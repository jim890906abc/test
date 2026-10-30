// 叢集 (cluster): what a worker's subagents are doing, as the cluster page's
// small squares need it. Through the REAL Hub (runner, kimi-remote adapter,
// cluster.js) with only Kimi's server faked, speaking the frames the real Kimi
// 2.3.3 was seen to send for an AgentSwarm (one call, one `subagent.spawned`
// per member, each with its own id, description, model and thinking; the
// members' own steps carry their agentId).
//
// What it settles:
//  - the conversation holds ONE card for a whole AgentSwarm, whose `subagent`
//    is overwritten by whichever member spoke last, so the card alone cannot
//    say how many subagents there are or how each one is doing. The cluster
//    state has one entry per member (`workers[].subagents`) and counts.
//  - the status of an entry is what the conversation's own cards claim
//    (agent-state.js: a stored "running" is a claim that needs evidence), a
//    member waiting for an approval reads awaiting, and what the Hub did not
//    measure is null (never filled in).
//  - steps and the last action are read from the member's own events.
//  - the cluster is announced at most once a second, and not at all when
//    nothing the page shows changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import fs from 'node:fs';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';

const MID = 'm_fake';
const FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
let hub;
let second = null;
let KIMI;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const newKimi = (extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: hub.TMP, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });

// A cluster of one worker that stays at work (the fake Kimi does not answer), and the worker's Kimi id.
async function oneWorker() {
  const parent = await newKimi();
  const r = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '甲', prompt: '做甲' }], isolate: false });
  const worker = r.cluster.workers[0];
  const kid = await kidOf(worker.sessionId);
  const f = (type, payload) => hub.machine.frame(kid, type, payload);
  f('turn.started', { turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, prompt: '做甲' });
  f('event.session.work_changed', { busy: true, pending_interaction: 'none' });
  await until(async () => (await snap(worker.sessionId)).status === 'running', 8000, 'the worker is at work');
  return { cid: r.cluster.id, sid: worker.sessionId, kid, f };
}

const swarmCall = (f, id = 'SW', items = 4) => f('tool.call.started', { toolCallId: id, name: 'AgentSwarm', args: { description: '群', items: Array.from({ length: items }, (_, i) => `項${i}`) }, description: 'Launching agent swarm: 群' });
const member = (f, i, { call = 'SW', model = FLASH, effort = 'max', bg = false } = {}) => {
  const subagentId = `agent-${i}`;
  f('subagent.spawned', { subagentId, subagentName: 'coder', parentToolCallId: call, parentAgentId: 'main', callerAgentId: 'main', description: `群 #${i + 1} (coder)`, swarmIndex: i + 1, runInBackground: bg, ...(model ? { model } : {}), ...(effort ? { thinkingEffort: effort } : {}) });
  f('subagent.started', { subagentId });
  return subagentId;
};
const step = (f, agentId, n, command, { finish = true } = {}) => {
  f('tool.call.started', { agentId, toolCallId: `${agentId}-t${n}`, name: 'Bash', args: { command }, description: command });
  if (finish) f('tool.result', { agentId, toolCallId: `${agentId}-t${n}`, output: 'ok' });
};
const subs = async (cid) => (await getCluster(cid)).workers[0].subagents;
const settled = (cid, fn, what) => until(async () => {
  const s = await subs(cid);
  return fn(s) && s;
}, 8000, what);

before(async () => {
  hub = await startRealHub('cluster-subagents');
  await hub.setDeepseekKey();
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const k = groups.find((g) => g.provider === 'kimi').models[0];
  KIMI = { model: k.id, effort: k.efforts[0] };
  hub.machine.autoReply = false;
});
after(async () => {
  await second?.stop();
  await hub?.stop();
});

