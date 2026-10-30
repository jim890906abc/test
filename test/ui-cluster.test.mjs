// The cluster screens (叢集), in a real browser: where you can start one, what the
// dispatch dialog sends, the cluster page (workers, time breakdown, memory, stop
// and merge), the banner on the main conversation, the tag in the sidebar, and
// that nothing on any of them calls a cluster a Swarm.
//
// The Hub in this branch has no cluster back end, so the page answers the GET
// calls itself (a scripted Hub: window.__fake) and the harness answers the
// calls that change something; what is checked is what the page sends and what
// it shows for what it was told. Skips, saying why, when there is no Chromium.
//
// CLUSTER_UI_SHOTS=<dir> also saves screenshots of every look to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skipReason, uiSession, CONTRAST_JS } from './browser-harness.mjs';
import { FAKE_SCRIPT, rowOf } from './fixtures/cluster-fake.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
let ui;
let b;

// The page's side of a Hub with clusters is test/fixtures/cluster-fake.mjs (FAKE_SCRIPT): GETs answered from window.__fake,
// the sockets kept so a test can push a message down them, summaries given the cluster fields the real Hub will put on them.
const SCRIPT = FAKE_SCRIPT;

before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
  await b.beforeLoad(SCRIPT);
});
after(() => ui?.stop());

// What the page is told next, now and in every page loaded after.
let fakeScript = null;
async function setFake(fake = {}, patch = {}) {
  const data = { online: true, clusters: {}, parents: {}, timing: {}, memory: {}, list: [], ...fake };
  if (fakeScript) await b.removeBeforeLoad(fakeScript);
  const src = `window.__fake = ${JSON.stringify(data)}; window.__patch = ${JSON.stringify(patch)};`;
  fakeScript = await b.beforeLoad(src);
  await b.eval(src);
}

const CID = 'c_0123456789ab';
const T0 = Date.now();
const W = (n, patch = {}) => ({
  sessionId: `s_w${n}`,
  title: `工作者 ${n}：改第 ${n} 區`,
  task: `把第 ${n} 區的登入錯誤訊息改好，並補測試`,
  status: 'running',
  branch: `cluster/${CID}/w${n}`,
  worktree: `/home/user/proj-cluster-${CID}/w${n}`,
  swarm: true,
  progress: `正在改第 ${n} 個檔案`,
  finishedAt: null,
  ...patch,
});
const CLUSTER = (patch = {}) => ({
  id: CID,
  parentId: 's_kimi',
  createdAt: T0 - 120_000,
  status: 'running',
  mode: 'brief',
  isolate: true,
  swarm: true,
  warnings: [],
  workers: [W(1), W(2, { status: 'idle', finishedAt: T0 - 5000, swarm: false }), W(3, { status: 'error', finishedAt: T0 - 1000 })],
  memory: { path: `/home/user/proj/.git/agent-hub-cluster/${CID}/memory.md`, bytes: 120, updatedAt: T0 - 60_000 },
  merge: null,
  ...patch,
});
const TIMING = (patch = {}) => ({ since: T0 - 100_000, turns: 3, wallMs: 100_000, modelMs: 50_000, toolMs: 30_000, compactMs: 0, rateLimitWaitMs: 10_000, requests: 12, http429: 1, subagents: { spawned: 2, requeuedForRateLimit: 0 }, unmeasured: [], ...patch });
const MEMORY = (text = '# 叢集記憶\n\n- 主對話決定：登入頁用 /auth/login') => ({ path: `/home/user/proj/.git/agent-hub-cluster/${CID}/memory.md`, text, bytes: Buffer.byteLength(text), updatedAt: T0 - 60_000 });

const fullFake = (over = {}) => ({
  clusters: { [CID]: CLUSTER() },
  parents: { s_kimi: [CLUSTER()] },
  timing: {
    s_w1: TIMING(),
    s_w2: TIMING({ modelMs: null, toolMs: 4000, compactMs: null, rateLimitWaitMs: 0, wallMs: 20_000, unmeasured: ['modelMs：閘道請求無法對應到這個對話', 'compactMs：Kimi 沒有回報壓縮時間'] }),
    s_w3: { __error: { status: 404, message: 'HTTP 404' } },
  },
  memory: { [CID]: MEMORY() },
  ...over,
});

// --------------------------------------------------------------- page helpers

const typeInto = (selector, value) =>
  b.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const fillTask = (i, title, prompt) =>
  b.eval(`(() => {
    const t = document.querySelectorAll('.cluster-task')[${i}];
    const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set(t.querySelector('input[name="task-title"]'), ${JSON.stringify(title)});
    set(t.querySelector('textarea[name="task-prompt"]'), ${JSON.stringify(prompt)});
  })()`);
const clusterPosts = async () => (await ui.calls()).filter((c) => c.method === 'POST' && /\/cluster$/.test(c.url));
const callsTo = async (re) => (await ui.calls()).filter((c) => c.method === 'POST' && re.test(c.url));
const slashItems = async (q = '/clu') => {
  await b.eval(`(() => { const t = document.querySelector('.composer-input'); t.focus(); t.value = ${JSON.stringify(q)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.sleep(200);
  return b.eval(`[...document.querySelectorAll('.slash-menu .slash-item')].map((i) => ({ name: i.querySelector('.slash-name')?.innerText.trim(), desc: i.title || i.querySelector('.slash-desc')?.innerText }))`);
};
const clearInput = () => b.eval(`(() => { const t = document.querySelector('.composer-input'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const openTitleMenu = async () => {
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.waitFor(`document.querySelector('.toolbar button[aria-label="更多"]')`);
  await b.click('.toolbar button[aria-label="更多"]');
  await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
  return b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].map((i) => ({ label: i.innerText.trim(), disabled: i.getAttribute('aria-disabled') === 'true' }))`);
};
const pressMenu = (label) => b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.includes(${JSON.stringify(label)}))?.click()`);
async function openDialog(id = 's_kimi') {
  await ui.openApp(`#/s/${id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await openTitleMenu();
  await pressMenu('叢集派工');
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
}
const dialogText = () => b.eval(`document.querySelector('.cluster-dialog')?.innerText ?? ''`);
const submitButton = () => b.eval(`(() => { const e = document.querySelector('.cluster-dialog button[type="submit"]'); return e ? { text: e.innerText.trim(), disabled: e.disabled } : null; })()`);
const pageText = () => b.eval(`document.querySelector('.cluster-page')?.innerText ?? ''`);
async function openPage(fake = fullFake(), cid = CID) {
  await setFake(fake);
  await ui.openApp(`#/cluster/${cid}`);
  await b.waitFor(`document.querySelector('.cluster-page .cluster-worker') || document.querySelector('.cluster-page .cluster-none')`);
  // The folded parts (the task queue, the memory) are closed on a fresh page; a person opens what they want to read, and these tests read them.
  await b.eval(`document.querySelectorAll('details.cluster-fold').forEach((d) => d.setAttribute('open', ''))`);
}
// A worker's drawer: the whole task, where it works, its time. Opened by pressing its tile, shut by the scrim.
async function openDrawerOf(sid) {
  await b.click(`.cluster-worker[data-session="${sid}"]`);
  await b.waitFor(`document.querySelector('.cluster-drawer.on')`);
  await b.sleep(200);
}
async function closeDrawer() {
  await b.eval(`document.querySelector('.cd-scrim')?.click()`);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
}
const confirmLast = () => b.click('.dialog .dialog-actions .om-btn:last-child');

// ------------------------------------------------------------- entry points

test('/cluster and 叢集派工… are offered in a Kimi and a DeepSeek conversation, not in a Claude one or on the home screen', { skip }, async () => {
  await setFake();
  for (const id of ['s_kimi', 's_ds']) {
    await ui.openApp(`#/s/${id}`);
    await b.waitFor(`document.querySelector('.composer-input')`);
    const items = await slashItems();
    const cmd = items.find((i) => i.name?.startsWith('/cluster'));
    assert.ok(cmd, `${id}: /cluster is in the slash menu: ${JSON.stringify(items)}`);
    assert.match(cmd.desc, /工作者/, 'says what it does');
    assert.doesNotMatch(cmd.desc, /Swarm|子代理群/, 'and does not call it a swarm');
    await clearInput();
    const menu = await openTitleMenu();
    const entry = menu.find((m) => m.label.includes('叢集派工'));
    assert.ok(entry, `${id}: the … menu has 叢集派工…: ${JSON.stringify(menu)}`);
    assert.equal(entry.disabled, false);
    assert.match(entry.label, /\/cluster/, 'and shows the command');
    await b.eval(`document.querySelector('.om-menu')?.remove()`);
  }

  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.deepEqual((await slashItems()).filter((i) => /cluster/.test(i.name || '')), [], 'a Claude conversation has no /cluster');
  await clearInput();
  assert.ok(!(await openTitleMenu()).some((m) => /叢集/.test(m.label)), 'and no 叢集 in its … menu');
  await b.eval(`document.querySelector('.om-menu')?.remove()`);

  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.deepEqual((await slashItems()).filter((i) => /cluster/.test(i.name || '')), [], 'the home screen has no conversation to dispatch from');
  await clearInput();
});

test('with the computer off, the menu item is greyed out and /cluster says why instead of opening a dialog', { skip }, async () => {
  await setFake({ online: false });
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  const entry = (await openTitleMenu()).find((m) => m.label.includes('叢集派工'));
  assert.ok(entry, 'it is shown');
  assert.equal(entry.disabled, true, '但不能按');
  await pressMenu('叢集派工');
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.eval(`(() => { const t = document.querySelector('.composer-input'); t.focus(); t.value = '/cluster'; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await b.waitFor(`document.body.innerText.includes('離線')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false);
});

// ------------------------------------------------------------ dispatch dialog

test('the dialog starts as the spec says and sends exactly spec §2: tasks, mode, isolate, swarm, workers', { skip }, async () => {
  await setFake();
  await openDialog();
  await ui.clearCalls();
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-task').length`), 1, 'one empty task to start');
  assert.equal(await b.eval(`document.querySelector('[data-field="mode"] [aria-pressed="true"]').innerText.trim()`), '簡報起跑（建議）');
  assert.equal(await b.eval(`document.querySelector('input[name="isolate"]').checked`), true);
  assert.equal(await b.eval(`document.querySelector('input[name="swarm"]').checked`), true);
  assert.deepEqual(await submitButton(), { text: '派出 1 個工作者', disabled: true }, 'nothing to send while the task says nothing');

  await b.click('[data-action="add-task"]');
  await fillTask(0, '修登入', '把登入頁的錯誤訊息改好');
  await fillTask(1, '', '掃描所有路由，列出沒有權限檢查的');
  assert.deepEqual(await submitButton(), { text: '派出 2 個工作者', disabled: false });

  const c = CLUSTER({ workers: [W(1), W(2)] });
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: c, warnings: ['不是 git 專案，工作者共用同一個資料夾，可能互相覆蓋'] });
  await setFake({ clusters: { [CID]: c }, parents: { s_kimi: [c] }, timing: { s_w1: TIMING(), s_w2: TIMING() }, memory: { [CID]: MEMORY() } });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`location.hash === '#/cluster/${CID}'`);
  const posts = await clusterPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/sessions/s_kimi/cluster');
  assert.deepEqual(posts[0].body, {
    tasks: [
      { title: '修登入', prompt: '把登入頁的錯誤訊息改好' },
      { title: '掃描所有路由，列出沒有權限檢查的', prompt: '掃描所有路由，列出沒有權限檢查的' },
    ],
    mode: 'brief',
    isolate: true,
    swarm: true,
    workers: 2,
  });
  await b.waitFor(`document.body.innerText.includes('不是 git 專案')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false, 'the dialog is gone');
  // The page drew the cluster it was just given at once; the memory and the time are read all the same.
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('主對話決定')`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
});

test('Enter in a task name goes on to its content; it does not send the dispatch', { skip }, async () => {
  await setFake();
  await openDialog();
  await ui.clearCalls();
  await fillTask(0, 'A', 'do a'); // everything needed to send is there
  await b.eval(`document.querySelector('input[name="task-title"]').focus()`);
  // A real key press (not a script's event): the one that makes a browser submit a form from a text box.
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await b.sleep(400);
  assert.equal((await clusterPosts()).length, 0, 'nothing was sent');
  assert.equal(await b.eval(`document.activeElement?.getAttribute('name')`), 'task-prompt', 'the cursor moved to the task\'s content');
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), true);
});

test('every choice reaches the body: fork, no worktrees, Kimi\'s own swarm mode off, a note for everyone', { skip }, async () => {
  await setFake();
  await openDialog('s_ds');
  await ui.clearCalls();
  await fillTask(0, 'A', 'do a');
  await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
  await b.click('input[name="isolate"]');
  await b.click('input[name="swarm"]');
  await typeInto('textarea[name="note"]', '  先讀 README，再動手  ');
  await ui.answer('POST', '/api/sessions/s_ds/cluster', 200, { cluster: CLUSTER({ parentId: 's_ds' }), warnings: [] });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`window.__calls.some((c) => /\\/cluster$/.test(c.url))`);
  const [post] = await clusterPosts();
  assert.equal(post.url, '/api/sessions/s_ds/cluster', 'for THIS conversation');
  assert.deepEqual(post.body, { tasks: [{ title: 'A', prompt: 'do a' }], mode: 'fork', isolate: false, swarm: false, workers: 1, note: '先讀 README，再動手' });
  await ui.stopAnswering();
});

