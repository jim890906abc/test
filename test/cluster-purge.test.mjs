// 完全清除 (full purge) of a finished cluster, through the REAL Hub process
// (server/index.js, its runner, cluster.js, cluster-purge.js) with only the
// outside faked: the computer's Kimi and bridge (the fake machine, whose sh.run
// really runs bash on this test machine's disk and whose Kimi conversations are
// real folders, so every worktree, branch, folder and backup below is real).
//
// What a person asked for: "when a cluster is finished, is there a clean way to
// remove it - the Agent Hub rows, the local cluster, the subagent session
// records?" What must hold at the same time (the no-loss rule): what is thrown
// away is first packed, nothing beyond the safe is thrown away unless its box is
// ticked (all off), whatever cannot be deleted is kept with the reason and the
// cluster says it is only partly purged, and the main conversation and every
// other conversation are untouched.
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
const hubs = [];

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

const machineOptions = (over = {}) => (TMP) => ({ home: path.join(TMP, 'machine-home'), capabilities: ['kimi_delete'], kimiHome: path.join(TMP, 'kimi-home'), stateDir: path.join(TMP, 'machine-state'), ...over });

async function startHub(name, { machine = machineOptions(), seed } = {}) {
  const h = await startRealHub(name, { claude: true, machine, seed });
  hubs.push(h);
  await h.setDeepseekKey();
  h.machine.shEnv = { ...GIT_ENV, HOME: h.TMP };
  const { groups } = await h.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  return h;
}

function makeRepo(h, name) {
  const dir = path.join(h.TMP, `${name}-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const snap = (h, id) => h.api('GET', `/sessions/${id}`);
const newKimi = (h, cwd, extra = {}) => h.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const cluster = (h, id, body) => h.api('POST', `/sessions/${id}/cluster`, body);
const getCluster = (h, cid) => h.api('GET', `/clusters/${cid}`);
const plan = (h, cid, q = '') => h.api('GET', `/clusters/${cid}/purge/plan${q}`);
const purge = (h, cid, body = {}) => h.api('POST', `/clusters/${cid}/purge`, body);
const tasks = (...titles) => titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` }));
const allDone = (h, cid) => until(async () => {
  const c = await getCluster(h, cid);
  return c.status === 'done' && c.workers.every((w) => w.finishedAt) && c;
}, 15000, `cluster ${cid} done`);
const rejects = async (promise, status, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected a ${status}, got success`);
  assert.equal(err.status, status, `${err.message}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
};
const gone404 = (h, cid) => rejects(getCluster(h, cid), 404);

const worktrees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
const branches = (repo) => git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
const siblings = (repo) => fs.readdirSync(path.dirname(repo)).filter((n) => n.startsWith(`${path.basename(repo)}-cluster-`));
const commit = (w, file, text, msg = `edit ${file}`) => {
  fs.writeFileSync(path.join(w.worktree, file), text);
  git(w.worktree, 'add', '-A');
  git(w.worktree, 'commit', '-q', '-m', msg);
};
const kimiOf = async (h, w) => (await snap(h, w.sessionId)).kimiSessionId;

// A cluster of three workers in a repo, in the state a purge meets most often:
//   w1 committed a.txt (goes into the merge)          -> branch safe (in the merged branch)
//   w2 committed a.txt differently (conflicts)         -> branch NOT merged, worktree clean
//   w3 left an untracked file                          -> worktree dirty, branch = the main HEAD
// and the merge was made (cluster/<id>/merged exists). No automatic clean-up ran (w2 did not go in).
async function threeWorkers(h, name, { merge = true } = {}) {
  const repo = makeRepo(h, name);
  const parent = await newKimi(h, repo);
  const { cluster: c } = await cluster(h, parent.id, { tasks: tasks('甲', '乙', '丙') });
  await allDone(h, c.id);
  const [w1, w2, w3] = c.workers;
  commit(w1, 'a.txt', 'one\nFROM-W1\nthree\n');
  commit(w2, 'a.txt', 'one\nFROM-W2\nthree\n');
  fs.writeFileSync(path.join(w3.worktree, 'scratch.txt'), 'not committed\n');
  if (merge) {
    const m = await h.api('POST', `/clusters/${c.id}/merge`);
    assert.deepEqual(m.merge.results.map((r) => r.ok), [true, false, true], 'the premise: w2 clashed, the others went in');
    assert.equal(m.cleanup, null, 'the premise: no automatic clean-up (not every worker went in)');
  }
  return { repo, parent, c, w1, w2, w3 };
}

