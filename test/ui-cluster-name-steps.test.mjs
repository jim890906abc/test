// The cluster's own name, its steps, and the two speeds, in a real browser.
//
// The owner (2026-10-30): "none of my clusters is named 'VPS框架開發', yet every one of
// them shows that" (the cards and the page header printed the main conversation's
// title); "show how many steps the cluster has gone in the overview, like the chat
// room - only that cluster's steps, nothing added up"; and, seeing 63 tok/s in the
// band and 128 on a worker's tile, "is this miscalculated?".
//
// The Hub is scripted (window.__fake, test/fixtures/cluster-fake.mjs): what is
// checked is what the page shows for what it was told, and what it sends.
// CLUSTER_UI_SHOTS=<dir> also saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skipReason, uiSession, CONTRAST_JS } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';
import { FAKE_SCRIPT, CID, T0, W, CLUSTER, rowOf, SPEED, NO_SPEED, GEN, NO_GEN, THROUGHPUT, NO_THROUGHPUT, fakeHub } from './fixtures/cluster-fake.mjs';
import { summarizeCluster, genShareView, tileSpeedView } from '../public/js/cluster-model.js';

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
const texts = (sel) => b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.trim())`);
const shot = async (name) => SHOTS && b.shot(path.join(SHOTS, `${name}.png`));
const emit = (cluster) => b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster })})`);
async function open(hash, fake, { size = [1280, 860], theme = 'light' } = {}) {
  await setFake(fake);
  await b.size(size[0], size[1], size[0] < 700);
  await b.goto(ui.hub.url + '#/', 200);
  await b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
  await b.goto(ui.hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
}
const IDS = { a: 'c_aaaaaaaaaaaa', b: 'c_bbbbbbbbbbbb', c: 'c_cccccccccccc', d: 'c_dddddddddddd' };
// Four clusters from the same main conversation world: two named, one whose main conversation is gone, one from an older Hub (no name, no steps).
const four = () => {
  const a = CLUSTER({ id: IDS.a, name: '修登入', parentId: 's_kimi', parentTitle: 'Kimi chat with subagents', steps: 483, stepsUnknown: 0, status: 'running', createdAt: T0 - 300_000 });
  const bb = CLUSTER({ id: IDS.b, name: '補測試 等 3 條', parentId: 's_kimi', parentTitle: 'Kimi chat with subagents', steps: 12345, stepsUnknown: 0, status: 'done', createdAt: T0 - 200_000 });
  const c = CLUSTER({ id: IDS.c, name: '被刪的主對話', parentId: 's_gone', parentTitle: null, steps: 7, stepsUnknown: 0, status: 'done', createdAt: T0 - 100_000 });
  const d = CLUSTER({ id: IDS.d, parentId: 's_kimi', status: 'done', createdAt: T0 - 50_000 });
  delete d.steps;
  return [a, bb, c, d];
};
const fakeFor = (list, extra = {}) => ({ clusters: Object.fromEntries(list.map((c) => [c.id, c])), parents: { s_kimi: list.filter((c) => c.parentId === 's_kimi') }, list: list.map((c) => rowOf(c, 'parentTitle' in c ? c.parentTitle : 'Kimi chat with subagents')), timing: {}, memory: {}, ...extra });

// ------------------------------------------------------------ the overview

test('overview: the big title of a card is the cluster\'s own name, the main conversation is the small line (or says it is gone); clusters of one conversation read differently', { skip }, async () => {
  await open('#/clusters', fakeFor(four()));
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 4`);
  const cards = await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => ({ id: c.dataset.cluster, name: c.querySelector('.cc-title').innerText, parent: c.querySelector('.cc-parent').hidden ? null : c.querySelector('.cc-parent').innerText, gone: c.querySelector('.cc-parent').classList.contains('gone'), aria: c.getAttribute('aria-label') }))`);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(by[IDS.a].name, '修登入');
  assert.equal(by[IDS.b].name, '補測試 等 3 條');
  assert.notEqual(by[IDS.a].name, by[IDS.b].name, 'two clusters of one conversation no longer read the same');
  // The main conversation as the page knows it now.
  assert.equal(by[IDS.a].parent, '主對話：Kimi chat with subagents');
  assert.equal(by[IDS.b].parent, '主對話：Kimi chat with subagents');
  assert.equal(by[IDS.c].name, '被刪的主對話');
  assert.equal(by[IDS.c].parent, '主對話已刪除');
  assert.equal(by[IDS.c].gone, true);
  assert.match(by[IDS.a].aria, /^修登入，主對話：Kimi chat with subagents，/);
  // A cluster an older Hub gave no name is called by its main conversation, once (the small line would only repeat it).
  assert.equal(by[IDS.d].name, 'Kimi chat with subagents');
  assert.equal(by[IDS.d].parent, null);
  await shot('names-overview-1280');
});

