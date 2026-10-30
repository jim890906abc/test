// What the connector's DeepSeek proxy writes down about every upstream request
// (when it started, when the answer's headers and first byte came, when it
// ended, the status, which key by id, whether another key took over), what it
// tells the Hub, and the one-key concurrency measure the Hub can ask for.
//
// The real connector, spawned with a saved key pool (so no Kimi is needed), a
// fake upstream gateway on loopback and a fake Hub socket. Nothing leaves this
// machine. Times are the proxy's own clock: the assertions look at order and at
// the delays the fake gateway really imposed, never at a number made up here.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dstiming-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const STATE_DIR = path.join(TMP, 'state');
const KEY_A = 'sk-timing-key-aaaa-1111';
const KEY_B = 'sk-timing-key-bbbb-2222';
const KEY_C = 'sk-timing-key-cccc-3333';
const TOKEN = `ah_local_${'ab12'.repeat(8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge;
let upstream;
let hubWss;
let hubWs;
let proxyPort;
let helloWaiters = [];
let lastHello = null;
let upstreamRequests = [];
let behaviours = new Map(); // upstream key -> async (req, res, body) => void
let hubMessages = []; // everything the connector said that is not a reply
const pending = new Map();

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
const ask = (op, args, ms = 60000) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no answer for ${op}`));
    }, ms);
    pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
  });
const nextHello = () => new Promise((resolve) => helloWaiters.push(resolve));
const records = () => hubMessages.filter((m) => m.t === 'deepseek.requests').flatMap((m) => m.records);
const recordsFor = (pred) => records().filter(pred);

// ------------------------------------------------------ fake upstream
const sse = (res, parts) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const p of parts) res.write(`data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const okStream = (tokens = 7) => (req, res) => sse(res, [{ choices: [{ index: 0, delta: { content: 'hello' } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: tokens, total_tokens: tokens + 3 } }]);
// Headers after `h` ms, the first body byte `f` ms later, the rest `t` ms after that.
const phased = ({ h = 0, f = 0, t = 0, tokens = 40 }) => async (req, res) => {
  await sleep(h);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.flushHeaders();
  await sleep(f);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }] })}\n\n`);
  await sleep(t);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: tokens } })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const failing = (status, code, message = 'nope') => (req, res) => {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

// Holds each request `hold` ms, answers 200 with a small JSON; with `limit` it
// answers 429 to anything past that many requests held at once.
let held = 0;
let peakHeld = 0;
let arrivals = []; // { at, key, held, status }
const limiter = ({ hold = 150, limit = Infinity, status = 429 } = {}) => async (req, res) => {
  const mine = held + 1;
  if (mine > limit) {
    arrivals.push({ at: Date.now(), key: req.headers.authorization, held: mine, status });
    return failing(status, 'rate_limit_exceeded', 'slow down')(req, res);
  }
  held++;
  peakHeld = Math.max(peakHeld, held);
  arrivals.push({ at: Date.now(), key: req.headers.authorization, held: mine, status: 200 });
  await sleep(hold);
  held--;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'length' }], usage: { completion_tokens: 1 } }));
};

function fakeUpstream() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      upstreamRequests.push({ url: req.url, key, body, headers: req.headers, at: Date.now() });
      try {
        await (behaviours.get(key) || okStream())(req, res, body);
      } catch {
        try {
          res.destroy();
        } catch {}
      }
    });
  });
}

// ------------------------------------------------------------- setup
const seed = () => ({
  deepseekPool: {
    port: proxyPort,
    token: TOKEN,
    gateway: 'opencode-go',
    revision: 1,
    activeId: 'dk_a',
    models: [{ model: 'deepseek-v4.1-flash', max_context_size: 1_000_000 }],
    rotation: 1,
    modelMap: { commandcode: { 'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash' } },
    keys: [
      { id: 'dk_a', apiKey: KEY_A, gateway: 'opencode-go' },
      { id: 'dk_b', apiKey: KEY_B, gateway: 'opencode-go' },
      { id: 'dk_c', apiKey: KEY_C, gateway: 'commandcode' },
    ],
  },
});

before(async () => {
  upstream = fakeUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  proxyPort = await freePort();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'bridge.json'), JSON.stringify(seed()), { mode: 0o600 });
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
      if (m.t === 'res' && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      hubMessages.push(m);
    });
  });
  const env = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}` };
  const connected = nextHello();
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
});

beforeEach(() => {
  upstreamRequests = [];
  behaviours = new Map();
  hubMessages = [];
  held = 0;
  peakHeld = 0;
  arrivals = [];
});

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  upstream?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const chat = (body = {}, headers = {}) =>
  fetch(`http://127.0.0.1:${proxyPort}/opencode-go/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });

