// The switch for the automatic 「繼續」 in the DeepSeek settings dialog (2026-10-30; server/key-recover.js):
// on by default, chosen at once, saved by the Hub, shown again from what the Hub says. The real Hub with
// a seeded key file and the real front end.
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
        JSON.stringify({ gateway: 'opencode-go', keys: { 'opencode-go': { revision: 1, activeId: 'k_a', keys: [{ id: 'k_a', key: 'sk-ui-resume-SECRETFRAGMENT01', addedAt: 1000 }] } }, order: ['k_a'], activity: {} }),
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

const stored = () => JSON.parse(fs.readFileSync(path.join(hub.data, 'deepseek.json'), 'utf8'));
const open = async () => {
  await b.size(1280, 900, false);
  await b.goto(hub.url + '#/', 300);
  await b.eval(`localStorage.clear(); location.reload()`);
  await sleep(800);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
  await b.click('.side-foot button[aria-label="設定"]');
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith('DeepSeek…'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length > 0`, { timeout: 8000 });
};
const checked = () => b.eval(`document.querySelector('.deepseek-settings input[name="autoResume"]').checked`);

test('the switch is there, on, with the words that say what it does and its limits', { skip }, async () => {
  await open();
  assert.equal(await checked(), true);
  const label = await b.eval(`document.querySelector('.deepseek-settings .ds-auto-resume').innerText.replace(/\\s+/g, ' ').trim()`);
  assert.match(label, /key 恢復後自動繼續被中斷的對話/);
  assert.match(label, /每個中斷的回合只送一次.*最近 2 小時.*Claude 對話不適用/);
  assert.equal('autoResume' in stored(), false, 'on is the default: nothing is written for it');
});

test('turning it off is saved by the Hub at once and stays off when the dialog is opened again; turning it on takes the line away', { skip }, async () => {
  await b.eval(`document.querySelector('.deepseek-settings input[name="autoResume"]').click()`);
  for (let i = 0; i < 100 && stored().autoResume !== false; i++) await sleep(50);
  assert.equal(stored().autoResume, false);
  assert.equal(await checked(), false);
  assert.equal((await hub.api('/deepseek')).autoResume, false);
  await open();
  assert.equal(await checked(), false, 'the dialog shows what the Hub says');
  await b.eval(`document.querySelector('.deepseek-settings input[name="autoResume"]').click()`);
  for (let i = 0; i < 100 && 'autoResume' in stored(); i++) await sleep(50);
  assert.equal('autoResume' in stored(), false);
  assert.equal((await hub.api('/deepseek')).autoResume, true);
});

test('a value that is not true or false is refused by the Hub, and nothing is written for it', { skip }, async () => {
  await assert.rejects(hub.api('/deepseek', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoResume: 'yes' }) }), /autoResume/);
  assert.equal('autoResume' in stored(), false);
});
