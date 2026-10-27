// /usage (/cost) and the figures about a conversation come from the Hub's own
// totals (summary.usage, meta.claudeUsage), never from adding up the events the
// page holds: with a window the page holds only the newest part, so a sum would
// be a fraction of the truth. A Claude conversation whose older turns carry the
// bulk of the cost; real Hub (it windows), real front end.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, seedSession, uiSession } from './browser-harness.mjs';
import { maker, WINDOW_ENV } from './fixtures/window-scenes.mjs';

const skip = skipReason();
let ui;
let b;

// 40 turns, each 0.5 dollars: 20 in all, of which the window holds the last two (1.00).
function costly() {
  const m = maker('u');
  const events = [];
  for (let i = 0; i < 40; i++) events.push(m.user(`問題 ${i}`), m.text(`回答 ${i}`), { ...m.end(), usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.5 } });
  return seedSession({
    id: 's_cost',
    title: '花很多錢的對話',
    agentId: 'claude',
    provider: 'claude',
    cwd: '/work/cost',
    usage: { inputTokens: 40_000, outputTokens: 20_000, costUsd: 20 },
    meta: { model: 'claude-opus-5-5', claudeUsage: { requests: 40, input: 40_000, output: 20_000, cacheRead: 0, cacheWrite: 0, searches: 0 }, budget: 25 },
    events,
  });
}

before(async () => {
  if (skip) return;
  ui = await uiSession([costly()]);
  // the window is the newest two turns
  b = ui.b;
});
after(() => ui?.stop());

const run = async (command) => {
  await b.eval(`(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); ta.value = ${JSON.stringify(command)}; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.sleep(200);
  await b.eval(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
};

test('the Hub windows this conversation, and the summary holds the whole conversation\'s totals', { skip }, async () => {
  const snap = await ui.hub.api('/sessions/s_cost');
  assert.ok(snap.window.hasEarlier, 'a windowed snapshot');
  const held = snap.events.filter((e) => e.type === 'turn_end').reduce((n, e) => n + e.usage.costUsd, 0);
  assert.ok(held > 0 && held < 5, `the window holds ${held} dollars of it`);
  assert.equal(snap.usage.costUsd, 20);
  const list = await ui.hub.api('/sessions');
  assert.equal(list.find((s) => s.id === 's_cost').usage.costUsd, 20, 'and so does the list');
});

test('/usage shows the conversation\'s own totals, not what the events held add up to', { skip }, async () => {
  await ui.openApp('#/s/s_cost');
  await b.waitFor(`document.querySelector('.composer textarea')`);
  await run('/usage');
  await b.waitFor(`document.querySelector('.dialog .kv')`, { timeout: 8000, label: 'the usage dialog' });
  const rows = await b.eval(`Object.fromEntries([...document.querySelectorAll('.dialog .kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]))`);
  assert.equal(rows['這個對話'], '約 US$20.00');
  assert.equal(rows['API 請求'], '40 次');
  assert.equal(rows['輸入'], '40.0k tokens');
  assert.equal(rows['輸出'], '20.0k tokens（含思考）');
});