test('1 to 64 tasks: the last one cannot be removed, a 65th cannot be added, and a task with nothing in it is not sent', { skip }, async () => {
  await setFake();
  await openDialog();
  await ui.clearCalls();
  const state = () => b.eval(`({ n: document.querySelectorAll('.cluster-task').length, addDisabled: document.querySelector('[data-action="add-task"]').disabled, removeDisabled: [...document.querySelectorAll('[data-action="remove-task"]')].map((x) => x.disabled), count: document.querySelector('.cluster-count')?.innerText.trim() })`);
  let s = await state();
  assert.deepEqual([s.n, s.addDisabled, s.removeDisabled, s.count], [1, false, [true], '1 / 64']);
  for (let i = 1; i < 64; i++) await b.click('[data-action="add-task"]');
  s = await state();
  assert.deepEqual([s.n, s.addDisabled, s.count], [64, true, '64 / 64'], 'sixty-four is the most');
  assert.ok(s.removeDisabled.every((d) => d === false));
  // Task 3 is removed: the numbering closes up.
  await fillTask(2, 'gone', 'x');
  await b.eval(`document.querySelectorAll('[data-action="remove-task"]')[2].click()`);
  s = await state();
  assert.equal(s.n, 63);
  assert.equal(await b.eval(`[...document.querySelectorAll('.cluster-task')].map((t) => t.querySelector('.cluster-task-no').innerText.trim()).join()`), Array.from({ length: 63 }, (_, i) => `任務 ${i + 1}`).join());
  assert.equal(await b.eval(`[...document.querySelectorAll('.cluster-task input[name="task-title"]')].some((i) => i.value === 'gone')`), false);
  // Only the first has something to do: the form refuses, says which, and sends nothing.
  await fillTask(0, 'one', 'do one');
  const sub = await submitButton();
  assert.equal(sub.disabled, true);
  assert.match(await dialogText(), /任務 2 還沒寫要做什麼/);
  await b.eval(`document.querySelector('.cluster-dialog').requestSubmit?.()`);
  await b.sleep(200);
  assert.equal((await clusterPosts()).length, 0);
});

test('a refusal from the Hub is shown in the dialog, nothing is opened, and the same press works again', { skip }, async () => {
  await setFake();
  await openDialog();
  await ui.clearCalls();
  await fillTask(0, 'A', 'do a');
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 409, { error: '那台電腦離線，現在不能開工作者' });
  // Two presses back to back: only one request.
  await b.eval(`(() => { const e = document.querySelector('.cluster-dialog button[type="submit"]'); e.click(); e.click(); })()`);
  await b.waitFor(`document.querySelector('.cluster-dialog .cluster-error')?.innerText.includes('那台電腦離線')`);
  assert.equal((await clusterPosts()).length, 1, '連按兩次只送一次');
  assert.equal(await b.eval('location.hash'), '#/s/s_kimi');
  assert.equal(await b.eval(`document.querySelector('.cluster-task input[name="task-title"]').value`), 'A', 'what was typed is still there');
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`window.__calls.filter((c) => /\\/cluster$/.test(c.url)).length === 2`);
  await ui.stopAnswering();
});

test('before sending, the dialog says when a fork would be heavy and when the workers would share a folder', { skip }, async () => {
  // The conversation is at 83% of its context (the Hub's own figure on its summary).
  await setFake({}, { s_kimi: { meta: { model: 'kimi-k2', machineName: 'box', context: { used: 830_000, size: 1_000_000 } } } });
  await openDialog();
  const warns = () => b.eval(`[...document.querySelectorAll('.cluster-dialog .cluster-warn')].map((w) => w.innerText.trim())`);
  assert.deepEqual(await warns(), [], 'brief start with a worktree each: nothing to warn about');
  await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
  let w = await warns();
  assert.equal(w.length, 1);
  assert.match(w[0], /83%/);
  assert.match(w[0], /簡報起跑/);
  await b.click('input[name="isolate"]');
  w = await warns();
  assert.equal(w.length, 2);
  assert.match(w.join(), /同一個資料夾/);
  await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('簡報起跑')).click()`);
  w = await warns();
  assert.equal(w.length, 1, 'brief again: only the folder one is left');
  assert.match(w[0], /同一個資料夾/);
  // The recommended way is the one marked as such.
  assert.match(await dialogText(), /簡報起跑（建議）/);
});

test('the switch for Kimi\'s own swarm mode says in so many words that it is Kimi\'s own, and the cluster is not one', { skip }, async () => {
  await setFake();
  await openDialog();
  const row = await b.eval(`(() => { const r = document.querySelector('.cluster-dialog [data-native-swarm]'); return r ? { text: r.innerText, checked: r.querySelector('input').checked } : null; })()`);
  assert.ok(row, 'the swarm switch row is marked');
  assert.match(row.text, /Kimi 原生/);
  assert.match(row.text, /Swarm/);
  assert.match(row.text, /叢集本身不是 Swarm/, 'and that the cluster is not a swarm');
  assert.equal(row.checked, true);
});

test('dispatching takes seconds (the workers are opened before the Hub answers): the dialog says so, locks, and a second press sends nothing', { skip }, async () => {
  await setFake();
  await openDialog();
  await ui.clearCalls();
  await fillTask(0, 'A', 'do a');
  const c = CLUSTER({ workers: [W(1)] });
  await setFake({ clusters: { [CID]: c }, parents: { s_kimi: [c] }, timing: { s_w1: TIMING() }, memory: { [CID]: MEMORY() } });
  await b.eval(`window.__postDelay = { prefix: '/api/sessions/s_kimi/cluster', ms: 1500 }`);
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: c, warnings: [] });
  await b.eval(`(() => { const e = document.querySelector('.cluster-dialog button[type="submit"]'); e.click(); e.click(); })()`);
  const waiting = await b.eval(`(() => ({
    submit: document.querySelector('.cluster-dialog button[type="submit"]').innerText.trim(),
    submitDisabled: document.querySelector('.cluster-dialog button[type="submit"]').disabled,
    note: document.querySelector('.cluster-sending')?.innerText.trim(),
    noteShown: document.querySelector('.cluster-sending')?.getClientRects().length > 0,
    spinner: Boolean(document.querySelector('.cluster-sending .spinner')),
    fieldsLocked: document.querySelector('.cluster-fields').disabled,
    typedLocked: document.querySelector('.cluster-task textarea').matches(':disabled'),
  }))()`);
  if (SHOTS) {
    await b.sleep(450); // the dialog's own fade-in is over
    await b.shot(path.join(SHOTS, 'dialog-sending-1280-light.png'));
  }
  assert.equal(waiting.submit, '派工中…');
  assert.equal(waiting.submitDisabled, true);
  assert.equal(waiting.noteShown, true, 'the waiting note is on the screen');
  assert.match(waiting.note, /正在開工作者對話/);
  assert.match(waiting.note, /幾秒/);
  assert.equal(waiting.spinner, true);
  assert.deepEqual([waiting.fieldsLocked, waiting.typedLocked], [true, true], 'what was typed cannot be changed while it is on its way');
  await b.click('.cluster-dialog button[type="submit"]');
  assert.equal((await b.eval(`window.__posts.filter((p) => /\\/cluster$/.test(p)).length`)), 1, 'two presses, one request');
  await b.waitFor(`location.hash === '#/cluster/${CID}'`);
  await ui.stopAnswering();
});

test('a dialog closed while the workers are being made still tells you the cluster exists, and offers to go to it', { skip }, async () => {
  await setFake();
  await openDialog();
  await fillTask(0, 'A', 'do a');
  const c = CLUSTER({ workers: [W(1)] });
  await setFake({ clusters: { [CID]: c }, parents: { s_kimi: [c] }, timing: { s_w1: TIMING() }, memory: { [CID]: MEMORY() } });
  await b.eval(`window.__postDelay = { prefix: '/api/sessions/s_kimi/cluster', ms: 1200 }`);
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: c, warnings: [] });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false, 'the person closed it');
  await b.waitFor(`document.querySelector('.toast')?.innerText.includes('叢集已建立')`);
  assert.equal(await b.eval('location.hash'), '#/s/s_kimi', 'and is not taken somewhere they did not ask to go');
  await b.eval(`[...document.querySelectorAll('.toast button')].find((x) => x.innerText.includes('查看'))?.click()`);
  await b.waitFor(`location.hash === '#/cluster/${CID}'`);
  await ui.stopAnswering();
});

test('several warnings from the Hub are all on the cluster page; the toast says how many instead of stacking them', { skip }, async () => {
  const warnings = ['主對話資料夾有未 commit 的修改，worktree 看不到', '這台電腦的 Kimi 開不起原生 Swarm 模式，工作者沒有開', '路徑含點目錄，改為共用同一個資料夾'];
  const c = CLUSTER({ workers: [W(1)], isolate: false, warnings: [] });
  await setFake();
  await openDialog();
  await fillTask(0, 'A', 'do a');
  await setFake({ clusters: { [CID]: { ...c, warnings } }, parents: { s_kimi: [c] }, timing: { s_w1: TIMING() }, memory: { [CID]: MEMORY() } });
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: c, warnings });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`location.hash === '#/cluster/${CID}'`);
  await b.waitFor(`document.querySelectorAll('.cluster-page .cluster-warn').length === 3`);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-page .cluster-warn')].map((w) => w.innerText.trim())`), warnings);
  assert.equal(await b.eval(`[...document.querySelectorAll('.toast')].filter((t) => /則警告/.test(t.innerText)).length`), 1, 'one toast');
  assert.equal(await b.eval(`[...document.querySelectorAll('.toast')].filter((t) => t.innerText.includes('未 commit')).length`), 0, 'not one toast per warning');
  assert.match(await pageText(), /共用同一個資料夾/, 'the cluster says what it really got (isolate: false)');
  await ui.stopAnswering();
});

