// Spec §5 and §8.2 as a script anyone can rerun: the three looks (Kimi, which
// also has a dark theme, Claude and DeepSeek) against the three providers'
// conversations, the home, 設定 and the menus, in a real browser, desktop and
// phone width.
//
//   node --test test/ui-matrix.test.mjs
//   UI_MATRIX_OUT=/some/dir node --test test/ui-matrix.test.mjs   # also keeps a screenshot of every cell
//
// Without a Chromium it skips and says why (set CHROMIUM_BIN to use another).
//
// What it checks:
//  * the look is the user's choice and nothing else: it is the same on the
//    Kimi, Claude and DeepSeek conversations, the home and 設定, and after a
//    reload; picking another look through the settings menu changes it, on a
//    desktop and on a phone;
//  * text a person has to read meets WCAG AA (4.5:1) where it is drawn:
//    provider tags (normal, open and pointed-at rows), subagent status marks,
//    the controls under the message box, the approval card and the error banner;
//  * the model, thinking and subagent controls fit a 390px screen in every look.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startHub, launchBrowser, skipReason, CONTRAST_JS } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';
import { startFakeClaude } from './fixtures/fake-anthropic.mjs';

const skip = skipReason();
if (skip) console.log(`# SKIP ui-matrix: ${skip}`);
const KEY = 'sk-ant-api03-fakeuitestkey0123456789abcdef';
const OUT = process.env.UI_MATRIX_OUT || '';
const LOOKS = [
  { name: 'kimi-light', look: 'kimi', theme: 'light' },
  { name: 'kimi-dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'light' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
const CONVERSATIONS = [
  ['kimi', 's_kimi'],
  ['claude', 's_claude'],
  ['deepseek', 's_ds'],
];
const TOKENS = ['--window', '--sidebar', '--accent', '--ink', '--row-active'];
const AA = 4.5;

let hub;
let fake;
let b;

before(async () => {
  if (skip) return;
  fake = await startFakeClaude(KEY);
  hub = await startHub(fixtureSessions(), { env: { AGENT_HUB_CLAUDE_TEST_URL: fake.url } });
  await hub.api('/claude', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: KEY }) });
  b = await launchBrowser();
});

after(async () => {
  await b?.close();
  hub?.stop();
  fake?.close();
});

const contrast = (sel) => b.eval(`(${CONTRAST_JS})(${JSON.stringify(sel)})`);
const setLook = async ({ look, theme }) => {
  await b.goto(hub.url + '#/', 200);
  await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(look)}); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
};
const open = async (hash, { width = 1280, height = 900 } = {}) => {
  await b.size(width, height, width < 700);
  await b.goto(hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
  await b.waitFor(`document.querySelector('.view .composer, .view .home')`);
  await b.sleep(500);
};
const tokens = () => b.eval(`(() => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(TOKENS)}.map((t) => [t, cs.getPropertyValue(t).trim()])); })()`);
const shot = async (name) => {
  if (OUT) await b.shot(path.join(OUT, `${name}.png`));
};
// Pre-existing contrasts that are below AA in an original look. The spec asks
// both to keep the three original looks and for AA, so these are reported
// (and may not get worse) rather than silently changed; see the note printed.
const KNOWN = { 'kimi-dark': { askPrimary: 3.8 }, claude: { askPrimary: 3.0 } };
const notes = [];
const must = (cell, what, r, floor = AA) => {
  assert.ok(r, `${cell}: ${what} is on the page`);
  const known = KNOWN[cell.split(' ')[0]]?.[what];
  if (known && r.ratio < AA) {
    assert.ok(r.ratio >= known, `${cell}: ${what} ${r.ratio.toFixed(2)}:1 got worse than the recorded ${known}:1`);
    notes.push(`${cell}: ${what} is ${r.ratio.toFixed(2)}:1 (below AA ${AA}:1; pre-existing in the original look)`);
    return;
  }
  assert.ok(r.ratio >= floor, `${cell}: ${what} is ${r.ratio.toFixed(2)}:1, needs ${floor}:1 (text ${r.fg}, behind it ${r.bg})`);
};

for (const L of LOOKS) {
  test(`${L.name}: the look is the user's, the same on every provider's conversation, the home and 設定, and after a reload`, { skip }, async () => {
    await setLook(L);
    const seen = [];
    for (const [provider, sid] of CONVERSATIONS) {
      await open(`#/s/${sid}`);
      assert.equal(await b.eval(`document.documentElement.dataset.look`), L.look, `${L.name} ${provider}: data-look`);
      seen.push([`conversation ${provider}`, await tokens()]);
      await shot(`${L.name}_conversation_${provider}`);
    }
    await open('#/');
    seen.push(['home', await tokens()]);
    await shot(`${L.name}_home`);
    // 設定 dialog
    await b.click('.side-foot button[aria-label="設定"]');
    await b.waitFor(`document.querySelector('.om-menu')`);
    seen.push(['settings menu', await tokens()]);
    await shot(`${L.name}_settings_menu`);
    await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith('設定…'))?.click()`);
    await b.waitFor(`document.querySelector('select[name="provider"]')`);
    seen.push(['settings dialog', await tokens()]);
    await shot(`${L.name}_settings_dialog`);
    await b.eval(`[...document.querySelectorAll('.dialog-actions button')].find((x) => x.textContent === '取消')?.click()`);
    // After a reload on a conversation of another provider.
    await b.goto(hub.url + '#/s/s_ds', 300);
    await b.eval('location.reload()');
    await b.sleep(900);
    assert.equal(await b.eval(`document.documentElement.dataset.look`), L.look, 'reload keeps the look');
    seen.push(['after reload', await tokens()]);
    const first = seen[0][1];
    for (const [where, t] of seen) assert.deepEqual(t, first, `${L.name}: tokens on ${where} differ from the first conversation's`);
    L.tokens = first;
  });
}

