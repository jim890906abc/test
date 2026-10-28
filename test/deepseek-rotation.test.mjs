// The DeepSeek keys as ONE list used in one order across gateways (2026-10-28):
// a file from before it (one pool per gateway) becomes one list without losing
// or changing a key; a connector that can rotate across gateways gets every key
// in that order, each with its gateway, and the model's names at the other
// gateways; an older one keeps getting one gateway's keys. A person can mark a
// key full, clear a mark and move a key; a reset time is only ever a time a
// gateway stated. A local fake gateway answers the check requests. Nothing here
// reads a real key or leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-rotation-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const CC = 'commandcode';
const OCG = 'opencode-go';
const GO1 = 'sk-go-one-000000000001';
const GO2 = 'sk-go-two-000000000002';
const CC1 = 'sk-cc-single-0000000003';
const NEW1 = 'sk-new-added-00000000004';
// The file as an older Hub left it: one pool per gateway, Command Code the one
// in use, its key a bare string; Go has two keys, the second out of quota.
const OLD_FILE = {
  gateway: CC,
  keys: {
    [OCG]: {
      revision: 3,
      activeId: 'k_go2',
      keys: [
        { id: 'k_go1', key: GO1, addedAt: 1000 },
        { id: 'k_go2', key: GO2, addedAt: 2000, exhaustedAt: 5000 },
      ],
    },
    [CC]: CC1,
  },
  activity: {},
};
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'deepseek.json'), JSON.stringify(OLD_FILE, null, 2));
const BEFORE_BYTES = fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8');

let account;
let machines;
let gateway;
const chat = new Map(); // upstream key -> (res) => void
const file = () => path.join(DATA, 'deepseek.json');
const disk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const scan = (v) => JSON.stringify(v);
const ids = () => account.rotationEntries().map((e) => e.k.id);
const view = () => account.publicAccount().rotation.keys;
const ALL_KEYS = [GO1, GO2, CC1, NEW1];

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
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('an older file (one pool per gateway) becomes one list in its old order; no key is lost or changed', () => {
  // (The bare-string key is turned into a pool at load, as it always was; a file that
  // already has pools is not rewritten just to add the order: see account-files-durability.)
  assert.notEqual(BEFORE_BYTES, '', 'the fixture is the old shape');
  assert.equal(typeof JSON.parse(BEFORE_BYTES).keys[CC], 'string');
  // The gateway that was in use comes first; each gateway's keys keep their order.
  const entries = account.rotationEntries();
  assert.deepEqual(entries.map((e) => e.gw), [CC, OCG, OCG]);
  assert.deepEqual(entries.map((e) => e.k.key), [CC1, GO1, GO2], 'every key value is exactly the one that was saved');
  assert.deepEqual(entries.slice(1).map((e) => e.k.id), ['k_go1', 'k_go2'], 'ids that were saved are kept');
  assert.equal(entries[2].k.exhaustedAt, 5000, 'and so is a key already marked out');
  assert.equal(account.gateway(), CC, 'the gateway whose model names are used is unchanged');

  const pub = account.publicAccount();
  assert.deepEqual(pub.rotation.keys.map((k) => [k.position, k.gateway, k.gatewayLabel, k.hint, k.state]), [
    [1, CC, 'Command Code', CC1.slice(-4), 'ready'],
    [2, OCG, 'OpenCode Go', GO1.slice(-4), 'ready'],
    [3, OCG, 'OpenCode Go', GO2.slice(-4), 'exhausted'],
  ]);
  assert.equal(pub.rotation.activeId, entries[0].k.id, 'the first key not known to be out is the one in use');
  assert.equal(pub.rotation.allExhausted, false);
  // Per gateway the old view is still there.
  assert.deepEqual(pub.gateways.find((g) => g.id === OCG).keys.map((k) => k.id), ['k_go1', 'k_go2']);
  for (const k of ALL_KEYS) assert.ok(!scan(pub).includes(k), 'the public account never carries a key');
  assert.ok(account.rotationRevision() >= 3 + 1, 'the list has a revision at least as new as every pool in it');
  // What is on disk after the load has every key value from the old file, once each.
  const text = fs.readFileSync(file(), 'utf8');
  for (const k of [GO1, GO2, CC1]) assert.equal(text.split(k).length - 1, 1, `${k} is in the file once`);
  assert.deepEqual(disk().order, entries.map((e) => e.k.id));
});

