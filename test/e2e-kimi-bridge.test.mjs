// End-to-end with the real Kimi Code CLI: hub + bridge + Kimi (`kimi web`
// and the terminal UI), where Kimi talks to a local fake OpenAI-compatible
// model, so no Kimi account or network is needed. Skipped (out loud, with the
// reason; REQUIRE_KIMI=1 makes it a failure) unless the kimi CLI is available
// (KIMI_BIN or `kimi` on PATH, found the same way for every e2e file). The
// terminal tests also need python3 (for a pseudo-terminal).
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
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-kimi-bridge');
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
const seen = []; // requests the fake model got
const wire = []; // every JSON request body plus its path, unlike `seen`
const poolSeen = []; // OpenAI-compatible requests through the key-pool proxy
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
      if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (j && typeof j === 'object') wire.push({ url: req.url, body: j });
      if (req.url.startsWith('/opencode-go/')) {
        const auth = req.headers.authorization || '';
        poolSeen.push({ auth, body: j });
        if (auth === 'Bearer sk-pool-first') {
          res.statusCode = 429;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'This key has no quota left' } }));
        }
      }
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      seen.push(j);
      // What the user said, without the notes Kimi and Agent Hub put around it.
      const users = msgs
        .filter((m) => m.role === 'user')
        .map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
        .filter(Boolean);
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
      if (sub && users.some((u) => u.includes('SLOWSUB'))) return send(last.role === 'tool' ? text('慢子代理做完了。') : call('子代理：跑很久的指令。', 'Bash', { command: 'sleep 20 && echo sub-done' }));
      if (sub) return send(last.role === 'tool' ? text('子代理結論：專案裡有 a.txt。') : call('子代理：先看看檔案。', 'Bash', { command: 'ls' }));
      if (lastUser.includes('子代理群') && last.role !== 'tool') return send(call('開一群子代理。', 'AgentSwarm', { description: '測試群', prompt_template: 'SUBAGENT_TASK SLOWSUB {{item}}', items: ['甲', '乙'] }));
      if (lastUser.includes('慢子代理') && last.role !== 'tool') return send(call('開一個慢子代理。', 'Agent', { description: '慢的', prompt: 'SUBAGENT_TASK SLOWSUB x' }));
      // Bound to a GitHub repository: Agent Hub's end-of-turn reminder, done
      // (REPOGOOD) or not; work left uncommitted; a forced push.
      const bound = lastUser.match(/bound to `([^`]+)`/);
      if (/Agent Hub check at the end of your turn/.test(lastUser)) {
        if (last.role === 'tool') return send(text('已經 commit 並 push。'));
        if (!users[0].includes('REPOGOOD')) return send(text('好的，等一下再處理。'));
        const dir = lastUser.match(/The clone is at (\S+):/)?.[1] || '.';
        return send(call('我來 commit 並 push。', 'Bash', { command: `cd ${dir} && git add -A && git -c user.name=Kimi -c user.email=kimi@example.com commit -q -m "Add work.txt" && git push -q -u origin ${bound[1]}` }));
      }
      if (/has bound this conversation/.test(lastUser)) {
        if (last.role === 'tool') return send(text('搬好了。'));
        return send(call('把檔案搬進 repo。', 'Bash', { command: `cp a.txt ${lastUser.match(/It was cloned into (\S+), inside/)[1]}/moved.txt` }));
      }
      if (lastUser.includes('REPOFORCE') && last.role !== 'tool') return send(call('推上去。', 'Bash', { command: 'git push -f origin main' }));
      if (/REPOGOOD|REPOLAZY/.test(lastUser) && last.role !== 'tool') return send(call('寫檔案。', 'Bash', { command: 'echo work > work.txt' }));
      if (last.role === 'tool') {
        if (prevCall === 'Agent') return send(text('子代理回報完成。'));
        if (prevCall === 'TodoList') return send(text('待辦已建立。'));
        return send(text(`結論：${String(last.content).includes('hello') ? '指令成功' : '指令沒有執行'}`));
      }
      if (lastUser.includes('子代理')) return send(call('我派一個子代理去看。', 'Agent', { description: '檢查專案檔案', prompt: 'SUBAGENT_TASK：列出專案檔案' }));
      if (lastUser.includes('待辦')) return send(call('先列待辦。', 'TodoList', { todos: [{ title: '讀取設定', status: 'done' }, { title: '修改程式', status: 'in_progress' }, { title: '跑測試', status: 'pending' }] }));
      if (lastUser.includes('慢工具')) return send(call('先跑一個慢指令。', 'Bash', { command: 'sleep 1.5 && echo slow-done' }));
      // A background command; when it is done, Kimi's own turn runs a long one.
      if (users[0]?.includes('背景工作') && !users.some((u) => /聊天|慢聊/.test(u))) {
        const args = (m) => m?.tool_calls?.[0]?.function?.arguments || '';
        if (last.role === 'tool') return send(text(args(msgs.at(-2)).includes('run_in_background') ? '背景開始了。' : '自己的回合做完了。'));
        if (!msgs.some((m) => m.role === 'tool')) return send(call('開一個背景工作。', 'Bash', { command: 'sleep 2 && echo bg-done', run_in_background: true, description: 'bg' }));
        return send(call('背景好了，接著跑長指令。', 'Bash', { command: 'sleep 6 && echo own-done' }));
      }
      if (lastUser.includes('長工作') && last.role !== 'tool') return send(call('跑一個長指令。', 'Bash', { command: 'sleep 6 && echo long-done' }));
      if (lastUser.includes('聊天')) return send(text(`收到：${lastUser}`));
      if (lastUser.includes('慢聊')) return send([...text(`收到：${lastUser}`).slice(0, 1), { delta: { content: '。' } }, { delta: { content: '。' } }, { delta: {}, finish_reason: 'stop' }], 500);
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
function terminalKimi(argv, cwd = PROJECT) {
  const p = spawn(PYTHON, ['-c', TTY_PY, ...argv], {
    cwd,
    env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME, HOME, TERM: 'xterm-256color', COLUMNS: '100', LINES: '30', PATH: `${path.dirname(KIMI)}${path.delimiter}${process.env.PATH}`, BROWSER: 'true' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  procs.push(p);
  return { type: (line) => p.stdin.write(`${line}\n`), stop: () => p.kill('SIGKILL') };
}

// What Kimi has written to a conversation's journal (sessions/<workspace>/<id>/
// agents/main/wire.jsonl under the Kimi home), as records. The Hub reads this
// journal when it opens a conversation, and Kimi writes to it a moment after
// it has answered a request or ended a turn — under load, later than a test
// that looks at the clock expects.
function journalRecords(kimiSessionId) {
  const root = path.join(KIMI_HOME, 'sessions');
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root);
  } catch {}
  for (const w of workspaces) {
    const file = path.join(root, w, kimiSessionId, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(file)) continue;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a line still being written
      }
    });
  }
  return [];
}
const journalPermission = (kimiSessionId) => journalRecords(kimiSessionId).filter((r) => r.type === 'permission.set_mode').at(-1)?.mode ?? null;
const kimiApi = async (method, p, body) => {
  // The bridge may restart `kimi web` to load the broker hook; its token file
  // is the source of truth, not the one read at startup.
  try {
    kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  } catch {}
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
const contentText = (content) => (typeof content === 'string' ? content : (content || []).map((p) => p.text || '').join(''));
// The newest user text a model saw, without Kimi's/Agent Hub's reminders.
const lastUserText = (body) => {
  const users = (body?.messages || [])
    .filter((m) => m.role === 'user')
    .map((m) => contentText(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean);
  return users.at(-1) || '';
};
const kimiSecondary = async () => {
  const cfg = await kimiApi('GET', '/config');
  const sec = cfg?.secondary_model || cfg?.secondaryModel;
  if (!sec) return null;
  return {
    model: sec.default_model ?? sec.defaultModel ?? sec.model,
    effort: sec.default_effort ?? sec.defaultEffort,
    force: (sec.force ?? false) === true,
  };
};
let dsReady = false;
// The tool policy Kimi keeps for a native session, as written by the per-prompt
// disabled_tools field (null until the file exists).
const kimiDisabledTools = (sid) => {
  const root = path.join(KIMI_HOME, 'sessions');
  for (const ws of fs.readdirSync(root)) {
    const f = path.join(root, ws, sid, 'tool-policy', 'state.json');
    if (!fs.existsSync(f)) continue;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')).disabledTools || [];
    } catch {}
  }
  return null;
};
// The bridge provisions the DeepSeek provider — and, because
// [secondary_model] is empty, this gateway's V4.1 Flash at max — when a
// DeepSeek conversation needs it. Both native-Agent tests start from that.
async function ensureDeepseekSecondary() {
  if (dsReady) return kimiSecondary();
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-native-test' });
  const warm = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 建立 DeepSeek', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await idle(warm.id);
  const secondary = await until(kimiSecondary, 20000, 'Kimi [secondary_model]');
  assert.deepEqual(secondary, { model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max', force: false });
  dsReady = true;
  return secondary;
}

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'a.txt'), 'hello\n');
  await startFakeModel();
  kimiWeb = await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_GITHUB_TEST_URL: path.join(TMP, 'github'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
});

let kimiWeb;
after(() => {
  for (const p of procs) p.kill('SIGTERM');
  // A Kimi server the bridge started on its own.
  try {
    for (const f of fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances'))) {
      try {
        process.kill(JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8')).pid, 'SIGTERM');
      } catch {}
    }
  } catch {}
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
  const s = await api('POST', '/sessions', { machineId, prompt: '請用子代理檢查專案', permission: 'auto', subagent: null });
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

  // Sent while busy: queued, runs as its own turn after the current one.
  const busyThen = async (text, after) => {
    await api('POST', `/sessions/${s.id}/messages`, { text: '慢工具' });
    await until(async () => (await session(s.id)).status === 'running', 5000, 'running');
    await new Promise((r) => setTimeout(r, 300));
    await after(text);
    return until(async () => {
      const x = await session(s.id);
      return x.status === 'idle' && !x.meta.queue?.length && x.events.some((e) => e.type === 'text' && e.text.includes(`收到：${text}`)) && x;
    }, 20000, `${text} answered`);
  };
  done = await busyThen('聊天 排隊', (text) => api('POST', `/sessions/${s.id}/messages`, { text }));
  assert.ok(!done.events.find((e) => e.type === 'user' && e.text === '聊天 排隊').steered);

  // 插隊: steered into the running turn without interrupting it.
  done = await busyThen('聊天 插隊', (text) => api('POST', `/sessions/${s.id}/messages`, { text, steer: true }));
  assert.equal(done.events.find((e) => e.type === 'user' && e.text === '聊天 插隊').steered, true);

  // A queued message can be steered later from the queue tray.
  done = await busyThen('聊天 後插', async (text) => {
    await api('POST', `/sessions/${s.id}/messages`, { text });
    const q = await until(async () => (await session(s.id)).meta.queue?.find((x) => x.text === text), 5000, 'queued');
    await api('POST', `/sessions/${s.id}/queue/${q.promptId}/steer`);
  });
  assert.equal(done.events.find((e) => e.type === 'user' && e.text === '聊天 後插').steered, true);
});

test('a conversation running in an uncontrollable terminal Kimi is still driven from the hub over the API', { skip: SKIP_TTY }, async () => {
  const tty = terminalKimi([KIMI, '--auto']);
  let sid = null; // cleanup on a failed assertion, so later tests see no leftover owner
  try {
    await new Promise((r) => setTimeout(r, 4000));
    tty.type(''); // accept "Trust this folder?" if Kimi asks
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 終端機');
    const k = await listed((s) => s.title === '聊天 終端機' && s.owner === 'tui', 'terminal conversation');
    assert.equal(k.controllable, false);
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    sid = s.id;
    tty.type('慢工具');
    await until(async () => (await session(s.id)).status === 'running', 8000, 'running, seen from the hub');
    const done = await idle(s.id);
    assert.ok(done.events.some((e) => e.type === 'tool_use' && e.name === 'Bash' && /slow-done/.test(e.output || '')));
    assert.equal(done.meta.owner, 'tui');
    // The terminal is still open and the hub does not control it: without
    // /unlock, the message goes through Kimi's Server API and is answered.
    await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 終端機從中控台' });
    const answered = await until(async () => {
      const x = await session(s.id);
      return x.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 終端機從中控台')) && x;
    }, 30000, 'answered over the API while the terminal is open');
    assert.ok(answered.events.some((e) => e.type === 'user' && e.text === '聊天 終端機從中控台'));
    // The old /unlock endpoint remains for compatibility, but the send above
    // did not depend on it.
    await api('POST', `/sessions/${s.id}/unlock`);
    await until(async () => (await session(s.id)).meta.owner !== 'tui', 8000, 'unlocked');
  } finally {
    if (sid) await api('POST', `/sessions/${sid}/unlock`).catch(() => {});
    tty.stop();
  }
});

test('other conversations in the folder of a terminal Kimi work from the hub without unlocking', { skip: SKIP_TTY }, async () => {
  // An older conversation in the project folder, started on the Kimi side.
  const ks = await kimiApi('POST', '/sessions', { metadata: { cwd: PROJECT } });
  await kimiApi('POST', `/sessions/${ks.id}/prompts`, { content: [{ type: 'text', text: '聊天 舊對話' }], model: 'fake/fake-1' });
  await listed((s) => s.id === ks.id && !s.busy && s.title, 'older conversation');
  const older = await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
  const tty = terminalKimi([KIMI, '--auto']);
  const olderId = older.id;
  try {
    await new Promise((r) => setTimeout(r, 4000));
    tty.type('');
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 另一個');
    await listed((s) => s.title === '聊天 另一個' && s.owner === 'tui' && !s.guess, 'terminal conversation');
    // The terminal Kimi could have the older one open (/resume): a guessed
    // conversation, but still usable from the hub.
    const guessed = await until(async () => {
      const x = await session(older.id);
      return x.meta.owner === 'tui' && x.meta.guess && x;
    }, 8000, 'older conversation guessed');
    assert.equal(guessed.meta.controllable, false);
    // No /unlock: the message goes through Kimi's Server API and is answered.
    await api('POST', `/sessions/${older.id}/messages`, { text: '聊天 舊對話從中控台' });
    await until(async () => (await session(older.id)).events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 舊對話從中控台')), 30000, 'answered over the API while the terminal is open');
    // A new one from the hub in the same folder is the hub's.
    const fresh = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '聊天 新對話', permission: 'auto' });
    assert.ok((await idle(fresh.id)).events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 新對話')));
    assert.notEqual((await session(fresh.id)).meta.owner, 'tui');
    // The compatibility endpoint itself still works.
    await api('POST', `/sessions/${older.id}/unlock`);
    await until(async () => (await session(older.id)).meta.owner !== 'tui', 8000, 'unlocked');
  } finally {
    await api('POST', `/sessions/${olderId}/unlock`).catch(() => {});
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

    // While the terminal Kimi works: one message waits for the turn to end,
    // the other is steered in with Ctrl-S.
    await api('POST', `/sessions/${s.id}/messages`, { text: '慢工具' });
    const slow = await pendingEvent(s.id);
    await api('POST', `/sessions/${s.id}/permissions/${slow.id}`, { optionId: 'approved' });
    await new Promise((r) => setTimeout(r, 300));
    await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 終端排隊' });
    await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 終端插隊', steer: true });
    await until(async () => {
      const x = await session(s.id);
      const said = (t) => x.events.some((e) => e.type === 'text' && e.text.includes(`收到：${t}`));
      return x.status === 'idle' && !x.meta.queue?.length && said('聊天 終端排隊') && said('聊天 終端插隊') && x;
    }, 30000, 'terminal queue and steer');
  } finally {
    tty.stop();
  }
});

test('a conversation from a terminal Kimi that was closed is continued from the hub', { skip: SKIP_TTY }, async () => {
  const tty = terminalKimi([KIMI, '--auto']);
  await new Promise((r) => setTimeout(r, 4000));
  tty.type('');
  await new Promise((r) => setTimeout(r, 1000));
  tty.type('聊天 關掉之前');
  const k = await listed((s) => s.title === '聊天 關掉之前' && s.owner === 'tui', 'terminal conversation');
  await new Promise((r) => setTimeout(r, 1500));
  tty.stop();
  await listed((s) => s.id === k.id && s.owner !== 'tui', 'terminal closed');
  const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 關掉之後' });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 關掉之後')) && x;
  }, 30000, 'answered from the hub');
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 關掉之前')), 'earlier turns are there');
});

test('opening an existing Kimi conversation keeps its native model, effort and permission', { skip: SKIP }, async () => {
  await api('PUT', '/settings', { defaults: { permission: 'auto' } });
  try {
    const ks = await kimiApi('POST', '/sessions', { metadata: { cwd: PROJECT } });
    await kimiApi('POST', `/sessions/${ks.id}/prompts`, { content: [{ type: 'text', text: '聊天 舊的對話' }], model: 'fake/fake-1', permission_mode: 'manual' });
    await listed((s) => s.id === ks.id && !s.busy && s.title, 'conversation started in Kimi');
    // Opening it reads the journal: wait until the journal has what the
    // conversation was started with (its model, its permission, the turn
    // ended). Opened earlier, the Hub finds no model there and applies its
    // global default permission over the conversation's own.
    await until(async () => {
      const records = journalRecords(ks.id);
      return records.some((r) => r.type === 'profile.bind' && r.modelAlias) && journalPermission(ks.id) === 'manual' && records.some((r) => r.type === 'turn.ended');
    }, 15000, 'the conversation in Kimi\'s journal');
    const s = await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
    // Global defaults belong to new conversations; this one was already
    // running with its own permission and must keep it.
    await until(async () => (await session(s.id)).meta.permission === 'manual', 15000, 'the native permission');
    // Changed in Kimi itself: opening it again follows Kimi, not the Hub default.
    await kimiApi('POST', `/sessions/${ks.id}/profile`, { agent_config: { permission_mode: 'yolo' } });
    await until(async () => journalPermission(ks.id) === 'yolo', 15000, "Kimi's journal to record the change");
    await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
    await until(async () => (await session(s.id)).meta.permission === 'yolo', 15000, 'the native permission after Kimi changed it');
    // Chosen in the conversation from the hub: it stays.
    await api('POST', `/sessions/${s.id}/config`, { permission: 'manual' });
    // Opening a conversation reads Kimi's journal, and Kimi writes a profile
    // change there a moment after it has answered the request. Opening it
    // again before that read the old value back (the flaky 'yolo' !==
    // 'manual' when the machine was busy). Wait for the journal, not for the
    // clock: the choice is recorded there, then nothing is left to arrive.
    await until(async () => journalPermission(ks.id) === 'manual', 15000, "the choice in Kimi's journal");
    await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
    // The attach has finished (its answer comes after the defaults step): the
    // global default ('auto') must not have been applied over the choice.
    const after = await session(s.id);
    assert.equal(after.meta.permission, 'manual');
    assert.equal((await api('GET', '/config')).settings.defaults.permission, 'auto', 'the default that must not win is really set');
  } finally {
    await api('PUT', '/settings', { defaults: {} });
  }
});

test('a per-conversation subagent default injects a scoped MCP token without putting it in Hub events', { skip: SKIP }, async () => {
  // The hook/MCP config is installed by the bridge; start this conversation
  // after the capability is advertised, as a browser would once connected.
  await until(async () => ((await api('GET', '/machines')).find((m) => m.id === machineId)?.broker || 0) >= 1, 20000, 'broker capability');
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '聊天 初始設定', permission: 'auto' });
  await until(async () => (await session(s.id)).status === 'idle', 20000, 'first turn');
  await api('POST', `/sessions/${s.id}/config`, { subagent: { provider: 'kimi', model: 'fake/fake-1', effort: '' } });
  assert.deepEqual((await session(s.id)).meta.subagent, { provider: 'kimi', model: 'fake/fake-1', effort: '' });
  const n0 = seen.length;
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 token 測試' });
  await until(async () => (await session(s.id)).status === 'idle' && seen.length > n0, 20000, 'answered with the token');
  const body = JSON.stringify(seen.slice(n0));
  assert.match(body, /mcp__agent-hub__delegate_to_provider/);
  assert.match(body, /hb_[0-9a-f]{48}/);
  const snap = await session(s.id);
  assert.ok(!JSON.stringify(snap.events).includes('hb_'), 'delegation token is not in Hub-visible events');
  assert.equal(snap.subagent.provider, 'kimi');
  assert.ok(snap.meta?.subagent, 'the subagent default survives the token turn');
  // The installed PreToolUse hook must stop the native Agent call and point
  // the model at the MCP broker instead.
  const n1 = seen.length;
  await api('POST', `/sessions/${s.id}/messages`, { text: '子代理 原生不得執行' });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && seen.length > n1 && x;
  }, 20000, 'native agent hook denied');
  const native = done.events.find((e) => e.name === 'Agent');
  assert.ok(native, 'the Agent call is visible');
  assert.equal(native.isError || native.status === 'error', true, JSON.stringify(native));
  assert.match(native.output || '', /disabled by the active tool policy|Agent Hub 子代理/);
  await api('POST', `/sessions/${s.id}/config`, { subagent: null });
});

test('a DeepSeek pool rotates an exhausted key inside the same real Kimi request', { skip: SKIP }, async () => {
  const first = 'sk-pool-first';
  const second = 'sk-pool-second';
  let acc = await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: first });
  acc = await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: second });
  const firstId = acc.gateways.find((g) => g.id === 'opencode-go').keys.find((k) => k.hint === 'irst').id;
  const secondId = acc.gateways.find((g) => g.id === 'opencode-go').keys.find((k) => k.hint === 'cond').id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', activateKeyId: firstId });
  const n0 = poolSeen.length;
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 號池輪替', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 號池輪替')) && x.events.some((e) => e.type === 'turn_end') && x;
  }, 30000, 'the second key completes the same turn');
  assert.equal(done.mode, 'deepseek');
  assert.equal(done.meta.model, 'agent-hub-deepseek/deepseek-v4.1-flash');
  assert.equal(done.meta.effort, 'max');
  assert.equal(done.events.filter((e) => e.type === 'user' && e.text === '聊天 號池輪替').length, 1);
  assert.equal(done.events.filter((e) => e.type === 'turn_end').length, 1);
  const calls = poolSeen.slice(n0);
  assert.equal(calls.length, 2, 'the first key fails, then the same request goes to the second');
  assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${first}`, `Bearer ${second}`]);
  assert.deepEqual(calls[0].body, calls[1].body, 'model, effort and the whole request are identical');
  assert.equal(calls[0].body.model, 'deepseek-v4.1-flash');
  assert.equal(calls[0].body.reasoning_effort, 'max');
  acc = await until(async () => {
    const a = await api('GET', '/deepseek');
    return a.activity?.some((x) => x.machineId === machineId && x.gateway === 'opencode-go' && x.activeId === secondId) ? a : null;
  }, 10000, 'the bridge reports the actual active key');
  const keys = acc.gateways.find((g) => g.id === 'opencode-go').keys;
  assert.ok(keys.find((k) => k.id === firstId).exhaustedAt);
  assert.equal(keys.find((k) => k.id === secondId).exhaustedAt, null);
  assert.ok(!JSON.stringify(acc).includes(first) && !JSON.stringify(acc).includes(second), 'public account never exposes either key');
});

