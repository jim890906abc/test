// What the page works out for itself from the events it holds, checked when the
// conversation is longer than the window the Hub sends. REAL Hub (it cuts the
// conversation into windows) fed by a made-up computer that streams a Kimi
// conversation into it, and the REAL front end — no stand-in in between.
//
// A window is the newest part of a conversation, so what lies before it is not
// in the page: the message that started the turn, the subagent card above the
// steps that go on inside it, the reply that was last said. Each test is one
// thing the page shows that depends on such an event.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, launchBrowser, startHub } from './browser-harness.mjs';
import { startLiveHub, sleep } from './fixtures/live-hub.mjs';
import { WINDOW_ENV, WINDOW, storedSession, maker } from './fixtures/window-scenes.mjs';

const skip = skipReason();
// Pages of 5, so that the page's own "load earlier while the top is near" (12 of them) reaches only 60 events back.
const ENV = { ...WINDOW_ENV, AGENT_HUB_PAGE_MAX_EVENTS: '5' };
const QUESTION = '調查整個專案並回報結果';
let b;
let turnHub; // a turn longer than the window: its question and its subagent card are out of it
let quietHub; // a subagent still working, quiet: its card is out of the window and no step of it is in
let resumedHub; // a finished subagent that was woken again long after
let replyHub; // the last reply is long and is not in the window
let userTs;
let cardId;
let quietCardId;

before(async () => {
  if (skip) return;
  b = await launchBrowser();

  turnHub = await startLiveHub({ env: ENV, kid: 'session_turn' });
  turnHub.start(QUESTION);
  turnHub.say('我先派一個子代理去掃描專案');
  await sleep(250);
  const agent = turnHub.agent('掃描程式碼');
  for (let i = 0; i < 150; i++) turnHub.tool(i, { agentId: agent.subagentId, name: i % 2 ? 'Read' : 'Bash' });
  await turnHub.settled(150);
  const whole = await turnHub.whole();
  userTs = whole.find((e) => e.type === 'user').ts;
  cardId = whole.find((e) => e.name === 'Agent').id;

  quietHub = await startLiveHub({ env: ENV, kid: 'session_quiet' });
  quietHub.start('在背景掃描，同時整理文件');
  const quiet = quietHub.agent('背景掃描', { background: true });
  quietHub.frame('tool.result', { turnId: 't1', toolCallId: quiet.id, output: 'started in background' });
  for (let i = 0; i < 60; i++) quietHub.tool(i);
  await quietHub.settled(60);
  quietCardId = (await quietHub.whole()).find((e) => e.name === 'Agent').id;

  resumedHub = await startLiveHub({ env: ENV, kid: 'session_resumed' });
  resumedHub.start('先做一個子代理，之後再叫醒它');
  resumedHub.say('派出去');
  const old = resumedHub.agent('舊的子代理');
  resumedHub.tool(0, { agentId: old.subagentId });
  resumedHub.frame('tool.result', { turnId: 't1', toolCallId: old.id, output: 'status: completed\n[summary]\n做完了' });
  for (let i = 0; i < 40; i++) resumedHub.tool(i + 100);
  for (let i = 0; i < 20; i++) resumedHub.tool(i + 200, { agentId: old.subagentId });
  await resumedHub.settled(60);
  await sleep(300);
});
after(async () => {
  await b?.close();
  for (const h of [turnHub, quietHub, resumedHub]) h?.stop();
  replyHub?.stop?.();
});

