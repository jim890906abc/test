// A DeepSeek key its gateway refuses (HTTP 401), in a real browser: the key list
// says "認證失敗（HTTP 401）" - apart from "已滿" - with when it failed and when a
// real request will look at it again, and says in so many words that this is the
// Hub's own probing time and not a reset time anybody stated; "清除標記" and
// "重新啟用" are offered and work; when every key is out the notice counts the
// kinds apart; each computer's line says the key it is on was refused. A real Hub
// with a seeded key file, the real front end, a local fake gateway.
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
const KEY_A = 'sk-auth-go-ready-SECRETFRAGMENT01';
const KEY_B = 'sk-auth-cc-ready-SECRETFRAGMENT02';
const KEY_C = 'sk-auth-go-refused-SECRETFRAGMENT03';
const KEY_D = 'sk-auth-go-quotaout-SECRETFRAGMENT04';
const FAILED_AT = Date.now() - 20_000;
const RETRY_AT = Date.now() + 100_000;
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
                { id: 'k_c', key: KEY_C, addedAt: 3000, authFailedAt: FAILED_AT, authFailures: 2, authRetryAt: RETRY_AT },
                // Out of quota, the gateway named no time: the other kind of key that is out.
                { id: 'k_d', key: KEY_D, addedAt: 4000, exhaustedAt: Date.now() - 5000 },
              ],
            },
            commandcode: { revision: 1, activeId: 'k_b', keys: [{ id: 'k_b', key: KEY_B, addedAt: 2000 }] },
          },
          order: ['k_a', 'k_b', 'k_c', 'k_d'],
          activity: {
            m_refused: { gateway: 'opencode-go', activeId: 'k_c', revision: 5, at: Date.now(), rotation: true },
            m_fine: { gateway: 'commandcode', activeId: 'k_b', revision: 5, at: Date.now(), rotation: true },
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
  b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => ({ id: r.dataset.keyId, state: r.querySelector('.ds-key-state')?.innerText, note: r.querySelector('.ds-key-auth')?.innerText || '', cls: r.className, acts: [...r.querySelectorAll('button')].map((x) => x.dataset.act || x.innerText) }))`);
const press = async (id, act) => {
  await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] [data-act="${act}"]').click()`);
  await b.waitFor(`!document.querySelector('.deepseek-settings .claude-test .spinner')`, { timeout: 8000 });
};
const stateOf = async (id) => (await rows()).find((r) => r.id === id)?.state;

test('a refused key is "認證失敗（HTTP 401）", not "已滿": when it failed, when a real request tries again, and that this time is the Hub\'s own', { skip }, async () => {
  await open();
  await openDeepseek();
  const list = await rows();
  const c = list.find((r) => r.id === 'k_c');
  assert.equal(c.state, '認證失敗（HTTP 401）');
  assert.doesNotMatch(c.state, /已滿|用盡/, 'it is not a key out of quota');
  const when = (t) => b.eval(`new Date(${t}).toLocaleString()`);
  assert.ok(c.note.includes(await when(FAILED_AT)), `the failure time is on the page: ${c.note}`);
  assert.ok(c.note.includes(await when(RETRY_AT)), `and the time of the next real try: ${c.note}`);
  assert.match(c.note, /上次/);
  assert.match(c.note, /下次(由)?真實請求再試/);
  assert.match(c.note, /不是供應商給的重置時間/, 'said in so many words: this is not a reset time');
  assert.match(c.note, /2 次/, 'how many times in a row');
  assert.doesNotMatch(c.note.replace('不是供應商給的重置時間', ''), /重置/, 'and no reset time is claimed');
  assert.match(c.cls, /exhausted|refused/, 'drawn as a key that is out of use');
  // Like any key that is out of use, it can be cleared or re-enabled, and cannot be marked again.
  assert.deepEqual(c.acts, ['top', 'up', 'down', 'clear', 'retry', 'test', 'measure', 'remove']);
  // The keys that are fine have no such note.
  assert.equal(list.find((r) => r.id === 'k_a').note, '');
  assert.equal(list.find((r) => r.id === 'k_a').state, '使用中');
  assert.equal(list.find((r) => r.id === 'k_b').state, '待命');
  // A key out of quota is still said the old way.
  const d = list.find((r) => r.id === 'k_d');
  assert.match(d.state, /已滿，重置時間未知/);
  assert.equal(d.note, '');
});

test('each computer\'s line says its key was refused', { skip }, async () => {
  const lines = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].map((m) => m.innerText.replace(/\\s+/g, ' ').trim())`);
  const refused = lines.find((l) => l.startsWith('m_refused'));
  const fine = lines.find((l) => l.startsWith('m_fine'));
  assert.match(refused, /OpenCode Go …/, refused);
  assert.match(refused, /認證失敗/, refused);
  assert.doesNotMatch(fine, /認證失敗|用盡|手動標記/, fine);
});

test('when every key is out the notice counts the kinds apart and says what the refused ones are waiting for', { skip }, async () => {
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-all-out')`), null, 'not shown while a key is fine');
  await press('k_a', 'mark');
  await press('k_b', 'mark');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-all-out')`, { timeout: 8000 });
  const text = await b.eval(`document.querySelector('.deepseek-settings .ds-all-out').innerText`);
  assert.match(text, /全部 4 把 key 都不能用/);
  assert.match(text, /認證失敗（HTTP 401）1 把/);
  assert.match(text, /額度用完 1 把/);
  assert.match(text, /手動標記已滿 2 把/);
  assert.match(text, /額度用完的 key 沒有任何閘道說過重置時間/, 'only the key out of quota is said to have no stated reset time');
  assert.match(text, /不是供應商給的重置時間/);
  assert.match(text, /重新啟用/);
  assert.match(text, /清除標記/);
  assert.match(text, /加入新的 key/);
  assert.doesNotMatch(text, /都是你手動標記的/, 'not every key is a manual one');
  await press('k_a', 'clear');
  await press('k_b', 'clear');
  await b.waitFor(`!document.querySelector('.deepseek-settings .ds-all-out')`, { timeout: 8000 });
});

test('"清除標記" works on a refused key: the Hub forgets the refusal at once, and the page shows the key as fine', { skip }, async () => {
  await press('k_c', 'clear');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_c"] .ds-key-state').innerText === '待命'`, { timeout: 8000 });
  const k = stored().keys['opencode-go'].keys.find((x) => x.id === 'k_c');
  assert.deepEqual([k.authFailedAt, k.authFailures, k.authRetryAt, k.exhaustedAt], [undefined, undefined, undefined, undefined]);
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_c"] .ds-key-auth')`), null, 'the note is gone with the state');
  const dom = await b.eval(`document.documentElement.outerHTML + document.body.innerText`);
  for (const key of [KEY_A, KEY_B, KEY_C, KEY_D]) assert.ok(!dom.includes(key.slice(0, -4)), 'a key is on the page');
});
