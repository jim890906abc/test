// A key whose reset time has passed comes back into the rotation by itself.
//
// 2026-10-30, the incident this is about: three keys had run out and the gateway had
// said when each comes back; those times passed, but the pool only looked at such a
// key when NO key was healthy - and a Command Code key that was being rate limited
// all day still counted as healthy. So seventeen conversations stayed glued to it
// and three keys with quota sat unused until a person pressed "clear mark".
//
// The rule now (a time the gateway STATED, nothing is estimated):
//   - a key whose stated reset time has passed is as good as a healthy one: it takes
//     its place in the rotation (in a sticky pool it counts as the key with the fewest
//     conversations) and its first real request is the proof - success clears the mark
//     (and tells the Hub), a quota answer again marks it with the new time the gateway
//     gives;
//   - a key out of quota with NO stated time keeps the old probing rule (only when no
//     key is healthy), and a key a person marked full is never used;
//   - the hello says the connector does this (`pool_reset_due`).
//
// The real connector, spawned on a saved key pool (so no Kimi is needed), a fake
// upstream gateway on loopback and a fake Hub socket. Nothing leaves this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, until, sleep, quota, rateLimited } from './bridge-keys-harness.mjs';

const h = createHarness({ prefix: 'resetdue', keys: { dk_a: 'sk-reset-key-aaaa-1111', dk_b: 'sk-reset-key-bbbb-2222', dk_c: 'sk-reset-key-cccc-3333' } });
const HOUR = 3_600_000;
// A key that ran out an hour ago and whose gateway said it comes back a minute ago.
const resetPassed = () => ({ exhaustedAt: Date.now() - HOUR, retryAt: Date.now() - 60_000 });

test('the hello says this connector puts a key back into the rotation when its reset time has passed', async () => {
  await h.boot();
  assert.ok(h.lastHello.capabilities.includes('pool_reset_due'), JSON.stringify(h.lastHello.capabilities));
  for (const name of ['pool', 'pool_cross', 'pool_sticky', 'pool_auth']) assert.ok(h.lastHello.capabilities.includes(name), name);
});

test('2026-10-30: one key is ready but rate limited all day, two keys have passed their reset time - the conversations are spread over all three, not glued to the one that says 429', async () => {
  await h.boot({ keyIds: ['dk_a', 'dk_b', 'dk_c'], states: { dk_b: resetPassed(), dk_c: resetPassed() } });
  h.behaviours.set('dk_a', rateLimited);
  const statuses = {};
  for (const s of h.sessions(6)) statuses[s] = await h.ask(s);
  // Where each conversation's own first request went (a request that got a 429 on a was sent on to another key).
  const placed = {};
  for (const u of h.upstreamRequests) placed[u.session] ??= u.key;
  const perKey = {};
  for (const k of Object.values(placed)) perKey[k] = (perKey[k] || 0) + 1;
  assert.deepEqual(perKey, { dk_a: 2, dk_b: 2, dk_c: 2 }, 'every key took its share; the one that is ready did not keep them all');
  assert.deepEqual(Object.values(statuses), [200, 200, 200, 200, 200, 200], 'and the two that landed on the rate-limited key did not see its 429: their requests were sent on (see bridge-rate-limit.test.mjs)');
  // The first real request on each of them proved it works: marks cleared, and the Hub is told with evidence.
  await until(() => h.reportedKey('dk_b')?.recoveredAt && h.reportedKey('dk_c')?.recoveredAt, 5000, 'recovered in the report');
  assert.ok(!h.reportedKey('dk_b').exhaustedAt && !h.reportedKey('dk_c').exhaustedAt);
  assert.ok(h.reportedKey('dk_b').recoveredFrom > 0, 'which exhaustion the success proved wrong');
});

test('the reset time arrives while the connector runs: the key is not used before it, and used right after it without any other key failing', async () => {
  await h.boot({ states: { dk_b: { exhaustedAt: Date.now() - HOUR, retryAt: Date.now() + 1500 } } });
  for (const s of h.sessions(2)) await h.ask(s);
  assert.deepEqual(h.keysSeen(), { dk_a: 2 }, 'b is out until its time, a takes both');
  await sleep(1700);
  assert.equal(await h.ask('session_conv3'), 200);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_b', 'b has no conversation, so the next new one goes there');
  await until(() => h.reportedKey('dk_b')?.recoveredAt, 5000, 'b recovered');
});

