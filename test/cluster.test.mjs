// 叢集 (cluster) through the REAL Hub (runner, kimi-remote adapter, cluster.js)
// with only the outside faked: the Kimi server of a computer (the fake machine,
// whose sh.run really runs bash on this test machine's disk, so the git
// worktrees, branches and merges below are real git in real folders), and the
// Anthropic API.
//
// What a person needs from "叢集派工": every task becomes a conversation of its
// own (with the main one's model, thinking, permission and subagent choice),
// in a git worktree of its own when it can; a memory file all of them share
// that is NOT in git and whose new parts reach each worker once; stop; a merge
// that leaves the main conversation's branch and folder alone; and a cluster
// that fails half way leaves nothing behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { startFakeMachine, DS } from './fixtures/fake-machine.mjs';

const MID = 'm_fake';
let hub;
let KIMI;
let DEEPSEEK;
let N = 0;

// A git that knows nobody: no identity, no global config. The Hub's merge must
// not depend on the person's own settings.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function makeRepo(name) {
  const dir = path.join(hub.TMP, `${name}-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newKimi = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const newDeepseek = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd, model: DEEPSEEK.model, effort: 'max', permission: 'auto', ...extra });
const cluster = (id, body) => hub.api('POST', `/sessions/${id}/cluster`, body);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const prompts = (kid) => hub.machine.prompts.filter((p) => p.sid === kid);
const textOf = (prompt) => prompt.body.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
// What the person's side of the prompt said (the Hub's own system reminders - the subagent rules, the memory - are separate blocks).
const briefOf = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('\n');
const reminders = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const tasks = (...titles) => titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` }));

async function say(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}

// Like say(), for a message the event store shows masked (a secret in it).
async function sayMasked(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user') && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to a message with a secret`);
}

const allDone = (cid) => until(async () => {
  const c = await getCluster(cid);
  return c.status === 'done' && c.workers.every((w) => w.finishedAt) && c;
}, 15000, `cluster ${cid} done`);

function watchWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws`);
  const msgs = [];
  ws.on('message', (d) => {
    try {
      msgs.push(JSON.parse(d));
    } catch {}
  });
  return { msgs, ready: new Promise((r) => ws.on('open', r)), close: () => ws.close() };
}

const rejects = async (promise, status, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected a ${status}, got success`);
  assert.equal(err.status, status, `${err.message}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
};

const worktrees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
const clusterBranches = (repo) => git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)').split('\n').filter(Boolean);
const siblings = (repo) => fs.readdirSync(path.dirname(repo)).filter((n) => n.startsWith(`${path.basename(repo)}-cluster-`));

before(async () => {
  hub = await startRealHub('cluster', { claude: true });
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  DEEPSEEK = { model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id };
});
after(() => hub?.stop());

// ------------------------------------------------------------------ brief

test('a brief cluster in a git repo: a worker per task, each in a worktree and a branch of its own, with the main conversation\'s settings, swarm on, the memory outside git', async () => {
  const repo = makeRepo('repo');
  const parent = await newKimi(repo, { permission: 'auto' });
  await say(parent.id, '先說一句背景話');
  const parentSnap = await snap(parent.id);
  assert.equal(parentSnap.meta.permission, 'auto', 'the premise');
  const ws = watchWs();
  await ws.ready;

  const r = await cluster(parent.id, { tasks: tasks('改 A', '改 B'), note: '全部人都要遵守 X 規則' });
  const c = r.cluster;
  assert.match(c.id, /^c_[0-9a-f]{12}$/);
  assert.deepEqual(r.warnings, []);
  assert.equal(c.parentId, parent.id);
  assert.equal(c.mode, 'brief', 'the default');
  assert.equal(c.isolate, true);
  assert.equal(c.swarm, true);
  assert.equal(c.workers.length, 2);

  const base = `${path.dirname(fs.realpathSync(repo))}/${path.basename(repo)}-cluster-${c.id}`;
  for (const [i, w] of c.workers.entries()) {
    const n = i + 1;
    assert.equal(w.branch, `cluster/${c.id}/w${n}`);
    assert.equal(w.worktree, `${base}/w${n}`);
    assert.ok(!w.worktree.split('/').some((seg) => seg.startsWith('.')), 'no dot folder in the path');
    assert.ok(fs.existsSync(path.join(w.worktree, 'a.txt')), 'a real checkout of the project');
    assert.equal(git(w.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), w.branch);
    assert.equal(w.title, ['改 A', '改 B'][i]);
    assert.equal(w.swarm, true);
  }
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), ...c.workers.map((w) => w.worktree)].sort());
  assert.deepEqual(clusterBranches(repo).sort(), c.workers.map((w) => w.branch).sort());

  // Each worker is a conversation of its own with the settings of the main one.
  for (const w of c.workers) {
    const s = await snap(w.sessionId);
    assert.equal(s.clusterId, c.id);
    assert.equal(s.clusterRole, 'worker');
    assert.ok(!s.parentId, 'a worker is not a sub-agent: no parentId');
    assert.equal(s.origin, 'hub');
    assert.equal(s.cwd, w.worktree);
    assert.equal(s.provider, 'kimi');
    assert.equal(s.model, parentSnap.model);
    assert.equal(s.effort, parentSnap.effort);
    assert.equal(s.meta.permission, 'auto');
    assert.equal(s.meta.swarmMode, true, 'what Kimi says');
    assert.equal(hub.machine.sessions.get(s.kimiSessionId).swarm, true, 'Kimi really has swarm mode on');
    assert.ok(hub.machine.profiles.some((p) => p.sid === s.kimiSessionId && p.title === w.title), 'Kimi was told the title too');
    assert.equal(s.title, w.title);
  }
  assert.deepEqual((await snap(parent.id)).clusterIds, [c.id]);
  assert.deepEqual((await hub.api('GET', '/sessions')).find((x) => x.id === c.workers[0].sessionId).clusterId, c.id, 'the list says so too');

  // The memory is outside every worktree and outside git.
  const memory = path.join(fs.realpathSync(repo), '.git', 'agent-hub-cluster', c.id, 'memory.md');
  assert.equal(c.memory.path, memory);
  assert.ok(fs.existsSync(memory));
  assert.ok(c.memory.bytes > 0 && typeof c.memory.updatedAt === 'number');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  for (const w of c.workers) assert.equal(git(w.worktree, 'status', '--porcelain'), '', 'nothing of the cluster to commit in a worktree');

  // The first message of a worker is its brief.
  for (const [i, w] of c.workers.entries()) {
    const sent = prompts(await kidOf(w.sessionId));
    assert.equal(sent.length, 1, 'one message to start with');
    const brief = briefOf(sent[0]);
    assert.ok(!reminders(sent[0]).some((t) => t.includes('叢集記憶')), 'the brief already says what the memory holds: no reminder repeats it');
    assert.ok(brief.includes(`請處理：${w.title}（第 ${i + 1} 項）`), 'its task');
    assert.ok(brief.includes(memory), 'the absolute path of the memory');
    assert.ok(brief.includes(w.worktree) && brief.includes(w.branch), 'its worktree and branch');
    assert.ok(brief.includes('全部人都要遵守 X 規則'), 'the note');
    for (const h of ['做了什麼', '改了哪些檔', '怎麼驗證', '未完成什麼']) assert.ok(brief.includes(h), `the report format names "${h}"`);
    assert.ok(brief.includes(c.workers[1 - i].title), 'the other tasks');
    assert.ok(brief.includes('先說一句背景話'), 'what the main conversation said');
    assert.ok(!/swarm|子代理群/i.test(brief), 'the brief does not call the cluster by the name of Kimi\'s own feature');
  }

  // Status, the list, the stream.
  const got = await getCluster(c.id);
  assert.deepEqual(Object.keys(got).sort(), ['cleanup', 'createdAt', 'id', 'isolate', 'memory', 'merge', 'mode', 'parentId', 'status', 'swarm', 'warnings', 'workers']);
  assert.deepEqual(Object.keys(got.workers[0]).sort(), ['branch', 'finishedAt', 'hidden', 'progress', 'sessionId', 'status', 'swarm', 'task', 'title', 'worktree']);
  assert.equal(got.cleanup, null, 'nothing has been cleaned up yet');
  assert.equal(got.workers[0].hidden, false);
  assert.deepEqual(Object.keys(got.memory).sort(), ['bytes', 'path', 'updatedAt']);
  assert.equal(got.merge, null);
  assert.deepEqual((await hub.api('GET', `/sessions/${parent.id}/clusters`)).map((x) => x.id), [c.id]);
  const done = await allDone(c.id);
  for (const w of done.workers) {
    assert.ok(w.progress && w.progress.length <= 160 && !w.progress.includes('\n'), `one line of progress: ${JSON.stringify(w.progress)}`);
    assert.equal(w.status, 'idle');
  }
  await until(async () => ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.status === 'done'), 5000, 'the stream says it is done');
  assert.ok(ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.workers.length === 2), 'and said so when it was made');
  ws.close();
});

test('a non-git folder: the workers share it, with the warning; the memory is in the folder; there is nothing to merge', async () => {
  const plain = path.join(hub.TMP, `plain-${++N}`);
  fs.mkdirSync(plain, { recursive: true });
  const parent = await newKimi(plain);
  const r = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  assert.deepEqual(r.warnings, ['不是 git 專案，工作者共用同一個資料夾，可能互相覆蓋']);
  assert.deepEqual(r.cluster.warnings, r.warnings);
  assert.equal(r.cluster.isolate, false, 'what is really so');
  for (const w of r.cluster.workers) {
    assert.equal(w.branch, null);
    assert.equal(w.worktree, null);
    assert.equal((await snap(w.sessionId)).cwd, plain);
  }
  const memory = path.join(plain, '.agent-hub-cluster', r.cluster.id, 'memory.md');
  assert.equal(r.cluster.memory.path, memory);
  assert.ok(fs.existsSync(memory));
  assert.equal(fs.readFileSync(path.join(plain, '.agent-hub-cluster', '.gitignore'), 'utf8'), '*\n', 'a later git init does not pick the memory up');
  const brief = briefOf(prompts(await kidOf(r.cluster.workers[0].sessionId))[0]);
  assert.ok(brief.includes('共用同一個資料夾') && brief.includes(plain));
  await rejects(hub.api('POST', `/clusters/${r.cluster.id}/merge`), 409, /獨立 worktree/);
});

test('isolate: false in a git repo: shared folder, says so, no worktree is made', async () => {
  const repo = makeRepo('shared');
  const parent = await newKimi(repo);
  const r = await cluster(parent.id, { tasks: tasks('甲'), isolate: false });
  assert.equal(r.cluster.isolate, false);
  assert.equal(r.cluster.workers[0].worktree, null);
  assert.match(r.warnings.join('\n'), /共用同一個資料夾/);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(clusterBranches(repo), []);
  // The memory is still where git does not look.
  assert.ok(fs.existsSync(path.join(fs.realpathSync(repo), '.git', 'agent-hub-cluster', r.cluster.id, 'memory.md')));
});

test('a conversation working in a folder below the project root: its workers get the same folder inside their worktrees', async () => {
  const repo = makeRepo('sub');
  fs.mkdirSync(path.join(repo, 'web', 'app'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web', 'app', 'index.js'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'app');
  const parent = await newKimi(path.join(repo, 'web', 'app'));
  const r = await cluster(parent.id, { tasks: tasks('甲') });
  const w = r.cluster.workers[0];
  assert.equal((await snap(w.sessionId)).cwd, `${w.worktree}/web/app`);
  assert.equal(w.worktree, `${path.dirname(fs.realpathSync(repo))}/${path.basename(repo)}-cluster-${r.cluster.id}/w1`, 'the worktree itself is the project\'s root');
  assert.ok(fs.existsSync(path.join(w.worktree, 'web', 'app', 'index.js')));
  assert.match(briefOf(prompts(await kidOf(w.sessionId))[0]), /你的工作資料夾是 .*\/w1\/web\/app/);
  assert.ok(r.cluster.memory.path.startsWith(`${fs.realpathSync(repo)}/.git/agent-hub-cluster/`), 'the memory is the project\'s, not the subfolder\'s');
});

test('uncommitted work in the main folder is said to be missing from the worktrees', async () => {
  const repo = makeRepo('dirty');
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'not committed\n');
  const parent = await newKimi(repo);
  const r = await cluster(parent.id, { tasks: tasks('甲') });
  assert.match(r.warnings.join('\n'), /1 項還沒 commit/);
  assert.ok(!fs.existsSync(path.join(r.cluster.workers[0].worktree, 'wip.txt')), 'a worktree starts from HEAD');
});

// ------------------------------------------------------------------- fork

test('fork mode: the native :fork per worker (history copied), started in the main folder with a brief that says where to edit, and a warning about it', async () => {
  const repo = makeRepo('fork');
  const parent = await newKimi(repo);
  await say(parent.id, '分叉之前聊過的話');
  const forksBefore = hub.machine.forks.length;
  const r = await cluster(parent.id, { tasks: tasks('叉一', '叉二'), mode: 'fork' });
  const c = r.cluster;
  assert.equal(c.mode, 'fork');
  const forks = hub.machine.forks.slice(forksBefore);
  assert.equal(forks.length, 2);
  assert.ok(forks.every((f) => f.from === parent.kimiSessionId));
  assert.deepEqual(forks.map((f) => f.body.title), ['叉一', '叉二'], 'named after the task');
  for (const [i, w] of c.workers.entries()) {
    const s = await snap(w.sessionId);
    assert.equal(s.kimiSessionId, forks[i].to);
    assert.equal(s.cwd, repo, 'a fork starts in the main conversation\'s folder');
    assert.ok(s.events.some((e) => e.type === 'user' && e.text === '分叉之前聊過的話'), 'the history came with it');
    assert.equal(s.clusterId, c.id);
    assert.equal(s.meta.swarmMode, true);
    assert.ok(fs.existsSync(w.worktree), 'its worktree exists');
    const brief = briefOf(prompts(s.kimiSessionId).at(-1));
    assert.ok(brief.includes(w.worktree) && brief.includes('一律用'), 'the brief says edits go to the worktree by absolute path');
    assert.ok(!brief.includes('主對話最近的對話摘錄'), 'a fork has the history; no excerpt is repeated');
  }
  assert.match(r.warnings.join('\n'), /從主對話的資料夾起跑.*沒有機制強制/);
});

test('fork mode warns when the main conversation already used half its context, and is refused while it is busy', async () => {
  const repo = makeRepo('forkctx');
  const parent = await newKimi(repo);
  await say(parent.id, '開場');
  hub.machine.frame(parent.kimiSessionId, 'agent.status.updated', { contextTokens: 600000, maxContextTokens: 1000000 });
  await until(async () => (await snap(parent.id)).meta.context?.used === 600000, 5000, 'the context the native reports');
  const r = await cluster(parent.id, { tasks: tasks('甲'), mode: 'fork' });
  assert.match(r.warnings.join('\n'), /已用 60%.*簡報起跑/);
  const briefMode = await cluster(parent.id, { tasks: tasks('乙') });
  assert.ok(!briefMode.warnings.some((w) => /上下文/.test(w)), 'a brief carries no history, nothing to warn about');

  hub.machine.autoReply = false;
  try {
    await hub.api('POST', `/sessions/${parent.id}/messages`, { text: '正在忙' });
    await until(async () => (await snap(parent.id)).status === 'running', 5000, 'busy');
    const forksBefore = hub.machine.forks.length;
    await rejects(cluster(parent.id, { tasks: tasks('丙'), mode: 'fork' }), 409, /正在執行中/);
    assert.equal(hub.machine.forks.length, forksBefore, 'nothing was forked');
  } finally {
    hub.machine.autoReply = true;
  }
});

// ------------------------------------------------------------- what is refused

test('a Claude conversation cannot dispatch a cluster', async () => {
  const dir = path.join(hub.TMP, `claude-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const claude = await hub.api('POST', '/sessions', { provider: 'claude', machineId: MID, cwd: dir, model: 'claude-opus-5-5', effort: 'high', permission: 'auto' });
  await rejects(cluster(claude.id, { tasks: tasks('甲') }), 400, /^叢集第一版只支援 Kimi／DeepSeek 對話$/);
});

