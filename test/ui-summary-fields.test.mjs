// What the page does with the summary fields the server adds for the unified
// models: handoff.notes (what a switch changed, e.g. a stricter permission),
// turn*/next* (this turn / the next turn), and an unreported permission. The
// Hub in this tree is shown a summary that carries them: the page's list
// request and its socket frames are rewritten in the browser, so what is
// checked is the page's own reading of the fields.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, skipReason, startHub } from './browser-harness.mjs';
import { fixtureSessions } from './ui-fixtures.mjs';

const skip = skipReason();
let hub;
before(async () => {
  if (skip) return;
  hub = await startHub(fixtureSessions());
});
after(() => hub?.stop());

// A browser whose view of the summaries (list + socket) has `patches[id]` merged in.
async function pageWith(patches, { list = true } = {}) {
  const page = await launchBrowser();
  await page.beforeLoad(`(() => {
    const patches = ${JSON.stringify(patches)};
    const real = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const res = await real(url, init);
      if (${list} && String(url) === '/api/sessions' && !(init && init.method && init.method !== 'GET')) {
        const list = await res.clone().json();
        for (const s of list) if (patches[s.id]) Object.assign(s, patches[s.id]);
        return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return res;
    };
    // The server sends frames that are ready within the same 16 ms as one
    // {t:'batch', items:[...]}: a snapshot and the summary that follows it
    // usually come that way (opening a conversation refreshes its subagent
    // policy), so the frames inside a batch are patched like the single ones.
    const patchFrame = (r) => {
      if (!r) return r;
      if (r.t === 'batch' && Array.isArray(r.items)) {
        for (const x of r.items) patchFrame(x);
        return r;
      }
      const s = r.session;
      if ((r.t === 'snapshot' || r.t === 'session') && s && patches[s.id]) Object.assign(s, patches[s.id]);
      return r;
    };
    const parse = JSON.parse.bind(JSON);
    JSON.parse = (text, reviver) => patchFrame(parse(text, reviver));
  })()`);
  return page;
}

test('summary.handoff.notes is said in the conversation, once dismissed it stays away, and other conversations show nothing', { skip }, async () => {
  const notes = ['權限「自動接受編輯」在 DeepSeek 沒有對應，已改為「需要時詢問」（更嚴）'];
  const page = await pageWith({ s_ds: { handoff: { fromProvider: 'claude', chainStartProvider: 'kimi', chainProviders: ['kimi', 'claude', 'deepseek'], targetProvider: 'deepseek', notes } } });
  try {
    await page.goto(hub.url + '#/s/s_ds', 500);
    await page.waitFor(`document.querySelector('.handoff-note')`);
    const text = await page.eval(`document.querySelector('.handoff-note').innerText`);
    assert.ok(text.includes(notes[0]), 'the server\'s note is shown as it is');
    assert.match(text, /Kimi → Claude → DeepSeek/, 'with the path the history came by');
    // the next snapshot/summary keeps it
    await page.sleep(800);
    assert.ok(await page.eval(`!!document.querySelector('.handoff-note')`), 'still there after the snapshot arrived');
    await page.eval(`document.querySelector('.handoff-note .linklike').click()`);
    assert.equal(await page.eval(`document.querySelector('.handoff-note')`), null);
    await page.goto(hub.url + '#/s/s_claude', 500);
    await page.waitFor(`document.querySelector('.composer')`);
    assert.equal(await page.eval(`document.querySelector('.handoff-note')`), null, 'a conversation without notes shows none');
  } finally {
    await page.close();
  }
});

test('handoff.notes that only the conversation\'s own snapshot carries (not the list) appear when it arrives', { skip }, async () => {
  const notes = ['權限已改為更嚴的模式'];
  const page = await pageWith({ s_ds: { handoff: { fromProvider: 'claude', targetProvider: 'deepseek', notes } } }, { list: false });
  try {
    await page.goto(hub.url + '#/s/s_ds', 300);
    await page.waitFor(`document.querySelector('.handoff-note')`);
    assert.ok((await page.eval(`document.querySelector('.handoff-note').innerText`)).includes(notes[0]));
  } finally {
    await page.close();
  }
});

test('turn*/next*: a running conversation names this turn\'s provider and the next one\'s; with no snapshot yet nothing is shown as different', { skip }, async () => {
  const running = { status: 'running', provider: 'kimi', nextProvider: 'deepseek', nextModel: 'agent-hub-deepseek/deepseek-v4.1-flash', nextEffort: 'max', nextSubagent: null, turnModel: null, turnEffort: null, turnSubagent: null };
  const tag = (page) => page.eval(`[...document.querySelectorAll('.side-row')].find((r) => r.innerText.includes('K to D idle switch'))?.querySelector('.row-tag')?.innerText`);
  let page = await pageWith({ s_swap: { ...running, turnProvider: 'kimi' } });
  try {
    await page.goto(hub.url + '#/', 600);
    await page.waitFor(`document.querySelectorAll('.side-row').length >= 4`);
    assert.equal(await tag(page), '本回合 Kimi／下一回合 DeepSeek');
  } finally {
    await page.close();
  }
  page = await pageWith({ s_swap: { ...running, turnProvider: null } });
  try {
    await page.goto(hub.url + '#/', 600);
    await page.waitFor(`document.querySelectorAll('.side-row').length >= 4`);
    assert.equal(await tag(page), 'DeepSeek', 'no snapshot: the next turn\'s values stand in');
  } finally {
    await page.close();
  }
});

test('a permission the server did not report is not guessed from the Hub\'s own mode, and a reported one is shown as given', { skip }, async () => {
  // permissionMode 'auto_edits' used to be turned into "全部自動" / "自動接受編輯" by the page.
  const page = await pageWith({ s_ds: { permissionMode: 'auto_edits' }, s_claude: { permissionMode: 'bypass', meta: { permission: 'edits' } } });
  try {
    await page.goto(hub.url + '#/s/s_ds', 500);
    await page.waitFor(`document.querySelector('[data-control="permission"]')`);
    assert.equal(await page.eval(`document.querySelector('[data-control="permission"]').innerText.trim()`), '權限（未回報）');
    await page.goto(hub.url + '#/s/s_claude', 500);
    await page.waitFor(`document.querySelector('[data-control="permission"]')`);
    assert.equal(await page.eval(`document.querySelector('[data-control="permission"]').innerText.trim()`), '自動接受編輯');
  } finally {
    await page.close();
  }
});
