// The auto-pause rules (server/autopause.js) on their own: a fake clock, a
// fake Kimi conversation and a fake quota. No machine or Kimi needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoPause, timings, parseUsage, activityOf, PAUSE_TEXT, RESUME_TEXT } from '../server/autopause.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-07T10:00:00Z');

// One conversation on one machine. `env` is what the test controls.
function harness({ threshold = 90, sessions } = {}) {
  const env = {
    t: T0,
    act: { online: true, state: 'idle', busy: false },
    usage: { used: 0.5, resetAt: T0 + 3 * HOUR, d7: 0.2, d7ResetAt: T0 + 50 * HOUR },
    usageResult: null, // a whole /oauth/usage result instead of `usage`
    readError: null,
    reads: 0,
    sent: [],
    sendError: null,
    sendGate: null, // a promise the next send waits for
    onSend: null,
    cannot: null,
    infos: [],
    warnings: [],
  };
  const s = { id: 's_1', machineId: 'm_1', kimiSessionId: 'session_1' };
  const list = sessions || [s];
  const deps = {
    sessions: () => list,
    activity: () => ({ ...env.act }),
    readUsage: async () => {
      env.reads++;
      if (env.readError) throw new Error(env.readError);
      if (env.usageResult) return env.usageResult;
      const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
      return { kind: 'ok', quota: { usages: { limit5h: { usedRatio: env.usage.used, resetAt: iso(env.usage.resetAt) }, limit7d: { usedRatio: env.usage.d7, resetAt: iso(env.usage.d7ResetAt) } }, extraUsage: null } };
    },
    send: async (sess, text, opts) => {
      if (env.sendGate) await env.sendGate;
      if (env.sendError) throw new Error(env.sendError);
      env.sent.push({ sid: sess.id, text, ...opts });
      env.onSend?.(text);
    },
    cannotSend: () => env.cannot,
    changed: () => {},
    info: (sess, text) => env.infos.push(text),
    now: () => env.t,
    timings: timings(1),
    warn: (m) => env.warnings.push(m),
  };
  const make = () => createAutoPause(deps);
  let ap = make();
  for (const x of list) ap.configure(x, { enabled: true, threshold });
  const h = {
    s,
    env,
    get ap() {
      return ap;
    },
    // Kimi's state changes; the hub sees it right away (as runner.onStatus does).
    set(state, extra = {}) {
      env.act = { online: true, state, busy: state === 'running' || state === 'awaiting', ...extra };
      for (const x of list) ap.observe(x);
    },
    async step(ms = 0) {
      env.t += ms;
      await ap.tick();
    },
    // A hub restart: the same stored conversation, nothing in memory.
    restart() {
      ap = make();
    },
    texts: () => env.sent.map((m) => m.text),
  };
  return h;
}

// Run to the point where 「優雅暫停」 has been sent (91% of 5 hours used).
async function paused(h, { resetIn = HOUR } = {}) {
  h.env.usage = { ...h.env.usage, used: 0.91, resetAt: h.env.t + resetIn };
  h.set('running');
  await h.step(0);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.phase, 'paused');
}

test('pauses once the 5-hour quota reaches the mark while Kimi works, slipping the message into the turn', async () => {
  const h = harness({ threshold: 90 });
  h.set('running');
  await h.step(0);
  assert.equal(h.env.sent.length, 0, 'under the mark');
  h.env.usage.used = 0.905;
  await h.step(10_000);
  assert.equal(h.env.sent.length, 0, 'the last reading is still fresh');
  await h.step(21_000);
  assert.equal(h.env.sent.length, 1);
  const m = h.env.sent[0];
  assert.equal(m.text, PAUSE_TEXT);
  assert.equal(m.steer, true, 'steered into the running turn');
  assert.match(m.note, /91%.*90%/);
  const a = h.s.autoPause;
  assert.equal(a.phase, 'paused');
  assert.equal(a.resetAt, h.env.usage.resetAt);
  // Kimi keeps working while it wraps up: nothing more is sent.
  for (let i = 0; i < 20; i++) await h.step(31_000);
  assert.equal(h.env.sent.length, 1);
  assert.deepEqual(h.env.warnings, []);
});

