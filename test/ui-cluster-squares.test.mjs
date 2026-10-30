// The cluster screens as small squares, in a real browser: the cluster page (a
// band of progress and speed, then one small tile per worker, nothing long on
// it), the drawer a tile opens (the whole task, where it works, its time, its
// subagents as squares and each one's detail), the page that lists every
// cluster, and the number beside its link in the sidebar.
//
// The Hub here is scripted (window.__fake, test/fixtures/cluster-fake.mjs): what
// is checked is what the page shows for what it was told, and how it behaves.
// The same screens against a real Hub with a fake computer are in
// test/e2e-cluster-squares.test.mjs, and against the real Kimi in
// test/e2e-cluster-squares-kimi.test.mjs.
//
// CLUSTER_UI_SHOTS=<dir> also saves screenshots of every look to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skipReason, uiSession, CONTRAST_JS } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';
import { FAKE_SCRIPT, CID, T0, W, SUB, CLUSTER, rowOf, TIMING, MEMORY, SPEED, NO_SPEED, countsOf, fakeHub } from './fixtures/cluster-fake.mjs';
import { summarizeCluster, totalsOf } from '../public/js/cluster-model.js';

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

// ------------------------------------------------------------------- data

const mix = (n, spec, patch = () => ({})) => Array.from({ length: n }, (_, i) => SUB(i, { status: spec(i), ...patch(i) }));
const tasks8 = Array.from({ length: 8 }, (_, i) => ({ index: i, title: `任務 ${i + 1}`, status: i < 3 ? 'done' : i < 6 ? 'running' : 'pending', workerSessionId: i < 6 ? `s_w${i + 1}` : null, startedAt: T0 - 100_000, finishedAt: i < 3 ? T0 - 5000 : null, attempts: 1, error: null }));
const BIG = mix(128, (i) => ['running', 'done', 'done', 'failed', 'unknown', 'awaiting'][i % 6]);
const SIX = () => [
  W(1, { title: '帳本領取登記核心：租約欄位＋claim/release＋原生接線', subagents: mix(8, (i) => (i < 5 ? 'running' : 'done')), done: 1, taskIndex: 0, speed: SPEED(64.2, 5.1) }),
  W(2, { title: '凱恩：帳本領單→Intent、寫回綁帳本id、已證實延伸', subagents: BIG, done: 2, taskIndex: 1, speed: SPEED(120.4, 9) }),
  W(3, { title: '新夜安：帳本領單→propose_intents', subagents: [], done: 0, taskIndex: 2, speed: NO_SPEED() }),
  W(4, { title: '自然停才交auditor＋清查', status: 'idle', finishedAt: T0 - 5000, subagents: mix(4, () => 'done'), done: 3, taskIndex: null, speed: SPEED(0, 0) }),
  W(5, { title: '歸因計數＋plugin.json開關', status: 'error', finishedAt: T0 - 1000, subagents: mix(3, (i) => (i === 0 ? 'failed' : 'cancelled')), done: 1, taskIndex: null, speed: SPEED(2, 1) }),
  W(6, { title: '雜項修正：Caido閥後預檢', status: 'awaiting_permission', subagents: mix(6, (i) => (i < 2 ? 'awaiting' : 'running')), done: 0, taskIndex: 5, speed: SPEED(18.3, 2) }),
];
const SIX_CLUSTER = (patch = {}) => CLUSTER({ workers: SIX(), tasks: tasks8, ...patch });
const fullFake = (c = SIX_CLUSTER(), extra = {}) => ({
  clusters: { [c.id]: c },
  parents: { s_kimi: [c] },
  list: [rowOf(c)],
  timing: { s_w1: TIMING(), s_w2: TIMING({ modelMs: null, unmeasured: ['modelMs：閘道請求無法對應到這個對話'], currentKey: { id: 'dk_0001', gateway: 'opencode-go', gatewayLabel: 'OpenCode Go', hint: 'a1b2', removed: false, lastUsedAt: T0 - 5000, machineId: 'm1', distribution: 'sticky' } }), s_w3: { __error: { status: 404, message: 'HTTP 404' } } },
  memory: { [c.id]: MEMORY() },
  ...extra,
});

// ---------------------------------------------------------------- helpers

async function open(hash, { fake = fullFake(), size = [1280, 860], look = null } = {}) {
  await setFake(fake);
  await b.size(size[0], size[1], size[0] < 700);
  await b.goto(ui.hub.url + '#/', 200);
  if (look) await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(look.look)}); localStorage.setItem('hubTheme', ${JSON.stringify(look.theme)})`);
  else await b.eval(`localStorage.removeItem('hubPalette'); localStorage.removeItem('hubTheme')`);
  await b.goto(ui.hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
}
const openCluster = async (opts) => {
  await open(`#/cluster/${CID}`, opts);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length > 0`);
  await b.sleep(250);
};
const shot = async (name) => SHOTS && b.shot(path.join(SHOTS, `${name}.png`));
const emit = (cluster) => b.eval(`window.__emit(${JSON.stringify({ t: 'cluster', cluster })})`);
const tileOf = (n) => `.cluster-worker[data-session="s_w${n}"]`;
const drawerOpen = () => b.eval(`(() => { const d = document.querySelector('.cluster-drawer'); return Boolean(d && !d.hidden && d.classList.contains('on')); })()`);
async function openDrawer(n) {
  await b.click(tileOf(n));
  await b.waitFor(`document.querySelector('.cluster-drawer.on')`);
  await b.sleep(250);
}
const press = async (key, code = key) => {
  const vk = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[key] || 0;
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await b.sleep(80);
};
const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.trim() ?? null`);
const perRow = (sel) => b.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})]; return e.filter((x) => x.offsetTop === e[0].offsetTop).length; })()`);
const FORBIDDEN_ETA = /ETA|剩餘|預計|預估|還要|remaining/i;

// ------------------------------------------------------------ the page

