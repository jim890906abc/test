// What the cluster screens say about subagents, speed and the whole cluster, with
// no page: the count line, the groups, which squares fit, how a speed is written,
// the one-line summary of a cluster that the list and the page both use, and the
// order of the list. The rule under all of it: a number the Hub did not measure is
// "—", never zero and never a guess, and nothing says how long anything will take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SQUARES_SHOWN,
  clusterElapsed,
  fmtRate,
  fmtWindow,
  groupCounts,
  keyView,
  sortClusters,
  speedView,
  squareLabel,
  squaresView,
  subagentDetail,
  subagentLine,
  subagentState,
  summarizeCluster,
  taskBar,
  totalsOf,
  workerSquare,
  workingSubagents,
} from '../public/js/cluster-model.js';

const counts = (o = {}) => ({ total: 0, running: 0, awaiting: 0, done: 0, failed: 0, cancelled: 0, unknown: 0, ...o });
const worker = (patch = {}) => ({ sessionId: 's', status: 'running', subagentCounts: counts(), subagentsOlder: 0, speed: { tokensPerSecond: null, requestsPerMinute: null, windowMs: null, unmeasured: '沒有' }, done: 0, taskIndex: 0, ...patch });
const cluster = (patch = {}) => ({ id: 'c_1', parentId: 'p', status: 'running', createdAt: 1_000_000, workers: [worker()], tasks: [{ index: 0, status: 'running' }, { index: 1, status: 'pending' }], ...patch });

test('the count line says how many and in which groups, only the groups that have any; cancelled and failed are one group', () => {
  assert.equal(subagentLine(counts({ total: 8, running: 5, done: 3 })), '子代理 8：5 執行中・3 完成');
  assert.equal(subagentLine(counts({ total: 6, running: 1, awaiting: 1, done: 1, failed: 1, cancelled: 1, unknown: 1 })), '子代理 6：1 執行中・1 等你核准・1 完成・2 失敗或取消・1 狀態未知');
  assert.equal(subagentLine(counts()), '沒有開過子代理');
  assert.equal(subagentLine(counts({ total: 3, done: 3 }), 12), '子代理 3：3 完成（另有 12 個更早的不在清單裡）');
  assert.deepEqual(groupCounts(counts({ failed: 2, cancelled: 3 })), { total: 0, running: 0, awaiting: 0, done: 0, failed: 5, unknown: 0 });
  assert.deepEqual(groupCounts(null), { total: 0, running: 0, awaiting: 0, done: 0, failed: 0, unknown: 0 });
  assert.equal(workingSubagents(counts({ running: 4, awaiting: 2, done: 9 })), 6, 'one that waits for you is alive');
});

test('every state has a word and a glyph of its own (never colour alone); an unknown state reads as unknown', () => {
  const glyphs = ['running', 'awaiting', 'done', 'failed', 'cancelled', 'unknown'].map((s) => subagentState(s));
  assert.deepEqual(glyphs.map((g) => g.label), ['執行中', '等你核准', '完成', '失敗', '已中斷', '狀態未知']);
  assert.deepEqual(glyphs.map((g) => g.glyph), ['', '!', '✓', '✕', '✕', '?']);
  assert.equal(subagentState('weird').group, 'unknown');
  assert.equal(subagentState('cancelled').group, subagentState('failed').group);
});

test('squares: the first 40 and a +N; "all" shows every one; a label says whose, what state and what it is doing', () => {
  const list = Array.from({ length: 128 }, (_, i) => ({ id: `a${i}`, title: `T${i}`, status: i % 2 ? 'done' : 'running', lastAction: '執行 ls' }));
  const v = squaresView(list);
  assert.equal(v.shown.length, SQUARES_SHOWN);
  assert.equal(v.hidden, 128 - SQUARES_SHOWN);
  assert.equal(squaresView(list, { all: true }).hidden, 0);
  assert.equal(squaresView(list.slice(0, 40)).hidden, 0);
  assert.equal(squareLabel(list[0], 0), '子代理 1，「T0」，執行中，最新動作 執行 ls');
  assert.equal(squareLabel({ status: 'unknown' }, 2), '子代理 3，狀態未知');
});

