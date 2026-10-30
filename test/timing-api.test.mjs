// How long things took, through the REAL Hub (runner, kimi-remote adapter,
// machines, DeepSeek account) with a fake computer around it that sends the
// events and records the way a real connector does:
//   GET  /api/sessions/:id/timing           where a conversation's time went
//   GET  /api/deepseek/keys/timing          per key: requests, peak, 429s, first byte, tokens/s
//   POST /api/deepseek/keys/:keyId/measure  the one-key concurrency measure
//
// The rule under test is the user's (2026-10-21): only what really happened.
// A number is a sum of times Kimi or the connector measured; anything else is
// null with the reason in `unmeasured`. Nothing here is checked against a
// figure the code itself could have made up: the frames carry the times, the
// expected numbers are worked out from them by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';
import { GATEWAY_KEY } from './fixtures/fake-machine.mjs';

const MID = 'm_fake';
const RL = 'Provider rate limit; subagent requeued for retry.';
const T = 1_790_000_000_000; // a moment, in Kimi's epoch milliseconds
let hub;
let CWD;
let KIMI;
let DEEPSEEK;

const timing = (id) => hub.api('GET', `/sessions/${id}/timing`);
const newKimi = () => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });
const newDeepseek = () => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model: DEEPSEEK.model, effort: 'max', permission: 'auto' });
const rejected = async (p) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail('expected the request to be refused');
};
// Frames of one conversation: [type, time, payload, options]. `inPayload`: the
// time is in the payload (Kimi's server) instead of on the frame (the journal).
const feed = (s, frames, options = {}) => {
  for (const [type, time, payload, opt] of frames) hub.machine.frameAt(s.kimiSessionId, type, time, payload, { ...options, ...opt });
};
const settle = (id, ok, what) => until(async () => {
  const t = await timing(id);
  return ok(t) && t;
}, 8000, what);
// The key the fake gateway accepts (the seeded one never makes a request).
const usedKey = async () => (await hub.api('GET', '/deepseek')).rotation.keys.find((k) => k.hint === GATEWAY_KEY.slice(-4));
const grant = async (...names) => {
  hub.machine.send({ t: 'broker.ready', broker: 1, capabilities: ['pool', 'pool_cross', 'handoff', ...names] });
  await until(async () => {
    const have = (await hub.api('GET', '/machines')).find((m) => m.id === MID).capabilities;
    return ['pool', ...names].every((n) => have.includes(n));
  }, 5000, `the capabilities ${names}`);
};
const noKey = (x) => assert.ok(!JSON.stringify(x).includes(GATEWAY_KEY), 'no key value in the answer');

// A turn that did everything: 10 s long, two model steps (1.0 s and 0.5 s), two
// overlapping tool calls (2.0 s together), a 1 s compaction, two subagents put
// back in the rate-limit queue (waiting 4 s together).
const FULL = (turn = '0') => [
  ['turn.started', T, { turnId: turn }],
  ['turn.step.completed', T + 1000, { turnId: turn, step: 1, stepId: `s1-${turn}`, llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 700 }],
  ['tool.call.started', T + 1100, { turnId: turn, toolCallId: `c1-${turn}`, name: 'Bash' }],
  ['tool.call.started', T + 1200, { turnId: turn, toolCallId: `c2-${turn}`, name: 'Bash' }],
  ['tool.result', T + 2200, { turnId: turn, toolCallId: `c2-${turn}`, output: 'x' }],
  ['tool.result', T + 3100, { turnId: turn, toolCallId: `c1-${turn}`, output: 'x' }],
  ['turn.step.completed', T + 3600, { turnId: turn, step: 2, stepId: `s2-${turn}`, llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 }],
  ['compaction.started', T + 3700, { trigger: 'auto' }],
  ['compaction.completed', T + 4700, { result: { tokensBefore: 9, tokensAfter: 3 } }],
  ['subagent.spawned', T + 4800, { subagentId: 'a1', subagentName: 'coder' }],
  ['subagent.spawned', T + 4850, { subagentId: 'a2', subagentName: 'coder' }],
  ['subagent.suspended', T + 5000, { subagentId: 'a1', reason: RL }],
  ['subagent.suspended', T + 6000, { subagentId: 'a2', reason: RL }],
  ['subagent.started', T + 7000, { subagentId: 'a2' }],
  ['subagent.started', T + 9000, { subagentId: 'a1' }],
  ['subagent.suspended', T + 9100, { subagentId: 'a1', reason: 'something else' }],
  ['turn.ended', T + 10000, { turnId: turn, reason: 'completed', durationMs: 10000 }],
];
const FULL_RESULT = { turns: 1, wallMs: 10000, modelMs: 1500, toolMs: 2000, compactMs: 1000, rateLimitWaitMs: 4000 };

