// What the TARGET runtime is actually asked to run with when a conversation
// changes runtime or starts a sub-agent on the other one. The adapters record
// what they receive; the assertions are about that, not about calls made.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupHub } from './fixtures/hub-harness.mjs';
import { KIMI_MODES, CLAUDE_MODES } from '../server/permissions.js';

let hub;
before(async () => {
  hub = await setupHub('perm');
});
after(() => hub.close());

// Independent of server/permissions.js: what each native mode does not ask about.
const NO_ASK = {
  kimi: { manual: [], yolo: ['routine edit', 'routine command'], auto: ['routine edit', 'risky edit', 'routine command', 'risky command', 'question/plan'] },
  claude: { manual: [], edits: ['routine edit', 'risky edit'], auto: ['routine edit', 'risky edit', 'routine command', 'risky command'] },
};
const runtimeOf = (p) => (p === 'claude' ? 'claude' : 'kimi');
const assertNotLooser = (from, fromMode, to, toMode, what) => {
  const loosened = NO_ASK[runtimeOf(to)][toMode].filter((x) => !NO_ASK[runtimeOf(from)][fromMode].includes(x));
  assert.deepEqual(loosened, [], `${what}: ${from}/${fromMode} -> ${to}/${toMode} stops asking about ${loosened.join(', ')}`);
};

const SOURCES = [
  ['kimi', KIMI_MODES, (mode) => hub.kimiNode({ meta: { permission: mode } })],
  ['deepseek', KIMI_MODES, (mode) => hub.deepseekNode({ meta: { permission: mode } })],
  ['claude', CLAUDE_MODES, (mode) => hub.claudeNode({ meta: { permission: mode } })],
];
const TARGETS = { claude: hub => hub.CLAUDE, kimi: hub => hub.KIMI, deepseek: hub => hub.DEEPSEEK };

test('a runtime switch gives the new node a permission that asks the same or more, in the new runtime\'s own words', async () => {
  let n = 0;
  for (const [from, modes, make] of SOURCES) {
    for (const mode of modes) {
      for (const to of ['claude', 'kimi', 'deepseek']) {
        if (runtimeOf(from) === runtimeOf(to)) continue; // same native conversation: no new node
        const old = make(mode);
        const node = await hub.runner.switchProvider(old, TARGETS[to](hub));
        const created = hub.store.getSession(node.id);
        let received;
        if (to === 'claude') received = hub.claude.calls.create.findLast((c) => c.id === node.id).permission;
        else received = hub.kimi.calls.configure.findLast((c) => c.id === node.id).permission;
        const vocab = to === 'claude' ? CLAUDE_MODES : KIMI_MODES;
        assert.ok(vocab.includes(received), `${from}/${mode} -> ${to}: the target was handed ${JSON.stringify(received)}, which is not one of its modes`);
        assertNotLooser(from, mode, to, received, 'switch');
        assert.equal(created.meta.permission, received, 'the node shows the mode it really runs with');
        n++;
      }
    }
  }
  assert.equal(n, 3 + 3 + 6, 'every source mode x every cross-runtime target was exercised');
});

test('the exact mappings the user will see', async () => {
  const run = async (make, mode, target) => {
    const node = await hub.runner.switchProvider(make({ meta: { permission: mode } }), target);
    return hub.store.getSession(node.id).meta.permission;
  };
  assert.equal(await run(hub.kimiNode, 'auto', hub.CLAUDE), 'auto');
  assert.equal(await run(hub.kimiNode, 'yolo', hub.CLAUDE), 'manual');
  assert.equal(await run(hub.claudeNode, 'edits', hub.KIMI), 'manual');
  assert.equal(await run(hub.claudeNode, 'auto', hub.KIMI), 'yolo');
  assert.equal(await run(hub.claudeNode, 'auto', hub.DEEPSEEK), 'yolo');
});

test('a stricter result is said so in the conversation; an exact one adds nothing', async () => {
  const strict = await hub.runner.switchProvider(hub.kimiNode({ meta: { permission: 'yolo' } }), hub.CLAUDE);
  const note = hub.store.getSession(strict.id).events.find((e) => e.type === 'info' && /權限/.test(e.text));
  assert.ok(note, 'a stricter mode is announced');
  assert.match(note.text, /需要時詢問/);
  assert.match(note.text, /每次詢問/);
  // A Claude node's events are the daemon's copy (replaced on every sync): the
  // same words are kept on the hand-off record, which a sync does not touch.
  assert.deepEqual(hub.store.getSession(strict.id).handoff.notes, [note.text]);
  assert.deepEqual(strict.handoff.notes, [note.text], 'and the summary carries them');
  const same = await hub.runner.switchProvider(hub.kimiNode({ meta: { permission: 'auto' } }), hub.CLAUDE);
  assert.equal(hub.store.getSession(same.id).events.some((e) => e.type === 'info' && /權限/.test(e.text)), false);
  assert.deepEqual(hub.store.getSession(same.id).handoff.notes, []);
});

