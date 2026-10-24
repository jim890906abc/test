// One kind of conversation, whatever the model, end to end: the real hub, a
// fake gateway (DeepSeek's key check), a fake Claude API (the key check), and
// scripted machines that speak the bridge protocol and play Kimi: its models
// and config (with the [secondary_model] pool), conversations, and the
// providers and the pool the bridge would write (bridge 0.9.0), or only the
// old DeepSeek op (0.8.0). No Kimi, gateway or account needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startFakeClaude } from './fixtures/fake-anthropic.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-models-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 30000 + Math.floor(Math.random() * 2000);
const TOKEN = 'models-token';
const MID = 'm_new';
const OLD_MID = 'm_old';
const SUB = 'managed:kimi-code/kimi-for-coding';
const K3 = 'managed:kimi-code/k3-256k';
const DS_FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
const DS_PRO = 'agent-hub-deepseek/deepseek-v4-pro';
const OPUS = 'agent-hub-claude/claude-opus-5-5';
const SONNET = 'agent-hub-claude/claude-sonnet-5-5';
const DS_KEY = 'sk-oc-go-0123456789wxyz';
const CLAUDE_KEY = `sk-ant-api03-${'k'.repeat(40)}-test`;
let hub;
let gateway;
let claudeApi;
let machine; // bridge 0.9.0
let old; // bridge 0.8.0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const session = (id) => api('GET', `/sessions/${id}`);
const infos = async (id) => (await session(id)).events.filter((e) => e.type === 'info').map((e) => e.text);

// ------------------------------------------------------------ the fakes