before(async () => {
  hub = await startRealHub('timing', {
    // A key that is on the list from the start and never makes a request.
    seed: (data) => {
      fs.writeFileSync(
        path.join(data, 'deepseek.json'),
        JSON.stringify({ gateway: 'opencode-go', keys: { 'opencode-go': { revision: 1, activeId: 'k_seed', keys: [{ id: 'k_seed', key: 'sk-seeded-key-for-timing-0001', addedAt: 1000 }] } } }),
        { mode: 0o600 },
      );
    },
  });
  await hub.setDeepseekKey();
  hub.machine.autoReply = false; // the frames here are the test's own
  CWD = path.join(hub.TMP, 'project');
  fs.mkdirSync(CWD, { recursive: true });
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  DEEPSEEK = { model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id };
});
after(() => hub?.stop());

// ---------------------------------------------------- one conversation

test('a conversation\'s time is the sum of what Kimi measured: turns, model steps, tool calls (overlaps once), compaction, rate-limit waits', async () => {
  const s = await newKimi();
  feed(s, FULL());
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.deepEqual({ turns: t.turns, wallMs: t.wallMs, modelMs: t.modelMs, toolMs: t.toolMs, compactMs: t.compactMs, rateLimitWaitMs: t.rateLimitWaitMs }, FULL_RESULT);
  assert.deepEqual(t.subagents, { spawned: 2, requeuedForRateLimit: 2 }, 'the requeue for another reason is not a rate-limit requeue');
  assert.equal(t.since, T, 'the Hub has seen this conversation since Kimi\'s first timestamp');
  assert.deepEqual(t.unmeasured.filter((u) => !/^(requests|http429)：/.test(u)), [], 'nothing else is missing');
});

test('Kimi\'s server puts the time in the payload instead of on the frame: the same numbers come out', async () => {
  const s = await newKimi();
  feed(s, FULL(), { inPayload: true });
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.deepEqual({ turns: t.turns, wallMs: t.wallMs, modelMs: t.modelMs, toolMs: t.toolMs, compactMs: t.compactMs, rateLimitWaitMs: t.rateLimitWaitMs }, FULL_RESULT);
});

test('the same frames seen again (a replay of the journal) change nothing', async () => {
  const s = await newKimi();
  feed(s, FULL());
  await settle(s.id, (x) => x.turns === 1, 'the turn');
  feed(s, FULL());
  feed(s, FULL(), { inPayload: true });
  await wait(300);
  const t = await timing(s.id);
  assert.deepEqual({ turns: t.turns, wallMs: t.wallMs, modelMs: t.modelMs, toolMs: t.toolMs, compactMs: t.compactMs, rateLimitWaitMs: t.rateLimitWaitMs }, FULL_RESULT);
  assert.deepEqual(t.subagents, { spawned: 2, requeuedForRateLimit: 2 });
});

