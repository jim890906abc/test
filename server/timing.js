// Where the time went: of one conversation (model, tools, compaction, waiting
// for a rate limit) and of each DeepSeek key (requests, simultaneous peak, 429s,
// time to the first byte, tokens per second), plus the one-key concurrency
// measure a person can ask for.
//
// One rule runs through all of it (the user's, 2026-10-21): only what really
// happened is recorded. A number is a sum of times that Kimi or the connector
// measured, or it is null with the reason in `unmeasured`. Nothing is estimated,
// extrapolated or filled in with "should be"; a running turn, a step that has
// no timing, a request that cannot be tied to a conversation are left out and
// said so, never guessed. `since` says from when the Hub has seen anything, so
// a number is never read as covering more than it does.
//
// Every figure is Kimi's or the connector's own stamp or measure, never the
// Hub's clock. So nothing the Hub does around a turn is in any number here: a
// worker's cluster memory is read over the Hub's own round trip before the
// prompt is sent to Kimi, and that happens before Kimi's turn begins, so it is
// in no turn length, model time or tool time.
//
// Sources:
//   • conversations: the frames Kimi's events arrive as (server/adapters/
//     kimi-remote.js hands every frame to observe()), each with Kimi's own
//     timestamp (`time`, on the frame for the journal, in the payload for
//     Kimi's server) and, for a model step, how long it took to the first
//     token and to the end of the stream;
//   • requests: the records a connector's DeepSeek proxy writes down and
//     reports ({ t: 'deepseek.requests' }, bridge/agent-hub-bridge.mjs dsLog).
import * as machines from './machines.js';
import * as deepseekAccount from './deepseek-account.js';

// What Kimi says when a swarm of subagents hits the provider's limit and one is
// put back in the queue (Kimi 2.3.3, RATE_LIMIT_SUSPENDED_REASON).
export const RATE_LIMIT_REASON = 'Provider rate limit; subagent requeued for retry.';
const MAX_ENTRIES = 20_000; // per kind and conversation; older ones go, and `since` moves up
const MAX_LEDGERS = 400;
const MAX_RECORDS = 20_000; // request records kept per computer

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// Kimi stamps its records with epoch milliseconds. Anything that is not (a
// small counter, a missing field) is "no time", never a time.
const epoch = (v) => (finite(v) && v > 1e11 ? v : null);

// Nearest-rank percentile of an ascending list (p in 1..100).
export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] : null);

