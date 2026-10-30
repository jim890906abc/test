// The rules behind the full purge's screens, in node (no page): what each box
// would change (the ONE function the Hub runs and the dialog shows), how the
// plan and the outcome read, the cluster's name and its main-conversation line,
// the share of time the workers write, and the tile's two speeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePurgeWorker,
  decidePurgeMerged,
  purgeOptions,
  purgePlanView,
  purgeResultView,
  clusterNameOf,
  parentLine,
  genShareView,
  tileSpeedView,
  stepsView,
  autoClusterName,
  isPurgeableRow,
  summarizeCluster,
  clusterStatusLabel,
} from '../public/js/cluster-model.js';

const F = (over = {}) => ({ hasWorktree: true, dir: true, registered: true, dirty: 0, statusError: '', tip: 'a1', mergedTip: 'b2', safe: 'merged', unique: 0, checkedOutAt: [], ...over });
const on = (k) => ({ [k]: true });

test('the options are only ever the four booleans, off unless exactly true', () => {
  assert.deepEqual(purgeOptions({}), { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false });
  assert.deepEqual(purgeOptions({ discardDirty: 'true', deleteUnmerged: 1, deleteMerged: 'yes', noBackup: 'on', extra: true }), { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false }, 'a string or a number is not a yes');
  assert.deepEqual(purgeOptions({ discardDirty: true, noBackup: true }), { discardDirty: true, deleteUnmerged: false, deleteMerged: false, noBackup: true });
  assert.deepEqual(purgeOptions(null), { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false });
});

test('a worktree: clean goes, dirty goes only with its box, a folder git does not know or cannot read is never touched whatever is ticked', () => {
  const all = { discardDirty: true, deleteUnmerged: true, deleteMerged: true };
  assert.equal(decidePurgeWorker(F()).worktree, 'remove');
  assert.equal(decidePurgeWorker(F({ dirty: 2 })).worktree, 'keep');
  assert.equal(decidePurgeWorker(F({ dirty: 2 })).keptBy.worktree, 'option', 'kept by an unticked box');
  assert.match(decidePurgeWorker(F({ dirty: 2 })).why.worktree, /有 2 項未提交.*沒勾「也丟掉未提交的修改」/);
  assert.equal(decidePurgeWorker(F({ dirty: 2 }), on('discardDirty')).worktree, 'discard');
  assert.equal(decidePurgeWorker(F({ dirty: 2 }), on('deleteUnmerged')).worktree, 'keep', 'another box does not decide this one');
  assert.equal(decidePurgeWorker(F({ dir: false }), all).worktree, 'gone');
  for (const bad of [F({ registered: false, dirty: 5 }), F({ statusError: 'fatal: bad index', dirty: 0 })]) {
    const d = decidePurgeWorker(bad, all);
    assert.equal(d.worktree, 'keep', 'not touched even with everything ticked');
    assert.equal(d.keptBy.worktree, 'problem', 'and that is a failure, not a choice');
  }
});

test('a branch: safe ones go, one with commits found nowhere else only with its box, one checked out elsewhere never, and none while its worktree stays', () => {
  assert.equal(decidePurgeWorker(F()).branch, 'delete');
  assert.equal(decidePurgeWorker(F({ safe: '', unique: 3 })).branch, 'keep');
  assert.equal(decidePurgeWorker(F({ safe: '', unique: 3 })).keptBy.branch, 'option');
  assert.match(decidePurgeWorker(F({ safe: '', unique: 3 })).why.branch, /3 個 commit 沒合併進去.*沒勾「也刪除沒合併進去的分支」/);
  assert.equal(decidePurgeWorker(F({ safe: '', unique: 3 }), on('deleteUnmerged')).branch, 'delete-unmerged');
  assert.equal(decidePurgeWorker(F({ safe: '', unique: 3 }), on('discardDirty')).branch, 'keep');
  const elsewhere = decidePurgeWorker(F({ safe: '', checkedOutAt: ['/home/user/other'] }), { deleteUnmerged: true });
  assert.deepEqual([elsewhere.branch, elsewhere.keptBy.branch], ['keep', 'problem']);
  assert.match(elsewhere.why.branch, /\/home\/user\/other 檢出/);
  assert.equal(decidePurgeWorker(F({ tip: '' })).branch, 'gone');
  // The worktree stays (dirty, unticked): the branch it holds stays with it, for the same reason.
  const stays = decidePurgeWorker(F({ dirty: 1 }));
  assert.deepEqual([stays.worktree, stays.branch, stays.keptBy.branch], ['keep', 'keep', 'option']);
  assert.equal(stays.why.branch, '分支還被保留下來的 worktree 使用中（沒勾「也丟掉未提交的修改」）');
  // Both boxes: both go.
  const both = decidePurgeWorker(F({ dirty: 1, safe: '', unique: 1 }), { discardDirty: true, deleteUnmerged: true });
  assert.deepEqual([both.worktree, both.branch, both.reasons], ['discard', 'delete-unmerged', []]);
  // A folder shared by the workers: nothing of the kind.
  assert.deepEqual(decidePurgeWorker({ hasWorktree: false }, { discardDirty: true }), { worktree: 'none', branch: 'none', reasons: [], why: { worktree: '', branch: '' }, keptBy: { worktree: null, branch: null } });
  assert.equal(decidePurgeWorker(undefined).worktree, 'none');
});