test('a bad request is refused before anything is made: 0 or 9 tasks, a task without a title or content, a bad mode, a non-boolean switch', async () => {
  const repo = makeRepo('bad');
  const parent = await newKimi(repo);
  const natives = hub.machine.sessions.size;
  const listed = (await hub.api('GET', '/sessions')).length;
  const bad = [
    [{ tasks: [] }, /至少/],
    [{}, /至少/],
    [{ tasks: tasks('1', '2', '3', '4', '5', '6', '7', '8', '9') }, /最多 8/],
    [{ tasks: [{ title: '', prompt: 'x' }] }, /沒有標題/],
    [{ tasks: [{ title: 'x', prompt: '  ' }] }, /沒有內容/],
    [{ tasks: tasks('x'), mode: 'swarm' }, /mode/],
    [{ tasks: tasks('x'), isolate: 'yes' }, /isolate/],
    [{ tasks: tasks('x'), swarm: 1 }, /swarm/],
  ];
  for (const [body, pattern] of bad) await rejects(cluster(parent.id, body), 400, pattern);
  // Eight is the limit, and is allowed.
  const eight = await cluster(parent.id, { tasks: tasks('1', '2', '3', '4', '5', '6', '7', '8'), isolate: false });
  assert.equal(eight.cluster.workers.length, 8);
  assert.equal(hub.machine.sessions.size, natives + 8, 'only the eight');
  assert.equal((await hub.api('GET', '/sessions')).length, listed + 8);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
});

