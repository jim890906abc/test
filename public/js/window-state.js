// What the page works out for itself from the events of a window, kept free of
// the DOM so the rules can be tested directly in node. A window is only the
// newest part of a conversation (the Hub sends no more); `outside` is what the
// Hub says about the part before it (see server/snapshot-window.js outsideOf).

// When the turn now running began: the newest message of the person. A turn
// longer than the window has that message before it, and the Hub names it
// (outside.question). A step inside a subagent is not the person's message.
// Without either, now: a clock that starts when the page does is better than
// none.
export function turnStartTs(events, outside, now = Date.now()) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'user' && !e.parent) return e.ts || now;
  }
  const ts = outside?.question?.ts;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : now;
}
