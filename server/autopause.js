// Auto-pause: when the Kimi account's 5-hour quota reaches the share set for
// a conversation, the hub types 「優雅暫停」 into it; once the 5-hour window
// has reset, it types 「繼續」. It runs on the hub, so no browser needs to be
// open, and its state is kept with the conversation, so a restart picks up
// where it left off.
//
// The rules, per conversation:
//   • Pause only while Kimi is working (not idle, not waiting on you), and
//     at most once per 5-hour window. The message is slipped into the
//     running turn (插隊), so Kimi reads it at its next step instead of
//     after the whole turn.
//   • A turn that fails while the quota is past the mark counts as paused:
//     the quota stopped Kimi before the message could.
//   • 「繼續」 goes out once Kimi has stopped, the window's reset time has
//     passed, and a usage reading taken since shows the 5-hour quota back
//     under the mark (and the 7-day quota not used up). Before the reset
//     time the quota is still looked at now and then, so a window that
//     reset early, or a mark raised above what is used, is not waited out.
//   • If the conversation starts working again while paused (someone sent
//     it a message), 「繼續」 is called off: whoever did that took over.
//   • 「額度恢復後送出」 (armResume) is the same wait, started by hand, for a
//     conversation paused some other way (you told Kimi to stop yourself).
//     Auto-pause need not be on. As the quota may be under the mark then,
//     it also waits for proof that the window has reset since: usage went
//     down, or Kimi reports a later reset time. Its message can be any text.
// Machines, Kimi and the store come in through `deps`, so the rules can be
// tested on their own (test/autopause.test.mjs).

export const PAUSE_TEXT = '優雅暫停';
export const RESUME_TEXT = '繼續';
export const DEFAULT_THRESHOLD = 90;

const BASE = {
  tick: 5_000, // how often conversations are looked at
  watchTtl: 30_000, // usage is read this often while Kimi works
  resumeTtl: 60_000, // ... and while waiting to send 「繼續」
  pausedTtl: 10 * 60_000, // ... and now and then while paused, before the reset time
  minGap: 10_000, // never read one machine's usage more often than this
  settle: 5_000, // idle this long after the pause = Kimi has stopped
  own: 90_000, // work that starts this soon after a 「繼續」 that seemed to fail is ours
  stopCheck: 10 * 60_000, // how long a failed turn is checked against the quota
  window: 5 * 3600_000, // when Kimi gives no reset time
  retry: [30_000, 60_000, 120_000, 300_000], // after a message did not go out
};
const LOG_MAX = 20;

// All waits scaled at once (tests run them faster).
export function timings(scale = 1) {
  const out = {};
  for (const [k, v] of Object.entries(BASE)) out[k] = Array.isArray(v) ? v.map((x) => Math.round(x * scale)) : Math.round(v * scale);
  return out;
}

// Kimi's /oauth/usage result → the 5-hour and 7-day windows. `rolled`: the
// reading itself says its window already ended (Kimi has not rolled it over
// yet), so its numbers cannot be trusted to pause on.
export function parseUsage(data, at) {
  if (data?.kind !== 'ok') {
    const msg = String(data?.message || '');
    const login = /no token|login|unauthori|authoriz/i.test(msg);
    return { ok: false, at, error: login ? '這台電腦的 Kimi 沒有用 Kimi 帳號登入，讀不到 5 小時額度' : `讀不到方案用量${msg ? `：${msg}` : ''}` };
  }
  const win = (k) => {
    const v = data.quota?.usages?.[k];
    const used = typeof v?.usedRatio === 'number' ? v.usedRatio : Number(v?.usedRatio);
    if (!v || v.usedRatio == null || !Number.isFinite(used)) return null;
    const resetAt = Date.parse(v.resetAt);
    return { used, resetAt: Number.isFinite(resetAt) ? resetAt : null };
  };
  const h5 = win('limit5h');
  if (!h5) return { ok: false, at, error: '這個 Kimi 帳號沒有 5 小時額度，沒辦法自動暫停' };
  return { ok: true, at, h5, d7: win('limit7d'), rolled: Boolean(h5.resetAt && h5.resetAt <= at) };
}

