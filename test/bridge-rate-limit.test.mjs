// A key that is probably being rate limited (HTTP 429 that is not about quota): the request
// is lent to a healthy key at once, and a key that keeps answering 429 cools down - all from
// counts the connector MEASURED, nothing estimated.
//
// 2026-10-30: a Command Code key answered 348 of 3,140 requests with 429 while seventeen
// conversations were glued to it - a rate limit moved nobody (only quota did) and the key
// still counted as healthy; the workers it cut off stayed in "error".
//
// The rules (every number is a constant at the head of the connector; these tests shorten them):
//   which key, in this order: 1. has quota and is usable (not out of quota, not refused, not marked
//   full; a key past its stated reset time counts), 2. is not cooling down, 3. has the fewest
//   conversations of those, 4. the order of the list;
//   A. a request that gets a 429 and has sent nothing to Kimi is sent again, the very same request,
//      to the next such key - once for each healthy key; only when every one said 429 does Kimi
//      get the 429. The conversation stays on its key (this is borrowing): its next request goes
//      to its own key first, and the cache key in the request is untouched;
//   B. a key with 3 such 429s in the last 30 seconds (or 20% of 5 or more requests) cools down
//      for 60 seconds: the requests of the conversations on it borrow other keys, new
//      conversations are not given to it; after a cooldown that ends and trips again at once the
//      next one is twice as long (10 minutes at most); only after 5 minutes of that without a
//      break are half of its conversations given to other keys for good;
//   C. every key cooling or unusable: the conversation's own key is used as always;
//   E. what was borrowed, how many cooldowns, how many resends worked is counted, per key, in
//      the pool report and in the request records (numbers and key ids only).
//
// The real connector, spawned on a saved key pool (so no Kimi is needed), a fake upstream
// gateway on loopback and a fake Hub socket. Nothing leaves this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, until, sleep, sse, failing, rateLimited } from './bridge-keys-harness.mjs';

const h = createHarness({ prefix: 'ratelimit', keys: { dk_a: 'sk-rate-key-aaaa-1111', dk_b: 'sk-rate-key-bbbb-2222', dk_c: 'sk-rate-key-cccc-3333', dk_d: 'sk-rate-key-dddd-4444' } });
// The same rules on a short clock: window 0.5 s, cooldown 0.6 s (doubling to 2.4 s), a break-free stretch of 2 s rebalances.
const env = (over = {}) => ({
  AGENT_HUB_DEEPSEEK_RATE_WINDOW_MS: '500',
  AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MS: '600',
  AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MAX_MS: '2400',
  AGENT_HUB_DEEPSEEK_RATE_REBALANCE_MS: '2000',
  AGENT_HUB_DEEPSEEK_RATE_REPORT_MS: '100',
  ...over,
});
const cooling = (id) => h.reportedKey(id)?.rateCooldown;
const stats = (id) => h.reportedKey(id)?.rateStats;
const seen = () => h.upstreamRequests.map((u) => u.key);
const sessionsOn = (id) => h.reportedKey(id)?.sessions;
// n requests of one conversation, one after the other.
const asks = async (session, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await h.ask(session));
  return out;
};
// Three 429s on the key the conversation lives on: it cools down. Returns how long, from the report.
const trip = async (session, id = 'dk_a') => {
  const t0 = Date.now();
  assert.deepEqual(await asks(session, 3), [200, 200, 200], 'each was lent to a healthy key: nobody sees an error');
  const c = await until(() => cooling(id), 3000, `${id} reported cooling`);
  return c.until - t0;
};
const cooled = (id = 'dk_a') => until(() => h.lastPoolReport() && !cooling(id), 6000, `${id} no longer cooling`);

test('the hello says this connector watches each key for rate limits', async () => {
  await h.boot({ env: env() });
  assert.ok(h.lastHello.capabilities.includes('pool_rate'), JSON.stringify(h.lastHello.capabilities));
  for (const name of ['pool', 'pool_sticky', 'pool_reset_due']) assert.ok(h.lastHello.capabilities.includes(name), name);
});

// ------------------------------------------------ A. lend the request at once

test('A: 2026-10-30 - a request that gets a 429 goes on to a healthy key at once; the conversation sees no error, the request is the very same, and the conversation stays on its own key', async () => {
  await h.boot({ env: env() });
  for (const s of h.sessions(2)) await h.ask(s); // 1 -> a   2 -> b
  h.upstreamRequests = [];
  h.behaviours.set('dk_a', rateLimited);
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen(), ['dk_a', 'dk_b']);
  assert.deepEqual(h.upstreamRequests[0].body, h.upstreamRequests[1].body, 'the very same request: model, messages and the cache key');
  assert.equal(h.upstreamRequests[1].body.prompt_cache_key, 'session_conv1', 'the conversation\'s cache key is untouched');
  assert.equal(cooling('dk_a'), undefined, 'one 429 is not a cooldown');
  // Borrowing moves nobody: the conversation is still counted on a, and its next request goes to a first.
  await until(() => sessionsOn('dk_a') === 1 && sessionsOn('dk_b') === 1, 3000, 'the counts');
  h.behaviours.delete('dk_a');
  h.upstreamRequests = [];
  await h.ask('session_conv1');
  assert.deepEqual(seen(), ['dk_a'], 'back on its own key');
});

