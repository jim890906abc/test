// The controls under the message box in a real browser: the model menu shows
// each model's thinking levels (and what a switch would do to the current
// one), and on a phone the model, thinking and subagent controls are on
// screen instead of scrolled out of sight.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession(fixtureSessions());
  b = ui.b;
});
after(() => ui?.stop());

test('the model menu shows each model\'s thinking levels, and what a switch would do to the current one', { skip }, async () => {
  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('[data-control="model"]')`);
  await b.click('[data-control="model"]');
  await b.waitFor(`document.querySelector('.model-menu .om-menu__item')`);
  const items = await b.eval(`[...document.querySelectorAll('.model-menu .om-menu__item')].map((i) => i.innerText.replace(/\\s+/g, ' '))`);
  const opus = items.find((t) => t.startsWith('Claude Opus 5.5'));
  assert.match(opus, /思考：low \/ medium（預設） \/ high \/ xhigh \/ max/, `efforts and the default listed for Opus 5.5: ${opus}`);
  const sonnet = items.find((t) => t.startsWith('Claude Sonnet 5.5'));
  assert.match(sonnet, /思考：off \/ low \/ medium \/ high（預設） \/ xhigh \/ max/, 'a model with another set of levels lists its own');
  assert.ok(items.filter((t) => /思考：/.test(t)).length >= 3, 'every model with levels lists them');
  // The internal alias is not shown as if it were something to read.
  assert.ok(!items.some((t) => /agent-hub-deepseek\//.test(t)), 'no internal alias in the menu');
  // The DeepSeek group is there, unavailable, with its reason.
  assert.ok(await b.eval(`[...document.querySelectorAll('.model-menu .menu-section')].some((s) => /DeepSeek（不可用/.test(s.innerText))`));
});

test('picking a model that does not have the current thinking level says, in the menu, what it will become', { skip }, async () => {
  // Pages can pre-set the state a Composer is shown with, so this needs no live
  // conversation: the model chip's menu is built from that state.
  await ui.openApp('#/');
  const items = await b.eval(`(async () => {
    const { Composer } = await import('/js/composer.js');
    const picked = [];
    const c = new Composer({ onOpenSubagent() {}, onCommand() {}, onConfig: (x) => picked.push(x) });
    document.body.append(c.el);
    const m = (id, efforts, def) => ({ id, name: id, provider: 'claude', efforts, defaultEffort: def, available: true });
    c.update({ agent: 'claude', provider: 'claude', models: [m('alpha', ['low', 'high', 'max'], 'high'), m('beta', ['low', 'medium'], 'medium')], providers: [], model: 'alpha', effort: 'max' });
    c.modelMenu(c.el.querySelector('[data-control="model"]'));
    const text = [...document.querySelectorAll('.om-menu__item')].map((i) => i.innerText.replace(/\\s+/g, ' '));
    [...document.querySelectorAll('.om-menu__item')].find((i) => /^\\W*beta/.test(i.innerText)).click();
    return { text, picked };
  })()`);
  const beta = items.text.find((t) => /^\W*beta/.test(t));
  assert.match(beta, /切換後思考強度改為 medium/);
  const alpha = items.text.find((t) => /^\W*alpha/.test(t));
  assert.ok(alpha, 'the current model is listed (with its tick)');
  assert.doesNotMatch(alpha, /切換後/, 'the current model changes nothing');
  assert.deepEqual(items.picked, [{ provider: 'claude', model: 'beta', effort: 'medium' }], 'and that is what is really sent');
});

for (const [name, hash] of [['home', '#/'], ['a conversation', '#/s/s_claude']]) {
  test(`phone width (390px): the model, thinking and subagent controls on ${name} are all on screen and clickable`, { skip }, async () => {
    await ui.openApp(hash, { viewport: [390, 800] });
    await b.waitFor(`document.querySelector('[data-control="subagent"]')`);
    const chips = await b.eval(`['model', 'effort', 'subagent'].map((c) => {
      const e = document.querySelector('[data-control="' + c + '"]');
      if (!e) return [c, null];
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.min(r.left + r.width / 2, window.innerWidth - 1), r.top + r.height / 2);
      return [c, { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), clickable: !!hit && (hit === e || e.contains(hit)) }];
    })`);
    assert.ok(await b.eval(`document.documentElement.scrollWidth <= window.innerWidth`), 'the page itself does not scroll sideways');
    for (const [c, r] of chips) {
      if (c === 'effort' && !r) continue; // shown only for a model with levels
      assert.ok(r, `${c} chip exists`);
      assert.ok(r.left >= 0 && r.right <= 390, `${c} chip is inside the 390px screen (left ${r.left}, right ${r.right})`);
      assert.ok(r.width > 24 && r.height > 16, `${c} chip has a size`);
      assert.ok(r.clickable, `${c} chip is not covered by anything`);
    }
    // And they work: the subagent chip opens its dialog, which fits too.
    await b.click('[data-control="subagent"]');
    await b.waitFor(`document.querySelector('select[name="subagent-mode"]')`);
    const dialogBox = await b.eval(`(() => { const r = document.querySelector('.subagent-settings').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })()`);
    assert.ok(dialogBox[0] >= 0 && dialogBox[1] <= 390, `the dialog fits the screen ${dialogBox}`);
    await b.eval(`document.querySelector('.dialog-actions button[type="button"]')?.click()`);
    await b.size(1280, 900);
  });
}

test('none of this leaves errors in the page', { skip }, async () => {
  const errors = b.logs.filter((l) => /^EXC|^error:/.test(l) && !/Failed to load resource/.test(l));
  assert.deepEqual(errors, []);
});