// Length of the union of [from, to] intervals (overlaps counted once).
export function unionMs(intervals) {
  const list = intervals.filter(([a, b]) => finite(a) && finite(b) && b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  let start = 0;
  for (const [a, b] of list) {
    if (a > end) {
      if (end > -Infinity) total += end - start;
      start = a;
      end = b;
    } else if (b > end) end = b;
  }
  return end > -Infinity ? total + (end - start) : 0;
}

// ------------------------------------------------------ conversation ledger

class Ledger {
  constructor() {
    this.turns = new Map(); // turn id -> { startedAt, endedAt, durationMs }
    this.steps = new Map(); // step id -> { turn, firstTokenMs, streamMs }
    this.tools = new Map(); // tool call id -> { turn, startedAt, endedAt, waited }
    this.compactions = new Map(); // started at -> { startedAt, endedAt }
    this.suspensions = new Map(); // `${subagent}@${time}` -> { subagent, from, to }
    this.spawned = new Set();
    this.frames = 0;
    this.untimedCompactions = 0; // compaction events that carry no time
    this.untimedSuspensions = 0; // rate-limit requeues that carry no time
    this.firstAt = null; // the earliest time any frame carried
    this.floor = 0; // entries older than this were dropped
    this.touched = 0;
  }

  see(t) {
    if (t !== null && (this.firstAt === null || t < this.firstAt)) this.firstAt = t;
  }

  trim(map, timeOf) {
    while (map.size > MAX_ENTRIES) {
      const [k, v] = map.entries().next().value;
      map.delete(k);
      const t = timeOf(v);
      if (t !== null && t !== undefined && t > this.floor) this.floor = t;
    }
  }
}

const ledgers = new Map(); // Hub conversation id -> Ledger

function ledgerFor(id) {
  let l = ledgers.get(id);
  if (!l) {
    l = new Ledger();
    ledgers.set(id, l);
    if (ledgers.size > MAX_LEDGERS) {
      // The one touched longest ago goes (its conversation is the least in use).
      let oldest = null;
      for (const [k, v] of ledgers) if (k !== id && (!oldest || v.touched < ledgers.get(oldest).touched)) oldest = k;
      if (oldest) ledgers.delete(oldest);
    }
  }
  l.touched = Date.now();
  return l;
}

export const forget = (id) => ledgers.delete(id);

// One frame of a conversation's Kimi events (as server/adapters/kimi-remote.js
// gets them). The same frame seen twice (a replay of the journal, a subagent's
// frames held back and let through) changes nothing: every entry is kept under
// the id Kimi gave it. Never throws.
export function observe(sessionId, frame) {
  try {
    if (!sessionId || !frame || typeof frame !== 'object') return;
    const p = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
    const type = frame.type || p.type;
    if (typeof type !== 'string') return;
    const l = ledgerFor(sessionId);
    l.frames++;
    const t = epoch(frame.time) ?? epoch(p.time);
    l.see(t);
    const main = (p.agentId || p.agent_id || 'main') === 'main';
    const turnKey = p.turnId === undefined || p.turnId === null ? null : String(p.turnId);
    switch (type) {
      case 'turn.started':
        if (!main || turnKey === null) return;
        l.turns.set(turnKey, { ...l.turns.get(turnKey), startedAt: t });
        l.trim(l.turns, (v) => v.startedAt);
        return;
      case 'turn.ended':
        if (!main || turnKey === null) return;
        l.turns.set(turnKey, { ...l.turns.get(turnKey), ended: true, endedAt: t, durationMs: finite(p.durationMs) && p.durationMs >= 0 ? p.durationMs : null });
        return;
      case 'turn.step.completed': {
        if (!main || turnKey === null) return;
        const id = p.stepId || `${turnKey}:${p.step ?? t ?? l.steps.size}`;
        const ms = (v) => (finite(v) && v >= 0 ? v : null);
        l.steps.set(id, { turn: turnKey, at: t, firstTokenMs: ms(p.llmFirstTokenLatencyMs), streamMs: ms(p.llmStreamDurationMs) });
        l.trim(l.steps, (v) => v.at);
        return;
      }
      case 'tool.call.started': {
        if (!main || !p.toolCallId) return;
        l.tools.set(p.toolCallId, { ...l.tools.get(p.toolCallId), turn: turnKey, startedAt: t });
        l.trim(l.tools, (v) => v.startedAt);
        return;
      }
      case 'tool.result': {
        if (!main || !p.toolCallId) return;
        l.tools.set(p.toolCallId, { ...l.tools.get(p.toolCallId), turn: l.tools.get(p.toolCallId)?.turn ?? turnKey, endedAt: t });
        return;
      }
      case 'event.approval.requested':
      case 'event.question.requested': {
        // The time between asking and the person answering is the person's, not the tool's.
        const owner = p.agent_id || p.agentId || 'main';
        const id = p.tool_call_id || p.toolCallId;
        if (owner !== 'main' || !id) return;
        l.tools.set(id, { ...l.tools.get(id), waited: true });
        return;
      }
      case 'compaction.started':
        if (!main) return;
        if (t === null) return void l.untimedCompactions++;
        if (!l.compactions.has(t)) l.compactions.set(t, { startedAt: t, endedAt: null });
        l.trim(l.compactions, (v) => v.startedAt);
        return;
      case 'compaction.completed': {
        if (!main) return;
        if (t === null) return void l.untimedCompactions++;
        // It ends the latest one that began before it and is still open.
        let open = null;
        for (const c of l.compactions.values()) if (c.endedAt === null && c.startedAt <= t && (!open || c.startedAt > open.startedAt)) open = c;
        if (open) open.endedAt = t;
        return;
      }
      case 'subagent.spawned':
        if (p.subagentId) l.spawned.add(p.subagentId);
        return;
      case 'subagent.suspended': {
        if (String(p.reason || '').trim() !== RATE_LIMIT_REASON) return;
        if (t === null || !p.subagentId) return void l.untimedSuspensions++;
        const key = `${p.subagentId}@${t}`;
        if (!l.suspensions.has(key)) l.suspensions.set(key, { subagent: p.subagentId, from: t, to: null });
        l.trim(l.suspensions, (v) => v.from);
        return;
      }
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.cancelled': {
        // The wait of a requeued subagent ends when it runs again (or is over).
        if (t === null || !p.subagentId) return;
        let open = null;
        for (const s of l.suspensions.values()) if (s.subagent === p.subagentId && s.to === null && s.from <= t && (!open || s.from > open.from)) open = s;
        if (open) open.to = t;
        return;
      }
      default:
    }
  } catch {}
}

// -------------------------------------------------------- request records

const OUTCOMES = new Set(['ok', 'quota', 'http_error', 'timeout', 'unreachable', 'aborted', 'stream_cut']);
const intOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const numOrNull = (v) => (finite(v) && v >= 0 ? v : null);
const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

// One record as a connector said it, rebuilt field by field (null when it is
// not a record at all). Only ids, times and numbers pass; nothing else.
function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id, /^[\w-]{1,64}$/);
  const key = str(r.key, /^[\w-]{1,64}$/);
  const startAt = epoch(r.startAt);
  if (!id || !key || startAt === null || !OUTCOMES.has(r.outcome)) return null;
  return {
    id,
    req: intOrNull(r.req),
    attempt: intOrNull(r.attempt) || 1,
    key,
    gateway: str(r.gateway, /^[\w-]{1,32}$/),
    session: str(r.session, /^session_[\w-]{4,80}$/),
    clientRetry: intOrNull(r.clientRetry),
    switchedFrom: str(r.switchedFrom, /^[\w-]{1,64}$/),
    // Lent (2026-10-30): the key this request would have gone to and why ('rate429' | 'cooldown').
    borrowedFrom: str(r.borrowedFrom, /^[\w-]{1,64}$/),
    borrowReason: r.borrowReason === 'rate429' || r.borrowReason === 'cooldown' ? r.borrowReason : null,
    recvAt: epoch(r.recvAt),
    startAt,
    headersMs: numOrNull(r.headersMs),
    firstByteMs: numOrNull(r.firstByteMs),
    endMs: numOrNull(r.endMs),
    status: Number.isInteger(r.status) && r.status >= 100 && r.status < 600 ? r.status : null,
    outcome: r.outcome,
    inflight: intOrNull(r.inflight),
    outTokens: intOrNull(r.outTokens),
  };
}