test('the page is an overview: a progress band with the speed and the counts, then one small tile per worker with nothing long on it', { skip }, async () => {
  await openCluster();
  const tiles = await b.eval(`[...document.querySelectorAll('.cluster-worker')].map((t) => ({
    session: t.dataset.session,
    title: t.querySelector('.cluster-worker-title').innerText,
    state: t.querySelector('.cluster-worker-state').innerText.trim(),
    place: t.querySelector('.cluster-worker-queue').innerText.trim(),
    speed: t.querySelector('[data-field="speed"]').innerText.trim(),
    speedTitle: t.querySelector('[data-field="speed"]').title,
    barNow: t.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),
    minis: t.querySelectorAll('.cw-mini').length,
    more: t.querySelector('.cw-mini-more')?.innerText ?? null,
    sub: t.querySelector('[data-field="subcount"]')?.innerText ?? '',
    text: t.innerText,
    height: Math.round(t.getBoundingClientRect().height),
  }))`);
  assert.equal(tiles.length, 6);
  assert.deepEqual(tiles.map((t) => t.state), ['執行中', '執行中', '執行中', '已完成', '出錯', '等你核准']);
  assert.deepEqual(tiles.map((t) => t.place), ['第 1/8 條', '第 2/8 條', '第 3/8 條', '做完 3 條', '做完 1 條', '第 6/8 條']);
  assert.deepEqual(tiles.map((t) => t.speed), ['64 tok/s', '120 tok/s', '—', '0 tok/s', '2 tok/s', '18 tok/s']);
  assert.deepEqual(tiles.map((t) => t.sub), ['子代理 5/8', '子代理 43/128', '', '子代理 0/4', '子代理 0/3', '子代理 6/6'], 'working over opened, from the counts the Hub sent');
  assert.equal(tiles[0].title, '帳本領取登記核心：租約欄位＋claim/release＋原生接線');
  // One row of little squares at most: the ones that need a look first, then "+N" for the rest.
  assert.deepEqual(tiles.map((t) => t.minis), [8, 12, 0, 4, 3, 6]);
  assert.equal(tiles[1].more, '+116');
  // Nothing long: no task text, no branch, no worktree, no reason, no sentence of progress.
  for (const t of tiles) {
    assert.ok(t.text.length < 90, `a tile is a few words, not a paragraph: ${JSON.stringify(t.text)}`);
    assert.doesNotMatch(t.text, /把第|cluster\/c_|worktree|量不到：|正在改|\/home\//, t.session);
    assert.ok(t.height < 150, `${t.session} is ${t.height}px tall`);
  }
  // A speed the records could not say is a dash on the tile; the reason is a tooltip, the long form is in the drawer.
  assert.equal(tiles[2].speedTitle, '量不到（原因在詳細裡）');
  assert.doesNotMatch(tiles[2].text, /DeepSeek 號池/);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker .cluster-timing, .cluster-worker .cluster-kv, .cluster-worker-task, .cluster-worker-progress').length`), 0);
  // Each tile is one control: a button with a name that says everything the tile shows.
  const aria = await b.eval(`[...document.querySelectorAll('.cluster-worker')].map((t) => [t.getAttribute('role'), t.tabIndex, t.getAttribute('aria-label')])`);
  assert.deepEqual(aria.map((a) => a[0]), Array(6).fill('button'));
  assert.deepEqual(aria.map((a) => a[1]), Array(6).fill(0));
  assert.match(aria[1][2], /凱恩.*執行中.*第 2\/8 條.*速度 120 tok\/s.*子代理 128：22 執行中・21 等你核准・43 完成・21 失敗或取消・21 狀態未知.*按下查看詳細/);
  assert.match(aria[2][2], /速度 量不到/);
  await shot('page-1280');
});

test('the band: how far the whole cluster is, how long it has run, how fast it goes, how many workers and subagents work - all from the one summary', { skip }, async () => {
  const c = SIX_CLUSTER();
  await openCluster({ fake: fullFake(c) });
  const sum = summarizeCluster(c);
  const band = await b.eval(`({
    status: document.querySelector('[data-field="status"]').innerText.trim(),
    progress: document.querySelector('[data-field="progress"]').innerText.trim(),
    barNow: document.querySelector('.ch-bar').getAttribute('aria-valuenow'),
    barLabel: document.querySelector('.ch-bar').getAttribute('aria-label'),
    elapsed: document.querySelector('[data-field="elapsed"]').innerText.trim(),
    speed: [...document.querySelectorAll('[data-stat="speed"] [data-field]')].map((e) => e.innerText.trim()),
    workers: [...document.querySelectorAll('[data-stat="workers"] [data-field]')].map((e) => e.innerText.trim()),
    subs: [...document.querySelectorAll('[data-stat="subagents"] [data-field]')].map((e) => e.innerText.trim()),
    unit: document.querySelector('[data-stat="speed"] .ch-stat-unit').innerText.trim(),
  })`);
  assert.equal(band.status, '進行中');
  assert.equal(band.progress, '任務 3/8 完成');
  assert.equal(band.barNow, '38');
  assert.equal(band.barLabel, '任務 3／8 完成');
  assert.match(band.elapsed, /^已跑 \d+ 分 \d+ 秒$/, 'since it was made, to now');
  assert.equal(band.speed[0], String(Math.round(sum.speed.tokensPerSecond)), 'the sum of the workers the records could speak for');
  assert.equal(band.unit, 'tok/s');
  assert.match(band.speed[1], /請求 \d+／分/);
  assert.match(band.speed[1], /5\/6 個工作者量得到/, 'and says that one could not');
  assert.equal(band.workers[0], String(sum.workersRunning));
  assert.equal(sum.workersRunning, 4);
  assert.equal(band.subs[0], String(sum.subagents.running + sum.subagents.awaiting));
  assert.match(band.subs[1], new RegExp(`共開過 ${sum.subagents.total} 個`));
  assert.match(band.subs[1], /23 個等你核准/);
  const page = await text('.cluster-page');
  assert.doesNotMatch(page, FORBIDDEN_ETA, 'nothing says how long anything will take');
  // A cluster whose subagents the Hub did not count says so, not zero.
  const old = SIX_CLUSTER({ workers: SIX().map(({ subagentCounts, subagents, subagentsOlder, ...w }) => w) });
  await open(`#/cluster/${CID}`, { fake: fullFake(old) });
  await b.waitFor(`document.querySelector('[data-stat="subagents"]')`);
  assert.equal(await text('[data-stat="subagents"] [data-field="num"]'), '—');
  assert.equal(await text('[data-stat="subagents"] [data-field="sub"]'), '量不到');
});

test('4 to 6 tiles in a row on a desktop and a wide screen, two on a phone, and nothing runs off the side', { skip }, async () => {
  for (const [name, size, lo, hi] of [['1280', [1280, 860], 4, 6], ['1600', [1600, 900], 5, 6], ['390', [390, 844], 2, 2]]) {
    await openCluster({ size });
    const n = await perRow('.cluster-worker');
    assert.ok(n >= lo && n <= hi, `${name}: ${n} tiles in a row`);
    const over = await b.eval(`(() => { const p = document.querySelector('.cluster-page'); return [p.scrollWidth - p.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]; })()`);
    assert.deepEqual(over.map((x) => x <= 1), [true, true], `${name}: no sideways scroll ${over}`);
    await shot(`page-${name}`);
  }
});

test('the folded parts (task queue, memory) are closed, say their summary on one line, and stay as the person left them while the cluster moves', { skip }, async () => {
  await openCluster();
  const folds = await b.eval(`[...document.querySelectorAll('details.cluster-fold')].map((d) => [d.open, d.querySelector('summary').innerText.replace(/\\s+/g, ' ').trim()])`);
  assert.deepEqual(folds.map((f) => f[0]), [false, false]);
  assert.equal(folds[0][1], '任務佇列 3/8 完成 · 3 條進行中 · 2 條等待中');
  assert.match(folds[1][1], /^叢集記憶 \d+ B · .*更新$/);
  await b.eval(`document.querySelector('details.cluster-queue summary').click()`);
  await b.sleep(100);
  assert.equal(await b.eval(`document.querySelector('details.cluster-queue').open`), true);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-queue-row').length`), 8);
  const next = SIX_CLUSTER();
  next.workers[0].progress = '別的進度';
  await emit(next);
  await b.sleep(300);
  assert.equal(await b.eval(`document.querySelector('details.cluster-queue').open`), true, 'the queue stays open when the cluster moves');
});

// ------------------------------------------------------------- the drawer

test('pressing a tile (or Enter on it) opens the drawer with the whole task, where it works and its time; Esc, the scrim and the × close it and the focus goes back to the tile', { skip }, async () => {
  await openCluster();
  await b.eval(`window.__gets.length = 0`);
  await b.eval(`document.querySelector(${JSON.stringify(tileOf(2))}).focus()`);
  await press('Enter');
  await b.waitFor(`document.querySelector('.cluster-drawer.on')`);
  await b.sleep(300);
  const d = await b.eval(`(() => {
    const el = document.querySelector('.cluster-drawer');
    const q = (s) => el.querySelector(s)?.innerText.trim() ?? null;
    return {
      role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), label: document.getElementById(el.getAttribute('aria-labelledby'))?.innerText,
      title: q('.cd-title'), state: q('.cluster-worker-state'), task: q('[data-field="task"]'), queue: q('[data-field="worker-queue"]'), progress: q('[data-field="progress"]'),
      branch: q('[data-field="branch"]'), worktree: q('[data-field="worktree"]'), copy: el.querySelector('[data-action="copy-path"]')?.getAttribute('aria-label'),
      swarm: q('[data-native-swarm]'), open: el.querySelector('[data-action="open-worker"]')?.getAttribute('href'),
      tokens: q('[data-field="tokens"]'), requests: q('[data-field="requests"]'),
      timing: Boolean(el.querySelector('.cluster-timing .cluster-bar')), inside: el.contains(document.activeElement),
    };
  })()`);
  assert.deepEqual([d.role, d.modal], ['dialog', 'true']);
  assert.equal(d.label, d.title);
  assert.equal(d.title, '凱恩：帳本領單→Intent、寫回綁帳本id、已證實延伸');
  assert.equal(d.state, '執行中');
  assert.match(d.task, /把第 2 區的登入錯誤訊息改好，並補測試。\n+（第二段）先讀 README，再動手。/, 'the whole task, as it was written');
  assert.match(d.queue, /正在做第 2\/8 條/);
  assert.equal(d.progress, '正在改第 2 個檔案');
  assert.equal(d.branch, `cluster/${CID}/w2`);
  assert.equal(d.worktree, `/home/user/proj-cluster-${CID}/w2`);
  assert.match(d.copy, /複製 .* 的 worktree 路徑/);
  assert.equal(d.swarm, '原生 Swarm 開');
  assert.equal(d.open, '#/s/s_w2');
  assert.equal(d.tokens, '最近 2 分鐘輸出 120 tok/s');
  assert.equal(d.requests, '請求 9／分');
  assert.equal(d.timing, true, 'the time breakdown is in the drawer');
  assert.equal(d.inside, true, 'the focus moved into the drawer');
  // Time was asked for this one worker only, when its drawer opened.
  assert.deepEqual((await b.eval('window.__gets')).filter((u) => /timing/.test(u)), ['/api/sessions/s_w2/timing']);
  await shot('drawer-1280');

  await press('Escape');
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  assert.equal(await b.eval(`document.activeElement.dataset.session`), 's_w2', 'the focus is back on the tile it came from');
  await b.waitFor(`document.querySelector('.cluster-drawer')?.hidden`);
  // The scrim, and the × button.
  await openDrawer(1);
  await b.eval(`document.querySelector('.cd-scrim').click()`);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  await openDrawer(1);
  await b.click('[data-action="close-drawer"]');
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  assert.equal(await drawerOpen(), false);
});

test('Tab goes round inside the open drawer and never reaches the page behind it', { skip }, async () => {
  await openCluster();
  await openDrawer(2);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    await press('Tab');
    assert.equal(await b.eval(`document.querySelector('.cluster-drawer').contains(document.activeElement)`), true, `after ${i + 1} Tab presses the focus is still in the drawer`);
    seen.add(await b.eval(`(() => { const e = document.activeElement; return e.tagName + '|' + (e.dataset.action || e.dataset.id || e.getAttribute('aria-label') || e.className); })()`));
  }
  // (The key really moves the focus: it went through the buttons of the drawer, and came round.)
  assert.ok(seen.size >= 4, `Tab visited ${seen.size} different controls`);
  for (let i = 0; i < 6; i++) {
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    assert.equal(await b.eval(`document.querySelector('.cluster-drawer').contains(document.activeElement)`), true, 'and backwards');
  }
});

