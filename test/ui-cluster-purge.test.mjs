// 完全清除 on the screen, in a real browser against a scripted Hub (window.__fake,
// test/fixtures/cluster-fake.mjs): the button on the cluster page and what it says
// when it is not offered, the confirmation (what will be deleted, the three boxes
// with their counts - all off - and what each would change, the backup box, the
// note for a connector too old to delete), what the click sends, the result
// (what was deleted, what was kept and why, the backups with where and until
// when), the partly purged cluster that can be purged again, and the page of every
// cluster with its batch purge and the list of recent purges.
//
// What the Hub really does with the disk is test/cluster-purge.test.mjs, and the
// whole way from a click to the disk is test/e2e-cluster-purge-ui.test.mjs.
// CLUSTER_UI_SHOTS=<dir> also saves screenshots of every look.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skipReason, uiSession, CONTRAST_JS } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';
import { FAKE_SCRIPT, T0, W, CLUSTER, rowOf, GEN, NO_GEN, SPEED, THROUGHPUT, fakeHub } from './fixtures/cluster-fake.mjs';
import { purgePlanView, purgeResultView, decidePurgeWorker, purgeAvailability } from '../public/js/cluster-model.js';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
let ui;
let b;
let setFake;

before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
  await b.beforeLoad(FAKE_SCRIPT);
  setFake = fakeHub(b);
});
after(() => ui?.stop());

