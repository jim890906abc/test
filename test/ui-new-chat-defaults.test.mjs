// The new-conversation settings in a real browser: the home screen's subagent
// choice (nothing chosen / native rules / a model are three different
// requests), the one writer and one reader of the defaults (設定, Claude API…,
// DeepSeek…, and the home screen), a save of two requests that is put back when
// the second is refused, and the subagent chip's "this turn / next turn".
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

const sessionPosts = async () => (await ui.calls()).filter((c) => c.method === 'POST' && c.url === '/api/sessions');
const subagentChip = () => ui.textOf('[data-control="subagent"]');
const setField = (sel, value) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const openMenuItem = async (anchorSel, label) => {
  await b.click(anchorSel);
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith(${JSON.stringify(label)}))?.click()`);
};
const SETTINGS_BTN = '.side-foot button[aria-label="設定"]';
const claudeDefaults = async () => (await ui.hub.api('/config')).settings.defaults.byProvider?.claude;

// What the page sends when a conversation is started from the home screen. The
// page answers the create itself, so no conversation is really started.
const sendFromHome = async (text) => {
  await ui.clearCalls();
  await ui.answer('POST', '/api/sessions', 400, { error: 'captured by the test' });
  await b.eval(`(() => { const t = document.querySelector('.composer-input'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await b.waitFor(`window.__calls.some((c) => c.url === '/api/sessions')`);
  const [post] = await sessionPosts();
  await ui.stopAnswering();
  return post.body;
};
const chooseSubagent = async (mode, { provider } = {}) => {
  await b.click('[data-control="subagent"]');
  await b.waitFor(`document.querySelector('select[name="subagent-mode"]')`);
  await b.eval(`(() => {
    const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('select[name="subagent-mode"]', ${JSON.stringify(mode)});
    ${provider ? `set('select[name="subagent-provider"]', ${JSON.stringify(provider)});` : ''}
  })()`);
  await b.eval(`document.querySelector('.subagent-settings button[type="submit"]').click()`);
  await b.waitFor(`!document.querySelector('select[name="subagent-mode"]')`);
};

test('home: "nothing chosen", "follow the native rules" and "a model" are three different requests, and the chip tells the truth', { skip }, async () => {
  await b.goto(ui.hub.url + '#/', 300);
  await b.eval(`localStorage.removeItem('hubHome')`);
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('[data-control="subagent"]')`);

  // Untouched: the chip shows what the server will really do, and nothing is sent.
  // (The model's name comes from a catalog that loads a moment after the page; until then
  // the chip has the id's own tail, so wait for the name rather than race it.)
  await b.waitFor(`/DeepSeek V4\\.1 Flash/.test(document.querySelector('[data-control="subagent"]').innerText)`, { label: 'the subagent chip takes the model\'s name from the catalog' });
  assert.match(await subagentChip(), /子代理 DeepSeek V4\.1 Flash · 思考 max（預設）/);
  let body = await sendFromHome('hello');
  assert.equal(Object.hasOwn(body, 'subagent'), false, 'nothing chosen: the key is not sent');

  // Chosen on purpose: native rules. null must be sent, not dropped.
  await chooseSubagent('follow');
  assert.match(await subagentChip(), /子代理 跟隨主模型/);
  body = await sendFromHome('hello');
  assert.equal(Object.hasOwn(body, 'subagent'), true);
  assert.equal(body.subagent, null);
  // ...and it is still the choice after a reload.
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('[data-control="subagent"]')`);
  assert.match(await subagentChip(), /子代理 跟隨主模型/);

  // A model.
  await chooseSubagent('custom', { provider: 'claude' });
  // (a Claude model's name starts with the provider, which is then said once: "Claude Opus 5.5")
  assert.match(await subagentChip(), /子代理 Claude /);
  body = await sendFromHome('hello');
  assert.equal(body.subagent.provider, 'claude');
  assert.ok(body.subagent.model);

  // Back to nothing chosen: the key goes away again.
  await chooseSubagent('default');
  assert.match(await subagentChip(), /（預設）/);
  body = await sendFromHome('hello');
  assert.equal(Object.hasOwn(body, 'subagent'), false);
  await b.eval(`localStorage.removeItem('hubHome')`);
});

test('設定, Claude API… and the home screen read and write the same new-conversation defaults', { skip }, async () => {
  await b.goto(ui.hub.url + '#/', 300);
  await b.eval(`localStorage.removeItem('hubHome')`);
  await ui.openApp('#/');
  await ui.clearCalls();

  // 設定…: one request, to the one settings API, none to the account APIs.
  await openMenuItem(SETTINGS_BTN, '設定…');
  await b.waitFor(`document.querySelector('select[name="provider"]')`);
  await setField('select[name="provider"]', 'claude');
  await setField('select[name="model"]', 'claude-sonnet-5-5');
  await b.eval(`document.querySelector('form.settings button[type="submit"]').click()`);
  await b.waitFor(`!document.querySelector('select[name="provider"]')`);
  const puts = (await ui.calls()).filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.url), ['/api/settings'], 'a single PUT, and not to /claude or /deepseek');
  assert.equal((await claudeDefaults()).model, 'claude-sonnet-5-5');

  // Claude API…: shows what 設定 saved (not an older account value), and its own save lands in the same place.
  await ui.clearCalls();
  await openMenuItem(SETTINGS_BTN, 'Claude API…');
  await b.waitFor(`document.querySelector('.claude-settings select[name="model"]')`);
  assert.equal(await b.eval(`document.querySelector('.claude-settings select[name="model"]').value`), 'claude-sonnet-5-5');
  await setField('.claude-settings select[name="model"]', 'claude-opus-5-5');
  await b.eval(`document.querySelector('.claude-settings button[type="submit"]').click()`);
  await b.waitFor(`!document.querySelector('.claude-settings')`);
  assert.equal((await claudeDefaults()).model, 'claude-opus-5-5', 'the save in the Claude dialog took effect where the home reads it');
  assert.ok((await ui.calls()).some((c) => c.method === 'PUT' && c.url === '/api/settings' && c.body.defaults.byProvider.claude.model === 'claude-opus-5-5'));

  // ...so the home screen starts from it, after a reload too.
  await ui.openApp('#/');
  await b.waitFor(`document.querySelector('[data-control="model"]')`);
  assert.match(await ui.textOf('[data-control="model"]'), /Claude Opus 5\.5/);
  // And 設定 shows it.
  await openMenuItem(SETTINGS_BTN, '設定…');
  await b.waitFor(`document.querySelector('select[name="provider"]')`);
  assert.equal(await b.eval(`document.querySelector('form.settings select[name="model"]').value`), 'claude-opus-5-5');
  await b.eval(`[...document.querySelectorAll('.dialog-actions button')].find((x) => x.textContent === '取消')?.click()`);
});

