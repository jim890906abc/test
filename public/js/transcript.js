// The conversation view. Events arrive one at a time (event / patch / delta)
// and each maps to one DOM node that is re-rendered in place, at most once
// per animation frame, so long conversations stay fast while streaming.
// Subagent events carry `parent` and render inside their Agent card; while
// that card is closed they are not rendered at all (only its summary line
// is), and catch up when it is opened. Nothing here walks the whole
// conversation per update: children and the newest row of each parent are
// indexed as events arrive.
import { h, fill, icon, fmtDuration } from './dom.js';
import { markdownInto, MarkdownStream, renderMarkdown, renderLineDiff, diffStats } from './markdown.js';
import { artifactOf, collectArtifacts, mergeArtifactIndex, artifactCard } from './artifacts.js';
import { agentLife, subagentModelView, lifeBadge } from './agent-state.js';
import { TOOLS, INTERNAL_TITLE, agentName, agentDescription, activityOf, lastShown } from './agent-activity.js';

// The verbs tool calls are shown with live in agent-activity.js (the cluster page uses them too).
export { TOOLS };

const ACTIVE = ['pending', 'running', 'awaiting'];
// Rows drawn right away when a conversation opens (what fills the screen
// and a little more); the rest of the window follows a slice at a time.
const NOW = 40;
// Text longer than this, while it is being written, is drawn a block at a time.
const STREAM_MIN = 1500;
// A copy of the whole conversation (a Hub that does not cut it into windows)
// is shown as its newest LEGACY_TAIL events; the rest is kept aside and
// drawn as you scroll up, CHUNK events at a time, like a windowed one.
const LEGACY_TAIL = 240;
const CHUNK = 80;
// How far above the top of the view the "earlier messages" marker starts a
// load, and how many loads in a row one look at the top may start.
const EARLIER_MARGIN = 700;
const EARLIER_RUN = 12;
// The most slices the pinned question is loaded through (a turn this long has thousands of events).
const PROMPT_PAGES = 200;
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
// Look-around tools: a run of them folds into one line, like Claude Code.
const LOOK = /^(Read|ReadFile|ReadMediaFile|Glob|Grep|FetchURL|WebFetch|WebSearch|SearchWeb)$/;
const lineCount = (t) => (t ? String(t).replace(/\n+$/, '').split('\n').length : 0);
const isAgent = (ev) => Boolean(ev.subagent) || /^(Agent|AgentSwarm|Task)$/.test(ev.name) || /(^|__)delegate_to_provider$/.test(ev.name || '');
const isTodo = (ev) => /^(TodoList|TodoWrite|SetTodoList)$/.test(ev.name);
// Claude's web search and fetch (run by the Claude API) come back as
// "title\n  url" per search result, or "title\nurl" for the fetched page.
function webLinks(ev) {
  if (!/^(WebSearch|WebFetch)$/.test(ev.name) || ev.status !== 'done') return null;
  const lines = String(ev.output || '').trim().split('\n').map((l) => l.trim());
  const url = (l) => /^https?:\/\/\S+$/.test(l || '');
  if (lines.length === 1 && url(lines[0])) return [{ title: lines[0], url: lines[0] }];
  const links = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (!url(lines[i + 1])) return null;
    links.push({ title: lines[i] || lines[i + 1], url: lines[i + 1] });
  }
  return links.length ? links : null;
}
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
// Following the newest message: back on when you reach the end by
// scrolling down (within this many pixels), off as soon as you scroll up.
const STICK_PX = 32;
// After you scroll up, reaching the end again within this long does not
// count: the end moves while Kimi writes.
const UP_GRACE_MS = 600;
// How often a subagent card is checked against the clock.
const LIFE_CHECK_MS = 5000;
// Browsers keep what is on screen in place when rows above change height
// (scroll anchoring); where one does not, the transcript does it itself.
const NATIVE_ANCHOR = typeof CSS !== 'undefined' && CSS.supports?.('overflow-anchor', 'auto');

const sameValue = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