test('an AgentSwarm of four: four entries (not one), each with its own status, steps, last action, model and times', async () => {
  const w = await oneWorker();
  const before = Date.now();
  swarmCall(w.f);
  const ids = [0, 1, 2, 3].map((i) => member(w.f, i));
  // member 0: three steps, then done. 1: fails. 2: still at its second step. 3: has not done anything yet.
  step(w.f, ids[0], 1, 'ls');
  step(w.f, ids[0], 2, 'wc -l /root/a.md');
  step(w.f, ids[0], 3, 'git status');
  w.f('subagent.completed', { subagentId: ids[0], resultSummary: '做完了' });
  step(w.f, ids[1], 1, 'npm test');
  w.f('subagent.failed', { subagentId: ids[1], error: '測試失敗' });
  step(w.f, ids[2], 1, 'cat x');
  step(w.f, ids[2], 2, 'wc -l /root/pentest-lab/AGENTS.md', { finish: false });

  const list = await settled(w.cid, (s) => s?.length === 4 && s[0].status === 'done' && s[1].status === 'failed' && s[2].lastAction === '執行 wc -l /root/pentest-lab/AGENTS.md', 'four members, drawn from their own frames');
  assert.deepEqual(list.map((s) => [s.id, s.status]), [['agent-0', 'done'], ['agent-1', 'failed'], ['agent-2', 'running'], ['agent-3', 'running']]);
  assert.deepEqual(list.map((s) => s.steps), [3, 1, 2, 0], 'each member counts its OWN tool calls');
  assert.equal(list[0].lastAction, '執行 git status');
  assert.equal(list[3].lastAction, null, 'a member that has done nothing has no last action (not a made-up one)');
  assert.deepEqual(list.map((s) => s.title), ['群 #1 (coder)', '群 #2 (coder)', '群 #3 (coder)', '群 #4 (coder)']);
  for (const s of list) {
    assert.equal(s.model, FLASH, 'the model Kimi reported in subagent.spawned');
    assert.equal(s.effort, 'max');
  }
  const card = (await snap(w.sid)).events.find((e) => e.name === 'AgentSwarm');
  assert.ok(list.every((s) => s.eventId === card.id), 'every member points at the one AgentSwarm card (where 在對話中查看 goes)');
  assert.ok(list.every((s) => s.startedAt >= before && s.startedAt <= Date.now()), "the Hub's clock when it saw the member start");
  assert.ok(list[0].finishedAt >= list[0].startedAt && list[1].finishedAt >= list[1].startedAt);
  assert.equal(list[2].finishedAt, null);

  const c = (await getCluster(w.cid)).workers[0];
  assert.deepEqual(c.subagentCounts, { total: 4, running: 2, awaiting: 0, done: 1, failed: 1, cancelled: 0, unknown: 0 });
  assert.equal(c.subagentsOlder, 0);
});

test('a member that was never told its model says so (null and the reason), not the conversation\'s model', async () => {
  const w = await oneWorker();
  swarmCall(w.f, 'SW2', 2);
  member(w.f, 10, { call: 'SW2', model: null, effort: null });
  member(w.f, 11, { call: 'SW2' });
  const list = await settled(w.cid, (s) => s?.length === 2, 'two members');
  assert.equal(list[0].model, null);
  assert.equal(list[0].effort, null);
  assert.match(list[0].modelReason, /沒有|模型/, 'why it could not be confirmed, in the page\'s own words');
  assert.equal(list[1].model, FLASH);
  assert.equal(list[1].modelReason, null);
});

test('a member that waits for an approval reads awaiting, until the person answers', async () => {
  const w = await oneWorker();
  swarmCall(w.f, 'SW3', 2);
  const [a, b] = [member(w.f, 20, { call: 'SW3' }), member(w.f, 21, { call: 'SW3' })];
  w.f('tool.call.started', { agentId: a, toolCallId: 'ap1', name: 'Bash', args: { command: 'rm -rf build' }, description: 'rm -rf build' });
  w.f('event.approval.requested', { agent_id: a, tool_call_id: 'ap1', approval_id: 'AP1', tool_name: 'Bash', action: 'run', tool_input_display: { kind: 'command', command: 'rm -rf build' } });
  let list = await settled(w.cid, (s) => s?.length === 2 && s[0].status === 'awaiting', 'the first member waits for approval');
  assert.equal(list[1].status, 'running', 'the other one does not');
  assert.equal(list[0].lastAction, '執行 rm -rf build');
  w.f('event.approval.resolved', { approval_id: 'AP1', decision: 'approved' });
  list = await settled(w.cid, (s) => s?.length === 2 && s[0].status === 'running', 'back at work after the answer');
  assert.ok(b);
  assert.equal((await getCluster(w.cid)).workers[0].subagentCounts.awaiting, 0);
});

test('a "running" claim with nothing behind it is not shown as running: the swarm call is over and the member never reported', async () => {
  const w = await oneWorker();
  swarmCall(w.f, 'SW4', 2);
  member(w.f, 30, { call: 'SW4' });
  member(w.f, 31, { call: 'SW4' });
  w.f('subagent.completed', { subagentId: 'agent-30', resultSummary: 'ok' });
  // The call returns (a result for the AgentSwarm call) although member 31 never said it was done.
  w.f('tool.result', { toolCallId: 'SW4', output: 'Wall time: 1 seconds\n' });
  const list = await settled(w.cid, (s) => s?.length === 2 && s[0].status === 'done' && s[1].status === 'unknown', 'the unproven claim is unknown');
  assert.match(list[1].reason, /工具已經結束|沒有回報/, 'and says why, as the conversation card does');
});

