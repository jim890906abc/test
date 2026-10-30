// A DeepSeek conversation whose turn ended on a quota or rate-limit error gets 「繼續」 by
// itself once a key is available that was not (2026-10-30; server/key-recover.js), through a
// REAL Hub: its runner, its Kimi adapter, its key account and the status events between them. Only
// the outside is scripted: a machine that speaks the bridge protocol and plays Kimi (it fails a turn
// the way Kimi reports one: `turn.ended` with reason `failed` and an `error` with a code), and a
// fake gateway that checks keys. Nothing leaves this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-key-recover-e2e-'));
const DATA = path.join(TMP, 'data');
const PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'kr-token';
const MID = 'm_kr';
const SUB = 'managed:kimi-code/kimi-for-coding';
const DS = 'agent-hub-deepseek';
const KEY_A = 'sk-kr-go-aaaa-0123456789';
const KEY_B = 'sk-kr-go-bbbb-0123456789';
const KEY_C = 'sk-kr-go-cccc-0123456789';
const GOOD = [KEY_A, KEY_B, KEY_C];
let hub;
let machine;
let gateway;

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function fakeGateway() {
  return http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    req.resume();
    if (!GOOD.some((k) => req.headers.authorization === `Bearer ${k}`)) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
    if (req.url === '/opencode-go/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    res.statusCode = 404;
    res.end('{}');
  });
}

// A computer: speaks the bridge protocol, plays Kimi. A prompt it is sent is recorded and answered
// by `k.mode`: 'ok' (a finished turn), 'hold' (nothing: the test decides), or a { code, message } error.
function fakeMachine(key) {
  const k = { sessions: new Map(), prompts: [], mode: 'hold', dsModels: [], n: 0 };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const infoOf = (sid) => {
    const s = k.sessions.get(sid);
    return { id: sid, title: s.title, metadata: { cwd: s.cwd }, busy: Boolean(s.busy), pending_interaction: 'none', last_turn_reason: s.last || 'completed', owner: null, controllable: null, guess: false, model: s.model, effort: s.thinking };
  };
  const entry = (sid) => ({ ...infoOf(sid), updated_at: new Date().toISOString() });
  const modelItems = () => [
    { model: SUB, display_name: 'kimi-for-coding', max_context_size: 262144, capabilities: ['thinking', 'image_in', 'tool_use'] },
    ...k.dsModels.map((alias) => ({ model: alias, display_name: alias.split('/').pop(), max_context_size: 1_000_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] })),
  ];
  k.add = (sid, over = {}) => {
    k.sessions.set(sid, { cwd: '/tmp/kr', model: '', thinking: '', title: sid, ...over });
    send({ t: 'kimi.session.update', item: entry(sid) });
  };
  const frame = (sid, type, payload = {}) => send({ t: 'kimi.event', frame: { type, session_id: sid, payload: { agentId: 'main', ...payload } } });
  // One turn as Kimi reports it: started, a bit of text, then it ends well or with an error.
  k.turn = (sid, promptId, text, error = null) => {
    const turnId = `turn_${++k.n}`;
    const s = k.sessions.get(sid);
    s.busy = true;
    frame(sid, 'turn.started', { turnId, promptId, origin: { kind: 'user' }, prompt: text });
    setTimeout(() => {
      if (error) {
        s.busy = false;
        s.last = 'failed';
        frame(sid, 'turn.ended', { reason: 'failed', error: { code: error.code, message: error.message } });
        frame(sid, 'event.session.work_changed', { busy: false, last_turn_reason: 'failed', pending_interaction: 'none' });
      } else {
        frame(sid, 'assistant.delta', { turnId, delta: `Kimi 收到：${text}` });
        s.busy = false;
        s.last = 'completed';
        frame(sid, 'turn.ended', { reason: 'completed' });
        frame(sid, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
      }
    }, 60);
  };
  k.report = (msg) => send({ t: 'deepseek.pool', ...msg });
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
      const c = body.agent_config || {};
      const s = k.sessions.get(m[1]);
      if (c.model) s.model = c.model;
      if (c.thinking) s.thinking = c.thinking;
      return ok({ id: m[1] });
    }
    if (m && method === 'POST' && m[2] === '/prompts') {
      const text = (body.content || []).filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');
      k.prompts.push({ sid: m[1], text, promptId: body.prompt_id });
      const mode = k.mode;
      if (mode === 'ok') setTimeout(() => k.turn(m[1], body.prompt_id, text), 20);
      else if (mode !== 'hold') setTimeout(() => k.turn(m[1], body.prompt_id, text, mode), 20);
      return ok({ prompt_id: body.prompt_id, status: 'started' });
    }
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'fake-machine', platform: 'test', bridgeVersion: '0.12.0', home: '/home/fake', pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky', 'pool_reset_due', 'pool_rate'], status });
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
        k.dsModels = a.models.map((x) => `${DS}/${x.model}`);
        out = { ok: true, created: true, models: k.dsModels, sessionHeader: true };
        break;
      case 'kimi.deepseek.remove':
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
  await api('PUT', '/deepseek', { apiKey: KEY_A });
  await api('PUT', '/deepseek', { apiKey: KEY_B });
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID)?.provision?.ok, 10000, 'provisioned');
});

