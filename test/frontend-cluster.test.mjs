// The cluster screen's rules that need no browser (public/js/cluster-model.js):
// what a dispatch sends (spec §2), what stops it from being sent, how far a
// cluster is, and how the timing numbers (spec §5) are laid out.
//
// The one rule that matters most is the last block: a number the Hub did not
// measure is never filled in by the page. It says 量不到 and why, and it does not
// work one out from the others (the owner said so on 2026-10-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUSTER_MAX_TASKS,
  CLUSTER_DEFAULTS,
  requestBody,
  draftProblems,
  progressOf,
  isActive,
  workerState,
  clusterStatusLabel,
  contextWarnings,
  mergeAvailability,
  memoryNote,
  fmtBytes,
  MEMORY_MAX_CHARS,
  fmtMs,
  timingView,
} from '../public/js/cluster-model.js';

const draft = (patch = {}) => ({ tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }], ...CLUSTER_DEFAULTS, note: '', ...patch });

// ---------------------------------------------------------------- dispatch

test('the defaults are the spec\'s: brief start, a worktree each, Kimi\'s own swarm mode on; 8 tasks at most', () => {
  assert.deepEqual({ ...CLUSTER_DEFAULTS }, { mode: 'brief', isolate: true, swarm: true });
  assert.equal(CLUSTER_MAX_TASKS, 8);
});

test('the request body is spec §2 exactly: tasks, mode, isolate, swarm, and note only when there is one', () => {
  assert.deepEqual(requestBody(draft()), { tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }], mode: 'brief', isolate: true, swarm: true });
  assert.deepEqual(requestBody(draft({ mode: 'fork', isolate: false, swarm: false, note: '  先讀 README  ' })), {
    tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }],
    mode: 'fork',
    isolate: false,
    swarm: false,
    note: '先讀 README',
  });
  assert.ok(!('note' in requestBody(draft({ note: '   ' }))), 'a blank note is not sent');
});

test('a task without a name is named after the first line of what it says; names and prompts are trimmed', () => {
  const b = requestBody(draft({ tasks: [{ title: '   ', prompt: '  掃描所有路由並列出沒有權限檢查的\n第二行不算  ' }, { title: ' A ', prompt: ' x ' }] }));
  assert.deepEqual(b.tasks, [{ title: '掃描所有路由並列出沒有權限檢查的', prompt: '掃描所有路由並列出沒有權限檢查的\n第二行不算' }, { title: 'A', prompt: 'x' }]);
  const long = requestBody(draft({ tasks: [{ title: '', prompt: 'あ'.repeat(80) }] }));
  assert.ok(long.tasks[0].title.length <= 31 && long.tasks[0].title.endsWith('…'), `a long first line is cut: ${long.tasks[0].title}`);
});

