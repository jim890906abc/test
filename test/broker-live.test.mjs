import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-live-broker-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let machines;
let runner;
let ADAPTERS;

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await wait();
  }
  throw new Error(`timeout: ${what}`);
}

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
    createRemote: async () => ({ kimiSessionId: `session_live_${++n}`, cwd: '/tmp/a' }),
    restore: () => {},
    attach: async (s) => { s.meta = { ...(s.meta || {}), model: 'kimi/k2', effort: 'on', permission: 'manual' }; },
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    send: async (s, text) => {
      const ctx = runner.liveContext(s);
      ctx.setStatus('running');
      const ev = ctx.emit({ type: 'tool_use', name: 'Ask', status: 'awaiting', permission: { options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }], chosen: null } });
      ctx.setStatus('awaiting_permission');
      await new Promise((resolve) => (s.state.liveResolve = resolve));
      ctx.setStatus('running');
      ctx.patch(ev, { status: s.state.liveInterrupted ? 'interrupted' : 'running', permission: { ...ev.permission, chosen: s.state.liveInterrupted ? 'cancelled' : 'ok' } });
      if (!s.state.liveInterrupted) ctx.emit({ type: 'text', text: `live:${text}` });
      ctx.emit({ type: 'turn_end', interrupted: Boolean(s.state.liveInterrupted), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
      ctx.setStatus('idle');
      return { ok: true };
    },
    respond: async (s, eventId, optionId) => {
      s.state.liveAnswer = optionId;
      s.state.liveResolve?.();
      return true;
    },
    interrupt: async (s) => {
      s.state.liveInterrupted = true;
      s.state.liveResolve?.();
      return true;
    },
  };

  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
});
after(async () => {
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const parent = () => store.createSession({
  agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_parent_${Math.random().toString(16).slice(2)}`,
  provider: 'kimi', cwd: '/tmp/a', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
  meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, model: 'kimi/k2', effort: 'on' },
  state: { defaultsApplied: true, userSet: { model: true, effort: true } }, permissionMode: 'ask',
});

test('a live adapter broker waits through awaiting_permission, then collects the native turn text', async () => {
  const p = parent();
  const pending = runner.delegateToProvider(p, { task: 'live task', provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const childId = await until(() => p.events.find((e) => e.type === 'tool_use' && e.childSessionId)?.childSessionId, 5000, 'child session');
  const child = store.getSession(childId);
  const ev = await until(() => child.events.find((e) => e.permission && !e.permission.chosen), 5000, 'child permission');
  assert.equal(child.parentId, p.id);
  assert.equal(child.depth, 1);
  assert.deepEqual(child.allowedTools, p.allowedTools);
  assert.equal(child.status, 'awaiting_permission');
  const card = p.events.find((e) => e.type === 'tool_use' && e.subagent?.broker);
  const mirrored = p.events.find((e) => e.brokerChildId === childId);
  assert.ok(card, 'the live child is linked to a parent card');
  assert.equal(mirrored.parent, card.id);
  assert.equal(mirrored.brokerChildId, childId);
  assert.ok(p.events.some((e) => e.brokerChildId === childId && e.permission && !e.permission.chosen), 'the permission is visible on the parent card while the child waits');
  await runner.resolvePermission(childId, ev.id, 'ok');
  const r = await pending;
  assert.equal(r.childSessionId, childId);
  assert.equal(r.text, 'live:live task');
  assert.equal(r.error, null);
  assert.equal(child.status, 'idle');
});

test('interrupting the parent interrupts the broker child and removes its tracking', async () => {
  const p = parent();
  const pending = runner.delegateToProvider(p, { task: 'stop me', provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const childId = await until(() => p.events.find((e) => e.type === 'tool_use' && e.childSessionId)?.childSessionId, 5000, 'child session');
  const child = store.getSession(childId);
  await until(() => child.status === 'awaiting_permission', 5000, 'child waiting');
  runner.interrupt(p.id);
  const r = await pending;
  assert.equal(r.childSessionId, childId);
  assert.ok(r.error);
  assert.equal(child.state.liveInterrupted, true);
  assert.equal(child.status, 'idle');
  const card = p.events.find((e) => e.type === 'tool_use' && e.subagent?.broker);
  assert.equal(card.subagent.status, 'cancelled');
  assert.equal(card.status, 'interrupted');
});

test('onStatus returns an unsubscribe function', () => {
  let calls = 0;
  const off = runner.onStatus(() => calls++);
  assert.equal(typeof off, 'function');
  off();
  assert.equal(calls, 0);
});