const open = async (hub, sid, { settle = 1200 } = {}) => {
  await b.size(1280, 900);
  await b.goto(`${hub.url}#/s/${sid}`, 300);
  await b.waitFor(`document.querySelector('.transcript')`, { timeout: 15000 });
  await sleep(settle);
};
const scroller = `document.querySelector('.transcript')`;
const parseSeconds = (text) => {
  const m = /(?:(\d+) 分 )?(\d+) 秒/.exec(text || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};

test('the scene really is a conversation longer than the window, with the turn\'s start and the card outside it', { skip }, async () => {
  const snap = await turnHub.hub.api(`/sessions/${turnHub.sid}`);
  assert.equal(snap.status, 'running');
  assert.ok(snap.window.hasEarlier && snap.events.length <= WINDOW + 2, `${snap.events.length} events of ${snap.window.total}`);
  assert.ok(!snap.events.some((e) => e.type === 'user' || e.name === 'Agent'), 'neither the question nor the subagent card came with the window');
  assert.ok(snap.events.every((e) => e.parent === cardId), 'every event in the window is a step of that card: all orphans if the card is not shipped with it');
});

test('busy timer: a conversation opened mid-turn counts from the message that started the turn, though that message is outside the window', { skip }, async () => {
  while (Date.now() - userTs < 4000) await sleep(200); // let the turn have run a few seconds
  await open(turnHub.hub, turnHub.sid);
  const shown = parseSeconds(await b.eval(`document.querySelector('.working')?.innerText`));
  const real = Math.floor((Date.now() - userTs) / 1000);
  assert.ok(real >= 3, `the scene has been running ${real}s`);
  assert.ok(shown !== null && shown >= real - 2 && shown <= real + 2, `the page says ${shown}s, the turn has run ${real}s`);
});

test('目前問題置頂: the question being answered stays pinned while its answer is on screen, though the question is outside the window; clicking it goes there', { skip }, async () => {
  await open(turnHub.hub, turnHub.sid);
  // a real scroll: up a little, and back to the end
  await b.eval(`${scroller}.scrollTop = ${scroller}.scrollHeight - ${scroller}.clientHeight - 60`);
  await sleep(150);
  await b.eval(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
  await b.waitFor(`document.querySelector('.prompt-pin-bar') && !document.querySelector('.prompt-pin-bar').hidden`, { timeout: 5000, label: 'the pin shows' });
  assert.equal(await b.eval(`document.querySelector('.prompt-pin-text').textContent`), QUESTION);
  await b.click('.prompt-pin');
  const userId = (await turnHub.whole()).find((e) => e.type === 'user').id;
  await b.waitFor(`document.querySelector('[data-id="${userId}"]')`, { timeout: 20000, label: 'the question is loaded' });
  await sleep(600);
  const y = await b.eval(`(() => { const sc = ${scroller}; const e = sc.querySelector('[data-id="${userId}"]'); return Math.round(e.getBoundingClientRect().top - sc.getBoundingClientRect().top); })()`);
  assert.ok(y >= 0 && y <= 140, `the question is at the top of the view (${y}px from the edge)`);
});

test('N 個在工作: a subagent still working counts, whether its card is outside the window or its steps are (and the 子代理 panel lists it)', { skip }, async () => {
  for (const [hub, name] of [[turnHub, 'steps in the window'], [quietHub, 'quiet, nothing of it in the window']]) {
    await open(hub.hub, hub.sid);
    assert.equal(await b.eval(`document.querySelector('.agent-tray-desc')?.innerText`), '1 個在工作', name);
    assert.equal(await b.eval(`[...document.querySelectorAll('.panel-head .om-seg__item')].length`), 0, 'the panel is closed');
    await b.click('.agent-tray');
    await b.waitFor(`document.querySelector('.panel .agent-list, .panel .agents-list, .panel [data-agent]')`, { timeout: 5000 }).catch(() => {});
    const listed = await b.eval(`document.querySelector('.panel')?.innerText`);
    assert.match(listed, /1 個在工作/, `${name}: the 子代理 panel counts it too`);
  }
});

test('a step whose subagent card is outside the window is still shown inside that card, with the card above it', { skip }, async () => {
  await open(turnHub.hub, turnHub.sid);
  assert.equal(await b.eval(`!!document.querySelector('[data-id="${cardId}"]')`), true, 'the card is on the page');
  const held = await b.eval(`[...document.querySelectorAll('[data-id="${cardId}"] .tool-children [data-id]')].length`);
  assert.ok(held >= 20 && held < 150, `its steps are inside it (${held} of 150: the window and what the page loaded by itself)`);
  assert.equal(await b.eval(`[...document.querySelectorAll('[data-id="${cardId}"] > .tool-head .tool-meta')].map((e) => e.innerText).find((t) => /個步驟/.test(t))`), '150 個步驟', 'the card counts all its steps, the 120 or so outside the window too');
  const quiet = await (async () => {
    await open(quietHub.hub, quietHub.sid);
    return b.eval(`!!document.querySelector('[data-id="${quietCardId}"]')`);
  })();
  assert.equal(quiet, true, 'a working subagent whose card is out of the window is on the page too');
});

// Reference: the same events drawn by a Transcript that holds all of them at once.
const wholeOrder = (hub) =>
  b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const whole = (await (await fetch('/api/sessions/${hub.sid}?window=all')).json()).events;
    const t = new Transcript({ cwd: '/x' });
    t.load(whole);
    // The page draws a long copy as its newest part and keeps the rest aside: draw it all.
    while (t.reserve.length) t.prepend(t.reserve.splice(-80));
    document.body.append(t.el);
    t.flush();
    const out = [...t.column.querySelectorAll('[data-id]')].map((e) => e.dataset.id + '<' + (e.parentElement.closest('[data-id]')?.dataset.id || ''));
    t.el.remove();
    t.destroy();
    return out;
  })()`);
const pageOrder = () => b.eval(`[...document.querySelectorAll('.transcript .column [data-id]')].map((e) => e.dataset.id + '<' + (e.parentElement.closest('[data-id]')?.dataset.id || ''))`);
async function loadEverything() {
  for (let i = 0; i < 120; i++) {
    if (await b.eval(`document.querySelector('.transcript .earlier').hidden`)) break;
    // the button is the same load as reaching the top, without the limit on how many follow each other by themselves
    await b.eval(`document.querySelector('.transcript .earlier-btn').click()`);
    await sleep(120);
  }
  assert.equal(await b.eval(`document.querySelector('.transcript .earlier').hidden`), true, 'everything is loaded');
  await sleep(600);
}

test('scrolled all the way up, the page holds exactly what drawing the whole conversation at once gives — a card held for its steps goes back to where it belongs', { skip }, async () => {
  for (const [hub, name] of [[turnHub, 'a subagent card above its steps'], [resumedHub, 'a finished subagent woken again long after']]) {
    await open(hub.hub, hub.sid);
    await loadEverything();
    if (hub === turnHub) assert.equal(await b.eval(`[...document.querySelectorAll('[data-id="${cardId}"] > .tool-head .tool-meta')].map((e) => e.innerText).find((t) => /個步驟/.test(t))`), '150 個步驟', 'and still 150 once they are all loaded');
    const got = await pageOrder();
    assert.deepEqual(got, await wholeOrder(hub), name);
    assert.ok(got.length > 60, `${name}: there was something to compare (${got.length})`);
    const card = (await hub.whole()).find((e) => e.name === 'Agent').id;
    assert.equal(got.filter((x) => x.startsWith(`${card}<`)).length, 1, `${name}: the card is on the page once`);
  }
});

test('a woken subagent\'s late steps are inside its old card, which stays where it was said, not at the top of the late part', { skip }, async () => {
  await open(resumedHub.hub, resumedHub.sid);
  const whole = await resumedHub.whole();
  const card = whole.find((e) => e.name === 'Agent');
  const late = whole.filter((e) => e.parent === card.id).slice(-20);
  assert.equal(late.length, 20);
  assert.equal(await b.eval(`!!document.querySelector('[data-id="${card.id}"]')`), true, 'the card is there');
  await loadEverything();
  // Its place is among the top-level rows right after the text that sent it out, before the 40 commands that followed.
  const top = await b.eval(`[...document.querySelectorAll('.transcript .column > .ev')].map((e) => e.dataset.id).filter(Boolean)`);
  const order = whole.filter((e) => !e.parent).map((e) => e.id).filter((id) => top.includes(id));
  assert.deepEqual(top.filter((id) => order.includes(id)), order, 'top-level rows in conversation order, the card among them');
  assert.ok(top.indexOf(card.id) < top.indexOf(whole.filter((e) => !e.parent && e.name === 'Bash').at(-1).id), 'the card comes before the commands that followed it');
});

// ------------------------------------------------------------- copy

test('/copy copies the whole last reply — even a long one that arrives cut short, even one that is not in the window', { skip }, async () => {
  const m = maker('r');
  const longReply = `${'很長的回覆。'.repeat(4000)}END-OF-REPLY`;
  const events = [m.user('寫一份很長的報告'), m.text(longReply), m.end(), ...Array.from({ length: 100 }, (_, i) => m.tool('Bash', { command: `echo ${i}` }))];
  replyHub = await startHub([storedSession(events, { id: 's_reply', title: '長回覆' })], { env: ENV });
  await b.size(1280, 900);
  await b.goto(`${replyHub.url}#/s/s_reply`, 300);
  await b.waitFor(`document.querySelector('.transcript .column > .ev')`, { timeout: 15000 });
  await sleep(500);
  const snap = await replyHub.api('/sessions/s_reply');
  assert.ok(!snap.events.some((e) => e.type === 'text'), 'the reply is outside the window');
  assert.ok(Buffer.byteLength(longReply) > 16 * 1024, 'and it is longer than what the Hub sends whole');
  await b.eval(`window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }`);
  await b.eval(`(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); ta.value = '/copy'; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await b.eval(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await b.waitFor(`window.__copied.length > 0 || document.querySelector('.toasts')?.innerText.includes('還沒有回覆')`, { timeout: 20000, label: 'copied, or told there was nothing' });
  const copied = await b.eval(`window.__copied`);
  assert.equal(copied.length, 1, `copied once (toast: ${await b.eval(`document.querySelector('.toasts')?.innerText`)})`);
  assert.equal(copied[0], longReply, 'the whole reply, to its last character');
});

// ------------------------------------------- the transcript, given what the Hub says is outside

test('a fresh copy after a reconnect brings the cards held above up to date, and a slice that carries the card itself puts it back in its place and tells the tray', { skip }, async () => {
  await b.goto(`${turnHub.hub.url}#/`, 300);
  await b.waitFor(`document.querySelector('.sidebar')`);
  const r = await b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const T0 = 1790000000000;
    const card = (status, sub) => ({ id: 'card', ts: T0 + 2, type: 'tool_use', agentId: 'main', name: 'Agent', title: '掃描', status, input: { description: '掃描' }, subagent: { id: 's', status: sub, ...(sub === 'done' ? { summary: '好了' } : {}) } });
    const step = (i) => ({ id: 's' + i, ts: T0 + 10 + i, type: 'tool_use', agentId: 'main', parent: 'card', name: 'Bash', title: 'echo ' + i, status: 'done', input: { command: 'echo ' + i }, output: String(i) });
    const user = { id: 'q', ts: T0, type: 'user', text: '問題' };
    const say = { id: 'say', ts: T0 + 1, type: 'text', agentId: 'main', text: '派出去' };
    const older = [user, say, card('running', 'running'), ...[0, 1, 2, 3, 4, 5].map(step)];
    const flushes = [];
    let status = 'running';
    // the page asks for the slice before the window by itself when its top is near: hold that answer back until it is wanted
    let release;
    const gate = new Promise((r) => (release = r));
    const t = new Transcript({ cwd: '/x', sessionStatus: () => status, onFlush: (ids) => flushes.push(ids.length), fetchEarlier: async () => (await gate, { events: older, firstIndex: 0, hasEarlier: false }) });
    document.body.append(t.el);
    const win = { total: 12, firstIndex: 6, hasEarlier: true };
    const held = [6, 7, 8, 9].map(step);
    const out = {};
    t.load(held, { window: win, outside: { ancestors: [{ ...card('running', 'running'), stepsBefore: 6 }], question: { id: 'q', ts: T0, text: '問題' } } });
    await new Promise((r) => setTimeout(r, 100));
    out.first = { running: t.runningCount(), agents: t.agentList().map((a) => [a.id, a.steps]), top: t.column.firstElementChild?.dataset.id, inside: [...t.column.querySelectorAll('[data-id="card"] .tool-children > [data-id]')].map((e) => e.dataset.id), orderHasCard: t.order.includes('card'), question: t.question?.id, foreground: t.foregroundCount() };
    // a reconnect: the same window again, the card has finished meanwhile
    status = 'running';
    t.load(held, { window: win, outside: { ancestors: [{ ...card('done', 'done'), stepsBefore: 6 }], question: { id: 'q', ts: T0, text: '問題' } } });
    await new Promise((r) => setTimeout(r, 100));
    out.fresh = { foreground: t.foregroundCount(), running: t.runningCount(), sub: t.get('card').subagent.status, cards: t.column.querySelectorAll('[data-id="card"]').length, top: t.column.firstElementChild?.dataset.id };
    // the slice that has the card in it
    const before = flushes.length;
    release();
    await new Promise((r) => setTimeout(r, 250));
    out.back = { top: [...t.column.querySelectorAll(':scope > [data-id]')].map((e) => e.dataset.id), inside: [...t.column.querySelectorAll('[data-id="card"] .tool-children > [data-id]')].map((e) => e.dataset.id), cards: t.column.querySelectorAll('[data-id="card"]').length, aboveLeft: t.above.size, order: t.order.length, flushedForTheCard: flushes.length > before, steps: t.agentList()[0]?.steps, agentIds: t.agentIds.slice() };
    t.el.remove();
    t.destroy();
    return out;
  })()`);
  assert.deepEqual(r.first, { running: 1, agents: [['card', 10]], top: 'card', inside: ['s6', 's7', 's8', 's9'], orderHasCard: false, question: 'q', foreground: 1 }, 'held above the window: counted (also as the call Kimi waits on, for 移到背景), listed with all its steps (4 held + 6 before the window), first on the page, not part of the run of events');
  assert.deepEqual(r.fresh, { foreground: 0, running: 0, sub: 'done', cards: 1, top: 'card' }, 'brought up to date, not drawn twice');
  assert.deepEqual(r.back.top, ['q', 'say', 'card'], 'back in its own place, after the message and the text that sent it out');
  assert.deepEqual(r.back.inside, ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'], 'its steps in order: the older ones first');
  assert.equal(r.back.cards, 1);
  assert.equal(r.back.aboveLeft, 0);
  assert.equal(r.back.steps, 10, 'still ten steps, not counted twice');
  assert.equal(r.back.flushedForTheCard, true, 'the tray was told a subagent came in');
});

test('without anything outside (a whole conversation, or an older Hub) the transcript is exactly as it was', { skip }, async () => {
  const r = await b.eval(`(async () => {
    const { Transcript } = await import('/js/transcript.js');
    const evs = [{ id: 'u', ts: 1, type: 'user', text: 'hi' }, { id: 'a', ts: 2, type: 'text', agentId: 'main', text: 'hello' }];
    const t = new Transcript({ cwd: '/x' });
    t.load(evs, {});
    t.load(evs, { window: { total: 2, firstIndex: 0, hasEarlier: false } });
    const out = { order: t.order.slice(), above: t.above.size, question: t.question, rows: t.column.children.length };
    t.destroy();
    return out;
  })()`);
  assert.deepEqual(r, { order: ['u', 'a'], above: 0, question: null, rows: 2 });
});