test('a full fork needs the main conversation idle: the dialog says so while it is working', { skip }, async () => {
  await setFake({}, { s_kimi: { status: 'running' } });
  await openDialog();
  const warns = () => b.eval(`[...document.querySelectorAll('.cluster-dialog .cluster-warn')].map((w) => w.innerText.trim())`);
  assert.deepEqual(await warns(), [], 'a brief start does not need it idle');
  await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
  const w = await warns();
  assert.equal(w.length, 1);
  assert.match(w[0], /正在工作/);
  assert.match(w[0], /閒下來/);
});

// -------------------------------------------------------------- cluster page

test('the cluster page shows the cluster, every worker, and how far it is: the tile says little, the drawer the rest', { skip }, async () => {
  await openPage();
  const t = await pageText();
  assert.match(t, /進行中/, 'the cluster status');
  assert.match(t, /1\/3 完成/, 'one worker has finished');
  assert.match(t, /簡報起跑/);
  const tiles = await b.eval(`[...document.querySelectorAll('.cluster-worker')].map((w) => ({
    session: w.dataset.session,
    title: w.querySelector('.cluster-worker-title').innerText.trim(),
    state: w.querySelector('.cluster-worker-state').innerText.trim(),
    long: Boolean(w.querySelector('.cluster-worker-task, [data-field="branch"], [data-field="worktree"], .cluster-timing')),
  }))`);
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles.map((w) => w.session), ['s_w1', 's_w2', 's_w3']);
  assert.deepEqual(tiles.map((w) => w.state), ['執行中', '已完成', '出錯']);
  assert.equal(tiles[0].title, '工作者 1：改第 1 區');
  assert.deepEqual(tiles.map((w) => w.long), [false, false, false], 'nothing long on a tile');
  // The drawer: the whole of it.
  const inDrawer = async (sid) => {
    await openDrawerOf(sid);
    const r = await b.eval(`(() => { const d = document.querySelector('.cluster-drawer'); const q = (s) => d.querySelector(s)?.innerText.trim(); return {
      task: q('[data-field="task"]'), branch: q('[data-field="branch"]'), worktree: q('[data-field="worktree"]'), swarm: q('[data-native-swarm]'), progress: q('[data-field="progress"]'),
      open: d.querySelector('a[data-action="open-worker"]')?.getAttribute('href') }; })()`);
    await closeDrawer();
    return r;
  };
  const w1 = await inDrawer('s_w1');
  assert.equal(w1.task, '把第 1 區的登入錯誤訊息改好，並補測試');
  assert.equal(w1.branch, `cluster/${CID}/w1`);
  assert.equal(w1.worktree, `/home/user/proj-cluster-${CID}/w1`);
  assert.match(w1.swarm, /原生 Swarm.*開/);
  assert.equal(w1.progress, '正在改第 1 個檔案');
  assert.equal(w1.open, '#/s/s_w1');
  assert.match((await inDrawer('s_w2')).swarm, /原生 Swarm.*關/);
  // The way back.
  assert.equal(await b.eval(`document.querySelector('[data-action="open-parent"]').getAttribute('href')`), '#/s/s_kimi');
});

test('the time breakdown draws what was reported at its reported share, and says 量不到 with the Hub\'s reason for what was not', { skip }, async () => {
  await openPage();
  // The time breakdown is in the worker's drawer, asked for when it opens.
  const card = () => '.cluster-drawer';
  await openDrawerOf('s_w1');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing')`);
  // Worker 1: everything reported, against a 100 s total.
  const w1 = await b.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(card('s_w1'))});
    const seg = (k) => { const e = c.querySelector('[data-seg="' + k + '"]'); return e ? parseFloat(e.style.width) : null; };
    return { model: seg('modelMs'), tool: seg('toolMs'), wait: seg('rateLimitWaitMs'), compact: seg('compactMs'),
      legend: Object.fromEntries([...c.querySelectorAll('[data-part]')].filter((e) => e.tagName === 'LI').map((e) => [e.dataset.part, e.innerText.replace(/\\s+/g, ' ').trim()])),
      total: c.querySelector('.cluster-timing-total').innerText.replace(/\\s+/g, ' ').trim(),
      facts: c.querySelector('.cluster-timing-facts')?.innerText.replace(/\\s+/g, ' ').trim() };
  })()`);
  assert.equal(w1.model, 50);
  assert.equal(w1.tool, 30);
  assert.equal(w1.wait, 10);
  assert.ok(!w1.compact, 'a part that is 0 has no width');
  assert.match(w1.legend.modelMs, /模型.*50\.0 秒/);
  assert.match(w1.legend.toolMs, /工具.*30\.0 秒/);
  assert.match(w1.legend.rateLimitWaitMs, /等限流.*10\.0 秒/);
  assert.match(w1.legend.compactMs, /壓縮.*0 秒/);
  assert.match(w1.total, /總時間.*1 分 40 秒/);
  assert.match(w1.facts, /回合 3/);
  assert.match(w1.facts, /429 次數 1/);
  await closeDrawer();

  // Worker 2: the model time and the compaction time could not be measured.
  await openDrawerOf('s_w2');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing')`);
  const w2 = await b.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(card('s_w2'))});
    return { segs: [...c.querySelectorAll('[data-seg]')].map((e) => [e.dataset.seg, parseFloat(e.style.width)]),
      model: c.querySelector('li[data-part="modelMs"]').innerText.replace(/\\s+/g, ' ').trim(),
      compact: c.querySelector('li[data-part="compactMs"]').innerText.replace(/\\s+/g, ' ').trim(),
      reasons: [...c.querySelectorAll('.cluster-reason')].map((e) => [e.dataset.part, e.innerText.trim()]),
      tool: c.querySelector('li[data-part="toolMs"]').innerText.replace(/\\s+/g, ' ').trim() };
  })()`);
  assert.deepEqual(w2.segs, [['toolMs', 20]], 'only the measured part is drawn, 4 s of 20 s');
  assert.match(w2.model, /模型.*量不到/);
  assert.match(w2.compact, /壓縮.*量不到/);
  assert.match(w2.tool, /工具.*4\.0 秒/);
  assert.deepEqual(w2.reasons, [['modelMs', '模型：閘道請求無法對應到這個對話'], ['compactMs', '壓縮：Kimi 沒有回報壓縮時間']], 'each reason is the Hub\'s own words, under the name of the part it is about');

  await closeDrawer();
  // Worker 3: the timing call itself failed.
  await openDrawerOf('s_w3');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing-failed')`);
  const w3 = await b.eval(`(() => { const c = document.querySelector(${JSON.stringify(card('s_w3'))}); return { failed: c.querySelector('.cluster-timing-failed')?.innerText.trim(), segs: c.querySelectorAll('[data-seg]').length }; })()`);
  assert.match(w3.failed, /量不到/);
  assert.match(w3.failed, /HTTP 404/);
  assert.equal(w3.segs, 0);
  await closeDrawer();
});

test('without a total from the Hub, the total says 量不到 and why, and the parts are drawn against each other, not against a made-up whole', { skip }, async () => {
  const one = CLUSTER({ workers: [W(1)] });
  await openPage(fullFake({ clusters: { [CID]: one }, timing: { s_w1: TIMING({ wallMs: null, modelMs: 6000, toolMs: 2000, rateLimitWaitMs: 2000, compactMs: 0, unmeasured: ['wallMs：這個對話沒有開始時間'] }) } }));
  await openDrawerOf('s_w1');
  await b.waitFor(`document.querySelector('.cluster-timing-total')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-timing-total').innerText.trim()`), '總時間 量不到');
  assert.equal(await b.eval(`document.querySelector('.cluster-reason[data-part="wallMs"]').innerText.trim()`), '總時間：這個對話沒有開始時間');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('[data-seg]')].map((e) => [e.dataset.seg, parseFloat(e.style.width)])`), [['modelMs', 60], ['toolMs', 20], ['rateLimitWaitMs', 20]]);
});

test('the time is read again while the cluster runs, and no longer once the page is left', { skip }, async () => {
  const one = CLUSTER({ workers: [W(1)] });
  await openPage(fullFake({ clusters: { [CID]: one }, timing: { s_w1: TIMING() } }));
  await openDrawerOf('s_w1');
  await b.waitFor(`document.querySelector('li[data-part="modelMs"]')?.innerText.includes('50.0 秒')`);
  // The model time moves on (the Hub's answer changes); the page picks it up by itself.
  await b.eval(`window.__fake.timing.s_w1 = ${JSON.stringify(TIMING({ modelMs: 70_000, wallMs: 120_000 }))}`);
  await b.waitFor(`document.querySelector('li[data-part="modelMs"]')?.innerText.includes('1 分 10 秒')`, { timeout: 14_000, label: 'the time is read again' });
  // Leave: from here on nothing asks for it.
  await b.eval(`location.hash = '#/s/s_kimi'`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  const asked = () => b.eval(`window.__gets.filter((u) => /\\/timing$/.test(u)).length`);
  const before = await asked();
  await b.sleep(11_500);
  assert.equal(await asked(), before, 'the page that was left stopped reading');
});

test('the page never makes a number up: every figure in a drawer is one the Hub sent', { skip }, async () => {
  // Distinctive figures, so that a sum or a difference would show.
  const t = TIMING({ wallMs: 123_000, modelMs: 41_000, toolMs: 17_000, rateLimitWaitMs: 5000, compactMs: 3000, turns: 7, requests: 19, http429: 2 });
  await openPage(fullFake({ timing: { s_w1: t, s_w2: t, s_w3: t } }));
  await openDrawerOf('s_w1');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing-total')`);
  const shown = await b.eval(`[...document.querySelector('.cluster-drawer .cluster-timing').innerText.matchAll(/\\d+(?:\\.\\d+)?/g)].map((m) => m[0])`);
  // 123 s = 2 分 3 秒; 41 s; 17 s; 5 s; 3 s; 7 turns; 19 requests; 2 x 429; 2 subagents; 0 requeued - and nothing else (no 123 - 66 = 57 s "other").
  assert.deepEqual([...new Set(shown)].sort(), ['0', '17.0', '19', '2', '3', '3.0', '41.0', '429', '5.0', '7'].sort());
});

test('the cluster memory is read from the Hub and a decision can be added to it', { skip }, async () => {
  await openPage();
  await b.waitFor(`document.querySelector('.cluster-memory-text')`);
  assert.match(await b.eval(`document.querySelector('.cluster-memory-text').innerText`), /主對話決定：登入頁用 \/auth\/login/);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-path').innerText.trim()`), `/home/user/proj/.git/agent-hub-cluster/${CID}/memory.md`);
  assert.equal(await b.eval(`document.querySelector('button[data-action="add-memory"]').disabled`), true, 'nothing to add yet');

  await ui.clearCalls();
  await ui.answer('POST', `/api/clusters/${CID}/memory`, 200, MEMORY('# 叢集記憶\n\n- 主對話決定：登入頁用 /auth/login\n\n## 主對話決定（10:42）\n\n改用 cookie，不用 token'));
  await typeInto('textarea[name="decision"]', '  改用 cookie，不用 token  ');
  assert.equal(await b.eval(`document.querySelector('button[data-action="add-memory"]').disabled`), false);
  await b.click('button[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').innerText.includes('改用 cookie')`);
  const posts = await callsTo(/\/memory$/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `/api/clusters/${CID}/memory`);
  assert.deepEqual(posts[0].body, { text: '改用 cookie，不用 token' });
  assert.equal(await b.eval(`document.querySelector('textarea[name="decision"]').value`), '', 'the box is emptied once it is in');
  await ui.stopAnswering();

  // The computer is off: the Hub says 409, and so does the page, where the memory would be.
  await ui.answer('POST', `/api/clusters/${CID}/memory`, 409, { error: '那台電腦離線，寫不進叢集記憶' });
  await typeInto('textarea[name="decision"]', '另一條');
  await b.click('button[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory .cluster-error')?.innerText.includes('那台電腦離線')`);
  assert.equal(await b.eval(`document.querySelector('textarea[name="decision"]').value`), '另一條', 'and what was typed is kept');
  await ui.stopAnswering();
});

