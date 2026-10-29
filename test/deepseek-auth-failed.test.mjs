// A DeepSeek key its gateway refuses with HTTP 401 (2026-10-29), on the Hub's side.
// The connector sets such a key aside as "refused" with its own fields
// (authFailedAt, authFailures, authRetryAt) - never as "exhausted", and with no
// reset time, because a 401 says nothing about when a key might work again. The
// Hub keeps and shows that state apart from quota, sends it to a connector that
// says it understands it (`pool_auth`) and to no other, lists refused keys apart
// from keys out of quota when nothing is usable, and lets a person clear it.
// A local fake gateway answers the check requests. Nothing here reads a real key
// or leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-auth-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const CC = 'commandcode';
const OCG = 'opencode-go';
const GO1 = 'sk-go-one-000000000001';
const GO2 = 'sk-go-two-000000000002';
const CC1 = 'sk-cc-single-0000000003';
const ALL_KEYS = [GO1, GO2, CC1];
const MIN = 60_000;
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'deepseek.json'),
  JSON.stringify({
    gateway: CC,
    keys: {
      [CC]: { revision: 2, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: CC1, addedAt: 500 }] },
      [OCG]: {
        revision: 3,
        activeId: 'k_go1',
        keys: [
          { id: 'k_go1', key: GO1, addedAt: 1000 },
          { id: 'k_go2', key: GO2, addedAt: 2000 },
        ],
      },
    },
    order: ['k_cc1', 'k_go1', 'k_go2'],
    activity: {},
  }),
  { mode: 0o600 },
);

let account;
let machines;
let gateway;
const chat = new Map(); // upstream key -> (res) => void
const file = () => path.join(DATA, 'deepseek.json');
const disk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const scan = (v) => JSON.stringify(v);
const view = () => account.publicAccount().rotation.keys;
const viewOf = (id) => view().find((k) => k.id === id);
const report = (keys, over = {}) =>
  account.applyPoolReport('m_auth', { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: account.rotationRevision(), activeId: 'k_go1', keys, ...over });
// What the key file holds for a key: one state at a time, no leftovers of the other.
const stored = (id) => Object.values(disk().keys).flatMap((p) => p.keys).find((k) => k.id === id);
const clearAll = () => {
  for (const e of account.rotationEntries()) account.clearMark(e.k.id);
};

function connect(machineId, extra = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '0.12.0', status: { available: true, server: false }, ...extra }));
}
const provisionArgs = async (machineId) => {
  let seen;
  await account.ensureProvider(machineId, { rpc: async (id, op, args) => ((seen = args), { ok: true, models: [] }) });
  return seen;
};

before(async () => {
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) return (chat.get(key) || ((r) => r.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))))(res);
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4.1-flash' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${gateway.address().port}`;
  account = await import('../server/deepseek-account.js');
  machines = await import('../server/machines.js');
  connect('m_auth', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth'] });
  connect('m_cross', { pool: 1, capabilities: ['pool', 'pool_cross'] });
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a connector reports a refused key: the Hub shows it as refused, with the time of the failure and of the next real try, and no reset time', () => {
  const failedAt = Date.now() - 5000;
  assert.equal(report([{ id: 'k_cc1', authFailedAt: failedAt, authFailures: 2, authRetryAt: failedAt + 2 * MIN }]), true);
  const k = viewOf('k_cc1');
  assert.equal(k.state, 'auth_failed');
  assert.equal(k.authFailed, true);
  assert.equal(k.authFailedAt, failedAt);
  assert.equal(k.authFailures, 2);
  assert.equal(k.authRetryAt, failedAt + 2 * MIN, 'the connector\'s own schedule');
  assert.equal(k.retryAt, failedAt + 2 * MIN, 'when a real request may look at it again');
  assert.deepEqual([k.exhaustedAt, k.resetAt, k.expiryKnown, k.manual], [null, null, false, false], 'it is not exhausted and nobody stated a reset time');
  assert.equal(viewOf('k_go1').authFailed, false);
  assert.equal(viewOf('k_go1').authFailedAt, null);
  // The one in use is the first key that is not out.
  assert.equal(account.publicAccount().rotation.activeId, 'k_go1');
  assert.equal(account.publicAccount().rotation.allExhausted, false);
  // The same report again changes nothing.
  assert.equal(report([{ id: 'k_cc1', authFailedAt: failedAt, authFailures: 2, authRetryAt: failedAt + 2 * MIN }]), false);
  // And the page-side numbers of the gateway view agree.
  const g = account.publicAccount().gateways.find((x) => x.id === CC);
  assert.equal(g.keys[0].authFailed, true);
  for (const key of ALL_KEYS) assert.ok(!scan(account.publicAccount()).includes(key), 'no key on the page');
  clearAll();
});

