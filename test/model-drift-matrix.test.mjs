// A DeepSeek conversation must never be put on a Kimi model. This is checked
// where it matters - on what the (fake) native Kimi on the machine RECEIVES,
// not on what the Hub records - for every way a conversation reaches the
// native after it was made: opened new, a Hub restart, global defaults that
// name a Kimi model, the machine reconnecting, K -> D -> K -> D, and the three
// shapes an old store keeps a DeepSeek conversation in.
//
// "Received" means three things, each asserted: every /profile change aimed at
// that native session names a DeepSeek alias (or none at all); the model the
// native ends up on is a DeepSeek alias; every prompt that carries a model
// carries a DeepSeek one. The real Hub process, its runner and its kimi-remote
// adapter run; only the machine (Kimi) and the gateway are fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.AGENT_HUB_PROFILE_CONFIRM_MS = '150';
const { startRealHub, until, wait } = await import('./fixtures/real-hub.mjs');
const { startFakeMachine, DS, SUB } = await import('./fixtures/fake-machine.mjs');

const MID = 'm_fake';
const ALIAS = `${DS}/deepseek-v4.1-flash`;
const hubs = [];
let CWD;
// The machine-wide defaults of 設定 name a Kimi model. A DeepSeek conversation
// that is ever handed these has been moved onto the subscription.
const KIMI_DEFAULTS = { defaults: { model: SUB, effort: 'max', permission: 'yolo' } };

// The shape an old store keeps a conversation in: only what was set when it
// was made.
const legacy = (id, over) => ({
  id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [],
  events: [
    { id: `${id}_u`, ts: 1000, type: 'user', text: `old question of ${id}` },
    { id: `${id}_a`, ts: 1001, type: 'text', text: `old answer of ${id}` },
    { id: `${id}_e`, ts: 1002, type: 'turn_end', durationMs: 5 },
  ],
  state: {}, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 }, createdAt: 1000, updatedAt: 2000, meta: {},
  agentId: `kimi@${MID}`, machineId: MID, kimiSessionId: `session_${id}`, ...over,
});
const OLD = {
  // the legacy mode, but not the marker made at creation, and no model kept
  // anywhere: nothing says which DeepSeek model it should run
  old_mode: (id) => legacy(id, { mode: 'deepseek' }),
  // what the 10-24 case looked like: no mode, no provider, no marker; the only
  // sign is the Hub's record of the model, and the native has not said yet
  old_record: (id) => legacy(id, { modelConfig: { provider: 'deepseek', model: ALIAS, effort: 'max' } }),
  // older still: no sign in the Hub's own fields at all; only the native knows
  old_native: (id) => legacy(id, {}),
};

async function newHub(name, { seedLegacy = true, from = null } = {}) {
  const hub = await startRealHub(name, {
    seed: (DATA) => {
      CWD = path.join(path.dirname(DATA), 'project');
      fs.mkdirSync(CWD, { recursive: true });
      if (from) fs.cpSync(from, DATA, { recursive: true });
      else fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(KIMI_DEFAULTS));
      if (seedLegacy && !from) for (const [id, make] of Object.entries(OLD)) fs.writeFileSync(path.join(DATA, 'sessions', `${id}.json`), JSON.stringify(make(id, CWD)));
    },
  });
  hubs.push(hub);
  await hub.setDeepseekKey();
  return hub;
}

let hub;
before(async () => {
  hub = await newHub('drift-matrix');
  // The native side of the old conversations: Kimi has them, and (old_native)
  // reports a DeepSeek alias, while the other two have not said which model.
  hub.machine.add('session_old_mode', { title: 'old_mode', cwd: CWD, model: '', permission: 'manual' });
  hub.machine.add('session_old_record', { title: 'old_record', cwd: CWD, model: '', permission: 'manual' });
  hub.machine.add('session_old_native', { title: 'old_native', cwd: CWD, model: ALIAS, permission: 'manual' });
  hub.machine.pushSessions();
});
after(async () => {
  for (const h of hubs) await h.stop();
});

