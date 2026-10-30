// How the DeepSeek keys are given out, in the settings dialog, in a real browser:
// two ways to choose between (one key for each conversation - the default - or the
// relay), how many conversations each key has right now, and what an older
// connector (which can only relay) looks like. A real Hub with a seeded key file,
// the real front end, and two scripted connectors that connect and report the way
// real ones do.
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
const KEY_A = 'sk-dist-go-ready-SECRETFRAGMENT01';
const KEY_B = 'sk-dist-cc-ready-SECRETFRAGMENT02';
const KEY_C = 'sk-dist-go-spare-SECRETFRAGMENT03';
let hub;
let gateway;
let b;
const machines = {};

// A connector: connects with what it can do, keeps the provisions it was sent, reports.
function connector(id, capabilities) {
  const key = JSON.parse(fs.readFileSync(path.join(hub.data, 'hub.json'), 'utf8')).bridgeKey;
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const k = { provisioned: [] };
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
    else if (m.op === 'kimi.deepseek.provision') {
      k.provisioned.push(m.args);
      out = { ok: true, created: true, models: m.args.models.map((x) => `agent-hub-deepseek/${x.model}`), sessionHeader: true };
    } else if (m.op === 'kimi.deepseek.remove') out = { ok: true, removed: true };
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.report = async (counts, over = {}) => {
    const acc = await hub.api('/deepseek');
    send({ t: 'deepseek.pool', gateway: 'opencode-go', rotation: 1, activeId: acc.rotation.activeId, revision: acc.rotation.revision, distribution: 'sticky', keys: Object.entries(counts).map(([kid, sessions]) => ({ id: kid, sessions })), ...over });
  };
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  k.last = () => k.provisioned.at(-1);
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
              activeId: 'k_a',
              keys: [
                { id: 'k_a', key: KEY_A, addedAt: 1000 },
                { id: 'k_c', key: KEY_C, addedAt: 3000 },
              ],
            },
            commandcode: { revision: 1, activeId: 'k_b', keys: [{ id: 'k_b', key: KEY_B, addedAt: 2000 }] },
          },
          order: ['k_a', 'k_b', 'k_c'],
          activity: {},
        }),
        { mode: 0o600 },
      );
    },
  });
  b = await launchBrowser();
  machines.new = connector('m_new', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff', 'pool_sticky']);
  machines.old = connector('m_old', ['pool', 'pool_cross', 'pool_auth', 'secondary_model', 'handoff']);
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
const text = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const sessionsShown = () => b.eval(`Object.fromEntries([...document.querySelectorAll('.deepseek-settings .ds-key')].map((r) => [r.dataset.keyId, r.querySelector('.ds-key-sessions')?.innerText.replace(/\\s+/g, ' ').trim() ?? null]))`);
const checkedWay = () => b.eval(`[...document.querySelectorAll('.deepseek-settings input[name="distribution"]')].find((x) => x.checked)?.value ?? null`);
const waitStored = async (want) => {
  for (let i = 0; i < 100 && stored().distribution !== want; i++) await sleep(50);
  assert.equal(stored().distribution, want);
};

test('the dialog offers the two ways and starts on one key for each conversation, the default, with nothing written to the key file', { skip }, async () => {
  await open();
  await openDeepseek();
  assert.equal(await b.eval(`document.querySelectorAll('.deepseek-settings input[name="distribution"]').length`), 2);
  assert.equal(await checkedWay(), 'sticky');
  const labels = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-dist .gw-name')].map((e) => e.innerText)`);
  assert.deepEqual(labels, ['平均分配（每個對話固定一把）', '接力（用完才換下一把）']);
  assert.match(await text('.deepseek-settings .ds-dist [data-dist="sticky"]'), /預設/);
  assert.match(await text('.deepseek-settings .ds-dist-note'), /每個對話固定用一把 key.*子代理.*前綴快取.*只有用那一把的對話改用別把/);
  assert.match(await text('.deepseek-settings .ds-key-head'), /平均分配：每個對話固定用一把/);
  assert.equal(stored().distribution, undefined);
  // The lead above the list is still there.
  assert.match(await text('.deepseek-settings'), /同一份清單，依序使用/);
});

test('each key says how many conversations it has once a computer has told the Hub, and the dialog follows it live', { skip }, async () => {
  assert.deepEqual(Object.values(await sessionsShown()), [null, null, null], 'nobody has counted: nothing is shown, not 0');
  await machines.new.report({ k_a: 4, k_b: 3, k_c: 0 });
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_a"] .ds-key-sessions')`, { timeout: 8000 });
  assert.deepEqual(await sessionsShown(), { k_a: '目前 4 個對話', k_b: '目前 3 個對話', k_c: '目前 0 個對話' });
  // A later report of the same computer replaces the last one.
  await machines.new.report({ k_a: 4, k_b: 2, k_c: 1 });
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key[data-key-id="k_b"] .ds-key-sessions')?.innerText.includes('2')`, { timeout: 8000 });
  assert.deepEqual(await sessionsShown(), { k_a: '目前 4 個對話', k_b: '目前 2 個對話', k_c: '目前 1 個對話' });
});

test('a computer whose connector is too old says it can only relay, and so does the note under the choice', { skip }, async () => {
  // The older connector reports the way an older connector does: no distribution, no counts.
  await machines.old.report({}, { distribution: undefined, keys: [{ id: 'k_a' }] });
  await b.waitFor(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].some((m) => m.innerText.startsWith('m_old'))`, { timeout: 8000 });
  const lines = await b.eval(`[...document.querySelectorAll('.deepseek-settings .ds-machine')].map((m) => m.innerText.replace(/\\s+/g, ' ').trim())`);
  const mNew = lines.find((l) => l.startsWith('m_new'));
  const mOld = lines.find((l) => l.startsWith('m_old'));
  assert.doesNotMatch(mNew, /只能接力/, mNew);
  assert.match(mOld, /這台電腦的連接器太舊，只能接力；重新執行連接指令更新後才會平均分配/, mOld);
  assert.match(await text('.deepseek-settings .ds-dist-note'), /「m_old」的連接器太舊，只能接力/);
  assert.doesNotMatch(await text('.deepseek-settings .ds-dist-note'), /m_new/);
});

test('choosing the relay is saved, sent to the computer that can read it, and the dialog changes its words; choosing the first way again undoes it', { skip }, async () => {
  const before = machines.new.provisioned.length;
  await b.eval(`document.querySelector('.deepseek-settings input[name="distribution"][value="relay"]').click()`);
  await waitStored('relay');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key-head')?.innerText.includes('依序使用')`, { timeout: 8000 });
  assert.equal(await checkedWay(), 'relay');
  for (let i = 0; i < 100 && machines.new.provisioned.length === before; i++) await sleep(50);
  assert.equal(machines.new.last().pool.distribution, 'relay');
  assert.equal('distribution' in machines.old.last().pool, false, 'the older connector is not told');
  assert.match(await text('.deepseek-settings .ds-key-head'), /依序使用，用完自動換下一把/);
  assert.match(await text('.deepseek-settings .ds-dist-note'), /所有對話都用清單裡使用中的那一把/);
  assert.deepEqual(Object.values(await sessionsShown()), [null, null, null], 'no counts in a relay');
  assert.doesNotMatch(await text('.deepseek-settings .ds-dist-note'), /m_old/, 'in a relay nobody is left out of anything');
  assert.equal(await b.eval(`document.querySelectorAll('.deepseek-settings [data-note="relay-only"]').length`), 0);

  await b.eval(`document.querySelector('.deepseek-settings input[name="distribution"][value="sticky"]').click()`);
  await waitStored('sticky');
  await b.waitFor(`document.querySelector('.deepseek-settings .ds-key-head')?.innerText.includes('平均分配')`, { timeout: 8000 });
  assert.equal(await checkedWay(), 'sticky');
  assert.match(await text('.deepseek-settings .ds-dist-note'), /「m_old」的連接器太舊/);
});

test('no key value and no conversation id is anywhere on the page', { skip }, async () => {
  const dom = await b.eval(`document.documentElement.outerHTML + ' ' + document.body.innerText`);
  for (const k of [KEY_A, KEY_B, KEY_C]) {
    assert.ok(!dom.includes(k), `a key is in the page: ${k.slice(0, 12)}`);
    assert.ok(!dom.includes(k.slice(0, -4)), 'not even all but the last four');
  }
  assert.ok(!/session_[\w-]{4,}/.test(dom), 'no conversation id');
});
