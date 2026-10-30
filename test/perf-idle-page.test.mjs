// What the Hub sends to a page that is only open, with a Hub shaped like the VPS
// one that was slow on 2026-10-30 (made up and repeatable: test/fixtures/perf-hub.mjs):
// 100 conversations of which 60 are workers of 12 clusters (8 at work), two
// computers that each report 100 Kimi conversations.
//
// What a page that watches nothing is sent in 15 seconds while eight clusters
// work (one worker touched and a few request records a second, a computer
// reporting again every other second): a plain page (every message whole, the
// way every page was sent them) and a slim page, side by side on the same Hub in
// the same run, so the ratio holds on any machine. The figures are printed
// (PERF lines) to keep next to the ones before them.
//
//   2026-10-30, this machine:
//     before (the plain page's figures are the old Hub's):  388-397 KB of messages (46 KB on the wire):
//                                              machine 7 x = 224-229 KB, cluster 15 x = 73-75 KB, session 15 x = 91-93 KB
//     with the slim forms:                     11.9 KB of messages (12.0 KB on the wire), 3.1%: cluster.patch 15 x = 6.6 KB, machine.patch 7 x = 5.3 KB
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startPerfHub, runWorkload, pushNatives, sleep } from './fixtures/perf-hub.mjs';

let hub;
before(async () => {
  hub = await startPerfHub({ conversations: 100, workers: 60, perCluster: 5, activeClusters: 8, machines: 2, native: 100 });
});
after(() => hub?.stop());

function page({ slim }) {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws?token=none`);
  const p = { by: {}, count: 0, bytes: 0, wire0: 0, ws, counting: false };
  ws.on('message', (d) => {
    if (!p.counting) return;
    const m = JSON.parse(d);
    for (const x of m.t === 'batch' ? m.items : [m]) {
      const n = Buffer.byteLength(JSON.stringify(x));
      const k = (p.by[x.t] ||= { n: 0, bytes: 0 });
      k.n++;
      k.bytes += n;
      p.bytes += n;
    }
  });
  p.ready = new Promise((r) => ws.on('open', () => (ws.send(JSON.stringify({ t: 'watch', sid: null, ...(slim ? { slim: 1 } : {}) })), r())));
  p.start = () => ((p.counting = true), (p.wire0 = ws._socket.bytesRead));
  p.wire = () => ws._socket.bytesRead - p.wire0;
  return p;
}
const show = (p) => Object.entries(p.by).map(([t, k]) => `${t} ${k.n}x=${(k.bytes / 1024).toFixed(1)}KB`).join(', ');

test('a page that shows nothing is sent a fraction of the bytes in 15 seconds while eight clusters work', async () => {
  const plain = page({ slim: false });
  const slim = page({ slim: true });
  await Promise.all([plain.ready, slim.ready]);
  // Both pages have been told the state once (the first message of a computer or a cluster is whole for a slim page); what follows is the 15 seconds.
  for (const m of hub.computers) pushNatives(m);
  hub.feedRequests(hub.made.workers.filter((w) => w.status === 'running'), 1);
  await sleep(2500);
  plain.start();
  slim.start();
  await runWorkload(hub, { seconds: 15 });
  await sleep(500);
  console.log(`PERF an open page, 15 s: plain ${(plain.bytes / 1024).toFixed(1)} KB of messages (${(plain.wire() / 1024).toFixed(1)} KB on the wire): ${show(plain)}`);
  console.log(`PERF an open page, 15 s: slim  ${(slim.bytes / 1024).toFixed(1)} KB of messages (${(slim.wire() / 1024).toFixed(1)} KB on the wire): ${show(slim)}   -> ${(slim.bytes / plain.bytes * 100).toFixed(1)}% of the bytes`);
  assert.ok(plain.by.machine.n >= 6 && plain.by.cluster.n >= 10 && plain.by.session.n >= 10, 'the workload makes the messages the VPS showed');
  assert.ok(slim.bytes < plain.bytes * 0.25, `a slim page is sent under a quarter of the bytes (${slim.bytes} of ${plain.bytes})`);
  assert.ok(slim.wire() < plain.wire(), 'and fewer on the wire as well');
  plain.ws.close();
  slim.ws.close();
});