test('the Hub-level mode of the new node is not above what it really runs with', async () => {
  const node = await hub.runner.switchProvider(hub.kimiNode({ meta: { permission: 'yolo' }, permissionMode: 'bypass' }), hub.CLAUDE);
  assert.equal(hub.store.getSession(node.id).permissionMode, 'ask');
  const edits = await hub.runner.switchProvider(hub.claudeNode({ meta: { permission: 'edits' }, permissionMode: 'auto_edits' }), hub.KIMI);
  assert.equal(hub.store.getSession(edits.id).permissionMode, 'ask');
});

test('with no native mode reported, the Hub-level mode is not read as the other runtime\'s word', async () => {
  // `bypass` on a Kimi conversation with nothing reported used to become Claude `auto`.
  const node = await hub.runner.switchProvider(hub.kimiNode({ meta: {}, permissionMode: 'bypass' }), hub.CLAUDE);
  assert.equal(hub.store.getSession(node.id).meta.permission, 'manual');
  const odd = await hub.runner.switchProvider(hub.kimiNode({ meta: { permission: 'edits' } }), hub.CLAUDE);
  assert.equal(hub.store.getSession(odd.id).meta.permission, 'manual', 'a Claude word on a Kimi conversation is not trusted');
});

test('a Kimi and DeepSeek switch inside the same runtime keeps its own word, validated', async () => {
  const a = hub.kimiNode({ meta: { permission: 'yolo' } });
  await hub.runner.switchProvider(a, hub.DEEPSEEK);
  assert.equal(hub.kimi.calls.configure.findLast((c) => c.id === a.id).permission, 'yolo');
  const b = hub.kimiNode({ meta: { permission: 'edits' }, permissionMode: 'ask' });
  await hub.runner.switchProvider(b, hub.DEEPSEEK);
  assert.equal(hub.kimi.calls.configure.findLast((c) => c.id === b.id).permission, 'manual', 'an unknown word is not sent to Kimi');
});

test('a sub-agent started on the other runtime asks the same or more than its parent (parent x child provider matrix)', async () => {
  let n = 0;
  for (const [from, modes, make] of SOURCES) {
    for (const mode of modes) {
      for (const to of ['kimi', 'claude', 'deepseek']) {
        const parent = make(mode);
        parent.meta = { ...parent.meta, subagent: { provider: to, model: TARGETS[to](hub).model, effort: TARGETS[to](hub).effort } };
        const r = await hub.runner.delegateToProvider(parent, { task: `t-${from}-${mode}-${to}`, provider: to, model: TARGETS[to](hub).model, effort: TARGETS[to](hub).effort });
        assert.ok(r.childSessionId, JSON.stringify(r));
        const child = hub.store.getSession(r.childSessionId);
        const received = to === 'claude' ? hub.claude.calls.create.findLast((c) => c.id === child.id).permission : hub.kimi.calls.configure.findLast((c) => c.id === child.id).permission;
        const vocab = to === 'claude' ? CLAUDE_MODES : KIMI_MODES;
        assert.ok(vocab.includes(received), `${from}/${mode} -> child ${to}: handed ${JSON.stringify(received)}`);
        assertNotLooser(from, mode, to, received, 'sub-agent');
        n++;
      }
    }
  }
  assert.equal(n, 3 * 3 * 3);
});

test('the sub-agent card says which mode the child runs with, and why when it is stricter', async () => {
  const parent = hub.kimiNode({ meta: { permission: 'yolo' }, permissionMode: 'bypass' });
  parent.meta = { ...parent.meta, subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
  const r = await hub.runner.delegateToProvider(parent, { task: 'card note', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  const card = parent.events.filter((e) => e.type === 'tool_use').at(-1);
  assert.equal(card.subagent.permission, 'manual');
  assert.match(card.subagent.permissionNote, /需要時詢問/);
  assert.equal(hub.store.getSession(r.childSessionId).permissionMode, 'ask');
});
