// 耗時 in the side panel of a conversation, in a real browser. The user is
// going to time the same job twice - once in ONE conversation that opens Kimi's
// own swarm, once as a cluster of workers - and the cluster's workers already
// show where their time went. A plain conversation showed nothing, so the two
// could not be set side by side. The panel's 耗時 tab is that view for a Kimi or
// a DeepSeek conversation (not a Claude one), drawn by the SAME function as the
// worker cards, plus the counts, from when the data covers, and a button that
// copies the Hub's raw answer for someone else to compare.
//
// The rule under test is the user's (2026-10-21): "不要再用自己模擬、計算的了".
// The page shows the numbers the Hub sent and nothing else; what the Hub
// did not measure says 量不到 and the Hub's own reason.
//
// A real Hub and the real front end; only the timing call is answered by the
// page itself where a test needs figures of its own (the Hub here has no
// computer, so it has no figures), and two tests let the real Hub answer. Skips,
// saying why, when there is no Chromium.
//
// TIMING_PANEL_SHOTS=<dir> also saves screenshots of every look to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skipReason, uiSession, CONTRAST_JS } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
const SHOTS = process.env.TIMING_PANEL_SHOTS || '';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let ui;
let b;

// The page's side of the timing call. `window.__timing[id]` is what the Hub
// "answers" (a body, or { __error: { status, message } }); with no entry the
// real Hub answers. Every timing GET is listed in window.__gets. The sockets
// are kept so a test can push a message down them (a conversation that starts
// or ends a turn). Every setInterval is listed in window.__intervals, and while
// window.__fastTick is on a 10-second timer runs every 300 ms, so that a test
// of "reads again / does not read" does not have to sit through the real wait
// (one test does, in real time).
const SCRIPT = `(() => {
  window.__timing = window.__timing || {};
  window.__gets = [];
  window.__intervals = [];
  window.__sockets = [];
  window.__copied = [];
  const realInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    window.__intervals.push(ms);
    return realInterval(fn, ms === 10000 && window.__fastTick ? 300 : ms, ...rest);
  };
  const RealWS = window.WebSocket;
  window.WebSocket = class extends RealWS {
    constructor(...a) { super(...a); window.__sockets.push(this); }
    set onmessage(fn) { this.__fn = fn; super.onmessage = fn; }
    get onmessage() { return this.__fn; }
  };
  window.__emit = (msg) => window.__sockets[window.__sockets.length - 1].__fn({ data: JSON.stringify(msg) });
  const real = window.fetch;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    if ((init.method || 'GET').toUpperCase() === 'GET' && /^\\/api\\/sessions\\/[\\w-]+\\/timing$/.test(u)) {
      window.__gets.push(u);
      const t = window.__timing[u.split('/')[3]];
      if (t !== undefined) return t && t.__error ? reply(t.__error.status, { error: t.__error.message }) : reply(200, t);
    }
    return real(url, init);
  };
})()`;

before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
  await b.beforeLoad(SCRIPT);
});
after(() => ui?.stop());

// What the page is told next, now and in every page loaded after.
let stateScript = null;
async function setPage({ timing = {}, fast = false, token = null } = {}) {
  if (stateScript) await b.removeBeforeLoad(stateScript);
  const src = `window.__timing = ${JSON.stringify(timing)}; window.__fastTick = ${fast};${token ? ` try { localStorage.setItem('hubToken', ${JSON.stringify(token)}); } catch {}` : ''}`;
  stateScript = await b.beforeLoad(src);
  await b.eval(src);
}

const T = 1_790_000_000_000; // a moment, in Kimi's epoch milliseconds
const FULL = (patch = {}) => ({
  since: T,
  turns: 7,
  wallMs: 123_000,
  modelMs: 41_000,
  toolMs: 17_000,
  compactMs: 3000,
  rateLimitWaitMs: 5000,
  requests: 19,
  http429: 2,
  requestsSince: T + 600_000,
  subagents: { spawned: 4, requeuedForRateLimit: 1 },
  unmeasured: [],
  ...patch,
});
// A Kimi conversation on a computer that is not DeepSeek's pool: what the Hub
// really says about it, in its own words.
const LACKING = () =>
  FULL({
    since: null,
    turns: 0,
    wallMs: null,
    modelMs: null,
    toolMs: 4000,
    compactMs: null,
    rateLimitWaitMs: 0,
    requests: null,
    http429: null,
    requestsSince: null,
    subagents: { spawned: null, requeuedForRateLimit: null },
    unmeasured: [
      'wallMs：還沒有結束的回合',
      'modelMs：這些回合的步驟沒有帶計時（被中斷的步驟沒有，或這台電腦的連接器太舊，沒有把計時欄位傳過來）',
      'compactMs：還沒有壓縮事件的時間戳',
      'since：收到的事件都沒有時間戳',
      'requests：這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以對應',
      'http429：這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以對應',
      'subagents：同上，沒有事件可以數',
    ],
  });