// These run after the pool test on purpose: provisioning the provider here
// would otherwise leave it on one key and hide the pool rotation from the
// test above. The pool test leaves a provider whose [secondary_model] is the
// same Flash alias, so the native path is still the real one.
test('the DeepSeek default runs Kimi’s own Agent on the provisioned Flash · max [secondary_model], with no MCP token', { skip: SKIP }, async () => {
  await until(async () => ((await api('GET', '/machines')).find((m) => m.id === machineId)?.broker || 0) >= 1, 20000, 'broker capability');
  await ensureDeepseekSecondary();
  const n0 = wire.length;
  // No subagent is named: the conversation gets the DeepSeek default.
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '子代理 DeepSeek 原生', permission: 'auto' });
  const done = await until(async () => {
    const x = await session(s.id);
    const card = x.events.find((e) => e.type === 'tool_use' && e.name === 'Agent' && e.subagent?.status === 'done');
    return x.status === 'idle' && card && { x, card };
  }, 30000, 'native DeepSeek Agent finished');
  const { x, card } = done;
  assert.deepEqual(x.meta.subagent, { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' });
  assert.ok(card.subagent.id, 'a real native subagent id');
  assert.equal(card.subagent.model, 'agent-hub-deepseek/deepseek-v4.1-flash');
  assert.equal(card.subagent.effort, 'max');
  assert.ok(!card.subagent.broker, 'a native subagent, not a broker child');
  assert.equal(card.childSessionId, undefined, 'no Hub child session for a native subagent');
  // The subagent's own tool process and result are visible under its card.
  const bash = x.events.find((e) => e.type === 'tool_use' && e.parent === card.id && e.name === 'Bash');
  assert.ok(bash, `no tool process under the Agent card: ${JSON.stringify(x.events.slice(-8))}`);
  assert.match(bash.output, /a\.txt/);
  assert.match(card.subagent.summary, /a\.txt/);
  assert.ok(!x.events.some((e) => /delegate_to_provider/.test(e.name || '')), 'no MCP broker card');
  // Nothing disabled the native tools for this DeepSeek default.
  const disabled = kimiDisabledTools(x.kimiSessionId);
  assert.ok(!disabled || disabled.length === 0, `the native tools were disabled: ${JSON.stringify(disabled)}`);
  // The prompt carried no broker token or instruction: the model chose.
  const promptReq = wire.slice(n0).find((w) => w.url === '/v1/chat/completions' && lastUserText(w.body) === '子代理 DeepSeek 原生');
  assert.ok(promptReq, 'the main model got the prompt');
  assert.doesNotMatch(JSON.stringify(promptReq.body.messages), /hb_[0-9a-f]{48}|delegate_to_provider|不要使用原生 Agent/);
  // The subagent really ran on the DeepSeek wire model at max, not only in
  // the Hub's settings.
  const childReq = wire.slice(n0).find((w) => w.url === '/opencode-go/chat/completions' && w.body.model === 'deepseek-v4.1-flash' && JSON.stringify(w.body.messages).includes('SUBAGENT_TASK'));
  assert.ok(childReq, 'no DeepSeek request for the native subagent');
  assert.equal(childReq.body.reasoning_effort, 'max');
});