const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.trim() ?? null`);
const texts = (sel) => b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
const shot = async (name) => SHOTS && b.shot(path.join(SHOTS, `${name}.png`));
const emit = (msg) => b.eval(`window.__emit(${JSON.stringify(msg)})`);
async function open(hash, fake, { size = [1280, 860], theme = 'light' } = {}) {
  await setFake(fake);
  await b.size(size[0], size[1], size[0] < 700);
  await b.goto(ui.hub.url + '#/', 200);
  await b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
  await b.goto(ui.hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
}
const A = 'c_aaaaaaaaaaaa';
const B2 = 'c_bbbbbbbbbbbb';
const C3 = 'c_cccccccccccc';

// A finished cluster of three workers, the way a purge meets it.
const done = (id, patch = {}) =>
  CLUSTER({
    id,
    name: '修登入 等 3 條',
    parentTitle: 'Kimi chat with subagents',
    steps: 483,
    status: 'done',
    createdAt: T0 - 400_000,
    workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0 - 5000, taskIndex: null, gen: NO_GEN(), done: 1, worktree: `/home/user/proj-cluster-${id}/w${n}`, branch: `cluster/${id}/w${n}` })),
    tasks: [0, 1, 2].map((i) => ({ index: i, title: `任務 ${i + 1}`, status: 'done', workerSessionId: `s_w${i + 1}`, startedAt: T0 - 300_000, finishedAt: T0 - 5000, attempts: 1, error: null })),
    ...patch,
  });
const facts = (over = {}) => ({ hasWorktree: true, dir: true, registered: true, dirty: 0, statusError: '', tip: 'abc1234', mergedTip: 'def5678', safe: 'merged', unique: 0, checkedOutAt: [], ...over });
// w1 clean and merged; w2 clean with 2 commits nowhere else; w3 with 3 uncommitted files.
const PLAN = (id = A, over = {}) => ({
  dryRun: true,
  clusterId: id,
  name: '修登入 等 3 條',
  options: { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false },
  days: 7,
  connector: { name: 'box', canDeleteKimi: true, trashDir: '/home/user/.agent-hub/trash', note: null },
  workers: [
    { sessionId: 's_w1', n: 1, title: '工作者 1：改第 1 區', worktree: `/home/user/proj-cluster-${id}/w1`, branch: `cluster/${id}/w1`, exists: true, conversation: { hubNodes: 1, hubSubagentSessions: 0, kimiSessions: 1, kimiSubagents: 8 }, facts: facts() },
    { sessionId: 's_w2', n: 2, title: '工作者 2：改第 2 區', worktree: `/home/user/proj-cluster-${id}/w2`, branch: `cluster/${id}/w2`, exists: true, conversation: { hubNodes: 1, hubSubagentSessions: 0, kimiSessions: 1, kimiSubagents: 3 }, facts: facts({ safe: '', unique: 2 }) },
    { sessionId: 's_w3', n: 3, title: '工作者 3：改第 3 區', worktree: `/home/user/proj-cluster-${id}/w3`, branch: `cluster/${id}/w3`, exists: true, conversation: { hubNodes: 1, hubSubagentSessions: 0, kimiSessions: 1, kimiSubagents: 0 }, facts: facts({ dirty: 3 }) },
  ],
  merged: { branch: `cluster/${id}/merged`, exists: true, tip: 'fff0000' },
  memory: { path: `/home/user/proj/.git/agent-hub-cluster/${id}/memory.md`, dir: `/home/user/proj/.git/agent-hub-cluster/${id}`, exists: true, bytes: 900 },
  totals: { workers: 3, conversations: 3, kimiSessions: 3, kimiSubagents: 11, worktrees: 3, dirtyWorktrees: 1, branches: 3, unmergedBranches: 1 },
  ...over,
});
const RESULT = (id = A, over = {}) => ({
  dryRun: false,
  clusterId: id,
  name: '修登入 等 3 條',
  at: T0,
  options: { discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false },
  aborted: false,
  reason: '',
  backup: { enabled: true, days: 7, expiresAt: T0 + 7 * 24 * 3600 * 1000, hub: { file: `cluster-${id}-20261030-101010.tar.gz`, bytes: 12_345, conversations: 3 }, machine: { machineId: 'm1', machineName: 'box', path: `/home/user/.agent-hub/trash/cluster-${id}-20261030-101010.tar.gz`, bytes: 4_500_000, missing: [], items: 4 } },
  connectorNote: null,
  workers: [
    { sessionId: 's_w1', n: 1, title: 'w1', conversation: 'deleted', kimi: { deleted: 1, archived: 0, gone: 0, failed: 0 }, worktree: 'removed', branch: 'deleted', reasons: [] },
    { sessionId: 's_w2', n: 2, title: 'w2', conversation: 'deleted', kimi: { deleted: 1, archived: 0, gone: 0, failed: 0 }, worktree: 'removed', branch: 'kept', reasons: ['分支有 2 個 commit 沒合併進去（沒勾「也刪除沒合併進去的分支」，所以保留）'] },
    { sessionId: 's_w3', n: 3, title: 'w3', conversation: 'deleted', kimi: { deleted: 1, archived: 0, gone: 0, failed: 0 }, worktree: 'kept', branch: 'kept', reasons: [] },
  ],
  merged: { branch: `cluster/${id}/merged`, state: 'kept', reason: '沒勾「也刪除合併分支」，所以保留' },
  memory: { state: 'deleted', reason: '' },
  failed: [],
  kept: [`w2 的分支 cluster/${id}/w2：分支有 2 個 commit 沒合併進去（沒勾「也刪除沒合併進去的分支」，所以保留）`, `w3 的worktree /home/user/proj-cluster-${id}/w3：有 3 項未提交的修改或未追蹤的檔案（沒勾「也丟掉未提交的修改」，所以保留）`, `合併分支 cluster/${id}/merged：沒勾「也刪除合併分支」，所以保留`],
  removed: true,
  partial: false,
  ...over,
});
const fakeFor = (list, extra = {}) => ({ clusters: Object.fromEntries(list.map((c) => [c.id, c])), parents: { s_kimi: list }, list: list.map((c) => rowOf(c, 'Kimi chat with subagents')), timing: {}, memory: {}, purgePlans: Object.fromEntries(list.map((c) => [c.id, PLAN(c.id)])), ...extra });
const dialogText = () => b.eval(`document.querySelector('.dialog')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const purgeCalls = async () => (await ui.calls()).filter((c) => c.method === 'POST' && /\/purge$/.test(c.url));
const box = (key) => `.dialog input[data-box="${key}"]`;
const tick = (key) => b.click(box(key));
const summary = () => b.eval(`Object.fromEntries([...document.querySelectorAll('.dialog [data-field="purge-summary"] li')].map((l) => [l.dataset.item, l.innerText.trim()]))`);

// ------------------------------------------------------------- the button

test('the button: offered for a finished cluster, with the same refusal in words as the Hub\'s 409 for a running one; a partly purged one offers to purge again', () => {
  const finished = done(A);
  assert.equal(purgeAvailability(finished).ok, true);
  assert.match(purgeAvailability(finished).why, /整個清掉.*主對話不動.*備份.*7 天/);
  assert.deepEqual(purgeAvailability(CLUSTER({ status: 'running' })), { ok: false, why: '叢集還在跑，先全部停止' }, 'a running worker: the Hub\'s own words');
  assert.deepEqual(purgeAvailability({ ...finished, status: 'running', workers: finished.workers.map((w) => ({ ...w, status: 'idle' })) }).ok, false);
  assert.equal(purgeAvailability({ ...finished, status: 'merging' }).ok, false);
  assert.equal(purgeAvailability({ ...finished, status: 'purging' }).why, '正在完全清除');
  assert.equal(purgeAvailability(finished, true).ok, false);
  assert.match(purgeAvailability({ ...finished, purge: { partial: true, failed: ['x'] } }).why, /再按一次/);
});