test('a computer that is offline: 409 and nothing is made', async () => {
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const off = startFakeMachine({ port: hub.PORT, key, id: 'm_off', name: 'off-machine' });
  await off.ready;
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === 'm_off' && m.online), 10000, 'second machine online');
  const dir = path.join(hub.TMP, `off-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_off', cwd: dir, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  off.close();
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === 'm_off' && !m.online), 10000, 'second machine offline');
  const listed = (await hub.api('GET', '/sessions')).length;
  await rejects(cluster(parent.id, { tasks: tasks('甲') }), 409, /離線/);
  assert.equal((await hub.api('GET', '/sessions')).length, listed);
  assert.deepEqual(await hub.api('GET', `/sessions/${parent.id}/clusters`), []);
});

// ------------------------------------------------------- failing half way

test('a worktree that cannot be made (the second one): everything made so far is taken back - worktrees, branches, memory, the record', async () => {
  const repo = makeRepo('recycle1');
  const parent = await newKimi(repo);
  const listed = (await hub.api('GET', '/sessions')).length;
  const natives = hub.machine.sessions.size;
  hub.machine.shHook = (a) => (/worktree add -b 'cluster\/[^']+\/w2'/.test(a.command) ? { output: 'fatal: simulated failure', exitCode: 128 } : null);
  try {
    const err = await rejects(cluster(parent.id, { tasks: tasks('甲', '乙', '丙') }), 502, /w2/);
    assert.match(err.message, /simulated failure/);
  } finally {
    hub.machine.shHook = null;
  }
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)], 'the first worktree is gone');
  assert.deepEqual(clusterBranches(repo), [], 'and its branch');
  assert.deepEqual(siblings(repo), [], 'and the folder they were in');
  const memoryRoot = path.join(fs.realpathSync(repo), '.git', 'agent-hub-cluster');
  assert.deepEqual(fs.existsSync(memoryRoot) ? fs.readdirSync(memoryRoot) : [], [], 'and the memory');
  assert.deepEqual(await hub.api('GET', `/sessions/${parent.id}/clusters`), [], 'no half a cluster');
  assert.equal((await snap(parent.id)).clusterIds.length, 0);
  assert.equal((await hub.api('GET', '/sessions')).length, listed);
  assert.equal(hub.machine.sessions.size, natives, 'no conversation was opened: the worktrees come first');
});

test('a conversation that cannot be opened (the second): the first is stopped and removed, the worktrees and branches are taken back', async () => {
  const repo = makeRepo('recycle2');
  const parent = await newKimi(repo);
  const listed = (await hub.api('GET', '/sessions')).length;
  let created = 0;
  hub.machine.createHook = () => (++created === 2 ? { code: 50001, msg: 'simulated: no room for another conversation', data: null } : null);
  const archivedBefore = hub.machine.archived.length;
  const promptsBefore = hub.machine.prompts.length;
  try {
    await rejects(cluster(parent.id, { tasks: tasks('甲', '乙', '丙') }), 400, /simulated/);
  } finally {
    hub.machine.createHook = null;
  }
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(clusterBranches(repo), []);
  assert.deepEqual(siblings(repo), []);
  assert.deepEqual(await hub.api('GET', `/sessions/${parent.id}/clusters`), []);
  assert.equal((await hub.api('GET', '/sessions')).length, listed, 'the conversations that were opened are gone from the list');
  await until(async () => hub.machine.archived.length > archivedBefore, 5000, 'the native conversations archived');
  // None of them had been asked anything: the briefs go out only when all exist.
  assert.equal(hub.machine.prompts.length, promptsBefore, 'no worker was started');
});

test('a brief that Kimi refuses (the second worker): the first, already started, is stopped; nothing is shown on the stream or saved of that cluster; everything is taken back', async () => {
  const repo = makeRepo('recycle4');
  const parent = await newKimi(repo);
  const ws = watchWs();
  await ws.ready;
  const listed = (await hub.api('GET', '/sessions')).length;
  const saved = () => (fs.existsSync(path.join(hub.DATA, 'clusters')) ? fs.readdirSync(path.join(hub.DATA, 'clusters')) : []);
  const savedBefore = saved();
  const streamBefore = ws.msgs.filter((m) => m.t === 'cluster').length;
  const abortsBefore = hub.machine.requests.filter((r) => r.path.endsWith(':abort')).length;
  let started;
  let asked = 0;
  hub.machine.autoReply = false;
  hub.machine.refusePrompts = (sid) => {
    if (++asked === 2) return true;
    started = sid;
    return false;
  };
  try {
    await rejects(cluster(parent.id, { tasks: tasks('甲', '乙') }), 502, /refused/);
  } finally {
    hub.machine.refusePrompts = false;
    hub.machine.autoReply = true;
  }
  assert.ok(started, 'the premise: the first brief went out');
  assert.ok(hub.machine.requests.filter((r) => r.path.endsWith(':abort')).slice(abortsBefore).some((r) => r.path.includes(started)), 'the worker that had started was stopped');
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(clusterBranches(repo), []);
  assert.equal((await hub.api('GET', '/sessions')).length, listed);
  assert.deepEqual(await hub.api('GET', `/sessions/${parent.id}/clusters`), []);
  assert.deepEqual(saved(), savedBefore, 'no record of it on disk');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(ws.msgs.filter((m) => m.t === 'cluster').length, streamBefore, 'and none was announced');
  ws.close();
});

test('a worktree with work in it is not removed by a recycle (git refuses a dirty one)', async () => {
  const repo = makeRepo('recycle3');
  const parent = await newKimi(repo);
  // The first worktree gets an uncommitted file just before the second one fails.
  hub.machine.shHook = (a) => {
    const m = /worktree add -b 'cluster\/[^']+\/w2' '([^']+)'/.exec(a.command);
    if (!m) return null;
    const first = m[1].replace(/\/w2$/, '/w1');
    fs.writeFileSync(path.join(first, 'precious.txt'), 'work of a person\n');
    return { output: 'fatal: simulated failure', exitCode: 128 };
  };
  let before;
  try {
    before = siblings(repo);
    await rejects(cluster(parent.id, { tasks: tasks('甲', '乙') }), 502);
  } finally {
    hub.machine.shHook = null;
  }
  const left = siblings(repo);
  assert.equal(left.length, 1, 'the folder with the unsaved work is kept');
  assert.equal(fs.readFileSync(path.join(repo, '..', left[0], 'w1', 'precious.txt'), 'utf8'), 'work of a person\n');
  assert.equal(before.length, 0);
});

// ---------------------------------------------------------------- settings

test('the workers take the main conversation\'s subagent choice as it is: an explicit one, and an explicit "native rules"', async () => {
  const dir = path.join(hub.TMP, `sub-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const withSub = await newKimi(dir, { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  assert.deepEqual(withSub.subagent, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'the premise');
  const a = await cluster(withSub.id, { tasks: tasks('甲'), swarm: false });
  const wa = await snap(a.cluster.workers[0].sessionId);
  assert.deepEqual(wa.subagent, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });

  const nativeRules = await newKimi(dir, { subagent: null });
  assert.equal(nativeRules.subagent, null, 'the premise');
  const b = await cluster(nativeRules.id, { tasks: tasks('乙'), swarm: false });
  assert.equal((await snap(b.cluster.workers[0].sessionId)).subagent, null, 'not today\'s global default');
});