test('an old conversation disabled for the broker gets its native tools back on the first DeepSeek prompt', { skip: SKIP }, async () => {
  await ensureDeepseekSecondary();
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '聊天 切換之前', permission: 'auto' });
  const firstTurn = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'turn_end') && x;
  }, 20000, 'the first turn');
  const kid = firstTurn.kimiSessionId;
  await api('POST', `/sessions/${s.id}/config`, { subagent: { provider: 'kimi', model: 'fake/fake-1', effort: '' } });
  const n0 = wire.length;
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 broker 打開' });
  const brokerPrompt = await until(async () => wire.slice(n0).find((w) => lastUserText(w.body) === '聊天 broker 打開'), 20000, 'the broker prompt');
  assert.match(JSON.stringify(brokerPrompt.body.messages), /hb_[0-9a-f]{48}/);
  // Kimi keeps the broker's tool policy for the session.
  const disabled = await until(async () => (kimiDisabledTools(kid)?.length ? kimiDisabledTools(kid) : null), 10000, 'the broker tool policy');
  assert.ok(disabled.includes('Agent'), JSON.stringify(disabled));
  await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'user' && e.text === '聊天 broker 打開') && x;
  }, 20000, 'the broker turn');
  // Switching to DeepSeek must send the empty list on the next prompt so the
  // native Agent is usable again.
  await api('POST', `/sessions/${s.id}/config`, { subagent: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' } });
  const n1 = wire.length;
  await api('POST', `/sessions/${s.id}/messages`, { text: '子代理 恢復原生' });
  const done = await until(async () => {
    const x = await session(s.id);
    const card = x.events.find((e) => e.type === 'tool_use' && e.name === 'Agent' && e.subagent?.status === 'done');
    return x.status === 'idle' && card && { x, card };
  }, 30000, 'restored native Agent');
  const promptReq = wire.slice(n1).find((w) => lastUserText(w.body) === '子代理 恢復原生');
  assert.ok(promptReq, 'the prompt after the switch reached the model');
  // The old turn's token reminder is history (short-lived and harmless); what
  // the Hub adds for this prompt must be nothing.
  const msgs = promptReq.body.messages || [];
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant');
  assert.doesNotMatch(JSON.stringify(msgs.slice(lastAssistant + 1)), /hb_[0-9a-f]{48}|delegate_to_provider|不要使用原生 Agent/);
  // The tool policy itself is back to empty, not only the Agent card.
  const restored = await until(async () => {
    const d = kimiDisabledTools(kid);
    return Array.isArray(d) && d.length === 0 ? d : null;
  }, 10000, 'the native tool policy restored');
  assert.deepEqual(restored, []);
  assert.equal(done.card.subagent.model, 'agent-hub-deepseek/deepseek-v4.1-flash');
  assert.equal(done.card.subagent.effort, 'max');
  const bash = done.x.events.find((e) => e.type === 'tool_use' && e.parent === done.card.id && e.name === 'Bash');
  assert.ok(bash, 'the restored Agent really ran its tool');
  assert.match(bash.output, /a\.txt/);
});

