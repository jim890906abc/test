// The DeepSeek keys as one list across gateways, through the real Hub's API: add
// keys on two gateways without changing whose model names are used, see them in
// one order with their gateway and state, mark one full / clear the mark / move
// one, and watch a connector that can rotate be given the whole list. A fake
// gateway answers both gateways; a scripted machine plays the connector. No key
// is ever sent back by the API or the live stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-rot-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 30000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ds-rot-token';
const MID = 'm_rot';
const KEY_GO = 'sk-rot-go-0123456789wxyz';
const KEY_CC = 'sk-rot-cc-0123456789abcd';
const KEY_CC2 = 'sk-rot-cc-second-0123456789ef';
const ALL = [KEY_GO, KEY_CC, KEY_CC2];
let hub;
let machine;
let gateway;
const gatewayCalls = [];

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const noKeys = (what, value) => {
  const text = JSON.stringify(value);
  for (const k of ALL) assert.ok(!text.includes(k), `${what} carries a key`);
};

function fakeGateway() {
  return http.createServer((req, res) => {
    gatewayCalls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    req.resume();
    if (!ALL.some((k) => req.headers.authorization === `Bearer ${k}`)) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'kimi-k2' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
    if (req.url === '/commandcode/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4-pro' }, { id: 'deepseek/deepseek-v4.1-flash-fast' }] }));
    res.statusCode = 404;
    res.end('{}');
  });
}

