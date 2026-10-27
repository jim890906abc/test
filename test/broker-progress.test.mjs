import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-progress-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

// transcript.js imports the browser vendor bundles; keep the UI logic under
// test with tiny local modules instead of a DOM dependency.
fs.writeFileSync(path.join(TMP, 'marked.mjs'), 'export const marked = { setOptions() {}, parse: (s) => String(s ?? "") };');
fs.writeFileSync(path.join(TMP, 'purify.mjs'), 'export default { sanitize: (s) => s };');
registerHooks({
  resolve(spec, context, next) {
    if (spec === '/vendor/marked.esm.js') return { url: pathToFileURL(path.join(TMP, 'marked.mjs')).href, shortCircuit: true };
    if (spec === '/vendor/purify.es.mjs') return { url: pathToFileURL(path.join(TMP, 'purify.mjs')).href, shortCircuit: true };
    return next(spec, context);
  },
});

let store;
let machines;
let runner;
let ADAPTERS;
let Transcript;
const gates = new Map();
const sent = [];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await wait();
  }
  throw new Error(`timeout: ${what}`);
}

const HIDDEN_TOKEN = `hb_${'a'.repeat(48)}`;

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  ({ ADAPTERS } = await import('../server/adapters/index.js'));
  runner = await import('../server/runner.js');
  ({ Transcript } = await import('../public/js/transcript.js'));
  runner.setBroadcast((m) => sent.push(m));
  let n = 0;
  ADAPTERS['kimi-remote'] = {
    live: false,
    AGENT: { id: 'kimi@m1', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({
      defaultModel: 'kimi/k2',
      models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }],
    }),
    createRemote: async () => ({ kimiSessionId: `session_child_${++n}`, cwd: '/tmp/a' }),
    restore: () => {},
    attach: async () => {},
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    run: async (ctx) => {
      const gate = { released: deferred(), mid: deferred(), chosen: null };
      gates.set(ctx.session.id, gate);
      const tool = ctx.emit({
        type: 'tool_use',
        name: 'Bash',
        title: 'echo hi',
        input: { command: 'echo hi', token: HIDDEN_TOKEN },
        status: 'pending',
      });
      gate.chosen = await ctx.askUser(tool, [{ optionId: 'allow', name: '允許', kind: 'allow_once' }]);
      ctx.patch(tool, { status: 'done', output: `${HIDDEN_TOKEN} ok` });
      const text = ctx.emit({ type: 'text', text: 'partial' });
      ctx.delta(text, ' progress');
      gate.mid.resolve();
      await gate.released.promise;
      ctx.emit({ type: 'text', text: 'final answer' });
    },
  };
  ADAPTERS.claude = {
    AGENT: { id: 'claude', name: 'Claude', type: 'claude', enabled: true },
    cannotSend: () => null,
    start: () => {},
    restore: () => {},
    create: async () => {},
    configure: async () => {},
    dispose: () => {},
    available: () => ({ ok: true }),
    hostFor: () => ({ stat: async () => ({ dir: true }) }),
  };

  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({
    t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1,
    status: { available: true, server: true, version: '2.3.1' },
  }));
});

after(async () => {
  store.flushAll();
  await wait(400);
  fs.rmSync(TMP, { recursive: true, force: true });
});

function parentSession() {
  const id = `session_parent_${Math.random().toString(16).slice(2)}`;
  return store.createSession({
    agentId: 'kimi@m1',
    machineId: 'm1',
    kimiSessionId: id,
    provider: 'kimi',
    cwd: '/tmp/a',
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
    meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, model: 'kimi/k2', effort: 'on' },
    state: { defaultsApplied: true },
    permissionMode: 'ask',
  });
}

// Start delegations without a parentEventId, as parallel MCP calls do, and
// let them reach their child turn before answering anything.
async function parallelDelegates(parent, tasks) {
  const pending = tasks.map((task) => runner.delegateToProvider(parent, {
    provider: 'kimi', model: 'kimi/k2', effort: 'on', task,
  }));
  const cards = await until(() => {
    const found = parent.events.filter((e) => e.type === 'tool_use' && !e.brokerChildId && e.childSessionId && e.subagent?.broker);
    return found.length === tasks.length ? found : null;
  }, 4000, 'one card per parallel delegation');
  const children = cards.map((card) => store.getSession(card.childSessionId));
  for (const child of children) {
    const tool = await until(() => child.events.find((e) => e.type === 'tool_use' && e.permission && !e.permission.chosen), 4000, 'child permission');
    await runner.resolvePermission(child.id, tool.id, 'allow');
  }
  for (const child of children) {
    const gate = await until(() => gates.get(child.id), 4000, 'child gate');
    gate.released.resolve();
  }
  const results = await Promise.all(pending);
  return { cards, children, results };
}