test('never pauses a conversation that is idle or waiting on you', async () => {
  const h = harness();
  h.env.usage.used = 0.99;
  await h.step(0);
  h.set('awaiting');
  await h.step(31_000);
  h.set('idle');
  await h.step(31_000);
  assert.equal(h.env.sent.length, 0);
  assert.equal(h.s.autoPause.phase, 'watching');
  h.set('running');
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
});

test('「繼續」 goes out only after the reset, once Kimi has stopped and a fresh reading confirms it', async () => {
  const h = harness();
  await paused(h);
  const reset = h.s.autoPause.resetAt;
  h.set('idle');
  await h.step(2_000);
  assert.equal(h.s.autoPause.wait.kind, 'stopping', 'not settled yet');
  await h.step(4_000);
  assert.equal(h.s.autoPause.settled, true);
  assert.deepEqual(h.s.autoPause.wait, { kind: 'reset', until: reset });
  // Right up to the reset: nothing.
  h.env.t = reset - 1;
  await h.step(0);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  // Past it, but Kimi still reports the old window: wait.
  await h.step(2);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.wait.kind, 'confirm');
  await h.step(11_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.wait.kind, 'usage');
  // The window rolled over.
  h.env.usage = { ...h.env.usage, used: 0.02, resetAt: reset + 5 * HOUR };
  await h.step(30_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT], 'the last reading is still fresh');
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
  const m = h.env.sent[1];
  assert.equal(m.steer, undefined, 'a new turn, not steered');
  assert.match(m.note, /已恢復.*2%/);
  assert.equal(h.s.autoPause.phase, 'watching');
  // Its own 「繼續」 starting a turn is not someone taking over, and it does
  // not pause again in the new window until the mark is reached.
  h.set('running');
  for (let i = 0; i < 5; i++) await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
  assert.equal(h.env.infos.length, 0);
  assert.deepEqual(h.env.warnings, []);
});

test('if Kimi is still working at the reset, 「繼續」 waits until it stops', async () => {
  const h = harness();
  await paused(h, { resetIn: 2 * MIN });
  h.env.usage = { ...h.env.usage, used: 0.01, resetAt: h.env.t + 6 * HOUR };
  for (let i = 0; i < 10; i++) await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT], 'Kimi still wrapping up');
  h.set('idle');
  await h.step(3_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT], 'not settled');
  await h.step(3_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
});

test('a message sent while paused (someone took over) calls off 「繼續」; no second pause in that window', async () => {
  const h = harness();
  await paused(h);
  const reset = h.s.autoPause.resetAt;
  h.set('idle');
  await h.step(6_000);
  assert.equal(h.s.autoPause.settled, true);
  h.set('running'); // e.g. a question sent from the phone
  assert.equal(h.s.autoPause.phase, 'watching');
  assert.equal(h.env.infos.length, 1);
  assert.match(h.s.autoPause.log.at(-1).text, /取消自動「繼續」/);
  // Still over the mark and working, but this window had its pause.
  h.env.usage.used = 0.97;
  await h.step(31_000);
  assert.equal(h.s.autoPause.wait.kind, 'quiet');
  h.set('idle');
  h.env.usage = { ...h.env.usage, used: 0.01, resetAt: reset + 5 * HOUR };
  h.env.t = reset + 1;
  await h.step(61_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT], 'no 「繼續」');
  // A new window: it pauses again when the mark is reached.
  h.env.usage.used = 0.93;
  h.set('running');
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, PAUSE_TEXT]);
});

test('turns that only flicker while Kimi wraps up are not mistaken for someone taking over', async () => {
  const h = harness();
  await paused(h);
  // The pause turn ends and the 「優雅暫停」 turn starts right after.
  h.set('idle');
  await h.step(1_000);
  h.set('running');
  assert.equal(h.s.autoPause.phase, 'paused');
  await h.step(31_000);
  h.set('idle');
  await h.step(6_000);
  assert.equal(h.s.autoPause.phase, 'paused');
  assert.equal(h.s.autoPause.settled, true);
  assert.equal(h.env.infos.length, 0);
});

