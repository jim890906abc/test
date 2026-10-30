// A Hub restart in the middle of a cluster: the cluster comes back from disk
// (data/clusters/<id>.json), its workers are still its workers, and what each
// worker has been told of the memory file is remembered, so a worker is not
// told the same decision again after the restart - and is told the one added
// while the Hub was down.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRealHub, until } from './fixtures/real-hub.mjs';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

const hubs = [];
after(async () => {
  for (const h of hubs.reverse()) await h.stop();
});

async function start(name, from = null) {
  const hub = await startRealHub(name, { seed: (DATA) => from && fs.cpSync(from, DATA, { recursive: true }) });
  hubs.push(hub);
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  return hub;
}

const snap = (hub, id) => hub.api('GET', `/sessions/${id}`);
async function say(hub, id, text) {
  const known = new Set((await snap(hub, id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(hub, id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}
const reminders = (hub, kid) => hub.machine.prompts.filter((p) => p.sid === kid).at(-1).body.content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text);

test('a cluster survives a Hub restart: record, workers, what each worker was told of the memory, and the merge', async () => {
  const first = await start('cluster-restart-1');
  const repo = path.join(first.TMP, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const { groups } = await first.api('GET', '/models?machine=m_fake');
  const m = groups.find((g) => g.provider === 'kimi').models[0];
  const parent = await first.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_fake', cwd: repo, model: m.id, effort: m.efforts[0], permission: 'auto' });
  const { cluster: c } = await first.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '甲', prompt: '做甲' }, { title: '乙', prompt: '做乙' }] });
  await until(async () => (await first.api('GET', `/clusters/${c.id}`)).status === 'done', 15000, 'done');
  const w1 = c.workers[0];

  // Decision A is told to w1 before the restart; decision B is added after.
  await first.api('POST', `/clusters/${c.id}/memory`, { text: '決定甲 DECISION_A' });
  await say(first, w1.sessionId, '重啟前的話');
  assert.ok(reminders(first, (await snap(first, w1.sessionId)).kimiSessionId).some((t) => t.includes('DECISION_A')), 'the premise: w1 was told A');
  fs.writeFileSync(path.join(w1.worktree, 'new.txt'), 'from w1\n');
  git(w1.worktree, 'add', '-A');
  git(w1.worktree, 'commit', '-q', '-m', 'w1');

  await first.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-keep-'));
  fs.cpSync(first.DATA, keep, { recursive: true });
  assert.ok(fs.existsSync(path.join(keep, 'clusters', `${c.id}.json`)), 'the record is on disk');

  const second = await start('cluster-restart-2', keep);
  fs.rmSync(keep, { recursive: true, force: true });
  for (const [sid, st] of first.machine.sessions.entries()) second.machine.add(sid, { ...st, history: (st.history || []).map((h) => ({ ...h })) });
  second.machine.pushSessions();
  await until(async () => (await second.api('GET', '/sessions')).some((s) => s.id === w1.sessionId), 10000, 'the conversations back');

  const back = await second.api('GET', `/clusters/${c.id}`);
  assert.equal(back.id, c.id);
  assert.equal(back.parentId, parent.id);
  assert.deepEqual(back.workers.map((w) => [w.sessionId, w.title, w.branch, w.worktree]), c.workers.map((w) => [w.sessionId, w.title, w.branch, w.worktree]));
  assert.equal(back.status, 'done', 'finished workers stay finished');
  assert.ok(back.workers.every((w) => w.finishedAt));
  assert.deepEqual((await second.api('GET', `/sessions/${parent.id}/clusters`)).map((x) => x.id), [c.id]);
  assert.equal((await snap(second, w1.sessionId)).clusterId, c.id);
  assert.deepEqual((await snap(second, parent.id)).clusterIds, [c.id]);

  await second.api('POST', `/clusters/${c.id}/memory`, { text: '決定乙 DECISION_B' });
  await say(second, w1.sessionId, '重啟後的話');
  const told = reminders(second, (await snap(second, w1.sessionId)).kimiSessionId).filter((t) => t.includes(c.memory.path));
  assert.equal(told.length, 1);
  assert.ok(told[0].includes('DECISION_B') && !told[0].includes('DECISION_A'), 'only what was added since, not what it was told before the restart');
  const w2 = c.workers[1];
  await say(second, w2.sessionId, '乙重啟後的話');
  const told2 = reminders(second, (await snap(second, w2.sessionId)).kimiSessionId).filter((t) => t.includes(c.memory.path));
  assert.ok(told2[0].includes('DECISION_A') && told2[0].includes('DECISION_B'), 'the worker that had been told nothing is told both');

  const merged = await second.api('POST', `/clusters/${c.id}/merge`);
  assert.equal(merged.merge.results[0].ok, true);
  assert.equal(git(repo, 'show', `${merged.merge.branch}:new.txt`), 'from w1');
  // The merge result is kept on the record.
  assert.deepEqual((await second.api('GET', `/clusters/${c.id}`)).merge, merged.merge);
});

