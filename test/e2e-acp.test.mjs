// End-to-end: real hub server + real WebSocket + an ACP agent process.
// Verifies that what the agent streams reaches the browser unchanged, in
// order and with low latency, and that permissions, cancel, modes, resume
// after a server restart and the not-logged-in path all work.
//
//   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MOCK = path.join(ROOT, 'test/fixtures/mock-acp-agent.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = /⟦t=(\d+)⟧/g;

let server;
let ws;
const inbox = [];

async function startServer() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (data) => inbox.push({ at: Date.now(), msg: JSON.parse(data) }));
  await new Promise((r) => ws.once('open', r));
}

async function stopServer() {
  ws?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
}

async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${data.error}`);
  return data;
}

async function until(fn, ms = 15000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const session = (sid) => api('GET', `/sessions/${sid}`);
const status = async (sid, st) => (await session(sid)).status === st;
const strip = (s) => (s || '').replace(MARK, '');

async function approveNext(sid, optionId) {
  const ev = await until(async () => {
    const s = await session(sid);
    return s.status === 'awaiting_permission' && s.events.find((e) => e.permission && !e.permission.chosen);
  }, 15000, 'permission request');
  await api('POST', `/sessions/${sid}/permissions/${ev.id}`, { optionId });
  return ev;
}

let agentId;

before(async () => {
  await startServer();
  const a = await api('POST', '/agents', { type: 'acp', name: 'Mock ACP', command: process.execPath, args: `"${MOCK}"`, env: { MOCK_LATENCY: '1' } });
  agentId = a.id;
  assert.equal(a.available, true);
});

after(async () => {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let sid;

test('connection test reports agent info', async () => {
  const r = await api('POST', `/agents/${agentId}/test`);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Mock ACP Agent 1\.0\.0/);
});

test('a turn streams to the browser unchanged, in order, with low latency', async () => {
  const startIdx = inbox.length;
  const s = await api('POST', '/sessions', { agentId, prompt: 'hello world', permissionMode: 'ask' });
  sid = s.id;
  const permEv = await approveNext(sid, 'approve');
  assert.equal(permEv.title, 'Shell: echo hello');
  assert.deepEqual(permEv.permission.options.map((o) => o.name), ['Approve once', 'Approve for this session', 'Reject']);
  await until(() => status(sid, 'idle'), 15000, 'idle');

  const snap = await session(sid);
  const types = snap.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['user', 'info', 'thinking']);
  assert.match(snap.events[1].text, /Mock ACP Agent 1\.0\.0 · ACP v1/);
  assert.equal(strip(snap.events[2].text), '使用者說「hello world」。我會先規劃再動手。');

  const texts = snap.events.filter((e) => e.type === 'text').map((e) => strip(e.text));
  assert.deepEqual(texts, ['第 1 回合，收到你的訊息：**hello world**\n\n', '完成 ✅ 指令已執行並更新 mock.txt。']);

  const [shell, edit] = snap.events.filter((e) => e.type === 'tool_use');
  assert.equal(shell.status, 'done');
  assert.equal(shell.kind, 'execute');
  assert.equal(shell.permission.chosen, 'approve');
  assert.equal(shell.content[0].content.text, 'hello\n');
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.content[0].type, 'diff');
  assert.equal(edit.content[0].newText, 'turn 1: hello world\n');

  const plan = snap.events.find((e) => e.type === 'plan');
  assert.deepEqual(plan.entries.map((e) => e.status), ['completed', 'completed']);
  // Order is preserved: text → tool → tool → text.
  assert.ok(types.indexOf('tool_use') > types.indexOf('text'));
  assert.equal(types.at(-1), 'turn_end');
  assert.equal(snap.events.at(-1).usage.inputTokens, 1200);

  // Agent metadata surfaced for the UI.
  assert.equal(snap.title, 'Mock: hello world');
  assert.equal(snap.meta.commands.length, 3);
  assert.equal(snap.meta.modes.currentModeId, 'default');
  assert.equal(snap.meta.configOptions[0].id, 'model');
  assert.deepEqual(snap.meta.context, { used: 12000, size: 262144 });

  // What the browser saw over the socket must rebuild the exact same text.
  const live = new Map();
  const latencies = [];
  for (const { at, msg } of inbox.slice(startIdx)) {
    if (msg.sid !== sid) continue;
    if (msg.t === 'event') live.set(msg.ev.id, { ...msg.ev });
    if (msg.t === 'delta') {
      const ev = live.get(msg.id);
      ev[msg.field] = (ev[msg.field] || '') + msg.text;
      for (const m of msg.text.matchAll(MARK)) latencies.push(at - Number(m[1]));
    }
    if (msg.t === 'patch') Object.assign(live.get(msg.id), msg.fields);
  }
  for (const ev of snap.events) assert.deepEqual(live.get(ev.id), ev, `event ${ev.type} differs between live stream and stored session`);

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  console.log(`  latency agent → browser over ${latencies.length} chunks: p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${latencies.at(-1)} ms`);
  assert.ok(latencies.length >= 15);
  assert.ok(pct(95) < 50, `p95 latency ${pct(95)} ms`);
});

test('follow-up turn reuses the same agent process and context', async () => {
  await api('POST', `/sessions/${sid}/messages`, { text: 'second' });
  await approveNext(sid, 'reject');
  await until(() => status(sid, 'idle'), 15000, 'idle');
  const snap = await session(sid);
  assert.equal(snap.events.filter((e) => e.type === 'info' && /已連線/.test(e.text)).length, 1, 'no reconnect');
  const texts = snap.events.filter((e) => e.type === 'text').map((e) => strip(e.text));
  assert.ok(texts.includes('第 2 回合，收到你的訊息：**second**\n\n'));
  const shells = snap.events.filter((e) => e.type === 'tool_use' && e.kind === 'execute');
  assert.equal(shells.at(-1).status, 'error');
  assert.equal(shells.at(-1).permission.chosen, 'reject');
});

test('images are forwarded as ACP image blocks', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await api('POST', `/sessions/${sid}/messages`, { text: 'look', images: [{ mimeType: 'image/png', data: png }] });
  await approveNext(sid, 'approve');
  await until(() => status(sid, 'idle'), 15000, 'idle');
  const snap = await session(sid);
  assert.ok(snap.events.some((e) => e.type === 'text' && strip(e.text).includes('收到 1 張圖片與你的訊息')));
});

test('interrupt cancels the running turn', async () => {
  await api('POST', `/sessions/${sid}/messages`, { text: 'slow please' });
  await until(() => status(sid, 'running'), 5000, 'running');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await api('POST', `/sessions/${sid}/interrupt`);
  await until(() => status(sid, 'idle'), 10000, 'idle after cancel');
  const snap = await session(sid);
  assert.equal(snap.events.at(-1).interrupted, true);
  console.log(`  cancel acknowledged in ${Date.now() - t0} ms`);
});

test('mode and model switches reach the agent', async () => {
  await api('POST', `/sessions/${sid}/config`, { modeId: 'plan' });
  await api('POST', `/sessions/${sid}/config`, { configId: 'model', value: 'mock-k2-turbo' });
  const snap = await until(async () => {
    const s = await session(sid);
    return s.meta.modes.currentModeId === 'plan' && s;
  });
  assert.equal(snap.meta.configOptions.find((o) => o.id === 'model').currentValue, 'mock-k2-turbo');
});

test('bypass mode answers permission requests automatically', async () => {
  const s = await api('POST', '/sessions', { agentId, prompt: 'auto', permissionMode: 'bypass' });
  await until(() => status(s.id, 'idle'), 15000, 'idle');
  const shell = (await session(s.id)).events.find((e) => e.type === 'tool_use' && e.kind === 'execute');
  assert.equal(shell.permission.auto, true);
  assert.equal(shell.permission.chosen, 'approve');
});

test('conversation resumes after the hub restarts', async () => {
  await stopServer();
  await startServer();
  await api('POST', `/sessions/${sid}/messages`, { text: 'after restart' });
  await approveNext(sid, 'approve');
  await until(() => status(sid, 'idle'), 15000, 'idle');
  const snap = await session(sid);
  assert.ok(snap.events.some((e) => e.type === 'info' && /已續接/.test(e.text)), 'resumed with session/resume');
});

test('not logged in → clear instructions with the login command', async () => {
  const a = await api('POST', '/agents', { type: 'acp', name: 'Mock NoAuth', command: process.execPath, args: `"${MOCK}"`, env: { MOCK_REQUIRE_AUTH: '1' }, login: 'mock-cli login' });
  const s = await api('POST', '/sessions', { agentId: a.id, prompt: 'hi' });
  await until(() => status(s.id, 'error'), 15000, 'error');
  const err = (await session(s.id)).events.find((e) => e.type === 'error');
  assert.match(err.text, /尚未登入/);
  assert.match(err.text, /mock-cli login/);
});
