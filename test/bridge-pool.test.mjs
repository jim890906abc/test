// The bridge's DeepSeek key pool: one loopback OpenAI-compatible proxy per
// connector, started on provision and persisted across restarts. Kimi's
// provider only ever sees a random local token; the proxy replaces it with
// the active upstream key and moves to the next key only for an explicit
// quota/credit/balance error that arrives before anything reached the client.
// A fake Kimi server and a fake upstream gateway, the real bridge, no account.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dspool-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const STATE_DIR = path.join(TMP, 'state');
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');
const MANAGED = 'managed:kimi-code';
const SUB = 'managed:kimi-code/kimi-for-coding';
const DS = 'agent-hub-deepseek';
const KEY_A = 'sk-pool-key-aaaa-1111';
const KEY_B = 'sk-pool-key-bbbb-2222';
const KEY_C = 'sk-pool-key-cccc-3333';

let bridge;
let kimi;
let upstream;
let hubWss;
let hubWs;
let upstreamRequests = [];
let responses = new Map(); // upstream key -> async (req, res, body) => void
let helloWaiters = [];
let lastHello = null;

// ------------------------------------------------------------ fake Kimi
let state;
let writes;
function toml() {
  const lines = [];
  if (state.defaultModel) lines.push(`default_model = "${state.defaultModel}"`, '');
  if (state.secondaryModel) {
    const s = state.secondaryModel;
    const defaultModel = s.defaultModel ?? s.default_model ?? s.model;
    const effort = s.defaultEffort ?? s.default_effort;
    const pool = s.models && typeof s.models === 'object' ? s.models : null;
    lines.push('[secondary_model]');
    if (defaultModel) lines.push(`default_model = "${defaultModel}"`);
    if (effort) lines.push(`default_effort = "${effort}"`);
    if (s.force === true) lines.push('force = true');
    if (pool) lines.push('', '[secondary_model.models]', ...Object.entries(pool).map(([k, v]) => `"${k}" = ${JSON.stringify(String(v ?? ''))}`));
    lines.push('');
  }
  for (const [id, p] of Object.entries(state.providers)) {
    lines.push(`[providers.${id.includes(':') ? `"${id}"` : id}]`, `type = "${p.type}"`, `base_url = "${p.base_url || ''}"`);
    if (p.api_key) lines.push(`api_key = "${p.api_key}"`);
    if (p.custom_headers) lines.push(`[providers.${id}.custom_headers]`, ...Object.entries(p.custom_headers).map(([k, v]) => `${k} = "${v}"`));
    lines.push('');
  }
  for (const [alias, m] of Object.entries(state.models)) lines.push(`[models."${alias}"]`, `provider = "${m.provider}"`, '');
  return lines.join('\n');
}
const writeToml = () => fs.writeFileSync(path.join(KIMI_HOME, 'config.toml'), toml());

// Kimi reloads config.toml after the bridge removes the [secondary_model]
// table it wrote; GET /config reads that table back from disk.
function syncSecondaryFromToml() {
  let text;
  try {
    text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  } catch {
    return;
  }
  const value = (v) => {
    const t = String(v).trim();
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {}
    }
    return t;
  };
  let head = '';
  let parent = null;
  let pool = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      head = t.replace(/\s+/g, '');
      if (head === '[secondary_model]') parent = {};
      if (head === '[secondary_model.models]') pool = parent ? {} : null;
      continue;
    }
    if (!t || t.startsWith('#') || !parent) continue;
    const m = t.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!m) continue;
    if (head === '[secondary_model.models]' && pool) pool[value(m[1])] = value(m[2]);
    else if (head === '[secondary_model]') {
      const key = value(m[1]);
      const camel = key === 'default_model' ? 'defaultModel' : key === 'default_effort' ? 'defaultEffort' : key;
      parent[camel] = m[2].trim() === 'true' ? true : m[2].trim() === 'false' ? false : value(m[2]);
    }
  }
  if (!parent) {
    state.secondaryModel = undefined;
    return;
  }
  if (pool) parent.models = pool;
  if (parent.force === undefined) parent.force = false;
  state.secondaryModel = parent;
}
function fresh() {
  state = {
    defaultModel: SUB,
    defaultProvider: MANAGED,
    thinking: { enabled: true, effort: 'high' },
    secondaryModel: undefined,
    providers: { [MANAGED]: { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', default_model: SUB, oauth: true, models: [SUB] }, other: { type: 'openai', base_url: 'https://other.example/v1', models: ['other/m'] } },
    models: { [SUB]: { provider: MANAGED, display_name: 'kimi-for-coding' }, 'other/m': { provider: 'other', display_name: 'm' } },
    managedDefault: SUB,
  };
  writes = [];
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  writeToml();
}

function fakeKimi() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = decodeURIComponent(req.url.split('?')[0]);
      const ok = (data, code = 0) => {
        if (req.method !== 'GET') writeToml();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code, msg: 'success', data }));
      };
      const err = (code, msg) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ code, msg, data: null })));
      if (req.method !== 'GET') writes.push([req.method, url, body]);
      if (url === '/api/v1/healthz') return ok({ ok: true });
      if (req.method === 'GET' && url === '/api/v1/config') {
        syncSecondaryFromToml();
        return ok({ ...(state.defaultModel ? { default_model: state.defaultModel } : {}), default_provider: state.defaultProvider, thinking: state.thinking, ...(state.secondaryModel ? { secondary_model: state.secondaryModel } : {}) });
      }
      if (req.method === 'GET' && url === '/api/v1/providers') {
        return ok({
          items: Object.entries(state.providers).map(([id, p]) => ({ id, type: p.type, base_url: p.base_url, ...(id === MANAGED && state.managedDefault ? { default_model: state.managedDefault } : {}), has_api_key: true, status: 'connected', models: p.models })),
        });
      }
      if (req.method === 'POST' && url === '/api/v1/config') {
        for (const [id, p] of Object.entries(body.providers || {})) {
          if (!state.providers[id]) return err(40001, 'no such provider');
          state.providers[id].custom_headers = { ...(state.providers[id].custom_headers || {}), ...(p.custom_headers || {}) };
        }
        if (body.secondary_model !== undefined) {
          const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          const cur = state.secondaryModel || {};
          const next = { ...cur };
          for (const [k, v] of Object.entries(body.secondary_model || {})) {
            if (k === 'models') next.models = { ...(cur.models || {}), ...(v || {}) };
            else next[camel(k)] = v;
          }
          const model = next.defaultModel ?? next.model ?? Object.keys(next.models || {})[0];
          if (!model || !state.models[model]) return err(40113, `model does not exist: ${String(model)}`);
          if (next.force === true && next.models !== undefined) return err(40001, 'force cannot be combined with models');
          if (next.models !== undefined && next.defaultModel !== undefined && !(next.defaultModel in next.models)) return err(40001, 'default_model is not a models key');
          for (const alias of Object.keys(next.models || {})) if (!state.models[alias]) return err(40113, `model does not exist: ${alias}`);
          state.secondaryModel = next;
        }
        return ok({});
      }
      if (req.method === 'GET' && url === '/api/v1/models') return ok({ items: Object.entries(state.models).map(([model, m]) => ({ model, provider: m.provider, display_name: m.display_name, max_context_size: 1000 })) });
      const pin = url.match(/^\/api\/v1\/models\/(.+):set_default$/);
      if (req.method === 'POST' && pin) {
        if (!state.models[pin[1]]) return err(40113, 'model does not exist');
        state.defaultModel = pin[1];
        return ok({ default_model: pin[1] });
      }
      const alias = (id, models) => Object.fromEntries(models.map((m) => [`${id}/${m.model}`, { provider: id, display_name: m.display_name || m.model }]));
      if (req.method === 'POST' && url === '/api/v1/providers') {
        if (state.providers[body.id]) return err(40901, `provider ${body.id} already exists`);
        state.providers[body.id] = { type: body.type, base_url: body.base_url, api_key: body.api_key, models: body.models.map((m) => `${body.id}/${m.model}`) };
        Object.assign(state.models, alias(body.id, body.models));
        if (!state.defaultModel) state.defaultModel = `${body.id}/${body.models[0].model}`;
        res.statusCode = 201;
        return ok(state.providers[body.id]);
      }
      const one = url.match(/^\/api\/v1\/providers\/([\w -]+)$/);
      if (req.method === 'PUT' && one) {
        const p = state.providers[one[1]];
        if (!p) return err(40401, 'provider does not exist');
        for (const a of p.models) delete state.models[a];
        Object.assign(p, { type: body.type, base_url: body.base_url, api_key: body.api_key, models: body.models.map((m) => `${one[1]}/${m.model}`) });
        Object.assign(state.models, alias(one[1], body.models));
        return ok({ provider: p });
      }
      if (req.method === 'DELETE' && one) {
        const p = state.providers[one[1]];
        if (!p) return err(40401, 'provider does not exist');
        for (const a of p.models) delete state.models[a];
        delete state.providers[one[1]];
        writeToml();
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      err(404, 'no route');
    });
  });
  new WebSocketServer({ server: srv, path: '/api/v1/ws' });
  return srv;
}