test('what stops a dispatch: no task, more than 8, a task with nothing to do, and an unknown way to start', () => {
  assert.deepEqual(draftProblems(draft()), []);
  assert.match(draftProblems(draft({ tasks: [] })).join(), /至少要有 1 個任務/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` }));
  assert.match(draftProblems(draft({ tasks: nine })).join(), /最多 8 個/);
  assert.deepEqual(draftProblems(draft({ tasks: nine.slice(0, 8) })), [], '8 is fine');
  const blank = draftProblems(draft({ tasks: [{ title: 'a', prompt: 'ok' }, { title: 'b', prompt: '  ' }] }));
  assert.match(blank.join(), /任務 2/, 'names the task that is empty');
  assert.match(draftProblems(draft({ mode: 'swarm' })).join(), /起跑方式/);
});

test('warnings before sending: a fork of a big conversation, and no worktrees', () => {
  assert.deepEqual(contextWarnings({ mode: 'brief', isolate: true, context: { used: 900, size: 1000 } }), [], 'brief start does not carry the history');
  assert.deepEqual(contextWarnings({ mode: 'fork', isolate: true, context: { used: 499, size: 1000 } }), []);
  const big = contextWarnings({ mode: 'fork', isolate: true, context: { used: 500, size: 1000 } });
  assert.equal(big.length, 1);
  assert.match(big[0], /50%/);
  assert.match(big[0], /簡報起跑/);
  assert.deepEqual(contextWarnings({ mode: 'fork', isolate: true, context: null }), [], 'no context figure: nothing is said, nothing is guessed');
  const shared = contextWarnings({ mode: 'brief', isolate: false, context: null });
  assert.match(shared.join(), /同一個資料夾/);
  for (const w of [...big, ...shared]) assert.doesNotMatch(w, /子代理群|Swarm/);
});

// ------------------------------------------------------------------ state

test('progress is workers with a finish time over all workers, a failed one counted on its own; a cluster is active until it is done, stopped or failed', () => {
  const c = { workers: [{ status: 'idle', finishedAt: 5 }, { status: 'running', finishedAt: null }, { status: 'idle', finishedAt: 9 }] };
  assert.deepEqual(progressOf(c), { done: 2, total: 3, failed: 0, deleted: 0 });
  assert.deepEqual(progressOf({ workers: [{ status: 'idle', finishedAt: 5 }, { status: 'error', finishedAt: 6 }, { status: 'error', finishedAt: null }] }), { done: 1, total: 3, failed: 2, deleted: 0 }, 'a worker that stopped with an error has finished but is not 完成');
  assert.deepEqual(progressOf({}), { done: 0, total: 0, failed: 0, deleted: 0 });
  assert.deepEqual(['starting', 'running', 'merging', 'done', 'stopped', 'error'].map((status) => isActive({ status })), [true, true, true, false, false, false]);
  assert.deepEqual(['starting', 'running', 'merging', 'done', 'stopped', 'error'].map(clusterStatusLabel), ['啟動中', '進行中', '合併中', '已完成', '已停止', '出錯']);
});

test('a worker says what its conversation is doing; a finish time makes it 已完成 unless it failed', () => {
  assert.equal(workerState({ status: 'running', finishedAt: null }).label, '執行中');
  assert.equal(workerState({ status: 'awaiting_permission', finishedAt: null }).label, '等你核准');
  assert.equal(workerState({ status: 'idle', finishedAt: null }).label, '閒置');
  assert.equal(workerState({ status: 'idle', finishedAt: 1 }).label, '已完成');
  assert.equal(workerState({ status: 'error', finishedAt: 1 }).label, '出錯', 'a failure is not hidden by a finish time');
  assert.equal(workerState({ status: 'something-new', finishedAt: null }).label, 'something-new', 'an unknown state is said as it came');
});

// ----------------------------------------------------------------- timing

test('durations read as a person says them', () => {
  assert.deepEqual([0, 400, 1500, 59_900, 61_000, 192_000, 3_723_000].map(fmtMs), ['0 秒', '0.4 秒', '1.5 秒', '59.9 秒', '1 分 1 秒', '3 分 12 秒', '1 小時 2 分']);
  assert.equal(fmtMs(null), null);
});

const timing = (patch = {}) => ({ since: 1, turns: 3, wallMs: 100_000, modelMs: 50_000, toolMs: 30_000, compactMs: 0, rateLimitWaitMs: 10_000, requests: 12, http429: 1, subagents: { spawned: 2, requeuedForRateLimit: 0 }, unmeasured: [], ...patch });

test('bar widths are the reported numbers over the reported total, and nothing is added to fill the rest', () => {
  const v = timingView(timing());
  assert.deepEqual(v.segments.map((s) => [s.key, s.label, s.ms, s.share]), [
    ['modelMs', '模型', 50_000, 0.5],
    ['toolMs', '工具', 30_000, 0.3],
    ['rateLimitWaitMs', '等限流', 10_000, 0.1],
    ['compactMs', '壓縮', 0, 0],
  ]);
  assert.equal(v.total.ms, 100_000);
  assert.equal(v.segments.reduce((a, s) => a + s.share, 0), 0.9, 'the 10% that no field accounts for stays empty - it is not given a name');
});

test('a field the Hub could not measure is 量不到 with the Hub\'s reason; it has no width and no number', () => {
  const v = timingView(timing({ modelMs: null, rateLimitWaitMs: null, unmeasured: ['modelMs：閘道請求無法對應到這個對話', 'rateLimitWaitMs：這台電腦的 Kimi 沒有回報限流等待'] }));
  const model = v.segments.find((s) => s.key === 'modelMs');
  assert.equal(model.ms, null);
  assert.equal(model.share, null);
  assert.equal(model.reason, '閘道請求無法對應到這個對話');
  assert.equal(v.segments.find((s) => s.key === 'rateLimitWaitMs').reason, '這台電腦的 Kimi 沒有回報限流等待');
  assert.equal(v.segments.find((s) => s.key === 'toolMs').reason, null, 'a measured one has no reason');
  // The total is the Hub's wallMs, not the sum of what is left.
  assert.equal(v.total.ms, 100_000);
});

test('no total from the Hub: the bar is scaled to the parts, and the total says 量不到 instead of being summed', () => {
  const v = timingView(timing({ wallMs: null, modelMs: 6000, toolMs: 2000, rateLimitWaitMs: 2000, compactMs: 0, unmeasured: ['wallMs：沒有開始時間'] }));
  assert.equal(v.total.ms, null);
  assert.equal(v.total.reason, '沒有開始時間');
  assert.deepEqual(v.segments.map((s) => s.share), [0.6, 0.2, 0.2, 0], 'scaled to the parts that were reported');
});

test('parts that add up to more than the total (clocks that overlap) are scaled so the bar stays inside its track', () => {
  const v = timingView(timing({ wallMs: 10_000, modelMs: 8000, toolMs: 8000, rateLimitWaitMs: 0, compactMs: 0 }));
  assert.deepEqual(v.segments.map((s) => s.share), [0.5, 0.5, 0, 0]);
  assert.equal(v.total.ms, 10_000, 'and the total is still the Hub\'s');
});

test('a field that is missing altogether is 量不到 too, and says nobody reported it; an entry about another field is kept as a note', () => {
  const t = timing({ unmeasured: ['http429：閘道不回報狀態碼', '這是一句沒有欄位名的說明'] });
  delete t.compactMs;
  const v = timingView(t);
  const compact = v.segments.find((s) => s.key === 'compactMs');
  assert.equal(compact.ms, null);
  assert.match(compact.reason, /沒有回報/);
  assert.deepEqual(v.notes, ['429 次數：閘道不回報狀態碼', '這是一句沒有欄位名的說明']);
});

test('a value that is not a number is not drawn; counts are shown only when reported', () => {
  const v = timingView(timing({ modelMs: 'lots', toolMs: -5, requests: null, http429: null, turns: 2 }));
  assert.equal(v.segments.find((s) => s.key === 'modelMs').ms, null);
  assert.equal(v.segments.find((s) => s.key === 'toolMs').ms, null);
  assert.deepEqual(v.facts, [['回合', 2], ['子代理', 2], ['子代理限流重排', 0]], 'only the counts that came, in a fixed order');
  assert.deepEqual(timingView(timing({ requests: 12, http429: 3 })).facts.map(([k]) => k), ['回合', '請求', '429 次數', '子代理', '子代理限流重排']);
});

test('when the timing could not be had at all, the whole thing is 量不到 with the error as the reason', () => {
  const v = timingView(null, new Error('HTTP 404'));
  assert.deepEqual(v.segments, []);
  assert.equal(v.failed, 'HTTP 404');
  const w = timingView(undefined);
  assert.match(w.failed, /沒有回報/);
});

// ------------------------------------------------- what the Hub changed (core)

test('a worker whose conversation was deleted is its own state, is not 完成, and is counted on its own', () => {
  assert.equal(workerState({ status: 'deleted', finishedAt: 5 }).label, '已刪除');
  const c = { workers: [{ status: 'idle', finishedAt: 5 }, { status: 'deleted', finishedAt: 6 }, { status: 'error', finishedAt: 7 }, { status: 'running', finishedAt: null }] };
  assert.deepEqual(progressOf(c), { done: 1, total: 4, failed: 1, deleted: 1 });
});

test('a full fork is warned about while the main conversation works (the Hub refuses it then); a brief start is not', () => {
  assert.match(contextWarnings({ mode: 'fork', isolate: true, busy: true }).join(), /正在工作.*閒下來/);
  assert.deepEqual(contextWarnings({ mode: 'brief', isolate: true, busy: true }), []);
  assert.deepEqual(contextWarnings({ mode: 'fork', isolate: true, busy: false }), []);
});

test('merging: not without branches, not twice (the Hub refuses a second), not while one runs; unfinished workers are said', () => {
  const w = (patch = {}) => ({ branch: 'cluster/c/w1', finishedAt: 1, status: 'idle', ...patch });
  const c = (patch = {}) => ({ id: 'c_1', isolate: true, status: 'running', merge: null, workers: [w(), w()], ...patch });
  assert.deepEqual(mergeAvailability(c()), { ok: true, why: '把各工作者的分支合進一個新分支' });
  assert.match(mergeAvailability(c({ workers: [w(), w({ finishedAt: null })] })).why, /還有 1 個工作者沒做完.*已 commit/);
  assert.equal(mergeAvailability(c({ workers: [w(), w({ finishedAt: null })] })).ok, true, 'merging early is allowed, with the warning');
  assert.equal(mergeAvailability(c({ workers: [w(), w({ finishedAt: null, status: 'deleted' })] })).why, '把各工作者的分支合進一個新分支', 'a deleted worker is not "still working"');
  assert.match(mergeAvailability(c({ isolate: false })).why, /沒有獨立 worktree/);
  assert.match(mergeAvailability(c({ workers: [w({ branch: null }), w({ branch: null })] })).why, /沒有獨立 worktree/);
  const done = mergeAvailability(c({ merge: { branch: 'cluster/c_1/merged', results: [] } }));
  assert.equal(done.ok, false);
  assert.match(done.why, /已經合併過了.*不支援重新合併/);
  assert.equal(mergeAvailability(c({ status: 'merging' })).ok, false);
  assert.equal(mergeAvailability(c(), true).ok, false, 'while another request is out');
});

test('a memory the Hub cut to its end says where the shown part starts; a whole one says nothing', () => {
  assert.equal(memoryNote({ text: 'x', bytes: 10 }), null);
  assert.equal(memoryNote({ text: 'x', truncated: false, from: 0 }), null);
  const n = memoryNote({ text: 'x', bytes: 250_000, truncated: true, from: 160_000 });
  assert.match(n, /只顯示最後一段/);
  assert.match(n, /160000/);
  assert.match(n, /250\.0 KB/);
  assert.match(memoryNote({ text: 'x', truncated: true }), /只顯示最後一段/, 'without the figures it still says so');
  assert.equal(MEMORY_MAX_CHARS, 20_000);
  assert.deepEqual([0, 512, 1500, 250_000, 2_500_000].map(fmtBytes), ['0 B', '512 B', '1.5 KB', '250.0 KB', '2.5 MB']);
});
