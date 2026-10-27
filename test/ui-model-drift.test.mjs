// In a real browser: a conversation recorded on DeepSeek whose native Kimi
// reports a Kimi model says so next to the message box and in the sidebar, and
// the button puts the choice back (POST /provider with force); the nudge from
// 80% of the context appears once and stays away once put away. The Hub is the
// real one, with the conversations on disk; the server's summarize() produces
// the drift, so what is checked is the page's reading of the real fields.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, seedSession, skipReason, startHub } from './browser-harness.mjs';
import { fixtureSessions, DS_FLASH } from './ui-fixtures.mjs';

const skip = skipReason();
const K3 = 'kimi-code/k3.1-pro';
const now = Date.now();
const ev = (id, type, text, ts) => ({ id, ts, type, ...(type === 'text' ? { agentId: 'main' } : {}), text });
const kimiish = (id, title, patch) => seedSession({
  id, title, agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `k_${id}`, cwd: '/tmp/d', updatedAt: now - 5000,
  events: [ev(`${id}_u`, 'user', 'hi', now - 9000), ev(`${id}_a`, 'text', 'hello', now - 8000)], ...patch,
});
let hub;
before(async () => {
  if (skip) return;
  hub = await startHub([
    ...fixtureSessions(),
    // the 10-27 case: recorded on DeepSeek by the user, the native runs Kimi K3.1 Pro
    kimiish('s_drift', 'Drifted DeepSeek chat', {
      provider: 'deepseek', mode: 'deepseek', modelConfig: { provider: 'deepseek', model: DS_FLASH, effort: 'max' },
      state: { defaultsApplied: true, userSet: { model: true, effort: true } }, meta: { model: K3, effort: 'max' },
    }),
    kimiish('s_ctx', 'Nearly full', { provider: 'kimi', modelConfig: { provider: 'kimi', model: 'kimi-k2', effort: '' }, meta: { model: 'kimi-k2', context: { used: 820000, size: 1000000 } } }),
    kimiish('s_ctx_low', 'Plenty of room', { provider: 'kimi', modelConfig: { provider: 'kimi', model: 'kimi-k2', effort: '' }, meta: { model: 'kimi-k2', context: { used: 300000, size: 1000000 } } }),
    seedSession({ id: 's_ctx_claude', title: 'Claude full', agentId: 'claude', provider: 'claude', cwd: '/tmp/c', updatedAt: now - 6000, meta: { model: 'claude-opus-5', context: { used: 900000, size: 1000000 } }, events: [ev('cc1', 'user', 'hi', now - 9000)] }),
  ]);
});
after(() => hub?.stop());

// Record the page's POSTs; answer the provider switch with the conversation as
// the server would have it after the native took the change.
const recordPosts = `(() => {
  window.__posts = [];
  const real = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (init && init.method === 'POST') window.__posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (init && init.method === 'POST' && /\\/api\\/sessions\\/s_drift\\/provider$/.test(String(url))) {
      const s = await (await real('/api/sessions/s_drift')).json();
      return new Response(JSON.stringify({ ...s, modelDrift: null, nativeModel: s.modelConfig.model, meta: { ...s.meta, model: s.modelConfig.model } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
})()`;

test('a drifted conversation names what runs, says it is not what was chosen, and the button asks for the choice back with force', { skip }, async () => {
  const page = await launchBrowser();
  try {
    await page.beforeLoad(recordPosts);
    await page.goto(hub.url + '#/s/s_drift', 600);
    await page.waitFor(`document.querySelector('[data-control="model-drift"]')`);
    const warn = await page.eval(`document.querySelector('[data-control="model-drift"]').innerText`);
    assert.match(warn, /實際：Kimi/, 'what really runs');
    assert.match(warn, /與你選的 DeepSeek V4\.1 Flash 不同/, 'that it is not the choice');
    const button = await page.eval(`document.querySelector('[data-control="model-restore"]').innerText.trim()`);
    assert.equal(button, '改回 DeepSeek V4.1 Flash');
    await page.eval(`document.querySelector('[data-control="model-restore"]').click()`);
    await page.waitFor(`window.__posts.some((p) => /\\/provider$/.test(p.url))`);
    const body = await page.eval(`window.__posts.find((p) => /\\/provider$/.test(p.url)).body`);
    assert.deepEqual(body, { provider: 'deepseek', model: DS_FLASH, effort: 'max', force: true }, 'the choice, with force');
    // the server's answer carries no drift: the notice goes away
    await page.waitFor(`!document.querySelector('[data-control="model-drift"]')`);
  } finally {
    await page.close();
  }
});

