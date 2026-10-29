// "量並行上限" on each DeepSeek key, in a real browser: it asks first and says
// how many requests it will send; nothing reaches the computer before the person
// agrees; the answer comes back as a table under that key (and is still there
// when the settings are opened again); a failure is said where the table would
// be; and the table fits a phone and both themes. A real Hub with a seeded key
// list and a computer (a bare WebSocket client playing a connector) that
// answers the measure; no key value may be on the page.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { skipReason, startHub, launchBrowser, CONTRAST_JS } from './browser-harness.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY_A = 'sk-measure-go-SECRETFRAGMENT01';
const KEY_B = 'sk-measure-cc-SECRETFRAGMENT02';
let hub;
let gateway;
let b;
let machine;
const rpcs = []; // { op, args } the computer was asked
let measureAnswer; // async (args) => the connector's answer

const answerFor = (args, over = {}) => ({
  keyId: args.keyId,
  gateway: 'opencode-go',
  model: args.model,
  at: Date.now(),
  totalRequests: 31,
  stoppedEarly: null,
  levels: [
    { concurrency: 1, requests: 1, ok: 1, http429: 0, errors: 0, statuses: { 200: 1 }, codes: [], latencyMs: { p50: 410, p95: 410 } },
    { concurrency: 2, requests: 2, ok: 2, http429: 0, errors: 0, statuses: { 200: 2 }, codes: [], latencyMs: { p50: 430, p95: 455 } },
    { concurrency: 4, requests: 4, ok: 4, http429: 0, errors: 0, statuses: { 200: 4 }, codes: [], latencyMs: { p50: 470, p95: 520 } },
    { concurrency: 8, requests: 8, ok: 5, http429: 3, errors: 0, statuses: { 200: 5, 429: 3 }, codes: ['rate_limit_exceeded'], latencyMs: { p50: 610, p95: 980 } },
    { concurrency: 16, requests: 16, ok: 5, http429: 10, errors: 1, statuses: { 200: 5, 429: 10, error: 1 }, codes: ['rate_limit_exceeded'], latencyMs: { p50: 700, p95: 1500 } },
  ],
  ...over,
});

