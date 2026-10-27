// A conversation's subagent setting must have a real effect, or say plainly
// that it cannot. A scripted computer speaks the bridge protocol (config
// answers, prompt bodies recorded) and the real Kimi adapter, policy module
// and machine registry run against it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-subagent-policy-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

let kimi;
let machines;
let store;
let policy;
let broker;
let runner;
const FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
const PRO = 'agent-hub-deepseek/deepseek-v4-pro';
const bridges = new Map();
const configs = new Map(); // machine id -> the [secondary_model] its Kimi has (snake_case, as the Server API says)
const configFails = new Set();
const configDelay = new Map(); // machine id -> ms its Kimi takes to answer the settings read
const calls = [];

function fakeBridge(id, { caps, broker: brokerFlag = 1 } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req') return;
    calls.push({ machine: id, op: msg.op, args: msg.args });
    let data = {};
    let ok = true;
    if (msg.op === 'kimi.request') {
      const { method, path: p } = msg.args;
      if (method === 'GET' && p === '/api/v1/config') {
        if (configFails.has(id)) ok = false;
        data = { code: 0, data: { default_model: 'fake', ...(configs.has(id) ? { secondary_model: configs.get(id) } : {}) } };
      } else if (method === 'GET' && p === '/api/v1/models') data = { code: 0, data: { items: [] } };
      else if (method === 'POST' && /\/prompts$/.test(p)) data = { code: 0, data: { status: 'started' } };
      else data = { code: 0, data: {} };
    } else if (msg.op === 'kimi.history') {
      data = { frames: [], more: false, before: 0, info: bridges.get(id).info?.[msg.args.sessionId] };
    }
    const answer = () => ws.emit('message', JSON.stringify(ok ? { t: 'res', id: msg.id, ok: true, data } : { t: 'res', id: msg.id, ok: false, error: '連接器沒有回應' }));
    if (msg.op === 'kimi.request' && msg.args.path === '/api/v1/config' && configDelay.get(id)) setTimeout(answer, configDelay.get(id));
    else queueMicrotask(answer);
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, platform: 'linux', home: TMP, bridgeVersion: '0.10.0', ...(brokerFlag ? { broker: brokerFlag } : {}), status: { available: true, server: true, version: '2.3.3' } }));
  if (caps) machines.getMachine(id).capabilities = caps;
  ws.info = {};
  bridges.set(id, ws);
  return ws;
}

function contextFor(session) {
  return {
    session,
    emit(fields) {
      const ev = { id: `e_${session.events.length}_${Math.random().toString(16).slice(2, 6)}`, ts: Date.now(), ...fields };
      session.events.push(ev);
      return ev;
    },
    patch: (ev, fields) => Object.assign(ev, fields),
    delta(ev, text, field = 'text') {
      ev[field] = (ev[field] || '') + text;
    },
    setStatus: (st) => (session.status = st),
    setMeta: (fields) => (session.meta = { ...(session.meta || {}), ...fields }),
    setTitle: (t) => (session.title = t),
    replaceEvents: (events) => (session.events = events),
  };
}

let n = 0;
async function makeSession({ machine, subagent, explicit = false, controllable = false, owner = null }) {
  const kid = `session_pol_${++n}`;
  const ws = bridges.get(machine);
  const info = { id: kid, title: 't', owner, controllable, guess: false, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', model: 'fake', permission: 'manual', workspace_id: 'ws', todos: [] };
  ws.info[kid] = info;
  machines.getMachine(machine).sessions = [...(machines.getMachine(machine).sessions || []), { id: kid, title: 't', owner, controllable, guess: false, busy: false, pending: 'none' }];
  const session = store.createSession({
    id: `s_pol_${n}`,
    machineId: machine,
    kimiSessionId: kid,
    agentId: `kimi@${machine}`,
    title: 't',
    status: 'idle',
    provider: 'kimi',
    meta: { model: 'fake', ...(subagent ? { subagent } : {}) },
    state: { defaultsApplied: true, ...(explicit ? { subagentExplicit: true } : {}) },
  });
  kimi.init((s) => contextFor(s));
  kimi.restore(session);
  await kimi.attach(session);
  return session;
}

const prompts = (sid) => calls.filter((c) => c.op === 'kimi.request' && c.args.method === 'POST' && c.args.path === `/api/v1/sessions/${sid}/prompts`);
const tui = () => calls.filter((c) => c.op === 'kimi.tui.input');
const infos = (s) => s.events.filter((e) => e.type === 'info' && e.subagentNotice);
const body = (c) => c.args.body;
const flash = { model: FLASH, models: { [FLASH]: 'flash' }, default_effort: 'max' };

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  kimi = await import('../server/adapters/kimi-remote.js');
  policy = await import('../server/subagent-policy.js');
  broker = await import('../server/subagent-broker.js');
  runner = await import('../server/runner.js');
  fs.mkdirSync(process.env.AGENT_HUB_DATA, { recursive: true });
  fakeBridge('m_ok');
  fakeBridge('m_nosec');
  fakeBridge('m_k3');
  fakeBridge('m_pool');
  fakeBridge('m_old', { broker: 0 });
  configs.set('m_ok', { default_model: FLASH, default_effort: 'max', models: { [FLASH]: 'DeepSeek V4.1 Flash' } });
  configs.set('m_k3', { default_model: 'kimi-code/k3', default_effort: 'high', models: { 'kimi-code/k3': 'K3' } });
  configs.set('m_pool', { default_model: FLASH, default_effort: 'max', models: { [FLASH]: 'DeepSeek V4.1 Flash', 'kimi-code/k3.1-pro': 'K3.1 Pro (手選)' } });
});

