// How the DeepSeek keys are given out, through the real Hub's API: the default is
// one key for each conversation ("sticky"), a person can switch to the old relay
// (use the key in use until it runs out) and back, a connector that can do it is
// sent the choice with the list and one that cannot is not, and the counts a
// connector reports (conversations on each key) come back out of the API. A fake
// gateway answers the key checks; scripted machines play the connectors. No key
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-sticky-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 32000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ds-sticky-token';
const KEY_GO = 'sk-stk-go-0123456789wxyz';
const KEY_CC = 'sk-stk-cc-0123456789abcd';
const ALL = [KEY_GO, KEY_CC];
let hub;
let newer; // a connector that can give each conversation its own key
let older; // one that cannot
let gateway;

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
    if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
    if (req.url === '/commandcode/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4-pro' }] }));
    res.statusCode = 404;
    res.end('{}');
  });
}

// A connector: says what it can do, keeps the provisions it was sent.
function fakeMachine(key, id, capabilities) {
  const k = { provisioned: [] };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  k.report = (msg) => send({ t: 'deepseek.pool', ...msg });
  ws.on('open', () => {
    send({ t: 'hello', machineId: id, name: id, platform: 'test', bridgeVersion: '0.12.0', home: '/home/fake', pool: 1, capabilities, status });
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
  newer = fakeMachine(key, 'm_new', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky']);
  older = fakeMachine(key, 'm_old', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff']);
  await Promise.all([newer.ready, older.ready]);
  await until(async () => (await api('GET', '/machines')).filter((m) => m.online).length === 2, 10000, 'both machines online');
});

after(() => {
  newer?.close();
  older?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const rotation = async () => (await api('GET', '/deepseek')).rotation;
const nextProvision = (machine, n) => until(async () => machine.provisioned.length > n && machine.last(), 8000, 'a provision');

test('with two keys the default is one key for each conversation: the connector that can is told so, the one that cannot is not', async () => {
  await api('PUT', '/deepseek', { apiKey: KEY_GO });
  const acc = await api('PUT', '/deepseek', { keyGateway: 'commandcode', apiKey: KEY_CC });
  assert.equal(acc.distribution, 'sticky');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8')).distribution, undefined, 'nothing chosen, nothing written');
  await until(async () => newer.provisioned.some((p) => p.pool?.keys?.length === 2) && older.provisioned.some((p) => p.pool?.keys?.length === 2), 8000, 'both given both keys');
  assert.equal(newer.provisioned.findLast((p) => p.pool?.keys?.length === 2).pool.distribution, 'sticky');
  assert.equal('distribution' in older.provisioned.findLast((p) => p.pool?.keys?.length === 2).pool, false);
  noKeys('PUT answer', acc);
});

test('choosing the relay sends the choice to the connector that can read it, once; choosing it again sends nothing', async () => {
  const n = newer.provisioned.length;
  const m = older.provisioned.length;
  const relayed = await api('PUT', '/deepseek', { distribution: 'relay' });
  assert.equal(relayed.distribution, 'relay');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8')).distribution, 'relay');
  assert.equal((await nextProvision(newer, n)).pool.distribution, 'relay');
  assert.equal('distribution' in (await nextProvision(older, m)).pool, false, 'the older connector relays whatever is chosen, and is not told');
  await new Promise((r) => setTimeout(r, 400));
  const [n2, m2] = [newer.provisioned.length, older.provisioned.length];
  assert.equal((await api('PUT', '/deepseek', { distribution: 'relay' })).distribution, 'relay');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(newer.provisioned.length, n2, 'the same choice: nothing sent');
  assert.equal(older.provisioned.length, m2);
  const back = await api('PUT', '/deepseek', { distribution: 'sticky' });
  assert.equal(back.distribution, 'sticky');
  assert.equal((await nextProvision(newer, n2)).pool.distribution, 'sticky');
  noKeys('answers', [relayed, back]);
});

test('the choice is one operation of its own, and only the two names are accepted', async () => {
  const rev = (await rotation()).revision;
  await assert.rejects(api('PUT', '/deepseek', { distribution: 'round-robin' }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { distribution: '' }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { distribution: null }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { distribution: 'relay', markFullKeyId: (await rotation()).keys[0].id }), (e) => e.status === 400 && /一次只能/.test(e.message));
  assert.equal((await rotation()).revision, rev, 'nothing changed');
  assert.equal((await api('GET', '/deepseek')).distribution, 'sticky');
});

test('the counts a connector reports come out of the API per key, without a key or a conversation id, and an older connector\'s rows say it cannot', async () => {
  const r = await rotation();
  const [go, cc] = r.keys;
  newer.report({ gateway: 'opencode-go', rotation: 1, activeId: go.id, revision: r.revision, distribution: 'sticky', keys: [{ id: go.id, sessions: 4 }, { id: cc.id, sessions: 3 }] });
  await until(async () => (await rotation()).keys[0].sessions === 4, 5000, 'the counts');
  const acc = await api('GET', '/deepseek');
  assert.deepEqual(acc.rotation.keys.map((k) => k.sessions), [4, 3]);
  const rowNew = acc.activity.find((a) => a.machineId === 'm_new');
  assert.equal(rowNew.stickyCapable, true);
  assert.equal(rowNew.distribution, 'sticky');
  older.report({ gateway: 'opencode-go', rotation: 1, activeId: go.id, revision: r.revision, keys: [{ id: go.id }] });
  await until(async () => (await api('GET', '/deepseek')).activity.some((a) => a.machineId === 'm_old'), 5000, 'the older one\'s row');
  const rowOld = (await api('GET', '/deepseek')).activity.find((a) => a.machineId === 'm_old');
  assert.ok(!rowOld.stickyCapable && !rowOld.distribution, JSON.stringify(rowOld));
  noKeys('the account', acc);
  assert.ok(!JSON.stringify(acc).includes('session_'), 'no conversation id');
});
