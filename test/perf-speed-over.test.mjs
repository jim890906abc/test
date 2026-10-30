// How long the speed of a worker and the output of a cluster take to work out
// when the computer holds 50 000 request records (the Hub keeps at most 20 000
// per computer; this is three computers' worth). A synthetic, repeatable
// measure of the CPU the cluster pages used to burn on this (6.9% of the VPS
// Hub's time in its 2026-10-30 profile): before the index every question read
// every record of the computer.
//
// The reference is the full scan itself, written out below and timed in the
// same run on the same records, so the threshold is a ratio and holds on a slow
// machine as well as a fast one. The figures are printed (PERF lines) so a run
// can be kept next to the one before it.
//
//   2026-10-30, this machine, before the index:  one worker 0.50 ms, a round over 13 clusters 56.4 ms
//   2026-10-30, this machine, with the index:    one worker 0.009 ms, a round over 13 clusters 0.71 ms
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-hub-perf-speed-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let machines;
let timing;

const NOW = 1_790_000_000_000;
const MACHINES = 3;
const PER_MACHINE = 16_600; // 49 800 records in all
const WORKERS = 60; // conversations per computer
const raw = []; // the records as the test made them, per machine
const chains = [];

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
}

before(async () => {
  machines = await import('../server/machines.js');
  timing = await import('../server/timing.js');
  const r = rng(12345);
  for (let m = 0; m < MACHINES; m++) {
    const id = `m_perf_${m}`;
    const ws = new EventEmitter();
    ws.send = () => {};
    ws.close = () => {};
    machines.attachBridge(ws);
    ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, capabilities: ['pool', 'pool_timing'], status: { available: false } }));
    const mine = [];
    for (let b = 0; b < PER_MACHINE; b += 500) {
      const records = [];
      for (let i = b; i < Math.min(PER_MACHINE, b + 500); i++) {
        const startAt = NOW - 3_600_000 + Math.floor((i / PER_MACHINE) * 3_600_000);
        records.push({ id: `r${m}-${i}`, req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: `session_w${m}-${i % WORKERS}`, startAt, recvAt: startAt, endMs: 400 + Math.floor(r() * 4000), status: 200, outcome: 'ok', outTokens: Math.floor(r() * 800) });
      }
      timing.applyRequests(id, { t: 'deepseek.requests', since: NOW - 7_200_000, records });
      mine.push(...records);
    }
    raw.push(mine);
    for (let w = 0; w < WORKERS; w++) chains.push([{ id: `n-${m}-${w}`, kimiSessionId: `session_w${m}-${w}`, machineId: id, provider: 'deepseek' }]);
  }
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The full scan: every record of the computer, as the code did before the index.
function scan(ids, machineIndex, now, windowMs, from) {
  const since = Math.max(now - windowMs, from, NOW - 7_200_000);
  let outTokens = 0;
  let requests = 0;
  for (const r of raw[machineIndex]) {
    if (!ids.has(r.session)) continue;
    if (r.startAt >= since && r.startAt <= now) requests++;
    const end = r.startAt + r.endMs;
    if (end >= since && end <= now) outTokens += r.outTokens;
  }
  return { outTokens, requests };
}

const ms = (f, reps) => {
  f(0);
  const t0 = process.hrtime.bigint();
  for (let i = 1; i <= reps; i++) f(i);
  return Number(process.hrtime.bigint() - t0) / 1e6 / reps;
};

test('one worker\'s speed over 50 000 records is worked out in a small fraction of the time a full scan takes', () => {
  assert.equal(chains.length, MACHINES * WORKERS);
  // Every call a different moment, so no saved answer is used: this is the cost of working a figure out.
  const indexed = ms((i) => timing.recentSpeed(chains[i % chains.length], { now: NOW + i * 13, from: NOW - 3_600_000 }), 600);
  const scanned = ms((i) => {
    const c = chains[i % chains.length];
    scan(new Set([c[0].kimiSessionId]), Math.floor((i % chains.length) / WORKERS), NOW + i * 13, 300_000, NOW - 3_600_000);
  }, 120);
  console.log(`PERF recentSpeed one worker: indexed ${indexed.toFixed(3)} ms, full scan ${scanned.toFixed(3)} ms, ${(scanned / indexed).toFixed(0)}x`);
  assert.ok(indexed * 5 < scanned, `the index must be at least 5x faster than reading every record (indexed ${indexed.toFixed(3)} ms, scan ${scanned.toFixed(3)} ms)`);
});

test('a round over 13 clusters of 10 workers (a cluster\'s output, then each worker\'s speed) is cheap', () => {
  let round = 0;
  const once = () => {
    const now = NOW + 1_000_000 + ++round * 7; // a moment nobody asked for yet
    for (let c = 0; c < 13; c++) {
      const members = chains.slice((c % 18) * 10, (c % 18) * 10 + 10);
      timing.recentOutput(members, { now, from: NOW - 3_600_000 });
      for (const ch of members) timing.recentSpeed(ch, { now, from: NOW - 3_600_000 });
    }
  };
  const indexed = ms(once, 20);
  const scanned = ms((i) => {
    const now = NOW + i * 7;
    for (let c = 0; c < 13; c++) {
      const members = chains.slice((c % 18) * 10, (c % 18) * 10 + 10);
      const ids = new Set(members.map((x) => x[0].kimiSessionId));
      scan(ids, Math.floor(((c % 18) * 10) / WORKERS), now, 60_000, NOW - 3_600_000);
      for (const ch of members) scan(new Set([ch[0].kimiSessionId]), Math.floor(((c % 18) * 10) / WORKERS), now, 300_000, NOW - 3_600_000);
    }
  }, 3);
  console.log(`PERF cluster overview round (13 clusters x (1 output + 10 speeds)): indexed ${indexed.toFixed(2)} ms, full scan ${scanned.toFixed(2)} ms, ${(scanned / indexed).toFixed(0)}x`);
  assert.ok(indexed * 5 < scanned, `a round must cost a fraction of the full scan (indexed ${indexed.toFixed(2)} ms, scan ${scanned.toFixed(2)} ms)`);
});
