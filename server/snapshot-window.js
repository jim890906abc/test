// What of a conversation goes into a snapshot. Opening a conversation used to
// send every event it ever had (tens of megabytes for a long one, mostly tool
// output); the page then had to read, parse and draw all of it before showing
// the newest message. Now the snapshot is a window on the end of the chain:
//
//   - at most `turns` of the latest turns (a turn starts at a top-level user
//     message), at most `events` events, at most `bytes` bytes, whichever is
//     reached first; the latest turn is kept whole up to `latestBytes` /
//     `latestEvents`, so what is happening now is readable in full;
//   - a field above `fieldBytes` inside a window event is replaced by a
//     preview of `previewBytes` and the event says so (`truncated`); the whole
//     event is one request away. Only what is SENT is cut, never what is
//     stored, and an event that may still grow (running, or at the live end of
//     a busy conversation) is never cut: its deltas must be able to continue it.
//
// The functions work on "items" ({ ev, node, nodeIndex }, see store.chainItems)
// in chain order. An event's position in that list is its index: the window
// says where it starts (`firstIndex`), a page asks for what is before an index.
import { Buffer } from 'node:buffer';
import { annotate } from './store.js';
import { artifactOf } from './artifacts.js';

// Tunable without a code change (AGENT_HUB_WINDOW_*, AGENT_HUB_PAGE_*, …).
export const DEFAULTS = Object.freeze({
  turns: 6, // latest turns in a snapshot
  bytes: 300 * 1024, // …and at most this much JSON
  events: 500, // …and at most this many events (what the page has to draw)
  latestBytes: 1024 * 1024, // the latest turn is kept whole up to this size
  latestEvents: 800,
  pageEvents: 100, // an older page, when the caller names no limit
  pageMaxEvents: 500, // …and the most it may ask for
  pageBytes: 300 * 1024, // …and at most this much JSON
  fieldBytes: 16 * 1024, // a field above this is cut to a preview
  previewBytes: 4 * 1024,
  liveTail: 24, // the newest events of a busy conversation are never cut
  ancestors: 50, // cards outside the window sent along with it (see outsideOf)
  questionBytes: 600, // the question before the window, as much of it as is sent
});

export function configFromEnv(env = process.env) {
  const n = (name, dflt) => {
    const v = Number(env[name]);
    return Number.isInteger(v) && v > 0 ? v : dflt;
  };
  return Object.freeze({
    turns: n('AGENT_HUB_WINDOW_TURNS', DEFAULTS.turns),
    bytes: n('AGENT_HUB_WINDOW_BYTES', DEFAULTS.bytes),
    events: n('AGENT_HUB_WINDOW_EVENTS', DEFAULTS.events),
    latestBytes: n('AGENT_HUB_WINDOW_LATEST_BYTES', DEFAULTS.latestBytes),
    latestEvents: n('AGENT_HUB_WINDOW_LATEST_EVENTS', DEFAULTS.latestEvents),
    pageEvents: n('AGENT_HUB_PAGE_EVENTS', DEFAULTS.pageEvents),
    pageMaxEvents: n('AGENT_HUB_PAGE_MAX_EVENTS', DEFAULTS.pageMaxEvents),
    pageBytes: n('AGENT_HUB_PAGE_BYTES', DEFAULTS.pageBytes),
    fieldBytes: n('AGENT_HUB_FIELD_LIMIT', DEFAULTS.fieldBytes),
    previewBytes: n('AGENT_HUB_PREVIEW_BYTES', DEFAULTS.previewBytes),
    liveTail: n('AGENT_HUB_LIVE_TAIL', DEFAULTS.liveTail),
    ancestors: n('AGENT_HUB_WINDOW_ANCESTORS', DEFAULTS.ancestors),
    questionBytes: n('AGENT_HUB_QUESTION_BYTES', DEFAULTS.questionBytes),
  });
}
export const CONFIG = configFromEnv();

const byteLen = (s) => Buffer.byteLength(s);

// A string cut to at most `max` bytes of UTF-8, on a character boundary.
export function cutBytes(str, max) {
  if (str.length * 3 <= max) return str; // even 3 bytes a character fits
  const buf = Buffer.from(str.slice(0, max)); // at least `max` bytes unless the string is shorter
  if (buf.length <= max) return str.slice(0, max);
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // not in the middle of a character
  return buf.subarray(0, end).toString('utf8');
}

