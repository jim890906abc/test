import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-switch-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
let fakeApi;
let store;
let machines;
let runner;
let ADAPTERS;
let deepseek;

before(async () => {
  fakeApi = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Opus 5.5' }], has_more: false }));
  });
  await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_CLAUDE_TEST_URL = `http://127.0.0.1:${fakeApi.address().port}`;
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  ({ ADAPTERS } = await import('../server/adapters/index.js'));
  runner = await import('../server/runner.js');
  deepseek = await import('../server/deepseek-account.js');
  deepseek.setKey('opencode-go', 'sk-test');

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
    createRemote: async () => ({ kimiSessionId: `session_new_${++n}`, cwd: '/tmp/a' }),
    restore: () => {},
    attach: async () => {},
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    run: async (ctx) => ctx.emit({ type: 'text', text: 'kimi reply' }),
  };
  ADAPTERS.claude = {
    AGENT: { id: 'claude', name: 'Claude', type: 'claude', enabled: true },
    cannotSend: () => null,
    start: () => {},
    restore: () => {},
    create: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), ...c }; },
    dispose: () => {},
    run: async (ctx) => ctx.emit({ type: 'text', text: 'claude reply' }),
    available: () => ({ ok: true }),
    hostFor: () => ({ stat: async () => ({ dir: true }) }),
  };

  // A machine that answers the DeepSeek provisioning RPC and advertises the
  // new broker capability.
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'req') return;
    queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: m.id, ok: true, data: { ok: true, created: false, models: [], sessionHeader: true } })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({
    t: 'hello', machineId: 'm1', name: 'M1', hostname: os.hostname(), platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1,
    status: { available: true, server: true, version: '2.3.1' },
  }));
  ws.emit('message', JSON.stringify({ t: 'kimi.sessions', items: [] }));
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 500));
  fakeApi?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const kimiNode = () => store.createSession({
  agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_${Math.random().toString(16).slice(2)}`,
  provider: 'kimi', cwd: '/tmp/a', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  state: { defaultsApplied: true, userSet: { model: true, effort: true } },
});

// This test replaces both adapters with recorders, so it proves the chain
// bookkeeping only. That the hand-off, the model and the permission really
// reach the target runtime is tested through the real adapters in
// switch-real-adapters.test.mjs and switch-legacy-fixtures.test.mjs.
test('six directions: K→C, C→K, K→D, D→K, D→C, C→D all keep a chain and only the leaf is active', async () => {
  const a = kimiNode();
  a.events.push({ ts: 1, type: 'user', text: 'from A' });
  const b = await runner.switchProvider(a, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(b.provider, 'claude');
  assert.equal(b.continuedFrom, a.id);
  assert.equal(a.continuedTo, b.id);
  assert.equal(a.events.length, 1, 'old events are not copied or erased');

  const c = await runner.switchProvider(b, { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  assert.equal(c.provider, 'kimi');
  assert.equal(c.continuedFrom, b.id);
  assert.match(store.getSession(c.id).handoff.text, /from A/);
  assert.ok(store.getSession(c.id).state.promptModel);

  const d = await runner.switchProvider(c, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  assert.equal(d.id, c.id, 'K→D reuses the same native Kimi node');
  assert.equal(d.kimiSessionId, c.kimiSessionId);
  assert.equal(d.provider, 'deepseek');
  assert.equal(d.mode, 'deepseek');

  const e = await runner.switchProvider(d, { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  assert.equal(e.id, d.id, 'D→K also reuses the same node');
  assert.equal(e.provider, 'kimi');
  assert.equal(e.mode, null);

  const f = await runner.switchProvider(e, { provider: 'claude', model: 'claude-opus-5-5' });
  assert.equal(f.provider, 'claude');
  assert.equal(f.continuedFrom, e.id);

  const g = await runner.switchProvider(f, { provider: 'deepseek', model: 'deepseek-v4.1-flash' });
  assert.equal(g.provider, 'deepseek');
  assert.equal(g.continuedFrom, f.id);
  assert.ok(g.kimiSessionId);

  const h = await runner.switchProvider(g, { provider: 'claude', model: 'claude-opus-5-5' });
  assert.equal(h.provider, 'claude');
  assert.equal(h.continuedFrom, g.id);
  assert.deepEqual(store.listLeaves().map((x) => x.id), [h.id]);
  assert.deepEqual(store.chainOf(h).map((x) => x.id), [a.id, b.id, c.id, f.id, g.id, h.id]);
});

test('3×3 broker creates a real child session with the selected provider/model/effort and links the parent event', async () => {
  const targets = [
    { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' },
  ];
  const parents = [
    store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_parent_k', provider: 'kimi', cwd: '/tmp/a', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { subagent: targets[0] }, permissionMode: 'ask' }),
    store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_parent_d', provider: 'deepseek', mode: 'deepseek', cwd: '/tmp/a', modelConfig: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' }, meta: { subagent: targets[1] }, permissionMode: 'ask' }),
    store.createSession({ agentId: 'claude', provider: 'claude', cwd: '/tmp/a', permissionMode: 'ask', meta: { subagent: targets[2] } }),
  ];
  for (const parent of parents) {
    for (const target of targets) {
      parent.meta = { ...(parent.meta || {}), subagent: target };
      const r = await runner.delegateToProvider(parent, { task: `do ${target.provider}`, provider: target.provider, model: target.model, effort: target.effort });
      assert.ok(r.childSessionId, JSON.stringify(r));
      assert.equal(r.provider, target.provider);
      assert.equal(r.model, target.model);
      assert.equal(r.effort, target.effort);
      const child = store.getSession(r.childSessionId);
      assert.equal(child.parentId, parent.id);
      assert.equal(child.provider, target.provider);
      assert.equal(child.meta.model, target.model);
      const ev = parent.events.filter((e) => e.type === 'tool_use').at(-1);
      assert.equal(ev.childSessionId, child.id);
      assert.equal(ev.subagent.provider, target.provider);
      assert.match(r.text, /reply/);
    }
  }
});

test('a message sent while a turn runs leaves that turn\'s snapshot alone: the settings changed meanwhile show as 下一回合 and apply to the next turn', async () => {
  // A live Kimi adapter that only records what it is sent; the runner, its
  // snapshot and its summary are the real ones. Two models, to change between.
  const kimi = ADAPTERS['kimi-remote'];
  const original = { live: kimi.live, cannotSend: kimi.cannotSend, send: kimi.send, modelsFor: kimi.modelsFor };
  const sent = [];
  Object.assign(kimi, {
    live: true,
    cannotSend: () => null,
    send: async (s, text) => (sent.push(text), { ok: true }),
    modelsFor: async () => ({
      defaultModel: 'kimi/k2',
      models: [
        { id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' },
        { id: 'kimi/k3', name: 'K3', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' },
      ],
    }),
  });
  try {
    const a = kimiNode();
    a.status = 'running';
    a.meta = { ...(a.meta || {}), model: 'kimi/k2', effort: 'on', turnProvider: 'kimi', turnModel: 'kimi/k2', turnEffort: 'on', turnSubagent: null };
    // The user moves the conversation to a different model and thinking while the turn runs.
    await runner.switchProvider(a, { provider: 'kimi', model: 'kimi/k3', effort: 'off' });
    assert.deepEqual([a.modelConfig.model, a.modelConfig.effort], ['kimi/k3', 'off'], 'chosen for the next turn');
    // ...and sends one more message, which waits behind the running turn.
    await runner.startTurn(a, 'queued behind the running turn');
    assert.deepEqual(sent, ['queued behind the running turn']);
    assert.deepEqual([a.meta.turnProvider, a.meta.turnModel, a.meta.turnEffort], ['kimi', 'kimi/k2', 'on'], 'the running turn keeps what it actually uses');
    const during = runner.summarize(a);
    assert.deepEqual([during.turnModel, during.turnEffort], ['kimi/k2', 'on']);
    assert.deepEqual([during.nextModel, during.nextEffort], ['kimi/k3', 'off']);

    // The turn is over; the next message starts a turn on the new settings.
    a.status = 'idle';
    await runner.startTurn(a, 'the next turn');
    assert.deepEqual([a.meta.turnProvider, a.meta.turnModel, a.meta.turnEffort], ['kimi', 'kimi/k3', 'off']);
  } finally {
    Object.assign(kimi, original);
  }
});

test('a running turn can only change same-runtime settings now; a cross-runtime switch is pending and applied once when idle', async () => {
  const a = kimiNode();
  a.status = 'running';
  a.meta = { ...(a.meta || {}), turnProvider: 'kimi', turnModel: 'kimi/k2', turnEffort: 'on' };
  // Same model and thinking is no change at all: nothing is touched.
  const same = await runner.switchProvider(a, { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  assert.equal(same.id, a.id);

  const pending = await runner.switchProvider(a, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(pending.id, a.id, 'the old leaf stays active for this turn');
  assert.equal(pending.pendingProvider.provider, 'claude');
  assert.equal(a.meta.turnProvider, 'kimi', 'this turn is still Kimi');
  assert.equal(a.provider, 'kimi');
  assert.equal(a.continuedTo, null);

  runner.liveContext(a).setStatus('idle');
  const end = Date.now() + 3000;
  while (!a.continuedTo && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(a.continuedTo, 'the pending switch ran automatically at idle');
  assert.equal(store.getSession(a.continuedTo).provider, 'claude');
  assert.equal(a.state.pendingProvider, null);
  assert.equal(a.meta.pendingSwitch, undefined);
});

test('a pending switch waits for its machine, clears stale in-progress state once, and is not dropped offline', async () => {
  const s = kimiNode();
  s.state = { ...(s.state || {}), pendingSwitching: true, pendingProvider: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', machineId: 'm_offline', reason: 'test' } };
  store.saveSession(s);
  runner.restoreLiveSessions();
  assert.equal(s.state.pendingSwitching, undefined, 'stale in-progress marker is cleared at startup');
  assert.ok(s.state.pendingProvider, 'the pending target is kept');
  assert.equal(await runner.applyPendingSwitch(s), null);
  assert.ok(s.state.pendingProvider, 'offline does not drop the pending target');

  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm_offline', name: 'offline-box', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
  // A bridge lists its conversations right after hello; until it has, the Hub
  // does not know whether a conversation is mid-turn and waits.
  ws.emit('message', JSON.stringify({ t: 'kimi.sessions', items: [] }));
  runner.resumePendingSwitches('m_offline');
  const end = Date.now() + 3000;
  while (!s.continuedTo && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(s.continuedTo, 'the pending switch runs when its machine comes online');
  assert.equal(s.state.pendingProvider, null);
});

test('the bridge broker request validates the token and reaches delegateToProvider', async () => {
  const broker = await import('../server/subagent-broker.js');
  const parent = kimiNode();
  parent.meta = { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
  const token = broker.issueToken(parent);
  const r = await broker.handleBridgeRequest('m1', { kind: 'broker', args: { token, task: 'bridge task' } });
  assert.ok(r.childSessionId);
  assert.equal(r.provider, 'claude');
  await assert.rejects(broker.handleBridgeRequest('m2', { kind: 'broker', args: { token, task: 'wrong machine' } }), /不屬於這台電腦/);
});

test('an explicit invalid model fails before a session is created or a prompt is sent', async () => {
  const n = store.listSessions().length;
  await assert.rejects(
    runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: '/tmp/a', config: { model: 'kimi/no-such', effort: 'on' } }),
    (e) => e.status === 400 && /沒有/.test(e.message),
  );
  assert.equal(store.listSessions().length, n);
});

test('a failed target leaves the old leaf untouched and retryable', async () => {
  const a = kimiNode();
  const before = store.listLeaves().length;
  await assert.rejects(runner.switchProvider(a, { provider: 'claude', model: 'no-such-model' }), (e) => e.status === 400);
  assert.equal(a.continuedTo, null);
  assert.equal(store.listLeaves().length, before);
});