before(async () => {
  if (skip) return;
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  hub = await startHub([], {
    env: { AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${gateway.address().port}` },
    seed: (data) => {
      fs.writeFileSync(
        path.join(data, 'deepseek.json'),
        JSON.stringify({
          gateway: 'opencode-go',
          keys: {
            'opencode-go': { revision: 1, activeId: 'k_a', keys: [{ id: 'k_a', key: KEY_A, addedAt: 1000 }] },
            commandcode: { revision: 1, activeId: 'k_b', keys: [{ id: 'k_b', key: KEY_B, addedAt: 2000 }] },
          },
          order: ['k_a', 'k_b'],
        }),
        { mode: 0o600 },
      );
    },
  });
  // A computer whose connector can measure.
  const bridgeKey = JSON.parse(fs.readFileSync(path.join(hub.data, 'hub.json'), 'utf8')).bridgeKey;
  machine = new WebSocket(`ws://127.0.0.1:${hub.port}/bridge?key=${encodeURIComponent(bridgeKey)}`);
  await new Promise((r) => machine.once('open', r));
  const send = (m) => machine.send(JSON.stringify(m));
  machine.on('message', async (d) => {
    const m = JSON.parse(d);
    if (m.t !== 'req') return;
    rpcs.push({ op: m.op, args: m.args });
    try {
      let data = { ok: true };
      if (m.op === 'kimi.deepseek.measure') data = await measureAnswer(m.args);
      else if (m.op === 'kimi.deepseek.provision') data = { ok: true, created: true, models: [], sessionHeader: true };
      send({ t: 'res', id: m.id, ok: true, data });
    } catch (err) {
      send({ t: 'res', id: m.id, ok: false, error: err.message, status: err.status });
    }
  });
  send({ t: 'hello', machineId: 'm_ui', name: '測試用電腦', hostname: 'ui', platform: 'test', bridgeVersion: '0.11.0', pool: 1, broker: 0, capabilities: ['pool', 'pool_cross', 'pool_timing', 'pool_measure'], home: '/home/ui', status: { available: false } });
  b = await launchBrowser();
});
after(async () => {
  machine?.close();
  await b?.close();
  hub?.stop();
  gateway?.close();
});

const SETTINGS_BTN = '.side-foot button[aria-label="設定"]';
const measureCalls = () => rpcs.filter((r) => r.op === 'kimi.deepseek.measure');
const open = async () => {
  await b.size(1280, 900, false);
  await b.goto(hub.url + '#/', 300);
  await b.eval(`localStorage.clear(); location.reload()`);
  await sleep(800);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
};
const openDeepseek = async () => {
  await b.click(SETTINGS_BTN);
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith('DeepSeek…'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length > 0`, { timeout: 8000 });
};
const closeSettings = async () => {
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await b.waitFor(`!document.querySelector('.deepseek-settings')`, { timeout: 5000 });
};
const press = (id) => b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] [data-act="measure"]').click()`);
const table = (id) =>
  b.eval(`(() => { const t = document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] .ds-measure-table'); if (!t) return null; return { head: [...t.querySelectorAll('th')].map((x) => x.innerText), rows: [...t.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.innerText)) }; })()`);
const confirmButton = `[...document.querySelectorAll('.alert .om-btn')].find((x) => x.classList.contains('om-btn--primary'))`;

test('every key has the button; pressing it asks first and says the number of requests and the cost, and nothing is sent until the person agrees', { skip }, async () => {
  await open();
  await openDeepseek();
  const labels = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key [data-act="measure"]')].map((x) => x.innerText)`);
  assert.deepEqual(labels, ['量並行上限', '量並行上限']);
  await press('k_a');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  const text = await b.eval(`document.querySelector('.alert').innerText`);
  assert.match(text, /共 31 個極小請求/);
  assert.match(text, /花少量額度/);
  assert.match(text, /1、2、4、8、16/);
  assert.match(text, /key 不會離開那台電腦/);
  assert.equal(await b.eval(`Boolean(document.querySelector('.deepseek-settings'))`), true, 'the question is over the settings');
  await sleep(300);
  assert.equal(measureCalls().length, 0, 'asking does not send anything');
  // Cancel: nothing is sent, nothing shows under the key.
  await b.eval(`[...document.querySelectorAll('.alert .om-btn')].find((x) => x.innerText === '取消').click()`);
  await b.waitFor(`!document.querySelector('.alert')`, { timeout: 5000 });
  await sleep(300);
  assert.equal(measureCalls().length, 0);
  assert.equal(await table('k_a'), null);
  // Escape does the same.
  await press('k_a');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await b.waitFor(`!document.querySelector('.alert')`, { timeout: 5000 });
  await sleep(300);
  assert.equal(measureCalls().length, 0, 'Escape sends nothing either');
});

test('after agreeing: it says it is measuring, the computer is asked for that key by id, and the result is a table under that key only', { skip }, async () => {
  let release;
  const held = new Promise((r) => (release = r));
  measureAnswer = async (args) => {
    await held;
    return answerFor(args);
  };
  await press('k_a');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`${confirmButton}.click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure .spinner')`, { timeout: 5000 });
  const running = await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure').innerText`);
  assert.match(running, /量測中.*共 31 個請求/);
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-act="measure"]').innerText`), '量測中…');
  // A second press while it runs sends no second question.
  await press('k_a');
  await sleep(300);
  assert.equal(await b.eval(`Boolean(document.querySelector('.alert'))`), false, 'no second question while measuring');
  await until(() => measureCalls().length === 1);
  assert.deepEqual(measureCalls()[0].args.keyId, 'k_a');
  assert.deepEqual(measureCalls()[0].args.levels, [1, 2, 4, 8, 16]);
  assert.equal(measureCalls()[0].args.model, 'deepseek-v4.1-flash');
  assert.ok(!JSON.stringify(measureCalls()).includes('SECRETFRAGMENT'), 'the computer is not sent a key');
  release();
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-table')`, { timeout: 8000 });
  const t = await table('k_a');
  assert.deepEqual(t.head, ['並行數', '成功', '429', '其他失敗', '延遲 p50', '延遲 p95']);
  assert.deepEqual(t.rows, [
    ['1', '1／1', '0', '0', '410 ms', '410 ms'],
    ['2', '2／2', '0', '0', '430 ms', '455 ms'],
    ['4', '4／4', '0', '0', '470 ms', '520 ms'],
    ['8', '5／8', '3', '0', '610 ms', '980 ms'],
    ['16', '5／16', '10', '1', '700 ms', '1500 ms'],
  ]);
  const head = await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-head').innerText`);
  assert.match(head, /在「測試用電腦」量/);
  assert.match(head, /共送出 31 個請求/);
  assert.match(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-note').innerText`), /rate_limit_exceeded/);
  assert.equal(await table('k_b'), null, 'the other key shows nothing');
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-act="measure"]').innerText`), '量並行上限');
});

test('opening the settings again shows the last result under its key', { skip }, async () => {
  await closeSettings();
  await openDeepseek();
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-table')`, { timeout: 8000 });
  const t = await table('k_a');
  assert.equal(t.rows.length, 5);
  assert.deepEqual(t.rows[4], ['16', '5／16', '10', '1', '700 ms', '1500 ms']);
  assert.equal(await table('k_b'), null);
});

test('a connector that stopped early, or refused, or is too old, is said where the table would be', { skip }, async () => {
  // Stopped early: the table of what was sent, and why the rest was not.
  measureAnswer = async (args) => answerFor(args, { totalRequests: 1, stoppedEarly: '閘道直接拒絕這把 key（HTTP 401），後面的並行數沒有再送', levels: [{ concurrency: 1, requests: 1, ok: 0, http429: 0, errors: 1, statuses: { 401: 1 }, codes: ['invalid_api_key'], latencyMs: null }] });
  await press('k_b');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`${confirmButton}.click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_b"] .ds-measure-table')`, { timeout: 8000 });
  const t = await table('k_b');
  assert.deepEqual(t.rows, [['1', '0／1', '0', '1', '—', '—']]);
  const notes = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key[data-key-id="k_b"] .ds-measure-note')].map((x) => x.innerText)`);
  assert.ok(notes.some((n) => /HTTP 401.*沒有再送/.test(n)), JSON.stringify(notes));
  assert.ok(notes.some((n) => /invalid_api_key/.test(n)));
  assert.ok((await table('k_a')), 'the first key keeps its own result');

  // A failure: said in red where the table was, with the Hub's words.
  measureAnswer = async () => {
    throw Object.assign(new Error('這台電腦正在量測一把 key，等它跑完再試'), { status: 409 });
  };
  await press('k_a');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`${confirmButton}.click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure.bad')`, { timeout: 8000 });
  assert.match(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure.bad').innerText`), /量測失敗：.*正在量測/);
  assert.equal(await table('k_a'), null, 'the old table is replaced by the failure, not shown beside it');
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure.bad').getAttribute('role')`), 'alert');
});

test('the table fits a phone with no sideways page scroll, and reads in both themes', { skip }, async () => {
  measureAnswer = async (args) => answerFor(args);
  await press('k_a');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`${confirmButton}.click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-table')`, { timeout: 8000 });
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    await b.size(w, h, mobile);
    await sleep(300);
    const fit = await b.eval(`(() => { const d = document.documentElement; const card = document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"]').getBoundingClientRect(); const scroll = document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-measure-scroll').getBoundingClientRect(); return { page: d.scrollWidth <= window.innerWidth, inside: scroll.right <= card.right + 1 && scroll.left >= card.left - 1 }; })()`);
    assert.equal(fit.page, true, `no sideways scroll of the page at ${w}`);
    assert.equal(fit.inside, true, `the table stays inside its card at ${w}`);
    for (const theme of ['light', 'dark']) {
      await b.eval(`document.documentElement.dataset.theme = '${theme}'`);
      await sleep(150);
      for (const sel of ['.ds-measure-table th', '.ds-measure-table tbody td', '.ds-measure-table td.warn', '.ds-measure-head']) {
        const c = await b.eval(`(${CONTRAST_JS})('.deepseek-settings .ds-key[data-key-id="k_a"] ${sel}')`);
        assert.ok(c && c.ratio >= 4.5, `${sel} on ${theme} at ${w}: ${JSON.stringify(c)}`);
      }
    }
    await b.eval(`delete document.documentElement.dataset.theme`);
  }
  // After all of it, no key value anywhere on the page.
  const dom = await b.eval(`document.documentElement.outerHTML + document.body.innerText`);
  for (const k of [KEY_A, KEY_B]) assert.ok(!dom.includes(k.slice(0, -4)), 'a key is on the page');
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error('timed out');
}
