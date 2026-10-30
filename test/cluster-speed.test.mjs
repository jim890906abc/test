// 叢集 (cluster): how fast the workers are going right now, and the list of every
// cluster. Through the REAL Hub with only the computer's side faked (the Kimi
// server and the connector's request records).
//
// The rule (the owner's): a speed is a sum of what was measured, over a window, or
// it is "—" with the reason. Never an estimate, never a time left.
//  - tokens per second = output tokens of the requests that ENDED in the window,
//    over the window's seconds; requests per minute = requests that STARTED in it;
//  - the window is the last 5 minutes but not longer than the work has been going
//    (nor than the connector's records are complete for), and says its own length;
//  - a worker the records cannot say anything about (not on the DeepSeek pool, no
//    records yet) is null with a reason, and is not counted as zero;
//  - GET /api/clusters is one light line per cluster, made by the same function the
//    page applies to a cluster it is pushed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';
import { summarizeCluster, totalsOf } from '../public/js/cluster-model.js';

const MID = 'm_fake';
let hub;
let KIMI;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const newDeepseek = () => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: hub.TMP, model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
const newKimi = () => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: hub.TMP, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
const dispatch = (parent, n) => hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: Array.from({ length: n }, (_, i) => ({ title: `任務 ${i + 1}`, prompt: `做第 ${i + 1} 條` })), isolate: false, workers: n });
const grant = async (...names) => {
  hub.machine.send({ t: 'broker.ready', broker: 1, capabilities: ['pool', 'pool_cross', 'handoff', ...names] });
  await until(async () => {
    const have = (await hub.api('GET', '/machines')).find((m) => m.id === MID).capabilities;
    return ['pool', ...names].every((n) => have.includes(n));
  }, 5000, `the capabilities ${names}`);
};
let seq = 0;
const record = (over = {}) => ({ id: `b1-${++seq}-${Math.random().toString(36).slice(2, 6)}`, req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: null, clientRetry: null, switchedFrom: null, recvAt: Date.now() - 100, startAt: Date.now() - 90, headersMs: 50, firstByteMs: 80, endMs: 500, status: 200, outcome: 'ok', inflight: 1, outTokens: null, ...over });
const report = (records, since = Date.now() - 3_600_000) => hub.machine.send({ t: 'deepseek.requests', boot: 'b1', since, replay: false, records });
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;

before(async () => {
  hub = await startRealHub('cluster-speed');
  await hub.setDeepseekKey();
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const k = groups.find((g) => g.provider === 'kimi').models[0];
  KIMI = { model: k.id, effort: k.efforts[0] };
  hub.machine.autoReply = false;
  await grant('pool_timing');
});
after(() => hub?.stop());