after(() => {
  machine?.close();
  hub?.kill('SIGTERM');
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const keys = async () => (await api('GET', '/deepseek')).rotation.keys;
const idOf = async (hint) => (await keys()).find((k) => k.hint === hint.slice(-4)).id;
// A new DeepSeek conversation whose first turn failed with `error` (the machine reports it the way Kimi does).
async function failedConversation(error) {
  machine.mode = error;
  const before = machine.prompts.length;
  const s = await api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: '/tmp/kr', prompt: '開始做事' });
  await until(async () => (await api('GET', `/sessions/${s.id}`)).status === 'error', 8000, 'the turn failed');
  assert.equal(machine.prompts.length, before + 1);
  machine.mode = 'hold';
  return s;
}
const prompts = (s) => machine.prompts.filter((p) => p.sid === s.kimiSessionId);
const infos = async (s) => (await api('GET', `/sessions/${s.id}`)).events.filter((e) => e.type === 'info' && /自動繼續/.test(e.text));
// Both keys of the pool are in use; B is then out of quota until a time its gateway stated.
async function outUntil(ms) {
  const id = await idOf(KEY_B);
  const acc = await api('GET', '/deepseek');
  const at = Date.now() + ms;
  machine.report({ gateway: 'opencode-go', rotation: 1, activeId: await idOf(KEY_A), revision: acc.rotation.revision, keys: [{ id, exhaustedAt: Date.now(), retryAt: at }] });
  await until(async () => (await keys()).find((k) => k.id === id)?.state === 'exhausted', 5000, 'B out');
  return { id, at };
}

test('a turn that ended on a rate limit is continued by itself when a key\'s stated reset time passes - once, with a note in the conversation', async () => {
  const { id } = await outUntil(2500);
  const s = await failedConversation({ code: 'provider.rate_limit', message: 'The provider is busy, try again later' });
  await sleep(600);
  assert.equal(prompts(s).length, 1, 'while the keys are as they were, nothing is sent');
  // B's reset time passes: the Hub sees a key that was not available, and says 「繼續」.
  machine.mode = 'ok';
  await until(() => prompts(s).length === 2, 8000, '「繼續」');
  assert.equal(prompts(s)[1].text, '繼續');
  assert.equal((await keys()).find((k) => k.id === id).state, 'reset_due', 'it was the key whose time passed');
  await until(async () => (await infos(s)).length === 1, 5000, 'the note');
  assert.equal((await infos(s))[0].text, '已在 key 恢復後自動繼續');
  // The turn it started went through: the conversation is fine again, and nothing more is sent.
  await until(async () => (await api('GET', `/sessions/${s.id}`)).status === 'idle', 5000, 'idle');
  await sleep(500);
  assert.equal(prompts(s).length, 2);
});

test('a quota error: continued when a key is ADDED; and not before', async () => {
  machine.mode = 'hold';
  const s = await failedConversation({ code: 'provider.api_error', message: 'Error code: 402 - {"error":{"code":"insufficient_quota","message":"DeepSeek 的 API key 都已用盡（共 2 把）"}}' });
  await sleep(500);
  assert.equal(prompts(s).length, 1);
  machine.mode = 'ok';
  await api('PUT', '/deepseek', { apiKey: KEY_C });
  await until(() => prompts(s).length === 2, 8000, '「繼續」 after the key was added');
  await sleep(500);
  assert.deepEqual(prompts(s).map((p) => p.text), ['開始做事', '繼續']);
});

