// The cost of mirroring a broker child's steps into its parent must not grow
// with how long the parent conversation is. Every delta / tool event of a
// child goes through brokerLinkFor + the projection lookup; on a 49 MB parent
// (tens of thousands of events) those used to scan the whole parent each time
// and ate a third of the Hub's CPU.
//
// The test drives the real runner the way a live adapter does
// (runner.liveContext(child).emit/patch/delta) against parents of two sizes
// and checks (a) what the mirror holds is right, and (b) the work per child
// event is about the same for a 30 000-event parent as for a 1 000-event one.
// The comparison is a ratio of two runs made back to back on this machine, so
// a slow machine does not trip it; the absolute bound is far above what the
// indexed code needs and only catches a return to scanning the parent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-broker-perf-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;
let broadcasts = [];

before(async () => {
  store = await import('../server/store.js');
  runner = await import('../server/runner.js');
  runner.setBroadcast((m) => broadcasts.push(m));
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const SMALL = 1_000;
const LARGE = 30_000;
const TEXT_STEPS = 400; // each: one text event + 5 deltas
const TOOL_STEPS = 400; // each: one tool_use event + one patch
const DELTAS = TEXT_STEPS * 5;
const task = 'perf task: summarise the repository layout';

// A parent with `size` ordinary events, the delegation card in the middle of
// them (so locating it is never a lucky first-element hit), and a broker child
// already linked to that card the way delegateToProvider leaves it.
function scene(size, childSize = 0) {
  const parent = store.createSession({
    agentId: 'kimi@m1', machineId: 'm1', provider: 'kimi', cwd: TMP, title: `parent ${size}`,
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { model: 'kimi/k2', effort: 'on' },
  });
  const cardAt = Math.floor(size / 2);
  for (let i = 0; i < size; i++) {
    if (i === cardAt) {
      parent.events.push({ id: 'e_card', ts: i, type: 'tool_use', name: 'delegate_to_provider', status: 'running', input: { task } });
      continue;
    }
    parent.events.push(i % 3 === 0
      ? { id: `e_f${i}`, ts: i, type: 'user', text: `question ${i}` }
      : i % 3 === 1
        ? { id: `e_f${i}`, ts: i, type: 'text', text: `answer ${i}` }
        : { id: `e_f${i}`, ts: i, type: 'tool_use', name: 'Bash', status: 'done', input: { command: `ls ${i}` }, output: 'x' });
  }
  const child = store.createSession({
    parentId: parent.id, agentId: 'kimi@m1', provider: 'kimi', cwd: TMP, title: task,
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { model: 'kimi/k2', effort: 'on' },
    state: { broker: { parentId: parent.id, parentEventId: 'e_card' } },
  });
  child.events.push({ id: `${child.id}_u`, ts: 1, type: 'user', text: task });
  // A long-running child: its own history is already long, none of it mirrored yet.
  for (let i = 0; i < childSize; i++) child.events.push({ id: `${child.id}_h${i}`, ts: 2 + i, type: 'text', text: `earlier ${i}` });
  const card = parent.events[cardAt];
  card.childSessionId = child.id;
  card.subagent = { id: child.id, broker: true, status: 'running', provider: 'kimi', model: 'kimi/k2', effort: 'on' };
  return { parent, child, card };
}

// The same stream of steps a live Kimi child produces.
function drive({ parent, child, card }) {
  const ctx = runner.liveContext(child);
  broadcasts = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < TEXT_STEPS; i++) {
    const t = ctx.emit({ type: 'text', text: `[${i}]` });
    for (let k = 0; k < 5; k++) ctx.delta(t, `tok${k} `);
  }
  for (let i = 0; i < TOOL_STEPS; i++) {
    const tool = ctx.emit({ type: 'tool_use', name: 'Bash', status: 'running', input: { command: `echo ${i}` } });
    ctx.patch(tool, { status: 'done', output: `out ${i}` });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, events: TEXT_STEPS + TOOL_STEPS + DELTAS + TOOL_STEPS };
}

const projections = (parent, child) => parent.events.filter((e) => e.brokerChildId === child.id);

test('what the parent mirrors of a child is right and attached to the child\'s card (30 000-event parent)', () => {
  const s = scene(LARGE);
  drive(s);
  const mirrored = projections(s.parent, s.child);
  assert.equal(mirrored.length, s.child.events.length - 1, 'every step of the child (not its prompt) is mirrored once');
  assert.ok(mirrored.every((e) => e.parent === s.card.id), 'every step hangs under the card');
  assert.equal(s.parent.events.filter((e) => e.type === 'tool_use' && e.subagent?.broker).length, 1, 'no second card was made');
  const texts = s.child.events.filter((e) => e.type === 'text');
  assert.equal(texts.length, TEXT_STEPS);
  for (const t of texts) {
    const m = mirrored.find((e) => e.brokerEventId === t.id);
    assert.equal(m.text, t.text, 'streamed text is identical in the parent');
    assert.match(m.text, /^\[\d+\](tok\d )+$/);
  }
  const tools = s.child.events.filter((e) => e.type === 'tool_use');
  for (const t of tools) {
    const m = mirrored.find((e) => e.brokerEventId === t.id);
    assert.equal(m.status, 'done');
    assert.equal(m.output, t.output);
  }
  assert.equal(s.child.state.broker.parentEventId, s.card.id);
  // The parent's sequence moved once per mirrored write, in order.
  const seqs = broadcasts.filter((m) => m.sid === s.parent.id).map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test('mirroring cost per child event does not depend on the parent\'s length', () => {
  // Best of three per size: the figure of interest is the code\'s own cost, not
  // a garbage collection that happened to land in one run.
  const best = (size) => {
    let b = Infinity;
    let events = 0;
    for (let r = 0; r < 3; r++) {
      const s = scene(size);
      const out = drive(s);
      events = out.events;
      b = Math.min(b, out.ms);
    }
    return { ms: b, events };
  };
  best(SMALL); // warm up the JIT on both paths before measuring
  const small = best(SMALL);
  const large = best(LARGE);
  const rate = (r) => Math.round((r.events / r.ms) * 1000);
  const line = `child events mirrored: ${small.events}; ${SMALL}-event parent ${small.ms.toFixed(1)} ms (${rate(small)}/s), ${LARGE}-event parent ${large.ms.toFixed(1)} ms (${rate(large)}/s), ratio ${(large.ms / small.ms).toFixed(2)}`;
  console.log(`BROKER-PERF ${line}`);
  assert.ok(large.ms < small.ms * 4 + 50, `cost grew with parent length: ${line}`);
  assert.ok(large.ms < 1500, `absolute cost too high: ${line}`);
});

test('mirroring cost per child event does not depend on how long the child already is', () => {
  const best = (childSize) => {
    let b = Infinity;
    let events = 0;
    for (let r = 0; r < 3; r++) {
      const out = drive(scene(SMALL, childSize));
      events = out.events;
      b = Math.min(b, out.ms);
    }
    return { ms: b, events };
  };
  best(0);
  const fresh = best(0);
  const long = best(20_000);
  const line = `child events mirrored: ${fresh.events}; child of 1 event ${fresh.ms.toFixed(1)} ms, child of 20 000 events ${long.ms.toFixed(1)} ms, ratio ${(long.ms / fresh.ms).toFixed(2)}`;
  console.log(`BROKER-PERF ${line}`);
  assert.ok(long.ms < fresh.ms * 4 + 50, `cost grew with the child's length: ${line}`);
});

// ---- what the index must not change -------------------------------------

const card = (id, text, extra = {}) => ({ id, ts: 5, type: 'tool_use', name: 'mcp__agent-hub__delegate_to_provider', status: 'running', input: { task: text }, ...extra });
const kid = (parent, id, text, link) => {
  const c = store.createSession({
    id, parentId: parent.id, agentId: 'kimi@m1', provider: 'kimi', cwd: TMP, title: text,
    modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' }, meta: { model: 'kimi/k2', effort: 'on' },
    ...(link ? { state: { broker: { parentId: parent.id, parentEventId: link } } } : {}),
  });
  c.events.push({ id: `${id}_u`, ts: 1, type: 'user', text });
  return c;
};
const plainParent = (n = 6) => {
  const p = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', provider: 'kimi', cwd: TMP, title: 'p', modelConfig: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } });
  for (let i = 0; i < n; i++) p.events.push({ id: `${p.id}_f${i}`, ts: i, type: i % 2 ? 'text' : 'user', text: `f${i}` });
  return p;
};
const step = (ctx, label) => {
  const t = ctx.emit({ type: 'text', text: `<${label}>` });
  ctx.delta(t, 'a');
  const tool = ctx.emit({ type: 'tool_use', name: 'Bash', status: 'running', input: { c: label } });
  ctx.patch(tool, { status: 'done', output: label });
  return { t, tool };
};
const mirrorsOf = (p, c) => p.events.filter((e) => e.brokerChildId === c.id);
const delegateCards = (p) => p.events.filter((e) => e.type === 'tool_use' && !e.brokerChildId && /delegate/.test(e.name || ''));

test('when a child\'s card is taken out of the parent, its steps move to the card that replaces it', () => {
  const p = plainParent();
  p.events.push(card('cardA', 'task A', { childSessionId: 's_mv', subagent: { id: 's_mv', broker: true } }), card('cardB', 'task A'));
  const c = kid(p, 's_mv', 'task A', 'cardA');
  const ctx = runner.liveContext(c);
  step(ctx, 'one');
  assert.ok(mirrorsOf(p, c).every((e) => e.parent === 'cardA'));
  p.events.splice(p.events.findIndex((e) => e.id === 'cardA'), 1); // in place, as a repair might
  step(ctx, 'two');
  const mirrors = mirrorsOf(p, c);
  assert.equal(mirrors.length, 4, 'two steps of text + tool each');
  assert.ok(mirrors.every((e) => e.parent === 'cardB'), 'the earlier steps follow the child to its new card, and so do the new ones');
  assert.equal(c.state.broker.parentEventId, 'cardB');
  assert.equal(delegateCards(p).length, 1);
});

test('a lost link makes the card appear before the child\'s first step, and every step hangs under it', () => {
  const p = plainParent();
  const c = kid(p, 's_lost', 'task L', null);
  const ctx = runner.liveContext(c);
  step(ctx, 'one');
  c.state = {}; // the saved link is lost
  step(ctx, 'two');
  const cards = delegateCards(p);
  assert.equal(cards.length, 1, 'one card, not one per call');
  const mirrors = mirrorsOf(p, c);
  assert.equal(mirrors.length, 4, 'two steps of text + tool each');
  assert.ok(mirrors.every((e) => e.parent === cards[0].id));
  assert.ok(p.events.indexOf(cards[0]) < p.events.indexOf(mirrors[0]), 'the card sits before the first step');
  assert.equal(c.state.broker.parentEventId, cards[0].id);
});

test('after the parent\'s history is replayed, later steps land under the replayed card', () => {
  const p = plainParent(3);
  p.events.push(card('cardR', 'task R', { childSessionId: 's_rp', subagent: { id: 's_rp', broker: true } }));
  const c = kid(p, 's_rp', 'task R', 'cardR');
  const cx = runner.liveContext(c);
  step(cx, 'before');
  runner.liveContext(p).replaceEvents([{ id: 'n1', ts: 1, type: 'user', text: 'hello' }, card('cardR2', 'task R', { toolCallId: 'T1' })]);
  step(cx, 'after-1');
  step(cx, 'after-2');
  const cards = delegateCards(p);
  assert.deepEqual(cards.map((x) => x.id), ['cardR2']);
  const mirrors = mirrorsOf(p, c);
  // The replay rebuilds the child's mirror from its events, prompt included.
  assert.equal(mirrors.length, c.events.length);
  assert.ok(mirrors.every((e) => e.parent === 'cardR2'));
  assert.equal(new Set(mirrors.map((e) => e.id)).size, mirrors.length, 'no step mirrored twice');
});

test('a mirror that was cut off the end of the parent is made again when the child next writes to it', () => {
  const p = plainParent();
  p.events.push(card('cardT', 'task T', { childSessionId: 's_tr', subagent: { id: 's_tr', broker: true } }));
  const c = kid(p, 's_tr', 'task T', 'cardT');
  const cx = runner.liveContext(c);
  step(cx, 'one');
  const two = step(cx, 'two');
  p.events.length -= 3; // the newest mirrors are gone
  cx.delta(two.t, 'more');
  cx.patch(two.tool, { status: 'error' });
  step(cx, 'three');
  const mirrors = mirrorsOf(p, c);
  assert.equal(new Set(mirrors.map((e) => e.id)).size, mirrors.length, 'no step mirrored twice');
  const t = mirrors.find((e) => e.brokerEventId === two.t.id);
  assert.equal(t.text, two.t.text, 'the mirror carries the child\'s whole text');
  assert.equal(mirrors.find((e) => e.brokerEventId === two.tool.id).status, 'error');
  assert.ok(mirrors.every((e) => e.parent === 'cardT'));
});

test('two children of one parent keep their steps apart while the parent grows between their writes', () => {
  const p = plainParent();
  p.events.push(card('cardX', 'task X', { childSessionId: 's_x', subagent: { id: 's_x', broker: true } }), card('cardY', 'task Y', { childSessionId: 's_y', subagent: { id: 's_y', broker: true } }));
  const x = kid(p, 's_x', 'task X', 'cardX');
  const y = kid(p, 's_y', 'task Y', 'cardY');
  const cx = runner.liveContext(x);
  const cy = runner.liveContext(y);
  for (let i = 0; i < 3; i++) {
    step(cx, `x${i}`);
    p.events.push({ id: `${p.id}_say${i}`, ts: 99, type: 'text', text: 'the parent speaks' });
    step(cy, `y${i}`);
  }
  assert.equal(mirrorsOf(p, x).length, 6);
  assert.equal(mirrorsOf(p, y).length, 6);
  assert.ok(mirrorsOf(p, x).every((e) => e.parent === 'cardX'));
  assert.ok(mirrorsOf(p, y).every((e) => e.parent === 'cardY'));
});

test('a card is not kept for a child that has since been asked something else', () => {
  const p = plainParent();
  p.events.push(card('cardK', 'task K original', { childSessionId: 's_k', subagent: { id: 's_k', broker: true } }));
  const c = kid(p, 's_k', 'task K original', 'cardK');
  const cx = runner.liveContext(c);
  step(cx, 'one');
  assert.ok(mirrorsOf(p, c).every((e) => e.parent === 'cardK'), 'while the child is doing what the card says, it keeps the card');
  c.events.push({ id: 'k_u2', ts: 9, type: 'user', text: 'a completely different follow-up' });
  step(cx, 'two');
  const now = p.events.find((e) => e.id === c.state.broker.parentEventId);
  assert.notEqual(now.id, 'cardK', 'the child moved to a card made for what it is doing now');
  assert.equal(now.input.task, 'a completely different follow-up');
  assert.ok(mirrorsOf(p, c).every((e) => e.parent === now.id), 'all of its steps follow');
});

test('when a child\'s saved link is pointed at another card, all of its earlier steps move there too', () => {
  const p = plainParent();
  p.events.push(card('cardB', 'task M', { childSessionId: 's_pt', subagent: { id: 's_pt', broker: true } }), card('cardC', 'task M'));
  const c = kid(p, 's_pt', 'task M', 'cardB');
  const cx = runner.liveContext(c);
  step(cx, 'one');
  step(cx, 'two');
  assert.ok(mirrorsOf(p, c).every((e) => e.parent === 'cardB'));
  c.state = { ...c.state, broker: { parentId: p.id, parentEventId: 'cardC' } }; // nothing in the parent's array changes
  step(cx, 'three');
  const mirrors = mirrorsOf(p, c);
  assert.equal(mirrors.length, 6);
  assert.ok(mirrors.every((e) => e.parent === 'cardC'), 'every step, old and new, hangs under the card the child now points at');
  assert.equal(p.events.find((e) => e.id === 'cardC').childSessionId, c.id, 'and that card now belongs to the child');
});