test('the sidebar names the provider that really runs; a conversation without drift is as it was; an old server (no field) shows nothing', { skip }, async () => {
  const page = await launchBrowser();
  try {
    await page.goto(hub.url + '#/', 600);
    await page.waitFor(`document.querySelectorAll('.side-row').length >= 5`);
    const tag = (title) => page.eval(`[...document.querySelectorAll('.side-row')].find((r) => r.querySelector('.row-title')?.innerText === ${JSON.stringify(title)})?.querySelector('.row-tag')?.innerText`);
    assert.equal(await tag('Drifted DeepSeek chat'), '實際 Kimi');
    assert.equal(await tag('DeepSeek chat'), 'DeepSeek');
    await page.goto(hub.url + '#/s/s_ds', 400);
    await page.waitFor(`document.querySelector('[data-control="permission"]')`);
    assert.equal(await page.eval(`document.querySelector('[data-control="model-drift"]')`), null, 'no drift, no notice');
  } finally {
    await page.close();
  }
});

test('page defends against a summary whose modelDrift is half filled', { skip }, async () => {
  const page = await launchBrowser();
  try {
    await page.beforeLoad(`(() => {
      const parse = JSON.parse.bind(JSON);
      const bad = (s) => { if (s && s.id === 's_drift') s.modelDrift = { kind: 'weird', actual: { model: 7 } }; };
      JSON.parse = (text, reviver) => { const r = parse(text, reviver); if (Array.isArray(r)) r.forEach(bad); else if (r && r.session) bad(r.session); else if (r && r.t === 'batch') r.items.forEach((x) => x.session && bad(x.session)); return r; };
    })()`);
    await page.goto(hub.url + '#/s/s_drift', 600);
    await page.waitFor(`document.querySelector('.composer')`);
    assert.equal(await page.eval(`document.querySelector('[data-control="model-restore"]')`), null, 'nothing to go back to: no button');
    assert.ok(await page.eval(`!!document.querySelector('.composer')`), 'and the composer is still there');
  } finally {
    await page.close();
  }
});

test('from 80% of the context one line says replies will slow down; × puts it away for good; below 80% and for Claude there is none', { skip }, async () => {
  const page = await launchBrowser();
  try {
    await page.goto(hub.url + '#/s/s_ctx', 600);
    await page.waitFor(`document.querySelector('.ctx-hint')`);
    assert.equal(await page.eval(`document.querySelector('.ctx-hint__text').innerText`), '上下文已用 82%，接近自動壓縮；回應會變慢，可用 /compact 或開新對話');
    await page.eval(`document.querySelector('.ctx-hint__x').click()`);
    await page.waitFor(`!document.querySelector('.ctx-hint')`);
    assert.ok(JSON.parse(await page.eval(`localStorage.getItem('hub.ctxHint')`)).s_ctx >= 0.8, 'remembered for this conversation');
    await page.goto(hub.url + '#/s/s_ctx_low', 400);
    await page.waitFor(`document.querySelector('.ctx-ring')`);
    assert.equal(await page.eval(`document.querySelector('.ctx-hint')`), null, 'under 80%: nothing');
    await page.goto(hub.url + '#/s/s_ctx_claude', 400);
    await page.waitFor(`document.querySelector('.composer')`);
    assert.equal(await page.eval(`document.querySelector('.ctx-hint')`), null, 'Claude has no such compaction');
    // back to the first one: still put away
    await page.goto(hub.url + '#/s/s_ctx', 400);
    await page.waitFor(`document.querySelector('.ctx-ring')`);
    assert.equal(await page.eval(`document.querySelector('.ctx-hint')`), null);
  } finally {
    await page.close();
  }
});

test('with no usable storage the hint still shows and can still be put away', { skip }, async () => {
  const page = await launchBrowser();
  try {
    await page.beforeLoad(`Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } })`);
    await page.goto(hub.url + '#/s/s_ctx', 600);
    await page.waitFor(`document.querySelector('.ctx-hint')`);
    await page.eval(`document.querySelector('.ctx-hint__x').click()`);
    await page.waitFor(`!document.querySelector('.ctx-hint')`);
  } finally {
    await page.close();
  }
});