// -------------------------------------------------------- fake upstream
const success = (res, text = 'pool answer') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const quota = (res, status = 402, code = 'insufficient_quota') => {
  const body = JSON.stringify({ error: { code, message: 'You exceeded your current quota' } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
function fakeUpstream() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null;
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      upstreamRequests.push({ url: req.url, key, body, headers: req.headers });
      const handler = responses.get(key);
      try {
        if (handler) await handler(req, res, body);
        else success(res);
      } catch {
        try {
          res.destroy();
        } catch {}
      }
    });
  });
  return srv;
}

// --------------------------------------------------------------- hub
const pending = new Map();
let reports = [];
const ask = (op, args) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no answer for ${op}`));
    }, 20000);
    pending.set(id, { resolve, timer });
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
  });
const nextHello = () => new Promise((resolve) => helloWaiters.push(resolve));

// Make sure the running connector has exactly this extra environment.
const withBridgeEnv = async (extraEnv = {}) => {
  if (JSON.stringify(extraEnv) !== bridgeEnvKey) await restartBridge(extraEnv);
};
// Stop the connector and start another on the same state, with extra
// environment (the proxy's timeouts and retry waits are read at start).
let bridgeEnvKey = '{}';
async function restartBridge(extraEnv = {}) {
  bridgeEnvKey = JSON.stringify(extraEnv);
  const exited = new Promise((r) => bridge.once('exit', r));
  bridge.kill('SIGTERM');
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  const connected = nextHello();
  const env = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}`, ...extraEnv };
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('restarted bridge did not connect')), 15000))]);
}

const models = (names = ['deepseek-v4.1-flash', 'deepseek-v4-pro']) =>
  names.map((model) => ({ model, display_name: `DS ${model}`, max_context_size: 1_000_000, max_output_size: 384_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] }));
const key = (id, apiKey, exhaustedAt) => ({ id, apiKey, ...(exhaustedAt ? { exhaustedAt } : {}) });
const pool = (keys, revision = 1, activeId = keys[0].id) => ({ revision, activeId, keys });
const provision = (over = {}) => ask('kimi.deepseek.provision', { gateway: 'opencode-go', models: models(), ...over });

const provider = () => state.providers[DS];
const localToken = () => provider().api_key;
const localBase = () => provider().base_url;
const chat = (body = {}, token = localToken()) =>
  fetch(`${localBase()}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
const request = (options, body) =>
  new Promise((resolve, reject) => {
    const url = options.url || `${localBase()}${options.path || '/chat/completions'}`;
    const req = http.request(url, { method: options.method || 'POST', headers: options.headers || {} }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

before(async () => {
  kimi = fakeKimi();
  await new Promise((r) => kimi.listen(0, '127.0.0.1', r));
  upstream = fakeUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = kimi.address().port;
  fs.mkdirSync(path.join(KIMI_HOME, 'server', 'instances'), { recursive: true });
  fs.writeFileSync(path.join(KIMI_HOME, 'server', 'instances', 'a.json'), JSON.stringify({ port, host: '127.0.0.1', pid: process.pid, server_id: 'srv1', started_at: Date.now() }));
  fs.writeFileSync(path.join(KIMI_HOME, 'server.token'), 'server-token');
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
      }
      if (m.t === 'deepseek.pool') reports.push(m);
      if (m.t === 'res' && pending.has(m.id)) {
        const p = pending.get(m.id);
        clearTimeout(p.timer);
        p.resolve(m);
        pending.delete(m.id);
      }
    });
  });
  const env = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}` };
  const connected = nextHello();
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge did not connect')), 15000))]);
});

beforeEach(() => {
  fresh();
  upstreamRequests = [];
  responses = new Map();
  reports = [];
});

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  kimi?.close();
  upstream?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

// --------------------------------------------------------------- tests

test('a pool provision points Kimi at a loopback proxy with a local token, never an upstream key', async () => {
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool.revision, 1);
  assert.equal(provider().base_url, localBase());
  assert.match(provider().base_url, /^http:\/\/127\.0\.0\.1:\d+\/opencode-go$/);
  assert.match(provider().api_key, /^ah_local_[0-9a-f]{32}$/);
  assert.notEqual(provider().api_key, KEY_A);
  assert.notEqual(provider().api_key, KEY_B);
  // The provider still belongs to the same Kimi setup: default untouched.
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.defaultProvider, MANAGED);
  assert.deepEqual(state.thinking, { enabled: true, effort: 'high' });
  assert.deepEqual(state.secondaryModel, { defaultModel: `${DS}/deepseek-v4.1-flash`, defaultEffort: 'max', force: false });
  assert.deepEqual(r.data.secondaryModel, { model: `${DS}/deepseek-v4.1-flash`, models: [], force: false, effort: 'max' });
  // The local token is the only credential in config.toml.
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.ok(text.includes(provider().api_key));
  assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B));
  // The report carries ids/health only.
  await new Promise((r) => setTimeout(r, 100));
  const report = reports.find((x) => x.gateway === 'opencode-go' && x.revision === 1);
  assert.ok(report, JSON.stringify(reports));
  assert.deepEqual(report.keys.map((k) => k.id), ['dk_a', 'dk_b']);
  assert.equal(report.activeId, 'dk_a');
  assert.ok(!JSON.stringify(report).includes('sk-pool'));
});

test('a provision starts requests on the preferred active key, not the first key in the list', async () => {
  responses.set(KEY_A, (req, res) => success(res, 'a'));
  responses.set(KEY_B, (req, res) => success(res, 'b'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)], 1, 'dk_b') });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool.activeId, 'dk_b');
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /b/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B]);
});

test('the same request moves from the first key to the second when the first says insufficient_quota', async () => {
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => success(res, 'second key answered'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const body = { model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'same request' }] };
  const res = await chat(body);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /second key answered/);
  assert.equal(upstreamRequests.length, 2, JSON.stringify(upstreamRequests.map((x) => x.key)));
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A, KEY_B]);
  assert.equal(upstreamRequests[0].headers.authorization, `Bearer ${KEY_A}`);
  assert.ok(!JSON.stringify(upstreamRequests[0].headers).includes(localToken()), 'the local proxy token never goes upstream');
  assert.equal(upstreamRequests[0].headers['x-api-key'], undefined);
  // Both attempts sent exactly the same model, effort and body.
  assert.deepEqual(upstreamRequests[0].body, body);
  assert.deepEqual(upstreamRequests[1].body, body);
  assert.equal(upstreamRequests[0].body.model, 'deepseek-v4.1-flash');
  assert.equal(upstreamRequests[0].body.reasoning_effort, 'max');
  // The exhausted key is reported, and the actual active key moved on.
  await new Promise((r) => setTimeout(r, 100));
  const report = reports.filter((x) => x.revision === 1).at(-1);
  assert.equal(report.activeId, 'dk_b');
  assert.ok(report.keys.find((k) => k.id === 'dk_a').exhaustedAt);
  assert.equal(report.keys.find((k) => k.id === 'dk_b').exhaustedAt, undefined);
  assert.ok(!JSON.stringify(reports).includes(KEY_A));
  assert.ok(!JSON.stringify(reports).includes(KEY_B));
});