// machine id -> { records: Map(id -> record), since, floor, version, bySession, orphans }
//   records    every record kept, by id, oldest first (what is dropped at the cap)
//   bySession  the same records by conversation, each list in order of start time,
//              so a window is found by bisection instead of by reading them all
//   orphans    the records that name no conversation, in order of start time
//   version    moves whenever anything above (or `since`, `floor`) changes: an
//              answer worked out at one version is good for exactly that version
const stores = new Map();

// A conversation's records in order of start time. `maxDur` is the longest
// request in it (never lowered when one is dropped: a bound that is too long
// only costs a few more records read, never a wrong number).
const newGroup = () => ({ recs: [], maxDur: 0 });

// The first position whose start time is not before `t`.
function lowerBound(recs, t) {
  let lo = 0;
  let hi = recs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (recs[mid].startAt < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function indexRecord(s, r) {
  let g;
  if (r.session) {
    g = s.bySession.get(r.session);
    if (!g) s.bySession.set(r.session, (g = newGroup()));
  } else g = s.orphans;
  const { recs } = g;
  if (!recs.length || recs[recs.length - 1].startAt <= r.startAt) recs.push(r);
  else {
    // Records arrive about in order; one that came late goes after the ones that started at the same moment.
    let lo = lowerBound(recs, r.startAt);
    while (lo < recs.length && recs[lo].startAt === r.startAt) lo++;
    recs.splice(lo, 0, r);
  }
  if (finite(r.endMs) && r.endMs > g.maxDur) g.maxDur = r.endMs;
}

function unindexRecord(s, r) {
  const g = r.session ? s.bySession.get(r.session) : s.orphans;
  if (!g) return;
  for (let i = lowerBound(g.recs, r.startAt); i < g.recs.length && g.recs[i].startAt === r.startAt; i++) {
    if (g.recs[i] === r) {
      g.recs.splice(i, 1);
      break;
    }
  }
  if (r.session && !g.recs.length) s.bySession.delete(r.session);
}

// A connector's {t:'deepseek.requests'}: kept by record id, so the same record
// sent again (after a reconnect, or to a Hub that restarted) is one record.
export function applyRequests(machineId, msg) {
  try {
    if (!machineId || !msg || msg.t !== 'deepseek.requests' || !Array.isArray(msg.records)) return false;
    let s = stores.get(machineId);
    if (!s) stores.set(machineId, (s = { records: new Map(), since: null, floor: 0, version: 0, bySession: new Map(), orphans: newGroup() }));
    const since = epoch(msg.since);
    let moved = false;
    if (since !== null && (s.since === null || since < s.since)) {
      s.since = since;
      moved = true;
    }
    let added = 0;
    for (const raw of msg.records.slice(0, 500)) {
      const r = cleanRecord(raw);
      if (!r || s.records.has(r.id)) continue;
      s.records.set(r.id, r);
      indexRecord(s, r);
      added++;
    }
    while (s.records.size > MAX_RECORDS) {
      const [k, v] = s.records.entries().next().value;
      s.records.delete(k);
      unindexRecord(s, v);
      if (v.startAt > s.floor) s.floor = v.startAt;
      moved = true;
    }
    if (added > 0 || moved) s.version++;
    return added > 0;
  } catch {
    return false;
  }
}

export function install() {
  machines.onBridgeMessage((machineId, msg) => {
    if (msg?.t === 'deepseek.requests') applyRequests(machineId, msg);
  });
}

// From when this machine's records can be relied on to be complete.
const coverageOf = (s) => (s.since === null ? null : Math.max(s.since, s.floor));

// -------------------------------------------------------- one conversation

const secondsAgo = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false });

/**
 * The time breakdown of a conversation (all the nodes of its chain, oldest
 * first). Every number is a sum of measured times or null; `unmeasured` says
 * what could not be measured and why. Contract (cluster spec §5):
 *   { since, turns, wallMs, modelMs, toolMs, compactMs, rateLimitWaitMs,
 *     requests, http429, subagents: { spawned, requeuedForRateLimit },
 *     unmeasured: [ 'field：why' ] }
 * plus `requestsSince`: from when the connector's request records cover.
 *
 * Parts (all of the main agent; a subagent's own steps are not added):
 *   wallMs           the turns that have ended, as Kimi timed them (durationMs)
 *   modelMs          for those turns' steps: time to the first token + stream
 *   toolMs           for those turns' tool calls: from the call to its result,
 *                    overlaps counted once. It includes the time a tool call
 *                    waits on its subagents; calls that waited for a person
 *                    (approval, question) are left out
 *   compactMs        compactions, from their start to their end
 *   rateLimitWaitMs  time during which a subagent was waiting in the queue
 *                    after the provider's rate limit (from its "suspended" event
 *                    to the next time it ran), overlaps counted once
 * Model and tool time can overlap (a tool may start while the model is still
 * writing the next call) and tool time contains the waiting for subagents, so
 * the parts are not meant to add up to wallMs.
 *   requests/http429 upstream requests the DeepSeek proxy sent for this
 *                    conversation (and its subagents), and how many were 429
 *   currentKey       the key of the conversation's latest request, from those
 *                    records: { id, gateway, gatewayLabel, hint (the key's last
 *                    four characters; null when the Hub no longer has the key),
 *                    removed, lastUsedAt (when that request was sent), machineId
 *                    (the computer whose connector sent it), distribution }; null
 *                    when no request of the conversation has been recorded.
 *                    `distribution` is how that computer gives keys out: 'sticky'
 *                    (this conversation keeps this key until it runs out or is
 *                    refused) or 'relay' (the key in use, whoever asks)
 */
