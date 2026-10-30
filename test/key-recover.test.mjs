// The Hub types 「繼續」 into a DeepSeek conversation whose turn ended on a quota or rate-limit
// error, once a key is available that was not (2026-10-30; server/key-recover.js). The rules, on their
// own: the conversations, the keys, the clock and the typing come in through the module's `deps`; the
// rules under test are the module's. With a real Hub, a real runner and a scripted Kimi:
// test/e2e-key-recover.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyRecover, classifyTurnError, lastFailedTurn, RESUME_TEXT, INFO_TEXT, WINDOW_MS } from '../server/key-recover.js';

const T0 = 1_800_000_000_000;

function make({ ids = ['k1'], enabled = true, nextAt = null } = {}) {
  const w = { t: T0, ids: new Set(ids), nextAt, enabled, failSend: false, sent: [], infos: [], timers: [], sessions: new Map(), n: 0 };
  const kr = createKeyRecover({
    isDeepseek: (s) => s.mode === 'deepseek',
    sessions: () => w.sessions.values(),
    getSession: (id) => w.sessions.get(id),
    enabled: () => w.enabled,
    availability: () => ({ ids: new Set(w.ids), nextAt: w.nextAt }),
    send: async (s, text) => {
      if (w.failSend) throw new Error('offline');
      w.sent.push([s.id, text]);
    },
    info: (s, text) => w.infos.push([s.id, text]),
    changed: () => {},
    now: () => w.t,
    schedule: (fn, ms) => {
      const h = { fn, ms, cancelled: false };
      w.timers.push(h);
      return h;
    },
    unschedule: (h) => {
      if (h) h.cancelled = true;
    },
  });
  w.kr = kr;
  w.session = (over = {}) => {
    const s = { id: `s_${++w.n}`, agentId: 'kimi', mode: 'deepseek', status: 'idle', events: [], keyRecover: null, ...over };
    w.sessions.set(s.id, s);
    return s;
  };
  const ev = (type, fields = {}) => ({ id: `e_${++w.n}`, ts: w.t, type, ...fields });
  // A turn: the person's message, then (for a failure) the error and the end with error: true.
  w.turn = (s, error) => {
    s.events.push(ev('user', { text: 'go' }));
    if (error) s.events.push(ev('error', { text: error.text, ...(error.code ? { code: error.code } : {}) }));
    s.events.push(ev('turn_end', { error: Boolean(error) }));
    s.status = error ? 'error' : 'idle';
    kr.observe(s);
  };
  w.fail = (s, text = 'Error code: 429 - rate limit', code = 'provider.rate_limit') => w.turn(s, { text, code });
  return w;
}
const QUOTA_TEXT = 'DeepSeek 的 API key 都已用盡（共 3 把）；最早已知的重置時間 2026/10/30 下午3:26:00';

test('which errors are this kind: a quota that is gone or a rate limit - and nothing else', () => {
  const quota = [
    ['', QUOTA_TEXT],
    ['provider.api_error', 'Error code: 402 - {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'],
    ['provider.api_error', 'insufficient credits'],
    ['', '額度用完了'],
    ['provider.auth_error', 'DeepSeek 的 API key 都不能用：認證失敗（HTTP 401）1 把、額度用完 2 把'],
  ];
  for (const [code, text] of quota) assert.equal(classifyTurnError({ code, text }), 'quota', `${code} ${text}`);
  const rate = [
    ['provider.rate_limit', 'The provider is busy'],
    ['', 'HTTP 429 Too Many Requests'],
    ['provider.api_error', 'Rate limit reached for requests'],
    ['', 'Provider rate limit; retry in 3s'],
  ];
  for (const [code, text] of rate) assert.equal(classifyTurnError({ code, text }), 'rate', `${code} ${text}`);
  const other = [
    ['provider.auth_error', '401 Unauthorized: Incorrect API key'],
    ['provider.overloaded', 'The server is overloaded, rate limit of capacity'],
    ['provider.connection_error', 'ECONNRESET'],
    ['provider.filtered', 'content filtered'],
    ['provider.api_error', 'Internal server error (500)'],
    ['', ''],
    ['', 'context length exceeded: 1,200,000 tokens'],
    ['', '已中斷'],
    ['tool.failed', 'Command failed with exit code 2'],
  ];
  for (const [code, text] of other) assert.equal(classifyTurnError({ code, text }), null, `${code} ${text}`);
  assert.equal(classifyTurnError(), null);
});