test('a 「繼續」 that fails is retried with backoff, and one that got through after all is recognised', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  h.env.usage = { ...h.env.usage, used: 0.03, resetAt: h.env.t + 6 * HOUR };
  h.env.sendError = '機器沒有在時間內回應';
  await h.step(2 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  const a = h.s.autoPause;
  assert.match(a.error, /沒有送出「繼續」/);
  assert.equal(a.phase, 'paused');
  const tries = () => a.log.filter((l) => /沒有送出/.test(l.text)).length;
  assert.equal(tries(), 1);
  await h.step(10_000);
  assert.equal(tries(), 1, 'waits before trying again');
  await h.step(25_000);
  assert.equal(tries(), 2, 'second try after 30s');
  await h.step(35_000);
  assert.equal(tries(), 2, 'third waits a minute');
  // It had reached Kimi after all: Kimi starts working.
  h.set('running');
  assert.equal(a.phase, 'watching');
  assert.equal(h.env.infos.length, 0, 'not reported as someone taking over');
  assert.match(a.log.at(-1).text, /應該已經送達/);
});

test('a 「繼續」 that fails is sent once it can be', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  h.env.usage = { ...h.env.usage, used: 0.03, resetAt: h.env.t + 6 * HOUR };
  h.env.sendError = 'Kimi 伺服器重新啟動中';
  await h.step(2 * MIN);
  h.env.sendError = null;
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
  assert.equal(h.s.autoPause.error, null);
  assert.equal(h.s.autoPause.phase, 'watching');
});

test('a failed 「優雅暫停」 is tried again while Kimi still works past the mark', async () => {
  const h = harness();
  h.env.usage.used = 0.95;
  h.env.sendError = '連接器拒絕了這個請求';
  h.set('running');
  await h.step(0);
  assert.equal(h.s.autoPause.phase, 'watching');
  assert.match(h.s.autoPause.error, /沒有送出「優雅暫停」/);
  h.env.sendError = null;
  await h.step(10_000);
  assert.equal(h.env.sent.length, 0, 'backoff');
  await h.step(21_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.phase, 'paused');
  assert.equal(h.s.autoPause.error, null);
});

test('a message is never sent twice while one is on its way', async () => {
  const h = harness();
  h.env.usage.used = 0.95;
  let open;
  h.env.sendGate = new Promise((r) => (open = r));
  h.set('running');
  const first = h.ap.tick();
  await new Promise((r) => setImmediate(r));
  h.env.t += 60_000;
  await h.ap.tick();
  h.set('awaiting');
  h.set('running');
  open();
  await first;
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
});

test('a turn that fails past the mark counts as paused by the quota, and is continued after the reset', async () => {
  const h = harness();
  h.env.usage.used = 0.85;
  h.set('running');
  await h.step(0);
  // Used up between two readings; Kimi's turn fails.
  h.env.usage = { ...h.env.usage, used: 1, resetAt: h.env.t + 30 * MIN };
  await h.step(3_000);
  h.set('error');
  await h.step(8_000);
  const a = h.s.autoPause;
  assert.equal(a.phase, 'paused');
  assert.equal(a.reason, 'quota');
  assert.equal(h.env.sent.length, 0, 'no 「優雅暫停」: Kimi has already stopped');
  assert.match(h.env.infos[0], /100%/);
  h.env.usage = { ...h.env.usage, used: 0, resetAt: h.env.t + 6 * HOUR };
  await h.step(31 * MIN);
  assert.deepEqual(h.texts(), [RESUME_TEXT]);
});

test('a turn that fails under the mark is left alone', async () => {
  const h = harness();
  h.env.usage.used = 0.4;
  h.set('running');
  await h.step(0);
  h.set('error');
  await h.step(11_000);
  await h.step(HOUR);
  assert.equal(h.s.autoPause.phase, 'watching');
  assert.equal(h.env.sent.length, 0);
});

