// When the hub provisions a computer's Kimi with the DeepSeek provider, and
// what it records about it (server/deepseek-account.js + machines.js):
//   - not only at the connector's hello: also when Kimi's server comes up
//     later, when the connector reconnects, on a key change, on an explicit
//     retry;
//   - a failure is retried with a backoff (and stops, and says why);
//   - the last result is on the machine: machine.provision = { ok, at, reason };
//   - the connector's capabilities / stale-daemon report are on the machine.
// A scripted machine that speaks the bridge protocol; no Kimi, no gateway.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-provision-triggers-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const account = await import('../server/deepseek-account.js');
const machines = await import('../server/machines.js');

const GW = 'opencode-go';
const KEY = 'sk-triggers-secret-000000000001';
const KEY2 = 'sk-triggers-secret-000000000002';
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve(fn()).catch(() => null);
    if (value) return value;
    await wait(10);
  }
  throw new Error(`timeout: ${what}`);
}
const okAnswer = (args, extra = {}) => ({ ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`), ...extra });

// A fake bridge connection. `handler(msg)` returns the answer (or throws) for
// every provision/remove request; `requests` records them.
function connect(id, { handler = (msg) => okAnswer(msg.args), hello = {}, status = { available: true, server: true } } = {}) {
  const requests = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req') return;
    requests.push(msg);
    Promise.resolve()
      .then(() => handler(msg))
      .then((data) => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: true, data })))
      .catch((err) => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: false, error: err.message })));
  };
  machines.attachBridge(ws);
  const say = (m) => ws.emit('message', JSON.stringify(m));
  const helloMsg = (over = {}) => ({ t: 'hello', machineId: id, name: id, platform: 'test', home: TMP, bridgeVersion: '0.11.0', pool: 1, status, ...hello, ...over });
  say(helloMsg());
  return { requests, ws, say, hello: helloMsg };
}
const provisions = (c) => c.requests.filter((r) => r.op === 'kimi.deepseek.provision');
const state = (id) => machines.listMachines().find((m) => m.id === id);

function reset() {
  account.reload();
  for (const gw of ['opencode-go', 'opencode', 'commandcode']) account.clearKey(gw);
  account.setSettings({ gateway: GW });
  account.setProvisionRetryDelays([40, 80]);
}
beforeEach(reset);

after(async () => {
  account.reload();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Kimi\'s server coming up after the hello provisions the computer (it used to be missed for good)', async () => {
  account.setKey(GW, KEY);
  const c = connect('trig_late', { status: { available: true, server: false } });
  await wait(80);
  assert.equal(provisions(c).length, 0, 'no server, nothing to provision');
  c.say({ t: 'kimi.status', status: { available: true, server: true } });
  await until(() => provisions(c).length === 1, 4000, 'provision after the server came up');
  await until(() => state('trig_late').provision?.ok === true, 4000, 'recorded result');
  assert.equal(state('trig_late').provision.reason, null);
  // Status pushes that do not change "server is up" provision nothing more.
  c.say({ t: 'kimi.status', status: { available: true, server: true, version: '2.3.3' } });
  await wait(80);
  assert.equal(provisions(c).length, 1);
  // Kimi's server going away and coming back loses nothing (the provider is in
  // Kimi's config file): the answer already known is trusted, no new request.
  c.say({ t: 'kimi.status', status: { available: true, server: false } });
  c.say({ t: 'kimi.status', status: { available: true, server: true } });
  await wait(100);
  assert.equal(provisions(c).length, 1);
});

test('a connector that reconnects is provisioned again, and a key change reaches the computer', async () => {
  account.setKey(GW, KEY);
  const c = connect('trig_again');
  await until(() => provisions(c).length === 1, 4000, 'first provision');
  c.say(c.hello());
  await until(() => provisions(c).length === 2, 4000, 'provision after the reconnect');
  account.setKey(GW, KEY2);
  const ids = await account.reprovision();
  assert.ok(ids.includes('trig_again'));
  assert.equal(provisions(c).length, 3);
  assert.equal(provisions(c).at(-1).args.pool.keys.length, 2);
});

test('machine.provision carries the last result and why, with every key masked', async () => {
  account.setKey(GW, KEY);
  let mode = 'fail';
  const c = connect('trig_state', {
    handler: (msg) => {
      if (mode === 'fail') throw new Error(`gateway refused ${KEY} (HTTP 500)`);
      if (mode === 'warn') return okAnswer(msg.args, { secondaryWarning: `no default_model; saw ${KEY}` });
      return okAnswer(msg.args);
    },
  });
  await until(() => state('trig_state').provision?.ok === false, 4000, 'failure recorded');
  let p = state('trig_state').provision;
  assert.equal(typeof p.at, 'number');
  assert.match(p.reason, /gateway refused/);
  assert.ok(!JSON.stringify(state('trig_state')).includes(KEY), 'no key in the machine status');
  assert.match(p.reason, /…0001/);
  // Success with a problem in the native subagent default: the provider is
  // there (ok), the reason for the warning is on the record, not a failure.
  mode = 'warn';
  const r = await account.retryProvision('trig_state');
  assert.equal(r.ok, true);
  p = state('trig_state').provision;
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.match(p.warning, /no default_model/);
  assert.ok(!JSON.stringify(state('trig_state')).includes(KEY));
  assert.ok(account.publicAccount().warnings.some((w) => w.machineId === 'trig_state' && /default_model/.test(w.text)), 'the settings page shows it');
  // A clean provision clears the warning.
  mode = 'clean';
  c.say(c.hello());
  await until(() => state('trig_state').provision?.ok === true && !state('trig_state').provision.warning, 4000, 'clean provision');
  assert.ok(!account.publicAccount().warnings.some((w) => w.machineId === 'trig_state'));
});

test('a failed provision is retried with a growing delay, then stops and says so', async () => {
  account.setKey(GW, KEY);
  const attempts = [];
  const c = connect('trig_backoff', {
    handler: () => {
      attempts.push(Date.now());
      throw new Error('socket hang up');
    },
  });
  await until(() => attempts.length === 3, 4000, 'the first try and two retries');
  await wait(300);
  assert.equal(attempts.length, 3, 'then it stops (delays: 40 ms, 80 ms)');
  assert.ok(attempts[1] - attempts[0] >= 35, 'first retry waits');
  assert.ok(attempts[2] - attempts[1] >= 70, 'second retry waits longer');
  const p = state('trig_backoff').provision;
  assert.equal(p.ok, false);
  assert.match(p.reason, /socket hang up/);
  // An explicit retry starts over, and a success ends the story.
  c.requests.length = 0;
  attempts.length = 0;
  const r = await account.retryProvision('trig_backoff', { rpc: async (id, op, args) => okAnswer(args) });
  assert.equal(r.ok, true);
  assert.equal(state('trig_backoff').provision.ok, true);
  await wait(200);
  assert.equal(attempts.length, 0, 'no stray retry after the success');
});

test('a retry that succeeds stops the backoff', async () => {
  account.setKey(GW, KEY);
  let n = 0;
  const c = connect('trig_recovers', {
    handler: (msg) => {
      n++;
      if (n < 2) throw new Error('kimi is restarting');
      return okAnswer(msg.args);
    },
  });
  await until(() => state('trig_recovers').provision?.ok === true, 4000, 'recovered by the first retry');
  await wait(250);
  assert.equal(n, 2, 'no further tries');
  assert.equal(provisions(c).length, 2);
});

test('failures only a person can fix are not retried', async () => {
  // A connector too old to know the op.
  account.setKey(GW, KEY);
  let old = 0;
  connect('trig_old', {
    handler: () => {
      old++;
      throw new Error('未知的操作：kimi.deepseek.provision');
    },
  });
  await until(() => state('trig_old').provision?.ok === false, 4000, 'old connector recorded');
  assert.equal(state('trig_old').provision.code, 'connector_old');
  assert.match(state('trig_old').provision.reason, /連接器太舊/);
  await wait(250);
  assert.equal(old, 1, 'not retried');

  // Several keys on a connector without the pool.
  account.setKey(GW, KEY2);
  const c = connect('trig_nopool', { hello: { pool: 0 } });
  await until(() => state('trig_nopool').provision?.code === 'pool_unsupported', 4000, 'pool_unsupported recorded');
  await wait(150);
  assert.equal(provisions(c).length, 0);
  assert.equal(state('trig_nopool').provision.ok, false);
});

test('no key: nothing is provisioned and nothing is recorded as failed', async () => {
  const c = connect('trig_nokey');
  await wait(100);
  assert.equal(provisions(c).length, 0);
  assert.equal(state('trig_nokey').provision, null);
});

test('the connector\'s capabilities and stale-daemon report are on the machine, exactly as sent, and never guessed from the version', () => {
  const c = connect('cap_new', { hello: { capabilities: ['pool', 'secondary_model', 'broker', 'handoff'], bridgeVersion: '0.11.0' } });
  assert.deepEqual(state('cap_new').capabilities, ['pool', 'secondary_model', 'broker', 'handoff']);
  // Kept across a hub restart for a machine that is offline then.
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_HUB_DATA, 'machines.json'), 'utf8')).find((x) => x.id === 'cap_new');
  assert.deepEqual(saved.capabilities, ['pool', 'secondary_model', 'broker', 'handoff']);
  assert.equal(machines.hasCapability('cap_new', 'handoff'), true);
  assert.equal(state('cap_new').daemonStale, false);
  // An older connector sends none: empty, whatever else it sends (pool:1 and
  // broker:1 are the numeric flags it always had).
  connect('cap_old', { hello: { bridgeVersion: '0.10.0', pool: 1, broker: 1 } });
  assert.deepEqual(state('cap_old').capabilities, []);
  assert.equal(machines.hasCapability('cap_old', 'broker'), false);
  assert.equal(state('cap_old').pool, 1);
  // Junk is dropped, the rest kept.
  connect('cap_junk', { hello: { capabilities: ['pool', 'Pool', 42, null, 'pool', '../x', 'broker'] } });
  assert.deepEqual(state('cap_junk').capabilities, ['pool', 'broker']);
  connect('cap_text', { hello: { capabilities: 'pool,broker' } });
  assert.deepEqual(state('cap_text').capabilities, []);
  // The stale daemon: on the hello, then by update, then cleared.
  connect('cap_stale', { hello: { daemonStale: true, daemonStaleReason: '舊的背景程式缺少 subagent_config' } });
  assert.equal(state('cap_stale').daemonStale, true);
  assert.match(state('cap_stale').daemonStaleReason, /subagent_config/);
  c.say({ t: 'daemon.state', stale: true, reason: 'handoff 不支援' });
  assert.deepEqual([state('cap_new').daemonStale, state('cap_new').daemonStaleReason], [true, 'handoff 不支援']);
  c.say({ t: 'daemon.state', stale: false });
  assert.deepEqual([state('cap_new').daemonStale, state('cap_new').daemonStaleReason], [false, '']);
  assert.equal(machines.CAPABILITY_CONNECTOR_VERSION, '0.11.0');
});