test('the times are Kimi\'s own: frames that reach the Hub late, or after a delay on the way, add nothing', async () => {
  const s = await newKimi();
  // 60 ms of Kimi's time, delivered over about 600 ms of the Hub's.
  const frames = [
    ['turn.started', T, { turnId: '0' }],
    ['turn.step.completed', T + 55, { turnId: '0', step: 1, stepId: 'late', llmFirstTokenLatencyMs: 20, llmStreamDurationMs: 30 }],
    ['turn.ended', T + 60, { turnId: '0', reason: 'completed', durationMs: 60 }],
  ];
  for (const f of frames) {
    feed(s, [f]);
    await wait(200);
  }
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.equal(t.wallMs, 60, 'Kimi\'s length of the turn, not the time the frames took to arrive');
  assert.equal(t.modelMs, 50);
});

test('what could not be measured is null with the reason, never a guess', async () => {
  // A conversation the Hub has seen nothing of.
  const quiet = await newKimi();
  const none = await timing(quiet.id);
  for (const f of ['wallMs', 'modelMs', 'toolMs', 'compactMs', 'rateLimitWaitMs']) {
    assert.equal(none[f], null, f);
    assert.ok(none.unmeasured.some((u) => u.startsWith(`${f}：`)), `${f} is explained: ${JSON.stringify(none.unmeasured)}`);
  }
  assert.equal(none.since, null);
  assert.equal(none.turns, 0);
  assert.deepEqual(none.subagents, { spawned: null, requeuedForRateLimit: null });

  // A turn still running is not counted, and is said.
  const running = await newKimi();
  feed(running, [['turn.started', T, { turnId: '0' }], ['turn.step.completed', T + 500, { turnId: '0', step: 1, stepId: 'r1', llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 100 }]]);
  const r = await settle(running.id, (x) => x.since === T, 'the running turn');
  assert.equal(r.turns, 0);
  assert.equal(r.wallMs, null);
  assert.equal(r.modelMs, null, 'the step of a turn that has not ended is not added');
  assert.ok(r.unmeasured.some((u) => /^wallMs：.*還在進行/.test(u)), JSON.stringify(r.unmeasured));

  // Steps without timing (an interrupted step, an old connector): not added, and counted.
  const mixed = await newKimi();
  feed(mixed, [
    ['turn.started', T, { turnId: '0' }],
    ['turn.step.completed', T + 500, { turnId: '0', step: 1, stepId: 'm1', llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 200 }],
    ['turn.step.completed', T + 900, { turnId: '0', step: 2, stepId: 'm2' }],
    ['turn.ended', T + 1000, { turnId: '0', reason: 'completed', durationMs: 1000 }],
  ]);
  const m = await settle(mixed.id, (x) => x.turns === 1, 'the mixed turn');
  assert.equal(m.modelMs, 300, 'only the step that has timing');
  assert.ok(m.unmeasured.some((u) => /^modelMs：1 個步驟沒有帶計時/.test(u)), JSON.stringify(m.unmeasured));
  const bare = await newKimi();
  feed(bare, [['turn.started', T, { turnId: '0' }], ['turn.step.completed', T + 900, { turnId: '0', step: 1, stepId: 'b1' }], ['turn.ended', T + 1000, { turnId: '0', reason: 'completed', durationMs: 1000 }]]);
  const b = await settle(bare.id, (x) => x.turns === 1, 'the bare turn');
  assert.equal(b.modelMs, null, 'no step has timing at all');
  assert.ok(b.unmeasured.some((u) => u.startsWith('modelMs：')));
  assert.equal(b.wallMs, 1000);
});

