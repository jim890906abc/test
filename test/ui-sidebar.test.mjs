// The sidebar in a real browser (spec §14): what is listed where, which
// provider a row names, the folded 子session group and its saved state, and
// the hint on a parent whose subagent waits for approval.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, skipReason, uiSession } from './browser-harness.mjs';
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

const sideRows = () => b.eval(`[...document.querySelectorAll('.side-row')].map((r) => ({ title: r.querySelector('.row-title').innerText, tag: r.querySelector('.row-tag')?.innerText ?? null }))`);
const groupHeads = () => b.eval(`[...document.querySelectorAll('.side-group-head')].map((h) => ({ label: h.querySelector('.side-group-name').innerText, count: h.querySelector('.side-group-count').innerText, open: h.getAttribute('aria-expanded'), tag: h.tagName }))`);
const saved = () => b.eval(`localStorage.getItem('hubSideSections')`);
const search = (text) => b.eval(`(() => { const i = document.querySelector('.side-search input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);

test('spec §14: three providers sit under 聊天室, terminal sessions under a folded 子session, subagent children nowhere', { skip }, async () => {
  await b.goto(ui.hub.url + '#/', 300);
  await b.eval(`localStorage.removeItem('hubSideSections')`);
  await ui.openApp('#/');
  await b.waitFor(`document.querySelectorAll('.side-row').length >= 4`);
  assert.deepEqual(await groupHeads(), [
    { label: '聊天室', count: '4', open: 'true', tag: 'BUTTON' },
    { label: '子session', count: '1', open: 'false', tag: 'BUTTON' },
  ]);
  const rows = await sideRows();
  assert.deepEqual(rows.map((r) => [r.title, r.tag]), [
    ['Kimi chat with subagents', 'Kimi'],
    ['Claude chat', 'Claude'],
    ['DeepSeek chat', 'DeepSeek'],
    ['K to D idle switch', 'DeepSeek'], // idle after a K→D switch: the NEXT turn's provider, not the earlier turn's Kimi
  ]);
  assert.ok(!rows.some((r) => /Hidden broker child/.test(r.title)), 'a subagent child has no row');
});

test('子session fold state is saved; a search opens it only for the moment', { skip }, async () => {
  await ui.openApp('#/');
  await b.waitFor(`document.querySelectorAll('.side-row').length >= 4`);
  assert.equal(await saved(), null, 'nothing saved yet');

  // A search opens the folded group, writes nothing, and hides nothing it should show.
  await search('terminal');
  await b.waitFor(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('Terminal session'))`);
  assert.equal(await saved(), null, 'searching did not write the fold state');
  assert.deepEqual((await groupHeads()).map((g) => [g.label, g.open, g.tag]), [['子session', 'true', 'DIV']]);
  // The child never turns up, even when searched for by name.
  await search('hidden broker');
  await b.waitFor(`document.querySelector('.side-empty')`);
  assert.deepEqual(await sideRows(), []);
  await search('');
  await b.waitFor(`document.querySelectorAll('.side-row').length === 4`);
  assert.equal((await groupHeads())[1].open, 'false', 'back to the saved (folded) state');

  // Unfolding is saved, and survives a reload.
  await b.click(`.side-group-head[title*="子session"]`);
  await b.waitFor(`[...document.querySelectorAll('.side-row')].some((r) => r.innerText.includes('Terminal session'))`);
  assert.deepEqual(JSON.parse(await saved()), { chat: true, sub: true });
  await ui.openApp('#/');
  await b.waitFor(`document.querySelectorAll('.side-row').length === 5`);
  assert.equal((await groupHeads())[1].open, 'true');
  // Opening a terminal session from here does not move it to 聊天室.
  await ui.openApp('#/s/s_ext');
  await b.waitFor(`document.querySelectorAll('.side-row').length === 5`);
  assert.deepEqual((await groupHeads()).map((g) => g.count), ['4', '1']);
  await b.eval(`localStorage.removeItem('hubSideSections')`);
});

test('opening a subagent child by its address explains it and leads to its parent', { skip }, async () => {
  await ui.openApp('#/s/s_child');
  await b.waitFor(`document.querySelector('.child-note')`);
  assert.match(await ui.textOf('.child-note'), /這是子代理對話[\s\S]*Kimi chat with subagents/);
});

test('a parent whose subagent waits for approval says so on its row (summary.pendingChildPermission)', { skip }, async () => {
  // The server is to put the flag on the summary; here the page is shown a list
  // in which one conversation carries it.
  const page = await launchBrowser();
  try {
    await page.beforeLoad(`(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        const res = await real(url, init);
        if (String(url).split('?')[0] === '/api/sessions' && !(init && init.method && init.method !== 'GET')) {
          const list = await res.clone().json();
          for (const s of list) if (s.id === 's_claude') s.pendingChildPermission = true;
          return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return res;
      };
    })()`);
    await page.goto(ui.hub.url + '#/', 400);
    await page.waitFor(`document.querySelectorAll('.side-row').length >= 4`);
    const rows = await page.eval(`[...document.querySelectorAll('.side-row')].map((r) => [r.querySelector('.row-title').innerText, r.querySelector('.child-waiting')?.innerText ?? null])`);
    assert.deepEqual(rows.find((r) => r[0] === 'Claude chat'), ['Claude chat', '子代理需要你']);
    assert.equal(rows.filter((r) => r[1]).length, 1, 'only the flagged one');
  } finally {
    await page.close();
  }
});