test('two parallel requests failing the same key both try the second, never skipping the third', async () => {
  let arrivals = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  responses.set(KEY_A, async (req, res) => {
    arrivals++;
    if (arrivals === 2) release();
    await gate;
    quota(res, 429, 'insufficient_quota');
  });
  responses.set(KEY_B, (req, res) => success(res, 'b'));
  responses.set(KEY_C, (req, res) => success(res, 'c'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B), key('dk_c', KEY_C)]) });
  assert.equal(r.ok, true, r.error);
  const body = { model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'parallel' }] };
  const [one, two] = await Promise.all([chat(body), chat(body)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.match(await one.text(), /b/);
  assert.match(await two.text(), /b/);
  const counts = (k) => upstreamRequests.filter((x) => x.key === k).length;
  assert.equal(counts(KEY_A), 2);
  assert.equal(counts(KEY_B), 2);
  assert.equal(counts(KEY_C), 0, 'the third key was never skipped to');
  // A report never moves the active pointer over the third key.
  await new Promise((r) => setTimeout(r, 100));
  const report = reports.filter((x) => x.revision === 1).at(-1);
  assert.equal(report.activeId, 'dk_b');
});

test('all keys exhausted: a clear 402, each key tried once, and no further upstream calls', async () => {
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => quota(res, 429, 'quota_exceeded'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const body = { model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'all' }] };
  const first = await chat(body);
  assert.equal(first.status, 402);
  const j = JSON.parse(await first.text());
  assert.equal(j.error.code, 'insufficient_quota');
  assert.ok(!JSON.stringify(j).includes(KEY_A) && !JSON.stringify(j).includes(KEY_B));
  assert.equal(upstreamRequests.length, 2);
  const before = upstreamRequests.length;
  const second = await chat(body);
  assert.equal(second.status, 402);
  assert.equal(JSON.parse(await second.text()).error.code, 'insufficient_quota');
  assert.equal(upstreamRequests.length, before, 'no loop after every key is known exhausted');
});

test('non-quota failures never move the pool', async () => {
  const cases = [
    [401, 'invalid_api_key', 'Unauthorized'],
    [402, 'payment_required', 'Payment required'],
    [403, 'upgrade_required', 'This plan has no API access'],
    [429, 'rate_limit_exceeded', 'Rate limit reached for requests'],
    [500, 'server_error', 'internal error'],
  ];
  for (const [status, code, message] of cases) {
    fresh();
    upstreamRequests = [];
    responses = new Map();
    responses.set(KEY_A, (req, res) => {
      const body = JSON.stringify({ error: { code, message } });
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    responses.set(KEY_B, (req, res) => success(res, 'should not happen'));
    const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
    assert.equal(r.ok, true, r.error);
    const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
    assert.equal(res.status, status, `${status} ${code}`);
    assert.equal(upstreamRequests.length, 1, `${status} ${code} retried`);
    assert.equal(upstreamRequests[0].key, KEY_A);
    await res.text();
  }
  // A network error is not a quota signal either.
  fresh();
  upstreamRequests = [];
  responses = new Map();
  responses.set(KEY_A, (req, res) => {
    req.socket.destroy();
  });
  responses.set(KEY_B, (req, res) => success(res, 'should not happen'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  assert.equal(res.status, 502);
  assert.equal(upstreamRequests.length, 1);
});

// What counts as "this key's quota is gone" is decided from the error's own
// code / message fields and its status, never from words that happen to occur
// anywhere in the body (an upstream often echoes the request it refused).
const jsonError = (status, error, extra = {}) => (req, res) => {
  const body = JSON.stringify({ error, ...extra });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const textError = (status, text) => (req, res) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
};
async function poolOutcome(handlerA) {
  fresh();
  upstreamRequests = [];
  responses = new Map();
  reports = [];
  responses.set(KEY_A, handlerA);
  responses.set(KEY_B, (req, res) => success(res, 'second key answered'));
  responses.set(KEY_C, (req, res) => success(res, 'third key answered'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B), key('dk_c', KEY_C)]) });
  assert.equal(r.ok, true, r.error);
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'x' }] });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 80));
  const last = reports.filter((x) => x.revision === 1).at(-1);
  return { status: res.status, text, upstream: upstreamRequests.map((x) => x.key), exhausted: (last?.keys || []).filter((k) => k.exhaustedAt).map((k) => k.id), saved: JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).deepseekPool.keys.filter((k) => k.exhaustedAt).map((k) => k.id) };
}

test('a 400 whose message echoes quota words marks no key exhausted and reaches Kimi as it is', async () => {
  const echo = jsonError(400, { code: 'invalid_request_error', message: 'Your request mentioned insufficient_quota, quota exceeded and no credits in the prompt' });
  const first = await poolOutcome(echo);
  assert.equal(first.status, 400);
  assert.deepEqual(first.upstream, [KEY_A], 'no other key was tried');
  assert.deepEqual(first.exhausted, [], 'nothing reported as exhausted');
  assert.deepEqual(first.saved, [], 'nothing persisted as exhausted');
  // The pool is still whole: a normal request goes to the first key and works.
  responses.set(KEY_A, (req, res) => success(res, 'a is fine'));
  upstreamRequests = [];
  const again = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(again.status, 200);
  assert.match(await again.text(), /a is fine/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A]);
});

