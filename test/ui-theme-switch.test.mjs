// Changing the look (Kimi / Claude / DeepSeek) or light/dark from the 設定 menu,
// in a real browser: the old picture of the page fades into the new one as a
// whole (View Transitions), not element by element; it can be skipped (reduced
// motion, no API, an API that throws); a run of changes does not pile up; and
// nothing the page is doing is interrupted by it — a live page in the side
// panel, a reply being written, the scroll position, the cursor in the message
// box, an element fixed to the screen.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { startWindowingProxy } from './fixtures/windowing-proxy.mjs';
import { synthSession, synthMarkdown, withArtifact } from './perf-lib.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
let proxy;
let b;

before(async () => {
  if (skip) return;
  hub = await startHub([synthSession({ id: 's_chat', title: '串流', count: 300, seed: 21 }), withArtifact(synthSession({ id: 's_art', title: '有頁面', count: 150, seed: 5 }))]);
  proxy = await startWindowingProxy({ target: hub.url, size: 150 });
  await proxy.warm('s_chat');
  await proxy.warm('s_art');
  b = await launchBrowser();
  // every page: count what the page asks of View Transitions, and what goes unhandled
  await b.beforeLoad(`(() => {
    const log = (window.__fade = { started: 0, rejections: [] });
    const begin = document.startViewTransition?.bind(document);
    if (begin) document.startViewTransition = (...a) => { log.started++; return begin(...a); };
    addEventListener('unhandledrejection', (e) => log.rejections.push(String(e.reason)));
  })()`);
});
after(async () => {
  await b?.close();
  await proxy?.close();
  hub?.stop();
});