test('speed is the output tokens of the requests that ended in the window, over its seconds; requests are those that started in it; nothing before the work began', async () => {
  const parent = await newDeepseek();
  const { cluster: c0 } = await dispatch(parent, 2);
  const [a, b] = c0.workers;
  const [ka, kb] = [await kidOf(a.sessionId), await kidOf(b.sessionId)];
  // The window cannot be longer than the work has been going: wait for a few seconds of it.
  await wait(6200);
  const now = Date.now();
  report([
    // Worker a: three requests that ended inside the window (100 + 200 + 300 tokens)...
    record({ session: ka, startAt: now - 4000, endMs: 1000, outTokens: 100 }),
    record({ session: ka, startAt: now - 3000, endMs: 1000, outTokens: 200 }),
    record({ session: ka, startAt: now - 2000, endMs: 1000, outTokens: 300 }),
    // ...one still going (counts as a request, has no tokens yet), one that ended before the cluster existed...
    record({ session: ka, startAt: now - 1000, endMs: null, outTokens: null }),
    record({ session: ka, startAt: c0.createdAt - 120_000, endMs: 1000, outTokens: 9999 }),
    // ...and another conversation's.
    record({ session: kb, startAt: now - 2500, endMs: 1000, outTokens: 50 }),
    record({ session: null, startAt: now - 2500, endMs: 1000, outTokens: 7777 }),
  ]);
  const got = await until(async () => {
    const c = await getCluster(c0.id);
    return c.workers[0].speed.outTokens === 600 && c;
  }, 8000, 'the records');
  const [sa, sb] = got.workers.map((w) => w.speed);
  assert.equal(sa.outTokens, 600, 'only what ended in the window: not the in-flight one, not the one from before the cluster, not anybody else\'s');
  assert.equal(sa.requests, 4, 'the requests that started in it, the one still going included');
  assert.ok(sa.windowMs >= 5000 && sa.windowMs <= Date.now() - c0.createdAt + 50, `the window is the time the work has been going (${sa.windowMs} ms), not 5 minutes`);
  assert.equal(sa.tokensPerSecond, Math.round((600 / (sa.windowMs / 1000)) * 10) / 10, 'tokens over the window seconds, nothing else');
  assert.equal(sa.requestsPerMinute, Math.round((4 / (sa.windowMs / 60_000)) * 10) / 10);
  assert.equal(sa.unmeasured, null);
  assert.equal(sb.outTokens, 50);
  assert.ok(!('eta' in sa) && !JSON.stringify(got).match(/eta|remaining|剩餘/i), 'no estimate of what is left is ever sent');
  // The list of clusters gives the very number the cluster page works out for itself.
  const row = (await hub.api('GET', '/clusters')).find((r) => r.id === c0.id);
  // (The window slides with the clock, so the two answers - asked a moment apart - may differ by a fraction in the speeds, and in nothing else.)
  const mine = summarizeCluster(got);
  assert.deepEqual({ ...row, speed: null, parentTitle: undefined }, { ...mine, speed: null, parentTitle: undefined });
  assert.ok(Math.abs(row.speed.tokensPerSecond - mine.speed.tokensPerSecond) < 2, `${row.speed.tokensPerSecond} vs ${mine.speed.tokensPerSecond}`);
  assert.ok(Math.abs(row.speed.tokensPerSecond - (sa.tokensPerSecond + sb.tokensPerSecond)) < 2, 'the cluster\'s speed is the sum of its workers\'');
  assert.equal(row.speed.workersMeasured, 2);
});

test('a worker the records cannot speak for is "—" with the reason, and does not drag the total down as a zero', async () => {
  const parent = await newKimi();
  const { cluster } = await dispatch(parent, 1);
  await wait(5500);
  const w = (await getCluster(cluster.id)).workers[0];
  assert.deepEqual([w.speed.tokensPerSecond, w.speed.requestsPerMinute, w.speed.windowMs, w.speed.outTokens], [null, null, null, null]);
  assert.match(w.speed.unmeasured, /不是 DeepSeek 號池/);
  const row = (await hub.api('GET', '/clusters')).find((r) => r.id === cluster.id);
  assert.equal(row.speed.tokensPerSecond, null);
  assert.equal(row.speed.workersMeasured, 0);
  assert.match(row.speed.unmeasured, /不是 DeepSeek 號池/);
});

test('a window shorter than a few seconds is not turned into a speed', async () => {
  const parent = await newDeepseek();
  const { cluster } = await dispatch(parent, 1);
  const k = await kidOf(cluster.workers[0].sessionId);
  report([record({ session: k, startAt: Date.now() - 500, endMs: 100, outTokens: 500 })]);
  await wait(500);
  const w = (await getCluster(cluster.id)).workers[0];
  assert.equal(w.speed.tokensPerSecond, null, 'half a second of work says nothing about how fast it goes');
  assert.match(w.speed.unmeasured, /時間窗只有|還量不出速度/);
});

