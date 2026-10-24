// A fake Kimi 2.1.1 server for the bridge's config-writing ops (providers and the
// subagent model pool), faithful where it matters:
//   • POST /config only MERGES (deepMerge), a null cannot delete a key of a table, and
//     the values of [secondary_model.models] must be strings;
//   • Kimi keeps config.toml itself and regroups its tables when it writes (providers
//     first, then models, then the rest);
//   • Kimi watches config.toml: whatever is written to the file by someone else is read
//     again (a fake `watch: false` turns that off, like [watch] enabled = false);
//   • createProvider SEEDS the global default model when none is set.
// Used with the real bridge, spawned (see test/bridge-hub-models.test.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

export const MANAGED = 'managed:kimi-code';
export const SUB = 'managed:kimi-code/kimi-for-coding';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b ?? a;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = isObj(out[k]) && isObj(b[k]) ? deepMerge(out[k], b[k]) : b[k];
  return out;
}
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// snake_case → camelCase, except the keys of the tables that are maps (providers, models).
function camelKeys(o, preserve = false) {
  if (Array.isArray(o)) return o.map((x) => camelKeys(x));
  if (!isObj(o)) return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [preserve ? k : camel(k), camelKeys(v, !preserve && ['providers', 'models', 'raw', 'experimental'].includes(k))]));
}
const q = (s) => JSON.stringify(String(s));

