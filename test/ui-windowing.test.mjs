// A long conversation is shown as its newest part; the rest comes as you scroll
// up, without the view jumping, and in the end the page holds exactly what it
// would have if everything had been drawn at once.
//
// Two ways a conversation arrives are covered: from a Hub that cuts it into
// windows (a stand-in for it sits in front of a real Hub, see
// fixtures/windowing-proxy.mjs), and from one that sends it whole (the front end
// holds the older part back itself).
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { startWindowingProxy } from './fixtures/windowing-proxy.mjs';
import { synthSession } from './fixtures/synth-conversation.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
let proxy;
let b;
// 700 events: more than the front end holds back for itself (240), more than
// the stand-in's window (100), and a few of them very long.
const session = synthSession({ id: 's_long', title: '長對話', count: 700, seed: 5, big: 0.05, bigBytes: 60_000 });
const total = session.events.length;

before(async () => {
  if (skip) return;
  hub = await startHub([session, synthSession({ id: 's_short', title: '短對話', count: 30, seed: 2 })]);
  proxy = await startWindowingProxy({ target: hub.url, size: 100, truncateOver: 40_000, previewBytes: 2000 });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  await proxy?.close();
  hub?.stop();
});

const open = async (base, sid) => {
  await b.goto(`${base}#/s/${sid}`, 300);
  await b.waitFor(`document.querySelectorAll('.transcript .column > .ev').length > 0`, { timeout: 15000 });
  await b.waitFor(`document.querySelector('.transcript .column > .ev')?.textContent.trim().length > 0 || true`);
  await sleep(500);
};
// Event ids drawn so far (rows and the rows inside folded groups).
const drawnIds = () => b.eval(`[...document.querySelectorAll('.transcript .column [data-id]')].map((e) => e.dataset.id)`);
const scroller = `document.querySelector('.transcript')`;
// The row at the top of the view and its distance from the top edge.
const topRow = () =>
  b.eval(`(() => {
    const sc = ${scroller};
    const box = sc.getBoundingClientRect();
    for (const e of sc.querySelectorAll('.column > .ev')) {
      const r = e.getBoundingClientRect();
      if (r.bottom > box.top + 1 && r.height > 0) return { id: e.dataset.id || e.querySelector('[data-id]')?.dataset.id, y: Math.round(r.top - box.top), top: sc.scrollTop };
    }
    return null;
  })()`);
const rowY = (id) => b.eval(`(() => { const sc = ${scroller}; const e = sc.querySelector('[data-id="${id}"]'); if (!e) return null; const row = e.closest('.column > .ev') || e; return Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top); })()`);
const settle = async () => {
  // the slice has been fetched and drawn, and the backlog is done
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const busy = await b.eval(`document.querySelector('.transcript .earlier')?.classList.contains('busy')`);
    if (!busy) break;
  }
  await sleep(250);
};

test('a windowed conversation opens as its newest part, with a marker for the rest', { skip }, async () => {
  await open(proxy.url, 's_long');
  const ids = await drawnIds();
  assert.ok(ids.length > 0 && ids.length < total, `only the window is drawn (${ids.length} of ${total} events)`);
  assert.ok(ids.length <= 140, `about the window, not much more (${ids.length})`);
  assert.equal(ids.at(-1), session.events.at(-1).id, 'the newest event is the last one drawn');
  assert.equal(await b.eval(`!document.querySelector('.transcript .earlier').hidden`), true, 'the earlier-messages marker is shown');
  assert.equal(await b.eval(`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 40`), true, 'the view is at the newest message');
});

test('scrolling to the top loads the slice before it and the view stays where it was', { skip }, async () => {
  await open(proxy.url, 's_long');
  const pagesBefore = proxy.stats.pages;
  const drawnBefore = (await drawnIds()).length;
  // Right at the top edge, where the browser itself does not hold the view in place.
  await b.eval(`${scroller}.scrollTop = 0`);
  await sleep(150);
  const at = await topRow();
  assert.ok(at, 'a row is at the top');
  await b.eval(`${scroller}.dispatchEvent(new Event('scroll'))`);
  await b.waitFor(`document.querySelectorAll('.transcript .column [data-id]').length > ${drawnBefore}`, { timeout: 8000 });
  await settle();
  assert.ok(proxy.stats.pages > pagesBefore, 'the earlier slice was asked for from the Hub');
  // The page is anchored to the event, not only to a position (see P-A: Kimi's own
  // 「載入更早」 shifts every index).
  assert.ok(proxy.stats.beforeIds.length > 0 && proxy.stats.beforeIds.every((id) => typeof id === 'string' && id), 'every earlier-page request names the event it goes before');
  const y = await rowY(at.id);
  assert.notEqual(y, null, 'the row that was at the top is still there');
  assert.ok(Math.abs(y - at.y) <= 2, `and still at the same place on screen (was ${at.y}px, now ${y}px)`);
});

