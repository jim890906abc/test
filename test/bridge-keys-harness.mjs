// The real connector, spawned on a saved DeepSeek key pool (so no Kimi is needed),
// a fake upstream gateway on loopback and a fake Hub socket. Nothing leaves this
// machine. Shared by the tests of how the pool treats a key whose reset time has
// passed and a key that is being rate limited (bridge-reset-due, bridge-rate-limit).
// The assertions look at which key the fake gateway saw each request arrive on.
import { before, after, beforeEach } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const until = async (fn, ms = 10000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export const sse = (res, text = 'hello') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 5 } })}\n\n`);
  res.end('data: [DONE]\n\n');
};
export const failing = (status, code, message = 'nope', headers = {}) => (req, res) => {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
// Out of quota (HTTP 402), as a gateway says it; `retryAfterSecs` is the reset time it states.
export const quota = (retryAfterSecs = null) => failing(402, 'insufficient_quota', 'You exceeded your current quota', retryAfterSecs ? { 'retry-after': String(retryAfterSecs) } : {});
// A rate limit (HTTP 429): slow down, nothing to do with the account's money.
export const rateLimited = failing(429, 'rate_limit_exceeded', 'Rate limit reached for requests');
export const refused = failing(401, 'invalid_api_key', 'Incorrect API key');

// `prefix` names the temp folder; `keys` maps key id -> the secret that gateway sees.
export function createHarness({ prefix, keys }) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-${prefix}-`));
  const KIMI_HOME = path.join(TMP, 'kimi');
  const STATE_DIR = path.join(TMP, 'state');
  const TOKEN = `ah_local_${'cd34'.repeat(8)}`;
  const KEY_ID = Object.fromEntries(Object.entries(keys).map(([id, v]) => [v, id]));
  const h = {
    TMP,
    TOKEN,
    KEYS: keys,
    bridge: null,
    upstream: null,
    hubWss: null,
    hubWs: null,
    proxyPort: 0,
    lastHello: null,
    upstreamRequests: [], // { key: 'dk_a', session, body, at }
    behaviours: new Map(), // key id -> async (req, res, body) => void
    hubMessages: [],
  };
  let helloWaiters = [];
  const nextHello = () => new Promise((resolve) => helloWaiters.push(resolve));

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
        h.upstreamRequests.push({ key, session: body?.prompt_cache_key ?? null, body, url: req.url, at: Date.now() });
        try {
          await (h.behaviours.get(key) || ((q, r) => sse(r)))(req, res, body);
        } catch {
          try {
            res.destroy();
          } catch {}
        }
      });
    });
  }

  // A fresh connector on a freshly saved pool: every test starts from nothing remembered.
  // `states` puts a key into the pool already marked, as the Hub's last provision would have:
  // { exhaustedAt, retryAt?, manual? } or { authFailedAt, authFailures? }.
  h.boot = async function boot({ keyIds = ['dk_a', 'dk_b'], distribution = 'sticky', env = {}, states = {}, gateways = {}, modelMap = null } = {}) {
    if (h.bridge) {
      const exited = new Promise((r) => h.bridge.once('exit', r));
      h.bridge.kill('SIGTERM');
      await exited;
    }
    h.proxyPort = await freePort();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(KIMI_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, 'bridge.json'),
      JSON.stringify({
        deepseekPool: {
          port: h.proxyPort,
          token: TOKEN,
          gateway: 'opencode-go',
          revision: 1,
          activeId: keyIds[0],
          models: [{ model: 'deepseek-v4.1-flash', max_context_size: 1_000_000 }],
          rotation: 1,
          ...(distribution ? { distribution } : {}),
          ...(modelMap ? { modelMap } : {}),
          keys: keyIds.map((id) => ({ id, apiKey: keys[id], gateway: gateways[id] || 'opencode-go', ...(states[id] || {}) })),
        },
      }),
      { mode: 0o600 },
    );
    h.hubMessages = [];
    h.upstreamRequests = [];
    h.behaviours = new Map();
    const connected = nextHello();
    const e = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${h.upstream.address().port}`, ...env };
    h.bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${h.hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env: e, stdio: 'ignore' });
    await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
  };

  before(async () => {
    h.upstream = fakeUpstream();
    await new Promise((r) => h.upstream.listen(0, '127.0.0.1', r));
    h.hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
    await new Promise((r) => h.hubWss.on('listening', r));
    h.hubWss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') {
          h.hubWs = ws;
          h.lastHello = m;
          const waiters = helloWaiters;
          helloWaiters = [];
          for (const r of waiters) r();
          return;
        }
        h.hubMessages.push(m);
      });
    });
  });
  beforeEach(() => {
    h.upstreamRequests = [];
    h.behaviours = new Map();
    h.hubMessages = [];
  });
  after(() => {
    h.bridge?.kill('SIGTERM');
    h.hubWss?.close();
    h.upstream?.close();
    setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
  });

  // (A new connection for each request, on purpose: Node's fetch reuses idle connections and, on this
  // machine, loses up to two seconds on one now and then - which would make every timing here flaky.)
  h.chat = (session, extra = {}) =>
    new Promise((resolve, reject) => {
      // (Kimi puts prompt_cache_key last in its bodies.)
      const body = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }], ...(session ? { prompt_cache_key: session } : {}), ...extra });
      const req = http.request(
        { host: '127.0.0.1', port: h.proxyPort, path: '/opencode-go/chat/completions', method: 'POST', agent: false, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null }, text: async () => text });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  h.ask = async (session, extra) => {
    const res = await h.chat(session, extra);
    const status = res.status;
    await res.text();
    return status;
  };
  // How many conversations each key ended up with, from the requests the gateway saw
  // (the last key a conversation arrived on).
  h.perKey = () => {
    const last = new Map();
    for (const u of h.upstreamRequests) if (u.session) last.set(u.session, u.key);
    const out = {};
    for (const k of last.values()) out[k] = (out[k] || 0) + 1;
    return out;
  };
  h.keysSeen = () => {
    const out = {};
    for (const u of h.upstreamRequests) out[u.key] = (out[u.key] || 0) + 1;
    return out;
  };
  h.lastPoolReport = () => h.hubMessages.filter((m) => m.t === 'deepseek.pool').at(-1);
  h.reportedKey = (id) => h.lastPoolReport()?.keys.find((k) => k.id === id);
  // The request records the connector sent (every attempt, in the order they were written).
  h.records = () => h.hubMessages.filter((m) => m.t === 'deepseek.requests').flatMap((m) => m.records);
  h.sessions = (n, prefix = 'session_conv') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  return h;
}