test('a main conversation on a model with no thinking choices whose record says "off": the workers are made too (an "off" the model does not list is not handed on as a choice)', async () => {
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const plain = startFakeMachine({ port: hub.PORT, key, id: 'm_nothink', name: 'no-thinking-machine' });
  plain.subThinking = false;
  plain.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  await plain.ready;
  try {
    await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === 'm_nothink' && m.online), 10000, 'machine online');
    const dir = path.join(hub.TMP, `noeffort-${++N}`);
    fs.mkdirSync(dir, { recursive: true });
    // Started with no model and no strength, as a person's plain "new conversation" is.
    const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_nothink', cwd: dir, permission: 'auto' });
    plain.frame(parent.kimiSessionId, 'agent.status.updated', { model: 'managed:kimi-code/kimi-for-coding', thinkingEffort: 'off' });
    await until(async () => (await snap(parent.id)).modelConfig.effort === 'off', 5000, 'the native\'s word in the record');
    assert.deepEqual((await hub.api('GET', '/models?machine=m_nothink')).groups.find((g) => g.provider === 'kimi').models[0].efforts, [], 'the premise: the model lists no strengths');
    const r = await cluster(parent.id, { tasks: tasks('甲'), swarm: false });
    const w = await snap(r.cluster.workers[0].sessionId);
    assert.equal(w.model, 'managed:kimi-code/kimi-for-coding');
    assert.equal(w.provider, 'kimi');
  } finally {
    plain.close();
  }
});

