// A page that keeps the slim forms (machine and cluster pushes as patches, listed
// summaries, no worker summaries) and a page that does not, against one REAL Hub
// with the same things happening: whatever the slim page is told, it must end up
// knowing exactly what the plain one says.
//
// The Hub is the synthetic one of test/fixtures/perf-hub.mjs (conversations and
// cluster workers on disk, two fake computers speaking the bridge protocol, the
// connector's request records for the workers' speeds), small here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startPerfHub, runWorkload, pushNatives, sleep } from './fixtures/perf-hub.mjs';
import { patchMachine, createClusterSync } from '../public/js/page-sync.js';

let hub;
before(async () => {
  hub = await startPerfHub({ conversations: 30, workers: 20, perCluster: 5, activeClusters: 2, machines: 2, native: 30 });
});
after(() => hub?.stop());

// A page reduced to its socket: every message in order, bundles unpacked.
function page({ slim, watch }) {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws?token=none`);
  const p = { msgs: [], bytes: 0, ws, close: () => ws.close() };
  ws.on('message', (d) => {
    p.bytes += d.length;
    const m = JSON.parse(d);
    for (const x of m.t === 'batch' ? m.items : [m]) p.msgs.push(x);
  });
  p.ready = new Promise((r) => ws.on('open', () => (ws.send(JSON.stringify({ t: 'watch', sid: watch ?? null, ...(slim ? { slim: 1 } : {}) })), r())));
  return p;
}
const kinds = (p) => p.msgs.map((m) => m.t);
const workerIds = () => new Set(hub.made.workers.map((w) => w.id));
const workerNatives = () => new Set(hub.made.workers.map((w) => w.kimiSessionId));

test('under the same events a slim page ends knowing what a plain page knows, from patches', async () => {
  const slim = page({ slim: true });
  const plain = page({ slim: false });
  await Promise.all([slim.ready, plain.ready]);
  // The slim page starts from the lists it just read, as app.js does.
  const startMachines = await hub.api('GET', '/machines?for=sidebar');
  let machines = structuredClone(startMachines);
  const sync = createClusterSync();
  // Prime: the first push of each computer and cluster is whole; what follows is what is measured.
  for (const m of hub.computers) pushNatives(m);
  await sleep(300);
  slim.msgs.length = plain.msgs.length = 0;
  await runWorkload(hub, { seconds: 8 });
  await sleep(1500);

  // ---- machines: apply the slim page's messages, compare with the plain page's last word on each computer
  for (const m of slim.msgs) {
    if (m.t === 'machine') machines = [...machines.filter((x) => x.id !== m.machine.id), m.machine];
    if (m.t === 'machine.patch') {
      const r = patchMachine(machines, m);
      assert.ok(r, 'the slim page has the computer a patch is about');
      machines = machines.map((x) => (x.id === r.machine.id ? r.machine : x));
    }
  }
  const gone = workerNatives();
  const lastPlain = (id) => plain.msgs.filter((m) => m.t === 'machine' && m.machine.id === id).at(-1)?.machine;
  for (const m of machines) {
    const want = lastPlain(m.id);
    assert.ok(want, `the plain page was told about ${m.id}`);
    const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    // (An online computer's lastSeen is not shown by any page, so the slim page may hold an older one.)
    const shown = (x, sessions) => ({ ...x, lastSeen: x.online ? 'not shown' : x.lastSeen, sessions: byId(sessions) });
    assert.deepEqual(shown(m, m.sessions), shown(want, want.sessions.filter((e) => !gone.has(e.id))), `${m.id}: the slim page knows what the plain page does, minus the workers' conversations`);
  }
  assert.ok(slim.msgs.some((m) => m.t === 'machine.patch'), 'the slim page was sent patches');
  assert.ok(!slim.msgs.some((m) => m.t === 'machine' && m.machine.sessions.some((e) => gone.has(e.id))));

  // ---- clusters: a whole one, then patches, against the plain page's last word on each
  const rebuilt = new Map();
  for (const m of slim.msgs) {
    if (m.t === 'cluster') rebuilt.set(m.cluster.id, sync.whole(structuredClone(m.cluster)));
    if (m.t === 'cluster.patch') {
      const c = sync.patch(m);
      assert.ok(c, `the slim page had cluster ${m.id} whole before its patch`);
      rebuilt.set(m.id, c);
    }
  }
  assert.ok(rebuilt.size >= 2, 'the clusters at work were pushed');
  for (const [id, c] of rebuilt) assert.deepEqual(c, plain.msgs.filter((m) => m.t === 'cluster' && m.cluster.id === id).at(-1).cluster, `cluster ${id}`);
  assert.ok(slim.msgs.some((m) => m.t === 'cluster.patch'));

  // ---- summaries: the plain page hears of the workers, the slim page does not (it would not show them)
  const heardOf = (p) => new Set(p.msgs.filter((m) => m.t === 'session').map((m) => m.session.id));
  assert.ok([...heardOf(plain)].some((id) => workerIds().has(id)), 'control: the workers\' summaries are pushed to a plain page');
  assert.ok(![...heardOf(slim)].some((id) => workerIds().has(id)), 'a slim page that does not show a worker is not sent its summary');
  assert.ok(slim.bytes < plain.bytes / 3, `and the slim page was sent a fraction of the bytes (${slim.bytes} against ${plain.bytes})`);
  slim.close();
  plain.close();
});

