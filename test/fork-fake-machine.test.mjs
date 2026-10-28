// /fork through the REAL Hub (runner, kimi-remote adapter, Claude mirror and a
// real Claude daemon), with only the outside faked: the Kimi server of a
// machine (whose :fork imitates what the real Kimi 2.3.3 did in
// test/e2e-fork.test.mjs) and the Anthropic API. It asks what a person sees
// after "分叉": a NEW conversation of the SAME provider, with the history, the
// folder and the settings of the one it came from, listed in the sidebar, the
// source left alone, and a message sent to the fork reaching the fork.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { DS } from './fixtures/fake-machine.mjs';

const MID = 'm_fake';
let hub;
let CWD;
let KIMI;
let DEEPSEEK;
let CLAUDE;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const list = () => hub.api('GET', '/sessions');
const fork = (id, args = '') => hub.api('POST', `/sessions/${id}/command`, { name: 'fork', args });
const kimiPromptsFor = (sid) => hub.machine.prompts.filter((p) => p.sid === sid);
const saidIn = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');
// The node as saved: the page's snapshot leaves `state` out. A save is
// deferred a moment, so wait for it to carry what is expected.
const saved = (id, ok) => until(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'sessions', `${id}.json`), 'utf8'));
  return ok(j) && j;
}, 8000, `${id} saved`);
const lines = (s) => s.events.filter((e) => e.type === 'user' || e.type === 'text').map((e) => `${e.type}:${e.text}`);
const newKimi = (extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const newDeepseek = (extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model: DEEPSEEK.model, effort: 'max', permission: 'auto', ...extra });

async function say(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}

before(async () => {
  hub = await startRealHub('fork-fake', { claude: true });
  await hub.setDeepseekKey();
  CWD = path.join(hub.TMP, 'project');
  fs.mkdirSync(CWD, { recursive: true });
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  DEEPSEEK = { model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id };
  CLAUDE = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
});
after(() => hub?.stop());

test('Kimi: a fork is a new Kimi conversation with the history and folder, listed, and the source is left alone', async () => {
  const src = await newKimi();
  const done = await say(src.id, '第一句');
  const sourceBefore = JSON.stringify(lines(done));
  const natives = hub.machine.sessions.size;

  const r = await fork(src.id, '我的分支');
  const f = r.session;
  assert.notEqual(f.id, src.id);
  assert.notEqual(f.kimiSessionId, src.kimiSessionId, 'its own native conversation');
  assert.equal(f.title, '我的分支');
  assert.equal(f.cwd, src.cwd);
  assert.equal(f.provider, 'kimi');
  assert.equal(f.origin, 'hub', 'a fork of a Hub conversation stays in the Hub category');
  assert.equal(f.model, KIMI.model);
  assert.equal(hub.machine.sessions.size, natives + 1, 'exactly one native conversation was made');
  assert.deepEqual(hub.machine.forks.map((x) => x.from), [src.kimiSessionId]);

  const full = await snap(f.id);
  assert.deepEqual(lines(full), lines(done), 'the history was copied');
  assert.equal((await list()).filter((x) => x.id === f.id).length, 1, 'listed in the sidebar');
  assert.equal(JSON.stringify(lines(await snap(src.id))), sourceBefore, 'the source did not change');

  // A message to the fork goes to the fork's native conversation, never the source's.
  const sentBefore = kimiPromptsFor(src.kimiSessionId).length;
  await say(f.id, '分支的新話');
  assert.equal(saidIn(kimiPromptsFor(f.kimiSessionId).at(-1)), '分支的新話');
  assert.equal(kimiPromptsFor(src.kimiSessionId).length, sentBefore, 'nothing reached the source');
  assert.ok(!lines(await snap(src.id)).some((l) => l.includes('分支的新話')));
});

test('Kimi: no title given, the native one is used ("Fork: <title>")', async () => {
  const src = await newKimi();
  await say(src.id, '沒有標題的分支');
  const { session: f } = await fork(src.id, '');
  assert.match(f.title, /^Fork: /);
  assert.deepEqual(hub.machine.forks.at(-1).body, {}, 'no title is asked for');
});