// ----------------------------------------------------------- page helpers

const PANEL_BTN = `[...document.querySelectorAll('.toolbar button')].find((x) => (x.title || '').startsWith('面板'))`;
const tabLabels = () => b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].map((x) => x.firstChild.textContent.trim())`);
async function openConversation(id, viewport) {
  await ui.openApp(`#/s/${id}`, { viewport });
  await b.waitFor(`document.querySelector('.composer-input')`);
}
async function openPanel() {
  await b.eval(`(${PANEL_BTN}).click()`);
  await b.waitFor(`document.querySelector('.panel:not([hidden]) .panel-head')`);
}
async function openTiming(id = 's_kimi', viewport) {
  await openConversation(id, viewport);
  await openPanel();
  await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].find((x) => x.firstChild.textContent.trim() === '耗時').click()`);
  await b.waitFor(`document.querySelector('.panel .timing-pane')`);
}
const paneText = () => b.eval(`document.querySelector('.panel .timing-pane')?.innerText ?? ''`);
const asked = (id = 's_kimi') => b.eval(`window.__gets.filter((u) => u === '/api/sessions/${id}/timing').length`);
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const itemText = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
// A conversation takes a turn / ends it: the Hub's summary with another status.
async function setStatus(id, status, extra = {}) {
  const summary = await ui.hub.api(`/sessions/${id}`);
  await b.eval(`window.__emit(${JSON.stringify({ t: 'session', session: { ...summary, status, ...extra } })})`);
}
// The local date and time of a moment, written by the page itself with its own Date.
const STAMP_JS = `(ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }`;
const secretLike = /sk-[A-Za-z0-9_-]{8,}|bearer\s|x-hub-token|authorization|api[_-]?key|tok_SECRET/i;

// ------------------------------------------------------------------- tabs

test('a Kimi and a DeepSeek conversation have a 耗時 tab in the panel, a Claude conversation does not', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL(), s_ds: FULL() } });
  for (const id of ['s_kimi', 's_ds']) {
    await openConversation(id);
    assert.match(await b.eval(`(${PANEL_BTN}).title`), /耗時/, `${id}: the panel button says it holds the time`);
    await openPanel();
    const labels = await tabLabels();
    assert.equal(labels.at(-1), '耗時', `${id}: ${labels}`);
    assert.deepEqual(labels.slice(0, -1), ['Artifact', '變更', '子代理', '待辦'], 'the other tabs are where they were');
  }
  await openConversation('s_claude');
  assert.doesNotMatch(await b.eval(`(${PANEL_BTN}).title`), /耗時/, 'a Claude conversation: the panel button does not promise it');
  await openPanel();
  assert.deepEqual(await tabLabels(), ['Artifact', '變更', '子代理', '待辦']);
  assert.equal(await b.eval(`document.querySelector('.panel .timing-pane')`), null);
  assert.equal((await b.eval(`window.__gets`)).filter((u) => /s_claude/.test(u)).length, 0, 'and nothing asked the Hub for a Claude conversation\'s time');
});

test('the tab shows the time of THAT conversation: it asks for it by id, once, when it is opened', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL(), s_ds: FULL({ turns: 9 }) } });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  assert.deepEqual(await b.eval(`window.__gets`), ['/api/sessions/s_ds/timing']);
  assert.match(await itemText('.timing-counts [data-count="turns"]'), /回合 9/);
});

// ----------------------------------------------------------- what is shown

test('every figure in the pane is one the Hub sent: the total, the four parts, the counts, and the two start times', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL() } });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  assert.equal(await itemText('.panel .cluster-timing-total'), '總時間 2 分 3 秒');
  const legend = await b.eval(`Object.fromEntries([...document.querySelectorAll('.panel .cluster-legend li')].map((e) => [e.dataset.part, e.innerText.replace(/\\s+/g, ' ').trim()]))`);
  assert.deepEqual(legend, { modelMs: '模型 41.0 秒', toolMs: '工具 17.0 秒', rateLimitWaitMs: '等限流 5.0 秒', compactMs: '壓縮 3.0 秒' });
  const segs = await b.eval(`[...document.querySelectorAll('.panel .cluster-bar [data-seg]')].map((e) => [e.dataset.seg, Math.round(parseFloat(e.style.width) * 10) / 10])`);
  assert.deepEqual(segs, [['modelMs', 33.3], ['toolMs', 13.8], ['rateLimitWaitMs', 4.1], ['compactMs', 2.4]], 'drawn against the Hub\'s own total');
  const counts = await b.eval(`Object.fromEntries([...document.querySelectorAll('.panel .timing-counts li')].map((e) => [e.dataset.count, e.innerText.replace(/\\s+/g, ' ').trim()]))`);
  assert.deepEqual(counts, { turns: '回合 7', requests: '請求 19', http429: '429 次數 2', spawned: '子代理 4', requeued: '子代理限流重排 1' });
  // The two times are the Hub's numbers, written as a date by the page's own Date - and kept as the number.
  const times = await b.eval(`(() => { const stamp = ${STAMP_JS}; return [...document.querySelectorAll('.panel .timing-coverage li')].map((e) => { const t = e.querySelector('time'); return { key: e.dataset.coverage, text: e.innerText.replace(/\\s+/g, ' ').trim(), time: t.textContent, ms: t.dataset.ms, iso: t.getAttribute('datetime'), want: stamp(Number(t.dataset.ms)) }; }); })()`);
  assert.deepEqual(times.map((t) => [t.key, t.ms, t.iso]), [['since', String(T), new Date(T).toISOString()], ['requestsSince', String(T + 600_000), new Date(T + 600_000).toISOString()]]);
  for (const t of times) assert.equal(t.time, t.want, `${t.key} is the local date and time of the Hub's number`);
  assert.match(times[0].text, /^起算時間 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(times[1].text, /^請求紀錄起算 /);
  // No figure that the Hub did not send: the digits in the whole pane, other than the two dates, are these and no others
  // (no 123 - 66 = 57 s of "other", no sum of the parts, no count of the counts).
  const shown = await b.eval(`(() => { let text = document.querySelector('.panel .timing-pane').innerText; for (const t of document.querySelectorAll('.panel .timing-pane time')) text = text.replace(t.textContent, ''); return [...text.matchAll(/\\d+(?:\\.\\d+)?/g)].map((m) => m[0]); })()`);
  assert.deepEqual([...new Set(shown)].sort(), ['1', '17.0', '19', '2', '3', '3.0', '4', '41.0', '429', '5.0', '7'].sort());
});