test('a refusal with no schedule is given the connector\'s own: 1 minute, doubling, 60 minutes at most', () => {
  const at = Date.now() - 1000;
  for (const [failures, gap] of [[1, MIN], [2, 2 * MIN], [3, 4 * MIN], [6, 32 * MIN], [7, 60 * MIN], [30, 60 * MIN]]) {
    clearAll();
    assert.equal(report([{ id: 'k_cc1', authFailedAt: at, authFailures: failures }]), true);
    assert.equal(viewOf('k_cc1').authRetryAt, at + gap, `after ${failures} refusals`);
  }
  // Nonsense counts and schedules are not believed.
  clearAll();
  report([{ id: 'k_cc1', authFailedAt: at, authFailures: 'many', authRetryAt: at + 99 * 60 * MIN }]);
  assert.equal(viewOf('k_cc1').authFailures, 1);
  assert.equal(viewOf('k_cc1').authRetryAt, at + MIN, 'a schedule longer than the longest gap is replaced');
  clearAll();
});

test('refused and exhausted are one state at a time: whichever a connector saw last stands, an older word cannot undo a newer one', () => {
  clearAll();
  const t = Date.now() - 60_000;
  assert.equal(report([{ id: 'k_go2', exhaustedAt: t }]), true);
  assert.equal(viewOf('k_go2').state, 'exhausted');
  // Refused later: the key is now refused, and the old exhaustion is gone (not shown beside it).
  assert.equal(report([{ id: 'k_go2', authFailedAt: t + 1000, authFailures: 1 }]), true);
  let k = viewOf('k_go2');
  assert.deepEqual([k.state, k.exhaustedAt, k.resetAt, k.authFailedAt], ['auth_failed', null, null, t + 1000]);
  // An exhaustion older than the refusal is ignored.
  assert.equal(report([{ id: 'k_go2', exhaustedAt: t }]), false);
  assert.equal(viewOf('k_go2').state, 'auth_failed');
  // Exhausted later still: back to quota, and the refusal is gone.
  assert.equal(report([{ id: 'k_go2', exhaustedAt: t + 5000, retryAt: Date.now() + 3600_000 }]), true);
  k = viewOf('k_go2');
  assert.deepEqual([k.state, k.authFailed, k.authFailedAt, k.authRetryAt, k.expiryKnown], ['exhausted', false, null, null, true]);
  assert.deepEqual([stored('k_go2').authFailedAt, stored('k_go2').authFailures, stored('k_go2').authRetryAt], [undefined, undefined, undefined], 'nothing of the refusal is left in the file');
  // A refusal older than the exhaustion is ignored.
  assert.equal(report([{ id: 'k_go2', authFailedAt: t + 1000, authFailures: 1 }]), false);
  assert.equal(viewOf('k_go2').state, 'exhausted');
  clearAll();
});

test('a successful real request after a refusal clears it; proof from before it, or from the future, does not', () => {
  clearAll();
  const failedAt = Date.now() - 10_000;
  report([{ id: 'k_go1', authFailedAt: failedAt, authFailures: 1 }]);
  assert.equal(viewOf('k_go1').state, 'auth_failed');
  assert.equal(report([{ id: 'k_go1', recoveredAt: failedAt - 1, recoveredFrom: failedAt }]), false, 'older than the failure');
  assert.equal(report([{ id: 'k_go1', recoveredAt: Date.now() + 3600_000, recoveredFrom: failedAt }]), false, 'a clock that is wrong is not evidence');
  assert.equal(viewOf('k_go1').state, 'auth_failed');
  assert.equal(report([{ id: 'k_go1', recoveredAt: failedAt + 1000, recoveredFrom: failedAt }]), true);
  const k = viewOf('k_go1');
  assert.deepEqual([k.state, k.authFailedAt, k.authFailures, k.authRetryAt, k.retryAt], ['ready', null, null, null, null]);
  // Silence about a refused key is not "healthy".
  report([{ id: 'k_go1', authFailedAt: failedAt + 2000, authFailures: 1 }]);
  report([{ id: 'k_go1' }]);
  assert.equal(viewOf('k_go1').state, 'auth_failed', 'a report with no news changes nothing');
  clearAll();
});

