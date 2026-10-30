// A key cooling down because of rate limits, as a person sees it in the settings dialog
// (2026-10-30): 「限流冷卻中（到 HH:MM:SS，最近 30 秒 N 次 429）」 next to the key's state, a line of
// counts (borrowed, cooled, resends that worked / failed), and a note on a computer whose connector
// is too old to watch. The real Hub with a seeded key file, the real front end, and two scripted
// connectors that report the way real ones do.
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
const KEYS = { k_a: 'sk-ui-rate-one-SECRETFRAGMENT01', k_b: 'sk-ui-rate-two-SECRETFRAGMENT02' };
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
  k.report = async (keys = []) => {
    const acc = await hub.api('/deepseek');
    send({ t: 'deepseek.pool', gateway: 'opencode-go', rotation: 1, activeId: acc.rotation.activeId, revision: acc.rotation.revision, distribution: 'sticky', keys });
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
          keys: { 'opencode-go': { revision: 2, activeId: 'k_a', keys: [{ id: 'k_a', key: KEYS.k_a, addedAt: 1000 }, { id: 'k_b', key: KEYS.k_b, addedAt: 2000 }] } },
          order: ['k_a', 'k_b'],
          activity: {},
        }),
        { mode: 0o600 },
      );
    },
  });
  b = await launchBrowser();
  machines.new = connector('m_new', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky', 'pool_reset_due', 'pool_rate']);
  machines.old = connector('m_old', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky', 'pool_reset_due']);
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
const text = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const hms = (t) => [new Date(t).getHours(), new Date(t).getMinutes(), new Date(t).getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');

test('nothing is said about rate limits until a computer reports one', { skip }, async () => {
  await open();
  await openDeepseek();
  assert.equal(await b.eval(`document.querySelectorAll('.deepseek-settings [data-rate]').length`), 0);
});

test('a key cooling down says until when and on what count, next to its state; the other key says nothing', { skip }, async () => {
  const until = Date.now() + 90_000;
  await machines.new.report([{ id: 'k_a', rateCooldown: { until, n429: 5, windowMs: 30_000, level: 0 } }]);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="cooldown"]')`, { timeout: 8000 });
  assert.equal(await text('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="cooldown"]'), `限流冷卻中（到 ${hms(until)}，最近 30 秒 5 次 429）`);
  assert.equal(await b.eval(`document.querySelectorAll('.deepseek-settings .ds-key[data-key-id="k_b"] [data-rate]').length`), 0);
  // It is still a key in use: its state is not "full".
  assert.doesNotMatch(await text('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-key-state'), /已滿/);
  assert.equal(await b.eval(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"]').className.includes('exhausted')`), false);
});

test('the counts of borrowing, cooling and resending are one line under the key', { skip }, async () => {
  await machines.new.report([{ id: 'k_a', rateCooldown: { until: Date.now() + 90_000, n429: 5, windowMs: 30_000, level: 0 }, rateStats: { borrows: 12, cooldowns: 2, resendOk: 9, resendFail: 1 } }]);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="stats"]')`, { timeout: 8000 });
  assert.match(await text('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="stats"]'), /借用 12 次、冷卻 2 次、因限流重送成功 9／失敗 1/);
});

test('a longer window is said in minutes', { skip }, async () => {
  await machines.new.report([{ id: 'k_a', rateCooldown: { until: Date.now() + 90_000, n429: 7, windowMs: 120_000, level: 1 } }]);
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="cooldown"]')?.innerText.includes('最近 2 分鐘 7 次')`, { timeout: 8000 });
});

test('the mark goes when the computer stops reporting the cooldown', { skip }, async () => {
  await machines.new.report([{ id: 'k_a' }]);
  await b.waitFor(`!document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] [data-rate="cooldown"]')`, { timeout: 8000 });
});

test('a computer whose connector is too old says it does not watch for rate limits; the new one does not say it', { skip }, async () => {
  await machines.new.report();
  await machines.old.report();
  await b.waitFor(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].filter((m) => /^m_(old|new)/.test(m.innerText)).length === 2`, { timeout: 8000 });
  const lines = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].map((m) => m.innerText.replace(/\\s+/g, ' ').trim())`);
  const mNew = lines.find((l) => l.startsWith('m_new'));
  const mOld = lines.find((l) => l.startsWith('m_old'));
  assert.doesNotMatch(mNew, /不會偵測限流/, mNew);
  assert.match(mOld, /這台電腦的連接器太舊，不會偵測限流；重新執行連接指令更新後，收到 429 的請求才會自動改用別把 key/, mOld);
});

test('no key value is anywhere on the page', { skip }, async () => {
  const dom = await b.eval(`document.documentElement.outerHTML + ' ' + document.body.innerText`);
  for (const k of Object.values(KEYS)) assert.ok(!dom.includes(k.slice(0, -4)), 'a key is in the page');
});
