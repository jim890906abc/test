// A key whose reset time has passed, as a person sees it in the settings dialog
// (2026-10-30): not "full" any more - "已到重置時間，待下一個請求確認". The real Hub with
// a seeded key file, the real front end, and two scripted connectors (one that puts such
// a key back by itself, one that does not).
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const NOW = Date.now();
const KEYS = { k_a: 'sk-ui-due-SECRETFRAGMENT01', k_b: 'sk-ui-ready-SECRETFRAGMENT02', k_c: 'sk-ui-future-SECRETFRAGMENT03', k_d: 'sk-ui-unknown-SECRETFRAGMENT04' };
let hub;
let gateway;
let b;
const machines = {};

function connector(id, capabilities) {
  const key = JSON.parse(fs.readFileSync(path.join(hub.data, 'hub.json'), 'utf8')).bridgeKey;
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const k = {};
  ws.on('open', () => {
    send({ t: 'hello', machineId: id, name: id, platform: 'test', bridgeVersion: '0.12.0', home: '/home/fake', pool: 1, capabilities, status });
    send({ t: 'kimi.sessions', items: [] });
  });
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t !== 'req') return;
    let out = { ok: true };
    if (m.op === 'kimi.status' || m.op === 'kimi.start') out = status;
    else if (m.op === 'kimi.request') out = { code: 0, msg: 'ok', data: m.args?.path === '/api/v1/models' ? { items: [] } : {} };
    else if (m.op === 'kimi.deepseek.provision') out = { ok: true, created: true, models: m.args.models.map((x) => `agent-hub-deepseek/${x.model}`), sessionHeader: true };
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.report = async (keys = [], over = {}) => {
    const acc = await hub.api('/deepseek');
    send({ t: 'deepseek.pool', gateway: 'opencode-go', rotation: 1, activeId: acc.rotation.activeId, revision: acc.rotation.revision, distribution: 'sticky', keys, ...over });
  };
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  return k;
}

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
              activeId: 'k_b',
              keys: [
                { id: 'k_a', key: KEYS.k_a, addedAt: 1000, exhaustedAt: NOW - HOUR, retryAt: NOW - 120_000 },
                { id: 'k_b', key: KEYS.k_b, addedAt: 2000 },
                { id: 'k_c', key: KEYS.k_c, addedAt: 3000, exhaustedAt: NOW - 1000, retryAt: NOW + 2 * HOUR },
                { id: 'k_d', key: KEYS.k_d, addedAt: 4000, exhaustedAt: NOW - HOUR },
              ],
            },
          },
          order: ['k_a', 'k_b', 'k_c', 'k_d'],
          activity: {},
        }),
        { mode: 0o600 },
      );
    },
  });
  b = await launchBrowser();
  machines.new = connector('m_new', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky', 'pool_reset_due', 'pool_rate']);
  machines.old = connector('m_old', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky']);
  await Promise.all([machines.new.ready, machines.old.ready]);
  for (let i = 0; i < 100 && (await hub.api('/machines')).filter((m) => m.online).length < 2; i++) await sleep(50);
});
after(async () => {
  await b?.close();
  for (const m of Object.values(machines)) m.close();
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
const stateOf = (id) => b.eval(`(document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"] .ds-key-state')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const classOf = (id) => b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="${id}"]')?.className ?? ''`);
const text = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);

test('a key whose time has passed says it waits for the next request to confirm it - not "full"; the others keep their words', { skip }, async () => {
  await open();
  await openDeepseek();
  assert.equal(await stateOf('k_a'), '已到重置時間，待下一個請求確認');
  assert.equal(await stateOf('k_b'), '待命', 'the first key of the list that is not out is the key in use - the one that waits to be confirmed comes before the ready one');
  assert.match(await stateOf('k_c'), /^已滿，.*重置$/);
  assert.equal(await stateOf('k_d'), '已滿，重置時間未知（下一個真實請求會再試）');
  assert.doesNotMatch(await text('.deepseek-settings .ds-key[data-key-id="k_a"]'), /已滿/);
  // It is in the rotation, so it is not drawn as a key that is out; the keys that are out are.
  assert.doesNotMatch(await classOf('k_a'), /exhausted/);
  assert.match(await classOf('k_c'), /exhausted/);
  // It can still be cleared or re-enabled by hand.
  assert.equal(await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-key[data-key-id="k_a"] [data-act]')].map((x) => x.dataset.act).filter((a) => a === 'clear' || a === 'retry').join(',')`), 'clear,retry');
});

test('the pool is not called "all out" while a key only waits for its confirming request', { skip }, async () => {
  assert.equal(await b.eval(`document.querySelectorAll('.deepseek-settings .ds-all-out').length`), 0);
});

test('a computer whose connector is too old says such a key waits there until every other key is out', { skip }, async () => {
  await machines.new.report();
  await machines.old.report();
  await b.waitFor(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].filter((m) => /^m_(old|new)/.test(m.innerText)).length === 2`, { timeout: 8000 });
  const lines = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].map((m) => m.innerText.replace(/\\s+/g, ' ').trim())`);
  const mNew = lines.find((l) => l.startsWith('m_new'));
  const mOld = lines.find((l) => l.startsWith('m_old'));
  assert.doesNotMatch(mNew, /連接器太舊/, mNew);
  assert.match(mOld, /這台電腦的連接器太舊，過了重置時間的 key 要等其他 key 都用完才會被試；重新執行連接指令更新後才會回到輪替/, mOld);
});

test('the key is cleared once a computer reports a real request went through on it', { skip }, async () => {
  await machines.new.report([{ id: 'k_a', recoveredAt: Date.now(), recoveredFrom: NOW - HOUR }]);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-key-state')?.innerText.trim() !== '已到重置時間，待下一個請求確認'`, { timeout: 8000 });
  assert.match(await stateOf('k_a'), /^(使用中|待命)$/);
});

test('no key value is anywhere on the page', { skip }, async () => {
  const dom = await b.eval(`document.documentElement.outerHTML + ' ' + document.body.innerText`);
  for (const k of Object.values(KEYS)) assert.ok(!dom.includes(k.slice(0, -4)), 'a key is in the page');
});
