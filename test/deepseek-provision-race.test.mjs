// DeepSeek provider provisioning races (server/deepseek-account.js): one
// ordered provision per computer, joined when the state is the same, with the
// gateway/pool/revision read when the request is actually sent. Every bridge
// answer is held behind an explicit gate, so the order is proved rather than
// assumed with sleeps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-race-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const account = await import('../server/deepseek-account.js');
const machines = await import('../server/machines.js');

const GW = 'opencode-go';
const OTHER_GW = 'opencode';
const K1 = 'sk-race-first-000000000001';
const K2 = 'sk-race-second-00000000002';
const K3 = 'sk-race-other-000000000003';

after(() => {
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

// ------------------------------------------------------------ helpers

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let every already-queued microtask/macrotask run once. This is a turn of
// the event loop, not a wait for a request to finish: requests finish only
// when a gate is released.
const flush = () => new Promise((r) => setImmediate(r));

// A bridge whose provision answers wait for the test to release them. `next()`
// resolves as soon as the next provision request is registered, so a test can
// hold the first one out while it changes the account.
function provisioner() {
  const calls = [];
  const waiting = [];
  const arrived = [];
  const installed = new Map();
  const note = (call) => {
    if (waiting.length) waiting.shift()(call);
    else arrived.push(call);
  };
  const rpc = async (machineId, op, args) => {
    const call = { machineId, op, args };
    calls.push(call);
    if (op === 'kimi.deepseek.remove') {
      installed.delete(machineId);
      return { ok: true, removed: true };
    }
    const gate = deferred();
    call.release = () => gate.resolve();
    call.fail = (err) => gate.reject(err);
    note(call);
    await gate.promise;
    installed.set(machineId, args);
    return { ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`) };
  };
  const next = () => (arrived.length ? Promise.resolve(arrived.shift()) : new Promise((r) => waiting.push(r)));
  return { calls, installed, next, rpc };
}

function connect(machineId, { pool = 0 } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '9.0.0', pool, status: { available: true, server: true } }));
}

// A clean account: known gateway, the given keys, no provisioned machines.
function setup({ keys = [K1], gateway = GW, other = [] } = {}) {
  account.reload();
  for (const id of ['opencode-go', 'opencode', 'commandcode']) account.clearKey(id);
  account.setSettings({ gateway });
  for (const key of keys) account.setKey(gateway, key);
  for (const key of other) account.setKey(OTHER_GW, key);
}

const provisions = (ctl) => ctl.calls.filter((c) => c.op === 'kimi.deepseek.provision');

// ------------------------------------------------------------ the races

test('a queued provision reads the gateway, pool and revision when it runs', async () => {
  setup();
  connect('race_recheck', { pool: 1 });
  const ctl = provisioner();
  const pending = account.ensureProvider('race_recheck', { rpc: ctl.rpc });
  // The call has not reached the bridge yet; change the pool first.
  const secondId = account.setKey(GW, K2);
  const revision = account.poolRevision(GW);

  const call = await ctl.next();
  assert.equal(call.args.pool.revision, revision, 'the revision at execution time, not at call time');
  assert.deepEqual(call.args.pool.keys.map((k) => k.apiKey), [K1, K2]);
  assert.equal(call.args.pool.activeId, secondId);
  call.release();
  await pending;
  assert.equal(provisions(ctl).length, 1, 'the obsolete call-time args were never sent');
});

test('calls for the same state share one request', async () => {
  setup();
  connect('race_share', { pool: 1 });
  const ctl = provisioner();
  const a = account.ensureProvider('race_share', { rpc: ctl.rpc });
  const b = account.ensureProvider('race_share', { rpc: ctl.rpc });
  const c = account.ensureProvider('race_share', { rpc: ctl.rpc });

  const call = await ctl.next();
  await flush();
  assert.equal(provisions(ctl).length, 1, 'one request, shared by all three callers');
  call.release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(ra, rb);
  assert.equal(rb, rc);
  assert.equal(provisions(ctl).length, 1);
  assert.equal((await account.ensureProvider('race_share', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 1, 'cached afterwards');
});

test('different computers provision in parallel', async () => {
  setup();
  connect('race_par_a', { pool: 1 });
  connect('race_par_b', { pool: 1 });
  const ctl = provisioner();
  const a = account.ensureProvider('race_par_a', { rpc: ctl.rpc });
  const b = account.ensureProvider('race_par_b', { rpc: ctl.rpc });

  const [ca, cb] = await Promise.all([ctl.next(), ctl.next()]);
  assert.equal(provisions(ctl).length, 2, 'both requests are out before either is answered');
  let settled = 0;
  a.then(() => settled++, () => settled++);
  b.then(() => settled++, () => settled++);
  await flush();
  assert.equal(settled, 0, 'neither waits for the other computer');
  ca.release();
  cb.release();
  await Promise.all([a, b]);
  assert.equal(provisions(ctl).length, 2);
});

test('a slower request for an older revision cannot overwrite the newer state', async () => {
  setup();
  connect('race_order', { pool: 1 });
  const ctl = provisioner();
  const first = account.ensureProvider('race_order', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  assert.equal(c1.args.pool.keys.length, 1);

  const secondId = account.setKey(GW, K2);
  const revision = account.poolRevision(GW);
  const second = account.ensureProvider('race_order', { rpc: ctl.rpc });
  await flush();
  assert.equal(provisions(ctl).length, 1, 'the newer state waits for the request already out');

  c1.release();
  const c2 = await ctl.next();
  assert.equal(c2.args.pool.revision, revision, 'the follow-up uses the current revision');
  assert.deepEqual(c2.args.pool.keys.map((k) => k.apiKey), [K1, K2]);
  assert.equal(c2.args.pool.activeId, secondId);

  // A caller arriving while the follow-up is out joins it: the old request's
  // completion did not drop the pending follow-up.
  const third = account.ensureProvider('race_order', { rpc: ctl.rpc });
  await flush();
  assert.equal(provisions(ctl).length, 2);
  c2.release();

  const [r1, r2, r3] = await Promise.all([first, second, third]);
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  assert.equal(ctl.installed.get('race_order').pool.revision, revision);
  assert.equal((await account.ensureProvider('race_order', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 2, 'the cached signature is the newer one, not the old completion');
});

test('a gateway switch while a request is out is applied after it, never instead of it', async () => {
  setup({ other: [K3] });
  connect('race_gw', { pool: 1 });
  const ctl = provisioner();
  const first = account.ensureProvider('race_gw', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  assert.equal(c1.args.gateway, GW);

  account.setSettings({ gateway: OTHER_GW });
  const second = account.ensureProvider('race_gw', { rpc: ctl.rpc });
  await flush();
  assert.equal(provisions(ctl).length, 1, 'no second gateway request runs concurrently');
  c1.release();

  const c2 = await ctl.next();
  assert.equal(c2.args.gateway, OTHER_GW);
  assert.equal(c2.args.pool.keys[0].apiKey, K3);
  c2.release();
  await Promise.all([first, second]);
  assert.equal((await account.ensureProvider('race_gw', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 2);
});

test('an answer that lands after the state moved back still re-applies the current state', async () => {
  setup({ other: [K3] });
  connect('race_revert', { pool: 1 });
  const ctl = provisioner();
  // The gateway in use is provisioned and cached.
  const cached = account.ensureProvider('race_revert', { rpc: ctl.rpc });
  const c0 = await ctl.next();
  c0.release();
  await cached;
  const revision = account.poolRevision(GW);

  // Switch to the other gateway and hold its provision out.
  account.setSettings({ gateway: OTHER_GW });
  const toOther = account.ensureProvider('race_revert', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  assert.equal(c1.args.gateway, OTHER_GW);

  // Switch back while that request is out. The old signature matches again,
  // but the connector will hold the other gateway once the request lands.
  account.setSettings({ gateway: GW });
  const back = account.ensureProvider('race_revert', { rpc: ctl.rpc });
  await flush();
  assert.equal(provisions(ctl).length, 2, 'the caller joins the request already out');
  c1.release();

  const c2 = await ctl.next();
  assert.equal(c2.args.gateway, GW);
  assert.equal(c2.args.pool.revision, revision);
  c2.release();
  await Promise.all([toOther, back]);
  assert.equal(ctl.installed.get('race_revert').gateway, GW);
  assert.equal((await account.ensureProvider('race_revert', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 3, 'the old cached signature did not hide the request that landed');
});

test('clearing the key while a provision is out never leaves the old key behind', async () => {
  setup();
  connect('race_clear', { pool: 1 });
  const ctl = provisioner();
  const pending = account.ensureProvider('race_clear', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  assert.equal(c1.args.pool.keys[0].apiKey, K1);

  account.clearKey(GW);
  const removal = account.removeProviders({ rpc: ctl.rpc });
  await flush();
  assert.equal(provisions(ctl).length, 1, 'the removal waits for the request already out');

  c1.release();
  await assert.rejects(pending, (e) => e.status === 409 && e.code === 'no_key');
  await removal;

  assert.equal(ctl.installed.has('race_clear'), false, 'the old key was taken off after it landed');
  const ops = ctl.calls.map((c) => c.op);
  assert.equal(ops[0], 'kimi.deepseek.provision');
  assert.ok(ops.slice(1).length >= 1 && ops.slice(1).every((op) => op === 'kimi.deepseek.remove'), `provision then removals: ${ops.join(',')}`);

  // No key, no request. A new key is a new provision, not the old cached one.
  await assert.rejects(account.ensureProvider('race_clear', { rpc: ctl.rpc }), (e) => e.code === 'no_key');
  account.setKey(GW, K2);
  const again = account.ensureProvider('race_clear', { rpc: ctl.rpc });
  const c2 = await ctl.next();
  assert.deepEqual(c2.args.pool.keys.map((k) => k.apiKey), [K2]);
  c2.release();
  await again;
  assert.equal(ctl.installed.get('race_clear').pool.keys[0].apiKey, K2);
});

test('clearing and setting a new key while the first provision is out reprovisions the new key', async () => {
  setup();
  connect('race_clear_set', { pool: 1 });
  const ctl = provisioner();
  const first = account.ensureProvider('race_clear_set', { rpc: ctl.rpc });
  const c1 = await ctl.next();

  account.clearKey(GW);
  const removal = account.removeProviders({ rpc: ctl.rpc });
  account.setKey(GW, K2);
  const done = account.reprovision({ rpc: ctl.rpc, list: () => [{ id: 'race_clear_set', online: true, kimi: { server: true } }] });
  await flush();
  assert.equal(provisions(ctl).length, 1, 'the new provision waits behind the request and the removal');

  c1.release();
  const c2 = await ctl.next();
  assert.deepEqual(c2.args.pool.keys.map((k) => k.apiKey), [K2], 'the new key, never the cleared one');
  c2.release();
  await first.catch(() => null); // the superseded request may succeed or say no_key
  await removal;
  const c3 = await ctl.next();
  assert.deepEqual(c3.args.pool.keys.map((k) => k.apiKey), [K2]);
  c3.release();
  assert.deepEqual(await done, ['race_clear_set'], 'reprovision still finds the machine whose request was superseded');
  assert.deepEqual(ctl.installed.get('race_clear_set').pool.keys.map((k) => k.apiKey), [K2]);
  assert.equal((await account.ensureProvider('race_clear_set', { rpc: ctl.rpc })).cached, true);
});

test('removing the key in use while a provision is out sends the remaining pool', async () => {
  setup({ keys: [K1, K2] });
  const pool = account.poolOf(GW);
  const [firstId] = pool.keys.map((k) => k.id);
  const removedId = pool.keys[1].id;
  connect('race_remove', { pool: 1 });
  const ctl = provisioner();
  const pending = account.ensureProvider('race_remove', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  assert.deepEqual(c1.args.pool.keys.map((k) => k.apiKey), [K1, K2]);

  assert.equal(account.removeKey(GW, removedId), 1);
  const revision = account.poolRevision(GW);
  c1.release();

  const c2 = await ctl.next();
  assert.equal(c2.args.pool.revision, revision);
  assert.deepEqual(c2.args.pool.keys.map((k) => k.apiKey), [K1], 'the removed key is not sent again');
  assert.equal(c2.args.pool.activeId, firstId);
  c2.release();

  const answer = await pending;
  assert.equal(answer.ok, true);
  assert.deepEqual(ctl.installed.get('race_remove').pool.keys.map((k) => k.apiKey), [K1]);
  assert.equal((await account.ensureProvider('race_remove', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 2);
});

test('a failed provision is retried, never cached', async () => {
  setup();
  connect('race_fail', { pool: 1 });
  const ctl = provisioner();
  const first = account.ensureProvider('race_fail', { rpc: ctl.rpc });
  const c1 = await ctl.next();
  c1.fail(new Error('bridge exploded'));
  await assert.rejects(first, /bridge exploded/);

  const second = account.ensureProvider('race_fail', { rpc: ctl.rpc });
  const c2 = await ctl.next();
  assert.equal(provisions(ctl).length, 2, 'the failure was not remembered as provisioned');
  c2.release();
  assert.equal((await second).ok, true);
  assert.equal((await account.ensureProvider('race_fail', { rpc: ctl.rpc })).cached, true);
  assert.equal(provisions(ctl).length, 2);
});

test('a bridge hello provisions native subagents without blocking or duplicating requests', async () => {
  setup();
  const ws = new EventEmitter();
  const calls = [];
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const req = JSON.parse(raw);
    calls.push(req);
    queueMicrotask(() => ws.emit('message', JSON.stringify({
      t: 'res', id: req.id, ok: true,
      data: { ok: true, models: [], secondaryModel: { model: 'agent-hub-deepseek/deepseek-v4.1-flash', models: [], effort: 'max', force: false } },
    })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'race_hello', name: 'race_hello', platform: 'test', home: TMP, bridgeVersion: '10.0.0', pool: 1, status: { available: true, server: true } }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'kimi.deepseek.provision');
  await account.ensureProvider('race_hello');
  await flush();
  assert.equal(calls.length, 1, 'hello and an explicit caller share one completed provision');
  assert.equal((await account.ensureProvider('race_hello')).cached, true);

  account.clearKey(GW);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'race_hello', name: 'race_hello', platform: 'test', home: TMP, bridgeVersion: '10.0.0', pool: 1, status: { available: true, server: true } }));
  await flush();
  assert.equal(calls.length, 1, 'reconnect without a key does not call the bridge');
});

test('a failed hello provision waits for another explicit trigger', async () => {
  setup();
  const ws = new EventEmitter();
  const calls = [];
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const req = JSON.parse(raw);
    calls.push(req);
    queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: req.id, ok: false, error: 'hello failed' })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'race_hello_fail', name: 'race_hello_fail', platform: 'test', home: TMP, bridgeVersion: '10.0.0', pool: 1, status: { available: true, server: true } }));
  await flush();
  await flush();
  assert.equal(calls.length, 1);
  await assert.rejects(account.ensureProvider('race_hello_fail'), /hello failed/);
  await flush();
  assert.equal(calls.length, 2, 'only the explicit caller retried');
});