export function sessionTiming(nodes, { now = Date.now() } = {}) {
  const unmeasured = [];
  const list = (nodes || []).filter(Boolean);
  const own = list.map((n) => ledgers.get(n.id)).filter(Boolean);
  const out = { since: null, turns: 0, wallMs: null, modelMs: null, toolMs: null, compactMs: null, rateLimitWaitMs: null, requests: null, http429: null, requestsSince: null, currentKey: null, subagents: { spawned: null, requeuedForRateLimit: null }, unmeasured };
  const why = (field, reason) => unmeasured.push(`${field}：${reason}`);

  if (!own.length || !own.some((l) => l.frames > 0)) {
    for (const f of ['wallMs', 'modelMs', 'toolMs', 'compactMs', 'rateLimitWaitMs']) why(f, '中控台還沒有收到這個對話的任何 Kimi 事件（對話還沒開始、不是 Kimi／DeepSeek 對話，或是中控台剛重新啟動而這段歷史還沒載入）');
    why('subagents', '同上，沒有事件可以數');
  } else {
    const firsts = own.map((l) => (l.firstAt === null ? null : Math.max(l.firstAt, l.floor))).filter((x) => x !== null);
    out.since = firsts.length ? Math.min(...firsts) : null;
    if (out.since === null) why('since', '收到的事件都沒有時間戳');

    // ---- turns that have ended
    const endedTurns = new Set(); // `${ledger index}/${turn}`
    let wall = 0;
    let running = 0;
    let turnsWithoutLength = 0;
    own.forEach((l, i) => {
      for (const [k, t] of l.turns) {
        if (!t.ended) {
          if (t.startedAt !== undefined) running++;
          continue;
        }
        // Kimi's own length of the turn; else its start to its end, both as Kimi stamped them.
        const length = finite(t.durationMs) ? t.durationMs : finite(t.startedAt) && finite(t.endedAt) ? t.endedAt - t.startedAt : null;
        if (!finite(length) || length < 0) {
          turnsWithoutLength++;
          continue;
        }
        endedTurns.add(`${i}/${k}`);
        wall += length;
      }
    });
    out.turns = endedTurns.size;
    if (endedTurns.size) out.wallMs = Math.round(wall);
    else why('wallMs', '還沒有結束的回合');
    if (running) why('wallMs', `${running} 個回合還在進行（或沒收到結束事件），等結束才算進來`);
    if (turnsWithoutLength) why('wallMs', `${turnsWithoutLength} 個回合結束了但沒有時間長度，沒有算進來`);

    // ---- model: the steps of those turns
    let model = 0;
    let modelSteps = 0;
    let stepsWithout = 0;
    own.forEach((l, i) => {
      for (const s of l.steps.values()) {
        if (!endedTurns.has(`${i}/${s.turn}`)) continue;
        if (s.firstTokenMs === null || s.streamMs === null) {
          stepsWithout++;
          continue;
        }
        model += s.firstTokenMs + s.streamMs;
        modelSteps++;
      }
    });
    if (modelSteps) out.modelMs = Math.round(model);
    else why('modelMs', endedTurns.size ? '這些回合的步驟沒有帶計時（被中斷的步驟沒有，或這台電腦的連接器太舊，沒有把計時欄位傳過來）' : '還沒有結束的回合');
    if (modelSteps && stepsWithout) why('modelMs', `${stepsWithout} 個步驟沒有帶計時（被中斷的步驟沒有，或連接器太舊），這些時間沒有算進來`);

    // ---- tools: the calls of those turns
    const intervals = [];
    let toolsOpen = 0;
    let toolsWaited = 0;
    let toolsUntimed = 0;
    own.forEach((l, i) => {
      for (const t of l.tools.values()) {
        if (!endedTurns.has(`${i}/${t.turn}`)) continue;
        if (t.waited) {
          toolsWaited++;
          continue;
        }
        if (t.endedAt === undefined || t.endedAt === null) {
          // No result in a turn that ended: interrupted. Its time is not known.
          if (t.startedAt !== undefined) toolsOpen++;
          continue;
        }
        if (!finite(t.startedAt) || !finite(t.endedAt) || t.endedAt < t.startedAt) {
          toolsUntimed++;
          continue;
        }
        intervals.push([t.startedAt, t.endedAt]);
      }
    });
    if (endedTurns.size) out.toolMs = Math.round(unionMs(intervals));
    else why('toolMs', '還沒有結束的回合');
    if (toolsWaited) why('toolMs', `${toolsWaited} 個工具呼叫等過你的核准或回答，那段是你的時間，沒有算進來`);
    if (toolsOpen) why('toolMs', `${toolsOpen} 個工具呼叫沒有收到結果（回合被中斷），沒有算進來`);
    if (toolsUntimed) why('toolMs', `${toolsUntimed} 個工具呼叫的事件沒有時間戳，沒有算進來`);

    // ---- compaction
    const compact = [];
    let compactOpen = 0;
    for (const l of own) for (const c of l.compactions.values()) (c.endedAt === null ? (compactOpen++, 0) : compact.push([c.startedAt, c.endedAt]));
    const compactUntimed = own.reduce((n, l) => n + l.untimedCompactions, 0);
    if (compact.length || !compactUntimed) out.compactMs = Math.round(unionMs(compact));
    if (compactOpen) why('compactMs', `${compactOpen} 次壓縮沒有收到結束事件（還在壓縮，或被取消），沒有算進來`);
    if (compactUntimed) why('compactMs', `${compactUntimed} 個壓縮事件沒有時間戳，沒有算進來`);

    // ---- subagents and the rate-limit queue
    out.subagents.spawned = own.reduce((n, l) => n + l.spawned.size, 0);
    const waits = [];
    let requeued = 0;
    let stillWaiting = 0;
    for (const l of own) {
      for (const s of l.suspensions.values()) {
        requeued++;
        if (s.to === null) stillWaiting++;
        else waits.push([s.from, s.to]);
      }
    }
    const suspendedUntimed = own.reduce((n, l) => n + l.untimedSuspensions, 0);
    out.subagents.requeuedForRateLimit = requeued;
    // A requeue without a time is still a requeue, but its wait is not known.
    if (waits.length || !suspendedUntimed) out.rateLimitWaitMs = Math.round(unionMs(waits));
    if (stillWaiting) why('rateLimitWaitMs', `${stillWaiting} 個被重新排隊的子代理還沒再開始跑，等它們再跑起來才算進來`);
    if (suspendedUntimed) {
      out.subagents.requeuedForRateLimit = requeued + suspendedUntimed;
      why('rateLimitWaitMs', `${suspendedUntimed} 次重新排隊的事件沒有時間戳，等了多久不知道，沒有算進來`);
    }
  }

  // ---- requests of the DeepSeek proxy
  requestsOf(list, out, why);
  // A 429 makes Kimi's own client wait and ask again, and Kimi reports no event
  // for that wait: only the subagents put back in the queue have one. So a
  // conversation with 429s and no queue wait does not mean nobody waited.
  if (out.http429 > 0 && out.rateLimitWaitMs !== null) why('rateLimitWaitMs', `只量得到子代理被重新排隊的等待；這個對話有 ${out.http429} 次 429，Kimi 自己重試時等了多久沒有任何事件可以量，不在這個數字裡`);
  return out;
}

