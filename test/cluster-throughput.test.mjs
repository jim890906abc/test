// 叢集總產出 (the cluster's throughput): everything the whole cluster - its
// workers AND their subagents - produced in the last minute, worked out from the
// connector's request records by timing.recentOutput(). Run in the same process
// (the Hub's own modules, the records fed the way a connector sends them), so the
// clock can be held still and a window longer than the test can be checked.
//
// The rules under test (the owner's, 2026-10-29; "only what really happened"):
//  - tokens of the requests that ENDED in the last 60 seconds, over the window's
//    seconds, for every conversation of the cluster; a subagent's requests carry
//    its worker's session id (prompt_cache_key), so they are counted with it;
//  - a request that ended before the window, or another conversation's, is not;
//  - a window cannot be longer than the cluster's life (`from`), and says its own length;
//  - no record at all, a connector too old, or workers off the DeepSeek pool: null and the reason, never 0;
//  - the five-minute per-worker speed (recentSpeed) gives the very same numbers as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-hub-throughput-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let machines;
let timing;

const NOW = 1_790_000_000_000;
const W_A = 'session_wa-1111';
const W_B = 'session_wb-2222';
const OTHER = 'session_someone-else-9999';
let seq = 0;
const rec = (over = {}) => ({ id: `r-${++seq}`, req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: W_A, clientRetry: null, switchedFrom: null, recvAt: NOW - 1000, startAt: NOW - 900, headersMs: 50, firstByteMs: 80, endMs: 500, status: 200, outcome: 'ok', inflight: 1, outTokens: null, ...over });
// A request that ENDED `endedAgo` ms before NOW.
const ended = (endedAgo, outTokens, session = W_A, over = {}) => rec({ session, startAt: NOW - endedAgo - 800, endMs: 800, outTokens, ...over });
const node = (kimiSessionId, over = {}) => ({ id: `n-${kimiSessionId}`, kimiSessionId, machineId: 'm_t', provider: 'deepseek', ...over });
const feed = (machineId, records, since = NOW - 3_600_000) => timing.applyRequests(machineId, { t: 'deepseek.requests', boot: 'b', since, replay: false, records });

function connect(id, capabilities) {
  const ws = new EventEmitter();
  ws.send = () => {};
  ws.close = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, capabilities, status: { available: false } }));
}