// The same shape with every long string cut: the page still gets the object
// it expects (a command, a path, a todo list), only the long text is a preview.
function shorten(value, max) {
  if (typeof value === 'string') return cutBytes(value, max);
  if (Array.isArray(value)) return value.map((x) => shorten(x, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shorten(v, max);
    return out;
  }
  return value;
}

// Fields that are shown as they are or not at all: a cut image is broken.
const KEEP_WHOLE = new Set(['images']);

const LIVE_STATUS = new Set(['pending', 'running', 'awaiting']);
// An event that can still receive deltas or patches.
export const isLiveEvent = (ev) => LIVE_STATUS.has(ev.status) || LIVE_STATUS.has(ev.subagent?.status);

// A page the agent wrote (Write / Edit on an .html file) is shown by the
// Artifact panel from the event's own input, so it is sent whole. Which events
// those are is the Artifact rule itself (artifacts.js), not a copy of it.
export const isArtifactEvent = (ev) => artifactOf(ev) !== null;

// The event as it goes out, and what it costs. An event whose fields are all
// small is returned as it is (the same object). `live` events are never cut.
export function slimEvent(ev, cfg = CONFIG, { live = false } = {}) {
  const bytes = byteLen(JSON.stringify(ev));
  if (live || bytes <= cfg.fieldBytes || isArtifactEvent(ev)) return { ev, bytes, truncated: null };
  let out = null;
  const fields = {};
  for (const [key, v] of Object.entries(ev)) {
    if (KEEP_WHOLE.has(key) || v == null || (typeof v !== 'string' && typeof v !== 'object')) continue;
    const size = typeof v === 'string' ? byteLen(v) : byteLen(JSON.stringify(v));
    if (size <= cfg.fieldBytes) continue;
    let short = shorten(v, cfg.previewBytes);
    // Still big (a long list of small things): an empty value of the same kind.
    if (typeof short === 'object' && byteLen(JSON.stringify(short)) > cfg.fieldBytes) short = Array.isArray(short) ? [] : {};
    (out ??= { ...ev })[key] = short;
    fields[key] = size;
  }
  if (!out) return { ev, bytes, truncated: null };
  const [field, size] = Object.entries(fields).sort((a, b) => b[1] - a[1])[0];
  const truncated = { bytes: size, field, fields };
  out.truncated = truncated;
  return { ev: out, bytes: byteLen(JSON.stringify(out)), truncated };
}

const isTurnStart = (ev) => ev.type === 'user' && !ev.parent;

// Walks back from `end` (an index; the item at `end` is not taken) collecting
// events while the limits allow, always at least one. Returns them oldest
// first with the index of the first.
function collect(items, end, { maxEvents, maxBytes, turns = Infinity, latest = null, liveFrom = Infinity, cfg }) {
  let lastTurn = -1;
  if (latest) for (let i = items.length - 1; i >= 0; i--) if (isTurnStart(items[i].ev)) { lastTurn = i; break; }
  const picked = [];
  let bytes = 0;
  let seen = 0;
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const it = items[i];
    const r = slimEvent(it.ev, cfg, { live: i >= liveFrom || isLiveEvent(it.ev) });
    const inLatest = lastTurn >= 0 && i >= lastTurn;
    const byteLimit = inLatest ? Math.max(maxBytes, latest.bytes) : maxBytes;
    const eventLimit = inLatest ? Math.max(maxEvents, latest.events) : maxEvents;
    if (picked.length && (bytes + r.bytes > byteLimit || picked.length >= eventLimit)) break;
    picked.push({ item: it, ev: r.ev });
    bytes += r.bytes;
    start = i;
    if (isTurnStart(it.ev) && ++seen >= turns) break;
  }
  picked.reverse();
  return { events: picked.map((p) => annotate(p.item, p.ev)), firstIndex: start, bytes };
}

// Index of the first of the newest `liveTail` events when the conversation is
// busy (its stream is still adding to them); nothing when it is idle.
export const liveFrom = (total, busy, cfg = CONFIG) => (busy ? Math.max(0, total - cfg.liveTail) : Infinity);

