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
  CLUSTER_MAX_WORKERS,
  CLUSTER_DEFAULTS,
  defaultWorkers,
  workersFor,
  parseTaskLines,
  queueAdvice,
  queueView,
  workerQueueLine,
  looksLikeWriting,
  looksReadOnly,
  requestBody,
  draftProblems,
  progressOf,
  failedText,
  isActive,
  workerState,
  clusterStatusLabel,
  contextWarnings,
  mergeAvailability,
  cleanupAvailability,
  cleanupPlanView,
  cleanupResultView,
  memoryNote,
  fmtBytes,
  MEMORY_MAX_CHARS,
  fmtMs,
  timingView,
} from '../public/js/cluster-model.js';

const draft = (patch = {}) => ({ tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }], ...CLUSTER_DEFAULTS, note: '', ...patch });

// ---------------------------------------------------------------- dispatch

test('the defaults are the spec\'s: brief start, a worktree each, Kimi\'s own swarm mode on; 64 tasks and 8 workers at most', () => {
  assert.deepEqual({ ...CLUSTER_DEFAULTS }, { mode: 'brief', isolate: true, swarm: true });
  assert.equal(CLUSTER_MAX_TASKS, 64);
  assert.equal(CLUSTER_MAX_WORKERS, 8);
});

test('the request body is spec §2 exactly: tasks, mode, isolate, swarm, workers, and note only when there is one', () => {
  assert.deepEqual(requestBody(draft()), { tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }], mode: 'brief', isolate: true, swarm: true, workers: 1 });
  assert.deepEqual(requestBody(draft({ mode: 'fork', isolate: false, swarm: false, note: '  先讀 README  ' })), {
    tasks: [{ title: '修登入', prompt: '把登入頁的錯誤訊息改好' }],
    mode: 'fork',
    isolate: false,
    swarm: false,
    workers: 1,
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

test('what stops a dispatch: no task, more than 64, a task with nothing to do, and an unknown way to start', () => {
  assert.deepEqual(draftProblems(draft()), []);
  assert.match(draftProblems(draft({ tasks: [] })).join(), /至少要有 1 個任務/);
  const many = Array.from({ length: 65 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` }));
  assert.match(draftProblems(draft({ tasks: many })).join(), /最多 64 個/);
  assert.deepEqual(draftProblems(draft({ tasks: many.slice(0, 64) })), [], '64 is fine - more than the workers: they wait in the queue');
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

// ---------------------------------------------------------------- clean up

test('清理: not while a worker works or the cluster is being made or merged, not twice over, and says what it will and will not do', () => {
  const w = (patch = {}) => ({ sessionId: 's_w', branch: 'cluster/c/w1', finishedAt: 1, status: 'idle', hidden: false, ...patch });
  const c = (patch = {}) => ({ id: 'c_1', isolate: true, status: 'done', merge: { branch: 'cluster/c_1/merged', results: [] }, cleanup: null, workers: [w(), w({ sessionId: 's_x' })], ...patch });
  const ok = cleanupAvailability(c());
  assert.equal(ok.ok, true);
  assert.match(ok.why, /移除乾淨的 worktree.*收起.*保留/, 'after a merge');
  assert.match(cleanupAvailability(c({ merge: null })).why, /還沒合併過.*沒有任何新 commit.*有 commit 的會保留/, 'before any merge it says what is different');
  assert.match(cleanupAvailability(c({ isolate: false, merge: null })).why, /共用同一個資料夾.*只把工作者對話從側欄收起/, 'with no worktrees it only tidies the sidebar, and says so');
  // The Hub refuses while a worker works (409); the button does not offer what it would refuse.
  const busy = cleanupAvailability(c({ status: 'running', workers: [w(), w({ status: 'running', finishedAt: null })] }));
  assert.equal(busy.ok, false);
  assert.match(busy.why, /工作者還在跑，先全部停止/);
  assert.equal(cleanupAvailability(c({ workers: [w({ status: 'awaiting_permission' })] })).ok, false);
  // ... but a cluster that reads "進行中" with nothing working (a worker that never started) can be cleaned: the Hub allows it.
  assert.equal(cleanupAvailability(c({ status: 'running', workers: [w({ finishedAt: null })] })).ok, true);
  assert.equal(cleanupAvailability(c({ status: 'merging' })).ok, false);
  assert.equal(cleanupAvailability(c({ status: 'starting' })).ok, false);
  assert.equal(cleanupAvailability(c(), true).ok, false, 'while another request is out');
  assert.equal(cleanupAvailability(c({ workers: [] })).ok, false);
  // Everything was cleaned and nothing is left over: nothing to do again. A worker put back on the sidebar, or one that was kept, can be done.
  const res = (patch = {}) => ({ sessionId: 's_w', worktree: 'removed', branch: 'deleted', hidden: true, reasons: [], ...patch });
  const cleaned = c({ cleanup: { at: 1, auto: true, results: [res(), res({ sessionId: 's_x' })] }, workers: [w({ hidden: true }), w({ sessionId: 's_x', hidden: true })] });
  assert.equal(cleanupAvailability(cleaned).ok, false);
  assert.match(cleanupAvailability(cleaned).why, /已經清理乾淨/);
  assert.equal(cleanupAvailability({ ...cleaned, cleanup: { ...cleaned.cleanup, results: [res(), res({ sessionId: 's_x', worktree: 'kept', branch: 'kept', hidden: false })] } }).ok, true, 'something was kept');
  assert.equal(cleanupAvailability({ ...cleaned, cleanup: { ...cleaned.cleanup, results: [res(), res({ sessionId: 's_x', hidden: false })] } }).ok, true, 'one was put back on the sidebar');
  assert.equal(cleanupAvailability(c({ workers: [w({ hidden: true }), w({ sessionId: 's_x', status: 'deleted' })], cleanup: { at: 1, auto: true, results: [res(), res({ sessionId: 's_x', hidden: false })] } })).ok, false, 'a deleted conversation is not "left over"');
});

test('the plan the Hub sends is laid out for the confirmation: what will be done per worker, what is kept and why, and the counts only of what will really happen', () => {
  const workers = [{ sessionId: 's1', title: '改登入' }, { sessionId: 's2', title: '改註冊' }, { sessionId: 's3', title: '只讀' }];
  const plan = {
    dryRun: true,
    results: [
      { sessionId: 's1', worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] },
      { sessionId: 's2', worktree: 'kept', branch: 'kept', hidden: false, reasons: ['有 2 項未提交的修改或未追蹤的檔案', '分支還被 worktree 使用中'] },
      { sessionId: 's3', worktree: 'removed', branch: 'deleted', hidden: true, reasons: ['worktree 資料夾本來就不在了'] },
    ],
    actions: [
      { sessionId: 's1', removeWorktree: true, deleteBranch: true, hide: true },
      { sessionId: 's2', removeWorktree: false, deleteBranch: false, hide: false },
      { sessionId: 's3', removeWorktree: false, deleteBranch: true, hide: true },
    ],
  };
  const v = cleanupPlanView(plan, workers);
  assert.deepEqual(v.rows.map((r) => [r.title, r.will, r.keeps]), [['改登入', ['移除 worktree', '刪除分支', '從側欄收起對話'], false], ['改註冊', [], true], ['只讀', ['刪除分支', '從側欄收起對話'], false]]);
  assert.deepEqual(v.rows[1].reasons, ['有 2 項未提交的修改或未追蹤的檔案', '分支還被 worktree 使用中']);
  assert.deepEqual(v.totals, { worktrees: 1, branches: 2, hidden: 2, kept: 1 }, 'a worktree that was already gone is not "removed" by this');
  assert.equal(v.nothing, false);
  const none = cleanupPlanView({ dryRun: true, results: [plan.results[1]], actions: [plan.actions[1]] }, workers);
  assert.equal(none.nothing, true);
  assert.deepEqual(cleanupPlanView(null, workers).rows, [], 'no plan, no rows');
});

test('the result of a worker\'s clean-up is said in the words of the screen: worktree and branch each removed / kept / not there, whether it is off the sidebar, and why anything was kept', () => {
  assert.deepEqual(cleanupResultView({ sessionId: 's', worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] }), { worktree: { text: '已移除', kept: false }, branch: { text: '已刪除', kept: false }, hidden: true, reasons: [], kept: false });
  const kept = cleanupResultView({ sessionId: 's', worktree: 'kept', branch: 'kept', hidden: false, reasons: ['有 1 項未提交的修改或未追蹤的檔案'] });
  assert.deepEqual([kept.worktree, kept.branch, kept.hidden, kept.kept], [{ text: '保留', kept: true }, { text: '保留', kept: true }, false, true]);
  assert.deepEqual(kept.reasons, ['有 1 項未提交的修改或未追蹤的檔案']);
  const shared = cleanupResultView({ sessionId: 's', worktree: null, branch: null, hidden: true, reasons: [] });
  assert.equal(shared.worktree, null, 'a worker with no worktree of its own has nothing to say about one');
  assert.equal(shared.branch, null);
  assert.equal(cleanupResultView(null), null);
});

// -------------------------------------------------------------- the queue

const nTasks = (n, make = (i) => ({ title: `任務${i + 1}`, prompt: `做第 ${i + 1} 件事` })) => Array.from({ length: n }, (_, i) => make(i));

test('workers: one per task up to 4 unless chosen; a chosen number is a whole number from 1 to 8; never more than there are tasks', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 64].map(defaultWorkers), [1, 2, 3, 4, 4, 4, 4]);
  assert.equal(workersFor(draft({ tasks: nTasks(6) })), 4, 'not chosen: the default');
  assert.equal(workersFor(draft({ tasks: nTasks(6), workers: null })), 4, 'null is "not chosen" too');
  assert.equal(workersFor(draft({ tasks: nTasks(6), workers: 2 })), 2);
  assert.equal(workersFor(draft({ tasks: nTasks(20), workers: 8 })), 8);
  assert.equal(workersFor(draft({ tasks: nTasks(3), workers: 8 })), 3, 'a worker with no task would only sit there');
  assert.equal(workersFor(draft({ tasks: nTasks(6), workers: 0 })), 4, 'a number the form refuses is not sent: the default stands in');
  assert.equal(requestBody(draft({ tasks: nTasks(6), workers: 3 })).workers, 3);
  assert.equal(requestBody(draft({ tasks: nTasks(6) })).workers, 4);
  assert.equal(requestBody(draft({ tasks: nTasks(2), workers: 8 })).workers, 2);
  for (const bad of [0, 9, 1.5, -1]) assert.match(draftProblems(draft({ tasks: nTasks(6), workers: bad })).join(), /工作者數要是 1 到 8/, `${bad} is refused`);
  assert.deepEqual(draftProblems(draft({ tasks: nTasks(6), workers: 8 })), []);
  assert.deepEqual(draftProblems(draft({ tasks: nTasks(6), workers: null })), [], 'not chosen is fine');
});

test('many tasks pasted at once: one per line, blank lines skipped, a copied list marker taken off, each named after its line', () => {
  const got = parseTaskLines('審查 A 模組\n\n  - 審查 B 模組  \n2. 審查 C 模組\n3) 審查 D\n• 審查 E\n\r\n* 審查 F\n');
  assert.deepEqual(got.map((t) => t.prompt), ['審查 A 模組', '審查 B 模組', '審查 C 模組', '審查 D', '審查 E', '審查 F']);
  assert.deepEqual(got.map((t) => t.title), got.map((t) => t.prompt), 'a short line is its own name');
  assert.deepEqual(parseTaskLines(''), []);
  assert.deepEqual(parseTaskLines('   \n\n \t\n'), []);
  assert.deepEqual(parseTaskLines('1.5 倍速度測試'), [{ title: '1.5 倍速度測試', prompt: '1.5 倍速度測試' }], 'a number that is not a list marker stays');
  assert.deepEqual(parseTaskLines('2024-01 的報表'), [{ title: '2024-01 的報表', prompt: '2024-01 的報表' }]);
  const long = parseTaskLines(`請審查這個很長很長很長很長很長很長很長很長很長很長的任務${'。'.repeat(30)}`)[0];
  assert.ok(long.title.length <= 31 && long.title.endsWith('…') && long.prompt.length > 31, 'a long line is cut for its name, whole as the task');
  assert.equal(parseTaskLines(Array.from({ length: 70 }, (_, i) => `t${i}`).join('\n')).length, 70, 'the cap is the dialog\'s to apply, not this function\'s');
});

test('the dialog\'s suggestion: few tasks → do it here; many alike read-only ones → one conversation with the native swarm; writing with a shared folder → a worktree each; nothing chosen or changed for the person', () => {
  const ids = (o) => queueAdvice(o).map((a) => a.id);
  const read = (n) => nTasks(n, (i) => ({ title: `審查 ${i}`, prompt: `審查 src/mod${i}.js 並列出問題` }));
  const write = (n) => nTasks(n, (i) => ({ title: `改 ${i}`, prompt: `修改 src/mod${i}.js 並新增測試` }));
  // up to 3 tasks: do it in this conversation
  for (const n of [1, 2, 3]) {
    const advice = queueAdvice({ tasks: read(n), isolate: true });
    assert.deepEqual(advice.map((a) => a.id), ['few']);
    assert.match(advice[0].text, /任務很少/);
    assert.match(advice[0].text, /直接在這個對話做通常最快/);
  }
  assert.deepEqual(ids({ tasks: read(4), isolate: true }), [], 'four tasks: no suggestion either way');
  // many tasks of the same read-only kind
  const many = queueAdvice({ tasks: read(8), isolate: true });
  assert.deepEqual(many.map((a) => a.id), ['readonly-swarm']);
  assert.match(many[0].text, /Swarm 模式一次派出/);
  assert.match(many[0].text, /Kimi 原生/, 'whose swarm it is');
  assert.deepEqual(ids({ tasks: [...read(7), ...write(1)], isolate: true }), [], 'one that writes spoils "all read-only"');
  assert.deepEqual(ids({ tasks: nTasks(8, () => ({ title: '雜事', prompt: '做一些事情' })), isolate: true }), [], 'tasks that say nothing either way are not called read-only');
  // writing without a worktree each
  const shared = queueAdvice({ tasks: write(6), isolate: false });
  assert.deepEqual(shared.map((a) => a.id), ['isolate']);
  assert.match(shared[0].text, /建議每個工作者獨立 worktree/);
  assert.deepEqual(ids({ tasks: write(6), isolate: true }), [], 'already isolated: nothing to suggest');
  assert.deepEqual(ids({ tasks: read(6), isolate: false }), ['readonly-swarm'], 'read-only tasks do not need a worktree each');
  assert.deepEqual(ids({ tasks: write(2), isolate: false }), ['few', 'isolate'], 'both can be said');
  // empty tasks are not tasks; nothing to say about nothing
  assert.deepEqual(queueAdvice({ tasks: [{ title: '', prompt: '  ' }] }), []);
  assert.deepEqual(queueAdvice({}), []);
  // it only says things: the same input gives the same words, and the input is untouched
  const input = { tasks: write(2), isolate: false };
  const before = JSON.stringify(input);
  assert.deepEqual(queueAdvice(input), queueAdvice(input));
  assert.equal(JSON.stringify(input), before);
  for (const a of [...many, ...shared]) assert.doesNotMatch(a.text.replace(/Kimi 原生的 Swarm 模式/, ''), /Swarm|子代理群/, 'the cluster is never called a Swarm');
  // the words it reads
  assert.equal(looksLikeWriting({ title: '', prompt: 'fix the login bug' }), true);
  assert.equal(looksReadOnly({ title: '', prompt: 'review the login flow' }), true);
  assert.equal(looksReadOnly({ title: '', prompt: 'review the login flow and fix it' }), false);
});

test('progress counts TASKS when the cluster has them (a failed one on its own), and workers as before when it has none', () => {
  const tasks = (...s) => s.map((status, index) => ({ index, title: `t${index}`, status }));
  const c = { workers: [{ status: 'idle', finishedAt: 5 }, { status: 'running', finishedAt: null }], tasks: tasks('done', 'done', 'done', 'running', 'pending', 'failed') };
  assert.deepEqual(progressOf(c), { done: 3, total: 6, failed: 1, deleted: 0 });
  assert.deepEqual(progressOf({ ...c, workers: [{ status: 'deleted' }, { status: 'idle', finishedAt: 5 }] }), { done: 3, total: 6, failed: 1, deleted: 1 });
  assert.deepEqual(progressOf({ workers: [{ status: 'idle', finishedAt: 5 }], tasks: [] }), { done: 1, total: 1, failed: 0, deleted: 0 }, 'no tasks listed: the workers, as before');
});

test('the queue as the page lists it: state, worker, and the Hub\'s two moments with the length between them; a stop says what was never sent', () => {
  const T0 = 1_790_000_000_000;
  const cluster = {
    status: 'running',
    workers: [{ sessionId: 'a', title: '甲' }, { sessionId: 'b', title: '乙' }],
    tasks: [
      { index: 0, title: '第一', status: 'done', workerSessionId: 'a', startedAt: T0, finishedAt: T0 + 192_000, attempts: 1, error: null },
      { index: 1, title: '第二', status: 'running', workerSessionId: 'b', startedAt: T0 + 5000, finishedAt: null, attempts: 1, error: null },
      { index: 2, title: '第三', status: 'pending', workerSessionId: null, startedAt: null, finishedAt: null, attempts: 1, error: 'w1 的回合出錯了，已退回佇列等別的工作者接手' },
      { index: 3, title: '第四', status: 'failed', workerSessionId: 'a', startedAt: T0 + 1000, finishedAt: T0 + 2000, attempts: 2, error: 'w1 的回合出錯了；這條已經重派過一次，不再重派' },
      { index: 4, title: '第五', status: 'pending', workerSessionId: null, startedAt: null, finishedAt: null, attempts: 0, error: null },
    ],
  };
  const v = queueView(cluster);
  assert.deepEqual(v.sum, { total: 5, done: 1, running: 1, pending: 2, failed: 1 });
  assert.deepEqual(v.rows.map((r) => [r.no, r.label, r.tone, r.workerNo]), [[1, '已完成', 'ok', 1], [2, '進行中', 'busy', 2], [3, '等待中', 'idle', null], [4, '失敗', 'danger', 1], [5, '等待中', 'idle', null]]);
  assert.equal(v.rows[0].span, '3 分 12 秒', 'the length is end minus start, both the Hub\'s own');
  assert.match(v.rows[0].started, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(v.rows[1].ended, null, 'a task still running has no end and no length');
  assert.equal(v.rows[1].span, null);
  assert.equal(v.rows[2].started, null);
  assert.deepEqual(v.rows.map((r) => r.handedBack), [false, false, true, true, false], 'handed back once, whatever it is now');
  assert.equal(v.neverSent, 0, 'running: waiting tasks are about to be sent');
  const stopped = queueView({ ...cluster, status: 'stopped' });
  assert.equal(stopped.neverSent, 2, 'after a stop what still waits was never sent');
  // an end before the start is not made into a length
  assert.equal(queueView({ workers: [], tasks: [{ index: 0, title: 'x', status: 'done', startedAt: T0 + 10, finishedAt: T0, attempts: 1 }] }).rows[0].span, null);
  assert.deepEqual(queueView({}).rows, []);
});

test('a worker card says which task it is on and how many it has done', () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ index: i, title: `任務${i + 1}`, status: 'pending' }));
  const c = { status: 'running', tasks };
  assert.equal(workerQueueLine({ status: 'running', taskIndex: 2, done: 2 }, c), '正在做第 3/6 條「任務3」 · 已完成 2 條');
  assert.equal(workerQueueLine({ status: 'idle', taskIndex: null, done: 3 }, c), '等待下一條 · 已完成 3 條');
  assert.equal(workerQueueLine({ status: 'idle', taskIndex: null, done: 3 }, { status: 'done', tasks: tasks.map((t) => ({ ...t, status: 'done' })) }), '手上沒有任務 · 已完成 3 條');
  assert.equal(workerQueueLine({ status: 'idle', taskIndex: null, done: 1 }, { status: 'stopped', tasks }), '手上沒有任務 · 已完成 1 條', 'after a stop it is not waiting for a next one');
  assert.equal(workerQueueLine({ status: 'deleted', taskIndex: null, done: 1 }, c), '對話已刪除 · 已完成 1 條');
  assert.equal(workerQueueLine({ status: 'idle' }, { tasks: [] }), null, 'a cluster without tasks (an older Hub) says nothing');
});

test('merge and clean-up count the queue: tasks still to do are said before a merge, and clean-up waits for the queue unless a stop ended it', () => {
  const base = { isolate: true, status: 'running', merge: null, workers: [{ status: 'idle', branch: 'b1', finishedAt: 5 }], tasks: [{ index: 0, status: 'done' }, { index: 1, status: 'pending' }, { index: 2, status: 'running' }] };
  assert.match(mergeAvailability(base).why, /還有 2 條任務沒做完/);
  assert.equal(mergeAvailability({ ...base, tasks: [{ index: 0, status: 'done' }] }).why, '把各工作者的分支合進一個新分支');
  assert.match(mergeAvailability({ ...base, tasks: [{ index: 0, status: 'done' }, { index: 1, status: 'failed' }] }).why, /^1 條任務失敗或被中斷；現在合併只會合進各工作者已 commit 的內容$/, 'a task that failed or was cut off is said too - its worker may have left half a change');
  assert.match(mergeAvailability({ ...base, tasks: [{ index: 0, status: 'pending' }, { index: 1, status: 'failed' }] }).why, /還有 1 條任務沒做完、1 條任務失敗或被中斷/);
  assert.equal(cleanupAvailability(base).ok, false);
  assert.match(cleanupAvailability(base).why, /佇列還有任務/);
  assert.equal(cleanupAvailability({ ...base, tasks: [{ index: 0, status: 'done' }, { index: 1, status: 'failed' }] }).ok, true, 'nothing left to do');
  assert.equal(cleanupAvailability({ ...base, status: 'stopped', tasks: [{ index: 0, status: 'done' }, { index: 1, status: 'pending' }] }).ok, true, 'a stop ended the dispatching: what waits will never be sent');
});

test('a failure is counted in the unit of what is counted: 條失敗 for tasks, 個出錯 for workers of a cluster with no task list', () => {
  assert.equal(failedText({ tasks: [{ index: 0, status: 'failed' }] }, 2), '2 條失敗');
  assert.equal(failedText({ tasks: [] , workers: [] }, 2), '2 個出錯');
  assert.equal(failedText({}, 1), '1 個出錯');
});