const LOOK = (look, theme = 'light') => b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(look)}); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
async function open(hash, { look = 'kimi', theme = 'light', width = 1280, height = 900, reduced = false } = {}) {
  await b.size(width, height, width < 700);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  await b.goto(proxy.url + '#/', 300);
  await LOOK(look, theme);
  await b.goto(proxy.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
  await b.waitFor(`document.querySelector('.transcript .column > .ev')`, { timeout: 15000 });
  await sleep(600);
  if (width < 700) {
    await b.click('.sidebar-toggle');
    await b.waitFor(`document.querySelector('.app.drawer')`);
    await sleep(400);
  }
}

// Open 設定 and choose an entry, with a pointer.
async function choose(label) {
  const mouse = async (x, y) => {
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const centre = (js) => b.eval(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const gear = await centre(`document.querySelector('.side-foot button[aria-label="設定"]')`);
  await mouse(gear.x, gear.y);
  await b.waitFor(`document.querySelector('.om-menu__item')`);
  await sleep(250);
  const at = await centre(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.querySelector('.menu-label')?.textContent.trim().startsWith(${JSON.stringify(label)}))`);
  assert.ok(at, `the menu has ${label}`);
  await mouse(at.x, at.y);
}

// Per frame, from now until `ms` have passed: is the fade marker on, how many
// element colour transitions as long as a fade run (the page's own hover
// transitions are shorter), which view-transition animations run and how far.
const WATCH = (ms) => `new Promise((resolve) => {
  const out = [];
  const t0 = performance.now();
  const colour = /color|fill|stroke/;
  const tick = (t) => {
    const all = document.getAnimations();
    out.push({
      at: t - t0,
      marker: document.documentElement.hasAttribute('data-color-fade'),
      look: document.documentElement.dataset.look,
      theme: document.documentElement.dataset.theme || '',
      colourTransitions: all.filter((a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition && colour.test(a.transitionProperty) && a.effect.getTiming().duration >= 150).length,
      view: all.filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition')).map((a) => ({ pseudo: a.effect.pseudoElement, t: a.currentTime, d: a.effect.getTiming().duration, ease: a.effect.getKeyframes()[0]?.easing })),
      newOpacity: getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity,
    });
    if (t - t0 < ${ms}) requestAnimationFrame(tick); else resolve(out);
  };
  requestAnimationFrame(tick);
})`;

const token = (name) => b.eval(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
const state = () => b.eval(`({ look: document.documentElement.dataset.look, theme: document.documentElement.dataset.theme || '', saved: localStorage.getItem('hubPalette'), savedTheme: localStorage.getItem('hubTheme'), marker: document.documentElement.hasAttribute('data-color-fade'), started: window.__fade.started, rejections: window.__fade.rejections })`);

test('choosing a look fades one whole picture into the other: no element has a colour transition, the fade takes --dur-base', { skip }, async () => {
  await open('#/s/s_chat');
  const watching = b.eval(WATCH(700));
  await choose('Claude');
  const frames = await watching;
  const dur = Number.parseFloat(await token('--dur-base'));
  assert.ok(dur >= 150 && dur <= 250, `the fade token is ${dur} ms (150–250)`);
  const fading = frames.filter((f) => f.view.length);
  assert.ok(fading.length >= 5, `the cross-fade was on screen for ${fading.length} frames`);
  assert.equal(Math.max(...frames.map((f) => f.colourTransitions)), 0, 'no element ran a colour transition of fade length (before, every element did)');
  const anims = fading.flatMap((f) => f.view);
  assert.deepEqual([...new Set(anims.map((a) => a.pseudo))], ['::view-transition-new(root)'], 'one animation: the new picture comes in over the old one');
  assert.equal(anims[0].d, dur, 'for as long as --dur-base');
  assert.equal(anims[0].ease, await token('--ease-move'), 'on the --ease-move curve');
  assert.ok(Math.max(...fading.map((f) => f.view.length)) === 1, 'and only one at a time');
  // the opacity of the new picture goes up through the middle, never jumps
  const op = fading.map((f) => Number(f.newOpacity)).filter(Number.isFinite);
  assert.ok(op.some((v) => v > 0.05 && v < 0.95), `the new picture was part way in (${op.map((v) => v.toFixed(2)).join(' ')})`);
  for (let i = 1; i < op.length; i++) assert.ok(op[i] >= op[i - 1] - 1e-6, 'and only ever more of it');
  assert.ok(frames.some((f) => f.marker), 'the page says it is fading while it does');
  const end = await state();
  assert.deepEqual({ look: end.look, saved: end.saved, marker: end.marker }, { look: 'claude', saved: 'claude', marker: false }, 'then the new look is in, saved, and the marker is gone');
  assert.deepEqual(end.rejections, [], 'nothing went unhandled');
  assert.equal(await b.eval(`document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition')).length`), 0, 'and nothing is left running');
});

test('the colours are in the page on the next frame, and light/dark goes the same way', { skip }, async () => {
  await open('#/s/s_chat');
  const t0 = Date.now();
  await choose('深色');
  await b.waitFor(`document.documentElement.dataset.theme === 'dark'`, { timeout: 1000 });
  assert.ok(Date.now() - t0 < 1000);
  const [r, g, bl] = (await b.eval(`getComputedStyle(document.querySelector('.app')).backgroundColor`)).match(/\d+/g).map(Number);
  assert.ok((r + g + bl) / 3 < 90, `the window is dark (${r},${g},${bl})`);
  await b.waitFor(`!document.documentElement.hasAttribute('data-color-fade')`, { timeout: 1500 });
  assert.equal((await state()).savedTheme, 'dark');
  await choose('淺色');
  await b.waitFor(`document.documentElement.dataset.theme === 'light' && !document.documentElement.hasAttribute('data-color-fade')`, { timeout: 1500 });
});

test('with prefers-reduced-motion the change is made at once, with no transition started', { skip }, async () => {
  await open('#/s/s_chat', { reduced: true });
  const before = (await state()).started;
  // one task: click the entry and look straight away
  await b.eval(`document.querySelector('.side-foot button[aria-label="設定"]').click()`);
  await b.waitFor(`document.querySelector('.om-menu__item')`);
  const seen = await b.eval(`(() => { [...document.querySelectorAll('.om-menu__item')].find((i) => i.querySelector('.menu-label').textContent.trim().startsWith('Claude')).click(); return { look: document.documentElement.dataset.look, marker: document.documentElement.hasAttribute('data-color-fade') }; })()`);
  assert.deepEqual(seen, { look: 'claude', marker: false }, 'the look is in before the click returns');
  assert.equal((await state()).started, before, 'no view transition was started');
});

test('a browser without View Transitions, or one whose call throws, still changes the colours at once', { skip }, async () => {
  await open('#/s/s_chat');
  for (const [name, stub] of [['missing', `document.startViewTransition = undefined`], ['throwing', `document.startViewTransition = () => { throw new Error('not here'); }`]]) {
    await b.eval(stub);
    const to = name === 'missing' ? 'DeepSeek' : 'Claude';
    await b.eval(`document.querySelector('.side-foot button[aria-label="設定"]').click()`);
    await b.waitFor(`document.querySelector('.om-menu__item')`);
    const seen = await b.eval(`(() => { [...document.querySelectorAll('.om-menu__item')].find((i) => i.querySelector('.menu-label').textContent.trim().startsWith(${JSON.stringify(to)})).click(); return { look: document.documentElement.dataset.look, marker: document.documentElement.hasAttribute('data-color-fade') }; })()`);
    assert.deepEqual(seen, { look: to.toLowerCase(), marker: false }, `${name}: the look is in before the click returns`);
    assert.equal((await state()).saved, to.toLowerCase(), `${name}: and saved`);
    await sleep(100);
  }
});

test('a run of changes does not pile up: one fade at a time, the last change wins, the page stays alive', { skip }, async () => {
  await open('#/s/s_chat');
  const res = await b.eval(`(async () => {
    const { fadeColors } = await import('/js/color-fade.js');
    const looks = ['claude', 'deepseek', 'kimi', 'claude', 'deepseek', 'kimi', 'claude', 'deepseek'];
    const peak = { views: 0, transitions: 0 };
    let go = true;
    const watch = () => { const v = document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition')).length; peak.views = Math.max(peak.views, v); if (go) requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
    const done = [];
    for (const [i, look] of looks.entries()) {
      done.push(fadeColors(() => { document.documentElement.dataset.look = look; localStorage.setItem('hubPalette', look); }));
      await new Promise((r) => setTimeout(r, i % 2 ? 20 : 60));
    }
    await Promise.all(done);
    await new Promise((r) => setTimeout(r, 600));
    go = false;
    return { peak, look: document.documentElement.dataset.look, marker: document.documentElement.hasAttribute('data-color-fade'), rejections: window.__fade.rejections, left: document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition')).length };
  })()`);
  assert.equal(res.look, 'deepseek', 'the last change is the look the page ends with');
  assert.ok(res.peak.views <= 1, `never more than one fade on screen (${res.peak.views})`);
  assert.equal(res.marker, false, 'the marker is gone');
  assert.equal(res.left, 0);
  assert.deepEqual(res.rejections, [], 'and the fades that were cut short raised nothing');
  // and the page answers: the settings menu opens
  await b.click('.side-foot button[aria-label="設定"]');
  await b.waitFor(`document.querySelector('.om-menu__item')`, { timeout: 2000 });
});

test('the picture half way through is the two whole pictures mixed, not part of one and part of the other', { skip }, async () => {
  await open('#/s/s_chat');
  const shot = async () => (await b.send('Page.captureScreenshot', { format: 'png' })).result.data;
  const start = await shot();
  await choose('Claude');
  const held = await b.eval(`new Promise((resolve) => { const t0 = performance.now(); const tick = () => { const list = document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition')); if (list.length) { window.__held = list; list.forEach((a) => a.pause()); list.forEach((a) => (a.currentTime = a.effect.getTiming().duration * 0.45)); resolve(list.length); } else if (performance.now() - t0 > 1500) resolve(0); else requestAnimationFrame(tick); }; tick(); })`);
  assert.equal(held, 1, 'the fade is there to be held');
  await sleep(150);
  const mid = await shot();
  await b.eval(`window.__held.forEach((a) => a.finish())`);
  await b.waitFor(`!document.documentElement.hasAttribute('data-color-fade')`, { timeout: 1500 });
  await b.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
  await sleep(150);
  const end = await shot();
  await b.goto('about:blank', 100);
  const r = await b.eval(`(async () => {
    const px = async (data) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
    const [O, M, N] = await Promise.all([px(${JSON.stringify(start)}), px(${JSON.stringify(mid)}), px(${JSON.stringify(end)})]);
    let n = 0, lo = 0, hi = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < O.length; i += 4) {
      const dr = N[i] - O[i], dg = N[i + 1] - O[i + 1], db = N[i + 2] - O[i + 2];
      const den = dr * dr + dg * dg + db * db;
      if (den < 900) continue;
      const a = ((M[i] - O[i]) * dr + (M[i + 1] - O[i + 1]) * dg + (M[i + 2] - O[i + 2]) * db) / den;
      n++; sum += a; sum2 += a * a;
      if (a < 0.1) lo++; else if (a > 0.9) hi++;
    }
    const mean = sum / n;
    return { n, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), old: lo / n, fresh: hi / n };
  })()`);
  assert.ok(r.n > 100000, `the two looks differ over ${r.n} pixels`);
  assert.ok(r.mean > 0.3 && r.mean < 0.9, `the mix is part way (${r.mean.toFixed(2)} of the way to the new look)`);
  assert.ok(r.sd < 0.1, `and the same part way everywhere (spread ${r.sd.toFixed(3)})`);
  assert.ok(r.old < 0.05 && r.fresh < 0.05, `no region is still all old (${(r.old * 100).toFixed(1)}%) or already all new (${(r.fresh * 100).toFixed(1)}%)`);
});

test('a live page in the side panel keeps running through the change: same frame element, ticks without a gap, never started over', { skip }, async () => {
  await open('#/s/s_art');
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('iframe.artifact-frame')`, { timeout: 8000 });
  await sleep(800);
  await b.eval(`(() => { window.__ticks = []; window.addEventListener('message', (e) => { if (e.data && typeof e.data.tick === 'number') window.__ticks.push({ n: e.data.tick, at: performance.now() }); }); document.querySelectorAll('iframe.artifact-frame').forEach((f, i) => (f.dataset.kept = 'k' + i)); })()`);
  await sleep(400);
  const from = await b.eval(`window.__ticks.length`);
  assert.ok(from >= 4, 'the page is ticking before the change');
  await choose('DeepSeek');
  await b.waitFor(`document.documentElement.dataset.look === 'deepseek' && !document.documentElement.hasAttribute('data-color-fade')`, { timeout: 2000 });
  await sleep(400);
  const ticks = await b.eval(`window.__ticks`);
  const ns = ticks.map((t) => t.n);
  for (let i = 1; i < ns.length; i++) assert.ok(ns[i] === ns[i - 1] + 1 || ns[i] === ns[i - 1], `the count went on ${ns[i - 1]} → ${ns[i]}`);
  const gap = Math.max(...ticks.slice(1).map((t, i) => t.at - ticks[i].at));
  assert.ok(gap < 250, `the longest wait between two ticks was ${gap.toFixed(0)} ms (a tick is every 50)`);
  assert.ok(ticks.length >= from + 10, 'and it went on ticking after');
  assert.equal(await b.eval(`[...document.querySelectorAll('iframe.artifact-frame')].map((f) => f.dataset.kept).join()`), 'k0,k1', 'the frames are the same elements, not new ones');
});

test('a reply being written, the scroll position, the cursor in the message box and a fixed element stay as they were', { skip }, async () => {
  await open('#/s/s_chat');
  const live = proxy.live('s_chat');
  const text = synthMarkdown(10000, 9);
  live.status('running');
  live.event({ id: 'fade_reply', type: 'text', agentId: 'main', text: '' });
  await sleep(200);
  // a fixed element, a place in the message box, a place in the transcript
  await b.eval(`(() => {
    const f = document.createElement('div');
    f.id = 'pin'; f.style.cssText = 'position:fixed;right:11px;bottom:13px;width:40px;height:40px;background:#c0392b;z-index:90';
    document.body.append(f);
    const ta = document.querySelector('.composer-input');
    ta.focus(); ta.value = 'hello world again'; ta.dispatchEvent(new Event('input')); ta.setSelectionRange(3, 9);
  })()`);
  // stream, and change the colours half way, from the page's own call
  const pieces = [];
  for (let i = 0; i < text.length; i += 100) pieces.push(text.slice(i, i + 100));
  const before = await b.eval(`({ top: document.querySelector('.transcript').scrollTop, pin: JSON.stringify(document.getElementById('pin').getBoundingClientRect()) })`);
  const feeding = (async () => {
    for (const p of pieces) {
      live.delta('fade_reply', 'text', p);
      await sleep(25);
    }
  })();
  await sleep(500);
  const sampler = b.eval(`new Promise((resolve) => {
    const out = [];
    const t0 = performance.now();
    const ta = document.querySelector('.composer-input');
    const tick = (t) => {
      out.push({ md: document.querySelector('[data-id="fade_reply"] .md')?.textContent.length || 0, sel: [ta.selectionStart, ta.selectionEnd], focused: document.activeElement === ta, pin: JSON.stringify(document.getElementById('pin').getBoundingClientRect()), fading: document.documentElement.hasAttribute('data-color-fade') });
      if (t - t0 < 900) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
    import('/js/color-fade.js').then(({ fadeColors }) => fadeColors(() => { document.documentElement.dataset.look = 'claude'; }));
  })`);
  const frames = await sampler;
  await feeding;
  await sleep(500);
  const fadingFrames = frames.filter((f) => f.fading);
  assert.ok(fadingFrames.length >= 5, `fading for ${fadingFrames.length} frames while the reply came in`);
  const md = frames.map((f) => f.md);
  for (let i = 1; i < md.length; i++) assert.ok(md[i] >= md[i - 1], 'the reply only ever grew');
  assert.ok(md.at(-1) > md[0], 'and kept growing during the fade');
  assert.equal(await b.eval(`document.querySelector('[data-id="fade_reply"] .md').textContent.length`) > md.at(-1), true, 'and went on after it');
  for (const f of frames) {
    assert.equal(f.focused, true, 'the message box kept the focus');
    assert.deepEqual(f.sel, [3, 9], 'and the selected range');
    assert.equal(f.pin, before.pin, 'the fixed element did not move');
  }
  // typing during/after the change still goes in
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'X', key: 'X', unmodifiedText: 'X' });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'X' });
  assert.equal(await b.eval(`document.querySelector('.composer-input').value`), 'helXld again', 'typing replaces the selected text');
  live.status('idle');
});

test('the scroll position of a conversation is not moved by the change', { skip }, async () => {
  await open('#/s/s_chat');
  await b.eval(`(() => { const t = document.querySelector('.transcript'); t.scrollTop = Math.round((t.scrollHeight - t.clientHeight) * 0.4); })()`);
  await sleep(300);
  const was = await b.eval(`document.querySelector('.transcript').scrollTop`);
  assert.ok(was > 100, `scrolled to ${was}`);
  await choose('Claude');
  await b.waitFor(`document.documentElement.dataset.look === 'claude' && !document.documentElement.hasAttribute('data-color-fade')`, { timeout: 2000 });
  assert.equal(await b.eval(`document.querySelector('.transcript').scrollTop`), was);
});

test('at a phone width: the look changes from the drawer, one fade, no sideways scroll', { skip }, async () => {
  await open('#/s/s_chat', { width: 390, height: 844 });
  const watching = b.eval(WATCH(700));
  await choose('DeepSeek');
  const frames = await watching;
  assert.ok(frames.filter((f) => f.view.length).length >= 4, 'the cross-fade ran');
  assert.equal(Math.max(...frames.map((f) => f.colourTransitions)), 0);
  const end = await state();
  assert.deepEqual({ look: end.look, marker: end.marker }, { look: 'deepseek', marker: false });
  assert.ok(await b.eval(`document.documentElement.scrollWidth <= innerWidth`), 'no sideways scroll');
  await b.size(1280, 900);
});
