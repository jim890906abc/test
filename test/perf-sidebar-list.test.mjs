// What the page's first request costs, with a Hub shaped like the VPS one that
// was slow on 2026-10-30 (made up and repeatable: test/fixtures/perf-hub.mjs):
// 100 conversations of which 60 are workers of 12 clusters (8 at work), two
// computers that each report 100 Kimi conversations.
//
// GET /api/sessions, the plain list (every conversation whole, as the VPS
// answered: 612 KB for 90) against ?for=sidebar (what the sidebar lists:
// workers as stubs, no model/skill lists). The figures are printed (PERF lines)
// to keep next to the ones before them.
//
//   2026-10-30, this machine:
//     before (the plain list, as it was):  GET /api/sessions 625 544 B, 76-88 ms on the first request, 15 ms warm; the largest entry 9 178 B
//     with ?for=sidebar:                   104 486 B (16.7%), 3.7 ms; the largest entry 1 775 B
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPerfHub } from './fixtures/perf-hub.mjs';

let hub;
before(async () => {
  hub = await startPerfHub({ conversations: 100, workers: 60, perCluster: 5, activeClusters: 8, machines: 2, native: 100 });
});
after(() => hub?.stop());

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function measure(p, runs = 7) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = await hub.raw(p);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    bytes = r.bytes;
  }
  return { bytes, ms: median(times) };
}

test('the page\'s first request is a fraction of the plain list: 100 conversations, 60 of them cluster workers', async () => {
  const plain = await measure('/api/sessions');
  const side = await measure('/api/sessions?for=sidebar');
  const list = (await hub.raw('/api/sessions?for=sidebar')).json();
  const biggest = (xs) => Math.max(...xs.map((x) => JSON.stringify(x).length));
  const plainList = (await hub.raw('/api/sessions')).json();
  console.log(`PERF GET /api/sessions: plain ${plain.bytes} B ${plain.ms.toFixed(1)} ms (${plainList.length} conversations, the largest ${biggest(plainList)} B); ?for=sidebar ${side.bytes} B ${side.ms.toFixed(1)} ms (${list.filter((s) => !s.stub).length} listed + ${list.filter((s) => s.stub).length} stubs, the largest ${biggest(list)} B): ${(side.bytes / plain.bytes * 100).toFixed(1)}% of the bytes`);
  assert.equal(list.length, 100, 'every conversation is accounted for');
  assert.ok(side.bytes < plain.bytes * 0.2, `the sidebar's list is under a fifth of the plain list (${side.bytes} of ${plain.bytes})`);
  assert.ok(biggest(list) < biggest(plainList) / 3, 'and its biggest entry is a fraction of the plain list\'s biggest');
  const m = await measure('/api/machines');
  const ms = await measure('/api/machines?for=sidebar');
  console.log(`PERF GET /api/machines: plain ${m.bytes} B ${m.ms.toFixed(1)} ms; ?for=sidebar ${ms.bytes} B ${ms.ms.toFixed(1)} ms`);
  assert.ok(ms.bytes < m.bytes * 0.8, 'without the workers\' 60 conversations of the 200 the computers list');
});
