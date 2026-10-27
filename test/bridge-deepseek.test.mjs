// The bridge making Kimi's DeepSeek provider (kimi.deepseek.provision and
// .remove, with the session header some gateways want), and what it must never do: touch the Kimi subscription login or
// Kimi's global default model, or let the hub create, replace or delete other
// providers. A fake Kimi server that behaves like Kimi 2.1.1 where it
// matters (createProvider SEEDS the global default model when none is set),
// and the real bridge, spawned. No Kimi or account needed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { parseToml, tomlAvailable, tomlSkip } from './fixtures/toml-oracle.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dsbridge-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const MANAGED = 'managed:kimi-code';
const SUB = 'managed:kimi-code/kimi-for-coding';
const DS = 'agent-hub-deepseek';
let bridge;
let kimi;
let hubWss;
let hubWs;

// Kimi's configuration, as the fake keeps it, and every write made to it.
let state;
let writes; // [method, path, body]
const fresh = (over = {}) => {
  state = {
    defaultModel: SUB,
    defaultProvider: MANAGED,
    thinking: { enabled: true, effort: 'high' },
    secondaryModel: undefined,
    providers: { [MANAGED]: { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', default_model: SUB, oauth: true, models: [SUB] }, other: { type: 'openai', base_url: 'https://other.example/v1', models: ['other/m'] } },
    models: { [SUB]: { provider: MANAGED, display_name: 'kimi-for-coding' }, 'other/m': { provider: 'other', display_name: 'm' } },
    managedDefault: SUB, // what GET /providers says the subscription's default model is
    hijack: false, // createProvider moves the default even when one is set
    corruptConfig: false, // a config write that also loses another provider
    lostOther: null, // the provider that write lost, until config.toml is restored
    rejectSecondary: false, // the config API refuses [secondary_model]
    ...over,
  };
  writes = [];
  // Kimi's config.toml as it is on disk, the way Kimi wrote it.
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  writeToml();
};

// config.toml as Kimi would write it after a change of the providers.
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
    if (pool) {
      lines.push('', '[secondary_model.models]');
      for (const [k, v] of Object.entries(pool)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          lines.push(`[secondary_model.models.${JSON.stringify(k)}]`);
          for (const [key, value] of Object.entries(v)) lines.push(`${key} = ${JSON.stringify(value)}`);
          lines.push('');
        } else lines.push(`"${k}" = ${JSON.stringify(String(v ?? ''))}`);
      }
    }
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
// `preserveFile`: a Kimi that saves in place and leaves the user's text alone.
const writeToml = () => {
  if (!state.preserveFile) fs.writeFileSync(path.join(KIMI_HOME, 'config.toml'), toml());
};

// Kimi watches config.toml and reloads it. The bridge removes the
// [secondary_model] table it wrote by editing this file, so GET /config reads
// that table back from disk (everything else stays in `state`).
function syncSecondaryFromToml() {
  let text;
  try {
    text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  } catch {
    return;
  }
  // A real TOML parser when there is one, so a hand-written file (comments after
  // headers, single quotes, inline tables) reads back the way Kimi reads it.
  if (tomlAvailable) {
    let sec;
    try {
      sec = parseToml(text).secondary_model;
    } catch {
      return;
    }
    if (!sec) {
      state.secondaryModel = undefined;
      return;
    }
    const camel = { default_model: 'defaultModel', default_effort: 'defaultEffort' };
    state.secondaryModel = Object.fromEntries(Object.entries(sec).map(([k, v]) => [camel[k] || k, v]));
    if (state.secondaryModel.force === undefined) state.secondaryModel.force = false;
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
  let nested = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      head = t.replace(/\s+/g, '');
      nested = null;
      if (head === '[secondary_model]') parent = {};
      if (head === '[secondary_model.models]') pool = parent ? {} : null;
      const match = head.match(/^\[secondary_model\.models\."((?:[^"\\]|\\.)*)"\]$/);
      if (match && parent) {
        pool ||= {};
        nested = JSON.parse(`"${match[1]}"`);
        pool[nested] ||= {};
      }
      continue;
    }
    if (!t || t.startsWith('#') || !parent) continue;
    const m = t.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!m) continue;
    if (head === '[secondary_model.models]' && pool) pool[value(m[1])] = value(m[2]);
    else if (nested && pool) {
      const key = value(m[1]);
      pool[nested][key] = m[2].trim() === 'true' ? true : m[2].trim() === 'false' ? false : value(m[2]);
    } else if (head === '[secondary_model]') {
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

// The provider a corrupt config write lost is back once its table is back in
// config.toml, and a header the bridge restored away is gone again: that is
// how Kimi reloads a restored file.
function restoreOtherFromToml() {
  if (!state.lostOther) return;
  try {
    if (!fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8').includes('[providers.other]')) return;
  } catch {
    return;
  }
  state.providers.other = state.lostOther;
  state.lostOther = null;
}

function restoreConfigFromToml() {
  restoreOtherFromToml();
  try {
    const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
    const ds = state.providers[DS];
    if (ds && !/[\[\.]custom_headers\]|custom_headers\s*=/.test(text)) delete ds.custom_headers;
  } catch {}
}

// Kimi's server: the routes the bridge uses for this, one port.
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
        restoreConfigFromToml();
        syncSecondaryFromToml();
        return ok({ ...(state.defaultModel ? { default_model: state.defaultModel } : {}), default_provider: state.defaultProvider, thinking: state.thinking, ...(state.secondaryModel ? { secondary_model: state.secondaryModel } : {}) });
      }
      if (req.method === 'GET' && url === '/api/v1/providers') {
        restoreConfigFromToml();
        return ok({
          items: Object.entries(state.providers).map(([id, p]) => ({ id, type: p.type, base_url: p.base_url, ...(id === MANAGED ? (state.managedDefault ? { default_model: state.managedDefault } : {}) : {}), has_api_key: true, status: 'connected', models: p.models })),
        });
      }
      // POST /config: Kimi merges into the domains it is given and writes
      // config.toml (the fake writes the tables it knows). A [secondary_model]
      // patch is a deep merge, exactly like Kimi's config.set: nothing is
      // deleted, and the model must resolve.
      if (req.method === 'POST' && url === '/api/v1/config') {
        for (const [id, p] of Object.entries(body.providers || {})) {
          if (!state.providers[id]) return err(40001, 'no such provider');
          state.providers[id].custom_headers = { ...(state.providers[id].custom_headers || {}), ...(p.custom_headers || {}) };
          if (state.corruptConfig && state.providers.other) {
            state.lostOther = state.providers.other;
            delete state.providers.other;
          }
        }
        if (body.secondary_model !== undefined) {
          if (state.rejectSecondary) return err(40001, 'secondary_model is not accepted');
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
      // POST /models/<alias>:set_default
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
        // Kimi 2.1.1: "When no global default_model is configured, it is seeded with the new provider's model."
        if (!state.defaultModel || state.hijack) state.defaultModel = `${body.id}/${body.default_model || body.models[0].model}`;
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

const pending = new Map();
const ask = (op, args) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    pending.set(id, resolve);
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
    setTimeout(() => reject(new Error('no answer')), 20000);
  });

const models = (names = ['deepseek-v4.1-flash', 'deepseek-v4-pro']) =>
  names.map((model) => ({ model, display_name: `DS ${model}`, max_context_size: 1_000_000, max_output_size: 384_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] }));
