// Key recovery for DeepSeek conversations (2026-10-30): a turn that ended because the keys ran
// out of quota or were rate limited does not stay in "error" waiting for a person. When a key
// is available again that was not at the time, the Hub types 「繼續」 into the conversation by
// itself - once for each interrupted turn.
//
// The rules:
//   - Only a DeepSeek conversation (a Kimi on a subscription and a Claude conversation do not use the
//     key pool, so nothing here is theirs), whose last turn ended with an error that says the quota
//     is gone or a rate limit was hit (classifyTurnError: Kimi's own `provider.rate_limit` code, and
//     the words of the quota errors the connector's proxy and the gateways give). An auth error, an
//     overloaded provider, a network error, any other error: not this.
//   - At the moment the turn ended the keys that were available are written down. 「繼續」 goes out
//     when a key is available now that was not then: a stated reset time passed, a person cleared a
//     mark, a key was added, a cooldown ended, a real request proved a key. Nothing is estimated: a
//     key out of quota with no stated time stays out until one of those happens.
//   - Once for each interrupted turn, and never in a row: if the turn that 「繼續」 started fails again,
//     nothing more is sent until a turn has gone through (a person who writes to the conversation
//     takes it over and ends the automatic one).
//   - Only a turn that ended in the last two hours; and only while the setting is on (it is, by default).
//   - It is said in the conversation: 「已在 key 恢復後自動繼續」.
// The state is kept with the conversation (`session.keyRecover`), so a restart of the Hub picks up
// where it was. Everything outside comes in through `deps`, so the rules are tested by themselves
// (test/key-recover.test.mjs) and with a real Hub (test/e2e-key-recover.test.mjs).

export const RESUME_TEXT = '繼續';
export const INFO_TEXT = '已在 key 恢復後自動繼續';
export const WINDOW_MS = 2 * 3_600_000;
const MAX_SEND_FAILURES = 3;
const OURS_MS = 60_000;

// Kimi's own words for a provider error are `error.code`: `provider.rate_limit` (HTTP 429) is the
// one this uses; the rest of a quota error is in its message - the connector's proxy says
// `insufficient_quota` / 「DeepSeek 的 API key 都已用盡」 when every key is out, and a gateway's own
// quota wording comes through as it is.
const QUOTA = /insufficient[_\s-]*quota|quota[\s\S]{0,12}\b(?:exceeded|exhausted)\b|都已用盡|額度(?:用盡|用完)|insufficient[_\s-]*(?:credits?|balance|funds)|out of credits?|credits?[\s\S]{0,12}\b(?:exhausted|depleted)\b|payment required|\b402\b/i;
const RATE = /\b429\b|rate[\s_-]?limit|too many requests|限流/i;
// Provider errors that are about something else, whatever the message adds.
const OTHER = /^provider\.(?:auth_error|connection_error|filtered|not_found|overloaded)$/;

// 'quota', 'rate' or null (not this kind of error).
export function classifyTurnError({ code = '', text = '' } = {}) {
  const t = String(text || '').slice(0, 4000);
  const c = String(code || '');
  if (QUOTA.test(t)) return 'quota';
  if (OTHER.test(c)) return null;
  if (c === 'provider.rate_limit' || RATE.test(t)) return 'rate';
  return null;
}

// The newest turn of a conversation, if it ended in an error: { turnEnd, error } (the `turn_end`
// event and the error event of that turn, or null), else null. A turn that started after it, or one
// that ended well, is not a failed turn.
export function lastFailedTurn(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'user') return null;
    if (e.type !== 'turn_end') continue;
    if (!e.error) return null;
    for (let j = i - 1; j >= 0; j--) {
      const x = events[j];
      if (x.type === 'user' || x.type === 'turn_end') break;
      if (x.type === 'error') return { turnEnd: e, error: x };
    }
    return { turnEnd: e, error: null };
  }
  return null;
}

