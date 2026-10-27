// Conversation files that were damaged on disk, as a person sees them (a real
// Hub that really repairs / refuses the files, and the real front end):
//   - a repaired conversation says so in the sidebar and at its top, with what
//     the repair cost, and says when the repair is not on disk yet;
//   - files the Hub could not load at all raise one banner at the top of the
//     sidebar that opens to the list, can be put away, and does not come back
//     until a different file is on the list (also across a Hub restart);
//   - all of it readable in every look, light and dark, and on a phone.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skipReason, startHub, launchBrowser, CONTRAST_JS } from './browser-harness.mjs';
import { maker, storedSession } from './fixtures/window-scenes.mjs';
import { damagedView } from '../public/js/damaged.js';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
let unsavedHub;
let savedHub;
let b;

// A well-formed session file with a stretch of NUL bytes where a crash left
// the disk block unwritten: the Hub can repair it.
function nulled(session) {
  const buf = Buffer.from(JSON.stringify(session));
  const at = buf.indexOf('GAP-START') + 20;
  return Buffer.concat([buf.subarray(0, at), Buffer.alloc(300), buf.subarray(at + 300)]);
}
function fixedSession(id, title) {
  const m = maker(id);
  return storedSession([m.user('一個問題'), m.text(`GAP-START ${'一些文字 '.repeat(200)}`), m.text('後面的回覆'), m.end()], { id, title, kimiSessionId: `session_${id}` });
}

before(async () => {
  if (skip) return;
  const ok = storedSession([maker('o').user('hello'), maker('p').text('hi')], { id: 's_ok', title: '好的對話', kimiSessionId: 'session_ok' });
  hub = await startHub([ok], {
    seed: (data) => {
      fs.writeFileSync(path.join(data, 'sessions', 's_fixed.json'), nulled(fixedSession('s_fixed', '救回來的對話')));
      fs.writeFileSync(path.join(data, 'sessions', 's_empty.json'), '');
      fs.writeFileSync(path.join(data, 'sessions', 's_garbage.json'), 'this is not json {{{');
    },
  });
  // The place the backup goes is taken by a plain file, so no backup can be made:
  // the repaired conversation stays in memory and the original is left alone.
  // The Hub also saves every conversation a moment after it starts, and a save
  // that lands is what ends "not written back yet": here the disk refuses
  // conversation writes, so the repair really is still only in memory.
  const looseSeed = (data) => {
    fs.writeFileSync(path.join(data, 'sessions-damaged'), 'in the way');
    fs.writeFileSync(path.join(data, 'sessions', 's_loose.json'), nulled(fixedSession('s_loose', '還沒寫回的對話')));
  };
  unsavedHub = await startHub([], { seed: looseSeed, env: { NODE_OPTIONS: `--import ${new URL('./fixtures/fail-session-writes.mjs', import.meta.url).href}` } });
  // The same, on a disk that takes the write: the Hub's own save puts the repaired conversation on disk.
  savedHub = await startHub([], { seed: looseSeed });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  hub?.stop();
  unsavedHub?.stop();
  savedHub?.stop();
});

const open = async (h, hash = '#/', { width = 1280, height = 900, clear = true } = {}) => {
  await b.size(width, height, width < 700);
  await b.goto(h.url + hash, 300);
  if (clear) await b.eval(`localStorage.removeItem('hubDamagedDismissed')`);
  await b.eval('location.reload()');
  await sleep(800);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
  await b.waitFor(`document.querySelectorAll('.side-row').length > 0`);
};
const banner = () => b.eval(`(() => { const e = document.querySelector('.damaged-banner'); return e ? { text: e.querySelector('.damaged-text').innerText.trim(), open: e.querySelector('.damaged-head').getAttribute('aria-expanded'), items: [...e.querySelectorAll('.damaged-item')].map((i) => ({ file: i.querySelector('.damaged-file').innerText, reason: i.querySelector('.damaged-reason').innerText, backup: i.querySelector('.damaged-backup').innerText })), note: e.querySelector('.damaged-note')?.innerText ?? null } : null; })()`);
const contrast = (sel) => b.eval(`(${CONTRAST_JS})(${JSON.stringify(sel)})`);
const requests = () => b.eval(`performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/damaged-sessions')).length`);