test('memory that cannot be read says why where it would be, and the rest of the page still works', { skip }, async () => {
  await openPage(fullFake({ memory: { [CID]: { __error: { status: 409, message: '那台電腦離線，讀不到叢集記憶' } } } }));
  await b.waitFor(`document.querySelector('.cluster-memory-none')`);
  assert.match(await b.eval(`document.querySelector('.cluster-memory-none').innerText`), /讀不到叢集記憶：那台電腦離線/);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 3);
});

test('全部停止 asks first, then stops THIS cluster; it cannot be pressed once the cluster is over', { skip }, async () => {
  await openPage();
  await ui.clearCalls();
  await ui.answer('POST', `/api/clusters/${CID}/stop`, 200, { cluster: CLUSTER({ status: 'stopped' }) });
  await b.click('[data-action="stop"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  assert.match(await b.eval(`document.querySelector('.dialog').innerText`), /對話、分支與 worktree 都會保留/);
  assert.equal((await callsTo(/\/stop$/)).length, 0, 'nothing is sent before the answer');
  await confirmLast();
  await b.waitFor(`window.__calls.some((c) => /\\/stop$/.test(c.url))`);
  const stops = await callsTo(/\/stop$/);
  assert.deepEqual(stops.map((c) => [c.url, c.body]), [[`/api/clusters/${CID}/stop`, {}]]);
  await b.waitFor(`document.querySelector('[data-action="stop"]').disabled`);
  assert.match(await pageText(), /已停止/, 'the answer is drawn');
  await ui.stopAnswering();

  // Cancelling the confirmation sends nothing.
  await openPage();
  await ui.clearCalls();
  await b.click('[data-action="stop"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  await b.click('.dialog .dialog-actions .om-btn:first-child');
  await b.sleep(200);
  assert.equal((await callsTo(/\/stop$/)).length, 0);
});

test('合併 asks first and then merges THIS cluster; the result shows what went in and which files clashed', { skip }, async () => {
  await openPage();
  await ui.clearCalls();
  const merged = CLUSTER({
    status: 'done',
    merge: {
      branch: `cluster/${CID}/merged`,
      at: T0,
      results: [
        { sessionId: 's_w1', branch: `cluster/${CID}/w1`, ok: true, conflicts: [] },
        { sessionId: 's_w2', branch: `cluster/${CID}/w2`, ok: false, conflicts: ['src/auth/login.js', 'src/auth/session.js'] },
        { sessionId: 's_w3', branch: `cluster/${CID}/w3`, ok: true, conflicts: [] },
      ],
    },
  });
  await ui.answer('POST', `/api/clusters/${CID}/merge`, 200, { cluster: merged });
  assert.equal(await b.eval(`document.querySelector('.cluster-merge')`), null, 'no result yet');
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  const ask = await b.eval(`document.querySelector('.dialog').innerText`);
  assert.match(ask, new RegExp(`cluster/${CID}/merged`));
  assert.match(ask, /不動主對話正在用的分支與工作樹/);
  assert.match(ask, /已 commit/, 'says that only what is committed on the branches goes in');
  await confirmLast();
  await b.waitFor(`document.querySelector('.cluster-merge')`);
  assert.deepEqual((await callsTo(/\/merge$/)).map((c) => [c.url, c.body]), [[`/api/clusters/${CID}/merge`, {}]]);
  const res = await b.eval(`(() => ({
    branch: document.querySelector('.cluster-merge [data-field="merge-branch"]').innerText.trim(),
    rows: [...document.querySelectorAll('.cluster-merge li[data-session]')].map((li) => ({ session: li.dataset.session, ok: li.dataset.ok, text: li.innerText.replace(/\\s+/g, ' ').trim() })),
  }))()`);
  assert.equal(res.branch, `cluster/${CID}/merged`);
  assert.deepEqual(res.rows.map((r) => [r.session, r.ok]), [['s_w1', 'true'], ['s_w2', 'false'], ['s_w3', 'true']]);
  assert.match(res.rows[0].text, /已合併/);
  assert.match(res.rows[1].text, /衝突/);
  assert.match(res.rows[1].text, /src\/auth\/login\.js/);
  assert.match(res.rows[1].text, /src\/auth\/session\.js/);
  await ui.stopAnswering();
});

test('合併 is not offered when the workers had no worktrees of their own, and says why; a merge the Hub refuses is shown', { skip }, async () => {
  await openPage(fullFake({ clusters: { [CID]: CLUSTER({ isolate: false, warnings: ['不是 git 專案，工作者共用同一個資料夾，可能互相覆蓋'], workers: [W(1, { branch: null, worktree: null }), W(2, { branch: null, worktree: null })] }) } }));
  const merge = await b.eval(`(() => { const e = document.querySelector('[data-action="merge"]'); return { disabled: e.disabled, title: e.title }; })()`);
  assert.equal(merge.disabled, true);
  assert.match(merge.title, /沒有獨立 worktree/);
  assert.match(await pageText(), /不是 git 專案/, 'the Hub\'s warning is on the page');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker [data-field="branch"]').length`), 0, 'no branch to show');

  await openPage();
  await ui.clearCalls();
  await ui.answer('POST', `/api/clusters/${CID}/merge`, 409, { error: '主對話的資料夾不是 git 專案' });
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  await confirmLast();
  await b.waitFor(`document.body.innerText.includes('主對話的資料夾不是 git 專案')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-merge')`), null);
  await ui.stopAnswering();
});

test('a worker whose conversation was deleted says so, has nothing to open, and its time is not asked for', { skip }, async () => {
  const c = CLUSTER({ workers: [W(1), W(2, { status: 'deleted', finishedAt: T0 - 5000, progress: '' }), W(3, { status: 'idle', finishedAt: T0 - 1000 })] });
  await openPage(fullFake({ clusters: { [CID]: c } }));
  await openDrawerOf('s_w2');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing-failed')`);
  const card = await b.eval(`(() => { const c = document.querySelector('.cluster-drawer'); const tile = document.querySelector('.cluster-worker[data-session="s_w2"]'); const link = c.querySelector('[data-action="open-worker"]'); return { state: tile.querySelector('.cluster-worker-state').innerText.trim(), open: Boolean(link && !link.hidden), timing: c.querySelector('.cluster-timing-failed')?.innerText.trim() }; })()`);
  await closeDrawer();
  assert.equal(card.state, '已刪除');
  assert.equal(card.open, false, 'there is no conversation to open');
  assert.match(card.timing, /量不到.*刪除/);
  assert.ok(!(await b.eval(`window.__gets`)).includes('/api/sessions/s_w2/timing'), 'nothing was asked about a conversation that is gone');
  if (SHOTS) await b.shot(path.join(SHOTS, 'page-deleted-worker-1280-light.png'));
  const head = await b.eval(`document.querySelector('.cluster-head').innerText.replace(/\\s+/g, ' ')`);
  assert.match(head, /1\/3 完成/, 'it is not counted as 完成');
  assert.match(head, /1 個已刪除/);
});

test('a memory file the Hub only sent the end of says so', { skip }, async () => {
  await openPage(fullFake({ memory: { [CID]: { ...MEMORY('…最後一段的內容'), bytes: 250_000, truncated: true, from: 160_000 } } }));
  await b.waitFor(`document.querySelector('.cluster-memory-truncated')`);
  const note = await b.eval(`document.querySelector('.cluster-memory-truncated').innerText.trim()`);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-truncated').getClientRects().length > 0`), true, 'and it is on the screen, not just in the page');
  assert.match(note, /只顯示最後一段/);
  assert.match(note, /160000/);
  assert.match(note, /250\.0 KB/);
  // And a complete one does not say it.
  await openPage(fullFake());
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.innerText.includes('登入頁')`);
  assert.equal(await b.eval(`getComputedStyle(document.querySelector('.cluster-memory-truncated')).display`), 'none');
});

test('the box for a decision stops at the 20,000 characters the Hub takes, and a refusal from the Hub is shown', { skip }, async () => {
  await openPage();
  await b.waitFor(`document.querySelector('.cluster-memory-text')`);
  assert.equal(await b.eval(`document.querySelector('textarea[name="decision"]').maxLength`), 20000);
  await ui.answer('POST', `/api/clusters/${CID}/memory`, 400, { error: '一次最多追加 20,000 字' });
  await typeInto('textarea[name="decision"]', 'x');
  await b.click('button[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory .cluster-error')?.innerText.includes('20,000')`);
  await ui.stopAnswering();
});

test('a merge that failed for a reason other than a clash says that reason; once merged, the button stays off and says why', { skip }, async () => {
  const merged = CLUSTER({
    status: 'done',
    merge: {
      branch: `cluster/${CID}/merged`,
      at: T0,
      results: [
        { sessionId: 's_w1', branch: `cluster/${CID}/w1`, ok: true, conflicts: [] },
        { sessionId: 's_w2', branch: `cluster/${CID}/w2`, ok: false, conflicts: [], error: '找不到分支 cluster/c_0123456789ab/w2' },
        { sessionId: 's_w3', branch: `cluster/${CID}/w3`, ok: false, conflicts: ['src/a.js'] },
      ],
    },
  });
  await openPage(fullFake({ clusters: { [CID]: merged } }));
  await b.waitFor(`document.querySelector('.cluster-merge')`);
  const rows = await b.eval(`[...document.querySelectorAll('.cluster-merge li[data-session]')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.match(rows[1], /合併失敗/);
  assert.match(rows[1], /找不到分支/);
  assert.doesNotMatch(rows[1], /衝突/, 'it did not clash');
  assert.match(rows[2], /衝突 1 個檔案/);
  const btn = await b.eval(`(() => { const e = document.querySelector('[data-action="merge"]'); return { disabled: e.disabled, title: e.title }; })()`);
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /已經合併過/);
  assert.match(await b.eval(`document.querySelector('.cluster-merge').innerText`), /不支援重新合併/, 'the reason is on the page, not only in a tooltip');
});

test('a merge the Hub refuses stays on the page where the buttons are, not only in a toast', { skip }, async () => {
  await openPage();
  await ui.answer('POST', `/api/clusters/${CID}/merge`, 409, { error: '分支 cluster/c_0123456789ab/merged 已經存在，第一版不支援重新合併' });
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  await confirmLast();
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')?.innerText.includes('不支援重新合併')`);
  assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), false, 'nothing was merged, so it can be tried again');
  await ui.stopAnswering();
});