test('the cluster page: 完全清除 is its own button beside 清理, off while the cluster runs (and says why), and a partly purged cluster is marked and offers to try again', { skip }, async () => {
  await open(`#/cluster/${A}`, fakeFor([done(A)]));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-head .cluster-actions .om-btn')].map((x) => x.getAttribute('aria-label'))`), ['全部停止', '合併工作者分支', '清理', '完全清除']);
  assert.equal(await b.eval(`document.querySelector('[data-action="purge"]').disabled`), false);
  assert.equal(await b.eval(`document.querySelector('[data-action="cleanup"] svg').outerHTML === document.querySelector('[data-action="purge"] svg').outerHTML`), false, 'not the same icon (on a phone the labels are gone)');
  // Running: off, with the reason.
  await open(`#/cluster/${A}`, fakeFor([CLUSTER({ id: A, name: 'x', parentTitle: 'p' })]));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  assert.equal(await b.eval(`document.querySelector('[data-action="purge"]').disabled`), true);
  assert.equal(await b.eval(`document.querySelector('[data-action="purge"]').title`), '叢集還在跑，先全部停止');
  // Partly purged.
  const partial = done(A, { purge: { at: T0, partial: true, failed: ['w2「乙」的對話：disk is busy'] } });
  await open(`#/cluster/${A}`, fakeFor([partial]));
  await b.waitFor(`document.querySelector('[data-field="purge-partial"]')`);
  assert.equal(await text('[data-field="purge-partial"]'), '部分清除');
  assert.match(await b.eval(`document.querySelector('[data-field="purge-partial"]').title`), /disk is busy/);
  assert.equal(await text('[data-action="purge"] .btn-label'), '再清除一次');
  assert.equal(await b.eval(`document.querySelector('[data-action="purge"]').disabled`), false);
  // Purging now (the page is told): everything is off, the badge says so.
  await emit({ t: 'cluster', cluster: { ...done(A), status: 'purging' } });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '清除中'`);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-head .cluster-actions .om-btn')].map((x) => x.disabled)`), [true, true, true, true]);
  assert.equal(await b.eval(`document.querySelector('[data-action="rename"]').disabled`), true, 'no rename while it is being taken away');
});

// ------------------------------------------------------------ the confirmation

test('the confirmation lists what will be deleted and kept, the three boxes are off and say how many things are behind each, and ticking one changes the list at once', { skip }, async () => {
  await open(`#/cluster/${A}`, fakeFor([done(A)]));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  await ui.clearCalls();
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  assert.equal((await ui.calls()).length, 0, 'asking what would happen sends nothing that changes');
  assert.match(await text('.cluster-purge-dialog .om-alert__title'), /^要完全清除「修登入 等 3 條」嗎？$/);
  assert.match(await text('.cluster-purge-dialog .cluster-cleanup-summary'), /主對話與其他對話完全不動.*不是收起，是刪除/);
  // What goes: counted from the plan, nothing ticked.
  let s = await summary();
  assert.equal(s.conversations, '3 個工作者對話：Hub 紀錄＋Kimi 紀錄 3 筆（含子代理 11 個）');
  assert.equal(s.worktrees, '2 個 worktree');
  assert.equal(s.branches, '1 個工作者分支');
  assert.equal(s.memory, '叢集記憶檔與資料夾');
  assert.equal(s.cluster, '叢集紀錄本身（從總覽移除）');
  assert.equal(s.kept, '保留 3 項（沒勾對應的選項，原因寫在下面）');
  // The three boxes: off, with the counts in their labels.
  assert.deepEqual(await b.eval(`['discardDirty','deleteUnmerged','deleteMerged','noBackup'].map((k) => document.querySelector('.dialog input[data-box="' + k + '"]').checked)`), [false, false, false, false]);
  assert.deepEqual(await texts('.cluster-purge-box .om-field__label'), ['也丟掉未提交的修改（有 1 個 worktree 有未提交修改）', '也刪除沒合併進去的分支（有 1 個）', '也刪除合併分支 cluster/c_aaaaaaaaaaaa/merged', '不留備份（立即永久刪除）']);
  // Per worker: what goes, what stays and why.
  const rows = await b.eval(`[...document.querySelectorAll('.cluster-purge-list > li')].map((l) => ({ keeps: l.dataset.keeps, text: l.innerText.replace(/\\s+/g, ' ').trim() }))`);
  assert.deepEqual(rows.map((r) => r.keeps), ['false', 'true', 'true']);
  assert.match(rows[0].text, /會刪：對話（Hub 紀錄＋Kimi 紀錄，含子代理 8 個）、移除 worktree、刪除分支/);
  assert.match(rows[1].text, /會刪：對話.*移除 worktree/);
  assert.match(rows[1].text, /分支有 2 個 commit 沒合併進去（沒勾「也刪除沒合併進去的分支」，所以保留）/);
  assert.match(rows[2].text, /有 3 項未提交的修改或未追蹤的檔案（沒勾「也丟掉未提交的修改」，所以保留）/);
  assert.match(rows[2].text, /分支還被保留下來的 worktree 使用中/);
  assert.match(await text('[data-field="merged-line"]'), /合併分支 cluster\/c_aaaaaaaaaaaa\/merged：保留（沒勾「也刪除合併分支」，所以保留）/);
  assert.match(await text('[data-field="backup-note"]'), /刪之前先備份.*\/home\/user\/\.agent-hub\/trash\/cluster-…tar\.gz.*data\/trash\/.*7 天後自動刪除.*備份失敗就一樣都不刪/);
  await shot('purge-confirm-1280-light');

  // Tick "also throw away uncommitted changes": the dirty worktree and its branch go into the list.
  await tick('discardDirty');
  s = await summary();
  assert.equal(s.worktrees, '3 個 worktree（其中 1 個連同未提交的修改）');
  assert.equal(s.branches, '2 個工作者分支');
  assert.equal(s.kept, '保留 2 項（沒勾對應的選項，原因寫在下面）');
  // Tick "also delete unmerged branches".
  await tick('deleteUnmerged');
  s = await summary();
  assert.equal(s.branches, '3 個工作者分支');
  assert.equal(s.kept, '保留 1 項（沒勾對應的選項，原因寫在下面）');
  // Tick "also delete the merged branch": nothing is kept any more.
  await tick('deleteMerged');
  s = await summary();
  assert.equal(s.kept, undefined, 'no "保留" line when nothing is kept');
  assert.match(await text('[data-field="merged-line"]'), /會刪除/);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-purge-list > li[data-keeps="true"]').length`), 0);
  await shot('purge-confirm-all-ticked-1280-light');
  // And back: unticking puts them back.
  await tick('deleteMerged');
  await tick('deleteUnmerged');
  await tick('discardDirty');
  assert.equal((await summary()).kept, '保留 3 項（沒勾對應的選項，原因寫在下面）');
  // The backup box warns.
  await tick('noBackup');
  assert.match(await text('[data-field="backup-note"]'), /^不留備份：刪掉就是刪掉了，救不回來。$/);
  assert.equal(await b.eval(`document.querySelector('[data-field="backup-note"]').classList.contains('danger')`), true);
  await shot('purge-confirm-nobackup-1280-light');
  // Cancel: nothing was sent.
  await b.eval(`document.querySelector('.cluster-purge-dialog .dialog-actions .om-btn').click()`);
  await b.waitFor(`!document.querySelector('.cluster-purge-dialog')`);
  assert.equal((await purgeCalls()).length, 0);
});