test('a page Kimi wrote outside the conversation folder still opens; other files do not', { skip: SKIP }, async () => {
  const dir = path.join(TMP, 'elsewhere');
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'report.html');
  const secret = path.join(dir, 'other.html');
  fs.writeFileSync(page, '<h1>報告</h1>');
  fs.writeFileSync(secret, '<h1>不該讀到</h1>');
  const ks = await kimiApi('POST', '/sessions', { metadata: { cwd: PROJECT } });
  await kimiApi('POST', `/sessions/${ks.id}/prompts`, { content: [{ type: 'text', text: `聊天 頁面在 ${page}` }], model: 'fake/fake-1' });
  await listed((s) => s.id === ks.id && !s.busy && s.title, 'conversation');
  const s = await api('POST', `/machines/${machineId}/kimi/${ks.id}/attach`);
  const f = await api('GET', `/sessions/${s.id}/file?path=${encodeURIComponent(page)}`);
  assert.equal(f.content, '<h1>報告</h1>');
  await assert.rejects(api('GET', `/sessions/${s.id}/file?path=${encodeURIComponent(secret)}`));
});

// Last: it replaces the Kimi server the other tests talk to directly.
// A bare repository standing in for GitHub's me/proj (main: README.md).
function githubRepo() {
  const origin = path.join(TMP, 'github', 'me', 'proj.git');
  if (fs.existsSync(origin)) return origin;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const seed = path.join(TMP, 'seed');
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# proj\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', origin, 'main');
  return origin;
}
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const turnsOf = (sid, n) => until(async () => { const x = await session(sid); return x.status === 'idle' && x.events.filter((e) => e.type === 'turn_end').length >= n && x; }, 40000, `${n} turns`);

