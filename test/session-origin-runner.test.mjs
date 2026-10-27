import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-origin-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let fakeApi;
let store;
let machines;
let runner;
let ADAPTERS;
let deepseek;
let claude;
const kimiIndex = new Map();
let created = 0;

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
  claude = await import('../server/adapters/claude.js');
  claude.init(runner.liveContext);
  deepseek.setKey('opencode-go', 'sk-test-only');

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
    createRemote: async ({ machineId }) => ({ kimiSessionId: `native_${machineId}_${++created}`, cwd: '/tmp/a' }),
    findByKimi: (machineId, kimiSessionId) => kimiIndex.get(`${machineId}:${kimiSessionId}`) || null,
    restore: () => {},
    attach: async (s) => {
      kimiIndex.set(`${s.machineId}:${s.kimiSessionId}`, s.id);
    },
    configure: async (s, c) => {
      s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort };
    },
    dispose: () => {},
    run: async (ctx) => ctx.emit({ type: 'text', text: 'kimi reply' }),
  };
  ADAPTERS.claude = {
    live: false,
    AGENT: { id: 'claude', name: 'Claude', type: 'claude', enabled: true },
    cannotSend: () => null,
    available: () => ({ ok: true }),
    start: () => {},
    restore: () => {},
    dispose: () => {},
    create: async (s, c = {}) => {
      s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort };
    },
    configure: async (s, c) => {
      s.meta = { ...(s.meta || {}), ...c };
    },
    hostFor: () => ({ stat: async () => ({ dir: true }) }),
    run: async (ctx) => ctx.emit({ type: 'text', text: 'claude reply' }),
  };

  // One connected computer: its bridge answers provisioning/attach RPCs.
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'req') return;
    const data = { ok: true, created: false, models: [], sessionHeader: true, metadata: { cwd: '/tmp/native' }, title: 'Native', last_prompt: 'Native' };
    queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: m.id, ok: true, data })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({
    t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1,
    status: { available: true, server: true, version: '2.3.1' },
  }));
});

after(async () => {
  store.flushAll();
  await wait(400);
  fakeApi?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const summary = (s) => runner.summarize(s);

test('sessions started in the Hub are hub for all three providers; origin is never arbitrary', async () => {
  const kimi = await runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: TMP, title: 'Kimi' });
  const claudeSession = await runner.newSession({ provider: 'claude', cwd: TMP, title: 'Claude' });
  const ds = await runner.newSession({
    provider: 'deepseek', machineId: 'm1', cwd: TMP, title: 'DeepSeek',
    config: { model: deepseek.models().defaultModel, effort: 'max' },
  });

  for (const s of [kimi, claudeSession, ds]) {
    assert.equal(s.origin, 'hub');
    assert.equal(summary(s).origin, 'hub');
  }
  assert.equal(kimi.provider, 'kimi');
  assert.equal(claudeSession.provider, 'claude');
  assert.equal(ds.provider, 'deepseek');

  // The low-level store defaults an unclaimed record to external; the runner
  // still reads a legacy record without origin as a main chat. A parent is
  // always a 子session, even when its persisted origin is missing.
  const lowLevel = store.createSession({ agentId: 'claude', provider: 'claude', cwd: TMP });
  assert.equal(lowLevel.origin, 'external');
  assert.equal(runner.originOf({ ...lowLevel, origin: undefined }), 'hub');
  assert.equal(runner.originOf({ ...lowLevel, origin: 'hub' }), 'hub');
  const orphanChild = store.createSession({ agentId: 'claude', provider: 'claude', cwd: TMP, parentId: 'missing' });
  assert.equal(orphanChild.origin, 'external');
  assert.equal(summary(orphanChild).origin, 'external');

  await assert.rejects(
    runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: TMP, origin: 'terminal' }),
    /origin 只能是 hub 或 external/,
  );
});

test('attaching a native Kimi session is external; viewing it again does not upgrade it', async () => {
  const ext = await runner.attachKimi('m1', 'native_external');
  assert.equal(ext.origin, 'external');
  assert.equal(summary(ext).origin, 'external');

  const again = await runner.attachKimi('m1', 'native_external');
  assert.equal(again.id, ext.id, 'the same attached session is reused');
  assert.equal(again.origin, 'external');

  // A Hub-created session merely looked at through the same path keeps hub.
  const hub = store.createSession({
    agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'native_hub_view',
    provider: 'kimi', cwd: '/tmp/a', origin: 'hub', title: 'Hub view',
  });
  kimiIndex.set('m1:native_hub_view', hub.id);
  const viewed = await runner.attachKimi('m1', 'native_hub_view');
  assert.equal(viewed.id, hub.id);
  assert.equal(viewed.origin, 'hub');
  assert.equal(summary(viewed).origin, 'hub');
});

test('a broker child has a parentId and is external regardless of the child provider', async () => {
  const parent = await runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: TMP, title: 'Parent' });
  const r = await runner.delegateToProvider(parent, {
    provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'a self-contained sub task',
  });
  assert.ok(r.childSessionId, r.error || 'no child session');
  const child = store.getSession(r.childSessionId);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.origin, 'external');
  assert.equal(summary(child).origin, 'external');
  assert.equal(summary(child).provider, 'kimi');
});

