// 叢集 task queue from the screen to the disk, with NOTHING between them faked:
// a real Hub, the real page in a real Chromium driven only by clicks and keys
// (the page's own requests are NOT intercepted), a computer whose shell really
// runs bash (real git worktrees) and a Kimi played by the fake machine.
//
// What a person sees of "more tasks than workers": the dialog takes a pasted
// list (one task per line) and a number of workers, and says what it would do
// instead of choosing for you; the cluster page lists every task with its state,
// who does it and the Hub's times, and "任務 x/y 完成" in its head; each worker
// card says which task it is on. On a phone and in the dark look it all fits and
// can be read.
//
// Skips, saying why, when there is no Chromium. CLUSTER_UI_SHOTS=<dir> also
// saves screenshots of the real flow to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipReason, launchBrowser, CONTRAST_JS } from './browser-harness.mjs';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
const MID = 'm_fake';
let hub;
let b;
let page;
let KIMI;
let N = 0;

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function makeRepo(name) {
  const dir = path.join(hub.TMP, `${name}-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newKimi = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const prompts = (kid) => hub.machine.prompts.filter((p) => p.sid === kid);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const idle = (sid) => until(async () => (await snap(sid)).status === 'idle' && snap(sid), 15000, `${sid} idle`);
const shot = async (name) => {
  if (!SHOTS) return;
  await b.sleep(450);
  await b.shot(path.join(SHOTS, name));
};
// Kimi reports the worker's current turn over.
async function finish(sid) {
  const kid = await kidOf(sid);
  hub.machine.reply(kid, prompts(kid).at(-1).body.prompt_id, '回報');
}
const waitPrompts = (sid, n) => until(async () => prompts(await kidOf(sid)).length >= n, 10000, `${n} prompts to ${sid}`);

const rows = () =>
  b.eval(`[...document.querySelectorAll('.cluster-queue-row')].map((r) => { const t = (s) => r.querySelector(s)?.innerText.trim() ?? null; return { task: r.dataset.task, status: r.dataset.status, no: t('.cluster-queue-no'), title: t('.cluster-queue-title'), state: t('[data-field="task-status"]'), worker: t('[data-field="task-worker"]'), times: t('[data-field="task-times"]'), note: t('[data-field="task-note"]') }; })`);
// A worker's tile says which task it is on in a few words; the whole line (which, of how many, what it is called, how many done) is in its drawer.
const queueCards = async () => {
  const sids = await b.eval(`[...document.querySelectorAll('.cluster-worker')].map((c) => c.dataset.session)`);
  const out = [];
  for (const sid of sids) {
    const place = await b.eval(`document.querySelector('.cluster-worker[data-session="${sid}"] .cluster-worker-queue')?.innerText.trim() ?? null`);
    const title = await b.eval(`document.querySelector('.cluster-worker[data-session="${sid}"] .cluster-worker-title')?.innerText.trim()`);
    await page.openDrawer(sid);
    const line = await b.eval(`document.querySelector('.cluster-drawer [data-field="worker-queue"]')?.innerText.trim() ?? null`);
    await page.closeDrawer();
    out.push({ title, place, line });
  }
  return out;
};
const overflow = () => b.eval(`({ page: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth, wide: [...document.querySelectorAll('.cluster-page *, .cluster-dialog *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.cluster-memory-text, pre, .cluster-tasks, .cluster-queue-list')).slice(0, 5).map((e) => e.className || e.tagName) })`);

const READONLY = ['審查登入模組並列出問題', '審查付款模組並列出問題', '審查通知模組並列出問題', '審查報表模組並列出問題', '審查搜尋模組並列出問題', '審查設定模組並列出問題'];

before(async () => {
  if (skip) return;
  hub = await startRealHub('cluster-queue-ui');
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

test('the dialog takes a pasted list and a number of workers, says what the numbers mean, and suggests - without choosing for the person', { skip }, async () => {
  S.repo = makeRepo('proj');
  S.parent = await newKimi(S.repo);
  await idle(S.parent.id);
  await page.openDialog(S.parent.id);
  // A new dialog: one empty task, workers follow the number of tasks.
  assert.equal(await b.eval(`document.querySelector('input[name="workers"]').value`), '1');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('[data-advice]')].map((e) => e.dataset.advice)`), [], 'nothing typed, nothing suggested');

  // Six lines pasted at once, some with the list marks they were copied with.
  await page.typeInto('textarea[name="task-lines"]', READONLY.map((t, i) => (i % 2 ? `${i + 1}. ${t}` : `- ${t}`)).join('\n'));
  await b.click('[data-action="add-lines"]');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-task').length`), 6, 'the empty first task was replaced, not kept');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-task textarea[name="task-prompt"]')].map((e) => e.value)`), READONLY, 'list marks are taken off');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-task input[name="task-title"]')].map((e) => e.value)`), Array(6).fill(''), 'the names are left for the Hub to make from each line: no line is written twice');
  assert.equal(await b.eval(`document.querySelector('textarea[name="task-lines"]').value`), '', 'the box is emptied');
  assert.match(await b.eval(`document.querySelector('[data-field="lines-note"]').innerText`), /加了 6 條/);
  assert.equal(await b.eval(`document.querySelector('.cluster-count').innerText.trim()`), '6 / 64');
  // Workers: not chosen yet, so the default (4) is shown and explained.
  assert.equal(await b.eval(`document.querySelector('input[name="workers"]').value`), '4');
  assert.match(await b.eval(`document.querySelector('[data-field="workers-help"]').innerText`), /6 條任務、4 個工作者：每個工作者一次做一條，做完在同一個對話裡自動領下一條/);
  assert.equal(await b.eval(`document.querySelector('.cluster-dialog button[type="submit"]').innerText.trim()`), '派出 6 條任務（4 個工作者）');
  // Six read-only tasks of one kind: the suggestion is shown, and nothing was switched.
  const advice = await b.eval(`[...document.querySelectorAll('[data-advice]')].map((e) => ({ id: e.dataset.advice, text: e.innerText.trim() }))`);
  assert.deepEqual(advice.map((a) => a.id), ['readonly-swarm']);
  assert.match(advice[0].text, /Swarm 模式一次派出/);
  assert.equal(await b.eval(`document.querySelector('input[name="swarm"]').checked`), true, 'the person\'s switches are as they were');
  assert.equal(await b.eval(`document.querySelector('[data-field="mode"] [aria-pressed="true"]').innerText.trim()`), '簡報起跑（建議）');
  await shot('q01-dialog-queue-1280-light.png');

  // The person chooses 2 workers.
  await page.typeInto('input[name="workers"]', '2');
  assert.equal(await b.eval(`document.querySelector('.cluster-dialog button[type="submit"]').innerText.trim()`), '派出 6 條任務（2 個工作者）');
  // More workers than tasks: said, not silently changed.
  await page.typeInto('input[name="workers"]', '8');
  assert.match(await b.eval(`document.querySelector('[data-field="workers-help"]').innerText`), /任務只有 6 條，所以只會開 6 個工作者/);
  assert.equal(await b.eval(`document.querySelector('.cluster-dialog button[type="submit"]').innerText.trim()`), '派出 6 個工作者');
  await page.typeInto('input[name="workers"]', '2');

  // Too few tasks: the other suggestion.
  for (let i = 0; i < 4; i++) await b.eval(`document.querySelector('[data-action="remove-task"]').click()`);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-task').length`), 2);
  const few = await b.eval(`[...document.querySelectorAll('[data-advice]')].map((e) => ({ id: e.dataset.advice, text: e.innerText.trim() }))`);
  assert.deepEqual(few.map((a) => a.id), ['few']);
  assert.match(few[0].text, /任務很少.*直接在這個對話做通常最快/);
  // Writing tasks with no worktree each: the third suggestion.
  await page.fillTask(0, '', '修改登入頁的錯誤訊息並新增測試');
  await b.click('input[name="isolate"]');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('[data-advice]')].map((e) => e.dataset.advice)`), ['few', 'isolate']);
  assert.match(await b.eval(`document.querySelector('[data-advice="isolate"]').innerText`), /建議每個工作者獨立 worktree/);
  assert.equal(await b.eval(`document.querySelector('input[name="isolate"]').checked`), false, 'and it did not turn the switch back on by itself');
  await b.click('input[name="isolate"]');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('[data-advice]')].map((e) => e.dataset.advice)`), ['few']);
  await b.eval(`document.querySelector('.cluster-dialog button[type="button"]:not([data-action])')?.click()`);
});