test('a box with nothing behind it is off and says so; the connector too old to delete is told in the dialog', { skip }, async () => {
  const plan = PLAN(A, { connector: { name: 'box', canDeleteKimi: false, trashDir: '/home/user/.agent-hub/trash', note: '這台電腦的連接器太舊，Kimi 紀錄只能封存、不能刪除；重新執行連接指令更新後才能完全刪除' }, merged: { branch: `cluster/${A}/merged`, exists: false, tip: '' } });
  plan.workers = plan.workers.map((w) => ({ ...w, facts: facts() }));
  await open(`#/cluster/${A}`, fakeFor([done(A)], { purgePlans: { [A]: plan } }));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  assert.deepEqual(await b.eval(`['discardDirty','deleteUnmerged','deleteMerged'].map((k) => document.querySelector('.dialog input[data-box="' + k + '"]').disabled)`), [true, true, true]);
  assert.match(await text('[data-boxrow="discardDirty"]'), /沒有 worktree 有未提交的修改/);
  assert.match(await text('[data-boxrow="deleteUnmerged"]'), /沒有分支帶著沒合併的 commit/);
  assert.match(await text('[data-boxrow="deleteMerged"]'), /這個叢集沒有合併過，沒有合併分支/);
  assert.match(await text('.cluster-purge-warns'), /連接器太舊，Kimi 紀錄只能封存、不能刪除；重新執行連接指令更新後才能完全刪除/);
  assert.match((await summary()).conversations, /Kimi 紀錄 3 筆.*只能封存、不能刪除/);
  await shot('purge-confirm-old-connector-1280-light');
});

test('the Hub\'s refusal of the dry run (409: still running) is said on the page and no dialog opens', { skip }, async () => {
  await open(`#/cluster/${A}`, fakeFor([done(A)], { purgePlans: { [A]: { __error: { status: 409, message: '叢集還在跑，先全部停止' } } } }));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')`);
  assert.equal(await text('.cluster-head .cluster-error'), '叢集還在跑，先全部停止');
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-purge-dialog'))`), false);
});

// ----------------------------------------------------------------- the result