// -------------------------------------------------- the key the conversation is on

const ON_KEY = (patch = {}) => ({ id: 'dk_a1', gateway: 'opencode-go', gatewayLabel: 'OpenCode Go', hint: 'a1b2', removed: false, lastUsedAt: T + 650_000, machineId: 'm_fake', distribution: 'sticky', ...patch });

test('the pane says which key the conversation is on, the way the Hub described it: gateway and last four characters, and how keys are given out', { skip }, async () => {
  await setPage({ timing: { s_ds: FULL({ currentKey: ON_KEY() }) } });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .timing-key')`);
  const line = await itemText('.panel .timing-key');
  assert.match(line, /^用的 key OpenCode Go …a1b2/, line);
  assert.match(line, /平均分配：這個對話固定用這一把，它用完或被拒絕才換/, line);
  assert.equal(await b.eval(`document.querySelector('.panel .timing-key').dataset.distribution`), 'sticky');
  assert.ok(!secretLike.test(line), line);
  // The line sits above the bar, and the figures below it are unchanged.
  assert.equal(await b.eval(`document.querySelector('.panel .timing-key').nextElementSibling.classList.contains('cluster-timing')`), true);
  assert.equal(await itemText('.panel .cluster-timing-total'), '總時間 2 分 3 秒');
});