test('a tool call that waited for a person, an open compaction and an open requeue are left out, and said', async () => {
  const s = await newKimi();
  feed(s, [
    ['turn.started', T, { turnId: '0' }],
    ['tool.call.started', T + 100, { turnId: '0', toolCallId: 'asked', name: 'Bash' }],
    ['event.approval.requested', T + 150, { approval_id: 'ap1', agent_id: 'main', tool_call_id: 'asked', tool_name: 'Bash' }],
    ['tool.result', T + 60_000, { turnId: '0', toolCallId: 'asked', output: 'ok' }],
    ['tool.call.started', T + 61_000, { turnId: '0', toolCallId: 'quick', name: 'Read' }],
    ['tool.result', T + 61_250, { turnId: '0', toolCallId: 'quick', output: 'ok' }],
    ['tool.call.started', T + 61_300, { turnId: '0', toolCallId: 'cut', name: 'Bash' }],
    ['compaction.started', T + 62_000, {}],
    ['subagent.spawned', T + 62_100, { subagentId: 'z1' }],
    ['subagent.suspended', T + 62_200, { subagentId: 'z1', reason: RL }],
    ['turn.ended', T + 70_000, { turnId: '0', reason: 'cancelled', durationMs: 70_000 }],
  ]);
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.equal(t.toolMs, 250, 'only the call nobody waited on and that has a result');
  assert.ok(t.unmeasured.some((u) => /^toolMs：.*等過你的核准/.test(u)));
  assert.ok(t.unmeasured.some((u) => /^toolMs：1 個工具呼叫沒有收到結果/.test(u)));
  assert.equal(t.compactMs, 0);
  assert.ok(t.unmeasured.some((u) => /^compactMs：1 次壓縮沒有收到結束事件/.test(u)));
  assert.equal(t.rateLimitWaitMs, 0);
  assert.ok(t.unmeasured.some((u) => /^rateLimitWaitMs：1 個被重新排隊的子代理還沒再開始跑/.test(u)));
  assert.equal(t.subagents.requeuedForRateLimit, 1, 'the requeue itself did happen');
});

test('events without a time cannot be timed: null and said, not counted as zero', async () => {
  const s = await newKimi();
  hub.machine.frame(s.kimiSessionId, 'turn.started', { turnId: '0' });
  hub.machine.frame(s.kimiSessionId, 'compaction.started', {});
  hub.machine.frame(s.kimiSessionId, 'compaction.completed', {});
  hub.machine.frame(s.kimiSessionId, 'subagent.suspended', { subagentId: 'u1', reason: RL });
  hub.machine.frame(s.kimiSessionId, 'turn.ended', { turnId: '0', reason: 'completed', durationMs: 500 });
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.equal(t.wallMs, 500, 'Kimi\'s durationMs needs no frame time');
  assert.equal(t.compactMs, null);
  assert.ok(t.unmeasured.some((u) => /^compactMs：.*沒有時間戳/.test(u)));
  assert.equal(t.rateLimitWaitMs, null);
  assert.equal(t.subagents.requeuedForRateLimit, 1);
  assert.equal(t.since, null, 'no frame carried a time');
});

test('a subagent\'s own steps are not added to the conversation\'s model time', async () => {
  const s = await newKimi();
  feed(s, [
    ['turn.started', T, { turnId: '0' }],
    ['turn.step.completed', T + 400, { turnId: '0', step: 1, stepId: 'main1', llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 100 }],
    ['subagent.spawned', T + 410, { subagentId: 'agent-0' }],
    ['turn.step.completed', T + 450, { turnId: '0', step: 1, stepId: 'sub1', llmFirstTokenLatencyMs: 9000, llmStreamDurationMs: 9000 }, { agentId: 'agent-0' }],
    ['turn.ended', T + 500, { turnId: '0', reason: 'completed', durationMs: 500 }],
  ]);
  const t = await settle(s.id, (x) => x.turns === 1, 'the turn');
  assert.equal(t.modelMs, 200);
});

// ------------------------------------------------ the proxy's request records

const record = (over = {}) => ({ id: `b1-${Math.random().toString(36).slice(2, 8)}`, req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: null, clientRetry: null, switchedFrom: null, recvAt: Date.now() - 100, startAt: Date.now() - 90, headersMs: 50, firstByteMs: 80, endMs: 500, status: 200, outcome: 'ok', inflight: 1, outTokens: null, ...over });
const report = (records, since = Date.now() - 3_600_000) => hub.machine.send({ t: 'deepseek.requests', boot: 'b1', since, replay: false, records });