async function purgeFromPage(id, answer, boxes = [], look = {}) {
  await open(`#/cluster/${id}`, fakeFor([done(id)]), look);
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  await ui.clearCalls();
  await ui.answer('POST', `/api/clusters/${id}/purge`, 200, answer);
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  for (const k of boxes) await tick(k);
  await b.click('[data-action="purge-confirm"]');
  await b.waitFor(`document.querySelector('[data-view="purge-result"]')`);
}

test('what the click sends: exactly the boxes that were ticked; and when the cluster is gone the page is its result - what was deleted, what was kept and why, the backups with where and until when - and the way back', { skip }, async () => {
  await purgeFromPage(A, RESULT(A, { options: { discardDirty: true, deleteUnmerged: false, deleteMerged: false, noBackup: false } }), ['discardDirty']);
  const [post] = await purgeCalls();
  assert.deepEqual(post.body, { discardDirty: true, deleteUnmerged: false, deleteMerged: false, noBackup: false });
  assert.equal(post.url, `/api/clusters/${A}/purge`);
  assert.equal(await b.eval(`document.querySelector('[data-view="purge-result"]').dataset.tone`), 'ok');
  assert.match(await text('[data-field="purge-title"]'), /^清除完成（有些東西依你的選擇保留了）$/);
  const lines = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-purge-section')].map((s) => [s.classList.contains('backup') ? 'backup' : s.classList[1], [...s.querySelectorAll('li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())]))`);
  assert.deepEqual(lines.deleted, ['3 個工作者對話（Hub 紀錄＋Kimi 紀錄與子代理）', '2 個 worktree', '1 個工作者分支', '叢集記憶檔與資料夾', '叢集紀錄本身（已從總覽移除）']);
  assert.equal(lines.kept.length, 3);
  assert.match(lines.kept[0], /w2 的分支.*沒勾「也刪除沒合併進去的分支」，所以保留/);
  assert.match(lines.kept[2], /合併分支.*沒勾「也刪除合併分支」/);
  assert.equal(lines.failed, undefined);
  assert.match(lines.backup[0], /box：\/home\/user\/\.agent-hub\/trash\/cluster-c_aaaaaaaaaaaa-20261030-101010\.tar\.gz \(4\.5 MB\)/);
  assert.match(lines.backup[1], /Hub：data\/trash\/cluster-c_aaaaaaaaaaaa-20261030-101010\.tar\.gz \(12\.3 KB\)/);
  assert.match(await text('.cluster-purge-section.backup .cluster-cleanup-kept-title'), /^備份（7 天後自動刪除，\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}）$/);
  // The cluster is gone: the page is only this result, with the way back; it is out of the list and the counts.
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-worker'))`), false);
  assert.equal(await b.eval(`document.querySelector('[data-action="back-to-list"]').getAttribute('href')`), '#/clusters');
  await shot('purge-result-1280-light');
  await b.click('[data-action="back-to-list"]');
  await b.waitFor(`location.hash === '#/clusters'`);
});

test('a purge that kept something it could not delete: the result says so in red with the reasons, the cluster stays under it marked 部分清除, and the result can be dismissed', { skip }, async () => {
  const partial = RESULT(A, { partial: true, removed: false, failed: ['w2「乙」的對話：Kimi 對話 session_x 沒有刪掉：disk is busy'], workers: RESULT(A).workers.map((w, i) => (i === 1 ? { ...w, conversation: 'kept', reasons: ['Kimi 對話 session_x 沒有刪掉：disk is busy'] } : w)) });
  await setFake(fakeFor([done(A)]));
  await open(`#/cluster/${A}`, fakeFor([done(A)]));
  await b.waitFor(`document.querySelector('[data-action="purge"]')`);
  await ui.answer('POST', `/api/clusters/${A}/purge`, 200, partial);
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  await b.click('[data-action="purge-confirm"]');
  await b.waitFor(`document.querySelector('[data-view="purge-result"]')`);
  assert.equal(await b.eval(`document.querySelector('[data-view="purge-result"]').dataset.tone`), 'partial');
  assert.equal(await text('[data-field="purge-title"]'), '部分清除：有 1 項沒清掉');
  assert.match(await text('[data-field="purge-summary-line"]'), /叢集還在總覽裡，標著「部分清除」；排除問題後再按一次/);
  assert.match(await text('.cluster-purge-section.failed'), /沒清掉的（原因）.*disk is busy/s);
  // The cluster is still there under it, and its buttons work.
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 3);
  assert.equal(await b.eval(`document.querySelector('[data-action="purge"]').disabled`), false);
  await shot('purge-result-partial-1280-light');
  await b.click('[data-action="dismiss-result"]');
  await b.waitFor(`!document.querySelector('[data-view="purge-result"]')`);
});

