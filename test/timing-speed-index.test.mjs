// recentSpeed / recentOutput over a time index of the request records.
//
// The speed of a worker and the output of a cluster are worked out from a
// computer's request records for every cluster page, every push and every
// list of clusters. They used to read EVERY record of the computer (up to
// 20 000) each time; now the records are indexed by conversation and by start
// time, and a repeated question inside the same second is answered once.
//
// What is under test is that nothing a person can see changed:
//  - the answer is, to the digit, what the old full scan gave: an oracle
//    (the old algorithm written out below, reading the raw records and nothing
//    of the Hub's own index) is compared with the Hub over many random
//    questions, including records exactly on the window's edges, a request
//    that started before the window and ended inside it, records that arrived
//    late and out of order, and the records dropped at the cap;
//  - a question asked with a clock of its own ({ now }) is never answered from
//    an older moment;
//  - a question asked without one may be answered with the moment of the
//    first asking for one second, but never with a record that arrived since;
//  - what a caller does with an answer cannot change the next answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-hub-speed-index-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let machines;
let timing;

const NOW = 1_790_000_000_000;
const MAX_RECORDS = 20_000;

// Small deterministic random source: the same seed asks the same questions.
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function connect(id, capabilities = ['pool', 'pool_timing']) {
  const ws = new EventEmitter();
  ws.send = () => {};
  ws.close = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, capabilities, status: { available: false } }));
}
const feed = (machineId, records, since) => timing.applyRequests(machineId, { t: 'deepseek.requests', boot: 'b', since, replay: false, records });
const rec = (id, over = {}) => ({ id, req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: null, clientRetry: null, switchedFrom: null, recvAt: NOW, startAt: NOW, headersMs: 5, firstByteMs: 8, endMs: 100, status: 200, outcome: 'ok', inflight: 1, outTokens: 10, ...over });
const node = (kimiSessionId, machineId, over = {}) => ({ id: `n-${kimiSessionId}`, kimiSessionId, machineId, provider: 'deepseek', ...over });

// ------------------------------------------------------------ the oracle
// The algorithm as it was before the index: read every record of every
// computer in the question, test each one. It sees only what the test fed.
class Oracle {
  constructor() {
    this.machines = new Map(); // machine id -> { records: [raw, ...] in the order they were kept, since, floor }
  }
  feed(machineId, records, since) {
    let m = this.machines.get(machineId);
    if (!m) this.machines.set(machineId, (m = { records: [], ids: new Set(), since: null, floor: 0 }));
    if (since !== null && (m.since === null || since < m.since)) m.since = since;
    for (const r of records.slice(0, 500)) {
      if (m.ids.has(r.id)) continue;
      m.ids.add(r.id);
      m.records.push(r);
    }
    while (m.records.length > MAX_RECORDS) {
      const gone = m.records.shift();
      m.ids.delete(gone.id);
      if (gone.startAt > m.floor) m.floor = gone.startAt;
    }
  }
  // The old speedOver, for chains whose leaf is on a DeepSeek-pool computer that can time.
  over(chains, { now, windowMs, from = null }) {
    const none = (unmeasured) => ({ result: { windowMs: null, outTokens: null, tokensPerSecond: null, requests: null, requestsPerMinute: null, unmeasured }, counted: 0 });
    const usable = chains.filter((nodes) => nodes?.at(-1)?.kimiSessionId && nodes.at(-1).machineId);
    if (!usable.length) return none('no chain');
    const byMachine = new Map();
    for (const nodes of usable) for (const n of nodes) if (n.kimiSessionId && n.machineId) (byMachine.get(n.machineId) || byMachine.set(n.machineId, new Set()).get(n.machineId)).add(n.kimiSessionId);
    let coverage = null;
    const used = [];
    for (const [machineId, ids] of byMachine) {
      const m = this.machines.get(machineId);
      const cov = m && m.since !== null ? Math.max(m.since, m.floor) : null;
      if (cov === null) continue;
      coverage = coverage === null ? cov : Math.min(coverage, cov);
      used.push([m, ids]);
    }
    if (coverage === null) return none('no coverage');
    const since = Math.max(now - windowMs, Number.isFinite(from) ? from : 0, coverage);
    const span = now - since;
    if (span < 5_000) return none('short');
    let outTokens = 0;
    let requests = 0;
    let unattributed = 0;
    for (const [m, ids] of used) {
      for (const r of m.records) {
        if (!r.session) {
          if (r.startAt >= since && r.startAt <= now) unattributed++;
          continue;
        }
        if (!ids.has(r.session)) continue;
        if (r.startAt >= since && r.startAt <= now) requests++;
        const end = Number.isFinite(r.endMs) ? r.startAt + r.endMs : null;
        if (end !== null && end >= since && end <= now && r.outTokens !== null) outTokens += r.outTokens;
      }
    }
    if (requests === 0 && unattributed > 0) return none('unattributed');
    return {
      result: { windowMs: span, outTokens, tokensPerSecond: Math.round((outTokens / (span / 1000)) * 10) / 10, requests, requestsPerMinute: Math.round((requests / (span / 60_000)) * 10) / 10, unmeasured: null },
      counted: usable.length,
    };
  }
}
// What the Hub says of an unanswerable question carries a sentence; the oracle only knows it is null.
const shape = (r) => (r.outTokens === null ? { unanswered: true } : r);

