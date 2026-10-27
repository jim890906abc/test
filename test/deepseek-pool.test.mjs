// The DeepSeek key pool (server/deepseek-account.js): migration from the old
// single-key file, deduplication, add/activate/remove/retry, the public
// projection (never a secret), connector capability fallback, pool reports
// and per-machine active keys. A local fake gateway answers /models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-pool-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const GW = 'opencode-go';
const KEY1 = 'sk-pool-first-000000000001';
const KEY2 = 'sk-pool-second-00000000002';
const OLD1 = 'sk-old-single-00000000old1';
const OLD2 = 'sk-old-cmd-0000000000old2';
// Before the account module loads: the old file shape (keys[gateway] string).
const OLD_FILE = { gateway: GW, keys: { [GW]: OLD1, commandcode: OLD2 } };
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'deepseek.json'), JSON.stringify(OLD_FILE, null, 2));

let account;
let machines;
let gateway;
const asked = [];
// What the fake gateway answers a real chat request with, by upstream key
// ('*' for any); default: a normal short completion.
const chat = new Map();
const quotaAnswer = (status = 402, code = 'insufficient_quota') => (res) => ((res.statusCode = status), res.end(JSON.stringify({ error: { code, message: 'You exceeded your current quota' } })));

const file = () => path.join(DATA, 'deepseek.json');
const disk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const gatewayOf = (pub, id = GW) => pub.gateways.find((g) => g.id === id);
const scan = (value) => JSON.stringify(value);

async function keys(...list) {
  account.clearKey(GW);
  for (const key of list) account.setKey(GW, key);
  account.setSettings({ gateway: GW });
  return account.poolOf(GW);
}

// Tests may route the automatic hello provision through the same fake RPC as
// the explicit call, so no fixture waits for a response its fake bridge lacks.
function connect(machineId, extra = {}) {
  const { rpc, ...hello } = extra;
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req' || !rpc) return;
    Promise.resolve()
      .then(() => rpc(msg.machineId || machineId, msg.op, msg.args))
      .then((data) => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: true, data })))
      .catch((err) => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: false, error: err.message })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '0.10.0', status: { available: true, server: true }, ...hello }));
  return ws;
}