test('a clean-up survives a Hub restart: what was cleaned and what was kept, the workers still off the sidebar, and a second clean-up after the restart finishes the one that was kept', async () => {
  const first = await start('cluster-cleanup-restart-1');
  const repo = path.join(first.TMP, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const { groups } = await first.api('GET', '/models?machine=m_fake');
  const m = groups.find((g) => g.provider === 'kimi').models[0];
  const parent = await first.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_fake', cwd: repo, model: m.id, effort: m.efforts[0], permission: 'auto' });
  const { cluster: c } = await first.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '甲', prompt: '做甲' }, { title: '乙', prompt: '做乙' }] });
  await until(async () => (await first.api('GET', `/clusters/${c.id}`)).status === 'done', 15000, 'done');
  const [w1, w2] = c.workers;
  fs.writeFileSync(path.join(w1.worktree, 'one.txt'), 'from w1\n');
  git(w1.worktree, 'add', '-A');
  git(w1.worktree, 'commit', '-q', '-m', 'w1');
  fs.writeFileSync(path.join(w2.worktree, 'scratch.txt'), 'not committed\n'); // keeps w2's worktree
  const merged = await first.api('POST', `/clusters/${c.id}/merge`);
  assert.equal(merged.cleanup.auto, true, 'the premise: it cleaned up by itself');
  assert.deepEqual(merged.cleanup.results.map((r) => [r.worktree, r.branch, r.hidden]), [['removed', 'deleted', true], ['kept', 'kept', false]]);

  await first.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-cleanup-keep-'));
  fs.cpSync(first.DATA, keep, { recursive: true });
  const second = await start('cluster-cleanup-restart-2', keep);
  fs.rmSync(keep, { recursive: true, force: true });
  for (const [sid, st] of first.machine.sessions.entries()) second.machine.add(sid, { ...st, history: (st.history || []).map((h) => ({ ...h })) });
  second.machine.pushSessions();
  await until(async () => (await second.api('GET', '/sessions')).some((s) => s.id === w1.sessionId), 10000, 'the conversations back');

  const back = await second.api('GET', `/clusters/${c.id}`);
  assert.deepEqual(back.cleanup, merged.cleanup, 'the record of the clean-up is what it was');
  assert.deepEqual(back.workers.map((w) => w.hidden), [true, false]);
  assert.equal((await snap(second, w1.sessionId)).clusterHidden, true, 'the conversation itself is still hidden');
  assert.equal(Boolean((await snap(second, w2.sessionId)).clusterHidden), false);
  assert.deepEqual((await second.api('GET', '/sessions')).filter((s) => s.clusterRole === 'worker').map((s) => [s.id, s.clusterHidden]).sort(), [[w1.sessionId, true], [w2.sessionId, false]].sort());

  // After the restart the person cleans the scratch file away and presses 清理 again.
  fs.rmSync(path.join(w2.worktree, 'scratch.txt'));
  const again = await second.api('POST', `/clusters/${c.id}/cleanup`);
  assert.equal(again.cleanup.auto, false);
  assert.deepEqual(again.cleanup.results.map((r) => [r.worktree, r.branch, r.hidden]), [['removed', 'deleted', true], ['removed', 'deleted', true]]);
  assert.equal((await snap(second, w2.sessionId)).clusterHidden, true);
  assert.equal(git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)'), `cluster/${c.id}/merged`);
});

