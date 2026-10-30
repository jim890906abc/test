// 完全清除 (full purge) of a cluster with the REAL Kimi Code CLI behind a real
// Hub and a real bridge (its real sh.run, real `:delete` allowance, real
// trash.info, real tar). Kimi talks to a local scripted model, so no account and
// no network are needed. Skipped (out loud) unless a kimi CLI is available, and it
// must run inside a network namespace with Kimi's home a scratch folder (never the
// real ~/.kimi-code):
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-cluster-purge.test.mjs'
//
// What the fake machine of test/cluster-purge.test.mjs can only imitate, settled
// here with Kimi itself:
//  - `POST /sessions/<id>:delete` really removes the conversation's folder
//    (a subagent's journal is inside it, so it goes with it), its index entry, and
//    the conversation answers 40401 afterwards - for an idle one;
//  - the backup the purge made holds those folders as they were (subagent journal
//    included) before they were deleted, read back by the system's tar;
//  - the main conversation and a conversation of its own are still there, whole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-cluster-purge');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-epurge-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const STATE_DIR = path.join(TMP, 'bridge-state');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 26000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-token';
const procs = [];
let fake;
let kimiToken;
let machineId;

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

// A scripted model that, for a worker whose task says SPAWN_SUB, calls the Agent
// tool once (so the conversation has a subagent journal of its own) and then answers.
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
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs.filter((m) => m.role === 'user').map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const lastUser = users.at(-1) || '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (chunks) => {
        for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      if (last.role !== 'tool' && lastUser.includes('SPAWN_SUB') && !lastUser.startsWith('SUBTASK_E2E')) {
        return send([{ delta: { role: 'assistant', content: '好。' } }, { delta: { tool_calls: [{ index: 0, id: 'call_sub', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'sub', prompt: 'SUBTASK_E2E 做一件小事' }) } }] } }, { delta: {}, finish_reason: 'tool_calls' }]);
      }
      send([{ delta: { role: 'assistant', content: `收到：${lastUser.split('\n')[0].slice(0, 60)}` } }, { delta: {}, finish_reason: 'stop' }]);
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
  return r.json();
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
// Kimi keeps a conversation in sessions/<project>/<id>/.
const dirOf = (kid) => {
  const root = path.join(KIMI_HOME, 'sessions');
  for (const ws of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const d = path.join(root, ws, kid);
    if (fs.existsSync(d)) return d;
  }
  return null;
};
const tarList = (file) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);

