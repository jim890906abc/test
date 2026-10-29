// 叢集 (cluster) end to end with the REAL Kimi Code CLI behind a real Hub and
// a real bridge (its real sh.run, which the cluster uses for git and for the
// memory file). Kimi talks to a local scripted model, so no account and no
// network are needed. Skipped (out loud) unless a kimi CLI is available:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-cluster.test.mjs'
//
// What the fake machine of test/cluster.test.mjs can only guess, settled here:
//  - a worker really is a Kimi conversation whose folder is its worktree, with
//    swarm mode really on (Kimi's own status says so);
//  - the first thing the model of a worker is sent is the brief, and what was
//    added to the memory file reaches the model of a worker in front of its
//    next message, as a system reminder, once;
//  - the git and shell work goes through the real bridge, and the merge of the
//    workers' branches works from there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-cluster');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ecluster-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 26000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const procs = [];
let fake;
const seen = []; // every chat request the scripted model got
let kimiToken;
let machineId;

// No identity and no global config for any git in this test.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

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
      const lastUser =
        (j.messages || [])
          .filter((m) => m.role === 'user')
          .map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
          .filter(Boolean)
          .at(-1) || '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = `收到：${lastUser.split('\n')[0].slice(0, 60)}`;
      for (const c of [{ delta: { role: 'assistant', content: text } }, { delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
      res.end('data: [DONE]\n\n');
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
  try {
    kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  } catch {}
  const r = await fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return (await r.json()).data;
};
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
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
const idle = (sid) => until(async () => (await session(sid)).status === 'idle' && session(sid), 30000, 'idle');
const nativeSwarm = async (kid) => (await kimiApi('GET', `/sessions/${kid}/status`)).swarm_mode;
// The text of every message the model was sent, one string per request.
const sentSince = (n) => seen.slice(n).map((x) => JSON.stringify(x.body.messages));

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  git(PROJECT, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(PROJECT, 'a.txt'), 'one\ntwo\n');
  git(PROJECT, 'add', '-A');
  git(PROJECT, 'commit', '-q', '-m', 'first');
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, ...GIT_ENV, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-cluster-test' });
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

test('real Kimi: a cluster of two workers - worktree folders, swarm mode on in Kimi itself, the brief is what the model gets first, the memory reaches the model once, the branches merge', { skip: SKIP }, async () => {
  const parent = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 主對話先說一句背景', permission: 'auto', subagent: null });
  await idle(parent.id);

  const n0 = seen.length;
  const { cluster: c, warnings } = await api('POST', `/sessions/${parent.id}/cluster`, {
    tasks: [{ title: '改甲', prompt: 'TASK_ALPHA 請改甲' }, { title: '改乙', prompt: 'TASK_BETA 請改乙' }],
    note: '大家都用 NOTE_E2E 這個慣例',
  });
  assert.deepEqual(warnings, []);
  assert.equal(c.workers.length, 2);
  const real = fs.realpathSync(PROJECT);
  const base = `${path.dirname(real)}/${path.basename(real)}-cluster-${c.id}`;

  for (const [i, w] of c.workers.entries()) {
    assert.equal(w.worktree, `${base}/w${i + 1}`);
    assert.ok(fs.existsSync(path.join(w.worktree, 'a.txt')), 'a real checkout, made through the real bridge');
    const s = await session(w.sessionId);
    // Kimi itself: the conversation's folder, and swarm mode.
    const native = await kimiApi('GET', `/sessions/${s.kimiSessionId}`);
    assert.equal(fs.realpathSync(native.metadata.cwd), fs.realpathSync(w.worktree), 'Kimi runs the worker in its worktree');
    assert.equal(await nativeSwarm(s.kimiSessionId), true, 'Kimi says swarm mode is on');
    assert.equal(s.meta.swarmMode, true);
    assert.equal(native.title, w.title, 'Kimi\'s own title is the task\'s');
  }
  await until(async () => (await Promise.all(c.workers.map((w) => session(w.sessionId)))).every((s) => s.status === 'idle' && s.events.some((e) => e.type === 'turn_end')), 40000, 'both workers answered');

  // The model of each worker was sent the brief: its task, folder, the memory path and the note.
  const asked = sentSince(n0);
  for (const w of c.workers) assert.equal((await session(w.sessionId)).title, w.title, 'and it keeps that name after the first turn');
  for (const [i, w] of c.workers.entries()) {
    const mine = asked.filter((m) => m.includes(`你是叢集 ${c.id} 的工作者 w${i + 1}`));
    assert.ok(mine.length >= 1, `the model of w${i + 1} was sent its brief`);
    assert.ok(mine[0].includes(['TASK_ALPHA', 'TASK_BETA'][i]) && mine[0].includes(w.worktree) && mine[0].includes(c.memory.path) && mine[0].includes('NOTE_E2E') && mine[0].includes('主對話先說一句背景'));
    assert.ok(!mine[0].includes(['TASK_BETA', 'TASK_ALPHA'][i]) || mine[0].includes('同時進行的任務'), 'the other task only as a title in the list');
  }

  // The memory goes through the real bridge's shell: read, append, and the new part reaches the next prompt once.
  const m0 = await api('GET', `/clusters/${c.id}/memory`);
  assert.ok(m0.text.includes('改甲') && m0.bytes === Buffer.byteLength(m0.text));
  await api('POST', `/clusters/${c.id}/memory`, { text: '決定：DECISION_E2E 用 tabs' });
  const n1 = seen.length;
  await api('POST', `/sessions/${c.workers[0].sessionId}/messages`, { text: '下一句話' });
  await until(async () => (await session(c.workers[0].sessionId)).events.filter((e) => e.type === 'turn_end').length >= 2, 30000, 'the second turn');
  const told = sentSince(n1).filter((m) => m.includes('DECISION_E2E'));
  assert.ok(told.length >= 1, 'the model was sent the decision');
  assert.match(told[0], /system-reminder/);
  await api('POST', `/sessions/${c.workers[0].sessionId}/messages`, { text: '再一句話' });
  await until(async () => (await session(c.workers[0].sessionId)).events.filter((e) => e.type === 'turn_end').length >= 3, 30000, 'the third turn');
  // The reminder of the second turn stays in Kimi's own history, so the model
  // sees it again as history; what must not happen is a second reminder.
  const lastRequest = JSON.stringify(seen.at(-1).body.messages);
  assert.equal(lastRequest.split('DECISION_E2E').length - 1, 1, 'told once: one copy in the history, not two');

  // The workers' work, merged.
  fs.writeFileSync(path.join(c.workers[0].worktree, 'alpha.txt'), 'alpha\n');
  git(c.workers[0].worktree, 'add', '-A');
  git(c.workers[0].worktree, 'commit', '-q', '-m', 'alpha');
  fs.writeFileSync(path.join(c.workers[1].worktree, 'beta.txt'), 'beta\n');
  git(c.workers[1].worktree, 'add', '-A');
  git(c.workers[1].worktree, 'commit', '-q', '-m', 'beta');
  const merged = await api('POST', `/clusters/${c.id}/merge`);
  assert.deepEqual(merged.merge.results.map((r) => r.ok), [true, true]);
  assert.equal(git(PROJECT, 'show', `${merged.merge.branch}:alpha.txt`), 'alpha');
  assert.equal(git(PROJECT, 'show', `${merged.merge.branch}:beta.txt`), 'beta');
  assert.equal(git(PROJECT, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(PROJECT, 'status', '--porcelain'), '');
});

test('real Kimi: a fork cluster - Kimi\'s own :fork per worker, the history comes along, swarm mode on', { skip: SKIP }, async () => {
  const parent = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 分叉前的話 FORK_HISTORY', permission: 'auto', subagent: null });
  await idle(parent.id);
  const n0 = seen.length;
  const { cluster: c } = await api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '叉甲', prompt: 'FORK_TASK_A 做甲' }, { title: '叉乙', prompt: 'FORK_TASK_B 做乙' }], mode: 'fork' });
  assert.equal(c.mode, 'fork');
  for (const w of c.workers) {
    const s = await session(w.sessionId);
    assert.notEqual(s.kimiSessionId, parent.kimiSessionId, 'a native conversation of its own');
    assert.equal(await nativeSwarm(s.kimiSessionId), true);
    await until(async () => (await session(w.sessionId)).events.some((e) => e.type === 'turn_end' && e.ts > s.createdAt), 40000, 'the fork answered its brief');
  }
  const forked = await session(c.workers[0].sessionId);
  assert.ok(forked.events.some((e) => e.type === 'user' && /FORK_HISTORY/.test(e.text)), 'the history came with the fork');
  // The fork's model got both: the history it was forked with and the brief.
  const both = sentSince(n0).filter((m) => m.includes('FORK_HISTORY') && m.includes(`你是叢集 ${c.id} 的工作者 w1`) && m.includes('FORK_TASK_A'));
  assert.ok(both.length >= 1, 'history and brief reached the model of w1');
});