before(async () => {
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      asked.push({ url: req.url, auth: req.headers.authorization, method: req.method, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        return (chat.get(key) || chat.get('*') || ((r) => r.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))))(res);
      }
      if (!req.url.endsWith('/models')) return (res.statusCode = 404), res.end('{}');
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${gateway.address().port}`;
  account = await import('../server/deepseek-account.js');
  machines = await import('../server/machines.js');
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the old single key migrates in place, keeps its id, and the file stays 0600', () => {
  const pub = account.publicAccount();
  assert.equal(pub.gateway, GW);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, OLD1.slice(-4));
  const go = gatewayOf(pub);
  assert.equal(go.keyCount, 1);
  assert.deepEqual(go.keys.map((k) => [k.hint, k.active, k.exhaustedAt]), [[OLD1.slice(-4), true, null]]);
  assert.equal(account.apiKey(GW), OLD1);
  const migrated = disk();
  assert.equal(migrated.keys[GW].keys[0].key, OLD1);
  assert.equal(migrated.keys[GW].keys[0].id, go.keys[0].id);
  assert.equal(migrated.keys[GW].revision, 1);
  assert.equal(fs.statSync(file()).mode & 0o077, 0, 'readable by this user only');

  assert.equal(typeof OLD_FILE.keys[GW], 'string', 'the fixture was the old single-string shape');
  assert.equal(typeof migrated.keys[GW], 'object', 'the file now holds the pooled shape');

  account.reload();
  assert.equal(account.publicAccount().gateways[0].keys[0].id, go.keys[0].id, 'the random id is stable across reloads');
  assert.equal(account.apiKey(GW), OLD1);
  assert.equal(gatewayOf(account.publicAccount(), 'commandcode').keyCount, 1);
});

test('adding the same key twice keeps one entry; add, prefer, remove and retry move the revision', async () => {
  account.clearKey(GW);
  const first = account.setKey(GW, KEY1);
  const revision = account.poolRevision(GW);
  assert.equal(account.setKey(GW, KEY1), first, 'the same key is the same entry');
  assert.equal(account.poolRevision(GW), revision, 'no revision change for the active duplicate');
  assert.equal(gatewayOf(account.publicAccount()).keyCount, 1);

  const second = account.setKey(GW, KEY2);
  assert.notEqual(second, first);
  let pub = account.publicAccount();
  assert.deepEqual(gatewayOf(pub).keys.map((k) => [k.id, k.active]), [[first, false], [second, true]]);
  assert.equal(gatewayOf(pub).keyHint, KEY2.slice(-4));
  assert.ok(account.poolRevision(GW) > revision);

  const beforeActivate = account.poolRevision(GW);
  account.activateKey(GW, first);
  assert.equal(account.poolRevision(GW), beforeActivate + 1);
  assert.equal(gatewayOf(account.publicAccount()).keys.find((k) => k.active).id, first);

  account.removeKey(GW, second);
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keyCount, 1);
  assert.deepEqual(gatewayOf(pub).keys.map((k) => k.id), [first]);

  // A report marks the active key exhausted; only a successful /models retry
  // clears it and makes it active again.
  const rev = account.poolRevision(GW);
  assert.equal(account.applyPoolReport('m_report', { t: 'deepseek.pool', gateway: GW, revision: rev, activeId: first, keys: [{ id: first, exhaustedAt: 1234 }] }), true);
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys[0].exhaustedAt, 1234);
  assert.deepEqual(pub.activity, [{ machineId: 'm_report', machineName: 'm_report', gateway: GW, activeId: first, revision: rev }]);
  await account.retryKey(GW, first);
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys[0].exhaustedAt, null);
  assert.equal(gatewayOf(pub).keys[0].active, true);
  assert.ok(asked.some((a) => a.auth === `Bearer ${KEY1}`), 'retry checked the key at the gateway');

  // No public output ever has the secret or the old one.
  for (const text of [scan(account.publicAccount()), scan(gatewayOf(account.publicAccount()))]) {
    assert.ok(!text.includes(KEY1) && !text.includes(KEY2) && !text.includes(OLD1), 'public projection has no key');
  }
  assert.equal(fs.statSync(file()).mode & 0o077, 0);
});

test('an older connector may use exactly one key; several keys are a clear 409, and pool:1 gets every key', async () => {
  await keys(KEY1);
  const calls = [];
  const rpc = async (machineId, op, args) => {
    calls.push({ machineId, op, args });
    return { ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`) };
  };
  connect('m_old', { rpc });
  connect('m_pool', { pool: 1, rpc });

  await account.ensureProvider('m_old', { rpc });
  const oldCall = calls.filter((c) => c.machineId === 'm_old').at(-1);
  assert.deepEqual(Object.keys(oldCall.args).sort(), ['apiKey', 'gateway', 'models']);
  assert.equal(oldCall.args.apiKey, KEY1);

  await account.ensureProvider('m_pool', { rpc });
  const poolArgs = calls.filter((c) => c.machineId === 'm_pool').at(-1).args;
  assert.deepEqual(Object.keys(poolArgs).sort(), ['gateway', 'models', 'pool']);
  assert.equal(poolArgs.pool.revision, account.poolRevision(GW));
  assert.deepEqual(poolArgs.pool.keys, [{ id: account.poolOf(GW).keys[0].id, apiKey: KEY1 }]);
  assert.equal(poolArgs.pool.activeId, account.poolOf(GW).activeId);

  const second = account.setKey(GW, KEY2);
  const before = calls.length;
  await assert.rejects(account.ensureProvider('m_old', { rpc }), (e) => e.status === 409 && e.code === 'pool_unsupported' && /0\.10/.test(e.message) && !e.message.includes(KEY1) && !e.message.includes(KEY2));
  assert.equal(calls.length, before, 'an old connector is never quietly given one of several keys');
  // A stale cached sig cannot hide the new revision either.
  await account.ensureProvider('m_pool', { rpc });
  const two = calls.filter((c) => c.machineId === 'm_pool').at(-1).args.pool;
  assert.equal(two.keys.length, 2);
  assert.equal(two.keys.find((k) => k.id === second).apiKey, KEY2);
});