test('on a relay the same line says every conversation shares the key in use, and a key the Hub no longer has is said to be gone with no tail made up', { skip }, async () => {
  await setPage({ timing: { s_ds: FULL({ currentKey: ON_KEY({ distribution: 'relay' }) }) } });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .timing-key')`);
  assert.match(await itemText('.panel .timing-key'), /OpenCode Go …a1b2.*接力：所有對話共用使用中的那一把，它用完才換下一把/);
  await setPage({ timing: { s_ds: FULL({ currentKey: ON_KEY({ removed: true, hint: null, gatewayLabel: 'Command Code', gateway: 'commandcode' }) }) } });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .timing-key')`);
  const gone = await itemText('.panel .timing-key');
  assert.match(gone, /Command Code 的一把 key（已不在清單裡）/, gone);
  assert.ok(!gone.includes('…'), 'no tail was made up for a key that is not there');
});

test('a DeepSeek conversation with no request yet says so; one that does not go through the key pool says nothing about keys', { skip }, async () => {
  await setPage({ timing: { s_ds: FULL({ requests: 0, http429: 0, currentKey: null }), s_kimi: LACKING() } });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .timing-key')`);
  assert.match(await itemText('.panel .timing-key'), /用的 key：這個對話還沒有請求紀錄，看不出來/);
  await openTiming('s_kimi');
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  assert.equal(await b.eval(`document.querySelector('.panel .timing-key')`), null, 'a Kimi subscription conversation has no key to name');
});

test('what the Hub could not measure says 量不到 and the Hub\'s reason, never a number, a date or a 0 in its place', { skip }, async () => {
  await setPage({ timing: { s_kimi: LACKING() } });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  assert.equal(await itemText('.panel .cluster-timing-total'), '總時間 量不到');
  const legend = await b.eval(`Object.fromEntries([...document.querySelectorAll('.panel .cluster-legend li')].map((e) => [e.dataset.part, e.innerText.replace(/\\s+/g, ' ').trim()]))`);
  assert.deepEqual(legend, { modelMs: '模型 量不到', toolMs: '工具 4.0 秒', rateLimitWaitMs: '等限流 0 秒', compactMs: '壓縮 量不到' }, 'a real 0 stays 0');
  const counts = await b.eval(`Object.fromEntries([...document.querySelectorAll('.panel .timing-counts li')].map((e) => [e.dataset.count, e.innerText.replace(/\\s+/g, ' ').trim()]))`);
  assert.deepEqual(counts, { turns: '回合 0', requests: '請求 量不到', http429: '429 次數 量不到', spawned: '子代理 量不到', requeued: '子代理限流重排 量不到' });
  const times = await b.eval(`Object.fromEntries([...document.querySelectorAll('.panel .timing-coverage li')].map((e) => [e.dataset.coverage, { text: e.innerText.replace(/\\s+/g, ' ').trim(), time: Boolean(e.querySelector('time')) }]))`);
  assert.deepEqual(times, { since: { text: '起算時間 量不到', time: false }, requestsSince: { text: '請求紀錄起算 量不到', time: false } });
  const text = clean(await paneText());
  for (const raw of LACKING().unmeasured) {
    const reason = raw.split('：').slice(1).join('：');
    assert.ok(text.includes(reason), `the Hub's reason is on the screen: ${reason}`);
  }
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'no date was made up for a time that was not sent');
  assert.equal(await b.eval(`document.querySelectorAll('.panel .cluster-bar [data-seg]').length`), 1, 'only the measured part is drawn');
});

test('the pane and the worker drawers draw the time with the same function: one place builds the bar, the legend and the reasons', { skip }, async () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
  const builders = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js') && /['"`]cluster-bar['"`]|['"`]cluster-legend['"`]/.test(read(f)));
  assert.deepEqual(builders, ['timing-box.js'], 'the bar and the legend are built in exactly one file');
  // (The cluster page draws it in a worker's drawer, which is cluster-tiles.js.)
  for (const f of ['cluster-tiles.js', 'timing-panel.js']) assert.match(read(f), /import \{[^}]*\btimingBox\b[^}]*\} from '\.\/timing-box\.js'/, `${f} draws it with the shared timingBox`);
  // ... and the pane really shows that bar.
  await setPage({ timing: { s_kimi: FULL() } });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-bar')`);
  assert.equal(await b.eval(`document.querySelectorAll('.panel .cluster-timing .cluster-bar .cluster-seg').length`), 4);
});

