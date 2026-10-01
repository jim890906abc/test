// End-to-end with the real Kimi Code CLI: hub + bridge + Kimi (`kimi web`
// and the terminal UI), where Kimi talks to a local fake OpenAI-compatible
// model, so no Kimi account or network is needed. Skipped unless the kimi CLI
// is available (KIMI_BIN or `kimi` on PATH). The terminal tests also need
// python3 (for a pseudo-terminal).
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
let PYTHON = null;
try {
  execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
  PYTHON = 'python3';
} catch {}
const SKIP_TTY = SKIP || (PYTHON && process.platform !== 'win32' ? false : 'python3 (pty) not available');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-kimi-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 22000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 24000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const procs = [];
let fake;
let kimiToken;
let machineId;

// A scripted model. The newest user message decides:
//   子代理 → an Agent call (the subagent runs `ls`); 待辦 → a TodoList call;
//   慢工具 → a slow Bash call; 聊天 → plain text; otherwise → a Bash call.
function startFakeModel() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs.filter((m) => m.role === 'user').map((m) => str(m.content)).filter((t) => !t.trimStart().startsWith('<system-reminder>'));
      const sub = users.some((u) => u.includes('SUBAGENT_TASK'));
      const lastUser = users.at(-1) || '';
      const prevCall = msgs.at(-2)?.tool_calls?.[0]?.function?.name;
      const send = (chunks, gap = 0) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) return res.end('data: [DONE]\n\n');
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunks[i++] }] })}\n\n`);
          setTimeout(tick, gap);
        };
        tick();
      };
      const text = (t) => [{ delta: { role: 'assistant', content: t } }, { delta: {}, finish_reason: 'stop' }];
      const call = (pre, name, args) => [
        { delta: { role: 'assistant', content: pre } },
        { delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ];
      if (sub) return send(last.role === 'tool' ? text('子代理結論：專案裡有 a.txt。') : call('子代理：先看看檔案。', 'Bash', { command: 'ls' }));
      if (last.role === 'tool') {
        if (prevCall === 'Agent') return send(text('子代理回報完成。'));
        if (prevCall === 'TodoList') return send(text('待辦已建立。'));
        return send(text(`結論：${String(last.content).includes('hello') ? '指令成功' : '指令沒有執行'}`));
      }
      if (lastUser.includes('子代理')) return send(call('我派一個子代理去看。', 'Agent', { description: '檢查專案檔案', prompt: 'SUBAGENT_TASK：列出專案檔案' }));
      if (lastUser.includes('待辦')) return send(call('先列待辦。', 'TodoList', { todos: [{ title: '讀取設定', status: 'done' }, { title: '修改程式', status: 'in_progress' }, { title: '跑測試', status: 'pending' }] }));
      if (lastUser.includes('慢工具')) return send(call('先跑一個慢指令。', 'Bash', { command: 'sleep 1.5 && echo slow-done' }));
      if (lastUser.includes('聊天')) return send(text(`收到：${lastUser}`));
      return send(call('我來執行指令。', 'Bash', { command: 'echo hello-from-kimi' }));
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

// Kimi's terminal UI in a pseudo-terminal; lines on stdin are typed into it.
const TTY_PY = `
import os, pty, sys, select, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
os.set_blocking(0, False)
while True:
    r, _, _ = select.select([fd, 0], [], [], 0.1)
    if fd in r:
        try:
            if not os.read(fd, 65536): break
        except OSError: break
    if 0 in r:
        data = sys.stdin.buffer.read()
        if not data: break
        for line in data.decode().splitlines():
            os.write(fd, line.encode()); time.sleep(0.3); os.write(fd, b'\\r'); time.sleep(0.2)