test('a dispatch of 6 tasks to 2 workers: the page lists the queue, each worker says what it is on, and both follow the Hub without a reload', { skip }, async () => {
  hub.machine.autoReply = false;
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  await page.openDialog(parent.id);
  await page.typeInto('textarea[name="task-lines"]', READONLY.join('\n'));
  await b.click('[data-action="add-lines"]');
  await page.typeInto('input[name="workers"]', '2');
  await page.submitDialog();
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 30000 });
  const cid = await b.eval('location.hash.slice(10)');
  await b.waitFor(`document.querySelectorAll('.cluster-queue-row').length === 6`);
  await page.openFolds(); // the queue is folded on a fresh page; a person opens it
  S.c = await getCluster(cid);
  assert.equal(S.c.workers.length, 2, 'two workers were made, for six tasks');
  assert.equal(S.c.tasks.length, 6);
  const [w1, w2] = S.c.workers;

  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 0/6 完成');
  assert.equal(await b.eval(`document.querySelector('.cluster-workers-count').innerText.trim()`), '2 個', 'the 工作者 heading counts workers, not tasks');
  let r = await rows();
  assert.deepEqual(r.map((x) => x.state), ['進行中', '進行中', '等待中', '等待中', '等待中', '等待中']);
  assert.deepEqual(r.map((x) => x.worker), ['w1', 'w2', null, null, null, null]);
  assert.deepEqual(r.map((x) => x.title), READONLY.map((t) => t));
  assert.match(r[0].times, /^開始 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'a running task has its start, not an end');
  assert.equal(r[2].times, null, 'a waiting task has no time');
  assert.equal(await b.eval(`document.querySelector('[data-field="queue-sum"]').innerText.trim()`), '0/6 完成 · 2 條進行中 · 4 條等待中');
  assert.deepEqual((await queueCards()).map((c) => c.line), [`正在做第 1/6 條「${READONLY[0]}」 · 已完成 0 條`, `正在做第 2/6 條「${READONLY[1]}」 · 已完成 0 條`]);
  assert.equal(await b.eval(`document.querySelector('[data-field="never-sent"]') === null`), true);
  await shot('q02-cluster-queue-1280-light.png');

  // w1 reports; the page moves on by itself: task 1 done, task 3 is w1's.
  await finish(w1.sessionId);
  await waitPrompts(w1.sessionId, 2);
  await b.waitFor(`document.querySelector('.cluster-progress').innerText.trim() === '任務 1/6 完成'`, { label: 'the head follows' });
  await b.waitFor(`document.querySelector('.cluster-queue-row[data-task="2"]')?.dataset.status === 'running'`);
  r = await rows();
  assert.deepEqual(r.map((x) => x.state), ['已完成', '進行中', '進行中', '等待中', '等待中', '等待中']);
  assert.equal(r[2].worker, 'w1', 'the next one is w1\'s');
  assert.match(r[0].times, /^開始 .* · 結束 .* · 用了 [\d.]+ 秒$/, 'a finished task has start, end and the length between them');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${w1.sessionId}"] .cluster-worker-queue')?.innerText.includes('第 3/6 條')`);
  assert.equal((await queueCards())[0].line, `正在做第 3/6 條「${READONLY[2]}」 · 已完成 1 條`);
  // The card's own title is the task it is on now.
  assert.equal((await queueCards())[0].title, READONLY[2]);

  // w1 goes through the rest while w2 is slow.
  for (let i = 2; i <= 4; i++) {
    await finish(w1.sessionId);
    await waitPrompts(w1.sessionId, i + 1);
  }
  await b.waitFor(`document.querySelector('.cluster-progress').innerText.trim() === '任務 4/6 完成'`);
  r = await rows();
  assert.deepEqual(r.map((x) => x.state), ['已完成', '進行中', '已完成', '已完成', '已完成', '進行中']);
  assert.deepEqual(r.map((x) => x.worker), ['w1', 'w2', 'w1', 'w1', 'w1', 'w1']);
  assert.equal((await queueCards())[0].line.endsWith('已完成 4 條'), true);
  assert.equal((await queueCards())[1].line, `正在做第 2/6 條「${READONLY[1]}」 · 已完成 0 條`, 'the slow one is still on its first');
  await shot('q03-cluster-queue-midway-1280-light.png');

  await finish(w1.sessionId);
  await finish(w2.sessionId);
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成' && document.querySelector('.cluster-progress').innerText.trim() === '任務 6/6 完成'`, { timeout: 15000 });
  assert.deepEqual((await rows()).map((x) => x.state), Array(6).fill('已完成'));
  assert.equal((await getCluster(cid)).status, 'done');
  S.done = await getCluster(cid);
  await shot('q04-cluster-queue-done-1280-light.png');
  hub.machine.autoReply = true;
});