function requestsOf(nodes, out, why) {
  const fields = ['requests', 'http429'];
  const sub = (reason) => fields.forEach((f) => why(f, reason));
  const leaf = nodes.at(-1);
  if (!leaf?.kimiSessionId || !leaf.machineId) return sub('這個對話還沒有對應到任何一台電腦上的 Kimi 對話');
  if (!(deepseekAccount.isDeepseek(leaf) || leaf.provider === 'deepseek')) return sub('這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以對應');
  const byMachine = new Map();
  for (const n of nodes) if (n.kimiSessionId && n.machineId) (byMachine.get(n.machineId) || byMachine.set(n.machineId, new Set()).get(n.machineId)).add(n.kimiSessionId);
  let requests = 0;
  let http429 = 0;
  let unattributed = 0;
  let coverage = null;
  let latest = null; // the newest record of this conversation, and the computer it came from
  const lacking = [];
  for (const [machineId, ids] of byMachine) {
    const m = machines.getMachine(machineId);
    if (!machines.hasCapability(machineId, 'pool_timing')) {
      lacking.push(m?.name || machineId);
      continue;
    }
    const s = stores.get(machineId);
    const from = out.since ?? 0;
    if (!s) {
      // The connector can write records but none has reached the Hub yet.
      continue;
    }
    const cov = coverageOf(s);
    if (cov !== null) coverage = coverage === null ? cov : Math.min(coverage, cov);
    for (const r of s.records.values()) {
      if (r.session && ids.has(r.session)) {
        requests++;
        if (r.status === 429) http429++;
        if (!latest || r.startAt > latest.r.startAt) latest = { r, machineId };
      } else if (!r.session && r.startAt >= from) unattributed++;
    }
  }
  out.requestsSince = coverage;
  if (latest) {
    const { r, machineId } = latest;
    const known = deepseekAccount.keyIdentity(r.key);
    // A connector that cannot give each conversation its own key relays, whatever the Hub chose.
    out.currentKey = {
      id: r.key,
      gateway: known?.gateway ?? r.gateway,
      gatewayLabel: known?.gatewayLabel ?? (r.gateway && deepseekAccount.GATEWAYS[r.gateway]?.label) ?? null,
      hint: known?.hint ?? null,
      removed: !known,
      lastUsedAt: r.startAt,
      machineId,
      distribution: machines.hasCapability(machineId, 'pool_sticky') ? deepseekAccount.distribution() : 'relay',
      // The latest request was lent to this key: the key it was lent from, and whether that one is cooling down now.
      ...(r.borrowedFrom
        ? (() => {
            const from = deepseekAccount.keyIdentity(r.borrowedFrom);
            return { borrowedFrom: { id: r.borrowedFrom, hint: from?.hint ?? null, gatewayLabel: from?.gatewayLabel ?? null, cooling: deepseekAccount.keyCooling(r.borrowedFrom) } };
          })()
        : {}),
    };
  }
  if (lacking.length) return sub(`「${lacking.join('、')}」的連接器太舊，沒有寫請求紀錄。在那台電腦重新執行連接指令更新`);
  if (coverage === null) return sub('連接器還沒有回報過任何請求紀錄（沒有請求，或連接器剛連上；它回報時會自己補上）');
  if (requests === 0 && unattributed > 0) return sub(`有 ${unattributed} 個請求沒帶對話識別（Kimi 版本沒有送 prompt_cache_key），沒辦法判斷哪些是這個對話的`);
  out.requests = requests;
  out.http429 = http429;
  if (unattributed > 0) why('requests', `另有 ${unattributed} 個同時間的請求沒帶對話識別，沒有算進來（這個數字是下限）`);
  if (out.since !== null && coverage > out.since) why('requests', `連接器從 ${secondsAgo(coverage)} 才開始記請求，這之前的請求不在裡面`);
}