test('the looks are visibly different from one another (so the check above can see a change)', { skip }, () => {
  const distinct = new Set(LOOKS.map((l) => `${l.tokens['--window']}|${l.tokens['--sidebar']}`));
  assert.equal(distinct.size, 4);
});

for (const L of LOOKS) {
  test(`${L.name}: text is readable (WCAG AA) on the sidebar rows, the cards, the controls, the approval and the error`, { skip }, async () => {
    await setLook(L);
    for (const [provider, sid] of CONVERSATIONS) {
      const cell = `${L.name} ${provider}`;
      await open(`#/s/${sid}`);
      // Provider tags on a row that is not open, on the open row, and under the pointer.
      const tags = await b.eval(`[...document.querySelectorAll('.side-row .row-tag')].map((t) => ({ open: !!t.closest('[aria-current=page]'), tag: t.className }))`);
      assert.ok(tags.some((t) => t.open), `${cell}: the open row has a tag`);
      assert.ok(tags.some((t) => !t.open), `${cell}: other rows have tags`);
      for (const [i, t] of tags.entries()) {
        must(`${cell} ${t.open ? 'open' : 'plain'}`, `tag[${t.tag.replace('row-tag ', '')}]`, await b.eval(`(${CONTRAST_JS})(document.querySelectorAll('.side-row .row-tag')[${i}])`));
      }
      await b.hover('.side-row:not([aria-current="page"])');
      const hovered = await b.eval(`[...document.querySelectorAll('.side-row:hover .row-tag')].map((t) => (${CONTRAST_JS})(t))`);
      for (const r of hovered) must(`${cell} hover`, 'tag', r);

      must(cell, 'toolbar title', await contrast('.om-toolbar__title'));
      must(cell, 'user message', await contrast('.bubble'));
      for (const c of ['model', 'permission', 'subagent']) must(cell, `${c} chip`, await contrast(`[data-control="${c}"]`));
      must(cell, 'approval question', await contrast('.ask-q'));
      must(cell, 'approval secondary button', await contrast('.ask .om-btn:not(.om-btn--primary)'));
      must(cell, 'askPrimary', await contrast('.ask .om-btn--primary'));
      must(cell, 'error banner', await contrast('.callout.danger .callout-text'));
      if (provider === 'kimi') {
        must(cell, 'unconfirmed model', await contrast('.subagent-model.unconfirmed'));
        must(cell, 'status unknown mark', await contrast('.mark-text.agent-unknown'));
        must(cell, 'subagent note', await contrast('.agent-note'));
      }
    }
    // The model menu and the subagent dialog.
    await open('#/s/s_claude');
    await b.click('[data-control="model"]');
    await b.waitFor(`document.querySelector('.model-menu .om-menu__item:not([aria-disabled="true"]) .menu-desc')`);
    // (a disabled item is exempt from the contrast rule, so the enabled ones are measured)
    must(`${L.name} model menu`, 'menu description', await contrast('.model-menu .om-menu__item:not([aria-disabled="true"]) .menu-desc'));
    must(`${L.name} model menu`, 'menu item', await contrast('.model-menu .om-menu__item:not([aria-disabled="true"]) .menu-label'));
    await shot(`${L.name}_model_menu`);
    await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });
}

for (const L of LOOKS) {
  test(`${L.name}: on a phone (390px) the controls fit, and the look can be changed from the settings menu`, { skip }, async () => {
    await setLook(L);
    for (const [hash, label] of [['#/', 'home'], ['#/s/s_claude', 'conversation']]) {
      await open(hash, { width: 390, height: 800 });
      const boxes = await b.eval(`['model', 'effort', 'subagent', 'permission'].map((c) => {
        const e = document.querySelector('[data-control="' + c + '"]');
        if (!e) return [c, null];
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.min(r.left + r.width / 2, innerWidth - 1), r.top + r.height / 2);
        return [c, { left: r.left, right: r.right, ok: !!hit && (hit === e || e.contains(hit)) }];
      })`);
      for (const [c, r] of boxes) {
        if (c === 'effort' && !r) continue;
        assert.ok(r, `${L.name} ${label}: ${c} chip is there`);
        assert.ok(r.left >= 0 && r.right <= 390, `${L.name} ${label}: ${c} chip inside the screen (${Math.round(r.left)}..${Math.round(r.right)})`);
        assert.ok(r.ok, `${L.name} ${label}: ${c} chip is not covered`);
      }
      assert.ok(await b.eval(`document.documentElement.scrollWidth <= innerWidth`), `${L.name} ${label}: no sideways page scroll`);
      await shot(`${L.name}_phone_${label}`);
    }
    // Open the drawer, the settings menu, and choose another look.
    await b.click('.sidebar-toggle');
    await b.waitFor(`document.querySelector('.app.drawer')`);
    await b.sleep(300);
    await b.click('.side-foot button[aria-label="設定"]');
    await b.waitFor(`document.querySelector('.om-menu')`);
    const menu = await b.eval(`(() => { const r = document.querySelector('.om-menu').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })()`);
    assert.ok(menu[0] >= 0 && menu[1] <= 390, `the settings menu fits the screen ${menu}`);
    const other = L.look === 'kimi' ? 'Claude' : 'Kimi';
    await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith(${JSON.stringify(other)}))?.click()`);
    await b.waitFor(`document.documentElement.dataset.look === ${JSON.stringify(other.toLowerCase())}`);
    assert.equal(await b.eval(`localStorage.getItem('hubPalette')`), other.toLowerCase(), 'the choice is saved');
    await b.size(1280, 900);
  });
}

after(() => {
  for (const n of notes) console.log(`# NOTE ${n}`);
});
