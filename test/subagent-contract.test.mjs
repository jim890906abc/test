// Every subagent card says what was requested (a snapshot from when the card
// was made), what the runtime reported it actually uses, and why that is
// unknown when it is. And a card never spins under a tool call that is over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-subagent-contract-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
fs.mkdirSync(path.join(TMP, 'data', 'sessions'), { recursive: true });
const { Mirror, init } = await import('../server/adapters/kimi-remote.js');
const store = await import('../server/store.js');
const machines = await import('../server/machines.js');
{
  // A computer whose Kimi server is up, so that a command does not try to start one.
  const { EventEmitter } = await import('node:events');
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = () => {};
  ws.close = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'm1', platform: 'linux', home: TMP, bridgeVersion: '0.10.0', status: { available: true, server: true, version: '2.3.3' } }));
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
const DS = { provider: 'deepseek', model: FLASH, effort: 'max' };

function fixture(subagent = DS) {
  const session = { id: 's', machineId: 'm1', kimiSessionId: 'k', state: {}, meta: subagent ? { subagent } : {}, events: [] };
  let seq = 0;
  const ctx = {
    emit(f) {
      const ev = { id: `e_${++seq}`, ...f };
      session.events.push(ev);
      return ev;
    },
    patch(ev, f) {
      Object.assign(ev, f);
    },
    delta() {},
    setStatus() {},
    setMeta() {},
  };
  init(() => ctx);
  return { mirror: new Mirror(session), session };
}
const call = { type: 'tool.call.started', payload: { agentId: 'main', toolCallId: 'T', name: 'Agent', args: { description: 'd', prompt: 'p' } } };
const spawned = (extra = {}) => ({ type: 'subagent.spawned', payload: { subagentId: 'a1', subagentName: 'coder', parentToolCallId: 'T', parentAgentId: 'main', runInBackground: false, ...extra } });
const result = (isError, output, id = 'T') => ({ type: 'tool.result', payload: { toolCallId: id, isError, output } });
const card = (session) => session.events.find((e) => e.name === 'Agent');
const feed = (m, ...frames) => frames.forEach((f) => m.onFrame(f));

test('an Agent card made before the subagent starts already carries the request and says why there is no actual yet', () => {
  const { mirror, session } = fixture();
  feed(mirror, call);
  const sub = card(session).subagent;
  assert.deepEqual(sub.requested, DS);
  assert.equal(sub.actual, null);
  assert.match(sub.unverifiedReason, /還沒啟動|等待/);
  assert.equal(sub.status, 'pending');
});

test('requested is a snapshot: changing the conversation setting later does not rewrite the card', () => {
  const { mirror, session } = fixture();
  feed(mirror, call);
  session.meta.subagent = { provider: 'claude', model: 'claude-opus-5-5', effort: 'low' };
  feed(mirror, spawned({ model: FLASH, thinkingEffort: 'max' }));
  assert.deepEqual(card(session).subagent.requested, DS, 'still what was asked when the card was made');
});

test('actual comes only from what Kimi reported (model and effort of subagent.spawned)', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: FLASH, thinkingEffort: 'max' }));
  const sub = card(session).subagent;
  assert.deepEqual(sub.actual, { provider: 'deepseek', model: FLASH, effort: 'max' });
  assert.equal(sub.unverifiedReason, undefined);
  assert.equal(sub.model, FLASH, 'the old fields stay for older pages');
});

test('a subagent that Kimi ran on the main model is shown as such, next to the request that it did not honour', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: 'kimi-code/k3', thinkingEffort: 'high' }));
  const sub = card(session).subagent;
  assert.deepEqual(sub.requested, DS);
  assert.deepEqual(sub.actual, { provider: 'kimi', model: 'kimi-code/k3', effort: 'high' });
});

test('a spawned event without a model leaves actual null and explains it', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned());
  const sub = card(session).subagent;
  assert.equal(sub.actual, null);
  assert.match(sub.unverifiedReason, /沒有帶出模型/);
  assert.deepEqual(sub.requested, DS);
});

test('a later status update from the subagent itself fills actual in', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned());
  feed(mirror, { type: 'agent.status.updated', payload: { agentId: 'a1', model: FLASH, thinkingEffort: 'max' } });
  assert.deepEqual(card(session).subagent.actual, { provider: 'deepseek', model: FLASH, effort: 'max' });
  assert.equal(card(session).subagent.unverifiedReason, undefined);
});

test('no setting (the native rule) means nothing was requested, and the card says so honestly', () => {
  const { mirror, session } = fixture(null);
  feed(mirror, call, spawned({ model: 'kimi-code/k3', thinkingEffort: 'high' }));
  assert.equal(card(session).subagent.requested, null);
  assert.equal(card(session).subagent.actual.model, 'kimi-code/k3');
});