test('a plain page is still told every computer message whole, even when nothing changed; a page that never said what it shows too', async () => {
  const plain = page({ slim: false });
  await plain.ready;
  const old = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws?token=none`);
    const msgs = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      for (const x of m.t === 'batch' ? m.items : [m]) msgs.push(x);
    });
    ws.on('open', () => resolve({ ws, msgs }));
  });
  await sleep(200);
  for (let i = 0; i < 3; i++) {
    pushNatives(hub.computers[0]); // the same list again
    await sleep(200);
  }
  await sleep(300);
  for (const p of [plain, old]) {
    const mine = p.msgs.filter((m) => m.t === 'machine' && m.machine.id === hub.computers[0].id);
    assert.equal(mine.length, 3, 'one whole message per report, changed or not');
    assert.ok(mine.every((m) => m.machine.sessions.some((e) => workerNatives().has(e.id))), 'with the workers\' conversations, as ever');
  }
  plain.close();
  old.ws.close();
});

test('a page that shows a worker is sent its summary whole, and the others\' stay listed', async () => {
  const worker = hub.made.workers[0];
  const watcher = page({ slim: true, watch: worker.id });
  const other = page({ slim: true });
  await Promise.all([watcher.ready, other.ready]);
  await sleep(500);
  watcher.msgs.length = other.msgs.length = 0;
  await hub.api('PATCH', `/sessions/${worker.id}`, { title: '被看著的工作者' });
  const main = hub.made.mains[0];
  await hub.api('PATCH', `/sessions/${main.id}`, { title: '一般對話改名' });
  await sleep(600);
  const got = watcher.msgs.filter((m) => m.t === 'session' && m.session.id === worker.id);
  assert.equal(got.length, 1);
  assert.equal(got[0].session.title, '被看著的工作者');
  assert.ok(got[0].session.meta.models.length > 0 && !got[0].session.slim, 'whole');
  assert.equal(other.msgs.filter((m) => m.t === 'session' && m.session.id === worker.id).length, 0);
  const listed = other.msgs.find((m) => m.t === 'session' && m.session.id === main.id);
  assert.ok(listed, 'an ordinary conversation is still pushed');
  assert.equal(listed.session.slim, true);
  assert.equal(listed.session.meta.models, undefined);
  assert.equal(listed.session.title, '一般對話改名');
  assert.equal(watcher.msgs.find((m) => m.t === 'session' && m.session.id === main.id)?.session.slim, true, 'a page that shows the worker is sent the other conversations listed, like any page');
  watcher.close();
  other.close();
});