test('a read that fails says 量不到 and why; copying is off until there is something to copy', { skip }, async () => {
  await setPage({ timing: { s_kimi: { __error: { status: 500, message: '中控台暫時讀不到這個對話' } } } });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-failed')`);
  assert.equal(await itemText('.panel .cluster-timing-failed'), '耗時量不到：中控台暫時讀不到這個對話');
  assert.equal(await b.eval(`document.querySelectorAll('.panel .cluster-seg').length`), 0);
  assert.equal(await b.eval(`document.querySelector('.panel [data-action="copy-timing"]').disabled`), true);
});

// ------------------------------------------------------------ when it reads

test('while the conversation works the pane reads again on a 10-second timer; idle, it does not; the end of a turn reads once more', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL() }, fast: true });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  assert.equal(await asked(), 1, 'one read when the tab opens');
  assert.ok((await b.eval(`window.__intervals`)).includes(10000), 'the timer is the 10-second one');
  // Idle: the timer runs, and reads nothing.
  await b.sleep(1500);
  assert.equal(await asked(), 1, 'idle: no re-read');
  // A turn starts: the figures move, and the pane follows them by itself.
  await setStatus('s_kimi', 'running');
  await b.eval(`window.__timing.s_kimi = ${JSON.stringify(FULL({ modelMs: 70_000, wallMs: 150_000 }))}`);
  await b.waitFor(`document.querySelector('.panel li[data-part="modelMs"]')?.innerText.includes('1 分 10 秒')`, { timeout: 4000, label: 'the pane read again while working' });
  const working = await asked();
  await b.sleep(1000);
  assert.ok((await asked()) > working, 'and keeps reading while it works');
  // The turn ends: whatever the last tick missed is read once, in the same breath.
  await b.eval(`(() => { window.__timing.s_kimi = ${JSON.stringify(FULL({ modelMs: 90_000, wallMs: 170_000 }))}; })()`);
  await setStatus('s_kimi', 'idle');
  await b.waitFor(`document.querySelector('.panel li[data-part="modelMs"]')?.innerText.includes('1 分 30 秒')`, { timeout: 2000, label: 'one more read at the end of the turn' });
  const ended = await asked();
  await b.sleep(1500);
  assert.equal(await asked(), ended, 'idle again: no more reads');
});

test('a read that fails while the conversation works keeps the last figures on screen and says the re-read failed', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL() }, fast: true });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  await setStatus('s_kimi', 'running');
  await b.eval(`window.__timing.s_kimi = { __error: { status: 503, message: '中控台忙線中' } }`);
  await b.waitFor(`document.querySelector('.panel .timing-stale')`, { timeout: 4000, label: 'the failed re-read is said' });
  assert.match(await itemText('.panel .timing-stale'), /重新讀取失敗：中控台忙線中/);
  assert.equal(await itemText('.panel .cluster-timing-total'), '總時間 2 分 3 秒', 'the last figures stay, as they were');
  assert.equal(await b.eval(`document.querySelector('.panel [data-action="copy-timing"]').disabled`), false, 'and they can still be copied');
  // The next good read takes the warning away.
  await b.eval(`window.__timing.s_kimi = ${JSON.stringify(FULL({ turns: 8 }))}`);
  await b.waitFor(`!document.querySelector('.panel .timing-stale') && document.querySelector('.panel [data-count="turns"]')?.innerText.includes('8')`, { timeout: 4000 });
  await setStatus('s_kimi', 'idle');
});

