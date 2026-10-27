// Moving around a conversation that is longer than the window, and the two
// things that look as if they might reach into it: searching, and taking a
// conversation out of the page. Real Hub (it windows), real front end.
//
// What the page has today, and these tests keep it honest:
//   - the only way to move between messages is the pinned question (see
//     ui-window-derived) and 「到最新訊息」, which has to work after older
//     slices were loaded;
//   - the search box above the conversations finds CONVERSATIONS, by title and
//     folder. It never searched message text, so a window cannot hide a result;
//     if message search is added it has to say what it covered. This test fails
//     then, on purpose;
//   - there is no export of a whole conversation; what comes out is /copy of the
//     last reply (ui-window-derived) and the pages in the Artifact panel.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { maker, storedSession, WINDOW_ENV } from './fixtures/window-scenes.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEEDLE = 'zebra-unique-needle';
let hub;
let b;
let events;

before(async () => {
  if (skip) return;
  const m = maker('n');
  events = [m.user(`很早的一則訊息，含 ${NEEDLE}`), m.text('收到'), m.end(), ...m.filler(60), m.user('最近的問題'), m.text('最近的回答'), m.end()];
  hub = await startHub([storedSession(events, { id: 's_nav', title: '導覽測試' })], { env: WINDOW_ENV });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  hub?.stop();
});

const scroller = `document.querySelector('.transcript')`;

test('到最新訊息 takes you back to the newest message after older slices were loaded', { skip }, async () => {
  const snap = await hub.api('/sessions/s_nav');
  assert.ok(snap.window.hasEarlier && !snap.events.some((e) => e.text?.includes(NEEDLE)), 'the old message is outside the window');
  await b.size(1280, 900);
  await b.goto(`${hub.url}#/s/s_nav`, 300);
  await b.waitFor(`document.querySelector('.transcript .column > .ev')`, { timeout: 15000 });
  await sleep(500);
  for (let i = 0; i < 40 && !(await b.eval(`document.querySelector('.transcript .earlier').hidden`)); i++) {
    await b.eval(`document.querySelector('.transcript .earlier-btn').click()`);
    await sleep(100);
  }
  assert.ok(await b.eval(`!!document.querySelector('.transcript').textContent.includes(${JSON.stringify(NEEDLE)})`), 'everything is loaded: the old message is on the page now');
  await b.eval(`${scroller}.scrollTop = 0`);
  await sleep(300);
  await b.waitFor(`!document.querySelector('.jump-bar').hidden`, { timeout: 5000, label: 'the jump button shows' });
  await b.click('.jump-end');
  await sleep(500);
  assert.equal(await b.eval(`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 40`), true, 'at the newest message');
  assert.equal(await b.eval(`[...document.querySelectorAll('.transcript .column [data-id]')].at(-1).dataset.id`), events.at(-1).id, 'and that is the last event');
});

test('the search box finds conversations by title and folder; message text, in or out of the window, is not what it searches', { skip }, async () => {
  await b.goto(`${hub.url}#/`, 300);
  await b.waitFor(`document.querySelector('.sidebar')`);
  // it is hidden until there are 8 conversations: show it by the page's own rule
  assert.equal(await b.eval(`document.querySelector('.side-search input').placeholder`), '搜尋對話');
  const search = async (text) => {
    await b.eval(`(() => { const i = document.querySelector('.side-search input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    await sleep(200);
    return b.eval(`[...document.querySelectorAll('.side-row .row-title')].map((e) => e.innerText)`);
  };
  assert.deepEqual(await search('導覽'), ['導覽測試'], 'by title');
  assert.deepEqual(await search('work/scene'), ['導覽測試'], 'by folder');
  assert.deepEqual(await search(NEEDLE), [], 'text that only an old message holds finds nothing: this search does not read messages');
  assert.deepEqual(await search('最近的回答'), [], 'nor does text of the newest message, which the page holds');
});

test('there is no way to export a whole conversation from the page: the menu of a conversation offers none', { skip }, async () => {
  await b.goto(`${hub.url}#/s/s_nav`, 300);
  await b.waitFor(`document.querySelector('.toolbar button[aria-label="更多"]')`);
  await b.click('.toolbar button[aria-label="更多"]');
  await b.waitFor(`document.querySelector('.om-menu')`);
  const labels = await b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.ok(labels.length >= 3, `the menu has items (${labels.join(' | ')})`);
  assert.deepEqual(labels.filter((l) => /匯出|輸出成|下載對話|export|save as|另存/i.test(l)), [], 'no export of the conversation: when one is added it has to take the Hub\'s part of the conversation, not the window');
});