test('a progress message redraws only what changed: the tile, its parts and the buttons are the same elements, so a selection or a focus is not lost; the open drawer follows', { skip }, async () => {
  await openPage();
  await openDrawerOf('s_w1');
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing')`);
  await b.eval(`(() => { window.__keep = { tile: document.querySelector('.cluster-worker[data-session="s_w1"]'), title: document.querySelector('.cluster-worker[data-session="s_w1"] .cluster-worker-title'), path: document.querySelector('.cluster-drawer [data-field="worktree"]'), stop: document.querySelector('[data-action="stop"]'), timing: document.querySelector('.cluster-drawer .cluster-timing') }; })()`);
  // Only the first worker's progress line moves (Hub updates come this way, several a second while it works).
  const next = CLUSTER({ workers: [W(1, { progress: '▸ 補測試：第 2 / 5 項' }), W(2, { status: 'idle', finishedAt: T0 - 5000, swarm: false }), W(3, { status: 'error', finishedAt: T0 - 1000 })] });
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: next })})`);
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-worker-progress').innerText.includes('補測試')`);
  const same = await b.eval(`({
    tile: window.__keep.tile === document.querySelector('.cluster-worker[data-session="s_w1"]'),
    title: window.__keep.title === document.querySelector('.cluster-worker[data-session="s_w1"] .cluster-worker-title'),
    path: window.__keep.path === document.querySelector('.cluster-drawer [data-field="worktree"]'),
    stop: window.__keep.stop === document.querySelector('[data-action="stop"]'),
    timing: window.__keep.timing === document.querySelector('.cluster-drawer .cluster-timing'),
  })`);
  assert.deepEqual(same, { tile: true, title: true, path: true, stop: true, timing: true });
  // A state change does change the badge, in the same tile.
  const done = CLUSTER({ workers: [W(1, { status: 'idle', finishedAt: T0, progress: 'ok' }), W(2, { status: 'idle', finishedAt: T0 - 5000, swarm: false }), W(3, { status: 'error', finishedAt: T0 - 1000 })] });
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: done })})`);
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="s_w1"] .cluster-worker-state').innerText.trim() === '已完成'`);
  assert.equal(await b.eval(`window.__keep.tile === document.querySelector('.cluster-worker[data-session="s_w1"]')`), true);
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /2\/3 完成/, 'the head follows the counts');
});

test('a cluster that does not exist says so; one the Hub cannot answer shows the reason and a way to try again', { skip }, async () => {
  await setFake({ clusters: {} });
  await ui.openApp('#/cluster/c_ffffffffffff');
  await b.waitFor(`document.querySelector('.cluster-none')`);
  assert.match(await pageText(), /沒有這個叢集/);
  await setFake({ clusters: { [CID]: { __error: { status: 502, message: '連不上那台電腦' } } } });
  await ui.openApp(`#/cluster/${CID}`);
  await b.waitFor(`document.querySelector('.cluster-none')`);
  assert.match(await pageText(), /連不上那台電腦/);
  await setFake(fullFake());
  await b.click('.cluster-none [data-action="retry"]');
  await b.waitFor(`document.querySelector('.cluster-worker')`);
});

// ------------------------------------------------------------ live updates

test('a cluster message over the socket updates the page, and one about another cluster does not', { skip }, async () => {
  await openPage();
  await openDrawerOf('s_w1');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-worker .cluster-worker-state')].map((e) => e.innerText.trim())`), ['執行中', '已完成', '出錯']);
  const next = CLUSTER({ workers: [W(1, { status: 'idle', finishedAt: T0, progress: '全部改完了' }), W(2, { status: 'idle', finishedAt: T0 - 5000, swarm: false }), W(3, { status: 'error', finishedAt: T0 - 1000 })], status: 'done' });
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: next })})`);
  await b.waitFor(`document.querySelector('.cluster-worker-state').innerText.trim() === '已完成'`);
  assert.match(await pageText(), /2\/3 完成/, 'one more finished (the failed one is not counted as 完成)');
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer .cluster-worker-progress').innerText.trim()`), '全部改完了', 'and the open drawer says what the worker said');
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /已完成/);
  // Another cluster's news is not this page's.
  const other = CLUSTER({ id: 'c_aaaaaaaaaaaa', status: 'stopped', workers: [W(9)] });
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: other })})`);
  await b.sleep(250);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 3);
  assert.doesNotMatch(await b.eval(`document.querySelector('.cluster-head').innerText`), /已停止/);
});

// -------------------------------------------------------- main conversation

test('the main conversation shows 叢集進行中 x/y 完成 → 查看 while a cluster runs, follows it, and drops it when it is over', { skip }, async () => {
  await setFake();
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-banner')`), null, 'no cluster, no banner');
  const running = CLUSTER();
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: running })})`);
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  const text = () => b.eval(`document.querySelector('.cluster-banner')?.innerText.replace(/\\s+/g, ' ').trim() ?? null`);
  assert.match(await text(), /叢集進行中 1\/3 完成/);
  assert.equal(await b.eval(`document.querySelector('.cluster-banner a').getAttribute('href')`), `#/cluster/${CID}`);
  assert.match(await b.eval(`document.querySelector('.cluster-banner a').innerText`), /查看/);

  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER({ workers: [W(1, { status: 'idle', finishedAt: T0 }), W(2, { status: 'idle', finishedAt: T0 }), W(3, { status: 'running' })] }) })})`);
  await b.waitFor(`document.querySelector('.cluster-banner')?.innerText.includes('2/3')`);
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER({ status: 'merging' }) })})`);
  await b.waitFor(`document.querySelector('.cluster-banner')?.innerText.includes('合併中')`);
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER({ status: 'done' }) })})`);
  await b.waitFor(`!document.querySelector('.cluster-banner')`);

  // A cluster of another conversation does not show here.
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER({ parentId: 's_ds', id: 'c_bbbbbbbbbbbb' }) })})`);
  await b.sleep(250);
  assert.equal(await b.eval(`document.querySelector('.cluster-banner')`), null);
});

test('a conversation whose summary lists clusters gets its banner from the Hub when it is opened; one that lists none asks for nothing', { skip }, async () => {
  await setFake({ parents: { s_kimi: [CLUSTER()] } }, { s_kimi: { clusterIds: [CID] } });
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  assert.match(await b.eval(`document.querySelector('.cluster-banner').innerText`), /叢集進行中 1\/3 完成/);
  assert.ok((await b.eval(`window.__gets`)).includes('/api/sessions/s_kimi/clusters'));
  await ui.openApp('#/s/s_ds');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.sleep(300);
  // (The list of every cluster is asked for once when the page starts, for the sidebar's number; that is not about this conversation.)
  assert.deepEqual((await b.eval(`window.__gets`)).filter((u) => /cluster/.test(u) && u !== '/api/clusters'), [], 'nothing was asked for a conversation with no clusters');
});

test('a worker is tagged 叢集 in the sidebar and, opened, says which cluster it belongs to', { skip }, async () => {
  await setFake({}, { s_ds: { clusterId: CID, clusterRole: 'worker' } });
  await ui.openApp('#/s/s_ds');
  await b.waitFor(`document.querySelector('.composer-input')`);
  const tag = await b.eval(`(() => { const row = [...document.querySelectorAll('.side-row')].find((r) => r.innerText.includes('DeepSeek chat')); const t = row?.querySelector('.row-tag.cluster'); return t ? { text: t.innerText.trim(), title: t.title } : null; })()`);
  assert.ok(tag, 'the worker\'s row has the tag');
  assert.equal(tag.text, '叢集');
  const other = await b.eval(`[...document.querySelectorAll('.side-row')].filter((r) => !r.innerText.includes('DeepSeek chat') && r.querySelector('.row-tag.cluster')).length`);
  assert.equal(other, 0, 'and no other row has it');
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-note a').getAttribute('href')`), `#/cluster/${CID}`);
  assert.match(await b.eval(`document.querySelector('.cluster-worker-note').innerText`), /叢集的工作者/);
});

// ------------------------------------------------------------------ naming