test('another kind of error (auth, overloaded) is left to a person', async () => {
  machine.mode = 'hold';
  const s = await failedConversation({ code: 'provider.auth_error', message: '401 Unauthorized' });
  const t = await failedConversation({ code: 'provider.overloaded', message: 'The provider is overloaded' });
  machine.mode = 'ok';
  // A key that was not there when they failed.
  await api('PUT', '/deepseek', { removeKeyId: await idOf(KEY_C) });
  await api('PUT', '/deepseek', { apiKey: KEY_C });
  await sleep(800);
  assert.equal(prompts(s).length, 1);
  assert.equal(prompts(t).length, 1);
});

test('the setting: off, nothing is typed; on again within the two hours, it is', async () => {
  machine.mode = 'hold';
  const { id } = await outUntil(60_000);
  assert.equal((await api('PUT', '/deepseek', { autoResume: false })).autoResume, false);
  const s = await failedConversation({ code: 'provider.rate_limit', message: '429' });
  machine.mode = 'ok';
  // A key comes back (a person clears the mark): with the setting off, nothing is typed.
  await api('PUT', '/deepseek', { clearMarkKeyId: id });
  await sleep(800);
  assert.equal(prompts(s).length, 1);
  await api('PUT', '/deepseek', { autoResume: true });
  await until(() => prompts(s).length === 2, 8000, '「繼續」 after the setting was turned on');
});

test('a person who writes to the conversation first takes it over: no 「繼續」 over their message', async () => {
  machine.mode = 'hold';
  const { id } = await outUntil(60_000);
  const s = await failedConversation({ code: 'provider.rate_limit', message: '429' });
  await api('POST', `/sessions/${s.id}/messages`, { text: '我自己來' });
  await until(() => prompts(s).length === 2, 5000, 'their message');
  assert.equal(prompts(s)[1].text, '我自己來');
  machine.mode = 'ok';
  await api('PUT', '/deepseek', { clearMarkKeyId: id });
  await sleep(800);
  assert.equal(prompts(s).length, 2, 'nothing of ours');
});

test('no loop: the turn 「繼續」 started fails again -> it is not sent a second time', async () => {
  machine.mode = 'hold';
  const { id } = await outUntil(60_000);
  const s = await failedConversation({ code: 'provider.rate_limit', message: '429' });
  machine.mode = { code: 'provider.rate_limit', message: '429 again' };
  await api('PUT', '/deepseek', { clearMarkKeyId: id });
  await until(() => prompts(s).length === 2, 8000, '「繼續」');
  await until(async () => (await api('GET', `/sessions/${s.id}`)).status === 'error', 5000, 'it failed again');
  // Another key comes (and goes away again, and another): still nothing more.
  machine.mode = 'ok';
  await api('PUT', '/deepseek', { removeKeyId: await idOf(KEY_C) });
  await api('PUT', '/deepseek', { apiKey: KEY_C });
  await sleep(1000);
  assert.equal(prompts(s).length, 2);
});

test('a cooldown that ends (the connector says so in its pool report) is a key that is available again: the stuck turn is continued', async () => {
  machine.mode = 'hold';
  const a = await idOf(KEY_A);
  const acc = await api('GET', '/deepseek');
  const report = (keys) => machine.report({ gateway: 'opencode-go', rotation: 1, activeId: a, revision: acc.rotation.revision, keys });
  // Key A has been answering 429 for a while: the connector cools it down.
  report([{ id: a, rateCooldown: { until: Date.now() + 60_000, n429: 5, windowMs: 30_000, level: 0 } }]);
  await until(async () => (await keys()).find((k) => k.id === a)?.rateCooldown, 5000, 'A cooling');
  const s = await failedConversation({ code: 'provider.rate_limit', message: 'The provider is busy, try again later' });
  await sleep(500);
  assert.equal(prompts(s).length, 1, 'nothing new while A still cools');
  machine.mode = 'ok';
  // The cooldown is over: the next report no longer carries it.
  report([{ id: a }]);
  await until(() => prompts(s).length === 2, 8000, '「繼續」 after the cooldown ended');
  assert.equal(prompts(s)[1].text, '繼續');
});