before(async () => {
  machines = await import('../server/machines.js');
  timing = await import('../server/timing.js');
  connect('m_t', ['pool', 'pool_timing']);
  // Everything below is the same moment's records: what each worker and its subagents did.
  feed('m_t', [
    // Worker A and its subagents (the same session id): three requests ended in the last minute, one 90 s ago, one 6 minutes ago.
    ended(5_000, 100),
    ended(25_000, 200),
    ended(55_000, 300),
    ended(90_000, 1000),
    ended(360_000, 4000),
    // Worker B: one inside the minute, one 70 s ago.
    ended(10_000, 50, W_B),
    ended(70_000, 700, W_B),
    // Somebody else's conversation, and a request still going (no end yet, so no tokens yet).
    ended(5_000, 7777, OTHER),
    rec({ session: W_A, startAt: NOW - 1_000, endMs: null, outTokens: null }),
  ]);
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('the whole cluster\'s output is the tokens of every request that ended in the last 60 seconds, over 60 seconds - the workers\' and their subagents\' alike, nobody else\'s, nothing from before the window', () => {
  const chains = [[node(W_A)], [node(W_B)]];
  const got = timing.recentOutput(chains, { now: NOW, from: NOW - 3_600_000 });
  assert.equal(got.windowMs, 60_000, 'the window is a minute, not five');
  assert.equal(got.outTokens, 100 + 200 + 300 + 50, 'A\'s three requests (worker and subagents share its session id) and B\'s one; not the 90 s, 70 s or 6 minute old ones, not the other conversation\'s, not the one still going');
  assert.equal(got.tokensPerSecond, Math.round((650 / 60) * 10) / 10);
  assert.equal(got.requests, 4 + 1, 'requests that started in the window: A\'s three and the one still going, and B\'s one');
  assert.equal(got.unmeasured, null);
  assert.deepEqual([got.workersCounted, got.workers], [2, 2]);
  // Not the sum of two per-worker numbers: one window, one total (a worker counted alone gives its own share).
  const onlyA = timing.recentOutput([[node(W_A)]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(onlyA.outTokens, 600);
  assert.equal(onlyA.workersCounted, 1);
});

test('the window is never longer than the cluster has lived: a cluster 20 seconds old is measured over 20 seconds, and says so', () => {
  const young = timing.recentOutput([[node(W_A)], [node(W_B)]], { now: NOW, from: NOW - 20_000 });
  assert.equal(young.windowMs, 20_000);
  assert.equal(young.outTokens, 100 + 50, 'only what ended inside those 20 seconds (A\'s 25- and 55-second-old requests are from before the cluster was made)');
  assert.equal(young.tokensPerSecond, 7.5);
  const brandNew = timing.recentOutput([[node(W_A)]], { now: NOW, from: NOW - 2_000 });
  assert.equal(brandNew.tokensPerSecond, null, 'two seconds of work says nothing about how fast it goes');
  assert.match(brandNew.unmeasured, /時間窗只有 2 秒|還量不出速度/);
});

test('a minute with no request in it is a measured zero; but requests that name no conversation may be the cluster\'s, so then there is no number', () => {
  feed('m_quiet', [ended(200_000, 900, 'session_qq-1111')]);
  connect('m_quiet', ['pool', 'pool_timing']);
  const quiet = timing.recentOutput([[node('session_qq-1111', { machineId: 'm_quiet' })]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(quiet.tokensPerSecond, 0, 'all of its requests are in the connector\'s records and none ended in the last minute: that is a measurement');
  assert.equal(quiet.outTokens, 0);
  feed('m_quiet', [ended(3_000, 400, null)]);
  const doubt = timing.recentOutput([[node('session_qq-1111', { machineId: 'm_quiet' })]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(doubt.tokensPerSecond, null, 'not 0: 400 tokens went somewhere');
  assert.match(doubt.unmeasured, /1 個請求沒帶對話識別/);
});

test('no records yet, a connector too old to write them, and workers off the DeepSeek pool each give "—" with their own reason - never 0', () => {
  connect('m_empty', ['pool', 'pool_timing']);
  const none = timing.recentOutput([[node('session_ee-1111', { machineId: 'm_empty' })]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(none.tokensPerSecond, null);
  assert.match(none.unmeasured, /還沒有回報過任何請求紀錄/);
  connect('m_old', ['pool']);
  const old = timing.recentOutput([[node('session_oo-1111', { machineId: 'm_old' })]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(old.tokensPerSecond, null);
  assert.match(old.unmeasured, /連接器太舊/);
  const kimi = timing.recentOutput([[node(W_A, { provider: 'kimi' })]], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(kimi.tokensPerSecond, null);
  assert.match(kimi.unmeasured, /不是 DeepSeek 號池/);
  assert.equal(timing.recentOutput([], { now: NOW }).tokensPerSecond, null, 'a cluster with no worker says nothing');
});

test('workers the records cannot speak for are left out and counted as left out: the total is of those that could, and says how many', () => {
  const got = timing.recentOutput([[node(W_A)], [node(W_B, { provider: 'kimi' })], []], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(got.outTokens, 600, 'only worker A\'s');
  assert.deepEqual([got.workersCounted, got.workers], [1, 3]);
});

test('the per-worker five-minute speed is unchanged: the same window, the same tokens, the same numbers and the same fields as before', () => {
  const a = timing.recentSpeed([node(W_A)], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(a.windowMs, 300_000);
  assert.equal(a.outTokens, 100 + 200 + 300 + 1000, 'the 90-second-old request counts here (it is inside five minutes); the 6-minute-old one does not');
  assert.equal(a.tokensPerSecond, 5.3);
  assert.equal(a.requests, 5);
  assert.equal(a.requestsPerMinute, 1);
  assert.equal(a.unmeasured, null);
  assert.deepEqual(Object.keys(a).sort(), ['outTokens', 'requests', 'requestsPerMinute', 'tokensPerSecond', 'unmeasured', 'windowMs'], 'no field of the cluster form leaks into a worker\'s');
  // And the reasons a worker cannot be measured are the very words they were.
  assert.match(timing.recentSpeed([node(W_A, { provider: 'kimi' })], { now: NOW }).unmeasured, /這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以算速度/);
  assert.match(timing.recentSpeed([], { now: NOW }).unmeasured, /這個對話還沒有對應到任何一台電腦上的 Kimi 對話/);
});