test('the failed turn is the last word of the conversation: a newer turn, or one that went through, is not one', () => {
  const e = (type, f = {}) => ({ id: `x${Math.random()}`, ts: 1, type, ...f });
  assert.equal(lastFailedTurn([]), null);
  assert.equal(lastFailedTurn([e('user'), e('turn_end', { error: false })]), null);
  const ok = lastFailedTurn([e('user'), e('error', { text: 'boom' }), e('turn_end', { error: true })]);
  assert.equal(ok.error.text, 'boom');
  assert.equal(lastFailedTurn([e('user'), e('error', { text: 'boom' }), e('turn_end', { error: true }), e('user')]), null, 'a new turn began');
  const two = lastFailedTurn([e('user'), e('error', { text: 'first' }), e('turn_end', { error: true }), e('user'), e('error', { text: 'second' }), e('turn_end', { error: true })]);
  assert.equal(two.error.text, 'second', 'the newest turn\'s own error');
  assert.equal(lastFailedTurn([e('user'), e('turn_end', { error: true })]).error, null, 'a failed turn with no error text');
});

test('a turn that ended on a rate limit gets 「繼續」 once a key is available that was not - and a second time never', async () => {
  const w = make({ ids: ['k1'] });
  const s = w.session();
  w.fail(s);
  await w.kr.evaluate();
  assert.deepEqual(w.sent, [], 'k1 was available when it failed: nothing new');
  w.ids.add('k2');
  await w.kr.evaluate();
  assert.deepEqual(w.sent, [[s.id, RESUME_TEXT]]);
  assert.equal(RESUME_TEXT, '繼續');
  assert.deepEqual(w.infos, [[s.id, INFO_TEXT]]);
  assert.equal(INFO_TEXT, '已在 key 恢復後自動繼續');
  w.ids.add('k3');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1, 'once for each interrupted turn');
});

test('quota errors too: nothing available when it failed, then a key appears', async () => {
  const w = make({ ids: [] });
  const s = w.session();
  w.fail(s, QUOTA_TEXT, 'provider.api_error');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1);
});

test('only these errors: an auth error, an overloaded provider, a lost connection, a plain failure are left to a person', async () => {
  const w = make({ ids: [] });
  const cases = [
    ['provider.auth_error', '401 Unauthorized'],
    ['provider.overloaded', 'overloaded'],
    ['provider.connection_error', 'ECONNRESET'],
    ['', 'Command failed'],
  ];
  const all = cases.map(([code, text]) => {
    const s = w.session();
    w.turn(s, { code, text });
    return s;
  });
  const bare = w.session();
  w.turn(bare, null);
  bare.events.push({ id: 'z', ts: 1, type: 'turn_end', error: true });
  bare.status = 'error';
  w.kr.observe(bare);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  assert.equal(w.kr.pending().size, 0);
  assert.ok(all.every((s) => !s.keyRecover));
});

test('only a conversation of DeepSeek, of its own: a Claude or Kimi-subscription conversation and a sub-agent are not touched; a cluster worker (no parent) is', async () => {
  const w = make({ ids: [] });
  const claude = w.session({ mode: null, agentId: 'claude' });
  const kimi = w.session({ mode: null });
  const child = w.session({ parentId: 's_parent' });
  const worker = w.session({ clusterWorker: true });
  for (const s of [claude, kimi, child, worker]) w.fail(s);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.deepEqual(w.sent, [[worker.id, RESUME_TEXT]]);
});

test('only a turn that ended in the last two hours', async () => {
  const w = make({ ids: [] });
  const old = w.session();
  const fresh = w.session();
  w.fail(old);
  w.t += WINDOW_MS - 60_000;
  w.fail(fresh);
  w.t += 120_000; // old: 2h 1min ago, fresh: 2 min ago
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.deepEqual(w.sent, [[fresh.id, RESUME_TEXT]]);
  assert.equal(WINDOW_MS, 7_200_000);
});

test('the setting: off, nothing is typed (and the turn stays waiting for it being turned on again within the two hours)', async () => {
  const w = make({ ids: [], enabled: false });
  const s = w.session();
  w.fail(s);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  w.enabled = true;
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1);
});