after(async () => {
  for (const ws of bridges.values()) ws.emit('close');
  store.flushAll();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const DS_DEFAULT = { provider: 'deepseek', model: FLASH, effort: 'max' };

test('native DeepSeek default on a computer whose [secondary_model] is that model: no token, no disabled tools, no notice', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: DS_DEFAULT });
  await kimi.send(s, 'hi');
  const [p] = prompts(s.kimiSessionId).slice(-1);
  assert.ok(p, 'prompt sent');
  assert.equal(body(p).disabled_tools, undefined, 'native tools stay');
  assert.ok(!JSON.stringify(body(p)).includes('hb_'), 'no delegation token');
  assert.equal(infos(s).length, 0);
  const info = policy.infoOf(s);
  assert.equal(info.scope, 'machine-global');
  assert.equal(info.route, 'native');
  assert.equal(info.ready, true);
  assert.equal(info.effective.model, FLASH, 'what the computer really has');
  kimi.dispose(s);
});

test('a computer with no [secondary_model] cannot give a DeepSeek subagent: the native tools are held back and the conversation says why and how to fix it', async () => {
  const s = await makeSession({ machine: 'm_nosec', subagent: DS_DEFAULT });
  machines.getMachine('m_nosec').provision = { ok: false, at: Date.now(), reason: '還沒有設定 DeepSeek key' };
  await kimi.send(s, 'hi');
  const [p] = prompts(s.kimiSessionId).slice(-1);
  assert.deepEqual(body(p).disabled_tools, ['Agent', 'AgentSwarm', 'agent', 'agent_swarm'], 'a subagent must not run on the main model while looking like DeepSeek');
  assert.ok(!JSON.stringify(body(p)).includes('hb_'), 'no token: this is not the broker');
  const [notice] = infos(s);
  assert.ok(notice, 'a system info event in the conversation');
  assert.match(notice.text, /DeepSeek/);
  assert.match(notice.text, /還沒有設定 DeepSeek key/, 'the provision reason is named');
  assert.match(notice.text, /修復/);
  const info = policy.infoOf(s);
  assert.equal(info.ready, false);
  assert.equal(info.code, 'no_secondary');
  assert.equal(info.scope, 'machine-global');
  assert.equal(info.effective, null);
  // The same problem is not repeated on every prompt.
  await kimi.send(s, 'again');
  assert.equal(infos(s).length, 1);
  kimi.dispose(s);
});

test('once the computer can do it, the next prompt puts the native tools back', async () => {
  const s = await makeSession({ machine: 'm_nosec', subagent: DS_DEFAULT });
  policy.forgetSecondary('m_nosec');
  await kimi.send(s, 'hi');
  assert.ok(body(prompts(s.kimiSessionId).at(-1)).disabled_tools.length, 'held back');
  configs.set('m_nosec', flash);
  // No forgetting here: an "absent" answer is never remembered, or a prompt
  // sent just after a provision lands would still be held back.
  await kimi.send(s, 'again');
  assert.deepEqual(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, [], 'restored');
  assert.equal(s.state.nativeSubagentDisabled, false);
  configs.delete('m_nosec');
  policy.forgetSecondary('m_nosec');
  kimi.dispose(s);
});