test('401/404/409/422/5xx never rotate, even with a quota code (400 and 403 do: see the credits tests below)', async () => {
  for (const status of [401, 404, 409, 422, 500, 502, 503]) {
    const out = await poolOutcome(jsonError(status, { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' }));
    assert.equal(out.status, status, `status ${status}`);
    assert.deepEqual(out.upstream, [KEY_A], `status ${status} tried another key`);
    assert.deepEqual(out.exhausted, [], `status ${status} marked a key exhausted`);
  }
});

test('a transient 429 never rotates, whatever its message says about usage or quota', async () => {
  const cases = [
    jsonError(429, { code: 'rate_limited', message: 'Too many requests: per-minute usage limit, retry in 3s' }),
    jsonError(429, { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests. You exceeded your current quota of requests per minute' }),
    jsonError(429, { type: 'rate_limit_error', message: 'insufficient credits for this burst; retry after 2 seconds' }),
    textError(429, 'Too Many Requests: slow down, per-minute usage limit'),
    (req, res) => (res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' }), res.end('{"error":{"message":"slow down"}}')),
  ];
  for (const [i, handler] of cases.entries()) {
    const out = await poolOutcome(handler);
    assert.equal(out.status, 429, `case ${i}`);
    assert.deepEqual(out.upstream, [KEY_A], `case ${i} rotated`);
    assert.deepEqual(out.exhausted, [], `case ${i} marked exhausted`);
  }
});

test('quota words outside the error object (an echoed request) are not a quota signal', async () => {
  const out = await poolOutcome(jsonError(429, { code: 'invalid_request', message: 'bad request' }, { echo: { prompt: 'please explain insufficient_quota and quota exceeded' }, detail: 'no credits' }));
  assert.equal(out.status, 429);
  assert.deepEqual(out.upstream, [KEY_A]);
  assert.deepEqual(out.exhausted, []);
});

test('an explicit quota/credit/balance error on 402 or 429 still rotates to the next key', async () => {
  const cases = [
    ['402 code', jsonError(402, { code: 'insufficient_quota', message: 'x' })],
    ['429 type', jsonError(429, { type: 'insufficient_quota', message: 'x' })],
    ['429 usage_limit_reached', jsonError(429, { code: 'usage_limit_reached', message: 'x' })],
    ['402 balance message, no code', jsonError(402, { message: 'Insufficient balance. Please top up.' })],
    ['402 plain text', textError(402, 'insufficient balance')],
    ['429 credits message', jsonError(429, { message: 'You have no credits remaining on this key' })],
    ['402 envelope with generic types', (req, res) => (res.writeHead(402, { 'content-type': 'application/json' }), res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is exhausted' } })))],
  ];
  for (const [name, handler] of cases) {
    const out = await poolOutcome(handler);
    assert.equal(out.status, 200, name);
    assert.match(out.text, /second key answered/, name);
    assert.deepEqual(out.upstream, [KEY_A, KEY_B], name);
    assert.deepEqual(out.exhausted, ['dk_a'], name);
  }
});

// The proxy must not wait on a silent gateway forever: Kimi would show a
// subagent "running" with nothing behind it.
test('an upstream that never answers gets a clear 504 after the first-byte timeout, without moving the pool', async () => {
  await withBridgeEnv({ AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS: '500', AGENT_HUB_DEEPSEEK_IDLE_MS: '600' });
  const hung = [];
  responses.set(KEY_A, (req, res) => {
    hung.push(res); // never answered
  });
  responses.set(KEY_B, (req, res) => success(res, 'should not be tried'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const t0 = Date.now();
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 504);
  assert.ok(elapsed >= 450 && elapsed < 5000, `timed out after ${elapsed} ms`);
  const j = JSON.parse(await res.text());
  assert.equal(j.error.code, 'upstream_timeout');
  assert.match(j.error.message, /沒有回應/);
  assert.ok(!JSON.stringify(j).includes(KEY_A));
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A], 'a timeout is not a quota signal: the second key is not tried');
  await new Promise((r) => setTimeout(r, 100));
  const last = reports.filter((x) => x.revision === 1).at(-1);
  assert.ok(!last || !last.keys.some((k) => k.exhaustedAt), 'no key was marked exhausted');
  // The proxy is still serving: the next request goes through.
  responses.set(KEY_A, (req, res) => success(res, 'back again'));
  const next = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(next.status, 200);
  assert.match(await next.text(), /back again/);
  for (const h of hung) h.destroy();
});

test('an upstream that sends headers but no first byte is also a 504, not an empty 200', async () => {
  await withBridgeEnv({ AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS: '500', AGENT_HUB_DEEPSEEK_IDLE_MS: '600' });
  responses.set(KEY_A, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders(); // headers out, body never starts
    setTimeout(() => res.destroy(), 4000).unref();
  });
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const res = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(res.status, 504);
  assert.equal(JSON.parse(await res.text()).error.code, 'upstream_timeout');
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A]);
});

test('a stream that stalls after some bytes is cut at the idle timeout and never replayed', async () => {
  await withBridgeEnv({ AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS: '500', AGENT_HUB_DEEPSEEK_IDLE_MS: '600' });
  responses.set(KEY_A, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    setTimeout(() => res.destroy(), 4000).unref(); // then silence
  });
  responses.set(KEY_B, (req, res) => success(res, 'replayed'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const t0 = Date.now();
  const res = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(res.status, 200);
  let text = '';
  try {
    text = await res.text();
  } catch {
    // the connection was cut: Kimi sees a network error and decides itself
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3500, `the stalled stream was cut after ${elapsed} ms`);
  assert.doesNotMatch(text, /replayed/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A], 'bytes had gone out: no second attempt');
});

test('with the default waits a slow-but-alive gateway is not cut', async () => {
  await withBridgeEnv({});
  const r = await provision({ pool: pool([key('dk_a', KEY_A)]) });
  assert.equal(r.ok, true, r.error);
  // A slow-but-alive answer well inside the default first-byte wait succeeds.
  responses.set(KEY_A, async (req, res) => {
    await new Promise((r) => setTimeout(r, 700));
    success(res, 'slow but fine');
  });
  const res = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /slow but fine/);
});

test('a stream that already sent bytes is never replayed, even if it ends with a quota error', async () => {
  responses.set(KEY_A, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    res.write('data: {"error":{"code":"insufficient_quota","message":"quota exceeded"}}\n\n');
    res.end();
  });
  responses.set(KEY_B, (req, res) => success(res, 'replayed'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /partial/);
  assert.doesNotMatch(text, /replayed/);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].key, KEY_A);
});

test('the local proxy rejects a bad token, an unknown path and an oversized body before upstream', async () => {
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const bad = await chat({ model: 'x' }, 'wrong-token');
  assert.equal(bad.status, 401);
  const unknown = await request({ url: `${new URL(localBase()).origin}/other-gateway/chat/completions`, headers: { authorization: `Bearer ${localToken()}`, 'content-type': 'application/json' } }, '{}');
  assert.equal(unknown.status, 404);
  const big = await request(
    { path: '/opencode-go/chat/completions', headers: { authorization: `Bearer ${localToken()}`, 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024 + 1) } },
    '',
  );
  assert.equal(big.status, 413);
  assert.equal(upstreamRequests.length, 0);
});

// ---------------------------------------------------------------- recovery
// An exhausted key must not stay exhausted forever. Rule (spec 13.1/13.2): it
// waits (the gateway's own Retry-After / reset time when it names one, else
// the pool's retryMs, else AGENT_HUB_DEEPSEEK_RETRY_MS, else 10 minutes);
// when no healthy key is left, the next real request tries a key whose wait
// is over. A success clears the mark and the next report carries the proof
// (recoveredAt, and which exhaustion it disproves); another quota error
// starts a fresh wait.
const RETRY_ENV = { AGENT_HUB_DEEPSEEK_RETRY_MS: '700' };
const lastReport = async () => (await new Promise((r) => setTimeout(r, 120)), reports.filter((x) => x.revision === 1).at(-1));

test('an exhausted key is tried again by a real request once its wait is over, and the success is proven to the hub', async () => {
  await withBridgeEnv(RETRY_ENV);
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => success(res, 'b answered'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const ask1 = () => chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'x' }] }).then(async (res) => ({ status: res.status, text: await res.text() }));
  assert.equal((await ask1()).status, 200);
  const exhaustedAt = (await lastReport()).keys.find((k) => k.id === 'dk_a').exhaustedAt;
  assert.ok(exhaustedAt);

  // A is healthy again at the gateway, but B is healthy too: the wait being
  // over is not a reason to touch A while a healthy key can answer.
  responses.set(KEY_A, (req, res) => success(res, 'a is back'));
  await new Promise((r) => setTimeout(r, 900));
  upstreamRequests = [];
  assert.equal((await ask1()).status, 200);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B]);

  // B runs dry: the request falls to A, whose wait is over; that request is
  // the probe and it succeeds.
  responses.set(KEY_B, (req, res) => quota(res, 429, 'quota_exceeded'));
  upstreamRequests = [];
  const third = await ask1();
  assert.equal(third.status, 200);
  assert.match(third.text, /a is back/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B, KEY_A]);
  const report = await lastReport();
  const a = report.keys.find((k) => k.id === 'dk_a');
  assert.equal(a.exhaustedAt, undefined, 'the mark is gone');
  assert.ok(a.recoveredAt > exhaustedAt, 'the proof is later than the exhaustion');
  assert.equal(a.recoveredFrom, exhaustedAt, 'and names the exhaustion it disproves');
  assert.ok(report.keys.find((k) => k.id === 'dk_b').exhaustedAt, 'B is now the exhausted one');
  assert.equal(report.activeId, 'dk_a');
  const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).deepseekPool.keys.find((k) => k.id === 'dk_a');
  assert.equal(persisted.exhaustedAt, undefined);
  assert.equal(persisted.recoveredFrom, exhaustedAt);
});

