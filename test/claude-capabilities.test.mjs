// The Hub does not send an older Claude daemon a field it would accept and
// silently ignore (a handoff, a subagent setting): it asks what the daemon
// can do, refuses with an upgrade message, and checks that what it sent
// really landed. A scripted computer speaks the connector protocol for
// `claude.rpc` and plays an older or a newer daemon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-claude-caps-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
fs.mkdirSync(process.env.AGENT_HUB_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.AGENT_HUB_DATA, 'claude.json'), JSON.stringify({ apiKey: `sk-ant-api03-${'k'.repeat(40)}-test` }));
let store;
let machines;
let mirror;
let policy;
let runner;
const calls = []; // { machine, op, args } the daemons were asked
const daemons = new Map(); // machine id -> behaviour

// One scripted computer. `caps === null` plays a daemon that has never heard
// of `capabilities` (the old kind); `landHandoff: false` plays one that takes
// a handoff and forgets it.
function connect(id, { caps, landHandoff = true } = {}) {
  daemons.set(id, { caps, landHandoff });
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'req') return;
    const reply = (ok, data, error) => queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: m.id, ok, ...(ok ? { data } : { error }) })));
    if (m.op !== 'claude.rpc') return reply(true, {});
    const { op, args } = m.args;
    calls.push({ machine: id, op, args });
    const d = daemons.get(id);
    if (op === 'capabilities') {
      if (d.caps === null) return reply(false, null, `Claude 背景程式不認得這個操作：capabilities`);
      return reply(true, { version: 'x', capabilities: d.caps });
    }
    if (op === 'create') {
      const events = [];
      if (args.config?.handoff && d.landHandoff) events.push({ id: 'e_h', ts: 1, type: 'info', text: '已接續先前對話', handoff: { from: 'Kimi' } });
      return reply(true, { id: args.id, title: args.title, status: 'idle', cwd: args.cwd, meta: { model: 'claude-opus-5-5', ...(args.config?.subagent ? { subagent: args.config.subagent } : {}) }, seq: events.length, events });
    }
    if (op === 'send') return reply(true, { status: 'running', seq: 1 });
    if (op === 'snapshot') return reply(true, { id: args.id, status: 'idle', cwd: TMP, meta: {}, seq: 0, events: [] });
    return reply(true, {});
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, platform: 'linux', home: TMP, bridgeVersion: '0.10.0', status: { available: false } }));
  return ws;
}

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  runner = await import('../server/runner.js'); // gives the adapters their context
  mirror = await import('../server/adapters/claude-mirror.js');
  policy = await import('../server/subagent-policy.js');
  connect('m_old', { caps: null });
  connect('m_new', { caps: ['broker', 'handoff', 'subagent_config'] });
  connect('m_forgetful', { caps: ['broker', 'handoff', 'subagent_config'], landHandoff: false });
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
const node = (machineId, extra = {}) => store.createSession({ id: `s_cap_${++n}`, agentId: 'claude', provider: 'claude', machineId, cwd: TMP, title: 't', ...extra });
const sentOps = (machine) => calls.filter((c) => c.machine === machine).map((c) => c.op);
const DS = { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' };

test('a daemon that does not know "capabilities" has none; a daemon that answers is believed', async () => {
  assert.deepEqual([...(await mirror.daemonCapabilities('m_old', { fresh: true }))], []);
  assert.deepEqual([...(await mirror.daemonCapabilities('m_new', { fresh: true }))].sort(), ['broker', 'handoff', 'subagent_config']);
});

test('a handoff is refused for an old daemon with an upgrade message, and nothing is created there', async () => {
  const s = node('m_old');
  calls.length = 0;
  await assert.rejects(mirror.create(s, { model: 'claude-opus-5-5', handoff: 'User: hi\n\nAssistant: hello', handoffFrom: { provider: 'kimi' } }), (e) => e.status === 409 && e.code === 'daemon_old' && /太舊/.test(e.message) && /handoff/.test(e.message));
  assert.ok(!sentOps('m_old').includes('create'), `create was sent: ${sentOps('m_old')}`);
});

test('a handoff the daemon took and forgot is an error, not a conversation that lost its history', async () => {
  const s = node('m_forgetful');
  await assert.rejects(mirror.create(s, { model: 'claude-opus-5-5', handoff: 'User: hi\n\nAssistant: hello', handoffFrom: { provider: 'kimi' } }), (e) => e.code === 'handoff_not_landed' && /沒有接下前段歷史/.test(e.message));
  // …and a daemon that keeps it is fine.
  const ok = node('m_new');
  await mirror.create(ok, { model: 'claude-opus-5-5', handoff: 'User: hi\n\nAssistant: hello', handoffFrom: { provider: 'kimi' } });
  assert.ok(ok.events.some((e) => e.handoff));
});

test('the unmarked DeepSeek default is not sent to an old daemon, and the conversation says it was not applied', async () => {
  const s = node('m_old', { meta: { subagent: DS } });
  calls.length = 0;
  await mirror.create(s, { model: 'claude-opus-5-5' });
  const create = calls.find((c) => c.machine === 'm_old' && c.op === 'create');
  assert.equal(create.args.config.subagent, null, 'an old daemon would ignore it and run Task on the main model');
  const notice = s.events.find((e) => e.subagentNotice);
  assert.ok(notice, 'said in the conversation');
  assert.match(notice.text, /太舊/);
  assert.match(notice.text, /原生規則/);
  const p = await policy.refresh(s);
  assert.equal(p.ready, false);
  assert.equal(p.code, 'daemon_old');
  assert.equal(policy.infoOf(s).ready, false, 'the browser is not shown a stamped DeepSeek default as if it were in force');
});

test('a subagent the user chose is refused for an old daemon: at creation, at configure and at send', async () => {
  const explicit = node('m_old', { meta: { subagent: DS }, state: { subagentExplicit: true } });
  await assert.rejects(mirror.create(explicit, { model: 'claude-opus-5-5' }), (e) => e.code === 'daemon_old');
  const s = node('m_old');
  await assert.rejects(mirror.configure(s, { subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } }), (e) => e.code === 'daemon_old');
  const chosen = node('m_old', { meta: { subagent: DS }, state: { subagentExplicit: true } });
  calls.length = 0;
  await assert.rejects(mirror.send(chosen, 'hello'), (e) => e.code === 'daemon_old');
  assert.ok(!sentOps('m_old').includes('send'), 'the message was not sent to be run with the wrong subagent');
});

test('a daemon that has the capabilities gets the setting and the messages', async () => {
  const s = node('m_new', { meta: { subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } }, state: { subagentExplicit: true } });
  calls.length = 0;
  await mirror.create(s, { model: 'claude-opus-5-5' });
  assert.deepEqual(calls.find((c) => c.op === 'create').args.config.subagent, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
  s.status = 'idle';
  await mirror.send(s, 'hello');
  assert.ok(sentOps('m_new').includes('send'));
  assert.equal((await policy.refresh(s)).ready, true);
});

test('broker setting on a daemon that has the setting but no broker is refused too', async () => {
  daemons.get('m_new').caps = ['handoff', 'subagent_config'];
  mirror.forgetCapabilities('m_new');
  try {
    await assert.rejects(mirror.configure(node('m_new'), { subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } }), (e) => e.code === 'daemon_old' && /broker/.test(e.message));
    await mirror.configure(node('m_new'), { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } });
  } finally {
    daemons.get('m_new').caps = ['broker', 'handoff', 'subagent_config'];
    mirror.forgetCapabilities('m_new');
  }
});