// What a Kimi conversation is doing: 'running', 'awaiting' (waiting on you),
// 'error' (its last turn failed) or 'idle'. The hub's own status is the
// freshest while it follows the conversation (`live`); the machine's session
// list (busy, waiting, last turn) covers the time it does not.
export function activityOf(session, machine, live) {
  if (!machine?.online || machine.kimi?.available === false) return { online: false, state: 'idle', busy: false };
  const e = (machine.sessions || []).find((x) => x.id === session.kimiSessionId);
  const st = session.status;
  const hub = live ? (st === 'running' ? 'running' : st === 'awaiting_permission' ? 'awaiting' : null) : null;
  const kimi = e?.busy ? (e.pending && e.pending !== 'none' ? 'awaiting' : 'running') : null;
  let state = hub === 'awaiting' || kimi === 'awaiting' ? 'awaiting' : hub || kimi;
  if (!state) state = (live ? st === 'error' : e?.lastTurn === 'failed') ? 'error' : 'idle';
  // A message waiting for the turn to end starts the next one.
  const queued = (session.meta?.queue || []).some((q) => !q.steered);
  return { online: true, state, busy: state === 'running' || state === 'awaiting' || queued };
}

const pct = (ratio) => Math.round(ratio * 100);
const over = (ratio, threshold) => ratio * 100 >= threshold;

// Something to do for this conversation: watching the quota, or a message
// waiting for the reset.
export const isActive = (a) => Boolean(a && (a.enabled || a.phase === 'paused'));

// The 5-hour window has reset since the pause: usage went down (only a reset
// does that), or Kimi reports a later reset time than the one known then.
function windowRenewed(a, r, t) {
  if (a.pausedUsed != null && r.h5.used < a.pausedUsed - 0.005) return true;
  if (r.rolled) return false;
  if (r.h5.resetAt && a.resetAt && r.h5.resetAt > a.resetAt + 60_000) return true;
  return Boolean(a.guessedReset && t >= a.resetAt);
}

