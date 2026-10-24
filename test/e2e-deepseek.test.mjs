// DeepSeek on a computer whose connector is the old one (0.8.0, which only has
// the DeepSeek op) and through the old way in ({ agent: 'deepseek' }): the real
// hub, a fake gateway (the DeepSeek models list and key check), and a scripted
// machine that speaks the bridge protocol and plays Kimi (conversations, their
// model and thinking, the DeepSeek provider the bridge would make). No Kimi,
// gateway or account needed. test/e2e-models.test.mjs is the same with the new
// connector and every source of models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ds-token';
const MID = 'm_ds';
const SUB = 'managed:kimi-code/kimi-for-coding';
const DS = 'agent-hub-deepseek';
const KEY = 'sk-oc-go-0123456789wxyz';
let hub;
let machine;
let gateway;
let gatewayCalls = [];

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

// ------------------------------------------------------- the fake gateway

// Go lists V4.1 Flash among others' models; it only takes the one key.
function fakeGateway() {
  return http.createServer((req, res) => {
    gatewayCalls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/opencode-go/models') return (res.statusCode = 404), res.end('{}');
    if (req.headers.authorization !== `Bearer ${KEY}`) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    res.end(JSON.stringify({ data: [{ id: 'kimi-k2' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
  });
}

// ------------------------------------------------------- the fake machine

function fakeMachine(key) {
  const k = {
    provisioned: [], // args of every kimi.deepseek.provision
    removed: 0,
    sessions: new Map(), // kimi session id -> { cwd, model, thinking, title }
    profiles: [], // { sid, agent_config }
    prompts: [], // { sid, body }
    archived: [],
    dsModels: [], // aliases the DeepSeek provider has now
    refuseModels: false, // profile refuses the DeepSeek model (the provider is gone)
    n: 0,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const infoOf = (sid) => {
    const s = k.sessions.get(sid);
    return { id: sid, title: s.title, metadata: { cwd: s.cwd }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', owner: null, controllable: null, model: s.model, effort: s.thinking };
  };
  const entry = (sid) => ({ ...infoOf(sid), updated_at: new Date().toISOString() });
  const modelItems = () => [
    { model: SUB, display_name: 'kimi-for-coding', max_context_size: 262144, capabilities: ['thinking', 'image_in', 'tool_use'] },
    ...k.dsModels.map((alias, i) => ({ model: alias, display_name: i === 0 ? 'K3-256k' : alias.split('/').pop(), max_context_size: 1_000_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] })),
  ];
  k.add = (sid, over = {}) => {
    k.sessions.set(sid, { cwd: '/tmp/project', model: '', thinking: '', title: sid, ...over });
    send({ t: 'kimi.session.update', item: entry(sid) });
  };
  const request = (method, p, body) => {
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') return ok({ default_model: SUB });
    if (p === '/api/v1/models') return ok({ items: modelItems() });
    if (method === 'POST' && p === '/api/v1/sessions') {
      const sid = `session_new${++k.n}`;
      k.add(sid, { cwd: body.metadata.cwd });
      return ok({ id: sid, metadata: { cwd: body.metadata.cwd } });
    }
    const m = p.match(/^\/api\/v1\/sessions\/(session_\w+)(.*)$/);
    if (m && /\/skills$/.test(m[2])) return ok({ skills: [] });
    if (m && method === 'POST' && m[2] === '/profile') {
      k.profiles.push({ sid: m[1], agent_config: body.agent_config });
      const c = body.agent_config || {};
      if (c.model && (!modelItems().some((x) => x.model === c.model) || (k.refuseModels && c.model.startsWith(`${DS}/`)))) return { code: 40113, msg: `model ${c.model} does not exist`, data: null };
      const s = k.sessions.get(m[1]);
      if (c.model) s.model = c.model;
      if (c.thinking) s.thinking = c.thinking;
      return ok({ id: m[1] });
    }
    if (m && method === 'POST' && m[2] === '/prompts') {
      k.prompts.push({ sid: m[1], body });
      return ok({ prompt_id: body.prompt_id, status: 'started' });
    }
    if (m && method === 'POST' && m[2] === ':archive') {
      k.archived.push(m[1]);
      return ok({});
    }
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'fake-machine', platform: 'test', bridgeVersion: '0.8.0', home: '/home/fake', status });
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
      case 'kimi.deepseek.provision':
        k.provisioned.push(a);
        k.dsModels = a.models.map((x) => `${DS}/${x.model}`);
        out = { ok: true, created: true, models: k.dsModels, sessionHeader: true };
        break;
      case 'kimi.deepseek.remove':
        k.removed++;
        k.dsModels = [];
        out = { ok: true, removed: true };
        break;
      case 'workspace.create':
        out = { path: '/tmp/agent-hub-workspaces/new' };
        break;
      default:
        out = { ok: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
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
  machine = fakeMachine(key);
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'machine online');
});

after(() => {
  machine?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the gateway key is tested before it is saved, kept private, and tells the models', async () => {
  const none = await api('GET', '/deepseek');
  assert.equal(none.gateway, 'opencode-go', 'a key without a gateway choice goes to OpenCode Go');
  assert.equal(none.hasKey, false);
  // Not accepted by the gateway: not saved, and why.
  await assert.rejects(api('PUT', '/deepseek', { apiKey: 'wrong-key' }), (e) => e.status === 400 && /金鑰無效/.test(e.message));
  assert.equal((await api('GET', '/deepseek')).hasKey, false);
  await assert.rejects(api('PUT', '/deepseek', { apiKey: 'has space' }), (e) => e.status === 400);
  await assert.rejects(api('PUT', '/deepseek', { gateway: 'nope', apiKey: KEY }), (e) => e.status === 400 && /閘道/.test(e.message));

  const acc = await api('PUT', '/deepseek', { apiKey: KEY });
  assert.deepEqual([acc.gateway, acc.hasKey, acc.keyHint], ['opencode-go', true, 'wxyz']);
  assert.ok(gatewayCalls.some((c) => c.auth === `Bearer ${KEY}`));
  // Never sent back, not even in the config a page loads or the stream.
  for (const body of [acc, await api('GET', '/deepseek'), await api('GET', '/config')]) assert.ok(!JSON.stringify(body).includes(KEY));
  assert.deepEqual((await api('GET', '/config')).deepseek.defaults, { model: 'deepseek-v4.1-flash', effort: 'max', permission: 'manual', planMode: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'deepseek.json'), 'utf8')).keys['opencode-go'], KEY);

  const models = await api('GET', '/deepseek/models');
  assert.equal(models.live, true);
  assert.deepEqual(models.models.map((m) => m.id), ['deepseek-v4-pro', 'deepseek-v4.1-flash']);
  assert.equal(models.defaultModel, 'deepseek-v4.1-flash');
  assert.deepEqual(models.models[1].efforts, ['low', 'high', 'max']);
  assert.equal((await api('POST', '/deepseek/test', {})).ok, true);

  // Defaults are checked and kept.
  const d = await api('PUT', '/deepseek', { defaults: { effort: 'high', permission: 'yolo', planMode: true, model: 'deepseek-v4-pro' } });
  assert.deepEqual(d.defaults, { model: 'deepseek-v4-pro', effort: 'high', permission: 'yolo', planMode: true });
  await api('PUT', '/deepseek', { defaults: { effort: 'max', permission: 'manual', planMode: false, model: 'deepseek-v4.1-flash' } });
});

test('a DeepSeek conversation: Kimi gets the provider once, the conversation runs on a DeepSeek model at max, and it is marked as one', async () => {
  const dir = '/tmp/project-ds';
  const s = await api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: dir, prompt: '你好' });
  assert.equal(s.mode, 'deepseek');
  assert.equal(s.family, 'deepseek');
  assert.equal(s.agentId, `kimi@${MID}`, 'an ordinary Kimi conversation on that computer');
  assert.equal(s.cwd, dir);

  // The bridge was asked once, with the gateway's name, the key and the models; no address.
  assert.equal(machine.provisioned.length, 1);
  const p = machine.provisioned[0];
  assert.deepEqual(Object.keys(p).sort(), ['apiKey', 'gateway', 'models']);
  assert.equal(p.gateway, 'opencode-go');
  assert.equal(p.apiKey, KEY);
  assert.deepEqual(p.models.map((m) => m.model), ['deepseek-v4-pro', 'deepseek-v4.1-flash']);
  assert.deepEqual(p.models[1], { model: 'deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash', max_context_size: 1_000_000, max_output_size: 384_000, capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'], support_efforts: ['low', 'high', 'max'] });

  // The model is chosen for this conversation (its own profile), at max.
  const prof = machine.profiles.filter((x) => x.sid === s.kimiSessionId);
  assert.deepEqual(prof.at(-1).agent_config, { model: `${DS}/deepseek-v4.1-flash`, thinking: 'max', permission_mode: 'manual' });
  assert.ok(prof.every((x) => !x.agent_config.model || x.agent_config.model.startsWith(`${DS}/`)), 'never a Kimi model');
  const sent = await until(async () => machine.prompts.find((x) => x.sid === s.kimiSessionId), 5000, 'prompt');
  assert.equal(sent.body.model, undefined, 'the conversation has its model; no default is slipped in');

  // Marked in the summaries (by its model; `mode` is only kept for pages that
  // still read it) and, until Kimi reports one, on disk by the model it was made for.
  const list = await api('GET', '/sessions');
  assert.equal(list.find((x) => x.id === s.id).family, 'deepseek');
  assert.equal(list.find((x) => x.id === s.id).mode, 'deepseek');
  assert.equal(await until(async () => JSON.parse(fs.readFileSync(path.join(DATA, 'sessions', `${s.id}.json`), 'utf8')).state?.intendedModel, 5000, 'saved'), `${DS}/deepseek-v4.1-flash`);
  const snap = await api('GET', `/sessions/${s.id}`);
  assert.equal(snap.meta.model, `${DS}/deepseek-v4.1-flash`);
  assert.equal(snap.meta.effort, 'max');
  assert.ok(snap.meta.models.find((m) => m.id === `${DS}/deepseek-v4.1-flash`).deepseek, 'the computer\'s model list marks DeepSeek models');
  assert.equal(snap.meta.models.find((m) => m.id === SUB).deepseek, undefined);

  // Another one: provisioned already, so not again.
  const s2 = await api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: dir, prompt: 'again', model: 'deepseek-v4-pro', effort: 'high', permission: 'yolo' });
  assert.equal(machine.provisioned.length, 1, 'cached');
  assert.deepEqual(machine.profiles.filter((x) => x.sid === s2.kimiSessionId).at(-1).agent_config, { model: `${DS}/deepseek-v4-pro`, thinking: 'high', permission_mode: 'yolo' });

  // Not one without a computer, with a model the gateway lacks, or without a key.
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', prompt: 'x' }), (e) => e.status === 400);
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', machineId: MID, model: 'gpt-5' }), (e) => e.status === 400 && /沒有 gpt-5/.test(e.message));
});

