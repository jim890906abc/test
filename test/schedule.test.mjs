// 定時送出 (server/schedule.js) on its own: a fake clock and a fake machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, scheduleTimings, MAX_SCHEDULED, MAX_ATTEMPTS } from '../server/schedule.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-07T10:00:00Z');

function harness() {
  const env = { t: T0, online: true, cannot: null, sendError: null, sent: [], saves: 0, warnings: [] };
  const s = { id: 's_1', kimiSessionId: 'k1' };
  let n = 0;
  const sc = createScheduler({
    sessions: () => [s],
    online: () => env.online,
    send: async (sess, text, opts) => {
      if (env.sendError) throw new Error(env.sendError);
      env.sent.push({ text, ...opts });
    },
    cannotSend: () => env.cannot,
    changed: () => env.saves++,
    newId: () => `q_${++n}`,
    now: () => env.t,
    timings: scheduleTimings(1),
    warn: (m) => env.warnings.push(m),
  });
  return {
    s,
    env,
    sc,
    async step(ms = 0) {
      env.t += ms;
      await sc.tick();
    },
    texts: () => env.sent.map((m) => m.text),
  };
}

test('a message goes out at its time, not before, and only once', async () => {
  const h = harness();
  h.sc.add(h.s, { text: '  繼續  ', at: T0 + 30 * MIN });
  assert.equal(h.s.scheduled.length, 1);
  assert.equal(h.s.scheduled[0].text, '繼續');
  await h.step(29 * MIN);
  assert.equal(h.env.sent.length, 0);
  await h.step(MIN);
  assert.deepEqual(h.texts(), ['繼續']);
  assert.equal(h.env.sent[0].note, '定時送出');
  assert.equal(h.s.scheduled.length, 0);
  await h.step(MIN);
  assert.equal(h.env.sent.length, 1);
  assert.deepEqual(h.env.warnings, []);
});

test('due messages go out one at a time, in order', async () => {
  const h = harness();
  h.sc.add(h.s, { text: '第二', at: T0 + 2 * MIN });
  h.sc.add(h.s, { text: '第一', at: T0 + MIN });
  await h.step(3 * MIN);
  assert.deepEqual(h.texts(), ['第一']);
  await h.step(0);
  assert.deepEqual(h.texts(), ['第一', '第二']);
});

test('offline at the time: sent when the machine is back, noted as late', async () => {
  const h = harness();
  h.sc.add(h.s, { text: '繼續', at: T0 + MIN });
  h.env.online = false;
  await h.step(MIN);
  await h.step(20 * MIN);
  assert.equal(h.env.sent.length, 0);
  assert.equal(h.s.scheduled[0].wait, 'offline');
  assert.equal(h.s.scheduled[0].attempts, 0, 'waiting is not a failed try');
  h.env.online = true;
  await h.step(5_000);
  assert.deepEqual(h.texts(), ['繼續']);
  assert.match(h.env.sent[0].note, /晚了 20 分鐘/);
});

test('a refused message is retried with growing waits, then left listed as not sent', async () => {
  const h = harness();
  h.sc.add(h.s, { text: '繼續', at: T0 });
  h.env.sendError = 'Kimi 回報錯誤';
  await h.step(0);
  const item = h.s.scheduled[0];
  assert.equal(item.attempts, 1);
  assert.match(item.error, /還沒送出：Kimi 回報錯誤/);
  await h.step(20_000);
  assert.equal(item.attempts, 1, 'waits 30s');
  await h.step(11_000);
  assert.equal(item.attempts, 2);
  for (let i = 0; i < 40; i++) await h.step(5 * MIN);
  assert.equal(item.attempts, MAX_ATTEMPTS);
  assert.equal(item.gaveUp, true);
  assert.match(item.error, /沒有送出/);
  h.env.sendError = null;
  await h.step(10 * MIN);
  assert.equal(h.env.sent.length, 0, 'given up');
  h.sc.cancel(h.s, item.id);
  assert.equal(h.s.scheduled.length, 0);
});

test('a conversation that cannot take messages is not sent to; it goes once it can', async () => {
  const h = harness();
  h.sc.add(h.s, { text: '繼續', at: T0 });
  h.env.cannot = '這個對話正在終端機的 Kimi 裡執行，中控台只能看';
  await h.step(0);
  assert.equal(h.env.sent.length, 0);
  assert.match(h.s.scheduled[0].error, /終端機/);
  h.env.cannot = null;
  await h.step(31_000);
  assert.deepEqual(h.texts(), ['繼續']);
});

test('what is scheduled is checked', () => {
  const h = harness();
  const bad = (x, re) => assert.throws(() => h.sc.add(h.s, x), (e) => e.status === 400 && re.test(e.message));
  bad({ text: '', at: T0 + MIN }, /空的/);
  bad({ text: 'x'.repeat(4001), at: T0 + MIN }, /太長/);
  bad({ text: '繼續' }, /時間/);
  bad({ text: '繼續', at: T0 - 5 * MIN }, /已經過了/);
  bad({ text: '繼續', at: T0 + 31 * 86_400_000 }, /30 天/);
  for (let i = 0; i < MAX_SCHEDULED; i++) h.sc.add(h.s, { text: `m${i}`, at: T0 + (i + 1) * MIN });
  bad({ text: '再一則', at: T0 + MIN }, /最多/);
  assert.throws(() => h.sc.cancel(h.s, 'q_nope'), (e) => e.status === 404);
});
