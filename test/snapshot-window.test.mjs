// The rules that choose the window of a snapshot and cut oversized fields
// (server/snapshot-window.js), on their own: which limit binds first, what the
// latest turn is guaranteed, what is never cut, and that cutting never touches
// the stored event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-window-unit-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const { latestWindow, pageBefore, slimEvent, cutBytes, oneEvent, configFromEnv, DEFAULTS, isLiveEvent, isArtifactEvent } = await import('../server/snapshot-window.js');

const node = { id: 'n1', conversationId: 'c1', provider: 'claude' };
const item = (ev) => ({ ev, node, nodeIndex: 0 });
const cfg = { ...DEFAULTS, turns: 1000, bytes: 1_000_000, events: 1000, latestBytes: 1_000_000, latestEvents: 1000, fieldBytes: 16384, previewBytes: 1000, liveTail: 3 };
const text = (i, size = 10) => ({ id: `e${i}`, ts: i, type: 'text', text: 'x'.repeat(size) });
const user = (i) => ({ id: `e${i}`, ts: i, type: 'user', text: `question ${i}` });
const idsOf = (r) => r.events.map((e) => e.id);
const seq = (a, b) => Array.from({ length: b - a }, (_, k) => `e${a + k}`);

test('the defaults are the documented ones, and the environment can change each of them', () => {
  assert.equal(DEFAULTS.bytes, 300 * 1024);
  assert.equal(DEFAULTS.fieldBytes, 16 * 1024);
  const c = configFromEnv({ AGENT_HUB_WINDOW_BYTES: '5000', AGENT_HUB_WINDOW_TURNS: '2', AGENT_HUB_FIELD_LIMIT: 'junk', AGENT_HUB_PAGE_EVENTS: '-3' });
  assert.equal(c.bytes, 5000);
  assert.equal(c.turns, 2);
  assert.equal(c.fieldBytes, DEFAULTS.fieldBytes, 'a value that is not a positive whole number is ignored');
  assert.equal(c.pageEvents, DEFAULTS.pageEvents);
});

test('the number of turns binds first when the turns are short', () => {
  // user at 0, 10, 20, 30, 40; 50 events of 10 bytes
  const items = Array.from({ length: 50 }, (_, i) => item(i % 10 === 0 ? user(i) : text(i)));
  const r = latestWindow(items, { cfg: { ...cfg, turns: 2 } });
  assert.deepEqual(idsOf(r), seq(30, 50), 'starts at the second-to-last user message');
  assert.deepEqual(r.window, { total: 50, firstIndex: 30, hasEarlier: true });
});

test('the byte budget binds first when events are long, the event cap when they are many', () => {
  const items = Array.from({ length: 100 }, (_, i) => item(text(i, 1000)));
  const perEvent = Buffer.byteLength(JSON.stringify(items.at(-1).ev));
  const byBytes = latestWindow(items, { cfg: { ...cfg, bytes: perEvent * 7 + 5 } });
  assert.equal(byBytes.events.length, 7);
  assert.equal(byBytes.window.firstIndex, 93);
  const byEvents = latestWindow(items, { cfg: { ...cfg, events: 12 } });
  assert.equal(byEvents.events.length, 12);
  assert.equal(byEvents.window.firstIndex, 88);
});

test('a window is never empty, even when the newest event alone is over the budget', () => {
  const items = [item(text(0, 10)), item(text(1, 50_000))];
  const r = latestWindow(items, { cfg: { ...cfg, bytes: 100, fieldBytes: 1_000_000 } });
  assert.deepEqual(idsOf(r), ['e1']);
  assert.deepEqual(r.window, { total: 2, firstIndex: 1, hasEarlier: true });
  const p = pageBefore(items, 2, { cfg: { ...cfg, pageBytes: 100, fieldBytes: 1_000_000 } });
  assert.deepEqual(idsOf(p), ['e1'], 'so paging back always makes progress');
});