test('a key that is still out of quota when its wait is over starts a new wait, one probe per key per wait', async () => {
  await withBridgeEnv(RETRY_ENV);
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => quota(res, 402, 'insufficient_quota'));
  const r = await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) });
  assert.equal(r.ok, true, r.error);
  const go = () => chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] }).then(async (res) => ({ status: res.status, body: JSON.parse(await res.text()) }));
  const first = await go();
  assert.equal(first.status, 402);
  assert.equal(first.body.error.code, 'insufficient_quota');
  assert.ok(first.body.error.retry_at > Date.now(), 'the error says when the next automatic try is');
  assert.match(first.body.error.message, /自動再試/);
  assert.match(first.body.error.message, /重新啟用|新的 key/, 'and how to recover now');
  assert.equal(upstreamRequests.length, 2);
  // Inside the wait: no upstream traffic at all.
  upstreamRequests = [];
  assert.equal((await go()).status, 402);
  assert.equal(upstreamRequests.length, 0);
  // After the wait: each key is probed once, then quiet again.
  await new Promise((r) => setTimeout(r, 900));
  const again = await go();
  assert.equal(again.status, 402);
  assert.deepEqual(upstreamRequests.map((x) => x.key).sort(), [KEY_A, KEY_B].sort());
  const quiet = upstreamRequests.length;
  assert.equal((await go()).status, 402);
  assert.equal(upstreamRequests.length, quiet, 'the failed probe started a new wait');
  const report = await lastReport();
  assert.ok(report.keys.every((k) => k.exhaustedAt && k.exhaustedAt > Date.now() - 800), 'exhaustion was re-stamped by the failed probe');
});

test('the gateway\'s own reset time (Retry-After) decides when its key is tried again', async () => {
  await withBridgeEnv({});
  let answers = 0;
  responses.set(KEY_A, (req, res) => {
    answers++;
    if (answers === 1) {
      const body = JSON.stringify({ error: { code: 'usage_limit_reached', message: 'x' } });
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    success(res, 'a after its own reset time');
  });
  const r = await provision({ pool: pool([key('dk_a', KEY_A)]) });
  assert.equal(r.ok, true, r.error);
  const go = () => chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] }).then(async (res) => ({ status: res.status, text: await res.text() }));
  assert.equal((await go()).status, 402, 'the only key is out of quota');
  const report = await lastReport();
  const a = report.keys.find((k) => k.id === 'dk_a');
  assert.ok(a.retryAt >= a.exhaustedAt + 900 && a.retryAt <= a.exhaustedAt + 1500, `retryAt follows Retry-After: ${a.retryAt - a.exhaustedAt} ms`);
  assert.equal((await go()).status, 402, 'still inside the gateway\'s wait (the default 10 minutes would never have ended)');
  await new Promise((r) => setTimeout(r, 1100));
  const back = await go();
  assert.equal(back.status, 200);
  assert.match(back.text, /after its own reset time/);
});

test('exhaustion the hub sends with a short retryMs is retried by the first request that needs it', async () => {
  await withBridgeEnv({});
  responses.set(KEY_A, (req, res) => success(res, 'recovered before the provision'));
  const r = await provision({ pool: { ...pool([key('dk_a', KEY_A, Date.now() - 60_000)]), retryMs: 1000 } });
  assert.equal(r.ok, true, r.error);
  const res = await chat({ model: 'deepseek-v4.1-flash', stream: true, messages: [] });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /recovered before the provision/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A]);
});

test('a new revision replaces the key set: removed keys are gone and never come back in reports', async () => {
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => success(res, 'b'));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)], 1, 'dk_a') })).ok, true);
  const first = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  assert.equal(first.status, 200);
  await first.text();
  // Revision 2 removes dk_a, prefers dk_b, and clears its health.
  const r2 = await provision({ pool: pool([key('dk_b', KEY_B)], 2, 'dk_b') });
  assert.equal(r2.ok, true, r2.error);
  await new Promise((r) => setTimeout(r, 100));
  const report = reports.filter((x) => x.revision === 2).at(-1);
  assert.ok(report);
  assert.deepEqual(report.keys.map((k) => k.id), ['dk_b']);
  assert.equal(report.activeId, 'dk_b');
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).deepseekPool;
  assert.deepEqual(saved.keys.map((k) => k.id), ['dk_b']);
  assert.ok(!JSON.stringify(saved).includes(KEY_A));
  assert.ok(!JSON.stringify(reports).includes(KEY_A));
});

test('remove deletes the provider and the persisted pool, leaving no key material', async () => {
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)], 3, 'dk_a') })).ok, true);
  const r = await ask('kimi.deepseek.remove', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.removed, true);
  assert.equal(r.data.secondaryRemoved, true);
  assert.equal(state.providers[DS], undefined);
  assert.ok(state.providers[MANAGED] && state.providers.other, 'other providers are untouched');
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.secondaryModel, undefined, 'the hub-created subagent default is gone');
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.equal(saved.deepseekPool, undefined);
  assert.ok(!JSON.stringify(saved).includes(KEY_A));
  assert.ok(!JSON.stringify(saved).includes(KEY_B));
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B));
  assert.doesNotMatch(text, /\[secondary_model\]|agent-hub-deepseek\//, 'no dangling subagent alias');
  // A later pool starts a fresh loopback proxy and works from the first key.
  const again = await provision({ pool: pool([key('dk_c', KEY_C)], 4, 'dk_c') });
  assert.equal(again.ok, true, again.error);
  responses.set(KEY_C, (req, res) => success(res, 'fresh proxy'));
  const res = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [] });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /fresh proxy/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_C]);
});