test('loading every slice gives the same page as drawing the whole conversation at once', { skip }, async () => {
  await open(proxy.url, 's_long');
  for (let i = 0; i < 60; i++) {
    const more = await b.eval(`!document.querySelector('.transcript .earlier').hidden`);
    if (!more) break;
    await b.eval(`${scroller}.scrollTop = 0`);
    await sleep(250);
    await settle();
  }
  assert.equal(await b.eval(`document.querySelector('.transcript .earlier').hidden`), true, 'the marker goes when nothing is left');
  const ids = await drawnIds();
  assert.deepEqual(ids, [...new Set(ids)], 'no event is drawn twice');
  assert.equal(ids.length, total, 'every event is there');
  // the structure of the page: every row (and group) in order, by event id
  const shape = await b.eval(`[...document.querySelectorAll('.transcript .column > .ev')].map((e) => e.dataset.id ? e.className.replace(/\\s+/g, ' ') + '#' + e.dataset.id : 'group[' + [...e.querySelectorAll('[data-id]')].map((x) => x.dataset.id).join(',') + ']')`);
  // the same conversation delivered whole, with the front end's own hold-back lifted by scrolling
  await open(hub.url, 's_long');
  for (let i = 0; i < 60; i++) {
    if (await b.eval(`document.querySelector('.transcript .earlier').hidden`)) break;
    await b.eval(`${scroller}.scrollTop = 0`);
    await sleep(250);
    await settle();
  }
  const whole = await b.eval(`[...document.querySelectorAll('.transcript .column > .ev')].map((e) => e.dataset.id ? e.className.replace(/\\s+/g, ' ') + '#' + e.dataset.id : 'group[' + [...e.querySelectorAll('[data-id]')].map((x) => x.dataset.id).join(',') + ']')`);
  assert.deepEqual(shape, whole, 'windowed and whole give the same rows and groups');
  assert.ok(whole.length > 100, 'and there was something to compare');
});

test('a fresh copy after a dropped connection keeps the older part already loaded and the view where it was', { skip }, async () => {
  await open(proxy.url, 's_long');
  await b.eval(`${scroller}.scrollTop = 0`);
  await b.waitFor(`document.querySelectorAll('.transcript .column [data-id]').length > 150`, { timeout: 8000 });
  await settle();
  // read somewhere in the middle of what is loaded
  await b.eval(`${scroller}.scrollTop = ${scroller}.scrollHeight / 2`);
  await sleep(300);
  const at = await topRow();
  const held = (await drawnIds()).length;
  const snapshots = proxy.stats.snapshots;
  proxy.dropSockets();
  await b.waitFor(`true`);
  for (let i = 0; i < 60 && proxy.stats.snapshots === snapshots; i++) await sleep(100);
  assert.ok(proxy.stats.snapshots > snapshots, 'the page reconnected and was sent a new copy');
  await sleep(600);
  assert.equal((await drawnIds()).length, held, 'the older events already loaded are still there');
  const y = await rowY(at.id);
  assert.ok(y !== null && Math.abs(y - at.y) <= 2, `and the view did not move (was ${at.y}px, now ${y}px)`);
});

test('a conversation that arrives whole shows its newest part and loads the rest as you scroll, without asking the Hub', { skip }, async () => {
  const before = proxy.stats.pages;
  await open(hub.url, 's_long');
  const ids = await drawnIds();
  assert.ok(ids.length > 0 && ids.length < 400, `held back (${ids.length} of ${total} events drawn)`);
  assert.equal(await b.eval(`!document.querySelector('.transcript .earlier').hidden`), true, 'the marker is there');
  const drawnBefore = ids.length;
  await b.eval(`${scroller}.scrollTop = 0`);
  await sleep(150);
  const at = await topRow();
  await b.eval(`${scroller}.dispatchEvent(new Event('scroll'))`);
  await b.waitFor(`document.querySelectorAll('.transcript .column [data-id]').length > ${drawnBefore}`, { timeout: 8000 });
  await settle();
  const y = await rowY(at.id);
  assert.ok(y !== null && Math.abs(y - at.y) <= 2, `the view did not jump (was ${at?.y}px, now ${y}px)`);
  assert.equal(proxy.stats.pages, before, 'nothing was fetched from the Hub for it');
});

