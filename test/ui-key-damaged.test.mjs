// A key file the Hub could not use, as a person sees it (a real Hub with a
// damaged claude.json / deepseek.json, and the real front end): the Claude API
// and DeepSeek settings dialogs say so above the key field — in the Hub's own
// words, with where the untouched copy is — and the home screen's "no key"
// notice says the same instead of "還沒有設定". A Hub whose files are fine says
// nothing of the kind.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let broken;
let fine;
let b;

before(async () => {
  if (skip) return;
  broken = await startHub([], {
    seed: (data) => {
      fs.writeFileSync(path.join(data, 'claude.json'), '{\n  "apiKey": "sk-ant-api03-SECRETFRAGMENT');
      fs.writeFileSync(path.join(data, 'deepseek.json'), Buffer.alloc(64));
    },
  });
  fine = await startHub([]);
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  broken?.stop();
  fine?.stop();
});

const SETTINGS_BTN = '.side-foot button[aria-label="設定"]';
const open = async (hub, hash = '#/') => {
  await b.size(1280, 900, false);
  await b.goto(hub.url + hash, 300);
  await b.eval(`localStorage.clear(); location.reload()`);
  await sleep(800);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
};
const openMenuItem = async (label) => {
  await b.click(SETTINGS_BTN);
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith(${JSON.stringify(label)}))?.click()`);
};
const backupOf = (hub, name) => path.join(hub.data, 'damaged-config', fs.readdirSync(path.join(hub.data, 'damaged-config')).find((f) => f.startsWith(`${name}.`)));

test('the Claude API dialog says the key file is damaged, where the copy is, and asks for the key again', { skip }, async () => {
  await open(broken);
  await openMenuItem('Claude API…');
  await b.waitFor(`document.querySelector('.claude-settings .config-damaged')`, { timeout: 8000 });
  const note = await b.eval(`document.querySelector('.claude-settings .config-damaged').innerText`);
  assert.match(note, /claude\.json/);
  assert.match(note, /損壞/);
  assert.ok(note.includes(backupOf(broken, 'claude.json')), `says where the copy is: ${note}`);
  assert.match(note, /重新輸入|從備份還原/);
  assert.ok(!note.includes('SECRETFRAGMENT'), 'never shows what is in the file');
  assert.match(await b.eval(`document.querySelector('.claude-settings .om-field__help').innerText`), /已儲存的 key 無法載入/, 'and the key field does not claim nothing was ever set');
});

test('the DeepSeek dialog says the same of its pool file', { skip }, async () => {
  await open(broken);
  await openMenuItem('DeepSeek…');
  await b.waitFor(`document.querySelector('.deepseek-settings .config-damaged')`, { timeout: 8000 });
  const note = await b.eval(`document.querySelector('.deepseek-settings .config-damaged').innerText`);
  assert.match(note, /deepseek\.json/);
  assert.match(note, /損壞/);
  assert.ok(note.includes(backupOf(broken, 'deepseek.json')), `says where the copy is: ${note}`);
});

test('the home screen\'s "no key" notice names the damaged file instead of saying no key was ever set', { skip }, async () => {
  await open(broken);
  // Claude is the provider with a notice when it has no key.
  await b.eval(`localStorage.setItem('hubHome', JSON.stringify({ provider: 'claude' }))`);
  await b.eval('location.reload()');
  await sleep(800);
  await b.waitFor(`document.querySelector('.callout.claude-key')`, { timeout: 8000 });
  const text = await b.eval(`document.querySelector('.callout.claude-key .callout-text').innerText`);
  assert.match(text, /損壞/);
  assert.doesNotMatch(text, /還沒有設定/);
});

test('a Hub whose key files are fine shows no such note (control)', { skip }, async () => {
  await open(fine);
  await openMenuItem('Claude API…');
  await b.waitFor(`document.querySelector('.claude-settings')`, { timeout: 8000 });
  assert.equal(await b.eval(`document.querySelector('.claude-settings .config-damaged')`), null);
  assert.match(await b.eval(`document.querySelector('.claude-settings .om-field__help').innerText`), /還沒有設定/);
});
