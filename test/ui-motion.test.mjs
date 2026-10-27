// Motion: one set of durations and curves for the whole page (tokens), only
// transform and opacity (and colours) moving, reduced motion respected, and
// the big moves (panel in, sidebar away, theme change) really done without
// laying the page out on every frame.
//
// The style rules are checked as text; the rest in a real browser. Skips the
// browser part, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { skipReason, uiSession, ROOT } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const css = ['app.css', 'oatmeal.css'].map((f) => [f, fs.readFileSync(`${ROOT}/public/css/${f}`, 'utf8')]);

// Every declaration `prop: value;` in a stylesheet, with the selector it sits in.
function declarations(text, wanted) {
  const out = [];
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`(?:^|[;{\\s])(${wanted})\\s*:\\s*([^;{}]+)`, 'g');
  for (const m of stripped.matchAll(re)) out.push({ prop: m[1], value: m[2].trim(), at: stripped.slice(Math.max(0, m.index - 80), m.index).split('{').at(-2)?.trim().split('\n').at(-1) });
  return out;
}

test('transitions move only colours, opacity and transform — never size or position', () => {
  const ok = /^(transform|opacity|color|background-color|border-color|box-shadow|fill|stroke|outline-color|text-decoration-color)$/;
  const bad = [];
  for (const [file, text] of css) {
    for (const d of declarations(text, 'transition(?:-property)?')) {
      const props = d.prop === 'transition-property' ? d.value.split(',').map((x) => x.trim()) : d.value.split(/,(?![^(]*\))/).map((part) => part.trim().split(/\s+/)[0]);
      for (const p of props) if (!ok.test(p) && p !== 'none') bad.push(`${file}: ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('keyframes move only opacity and transform', () => {
  const bad = [];
  for (const [file, text] of css) {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of stripped.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)) {
      for (const d of m[2].matchAll(/([\w-]+)\s*:/g)) if (!/^(opacity|transform)$/.test(d[1])) bad.push(`${file}: @keyframes ${m[1]} sets ${d[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every duration and curve comes from the motion tokens (the endless spinners aside)', () => {
  const bad = [];
  for (const [file, text] of css) {
    for (const d of declarations(text, 'transition|animation')) {
      if (/\binfinite\b/.test(d.value) || d.value === 'none') continue;
      // the timing and the curve are variables, not numbers
      if (/(^|\s)[\d.]+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, '').replace(/\s\d+ms\s*(forwards|both)?$/, ''))) bad.push(`${file}: ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(bad, []);
  const app = css[0][1];
  for (const t of ['--dur-fast', '--dur-base', '--dur-slow', '--ease-out', '--ease-in', '--ease-move']) assert.match(app, new RegExp(`${t}:`), `${t} is defined`);
});

test('reduced motion makes every duration token (almost) nothing', () => {
  const app = css[0][1];
  const block = app.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/);
  assert.ok(block, 'a reduced-motion block redefines the tokens');
  for (const t of ['--dur-fast', '--dur-base', '--dur-slow']) assert.match(block[1], new RegExp(`${t}:\\s*1ms`));
});

const skip = skipReason();
let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
});
after(() => ui?.stop());

const durations = (sel) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const s = getComputedStyle(e); return { animation: s.animationDuration, name: s.animationName }; })()`);
const token = (name) => b.eval(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
const secs = (ms) => `${parseFloat(ms) / 1000}s`;

test('menus, dialogs, toasts and the panel enter with the durations of the tokens', { skip }, async () => {
  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('[data-control="model"]')`);
  await b.click('[data-control="model"]');
  await b.waitFor(`document.querySelector('.model-menu .om-menu__item')`);
  const menu = await durations('.om-menu.popover');
  assert.equal(menu.animation, secs(await token('--dur-fast')), 'a menu uses --dur-fast');
  assert.equal(menu.name, 'pop-in');
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('.panel:not([hidden])')`);
  const panel = await durations('.panel');
  assert.equal(panel.animation, secs(await token('--dur-base')), 'the panel uses --dur-base');
  assert.equal(panel.name, 'slide-in-right');
});

test('with prefers-reduced-motion nothing takes time: tokens, menus and the panel', { skip }, async () => {
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await ui.openApp('#/s/s_claude');
    assert.equal(await token('--dur-base'), '1ms');
    await b.waitFor(`document.querySelector('[data-control="model"]')`);
    await b.click('[data-control="model"]');
    await b.waitFor(`document.querySelector('.model-menu .om-menu__item')`);
    assert.equal((await durations('.om-menu.popover')).animation, '0.001s', 'a menu appears at once');
    // the sidebar does not slide: no animation is started
    await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await b.eval(`document.querySelector('button[title="收合側欄"]').click()`);
    await sleep(60);
    assert.equal(await b.eval(`document.getAnimations().filter((a) => a.effect?.getKeyframes?.().some((k) => k.transform && k.transform !== 'none')).length`), 0, 'no transform animation runs');
    assert.equal(await b.eval(`document.querySelector('.app').classList.contains('no-sidebar')`), true, 'and the sidebar is simply gone');
    await b.eval(`document.querySelector('button[title="顯示側欄"]').click()`);
  } finally {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
});

test('the sidebar slides away and back with transforms only, laying the page out a handful of times, not once a frame', { skip }, async () => {
  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('button[title="收合側欄"]')`);
  await sleep(300);
  const layouts = async () => (await b.send('Performance.getMetrics')).result.metrics.find((m) => m.name === 'LayoutCount').value;
  await b.send('Performance.enable');
  for (const [label, sel, closed] of [['closing', 'button[title="收合側欄"]', true], ['opening', 'button[title="顯示側欄"]', false]]) {
    const before = await layouts();
    await b.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await sleep(40);
    const anims = await b.eval(`document.getAnimations().filter((a) => a.effect?.getKeyframes?.().some((k) => k.transform)).length`);
    assert.ok(anims >= 2, `${label}: the sidebar and the conversation are both animating (${anims})`);
    assert.equal(await b.eval(`document.querySelector('.app').classList.contains('sliding')`), true);
    await sleep(Number.parseFloat(await token('--dur-slow')) + 150);
    const used = (await layouts()) - before;
    assert.ok(used <= 8, `${label}: the page was laid out ${used} times in all (not once a frame; limit 8)`);
    assert.equal(await b.eval(`document.querySelector('.app').classList.contains('sliding')`), false, `${label}: finished`);
    assert.equal(await b.eval(`document.querySelector('.app').classList.contains('no-sidebar')`), closed);
  }
});

test('a change of theme cross-fades the picture instead of jumping, and the change itself is made at once', { skip }, async () => {
  await ui.openApp('#/s/s_claude');
  await b.eval(`localStorage.setItem('hubTheme', 'light')`);
  await ui.openApp('#/s/s_claude');
  const bg = () => b.eval(`getComputedStyle(document.querySelector('.app')).backgroundColor`);
  const light = await bg();
  // how much of the new picture is in, frame by frame, from the click on
  const watching = b.eval(`new Promise((resolve) => {
    const out = [];
    const t0 = performance.now();
    const tick = (t) => {
      out.push({ fading: document.documentElement.hasAttribute('data-color-fade'), dark: document.documentElement.dataset.theme === 'dark', fresh: Number(getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity) });
      if (t - t0 < 600) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  })`);
  await b.click('button[title="設定"]');
  await b.waitFor(`[...document.querySelectorAll('.om-menu__item')].some((i) => i.textContent.includes('深色'))`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.textContent.includes('深色')).click()`);
  const frames = await watching;
  const first = frames.find((f) => f.dark);
  assert.ok(first, 'the theme is dark within a few frames of the click');
  assert.equal(first.fading, true, 'the page says it is fading as the new colours arrive');
  const fresh = frames.filter((f) => Number.isFinite(f.fresh)).map((f) => f.fresh);
  assert.ok(fresh.some((v) => v > 0.05 && v < 0.95), `the new picture came in part by part (${fresh.map((v) => v.toFixed(2)).join(' ')}), not all at once`);
  assert.notEqual(await bg(), light, 'the page itself is dark');
  await sleep(Number.parseFloat(await token('--dur-base')) + 200);
  assert.equal(await b.eval(`document.documentElement.hasAttribute('data-color-fade')`), false, 'the fade is over');
  assert.equal(await b.eval(`document.getAnimations().length`), 0, 'and nothing is left running');
  await b.eval(`localStorage.setItem('hubTheme', 'light')`);
});