test('a speed the records could not say is a dash on the tile, and in the drawer the reason in full; a deleted worker has no time to read', { skip }, async () => {
  await openCluster();
  await openDrawer(3);
  const why = await text('[data-field="speed-why"]');
  assert.match(why, /^—　量不到：這個對話用的不是 DeepSeek 號池/);
  assert.equal(await b.eval(`document.querySelector('[data-field="tokens"]')`), null);
  const ws = SIX();
  ws[2] = { ...ws[2], status: 'deleted' };
  await openCluster({ fake: fullFake(SIX_CLUSTER({ workers: ws })) });
  assert.equal(await text(`${tileOf(3)} .cluster-worker-queue`), '已刪除');
  await openDrawer(3);
  assert.match(await text('.cluster-timing-failed'), /已被刪除/);
  assert.equal(await b.eval(`document.querySelector('[data-action="open-worker"]').hidden`), true, 'no conversation to open');
  assert.doesNotMatch(await text('.cluster-drawer'), FORBIDDEN_ETA, 'and nothing in the drawer says how long anything will take');
});

test('the drawer says which key of the pool the worker uses: the gateway and the last four characters; "sticky" is noted; a removed key, no record yet, and a Hub that does not say are each said as they are; nothing else of the key is shown', { skip }, async () => {
  const key = (patch = {}) => ({ id: 'dk_9f8e7d_SECRETID', gateway: 'opencode-go', gatewayLabel: 'OpenCode Go', hint: 'a1b2', removed: false, lastUsedAt: 1_800_000_123_456, machineId: 'm_SECRETMACHINE', distribution: 'relay', ...patch });
  const timing = {
    s_w1: TIMING({ currentKey: key({ distribution: 'sticky' }) }),
    s_w2: TIMING({ currentKey: key({ gateway: 'commandcode', gatewayLabel: 'Command Code', hint: 'zz99' }) }),
    s_w3: TIMING({ currentKey: key({ hint: null, removed: true }) }),
    s_w4: TIMING({ currentKey: null }),
    s_w5: TIMING(), // a Hub that does not say
  };
  await openCluster({ fake: fullFake(SIX_CLUSTER(), { timing }) });
  const lineOf = async (n) => {
    await openDrawer(n);
    await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing')`);
    const r = await b.eval(`(() => { const sec = document.querySelector('.cluster-drawer [data-sec="key"]'); return { shown: Boolean(sec && !sec.hidden && sec.getClientRects().length), line: sec?.querySelector('[data-field="key"]')?.innerText.trim() ?? null, note: sec?.querySelector('[data-field="key-note"]')?.innerText.trim() ?? null, all: document.querySelector('.cluster-drawer').innerText }; })()`);
    await b.eval(`document.querySelector('.cd-scrim').click()`);
    await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
    return r;
  };
  const w1 = await lineOf(1);
  assert.deepEqual([w1.shown, w1.line, w1.note], [true, '用的 key：OpenCode Go …a1b2', '這個對話固定用這一把']);
  const w2 = await lineOf(2);
  assert.deepEqual([w2.shown, w2.line, w2.note], [true, '用的 key：Command Code …zz99', null], 'relayed over the pool: no note');
  const w3 = await lineOf(3);
  assert.deepEqual([w3.shown, w3.line], [true, '用的 key：key 已從清單移除']);
  const w4 = await lineOf(4);
  assert.deepEqual([w4.shown, w4.line], [true, '用的 key：還沒有請求紀錄']);
  const w5 = await lineOf(5);
  assert.equal(w5.shown, false, 'a Hub that does not say the key: nothing about it');
  for (const r of [w1, w2, w3, w4, w5]) for (const secret of ['SECRETID', 'SECRETMACHINE', '1800000123456', 'dk_9f8e7d']) assert.ok(!r.all.includes(secret), `${secret} is nowhere in the drawer`);
  // The tile never shows it.
  assert.doesNotMatch(await text('.cluster-workers'), /用的 key|a1b2|OpenCode/);
  // It follows the Hub: the key changes while the drawer is open (the time is asked for again).
  await openDrawer(1);
  await b.waitFor(`document.querySelector('.cluster-drawer [data-field="key"]')?.innerText.includes('a1b2')`);
  await b.eval(`window.__fake.timing.s_w1 = ${JSON.stringify(TIMING({ currentKey: key({ hint: 'c3d4', distribution: 'relay' }) }))}`);
  await b.waitFor(`document.querySelector('.cluster-drawer [data-field="key"]')?.innerText.includes('c3d4')`, { timeout: 14_000, label: 'the key is read again' });
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer [data-field="key-note"]')`), null, 'and the "sticky" note goes with it');
  await shot('drawer-key-1280');
});

