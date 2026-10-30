// The sidebar and a cluster's workers, in a real browser against a real Hub that
// has conversations and cluster workers on disk: the page asks for the sidebar's
// list (?for=sidebar), the workers are not rows - one line counts them and says
// when one needs you - a search finds a worker by name, an open worker is listed
// like any open conversation, and a worker that starts waiting for you is still
// said (toast), whichever page you are on.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession, seedSession } from './browser-harness.mjs';
import { FAKE_SCRIPT } from './fixtures/cluster-fake.mjs';

const skip = skipReason();
const CID = 'c_0123456789ab';
const now = Date.now();
const main = (id, title, over = {}) => seedSession({ id, title, agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `k_${id}`, provider: 'kimi', cwd: '/proj', updatedAt: now - 1000, meta: { machineName: 'box' }, events: [{ id: `${id}e`, ts: now - 5000, type: 'user', text: 'hi' }], ...over });
const worker = (n, title, over = {}) => main(`s_w${n}`, title, { clusterId: CID, clusterRole: 'worker', status: 'idle', updatedAt: now - 2000 - n, kimiSessionId: `k_w${n}`, ...over });
const SESSIONS = () => [main('s_main1', '主對話一'), seedSession({ id: 's_main2', title: '主對話二', agentId: 'claude', provider: 'claude', cwd: '/proj', updatedAt: now - 3000, events: [] }), worker(1, '工作者甲：改登入'), worker(2, '工作者乙：補測試'), worker(3, '工作者丙：寫文件'), worker(4, '收起來的工作者', { clusterHidden: true })];
const clusterWith = (statuses, extra = {}) => ({
  id: CID, parentId: 's_main1', createdAt: now - 60_000, status: 'running', mode: 'brief', isolate: false, swarm: false, warnings: [], tasks: [], memory: { path: '/m.md', bytes: 1 }, merge: null,
  workers: statuses.map((st, i) => ({ sessionId: `s_w${i + 1}`, title: ['工作者甲：改登入', '工作者乙：補測試', '工作者丙：寫文件', '收起來的工作者'][i], task: 't', status: st.status ?? st, branch: null, worktree: null, swarm: false, progress: '', finishedAt: null, hidden: i === 3, subagents: [], subagentCounts: { total: 0, running: 0, awaiting: st.awaiting ?? 0, done: 0, failed: 0, cancelled: 0, unknown: 0 }, subagentsOlder: 0, ...extra })),
  ...extra,
});

let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession(SESSIONS(), { claude: false });
  b = ui.b;
  await b.beforeLoad(FAKE_SCRIPT);
  await b.beforeLoad(`window.__fake = { online: true, clusters: {}, parents: {}, timing: {}, memory: {}, list: [] };`);
});
after(() => ui?.stop());

const titles = () => b.eval(`[...document.querySelectorAll('.side-row:not(.side-workers) .row-title')].map((e) => e.innerText)`);
const line = () => b.eval(`(() => { const e = document.querySelector('.side-workers'); return e ? { title: e.querySelector('.row-title').innerText, sub: e.querySelector('.row-sub-text').innerText, href: e.getAttribute('href'), needs: Boolean(e.querySelector('.om-badge--warning')), spinner: Boolean(e.querySelector('.spinner')) } : null; })()`);
const search = (text) => b.eval(`(() => { const i = document.querySelector('.side-search input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
const emit = (cluster) => b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster })})`);

test('the page asks for the sidebar\'s list, lists the conversations and counts the workers on one line instead of listing them', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  assert.deepEqual(await titles(), ['主對話一', '主對話二']);
  const l = await line();
  assert.equal(l.title, '叢集工作者 3 個', 'the one the clean-up hid is not counted');
  assert.equal(l.href, '#/clusters');
  assert.match(l.sub, /叢集總覽/);
  const gets = await b.eval('window.__gets');
  assert.ok(gets.includes('/api/sessions?for=sidebar'), `asked for the sidebar's list: ${gets}`);
  assert.ok(gets.includes('/api/machines?for=sidebar'));
  assert.ok(!gets.includes('/api/sessions'), 'and never for every conversation whole');
  assert.ok(!gets.some((u) => /\/api\/sessions\/s_w\d/.test(u)), 'nothing was loaded for a worker');
});

test('a search finds a worker by name, tagged 叢集, and opens it; left again, it is not in the list', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  await search('測試');
  await b.waitFor(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('工作者乙'))`);
  assert.equal(await line(), null, 'while searching the workers are results, not a count');
  const hit = await b.eval(`(() => { const r = [...document.querySelectorAll('.side-row')].find((r) => r.innerText.includes('工作者乙')); return { tag: r.querySelector('.row-tag.cluster')?.innerText, href: r.getAttribute('href') }; })()`);
  assert.deepEqual(hit, { tag: '叢集', href: '#/s/s_w2' });
  await search('收起來');
  await b.sleep(150);
  assert.equal(await b.eval(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('收起來的工作者'))`), false, 'a worker the clean-up hid is not found');
  await search('工作者乙');
  await b.waitFor(`document.querySelector('.side-row[href="#/s/s_w2"]')`);
  await b.click('.side-row[href="#/s/s_w2"]');
  await b.waitFor(`document.querySelector('.cluster-worker-note') && document.querySelector('.composer-input')`);
  assert.equal(await b.eval(`document.querySelector('.side-row[aria-current="page"]')?.getAttribute('href')`), '#/s/s_w2', 'the open worker is listed, and marked');
  assert.match(await b.eval(`document.querySelector('.toolbar').innerText`), /工作者乙/, 'its conversation, with its whole summary, came with the snapshot when it was opened');
  // Leave it: back to the plain list.
  await search('');
  await b.eval(`location.hash = '#/'`);
  await b.waitFor(`document.querySelector('.side-workers') && !document.querySelector('.side-row[href="#/s/s_w2"]')`);
  assert.equal((await line()).title, '叢集工作者 3 個');
});