`;
function terminalKimi(argv) {
  const p = spawn(PYTHON, ['-c', TTY_PY, ...argv], {
    cwd: PROJECT,
    env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME, HOME, TERM: 'xterm-256color', COLUMNS: '100', LINES: '30', PATH: `${path.dirname(KIMI)}${path.delimiter}${process.env.PATH}` },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  procs.push(p);
  return { type: (line) => p.stdin.write(`${line}\n`), stop: () => p.kill('SIGKILL') };
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
const session = (sid) => api('GET', `/sessions/${sid}`);
const pendingEvent = (sid) => until(async () => (await session(sid)).events.find((e) => e.permission && !e.permission.chosen), 20000, 'approval');
const idle = (sid) => until(async () => (await session(sid)).status === 'idle' && session(sid), 20000, 'idle');
const listed = (pred, what) => until(async () => (await api('GET', '/machines')).find((m) => m.id === machineId).sessions.find(pred), 20000, what);

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'a.txt'), 'hello\n');
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
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
  // Started on the Kimi side, as if typed into Kimi's own web UI.
  const ks = await kimiApi('POST', '/sessions', { metadata: { cwd: PROJECT } });
  await kimiApi('POST', `/sessions/${ks.id}/prompts`, { content: [{ type: 'text', text: '從 Kimi 端開始' }], model: 'fake/fake-1', permission_mode: 'manual' });
  await listed((s) => s.id === ks.id && s.pending === 'approval', 'listed as waiting');

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

test('messages sent from the hub run on the machine; a rejection with feedback reaches Kimi', { skip: SKIP }, async () => {
  const s = (await api('GET', '/sessions')).find((x) => x.machineId === machineId);
  await api('POST', `/sessions/${s.id}/messages`, { text: '再一次' });
  const ev = await pendingEvent(s.id);
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'rejected', feedback: '先不要執行' });
  const done = await idle(s.id);
  const tools = done.events.filter((e) => e.type === 'tool_use' && e.name === 'Bash');
  assert.equal(tools.at(-1).status, 'error');
  assert.equal(tools.at(-1).permission.chosen, 'rejected');
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('指令沒有執行')));
  const files = await api('GET', `/sessions/${s.id}/files`);
  assert.ok(files.some((f) => f.name === 'a.txt'));
});

test('a new conversation started from the hub; subagents nest under their Agent call', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, prompt: '請用子代理檢查專案', permission: 'auto' });
  assert.ok(s.kimiSessionId);
  assert.ok(s.cwd.includes('agent-hub-workspaces'));
  const done = await idle(s.id);
  const agent = done.events.find((e) => e.type === 'tool_use' && e.name === 'Agent');
  assert.equal(agent.subagent.status, 'done');
  assert.match(agent.subagent.summary, /a\.txt/);
  const kids = done.events.filter((e) => e.parent === agent.id);
  assert.ok(kids.some((e) => e.type === 'tool_use' && e.name === 'Bash' && e.status === 'done'));
  assert.ok(kids.some((e) => e.type === 'text' && e.text.includes('子代理結論')));
  assert.equal(done.meta.permission, 'auto');

  // The same conversation rebuilt from Kimi's journal on disk.
  const again = await api('POST', `/machines/${machineId}/kimi/${s.kimiSessionId}/attach`);
  const re = await session(again.id);
  const agent2 = re.events.find((e) => e.type === 'tool_use' && e.name === 'Agent');
  assert.ok(re.events.some((e) => e.parent === agent2.id && e.type === 'tool_use'));
});

test('todos are tracked, and a message sent while Kimi works is slipped into the turn', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, prompt: '請列待辦', permission: 'auto' });
  let done = await idle(s.id);
  assert.deepEqual(done.meta.todos.map((t) => t.status), ['done', 'in_progress', 'pending']);
  assert.ok(done.events.some((e) => e.type === 'tool_use' && e.todos?.length === 3));

  await api('POST', `/sessions/${s.id}/messages`, { text: '慢工具' });
  await until(async () => (await session(s.id)).status === 'running', 5000, 'running');
  await new Promise((r) => setTimeout(r, 300));
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 插隊' });
  done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && !x.meta.queue?.length && x;
  }, 20000, 'steered and idle');
  const steered = done.events.find((e) => e.type === 'user' && e.text === '聊天 插隊');
  assert.equal(steered.steered, true);
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 插隊')));
});

test('a conversation running in a terminal Kimi is followed live, read-only', { skip: SKIP_TTY }, async () => {
  const tty = terminalKimi([KIMI, '--auto']);
  try {
    await new Promise((r) => setTimeout(r, 4000));
    tty.type(''); // accept "Trust this folder?" if Kimi asks
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 終端機');
    const k = await listed((s) => s.title === '聊天 終端機' && s.owner === 'tui', 'terminal conversation');
    assert.equal(k.controllable, false);
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    tty.type('慢工具');
    await until(async () => (await session(s.id)).status === 'running', 8000, 'running, seen from the hub');
    const done = await idle(s.id);
    assert.ok(done.events.some((e) => e.type === 'tool_use' && e.name === 'Bash' && /slow-done/.test(e.output || '')));
    assert.equal(done.meta.owner, 'tui');
    await assert.rejects(api('POST', `/sessions/${s.id}/messages`, { text: 'hi' }), (e) => e.status === 409);
  } finally {
    tty.stop();
  }
});

test('a terminal Kimi started with `agent-hub-bridge.mjs kimi` can be driven from the hub', { skip: SKIP_TTY }, async () => {
  const tty = terminalKimi([process.execPath, path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'kimi']);
  try {
    await new Promise((r) => setTimeout(r, 5000));
    tty.type('');
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 可操作');
    const k = await listed((s) => s.title === '聊天 可操作' && s.owner === 'tui' && s.controllable, 'controllable terminal conversation');
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    await api('POST', `/sessions/${s.id}/messages`, { text: '請執行指令' });
    const ev = await pendingEvent(s.id);
    await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'approved' });
    const done = await until(async () => {
      const x = await session(s.id);
      return x.status === 'idle' && x.events.some((e) => e.type === 'text' && e.text.includes('結論：指令成功')) && x;
    }, 20000, 'approved in the terminal');
    assert.equal(done.events.filter((e) => e.type === 'user' && e.text === '請執行指令').length, 1, 'shown once');
  } finally {
    tty.stop();
  }
});