// --------------------------------------------------- the subagent squares

test('the squares: one per subagent, a glyph as well as a colour, a legend, a count line, a name that says whose and what; arrow keys move between them', { skip }, async () => {
  await openCluster();
  await openDrawer(1);
  const g = await b.eval(`(() => {
    const cells = [...document.querySelectorAll('.cluster-drawer .sa-cell')];
    return {
      line: document.querySelector('[data-field="subagent-line"]').innerText.trim(),
      cells: cells.map((c) => [c.dataset.group, c.innerText.trim(), c.getAttribute('aria-label'), c.getAttribute('aria-expanded'), c.tabIndex, c.title]),
      legend: [...document.querySelectorAll('.sa-legend li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim()),
      legendLabel: document.querySelector('.sa-legend').getAttribute('aria-label'),
      group: document.querySelector('.sa-grid').getAttribute('role') + ':' + document.querySelector('.sa-grid').getAttribute('aria-label'),
    };
  })()`);
  assert.equal(g.line, '子代理 8：5 執行中・3 完成');
  assert.equal(g.cells.length, 8);
  assert.deepEqual(g.cells.map((c) => c[0]), ['running', 'running', 'running', 'running', 'running', 'done', 'done', 'done']);
  assert.deepEqual(g.cells.map((c) => c[1]), ['', '', '', '', '', '✓', '✓', '✓'], 'done says ✓ in the square (the running dot is drawn)');
  assert.equal(g.cells[0][2], '子代理 1，「分包 #1 (coder)」，執行中，最新動作 執行 wc -l /home/user/proj/f0.md');
  assert.equal(g.cells[7][2], '子代理 8，「分包 #8 (coder)」，完成，最新動作 執行 wc -l /home/user/proj/f7.md');
  assert.ok(g.cells.every((c) => c[2] === c[5]), 'the tooltip is the same words');
  assert.deepEqual(g.cells.map((c) => c[4]), [0, -1, -1, -1, -1, -1, -1, -1], 'one stop for the keyboard');
  assert.deepEqual(g.legend, ['執行中', '! 等你核准', '✓ 完成', '✕ 失敗或取消', '? 狀態未知']);
  assert.equal(g.legendLabel, '圖例');
  assert.equal(g.group, 'group:子代理');
  // The four kinds that are not running, each with its own glyph (never a colour alone).
  await b.eval(`document.querySelector('.cd-scrim').click()`);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  await openDrawer(5);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-drawer .sa-cell')].map((c) => [c.dataset.status, c.dataset.group, c.innerText.trim(), c.getAttribute('aria-label').split('，')[2]])`), [['failed', 'failed', '✕', '失敗'], ['cancelled', 'failed', '✕', '已中斷'], ['cancelled', 'failed', '✕', '已中斷']]);
  await b.eval(`document.querySelector('.cd-scrim').click()`);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  await openDrawer(6);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-drawer .sa-cell')].slice(0, 3).map((c) => [c.dataset.status, c.innerText.trim()])`), [['awaiting', '!'], ['awaiting', '!'], ['running', '']]);
  await b.eval(`document.querySelector('.cd-scrim').click()`);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
  await openDrawer(2);
  const unknown = await b.eval(`[...document.querySelectorAll('.cluster-drawer .sa-cell[data-status="unknown"]')].slice(0, 1).map((c) => c.innerText.trim())`);
  assert.deepEqual(unknown, ['?']);

  // Arrow keys, Home and End.
  await b.eval(`document.querySelector('.cluster-drawer .sa-cell').focus()`);
  await press('ArrowRight');
  assert.equal(await b.eval(`document.activeElement.dataset.id`), 'agent-1');
  await press('ArrowLeft');
  assert.equal(await b.eval(`document.activeElement.dataset.id`), 'agent-0');
  await press('End');
  assert.equal(await b.eval(`document.activeElement.dataset.id`), 'agent-39', 'the last square that is shown');
  await press('Home');
  assert.equal(await b.eval(`document.activeElement.dataset.id`), 'agent-0');
  await press('ArrowDown');
  const second = Number((await b.eval(`document.activeElement.dataset.id`)).slice(6));
  assert.ok(second > 4, `Down is a row further (${second})`);
});

