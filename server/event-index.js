// A lookup index over a conversation's `events` array, so the broker mirror
// does not scan the whole conversation for every streamed token.
//
// A parent conversation can hold tens of thousands of events, and every delta
// or tool event of every broker child asks the same questions about it: where
// is the card this child hangs under, does this step already have its mirror,
// do all of this child's steps hang under that card. Answering each by walking
// the array made the cost of one streamed token grow with the length of the
// parent.
//
// The index is only an accelerator: it must never change an answer. The
// events array stays the single source of truth, and the index is rebuilt from
// it whenever it can no longer be trusted:
//   - Every answer is checked against the array before it is returned
//     (`events[i].id === id`), so a stale entry can never be handed out.
//   - The array only ever grows at its end (push) or has one element spliced
//     in; both leave the elements the index already saw where they were, or
//     move the last one, which the guard below notices. A shorter array, or a
//     different first / middle / last element than the index remembers, throws
//     the whole index away and it is rebuilt from the array.
//   - An array that is replaced (`session.events = [...]`) is a different
//     object and starts with no index at all.
// Elements are never replaced in place and an event's `id` / `type` never
// change after it is in the array; that is the one assumption the index adds
// to what the callers already relied on.
//
// The id table is only built for arrays somebody looks events up in by id (a
// parent conversation); a child's own array only keeps its prompts.

const caches = new WeakMap();

class Cache {
  constructor() {
    this.n = 0; // how many leading elements the guards and `users` have seen
    this.first = undefined;
    this.last = undefined;
    this.probeAt = 0; // one more element from the middle, remembered like the first and last
    this.probe = undefined;
    this.users = []; // the 'user' events, oldest first
    this.byId = null; // id -> index of the first event with that id, once asked for
    this.idN = 0; // how many leading elements `byId` has seen
    this.reparented = new Map(); // child id -> { cardId, n }: its steps verified under that card up to n
  }
}

// Bring the index up to date with `events` (reading only what was appended
// since the last call) and return it.
export function syncEvents(events, { ids = false } = {}) {
  let c = caches.get(events);
  if (c && c.n > 0 && (c.n > events.length || events[c.n - 1] !== c.last || events[0] !== c.first || events[c.probeAt] !== c.probe)) c = null;
  if (!c) {
    c = new Cache();
    caches.set(events, c);
  }
  for (let i = c.n; i < events.length; i++) if (events[i]?.type === 'user') c.users.push(events[i]);
  if (events.length > c.n) {
    c.n = events.length;
    c.first = events[0];
    c.last = events[c.n - 1];
    c.probeAt = c.n >> 1;
    c.probe = events[c.probeAt];
  }
  if (ids) {
    if (!c.byId) c.byId = new Map();
    for (let i = c.idN; i < events.length; i++) {
      const id = events[i]?.id;
      if (id !== undefined && !c.byId.has(id)) c.byId.set(id, i);
    }
    c.idN = events.length;
  }
  return c;
}

// Forget what is known about `events`: for a caller that has just changed the
// array in a way that moves elements already indexed.
export function forgetEvents(events) {
  if (events) caches.delete(events);
}

// Same answer as `events.find((e) => e.id === id)`.
export function findEvent(events, id) {
  if (!events) return undefined;
  if (id === undefined) return events.find((e) => e.id === id);
  let c = syncEvents(events, { ids: true });
  let i = c.byId.get(id);
  if (i === undefined) return undefined;
  if (events[i]?.id !== id) {
    // The array changed under the index in a way the guards did not see.
    caches.delete(events);
    c = syncEvents(events, { ids: true });
    i = c.byId.get(id);
    if (i === undefined) return undefined;
  }
  return events[i];
}

// Same answer as `[...events].reverse().find((e) => e.type === 'user' && String(e.text || '').trim())`,
// without walking everything between the end and the first prompt.
export function lastUserEventWithText(events) {
  if (!events) return undefined;
  const users = syncEvents(events).users;
  for (let i = users.length - 1; i >= 0; i--) if (String(users[i].text || '').trim()) return users[i];
  return undefined;
}