test('A: every healthy key says 429 -> the 429 goes to Kimi (the last one, with its own Retry-After), each key was asked once', async () => {
  await h.boot({ keyIds: ['dk_a', 'dk_b', 'dk_c'], env: env() });
  h.behaviours.set('dk_a', rateLimited);
  h.behaviours.set('dk_b', rateLimited);
  h.behaviours.set('dk_c', failing(429, 'rate_limit_exceeded', 'Rate limit reached for requests', { 'retry-after': '7' }));
  const res = await h.chat('session_conv1');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '7');
  assert.match(await res.text(), /rate_limit_exceeded/);
  assert.deepEqual(seen(), ['dk_a', 'dk_b', 'dk_c']);
});

test('A: the key it is lent to is one with quota - a key out of quota is not, however few conversations it has', async () => {
  await h.boot({ keyIds: ['dk_a', 'dk_b', 'dk_c'], env: env(), states: { dk_b: { exhaustedAt: Date.now() - 1000, retryAt: Date.now() + 3_600_000 } } });
  await h.ask('session_conv1'); // a
  h.behaviours.set('dk_a', rateLimited);
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen().slice(-2), ['dk_a', 'dk_c'], 'b has the fewest conversations (none) but no quota');
});

test('A: a 429 that is about quota is not a rate limit - the key is out as before, the conversation moves for good, and no cooldown or borrowing is counted', async () => {
  // (One rate-limit 429 would be enough for a cooldown here: a quota 429 counted as one would show.)
  await h.boot({ env: env({ AGENT_HUB_DEEPSEEK_RATE_TRIP_429: '1' }) });
  for (const s of h.sessions(2)) await h.ask(s);
  h.behaviours.set('dk_a', failing(429, 'insufficient_quota', 'You exceeded your current quota'));
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen().slice(-2), ['dk_a', 'dk_b']);
  const a = h.reportedKey('dk_a');
  assert.ok(a.exhaustedAt, 'a is out of quota');
  assert.equal(a.rateCooldown, undefined);
  assert.equal(a.rateStats, undefined, 'nothing borrowed, nothing counted');
  h.upstreamRequests = [];
  await h.ask('session_conv1');
  assert.deepEqual(seen(), ['dk_b'], 'moved for good, not lent');
});

test('A: a relay lends the request too, and from then on stays on the key that worked', async () => {
  await h.boot({ distribution: 'relay', env: env() });
  h.behaviours.set('dk_a', rateLimited);
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen(), ['dk_a', 'dk_b']);
  h.upstreamRequests = [];
  assert.equal(await h.ask('session_conv2'), 200);
  assert.deepEqual(seen(), ['dk_b']);
});

test('A: the key it is lent to may be on another gateway: the address and the model name are that gateway\'s, as always', async () => {
  const map = { commandcode: { 'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash' } };
  await h.boot({ env: env(), gateways: { dk_b: 'commandcode' }, modelMap: map });
  h.behaviours.set('dk_a', rateLimited);
  assert.equal(await h.ask('session_conv1'), 200);
  const [first, second] = h.upstreamRequests;
  assert.ok(first.url.startsWith('/opencode-go/') && second.url.startsWith('/commandcode/'), `${first.url} -> ${second.url}`);
  assert.equal(first.body.model, 'deepseek-v4.1-flash');
  assert.equal(second.body.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(second.body.prompt_cache_key, 'session_conv1');
});

// ------------------------------------------------ B. the cooldown

test('B: three 429s inside the window put the key into cooldown - the report says until when and on what counts; its conversations borrow, new ones are not given to it, nobody is moved', async () => {
  await h.boot({ env: env() });
  for (const s of h.sessions(2)) await h.ask(s); // 1 -> a   2 -> b
  h.behaviours.set('dk_a', rateLimited);
  const length = await trip('session_conv1');
  assert.ok(length >= 550 && length <= 1000, `the first cooldown is the base one (0.6 s here), got ${length} ms`);
  const c = cooling('dk_a');
  assert.ok(c.n429 >= 3 && c.windowMs === 500 && c.level === 0, JSON.stringify(c));
  assert.equal(cooling('dk_b'), undefined, 'only the key that is limited says so');
  // While it cools: its conversation's request goes straight to a healthy key, not to a first.
  h.upstreamRequests = [];
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen(), ['dk_b']);
  // A new conversation is not given to it though a tie would have gone to the first of the list.
  assert.equal(await h.ask('session_conv3'), 200);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_b');
  assert.equal(sessionsOn('dk_a'), 1, 'conversation 1 is still counted on a');
  assert.ok(!JSON.stringify(h.hubMessages).includes('sk-rate'), 'no key value in anything sent to the Hub');
});