test('a DeepSeek main conversation gives DeepSeek workers: same model alias, its own badge, swarm on', async () => {
  const dir = path.join(hub.TMP, `ds-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const parent = await newDeepseek(dir);
  assert.equal(parent.provider, 'deepseek');
  const r = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  for (const w of r.cluster.workers) {
    const s = await snap(w.sessionId);
    assert.equal(s.provider, 'deepseek');
    assert.equal(s.mode, 'deepseek');
    assert.equal(s.model, parent.model);
    assert.equal(s.effort, 'max');
    assert.equal(s.modelDrift, null);
    assert.equal(hub.machine.sessions.get(s.kimiSessionId).model, `${DS}/${DEEPSEEK.model}`, 'the native runs the DeepSeek model');
    assert.equal(s.meta.swarmMode, true);
  }
});

test('swarm: false leaves the workers\' swarm mode alone; a Kimi without swarm mode is reported per worker, not hidden', async () => {
  const dir = path.join(hub.TMP, `swarm-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const parent = await newKimi(dir);
  const off = await cluster(parent.id, { tasks: tasks('甲'), swarm: false });
  assert.equal(off.cluster.swarm, false);
  assert.equal(off.cluster.workers[0].swarm, false);
  const kid = await kidOf(off.cluster.workers[0].sessionId);
  assert.deepEqual(hub.machine.profiles.filter((p) => p.sid === kid && p.agent_config && 'swarm_mode' in p.agent_config), [], 'nothing about swarm mode was sent');

  hub.machine.swarmUnsupported = true;
  try {
    const old = await cluster(parent.id, { tasks: tasks('乙', '丙') });
    assert.equal(old.cluster.workers.length, 2, 'the cluster is made anyway');
    assert.ok(old.cluster.workers.every((w) => w.swarm === false), 'and says the workers do not have it');
    assert.equal(old.warnings.filter((w) => /沒能開啟原生 Swarm 模式/.test(w)).length, 2);
    assert.ok(old.warnings.some((w) => w.includes('w1') && w.includes('乙')) && old.warnings.some((w) => w.includes('w2') && w.includes('丙')));
  } finally {
    hub.machine.swarmUnsupported = false;
  }
});

// ------------------------------------------------------------------ brief text

test('the excerpt of the main conversation in a brief is masked (even what the events keep) and cut to 8,000 characters, newest kept', async () => {
  const dir = path.join(hub.TMP, `redact-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  const parent = await newKimi(dir);
  const hb = `hb_${'a'.repeat(24)}`;
  const sk = `sk-${'b'.repeat(30)}`;
  await sayMasked(parent.id, `我的令牌 ${hb} 還有金鑰 ${sk} 請記住`);
  await sayMasked(parent.id, '環境檔裡有 DEEPSEEK_API_KEY=zzzzzzzz12345678 和 password: hunter2hunter2 兩行');
  // The premise: what the events keep is the lighter masking (shapes), which
  // leaves a KEY=VALUE line; the strict masking of the excerpt must catch it.
  const kept = (await snap(parent.id)).events.map((e) => e.text || '').join('\n');
  assert.ok(!kept.includes('a'.repeat(24)) && !kept.includes('b'.repeat(30)), 'shapes are masked in the events already');
  assert.ok(kept.includes('zzzzzzzz12345678'), 'the premise: the event store keeps a KEY=VALUE line');
  for (let i = 1; i <= 12; i++) await say(parent.id, `MSG_${String(i).padStart(2, '0')} ${'填'.repeat(1400)}`);
  await say(parent.id, `LONG_HEAD ${'中'.repeat(5000)} LONG_TAIL`);

  const r = await cluster(parent.id, { tasks: tasks('甲') });
  const brief = briefOf(prompts(await kidOf(r.cluster.workers[0].sessionId))[0]);
  for (const secret of [hb, sk, 'a'.repeat(24), 'b'.repeat(30), 'zzzzzzzz12345678', 'hunter2hunter2']) assert.ok(!brief.includes(secret), `${secret.slice(0, 12)}… must not be in the brief`);
  const head = '## 主對話最近的對話摘錄（舊到新，已遮蔽金鑰，只當背景）';
  const excerpt = brief.slice(brief.indexOf(head) + head.length).trim();
  assert.ok(excerpt.length <= 8000, `excerpt is ${excerpt.length} characters`);
  assert.ok(excerpt.includes('MSG_12') && !excerpt.includes('MSG_01'), 'the newest is kept, the oldest is not');
  assert.ok(excerpt.includes('LONG_HEAD') && excerpt.includes('LONG_TAIL') && excerpt.includes('中間省略'), 'a long message keeps its beginning and its end');
  assert.ok(excerpt.indexOf('MSG_11') < excerpt.indexOf('MSG_12'), 'oldest to newest');

  // The same masking over a short history: the words around a secret stay.
  const small = await newKimi(dir);
  await sayMasked(small.id, '環境檔裡有 DEEPSEEK_API_KEY=yyyyyyyy87654321 這行');
  const r2 = await cluster(small.id, { tasks: tasks('乙') });
  const brief2 = briefOf(prompts(await kidOf(r2.cluster.workers[0].sessionId))[0]);
  assert.ok(brief2.includes('環境檔裡有') && brief2.includes('[redacted]') && !brief2.includes('yyyyyyyy87654321'));
});

// ---------------------------------------------------------------- memory

test('the memory: read it, add a decision, and each worker is told the new part once, only the new part, before its next message', async () => {
  const repo = makeRepo('memory');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙'), note: '備註 NOTE_IN_HEADER' });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  const k1 = await kidOf(w1.sessionId);
  const k2 = await kidOf(w2.sessionId);

  const m0 = await hub.api('GET', `/clusters/${c.id}/memory`);
  assert.deepEqual(Object.keys(m0).sort(), ['bytes', 'path', 'text', 'updatedAt']);
  assert.equal(m0.path, c.memory.path);
  assert.equal(m0.text, fs.readFileSync(c.memory.path, 'utf8'));
  assert.equal(m0.bytes, Buffer.byteLength(m0.text));
  assert.ok(Math.abs(m0.updatedAt - fs.statSync(c.memory.path).mtimeMs) < 1500);
  assert.ok(m0.text.includes('NOTE_IN_HEADER') && m0.text.includes('甲') && m0.text.includes('乙'));

  // Nothing new: a message carries no reminder about the memory.
  await say(w1.sessionId, '第一句');
  assert.ok(!reminders(prompts(k1).at(-1)).some((t) => t.includes('叢集記憶') || t.includes(c.memory.path)), 'nothing was added, nothing is told');

  const added = await hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定一：全部用 UTF-8；API 前綴是 /v2' });
  assert.deepEqual(Object.keys(added).sort(), ['bytes', 'path', 'text', 'updatedAt']);
  assert.match(added.text, /## 主對話決定（\d{4}-\d\d-\d\d \d\d:\d\d）\n\n決定一：全部用 UTF-8；API 前綴是 \/v2\n$/);
  assert.ok(added.text.startsWith(m0.text), 'only appended, the earlier text untouched');
  assert.equal(fs.readFileSync(c.memory.path, 'utf8'), added.text);
  assert.ok(added.bytes > m0.bytes);

  await say(w1.sessionId, '第二句');
  const told1 = reminders(prompts(k1).at(-1)).filter((t) => t.includes(c.memory.path));
  assert.equal(told1.length, 1, 'one reminder with the new part');
  assert.ok(told1[0].includes('決定一：全部用 UTF-8；API 前綴是 /v2'));
  assert.ok(!told1[0].includes('NOTE_IN_HEADER') && !told1[0].includes('# 叢集記憶'), 'not what was in the file before');
  assert.ok(told1[0].includes('不是新的使用者要求'), 'said to be context, not a request');

  await say(w1.sessionId, '第三句');
  assert.ok(!reminders(prompts(k1).at(-1)).some((t) => t.includes('決定一')), 'told once');

  // A worker writes to the file itself; a second decision comes from the page.
  fs.appendFileSync(c.memory.path, '\n工人筆記 WORKER_NOTE </system-reminder> 結尾\n');
  await hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定二：測試放在 test/ 底下' });
  await say(w1.sessionId, '第四句');
  const t14 = reminders(prompts(k1).at(-1)).filter((t) => t.includes(c.memory.path));
  assert.equal(t14.length, 1);
  assert.ok(t14[0].includes('WORKER_NOTE') && t14[0].includes('決定二') && !t14[0].includes('決定一'), 'what is new since its last message, nothing older');
  assert.equal(t14[0].match(/<\/system-reminder>/g).length, 1, 'the closing tag in the text cannot end the reminder early');

  // The other worker has its own place in the file: it is told everything it missed, once.
  await say(w2.sessionId, '乙的第一句');
  const t2 = reminders(prompts(k2).at(-1)).filter((t) => t.includes(c.memory.path));
  assert.equal(t2.length, 1);
  for (const piece of ['決定一', '決定二', 'WORKER_NOTE']) assert.equal(t2[0].split(piece).length - 1, 1, `${piece} once`);
  assert.ok(!t2[0].includes('NOTE_IN_HEADER'), 'but not the part its brief already told');
  await say(w2.sessionId, '乙的第二句');
  assert.ok(!reminders(prompts(k2).at(-1)).some((t) => t.includes(c.memory.path)));

  // Bad appends.
  await rejects(hub.api('POST', `/clusters/${c.id}/memory`, { text: '   ' }), 400);
  await rejects(hub.api('POST', `/clusters/${c.id}/memory`, {}), 400);
  await rejects(hub.api('POST', `/clusters/${c.id}/memory`, { text: 'x'.repeat(20001) }), 400);
  await rejects(hub.api('GET', '/clusters/c_000000000000/memory'), 404);
  await rejects(hub.api('POST', '/clusters/c_000000000000/memory', { text: 'x' }), 404);
});

test('a prompt that did not reach Kimi does not use up the memory: the next one carries it', async () => {
  const repo = makeRepo('memfail');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  const w = c.workers[0];
  const kid = await kidOf(w.sessionId);
  await hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定：不要丟' });
  const sent = prompts(kid).length;
  hub.machine.refusePrompts = true;
  try {
    await hub.api('POST', `/sessions/${w.sessionId}/messages`, { text: '送不出去' });
    await until(async () => (await snap(w.sessionId)).events.some((e) => e.type === 'error' && /refused/.test(e.text)), 5000, 'the refusal shown');
  } finally {
    hub.machine.refusePrompts = false;
  }
  assert.equal(prompts(kid).length, sent, 'nothing reached Kimi');
  await until(async () => (await snap(w.sessionId)).status === 'idle', 5000, 'idle again');
  await say(w.sessionId, '這次送得出去');
  const told = reminders(prompts(kid).at(-1)).filter((t) => t.includes(c.memory.path));
  assert.equal(told.length, 1);
  assert.ok(told[0].includes('決定：不要丟'));
  await say(w.sessionId, '再一次');
  assert.ok(!reminders(prompts(kid).at(-1)).some((t) => t.includes('決定：不要丟')), 'and then it is used up');
});

test('two messages leaving a worker together do not both carry the same new part of the memory', async () => {
  const repo = makeRepo('memrace');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  const w = c.workers[0];
  const kid = await kidOf(w.sessionId);
  await hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定：RACE_MARK' });
  const sent = prompts(kid).length;
  await Promise.all([hub.api('POST', `/sessions/${w.sessionId}/messages`, { text: '同時一' }), hub.api('POST', `/sessions/${w.sessionId}/messages`, { text: '同時二' })]);
  await until(async () => prompts(kid).length >= sent + 2, 10000, 'both messages at Kimi');
  const carrying = prompts(kid).slice(sent).filter((p) => reminders(p).some((t) => t.includes('RACE_MARK')));
  assert.equal(carrying.length, 1, 'told once');
});

// ------------------------------------------------------------------- stop

test('stop interrupts every working worker, deletes nothing, and the cluster reads "stopped" once they are idle', async () => {
  const repo = makeRepo('stop');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  let c;
  try {
    ({ cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙', '丙') }));
    assert.equal(c.status, 'running');
    await until(async () => (await getCluster(c.id)).workers.every((w) => w.status === 'running'), 5000, 'all working');
    const kids = await Promise.all(c.workers.map((w) => kidOf(w.sessionId)));
    const abortsBefore = hub.machine.requests.filter((r) => r.path.endsWith(':abort')).length;
    const stopped = await hub.api('POST', `/clusters/${c.id}/stop`);
    assert.equal(stopped.id, c.id);
    const aborts = hub.machine.requests.filter((r) => r.path.endsWith(':abort')).slice(abortsBefore).map((r) => r.path);
    assert.deepEqual(aborts.sort(), kids.map((k) => `/api/v1/sessions/${k}:abort`).sort(), 'each worker, once');
    // Kimi reports each turn over.
    for (const k of kids) hub.machine.frame(k, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
    const after = await until(async () => {
      const x = await getCluster(c.id);
      return x.workers.every((w) => w.status === 'idle') && x;
    }, 5000, 'all idle');
    assert.equal(after.status, 'stopped');
    // A worker cut off in the middle did not finish its task: counting it as finished made the page read
    // "已停止 · 3/3 完成" with every card 已完成 (found by test/e2e-cluster-ui.test.mjs).
    assert.ok(after.workers.every((w) => w.finishedAt === null), 'cut off, not finished');
    assert.equal(worktrees(repo).length, 4, 'the worktrees stay');
    for (const w of c.workers) assert.ok((await snap(w.sessionId)).id, 'the conversations stay');
  } finally {
    hub.machine.autoReply = true;
  }
});

test('stop on a cluster whose workers are all done does nothing', async () => {
  const repo = makeRepo('stopdone');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  const before = hub.machine.requests.filter((r) => r.path.endsWith(':abort')).length;
  const r = await hub.api('POST', `/clusters/${c.id}/stop`);
  assert.equal(r.status, 'done', 'still done: nothing was stopped');
  assert.equal(hub.machine.requests.filter((x) => x.path.endsWith(':abort')).length, before);
  await rejects(hub.api('POST', '/clusters/c_000000000000/stop'), 404);
});

// ------------------------------------------------------- where the worktrees go

test('a repo that has no commit yet cannot have worktrees: the workers share the folder and it says so', async () => {
  const dir = path.join(hub.TMP, `nocommit-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const parent = await newKimi(dir);
  const r = await cluster(parent.id, { tasks: tasks('甲') });
  assert.equal(r.cluster.isolate, false);
  assert.match(r.warnings.join('\n'), /還沒有任何 commit/);
  assert.equal((await snap(r.cluster.workers[0].sessionId)).cwd, dir);
  assert.ok(fs.existsSync(path.join(fs.realpathSync(dir), '.git', 'agent-hub-cluster', r.cluster.id, 'memory.md')), 'the memory is still outside the working files');
});

test('a project under a dot folder: its worktrees go to the computer\'s agent-hub-workspaces instead (tools skip hidden folders); if that has a dot too, no worktrees, said so', async () => {
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const home = path.join(hub.TMP, 'machine-home');
  fs.mkdirSync(home, { recursive: true });
  const dotHome = path.join(hub.TMP, '.dothome');
  fs.mkdirSync(dotHome, { recursive: true });
  const a = startFakeMachine({ port: hub.PORT, key, id: 'm_dot', name: 'dot-machine', home });
  const b = startFakeMachine({ port: hub.PORT, key, id: 'm_dot2', name: 'dot-machine-2', home: dotHome });
  for (const m of [a, b]) {
    m.shEnv = { ...GIT_ENV, HOME: hub.TMP };
    await m.ready;
  }
  try {
    await until(async () => (await hub.api('GET', '/machines')).filter((m) => ['m_dot', 'm_dot2'].includes(m.id) && m.online).length === 2, 10000, 'both machines online');
    const repo = path.join(hub.TMP, '.hidden', `repo-${++N}`);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    const onA = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_dot', cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
    const r = await cluster(onA.id, { tasks: tasks('甲', '乙') });
    assert.equal(r.cluster.isolate, true);
    const base = path.join(fs.realpathSync(home), 'agent-hub-workspaces', `${path.basename(repo)}-cluster-${r.cluster.id}`);
    assert.deepEqual(r.cluster.workers.map((w) => w.worktree), [`${base}/w1`, `${base}/w2`]);
    for (const w of r.cluster.workers) {
      assert.ok(fs.existsSync(path.join(w.worktree, 'a.txt')));
      assert.ok(!w.worktree.split('/').some((seg) => seg.startsWith('.')));
      assert.equal((await snap(w.sessionId)).cwd, w.worktree);
    }
    assert.deepEqual(worktrees(repo).length, 3);

    const onB = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_dot2', cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
    const r2 = await cluster(onB.id, { tasks: tasks('丙') });
    assert.equal(r2.cluster.isolate, false);
    assert.match(r2.warnings.join('\n'), /以點開頭的資料夾/);
    assert.equal(worktrees(repo).length, 3, 'no worktree was made');
  } finally {
    a.close();
    b.close();
  }
});

// -------------------------------------------------- the computer goes away

test('the computer goes offline after the cluster was made: the status still reads, what needs the computer says 409', async () => {
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const away = startFakeMachine({ port: hub.PORT, key, id: 'm_away', name: 'away-machine' });
  away.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  await away.ready;
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === 'm_away' && m.online), 10000, 'machine online');
  const repo = makeRepo('away');
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_away', cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  away.close();
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === 'm_away' && !m.online), 10000, 'machine offline');
  const got = await getCluster(c.id);
  assert.equal(got.id, c.id);
  assert.ok(got.memory.bytes > 0, 'the size last known');
  assert.equal(got.workers[0].branch, c.workers[0].branch);
  await rejects(hub.api('GET', `/clusters/${c.id}/memory`), 409, /離線/);
  await rejects(hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定' }), 409, /離線/);
  await rejects(hub.api('POST', `/clusters/${c.id}/merge`), 409, /離線/);
  assert.notEqual((await getCluster(c.id)).status, 'merging', 'a refused merge does not leave the cluster marked as merging');
});