test('the pool and its current key survive a bridge restart; state is private and has no prompt', async () => {
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => success(res, 'after restart'));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)], 7, 'dk_a') })).ok, true);
  const before = await chat({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'before restart' }] });
  assert.equal(before.status, 200);
  await before.text();
  const base = localBase();
  const token = localToken();
  const mode = fs.statSync(STATE_FILE).mode & 0o777;
  assert.equal(mode, 0o600);
  const savedText = fs.readFileSync(STATE_FILE, 'utf8');
  assert.ok(!savedText.includes('before restart'), 'no prompt is persisted');
  assert.ok(savedText.includes(KEY_B), 'the bridge persists the pool it needs');

  // Stop this bridge and start another one with the same state.
  const exited = new Promise((r) => bridge.once('exit', r));
  bridge.kill('SIGTERM');
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  upstreamRequests = [];
  const connected = nextHello();
  const env = { ...process.env, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${upstream.address().port}` };
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('restarted bridge did not connect')), 15000))]);

  // The old loopback address and token still work, and the exhausted first
  // key is still skipped.
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'after restart' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /after restart/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B]);
  await new Promise((r) => setTimeout(r, 100));
  const report = reports.at(-1);
  assert.equal(report.gateway, 'opencode-go');
  assert.equal(report.revision, 7);
  assert.equal(report.activeId, 'dk_b');
  assert.ok(report.keys.find((k) => k.id === 'dk_a').exhaustedAt);
  assert.ok(!JSON.stringify(report).includes(KEY_B));
  // The subagent default the hub wrote is still Kimi's, not rewritten by the
  // restart.
  assert.deepEqual(state.secondaryModel, { defaultModel: `${DS}/deepseek-v4.1-flash`, defaultEffort: 'max', force: false });
});

// ======================================================================
// One rotation order across gateways (2026-10-28): a key that is really out
// of credit/quota is marked, and the very same request goes to the next key
// in the order, whichever gateway that key belongs to. The Kimi-facing model
// name, the address, the model id at that gateway and the gateway-specific
// session header all change with the key. Nothing is guessed: the reset time
// is the one the gateway's message states, otherwise "unknown" and a real
// request finds out.
// ======================================================================
const CREDITS_MSG = 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.';
const CC = 'commandcode';
const OCG = 'opencode-go';
const ck = (id, apiKey, gateway, extra = {}) => ({ id, apiKey, gateway, ...extra });
const MODEL_MAP = { [CC]: { 'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash' }, opencode: { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'deepseek-v4-pro': 'deepseek-v4-pro' } };
const cross = (keys, over = {}) => ({ revision: 1, activeId: keys[0].id, rotation: 1, modelMap: MODEL_MAP, keys, ...over });
const chatWith = (body, headers = {}) =>
  fetch(`${localBase()}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${localToken()}`, 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
const FLASH = { model: 'deepseek-v4.1-flash', reasoning_effort: 'max', stream: true, messages: [{ role: 'user', content: 'rotate me' }] };
const savedPool = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).deepseekPool;
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// The tests above end on a persisted pool at a high revision; from here on every
// test starts without one (a hub that has forgotten the connector's pool).
let crossSection = false;
beforeEach(async () => {
  if (crossSection) await ask('kimi.deepseek.remove', {});
});

test('the hello names the new ability, so a hub knows this connector can rotate across gateways', () => {
  crossSection = true;
  assert.ok(lastHello, 'a hello was seen');
  assert.ok(lastHello.capabilities.includes('pool_cross'), JSON.stringify(lastHello.capabilities));
  assert.ok(lastHello.capabilities.includes('pool'), 'and still the pool');
});

test('a 400 that says "insufficient credits" (the 2026-10-24 incident) rotates to the next key; Kimi sees one normal answer', async () => {
  const cases = [
    ['json message', jsonError(400, { message: CREDITS_MSG, type: 'invalid_request_error' })],
    ['json, no type', jsonError(400, { message: CREDITS_MSG })],
    ['plain text', textError(400, CREDITS_MSG)],
    ['402 plain text', textError(402, CREDITS_MSG)],
    ['envelope with a credits error type', (req, res) => (res.writeHead(400, { 'content-type': 'application/json' }), res.end(JSON.stringify({ type: 'error', error: { type: 'CreditsError', message: 'Insufficient balance. Manage your billing here.' } })))],
  ];
  for (const [name, handler] of cases) {
    const out = await poolOutcome(handler);
    assert.equal(out.status, 200, name);
    assert.match(out.text, /second key answered/, name);
    assert.deepEqual(out.upstream, [KEY_A, KEY_B], name);
    assert.deepEqual(out.exhausted, ['dk_a'], name);
    assert.deepEqual(out.saved, ['dk_a'], `${name}: persisted`);
  }
});

test('400/403 count as quota only for an account-level statement: explicit quota code, or credits/limit wording that is not an echo', async () => {
  const rotate = [
    ['400 quota code', jsonError(400, { code: 'insufficient_quota', message: 'x' })],
    ['403 quota code', jsonError(403, { code: 'usage_limit_reached', message: 'x' })],
    ['403 usage limit message', jsonError(403, { message: "You've reached your monthly usage limit for this key." })],
    ['400 monthly limit', jsonError(400, { message: 'Monthly limit reached' })],
    ['429 command code usage limit', jsonError(429, { message: "You've reached your 5-hour usage limit for your plan. Your limit resets at 3:00 PM." })],
    ['429 subscription quota with a long wait', jsonError(429, { type: 'SubscriptionUsageLimitError', message: 'Subscription quota exceeded. Retry in 2hr 3min.' })],
  ];
  for (const [name, handler] of rotate) {
    const out = await poolOutcome(handler);
    assert.equal(out.status, 200, name);
    assert.deepEqual(out.upstream, [KEY_A, KEY_B], name);
    assert.deepEqual(out.exhausted, ['dk_a'], name);
  }
  const stay = [
    ['400 reasoning must be passed back', 400, jsonError(400, { code: 'invalid_request_error', message: 'The reasoning_content in the thinking mode must be passed back to the API.' })],
    ['400 plain bad request', 400, jsonError(400, { message: 'Invalid value for messages[3].content: expected a string' })],
    ['400 context too long', 400, jsonError(400, { message: "This model's maximum context length is 1000000 tokens. However, your messages resulted in 1200000 tokens." })],
    ['400 echoed words', 400, jsonError(400, { code: 'invalid_request_error', message: 'Your request mentioned insufficient credits and a monthly limit reached in the prompt' })],
    ['403 plan refusal', 403, jsonError(403, { code: 'upgrade_required', message: 'Your plan has no API access; upgrade to add credits' })],
    ['403 plain forbidden', 403, jsonError(403, { message: 'Forbidden' })],
    ['429 per minute', 429, jsonError(429, { message: 'Rate limit: you have exceeded your usage limit per minute, retry in 3 seconds' })],
    ['400 credits wording in a code that names rate limiting', 400, jsonError(400, { code: 'rate_limit_exceeded', message: 'insufficient credits for this burst' })],
  ];
  for (const [name, status, handler] of stay) {
    const out = await poolOutcome(handler);
    assert.equal(out.status, status, name);
    assert.deepEqual(out.upstream, [KEY_A], `${name}: no other key was tried`);
    assert.deepEqual(out.exhausted, [], name);
  }
});

test('OpenCode Go -> Command Code: the same request goes to the next gateway with its address, model id, session header and key', async () => {
  responses.set(KEY_A, jsonError(400, { message: CREDITS_MSG }));
  responses.set(KEY_B, (req, res) => success(res, 'command code answered'));
  const r = await provision({ pool: cross([ck('dk_a', KEY_A, OCG), ck('dk_b', KEY_B, CC)]) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool.revision, 1);
  assert.match(provider().base_url, /\/opencode-go$/, 'Kimi keeps talking to the one provider it was given');
  const res = await chatWith(FLASH, { 'x-opencode-session': 'ses_agenthub_0123456789abcdef', 'x-agent-hub-note': 'private' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /command code answered/);
  assert.equal(upstreamRequests.length, 2);
  const [first, second] = upstreamRequests;
  assert.equal(first.url, '/opencode-go/chat/completions');
  assert.equal(first.key, KEY_A);
  assert.equal(first.body.model, 'deepseek-v4.1-flash');
  assert.equal(first.headers['x-opencode-session'], 'ses_agenthub_0123456789abcdef');
  assert.equal(first.headers['x-session-id'], undefined);
  assert.equal(second.url, '/commandcode/chat/completions');
  assert.equal(second.key, KEY_B);
  assert.equal(second.body.model, 'deepseek/deepseek-v4.1-flash', 'the model id is the one Command Code lists');
  assert.deepEqual({ ...second.body, model: 'x' }, { ...FLASH, model: 'x' }, 'nothing else in the request changed');
  assert.equal(second.headers['x-session-id'], 'ses_agenthub_0123456789abcdef', 'the same session id under the name this gateway uses');
  assert.equal(second.headers['x-opencode-session'], undefined);
  assert.equal(second.headers['x-agent-hub-note'], undefined);
  assert.equal(second.headers.authorization, `Bearer ${KEY_B}`);
  assert.ok(!JSON.stringify(second.headers).includes(localToken()));
  await settle();
  const report = reports.filter((x) => x.revision === 1).at(-1);
  assert.equal(report.rotation, 1);
  assert.equal(report.activeId, 'dk_b');
  assert.equal(report.gateway, CC, 'the machine is now on a Command Code key');
  assert.ok(report.keys.find((k) => k.id === 'dk_a').exhaustedAt);
  assert.ok(!JSON.stringify(reports).includes(KEY_A) && !JSON.stringify(reports).includes(KEY_B));
  // The next request starts on the key that works: no wasted call to the dry one.
  upstreamRequests = [];
  const again = await chatWith(FLASH, { 'x-opencode-session': 'ses_agenthub_0123456789abcdef' });
  assert.equal(again.status, 200);
  await again.text();
  assert.deepEqual(upstreamRequests.map((x) => [x.url, x.key]), [['/commandcode/chat/completions', KEY_B]]);
});

test('Command Code -> OpenCode Go: the other direction renames the model and the header back', async () => {
  const flash = models(['deepseek/deepseek-v4.1-flash']);
  responses.set(KEY_A, jsonError(429, { message: "You've reached your 5-hour usage limit for your plan." }));
  responses.set(KEY_B, (req, res) => success(res, 'go answered'));
  const map = { [OCG]: { 'deepseek/deepseek-v4.1-flash': 'deepseek-v4.1-flash' } };
  const r = await provision({ gateway: CC, models: flash, pool: cross([ck('dk_a', KEY_A, CC), ck('dk_b', KEY_B, OCG)], { modelMap: map }) });
  assert.equal(r.ok, true, r.error);
  assert.match(provider().base_url, /\/commandcode$/);
  const res = await chatWith({ ...FLASH, model: 'deepseek/deepseek-v4.1-flash' }, { 'x-session-id': 'ses_agenthub_fedcba9876543210' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /go answered/);
  const [first, second] = upstreamRequests;
  assert.equal(first.url, '/commandcode/chat/completions');
  assert.equal(first.body.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(first.headers['x-session-id'], 'ses_agenthub_fedcba9876543210');
  assert.equal(second.url, '/opencode-go/chat/completions');
  assert.equal(second.body.model, 'deepseek-v4.1-flash');
  assert.equal(second.headers['x-opencode-session'], 'ses_agenthub_fedcba9876543210');
  assert.equal(second.headers['x-session-id'], undefined);
});

test('a key whose gateway has no counterpart of the requested model is skipped without being marked exhausted', async () => {
  responses.set(KEY_B, (req, res) => success(res, 'must not be reached'));
  responses.set(KEY_C, (req, res) => success(res, 'go answered the pro model'));
  const r = await provision({ pool: cross([ck('dk_b', KEY_B, CC), ck('dk_c', KEY_C, OCG)]) });
  assert.equal(r.ok, true, r.error);
  const res = await chatWith({ ...FLASH, model: 'deepseek-v4-pro' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /go answered the pro model/);
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_C], 'Command Code was not asked for a model it was not told about');
  await settle();
  assert.deepEqual(reports.filter((x) => x.revision === 1).at(-1).keys.filter((k) => k.exhaustedAt), [], 'skipping is not exhaustion');
  // Only keys that cannot serve it: a clear answer that is not a quota error.
  upstreamRequests = [];
  assert.equal((await provision({ pool: cross([ck('dk_b', KEY_B, CC)], { revision: 2 }) })).ok, true);
  const none = await chatWith({ ...FLASH, model: 'deepseek-v4-pro' });
  assert.equal(none.status, 400);
  const j = JSON.parse(await none.text());
  assert.equal(j.error.code, 'model_not_available');
  assert.match(j.error.message, /deepseek-v4-pro/);
  assert.equal(upstreamRequests.length, 0);
});

// ---- reset times: only what the message states
const clock = (ms) => new Date(Date.now() + ms);
async function resetOf(message, extra = {}) {
  const out = await poolOutcome(jsonError(429, { message, ...extra }));
  assert.equal(out.status, 200, message);
  const report = reports.filter((x) => x.revision === 1).at(-1);
  const a = report.keys.find((k) => k.id === 'dk_a');
  assert.ok(a.exhaustedAt, message);
  const saved = savedPool().keys.find((k) => k.id === 'dk_a');
  assert.equal(saved.retryAt, a.retryAt, 'persisted the same as reported');
  return { retryAt: a.retryAt, exhaustedAt: a.exhaustedAt };
}

test('Command Code "resets at ...170Z" is read as UTC, fraction and all', async () => {
  const when = clock(3 * 3600_000);
  when.setUTCMilliseconds(170);
  const iso = when.toISOString();
  assert.match(iso, /\.170Z$/);
  const got = await resetOf(`You've reached your 5-hour usage limit for your plan. Your limit resets at ${iso}.`);
  assert.equal(got.retryAt, when.getTime());
  const plus8 = clock(2 * 3600_000);
  plus8.setUTCMilliseconds(0);
  const local = new Date(plus8.getTime() + 8 * 3600_000).toISOString().replace('Z', '+08:00');
  assert.equal((await resetOf(`Usage limit reached. Resets at ${local}`)).retryAt, plus8.getTime());
});