test('B: when the cooldown ends the key is used again by its conversations, and the report takes the mark back by itself', async () => {
  await h.boot({ env: env() });
  for (const s of h.sessions(2)) await h.ask(s);
  h.behaviours.set('dk_a', rateLimited);
  await trip('session_conv1');
  await cooled();
  h.behaviours.delete('dk_a');
  h.upstreamRequests = [];
  await h.ask('session_conv1');
  assert.deepEqual(seen(), ['dk_a'], 'its own key first, as soon as the cooldown is over');
});

test('B: it trips again right after a cooldown -> twice as long, then twice again, then no more than the longest; a calm gap in between starts over', async () => {
  await h.boot({ env: env({ AGENT_HUB_DEEPSEEK_RATE_REBALANCE_MS: '600000' }) }); // (no rebalancing here: that is the next test)
  for (const s of h.sessions(2)) await h.ask(s);
  h.behaviours.set('dk_a', rateLimited);
  const lengths = [];
  for (let i = 0; i < 4; i++) {
    lengths.push(await trip('session_conv1'));
    await cooled();
  }
  const near = (got, want) => got >= want - 50 && got <= want + 450;
  assert.ok(near(lengths[0], 600) && near(lengths[1], 1200) && near(lengths[2], 2400) && near(lengths[3], 2400), `0.6, 1.2, 2.4, 2.4 s expected, got ${lengths}`);
  // A calm stretch longer than the window, then trouble again: the base cooldown.
  await sleep(700);
  const again = await trip('session_conv1');
  assert.ok(near(again, 600), `starts over at the base one, got ${again} ms`);
});

test('B: the thresholds - one 429 among five requests (20%, but one is no signal), or two among twenty-one, is not a cooldown; two among eight is', async () => {
  const run = async (pattern) => {
    await h.boot({ env: env({ AGENT_HUB_DEEPSEEK_RATE_WINDOW_MS: '5000' }) });
    for (const s of h.sessions(2)) await h.ask(s); // 1 -> a (that request is one of a's requests too)
    let i = 0;
    h.behaviours.set('dk_a', (q, r) => (pattern[i++] === '4' ? rateLimited(q, r) : sse(r)));
    for (let n = 0; n < pattern.length; n++) await h.ask('session_conv1');
    await sleep(250);
    return cooling('dk_a');
  };
  assert.equal(await run('ooo4'), undefined, 'one 429 among five requests is 20%, and still not a cooldown: under the count of three and under the floor of two');
  assert.equal(await run('oooooooooooooooooo44'), undefined, 'two of twenty-one is under 20%');
  assert.ok(await run('ooooo44'), 'two 429s among eight requests (25%)');
});

test('B: only after the cooling has gone on for the whole stretch without a break do half of the key\'s conversations get another key for good - the busiest first, each at its next request', async () => {
  await h.boot({ env: env() });
  for (const s of h.sessions(8)) await h.ask(s); // 1,3,5,7 -> a   2,4,6,8 -> b
  await until(() => sessionsOn('dk_a') === 4 && sessionsOn('dk_b') === 4, 3000, 'the counts');
  h.behaviours.set('dk_a', rateLimited);
  const t0 = Date.now();
  let midway = null;
  while (Date.now() - t0 < 3000) {
    await h.ask('session_conv1');
    if (midway === null && Date.now() - t0 > 1000) midway = sessionsOn('dk_a');
    await sleep(20);
  }
  assert.equal(midway, 4, 'nobody has been moved after one second of cooling');
  // Conversation 1 (the busiest) went at its next request; 7 (the next busiest) goes when it asks; 3 and 5 stay.
  await h.ask('session_conv7');
  h.behaviours.delete('dk_a');
  await cooled();
  await sleep(800);
  const where = {};
  for (const s of ['session_conv1', 'session_conv7', 'session_conv3', 'session_conv5']) {
    const before = h.upstreamRequests.length;
    await h.ask(s);
    where[s] = h.upstreamRequests[before].key;
  }
  assert.deepEqual(where, { session_conv1: 'dk_b', session_conv7: 'dk_b', session_conv3: 'dk_a', session_conv5: 'dk_a' });
  await until(() => sessionsOn('dk_a') === 2 && sessionsOn('dk_b') === 6, 3000, 'the counts after the move');
});