test('requests and 429s of a DeepSeek conversation come from the connector\'s records, tied to it by its Kimi session', async () => {
  // (With two keys a DeepSeek conversation needs a connector that has the pool: that, but not yet the records.)
  await grant();
  const s = await newDeepseek();
  const other = await newDeepseek();
  feed(s, [['turn.started', T, { turnId: '0' }], ['turn.ended', T + 10, { turnId: '0', reason: 'completed', durationMs: 10 }]]);

  // A connector that does not say it writes records (an old one): null, and how to fix it.
  const old = await timing(s.id);
  assert.equal(old.requests, null);
  assert.equal(old.http429, null);
  assert.ok(old.unmeasured.some((u) => /^requests：.*連接器太舊/.test(u) && /重新執行連接指令/.test(u)), JSON.stringify(old.unmeasured));

  await grant('pool_timing');
  const since = Date.now() - 3_600_000;
  report([
    record({ session: s.kimiSessionId }),
    record({ session: s.kimiSessionId, status: 429, outcome: 'http_error' }),
    record({ session: s.kimiSessionId, status: 402, outcome: 'quota' }),
    record({ session: other.kimiSessionId }),
    record({ session: null }),
  ], since);
  const t = await settle(s.id, (x) => x.requests !== null, 'the records');
  assert.equal(t.requests, 3, 'the three of this conversation');
  assert.equal(t.http429, 1);
  assert.equal(t.requestsSince, since);
  assert.ok(t.unmeasured.some((u) => /^requests：另有 1 個.*沒帶對話識別/.test(u)), 'the request nobody can place is said');
  // Kimi's own wait after a 429 has no event: the queue wait does not claim to hold it.
  assert.ok(t.unmeasured.some((u) => /^rateLimitWaitMs：只量得到子代理被重新排隊的等待.*1 次 429/.test(u)), JSON.stringify(t.unmeasured));

  // The same records sent again (a reconnect) are the same records.
  const again = record({ session: s.kimiSessionId, id: 'b1-fixed' });
  report([again]);
  report([again]);
  await wait(300);
  assert.equal((await timing(s.id)).requests, 4);

  // Another conversation: only requests that name no conversation at all cannot be told apart, so nothing is claimed.
  const third = await newDeepseek();
  const x = await timing(third.id);
  assert.equal(x.requests, null);
  assert.ok(x.unmeasured.some((u) => /^requests：有 \d+ 個請求沒帶對話識別/.test(u)), JSON.stringify(x.unmeasured));
});

test('a conversation on the Kimi subscription has no proxy requests to count', async () => {
  const s = await newKimi();
  const t = await timing(s.id);
  assert.equal(t.requests, null);
  assert.ok(t.unmeasured.some((u) => /^requests：.*不是 DeepSeek 號池/.test(u)));
  assert.equal(t.currentKey, null, 'no key is claimed for a conversation that does not go through the pool');
});

// ------------------------------------------------------------------ keys