test('the Hub really repairs one file and refuses two, and says so on /api/damaged-sessions', { skip }, async () => {
  const list = await hub.api('/damaged-sessions');
  assert.deepEqual(list.map((x) => [x.file, x.salvaged]).sort(), [['s_empty.json', false], ['s_fixed.json', true], ['s_garbage.json', false]]);
  assert.ok(list.find((x) => x.file === 's_fixed.json').removedBytes > 0);
});

test('files the Hub could not load raise one banner at the top of the sidebar, closed to a line', { skip }, async () => {
  await open(hub);
  await b.waitFor(`document.querySelector('.damaged-banner')`, { timeout: 8000 });
  const bn = await banner();
  assert.equal(bn.text, '2 個對話檔損壞無法載入', 'the repaired one is not counted: it has its own badge');
  assert.equal(bn.open, 'false');
  assert.deepEqual(bn.items, [], 'the list is closed');
  const order = await b.eval(`[...document.querySelector('.sidebar').children].map((e) => e.className.split(' ')[0])`);
  assert.ok(order.indexOf('damaged-slot') !== -1 && order.indexOf('damaged-slot') < order.indexOf('side-list'), `above the conversations (${order})`);
});

test('opening it lists each file with the Hub\'s reason and where the untouched original is kept', { skip }, async () => {
  await open(hub);
  await b.waitFor(`document.querySelector('.damaged-banner')`, { timeout: 8000 });
  await b.click('.damaged-head');
  const bn = await banner();
  assert.equal(bn.open, 'true');
  assert.deepEqual(bn.items.map((i) => i.file).sort(), ['s_empty.json', 's_garbage.json']);
  const empty = bn.items.find((i) => i.file === 's_empty.json');
  assert.match(empty.reason, /空的/);
  assert.match(empty.backup, /^備份：data\/sessions-damaged\/s_empty\.json\.\d+$/);
  assert.match(bn.note, /Hub 那台機器.*data\/sessions-damaged/, 'the backups are on the Hub\'s machine');
  // …and it closes again
  await b.click('.damaged-head');
  assert.equal((await banner()).open, 'false');
});

test('a repaired conversation carries a badge in the sidebar, with what the repair cost; the others carry none', { skip }, async () => {
  await open(hub);
  const rows = await b.eval(`[...document.querySelectorAll('.side-row')].map((r) => ({ title: r.querySelector('.row-title').innerText, badge: r.querySelector('.row-tag.salvaged')?.innerText ?? null, tip: r.querySelector('.row-tag.salvaged')?.title ?? null }))`);
  assert.deepEqual(rows.map((r) => [r.title, r.badge]).sort(), [['好的對話', null], ['救回來的對話', '曾損壞並已修復']]);
  const tip = rows.find((r) => r.badge).tip;
  assert.match(tip, /非法控制字元/, 'the reason');
  assert.match(tip, /約損失 300 位元組/, 'roughly what was lost');
  assert.match(tip, /data\/sessions-damaged\/s_fixed\.json\.\d+/, 'where the original is');
  assert.ok(!tip.includes('尚未寫回原檔'), 'it was written back');
});

test('at the top of a repaired conversation the same badge, and nothing on one that was never damaged', { skip }, async () => {
  await open(hub, '#/s/s_fixed');
  await b.waitFor(`document.querySelector('.toolbar .salvaged-badge')`, { timeout: 8000 });
  assert.equal(await b.eval(`document.querySelector('.toolbar .salvaged-badge').innerText.trim()`), '曾損壞並已修復');
  assert.match(await b.eval(`document.querySelector('.toolbar .salvaged-badge').title`), /約損失 300 位元組/);
  assert.equal(await b.eval(`document.querySelector('.toolbar .salvaged-unsaved')`), null, 'written back: no such warning');
  await open(hub, '#/s/s_ok');
  await b.waitFor(`document.querySelector('.toolbar .om-toolbar__title')?.innerText === '好的對話'`);
  assert.equal(await b.eval(`document.querySelector('.toolbar .salvaged-badge')`), null);
});