test('a clean-up is on disk as soon as it is done, not only when the Hub is stopped: a Hub that is killed does not lose what was cleaned or which conversations were hidden', async () => {
  const hub = await start('cluster-cleanup-disk');
  const repo = path.join(hub.TMP, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const { groups } = await hub.api('GET', '/models?machine=m_fake');
  const m = groups.find((g) => g.provider === 'kimi').models[0];
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_fake', cwd: repo, model: m.id, effort: m.efforts[0], permission: 'auto' });
  const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '甲', prompt: '做甲' }] });
  await until(async () => (await hub.api('GET', `/clusters/${c.id}`)).status === 'done', 15000, 'done');
  const file = path.join(hub.DATA, 'clusters', `${c.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cleanup ?? null, null, 'the premise: nothing cleaned yet on disk');

  const done = await hub.api('POST', `/clusters/${c.id}/cleanup`);
  assert.equal(done.cleanup.results[0].hidden, true);
  // The cluster's record, at once (a cluster's own file is written when it changes) ...
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.cleanup.auto, false);
  assert.deepEqual(onDisk.cleanup.results.map((r) => [r.worktree, r.branch]), [['removed', 'deleted']]);
  // ... and the conversation's own flag, once the Hub's short write delay has passed (nothing waits for the Hub to be stopped).
  const sessionFile = path.join(hub.DATA, 'sessions', `${c.workers[0].sessionId}.json`);
  await until(async () => JSON.parse(fs.readFileSync(sessionFile, 'utf8')).clusterHidden === true, 8000, 'the hidden flag on disk');
});

test('the queue survives a Hub restart: who did what, and what is still waiting; a turn that ended while the Hub was away is settled and the queue goes on - every task is sent once, none of the finished ones again', async () => {
  const first = await start('cluster-queue-restart-1');
  const repo = path.join(first.TMP, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const { groups } = await first.api('GET', '/models?machine=m_fake');
  const m = groups.find((g) => g.provider === 'kimi').models[0];
  const parent = await first.api('POST', '/sessions', { provider: 'kimi', machineId: 'm_fake', cwd: repo, model: m.id, effort: m.efforts[0], permission: 'auto' });
  const tasks = Array.from({ length: 6 }, (_, i) => ({ title: `任務 ${i + 1}`, prompt: `做第 ${i + 1} 條 TASK_MARK_${i}_END` }));
  const markOf = (hub, kid) => hub.machine.prompts.filter((p) => p.sid === kid).map((p) => /TASK_MARK_(\d+)_END/.exec(p.body.content.map((c) => c.text || '').join('\n'))?.[1]);
  first.machine.autoReply = false;
  const { cluster: c } = await first.api('POST', `/sessions/${parent.id}/cluster`, { tasks, workers: 2 });
  const [w1, w2] = c.workers;
  const k1 = (await snap(first, w1.sessionId)).kimiSessionId;
  // w1 reports its first task, so it is on its second (task 2) when the Hub goes.
  first.machine.reply(k1, first.machine.prompts.filter((p) => p.sid === k1)[0].body.prompt_id, '回報');
  await until(async () => (await first.api('GET', `/clusters/${c.id}`)).tasks[2].status === 'running', 8000, 'w1 on its second task');
  const before = await first.api('GET', `/clusters/${c.id}`);
  assert.deepEqual(before.tasks.map((t) => t.status), ['done', 'running', 'running', 'pending', 'pending', 'pending'], 'the premise');

  await first.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-queue-keep-'));
  fs.cpSync(first.DATA, keep, { recursive: true });
  const second = await start('cluster-queue-restart-2', keep);
  fs.rmSync(keep, { recursive: true, force: true });

  // The Hub is back, the computer is not yet listing its conversations: the queue is as it was left.
  const back = await second.api('GET', `/clusters/${c.id}`);
  assert.deepEqual(back.tasks.map((t) => [t.index, t.status, t.workerSessionId, t.startedAt, t.finishedAt, t.attempts]), before.tasks.map((t) => [t.index, t.status, t.workerSessionId, t.startedAt, t.finishedAt, t.attempts]), 'every task, its worker and its times came back');
  assert.equal(back.status, 'running', 'with tasks still to do the cluster is not done');
  await assert.rejects(second.api('POST', `/clusters/${c.id}/cleanup`), (e) => e.status === 409 && /佇列還有任務/.test(e.message), 'clean-up counts the waiting queue as work, even with every worker quiet');

  // The computer lists its conversations (Kimi is not working on any of them): the turns that ended while nobody was
  // listening are settled, and the queue goes on to the end.
  for (const [sid, st] of first.machine.sessions.entries()) second.machine.add(sid, { ...st, history: (st.history || []).map((h) => ({ ...h })) });
  second.machine.pushSessions();
  const done = await until(async () => {
    const x = await second.api('GET', `/clusters/${c.id}`);
    return x.status === 'done' && x.tasks.every((t) => t.status === 'done') && x;
  }, 20000, 'the queue finished after the restart');
  const kids = [k1, (await snap(second, w2.sessionId)).kimiSessionId];
  const sentAfter = kids.flatMap((k) => markOf(second, k));
  assert.deepEqual(sentAfter.map(Number).sort((a, b) => a - b), [3, 4, 5], 'only the waiting tasks were sent after the restart, each once');
  assert.equal(done.workers[0].done + done.workers[1].done, 6);
  assert.equal(done.tasks[0].workerSessionId, w1.sessionId, 'who did what is kept');
  assert.equal(done.tasks[1].workerSessionId, w2.sessionId);
  assert.ok(done.tasks[0].finishedAt === before.tasks[0].finishedAt, 'the time of a task finished before the restart is the one measured then');
  assert.ok(done.tasks[1].startedAt === before.tasks[1].startedAt);
});