test('requests that name no conversation may be this worker\'s: a zero is not claimed over them, the speed is "—" with that reason', async () => {
  const parent = await newDeepseek();
  const { cluster } = await dispatch(parent, 1);
  const k = await kidOf(cluster.workers[0].sessionId);
  await wait(5600);
  const now = Date.now();
  // Only a request with no session id (an older Kimi does not send prompt_cache_key), and another worker's.
  report([record({ session: null, startAt: now - 2000, endMs: 1000, outTokens: 400 }), record({ session: 'session_someone-else-1234', startAt: now - 2000, endMs: 1000, outTokens: 90 })]);
  await wait(400);
  const w = (await getCluster(cluster.id)).workers[0];
  assert.equal(w.speed.tokensPerSecond, null, 'not 0: 400 tokens went somewhere');
  assert.match(w.speed.unmeasured, /1 個請求沒帶對話識別/);
  // The same worker's own request settles it: now it is a number (its own tokens only).
  report([record({ session: k, startAt: now - 1500, endMs: 800, outTokens: 70 })]);
  const got = await until(async () => {
    const x = (await getCluster(cluster.id)).workers[0];
    return x.speed.outTokens === 70 && x;
  }, 6000, 'its own request counted');
  assert.equal(got.speed.requests, 1);
  assert.equal(got.speed.unmeasured, null);
});

test('GET /api/clusters: every cluster of every conversation, light, and the totals over them come out right while several run at once', async () => {
  const p1 = await newKimi();
  const p2 = await newKimi();
  const c1 = (await dispatch(p1, 2)).cluster;
  const c2 = (await dispatch(p2, 3)).cluster;
  // Members of a swarm in the first cluster's first worker, two of them running; one in the second cluster's.
  const f = async (c, i) => {
    const kid = await kidOf(c.workers[i].sessionId);
    return (type, payload) => hub.machine.frame(kid, type, payload);
  };
  const turn = (fx) => {
    fx('turn.started', { turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, prompt: 'x' });
    fx('event.session.work_changed', { busy: true, pending_interaction: 'none' });
  };
  const swarm = (fx, call, ids) => {
    fx('tool.call.started', { toolCallId: call, name: 'AgentSwarm', args: { description: '群', items: ids } });
    for (const id of ids) {
      fx('subagent.spawned', { subagentId: id, subagentName: 'coder', parentToolCallId: call, parentAgentId: 'main', description: id, runInBackground: false });
      fx('subagent.started', { subagentId: id });
    }
  };
  const f1 = await f(c1, 0);
  const f2 = await f(c2, 0);
  turn(f1);
  turn(f2);
  swarm(f1, 'S1', ['x1', 'x2', 'x3']);
  f1('subagent.completed', { subagentId: 'x3', resultSummary: 'ok' });
  swarm(f2, 'S2', ['y1']);
  const rows = await until(async () => {
    const r = await hub.api('GET', '/clusters');
    const a = r.find((x) => x.id === c1.id);
    const b = r.find((x) => x.id === c2.id);
    return a?.subagents?.total === 3 && b?.subagents?.total === 1 && r;
  }, 8000, 'both clusters\' subagents');
  // Light: no list of subagents, no worker array, no task text.
  for (const r of rows) assert.ok(!('workers' in r && Array.isArray(r.workers)) && !('subagentList' in r) && !JSON.stringify(r).includes('做第'), 'a summary, not the cluster');
  assert.ok(rows.every((r) => r.parentTitle !== undefined && typeof r.workers === 'number'));
  const a = rows.find((x) => x.id === c1.id);
  const b = rows.find((x) => x.id === c2.id);
  assert.deepEqual([a.subagents.running, a.subagents.done, a.workers, a.workersRunning], [2, 1, 2, 2]);
  assert.equal(b.subagents.running, 1);
  // The totals over the list are the sums of the clusters', from the same lines.
  const t = totalsOf(rows);
  assert.equal(t.subagentsRunning, rows.reduce((s, r) => s + r.subagents.running + r.subagents.awaiting, 0));
  assert.ok(t.subagentsRunning >= 3, `two swarms running: ${t.subagentsRunning}`);
  assert.equal(t.subagentsOpened, rows.reduce((s, r) => s + r.subagents.total, 0));
  assert.equal(t.workersRunning, rows.reduce((s, r) => s + r.workersRunning, 0));
  // And one cluster's own state gives the same line.
  assert.deepEqual({ ...a, parentTitle: undefined }, { ...summarizeCluster(await getCluster(c1.id)), parentTitle: undefined });
  assert.equal(a.parentTitle, (await snap(p1.id)).title);
});
