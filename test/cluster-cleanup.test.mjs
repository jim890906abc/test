// 叢集 (cluster) clean-up after the work is merged: through the REAL Hub
// (runner, cluster.js, the adapters) with only the outside faked - the Kimi of a
// computer (the fake machine, whose sh.run really runs bash on this test
// machine's disk, so the worktrees, branches and removals below are real git in
// real folders) and the Anthropic API.
//
// What a person asked for: "after I press merge, those branches should go away
// by themselves, or they take up space and sidebar rows". What must hold at the
// same time (the no-loss rule): only a CLEAN worktree is removed, only a branch
// whose commits are somewhere else (the merged branch, or the main
// conversation's HEAD) is deleted, the merged branch stays, a worker whose
// merge failed is left alone, the conversations are hidden from the sidebar and
// never deleted, and one step failing leaves that worker as it was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startRealHub, until } from './fixtures/real-hub.mjs';

const MID = 'm_fake';
let hub;
let KIMI;
let N = 0;

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
const cluster = (id, body) => hub.api('POST', `/sessions/${id}/cluster`, body);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const merge = (cid) => hub.api('POST', `/clusters/${cid}/merge`);
const cleanup = (cid) => hub.api('POST', `/clusters/${cid}/cleanup`);
const plan = (cid) => hub.api('GET', `/clusters/${cid}/cleanup/plan`);
const unhide = (cid, body) => hub.api('POST', `/clusters/${cid}/unhide`, body);
const tasks = (...titles) => titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` }));
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
const branches = (repo) => git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)').split('\n').filter(Boolean);
const siblings = (repo) => fs.readdirSync(path.dirname(repo)).filter((n) => n.startsWith(`${path.basename(repo)}-cluster-`));
const commit = (w, file, text, msg = `edit ${file}`) => {
  fs.writeFileSync(path.join(w.worktree, file), text);
  git(w.worktree, 'add', '-A');
  git(w.worktree, 'commit', '-q', '-m', msg);
};
// What each result says, without the sessions' ids.
const brief = (results) => results.map((r) => [r.worktree, r.branch, r.hidden]);
const hiddenOf = async (sid) => Boolean((await snap(sid)).clusterHidden);

before(async () => {
  hub = await startRealHub('cluster-cleanup', { claude: true });
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
});
after(() => hub?.stop());

// ------------------------------------------------------- after a full merge

test('a merge in which every worker went in cleans up by itself: worktrees removed, worker branches deleted, the merged branch and the memory kept, the conversations hidden from the sidebar but not deleted', async () => {
  const repo = makeRepo('auto');
  const parent = await newKimi(repo);
  const ws = watchWs();
  await ws.ready;
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  commit(w1, 'x.txt', 'from w1\n');
  commit(w2, 'y.txt', 'from w2\n');
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const userEventsBefore = (await snap(parent.id)).events.filter((e) => e.type === 'user').length;

  const out = await merge(c.id);
  assert.deepEqual(out.merge.results.map((r) => r.ok), [true, true], 'the premise: both went in');
  assert.equal(out.cleanup.auto, true);
  assert.ok(Math.abs(out.cleanup.at - Date.now()) < 60_000);
  assert.deepEqual(out.cleanup.results, [
    { sessionId: w1.sessionId, worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] },
    { sessionId: w2.sessionId, worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] },
  ]);

  // The disk.
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)], 'only the main folder is left');
  assert.deepEqual(branches(repo), [`cluster/${c.id}/merged`], 'the merged branch is what stays');
  assert.equal(git(repo, 'show', `cluster/${c.id}/merged:x.txt`), 'from w1');
  assert.equal(git(repo, 'show', `cluster/${c.id}/merged:y.txt`), 'from w2', 'what the deleted branches held is in it');
  assert.deepEqual(siblings(repo), [], 'the cluster\'s folder beside the project is gone too');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(repo, 'status', '--porcelain'), '');

  // The conversations: hidden, not deleted; the memory is still readable.
  for (const w of c.workers) {
    const s = await snap(w.sessionId);
    assert.equal(s.clusterHidden, true);
    assert.equal(s.clusterId, c.id, 'still a worker of the cluster');
  }
  assert.ok((await hub.api('GET', `/clusters/${c.id}/memory`)).text.includes(c.id));

  // The Hub says it the same way when asked again, and told every page.
  assert.deepEqual((await getCluster(c.id)).cleanup, out.cleanup);
  assert.deepEqual((await getCluster(c.id)).workers.map((w) => w.hidden), [true, true]);
  await until(async () => ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.cleanup?.auto === true), 5000, 'the cluster message with the clean-up');
  await until(async () => ws.msgs.some((m) => m.t === 'session' && m.session.id === w1.sessionId && m.session.clusterHidden === true), 5000, 'the worker\'s summary says hidden');
  ws.close();

  // The main conversation is told, as a system line.
  const after = await snap(parent.id);
  assert.equal(after.events.filter((e) => e.type === 'user').length, userEventsBefore, 'no message from the user was made up');
  const line = after.events.filter((e) => e.type === 'info' && e.text.includes('已清理')).at(-1);
  assert.ok(line, 'a line says it was cleaned up');
  assert.ok(line.text.includes(c.id) && line.text.includes('2 個 worktree') && line.text.includes('2 個分支'), line.text);
  assert.ok(line.text.includes(`cluster/${c.id}/merged`), 'and says what stays');
});

test('a computer that fails while the automatic clean-up looks at the workers does not undo the merge: the merged branch stays, every worker is kept whole with the reason, and a later clean-up by hand works', async () => {
  const repo = makeRepo('autofail');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  commit(w1, 'x.txt', 'from w1\n');
  commit(w2, 'y.txt', 'from w2\n');
  // Looking at a worker (the clean-up's first command per worker) fails; the merge's own commands do not.
  hub.machine.shHook = (a) => (a.command.includes('AHC_WTDIR') ? { output: 'the machine broke', exitCode: 9 } : null);
  let out;
  try {
    out = await merge(c.id);
  } finally {
    hub.machine.shHook = null;
  }
  assert.deepEqual(out.merge.results.map((r) => r.ok), [true, true], 'the merge itself is done');
  assert.equal(git(repo, 'show', `cluster/${c.id}/merged:x.txt`), 'from w1');
  assert.equal(git(repo, 'show', `cluster/${c.id}/merged:y.txt`), 'from w2');
  assert.deepEqual(brief(out.cleanup.results), [['kept', 'kept', false], ['kept', 'kept', false]]);
  assert.match(out.cleanup.results[0].reasons.join(' '), /看不到 git 狀態.*the machine broke/);
  assert.equal(worktrees(repo).length, 3, 'nothing was removed');
  assert.equal(branches(repo).length, 3, 'nothing was deleted');
  for (const w of c.workers) assert.equal(await hiddenOf(w.sessionId), false);
  // The machine is fine again: pressing 清理 finishes the job.
  const again = await cleanup(c.id);
  assert.deepEqual(brief(again.cleanup.results), [['removed', 'deleted', true], ['removed', 'deleted', true]]);
});

test('a project folder with a space, a quote, a dollar sign and Chinese in its name is cleaned up all the same (nothing in the clean-up is spliced into a shell line unquoted)', async () => {
  const repo = makeRepo("sp ace's $HOME `x` 專案");
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  commit(w1, 'x.txt', 'from w1\n');
  commit(w2, 'y.txt', 'from w2\n');
  fs.writeFileSync(path.join(w2.worktree, 'scratch.txt'), 'not committed\n');
  const planned = await plan(c.id);
  assert.deepEqual(brief(planned.results), [['kept', 'kept', false], ['kept', 'kept', false]], 'before a merge: both have commits');
  const out = await merge(c.id);
  assert.equal(out.cleanup.auto, true);
  assert.deepEqual(brief(out.cleanup.results), [['removed', 'deleted', true], ['kept', 'kept', false]]);
  assert.match(out.cleanup.results[1].reasons.join(' '), /1 項未提交/);
  assert.ok(!fs.existsSync(w1.worktree) && fs.existsSync(w2.worktree));
  assert.deepEqual(branches(repo).sort(), [`cluster/${c.id}/merged`, w2.branch].sort());
  assert.equal(git(repo, 'show', `cluster/${c.id}/merged:x.txt`), 'from w1');
  fs.rmSync(path.join(w2.worktree, 'scratch.txt'));
  const again = await cleanup(c.id);
  assert.deepEqual(brief(again.cleanup.results), [['removed', 'deleted', true], ['removed', 'deleted', true]]);
  assert.deepEqual(siblings(repo), [], 'and the folder beside the project is gone');
});

test('a merge in which a worker clashed does not clean up by itself; cleaning up by hand then leaves that worker alone and cleans the others', async () => {
  const repo = makeRepo('conflict');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙', '丙') });
  await allDone(c.id);
  const [w1, w2, w3] = c.workers;
  commit(w1, 'a.txt', 'one-from-w1\ntwo\nthree\n');
  commit(w2, 'a.txt', 'one-from-w2\ntwo\nthree\n');
  commit(w3, 'c.txt', 'from w3\n');

  const out = await merge(c.id);
  assert.deepEqual(out.merge.results.map((r) => r.ok), [true, false, true]);
  assert.equal(out.cleanup, null, 'a merge with a failure cleans nothing by itself');
  assert.equal(worktrees(repo).length, 4);
  assert.equal(branches(repo).length, 4);
  for (const w of c.workers) assert.equal(await hiddenOf(w.sessionId), false);

  const done = await cleanup(c.id);
  assert.equal(done.cleanup.auto, false);
  assert.deepEqual(brief(done.cleanup.results), [['removed', 'deleted', true], ['kept', 'kept', false], ['removed', 'deleted', true]]);
  assert.match(done.cleanup.results[1].reasons.join(' '), /沒合進去/, 'says why the clashing worker was left');
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), w2.worktree].sort());
  assert.deepEqual(branches(repo).sort(), [`cluster/${c.id}/merged`, w2.branch].sort());
  assert.equal(git(w2.worktree, 'log', '-1', '--format=%s'), 'edit a.txt', 'its work is where it was');
  assert.deepEqual(await Promise.all(c.workers.map((w) => hiddenOf(w.sessionId))), [true, false, true]);
});

test('a worktree with something uncommitted or untracked in it is kept with the reason (and its branch with it); once it is clean a second clean-up takes it', async () => {
  const repo = makeRepo('dirty');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  commit(w1, 'x.txt', 'from w1\n');
  commit(w2, 'y.txt', 'from w2\n');
  fs.writeFileSync(path.join(w2.worktree, 'scratch.txt'), 'not committed\n'); // untracked
  fs.writeFileSync(path.join(w2.worktree, 'b.txt'), 'bee, edited\n'); // modified

  const out = await merge(c.id);
  assert.equal(out.cleanup.auto, true, 'both went in, so it ran');
  assert.deepEqual(brief(out.cleanup.results), [['removed', 'deleted', true], ['kept', 'kept', false]]);
  assert.match(out.cleanup.results[1].reasons.join(' '), /2 項未提交/);
  assert.equal(fs.readFileSync(path.join(w2.worktree, 'scratch.txt'), 'utf8'), 'not committed\n', 'nothing in it was touched');
  assert.equal(fs.readFileSync(path.join(w2.worktree, 'b.txt'), 'utf8'), 'bee, edited\n');
  assert.ok(branches(repo).includes(w2.branch), 'a branch a worktree still uses is not deleted');
  assert.equal(await hiddenOf(w2.sessionId), false, 'a worker with something left stays in the sidebar');
  assert.equal(await hiddenOf(w1.sessionId), true);

  // Cleaned by the person, then the same button again.
  fs.rmSync(path.join(w2.worktree, 'scratch.txt'));
  git(w2.worktree, 'checkout', '--', 'b.txt');
  const again = await cleanup(c.id);
  assert.deepEqual(brief(again.cleanup.results), [['removed', 'deleted', true], ['removed', 'deleted', true]]);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(branches(repo), [`cluster/${c.id}/merged`]);
  assert.equal(await hiddenOf(w2.sessionId), true);
});

// ---------------------------------------------------------------- by hand

test('by hand on a cluster that was never merged: a branch with no commit of its own goes, one with a commit stays (and so does its worktree)', async () => {
  const repo = makeRepo('readonly');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('只讀甲', '寫乙', '只讀丙') });
  await allDone(c.id);
  const [w1, w2, w3] = c.workers;
  commit(w2, 'y.txt', 'from w2\n');
  const tip = git(w2.worktree, 'rev-parse', 'HEAD');

  const out = await cleanup(c.id);
  assert.equal(out.cleanup.auto, false);
  assert.deepEqual(brief(out.cleanup.results), [['removed', 'deleted', true], ['kept', 'kept', false], ['removed', 'deleted', true]]);
  assert.match(out.cleanup.results[1].reasons.join(' '), /還沒合併過.*1 個 commit/);
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), w2.worktree].sort());
  assert.deepEqual(branches(repo), [w2.branch]);
  assert.equal(git(repo, 'rev-parse', w2.branch), tip, 'the commit is exactly where it was');
  assert.deepEqual(await Promise.all([w1, w2, w3].map((w) => hiddenOf(w.sessionId))), [true, false, true]);
  // No merged branch was made by cleaning up.
  assert.equal(git(repo, 'branch', '--list', `cluster/${c.id}/merged`), '');
  assert.equal((await getCluster(c.id)).merge, null);
});

test('with the merged branch gone, a worker\'s commits are nowhere else: every branch is kept, whatever else is true', async () => {
  const repo = makeRepo('late');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙', '丙') });
  await allDone(c.id);
  const [w1, w2, w3] = c.workers;
  commit(w1, 'a.txt', 'one-from-w1\ntwo\nthree\n');
  commit(w2, 'a.txt', 'one-from-w2\ntwo\nthree\n'); // clashes: no automatic clean-up
  commit(w3, 'c.txt', 'from w3\n');
  const out = await merge(c.id);
  assert.equal(out.cleanup, null);
  commit(w1, 'late.txt', 'made after the merge\n'); // w1 went on working
  commit(w3, 'late.txt', 'also late\n');
  git(repo, 'branch', '-D', `cluster/${c.id}/merged`); // and the merged branch is gone (someone deleted it)

  // Without the merged branch, nothing of w1/w3 is anywhere else: all three are kept.
  const none = await cleanup(c.id);
  assert.deepEqual(brief(none.cleanup.results), [['kept', 'kept', false], ['kept', 'kept', false], ['kept', 'kept', false]]);
  assert.equal(branches(repo).length, 3);
  assert.equal(worktrees(repo).length, 4);
});

test('a merge branch exists but a worker committed after it was made: that worker\'s branch has commits the merged branch lacks, so it is kept', async () => {
  const repo = makeRepo('late2');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙', '丙') });
  await allDone(c.id);
  const [w1, w2, w3] = c.workers;
  commit(w1, 'a.txt', 'one-from-w1\ntwo\nthree\n');
  commit(w2, 'a.txt', 'one-from-w2\ntwo\nthree\n');
  commit(w3, 'c.txt', 'from w3\n');
  const out = await merge(c.id);
  assert.equal(out.cleanup, null);
  commit(w1, 'late.txt', 'made after the merge\n');

  const done = await cleanup(c.id);
  assert.deepEqual(brief(done.cleanup.results), [['kept', 'kept', false], ['kept', 'kept', false], ['removed', 'deleted', true]]);
  assert.match(done.cleanup.results[0].reasons.join(' '), new RegExp(`1 個 commit 沒合進 cluster/${c.id}/merged`));
  assert.ok(branches(repo).includes(w1.branch));
  assert.equal(git(w1.worktree, 'log', '-1', '--format=%s'), 'edit late.txt');
});

test('while a worker is still working, cleaning up by hand is refused (409) and so is the plan; nothing is touched', async () => {
  const repo = makeRepo('busy');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
    await until(async () => (await getCluster(c.id)).workers.every((w) => w.status === 'running'), 5000, 'all working');
    await rejects(cleanup(c.id), 409, /工作者還在跑，先全部停止/);
    await rejects(plan(c.id), 409, /工作者還在跑/);
    assert.equal(worktrees(repo).length, 3);
    assert.equal((await getCluster(c.id)).cleanup, null);
    for (const w of c.workers) assert.equal(await hiddenOf(w.sessionId), false);
  } finally {
    hub.machine.autoReply = true;
  }
});

test('a cluster that does not exist is a 404 for all three calls', async () => {
  await rejects(cleanup('c_000000000000'), 404);
  await rejects(plan('c_000000000000'), 404);
  await rejects(unhide('c_000000000000', {}), 404);
});

test('the plan is a dry run: it says what a clean-up would do, changes nothing, and the clean-up then does exactly that', async () => {
  const repo = makeRepo('plan');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  commit(w1, 'x.txt', 'from w1\n');
  fs.writeFileSync(path.join(w2.worktree, 'scratch.txt'), 'x\n');

  const p = await plan(c.id);
  assert.equal(p.dryRun, true);
  assert.deepEqual(brief(p.results), [['kept', 'kept', false], ['kept', 'kept', false]]);
  assert.match(p.results[0].reasons.join(' '), /還沒合併過/);
  assert.match(p.results[1].reasons.join(' '), /1 項未提交/);
  assert.deepEqual(p.actions, [
    { sessionId: w1.sessionId, removeWorktree: false, deleteBranch: false, hide: false },
    { sessionId: w2.sessionId, removeWorktree: false, deleteBranch: false, hide: false },
  ], 'nothing would happen');
  assert.equal(worktrees(repo).length, 3, 'nothing was removed');
  assert.equal(branches(repo).length, 2);
  assert.equal((await getCluster(c.id)).cleanup, null, 'and nothing was recorded');
  assert.equal(await hiddenOf(w1.sessionId), false);

  fs.rmSync(path.join(w2.worktree, 'scratch.txt'));
  const p2 = await plan(c.id);
  assert.deepEqual(brief(p2.results), [['kept', 'kept', false], ['removed', 'deleted', true]]);
  assert.deepEqual(p2.actions[1], { sessionId: w2.sessionId, removeWorktree: true, deleteBranch: true, hide: true }, 'what would really be done to w2');
  const done = await cleanup(c.id);
  assert.deepEqual(done.cleanup.results, p2.results, 'what the plan said is what was done');
});

test('a git that refuses one worker leaves that worker as it was, says why, and the others are cleaned', async () => {
  const repo = makeRepo('refuse');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  hub.machine.shHook = (a) => (a.command.includes(w1.worktree) && /worktree remove/.test(a.command) ? { output: 'fatal: the disk said boom', exitCode: 128 } : null);
  let out;
  try {
    out = await cleanup(c.id);
  } finally {
    hub.machine.shHook = null;
  }
  assert.deepEqual(brief(out.cleanup.results), [['kept', 'kept', false], ['removed', 'deleted', true]]);
  assert.match(out.cleanup.results[0].reasons.join(' '), /boom/, 'the reason is git\'s own');
  assert.ok(fs.existsSync(w1.worktree) && branches(repo).includes(w1.branch), 'the refused worker is whole: worktree and branch');
  assert.ok(!fs.existsSync(w2.worktree) && !branches(repo).includes(w2.branch));
  // Not a half state in git: the kept branch is still checked out where it was.
  assert.equal(git(w1.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), w1.branch);
});

test('a worktree folder that someone already deleted: its record is dropped and its (empty) branch goes; a branch checked out in the main folder is never deleted', async () => {
  const repo = makeRepo('gone');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  fs.rmSync(w1.worktree, { recursive: true, force: true }); // deleted by hand: git still lists it
  git(repo, 'worktree', 'remove', '--force', w2.worktree);
  git(repo, 'checkout', '-q', w2.branch); // and the person looks at w2's branch in the main folder

  const planned = await plan(c.id);
  assert.deepEqual(planned.actions.map((a) => [a.removeWorktree, a.deleteBranch, a.hide]), [[false, true, true], [false, false, false]], 'a folder that is already gone is not a removal; a branch that is checked out is not deleted');
  const out = await cleanup(c.id);
  assert.deepEqual(brief(out.cleanup.results), [['removed', 'deleted', true], ['removed', 'kept', false]]);
  assert.match(out.cleanup.results[0].reasons.join(' '), /本來就不在/);
  assert.match(out.cleanup.results[1].reasons.join(' '), /檢出/);
  assert.ok(!worktrees(repo).some((p) => p.includes(w1.worktree)), 'the stale record is gone');
  assert.deepEqual(branches(repo), [w2.branch], 'the checked-out branch is still there, and the main folder is on it');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), w2.branch);
});

test('a cluster whose workers share one folder has nothing to remove: cleaning up by hand just takes the finished conversations off the sidebar', async () => {
  const repo = makeRepo('shared');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙'), isolate: false });
  await allDone(c.id);
  const out = await cleanup(c.id);
  assert.deepEqual(brief(out.cleanup.results), [[null, null, true], [null, null, true]]);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(await Promise.all(c.workers.map((w) => hiddenOf(w.sessionId))), [true, true]);
});

test('cleaning up twice is harmless: the second says the same, still hidden', async () => {
  const repo = makeRepo('twice');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲') });
  await allDone(c.id);
  const first = await cleanup(c.id);
  const second = await cleanup(c.id);
  assert.deepEqual(brief(second.cleanup.results), brief(first.cleanup.results));
  assert.deepEqual(brief(second.cleanup.results), [['removed', 'deleted', true]]);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
});

// ---------------------------------------------------------------- unhide

test('放回側欄: one worker, or all of them; the summary and the cluster say so; nothing else changes', async () => {
  const repo = makeRepo('unhide');
  const parent = await newKimi(repo);
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲', '乙') });
  await allDone(c.id);
  const [w1, w2] = c.workers;
  await cleanup(c.id);
  assert.deepEqual(await Promise.all([w1, w2].map((w) => hiddenOf(w.sessionId))), [true, true]);
  const ws = watchWs();
  await ws.ready;

  const one = await unhide(c.id, { sessionId: w1.sessionId });
  assert.deepEqual(one.workers.map((w) => w.hidden), [false, true]);
  assert.deepEqual(await Promise.all([w1, w2].map((w) => hiddenOf(w.sessionId))), [false, true]);
  assert.equal(one.cleanup.results[0].hidden, false, 'the clean-up record follows the conversation');
  await until(async () => ws.msgs.some((m) => m.t === 'session' && m.session.id === w1.sessionId && m.session.clusterHidden === false), 5000, 'the page is told');

  const all = await unhide(c.id, {});
  assert.deepEqual(all.workers.map((w) => w.hidden), [false, false]);
  assert.deepEqual(await Promise.all([w1, w2].map((w) => hiddenOf(w.sessionId))), [false, false]);
  assert.deepEqual(all.cleanup.results.map((r) => [r.worktree, r.branch]), [['removed', 'deleted'], ['removed', 'deleted']], 'the git side is as it was');
  await rejects(unhide(c.id, { sessionId: 's_nobody' }), 404);
  ws.close();
});

test('a hidden worker whose conversation moves to another runtime and back is still hidden in its new node', async () => {
  const repo = makeRepo('chain');
  const parent = await newKimi(repo);
  // (Workers sharing the folder: their conversations still have a folder to be switched in.)
  const { cluster: c } = await cluster(parent.id, { tasks: tasks('甲'), isolate: false });
  await allDone(c.id);
  const w = c.workers[0];
  await cleanup(c.id);
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const claude = groups.find((g) => g.provider === 'claude').models[0];
  const toClaude = await hub.api('POST', `/sessions/${w.sessionId}/provider`, { provider: 'claude', model: claude.id, ...(claude.efforts?.[0] ? { effort: claude.efforts[0] } : {}) });
  const back = await hub.api('POST', `/sessions/${toClaude.id}/provider`, { provider: 'kimi', model: KIMI.model, effort: KIMI.effort });
  const leaf = await snap(back.id);
  assert.notEqual(leaf.id, w.sessionId, 'a new node');
  assert.equal(leaf.clusterHidden, true, 'the new node is hidden too, or the row would reappear');
  assert.equal((await getCluster(c.id)).workers[0].hidden, true);
  // And putting it back reaches the node the sidebar shows.
  await unhide(c.id, {});
  assert.equal(Boolean((await snap(leaf.id)).clusterHidden), false);
});