test('reports only touch known gateways/ids, a stale revision cannot undo newer key state, and each machine keeps its own active key', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const rev = pool.revision;

  // Unknown gateway and unknown key id are ignored; the report is still a
  // valid activity for the machine, with no invented active id.
  assert.equal(account.applyPoolReport('m_x', { t: 'deepseek.pool', gateway: 'evil', revision: rev, activeId: first, keys: [] }), false);
  account.applyPoolReport('m_pool', { t: 'deepseek.pool', gateway: GW, revision: rev, activeId: 'dk_unknown', keys: [{ id: 'dk_unknown', exhaustedAt: 5 }, { id: second, exhaustedAt: null, apiKey: KEY2 }] });
  let pub = account.publicAccount();
  assert.deepEqual(pub.activity.find((a) => a.machineId === 'm_pool').activeId, null);
  assert.equal(gatewayOf(pub).keys.find((k) => k.id === second).exhaustedAt, null);

  // Current report marks the first key exhausted.
  account.applyPoolReport('m_pool', { t: 'deepseek.pool', gateway: GW, revision: rev, activeId: first, keys: [{ id: first, exhaustedAt: 777 }] });
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys.find((k) => k.id === first).exhaustedAt, 777);
  assert.deepEqual(pub.activity.find((a) => a.machineId === 'm_pool').activeId, first);

  // An older revision must not clear it.
  account.applyPoolReport('m_stale', { t: 'deepseek.pool', gateway: GW, revision: rev - 1, activeId: first, keys: [{ id: first, exhaustedAt: null }] });
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys.find((k) => k.id === first).exhaustedAt, 777, 'the stale report did not clear the key');
  // The machine's last actual report is kept (with its revision), it just
  // cannot change key health.
  assert.equal(pub.activity.find((a) => a.machineId === 'm_stale')?.revision, rev - 1);

  // New report at a NEWER revision with an explicit null is a reset (a report at
  // the revision the exhaustion was recorded at, or an old one, is not); the
  // hub preferred active key is untouched.
  account.activateKey(GW, first);
  account.activateKey(GW, second);
  const rev2 = account.poolRevision(GW);
  assert.ok(rev2 > rev);
  account.applyPoolReport('m_pool', { t: 'deepseek.pool', gateway: GW, revision: rev2, activeId: first, keys: [{ id: first, exhaustedAt: null }] });
  pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys.find((k) => k.id === first).exhaustedAt, null);
  assert.equal(gatewayOf(pub).keys.find((k) => k.active).id, second, 'activity never rewrites the hub preferred key');

  // The machine's own active key is preferred when provisioning, but another
  // machine with no report uses the hub's preferred one.
  const calls = [];
  const rpc = async (machineId, op, args) => (calls.push({ machineId, args }), { ok: true, models: [] });
  await account.ensureProvider('m_pool', { rpc });
  assert.equal(calls.at(-1).args.pool.activeId, first);
  connect('m_fresh', { pool: 1 });
  await account.ensureProvider('m_fresh', { rpc });
  assert.equal(calls.at(-1).args.pool.activeId, second);

  // No whole key in the public account or the persisted report state.
  assert.ok(!scan(pub).includes(KEY1) && !scan(pub).includes(KEY2));
  assert.equal(fs.statSync(file()).mode & 0o077, 0);
});