// ------------------------------------------------------------- the keys

/**
 * One entry per key the Hub holds (id, gateway, last four characters, nothing
 * secret), from the request records of every computer:
 *   requests         upstream requests sent with the key (each attempt counts)
 *   http429          of those, the ones the gateway answered 429
 *   peakConcurrent   most requests of the key in flight at once on one computer
 *   firstByteMs      { p50, p95, n } from sending to the first byte, over the
 *                    requests the gateway served (2xx); null when none
 *   tokensPerSecond  output tokens over the time from the first byte to the end
 *                    of the answer, over the served requests whose usage was
 *                    seen; null when none
 *   measure          the last concurrency measure of the key, if one was made
 */
export function keysTiming() {
  const account = deepseekAccount.publicAccount();
  const keys = account.rotation?.keys || [];
  const unmeasured = [];
  const covered = [...stores.entries()].filter(([id]) => machines.hasCapability(id, 'pool_timing'));
  const bySince = covered.map(([, s]) => coverageOf(s)).filter((x) => x !== null);
  if (!bySince.length) unmeasured.push('還沒有任何連接器回報過請求紀錄（沒有請求，或連接器太舊：重新執行連接指令更新）');
  const old = machines.listMachines().filter((m) => m.online && (m.capabilities || []).includes('pool') && !(m.capabilities || []).includes('pool_timing'));
  if (old.length) unmeasured.push(`「${old.map((m) => m.name).join('、')}」的連接器太舊，沒有寫請求紀錄，這幾台的請求不在裡面`);
  const out = keys.map((k) => {
    const mine = [];
    const usedBy = new Set();
    for (const [machineId, s] of covered) {
      for (const r of s.records.values()) {
        if (r.key !== k.id) continue;
        mine.push(r);
        usedBy.add(machineId);
      }
    }
    const note = [];
    const served = mine.filter((r) => r.status >= 200 && r.status < 300);
    const first = served.map((r) => r.firstByteMs).filter(finite).sort((a, b) => a - b);
    const rated = served.filter((r) => r.outTokens > 0 && finite(r.firstByteMs) && finite(r.endMs) && r.endMs > r.firstByteMs);
    const seconds = rated.reduce((a, r) => a + (r.endMs - r.firstByteMs) / 1000, 0);
    if (!mine.length) note.push('沒有這把 key 的請求紀錄');
    else {
      if (!first.length) note.push('firstByteMs：沒有成功的請求，量不到');
      if (served.length && !rated.length) note.push('tokensPerSecond：成功的請求都沒有 usage 或沒有串流時間，量不到');
      if (usedBy.size > 1) note.push(`peakConcurrent：這把 key 被 ${usedBy.size} 台電腦用，只是單一台的最大值；各台之間同時有多少沒辦法合併（時鐘不同步）`);
    }
    return {
      id: k.id,
      gateway: k.gateway,
      gatewayLabel: k.gatewayLabel,
      hint: k.hint,
      requests: mine.length,
      http429: mine.filter((r) => r.status === 429).length,
      peakConcurrent: mine.length ? Math.max(...mine.map((r) => r.inflight || 1)) : null,
      firstByteMs: first.length ? { p50: Math.round(percentile(first, 50)), p95: Math.round(percentile(first, 95)), n: first.length } : null,
      tokensPerSecond: rated.length && seconds > 0 ? Math.round((rated.reduce((a, r) => a + r.outTokens, 0) / seconds) * 10) / 10 : null,
      measure: measures.get(k.id) || null,
      unmeasured: note,
    };
  });
  for (const id of [...measures.keys()]) if (!keys.some((k) => k.id === id)) measures.delete(id);
  return { since: bySince.length ? Math.min(...bySince) : null, keys: out, unmeasured };
}

// ----------------------------------------------------- the concurrency measure

export const MEASURE_LEVELS = [1, 2, 4, 8, 16];
const measures = new Map(); // key id -> the last measure, with the computer it ran on
const measuring = new Set(); // key ids and computer ids with a measure under way

export function measureLevels(levels) {
  const list = levels === undefined ? MEASURE_LEVELS : levels;
  if (!Array.isArray(list) || list.length < 1 || list.length > 8 || list.some((n) => !Number.isInteger(n) || n < 1 || n > 32)) throw Object.assign(new Error('並行數要是 1 到 8 個整數，每個 1～32'), { status: 400 });
  const total = list.reduce((a, b) => a + b, 0);
  if (total > 64) throw Object.assign(new Error(`總共 ${total} 個請求太多了，最多 64 個`), { status: 400 });
  return { levels: list, total };
}