test('no auto-pause, and no 「額度恢復後送出」, while the model is a DeepSeek one (they watch the Kimi subscription)', async () => {
  machine.add('session_plain', { title: 'plain Kimi', model: SUB, thinking: 'high' });
  const kimi = await api('POST', `/machines/${MID}/kimi/session_plain/attach`);
  assert.equal(kimi.mode, null);
  const ds = (await api('GET', '/sessions')).find((x) => x.mode === 'deepseek');
  for (const body of [{ enabled: true, threshold: 80 }, { resumeAfterReset: true, text: '繼續' }]) {
    await assert.rejects(api('POST', `/sessions/${ds.id}/autopause`, body), (e) => e.status === 400 && /不用 Kimi 訂閱/.test(e.message), JSON.stringify(body));
  }
  // Turning it off is all that can be done (calling off a waiting 「繼續」 is as for any conversation: nothing waits here).
  assert.equal((await api('POST', `/sessions/${ds.id}/autopause`, { enabled: false })).id, ds.id);
  await assert.rejects(api('POST', `/sessions/${ds.id}/autopause`, { cancelResume: true }), (e) => e.status === 409);
  // A Kimi conversation still can.
  const on = await api('POST', `/sessions/${kimi.id}/autopause`, { enabled: true, threshold: 80 });
  assert.equal(on.autoPause.enabled, true);
  assert.notEqual((await api('GET', '/sessions')).find((x) => x.id === ds.id).autoPause?.enabled, true);
  // 定時送出 with a time works in both.
  const at = Date.now() + 3600_000;
  assert.equal((await api('POST', `/sessions/${ds.id}/schedule`, { text: '繼續', at })).scheduled.length, 1);
});

