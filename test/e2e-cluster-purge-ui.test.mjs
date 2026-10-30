// 完全清除 and the cluster's name from the screen to the disk, with NOTHING between
// them faked but the computer's Kimi: a real Hub serving the real page, a real
// Chromium driven only by clicks and keys, a computer whose shell really runs bash
// (so worktrees, branches, backups and their removal are real git and real files)
// and whose Kimi conversations are real folders, played by the fake machine.
// The page's own requests are NOT intercepted.
//
// The owner asked: "after a cluster has finished, is there a clean way to remove it
// - the Agent Hub rows, the local cluster, the subagent session records?", and
// "none of my clusters is named 'VPS框架開發', yet every one shows that".
//
// Skips, saying why, when there is no Chromium. CLUSTER_UI_SHOTS=<dir> also saves
// screenshots of the real flow.
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
const branches = (repo) => git(repo, 'branch', '--list', 'cluster/*', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
const shot = async (name) => {
  if (!SHOTS) return;
  await b.sleep(450);
  await b.shot(path.join(SHOTS, name));
};
const sidebarHas = (sid) => b.eval(`[...document.querySelectorAll('.sidebar .side-row')].some((r) => r.getAttribute('href') === '#/s/${sid}')`);
const kimiOf = async (w) => (await snap(w.sessionId)).kimiSessionId;
const tarList = (file) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
const setTheme = (theme) => b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
const summary = () => b.eval(`Object.fromEntries([...document.querySelectorAll('.dialog [data-field="purge-summary"] li')].map((l) => [l.dataset.item, l.innerText.trim()]))`);
// An already-made, finished cluster of `n` workers through the API (the dispatch screen is used once, above).
async function finished(repo, parent, tasks, name) {
  const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: tasks.map((t) => ({ title: t, prompt: `請處理：${t}` })), ...(name ? { name } : {}) });
  await until(async () => (await getCluster(c.id)).status === 'done', 15000, `${c.id} done`);
  return c;
}

before(async () => {
  if (skip) return;
  hub = await startRealHub('cluster-purge-ui', {
    claude: true,
    machine: (TMP) => ({ home: path.join(TMP, 'machine-home'), capabilities: ['kimi_delete'], kimiHome: path.join(TMP, 'kimi-home'), stateDir: path.join(TMP, 'machine-state') }),
  });
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

test('a cluster is dispatched with a name, shows it big with the main conversation small, steps in the head, and the pencil renames it - against the real Hub', { skip }, async () => {
  S.repo = makeRepo('proj');
  S.parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: S.repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  await hub.api('POST', `/sessions/${S.parent.id}/command`, { name: 'title', args: 'VPS框架開發' });
  // Two clusters from this one conversation: one named by the person in the dialog, one left to be named from its tasks.
  await page.openDialog(S.parent.id);
  await b.waitFor(`document.querySelector('input[name="cluster-name"]')`);
  await page.fillTask(0, '改甲', '請處理：改甲（第 1 項）');
  await b.click('[data-action="add-task"]');
  await page.fillTask(1, '改乙', '請處理：改乙（第 2 項）');
  await b.click('[data-action="add-task"]');
  await page.fillTask(2, '改丙', '請處理：改丙（第 3 項）');
  assert.equal(await b.eval(`document.querySelector('input[name="cluster-name"]').placeholder`), '改甲 等 3 條');
  await page.typeInto('input[name="cluster-name"]', '登入大改造');
  await shot('p0-dispatch-name-1280-light.png');
  await page.submitDialog();
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 30000 });
  S.cid = await b.eval('location.hash.slice(10)');
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3`);
  S.c = await getCluster(S.cid);
  await until(async () => (await getCluster(S.cid)).status === 'done', 15000, 'done');
  S.c = await getCluster(S.cid);
  assert.equal(S.c.name, '登入大改造');
  await b.waitFor(`document.querySelector('.cluster-head [data-field="name"]')?.innerText.trim() === '登入大改造'`);
  assert.equal(await b.eval(`document.querySelector('.cluster-head [data-field="parent"]').innerText.trim()`), '主對話：VPS框架開發');
  assert.equal(await b.eval(`document.querySelector('.ch-facts [data-field="steps"]')?.innerText.trim()`), '共 0 步', 'a measured zero: the fake Kimi made no tool calls');
  // Another cluster from the same conversation, named from its tasks.
  S.c2 = await finished(S.repo, S.parent, ['修登入', '補測試']);
  assert.equal(S.c2.name, '修登入 等 2 條');
  await page.open('#/clusters');
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 2`);
  const cards = await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => [c.querySelector('.cc-title').innerText, c.querySelector('.cc-parent').innerText])`);
  assert.deepEqual(cards.map((c) => c[0]).sort(), ['修登入 等 2 條', '登入大改造']);
  assert.ok(cards.every((c) => c[1] === '主對話：VPS框架開發'));
  assert.ok(!cards.some((c) => c[0] === 'VPS框架開發'), 'no card is called by the main conversation');
  await shot('p1-overview-names-1280-light.png');
  // The pencil, by clicking.
  await page.open(`#/cluster/${S.cid}`);
  await b.waitFor(`document.querySelector('[data-action="rename"]')`);
  await b.click('[data-action="rename"]');
  await b.waitFor(`document.querySelector('.cluster-rename-dialog')`);
  await page.typeInto('.cluster-rename-dialog input', '登入頁 重做');
  await b.click('[data-action="rename-save"]');
  await b.waitFor(`document.querySelector('.cluster-head [data-field="name"]').innerText.trim() === '登入頁 重做'`);
  assert.equal((await getCluster(S.cid)).name, '登入頁 重做', 'the Hub has it');
  assert.equal(JSON.parse(fs.readFileSync(path.join(hub.DATA, 'clusters', `${S.cid}.json`), 'utf8')).name, '登入頁 重做', 'and the disk');
});