test('waits for the 7-day quota too, when it is used up', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  h.env.usage = { used: 0, resetAt: h.env.t + 6 * HOUR, d7: 1, d7ResetAt: h.env.t + 20 * HOUR };
  await h.step(2 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.deepEqual(h.s.autoPause.wait, { kind: 'week', until: h.env.usage.d7ResetAt });
  h.env.usage.d7 = 0;
  await h.step(61_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
});

test('used up again in the new window by something else: waits for the next reset', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  const next = h.env.t + 5 * HOUR;
  h.env.usage = { ...h.env.usage, used: 0.96, resetAt: next };
  await h.step(2 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.resetAt, next);
  await h.step(HOUR);
  assert.deepEqual(h.s.autoPause.wait, { kind: 'reset', until: next });
  h.env.t = next + 1;
  h.env.usage = { ...h.env.usage, used: 0, resetAt: next + 5 * HOUR };
  await h.step(0);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
});

test('while paused the quota is still looked at now and then: a window that reset early is not waited out', async () => {
  const h = harness();
  await paused(h, { resetIn: 3 * HOUR });
  h.set('idle');
  await h.step(6_000);
  h.env.usage = { ...h.env.usage, used: 0.02, resetAt: h.env.t + 5 * HOUR };
  await h.step(5 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT], 'the reading from the pause is recent enough');
  await h.step(5 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
});

test('raising the mark above what is used, while paused, continues; the new mark then applies', async () => {
  const h = harness({ threshold: 90 });
  await paused(h, { resetIn: 3 * HOUR });
  h.set('idle');
  await h.step(6_000);
  h.ap.configure(h.s, { threshold: 95 });
  await h.step(5_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
  h.env.usage.used = 0.96;
  h.set('running');
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT, PAUSE_TEXT]);
});

test('turning it off while paused drops 「繼續」; 取消繼續 keeps it on for the next window', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  h.ap.configure(h.s, { enabled: false });
  assert.equal(h.s.autoPause.enabled, false);
  assert.match(h.s.autoPause.log.at(-1).text, /不會送出「繼續」/);
  h.env.usage = { ...h.env.usage, used: 0, resetAt: h.env.t + 6 * HOUR };
  await h.step(2 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);

  const g = harness();
  await paused(g, { resetIn: MIN });
  g.set('idle');
  await g.step(6_000);
  g.ap.cancelResume(g.s);
  assert.equal(g.s.autoPause.enabled, true);
  assert.equal(g.s.autoPause.phase, 'watching');
  assert.throws(() => g.ap.cancelResume(g.s), (e) => e.status === 409);
  g.env.usage = { ...g.env.usage, used: 0, resetAt: g.env.t + 6 * HOUR };
  await g.step(2 * MIN);
  assert.deepEqual(g.texts(), [PAUSE_TEXT]);
  // The next window still pauses.
  g.env.usage.used = 0.95;
  g.set('running');
  await g.step(31_000);
  assert.deepEqual(g.texts(), [PAUSE_TEXT, PAUSE_TEXT]);
});

test('nothing is done while the machine is offline; it carries on when it is back', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  await h.step(6_000);
  h.env.act = { online: false, state: 'idle', busy: false };
  h.env.usage = { ...h.env.usage, used: 0, resetAt: h.env.t + 6 * HOUR };
  await h.step(5 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);
  assert.equal(h.s.autoPause.wait.kind, 'offline');
  h.env.act = { online: true, state: 'idle', busy: false };
  await h.step(5_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);
});

test('came back from offline working on something else: that was someone taking over', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  await h.step(6_000);
  h.env.act = { online: false, state: 'idle', busy: false };
  await h.step(MIN);
  h.env.act = { online: true, state: 'running', busy: true };
  await h.step(5_000);
  assert.equal(h.s.autoPause.phase, 'watching');
  assert.equal(h.env.infos.length, 1);
});