before(async () => {
  machines = await import('../server/machines.js');
  timing = await import('../server/timing.js');
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('over many random questions the indexed speed and output are, to the digit, what the full scan gave', () => {
  const MIDS = ['m_a', 'm_b'];
  for (const m of MIDS) connect(m);
  const oracle = new Oracle();
  const r = rng(42);
  const SESSIONS = MIDS.flatMap((m) => Array.from({ length: 6 }, (_, i) => `session_${m}-${i}-aaaa`));
  const pick = (list) => list[Math.floor(r() * list.length)];
  // Edges the questions will use, so that records sit exactly on them.
  const edges = [NOW, NOW - 60_000, NOW - 300_000, NOW - 120_000];
  const durations = [null, 0, 1, 100, 799.5, 5_000, 61_000, 400_000, 1_000_000];
  let n = 0;
  for (const mid of MIDS) {
    const records = [];
    for (let i = 0; i < 2400; i++) {
      const edge = r() < 0.2;
      const startAt = edge ? pick(edges) + pick([0, 0, -1, 1]) : NOW - 800_000 + Math.floor(r() * 900_000);
      const session = r() < 0.12 ? null : r() < 0.1 ? 'session_somebody-else-zzzz' : pick(SESSIONS.filter((s) => s.startsWith(`session_${mid}`)));
      const endMs = pick(durations);
      records.push(rec(`r${++n}`, { session, startAt, recvAt: startAt, endMs, outTokens: r() < 0.15 ? null : Math.floor(r() * 900) }));
    }
    // Arrive in batches, some of them backwards: late records must land in order of start time.
    for (let b = 0; b < records.length; b += 500) {
      const batch = records.slice(b, b + 500);
      if (b % 1000 === 500) batch.reverse();
      const since = NOW - 3_600_000;
      feed(mid, batch, since);
      oracle.feed(mid, batch, since);
    }
  }
  // The same record sent again is still one record.
  const again = [rec('r1', { session: SESSIONS[0] })];
  feed('m_a', again, NOW - 3_600_000);
  oracle.feed('m_a', again, NOW - 3_600_000);
  let answered = 0;
  for (let q = 0; q < 400; q++) {
    const k = 1 + Math.floor(r() * 5);
    const chains = Array.from({ length: k }, () => {
      const len = 1 + Math.floor(r() * 2);
      return Array.from({ length: len }, () => {
        const s = pick(SESSIONS);
        return node(s, r() < 0.15 ? pick(MIDS) : s.slice(8, 11));
      });
    });
    const now = pick(edges) + pick([0, 0, 1, -1, 7, 4_999, 5_000, 5_001]);
    const windowMs = pick([60_000, 300_000, 120_000, 1_000]);
    const from = pick([null, NOW - 3_600_000, NOW - 150_000, NOW - 10_000, NOW + 10_000]);
    const want = oracle.over(chains, { now, windowMs, from });
    const { workersCounted, workers, ...got } = timing.recentOutput(chains, { now, windowMs, from });
    assert.deepEqual(shape(got), shape(want.result), `question ${q}: output of ${chains.length} chains at ${now - NOW}`);
    assert.equal(workersCounted, want.counted, `question ${q}: chains counted`);
    assert.equal(workers, chains.length);
    const one = timing.recentSpeed(chains[0], { now, from });
    const wantOne = oracle.over([chains[0]], { now, windowMs: 300_000, from });
    assert.deepEqual(shape(one), shape(wantOne.result), `question ${q}: speed of one chain`);
    if (got.outTokens !== null) answered++;
  }
  assert.ok(answered > 150, `the questions were not all unanswerable (${answered} answered)`);
});

test('a request that started before the window and ended inside it counts its tokens, and one that has not ended counts none', () => {
  connect('m_edge');
  const S = 'session_edge-0001';
  feed('m_edge', [
    rec('e1', { session: S, startAt: NOW - 400_000, endMs: 150_000, outTokens: 500 }), // ended 250 s ago: inside five minutes
    rec('e2', { session: S, startAt: NOW - 1_000, endMs: null, outTokens: null }), // still going
    rec('e3', { session: S, startAt: NOW - 2_000_000, endMs: 5_000, outTokens: 9_999 }), // long gone
  ], NOW - 3_600_000);
  const got = timing.recentSpeed([node(S, 'm_edge')], { now: NOW, from: NOW - 3_600_000 });
  assert.equal(got.outTokens, 500);
  assert.equal(got.requests, 1, 'only e2 started inside the window');
});

test('past the cap the oldest record goes, the window cannot start before what was dropped, and the answer matches the full scan', () => {
  connect('m_cap');
  const oracle = new Oracle();
  const S = ['session_cap-0001-aaaa', 'session_cap-0002-aaaa'];
  const r = rng(7);
  let n = 0;
  // 20 500 records in order, each 30 ms after the last: the first 500 are dropped.
  for (let b = 0; b < 41; b++) {
    const batch = [];
    for (let i = 0; i < 500; i++) {
      const startAt = NOW - 700_000 + n * 30;
      batch.push(rec(`c${n}`, { session: S[n % 2], startAt, recvAt: startAt, endMs: 200 + Math.floor(r() * 3000), outTokens: Math.floor(r() * 500) }));
      n++;
    }
    feed('m_cap', batch, NOW - 3_600_000);
    oracle.feed('m_cap', batch, NOW - 3_600_000);
  }
  const chains = [[node(S[0], 'm_cap')], [node(S[1], 'm_cap')]];
  for (const now of [NOW, NOW - 30_000, NOW - 400_000]) {
    const want = oracle.over(chains, { now, windowMs: 300_000, from: null });
    const { workersCounted, workers, ...got } = timing.recentOutput(chains, { now, windowMs: 300_000 });
    assert.deepEqual(shape(got), shape(want.result));
  }
  // The floor: the window of a long question starts after the last dropped record, not before.
  const long = timing.recentOutput(chains, { now: NOW, windowMs: 3_600_000 });
  const m = oracle.machines.get('m_cap');
  assert.equal(long.windowMs, NOW - Math.max(NOW - 3_600_000, m.floor, m.since));
  assert.ok(m.floor > NOW - 700_000, 'the cap really dropped records');
});

test('asked without a clock, the same question inside one second is answered once; a record that arrives meanwhile is in the next answer', () => {
  connect('m_cache');
  const S = 'session_cache-0001';
  const FROM = NOW - 100_000; // the cluster began 100 s before: the window is as long as its life, so it grows with the clock
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    feed('m_cache', [rec('k1', { session: S, startAt: NOW - 20_000, endMs: 1_000, outTokens: 100 })], NOW - 3_600_000);
    const ask = () => timing.recentSpeed([node(S, 'm_cache')], { from: FROM });
    const first = ask();
    assert.equal(first.outTokens, 100);
    assert.equal(first.windowMs, 100_000);
    clock = NOW + 400;
    const second = ask();
    assert.deepEqual(second, first, 'inside the same second: the answer of the first asking');
    // A record arrives: the next answer has it at once, whatever the second.
    feed('m_cache', [rec('k2', { session: S, startAt: NOW + 100, endMs: 100, outTokens: 50 })], NOW - 3_600_000);
    clock = NOW + 600;
    const third = ask();
    assert.equal(third.outTokens, 150, 'a new record is never hidden by the saved answer');
    assert.equal(third.windowMs, 100_600, 'and the answer is worked out at the moment it was asked');
    // Over a second later the saved answer is no longer used.
    clock = NOW + 2_000;
    const fourth = ask();
    assert.equal(fourth.windowMs, 102_000);
  } finally {
    Date.now = realNow;
  }
});

test('asked with a clock of its own, an answer is never one of another moment', () => {
  connect('m_clock');
  const S = 'session_clock-0001';
  feed('m_clock', [rec('t1', { session: S, startAt: NOW - 20_000, endMs: 1_000, outTokens: 100 })], NOW - 3_600_000);
  const at = (now) => timing.recentSpeed([node(S, 'm_clock')], { now, from: NOW - 100_000 });
  const a = at(NOW);
  const b = at(NOW + 100);
  const c = at(NOW);
  assert.equal(b.windowMs, a.windowMs + 100);
  assert.deepEqual(c, a, 'the same moment, the same answer');
});

test('a caller that changes the answer it got cannot change the next one', () => {
  connect('m_mut');
  const S = 'session_mut-0001';
  feed('m_mut', [rec('u1', { session: S, startAt: NOW - 20_000, endMs: 1_000, outTokens: 100 })], NOW - 3_600_000);
  const ask = () => timing.recentOutput([[node(S, 'm_mut')]], { now: NOW, from: NOW - 3_600_000 });
  const first = ask();
  first.outTokens = -1;
  first.tokensPerSecond = -1;
  assert.equal(ask().outTokens, 100);
  const speed = () => timing.recentSpeed([node(S, 'm_mut')], { now: NOW, from: NOW - 3_600_000 });
  speed(); // worked out
  speed().outTokens = -5; // answered from what was saved, and changed by the caller
  assert.equal(speed().outTokens, 100);
});

test('a request that names no conversation counts against a zero only when it started inside the window', () => {
  connect('m_orphan');
  const S = 'session_orphan-0001';
  // Inside the window, nobody's request at all: a zero is not claimed.
  feed('m_orphan', [rec('o1', { session: null, startAt: NOW - 10_000 })], NOW - 3_600_000);
  assert.match(timing.recentSpeed([node(S, 'm_orphan')], { now: NOW, from: NOW - 100_000 }).unmeasured, /沒帶對話識別/);
  // After the window's end (the question is about an earlier moment) it is not counted: the conversation really did nothing.
  const earlier = timing.recentSpeed([node(S, 'm_orphan')], { now: NOW - 60_000, from: NOW - 200_000 });
  assert.equal(earlier.unmeasured, null);
  assert.equal(earlier.requests, 0);
  // Before the window's start it is not counted either.
  const later = timing.recentSpeed([node(S, 'm_orphan')], { now: NOW + 400_000, from: NOW + 100_000 });
  assert.equal(later.unmeasured, null);
  assert.equal(later.requests, 0);
});

test('unanswerable questions keep their words: a connector that cannot time, no record yet, no computer, not a DeepSeek conversation', () => {
  connect('m_old', ['pool']);
  assert.match(timing.recentSpeed([node('session_old-0001', 'm_old')], { now: NOW }).unmeasured, /太舊/);
  connect('m_new');
  assert.match(timing.recentSpeed([node('session_new-0001', 'm_new')], { now: NOW }).unmeasured, /還沒有回報過任何請求紀錄/);
  assert.match(timing.recentSpeed([], { now: NOW }).unmeasured, /還沒有對應到任何一台電腦上的 Kimi 對話/);
  assert.match(timing.recentSpeed([node('session_kimi-0001', 'm_new', { provider: 'kimi' })], { now: NOW }).unmeasured, /不是 DeepSeek 號池/);
});