test('a person who wrote to the conversation first took it over: nothing is typed over theirs', async () => {
  const w = make({ ids: [] });
  const s = w.session();
  w.fail(s);
  // A person sends a message: the conversation starts a turn.
  s.events.push({ id: 'u', ts: w.t, type: 'user', text: 'hello' });
  s.status = 'running';
  w.kr.observe(s);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  assert.equal(s.keyRecover, null);
});

test('no loop: the turn that 「繼續」 started fails again -> nothing more, until a turn has gone through', async () => {
  const w = make({ ids: [] });
  const s = w.session();
  w.fail(s);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1);
  // Our 「繼續」 starts a turn (running), which fails with the same kind of error.
  s.status = 'running';
  w.kr.observe(s);
  w.fail(s);
  w.ids.add('k2');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1, 'not sent again');
  w.ids.add('k3');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1);
  // A turn goes through (a person continued it): the automatic continue is for the next failure again.
  w.turn(s, null);
  w.ids.clear();
  w.fail(s);
  w.ids.add('k4');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 2);
});

test('what was out when the turn failed is not news later: only a key that was not available then counts', async () => {
  const w = make({ ids: ['k1', 'k2'] });
  const s = w.session();
  w.fail(s);
  w.ids.delete('k2');
  await w.kr.evaluate();
  w.ids.add('k2'); // k2 was available when it failed - it is not a key that "appeared"
  await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  w.ids.add('k3');
  await w.kr.evaluate();
  assert.equal(w.sent.length, 1);
});

test('the Hub restarts in between: what was written with the conversation is picked up', async () => {
  const w = make({ ids: [] });
  const s = w.session();
  w.fail(s);
  assert.equal(s.keyRecover.kind, 'rate');
  // A new run of the module over the same conversations.
  const w2 = make({ ids: ['k1'] });
  w2.sessions.set(s.id, s);
  w2.t = w.t + 600_000;
  w2.kr.start();
  await w2.kr.evaluate();
  assert.deepEqual(w2.sent, [[s.id, RESUME_TEXT]]);
});

test('typing that did not get through (the computer is away) is tried again at the next news, three times at most', async () => {
  const w = make({ ids: [] });
  const s = w.session();
  w.fail(s);
  w.ids.add('k1');
  w.failSend = true;
  for (let i = 0; i < 5; i++) await w.kr.evaluate();
  assert.equal(w.sent.length, 0);
  assert.equal(w.kr.pending().size, 0, 'given up after three');
  const w2 = make({ ids: [] });
  const s2 = w2.session();
  w2.fail(s2);
  w2.ids.add('k1');
  w2.failSend = true;
  await w2.kr.evaluate();
  w2.failSend = false;
  await w2.kr.evaluate();
  assert.deepEqual(w2.sent, [[s2.id, RESUME_TEXT]], 'back, and it went');
  assert.equal(w2.infos.length, 1, 'said once, when it went');
});

test('a time somebody STATED is waited for: the next reset time or the end of a cooldown arms a timer, and nothing else does', async () => {
  const w = make({ ids: [], nextAt: T0 + 90_000 });
  const s = w.session();
  w.fail(s);
  await w.kr.evaluate();
  const live = w.timers.filter((h) => !h.cancelled);
  assert.equal(live.length, 1);
  assert.ok(live[0].ms >= 90_000 && live[0].ms <= 91_000, `armed for the stated time, got ${live[0].ms}`);
  // The time comes: the key is available, the timer's function does the rest.
  w.t += 90_100;
  w.ids.add('k1');
  w.nextAt = null;
  live[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.sent.length, 1);
  // Nothing stated, nothing armed.
  const w2 = make({ ids: [], nextAt: null });
  w2.fail(w2.session());
  await w2.kr.evaluate();
  assert.equal(w2.timers.filter((h) => !h.cancelled).length, 0);
});

test('several conversations at once: each gets its own 「繼續」, once', async () => {
  const w = make({ ids: [] });
  const list = [w.session(), w.session(), w.session()];
  for (const s of list) w.fail(s);
  w.ids.add('k1');
  await w.kr.evaluate();
  assert.deepEqual(w.sent.map(([id]) => id).sort(), list.map((s) => s.id).sort());
  await w.kr.evaluate();
  assert.equal(w.sent.length, 3);
});
