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
  genView,
  groupCounts,
  keyView,
  outputTotalView,
  outputView,
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
const worker = (patch = {}) => ({ sessionId: 's', status: 'running', subagentCounts: counts(), subagentsOlder: 0, speed: { tokensPerSecond: null, requestsPerMinute: null, windowMs: null, unmeasured: '沒有' }, gen: { tokensPerSecond: null, unmeasured: '還沒有完成任何一步' }, done: 0, taskIndex: 0, ...patch });
const THROUGHPUT = (tps = 5.8, over = {}) => ({ windowMs: 60_000, outTokens: Math.round(tps * 60), tokensPerSecond: tps, requests: 5, requestsPerMinute: 5, unmeasured: null, workersCounted: 2, workers: 2, ...over });
const NO_THROUGHPUT = (why = '這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以算速度') => ({ windowMs: null, outTokens: null, tokensPerSecond: null, requests: null, requestsPerMinute: null, unmeasured: why, workersCounted: 0, workers: 2 });
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
  // (The five-minute figure is 平均產出 now: it counts the waiting too, and says so.)
  assert.deepEqual([v.measured, v.text, v.tokens, v.requests], [true, '120 tok/s', '平均產出（最近 2 分鐘，含等待）：120 tok/s', '請求 9／分']);
  assert.equal(v.label, '平均產出（最近 2 分鐘，含等待）');
  assert.equal(v.tip, '最近 5 分鐘內產出的字數 ÷ 300 秒，含等待與工具時間');
  const none = speedView({ tokensPerSecond: null, unmeasured: '連接器還沒有回報過任何請求紀錄' });
  assert.deepEqual([none.measured, none.text, none.tokens], [false, '—', null]);
  assert.equal(none.why, '連接器還沒有回報過任何請求紀錄');
  assert.equal(speedView(undefined).text, '—');
  assert.equal(speedView({ tokensPerSecond: 0, windowMs: 60_000 }).text, '0 tok/s', 'measured zero is a number');
  for (const v2 of [v, none]) assert.ok(!/eta|剩餘|預計|還要|remaining/i.test(JSON.stringify(v2)), 'no estimate of what is left');
});

test('生成速度 of a worker: a number only where the Hub measured one, "—" and its reason otherwise (a measured 0 is a number, not slow), the algorithm in one sentence', () => {
  const v = genView({ tokensPerSecond: 103.4, unmeasured: null });
  assert.deepEqual([v.measured, v.text, v.why], [true, '103 tok/s', null]);
  assert.equal(v.tip, '模型實際吐字時每秒的字數，不含等工具與等第一個字');
  const none = genView({ tokensPerSecond: null, unmeasured: '這個工作者現在沒有在跑' });
  assert.deepEqual([none.measured, none.text, none.why], [false, '—', '這個工作者現在沒有在跑']);
  assert.equal(genView(undefined).text, '—', 'a Hub that does not say: a dash');
  assert.match(genView(undefined).why, /沒有回報生成速度/);
  assert.equal(genView({ tokensPerSecond: 0 }).text, '0 tok/s');
  assert.ok(!/eta|剩餘|預計|還要|remaining/i.test(JSON.stringify([v, none])));
});

test('叢集總產出: the cluster\'s last minute from the Hub\'s own line; says its window when it is shorter than a minute and how many workers the records could speak for; "—" and why where it cannot, and for a cluster that is over', () => {
  const v = outputView(THROUGHPUT(5.84), { active: true });
  assert.deepEqual([v.measured, v.num, v.text], [true, '5.8', '5.8 tok/s']);
  assert.equal(v.sub, '最近 1 分鐘・所有代理（含子代理）');
  assert.equal(v.tip, '最近 1 分鐘所有代理（含子代理）實際產出的字數 ÷ 60 秒；字數在每個請求結束時才計入，所以會略有跳動');
  // A cluster 20 seconds old can only be measured over 20 seconds, and says so.
  const young = outputView(THROUGHPUT(7.5, { windowMs: 20_000 }), { active: true });
  assert.match(young.sub, /最近 20 秒/);
  assert.match(young.sub, /叢集才跑了這麼久/);
  assert.match(young.tip, /20 秒/);
  // Some workers the records cannot speak for: the total is of the others, and says it.
  const part = outputView(THROUGHPUT(5.8, { workersCounted: 1, workers: 3 }), { active: true });
  assert.match(part.sub, /1\/3 個工作者量得到/);
  // A measured zero is a number while the cluster works.
  assert.equal(outputView(THROUGHPUT(0), { active: true }).text, '0 tok/s');
  // Where the records cannot say: a dash and the reason, never 0.
  const none = outputView(NO_THROUGHPUT('連接器還沒有回報過任何請求紀錄'), { active: true });
  assert.deepEqual([none.measured, none.num, none.text, none.why], [false, '—', '—', '連接器還沒有回報過任何請求紀錄']);
  assert.equal(none.sub, '量不到');
  assert.equal(outputView(undefined, { active: true }).num, '—');
  assert.match(outputView(undefined, { active: true }).why, /沒有回報叢集總產出/);
  // A cluster that is over has no "last minute" to say: a dash, not 0.
  const over = outputView(THROUGHPUT(0), { active: false });
  assert.deepEqual([over.measured, over.num], [false, '—']);
  assert.equal(over.sub, '叢集已結束');
  assert.ok(!/eta|剩餘|預計|還要|remaining/i.test(JSON.stringify([v, young, part, none, over])));
});