const provision = (over = {}) => ask('kimi.deepseek.provision', { gateway: 'opencode-go', apiKey: 'sk-test-key-1234', models: models(), ...over });
const posted = () => writes.filter(([m, p]) => p === '/api/v1/providers' && m === 'POST');

before(async () => {
  kimi = fakeKimi();
  await new Promise((r) => kimi.listen(0, '127.0.0.1', r));
  const port = kimi.address().port;
  fs.mkdirSync(path.join(KIMI_HOME, 'server', 'instances'), { recursive: true });
  fs.writeFileSync(path.join(KIMI_HOME, 'server', 'instances', 'a.json'), JSON.stringify({ port, host: '127.0.0.1', pid: process.pid, server_id: 'srv1', started_at: Date.now() }));
  fs.writeFileSync(path.join(KIMI_HOME, 'server.token'), 'server-token');
  hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => hubWss.on('listening', r));
  const connected = new Promise((resolve) => {
    hubWss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') (hubWs = ws), resolve();
        if (m.t === 'res' && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
      });
    });
  });
  const env = { ...process.env, HOME: TMP };
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge did not connect')), 15000))]);
});

beforeEach(() => fresh());

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  kimi?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('provision creates agent-hub-deepseek at the gateway\'s address, with no default_model, and Kimi\'s default stays', async () => {
  const r = await provision({ apiKey: 'sk-test-key-1234' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.models, [`${DS}/deepseek-v4.1-flash`, `${DS}/deepseek-v4-pro`]);
  assert.equal(r.data.created, true);
  // The provider, then its session header, then the approved subagent
  // default; the default was already set, nothing to pin.
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), ['POST /api/v1/providers', 'POST /api/v1/config', 'POST /api/v1/config']);
  const [method, p, body] = writes[0];
  assert.deepEqual([method, p], ['POST', '/api/v1/providers']);
  assert.equal(body.id, DS);
  assert.equal(body.type, 'openai');
  assert.equal(body.base_url, 'https://opencode.ai/inference/go/openai/v1', 'the bridge\'s own address for the gateway');
  assert.equal(body.api_key, 'sk-test-key-1234');
  assert.ok(!('default_model' in body), 'Kimi\'s own pointer is never in the body');
  assert.deepEqual(body.models[0], { model: 'deepseek-v4.1-flash', max_context_size: 1_000_000, max_output_size: 384_000, display_name: 'DS deepseek-v4.1-flash', capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] });
  // The empty [secondary_model] became this gateway's V4.1 Flash at max,
  // without `force`; the hub is told the actual value.
  const secondary = writes[2][2].secondary_model;
  assert.deepEqual(secondary, { default_model: `${DS}/deepseek-v4.1-flash`, default_effort: 'max' });
  assert.ok(!('force' in secondary));
  assert.deepEqual(r.data.secondaryModel, { model: `${DS}/deepseek-v4.1-flash`, models: [], force: false, effort: 'max' });
  assert.deepEqual(state.secondaryModel, { defaultModel: `${DS}/deepseek-v4.1-flash`, defaultEffort: 'max', force: false });
  // The subscription and the rest of Kimi's configuration are as they were.
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.defaultProvider, MANAGED);
  assert.deepEqual(state.thinking, { enabled: true, effort: 'high' });
  assert.deepEqual(Object.keys(state.providers), [MANAGED, 'other', DS]);
  assert.equal(state.providers[MANAGED].models[0], SUB);
});