test('a backup that could not be made: "沒有清除：什麼都沒有刪", the reason, and the cluster is where it was', { skip }, async () => {
  const aborted = { dryRun: false, clusterId: A, name: 'x', options: {}, aborted: true, reason: '備份沒有做成，所以什麼都沒有刪：沒有空間了', backup: { enabled: true, error: '沒有空間了' }, workers: [], failed: [], kept: [], removed: false, partial: false };
  await purgeFromPage(A, aborted);
  assert.equal(await b.eval(`document.querySelector('[data-view="purge-result"]').dataset.tone`), 'aborted');
  assert.equal(await text('[data-field="purge-title"]'), '沒有清除：什麼都沒有刪');
  assert.match(await text('[data-field="purge-summary-line"]'), /備份沒有做成，所以什麼都沒有刪：沒有空間了/);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 3);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-purge-section'))`), false, 'no list of deletions: nothing was deleted');
  await shot('purge-result-aborted-1280-light');
});

test('a cluster purged from somewhere else (the socket says cluster.removed): its page says it is gone and leads back; the list and the sidebar count forget it', { skip }, async () => {
  await open(`#/cluster/${A}`, fakeFor([done(A), done(B2, { name: '另一個' })]));
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3`);
  await emit({ t: 'cluster.removed', id: A });
  await b.waitFor(`document.querySelector('.cluster-none')`);
  assert.match(await text('.cluster-none'), /這個叢集已被清除.*備份保留 7 天/s);
  assert.equal(await b.eval(`document.querySelector('.cluster-none [data-action="back-to-list"]').getAttribute('href')`), '#/clusters');
  await b.goto(ui.hub.url + '#/clusters', 200);
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 2`);
  await emit({ t: 'cluster.removed', id: A });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 1`);
  assert.equal(await b.eval(`document.querySelector('.cluster-card').dataset.cluster`), B2);
});

// ------------------------------------------------------------------ every cluster

const finishedRow = (id, name, over = {}) => done(id, { name, ...over });
const listFake = () => {
  const list = [finishedRow(A, '修登入 等 3 條'), finishedRow(B2, '補測試'), CLUSTER({ id: C3, name: '還在跑的', parentTitle: 'Kimi chat with subagents', status: 'running' })];
  return fakeFor(list, {
    trash: { days: 7, items: [{ id: 'c_dddddddddddd-20261029-101010', clusterId: 'c_dddddddddddd', name: '昨天清掉的', purgedAt: T0 - 86_400_000, expiresAt: T0 + 6 * 86_400_000, partial: false, hub: { file: 'cluster-c_dddddddddddd-20261029-101010.tar.gz', bytes: 4000, removed: false }, machine: { machineId: 'm1', machineName: 'box', path: '/home/user/.agent-hub/trash/cluster-c_dddddddddddd-20261029-101010.tar.gz', bytes: 9_000_000, removed: false }, kept: ['w3 的 worktree /home/user/x-cluster-c_dddddddddddd/w3：有 1 項未提交的修改'] }] },
  });
};

test('the page of every cluster: pick several finished ones (a running one cannot be picked), one confirmation for all with the totals, one result for each', { skip }, async () => {
  await open('#/clusters', listFake());
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  assert.equal(await b.eval(`document.querySelector('[data-action="pick-start"]').disabled`), false);
  await b.click('[data-action="pick-start"]');
  await b.waitFor(`document.querySelector('[data-action="batch-purge"]')`);
  assert.equal(await text('[data-field="picked"]'), '點卡片選取要清除的叢集（只有已結束的可以選）');
  assert.equal(await b.eval(`document.querySelector('[data-action="batch-purge"]').disabled`), true, 'nothing picked yet');
  const cls = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-card')].map((c) => [c.dataset.cluster, [c.classList.contains('pickable'), c.classList.contains('unpickable'), c.querySelector('[data-field="select"]').hidden]]))`);
  assert.deepEqual(cls, { [A]: [true, false, false], [B2]: [true, false, false], [C3]: [false, true, false] });
  // A press on a card chooses it (it does not open it); a running one does nothing.
  await b.click(`.cluster-card[data-cluster="${C3}"]`);
  assert.equal(await b.eval(`location.hash`), '#/clusters');
  assert.equal(await text('[data-field="picked"]'), '點卡片選取要清除的叢集（只有已結束的可以選）');
  await b.click(`.cluster-card[data-cluster="${A}"]`);
  assert.equal(await b.eval(`location.hash`), '#/clusters', 'picking, not opening');
  assert.equal(await text('[data-field="picked"]'), '已選 1 個叢集');
  assert.equal(await b.eval(`document.querySelector('.cluster-card[data-cluster="${A}"] [data-field="select"]').getAttribute('aria-checked')`), 'true');
  await shot('purge-batch-pick-1280-light');
  // All of the finished ones in one press.
  await b.click('[data-action="pick-all"]');
  assert.equal(await text('[data-field="picked"]'), '已選 2 個叢集');
  assert.match(await text('[data-action="pick-all"]'), /全選已結束的（2）/);
  await ui.clearCalls();
  await b.click('[data-action="batch-purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  assert.equal(await text('.cluster-purge-dialog .om-alert__title'), '要完全清除這 2 個叢集嗎？');
  // Totals over both: 3+3 conversations, 2+2 worktrees, 1+1 branches, 2 cluster records; the boxes count over both.
  const s = await summary();
  assert.match(s.conversations, /^6 個工作者對話：Hub 紀錄＋Kimi 紀錄 6 筆（含子代理 22 個）$/);
  assert.equal(s.worktrees, '4 個 worktree');
  assert.equal(s.branches, '2 個工作者分支');
  assert.equal(s.cluster, '2 個叢集紀錄本身（從總覽移除）');
  assert.deepEqual(await texts('.cluster-purge-box .om-field__label'), ['也丟掉未提交的修改（有 2 個 worktree 有未提交修改）', '也刪除沒合併進去的分支（有 2 個）', '也刪除合併分支（2 個叢集有）', '不留備份（立即永久刪除）']);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-purge-cluster')].map((d) => [d.dataset.cluster, d.open])`), [[A, false], [B2, false]], 'folded: one section per cluster');
  await shot('purge-batch-confirm-1280-light');
  await tick('discardDirty');
  await ui.answer('POST', `/api/clusters/${A}/purge`, 200, RESULT(A, { options: { discardDirty: true, deleteUnmerged: false, deleteMerged: false, noBackup: false } }));
  await ui.answer('POST', `/api/clusters/${B2}/purge`, 409, { error: '叢集還在跑，先全部停止' });
  await b.click('[data-action="purge-confirm"]');
  await b.waitFor(`document.querySelector('.cluster-purge-batch')`);
  const posts = await purgeCalls();
  assert.deepEqual(posts.map((p) => p.url), [`/api/clusters/${A}/purge`, `/api/clusters/${B2}/purge`], 'one after the other, in the order picked');
  for (const p of posts) assert.deepEqual(p.body, { discardDirty: true, deleteUnmerged: false, deleteMerged: false, noBackup: false }, 'the same boxes for each');
  const results = await b.eval(`[...document.querySelectorAll('.cluster-purge-batch [data-view="purge-result"]')].map((r) => [r.dataset.tone, r.querySelector('.cluster-section-title .muted').innerText, r.innerText.includes('叢集還在跑，先全部停止')])`);
  assert.deepEqual(results, [['ok', '修登入 等 3 條', false], ['aborted', '補測試', true]], 'each cluster has its own result, a refused one says why');
  await shot('purge-batch-result-1280-light');
  await b.click('[data-action="close-result"]');
  await b.waitFor(`!document.querySelector('.cluster-purge-batch')`);
});

