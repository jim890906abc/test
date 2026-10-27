// A window is only the newest part of a conversation. What its events refer to
// that is not in it comes with it as `outside` (server/snapshot-window.js
// outsideOf): the question before the window, and the cards the window's
// events belong to. Pure cases first, then over the API and the socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { latestWindow, outsideOf, DEFAULTS, configFromEnv } from '../server/snapshot-window.js';
import { startHub } from './browser-harness.mjs';
import { storedSession, WINDOW_ENV, maker, T0 } from './fixtures/window-scenes.mjs';
import { page, until } from './hub-ws-fixtures.mjs';

const item = (ev) => ({ ev, node: { id: 'n1', conversationId: 'n1' }, nodeIndex: 0 });
const cfg = { ...DEFAULTS, turns: 1000, bytes: 1_000_000, events: 5, latestBytes: 1_000_000, latestEvents: 5, liveTail: 2 };
const ids = (list) => list.map((e) => e.id);

// user, a message, a subagent card with `steps` steps, a message: the window is the newest few.
function longTurn(steps = 6, lead = []) {
  const m = maker('t', T0 + 10_000_000); // after any lead: a conversation is in time order
  const evs = [...lead.map((f) => ({ ...f })), m.user('先做這件事'), m.text('好，我派子代理')];
  const card = m.tool('Agent', { description: '掃描' }, { subagent: { id: 'sub', status: 'running' }, status: 'running', output: '' });
  evs.push(card);
  for (let i = 0; i < steps; i++) evs.push(m.tool('Bash', { command: `echo ${i}` }, { parent: card.id }));
  evs.push(m.text('我同時整理文件'));
  return { evs, card };
}

test('nothing outside: a window that starts at the beginning, or a whole conversation, has no `outside`', () => {
  const { evs } = longTurn();
  const whole = latestWindow(evs.map(item), { cfg: { ...cfg, events: 100, latestEvents: 100 } });
  assert.equal(whole.window.firstIndex, 0);
  assert.equal(whole.outside, null);
  assert.equal(latestWindow([], { cfg }).outside, null);
});

test('the question before the window is the newest message of the person there, cut to a few hundred bytes', () => {
  const m = maker('q');
  const evs = [m.user('很早以前的問題'), m.text('回答'), m.end(), m.user('目前的問題 ' + '長'.repeat(1000), { images: ['a', 'b'] }), ...Array.from({ length: 8 }, (_, i) => m.tool('Bash', { command: `echo ${i}` }))];
  const r = latestWindow(evs.map(item), { cfg });
  assert.equal(r.window.firstIndex, evs.length - 5);
  const q = r.outside.question;
  assert.equal(q.id, evs[3].id, 'the newest one before the window, not the first');
  assert.equal(q.ts, evs[3].ts);
  assert.ok(q.text.startsWith('目前的問題 ') && Buffer.byteLength(q.text) <= DEFAULTS.questionBytes, `cut to ${Buffer.byteLength(q.text)} bytes`);
  assert.equal(q.images, 2);
  // a message inside a subagent is not the person's
  const withChild = [m.user('真正的問題'), { ...m.user('子代理收到的任務'), parent: 'x' }, ...Array.from({ length: 8 }, (_, i) => m.tool('Bash', { command: `echo ${i}` }))];
  assert.equal(latestWindow(withChild.map(item), { cfg }).outside.question.id, withChild[0].id);
});

test('a card whose steps are in the window comes with it, with how many of its tool calls lie before the window', () => {
  const { evs, card } = longTurn();
  const r = latestWindow(evs.map(item), { cfg });
  assert.ok(ids(r.events).every((id) => id !== card.id), 'the card is not in the window');
  assert.deepEqual(ids(r.outside.ancestors), [card.id]);
  const a = r.outside.ancestors[0];
  assert.equal(a.name, 'Agent');
  assert.equal(a.stepsBefore, r.window.firstIndex - 3, 'the steps between the card and the window start');
  assert.equal(r.outside.question.id, evs[0].id);
});

test('cards of cards: a step whose card is itself a step of an older card brings both, oldest first', () => {
  const m = maker('n');
  const outer = m.tool('Agent', { description: '外層' }, { subagent: { id: 'o', status: 'running' } });
  const inner = m.tool('Agent', { description: '內層' }, { parent: outer.id, subagent: { id: 'i', status: 'running' } });
  const evs = [m.user('做'), outer, inner, ...Array.from({ length: 6 }, (_, i) => m.tool('Bash', { command: `echo ${i}` }, { parent: inner.id }))];
  const r = latestWindow(evs.map(item), { cfg });
  assert.deepEqual(ids(r.outside.ancestors), [outer.id, inner.id]);
});

