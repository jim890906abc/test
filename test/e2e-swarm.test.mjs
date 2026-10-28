// Swarm mode from the Hub, end to end with the REAL Kimi Code CLI (its real
// profile endpoint, status, journal and AgentSwarm tool) behind a real Hub and
// a real bridge. Kimi talks to a local scripted model, so no account and no
// network are needed. Skipped (out loud) unless a kimi CLI is available:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-swarm.test.mjs'
//
// What it settles (the Hub's side was a guess from Kimi's strings before):
//  - turning swarm mode on/off from the Hub changes what Kimi itself reports
//    (its session status), writes its journal, and changes what the model is
//    told;
//  - the symptom this exists for: the main model's AgentSwarm call is refused
//    with "Swarm mode is off" until the person turns it on, and runs after;
//  - Kimi changing it by itself shows in the Hub;
//  - in a terminal the Hub controls, the Hub sends Kimi's /swarm, and in "ask
//    every time" it answers Kimi's picker with the choice that keeps the
//    person's permission (the picker's default does not).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-swarm');

let PYTHON = null;
try {
  execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
  PYTHON = 'python3';
} catch {}
const SKIP_TTY = SKIP || (PYTHON && process.platform !== 'win32' ? false : 'python3 (pty) not available');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-swarm-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 22000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 24000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const DS = 'agent-hub-deepseek';
const procs = [];
let fake;
const seen = []; // { url, body }: every chat request the scripted model got
let kimiToken;
let machineId;

// A scripted model. "子代理群" → an AgentSwarm call (each subagent just
// answers); a tool result is repeated back; anything else answers with what it
// was told.
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
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs
        .filter((m) => m.role === 'user')
        .map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
        .filter(Boolean);
      const lastUser = users.at(-1) || '';
      const send = (chunks) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      const text = (t) => [{ delta: { role: 'assistant', content: t } }, { delta: {}, finish_reason: 'stop' }];
      const call = (pre, name, args) => [
        { delta: { role: 'assistant', content: pre } },
        { delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ];
      if (users.some((u) => u.includes('SUBAGENT_TASK'))) return send(text('子代理做完了。'));
      if (lastUser.includes('子代理群') && last.role !== 'tool') return send(call('開一群子代理。', 'AgentSwarm', { description: '測試群', prompt_template: 'SUBAGENT_TASK {{item}}', items: ['甲', '乙'] }));
      if (last.role === 'tool') return send(text(`工具結果：${String(last.content).slice(0, 200)}`));
      return send(text(`收到：${lastUser}`));
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

// What Kimi wrote to a conversation's journal (sessions/<workspace>/<id>/agents/main/wire.jsonl).
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
const swarmRecords = (kid) => journalRecords(kid).filter((r) => /^swarm_mode\./.test(r.type)).map((r) => ({ type: r.type, trigger: r.trigger }));
const journalPermission = (kid) => journalRecords(kid).filter((r) => r.type === 'permission.set_mode').at(-1)?.mode ?? null;

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
const config = (sid, body) => api('POST', `/sessions/${sid}/config`, body);
const nativeSwarm = async (kid) => (await kimiApi('GET', `/sessions/${kid}/status`)).swarm_mode;
const listed = (pred, what) => until(async () => (await api('GET', '/machines')).find((m) => m.id === machineId).sessions.find(pred), 20000, what);
// Say something and wait for the answer; returns what the scripted model was
// sent for it (the requests since).
async function say(sid, text) {
  const n = seen.length;
  await api('POST', `/sessions/${sid}/messages`, { text });
  await until(async () => {
    const s = await session(sid);
    return s.status === 'idle' && s.events.some((e) => e.type === 'user' && e.text === text) && s.events.some((e) => e.type === 'turn_end') && s.events.at(-1).type !== 'user';
  }, 40000, `the answer to "${text}"`);
  return seen.slice(n).map((x) => JSON.stringify(x.body.messages));
}

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-swarm-test' });
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

test('Kimi: swarm on/off from the Hub is what Kimi itself reports, writes in its journal, and tells the model', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 開始', permission: 'auto', subagent: null });
  await idle(s.id);
  const kid = s.kimiSessionId;
  assert.equal(await nativeSwarm(kid), false, 'the premise: a new conversation has it off');
  assert.ok(!(await session(s.id)).meta.swarmMode);

  const on = await config(s.id, { swarmMode: true });
  assert.equal(on.meta.swarmMode, true);
  assert.equal(await nativeSwarm(kid), true, 'Kimi says it is on');
  await until(async () => swarmRecords(kid).length > 0, 10000, 'the journal');
  assert.deepEqual(swarmRecords(kid), [{ type: 'swarm_mode.enter', trigger: 'manual' }], 'entered by the person ("manual"), not by a tool call');
  const told = await say(s.id, '聊天 swarm 開著');
  assert.ok(told.some((m) => /agent swarm/.test(m)), 'the model is told it is in swarm mode');

  const off = await config(s.id, { swarmMode: false });
  assert.equal(off.meta.swarmMode, false);
  assert.equal(await nativeSwarm(kid), false, 'Kimi says it is off');
  await until(async () => swarmRecords(kid).length === 2, 10000, 'the journal');
  assert.deepEqual(swarmRecords(kid).map((r) => r.type), ['swarm_mode.enter', 'swarm_mode.exit']);
  const toldOff = await say(s.id, '聊天 swarm 關了');
  assert.ok(toldOff.some((m) => /Swarm Mode Ended/.test(m)), 'and told when it ends');
  assert.equal((await session(s.id)).meta.swarmMode, false);
});

