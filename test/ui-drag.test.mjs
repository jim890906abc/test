// Dragging the dividers (the side panel's edge, the 子代理 list/report bars) in a
// real browser: the size follows the pointer, nothing is saved or measured while it
// moves (that is what made it stutter), it is saved once when let go, a frame
// on the page cannot take the pointer away, and double-click still resets.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
let ui;
let b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
});
after(() => ui?.stop());

const point = (sel) => b.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) }; })()`);
const mouse = (type, x, y, buttons = 0) => b.send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
// Count writes to storage from now on.
const spyStorage = () => b.eval(`(() => { window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (...a) { if (a[0] === 'hubLayout') window.__writes++; return set.apply(this, a); }; })()`);
const writes = () => b.eval('window.__writes');
// Count reads of a size from the panel or the sidebar (each one, right after a write, makes the browser lay the page out on the spot).
const spyReads = () =>
  b.eval(`(() => {
    window.__reads = 0;
    for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight']) {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, prop) || Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { if (this.closest?.('.panel, .sidebar') || this.matches?.('.panel, .sidebar')) window.__reads++; return d.get.call(this); } });
    }
  })()`);
const reads = () => b.eval('window.__reads');
const panelWidth = () => b.eval(`document.querySelector('.panel').getBoundingClientRect().width`);
const saved = () => b.eval(`JSON.parse(localStorage.getItem('hubLayout') || '{}')`);

async function openPanel(hash = '#/s/s_claude') {
  await ui.openApp(hash);
  await b.eval(`localStorage.removeItem('hubLayout')`);
  await ui.openApp(hash);
  await b.waitFor(`document.querySelector('.transcript .column > .ev')`);
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('.panel-grip')`);
  await sleep(300);
}

test('dragging the side panel\'s edge follows the pointer, saves nothing until it is let go, then saves once', { skip }, async () => {
  await openPanel();
  await spyStorage();
  const w0 = await panelWidth();
  const g = await point('.panel-grip');
  await mouse('mouseMoved', g.x, g.y);
  await mouse('mousePressed', g.x, g.y, 1);
  assert.equal(await b.eval(`document.querySelector('.app').classList.contains('resizing')`), true, 'the page is in dragging mode');
  await spyReads();
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', g.x - i * 20, g.y, 1);
    await sleep(20);
  }
  await sleep(50);
  assert.equal(await reads(), 0, 'and no size of the panel or sidebar was read while it moved');
  const during = await panelWidth();
  assert.ok(Math.abs(during - (w0 + 200)) <= 3, `the panel is ${Math.round(during - w0)}px wider, as far as the pointer went (200)`);
  assert.equal(await writes(), 0, 'nothing was saved while it moved');
  await mouse('mouseReleased', g.x - 200, g.y, 0);
  await sleep(100);
  assert.equal(await b.eval(`document.querySelector('.app').classList.contains('resizing')`), false, 'dragging mode is over');
  assert.equal(await writes(), 1, 'saved once, when it was let go');
  assert.ok(Math.abs((await saved()).panelW - during) <= 2, `and what was saved is where it ended (${(await saved()).panelW})`);
});

test('the edge stops at the same limits as before, and double-click puts it back', { skip }, async () => {
  await openPanel();
  const w0 = await panelWidth();
  const g = await point('.panel-grip');
  await mouse('mouseMoved', g.x, g.y);
  await mouse('mousePressed', g.x, g.y, 1);
  await mouse('mouseMoved', 5, g.y, 1); // far past the other side
  await sleep(80);
  await mouse('mouseReleased', 5, g.y, 0);
  const wide = await panelWidth();
  const sidebar = await b.eval(`document.querySelector('.sidebar').getBoundingClientRect().width`);
  assert.ok(Math.abs(wide - (1280 - sidebar - 360)) <= 2, `stops short of the conversation's minimum (${Math.round(wide)}px)`);
  const g2 = await point('.panel-grip');
  await mouse('mouseMoved', g2.x, g2.y);
  await mouse('mousePressed', g2.x, g2.y, 1);
  await mouse('mouseMoved', 1270, g2.y, 1);
  await sleep(80);
  await mouse('mouseReleased', 1270, g2.y, 0);
  assert.equal(Math.round(await panelWidth()), 320, 'and at the other end at 320px');
  await b.eval(`document.querySelector('.panel-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(100);
  assert.ok(Math.abs((await panelWidth()) - w0) <= 2, 'double-click gives the default width back');
  assert.equal((await saved()).panelW, undefined, 'and forgets the saved one');
});

test('a frame on the page does not take the pointer while a divider is dragged', { skip }, async () => {
  await openPanel();
  await b.eval(`(() => { const f = document.createElement('iframe'); f.className = 'artifact-frame'; f.id = 'probe-frame'; f.srcdoc = '<p>x</p>'; document.querySelector('.panel').append(f); const g = document.createElement('iframe'); g.id = 'probe-other'; g.srcdoc = '<p>y</p>'; document.querySelector('.panel').append(g); })()`);
  const pe = () => b.eval(`['probe-frame', 'probe-other'].map((id) => getComputedStyle(document.getElementById(id)).pointerEvents)`);
  assert.deepEqual(await pe(), ['auto', 'auto']);
  const g = await point('.panel-grip');
  await mouse('mouseMoved', g.x, g.y);
  await mouse('mousePressed', g.x, g.y, 1);
  await mouse('mouseMoved', g.x - 40, g.y, 1);
  assert.deepEqual(await pe(), ['none', 'none'], 'frames let the pointer through while dragging');
  await mouse('mouseReleased', g.x - 40, g.y, 0);
  await sleep(80);
  assert.deepEqual(await pe(), ['auto', 'auto'], 'and take it again after');
});

test('the 子代理 list/report bars drag the same way: the size follows, saved once at the end', { skip }, async () => {
  await openPanel('#/s/s_kimi');
  await b.eval(`[...document.querySelectorAll('.om-seg__item')].find((x) => x.textContent.startsWith('子代理'))?.click()`);
  await b.waitFor(`document.querySelector('.agent-sec--grip')`);
  await sleep(300);
  await spyStorage();
  const h0 = await b.eval(`document.querySelector('.agent-top').getBoundingClientRect().height`);
  const g = await point('.agent-pane.agent-steps .agent-sec--grip');
  await mouse('mouseMoved', g.x, g.y);
  await mouse('mousePressed', g.x, g.y, 1);
  assert.equal(await b.eval(`document.querySelector('.app').classList.contains('resizing-row')`), true, 'the row-resize cursor mode');
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', g.x, g.y - i * 10, 1);
    await sleep(20);
  }
  await sleep(60);
  const h1 = await b.eval(`document.querySelector('.agent-top').getBoundingClientRect().height`);
  assert.ok(h0 - h1 > 40 && h0 - h1 < 70, `the list is ${Math.round(h0 - h1)}px shorter (pointer went up 60px)`);
  assert.equal(await writes(), 0, 'nothing saved while it moves');
  await mouse('mouseReleased', g.x, g.y - 60, 0);
  await sleep(100);
  assert.equal(await writes(), 1, 'saved once at the end');
  assert.ok((await saved()).agentListH > 0);
  assert.equal(await b.eval(`document.querySelector('.app').className.includes('resizing')`), false);
});
