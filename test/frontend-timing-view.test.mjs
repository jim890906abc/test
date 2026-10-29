// What the 耗時 panel of a conversation needs from the timing figures, without a
// browser (public/js/cluster-model.js, shared with the cluster cards): every
// count the Hub reports - also the ones it could not measure - and from when its
// data covers. The rule under test is the user's (2026-10-21): only what the
// Hub sent. A figure it did not send is null here, never a guess, and a clock
// time is the Hub's own number written as a date, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingView, fmtStamp } from '../public/js/cluster-model.js';

const SINCE = new Date(2026, 9, 29, 14, 3, 22).getTime(); // 29 Oct 2026 14:03:22 local
const REQ_SINCE = new Date(2026, 9, 29, 9, 5, 7).getTime();
const timing = (patch = {}) => ({
  since: SINCE,
  turns: 7,
  wallMs: 123_000,
  modelMs: 41_000,
  toolMs: 17_000,
  compactMs: 3000,
  rateLimitWaitMs: 5000,
  requests: 19,
  http429: 2,
  requestsSince: REQ_SINCE,
  subagents: { spawned: 4, requeuedForRateLimit: 1 },
  unmeasured: [],
  ...patch,
});

test('a clock time is the Hub\'s number as a local date and time, to the second; anything that is not a time is nothing', () => {
  assert.equal(fmtStamp(SINCE), '2026-10-29 14:03:22');
  assert.equal(fmtStamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05', 'every part is two digits');
  for (const bad of [null, undefined, 0, -5, NaN, Infinity, '1790000000000', {}, 8.64e15 + 1]) assert.equal(fmtStamp(bad), null, `${String(bad)} is not a time`);
});

test('every count has a row, in a fixed order, and the one the Hub could not measure is null, not 0', () => {
  const full = timingView(timing());
  assert.deepEqual(full.counts.map((c) => [c.key, c.label, c.n]), [
    ['turns', '回合', 7],
    ['requests', '請求', 19],
    ['http429', '429 次數', 2],
    ['spawned', '子代理', 4],
    ['requeued', '子代理限流重排', 1],
  ]);
  const lacking = timingView(timing({ requests: null, http429: null, requestsSince: null, subagents: { spawned: null, requeuedForRateLimit: null } }));
  assert.deepEqual(lacking.counts.map((c) => [c.key, c.n]), [['turns', 7], ['requests', null], ['http429', null], ['spawned', null], ['requeued', null]]);
  // A count that is really 0 stays 0.
  assert.deepEqual(timingView(timing({ http429: 0 })).counts.find((c) => c.key === 'http429'), { key: 'http429', label: '429 次數', n: 0 });
  // The older view of the same numbers (what the cluster cards print) is unchanged.
  assert.deepEqual(lacking.facts, [['回合', 7]]);
  assert.deepEqual(full.facts.map(([k]) => k), ['回合', '請求', '429 次數', '子代理', '子代理限流重排']);
});

test('from when the data covers: the Hub\'s two times, each null when it is not given - nothing stands in for it', () => {
  const v = timingView(timing());
  assert.deepEqual(v.coverage.map((c) => [c.key, c.label, c.ms]), [['since', '起算時間', SINCE], ['requestsSince', '請求紀錄起算', REQ_SINCE]]);
  const none = timingView(timing({ since: null, requestsSince: null }));
  assert.deepEqual(none.coverage.map((c) => c.ms), [null, null]);
  const odd = timingView(timing({ since: 'yesterday', requestsSince: -1 }));
  assert.deepEqual(odd.coverage.map((c) => c.ms), [null, null], 'a value that is not a time is not shown as one');
  const gone = timing();
  delete gone.requestsSince;
  assert.equal(timingView(gone).coverage[1].ms, null, 'an old Hub that does not send it');
});

test('the reasons for the counts and the times stay in notes under the name of the field, as the Hub said them', () => {
  const v = timingView(timing({ since: null, requests: null, http429: null, requestsSince: null, unmeasured: ['since：收到的事件都沒有時間戳', 'requests：這個對話用的不是 DeepSeek 號池', 'http429：這個對話用的不是 DeepSeek 號池'] }));
  assert.deepEqual(v.notes, ['起算時間：收到的事件都沒有時間戳', '請求：這個對話用的不是 DeepSeek 號池', '429 次數：這個對話用的不是 DeepSeek 號池']);
});