// deps: {
//   sessions()                     conversations with auto-pause on
//   activity(session)              → activityOf(...)
//   readUsage(machineId)           → Kimi's /oauth/usage result
//   send(session, text, opts)      types a message; throws if it did not go out
//   cannotSend(session)            → why messages cannot be sent, or null
//   changed(session, { immediate })  persist and broadcast
//   info(session, text)            a note in the conversation
//   now(), timings, warn()
// }
export function createAutoPause(deps) {
  const T = deps.timings || timings();
  const now = deps.now || Date.now;
  const warn = deps.warn || ((...a) => console.warn('[autopause]', ...a));
  const seen = new Map(); // session id -> { state, busy, at }: activity last seen, and since when
  const busyEval = new Set(); // sessions being looked at
  const sending = new Set(); // sessions with one of our messages on its way
  const stops = new Map(); // session id -> when a turn failed while watching
  const usage = new Map(); // machine id -> { at, value?, promise? }

  const changed = (s, immediate = false) => deps.changed(s, { immediate });

  function log(s, text) {
    const a = s.autoPause;
    a.log = [...(a.log || []), { ts: now(), text }].slice(-LOG_MAX);
  }

  // A usage reading at most `ttl` old (and taken after `since`), shared by
  // every conversation on the machine. Null when none can be had yet.
  async function reading(machineId, ttl, since = 0, force = false) {
    const t = now();
    const c = usage.get(machineId);
    const usable = (v) => v && v.at >= since && t - v.at < ttl && !(v.ok && v.h5.resetAt && v.h5.resetAt > v.at && t >= v.h5.resetAt);
    if (usable(c?.value)) return c.value;
    if (c?.promise) {
      const v = await c.promise;
      return usable(v) || (v && !v.ok) ? v : null;
    }
    if (c && t - c.at < T.minGap && !force) return null;
    // Stamped with when it was asked for: usage only grows within a window,
    // so that is the time it is sure to be true for.
    const promise = Promise.resolve()
      .then(() => deps.readUsage(machineId))
      .then(
        (data) => parseUsage(data, t),
        (err) => ({ ok: false, at: t, error: `讀不到方案用量：${err?.message || err}` }),
      );
    usage.set(machineId, { at: t, value: c?.value, promise });
    const value = await promise;
    usage.set(machineId, { at: t, value });
    return value;
  }

  // ------------------------------------------------------------ changes

  // Called on every status change (and each look): notices work starting
  // while paused, and turns that fail while watching.
  function observe(s, act = deps.activity(s)) {
    const a = s.autoPause;
    if (!isActive(a) || !act.online) return;
    const t = now();
    const prev = seen.get(s.id);
    if (prev && prev.state === act.state && prev.busy === act.busy) return;
    seen.set(s.id, { state: act.state, busy: act.busy, at: t });
    if (sending.has(s.id)) return; // our own message moving things
    if (!prev) {
      // First look since the hub started: a conversation that had stopped
      // after the pause and is working again was taken over meanwhile.
      if (a.phase === 'paused' && a.settled && act.busy) takeOver(s);
      return;
    }
    if (a.phase === 'paused' && a.settled && act.busy && !prev.busy) return takeOver(s);
    if (a.enabled && a.phase === 'watching' && prev.busy && act.state === 'error') stops.set(s.id, t);
  }

  function takeOver(s) {
    const a = s.autoPause;
    const text = a.resumeText || RESUME_TEXT;
    // A 「繼續」 that looked like it failed may have gone through after all.
    const ours = a.lastSent === 'resume' && now() - (a.sentAt || 0) < T.own;
    Object.assign(a, { phase: 'watching', reason: null, resumeText: null, settled: false, failures: 0, retryAt: 0, error: null, wait: null });
    if (ours) log(s, `對話開始工作了，剛才的「${text}」應該已經送達`);
    else {
      log(s, `暫停期間對話又開始工作，取消自動「${text}」`);
      deps.info?.(s, `暫停期間對話又開始工作，不會自動送出「${text}」`);
    }
    changed(s, true);
  }

  // ------------------------------------------------------------ actions

  function failed(s, kind, text, err) {
    const a = s.autoPause;
    const t = now();
    a.failures = (a.failures || 0) + 1;
    a.retryAt = t + T.retry[Math.min(a.failures, T.retry.length) - 1];
    a.error = `沒有送出「${text}」：${err?.message || err}`;
    if (kind === 'resume') Object.assign(a, { sentAt: t, lastSent: 'resume' });
    log(s, a.error);
    changed(s, true);
  }

  async function pause(s, r) {
    const a = s.autoPause;
    sending.add(s.id);
    try {
      await deps.send(s, PAUSE_TEXT, { steer: true, note: `自動暫停：5 小時額度已用 ${pct(r.h5.used)}%（門檻 ${a.threshold}%）` });
    } catch (err) {
      return failed(s, 'pause', PAUSE_TEXT, err);
    } finally {
      sending.delete(s.id);
    }
    const t = now();
    log(s, `5 小時額度已用 ${pct(r.h5.used)}%，送出「${PAUSE_TEXT}」`);
    // Turned off while the message was on its way: nothing to resume.
    if (a.enabled) {
      Object.assign(a, { phase: 'paused', reason: 'sent', pausedAt: t, pausedUsed: r.h5.used, resetAt: r.h5.resetAt, quietUntil: r.h5.resetAt || t + T.window, settled: false, sentAt: t, lastSent: 'pause', failures: 0, retryAt: 0, error: null, wait: { kind: 'stopping' } });
    }
    changed(s, true);
  }

  async function resume(s, r) {
    const a = s.autoPause;
    const text = a.resumeText || RESUME_TEXT;
    sending.add(s.id);
    try {
      await deps.send(s, text, { note: `自動送出：5 小時額度已恢復（已用 ${pct(r.h5.used)}%）` });
    } catch (err) {
      return failed(s, 'resume', text, err);
    } finally {
      sending.delete(s.id);
    }
    const t = now();
    // The mark applies again right away, also when resuming before the reset.
    Object.assign(a, { phase: 'watching', reason: null, resumeText: null, settled: false, quietUntil: 0, sentAt: t, lastSent: 'resume', resumedAt: t, failures: 0, retryAt: 0, error: null, wait: null });
    log(s, `5 小時額度已恢復（已用 ${pct(r.h5.used)}%），送出「${text}」`);
    changed(s, true);
  }

  function stoppedByQuota(s, r) {
    const a = s.autoPause;
    const t = now();
    Object.assign(a, { phase: 'paused', reason: 'quota', pausedAt: t, pausedUsed: r.h5.used, resetAt: r.h5.resetAt, quietUntil: r.h5.resetAt || t + T.window, settled: true, failures: 0, retryAt: 0, error: null, wait: r.h5.resetAt ? { kind: 'reset', until: r.h5.resetAt } : null });
    log(s, `Kimi 停下時 5 小時額度已用 ${pct(r.h5.used)}%，額度恢復後送出「${RESUME_TEXT}」`);
    deps.info?.(s, `Kimi 停下時 5 小時額度已用 ${pct(r.h5.used)}%，額度恢復後會自動送出「${RESUME_TEXT}」`);
    changed(s, true);
  }

  // ------------------------------------------------------------- checks

  async function watching(s, act, t) {
    const a = s.autoPause;
    const stoppedAt = stops.get(s.id);
    if (stoppedAt && (act.busy || t - stoppedAt > T.stopCheck)) stops.delete(s.id);
    if (t < (a.quietUntil || 0)) {
      // Paused once in this window already, and someone took over.
      a.wait = { kind: 'quiet', until: a.quietUntil };
      stops.delete(s.id);
      return;
    }
    a.wait = null;
    const stopped = stops.has(s.id) && act.state === 'error';
    if (act.state !== 'running' && !stopped) {
      // Nothing to pause: earlier problems no longer apply.
      Object.assign(a, { failures: 0, retryAt: 0, error: null });
      return;
    }
    if (t < (a.retryAt || 0)) return;
    const r = await reading(s.machineId, T.watchTtl, stopped ? stops.get(s.id) : 0);
    if (!r) return;
    if (!r.ok) {
      a.error = r.error;
      return;
    }
    if (a.error && !a.failures) a.error = null;
    if (r.rolled || !over(r.h5.used, a.threshold)) {
      if (stopped) stops.delete(s.id);
      return;
    }
    // Still so after the wait?
    const now2 = deps.activity(s);
    if (!a.enabled || a.phase !== 'watching' || now() < (a.quietUntil || 0) || !now2.online) return;
    if (stopped) {
      stops.delete(s.id);
      if (!now2.busy) stoppedByQuota(s, r);
      return;
    }
    if (now2.state !== 'running') return;
    const why = deps.cannotSend(s);
    if (why) {
      a.error = why;
      return;
    }
    await pause(s, r);
  }

  async function paused(s, act, t) {
    const a = s.autoPause;
    if (act.busy) {
      a.wait = { kind: 'stopping' };
      return;
    }
    if (!a.settled) {
      if (t - (seen.get(s.id)?.at ?? t) < T.settle) {
        a.wait = { kind: 'stopping' };
        return;
      }
      a.settled = true;
    }
    const early = Boolean(a.resetAt && t < a.resetAt);
    if (early) a.wait = { kind: 'reset', until: a.resetAt };
    else if (!['usage', 'week'].includes(a.wait?.kind)) a.wait = { kind: 'confirm' }; // reset time passed: making sure
    if (t < (a.retryAt || 0)) return;
    const r = await reading(s.machineId, early ? T.pausedTtl : T.resumeTtl);
    if (!r) return;
    if (!r.ok) {
      a.error = r.error;
      return;
    }
    if (a.error && !a.failures) a.error = null;
    const renewed = windowRenewed(a, r, t);
    if (over(r.h5.used, a.threshold) || (early && r.rolled)) {
      // Not reset yet, or used up again by something else: wait for the next
      // reset (measured from this window from now on).
      if (r.h5.resetAt && !r.rolled) {
        if (renewed) a.pausedUsed = r.h5.used;
        Object.assign(a, { resetAt: r.h5.resetAt, guessedReset: false });
      }
      a.wait = a.resetAt && now() < a.resetAt ? { kind: 'reset', until: a.resetAt } : { kind: 'usage', used: r.h5.used, until: r.rolled ? null : r.h5.resetAt };
      return;
    }
    // Set by hand under the mark: only once the window it was set in is over.
    if (a.reason === 'manual' && !renewed) return;
    if (r.d7 && r.d7.used >= 1) {
      a.wait = { kind: 'week', until: r.d7.resetAt };
      return;
    }
    const now2 = deps.activity(s);
    if (a.phase !== 'paused' || !now2.online || now2.busy) return;
    const why = deps.cannotSend(s);
    if (why) {
      a.error = why;
      return;
    }
    await resume(s, r);
  }

  async function evaluate(s) {
    const a = s.autoPause;
    const before = JSON.stringify(a);
    try {
      const act = deps.activity(s);
      observe(s, act);
      if (!isActive(a)) return;
      if (!act.online) {
        a.wait = { kind: 'offline' };
        return;
      }
      if (a.wait?.kind === 'offline') a.wait = null;
      if (a.phase === 'paused') await paused(s, act, now());
      else if (a.enabled) await watching(s, act, now());
    } finally {
      if (s.autoPause === a && JSON.stringify(a) !== before) changed(s);
    }
  }

  // ------------------------------------------------------------ outside

  function tick() {
    const list = deps.sessions().filter((s) => isActive(s.autoPause));
    const ids = new Set(list.map((s) => s.id));
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id), stops.delete(id);
    return Promise.all(
      list.map((s) => {
        if (busyEval.has(s.id)) return null;
        busyEval.add(s.id);
        return evaluate(s)
          .catch((err) => warn(`${s.id}: ${err?.stack || err}`))
          .finally(() => busyEval.delete(s.id));
      }),
    );
  }

  const fresh = () => ({ phase: 'watching', reason: null, resumeText: null, pausedAt: null, pausedUsed: null, resetAt: null, guessedReset: false, quietUntil: 0, settled: false, failures: 0, retryAt: 0, error: null, wait: null });
  const blank = () => ({ enabled: false, threshold: DEFAULT_THRESHOLD, ...fresh(), log: [] });
  // A wait set by hand is its own thing: turning auto-pause on or off keeps it.
  const handSet = (a) => a.phase === 'paused' && a.reason === 'manual';

  function configure(s, { enabled, threshold } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') throw Object.assign(new Error('enabled 要是 true 或 false'), { status: 400 });
    let n;
    if (threshold !== undefined) {
      n = Number(threshold);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw Object.assign(new Error('門檻要是 1 到 100 之間的整數'), { status: 400 });
    }
    const a = (s.autoPause ??= blank());
    if (n !== undefined && n !== a.threshold) {
      a.threshold = n;
      if (a.enabled && enabled !== false) log(s, `門檻改成 ${n}%`);
    }
    if (enabled === true && !a.enabled) {
      if (handSet(a)) a.enabled = true;
      else {
        Object.assign(a, fresh(), { enabled: true });
        seen.delete(s.id);
      }
      stops.delete(s.id);
      log(s, `開啟自動暫停，門檻 ${a.threshold}%`);
      observe(s);
    } else if (enabled === false && a.enabled) {
      const drop = a.phase === 'paused' && !handSet(a);
      if (handSet(a)) a.enabled = false;
      else {
        Object.assign(a, fresh(), { enabled: false });
        seen.delete(s.id);
      }
      stops.delete(s.id);
      log(s, drop ? `關閉自動暫停，不會送出「${RESUME_TEXT}」` : '關閉自動暫停');
    }
    changed(s, true);
    return a;
  }

  // 「取消自動繼續」: auto-pause stays on for the next windows, but this one
  // is left alone.
  function cancelResume(s) {
    const a = s.autoPause;
    if (a?.phase !== 'paused') throw Object.assign(new Error(`目前沒有等著送出的「${RESUME_TEXT}」`), { status: 409 });
    const text = a.resumeText || RESUME_TEXT;
    Object.assign(a, { phase: 'watching', reason: null, resumeText: null, settled: false, failures: 0, retryAt: 0, error: null, wait: null });
    log(s, `你取消了自動「${text}」`);
    changed(s, true);
  }

  // 「額度恢復後送出」: wait for the 5-hour window to reset, then send `text`
  // (「繼續」), for a conversation paused by hand. Reads the quota now, to
  // know which window it is.
  async function armResume(s, { text } = {}) {
    const msg = String(text ?? RESUME_TEXT).trim();
    if (!msg) throw Object.assign(new Error('要送出的訊息是空的'), { status: 400 });
    if (msg.length > 4000) throw Object.assign(new Error('訊息太長（最多 4000 字）'), { status: 400 });
    const r = await reading(s.machineId, T.resumeTtl, 0, true);
    if (!r?.ok) throw Object.assign(new Error(`${r?.error || '讀不到方案用量'}，沒辦法知道額度什麼時候恢復`), { status: 409 });
    const a = (s.autoPause ??= blank());
    const t = now();
    const resetAt = r.h5.resetAt || t + T.window;
    Object.assign(a, { phase: 'paused', reason: 'manual', resumeText: msg, pausedAt: t, pausedUsed: r.h5.used, resetAt, guessedReset: !r.h5.resetAt, settled: false, failures: 0, retryAt: 0, error: null, wait: { kind: 'stopping' } });
    // Auto-pause has nothing to pause in a window already paused by hand.
    if (a.enabled) a.quietUntil = Math.max(a.quietUntil || 0, resetAt);
    stops.delete(s.id);
    log(s, `設定 5 小時額度恢復後送出「${msg}」（目前已用 ${pct(r.h5.used)}%）`);
    observe(s); // from now on, so Kimi stopping is seen
    changed(s, true);
    return a;
  }

  let timer = null;
  function start() {
    timer ??= setInterval(() => tick(), T.tick);
    timer.unref?.();
    return timer;
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { tick, observe, configure, cancelResume, armResume, start, stop };
}
