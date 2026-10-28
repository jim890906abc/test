// What a person can do to the DeepSeek key list, in a real browser: move a key
// (up, down, to the front), mark a key full by hand and clear a mark, delete and
// clear without the confirmation taking the settings away, and read what each
// computer is on and what the list says when every key is out. A real Hub with a
// seeded key file, the real front end, a local fake gateway for the key checks.
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
const KEY_A = 'sk-act-go-ready-SECRETFRAGMENT01';
const KEY_B = 'sk-act-cc-ready-SECRETFRAGMENT02';
const KEY_C = 'sk-act-go-out-SECRETFRAGMENT03';
let hub;
let gateway;
let b;

before(async () => {
  if (skip) return;
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
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
              activeId: 'k_a',
              keys: [
                { id: 'k_a', key: KEY_A, addedAt: 1000 },
                { id: 'k_c', key: KEY_C, addedAt: 3000, exhaustedAt: Date.now() - 5000 },
              ],
            },
            commandcode: { revision: 1, activeId: 'k_b', keys: [{ id: 'k_b', key: KEY_B, addedAt: 2000 }] },
          },
          order: ['k_a', 'k_b', 'k_c'],
          // One computer on a connector that rotates across gateways, one on an older one.
          activity: {
            m_new: { gateway: 'commandcode', activeId: 'k_b', revision: 5, at: Date.now(), rotation: true },
            m_old: { gateway: 'opencode-go', activeId: 'k_a', revision: 2, at: Date.now() },
          },
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
const stored = () => JSON.parse(fs.readFileSync(path.join(hub.data, 'deepseek.json'), 'utf8'));
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
  b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => ({ id: r.dataset.keyId, pos: r.querySelector('.ds-key-pos')?.innerText, gateway: r.querySelector('.ds-key-gw')?.innerText, state: r.querySelector('.ds-key-state')?.innerText, acts: [...r.querySelectorAll('button')].map((x) => x.dataset.act || x.innerText) }))`);
const order = () => b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => r.dataset.keyId)`);
// (One operation is out at a time and a click during it is ignored on purpose: wait for it to end.)
const press = async (id, act) => {
  await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] [data-act="${act}"]').click()`);
  await b.waitFor(`!document.querySelector('.deepseek-settings .claude-test .spinner')`, { timeout: 8000 });
};
const waitOrder = (ids) => b.waitFor(`JSON.stringify([...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => r.dataset.keyId)) === ${JSON.stringify(JSON.stringify(ids))}`, { timeout: 8000 });
const stateOf = async (id) => (await rows()).find((r) => r.id === id)?.state;

test('each key offers only the moves and marks that make sense for where it is and how it stands', { skip }, async () => {
  await open();
  await openDeepseek();
  const list = await rows();
  assert.deepEqual(list.map((r) => r.id), ['k_a', 'k_b', 'k_c']);
  // First: nothing to move up; last: nothing to move down; a key that is fine can be marked, one that is out can be cleared or re-enabled.
  assert.deepEqual(list[0].acts, ['down', 'mark', 'test', 'remove'], 'first, fine');
  assert.deepEqual(list[1].acts, ['top', 'up', 'down', 'mark', 'test', 'remove'], 'middle, fine');
  assert.deepEqual(list[2].acts, ['top', 'up', 'clear', 'retry', 'test', 'remove'], 'last, out');
  assert.equal(list[0].state, '使用中');
  assert.equal(list[1].state, '待命');
  assert.match(list[2].state, /已滿，重置時間未知/);
});