test('a problem seen in a remembered answer is checked against the computer before a prompt is held back', async () => {
  configs.set('m_flip', { default_model: FLASH, default_effort: 'max', models: { [FLASH]: 'x' } });
  fakeBridge('m_flip');
  const s = await makeSession({ machine: 'm_flip', subagent: DS_DEFAULT });
  policy.forgetSecondary('m_flip');
  await kimi.send(s, 'one');
  assert.equal(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, undefined);
  assert.equal(policy.cachedSecondary('m_flip').state, 'ok', 'remembered');
  // The computer was changed to Pro · low (that is what the conversation now asks for), within the
  // time the old answer is remembered: judged by the old answer alone, Pro would look like a mismatch.
  configs.set('m_flip', { default_model: PRO, default_effort: 'low', models: { [PRO]: 'x' } });
  s.meta.subagent = { provider: 'deepseek', model: PRO, effort: 'low' };
  const asked = () => calls.filter((c) => c.machine === 'm_flip' && c.args?.path === '/api/v1/config').length;
  const n = asked();
  await kimi.send(s, 'two');
  assert.ok(asked() > n, 'asked the computer again before believing the mismatch');
  assert.equal(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, undefined, 'and it matched, so nothing was held back');
  assert.equal(policy.infoOf(s).ready, true);
  kimi.dispose(s);
});

test('the message is shown and the conversation marked running before the computer\'s settings are read', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: DS_DEFAULT });
  policy.forgetSecondary('m_ok');
  configDelay.set('m_ok', 400);
  try {
    const sending = kimi.send(s, 'slow read');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.status, 'running', 'a slow read must not leave the conversation looking idle');
    assert.ok(s.events.some((e) => e.type === 'user' && e.text === 'slow read'));
    assert.equal(prompts(s.kimiSessionId).filter((c) => body(c).content.some((p) => p.text === 'slow read')).length, 0, 'not posted yet');
    await sending;
    assert.equal(prompts(s.kimiSessionId).filter((c) => body(c).content.some((p) => p.text === 'slow read')).length, 1);
  } finally {
    configDelay.delete('m_ok');
  }
  kimi.dispose(s);
});

test('a computer whose own default is not DeepSeek is reported, not overwritten and not run as DeepSeek', async () => {
  const s = await makeSession({ machine: 'm_k3', subagent: DS_DEFAULT });
  await kimi.send(s, 'hi');
  assert.ok(body(prompts(s.kimiSessionId).at(-1)).disabled_tools.length);
  assert.equal(policy.infoOf(s).code, 'secondary_not_deepseek');
  assert.match(infos(s)[0].text, /kimi-code\/k3/);
  assert.deepEqual(configs.get('m_k3').default_model, 'kimi-code/k3', 'the user setting is untouched');
  kimi.dispose(s);
});

test('an explicit DeepSeek choice that differs from the computer default goes through the broker, per conversation', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: { provider: 'deepseek', model: PRO, effort: 'low' }, explicit: true });
  await kimi.send(s, 'hi');
  const b = body(prompts(s.kimiSessionId).at(-1));
  assert.deepEqual(b.disabled_tools, ['Agent', 'AgentSwarm', 'agent', 'agent_swarm'], 'the native tools would use the computer default instead');
  assert.match(JSON.stringify(b.content), /hb_[0-9a-f]{48}/, 'the broker token is what lets it delegate');
  assert.match(JSON.stringify(b.content), /deepseek-v4-pro/);
  const info = policy.infoOf(s);
  assert.equal(info.route, 'broker');
  assert.equal(info.scope, 'conversation');
  assert.deepEqual(info.effective, { provider: 'deepseek', model: PRO, effort: 'low' }, 'the conversation value is what runs');
  kimi.dispose(s);
});

test('an explicit choice equal to the computer default stays native', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: DS_DEFAULT, explicit: true });
  await kimi.send(s, 'hi');
  assert.equal(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, undefined);
  assert.equal(policy.infoOf(s).route, 'native');
  kimi.dispose(s);
});

test('a connector without the broker: the choice is refused out loud and the native tools are NOT disabled', async () => {
  const s = await makeSession({ machine: 'm_old', subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, explicit: true });
  const before = prompts(s.kimiSessionId).length;
  const r = await kimi.send(s, 'hi').catch((e) => ({ ok: false, error: e.message }));
  assert.equal(r.ok, false);
  assert.match(r.error, /連接器太舊/);
  assert.equal(prompts(s.kimiSessionId).length, before, 'nothing was sent with half a policy (tools disabled, no route)');
  kimi.dispose(s);
});

