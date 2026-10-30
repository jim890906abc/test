// "One key for each conversation" (distribution: 'sticky') in the connector's
// DeepSeek proxy. The old way ('relay') sends every conversation down the one key
// in use and moves on only when it runs out; the new way gives each conversation
// (the `prompt_cache_key` Kimi puts in every request, the same one for the main
// agent and its subagents) the key that has the fewest conversations, and keeps
// it there, so the gateway's prefix cache (tied to the account) is not lost and
// the conversations share the keys' throughput instead of queueing on one.
//
// The real connector, spawned on a saved key pool (so no Kimi is needed), a fake
// upstream gateway on loopback and a fake Hub socket. Nothing leaves this machine.
// The assertions look at which key the fake gateway saw each request arrive on.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dssticky-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const STATE_DIR = path.join(TMP, 'state');
const KEYS = { dk_a: 'sk-sticky-key-aaaa-1111', dk_b: 'sk-sticky-key-bbbb-2222', dk_c: 'sk-sticky-key-cccc-3333' };
const KEY_ID = Object.fromEntries(Object.entries(KEYS).map(([id, v]) => [v, id]));
const TOKEN = `ah_local_${'cd34'.repeat(8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge;
let upstream;
let hubWss;
let hubWs;
let proxyPort;
let helloWaiters = [];
let lastHello = null;
let upstreamRequests = []; // { key: 'dk_a', session, body }
let behaviours = new Map(); // key id -> async (req, res, body) => void
let hubMessages = [];

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const until = async (fn, ms = 10000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const nextHello = () => new Promise((resolve) => helloWaiters.push(resolve));

const sse = (res, text = 'hello') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 5 } })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const failing = (status, code, message = 'nope') => (req, res) => {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const quota = failing(402, 'insufficient_quota', 'You exceeded your current quota');
const refused = failing(401, 'invalid_api_key', 'Incorrect API key');

function fakeUpstream() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      const key = KEY_ID[String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')] || 'unknown';
      upstreamRequests.push({ key, session: body?.prompt_cache_key ?? null, body });
      try {
        await (behaviours.get(key) || ((q, r) => sse(r)))(req, res, body);
      } catch {
        try {
          res.destroy();
        } catch {}
      }
    });
  });
}

// A fresh connector on a freshly saved pool: every test starts from nothing
// remembered. `pool` goes into the saved state as it is (so `distribution` can be
// left out, as a pool saved by an older connector or hub has none).
async function boot({ keys = ['dk_a', 'dk_b'], distribution = 'sticky', env = {}, models = true, gateways = {}, modelMap = null } = {}) {
  if (bridge) {
    const exited = new Promise((r) => bridge.once('exit', r));
    bridge.kill('SIGTERM');
    await exited;
  }
  proxyPort = await freePort();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIR, 'bridge.json'),
    JSON.stringify({
      deepseekPool: {
        port: proxyPort,
        token: TOKEN,
        gateway: 'opencode-go',
        revision: 1,
        activeId: keys[0],
        models: models ? [{ model: 'deepseek-v4.1-flash', max_context_size: 1_000_000 }] : [],
        rotation: 1,
        ...(distribution ? { distribution } : {}),
        ...(modelMap ? { modelMap } : {}),
        keys: keys.map((id) => ({ id, apiKey: KEYS[id], gateway: gateways[id] || 'opencode-go' })),
      },
    }),
    { mode: 0o600 },
  );
  hubMessages = [];
  upstreamRequests = [];
  behaviours = new Map();
  const connected = nextHello();
  const e = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}`, ...env };
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env: e, stdio: 'ignore' });
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
}

before(async () => {
  upstream = fakeUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => hubWss.on('listening', r));
  hubWss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') {
        hubWs = ws;
        lastHello = m;
        const waiters = helloWaiters;
        helloWaiters = [];
        for (const r of waiters) r();
        return;
      }
      hubMessages.push(m);
    });
  });
});

