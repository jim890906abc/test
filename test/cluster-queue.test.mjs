// 叢集 (cluster) task queue, through the REAL Hub (runner, kimi-remote adapter,
// cluster.js) with only the outside faked: the Kimi server of a computer (the
// fake machine, whose sh.run really runs bash, so the git worktrees below are
// real git in real folders) and the Anthropic API.
//
// What a person needs from "more tasks than workers": the workers are opened
// with the first tasks; a worker whose turn ends is given the next waiting task
// IN ITS OWN CONVERSATION (its context, its worktree, its branch with the
// commits of the earlier tasks) until none is left; so the slow task does not
// hold up the ones behind it. A worker that fails hands its task back once; a
// stop ends the dispatching; and the times on the tasks are the Hub's own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newKimi = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const cluster = (id, body) => hub.api('POST', `/sessions/${id}/cluster`, body);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const prompts = (kid) => hub.machine.prompts.filter((p) => p.sid === kid);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const textOf = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('\n');
const reminders = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text);
// The task a prompt carries: each task's text has a mark of its own.
const markOf = (prompt) => /TASK_MARK_(\d+)_END/.exec(textOf(prompt))?.[1];
const tasks = (n) => Array.from({ length: n }, (_, i) => ({ title: `任務 ${i + 1}`, prompt: `請處理第 ${i + 1} 條 TASK_MARK_${i}_END` }));

const rejects = async (promise, status, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected a ${status}, got success`);
  assert.equal(err.status, status, `${err.message}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
};

// Kimi reports the worker's current turn over (the fake's own reply, on our schedule).
async function finish(sid, text = '回報') {
  const kid = await kidOf(sid);
  const p = prompts(kid).at(-1);
  hub.machine.reply(kid, p.body.prompt_id, text);
  return p;
}
// Kimi reports the worker's turn failed.
async function failTurn(sid) {
  const kid = await kidOf(sid);
  hub.machine.frame(kid, 'event.session.work_changed', { busy: false, last_turn_reason: 'failed', pending_interaction: 'none' });
}
const taskState = (c) => c.tasks.map((t) => t.status);
const waitFor = (cid, fn, what) => until(async () => {
  const c = await getCluster(cid);
  return fn(c) && c;
}, 10000, what);
// `n` prompts have reached this worker's Kimi conversation.
const waitPrompts = (sid, n) => until(async () => prompts(await kidOf(sid)).length >= n, 10000, `${n} prompts to ${sid}`);

before(async () => {
  hub = await startRealHub('cluster-queue');
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const k = groups.find((g) => g.provider === 'kimi').models[0];
  KIMI = { model: k.id, effort: k.efforts[0] };
});
after(() => hub?.stop());

// -------------------------------------------------------------- the request

test('workers: 1 to 8, whole numbers; 64 tasks at most; by default one per task up to 4; more workers than tasks opens only as many as there are tasks, and says so', async () => {
  const repo = makeRepo('req');
  const parent = await newKimi(repo);
  const natives = hub.machine.sessions.size;
  for (const workers of [0, 9, 1.5, '2', null, -1]) await rejects(cluster(parent.id, { tasks: tasks(3), workers, isolate: false }), 400, /workers/);
  await rejects(cluster(parent.id, { tasks: tasks(65), isolate: false }), 400, /最多 64/);
  await rejects(cluster(parent.id, { tasks: [], isolate: false }), 400, /至少/);
  assert.equal(hub.machine.sessions.size, natives, 'nothing was made by a refused request');

  hub.machine.autoReply = false;
  try {
    const dflt = await cluster(parent.id, { tasks: tasks(6), isolate: false });
    assert.equal(dflt.cluster.workers.length, 4, 'six tasks: four workers by default');
    assert.equal(dflt.cluster.tasks.length, 6);
    const few = await cluster(parent.id, { tasks: tasks(3), isolate: false });
    assert.equal(few.cluster.workers.length, 3, 'three tasks: one worker each, as before');
    const eight = await cluster(parent.id, { tasks: tasks(8), workers: 8, isolate: false });
    assert.equal(eight.cluster.workers.length, 8);
    const many = await cluster(parent.id, { tasks: tasks(64), workers: 2, isolate: false });
    assert.equal(many.cluster.workers.length, 2);
    assert.equal(many.cluster.tasks.length, 64);
    assert.deepEqual(many.cluster.tasks.slice(0, 3).map((t) => [t.index, t.status]), [[0, 'running'], [1, 'running'], [2, 'pending']]);
    assert.ok(many.cluster.tasks.slice(2).every((t) => t.status === 'pending'));
    const clamped = await cluster(parent.id, { tasks: tasks(2), workers: 5, isolate: false });
    assert.equal(clamped.cluster.workers.length, 2, 'no worker is opened to sit idle');
    assert.match(clamped.warnings.join('\n'), /工作者數 5 比任務數 2 多，只開 2 個/);
    for (const c of [dflt, few, eight, many, clamped]) await hub.api('POST', `/clusters/${c.cluster.id}/stop`);
  } finally {
    hub.machine.autoReply = true;
  }
});