test('a new Kimi conversation bound to a GitHub repository: cloned, told the rules, reminded, pushed', { skip: SKIP }, async () => {
  const origin = githubRepo();
  const n0 = seen.length;
  const s = await api('POST', '/sessions', { machineId, repo: 'me/proj', prompt: 'REPOGOOD 寫一個檔案', permission: 'auto' });
  const branch = s.repo.branch;
  assert.match(branch, /^claude\/\d{8}-[0-9a-f]{4}$/);
  assert.equal(s.repo.full, 'me/proj');
  assert.equal(s.cwd, s.repo.dir);
  assert.match(s.cwd, /agent-hub-workspaces\/\d{4}-\d\d-\d\d-proj$/);
  assert.equal(gitIn(s.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  // Kimi wrote work.txt and stopped; Agent Hub reminded it; it pushed.
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'text' && e.text.includes('已經 commit 並 push')) && x;
  }, 60000, 'pushed');
  assert.equal(gitIn(origin, 'show', `${branch}:work.txt`), 'work');
  assert.ok(done.events.some((e) => e.type === 'user' && e.note === 'Agent Hub 檢查：還有沒上傳到 GitHub 的工作'));
  // The rules went with the first message.
  const first = seen.slice(n0).find((j) => JSON.stringify(j.messages).includes('REPOGOOD'));
  assert.match(JSON.stringify(first.messages), /bound to the GitHub repository me\/proj/);
});