test('each gateway has its own address, which only the bridge knows', async () => {
  const urls = { 'opencode-go': 'https://opencode.ai/inference/go/openai/v1', opencode: 'https://opencode.ai/inference/openai/v1', commandcode: 'https://api.commandcode.ai/provider/v1' };
  for (const [gateway, url] of Object.entries(urls)) {
    fresh();
    const r = await provision({ gateway, models: models(gateway === 'commandcode' ? ['deepseek/deepseek-v4.1-flash'] : undefined) });
    assert.equal(r.ok, true, r.error);
    assert.equal(posted()[0][2].base_url, url, gateway);
  }
  // The address is not something the hub can send.
  fresh();
  const r = await provision({ gateway: 'opencode-go', base_url: 'https://evil.example/v1', baseUrl: 'https://evil.example/v1' });
  assert.equal(posted()[0][2].base_url, 'https://opencode.ai/inference/go/openai/v1');
  assert.ok(!JSON.stringify(posted()[0][2]).includes('evil'), r.error);
});

test('commandcode model ids with a vendor prefix become aliases under the provider', async () => {
  const r = await provision({ gateway: 'commandcode', models: models(['deepseek/deepseek-v4.1-flash']) });
  assert.deepEqual(r.data.models, [`${DS}/deepseek/deepseek-v4.1-flash`]);
});