test('a save that takes two requests puts the first back when the second is refused', { skip }, async () => {
  const webBefore = (await ui.hub.api('/claude')).webTools;
  await ui.openApp('#/');
  await ui.clearCalls();
  await ui.answer('PUT', '/api/settings', 400, { error: '預設不被接受' });
  await openMenuItem(SETTINGS_BTN, 'Claude API…');
  await b.waitFor(`document.querySelector('.claude-settings select[name="model"]')`);
  await setField('.claude-settings select[name="model"]', 'claude-haiku-5-5');
  // flip "web tools" (the account's own setting, saved by the first request)
  await b.eval(`(() => { const boxes = [...document.querySelectorAll('.claude-settings input.om-switch')]; const web = boxes[boxes.length - 1]; web.checked = !web.checked; })()`);
  await b.eval(`document.querySelector('.claude-settings button[type="submit"]').click()`);
  await b.waitFor(`document.querySelector('.claude-test.bad')`);
  assert.match(await ui.textOf('.claude-test.bad'), /預設不被接受/);
  const seq = (await ui.calls()).filter((c) => c.method === 'PUT').map((c) => [c.url, c.body.webTools ?? null]);
  assert.deepEqual(seq, [['/api/claude', !webBefore], ['/api/settings', null], ['/api/claude', webBefore]], 'the account change was undone after the refusal');
  assert.equal((await ui.hub.api('/claude')).webTools, webBefore, 'and the server really is back where it was');
  assert.equal((await claudeDefaults()).model, 'claude-opus-5-5', 'defaults untouched');
  await ui.stopAnswering();
  await b.eval(`[...document.querySelectorAll('.dialog-actions button')].find((x) => x.textContent === '取消')?.click()`);
  await b.waitFor(`!document.querySelector('.claude-settings')`);
});

test('DeepSeek…: a save with nothing changed sends nothing; a gateway change is put back when the defaults are refused', { skip }, async () => {
  await ui.openApp('#/');
  const before = (await ui.hub.api('/deepseek')).gateway;
  const other = (await ui.hub.api('/deepseek')).gateways.find((g) => g.id !== before).id;
  await ui.clearCalls();
  await openMenuItem(SETTINGS_BTN, 'DeepSeek…');
  await b.waitFor(`document.querySelector('.deepseek-settings select[name="model"] option')`);
  await b.eval(`document.querySelector('.deepseek-settings button[type="submit"]').click()`);
  await b.waitFor(`!document.querySelector('.deepseek-settings')`);
  assert.deepEqual((await ui.calls()).filter((c) => c.method === 'PUT'), [], 'unchanged: no request');

  await ui.answer('PUT', '/api/settings', 400, { error: '預設不被接受' });
  await openMenuItem(SETTINGS_BTN, 'DeepSeek…');
  await b.waitFor(`document.querySelector('.deepseek-settings select[name="model"] option')`);
  await b.eval(`document.querySelector('.deepseek-settings input[name="gateway"][value="${other}"]').click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings select[name="model"] option')`);
  await setField('.deepseek-settings select[name="permission"]', 'auto');
  await ui.clearCalls();
  await b.eval(`document.querySelector('.deepseek-settings button[type="submit"]').click()`);
  await b.waitFor(`document.querySelector('.deepseek-settings .claude-test.bad')`);
  const seq = (await ui.calls()).filter((c) => c.method === 'PUT').map((c) => [c.url, c.body.gateway ?? null]);
  assert.deepEqual(seq, [['/api/deepseek', other], ['/api/settings', null], ['/api/deepseek', before]], 'gateway changed, then put back');
  assert.equal((await ui.hub.api('/deepseek')).gateway, before, 'the server is back on the first gateway');
  await ui.stopAnswering();
});