test('the list of recent purges: each with when, until when its backup is kept, the file on the computer and the Hub\'s, and what was left in place', { skip }, async () => {
  await open('#/clusters', listFake());
  await b.waitFor(`document.querySelector('[data-view="purged-list"]')`);
  assert.match(await text('[data-view="purged-list"] summary'), /最近清除的叢集.*1 筆 · 備份保留 7 天/s);
  await b.eval(`document.querySelector('[data-view="purged-list"]').open = true`);
  const item = await text('[data-purged="c_dddddddddddd"]');
  assert.match(item, /昨天清掉的/);
  assert.match(item, /清除於 \d{4}-\d{2}-\d{2}.*備份到 \d{4}-\d{2}-\d{2}/);
  assert.match(item, /box：\/home\/user\/\.agent-hub\/trash\/cluster-c_dddddddddddd-20261029-101010\.tar\.gz/);
  assert.match(item, /Hub：data\/trash\/cluster-c_dddddddddddd-20261029-101010\.tar\.gz/);
  assert.match(item, /w3 的 worktree.*有 1 項未提交的修改/);
  await shot('purge-recent-1280-light');
  // None purged: no section at all.
  await open('#/clusters', { ...listFake(), trash: { days: 7, items: [] } });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  assert.equal(await b.eval(`Boolean(document.querySelector('[data-view="purged-list"]'))`), false);
});

test('the batch bar is off when nothing can be picked, and cancelling leaves the cards as they were', { skip }, async () => {
  await open('#/clusters', fakeFor([CLUSTER({ id: C3, name: '還在跑的', parentTitle: 'p', status: 'running' })]));
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 1`);
  assert.equal(await b.eval(`document.querySelector('[data-action="pick-start"]').disabled`), true);
  assert.equal(await b.eval(`document.querySelector('[data-action="pick-start"]').title`), '沒有已結束的叢集可以清除');
  await open('#/clusters', listFake());
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  await b.click('[data-action="pick-start"]');
  await b.click(`.cluster-card[data-cluster="${A}"]`);
  await b.click('[data-action="pick-cancel"]');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-card.picking, .cluster-card.picked').length`), 0);
  assert.equal(await b.eval(`document.querySelector('.cluster-card[data-cluster="${A}"]').getAttribute('href')`), `#/cluster/${A}`);
  assert.equal(await b.eval(`document.querySelector('[data-field="select"]').hidden`), true);
});