// ------------------------------------------------------------ the queue runs

test('6 tasks, 2 workers: each worker takes them in order in its own conversation, every task is done exactly once, and the cluster is done only after the last', async () => {
  const repo = makeRepo('six');
  const parent = await newKimi(repo);
  const r = await cluster(parent.id, { tasks: tasks(6), workers: 2 });
  const c0 = r.cluster;
  assert.equal(c0.workers.length, 2);
  assert.equal(c0.tasks.length, 6);
  assert.deepEqual(Object.keys(c0.tasks[0]).sort(), ['attempts', 'error', 'finishedAt', 'index', 'startedAt', 'status', 'title', 'workerSessionId']);
  assert.ok('taskIndex' in c0.workers[0] && 'done' in c0.workers[0]);

  const c = await waitFor(c0.id, (x) => x.status === 'done' && x.tasks.every((t) => t.status === 'done'), 'all six tasks done');
  const [w1, w2] = c.workers;
  const k1 = await kidOf(w1.sessionId);
  const k2 = await kidOf(w2.sessionId);
  const got = [prompts(k1).map(markOf), prompts(k2).map(markOf)];
  // Each task was sent exactly once, to exactly one worker, and each worker got its tasks in order.
  assert.deepEqual([...got[0], ...got[1]].map(Number).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], `each task once: ${JSON.stringify(got)}`);
  for (const mine of got) assert.deepEqual(mine.map(Number), [...mine.map(Number)].sort((a, b) => a - b), 'in order');
  assert.equal(got[0][0], '0', 'worker 1 starts with the first task');
  assert.equal(got[1][0], '1', 'worker 2 with the second');
  // The record agrees with what was sent.
  for (const t of c.tasks) {
    const who = got[0].includes(String(t.index)) ? w1 : w2;
    assert.equal(t.workerSessionId, who.sessionId, `task ${t.index} is recorded on the worker that got it`);
    assert.equal(t.attempts, 1);
    assert.equal(t.error, null);
  }
  assert.equal(c.workers[0].done + c.workers[1].done, 6);
  assert.ok(c.workers.every((w) => w.taskIndex === null && w.finishedAt), 'nothing is running at the end');
  assert.equal(c.status, 'done');
  // The follow-up tasks went into the same conversations (no new conversation was opened for a task).
  assert.equal((await snap(w1.sessionId)).clusterId, c.id);
  assert.equal((await hub.api('GET', '/sessions')).filter((s) => s.clusterId === c.id).length, 2);
});