test('a conversation\'s subagent dialog starts from that conversation\'s setting and saves exactly what is chosen', { skip }, async () => {
  // s_claude: native rules (null). s_kimi: a model.
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('[data-control="subagent"]')`);
  await b.click('[data-control="subagent"]');
  await b.waitFor(`document.querySelector('select[name="subagent-mode"]')`);
  assert.equal(await b.eval(`document.querySelector('select[name="subagent-mode"]').value`), 'custom');
  assert.equal(await b.eval(`[...document.querySelector('select[name="subagent-mode"]').options].map((o) => o.value).join()`), 'follow,custom', 'no "default" mode for an existing conversation');
  await b.eval(`[...document.querySelectorAll('.dialog-actions button')].find((x) => x.textContent === '取消')?.click()`);

  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('[data-control="subagent"]')`);
  assert.match(await subagentChip(), /子代理 跟隨主模型/);
  await ui.clearCalls();
  await ui.answer('POST', '/api/sessions/s_claude/config', 200, {});
  await b.click('[data-control="subagent"]');
  await b.waitFor(`document.querySelector('select[name="subagent-mode"]')`);
  assert.equal(await b.eval(`document.querySelector('select[name="subagent-mode"]').value`), 'follow');
  await b.eval(`(() => {
    const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('select[name="subagent-mode"]', 'custom');
    set('select[name="subagent-provider"]', 'claude');
  })()`);
  await b.eval(`document.querySelector('.subagent-settings button[type="submit"]').click()`);
  await b.waitFor(`window.__calls.some((c) => c.url === '/api/sessions/s_claude/config')`);
  const [post] = (await ui.calls()).filter((c) => c.url === '/api/sessions/s_claude/config');
  assert.equal(post.body.subagent.provider, 'claude');
  assert.ok(post.body.subagent.model);
  await b.waitFor(`/^子代理 Claude /.test(document.querySelector('[data-control="subagent"]').innerText)`);
  await ui.stopAnswering();
});

test('the subagent chip says which subagent this turn started with when it is not the one the next turn will use', { skip }, async () => {
  await ui.openApp('#/');
  const chips = await b.eval(`(async () => {
    const { Composer } = await import('/js/composer.js');
    const c = new Composer({ onOpenSubagent() {}, onConfig() {}, onCommand() {} });
    document.body.append(c.el);
    const next = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
    const text = (state) => { c.update({ agent: 'kimi', provider: 'kimi', models: [], running: false, awaiting: false, ...state }); return c.el.querySelector('[data-control="subagent"]').innerText; };
    return {
      idle: text({ subagentMode: 'custom', subagent: next, turnSubagent: null }),
      runningSame: text({ running: true, subagentMode: 'custom', subagent: next, turnSubagent: next }),
      runningChanged: text({ running: true, subagentMode: 'custom', subagent: next, turnSubagent: null }),
      runningNoSnapshot: text({ running: true, subagentMode: 'custom', subagent: next, turnSubagent: undefined }),
      followNow: text({ running: true, subagentMode: 'follow', subagent: null, turnSubagent: next }),
      defaultMode: text({ subagentMode: 'default', subagent: null }),
    };
  })()`);
  assert.equal(chips.idle, '子代理 claude-opus-5-5 · 思考 high', 'idle: just the setting (no catalog here: the id\'s tail, the provider said once)');
  assert.equal(chips.runningSame, chips.idle, 'running with the same one: nothing extra');
  assert.equal(chips.runningChanged, '子代理 本回合 跟隨主模型／下一回合 claude-opus-5-5 · 思考 high');
  assert.equal(chips.runningNoSnapshot, chips.idle, 'no snapshot of the turn: nothing is guessed');
  assert.equal(chips.followNow, '子代理 本回合 claude-opus-5-5 · 思考 high／下一回合 跟隨主模型');
  assert.match(chips.defaultMode, /^子代理 deepseek-v4\.1-flash · 思考 max（預設）$/);
});