test('a plain Agent call is one entry; a refused AgentSwarm (no subagent started) is none', async () => {
  const w = await oneWorker();
  w.f('tool.call.started', { toolCallId: 'AG', name: 'Agent', args: { description: '查一下', prompt: 'p' } });
  w.f('subagent.spawned', { subagentId: 'agent-40', subagentName: 'explore', parentToolCallId: 'AG', parentAgentId: 'main', description: '查一下', runInBackground: false, model: FLASH, thinkingEffort: 'high' });
  w.f('subagent.started', { subagentId: 'agent-40' });
  // A swarm the model asked for while swarm mode was off: Kimi refuses it, nothing starts.
  w.f('tool.call.started', { toolCallId: 'REF', name: 'AgentSwarm', args: { description: '被拒', items: ['a'] } });
  w.f('tool.result', { toolCallId: 'REF', isError: true, output: 'Swarm mode is off, so AgentSwarm did not run and no subagents were started.' });
  const list = await settled(w.cid, (s) => s?.length === 1, 'one entry');
  assert.deepEqual([list[0].id, list[0].title, list[0].effort], ['agent-40', '查一下', 'high']);
  await wait(1200);
  assert.equal((await subs(w.cid)).length, 1, 'the refused swarm never shows up as a failed subagent');
});

test('the cluster is announced at most once a second while members work, and not at all when nothing the page shows changed', async () => {
  const w = await oneWorker();
  swarmCall(w.f, 'SW6', 3);
  const ids = [0, 1, 2].map((i) => member(w.f, 60 + i, { call: 'SW6' }));
  await settled(w.cid, (s) => s?.length === 3, 'three members');
  await wait(1300); // let the announcement of the spawn go out
  const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws`);
  const seen = [];
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(d);
      for (const x of m.t === 'batch' ? m.items : [m]) if (x.t === 'cluster' && x.cluster.id === w.cid) seen.push({ at: Date.now(), subagents: x.cluster.workers[0].subagents });
    } catch {}
  });
  await new Promise((r) => ws.on('open', r));
  // 60 tool calls from three members over about 1.8 s: every one changes a member's steps.
  const t0 = Date.now();
  for (let n = 0; n < 60; n++) {
    step(w.f, ids[n % 3], n, `echo ${n}`);
    await wait(30);
  }
  const burst = Date.now() - t0;
  await wait(1300);
  const during = seen.length;
  assert.ok(during >= 1, 'the page was told');
  assert.ok(during <= Math.ceil(burst / 1000) + 1, `at most one announcement per second: ${during} in ${burst} ms`);
  assert.equal(seen.at(-1).subagents.reduce((a, s) => a + s.steps, 0), 60, 'and the last one has all 60 steps');
  // Now something that changes nothing the page shows: a member's thinking.
  seen.length = 0;
  for (let n = 0; n < 10; n++) w.f('thinking.delta', { agentId: ids[0], turnId: 't1', delta: 'x'.repeat(5) });
  await wait(1600);
  assert.equal(seen.length, 0, 'no change in what is shown: nothing is sent');
  ws.close();
});

test('the roster survives a Hub restart; what claimed to run then reads as it does on the conversation card (interrupted), not as running', async () => {
  const w = await oneWorker();
  swarmCall(w.f, 'SW5', 2);
  member(w.f, 50, { call: 'SW5' });
  member(w.f, 51, { call: 'SW5' });
  step(w.f, 'agent-51', 1, 'echo hi');
  w.f('subagent.completed', { subagentId: 'agent-50', resultSummary: 'ok' });
  const live = await settled(w.cid, (s) => s?.length === 2 && s[0].status === 'done' && s[1].steps === 1, 'before the restart');
  assert.equal(live[1].status, 'running');
  // The Hub is stopped (it writes what it holds) and started again on a copy of its data.
  await hub.halt();
  second = await startRealHub('cluster-subagents-again', { seed: (DATA) => fs.cpSync(hub.DATA, DATA, { recursive: true }) });
  const again = (await second.api('GET', `/clusters/${w.cid}`)).workers[0];
  assert.equal(again.subagents.length, 2, 'both entries came back');
  assert.equal(again.subagents[0].status, 'done');
  assert.equal(again.subagents[1].status, 'cancelled', 'the one that was running was cut by the restart: it is not running now');
  assert.match(again.subagents[1].reason, /中斷|重新啟動/, 'and says why, as the card does');
  assert.equal(again.subagents[1].steps, 1);
  assert.equal(again.subagents[1].title, '群 #52 (coder)');
  assert.equal(again.subagentCounts.running, 0);
  assert.equal(again.subagentCounts.cancelled, 1);
});