test('a connector that can rotate across gateways gets every key in order with its gateway, and the names of the model at the other gateways', async () => {
  connect('m_cross', { pool: 1, capabilities: ['pool', 'pool_cross'] });
  const args = await provisionArgs('m_cross');
  assert.equal(args.gateway, CC, 'Kimi\'s provider is made from the model names of the gateway in use');
  assert.deepEqual(args.models.map((m) => m.model).slice(0, 2), ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-fast']);
  assert.equal(args.pool.rotation, 1);
  assert.equal(args.pool.revision, account.rotationRevision());
  assert.deepEqual(args.pool.keys.map((k) => [k.id, k.apiKey, k.gateway]), [
    [account.rotationEntries()[0].k.id, CC1, CC],
    ['k_go1', GO1, OCG],
    ['k_go2', GO2, OCG],
  ]);
  assert.equal(args.pool.keys[2].exhaustedAt, 5000, 'the exhaustion mark travels with the key');
  assert.equal(args.pool.keys[2].retryAt, undefined, 'and no reset time is made up for it');
  assert.equal(args.pool.activeId, args.pool.keys[0].id, 'it starts on the first key not known to be out');
  assert.deepEqual(args.pool.modelMap[OCG], { 'deepseek/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro': 'deepseek-v4-pro' }, 'only models with a counterpart of the same name');
  assert.equal(args.pool.modelMap[CC], undefined, 'no table for the gateway the names come from');
});

test('an older pool connector gets the keys of one gateway as before; an older one still gets one key', async () => {
  connect('m_pool_only', { pool: 1 });
  const poolArgs = await provisionArgs('m_pool_only');
  assert.equal(poolArgs.gateway, CC);
  assert.equal(poolArgs.pool.rotation, undefined);
  assert.deepEqual(poolArgs.pool.keys.map((k) => [k.apiKey, k.gateway]), [[CC1, undefined]], 'only the keys of its own gateway, no gateway field');
  assert.equal(poolArgs.pool.revision, account.poolRevision(CC));
  assert.equal(poolArgs.pool.modelMap, undefined);
  connect('m_ancient', {});
  const single = await provisionArgs('m_ancient');
  assert.deepEqual(Object.keys(single).sort(), ['apiKey', 'gateway', 'models']);
  assert.equal(single.apiKey, CC1);
});

test('a rotation report names the key it is on and marks keys of any gateway; the time in it is only what a gateway stated', () => {
  const rev = account.rotationRevision();
  const [ccKey, go1] = account.rotationEntries().map((e) => e.k);
  const stated = Date.now() + 2 * 3600_000;
  // Reported from a machine whose key in use is on OpenCode Go, about a Command Code key.
  assert.equal(account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: rev, activeId: go1.id, keys: [{ id: ccKey.id, exhaustedAt: Date.now(), retryAt: stated }] }), true);
  const cc = view()[0];
  assert.equal(cc.state, 'exhausted');
  assert.equal(cc.resetAt, stated);
  assert.equal(cc.expiryKnown, true);
  assert.deepEqual(account.publicAccount().activity.find((a) => a.machineId === 'm_cross'), { machineId: 'm_cross', machineName: 'm_cross', gateway: OCG, activeId: go1.id, revision: rev, rotation: true });
  // A report from before the list changed cannot undo anything.
  assert.equal(account.applyPoolReport('m_stale', { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: rev - 1, activeId: go1.id, keys: [{ id: ccKey.id, exhaustedAt: null }] }), true, 'its activity is kept');
  assert.equal(view()[0].state, 'exhausted');
  // An older-shape report about one gateway cannot touch another gateway's keys.
  account.applyPoolReport('m_old', { t: 'deepseek.pool', gateway: OCG, revision: account.poolRevision(OCG), activeId: go1.id, keys: [{ id: ccKey.id, exhaustedAt: 1 }] });
  assert.equal(view()[0].exhaustedAt, cc.exhaustedAt);
  // The key is out for real: the first not known to be out is the next one.
  assert.equal(account.publicAccount().rotation.activeId, go1.id);
  // Evidence that a real request worked after the exhaustion clears it.
  assert.equal(account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: rev, activeId: ccKey.id, keys: [{ id: ccKey.id, recoveredAt: cc.exhaustedAt + 1000, recoveredFrom: cc.exhaustedAt }] }), true);
  assert.equal(view()[0].state, 'ready');
  assert.equal(view()[0].resetAt, null);
});

