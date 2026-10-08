// The plan quota read right (server/quota.js): Kimi's ratios have been seen
// stuck at 0 while the counts in the same answer are right. The answers here
// are shaped like the ones posted in MoonshotAI/kimi-code#3951,
// steipete/CodexBar#3754 and #4306.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuota, countsOf, countEntry } from '../server/quota.js';

const NOW = Date.parse('2026-10-08T10:00:00Z');
const at = (h) => new Date(NOW + h * 3600_000).toISOString();
// Kimi's parse of an answer (its parseManagedUsagePayload).
const kimi = (raw) => ({
  usages: Object.fromEntries(
    Object.entries({ limit5h: 'limit_5h', limit7d: 'limit_7d', monthTotal: 'limit_month_total', monthCode: 'limit_month_code' })
      .filter(([, w]) => raw.usages?.[w])
      .map(([k, w]) => [k, { usedRatio: raw.usages[w].used_ratio, resetAt: raw.usages[w].reset_time }]),
  ),
  extraUsage: null,
});
const five = (detail) => ({ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail });

test('ratios stuck at 0, counts right: the counts are shown, marked', () => {
  // CodexBar#3754: 5 h 1/100 and the week 19/100, both ratios 0.
  const raw = {
    usage: { limit: '100', used: '19', remaining: '81', resetTime: at(80) },
    limits: [five({ limit: '100', used: '1', remaining: '99', resetTime: at(3) })],
    usages: { limit_5h: { used_ratio: 0, reset_time: at(3) }, limit_7d: { used_ratio: 0, reset_time: at(80) } },
  };
  const q = mergeQuota(kimi(raw), raw, NOW);
  assert.deepEqual(q.usages.limit5h, { usedRatio: 0.01, resetAt: at(3), counted: { used: 1, limit: 100 }, reported: 0 });
  assert.deepEqual(q.usages.limit7d, { usedRatio: 0.19, resetAt: at(80), counted: { used: 19, limit: 100 }, reported: 0 });
  assert.equal(q.extraUsage, null);
});

test('the week used up while its ratio says 0: 100%', () => {
  // kimi-code#3951: the API answers 403 (weekly limit), `usage` says
  // 100/100, the 5-hour counts say nothing used, every ratio 0.
  const raw = {
    usage: { limit: '100', used: '100', remaining: '0', resetTime: at(40) },
    limits: [five({ limit: '100', remaining: '100', resetTime: at(2) })],
    usages: { limit_5h: { used_ratio: 0, reset_time: at(2) }, limit_7d: { used_ratio: 0, reset_time: at(40) } },
  };
  const q = mergeQuota(kimi(raw), raw, NOW);
  assert.equal(q.usages.limit7d.usedRatio, 1);
  assert.equal(q.usages.limit5h.usedRatio, 0, 'the 5 hours really are unused');
  assert.equal(q.usages.limit5h.counted, undefined);
});

test('a monthly plan: the 5-hour counts, the month as Kimi has it', () => {
  // CodexBar#4306: 5 h exhausted by its counts, ratio 0; a monthly pool.
  const raw = {
    limits: [five({ limit: '100', used: '100', remaining: '0', resetTime: at(1) })],
    usages: { limit_5h: { used_ratio: 0, reset_time: at(1) }, limit_month_total: { used_ratio: 0.5531, reset_time: at(300) }, limit_month_code: { used_ratio: 0, reset_time: at(300) } },
  };
  const q = mergeQuota(kimi(raw), raw, NOW);
  assert.equal(q.usages.limit5h.usedRatio, 1);
  assert.equal(q.usages.monthTotal.usedRatio, 0.5531);
  assert.equal(q.usages.limit7d, undefined);
});

test('a ratio that is right stays; so does one higher than the counts', () => {
  const raw = {
    usage: { limit: '100', used: '35', resetTime: at(50) },
    limits: [five({ limit: '100', used: '10', resetTime: at(4) })],
    usages: { limit_5h: { used_ratio: 0.17, reset_time: at(4) }, limit_7d: { used_ratio: 0.352, reset_time: at(50) } },
  };
  const q = mergeQuota(kimi(raw), raw, NOW);
  assert.deepEqual(q.usages, kimi(raw).usages);
});

test('counts of another period are left alone', () => {
  const raw = {
    // The week's counts reset at another time than the week Kimi reports;
    // the 5-hour counts are of a window already over.
    usage: { limit: '100', used: '90', resetTime: at(20) },
    limits: [five({ limit: '100', used: '95', resetTime: at(-0.5) })],
    usages: { limit_5h: { used_ratio: 0, reset_time: at(4.5) }, limit_7d: { used_ratio: 0, reset_time: at(100) } },
  };
  const q = mergeQuota(kimi(raw), raw, NOW);
  assert.deepEqual(q.usages, kimi(raw).usages);
  // Reset times a little apart (seconds) are the same window.
  const near = { ...raw, usage: { limit: '100', used: '90', resetTime: new Date(NOW + 100 * 3600_000 + 1450).toISOString() } };
  assert.equal(mergeQuota(kimi(near), near, NOW).usages.limit7d.usedRatio, 0.9);
  // A "week" resetting further away than a week is not the week.
  const far = { usage: { limit: '100', used: '90', resetTime: at(24 * 9) }, usages: { limit_5h: { used_ratio: 0, reset_time: at(1) } } };
  assert.equal(mergeQuota(kimi(far), far, NOW).usages.limit7d, undefined);
  // With no weekly ratio, counts resetting with the month are the month's.
  const month = { usage: { limit: '100', used: '90', resetTime: at(30) }, usages: { limit_5h: { used_ratio: 0, reset_time: at(1) }, limit_month_total: { used_ratio: 0.2, reset_time: at(30) } } };
  assert.equal(mergeQuota(kimi(month), month, NOW).usages.limit7d, undefined);
});

test('a window only the counts describe is taken from them', () => {
  const raw = { limits: [five({ limit: 200, used: 50, resetTime: at(2) })], usages: {} };
  assert.deepEqual(mergeQuota({ usages: {}, extraUsage: null }, raw, NOW).usages.limit5h, { usedRatio: 0.25, resetAt: at(2), counted: { used: 50, limit: 200 } });
});

test('count entries: strings or numbers, used from remaining, nonsense dropped', () => {
  assert.deepEqual(countEntry({ limit: '100', remaining: '81', resetTime: at(1) }), { used: 19, limit: 100, ratio: 0.19, resetAt: at(1) });
  assert.equal(countEntry({ limit: '100', used: '150' }).ratio, 1);
  assert.equal(countEntry({ limit: '0', used: '0' }), null);
  assert.equal(countEntry({ limit: 'x', used: '1' }), null);
  assert.equal(countEntry({ limit: '100' }), null);
  assert.equal(countEntry(null), null);
  // Windows told in other units; others ignored.
  const c = countsOf({ limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 10, used: 1, resetTime: at(1) } }, { window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 10, used: 9, resetTime: at(1) } }] });
  assert.deepEqual(Object.keys(c), ['limit5h']);
  assert.deepEqual(countsOf(null), {});
  assert.deepEqual(countsOf({ limits: 'x', usage: 3 }), {});
  // Nothing to fold in: Kimi's reading as it is.
  const q = { usages: { limit5h: { usedRatio: 0.3, resetAt: at(1) } }, extraUsage: null };
  assert.deepEqual(mergeQuota(q, null, NOW), q);
  assert.equal(mergeQuota(undefined, {}, NOW), undefined);
});