// ------------------------------------------------------------------ merge

test('merge: a new branch from the main HEAD takes each worker\'s branch in order; the one that conflicts is recorded and skipped; the main branch and folder are not touched', async () => {
  const repo = makeRepo('merge');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙', '丙') });
  await allDone(c.id);
  const [w1, w2, w3] = c.workers;
  // The workers' work: w1 and w2 change the same line (w2 is in the middle:
  // the merge must be put right after its conflict for w3 to merge), w3 adds a file.
  fs.writeFileSync(path.join(w1.worktree, 'a.txt'), 'one-from-w1\ntwo\nthree\n');
  git(w1.worktree, 'commit', '-q', '-am', 'w1 change');
  fs.writeFileSync(path.join(w2.worktree, 'a.txt'), 'one-from-w2\ntwo\nthree\n');
  git(w2.worktree, 'commit', '-q', '-am', 'w2 change');
  fs.writeFileSync(path.join(w3.worktree, 'c.txt'), 'from w3\n');
  git(w3.worktree, 'add', '-A');
  git(w3.worktree, 'commit', '-q', '-m', 'w3 file');

  // The main conversation's folder has work in progress of its own.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee, edited and not committed\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const statusBefore = git(repo, 'status', '--porcelain');
  const userEventsBefore = (await snap(parent.id)).events.filter((e) => e.type === 'user').length;

  const merged = await hub.api('POST', `/clusters/${c.id}/merge`);
  const m = merged.merge;
  assert.equal(m.branch, `cluster/${c.id}/merged`);
  assert.ok(Math.abs(m.at - Date.now()) < 60_000);
  assert.deepEqual(m.results.map((r) => ({ sessionId: r.sessionId, branch: r.branch, ok: r.ok, conflicts: r.conflicts })), [
    { sessionId: w1.sessionId, branch: w1.branch, ok: true, conflicts: [] },
    { sessionId: w2.sessionId, branch: w2.branch, ok: false, conflicts: ['a.txt'] },
    { sessionId: w3.sessionId, branch: w3.branch, ok: true, conflicts: [] },
  ]);

  // The branch holds w1 and w3, from the HEAD that was; not w2.
  assert.equal(git(repo, 'show', `${m.branch}:a.txt`), 'one-from-w1\ntwo\nthree');
  assert.equal(git(repo, 'show', `${m.branch}:c.txt`), 'from w3');
  assert.equal(git(repo, 'merge-base', m.branch, 'main'), headBefore, 'it grew from the main HEAD');
  assert.equal(git(repo, 'log', '--merges', '--format=%s', m.branch).split('\n').length, 2, 'one merge commit per merged worker');
  assert.match(git(repo, 'log', '--merges', '--format=%s', m.branch), /Merge cluster c_[0-9a-f]+ w3/);
  assert.equal(git(repo, 'log', '-1', '--format=%an', m.branch), 'Agent Hub', 'a git with no identity of its own still merges');

  // The main conversation's side is exactly as it was.
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'bee, edited and not committed\n');
  assert.ok(!fs.existsSync(path.join(fs.realpathSync(repo), '.git', 'MERGE_HEAD')));
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), ...c.workers.map((w) => w.worktree)].sort(), 'the worktree the merge was made in is gone, the workers\' stay');
  assert.ok(clusterBranches(repo).includes(m.branch) && c.workers.every((w) => clusterBranches(repo).includes(w.branch)), 'every branch stays');
  assert.equal(git(w2.worktree, 'status', '--porcelain'), '', 'the conflicting worker\'s own worktree is untouched');

  // Saved on the cluster; said in the main conversation as a system line, not as the user.
  assert.deepEqual((await getCluster(c.id)).merge, m);
  const after = await snap(parent.id);
  assert.equal(after.events.filter((e) => e.type === 'user').length, userEventsBefore, 'no message from the user was invented');
  const info = after.events.filter((e) => e.type === 'info').at(-1);
  assert.ok(info.text.includes(c.id) && info.text.includes(m.branch) && info.text.includes('w2') && info.text.includes('a.txt'));
  assert.match(info.text, /沒有被動到/);

  // The branch exists now: a second merge would not make it again.
  await rejects(hub.api('POST', `/clusters/${c.id}/merge`), 409, /已經存在/);
  assert.deepEqual((await getCluster(c.id)).merge, m, 'the first result is kept');
});