function watchWs(h) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.PORT}/ws`);
  const msgs = [];
  ws.on('message', (d) => {
    try {
      msgs.push(JSON.parse(d));
    } catch {}
  });
  return { msgs, ready: new Promise((r) => ws.on('open', r)), close: () => ws.close() };
}

// A list of the entries of a tar.gz (the system tar reads what the connector's tar wrote and what the Hub's own writer wrote).
const tarList = (file) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
const tarRead = (file, member) => execFileSync('tar', ['-xzOf', file, member], { encoding: 'utf8' });

before(async () => {
  hub = await startHub('cluster-purge');
});
after(async () => {
  for (const h of hubs.reverse()) await h.stop();
});

// ------------------------------------------------------------------ the plan

test('the dry run lists what a purge would do and changes nothing: conversations with their Kimi sessions, worktrees with what is in them, branches, the merged branch, the memory, and where the backup goes', async () => {
  const { repo, c, w1, w2, w3 } = await threeWorkers(hub, 'plan');
  const kids = await Promise.all([w1, w2, w3].map((w) => kimiOf(hub, w)));
  const p = await plan(hub, c.id);
  assert.equal(p.dryRun, true);
  assert.equal(p.clusterId, c.id);
  assert.equal(p.name, '甲 等 3 條');
  assert.equal(p.days, 7);
  assert.equal(p.connector.canDeleteKimi, true);
  assert.equal(p.connector.trashDir, path.join(hub.TMP, 'machine-state', 'trash'));
  assert.equal(p.connector.note, null);
  assert.deepEqual(p.workers.map((w) => w.sessionId), [w1, w2, w3].map((w) => w.sessionId));
  for (const w of p.workers) assert.deepEqual([w.exists, w.conversation.hubNodes, w.conversation.kimiSessions], [true, 1, 1]);
  assert.deepEqual(p.workers.map((w) => [w.facts.dirty, w.facts.safe, w.facts.unique]), [[0, 'merged', 0], [0, '', 1], [1, 'merged', 0]], 'what git says of each worktree and branch');
  assert.deepEqual(p.merged, { branch: `cluster/${c.id}/merged`, exists: true, tip: git(repo, 'rev-parse', `cluster/${c.id}/merged`), decision: { state: 'keep', reason: '沒勾「也刪除合併分支」，所以保留' } });
  assert.equal(p.memory.exists, true);
  assert.ok(p.memory.dir.endsWith(`/agent-hub-cluster/${c.id}`));
  assert.deepEqual(p.totals, { workers: 3, conversations: 3, kimiSessions: 3, kimiSubagents: 0, worktrees: 3, dirtyWorktrees: 1, branches: 3, unmergedBranches: 1 });
  // With no box ticked.
  assert.deepEqual(p.workers.map((w) => [w.decision.worktree, w.decision.branch]), [['remove', 'delete'], ['remove', 'keep'], ['keep', 'keep']]);
  // The boxes change what it would do, and the dry run says so.
  const all = await plan(hub, c.id, '?discardDirty=1&deleteUnmerged=1&deleteMerged=1');
  assert.deepEqual(all.workers.map((w) => [w.decision.worktree, w.decision.branch]), [['remove', 'delete'], ['remove', 'delete-unmerged'], ['discard', 'delete']]);
  assert.equal(all.merged.decision.state, 'delete');
  assert.deepEqual(all.options, { discardDirty: true, deleteUnmerged: true, deleteMerged: true, noBackup: false });

  // Nothing was touched: the conversations, Kimi's folders, worktrees, branches, memory, the record, no trash.
  for (const w of [w1, w2, w3]) assert.ok(await snap(hub, w.sessionId));
  for (const kid of kids) assert.ok(fs.existsSync(hub.machine.dirOf(kid)), 'Kimi\'s folder is still there');
  assert.equal(worktrees(repo).length, 4);
  assert.equal(branches(repo).length, 4);
  assert.equal((await getCluster(hub, c.id)).status, 'done');
  assert.equal(hub.machine.deleted.length, 0);
  assert.ok(!fs.existsSync(path.join(hub.TMP, 'machine-state')), 'no backup folder was made');
  assert.ok(!fs.existsSync(path.join(hub.DATA, 'trash')));
});

// ------------------------------------------------------------- the three boxes

test('with no box ticked a purge takes the conversations, the clean worktrees, the safe branches and the memory, and KEEPS the dirty worktree, the branch with unmerged commits and the merged branch - each with its reason', async () => {
  const { repo, parent, c, w1, w2, w3 } = await threeWorkers(hub, 'defaults');
  const kids = await Promise.all([w1, w2, w3].map((w) => kimiOf(hub, w)));
  const before = await snap(hub, parent.id);
  const memoryDir = (await plan(hub, c.id)).memory.dir;

  const out = await purge(hub, c.id);
  assert.equal(out.aborted, false);
  assert.deepEqual(out.options, { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false });
  assert.deepEqual(out.workers.map((w) => [w.conversation, w.worktree, w.branch]), [['deleted', 'removed', 'deleted'], ['deleted', 'removed', 'kept'], ['deleted', 'kept', 'kept']]);
  assert.match(out.workers[1].reasons.join(' '), /1 個 commit 沒合併進去.*沒勾/);
  assert.match(out.workers[2].reasons.join(' '), /1 項未提交.*沒勾/);
  assert.deepEqual([out.merged.state, out.merged.branch], ['kept', `cluster/${c.id}/merged`]);
  assert.match(out.merged.reason, /沒勾/);
  assert.equal(out.memory.state, 'deleted');
  assert.deepEqual(out.failed, [], 'kept by an unticked box is not a failure');
  assert.equal(out.partial, false);
  assert.equal(out.removed, true);
  assert.equal(out.kept.length, 4, 'the dirty worktree, its branch, the unmerged branch, the merged branch are said');

  // The disk: the clean worktrees are gone, the kept ones are exactly as they were.
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), fs.realpathSync(w3.worktree)].sort());
  assert.equal(fs.readFileSync(path.join(w3.worktree, 'scratch.txt'), 'utf8'), 'not committed\n', 'the uncommitted file is untouched');
  assert.deepEqual(branches(repo), [w2.branch, w3.branch, `cluster/${c.id}/merged`].sort());
  assert.ok(!fs.existsSync(memoryDir), 'the memory folder is gone');
  assert.deepEqual(siblings(repo), [path.basename(path.dirname(w3.worktree))], 'the cluster\'s folder stays while a worktree is in it');
  // The conversations: the Hub's records, Kimi's folders.
  for (const w of [w1, w2, w3]) await rejects(snap(hub, w.sessionId), 404);
  for (const kid of kids) assert.ok(!fs.existsSync(hub.machine.dirOf(kid)), 'Kimi\'s folder (subagents inside it) is gone');
  assert.deepEqual([...hub.machine.deleted].sort(), [...kids].sort());
  assert.deepEqual(hub.machine.archived, [], ':delete, not :archive');
  // The cluster itself.
  await gone404(hub, c.id);
  assert.ok(!(await hub.api('GET', '/clusters')).some((r) => r.id === c.id));
  assert.ok(!fs.existsSync(path.join(hub.DATA, 'clusters', `${c.id}.json`)));
  // The main conversation: as it was (its list of clusters no longer names this one).
  const after = await snap(hub, parent.id);
  assert.deepEqual(after.events, before.events, 'no event was added or changed');
  assert.equal(after.title, before.title);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.clusterIds || [], (before.clusterIds || []).filter((id) => id !== c.id));
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the project\'s own folder is untouched');
});

test('"也丟掉未提交的修改" lets go of the dirty worktree (and with it the branch) - and only that', async () => {
  const { repo, c, w3 } = await threeWorkers(hub, 'box-dirty');
  const out = await purge(hub, c.id, { discardDirty: true });
  assert.deepEqual(out.workers.map((w) => [w.worktree, w.branch]), [['removed', 'deleted'], ['removed', 'kept'], ['discarded', 'deleted']]);
  assert.ok(!fs.existsSync(w3.worktree));
  assert.deepEqual(branches(repo), [c.workers[1].branch, `cluster/${c.id}/merged`].sort(), 'the unmerged branch and the merged branch are still kept');
  assert.ok(out.removed);
});

test('"也刪除沒合併進去的分支" deletes the branch whose commits are nowhere else - and only that', async () => {
  const { repo, c, w3 } = await threeWorkers(hub, 'box-unmerged');
  const tip = git(repo, 'rev-parse', c.workers[1].branch);
  const out = await purge(hub, c.id, { deleteUnmerged: true });
  assert.deepEqual(out.workers.map((w) => [w.worktree, w.branch]), [['removed', 'deleted'], ['removed', 'deleted'], ['kept', 'kept']]);
  assert.deepEqual(branches(repo), [w3.branch, `cluster/${c.id}/merged`].sort());
  assert.ok(fs.existsSync(w3.worktree), 'the dirty worktree stays');
  assert.equal(tryGit(repo, 'rev-parse', '--verify', '-q', tip), tip, 'git still has the commit object (a backup holds it too)');
});

test('"也刪除合併分支" deletes cluster/<id>/merged - and only that', async () => {
  const { repo, c, w2, w3 } = await threeWorkers(hub, 'box-merged');
  const out = await purge(hub, c.id, { deleteMerged: true });
  assert.deepEqual([out.merged.state, out.merged.branch], ['deleted', `cluster/${c.id}/merged`]);
  assert.deepEqual(branches(repo), [w2.branch, w3.branch].sort());
  assert.ok(fs.existsSync(w3.worktree));
});

test('all three ticked: nothing of the cluster is left on the computer, and the project folder is as it was', async () => {
  const { repo, parent, c, w1 } = await threeWorkers(hub, 'box-all');
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true, deleteMerged: true });
  assert.deepEqual(out.workers.map((w) => [w.conversation, w.worktree, w.branch]), [['deleted', 'removed', 'deleted'], ['deleted', 'removed', 'deleted'], ['deleted', 'discarded', 'deleted']]);
  assert.deepEqual(out.kept, []);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(branches(repo), []);
  assert.deepEqual(siblings(repo), [], 'the cluster\'s folder beside the project is gone too');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  await gone404(hub, c.id);
  assert.ok(await snap(hub, parent.id), 'the main conversation is still there');
  assert.ok(!fs.existsSync(path.dirname(w1.worktree)));
});

// -------------------------------------------------------------------- backups

test('the backup is made first and really holds what is deleted: Kimi\'s folders with the subagent journals, the memory, and (for the boxes ticked) the uncommitted changes and the branches; the Hub\'s side holds the conversation files and the record; both are kept 7 days and listed', async () => {
  const { repo, c, w1, w2, w3 } = await threeWorkers(hub, 'backup');
  const kids = await Promise.all([w1, w2, w3].map((w) => kimiOf(hub, w)));
  await hub.api('POST', `/clusters/${c.id}/memory`, { text: '決定：BACKUP_MARK 用 tabs' });
  const t0 = Date.now();
  const w2tip = git(repo, 'rev-parse', c.workers[1].branch);
  const out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true, deleteMerged: true });
  assert.equal(out.backup.enabled, true);
  assert.equal(out.backup.days, 7);
  assert.ok(Math.abs(out.backup.expiresAt - (t0 + 7 * 24 * 3600 * 1000)) < 120_000, 'kept 7 days');

  // The computer's file.
  const mach = out.backup.machine;
  assert.equal(path.dirname(mach.path), path.join(hub.TMP, 'machine-state', 'trash'));
  assert.match(path.basename(mach.path), new RegExp(`^cluster-${c.id}-\\d{8}-\\d{6}\\.tar\\.gz$`));
  assert.ok(fs.existsSync(mach.path) && fs.statSync(mach.path).size === mach.bytes && mach.bytes > 0);
  assert.equal(fs.statSync(mach.path).mode & 0o077, 0, 'private to the user');
  const list = tarList(mach.path);
  for (const kid of kids) {
    const rel = path.relative('/', hub.machine.dirOf(kid));
    assert.ok(list.includes(`${rel}/agents/main/wire.jsonl`), 'the conversation\'s journal');
    assert.ok(list.includes(`${rel}/agents/agent-0/wire.jsonl`), 'and its subagent\'s');
    assert.equal(tarRead(mach.path, `${rel}/agents/agent-0/wire.jsonl`), `{"type":"subagent","session":"${kid}"}\n`, 'with what was in it');
  }
  const memRel = path.relative('/', c.memory.path);
  assert.ok(tarRead(mach.path, memRel).includes('BACKUP_MARK'), 'the memory file, with the decision');
  assert.ok(list.includes('MANIFEST.txt'));
  assert.match(tarRead(mach.path, 'MANIFEST.txt'), new RegExp(c.id));
  // The dirty worktree's content, and the commits of the branches deleted.
  assert.ok(list.includes('extras/w3-uncommitted.patch'));
  const untracked = path.join(hub.TMP, 'check-untracked.tar.gz');
  fs.writeFileSync(untracked, execFileSync('tar', ['-xzOf', mach.path, 'extras/w3-untracked.tar.gz']));
  assert.deepEqual(tarList(untracked), ['scratch.txt'], 'the uncommitted file is packed');
  assert.ok(list.includes('extras/branches.bundle'));
  const bundle = path.join(hub.TMP, 'check.bundle');
  fs.writeFileSync(bundle, execFileSync('tar', ['-xzOf', mach.path, 'extras/branches.bundle']));
  const heads = git(repo, 'bundle', 'list-heads', bundle);
  assert.ok(heads.includes(w2tip), 'the unmerged commit is in the bundle, so deleting the branch lost nothing');

  // The Hub's file.
  const h = out.backup.hub;
  const hubFile = path.join(hub.DATA, 'trash', h.file);
  assert.ok(fs.existsSync(hubFile) && fs.statSync(hubFile).size === h.bytes);
  assert.equal(fs.statSync(hubFile).mode & 0o077, 0);
  const hubList = tarList(hubFile);
  for (const w of [w1, w2, w3]) assert.ok(hubList.includes(`sessions/${w.sessionId}.json`), 'a worker\'s conversation file');
  assert.ok(hubList.includes(`clusters/${c.id}.json`));
  assert.equal(JSON.parse(tarRead(hubFile, `clusters/${c.id}.json`)).id, c.id);
  assert.equal(JSON.parse(tarRead(hubFile, `sessions/${w1.sessionId}.json`)).clusterId, c.id);
  assert.equal(JSON.parse(tarRead(hubFile, 'MANIFEST.json')).clusterId, c.id);

  // Listed, with the paths and the expiry.
  const listed = await hub.api('GET', '/clusters/trash');
  assert.equal(listed.days, 7);
  const mine = listed.items.find((i) => i.clusterId === c.id);
  assert.ok(mine);
  assert.equal(mine.name, '甲 等 3 條');
  assert.equal(mine.machine.path, mach.path);
  assert.equal(mine.hub.file, h.file);
  assert.equal(mine.expiresAt, out.backup.expiresAt);
});

test('no backup ticked off ("不留備份"): nothing is packed and nothing is listed, and the deletion goes on the same', async () => {
  const { c, w1 } = await threeWorkers(hub, 'nobackup', { merge: false });
  const before = fs.existsSync(path.join(hub.DATA, 'trash')) ? fs.readdirSync(path.join(hub.DATA, 'trash')).length : 0;
  const out = await purge(hub, c.id, { noBackup: true });
  assert.equal(out.backup.enabled, false);
  assert.equal(out.backup.machine, null);
  assert.equal(out.backup.hub, null);
  assert.equal(out.removed, true);
  await rejects(snap(hub, w1.sessionId), 404);
  const after = fs.existsSync(path.join(hub.DATA, 'trash')) ? fs.readdirSync(path.join(hub.DATA, 'trash')).length : 0;
  assert.equal(after, before, 'no file added to the Hub\'s trash');
});

test('a backup that cannot be made means nothing is deleted - on the computer or in the Hub - and the reason is given; the cluster is whole and can be purged once the fault is gone', async () => {
  const { repo, parent, c, w1, w2, w3 } = await threeWorkers(hub, 'backupfail');
  const kids = await Promise.all([w1, w2, w3].map((w) => kimiOf(hub, w)));
  const deletedBefore = hub.machine.deleted.length;
  hub.machine.shHook = (a) => (a.command.includes('ahpurge') ? { output: 'AHC_ERR=沒有空間了', exitCode: 30 } : null);
  let out;
  try {
    out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true, deleteMerged: true });
  } finally {
    hub.machine.shHook = null;
  }
  assert.equal(out.aborted, true);
  assert.match(out.reason, /備份沒有做成，所以什麼都沒有刪.*沒有空間了/);
  // Everything is where it was.
  assert.equal(worktrees(repo).length, 4);
  assert.equal(branches(repo).length, 4);
  for (const w of [w1, w2, w3]) assert.ok(await snap(hub, w.sessionId));
  for (const kid of kids) assert.ok(fs.existsSync(hub.machine.dirOf(kid)));
  assert.deepEqual(hub.machine.deleted.slice(deletedBefore), []);
  assert.equal(fs.readFileSync(path.join(w3.worktree, 'scratch.txt'), 'utf8'), 'not committed\n');
  const still = await getCluster(hub, c.id);
  assert.equal(still.status, 'done', 'not left in "purging"');
  assert.equal(still.purge, null);
  assert.ok(await snap(hub, parent.id));
  assert.ok(!fs.readdirSync(path.join(hub.DATA, 'trash')).some((f) => f.includes(c.id)), 'the Hub\'s half of the backup is not left behind');
  // The fault is gone: it goes through.
  assert.equal((await purge(hub, c.id)).removed, true);
});

test('the Hub\'s half of the backup failing also stops everything, and the computer\'s half is not left behind', async () => {
  const { repo, c, w1 } = await threeWorkers(hub, 'backupfail-hub', { merge: false });
  const trashDir = path.join(hub.DATA, 'trash');
  fs.rmSync(trashDir, { recursive: true, force: true });
  fs.writeFileSync(trashDir, 'a file where the folder should be');
  let out;
  try {
    out = await purge(hub, c.id);
  } finally {
    fs.rmSync(trashDir, { force: true });
  }
  assert.equal(out.aborted, true);
  assert.match(out.reason, /備份沒有做成/);
  assert.ok(await snap(hub, w1.sessionId));
  assert.equal(worktrees(repo).length, 4);
  const machineTrash = path.join(hub.TMP, 'machine-state', 'trash');
  assert.ok(!fs.existsSync(machineTrash) || !fs.readdirSync(machineTrash).some((f) => f.includes(c.id)));
  await purge(hub, c.id, { noBackup: true });
});

// ------------------------------------------------------------- failure and retry

test('one worker\'s Kimi conversation that will not delete is kept (Hub record too) with the reason, the rest goes, the cluster stays marked as partly purged - and pressing again finishes it', async () => {
  const { parent, c, w1, w2, w3, repo } = await threeWorkers(hub, 'partial', { merge: false });
  const kid2 = await kimiOf(hub, w2);
  hub.machine.deleteFails.set(kid2, { code: 50001, msg: 'disk is busy', sticky: true });
  const ws = watchWs(hub);
  await ws.ready;
  const out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.equal(out.partial, true);
  assert.equal(out.removed, false);
  assert.deepEqual(out.workers.map((w) => w.conversation), ['deleted', 'kept', 'deleted']);
  assert.match(out.workers[1].reasons.join(' '), /disk is busy/);
  assert.match(out.failed[0], /w2「乙」的對話.*disk is busy/);
  // w2's Hub record is still there so it can be tried again; the others are gone.
  assert.ok(await snap(hub, w2.sessionId));
  await rejects(snap(hub, w1.sessionId), 404);
  await rejects(snap(hub, w3.sessionId), 404);
  assert.ok(fs.existsSync(hub.machine.dirOf(kid2)), 'its Kimi folder is untouched');
  // The cluster stays, says so, and is not "purging" any more.
  const c2 = await getCluster(hub, c.id);
  assert.notEqual(c2.status, 'purging');
  assert.equal(c2.purge.partial, true);
  assert.match(c2.purge.failed[0], /w2/);
  assert.deepEqual(c2.workers.map((w) => w.status === 'deleted'), [true, false, true]);
  assert.ok((await hub.api('GET', '/clusters')).some((r) => r.id === c.id && r.purgePartial === true));
  assert.ok(await snap(hub, parent.id));
  // (the rest of the work was done anyway: the worktrees and the branches of the others)
  assert.ok(!fs.existsSync(w1.worktree) && !fs.existsSync(w3.worktree));
  await until(async () => ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.purge?.partial), 5000, 'the page is told it is partly purged');
  ws.close();

  // The fault is gone: again, and it completes - what was deleted is not asked for twice.
  hub.machine.deleteFails.clear();
  const again = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.equal(again.removed, true);
  assert.equal(again.partial, false);
  assert.deepEqual(again.workers.map((w) => w.conversation), ['gone', 'deleted', 'gone']);
  assert.ok(!fs.existsSync(hub.machine.dirOf(kid2)));
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(branches(repo), []);
  await gone404(hub, c.id);
});

test('a Kimi conversation that is already gone from the computer counts as deleted (40401 is not a failure)', async () => {
  const { c, w1, w2 } = await threeWorkers(hub, 'kimigone', { merge: false });
  const kid1 = await kimiOf(hub, w1);
  hub.machine.sessions.delete(kid1);
  fs.rmSync(hub.machine.dirOf(kid1), { recursive: true, force: true });
  const out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.equal(out.removed, true);
  assert.deepEqual(out.workers[0].kimi, { deleted: 0, archived: 0, gone: 1, failed: 0 });
  assert.deepEqual(out.workers.map((w) => w.conversation), ['deleted', 'deleted', 'deleted']);
  await rejects(snap(hub, w2.sessionId), 404);
});

test('a worktree git will not remove is kept with git\'s reason, the branch with it, and the purge is partial; the main conversation is not touched', async () => {
  const { repo, parent, c, w1 } = await threeWorkers(hub, 'gitrefuse', { merge: false });
  // A lock git honours: `git worktree remove` refuses a locked worktree.
  git(repo, 'worktree', 'lock', w1.worktree);
  const out = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.equal(out.partial, true);
  assert.deepEqual([out.workers[0].worktree, out.workers[0].branch], ['kept', 'kept']);
  assert.match(out.workers[0].reasons.join(' '), /git 拒絕移除 worktree.*lock/i);
  assert.match(out.workers[0].reasons.join(' '), /分支還被保留下來的 worktree 使用中/);
  assert.ok(fs.existsSync(w1.worktree));
  assert.equal(await getCluster(hub, c.id).then((x) => x.purge.partial), true);
  assert.ok(await snap(hub, parent.id));
  git(repo, 'worktree', 'unlock', w1.worktree);
  const again = await purge(hub, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.equal(again.reason, '');
  assert.deepEqual(again.failed, []);
  assert.equal(again.removed, true);
});

// ------------------------------------------------------------------- refusals

test('a cluster that is still running is refused with 409 "先全部停止", the dry run and the purge alike, and nothing changes', async () => {
  const repo = makeRepo(hub, 'running');
  const parent = await newKimi(hub, repo);
  hub.machine.autoReply = false;
  let c;
  try {
    c = (await cluster(hub, parent.id, { tasks: tasks('甲', '乙') })).cluster;
    await until(async () => (await getCluster(hub, c.id)).workers.some((w) => w.status === 'running'), 8000, 'a worker running');
    const deletedBefore = hub.machine.deleted.length;
    await rejects(plan(hub, c.id), 409, /先全部停止/);
    await rejects(purge(hub, c.id), 409, /先全部停止/);
    assert.equal((await getCluster(hub, c.id)).purge, null);
    assert.equal(hub.machine.deleted.length, deletedBefore);
    assert.equal(worktrees(repo).length, 3, 'the worktrees are there');
  } finally {
    hub.machine.autoReply = true;
  }
  const kids = await Promise.all(c.workers.map((w) => kimiOf(hub, w)));
  await hub.api('POST', `/clusters/${c.id}/stop`);
  for (const k of kids) hub.machine.frame(k, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
  await until(async () => (await getCluster(hub, c.id)).status === 'stopped', 8000, 'stopped');
  assert.equal((await purge(hub, c.id, { noBackup: true })).removed, true, 'after the stop it goes');
});

test('a computer that is offline is refused with 409 and nothing is touched; an unknown cluster is 404; a second purge while one runs is 409', async () => {
  await rejects(purge(hub, 'c_000000000000'), 404);
  await rejects(plan(hub, 'c_000000000000'), 404);
  const { c, w1 } = await threeWorkers(hub, 'concurrent', { merge: false });
  // Two at once: the second is turned away while the first works.
  hub.machine.shHook = async (a) => {
    if (a.command.includes('ahpurge')) await new Promise((r) => setTimeout(r, 600));
    return null;
  };
  try {
    const first = purge(hub, c.id, { noBackup: false });
    await until(async () => (await getCluster(hub, c.id)).status === 'purging', 5000, 'purging');
    await rejects(purge(hub, c.id), 409, /正在清除/);
    await rejects(hub.api('POST', `/clusters/${c.id}/cleanup`), 409);
    await rejects(hub.api('POST', `/clusters/${c.id}/merge`), 409);
    assert.equal((await first).removed, true);
  } finally {
    hub.machine.shHook = null;
  }
  await rejects(snap(hub, w1.sessionId), 404);
});

// ------------------------------------------------------------ other conversations

test('other clusters of the same main conversation, the main conversation and an unrelated conversation are untouched, and the page is told the cluster is gone', async () => {
  const repo = makeRepo(hub, 'others');
  const parent = await newKimi(hub, repo);
  const other = await newKimi(hub, repo);
  const { cluster: keep } = await cluster(hub, parent.id, { tasks: tasks('留下的') });
  const { cluster: gone } = await cluster(hub, parent.id, { tasks: tasks('要清的') });
  await Promise.all([allDone(hub, keep.id), allDone(hub, gone.id)]);
  const keepKid = await kimiOf(hub, keep.workers[0]);
  const otherBefore = await snap(hub, other.id);
  const parentBefore = await snap(hub, parent.id);
  const ws = watchWs(hub);
  await ws.ready;
  await purge(hub, gone.id, { discardDirty: true, deleteUnmerged: true });
  await until(async () => ws.msgs.some((m) => m.t === 'cluster.removed' && m.id === gone.id), 5000, 'the cluster.removed message');
  await until(async () => ws.msgs.some((m) => m.t === 'session' && m.session.id === parent.id && !(m.session.clusterIds || []).includes(gone.id)), 5000, 'the main conversation\'s summary without it');
  assert.ok(ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === gone.id && m.cluster.status === 'purging'), 'the page saw it purging');
  ws.close();
  // Untouched.
  assert.deepEqual((await snap(hub, other.id)).events, otherBefore.events);
  assert.deepEqual((await snap(hub, parent.id)).events, parentBefore.events);
  assert.ok(fs.existsSync(hub.machine.dirOf(keepKid)));
  assert.ok(await snap(hub, keep.workers[0].sessionId));
  assert.equal((await getCluster(hub, keep.id)).status, 'done');
  assert.deepEqual((await snap(hub, parent.id)).clusterIds, [keep.id]);
  assert.deepEqual((await hub.api('GET', `/sessions/${parent.id}/clusters`)).map((x) => x.id), [keep.id]);
  assert.ok(fs.existsSync(keep.workers[0].worktree), 'the other cluster\'s worktree is where it was');
});

test('a cluster whose workers share the project folder (not a git project) is purged too: no worktree to remove, the memory folder and the .gitignore made for it go', async () => {
  const folder = path.join(hub.TMP, 'plain-folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine\n');
  const parent = await newKimi(hub, folder);
  const { cluster: c } = await cluster(hub, parent.id, { tasks: tasks('甲', '乙') });
  await allDone(hub, c.id);
  assert.ok(fs.existsSync(path.join(folder, '.agent-hub-cluster', c.id, 'memory.md')), 'the premise');
  const out = await purge(hub, c.id);
  assert.equal(out.removed, true);
  assert.deepEqual(out.workers.map((w) => [w.worktree, w.branch]), [['none', 'none'], ['none', 'none']]);
  assert.deepEqual(fs.readdirSync(folder), ['notes.txt'], 'the project folder holds what it held');
});

// --------------------------------------------------------------- an older connector

test('an older connector (no kimi_delete): the Kimi conversations are archived, not deleted, the page is told why and what to do, and the rest of the purge goes on', async () => {
  const old = await startHub('cluster-purge-old', { machine: machineOptions({ capabilities: [] }) });
  const { repo, c, w1, w2, w3 } = await threeWorkers(old, 'old', { merge: false });
  const kids = await Promise.all([w1, w2, w3].map((w) => kimiOf(old, w)));
  const p = await plan(old, c.id);
  assert.equal(p.connector.canDeleteKimi, false);
  assert.match(p.connector.note, /連接器太舊.*只能封存.*重新執行連接指令/);
  assert.equal(p.connector.trashDir, path.join(old.TMP, 'machine-home', '.agent-hub', 'trash'), 'the default place of an old connector\'s state');
  const out = await purge(old, c.id, { discardDirty: true, deleteUnmerged: true });
  assert.match(out.connectorNote, /連接器太舊，Kimi 紀錄只能封存、不能刪除；重新執行連接指令更新後才能完全刪除/);
  assert.deepEqual(out.workers.map((w) => w.conversation), ['archived', 'archived', 'archived']);
  assert.deepEqual([...old.machine.archived].sort(), [...kids].sort());
  assert.deepEqual(old.machine.deleted, [], 'never asked an old connector for :delete');
  for (const kid of kids) assert.ok(fs.existsSync(old.machine.dirOf(kid)), 'archived, so the record is still on the computer');
  assert.equal(out.removed, true, 'the Hub\'s side is purged all the same');
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  // The backup still holds the memory (the Kimi folders are not deleted, so they are not packed).
  const list = tarList(out.backup.machine.path);
  assert.ok(list.some((e) => e.endsWith('/memory.md')));
  assert.ok(!list.some((e) => e.includes('wire.jsonl')));
  assert.equal(path.dirname(out.backup.machine.path), path.join(old.TMP, 'machine-home', '.agent-hub', 'trash'));
});