test('DeepSeek: a fork is a DeepSeek conversation too: badge, model, effort, mode, no drift, and its next turn is allowed', async () => {
  const src = await newDeepseek();
  await say(src.id, 'DS 第一句');
  const before = await snap(src.id);
  assert.equal(before.provider, 'deepseek');
  const alias = `${DS}/${DEEPSEEK.model}`;

  const { session: f } = await fork(src.id, 'DS 分支');
  assert.equal(f.provider, 'deepseek', 'the badge');
  assert.equal(f.mode, 'deepseek');
  assert.equal(f.modelConfig.provider, 'deepseek');
  assert.equal(f.modelConfig.model, alias);
  assert.equal(f.effort, 'max');
  assert.equal(f.modelDrift, null, 'what the Hub records and what the native runs agree');
  const full = await snap(f.id);
  assert.equal(full.provider, 'deepseek');
  assert.equal(full.mode, 'deepseek');
  assert.deepEqual(lines(full), lines(before), 'the history was copied');
  const disk = await saved(f.id, (j) => j.state?.deepseek);
  assert.equal(disk.provider, 'deepseek');
  assert.equal(disk.mode, 'deepseek');
  assert.equal(disk.state.deepseek.model, alias, 'the marker a DeepSeek conversation is made with');

  // The sidebar list says the same.
  const row = (await list()).find((x) => x.id === f.id);
  assert.equal(row.provider, 'deepseek');
  assert.equal(row.modelDrift, null);

  // And it can be talked to: on DeepSeek, in the fork's own native conversation.
  await say(f.id, 'DS 分支的新話');
  const sent = kimiPromptsFor(f.kimiSessionId).at(-1);
  assert.equal(saidIn(sent), 'DS 分支的新話');
  assert.ok(!sent.body.model || sent.body.model === alias, 'never a Kimi model');
  assert.equal(hub.machine.sessions.get(f.kimiSessionId).model, alias);
  assert.equal(kimiPromptsFor(src.kimiSessionId).at(-1)?.body.content.map((c) => c.text || '').join('').includes('DS 分支的新話'), false);
});