test('an exhaustion without a stated time stays "unknown": no reset time is shown, and a short gap decides when a real request may look again', () => {
  const rev = account.rotationRevision();
  const ccKey = account.rotationEntries()[0].k;
  const t = Date.now();
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: rev, activeId: ccKey.id, keys: [{ id: ccKey.id, exhaustedAt: t }] });
  const v = view()[0];
  assert.equal(v.state, 'exhausted');
  assert.equal(v.resetAt, null, 'nothing is claimed about when it comes back');
  assert.equal(v.expiryKnown, false);
  assert.ok(v.retryAt > t && v.retryAt - t <= 60_000, `a real request may look again after a short gap: ${v.retryAt - t} ms`);
  assert.equal(account.retryMs(), 30_000, 'the gap is 30 seconds unless set, not minutes');
  // A stated time that has passed is just "due", no longer a claim.
  ccKey.retryAt = t - 1000;
  assert.equal(view()[0].expiryKnown, false);
  delete ccKey.exhaustedAt;
  delete ccKey.retryAt;
  delete ccKey.exhaustedRev;
});

test('marking a key full, clearing the mark, and moving a key: what a person says is kept, versioned and sent', async () => {
  const [first, second, third] = ids();
  let rev = account.rotationRevision();
  // Mark by hand.
  assert.equal(account.markFull(first), true);
  assert.equal(account.markFull(first), false, 'marking twice changes nothing');
  assert.ok(account.rotationRevision() > rev, 'a mark is a new version of the list');
  const m = view()[0];
  assert.deepEqual([m.state, m.manual, m.resetAt, m.retryAt, m.expiryKnown], ['manual', true, null, null, false]);
  assert.equal(account.publicAccount().rotation.activeId, second, 'the next key is in use');
  assert.throws(() => account.markFull('dk_nope'), (e) => e.status === 404);
  // It travels to a connector that can rotate; an older one never sees it.
  const cross = await provisionArgs('m_cross');
  assert.deepEqual([cross.pool.keys[0].manual, typeof cross.pool.keys[0].exhaustedAt, cross.pool.keys[0].retryAt], [true, 'number', undefined]);
  assert.equal(cross.pool.activeId, second);
  // A report cannot undo a person's mark (not "healthy by silence", not "recovered").
  const r = account.rotationRevision();
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: r, activeId: first, keys: [{ id: first, recoveredAt: Date.now() + 1000, recoveredFrom: m.exhaustedAt }] });
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: r + 1, activeId: first, keys: [{ id: first, exhaustedAt: null }] });
  assert.equal(view()[0].state, 'manual');
  // Clear it by hand: no request to the gateway, the key is simply fine again.
  rev = account.rotationRevision();
  assert.equal(account.clearMark(first), true);
  assert.equal(account.clearMark(first), false, 'a key that is not marked has nothing to clear');
  assert.ok(account.rotationRevision() > rev);
  assert.equal(view()[0].state, 'ready');
  assert.equal(account.publicAccount().rotation.activeId, first);
  // The same clearing works on an exhaustion a gateway reported.
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: account.rotationRevision(), activeId: second, keys: [{ id: first, exhaustedAt: Date.now() }] });
  assert.equal(view()[0].state, 'exhausted');
  assert.equal(account.clearMark(first), true);
  assert.equal(view()[0].state, 'ready');

  // Move.
  assert.equal(account.moveKey(second, 'up'), true);
  assert.deepEqual(ids(), [second, first, third]);
  assert.equal(account.moveKey(second, 'up'), false, 'already first');
  assert.equal(account.moveKey(third, 'top'), true);
  assert.deepEqual(ids(), [third, second, first]);
  assert.equal(account.moveKey(first, 'down'), false, 'already last');
  assert.equal(account.moveKey(third, 'down'), true);
  assert.deepEqual(ids(), [second, third, first]);
  assert.throws(() => account.moveKey(first, 'sideways'), (e) => e.status === 400);
  assert.throws(() => account.moveKey('dk_nope', 'up'), (e) => e.status === 404);
  const moved = await provisionArgs('m_cross');
  assert.deepEqual(moved.pool.keys.map((k) => k.id), [second, third, first], 'the connector gets the keys in the new order');
  assert.equal(moved.pool.activeId, second, 'and starts on the first one');
  // On disk too, and it survives a reload.
  assert.deepEqual(disk().order, [second, third, first]);
  account.reload();
  assert.deepEqual(ids(), [second, third, first]);
  assert.equal(fs.statSync(file()).mode & 0o077, 0, 'still private');
  account.moveKey(first, 'top');
  account.moveKey(third, 'down');
  assert.deepEqual(ids(), [first, second, third], 'back to the old order for the next tests');
});