test('a token that cannot be issued does not leave the main agent without any way to start a subagent', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, explicit: true });
  const kid = s.kimiSessionId;
  delete s.kimiSessionId; // there is no native session to bind a token to
  const before = prompts(kid).length;
  const r = await kimi.send(s, 'hi').catch((e) => ({ ok: false, error: e.message }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /token/);
  assert.equal(prompts(kid).length, before, 'tools were not disabled for a route that cannot be used');
  kimi.dispose(s);
});

test('a controllable terminal conversation: the policy is applied per prompt, over the API when it needs a prompt body', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, explicit: true, owner: 'tui', controllable: true });
  calls.length = 0;
  await kimi.send(s, 'hi');
  assert.equal(tui().length, 0, 'typing into the terminal would carry neither token nor tool policy');
  const b = body(prompts(s.kimiSessionId).at(-1));
  assert.deepEqual(b.disabled_tools, ['Agent', 'AgentSwarm', 'agent', 'agent_swarm']);
  assert.match(JSON.stringify(b.content), /hb_/);
  // Back to the native rule: the held-back tools must be restored, which also needs a prompt body.
  s.meta.subagent = DS_DEFAULT;
  calls.length = 0;
  await kimi.send(s, 'again');
  assert.equal(tui().length, 0);
  assert.deepEqual(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, []);
  // With nothing to apply the terminal is typed into as before.
  calls.length = 0;
  s.status = 'idle'; // the previous turns never end in this script
  s.meta.queue = [];
  await kimi.send(s, 'third');
  assert.equal(tui().length, 1);
  assert.equal(prompts(s.kimiSessionId).length, 0);
  kimi.dispose(s);
});

test('the hook refuses a main model that picks another pool model or "primary" for a DeepSeek conversation, and lets the default through', async () => {
  const s = await makeSession({ machine: 'm_pool', subagent: DS_DEFAULT });
  const ask = (toolInput) => broker.handleBridgeRequest('m_pool', { kind: 'hook', args: { sessionId: s.kimiSessionId, toolName: 'Agent', toolInput } });
  assert.equal((await ask({ prompt: 'x' })).deny, false);
  assert.equal((await ask({ prompt: 'x', model: FLASH })).deny, false);
  const bad = await ask({ prompt: 'x', model: 'kimi-code/k3.1-pro' });
  assert.equal(bad.deny, true);
  assert.match(bad.reason, /DeepSeek/);
  assert.equal((await ask({ prompt: 'x', model: 'primary' })).deny, true);
  assert.equal((await ask({ agents: [{ prompt: 'y', model: 'kimi-code/k3.1-pro' }] })).deny, true, 'a swarm entry too');
  kimi.dispose(s);
});

test('the hook stops a native Agent when the request cannot be honoured, naming the reason', async () => {
  const s = await makeSession({ machine: 'm_nosec', subagent: DS_DEFAULT });
  configs.delete('m_nosec');
  delete machines.getMachine('m_nosec').provision;
  policy.forgetSecondary('m_nosec');
  const r = await broker.handleBridgeRequest('m_nosec', { kind: 'hook', args: { sessionId: s.kimiSessionId, toolName: 'Agent' } });
  assert.equal(r.deny, true);
  assert.match(r.reason, /DeepSeek/);
  assert.match(r.reason, /\[secondary_model\]/);
  kimi.dispose(s);
});

test('a computer whose settings cannot be read is unknown, not a verdict: the prompt goes out and the card says unverified', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: DS_DEFAULT });
  policy.forgetSecondary('m_ok');
  configFails.add('m_ok');
  try {
    await kimi.send(s, 'hi');
    assert.equal(body(prompts(s.kimiSessionId).at(-1)).disabled_tools, undefined);
    assert.equal(policy.infoOf(s).ready, null);
    assert.equal(policy.infoOf(s).code, 'unknown');
  } finally {
    configFails.delete('m_ok');
    policy.forgetSecondary('m_ok');
  }
  kimi.dispose(s);
});

test('summaries carry the scope and the effective value for the browser', async () => {
  const s = await makeSession({ machine: 'm_ok', subagent: DS_DEFAULT });
  await policy.refresh(s);
  const sum = runner.summarize(s);
  assert.equal(sum.subagentInfo.scope, 'machine-global');
  assert.equal(sum.subagentInfo.effective.model, FLASH);
  assert.equal(sum.subagent.model, FLASH, 'the stored request is still there');
  kimi.dispose(s);
});
