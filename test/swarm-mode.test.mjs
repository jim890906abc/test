// Swarm mode from the Hub, through the REAL Hub (runner, kimi-remote adapter)
// with only the outside faked: the Kimi server of a machine (whose /profile,
// /status and event stream imitate what the real Kimi 2.3.3 does with
// `agent_config.swarm_mode`; test/e2e-swarm.test.mjs runs the real one) and
// the Anthropic API.
//
// What a person needs: turning swarm mode on/off in a Kimi or DeepSeek
// conversation really reaches Kimi (the main model's AgentSwarm call is
// refused with "Swarm mode is off" until then), the Hub shows what Kimi says
// (not only what the Hub asked for), a Kimi that cannot do it is said so
// instead of pretending, a Claude conversation has no such mode, and in a
// terminal the Hub only sends Kimi's own /swarm command (never the API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until } from './fixtures/real-hub.mjs';

const MID = 'm_fake';
let hub;
let CWD;
let KIMI;
let DEEPSEEK;
let CLAUDE;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const config = (id, body) => hub.api('POST', `/sessions/${id}/config`, body);
const newKimi = (extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const newDeepseek = (extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model: DEEPSEEK.model, effort: 'max', permission: 'auto', ...extra });
const newClaude = (extra = {}) => hub.api('POST', '/sessions', { provider: 'claude', machineId: MID, cwd: CWD, model: CLAUDE.model, effort: CLAUDE.effort, permission: 'auto', ...extra });
// What Kimi was told about swarm mode, in order, for one native conversation.
const swarmProfiles = (kid) => hub.machine.profiles.filter((p) => p.sid === kid && p.agent_config && 'swarm_mode' in p.agent_config).map((p) => p.agent_config.swarm_mode);
const typedInto = () => hub.machine.rpcs.filter((r) => r.op === 'kimi.tui.input').map((r) => r.args);

before(async () => {
  // The wait for a terminal Kimi's picker is real time; the fake machine has no picker.
  process.env.AGENT_HUB_TUI_PICKER_MS = '30';
  hub = await startRealHub('swarm-mode', { claude: true });
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

test('Kimi: swarm on and off reach Kimi as agent_config.swarm_mode, and the conversation shows what Kimi took', async () => {
  const s = await newKimi();
  assert.ok(!s.meta.swarmMode, 'a new conversation starts with swarm mode off');

  const on = await config(s.id, { swarmMode: true });
  assert.deepEqual(swarmProfiles(s.kimiSessionId), [true], 'Kimi was told once, with true');
  assert.equal(on.meta.swarmMode, true, 'the answer already says on');
  assert.equal((await snap(s.id)).meta.swarmMode, true, 'and so does the conversation');
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).swarm, true, 'Kimi really has it on');

  const off = await config(s.id, { swarmMode: false });
  assert.deepEqual(swarmProfiles(s.kimiSessionId), [true, false]);
  assert.equal(off.meta.swarmMode, false);
  assert.equal((await snap(s.id)).meta.swarmMode, false);
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).swarm, false);
});

test('swarm mode is a setting by itself: it changes nothing else of the conversation', async () => {
  const s = await newKimi({ planMode: true });
  const before = await snap(s.id);
  await config(s.id, { swarmMode: true });
  const after = await snap(s.id);
  for (const k of ['model', 'effort', 'permission', 'planMode']) assert.equal(after.meta[k], before.meta[k], `${k} stays`);
  assert.equal(after.model, before.model);
  const profile = hub.machine.profiles.filter((p) => p.sid === s.kimiSessionId && 'swarm_mode' in p.agent_config).at(-1);
  assert.deepEqual(profile.agent_config, { swarm_mode: true }, 'only swarm_mode was sent');
});

test('Kimi says it changed by itself (/swarm in a terminal, another client): the conversation follows, both ways', async () => {
  const s = await newKimi();
  hub.machine.sessions.get(s.kimiSessionId).swarm = true;
  hub.machine.frame(s.kimiSessionId, 'agent.status.updated', { swarmMode: true });
  await until(async () => (await snap(s.id)).meta.swarmMode === true, 5000, 'swarm on, as Kimi says');
  hub.machine.sessions.get(s.kimiSessionId).swarm = false;
  hub.machine.frame(s.kimiSessionId, 'agent.status.updated', { swarmMode: false });
  await until(async () => (await snap(s.id)).meta.swarmMode === false, 5000, 'swarm off, as Kimi says');
  // A status report that does not mention swarm mode (a model change) leaves it alone.
  hub.machine.frame(s.kimiSessionId, 'agent.status.updated', { swarmMode: true });
  await until(async () => (await snap(s.id)).meta.swarmMode === true, 5000, 'on again');
  hub.machine.frame(s.kimiSessionId, 'agent.status.updated', { thinkingEffort: 'high' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await snap(s.id)).meta.swarmMode, true, 'a report about something else does not turn it off');
});

test('DeepSeek runs in Kimi: its swarm mode is Kimi\'s, set the same way', async () => {
  const s = await newDeepseek();
  assert.equal(s.provider, 'deepseek');
  const on = await config(s.id, { swarmMode: true });
  assert.deepEqual(swarmProfiles(s.kimiSessionId), [true]);
  assert.equal(on.meta.swarmMode, true);
  assert.equal(on.provider, 'deepseek', 'still a DeepSeek conversation');
  await config(s.id, { swarmMode: false });
  assert.deepEqual(swarmProfiles(s.kimiSessionId), [true, false]);
  assert.equal((await snap(s.id)).meta.swarmMode, false);
});