test('the merged branch goes only with its box, and is said when it is not there', () => {
  assert.deepEqual(decidePurgeMerged(false, on('deleteMerged')), { state: 'none', reason: '' });
  assert.deepEqual(decidePurgeMerged(true, {}), { state: 'keep', reason: '沒勾「也刪除合併分支」，所以保留' });
  assert.deepEqual(decidePurgeMerged(true, on('deleteMerged')), { state: 'delete', reason: '' });
  assert.equal(decidePurgeMerged(true, { discardDirty: true, deleteUnmerged: true }).state, 'keep', 'the other two do not take it');
});

const PLAN = () => ({
  workers: [
    { sessionId: 'w1', n: 1, title: 'a', exists: true, worktree: '/p/w1', branch: 'b1', conversation: { kimiSessions: 1, kimiSubagents: 4 }, facts: F() },
    { sessionId: 'w2', n: 2, title: 'b', exists: true, worktree: '/p/w2', branch: 'b2', conversation: { kimiSessions: 1, kimiSubagents: 0 }, facts: F({ safe: '', unique: 2 }) },
    { sessionId: 'w3', n: 3, title: 'c', exists: false, worktree: '/p/w3', branch: 'b3', conversation: { kimiSessions: 0, kimiSubagents: 0 }, facts: F({ dirty: 1 }) },
    { sessionId: 'w4', n: 4, title: 'd', exists: true, worktree: null, branch: null, conversation: { kimiSessions: 1, kimiSubagents: 0 }, facts: { hasWorktree: false } },
  ],
  merged: { branch: 'cluster/c/merged', exists: true },
  totals: { kimiSessions: 3, kimiSubagents: 4 },
  connector: { canDeleteKimi: true },
  days: 7,
});

test('the plan as the dialog shows it: the counts follow the boxes, a conversation that is already gone is not counted, and what each box could take is counted for its label', () => {
  const v0 = purgePlanView(PLAN(), {});
  assert.deepEqual(v0.totals, { conversations: 3, kimiSessions: 3, kimiSubagents: 4, worktrees: 2, discarded: 0, branches: 1, kept: 3 });
  assert.deepEqual(v0.boxes, { dirty: 1, unmerged: 1, merged: true });
  assert.deepEqual(v0.rows.map((r) => r.keeps), [false, true, true, false]);
  assert.deepEqual(v0.rows[3].will, ['對話（Hub 紀錄＋Kimi 紀錄）'], 'a shared folder has no worktree or branch to list');
  const v1 = purgePlanView(PLAN(), { discardDirty: true });
  assert.deepEqual([v1.totals.worktrees, v1.totals.discarded, v1.totals.branches, v1.totals.kept], [3, 1, 2, 2]);
  const v2 = purgePlanView(PLAN(), { discardDirty: true, deleteUnmerged: true, deleteMerged: true });
  assert.deepEqual([v2.totals.worktrees, v2.totals.branches, v2.totals.kept, v2.merged.state], [3, 3, 0, 'delete']);
  assert.deepEqual(v0.rows[2].will.includes('移除 worktree'), false);
  assert.equal(purgePlanView({}, {}).totals.conversations, 0, 'an empty plan does not break it');
});