test('a forced push asked for in a bound Kimi conversation is refused for the user', { skip: SKIP }, async () => {
  githubRepo();
  const s = await api('POST', '/sessions', { machineId, repo: 'me/proj', branch: 'main', prompt: 'REPOFORCE', permission: 'manual' });
  const done = await until(async () => {
    const x = await session(s.id);
    const ev = x.events.find((e) => e.type === 'tool_use' && e.name === 'Bash');
    return x.status === 'idle' && ev?.permission?.chosen === 'rejected' && x;
  }, 40000, 'refused');
  assert.ok(done.events.some((e) => e.type === 'info' && /Agent Hub 擋下了這個指令/.test(e.text)));
  assert.equal(gitIn(s.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('an existing Kimi conversation bound to a repository: cloned inside its folder, work brought over and pushed', { skip: SKIP }, async () => {
  const origin = githubRepo();
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '聊天 你好', permission: 'auto' });
  await turnsOf(s.id, 1);
  const b = await api('POST', `/sessions/${s.id}/repo`, { repo: 'me/proj', branch: 'feature/k' });
  assert.equal(b.repo.dir, path.join(PROJECT, 'proj'));
  assert.equal(b.cwd, PROJECT);
  await assert.rejects(api('POST', `/sessions/${s.id}/repo`, { repo: 'me/proj' }), /已經綁定/);
  // Kimi brings a.txt over and leaves it uncommitted; reminded twice, it
  // does nothing: Agent Hub pushes it.
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'info' && /已自動 commit 並 push 到 feature\/k/.test(e.text)) && x;
  }, 90000, 'auto-saved');
  assert.equal(done.events.filter((e) => e.type === 'user' && e.note === 'Agent Hub 檢查：還有沒上傳到 GitHub 的工作').length, 2);
  assert.equal(gitIn(origin, 'show', 'feature/k:moved.txt'), 'hello');
  assert.match(gitIn(origin, 'log', '-1', '--format=%s', 'feature/k'), /Agent Hub auto-save/);
});