test('DeepSeek models stay out of Kimi\'s migration and a Kimi conversation\'s defaults, and the Kimi defaults do not move a DeepSeek conversation', async () => {
  // The computer lists a DeepSeek model that looks like K3-256k (the fake names the first so):
  // the settings migration must not take it for Kimi's.
  const models = await api('GET', `/machines/${MID}/models`);
  assert.ok(models.models.some((m) => m.id.startsWith(`${DS}/`) && m.deepseek));
  assert.ok(models.models.find((m) => m.name === 'K3-256k'));
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  assert.ok(!st.defaults?.model, `no model chosen for Kimi's defaults: ${st.defaults?.model}`);
  assert.ok(!(st.migrated || []).includes('model-k3-256k'));
  // A DeepSeek model may be the default for new conversations (chosen per conversation, never Kimi's own default).
  const saved = await api('PUT', '/settings', { defaults: { model: `${DS}/deepseek-v4-pro`, effort: 'max', permission: 'manual' } });
  assert.equal(saved.defaults.model, `${DS}/deepseek-v4-pro`);
  await api('PUT', '/settings', { defaults: { model: SUB, effort: 'high', permission: 'manual' } });

  // Opening conversations applies the Kimi defaults to Kimi ones only.
  const ds = (await api('GET', '/sessions')).find((x) => x.mode === 'deepseek');
  const before = machine.profiles.length;
  await api('POST', `/machines/${MID}/kimi/${ds.kimiSessionId}/attach`);
  machine.add('session_plain2', { title: 'another Kimi', model: 'something/else', thinking: 'low' });
  await api('POST', `/machines/${MID}/kimi/session_plain2/attach`);
  const posted = machine.profiles.slice(before);
  assert.ok(posted.some((x) => x.sid === 'session_plain2' && x.agent_config.model === SUB), 'a Kimi conversation gets the Kimi default model, as before');
  assert.ok(!posted.some((x) => x.sid === ds.kimiSessionId && x.agent_config.model), 'a DeepSeek conversation keeps its model');
  assert.ok(!posted.some((x) => x.sid === ds.kimiSessionId && x.agent_config.model === SUB));
  assert.equal((await api('GET', `/sessions/${ds.id}`)).meta.model.startsWith(`${DS}/`), true);
});