const TOO_OLD = (m) => Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，重新執行連接指令更新（左下角「連接電腦…」）`), { status: 409, code: 'connector_old' });

/**
 * Ask a connector to measure ONE key: `levels` requests at once, level after
 * level (see the connector's proxy.measure). It costs real requests, so it is
 * only ever done for a person who was told how many: `confirmedRequests` must
 * be the total of `levels`, or nothing is sent. The key never leaves the
 * connector (the Hub names it by id) and nothing here keeps or returns more
 * than what the connector answered with.
 */
export async function measureKey({ keyId, levels, confirmedRequests, machineId, rpc = machines.rpc } = {}) {
  const gw = deepseekAccount.gatewayOfKey(keyId);
  if (!gw) throw Object.assign(new Error('找不到這把 key'), { status: 404 });
  const plan = measureLevels(levels);
  if (confirmedRequests !== plan.total) throw Object.assign(new Error(`要先讓使用者確認：這次量測會送出共 ${plan.total} 個請求（confirmedRequests 要等於 ${plan.total}）`), { status: 400 });
  const online = machines.listMachines().filter((m) => m.online);
  let target;
  if (machineId !== undefined) {
    target = online.find((m) => m.id === machineId);
    if (!target) throw Object.assign(new Error('那台電腦不在線上'), { status: 409 });
  } else {
    if (!online.length) throw Object.assign(new Error('沒有任何已連接的電腦在線上：量測要在連接器那台電腦上做（key 不會離開那台電腦）'), { status: 409 });
    const capable = online.filter((m) => (m.capabilities || []).includes('pool_measure'));
    // The computer that has been using this key most recently, else the first that can.
    const used = (m) => Math.max(0, ...[...(stores.get(m.id)?.records.values() || [])].filter((r) => r.key === keyId).map((r) => r.startAt));
    target = capable.sort((a, b) => used(b) - used(a))[0];
    if (!target) throw TOO_OLD(online[0]);
  }
  if (!(target.capabilities || []).includes('pool_measure')) throw TOO_OLD(target);
  const model = deepseekAccount.pickDefaultModel(deepseekAccount.modelIds(gw));
  if (!model) throw Object.assign(new Error('找不到這家閘道的模型名稱，沒辦法送測試請求'), { status: 409 });
  const busy = [`key:${keyId}`, `machine:${target.id}`];
  if (busy.some((b) => measuring.has(b))) throw Object.assign(new Error('這把 key（或這台電腦）正在量測，等它跑完再試'), { status: 409 });
  busy.forEach((b) => measuring.add(b));
  try {
    const result = await rpc(target.id, 'kimi.deepseek.measure', { keyId, levels: plan.levels, model }, 5 * 60_000);
    const done = { ...result, machineId: target.id, machineName: target.name };
    measures.set(keyId, done);
    return done;
  } catch (err) {
    if (/未知的操作/.test(err?.message || '')) throw TOO_OLD(target);
    throw err;
  } finally {
    busy.forEach((b) => measuring.delete(b));
  }
}

// ------------------------------------------------------------- right now

// How fast a conversation is going right now, for the cluster pages. Only what
// the connector's request records say, added up over a time window - no
// estimate, and nothing is said about how long anything will take:
//   outTokens          output tokens of the requests that ENDED in the window
//   tokensPerSecond    outTokens over the window's seconds
//   requests           requests that STARTED in the window (each attempt counts)
//   requestsPerMinute  requests over the window's minutes
// The window is the last `windowMs`, but not from before `from` (when the work
// began) nor before the records are complete (the connector's coverage): a
// window cannot be longer than the time it is known for, so the number of a
// conversation that started 30 seconds ago is over 30 seconds, and `windowMs`
// says which. Every field is null, with `unmeasured` saying why, where the
// records cannot say (not a DeepSeek-pool conversation, no records yet, a
// window too short to mean anything).
export const SPEED_WINDOW_MS = 5 * 60_000;
export const SPEED_MIN_SPAN_MS = 5_000;
// The cluster page's big number is over a shorter window: what the whole
// cluster produced in the last minute.
export const OUTPUT_WINDOW_MS = 60_000;

// The one computation behind both: over the conversations of one or more
// chains (a chain is a conversation's nodes, oldest first), the request records
// of the window. `counted` is how many chains the records can speak for; a chain
// they cannot (not a DeepSeek-pool conversation, not tied to a computer yet) is
// left out, and when none can, the answer is null with the first chain's reason.
// A subagent's requests carry its worker's session id (prompt_cache_key), so a
// worker's chain covers its subagents' requests too.
function speedOver(chains, { now: asked = null, windowMs = SPEED_WINDOW_MS, from = null } = {}) {
  const none = (unmeasured) => ({ result: { windowMs: null, outTokens: null, tokensPerSecond: null, requests: null, requestsPerMinute: null, unmeasured }, counted: 0 });
  const usable = [];
  const why = [];
  for (const nodes of chains) {
    const leaf = nodes?.at(-1);
    if (!leaf?.kimiSessionId || !leaf.machineId) why.push('這個對話還沒有對應到任何一台電腦上的 Kimi 對話');
    else if (!(deepseekAccount.isDeepseek(leaf) || leaf.provider === 'deepseek')) why.push('這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以算速度');
    else usable.push(nodes);
  }
  if (!usable.length) return none(why[0] || '這個叢集還沒有任何工作者');
  const byMachine = new Map();
  for (const nodes of usable) for (const n of nodes) if (n.kimiSessionId && n.machineId) (byMachine.get(n.machineId) || byMachine.set(n.machineId, new Set()).get(n.machineId)).add(n.kimiSessionId);
  let coverage = null;
  const lacking = [];
  const used = [];
  for (const [machineId, ids] of byMachine) {
    if (!machines.hasCapability(machineId, 'pool_timing')) {
      lacking.push(machines.getMachine(machineId)?.name || machineId);
      continue;
    }
    const s = stores.get(machineId);
    const cov = s ? coverageOf(s) : null;
    if (cov === null) continue;
    coverage = coverage === null ? cov : Math.min(coverage, cov);
    used.push([machineId, s, ids]);
  }
  if (lacking.length) return none(`「${lacking.join('、')}」的連接器太舊，沒有寫請求紀錄。在那台電腦重新執行連接指令更新`);
  if (coverage === null) return none('連接器還沒有回報過任何請求紀錄（沒有請求，或連接器剛連上；它回報時會自己補上）');
  // The same question inside one second is answered once (see `saved` below).
  // A caller that names its own clock gets an answer of that moment, always.
  const clock = Date.now();
  const now = finite(asked) ? asked : clock;
  const key = `${finite(asked) ? now : 'now'}|${windowMs}|${usable.length}|${finite(from) ? from : ''}|${used.map(([machineId, s, ids]) => `${machineId}:${s.version}:${[...ids].sort().join(',')}`).join(';')}`;
  const kept = saved.get(key);
  if (kept && (finite(asked) || clock - kept.at < SAVED_MS)) return { result: { ...kept.answer.result }, counted: kept.answer.counted };
  const answer = speedFrom(used, usable.length, { now, windowMs, from, coverage, none });
  saved.set(key, { at: clock, answer });
  if (saved.size > SAVED_MAX) saved.delete(saved.keys().next().value);
  return { result: { ...answer.result }, counted: answer.counted };
}

// What was worked out for a question, by its key: the records it was worked out
// from (a computer's `version`), the window, and - for a caller that named its
// own clock - the moment. Without a clock of its own a question is answered
// with the moment it was first asked for SAVED_MS: a cluster is read for its
// page, its push and the list of clusters within a second of each other, and
// each of them would read the same records again for the same figures. A
// record that arrives (a new `version`) is a different question, so it is never
// hidden by what was saved.
const SAVED_MS = 1000;
const SAVED_MAX = 512;
const saved = new Map();

// The figures themselves: the request records of the window, found by bisection
// in each conversation's list of records (in order of start time) instead of by
// reading every record the computer holds.
//   requests    started inside the window
//   outTokens   ENDED inside the window (a request longer than the window may
//               have started before it, so the search starts one longest
//               request earlier)
function speedFrom(used, counted, { now, windowMs, from, coverage, none }) {
  const since = Math.max(now - windowMs, finite(from) ? from : 0, coverage);
  const span = now - since;
  if (span < SPEED_MIN_SPAN_MS) return none(`可以算的時間窗只有 ${Math.max(0, Math.round(span / 1000))} 秒（工作剛開始，或連接器剛開始記請求），還量不出速度`);
  let outTokens = 0;
  let requests = 0;
  let unattributed = 0;
  for (const [, s, ids] of used) {
    for (const id of ids) {
      const g = s.bySession.get(id);
      if (!g) continue;
      const { recs } = g;
      // One millisecond beyond the longest request: the sum start + duration may round.
      for (let i = lowerBound(recs, since - g.maxDur - 1); i < recs.length; i++) {
        const r = recs[i];
        if (r.startAt > now) break;
        if (r.startAt >= since) requests++;
        const end = finite(r.endMs) ? r.startAt + r.endMs : null;
        if (end !== null && end >= since && end <= now && r.outTokens !== null) outTokens += r.outTokens;
      }
    }
    // A request that names no conversation may be anyone's.
    const o = s.orphans.recs;
    for (let i = lowerBound(o, since); i < o.length && o[i].startAt <= now; i++) unattributed++;
  }
  // As for the request count of a conversation: a request that names no conversation may be this one's, so a zero is not claimed.
  if (requests === 0 && unattributed > 0) return none(`窗內有 ${unattributed} 個請求沒帶對話識別（Kimi 版本沒有送 prompt_cache_key），沒辦法判斷哪些是這個對話的`);
  return {
    result: {
      windowMs: span,
      outTokens,
      tokensPerSecond: Math.round((outTokens / (span / 1000)) * 10) / 10,
      requests,
      requestsPerMinute: Math.round((requests / (span / 60_000)) * 10) / 10,
      unmeasured: null,
    },
    counted,
  };
}

export function recentSpeed(nodes, opts = {}) {
  return speedOver([nodes], opts).result;
}

// What a whole cluster produced in the last minute: the same figures as
// recentSpeed over every worker's conversation at once (so one window, one
// total - not a sum of per-worker numbers), plus how many of the cluster's
// `workers` the records could speak for. A worker they cannot is left out and
// counted as left out; the page says so.
export function recentOutput(chains, { now = Date.now(), windowMs = OUTPUT_WINDOW_MS, from = null } = {}) {
  const list = Array.isArray(chains) ? chains : [];
  const { result, counted } = speedOver(list, { now, windowMs, from });
  return { ...result, workersCounted: counted, workers: list.length };
}