test('files attached to a Kimi message are saved on its computer through the bridge (a .zip unpacked)', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '聊天 開始', permission: 'auto' });
  await turnsOf(s.id, 1);
  const zip = execFileSync('python3', ['-c', "import io, zipfile, base64, sys; b = io.BytesIO(); z = zipfile.ZipFile(b, 'w'); z.writestr('x/y.md', 'hello zip'); z.close(); sys.stdout.write(base64.b64encode(b.getvalue()).decode())"], { encoding: 'utf8' });
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 看附件', files: [{ name: 'n.md', content: 'note' }, { name: 'p.zip', data: zip }] });
  const done = await turnsOf(s.id, 2);
  const stamps = fs.readdirSync(path.join(PROJECT, '.agent-hub', 'attachments'));
  const dir = path.join(PROJECT, '.agent-hub', 'attachments', stamps.at(-1));
  assert.equal(fs.readFileSync(path.join(dir, 'n.md'), 'utf8'), 'note');
  assert.equal(fs.readFileSync(path.join(dir, 'p', 'x', 'y.md'), 'utf8'), 'hello zip');
  const user = done.events.filter((e) => e.type === 'user').at(-1);
  assert.match(user.text, /\[附件\] 2 個已存到工作資料夾/);
  assert.doesNotMatch(user.text, /hello zip/);
});

test('messages waiting to cut in while Kimi runs a turn of its own all go in together when the next turn starts', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '背景工作 開始', permission: 'auto' });
  // Kimi's own turn (after the background command), which takes no message in.
  await until(async () => (await session(s.id)).events.some((e) => e.type === 'tool_use' && /sleep 6/.test(JSON.stringify(e.input || '')) && e.status === 'running'), 30000, 'own turn');
  for (const t of ['慢聊 一', '慢聊 二', '慢聊 三']) await api('POST', `/sessions/${s.id}/messages`, { text: t, steer: true });
  await until(async () => (await session(s.id)).meta.queue?.length === 3 && (await session(s.id)).meta.queue.every((q) => q.cutIn && !q.steered), 10000, 'waiting to cut in');
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && !(x.meta.queue || []).length && x.events.filter((e) => e.type === 'user').length === 4 && x;
  }, 40000, 'all read');
  const users = done.events.filter((e) => e.type === 'user').map((e) => [e.text, Boolean(e.steered)]);
  // The first starts the turn; the other two go into it, not turns of their own.
  assert.deepEqual(users.slice(1), [['慢聊 一', false], ['慢聊 二', true], ['慢聊 三', true]]);
  const after = done.events.slice(done.events.findIndex((e) => e.text === '慢聊 一'));
  assert.equal(after.filter((e) => e.type === 'turn_end').length, 1);
});

test('/steer: every queued message into the running turn at once', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '長工作 開始', permission: 'auto' });
  await until(async () => (await session(s.id)).events.some((e) => e.type === 'tool_use' && e.status === 'running'), 20000, 'running');
  for (const t of ['聊天 甲', '聊天 乙']) await api('POST', `/sessions/${s.id}/messages`, { text: t });
  await until(async () => (await session(s.id)).meta.queue?.length === 2, 10000, 'queued');
  assert.deepEqual(await api('POST', `/sessions/${s.id}/queue/steer-all`), { count: 2 });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.status === 'idle' && x.events.filter((e) => e.type === 'user').length === 3 && x;
  }, 30000, 'read');
  assert.deepEqual(done.events.filter((e) => e.type === 'user').slice(1).map((e) => [e.text, Boolean(e.steered)]), [['聊天 甲', true], ['聊天 乙', true]]);
  assert.equal(done.events.filter((e) => e.type === 'turn_end').length, 1);
});