// ------------------------------------------------------------ phone and dark

test('on a phone and in the dark look the confirmation, the result, the batch bar and the list of recent purges are readable, fit the screen, and the buttons are reachable', { skip }, async () => {
  for (const [theme, size, label] of [['light', [390, 844], '390-light'], ['dark', [390, 844], '390-dark'], ['dark', [1280, 860], '1280-dark']]) {
    // The confirmation.
    await open(`#/cluster/${A}`, fakeFor([done(A)]), { size, theme });
    await b.waitFor(`document.querySelector('[data-action="purge"]')`);
    await b.click('[data-action="purge"]');
    await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
    await b.sleep(400);
    const dlg = await b.eval(`(() => { const d = document.querySelector('.dialog'); const r = d.getBoundingClientRect(); const act = document.querySelector('.cluster-purge-dialog .dialog-actions'); d.scrollTop = d.scrollHeight; const a = act.getBoundingClientRect(); const confirm = document.querySelector('[data-action="purge-confirm"]').getBoundingClientRect(); return { fits: r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, over: d.scrollWidth - d.clientWidth, confirmVisible: confirm.bottom <= innerHeight + 1 && confirm.top >= 0 && confirm.right <= innerWidth + 1 }; })()`);
    assert.equal(dlg.fits, true, `${label}: the dialog fits the screen`);
    assert.ok(dlg.over <= 1, `${label}: the dialog does not scroll sideways (${dlg.over})`);
    assert.equal(dlg.confirmVisible, true, `${label}: the confirm button can be reached`);
    const ratios = await b.eval(`(() => { const contrast = ${CONTRAST_JS}; return ['.cluster-purge-dialog .om-alert__title', '.cluster-purge-summary li', '.cluster-purge-box .om-field__label', '.cluster-purge-box .om-field__help', '[data-field="backup-note"]', '.cluster-purge-list .om-field__help'].map((s) => { const e = document.querySelector(s); return e ? [s, contrast(e).ratio] : [s, null]; }); })()`);
    for (const [sel, ratio] of ratios) assert.ok(ratio === null || ratio >= 4.5, `${label}: ${sel} contrast ${ratio}`);
    await shot(`purge-confirm-${label}`);
    await b.eval(`document.querySelector('.cluster-purge-dialog .dialog-actions .om-btn').click()`);
    // The result.
    await purgeFromPage(A, RESULT(A, { partial: true, removed: false, failed: ['w2 的分支 x：一個很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長的原因 /home/user/a/very/long/path/that/does/not/break/anything/at/all'] }), [], { size, theme });
    const over = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over.map((x) => x <= 1), [true, true], `${label}: the result does not scroll sideways ${over}`);
    const ratios2 = await b.eval(`(() => { const contrast = ${CONTRAST_JS}; return ['[data-field="purge-title"]', '.cluster-purge-section.deleted li', '.cluster-purge-section.kept li', '.cluster-purge-section.failed li', '.cluster-purge-section.backup code'].map((s) => { const e = document.querySelector(s); return e ? [s, contrast(e).ratio] : [s, null]; }); })()`);
    for (const [sel, ratio] of ratios2) assert.ok(ratio === null || ratio >= 4.5, `${label}: result ${sel} contrast ${ratio}`);
    await shot(`purge-result-${label}`);
    // The page of every cluster in picking mode, and the recent list.
    await open('#/clusters', listFake(), { size, theme });
    await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
    await b.click('[data-action="pick-start"]');
    await b.click(`.cluster-card[data-cluster="${A}"]`);
    await b.eval(`document.querySelector('[data-view="purged-list"]').open = true`);
    const over2 = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over2.map((x) => x <= 1), [true, true], `${label}: the list does not scroll sideways ${over2}`);
    const ratios3 = await b.eval(`(() => { const contrast = ${CONTRAST_JS}; return ['.cl-bar-count', '.cluster-purged [data-purged] .om-field__help', '.cluster-purged .cluster-merge-name', '.cc-check.on'].map((s) => { const e = document.querySelector(s); return e ? [s, contrast(e).ratio] : [s, null]; }); })()`);
    for (const [sel, ratio] of ratios3) assert.ok(ratio === null || ratio >= 3, `${label}: ${sel} contrast ${ratio}`);
    await shot(`purge-batch-list-${label}`);
  }
  void purgePlanView; void purgeResultView; void decidePurgeWorker; void GEN; void SPEED; void THROUGHPUT;
});