test('overview: each card says its own steps ("483 步"), a cluster that did not say shows none, and the page head adds nothing up', { skip }, async () => {
  await open('#/clusters', fakeFor(four()));
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 4`);
  const steps = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-card')].map((c) => [c.dataset.cluster, c.querySelector('[data-field="steps"]').hidden ? null : c.querySelector('[data-field="steps"]').innerText.trim()]))`);
  assert.deepEqual(steps, { [IDS.a]: '483 步', [IDS.b]: '12,345 步', [IDS.c]: '7 步', [IDS.d]: null });
  assert.match(await b.eval(`document.querySelector('.cluster-card [data-field="steps"]:not([hidden])').title`), /一步＝一次工具呼叫.*聊天室子代理卡片的「N 個步驟」/);
  // The numbers over all clusters at the top do not include steps: the owner asked for none added up.
  const head = await text('.cl-stats');
  assert.doesNotMatch(head, /步/, `no step total in: ${head}`);
  assert.ok(!(12345 + 483 + 7).toString().split('').every((d) => head.includes(d)) || !head.includes('12835'), 'and not the sum, whatever it is called');
  assert.equal(await b.eval(`document.querySelectorAll('.cl-stat[data-stat*="step"]').length`), 0);
  await shot('steps-overview-1280');
});

test('overview: the steps follow the pushed cluster live', { skip }, async () => {
  const list = four();
  await open('#/clusters', fakeFor(list));
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 4`);
  await emit({ ...list[0], steps: 500 });
  await b.waitFor(`document.querySelector('.cluster-card[data-cluster="${IDS.a}"] [data-field="steps"]').innerText.trim() === '500 步'`);
  // A cluster that did not say before and now does.
  await emit({ ...list[3], steps: 3 });
  await b.waitFor(`document.querySelector('.cluster-card[data-cluster="${IDS.d}"] [data-field="steps"]')?.innerText.trim() === '3 步'`);
  assert.equal(await text(`.cluster-card[data-cluster="${IDS.b}"] [data-field="steps"]`), '12,345 步', 'the others did not move');
});

// ------------------------------------------------------------ the cluster page

test('the page head: the cluster\'s name is the big title, the main conversation a small link under it (or the plain words that it is gone); the toolbar does not put the conversation\'s title in the name\'s place', { skip }, async () => {
  const list = four();
  await open(`#/cluster/${IDS.a}`, fakeFor(list));
  await b.waitFor(`document.querySelector('[data-field="name"]')`);
  assert.equal(await text('.cluster-head [data-field="name"]'), '修登入');
  assert.equal(await text('.cluster-head [data-field="parent"]'), '主對話：Kimi chat with subagents');
  assert.equal(await b.eval(`document.querySelector('.cluster-head [data-field="parent"]').getAttribute('href')`), '#/s/s_kimi');
  assert.equal(await b.eval(`document.querySelector('.cluster-head [data-field="parent"]').dataset.action`), 'open-parent');
  assert.match(await text('.toolbar .om-toolbar__subtitle'), /^修登入 · c_aaaaaaaaaaaa$/);
  await shot('names-head-1280-light');
  // Its main conversation is gone.
  await open(`#/cluster/${IDS.c}`, fakeFor(list));
  await b.waitFor(`document.querySelector('.cluster-head [data-field="name"]')`);
  assert.equal(await text('.cluster-head [data-field="name"]'), '被刪的主對話');
  assert.equal(await text('.cluster-head [data-field="parent"]'), '主對話已刪除');
  assert.equal(await b.eval(`document.querySelector('.cluster-head [data-field="parent"]').tagName`), 'DIV', 'not a link to nothing');
  // An older Hub (no name): the head is called by the conversation, and there is no second line.
  await open(`#/cluster/${IDS.d}`, fakeFor(list));
  await b.waitFor(`document.querySelector('.cluster-head [data-field="name"]')`);
  assert.equal(await text('.cluster-head [data-field="name"]'), 'Kimi chat with subagents');
});