test('a working broker child is projected into the parent card before it finishes', async () => {
  const p = parentSession();
  p.events.push({ id: 'e_parent_own', ts: Date.now(), type: 'text', text: 'parent text' });
  const pending = runner.delegateToProvider(p, { task: 'probe work', provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const card = await until(() => p.events.find((e) => e.type === 'tool_use' && e.subagent?.broker), 4000, 'parent card');
  const child = await until(() => store.getSession(card.childSessionId), 4000, 'child session');
  // Kimi's own MCP tool frame may arrive after the broker made the card.
  const native = runner.liveContext(p).emit({ type: 'tool_use', name: 'mcp__agent-hub__delegate_to_provider', toolCallId: 'call_mcp_1', input: { task: 'probe work' }, status: 'running' });
  assert.equal(native.id, card.id, 'the late MCP frame merges into one card');
  assert.equal(native.toolCallId, 'call_mcp_1');
  assert.equal(p.events.filter((e) => e.type === 'tool_use' && /delegate/.test(e.name || '')).length, 1);
  const permission = await until(() => p.events.find((e) => e.brokerChildId === child.id && e.permission && !e.permission.chosen), 4000, 'mirrored permission');

  assert.equal(permission.parent, card.id);
  assert.equal(permission.brokerChildId, child.id);
  assert.match(permission.brokerEventId, /^e_/);
  assert.ok(permission.id.startsWith('bp_'));
  assert.equal(card.provider, 'kimi');
  assert.equal(card.model, 'kimi/k2');
  assert.equal(card.subagent.effort, 'on');
  assert.equal(card.subagent.status, 'running');
  assert.equal(card.status, 'running');
  assert.ok(p.events.some((e) => e.id === 'e_parent_own'), 'parent events are kept');

  // Secrets never travel into the mirror: the token key and value are gone.
  const mirroredTool = p.events.find((e) => e.brokerChildId === child.id && e.type === 'tool_use');
  const serialized = JSON.stringify(mirroredTool);
  assert.doesNotMatch(serialized, /hb_[0-9a-f]{32,}/);
  assert.equal(mirroredTool.input.token, undefined);
  assert.equal(mirroredTool.parent, card.id);
  assert.ok(sent.some((m) => m.t === 'event' && m.sid === p.id && m.ev?.brokerChildId === child.id), 'the mirror is broadcast on the parent session');

  // The parent's transport status does not decide what the still-working
  // child is doing.
  runner.liveContext(p).patch(card, { status: 'error', isError: true, output: 'mcp transport failed' });
  assert.equal(card.status, 'running');
  assert.equal(card.subagent.status, 'running');

  // The mirrored permission is answered on the child session.
  assert.equal(await runner.resolvePermission(p.id, permission.id, 'allow'), true);
  await until(() => p.events.find((e) => e.type === 'text' && e.brokerChildId === child.id && e.text.includes('progress')), 4000, 'mirrored delta');
  const text = p.events.find((e) => e.type === 'text' && e.brokerChildId === child.id && e.text.includes('progress'));
  assert.equal(text.text, 'partial progress');
  assert.equal(text.parent, card.id);
  assert.ok(sent.some((m) => m.t === 'delta' && m.sid === p.id && m.id.startsWith('bp_')), 'child deltas are broadcast on the parent session');
  assert.equal(card.status, 'running');
  assert.equal(p.events.filter((e) => e.brokerChildId === child.id && e.type === 'tool_use').length, 1);

  const gate = await until(() => gates.get(child.id), 1000, 'adapter gate');
  gate.released.resolve();
  const r = await pending;
  assert.equal(r.error, null);
  assert.equal(r.childSessionId, child.id);
  assert.equal(card.status, 'done');
  assert.equal(card.isError, false);
  assert.equal(card.subagent.status, 'done');
  assert.match(card.subagent.summary, /final answer/);
  assert.equal(card.childSessionId, child.id);

  // A late MCP transport error cannot replace the child's final state.
  runner.liveContext(p).patch(card, { status: 'error', isError: true, output: 'late transport error' });
  assert.equal(card.status, 'done');
  assert.equal(card.isError, false);
  assert.equal(card.subagent.status, 'done');
});

test('child replay rebuilds only its own mirror; restart and recovery are idempotent', async () => {
  const p = parentSession();
  p.events.push(
    { id: 'e_parent_a', ts: Date.now(), type: 'text', text: 'keep me' },
    { id: 'e_card_a', ts: Date.now(), type: 'tool_use', name: 'Task', title: 'A', status: 'running', childSessionId: 's_child_a', subagent: { id: 's_child_a', name: 'subagent', status: 'running', broker: true } },
    { id: 'e_card_b', ts: Date.now(), type: 'tool_use', name: 'Task', title: 'B', status: 'running', childSessionId: 's_child_b', subagent: { id: 's_child_b', name: 'subagent', status: 'running', broker: true } },
  );
  const a = store.createSession({ id: 's_child_a', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a' });
  const b = store.createSession({ id: 's_child_b', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a' });
  a.state = { ...(a.state || {}), broker: { parentId: p.id, parentEventId: 'e_card_a' } };
  b.state = { ...(b.state || {}), broker: { parentId: p.id, parentEventId: 'e_card_b' } };
  store.saveSession(a);
  store.saveSession(b);

  a.events = [
    { id: 'e_a1', ts: 1, type: 'tool_use', name: 'Read', title: 'a.txt', status: 'done' },
    { id: 'e_a2', ts: 2, type: 'text', text: 'a step' },
  ];
  b.events = [
    { id: 'e_b1', ts: 3, type: 'tool_use', name: 'Grep', title: 'needle', status: 'done' },
    { id: 'e_b2', ts: 4, type: 'text', text: 'b step' },
  ];
  runner.liveContext(a).replaceEvents(a.events);
  runner.liveContext(b).replaceEvents(b.events);

  const count = (childId) => p.events.filter((e) => e.brokerChildId === childId).length;
  assert.equal(count(a.id), 2);
  assert.equal(count(b.id), 2);
  assert.ok(p.events.some((e) => e.id === 'e_parent_a'));
  assert.equal(p.events.find((e) => e.brokerChildId === a.id && e.type === 'tool_use').parent, 'e_card_a');

  // Claude daemons deliver new events through insert().
  runner.liveContext(b).insert({ id: 'e_b3', ts: 8, type: 'text', text: 'inserted step' });
  assert.equal(count(b.id), 3);
  assert.equal(p.events.find((e) => e.brokerEventId === 'e_b3')?.text, 'inserted step');

  // Native replay gives the child fresh ids: only that child's mirror is
  // replaced; the other child and the parent's own events stay.
  runner.liveContext(a).replaceEvents([
    { id: 'e_a3', ts: 5, type: 'tool_use', name: 'Read', title: 'b.txt', status: 'done' },
    { id: 'e_a4', ts: 6, type: 'tool_use', name: 'Read', title: 'c.txt', status: 'done' },
  ]);
  assert.equal(count(a.id), 2);
  assert.equal(count(b.id), 3);
  assert.ok(p.events.some((e) => e.id === 'e_parent_a'));
  assert.equal(new Set(p.events.map((e) => e.id)).size, p.events.length, 'no duplicate event ids');
  assert.equal(p.events.filter((e) => e.brokerChildId === a.id).map((e) => e.brokerEventId).sort().join(','), 'e_a3,e_a4');

  const snapshot = JSON.stringify(p.events);
  runner.restoreLiveSessions();
  assert.equal(JSON.stringify(p.events), snapshot, 'restart does not duplicate or rewrite a complete mirror');
  runner.restoreLiveSessions();
  assert.equal(JSON.stringify(p.events), snapshot);

  // An older child with no state link is recovered from parentId plus the
  // parent card's childSessionId / subagent.id.
  const old = store.createSession({ id: 's_child_old', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a' });
  old.events = [{ id: 'e_old1', ts: 7, type: 'tool_use', name: 'Bash', title: 'old', status: 'done' }];
  p.events.push({ id: 'e_card_old', ts: Date.now(), type: 'tool_use', name: 'Task', title: 'old', status: 'running', childSessionId: old.id, subagent: { id: old.id, name: 'subagent', status: 'done', broker: true } });
  store.saveSession(old);
  runner.restoreLiveSessions();
  assert.equal(old.state.broker.parentId, p.id);
  assert.equal(old.state.broker.parentEventId, 'e_card_old');
  assert.equal(p.events.filter((e) => e.brokerChildId === old.id).length, 1);
  assert.equal(p.events.find((e) => e.brokerChildId === old.id).parent, 'e_card_old');
});

test('a parent native replay keeps the broker card and its steps on the new event id', () => {
  const p = parentSession();
  p.events.push({
    id: 'e_card_orig', ts: 1, type: 'tool_use', name: 'mcp__agent-hub__delegate_to_provider', toolCallId: 'call_1',
    title: 'do replay', input: { task: 'do replay' }, status: 'running',
    childSessionId: 's_child_replay', subagent: { id: 's_child_replay', name: 'subagent', broker: true, status: 'running' },
  });
  const child = store.createSession({ id: 's_child_replay', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a' });
  child.state = { ...(child.state || {}), broker: { parentId: p.id, parentEventId: 'e_card_orig' } };
  child.events = [
    { id: 'e_r1', ts: 2, type: 'tool_use', name: 'Read', title: 'x.txt', status: 'done' },
    { id: 'e_r2', ts: 3, type: 'text', text: 'child progress' },
  ];
  store.saveSession(child);
  runner.liveContext(child).replaceEvents(child.events);
  assert.equal(p.events.find((e) => e.parent === 'e_card_orig')?.brokerChildId, child.id);

  runner.liveContext(p).replaceEvents([
    { id: 'k_new_1', ts: 10, type: 'tool_use', name: 'mcp__agent-hub__delegate_to_provider', toolCallId: 'call_1', input: { task: 'do replay' }, status: 'done' },
    { id: 'k_new_2', ts: 11, type: 'text', text: 'native text' },
  ]);

  assert.ok(p.events.some((e) => e.id === 'k_new_2'), 'native events are kept');
  const card = p.events.find((e) => e.id === 'k_new_1');
  assert.equal(card.childSessionId, child.id);
  assert.equal(card.subagent.id, child.id);
  assert.equal(card.subagent.broker, true);
  assert.equal(child.state.broker.parentEventId, 'k_new_1');
  assert.deepEqual(
    p.events.filter((e) => e.brokerChildId === child.id).map((e) => e.parent),
    ['k_new_1', 'k_new_1'],
  );
  assert.equal(p.events.filter((e) => e.brokerChildId === child.id).length, 2);
  assert.equal(new Set(p.events.map((e) => e.id)).size, p.events.length);
});

test('the transcript links a late subagent patch and trusts the child status', () => {
  const t = Object.create(Transcript.prototype);
  Object.assign(t, {
    events: new Map(),
    order: [],
    agentIds: [],
    mainTools: [],
    kids: new Map(),
    lastOf: new Map(),
    nodes: new Map(),
    dirty: new Set(),
    deferred: new Set(),
    dirtyGroups: new Set(),
  });
  t.markDirty = () => {};
  t.makeNode = () => ({});
  t.mount = () => {};

  t.add({ id: 'late', type: 'tool_use', name: 'run_task', title: 'delegate_to_provider', status: 'running', input: { task: 'summarize the repo' } });
  assert.deepEqual(t.agentIds, [], 'a nameless tool is not a subagent yet');
  t.patch('late', { subagent: { id: 's1', name: 'broker', broker: true, description: 'summarize the repo', provider: 'deepseek', model: 'v4.1-flash', effort: 'max', status: 'running' } });
  assert.deepEqual(t.agentIds, ['late'], 'the patch adds the card and its work count');
  assert.equal(t.runningCount(), 1);

  t.add({ id: 'step', type: 'tool_use', name: 'Grep', title: 'TODO', status: 'done', parent: 'late' });
  t.add({ id: 'note', type: 'text', text: 'working summary', parent: 'late' });
  let a = t.agentList()[0];
  assert.equal(a.name, '', 'internal broker name is not shown');
  assert.equal(a.description, 'summarize the repo');
  assert.equal(a.steps, 1);

  t.patch('late', { status: 'error', isError: true, output: 'MCP transport failed' });
  a = t.agentList()[0];
  assert.equal(a.failed, false, 'a transport error does not override the child status');
  assert.equal(a.running, true);
  assert.equal(t.runningCount(), 1);

  t.patch('late', { subagent: { ...t.get('late').subagent, status: 'done', summary: 'the real answer' } });
  a = t.agentList()[0];
  assert.equal(a.running, false);
  assert.equal(a.failed, false);
  assert.equal(a.summary, 'the real answer');
  assert.equal(t.runningCount(), 0);

  t.patch('late', { subagent: { ...t.get('late').subagent, status: 'error' } });
  a = t.agentList()[0];
  assert.equal(a.failed, true);
  assert.equal(t.runningCount(), 0);

  t.patch('late', { subagent: { ...t.get('late').subagent, status: 'cancelled', summary: 'partial' } });
  a = t.agentList()[0];
  assert.equal(a.failed, false);
  assert.equal(a.stopped, true);
  assert.equal(a.summary, 'partial');
});

test('old transport-error cards reconcile to the child end, but never from a running child', () => {
  const p = parentSession();
  const make = (suffix, cardStatus, childStatus, end) => {
    const id = `s_reconcile_${suffix}`;
    p.events.push({ id: `e_reconcile_${suffix}`, type: 'tool_use', name: 'delegate_to_provider', title: suffix, status: cardStatus, isError: cardStatus === 'error', childSessionId: id, subagent: { id, broker: true, status: cardStatus } });
    const child = store.createSession({ id, parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a', status: childStatus });
    child.events = [{ id: `e_${suffix}_text`, type: 'text', text: `${suffix} answer` }, { id: `e_${suffix}_end`, type: 'turn_end', ...end }];
    return child;
  };
  make('done', 'error', 'idle', { error: false, interrupted: false });
  make('cancelled', 'error', 'idle', { error: false, interrupted: true });
  make('running', 'running', 'running', { error: false, interrupted: false });
  runner.restoreLiveSessions();
  const card = (suffix) => p.events.find((e) => e.id === `e_reconcile_${suffix}`);
  assert.equal(card('done').status, 'done');
  assert.equal(card('done').subagent.status, 'done');
  assert.equal(card('done').subagent.summary, 'done answer');
  assert.equal(card('done').isError, false);
  assert.equal(card('cancelled').status, 'interrupted');
  assert.equal(card('cancelled').subagent.status, 'cancelled');
  assert.equal(card('cancelled').isError, false);
  assert.equal(card('running').status, 'running');
  assert.equal(card('running').subagent.status, 'running');
  const snapshot = JSON.stringify(p.events);
  runner.restoreLiveSessions();
  assert.equal(JSON.stringify(p.events), snapshot, 'reconciliation is idempotent');
});

test('parallel delegations without parentEventId each get their own card, child and projection parent', async () => {
  const p = parentSession();
  const tasks = ['parallel task one', 'parallel task two'];
  const { cards, children, results } = await parallelDelegates(p, tasks);

  assert.equal(new Set(cards.map((c) => c.id)).size, 2, 'one card per delegation');
  assert.equal(new Set(children.map((c) => c.id)).size, 2, 'one child per delegation');
  assert.deepEqual(cards.map((c) => c.input.task), tasks);
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const child = children[i];
    assert.equal(card.childSessionId, child.id);
    assert.equal(card.subagent.id, child.id);
    assert.equal(results[i].childSessionId, child.id);
    assert.equal(runner.summarize(child).parentId, p.id);
    assert.equal(runner.summarize(child).origin, 'external');
    const projections = p.events.filter((e) => e.brokerChildId === child.id);
    assert.ok(projections.length > 0, 'the child has projected steps');
    assert.deepEqual([...new Set(projections.map((e) => e.parent))], [card.id]);
    assert.equal(p.events.filter((e) => e.childSessionId === child.id && !e.brokerChildId).length, 1, 'exactly one parent card');
  }
  assert.equal(new Set(p.events.map((e) => e.id)).size, p.events.length, 'no duplicate event ids');
});

test('parallel delegations with the same task text still never share a card', async () => {
  const p = parentSession();
  const task = 'identical parallel task';
  const { cards, children } = await parallelDelegates(p, [task, task]);

  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((c) => c.id)).size, 2);
  assert.equal(new Set(children.map((c) => c.id)).size, 2);
  assert.deepEqual(cards.map((c) => c.input.task), [task, task]);
  for (const [i, card] of cards.entries()) {
    const child = children[i];
    assert.equal(card.childSessionId, child.id);
    assert.equal(card.subagent.id, child.id);
    const projections = p.events.filter((e) => e.brokerChildId === child.id);
    assert.deepEqual([...new Set(projections.map((e) => e.parent))], [card.id]);
  }
});

test('a stale shared card is repaired into one independent card per child without losing steps', () => {
  const p = parentSession();
  p.events.push({
    id: 'e_shared', ts: 1, type: 'tool_use', name: 'delegate_to_provider', title: 'owner task', status: 'running',
    childSessionId: 's_owner', subagent: { id: 's_owner', broker: true, status: 'running', provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  });
  const owner = store.createSession({
    id: 's_owner', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a', title: 'owner task',
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  });
  owner.state = { ...(owner.state || {}), broker: { parentId: p.id, parentEventId: 'e_shared' } };
  owner.events = [
    { id: 'e_owner_step', ts: 2, type: 'text', text: 'owner step' },
    { id: 'e_owner_end', ts: 3, type: 'turn_end', error: false, interrupted: false },
  ];
  const victim = store.createSession({
    id: 's_victim', parentId: p.id, agentId: 'kimi@m1', provider: 'kimi', cwd: '/tmp/a', title: 'victim task',
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  });
  // The old bug wrote the same card id into every parallel child.
  victim.state = { ...(victim.state || {}), broker: { parentId: p.id, parentEventId: 'e_shared' } };
  victim.events = [
    { id: 'e_victim_step', ts: 4, type: 'tool_use', name: 'Read', title: 'victim.txt', status: 'done' },
    { id: 'e_victim_text', ts: 5, type: 'text', text: 'victim progress' },
    { id: 'e_victim_end', ts: 6, type: 'turn_end', error: false, interrupted: false },
  ];
  p.events.push(
    { id: 'bp_s_owner_e_owner_step', ts: 2, type: 'text', text: 'owner step', parent: 'e_shared', brokerChildId: owner.id, brokerEventId: 'e_owner_step' },
    { id: 'bp_s_victim_e_victim_step', ts: 4, type: 'tool_use', name: 'Read', title: 'victim.txt', status: 'done', parent: 'e_shared', brokerChildId: victim.id, brokerEventId: 'e_victim_step' },
    { id: 'bp_s_victim_e_victim_text', ts: 5, type: 'text', text: 'victim progress', parent: 'e_shared', brokerChildId: victim.id, brokerEventId: 'e_victim_text' },
  );
  store.saveSession(p);
  store.saveSession(owner);
  store.saveSession(victim);

  runner.restoreLiveSessions();

  const ownerCard = p.events.find((e) => !e.brokerChildId && e.childSessionId === owner.id);
  const victimCard = p.events.find((e) => !e.brokerChildId && e.childSessionId === victim.id);
  assert.equal(ownerCard.id, 'e_shared', 'the real owner keeps its card');
  assert.ok(victimCard, 'the stale child gets its own card');
  assert.notEqual(victimCard.id, 'e_shared');
  assert.equal(victimCard.title, 'victim task');
  assert.equal(victimCard.provider, 'kimi');
  assert.equal(victimCard.model, 'kimi/k2');
  assert.equal(victimCard.effort, 'on');
  assert.equal(victimCard.status, 'done');
  assert.equal(victimCard.subagent.id, victim.id);
  assert.equal(victim.state.broker.parentEventId, victimCard.id);
  assert.equal(owner.state.broker.parentEventId, 'e_shared');

  assert.equal(p.events.filter((e) => !e.brokerChildId && e.childSessionId === owner.id).length, 1);
  assert.equal(p.events.filter((e) => !e.brokerChildId && e.childSessionId === victim.id).length, 1);
  assert.deepEqual([...new Set(p.events.filter((e) => e.brokerChildId === victim.id).map((e) => e.parent))], [victimCard.id]);
  assert.deepEqual([...new Set(p.events.filter((e) => e.brokerChildId === owner.id).map((e) => e.parent))], ['e_shared']);
  assert.ok(p.events.some((e) => e.id === 'bp_s_victim_e_victim_text' && e.text === 'victim progress'));
  assert.ok(p.events.some((e) => e.id === 'e_shared' && e.childSessionId === owner.id));
  assert.equal(new Set(p.events.map((e) => e.id)).size, p.events.length, 'repair keeps ids unique');

  const snapshot = JSON.stringify(p.events);
  runner.restoreLiveSessions();
  assert.equal(JSON.stringify(p.events), snapshot, 'repair is idempotent');
});