test('a run of reads cut by the edge of a window is one row once the earlier part arrives', { skip }, async () => {
  // 40 events, a run of seven Reads at 10..16, and a window that starts in the middle of it (13).
  const evs = Array.from({ length: 40 }, (_, i) => {
    const base = { id: `r${i}`, ts: 1_790_000_000_000 + i * 1000 };
    if (i >= 10 && i <= 16) return { ...base, type: 'tool_use', agentId: 'main', name: 'Read', title: `/w/f${i}.js`, status: 'done', input: { path: `/w/f${i}.js` }, output: `line ${i}`, isError: false };
    // tall enough that the window fills the screen and its margin, so nothing is loaded by itself
    const tall = Array.from({ length: 8 }, (_, k) => `paragraph ${k} of ${i}: ${'words '.repeat(40)}`).join('\n\n');
    return i % 5 === 0 ? { ...base, type: 'user', text: `question ${i}\n\n${tall}` } : { ...base, type: 'text', agentId: 'main', text: tall };
  });
  const runHub = await startHub([synthSession({ id: 's_runs', title: 'runs', count: 1, seed: 1 }), { ...synthSession({ id: 's_runs', title: 'runs', count: 1, seed: 1 }), events: evs }]);
  const runProxy = await startWindowingProxy({ target: runHub.url, size: 27 });
  try {
    await open(runProxy.url, 's_runs');
    assert.equal(await b.eval(`document.querySelector('[data-id="r13"]') && !document.querySelector('[data-id="r12"]')`), true, 'the window starts inside the run');
    await b.eval(`${scroller}.scrollTop = 0`);
    await b.waitFor(`document.querySelector('[data-id="r10"]')`, { timeout: 8000 });
    await settle();
    const groups = await b.eval(`[...document.querySelectorAll('.transcript .column > .tool-group')].map((g) => [...g.querySelectorAll('[data-id]')].map((x) => x.dataset.id).join(','))`);
    assert.deepEqual(groups, ['r10,r11,r12,r13,r14,r15,r16'], 'seven reads in one group');
    assert.match(await b.eval(`document.querySelector('.transcript .column > .tool-group .tool-verb')?.textContent`), /7/, 'whose title counts all seven');
  } finally {
    await runProxy.close();
    runHub.stop();
  }
});

test('while the first copy is on its way grey placeholder bars fade in, and they are gone once it is drawn', { skip }, async () => {
  proxy.holdSnapshots(1200);
  try {
    await b.goto(`${proxy.url}#/s/s_long`, 300);
    await b.waitFor(`document.querySelector('.transcript-skeleton')`, { timeout: 8000 });
    await sleep(500);
    const shown = await b.eval(`Number(getComputedStyle(document.querySelector('.transcript-skeleton')).opacity)`);
    assert.ok(shown > 0.9, `visible after a moment of waiting (opacity ${shown})`);
    assert.equal(await b.eval(`document.querySelectorAll('.transcript .column > .ev').length`), 0, 'and nothing else is drawn yet');
  } finally {
    proxy.holdSnapshots(0);
  }
  await b.waitFor(`document.querySelectorAll('.transcript .column > .ev').length > 0`, { timeout: 8000 });
  assert.equal(await b.eval(`document.querySelector('.transcript-skeleton')`), null, 'the bars are gone');
});

test('a short conversation has no marker', { skip }, async () => {
  await open(proxy.url, 's_short');
  assert.equal(await b.eval(`document.querySelector('.transcript .earlier').hidden`), true);
});

test('an event the Hub cut short says so, and opening it brings the whole', { skip }, async () => {
  // a long tool output in the newest window
  const target = session.events.slice(-100).find((e) => e.type === 'tool_use' && typeof e.output === 'string' && e.output.length > 40_000 && !e.parent);
  assert.ok(target, 'the fixture has a long output in its newest window');
  await open(proxy.url, 's_long');
  const fullsBefore = proxy.stats.fulls;
  // a folded read/search group is opened first (a group of one is not folded)
  await b.eval(`(() => { const g = document.querySelector('[data-id="${target.id}"]').closest('.tool-group'); g?.querySelector(':scope > .tool-head .tool-row')?.click(); })()`);
  await sleep(200);
  await b.eval(`document.querySelector('[data-id="${target.id}"] .tool-head .tool-row')?.click()`);
  await b.waitFor(`document.querySelector('[data-id="${target.id}"] .trunc-note')`);
  const shown = await b.eval(`document.querySelector('[data-id="${target.id}"] pre.out')?.textContent.length`);
  assert.ok(shown < 10_000, `only a preview is drawn (${shown} chars)`);
  await b.eval(`document.querySelector('[data-id="${target.id}"] .trunc-btn').click()`);
  await b.waitFor(`!document.querySelector('[data-id="${target.id}"] .trunc-note')`, { timeout: 8000 });
  const full = await b.eval(`document.querySelector('[data-id="${target.id}"] pre.out')?.textContent.length`);
  assert.ok(full >= target.output.length - 2, `the whole output is drawn now (${full} of ${target.output.length})`);
  assert.equal(proxy.stats.fulls, fullsBefore + 1, 'with one request');
});