test('nothing on any cluster screen calls a cluster a swarm; "Swarm" is only ever Kimi\'s own mode, said as such', { skip }, async () => {
  const NAMING = `(() => {
    const root = document.body;
    const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '');
    const all = [...root.querySelectorAll('.cluster-dialog *, .cluster-page *, .cluster-banner *, .cluster-worker-note *, .toasts *, .slash-menu *, .om-menu *')];
    return {
      group: all.filter((e) => /子代理群/.test(own(e))).map((e) => e.outerHTML.slice(0, 100)),
      swarm: all.filter((e) => /swarm/i.test(own(e)) && !e.closest('[data-native-swarm]')).map((e) => e.outerHTML.slice(0, 100)),
      native: [...root.querySelectorAll('[data-native-swarm]')].map((e) => e.innerText.replace(/\\s+/g, ' ')),
    };
  })()`;
  // The dialog.
  await setFake();
  await openDialog();
  let r = await b.eval(NAMING);
  assert.deepEqual([r.group, r.swarm], [[], []], `dialog: ${JSON.stringify(r)}`);
  assert.ok(r.native.length >= 1 && r.native.every((t) => /Kimi 原生/.test(t)), `the dialog says whose Swarm it is: ${r.native}`);
  // The page and the banner.
  await openPage();
  await openDrawerOf('s_w1');
  r = await b.eval(NAMING);
  assert.deepEqual([r.group, r.swarm], [[], []], `page: ${JSON.stringify(r)}`);
  assert.ok(r.native.length >= 2 && r.native.every((t) => /原生 Swarm/.test(t)), `the cluster's chip and the worker's chip in its drawer say 原生: ${r.native}`);
  await closeDrawer();
  // The list of every cluster and the link to it in the sidebar.
  await setFake({ list: [rowOf(CLUSTER())], clusters: { [CID]: CLUSTER() } });
  await ui.openApp('#/clusters');
  await b.waitFor(`document.querySelector('.cluster-card')`);
  r = await b.eval(NAMING.replace(".cluster-dialog *, .cluster-page *", ".cluster-dialog *, .cluster-page *, .sidebar [data-nav=clusters] *"));
  assert.deepEqual([r.group, r.swarm], [[], []], `the list: ${JSON.stringify(r)}`);
  await openPage();
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER() })})`);
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  r = await b.eval(NAMING);
  assert.deepEqual([r.group, r.swarm], [[], []], `banner: ${JSON.stringify(r)}`);
});


// ----------------------------------------------------------------- contrast

// Every kind of text these screens draw, read against what it sits on, in the
// three looks (the Kimi look in both themes, the Claude look and the DeepSeek
// look each have one): AA for small text.
const AA = 4.5;
const LOOKS = [
  { name: 'kimi light', look: 'kimi', theme: 'light' },
  { name: 'kimi dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'dark' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
const PAGE_TEXT = [
  ['cluster status badge', '.cluster-head [data-field="status"]'],
  ['failed count badge', '.cluster-head .om-badge--danger'],
  ['progress', '.cluster-progress'],
  ['facts', '.ch-facts > span:not([data-native-swarm])'],
  ['native swarm chip (on)', '.cluster-head .cluster-chip.on'],
  ['link to the main conversation', '.cluster-head .linklike'],
  ['stop button', '[data-action="stop"]'],
  ['worker state badge', '.cluster-worker-state'],
  ['worker title', '.cluster-worker-title'],
  ['memory text', '.cluster-memory-text'],
  ['memory meta', '.cluster-memory-meta'],
  ['memory truncated note', '.cluster-memory-truncated'],
  ['merge failure reason', '.cluster-merge .om-field__error'],
  ['merge branch', '.cluster-merge-branch'],
  ['merge row name', '.cluster-merge-name'],
  ['merge ok badge', '.cluster-merge li.ok .om-badge'],
  ['merge conflict badge', '.cluster-merge li.fail .om-badge'],
  ['conflict path', '.cluster-conflicts code'],
];
// What a worker's drawer shows (a tile has no long text; the drawer has all of it).
const DRAWER_TEXT = {
  s_w1: [
    ['worker task', '.cd-task'],
    ['branch and worktree names', '.cluster-kv dt'],
    ['branch value', '.cluster-kv code'],
    ['progress line', '.cluster-drawer .cluster-worker-progress'],
    ['time total', '.cluster-timing-total'],
    ['time legend label', '.cluster-legend-label'],
    ['time legend value', '.cluster-legend-value'],
    ['counts', '.cluster-timing-facts'],
    ['native swarm chip (on)', '.cluster-drawer .cluster-chip.on'],
  ],
  s_w2: [
    ['量不到', '.cluster-legend li.unmeasured .cluster-legend-value'],
    ['reason', '.cluster-reason'],
    ['native swarm chip (off)', '.cluster-drawer .cluster-chip:not(.on)'],
  ],
  s_w3: [['timing failed', '.cluster-timing-failed']],
};
const DIALOG_TEXT = [
  ['task number', '.cluster-task-no'],
  ['count', '.cluster-count'],
  ['mode help', '.cluster-dialog [data-field="mode"] + .om-field__help'],
  ['switch help', '.cluster-dialog .settings-switch .om-field__help'],
  ['warning', '.cluster-warn'],
  ['problem', '.cluster-problems'],
  ['error', '.cluster-error'],
];
// The primary button (white on the accent) is below AA in two of the original looks,
// as ui-matrix.test.mjs records: here it may not be worse than that.
const KNOWN_PRIMARY = { 'merge button|kimi dark': 3.8, 'merge button|claude': 3.0 };
async function contrastOf(list, L) {
  const bad = [];
  for (const [what, sel] of list) {
    // A control that is switched off is exempt (WCAG 1.4.3); the ones that matter are measured while they are on.
    // (What is on the screen: a drawer that is shut is not.)
    const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.matches(':disabled') && e.getClientRects().length).slice(0, 6).map((e) => (${CONTRAST_JS})(e))`);
    assert.ok(rs.length, `${what} (${sel}) is on the screen`);
    const floor = KNOWN_PRIMARY[`${what}|${L.name}`] ?? AA;
    for (const r of rs) if (r.ratio < floor) bad.push(`${what} ${r.ratio.toFixed(2)}:1, needs ${floor}:1 (text ${r.fg}, behind ${r.bg})`);
  }
  return bad;
}
for (const L of LOOKS) {
  test(`${L.name}: all the text on the cluster screens reads at AA (4.5:1)`, { skip }, async () => {
    const merged = CLUSTER({ merge: { branch: `cluster/${CID}/merged`, at: T0, results: [{ sessionId: 's_w1', branch: `cluster/${CID}/w1`, ok: true, conflicts: [] }, { sessionId: 's_w2', branch: `cluster/${CID}/w2`, ok: false, conflicts: ['src/auth/login.js'] }, { sessionId: 's_w3', branch: `cluster/${CID}/w3`, ok: false, conflicts: [], error: '找不到分支' }] } });
    const truncated = { ...MEMORY(), bytes: 250_000, truncated: true, from: 100_000 };
    await setFake(fullFake({ clusters: { [CID]: merged }, parents: { s_kimi: [merged] }, memory: { [CID]: truncated } }), { s_ds: { clusterId: CID, clusterRole: 'worker' } });
    const open = async (hash) => {
      await b.size(1280, 900);
      await b.goto(ui.hub.url + '#/', 300);
      await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(L.look)}); localStorage.setItem('hubTheme', ${JSON.stringify(L.theme)})`);
      await b.goto(ui.hub.url + hash, 300);
      await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
    };
    await open(`#/cluster/${CID}`);
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3 && document.querySelector('.cluster-memory-text') && document.querySelector('.cluster-merge')`);
    await b.eval(`document.querySelectorAll('details.cluster-fold').forEach((d) => d.setAttribute('open', ''))`);
    // A memory that cannot be read, to measure its notice too.
    assert.deepEqual(await contrastOf(PAGE_TEXT, L), [], `${L.name}: the page`);
    if (SHOTS) await b.shot(path.join(SHOTS, `look-${L.name.replace(' ', '-')}.png`));
    // The drawers.
    for (const [sid, list] of Object.entries(DRAWER_TEXT)) {
      await openDrawerOf(sid);
      await b.waitFor(`document.querySelector('.cluster-drawer [data-sec="time"] .cluster-timing, .cluster-drawer [data-sec="time"] .cluster-timing-failed')`);
      assert.deepEqual(await contrastOf(list, L), [], `${L.name}: the drawer of ${sid}`);
      await closeDrawer();
    }
    // The merge button, while it is on (once a cluster is merged it is off for good).
    await setFake(fullFake(), { s_ds: { clusterId: CID, clusterRole: 'worker' } });
    await open(`#/cluster/${CID}`);
    await b.waitFor(`document.querySelector('.cluster-worker')`);
    assert.deepEqual(await contrastOf([['merge button', '[data-action="merge"]']], L), [], `${L.name}: the merge button`);
    await setFake(fullFake({ clusters: { [CID]: merged }, parents: { s_kimi: [merged] }, memory: { [CID]: truncated } }), { s_ds: { clusterId: CID, clusterRole: 'worker' } });
    assert.equal(await b.eval(`document.documentElement.dataset.look`), L.look);

    // The dialog, with a problem and the error showing.
    await open('#/s/s_kimi');
    await b.waitFor(`document.querySelector('.composer-input')`);
    await b.click('.toolbar button[aria-label="更多"]');
    await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
    await pressMenu('叢集派工');
    await b.waitFor(`document.querySelector('.cluster-dialog')`);
    await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
    await b.click('input[name="isolate"]');
    await fillTask(0, 'a', '');
    await ui.answer('POST', '/api/sessions/s_kimi/cluster', 409, { error: '那台電腦離線' });
    await fillTask(0, 'a', 'b');
    await b.click('[data-action="add-task"]');
    await fillTask(1, 'c', 'd');
    await b.eval(`window.__postDelay = { prefix: '/api/sessions/s_kimi/cluster', ms: 700 }`);
    await b.click('.cluster-dialog button[type="submit"]');
    assert.deepEqual(await contrastOf([['sending note', '.cluster-sending .callout-text']], L), [], `${L.name}: while it is on its way`);
    await b.waitFor(`document.querySelector('.cluster-error')?.innerText`);
    await b.click('[data-action="add-task"]'); // an empty task: the problem line shows
    assert.deepEqual(await contrastOf(DIALOG_TEXT, L), [], `${L.name}: the dialog`);
    await ui.stopAnswering();

    // The sidebar tag (plain, on the open row and under the pointer) and the notes on a conversation.
    // A cluster's workers are not listed in the sidebar (a search finds them by name, and the open one is listed): the plain tag is read on the row a search finds.
    await open('#/s/s_kimi');
    await b.waitFor(`document.querySelector('.composer-input')`);
    await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER() })})`);
    await b.waitFor(`document.querySelector('.cluster-banner')`);
    await b.eval(`(() => { const i = document.querySelector('.side-search input'); i.value = 'DeepSeek'; i.dispatchEvent(new Event('input')); })()`);
    await b.waitFor(`document.querySelector('.row-tag.cluster')`);
    const tag = await b.eval(`(${CONTRAST_JS})(document.querySelector('.row-tag.cluster'))`);
    const bad = [];
    if (tag.ratio < AA) bad.push(`sidebar tag ${tag.ratio.toFixed(2)}:1`);
    bad.push(...(await contrastOf([['banner text', '.cluster-banner-text'], ['banner link', '.cluster-banner .linklike']], L)));
    await open('#/s/s_ds');
    await b.waitFor(`document.querySelector('.cluster-worker-note')`);
    bad.push(...(await contrastOf([['worker note', '.cluster-worker-note .callout-text'], ['worker note link', '.cluster-worker-note .linklike'], ['open row tag', '.side-row[aria-current="page"] .row-tag.cluster']], L)));
    await b.hover('.side-row:not([aria-current="page"]) .row-tag.cluster, .side-row:not([aria-current="page"])');
    assert.deepEqual(bad, [], `${L.name}: the notes and the tag`);
  });
}

// ------------------------------------------------------------------- layout

const CELLS = [
  { name: '1280 light', w: 1280, h: 900, theme: 'light' },
  { name: '1280 dark', w: 1280, h: 900, theme: 'dark' },
  { name: '390 light', w: 390, h: 844, theme: 'light' },
  { name: '390 dark', w: 390, h: 844, theme: 'dark' },
];
async function openCell(cell, hash) {
  await b.size(cell.w, cell.h, cell.w < 700);
  await b.goto(ui.hub.url + '#/', 300);
  await b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(cell.theme)})`);
  await b.goto(ui.hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
}
// Anything that sticks out of the box it is in, or of the window.
const STICKS_OUT = (rootSel) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)});
  const rr = root.getBoundingClientRect();
  const out = [];
  for (const e of root.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > rr.right + 1 || r.left < rr.left - 1) out.push(e.className + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' in ' + Math.round(rr.left) + '-' + Math.round(rr.right));
  }
  return { out: out.slice(0, 8), page: document.documentElement.scrollWidth - document.documentElement.clientWidth, box: root.scrollWidth - root.clientWidth };
})()`;

for (const cell of CELLS) {
  test(`${cell.name}: the dispatch dialog and the cluster page fit, nothing is cut off or runs past its box`, { skip }, async () => {
    await setFake(fullFake());
    // The dialog, with all eight tasks and every warning showing: the tallest it gets.
    await openCell(cell, '#/s/s_kimi');
    await b.waitFor(`document.querySelector('.composer-input')`);
    await b.click('.toolbar button[aria-label="更多"]');
    await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
    await pressMenu('叢集派工');
    await b.waitFor(`document.querySelector('.cluster-dialog')`);
    await fillTask(0, '修登入頁的錯誤訊息', '把登入頁在帳密錯誤時顯示的訊息改成能說明是帳號還是密碼的問題，並補一個測試');
    await b.click('[data-action="add-task"]');
    await fillTask(1, '', '掃描所有路由，列出沒有權限檢查的');
    await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
    await b.click('input[name="isolate"]');
    await typeInto('textarea[name="note"]', '先讀 README，再動手；不要碰 migrations 資料夾');
    let fit = await b.eval(STICKS_OUT('.cluster-dialog'));
    assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} dialog: ${JSON.stringify(fit)}`);
    const dialogBox = await b.eval(`(() => { const r = document.querySelector('.dialog').getBoundingClientRect(); const sub = document.querySelector('.cluster-dialog button[type="submit"]'); sub.scrollIntoView(); const s = sub.getBoundingClientRect(); return { dialogRight: r.right, vw: innerWidth, subVisible: s.width > 0 && s.left >= r.left && s.right <= r.right + 1, subH: Math.round(s.height) }; })()`);
    assert.ok(dialogBox.dialogRight <= dialogBox.vw, 'the dialog is inside the window');
    assert.ok(dialogBox.subVisible, 'and the send button is reachable inside it');
    if (SHOTS) {
      await b.eval(`document.querySelector('.dialog').scrollTop = 0`);
      await b.shot(path.join(SHOTS, `dialog-${cell.name.replace(' ', '-')}.png`));
    }

    // The cluster page.
    await openCell(cell, `#/cluster/${CID}`);
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3 && document.querySelector('.cluster-memory-text')`);
    await b.eval(`document.querySelectorAll('details.cluster-fold').forEach((d) => d.setAttribute('open', ''))`);
    fit = await b.eval(STICKS_OUT('.cluster-page'));
    assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} page: ${JSON.stringify(fit)}`);
    const cards = await b.eval(`(() => [...document.querySelectorAll('.cluster-worker')].map((c) => { const r = c.getBoundingClientRect(); const t = c.querySelector('.cluster-worker-title'); return { w: Math.round(r.width), left: Math.round(r.left), vw: innerWidth, titleClipped: t.scrollWidth > t.clientWidth + 1 && getComputedStyle(t).whiteSpace === 'nowrap' && getComputedStyle(t).textOverflow !== 'ellipsis' }; }))()`);
    assert.equal(cards.length, 3);
    for (const c of cards) {
      assert.ok(c.left >= 0 && c.left + c.w <= c.vw, `${cell.name}: a card is inside the window: ${JSON.stringify(c)}`);
      assert.ok(c.w >= 150, `${cell.name}: a tile is not squeezed into a sliver: ${c.w}px`);
    }
    // The buttons are whole words on one line each, not cut into letters.
    const buttons = await b.eval(`[...document.querySelectorAll('.cluster-page .om-btn')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.trim(), h: Math.round(r.height), w: Math.round(r.width), lines: Math.round(r.height / parseFloat(getComputedStyle(e).lineHeight || 20)) }; }).filter((x) => x.text)`);
    assert.ok(buttons.length >= 2);
    for (const x of buttons) assert.ok(x.h <= 40, `${cell.name}: button 「${x.text}」 stays on one line (${x.h}px high)`);
    // A worker's drawer fits as well: nothing sticks out of it or of the window.
    await openDrawerOf('s_w1');
    await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing')`);
    fit = await b.eval(STICKS_OUT('.cluster-drawer'));
    assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} drawer: ${JSON.stringify(fit)}`);
    if (SHOTS) await b.shot(path.join(SHOTS, `drawer-${cell.name.replace(' ', '-')}.png`));
    await closeDrawer();
    if (SHOTS) {
      await b.eval(`document.querySelector('.cluster-page').scrollTop = 0`);
      await b.shot(path.join(SHOTS, `page-${cell.name.replace(' ', '-')}.png`));
      await b.eval(`(() => { const p = document.querySelector('.cluster-page'); p.scrollTop = p.scrollHeight; })()`);
      await b.shot(path.join(SHOTS, `page-bottom-${cell.name.replace(' ', '-')}.png`));
    }
  });
}

test('the merge result and a banner fit too, at a phone\'s width', { skip }, async () => {
  const merged = CLUSTER({
    status: 'done',
    merge: { branch: `cluster/${CID}/merged`, at: T0, results: [{ sessionId: 's_w1', branch: `cluster/${CID}/w1`, ok: true, conflicts: [] }, { sessionId: 's_w2', branch: `cluster/${CID}/w2`, ok: false, conflicts: ['packages/some-long-package-name/src/components/LoginForm/validation/errorMessages.test.tsx', 'src/auth/session.js'] }] },
  });
  await setFake(fullFake({ clusters: { [CID]: merged } }));
  const cell = CELLS[2];
  await openCell(cell, `#/cluster/${CID}`);
  await b.waitFor(`document.querySelector('.cluster-merge')`);
  const fit = await b.eval(STICKS_OUT('.cluster-page'));
  assert.deepEqual(fit, { out: [], page: 0, box: 0 }, JSON.stringify(fit));
  if (SHOTS) {
    await b.eval(`document.querySelector('.cluster-merge').scrollIntoView()`);
    await b.shot(path.join(SHOTS, 'merge-390-light.png'));
  }
  await openCell(cell, '#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster: CLUSTER() })})`);
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  const banner = await b.eval(`(() => { const r = document.querySelector('.cluster-banner').getBoundingClientRect(); return { left: r.left, right: r.right, h: Math.round(r.height), vw: innerWidth }; })()`);
  assert.ok(banner.left >= 0 && banner.right <= banner.vw, JSON.stringify(banner));
  assert.ok(banner.h <= 72, `the banner stays a banner: ${banner.h}px`);
  if (SHOTS) await b.shot(path.join(SHOTS, 'banner-390-light.png'));
});