before(async () => {
  if (SKIP) return;
  assert.ok(KIMI_HOME.startsWith(os.tmpdir()), 'Kimi\'s home is a scratch folder, never the real one');
  for (const d of [HOME, PROJECT, STATE_DIR]) fs.mkdirSync(d, { recursive: true });
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
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI, '--state-dir', STATE_DIR, '--kimi-home', KIMI_HOME], { KIMI_CODE_HOME: KIMI_HOME, ...GIT_ENV, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
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

test('real Kimi: a purge deletes the workers\' conversations - folder, subagent journal inside it, index entry - and the backup holds them as they were; the main conversation and another conversation are untouched', { skip: SKIP }, async () => {
  assert.match((await api('GET', '/machines')).find((x) => x.id === machineId).capabilities.join(','), /kimi_delete/, 'the real connector says it can');
  const parent = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 主對話先說一句背景', permission: 'yolo', subagent: null });
  const bystander = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 旁邊的對話', permission: 'yolo', subagent: null });
  await idle(parent.id);
  await idle(bystander.id);
  const parentKid = (await session(parent.id)).kimiSessionId;
  const bystanderKid = (await session(bystander.id)).kimiSessionId;

  const { cluster: c } = await api('POST', `/sessions/${parent.id}/cluster`, {
    tasks: [{ title: '改甲', prompt: 'SPAWN_SUB 請改甲（開一個子代理）' }, { title: '改乙', prompt: 'TASK_BETA 請改乙' }],
    name: '真 Kimi 清除',
  });
  assert.equal(c.name, '真 Kimi 清除');
  await until(async () => {
    const x = await api('GET', `/clusters/${c.id}`);
    return x.status === 'done' && x.workers.every((w) => w.finishedAt);
  }, 60000, 'both workers done');
  const workers = await Promise.all(c.workers.map((w) => session(w.sessionId)));
  const kids = workers.map((w) => w.kimiSessionId);
  const dirs = kids.map(dirOf);
  assert.ok(dirs.every(Boolean), 'the premise: Kimi keeps both conversations on disk');
  // The first worker really has a subagent: its journal is a folder inside the conversation's folder.
  const agents = (d) => fs.readdirSync(path.join(d, 'agents'));
  assert.ok(agents(dirs[0]).length >= 2, `a subagent journal beside main (got ${agents(dirs[0]).join(',')})`);
  assert.deepEqual(agents(dirs[1]), ['main']);
  fs.writeFileSync(path.join(c.workers[0].worktree, 'dirty.txt'), 'uncommitted\n');
  const parentEventsBefore = (await session(parent.id)).events;

  const p = await api('GET', `/clusters/${c.id}/purge/plan`);
  assert.equal(p.connector.canDeleteKimi, true);
  assert.equal(p.connector.trashDir, path.join(STATE_DIR, 'trash'), 'the real connector\'s trash');
  assert.equal(p.totals.kimiSessions, 2);
  assert.ok(p.workers[0].conversation.kimiSubagents >= 1, 'the plan counts the subagent');

  const out = await api('POST', `/clusters/${c.id}/purge`, { discardDirty: true, deleteUnmerged: true });
  assert.equal(out.aborted, false, out.reason);
  assert.equal(out.removed, true);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.workers.map((w) => w.conversation), ['deleted', 'deleted']);

  // Kimi itself: the folders (and the subagent journal in them) are gone, and the conversations do not exist any more.
  for (const [i, kid] of kids.entries()) {
    assert.equal(dirOf(kid), null, `folder ${i} gone`);
    assert.equal(fs.existsSync(dirs[i]), false);
    const r = await kimiApi('GET', `/sessions/${kid}`);
    assert.equal(r.code, 40401, 'Kimi no longer knows it');
    const again = await kimiApi('POST', `/sessions/${kid}:delete`, {});
    assert.equal(again.code, 40401, 'a second :delete is "not found", which the Hub counts as done');
  }
  const listed = (await kimiApi('GET', '/sessions')).data.items.map((s) => s.id);
  assert.ok(!kids.some((k) => listed.includes(k)), 'not in Kimi\'s list');
  assert.ok(listed.includes(parentKid) && listed.includes(bystanderKid));
  assert.ok(fs.existsSync(dirOf(parentKid)) && fs.existsSync(dirOf(bystanderKid)), 'the main conversation\'s and the other one\'s folders are whole');
  // The index says deleted (Kimi's own journal of it).
  const index = fs.readFileSync(path.join(KIMI_HOME, 'session_index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const kid of kids) assert.ok(index.some((e) => e.sessionId === kid && e.deleted === true), `${kid} is marked deleted in Kimi's index`);

  // The backup, made before, holds them as they were - the subagent's journal too.
  const file = out.backup.machine.path;
  assert.equal(path.dirname(file), path.join(STATE_DIR, 'trash'));
  const list = tarList(file);
  for (const [i, d] of dirs.entries()) {
    const rel = path.relative('/', d);
    assert.ok(list.includes(`${rel}/agents/main/wire.jsonl`), `${i}: main journal`);
  }
  assert.ok(list.some((e) => e.startsWith(`${path.relative('/', dirs[0])}/agents/`) && !e.includes('/agents/main/') && e.endsWith('wire.jsonl')), 'the subagent\'s journal is in the backup');
  assert.ok(list.includes('extras/w1-uncommitted.patch'), 'the discarded worktree\'s uncommitted work is in it');
  assert.ok(!fs.existsSync(c.workers[0].worktree) && !fs.existsSync(c.workers[1].worktree));
  assert.equal(git(PROJECT, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(PROJECT, 'status', '--porcelain'), '');

  // The main conversation and the other: as they were.
  assert.deepEqual((await session(parent.id)).events, parentEventsBefore);
  assert.equal((await session(bystander.id)).status, 'idle');
  assert.ok((await session(parent.id)).kimiSessionId);
  await assert.rejects(api('GET', `/clusters/${c.id}`), (e) => e.status === 404);
});