test('a btw side question and a replayed card explain why they have no model', async () => {
  const { mirror, session } = fixture();
  mirror.api = async () => ({ agent_id: 'b1' });
  await mirror.command('btw', '順便問');
  const btw = session.events.find((e) => e.name === 'btw');
  assert.equal(btw.subagent.actual, null);
  assert.match(btw.subagent.unverifiedReason, /btw/);

  const events = [{ id: 'h1', type: 'tool_use', name: 'Agent', ts: 1, input: { description: 'old' }, output: 'agent_id: agent-9\nactual_subagent_type: coder\nstatus: completed\n\n[summary]\n舊結果' }];
  mirror.api = async () => ({ items: [] });
  await mirror.importSubagents(events, () => {});
  assert.equal(events[0].subagent.actual, null);
  assert.match(events[0].subagent.unverifiedReason, /歷史|紀錄/);
  assert.equal(events[0].subagent.requested, null, 'what was requested then is not known now');
});

// ----------------------------------------------- the spinner stops with the call

test('a failed Agent call ends its subagent in error, whether or not it was spawned or reported a model', () => {
  for (const frames of [[call, spawned(), result(true, 'subagent error: x')], [call, spawned({ model: FLASH, thinkingEffort: 'max' }), result(true, 'subagent error: x')], [call, result(true, 'cannot start')]]) {
    const { mirror, session } = fixture();
    feed(mirror, ...frames);
    assert.equal(card(session).status, 'error');
    assert.equal(card(session).subagent.status, 'error', 'a card under a failed call must not spin');
    assert.ok(card(session).subagent.error);
  }
});

test('a clean result without a status line finishes the subagent', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: FLASH, thinkingEffort: 'max' }), result(false, 'some summary'));
  assert.equal(card(session).subagent.status, 'done');
  assert.equal(card(session).subagent.summary, 'some summary');
});

test('a transport error whose text says completed is an error, not a running child', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: FLASH, thinkingEffort: 'max' }), result(true, 'status: completed'));
  assert.equal(card(session).status, 'error');
  assert.equal(card(session).subagent.status, 'error');
});

test('a background launch keeps running after its call returns; Kimi says when it ends', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: FLASH, thinkingEffort: 'max', runInBackground: true }), result(false, 'started in background'));
  assert.equal(card(session).status, 'done');
  assert.equal(card(session).subagent.status, 'running');
  feed(mirror, { type: 'subagent.completed', payload: { subagentId: 'a1', resultSummary: 'fertig' } });
  assert.equal(card(session).subagent.status, 'done');
  // …but a background launch that failed is an error right away.
  const f = fixture();
  feed(f.mirror, call, spawned({ model: FLASH, thinkingEffort: 'max', runInBackground: true }), result(true, 'launch failed'));
  assert.equal(card(f.session).subagent.status, 'error');
});

test('a result never overturns a subagent that already ended', () => {
  const { mirror, session } = fixture();
  feed(mirror, call, spawned({ model: FLASH, thinkingEffort: 'max' }), { type: 'subagent.cancelled', payload: { subagentId: 'a1' } }, result(false, 'whatever'));
  assert.equal(card(session).subagent.status, 'cancelled');
});

// ----------------------------------------------------------- restart

test('after a Hub restart no subagent card is left running under a tool call that is over', () => {
  const mk = (id, evStatus, sub) => ({ id, status: 'idle', events: [{ id: `${id}_e`, type: 'tool_use', name: 'Agent', status: evStatus, subagent: sub }], meta: {}, state: {} });
  const sessions = [
    mk('s_cut', 'running', { id: 'a', status: 'running' }),
    mk('s_pending', 'running', { status: 'pending' }),
    mk('s_done', 'done', { id: 'a', status: 'running' }),
    mk('s_err', 'error', { id: 'a', status: 'running' }),
    mk('s_bg', 'done', { id: 'a', status: 'running', background: true }),
    mk('s_ended', 'done', { id: 'a', status: 'cancelled' }),
  ];
  for (const s of sessions) fs.writeFileSync(path.join(TMP, 'data', 'sessions', `${s.id}.json`), JSON.stringify(s));
  store.loadSessions();
  const st = (id) => store.getSession(id).events[0].subagent.status;
  assert.equal(st('s_cut'), 'cancelled');
  assert.equal(store.getSession('s_cut').events[0].status, 'interrupted');
  assert.equal(st('s_pending'), 'cancelled');
  assert.equal(st('s_done'), 'done');
  assert.equal(st('s_err'), 'error');
  assert.equal(st('s_bg'), 'running', 'a background subagent may still be running; the replay decides');
  assert.equal(st('s_ended'), 'cancelled');
});