function fakeGateway() {
  return http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/opencode-go/models') return (res.statusCode = 404), res.end('{}');
    if (req.headers.authorization !== `Bearer ${DS_KEY}`) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    res.end(JSON.stringify({ data: [{ id: 'kimi-k2' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
  });
}

// A computer: Kimi's models and config, conversations, and the bridge's ops.
// `version` decides which ops the bridge knows.
function fakeMachine(key, { id, version }) {
  const hubOps = version >= '0.9.0';
  const k = {
    id,
    sessions: new Map(), // kimi session id -> { cwd, model, thinking, title }
    provisioned: [], // args of kimi.hub.provision / kimi.deepseek.provision
    removed: [], // args of kimi.hub.remove / kimi.deepseek.remove
    syncs: [], // args of kimi.subagents.sync
    log: [], // every bridge op that changes Kimi, in order
    requests: [], // every kimi.request
    specs: new Map(), // alias -> model as the provider gave it
    pool: null, // Kimi's [secondary_model]: { default_model, models: { alias: description } }
    poolEfforts: {},
    force: false, // the user's Kimi locks the pool
    profiles: [], // { sid, agent_config }
    prompts: [], // { sid, parts, text, body }
    archived: [],
    n: 0,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const infoOf = (sid) => {
    const s = k.sessions.get(sid);
    return { id: sid, title: s.title, metadata: { cwd: s.cwd }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', owner: null, controllable: null, model: s.model, effort: s.thinking };
  };
  const modelItems = () => [
    { model: SUB, display_name: 'kimi-for-coding', max_context_size: 262144, capabilities: ['thinking', 'image_in', 'tool_use'] },
    { model: K3, display_name: 'K3-256k', max_context_size: 262144, capabilities: ['thinking', 'image_in', 'tool_use'], support_efforts: ['low', 'high'] },
    ...[...k.specs].map(([alias, m]) => ({ ...m, model: alias })),
  ];
  const frame = (sid, type, payload) => {
    const f = { type, session_id: sid, time: Date.now(), payload: { agentId: 'main', ...payload, sessionId: sid } };
    send({ t: 'kimi.event', frame: f });
  };
  k.frame = frame;
  k.add = (sid, over = {}) => {
    k.sessions.set(sid, { cwd: '/tmp/project', model: '', thinking: '', title: sid, ...over });
    send({ t: 'kimi.session.update', item: { ...infoOf(sid), updated_at: new Date().toISOString() } });
  };
  // A turn that answers at once.
  const answer = (sid, promptId, text) => {
    k.turn = (k.turn || 0) + 1;
    const turnId = `t${k.turn}`;
    setTimeout(() => {
      frame(sid, 'turn.started', { turnId, promptId, origin: { kind: 'user' }, prompt: text });
      frame(sid, 'turn.ended', { turnId, reason: 'completed' });
    }, 20);
  };
  const request = (method, p, body) => {
    k.requests.push({ method, path: p, body });
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') {
      return ok({ default_model: SUB, ...(k.pool ? { secondary_model: { default_model: k.pool.default_model, models: k.pool.models, ...(k.force ? { force: true } : {}) } } : {}) });
    }
    if (p === '/api/v1/models') return ok({ items: modelItems() });
    if (method === 'POST' && p === '/api/v1/sessions') {
      const sid = `session_new${k.id}${++k.n}`;
      k.add(sid, { cwd: body.metadata.cwd });
      return ok({ id: sid, metadata: { cwd: body.metadata.cwd } });
    }
    const m = p.match(/^\/api\/v1\/sessions\/(session_\w+)(.*)$/);
    if (m && /\/skills$/.test(m[2])) return ok({ skills: [] });
    if (m && method === 'POST' && m[2] === '/profile') {
      k.profiles.push({ sid: m[1], agent_config: body.agent_config });
      const c = body.agent_config || {};
      if (c.model && !modelItems().some((x) => x.model === c.model)) return { code: 40113, msg: `model ${c.model} does not exist`, data: null };
      const s = k.sessions.get(m[1]);
      if (c.model) s.model = c.model;
      if (c.thinking) s.thinking = c.thinking;
      return ok({ id: m[1] });
    }
    if (m && method === 'POST' && m[2] === '/prompts') {
      const parts = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text);
      k.prompts.push({ sid: m[1], parts, text: parts[0], body });
      answer(m[1], body.prompt_id, parts[0]);
      return ok({ prompt_id: body.prompt_id, status: 'started' });
    }
    if (m && method === 'POST' && m[2] === ':archive') {
      k.archived.push(m[1]);
      return ok({});
    }
    return ok({});
  };
  const providerOf = (alias) => alias.split('/')[0];
  // The ops of the bridge. An old bridge answers "未知的操作" to the new ones.
  const ops = {
    'kimi.hub.provision': (a) => {
      k.log.push(`provision:${a.provider}`);
      k.provisioned.push(a);
      for (const alias of [...k.specs.keys()]) if (providerOf(alias) === `agent-hub-${a.provider}`) k.specs.delete(alias);
      for (const m of a.models) k.specs.set(`agent-hub-${a.provider}/${m.model}`, m);
      // A provision (PUT) drops the efforts the pool had set for it.
      for (const alias of Object.keys(k.poolEfforts)) if (providerOf(alias) === `agent-hub-${a.provider}`) delete k.poolEfforts[alias];
      return { ok: true, created: true, models: a.models.map((m) => `agent-hub-${a.provider}/${m.model}`), ...(a.provider === 'deepseek' ? { sessionHeader: true } : {}) };
    },
    'kimi.hub.remove': (a) => {
      k.log.push(`remove:${a.provider}`);
      k.removed.push(a);
      for (const alias of [...k.specs.keys()]) if (providerOf(alias) === `agent-hub-${a.provider}`) k.specs.delete(alias);
      if (k.pool) for (const alias of Object.keys(k.pool.models)) if (providerOf(alias) === `agent-hub-${a.provider}`) delete k.pool.models[alias];
      return { ok: true, removed: true, poolRemoved: true };
    },
    'kimi.subagents.sync': (a) => {
      k.log.push('sync');
      k.syncs.push(a);
      if (k.force) return { ok: true, skipped: 'force', pool: null, warning: 'locked' };
      k.pool = { default_model: SUB, models: { ...a.models } };
      k.poolEfforts = { ...a.efforts };
      return { ok: true, pool: { defaultModel: SUB, models: Object.keys(a.models) }, merged: true, efforts: { ...a.efforts }, added: [], removed: [] };
    },
    'kimi.deepseek.provision': (a) => {
      k.log.push('provision:deepseek');
      k.provisioned.push(a);
      for (const alias of [...k.specs.keys()]) if (providerOf(alias) === 'agent-hub-deepseek') k.specs.delete(alias);
      for (const m of a.models) k.specs.set(`agent-hub-deepseek/${m.model}`, m);
      return { ok: true, created: true, models: a.models.map((m) => `agent-hub-deepseek/${m.model}`), sessionHeader: true };
    },
    'kimi.deepseek.remove': (a) => {
      k.log.push('remove:deepseek');
      k.removed.push(a);
      for (const alias of [...k.specs.keys()]) if (providerOf(alias) === 'agent-hub-deepseek') k.specs.delete(alias);
      return { ok: true, removed: true };
    },
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: id, name: `fake-${id}`, platform: 'test', bridgeVersion: version, home: '/home/fake', status });
    send({ t: 'kimi.sessions', items: [] });
  });
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t !== 'req') return;
    const a = m.args || {};
    let out;
    switch (m.op) {
      case 'kimi.status':
      case 'kimi.start':
        out = status;
        break;
      case 'kimi.info':
        out = k.sessions.has(a.sessionId) ? infoOf(a.sessionId) : null;
        break;
      case 'kimi.history':
        out = { frames: [], more: false, before: 0, info: infoOf(a.sessionId) };
        break;
      case 'kimi.request':
        out = request(a.method, a.path, a.body);
        break;
      case 'workspace.create':
        out = { path: '/tmp/agent-hub-workspaces/new' };
        break;
      default:
        if (ops[m.op]) {
          if (/^kimi\.(hub|subagents)\./.test(m.op) && !hubOps) return send({ t: 'res', id: m.id, ok: false, error: `未知的操作：${m.op}` });
          out = ops[m.op](a);
        } else out = { ok: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  return k;
}

// What a prompt told Kimi's model about subagents.
const noteOf = (p) => p.parts.find((t) => t.startsWith('<system-reminder>When you launch subagents')) || null;
const promptsOf = (k, s) => k.prompts.filter((p) => p.sid === s.kimiSessionId);
const lastProfile = (k, s) => k.profiles.filter((x) => x.sid === s.kimiSessionId).at(-1)?.agent_config;
// Say something in a conversation, and wait for the prompt to reach Kimi.
async function say(k, s, text) {
  const n = promptsOf(k, s).length;
  await api('POST', `/sessions/${s.id}/messages`, { text });
  await until(async () => promptsOf(k, s).length > n, 5000, `prompt "${text}"`);
  await sleep(60);
  return promptsOf(k, s).at(-1);
}

before(async () => {
  gateway = fakeGateway();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  claudeApi = await startFakeClaude(CLAUDE_KEY);
  // Conversations from before the modes were merged, on disk when the hub starts.
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  const base = { status: 'idle', permissionMode: 'ask', allowedTools: [], state: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1, updatedAt: 1, titled: true, seq: 2 };
  const events = [{ id: 'e1', ts: 1, type: 'user', text: '以前的問題' }, { id: 'e2', ts: 2, type: 'text', text: '以前的回答' }];
  fs.writeFileSync(path.join(DATA, 'sessions', 's_oldds.json'), JSON.stringify({ ...base, id: 's_oldds', title: '舊的 DeepSeek 對話', agentId: `kimi@${MID}`, machineId: MID, kimiSessionId: 'session_oldds', cwd: '/tmp/old-ds', mode: 'deepseek', state: { deepseek: { gateway: 'opencode-go', model: DS_PRO } }, meta: { model: DS_PRO, effort: 'max' }, events }));
  fs.writeFileSync(path.join(DATA, 'sessions', 's_oldclaude.json'), JSON.stringify({ ...base, id: 's_oldclaude', title: '舊的 Claude 對話', agentId: 'claude', cwd: '/tmp/old-claude', meta: { model: 'claude-opus-5-5', effort: 'high' }, events }));
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${gateway.address().port}`, AGENT_HUB_CLAUDE_TEST_URL: claudeApi.url, ANTHROPIC_API_KEY: '' },
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
  machine = fakeMachine(key, { id: MID, version: '0.9.0' });
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'machine online');
  hub.key = key;
});

after(() => {
  machine?.close();
  old?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  claudeApi?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a computer that says hello gets a pool of subagent models: its own models, nothing else yet', async () => {
  await until(async () => machine.syncs.length >= 1, 10000, 'pool synced');
  assert.deepEqual(Object.keys(machine.syncs[0].models), [SUB, K3]);
  assert.deepEqual(machine.syncs[0].efforts, {}, 'Kimi decides its own models\' effort');
  assert.match(machine.syncs[0].models[SUB], /Kimi.*訂閱/);
  assert.equal(machine.pool.default_model, SUB);
  assert.deepEqual(machine.provisioned, [], 'no key, no provider');
  const cat = await api('GET', `/models?machineId=${MID}`);
  assert.deepEqual(cat.sources.map((s) => s.id), ['kimi']);
  assert.deepEqual(cat.sources[0].models.map((m) => m.id), [SUB, K3], 'listed whatever Kimi\'s default is');
  assert.equal(cat.sources[0].ready, true);
  assert.equal(cat.subagentEffortScope, 'per-model');
  assert.equal(cat.subagents.available, true);
});

test('a key given: its provider first, then the pool again with its models; DeepSeek subagents at max', async () => {
  await assert.rejects(api('PUT', '/deepseek', { apiKey: 'wrong-key' }), (e) => e.status === 400);
  await api('PUT', '/deepseek', { apiKey: DS_KEY });
  await until(async () => machine.provisioned.length === 1 && Object.keys(machine.pool.models).includes(DS_FLASH), 10000, 'DeepSeek provisioned and synced');
  const p = machine.provisioned[0];
  assert.deepEqual([p.provider, p.gateway, p.apiKey], ['deepseek', 'opencode-go', DS_KEY]);
  assert.deepEqual(p.models.map((m) => m.model), ['deepseek-v4-pro', 'deepseek-v4.1-flash']);
  assert.deepEqual(machine.log.slice(-2), ['provision:deepseek', 'sync'], 'the pool follows the provision');
  assert.deepEqual(machine.poolEfforts, { [DS_PRO]: 'max', [DS_FLASH]: 'max' });
  assert.deepEqual(Object.keys(machine.pool.models), [SUB, K3, DS_PRO, DS_FLASH]);
  assert.match(machine.pool.models[DS_FLASH], /DeepSeek.*DeepSeek 閘道 key/);

  await assert.rejects(api('PUT', '/claude', { apiKey: 'sk-ant-api03-wrongwrongwrongwrongwrong' }), (e) => e.status === 400);
  await api('PUT', '/claude', { apiKey: CLAUDE_KEY });
  await until(async () => machine.provisioned.some((x) => x.provider === 'claude') && Object.keys(machine.pool.models).includes(OPUS), 10000, 'Claude provisioned and synced');
  const c = machine.provisioned.find((x) => x.provider === 'claude');
  assert.deepEqual(Object.keys(c).sort(), ['apiKey', 'models', 'provider']);
  assert.equal(c.apiKey, CLAUDE_KEY);
  assert.deepEqual(c.models.map((m) => m.model), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(c.models[0].capabilities, ['thinking', 'always_thinking', 'tool_use', 'image_in']);
  assert.equal(c.models[0].adaptive_thinking, true);
  assert.deepEqual(machine.log.slice(-2), ['provision:claude', 'sync']);
  assert.deepEqual(Object.keys(machine.pool.models), [SUB, K3, DS_PRO, DS_FLASH, OPUS, SONNET]);
  assert.deepEqual(machine.poolEfforts, { [DS_PRO]: 'max', [DS_FLASH]: 'max' }, 'Claude: nothing set until 設定 says');
  // The keys never go to a page.
  for (const body of [await api('GET', '/config'), await api('GET', `/models?machineId=${MID}`)]) assert.ok(!JSON.stringify(body).includes(CLAUDE_KEY) && !JSON.stringify(body).includes(DS_KEY));
});

test('GET /api/models: every source with its models, efforts and billing', async () => {
  const cat = await api('GET', `/models?machineId=${MID}`);
  assert.deepEqual(cat.sources.map((s) => s.id), ['kimi', 'deepseek', 'claude']);
  const [kimi, ds, cl] = cat.sources;
  assert.deepEqual([kimi.label, kimi.billing, kimi.ready, kimi.defaultModel], ['Kimi', 'Kimi 訂閱', true, SUB]);
  assert.deepEqual(kimi.models.map((m) => m.id), [SUB, K3], 'the hub providers\' models are not Kimi\'s');
  assert.deepEqual(kimi.models[1], { id: K3, name: 'K3-256k', efforts: ['off', 'low', 'high'], defaultEffort: null, image: true, context: 262144, family: 'kimi' });
  assert.deepEqual([ds.label, ds.billing, ds.ready, ds.gateway.label], ['DeepSeek', 'OpenCode Go 的 API key', true, 'OpenCode Go']);
  assert.deepEqual(ds.models.map((m) => [m.id, m.family, m.efforts, m.defaultEffort]), [[DS_PRO, 'deepseek', ['low', 'high', 'max'], 'max'], [DS_FLASH, 'deepseek', ['low', 'high', 'max'], 'max']]);
  assert.deepEqual([cl.label, cl.ready], ['Claude', true]);
  assert.deepEqual(cl.models.map((m) => [m.id, m.name, m.family, m.efforts, m.defaultEffort]), [
    [OPUS, 'Claude Opus 5.5', 'claude', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    [SONNET, 'Claude Sonnet 5.5', 'claude', ['off', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'],
  ]);
  assert.match(cl.billing, /Claude Console 的 API key/);
  assert.equal(cat.subagentEffortScope, 'per-model');
  assert.deepEqual(cat.subagents.pool, [SUB, K3, DS_PRO, DS_FLASH, OPUS, SONNET]);
  // Without a computer: what the keys give, and a Kimi that is not ready.
  const none = await api('GET', '/models');
  assert.equal(none.sources[0].ready, false);
  assert.deepEqual(none.sources.map((s) => s.id), ['kimi', 'deepseek', 'claude']);
});

test('settings: the default main model can be any source\'s and the subagent model and efforts are kept; Kimi\'s global default is never touched', async () => {
  const cfg = await api('GET', '/config');
  assert.equal(cfg.settings.defaults.subagentModel, 'primary');
  assert.deepEqual(cfg.settings.subagentEfforts, {});
  const saved = await api('PUT', '/settings', { defaults: { model: DS_FLASH, effort: 'high', permission: 'manual', planMode: false, subagentModel: OPUS }, subagentEfforts: { [OPUS]: 'high', [DS_PRO]: 'low', [SUB]: 'low', [SONNET]: 'turbo' } });
  assert.equal(saved.defaults.model, DS_FLASH, 'a DeepSeek model as the default for new conversations');
  assert.equal(saved.defaults.subagentModel, OPUS);
  assert.deepEqual(saved.subagentEfforts, { [OPUS]: 'high', [DS_PRO]: 'low' }, 'Kimi\'s own models and nonsense are dropped');
  assert.deepEqual((await api('GET', '/config')).settings.subagentEfforts, saved.subagentEfforts);
  // Sent to the computers: global, per model.
  await until(async () => machine.poolEfforts[OPUS] === 'high', 10000, 'efforts synced');
  assert.deepEqual(machine.poolEfforts, { [DS_PRO]: 'low', [DS_FLASH]: 'max', [OPUS]: 'high' });
  const cat = await api('GET', `/models?machineId=${MID}`);
  assert.equal(cat.sources[1].models.find((m) => m.id === DS_PRO).subagentEffort, 'low');
  assert.equal(cat.sources[2].models.find((m) => m.id === OPUS).subagentEffort, 'high');
  // Not given again: kept.
  const again = await api('PUT', '/settings', { defaults: { model: DS_FLASH, effort: 'high', permission: 'manual', planMode: false } });
  assert.equal(again.defaults.subagentModel, OPUS);
  assert.deepEqual(again.subagentEfforts, saved.subagentEfforts);
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  assert.equal(st.defaults.model, DS_FLASH);
});

test('the default model of 設定 starts a conversation that gives no model (per conversation, with its subagent model)', async () => {
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-default', prompt: '用預設' });
  assert.equal(s.family, 'deepseek');
  assert.deepEqual(s.subagent, { model: OPUS });
  assert.deepEqual(lastProfile(machine, s), { model: DS_FLASH, thinking: 'max' });
  const p = await until(async () => promptsOf(machine, s)[0], 5000, 'prompt');
  assert.match(noteOf(p), new RegExp(`model: "${OPUS}"`));
  // Back to ordinary defaults for the tests below.
  await api('PUT', '/settings', { defaults: { model: '', effort: 'high', permission: 'manual', planMode: false, subagentModel: 'primary' }, subagentEfforts: {} });
  await until(async () => !('agent-hub-claude/claude-opus-5-5' in machine.poolEfforts), 10000, 'efforts back');
  // The default of a Kimi conversation is Kimi's own (the global default is never moved).
  assert.ok(!machine.requests.some((r) => /set_default|:set_default/.test(r.path)), 'Kimi\'s global default model was never set');
  assert.ok(!machine.requests.some((r) => r.method !== 'GET' && /^\/api\/v1\/(config|providers)/.test(r.path)), 'the hub never writes Kimi\'s config itself');
});

test('a Kimi conversation: Kimi\'s model, the pool\'s note on the first prompt only', async () => {
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-kimi', prompt: '你好', model: K3, effort: 'high' });
  assert.equal(s.family, 'kimi');
  assert.equal(s.agentId, `kimi@${MID}`);
  assert.deepEqual(s.subagent, { model: 'primary' });
  assert.equal(s.mode, null);
  assert.equal(lastProfile(machine, s).model, K3);
  const first = await until(async () => promptsOf(machine, s)[0], 5000, 'first prompt');
  assert.equal(first.text, '你好');
  assert.match(noteOf(first), /pass model: "primary" \(the same model as you\) unless the user explicitly asks for another model/);
  assert.match(noteOf(first), /without `model` runs on this computer's default model/);
  assert.equal(first.body.model, undefined);
  // Said once.
  const second = await say(machine, s, '第二句');
  assert.equal(noteOf(second), null);
  assert.equal(noteOf(await say(machine, s, '第三句')), null);
  // `agent: 'kimi'` is the same kind of conversation.
  const k2 = await api('POST', '/sessions', { agent: 'kimi', machineId: MID, cwd: '/tmp/project-kimi2', model: SUB });
  assert.equal(k2.family, 'kimi');
  assert.equal(lastProfile(machine, k2).model, SUB);
});

test('a DeepSeek main model just works (providers first); its thinking is the model\'s own; the model of subagents is its own setting', async () => {
  const before = machine.provisioned.length;
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-ds', prompt: '用 DeepSeek', model: DS_PRO, subagent: { model: SONNET } });
  assert.equal(s.family, 'deepseek');
  assert.equal(s.mode, 'deepseek', 'kept for pages that still read it');
  assert.deepEqual(s.subagent, { model: SONNET });
  assert.equal(machine.provisioned.length, before, 'the providers were there already');
  assert.deepEqual(lastProfile(machine, s), { model: DS_PRO, thinking: 'max' });
  const profs = machine.profiles.filter((x) => x.sid === s.kimiSessionId);
  assert.ok(profs.every((x) => !x.agent_config.model || x.agent_config.model.startsWith('agent-hub-deepseek/')), 'never a Kimi model, not even for a moment');
  const first = await until(async () => promptsOf(machine, s)[0], 5000, 'prompt');
  assert.equal(first.body.model, undefined, 'it has its model; no default is slipped in');
  assert.match(noteOf(first), new RegExp(`pass model: "${SONNET}" unless`));
  const snap = await session(s.id);
  assert.equal(snap.meta.model, DS_PRO);
  assert.equal(snap.meta.models.find((m) => m.id === DS_PRO).family, 'deepseek');
  assert.equal(snap.meta.models.find((m) => m.id === K3).family, 'kimi');

  // Thinking asked for that the model lacks becomes its own; a chosen one is kept.
  const low = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/ds2', model: DS_FLASH, effort: 'low', permission: 'yolo' });
  assert.deepEqual(lastProfile(machine, low), { model: DS_FLASH, thinking: 'low', permission_mode: 'yolo' });
  const odd = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/ds3', model: DS_FLASH, effort: 'xhigh' });
  assert.equal(lastProfile(machine, odd).thinking, 'max');

  // The old way in, with the gateway's own model id.
  const legacy = await api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: '/tmp/ds4', model: 'deepseek-v4-pro' });
  assert.equal(legacy.family, 'deepseek');
  assert.equal(lastProfile(machine, legacy).model, DS_PRO);
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', machineId: MID, model: 'gpt-5' }), (e) => e.status === 400 && /沒有 gpt-5/.test(e.message));
  await assert.rejects(api('POST', '/sessions', { machineId: MID, model: 'agent-hub-deepseek/gpt-5' }), (e) => e.status === 400 && /沒有 gpt-5/.test(e.message));
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', prompt: 'x' }), (e) => e.status === 400);
});

test('a Claude main model works the same: a Kimi provider of type anthropic, billed to the Claude API key', async () => {
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-claude', prompt: '用 Claude', model: OPUS, effort: 'xhigh' });
  assert.equal(s.family, 'claude');
  assert.equal(s.agentId, `kimi@${MID}`, 'a Kimi conversation, not the Claude daemon\'s');
  assert.equal(s.mode, null);
  assert.deepEqual(lastProfile(machine, s), { model: OPUS, thinking: 'xhigh' });
  const profs = machine.profiles.filter((x) => x.sid === s.kimiSessionId);
  assert.ok(profs.every((x) => !x.agent_config.model || x.agent_config.model === OPUS), 'never a Kimi model');
  const first = await until(async () => promptsOf(machine, s)[0], 5000, 'prompt');
  assert.match(noteOf(first), /pass model: "primary"/);
  // Without thinking: the model's own default.
  const plain = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/claude2', model: SONNET });
  assert.equal(lastProfile(machine, plain).thinking, 'high');
  // A model the key does not have.
  await assert.rejects(api('POST', '/sessions', { machineId: MID, model: 'agent-hub-claude/claude-nope-9' }), (e) => e.status === 400 && /claude-nope-9/.test(e.message));
  // The Claude daemon's own way in is as before.
  assert.equal((await api('GET', '/sessions')).find((x) => x.id === s.id).family, 'claude');
});

test('subagent model: said again when it changes, and when the main model changes; a model the pool lacks is never named', async () => {
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-sub', prompt: 'one', model: K3, effort: 'off' });
  const first = await until(async () => promptsOf(machine, s)[0], 5000, 'prompt');
  assert.match(noteOf(first), /model: "primary"/);
  assert.equal(noteOf(await say(machine, s, 'two')), null, 'nothing changed');

  // The conversation's subagents move to a DeepSeek model: the next message says so, once; and where it is billed.
  const posted = machine.profiles.length;
  await api('POST', `/sessions/${s.id}/config`, { subagent: { model: DS_FLASH } });
  assert.deepEqual((await session(s.id)).subagent, { model: DS_FLASH });
  assert.ok((await infos(s.id)).some((t) => /子代理改用 DeepSeek V4.1 Flash（下一則訊息起生效；算在 OpenCode Go 的 API key）/.test(t)));
  assert.equal(machine.profiles.length, posted, 'a subagent setting is not a Kimi setting: nothing was posted to Kimi');
  const third = await say(machine, s, 'three');
  assert.match(noteOf(third), new RegExp(`pass model: "${DS_FLASH}" unless`));
  assert.equal(noteOf(await say(machine, s, 'four')), null);

  // The main model moves to another source: the line about billing, the thinking it cannot keep, and the note again.
  const infoCount = (await infos(s.id)).length;
  await api('POST', `/sessions/${s.id}/config`, { model: DS_PRO });
  assert.deepEqual(lastProfile(machine, s), { model: DS_PRO, thinking: 'max' }, '"off" does not exist on DeepSeek: its own default');
  let lines = await infos(s.id);
  assert.equal(lines.length, infoCount + 1);
  assert.equal(lines.at(-1), '改用 DeepSeek V4 Pro：之後的回合算在 OpenCode Go 的 API key，不用 Kimi 訂閱');
  assert.equal((await session(s.id)).family, 'deepseek');
  const five = await say(machine, s, 'five');
  assert.match(noteOf(five), new RegExp(`pass model: "${DS_FLASH}" unless`), 'the main model changed: said again');
  assert.equal(noteOf(await say(machine, s, 'six')), null);

  // Within the same source: no billing line (but the note is said again).
  await api('POST', `/sessions/${s.id}/config`, { model: DS_FLASH });
  assert.equal((await infos(s.id)).length, lines.length, 'DeepSeek to DeepSeek: the same bill');
  assert.match(noteOf(await say(machine, s, 'seven')), /model: "agent-hub-deepseek\/deepseek-v4.1-flash"/);
  // To Claude, then to Kimi.
  await api('POST', `/sessions/${s.id}/config`, { model: OPUS });
  assert.match((await infos(s.id)).at(-1), /^改用 Claude Opus 5.5：之後的回合算在 Claude Console 的 API key（按量計費），不用 Kimi 訂閱$/);
  await api('POST', `/sessions/${s.id}/config`, { model: K3 });
  assert.equal((await infos(s.id)).at(-1), '改用 K3-256k：之後的回合算在 Kimi 訂閱');
  assert.equal((await session(s.id)).family, 'kimi');

  // A subagent model the computer's Kimi does not have: not named; the conversation says so; the main model's own is used.
  await api('POST', `/sessions/${s.id}/config`, { subagent: { model: 'agent-hub-deepseek/gone' } });
  const eight = await say(machine, s, 'eight');
  assert.ok(!eight.parts.join('').includes('agent-hub-deepseek/gone'), 'never named');
  assert.match(noteOf(eight), /model: "primary"/);
  assert.ok((await infos(s.id)).includes('子代理模型 gone 還沒在這台電腦的 Kimi 設定好，子代理先跟主模型一樣'));
  const n = (await infos(s.id)).length;
  assert.equal(noteOf(await say(machine, s, 'nine')), null);
  assert.equal((await infos(s.id)).length, n, 'said once');
  // Garbage is refused; "primary" is back.
  await assert.rejects(api('POST', `/sessions/${s.id}/config`, { subagent: { model: '' } }), (e) => e.status === 400);
  await api('POST', `/sessions/${s.id}/config`, { subagent: 'primary' });
  assert.equal((await session(s.id)).subagent.model, 'primary');
  // A model of a source without a key is refused.
  await api('POST', `/sessions/${s.id}/config`, { subagent: { model: DS_FLASH } });
});

test('the user\'s Kimi locks the pool (force): the conversation says so and names no subagent model', async () => {
  machine.force = true;
  // Any change of efforts goes to the pool, and the bridge leaves it alone.
  await api('PUT', '/settings', { defaults: { model: '', effort: 'high', permission: 'manual', planMode: false }, subagentEfforts: { [DS_PRO]: 'high' } });
  await until(async () => (await api('GET', `/models?machineId=${MID}`)).subagents.available === false, 10000, 'forced');
  const cat = await api('GET', `/models?machineId=${MID}`);
  assert.match(cat.subagents.reason, /鎖定了子代理模型（force），中控台沒有改它/);
  assert.equal(cat.subagentEffortScope, 'none');
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-force', prompt: 'x', model: K3, subagent: { model: DS_FLASH } });
  const p = await until(async () => promptsOf(machine, s)[0], 5000, 'prompt');
  assert.equal(noteOf(p), null);
  assert.ok((await infos(s.id)).some((t) => /鎖定了子代理模型（force）/.test(t)));
  machine.force = false;
  await api('PUT', '/settings', { defaults: { model: '', effort: 'high', permission: 'manual', planMode: false }, subagentEfforts: {} });
  await until(async () => (await api('GET', `/models?machineId=${MID}`)).subagents.available === true, 10000, 'pool back');
});

test('an old bridge: DeepSeek works as before without a pool; Claude and subagent models say to run the 連接器 again', async () => {
  old = fakeMachine(hub.key, { id: OLD_MID, version: '0.8.0' });
  await old.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === OLD_MID && m.online), 10000, 'machine online');
  // Its hello gave it the DeepSeek provider, with the op it knows; no pool, no Claude.
  await until(async () => old.provisioned.length === 1, 10000, 'DeepSeek provisioned');
  assert.deepEqual(Object.keys(old.provisioned[0]).sort(), ['apiKey', 'gateway', 'models']);
  assert.deepEqual(old.log, ['provision:deepseek']);
  const cat = await api('GET', `/models?machineId=${OLD_MID}`);
  const [, ds, cl] = cat.sources;
  assert.equal(ds.ready, true);
  assert.equal(cl.ready, false);
  assert.match(cl.note, /連接器太舊.*連接指令/);
  assert.equal(cat.subagentEffortScope, 'none');
  assert.equal(cat.subagents.available, false);
  assert.match(cat.subagents.reason, /連接器太舊/);

  const s = await api('POST', '/sessions', { machineId: OLD_MID, cwd: '/tmp/old-ds', prompt: 'hi', model: DS_PRO, subagent: { model: DS_FLASH } });
  assert.equal(s.family, 'deepseek');
  assert.deepEqual(lastProfile(old, s), { model: DS_PRO, thinking: 'max' });
  const p = await until(async () => promptsOf(old, s)[0], 5000, 'prompt');
  assert.equal(noteOf(p), null, 'no pool, no note');
  assert.ok((await infos(s.id)).some((t) => /連接器太舊/.test(t) && /子代理模型/.test(t)), 'the subagent model asked for cannot be had');
  assert.ok(!old.log.includes('sync'));
  await assert.rejects(api('POST', '/sessions', { machineId: OLD_MID, cwd: '/tmp/old-cl', model: OPUS }), (e) => e.status === 409 && /連接器太舊/.test(e.message) && /Claude/.test(e.message));
  // A Kimi conversation there is as it was: no note.
  const plain = await api('POST', '/sessions', { machineId: OLD_MID, cwd: '/tmp/old-kimi', prompt: 'hi', model: K3 });
  assert.equal(noteOf(await until(async () => promptsOf(old, plain)[0], 5000, 'prompt')), null);
  assert.equal(plain.family, 'kimi');
});

test('auto-pause and 「額度恢復後送出」 only while the model is Kimi\'s (they watch the Kimi subscription)', async () => {
  const s = await api('POST', '/sessions', { machineId: MID, cwd: '/tmp/project-ap', model: K3 });
  const on = await api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 80 });
  assert.equal(on.autoPause.enabled, true);
  // On a DeepSeek or Claude model: refused, and why.
  await api('POST', `/sessions/${s.id}/config`, { model: DS_PRO });
  for (const body of [{ enabled: true, threshold: 80 }, { resumeAfterReset: true, text: '繼續' }]) {
    await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, body), (e) => e.status === 400 && /不用 Kimi 訂閱/.test(e.message) && /DeepSeek/.test(e.message) && /OpenCode Go/.test(e.message), JSON.stringify(body));
  }
  await api('POST', `/sessions/${s.id}/config`, { model: OPUS });
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { enabled: true }), (e) => e.status === 400 && /Claude/.test(e.message) && /不用 Kimi 訂閱/.test(e.message));
  // Turning it off is allowed (it came on while the model was Kimi's).
  assert.equal((await api('POST', `/sessions/${s.id}/autopause`, { enabled: false })).autoPause.enabled, false);
  // Back on Kimi's model: it works again.
  await api('POST', `/sessions/${s.id}/config`, { model: SUB });
  assert.equal((await api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 70 })).autoPause.threshold, 70);
  await api('POST', `/sessions/${s.id}/autopause`, { enabled: false });
});

test('a defaults change never moves a DeepSeek or Claude conversation onto a Kimi model, nor a Kimi one onto an API-key model', async () => {
  await api('PUT', '/settings', { defaults: { model: K3, effort: 'high', permission: 'manual', planMode: false } });
  machine.add('session_plain', { title: 'plain Kimi', model: SUB, thinking: 'high' });
  machine.add('session_wander', { title: 'on DeepSeek', model: DS_PRO, thinking: 'max' });
  const before = machine.profiles.length;
  const plain = await api('POST', `/machines/${MID}/kimi/session_plain/attach`);
  const wander = await api('POST', `/machines/${MID}/kimi/session_wander/attach`);
  assert.equal(plain.family, 'kimi');
  assert.equal(wander.family, 'deepseek', 'by its model');
  const posted = machine.profiles.slice(before);
  assert.ok(posted.some((x) => x.sid === 'session_plain' && x.agent_config.model === K3), 'a Kimi conversation gets the Kimi default model');
  assert.ok(!posted.some((x) => x.sid === 'session_wander' && x.agent_config.model), 'a DeepSeek conversation keeps its model');
  // A default of DeepSeek is chosen for conversations made from the hub, not put on one made in Kimi.
  await api('PUT', '/settings', { defaults: { model: DS_FLASH, effort: 'high', permission: 'manual', planMode: false } });
  machine.add('session_plain3', { title: 'plain Kimi 3', model: SUB, thinking: 'high' });
  const p3 = await api('POST', `/machines/${MID}/kimi/session_plain3/attach`);
  assert.equal(p3.family, 'kimi');
  assert.ok(!machine.profiles.some((x) => x.sid === 'session_plain3' && x.agent_config.model), 'left on its Kimi model');
  await api('PUT', '/settings', { defaults: { model: '', effort: 'high', permission: 'manual', planMode: false } });
  // And the K3-256k migration only ever picks a Kimi model.
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  assert.ok(!st.defaults.model || !/agent-hub-/.test(st.defaults.model));
});

test('what a subagent really ran on shows on its card: model, thinking and where it is billed; "same as the main model" is marked', async () => {
  const s = (await api('GET', '/sessions')).find((x) => x.cwd === '/tmp/project-ds' && x.family === 'deepseek');
  const sid = s.kimiSessionId;
  const k = machine;
  k.frame(sid, 'turn.started', { turnId: 'tx', promptId: 'p_x', origin: { kind: 'user' }, prompt: '派子代理' });
  for (const [call, id, p] of [
    ['call_a', 'agent-a', { model: OPUS, thinkingEffort: 'xhigh' }],
    ['call_b', 'agent-b', { model: DS_PRO, thinkingEffort: 'max' }],
    ['call_c', 'agent-c', { model: K3 }],
  ]) {
    k.frame(sid, 'tool.call.started', { toolCallId: call, name: 'Agent', args: { description: id, prompt: 'x' } });
    k.frame(sid, 'subagent.spawned', { subagentId: id, subagentName: 'coder', parentToolCallId: call, parentAgentId: 'main', callerAgentId: 'main', description: id, runInBackground: false, taskId: `task_${id}`, ...p });
  }
  const cards = await until(async () => {
    const ev = (await session(s.id)).events.filter((e) => e.name === 'Agent' && e.subagent?.model);
    return ev.length === 3 && ev;
  }, 5000, 'subagent cards');
  const by = Object.fromEntries(cards.map((c) => [c.subagent.id, c.subagent]));
  assert.deepEqual([by['agent-a'].model, by['agent-a'].effort, by['agent-a'].family, by['agent-a'].onMain], [OPUS, 'xhigh', 'claude', false]);
  assert.deepEqual([by['agent-b'].model, by['agent-b'].effort, by['agent-b'].family, by['agent-b'].onMain], [DS_PRO, 'max', 'deepseek', true], 'the main model is DeepSeek V4 Pro: the same one');
  assert.deepEqual([by['agent-c'].model, by['agent-c'].family, by['agent-c'].effort], [K3, 'kimi', undefined]);
  // Later news of the same subagent's thinking.
  k.frame(sid, 'agent.status.updated', { agentId: 'agent-c', model: K3, thinkingEffort: 'high' });
  await until(async () => (await session(s.id)).events.find((e) => e.subagent?.id === 'agent-c')?.subagent.effort === 'high', 5000, 'effort updated');
  k.frame(sid, 'turn.ended', { turnId: 'tx', reason: 'completed' });
});

test('conversations from before the modes were merged open and work as they did', async () => {
  const list = await api('GET', '/sessions');
  const ds = list.find((x) => x.id === 's_oldds');
  assert.deepEqual([ds.family, ds.mode, ds.subagent, ds.agentId], ['deepseek', 'deepseek', { model: 'primary' }, `kimi@${MID}`]);
  const cl = list.find((x) => x.id === 's_oldclaude');
  assert.deepEqual([cl.family, cl.subagent, cl.agentId], ['claude', null, 'claude']);

  // Opened: caught up from Kimi, the model kept (the Kimi defaults do not move it).
  machine.add('session_oldds', { title: '舊的 DeepSeek 對話', model: DS_PRO, thinking: 'max', cwd: '/tmp/old-ds' });
  await api('PUT', '/settings', { defaults: { model: K3, effort: 'high', permission: 'manual', planMode: false } });
  const snap = await session('s_oldds');
  assert.equal(snap.meta.model, DS_PRO);
  assert.ok(snap.events.some((e) => e.text === '以前的問題'));
  await until(async () => (await session('s_oldds')).meta.models?.some((m) => m.id === K3), 5000, 'models loaded');
  await sleep(300);
  assert.ok(!machine.profiles.some((x) => x.sid === 'session_oldds' && x.agent_config.model), 'still on DeepSeek');
  await api('PUT', '/settings', { defaults: { model: '', effort: 'high', permission: 'manual', planMode: false } });
  // A message goes with its model, and the note for the pool the computer has now.
  const p = await say(machine, { kimiSessionId: 'session_oldds', id: 's_oldds' }, '接著問');
  assert.equal(p.body.model, undefined);
  assert.match(noteOf(p), /model: "primary"/);
  assert.equal(noteOf(await say(machine, { kimiSessionId: 'session_oldds', id: 's_oldds' }, '再問')), null);
  // It can still switch to Kimi now (it could not before), saying where the bill goes.
  await api('POST', '/sessions/s_oldds/config', { model: K3 });
  assert.equal((await infos('s_oldds')).at(-1), '改用 K3-256k：之後的回合算在 Kimi 訂閱');
  assert.equal((await session('s_oldds')).family, 'kimi');
  // The Claude daemon's conversation opens (its events are as they were).
  const c = await session('s_oldclaude');
  assert.ok(c.events.some((e) => e.text === '以前的回答'));
  assert.equal(c.family, 'claude');
});

test('removing a key takes its provider off the computers and out of the pool; the model is refused after', async () => {
  const removed = machine.removed.length;
  await api('PUT', '/claude', { clearKey: true });
  await until(async () => machine.removed.some((r) => r.provider === 'claude') && !Object.keys(machine.pool.models).includes(OPUS), 10000, 'Claude removed');
  assert.ok(machine.removed.length > removed);
  assert.deepEqual(machine.log.slice(-2), ['remove:claude', 'sync']);
  assert.deepEqual(Object.keys(machine.pool.models), [SUB, K3, DS_PRO, DS_FLASH]);
  const cat = await api('GET', `/models?machineId=${MID}`);
  assert.deepEqual(cat.sources.map((s) => s.id), ['kimi', 'deepseek']);
  await assert.rejects(api('POST', '/sessions', { machineId: MID, cwd: '/tmp/x', model: OPUS }), (e) => e.status === 409 && /Claude API key/.test(e.message));
  const s = (await api('GET', '/sessions')).find((x) => x.cwd === '/tmp/project-kimi');
  await assert.rejects(api('POST', `/sessions/${s.id}/config`, { model: OPUS }), (e) => e.status === 409 && /Claude API key/.test(e.message));

  await api('PUT', '/deepseek', { clearKey: true });
  await until(async () => machine.removed.some((r) => r.provider === 'deepseek') && Object.keys(machine.pool.models).length === 2, 10000, 'DeepSeek removed');
  assert.deepEqual(machine.log.slice(-2), ['remove:deepseek', 'sync']);
  assert.deepEqual(Object.keys(machine.pool.models), [SUB, K3], 'only Kimi\'s own models are left in the pool');
  await until(async () => old.removed.length === 1, 10000, 'the old bridge\'s provider removed, with its own op');
  await assert.rejects(api('POST', '/sessions', { machineId: MID, cwd: '/tmp/x', model: DS_PRO }), (e) => e.status === 409 && /API key/.test(e.message));
  assert.deepEqual((await api('GET', `/models?machineId=${MID}`)).sources.map((s) => s.id), ['kimi']);
});
