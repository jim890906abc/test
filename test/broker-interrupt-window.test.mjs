// Stopping the parent while a delegation is still creating its child (the
// window before the child is tracked) must stop that delegation too: the
// child may exist afterwards, but it must not run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-interrupt-window-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;
let machines;
let ADAPTERS;
let createDelay = 0;
const childSends = [];
const interrupted = [];
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  ({ ADAPTERS } = await import('../server/adapters/index.js'));
  runner = await import('../server/runner.js');
  let n = 0;
  ADAPTERS['kimi-remote'] = {
    live: true,
    AGENT: { id: 'kimi@m1', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({ defaultModel: 'kimi/k2', models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }] }),
    createRemote: async () => {
      await wait(createDelay);
      return { kimiSessionId: `session_w_${++n}`, cwd: TMP };
    },
    restore: () => {},
    attach: async () => {},
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    cannotSend: () => null,
    interrupt: async (s) => { interrupted.push(s.id); },
    send: async (s, text) => {
      childSends.push({ id: s.id, text });
      const ctx = runner.liveContext(s);
      ctx.setStatus('running');
      ctx.emit({ type: 'text', text: 'ran' });
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
const cardOf = (p) => p.events.find((e) => e.type === 'tool_use' && !e.brokerChildId && e.subagent?.broker);

test('a foreground delegation stopped while its child is being created never runs the child', async () => {
  createDelay = 200;
  const p = parent();
  const before = childSends.length;
  const pending = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'stop me early' });
  await wait(60);
  runner.interrupt(p.id);
  const r = await pending;
  assert.equal(childSends.length, before, 'the child turn must not start');
  assert.equal(r.error, '已中斷');
  assert.equal(cardOf(p).status, 'interrupted');
  assert.equal(cardOf(p).subagent.status, 'cancelled');
  assert.ok(r.childSessionId, 'the child was made, so the card can point at it');
});

test('a background delegation stopped during creation does not run or report back either', async () => {
  createDelay = 200;
  const p = parent();
  const before = childSends.length;
  const pending = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'stop me early too', background: true });
  await wait(60);
  runner.interrupt(p.id);
  const r = await pending;
  await wait(100);
  assert.equal(childSends.length, before);
  assert.equal(r.error, '已中斷');
  assert.notEqual(r.status, 'running');
});

test('a delegation that was not stopped still runs (the check is about this parent\'s stops only)', async () => {
  createDelay = 30;
  const p = parent();
  const other = parent();
  const pending = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'normal' });
  runner.interrupt(other.id);
  const r = await pending;
  assert.equal(r.error, null);
  assert.equal(r.text, 'ran');
});
