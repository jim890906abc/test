// One delegation, one card; a broker child is a hidden child from the first
// moment it exists; a card is never shared between children; and a repair
// after a restart decides by what the child was asked, not only by whichever
// id the card happens to hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-broker-cards-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;
let machines;
let ADAPTERS;
let KimiMirror;
const broadcasts = [];
const gates = [];
const seenAtAttach = [];
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await wait();
  }
  throw new Error('timeout');
}

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  ({ ADAPTERS } = await import('../server/adapters/index.js'));
  ({ Mirror: KimiMirror } = await import('../server/adapters/kimi-remote.js'));
  runner = await import('../server/runner.js');
  runner.setBroadcast((m) => broadcasts.push(m));
  let n = 0;
  ADAPTERS['kimi-remote'] = {
    live: true,
    AGENT: { id: 'kimi@m1', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({ defaultModel: 'kimi/k2', models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }] }),
    createRemote: async () => ({ kimiSessionId: `session_card_${++n}`, cwd: TMP }),
    restore: () => {},
    // What a browser loading the list, or a crash, would see at this moment.
    attach: async (s) => {
      const listed = store.listLeaves().find((x) => x.id === s.id);
      seenAtAttach.push({ id: s.id, parentId: s.parentId, origin: s.origin, listed: Boolean(listed) });
      s.meta = { ...(s.meta || {}), model: 'kimi/k2', effort: 'on' };
    },
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    cannotSend: () => null,
    interrupt: async () => {},
    send: async (s) => {
      const ctx = runner.liveContext(s);
      ctx.setStatus('running');
      let release;
      gates.push({ s, release: () => release() });
      await new Promise((r) => (release = r));
      ctx.emit({ type: 'text', text: 'done' });
      ctx.emit({ type: 'turn_end', usage: {} });
      ctx.setStatus('idle');
      return { ok: true };
    },
  };
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: TMP, bridgeVersion: '0.10.0', broker: 1, status: { available: true, server: true, version: '2.3.3' } }));
});
after(async () => {
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const parent = () => store.createSession({
  agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_p_${Math.random().toString(16).slice(2)}`, provider: 'kimi', cwd: TMP,
  modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { model: 'kimi/k2', effort: 'on' }, state: { defaultsApplied: true }, permissionMode: 'ask',
});
const delegate = (p, task, extra = {}) => runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task, ...extra });
const cards = (p) => p.events.filter((e) => e.type === 'tool_use' && !e.brokerChildId && /delegate|mcp__agent-hub/.test(e.name || ''));
const gateOf = (p, i = 0) => gates.filter((g) => g.s.parentId === p.id)[i];

test('a broker child is a hidden child (parentId, external) the first time it can be listed, saved or broadcast', async () => {
  const p = parent();
  broadcasts.length = 0;
  seenAtAttach.length = 0;
  const running = delegate(p, 'born hidden');
  const g = await until(() => gateOf(p));
  g.release();
  const r = await running;
  const seen = seenAtAttach.find((x) => x.parentId === p.id);
  assert.ok(seen, 'the child had its parentId while its runtime was being attached');
  assert.equal(seen.origin, 'external');
  const announced = broadcasts.filter((m) => m.t === 'session' && m.session.id === r.childSessionId);
  assert.ok(announced.length > 0);
  for (const m of announced) {
    assert.equal(m.session.parentId, p.id, 'never announced as a free-standing 子session first');
    assert.equal(m.session.origin, 'external');
  }
  assert.equal(store.getSession(r.childSessionId).state.broker.parentEventId, cards(p)[0].id, 'the link to the card exists from creation');
});

test('an explicit parentEventId that another child already holds is not taken over', async () => {
  const p = parent();
  p.events.push({ id: 'e_native', ts: 1, type: 'tool_use', name: 'mcp__agent-hub__delegate_to_provider', status: 'running', input: { task: 'same card' } });
  const a = delegate(p, 'same card', { parentEventId: 'e_native' });
  const ga = await until(() => gateOf(p, 0));
  const b = delegate(p, 'same card', { parentEventId: 'e_native' });
  const gb = await until(() => gateOf(p, 1));
  assert.notEqual(ga.s.id, gb.s.id);
  const native = p.events.find((e) => e.id === 'e_native');
  assert.equal(native.childSessionId, ga.s.id, 'the first child keeps the card');
  const mine = cards(p).filter((c) => c.childSessionId === gb.s.id);
  assert.equal(mine.length, 1);
  assert.notEqual(mine[0].id, 'e_native', 'the second delegation has a card of its own');
  ga.release();
  gb.release();
  await Promise.all([a, b]);
  assert.equal(cards(p).length, 2);
});

test('the MCP request before Kimi\'s own tool frame: one card, and Kimi\'s result lands on it', async () => {
  const p = parent();
  const mirror = new KimiMirror(p);
  const running = delegate(p, 'one card please');
  const g = await until(() => gateOf(p));
  assert.equal(cards(p).length, 1, 'the delegation made its card');
  // Now Kimi\'s own frames for that MCP call arrive.
  mirror.onFrame({ type: 'tool.call.delta', payload: { agentId: 'main', toolCallId: 'T1', name: 'mcp__agent-hub__delegate_to_provider', argumentsPart: '{"task":"one ca' } });
  mirror.onFrame({ type: 'tool.call.started', payload: { agentId: 'main', toolCallId: 'T1', name: 'mcp__agent-hub__delegate_to_provider', args: { token: 'hb_x', task: 'one card please' } } });
  assert.equal(cards(p).length, 1, 'Kimi\'s frame joined the delegation\'s card instead of making another');
  assert.equal(cards(p)[0].toolCallId, 'T1');
  g.release();
  await running;
  mirror.onFrame({ type: 'tool.result', payload: { agentId: 'main', toolCallId: 'T1', isError: false, output: 'done' } });
  assert.equal(cards(p).length, 1);
  assert.equal(cards(p)[0].subagent.status, 'done');
  assert.equal(cards(p)[0].subagent.id, cards(p)[0].childSessionId);
});

test('Kimi\'s tool frame first, then the MCP request: still one card (and a second parallel call gets its own)', async () => {
  const p = parent();
  const mirror = new KimiMirror(p);
  mirror.onFrame({ type: 'tool.call.started', payload: { agentId: 'main', toolCallId: 'T2', name: 'mcp__agent-hub__delegate_to_provider', args: { token: 'hb_x', task: 'first' } } });
  mirror.onFrame({ type: 'tool.call.started', payload: { agentId: 'main', toolCallId: 'T3', name: 'mcp__agent-hub__delegate_to_provider', args: { token: 'hb_x', task: 'second' } } });
  const a = delegate(p, 'first');
  const b = delegate(p, 'second');
  const ga = await until(() => gateOf(p, 0));
  const gb = await until(() => gateOf(p, 1));
  assert.equal(cards(p).length, 2);
  ga.release();
  gb.release();
  await Promise.all([a, b]);
  assert.deepEqual(cards(p).map((c) => c.toolCallId).sort(), ['T2', 'T3']);
});

test('a restart repair gives a card to the child it was made for, even when the card holds the other child\'s id', () => {
  const p = parent();
  p.events.push({
    id: 'e_one', ts: 1, type: 'tool_use', name: 'delegate_to_provider', title: 'task one', status: 'done', input: { task: 'task one' },
    // last writer wins: the old bug left the second child's id on the first child's card
    childSessionId: 's_two', subagent: { id: 's_two', broker: true, status: 'done', provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  });
  const mk = (id, task) => {
    const s = store.createSession({ id, parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: TMP, title: task, modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } });
    s.state = { ...(s.state || {}), broker: { parentId: p.id, parentEventId: 'e_one' } };
    s.events = [{ id: `${id}_u`, ts: 2, type: 'user', text: task }, { id: `${id}_t`, ts: 3, type: 'text', text: `${task} result` }, { id: `${id}_e`, ts: 4, type: 'turn_end', error: false, interrupted: false }];
    return s;
  };
  const one = mk('s_one', 'task one');
  const two = mk('s_two', 'task two');
  runner.restoreLiveSessions();
  const cardOne = cards(p).find((c) => c.childSessionId === one.id);
  const cardTwo = cards(p).find((c) => c.childSessionId === two.id);
  assert.ok(cardOne && cardTwo, 'each child has a card');
  assert.notEqual(cardOne.id, cardTwo.id);
  assert.equal(cardOne.input.task, 'task one');
  assert.equal(cardOne.id, 'e_one', 'the first child gets its own card back');
  assert.equal(cardTwo.title, 'task two', 'the second child\'s card is about its own task');
  assert.equal(cards(p).length, 2, 'no stale card is left behind');
  assert.equal(one.state.broker.parentEventId, 'e_one');
  assert.equal(two.state.broker.parentEventId, cardTwo.id);
});
