// Conversations saved by the versions before the unified models (no provider,
// modelConfig, conversationId, origin...) open without losing their history,
// are recognised for what they are (a DeepSeek conversation is not "Kimi"),
// and can be switched to either of the other two — the history arrives there.
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
let CLAUDE;
let DEEPSEEK;
const claudeCalls = () => hub.fakeClaude.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'));
const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const snap = (id) => hub.api('GET', `/sessions/${id}`);
const reminderOf = (sid) => hub.machine.prompts.filter((p) => p.sid === sid).map((p) => p.body.content.filter((c) => c.text?.startsWith('<system-reminder>')).map((c) => c.text).join('\n')).join('\n');

// The shape an old store has: only what was set when it was made.
const legacy = (id, over) => ({
  id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [],
  events: [
    { id: `${id}_u`, ts: 1000, type: 'user', text: `legacy question of ${id}` },
    { id: `${id}_a`, ts: 1001, type: 'text', text: `legacy answer of ${id}` },
    { id: `${id}_e`, ts: 1002, type: 'turn_end', durationMs: 5 },
  ],
  state: {}, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 }, createdAt: 1000, updatedAt: 2000, cwd: '', meta: {}, ...over,
});
const kimiLegacy = (id) => legacy(id, { agentId: `kimi@${MID}`, machineId: MID, kimiSessionId: `session_${id}`, cwd: CWD, meta: { model: 'managed:kimi-code/kimi-for-coding', permission: 'yolo' } });
const dsLegacy = (id) => legacy(id, { agentId: `kimi@${MID}`, machineId: MID, kimiSessionId: `session_${id}`, cwd: CWD, mode: 'deepseek', state: { deepseek: { gateway: 'opencode-go', model: `${DS}/deepseek-v4.1-flash` } }, meta: { model: `${DS}/deepseek-v4.1-flash`, permission: 'yolo' } });
const claudeLegacy = (id) => legacy(id, { agentId: 'claude', cwd: CWD, meta: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', permission: 'edits', planMode: false } });
const IDS = { k_claude: kimiLegacy, k_ds: kimiLegacy, d_kimi: dsLegacy, d_claude: dsLegacy, c_kimi: claudeLegacy, c_ds: claudeLegacy };

before(async () => {
  hub = await startRealHub('legacy', {
    claude: true,
    seed: (DATA) => {
      CWD = path.join(path.dirname(DATA), 'project');
      fs.mkdirSync(CWD, { recursive: true });
      for (const [id, make] of Object.entries(IDS)) fs.writeFileSync(path.join(DATA, 'sessions', `${id}.json`), JSON.stringify(make(id)));
    },
  });
  await hub.setDeepseekKey();
  // Kimi has the same history stored that the old Hub store shows.
  for (const id of ['k_claude', 'k_ds', 'd_kimi', 'd_claude']) hub.machine.add(`session_${id}`, { title: id, cwd: CWD, model: id.startsWith('d_') ? `${DS}/deepseek-v4.1-flash` : 'managed:kimi-code/kimi-for-coding', permission: 'yolo', history: [{ user: `legacy question of ${id}`, assistant: `legacy answer of ${id}` }] });
  hub.machine.pushSessions();
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { provider: 'kimi', model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  CLAUDE = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  DEEPSEEK = { provider: 'deepseek', model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id, effort: 'max' };
});
after(() => hub?.stop());

test('each old conversation opens whole and is recognised as what it is', async () => {
  for (const [id, want] of [['k_claude', 'kimi'], ['k_ds', 'kimi'], ['d_kimi', 'deepseek'], ['d_claude', 'deepseek'], ['c_kimi', 'claude'], ['c_ds', 'claude']]) {
    const s = await snap(id);
    assert.equal(s.provider, want, `${id} is ${want}`);
    assert.deepEqual(s.events.filter((e) => e.type === 'user' || e.type === 'text').map((e) => e.text), [`legacy question of ${id}`, `legacy answer of ${id}`], `${id} keeps its history`);
    assert.equal(s.chainLength, 1);
    assert.equal(s.isLeaf, true);
  }
});

for (const id of Object.keys(IDS)) {
  test(`${id}: choosing another provider keeps the old history, hands it over, and leaves the old node alone`, async () => {
    const target = { k_claude: CLAUDE, k_ds: DEEPSEEK, d_kimi: KIMI, d_claude: CLAUDE, c_kimi: KIMI, c_ds: DEEPSEEK }[id];
    const before = await snap(id);
    const leaf = await hub.api('POST', `/sessions/${id}/provider`, target);
    assert.equal(leaf.provider, target.provider);
    const whole = await snap(id);
    const users = whole.events.filter((e) => e.type === 'user' || e.type === 'text').map((e) => e.text);
    assert.deepEqual(users.slice(0, 2), [`legacy question of ${id}`, `legacy answer of ${id}`], 'the old history is still shown, first');
    assert.equal(whole.id, leaf.id, 'the old URL leads to the current leaf');
    // Kimi <-> DeepSeek is one native conversation with another model: no new node.
    const sameConversation = ['k_ds', 'd_kimi'].includes(id);
    assert.equal(leaf.id === id, sameConversation);
    if (!sameConversation) {
      assert.equal(whole.chain[0].id, id);
      assert.equal(whole.chain[0].isLeaf, false);
    }
    // The first real message carries the history to the new runtime.
    const known = new Set(whole.events.map((e) => e.id));
    await hub.api('POST', `/sessions/${leaf.id}/messages`, { text: `continue ${id}` });
    await until(async () => {
      const s = await snap(leaf.id);
      const fresh = s.events.filter((e) => !known.has(e.id));
      return s.status === 'idle' && fresh.some((e) => e.type === 'turn_end') && s;
    }, 25000, 'the answer after the switch');
    if (target.provider === 'claude') {
      const history = textOf(claudeCalls().findLast((r) => textOf(r.body.messages.at(-1).content) === `continue ${id}`).body.messages[0].content);
      assert.match(history, new RegExp(`legacy question of ${id}`));
      assert.match(history, new RegExp(`legacy answer of ${id}`));
    } else if (sameConversation) {
      assert.equal(reminderOf(leaf.kimiSessionId), '', 'the same Kimi conversation already has its context: nothing is re-sent');
      const last = hub.machine.prompts.filter((p) => p.sid === leaf.kimiSessionId).at(-1);
      assert.equal(last.body.model, target.provider === 'deepseek' ? `${DS}/${target.model}` : target.model, 'and the chosen model is on the prompt');
    } else {
      assert.match(reminderOf(leaf.kimiSessionId), new RegExp(`legacy answer of ${id}`));
    }
    // The old node and its native conversation are as they were.
    const old = (await snap(leaf.id)).chain[0];
    assert.equal(old.kimiSessionId, before.kimiSessionId);
    if (before.kimiSessionId) assert.equal(hub.machine.archived.includes(before.kimiSessionId), false, 'the old native session was not archived');
  });
}