// -------------------------------------------------------- capabilities

test('the hello says this connector writes request records, can measure a key, and carries step timing', () => {
  for (const name of ['pool_timing', 'pool_measure', 'event_timing']) assert.ok(lastHello.capabilities.includes(name), `${name} in ${JSON.stringify(lastHello.capabilities)}`);
  // What it could already do is still said.
  assert.ok(lastHello.capabilities.includes('pool') && lastHello.capabilities.includes('pool_cross'));
});

// ----------------------------------------------------- request records

test('a request is written down with its own times, status, key id, conversation and tokens', async () => {
  behaviours.set(KEY_A, phased({ h: 120, f: 90, t: 110, tokens: 40 }));
  const before = Date.now();
  const res = await chat({ prompt_cache_key: 'session_abc-123' }, { 'x-stainless-retry-count': '2' });
  assert.equal(res.status, 200);
  await res.text();
  const after = Date.now();
  const [r] = await until(() => {
    const got = records();
    return got.length === 1 && got;
  }, 5000, 'the record');
  assert.equal(r.key, 'dk_a');
  assert.equal(r.gateway, 'opencode-go');
  assert.equal(r.status, 200);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.session, 'session_abc-123', 'the conversation Kimi puts in prompt_cache_key');
  assert.equal(r.attempt, 1);
  assert.equal(r.switchedFrom, null);
  assert.equal(r.clientRetry, 2, 'Kimi\'s own retry count for this request');
  assert.equal(r.outTokens, 40, 'completion_tokens of the stream\'s usage');
  assert.ok(r.startAt >= before - 5 && r.startAt <= after, `startAt ${r.startAt} within the request`);
  assert.ok(r.recvAt <= r.startAt, 'received before it was sent upstream');
  // Order, and the delays the gateway really imposed.
  assert.ok(r.headersMs >= 110, `headers after the gateway's 120 ms: ${r.headersMs}`);
  assert.ok(r.firstByteMs >= r.headersMs + 80, `first byte 90 ms after the headers: ${r.firstByteMs} vs ${r.headersMs}`);
  assert.ok(r.endMs >= r.firstByteMs + 100, `the rest 110 ms after that: ${r.endMs} vs ${r.firstByteMs}`);
  assert.ok(r.endMs <= after - before + 20, 'not longer than the whole request took');
  assert.equal(r.inflight, 1);
  // Only ids and numbers: never a key.
  assert.ok(!JSON.stringify(hubMessages).includes('sk-timing'), 'no key value in anything sent to the Hub');
});

test('a 429 that is not a quota error is sent on to the next key (2026-10-30), and goes to the client unchanged when every key says it; each attempt is written down as a 429, and none marks a key', async () => {
  behaviours.set(KEY_A, failing(429, 'rate_limit_exceeded', 'slow down'));
  behaviours.set(KEY_B, failing(429, 'rate_limit_exceeded', 'slow down'));
  behaviours.set(KEY_C, failing(429, 'rate_limit_exceeded', 'slow down'));
  const res = await chat();
  assert.equal(res.status, 429);
  await res.text();
  const [r, second] = await until(() => records().length === 3 && records(), 5000, 'the records');
  assert.equal(r.status, 429);
  assert.equal(r.outcome, 'http_error');
  assert.equal(r.key, 'dk_a');
  assert.equal(r.firstByteMs !== null, true, 'the error body\'s first byte was seen');
  assert.equal(r.outTokens, null, 'no usage in an error');
  assert.equal(r.borrowedFrom, null, 'the first attempt is on its own key');
  assert.deepEqual([second.key, second.status, second.outcome, second.borrowedFrom, second.borrowReason], ['dk_b', 429, 'http_error', 'dk_a', 'rate429'], 'the second attempt was lent by a');
  assert.equal(upstreamRequests.length, 3, 'every key was asked once, no more');
  await sleep(100);
  const report = hubMessages.filter((m) => m.t === 'deepseek.pool').at(-1);
  assert.ok(!report || report.keys.every((k) => !k.exhaustedAt), 'a rate limit marks no key out of quota');
});