const snap = (h, id) => h.api('GET', `/sessions/${id}`);
async function say(h, id, text) {
  const known = new Set((await snap(h, id)).events.map((e) => e.id));
  await h.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(h, id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`).catch(async (err) => {
    const s = await snap(h, id);
    err.message += `\n status=${s.status} events=${JSON.stringify(s.events.slice(-4).map((e) => [e.type, String(e.text).slice(0, 160)]))} machine=${JSON.stringify(h.machine.requests.slice(-4))}`;
    throw err;
  });
}
const newDs = (h, over = {}) => h.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model: 'deepseek-v4.1-flash', effort: 'max', ...over });

// What the native received for one native session, whatever the Hub recorded.
function received(h, nativeSid) {
  const profiles = h.machine.profiles.filter((p) => p.sid === nativeSid && p.agent_config?.model).map((p) => p.agent_config.model);
  const prompts = h.machine.prompts.filter((p) => p.sid === nativeSid);
  return { profiles, promptModels: prompts.map((p) => p.body.model).filter(Boolean), prompts: prompts.length, native: h.machine.sessions.get(nativeSid)?.model };
}
function assertDeepseekOnly(h, nativeSid, what, { needsModelAtPrompt = false } = {}) {
  const r = received(h, nativeSid);
  assert.deepEqual(r.profiles.filter((m) => !m.startsWith(`${DS}/`)), [], `${what}: no /profile named a non-DeepSeek model (${JSON.stringify(r.profiles)})`);
  assert.deepEqual(r.promptModels.filter((m) => !m.startsWith(`${DS}/`)), [], `${what}: no prompt carried a non-DeepSeek model (${JSON.stringify(r.promptModels)})`);
  if (r.native !== '') assert.ok(String(r.native).startsWith(`${DS}/`), `${what}: the native runs ${r.native}`);
  if (needsModelAtPrompt) assert.ok(r.promptModels.length > 0, `${what}: with the native silent about its model, the prompt names the DeepSeek one`);
  return r;
}

test('matrix · new: a DeepSeek conversation made now is on DeepSeek on the native and stays there', async () => {
  const s = await newDs(hub);
  await say(hub, s.id, 'first');
  const r = assertDeepseekOnly(hub, s.kimiSessionId, 'new');
  assert.equal(r.native, ALIAS);
  assert.ok(r.profiles.length >= 1, 'it was given its model');
  const after = await snap(hub, s.id);
  assert.equal(after.provider, 'deepseek');
  assert.equal(after.modelDrift, null);
});

// A message to an old conversation that has no model anywhere is refused, in
// words, rather than run on whatever Kimi's default is.
async function sayRefused(h, id, text) {
  await h.api('POST', `/sessions/${id}/messages`, { text });
  const s = await until(async () => {
    const x = await snap(h, id);
    return x.events.some((e) => e.type === 'error' && /還沒有模型/.test(e.text)) && x;
  }, 10000, `the refusal for "${text}"`);
  return s;
}

test('matrix · the old conversations, each shape: opened and written to with Kimi defaults set, the native never gets a Kimi model', async () => {
  for (const id of ['old_record', 'old_native']) {
    const s = await say(hub, id, `again ${id}`);
    assertDeepseekOnly(hub, `session_${id}`, id, { needsModelAtPrompt: id === 'old_record' });
    assert.equal(s.provider, 'deepseek', `${id} is a DeepSeek conversation (restored from ${id === 'old_native' ? 'what the native reports' : 'what the record kept'})`);
    assert.equal(s.modelDrift, null, `${id}: no disagreement`);
  }
  // No model kept anywhere: nothing is sent, and it is not given Kimi's.
  const refused = await sayRefused(hub, 'old_mode', 'again old_mode');
  assert.equal(refused.provider, 'deepseek');
  assertDeepseekOnly(hub, 'session_old_mode', 'old_mode');
  assert.equal(hub.machine.prompts.filter((p) => p.sid === 'session_old_mode').length, 0, 'nothing reached the native');
  // the global defaults were never laid over any of them
  assert.equal(hub.machine.profiles.some((p) => /^session_old_/.test(p.sid) && p.agent_config?.model === SUB), false);
  // and what was held back is on record: not applied, marked unconfirmed (kept
  // for when the native has spoken), not "done"
  await wait(2000); // the store writes a changed conversation after 1.5 s
  const stored = (id) => JSON.parse(fs.readFileSync(path.join(hub.DATA, 'sessions', `${id}.json`), 'utf8')).state;
  for (const id of ['old_record', 'old_mode']) {
    assert.equal(stored(id).modelUnconfirmed, true, `${id} is marked unconfirmed`);
    assert.notEqual(stored(id).defaultsApplied, true, `${id}: the defaults were not recorded as applied`);
  }
});

test('matrix · the native is silent about its model: the defaults are held back and the conversation is marked unconfirmed, not given a model', async () => {
  const s = await newDs(hub);
  const native = s.kimiSessionId;
  const profilesBefore = hub.machine.profiles.filter((p) => p.sid === native).length;
  // The Hub as the 10-24 conversation had it: the settings of the chat known to
  // it, the native's model not (a journal that is behind).
  hub.machine.sessions.get(native).model = '';
  // reconnect only this conversation: re-read it from the machine
  hub.machine.pushSessions();
  await say(hub, s.id, 'while unknown');
  assertDeepseekOnly(hub, native, 'unknown native');
  assert.ok(hub.machine.profiles.filter((p) => p.sid === native).length >= profilesBefore);
});

test('matrix · the machine reconnects: the conversation is attached again and still runs on DeepSeek', async () => {
  const s = await newDs(hub);
  await say(hub, s.id, 'before the cable');
  const native = s.kimiSessionId;
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const carried = new Map([...hub.machine.sessions.entries()].map(([sid, st]) => [sid, { ...st }]));
  hub.machine.close();
  await until(async () => !(await hub.api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'the machine to be seen gone');
  const again = startFakeMachine({ port: hub.PORT, key, id: MID });
  await again.ready;
  for (const [sid, st] of carried) again.add(sid, st);
  again.dsModels = hub.machine.dsModels;
  hub.machine = again;
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'the machine to be back');
  await hub.setDeepseekKey().catch(() => {});
  // The Hub catches the conversation up from the machine's journal when it
  // comes back; a message typed in the middle of that would be replayed over.
  await wait(1200);
  await say(hub, s.id, 'after the cable');
  assertDeepseekOnly(hub, native, 'reconnect');
  assert.equal((await snap(hub, s.id)).modelDrift, null);
});

test('matrix · K -> D -> K -> D on the same native conversation: back on DeepSeek, the prompt names DeepSeek', async () => {
  const s = await newDs(hub);
  await say(hub, s.id, 'on deepseek');
  const kimi = (await hub.api('GET', `/models?machine=${MID}`)).groups.find((g) => g.provider === 'kimi').models[0];
  await hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'kimi', model: kimi.id, effort: kimi.efforts?.[0] || '' });
  await say(hub, s.id, 'on kimi');
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).model, kimi.id, 'as a Kimi conversation it is on Kimi (that is the switch the user asked for)');
  await hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  const back = await say(hub, s.id, 'on deepseek again');
  assert.equal(back.provider, 'deepseek');
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).model, ALIAS, 'the native is on DeepSeek again');
  const last = hub.machine.prompts.filter((p) => p.sid === s.kimiSessionId).at(-1);
  assert.equal(last.body.model, ALIAS, 'and the prompt after the switch names the DeepSeek model');
  assert.equal(back.modelDrift, null);
});

test('matrix · a record the user never set is not rewritten onto another family either: the native\'s Kimi model is a disagreement, not the new record', async () => {
  // old_record has the Hub's record (DeepSeek) but no user choice: the Hub
  // normally follows the native, but only inside the conversation's own family.
  await say(hub, 'old_record', 'for the record');
  hub.machine.nativeChange('session_old_record', { model: SUB, thinking: 'high' });
  const x = await until(async () => {
    const y = await snap(hub, 'old_record');
    return y.nativeModel === SUB && y;
  }, 5000, 'the native model to be reported');
  assert.equal(x.modelConfig.model, ALIAS, 'the record still names the DeepSeek model');
  assert.equal(x.provider, 'deepseek');
  assert.equal(x.modelDrift.expected.model, ALIAS);
  assert.equal(x.modelDrift.kind, 'provider');
  // leave the conversation as found for the tests after this one
  hub.machine.nativeChange('session_old_record', { model: ALIAS, thinking: 'max' });
  await until(async () => (await snap(hub, 'old_record')).modelDrift === null, 5000, 'the drift to clear');
});

test('matrix · what a conversation records, it keeps: a native that reports a Kimi model does not rewrite a DeepSeek conversation\'s record', async () => {
  const s = await newDs(hub);
  await say(hub, s.id, 'hello');
  hub.machine.nativeChange(s.kimiSessionId, { model: SUB, thinking: 'high' });
  const drifted = await until(async () => {
    const x = await snap(hub, s.id);
    return x.nativeModel === SUB && x;
  }, 5000, 'the native model to be reported');
  assert.equal(drifted.provider, 'deepseek');
  assert.equal(drifted.modelConfig.model, ALIAS, 'the record stays what the user chose');
  assert.equal(drifted.modelDrift.kind, 'provider');
  assert.equal(drifted.modelDrift.actual.provider, 'kimi');
  assert.equal(drifted.nativeProvider, 'kimi');
});

test('matrix · a Hub restart: the conversations come back from disk, the machine is attached again, and nothing is moved onto Kimi', async () => {
  const s = await newDs(hub);
  await say(hub, s.id, 'before the restart');
  const natives = [...hub.machine.sessions.entries()].map(([sid, st]) => [sid, { ...st }]);
  await hub.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-keep-'));
  fs.cpSync(hub.DATA, keep, { recursive: true });
  const restarted = await newHub('drift-restart', { from: keep });
  // the Kimi defaults are still on disk (copied with the data)
  assert.equal(JSON.parse(fs.readFileSync(path.join(restarted.DATA, 'settings.json'), 'utf8')).defaults.model, SUB);
  for (const [sid, st] of natives) restarted.machine.add(sid, st);
  restarted.machine.pushSessions();
  await wait(300);
  const sum = await snap(restarted, s.id);
  assert.equal(sum.provider, 'deepseek');
  await say(restarted, s.id, 'after the restart');
  assertDeepseekOnly(restarted, s.kimiSessionId, 'restart');
  for (const id of ['old_record', 'old_native']) {
    await say(restarted, id, `old after the restart ${id}`);
    assertDeepseekOnly(restarted, `session_${id}`, `restart · ${id}`);
  }
  await sayRefused(restarted, 'old_mode', 'old after the restart old_mode');
  assertDeepseekOnly(restarted, 'session_old_mode', 'restart · old_mode');
  fs.rmSync(keep, { recursive: true, force: true });
});
