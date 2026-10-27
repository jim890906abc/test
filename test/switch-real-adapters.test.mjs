// The six runtime switches through the REAL adapters: a real Hub process (its
// runner, its kimi-remote adapter, the Claude mirror), a real Claude daemon,
// and only the outside faked — the Kimi server on a machine (what its API is
// asked to do is recorded) and the Anthropic API (every request recorded). The
// assertions are on what the target actually RECEIVED: the hand-off text in
// Claude's messages / in Kimi's prompt, the permission it was configured with,
// and what it did with it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { GATEWAY_KEY, DS } from './fixtures/fake-machine.mjs';
import { redactSecrets } from '../server/redact.js';

const MID = 'm_fake';
const SECRET = 'sk-ant-api03-SECRETSECRETSECRET1234567890';
let hub;
let CWD;
let KIMI;
let CLAUDE;
let DEEPSEEK;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const claudeCalls = () => hub.fakeClaude.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'));
const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const kimiPromptsFor = (sid) => hub.machine.prompts.filter((p) => p.sid === sid);
const reminderOf = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text).join('\n');
const saidIn = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');

// Send a message and wait until the answer is complete. The Hub masks secrets
// where an event comes in, so the user's event carries the masked text: match
// either, or a message with a key in it would never be seen to arrive.
async function say(id, text) {
  const shown = redactSecrets(text);
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && (e.text === text || e.text === shown)) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}
const switchTo = (id, target) => hub.api('POST', `/sessions/${id}/provider`, target);
const newKimi = (permission) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD, model: KIMI.model, effort: KIMI.effort, permission });
const nativeCreates = () => hub.machine.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/sessions').length;

