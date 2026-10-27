// Subagent cards and the 子代理 panel in a real browser: what ran (requested vs
// actual), whether it is still working (a spinner needs evidence), and that the
// card and the panel say the same thing. The seeded conversations are the ones
// the restore path really leaves behind (see ui-fixtures.mjs).
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedSession, skipReason, uiSession } from './browser-harness.mjs';
import { fixtureSessions, SUB_DEFAULT } from './ui-fixtures.mjs';

const skip = skipReason();

// A conversation stored by the old code: its foreground subagent card says
// "running" although the call that started it came back (done). The Hub's
// restore settles that card itself (the call returned, so the subagent did).
function settledByRestart() {
  const t = Date.now();
  return seedSession({
    id: 's_settled',
    title: 'Settled by the restart',
    agentId: 'claude',
    provider: 'claude',
    cwd: '/tmp/x',
    updatedAt: t - 5000,
    meta: { model: 'claude-opus-5', subagent: null },
    events: [
      { id: 'q1', ts: t - 9000, type: 'user', text: 'go' },
      { id: 'q2', ts: t - 8000, type: 'tool_use', agentId: 'main', name: 'Task', title: 'call that came back', status: 'done', subagent: { id: 'q', name: 'subagent', description: 'call that came back', status: 'running' } },
    ],
  });
}

let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession([...fixtureSessions(), settledByRestart()]);
  b = ui.b;
});
after(() => ui?.stop());

// The head line of every subagent card in the open conversation.
const cardHeads = () =>
  b.eval(`[...document.querySelectorAll('.tool.agent')].map((c) => ({
    text: c.querySelector('.tool-head').innerText.replace(/\\s+/g, ' ').trim(),
    spinner: !!c.querySelector('.tool-head .spinner'),
    notes: [...c.querySelectorAll('.agent-note')].map((n) => n.innerText),
    model: c.querySelector('.subagent-model')?.innerText ?? null,
    modelClass: c.querySelector('.subagent-model')?.className ?? '',
  }))`);
// ("verified model" is inside "unverified model": match whole words)
const hasTitle = (text, title) => new RegExp(`(^|\\s)${title}(\\s|$)`).test(text);
// The model names come from the catalog, which loads a moment after the page.
const cardsReady = async () => {
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 6`);
  await b.waitFor(`[...document.querySelectorAll('.tool.agent .subagent-model')].some((m) => m.innerText.includes('DeepSeek V4.1 Flash'))`);
};
const byTitle = (cards, title) => cards.find((c) => hasTitle(c.text, title));

test('after a restart, leftover "running" subagents stop spinning, say why, and never claim the conversation\'s DeepSeek setting as the model', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 6`);
  const cards = await cardHeads();

  const stuck = byTitle(cards, 'stuck after restart');
  assert.equal(stuck.spinner, false, 'tool call interrupted by the restart: no spinner');
  assert.match(stuck.text, /已中斷/);
  assert.match(stuck.notes.join('\n'), /重新啟動/, 'the reason is on the card');

  const unreported = byTitle(cards, 'finished without report');
  assert.equal(unreported.spinner, false);
  assert.match(unreported.text, /狀態未知/);

  // No card says "<provider> · 模型等待回報/未回報": that was the conversation's setting posing as the model.
  for (const c of cards) assert.doesNotMatch(c.text, /(DeepSeek|Claude|Kimi) · 模型(等待|未)回報/, c.text);

  // Both stuck cards carry no model at all: unconfirmed, with no provider invented.
  assert.equal(unreported.model, '模型未確認');
  assert.equal(stuck.model, '模型未確認');

  // The tray under the conversation counts 0 instead of "2 個在工作".
  assert.equal(await b.eval(`document.querySelector('.agent-tray')`), null, 'no "N working" tray');
});