test('a square opens that subagent\'s detail; Esc closes the detail first, then the drawer; 在對話中查看 goes to the worker\'s conversation', { skip }, async () => {
  await openCluster();
  await openDrawer(1);
  await b.click('.cluster-drawer .sa-cell[data-id="agent-2"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  const d = await b.eval(`(() => {
    const el = document.querySelector('.sa-detail');
    const f = (n) => el.querySelector('[data-field="' + n + '"]')?.innerText.trim() ?? null;
    return { role: el.getAttribute('role') + ':' + el.getAttribute('aria-label'), title: f('title'), state: f('state'), model: f('model'), steps: f('steps'), last: f('last-action'), started: f('started'), finished: f('finished'), span: f('span'), reason: f('reason'), expanded: document.querySelector('.sa-cell[data-id="agent-2"]').getAttribute('aria-expanded') };
  })()`);
  assert.deepEqual([d.role, d.title, d.state, d.expanded], ['region:子代理詳細', '分包 #3 (coder)', '執行中', 'true']);
  assert.match(d.model, /deepseek-v4\.1-flash.* · 思考 max/i, 'the model Kimi reported, with its thinking');
  assert.equal(d.steps, '5 步');
  assert.equal(d.last, '執行 wc -l /home/user/proj/f2.md');
  assert.match(d.started, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(d.span, /^已跑 \d+ 分 \d+ 秒$|^已跑 \d+\.\d 秒$/);
  assert.equal(d.finished, null, 'it has not finished: no end to show');
  assert.equal(d.reason, null);
  await shot('detail-1280');

  // A second press on the same square closes it; another opens that one instead.
  await b.click('.cluster-drawer .sa-cell[data-id="agent-6"]');
  await b.waitFor(`document.querySelector('.sa-detail [data-field="title"]').innerText.includes('#7')`);
  const done = await b.eval(`(() => { const f = (n) => document.querySelector('.sa-detail [data-field="' + n + '"]')?.innerText.trim() ?? null; return [f('state'), f('finished'), f('span')]; })()`);
  assert.equal(done[0], '完成');
  assert.match(done[1], /^\d{4}-/, 'a finished one has an end');
  // Esc: the detail, and then the drawer.
  await press('Escape');
  assert.equal(await b.eval(`document.querySelector('.sa-detail').hidden`), true);
  assert.equal(await drawerOpen(), true, 'the first Esc closed only the detail');
  assert.equal(await b.eval(`document.activeElement.dataset.id`), 'agent-6', 'and the focus went back to its square');
  await press('Escape');
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);

  // 在對話中查看: the worker whose conversation the scratch Hub has (s_ds).
  const ws = SIX();
  ws[0] = { ...ws[0], sessionId: 's_ds' };
  await openCluster({ fake: fullFake(SIX_CLUSTER({ workers: ws })) });
  await b.click('.cluster-worker[data-session="s_ds"]');
  await b.waitFor(`document.querySelector('.cluster-drawer.on')`);
  await b.click('.cluster-drawer .sa-cell[data-id="agent-1"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  await b.click('[data-action="view-in-chat"]');
  await b.waitFor(`location.hash === '#/s/s_ds'`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer')`), null, 'the drawer is gone with the page');
});

test('a subagent that was never told its model says "—" and why; one that ended says how long it took; one the Hub is unsure of says why', { skip }, async () => {
  const list = [SUB(0, { model: null, provider: null, effort: null, modelReason: '還在等這個子代理回報它用的模型' }), SUB(1, { status: 'done', finishedAt: T0 - 90_000 + 1000 + 4200, startedAt: T0 - 90_000 + 1000 }), SUB(2, { status: 'unknown', reason: '呼叫這個子代理的工具已經結束，但它沒有回報最終狀態' }), SUB(3, { status: 'cancelled', finishedAt: null, reason: '呼叫這個子代理的工具被中斷了（例如中控台重新啟動過），它沒有回報結果' }), SUB(4, { startedAt: null })];
  const c = SIX_CLUSTER({ workers: [W(1, { subagents: list, taskIndex: 0 }), ...SIX().slice(1)] });
  await openCluster({ fake: fullFake(c) });
  await openDrawer(1);
  const pick = async (id) => {
    await b.click(`.cluster-drawer .sa-cell[data-id="${id}"]`);
    await b.waitFor(`document.querySelector('.sa-detail [data-field="title"]') && !document.querySelector('.sa-detail').hidden`);
    return b.eval(`(() => { const f = (n) => document.querySelector('.sa-detail [data-field="' + n + '"]')?.innerText.trim() ?? null; return { model: f('model'), span: f('span'), reason: f('reason'), state: f('state'), started: f('started'), finished: f('finished') }; })()`);
  };
  assert.equal((await pick('agent-0')).model, '—（還在等這個子代理回報它用的模型）');
  assert.equal((await pick('agent-1')).span, '跑了 4.2 秒');
  const u = await pick('agent-2');
  assert.deepEqual([u.state, u.reason], ['狀態未知', '呼叫這個子代理的工具已經結束，但它沒有回報最終狀態']);
  const k = await pick('agent-3');
  assert.deepEqual([k.state, k.reason, k.finished], ['已中斷', '呼叫這個子代理的工具被中斷了（例如中控台重新啟動過），它沒有回報結果', '—'], 'no end time was reported: none is shown');
  const n = await pick('agent-4');
  assert.deepEqual([n.started, n.span], ['—', '—'], 'no start was seen: no length is made up');
});

test('128 subagents: 40 squares and +88, +88 shows them all; the drawer stays inside its width on a desktop and a phone', { skip }, async () => {
  for (const size of [[1280, 860], [390, 844]]) {
    await openCluster({ size });
    await openDrawer(2);
    assert.equal(await b.eval(`document.querySelectorAll('.cluster-drawer .sa-cell').length`), 40);
    assert.equal(await text('.cluster-drawer .sa-more'), '+88');
    assert.equal(await b.eval(`document.querySelector('.cluster-drawer .sa-more').getAttribute('aria-label')`), '再顯示 88 個子代理');
    await b.click('.cluster-drawer .sa-more');
    await b.waitFor(`document.querySelectorAll('.cluster-drawer .sa-cell').length === 128`);
    assert.equal(await b.eval(`document.querySelector('.cluster-drawer .sa-more')`), null);
    const over = await b.eval(`(() => { const d = document.querySelector('.cluster-drawer'); const body = d.querySelector('.cd-body'); const r = d.getBoundingClientRect(); return { x: body.scrollWidth - body.clientWidth, outside: [...d.querySelectorAll('.sa-cell')].filter((c) => c.getBoundingClientRect().right > r.right + 1).length }; })()`);
    assert.deepEqual(over, { x: 0, outside: 0 }, `${size[0]}: nothing sticks out`);
    await shot(`drawer-128-${size[0]}`);
  }
});

// ------------------------------------------------------------- live