before(async () => {
  hub = await startRealHub('switch-real', { claude: true });
  await hub.setDeepseekKey();
  CWD = path.join(hub.TMP, 'project');
  fs.mkdirSync(CWD, { recursive: true });
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { provider: 'kimi', model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  CLAUDE = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  DEEPSEEK = { provider: 'deepseek', model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id, effort: 'max' };
});
after(() => hub?.stop());

test('K→C: Claude is sent the history (secrets removed), runs with a permission that asks as much, and asks', async () => {
  const k = await newKimi('yolo');
  await say(k.id, `hello from kimi ${SECRET}`);
  const leaf = await switchTo(k.id, CLAUDE);
  assert.equal(leaf.provider, 'claude');
  assert.equal(leaf.continuedFrom, k.id);
  assert.match(leaf.handoff.notes.join('\n'), /需要時詢問.*每次詢問/, 'the stricter mode is on record');
  assert.equal(claudeCalls().length, 0, 'making the node asks Claude for nothing');

  await say(leaf.id, 'continue please');
  const req = claudeCalls().at(-1).body;
  assert.equal(req.model, 'claude-opus-5-5');
  const [history, next] = req.messages;
  assert.match(textOf(history.content), /prior conversation history from Kimi/);
  assert.match(textOf(history.content), /hello from kimi/);
  assert.match(textOf(history.content), /Kimi 收到：hello from kimi/, 'the assistant\'s side too');
  assert.match(textOf(history.content), /NOT a new user request/);
  assert.equal(textOf(next.content), 'continue please', 'the real message stays separate');
  assert.equal(JSON.stringify(req).includes(SECRET), false, 'no secret reached Claude');
  assert.equal(JSON.stringify(req).includes('SECRETSECRETSECRET'), false);

  // Kimi `yolo` asked less than Claude's `edits` does about commands: the Claude node starts on `manual`,
  // and really asks before running a command.
  assert.equal((await snap(leaf.id)).meta.permission, 'manual');
  await hub.api('POST', `/sessions/${leaf.id}/messages`, { text: 'BASH please' });
  const ask = await until(async () => (await snap(leaf.id)).events.find((e) => e.permission && !e.permission.chosen), 15000, 'Claude asks before running the command');
  assert.equal(ask.name, 'Bash');
  await hub.api('POST', `/sessions/${leaf.id}/permissions/${ask.id}`, { optionId: 'rejected' });
  await until(async () => (await snap(leaf.id)).status === 'idle', 15000, 'the turn ends after the refusal');
});

test('C→K: Kimi gets a new native session configured with a mapped permission, and the history in its first prompt only', async () => {
  const k = await newKimi('manual');
  const c = await switchTo(k.id, CLAUDE);
  await say(c.id, 'claude era message');
  await hub.api('POST', `/sessions/${c.id}/config`, { permission: 'auto' });
  await until(async () => (await snap(c.id)).meta.permission === 'auto', 10000, 'Claude on auto');
  const before = nativeCreates();
  const back = await switchTo(c.id, KIMI);
  assert.equal(back.provider, 'kimi');
  assert.equal(nativeCreates(), before + 1, 'a new native Kimi session (A→B→A does not reuse the old one)');
  assert.notEqual(back.kimiSessionId, k.kimiSessionId);
  const profile = hub.machine.profiles.findLast((p) => p.sid === back.kimiSessionId);
  assert.equal(profile.agent_config.model, KIMI.model);
  // Claude `auto` ("nothing asks") is not Kimi `auto` ("Never Ask", it also answers questions and plans): Kimi gets `yolo`.
  assert.equal(profile.agent_config.permission_mode, 'yolo');
  assert.notEqual(profile.agent_config.permission_mode, 'auto');
  assert.equal(hub.machine.sessions.get(back.kimiSessionId).permission, 'yolo');

  await say(back.id, 'now back on kimi');
  const first = kimiPromptsFor(back.kimiSessionId)[0];
  assert.equal(saidIn(first), 'now back on kimi');
  const reminder = reminderOf(first);
  assert.match(reminder, /prior conversation history from Claude/);
  assert.match(reminder, /claude era message/);
  assert.match(reminder, /收到：claude era message/);
  assert.match(reminder, /Kimi → Claude|Kimi → Claude/, 'the whole trail is named');
  assert.equal((await snap(back.id)).handoff.consumedAt != null, true, 'consumed once Kimi accepted the prompt');

  await say(back.id, 'and a second message');
  const second = kimiPromptsFor(back.kimiSessionId)[1];
  assert.equal(reminderOf(second), '', 'the history is sent once, not with every prompt');
});

test('K↔D keep the same native session; the DeepSeek model really reaches the prompt', async () => {
  const k = await newKimi('yolo');
  await say(k.id, 'on kimi first');
  const creates = nativeCreates();
  const d = await switchTo(k.id, DEEPSEEK);
  assert.equal(d.id, k.id, 'the same node');
  assert.equal(d.kimiSessionId, k.kimiSessionId);
  assert.equal(d.provider, 'deepseek');
  assert.equal(nativeCreates(), creates, 'no new native session');
  const prof = hub.machine.profiles.findLast((p) => p.sid === k.kimiSessionId);
  assert.equal(prof.agent_config.model, `${DS}/${DEEPSEEK.model}`);
  assert.equal(prof.agent_config.thinking, 'max');
  assert.equal(prof.agent_config.permission_mode, 'yolo', 'its own mode is kept, in its own word');
  await say(d.id, 'on deepseek now');
  assert.equal(kimiPromptsFor(k.kimiSessionId).at(-1).body.model, `${DS}/${DEEPSEEK.model}`);
  const back = await switchTo(d.id, KIMI);
  assert.equal(back.provider, 'kimi');
  assert.equal(hub.machine.profiles.findLast((p) => p.sid === k.kimiSessionId).agent_config.model, KIMI.model);
  await say(back.id, 'kimi again');
  assert.equal(kimiPromptsFor(k.kimiSessionId).at(-1).body.model, KIMI.model);
});

test('D→C: Claude is told the history came from DeepSeek, with the DeepSeek era in it', async () => {
  const k = await newKimi('auto');
  await switchTo(k.id, DEEPSEEK);
  await say(k.id, 'deepseek era words');
  const c = await switchTo(k.id, CLAUDE);
  assert.equal(c.provider, 'claude');
  assert.equal(c.handoff.fromProvider, 'deepseek');
  await say(c.id, 'after the move');
  const history = textOf(claudeCalls().at(-1).body.messages[0].content);
  assert.match(history, /prior conversation history from DeepSeek/);
  assert.match(history, /deepseek era words/);
  // Kimi runtime `auto` (Never Ask) and Claude `auto` ask the same thing.
  assert.equal((await snap(c.id)).meta.permission, 'auto');
});

test('C→D: a new native Kimi session on a DeepSeek model, carrying Claude\'s history', async () => {
  const k = await newKimi('manual');
  const c = await switchTo(k.id, CLAUDE);
  await say(c.id, 'claude says things');
  await hub.api('POST', `/sessions/${c.id}/config`, { permission: 'edits' });
  await until(async () => (await snap(c.id)).meta.permission === 'edits', 10000, 'Claude on edits');
  const d = await switchTo(c.id, DEEPSEEK);
  assert.equal(d.provider, 'deepseek');
  const prof = hub.machine.profiles.findLast((p) => p.sid === d.kimiSessionId);
  assert.equal(prof.agent_config.model, `${DS}/${DEEPSEEK.model}`);
  assert.equal(prof.agent_config.permission_mode, 'manual', 'Kimi has no edits-only mode: the stricter one');
  await say(d.id, 'hello deepseek');
  const first = kimiPromptsFor(d.kimiSessionId)[0];
  assert.match(reminderOf(first), /prior conversation history from Claude/);
  assert.match(reminderOf(first), /claude says things/);
  assert.equal(first.body.model, `${DS}/${DEEPSEEK.model}`);
});

test('K→C→K and C→K→C: the chain keeps growing, only the leaf is listed, and the last hop carries every earlier era', async () => {
  const k1 = await newKimi('manual');
  await say(k1.id, 'era one on kimi');
  const c = await switchTo(k1.id, CLAUDE);
  await say(c.id, 'era two on claude');
  const k2 = await switchTo(c.id, KIMI);
  assert.notEqual(k2.kimiSessionId, k1.kimiSessionId);
  await say(k2.id, 'era three on kimi');
  const reminder = reminderOf(kimiPromptsFor(k2.kimiSessionId)[0]);
  assert.match(reminder, /era one on kimi/);
  assert.match(reminder, /era two on claude/);
  const list = await hub.api('GET', '/sessions');
  assert.deepEqual(list.filter((s) => s.conversationId === k1.conversationId).map((s) => s.id), [k2.id]);
  const full = await snap(k1.id);
  assert.equal(full.id, k2.id);
  assert.equal(full.chainLength, 3);
  assert.deepEqual(full.chain.map((n) => n.provider), ['kimi', 'claude', 'kimi']);
  const texts = full.events.filter((e) => e.type === 'user').map((e) => e.text);
  assert.deepEqual(texts, ['era one on kimi', 'era two on claude', 'era three on kimi'], 'no history lost or doubled');

  // C→K→C from a Claude start.
  // A Claude conversation of the Hub's own computer (its daemon), the other kind of Claude node.
  const c1 = await hub.api('POST', '/sessions', { provider: 'claude', cwd: CWD, model: CLAUDE.model, effort: CLAUDE.effort });
  await say(c1.id, 'claude start');
  const kk = await switchTo(c1.id, KIMI);
  await say(kk.id, 'kimi middle');
  const c2 = await switchTo(kk.id, CLAUDE);
  await say(c2.id, 'claude end');
  const hist = textOf(claudeCalls().at(-1).body.messages[0].content);
  assert.match(hist, /claude start/);
  assert.match(hist, /kimi middle/);
  assert.match(hist, /Claude → Kimi/);
});

test('a secret typed on one runtime is not handed to the next (checked at the Claude request and the Kimi prompt)', async () => {
  const k = await newKimi('manual');
  await say(k.id, `my key is ${SECRET} and Authorization: Bearer abcdefghijklmnop1234`);
  const c = await switchTo(k.id, CLAUDE);
  await say(c.id, 'go on');
  const toClaude = JSON.stringify(claudeCalls().at(-1).body);
  assert.equal(toClaude.includes(SECRET), false);
  assert.equal(toClaude.includes('abcdefghijklmnop1234'), false);
  const back = await switchTo(c.id, KIMI);
  await say(back.id, 'and back');
  const toKimi = JSON.stringify(kimiPromptsFor(back.kimiSessionId)[0].body);
  assert.equal(toKimi.includes(SECRET), false);
  assert.equal(toKimi.includes('abcdefghijklmnop1234'), false);
});

test('the DeepSeek gateway key is not handed on either', async () => {
  const k = await newKimi('manual');
  await say(k.id, `export DEEPSEEK_API_KEY=${GATEWAY_KEY}`);
  const c = await switchTo(k.id, CLAUDE);
  await say(c.id, 'go on');
  assert.equal(JSON.stringify(claudeCalls().at(-1).body).includes(GATEWAY_KEY), false);
});
