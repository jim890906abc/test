// Delegation tokens, through the path the bridge really takes
// (handleBridgeRequest -> handleDelegate): bound to the Hub node, its native
// session and machine, only valid while that conversation still chooses the
// broker, revoked when it stops, and good for as long as the turn that
// received it runs. Reaching the runner is observed by its own refusal of an
// empty task (400); a bad token is refused before that (403).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-broker-token-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let broker;
let runner;
let machines;
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  broker = await import('../server/subagent-broker.js');
  runner = await import('../server/runner.js');
  for (const id of ['m1', 'm2']) {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.close = () => {};
    ws.send = () => {};
    machines.attachBridge(ws);
    ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, platform: 'linux', home: TMP, bridgeVersion: '0.10.0', broker: 1, status: { available: true, server: true, version: '2.3.3' } }));
  }
});
after(async () => {
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
const make = (extra = {}) => store.createSession({
  id: `s_tok_${++n}`, agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `session_tok_${n}`, provider: 'kimi', cwd: TMP,
  meta: { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, model: 'x' }, state: { subagentExplicit: true }, status: 'running', ...extra,
});
const delegate = (machine, token, task = '') => broker.handleBridgeRequest(machine, { kind: 'broker', args: { token, task } });
const refused = (p, re) => assert.rejects(p, (e) => (re.test(e.message) && e.status === 403));
const reachedRunner = (p) => assert.rejects(p, (e) => e.status === 400 && /任務是空的/.test(e.message));

test('a valid token for its own conversation, machine and native session reaches the runner', async () => {
  const s = make();
  await reachedRunner(delegate('m1', broker.issueToken(s)));
});

test('a token presented through another computer is refused', async () => {
  const s = make();
  await refused(delegate('m2', broker.issueToken(s)), /不屬於這台電腦/);
});

test('a token whose native session is no longer the conversation\'s is refused (re-bound or replaced)', async () => {
  const s = make();
  const token = broker.issueToken(s);
  s.kimiSessionId = 'session_other';
  await refused(delegate('m1', token), /不屬於這個 Kimi 對話/);
});

test('a token stops working once the conversation no longer chooses the broker', async () => {
  const s = make();
  const token = broker.issueToken(s);
  s.meta = { ...s.meta, subagent: null };
  await refused(delegate('m1', token), /子代理設定已經改變/);
  // …and changing the setting through the runner revokes it outright.
  const t = make();
  const token2 = broker.issueToken(t);
  await runner.setSubagent(t, null).catch(() => {});
  assert.throws(() => broker.validateToken(token2), /無效或已過期/);
});

test('a token lives as long as the turn that got it, and no longer than that once the conversation is idle', async () => {
  const s = make();
  const token = broker.issueToken(s, { ttlMs: 1000 });
  await wait(1100);
  // Still working on the turn that received the token: it goes on being valid.
  s.status = 'running';
  await reachedRunner(delegate('m1', token));
  await wait(1100);
  s.status = 'idle';
  await refused(delegate('m1', token), /無效或已過期/);
});

test('one live token per conversation: it is reused while valid, replaced after revoking, and the old one is dead', async () => {
  const s = make();
  const a = broker.issueToken(s);
  assert.equal(broker.issueToken(s), a, 'history never accumulates different tokens');
  broker.revokeSession(s.id);
  const b = broker.issueToken(s);
  assert.notEqual(a, b);
  assert.throws(() => broker.validateToken(a), /無效或已過期/);
  assert.equal(broker.validateToken(b).hubSessionId, s.id);
});

test('a deleted or continued conversation cannot be delegated from', async () => {
  const s = make();
  const token = broker.issueToken(s);
  s.continuedTo = 'someone_else';
  await assert.rejects(delegate('m1', token), (e) => e.status === 409);
  const gone = make();
  const t2 = broker.issueToken(gone);
  store.deleteSession(gone.id);
  await assert.rejects(delegate('m1', t2), (e) => e.status === 404 || e.status === 403);
});