export class Transcript {
  // opts: { cwd, agentName ('Kimi' | 'Claude'), onRespond(ev, optionId, extra), onOpenArtifact(path, versionId), onCopy }
  constructor(opts) {
    this.opts = opts;
    this.column = h('div', { class: 'column' });
    this.working = h('div', { class: 'working', hidden: true });
    // Back to the newest message when scrolled up (lit when more arrived).
    this.jump = h('button', { class: 'jump-end', type: 'button', title: '到最新訊息', 'aria-label': '到最新訊息', onclick: () => this.toEnd() }, icon('down'));
    this.jumpBar = h('div', { class: 'jump-bar', hidden: true }, this.jump);
    // The question being answered on screen, once it has scrolled out of
    // view above (like Claude Code's CLI): click to go back to it.
    this.pinText = h('span', { class: 'prompt-pin-text' });
    this.pin = h('button', { class: 'prompt-pin', type: 'button', title: '跳到這個問題', onclick: () => this.toPrompt() }, icon('up'), this.pinText);
    this.pinBar = h('div', { class: 'prompt-pin-bar', hidden: true }, this.pin);
    // "Earlier messages": the top of the conversation when more exists than is
    // drawn. Reaching it (a screenful before) loads the next slice.
    this.earlierText = h('span', { class: 'earlier-text' }, '載入更早的訊息');
    this.earlierBtn = h('button', { class: 'earlier-btn', type: 'button', onclick: () => ((this.olderFailed = false), this.loadOlder(true)) }, this.earlierText);
    this.earlier = h('div', { class: 'earlier', hidden: true }, this.earlierBtn);
    this.fullBusy = new Set(); // events whose whole content is being fetched
    this.fullFailed = new Set();
    this.fullIds = new Set(); // events fetched whole: a fresh copy's short preview must not replace them
    // Cards older than the window that steps inside the window belong to, or
    // subagents still at work (the Hub sends them with the window). Held, drawn
    // above everything else, but not part of `order`: the held events are one
    // run of the conversation and what is asked for next starts at its first.
    this.above = new Set();
    this.stepsOlder = new Map(); // card id -> its tool calls before the window that are not held yet (the Hub counts them)
    this.question = null; // the person's message before the window: { id, ts, text, images? }, until it is loaded
    this.reserve = []; // older events kept aside (a copy that arrived whole), oldest first
    this.firstIndex = 0; // the position, in the whole conversation, of the oldest event held
    this.hasEarlier = false; // a Hub that windows has older events than are held
    this.gen = 0; // bumped when the held events are replaced, so a late answer is dropped
    this.host = null; // where new rows are mounted (the column, or a fragment while older ones are built)
    this.users = []; // top-level user message ids, in order
    this.agentIds = []; // top-level subagent calls
    this.mainTools = []; // top-level tool calls
    this.kids = new Map(); // parent id -> ids of its direct children, in order
    this.lastOf = new Map(); // parent id ('' for the top) -> its newest child
    this.deferred = new Set(); // dirty, but inside a closed subagent card
    // Until the first copy of the conversation arrives: grey bars that fade in
    // after a moment (a quick answer never shows them).
    this.skeleton = h('div', { class: 'transcript-skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
    this.el = h('div', { class: 'transcript', tabindex: '-1' }, this.pinBar, this.earlier, this.skeleton, this.column, this.working, this.jumpBar);
    this.events = new Map();
    this.order = [];
    this.nodes = new Map();
    this.waiting = new Map(); // parent id -> child ids that arrived first
    this.groupOf = new Map(); // event id -> the look-around group it sits in
    this.dirtyGroups = new Set();
    this.dirty = new Set();
    this.open = new Set(); // ids the user expanded
    this.shut = new Set(); // ids the user collapsed
    this.stick = true;
    this.raf = 0;
    this.status = 'idle';
    // Whether to follow the newest message is decided by what you do, not
    // by where the view happens to be: text arriving between two scroll
    // events, or the area under the conversation changing size, must never
    // count as you scrolling away — and a small scroll up (a trackpad sends
    // a few pixels at a time) must count at once, before the next bit of
    // text pulls the view back down.
    this.upAt = 0;
    this.downAt = 0;
    this.lastTop = 0;
    this.lastHeight = 0;
    this.lastClient = 0;
    const up = () => {
      this.upAt = performance.now();
      this.setStick(false);
    };
    const down = () => (this.downAt = performance.now());
    this.el.addEventListener(
      'wheel',
      (e) => {
        // Scrolling a box of its own inside (a long command's output) is not
        // scrolling the conversation.
        if (this.innerScroller(e.target, e.deltaY)) return;
        if (e.deltaY < 0) up();
        else if (e.deltaY > 0) down();
      },
      { passive: true },
    );
    let touchY = null;
    this.el.addEventListener('touchstart', (e) => (touchY = e.touches[0]?.clientY ?? null), { passive: true });
    this.el.addEventListener(
      'touchmove',
      (e) => {
        const y = e.touches[0]?.clientY;
        if (y == null || touchY == null) return;
        if (y > touchY + 2) up(); // finger down: the view goes up
        else if (y < touchY - 2) down();
        touchY = y;
      },
      { passive: true },
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) up();
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(e.key)) down();
    });
    this.el.addEventListener('scroll', () => {
      const top = this.el.scrollTop;
      const height = this.el.scrollHeight;
      const client = this.el.clientHeight;
      const fromEnd = height - top - client;
      // The view only moves up by itself when the end comes closer (the
      // conversation got shorter, or the view taller). Moving up otherwise
      // is you: a finger, the scrollbar, a key, finding text.
      const nearer = height < this.lastHeight - 1 || client > this.lastClient + 1;
      if (top < this.lastTop - 1 && !nearer) up();
      else if (fromEnd <= STICK_PX) {
        // At the end: following again, unless you have just scrolled up.
        if (!this.stick && (this.downAt > this.upAt || performance.now() - this.upAt > UP_GRACE_MS)) this.setStick(true);
      }
      this.lastTop = top;
      this.lastHeight = height;
      this.lastClient = client;
      if (!this.stick && !NATIVE_ANCHOR) this.pickAnchor();
      this.pinRaf ||= requestAnimationFrame(() => ((this.pinRaf = 0), this.updatePin()));
    });
    this.tick = setInterval(() => this.renderWorking(), 1000);
    // A subagent's spinner has to stop by itself when its evidence runs out
    // (nothing arrives to tell the page), so the cards are looked at again.
    this.lifeSeen = new Map(); // agent id -> the state its card was drawn for
    this.lifeTick = setInterval(() => this.recheckAgents(), opts.lifeCheckMs || LIFE_CHECK_MS);
    // Links in Kimi's replies to local files (a page it wrote) open in the
    // panel instead of a browser tab.
    this.el.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || !this.column.contains(a) || e.metaKey || e.ctrlKey) return;
      if (this.opts.onLink?.(a.getAttribute('href'))) e.preventDefault();
    });
    // Following the end is done here, after the browser has laid the page
    // out anyway, rather than right after each change: reading the height
    // then would make it lay out the whole conversation an extra time per
    // frame. Covers the column growing and the view itself resizing.
    this.resize = new ResizeObserver(() => (this.stick ? this.scrollToEnd() : NATIVE_ANCHOR || this.keepAnchor()));
    this.resize.observe(this.column);
    this.resize.observe(this.working);
    this.resize.observe(this.el);
    // Reaching the top (a screenful before it) loads the slice before.
    this.olderRun = 0;
    if (typeof IntersectionObserver !== 'undefined') {
      this.topWatch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && this.loadOlder(), { root: this.el, rootMargin: `${EARLIER_MARGIN}px 0px 0px 0px` });
      this.topWatch.observe(this.earlier);
    }
    // Scrolling by hand starts the count of automatic loads again.
    this.el.addEventListener('scroll', () => (this.olderRun = 0), { passive: true });
  }

  destroy() {
    this.gen++;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.pinRaf);
    clearTimeout(this.backlogTimer);
    clearInterval(this.tick);
    clearInterval(this.lifeTick);
    this.resize.disconnect();
    this.topWatch?.disconnect();
    // The node and event tables are the heavy part; a transcript that is
    // kept alive by something (a closure, a pending callback) must not hold
    // the conversation with it.
    for (const node of this.nodes.values()) if (node.mdTimer) clearTimeout(node.mdTimer);
    this.events.clear();
    this.nodes.clear();
    this.above.clear();
    this.order = [];
    this.reserve = [];
    this.backlog = [];
    this.column.replaceChildren();
  }

  // A conversation's events, all at once: when it opens, and again whenever
  // the page takes a fresh copy (reconnecting, having fallen behind). A
  // fresh copy of what is already shown only updates what changed, so the
  // view stays as it is; one that does not line up is drawn anew, back at
  // the same place if you had scrolled up.
  //
  // `info.window` ({ total, firstIndex, hasEarlier }) says the events are only
  // the newest part of a longer conversation (the Hub cuts them into windows);
  // earlier ones come from `opts.fetchEarlier` as you scroll up. A copy that
  // arrives whole is cut the same way here: its newest LEGACY_TAIL events are
  // drawn and the rest is held back (`reserve`) for the same scroll.
  load(events, info = {}) {
    const win = info.window && typeof info.window === 'object' ? info.window : null;
    const outside = win && info.outside && typeof info.outside === 'object' ? info.outside : null;
    const ancestors = Array.isArray(outside?.ancestors) ? outside.ancestors : [];
    const question = outside?.question && typeof outside.question === 'object' && typeof outside.question.id === 'string' ? outside.question : null;
    let reserve = [];
    let first = win ? Number(win.firstIndex) : 0;
    // Where the copy lines up with what is already held, if it does: a
    // window starts somewhere inside the held events (or at their start), a
    // whole copy has the first held event somewhere inside it.
    let at = -1;
    if (this.order.length && events.length) {
      if (win) {
        const p = this.order.indexOf(events[0].id);
        if (p !== -1 && this.order.length - p <= events.length && this.order.slice(p).every((id, i) => events[i].id === id)) {
          this.holdAncestors(ancestors);
          // The question before the window is the one before the first event held only when the window starts there.
          if (p === 0) this.question = question;
          this.reconcile(events, p);
          if (p === 0) this.setEarlier(first, win.hasEarlier ?? first > 0);
          this.schedulePin();
          return;
        }
      } else {
        const j = events.findIndex((e) => e.id === this.order[0]);
        if (j !== -1 && this.order.length <= events.length - j && this.order.every((id, i) => events[j + i].id === id)) at = j;
      }
    }
    if (at !== -1) {
      // Whole copy: what is held is its newest part; the rest stays aside.
      reserve = events.slice(0, at);
      this.reconcile(events.slice(at), 0);
      this.reserve = reserve;
      this.setEarlier(reserve.length, reserve.length > 0, true);
      return;
    }
    if (!win && events.length > LEGACY_TAIL) {
      reserve = events.slice(0, events.length - LEGACY_TAIL);
      events = events.slice(-LEGACY_TAIL);
    }
    const spot = this.order.length && !this.stick ? this.viewSpot() : null;
    this.skeleton?.remove();
    this.skeleton = null;
    this.gen++;
    this.events.clear();
    this.order = [];
    this.nodes.clear();
    this.waiting.clear();
    this.groupOf.clear();
    this.users = [];
    this.agentIds = [];
    this.mainTools = [];
    this.kids.clear();
    this.lastOf.clear();
    this.deferred.clear();
    this.dirty.clear();
    this.dirtyGroups.clear();
    this.pinBar.hidden = true;
    this.column.replaceChildren();
    this.above.clear();
    this.stepsOlder.clear();
    this.question = question;
    this.groupEls = new WeakMap();
    clearTimeout(this.backlogTimer);
    this.olderBusy = false;
    this.olderFailed = false;
    this.fullIds.clear();
    this.fullBusy.clear();
    this.fullFailed.clear();
    this.holdAncestors(ancestors);
    for (const ev of events) this.add(ev, true);
    // The newest part (what is on screen, at the bottom) is drawn now; the
    // rest after it, a slice at a time, so a long conversation shows at once
    // and stays responsive while the older part fills in.
    const all = [...this.dirty];
    const keep = new Set(all.slice(-NOW));
    for (const id of this.above) keep.add(id);
    // Where you were reading is drawn now too.
    const i = spot?.id ? all.indexOf(spot.id) : -1;
    if (i !== -1) for (const id of all.slice(Math.max(0, i - NOW / 2), i + NOW / 2)) keep.add(id);
    this.backlog = all.filter((id) => !keep.has(id));
    this.dirty = keep;
    for (const id of keep) {
      const p = this.events.get(id)?.parent;
      if (p) keep.add(p); // a card shows its latest step
    }
    this.flush();
    if (spot) this.backTo(spot);
    else this.scrollToEnd();
    if (this.backlog.length) this.backlogTimer = setTimeout(() => this.drawBacklog(), 0);
    this.reserve = reserve;
    if (win) this.setEarlier(first, win.hasEarlier ?? first > 0);
    else this.setEarlier(reserve.length, reserve.length > 0, true);
    this.schedulePin();
  }

  // A fresh copy of the newest events lines up with the held ones from
  // `from`: update what changed, add what is new. The older part is untouched.
  reconcile(events, from) {
    for (let i = from; i < this.order.length; i++) {
      const old = this.events.get(this.order[i]);
      const ev = events[i - from];
      if (ev.truncated && this.fullIds.has(ev.id)) continue;
      const changed = {};
      for (const k of Object.keys(ev)) if (!sameValue(old[k], ev[k])) changed[k] = ev[k];
      for (const k of Object.keys(old)) if (!(k in ev)) changed[k] = undefined;
      if (Object.keys(changed).length) this.patch(ev.id, changed);
    }
    for (const ev of events.slice(this.order.length - from)) this.add(ev);
  }

  // The cards the Hub sent along with a window (see `above`), oldest first.
  // One already held is only brought up to date; the rest go above everything
  // else, in the order given.
  holdAncestors(list) {
    const fresh = [];
    for (const ev of list) {
      if (!ev || typeof ev.id !== 'string') continue;
      if (this.events.has(ev.id)) this.patch(ev.id, ev);
      else fresh.push(ev);
    }
    if (!fresh.length) return;
    const top = document.createDocumentFragment();
    const agents = [];
    const calls = [];
    for (const ev of fresh) {
      this.above.add(ev.id);
      if (ev.stepsBefore > 0) this.stepsOlder.set(ev.id, ev.stepsBefore);
      this.events.set(ev.id, ev);
      if (ev.type === 'tool_use' && !ev.parent && isAgent(ev)) agents.push(ev.id);
      if (ev.type === 'tool_use' && !ev.parent) calls.push(ev.id);
      if (ev.parent) (this.kids.get(ev.parent) || this.kids.set(ev.parent, []).get(ev.parent)).push(ev.id);
      const node = this.makeNode(ev);
      this.nodes.set(ev.id, node);
      const parent = ev.parent && this.nodes.get(ev.parent);
      (parent?.children || top).append(node.el);
      this.markDirty(ev.id, true);
    }
    this.agentIds.unshift(...agents);
    this.mainTools.unshift(...calls); // what a foreground subagent card is: a call Kimi is waiting on
    this.column.insertBefore(top, this.column.firstChild);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  // What is held reaches back to position `index` of the conversation, and
  // there is (or is not) more before it.
  setEarlier(index, has, local = false) {
    this.firstIndex = index;
    this.hasEarlier = Boolean(has);
    this.localEarlier = local; // true: the older events are in `reserve`, not on the Hub
    this.drawEarlier();
  }

  canLoadOlder() {
    return this.reserve.length > 0 || (this.hasEarlier && !this.localEarlier && this.firstIndex > 0 && typeof this.opts.fetchEarlier === 'function');
  }

  drawEarlier() {
    const can = this.canLoadOlder();
    this.earlier.hidden = !can;
    this.earlier.classList.toggle('busy', Boolean(this.olderBusy));
    this.earlier.classList.toggle('failed', Boolean(this.olderFailed));
    this.earlierText.textContent = this.olderFailed ? '載入失敗，點這裡重試' : this.olderBusy ? '載入更早的訊息…' : '載入更早的訊息';
  }

  // The next slice of older events, drawn above the held ones without
  // moving what is on screen. `manual`: the button was pressed.
  async loadOlder(manual = false) {
    if (this.olderBusy || !this.canLoadOlder()) return;
    if (!manual && (this.olderFailed || this.olderRun >= EARLIER_RUN)) return;
    if (!manual) this.olderRun++;
    const gen = this.gen;
    this.olderBusy = true;
    this.drawEarlier();
    let chunk;
    let first = this.firstIndex;
    let has = false;
    try {
      if (this.reserve.length) {
        chunk = this.reserve.splice(-CHUNK);
        first = this.reserve.length;
        has = first > 0;
      } else {
        const r = await this.opts.fetchEarlier({ before: this.firstIndex, beforeId: this.order[0], limit: CHUNK });
        chunk = Array.isArray(r?.events) ? r.events : [];
        first = Number.isFinite(Number(r?.firstIndex)) ? Number(r.firstIndex) : Math.max(0, this.firstIndex - chunk.length);
        has = Boolean(r?.hasEarlier ?? first > 0) && chunk.length > 0;
      }
    } catch {
      if (gen === this.gen) (this.olderBusy = false), (this.olderFailed = true), this.drawEarlier();
      return;
    }
    if (gen !== this.gen) return; // the conversation was replaced meanwhile
    this.olderBusy = false;
    this.prepend(chunk);
    this.setEarlier(first, has, this.localEarlier);
    // Still near the top (the slice was short, or all hidden rows): go on, a bounded number of times.
    requestAnimationFrame(() => {
      if (gen !== this.gen || !this.canLoadOlder()) return;
      const near = this.earlier.getBoundingClientRect().bottom > this.el.getBoundingClientRect().top - EARLIER_MARGIN;
      if (near) this.loadOlder();
    });
  }

  // Events older than every held one, oldest first. Built off-screen in a
  // fragment, put in above, and the view put back where it was.
  prepend(events) {
    // A card held above everything (see `above`) whose own place is in this
    // slice goes back there, keeping the steps it already shows.
    const steps = new Map();
    for (const ev of events) {
      if (!this.above.has(ev.id)) continue;
      const node = this.nodes.get(ev.id);
      steps.set(ev.id, [...node.children.childNodes]);
      node.el.remove();
      this.nodes.delete(ev.id);
      this.events.delete(ev.id);
      this.above.delete(ev.id);
      this.stepsOlder.delete(ev.id); // its own place is here: every step before the window is held by now
      const at = this.agentIds.indexOf(ev.id);
      if (at !== -1) this.agentIds.splice(at, 1);
      const call = this.mainTools.indexOf(ev.id);
      if (call !== -1) this.mainTools.splice(call, 1);
      const siblings = ev.parent && this.kids.get(ev.parent);
      const k = siblings ? siblings.indexOf(ev.id) : -1;
      if (k !== -1) siblings.splice(k, 1);
    }
    const fresh = events.filter((e) => !this.events.has(e.id));
    if (!fresh.length) return;
    for (const e of fresh) if (e.parent && e.type === 'tool_use' && this.stepsOlder.has(e.parent)) this.stepsOlder.set(e.parent, Math.max(0, this.stepsOlder.get(e.parent) - 1));
    const fromEnd = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
    const grew = this.grew;
    const kept = { order: this.order, users: this.users, agentIds: this.agentIds, mainTools: this.mainTools, kids: this.kids, lastOf: this.lastOf, dirty: this.dirty };
    this.order = [];
    this.users = [];
    this.agentIds = [];
    this.mainTools = [];
    this.kids = new Map();
    this.lastOf = new Map();
    this.dirty = new Set();
    const host = document.createDocumentFragment();
    this.host = host;
    this.attachLater = [];
    this.attachFirst = new Map();
    for (const ev of fresh) this.add(ev, true);
    this.host = null;
    this.grew = grew; // older events are not news
    // A step whose card is held already: it goes after the ones that came with the slice.
    for (const [parent, kid] of this.attachLater) this.nodes.get(parent)?.children.append(this.nodes.get(kid).el);
    this.attachLater = null;
    // …and the steps a card held above everything had already come after the older ones that arrive now.
    for (const [id, els] of steps) this.nodes.get(id)?.children.append(...els);
    for (const [parent, els] of this.attachFirst) this.nodes.get(parent)?.children.prepend(...els);
    this.attachFirst = null;
    const chunkDirty = [...this.dirty];
    this.order = [...this.order, ...kept.order];
    this.users = [...this.users, ...kept.users];
    // Cards held above everything are older than any slice: they stay first.
    this.agentIds = [...kept.agentIds.filter((id) => this.above.has(id)), ...this.agentIds, ...kept.agentIds.filter((id) => !this.above.has(id))];
    this.mainTools = [...kept.mainTools.filter((id) => this.above.has(id)), ...this.mainTools, ...kept.mainTools.filter((id) => !this.above.has(id))];
    for (const [p, list] of kept.kids) this.kids.set(p, [...(this.kids.get(p) || []), ...list]);
    for (const [p, id] of kept.lastOf) this.lastOf.set(p, id);
    this.dirty = kept.dirty;
    // A read/search run cut by the edge of the slice is one row, as it would be whole.
    const tail = host.lastElementChild && this.groupEls?.get(host.lastElementChild);
    const head = this.column.firstElementChild && this.groupEls?.get(this.column.firstElementChild);
    if (tail && head && tail !== head) {
      tail.members.push(...head.members);
      for (const id of head.members) this.groupOf.set(id, tail);
      tail.body.append(...head.body.childNodes);
      head.el.remove();
      this.dirtyGroups.add(tail);
    }
    this.column.insertBefore(host, this.column.firstChild);
    // The newest part of the slice (just above the screen) is drawn now, the rest after.
    const now = chunkDirty.slice(-NOW);
    const rest = chunkDirty.slice(0, -NOW);
    this.renderIds(now);
    this.backlog = [...rest, ...(this.backlog || [])];
    if (this.backlog.length && !this.backlogTimer) this.backlogTimer = setTimeout(() => this.drawBacklog(), 0);
    this.el.scrollTop = this.el.scrollHeight - this.el.clientHeight - fromEnd;
    this.lastTop = this.el.scrollTop;
    this.lastHeight = this.el.scrollHeight;
    this.lastClient = this.el.clientHeight;
    if (this.artifactsChanged) {
      this.artifactsChanged = false;
      this.opts.onArtifacts?.(this.artifacts(), { older: true });
    }
    this.schedulePin();
    // Subagents came in with the slice: the tray's count of those at work is not the one it was.
    if (fresh.some((e) => e.type === 'tool_use' && isAgent(e))) this.opts.onFlush?.([]);
  }

  renderIds(ids) {
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (this.insideClosed(node.ev)) this.deferred.add(id);
      else this.render(node);
    }
    for (const g of this.dirtyGroups) this.renderGroup(g);
    this.dirtyGroups.clear();
  }

  // The row at the top of the view and how far from the end it is.
  viewSpot() {
    this.pickAnchor();
    const a = this.anchor;
    return { id: a?.el.dataset.id || null, y: a?.y || 0, fromEnd: this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight };
  }

  backTo(at) {
    const el = at.id && this.nodes.get(at.id)?.el;
    if (el?.isConnected) this.el.scrollTop += el.getBoundingClientRect().top - this.el.getBoundingClientRect().top - at.y;
    else this.el.scrollTop = this.el.scrollHeight - this.el.clientHeight - at.fromEnd;
    this.lastTop = this.el.scrollTop;
    this.lastHeight = this.el.scrollHeight;
    this.lastClient = this.el.clientHeight;
    this.pickAnchor();
  }

  drawBacklog() {
    this.backlogTimer = 0;
    const end = performance.now() + 8;
    while (this.backlog.length && performance.now() < end) {
      const id = this.backlog.pop(); // newest first: nearest to the view
      const node = this.nodes.get(id);
      if (!node) continue;
      if (this.insideClosed(node.ev)) this.deferred.add(id);
      else this.render(node);
      // Something to do for the person (a key, a click) comes before the rest.
      if (navigator.scheduling?.isInputPending?.()) break;
    }
    for (const g of this.dirtyGroups) this.renderGroup(g);
    this.dirtyGroups.clear();
    if (this.stick) this.scrollToEnd();
    if (this.backlog.length) this.backlogTimer = setTimeout(() => this.drawBacklog(), 0);
  }

  add(ev, batch = false) {
    if (this.events.has(ev.id)) return this.patch(ev.id, ev);
    this.events.set(ev.id, ev);
    this.order.push(ev.id);
    this.grew = true;
    if (ev.type === 'user' && !ev.parent) this.users.push(ev.id);
    if (ev.type === 'tool_use' && !ev.parent && isAgent(ev)) this.agentIds.push(ev.id);
    if (ev.type === 'tool_use' && !ev.parent) this.mainTools.push(ev.id);
    if (ev.parent) {
      const list = this.kids.get(ev.parent);
      if (list) list.push(ev.id);
      else this.kids.set(ev.parent, [ev.id]);
    }
    this.lastOf.set(ev.parent || '', ev.id);
    const node = this.makeNode(ev);
    this.nodes.set(ev.id, node);
    this.mount(node);
    this.markDirty(ev.id, batch);
    if (ev.parent) this.markDirty(ev.parent, batch); // parent shows the latest activity
    if (artifactOf(ev)) this.artifactsChanged = true;
  }

  patch(id, fields) {
    const ev = this.events.get(id);
    if (!ev) return;
    const wasAgent = isAgent(ev);
    Object.assign(ev, fields);
    // The MCP tool call may arrive before its child session links the
    // subagent data. It becomes a card (and a work count) the moment it does.
    if (!wasAgent && isAgent(ev) && ev.type === 'tool_use' && !ev.parent && !this.agentIds.includes(id)) {
      const at = this.order.indexOf(id);
      const i = this.agentIds.findIndex((x) => this.order.indexOf(x) > at);
      this.agentIds.splice(i === -1 ? this.agentIds.length : i, 0, id);
    }
    this.markDirty(id);
    if (ev.parent) this.markDirty(ev.parent);
    if (ev.type === 'tool_use' && (artifactOf(ev) || 'input' in fields)) this.artifactsChanged = true;
  }

  delta(id, field, text) {
    const ev = this.events.get(id);
    if (!ev) return;
    ev[field] = (ev[field] || '') + text;
    this.grew = true;
    this.markDirty(id);
    if (ev.parent) this.markDirty(ev.parent);
    if (field === 'argsText' && artifactOf(ev)) this.artifactsChanged = true;
  }

  get(id) {
    return this.events.get(id);
  }

  all() {
    return this.order.map((id) => this.events.get(id));
  }

  // What the agent said last, whole: its newest text (not a subagent's) with
  // something in it. Looked for in the events held, then in the part held
  // aside, then, a slice at a time without drawing anything, in the part the
  // Hub has not sent (a turn can end in a long run of tool calls, with the last
  // reply before them). A reply the Hub sent as a preview is fetched whole.
  // null when there is none.
  async lastReply(maxSlices = 100) {
    const pick = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.type === 'text' && !e.parent && e.text?.trim()) return e;
      }
      return null;
    };
    let ev = pick(this.all()) || pick(this.reserve);
    let before = this.firstIndex;
    let beforeId = this.order[0];
    for (let n = 0; !ev && n < maxSlices && this.hasEarlier && !this.localEarlier && before > 0 && typeof this.opts.fetchEarlier === 'function'; n++) {
      const r = await this.opts.fetchEarlier({ before, beforeId, limit: CHUNK });
      const list = Array.isArray(r?.events) ? r.events : [];
      if (!list.length) break;
      ev = pick(list);
      before = Number.isFinite(Number(r.firstIndex)) ? Number(r.firstIndex) : before - list.length;
      beforeId = list[0].id;
      if (!r.hasEarlier) break;
    }
    if (!ev) return null;
    if (ev.truncated && this.opts.fetchFull) {
      try {
        const whole = await this.opts.fetchFull(ev);
        if (typeof whole?.text === 'string') return whole.text;
      } catch {
        // the preview is all there is
      }
    }
    return ev.text;
  }

  // The pages this conversation made. From the events held, plus: the older
  // part a copy that arrived whole keeps aside (`reserve`), and the Hub's list
  // of pages over the whole conversation (setArtifactIndex), for the part it
  // never sent because it sends only the newest window.
  artifacts() {
    const held = this.reserve.length ? [...this.reserve, ...this.all()] : this.all();
    return mergeArtifactIndex(collectArtifacts(held), this.artifactIndex);
  }

  // The Hub's list of artifact events over the whole conversation arrived.
  // Pages found in it are older than anything on screen: not news.
  setArtifactIndex(entries) {
    this.artifactIndex = Array.isArray(entries) ? entries : null;
    this.opts.onArtifacts?.(this.artifacts(), { older: true });
  }

  // The model that produced the last response (Claude), shown while working.
  setServed(name) {
    this.served = name || '';
    if (this.servedEl) this.servedEl.textContent = this.served ? ` · ${this.served}` : '';
  }

  setStatus(status, since, tps) {
    const changed = this.status !== status || !this.statusKnown;
    this.status = status;
    this.statusKnown = true;
    if (since) this.since = since;
    if (tps !== undefined) this.tps = tps;
    this.renderWorking();
    // The last open thinking/tool rows reflect whether Kimi is still going.
    for (const id of this.order.slice(-6)) this.markDirty(id);
    // Whether a subagent is still working depends on whether the conversation is.
    if (changed) for (const id of this.agentIds) this.markDirty(id);
  }

  markDirty(id, batch) {
    this.dirty.add(id);
    const g = this.groupOf.get(id);
    if (g) this.dirtyGroups.add(g);
    if (!batch && !this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.raf = 0;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (this.insideClosed(node.ev)) this.deferred.add(id);
      else this.render(node);
    }
    for (const g of this.dirtyGroups) this.renderGroup(g);
    this.dirtyGroups.clear();
    if (this.artifactsChanged) {
      this.artifactsChanged = false;
      this.opts.onArtifacts?.(this.artifacts());
    }
    if (!this.stick && this.grew) this.jump.classList.add('new');
    this.grew = false;
    this.opts.onFlush?.(ids);
  }

  scrollToEnd() {
    this.el.scrollTop = this.el.scrollHeight;
    this.lastTop = this.el.scrollTop;
    this.lastHeight = this.el.scrollHeight;
    this.lastClient = this.el.clientHeight;
  }

  // A box inside the conversation that scrolls by itself and still can in
  // this direction.
  innerScroller(target, dy) {
    for (let n = target; n && n !== this.el; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return n;
    }
    return null;
  }

  setStick(on) {
    if (this.stick === on) return;
    this.stick = on;
    this.jumpBar.hidden = on;
    if (on) this.jump.classList.remove('new');
    else if (!NATIVE_ANCHOR) this.pickAnchor();
  }

  // Where the browser does not keep what is on screen in place itself: the
  // first row reaching into view, and where it is, so that rows above
  // changing height (drawn for the first time, a card opening) can be made
  // up for.
  pickAnchor() {
    const rows = this.column.children;
    const top = this.el.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid].getBoundingClientRect();
      if (r.bottom > top) (found = rows[mid]), (hi = mid - 1);
      else lo = mid + 1;
    }
    this.anchor = found ? { el: found, y: found.getBoundingClientRect().top - top } : null;
  }

  keepAnchor() {
    const a = this.anchor;
    if (!a?.el.isConnected) return this.pickAnchor();
    const shift = a.el.getBoundingClientRect().top - this.el.getBoundingClientRect().top - a.y;
    if (Math.abs(shift) >= 1) {
      this.el.scrollTop += shift;
      this.lastTop = this.el.scrollTop;
    }
  }

  // Subagents still working (background ones included), for the tray
  // under the conversation: what each is doing right now.
  runningAgents() {
    return this.agentList(true);
  }

  // How many are still working, without looking at their steps.
  runningCount() {
    let n = 0;
    for (const id of this.agentIds) if (this.events.has(id) && this.agentLife(this.events.get(id)).running) n++;
    return n;
  }

  // What Kimi is waiting on right now (a foreground subagent or command):
  // what 移到背景 (Ctrl+B) would move. Only the latest calls can be.
  foregroundCount() {
    let n = 0;
    for (const id of this.mainTools.slice(-40)) {
      const ev = this.events.get(id);
      if (ev && ['pending', 'running'].includes(ev.status) && !ev.subagent?.background && !ev.input?.run_in_background) n++;
    }
    return n;
  }

  // Inside a subagent card that is closed (at any depth): not on screen.
  insideClosed(ev) {
    let p = ev.parent;
    while (p) {
      const pe = this.events.get(p);
      if (!pe) return false;
      if (isAgent(pe) && !this.agentOpen(pe)) return true;
      p = pe.parent;
    }
    return false;
  }

  // Subagent cards start closed, but open by themselves while one of their
  // steps waits for you (an approval or a question).
  agentOpen(ev) {
    return this.expanded(ev, this.childrenOf(ev.id).some((k) => k.permission && !k.permission.chosen));
  }

  // A card was opened: what changed inside it while closed is drawn now.
  reveal() {
    for (const id of this.deferred) {
      const ev = this.events.get(id);
      if (ev && !this.insideClosed(ev)) {
        this.deferred.delete(id);
        this.markDirty(id);
      }
    }
  }

  // ------------------------------------------------- what a subagent is doing

  // The conversation's status, when it is known. A transcript that was never
  // told is not evidence of an idle conversation.
  sessionStatus() {
    const v = this.opts?.sessionStatus?.();
    if (v !== undefined && v !== null) return v;
    return this.statusKnown ? this.status : undefined;
  }

  // Newest sign of life from a subagent: its own event or its newest step.
  lastActivity(id) {
    const ev = this.events.get(id);
    const newest = this.events.get(this.lastOf.get(id) || '');
    return Math.max(ev?.ts || 0, newest?.parent === id ? newest.ts || 0 : 0);
  }

  // What the card may claim about one subagent: whether it is alive, and the
  // model it ran on. Cards and the 子代理 panel both come through here.
  agentLife(ev) {
    return agentLife(ev, { sessionStatus: this.sessionStatus(), childStatus: this.opts?.childStatus, lastActivity: this.lastActivity(ev.id) || undefined, limits: this.opts?.limits });
  }

  agentView(ev) {
    const life = this.agentLife(ev);
    const model = subagentModelView(ev, life, { modelName: this.opts?.modelName, effortLabel: this.opts?.effortLabel, limits: this.opts?.limits });
    return { life, model };
  }

  // The names of models came in (the catalog loaded): cards redraw with them.
  refreshAgents() {
    for (const id of this.agentIds) this.markDirty(id);
  }

  // Cards whose evidence changed with the clock alone are drawn again.
  recheckAgents() {
    for (const id of this.agentIds) {
      const ev = this.events.get(id);
      if (!ev) continue;
      const { life, model } = this.agentView(ev);
      if (this.lifeSeen.get(id) !== `${life.state}|${life.reason}|${model.waiting}`) this.markDirty(id);
    }
  }

  // Every subagent this conversation started (newest last), or only the
  // ones still working.
  agentList(onlyRunning = false) {
    const out = [];
    for (const id of this.agentIds) {
      const ev = this.events.get(id);
      if (!ev) continue;
      const { life, model } = this.agentView(ev);
      if (onlyRunning && !life.running) continue;
      const sub = ev.subagent || {};
      const kids = this.childrenOf(id);
      const activity = activityOf(lastShown(kids));
      out.push({
        id,
        name: agentName(sub),
        // Without a description, the first line of the task it was given.
        description: agentDescription(ev, sub),
        activity,
        steps: this.stepCount(id, kids),
        background: Boolean(sub.background),
        life,
        badge: lifeBadge(life),
        modelView: model,
        running: life.running,
        failed: life.failed,
        stopped: life.stopped,
        unknown: life.unknown,
        done: life.done,
        summary: life.running ? '' : sub.summary || '',
      });
    }
    return out;
  }

  // A card's tool calls: the ones held, and the ones before the window that the Hub counted.
  stepCount(id, kids = this.childrenOf(id)) {
    // (`?.`: a Transcript built without its constructor, as the broker tests do, has no such table)
    return kids.filter((k) => k.type === 'tool_use').length + (this.stepsOlder?.get(id) || 0);
  }

  childrenOf(id) {
    return (this.kids.get(id) || []).map((k) => this.events.get(k)).filter(Boolean);
  }

  // Everything a subagent did (its nested subagents included), oldest first.
  descendants(agentId) {
    const inside = new Set([agentId]);
    const out = [];
    for (const id of this.order) {
      const ev = this.events.get(id);
      if (ev.parent && inside.has(ev.parent)) {
        inside.add(id);
        out.push(ev);
      }
    }
    return out;
  }

  // Open a subagent's card and bring it into view.
  focusAgent(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.open.add(id);
    this.shut.delete(id);
    this.markDirty(id);
    this.reveal();
    this.upAt = performance.now();
    this.setStick(false);
    node.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // The pin is worked out when the view moves (scroll) and when what is held
  // changes under a view that does not: once per frame at most, never per event.
  schedulePin() {
    this.pinRaf ||= requestAnimationFrame(() => ((this.pinRaf = 0), this.updatePin()));
  }

  // The newest question whose bubble is entirely above the visible area. When
  // no question held is above it, the one before the window (the Hub names it)
  // is: the answer on screen is the answer to it.
  updatePin() {
    // Under the bar itself counts as out of view.
    const top = this.el.getBoundingClientRect().top + (this.pinBar.hidden ? 0 : this.pin.offsetHeight) + 4;
    let found = null;
    for (let i = this.users.length - 1; i >= 0; i--) {
      const el = this.nodes.get(this.users[i])?.el;
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= top) {
        found = this.users[i];
        break;
      }
    }
    const ask = !found && this.question && !this.events.has(this.question.id) ? this.question : null;
    this.pinned = found || null;
    this.pinBar.hidden = !found && !ask;
    const ev = found ? this.events.get(found) : ask;
    if (ev) this.pinText.textContent = (ev.text || (ev.images?.length || ev.images ? `${ev.images?.length ?? ev.images} 張圖片` : '')).replace(/\s+/g, ' ').trim();
    this.pinAsk = ask?.id || null;
  }

  // Back to the pinned question. One that is still before the window is loaded
  // first, a slice at a time, with the pin saying so.
  async toPrompt() {
    const wanted = this.pinAsk || this.pinned;
    if (this.pinAsk && !this.nodes.has(this.pinAsk)) {
      const gen = this.gen;
      this.pin.classList.add('busy');
      this.pin.disabled = true;
      for (let i = 0; i < PROMPT_PAGES && gen === this.gen && !this.nodes.has(wanted) && this.canLoadOlder() && !this.olderFailed; i++) {
        while (this.olderBusy && gen === this.gen) await new Promise((r) => setTimeout(r, 40));
        await this.loadOlder(true);
      }
      this.pin.classList.remove('busy');
      this.pin.disabled = false;
      if (gen !== this.gen) return;
    }
    const el = wanted && this.nodes.get(wanted)?.el;
    if (!el) return;
    this.upAt = performance.now();
    this.setStick(false);
    const y = el.getBoundingClientRect().top - this.el.getBoundingClientRect().top + this.el.scrollTop - this.pin.offsetHeight - 12;
    this.el.scrollTo({ top: Math.max(0, y) });
  }

  toEnd() {
    this.downAt = performance.now();
    this.setStick(true);
    this.scrollToEnd();
  }

  // ------------------------------------------------------------ nodes

  makeNode(ev) {
    const el = h('div', { class: `ev ev-${ev.type}`, dataset: { id: ev.id } });
    const node = { ev, el, children: null };
    if (ev.type === 'tool_use') {
      node.head = h('div', { class: 'tool-head' });
      node.body = h('div', { class: 'tool-body' });
      node.children = h('div', { class: 'tool-children' });
      el.append(node.head, node.body, node.children);
    }
    return node;
  }

  mount(node) {
    const { ev } = node;
    if (ev.parent) {
      const parent = this.nodes.get(ev.parent);
      if (parent?.children) {
        // An older step of a card held above everything goes before the steps it shows.
        if (this.attachFirst && this.above.has(ev.parent)) (this.attachFirst.get(ev.parent) || this.attachFirst.set(ev.parent, []).get(ev.parent)).push(node.el);
        else parent.children.append(node.el);
      } else {
        const list = this.waiting.get(ev.parent) || [];
        list.push(ev.id);
        this.waiting.set(ev.parent, list);
      }
    } else if ((ev.type === 'tool_use' && LOOK.test(ev.name)) || ev.type === 'thinking') this.joinGroup(node);
    else (this.host || this.column).append(node.el);
    const kids = this.waiting.get(ev.id);
    if (kids && node.children) {
      this.waiting.delete(ev.id);
      // While older events are being put in, the steps already held come after theirs.
      if (this.attachLater) for (const k of kids) this.attachLater.push([ev.id, k]);
      else for (const k of kids) node.children.append(this.nodes.get(k).el);
    }
  }

  render(node) {
    const ev = node.ev;
    switch (ev.type) {
      case 'user':
        return this.renderUser(node);
      case 'text': {
        if (!node.md) node.el.append((node.md = h('div', { class: 'md' })));
        // Drawn already, as it is now, and not a reply being written: nothing to
        // parse. (The newest rows are marked again whenever the conversation
        // starts or stops working; a 100 kB reply must not be parsed each time.)
        if (!node.stream && node.drawn === ev.text && node.md.firstChild) {
          this.truncMark(node);
          return;
        }
        const t = performance.now();
        if (this.isLive(ev) && ev.text?.length > STREAM_MIN) {
          // A long reply still being written: only its last block is drawn
          // again, and no more often than it can afford (a fifth of the
          // time at most), so typing and scrolling stay smooth.
          const gap = Math.min(250, Math.max(0, 3 * (node.mdCost || 0) - 16));
          if (t - (node.mdAt || 0) < gap) {
            node.mdTimer ??= setTimeout(() => ((node.mdTimer = null), this.markDirty(ev.id)), gap);
            return;
          }
          (node.stream ??= new MarkdownStream(node.md)).update(ev.text);
        } else {
          // Anything else (short, or finished) is drawn whole.
          node.stream = null;
          markdownInto(node.md, ev.text);
        }
        node.drawn = node.stream ? null : ev.text;
        node.mdAt = t;
        node.mdCost = performance.now() - t;
        node.el.hidden = !ev.text?.trim();
        this.truncMark(node);
        return;
      }
      case 'thinking':
        return this.renderThinking(node);
      case 'tool_use':
        return this.renderTool(node);
      case 'info':
        if (ev.more) return fill(node.el, h('button', { class: 'om-btn om-btn--sm load-earlier', type: 'button', onclick: (e) => ((e.currentTarget.disabled = true), this.opts.onLoadEarlier?.()) }, '載入更早的對話'));
        return fill(node.el, h('span', { class: 'note' }, ev.text));
      case 'error':
        return fill(node.el, h('div', { class: 'callout danger' }, icon('alert'), h('div', { class: 'callout-text' }, ev.text)));
      case 'turn_end': {
        // Claude: which model(s) actually answered this turn.
        const by = (ev.models || []).map((m) => m.name || m.id).join('、');
        node.el.hidden = !(ev.interrupted || ev.error || by);
        const what = ev.restarted ? '中控台重新啟動，這一輪被中斷了' : ev.interrupted ? '已中斷' : ev.error ? '這一輪沒有完成' : '';
        return fill(node.el, h('span', { class: 'note', title: (ev.models || []).map((m) => m.id).join('\n') }, [what, by ? `由 ${by} 回覆` : ''].filter(Boolean).join(' · ')));
      }
      default:
        node.el.hidden = true;
    }
  }

  renderUser(node) {
    const ev = node.ev;
    const images = (ev.images || []).map((src) => (src ? h('img', { class: 'user-img', src, alt: '附加的圖片', loading: 'lazy', onclick: () => this.opts.onImage?.(src) }) : h('span', { class: 'user-img placeholder' }, icon('image'), '圖片')));
    const note = [ev.note, ev.steered ? `在 ${this.name()} 工作時插入` : null].filter(Boolean).join(' · ');
    fill(
      node.el,
      h('div', { class: 'bubble' }, images.length ? h('div', { class: 'user-imgs' }, images) : null, ...userText(ev.text)),
      note ? h('div', { class: 'bubble-note' }, note) : null,
    );
  }

  renderThinking(node) {
    const ev = node.ev;
    const live = this.isLive(ev);
    const open = this.open.has(ev.id);
    fill(
      node.el,
      h(
        'button',
        { class: `fold${live ? ' live' : ''}`, type: 'button', 'aria-expanded': String(open), onclick: () => this.toggle(ev.id, open) },
        icon('brain'),
        h('span', null, live ? '思考中' : '思考過程'),
        icon('chev', 'chev'),
      ),
      open ? h('div', { class: 'thinking-text' }, ev.text) : null,
      open && ev.truncated ? this.truncNote(ev) : null,
    );
  }

  // ------------------------------------------------------ cut-short content
  // The Hub may send a very long field (a command's output, a file) as a
  // short preview marked `truncated: { field, bytes }`. The row says so, and
  // opening it fetches the whole thing.

  truncNote(ev) {
    const t = ev.truncated || {};
    const bytes = Number(t.bytes) || 0;
    const busy = this.fullBusy.has(ev.id);
    const failed = this.fullFailed.has(ev.id);
    return h(
      'div',
      { class: 'trunc-note' },
      h('span', null, `內容很長${bytes ? `（${fmtSize(bytes)}）` : ''}，這裡只顯示前面一段。`),
      this.opts.fetchFull ? h('button', { class: 'om-btn om-btn--sm trunc-btn', type: 'button', disabled: busy, onclick: () => this.loadFull(ev.id) }, busy ? '載入中…' : failed ? '載入失敗，再試一次' : '載入完整內容') : null,
    );
  }

  // Keeps the note under a text row in step with the event.
  truncMark(node) {
    const ev = node.ev;
    if (ev.truncated) {
      const note = this.truncNote(ev);
      if (node.trunc) node.trunc.replaceWith(note);
      else node.el.append(note);
      node.trunc = note;
    } else if (node.trunc) {
      node.trunc.remove();
      node.trunc = null;
    }
  }

  async loadFull(id) {
    const ev = this.events.get(id);
    if (!ev || this.fullBusy.has(id) || !this.opts.fetchFull) return;
    this.fullBusy.add(id);
    this.fullFailed.delete(id);
    this.markDirty(id);
    const gen = this.gen;
    try {
      const full = await this.opts.fetchFull(ev);
      if (gen !== this.gen || !full || typeof full !== 'object') throw new Error('no event');
      const fields = {};
      for (const k of Object.keys(full)) if (k !== 'id' && k !== 'truncated') fields[k] = full[k];
      fields.truncated = undefined;
      this.fullIds.add(id);
      this.patch(id, fields);
    } catch {
      this.fullFailed.add(id);
    }
    this.fullBusy.delete(id);
    this.markDirty(id);
  }

  name() {
    return this.opts.agentName || 'Kimi';
  }

  // The newest unfinished row while the agent is working.
  isLive(ev) {
    return this.status === 'running' && this.lastOf.get(ev.parent || '') === ev.id;
  }

  toggle(id, wasOpen) {
    if (wasOpen) (this.open.delete(id), this.shut.add(id));
    else (this.open.add(id), this.shut.delete(id));
    if (id.startsWith('g:')) this.markDirty(id.slice(2));
    else this.markDirty(id);
    if (!wasOpen) this.reveal();
  }

  expanded(ev, byDefault) {
    if (this.open.has(ev.id)) return true;
    if (this.shut.has(ev.id)) return false;
    return byDefault;
  }

  // ------------------------------------------------------------ groups
  // Reads, searches and the thinking between them collapse into one row
  // ("讀取 3 個檔案、搜尋 2 次") that opens to show each step.

  joinGroup(node) {
    const host = this.host || this.column;
    const last = host.lastElementChild;
    let g = last && this.groupEls?.get(last);
    if (!g) {
      g = { id: `g:${node.ev.id}`, members: [], head: h('div', { class: 'tool-head' }), body: h('div', { class: 'group-body' }) };
      g.el = h('div', { class: 'ev tool-group' }, g.head, g.body);
      (this.groupEls ??= new WeakMap()).set(g.el, g);
      host.append(g.el);
    }
    g.members.push(node.ev.id);
    g.body.append(node.el);
    this.groupOf.set(node.ev.id, g);
    this.dirtyGroups.add(g);
  }

  renderGroup(g) {
    const evs = g.members.map((id) => this.events.get(id));
    const tools = evs.filter((e) => e.type === 'tool_use');
    const solo = tools.length < 2;
    g.el.className = `ev tool-group ${solo ? `solo ev-${(tools[0] || evs[0]).type}` : 'ev-tool_use'}`;
    if (solo) {
      fill(g.head);
      g.body.hidden = false;
      return;
    }
    const busy = tools.some((e) => ACTIVE.includes(e.status) && this.status === 'running');
    const urgent = tools.some((e) => e.status === 'error' || (e.permission && !e.permission.chosen));
    const open = urgent || this.expanded({ id: g.id }, false);
    const n = (re) => tools.filter((e) => re.test(e.name)).length;
    const parts = [
      [n(/^Read/), (k) => `讀取 ${k} 個檔案`],
      [n(/^Grep$/), (k) => `搜尋 ${k} 次`],
      [n(/^Glob$/), (k) => `找檔案 ${k} 次`],
      [n(/^(WebSearch|SearchWeb)$/), (k) => `搜尋網路 ${k} 次`],
      [n(/^(FetchURL|WebFetch)$/), (k) => `讀取 ${k} 個網頁`],
    ]
      .filter(([k]) => k)
      .map(([k, f]) => f(k));
    const current = busy ? tools.at(-1) : null;
    fill(
      g.head,
      h(
        'button',
        { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => !urgent && this.toggle(g.id, open) },
        h('span', { class: 'tool-icon' }, icon('search')),
        h('span', { class: 'tool-verb' }, parts.join('、')),
        h('span', { class: 'tool-target' }, current ? this.target(current) : null),
        busy ? h('span', { class: 'spinner', 'aria-label': '執行中' }) : null,
        urgent ? null : icon('chev', 'chev'),
      ),
    );
    g.body.hidden = !open;
  }

  // ------------------------------------------------------------- tools

  renderTool(node) {
    const ev = node.ev;
    const [ic, verb] = TOOLS[ev.name] || ['bolt', ev.name.replace(/^mcp__/, '').replace(/__/g, ' · ')];
    const waiting = ev.permission && !ev.permission.chosen;
    const art = artifactOf(ev);
    node.el.className = `ev ev-tool_use tool status-${ev.status}${waiting ? ' waiting' : ''}${isAgent(ev) ? ' agent' : ''}${ev.parent ? ' nested' : ''}`;

    // Drawn some other way: the cached row below no longer stands.
    if ((art && !waiting) || (isTodo(ev) && (ev.todos || ev.input?.todos)) || isAgent(ev)) node.headOf = null;
    if (art && !waiting) return this.renderArtifactTool(node, art);
    if (isTodo(ev) && (ev.todos || ev.input?.todos)) return this.renderTodos(node);
    if (isAgent(ev)) return this.renderAgent(node, ic, verb);
    node.headKey = null;

    const open = waiting || this.expanded(ev, ['Edit', 'MultiEdit', 'StrReplaceFile'].includes(ev.name) || ev.status === 'error');
    // The row itself changes far less often than the output under it.
    const head = node.headOf;
    if (!head || head.input !== ev.input || head.status !== ev.status || head.title !== ev.title || head.open !== open || head.waiting !== waiting || head.permission !== ev.permission || head.args !== Boolean(ev.argsText) || head.name !== ev.name) {
      node.headOf = { input: ev.input, status: ev.status, title: ev.title, open, waiting, permission: ev.permission, args: Boolean(ev.argsText), name: ev.name };
      fill(
        node.head,
        h(
          'button',
          { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => !waiting && this.toggle(ev.id, open) },
          h('span', { class: 'tool-icon' }, icon(ic)),
          h('span', { class: 'tool-verb' }, verb),
          h('span', { class: 'tool-target' }, this.target(ev)),
          this.meta(ev),
          this.statusMark(ev),
          waiting ? null : icon('chev', 'chev'),
        ),
      );
    }
    fill(node.body, ...(open ? this.toolBody(ev) : this.peek(ev)));
    if (open && ev.truncated) node.body.append(this.truncNote(ev));
    if (waiting) node.body.append(this.permissionUI(ev));
    else if (ev.permission?.chosen && !/^approved/.test(ev.permission.chosen)) node.body.append(this.permissionResult(ev));
  }

  target(ev) {
    const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
    const rel = (p) => {
      const cwd = this.opts.cwd;
      return cwd && p?.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
    };
    if (ev.name === 'Bash' || ev.name === 'Shell') {
      const cmd = (input.command || ev.title || '').split('\n')[0];
      // Claude says what a command does: that, with the command in the card.
      return input.description ? h('span', { title: cmd }, input.description) : h('code', null, cmd);
    }
    if (input.path || input.file_path) return h('code', null, rel(input.path || input.file_path));
    if (ev.name === 'CodeExecution' && (input.code || input.command)) return h('code', null, String(input.code || input.command).split('\n')[0]);
    if (input.pattern) return h('code', null, input.pattern);
    if (input.url) return h('span', null, input.url);
    if (ev.name === 'AskUserQuestion') return h('span', null, ev.title);
    if (ev.name === 'Skill') return h('code', null, `/${input.skill || ''}`);
    const t = ev.title && ev.title !== ev.name ? ev.title : '';
    if (!t && ev.argsText && ev.status === 'pending') return h('span', { class: 'muted' }, '…');
    return h('span', null, rel(t));
  }

  meta(ev) {
    const input = ev.input || {};
    if (/^(Edit|MultiEdit|StrReplaceFile)$/.test(ev.name) && typeof input.old_string === 'string') {
      const s = diffStats(input.old_string, input.new_string);
      return h('span', { class: 'tool-meta' }, h('span', { class: 'plus' }, `+${s.added}`), h('span', { class: 'minus' }, `−${s.removed}`));
    }
    if (/^Write/.test(ev.name) && typeof input.content === 'string') return h('span', { class: 'tool-meta' }, h('span', { class: 'plus' }, `+${input.content.split('\n').length}`));
    return null;
  }

  statusMark(ev) {
    if (ev.permission && !ev.permission.chosen) return h('span', { class: 'om-badge om-badge--warning' }, ev.permission.kind === 'question' ? '等你回答' : '等你核准');
    if (ev.status === 'pending' || ev.status === 'running') return h('span', { class: 'spinner', 'aria-label': '執行中' });
    if (ev.status === 'error') return h('span', { class: 'mark danger', title: '失敗' }, icon('alert'));
    if (ev.status === 'interrupted') return h('span', { class: 'mark-text' }, '已中斷');
    if (ev.permission?.chosen === 'rejected') return h('span', { class: 'mark-text' }, '已拒絕');
    return null;
  }

  // Collapsed rows still show what matters: live output while a command
  // runs, the first line of an error.
  // Finished ones get a one-line result under them, like Claude Code's
  // "⎿ Read 120 lines": the first lines of a command's output, how many
  // lines were read, how many matches were found.
  peek(ev) {
    const bash = /^(Bash|Shell|CodeExecution)$/.test(ev.name);
    if (ev.status === 'running' && ev.output && bash) {
      return [h('pre', { class: 'tail' }, ev.output.replace(/\n$/, '').split('\n').slice(-3).join('\n'))];
    }
    if (ev.status !== 'done') return [];
    // A preview cut short has no honest line count: say how big it is.
    if (ev.truncated?.field === 'output') return [h('div', { class: 'result' }, `輸出很長（${fmtSize(Number(ev.truncated.bytes) || 0)}），展開後可載入完整內容`)];
    const out = String(ev.output || '').replace(/\s+$/, '');
    const n = lineCount(out);
    const line = (text) => [h('div', { class: 'result' }, text)];
    if (bash) {
      if (!out || out === '(no output)') return line('（沒有輸出）');
      const lines = out.split('\n');
      return [h('pre', { class: 'result-out' }, lines.slice(0, 3).join('\n')), lines.length > 3 ? h('div', { class: 'result' }, `… 還有 ${lines.length - 3} 行`) : null].filter(Boolean);
    }
    // Claude's Read, Grep and Glob end a long result with "… 120 more lines".
    const more = out.match(/\n… (?:and )?(\d+) more[^\n]*$/);
    const shown = more ? n - 1 : n;
    if (/^Read/.test(ev.name)) {
      if (/^（圖片/.test(out)) return line(out);
      if (!shown || out === '(the file is empty)') return line('空的檔案');
      return line(`讀了 ${shown} 行${more ? `，還有 ${more[1]} 行` : ''}`);
    }
    const total = shown + (more ? Number(more[1]) : 0);
    if (ev.name === 'Grep') return line(total ? `找到 ${total} 筆` : '沒有找到');
    if (ev.name === 'Glob') return line(total ? `找到 ${total} 個檔案` : '沒有找到');
    const links = webLinks(ev);
    if (links) return line(ev.name === 'WebSearch' ? `找到 ${links.length} 個結果` : links[0].title);
    if (/^(Write|WriteFile|Edit|MultiEdit|StrReplaceFile|TodoList|TodoWrite|SetTodoList|ExitPlanMode|EnterPlanMode|AskUserQuestion)$/.test(ev.name)) return [];
    if (!out) return [];
    const first = out.split('\n')[0];
    return line(n > 1 ? `${first.slice(0, 120)} …` : first.slice(0, 160));
  }

  toolBody(ev) {
    const input = ev.input && typeof ev.input === 'object' ? ev.input : null;
    const out = [];
    const output = (text, cls = '') => text && out.push(h('pre', { class: `out ${cls}` }, text.replace(/\n$/, '')));
    switch (ev.name) {
      case 'Bash':
      case 'Shell':
        // On one line in the row, unless a description took its place.
        if (input?.command && (input.description || input.command.includes('\n'))) out.push(h('pre', { class: 'out cmd' }, input.command));
        output(ev.output, ev.status === 'error' ? 'err' : '');
        break;
      case 'CodeExecution':
        // Run in the Claude API's sandbox, not on this computer.
        if (input?.code || input?.command?.includes('\n')) out.push(h('pre', { class: 'out cmd' }, input.code || input.command));
        output(ev.output, ev.status === 'error' ? 'err' : '');
        break;
      case 'WebSearch':
      case 'WebFetch': {
        const links = webLinks(ev);
        if (!links) return this.toolArgs(ev, input, out);
        out.push(h('ul', { class: 'web-links' }, ...links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title), h('span', { class: 'web-host' }, hostOf(l.url))))));
        break;
      }
      case 'Edit':
      case 'StrReplaceFile':
        if (typeof input?.old_string === 'string') out.push(renderLineDiff(input.old_string, input.new_string ?? '', { context: 2 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'MultiEdit':
        for (const e of input?.edits || []) out.push(renderLineDiff(e.old_string, e.new_string ?? '', { context: 2 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'Write':
      case 'WriteFile':
        if (typeof input?.content === 'string') out.push(renderLineDiff('', input.content, { context: 0 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'ExitPlanMode':
        if (input?.plan) out.push(renderMarkdown(input.plan, 'md plan'));
        else output(ev.output);
        break;
      default:
        return this.toolArgs(ev, input, out);
    }
    return out;
  }

  // Any other tool: its arguments, then its output.
  toolArgs(ev, input, out) {
    if (input && !/^(Read|ReadFile|Glob|Grep|AskUserQuestion)$/.test(ev.name)) {
      const keys = Object.keys(input).filter((k) => input[k] !== '' && input[k] != null);
      if (keys.length) out.push(h('pre', { class: 'out args' }, keys.map((k) => `${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`).join('\n')));
    } else if (!input && ev.argsText) out.push(h('pre', { class: 'out args' }, ev.argsText));
    if (ev.output) out.push(h('pre', { class: `out ${ev.status === 'error' ? 'err' : ''}` }, ev.output.replace(/\n$/, '')));
    return out;
  }

  // --------------------------------------------------------- special

  renderTodos(node) {
    const ev = node.ev;
    const todos = ev.todos || ev.input?.todos || [];
    const done = todos.filter((t) => t.status === 'done' || t.status === 'completed').length;
    fill(node.head, h('div', { class: 'tool-row static' }, h('span', { class: 'tool-icon' }, icon('todo')), h('span', { class: 'tool-verb' }, '待辦'), h('span', { class: 'tool-target muted' }, `${done}/${todos.length} 完成`)));
    fill(node.body, todoList(todos));
  }

  renderAgent(node, ic, verb) {
    const ev = node.ev;
    const sub = ev.subagent || {};
    const kids = this.childrenOf(ev.id);
    const { life, model } = this.agentView(ev);
    const { running, failed, stopped, unknown } = life;
    this.lifeSeen.set(ev.id, `${life.state}|${life.reason}|${model.waiting}`);
    const open = this.agentOpen(ev);
    const steps = this.stepCount(ev.id, kids);
    const last = [...kids].reverse().find((k) => k.type === 'tool_use' || (k.type === 'text' && k.text?.trim()));
    let activity = '';
    if (running && last) activity = last.type === 'tool_use' ? `${(TOOLS[last.name] || [null, last.name])[1]} ${last.title || ''}` : last.text.trim().split('\n').pop();
    const name = agentName(sub);
    const base = ev.name === 'btw' || !INTERNAL_TITLE.test(String(verb || '')) ? verb : '子代理';
    const label = ev.name === 'btw' ? verb : `${base}${name ? ` · ${name}` : ''}`;
    const description = agentDescription(ev, sub);
    const summary = sub.summary;
    // Redrawn only when something on it changed: a working subagent touches
    // its card many times a second, and a rebuilt spinner starts over.
    const headKey = [label, description, steps, Boolean(sub.background), life.state, life.reason, sub.status, ev.status, open, model.text, model.mismatch, model.confirmed].join('\u0001');
    const bodyKey = [open, running, activity, summary, sub.error, life.reason, model.requestedText, model.note].join('\u0001');
    const same = node.headKey === headKey && node.bodyKey === bodyKey && !(ev.permission && !ev.permission.chosen);
    node.children.hidden = !open;
    if (same) return;
    const statusEl = running
      ? h('span', { class: 'spinner' })
      : failed
        ? h('span', { class: 'mark danger', title: life.reasonText || '失敗' }, icon('alert'))
        : stopped
          ? h('span', { class: 'mark-text', title: life.reasonText || '' }, '已中斷')
          : unknown
            ? h('span', { class: 'mark-text agent-unknown', title: life.reasonText }, '狀態未知')
            : null;
    if (node.headKey !== headKey) {
      node.headKey = headKey;
      fill(
        node.head,
        h(
          'button',
          { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => this.toggle(ev.id, open) },
          h('span', { class: 'tool-icon' }, icon(ic)),
          h('span', { class: 'tool-verb', title: label }, label),
          h('span', { class: 'tool-target' }, description),
          // The model and what goes with it. Beside the title on a wide card
          // (the box is `display: contents`); on its own line under it on a
          // narrow one (app.css, @container agentcard), so none of it is cut off.
          h(
            'span',
            { class: 'agent-meta' },
            h('span', { class: `tool-meta subagent-model${model.confirmed ? '' : ' unconfirmed'}${model.mismatch ? ' mismatch' : ''}`, title: model.title }, model.text),
            model.mismatch ? h('span', { class: 'tool-meta subagent-mismatch', title: model.title }, '與要求不同') : null,
            steps ? h('span', { class: 'tool-meta' }, `${steps} 個步驟`) : null,
            sub.background ? h('span', { class: 'om-badge' }, '背景') : null,
          ),
          statusEl,
          icon('chev', 'chev'),
        ),
      );
    }
    node.bodyKey = bodyKey;
    // What was asked for is said on its own line, and as a request: it is not
    // the model that ran.
    const notes = [model.requestedText, model.note, unknown || stopped || failed ? life.reasonText : ''].filter(Boolean);
    fill(
      node.body,
      !open && running && activity ? h('div', { class: 'agent-activity' }, activity) : null,
      !open && !running && summary ? h('div', { class: 'agent-summary clamp' }, summary) : null,
      notes.length ? h('div', { class: 'agent-notes' }, notes.map((t) => h('div', { class: 'agent-note' }, t))) : null,
      sub.error ? h('div', { class: 'callout danger small' }, icon('alert'), h('div', { class: 'callout-text' }, sub.error)) : null,
    );
    if (open && summary && !running) {
      node.summary ??= h('div', { class: 'agent-summary' });
      fill(node.summary, h('div', { class: 'agent-summary-label' }, '子代理回報'), renderMarkdown(summary));
      node.children.append(node.summary);
    } else node.summary?.remove();
    if (ev.permission && !ev.permission.chosen) node.body.append(this.permissionUI(ev));
  }

  renderArtifactTool(node, art) {
    const ev = node.ev;
    const all = this.opts.artifactsCache?.() || this.artifacts();
    const a = all.find((x) => x.path === art.path) || { path: art.path, versions: [{ id: ev.id, html: art.content, streaming: true }] };
    fill(node.head);
    fill(node.body, artifactCard(a, ev.id, { onOpen: (path, id) => this.opts.onOpenArtifact?.(path, id), active: this.opts.activeArtifact?.() === art.path }));
    if (ev.status === 'error') node.body.append(h('pre', { class: 'out err' }, String(ev.output || '').replace(/\n$/, '')));
  }

  // -------------------------------------------------------- permission

  permissionUI(ev) {
    const p = ev.permission;
    if (p.kind === 'question') return this.questionForm(ev);
    const box = h('div', { class: 'ask' });
    const send = (optionId, extra) => {
      for (const b of box.querySelectorAll('button, textarea, input')) b.disabled = true;
      this.opts.onRespond(ev, optionId, extra).catch(() => {
        for (const b of box.querySelectorAll('button, textarea, input')) b.disabled = false;
      });
    };
    if (p.kind === 'plan') {
      if (p.plan) box.append(renderMarkdown(p.plan, 'md plan'));
      box.append(
        h('div', { class: 'ask-q' }, '要照這個計畫進行嗎？'),
        h(
          'div',
          { class: 'ask-actions' },
          ...p.options.map((o, i) => h('button', { class: `om-btn${i === 0 ? ' om-btn--primary' : ''}`, type: 'button', title: o.description || '', onclick: () => send(o.optionId) }, o.name)),
          this.rejectButton(box, send, '先不要'),
        ),
      );
      return box;
    }
    const verb = /^(Bash|Shell)$/.test(ev.name) ? '執行這個指令' : /^(Write|Edit|MultiEdit|StrReplaceFile)$/.test(ev.name) ? '修改這個檔案' : `使用 ${ev.name}`;
    box.append(
      h('div', { class: 'ask-q' }, `要讓 ${this.name()} ${verb}嗎？`),
      h(
        'div',
        { class: 'ask-actions' },
        h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => send('approved') }, '允許'),
        h('button', { class: 'om-btn', type: 'button', title: `這個對話接下來的 ${ev.name} 都不再詢問`, onclick: () => send('approved_session') }, '這個對話都允許'),
        this.rejectButton(box, send, '拒絕…'),
      ),
    );
    return box;
  }

  // Reject, optionally telling Kimi what to do instead.
  rejectButton(box, send, label) {
    return h(
      'button',
      {
        class: 'om-btn',
        type: 'button',
        onclick: (e) => {
          const actions = e.currentTarget.parentElement;
          const ta = h('textarea', { class: 'om-input', rows: 2, placeholder: `告訴 ${this.name()} 要改成怎麼做（可以留白）` });
          const form = h(
            'div',
            { class: 'ask-reject' },
            ta,
            h(
              'div',
              { class: 'ask-actions' },
              h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => send('rejected', { feedback: ta.value }) }, '拒絕'),
              h('button', { class: 'om-btn om-btn--plain', type: 'button', onclick: () => (form.remove(), (actions.hidden = false)) }, '返回'),
            ),
          );
          ta.addEventListener('keydown', (k) => {
            if (k.key === 'Enter' && !k.shiftKey && !k.isComposing) {
              k.preventDefault();
              send('rejected', { feedback: ta.value });
            }
          });
          actions.hidden = true;
          box.append(form);
          ta.focus();
        },
      },
      label,
    );
  }

  questionForm(ev) {
    const items = ev.permission.questions || [];
    const box = h('form', { class: 'ask question' });
    const fields = items.map((q, qi) => {
      const name = `${ev.id}-${qi}`;
      const multi = Boolean(q.multi_select);
      const options = (q.options || []).map((o) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { class: multi ? 'om-check' : 'om-radio', type: multi ? 'checkbox' : 'radio', name, value: o.id }),
          h('span', { class: 'choice-text' }, h('span', null, o.label), o.description ? h('span', { class: 'choice-desc' }, o.description) : null),
        ),
      );
      const other = q.allow_other ? h('input', { class: 'om-input other', type: 'text', placeholder: q.other_label || '其他答案' }) : null;
      box.append(
        h('fieldset', { class: 'q' }, h('legend', null, q.header ? h('span', { class: 'q-header' }, q.header) : null, q.question), q.body ? h('div', { class: 'q-body' }, q.body) : null, ...options, other),
      );
      return { q, name, multi, other };
    });
    const answers = () => {
      const out = {};
      for (const f of fields) {
        const picked = [...box.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value);
        const text = f.other?.value.trim();
        if (f.multi) out[f.q.id] = text ? { kind: 'multi_with_other', option_ids: picked, other_text: text } : picked.length ? { kind: 'multi', option_ids: picked } : { kind: 'skipped' };
        else out[f.q.id] = text ? { kind: 'other', text } : picked[0] ? { kind: 'single', option_id: picked[0] } : { kind: 'skipped' };
      }
      return out;
    };
    const send = (optionId, extra) => {
      for (const b of box.querySelectorAll('button, input')) b.disabled = true;
      this.opts.onRespond(ev, optionId, extra).catch(() => {
        for (const b of box.querySelectorAll('button, input')) b.disabled = false;
      });
    };
    // A single single-choice question answers on click, like the CLI.
    if (items.length === 1 && !fields[0].multi && !fields[0].other) {
      for (const input of box.querySelectorAll('input')) input.addEventListener('change', () => send('answer', { answers: answers() }));
    }
    box.append(
      h(
        'div',
        { class: 'ask-actions' },
        h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '送出答案'),
        h('button', { class: 'om-btn om-btn--plain', type: 'button', onclick: () => send('__dismiss') }, '略過'),
      ),
    );
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      send('answer', { answers: answers() });
    });
    return box;
  }

  permissionResult(ev) {
    const p = ev.permission;
    const text =
      p.kind === 'question'
        ? p.chosen === '__dismiss'
          ? '已略過'
          : `已回答${answerSummary(ev)}`
        : p.chosen === 'rejected'
          ? `已拒絕${p.feedback ? `：${p.feedback}` : ''}`
          : p.chosen === 'approved_session'
            ? '已允許（這個對話都允許）'
            : p.chosen === 'cancelled'
              ? '已取消'
              : p.kind === 'plan'
                ? `已選擇：${p.options.find((o) => o.optionId === p.chosen)?.name || '同意'}`
                : '已允許';
    return h('div', { class: 'ask-done' }, text);
  }

  // ---------------------------------------------------------- working

  renderWorking() {
    const s = this.status;
    if (s !== 'running' && s !== 'awaiting_permission') {
      this.working.hidden = true;
      this.workingKind = null;
      return;
    }
    this.working.hidden = false;
    const secs = this.since ? fmtDuration(Date.now() - this.since) : '';
    if (s === 'running') {
      // Built once; the clock and the speed are updated in place, so the
      // pulse keeps its rhythm.
      if (this.workingKind !== 'running') {
        this.workingKind = 'running';
        this.secsEl = h('span', { class: 'muted' });
        this.tpsEl = h('span', { class: 'muted', title: '產生速度：這一輪生成的 token 數 ÷ 生成時間' });
        this.servedEl = h('span', { class: 'muted', title: '最近一次回應實際由這個模型產生（每次回應都會更新）' }, this.served ? ` · ${this.served}` : '');
        fill(this.working, h('div', { class: 'working-line' }, h('span', { class: 'pulse' }), h('span', null, `${this.name()} 正在處理`), this.servedEl, this.secsEl, this.tpsEl, h('span', { class: 'muted hint' }, ' · Esc 停止')));
      }
      this.secsEl.textContent = secs ? ` · ${secs}` : '';
      this.tpsEl.textContent = this.tps ? ` · ${this.tps} tok/s` : '';
      return;
    }
    if (this.workingKind === 'waiting') return;
    this.workingKind = 'waiting';
    fill(this.working, h('div', { class: 'working-line' }, h('span', { class: 'om-badge om-badge--warning' }, '等你回應'), h('span', { class: 'muted' }, '在上面的卡片選擇怎麼做')));
  }
}