test('the one that finishes first takes the next task: a slow worker and a fast one, and the fast one does more', async () => {
  const repo = makeRepo('fast');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(6), workers: 2 });
    const [slow, fast] = c0.workers;
    await waitPrompts(slow.sessionId, 1);
    await waitPrompts(fast.sessionId, 1);
    const fastKid = await kidOf(fast.sessionId);
    const slowKid = await kidOf(slow.sessionId);
    // The fast one reports each task as soon as it gets it, five times over; the slow one never does.
    const t0 = Date.now();
    for (let i = 1; i <= 4; i++) {
      await finish(fast.sessionId);
      await waitPrompts(fast.sessionId, i + 1);
    }
    await finish(fast.sessionId);
    const c = await waitFor(c0.id, (x) => x.tasks.filter((t) => t.status === 'done').length === 5, 'five tasks done by the fast worker');
    const t1 = Date.now();
    assert.equal(prompts(slowKid).length, 1, 'the slow worker was given nothing else');
    assert.deepEqual(prompts(fastKid).map(markOf), ['1', '2', '3', '4', '5'], 'the fast one took the next waiting task every time (the slow one holds task 0)');
    assert.deepEqual(taskState(c), ['running', 'done', 'done', 'done', 'done', 'done']);
    assert.equal(c.workers.find((w) => w.sessionId === fast.sessionId).done, 5);
    assert.equal(c.workers.find((w) => w.sessionId === slow.sessionId).done, 0);
    assert.equal(c.workers.find((w) => w.sessionId === slow.sessionId).taskIndex, 0, 'the slow worker is still on task 0');
    assert.equal(c.status, 'running', 'not done while a task is running');
    // The times are the Hub's clock at the moment, not made up: inside the window of the test, in the order things happened.
    const byIndex = c.tasks;
    for (const t of byIndex.slice(1)) {
      assert.ok(t.startedAt >= t0 - 3000 && t.finishedAt <= t1 + 200, `task ${t.index} times are inside the test's own window`);
      assert.ok(t.finishedAt >= t.startedAt);
    }
    for (let i = 2; i <= 5; i++) assert.ok(byIndex[i].startedAt >= byIndex[i - 1].finishedAt, `task ${i} was handed out after the one before it finished`);
    assert.equal(byIndex[0].finishedAt, null);
    // The slow one finishes at last.
    await finish(slow.sessionId);
    const done = await waitFor(c0.id, (x) => x.status === 'done', 'done');
    assert.deepEqual(taskState(done), Array(6).fill('done'));
    assert.ok(done.tasks[0].finishedAt >= done.tasks[5].finishedAt, 'the slow task ended last');
  } finally {
    hub.machine.autoReply = true;
  }
});

test('a follow-up task is a short message in the same conversation: "task i/N", the task, and not the brief again; the memory\'s news and the worker\'s own worktree carry on', async () => {
  const repo = makeRepo('follow');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(4), workers: 2, note: '備註 NOTE_ONLY_IN_BRIEF' });
    const [w1] = c0.workers;
    const kid = await kidOf(w1.sessionId);
    const first = textOf(prompts(kid)[0]);
    assert.match(first, /這是第 1\/4 條任務；完成後照固定格式回報，然後等待下一條。/);
    assert.ok(first.includes(c0.memory.path) && first.includes('NOTE_ONLY_IN_BRIEF') && first.includes('## 叢集記憶'), 'the first task still comes with the whole brief');
    assert.match(first, /任務佇列/);
    for (const t of c0.tasks) assert.ok(first.includes(t.title), 'the brief lists the queue');

    // The worker commits its first task; the Hub adds a decision to the memory; then the worker reports.
    const session = await snap(w1.sessionId);
    fs.writeFileSync(path.join(w1.worktree, 'first.txt'), 'from task 0\n');
    git(w1.worktree, 'add', '-A');
    git(w1.worktree, 'commit', '-q', '-m', 'task 0');
    await hub.api('POST', `/clusters/${c0.id}/memory`, { text: '決定：MEMORY_NEWS_FOR_NEXT' });
    await finish(w1.sessionId);
    await waitPrompts(w1.sessionId, 2);
    const second = prompts(kid)[1];
    const text = textOf(second);
    assert.match(text, /這是第 3\/4 條任務；完成後照固定格式回報，然後等待下一條。/, 'the third task, numbered in the order given');
    assert.ok(text.includes('請處理第 3 條 TASK_MARK_2_END') && text.includes('任務 3'));
    assert.ok(!text.includes(c0.memory.path) && !text.includes('## 叢集記憶') && !text.includes('NOTE_ONLY_IN_BRIEF') && !text.includes('主對話最近的對話摘錄'), 'the brief is not sent again');
    assert.ok(text.length < first.length / 2, `short: ${text.length} vs ${first.length}`);
    assert.ok(text.includes(w1.branch), 'it says where to commit');
    assert.ok(reminders(second).some((t) => t.includes('MEMORY_NEWS_FOR_NEXT')), 'what the memory gained meanwhile reaches the worker with the next task');
    // The same conversation, the same folder, the same branch: the commit of task 0 is still there.
    assert.equal((await snap(w1.sessionId)).cwd, session.cwd);
    assert.equal(git(w1.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), w1.branch);
    assert.equal(git(w1.worktree, 'log', '--format=%s', '-1'), 'task 0');
    assert.equal(fs.readFileSync(path.join(w1.worktree, 'first.txt'), 'utf8'), 'from task 0\n');
    // The conversation is named after the task it is doing now.
    await until(async () => (await snap(w1.sessionId)).title === '任務 3', 5000, 'the conversation named after the task');
    assert.equal((await getCluster(c0.id)).workers[0].title, '任務 3');
    await hub.api('POST', `/clusters/${c0.id}/stop`);
  } finally {
    hub.machine.autoReply = true;
  }
});