test('the cluster moves under an open page: numbers change, tiles stay the same elements, the open drawer keeps its place and its selected subagent', { skip }, async () => {
  const c = SIX_CLUSTER();
  await openCluster({ fake: fullFake(c) });
  await b.eval(`document.querySelectorAll('.cluster-worker').forEach((t) => (t.dataset.mark = 'kept'))`);
  await openDrawer(1);
  await b.click('.cluster-drawer .sa-cell[data-id="agent-2"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  await b.eval(`document.querySelector('.cd-body').scrollTop = 120`);

  const next = SIX_CLUSTER();
  next.workers[0] = W(1, { title: c.workers[0].title, subagents: mix(8, (i) => (i < 2 ? 'running' : 'done'), (i) => (i === 2 ? { steps: 99, lastAction: '執行 npm test' } : {})), done: 1, taskIndex: 0, speed: SPEED(7.3, 2) });
  next.workers[0].speed = SPEED(7.3, 2);
  await emit(next);
  await b.waitFor(`document.querySelector('[data-stat="subagents"] [data-field="num"]').innerText.trim() === '${summarizeCluster(next).subagents.running + summarizeCluster(next).subagents.awaiting}'`);
  assert.equal(await text('[data-stat="speed"] [data-field="num"]'), String(Math.round(summarizeCluster(next).speed.tokensPerSecond)));
  assert.equal(await text(`${tileOf(1)} [data-field="subcount"]`), '子代理 2/8');
  assert.equal(await text(`${tileOf(1)} [data-field="speed"]`), '7.3 tok/s');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker[data-mark="kept"]').length`), 6, 'no tile was torn down for a number that moved');
  // The drawer: still open, still on the same subagent, with what changed.
  assert.equal(await drawerOpen(), true);
  await b.waitFor(`document.querySelector('.sa-detail [data-field="steps"]')?.innerText.trim() === '99 步'`);
  assert.equal(await text('.sa-detail [data-field="last-action"]'), '執行 npm test');
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer .sa-cell[data-id="agent-2"]').getAttribute('aria-expanded')`), 'true');
  assert.equal(await b.eval(`document.querySelector('.cd-body').scrollTop`), 120, 'and where the person had scrolled to');
  assert.equal(await text('.cluster-drawer [data-field="subagent-line"]'), '子代理 8：2 執行中・6 完成');
  assert.equal(await text('.cluster-drawer [data-field="tokens"]'), '最近 2 分鐘輸出 7.3 tok/s');

  // The subagent it was showing is no longer in the list (the oldest are let go): the detail closes, nothing breaks.
  const gone = SIX_CLUSTER();
  gone.workers[0] = W(1, { title: c.workers[0].title, subagents: mix(8, () => 'done').slice(4), done: 1, taskIndex: 0 });
  await emit(gone);
  await b.waitFor(`document.querySelector('.sa-detail').hidden`);
  assert.equal(await drawerOpen(), true);
  // Another cluster's news is not this page's.
  await emit({ ...SIX_CLUSTER(), id: 'c_ffffffffffff', workers: [] });
  await b.sleep(200);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 6);
  // The worker is deleted meanwhile: the drawer closes with it.
  const del = SIX_CLUSTER({ workers: SIX().slice(1) });
  await emit(del);
  await b.waitFor(`!document.querySelector('.cluster-drawer.on')`);
});

test('the colours move with the motion setting: what is working breathes, and with reduced motion nothing does', { skip }, async () => {
  await openCluster();
  await openDrawer(1);
  const anim = () => b.eval(`({ bar: getComputedStyle(document.querySelector('.cw-bar-run')).animationName, mini: getComputedStyle(document.querySelector('.cw-mini[data-group="running"]')).animationName, dot: getComputedStyle(document.querySelector('.sa-cell[data-group="running"]'), '::after').animationName })`);
  const on = await anim();
  assert.ok(Object.values(on).every((n) => n !== 'none'), `breathing: ${JSON.stringify(on)}`);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await b.sleep(100);
    const off = await anim();
    assert.deepEqual(Object.values(off), ['none', 'none', 'none'], 'reduced motion: still');
  } finally {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
});

// ------------------------------------------------------------- the phone