test('a relative time ("resets in 2 hours 15 minutes", "Retry in 2hr 3min") is counted from now', async () => {
  const a = await resetOf('Usage limit reached; your limit resets in 2 hours 15 minutes.');
  assert.ok(Math.abs(a.retryAt - a.exhaustedAt - (2 * 3600 + 15 * 60) * 1000) < 5000, String(a.retryAt - a.exhaustedAt));
  const b = await resetOf('Subscription quota exceeded. Retry in 2hr 3min.');
  assert.ok(Math.abs(b.retryAt - b.exhaustedAt - (2 * 3600 + 3 * 60) * 1000) < 5000, String(b.retryAt - b.exhaustedAt));
});

test('with several "resets at" in one message, the last readable one is taken', async () => {
  const early = clock(1 * 3600_000);
  early.setUTCMilliseconds(0);
  const late = clock(5 * 3600_000);
  late.setUTCMilliseconds(250);
  const both = await resetOf(`Usage limit reached. Window A resets at ${early.toISOString()}. Window B resets at ${late.toISOString()}.`);
  assert.equal(both.retryAt, late.getTime());
  const garbage = await resetOf(`Usage limit reached. Resets at ${early.toISOString()}. Notes: next window resets at sometime soon`);
  assert.equal(garbage.retryAt, early.getTime(), 'a later time that cannot be read does not hide an earlier one that can');
});

test('no stated time, no zone, a past time or an absurd one: the expiry is unknown and nothing is invented', async () => {
  const noTime = await resetOf('Monthly limit reached');
  assert.equal(noTime.retryAt, undefined);
  const noZone = await resetOf(`Usage limit reached. Resets at ${clock(2 * 3600_000).toISOString().slice(0, 19)}`);
  assert.equal(noZone.retryAt, undefined, 'a time without a zone is not guessed');
  const timeOfDay = await resetOf("You've reached your 5-hour usage limit. Your limit resets at 3:00 PM.");
  assert.equal(timeOfDay.retryAt, undefined, 'a clock time with no zone or date is not guessed');
  const past = await resetOf(`Usage limit reached. Resets at ${clock(-3600_000).toISOString()}`);
  assert.equal(past.retryAt, undefined);
  const far = await resetOf(`Usage limit reached. Resets at ${clock(400 * 86_400_000).toISOString()}`);
  assert.equal(far.retryAt, undefined);
});

test('Retry-After and the reset fields still win, ahead of the message', async () => {
  const body = JSON.stringify({ error: { code: 'usage_limit_reached', message: `Usage limit reached. Resets at ${clock(9 * 3600_000).toISOString()}` } });
  const out = await poolOutcome((req, res) => (res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' }), res.end(body)));
  assert.equal(out.status, 200);
  const a = reports.filter((x) => x.revision === 1).at(-1).keys.find((k) => k.id === 'dk_a');
  assert.ok(Math.abs(a.retryAt - a.exhaustedAt - 3600_000) < 5000);
});

test('a key with an unknown expiry is found healthy by a real request after the probe gap, no time invented in between', async () => {
  await withBridgeEnv(RETRY_ENV);
  let dry = true;
  responses.set(KEY_A, (req, res) => (dry ? jsonError(400, { message: 'Monthly limit reached' })(req, res) : success(res, 'a is back')));
  responses.set(KEY_B, (req, res) => quota(res, 402, 'insufficient_quota'));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) })).ok, true);
  const go = () => chat(FLASH).then(async (res) => ({ status: res.status, text: await res.text() }));
  assert.equal((await go()).status, 402, 'both are out');
  await settle();
  const out = reports.filter((x) => x.revision === 1).at(-1);
  assert.ok(out.keys.every((k) => k.exhaustedAt && k.retryAt === undefined), 'nothing claims to know when they come back');
  dry = false;
  upstreamRequests = [];
  assert.equal((await go()).status, 402, 'inside the gap nobody is asked');
  assert.equal(upstreamRequests.length, 0);
  await new Promise((r) => setTimeout(r, 900));
  const back = await go();
  assert.equal(back.status, 200);
  assert.match(back.text, /a is back/);
  await settle();
  const a = reports.filter((x) => x.revision === 1).at(-1).keys.find((k) => k.id === 'dk_a');
  assert.equal(a.exhaustedAt, undefined);
  assert.ok(a.recoveredAt);
  await withBridgeEnv({});
});