test('the symptom: AgentSwarm is refused while swarm mode is off, and runs once the Hub turned it on', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 先聊', permission: 'auto', subagent: null });
  await idle(s.id);
  const cards = (x) => x.events.filter((e) => e.type === 'tool_use' && e.name === 'AgentSwarm');
  const refused = await say(s.id, '請開子代理群');
  assert.ok(refused.some((m) => /Swarm mode is off, so AgentSwarm did not run/.test(m)), 'refused: this is what the person saw');
  assert.equal(cards(await session(s.id)).length, 1);
  assert.match(JSON.stringify(cards(await session(s.id))[0]), /Swarm mode is off/);
  assert.ok(!seen.some((x) => JSON.stringify(x.body.messages).includes('SUBAGENT_TASK 甲')), 'no subagent was started');

  await config(s.id, { swarmMode: true });
  await say(s.id, '再請開子代理群');
  const [first, second] = cards(await session(s.id));
  assert.match(JSON.stringify(first), /Swarm mode is off/);
  assert.doesNotMatch(JSON.stringify(second), /Swarm mode is off/, 'the second AgentSwarm call was not refused');
  assert.ok(seen.some((x) => JSON.stringify(x.body.messages).includes('SUBAGENT_TASK 甲')), 'its subagents really started');
});

test('Kimi changes swarm mode by itself (another client): the conversation follows, both ways', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 外面改', permission: 'auto', subagent: null });
  await idle(s.id);
  await kimiApi('POST', `/sessions/${s.kimiSessionId}/profile`, { agent_config: { swarm_mode: true } });
  await until(async () => (await session(s.id)).meta.swarmMode === true, 10000, 'on, as Kimi says');
  await kimiApi('POST', `/sessions/${s.kimiSessionId}/profile`, { agent_config: { swarm_mode: false } });
  await until(async () => (await session(s.id)).meta.swarmMode === false, 10000, 'off, as Kimi says');
});

test('DeepSeek: its swarm mode is the same Kimi\'s', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天 DS', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await idle(s.id);
  assert.equal(s.provider, 'deepseek');
  const on = await config(s.id, { swarmMode: true });
  assert.equal(on.meta.swarmMode, true);
  assert.equal(on.provider, 'deepseek');
  assert.equal(await nativeSwarm(s.kimiSessionId), true);
  await config(s.id, { swarmMode: false });
  assert.equal(await nativeSwarm(s.kimiSessionId), false);
});