test('a person marks a refused key full or clears it; their mark is never undone by a report', () => {
  clearAll();
  const failedAt = Date.now() - 1000;
  report([{ id: 'k_go1', authFailedAt: failedAt, authFailures: 3 }]);
  // Clear: no request to the gateway, a new version of the list, nothing of the refusal left.
  let rev = account.rotationRevision();
  assert.equal(account.clearMark('k_go1'), true);
  assert.ok(account.rotationRevision() > rev);
  assert.equal(viewOf('k_go1').state, 'ready');
  assert.deepEqual(Object.keys(disk().keys[OCG].keys.find((k) => k.id === 'k_go1')).filter((f) => /^auth|exhausted|retry/.test(f)), []);
  assert.equal(account.clearMark('k_go1'), false, 'nothing left to clear');
  // Mark by hand a key that is refused: it is the person's mark now, and the refusal is gone.
  report([{ id: 'k_go1', authFailedAt: failedAt, authFailures: 3 }]);
  assert.equal(account.markFull('k_go1'), true);
  const m = viewOf('k_go1');
  assert.deepEqual([m.state, m.manual, m.authFailed, m.authFailedAt, m.retryAt], ['manual', true, false, null, null]);
  assert.deepEqual([stored('k_go1').authFailedAt, stored('k_go1').authFailures, stored('k_go1').authRetryAt], [undefined, undefined, undefined], 'nothing of the refusal is left in the file');
  // Reports - refusal, exhaustion, recovery - cannot touch it.
  report([{ id: 'k_go1', authFailedAt: Date.now(), authFailures: 1 }]);
  report([{ id: 'k_go1', recoveredAt: Date.now(), recoveredFrom: failedAt }]);
  assert.equal(viewOf('k_go1').state, 'manual');
  assert.equal(account.clearMark('k_go1'), true);
  clearAll();
});

test('the refusal is kept in the key file and survives a reload; the file has nothing about it for a key that is fine', () => {
  clearAll();
  const failedAt = Date.now() - 1000;
  report([{ id: 'k_cc1', authFailedAt: failedAt, authFailures: 4, authRetryAt: failedAt + 8 * MIN }]);
  const written = disk().keys[CC].keys[0];
  assert.deepEqual([written.authFailedAt, written.authFailures, written.authRetryAt, written.exhaustedAt], [failedAt, 4, failedAt + 8 * MIN, undefined]);
  const fine = disk().keys[OCG].keys[0];
  assert.deepEqual(Object.keys(fine).sort(), ['addedAt', 'id', 'key']);
  account.reload();
  const k = viewOf('k_cc1');
  assert.deepEqual([k.state, k.authFailedAt, k.authFailures, k.authRetryAt], ['auth_failed', failedAt, 4, failedAt + 8 * MIN]);
  assert.equal(fs.statSync(file()).mode & 0o077, 0, 'still private');
  clearAll();
});

test('a connector that understands refused keys is sent them with the key; one that does not gets the key as it always did', async () => {
  clearAll();
  const failedAt = Date.now() - 5000;
  report([{ id: 'k_cc1', authFailedAt: failedAt, authFailures: 2 }]);
  const mine = await provisionArgs('m_auth');
  const cc = mine.pool.keys.find((k) => k.id === 'k_cc1');
  assert.deepEqual([cc.authFailedAt, cc.authFailures, cc.exhaustedAt, cc.retryAt, cc.manual], [failedAt, 2, undefined, undefined, undefined], 'its own fields, not an exhaustion');
  assert.equal(cc.apiKey, CC1);
  assert.equal(mine.pool.activeId, 'k_go1', 'it starts on the first key that is not out');
  assert.ok(mine.pool.keys.filter((k) => k.id !== 'k_cc1').every((k) => !('authFailedAt' in k)));
  const other = await provisionArgs('m_cross');
  const ccOld = other.pool.keys.find((k) => k.id === 'k_cc1');
  assert.deepEqual(Object.keys(ccOld).sort(), ['apiKey', 'gateway', 'id'], 'a connector that cannot read the fields is not given them');
  assert.equal(other.pool.activeId, 'k_go1', 'but is still not started on a key the Hub knows is refused');
  clearAll();
});