// ---------------------------------------------------------------- failures

test('a worker whose turn failed is out of the queue and its task goes back ONCE: another worker takes it; a second failure ends it as failed and it is not sent a third time', async () => {
  const repo = makeRepo('fail');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(3), workers: 2 });
    const [w1, w2] = c0.workers;
    const k1 = await kidOf(w1.sessionId);
    const k2 = await kidOf(w2.sessionId);
    await failTurn(w1.sessionId);
    const c1 = await waitFor(c0.id, (x) => x.tasks[0].status === 'pending', 'task 0 handed back');
    assert.equal(c1.tasks[0].attempts, 1);
    assert.match(c1.tasks[0].error, /w1 的回合出錯了.*退回佇列/);
    assert.equal(c1.tasks[0].workerSessionId, null);
    assert.equal(c1.tasks[0].startedAt, null);
    assert.equal(c1.status, 'running');
    // The failed worker is given nothing more; the handed-back task goes before the ones behind it.
    await finish(w2.sessionId);
    await waitPrompts(w2.sessionId, 2);
    assert.equal(markOf(prompts(k2).at(-1)), '0', 'task 0 goes to the other worker, ahead of task 2');
    assert.equal(prompts(k1).length, 1, 'the failed worker got nothing more');
    const c2 = await waitFor(c0.id, (x) => x.tasks[0].status === 'running' && x.tasks[0].workerSessionId === w2.sessionId, 'task 0 running on w2');
    assert.equal(c2.tasks[0].attempts, 2);
    assert.equal(c2.tasks[0].error, null);
    // It fails again: it is the task's own failure now.
    await failTurn(w2.sessionId);
    const c3 = await waitFor(c0.id, (x) => x.tasks[0].status === 'failed', 'task 0 failed for good');
    assert.match(c3.tasks[0].error, /w2 的回合出錯了.*不再重派/);
    assert.ok(c3.tasks[0].finishedAt >= c3.tasks[0].startedAt && c3.tasks[0].finishedAt > 0);
    assert.equal(c3.tasks[0].attempts, 2);
    // Nobody is left to take task 2: it ends as failed too (not left waiting for ever), and says why.
    assert.equal(c3.tasks[2].status, 'failed');
    assert.match(c3.tasks[2].error, /沒有可用的工作者/);
    assert.equal(c3.tasks[1].status, 'done');
    assert.equal(c3.status, 'done', 'the cluster ends');
    const sent = [...prompts(k1), ...prompts(k2)].map(markOf);
    assert.equal(sent.filter((m) => m === '0').length, 2, 'task 0 was sent twice, never a third time');
    assert.equal(sent.filter((m) => m === '2').length, 0, 'task 2 was never sent');
  } finally {
    hub.machine.autoReply = true;
  }
});

test('a lone worker that fails has nobody to hand its task to: it and the ones behind it end as failed, and the cluster reads error', async () => {
  const repo = makeRepo('lone');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(2), workers: 1 });
    const [w1] = c0.workers;
    await failTurn(w1.sessionId);
    const c = await waitFor(c0.id, (x) => x.tasks[0].status === 'failed', 'task 0 failed');
    assert.equal(c.tasks[1].status, 'failed', 'and the one waiting behind it has no worker either');
    assert.equal(c.status, 'error', 'every task failed');
    assert.equal(prompts(await kidOf(w1.sessionId)).length, 1);
  } finally {
    hub.machine.autoReply = true;
  }
});

test('a worker whose conversation is deleted: the task it was on goes back and another worker takes it', async () => {
  const repo = makeRepo('del');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(3), workers: 2 });
    const [w1, w2] = c0.workers;
    await hub.api('DELETE', `/sessions/${w1.sessionId}`);
    const c1 = await waitFor(c0.id, (x) => x.workers[0].status === 'deleted' && x.tasks[0].status === 'pending', 'task 0 handed back');
    assert.match(c1.tasks[0].error, /對話被刪除/);
    await finish(w2.sessionId);
    await waitPrompts(w2.sessionId, 2);
    assert.equal(markOf(prompts(await kidOf(w2.sessionId)).at(-1)), '0');
    await finish(w2.sessionId);
    await waitPrompts(w2.sessionId, 3);
    await finish(w2.sessionId);
    const done = await waitFor(c0.id, (x) => x.status === 'done', 'done');
    assert.deepEqual(taskState(done), ['done', 'done', 'done']);
    assert.ok(done.tasks.every((t) => t.workerSessionId === w2.sessionId));
    assert.equal(done.workers[1].done, 3);
  } finally {
    hub.machine.autoReply = true;
  }
});