test('on a phone the drawer is a sheet from the bottom, tiles are two across, and the page does not scroll sideways', { skip }, async () => {
  await openCluster({ size: [390, 844] });
  assert.equal(await perRow('.cluster-worker'), 2);
  await openDrawer(1);
  const r = await b.eval(`(() => { const d = document.querySelector('.cluster-drawer').getBoundingClientRect(); return { left: d.left, right: d.right, top: d.top, bottom: d.bottom, h: innerHeight, w: innerWidth }; })()`);
  assert.equal(r.left, 0);
  assert.equal(r.right, r.w);
  assert.ok(Math.abs(r.bottom - r.h) < 2, `it sits on the bottom edge: ${JSON.stringify(r)}`);
  assert.ok(r.top > r.h * 0.1 && r.top < r.h * 0.5, `a sheet, not the whole screen: top at ${r.top} of ${r.h}`);
  const sq = await b.eval(`(() => { const c = document.querySelector('.cluster-drawer .sa-cell').getBoundingClientRect(); return [c.width, c.height]; })()`);
  assert.ok(sq[0] >= 24 && sq[1] >= 24, `squares are big enough to touch: ${sq}`);
  await b.click('.cluster-drawer .sa-cell[data-id="agent-1"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  await shot('drawer-390');
  const over = await b.eval(`(() => { const e = document.documentElement; return e.scrollWidth - e.clientWidth; })()`);
  assert.ok(over <= 1);
  // The three buttons are icons here and still have names.
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-head .cluster-actions .om-btn')].map((x) => x.getAttribute('aria-label'))`), ['全部停止', '合併工作者分支', '清理']);
});

// ------------------------------------------------------ every cluster

const LIST_CLUSTERS = () => {
  const running = SIX_CLUSTER({ id: 'c_aaaaaaaaaaaa', createdAt: T0 - 600_000 });
  const newer = CLUSTER({
    id: 'c_bbbbbbbbbbbb',
    parentId: 's_ds',
    createdAt: T0 - 60_000,
    workers: [W(1, { subagents: mix(12, (i) => (i < 9 ? 'running' : 'done')), taskIndex: 0, speed: SPEED(88, 7) }), W(2, { subagents: [], taskIndex: 1, speed: NO_SPEED() })],
    tasks: tasks8.slice(0, 4),
  });
  const done = CLUSTER({ id: 'c_cccccccccccc', parentId: 's_kimi', status: 'done', createdAt: T0 - 3_600_000, workers: [W(1, { status: 'idle', finishedAt: T0 - 5000, taskIndex: null, subagents: mix(3, () => 'done'), speed: SPEED(0, 0) })], tasks: [{ ...tasks8[0], status: 'done', finishedAt: T0 - 5000 }] });
  return [done, running, newer];
};
const listFake = (cs = LIST_CLUSTERS()) => ({ clusters: Object.fromEntries(cs.map((c) => [c.id, c])), list: cs.map((c) => rowOf(c, c.parentId === 's_ds' ? 'DeepSeek chat' : 'Kimi chat with subagents')) });

test('#/clusters lists every cluster of every conversation, the working ones first; big numbers over all of them; a card is a link to its cluster', { skip }, async () => {
  const cs = LIST_CLUSTERS();
  await open('#/clusters', { fake: listFake(cs) });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  await b.sleep(200);
  const rows = cs.map((c) => rowOf(c));
  const t = totalsOf(rows);
  const stats = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cl-stat')].map((s) => [s.dataset.stat, [s.querySelector('[data-field="num"]').innerText.trim(), s.querySelector('.cl-stat-label').innerText.trim(), s.querySelector('[data-field="sub"]')?.innerText.trim() ?? null]]))`);
  assert.deepEqual(stats['subagents-running'], [String(t.subagentsRunning), '執行中子代理', `共開過 ${t.subagentsOpened} 個`]);
  assert.deepEqual(stats['workers-running'], [String(t.workersRunning), '執行中工作者', `${t.active} 個叢集進行中`]);
  assert.equal(stats.speed[0], String(Math.round(t.tokensPerSecond)));
  assert.equal(stats.speed[1], '目前總速度');
  assert.equal(t.active, 2);
  const cards = await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => ({
    id: c.dataset.cluster, href: c.getAttribute('href'), title: c.querySelector('.cc-title').innerText, state: c.querySelector('.cc-state').innerText.trim(),
    progress: c.querySelector('.cc-progress').innerText, speed: c.querySelector('[data-field="speed"]').innerText.replace(/\\s+/g, ' ').trim(), speedTitle: c.querySelector('[data-field="speed"]').title,
    workers: c.querySelector('[data-field="workers"]').innerText, subs: c.querySelector('[data-field="subagents"]').innerText, aria: c.getAttribute('aria-label'), text: c.innerText,
  }))`);
  assert.deepEqual(cards.map((c) => c.id), ['c_bbbbbbbbbbbb', 'c_aaaaaaaaaaaa', 'c_cccccccccccc'], 'working first, newest first; then the finished');
  assert.deepEqual(cards.map((c) => c.href), ['#/cluster/c_bbbbbbbbbbbb', '#/cluster/c_aaaaaaaaaaaa', '#/cluster/c_cccccccccccc']);
  assert.deepEqual(cards.map((c) => c.title), ['DeepSeek chat', 'Kimi chat with subagents', 'Kimi chat with subagents']);
  assert.deepEqual(cards.map((c) => c.state), ['進行中', '進行中', '已完成']);
  assert.deepEqual(cards.map((c) => c.progress), ['3/4', '3/8', '1/1']);
  assert.deepEqual(cards.map((c) => c.workers), ['工作者 2/2', '工作者 4/6', '工作者 0/1']);
  assert.deepEqual(cards.map((c) => c.subs), ['子代理 9/12', '子代理 54/149', '子代理 0/3']);
  assert.equal(cards[0].speed, '88 tok/s');
  assert.match(cards[0].aria, /DeepSeek chat，進行中，任務 3／4 完成，速度 88 tok\/s，子代理 12：9 執行中・3 完成/);
  for (const c of cards) {
    assert.ok(c.text.length < 80, `a card is a few words: ${JSON.stringify(c.text)}`);
    assert.doesNotMatch(c.text, FORBIDDEN_ETA);
  }
  await shot('list-1280');
  await b.click('.cluster-card[data-cluster="c_aaaaaaaaaaaa"]');
  await b.waitFor(`location.hash === '#/cluster/c_aaaaaaaaaaaa'`);
});

test('the list follows the cluster messages: numbers change, a new cluster appears, the order follows, nothing is fetched again', { skip }, async () => {
  const cs = LIST_CLUSTERS();
  await open('#/clusters', { fake: listFake(cs) });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  await b.eval(`window.__gets.length = 0; document.querySelectorAll('.cluster-card').forEach((c) => (c.dataset.mark = 'kept'))`);
  const speedOf = async (id) => (await text(`.cluster-card[data-cluster="${id}"] [data-field="speed"]`)).replace(/\s+/g, ' ');
  assert.equal(await speedOf('c_bbbbbbbbbbbb'), '88 tok/s');
  // One cluster's workers speed up and open more subagents.
  const b2 = cs[2];
  const faster = { ...b2, workers: [W(1, { subagents: mix(20, () => 'running'), taskIndex: 0, speed: SPEED(300, 9) }), b2.workers[1]] };
  await emit(faster);
  await b.waitFor(`document.querySelector('.cl-stat[data-stat="subagents-running"] [data-field="num"]').innerText.trim() === '${totalsOf([rowOf(cs[0]), rowOf(cs[1]), rowOf(faster)]).subagentsRunning}'`);
  assert.equal(await speedOf('c_bbbbbbbbbbbb'), '300 tok/s');
  assert.equal(await text('.cl-stat[data-stat="speed"] [data-field="num"]'), String(Math.round(totalsOf([rowOf(cs[0]), rowOf(cs[1]), rowOf(faster)]).tokensPerSecond)));
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-card[data-mark="kept"]').length`), 3, 'cards are updated in place');
  // The finished one is finished; a brand new cluster takes the first place; the oldest working one is second.
  const fresh = CLUSTER({ id: 'c_dddddddddddd', parentId: 's_kimi', createdAt: Date.now(), workers: [W(1, { subagents: mix(2, () => 'running') })], tasks: tasks8.slice(0, 2) });
  await emit(fresh);
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 4`);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => c.dataset.cluster)`), ['c_dddddddddddd', 'c_bbbbbbbbbbbb', 'c_aaaaaaaaaaaa', 'c_cccccccccccc']);
  // The last working cluster ends: the order and the numbers follow.
  await emit({ ...fresh, status: 'done', workers: [W(1, { status: 'idle', finishedAt: Date.now(), taskIndex: null, subagents: mix(2, () => 'done') })] });
  await b.waitFor(`document.querySelector('.cluster-card[data-cluster="c_dddddddddddd"]').dataset.status === 'done'`);
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => c.dataset.cluster)`), ['c_bbbbbbbbbbbb', 'c_aaaaaaaaaaaa', 'c_dddddddddddd', 'c_cccccccccccc']);
  assert.deepEqual((await b.eval('window.__gets')).filter((u) => /\/clusters/.test(u)), [], 'the numbers came down the socket; no page was fetched again');
});

test('with no cluster the list says how to start one; a cluster whose subagents the Hub did not count shows a dash, not a zero', { skip }, async () => {
  await open('#/clusters', { fake: { list: [], clusters: {} } });
  await b.waitFor(`document.querySelector('.cl-empty') && !document.querySelector('.cl-empty').hidden`);
  assert.match(await text('.cl-empty'), /還沒有叢集[\s\S]*\/cluster/);
  assert.equal(await text('.cl-stat[data-stat="subagents-running"] [data-field="num"]'), '—');
  const old = SIX_CLUSTER({ workers: SIX().map(({ subagentCounts, subagents, subagentsOlder, ...w }) => w) });
  await open('#/clusters', { fake: listFake([old]) });
  await b.waitFor(`document.querySelector('.cluster-card')`);
  assert.equal(await text('.cluster-card [data-field="subagents"]'), '子代理 —');
  assert.equal(await text('.cl-stat[data-stat="subagents-running"] [data-field="sub"]'), '量不到');
});

test('the sidebar link: its number is the subagents at work over every cluster, it follows the messages, and it disappears when no cluster works', { skip }, async () => {
  const cs = LIST_CLUSTERS();
  await open('#/', { fake: listFake(cs) });
  await b.waitFor(`document.querySelector('[data-nav="clusters"] .cluster-nav-count') && !document.querySelector('[data-nav="clusters"] .cluster-nav-count').hidden`);
  const n = totalsOf(cs.map((c) => rowOf(c))).subagentsRunning;
  const badge = () => b.eval(`(() => { const e = document.querySelector('[data-nav="clusters"]'); const c = e.querySelector('.cluster-nav-count'); return { link: e.innerText.replace(/\\s+/g, ' ').trim(), hidden: c.hidden, label: c.getAttribute('aria-label'), title: e.title, href: e.getAttribute('href') }; })()`);
  const first = await badge();
  assert.deepEqual([first.link, first.hidden, first.href], [`叢集總覽 ${n}`, false, '#/clusters']);
  assert.equal(first.label, `${n} 個子代理正在工作`);
  assert.match(first.title, /2 個叢集進行中/);
  // The message of a cluster that has opened more.
  const more = { ...cs[2], workers: [W(1, { subagents: mix(30, () => 'running'), taskIndex: 0 }), cs[2].workers[1]] };
  await emit(more);
  const n2 = totalsOf([rowOf(cs[0]), rowOf(cs[1]), rowOf(more)]).subagentsRunning;
  await b.waitFor(`document.querySelector('[data-nav="clusters"] .cluster-nav-count').innerText.trim() === '${n2}'`);
  // Every working cluster ends: the number goes away.
  const end = (c) => ({ ...c, status: 'done', workers: c.workers.map((w) => ({ ...w, status: 'idle', finishedAt: Date.now(), taskIndex: null, subagents: w.subagents.map((s) => ({ ...s, status: 'done' })), subagentCounts: countsOf(w.subagents.map((s) => ({ ...s, status: 'done' }))) })) });
  await emit(end(cs[1]));
  await emit(end(more));
  await b.waitFor(`document.querySelector('[data-nav="clusters"] .cluster-nav-count').hidden`);
  assert.equal((await badge()).title, '叢集總覽');
  // And the link goes to the list.
  await b.click('[data-nav="clusters"]');
  await b.waitFor(`location.hash === '#/clusters' && document.querySelector('.cluster-list-page')`);
  assert.equal(await b.eval(`document.querySelector('[data-nav="clusters"]').getAttribute('aria-current')`), 'page');
});

test('the list on a phone: one card across, the three numbers in a row, no sideways scroll', { skip }, async () => {
  await open('#/clusters', { fake: listFake(), size: [390, 844] });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  assert.equal(await perRow('.cluster-card'), 1);
  assert.equal(await perRow('.cl-stat'), 3);
  assert.ok((await b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 1);
  await shot('list-390');
  await open('#/clusters', { fake: listFake(), size: [1600, 900] });
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 3`);
  assert.ok((await perRow('.cluster-card')) >= 3, 'wide: all three side by side');
  await shot('list-1600');
});