function answerSummary(ev) {
  const a = ev.answers;
  const q = ev.permission.questions || [];
  if (!a) return '';
  const parts = [];
  for (const item of q) {
    const x = a[item.id];
    if (!x || x.kind === 'skipped') continue;
    const label = (id) => item.options?.find((o) => o.id === id)?.label || id;
    if (x.kind === 'single') parts.push(label(x.option_id));
    else if (x.kind === 'multi') parts.push(x.option_ids.map(label).join('、'));
    else if (x.kind === 'other') parts.push(x.text);
    else if (x.kind === 'multi_with_other') parts.push([...x.option_ids.map(label), x.other_text].join('、'));
  }
  return parts.length ? `：${parts.join('；')}` : '';
}

export function todoList(todos) {
  return h(
    'ul',
    { class: 'todos' },
    todos.map((t) => {
      const st = t.status === 'completed' ? 'done' : t.status;
      return h(
        'li',
        { class: `todo ${st}` },
        h('span', { class: 'todo-box', 'aria-hidden': 'true' }, st === 'done' ? icon('check') : null),
        h('span', { class: 'todo-text' }, t.title || t.content || ''),
        st === 'in_progress' ? h('span', { class: 'om-badge' }, '進行中') : null,
      );
    }),
  );
}


// A message's text, with the files attached to it (<file name="…">…</file>)
// as cards that open to show what was sent.
function userText(text) {
  if (!text) return [];
  const files = [];
  let rest = text.replace(/\n*<file name="([^"]*)">\n([\s\S]*?)\n<\/file>/g, (_, name, content) => (files.push({ name, content }), '')).trim();
  // Files saved in the folder: the list the hub added, set apart.
  const i = rest.search(/\n*\[附件\] /);
  const saved = i === -1 ? '' : rest.slice(i).trim();
  if (i !== -1) rest = rest.slice(0, i).trim();
  return [
    rest ? h('div', { class: 'user-text' }, rest) : null,
    saved ? h('div', { class: 'user-attach' }, icon('attach'), h('span', null, saved.replace(/^\[附件\] /, ''))) : null,
    files.length
      ? h(
          'div',
          { class: 'user-files' },
          ...files.map((f) => h('details', { class: 'user-file' }, h('summary', null, icon('document'), h('span', null, f.name), h('span', { class: 'user-file__size' }, `${f.content.split('\n').length} 行`)), h('pre', null, f.content))),
        )
      : null,
  ];
}