export function createFakeKimi({ home }) {
  const file = path.join(home, 'config.toml');
  const k = {
    state: null,
    writes: [], // [method, path, body] of everything that is not a GET
    written: '', // config.toml as Kimi last wrote it
    watch: true,
    rejectPool: false, // a POST /config with secondary_model fails (Kimi turns the pool down)
    corruptConfig: false, // a POST /config also loses another provider
    hijack: false, // createProvider moves the default even when one is set
    extraToml: '', // tables of Kimi's the hub knows nothing about
  };

  k.reset = (over = {}) => {
    k.state = {
      defaultModel: SUB,
      defaultProvider: MANAGED,
      thinking: { enabled: true, effort: 'high' },
      secondary: undefined, // camelCase, like GET /config answers
      providers: { [MANAGED]: { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', default_model: SUB, models: [SUB] }, other: { type: 'openai', base_url: 'https://other.example/v1', api_key: 'sk-other', models: ['other/m', 'other/n'] } },
      models: {
        [SUB]: { provider: MANAGED, model: 'kimi-for-coding', display_name: 'kimi-for-coding', max_context_size: 262144, capabilities: ['thinking', 'image_in', 'tool_use'] },
        'other/m': { provider: 'other', model: 'm', display_name: 'm', max_context_size: 100000, capabilities: ['tool_use'] },
        'other/n': { provider: 'other', model: 'n', display_name: 'n', max_context_size: 100000, capabilities: ['tool_use'] },
      },
      managedDefault: SUB,
      ...over,
    };
    k.writes = [];
    k.watch = true;
    k.rejectPool = false;
    k.corruptConfig = false;
    k.hijack = false;
    k.extraToml = '[loop_control]\nmax_steps = 30\n\n[telemetry_x]\nenabled = false\n';
    fs.mkdirSync(home, { recursive: true });
    k.save();
  };

  // config.toml the way Kimi writes it.
  k.toml = () => {
    const s = k.state;
    const L = [];
    if (s.defaultModel) L.push(`default_model = ${q(s.defaultModel)}`, '');
    for (const [id, p] of Object.entries(s.providers)) {
      L.push(`[providers.${/[:\s]/.test(id) ? q(id) : id}]`, `type = ${q(p.type)}`, `base_url = ${q(p.base_url || '')}`);
      if (p.api_key) L.push(`api_key = ${q(p.api_key)}`);
      if (p.default_model) L.push(`default_model = ${q(p.default_model)}`);
      if (p.custom_headers) L.push('', `[providers.${id}.custom_headers]`, ...Object.entries(p.custom_headers).map(([a, b]) => `${a} = ${q(b)}`));
      L.push('');
    }
    for (const [alias, m] of Object.entries(s.models)) {
      L.push(`[models.${q(alias)}]`, `provider = ${q(m.provider)}`, `model = ${q(m.model || alias.split('/').pop())}`, `max_context_size = ${m.max_context_size || 1000}`);
      if (m.capabilities) L.push(`capabilities = [ ${m.capabilities.map(q).join(', ')} ]`);
      if (m.display_name) L.push(`display_name = ${q(m.display_name)}`);
      if (m.support_efforts) L.push(`support_efforts = [ ${m.support_efforts.map(q).join(', ')} ]`);
      if (m.default_effort) L.push(`default_effort = ${q(m.default_effort)}`);
      L.push('');
    }
    if (s.thinking?.effort) L.push('[thinking]', `effort = ${q(s.thinking.effort)}`, '');
    if (k.extraToml) L.push(k.extraToml, '');
    const sec = s.secondary;
    if (sec) {
      const head = [];
      if (sec.defaultModel !== undefined) head.push(`default_model = ${q(sec.defaultModel)}`);
      if (sec.model !== undefined) head.push(`model = ${q(sec.model)}`);
      if (sec.defaultEffort !== undefined) head.push(`default_effort = ${q(sec.defaultEffort)}`);
      if (sec.force !== undefined) head.push(`force = ${sec.force}`);
      L.push('[secondary_model]', ...head, '');
      if (sec.models) L.push('[secondary_model.models]', ...Object.entries(sec.models).map(([a, d]) => `${q(a)} = ${q(d)}`), '');
    }
    return L.join('\n');
  };
  k.save = () => {
    k.written = k.toml();
    fs.writeFileSync(file, k.written);
  };

  // Someone else changed config.toml: Kimi reads the pool tables again.
  const reload = () => {
    if (!k.watch) return;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text === k.written) return;
    const sec = {};
    let table = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      const h = t.match(/^\[(.+)\]$/);
      if (h) {
        table = h[1].replace(/\s+/g, '');
        continue;
      }
      const kv = t.match(/^(?:"((?:[^"\\]|\\.)*)"|([\w-]+))\s*=\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1] !== undefined ? JSON.parse(`"${kv[1]}"`) : kv[2];
      let val = kv[3];
      try {
        val = JSON.parse(val);
      } catch {}
      if (table === 'secondary_model') sec[camel(key)] = val;
      else if (table === 'secondary_model.models') (sec.models ??= {})[key] = val;
    }
    k.state.secondary = Object.keys(sec).length ? sec : undefined;
    k.written = text;
  };

  const modelItem = (alias, m) => ({ provider: m.provider, model: alias, display_name: m.display_name || alias, max_context_size: m.max_context_size || 1000, ...(m.capabilities ? { capabilities: m.capabilities } : {}), ...(m.support_efforts ? { support_efforts: m.support_efforts } : {}), ...(m.default_effort ? { default_effort: m.default_effort } : {}) });

  k.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      reload();
      const body = raw ? JSON.parse(raw) : undefined;
      const url = decodeURIComponent(req.url.split('?')[0]);
      const s = k.state;
      const ok = (data, code = 0) => {
        if (req.method !== 'GET') k.save();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code, msg: 'success', data }));
      };
      const err = (code, msg) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ code, msg, data: null })));
      if (req.method !== 'GET') k.writes.push([req.method, url, body]);
      if (url === '/api/v1/healthz') return ok({ ok: true });
      if (req.method === 'GET' && url === '/api/v1/config') {
        return ok({ ...(s.defaultModel ? { default_model: s.defaultModel } : {}), default_provider: s.defaultProvider, thinking: s.thinking, ...(s.secondary ? { secondary_model: s.secondary } : {}) });
      }
      if (req.method === 'GET' && url === '/api/v1/providers') {
        return ok({ items: Object.entries(s.providers).map(([id, p]) => ({ id, type: p.type, base_url: p.base_url, ...(id === MANAGED && s.managedDefault ? { default_model: s.managedDefault } : {}), has_api_key: true, status: 'connected', models: p.models })) });
      }
      if (req.method === 'GET' && url === '/api/v1/models') return ok({ items: Object.entries(s.models).map(([a, m]) => modelItem(a, m)) });
      // POST /config: merge semantics, snake_case in, camelCase kept.
      if (req.method === 'POST' && url === '/api/v1/config') {
        if (body.secondary_model !== undefined) {
          if (k.rejectPool) return err(40001, 'secondary_model: invalid');
          const patch = camelKeys(body.secondary_model);
          for (const [a, d] of Object.entries(patch.models || {})) if (typeof d !== 'string') return err(40001, `Invalid input: expected string for ${a}`);
          s.secondary = deepMerge(s.secondary || {}, patch);
        }
        for (const [id, p] of Object.entries(body.providers || {})) {
          if (!s.providers[id]) return err(40001, 'no such provider');
          s.providers[id].custom_headers = { ...(s.providers[id].custom_headers || {}), ...(p.custom_headers || {}) };
        }
        for (const [alias, patch] of Object.entries(body.models || {})) {
          if (!s.models[alias]) return err(40001, `no such model ${alias}`);
          Object.assign(s.models[alias], patch);
        }
        if (k.corruptConfig) delete s.providers.other;
        return ok({});
      }
      const pin = url.match(/^\/api\/v1\/models\/(.+):set_default$/);
      if (req.method === 'POST' && pin) {
        if (!s.models[pin[1]]) return err(40113, 'model does not exist');
        s.defaultModel = pin[1];
        return ok({ default_model: pin[1] });
      }
      const fill = (id, models) => Object.fromEntries(models.map((m) => [`${id}/${m.model}`, { provider: id, model: m.model, display_name: m.display_name || m.model, max_context_size: m.max_context_size, max_output_size: m.max_output_size, capabilities: m.capabilities, support_efforts: m.support_efforts, ...(m.adaptive_thinking !== undefined ? { adaptive_thinking: m.adaptive_thinking } : {}) }]));
      if (req.method === 'POST' && url === '/api/v1/providers') {
        if (s.providers[body.id]) return err(40901, `provider ${body.id} already exists`);
        s.providers[body.id] = { type: body.type, base_url: body.base_url, api_key: body.api_key, models: body.models.map((m) => `${body.id}/${m.model}`) };
        Object.assign(s.models, fill(body.id, body.models));
        if (!s.defaultModel || k.hijack) s.defaultModel = `${body.id}/${body.default_model || body.models[0].model}`;
        res.statusCode = 201;
        return ok(s.providers[body.id]);
      }
      const one = url.match(/^\/api\/v1\/providers\/([\w -]+)$/);
      if (req.method === 'PUT' && one) {
        const p = s.providers[one[1]];
        if (!p) return err(40401, 'provider does not exist');
        for (const a of p.models) delete s.models[a];
        Object.assign(p, { type: body.type, base_url: body.base_url, api_key: body.api_key, models: body.models.map((m) => `${one[1]}/${m.model}`) });
        Object.assign(s.models, fill(one[1], body.models));
        return ok({ provider: p });
      }
      if (req.method === 'DELETE' && one) {
        const p = s.providers[one[1]];
        if (!p) return err(40401, 'provider does not exist');
        for (const a of p.models) delete s.models[a];
        delete s.providers[one[1]];
        k.save();
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      err(404, 'no route');
    });
  });
  new WebSocketServer({ server: k.server, path: '/api/v1/ws' });

  // Listens, and tells the bridge where (the instance file and token Kimi writes).
  k.listen = async () => {
    await new Promise((r) => k.server.listen(0, '127.0.0.1', r));
    const port = k.server.address().port;
    fs.mkdirSync(path.join(home, 'server', 'instances'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'instances', 'a.json'), JSON.stringify({ port, host: '127.0.0.1', pid: process.pid, server_id: 'srv1', started_at: Date.now() }));
    fs.writeFileSync(path.join(home, 'server.token'), 'server-token');
    return port;
  };
  return k;
}