test('a Kimi that has no swarm mode (older) is said so; the conversation does not claim it is on', async () => {
  const s = await newKimi();
  hub.machine.swarmUnsupported = true;
  try {
    await assert.rejects(config(s.id, { swarmMode: true }), (e) => {
      assert.equal(e.status, 502);
      assert.match(e.message, /swarm/);
      assert.match(e.message, /沒有.*swarm 模式|不支援/);
      return true;
    });
  } finally {
    hub.machine.swarmUnsupported = false;
  }
  assert.notEqual((await snap(s.id)).meta.swarmMode, true, 'not shown as on');
});

test('Kimi answers "ok" but its status says it did not take it: the failure is shown and the conversation keeps what Kimi has', async () => {
  const s = await newKimi();
  await config(s.id, { swarmMode: true });
  hub.machine.swarmIgnore = true;
  try {
    await assert.rejects(config(s.id, { swarmMode: false }), (e) => {
      assert.equal(e.status, 502);
      assert.match(e.message, /swarm/);
      return true;
    });
  } finally {
    hub.machine.swarmIgnore = false;
  }
  assert.equal((await snap(s.id)).meta.swarmMode, true, 'the Hub still says on: that is what Kimi says');
});

test('a Claude conversation has no swarm mode: refused with a reason, nothing changes', async () => {
  const s = await newClaude();
  await assert.rejects(config(s.id, { swarmMode: true }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /Claude.*swarm/);
    return true;
  });
  const after = await snap(s.id);
  assert.ok(!after.meta.swarmMode);
});

test('only true or false is a swarm setting; anything else is refused and nothing is sent to Kimi', async () => {
  const s = await newKimi();
  const profiles = hub.machine.profiles.length;
  for (const bad of ['on', 'yes', 1, null]) {
    await assert.rejects(config(s.id, { swarmMode: bad }), (e) => e.status === 400, `${JSON.stringify(bad)} is refused`);
  }
  assert.equal(hub.machine.profiles.length, profiles, 'nothing reached Kimi');
});

// ---------------------------------------------------------------- terminal

async function terminalKimi(name, permission) {
  const sid = `session_swarm_${name}`;
  hub.machine.add(sid, { title: `terminal ${name}`, cwd: CWD, model: KIMI.model, owner: 'tui', controllable: true, permission });
  hub.machine.pushSessions();
  const node = await hub.api('POST', `/machines/${MID}/kimi/${sid}/attach`);
  await until(async () => (await snap(node.id)).meta.controllable === true, 5000, 'attached as controllable');
  return { node, sid };
}

test('a terminal Kimi the Hub controls: swarm on/off is Kimi\'s own /swarm sent in, never the API', async () => {
  const { node, sid } = await terminalKimi('auto', 'auto');
  const typedBefore = typedInto().length;
  const profilesBefore = hub.machine.profiles.length;

  const on = await config(node.id, { swarmMode: true });
  assert.deepEqual(typedInto().slice(typedBefore), [{ sessionId: sid, action: 'send', text: '/swarm on', mode: 'enter' }], 'exactly /swarm on, pasted and submitted: no picker in Never Ask, so no more keys');
  assert.equal(on.meta.swarmMode, true);

  await config(node.id, { swarmMode: false });
  assert.deepEqual(typedInto().slice(typedBefore).map((t) => t.text), ['/swarm on', '/swarm off']);
  assert.equal((await snap(node.id)).meta.swarmMode, false);
  assert.equal(hub.machine.profiles.length, profilesBefore, 'nothing went through Kimi\'s API');
  assert.deepEqual(swarmProfiles(sid), []);
});

test('a terminal in "ask every time": Kimi opens a picker whose default switches the terminal to Never Ask; the Hub picks "Start in Always Ask" instead, and never confirms the default', async () => {
  const { node, sid } = await terminalKimi('manual', 'manual');
  assert.equal((await snap(node.id)).meta.permission, 'manual', 'the premise');
  const typedBefore = typedInto().length;
  await config(node.id, { swarmMode: true });
  const typed = typedInto().slice(typedBefore);
  assert.deepEqual(typed[0], { sessionId: sid, action: 'send', text: '/swarm on', mode: 'enter' });
  assert.ok(!typed.some((t) => t.confirm), 'Enter on the picker\'s default would silently turn approvals off');
  // The picker's choices are: 1 Never Ask, 2 Ask When Needed, 3 Always Ask. Down, Down, Enter (the bridge adds the Enter).
  assert.deepEqual(typed.slice(1), [{ sessionId: sid, action: 'command', text: '\x1b[B\x1b[B' }]);
  assert.equal((await snap(node.id)).meta.permission, 'manual', 'the permission the person had is the one they keep');
  // Turning it off has no picker.
  const n = typedInto().length;
  await config(node.id, { swarmMode: false });
  assert.deepEqual(typedInto().slice(n).map((t) => t.text), ['/swarm off']);
});

test('a terminal where the same change also sets the permission to Never Ask: no picker to answer', async () => {
  const { node } = await terminalKimi('both', 'manual');
  const n = typedInto().length;
  await config(node.id, { permission: 'auto', swarmMode: true });
  const texts = typedInto().slice(n).map((t) => t.text);
  assert.ok(texts.includes('/swarm on'));
  assert.ok(!texts.includes('\x1b[B\x1b[B'), `no picker keys after /auto: ${JSON.stringify(texts)}`);
});

test('a terminal where the person cancelled Kimi\'s picker: Kimi\'s word that swarm is off corrects the Hub', async () => {
  const { node, sid } = await terminalKimi('cancel', 'auto');
  await config(node.id, { swarmMode: true });
  assert.equal((await snap(node.id)).meta.swarmMode, true, 'what the Hub typed');
  hub.machine.frame(sid, 'agent.status.updated', { swarmMode: false });
  await until(async () => (await snap(node.id)).meta.swarmMode === false, 5000, 'corrected by Kimi');
});