test('a key whose time has passed but is still out of quota is marked again with the NEW time the gateway gives, and the request is not lost', async () => {
  await h.boot({ states: { dk_b: resetPassed() } });
  await h.ask('session_conv0'); // a has one conversation, b none: the next new one goes to b
  h.upstreamRequests = [];
  const before = Date.now();
  h.behaviours.set('dk_b', quota(120));
  assert.equal(await h.ask('session_conv1'), 200, 'b was tried first (fewest conversations), said quota, and the very same request went on to a');
  assert.deepEqual(h.upstreamRequests.map((u) => u.key), ['dk_b', 'dk_a']);
  const b = h.reportedKey('dk_b');
  assert.ok(b.exhaustedAt >= before, 'a fresh exhaustion, not the old one');
  assert.ok(b.retryAt >= before + 100_000 && b.retryAt <= Date.now() + 125_000, `the gateway's new time (about two minutes away), got ${b.retryAt - before} ms`);
  // Its time is in the future again: new conversations do not go there.
  h.upstreamRequests = [];
  for (const s of ['session_conv2', 'session_conv3']) await h.ask(s);
  assert.deepEqual(h.keysSeen(), { dk_a: 2 });
});

test('still out of quota and the gateway names no time: marked again with none (it is then probed the old way, never guessed)', async () => {
  await h.boot({ states: { dk_b: resetPassed() } });
  await h.ask('session_conv0');
  h.behaviours.set('dk_b', quota());
  assert.equal(await h.ask('session_conv1'), 200);
  const b = h.reportedKey('dk_b');
  assert.ok(b.exhaustedAt > Date.now() - 5000 && b.retryAt === undefined, JSON.stringify(b));
});

test('a key out of quota whose gateway never named a time keeps the old rule: it is only looked at when no key is healthy', async () => {
  await h.boot({ states: { dk_b: { exhaustedAt: Date.now() - HOUR } } });
  for (const s of h.sessions(4)) assert.equal(await h.ask(s), 200);
  assert.deepEqual(h.keysSeen(), { dk_a: 4 }, 'no stated time, so nothing says it is back: a healthy key is used');
  // With a out, b is the probe.
  h.behaviours.set('dk_a', quota());
  assert.equal(await h.ask('session_conv5'), 200);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_b');
});

test('a reset time still in the future, or a key a person marked full, is not used', async () => {
  await h.boot({ keyIds: ['dk_a', 'dk_b', 'dk_c'], states: { dk_b: { exhaustedAt: Date.now() - HOUR, retryAt: Date.now() + HOUR }, dk_c: { exhaustedAt: Date.now() - HOUR, manual: true } } });
  for (const s of h.sessions(4)) await h.ask(s);
  assert.deepEqual(h.keysSeen(), { dk_a: 4 });
});

test('relay: a key whose time has passed that stands first in the list is taken in the list order, not only when the later ones fail', async () => {
  await h.boot({ distribution: 'relay', keyIds: ['dk_b', 'dk_a'], states: { dk_b: resetPassed() } });
  assert.equal(await h.ask('session_conv1'), 200);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_b', 'b is first in the list and its time has passed');
  await until(() => h.reportedKey('dk_b')?.recoveredAt, 5000, 'b recovered');
  // From then on it is just the key in use.
  assert.equal(await h.ask('session_conv2'), 200);
  assert.equal(h.upstreamRequests.at(-1).key, 'dk_b');
});

test('relay: the key in use runs out and the next one whose time has passed takes over, proven by its first request', async () => {
  await h.boot({ distribution: 'relay', keyIds: ['dk_a', 'dk_b'], states: { dk_b: resetPassed() } });
  h.behaviours.set('dk_a', quota());
  assert.equal(await h.ask('session_conv1'), 200);
  assert.deepEqual(h.upstreamRequests.map((u) => u.key), ['dk_a', 'dk_b']);
  await until(() => h.reportedKey('dk_b')?.recoveredAt, 5000, 'b recovered');
});