test('the outcome as the result page reads it: deleted counts from what happened, kept and failed as they were said, a partial or aborted one named as such', () => {
  const result = {
    aborted: false,
    removed: true,
    partial: false,
    connectorNote: null,
    workers: [
      { conversation: 'deleted', worktree: 'removed', branch: 'deleted' },
      { conversation: 'deleted', worktree: 'discarded', branch: 'deleted' },
      { conversation: 'gone', worktree: 'gone', branch: 'gone' },
      { conversation: 'deleted', worktree: 'none', branch: 'none' },
    ],
    merged: { branch: 'cluster/c/merged', state: 'deleted' },
    memory: { state: 'deleted' },
    kept: [],
    failed: [],
    backup: { enabled: true, days: 7, expiresAt: 1, hub: { file: 'h.tar.gz', bytes: 3 }, machine: { machineName: 'box', path: '/p/m.tar.gz', bytes: 5, missing: [] } },
  };
  const v = purgeResultView(result);
  assert.equal(v.tone, 'ok');
  assert.equal(v.title, '清除完成');
  assert.deepEqual(v.deleted, ['3 個工作者對話（Hub 紀錄＋Kimi 紀錄與子代理）', '2 個 worktree（其中 1 個連同未提交的修改）', '2 個工作者分支', '合併分支 cluster/c/merged', '叢集記憶檔與資料夾', '叢集紀錄本身（已從總覽移除）']);
  assert.deepEqual(v.backup, { enabled: true, days: 7, expiresAt: 1, hub: { file: 'h.tar.gz', bytes: 3 }, machine: { name: 'box', path: '/p/m.tar.gz', bytes: 5, missing: [] } });
  assert.equal(purgeResultView({ ...result, kept: ['x'] }).title, '清除完成（有些東西依你的選擇保留了）');
  const partial = purgeResultView({ ...result, partial: true, removed: false, failed: ['a', 'b'] });
  assert.deepEqual([partial.tone, partial.title, partial.cluster], ['partial', '部分清除：有 2 項沒清掉', false]);
  assert.ok(!partial.deleted.includes('叢集紀錄本身（已從總覽移除）'), 'the record is not said to be gone while it stays');
  const aborted = purgeResultView({ aborted: true, reason: '備份沒有做成，所以什麼都沒有刪：x' });
  assert.deepEqual([aborted.tone, aborted.title, aborted.deleted, aborted.summary], ['aborted', '沒有清除：什麼都沒有刪', [], '備份沒有做成，所以什麼都沒有刪：x']);
  assert.equal(purgeResultView({ ...result, backup: { enabled: false } }).backup.enabled, false);
  assert.match(purgeResultView({ ...result, connectorNote: '太舊', workers: [{ conversation: 'archived', worktree: 'none', branch: 'none' }] }).deleted[0], /Kimi 紀錄只封存/);
  assert.equal(purgeResultView(null), null);
});

test('the name and the line under it: the name is the cluster\'s own; the main conversation is "主對話：…" (what the page knows now wins), or says it is gone, or says nothing when nobody knows', () => {
  assert.equal(clusterNameOf({ name: '  登入大改造 ', parentTitle: 'VPS框架開發' }), '登入大改造');
  assert.equal(clusterNameOf({ parentTitle: 'VPS框架開發' }), 'VPS框架開發', 'an older Hub: by its conversation, as before');
  assert.equal(clusterNameOf({ parentTitle: null }), '（未命名叢集）');
  assert.equal(clusterNameOf({ name: '' }, '現在的標題'), '現在的標題');
  assert.deepEqual(parentLine({ parentId: 's', parentTitle: 'A' }), { text: '主對話：A', title: 'A', gone: false });
  assert.equal(parentLine({ parentId: 's', parentTitle: 'A' }, '改過名的 B').text, '主對話：改過名的 B');
  assert.deepEqual(parentLine({ parentId: 's', parentTitle: null }), { text: '主對話已刪除', title: '', gone: true });
  assert.equal(parentLine({ parentId: 's', parentTitle: null }, 'still here').gone, false, 'the page still has it: it is not gone');
  assert.equal(parentLine({ parentId: 's' }).text, '主對話', 'an older Hub did not say');
  assert.equal(parentLine({}).text, '');
  assert.equal(autoClusterName([{ title: '一' }, { title: '二' }]), '一 等 2 條');
});