// Draws a few made-up rows once the page is idle, off screen. The first
// conversation a person opens would otherwise pay for the Markdown and DOMPurify
// code being run for the first time (about 60 ms on a laptop); this pays it
// while nothing is waiting.
export function warmTranscript() {
  try {
    const t = new Transcript({ cwd: '/', agentName: 'Kimi', onRespond: async () => {} });
    const md = '# Title\n\nSome **bold**, `code` and a [link](https://example.com).\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const ts = Date.now();
    t.load([
      { id: 'w1', ts, type: 'user', text: 'hello' },
      { id: 'w2', ts, type: 'thinking', text: 'hm' },
      { id: 'w3', ts, type: 'tool_use', agentId: 'main', name: 'Read', title: '/a', status: 'done', input: { path: '/a' }, output: '1\t2' },
      { id: 'w4', ts, type: 'tool_use', agentId: 'main', name: 'Bash', title: 'ls', status: 'done', input: { command: 'ls' }, output: 'a\nb\nc\nd' },
      { id: 'w5', ts, type: 'tool_use', agentId: 'main', name: 'Edit', title: '/a', status: 'done', input: { path: '/a', old_string: 'a', new_string: 'b' }, output: 'ok' },
      { id: 'w6', ts, type: 'text', agentId: 'main', text: md },
      { id: 'w7', ts, type: 'turn_end', durationMs: 1 },
    ]);
    t.destroy();
  } catch {}
}
