// 定時送出: messages set to go out into a conversation at a given time. The
// hub types them then, whether or not a browser is open, and keeps them with
// the conversation, so a restart keeps them too.
//   • Sent like a message typed then: while Kimi works it waits for the turn
//     to end (Kimi's queue).
//   • A machine that is offline at the time gets it once it is back, noted
//     as late. One that refuses it is tried again with growing waits, up to
//     MAX_ATTEMPTS times (about an hour); then it stays listed as not sent.
//   • Due messages of one conversation go out one at a time, in order.
// (The other kind of timing, 「5 小時額度恢復後」, is autopause.armResume.)

const BASE = {
  tick: 5_000,
  retry: [30_000, 60_000, 120_000, 300_000],
  late: 2 * 60_000, // noted as late beyond this
};
export const MAX_SCHEDULED = 20;
export const MAX_ATTEMPTS = 12;
const MAX_AHEAD = 30 * 86_400_000;

export function scheduleTimings(scale = 1) {
  const out = {};
  for (const [k, v] of Object.entries(BASE)) out[k] = Array.isArray(v) ? v.map((x) => Math.round(x * scale)) : Math.round(v * scale);
  return out;
}

// deps: { sessions(), online(session), send(session, text, opts),
//         cannotSend(session), changed(session, { immediate }), newId(), now(), timings, warn() }
export function createScheduler(deps) {
  const T = deps.timings || scheduleTimings();
  const now = deps.now || Date.now;
  const warn = deps.warn || ((...a) => console.warn('[schedule]', ...a));
  const busy = new Set(); // sessions with a message on its way

  function add(s, { text, at } = {}) {
    const msg = String(text ?? '').trim();
    if (!msg) throw Object.assign(new Error('要送出的訊息是空的'), { status: 400 });
    if (msg.length > 4000) throw Object.assign(new Error('訊息太長（最多 4000 字）'), { status: 400 });
    const when = Number(at);
    const t = now();
    if (!Number.isFinite(when)) throw Object.assign(new Error('沒有指定送出的時間'), { status: 400 });
    if (when < t - 60_000) throw Object.assign(new Error('這個時間已經過了'), { status: 400 });
    if (when > t + MAX_AHEAD) throw Object.assign(new Error('最多只能排 30 天內的訊息'), { status: 400 });
    const list = (s.scheduled ??= []);
    if (list.length >= MAX_SCHEDULED) throw Object.assign(new Error(`一個對話最多排 ${MAX_SCHEDULED} 則`), { status: 400 });
    const item = { id: deps.newId(), text: msg, at: Math.max(when, t), createdAt: t, attempts: 0, retryAt: 0, error: null, wait: null };
    list.push(item);
    list.sort((a, b) => a.at - b.at);
    deps.changed(s, { immediate: true });
    return item;
  }

  function cancel(s, id) {
    const list = s.scheduled || [];
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) throw Object.assign(new Error('找不到這則定時訊息（可能已經送出了）'), { status: 404 });
    if (busy.has(`${s.id}:${id}`)) throw Object.assign(new Error('這則訊息正在送出'), { status: 409 });
    list.splice(i, 1);
    deps.changed(s, { immediate: true });
  }

  async function run(s) {
    const t = now();
    const item = (s.scheduled || []).find((x) => x.at <= t && !x.gaveUp);
    if (!item) return;
    const before = JSON.stringify(item);
    try {
      if (t < (item.retryAt || 0)) return;
      if (!deps.online(s)) {
        item.wait = 'offline';
        return;
      }
      item.wait = null;
      const why = deps.cannotSend(s);
      if (why) throw new Error(why);
      const late = t - item.at > T.late ? Math.round((t - item.at) / 60_000) : 0;
      busy.add(`${s.id}:${item.id}`);
      try {
        await deps.send(s, item.text, { note: late ? `定時送出（晚了 ${late} 分鐘，當時沒辦法送）` : '定時送出' });
      } finally {
        busy.delete(`${s.id}:${item.id}`);
      }
      s.scheduled = (s.scheduled || []).filter((x) => x !== item);
      deps.changed(s, { immediate: true });
    } catch (err) {
      item.attempts = (item.attempts || 0) + 1;
      item.retryAt = now() + T.retry[Math.min(item.attempts, T.retry.length) - 1];
      item.error = `還沒送出：${err?.message || err}`;
      if (item.attempts >= MAX_ATTEMPTS) {
        item.gaveUp = true;
        item.error = `沒有送出（試了 ${item.attempts} 次）：${err?.message || err}`;
      }
    } finally {
      if ((s.scheduled || []).includes(item) && JSON.stringify(item) !== before) deps.changed(s, { immediate: true });
    }
  }

  const running = new Set();
  function tick() {
    return Promise.all(
      deps.sessions().map((s) => {
        if (!s.scheduled?.length || running.has(s.id)) return null;
        running.add(s.id);
        return run(s)
          .catch((err) => warn(`${s.id}: ${err?.stack || err}`))
          .finally(() => running.delete(s.id));
      }),
    );
  }

  let timer = null;
  function start() {
    timer ??= setInterval(() => tick(), T.tick);
    timer.unref?.();
    return timer;
  }

  return { add, cancel, tick, start, stop: () => (clearInterval(timer), (timer = null)) };
}