test('a conversation that cannot take messages, or a quota that cannot be read, is reported', async () => {
  const h = harness();
  h.env.usage.used = 0.95;
  h.env.cannot = '這個對話正在終端機的 Kimi 裡執行，中控台只能看';
  h.set('running');
  await h.step(0);
  assert.equal(h.env.sent.length, 0);
  assert.match(h.s.autoPause.error, /終端機/);
  h.env.cannot = null;
  await h.step(31_000);
  assert.deepEqual(h.texts(), [PAUSE_TEXT]);

  const g = harness();
  g.env.usageResult = { kind: 'error', message: 'No token found, please login first' };
  g.set('running');
  await g.step(0);
  assert.match(g.s.autoPause.error, /沒有用 Kimi 帳號登入/);
  g.env.usageResult = null;
  g.env.readError = '機器「x」目前離線';
  await g.step(31_000);
  assert.match(g.s.autoPause.error, /讀不到方案用量/);
  assert.equal(g.env.sent.length, 0);
  // Idle again: the problem no longer applies.
  g.set('idle');
  await g.step(5_000);
  assert.equal(g.s.autoPause.error, null);
});

test('a hub restart keeps the state: paused conversations are continued, or let go if taken over meanwhile', async () => {
  const h = harness();
  await paused(h, { resetIn: MIN });
  h.set('idle');
  await h.step(6_000);
  h.restart();
  h.env.usage = { ...h.env.usage, used: 0, resetAt: h.env.t + 6 * HOUR };
  await h.step(2 * MIN);
  assert.deepEqual(h.texts(), [PAUSE_TEXT, RESUME_TEXT]);

  const g = harness();
  await paused(g, { resetIn: MIN });
  g.set('idle');
  await g.step(6_000);
  g.restart();
  g.env.act = { online: true, state: 'running', busy: true }; // someone started it while the hub was down
  await g.step(5_000);
  assert.equal(g.s.autoPause.phase, 'watching');
  g.set('idle');
  g.env.usage = { ...g.env.usage, used: 0, resetAt: g.env.t + 6 * HOUR };
  await g.step(2 * MIN);
  assert.deepEqual(g.texts(), [PAUSE_TEXT]);
});

test('a reading from before the reset is never used to pause in the new window', async () => {
  const h = harness();
  h.env.usage = { ...h.env.usage, used: 0.5, resetAt: T0 + 20_000 };
  h.set('running');
  await h.step(0);
  // Kimi's server still answers with the ended window, at 95%.
  h.env.usage.used = 0.95;
  await h.step(25_000);
  assert.equal(h.env.sent.length, 0, 'the reading says its window ended');
  // Rolled over: a new window at 10%.
  h.env.usage = { ...h.env.usage, used: 0.1, resetAt: h.env.t + 5 * HOUR };
  await h.step(11_000);
  assert.equal(h.env.sent.length, 0);
});

test('several conversations on one machine share one usage reading', async () => {
  const a = { id: 's_a', machineId: 'm_1', kimiSessionId: 'session_a' };
  const b = { id: 's_b', machineId: 'm_1', kimiSessionId: 'session_b' };
  const h = harness({ sessions: [a, b] });
  h.env.usage.used = 0.95;
  h.set('running');
  await h.step(0);
  assert.equal(h.env.reads, 1);
  assert.deepEqual(h.env.sent.map((m) => m.sid).sort(), ['s_a', 's_b']);
  for (let i = 0; i < 6; i++) await h.step(5_000);
  assert.equal(h.env.reads, 1, 'nothing to read while both are paused and working');
});

// ------------------------------------------------- 額度恢復後送出 (by hand)

test('set by hand after pausing Kimi yourself: sent once the window has really reset, even when under the mark', async () => {
  const h = harness({ threshold: 90 });
  h.set('idle'); // you told Kimi to stop, and it did
  h.env.usage = { ...h.env.usage, used: 0.7, resetAt: T0 + 2 * HOUR };
  await h.ap.armResume(h.s, { text: '繼續' });
  const a = h.s.autoPause;
  assert.equal(a.phase, 'paused');
  assert.equal(a.reason, 'manual');
  assert.equal(a.resetAt, T0 + 2 * HOUR);
  await h.step(6_000);
  assert.deepEqual(a.wait, { kind: 'reset', until: T0 + 2 * HOUR });
  for (let i = 0; i < 6; i++) await h.step(10 * MIN);
  assert.equal(h.env.sent.length, 0, '70% is under the mark, but the window has not reset');
  // Past the reset time, Kimi still answers with the old window.
  h.env.t = T0 + 2 * HOUR + 1;
  await h.step(0);
  await h.step(61_000);
  assert.equal(h.env.sent.length, 0, 'not rolled over yet');
  h.env.usage = { ...h.env.usage, used: 0.0, resetAt: h.env.t + 5 * HOUR };
  await h.step(61_000);
  assert.deepEqual(h.texts(), [RESUME_TEXT]);
  assert.equal(h.s.autoPause.phase, 'watching');
  assert.equal(h.s.autoPause.reason, null);
});