test('Kimi refuses the next task: that worker is out, the task goes back once and another worker takes it', async () => {
  const repo = makeRepo('refuse');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(4), workers: 2 });
    const [w1, w2] = c0.workers;
    const k1 = await kidOf(w1.sessionId);
    // w1's next prompt is refused.
    hub.machine.refusePrompts = (sid) => sid === k1;
    await finish(w1.sessionId);
    const c1 = await waitFor(c0.id, (x) => x.tasks[2].attempts === 1 && x.tasks[2].status === 'pending' && /交給 w1 時失敗/.test(x.tasks[2].error || ''), 'task 2 handed back after the refusal');
    assert.equal(c1.tasks[0].status, 'done');
    hub.machine.refusePrompts = false;
    await finish(w2.sessionId);
    await waitPrompts(w2.sessionId, 2);
    assert.equal(markOf(prompts(await kidOf(w2.sessionId)).at(-1)), '2');
    assert.equal(prompts(k1).length, 1, 'nothing reached w1 (it was refused)');
    await hub.api('POST', `/clusters/${c0.id}/stop`);
  } finally {
    hub.machine.refusePrompts = false;
    hub.machine.autoReply = true;
  }
});

// -------------------------------------------------------------------- stop

test('stop ends the dispatching: the tasks being worked on are cut off, the waiting ones stay waiting, nothing new is sent - not even after a worker is spoken to by hand', async () => {
  const repo = makeRepo('stop');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(5), workers: 2 });
    const [w1, w2] = c0.workers;
    const kids = [await kidOf(w1.sessionId), await kidOf(w2.sessionId)];
    const sentBefore = hub.machine.prompts.length;
    await hub.api('POST', `/clusters/${c0.id}/stop`);
    for (const k of kids) hub.machine.frame(k, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
    const c = await waitFor(c0.id, (x) => x.workers.every((w) => w.status === 'idle') && x.status === 'stopped', 'stopped');
    assert.deepEqual(taskState(c), ['failed', 'failed', 'pending', 'pending', 'pending']);
    assert.match(c.tasks[0].error, /全部停止/);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(hub.machine.prompts.length, sentBefore, 'no task was sent after the stop');
    // A person talks to a worker by hand; when it ends, the queue still does not go on.
    hub.machine.autoReply = true;
    await hub.api('POST', `/sessions/${w1.sessionId}/messages`, { text: '手動說一句' });
    await until(async () => (await snap(w1.sessionId)).events.filter((e) => e.type === 'turn_end').length >= 1 && (await snap(w1.sessionId)).status === 'idle', 8000, 'the manual turn over');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(hub.machine.prompts.length, sentBefore + 1, 'only the person\'s own message');
    const after = await getCluster(c0.id);
    // The person went on with w1's cut-off task by hand and it ended: that task is done; the other is still cut off; nothing was sent.
    assert.deepEqual(taskState(after), ['done', 'failed', 'pending', 'pending', 'pending']);
    assert.equal(after.tasks[0].workerSessionId, w1.sessionId);
    assert.equal(after.tasks[0].error, null);
    assert.equal(after.status, 'stopped', 'a cluster with tasks never sent reads stopped, not done');
  } finally {
    hub.machine.autoReply = true;
  }
});

test('stop while a worker\'s turn is ending: the next task is not handed to the worker that the stop interrupted', async () => {
  const repo = makeRepo('stoprace');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(3), workers: 1 });
    const [w1] = c0.workers;
    const k1 = await kidOf(w1.sessionId);
    // Kimi ends the turn the moment the abort arrives, before the stop request has returned.
    hub.machine.answers['kimi.request'] = async (a) => {
      if (/:abort$/.test(a.path)) {
        hub.machine.frame(k1, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
        await new Promise((r) => setTimeout(r, 150)); // the stop request is still waiting for its answer
      }
      return { code: 0, msg: 'ok', data: {} };
    };
    try {
      await hub.api('POST', `/clusters/${c0.id}/stop`);
    } finally {
      delete hub.machine.answers['kimi.request'];
    }
    await waitFor(c0.id, (x) => x.workers[0].status === 'idle', 'idle');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(prompts(k1).length, 1, 'the interrupted worker was not handed task 1');
    assert.deepEqual(taskState(await getCluster(c0.id)), ['failed', 'pending', 'pending']);
  } finally {
    hub.machine.autoReply = true;
  }
});