// ---------------------------------------------------------------- clean up
//
// After a merge the Hub cleans up by itself, and 清理 does it by hand. What the
// page owes the person: ask first and list what will be removed and what kept
// (and why); show what was done, per worker; put a hidden conversation back;
// and never offer what the Hub would refuse.

const OKS = [1, 2, 3].map((n) => ({ sessionId: `s_w${n}`, branch: `cluster/${CID}/w${n}`, ok: true, conflicts: [] }));
const DONE = (patch = {}) => CLUSTER({
  status: 'done',
  workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0 - 9000 + n * 1000, swarm: false, progress: `第 ${n} 區做完了` })),
  merge: { branch: `cluster/${CID}/merged`, at: T0 - 3000, results: OKS },
  ...patch,
});
const KEPT_WHY = ['有 2 項未提交的修改或未追蹤的檔案', '分支還被 worktree 使用中'];
const RESULTS = [
  { sessionId: 's_w1', worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] },
  { sessionId: 's_w2', worktree: 'kept', branch: 'kept', hidden: false, reasons: KEPT_WHY },
  { sessionId: 's_w3', worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] },
];
const CLEANED = (patch = {}) => DONE({
  workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0 - 9000 + n * 1000, swarm: false, progress: `第 ${n} 區做完了`, hidden: n !== 2 })),
  cleanup: { at: T0 - 2000, auto: true, results: RESULTS },
  ...patch,
});
const PLAN = {
  dryRun: true,
  results: RESULTS,
  actions: [
    { sessionId: 's_w1', removeWorktree: true, deleteBranch: true, hide: true },
    { sessionId: 's_w2', removeWorktree: false, deleteBranch: false, hide: false },
    { sessionId: 's_w3', removeWorktree: true, deleteBranch: true, hide: true },
  ],
};
const cleanupBtn = () => b.eval(`(() => { const e = document.querySelector('[data-action="cleanup"]'); return e ? { disabled: e.disabled, title: e.title, text: e.innerText.trim() } : null; })()`);
const dialogOf = () => b.eval(`document.querySelector('.dialog')?.innerText.replace(/[ \\t]+/g, ' ') ?? ''`);

test('清理 is offered when nothing is working and says what it will do; while a worker works it is off and says to stop first', { skip }, async () => {
  await openPage();
  let btn = await cleanupBtn();
  assert.ok(btn, 'the button is on the page');
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /工作者還在跑，先全部停止/);

  await openPage(fullFake({ clusters: { [CID]: DONE() } }));
  btn = await cleanupBtn();
  assert.equal(btn.disabled, false);
  assert.match(btn.title, /移除乾淨的 worktree.*收起.*保留/);
  assert.equal(btn.text, '清理');

  await openPage(fullFake({ clusters: { [CID]: DONE({ merge: null }) } }));
  assert.match((await cleanupBtn()).title, /還沒合併過.*沒有任何新 commit.*有 commit 的會保留/, 'before a merge it says what is different');

  // Cleaned already, nothing left over: nothing to press.
  await openPage(fullFake({ clusters: { [CID]: CLEANED({ cleanup: { at: T0, auto: true, results: RESULTS.map((r) => ({ ...r, worktree: 'removed', branch: 'deleted', hidden: true, reasons: [] })) }, workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0, hidden: true })) }) } }));
  btn = await cleanupBtn();
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /已經清理乾淨/);
});

test('清理 asks first, listing what it will remove and what it keeps with the reason and the path; cancelling sends nothing; confirming cleans THIS cluster and the result is drawn', { skip }, async () => {
  const cleaned = CLEANED({ cleanup: { at: T0, auto: false, results: RESULTS } });
  await openPage(fullFake({ clusters: { [CID]: DONE() }, plans: { [CID]: PLAN } }));
  assert.equal(await b.eval(`document.querySelector('.cluster-cleanup')`), null, 'no result before anything was done');
  await ui.clearCalls();
  await ui.answer('POST', `/api/clusters/${CID}/cleanup`, 200, { cluster: cleaned });
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  assert.ok((await b.eval(`window.__gets`)).includes(`/api/clusters/${CID}/cleanup/plan`), 'the Hub was asked what it would do');
  assert.equal((await callsTo(/\/cleanup$/)).length, 0, 'and nothing is done before the answer');
  const ask = await dialogOf();
  assert.match(ask, /要清理這個叢集嗎/);
  assert.match(ask, /移除 2 個 worktree/);
  assert.match(ask, /刪除 2 個分支/);
  assert.match(ask, /收起 2 個工作者對話/);
  assert.match(ask, /保留 1 個工作者/);
  assert.ok(ask.includes(`cluster/${CID}/merged`), 'the merged branch is said to stay');
  assert.match(ask, /叢集記憶/, 'and the memory');
  assert.match(ask, /對話不會刪/, 'the conversations are not deleted');
  assert.match(ask, /node_modules/, 'ignored files go with the worktree: said');
  const rows = await b.eval(`[...document.querySelectorAll('.dialog .cluster-cleanup-list > li')].map((li) => ({ session: li.dataset.session, keeps: li.dataset.keeps, text: li.innerText.replace(/\\s+/g, ' ').trim() }))`);
  assert.deepEqual(rows.map((r) => [r.session, r.keeps]), [['s_w1', 'false'], ['s_w2', 'true'], ['s_w3', 'false']]);
  assert.match(rows[0].text, /移除 worktree.*刪除分支.*從側欄收起對話/);
  assert.match(rows[1].text, /保留/);
  assert.ok(rows[1].text.includes('有 2 項未提交的修改或未追蹤的檔案'), 'why it is kept');
  assert.ok(rows[1].text.includes(`/home/user/proj-cluster-${CID}/w2`), 'and where it is');
  if (SHOTS) await b.shot(path.join(SHOTS, 'cleanup-confirm-1280-light.png'));

  // Cancel: nothing is sent.
  await b.click('.dialog .dialog-actions .om-btn:first-child');
  await b.waitFor(`!document.querySelector('.dialog')`);
  assert.equal((await callsTo(/\/cleanup$/)).length, 0);

  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  await confirmLast();
  await b.waitFor(`document.querySelector('.cluster-cleanup')`);
  assert.deepEqual((await callsTo(/\/cleanup$/)).map((c) => [c.url, c.body]), [[`/api/clusters/${CID}/cleanup`, {}]]);

  // The result: the summary, who was kept and why; each card says its own.
  const sec = await b.eval(`document.querySelector('.cluster-cleanup').innerText.replace(/\\s+/g, ' ')`);
  assert.match(sec, /清理結果/);
  assert.match(sec, /手動/);
  assert.match(sec, /2 個 worktree 已移除/);
  assert.match(sec, /2 個分支已刪除/);
  assert.match(sec, /2 個對話已從側欄收起/);
  assert.ok(sec.includes('有 2 項未提交的修改或未追蹤的檔案') && sec.includes(`/home/user/proj-cluster-${CID}/w2`), 'the kept worker: reason and path');
  // What the clean-up did to each worker is in its drawer.
  const cards = [];
  for (const sid of ['s_w1', 's_w2', 's_w3']) {
    await openDrawerOf(sid);
    cards.push(await b.eval(`(() => { const c = document.querySelector('.cluster-drawer'); return { session: '${sid}', worktree: c.querySelector('[data-field="cleanup-worktree"]')?.innerText.trim() ?? null, branch: c.querySelector('[data-field="cleanup-branch"]')?.innerText.trim() ?? null, hidden: c.querySelector('[data-field="cleanup-hidden"]')?.innerText.trim() ?? null, unhide: Boolean(c.querySelector('[data-action="unhide"]')), reasons: [...c.querySelectorAll('.cluster-cleanup-reasons li')].map((l) => l.innerText.trim()) }; })()`));
    if (sid === 's_w1') assert.equal(await b.eval(`document.querySelector('.cluster-drawer [data-action="open-worker"]') !== null`), true, 'the conversation can still be opened from its drawer');
    await closeDrawer();
  }
  assert.deepEqual(cards.map((c) => [c.session, c.worktree, c.branch, c.hidden, c.unhide]), [
    ['s_w1', 'worktree 已移除', '分支已刪除', '已從側欄收起', true],
    ['s_w2', 'worktree 保留', '分支保留', '在側欄', false],
    ['s_w3', 'worktree 已移除', '分支已刪除', '已從側欄收起', true],
  ]);
  assert.deepEqual(cards[1].reasons, KEPT_WHY);
  if (SHOTS) {
    await b.eval(`document.querySelector('.cluster-cleanup').scrollIntoView()`);
    await b.shot(path.join(SHOTS, 'cleanup-result-1280-light.png'));
  }
  await ui.stopAnswering();
});