test('完全清除 from the cluster page: the confirmation counts match the disk, nothing is deleted until the click, then the worktrees, branches, memory, Kimi folders and the Hub rows go, the backup is real, the main conversation stays', { skip }, async () => {
  const [w1, w2, w3] = S.c.workers;
  commit(w1, 'a.txt', 'one\nFROM-W1\nthree\n');
  commit(w2, 'a.txt', 'one\nFROM-W2\nthree\n');
  fs.writeFileSync(path.join(w3.worktree, 'scratch.txt'), 'a note nobody committed\n');
  await hub.api('POST', `/clusters/${S.cid}/merge`);
  const kids = await Promise.all([w1, w2, w3].map(kimiOf));
  const mergedTip = git(S.repo, 'rev-parse', `cluster/${S.cid}/merged`);
  const parentBefore = await snap(S.parent.id);
  const ofThis = (list) => list.filter((p) => p.includes(S.cid));
  assert.equal(ofThis(worktrees(S.repo)).length, 3);

  await page.open(`#/cluster/${S.cid}`);
  await b.waitFor(`document.querySelector('[data-action="purge"]') && !document.querySelector('[data-action="purge"]').disabled`);
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  const s = await summary();
  assert.equal(s.conversations, '3 個工作者對話：Hub 紀錄＋Kimi 紀錄 3 筆');
  assert.equal(s.worktrees, '2 個 worktree', 'w1 and w2 are clean; w3 has something uncommitted');
  assert.equal(s.branches, '1 個工作者分支', 'only w1\'s commits are in the merged branch');
  await shot('p2-purge-confirm-1280-light.png');
  // Nothing has been touched by asking.
  assert.equal(ofThis(worktrees(S.repo)).length, 3);
  for (const kid of kids) assert.ok(fs.existsSync(hub.machine.dirOf(kid)));
  for (const w of [w1, w2, w3]) assert.ok(await snap(w.sessionId));

  // Cancelled first.
  await b.click('.cluster-purge-dialog .dialog-actions .om-btn:first-child');
  await b.waitFor(`!document.querySelector('.cluster-purge-dialog')`);
  assert.equal(ofThis(worktrees(S.repo)).length, 3);
  // Then really, with the defaults (nothing ticked).
  await b.click('[data-action="purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  await b.click('[data-action="purge-confirm"]');
  await b.waitFor(`document.querySelector('[data-view="purge-result"]')`, { timeout: 30000 });
  assert.equal(await b.eval(`document.querySelector('[data-view="purge-result"]').dataset.tone`), 'ok');

  // The disk: the clean worktrees and the safe branch are gone; the dirty worktree, the unmerged branch and the merged branch stayed.
  assert.deepEqual(ofThis(worktrees(S.repo)), [fs.realpathSync(w3.worktree)], 'of this cluster only the dirty one is left (the other cluster\'s are its own)');
  assert.deepEqual(branches(S.repo).filter((n) => n.includes(S.cid)), [w2.branch, w3.branch, `cluster/${S.cid}/merged`].sort());
  assert.equal(git(S.repo, 'rev-parse', `cluster/${S.cid}/merged`), mergedTip, 'the merged branch is untouched');
  assert.equal(fs.readFileSync(path.join(w3.worktree, 'scratch.txt'), 'utf8'), 'a note nobody committed\n');
  for (const kid of kids) assert.ok(!fs.existsSync(hub.machine.dirOf(kid)), 'Kimi\'s folder is gone');
  assert.ok(!fs.existsSync(path.dirname(S.c.memory.path)), 'the memory folder is gone');
  // The Hub: no workers, no cluster record, the main conversation is whole.
  for (const w of [w1, w2, w3]) assert.equal(await sidebarHas(w.sessionId), false);
  await assert.rejects(getCluster(S.cid), (e) => e.status === 404);
  assert.ok(!fs.existsSync(path.join(hub.DATA, 'clusters', `${S.cid}.json`)));
  const parentAfter = await snap(S.parent.id);
  assert.deepEqual(parentAfter.events, parentBefore.events);
  assert.equal(await sidebarHas(S.parent.id), true);
  assert.deepEqual(parentAfter.clusterIds, [S.c2.id], 'its list of clusters has only the other one');
  // What the page says.
  const lines = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-purge-section')].map((s) => [s.classList.contains('backup') ? 'backup' : s.classList[1], [...s.querySelectorAll('li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())]))`);
  assert.deepEqual(lines.deleted, ['3 個工作者對話（Hub 紀錄＋Kimi 紀錄與子代理）', '2 個 worktree', '1 個工作者分支', '叢集記憶檔與資料夾', '叢集紀錄本身（已從總覽移除）']);
  assert.equal(lines.kept.length, 4, 'the dirty worktree, its branch, the unmerged branch and the merged branch, each with its reason');
  assert.ok(lines.kept.every((l) => /沒勾/.test(l)));
  // The backup the page names is a real file with what was deleted.
  const file = await b.eval(`document.querySelector('[data-field="backup-machine"]').innerText`);
  assert.equal(path.dirname(file), path.join(hub.TMP, 'machine-state', 'trash'));
  const list = tarList(file);
  for (const kid of kids) assert.ok(list.includes(`${path.relative('/', hub.machine.dirOf(kid))}/agents/agent-0/wire.jsonl`), 'the subagent journal is in it');
  assert.ok(list.some((e) => e.endsWith('/memory.md')));
  const hubFile = path.join(hub.DATA, 'trash', path.basename(await b.eval(`document.querySelector('[data-field="backup-hub"]').innerText`)));
  assert.ok(tarList(hubFile).includes(`clusters/${S.cid}.json`));
  await shot('p3-purge-result-1280-light.png');
  assert.equal(await b.eval(`document.querySelector('.cluster-gone [data-action="back-to-list"]')?.getAttribute('href')`), '#/clusters');
  await b.click('[data-action="back-to-list"]');
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 1`);
  assert.equal(await b.eval(`document.querySelector('.cluster-card .cc-title').innerText`), S.c2.name);
  // The list of recent purges, with the real file.
  await b.waitFor(`document.querySelector('[data-view="purged-list"]')`);
  await b.eval(`document.querySelector('[data-view="purged-list"]').open = true`);
  assert.ok((await b.eval(`document.querySelector('[data-view="purged-list"]').innerText`)).includes(file));
  await shot('p4-recent-purges-1280-light.png');
});