test('an older connector never gets a key a person marked full, and never a made-up replacement', async () => {
  // Two Command Code keys; the first marked by hand.
  const extra = account.setKey(CC, NEW1);
  const mine = account.rotationEntries().find((e) => e.gw === CC && e.k.id !== extra).k.id;
  account.markFull(mine);
  const legacy = await provisionArgs('m_pool_only');
  assert.deepEqual(legacy.pool.keys.map((k) => k.id), [extra], 'the marked key is left out');
  assert.equal(legacy.pool.activeId, extra);
  account.clearMark(mine);
  account.removeKey(CC, extra);
  assert.ok(!ids().includes(extra), 'removing a key removes it from the order');
  assert.deepEqual(disk().order.filter((id) => id === extra), []);
});

test('a new key goes to the end of the order, and the very first key decides the gateway whose model names are used', () => {
  const before = ids();
  const id = account.setKey(OCG, NEW1);
  assert.deepEqual(ids(), [...before, id], 'added last: it is used when the keys before it are out');
  assert.equal(account.gateway(), CC, 'not the first key: the choice stays');
  assert.equal(view().at(-1).gateway, OCG);
  assert.ok(!scan(account.publicAccount()).includes(NEW1));
  account.removeKey(OCG, id);
  assert.deepEqual(ids(), before);
});