test('a fork keeps the subagent choice of the conversation it came from (explicit or not), and does not take today\'s global default', async () => {
  const flash = `${DS}/${DEEPSEEK.model}`;
  // An explicit choice: Claude as the subagent of a Kimi conversation.
  const a = await newKimi({ subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  await say(a.id, '子代理設定');
  assert.deepEqual(a.subagent, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'the source really has it');
  const fa = (await fork(a.id)).session;
  assert.deepEqual(fa.subagent, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal((await saved(fa.id, (j) => j.state?.subagentExplicit)).state.subagentExplicit, true, 'still an explicit choice, not the unmarked default');

  // An explicit "native rules" (null) must not turn into the default DeepSeek subagent.
  const b = await newKimi({ subagent: null });
  await say(b.id, '原生規則');
  assert.equal(b.subagent, null);
  assert.equal((await saved(b.id, (j) => j.state?.subagentExplicit)).state.subagentExplicit, true, 'the source really made that choice');
  const fb = (await fork(b.id)).session;
  assert.equal(fb.subagent, null);
  assert.equal((await saved(fb.id, (j) => j.state?.subagentExplicit)).state.subagentExplicit, true);

  // The unmarked default stays the default.
  const c = await newDeepseek();
  await say(c.id, '預設子代理');
  const fc = (await fork(c.id)).session;
  assert.deepEqual(fc.subagent, { provider: 'deepseek', model: flash, effort: 'max' });
});

test('forking a conversation that is working is refused with a reason, and nothing is made', async () => {
  const src = await newKimi();
  await say(src.id, '先有歷史');
  hub.machine.sessions.get(src.kimiSessionId).busy = true;
  try {
    const before = (await list()).length;
    await assert.rejects(fork(src.id), (e) => e.status === 400 && /忙碌/.test(e.message));
    assert.equal((await list()).length, before, 'no half-made conversation in the sidebar');
    assert.equal(hub.machine.forks.filter((x) => x.from === src.kimiSessionId).length, 0);
  } finally {
    hub.machine.sessions.get(src.kimiSessionId).busy = false;
  }
});

test('forking twice at once makes two separate conversations, each bound to its own native one', async () => {
  const src = await newDeepseek();
  await say(src.id, '連按兩次');
  const [x, y] = await Promise.all([fork(src.id, 'A'), fork(src.id, 'B')]);
  assert.notEqual(x.session.id, y.session.id);
  assert.notEqual(x.session.kimiSessionId, y.session.kimiSessionId);
  assert.deepEqual([x.session.provider, y.session.provider], ['deepseek', 'deepseek']);
  const bound = (await list()).map((s) => s.kimiSessionId).filter(Boolean);
  assert.equal(new Set(bound).size, bound.length, 'no native conversation is bound to two nodes');
});

test('attaching one native conversation twice at once makes one node, not two bound to the same native', async () => {
  hub.machine.add('session_twice', { title: 'attached twice', cwd: CWD });
  const url = `/machines/${MID}/kimi/session_twice/attach`;
  const [a, b] = await Promise.all([hub.api('POST', url), hub.api('POST', url)]);
  assert.equal(a.id, b.id);
  assert.equal((await list()).filter((s) => s.kimiSessionId === 'session_twice').length, 1);
});

test('chain: forking through the first node of a conversation switched Kimi → Claude → DeepSeek forks the leaf and leaves every node alone', async () => {
  const k = await newKimi();
  await say(k.id, '在 Kimi 的時候');
  const c = await hub.api('POST', `/sessions/${k.id}/provider`, CLAUDE);
  await say(c.id, '在 Claude 的時候');
  const leaf = await hub.api('POST', `/sessions/${c.id}/provider`, { provider: 'deepseek', model: DEEPSEEK.model, effort: 'max' });
  assert.equal(leaf.provider, 'deepseek');
  assert.notEqual(leaf.id, k.id, 'a real chain: a node of its own');
  await say(leaf.id, '換成 DeepSeek 之後');
  const nodes = [k.id, c.id, leaf.id];
  const before = JSON.stringify(await Promise.all(nodes.map(async (id) => lines(await snap(id)))));
  // The browser may still hold the first node's URL: the Hub works on the leaf.
  const { session: f } = await fork(k.id, '鏈的分支');
  assert.equal(f.provider, 'deepseek');
  assert.equal(hub.machine.forks.at(-1).from, leaf.kimiSessionId, 'forked the leaf\'s native conversation, not the first node\'s');
  assert.equal(f.kimiSessionId, hub.machine.forks.at(-1).to);
  assert.equal(f.chainLength, 1, 'a fork starts a conversation of its own');
  assert.equal(f.continuedFrom, null);
  assert.equal(f.modelDrift, null);
  assert.equal(JSON.stringify(await Promise.all(nodes.map(async (id) => lines(await snap(id))))), before, 'no node of the chain changed');
  const visible = (await list()).map((s) => s.id);
  assert.ok(visible.includes(f.id) && visible.includes(leaf.id), 'the chain\'s leaf and the fork are listed');
  assert.ok(!visible.includes(k.id) && !visible.includes(c.id), 'and the chain still counts as one conversation');
});

const claudeCalls = () => hub.fakeClaude.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'));
const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const newClaude = (extra = {}) => hub.api('POST', '/sessions', { provider: 'claude', machineId: MID, cwd: CWD, model: CLAUDE.model, effort: CLAUDE.effort, permission: 'auto', ...extra });

test('Claude (on a computer): a fork is a new Claude conversation with the history, model, folder and subagent choice; the source is left alone', async () => {
  const src = await newClaude({ subagent: { provider: 'deepseek', model: `${DS}/${DEEPSEEK.model}`, effort: 'max' } });
  const done = await say(src.id, 'claude 第一句');
  const sourceBefore = JSON.stringify(lines(done));
  const { session: f } = await fork(src.id, 'C 分支');
  assert.notEqual(f.id, src.id);
  assert.equal(f.provider, 'claude');
  assert.equal(f.agentId, 'claude');
  assert.equal(f.machineId, MID);
  assert.equal(f.title, 'C 分支');
  assert.equal(f.cwd, src.cwd);
  assert.equal(f.origin, 'hub');
  // (What the page shows: the fork's modelConfig is blank here, the model and
  // effort come from the daemon's meta - see the report, left as it is.)
  assert.equal(f.model, CLAUDE.model);
  assert.equal(f.effort, CLAUDE.effort);
  assert.deepEqual(f.subagent, { provider: 'deepseek', model: `${DS}/${DEEPSEEK.model}`, effort: 'max' }, 'the subagent choice');
  assert.deepEqual(lines(await snap(f.id)), lines(done), 'the history was copied');
  assert.equal((await list()).filter((x) => x.id === f.id).length, 1, 'listed in the sidebar');
  assert.equal(JSON.stringify(lines(await snap(src.id))), sourceBefore, 'the source did not change');

  // The fork continues from the copied conversation, on its own.
  await say(f.id, '分支裡的話');
  const req = claudeCalls().at(-1).body;
  const sent = req.messages.map((m) => textOf(m.content)).join('\n');
  assert.match(sent, /claude 第一句/, 'Claude was given the history');
  assert.match(sent, /分支裡的話/);
  await say(src.id, '原本裡的話');
  const again = claudeCalls().at(-1).body.messages.map((m) => textOf(m.content)).join('\n');
  assert.doesNotMatch(again, /分支裡的話/, 'the source never saw the fork\'s message');
  assert.ok(!lines(await snap(src.id)).some((l) => l.includes('分支裡的話')));
});

test('a conversation a terminal the bridge controls is running: a fork is refused, the terminal is left where it is (Kimi and DeepSeek)', async () => {
  // Typing /fork into that terminal would move IT onto the fork and make no
  // conversation here: the person would press 分叉, see nothing open, and find
  // their terminal somewhere else.
  for (const [name, model] of [['Kimi', KIMI.model], ['DeepSeek', DEEPSEEK.model]]) {
    const sid = `session_term_${name.toLowerCase()}`;
    hub.machine.add(sid, { title: `terminal ${name}`, cwd: CWD, model, owner: 'tui', controllable: true });
    hub.machine.pushSessions();
    const node = await hub.api('POST', `/machines/${MID}/kimi/${sid}/attach`);
    const forksBefore = hub.machine.forks.length;
    const typedBefore = hub.machine.rpcs.filter((r) => r.op === 'kimi.tui.input').length;
    const sessionsBefore = (await list()).length;
    await assert.rejects(fork(node.id, '分支'), (e) => {
      assert.equal(e.status, 409, `${name}: refused, not an error of ours`);
      assert.match(e.message, /正在終端機執行：分叉會讓那個終端機換到新的對話/);
      return true;
    });
    assert.equal(hub.machine.rpcs.filter((r) => r.op === 'kimi.tui.input').length, typedBefore, `${name}: nothing was typed into the terminal`);
    assert.equal(hub.machine.forks.length, forksBefore, `${name}: no native fork was made either`);
    assert.equal((await list()).length, sessionsBefore, `${name}: no conversation was made`);
  }
});

test('the computer is offline: a clear error, nothing made, the source still there (Kimi, DeepSeek and Claude)', async () => {
  const src = await newKimi();
  await say(src.id, '離線前');
  const ds = await newDeepseek();
  await say(ds.id, 'DS 離線前');
  const cl = await newClaude();
  await say(cl.id, 'Claude 離線前');
  const before = (await list()).length;
  hub.machine.close();
  await until(async () => !(await hub.api('GET', '/machines')).find((m) => m.id === MID)?.online, 10000, 'the machine offline');
  try {
    for (const id of [src.id, ds.id, cl.id]) {
      await assert.rejects(fork(id), (e) => {
        assert.equal(e.status, 409);
        assert.match(e.message, /目前離線：請在那台機器上執行連接器/);
        return true;
      });
    }
    assert.equal((await list()).length, before);
    assert.equal(hub.machine.forks.filter((x) => x.from === src.kimiSessionId).length, 0);
  } finally {
    // This test closes the machine for good: it has to stay the last one.
  }
});