test('the page head says "共 N 步" and follows the pushed cluster; a cluster that did not say shows none', { skip }, async () => {
  const list = four();
  await open(`#/cluster/${IDS.a}`, fakeFor(list));
  await b.waitFor(`document.querySelector('.ch-facts [data-field="steps"]')`);
  assert.equal(await text('.ch-facts [data-field="steps"]'), '共 483 步');
  await emit({ ...list[0], steps: 484 });
  await b.waitFor(`document.querySelector('.ch-facts [data-field="steps"]')?.innerText.trim() === '共 484 步'`);
  await open(`#/cluster/${IDS.d}`, fakeFor(list));
  await b.waitFor(`document.querySelector('.cluster-head')`);
  assert.equal(await b.eval(`document.querySelector('.ch-facts [data-field="steps"]')`), null);
  // The unknown is said in the tip, not hidden.
  const withUnknown = CLUSTER({ id: IDS.a, name: 'x', steps: 10, stepsUnknown: 2, parentTitle: 'p' });
  await open(`#/cluster/${IDS.a}`, fakeFor([withUnknown]));
  await b.waitFor(`document.querySelector('.ch-facts [data-field="steps"]')`);
  assert.match(await b.eval(`document.querySelector('.ch-facts [data-field="steps"]').title`), /有 2 個工作者的對話已刪除/);
});

// ------------------------------------------------------------ the two speeds

const RUN = (n, gen, avg) => W(n, { status: 'running', gen: GEN(gen), speed: avg === null ? NO_SPEED() : SPEED(avg, 3), taskIndex: n - 1 });
test('a working tile says 生成 and 平均 (its last five minutes); idle is a dash; an average that cannot be measured is a dash after 平均', { skip }, async () => {
  const c = CLUSTER({ id: IDS.a, name: '速度', parentTitle: 'p', workers: [RUN(1, 128.4, 63.2), RUN(2, 41.9, null), W(3, { status: 'idle', finishedAt: T0 - 1000, gen: NO_GEN(), speed: SPEED(5, 1), taskIndex: null })] });
  await open(`#/cluster/${IDS.a}`, fakeFor([c]));
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3`);
  assert.deepEqual(await texts('.cluster-worker [data-field="gen"]'), ['生成 128 · 平均 63', '生成 42 · 平均 —', '—']);
  const titles = await b.eval(`[...document.querySelectorAll('.cluster-worker [data-field="gen"]')].map((e) => e.title)`);
  assert.match(titles[0], /^生成 128 tok\/s：.*平均 63 tok\/s：最近 5 分鐘/);
  assert.match(titles[1], /平均 量不到/);
  assert.match(titles[2], /現在量不到/);
  assert.deepEqual(tileSpeedView(c.workers[2]).measured, false);
  await shot('speed-tiles-1280-light');
});

test('under 叢集總產出 the band says how much of the time the workers write: Σ of their speeds, divided; and the line is not there when it cannot be worked out', { skip }, async () => {
  // Two workers writing at 128 and 100 tok/s; the cluster produced 60 tok/s over the last minute: X = 228/2 = 114, Y = 60/228 = 26%.
  const c = CLUSTER({ id: IDS.a, name: '速度', parentTitle: 'p', throughput: THROUGHPUT(60), workers: [RUN(1, 128, 63), RUN(2, 100, 50), W(3, { status: 'idle', finishedAt: T0 - 1000, gen: NO_GEN(), taskIndex: null })] });
  await open(`#/cluster/${IDS.a}`, fakeFor([c]));
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3`);
  const line = '工作者生成時約 114 tok/s，約有 26% 時間在生成，其餘在跑工具或等待';
  await b.waitFor(`!document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden`);
  assert.equal(await text('[data-stat="output"] [data-field="gen-share"]'), line);
  assert.equal(genShareView(c).text, line, 'the page and the model agree');
  assert.match(await b.eval(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').title`), /2 個工作者現在的生成速度合計 228 tok\/s；叢集總產出 60 tok\/s ÷ 228 ≈ 26%。兩個數字都是量到的，只做除法/);
  assert.equal(await text('[data-stat="output"] [data-field="num"]'), '60', 'the band\'s own number is not changed');
  await shot('speed-share-1280-light');

  // Pushed again: it follows (one more tok/s of output).
  await emit({ ...c, throughput: THROUGHPUT(114) });
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]')?.innerText.includes('50%')`);

  // Not worked out → the whole line is gone: a working worker whose speed is not measured; no cluster output; nothing working; more output than the workers' speeds (subagents' text).
  const hidden = async (cluster, why) => {
    await emit(cluster);
    await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden === true`);
    assert.equal(await b.eval(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').innerText.trim()`), '', why);
    assert.equal(genShareView(cluster).shown, false, why);
  };
  await hidden({ ...c, workers: [RUN(1, 128, 63), W(2, { status: 'running', gen: NO_GEN('這一輪還沒有完成任何一步'), taskIndex: 1 })] }, 'a working worker without a measured speed');
  await emit(c);
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden === false`);
  await hidden({ ...c, throughput: NO_THROUGHPUT() }, 'no cluster output');
  await emit(c);
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden === false`);
  await hidden({ ...c, workers: c.workers.map((w) => ({ ...w, status: 'idle', gen: NO_GEN() })), status: 'running' }, 'nothing is writing');
  await emit(c);
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden === false`);
  await hidden({ ...c, throughput: THROUGHPUT(500) }, 'output above what the workers write: the subagents\' text is in it, no share is claimed');
  await emit(c);
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="gen-share"]').hidden === false`);
  await hidden({ ...c, status: 'done', workers: c.workers.map((w) => ({ ...w, status: 'idle', gen: NO_GEN(), finishedAt: T0 })) }, 'a finished cluster');
});