test('the row of a cluster carries its name, its main conversation (null = deleted), its steps and whether it is partly purged; and a running cluster cannot be picked for a batch', () => {
  const c = { id: 'c1', name: 'n', parentId: 's', parentTitle: null, steps: 5, stepsUnknown: 1, purge: { partial: true }, status: 'done', workers: [{ status: 'idle' }], tasks: [] };
  const row = summarizeCluster(c);
  assert.deepEqual([row.name, row.parentTitle, row.steps, row.stepsUnknown, row.purgePartial], ['n', null, 5, 1, true]);
  assert.equal('parentTitle' in summarizeCluster({ id: 'c' }), false, 'not said by an older Hub: not made up');
  assert.equal(summarizeCluster({ id: 'c', steps: -1 }).steps, null);
  assert.equal(isPurgeableRow({ status: 'done', workersRunning: 0 }), true);
  assert.equal(isPurgeableRow({ status: 'error', workersRunning: 0 }), true);
  assert.equal(isPurgeableRow({ status: 'stopped' }), true);
  for (const status of ['running', 'merging', 'starting', 'purging']) assert.equal(isPurgeableRow({ status, workersRunning: 0 }), false, status);
  assert.equal(isPurgeableRow({ status: 'done', workersRunning: 1 }), false);
  assert.equal(clusterStatusLabel('purging'), '清除中');
});

const G = (tps) => ({ tokensPerSecond: tps, unmeasured: tps === null ? '還沒量到' : null });
const run = (gen) => ({ status: 'running', gen: G(gen) });
const cl = (out, workers, status = 'running') => ({ status, throughput: { tokensPerSecond: out }, workers });

test('the share of time spent writing: Σ of the working workers\' speeds, X = Σ ÷ n, Y = output ÷ Σ - and nothing when any of it is not measured', () => {
  const v = genShareView(cl(63, [run(128), run(100)]));
  assert.deepEqual([v.shown, v.x, v.y], [true, '114', 28]);
  assert.equal(v.text, '工作者生成時約 114 tok/s，約有 28% 時間在生成，其餘在跑工具或等待');
  assert.equal(genShareView(cl(63, [run(128)])).y, 49, 'one worker: 63 ÷ 128');
  assert.equal(genShareView(cl(63, [run(128), { status: 'idle', gen: G(null) }])).y, 49, 'a worker that is not working is not in the sum');
  assert.equal(genShareView(cl(0.2, [run(128)])).y, 1, 'never "0%" while something was written');
  assert.equal(genShareView(cl(128, [run(128)])).y, 100);
  for (const [why, c] of [
    ['a working worker without a measured speed', cl(63, [run(128), run(null)])],
    ['no output measured', cl(null, [run(128)])],
    ['nothing working', cl(63, [{ status: 'idle', gen: G(null) }])],
    ['more output than the workers write', cl(300, [run(128)])],
    ['the cluster is over', cl(63, [run(128)], 'done')],
    ['no workers', cl(63, [])],
    ['output not a number', { status: 'running', throughput: {}, workers: [run(128)] }],
    ['a zero speed', cl(63, [run(0)])],
  ]) assert.equal(genShareView(c).shown, false, why);
  assert.equal(genShareView(null).shown, false);
});

test('the tile\'s two speeds: 生成 and 平均 where it writes, "—" where it does not, a dash after 平均 where the average is not measured', () => {
  const sp = (tps) => ({ tokensPerSecond: tps, requestsPerMinute: 1, windowMs: 300_000, unmeasured: tps === null ? '沒有請求紀錄' : null });
  assert.equal(tileSpeedView({ gen: G(128.4), speed: sp(63.2) }).text, '生成 128 · 平均 63');
  assert.equal(tileSpeedView({ gen: G(8.46), speed: sp(2.04) }).text, '生成 8.5 · 平均 2');
  assert.equal(tileSpeedView({ gen: G(41.9), speed: sp(null) }).text, '生成 42 · 平均 —');
  assert.deepEqual([tileSpeedView({ gen: G(null), speed: sp(5) }).text, tileSpeedView({ gen: G(null), speed: sp(5) }).measured], ['—', false]);
  assert.equal(tileSpeedView({}).text, '—');
  assert.match(tileSpeedView({ gen: G(null) }).title, /現在量不到/);
  assert.match(tileSpeedView({ gen: G(1), speed: sp(2) }).title, /生成 1 tok\/s.*平均 2 tok\/s/);
  assert.equal(stepsView(1).long, '共 1 步');
});