// ------------------------------------------------ the order of choice, and C

test('the order of choice: quota, then not cooling, then the fewest conversations, then the list', async () => {
  await h.boot({ keyIds: ['dk_a', 'dk_b', 'dk_c', 'dk_d'], env: env({ AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MS: '3000', AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MAX_MS: '3000' }), states: { dk_b: { exhaustedAt: Date.now() - 1000, retryAt: Date.now() + 3_600_000 } } });
  for (const s of h.sessions(8)) await h.ask(s); // 1,4,7 -> a   2,5,8 -> c   3,6 -> d   (b has no quota)
  await until(() => sessionsOn('dk_a') === 3 && sessionsOn('dk_c') === 3 && sessionsOn('dk_d') === 2, 3000, 'the counts');
  // 1. b has the fewest (none) but no quota; c comes before d in the list but has more conversations: d.
  h.behaviours.set('dk_a', rateLimited);
  h.upstreamRequests = [];
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen(), ['dk_a', 'dk_d']);
  // 2. d cools down (its conversation 3 asks three times; the requests are lent elsewhere): now only c is a key
  //    that has quota and is not cooling, though d has fewer conversations.
  h.behaviours.delete('dk_a');
  h.behaviours.set('dk_d', rateLimited);
  await trip('session_conv3', 'dk_d');
  h.behaviours.delete('dk_d');
  await sleep(600); // (a's 429 of step 1 leaves the window)
  h.behaviours.set('dk_a', rateLimited);
  h.upstreamRequests = [];
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(seen(), ['dk_a', 'dk_c']);
});

test('C: every key cooling -> the conversation\'s own key is used as always, a 429 reaches Kimi, and a new conversation is still placed', async () => {
  await h.boot({ env: env({ AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MS: '5000', AGENT_HUB_DEEPSEEK_RATE_COOLDOWN_MAX_MS: '5000' }) });
  for (const s of h.sessions(2)) await h.ask(s); // 1 -> a   2 -> b
  h.behaviours.set('dk_a', rateLimited);
  await trip('session_conv1', 'dk_a');
  h.behaviours.set('dk_b', rateLimited);
  // b: its requests are lent to nobody (a is cooling), so Kimi gets the 429s; three of them cool it too.
  assert.deepEqual(await asks('session_conv2', 3), [429, 429, 429]);
  await until(() => cooling('dk_b'), 3000, 'b cooling too');
  h.upstreamRequests = [];
  assert.equal(await h.ask('session_conv1'), 429);
  assert.deepEqual(seen(), ['dk_a'], 'its own key, nothing else to lend it to');
  assert.equal(await h.ask('session_conv2'), 429);
  assert.deepEqual(seen(), ['dk_a', 'dk_b']);
  // A conversation is never left without a key: a new one is placed by the usual rule (fewest, then the list).
  assert.equal(await h.ask('session_conv3'), 429);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_a');
});

// ------------------------------------------------ E. what is counted

test('E: the request records say what was borrowed and why; the report counts borrowings, cooldowns and how the resends went', async () => {
  await h.boot({ env: env() });
  for (const s of h.sessions(2)) await h.ask(s); // 1 -> a   2 -> b
  h.behaviours.set('dk_a', rateLimited);
  await trip('session_conv1'); // three 429s, each resent to b and answered 200
  await h.ask('session_conv1'); // while cooling: lent to b without trying a
  await until(() => stats('dk_a')?.borrows === 4, 5000, 'the counts in a report');
  assert.deepEqual(stats('dk_a'), { borrows: 4, cooldowns: 1, resendOk: 3, resendFail: 0 });
  await until(() => h.records().length >= 9, 5000, 'the records');
  const lent = h.records().filter((r) => r.borrowedFrom);
  assert.deepEqual(lent.map((r) => [r.key, r.borrowedFrom, r.borrowReason]), [
    ['dk_b', 'dk_a', 'rate429'],
    ['dk_b', 'dk_a', 'rate429'],
    ['dk_b', 'dk_a', 'rate429'],
    ['dk_b', 'dk_a', 'cooldown'],
  ]);
  const first = h.records().filter((r) => r.key === 'dk_a' && r.status === 429);
  assert.ok(first.length >= 3 && first.every((r) => !r.borrowedFrom), 'the attempt that got the 429 was on its own key');
  // A resend that fails too: b says 429 as well.
  h.behaviours.set('dk_b', rateLimited);
  await cooled();
  assert.equal(await h.ask('session_conv1'), 429);
  await until(() => stats('dk_a')?.resendFail === 1, 5000, 'the failed resend counted');
  assert.ok(Object.values(stats('dk_a')).every(Number.isInteger), 'numbers only');
});