test('per key: requests, 429s, the most at once, time to the first byte and tokens per second, from the records only', async () => {
  await grant('pool_timing');
  const k = await usedKey();
  assert.ok(k.id);
  const at = Date.now();
  const mine = (over) => record({ key: k.id, startAt: at - 5000, ...over });
  report([
    mine({ firstByteMs: 100, endMs: 1100, outTokens: 100, inflight: 1 }),
    mine({ firstByteMs: 200, endMs: 2200, outTokens: 200, inflight: 2 }),
    mine({ firstByteMs: 300, endMs: 400, outTokens: null, inflight: 3 }),
    mine({ firstByteMs: 1000, endMs: 1500, outTokens: null, inflight: 2 }),
    mine({ firstByteMs: 50, endMs: 60, status: 429, outcome: 'http_error', inflight: 1 }),
    record({ key: 'dk_someone_else', inflight: 9 }),
    // Not records: refused, and nothing outside the fields is kept.
    { id: 'junk-1', key: k.id, startAt: at, outcome: 'ok', apiKey: 'sk-leaked-from-a-record', note: GATEWAY_KEY },
    { id: 'junk-2', key: k.id, startAt: 'yesterday', outcome: 'ok' },
    { id: 'junk-3', key: k.id, startAt: at, outcome: 'weird' },
  ]);
  const out = await until(async () => {
    const x = await hub.api('GET', '/deepseek/keys/timing');
    const e = x.keys.find((y) => y.id === k.id);
    return e?.requests >= 5 && x;
  }, 5000, 'the key\'s records');
  const e = out.keys.find((y) => y.id === k.id);
  assert.equal(e.requests, 6, 'five records and junk-1 (it has what a record needs; the fields it has besides are dropped)');
  assert.equal(e.http429, 1);
  assert.equal(e.peakConcurrent, 3);
  // Served ones only (the 429 is not a first byte of an answer): 100, 200, 300, 1000.
  assert.deepEqual(e.firstByteMs, { p50: 200, p95: 1000, n: 4 });
  // 300 tokens over (1100-100)+(2200-200) ms = 3 s.
  assert.equal(e.tokensPerSecond, 100);
  assert.equal(e.hint, k.hint);
  assert.equal(e.gateway, k.gateway);
  assert.ok(!out.keys.some((y) => y.id === 'dk_someone_else'), 'only keys the Hub holds');
  noKey(out);
  assert.ok(!JSON.stringify(out).includes('sk-leaked'), 'nothing of a record outside its fields is shown');
  assert.equal(e.measure, null, 'nothing was measured: it is only done on a person\'s press');
});

test('a key with no records says so, with null where nothing could be measured', async () => {
  // The seeded key never made a request.
  await grant('pool_timing');
  const out = await hub.api('GET', '/deepseek/keys/timing');
  const quiet = out.keys.find((y) => y.id === 'k_seed');
  assert.ok(quiet, JSON.stringify(out.keys.map((y) => [y.id, y.requests])));
  assert.equal(quiet.requests, 0);
  assert.equal(quiet.http429, 0);
  assert.equal(quiet.peakConcurrent, null);
  assert.equal(quiet.firstByteMs, null);
  assert.equal(quiet.tokensPerSecond, null);
  assert.ok(quiet.unmeasured.length >= 1);
  assert.ok(!JSON.stringify(out).includes('sk-seeded-key'));
});

// ---------------------------------------------------------- the measure

const measureCalls = () => hub.machine.rpcs.filter((r) => r.op === 'kimi.deepseek.measure');
const measureAnswer = (args) => ({ keyId: args.keyId, gateway: 'opencode-go', model: args.model, at: Date.now(), totalRequests: 31, stoppedEarly: null, levels: [1, 2, 4, 8, 16].map((n) => ({ concurrency: n, requests: n, ok: Math.min(n, 4), http429: Math.max(0, n - 4), errors: 0, statuses: n > 4 ? { 200: 4, 429: n - 4 } : { 200: n }, codes: [], latencyMs: { p50: 120, p95: 180 } })) });

test('the measure is never started by the Hub on its own, and needs the person\'s count of requests first', async () => {
  assert.equal(measureCalls().length, 0, 'nothing in all of the above asked a connector to measure');
  const k = await usedKey();
  const body = (b) => hub.api('POST', `/deepseek/keys/${k.id}/measure`, b);
  const none = await rejected(body({}));
  assert.equal(none.status, 400);
  assert.match(none.message, /確認.*31 個請求/);
  const wrong = await rejected(body({ confirmedRequests: 30 }));
  assert.equal(wrong.status, 400);
  const odd = await rejected(body({ levels: [100], confirmedRequests: 100 }));
  assert.equal(odd.status, 400);
  const extra = await rejected(body({ confirmedRequests: 31, apiKey: 'sk-x' }));
  assert.equal(extra.status, 400, 'no other field is taken');
  const missing = await rejected(hub.api('POST', '/deepseek/keys/dk_unknown/measure', { confirmedRequests: 31 }));
  assert.equal(missing.status, 404);
  assert.equal(measureCalls().length, 0, 'none of these reached a connector');
});

