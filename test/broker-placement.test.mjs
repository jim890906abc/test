// A child conversation works in the same file system as its parent: on the
// parent's computer, in the parent's folder. A Claude conversation on the
// Hub's own host gets a Kimi/DeepSeek child only on a connector of that same
// host; otherwise the delegation says why instead of picking "the first Kimi
// computer" and applying a path that does not exist there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-placement-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;
let machines;
let ADAPTERS;
const made = []; // { machineId, cwd }
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function connect(id, hostname) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, hostname, platform: 'linux', home: TMP, bridgeVersion: '0.10.0', broker: 1, status: { available: true, server: true, version: '2.3.3' } }));
}

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  ({ ADAPTERS } = await import('../server/adapters/index.js'));
  runner = await import('../server/runner.js');
  let n = 0;
  ADAPTERS['kimi-remote'] = {
    live: true,
    AGENT: { id: 'kimi@x', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({ defaultModel: 'kimi/k2', models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }] }),
    createRemote: async ({ machineId, cwd }) => {
      made.push({ machineId, cwd });
      return { kimiSessionId: `session_pl_${++n}`, cwd };
    },
    restore: () => {},
    attach: async () => {},
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    cannotSend: () => null,
    interrupt: async () => {},
    send: async (s) => {
      const ctx = runner.liveContext(s);
      ctx.setStatus('running');
      ctx.emit({ type: 'text', text: 'ok' });
      ctx.emit({ type: 'turn_end', usage: {} });
      ctx.setStatus('idle');
      return { ok: true };
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
  connect('m_first', 'some-other-host');
  connect('m_remote', 'remote-host');
});
after(async () => {
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const claudeParent = (machineId) => store.createSession({
  agentId: 'claude', provider: 'claude', cwd: '/home/hub/project', modelConfig: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  meta: { model: 'claude-opus-5-5' }, permissionMode: 'ask', ...(machineId ? { machineId } : {}),
});
const ask = (parent) => runner.delegateToProvider(parent, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'find it' });

test('a Claude conversation on the Hub host does not get a child on "the first Kimi computer"', async () => {
  const before = made.length;
  const r = await ask(claudeParent(null));
  assert.equal(made.length, before, 'no Kimi session was created anywhere');
  assert.match(r.error, /同一台電腦/);
  assert.match(r.error, /Hub/);
  assert.equal(r.childSessionId, null);
});

test('…but one on a connector of the same host as the Hub gets its child there, in the parent\'s folder', async () => {
  connect('m_here', os.hostname());
  const parent = claudeParent(null);
  const r = await ask(parent);
  assert.equal(r.error, null, r.error);
  const last = made.at(-1);
  assert.equal(last.machineId, 'm_here');
  assert.equal(last.cwd, '/home/hub/project');
  assert.equal(store.getSession(r.childSessionId).machineId, 'm_here');
});

test('a Claude conversation on a connected computer keeps its child on that computer, whichever is listed first', async () => {
  const r = await ask(claudeParent('m_remote'));
  assert.equal(r.error, null, r.error);
  assert.equal(made.at(-1).machineId, 'm_remote');
});

test('a Kimi parent\'s child is on the parent\'s computer', async () => {
  const p = store.createSession({ agentId: 'kimi@m_remote', machineId: 'm_remote', kimiSessionId: 'session_pp', provider: 'kimi', cwd: '/srv/x', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { model: 'kimi/k2', effort: 'on' }, permissionMode: 'ask' });
  const r = await ask(p);
  assert.equal(r.error, null, r.error);
  assert.equal(made.at(-1).machineId, 'm_remote');
  assert.equal(made.at(-1).cwd, '/srv/x');
});