test('a key that is out of quota hands the same request to the next key, and both attempts are written down', async () => {
  behaviours.set(KEY_A, failing(402, 'insufficient_quota', 'You exceeded your current quota'));
  behaviours.set(KEY_B, okStream(11));
  const res = await chat({ prompt_cache_key: 'session_swap' });
  assert.equal(res.status, 200);
  await res.text();
  const got = await until(() => records().length === 2 && records(), 5000, 'both records');
  const [a, b] = got.sort((x, y) => x.attempt - y.attempt);
  assert.equal(a.req, b.req, 'one request');
  assert.deepEqual([a.attempt, a.key, a.status, a.outcome, a.switchedFrom], [1, 'dk_a', 402, 'quota', null]);
  assert.deepEqual([b.attempt, b.key, b.status, b.outcome, b.switchedFrom], [2, 'dk_b', 200, 'ok', 'dk_a']);
  assert.equal(b.outTokens, 11);
  assert.equal(a.session, 'session_swap');
  assert.equal(b.session, 'session_swap');
  assert.ok(b.startAt >= a.startAt + a.endMs - 5, 'the second attempt began after the first ended');
  // dk_a is marked out now; put it back so the other tests start on it.
  behaviours.set(KEY_A, okStream());
  await sleep(50);
});

test('requests that overlap on one key say how many were in flight when each began', async () => {
  // The gateway answers only when all three are in, so they really are in flight together.
  let arrived = 0;
  const barrier = async (req, res) => {
    arrived++;
    const end = Date.now() + 5000;
    while (arrived < 3 && Date.now() < end) await sleep(10);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { completion_tokens: 1 } }));
  };
  // (dk_a was marked out by the test above; the key in use is B. Both are held, so it does not matter.)
  behaviours.set(KEY_B, barrier);
  behaviours.set(KEY_A, barrier);
  const done = await Promise.all([1, 2, 3].map(() => chat({ stream: false }).then((r) => r.text())));
  assert.equal(done.length, 3);
  const got = await until(() => records().length >= 3 && records(), 5000, 'three records');
  const key = got[0].key;
  assert.ok(got.every((r) => r.key === key), 'all on one key');
  assert.deepEqual(got.map((r) => r.inflight).sort(), [1, 2, 3], `the third began with 3 on ${key} in flight`);
});