test('by hand: works with auto-pause off, sends the text you chose, and is called off if someone takes over', async () => {
  const h = harness();
  h.ap.configure(h.s, { enabled: false });
  h.env.usage = { ...h.env.usage, used: 0.97, resetAt: T0 + 30 * MIN };
  await h.ap.armResume(h.s, { text: '請從 PROGRESS.md 接著做' });
  // Turning auto-pause on and off leaves the hand-set wait alone.
  h.ap.configure(h.s, { enabled: true });
  h.ap.configure(h.s, { enabled: false });
  assert.equal(h.s.autoPause.phase, 'paused');
  await h.step(6_000);
  h.env.usage = { ...h.env.usage, used: 0.01, resetAt: T0 + 6 * HOUR };
  await h.step(31 * MIN);
  assert.deepEqual(h.texts(), ['請從 PROGRESS.md 接著做']);
  assert.match(h.env.sent[0].note, /5 小時額度已恢復/);

  const g = harness();
  g.ap.configure(g.s, { enabled: false });
  g.set('idle');
  g.env.usage = { ...g.env.usage, used: 0.97, resetAt: T0 + 30 * MIN };
  await g.ap.armResume(g.s, {});
  await g.step(6_000);
  g.set('running');
  assert.equal(g.s.autoPause.phase, 'watching');
  assert.match(g.env.infos[0], /不會自動送出「繼續」/);
  g.set('idle');
  g.env.usage = { ...g.env.usage, used: 0.01, resetAt: T0 + 6 * HOUR };
  await g.step(31 * MIN);
  assert.equal(g.env.sent.length, 0);
});

test('by hand while Kimi is still wrapping up: waits for it to stop', async () => {
  const h = harness();
  h.set('running');
  h.env.usage = { ...h.env.usage, used: 0.8, resetAt: T0 + MIN };
  await h.ap.armResume(h.s, {});
  h.env.usage = { ...h.env.usage, used: 0, resetAt: T0 + 6 * HOUR };
  await h.step(2 * MIN);
  await h.step(61_000);
  assert.equal(h.env.sent.length, 0, 'still working');
  assert.equal(h.s.autoPause.wait.kind, 'stopping');
  h.set('idle');
  await h.step(6_000);
  assert.deepEqual(h.texts(), [RESUME_TEXT]);
});

test('by hand: a window that resets earlier than said is noticed; no reset time known means five hours', async () => {
  const h = harness();
  h.env.usage = { ...h.env.usage, used: 0.6, resetAt: T0 + 3 * HOUR };
  await h.ap.armResume(h.s, {});
  await h.step(6_000);
  h.env.usage = { ...h.env.usage, used: 0.05, resetAt: T0 + 5 * HOUR };
  await h.step(11 * MIN);
  assert.deepEqual(h.texts(), [RESUME_TEXT], 'usage went down: the window reset');

  const g = harness();
  g.env.usage = { ...g.env.usage, used: 0.6, resetAt: null };
  await g.ap.armResume(g.s, {});
  assert.equal(g.s.autoPause.resetAt, T0 + 5 * HOUR);
  await g.step(6_000);
  await g.step(4 * HOUR);
  assert.equal(g.env.sent.length, 0);
  g.env.t = T0 + 5 * HOUR + 1;
  await g.step(61_000);
  assert.deepEqual(g.texts(), [RESUME_TEXT]);
});