test('no default model set: the subscription\'s model is pinned first, so DeepSeek does not become Kimi\'s default', async () => {
  fresh({ defaultModel: '' });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  // Pinned (by Kimi's set-default request) before the provider was made; then
  // the header, then the empty [secondary_model].
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`POST /api/v1/models/${SUB}:set_default`, 'POST /api/v1/providers', 'POST /api/v1/config', 'POST /api/v1/config']);
  assert.equal(state.defaultModel, SUB, 'Kimi did seed the default on create, from the pin');
  assert.ok(state.providers[DS]);
  // Without the pin the fake (like Kimi) would have made DeepSeek the default:
  fresh({ defaultModel: '' });
  const raw = await fetch(`http://127.0.0.1:${kimi.address().port}/api/v1/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'plain', type: 'openai', models: [{ model: 'm', max_context_size: 1000 }] }) });
  assert.equal(raw.status, 201);
  assert.equal(state.defaultModel, 'plain/m', 'a bare createProvider seeds the default, as Kimi 2.1.1 does');
});

test('no default and no subscription model to pin: nothing is created, with a clear error', async () => {
  fresh({ defaultModel: '', managedDefault: '' });
  state.providers[MANAGED].models = [];
  const r = await provision();
  assert.equal(r.ok, false);
  assert.match(r.error, /沒有設定預設模型/);
  assert.match(r.error, /kimi login/);
  assert.deepEqual(writes, [], 'no write of any kind');
  assert.equal(state.providers[DS], undefined);
  // And with no subscription provider at all:
  fresh({ defaultModel: '', providers: { other: { type: 'openai', models: ['other/m'] } }, models: { 'other/m': { provider: 'other' } } });
  const r2 = await provision();
  assert.equal(r2.ok, false);
  assert.deepEqual(writes, []);
});

test('the default model moved by creating the provider is put back, loudly', async () => {
  fresh({ hijack: true });
  const r = await provision();
  assert.equal(r.ok, false);
  assert.match(r.error, /全域預設模型被改動了/);
  assert.match(r.error, /已還原/);
  assert.equal(state.defaultModel, SUB, 'restored');
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), ['POST /api/v1/providers', `POST /api/v1/models/${SUB}:set_default`]);
});

test('a default that cannot be put back is said so', async () => {
  fresh({ hijack: true });
  delete state.models[SUB]; // Kimi no longer knows the model it was pinned to
  const r = await provision();
  assert.equal(r.ok, false);
  assert.match(r.error, /沒辦法還原/);
});

test('present already: replaced, not created again; the default is never touched', async () => {
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  const r = await provision({ apiKey: 'sk-new-key-5678', gateway: 'commandcode', models: models(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro']) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.created, false);
  // The provider and its session header. The stale subagent alias is repaired
  // in config.toml because the config API cannot delete old pool entries.
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`PUT /api/v1/providers/${DS}`, 'POST /api/v1/config']);
  assert.equal(r.data.secondaryChanged, true);
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model));
  const body = writes[0][2];
  assert.equal(body.base_url, 'https://api.commandcode.ai/provider/v1');
  assert.equal(body.api_key, 'sk-new-key-5678');
  assert.ok(!('default_model' in body) && !('id' in body) && !('new_id' in body));
  assert.deepEqual(state.providers[DS].models, [`${DS}/deepseek/deepseek-v4.1-flash`, `${DS}/deepseek/deepseek-v4-pro`]);
  assert.equal(state.defaultModel, SUB);
  assert.deepEqual(r.data.secondaryModel, { model: `${DS}/deepseek/deepseek-v4.1-flash`, models: [], force: false, effort: 'max' });
});

test('an existing [secondary_model] is reported with its actual model, force and effort, never changed', async () => {
  fresh({ secondaryModel: { defaultModel: SUB, defaultEffort: 'high', models: { [SUB]: '' }, force: false } });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.secondaryModel, { model: SUB, models: [SUB], force: false, effort: 'high' });
  assert.deepEqual(state.secondaryModel, { defaultModel: SUB, defaultEffort: 'high', models: { [SUB]: '' }, force: false });
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model), 'no secondary write');
});

test('a gateway change repairs the secondary pool and preserves every other model and description', async () => {
  const oldFlash = `${DS}/deepseek/deepseek-v4.1-flash`;
  const oldPro = `${DS}/deepseek/deepseek-v4-pro`;
  const oldGone = `${DS}/deepseek/deepseek-v4-flash`;
  const newFlash = `${DS}/deepseek-v4.1-flash`;
  const newPro = `${DS}/deepseek-v4-pro`;
  fresh({
    secondaryModel: {
      defaultModel: oldFlash,
      defaultEffort: 'high',
      force: false,
      models: { [oldFlash]: 'DS V4.1（保留描述）', [oldPro]: 'DS V4 Pro（保留描述）', [oldGone]: '舊模型', [SUB]: 'K3.1 Pro（保留描述）', 'other/m': '其他模型（保留描述）' },
    },
  });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.secondaryChanged, true);
  assert.equal(r.data.secondaryModel.model, newFlash);
  assert.equal(r.data.secondaryModel.effort, 'high');
  assert.equal(r.data.secondaryModel.force, false);
  assert.deepEqual(r.data.secondaryModel.models, [newFlash, newPro, SUB, 'other/m']);
  assert.deepEqual(state.secondaryModel.models, {
    [newFlash]: 'DS V4.1（保留描述）',
    [newPro]: 'DS V4 Pro（保留描述）',
    [SUB]: 'K3.1 Pro（保留描述）',
    'other/m': '其他模型（保留描述）',
  });
  assert.equal(state.secondaryModel.defaultEffort, 'high');
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.defaultProvider, MANAGED);
  assert.deepEqual(state.thinking, { enabled: true, effort: 'high' });
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model), 'the file repair does not deep-merge stale keys back');

  const beforeText = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  writes.length = 0;
  const again = await provision();
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.secondaryChanged, undefined);
  assert.equal(fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8'), beforeText, 'a second provision is idempotent');
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model));
});

test('nested secondary model tables are remapped without touching other nested models', async () => {
  const oldFlash = `${DS}/deepseek/deepseek-v4.1-flash`;
  const oldPro = `${DS}/deepseek/deepseek-v4-pro`;
  const oldGone = `${DS}/deepseek/deepseek-v4-flash`;
  const newFlash = `${DS}/deepseek-v4.1-flash`;
  const newPro = `${DS}/deepseek-v4-pro`;
  fresh({
    secondaryModel: {
      defaultModel: oldFlash,
      defaultEffort: 'max',
      force: false,
      models: {
        [oldFlash]: '直接寫入的 Flash 描述',
        [SUB]: { description: 'K3.1 Pro（nested 不變）' },
        [oldPro]: { description: 'nested Pro 描述' },
        [oldGone]: { description: '要移除的舊模型' },
        'other/m': { description: '其他 nested 模型（不變）' },
      },
    },
  });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.secondaryChanged, true);
  assert.equal(r.data.secondaryModel.model, newFlash);
  assert.deepEqual([...r.data.secondaryModel.models].sort(), [newFlash, newPro, SUB, 'other/m'].sort());
  assert.equal(state.secondaryModel.defaultModel, newFlash);
  assert.equal(state.secondaryModel.defaultEffort, 'max');
  assert.equal(state.secondaryModel.models[newFlash], '直接寫入的 Flash 描述');
  assert.equal(state.secondaryModel.models[newPro], 'nested Pro 描述');
  assert.deepEqual(state.secondaryModel.models[SUB], { description: 'K3.1 Pro（nested 不變）' });
  assert.deepEqual(state.secondaryModel.models['other/m'], { description: '其他 nested 模型（不變）' });
  assert.equal(state.secondaryModel.models[oldPro], undefined);
  assert.equal(state.secondaryModel.models[oldGone], undefined);
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.ok(text.includes(`[secondary_model.models."${SUB}"]`));
  assert.ok(text.includes('K3.1 Pro（nested 不變）'));
  assert.equal(state.defaultModel, SUB);
});

test('a valid secondary default missing from its pool is added without changing its effort', async () => {
  const alias = `${DS}/deepseek-v4.1-flash`;
  fresh({ secondaryModel: { defaultModel: alias, defaultEffort: 'max', models: { [SUB]: 'K3.1 Pro（不變）' }, force: false } });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.secondaryChanged, true);
  assert.equal(state.secondaryModel.defaultModel, alias);
  assert.equal(state.secondaryModel.defaultEffort, 'max');
  assert.deepEqual(state.secondaryModel.models, { [SUB]: 'K3.1 Pro（不變）', [alias]: 'DeepSeek V4.1 Flash' });
  assert.equal(state.defaultModel, SUB);
});

test('an unmappable custom secondary is refused before the provider changes', async () => {
  const alias = `${DS}/deepseek/deepseek-v4-pro`;
  fresh({ secondaryModel: { defaultModel: alias, defaultEffort: 'high', models: { [alias]: '使用者的模型' }, force: true } });
  const r = await provision({ models: models(['deepseek-v4.1-flash']) });
  assert.equal(r.ok, false);
  assert.match(r.error, /secondary_model/);
  assert.ok(r.error.includes(alias));
  assert.deepEqual(writes, [], 'no provider or config write happens first');
  assert.equal(state.providers[DS], undefined);
  assert.equal(state.secondaryModel.defaultModel, alias);
  assert.equal(state.secondaryModel.force, true);
});

test('an ambiguous model alias is refused instead of guessed', async () => {
  const alias = `${DS}/deepseek/deepseek-v4.1-flash`;
  fresh({ secondaryModel: { defaultModel: alias, defaultEffort: 'max', models: { [alias]: '舊 Flash' }, force: false } });
  const r = await provision({ models: models(['deepseek-v4.1-flash', 'vendor/deepseek-v4.1-flash']) });
  assert.equal(r.ok, false);
  assert.match(r.error, /超過一個對應/);
  assert.deepEqual(writes, []);
  assert.equal(state.providers[DS], undefined);
});

test('a provider update that would break the user\'s own DeepSeek secondary alias is refused before writing', async () => {
  const alias = `${DS}/deepseek-v4.1-flash`;
  fresh({ secondaryModel: { defaultModel: alias, models: { [alias]: 'mine' }, force: false } });
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  const r = await provision({ models: models(['deepseek-v4-pro']) });
  assert.equal(r.ok, false);
  assert.match(r.error, /secondary_model/);
  assert.deepEqual(writes, [], 'nothing was written');
  assert.deepEqual(state.providers[DS].models, [`${DS}/deepseek-v4.1-flash`, `${DS}/deepseek-v4-pro`], 'the old provider is intact');
});

test('an empty [secondary_model] is set once; a repeat provision is idempotent', async () => {
  const first = await provision();
  assert.equal(first.ok, true, first.error);
  const alias = `${DS}/deepseek-v4.1-flash`;
  assert.equal(first.data.secondaryChanged, true);
  assert.deepEqual(first.data.secondaryModel, { model: alias, models: [], force: false, effort: 'max' });
  const secondaryWrites = () => writes.filter(([, p, body]) => p === '/api/v1/config' && body?.secondary_model);
  assert.equal(secondaryWrites().length, 1);
  // Same provider and models again: the approved value is already there.
  writes.length = 0;
  const again = await provision();
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.secondaryChanged, undefined);
  assert.deepEqual(again.data.secondaryModel, { model: alias, models: [], force: false, effort: 'max' });
  assert.equal(secondaryWrites().length, 0, 'no second secondary write');
  assert.deepEqual(state.secondaryModel, { defaultModel: alias, defaultEffort: 'max', force: false });
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.defaultProvider, MANAGED);
});

test('command code uses its own V4.1 Flash alias for the subagent default', async () => {
  const r = await provision({ gateway: 'commandcode', models: models(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro']) });
  assert.equal(r.ok, true, r.error);
  const alias = `${DS}/deepseek/deepseek-v4.1-flash`;
  assert.deepEqual(r.data.secondaryModel, { model: alias, models: [], force: false, effort: 'max' });
  const body = writes.find(([, p, b]) => p === '/api/v1/config' && b?.secondary_model)[2];
  assert.deepEqual(body.secondary_model, { default_model: alias, default_effort: 'max' });
});

// The subagent default is best effort: the DeepSeek provider is what a main
// conversation needs, and it must not be reported as failed (nor re-provisioned
// on every message) because the native [secondary_model] could not be set.
test('a gateway without V4.1 Flash still provides the provider; the missing subagent default is a warning', async () => {
  const r = await provision({ models: models(['deepseek-v4-pro']) });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.secondaryWarning, /沒有 deepseek-v4\.1-flash/);
  assert.equal(r.data.secondaryChanged, undefined);
  assert.equal(r.data.secondaryModel, undefined);
  assert.ok(state.providers[DS], 'the provider itself was created');
  assert.equal(state.secondaryModel, undefined, 'no secondary was invented');
});

test('a config API that rejects the subagent default is a warning too, with no half-written secondary', async () => {
  fresh({ rejectSecondary: true });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.secondaryWarning, /secondary_model is not accepted/);
  assert.equal(r.data.secondaryChanged, undefined);
  assert.ok(state.providers[DS], 'the provider was created');
  assert.equal(state.secondaryModel, undefined, 'no half-written secondary');
  assert.equal(state.defaultModel, SUB);
  // Provisioning again (the hub does after a failed attempt) is idempotent for
  // the provider and tries the subagent default again.
  fresh({ rejectSecondary: false, providers: state.providers, models: state.models });
  const again = await provision();
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.secondaryWarning, undefined);
  assert.equal(again.data.secondaryChanged, true);
  assert.equal(state.secondaryModel.defaultModel, `${DS}/deepseek-v4.1-flash`);
});

test('a [secondary_model] that has only a default_effort is the user\'s: nothing is added, the effort is not touched', async () => {
  fresh({ secondaryModel: { defaultEffort: 'high' } });
  const textBefore = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.match(textBefore, /\[secondary_model\]\ndefault_effort = "high"/);
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.secondaryWarning, /default_model/);
  assert.equal(r.data.secondaryChanged, undefined);
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model), 'no secondary write');
  assert.equal(state.secondaryModel.defaultModel, undefined, 'no default_model added');
  assert.equal(state.secondaryModel.defaultEffort, 'high', 'the effort is still high, not max');
  assert.ok(state.providers[DS], 'the provider is there');
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.match(text, /\[secondary_model\]\ndefault_effort = "high"\n/);
  assert.doesNotMatch(text, /default_effort = "max"/);
  // The same holds on every later provision.
  writes.length = 0;
  const again = await provision();
  assert.equal(again.ok, true);
  assert.ok(!writes.some(([, p, body]) => p === '/api/v1/config' && body?.secondary_model));
});

test('what is not a gateway, a model or a key Kimi may be given is refused before anything is written', async () => {
  const bad = [
    [{ gateway: 'evil' }, /閘道/],
    [{ gateway: 'deepseek' }, /閘道/],
    [{ gateway: 'opencode-zen' }, /閘道/],
    [{ gateway: undefined }, /閘道/],
    [{ gateway: '__proto__' }, /閘道/],
    [{ apiKey: '' }, /API key/],
    [{ apiKey: 'has space' }, /API key/],
    [{ apiKey: 'line\nbreak' }, /API key/],
    [{ apiKey: 'tab\there' }, /API key/],
    [{ apiKey: 'x'.repeat(501) }, /API key/],
    [{ apiKey: 12345 }, /API key/],
    [{ models: [] }, /1 到 20/],
    [{ models: 'deepseek-v4-pro' }, /1 到 20/],
    [{ models: models(Array.from({ length: 21 }, (_, i) => `deepseek-m${i}`)) }, /1 到 20/],
    [{ models: models(['bad name']) }, /模型名稱不合法/],
    [{ models: models(['x'.repeat(101)]) }, /模型名稱不合法/],
    [{ models: models(['../etc']) }, /模型名稱不合法/],
    [{ models: models(['a/../b']) }, /模型名稱不合法/],
    [{ models: models(['/abs']) }, /模型名稱不合法/],
    [{ models: models(['a$b']) }, /模型名稱不合法/],
    [{ models: [{ max_context_size: 1_000_000 }] }, /模型名稱不合法/],
    [{ models: models(['a', 'a']) }, /重複/],
    [{ models: [{ ...models(['a'])[0], max_context_size: 'big' }] }, /max_context_size/],
    [{ models: [{ ...models(['a'])[0], max_context_size: 5 }] }, /max_context_size/],
    [{ models: [{ ...models(['a'])[0], max_context_size: 1e12 }] }, /max_context_size/],
    [{ models: [{ ...models(['a'])[0], max_output_size: -1 }] }, /max_output_size/],
    [{ models: [{ ...models(['a'])[0], support_efforts: ['high', 'ludicrous'] }] }, /support_efforts/],
    [{ models: [{ ...models(['a'])[0], capabilities: ['tool_use', 'root_access'] }] }, /capabilities/],
    [{ models: [{ ...models(['a'])[0], display_name: 'x\ny' }] }, /顯示名稱/],
  ];
  for (const [over, why] of bad) {
    const r = await provision(over);
    assert.equal(r.ok, false, JSON.stringify(over).slice(0, 80));
    assert.match(r.error, why, JSON.stringify(over).slice(0, 80));
  }
  assert.deepEqual(writes, [], 'nothing reached Kimi');
});

test('only the fields the bridge knows go to Kimi', async () => {
  const m = { ...models()[0], default_model: 'x', api_key: 'sneaky', adaptive_thinking: true, base_url: 'https://evil.example', extra: { a: 1 } };
  const r = await provision({ models: [m, models()[1]] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(posted()[0][2].models[0]).sort(), ['capabilities', 'display_name', 'max_context_size', 'max_output_size', 'model', 'support_efforts']);
  assert.deepEqual(Object.keys(posted()[0][2]).sort(), ['api_key', 'base_url', 'id', 'models', 'type']);
});

test('gateways that want a session header get one on the provider, the same every time on this computer', async () => {
  const header = () => state.providers[DS].custom_headers;
  assert.equal((await provision({ gateway: 'opencode-go' })).data.sessionHeader, true);
  const ses = header()['x-opencode-session'];
  assert.match(ses, /^ses_agenthub_[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(header()), ['x-opencode-session']);
  // Written to config.toml, into the DeepSeek provider's table only.
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.match(text, new RegExp(`\\[providers\\.${DS}\\.custom_headers\\]\\nx-opencode-session = "${ses}"`));
  assert.ok(!/\[providers\.other\.custom_headers\]|\[providers\."managed:kimi-code"\.custom_headers\]/.test(text));
  assert.equal(state.providers.other.custom_headers, undefined);
  assert.equal(state.providers[MANAGED].custom_headers, undefined);
  // The same id with the other OpenCode gateway, and under Command Code's header name.
  fresh();
  assert.equal((await provision({ gateway: 'opencode' })).data.sessionHeader, true);
  assert.equal(header()['x-opencode-session'], ses);
  fresh();
  const cc = await provision({ gateway: 'commandcode', models: models(['deepseek/deepseek-v4.1-flash']) });
  assert.equal(cc.data.sessionHeader, true);
  assert.deepEqual(header(), { 'x-session-id': ses });
  // Nothing about it in the answer that is not safe to show.
  assert.ok(!JSON.stringify(cc.data).includes('sk-test-key'));
});

test('a config write that changes anything else is undone, and the hub is told the header is missing', async () => {
  fresh({ corruptConfig: true });
  const before = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  const r = await provision();
  // The provider itself was made; the header was not kept.
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.sessionHeader, false);
  assert.match(r.data.warning, /已還原/);
  // config.toml is what it was just before the header write: the provider's
  // tables there, nothing lost, no leftover backup or temp file.
  const after = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.ok(after.includes('[providers.other]'), 'the other provider is still in the file');
  assert.ok(!after.includes('custom_headers'));
  assert.notEqual(after, '');
  assert.ok(before.length > 0);
  assert.deepEqual(fs.readdirSync(KIMI_HOME).filter((f) => f.endsWith('.tmp')), []);
});

test('through kimi.request the hub still cannot make, replace or delete providers, or move the default', async () => {
  const attempts = [
    ['POST', '/api/v1/providers', { id: 'x', type: 'openai', models: [{ model: 'm', max_context_size: 1000 }] }],
    ['PUT', `/api/v1/providers/${DS}`, { type: 'openai', models: [] }],
    ['PUT', '/api/v1/providers/other', { type: 'openai', models: [] }],
    ['DELETE', `/api/v1/providers/${DS}`, undefined],
    ['DELETE', '/api/v1/providers/other', undefined],
    ['DELETE', `/api/v1/providers/${MANAGED}`, undefined],
    ['POST', '/api/v1/sessions/session_x:takeover', {}],
    ['POST', `/api/v1/models/${encodeURIComponent('other/m')}:set_default`, {}],
    ['POST', '/api/v1/providers:import_catalog', { catalog_id: 'x' }],
    ['POST', '/api/v1/config', { default_model: 'other/m' }],
    ['POST', '/api/v1/oauth/logout', {}],
  ];
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  for (const [method, p, body] of attempts) {
    const r = await ask('kimi.request', { method, path: p, body });
    assert.equal(r.ok, false, `${method} ${p}`);
    assert.match(r.error, /連接器拒絕了這個請求/, `${method} ${p}`);
  }
  assert.deepEqual(writes, []);
  // Reading them is as before.
  const list = await ask('kimi.request', { method: 'GET', path: '/api/v1/providers' });
  assert.equal(list.data.code, 0);
  assert.equal(list.data.data.items.length, 3);
});

test('remove deletes agent-hub-deepseek and nothing else', async () => {
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  const r = await ask('kimi.deepseek.remove', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.removed, true);
  assert.equal(r.data.secondaryRemoved, true);
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`DELETE /api/v1/providers/${DS}`]);
  assert.deepEqual(Object.keys(state.providers), [MANAGED, 'other']);
  assert.equal(state.defaultModel, SUB);
  assert.equal(state.defaultProvider, MANAGED);
  assert.deepEqual(state.thinking, { enabled: true, effort: 'high' });
  // The [secondary_model] this hub wrote is gone, from Kimi's view and the
  // file; no alias pointing at the removed provider is left behind.
  assert.equal(state.secondaryModel, undefined);
  const text = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
  assert.doesNotMatch(text, /\[secondary_model\]|agent-hub-deepseek\//);
  // Again: nothing there, nothing done.
  writes.length = 0;
  const again = await ask('kimi.deepseek.remove', {});
  assert.deepEqual([again.ok, again.data.removed, writes], [true, false, []]);
  assert.equal(state.secondaryModel, undefined);
  // The args cannot name another provider.
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  await ask('kimi.deepseek.remove', { id: 'other', provider: 'other', path: '/api/v1/providers/other' });
  assert.ok(state.providers.other && state.providers[MANAGED]);
});

// People edit config.toml by hand. A table the hub wrote, later touched up by
// its user (a comment on the header, single quotes), is still the hub's table:
// removal must recognise it and take away exactly that table.
test('remove recognises the hub\'s [secondary_model] after a hand edit, and leaves the rest of the file alone', { skip: tomlSkip }, async () => {
  assert.equal((await provision()).ok, true);
  const file = path.join(KIMI_HOME, 'config.toml');
  const canonical = fs.readFileSync(file, 'utf8');
  const edited = canonical.replace('[secondary_model]', "[secondary_model] # subagents (edited by me)").replace(/default_model = "([^"]+)"/, "default_model = '$1'");
  assert.notEqual(edited, canonical);
  fs.writeFileSync(file, `# my own notes\n${edited}`);
  const parsedBefore = parseToml(fs.readFileSync(file, 'utf8'));
  writes.length = 0;
  // Kimi's own save after the provider is deleted would rewrite the file in its
  // style (it drops comments); keep the file as the connector left it to see
  // the connector's edit alone.
  state.preserveFile = true;
  const r = await ask('kimi.deepseek.remove', {});
  state.preserveFile = false;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.secondaryRemoved, true);
  const text = fs.readFileSync(file, 'utf8');
  const parsedAfter = parseToml(text);
  assert.equal(parsedAfter.secondary_model, undefined);
  assert.ok(text.startsWith('# my own notes\n'), 'the user\'s own first line is still there');
  assert.equal(parsedAfter.default_model, SUB);
  assert.deepEqual(parsedAfter.providers.other, parsedBefore.providers.other);
  assert.deepEqual({ ...parsedAfter, secondary_model: undefined, providers: undefined }, { ...parsedBefore, secondary_model: undefined, providers: undefined });
});

