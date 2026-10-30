// The events index must give exactly the answers the linear scans it replaced
// gave, whatever happens to the array between two questions: appends, inserts
// at any position, removals, truncation, a replaced array, duplicate ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEvent, lastUserEventWithText, syncEvents, forgetEvents } from '../server/event-index.js';

const ref = {
  find: (events, id) => (events || []).find((e) => e.id === id),
  lastUser: (events) => [...(events || [])].reverse().find((e) => e.type === 'user' && String(e.text || '').trim()),
};

// A small deterministic generator so a failure can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('findEvent answers what Array.find answers: first match, absent id, no array', () => {
  const a = { id: 'a' };
  const dup1 = { id: 'd', n: 1 };
  const dup2 = { id: 'd', n: 2 };
  const events = [a, dup1, dup2];
  assert.equal(findEvent(events, 'a'), a);
  assert.equal(findEvent(events, 'd'), dup1, 'the first of two events with one id');
  assert.equal(findEvent(events, 'nope'), undefined);
  assert.equal(findEvent(undefined, 'a'), undefined);
  assert.equal(findEvent([], 'a'), undefined);
  const noId = { x: 1 };
  assert.equal(findEvent([noId], undefined), noId, 'an undefined id matches an event without one, as find did');
});

test('an event pushed after the first question is found by the next one', () => {
  const events = [{ id: 'a' }];
  assert.equal(findEvent(events, 'b'), undefined);
  const b = { id: 'b' };
  events.push(b);
  assert.equal(findEvent(events, 'b'), b);
});

test('an element inserted among the indexed ones does not leave stale positions behind', () => {
  const events = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(findEvent(events, 'c'), events[2]);
  const x = { id: 'x' };
  events.splice(1, 0, x);
  assert.equal(findEvent(events, 'x'), x);
  assert.equal(findEvent(events, 'b'), events[2]);
  assert.equal(findEvent(events, 'c'), events[3]);
  const y = { id: 'y' };
  events.unshift(y);
  assert.equal(findEvent(events, 'y'), y);
  assert.equal(findEvent(events, 'a'), events[1]);
});

test('removing events, even when as many are appended afterwards, is noticed', () => {
  const events = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(findEvent(events, id));
  events.splice(1, 1);
  events.push({ id: 'e' });
  assert.equal(findEvent(events, 'b'), undefined, 'a removed event is gone');
  assert.equal(findEvent(events, 'e'), events[3]);
  assert.equal(findEvent(events, 'c'), events[1]);
  events.length = 1;
  assert.equal(findEvent(events, 'e'), undefined);
  events.push({ id: 'f' });
  assert.equal(findEvent(events, 'f'), events[1]);
  assert.equal(findEvent(events, 'c'), undefined);
});

test('an index entry whose event no longer has that id is never handed out', () => {
  const events = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  assert.equal(findEvent(events, 'b'), events[1]);
  // Not the first, last or middle element, so only the answer check can notice.
  events[1] = { id: 'x' };
  assert.equal(findEvent(events, 'b'), undefined, 'the id that is gone');
  assert.equal(findEvent(events, 'x'), events[1], 'and the one that took its place');
});

test('a replaced array has its own index', () => {
  let events = [{ id: 'a' }, { id: 'b' }];
  assert.ok(findEvent(events, 'b'));
  events = [{ id: 'b', fresh: true }];
  assert.equal(findEvent(events, 'b').fresh, true);
  assert.equal(findEvent(events, 'a'), undefined);
});

test('forgetEvents drops the index; the next question rebuilds it from the array', () => {
  const events = [{ id: 'a' }, { id: 'b' }];
  findEvent(events, 'b');
  events.splice(1, 0, { id: 'm' });
  forgetEvents(events);
  assert.equal(findEvent(events, 'b'), events[2]);
  forgetEvents(undefined);
});

test('lastUserEventWithText skips prompts with no words and tracks later ones', () => {
  const events = [{ id: '1', type: 'user', text: 'first' }, { id: '2', type: 'text', text: 'x' }, { id: '3', type: 'user', text: '   ' }];
  assert.equal(lastUserEventWithText(events), events[0]);
  const four = { id: '4', type: 'user', text: ' second ' };
  events.push(four);
  assert.equal(lastUserEventWithText(events), four);
  assert.equal(lastUserEventWithText([]), undefined);
  assert.equal(lastUserEventWithText(undefined), undefined);
  assert.equal(lastUserEventWithText([{ id: 'z', type: 'user', text: '' }]), undefined);
  four.text = '';
  assert.equal(lastUserEventWithText(events), events[0], 'a prompt whose words were removed no longer counts');
});

test('random sequences of appends, inserts, removals and truncations never change an answer', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    let n = 0;
    const make = () => {
      n++;
      const kind = r();
      // Ids repeat now and then so "first match" is exercised.
      const id = r() < 0.1 ? `dup${Math.floor(r() * 3)}` : `e${n}`;
      return { id, type: kind < 0.3 ? 'user' : 'text', text: r() < 0.2 ? ' ' : `t${n}` };
    };
    let events = Array.from({ length: Math.floor(r() * 20) }, make);
    for (let step = 0; step < 300; step++) {
      const op = r();
      if (op < 0.35) events.push(make());
      else if (op < 0.45) events.splice(Math.floor(r() * (events.length + 1)), 0, make());
      else if (op < 0.52) events.unshift(make());
      else if (op < 0.6 && events.length) events.splice(Math.floor(r() * events.length), 1);
      else if (op < 0.64 && events.length) events.pop();
      else if (op < 0.67) events.length = Math.floor(r() * (events.length + 1));
      else if (op < 0.7) events = events.filter(() => r() < 0.8);
      else if (op < 0.72) events = [...events, make()];
      else if (op < 0.75) forgetEvents(events);
      // Ask about ids that exist, ids that used to, and ids that never did.
      const ids = [...events.slice(0, 3), ...events.slice(-3)].map((e) => e.id);
      for (const id of [...ids, 'dup0', 'dup1', 'dup2', `e${n + 1}`, `e${Math.max(1, n - 5)}`]) {
        assert.equal(findEvent(events, id), ref.find(events, id), `seed ${seed} step ${step} id ${id}`);
      }
      assert.equal(lastUserEventWithText(events), ref.lastUser(events), `seed ${seed} step ${step} last user`);
    }
  }
});

test('syncEvents on an unchanged array does no new work and keeps the same index', () => {
  const events = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, type: 'text' }));
  const a = syncEvents(events, { ids: true });
  const b = syncEvents(events, { ids: true });
  assert.equal(a, b);
  assert.equal(a.n, 1000);
  assert.equal(a.idN, 1000);
  events.push({ id: 'more', type: 'user', text: 'hi' });
  const c = syncEvents(events, { ids: true });
  assert.equal(c, a, 'an append extends the same index');
  assert.equal(c.n, 1001);
  assert.equal(c.users.length, 1);
});