test('a request with no conversation in it is written down with session null, and a client that leaves is "aborted"', async () => {
  behaviours.set(KEY_A, okStream());
  behaviours.set(KEY_B, okStream());
  await (await chat()).text();
  const [r] = await until(() => records().length === 1 && records(), 5000, 'the record');
  assert.equal(r.session, null);
  assert.equal(r.clientRetry, null);
  // A client that goes away while the gateway is still silent.
  hubMessages = [];
  behaviours.set(KEY_A, phased({ h: 0, f: 600, t: 0 }));
  behaviours.set(KEY_B, phased({ h: 0, f: 600, t: 0 }));
  const ac = new AbortController();
  const p = fetch(`http://127.0.0.1:${proxyPort}/opencode-go/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [] }), signal: ac.signal }).catch(() => null);
  await sleep(200);
  ac.abort();
  await p;
  const [a] = await until(() => records().length === 1 && records(), 5000, 'the aborted record');
  assert.equal(a.outcome, 'aborted');
  assert.equal(a.firstByteMs, null, 'no first byte was seen');
});

test('after the Hub connection drops and comes back, the records are sent again (the Hub keeps them by id)', async () => {
  behaviours.set(KEY_A, okStream());
  behaviours.set(KEY_B, okStream());
  await (await chat({ prompt_cache_key: 'session_again' })).text();
  const first = await until(() => records().find((r) => r.session === 'session_again'), 5000, 'the record');
  const back = nextHello();
  hubMessages = [];
  hubWs.close();
  await Promise.race([back, sleep(15000).then(() => Promise.reject(new Error('no reconnect')))]);
  const again = await until(() => records().find((r) => r.id === first.id), 8000, 'the same record sent again');
  assert.equal(again.startAt, first.startAt);
  assert.ok(!JSON.stringify(hubMessages).includes('sk-timing'));
});

// -------------------------------------------------- what Kimi's journal carries

test('a step the journal ends carries how long the model took to start and to stream, with the journal\'s own times', async () => {
  const sid = 'session_timing1';
  const dir = path.join(KIMI_HOME, 'sessions', 'ws1', sid);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ title: '計時', cwd: TMP }));
  const lines = [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'agent-hub-deepseek/deepseek-v4.1-flash', profileName: 'default', thinkingEffort: 'high', systemPrompt: 'x', disallowedTools: [], time: 1000 },
    { type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'p1', origin: { kind: 'user' }, input: [{ type: 'text', text: '開始' }], time: 2000 },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', uuid: 'step-uuid-1', turnId: '0', step: 1, finishReason: 'end_turn', usage: { inputOther: 5, output: 20, inputCacheRead: 0, inputCacheCreation: 0 }, llmFirstTokenLatencyMs: 310, llmStreamDurationMs: 690 }, time: 3000 },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', durationMs: 1100, time: 3100 },
  ];
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = await ask('kimi.history', { sessionId: sid, turns: 10 });
  assert.equal(r.ok, true, r.error);
  const step = r.data.frames.find((f) => f.type === 'turn.step.completed');
  assert.ok(step, JSON.stringify(r.data.frames.map((f) => f.type)));
  assert.equal(step.payload.llmFirstTokenLatencyMs, 310);
  assert.equal(step.payload.llmStreamDurationMs, 690);
  assert.equal(step.payload.stepId, 'step-uuid-1');
  assert.equal(step.payload.step, 1);
  assert.equal(step.time, 3000, 'the journal\'s own time');
  const ended = r.data.frames.find((f) => f.type === 'turn.ended');
  assert.equal(ended.payload.durationMs, 1100);
  assert.equal(ended.time, 3100);
});

// ------------------------------------------------- the concurrency measure

const LEVELS = [1, 2, 4, 8, 16];
// The gateway holds each request until every request of its level has arrived
// (so they really were in flight together), counted from the order they come
// in: 1, then 2, then 4, 8, 16. `limit` answers 429 to everything past that
// many of one level.
function levelGate({ limit = Infinity, levels = LEVELS } = {}) {
  const bounds = levels.map((n, i) => ({ n, from: levels.slice(0, i).reduce((a, b) => a + b, 0) }));
  let seen = 0;
  const reached = new Map(); // level -> how many were held at once when the last arrived
  const arrived = new Map();
  const gate = async (req, res) => {
    const index = seen++;
    const b = bounds.findLast((x) => index >= x.from);
    arrived.set(b.n, (arrived.get(b.n) || 0) + 1);
    const end = Date.now() + 4000;
    while (arrived.get(b.n) < b.n && Date.now() < end) await sleep(5);
    reached.set(b.n, arrived.get(b.n));
    const position = index - b.from; // 0-based inside the level
    if (position >= limit) return failing(429, 'rate_limit_exceeded', 'slow down')(req, res);
    await sleep(60);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'length' }], usage: { completion_tokens: 1 } }));
  };
  return { gate, reached, seen: () => seen };
}
const measure = (args, ms) => ask('kimi.deepseek.measure', { model: 'deepseek-v4.1-flash', ...args }, ms);

test('measure sends 1, 2, 4, 8 and 16 requests at once on the named key, and says what each level got', async () => {
  const g = levelGate({ limit: 4 });
  behaviours.set(KEY_B, g.gate);
  const r = await measure({ keyId: 'dk_b' });
  assert.equal(r.ok, true, r.error);
  const m = r.data;
  assert.equal(m.keyId, 'dk_b');
  assert.equal(m.gateway, 'opencode-go');
  assert.equal(m.totalRequests, 31);
  assert.equal(upstreamRequests.length, 31, 'exactly the 31 small requests, no more');
  assert.ok(upstreamRequests.every((u) => u.key === KEY_B), 'all with the named key and no other');
  assert.ok(upstreamRequests.every((u) => u.url === '/opencode-go/chat/completions' && u.body.max_tokens <= 16 && u.body.stream === false), 'small, not streamed');
  // Really at the same time: the gateway held each level until all of it had arrived.
  assert.deepEqual([...g.reached.entries()], LEVELS.map((n) => [n, n]), 'every level was in flight all at once');
  // And what each level got: the gateway let 4 through and answered 429 to the rest.
  assert.deepEqual(m.levels.map((l) => [l.concurrency, l.requests, l.ok, l.http429, l.errors]), [
    [1, 1, 1, 0, 0],
    [2, 2, 2, 0, 0],
    [4, 4, 4, 0, 0],
    [8, 8, 4, 4, 0],
    [16, 16, 4, 12, 0],
  ]);
  assert.deepEqual(m.levels[4].statuses, { 200: 4, 429: 12 });
  for (const l of m.levels) {
    assert.ok(l.latencyMs.p50 >= 55, `p50 ${l.latencyMs.p50} is at least the 60 ms the gateway held (level ${l.concurrency})`);
    assert.ok(l.latencyMs.p95 >= l.latencyMs.p50);
  }
  assert.equal(m.stoppedEarly, null);
  // The key never leaves this computer: not in the answer, not in anything sent to the Hub.
  assert.ok(!JSON.stringify(r).includes('sk-timing'), JSON.stringify(r));
  assert.ok(!JSON.stringify(hubMessages).includes('sk-timing'));
});

test('measure uses the key\'s own gateway and the model it is given, and takes levels it is told', async () => {
  behaviours.set(KEY_C, levelGate({ levels: [3] }).gate);
  const r = await measure({ keyId: 'dk_c', levels: [3], model: 'deepseek/deepseek-v4.1-flash' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.gateway, 'commandcode');
  assert.equal(r.data.totalRequests, 3);
  assert.deepEqual(upstreamRequests.map((u) => [u.url, u.key, u.body.model]), Array(3).fill(['/commandcode/chat/completions', KEY_C, 'deepseek/deepseek-v4.1-flash']));
  assert.deepEqual(r.data.levels.map((l) => [l.concurrency, l.ok]), [[3, 3]]);
});

test('measure does not change what the pool thinks of the key, even when the gateway says its quota is gone', async () => {
  // Whichever key real requests are on now is the one measured.
  behaviours.set(KEY_A, okStream());
  behaviours.set(KEY_B, okStream());
  await (await chat()).text();
  const used = upstreamRequests[0].key;
  const id = used === KEY_A ? 'dk_a' : 'dk_b';
  behaviours.set(used, failing(402, 'insufficient_quota', 'You exceeded your current quota'));
  hubMessages = [];
  const r = await measure({ keyId: id, levels: [2] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.levels[0].statuses, { 402: 2 });
  assert.equal(r.data.levels[0].ok, 0);
  assert.deepEqual(r.data.levels[0].codes, ['insufficient_quota']);
  assert.equal(hubMessages.filter((m) => m.t === 'deepseek.pool').length, 0, 'no pool report: nothing was marked exhausted');
  // A real request still starts on the same key: it was not moved off it.
  upstreamRequests = [];
  behaviours.set(used, okStream());
  await (await chat()).text();
  assert.equal(upstreamRequests[0].key, used);
});

test('a key that is refused outright is not asked 30 more times', async () => {
  behaviours.set(KEY_B, failing(401, 'invalid_api_key', 'bad key'));
  const r = await measure({ keyId: 'dk_b' });
  assert.equal(r.ok, true, r.error);
  assert.equal(upstreamRequests.length, 1, 'the first level was refused, so the rest were not sent');
  assert.deepEqual(r.data.levels.map((l) => [l.concurrency, l.requests]), [[1, 1]]);
  assert.match(r.data.stoppedEarly, /401/);
  assert.equal(r.data.totalRequests, 1);
});

test('measure refuses what it should, before sending anything', async () => {
  const bad = async (args, status, pattern) => {
    upstreamRequests = [];
    const r = await measure(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(r.status, status, `${JSON.stringify(args)}: ${r.error}`);
    assert.match(r.error, pattern);
    assert.equal(upstreamRequests.length, 0, `nothing sent for ${JSON.stringify(args)}`);
  };
  await bad({ keyId: 'dk_unknown' }, 404, /沒有這把 key/);
  await bad({ keyId: 'dk_b', levels: [0] }, 400, /並行數/);
  await bad({ keyId: 'dk_b', levels: [100] }, 400, /並行數/);
  await bad({ keyId: 'dk_b', levels: 'many' }, 400, /並行數/);
  await bad({ keyId: 'dk_b', levels: [32, 32, 32] }, 400, /總共/);
  await bad({ keyId: 'dk_b', model: '../../etc' }, 400, /模型/);
  await bad({ keyId: 'dk_b', model: undefined }, 400, /模型/);
});

test('one measure at a time: a second one while the first is running is refused', async () => {
  const g = levelGate({ levels: [2] });
  behaviours.set(KEY_B, g.gate);
  const first = measure({ keyId: 'dk_b', levels: [2] });
  await until(() => upstreamRequests.length >= 1, 5000, 'the first request');
  const second = await measure({ keyId: 'dk_b', levels: [1] });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.match(second.error, /正在量測/);
  assert.equal((await first).ok, true);
});
