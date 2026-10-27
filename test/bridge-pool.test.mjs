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

test('only 402 and 429 can rotate: 400/401/403/404/409/422/5xx with a quota code do not', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 500, 502, 503]) {
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