test('a connector too old to measure is told so, in words that say what to do', async () => {
  const k = await usedKey();
  const err = await rejected(hub.api('POST', `/deepseek/keys/${k.id}/measure`, { confirmedRequests: 31 }));
  assert.equal(err.status, 409);
  assert.match(err.message, /連接器太舊，重新執行連接指令/);
  assert.equal(measureCalls().length, 0, 'nothing was sent to it');
});

test('with a connector that can: it is asked by key id and model only, the answer is kept with the computer it came from, and the key never moves', async () => {
  await grant('pool_timing', 'pool_measure');
  hub.machine.answers['kimi.deepseek.measure'] = async (args) => measureAnswer(args);
  const k = await usedKey();
  const r = await hub.api('POST', `/deepseek/keys/${k.id}/measure`, { confirmedRequests: 31 });
  assert.equal(measureCalls().length, 1);
  const call = measureCalls()[0];
  assert.deepEqual(Object.keys(call.args).sort(), ['keyId', 'levels', 'model']);
  assert.equal(call.args.keyId, k.id);
  assert.deepEqual(call.args.levels, [1, 2, 4, 8, 16]);
  assert.equal(call.args.model, 'deepseek-v4.1-flash', 'the model of the key\'s gateway');
  assert.ok(!JSON.stringify(call).includes(GATEWAY_KEY), 'the key is not in what the connector is asked');
  assert.equal(r.machineId, MID);
  assert.equal(r.totalRequests, 31);
  assert.deepEqual(r.levels.map((l) => [l.concurrency, l.ok, l.http429]), [[1, 1, 0], [2, 2, 0], [4, 4, 0], [8, 4, 4], [16, 4, 12]]);
  noKey(r);
  // And the key list shows it, under that key.
  const out = await hub.api('GET', '/deepseek/keys/timing');
  assert.equal(out.keys.find((y) => y.id === k.id).measure.levels.length, 5);
  noKey(out);
});

test('levels other than the usual ones are measured when the total was confirmed; two at once on one key are refused', async () => {
  const k = await usedKey();
  let release;
  const held = new Promise((r) => (release = r));
  hub.machine.answers['kimi.deepseek.measure'] = async (args) => {
    await held;
    return measureAnswer(args);
  };
  const before = measureCalls().length;
  const first = hub.api('POST', `/deepseek/keys/${k.id}/measure`, { levels: [3, 6], confirmedRequests: 9 });
  await until(async () => measureCalls().length === before + 1, 5000, 'the call');
  assert.deepEqual(measureCalls().at(-1).args.levels, [3, 6]);
  const second = await rejected(hub.api('POST', `/deepseek/keys/${k.id}/measure`, { confirmedRequests: 31 }));
  assert.equal(second.status, 409);
  assert.match(second.message, /正在量測/);
  assert.equal(measureCalls().length, before + 1, 'the second never reached the connector');
  release();
  await first;
});

test('a connector that says it can but does not know the operation is still told it is too old', async () => {
  const k = await usedKey();
  hub.machine.answers['kimi.deepseek.measure'] = async () => {
    throw new Error('未知的操作：kimi.deepseek.measure');
  };
  const err = await rejected(hub.api('POST', `/deepseek/keys/${k.id}/measure`, { confirmedRequests: 31 }));
  assert.equal(err.status, 409);
  assert.match(err.message, /連接器太舊/);
  // A connector's own refusal comes through with its words.
  hub.machine.answers['kimi.deepseek.measure'] = async () => {
    throw Object.assign(new Error('這台電腦正在量測一把 key，等它跑完再試'), { status: 409 });
  };
  const busy = await rejected(hub.api('POST', `/deepseek/keys/${k.id}/measure`, { confirmedRequests: 31 }));
  assert.equal(busy.status, 409);
  assert.match(busy.message, /正在量測/);
});

