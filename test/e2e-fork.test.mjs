// /fork on a Kimi and on a DeepSeek conversation, end to end with the REAL Kimi
// Code CLI (its real `:fork`, its real journal) behind a real Hub and a real
// bridge. Kimi talks to a local fake OpenAI-compatible model, so no account and
// no network are needed. Skipped (out loud) unless a kimi CLI is available:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi node --test test/e2e-fork.test.mjs
//
// What it settles (the Hub's side of fork was untested before):
//  - the fork is a NEW Hub conversation with the same history, folder and
//    provider, listed in the sidebar and leaving the source untouched;
//  - a DeepSeek conversation forks into a DeepSeek one (badge, mode, model,
//    effort, subagent choice), and its next turn really goes to the gateway;
//  - forking while a turn runs, twice in a row, and from a chain's leaf.
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
const { KIMI, SKIP } = kimiGate('e2e-fork');

let PYTHON = null;
try {
  execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
  PYTHON = 'python3';
} catch {}
const SKIP_TTY = SKIP || (PYTHON && process.platform !== 'win32' ? false : 'python3 (pty) not available');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-fork-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 22000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 24000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const DS = 'agent-hub-deepseek';
const procs = [];
let fake;
const seen = []; // { url, body }: every chat request the fake model got
let kimiToken;
let machineId;
let kimiWeb;

// A scripted model: the newest user message decides. 很慢 streams for a few
// seconds (a turn that is still running when the fork is asked for); anything
// else answers at once with what it was told.
function startFakeModel() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      seen.push({ url: req.url, body: j });
      const users = (j.messages || [])
        .filter((m) => m.role === 'user')
        .map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
        .filter(Boolean);
      const lastUser = users.at(-1) || '';
      const chunks = lastUser.includes('很慢')
        ? [{ delta: { role: 'assistant', content: `慢慢收到：${lastUser}` } }, ...Array.from({ length: 10 }, () => ({ delta: { content: '。' } })), { delta: {}, finish_reason: 'stop' }]
        : [{ delta: { role: 'assistant', content: `收到：${lastUser}` } }, { delta: {}, finish_reason: 'stop' }];
      const gap = lastUser.includes('很慢') ? 500 : 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) return res.end('data: [DONE]\n\n');
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunks[i++] }] })}\n\n`);
        setTimeout(tick, gap);
      };
      tick();
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', r));
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
const listed = (pred, what) => until(async () => (await api('GET', '/machines')).find((m) => m.id === machineId).sessions.find(pred), 20000, what);

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
const idle = (sid) => until(async () => (await session(sid)).status === 'idle' && session(sid), 20000, 'idle');
const texts = (s) => s.events.filter((e) => e.type === 'text' || e.type === 'user').map((e) => `${e.type}:${e.text}`);
const wsEvents = [];

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
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-fork-test' });
  // What a browser tab would hear: the sidebar learns of a conversation from
  // these broadcasts.
  const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/ws?token=${TOKEN}`);
  ws.on('message', (d) => {
    try {
      wsEvents.push(JSON.parse(d));
    } catch {}
  });
  await new Promise((r) => ws.on('open', r));
  procs.push({ kill: () => ws.close() });
});

after(() => {
  for (const p of procs) p.kill('SIGTERM');
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

// The model requests the fake gateway got, from index `n` on: { url, model, effort, said }.
// Kimi's own model is served under /v1, the DeepSeek gateway under /opencode-go.
const requestsSince = (n) => seen.slice(n).map((x) => ({ url: x.url, model: x.body.model, effort: x.body.reasoning_effort, text: JSON.stringify(x.body.messages) }));
const broadcastsOf = (id) => wsEvents.filter((e) => e.t === 'session' && e.session.id === id).map((e) => e.session);

test('Kimi: a fork is a new Hub conversation with the real history, folder and title, listed and announced; the source is left alone', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 第一句', permission: 'auto', subagent: null });
  const src = await idle(s.id);
  const sourceBefore = JSON.stringify(texts(src));
  const listBefore = (await api('GET', '/sessions')).map((x) => x.id);

  const r = await api('POST', `/sessions/${src.id}/command`, { name: 'fork', args: '我的分支' });
  const f = r.session;
  assert.notEqual(f.id, src.id);
  assert.notEqual(f.kimiSessionId, src.kimiSessionId, 'its own native conversation');
  assert.equal(f.title, '我的分支');
  assert.equal(f.cwd, src.cwd);
  assert.equal(f.provider, 'kimi');
  assert.equal(f.origin, 'hub');
  assert.equal(f.model, 'fake/fake-1');
  assert.equal(f.modelDrift, null);
  assert.equal((await kimiApi('GET', `/sessions/${f.kimiSessionId}`)).title, '我的分支', 'Kimi has it under that title');

  const full = await idle(f.id);
  assert.deepEqual(texts(full), texts(src), 'the history Kimi copied is shown');
  const added = (await api('GET', '/sessions')).map((x) => x.id).filter((id) => !listBefore.includes(id));
  assert.deepEqual(added, [f.id], 'one new conversation in the sidebar');
  assert.ok(broadcastsOf(f.id).length > 0, 'and the browsers were told');
  assert.equal(JSON.stringify(texts(await session(src.id))), sourceBefore, 'the source did not change');

  // The fork continues from the copied history, on its own; the source never hears of it.
  const n = seen.length;
  await api('POST', `/sessions/${f.id}/messages`, { text: '聊天 分支第二句' });
  const talked = await until(async () => {
    const x = await session(f.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 分支第二句')) && x;
  }, 30000, 'the fork to answer');
  assert.ok(talked.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 第一句')), 'the earlier turn is still there');
  const asked = requestsSince(n);
  assert.equal(asked.length, 1);
  assert.match(asked[0].text, /聊天 第一句/, 'the model was given the copied history');
  assert.equal(asked[0].url.startsWith('/v1/'), true, 'on Kimi\'s own model');
  assert.ok(!texts(await session(src.id)).some((t) => t.includes('分支第二句')), 'the source did not get the fork\'s message');
});

test('Kimi: no title given, Kimi names the fork "Fork: <title>"', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 沒有標題', permission: 'auto', subagent: null });
  await idle(s.id);
  const { session: f } = await api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: '' });
  assert.equal(f.title, 'Fork: 聊天 沒有標題');
});