test('a terminal the Hub controls, in "ask every time": Kimi\'s picker would switch approvals off on Enter; the Hub keeps the permission', { skip: SKIP_TTY }, async () => {
  // The premise, with a terminal nobody but the test drives: /swarm on opens
  // a picker, and its default choice ("Switch to Never Ask and start") turns
  // approvals off. If this ever stops being true, the Hub's down-down is stale.
  const probe = terminalKimi([process.execPath, path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'kimi']);
  try {
    await new Promise((r) => setTimeout(r, 5000));
    probe.type(''); // accept "Trust this folder?" if Kimi asks
    await new Promise((r) => setTimeout(r, 1000));
    probe.type('聊天 探針');
    const k = await listed((x) => x.title === '聊天 探針' && x.owner === 'tui' && x.controllable, 'controllable terminal conversation');
    await until(async () => journalRecords(k.id).some((r) => r.type === 'turn.ended'), 20000, 'the first turn in the journal');
    assert.ok(journalPermission(k.id) !== 'auto', 'the premise: approvals are not off');
    probe.type('/swarm on');
    await new Promise((r) => setTimeout(r, 1500));
    probe.type(''); // Enter on the picker's default
    await until(async () => journalPermission(k.id) === 'auto', 10000, 'the picker\'s default to switch to Never Ask');
    assert.deepEqual(swarmRecords(k.id).map((r) => r.type), ['swarm_mode.enter']);
  } finally {
    probe.stop();
  }

  // The Hub's way: the same command, the third choice.
  const tty = terminalKimi([process.execPath, path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'kimi']);
  try {
    await new Promise((r) => setTimeout(r, 5000));
    tty.type('');
    await new Promise((r) => setTimeout(r, 1000));
    tty.type('聊天 受控終端');
    const k = await listed((x) => x.title === '聊天 受控終端' && x.owner === 'tui' && x.controllable, 'controllable terminal conversation');
    const s = await api('POST', `/machines/${machineId}/kimi/${k.id}/attach`);
    await until(async () => journalRecords(k.id).some((r) => r.type === 'turn.ended'), 20000, 'the first turn in the journal');
    await until(async () => (await session(s.id)).meta.permission === 'manual', 15000, 'the Hub to know the permission');
    const before = journalPermission(k.id);

    const on = await config(s.id, { swarmMode: true });
    assert.equal(on.meta.swarmMode, true);
    await until(async () => swarmRecords(k.id).length === 1, 15000, 'Kimi to enter swarm mode');
    assert.deepEqual(swarmRecords(k.id), [{ type: 'swarm_mode.enter', trigger: 'manual' }]);
    assert.equal(journalPermission(k.id), before, 'Kimi\'s permission did not change');
    assert.equal((await session(s.id)).meta.permission, 'manual');

    await config(s.id, { swarmMode: false });
    await until(async () => swarmRecords(k.id).length === 2, 15000, 'Kimi to leave swarm mode');
    assert.deepEqual(swarmRecords(k.id).map((r) => r.type), ['swarm_mode.enter', 'swarm_mode.exit']);
    assert.equal(journalPermission(k.id), before);
    await until(async () => (await session(s.id)).meta.swarmMode === false, 10000, 'the conversation to say off');

    // The person types /swarm in the terminal itself: the Hub follows what
    // Kimi's journal says, which it can only learn from the bridge.
    tty.type('/swarm on');
    await new Promise((r) => setTimeout(r, 1500));
    tty.type(''); // Enter on the picker (its default turns approvals off: the person's choice)
    await until(async () => swarmRecords(k.id).length === 3, 15000, 'Kimi to enter swarm mode again');
    await until(async () => (await session(s.id)).meta.swarmMode === true, 10000, 'the conversation to follow the terminal');
  } finally {
    tty.stop();
  }
});
