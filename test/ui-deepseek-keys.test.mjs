// The DeepSeek keys as one list, as a person sees them (a real Hub with a
// pool file that has keys on two gateways, and the real front end): every key
// is in one list with its gateway and its state said plainly (in use / waiting /
// full until a time the gateway stated / full with the time unknown), a key can
// be added for ANY gateway into that list without changing whose model names are
// used, and no key value is anywhere on the page.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GO1 = 'sk-ui-go-one-SECRETFRAGMENT01';
const CC1 = 'sk-ui-cc-one-SECRETFRAGMENT02';
const GO2 = 'sk-ui-go-two-SECRETFRAGMENT03';
const NEW_CC = 'sk-ui-cc-new-SECRETFRAGMENT04';
const RESET = Date.now() + 3 * 3600_000;
let hub;
let gateway;
let b;

before(async () => {
  if (skip) return;
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4.1-flash' }] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  hub = await startHub([], {
    env: { AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${gateway.address().port}` },
    seed: (data) => {
      fs.writeFileSync(
        path.join(data, 'deepseek.json'),
        JSON.stringify({
          gateway: 'opencode-go',
          keys: {
            'opencode-go': {
              revision: 2,
              activeId: 'k_go1',
              keys: [
                { id: 'k_go1', key: GO1, addedAt: 1000, exhaustedAt: Date.now() - 1000, retryAt: RESET },
                { id: 'k_go2', key: GO2, addedAt: 2000, exhaustedAt: Date.now() - 2000 },
              ],
            },
            commandcode: { revision: 1, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: CC1, addedAt: 3000 }] },
          },
          order: ['k_go1', 'k_cc1', 'k_go2'],
          activity: {},
        }),
        { mode: 0o600 },
      );
    },
  });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  hub?.stop();
  gateway?.close();
});

const SETTINGS_BTN = '.side-foot button[aria-label="設定"]';
const open = async () => {
  await b.size(1280, 900, false);
  await b.goto(hub.url + '#/', 300);
  await b.eval(`localStorage.clear(); location.reload()`);
  await sleep(800);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
};
const openDeepseek = async () => {
  await b.click(SETTINGS_BTN);
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith('DeepSeek…'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length > 0`, { timeout: 8000 });
};
const rows = () =>
  b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => ({ id: r.dataset.keyId, pos: r.querySelector('.ds-key-pos')?.innerText, gateway: r.querySelector('.ds-key-gw')?.innerText, hint: r.querySelector('.ds-key-hint')?.innerText, state: r.querySelector('.ds-key-state')?.innerText, on: r.classList.contains('on'), buttons: [...r.querySelectorAll('button')].map((x) => x.innerText) }))`);

test('one list, in order, with each key\'s gateway and a state that makes no claim the gateway did not make', { skip }, async () => {
  await open();
  await openDeepseek();
  const list = await rows();
  assert.deepEqual(list.map((r) => [r.pos, r.gateway, r.hint]), [['1', 'OpenCode Go', `…${GO1.slice(-4)}`], ['2', 'Command Code', `…${CC1.slice(-4)}`], ['3', 'OpenCode Go', `…${GO2.slice(-4)}`]]);
  assert.match(list[0].state, /已滿，.*重置/, 'the stated time is shown');
  assert.doesNotMatch(list[0].state, /未知/);
  assert.equal(list[1].state, '使用中', 'the first key not known to be out is the one in use');
  assert.equal(list[1].on, true);
  assert.match(list[2].state, /已滿，重置時間未知/, 'no time is invented for a key whose gateway named none');
  assert.ok(list[0].buttons.includes('重新啟用') && list[2].buttons.includes('重新啟用'));
  assert.ok(!list[1].buttons.includes('重新啟用'), 'a key that is fine has nothing to re-enable');
  // The shown reset time is the stated one, in the person's own clock.
  const shown = await b.eval(`document.querySelector('.deepseek-settings .ds-key-state').innerText`);
  assert.ok(shown.includes(new Date(RESET).toLocaleString()), shown);
  // The lead says what the list does.
  const text = await b.eval(`document.querySelector('.deepseek-settings').innerText`);
  assert.match(text, /同一份清單，依序使用/);
});

test('no key value is anywhere on the page: not in the dialog, not in the page source, not in what the page stores', { skip }, async () => {
  const dom = await b.eval(`document.documentElement.outerHTML + ' ' + document.body.innerText`);
  const stored = await b.eval(`JSON.stringify({ ...localStorage })`);
  for (const k of [GO1, CC1, GO2, NEW_CC]) {
    assert.ok(!dom.includes(k), `a key is in the page: ${k.slice(0, 12)}`);
    assert.ok(!dom.includes(k.slice(0, -4)), 'not even all but the last four');
    assert.ok(!stored.includes(k));
  }
});

test('adding a key for another gateway puts it last in the same list and leaves whose model names are used as they were', { skip }, async () => {
  await b.eval(`(() => { const s = document.querySelector('.deepseek-settings select[name="keyGateway"]'); s.value = 'commandcode'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const options = await b.eval(`[...document.querySelectorAll('.deepseek-settings select[name="keyGateway"] option')].map((o) => o.value)`);
  assert.deepEqual(options, ['opencode-go', 'opencode', 'commandcode']);
  await b.eval(`(() => { const i = document.querySelector('.deepseek-settings .ds-key-add input'); i.value = ${JSON.stringify(NEW_CC)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key-add button')].find((x) => x.innerText.includes('加入 key')).click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length === 4`, { timeout: 8000 });
  const list = await rows();
  assert.deepEqual([list[3].pos, list[3].gateway, list[3].hint, list[3].state], ['4', 'Command Code', `…${NEW_CC.slice(-4)}`, '待命']);
  const saved = JSON.parse(fs.readFileSync(path.join(hub.data, 'deepseek.json'), 'utf8'));
  assert.equal(saved.gateway, 'opencode-go', 'the model names stayed those of the gateway they were');
  assert.equal(saved.keys.commandcode.keys.at(-1).key, NEW_CC);
  assert.equal(saved.order.at(-1), saved.keys.commandcode.keys.at(-1).id);
  // The key field is emptied, and the value is not left on the page.
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key-add input').value`), '');
  const dom = await b.eval(`document.documentElement.outerHTML + document.body.innerText`);
  assert.ok(!dom.includes(NEW_CC) && !dom.includes(NEW_CC.slice(0, -4)));
});

test('deleting a key removes just that key and keeps the order of the others', { skip }, async () => {
  await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_cc1"] .om-btn--destructive').click()`);
  await b.waitFor(`document.querySelector('.alert .om-btn--destructive')`, { timeout: 5000 });
  assert.match(await b.eval(`document.querySelector('.alert').innerText`), /Command Code …/, 'the confirmation names the gateway');
  await b.eval(`document.querySelector('.alert .om-btn--destructive').click()`);
  // (The confirmation opened over the settings, so the list refreshes where it is.)
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length === 3`, { timeout: 8000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(hub.data, 'deepseek.json'), 'utf8')).keys.commandcode.keys.length, 1);
  const list = await rows();
  assert.deepEqual(list.map((r) => r.pos), ['1', '2', '3'], 'positions close up');
  assert.deepEqual(list.map((r) => r.id).filter((id) => id.startsWith('k_')), ['k_go1', 'k_go2']);
  assert.equal(list[2].gateway, 'Command Code', 'the key added last is still last');
});