test('a detail: model and thinking when reported, "—" and why when not; time since start while it works, how long it took after', () => {
  const t0 = 1_800_000_000_000;
  const running = subagentDetail({ status: 'running', title: '做 X', provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max', steps: 7, lastAction: '執行 ls', startedAt: t0, finishedAt: null, eventId: 'e1' }, { now: t0 + 75_000, modelText: (p, m) => `${p}:${m.split('/').pop()}` });
  assert.equal(running.model, 'deepseek:deepseek-v4.1-flash · 思考 max');
  assert.equal(running.span, '已跑 1 分 15 秒');
  assert.equal(running.steps, 7);
  assert.equal(running.eventId, 'e1');
  const done = subagentDetail({ status: 'done', startedAt: t0, finishedAt: t0 + 4_200 }, { now: t0 + 999_999 });
  assert.equal(done.span, '跑了 4.2 秒', 'the time it took, not the time since');
  const none = subagentDetail({ status: 'unknown', model: null, modelReason: '子代理執行了一段時間，仍沒有收到它實際使用的模型', steps: 0 });
  assert.equal(none.model, null);
  assert.match(none.modelWhy, /沒有收到它實際使用的模型/);
  assert.equal(none.span, null, 'no start time reported: no length made up');
  assert.equal(none.started, null);
  assert.equal(subagentDetail({ status: 'done' }).modelWhy, '沒有回報');
});

test('a speed is written from a measured number; "—" with the reason where there is none; never a time left', () => {
  assert.equal(fmtRate(42.46), '42');
  assert.equal(fmtRate(5.04), '5');
  assert.equal(fmtRate(5.25), '5.3');
  assert.equal(fmtRate(0), '0');
  assert.equal(fmtRate(null), null);
  assert.equal(fmtRate(NaN), null);
  assert.equal(fmtRate(-1), null);
  assert.equal(fmtWindow(300_000), '5 分鐘');
  assert.equal(fmtWindow(30_000), '30 秒');
  const v = speedView({ tokensPerSecond: 120.4, requestsPerMinute: 9, windowMs: 120_000 });
  assert.deepEqual([v.measured, v.text, v.tokens, v.requests], [true, '120 tok/s', '最近 2 分鐘輸出 120 tok/s', '請求 9／分']);
  const none = speedView({ tokensPerSecond: null, unmeasured: '連接器還沒有回報過任何請求紀錄' });
  assert.deepEqual([none.measured, none.text, none.tokens], [false, '—', null]);
  assert.equal(none.why, '連接器還沒有回報過任何請求紀錄');
  assert.equal(speedView(undefined).text, '—');
  assert.equal(speedView({ tokensPerSecond: 0, windowMs: 60_000 }).text, '0 tok/s', 'measured zero is a number');
  for (const v2 of [v, none]) assert.ok(!/eta|剩餘|預計|還要|remaining/i.test(JSON.stringify(v2)), 'no estimate of what is left');
});

test('summarizeCluster: tasks, workers, subagents and speed from the workers\' own numbers; null where nobody said', () => {
  const c = cluster({
    workers: [
      worker({ sessionId: 'a', subagentCounts: counts({ total: 4, running: 2, done: 1, failed: 1 }), subagentsOlder: 3, speed: { tokensPerSecond: 40, requestsPerMinute: 2 } }),
      worker({ sessionId: 'b', status: 'awaiting_permission', subagentCounts: counts({ total: 2, awaiting: 1, unknown: 1 }), speed: { tokensPerSecond: 10.5, requestsPerMinute: 1.5 } }),
      worker({ sessionId: 'c', status: 'idle', subagentCounts: counts({ total: 1, cancelled: 1 }), speed: { tokensPerSecond: null, requestsPerMinute: null, unmeasured: '不是 DeepSeek 號池' } }),
    ],
    tasks: [{ index: 0, status: 'done' }, { index: 1, status: 'running' }, { index: 2, status: 'running' }, { index: 3, status: 'pending' }, { index: 4, status: 'failed' }],
  });
  const s = summarizeCluster(c);
  assert.deepEqual(s.tasks, { done: 1, total: 5, failed: 1, running: 2, pending: 1 });
  assert.equal(s.workers, 3);
  assert.equal(s.workersRunning, 2, 'one that waits for approval is at work; the idle one is not');
  assert.deepEqual(s.subagents, { total: 7, running: 2, awaiting: 1, done: 1, failed: 1, cancelled: 1, unknown: 1, older: 3 });
  assert.equal(s.speed.tokensPerSecond, 50.5, 'the sum of the workers that could say');
  assert.equal(s.speed.requestsPerMinute, 3.5);
  assert.deepEqual([s.speed.workersMeasured, s.speed.workers], [2, 3]);
  assert.equal(s.speed.unmeasured, null);

  const blind = summarizeCluster(cluster({ workers: [worker({ speed: { tokensPerSecond: null, unmeasured: '第一個原因' } }), worker({ speed: { tokensPerSecond: null, unmeasured: '第二個原因' } })] }));
  assert.equal(blind.speed.tokensPerSecond, null, 'no worker could say: not zero');
  assert.equal(blind.speed.unmeasured, '第一個原因');
  // A Hub that does not send subagent counts (an older one): the summary says it does not know.
  const old = summarizeCluster(cluster({ workers: [{ sessionId: 'x', status: 'running' }] }));
  assert.equal(old.subagents, null);
  assert.equal(old.speed.tokensPerSecond, null);
  assert.ok(!JSON.stringify(s).match(/eta|剩餘|預計/i));
});

test('the totals over every cluster are the sums of their summaries; a cluster that did not say is not counted as zero', () => {
  const rows = [
    summarizeCluster(cluster({ id: 'c_1', workers: [worker({ subagentCounts: counts({ total: 5, running: 3, awaiting: 1, done: 1 }), speed: { tokensPerSecond: 20 } })] })),
    summarizeCluster(cluster({ id: 'c_2', status: 'done', workers: [worker({ status: 'idle', subagentCounts: counts({ total: 4, done: 4 }), subagentsOlder: 2, speed: { tokensPerSecond: 5.5 } })] })),
    summarizeCluster(cluster({ id: 'c_3', workers: [{ sessionId: 'x', status: 'running' }] })),
  ];
  const t = totalsOf(rows);
  assert.equal(t.clusters, 3);
  assert.equal(t.active, 2);
  assert.equal(t.subagentsRunning, 4, '3 running + 1 waiting, of the clusters that said');
  assert.equal(t.subagentsOpened, 11, 'everything ever opened: 5 + 4 + the 2 let go of');
  assert.equal(t.subagentsPartial, true, 'one cluster did not say');
  assert.equal(t.workersRunning, 2);
  assert.equal(t.tokensPerSecond, 25.5);
  assert.deepEqual(totalsOf([]), { clusters: 0, active: 0, workersRunning: 0, subagentsRunning: 0, subagentsOpened: 0, subagentsPartial: false, tokensPerSecond: null });
  assert.equal(totalsOf([rows[2]]).tokensPerSecond, null);
});

test('the list is the working clusters first, each group newest first', () => {
  const rows = [
    { id: 'old-done', status: 'done', createdAt: 5 },
    { id: 'old-run', status: 'running', createdAt: 1 },
    { id: 'new-done', status: 'stopped', createdAt: 9 },
    { id: 'new-run', status: 'merging', createdAt: 7 },
    { id: 'starting', status: 'starting', createdAt: 8 },
  ];
  assert.deepEqual(sortClusters(rows).map((r) => r.id), ['starting', 'new-run', 'old-run', 'new-done', 'old-done']);
  assert.deepEqual(rows.map((r) => r.id)[0], 'old-done', 'the input is not reordered');
});

test('how long a cluster has been going: to now while it works, to the last end the Hub saw once it is over, nothing made up', () => {
  const live = cluster({ createdAt: 1_000_000_000_000 });
  assert.equal(clusterElapsed(live, 1_000_000_000_000 + 90_000), 90_000);
  const over = cluster({ status: 'done', createdAt: 1_000_000_000_000, tasks: [{ finishedAt: 1_000_000_030_000 }, { finishedAt: 1_000_000_050_000 }], workers: [{ finishedAt: 1_000_000_040_000 }] });
  assert.equal(clusterElapsed(over, 9e15), 50_000);
  assert.equal(clusterElapsed(cluster({ status: 'stopped', createdAt: 1_000_000_000_000, tasks: [], workers: [] }), 9e15), null, 'over, with nothing to say when: unknown');
  assert.equal(clusterElapsed({ status: 'running' }, 5), null);
});

test('the bar over tasks, and a worker\'s place in it', () => {
  const c = cluster({ tasks: [{ status: 'done' }, { status: 'done' }, { status: 'running' }, { status: 'failed' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }] });
  const bar = taskBar(c);
  assert.deepEqual([bar.total, bar.done, bar.running, bar.failed], [8, 0.25, 0.125, 0.125]);
  assert.deepEqual(taskBar({ workers: [] }), { total: 0, done: 0, running: 0, failed: 0 });
  const w = workerSquare({ status: 'running', taskIndex: 2, done: 2 }, c);
  assert.deepEqual([w.place, w.share, w.working], ['第 3/8 條', 0.25, true]);
  assert.equal(workerSquare({ status: 'idle', taskIndex: null, done: 3 }, c).place, '做完 3 條');
  assert.equal(workerSquare({ status: 'idle', taskIndex: null, done: 0 }, c).place, '待命');
  assert.equal(workerSquare({ status: 'deleted', taskIndex: null, done: 0 }, c).place, '已刪除');
  assert.equal(workerSquare({ status: 'running' }, { tasks: [] }).place, null, 'a cluster without a queue has no "which task"');
});

test('the key a worker uses: the gateway and the last four characters and nothing else; a removed key, no record yet, and a Hub that does not say are each said as they are', () => {
  const key = { id: 'dk_9f8e7d', gateway: 'opencode-go', gatewayLabel: 'OpenCode Go', hint: 'a1b2', removed: false, lastUsedAt: 1_800_000_000_000, machineId: 'm_secret', distribution: 'relay' };
  assert.deepEqual(keyView({ currentKey: key }), { state: 'ok', text: 'OpenCode Go …a1b2', note: null });
  assert.deepEqual(keyView({ currentKey: { ...key, distribution: 'sticky' } }), { state: 'ok', text: 'OpenCode Go …a1b2', note: '這個對話固定用這一把' });
  assert.equal(keyView({ currentKey: { ...key, gatewayLabel: undefined, gateway: 'commandcode' } }).text, 'Command Code …a1b2', 'the label from the gateway when the Hub sent none');
  assert.deepEqual(keyView({ currentKey: { ...key, hint: null, removed: true } }), { state: 'removed', text: 'key 已從清單移除', note: null });
  assert.equal(keyView({ currentKey: { ...key, removed: true } }).state, 'removed', 'removed, whatever the hint');
  assert.equal(keyView({ currentKey: { ...key, hint: null } }).state, 'removed', 'no hint to name it by');
  assert.deepEqual(keyView({ currentKey: null }), { state: 'none', text: '還沒有請求紀錄', note: null });
  assert.equal(keyView({ turns: 1 }), null, 'a Hub that does not say: nothing is said');
  assert.equal(keyView(undefined), null);
  assert.equal(keyView({ currentKey: { ...key, hint: 'xxxxxa1b2' } }).text, 'OpenCode Go …a1b2', 'never more than the last four');
  const shown = JSON.stringify([keyView({ currentKey: key }), keyView({ currentKey: { ...key, distribution: 'sticky' } })]);
  for (const secret of ['dk_9f8e7d', 'm_secret', '1800000000000']) assert.ok(!shown.includes(secret), `${secret} is not part of what is shown`);
});
