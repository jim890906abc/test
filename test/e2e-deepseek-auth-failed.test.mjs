// A DeepSeek key the gateway refuses (HTTP 401) through the real Hub's API: a
// connector that says `pool_auth` reports one, the settings answer and the live
// stream show it as refused (not exhausted, no reset time), a person clears it
// with the same "clear the mark" operation as any other mark and the connector is
// given the new list without it; a connector that cannot read the fields is never
// sent them. A fake gateway answers both gateways; scripted machines play the
// connectors. No key is ever sent back by the API or the live stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-auth-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 32000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ds-auth-token';
const KEY_GO = 'sk-auth-go-0123456789wxyz';
const KEY_CC = 'sk-auth-cc-0123456789abcd';
const ALL = [KEY_GO, KEY_CC];
let hub;
let gateway;
let newer;
let older;

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
    res.setHeader('content-type', 'application/json');
    req.resume();
    if (!ALL.some((k) => req.headers.authorization === `Bearer ${k}`)) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
    if (req.url === '/commandcode/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4-pro' }] }));
    res.statusCode = 404;
    res.end('{}');
  });
}

// A connector: says what it can do, keeps the provisions it was sent, reports on request.
function fakeMachine(key, machineId, capabilities) {
  const k = { provisioned: [] };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  k.report = (msg) => send({ t: 'deepseek.pool', ...msg });
  ws.on('open', () => {
    send({ t: 'hello', machineId, name: machineId, platform: 'test', bridgeVersion: '0.12.0', home: '/home/fake', pool: 1, capabilities, status });
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
    } else if (m.op === 'kimi.deepseek.remove') out = { ok: true, removed: true };
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
  newer = fakeMachine(key, 'm_new', ['pool', 'pool_cross', 'secondary_model', 'handoff', 'pool_auth']);
  older = fakeMachine(key, 'm_old', ['pool', 'pool_cross', 'secondary_model', 'handoff']);
  await Promise.all([newer.ready, older.ready]);
  await until(async () => (await api('GET', '/machines')).filter((m) => ['m_new', 'm_old'].includes(m.id) && m.online).length === 2, 10000, 'machines online');
});

after(() => {
  newer?.close();
  older?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const rotation = async () => (await api('GET', '/deepseek')).rotation;
const provisionedWith = (machine, n) => until(async () => machine.provisioned.length > n && machine.last(), 8000, 'a provision');

test('a connector reports a refused key: the settings answer and the live stream show it as refused, with no reset time and no key', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const events = [];
  ws.on('message', (d) => {
    try {
      events.push(JSON.parse(d));
    } catch {}
  });
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)));
  await api('PUT', '/deepseek', { apiKey: KEY_GO });
  await api('PUT', '/deepseek', { keyGateway: 'commandcode', apiKey: KEY_CC });
  const before = await rotation();
  const [go, cc] = before.keys;
  const failedAt = Date.now() - 3000;
  newer.report({ gateway: 'commandcode', rotation: 1, activeId: cc.id, revision: before.revision, keys: [{ id: go.id, authFailedAt: failedAt, authFailures: 1, authRetryAt: failedAt + 60_000 }] });
  await until(async () => (await rotation()).keys[0].state === 'auth_failed', 5000, 'refusal report');
  const r = await rotation();
  const k = r.keys[0];
  assert.deepEqual([k.authFailed, k.authFailedAt, k.authFailures, k.authRetryAt, k.exhaustedAt, k.resetAt, k.expiryKnown, k.manual], [true, failedAt, 1, failedAt + 60_000, null, null, false, false]);
  assert.equal(r.activeId, cc.id, 'the next key is the one in use');
  assert.equal(r.allExhausted, false);
  assert.equal(r.nextResetAt, null, 'no reset time was ever stated');
  await until(async () => events.some((m) => m.t === 'deepseek' && m.account.rotation?.keys[0].state === 'auth_failed'), 5000, 'broadcast');
  noKeys('the answer', r);
  noKeys('live stream', events.filter((m) => m.t === 'deepseek'));
  ws.close();
});

test('clearing the mark on a refused key is the same operation as for any mark; the connector is given the list again, without it', async () => {
  const [go] = (await rotation()).keys;
  const n = newer.provisioned.length;
  const cleared = await api('PUT', '/deepseek', { clearMarkKeyId: go.id });
  assert.deepEqual(cleared.rotation.keys.map((k) => [k.state, k.authFailed]), [['ready', false], ['ready', false]]);
  const sent = await provisionedWith(newer, n);
  assert.ok(sent.pool.keys.every((k) => !('authFailedAt' in k) && !('exhaustedAt' in k)), 'no mark goes out');
  noKeys('the answer', cleared);
});

test('a connector that understands refused keys is sent them with the key; one that does not is not, and is still not started on that key', async () => {
  const before = await rotation();
  const [go, cc] = before.keys;
  const failedAt = Date.now() - 2000;
  newer.report({ gateway: 'commandcode', rotation: 1, activeId: cc.id, revision: before.revision, keys: [{ id: go.id, authFailedAt: failedAt, authFailures: 3 }] });
  await until(async () => (await rotation()).keys[0].state === 'auth_failed', 5000, 'refusal report');
  assert.equal((await rotation()).keys[0].authRetryAt, failedAt + 4 * 60_000, 'a refusal with no schedule gets the one the connector uses: the third waits 4 minutes');
  // A change of the list (here: a move) makes the Hub provision every computer again.
  const nNew = newer.provisioned.length;
  const nOld = older.provisioned.length;
  await api('PUT', '/deepseek', { moveKeyId: cc.id, direction: 'top' });
  const forNew = await provisionedWith(newer, nNew);
  const forOld = await provisionedWith(older, nOld);
  const newerGo = forNew.pool.keys.find((k) => k.id === go.id);
  assert.deepEqual([newerGo.authFailedAt, newerGo.authFailures, newerGo.exhaustedAt], [failedAt, 3, undefined]);
  const olderGo = forOld.pool.keys.find((k) => k.id === go.id);
  assert.deepEqual(Object.keys(olderGo).sort(), ['apiKey', 'gateway', 'id'], 'the older connector gets the key as it always did');
  assert.equal(forOld.pool.activeId, cc.id, 'and is started on the key the Hub does not know to be refused');
  assert.equal(forNew.pool.activeId, cc.id);
  // Every key out of use: the Hub says so in one answer, apart for each kind.
  const r = await rotation();
  newer.report({ gateway: 'commandcode', rotation: 1, activeId: cc.id, revision: r.revision, keys: [{ id: cc.id, exhaustedAt: Date.now() }] });
  await until(async () => (await rotation()).allExhausted, 5000, 'second report');
  const all = await rotation();
  assert.deepEqual(all.keys.map((k) => k.state).sort(), ['auth_failed', 'exhausted']);
  assert.equal(all.nextResetAt, null);
  noKeys('rotation', all);
});