test('a Hub fork keeps the source category; an external source stays external', async () => {
  const hub = await runner.newSession({ provider: 'claude', cwd: TMP, title: 'Hub fork source' });
  const hubFork = (await claude.command(hub, 'fork', 'branch')).session;
  assert.equal(hubFork.origin, 'hub');
  assert.equal(summary(hubFork).origin, 'hub');

  const external = store.createSession({ agentId: 'claude', provider: 'claude', cwd: TMP, origin: 'external', title: 'Native fork source' });
  const externalFork = (await claude.command(external, 'fork', 'branch 2')).session;
  assert.equal(externalFork.origin, 'external');
  assert.equal(summary(externalFork).origin, 'external');
});

test('six directions and A→B→A keep one hub chain, never copy events, and list only the leaf', async () => {
  const a = await runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: TMP, title: 'A' });
  a.events.push({ id: 'a_user', ts: 1, type: 'user', text: 'from A' });
  store.saveSession(a);

  const b = await runner.switchProvider(a, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  const bNode = store.getSession(b.id);
  assert.equal(b.continuedFrom, a.id);
  assert.equal(a.continuedTo, b.id);
  assert.equal(b.origin, 'hub');
  assert.equal(a.events.length, 1, 'the old node keeps its own events');
  assert.equal(bNode.events.some((e) => e.id === 'a_user'), false, 'old events are not copied into the new node');
  assert.ok(store.chainEvents(bNode).some((e) => e.id === 'a_user'), 'the chain history still shows the old events');

  // C→K is a new Kimi node (A2), not the old one, and carries the chain.
  const a2 = await runner.switchProvider(b, { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const a2Node = store.getSession(a2.id);
  assert.notEqual(a2.id, a.id);
  assert.equal(a2.continuedFrom, b.id);
  assert.notEqual(a2.kimiSessionId, a.kimiSessionId);
  assert.equal(a2.origin, 'hub');
  assert.deepEqual(store.chainOf(a2Node).map((x) => x.id), [a.id, b.id, a2.id]);
  assert.deepEqual(store.listLeaves().filter((s) => s.conversationId === a.conversationId).map((s) => s.id), [a2.id]);
  assert.deepEqual(store.chainOf(a2Node).map((x) => summary(x).origin), ['hub', 'hub', 'hub']);

  // K↔D reuses one native Kimi node; both directions stay hub.
  const d = await runner.switchProvider(a2Node, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  assert.equal(d.id, a2.id);
  assert.equal(d.origin, 'hub');
  const backToK = await runner.switchProvider(store.getSession(d.id), { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  assert.equal(backToK.id, a2.id);
  assert.equal(backToK.origin, 'hub');

  // The other two directions on a separate chain: C→D and D→C.
  const c0 = await runner.newSession({ provider: 'claude', cwd: TMP, title: 'C0' });
  c0.events.push({ id: 'c0_user', ts: 2, type: 'user', text: 'from C0' });
  const d0 = await runner.switchProvider(c0, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  const d0Node = store.getSession(d0.id);
  assert.equal(d0.continuedFrom, c0.id);
  assert.equal(d0.origin, 'hub');
  assert.equal(d0Node.events.some((e) => e.id === 'c0_user'), false);
  const c1 = await runner.switchProvider(d0Node, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  const c1Node = store.getSession(c1.id);
  assert.equal(c1.continuedFrom, d0.id);
  assert.equal(c1.origin, 'hub');
  assert.deepEqual(store.chainOf(c1Node).map((x) => summary(x).origin), ['hub', 'hub', 'hub']);
  assert.deepEqual(store.listLeaves().filter((s) => s.conversationId === c0.conversationId).map((s) => s.id), [c1.id]);
});

test('a continuation of an external chain stays external across runtime switches', async () => {
  const native = await runner.attachKimi('m1', 'native_chain_source');
  const claudeNode = await runner.switchProvider(native, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(claudeNode.origin, 'external');
  assert.equal(summary(claudeNode).origin, 'external');
  const kimiNode = await runner.switchProvider(store.getSession(claudeNode.id), { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const kimiNodeSession = store.getSession(kimiNode.id);
  assert.equal(kimiNode.origin, 'external');
  assert.deepEqual(store.chainOf(kimiNodeSession).map((x) => summary(x).origin), ['external', 'external', 'external']);
});

test('origin survives a Hub reload for both hub and external sessions', async () => {
  const hub = await runner.newSession({ provider: 'kimi', machineId: 'm1', cwd: TMP, title: 'Reload hub' });
  const ext = await runner.attachKimi('m1', 'native_reload');
  store.saveSession(hub, { immediate: true });
  store.saveSession(ext, { immediate: true });
  store.flushAll();
  await wait(200);

  const script = `
    const store = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/store.js')).href)});
    store.loadSessions();
    const runner = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/runner.js')).href)});
    const ids = ${JSON.stringify([hub.id, ext.id])};
    console.log(JSON.stringify(ids.map((id) => {
      const s = store.getSession(id);
      return { id, origin: s?.origin || null, summary: s ? runner.summarize(s).origin : null };
    })));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  const rows = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(rows, [
    { id: hub.id, origin: 'hub', summary: 'hub' },
    { id: ext.id, origin: 'external', summary: 'external' },
  ]);
});