test('a working conversation also sends every subagent card still at work, whether or not a step of it is in the window; an idle one does not', () => {
  const m = maker('w');
  const quiet = m.tool('Agent', { description: '安靜的背景作業' }, { subagent: { id: 's', status: 'running', background: true } });
  const done = m.tool('Agent', { description: '做完的' }, { subagent: { id: 'd', status: 'done' } });
  const evs = [m.user('開始'), quiet, done, ...Array.from({ length: 10 }, (_, i) => m.tool('Bash', { command: `echo ${i}` }))];
  const busy = latestWindow(evs.map(item), { busy: true, cfg });
  assert.deepEqual(ids(busy.outside.ancestors), [quiet.id], 'the one at work, not the one that finished');
  const idle = latestWindow(evs.map(item), { busy: false, cfg });
  assert.equal(idle.outside.ancestors, undefined, 'an idle conversation holds nothing at work');
  assert.ok(idle.outside.question, '…but still has its question');
});

test('at most `ancestors` cards, the newest; a card that is no longer working has a long field cut like any other event', () => {
  const m = maker('c');
  const cards = Array.from({ length: 5 }, (_, i) => m.tool('Agent', { description: `卡 ${i}` }, { subagent: { id: `s${i}`, status: 'done' }, output: 'x'.repeat(40_000) }));
  // the window holds a step of each card
  const evs = [m.user('開始'), ...cards, ...cards.map((c) => m.tool('Bash', { command: 'echo' }, { parent: c.id }))];
  const c3 = { ...DEFAULTS, ancestors: 3, fieldBytes: 16384, previewBytes: 1000 };
  const r = outsideOf(evs.map(item), 6, evs.slice(6), { busy: false, cfg: c3 });
  assert.deepEqual(ids(r.ancestors), ids(cards.slice(-3)));
  assert.ok(r.ancestors.every((a) => a.truncated && a.output.length < 2000), 'cut, and said so');
  // one still at work is sent whole: its output may still be growing
  const live = m.tool('Agent', { description: '還在跑' }, { subagent: { id: 'l', status: 'running' }, output: 'y'.repeat(40_000) });
  const more = [m.user('開始'), live, m.tool('Bash', { command: 'echo' }, { parent: live.id })];
  const kept = outsideOf(more.map(item), 2, more.slice(2), { busy: true, cfg: c3 });
  assert.equal(kept.ancestors[0].output.length, 40_000);
});

test('the numbers can be set from the environment', () => {
  const c = configFromEnv({ AGENT_HUB_WINDOW_ANCESTORS: '7', AGENT_HUB_QUESTION_BYTES: '200' });
  assert.equal(c.ancestors, 7);
  assert.equal(c.questionBytes, 200);
  assert.equal(configFromEnv({}).ancestors, DEFAULTS.ancestors);
});

// ------------------------------------------------- over the API and the socket

let hub;
const lead = Array.from(maker('lead').filler(10));
const { evs: turn, card } = longTurn(60, lead);
before(async () => {
  hub = await startHub([storedSession(turn, { id: 's_out', status: 'idle' })], { env: WINDOW_ENV });
});
after(() => hub?.stop());

test('the snapshot (HTTP and socket) carries `outside` beside `window`, whose own shape is unchanged; ?window=all carries neither', async () => {
  const s = await hub.api('/sessions/s_out');
  assert.deepEqual(Object.keys(s.window).sort(), ['firstIndex', 'hasEarlier', 'total'], 'the window keeps its three fields');
  assert.equal(s.outside.question.id, turn.find((e, i) => e.type === 'user' && i >= lead.length).id, 'the newest message of the person before the window');
  assert.ok(s.events.every((e) => e.id !== card.id));
  const all = await hub.api('/sessions/s_out?window=all');
  assert.equal(all.window, undefined);
  assert.equal(all.outside, undefined);

  const p = page({ port: hub.port, token: 'none', watch: 's_out' });
  await p.ready;
  await until(async () => p.snapshots === 1, 5000, 'snapshot');
  const snap = p.got.find((m) => m.t === 'snapshot').session;
  assert.deepEqual(snap.outside.question, s.outside.question);
  assert.deepEqual(snap.window, s.window);
  p.ws.close();
});

test('a conversation that is working sends its subagents at work; once it is idle they are not sent', async () => {
  // stored 'running' becomes idle when a Hub starts, so the busy case is covered above on the pure function
  const s = await hub.api('/sessions/s_out');
  assert.equal(s.status, 'idle');
  assert.deepEqual(ids(s.outside.ancestors), [card.id], 'its steps are in the window, so its card comes');
});
