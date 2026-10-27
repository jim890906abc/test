// The Artifact panel lists every page the conversation made, also the ones
// written long before the part of the conversation the page holds. Real Hub
// (it cuts the conversation into windows by itself) and real front end.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { artifactScene, storedSession, WINDOW_ENV, WINDOW } from './fixtures/window-scenes.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scene = artifactScene();
let hub;
let b;

before(async () => {
  if (skip) return;
  hub = await startHub([storedSession(scene.events)], { env: WINDOW_ENV });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  hub?.stop();
});

// The page being shown by the panel right now (the front one of the two frames).
const shown = () => b.eval(`(() => { const f = [...document.querySelectorAll('.artifact-frame')].find((x) => !x.classList.contains('back')); return f ? f.srcdoc : null; })()`);
const label = () => b.eval(`document.querySelector('.panel .versions-label')?.textContent ?? null`);
const pickItems = async () => {
  await b.click('.panel .artifact-pick');
  await sleep(150);
  const items = await b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
  return items;
};
const choose = async (path) => {
  await b.click('.panel .artifact-pick');
  await sleep(150);
  const ok = await b.eval(`(() => { const it = [...document.querySelectorAll('.om-menu .om-menu__item')].find((e) => e.innerText.includes(${JSON.stringify(path)})); if (!it) return false; it.click(); return true; })()`);
  assert.ok(ok, `${path} is in the list`);
  await sleep(400);
};

async function open() {
  await b.goto(`${hub.url}#/s/s_scene`, 300);
  await b.waitFor(`document.querySelectorAll('.transcript .column > .ev').length > 0`, { timeout: 15000 });
  await sleep(600);
}

test('the Hub really cuts this conversation: the first pages were written outside the window', { skip }, async () => {
  const snap = await hub.api('/sessions/s_scene');
  assert.ok(snap.window?.hasEarlier, 'a windowed snapshot');
  assert.ok(snap.events.length <= WINDOW + 5, `${snap.events.length} events came`);
  const held = snap.events.filter((e) => e.type === 'tool_use' && /html$/.test(e.input?.path || '')).map((e) => e.input.path);
  assert.deepEqual(held, ['/site/old.html', '/site/new.html'], 'only the late edit and the new page are in the window; other.html and the first two versions of old.html are not');
});

test('the panel lists every page, the old ones too, and each page has all its versions', { skip }, async () => {
  await open();
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('.panel .artifact-pick')`, { timeout: 8000 });
  // the list of pages is asked for after the window is drawn
  await b.waitFor(`document.querySelector('.panel .tab-count')?.textContent === '3'`, { timeout: 8000, label: 'three pages' });
  const items = await pickItems();
  for (const want of ['/site/old.html', '/site/other.html', '/site/new.html']) assert.ok(items.some((t) => t.includes(want)), `${want} is listed (${JSON.stringify(items)})`);
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
});

test('an old page opens to its latest version even though the Write it grew from is outside the window; earlier versions step back to it', { skip }, async () => {
  await open();
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('.panel .tab-count')?.textContent === '3'`, { timeout: 8000, label: 'three pages' });
  await choose('/site/old.html');
  assert.equal(await label(), '3/3', 'three versions: the Write, the Edit, the late Edit');
  await b.waitFor(`(() => { const f = [...document.querySelectorAll('.artifact-frame')].find((x) => !x.classList.contains('back')); return f && f.srcdoc.includes('第三版'); })()`, { timeout: 8000, label: 'latest version shown' });
  let html = await shown();
  for (const s of scene.expected['old.html'].contains) assert.ok(html.includes(s), `latest version has ${s}`);
  for (const s of scene.expected['old.html'].lacks) assert.ok(!html.includes(s), `and not ${s}`);
  // one step back: the Edit that is also out of the window
  await b.click('.panel .versions button[title="上一版"]');
  await b.waitFor(`(() => { const f = [...document.querySelectorAll('.artifact-frame')].find((x) => !x.classList.contains('back')); return f && f.srcdoc.includes('第二版'); })()`, { timeout: 8000, label: 'version 2' });
  assert.equal(await label(), '2/3');
  await b.click('.panel .versions button[title="上一版"]');
  await b.waitFor(`(() => { const f = [...document.querySelectorAll('.artifact-frame')].find((x) => !x.classList.contains('back')); return f && f.srcdoc.includes('第一版'); })()`, { timeout: 8000, label: 'version 1' });
  assert.equal(await label(), '1/3');
  html = await shown();
  assert.ok(html.includes('舊頁面'), 'the first version is the page as first written');
});

test('a page that only exists outside the window opens from the Hub, with its own title', { skip }, async () => {
  await open();
  await b.click('button[title^="面板"]');
  await b.waitFor(`document.querySelector('.panel .tab-count')?.textContent === '3'`, { timeout: 8000, label: 'three pages' });
  await choose('/site/other.html');
  await b.waitFor(`(() => { const f = [...document.querySelectorAll('.artifact-frame')].find((x) => !x.classList.contains('back')); return f && f.srcdoc.includes('只寫過一次'); })()`, { timeout: 8000, label: 'other.html shown' });
  assert.equal(await b.eval(`document.querySelector('.panel .artifact-name, .panel .artifact-pick span')?.textContent`), '其他頁', 'the title of the page, not its file name');
});

test('the card in the conversation counts versions from the first, not from what the window holds', { skip }, async () => {
  await open();
  await b.waitFor(`document.querySelector('.transcript .artifact-card')`, { timeout: 8000 });
  await b.waitFor(`[...document.querySelectorAll('.transcript .artifact-card-sub')].some((e) => /第 3 版/.test(e.textContent))`, { timeout: 8000, label: 'card says 第 3 版' });
});

test('opening a conversation does not open the panel by itself for the old pages', { skip }, async () => {
  await open();
  await sleep(800);
  assert.equal(await b.eval(`document.querySelector('.panel')?.hidden ?? true`), true, 'the panel stays closed: pages found in older messages are not news');
});

test('a copy that arrives whole (a Hub that does not window) keeps the pages of the part the page holds aside', { skip }, async () => {
  const long = artifactScene({ padding: 120 });
  await b.goto(`${hub.url}#/`, 300);
  await b.waitFor(`document.querySelector('.sidebar')`);
  const r = await b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const t = new Transcript({ cwd: '/site' });
    t.load(${JSON.stringify(long.events)});
    const out = { held: t.order.length, aside: t.reserve.length, pages: t.artifacts().map((a) => [a.path, a.versions.length, Boolean(a.partial)]) };
    t.destroy();
    return out;
  })()`);
  assert.ok(r.aside > 100 && r.held <= 240, `most of the conversation is held aside (${r.held} held, ${r.aside} aside)`);
  assert.deepEqual(r.pages, [['/site/old.html', 3, false], ['/site/other.html', 1, false], ['/site/new.html', 1, false]], 'all three pages, with all versions, nothing left to ask the Hub for');
});