test('by hand: refused when the quota cannot be read, or the text is empty', async () => {
  const h = harness();
  h.env.usageResult = { kind: 'error', message: 'No token found' };
  await assert.rejects(h.ap.armResume(h.s, {}), (e) => e.status === 409 && /沒辦法知道額度什麼時候恢復/.test(e.message));
  h.env.usageResult = null;
  await assert.rejects(h.ap.armResume(h.s, { text: '   ' }), (e) => e.status === 400);
  assert.equal(h.s.autoPause.phase, 'watching');
});

test('settings are checked', () => {
  const h = harness();
  for (const threshold of [0, 101, 1.5, 'abc', -3]) assert.throws(() => h.ap.configure(h.s, { threshold }), (e) => e.status === 400, String(threshold));
  assert.throws(() => h.ap.configure(h.s, { enabled: 'yes' }), (e) => e.status === 400);
  h.ap.configure(h.s, { threshold: '75' });
  assert.equal(h.s.autoPause.threshold, 75);
  h.ap.configure(h.s, { threshold: 100 });
  assert.equal(h.s.autoPause.threshold, 100);
  const fresh = { id: 's_new' };
  h.ap.configure(fresh, {});
  assert.equal(fresh.autoPause.enabled, false);
  assert.equal(fresh.autoPause.threshold, 90);
});

test('Kimi usage results are read the way Kimi reports them', () => {
  const at = T0;
  const ok = parseUsage({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.42, resetAt: '2026-10-07T12:00:00Z' }, limit7d: { usedRatio: 0.1 } }, extraUsage: null } }, at);
  assert.equal(ok.ok, true);
  assert.equal(ok.h5.used, 0.42);
  assert.equal(ok.h5.resetAt, Date.parse('2026-10-07T12:00:00Z'));
  assert.deepEqual(ok.d7, { used: 0.1, resetAt: null });
  assert.equal(ok.rolled, false);
  assert.equal(parseUsage({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 1, resetAt: '2026-10-07T09:00:00Z' } } } }, at).rolled, true);
  assert.match(parseUsage({ kind: 'ok', quota: { usages: { limit7d: { usedRatio: 0.3 } } } }, at).error, /沒有 5 小時額度/);
  assert.match(parseUsage({ kind: 'error', message: 'Authorization failed. Please check your API key (try /login).' }, at).error, /沒有用 Kimi 帳號登入/);
  assert.match(parseUsage({ kind: 'error', message: 'Failed to fetch usage: request timed out.' }, at).error, /讀不到方案用量：Failed/);
  assert.equal(parseUsage(null, at).ok, false);
});

test('what a conversation is doing combines the hub and the machine', () => {
  const machine = (sessions, extra = {}) => ({ online: true, kimi: { available: true }, sessions, ...extra });
  const s = (status, meta) => ({ kimiSessionId: 'k1', status, meta });
  assert.deepEqual(activityOf(s('running'), null, true), { online: false, state: 'idle', busy: false });
  assert.equal(activityOf(s('running'), machine([], { online: false }), true).online, false);
  assert.equal(activityOf(s('running'), machine([]), true).state, 'running');
  assert.equal(activityOf(s('running'), machine([]), false).state, 'idle', 'a stale hub status is not trusted');
  assert.equal(activityOf(s('idle'), machine([{ id: 'k1', busy: true, pending: 'none' }]), false).state, 'running');
  assert.equal(activityOf(s('idle'), machine([{ id: 'k1', busy: true, pending: 'approval' }]), false).state, 'awaiting');
  assert.equal(activityOf(s('awaiting_permission'), machine([{ id: 'k1', busy: true, pending: 'none' }]), true).state, 'awaiting');
  assert.equal(activityOf(s('error'), machine([]), true).state, 'error');
  assert.equal(activityOf(s('idle'), machine([{ id: 'k1', busy: false, lastTurn: 'failed' }]), false).state, 'error');
  const queued = activityOf(s('idle', { queue: [{ promptId: 'p', steered: false }] }), machine([]), true);
  assert.deepEqual([queued.state, queued.busy], ['idle', true]);
  assert.equal(activityOf(s('idle', { queue: [{ promptId: 'p', steered: true }] }), machine([]), true).busy, false);
});
