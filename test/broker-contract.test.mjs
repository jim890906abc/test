// A broker card says what the delegation asked for (fixed when it is made)
// and what the child's own runtime reports it used. The reply to the caller
// carries the report, not the request echoed back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-broker-contract-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;
let machines;
let ADAPTERS;
let reports = { model: 'kimi/runtime-model', effort: 'off' }; // what the fake runtime says it ran on
const gates = [];

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
  runner = await import('../server/runner.js');
  let n = 0;
  ADAPTERS['kimi-remote'] = {
    live: true,
    AGENT: { id: 'kimi@m1', name: 'Kimi', type: 'kimi-remote', enabled: true },
    available: () => ({ ok: true }),
    ensureServer: async () => {},
    forgetModels: () => {},
    modelsFor: async () => ({ defaultModel: 'kimi/k2', models: [{ id: 'kimi/k2', name: 'K2', efforts: ['off', 'on'], defaultEffort: 'on', provider: 'kimi' }] }),
    createRemote: async () => ({ kimiSessionId: `session_c_${++n}`, cwd: TMP }),
    restore: () => {},
    attach: async () => {},
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
      // The runtime's own word about what it ran on, arriving with the turn.
      s.meta = { ...(s.meta || {}), model: reports.model, effort: reports.effort };
      ctx.emit({ type: 'text', text: 'done' });
      ctx.emit({ type: 'turn_end', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
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

test('the card is requested at once; its actual is the child runtime\'s report, and so is the reply to the caller', async () => {
  const p = parent();
  const running = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'contract task' });
  await until(() => gates.find((g) => g.s.parentId === p.id));
  const mid = cardOf(p).subagent;
  assert.deepEqual(mid.requested, { provider: 'kimi', model: 'kimi/k2', effort: 'on' });
  gates.find((g) => g.s.parentId === p.id).release();
  const r = await running;
  const sub = cardOf(p).subagent;
  assert.deepEqual(sub.requested, { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, 'the request does not change');
  assert.deepEqual(sub.actual, { provider: 'kimi', model: 'kimi/runtime-model', effort: 'off' }, 'what the runtime said, not the request');
  assert.equal(sub.unverifiedReason, undefined);
  assert.equal(r.model, 'kimi/runtime-model', 'the caller is told what really ran, so a mismatch can be refused');
  assert.equal(r.effort, 'off');
});

test('an explicit one-shot override is the request on the card, not the conversation default', async () => {
  const p = parent();
  p.meta.subagent = { provider: 'kimi', model: 'kimi/k2', effort: 'on' };
  const running = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'off', task: 'override task' });
  await until(() => gates.find((g) => g.s.parentId === p.id));
  assert.deepEqual(cardOf(p).subagent.requested, { provider: 'kimi', model: 'kimi/k2', effort: 'off' });
  gates.find((g) => g.s.parentId === p.id).release();
  await running;
});

test('a child that never reported leaves the card unverified instead of echoing the request', async () => {
  const p = parent();
  const saved = ADAPTERS['kimi-remote'].configure;
  ADAPTERS['kimi-remote'].configure = async () => {}; // the runtime says nothing about its model
  try {
    const running = runner.delegateToProvider(p, { provider: 'kimi', model: 'kimi/k2', effort: 'on', task: 'silent task' });
    await until(() => gates.find((g) => g.s.parentId === p.id));
    const g = gates.find((x) => x.s.parentId === p.id);
    g.s.meta = { ...g.s.meta, model: undefined, effort: undefined };
    const saveReports = reports;
    reports = { model: undefined, effort: undefined };
    g.release();
    await running;
    reports = saveReports;
    const sub = cardOf(p).subagent;
    assert.equal(sub.actual, null);
    assert.match(sub.unverifiedReason, /回報/);
    assert.equal(sub.requested.model, 'kimi/k2');
  } finally {
    ADAPTERS['kimi-remote'].configure = saved;
  }
});