test('the latest turn is kept whole beyond the ordinary budget, up to its own limit, and nothing older then', () => {
  // an old turn (0..9), then the latest turn (10..49): 40 events of ~1 KB
  const items = Array.from({ length: 50 }, (_, i) => item(i === 0 ? user(i) : i === 10 ? user(i) : text(i, 1000)));
  const small = { ...cfg, bytes: 5_000, latestBytes: 100_000 };
  const r = latestWindow(items, { cfg: small });
  assert.equal(r.window.firstIndex, 10, 'the whole latest turn, from its user message');
  assert.equal(r.events[0].type, 'user');
  assert.equal(r.events.length, 40);
  // Too large even for that: cut inside the latest turn, still the newest events.
  const tight = latestWindow(items, { cfg: { ...small, latestBytes: 10_000 } });
  assert.ok(tight.events.length < 40 && tight.window.firstIndex > 10);
  assert.equal(tight.events.at(-1).id, 'e49');
  // Latest turn small: the ordinary budget goes on filling with older turns.
  const roomy = latestWindow(items, { cfg: { ...cfg, bytes: 100_000, latestBytes: 100_000, turns: 1000 } });
  assert.equal(roomy.window.firstIndex, 0);
});

test('a chain with no user message is one budget, not one endless turn', () => {
  const items = Array.from({ length: 100 }, (_, i) => item(text(i, 1000)));
  const perEvent = Buffer.byteLength(JSON.stringify(items.at(-1).ev));
  const r = latestWindow(items, { cfg: { ...cfg, bytes: perEvent * 5 + 1, latestBytes: 1_000_000 } });
  assert.equal(r.events.length, 5);
});

test('messages of subagents (with a parent) are not turns of their own', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(i === 5 || i === 20 ? user(i) : i === 25 ? { ...user(i), parent: 'agent_card' } : text(i)));
  const r = latestWindow(items, { cfg: { ...cfg, turns: 2 } });
  assert.equal(r.window.firstIndex, 5, 'two real turns (5 and 20); the nested user message does not count');
});

test('paging back: each page ends where the last began, with no event twice and none lost', () => {
  const items = Array.from({ length: 95 }, (_, i) => item(text(i, 100)));
  for (const limit of [1, 4, 10, 33]) {
    let end = 95;
    const got = [];
    while (end > 0) {
      const p = pageBefore(items, end, { limit, cfg });
      assert.ok(p.events.length >= 1 && p.events.length <= limit);
      assert.equal(p.firstIndex, end - p.events.length);
      got.unshift(...idsOf(p));
      end = p.firstIndex;
      assert.equal(p.hasEarlier, end > 0);
    }
    assert.deepEqual(got, seq(0, 95));
  }
  assert.deepEqual(pageBefore(items, 0, { cfg }), { events: [], firstIndex: 0, hasEarlier: false, total: 95 });
  assert.equal(pageBefore(items, 500, { limit: 3, cfg }).firstIndex, 92, 'past the end counts as the end');
  assert.equal(pageBefore(items, 95, { limit: 100_000, cfg: { ...cfg, pageMaxEvents: 20 } }).events.length, 20, 'a page is never longer than the cap');
});

test('events are annotated with their node, and the window shares nothing with the stored events', () => {
  const stored = { id: 'e0', ts: 1, type: 'tool_use', status: 'done', output: 'y'.repeat(50_000), input: { command: 'ls' } };
  const before = structuredClone(stored);
  const r = latestWindow([item(stored)], { cfg });
  assert.equal(r.events[0].nodeId, 'n1');
  assert.equal(r.events[0].conversationId, 'c1');
  assert.equal(r.events[0].nodeProvider, 'claude');
  assert.notEqual(r.events[0], stored);
  assert.ok(r.events[0].truncated, 'cut for the page');
  assert.deepEqual(stored, before, 'the stored event is exactly as it was');
  assert.equal(stored.output.length, 50_000);
});

test('cutBytes stops on a character, never inside one, and never above the limit', () => {
  assert.equal(cutBytes('abc', 10), 'abc');
  assert.equal(cutBytes('abcdef', 4), 'abcd');
  for (const s of ['想法'.repeat(50), '😀'.repeat(50), 'a😀b想'.repeat(30), 'é'.repeat(100)]) {
    for (const max of [1, 2, 3, 4, 5, 7, 10, 33]) {
      const out = cutBytes(s, max);
      assert.ok(Buffer.byteLength(out) <= max, `${JSON.stringify(s.slice(0, 4))}… at ${max}: ${Buffer.byteLength(out)}`);
      assert.ok(s.startsWith(out));
      assert.ok(!out.includes('�'));
      assert.ok(Buffer.byteLength(out) > max - 4, 'and it keeps as much as fits');
    }
  }
});

