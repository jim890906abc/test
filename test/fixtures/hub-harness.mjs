// An in-process Hub for runner-level tests: the real store, machines and
// runner; the two adapters are replaced by recorders at THEIR boundary
// (what Kimi's server API / the Claude daemon would be asked to do). Tests that
// need the real adapters use the e2e harness instead (test/switch-real-adapters).
//
//   const hub = await setupHub('name');   // sets AGENT_HUB_DATA first
//   hub.kimi.calls / hub.claude.calls      // what the adapters were asked
//   hub.kimi.gate = promise                // hold the next createRemote
//   hub.claude.gate = promise              // hold the next Claude create
//   await hub.close()
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export async function setupHub(name, { env = {} } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-${name}-`));
  process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
  process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  Object.assign(process.env, env);
  const fakeApi = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Opus 5.5' }], has_more: false }));
  });
  await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_CLAUDE_TEST_URL = `http://127.0.0.1:${fakeApi.address().port}`;
  const store = await import('../../server/store.js');
  const machines = await import('../../server/machines.js');
  const { ADAPTERS } = await import('../../server/adapters/index.js');
  const runner = await import('../../server/runner.js');
  const deepseek = await import('../../server/deepseek-account.js');
  deepseek.setKey('opencode-go', 'sk-test');

  let n = 0;
  const kimi = {
    entered: [], // createRemote calls that started (the gate holds them after this)
    calls: { createRemote: [], configure: [], attach: [], dispose: [], send: [], archive: [] },
    gate: null,
    failConfigure: null,
    live: false,
    sendResult: { ok: true },
  };
  const claude = { entered: [], calls: { create: [], configure: [], dispose: [], send: [] }, gate: null, failCreate: null, live: false };
  const hold = async (o, key = 'gate') => {
    const g = o[key];
    if (g) {
      o[key] = null;
      await g;
    }
  };
  ADAPTERS['kimi-remote'] = {
    get live() { return kimi.live; },
    AGENT: { id: 'kimi@m1', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    cannotSend: () => null,
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({
      defaultModel: 'kimi/k2',
      models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }],
    }),
    createRemote: async (c) => {
      kimi.entered.push(c);
      await hold(kimi);
      const r = { kimiSessionId: `session_new_${++n}`, cwd: '/tmp/a' };
      kimi.calls.createRemote.push({ ...c, ...r });
      return r;
    },
    findByKimi: (m, k) => store.listSessions().find((s) => s.machineId === m && s.kimiSessionId === k)?.id || null,
    restore: () => {},
    attach: async (s) => void kimi.calls.attach.push(s.id),
    configure: async (s, c) => {
      kimi.calls.configure.push({ id: s.id, status: s.status, ...c });
      if (kimi.failConfigure) throw kimi.failConfigure;
      s.meta = { ...(s.meta || {}), model: c.model ?? s.meta?.model, effort: c.effort ?? s.meta?.effort, ...(c.permission ? { permission: c.permission } : {}) };
    },
    dispose: (s) => void kimi.calls.dispose.push(s.id),
    onMachineOnline: () => {},
    command: async (s, name) => void kimi.calls.archive.push([s.id, name]),
    send: async (s, text, opts) => {
      kimi.calls.send.push({ id: s.id, text, opts });
      return kimi.sendResult;
    },
    interrupt: () => {},
    isLive: () => true,
    run: async (ctx) => {
      await hold(kimi, 'runGate');
      ctx.emit({ type: 'text', text: 'kimi reply' });
    },
  };
  ADAPTERS.claude = {
    get live() { return claude.live; },
    AGENT: { id: 'claude', name: 'Claude', type: 'claude', enabled: true },
    cannotSend: () => null,
    start: () => {},
    restore: () => {},
    create: async (s, c) => {
      claude.entered.push(s.id);
      await hold(claude);
      claude.calls.create.push({ id: s.id, ...c });
      if (claude.failCreate) throw claude.failCreate;
      s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort, ...(c.permission ? { permission: c.permission } : {}) };
    },
    configure: async (s, c) => {
      claude.calls.configure.push({ id: s.id, ...c });
      s.meta = { ...(s.meta || {}), ...c };
    },
    dispose: (s) => void claude.calls.dispose.push(s.id),
    send: async (s, text, opts) => {
      claude.calls.send.push({ id: s.id, text, opts });
      return { ok: true };
    },
    interrupt: () => {},
    command: async () => ({}),
    run: async (ctx) => ctx.emit({ type: 'text', text: 'claude reply' }),
    available: () => ({ ok: true }),
    hostFor: () => ({ stat: async () => ({ dir: true }) }),
  };

  // A machine that answers the provisioning RPC and advertises the broker.
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  const rpc = [];
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'req') return;
    rpc.push({ op: m.op, args: m.args });
    queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: m.id, ok: true, data: { ok: true, created: false, models: [], sessionHeader: true } })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({
    t: 'hello', machineId: 'm1', name: 'M1', hostname: os.hostname(), platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1,
    status: { available: true, server: true, version: '2.3.1' },
  }));

  // A bridge lists its Kimi conversations right after it says hello.
  ws.emit('message', JSON.stringify({ t: 'kimi.sessions', items: [] }));

  const broadcasts = [];
  runner.setBroadcast((m) => broadcasts.push(m));

  const kimiNode = (over = {}) => store.createSession({
    agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_${Math.random().toString(16).slice(2)}`,
    provider: 'kimi', cwd: '/tmp/a', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
    state: { defaultsApplied: true, userSet: { model: true, effort: true } },
    meta: {}, ...over,
  });
  const deepseekNode = (over = {}) => kimiNode({
    provider: 'deepseek', mode: 'deepseek',
    modelConfig: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' }, ...over,
  });
  const claudeNode = (over = {}) => store.createSession({
    agentId: 'claude', provider: 'claude', cwd: '/tmp/a',
    modelConfig: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, meta: {}, ...over,
  });

  return {
    TMP, store, machines, runner, ADAPTERS, deepseek, kimi, claude, broadcasts, kimiNode, deepseekNode, claudeNode,
    ws, rpc,
    CLAUDE: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    KIMI: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
    DEEPSEEK: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' },
    async close() {
      store.flushAll();
      await new Promise((r) => setTimeout(r, 300));
      fakeApi.close();
      fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
}

export const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
