// What the Hub says about a key whose reset time has passed (2026-10-30). The gateway
// STATED when the key comes back and that time is over: the key is not "full" any
// more, it is waiting for the next real request to confirm it (the connector puts it
// back into the rotation by itself; test/bridge-reset-due.test.mjs). The Hub must say
// that, not "full", start a relay on it when it comes first in the list, and tell
// which computers are too old to put such a key back.
// Nothing here reads a real key or leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-resetdue-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const OCG = 'opencode-go';
const HOUR = 3_600_000;
const NOW = Date.now();
const GO1 = 'sk-resetdue-go-one-0000000001';
const GO2 = 'sk-resetdue-go-two-0000000002';
const GO3 = 'sk-resetdue-go-three-00000003';
const CC1 = 'sk-resetdue-cc-one-0000000004';
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'deepseek.json'),
  JSON.stringify({
    gateway: OCG,
    keys: {
      [OCG]: {
        revision: 3,
        activeId: 'k_go2',
        keys: [
          // out an hour ago, the gateway said it comes back a minute ago
          { id: 'k_go1', key: GO1, addedAt: 1000, exhaustedAt: NOW - HOUR, retryAt: NOW - 60_000 },
          { id: 'k_go2', key: GO2, addedAt: 2000 },
          // out, comes back in an hour (stated)
          { id: 'k_go3', key: GO3, addedAt: 3000, exhaustedAt: NOW - 1000, retryAt: NOW + HOUR },
        ],
      },
      // out, no time ever stated
      commandcode: { revision: 2, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: CC1, addedAt: 500, exhaustedAt: NOW - HOUR }] },
    },
    order: ['k_go1', 'k_go2', 'k_go3', 'k_cc1'],
    activity: {},
  }),
  { mode: 0o600 },
);

let account;
let machines;
let gateway;
const disk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8'));
const view = () => Object.fromEntries(account.publicAccount().rotation.keys.map((k) => [k.id, k]));

const sockets = new Map();
function connect(machineId, extra = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  sockets.set(machineId, ws);
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '0.12.0', status: { available: true, server: false }, ...extra }));
}
const provisionArgs = async (machineId) => {
  let seen;
  account.forgetProvider(machineId);
  await account.ensureProvider(machineId, { rpc: async (id, op, args) => ((seen = args), { ok: true, models: [] }) });
  return seen;
};

before(async () => {
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${gateway.address().port}`;
  account = await import('../server/deepseek-account.js');
  machines = await import('../server/machines.js');
  connect('m_new', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'pool_sticky', 'pool_reset_due'] });
  connect('m_old', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'pool_sticky'] });
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a key whose stated reset time has passed is "reset_due", not "exhausted"; the other two keep their words', () => {
  const v = view();
  assert.equal(v.k_go1.state, 'reset_due');
  assert.equal(v.k_go1.resetDue, true);
  assert.equal(v.k_go1.resetAt, NOW - 60_000, 'the time the gateway stated is still said');
  assert.equal(v.k_go1.expiryKnown, false, 'it is not waiting for a time any more');
  assert.deepEqual([v.k_go2.state, v.k_go2.resetDue], ['ready', false]);
  assert.deepEqual([v.k_go3.state, v.k_go3.resetDue, v.k_go3.expiryKnown], ['exhausted', false, true], 'a time still ahead: out');
  assert.deepEqual([v.k_cc1.state, v.k_cc1.resetDue, v.k_cc1.expiryKnown], ['exhausted', false, false], 'no time was stated, nothing is due');
});

test('the Hub does not call the whole pool out while a key is only waiting for its confirming request', () => {
  const acc = account.publicAccount();
  assert.equal(acc.rotation.activeId, 'k_go1', 'the first key in the list that is not out: the one that is due comes before a ready one that stands later');
  // Nothing is "all out" here: one key is ready and one is due. Take the ready one away to see the due one alone.
  assert.equal(acc.rotation.allExhausted, false);
  assert.equal(acc.gateways.find((g) => g.id === OCG).allExhausted, false);
});

test('a relay is started on the first key of the list whose time has passed, ahead of a later ready one; its mark and time go along unchanged', async () => {
  const args = await provisionArgs('m_new');
  assert.equal(args.pool.activeId, 'k_go1');
  const sent = args.pool.keys.find((k) => k.id === 'k_go1');
  assert.deepEqual([sent.exhaustedAt, sent.retryAt], [NOW - HOUR, NOW - 60_000], 'the connector decides by the very time the gateway stated');
});

test('which computers can put such a key back: only those that say so', () => {
  for (const m of ['m_new', 'm_old']) account.applyPoolReport(m, { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: account.rotationRevision(), activeId: 'k_go2', keys: [] });
  const rows = Object.fromEntries(account.publicAccount().activity.map((a) => [a.machineId, a]));
  assert.equal(rows.m_new.resetDueCapable, true);
  assert.equal('resetDueCapable' in rows.m_old, false, 'an older connector waits for every other key to be out before it looks at such a key');
});

test('a key a person marked full is never "reset_due"; clearing the mark puts it back', () => {
  account.markFull('k_go2');
  assert.deepEqual([view().k_go2.state, view().k_go2.resetDue], ['manual', false]);
  account.clearMark('k_go2');
  assert.equal(view().k_go2.state, 'ready');
});

test('a connector reports the key out again with a time ahead: it is "exhausted" once more; with every key out and none due the pool is out, and the earliest stated time is said', () => {
  const rev = account.rotationRevision();
  account.applyPoolReport('m_new', {
    t: 'deepseek.pool',
    gateway: OCG,
    rotation: 1,
    revision: rev,
    activeId: 'k_go2',
    keys: [
      { id: 'k_go1', exhaustedAt: NOW - 1000, retryAt: NOW + 2 * HOUR },
      { id: 'k_go2', exhaustedAt: NOW - 500, retryAt: NOW + 3 * HOUR },
    ],
  });
  const acc = account.publicAccount();
  assert.deepEqual(acc.rotation.keys.map((k) => k.state), ['exhausted', 'exhausted', 'exhausted', 'exhausted']);
  assert.equal(acc.rotation.allExhausted, true);
  assert.equal(acc.rotation.nextResetAt, NOW + HOUR);
});