test('a stated reset time keeps its key aside until then; when it has passed, the next real request that needs it uses it', async () => {
  await withBridgeEnv({});
  const when = clock(1500);
  when.setUTCMilliseconds(0);
  let reset = false;
  responses.set(KEY_A, (req, res) => (reset ? success(res, 'a after its reset') : jsonError(429, { message: `Usage limit reached. Resets at ${when.toISOString()}` })(req, res)));
  responses.set(KEY_B, (req, res) => (reset ? quota(res, 402, 'insufficient_quota') : success(res, 'b answered')));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) })).ok, true);
  assert.match(await (await chat(FLASH)).text(), /b answered/);
  reset = true;
  upstreamRequests = [];
  // b is now dry too, a's stated time has not come: nobody is probed early.
  const early = await chat(FLASH);
  assert.equal(early.status, 402);
  await early.text();
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B], 'a was not touched before its stated time');
  await new Promise((r) => setTimeout(r, Math.max(0, when.getTime() - Date.now()) + 300));
  upstreamRequests = [];
  const late = await chat(FLASH);
  assert.equal(late.status, 200);
  assert.match(await late.text(), /a after its reset/);
});

test('every key out: one clear error that lists each key by gateway and last four characters, with the states and the earliest known reset', async () => {
  await withBridgeEnv({});
  const when = clock(2 * 3600_000);
  when.setUTCMilliseconds(0);
  responses.set(KEY_A, jsonError(429, { message: `You've reached your 5-hour usage limit. Resets at ${when.toISOString()}` }));
  responses.set(KEY_B, jsonError(400, { message: 'Monthly limit reached' }));
  const r = await provision({ pool: cross([ck('dk_a', KEY_A, CC), ck('dk_b', KEY_B, OCG), ck('dk_c', KEY_C, OCG, { exhaustedAt: Date.now() - 1000, manual: true })]) });
  assert.equal(r.ok, true, r.error);
  const res = await chatWith(FLASH);
  assert.equal(res.status, 402);
  const j = JSON.parse(await res.text());
  assert.equal(j.error.code, 'insufficient_quota');
  const text = j.error.message;
  assert.match(text, /Command Code[^\n]*…1111[^\n]*重置/, text);
  assert.match(text, /OpenCode Go[^\n]*…2222[^\n]*(到期未知|重置時間未知)/, text);
  assert.match(text, /OpenCode Go[^\n]*…3333[^\n]*手動標記/, text);
  assert.match(text, /自動再試/);
  assert.match(text, /重新啟用|清除/, 'says how to recover now');
  assert.equal(j.error.retry_at > Date.now(), true, 'the next try that can happen is machine-readable');
  for (const k of [KEY_A, KEY_B, KEY_C]) assert.ok(!JSON.stringify(j).includes(k), 'no key value in the error');
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_A, KEY_B], 'the manually marked key is never tried');
  // Quiet afterwards: the stated time is not due, and the unknown one waits out the gap.
  upstreamRequests = [];
  assert.equal((await chatWith(FLASH)).status, 402);
  assert.ok(!upstreamRequests.some((x) => x.key === KEY_C));
});

test('a manually marked key is never used or probed, however long ago it was marked; the other keys carry on', async () => {
  await withBridgeEnv(RETRY_ENV);
  responses.set(KEY_A, (req, res) => success(res, 'must stay untouched'));
  responses.set(KEY_B, (req, res) => success(res, 'b answered'));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A, Date.now() - 3600_000), key('dk_b', KEY_B)].map((k, i) => (i === 0 ? { ...k, manual: true } : k)), 1, 'dk_b') })).ok, true);
  assert.match(await (await chat(FLASH)).text(), /b answered/);
  responses.set(KEY_B, (req, res) => quota(res, 402, 'insufficient_quota'));
  await new Promise((r) => setTimeout(r, 900));
  upstreamRequests = [];
  const dry = await chat(FLASH);
  assert.equal(dry.status, 402);
  await dry.text();
  assert.deepEqual(upstreamRequests.map((x) => x.key), [KEY_B], 'only the non-manual key is probed');
  await settle();
  const a = reports.filter((x) => x.revision === 1).at(-1).keys.find((k) => k.id === 'dk_a');
  assert.ok(a.exhaustedAt, 'still reported as exhausted');
  assert.equal(savedPool().keys.find((k) => k.id === 'dk_a').manual, true, 'and still manual after being saved');
  await withBridgeEnv({});
});

test('a cross-gateway pool is remembered across a restart: keys, their gateways and the model table', async () => {
  responses.set(KEY_A, jsonError(400, { message: CREDITS_MSG }));
  responses.set(KEY_B, (req, res) => success(res, 'after restart, command code'));
  assert.equal((await provision({ pool: cross([ck('dk_a', KEY_A, OCG), ck('dk_b', KEY_B, CC)], { revision: 5 }) })).ok, true);
  const saved = savedPool();
  assert.deepEqual(saved.keys.map((k) => [k.id, k.gateway]), [['dk_a', OCG], ['dk_b', CC]]);
  assert.deepEqual(saved.modelMap[CC], MODEL_MAP[CC]);
  const base = localBase();
  const token = localToken();
  await restartBridge({});
  upstreamRequests = [];
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(FLASH) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /after restart, command code/);
  assert.deepEqual(upstreamRequests.map((x) => [x.url, x.key, x.body.model]), [['/opencode-go/chat/completions', KEY_A, 'deepseek-v4.1-flash'], ['/commandcode/chat/completions', KEY_B, 'deepseek/deepseek-v4.1-flash']]);
});

test('a provision that names a gateway the connector does not know, or a bad model table, is refused whole', async () => {
  const bad = [
    cross([ck('dk_a', KEY_A, 'evil.example')]),
    cross([ck('dk_a', KEY_A, OCG)], { modelMap: { 'evil.example': { 'deepseek-v4.1-flash': 'x' } } }),
    cross([ck('dk_a', KEY_A, OCG)], { modelMap: { [CC]: { 'deepseek-v4.1-flash': '../../etc/passwd' } } }),
    cross([ck('dk_a', KEY_A, OCG)], { modelMap: { [CC]: ['x'] } }),
  ];
  for (const p of bad) {
    const r = await provision({ pool: p });
    assert.equal(r.ok, false, JSON.stringify(p));
  }
});

test('a pool without per-key gateways behaves exactly as before: same gateway, no rotation flag in its reports', async () => {
  responses.set(KEY_A, (req, res) => quota(res, 402, 'insufficient_quota'));
  responses.set(KEY_B, (req, res) => success(res, 'old shape'));
  assert.equal((await provision({ pool: pool([key('dk_a', KEY_A), key('dk_b', KEY_B)]) })).ok, true);
  const res = await chat(FLASH);
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(upstreamRequests.map((x) => x.url), ['/opencode-go/chat/completions', '/opencode-go/chat/completions']);
  await settle();
  const report = reports.filter((x) => x.revision === 1).at(-1);
  assert.equal(report.rotation, undefined);
  assert.equal(report.gateway, 'opencode-go');
});