// ------------------------------------------------------------- the looks

// AA for small text, in every look the app has (the ones with no colour of their own for a state use the app's).
const AA = 4.5;
const LOOKS = [
  { name: 'kimi light', look: 'kimi', theme: 'light' },
  { name: 'kimi dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'dark' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
const PAGE_TEXT = [
  ['status badge', '[data-field="status"]'],
  ['progress', '.cluster-progress'],
  ['elapsed', '.ch-elapsed'],
  ['stat label', '.ch-stat-label'],
  ['stat number', '.ch-stat-num'],
  ['stat unit', '.ch-stat-unit'],
  ['stat sub', '.ch-stat-sub'],
  ['facts', '.ch-facts > span:not([data-native-swarm])'],
  ['tile title', '.cluster-worker-title'],
  ['tile state', '.cluster-worker-state'],
  ['tile place', '.cluster-worker-queue'],
  ['tile speed', '.cw-speed'],
  ['tile count', '.cw-subcount'],
  ['tile more', '.cw-mini-more'],
  ['fold title', '.cluster-fold .cf-title'],
  ['fold summary', '.cluster-fold summary .muted'],
];
const DRAWER_TEXT = [
  ['title', '.cd-title'],
  ['state', '.cd-head .cluster-worker-state'],
  ['section heading', '.cd-sec h3'],
  ['task', '.cd-task'],
  ['queue line', '.cd-sec .cluster-worker-queue'],
  ['progress line', '.cd-sec .cluster-worker-progress'],
  ['speed', '[data-field="tokens"]'],
  ['count line', '.sa-count'],
  ['legend', '.sa-legend li'],
  ['legend glyph running', '.sa-legend .sa-key[data-group="running"]'],
  ['legend glyph awaiting', '.sa-legend .sa-key[data-group="awaiting"]'],
  ['legend glyph done', '.sa-legend .sa-key[data-group="done"]'],
  ['legend glyph failed', '.sa-legend .sa-key[data-group="failed"]'],
  ['legend glyph unknown', '.sa-legend .sa-key[data-group="unknown"]'],
  ['square awaiting', '.sa-grid .sa-cell[data-group="awaiting"]'],
  ['square done', '.sa-grid .sa-cell[data-group="done"]'],
  ['square failed', '.sa-grid .sa-cell[data-group="failed"]'],
  ['square unknown', '.sa-grid .sa-cell[data-group="unknown"]'],
  ['detail name', '.sa-detail-name'],
  ['detail state', '.sa-detail-state'],
  ['detail row label', '.sa-detail-rows dt'],
  ['detail row value', '.sa-detail-rows dd'],
  ['branch', '[data-field="branch"]'],
  ['key line', '[data-field="key"]'],
  ['key label', '.cd-key-label'],
  ['timing', '.cluster-timing-head'],
];
const LIST_TEXT = [
  ['stat number', '.cl-stat-num'],
  ['stat label', '.cl-stat-label'],
  ['stat sub', '.cl-stat-sub'],
  ['card title', '.cc-title'],
  ['card state', '.cc-state'],
  ['card progress', '.cc-progress'],
  ['card speed', '.cc-speed-num'],
  ['card speed unit', '.cc-speed-unit'],
  ['card facts', '.cc-fact'],
  ['sidebar count', '.cluster-nav-count'],
];
async function contrastOf(list, L) {
  const bad = [];
  for (const [what, sel] of list) {
    const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.matches(':disabled') && e.offsetParent !== null).slice(0, 6).map((e) => (${CONTRAST_JS})(e))`);
    assert.ok(rs.length, `${L.name}: ${what} (${sel}) is on the screen`);
    for (const r of rs) if (r.ratio < AA) bad.push(`${what} ${r.ratio.toFixed(2)}:1 (text ${r.fg}, behind ${r.bg})`);
  }
  return bad;
}
for (const L of LOOKS) {
  test(`${L.name}: the small squares, the drawer, the list and the sidebar number all read at AA (4.5:1)`, { skip }, async () => {
    const cs = LIST_CLUSTERS();
    const fake = { ...fullFake(SIX_CLUSTER()), ...listFake(cs), clusters: { ...listFake(cs).clusters, [CID]: SIX_CLUSTER() } };
    await open(`#/cluster/${CID}`, { fake, look: L });
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 6`);
    await b.sleep(300);
    assert.equal(await b.eval(`document.documentElement.dataset.look`), L.look);
    assert.deepEqual(await contrastOf(PAGE_TEXT, L), [], `${L.name}: the page`);
    await openDrawer(2);
    await b.click('.cluster-drawer .sa-cell[data-id="agent-2"]');
    await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
    await b.sleep(250);
    assert.deepEqual(await contrastOf(DRAWER_TEXT, L), [], `${L.name}: the drawer`);
    await shot(`look-${L.name.replace(' ', '-')}-drawer`);
    await open('#/clusters', { fake, look: L });
    await b.waitFor(`document.querySelectorAll('.cluster-card').length >= 3`);
    await b.sleep(300);
    assert.deepEqual(await contrastOf(LIST_TEXT, L), [], `${L.name}: the list`);
    await shot(`look-${L.name.replace(' ', '-')}-list`);
    await openCluster({ fake, look: L });
    await shot(`look-${L.name.replace(' ', '-')}-page`);
  });
}