// deps: {
//   isDeepseek(session)        a conversation that uses the DeepSeek key pool
//   sessions()                 every conversation (looked at once, at start, for what a restart left)
//   getSession(id)             the conversation, or undefined (deleted)
//   enabled()                  the setting (on unless a person turned it off)
//   availability()             { ids: Set(key id), nextAt }  the keys that can be counted on now, and the next
//                              moment that is going to change from a time somebody stated (or null)
//   send(session, text)        types it into the conversation (rejects when it did not get through)
//   info(session, text)        leaves a system note in the conversation
//   changed(session)           the conversation's keyRecover changed: keep it
//   now()                      the clock (default Date.now)
//   schedule(fn, ms) -> handle / unschedule(handle)   timers (default setTimeout / clearTimeout)
// }
export function createKeyRecover(deps) {
  const now = deps.now || Date.now;
  const schedule = deps.schedule || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const unschedule = deps.unschedule || clearTimeout;
  const pending = new Map(); // conversation id -> its marker (the same object as session.keyRecover)
  const ours = new Map(); // conversation id -> when we typed 「繼續」 (until its turn is seen starting)
  let timer = null;
  let current = null; // the pass that is going on (a call that comes meanwhile makes it go once more)
  let again = false;

  // A DeepSeek conversation of its own: not a Claude one, and not a sub-agent's (its parent's turn
  // decides what happens to that). A cluster worker has no parent: it is one.
  const mine = (session) => Boolean(session && deps.isDeepseek(session) && session.agentId !== 'claude' && !session.parentId);
  const keep = (session) => deps.changed?.(session);
  const drop = (session) => {
    pending.delete(session.id);
    ours.delete(session.id);
    if (session.keyRecover) {
      session.keyRecover = null;
      keep(session);
    }
  };

  // A conversation's status changed (or it was just looked at): note a turn that ended on a quota or
  // rate-limit error, and let go of one that went on by itself.
  function observe(session) {
    if (!mine(session)) return;
    const marker = session.keyRecover;
    const status = session.status;
    if (status === 'idle') {
      // A turn went through: the conversation is fine, and the automatic continue may be used again.
      if (marker) drop(session);
      return;
    }
    if (status === 'running' || status === 'awaiting_permission') {
      // Somebody wrote to it. If that was not us, they took over: our note about the old failure is done with.
      if (marker && !ours.has(session.id)) drop(session);
      else ours.delete(session.id);
      return;
    }
    if (status !== 'error') return;
    const failed = lastFailedTurn(session.events);
    if (!failed) return;
    if (marker?.turnEventId === failed.turnEnd.id) return;
    const kind = classifyTurnError({ code: failed.error?.code, text: failed.error?.text });
    if (!kind) return;
    // The turn we started with 「繼續」 failed again: no loop. It waits for a person (or a turn that goes through).
    if (marker?.chainOpen) {
      session.keyRecover = { ...marker, gaveUpOn: failed.turnEnd.id };
      keep(session);
      return;
    }
    const fresh = { turnEventId: failed.turnEnd.id, errorAt: Number(failed.turnEnd.ts) || now(), kind, avail: [...deps.availability().ids], sendFailures: 0 };
    session.keyRecover = fresh;
    pending.set(session.id, fresh);
    keep(session);
    evaluate();
  }

  // Look at what is waiting: is a key available that was not, for each interrupted turn that is
  // recent enough and still the conversation's last word?
  function evaluate() {
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          try {
            await pass();
          } catch (err) {
            deps.log?.(err);
          }
        } while (again);
      } finally {
        current = null;
      }
    })();
    return current;
  }

  async function pass() {
    unschedule(timer);
    timer = null;
    const av = deps.availability();
    const t = now();
    if (av.nextAt && pending.size) timer = schedule(() => evaluate(), Math.min(2_000_000_000, Math.max(50, av.nextAt - t + 50)));
    if (!deps.enabled()) return;
    for (const [id, marker] of [...pending]) {
      const session = deps.getSession(id);
      if (!session) {
        pending.delete(id);
        continue;
      }
      if (marker.resumedAt || t - marker.errorAt > WINDOW_MS) {
        pending.delete(id);
        continue;
      }
      // Only while it is still the conversation's last word, in the state the failure left it.
      const failed = lastFailedTurn(session.events);
      if (session.status !== 'error' || !failed || failed.turnEnd.id !== marker.turnEventId) {
        drop(session);
        continue;
      }
      if (!av.ids.size) continue;
      if (![...av.ids].some((k) => !marker.avail.includes(k))) continue;
      // Typed once; if it did not get through (the computer is away) it is tried again at the next news, a few times.
      marker.resumedAt = t;
      marker.chainOpen = true;
      ours.set(id, t);
      keep(session);
      try {
        await deps.send(session, RESUME_TEXT);
        pending.delete(id);
        deps.info?.(session, INFO_TEXT);
      } catch {
        marker.resumedAt = 0;
        marker.chainOpen = false;
        marker.sendFailures = (marker.sendFailures || 0) + 1;
        ours.delete(id);
        if (marker.sendFailures >= MAX_SEND_FAILURES) pending.delete(id);
        keep(session);
      }
    }
    // A note of ours that never saw its turn start is forgotten after a while.
    for (const [id, at] of ours) if (t - at > OURS_MS) ours.delete(id);
  }

  // After a restart: what the last run left, for the conversations whose failure is still recent and last.
  function start() {
    const t = now();
    for (const session of deps.sessions()) {
      const m = session.keyRecover;
      if (!m || m.resumedAt || !mine(session) || session.status !== 'error') continue;
      if (t - m.errorAt > WINDOW_MS || !Array.isArray(m.avail)) continue;
      pending.set(session.id, m);
    }
    if (pending.size) evaluate();
  }

  return { observe, evaluate, start, pending: () => new Map(pending), stop: () => unschedule(timer) };
}