test('the merge confirmation says that a merge in which every worker went in cleans up by itself, and what stays', { skip }, async () => {
  await openPage(fullFake({ clusters: { [CID]: DONE({ merge: null }) } }));
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  const ask = await dialogOf();
  assert.match(ask, /全部.*合併成功.*自動清理/);
  assert.match(ask, /未提交|沒合進去/, 'and what it will not touch');
  await b.click('.dialog .dialog-actions .om-btn:first-child');
});

test('a plan with nothing to do says so and cannot be confirmed; a refusal of the plan or of the clean-up is shown where the buttons are', { skip }, async () => {
  const nothing = { dryRun: true, results: [RESULTS[1]], actions: [PLAN.actions[1]] };
  await openPage(fullFake({ clusters: { [CID]: DONE() }, plans: { [CID]: nothing } }));
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  assert.match(await dialogOf(), /現在沒有可以清理的東西/);
  assert.equal(await b.eval(`document.querySelector('.dialog .dialog-actions .om-btn:last-child').disabled`), true, 'nothing to confirm');
  await b.click('.dialog .dialog-actions .om-btn:first-child');
  await b.waitFor(`!document.querySelector('.dialog')`);

  // The Hub refuses the plan (a worker started again, the computer went off).
  await openPage(fullFake({ clusters: { [CID]: DONE() }, plans: { [CID]: { __error: { status: 409, message: '工作者還在跑，先全部停止' } } } }));
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-head .cluster-error').innerText.trim()`), '工作者還在跑，先全部停止');
  assert.equal(await b.eval(`Boolean(document.querySelector('.dialog'))`), false, 'no dialog for a refusal');

  // The plan is fine; the clean-up itself is refused.
  await openPage(fullFake({ clusters: { [CID]: DONE() }, plans: { [CID]: PLAN } }));
  await ui.answer('POST', `/api/clusters/${CID}/cleanup`, 409, { error: '機器「box」目前離線：請在那台機器上執行連接器' });
  await b.click('[data-action="cleanup"]');
  await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
  await confirmLast();
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')`);
  assert.match(await b.eval(`document.querySelector('.cluster-head .cluster-error').innerText`), /目前離線/);
  assert.equal(await b.eval(`document.querySelector('.cluster-cleanup')`), null, 'and nothing is drawn as done');
  await ui.stopAnswering();
});

test('放回側欄: one worker or all, sent to THIS cluster, and the card and the result follow what the Hub answers', { skip }, async () => {
  await openPage(fullFake({ clusters: { [CID]: CLEANED() } }));
  await ui.clearCalls();
  const afterOne = CLEANED({ workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0 - 9000 + n * 1000, swarm: false, hidden: n === 3 })), cleanup: { at: T0 - 2000, auto: true, results: RESULTS.map((r) => ({ ...r, hidden: r.sessionId === 's_w3' })) } });
  await ui.answer('POST', `/api/clusters/${CID}/unhide`, 200, { cluster: afterOne });
  await openDrawerOf('s_w1');
  await b.click('.cluster-drawer [data-action="unhide"]');
  await b.waitFor(`document.querySelector('.cluster-drawer [data-field="cleanup-hidden"]').innerText.trim() === '在側欄'`);
  assert.deepEqual((await callsTo(/\/unhide$/)).map((c) => [c.url, c.body]), [[`/api/clusters/${CID}/unhide`, { sessionId: 's_w1' }]]);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-drawer [data-action="unhide"]'))`), false, 'nothing left to put back on that worker');
  await closeDrawer();
  await openDrawerOf('s_w3');
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer [data-field="cleanup-hidden"]').innerText.trim()`), '已從側欄收起');
  await closeDrawer();
  assert.match(await b.eval(`document.querySelector('.cluster-cleanup').innerText`), /1 個對話已從側欄收起/);
  await ui.stopAnswering();

  // All at once, from the result.
  await ui.clearCalls();
  const none = CLEANED({ workers: [1, 2, 3].map((n) => W(n, { status: 'idle', finishedAt: T0, swarm: false, hidden: false })), cleanup: { at: T0 - 2000, auto: true, results: RESULTS.map((r) => ({ ...r, hidden: false })) } });
  await ui.answer('POST', `/api/clusters/${CID}/unhide`, 200, { cluster: none });
  await b.click('.cluster-cleanup [data-action="unhide-all"]');
  await b.waitFor(`!document.querySelector('.cluster-cleanup [data-action="unhide-all"]')`);
  assert.deepEqual((await callsTo(/\/unhide$/)).map((c) => [c.url, c.body]), [[`/api/clusters/${CID}/unhide`, {}]]);
  assert.match(await b.eval(`document.querySelector('.cluster-cleanup').innerText`), /0 個對話已從側欄收起/);
  await ui.stopAnswering();
});

test('the sidebar has no row for a worker the clean-up hid, and gets it back live when it is put back; the worker\'s own page says where it went', { skip }, async () => {
  await setFake({}, { s_ds: { clusterId: CID, clusterRole: 'worker', clusterHidden: true } });
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.equal(await b.eval(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('DeepSeek chat'))`), false, 'no row for the hidden worker');
  assert.equal(await b.eval(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('Kimi'))`), true, 'the others are there');

  // Its own page still opens (from the cluster page's 開啟對話) and says why it is not in the list.
  await ui.openApp('#/s/s_ds');
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  assert.match(await b.eval(`document.querySelector('.cluster-worker-note').innerText`), /已從側欄收起/);
  assert.equal(await b.eval(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('DeepSeek chat'))`), false, 'opened, still not listed');

  // Put back: the Hub says so down the socket, and the row is there without a reload.
  await b.eval(`(async () => { const s = await (await fetch('/api/sessions/s_ds')).json(); window.__emit({ t: 'session', session: { ...s, clusterHidden: false } }); })()`);
  await b.waitFor(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('DeepSeek chat'))`);
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-note').innerText.includes('已從側欄收起')`), false, 'the note is gone with it');
});

test('the clean-up result and the confirmation fit a phone, and nothing in them is hard to read in either look', { skip }, async () => {
  const cleaned = CLEANED({ cleanup: { at: T0, auto: true, results: RESULTS.map((r) => (r.sessionId === 's_w2' ? { ...r, reasons: [...r.reasons, 'git 拒絕移除 worktree：fatal: cannot remove a locked working tree, lock reason: /very/long/path/that/goes/on/and/on/and/on/to/test/wrapping'] } : r)) } });
  const SEL = [
    ['result title', '.cluster-cleanup .cluster-section-title'],
    ['result summary', '.cluster-cleanup-summary'],
    ['kept reason', '.cluster-cleanup-kept .om-field__help, .cluster-cleanup-kept li'],
  ];
  // (Each worker's own chips and reasons are in its drawer: checked below.)
  const DRAWER_SEL = [
    ['card chip', '.cluster-drawer .cluster-worker-cleanup .om-badge'],
    ['card reason', '.cluster-drawer .cluster-cleanup-reasons li'],
  ];
  for (const cell of CELLS) {
    await setFake(fullFake({ clusters: { [CID]: cleaned }, plans: { [CID]: PLAN } }));
    await openCell(cell, `#/cluster/${CID}`);
    await b.waitFor(`document.querySelector('.cluster-cleanup') && document.querySelectorAll('.cluster-worker').length === 3`);
    let fit = await b.eval(STICKS_OUT('.cluster-page'));
    assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} page: ${JSON.stringify(fit)}`);
    const bad = [];
    // The worker that was kept (its reasons are the long ones) in its drawer.
    await openDrawerOf('s_w2');
    fit = await b.eval(STICKS_OUT('.cluster-drawer'));
    assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} drawer: ${JSON.stringify(fit)}`);
    for (const [what, sel] of DRAWER_SEL) {
      const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, 6).map((e) => (${CONTRAST_JS})(e))`);
      assert.ok(rs.length, `${what} is on the screen`);
      for (const r of rs) if (r.ratio < AA) bad.push(`${cell.name} ${what} ${r.ratio.toFixed(2)}:1`);
    }
    await closeDrawer();
    for (const [what, sel] of SEL) {
      const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, 6).map((e) => (${CONTRAST_JS})(e))`);
      assert.ok(rs.length, `${what} is on the screen`);
      for (const r of rs) if (r.ratio < AA) bad.push(`${cell.name} ${what} ${r.ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(bad, []);
    // The confirmation.
    await b.eval(`document.querySelector('[data-action="cleanup"]').scrollIntoView()`);
    const enabled = await b.eval(`!document.querySelector('[data-action="cleanup"]').disabled`);
    if (enabled) {
      await b.click('[data-action="cleanup"]');
      await b.waitFor(`document.querySelector('.dialog .cluster-cleanup-list')`);
      fit = await b.eval(STICKS_OUT('.dialog'));
      assert.deepEqual(fit, { out: [], page: 0, box: 0 }, `${cell.name} confirmation: ${JSON.stringify(fit)}`);
      const reach = await b.eval(`(() => { const e = document.querySelector('.dialog .dialog-actions .om-btn:last-child'); e.scrollIntoView(); const r = e.getBoundingClientRect(); const d = document.querySelector('.dialog').getBoundingClientRect(); return { inside: r.width > 0 && r.left >= d.left && r.right <= d.right + 1, h: Math.round(r.height) }; })()`);
      assert.ok(reach.inside && reach.h <= 40, `${cell.name}: the buttons are reachable and whole: ${JSON.stringify(reach)}`);
      const dbad = [];
      for (const sel of ['.dialog .om-alert__title', '.dialog .cluster-cleanup-summary', '.dialog .cluster-cleanup-list li', '.dialog .cluster-cleanup-note']) {
        const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, 4).map((e) => (${CONTRAST_JS})(e))`);
        assert.ok(rs.length, `${sel} is on the screen`);
        for (const r of rs) if (r.ratio < AA) dbad.push(`${cell.name} ${sel} ${r.ratio.toFixed(2)}:1`);
      }
      assert.deepEqual(dbad, []);
      if (SHOTS) await b.shot(path.join(SHOTS, `cleanup-confirm-${cell.name.replace(' ', '-')}.png`));
      await b.click('.dialog .dialog-actions .om-btn:first-child');
      await b.waitFor(`!document.querySelector('.dialog')`);
    }
    if (SHOTS) {
      await b.eval(`document.querySelector('.cluster-cleanup').scrollIntoView()`);
      await b.shot(path.join(SHOTS, `cleanup-result-${cell.name.replace(' ', '-')}.png`));
    }
  }
});
