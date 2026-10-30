// What the Hub does with the rate-limit news a connector reports (2026-10-30; the connector's
// side is test/bridge-rate-limit.test.mjs): which key is cooling down and until when, on what
// count, how often a key was borrowed from / cooled / resent - and which keys a stuck turn can
// count on. Only what a connector that SAYS it watches (`pool_rate`) reported is believed, and
// only from a computer that is online. Nothing here reads a real key or leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-rate-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const OCG = 'opencode-go';
const HOUR = 3_600_000;
const NOW = Date.now();
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'deepseek.json'),
  JSON.stringify({
    gateway: OCG,
    keys: {
      [OCG]: {
        revision: 3,
        activeId: 'k_go1',
        keys: [
          { id: 'k_go1', key: 'sk-rate-hub-go-one-00000001', addedAt: 1000 },
          { id: 'k_go2', key: 'sk-rate-hub-go-two-00000002', addedAt: 2000 },
          // out of quota, the stated time has passed: waiting to be confirmed (counts as available)
          { id: 'k_go3', key: 'sk-rate-hub-go-three-0000003', addedAt: 3000, exhaustedAt: NOW - HOUR, retryAt: NOW - 60_000 },
        ],
      },
      // out of quota with a time ahead
      commandcode: { revision: 2, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: 'sk-rate-hub-cc-one-00000004', addedAt: 500, exhaustedAt: NOW - 1000, retryAt: NOW + HOUR }] },
    },
    order: ['k_go1', 'k_go2', 'k_go3', 'k_cc1'],
    activity: {},
  }),
  { mode: 0o600 },
);

let account;
let machines;
let gateway;
const sockets = new Map();
const view = () => Object.fromEntries(account.publicAccount().rotation.keys.map((k) => [k.id, k]));
const report = (machineId, keys, over = {}) =>
  account.applyPoolReport(machineId, { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: account.rotationRevision(), activeId: 'k_go1', distribution: 'sticky', keys, ...over });
function connect(machineId, extra = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  sockets.set(machineId, ws);
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '0.12.0', status: { available: true, server: false }, ...extra }));
}
const CAPS = ['pool', 'pool_cross', 'pool_auth', 'pool_sticky', 'pool_reset_due', 'pool_rate'];

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
  connect('m_rate', { pool: 1, capabilities: CAPS });
  connect('m_rate2', { pool: 1, capabilities: CAPS });
  connect('m_old', { pool: 1, capabilities: CAPS.filter((c) => c !== 'pool_rate') });
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const cool = (over = {}) => ({ until: Date.now() + 60_000, level: 0, n429: 4, windowMs: 30_000, ...over });

test('a connector that watches reports a key cooling down: the page is told until when and on what count; the key is still "ready" (it is in use for everything else)', () => {
  assert.equal(view().k_go1.rateCooldown, null, 'nothing reported: nothing said');
  const until = Date.now() + 60_000;
  assert.equal(report('m_rate', [{ id: 'k_go1', rateCooldown: cool({ until, n429: 4 }) }]), true);
  const k = view().k_go1;
  assert.deepEqual(k.rateCooldown, { until, n429: 4, windowMs: 30_000, level: 0, machines: 1 });
  assert.equal(k.state, 'ready');
  assert.equal(account.keyCooling('k_go1'), true);
  assert.equal(account.keyCooling('k_go2'), false);
  assert.equal(view().k_go2.rateCooldown, null);
  // The same report again changes nothing (nothing to broadcast).
  assert.equal(report('m_rate', [{ id: 'k_go1', rateCooldown: cool({ until, n429: 4 }) }]), false);
});

test('a report replaces the computer\'s last one: no cooldown in it takes the mark back', () => {
  report('m_rate', [{ id: 'k_go1' }]);
  assert.equal(view().k_go1.rateCooldown, null);
});

test('two computers add up: the later end, the more 429, how many computers say so', () => {
  const t1 = Date.now() + 30_000;
  const t2 = Date.now() + 90_000;
  report('m_rate', [{ id: 'k_go1', rateCooldown: cool({ until: t1, n429: 3, level: 0 }) }]);
  report('m_rate2', [{ id: 'k_go1', rateCooldown: cool({ until: t2, n429: 5, level: 1 }) }]);
  assert.deepEqual(view().k_go1.rateCooldown, { until: t2, n429: 8, windowMs: 30_000, level: 1, machines: 2 });
  // A computer that goes away takes its word with it.
  sockets.get('m_rate2').emit('close');
  assert.deepEqual(view().k_go1.rateCooldown, { until: t1, n429: 3, windowMs: 30_000, level: 0, machines: 1 });
  connect('m_rate2', { pool: 1, capabilities: CAPS });
  assert.equal(view().k_go1.rateCooldown?.machines, 1, 'and it does not come back with the computer: it must say it again');
});

test('a cooldown whose time has passed is not shown, whatever the last report said', () => {
  report('m_rate', [{ id: 'k_go1', rateCooldown: cool({ until: Date.now() - 1000 }) }]);
  assert.equal(view().k_go1.rateCooldown, null);
});

test('a computer whose connector does not say it watches is not believed about it; nothing odd gets in: ids the Hub does not know, numbers that are not numbers', () => {
  report('m_old', [{ id: 'k_go2', rateCooldown: cool() }]);
  assert.equal(view().k_go2.rateCooldown, null);
  report('m_rate', [
    { id: 'k_unknown', rateCooldown: cool() },
    { id: 'k_go2', rateCooldown: { until: 'soon', n429: -4, windowMs: 'x' } },
    { id: 'k_go1', rateCooldown: { until: Date.now() + 10 * 86_400_000, n429: 1, windowMs: 30_000, level: 0 } },
  ]);
  assert.equal(view().k_go2.rateCooldown, null);
  assert.equal(view().k_go1.rateCooldown, null, 'ten days is not a cooldown');
  assert.ok(!JSON.stringify(account.publicAccount()).includes('k_unknown'));
});

test('the counts of borrowing, cooling and resending add up over the computers that say so, and are numbers and nothing else', () => {
  report('m_rate', [{ id: 'k_go1', rateStats: { borrows: 4, cooldowns: 1, resendOk: 3, resendFail: 0 } }]);
  report('m_rate2', [{ id: 'k_go1', rateStats: { borrows: 2, cooldowns: 0, resendOk: 1, resendFail: 1 } }]);
  assert.deepEqual(view().k_go1.rateStats, { borrows: 6, cooldowns: 1, resendOk: 4, resendFail: 1 });
  assert.equal(view().k_go2.rateStats, null);
  report('m_rate', [{ id: 'k_go1', rateStats: { borrows: 'many', cooldowns: -1, resendOk: 1.5, resendFail: 2, evil: 'x' } }]);
  assert.deepEqual(view().k_go1.rateStats, { borrows: 2, cooldowns: 0, resendOk: 1, resendFail: 3 }, 'only the whole numbers of the four names; the rest counts as nothing');
});

test('which computers watch for rate limits: only those that say so', () => {
  const rows = Object.fromEntries(account.publicAccount().activity.map((a) => [a.machineId, a]));
  assert.equal(rows.m_rate.rateCapable, true);
  assert.equal('rateCapable' in rows.m_old, false, 'an older connector neither lends a request that got a 429 nor cools a key');
});