test('merge: a worker with nothing committed merges as a no-op; a branch someone deleted is reported, not fatal', async () => {
  const repo = makeRepo('merge2');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  fs.writeFileSync(path.join(w1.worktree, 'x.txt'), 'x\n');
  git(w1.worktree, 'add', '-A');
  git(w1.worktree, 'commit', '-q', '-m', 'x');
  git(repo, 'worktree', 'remove', '--force', w2.worktree);
  git(repo, 'branch', '-D', w2.branch);
  const merged = await hub.api('POST', `/clusters/${c.id}/merge`);
  assert.equal(merged.merge.results[0].ok, true);
  assert.equal(merged.merge.results[1].ok, false);
  assert.deepEqual(merged.merge.results[1].conflicts, []);
  assert.match(merged.merge.results[1].error, new RegExp(w2.branch));
  assert.equal(git(repo, 'show', `${merged.merge.branch}:x.txt`), 'x');
  assert.equal(merged.status === 'merging', false);
});

test('merge that fails for another reason leaves nothing behind and can be tried again', async () => {
  const repo = makeRepo('merge3');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  hub.machine.shHook = (a) => (/merge --no-ff/.test(a.command) ? { output: 'the machine broke', exitCode: 7 } : null);
  try {
    await rejects(hub.api('POST', `/clusters/${c.id}/merge`), 502, /合併 w1 時出錯/);
  } finally {
    hub.machine.shHook = null;
  }
  assert.ok(!clusterBranches(repo).includes(`cluster/${c.id}/merged`), 'the half-made merge branch is removed');
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), c.workers[0].worktree].sort(), 'and its worktree');
  assert.equal((await getCluster(c.id)).merge, null);
  assert.notEqual((await getCluster(c.id)).status, 'merging');
  const again = await hub.api('POST', `/clusters/${c.id}/merge`);
  assert.equal(again.merge.results[0].ok, true);
});