test('a conversation is a DeepSeek one by its model too; the model can move to another source, saying where the bill goes', async () => {
  // Started in Kimi, then on a DeepSeek model (from a terminal, say): the model decides.
  machine.add('session_wander', { title: 'wanders', model: `${DS}/deepseek-v4-pro`, thinking: 'max' });
  const w = await api('POST', `/machines/${MID}/kimi/session_wander/attach`);
  assert.equal(w.mode, 'deepseek');
  assert.equal(w.family, 'deepseek');
  const plain = (await api('GET', '/sessions')).find((x) => x.title === 'plain Kimi');
  assert.equal(plain.mode, null);
  assert.equal(plain.family, 'kimi');

  const ds = (await api('GET', '/sessions')).find((x) => x.mode === 'deepseek' && x.cwd === '/tmp/project-ds');
  const infos = async (id) => (await api('GET', `/sessions/${id}`)).events.filter((e) => e.type === 'info').map((e) => e.text);
  // DeepSeek to Kimi (it could not before): the bill is the subscription's now.
  await api('POST', `/sessions/${ds.id}/config`, { model: SUB });
  assert.equal(machine.profiles.filter((x) => x.sid === ds.kimiSessionId).at(-1).agent_config.model, SUB);
  assert.equal((await api('GET', `/sessions/${ds.id}`)).family, 'kimi');
  assert.equal((await infos(ds.id)).at(-1), '改用 kimi-for-coding：之後的回合算在 Kimi 訂閱');
  // ... and back; Kimi to DeepSeek says whose key pays.
  await api('POST', `/sessions/${ds.id}/config`, { model: `${DS}/deepseek-v4-pro`, effort: 'low' });
  const last = machine.profiles.filter((x) => x.sid === ds.kimiSessionId).at(-1).agent_config;
  assert.deepEqual([last.model, last.thinking], [`${DS}/deepseek-v4-pro`, 'low']);
  assert.equal((await infos(ds.id)).at(-1), '改用 DeepSeek V4 Pro：之後的回合算在 OpenCode Go 的 API key，不用 Kimi 訂閱');
  await api('POST', `/sessions/${plain.id}/config`, { model: `${DS}/deepseek-v4-pro` });
  assert.equal((await api('GET', `/sessions/${plain.id}`)).family, 'deepseek');
  assert.match((await infos(plain.id)).at(-1), /不用 Kimi 訂閱/);
  await api('POST', `/sessions/${plain.id}/config`, { model: SUB, effort: 'max' });
  assert.equal((await api('GET', `/sessions/${plain.id}`)).family, 'kimi');
  // A model of a source without a key is refused.
  await assert.rejects(api('POST', `/sessions/${plain.id}/config`, { model: 'agent-hub-claude/claude-opus-5-5' }), (e) => e.status === 409 && /Claude API key/.test(e.message));
});

test('if Kimi has lost the provider, it is made again once; if the model still fails nothing is left running on Kimi\'s own model', async () => {
  const n = machine.provisioned.length;
  machine.refuseModels = true;
  const before = (await api('GET', '/sessions')).length;
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: '/tmp/never', prompt: 'x' }), /找不到要用的模型/);
  assert.equal(machine.provisioned.length, n + 1, 'asked for the provider again, once');
  assert.equal((await api('GET', '/sessions')).length, before, 'no half-made conversation');
  assert.ok(machine.archived.length >= 1, 'the Kimi conversation was archived');
  assert.ok(!machine.prompts.some((x) => x.body.content?.[0]?.text === 'x'), 'no prompt was ever sent');
  machine.refuseModels = false;
});

test('removing the key takes the provider off the computers', async () => {
  const removed = machine.removed;
  const acc = await api('PUT', '/deepseek', { clearKey: true });
  assert.equal(acc.hasKey, false);
  await until(async () => machine.removed > removed, 5000, 'provider removed');
  await assert.rejects(api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: '/tmp/x', prompt: 'x' }), (e) => e.status === 409 && /API key/.test(e.message));
});
