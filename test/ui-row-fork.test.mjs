// 分叉 in a sidebar conversation's … menu, in a real browser: it is there for a
// Claude, a Kimi and a DeepSeek conversation, it asks the Hub for a /fork of
// THAT conversation and opens the copy, a second press while the first is still
// being made does nothing, a refusal is shown and nothing is opened, and a
// conversation on a computer that is off cannot be forked from there.
//
// The page answers the fork itself, so no conversation is really copied. Skips,
// saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession } from './browser-harness.mjs';
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

// The harness has no computer connected, so m1 (the one the Kimi and DeepSeek
// fixtures live on) is made to look online from the page's side.
const machineOnline = (online) =>
  b.beforeLoad(`(() => {
    const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url) === '/api/machines' && !(init?.method && init.method !== 'GET')) {
        return new Response(JSON.stringify([{ id: 'm1', name: 'box', online: ${online}, kimi: { available: ${online} } }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
  })()`);

const rowMore = (title) => `.row-more[aria-label="「${title}」的選項"]`;
const menuItems = () => b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].map((i) => ({ label: i.innerText.trim(), disabled: i.getAttribute('aria-disabled') === 'true' }))`);
const openRowMenu = async (title) => {
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.waitFor(`document.querySelector(${JSON.stringify(rowMore(title))})`);
  await b.click(rowMore(title));
  await b.waitFor(`document.querySelector('.om-menu')`);
};
const pressFork = () => b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.trim() === '分叉')?.click()`);
const forkPosts = async () => (await ui.calls()).filter((c) => c.method === 'POST' && /\/command$/.test(c.url));

test('分叉 is in the … menu of a Claude conversation, right after the name, and forks that conversation and opens the copy', { skip }, async () => {
  await ui.openApp('#/');
  await ui.clearCalls();
  await ui.answer('POST', '/api/sessions/s_claude/command', 200, { session: { id: 's_claude_copy', title: 'Claude chat（複製）', provider: 'claude', agentId: 'claude', status: 'idle' } });
  await openRowMenu('Claude chat');
  const items = await menuItems();
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('分叉'), `菜單裡要有「分叉」：${labels}`);
  assert.equal(labels.indexOf('分叉'), labels.indexOf('重新命名…') + 1, '放在「重新命名…」之後');
  assert.equal(items.find((i) => i.label === '分叉').disabled, false);
  await pressFork();
  await b.waitFor(`location.hash === '#/s/s_claude_copy'`);
  const posts = await forkPosts();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { name: 'fork', args: '' }, '送的是這個對話的 /fork，不帶標題');
  assert.equal(posts[0].url, '/api/sessions/s_claude/command');
});

test('a second press while the fork is still being made does nothing; a refusal is shown and nothing is opened', { skip }, async () => {
  await ui.openApp('#/');
  await ui.clearCalls();
  await ui.stopAnswering();
  await ui.answer('POST', '/api/sessions/s_claude/command', 409, { error: '這個對話現在不能分叉：測試擋下' });
  await openRowMenu('Claude chat');
  // Two presses back to back, before the first answer can come back.
  await b.eval(`(() => {
    const item = [...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.trim() === '分叉');
    item.click();
    item.click();
  })()`);
  await b.waitFor(`document.body.innerText.includes('這個對話現在不能分叉：測試擋下')`);
  assert.equal((await forkPosts()).length, 1, '連按兩次只送一次');
  assert.equal(await b.eval('location.hash'), '#/', '被拒絕時不會跳到任何對話');
  // The lock is released: the same press works again after the refusal.
  await openRowMenu('Claude chat');
  await pressFork();
  await b.waitFor(`window.__calls.filter((c) => /\\/command$/.test(c.url)).length === 2`);
});

test('分叉 on a DeepSeek and a Kimi conversation forks THAT conversation when its computer is on', { skip }, async () => {
  await ui.stopAnswering();
  await machineOnline(true);
  for (const [title, id] of [['DeepSeek chat', 's_ds'], ['Kimi chat with subagents', 's_kimi']]) {
    await ui.openApp('#/');
    await ui.clearCalls();
    await ui.answer('POST', `/api/sessions/${id}/command`, 200, { session: { id: `${id}_copy`, title: `${title} copy`, provider: id === 's_ds' ? 'deepseek' : 'kimi', agentId: 'kimi@m1', machineId: 'm1', status: 'idle' } });
    await openRowMenu(title);
    const item = (await menuItems()).find((i) => i.label === '分叉');
    assert.ok(item, `${title}：菜單裡要有「分叉」`);
    assert.equal(item.disabled, false, `${title}：電腦在線時可按`);
    await pressFork();
    await b.waitFor(`location.hash === '#/s/${id}_copy'`);
    const posts = await forkPosts();
    assert.deepEqual(posts.map((p) => p.url), [`/api/sessions/${id}/command`]);
    assert.deepEqual(posts[0].body, { name: 'fork', args: '' });
  }
});

test('分叉 shows, greyed out, for a Kimi / DeepSeek conversation whose computer is off, and does nothing', { skip }, async () => {
  await ui.stopAnswering();
  await machineOnline(false);
  await ui.openApp('#/');
  await ui.clearCalls();
  await openRowMenu('DeepSeek chat');
  const item = (await menuItems()).find((i) => i.label === '分叉');
  assert.ok(item, '離線時也看得到「分叉」');
  assert.equal(item.disabled, true, '但不能按：分叉要由那台電腦的 Kimi 做');
  await pressFork();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await forkPosts()).length, 0);
});
