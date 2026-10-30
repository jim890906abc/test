// 叢集 (cluster) clean-up from the screen to the disk, with NOTHING between
// them faked: a real Hub serving the real page, a real Chromium driven only by
// clicks, a computer whose shell really runs bash (so the worktrees, branches,
// commits, merges and their removal below are real git in real folders) and a
// Kimi that is played by the fake machine. The page's own requests are NOT
// intercepted: what the cluster page and the sidebar show is what the Hub said,
// and what a button sends is what the Hub got.
//
// The person's question was: "after I merge, those branches should go away by
// themselves - otherwise they take disk and rows in the sidebar".
//
// Skips, saying why, when there is no Chromium. CLUSTER_UI_SHOTS=<dir> also
// saves screenshots of the real flow to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipReason, launchBrowser } from './browser-harness.mjs';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
const MID = 'm_fake';
let hub;
let b;
let KIMI;
let page;
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
const commit = (w, file, text) => {
  fs.writeFileSync(path.join(w.worktree, file), text);
  git(w.worktree, 'add', '-A');
  git(w.worktree, 'commit', '-q', '-m', `edit ${file}`);
};
const snap = (id) => hub.api('GET', `/sessions/${id}`);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const worktrees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
const branches = (repo) => git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)').split('\n').filter(Boolean);
// Dispatch a cluster of `titles` from `parent` through the screen; returns the cluster as the Hub has it.
const dispatch = (parent, titles) => page.dispatch(parent, titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` })));
const shot = async (name) => {
  if (!SHOTS) return;
  await b.sleep(450);
  await b.shot(path.join(SHOTS, name));
};
// A cluster's workers are not rows of the sidebar's list (one line counts them); a worker "has a row" when a search for its name finds it - and a worker the clean-up took off the sidebar is not found.
const typeSearch = (text) => b.eval(`(() => { const i = document.querySelector('.side-search input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
const rowOf = (sid) => `[...document.querySelectorAll('.sidebar .side-row')].some((r) => r.getAttribute('href') === '#/s/${sid}')`;
const sidebarHas = async (sid) => {
  await typeSearch((await hub.api('GET', `/sessions/${sid}`)).title);
  await b.sleep(150);
  const has = await b.eval(rowOf(sid));
  await typeSearch('');
  return has;
};
// What the clean-up did to each worker is in its drawer: open it, read it, close it.
const cards = async () => {
  const sids = await b.eval(`[...document.querySelectorAll('.cluster-worker')].map((c) => c.dataset.session)`);
  const out = [];
  for (const sid of sids) {
    await page.openDrawer(sid);
    out.push(await b.eval(`(() => { const c = document.querySelector('.cluster-drawer'); return { session: '${sid}', worktree: c.querySelector('[data-field="cleanup-worktree"]')?.innerText.trim() ?? null, branch: c.querySelector('[data-field="cleanup-branch"]')?.innerText.trim() ?? null, hidden: c.querySelector('[data-field="cleanup-hidden"]')?.innerText.trim() ?? null, reasons: [...c.querySelectorAll('.cluster-cleanup-reasons li')].map((l) => l.innerText.trim()) }; })()`));
    await page.closeDrawer();
  }
  return out;
};

before(async () => {
  if (skip) return;
  hub = await startRealHub('cluster-cleanup-ui', { claude: true });
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const k = groups.find((g) => g.provider === 'kimi').models[0];
  KIMI = { model: k.id, effort: k.efforts[0] };
  b = await launchBrowser({ width: 1280, height: 900 });
  page = clusterPage({ b, base: `http://127.0.0.1:${hub.PORT}/`, cluster: getCluster });
});
after(async () => {
  await b?.close();
  await hub?.stop();
});

const S = {};

test('merging from the page cleans up by itself: the worktrees and branches that were merged go, the one with something uncommitted stays and says why, the sidebar loses the rows that are done, and nothing of the work is lost', { skip }, async () => {
  S.repo = makeRepo('proj');
  S.parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: S.repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  const c = await dispatch(S.parent, ['改甲', '改乙', '改丙']);
  S.c = c;
  await until(async () => (await getCluster(c.id)).status === 'done', 15000, 'done');
  const [w1, w2, w3] = c.workers;
  commit(w1, 'one.txt', 'from w1\n');
  commit(w2, 'two.txt', 'from w2\n');
  fs.writeFileSync(path.join(w2.worktree, 'scratch.txt'), 'a note the worker did not commit\n');
  // w3 did nothing (a read-only worker).
  for (const w of c.workers) assert.equal(await sidebarHas(w.sessionId), true, 'the premise: every worker has a row');
  assert.equal(worktrees(S.repo).length, 4);

  await page.open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelector('[data-action="merge"]') && !document.querySelector('[data-action="merge"]').disabled`);
  assert.equal(await b.eval(`document.querySelector('.cluster-cleanup')`), null, 'nothing was cleaned up yet');
  await shot('c0-before-merge-1280-light.png');
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  const asked = await b.eval(`document.querySelector('.dialog').innerText`);
  assert.match(asked, /全部.*合併成功.*自動清理/, 'the person is told before pressing');
  await shot('c1-merge-confirm-1280-light.png');
  await page.confirm();
  await b.waitFor(`document.querySelector('.cluster-cleanup')`, { timeout: 20000 });

  // The disk: w1 and w3 are gone (their work is in the merged branch), w2 is whole.
  assert.deepEqual(worktrees(S.repo).sort(), [fs.realpathSync(S.repo), w2.worktree].sort());
  assert.deepEqual(branches(S.repo).sort(), [`cluster/${c.id}/merged`, w2.branch].sort());
  assert.equal(git(S.repo, 'show', `cluster/${c.id}/merged:one.txt`), 'from w1');
  assert.equal(git(S.repo, 'show', `cluster/${c.id}/merged:two.txt`), 'from w2');
  assert.equal(fs.readFileSync(path.join(w2.worktree, 'scratch.txt'), 'utf8'), 'a note the worker did not commit\n', 'the uncommitted file is where it was');
  assert.equal(git(S.repo, 'status', '--porcelain'), '', 'the main folder was not touched');

  // The page: the summary, who was kept and why, each card.
  const sec = await b.eval(`document.querySelector('.cluster-cleanup').innerText.replace(/\\s+/g, ' ')`);
  assert.match(sec, /合併全部成功後自動執行/);
  assert.match(sec, /2 個 worktree 已移除 · 2 個分支已刪除 · 2 個對話已從側欄收起 · 1 個工作者有東西保留/);
  assert.ok(sec.includes(w2.worktree) && sec.includes('1 項未提交的修改或未追蹤的檔案'), 'the kept worktree: its path and why');
  assert.deepEqual(await cards(), [
    { session: w1.sessionId, worktree: 'worktree 已移除', branch: '分支已刪除', hidden: '已從側欄收起', reasons: [] },
    { session: w2.sessionId, worktree: 'worktree 保留', branch: '分支保留', hidden: '在側欄', reasons: ['有 1 項未提交的修改或未追蹤的檔案', '分支還被 worktree 使用中'] },
    { session: w3.sessionId, worktree: 'worktree 已移除', branch: '分支已刪除', hidden: '已從側欄收起', reasons: [] },
  ]);
  await b.eval(`document.querySelector('.cluster-cleanup').scrollIntoView()`);
  await shot('c2-auto-cleanup-result-1280-light.png');
  await b.eval(`document.querySelector('.cluster-page').scrollTop = 0`);
  await shot('c2b-auto-cleanup-top-1280-light.png');

  // The sidebar: the finished workers' rows are gone, the one with something left stays; the conversations are not deleted.
  await b.waitFor(`!${await sidebarHasExpr(w1.sessionId)}`);
  assert.equal(await sidebarHas(w1.sessionId), false);
  assert.equal(await sidebarHas(w3.sessionId), false);
  assert.equal(await sidebarHas(w2.sessionId), true);
  assert.equal(await sidebarHas(S.parent.id), true, 'the main conversation is untouched');
  for (const w of c.workers) assert.equal((await snap(w.sessionId)).id, w.sessionId, 'every conversation still exists');
  await shot('c3-sidebar-after-cleanup-1280-light.png');

  // The Hub's own record, and the main conversation was told.
  const api = await getCluster(c.id);
  assert.equal(api.cleanup.auto, true);
  assert.deepEqual(api.cleanup.results.map((r) => [r.worktree, r.branch, r.hidden]), [['removed', 'deleted', true], ['kept', 'kept', false], ['removed', 'deleted', true]]);
  const info = (await snap(S.parent.id)).events.filter((e) => e.type === 'info' && e.text.includes('已清理')).at(-1);
  assert.ok(info && info.text.includes(c.id) && info.text.includes('w2'), 'the main conversation says what was cleaned and what was kept');
});

test('放回側欄 on a card brings that conversation back into the sidebar, and it opens from the card even while it is hidden', { skip }, async () => {
  const [w1, , w3] = S.c.workers;
  await page.open(`#/cluster/${S.c.id}`);
  await page.openDrawer(w1.sessionId);
  await b.waitFor(`document.querySelector('.cluster-drawer [data-action="unhide"]')`);
  await page.closeDrawer();
  assert.equal(await sidebarHas(w1.sessionId), false);

  // Opened from its drawer: the worker's page says it was tucked away.
  await page.openDrawer(w3.sessionId);
  await b.click('.cluster-drawer [data-action="open-worker"]');
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  assert.match(await b.eval(`document.querySelector('.cluster-worker-note').innerText`), /已從側欄收起/);
  assert.equal(await sidebarHas(w3.sessionId), false, 'opened, and still not listed');
  await b.eval('history.back()');
  await b.waitFor(`document.querySelector('.cluster-worker')`);

  await page.openDrawer(w1.sessionId);
  await b.click('.cluster-drawer [data-action="unhide"]');
  await b.waitFor(`document.querySelector('.cluster-drawer [data-field="cleanup-hidden"]').innerText.trim() === '在側欄'`);
  await page.closeDrawer();
  await b.waitFor(await sidebarHasExpr(w1.sessionId));
  assert.equal(await sidebarHas(w1.sessionId), true, 'the row is back');
  assert.equal(await sidebarHas(w3.sessionId), false, 'only that one');
  assert.equal((await snap(w1.sessionId)).clusterHidden, false);
  assert.equal((await getCluster(S.c.id)).workers[0].hidden, false);
  assert.match(await b.eval(`document.querySelector('.cluster-cleanup').innerText`), /1 個對話已從側欄收起/);
  await shot('c4-after-unhide-1280-light.png');
});

test('清理 by hand: the confirmation lists what it will remove, the worker that was kept is taken once it is clean, the main folder and the merged branch stay, a reload shows the same result', { skip }, async () => {
  const [w1, w2, w3] = S.c.workers;
  fs.rmSync(path.join(w2.worktree, 'scratch.txt')); // the person looked at it and cleaned it away
  await page.open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('[data-action="cleanup"]') && !document.querySelector('[data-action="cleanup"]').disabled`);
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  const ask = await b.eval(`document.querySelector('.dialog').innerText.replace(/[ \\t]+/g, ' ')`);
  assert.match(ask, /要清理這個叢集嗎/);
  // Only what really happens is counted: w1 and w3 were cleaned before (w3 is hidden already), w1 was put back on the sidebar by the person and goes off it again.
  assert.match(ask, /移除 1 個 worktree、刪除 1 個分支、從側欄收起 2 個工作者對話/);
  assert.ok(ask.includes(`cluster/${S.c.id}/merged`), 'the merged branch is said to stay');
  const rows = await b.eval(`[...document.querySelectorAll('.dialog .cluster-cleanup-list > li')].map((li) => [li.dataset.session, li.dataset.keeps])`);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find((r) => r[0] === w2.sessionId), [w2.sessionId, 'false']);
  await shot('c5-cleanup-confirm-1280-light.png');
  // Cancel first: nothing happens.
  await b.click('.dialog .dialog-actions .om-btn:first-child');
  await b.waitFor(`!document.querySelector('.dialog')`);
  assert.ok(fs.existsSync(w2.worktree), 'cancelling removed nothing');
  assert.equal((await getCluster(S.c.id)).cleanup.auto, true, 'and the record is still the automatic one');

  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  await page.confirm();
  await b.waitFor(`document.querySelector('.cluster-cleanup .muted').innerText.includes('手動')`);
  assert.deepEqual(worktrees(S.repo), [fs.realpathSync(S.repo)], 'only the main folder is left');
  assert.deepEqual(branches(S.repo), [`cluster/${S.c.id}/merged`]);
  assert.equal(git(S.repo, 'show', `cluster/${S.c.id}/merged:two.txt`), 'from w2');
  assert.equal(git(S.repo, 'status', '--porcelain'), '');
  assert.equal(git(S.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  const sec = await b.eval(`document.querySelector('.cluster-cleanup').innerText.replace(/\\s+/g, ' ')`);
  assert.match(sec, /3 個 worktree 已移除 · 3 個分支已刪除 · 3 個對話已從側欄收起/);
  assert.equal(await b.eval(`document.querySelector('.cluster-cleanup-kept')`), null, 'nothing is kept now');
  assert.equal(await b.eval(`document.querySelector('[data-action="cleanup"]').disabled`), true, 'nothing left to clean');
  assert.match(await b.eval(`document.querySelector('[data-action="cleanup"]').title`), /已經清理乾淨/);
  // w1 had been put back on the sidebar by the person: the confirmation said it would go off again, and nothing of it is left.
  assert.equal(await sidebarHas(w1.sessionId), false);
  assert.equal(await sidebarHas(w2.sessionId), false);
  assert.equal(await sidebarHas(w3.sessionId), false);
  await shot('c6-manual-cleanup-result-1280-light.png');

  // A reload: the page shows what the Hub has.
  await page.open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('.cluster-cleanup')`);
  assert.match(await b.eval(`document.querySelector('.cluster-cleanup .muted').innerText`), /手動/);
  assert.equal((await getCluster(S.c.id)).cleanup.auto, false);
});

test('a cluster that was never merged, cleaned by hand from the page: the worker with no commit goes, the one with a commit stays with its reason; the buttons wait while a worker works', { skip }, async () => {
  const repo = makeRepo('readonly');
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  hub.machine.autoReply = false; // the workers stay at work until the test says their turn is over
  let c;
  try {
    c = await dispatch(parent, ['只讀', '要改']);
    await b.waitFor(`[...document.querySelectorAll('.cluster-worker .cluster-worker-state')].every((e) => e.innerText.trim() === '執行中')`);
    const busy = await b.eval(`(() => { const e = document.querySelector('[data-action="cleanup"]'); return { disabled: e.disabled, title: e.title }; })()`);
    assert.equal(busy.disabled, true);
    assert.match(busy.title, /工作者還在跑，先全部停止/);
    await shot('c7-cleanup-waits-1280-light.png');
  } finally {
    // The turns end: the workers have given their reports.
    for (const w of c?.workers || []) {
      const kid = (await snap(w.sessionId)).kimiSessionId;
      const p = hub.machine.prompts.find((x) => x.sid === kid);
      hub.machine.reply(kid, p.body.prompt_id, '簡報');
    }
    hub.machine.autoReply = true;
  }
  await until(async () => (await getCluster(c.id)).status === 'done', 15000, 'done');
  const [ro, rw] = c.workers;
  commit(rw, 'new.txt', 'work that was never merged\n');
  await b.waitFor(`document.querySelector('[data-action="cleanup"]') && !document.querySelector('[data-action="cleanup"]').disabled`);
  assert.match(await b.eval(`document.querySelector('[data-action="cleanup"]').title`), /還沒合併過/);
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  const rows = await b.eval(`[...document.querySelectorAll('.dialog .cluster-cleanup-list > li')].map((li) => ({ session: li.dataset.session, keeps: li.dataset.keeps, text: li.innerText.replace(/\\s+/g, ' ') }))`);
  assert.deepEqual(rows.map((r) => [r.session, r.keeps]), [[ro.sessionId, 'false'], [rw.sessionId, 'true']]);
  assert.match(rows[1].text, /還沒合併過：分支有 1 個 commit/);
  await shot('c8-unmerged-confirm-1280-light.png');
  await page.confirm();
  await b.waitFor(`document.querySelector('.cluster-cleanup')`);
  assert.deepEqual(worktrees(repo).sort(), [fs.realpathSync(repo), rw.worktree].sort());
  assert.deepEqual(branches(repo), [rw.branch]);
  assert.equal(git(repo, 'log', '-1', '--format=%s', rw.branch), 'edit new.txt', 'the unmerged commit is where it was');
  assert.deepEqual((await cards()).map((x) => [x.worktree, x.branch, x.hidden]), [['worktree 已移除', '分支已刪除', '已從側欄收起'], ['worktree 保留', '分支保留', '在側欄']]);
  assert.equal(await sidebarHas(ro.sessionId), false);
  assert.equal(await sidebarHas(rw.sessionId), true, 'a worker with unmerged work stays in the sidebar');
  await shot('c9-unmerged-result-1280-light.png');
});

// The condition the page waits for until a worker's row is on the sidebar (a string for b.waitFor).
async function sidebarHasExpr(sid) {
  await typeSearch((await hub.api('GET', `/sessions/${sid}`)).title); // (left typed: the condition is waited for, then the next check types its own)
  return rowOf(sid);
}