test('a refused key whose next try has come is usable again for a provision; one whose time has not is not', async () => {
  clearAll();
  const now = Date.now();
  // Every key refused and not due: nothing to provision, and the answer says why.
  report([
    { id: 'k_cc1', authFailedAt: now - 5000, authFailures: 1 },
    { id: 'k_go1', authFailedAt: now - 5000, authFailures: 1 },
    { id: 'k_go2', authFailedAt: now - 5000, authFailures: 1 },
  ]);
  const pub = account.publicAccount();
  assert.equal(pub.rotation.allExhausted, true, 'every key is out of use');
  assert.equal(pub.gateways.find((g) => g.id === OCG).allExhausted, true);
  assert.equal(pub.gateways.find((g) => g.id === OCG).nextRetryAt, now - 5000 + MIN);
  await assert.rejects(account.ensureProvider('m_auth', { rpc: async () => ({}) }), (e) => {
    assert.equal(e.code, 'pool_exhausted');
    assert.ok(Math.abs(e.retryAt - (now - 5000 + MIN)) < 1000, 'the next real try is the probe time');
    return true;
  });
  // A minute later (here: a refusal long ago) the probe is allowed through.
  clearAll();
  report([
    { id: 'k_cc1', authFailedAt: now - 5 * MIN, authFailures: 1 },
    { id: 'k_go1', authFailedAt: now - 5 * MIN, authFailures: 1 },
    { id: 'k_go2', authFailedAt: now - 5 * MIN, authFailures: 1 },
  ]);
  const args = await provisionArgs('m_auth');
  assert.ok(args.pool.keys.every((k) => k.authFailedAt), 'the refusals still go with the keys: nothing is cleared on a guess');
  assert.equal(args.pool.activeId, 'k_cc1', 'the first key whose time has come');
  clearAll();
});

test('every key unusable: refused keys, keys out of quota and keys marked by hand are counted and listed apart, and no key value shows', async () => {
  clearAll();
  const now = Date.now();
  report([{ id: 'k_cc1', authFailedAt: now - 5000, authFailures: 1 }, { id: 'k_go1', exhaustedAt: now - 1000 }]);
  account.markFull('k_go2');
  await assert.rejects(account.ensureProvider('m_auth', { rpc: async () => ({}) }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'pool_exhausted');
    const lines = e.message.split('\n');
    assert.match(lines[0], /都不能用（共 3 把）/, e.message);
    assert.match(lines[0], /認證失敗（HTTP 401）1 把/);
    assert.match(lines[0], /額度用完 1 把/);
    assert.match(lines[0], /手動標記已滿 1 把/);
    assert.match(lines[1], new RegExp(`^1\\. Command Code …${CC1.slice(-4)}：認證失敗（HTTP 401）`), lines[1]);
    assert.match(lines[2], new RegExp(`^2\\. OpenCode Go …${GO1.slice(-4)}：已滿，重置時間未知`), lines[2]);
    assert.match(lines[3], new RegExp(`^3\\. OpenCode Go …${GO2.slice(-4)}：手動標記已滿`), lines[3]);
    assert.match(lines[1], /不是供應商給的重置時間/, 'the refused key\'s time is said to be ours');
    assert.doesNotMatch(lines[1].replace('不是供應商給的重置時間', ''), /重置/, 'and no reset time is given for it');
    assert.match(e.message, /重新啟用|清除標記/);
    assert.ok(e.retryAt > now - 1000, 'the next time a real request may look again');
    for (const k of ALL_KEYS) assert.ok(!e.message.includes(k), 'no key value in the error');
    return true;
  });
  // With no refused key the message is the one it always was.
  clearAll();
  report([{ id: 'k_cc1', exhaustedAt: now - 1000 }, { id: 'k_go1', exhaustedAt: now - 1000 }, { id: 'k_go2', exhaustedAt: now - 1000 }]);
  await assert.rejects(account.ensureProvider('m_auth', { rpc: async () => ({}) }), (e) => {
    assert.match(e.message.split('\n')[0], /^DeepSeek 的 API key 都已用盡（共 3 把）/);
    assert.doesNotMatch(e.message, /認證失敗/);
    return true;
  });
  clearAll();
});

test('re-enabling a refused key with a real request clears it when the gateway accepts the key, and leaves it when it still refuses', async () => {
  clearAll();
  report([{ id: 'k_go1', authFailedAt: Date.now() - 1000, authFailures: 5 }]);
  chat.set(GO1, (res) => ((res.statusCode = 401), res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'no' } }))));
  await assert.rejects(account.retryKey(OCG, 'k_go1'), (e) => e.code === 'key_refused');
  assert.equal(viewOf('k_go1').state, 'auth_failed', 'still refused: the mark stays');
  chat.delete(GO1);
  assert.equal(await account.retryKey(OCG, 'k_go1'), true);
  const k = viewOf('k_go1');
  assert.deepEqual([k.state, k.authFailedAt, k.authFailures, k.authRetryAt], ['ready', null, null, null]);
  assert.equal(account.publicAccount().rotation.activeId, 'k_cc1');
  clearAll();
});