test('DeepSeek: a fork is a DeepSeek conversation: badge, model, effort, marker, subagent, announced as such, and its next turn goes to the gateway', { skip: SKIP }, async () => {
  const alias = `${DS}/deepseek-v4.1-flash`;
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 DS第一句', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  const src = await idle(s.id);
  assert.equal(src.provider, 'deepseek');

  const { session: f } = await api('POST', `/sessions/${src.id}/command`, { name: 'fork', args: 'DS分支' });
  assert.equal(f.provider, 'deepseek', 'the badge');
  assert.equal(f.mode, 'deepseek');
  assert.equal(f.modelConfig.provider, 'deepseek');
  assert.equal(f.model, alias);
  assert.equal(f.effort, 'max');
  assert.deepEqual(f.subagent, src.meta.subagent, 'the subagent choice of the source');
  assert.equal(f.modelDrift, null, 'no provider drift on a model that is right');
  assert.deepEqual([...new Set(broadcastsOf(f.id).map((x) => x.provider))], ['deepseek'], 'never announced to the sidebar as anything else');
  const full = await idle(f.id);
  assert.deepEqual(texts(full), texts(src), 'the history Kimi copied is shown');
  const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'sessions', `${f.id}.json`), 'utf8'));
  assert.equal(disk.provider, 'deepseek');
  assert.equal(disk.state.deepseek.model, alias);

  // Its next turn is allowed, and really runs on the DeepSeek gateway at max.
  const n = seen.length;
  await api('POST', `/sessions/${f.id}/messages`, { text: '聊天 DS分支第二句' });
  const talked = await until(async () => {
    const x = await session(f.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'text' && e.text.includes('收到：聊天 DS分支第二句')) && x;
  }, 30000, 'the DeepSeek fork to answer');
  const asked = requestsSince(n);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, '/opencode-go/chat/completions', 'the gateway, not Kimi\'s own model');
  assert.equal(asked[0].model, 'deepseek-v4.1-flash');
  assert.equal(asked[0].effort, 'max');
  assert.match(asked[0].text, /聊天 DS第一句/, 'with the copied history');
  assert.equal(talked.provider, 'deepseek');
  assert.ok(!texts(await session(src.id)).some((t) => t.includes('DS分支第二句')), 'the source did not get the fork\'s message');
});

test('a conversation that is working cannot be forked: refused with a reason, nothing made, the source finishes undisturbed', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 先有歷史', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await idle(s.id);
  await api('POST', `/sessions/${s.id}/messages`, { text: '很慢 的一輪' });
  await until(async () => (await session(s.id)).status === 'running', 10000, 'running');
  const listBefore = (await api('GET', '/sessions')).length;
  await assert.rejects(api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: '' }), (e) => e.status === 400 && /忙碌/.test(e.message));
  assert.equal((await api('GET', '/sessions')).length, listBefore, 'no half-made conversation');
  const done = await idle(s.id);
  assert.ok(done.events.some((e) => e.type === 'text' && e.text.includes('慢慢收到：很慢 的一輪')), 'the running turn was not disturbed');
});

test('forking twice at once makes two separate conversations bound to their own native ones', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 連按兩次', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await idle(s.id);
  const [x, y] = await Promise.all([api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: 'A' }), api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: 'B' })]);
  assert.notEqual(x.session.id, y.session.id);
  assert.notEqual(x.session.kimiSessionId, y.session.kimiSessionId);
  assert.deepEqual([x.session.provider, y.session.provider], ['deepseek', 'deepseek']);
  assert.deepEqual([x.session.title, y.session.title].sort(), ['A', 'B']);
  const bound = (await api('GET', '/sessions')).map((v) => v.kimiSessionId).filter(Boolean);
  assert.equal(new Set(bound).size, bound.length, 'no native conversation is bound to two nodes');
});

test('a conversation open in a terminal Kimi that the Hub does not control forks over the API like any other', { skip: SKIP_TTY }, async () => {
  const tty = terminalKimi([KIMI, '--auto']);
  let sid = null;
  try {
    await new Promise((r) => setTimeout(r, 4000));
    tty.type(''); // accept "Trust this folder?" if Kimi asks
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 終端機裡的');
    const k = await listed((x) => x.title === '聊天 終端機裡的' && x.owner === 'tui', 'terminal conversation');
    assert.equal(k.controllable, false, 'the premise: the Hub cannot type into this terminal');
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    sid = s.id;
    await idle(s.id);
    const { session: f } = await api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: '' });
    assert.equal(f.title, 'Fork: 聊天 終端機裡的');
    assert.notEqual(f.kimiSessionId, k.id);
    assert.ok(texts(await session(f.id)).some((t) => t.includes('收到：聊天 終端機裡的')), 'the history is there');
  } finally {
    if (sid) await api('POST', `/sessions/${sid}/unlock`).catch(() => {});
    tty.stop();
  }
});