// ------------------------------------------------- the key a conversation is on
// (Last in the file: these put requests on the seeded key, which the test of "a key
// with no records" needs to find untouched.)

test('the key a DeepSeek conversation is on is the key of its latest request: gateway and last four characters, never the key', async () => {
  await grant('pool_timing', 'pool_sticky');
  const keys = (await hub.api('GET', '/deepseek')).rotation.keys;
  assert.ok(keys.length >= 2, 'two keys on the list');
  const [a, b] = keys;
  const s = await newDeepseek();
  const other = await newDeepseek();
  const now = Date.now();
  // No request yet: nothing is claimed.
  assert.equal((await timing(s.id)).currentKey, null);
  report([
    record({ session: s.kimiSessionId, key: a.id, startAt: now - 5000 }),
    record({ session: s.kimiSessionId, key: b.id, startAt: now - 1000 }),
    record({ session: s.kimiSessionId, key: a.id, startAt: now - 3000 }), // arrived out of order
    record({ session: other.kimiSessionId, key: a.id, startAt: now - 10 }), // another conversation's, and later
  ]);
  const t = await settle(s.id, (x) => x.currentKey, 'the key');
  assert.deepEqual(t.currentKey, { id: b.id, gateway: b.gateway, gatewayLabel: b.gatewayLabel, hint: b.hint, removed: false, lastUsedAt: now - 1000, machineId: MID, distribution: 'sticky' });
  assert.equal(t.currentKey.hint.length, 4);
  noKey(t);
  // It moves with the conversation: a later request on the other key.
  report([record({ session: s.kimiSessionId, key: a.id, startAt: now - 500 })]);
  const moved = await settle(s.id, (x) => x.currentKey?.id === a.id, 'the move');
  assert.equal(moved.currentKey.lastUsedAt, now - 500);
  assert.equal((await timing(other.id)).currentKey.id, a.id, 'each conversation has its own');
});

test('the way the keys are given out is said for the computer that sent the request: the Hub\'s choice if it can, the relay if it cannot', async () => {
  const [a] = (await hub.api('GET', '/deepseek')).rotation.keys;
  const s = await newDeepseek();
  report([record({ session: s.kimiSessionId, key: a.id, startAt: Date.now() - 100 })]);
  await grant('pool_timing'); // a connector that cannot give each conversation its own key
  assert.equal((await settle(s.id, (x) => x.currentKey)).currentKey.distribution, 'relay');
  await grant('pool_timing', 'pool_sticky');
  assert.equal((await settle(s.id, (x) => x.currentKey?.distribution === 'sticky')).currentKey.distribution, 'sticky');
  await hub.api('PUT', '/deepseek', { distribution: 'relay' });
  try {
    assert.equal((await settle(s.id, (x) => x.currentKey?.distribution === 'relay')).currentKey.distribution, 'relay', 'a person chose the relay');
  } finally {
    await hub.api('PUT', '/deepseek', { distribution: 'sticky' });
  }
  assert.equal((await timing(s.id)).currentKey.distribution, 'sticky');
});

test('a key that is no longer on the list is said to be gone, with its gateway, and no last four characters are made up', async () => {
  await grant('pool_timing', 'pool_sticky');
  const s = await newDeepseek();
  report([record({ session: s.kimiSessionId, key: 'dk_removed1', gateway: 'commandcode', startAt: Date.now() - 100 })]);
  const t = await settle(s.id, (x) => x.currentKey, 'the key');
  assert.deepEqual([t.currentKey.id, t.currentKey.gateway, t.currentKey.gatewayLabel, t.currentKey.hint, t.currentKey.removed], ['dk_removed1', 'commandcode', 'Command Code', null, true]);
});