test('up, down and to-the-front change the order on the page and in the Hub, and "in use" follows the order', { skip }, async () => {
  // Two clicks before the first answer: one move, not two (the second would act on a list that is about to change).
  await b.eval(`(() => { const x = document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-act="down"]'); x.click(); x.click(); })()`);
  await waitOrder(['k_b', 'k_a', 'k_c']);
  await sleep(500);
  assert.deepEqual(await order(), ['k_b', 'k_a', 'k_c'], 'the second click did nothing');
  assert.deepEqual(stored().order, ['k_b', 'k_a', 'k_c']);
  assert.equal(await stateOf('k_b'), '使用中', 'the first key not known to be out is the one in use');
  assert.equal(await stateOf('k_a'), '待命');
  await press('k_c', 'top');
  await waitOrder(['k_c', 'k_b', 'k_a']);
  assert.deepEqual(stored().order, ['k_c', 'k_b', 'k_a']);
  assert.equal(await stateOf('k_b'), '使用中', 'a key that is out in front does not take the place of a key that is fine');
  await press('k_a', 'up');
  await waitOrder(['k_c', 'k_a', 'k_b']);
  await press('k_c', 'down');
  await press('k_c', 'down');
  await waitOrder(['k_a', 'k_b', 'k_c']);
  assert.deepEqual(stored().order, ['k_a', 'k_b', 'k_c']);
  const list = await rows();
  assert.deepEqual(list.map((r) => r.pos), ['1', '2', '3']);
});

test('when every key is out the list says so, and says honestly whether any gateway named a time', { skip }, async () => {
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-all-out')`), null, 'not shown while a key is fine');
  // k_c was reported out by a gateway that named no time; a and b are marked by hand.
  await press('k_a', 'mark');
  await press('k_b', 'mark');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-all-out')`, { timeout: 8000 });
  const text = await b.eval(`document.querySelector('.deepseek-settings .ds-all-out').innerText`);
  assert.match(text, /全部 3 把 key 都用盡了/);
  assert.match(text, /沒有任何閘道說過重置時間/, 'no time is shown that nobody stated');
  assert.match(text, /下一個真實請求會再試/);
  assert.match(text, /重新啟用/);
  assert.match(text, /清除標記/);
  assert.match(text, /加入新的 key/);
  await press('k_a', 'clear');
  await b.waitFor(`!document.querySelector('.deepseek-settings .ds-all-out')`, { timeout: 8000 });
  await press('k_b', 'clear');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_b"] .ds-key-state').innerText === '待命'`, { timeout: 8000 });
});

test('marking a key full sets it aside until a person clears it; clearing also works on a key a gateway reported out', { skip }, async () => {
  await press('k_a', 'mark');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-key-state').innerText === '手動標記已滿'`, { timeout: 8000 });
  assert.equal(stored().keys['opencode-go'].keys.find((k) => k.id === 'k_a').manual, true);
  assert.equal(await stateOf('k_b'), '使用中', 'the next key is in use');
  const acts = (await rows()).find((r) => r.id === 'k_a').acts;
  assert.ok(acts.includes("clear") && acts.includes("retry") && !acts.includes("mark"), 'a marked key offers clearing and re-enabling, not marking again');
  await press('k_a', 'clear');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-key-state').innerText === '使用中'`, { timeout: 8000 });
  const a = stored().keys['opencode-go'].keys.find((k) => k.id === 'k_a');
  assert.equal(a.exhaustedAt, undefined);
  assert.equal(a.manual, undefined);
  // A key the gateway said was out: the person says it is fine, nothing is asked of the gateway.
  await press('k_c', 'clear');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_c"] .ds-key-state').innerText === '待命'`, { timeout: 8000 });
  assert.equal(stored().keys['opencode-go'].keys.find((k) => k.id === 'k_c').exhaustedAt, undefined);
  await press('k_c', 'mark');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_c"] .ds-key-state').innerText === '手動標記已滿'`, { timeout: 8000 });
  // All of them by hand: nothing will retry by itself, and the list says that instead of promising a retry.
  await press('k_a', 'mark');
  await press('k_b', 'mark');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-all-out')`, { timeout: 8000 });
  const manual = await b.eval(`document.querySelector('.deepseek-settings .ds-all-out').innerText`);
  assert.match(manual, /都是你手動標記的，不會自動再試/);
  assert.doesNotMatch(manual, /下一個真實請求會再試|沒有任何閘道說過/);
  await press('k_a', 'clear');
  await press('k_b', 'clear');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_b"] .ds-key-state').innerText === '待命'`, { timeout: 8000 });
});