test('the batch from the page of every cluster: two finished clusters picked, one confirmation, the boxes ticked, both gone, a result for each; the backups are listed', { skip }, async () => {
  const repo = makeRepo('batch');
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  const a = await finished(repo, parent, ['批甲', '批乙'], '批次一');
  const c = await finished(repo, parent, ['批丙'], '批次二');
  commit(a.workers[0], 'x.txt', 'unmerged work\n');
  fs.writeFileSync(path.join(c.workers[0].worktree, 'dirty.txt'), 'uncommitted\n');
  const kids = await Promise.all([...a.workers, ...c.workers].map(kimiOf));
  await page.open('#/clusters');
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  await b.click('[data-action="pick-start"]');
  await b.click(`.cluster-card[data-cluster="${a.id}"]`);
  await b.click(`.cluster-card[data-cluster="${c.id}"]`);
  assert.equal(await b.eval(`document.querySelector('[data-field="picked"]').innerText.trim()`), '已選 2 個叢集');
  await shot('p5-batch-pick-1280-light.png');
  await b.click('[data-action="batch-purge"]');
  await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
  const s = await summary();
  assert.equal(s.conversations, '3 個工作者對話：Hub 紀錄＋Kimi 紀錄 3 筆');
  assert.equal(s.cluster, '2 個叢集紀錄本身（從總覽移除）');
  await shot('p6-batch-confirm-1280-light.png');
  await b.click('.dialog input[data-box="discardDirty"]');
  await b.click('.dialog input[data-box="deleteUnmerged"]');
  await b.click('[data-action="purge-confirm"]');
  await b.waitFor(`document.querySelector('.cluster-purge-batch')`, { timeout: 30000 });
  const results = await b.eval(`[...document.querySelectorAll('.cluster-purge-batch [data-view="purge-result"]')].map((r) => [r.dataset.tone, r.querySelector('.cluster-section-title .muted').innerText])`);
  assert.deepEqual(results, [['ok', '批次一'], ['ok', '批次二']]);
  await shot('p7-batch-result-1280-light.png');
  assert.deepEqual(worktrees(repo), [fs.realpathSync(repo)]);
  assert.deepEqual(branches(repo), []);
  for (const kid of kids) assert.ok(!fs.existsSync(hub.machine.dirOf(kid)));
  await assert.rejects(getCluster(a.id), (e) => e.status === 404);
  await assert.rejects(getCluster(c.id), (e) => e.status === 404);
  await b.click('[data-action="close-result"]');
  await b.waitFor(`!document.querySelector('.cluster-purge-batch')`);
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 1`);
  assert.equal((await hub.api('GET', '/clusters/trash')).items.filter((i) => [a.id, c.id].includes(i.clusterId)).length, 2, 'both purges have their backups listed');
});

test('the same screens on a phone and in the dark look, against the real Hub', { skip }, async () => {
  const repo = makeRepo('looks');
  const parent = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: repo, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
  await hub.api('POST', `/sessions/${parent.id}/command`, { name: 'title', args: 'VPS框架開發' });
  const looks = [['390-light', 390, 844, 'light'], ['390-dark', 390, 844, 'dark'], ['1280-dark', 1280, 900, 'dark']];
  for (const [label, w, h, theme] of looks) {
    const c = await finished(repo, parent, ['看起來', '怎麼樣'], `外觀 ${label}`);
    fs.writeFileSync(path.join(c.workers[0].worktree, 'dirty.txt'), 'uncommitted\n');
    await b.size(w, h, w < 700);
    await b.goto(`http://127.0.0.1:${hub.PORT}/#/`, 200);
    await setTheme(theme);
    await page.open(`#/cluster/${c.id}`);
    await b.waitFor(`document.querySelector('[data-action="purge"]') && !document.querySelector('[data-action="purge"]').disabled`);
    await shot(`p8-page-${label}.png`);
    await b.click('[data-action="purge"]');
    await b.waitFor(`document.querySelector('.cluster-purge-dialog')`);
    await b.sleep(300);
    await shot(`p9-confirm-${label}.png`);
    const over = await b.eval(`(() => { const d = document.querySelector('.dialog'); return d.scrollWidth - d.clientWidth; })()`);
    assert.ok(over <= 1, `${label}: the dialog does not scroll sideways (${over})`);
    await b.click('[data-action="purge-confirm"]');
    await b.waitFor(`document.querySelector('[data-view="purge-result"]')`, { timeout: 30000 });
    await b.sleep(300);
    await shot(`p10-result-${label}.png`);
    const over2 = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over2.map((x) => x <= 1), [true, true], `${label}: the result does not scroll sideways ${over2}`);
  }
  await b.size(1280, 900, false);
  await setTheme('light');
});