// ------------------------------------------------------------ renaming

test('the pencil renames: a dialog with the name, the new name is sent, the page shows it; a blank name is not sent; the Hub\'s refusal is said in the dialog', { skip }, async () => {
  const c = four()[0];
  await open(`#/cluster/${IDS.a}`, fakeFor([c]));
  await b.waitFor(`document.querySelector('[data-action="rename"]')`);
  await ui.clearCalls();
  await b.click('[data-action="rename"]');
  await b.waitFor(`document.querySelector('.cluster-rename-dialog')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-rename-dialog input').value`), '修登入');
  assert.equal(await b.eval(`document.querySelector('.cluster-rename-dialog input').maxLength`), 60);
  await shot('rename-dialog-1280-light');
  // Blank: not sent.
  await b.eval(`(() => { const i = document.querySelector('.cluster-rename-dialog input'); i.value = '   '; })()`);
  await b.click('[data-action="rename-save"]');
  await b.waitFor(`document.querySelector('[data-field="rename-error"]').innerText.includes('空')`);
  assert.equal((await ui.calls()).filter((x) => /\/name$/.test(x.url)).length, 0);
  // The Hub refuses.
  await b.eval(`document.querySelector('.cluster-rename-dialog input').value = '新名字'`);
  await ui.answer('POST', `/api/clusters/${IDS.a}/name`, 400, { error: '叢集名稱最多 60 個字' });
  await b.click('[data-action="rename-save"]');
  await b.waitFor(`document.querySelector('[data-field="rename-error"]').innerText.includes('最多 60')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-rename-dialog'))`), true, 'the dialog stays open');
  assert.equal(await text('.cluster-head [data-field="name"]'), '修登入');
  // It goes through: the new name is on the page (from the Hub's answer).
  await ui.stopAnswering();
  await ui.answer('POST', `/api/clusters/${IDS.a}/name`, 200, { ...c, name: '新名字' });
  await b.click('[data-action="rename-save"]');
  await b.waitFor(`!document.querySelector('.cluster-rename-dialog')`);
  await b.waitFor(`document.querySelector('.cluster-head [data-field="name"]').innerText.trim() === '新名字'`);
  const sent = (await ui.calls()).filter((x) => /\/name$/.test(x.url));
  assert.deepEqual(sent.map((x) => x.body), [{ name: '新名字' }, { name: '新名字' }]);
  await ui.stopAnswering();
  // The pencil is a real button with a name.
  assert.equal(await b.eval(`document.querySelector('[data-action="rename"]').getAttribute('aria-label')`), '重新命名叢集');
});

// ------------------------------------------------------------ the dispatch dialog

