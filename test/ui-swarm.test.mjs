// Swarm mode in the page, in a real browser: /swarm is in the slash menu of a
// Kimi and a DeepSeek conversation (not a Claude one, which has no such mode),
// turning it on shows a chip that says so and turns it off when pressed, the
// permission menu has the same switch, /swarm off and /swarm <task> do what
// they say, and the home screen (no conversation yet) has none of it.
//
// The page answers the config call itself (the harness has no computer
// connected), so what is checked is what the page sends and shows. Skips,
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

const configPosts = async (id) => (await ui.calls()).filter((c) => c.method === 'POST' && c.url === `/api/sessions/${id}/config`);
const messagePosts = async (id) => (await ui.calls()).filter((c) => c.method === 'POST' && c.url === `/api/sessions/${id}/messages`);
// What the Hub answers a config call with: the conversation's summary, swarm mode as asked.
async function answerConfig(id, swarmMode, meta = {}) {
  const summary = (await ui.hub.api('/sessions')).find((x) => x.id === id);
  await ui.stopAnswering();
  await ui.answer('POST', `/api/sessions/${id}/config`, 200, { ...summary, meta: { ...summary.meta, ...meta, swarmMode } });
  await ui.answer('POST', `/api/sessions/${id}/messages`, 200, { ok: true });
}
const chip = () => b.eval(`(() => { const c = document.querySelector('[data-control="swarm"]'); return c ? { text: c.innerText.trim(), title: c.title, pressed: c.getAttribute('aria-pressed') } : null; })()`);
const openPermissionMenu = async () => {
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
  await b.waitFor(`document.querySelector('[data-control="permission"]')`);
  await b.click('[data-control="permission"]');
  await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
  return b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].map((i) => ({ label: i.innerText.replace(/[✓\\s]+/g, ' ').trim(), checked: i.getAttribute('aria-checked') === 'true' }))`);
};
const pressMenu = (label) => b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((i) => i.innerText.includes(${JSON.stringify(label)}))?.click()`);
// Type into the message box and press Enter, as a person does.
async function typeAndEnter(text) {
  await b.eval(`(() => {
    const t = document.querySelector('.composer-input');
    t.focus();
    t.value = ${JSON.stringify(text)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await b.eval(`document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
}
const slashItems = async () => {
  await b.eval(`(() => { const t = document.querySelector('.composer-input'); t.focus(); t.value = '/swar'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 200));
  // `desc` is what the row's tooltip says in full (the row itself cuts a long description short).
  return b.eval(`[...document.querySelectorAll('.slash-menu .slash-item')].map((i) => ({ name: i.querySelector('.slash-name')?.innerText.trim(), desc: i.title }))`);
};
const clearInput = () => b.eval(`(() => { const t = document.querySelector('.composer-input'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

for (const [title, id] of [['Kimi', 's_kimi'], ['DeepSeek', 's_ds']]) {
  test(`${title}: /swarm is in the slash menu, the permission menu has the switch, and turning it on shows a chip that turns it off`, { skip }, async () => {
    await ui.openApp(`#/s/${id}`);
    await b.waitFor(`document.querySelector('.composer-input')`);
    await ui.clearCalls();

    const items = await slashItems();
    const swarm = items.find((i) => i.name?.startsWith('/swarm'));
    assert.ok(swarm, `/swarm is offered: ${JSON.stringify(items)}`);
    assert.match(swarm.name, /on \| off/, 'with what it takes');
    assert.match(swarm.desc, /swarm 模式/);
    assert.match(swarm.desc, /子代理群/);
    assert.match(swarm.desc, /之後保持開啟/, 'the description says a task leaves it on');
    await clearInput();

    assert.equal(await chip(), null, 'nothing shows while it is off');
    const menu = await openPermissionMenu();
    const entry = menu.find((m) => m.label.startsWith('Swarm 模式'));
    assert.ok(entry, `the permission menu has the switch: ${JSON.stringify(menu)}`);
    assert.equal(entry.checked, false);

    // Turn it on from the menu.
    await answerConfig(id, true);
    await pressMenu('Swarm 模式');
    await b.waitFor(`document.querySelector('[data-control="swarm"]')`);
    assert.deepEqual((await configPosts(id)).map((c) => c.body), [{ swarmMode: true }], 'it asked for swarm mode and nothing else');
    const on = await chip();
    assert.match(on.text, /Swarm/);
    assert.equal(on.pressed, 'true');
    assert.match(on.title, /點一下關閉/);
    assert.ok(await b.waitFor(`document.body.innerText.includes('Swarm 模式已開啟')`), 'and says what it costs');
    assert.match(await b.eval(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' ')`), /每次詢問.*子代理可能停下來等你核准/, 'and that approvals may stop the subagents (this conversation asks every time)');
    assert.equal((await openPermissionMenu()).find((m) => m.label.startsWith('Swarm 模式')).checked, true, 'the menu shows it ticked');
    await b.eval(`document.querySelector('.om-menu')?.remove()`);

    // Press the chip: off.
    await ui.clearCalls();
    await answerConfig(id, false);
    await b.click('[data-control="swarm"]');
    await b.waitFor(`!document.querySelector('[data-control="swarm"]')`);
    assert.deepEqual((await configPosts(id)).map((c) => c.body), [{ swarmMode: false }]);
  });
}

test('/swarm switches it; /swarm on and /swarm off are the same as saying so; saying what it already is only says so', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await ui.clearCalls();

  await answerConfig('s_kimi', true);
  await typeAndEnter('/swarm');
  await b.waitFor(`document.querySelector('[data-control="swarm"]')`);
  assert.deepEqual((await configPosts('s_kimi')).map((c) => c.body), [{ swarmMode: true }], 'nothing typed after it: switched on');
  assert.equal((await messagePosts('s_kimi')).length, 0, 'and /swarm itself is never sent to the model as a message');

  await ui.clearCalls();
  await typeAndEnter('/swarm on');
  await b.waitFor(`document.body.innerText.includes('Swarm 模式已經是開的')`);
  assert.equal((await configPosts('s_kimi')).length, 0, 'already on: nothing is sent');

  await answerConfig('s_kimi', false);
  await typeAndEnter('/swarm off');
  await b.waitFor(`!document.querySelector('[data-control="swarm"]')`);
  assert.deepEqual((await configPosts('s_kimi')).map((c) => c.body), [{ swarmMode: false }]);

  await ui.clearCalls();
  await typeAndEnter('/swarm off');
  await b.waitFor(`document.body.innerText.includes('Swarm 模式已經是關的')`);
  assert.equal((await configPosts('s_kimi')).length, 0, 'already off: nothing is sent');
});

test('/swarm <task> turns it on and then sends the task as an ordinary message; with it already on, only the task is sent', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await ui.clearCalls();

  await answerConfig('s_kimi', true, { permission: 'auto' });
  await typeAndEnter('/swarm 把每個套件都掃一遍');
  await b.waitFor(`window.__calls.some((c) => /\\/messages$/.test(c.url))`);
  const calls = (await ui.calls()).filter((c) => /\/(config|messages)$/.test(c.url));
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['config', 'messages'], 'on first, then the task');
  assert.deepEqual(calls[0].body, { swarmMode: true });
  assert.equal(calls[1].body.text, '把每個套件都掃一遍', 'the task, without /swarm');
  assert.ok(await chip(), 'and it stays on');
  const toasts = await b.eval(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' ')`);
  assert.match(toasts, /Swarm 模式已開啟/, 'it said it was turned on');
  assert.doesNotMatch(toasts, /每次詢問/, 'no approval warning when approvals are not "ask every time"');

  await ui.clearCalls();
  await typeAndEnter('/swarm 再來一個任務');
  await b.waitFor(`window.__calls.some((c) => /\\/messages$/.test(c.url))`);
  const again = (await ui.calls()).filter((c) => /\/(config|messages)$/.test(c.url));
  assert.deepEqual(again.map((c) => c.url.split('/').pop()), ['messages'], 'already on: just the task');
  assert.equal(again[0].body.text, '再來一個任務');

  // Leave it as the next test found it.
  await answerConfig('s_kimi', false);
  await b.click('[data-control="swarm"]');
  await b.waitFor(`!document.querySelector('[data-control="swarm"]')`);
});

test('if turning it on fails, the task is NOT sent and the chip does not appear', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await ui.clearCalls();
  await ui.stopAnswering();
  await ui.answer('POST', '/api/sessions/s_kimi/config', 502, { error: '這台電腦的 Kimi 沒有 swarm 模式' });
  await typeAndEnter('/swarm 不會送出的任務');
  await b.waitFor(`document.body.innerText.includes('這台電腦的 Kimi 沒有 swarm 模式')`);
  assert.equal((await messagePosts('s_kimi')).length, 0, 'the task never went out');
  assert.equal(await chip(), null);
  await ui.stopAnswering();
});

test('a conversation that is already in swarm mode (Kimi says so) shows the chip when opened', { skip }, async () => {
  // Kimi turned it on (the terminal, another client): the Hub's record says so.
  await ui.stopAnswering();
  const { data } = ui.hub;
  const file = `${data}/sessions/s_ds.json`;
  const fs = await import('node:fs');
  const saved = fs.readFileSync(file, 'utf8');
  try {
    const j = JSON.parse(saved);
    j.meta = { ...j.meta, swarmMode: true };
    fs.writeFileSync(file, JSON.stringify(j));
    await ui.hub.restart();
    await ui.openApp('#/s/s_ds');
    await b.waitFor(`document.querySelector('[data-control="swarm"]')`);
    assert.match((await chip()).text, /Swarm/);
  } finally {
    fs.writeFileSync(file, saved);
    await ui.hub.restart();
  }
});

test('a Claude conversation has no /swarm and no switch', { skip }, async () => {
  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.deepEqual((await slashItems()).filter((i) => /swarm/i.test(i.name || '')), [], 'not in the slash menu');
  await clearInput();
  const menu = await openPermissionMenu();
  assert.ok(!menu.some((m) => /Swarm/.test(m.label)), `not in the permission menu: ${JSON.stringify(menu)}`);
  assert.equal(await chip(), null);
  await b.eval(`document.querySelector('.om-menu')?.remove()`);
});

test('the home screen (no conversation yet) has no swarm switch, whichever provider it is set to', { skip }, async () => {
  for (const provider of ['kimi', 'deepseek', 'claude']) {
    await ui.openApp('#/');
    await b.eval(`localStorage.setItem('hubHome', JSON.stringify({ provider: ${JSON.stringify(provider)} }))`);
    await ui.openApp('#/');
    await b.waitFor(`document.querySelector('.composer-input')`);
    const r = await b.eval(`(async () => {
      const t = document.querySelector('.composer-input');
      t.focus(); t.value = '/swar'; t.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const slash = [...document.querySelectorAll('.slash-menu .slash-item')].map((i) => i.innerText);
      t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true }));
      return { slash, chip: Boolean(document.querySelector('[data-control="swarm"]')) };
    })()`);
    assert.deepEqual(r.slash.filter((x) => /swarm/i.test(x)), [], `${provider}: not in the home slash menu`);
    assert.equal(r.chip, false);
    const menu = await openPermissionMenu();
    // The premise: the home screen really is that provider's (Claude's permissions are not Kimi's).
    assert.equal(menu.some((m) => /自動接受編輯/.test(m.label)), provider === 'claude', `${provider}: the home composer is the one for ${provider}: ${JSON.stringify(menu)}`);
    assert.equal(menu.some((m) => /需要時詢問/.test(m.label)), provider !== 'claude', `${provider}: the home composer is the one for ${provider}`);
    assert.ok(!menu.some((m) => /Swarm/.test(m.label)), `${provider}: not in the home permission menu either`);
    await b.eval(`document.querySelector('.om-menu')?.remove()`);
  }
  await b.eval(`localStorage.removeItem('hubHome')`);
});
