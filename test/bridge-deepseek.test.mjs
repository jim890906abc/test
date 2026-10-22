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
        return ok({ ...(state.defaultModel ? { default_model: state.defaultModel } : {}), default_provider: state.defaultProvider, thinking: state.thinking, ...(state.secondaryModel ? { secondary_model: state.secondaryModel } : {}) });
      }
      if (req.method === 'GET' && url === '/api/v1/providers') {
        return ok({
          items: Object.entries(state.providers).map(([id, p]) => ({ id, type: p.type, base_url: p.base_url, ...(id === MANAGED ? (state.managedDefault ? { default_model: state.managedDefault } : {}) : {}), has_api_key: true, status: 'connected', models: p.models })),
        });
      }
      // POST /config {providers: {id: {custom_headers}}}: Kimi merges into [providers]
      // and writes config.toml (the fake writes the tables it knows).
      if (req.method === 'POST' && url === '/api/v1/config') {
        for (const [id, p] of Object.entries(body.providers || {})) {
          if (!state.providers[id]) return err(40001, 'no such provider');
          state.providers[id].custom_headers = { ...(state.providers[id].custom_headers || {}), ...(p.custom_headers || {}) };
          if (state.corruptConfig) delete state.providers.other;
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
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill'], { env, stdio: 'ignore' });
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
  // The provider, then its session header; the default was already set, nothing to pin.
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), ['POST /api/v1/providers', 'POST /api/v1/config']);
  const [method, p, body] = writes[0];
  assert.deepEqual([method, p], ['POST', '/api/v1/providers']);
  assert.equal(body.id, DS);
  assert.equal(body.type, 'openai');
  assert.equal(body.base_url, 'https://opencode.ai/inference/go/openai/v1', 'the bridge\'s own address for the gateway');
  assert.equal(body.api_key, 'sk-test-key-1234');
  assert.ok(!('default_model' in body), 'Kimi\'s own pointer is never in the body');
  assert.deepEqual(body.models[0], { model: 'deepseek-v4.1-flash', max_context_size: 1_000_000, max_output_size: 384_000, display_name: 'DS deepseek-v4.1-flash', capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] });
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
  // Pinned (by Kimi's set-default request) before the provider was made.
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`POST /api/v1/models/${SUB}:set_default`, 'POST /api/v1/providers', 'POST /api/v1/config']);
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
  const r = await provision({ apiKey: 'sk-new-key-5678', gateway: 'commandcode', models: models(['deepseek/deepseek-v4-pro']) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.created, false);
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`PUT /api/v1/providers/${DS}`, 'POST /api/v1/config']);
  const body = writes[0][2];
  assert.equal(body.base_url, 'https://api.commandcode.ai/provider/v1');
  assert.equal(body.api_key, 'sk-new-key-5678');
  assert.ok(!('default_model' in body) && !('id' in body) && !('new_id' in body));
  assert.deepEqual(state.providers[DS].models, [`${DS}/deepseek/deepseek-v4-pro`]);
  assert.equal(state.defaultModel, SUB);
});

test('a [secondary_model] is reported, never changed', async () => {
  fresh({ secondaryModel: { defaultModel: SUB, models: { [SUB]: '' }, force: false } });
  const r = await provision();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.secondaryModel, { model: SUB, models: [SUB], force: false });
  assert.deepEqual(state.secondaryModel, { defaultModel: SUB, models: { [SUB]: '' }, force: false });
  fresh();
  assert.equal((await provision()).data.secondaryModel, undefined);
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
  const m = { ...models(['deepseek-v4-pro'])[0], default_model: 'x', api_key: 'sneaky', adaptive_thinking: true, base_url: 'https://evil.example', extra: { a: 1 } };
  const r = await provision({ models: [m] });
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
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [`DELETE /api/v1/providers/${DS}`]);
  assert.deepEqual(Object.keys(state.providers), [MANAGED, 'other']);
  assert.equal(state.defaultModel, SUB);
  // Again: nothing there, nothing done.
  writes.length = 0;
  const again = await ask('kimi.deepseek.remove', {});
  assert.deepEqual([again.ok, again.data.removed, writes], [true, false, []]);
  // The args cannot name another provider.
  assert.equal((await provision()).ok, true);
  writes.length = 0;
  await ask('kimi.deepseek.remove', { id: 'other', provider: 'other', path: '/api/v1/providers/other' });
  assert.ok(state.providers.other && state.providers[MANAGED]);
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