test('a long string anywhere inside an object field is cut, the shape stays; a long list of small things becomes empty', () => {
  const ev = { id: 'x', ts: 1, type: 'tool_use', status: 'done', input: { path: '/a', edits: [{ old: 'o'.repeat(20_000), new: 'n'.repeat(20_000) }], n: 3, ok: true, none: null } };
  const { ev: cut, truncated } = slimEvent(ev, { ...cfg, previewBytes: 100 });
  assert.equal(cut.input.path, '/a');
  assert.equal(cut.input.n, 3);
  assert.equal(cut.input.ok, true);
  assert.equal(cut.input.none, null);
  assert.equal(cut.input.edits[0].old.length, 100);
  assert.equal(cut.input.edits[0].new.length, 100);
  assert.equal(truncated.field, 'input');

  const list = { id: 'y', ts: 1, type: 'tool_use', status: 'done', todos: Array.from({ length: 5000 }, (_, i) => ({ i, t: 'task' })) };
  const slim = slimEvent(list, cfg);
  assert.deepEqual(slim.ev.todos, []);
  assert.equal(slim.truncated.field, 'todos');
});

test('what must not be cut is not: images, events still running, and the live end of a busy conversation', () => {
  const images = { id: 'u', ts: 1, type: 'user', text: 'look', images: [{ data: 'i'.repeat(40_000) }] };
  assert.equal(slimEvent(images, cfg).ev, images, 'images are shown whole or not at all');
  for (const status of ['pending', 'running', 'awaiting']) {
    const live = { id: 'r', ts: 1, type: 'tool_use', status, output: 'o'.repeat(40_000) };
    assert.equal(slimEvent(live, cfg, { live: isLiveEvent(live) }).ev, live, status);
    const r = latestWindow([item(live)], { cfg });
    assert.equal(r.events[0].output.length, 40_000, `${status}: its deltas continue what the page was sent`);
  }
  const card = { id: 'c', ts: 1, type: 'tool_use', status: 'done', output: 'o'.repeat(40_000), subagent: { status: 'running' } };
  assert.equal(latestWindow([item(card)], { cfg }).events[0].output.length, 40_000, 'a card whose subagent still runs');

  // Busy: the newest `liveTail` (3) events are whole, older ones are cut as usual.
  const done = (i) => ({ id: `e${i}`, ts: i, type: 'thinking', text: 't'.repeat(40_000) });
  const items = [0, 1, 2, 3, 4].map((i) => item(done(i)));
  const busy = latestWindow(items, { busy: true, cfg });
  assert.deepEqual(busy.events.map((e) => e.text.length === 40_000), [false, false, true, true, true]);
  const idle = latestWindow(items, { busy: false, cfg });
  assert.ok(idle.events.every((e) => e.text.length < 40_000));
});

test('a page the agent wrote (an .html file) is sent whole, because the Artifact panel shows it from the event; any other file is cut', () => {
  const html = (name, path, extra = {}) => ({ id: 'a', ts: 1, type: 'tool_use', name, status: 'done', input: { path, content: '<p>x</p>'.repeat(10_000), ...extra } });
  for (const name of ['Write', 'WriteFile']) {
    const ev = html(name, '/work/report.html');
    assert.equal(isArtifactEvent(ev), true);
    assert.equal(slimEvent(ev, cfg).ev, ev, `${name} .html`);
  }
  const edit = { id: 'e', ts: 1, type: 'tool_use', name: 'Edit', status: 'done', input: { file_path: '/work/x.HTM', old_string: 'a'.repeat(20_000), new_string: 'b'.repeat(20_000) } };
  assert.equal(slimEvent(edit, cfg).ev, edit, 'an Edit of a page too');
  for (const [name, path] of [['Write', '/work/notes.md'], ['Write', '/work/page.html.bak'], ['Bash', '/work/page.html'], ['Read', '/work/page.html']]) {
    const ev = html(name, path);
    assert.equal(isArtifactEvent(ev), false, `${name} ${path}`);
    assert.ok(slimEvent(ev, cfg).truncated, `${name} ${path} is cut like any other big field`);
  }
});

test('one event: whole on request, otherwise as the snapshot has it', () => {
  const stored = { id: 'e', ts: 1, type: 'tool_use', status: 'done', output: 'z'.repeat(30_000) };
  assert.equal(oneEvent(item(stored), { full: true, cfg }).output.length, 30_000);
  assert.equal(oneEvent(item(stored), { full: true, cfg }).truncated, undefined);
  const cut = oneEvent(item(stored), { cfg });
  assert.ok(cut.output.length <= 1000 && cut.truncated.bytes === 30_000);
});

test('an event with only small fields comes back as the very same object (nothing copied for nothing)', () => {
  const ev = text(1, 100);
  assert.equal(slimEvent(ev, cfg).ev, ev);
});
