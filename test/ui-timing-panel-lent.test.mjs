// The key line of the 耗時 tab when the conversation's latest request was LENT to another key
// (2026-10-30): 「暫時借用 …xxxx（…yyyy 限流冷卻中）」. The conversation stays on its own key; only
// the request went elsewhere because that key is cooling down after rate limits (or just answered a
// 429). The page says it only when the Hub's answer says it (`currentKey.borrowedFrom`), and uses the
// Hub's words and numbers, nothing of its own. The Hub's side of that field is the timing
// package's (server/timing.js); this is the page's side, with the Hub's answer written by the page.
//
// A real Hub and the real front end; only the timing call is answered by the page itself. Skips,
// saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
let ui;
let b;

const SCRIPT = `(() => {
  window.__timing = window.__timing || {};
  const real = window.fetch;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    if ((init.method || 'GET').toUpperCase() === 'GET' && /^\\/api\\/sessions\\/[\\w-]+\\/timing$/.test(u)) {
      const t = window.__timing[u.split('/')[3]];
      if (t !== undefined) return reply(200, t);
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

let stateScript = null;
async function setPage(timing) {
  if (stateScript) await b.removeBeforeLoad(stateScript);
  const src = `window.__timing = ${JSON.stringify(timing)};`;
  stateScript = await b.beforeLoad(src);
  await b.eval(src);
}

const T = 1_790_000_000_000;
const FULL = (patch = {}) => ({ since: T, turns: 7, wallMs: 123_000, modelMs: 41_000, toolMs: 17_000, compactMs: 3000, rateLimitWaitMs: 5000, requests: 19, http429: 2, requestsSince: T + 600_000, subagents: { spawned: 4, requeuedForRateLimit: 1 }, unmeasured: [], ...patch });
const ON_KEY = (patch = {}) => ({ id: 'dk_b2', gateway: 'opencode-go', gatewayLabel: 'OpenCode Go', hint: 'b2c3', removed: false, lastUsedAt: T + 650_000, machineId: 'm_fake', distribution: 'sticky', ...patch });

const PANEL_BTN = `[...document.querySelectorAll('.toolbar button')].find((x) => (x.title || '').startsWith('面板'))`;
async function openTiming(id = 's_ds') {
  await ui.openApp(`#/s/${id}`, {});
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.eval(`(${PANEL_BTN}).click()`);
  await b.waitFor(`document.querySelector('.panel:not([hidden]) .panel-head')`);
  await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].find((x) => x.firstChild.textContent.trim() === '耗時').click()`);
  await b.waitFor(`document.querySelector('.panel .timing-pane .timing-key')`);
}
const line = () => b.eval(`document.querySelector('.panel .timing-key').innerText.replace(/\\s+/g, ' ').trim()`);

test('a request lent because its own key is cooling down: the line says which key it borrowed and which one cools', { skip }, async () => {
  await setPage({ s_ds: FULL({ currentKey: ON_KEY({ borrowedFrom: { id: 'dk_a1', hint: 'a1b2', gatewayLabel: 'OpenCode Go', cooling: true } }) }) });
  await openTiming();
  const text = await line();
  assert.match(text, /^用的 key OpenCode Go …b2c3/, text);
  assert.match(text, /暫時借用 …b2c3（…a1b2 限流冷卻中）/, text);
  assert.equal(await b.eval(`document.querySelectorAll('.panel .timing-key [data-part="key-lent"]').length`), 1);
});

test('lent because the key just answered a 429 (it is not cooling): said as that', { skip }, async () => {
  await setPage({ s_ds: FULL({ currentKey: ON_KEY({ borrowedFrom: { id: 'dk_a1', hint: 'a1b2', gatewayLabel: 'OpenCode Go', cooling: false } }) }) });
  await openTiming();
  assert.match(await line(), /暫時借用 …b2c3（…a1b2 剛收到限流 429）/);
});

test('the key it was lent from is gone from the list: no tail is made up for it', { skip }, async () => {
  await setPage({ s_ds: FULL({ currentKey: ON_KEY({ borrowedFrom: { id: 'dk_gone', hint: null, gatewayLabel: null, cooling: true } }) }) });
  await openTiming();
  const text = await line();
  assert.match(text, /暫時借用 …b2c3（原本的 key 限流冷卻中）/, text);
});

test('a request that was not lent says nothing about borrowing', { skip }, async () => {
  await setPage({ s_ds: FULL({ currentKey: ON_KEY() }) });
  await openTiming();
  assert.equal(await b.eval(`document.querySelectorAll('.panel .timing-key [data-part="key-lent"]').length`), 0);
  assert.doesNotMatch(await line(), /借用/);
});
