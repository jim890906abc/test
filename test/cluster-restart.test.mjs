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