test('each computer\'s key says its gateway and its state; an older connector says it only rotates inside one gateway', { skip }, async () => {
  const lines = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].map((m) => m.innerText.replace(/\\s+/g, ' ').trim())`);
  const mNew = lines.find((l) => l.startsWith('m_new'));
  const mOld = lines.find((l) => l.startsWith('m_old'));
  assert.match(mNew, /Command Code …/, mNew);
  assert.doesNotMatch(mNew, /舊版/);
  assert.match(mOld, /OpenCode Go …/, mOld);
  assert.match(mOld, /舊版連接器.*只在 OpenCode Go 內換/, mOld);
  const hint = await b.eval(`document.querySelector('.deepseek-settings .ds-machine-rev').title`);
  assert.doesNotMatch(hint, /號池版本/, 'the old wording talked about a pool per gateway');
});

test('deleting: the confirmation opens over the settings, Escape and cancel leave both alone, and confirming refreshes the list in place', { skip }, async () => {
  const del = (id) => b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] [data-act="remove"]').click()`);
  await del('k_c');
  await b.waitFor(`document.querySelector('.alert .om-btn--destructive')`, { timeout: 5000 });
  assert.equal(await b.eval(`Boolean(document.querySelector('.deepseek-settings'))`), true, 'the settings are still there under the confirmation');
  assert.match(await b.eval(`document.querySelector('.alert').innerText`), /OpenCode Go …/);
  // Escape closes the confirmation only.
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await b.waitFor(`!document.querySelector('.alert')`, { timeout: 5000 });
  assert.equal(await b.eval(`Boolean(document.querySelector('.deepseek-settings'))`), true, 'Escape took the confirmation, not the settings');
  assert.equal((await order()).length, 3);
  // Cancel.
  await del('k_c');
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  await b.eval(`[...document.querySelectorAll('.alert .om-btn')].find((x) => x.innerText === '取消').click()`);
  await b.waitFor(`!document.querySelector('.alert')`, { timeout: 5000 });
  assert.equal((await order()).length, 3);
  assert.equal(stored().keys['opencode-go'].keys.length, 2, 'nothing was removed');
  // Confirm: the list shrinks in the same window; no reopening.
  await del('k_c');
  await b.waitFor(`document.querySelector('.alert .om-btn--destructive')`, { timeout: 5000 });
  await b.eval(`document.querySelector('.alert .om-btn--destructive').click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length === 2`, { timeout: 8000 });
  assert.deepEqual(await order(), ['k_a', 'k_b']);
  assert.deepEqual(stored().order, ['k_a', 'k_b']);
  assert.equal(await b.eval(`Boolean(document.querySelector('.alert'))`), false);
});

test('clearing every key asks over the settings too; cancelling leaves the list as it was', { skip }, async () => {
  await b.eval(`[...document.querySelectorAll('.deepseek-settings .claude-key-actions button')].find((x) => x.innerText.startsWith('清空全部')).click()`);
  await b.waitFor(`document.querySelector('.alert')`, { timeout: 5000 });
  assert.equal(await b.eval(`Boolean(document.querySelector('.deepseek-settings'))`), true);
  assert.match(await b.eval(`document.querySelector('.alert').innerText`), /清空全部 2 把/);
  await b.eval(`[...document.querySelectorAll('.alert .om-btn')].find((x) => x.innerText === '取消').click()`);
  await b.waitFor(`!document.querySelector('.alert')`, { timeout: 5000 });
  assert.equal((await order()).length, 2);
  // No key value anywhere on the page, after all of it.
  const dom = await b.eval(`document.documentElement.outerHTML + document.body.innerText`);
  for (const k of [KEY_A, KEY_B, KEY_C]) assert.ok(!dom.includes(k.slice(0, -4)), 'a key is on the page');
});