test('remove refuses, and changes nothing, when the hub\'s table was rewritten as an inline table or with a pool', { skip: tomlSkip }, async () => {
  assert.equal((await provision()).ok, true);
  const file = path.join(KIMI_HOME, 'config.toml');
  const alias = `${DS}/deepseek-v4.1-flash`;
  const body = fs.readFileSync(file, 'utf8').replace(/\[secondary_model\]\n[^\[]*/, '');
  for (const shape of [
    `secondary_model = { default_model = "${alias}", default_effort = "max" }\n`,
    `secondary_model.default_model = "${alias}"\nsecondary_model.default_effort = "max"\n`,
  ]) {
    fs.writeFileSync(file, shape + body);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(parseToml(text).secondary_model, 'valid TOML with a secondary_model');
    writes.length = 0;
    const r = await ask('kimi.deepseek.remove', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /secondary_model/);
    assert.deepEqual(writes, [], 'the provider was not deleted');
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file was not touched');
  }
});

// The gateway changed and the user's [secondary_model] names the old aliases in
// a spelling the connector must not edit blindly: the provider is still
// provided, the file is byte for byte as it was, and the reason is reported.
test('a stale alias in a [secondary_model] that cannot be edited safely is a warning; the file is not touched', { skip: tomlSkip }, async () => {
  const old = `${DS}/deepseek/deepseek-v4.1-flash`;
  fresh({ secondaryModel: { defaultModel: old, defaultEffort: 'high', models: { [old]: '舊閘道的 Flash', [SUB]: 'kimi' }, force: false } });
  // The fake lists the old alias as a model Kimi still resolves.
  state.models[old] = { provider: DS, display_name: 'old flash' };
  const file = path.join(KIMI_HOME, 'config.toml');
  const inline = `secondary_model = { default_model = "${old}", default_effort = "high", models = { "${old}" = "舊閘道的 Flash", "${SUB}" = "kimi" } }\n`;
  fs.writeFileSync(file, inline + fs.readFileSync(file, 'utf8').replace(/\[secondary_model\][\s\S]*?(?=\n\[providers)/, ''));
  // Kimi's own writes keep this spelling in this scenario (a Kimi that edits in place).
  const text = fs.readFileSync(file, 'utf8');
  state.preserveFile = true;
  const r = await provision();
  state.preserveFile = false;
  assert.equal(r.ok, true, r.error);
  assert.ok(state.providers[DS], 'the DeepSeek provider is provided');
  assert.match(r.data.secondaryWarning || '', /secondary_model/);
  assert.match(r.data.secondaryWarning || '', /沒有改動這個檔案|無法安全修復/);
  assert.equal(r.data.secondaryChanged, undefined);
  assert.ok(fs.readFileSync(file, 'utf8').includes(inline), 'the inline table is still there, byte for byte');
  assert.ok(text.includes(inline));
});

test('remove keeps a secondary_model the user set up and leaves its other entries alone', async () => {
  fresh({ secondaryModel: { defaultModel: SUB, defaultEffort: 'high', models: { [SUB]: 'kimi', 'kimi-code/k3': 'k3' }, force: false } });
  assert.equal((await provision()).ok, true);
  const before = structuredClone(state.secondaryModel);
  assert.equal((await ask('kimi.deepseek.remove', {})).ok, true);
  assert.deepEqual(state.secondaryModel, before);
});

test('remove stops instead of leaving a DeepSeek alias when the secondary table is no longer ours', async () => {
  assert.equal((await provision()).ok, true);
  // The user added another model to the pool: the config API can merge but
  // cannot delete that one key, so removing the provider would leave a
  // dangling alias. Removal must refuse and change nothing.
  state.secondaryModel = { ...state.secondaryModel, models: { [`${DS}/deepseek-v4.1-flash`]: 'hub', [SUB]: 'kimi' } };
  writeToml();
  writes.length = 0;
  const r = await ask('kimi.deepseek.remove', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /secondary_model/);
  assert.deepEqual(writes, [], 'provider not deleted');
  assert.ok(state.providers[DS]);
  assert.ok(state.secondaryModel.models[`${DS}/deepseek-v4.1-flash`] !== undefined);
});

test('remove refuses while Kimi\'s default model is a DeepSeek one (it would be left dangling)', async () => {
  assert.equal((await provision()).ok, true);
  state.defaultModel = `${DS}/deepseek-v4-pro`;
  writes.length = 0;
  const r = await ask('kimi.deepseek.remove', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /預設模型是 DeepSeek/);
  assert.deepEqual(writes, []);
});

test('Kimi\'s own error never carries the key', async () => {
  fresh();
  state.providers[DS] = { type: 'openai', models: [] };
  const orig = state.models;
  // Make the replace fail the way a validation error does, echoing the body.
  const srvRequest = kimi.listeners('request')[0];
  kimi.removeAllListeners('request');
  kimi.on('request', (req, res) => {
    if (req.method === 'PUT') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ code: 40001, msg: `invalid body ${raw}`, data: null }))));
      return;
    }
    srvRequest(req, res);
  });
  try {
    const r = await provision({ apiKey: 'sk-secret-key-9999' });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('sk-secret-key-9999'), r.error);
    assert.match(r.error, /\*\*\*/);
  } finally {
    kimi.removeAllListeners('request');
    kimi.on('request', srvRequest);
    state.models = orig;
  }
});