// What the events of a window refer to that is not in it, because the window
// is only the newest part. The page works out some of what it shows from the
// events it holds, and these are the three things that go missing:
//   - `question`: the newest message of the person before the window (id, ts,
//     the start of its text). What the page pins above an answer, and what the
//     busy clock counts from, when the window holds no message of its own;
//   - `ancestors`: the cards the window's events belong to (a step inside a
//     subagent whose card is older than the window), and, while the
//     conversation is working, every subagent card still at work, whether or
//     not a step of it is in the window. Without the card the steps have
//     nowhere to be shown and the subagent is not counted as working. They are
//     sent as the page would get them in a window (a long field cut), oldest
//     first, at most `cfg.ancestors` (the newest), each with `stepsBefore`
//     when some of its tool calls lie before the window.
// null when there is nothing to say.
export function outsideOf(items, firstIndex, events, { busy = false, cfg = CONFIG } = {}) {
  if (firstIndex <= 0) return null;
  const out = {};
  for (let i = firstIndex - 1; i >= 0; i--) {
    const ev = items[i].ev;
    if (!isTurnStart(ev)) continue;
    out.question = { id: ev.id, ts: ev.ts, text: cutBytes(String(ev.text ?? ''), cfg.questionBytes), ...(ev.images?.length ? { images: ev.images.length } : {}) };
    break;
  }
  const held = new Set(events.map((e) => e.id));
  const wanted = new Set();
  for (const e of events) if (e.parent && !held.has(e.parent)) wanted.add(e.parent);
  if (wanted.size || busy) {
    const found = [];
    const steps = new Map(); // card id -> its tool calls before the window
    // Newest first: a parent is older than its steps, so walking back meets
    // each one after the step that names it and its own parent after it.
    for (let i = firstIndex - 1; i >= 0 && (busy || wanted.size); i--) {
      const ev = items[i].ev;
      if (ev.parent && ev.type === 'tool_use') steps.set(ev.parent, (steps.get(ev.parent) || 0) + 1);
      const asked = wanted.delete(ev.id);
      const working = busy && !ev.parent && ev.type === 'tool_use' && (ev.subagent?.status === 'running' || ev.subagent?.status === 'pending');
      if (!asked && !working) continue;
      found.push({ item: items[i], before: steps.get(ev.id) || 0 });
      if (ev.parent && !held.has(ev.parent)) wanted.add(ev.parent);
    }
    found.reverse();
    // `stepsBefore`: how many of the card's tool calls lie before the window, so
    // the card does not claim only as many steps as the page holds.
    for (const { item, before } of found.slice(-cfg.ancestors)) (out.ancestors ??= []).push({ ...annotate(item, slimEvent(item.ev, cfg, { live: isLiveEvent(item.ev) }).ev), ...(before ? { stepsBefore: before } : {}) });
  }
  return out.question || out.ancestors ? out : null;
}

// The window of a snapshot: the end of the chain.
export function latestWindow(items, { busy = false, cfg = CONFIG } = {}) {
  const r = collect(items, items.length, {
    maxEvents: cfg.events,
    maxBytes: cfg.bytes,
    turns: cfg.turns,
    latest: { bytes: cfg.latestBytes, events: cfg.latestEvents },
    liveFrom: liveFrom(items.length, busy, cfg),
    cfg,
  });
  return { events: r.events, window: { total: items.length, firstIndex: r.firstIndex, hasEarlier: r.firstIndex > 0 }, outside: outsideOf(items, r.firstIndex, r.events, { busy, cfg }) };
}

// A page of older events: what lies before index `before`.
export function pageBefore(items, before, { limit, busy = false, cfg = CONFIG } = {}) {
  const end = Math.min(Math.max(0, before), items.length);
  const max = Math.min(Math.max(1, limit ?? cfg.pageEvents), cfg.pageMaxEvents);
  if (!end) return { events: [], firstIndex: 0, hasEarlier: false, total: items.length };
  const r = collect(items, end, { maxEvents: max, maxBytes: cfg.pageBytes, liveFrom: liveFrom(items.length, busy, cfg), cfg });
  return { events: r.events, firstIndex: r.firstIndex, hasEarlier: r.firstIndex > 0, total: items.length };
}

// One event, as the page would get it in a snapshot, or whole.
export function oneEvent(item, { full = false, cfg = CONFIG } = {}) {
  return annotate(item, full ? item.ev : slimEvent(item.ev, cfg, { live: isLiveEvent(item.ev) }).ev);
}