test('a call that came back settles its subagent in the restore: finished, not spinning, not "unknown"', { skip }, async () => {
  await ui.openApp('#/s/s_settled');
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 1`);
  const [card] = await cardHeads();
  assert.equal(card.spinner, false);
  assert.doesNotMatch(card.text, /狀態未知|已中斷/, 'the server said it is over; the page does not second-guess it');
  assert.equal(card.model, '模型未確認', 'and it still claims no model it was never told');
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
  await b.waitFor(`[...document.querySelectorAll('.om-seg__item')].some((x) => x.textContent.startsWith('子代理'))`);
  await b.eval(`[...document.querySelectorAll('.om-seg__item')].find((x) => x.textContent.startsWith('子代理'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.agent-item').length >= 1`);
  assert.equal(await b.eval(`document.querySelector('.agent-item .om-badge:last-child')?.innerText`), '完成');
});

test('requested and actual are two different things on the card', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await cardsReady();
  const cards = await cardHeads();

  const verified = byTitle(cards, 'verified model');
  assert.equal(verified.model, 'DeepSeek V4.1 Flash · 思考 max', 'the provider is said once: the model\'s own name starts with it');
  assert.equal(verified.notes.length, 0, 'asked for the same thing, nothing more to say');

  const unverified = byTitle(cards, 'unverified model');
  assert.equal(unverified.model, '模型未確認');
  assert.match(unverified.modelClass, /unconfirmed/);
  assert.match(unverified.notes.join('\n'), /要求：DeepSeek V4\.1 Flash · 思考 max/, 'the request is labelled as a request');
  assert.match(unverified.notes.join('\n'), /沒有回報子代理實際用的模型/, 'the server\'s reason is shown');

  const elsewhere = byTitle(cards, 'ran elsewhere');
  assert.equal(elsewhere.model, 'claude-haiku-4 · 思考 low');
  assert.match(elsewhere.text, /與要求不同/);
  assert.match(elsewhere.notes.join('\n'), /要求：DeepSeek/);
});

test('model names on the cards follow the catalog when it arrives after the conversation', { skip }, async () => {
  await ui.delay('/api/models', 1200); // the names come from a catalog that is slow
  await ui.openApp('#/s/s_kimi'); // straight to the conversation: no home catalog to borrow names from
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 6`);
  const early = byTitle(await cardHeads(), 'verified model');
  assert.equal(early.model, 'deepseek-v4.1-flash · 思考 max', 'before the catalog: the id\'s own tail, not an invented name (and the provider once)');
  await b.waitFor(`[...document.querySelectorAll('.tool.agent .subagent-model')].some((m) => m.innerText === 'DeepSeek V4.1 Flash · 思考 max')`, { label: 'the card takes the name once the catalog is in' });
  await ui.stopDelaying();
});

test('a card that carries no model says the same in a conversation whose setting is DeepSeek and in one whose setting is "native rules"', { skip }, async () => {
  // s_kimi's own subagent setting is DeepSeek V4.1 Flash; s_claude's is null.
  // Neither setting may leak onto a card that reported nothing.
  await ui.openApp('#/s/s_kimi');
  await cardsReady();
  const inDeepseekChat = byTitle(await cardHeads(), 'finished without report');
  await ui.openApp('#/s/s_claude');
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 1`);
  const inNativeChat = byTitle(await cardHeads(), 'task without model');
  for (const c of [inDeepseekChat, inNativeChat]) {
    assert.equal(c.model, '模型未確認');
    assert.doesNotMatch(c.text, /DeepSeek|Claude|Kimi/, 'no provider is named when none was reported');
    assert.deepEqual(c.notes.filter((n) => /要求/.test(n)), [], 'and nothing is claimed as requested either');
  }
});

test('the 子代理 panel says the same thing as the card for every subagent', { skip }, async () => {
  await ui.openApp('#/s/s_kimi');
  await cardsReady();
  const cards = await cardHeads();
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
  await b.waitFor(`[...document.querySelectorAll('.om-seg__item')].some((x) => x.textContent.startsWith('子代理'))`);
  await b.eval(`[...document.querySelectorAll('.om-seg__item')].find((x) => x.textContent.startsWith('子代理'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.agent-item').length >= 6`);
  const rows = await b.eval(`[...document.querySelectorAll('.agent-item')].map((r) => ({
    model: r.querySelector('.agent-item-model')?.innerText ?? null,
    desc: r.querySelector('.agent-item-desc')?.innerText ?? '',
    badge: r.querySelector('.om-badge:last-child')?.innerText ?? null,
    spinner: !!r.querySelector('.spinner'),
    notes: [...r.querySelectorAll('.agent-item-note')].map((n) => n.innerText),
  }))`);
  assert.equal(await b.eval(`document.querySelector('.agent-sec-count')?.innerText`), '6 個', 'nobody "in work"');
  for (const card of cards) {
    const title = ['stuck after restart', 'finished without report', 'verified model', 'unverified model', 'ran elsewhere', 'child task'].find((t) => hasTitle(card.text, t));
    const row = rows.find((r) => hasTitle(r.desc, title));
    assert.ok(row, `panel has a row for ${title}`);
    assert.equal(row.model, card.model, `${title}: same model text in the card and the panel`);
    assert.equal(row.spinner, card.spinner, `${title}: same working/not-working`);
  }
  assert.equal(rows.find((r) => hasTitle(r.desc, 'stuck after restart')).badge, '已中斷');
  assert.match(rows.find((r) => hasTitle(r.desc, 'stuck after restart')).notes.join('\n'), /重新啟動/, 'the panel says why, as the card does');
  assert.equal(rows.find((r) => hasTitle(r.desc, 'finished without report')).badge, '狀態未知');
  assert.match(rows.find((r) => hasTitle(r.desc, 'unverified model')).notes.join('\n'), /要求：DeepSeek/);
});