// The connector: says what it can do, keeps the provisions it was sent.
function fakeMachine(key, capabilities) {
  const k = { provisioned: [], removed: 0 };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  k.report = (msg) => send({ t: 'deepseek.pool', ...msg });
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'rot-machine', platform: 'test', bridgeVersion: '0.12.0', home: '/home/fake', pool: 1, capabilities, status });
    send({ t: 'kimi.sessions', items: [] });
  });
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t !== 'req') return;
    let out = { ok: true };
    if (m.op === 'kimi.status' || m.op === 'kimi.start') out = status;
    else if (m.op === 'kimi.request') out = { code: 0, msg: 'ok', data: m.args?.path === '/api/v1/models' ? { items: [] } : {} };
    else if (m.op === 'kimi.deepseek.provision') {
      k.provisioned.push(m.args);
      out = { ok: true, created: true, models: m.args.models.map((x) => `agent-hub-deepseek/${x.model}`), sessionHeader: true };
    } else if (m.op === 'kimi.deepseek.remove') {
      k.removed++;
      out = { ok: true, removed: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  k.last = () => k.provisioned.at(-1);
  return k;
}

before(async () => {
  gateway = fakeGateway();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${gateway.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start:\n${out}`)), 15000);
    const on = (d) => {
      out += d;
      if (out.includes('已啟動')) (clearTimeout(t), resolve());
    };
    hub.stdout.on('data', on);
    hub.stderr.on('data', on);
  });
  const key = JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey;
  machine = fakeMachine(key, ['pool', 'pool_cross', 'secondary_model', 'handoff']);
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'machine online');
});

after(() => {
  machine?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const rotation = async () => (await api('GET', '/deepseek')).rotation;
const settled = async (n) => until(async () => machine.provisioned.length > n && machine.last(), 8000, 'a provision');

test('keys on two gateways are one list in the order they were added; adding to a gateway does not change whose model names are used', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const events = [];
  ws.on('message', (d) => {
    try {
      events.push(JSON.parse(d));
    } catch {}
  });
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)));

  const one = await api('PUT', '/deepseek', { apiKey: KEY_GO });
  assert.equal(one.gateway, 'opencode-go');
  const two = await api('PUT', '/deepseek', { keyGateway: 'commandcode', apiKey: KEY_CC });
  assert.equal(two.gateway, 'opencode-go', 'the key went to Command Code, the model names stayed');
  noKeys('PUT answer', two);
  assert.deepEqual(two.rotation.keys.map((k) => [k.position, k.gateway, k.gatewayLabel, k.state, k.active]), [
    [1, 'opencode-go', 'OpenCode Go', 'ready', true],
    [2, 'commandcode', 'Command Code', 'ready', false],
  ]);
  assert.deepEqual(two.rotation.keys.map((k) => k.hint), [KEY_GO.slice(-4), KEY_CC.slice(-4)]);
  assert.ok(gatewayCalls.some((c) => c.url === '/commandcode/models' && c.auth === `Bearer ${KEY_CC}`), 'the key was checked at its own gateway');

  // The connector that can rotate is given both, in order, with their gateways.
  await until(async () => machine.provisioned.some((p) => p.pool?.keys?.length === 2), 8000, 'a provision with both keys');
  const args = machine.provisioned.findLast((p) => p.pool?.keys?.length === 2);
  assert.equal(args.gateway, 'opencode-go');
  assert.equal(args.pool.rotation, 1);
  assert.deepEqual(args.pool.keys.map((k) => [k.apiKey, k.gateway]), [[KEY_GO, 'opencode-go'], [KEY_CC, 'commandcode']]);
  assert.equal(args.pool.activeId, args.pool.keys[0].id);
  assert.deepEqual(args.pool.modelMap.commandcode, { 'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash', 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' });

  // The page hears about it without a key; /config does not carry one either.
  await until(async () => events.some((m) => m.t === 'deepseek' && m.account.rotation?.keys.length === 2), 5000, 'broadcast');
  noKeys('live stream', events.filter((m) => m.t === 'deepseek'));
  noKeys('config', await api('GET', '/config'));
  ws.close();
});

test('a connector reports a key out on its gateway; the reset time shown is the one it passed on, and a key without one is "unknown"', async () => {
  const before = await rotation();
  const [go, cc] = before.keys;
  const stated = Date.now() + 2 * 3600_000;
  machine.report({ gateway: 'commandcode', rotation: 1, activeId: go.id, revision: before.revision, keys: [{ id: cc.id, exhaustedAt: Date.now(), retryAt: stated }] });
  await until(async () => (await rotation()).keys[1].state === 'exhausted', 5000, 'exhaustion report');
  let r = await rotation();
  assert.deepEqual([r.keys[1].resetAt, r.keys[1].expiryKnown], [stated, true]);
  machine.report({ gateway: 'commandcode', rotation: 1, activeId: go.id, revision: r.revision, keys: [{ id: go.id, exhaustedAt: Date.now() }] });
  await until(async () => (await rotation()).keys[0].state === 'exhausted', 5000, 'second exhaustion report');
  r = await rotation();
  assert.deepEqual([r.keys[0].resetAt, r.keys[0].expiryKnown], [null, false], 'no time is made up for a key whose gateway named none');
  assert.equal(r.allExhausted, true);
  assert.equal(r.nextResetAt, stated);
  const acc = await api('GET', '/deepseek');
  assert.deepEqual(acc.activity.find((a) => a.machineId === MID), { machineId: MID, machineName: 'rot-machine', gateway: 'commandcode', activeId: go.id, revision: r.revision, rotation: true });
  // A person says they are fine: no request to the gateway, a new version of the list.
  for (const key of r.keys) await api('PUT', '/deepseek', { clearMarkKeyId: key.id });
  r = await rotation();
  assert.deepEqual(r.keys.map((k) => k.state), ['ready', 'ready']);
  assert.ok(r.revision > before.revision);
});

test('mark full, clear the mark and move: each is one operation by key id, and the connector is given the result', async () => {
  const [go, cc] = (await rotation()).keys;
  let n = machine.provisioned.length;
  const marked = await api('PUT', '/deepseek', { markFullKeyId: go.id });
  assert.deepEqual(marked.rotation.keys.map((k) => [k.state, k.manual]), [['manual', true], ['ready', false]]);
  assert.equal(marked.rotation.activeId, cc.id);
  let sent = await settled(n);
  assert.deepEqual([sent.pool.keys[0].manual, sent.pool.keys[0].retryAt, typeof sent.pool.keys[0].exhaustedAt], [true, undefined, 'number']);
  assert.equal(sent.pool.activeId, cc.id);

  n = machine.provisioned.length;
  const moved = await api('PUT', '/deepseek', { moveKeyId: cc.id, direction: 'top' });
  assert.deepEqual(moved.rotation.keys.map((k) => k.id), [cc.id, go.id]);
  sent = await settled(n);
  assert.deepEqual(sent.pool.keys.map((k) => k.id), [cc.id, go.id], 'the connector gets the new order');
  assert.equal((await api('PUT', '/deepseek', { moveKeyId: cc.id, direction: 'up' })).rotation.keys[0].id, cc.id, 'moving the first up changes nothing and is not an error');

  n = machine.provisioned.length;
  const cleared = await api('PUT', '/deepseek', { clearMarkKeyId: go.id });
  assert.deepEqual(cleared.rotation.keys.map((k) => k.state), ['ready', 'ready']);
  sent = await settled(n);
  assert.ok(sent.pool.keys.every((k) => !k.exhaustedAt));
  noKeys('the answers', [marked, moved, cleared]);
});

test('the operations are strict: one at a time, only known fields, real key ids; a key is tested at its own gateway', async () => {
  const keys = (await rotation()).keys;
  const [a, b] = keys;
  const cc = keys.find((k) => k.gateway === 'commandcode');
  await assert.rejects(api('PUT', '/deepseek', { markFullKeyId: a.id, moveKeyId: b.id }), (e) => e.status === 400 && /一次只能/.test(e.message));
  await assert.rejects(api('PUT', '/deepseek', { direction: 'up' }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { moveKeyId: a.id, direction: 'sideways' }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { markFullKeyId: 'dk_nope' }), (e) => e.status === 404);
  await assert.rejects(api('PUT', '/deepseek', { clearMarkKeyId: 5 }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { keyGateway: 'nope', apiKey: KEY_CC2 }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { markFullKeyId: a.id, secret: 'x' }), (e) => e.status === 400 && /不支援的欄位/.test(e.message));
  const calls = gatewayCalls.length;
  const t = await api('POST', '/deepseek/test', { keyId: cc.id });
  assert.equal(t.ok, true);
  assert.ok(gatewayCalls.slice(calls).some((c) => c.url === '/commandcode/models' && c.auth === `Bearer ${KEY_CC}`), 'the test went to the gateway the key belongs to, with no gateway given');
});

test('removing a key by id leaves the order whole and the others untouched; the file holds the order', async () => {
  const added = await api('PUT', '/deepseek', { keyGateway: 'commandcode', apiKey: KEY_CC2 });
  assert.equal(added.rotation.keys.length, 3);
  assert.equal(added.rotation.keys[2].gateway, 'commandcode', 'a new key goes last');
  const [first, second, third] = added.rotation.keys;
  const removed = await api('PUT', '/deepseek', { removeKeyId: second.id });
  assert.deepEqual(removed.rotation.keys.map((k) => k.id), [first.id, third.id]);
  const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8'));
  assert.deepEqual(disk.order, [first.id, third.id]);
  assert.equal(fs.statSync(path.join(DATA, 'deepseek.json')).mode & 0o077, 0);
  noKeys('the answer', removed);
});
