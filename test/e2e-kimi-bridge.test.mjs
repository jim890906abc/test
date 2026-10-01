// End-to-end with the real Kimi Code CLI: hub + bridge + `kimi web`, where
// Kimi talks to a local fake OpenAI-compatible model, so no Kimi account or
// network is needed. Skipped unless the kimi CLI is available (KIMI_BIN or
// `kimi` on PATH).
//
//   KIMI_BIN=/path/to/kimi node --test test/e2e-kimi-bridge.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}
const KIMI = process.env.KIMI_BIN || which('kimi');
const SKIP = KIMI ? false : 'kimi CLI not installed (set KIMI_BIN)';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-kimi-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 22000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 24000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const procs = [];
let fake;
let kimiToken;
let machineId;

// Turn 1: text + a Bash call; after the tool result: a final answer.
function startFakeModel() {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const last = (j.messages || []).at(-1) || {};
      const send = (chunks) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      if (last.role === 'tool') return send([{ delta: { content: `結論：${String(last.content).includes('hello-from-kimi') ? '指令成功' : '指令沒有執行'}` } }, { delta: {}, finish_reason: 'stop' }]);
      const bash = (j.tools || []).map((t) => t.function || t).find((t) => /bash|shell/i.test(t.name));
      const args = JSON.stringify({ command: 'echo hello-from-kimi' });
      send([
        { delta: { role: 'assistant', content: '我來執行指令。' } },
        { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: bash.name, arguments: args } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ]);
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', r));
}

function run(cmd, args, env, ready) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${cmd} did not become ready:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      if (ready.test(out)) (clearTimeout(t), resolve(p));
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
}

const kimiApi = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return (await r.json()).data;
};
const api = async (method, p, body, token = TOKEN) => {
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': token }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const pendingEvent = (sid) => until(async () => (await api('GET', `/sessions/${sid}`)).events.find((e) => e.permission && !e.permission.chosen), 20000, 'approval');
const idle = (sid) => until(async () => (await api('GET', `/sessions/${sid}`)).status === 'idle' && api('GET', `/sessions/${sid}`), 20000, 'idle');

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'a.txt'), 'hello\n');
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine'], { KIMI_CODE_HOME: KIMI_HOME, HOME: path.join(TMP, 'home') }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.available), 10000, 'machine online');
  machineId = m.id;
});

after(() => {
  for (const p of procs) p.kill('SIGTERM');
  fake?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 500);
});

test('the hub requires its login token and the bridge key', { skip: SKIP }, async () => {
  await assert.rejects(api('GET', '/config', undefined, 'wrong'), (e) => e.status === 401);
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/bridge?key=wrong`);
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(code, 4401);
});

test('a Kimi conversation waiting for approval shows up and can be taken over', { skip: SKIP }, async () => {
  // Started on the Kimi side, as if typed into Kimi's own UI.
  const ks = await kimiApi('POST', '/sessions', { metadata: { cwd: PROJECT } });
  await kimiApi('POST', `/sessions/${ks.id}/prompts`, { content: [{ type: 'text', text: '從 Kimi 端開始' }], model: 'fake/fake-1', permission_mode: 'manual' });
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === machineId).sessions.find((s) => s.id === ks.id && s.pending === 'approval'), 20000, 'listed as waiting');

  const s = await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
  assert.equal(s.agentId, `kimi@${machineId}`);
  const ev = await pendingEvent(s.id);
  assert.equal(ev.name, 'Bash');
  assert.deepEqual(ev.permission.options.map((o) => o.optionId), ['approved', 'approved_session', 'rejected']);
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'approved' });
  const done = await idle(s.id);
  const tool = done.events.find((e) => e.type === 'tool_use' && e.name === 'Bash');
  assert.equal(tool.status, 'done');
  assert.match(tool.output, /hello-from-kimi/);
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('結論：指令成功')));
  assert.ok(done.events.some((e) => e.type === 'user' && e.text === '從 Kimi 端開始'));
});

test('messages sent from the hub run on the machine; a rejection reaches Kimi', { skip: SKIP }, async () => {
  const s = (await api('GET', '/sessions')).find((x) => x.machineId === machineId);
  await api('POST', `/sessions/${s.id}/messages`, { text: '再一次' });
  const ev = await pendingEvent(s.id);
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'rejected' });
  const done = await idle(s.id);
  const tools = done.events.filter((e) => e.type === 'tool_use' && e.name === 'Bash');
  assert.equal(tools.at(-1).status, 'error');
  assert.equal(tools.at(-1).permission.chosen, 'rejected');
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('指令沒有執行')));
  const files = await api('GET', `/sessions/${s.id}/files`);
  assert.ok(files.some((f) => f.name === 'a.txt'));
});

test('a new Kimi conversation can be started on the machine from the hub', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { agentId: `kimi@${machineId}`, prompt: 'hello', permissionMode: 'bypass' });
  assert.ok(s.kimiSessionId);
  assert.ok(s.cwd.includes('agent-hub-workspaces'));
  const done = await idle(s.id);
  assert.ok(done.events.some((e) => e.type === 'tool_use' && /hello-from-kimi/.test(e.output || '')));
  assert.equal(done.events.filter((e) => e.type === 'error').length, 0);
});