test('closing the panel, or leaving the conversation, stops the reading - also while it is working', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL(), s_ds: FULL() }, fast: true });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  await setStatus('s_kimi', 'running');
  await b.waitFor(`window.__gets.length >= 3`, { timeout: 4000, label: 'it is reading while it works' });
  // Close the panel.
  await b.eval(`document.querySelector('.panel .panel-head button[aria-label="關閉面板"]').click()`);
  await b.waitFor(`document.querySelector('.panel').hidden`);
  await b.sleep(300);
  const closed = await asked();
  await b.sleep(1500);
  assert.equal(await asked(), closed, 'panel closed: nothing asks any more');
  // Open it again: it reads at once and goes on; then go to another conversation.
  await openPanel();
  await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].find((x) => x.firstChild.textContent.trim() === '耗時').click()`);
  await b.waitFor(`window.__gets.length > ${closed}`, { timeout: 3000, label: 'opened again: it reads' });
  await b.eval(`location.hash = '#/s/s_ds'`);
  await b.waitFor(`document.querySelector('.composer-input') && document.querySelector('.toolbar .om-toolbar__title')?.innerText.includes('DeepSeek chat')`);
  assert.equal(await b.eval(`document.querySelector('.panel').hidden`), true, 'the panel of the conversation that was left is gone');
  await b.sleep(300);
  const left = await asked();
  await b.sleep(1500);
  assert.equal(await asked(), left, 'left the conversation: nothing asks any more');
  assert.equal(await asked('s_ds'), 0, 'and the conversation entered did not start a reading by itself');
  await setStatus('s_kimi', 'idle');
});

test('in real time: a working conversation is read again after about ten seconds - not sooner, and it gets there', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL() }, fast: false });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  await setStatus('s_kimi', 'running');
  await b.eval(`window.__timing.s_kimi = ${JSON.stringify(FULL({ modelMs: 70_000, wallMs: 150_000 }))}`);
  const started = Date.now();
  await b.sleep(4000);
  assert.equal(await asked(), 1, 'four seconds in, nothing was asked again');
  await b.waitFor(`document.querySelector('.panel li[data-part="modelMs"]')?.innerText.includes('1 分 10 秒')`, { timeout: 9000, label: 'the re-read' });
  const took = Date.now() - started;
  assert.ok(took >= 5000 && took <= 13_000, `the re-read came ${took} ms after the change`);
  await setStatus('s_kimi', 'idle');
});

test('a conversation that stops being a Kimi or DeepSeek one takes the 耗時 tab with it', { skip }, async () => {
  await setPage({ timing: { s_kimi: FULL() }, fast: true });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  await setStatus('s_kimi', 'running', { provider: 'claude', agentId: 'claude' });
  await b.waitFor(`document.querySelector('.panel').hidden`, { timeout: 3000, label: 'the panel closes' });
  await b.sleep(300);
  const n = await asked();
  await b.sleep(1200);
  assert.equal(await asked(), n, 'and nothing is read for it');
  await setStatus('s_kimi', 'idle', { provider: 'kimi', agentId: 'kimi@m1' });
});

// -------------------------------------------------------------------- copy

test('複製數字 copies the Hub\'s raw answer with the conversation\'s title and id - and nothing that is a key or a token', { skip }, async () => {
  const body = FULL({ unmeasured: ['requests：另有 3 個同時間的請求沒帶對話識別，沒有算進來（這個數字是下限）'] });
  await setPage({ timing: { s_kimi: body }, token: 'tok_SECRET_that_must_never_be_copied_0123456789' });
  await openTiming();
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  await b.eval(`navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }`);
  assert.equal(await b.eval(`localStorage.getItem('hubToken')`), 'tok_SECRET_that_must_never_be_copied_0123456789', 'the page does hold a token, so the check below means something');
  await b.click('.panel [data-action="copy-timing"]');
  await b.waitFor(`window.__copied.length === 1`);
  const text = (await b.eval(`window.__copied`))[0];
  assert.deepEqual(JSON.parse(text), { title: 'Kimi chat with subagents', id: 's_kimi', timing: body }, 'the raw answer, whole, with the title and the id');
  assert.ok(!secretLike.test(text), `nothing in it looks like a key or a token: ${text.match(secretLike)}`);
  assert.match(await b.eval(`document.querySelector('.toasts')?.innerText ?? ''`), /已複製/);
});

test('the real Hub\'s answer is what is shown and what is copied (nothing stubbed): its reasons on screen, its JSON in the clipboard', { skip }, async () => {
  await setPage({ timing: {} });
  await openTiming('s_ds');
  await b.waitFor(`document.querySelector('.panel .cluster-timing-total')`);
  const api = await ui.hub.api('/sessions/s_ds/timing');
  assert.ok(Array.isArray(api.unmeasured) && api.unmeasured.length >= 5, 'the Hub has no figures for this one and says why');
  assert.equal(await itemText('.panel .cluster-timing-total'), '總時間 量不到');
  const text = clean(await paneText());
  for (const raw of api.unmeasured) {
    const reason = raw.split('：').slice(1).join('：');
    assert.ok(text.includes(clean(reason)), `the Hub's own reason is on the screen: ${reason}`);
  }
  await b.eval(`navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }`);
  await b.click('.panel [data-action="copy-timing"]');
  await b.waitFor(`window.__copied.length === 1`);
  const copied = JSON.parse((await b.eval(`window.__copied`))[0]);
  assert.deepEqual(copied, { title: 'DeepSeek chat', id: 's_ds', timing: await ui.hub.api('/sessions/s_ds/timing') });
  assert.ok(!secretLike.test(JSON.stringify(copied)));
});

