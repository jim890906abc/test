// Which keys a stuck turn can count on, and the setting that turns the automatic 「繼續」 off
// (2026-10-30; server/key-recover.js reads both): the keys with quota - one only waiting to be
// confirmed after its stated reset time counts - that no computer says is cooling down because of
// rate limits, and the next moment that is going to change from a time somebody STATED. Nothing
// here reads a real key or leaves the machine.
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

test('which keys a stuck turn can count on: with quota (a key waiting to be confirmed counts), not cooling down; the time something next changes is the stated one', () => {
  // k_go1, k_go2: ready; k_go3: waiting to be confirmed; k_cc1: out until an hour from now.
  report('m_rate', [{ id: 'k_go1', rateCooldown: cool({ until: Date.now() + 45_000 }) }]);
  const a = account.availability();
  assert.deepEqual([...a.ids].sort(), ['k_go2', 'k_go3']);
  assert.ok(a.nextAt > Date.now() && a.nextAt <= Date.now() + 45_000 + 50, `the next change is the end of the cooldown, got ${a.nextAt - Date.now()} ms ahead`);
  report('m_rate', [{ id: 'k_go1' }]);
  assert.deepEqual([...account.availability().ids].sort(), ['k_go1', 'k_go2', 'k_go3']);
  // The stated time of the key that is out is the next change when nothing else is nearer.
  assert.ok(Math.abs(account.availability().nextAt - (NOW + HOUR)) < 5, 'k_cc1 comes back at the time its gateway stated');
});

test('turning the automatic "continue" off is a setting of the Hub, on by default, saved, and shown to the page', () => {
  assert.equal(account.autoResumeEnabled(), true);
  assert.equal(account.publicAccount().autoResume, true);
  account.setSettings({ autoResume: false });
  assert.equal(account.autoResumeEnabled(), false);
  assert.equal(account.publicAccount().autoResume, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8')).autoResume, false);
  account.setSettings({ autoResume: true });
  assert.equal(account.autoResumeEnabled(), true);
  assert.throws(() => account.setSettings({ autoResume: 'yes' }), /autoResume/);
});