test('stop on the page: the running tasks read 失敗 (cut off), the waiting ones are said never to have been sent, and the cluster reads 已停止', { skip }, async () => {
  hub.machine.autoReply = false;
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await page.dispatch(parent, READONLY.slice(0, 5).map((t) => ({ title: '', prompt: t })), { workers: 2 });
  S.stopped = c;
  assert.equal(c.tasks.length, 5);
  const kids = await Promise.all(c.workers.map((w) => kidOf(w.sessionId)));
  await b.click('[data-action="stop"]');
  await page.confirm();
  for (const k of kids) hub.machine.frame(k, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已停止'`, { timeout: 12000 });
  await b.waitFor(`document.querySelector('[data-field="never-sent"]')`);
  assert.match(await b.eval(`document.querySelector('[data-field="never-sent"]').innerText`), /已經停止派工：還有 3 條任務沒有派出去/);
  const r = await rows();
  assert.deepEqual(r.map((x) => x.state), ['失敗', '失敗', '等待中', '等待中', '等待中']);
  assert.match(r[0].note, /全部停止/);
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 0/5 完成');
  assert.equal(await b.eval(`document.querySelector('[data-action="cleanup"]').disabled`), false, 'a stop ended the queue: clean-up is allowed');
  await shot('q05-cluster-stopped-1280-light.png');
  hub.machine.autoReply = true;
});

test('a task handed back after its worker failed is said on the page, and a task that failed twice says why', { skip }, async () => {
  hub.machine.autoReply = false;
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await page.dispatch(parent, READONLY.slice(0, 3).map((t) => ({ title: '', prompt: t })), { workers: 2 });
  const [w1, w2] = c.workers;
  const k1 = await kidOf(w1.sessionId);
  hub.machine.frame(k1, 'event.session.work_changed', { busy: false, last_turn_reason: 'failed', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('.cluster-queue-row[data-task="0"]')?.dataset.status === 'pending'`, { timeout: 12000 });
  let r = await rows();
  assert.match(r[0].note, /^w1 的回合出錯了，已退回佇列等別的工作者接手$/);
  assert.equal(r[0].state, '等待中');
  await finish(w2.sessionId);
  await b.waitFor(`document.querySelector('.cluster-queue-row[data-task="0"]')?.dataset.status === 'running'`, { timeout: 12000 });
  r = await rows();
  assert.equal(r[0].worker, 'w2');
  assert.match(r[0].note, /這條已經退回佇列重派過一次/);
  hub.machine.frame(await kidOf(w2.sessionId), 'event.session.work_changed', { busy: false, last_turn_reason: 'failed', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('.cluster-queue-row[data-task="0"]')?.dataset.status === 'failed'`, { timeout: 12000 });
  r = await rows();
  assert.match(r[0].note, /w2 的回合出錯了.*不再重派/);
  assert.equal(r[0].state, '失敗');
  assert.equal(r[2].state, '失敗', 'with no worker left the one behind it fails too');
  assert.match(r[2].note, /沒有可用的工作者/);
  await shot('q06-cluster-queue-failed-1280-light.png');
  hub.machine.autoReply = true;
});

// ------------------------------------------------- a phone, and the dark look

const LOOK = (theme) => b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
async function openLook(hash, { width = 1280, height = 900, theme = 'light' } = {}) {
  await b.size(width, height, width < 700);
  await b.goto(`http://127.0.0.1:${hub.PORT}/#/`, 300);
  await LOOK(theme);
  await page.open(hash);
  await b.sleep(400);
}

test('on a phone (390) the queue, the worker lines and the dialog with the pasted list and the workers box fit the screen: nothing cut off, nothing scrolling sideways, buttons reachable', { skip }, async () => {
  await openLook(`#/cluster/${S.done.id}`, { width: 390, height: 844 });
  await b.waitFor(`document.querySelectorAll('.cluster-queue-row').length === 6`);
  let o = await overflow();
  assert.ok(o.page <= 0 && o.body <= 0, `no sideways scroll: ${JSON.stringify(o)}`);
  assert.deepEqual(o.wide, [], 'nothing sticks out past the right edge');
  // Every row keeps its number, title, state and (where there is one) worker and times inside the list.
  const geometry = await b.eval(`[...document.querySelectorAll('.cluster-queue-row')].map((row) => { const list = row.closest('.cluster-queue-list').getBoundingClientRect(); return [...row.querySelectorAll('.cluster-queue-no, .cluster-queue-title, [data-field="task-status"], [data-field="task-worker"], [data-field="task-times"]')].every((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= list.left - 1 && r.right <= list.right + 1; }); })`);
  assert.deepEqual(geometry, Array(6).fill(true), 'every part of every row is inside the list');
  const title = await b.eval(`(() => { const e = document.querySelector('.cluster-queue-title'); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), clipped: e.scrollWidth > e.clientWidth + 1 }; })()`);
  assert.ok(title.w > 150 && !title.clipped, `a task's name is read whole on a phone: ${JSON.stringify(title)}`);
  const line = await b.eval(`(() => { const e = document.querySelector('.cluster-worker-queue'); const r = e.getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth, h: Math.round(r.height) }; })()`);
  assert.ok(line.inside, 'the worker line is inside the screen');
  await shot('q07-cluster-queue-390-light.png');
  await b.eval(`document.querySelector('.cluster-queue').scrollIntoView()`);
  await shot('q08-cluster-queue-list-390-light.png');

  // The dialog: the pasted list, the workers box, the suggestion.
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  await openLook(`#/s/${parent.id}`, { width: 390, height: 844 });
  await page.typeInto('.composer-input', '/cluster');
  await b.waitFor(`document.querySelector('.slash-menu .slash-item')`);
  await page.press('Enter');
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  await b.sleep(500);
  await page.typeInto('textarea[name="task-lines"]', READONLY.join('\n'));
  await b.click('[data-action="add-lines"]');
  o = await overflow();
  assert.ok(o.page <= 0 && o.body <= 0, `the dialog fits: ${JSON.stringify(o)}`);
  assert.deepEqual(o.wide, []);
  const reach = await b.eval(`(() => { const out = {}; for (const [k, sel] of [['lines', 'textarea[name="task-lines"]'], ['add', '[data-action="add-lines"]'], ['workers', 'input[name="workers"]'], ['submit', '.cluster-dialog button[type="submit"]']]) { const e = document.querySelector(sel); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); out[k] = { inside: r.left >= 0 && r.right <= innerWidth, h: Math.round(r.height), w: Math.round(r.width) }; } return out; })()`);
  for (const [k, v] of Object.entries(reach)) assert.ok(v.inside && v.h >= 24, `${k} can be reached and pressed on a phone: ${JSON.stringify(v)}`);
  await b.eval(`document.querySelector('[data-field="advice"]').scrollIntoView({ block: 'center' })`);
  await shot('q09-dialog-queue-390-light.png');
  await b.eval(`document.querySelector('.cluster-dialog button[type="button"]:not([data-action])')?.click()`);
  await b.size(1280, 900);
});

test('in the dark look the queue and the new lines of the dialog and the worker cards can be read', { skip }, async () => {
  const sels = ['.cluster-queue-no', '.cluster-queue-title', '[data-field="task-status"]', '[data-field="task-worker"]', '[data-field="task-times"]', '.cluster-queue summary .muted', '.cluster-worker-queue', '.cluster-progress'];
  for (const theme of ['dark', 'light']) {
    await openLook(`#/cluster/${S.done.id}`, { theme });
    await b.waitFor(`document.querySelectorAll('.cluster-queue-row').length === 6 && document.querySelector('.cluster-worker-queue')`);
    const bg = await b.eval(`getComputedStyle(document.body).backgroundColor`);
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    if (theme === 'dark') assert.ok(lum(bg) < 0.25, `the page is dark: ${bg}`);
    else assert.ok(lum(bg) > 0.6, `the page is light: ${bg}`);
    for (const sel of sels) {
      const r = await b.eval(`(${CONTRAST_JS})(${JSON.stringify(sel)})`);
      assert.ok(r, `${theme}: ${sel} is on the page`);
      assert.ok(r.ratio >= 4.5, `${theme}: ${sel} contrast ${r.ratio.toFixed(2)} (text ${r.fg} on ${r.bg})`);
    }
    if (theme === 'dark') {
      await shot('q10-cluster-queue-1280-dark.png');
      await b.eval(`document.querySelector('.cluster-queue').scrollIntoView()`);
      await shot('q11-cluster-queue-list-1280-dark.png');
    }
  }
  // The dialog, dark: the suggestion is the one new coloured box.
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  await openLook(`#/s/${parent.id}`, { theme: 'dark' });
  await page.typeInto('.composer-input', '/cluster');
  await b.waitFor(`document.querySelector('.slash-menu .slash-item')`);
  await page.press('Enter');
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  await b.sleep(500);
  await page.typeInto('textarea[name="task-lines"]', READONLY.join('\n'));
  await b.click('[data-action="add-lines"]');
  for (const sel of ['[data-advice="readonly-swarm"] .callout-text', '[data-field="workers-help"]', '[data-field="lines-note"]', '.cluster-count']) {
    const r = await b.eval(`(${CONTRAST_JS})(${JSON.stringify(sel)})`);
    assert.ok(r && r.ratio >= 4.5, `dark dialog: ${sel} contrast ${r?.ratio.toFixed(2)} (text ${r?.fg} on ${r?.bg})`);
  }
  await shot('q12-dialog-queue-1280-dark.png');
  await b.eval(`document.querySelector('.cluster-dialog button[type="button"]:not([data-action])')?.click()`);
  await LOOK('light');
});