test('a repair that is not on disk yet says 尚未寫回原檔, at the top and in the sidebar', { skip }, async () => {
  await open(unsavedHub, '#/s/s_loose');
  await b.waitFor(`document.querySelector('.toolbar .salvaged-badge')`, { timeout: 8000 });
  assert.equal(await b.eval(`document.querySelector('.toolbar .salvaged-unsaved')?.innerText.trim()`), '尚未寫回原檔');
  assert.equal(await b.eval(`document.querySelector('.side-row .row-tag.salvaged')?.classList.contains('unsaved')`), true, 'the sidebar tag is marked too');
  assert.match(await b.eval(`document.querySelector('.side-row .row-tag.salvaged').title`), /尚未寫回原檔.*沒有備份原檔|沒有備份原檔.*尚未寫回原檔|尚未寫回原檔/s);
  assert.equal(await b.eval(`document.querySelector('.damaged-banner')`), null, 'a repaired file is not a file that failed to load');
});

test('once the Hub has written the repaired conversation to disk, 尚未寫回原檔 is gone — at the top, in the sidebar, and after a Hub restart', { skip }, async () => {
  const entry = async () => (await savedHub.api('/damaged-sessions')).find((x) => x.file === 's_loose.json');
  // The Hub's own save a moment after it started has landed (its first look says unsaved).
  for (let i = 0; i < 100 && (await entry()).unsaved; i++) await sleep(100);
  assert.equal((await entry()).unsaved, false, 'the list of damaged files no longer says so');
  await open(savedHub, '#/s/s_loose');
  await b.waitFor(`document.querySelector('.toolbar .salvaged-badge')`, { timeout: 8000 });
  assert.equal(await b.eval(`document.querySelector('.toolbar .salvaged-unsaved')`), null, 'no warning at the top');
  assert.equal(await b.eval(`document.querySelector('.side-row .row-tag.salvaged')?.classList.contains('unsaved')`), false, 'none in the sidebar');
  // The mark was not written into the file either: a restart does not bring it back.
  await savedHub.restart();
  assert.equal((await entry()).unsaved, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(savedHub.data, 'sessions', 's_loose.json'), 'utf8')).meta.salvaged.unsaved, undefined);
});

test('with no damaged files there is no banner at all', { skip }, async () => {
  await open(unsavedHub);
  await sleep(500);
  assert.equal(await b.eval(`document.querySelector('.damaged-slot').hidden`), true);
  assert.equal(await b.eval(`document.querySelector('.damaged-banner')`), null);
});

// ---------------------------------------------------------------- looks