test('移到背景: a foreground subagent and a foreground command go to the background, and Kimi carries on', { skip: SKIP }, async () => {
  for (const [what, running] of [['慢子代理 開始', (e) => e.type === 'tool_use' && e.parent && e.status === 'running'], ['長工作 開始', (e) => e.type === 'tool_use' && e.name === 'Bash' && e.status === 'running']]) {
    const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: what, permission: 'auto', subagent: null });
    await until(async () => (await session(s.id)).events.some(running), 30000, `${what} running`);
    await new Promise((r) => setTimeout(r, 800));
    const r = await api('POST', `/sessions/${s.id}/background`);
    assert.equal(r.moved, 1, what);
    // Kimi does not wait for it any more: the turn ends long before it would.
    await idle(s.id);
    const tasks = (await kimiApi('GET', `/sessions/${s.kimiSessionId}/tasks`)).items || [];
    assert.ok(tasks.some((t) => t.run_in_background === true || t.detached === true || t.status !== 'running'), JSON.stringify(tasks));
  }
});

test('移到背景 with a subagent swarm: it cannot go there, so it is stopped and the waiting message sent again', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '子代理群 開始', permission: 'auto', subagent: null });
  await until(async () => (await session(s.id)).events.some((e) => e.type === 'tool_use' && e.parent && e.status === 'running'), 30000, 'swarm running');
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 先看這個', steer: true });
  await until(async () => (await session(s.id)).meta.queue?.length === 1, 10000, 'waiting');
  const r = await api('POST', `/sessions/${s.id}/background`);
  assert.equal(r.moved, 0);
  assert.equal(r.swarm.description, '測試群');
  assert.equal(r.swarm.waiting, 1);
  const n0 = seen.length;
  const x = await api('POST', `/sessions/${s.id}/background`, { interruptSwarm: true });
  assert.deepEqual(x, { interrupted: true, sent: 1 });
  const done = await until(async () => {
    const y = await session(s.id);
    return y.status === 'idle' && y.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 先看這個')) && y;
  }, 30000, 'read');
  // Once: not also run by Kimi on its own after the stop.
  await new Promise((r) => setTimeout(r, 2000));
  const users = (await session(s.id)).events.filter((e) => e.type === 'user' && e.text === '聊天 先看這個');
  assert.equal(users.length, 1, JSON.stringify(users));
  assert.equal(users[0].note, '中斷子代理群後送出');
  assert.ok(done.events.some((e) => e.type === 'info' && /已中斷子代理群「測試群」/.test(e.text)));
  // Kimi is told it can resume them.
  assert.match(JSON.stringify(seen.slice(n0).map((j) => j.messages.at(-1))), /resume_agent_ids/);
});

test('stopping Kimi: a message it took in but had not read yet is read right after', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, cwd: PROJECT, prompt: '子代理群 開始', permission: 'auto', subagent: null });
  await until(async () => (await session(s.id)).events.some((e) => e.type === 'tool_use' && e.parent && e.status === 'running'), 30000, 'swarm running');
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 停下前送的', steer: true });
  await until(async () => (await session(s.id)).meta.queue?.[0]?.steered, 10000, 'taken in');
  await api('POST', `/sessions/${s.id}/interrupt`);
  const done = await until(async () => {
    const y = await session(s.id);
    return y.status === 'idle' && y.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 停下前送的')) && y;
  }, 30000, 'read after the stop');
  assert.equal(done.events.filter((e) => e.type === 'user' && e.text === '聊天 停下前送的').length, 1);
});

test('a conversation a terminal Kimi hands over with /web is the hub\'s, even with another terminal Kimi in its folder', { skip: SKIP_TTY }, async () => {
  const dir = path.join(TMP, 'webproj');
  fs.mkdirSync(dir, { recursive: true });
  const start = async () => {
    const t = terminalKimi([KIMI, '--auto'], dir);
    await new Promise((r) => setTimeout(r, 4000));
    t.type(''); // accept "Trust this folder?" if Kimi asks
    await new Promise((r) => setTimeout(r, 1000));
    return t;
  };
  // One terminal Kimi sits in the folder; another one there starts a conversation.
  const other = await start();
  const a = await start();
  const servers = () => new Set(fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances')).map((f) => JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8')).pid));
  const before = servers();
  try {
    a.type('聊天 交給中控台');
    const k = await listed((x) => x.title === '聊天 交給中控台' && x.owner === 'tui', 'terminal conversation');
    await new Promise((r) => setTimeout(r, 1500));
    a.type('/web');
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    await until(async () => (await session(s.id)).meta.owner !== 'tui', 20000, 'handed over, not locked by the other terminal Kimi');
    await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 從中控台接手' });
    await until(async () => (await session(s.id)).events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 從中控台接手')), 30000, 'answered from the hub');
    // The other terminal Kimi's own conversation is still its own.
    other.type('聊天 另一個終端機');
    await listed((x) => x.title === '聊天 另一個終端機' && x.owner === 'tui' && !x.guess, 'the other terminal conversation');
    await new Promise((r) => setTimeout(r, 3000));
    assert.notEqual((await session(s.id)).meta.owner, 'tui');
  } finally {
    other.stop();
    a.stop();
    for (const pid of servers()) if (!before.has(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

test('when the Kimi server goes away, the bridge starts a new one on the next message', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { machineId, prompt: '聊天 伺服器在', permission: 'auto' });
  await idle(s.id);
  kimiWeb.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 5000)); // the bridge notices it is gone
  await api('POST', `/sessions/${s.id}/messages`, { text: '聊天 伺服器重開' });
  await until(async () => (await session(s.id)).events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 伺服器重開')), 40000, 'answered by a new Kimi server');
});
