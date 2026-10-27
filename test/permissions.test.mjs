// Permission vocabularies across providers. The words overlap but do not mean
// the same thing (`kimi --help`: yolo = "Ask When Needed", auto = "Never Ask";
// Claude: edits = file changes only, auto = nothing asks), so a switch or a
// sub-agent must translate, and may only ever ask the same or MORE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPermission, nativePermission, hubModeFor, inheritPermission, KIMI_MODES, CLAUDE_MODES, HUB_MODES, vocabularyOf } from '../server/permissions.js';

// Written independently of server/permissions.js on purpose: the actions each
// mode does NOT ask about, in plain words. The property test below judges the
// module's choices against these facts, not against its own table.
const NO_ASK = {
  kimi: { manual: [], yolo: ['routine edit', 'routine command'], auto: ['routine edit', 'risky edit', 'routine command', 'risky command', 'question/plan'] },
  claude: { manual: [], edits: ['routine edit', 'risky edit'], auto: ['routine edit', 'risky edit', 'routine command', 'risky command'] },
};
const runtime = (p) => (p === 'claude' ? 'claude' : 'kimi');
const modesOf = (p) => (p === 'claude' ? CLAUDE_MODES : KIMI_MODES);

test('every mode of every provider maps into every provider without asking less', () => {
  let checked = 0;
  for (const from of ['kimi', 'deepseek', 'claude']) {
    for (const to of ['kimi', 'deepseek', 'claude']) {
      for (const mode of modesOf(from)) {
        const r = mapPermission(from, mode, to);
        assert.ok(modesOf(to).includes(r.permission), `${from}/${mode} -> ${to} gave a word ${to} does not know: ${r.permission}`);
        const before = NO_ASK[runtime(from)][mode];
        const after = NO_ASK[runtime(to)][r.permission];
        const loosened = after.filter((x) => !before.includes(x));
        assert.deepEqual(loosened, [], `${from}/${mode} -> ${to}/${r.permission} stops asking about ${loosened.join(', ')}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 3 * 3 * 3);
});

test('the actual mapping (explicit truth table)', () => {
  const table = [
    // Kimi runtime -> Claude
    ['kimi', 'manual', 'claude', 'manual'],
    ['kimi', 'yolo', 'claude', 'manual'], // Claude's `edits` would approve risky edits Kimi still asks about
    ['kimi', 'auto', 'claude', 'auto'], // Never Ask = nothing asks
    ['deepseek', 'yolo', 'claude', 'manual'],
    ['deepseek', 'auto', 'claude', 'auto'],
    // Claude -> Kimi runtime
    ['claude', 'manual', 'kimi', 'manual'],
    ['claude', 'edits', 'kimi', 'manual'], // Kimi has no edits-only mode; yolo also runs commands
    ['claude', 'auto', 'kimi', 'yolo'], // Kimi auto would also answer questions and plans by itself
    ['claude', 'edits', 'deepseek', 'manual'],
    ['claude', 'auto', 'deepseek', 'yolo'],
    // Same vocabulary: unchanged
    ['kimi', 'yolo', 'deepseek', 'yolo'],
    ['deepseek', 'auto', 'kimi', 'auto'],
    ['claude', 'edits', 'claude', 'edits'],
  ];
  for (const [from, mode, to, want] of table) assert.equal(mapPermission(from, mode, to).permission, want, `${from}/${mode} -> ${to}`);
});

test('a word from the other vocabulary, a missing or a junk value never passes through; it becomes the strictest', () => {
  for (const bad of ['edits', 'bypass', 'ask', '', undefined, null, 'AUTO', 'auto ', 7, {}]) {
    for (const to of ['kimi', 'deepseek', 'claude']) {
      const r = mapPermission('kimi', bad, to);
      assert.equal(r.permission, 'manual', `kimi/${String(bad)} -> ${to}`);
      assert.equal(r.invalid, true);
      assert.equal(r.tightened, true);
    }
  }
  for (const bad of ['yolo', 'bypass', undefined, 'Edits']) assert.equal(mapPermission('claude', bad, 'kimi').permission, 'manual', `claude/${String(bad)}`);
  assert.throws(() => mapPermission('kimi', 'auto', 'gemini'), /unknown provider/);
});

test('exactness and notes: a same-meaning move is silent, a stricter one says what happened', () => {
  for (const [from, mode, to] of [['kimi', 'manual', 'claude'], ['kimi', 'auto', 'claude'], ['claude', 'manual', 'kimi'], ['claude', 'edits', 'claude'], ['kimi', 'yolo', 'deepseek']]) {
    const r = mapPermission(from, mode, to);
    assert.equal(r.exact, true, `${from}/${mode} -> ${to}`);
    assert.equal(r.note, '');
  }
  const y = mapPermission('kimi', 'yolo', 'claude');
  assert.equal(y.tightened, true);
  assert.match(y.note, /需要時詢問/);
  assert.match(y.note, /每次詢問/);
  assert.match(y.note, /不會少問/);
  assert.match(mapPermission('claude', 'edits', 'kimi').note, /自動接受編輯/);
});

test('a conversation reports its native mode; without one the Hub-level mode is translated strictly', () => {
  assert.equal(nativePermission({ meta: { permission: 'yolo' } }, 'kimi'), 'yolo');
  assert.equal(nativePermission({ meta: { permission: 'edits' } }, 'claude'), 'edits');
  // A Claude word on a Kimi conversation is not Kimi's: ignored, not trusted.
  assert.equal(nativePermission({ meta: { permission: 'edits' }, permissionMode: 'ask' }, 'kimi'), 'manual');
  assert.equal(nativePermission({ meta: { permission: 'edits' }, permissionMode: 'auto_edits' }, 'kimi'), 'manual', 'Kimi has no edits-only mode');
  assert.equal(nativePermission({ permissionMode: 'auto_edits' }, 'claude'), 'edits');
  assert.equal(nativePermission({ permissionMode: 'bypass' }, 'claude'), 'auto');
  assert.equal(nativePermission({ permissionMode: 'bypass' }, 'kimi'), 'yolo');
  assert.equal(nativePermission({ permissionMode: 'ask' }, 'deepseek'), 'manual');
  assert.equal(nativePermission({}, 'kimi'), 'manual');
  assert.equal(nativePermission({ permissionMode: 'weird' }, 'claude'), 'manual');
  assert.equal(nativePermission({ meta: { permission: 'auto' } }, 'gemini'), 'manual');
});

test('inheritPermission chains the two steps (what a switch and a sub-agent use)', () => {
  const kimiYolo = { meta: { permission: 'yolo' }, permissionMode: 'bypass' };
  assert.equal(inheritPermission(kimiYolo, 'kimi', 'claude').permission, 'manual');
  const claudeAuto = { meta: { permission: 'auto' }, permissionMode: 'bypass' };
  assert.equal(inheritPermission(claudeAuto, 'claude', 'deepseek').permission, 'yolo');
  // A Hub-level `bypass` alone must not turn a Kimi conversation into Claude `auto`.
  assert.equal(inheritPermission({ permissionMode: 'bypass' }, 'kimi', 'claude').permission, 'manual');
});

test('the Hub-level mode of a new node never exceeds the old one or the native mode', () => {
  for (const [provider, modes] of [['kimi', KIMI_MODES], ['claude', CLAUDE_MODES]]) {
    for (const mode of modes) {
      for (const ceiling of [...HUB_MODES, undefined]) {
        const hub = hubModeFor(provider, mode, ceiling);
        assert.ok(HUB_MODES.includes(hub));
        if (ceiling) assert.ok(HUB_MODES.indexOf(hub) <= HUB_MODES.indexOf(ceiling), `${provider}/${mode} under ${ceiling} gave ${hub}`);
      }
    }
  }
  assert.equal(hubModeFor('claude', 'edits'), 'auto_edits');
  assert.equal(hubModeFor('claude', 'edits', 'ask'), 'ask');
  assert.equal(hubModeFor('kimi', 'yolo'), 'ask');
  assert.equal(hubModeFor('kimi', 'auto'), 'bypass');
});

test('vocabularies: DeepSeek speaks Kimi', () => {
  assert.equal(vocabularyOf('deepseek'), 'kimi');
  assert.equal(vocabularyOf('kimi'), 'kimi');
  assert.equal(vocabularyOf('claude'), 'claude');
  assert.equal(vocabularyOf('x'), null);
});