test('stop on a cluster that is done changes nothing: it is not marked stopped', async () => {
  const repo = makeRepo('stopdone');
  const parent = await newKimi(repo);
  const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(3), workers: 2 });
  await waitFor(c0.id, (x) => x.status === 'done', 'done');
  const r = await hub.api('POST', `/clusters/${c0.id}/stop`);
  assert.equal(r.status, 'done');
});

// ------------------------------------------------------ clean up and merge

test('the automatic clean-up after a merge does not run while the queue is open (tasks wait), and the queue goes on after the merge', async () => {
  const repo = makeRepo('clean');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(5), workers: 2 });
    const [w1, w2] = c0.workers;
    await rejects(hub.api('POST', `/clusters/${c0.id}/cleanup`), 409, /工作者還在跑/);
    await rejects(hub.api('GET', `/clusters/${c0.id}/cleanup/plan`), 409, /工作者還在跑/);
    // Both workers report their first task; task 2 and 3 are handed out, task 4 waits.
    await finish(w1.sessionId);
    await finish(w2.sessionId);
    await waitPrompts(w1.sessionId, 2);
    await waitPrompts(w2.sessionId, 2);
    const merged = await hub.api('POST', `/clusters/${c0.id}/merge`);
    assert.ok(merged.merge.results.every((x) => x.ok), 'the merge itself went in');
    assert.equal(merged.cleanup, null, 'tasks are waiting: nothing was cleaned up by itself');
    assert.ok(fs.existsSync(w1.worktree) && fs.existsSync(w2.worktree), 'both worktrees are there');
    // The queue goes on after the merge, to the end.
    await finish(w1.sessionId);
    await waitPrompts(w1.sessionId, 3);
    await finish(w2.sessionId);
    await finish(w1.sessionId);
    const done = await waitFor(c0.id, (x) => x.status === 'done', 'done');
    assert.deepEqual(taskState(done), Array(5).fill('done'));
    // Nothing is waiting any more: clean-up is offered.
    const plan = await hub.api('GET', `/clusters/${c0.id}/cleanup/plan`);
    assert.equal(plan.dryRun, true);
  } finally {
    hub.machine.autoReply = true;
  }
});

// ------------------------------------------------------------------ shape

test('the cluster\'s fields: tasks and the worker\'s taskIndex and done are there while it runs, and the record on disk keeps the queue', async () => {
  const repo = makeRepo('shape');
  const parent = await newKimi(repo);
  hub.machine.autoReply = false;
  try {
    const { cluster: c0 } = await cluster(parent.id, { tasks: tasks(3), workers: 2 });
    const got = await getCluster(c0.id);
    assert.deepEqual(Object.keys(got).sort(), ['cleanup', 'createdAt', 'id', 'isolate', 'memory', 'merge', 'mode', 'parentId', 'status', 'swarm', 'tasks', 'warnings', 'workers']);
    assert.deepEqual(Object.keys(got.workers[0]).sort(), ['branch', 'done', 'finishedAt', 'hidden', 'progress', 'sessionId', 'speed', 'status', 'subagentCounts', 'subagents', 'subagentsOlder', 'swarm', 'task', 'taskIndex', 'title', 'worktree']);
    assert.deepEqual(got.workers.map((w) => [w.taskIndex, w.done]), [[0, 0], [1, 0]]);
    assert.deepEqual(got.tasks.map((t) => [t.index, t.title, t.status, t.workerSessionId]), [[0, '任務 1', 'running', got.workers[0].sessionId], [1, '任務 2', 'running', got.workers[1].sessionId], [2, '任務 3', 'pending', null]]);
    assert.ok(got.tasks[0].startedAt > 0 && got.tasks[0].finishedAt === null && got.tasks[2].startedAt === null);
    const file = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'clusters', `${c0.id}.json`), 'utf8'));
    assert.deepEqual(file.tasks.map((t) => t.status), ['running', 'running', 'pending']);
    assert.equal(file.tasks[2].prompt.includes('TASK_MARK_2_END'), true, 'the text of a waiting task is kept so it can be sent after a restart');
    await hub.api('POST', `/clusters/${c0.id}/stop`);
  } finally {
    hub.machine.autoReply = true;
  }
});
