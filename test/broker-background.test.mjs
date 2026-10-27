import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-background-broker-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let machines;
let runner;
let ADAPTERS;
const gates = new Map();
const parentSends = [];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve(fn()).catch(() => null);
    if (value) return value;
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
    createRemote: async () => ({ kimiSessionId: `session_bg_${++n}`, cwd: TMP }),
    restore: () => {},
    attach: async (s) => { s.meta = { ...(s.meta || {}), model: 'kimi/k2', effort: 'on', permission: 'manual' }; },
    configure: async (s, c) => { s.meta = { ...(s.meta || {}), model: c.model, effort: c.effort }; },
    dispose: () => {},
    cannotSend: () => null,
    send: async (s, text, opts = {}) => {
      if (s.state.parent) {
        parentSends.push({ session: s, text, opts, wasBusy: ['running', 'awaiting_permission'].includes(s.status) });
        return { ok: true, queued: ['running', 'awaiting_permission'].includes(s.status) };
      }
      const ctx = runner.liveContext(s);
      const gate = deferred();
      gates.set(s.id, gate);
      ctx.setStatus('running');
      await gate.promise;
      if (!s.state.liveInterrupted) ctx.emit({ type: 'text', text: `done:${text}` });
      ctx.emit({ type: 'turn_end', interrupted: Boolean(s.state.liveInterrupted), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
      ctx.setStatus('idle');
      if (s.state.staleRunningAfterEnd) ctx.setStatus('running');
      return { ok: true };
    },
    interrupt: async (s) => {
      s.state.interrupts = (s.state.interrupts || 0) + 1;
      if (!s.state.parent) {
        s.state.liveInterrupted = true;
        gates.get(s.id)?.resolve();
      }
    },
  };
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: TMP, bridgeVersion: '1.0.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
});

after(async () => {
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

function parentSession() {
  return store.createSession({
    agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_parent_${Math.random().toString(16).slice(2)}`,
    provider: 'kimi', cwd: TMP, modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' },
    meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, model: 'kimi/k2', effort: 'on' },
    state: { parent: true, defaultsApplied: true, userSet: { model: true, effort: true } }, permissionMode: 'ask',
  });
}

const cardFor = (p, id) => p.events.find((e) => e.type === 'tool_use' && !e.brokerChildId && e.childSessionId === id);

test('two background children run independently and both deliver their final results', async () => {
  const p = parentSession();
  const before = parentSends.length;
  const [a, b] = await Promise.all([
    runner.delegateToProvider(p, { task: 'background A', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true }),
    runner.delegateToProvider(p, { task: 'background B', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true }),
  ]);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.equal(a.background, true);
  assert.notEqual(a.childSessionId, b.childSessionId);
  const ca = store.getSession(a.childSessionId);
  const cb = store.getSession(b.childSessionId);
  assert.ok(gates.has(ca.id), 'A started before either finished');
  assert.ok(gates.has(cb.id), 'B started without waiting for A');
  assert.equal(ca.status, 'running');
  assert.equal(cb.status, 'running');
  assert.equal(parentSends.length, before);
  assert.equal(cardFor(p, ca.id).subagent.background, true);
  assert.notEqual(cardFor(p, ca.id).id, cardFor(p, cb.id).id);
  p.status = 'running';

  gates.get(ca.id).resolve();
  await until(() => parentSends.slice(before).some((x) => x.text.includes('done:background A')), 4000, 'A completion notification');
  assert.equal(cb.status, 'running', 'B is still independent');
  assert.equal(cardFor(p, ca.id).subagent.status, 'done');
  assert.equal(cardFor(p, cb.id).subagent.status, 'running');

  gates.get(cb.id).resolve();
  await until(() => parentSends.slice(before).length === 2, 4000, 'B completion notification');
  await until(() => cardFor(p, cb.id).subagent.status === 'done', 4000, 'B final card');
  assert.ok(parentSends.slice(before).every((x) => x.wasBusy && x.opts.note === 'Agent Hub 背景子代理完成通知'), 'busy parents queue completion prompts');
  assert.match(parentSends.at(-1).text, /done:background B/);
  assert.match(cardFor(p, ca.id).subagent.summary, /done:background A/);
  assert.match(cardFor(p, cb.id).subagent.summary, /done:background B/);

  runner.interrupt(p.id);
  assert.equal(ca.state.interrupts, undefined, 'A was removed from active tracking');
  assert.equal(cb.state.interrupts, undefined, 'B was removed from active tracking');
});

test('interrupting the parent stops a background child and never revives the parent', async () => {
  const p = parentSession();
  const before = parentSends.length;
  const r = await runner.delegateToProvider(p, { task: 'background stop', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true });
  const child = store.getSession(r.childSessionId);
  await until(() => gates.has(child.id), 4000, 'child started');
  runner.interrupt(p.id);
  await until(() => cardFor(p, child.id).status === 'interrupted', 4000, 'cancelled card');
  assert.equal(child.state.liveInterrupted, true);
  assert.equal(child.state.interrupts, 1);
  assert.equal(cardFor(p, child.id).subagent.status, 'cancelled');
  await wait(50);
  assert.equal(parentSends.length, before, 'no automatic parent turn after interruption');
  runner.interrupt(p.id);
  assert.equal(child.state.interrupts, 1, 'finished child is no longer tracked');
});

test('the default broker call remains synchronous and has no completion prompt', async () => {
  const p = parentSession();
  const before = parentSends.length;
  const pending = runner.delegateToProvider(p, { task: 'background compatible', provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const id = await until(() => p.events.find((e) => e.childSessionId && e.subagent?.broker)?.childSessionId, 4000, 'synchronous child');
  await until(() => gates.has(id), 4000, 'synchronous gate');
  gates.get(id).resolve();
  const r = await pending;
  assert.equal(r.childSessionId, id);
  assert.equal(r.text, 'done:background compatible');
  assert.equal(r.error, null);
  assert.equal(r.background, undefined);
  assert.equal(parentSends.length, before);
});

test('a native turn_end wins over a stale live running status', async () => {
  const p = parentSession();
  const pending = runner.delegateToProvider(p, { task: 'stale status', provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  const id = await until(() => p.events.find((e) => e.childSessionId && e.subagent?.broker)?.childSessionId, 4000, 'child');
  const child = store.getSession(id);
  child.state.staleRunningAfterEnd = true;
  await until(() => gates.has(id), 4000, 'gate');
  gates.get(id).resolve();
  const r = await pending;
  assert.equal(child.status, 'running', 'the fixture reproduces the late status snapshot');
  assert.equal(r.error, null);
  assert.equal(r.text, 'done:stale status');
  const card = cardFor(p, id);
  assert.equal(card.status, 'done');
  assert.equal(card.subagent.status, 'done');
  assert.match(card.subagent.summary, /done:stale status/);
  runner.interrupt(p.id);
  assert.equal(child.state.interrupts, undefined, 'the completed child was already untracked');
});