test('every key out: the error lists each key by gateway and last four characters with its state, says the earliest stated reset, and never shows a key', async () => {
  const [a, b, c] = ids();
  const stated = Date.now() + 3 * 3600_000;
  const rev = account.rotationRevision();
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: rev, activeId: a, keys: [{ id: a, exhaustedAt: Date.now(), retryAt: stated }, { id: b, exhaustedAt: Date.now() }] });
  account.markFull(c);
  await assert.rejects(account.ensureProvider('m_cross', { rpc: async () => ({}) }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'pool_exhausted');
    const lines = e.message.split('\n');
    assert.match(lines[0], /都已用盡（共 3 把）/);
    assert.match(lines[1], new RegExp(`^1\\. Command Code …${CC1.slice(-4)}：已滿，.*重置`), lines[1]);
    assert.match(lines[2], new RegExp(`^2\\. OpenCode Go …${GO1.slice(-4)}：已滿，重置時間未知`), lines[2]);
    assert.match(lines[3], new RegExp(`^3\\. OpenCode Go …${GO2.slice(-4)}：手動標記已滿`), lines[3]);
    assert.match(e.message, /最早已知的重置時間/);
    assert.match(e.message, /自動再試/);
    assert.match(e.message, /重新啟用|清除標記|新的 key/);
    assert.ok(e.retryAt > Date.now() && e.retryAt < stated, 'the next time a real request may look again: the unknown-expiry key, not the stated one');
    for (const k of ALL_KEYS) assert.ok(!e.message.includes(k), 'no key value in the error');
    return true;
  });
  // Only marks left: nothing will retry by itself, and it says so.
  account.clearMark(a);
  account.markFull(a);
  account.markFull(b);
  await assert.rejects(account.ensureProvider('m_cross', { rpc: async () => ({}) }), (e) => e.code === 'pool_exhausted' && e.retryAt === undefined && /手動標記/.test(e.message));
  // One mark cleared by hand: a connector can be given the pool again, and a real request finds out.
  account.clearMark(b);
  const back = await provisionArgs('m_cross');
  assert.equal(back.pool.activeId, b);
  for (const id of ids()) account.clearMark(id);
});

test('once a stated reset time has passed, the pool is usable again without anyone saying so: the next real request is the check', async () => {
  const keys = account.rotationEntries().map((e) => e.k);
  const past = Date.now() - 5000;
  const rev = account.rotationRevision();
  account.applyPoolReport('m_cross', { t: 'deepseek.pool', gateway: CC, rotation: 1, revision: rev, activeId: keys[0].id, keys: keys.map((k) => ({ id: k.id, exhaustedAt: Date.now() - 60_000, retryAt: Date.now() + 100 })) });
  assert.equal(account.publicAccount().rotation.allExhausted, true);
  await new Promise((r) => setTimeout(r, 150));
  const args = await provisionArgs('m_cross');
  assert.ok(args.pool.keys.every((k) => k.exhaustedAt), 'the marks are still sent: nothing is cleared on a guess');
  assert.ok(args.pool.keys.every((k) => k.retryAt < Date.now()), 'but their stated time is over, so a request may use them');
  assert.ok(past < Date.now());
  for (const k of keys) account.clearMark(k.id);
});

test('re-enabling a key with a real request lifts a person\'s mark too, and a refusal leaves it', async () => {
  const [a] = ids();
  account.markFull(a);
  chat.set(CC1, (res) => ((res.statusCode = 402), res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'x' } }))));
  await assert.rejects(account.retryKey(CC, a), (e) => e.code === 'still_exhausted');
  assert.equal(view()[0].state, 'manual', 'the gateway still says no: the mark stays');
  chat.delete(CC1);
  assert.equal(await account.retryKey(CC, a), true);
  assert.equal(view()[0].state, 'ready');
  assert.equal(view()[0].manual, false);
});

test('the key file keeps every key and the order across a reload, 0600, and holds nothing a page could see', () => {
  const written = disk();
  for (const k of [GO1, GO2, CC1]) assert.ok(scan(written).includes(k), 'the file keeps the keys');
  assert.deepEqual(written.order.sort(), ids().sort());
  account.reload();
  assert.deepEqual(account.rotationEntries().map((e) => e.k.key).sort(), [CC1, GO1, GO2].sort());
  for (const k of ALL_KEYS) assert.ok(!scan(account.publicAccount()).includes(k));
  assert.equal(fs.statSync(file()).mode & 0o077, 0);
});

test('the first key there is, on any gateway, decides whose model names are used', () => {
  for (const gw of Object.keys(account.GATEWAYS)) account.clearKey(gw);
  account.setSettings({ gateway: OCG });
  assert.equal(account.gateway(), OCG);
  account.setKey(CC, CC1);
  assert.equal(account.gateway(), CC, 'the only key is a Command Code one: its names are used, not a gateway with no key');
  account.setKey(OCG, GO1);
  assert.equal(account.gateway(), CC, 'a later key does not change it');
  assert.equal(account.apiKey() !== '', true);
});