// -------------------------------------------------------------------- looks

const AA = 4.5;
const LOOKS = [
  { name: 'kimi light', look: 'kimi', theme: 'light' },
  { name: 'kimi dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'dark' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
const PANE_TEXT = [
  ['tab strip', '.panel-head .om-seg__item[aria-pressed="false"]'],
  ['tab strip (chosen)', '.panel-head .om-seg__item[aria-pressed="true"]'],
  ['time head', '.timing-pane .cluster-timing-head > span:first-child'],
  ['time total', '.timing-pane .cluster-timing-total'],
  ['time legend label', '.timing-pane .cluster-legend-label'],
  ['time legend value', '.timing-pane .cluster-legend-value'],
  ['量不到 (part)', '.timing-pane .cluster-legend li.unmeasured .cluster-legend-value'],
  ['reason', '.timing-pane .cluster-reason'],
  ['section title', '.timing-pane .timing-section-title'],
  ['count label', '.timing-pane .timing-counts .timing-label'],
  ['count value', '.timing-pane .timing-counts .timing-value'],
  ['量不到 (count)', '.timing-pane .timing-counts li.unmeasured .timing-value'],
  ['coverage label', '.timing-pane .timing-coverage .timing-label'],
  ['coverage value', '.timing-pane .timing-coverage time'],
  ['量不到 (coverage)', '.timing-pane .timing-coverage li.unmeasured .timing-value'],
  ['help', '.timing-pane .timing-help'],
  ['copy button', '.timing-pane [data-action="copy-timing"]'],
];
async function contrastOf(list, L) {
  const bad = [];
  for (const [what, sel] of list) {
    const rs = await b.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.matches(':disabled')).slice(0, 6).map((e) => (${CONTRAST_JS})(e))`);
    assert.ok(rs.length, `${what} (${sel}) is on the screen`);
    for (const r of rs) if (r.ratio < AA) bad.push(`${what} ${r.ratio.toFixed(2)}:1, needs ${AA}:1 (text ${r.fg}, behind ${r.bg})`);
  }
  return bad;
}
async function openCell(cell, id = 's_kimi') {
  await b.size(cell.w, cell.h, cell.w < 700);
  await b.goto(ui.hub.url + '#/', 300);
  await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(cell.look || 'kimi')}); localStorage.setItem('hubTheme', ${JSON.stringify(cell.theme)})`);
  await b.goto(ui.hub.url + `#/s/${id}`, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.composer-input')`);
  await openPanel();
  await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].find((x) => x.firstChild.textContent.trim() === '耗時').click()`);
  await b.waitFor(`document.querySelector('.panel .cluster-timing') && document.querySelector('.panel').getAnimations().length === 0`);
}

for (const L of LOOKS) {
  test(`${L.name}: all the text of the 耗時 tab reads at AA (4.5:1)`, { skip }, async () => {
    // Three shapes: the pane with 量不到 and the Hub's reasons, everything measured (with a note), and a failed read.
    await setPage({ timing: { s_kimi: LACKING() } });
    await openCell({ w: 1280, h: 900, ...L });
    assert.equal(await b.eval(`document.documentElement.dataset.look`), L.look);
    const bad = await contrastOf(PANE_TEXT.filter(([w]) => w !== 'coverage value'), L); // no date to read where the Hub sent none
    await setPage({ timing: { s_kimi: FULL({ unmeasured: ['requests：另有 3 個請求沒帶對話識別，沒有算進來（這個數字是下限）'], currentKey: ON_KEY() }) } });
    await openCell({ w: 1280, h: 900, ...L });
    bad.push(...(await contrastOf(PANE_TEXT.filter(([w]) => !/量不到/.test(w)), L)));
    bad.push(...(await contrastOf([['key line', '.timing-pane .timing-key'], ['key name', '.timing-pane .timing-key-name'], ['key how', '.timing-pane .timing-key-how']], L)));
    if (SHOTS) await b.shot(path.join(SHOTS, `look-${L.name.replace(' ', '-')}.png`));
    await setPage({ timing: { s_kimi: { __error: { status: 500, message: '中控台暫時讀不到這個對話' } } } });
    await openCell({ w: 1280, h: 900, ...L });
    assert.ok(await b.eval(`document.querySelector('.panel .cluster-timing-failed')`), 'the failed read is on the screen');
    bad.push(...(await contrastOf([['failed', '.timing-pane .cluster-timing-failed']], L)));
    assert.deepEqual(bad, [], `${L.name}: ${bad.join('; ')}`);
  });
}

// ------------------------------------------------------------------- layout

const CELLS = [
  { name: '1280 light', w: 1280, h: 900, theme: 'light' },
  { name: '1280 dark', w: 1280, h: 900, theme: 'dark' },
  { name: '390 light', w: 390, h: 844, theme: 'light' },
  { name: '390 dark', w: 390, h: 844, theme: 'dark' },
];
// Anything that sticks out of the panel, or of the window; and the pane's own scroll.
const FITS = `(() => {
  const panel = document.querySelector('.panel');
  const pr = panel.getBoundingClientRect();
  const out = [];
  for (const e of panel.querySelectorAll('*')) {
    if (e.closest('.panel-grip')) continue; // the drag handle sits on the panel's edge on purpose
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push((e.className || e.tagName) + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' in ' + Math.round(pr.left) + '-' + Math.round(pr.right));
  }
  const body = document.querySelector('.timing-pane');
  const head = document.querySelector('.panel-head');
  return { out: out.slice(0, 8), page: document.documentElement.scrollWidth - document.documentElement.clientWidth, side: body.scrollWidth - body.clientWidth, head: head.scrollWidth - head.clientWidth, panelRight: Math.round(pr.right), vw: innerWidth };
})()`;
for (const cell of CELLS) {
  test(`${cell.name}: the 耗時 tab fits - tabs, bar, legend, counts, dates, reasons and the button, nothing cut off or run past its box`, { skip }, async () => {
    for (const [what, data] of [['measured', FULL({ unmeasured: ['requests：另有 3 個同時間的請求沒帶對話識別，沒有算進來（這個數字是下限）'], currentKey: ON_KEY() })], ['lacking', LACKING()]]) {
      await setPage({ timing: { s_kimi: data } });
      await openCell(cell);
      const fit = await b.eval(FITS);
      assert.deepEqual([fit.out, fit.page, fit.side, fit.head], [[], 0, 0, 0], `${cell.name} ${what}: ${JSON.stringify(fit)}`);
      assert.ok(fit.panelRight <= fit.vw, 'the panel is inside the window');
      // Words stay whole: a tab, a legend row, a count row and a date row are one line each.
      const rows = await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item, .panel-head .om-btn, .timing-pane .cluster-legend li, .timing-pane .timing-counts li, .timing-pane .timing-coverage li, .timing-pane .cluster-timing-head, .timing-pane [data-action="copy-timing"]')].map((e) => { const r = e.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(e).lineHeight) || 18; return { what: (e.className || e.tagName) + ' ' + e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 24), h: Math.round(r.height), lines: Math.round(r.height / lh) }; })`);
      assert.ok(rows.length >= 15, `${rows.length} rows measured`);
      for (const r of rows) assert.ok(r.h <= 40 && r.lines <= 2, `${cell.name} ${what}: stays compact: ${JSON.stringify(r)}`);
      const oneLine = await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item, .timing-pane .cluster-legend-value, .timing-pane .timing-value, .timing-pane time, .timing-pane .cluster-timing-total, .timing-pane [data-action="copy-timing"]')].filter((e) => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 26).map((e) => e.className + ' ' + e.innerText.trim())`);
      assert.deepEqual(oneLine, [], `${cell.name} ${what}: no tab, value, date or button is broken over two lines`);
      // The button is reachable inside the pane.
      const button = await b.eval(`(() => { const e = document.querySelector('.timing-pane [data-action="copy-timing"]'); e.scrollIntoView(); const r = e.getBoundingClientRect(); const p = document.querySelector('.panel').getBoundingClientRect(); return { inside: r.left >= p.left && r.right <= p.right + 1 && r.bottom <= p.bottom + 1 && r.top >= p.top, h: Math.round(r.height) }; })()`);
      assert.equal(button.inside, true, `${cell.name} ${what}: the copy button is inside the panel`);
      if (SHOTS) {
        await b.eval(`document.querySelector('.timing-pane').scrollTop = 0`);
        await b.shot(path.join(SHOTS, `pane-${what}-${cell.name.replace(' ', '-')}.png`));
      }
    }
  });
}