test('the dispatch dialog has a name box: its placeholder is the name the Hub will make; what is typed is sent (and a blank sends none)', { skip }, async () => {
  await setFake({});
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.click('.toolbar button[aria-label="更多"]');
  await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
  await b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.includes('叢集派工'))?.click()`);
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  const input = 'input[name="cluster-name"]';
  const set = (sel, value) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.match(await b.eval(`document.querySelector('${input}').placeholder`), /留空就用任務的名稱/);
  await set('.cluster-task:nth-of-type(1) input[name="task-title"]', '修登入');
  await set('.cluster-task:nth-of-type(1) textarea[name="task-prompt"]', '把登入頁的錯誤訊息改好');
  assert.equal(await b.eval(`document.querySelector('${input}').placeholder`), '修登入', 'one task: named after it');
  await b.click('[data-action="add-task"]');
  await set('.cluster-task:nth-of-type(2) input[name="task-title"]', '補測試');
  await set('.cluster-task:nth-of-type(2) textarea[name="task-prompt"]', '補登入的測試');
  assert.equal(await b.eval(`document.querySelector('${input}').placeholder`), '修登入 等 2 條', 'several: the first and how many');
  assert.equal(await b.eval(`document.querySelector('${input}').maxLength`), 60);
  await shot('dispatch-name-1280-light');
  // Blank name: none is sent.
  await ui.clearCalls();
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: CLUSTER({ parentId: 's_kimi' }), warnings: [] });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`window.__calls.some((c) => /\\/cluster$/.test(c.url))`);
  let [post] = (await ui.calls()).filter((c) => /\/cluster$/.test(c.url));
  assert.ok(!('name' in post.body), 'no name key when none was typed');
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`);
  // A typed name is sent, cleaned.
  await ui.stopAnswering();
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.click('.toolbar button[aria-label="更多"]');
  await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
  await b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.includes('叢集派工'))?.click()`);
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  await set('.cluster-task:nth-of-type(1) textarea[name="task-prompt"]', '做一件事');
  await set(input, '  登入頁   大改造 ');
  await ui.clearCalls();
  await ui.answer('POST', '/api/sessions/s_kimi/cluster', 200, { cluster: CLUSTER({ parentId: 's_kimi', name: '登入頁 大改造' }), warnings: [] });
  await b.click('.cluster-dialog button[type="submit"]');
  await b.waitFor(`window.__calls.some((c) => /\\/cluster$/.test(c.url))`);
  [post] = (await ui.calls()).filter((c) => /\/cluster$/.test(c.url));
  assert.equal(post.body.name, '登入頁 大改造');
  await ui.stopAnswering();
});

// ------------------------------------------------------------ phone and dark

test('on a phone and in the dark look the name, the small line, the steps and the speeds stay readable and nothing runs off the side', { skip }, async () => {
  const c = CLUSTER({ id: IDS.a, name: '這是一個很長很長很長很長很長很長很長很長很長很長很長很長的叢集名稱', parentTitle: 'Kimi chat with subagents', steps: 483, throughput: THROUGHPUT(60), workers: [RUN(1, 128, 63), RUN(2, 100, 50)] });
  const rows = [c, CLUSTER({ id: IDS.b, name: '另一個', parentId: 's_gone', parentTitle: null, steps: 12345, status: 'done' })];
  for (const [theme, size, label] of [['light', [390, 844], '390-light'], ['dark', [390, 844], '390-dark'], ['dark', [1280, 860], '1280-dark']]) {
    await open(`#/cluster/${IDS.a}`, fakeFor(rows), { size, theme });
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
    await b.sleep(250);
    const over = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over.map((x) => x <= 1), [true, true], `${label}: no sideways scroll ${over}`);
    const name = await b.eval(`(() => { const e = document.querySelector('.ch-name'); const r = e.getBoundingClientRect(); const pr = document.querySelector('.cluster-head').getBoundingClientRect(); return { inside: r.right <= pr.right + 1, truncated: e.scrollWidth > e.clientWidth }; })()`);
    assert.equal(name.inside, true, `${label}: the long name stays inside the head`);
    // Contrast of the small text against what it sits on.
    const ratios = await b.eval(`(() => { const contrast = ${CONTRAST_JS}; return ['.ch-parent', '.ch-name', '.ch-facts [data-field="steps"]', '.cluster-worker [data-field="gen"]'].map((s) => { const e = document.querySelector(s); return e ? [s, contrast(e).ratio] : [s, null]; }); })()`);
    for (const [sel, ratio] of ratios) assert.ok(ratio === null || ratio >= 4.5, `${label}: ${sel} contrast ${ratio}`);
    await shot(`name-steps-speed-page-${label}`);
    await open('#/clusters', fakeFor(rows), { size, theme });
    await b.waitFor(`document.querySelectorAll('.cluster-card').length === 2`);
    const over2 = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over2.map((x) => x <= 1), [true, true], `${label}: the overview does not scroll sideways ${over2}`);
    const ratios2 = await b.eval(`(() => { const contrast = ${CONTRAST_JS}; return ['.cc-title', '.cc-parent', '[data-field="steps"]:not([hidden])'].map((s) => { const e = document.querySelector('.cluster-card ' + s); return e ? [s, contrast(e).ratio] : [s, null]; }); })()`);
    for (const [sel, ratio] of ratios2) assert.ok(ratio === null || ratio >= 4.5, `${label}: card ${sel} contrast ${ratio}`);
    await shot(`name-steps-overview-${label}`);
  }
  void summarizeCluster;
});