beforeEach(() => {
  upstreamRequests = [];
  behaviours = new Map();
  hubMessages = [];
});

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  upstream?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const chat = (session, extra = {}) =>
  fetch(`http://127.0.0.1:${proxyPort}/opencode-go/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    // (Kimi puts prompt_cache_key last in its bodies.)
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }], ...(session ? { prompt_cache_key: session } : {}), ...extra }),
  });
const ask = async (session, extra) => {
  const res = await chat(session, extra);
  const status = res.status;
  await res.text();
  return status;
};
// Which key each conversation's requests arrived on: { session: Set(key ids) }.
const keysBySession = () => {
  const out = {};
  for (const u of upstreamRequests) (out[u.session ?? '(none)'] ||= new Set()).add(u.key);
  return out;
};
// How many conversations each key ended up with, from the requests the gateway saw
// (the last key a conversation arrived on).
const perKey = () => {
  const last = new Map();
  for (const u of upstreamRequests) if (u.session) last.set(u.session, u.key);
  const out = {};
  for (const k of last.values()) out[k] = (out[k] || 0) + 1;
  return out;
};
const lastPoolReport = () => hubMessages.filter((m) => m.t === 'deepseek.pool').at(-1);
const reportedSessions = () => Object.fromEntries((lastPoolReport()?.keys || []).map((k) => [k.id, k.sessions]));
const sessions = (n, prefix = 'session_conv') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// -------------------------------------------------------- capability

test('the hello says this connector can give each conversation its own key', async () => {
  await boot();
  assert.ok(lastHello.capabilities.includes('pool_sticky'), JSON.stringify(lastHello.capabilities));
  // What it could already do is still said.
  for (const name of ['pool', 'pool_cross', 'pool_timing', 'pool_auth']) assert.ok(lastHello.capabilities.includes(name), name);
});

// ----------------------------------------------------- the even split

test('six conversations on two keys: three each, and every request of a conversation (its subagents included) stays on its one key', async () => {
  await boot();
  const all = sessions(6);
  // The first request of each conversation, all at once (the split must not depend on who answers first).
  assert.deepEqual(await Promise.all(all.map((s) => ask(s))), [200, 200, 200, 200, 200, 200]);
  // Then the main agent and a subagent of each conversation keep asking, mixed together.
  const more = all.flatMap((s) => [ask(s), ask(s, { messages: [{ role: 'user', content: 'a subagent asks' }] })]);
  assert.ok((await Promise.all(more)).every((s) => s === 200));
  assert.equal(upstreamRequests.length, 18);
  for (const [s, ks] of Object.entries(keysBySession())) assert.equal(ks.size, 1, `${s} used ${[...ks]}`);
  assert.deepEqual(perKey(), { dk_a: 3, dk_b: 3 });
  // The connector says so, by key id (never the key).
  await until(() => reportedSessions().dk_a === 3 && reportedSessions().dk_b === 3, 5000, 'the counts in a report');
  assert.equal(lastPoolReport().distribution, 'sticky');
  assert.ok(!JSON.stringify(hubMessages).includes('sk-sticky'), 'no key value in anything sent to the Hub');
});

test('a new conversation goes to the key that has fewer; a tie goes to the key that comes first in the list', async () => {
  await boot({ keys: ['dk_a', 'dk_b', 'dk_c'] });
  // 1->a 2->b 3->c 4->a 5->b: a and b have two, c has one.
  for (const s of sessions(5)) await ask(s);
  assert.deepEqual(perKey(), { dk_a: 2, dk_b: 2, dk_c: 1 });
  assert.equal(upstreamRequests.at(-1).key, 'dk_b');
  await ask('session_conv6');
  assert.equal(upstreamRequests.at(-1).key, 'dk_c', 'the one with fewer, not the next in turn');
  await ask('session_conv7');
  assert.equal(upstreamRequests.at(-1).key, 'dk_a', 'all level: the first in the list');
});

test('a conversation that stopped asking is forgotten after a while, and the next new one fills the gap', async () => {
  await boot({ env: { AGENT_HUB_DEEPSEEK_STICKY_IDLE_MS: '700' } });
  for (const s of sessions(4)) await ask(s); // 1,3 -> a   2,4 -> b
  assert.deepEqual(perKey(), { dk_a: 2, dk_b: 2 });
  // Only 1 and 3 (on a) keep going; 2 and 4 (on b) go quiet.
  for (let i = 0; i < 3; i++) {
    await sleep(300);
    await ask('session_conv1');
    await ask('session_conv3');
  }
  // Meanwhile b has had none for a while and a has had two: the two on a stay on a, because their cache is there.
  assert.deepEqual([...new Set(upstreamRequests.filter((u) => ['session_conv1', 'session_conv3'].includes(u.session)).map((u) => u.key))], ['dk_a'], 'a conversation is not moved to a key that has fewer');
  upstreamRequests = [];
  await ask('session_conv5');
  assert.equal(upstreamRequests[0].key, 'dk_b', 'b had none left, a had two');
  // The conversation that came back after its absence is placed again, by the same rule.
  await ask('session_conv2');
  assert.equal(upstreamRequests[1].key, 'dk_b', 'a has two, b has one');
  await until(() => reportedSessions().dk_a === 2 && reportedSessions().dk_b === 2, 5000, 'the counts after the forgetting');
});

test('the connector remembers a bounded number of conversations: past it the one that asked longest ago is forgotten, which only means it is placed again', async () => {
  await boot({ env: { AGENT_HUB_DEEPSEEK_STICKY_MAX: '3' } });
  for (const s of sessions(5)) await ask(s);
  await until(() => {
    const n = Object.values(reportedSessions()).reduce((a, b) => a + (b || 0), 0);
    return n === 3 && n;
  }, 5000, 'three conversations remembered, not five');
  // The newest three are the ones kept: asking again does not move them.
  upstreamRequests = [];
  for (const s of ['session_conv3', 'session_conv4', 'session_conv5']) await ask(s);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b', 'dk_a'], 'conversations 3, 4 and 5 are where they were put (a, b, a)');
});

// ------------------------------------------------------- a key runs out

test('a key out of quota: only its conversations move, the request that hit it is sent again on the next key, the others stay put', async () => {
  await boot({ keys: ['dk_a', 'dk_b', 'dk_c'] });
  for (const s of sessions(6)) await ask(s); // 1,4 -> a   2,5 -> b   3,6 -> c
  assert.deepEqual(perKey(), { dk_a: 2, dk_b: 2, dk_c: 2 });
  upstreamRequests = [];
  behaviours.set('dk_a', quota);
  // The conversation on a asks: a says quota, the same request goes on (nothing reaches the client but the answer).
  assert.equal(await ask('session_conv1'), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b'], 'tried a, then the key with the fewest (tie: b before c)');
  assert.deepEqual(upstreamRequests[0].body, upstreamRequests[1].body, 'exactly the same request');
  // The others did not move: not a request of theirs goes anywhere else.
  upstreamRequests = [];
  for (const s of ['session_conv2', 'session_conv5', 'session_conv3', 'session_conv6']) assert.equal(await ask(s), 200);
  assert.deepEqual(upstreamRequests.map((u) => `${u.session}@${u.key}`), ['session_conv2@dk_b', 'session_conv5@dk_b', 'session_conv3@dk_c', 'session_conv6@dk_c']);
  // The one that moved stays moved, and does not go back to look at a.
  upstreamRequests = [];
  await ask('session_conv1');
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_b']);
  // The other conversation that was on a moves when it asks, by the same rule (c has fewer than b now).
  upstreamRequests = [];
  await ask('session_conv4');
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_c']);
  await until(() => reportedSessions().dk_a === 0 && reportedSessions().dk_b === 3 && reportedSessions().dk_c === 3, 5000, 'the counts after the move');
  assert.ok(lastPoolReport().keys.find((k) => k.id === 'dk_a').exhaustedAt, 'a is reported out');
});

test('a key the gateway refuses (401) is left the same way: only its conversations move, and the request is sent again', async () => {
  await boot();
  for (const s of sessions(4)) await ask(s); // 1,3 -> a   2,4 -> b
  upstreamRequests = [];
  behaviours.set('dk_b', refused);
  assert.equal(await ask('session_conv2'), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_b', 'dk_a']);
  upstreamRequests = [];
  assert.equal(await ask('session_conv1'), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a'], 'a conversation that was on a is not touched');
  assert.equal(await ask('session_conv4'), 200);
  assert.equal(upstreamRequests.at(-1).key, 'dk_a');
  const b = lastPoolReport().keys.find((k) => k.id === 'dk_b');
  assert.ok(b.authFailedAt && !b.exhaustedAt, 'b is reported as refused, not as out of quota');
});

test('the main agent and a subagent of one conversation that both hit the key running out end on the same new key', async () => {
  await boot({ keys: ['dk_a', 'dk_b', 'dk_c'] });
  await ask('session_conv1'); // a
  await ask('session_conv2'); // b
  await ask('session_conv3'); // c
  upstreamRequests = [];
  // The gateway answers a only when both requests are in, then says quota to both.
  let arrived = 0;
  behaviours.set('dk_a', async (req, res) => {
    arrived++;
    const end = Date.now() + 4000;
    while (arrived < 2 && Date.now() < end) await sleep(5);
    quota(req, res);
  });
  const [x, y] = await Promise.all([ask('session_conv1'), ask('session_conv1', { messages: [{ role: 'user', content: 'subagent' }] })]);
  assert.deepEqual([x, y], [200, 200]);
  const after = upstreamRequests.filter((u) => u.key !== 'dk_a').map((u) => u.key);
  assert.equal(after.length, 2);
  assert.equal(new Set(after).size, 1, `both on one key, not split: ${after}`);
  // And the conversation is on that key from now on.
  upstreamRequests = [];
  await ask('session_conv1');
  assert.deepEqual(upstreamRequests.map((u) => u.key), [after[0]]);
});

test('every key out: the same clear answer as before, and each key is tried once', async () => {
  await boot();
  behaviours.set('dk_a', quota);
  behaviours.set('dk_b', quota);
  const res = await chat('session_conv1');
  assert.equal(res.status, 402);
  assert.equal(JSON.parse(await res.text()).error.code, 'insufficient_quota');
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b']);
});

test('a request whose model a key\'s gateway does not have goes to another key for that one request; the conversation stays where it is', async () => {
  // c is on another gateway, which has the Flash model under its own name and no Pro model.
  await boot({ keys: ['dk_a', 'dk_c'], gateways: { dk_c: 'commandcode' }, modelMap: { commandcode: { 'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash' } } });
  await ask('session_conv1'); // a
  await ask('session_conv2'); // c
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_c']);
  assert.equal(upstreamRequests[1].body.model, 'deepseek/deepseek-v4.1-flash', 'spelled as that gateway spells it');
  upstreamRequests = [];
  // Conversation 2 asks for a model c cannot serve: one request on a. It is still conversation 2 on c afterwards.
  assert.equal(await ask('session_conv2', { model: 'deepseek-v4-pro' }), 200);
  assert.deepEqual(upstreamRequests.map((u) => [u.key, u.body.model]), [['dk_a', 'deepseek-v4-pro']]);
  assert.equal(await ask('session_conv2'), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_c'], 'back on c with the model it can serve');
  // And the count did not change by it: the next newcomer sees a and c level and takes the first.
  await ask('session_conv3');
  assert.equal(upstreamRequests.at(-1).key, 'dk_a');
  await ask('session_conv4');
  assert.equal(upstreamRequests.at(-1).key, 'dk_c');
});

// ------------------------------------------------- no conversation named

test('a request that names no conversation is relayed: the key in use, no count, no memory', async () => {
  await boot();
  for (let i = 0; i < 4; i++) await ask(null);
  // A body that names something that is not a Kimi session is not trusted as one either.
  await ask('not-a-session-id');
  assert.deepEqual([...new Set(upstreamRequests.map((u) => u.key))], ['dk_a'], 'all on the key in use');
  assert.equal(upstreamRequests.length, 5);
  // So the next real conversation is still the first one anyone has.
  upstreamRequests = [];
  await ask('session_conv1');
  assert.equal(upstreamRequests[0].key, 'dk_a');
  await ask('session_conv2');
  assert.equal(upstreamRequests[1].key, 'dk_b', 'the nameless requests were not counted as conversations');
  // When the key in use runs out the nameless ones move on, as in a relay.
  behaviours.set('dk_a', quota);
  upstreamRequests = [];
  assert.equal(await ask(null), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b']);
});

// ------------------------------------------------------------- relay

test('relay: every conversation goes down the key in use, whatever its name, and moves only when that key runs out', async () => {
  await boot({ distribution: 'relay' });
  for (const s of sessions(6)) await ask(s);
  assert.deepEqual([...new Set(upstreamRequests.map((u) => u.key))], ['dk_a']);
  assert.equal(lastPoolReport()?.distribution ?? 'relay', 'relay');
  assert.ok((lastPoolReport()?.keys || []).every((k) => k.sessions === undefined), 'no counts in a relay');
  behaviours.set('dk_a', quota);
  upstreamRequests = [];
  for (const s of sessions(3)) assert.equal(await ask(s), 200);
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b', 'dk_b', 'dk_b'], 'a is found out once; the rest go straight to b');
});

test('a pool saved without a distribution (a Hub from before this) is a relay: nothing changes for it', async () => {
  await boot({ distribution: null });
  for (const s of sessions(4)) await ask(s);
  assert.deepEqual([...new Set(upstreamRequests.map((u) => u.key))], ['dk_a']);
  assert.ok((lastPoolReport()?.keys || []).every((k) => k.sessions === undefined));
});

test('the split is kept in memory only: a restarted connector places conversations afresh (it costs one cache, never a request)', async () => {
  await boot();
  for (const s of sessions(2)) await ask(s); // 1 -> a   2 -> b
  assert.deepEqual(perKey(), { dk_a: 1, dk_b: 1 });
  const saved = fs.readFileSync(path.join(STATE_DIR, 'bridge.json'), 'utf8');
  assert.ok(!saved.includes('session_conv'), 'no conversation id is written to disk');
  assert.match(saved, /"distribution":\s*"sticky"/, 'the way of splitting is kept');
  // Restart on the saved state (boot() would rewrite it): the same port and pool come back.
  const exited = new Promise((r) => bridge.once('exit', r));
  bridge.kill('SIGTERM');
  await exited;
  const connected = nextHello();
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env: { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}` }, stdio: 'ignore' });
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
  upstreamRequests = [];
  await ask('session_conv2');
  await ask('session_conv1');
  assert.deepEqual(upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b'], 'placed again from nothing: the first newcomer is the first in the list');
});