test('叢集總產出 over every working cluster (the list page\'s big number): the sum, how many clusters it is of, and a dash with the reason when none can say or none is working', () => {
  const v = outputTotalView({ active: 2, outputTokensPerSecond: 82.8, outputMeasured: 2 });
  assert.deepEqual([v.measured, v.num, v.sub], [true, '83', '最近 1 分鐘・2 個進行中叢集合計']);
  assert.equal(outputTotalView({ active: 2, outputTokensPerSecond: 0, outputMeasured: 2 }).num, '0', 'working clusters that produced nothing in the last minute: a measured zero');
  const blind = outputTotalView({ active: 1, outputTokensPerSecond: null, outputMeasured: 0 });
  assert.deepEqual([blind.measured, blind.num, blind.sub], [false, '—', '量不到']);
  assert.match(blind.why, /沒有請求紀錄可算/);
  const idle = outputTotalView({ active: 0, outputTokensPerSecond: null, outputMeasured: 0 });
  assert.deepEqual([idle.measured, idle.num, idle.sub], [false, '—', '沒有進行中的叢集']);
  assert.equal(outputTotalView(undefined).num, '—');
  assert.equal(v.tip, '最近 1 分鐘所有代理（含子代理）實際產出的字數 ÷ 60 秒；字數在每個請求結束時才計入，所以會略有跳動');
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
  // The cluster's last-minute output is the Hub's line, passed on as it is (not a sum of the workers' averages).
  assert.equal(summarizeCluster(cluster({ throughput: THROUGHPUT(12.3) })).throughput.tokensPerSecond, 12.3);
  assert.deepEqual(summarizeCluster(cluster({ throughput: THROUGHPUT(12.3) })).throughput, THROUGHPUT(12.3));
  assert.equal(s.throughput.tokensPerSecond, null, 'a cluster the Hub sent no such line for');
  assert.match(s.throughput.unmeasured, /沒有回報叢集總產出/);

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
    summarizeCluster(cluster({ id: 'c_1', throughput: THROUGHPUT(8.5), workers: [worker({ subagentCounts: counts({ total: 5, running: 3, awaiting: 1, done: 1 }), speed: { tokensPerSecond: 20 } })] })),
    summarizeCluster(cluster({ id: 'c_2', status: 'done', throughput: THROUGHPUT(0), workers: [worker({ status: 'idle', subagentCounts: counts({ total: 4, done: 4 }), subagentsOlder: 2, speed: { tokensPerSecond: 5.5 } })] })),
    summarizeCluster(cluster({ id: 'c_3', workers: [{ sessionId: 'x', status: 'running' }] })),
    summarizeCluster(cluster({ id: 'c_4', throughput: THROUGHPUT(1.25), workers: [worker({ speed: { tokensPerSecond: 3 } })] })),
  ];
  const t = totalsOf(rows);
  assert.equal(t.clusters, 4);
  assert.equal(t.active, 3);
  assert.equal(t.subagentsRunning, 4, '3 running + 1 waiting, of the clusters that said');
  assert.equal(t.subagentsOpened, 11, 'everything ever opened: 5 + 4 + the 2 let go of');
  assert.equal(t.subagentsPartial, true, 'one cluster did not say');
  assert.equal(t.workersRunning, 3);
  // 叢集總產出 over everything: the sum of the clusters that are WORKING and measured one - the finished cluster\'s minute is over, and the one that did not say is not 0.
  assert.equal(t.outputTokensPerSecond, 9.8, '8.5 + 1.25 (the finished cluster\'s 0 is not added, the unsaid one neither)');
  assert.equal(t.outputMeasured, 2);
  // 平均產出 is what the number beside it used to be: the sum of the clusters\' averages, all of them.
  assert.equal(t.avgTokensPerSecond, 28.5);
  assert.ok(!('tokensPerSecond' in t), 'no number left that could be read as either');
  assert.deepEqual(totalsOf([]), { clusters: 0, active: 0, workersRunning: 0, subagentsRunning: 0, subagentsOpened: 0, subagentsPartial: false, outputTokensPerSecond: null, outputMeasured: 0, avgTokensPerSecond: null });
  assert.equal(totalsOf([rows[2]]).outputTokensPerSecond, null);
  assert.equal(totalsOf([rows[1]]).outputTokensPerSecond, null, 'only a cluster that is over: nothing is working, so no output');
  assert.equal(totalsOf([rows[2]]).avgTokensPerSecond, null);
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
