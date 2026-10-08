// The plan quota, read right. Kimi's /usages answer carries it twice: as
// ratios (usages.limit_5h.used_ratio …), all Kimi Code reads and shows, and
// as counts (usage for the week, limits[] for the 5-hour window). The ratios
// have been seen stuck at 0 while the counts, and the 403 "limit reached",
// say otherwise (MoonshotAI/kimi-code#3817, #3908, #3951, #4133). So a
// window the counts describe too (same reset time) shows the higher of the
// two, and a window only the counts describe is taken from them. Counts of
// another period (another reset time, or one already past) are left alone.

const MATCH_MS = 2 * 60_000;
const SLACK_MS = 10 * 60_000;
const WINDOW_MS = { limit5h: 5 * 3600_000, limit7d: 7 * 86400_000 };
const MINUTES = { SECOND: 1 / 60, MINUTE: 1, HOUR: 60, DAY: 1440 };

const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const time = (v) => (typeof v === 'string' && v ? Date.parse(v) : NaN);

// {limit, used, remaining, resetTime} (numbers or strings) → counts.
export function countEntry(d) {
  if (!d || typeof d !== 'object') return null;
  const limit = num(d.limit);
  if (!limit || limit <= 0) return null;
  let used = num(d.used);
  const remaining = num(d.remaining);
  if (used == null && remaining != null) used = limit - remaining;
  if (used == null) return null;
  used = Math.max(0, Math.min(limit, used));
  const resetAt = [d.resetTime, d.reset_time, d.resetAt].find((v) => Number.isFinite(time(v)));
  return { used, limit, ratio: used / limit, resetAt };
}

const minutesOf = (w) => {
  const n = num(w?.duration);
  const unit = MINUTES[String(w?.timeUnit || w?.time_unit || '').toUpperCase().replace(/^TIME_UNIT_/, '')];
  return n != null && unit ? n * unit : null;
};

// The counts in an /usages answer, by window.
export function countsOf(raw) {
  const out = {};
  for (const l of Array.isArray(raw?.limits) ? raw.limits : []) {
    const m = minutesOf(l?.window);
    const c = countEntry(l?.detail);
    if (!c || m == null) continue;
    if (Math.abs(m - 300) < 1) out.limit5h ??= c;
    else if (Math.abs(m - 10080) < 1) out.limit7d ??= c;
  }
  // The top-level `usage` is the weekly quota.
  const week = countEntry(raw?.usage);
  if (week) out.limit7d ??= week;
  return out;
}

// Kimi's parsed quota ({usages: {limit5h: {usedRatio, resetAt}, …}}) with
// the counts of the same answer folded in. A window corrected from counts
// carries `counted: {used, limit}` and, when Kimi had a ratio for it,
// `reported` (that ratio).
export function mergeQuota(quota, raw, now = Date.now()) {
  if (!quota || typeof quota !== 'object') return quota;
  const counts = countsOf(raw);
  const usages = { ...(quota.usages || {}) };
  for (const [k, c] of Object.entries(counts)) {
    const reset = time(c.resetAt);
    // Counts of a window already over, or longer away than the window lasts,
    // are not this window's.
    if (!Number.isFinite(reset) || reset <= now || reset > now + WINDOW_MS[k] + SLACK_MS) continue;
    const r = usages[k];
    const rReset = time(r?.resetAt);
    if (r && Number.isFinite(rReset) && Math.abs(rReset - reset) > MATCH_MS) continue;
    // With no weekly ratio to compare with, counts that reset with the month
    // are the month's.
    if (!r && ['monthTotal', 'monthCode'].some((m) => Math.abs(time(usages[m]?.resetAt) - reset) <= MATCH_MS)) continue;
    const reported = typeof r?.usedRatio === 'number' && Number.isFinite(r.usedRatio) ? r.usedRatio : null;
    if (reported != null && c.ratio <= reported + 0.005) continue;
    usages[k] = { ...(r || {}), usedRatio: c.ratio, resetAt: r?.resetAt || c.resetAt, counted: { used: c.used, limit: c.limit }, ...(reported != null ? { reported } : {}) };
  }
  return { ...quota, usages };
}