const LOOKS = [
  { name: 'kimi-light', look: 'kimi', theme: 'light' },
  { name: 'kimi-dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'light' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
for (const L of LOOKS) {
  test(`${L.name}: the badges, the banner and its list are readable (WCAG AA) and fit the sidebar`, { skip }, async () => {
    await b.size(1280, 900);
    await b.goto(hub.url + '#/', 200);
    await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(L.look)}); localStorage.setItem('hubTheme', ${JSON.stringify(L.theme)}); localStorage.removeItem('hubDamagedDismissed')`);
    await b.goto(hub.url + '#/s/s_fixed', 300);
    await b.eval('location.reload()');
    await sleep(800);
    await b.waitFor(`document.querySelector('.damaged-banner') && document.querySelector('.toolbar .salvaged-badge')`, { timeout: 10000 });
    await b.click('.damaged-head');
    const checks = {
      'sidebar badge (open row)': '.side-row[aria-current="page"] .row-tag.salvaged',
      'toolbar badge': '.toolbar .salvaged-badge',
      'banner headline': '.damaged-banner .damaged-text',
      'banner file name': '.damaged-banner .damaged-file',
      'banner reason': '.damaged-banner .damaged-reason',
      'banner backup': '.damaged-banner .damaged-backup',
      'banner note': '.damaged-banner .damaged-note',
    };
    for (const [what, sel] of Object.entries(checks)) {
      const r = await contrast(sel);
      assert.ok(r, `${L.name}: ${what} is on the page`);
      assert.ok(r.ratio >= 4.5, `${L.name}: ${what} is ${r.ratio.toFixed(2)}:1, needs 4.5:1 (text ${r.fg}, behind it ${r.bg})`);
    }
    // not the open row: the tag on a row nobody is pointing at
    await b.goto(hub.url + '#/s/s_ok', 300);
    await b.waitFor(`document.querySelector('.side-row .row-tag.salvaged')`);
    const idle = await contrast('.side-row:not([aria-current="page"]) .row-tag.salvaged');
    assert.ok(idle && idle.ratio >= 4.5, `${L.name}: sidebar badge on a row that is not open ${idle?.ratio?.toFixed(2)}:1`);
    // nothing sticks out of the sidebar
    const over = await b.eval(`(() => { const sb = document.querySelector('.sidebar').getBoundingClientRect(); return [...document.querySelectorAll('.damaged-banner, .damaged-banner *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > sb.right + 1 || r.left < sb.left - 1); }).map((e) => e.className); })()`);
    assert.deepEqual(over, [], `${L.name}: inside the sidebar`);
  });
}

test('on a phone: the banner is in the drawer, opens, lists, closes and fits the screen; the badge is at the top of the conversation', { skip }, async () => {
  await b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', 'light')`);
  await open(hub, '#/s/s_fixed', { width: 390, height: 800 });
  await b.waitFor(`document.querySelector('.toolbar .salvaged-badge')`, { timeout: 10000 });
  const top = await b.eval(`(() => { const e = document.querySelector('.toolbar .salvaged-badge'); const r = e.getBoundingClientRect(); const t = document.querySelector('.toolbar').getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth + 1, visible: r.width > 0 && r.height > 0 && r.bottom <= t.bottom + 1 }; })()`);
  assert.deepEqual(top, { inside: true, visible: true }, 'the badge fits in the toolbar');
  await b.click('.sidebar-toggle');
  await b.waitFor(`document.querySelector('.app').classList.contains('drawer')`);
  await b.waitFor(`document.querySelector('.damaged-banner')`);
  await b.click('.damaged-head');
  await sleep(400);
  const fit = await b.eval(`(() => { const out = []; for (const e of document.querySelectorAll('.damaged-banner, .damaged-banner *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && (r.right > innerWidth + 1 || r.left < -1)) out.push(e.className); } return { out, scrollX: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
  assert.deepEqual(fit, { out: [], scrollX: false }, 'nothing past the screen edge, no sideways scroll');
  assert.ok((await banner()).items.length === 2);
  // the close button is a real touch target
  const size = await b.eval(`(() => { const r = document.querySelector('.damaged-close').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  assert.ok(size[0] >= 28 && size[1] >= 28, `close button ${size}`);
});

// Last: it restarts the Hub and adds a file, which the tests above must not see.
test('put away, it stays away: across a reload and a Hub restart; a different file brings it back, found when the socket reconnects', { skip }, async () => {
  await open(hub);
  await b.waitFor(`document.querySelector('.damaged-banner')`, { timeout: 8000 });
  await b.click('.damaged-close');
  assert.equal(await b.eval(`document.querySelector('.damaged-slot').hidden`), true, 'put away');
  await b.eval('location.reload()');
  await sleep(1200);
  assert.equal(await b.eval(`document.querySelector('.damaged-slot').hidden`), true, 'still away after a reload');

  // The Hub restarts with the same files: the page reconnects, asks again, and says nothing.
  const asked = await requests();
  await hub.restart();
  await b.waitFor(`performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/damaged-sessions')).length > ${asked}`, { timeout: 20000, label: 'asked again after the reconnect' });
  await sleep(300);
  assert.equal(await b.eval(`document.querySelector('.damaged-slot').hidden`), true, 'the same set: not bothered again');

  // Another damaged file appears, then the Hub restarts: the banner comes back, on the open page.
  fs.writeFileSync(path.join(hub.data, 'sessions', 's_third.json'), '');
  const before = await requests();
  await hub.restart();
  await b.waitFor(`performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/damaged-sessions')).length > ${before}`, { timeout: 20000, label: 'asked again' });
  await b.waitFor(`document.querySelector('.damaged-banner .damaged-text')?.innerText.trim() === '3 個對話檔損壞無法載入'`, { timeout: 8000, label: 'banner with 3' });
  const list = damagedView(await hub.api('/damaged-sessions'));
  assert.equal(list.count, 3);
});