test('a worker that starts waiting for you is said, on whatever page you are on, and the line says so', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  // The cluster says all three are working (the page learns it; nothing to say).
  await emit(clusterWith(['running', 'running', 'running', 'running']));
  await b.waitFor(`document.querySelector('.side-workers .spinner')`);
  assert.equal((await line()).needs, false);
  assert.equal(await b.eval(`document.querySelectorAll('.toasts .toast, .toasts > *').length`), 0, 'nothing said yet');
  // One of them now waits for approval.
  await emit(clusterWith(['running', 'awaiting_permission', 'running', 'running']));
  await b.waitFor(`document.querySelector('.toasts')?.innerText.includes('「工作者乙：補測試」需要你核准')`);
  await b.waitFor(`document.querySelector('.side-workers .om-badge--warning')`);
  assert.equal((await line()).needs, true);
  // The title of the page counts it, like any conversation that needs you.
  assert.match(await b.eval('document.title'), /^\(1\) /);
  // It is approved: the line calms down.
  await emit(clusterWith(['running', 'running', 'running', 'running']));
  await b.waitFor(`!document.querySelector('.side-workers .om-badge--warning')`);
});

test('a worker\'s subagent that waits for approval is said once, like a conversation\'s', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  await emit(clusterWith(['running', 'running', 'running', 'running']));
  await b.sleep(200);
  await emit(clusterWith(['running', { status: 'running', awaiting: 1 }, 'running', 'running']));
  await b.waitFor(`document.querySelector('.toasts')?.innerText.includes('「工作者乙：補測試」的子代理需要你核准')`);
  assert.equal((await line()).needs, true);
});

test('a worker the Hub has not listed (made after the page loaded) is counted and found as soon as its cluster says so', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  const c = clusterWith(['running', 'running', 'running', 'running']);
  c.workers.push({ ...c.workers[0], sessionId: 's_w9', title: '新來的工作者戊' });
  await emit(c);
  await b.waitFor(`document.querySelector('.side-workers .row-title')?.innerText === '叢集工作者 4 個'`);
  await search('戊');
  await b.waitFor(`document.querySelector('.side-row[href="#/s/s_w9"]')`);
  // And one whose conversation is deleted is gone.
  const d = clusterWith(['running', 'running', 'running', 'running']);
  d.workers.push({ ...c.workers[0], sessionId: 's_w9', title: '新來的工作者戊', status: 'deleted' });
  await emit(d);
  await search('');
  await b.waitFor(`document.querySelector('.side-workers .row-title')?.innerText === '叢集工作者 3 個'`);
});

test('a worker announced before it is known to be one (the Hub marks it a moment after it makes it) is a plain row until its cluster names it, then it is counted instead, and its Kimi conversation is no row of its computer', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.side-workers')`);
  // The conversation the Hub made for a new worker, as first announced: not marked, and its Kimi conversation listed by the computer.
  await b.eval(`(async () => {
    const s = await (await fetch('/api/sessions/s_main1')).json();
    window.__emit({ t: 'machine', machine: { id: 'm1', name: 'box', online: true, kimi: { available: true }, sessions: [{ id: 'k_new1', title: '新工作者的 Kimi', cwd: '/proj/w9', updatedAt: Date.now(), hubSessionId: 's_new1', leafId: 's_new1', isLeaf: true, conversationId: 's_new1' }] } });
    window.__emit({ t: 'session', session: { ...s, id: 's_new1', conversationId: 's_new1', leafId: 's_new1', title: '新工作者', kimiSessionId: 'k_new1', clusterId: null, clusterRole: null } });
  })()`);
  await b.waitFor(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('新工作者'))`);
  assert.equal((await line()).title, '叢集工作者 3 個');
  // Its cluster names it.
  const c = clusterWith(['running', 'running', 'running', 'running']);
  c.workers.push({ ...c.workers[0], sessionId: 's_new1', title: '新工作者' });
  await emit(c);
  await b.waitFor(`document.querySelector('.side-workers .row-title')?.innerText === '叢集工作者 4 個'`);
  assert.deepEqual(await titles(), ['主對話一', '主對話二'], 'no row for it in the list, and none for its Kimi conversation among the terminal ones');
  await search('新工作者');
  await b.waitFor(`document.querySelector('.side-row[href="#/s/s_new1"]')`);
  assert.equal(await b.eval(`[...document.querySelectorAll('.side-row')].filter((r) => r.innerText.includes('新工作者')).length`), 1, 'found once - the worker, not its computer\'s entry for its Kimi conversation (a search opens the 子session group)');
  await search('');
});