test('a stale "running" claim under a call that is over is not believed, whatever way the call ended (cards an older store or another runtime can still hand over)', { skip }, async () => {
  await ui.openApp('#/');
  const r = await b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const ts = Date.now();
    const call = (id, status) => ({ id, ts, type: 'tool_use', agentId: 'main', name: 'Agent', status, subagent: { id: 'x' + id, status: 'running', description: id } });
    const tr = new Transcript({ cwd: '/x', agentName: 'Kimi', sessionStatus: () => 'running' });
    document.body.append(tr.el);
    tr.load([{ id: 'u', ts, type: 'user', text: 'go' }, call('done', 'done'), call('ended', 'ended'), call('interrupted', 'interrupted'), call('error', 'error'), call('live', 'running'), ...Array.from({ length: 8 }, (_, i) => ({ id: 'later' + i, ts, type: 'text', agentId: 'main', text: 'more ' + i }))]);
    tr.setStatus('running');
    await frame();
    const look = (id) => {
      const el = tr.nodes.get(id).el;
      return { spinner: !!el.querySelector('.tool-head .spinner'), head: el.querySelector('.tool-head').textContent.replace(/\\s+/g, ' '), notes: [...el.querySelectorAll('.agent-note')].map((n) => n.textContent) };
    };
    const out = Object.fromEntries(['done', 'ended', 'interrupted', 'error', 'live'].map((id) => [id, look(id)]));
    tr.destroy();
    return out;
  })()`);
  for (const id of ['done', 'ended']) {
    assert.equal(r[id].spinner, false, `call ${id}: no spinner`);
    assert.match(r[id].head, /狀態未知/, `call ${id}: the page does not know how it ended`);
  }
  assert.equal(r.interrupted.spinner, false);
  assert.match(r.interrupted.head, /已中斷/);
  assert.match(r.interrupted.notes.join('\n'), /重新啟動/, 'and says why');
  assert.equal(r.error.spinner, false);
  assert.doesNotMatch(r.error.head, /狀態未知|已中斷/, 'a failed call is a failure, not an unknown');
  assert.equal(r.live.spinner, true, 'control: a call that is still running, in a conversation that works, spins');
});

test('a spinner needs evidence: it stops when the conversation goes idle, and by itself when a background subagent falls silent, and comes back with activity', { skip }, async () => {
  await ui.openApp('#/');
  const r = await b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const t0 = Date.now();
    const events = () => [
      { id: 'u', ts: Date.now(), type: 'user', text: 'go' },
      { id: 'bg', ts: Date.now(), type: 'tool_use', agentId: 'main', name: 'Agent', status: 'done', subagent: { id: 'b1', status: 'running', background: true, requested: ${JSON.stringify(SUB_DEFAULT)}, actual: null } },
      { id: 'fg', ts: Date.now(), type: 'tool_use', agentId: 'main', name: 'Agent', status: 'running', subagent: { id: 'f1', status: 'running' } },
      // later rows, so the cards are not among the last few that a status change redraws anyway
      ...Array.from({ length: 8 }, (_, i) => ({ id: 'later' + i, ts: Date.now(), type: 'text', agentId: 'main', text: 'more ' + i })),
    ];
    const make = (opts) => {
      let session = 'running';
      const tr = new Transcript({ cwd: '/x', agentName: 'Kimi', sessionStatus: () => session, limits: { silentMs: 500, modelReportWaitMs: 500 }, ...opts });
      document.body.append(tr.el);
      tr.load(events());
      tr.setStatus('running');
      return { tr, setSession: (s) => ((session = s), tr.setStatus(s)) };
    };
    const look = async (tr, label) => {
      await frame();
      const head = (id) => tr.nodes.get(id).el.querySelector('.tool-head');
      return { label, bg: !!head('bg').querySelector('.spinner'), fg: !!head('fg').querySelector('.spinner'), count: tr.runningCount(), bgText: head('bg').textContent.replace(/\\s+/g, ' '), fgText: head('fg').textContent.replace(/\\s+/g, ' ') };
    };
    const out = {};
    // A: no clock check at all (the interval is far away): only a status change can redraw.
    {
      const { tr, setSession } = make({ lifeCheckMs: 1e9 });
      out.working = await look(tr, 'working');
      setSession('idle');
      out.idle = await look(tr, 'idle at once');
      tr.destroy();
    }
    // B: the clock check runs; nothing is told to the page while time passes.
    {
      const { tr, setSession } = make({ lifeCheckMs: 60 });
      setSession('idle');
      await wait(900);
      out.silent = await look(tr, 'after silence');
      tr.add({ id: 'step', ts: Date.now(), type: 'tool_use', agentId: 'b1', parent: 'bg', name: 'Bash', title: 'ls', status: 'running' });
      out.again = await look(tr, 'activity again');
      tr.destroy();
    }
    return out;
  })()`);
  const { working, idle, silent, again } = r;
  assert.deepEqual([working.bg, working.fg, working.count], [true, true, 2], 'both spin while the conversation works');
  assert.match(working.bgText, /等待回報模型/, 'a live subagent briefly waits for its model report');
  assert.deepEqual([idle.fg, idle.bg, idle.count], [false, true, 1], 'idle: the foreground one stops at once, the background one is still alive');
  assert.match(idle.fgText, /狀態未知/);
  assert.deepEqual([silent.bg, silent.count], [false, 0], 'silent too long: stops with no event arriving');
  assert.match(silent.bgText, /狀態未知/);
  assert.match(silent.bgText, /模型未確認/, 'and the wait for the model report ended too');
  assert.deepEqual([again.bg, again.count], [true, 1], 'any new activity brings it back');
});