test('every key exhausted is pool_exhausted (409, no secrets); a successful retry makes one usable again', async () => {
  connect('m_none', { pool: 1 });
  const pool = await keys(KEY1, KEY2);
  const at = Date.now();
  account.applyPoolReport('m_all', { t: 'deepseek.pool', gateway: GW, revision: pool.revision, activeId: pool.activeId, keys: pool.keys.map((k) => ({ id: k.id, exhaustedAt: at })) });
  await assert.rejects(account.ensureProvider('m_none', { rpc: async () => ({}) }), (e) => e.status === 409 && e.code === 'pool_exhausted' && !e.message.includes(KEY1) && !e.message.includes(KEY2));
  // The old single-key route says the same thing.
  await assert.rejects(account.ensureProvider('m_old_none', { rpc: async () => ({}) }), (e) => e.code === 'pool_exhausted');

  await account.retryKey(GW, pool.keys[1].id);
  const r = await account.ensureProvider('m_none', { rpc: async (id, op, args) => ({ ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`) }) });
  assert.equal(r.ok, true);
  assert.equal(gatewayOf(account.publicAccount()).keys.find((k) => k.active).id, pool.keys[1].id);
});

test('a runtime pool report changes activity, not what every computer provisions', async () => {
  account.reload();
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const calls = [];
  const rpc = async (machineId, op, args) => (calls.push({ machineId, op, args }), { ok: true, models: [] });
  connect('m_report_a', { pool: 1, rpc });
  connect('m_report_b', { pool: 1, rpc });
  await account.ensureProvider('m_report_a', { rpc });
  await account.ensureProvider('m_report_b', { rpc });
  assert.equal(calls.length, 2);
  calls.length = 0;

  // The connector reports its actual key and marks the other exhausted at the
  // current revision. Activity and key health move; the revision does not.
  const at = Date.now();
  assert.equal(account.applyPoolReport('m_report_a', { t: 'deepseek.pool', gateway: GW, revision: pool.revision, activeId: first, keys: [{ id: second, exhaustedAt: at }] }), true);
  const pub = account.publicAccount();
  assert.equal(gatewayOf(pub).keys.find((k) => k.id === second).exhaustedAt, at, 'the report did change key health');
  assert.equal(pub.activity.find((a) => a.machineId === 'm_report_a').activeId, first);

  assert.deepEqual(await account.reprovision({ rpc, list: () => [] }), [], 'no computer is made to provision again');
  assert.equal((await account.ensureProvider('m_report_b', { rpc })).cached, true);
  assert.equal(calls.length, 0, 'a runtime report is not a revision change');
});

// ------------------------------------------------- exhaustion and recovery
// Spec 13.1: an exhaustion is cleared only by a successful re-enable (a real
// request, not just /models) or by evidence newer than the exhaustion. A
// computer saying nothing about a key says nothing: it never clears one.

const exhaustedOf = (id) => account.poolOf(GW).keys.find((k) => k.id === id)?.exhaustedAt ?? null;
const report = (machineId, rev, keys, activeId = null) => account.applyPoolReport(machineId, { t: 'deepseek.pool', gateway: GW, revision: rev, activeId, keys });

test('another computer\'s healthy-looking report (same revision, no field for the key) never clears an exhaustion', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const rev = pool.revision;
  assert.equal(report('m_a', rev, [{ id: first, exhaustedAt: 5000 }, { id: second }], second), true);
  assert.equal(exhaustedOf(first), 5000);
  // Machine B never used the first key: its report lists every id with no news.
  report('m_b', rev, [{ id: first }, { id: second }], second);
  assert.equal(exhaustedOf(first), 5000, 'silence is not health');
  // Not even an explicit null at the same revision: nothing newer happened.
  report('m_b', rev, [{ id: first, exhaustedAt: null }, { id: second }], second);
  assert.equal(exhaustedOf(first), 5000, 'an explicit null at the revision of the exhaustion does not reset it either');
  // And the public projection agrees.
  assert.equal(gatewayOf(account.publicAccount()).keys.find((k) => k.id === first).exhaustedAt, 5000);
});

test('a real success after the exhaustion (recoveredAt) clears it; older or future proof does not', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const rev = pool.revision;
  const t = Date.now() - 60_000;
  report('m_a', rev, [{ id: first, exhaustedAt: t }, { id: second }], second);
  assert.equal(exhaustedOf(first), t);
  // Proof that predates the exhaustion proves nothing.
  report('m_b', rev, [{ id: first, recoveredAt: t - 1000, recoveredFrom: t - 5000 }], second);
  assert.equal(exhaustedOf(first), t);
  // Proof from the future (a wrong clock) is not believed either.
  report('m_b', rev, [{ id: first, recoveredAt: Date.now() + 3_600_000, recoveredFrom: t }], second);
  assert.equal(exhaustedOf(first), t);
  // A success after the exhaustion is the evidence.
  assert.equal(report('m_b', rev, [{ id: first, recoveredAt: t + 30_000, recoveredFrom: t }], first), true);
  assert.equal(exhaustedOf(first), null);
  assert.equal(account.poolOf(GW).keys.find((k) => k.id === first).retryAt, undefined);
  // Machines still reporting the old exhaustion (newer timestamp) win again.
  report('m_a', rev, [{ id: first, exhaustedAt: t + 40_000 }], second);
  assert.equal(exhaustedOf(first), t + 40_000);
  // The same recovery evidence arriving again is an old fact now.
  report('m_b', rev, [{ id: first, recoveredAt: t + 30_000, recoveredFrom: t }], first);
  assert.equal(exhaustedOf(first), t + 40_000, 'proof older than the newest exhaustion is ignored');
});

test('a newer revision with an explicit null is a reset; reports carry the gateway\'s reset time and the hub keeps the newest exhaustion', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const rev = pool.revision;
  report('m_a', rev, [{ id: first, exhaustedAt: 9000, retryAt: Date.now() + 7_200_000 }], second);
  assert.equal(account.poolOf(GW).keys.find((k) => k.id === first).retryAt > Date.now(), true);
  // An older exhaustion arriving late (another computer) does not overwrite.
  report('m_b', rev, [{ id: first, exhaustedAt: 8000 }], second);
  assert.equal(exhaustedOf(first), 9000);
  account.activateKey(GW, first);
  account.activateKey(GW, second);
  const rev2 = account.poolRevision(GW);
  assert.ok(rev2 > rev);
  report('m_a', rev2, [{ id: first, exhaustedAt: null }], second);
  assert.equal(exhaustedOf(first), null);
});

test('re-enabling a key makes a real small request: quota still gone keeps it exhausted, a completion clears it', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  report('m_a', pool.revision, [{ id: first, exhaustedAt: Date.now() }], second);
  asked.length = 0;
  chat.set(KEY1, quotaAnswer(402));
  const revBefore = account.poolRevision(GW);
  await assert.rejects(account.retryKey(GW, first), (e) => e.status === 409 && e.code === 'still_exhausted' && /額度|用盡/.test(e.message) && !e.message.includes(KEY1));
  assert.ok(exhaustedOf(first), 'the key stays exhausted');
  assert.equal(account.poolRevision(GW), revBefore, 'nothing changed');
  const probe = asked.find((a) => a.method === 'POST' && a.url === `/${GW}/chat/completions`);
  assert.ok(probe, 'a real chat request was made, not only /models');
  assert.equal(probe.auth, `Bearer ${KEY1}`);
  assert.equal(probe.body.stream, false);
  assert.ok(probe.body.max_tokens <= 32, 'a tiny request');
  assert.match(probe.body.model, /deepseek-v4\.1-flash/);

  // /models fine and still no quota: a rate limit is not recovery either.
  chat.set(KEY1, quotaAnswer(429, 'rate_limited'));
  await assert.rejects(account.retryKey(GW, first), (e) => e.status === 409);
  assert.ok(exhaustedOf(first));
  // A gateway error is not a "yes".
  chat.set(KEY1, (res) => ((res.statusCode = 503), res.end('{}')));
  await assert.rejects(account.retryKey(GW, first), (e) => e.status >= 400);
  assert.ok(exhaustedOf(first));

  chat.delete(KEY1);
  assert.equal(await account.retryKey(GW, first), true);
  assert.equal(exhaustedOf(first), null);
  assert.equal(account.poolOf(GW).activeId, first);
  assert.ok(account.poolRevision(GW) > revBefore);
  chat.clear();
});

test('every key exhausted: the error says when it retries by itself and how to recover now; once the wait is over the pool is used again', async () => {
  // Kimi's server is not up there: no automatic provision races this test.
  connect('m_wait', { pool: 1, status: { available: true, server: false } });
  const pool = await keys(KEY1, KEY2);
  const now = Date.now();
  report('m_all', pool.revision, pool.keys.map((k) => ({ id: k.id, exhaustedAt: now })));
  await assert.rejects(account.ensureProvider('m_wait', { rpc: async () => ({}) }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'pool_exhausted');
    assert.match(e.message, /設定/);
    assert.match(e.message, /重新啟用|新的 key|加入新/);
    assert.match(e.message, /自動(再試|重試)/, 'tells when it tries again by itself');
    assert.ok(e.retryAt > now, 'machine-readable next try');
    assert.ok(!e.message.includes(KEY1) && !e.message.includes(KEY2));
    return true;
  });
  // The wait is over (the exhaustion is an hour old): the main conversation is
  // not blocked. The pool goes to the connector with the exhaustion marks, and
  // the connector's next real request is the probe.
  const old = Date.now() - 3_600_000;
  for (const k of account.poolOf(GW).keys) k.exhaustedAt = old;
  const calls = [];
  const rpc = async (machineId, op, args) => (calls.push(args), { ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`) });
  const r = await account.ensureProvider('m_wait', { rpc });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].pool.keys.every((k) => k.exhaustedAt === old), 'exhaustion marks are sent, not hidden');
  assert.ok(calls[0].pool.retryMs >= 1000, 'the connector is told how long an exhausted key waits');
  // A gateway-named reset time keeps its key waiting past the default.
  for (const k of account.poolOf(GW).keys) k.retryAt = Date.now() + 3_600_000;
  await assert.rejects(account.ensureProvider('m_wait2', { rpc }), (e) => e.code === 'pool_exhausted');
  for (const k of account.poolOf(GW).keys) delete k.retryAt;
});

test('the public account shows each exhausted key\'s next automatic try and whether every key is out', async () => {
  const pool = await keys(KEY1, KEY2);
  const [first, second] = pool.keys.map((k) => k.id);
  const t = Date.now();
  report('m_a', pool.revision, [{ id: first, exhaustedAt: t }]);
  let go = gatewayOf(account.publicAccount());
  assert.equal(go.allExhausted, false);
  assert.ok(go.keys.find((k) => k.id === first).retryAt > t);
  assert.equal(go.keys.find((k) => k.id === second).retryAt, null);
  report('m_a', pool.revision, [{ id: second, exhaustedAt: t, retryAt: t + 5_000_000 }]);
  go = gatewayOf(account.publicAccount());
  assert.equal(go.allExhausted, true);
  assert.equal(go.nextRetryAt, go.keys.find((k) => k.id === first).retryAt, 'the earliest try among the exhausted keys');
  assert.equal(go.keys.find((k) => k.id === second).retryAt, t + 5_000_000);
});
