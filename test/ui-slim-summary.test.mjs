// The Hub sends a page the whole summary of the conversation that is open and a
// listed one (no model/skill lists, queue or to-do list) of the others - but a
// listed summary that reaches the open conversation anyway (a message queued a
// moment before the page opened it) must never replace what the page shows.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, uiSession, seedSession } from './browser-harness.mjs';
import { FAKE_SCRIPT } from './fixtures/cluster-fake.mjs';

const skip = skipReason();
const now = Date.now();
const main = (id, title) => seedSession({ id, title, agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `k_${id}`, provider: 'kimi', cwd: '/proj', updatedAt: now - 1000, meta: { machineName: 'box' }, events: [{ id: `${id}e`, ts: now - 5000, type: 'user', text: 'hi' }] });

let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession([main('s_main1', '主對話一')], { claude: false });
  b = ui.b;
  await b.beforeLoad(FAKE_SCRIPT);
  await b.beforeLoad(`window.__fake = { online: true, clusters: {}, parents: {}, timing: {}, memory: {}, list: [] };`);
});
after(() => ui?.stop());

test('a listed summary never replaces what the open conversation shows, while the whole one does (the Hub sends the open conversation only whole ones)', { skip }, async () => {
  await ui.openApp('#/s/s_main1');
  await b.waitFor(`document.querySelector('.composer-input')`);
  const spinner = () => b.eval(`Boolean([...document.querySelectorAll('.side-row')].find((r) => r.getAttribute('href') === '#/s/s_main1')?.querySelector('.spinner'))`);
  assert.equal(await spinner(), false);
  await b.eval(`(async () => { const s = await (await fetch('/api/sessions/s_main1')).json(); window.__emit({ t: 'session', session: { ...s, status: 'running', slim: true, meta: {} } }); })()`);
  await b.sleep(300);
  assert.equal(await spinner(), false, 'a listed summary of the open conversation is ignored');
  await b.eval(`(async () => { const s = await (await fetch('/api/sessions/s_main1')).json(); window.__emit({ t: 'session', session: { ...s, status: 'running' } }); })()`);
  await b.waitFor(`[...document.querySelectorAll('.side-row')].find((r) => r.getAttribute('href') === '#/s/s_main1')?.querySelector('.spinner')`);
});
