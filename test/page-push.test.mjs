// What a page that keeps the slim forms is sent (server/page-push.js), tried on
// its own with stand-in sockets: the first message of a computer, a cluster or a
// summary is whole; after that only what changed; nothing when nothing did; and
// a page that applies those messages the way app.js does (public/js/page-sync.js)
// ends with exactly what the Hub has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, forgetSession } from '../server/page-push.js';
import { patchMachine, createClusterSync } from '../public/js/page-sync.js';

const workers = new Set(['nat_w1', 'nat_w2']);
const deps = {
  isWorkerNative: (_m, id) => workers.has(id),
  sidebarView: (pub) => ({ ...pub, sessions: pub.sessions.filter((e) => !workers.has(e.id)) }),
};
const entry = (id, over = {}) => ({ id, title: `conv ${id}`, cwd: '/p', busy: false, pending: 'none', updatedAt: 1000, owner: null, hubSessionId: `s_${id}`, isLeaf: true, ...over });
const machine = (sessions, over = {}) => ({ id: 'm1', name: 'box', online: true, lastSeen: 1, kimi: { available: true }, capabilities: ['pool'], sessions, ...over });
const socket = (over = {}) => ({ readyState: 1, watch: null, slim: true, ...over });
// What the Hub's broadcast does for one slim page: the texts, parsed.
const send = (ws, msg) => {
  const way = prepare(msg, deps);
  assert.ok(way, `${msg.t} has a slim way`);
  const text = JSON.stringify(msg);
  return way.deliver(ws, () => text).map((t) => JSON.parse(t));
};

test('a computer: whole the first time (without the cluster workers\' conversations), then only what changed, and nothing when nothing did', () => {
  const ws = socket();
  const list = [entry('a'), entry('b'), entry('nat_w1'), entry('c')];
  const first = send(ws, { t: 'machine', machine: machine(list) });
  assert.equal(first.length, 1);
  assert.equal(first[0].t, 'machine');
  assert.deepEqual(first[0].machine.sessions.map((e) => e.id), ['a', 'b', 'c'], 'a worker\'s conversation is not a row of the sidebar');
  assert.deepEqual(send(ws, { t: 'machine', machine: machine(list) }), [], 'the same again: nothing');

  const changed = [entry('a'), entry('b', { busy: true, updatedAt: 2000 }), entry('nat_w1', { busy: true }), entry('c')];
  const patch = send(ws, { t: 'machine', machine: machine(changed) });
  assert.equal(patch.length, 1);
  assert.equal(patch[0].t, 'machine.patch');
  assert.equal(patch[0].machine, undefined, 'the computer\'s own fields did not move');
  assert.deepEqual(patch[0].upsert.map((e) => e.id), ['b'], 'only the entry that changed (a worker\'s change is nobody\'s business)');
  assert.deepEqual(patch[0].remove, []);

  const gone = send(ws, { t: 'machine', machine: machine([entry('a'), entry('d'), entry('b', { busy: true, updatedAt: 2000 })]) });
  assert.deepEqual(gone[0].upsert.map((e) => e.id), ['d']);
  assert.deepEqual(gone[0].remove, ['c']);

  const offline = send(ws, { t: 'machine', machine: machine([], { online: false }) });
  assert.equal(offline[0].machine.online, false, 'a field of the computer itself that moved is sent');
  assert.deepEqual(offline[0].remove.sort(), ['a', 'b', 'd']);
});

test('an online computer\'s lastSeen alone is not news; an offline one\'s is (the page shows when it was last seen)', () => {
  const ws = socket();
  send(ws, { t: 'machine', machine: machine([entry('a')], { lastSeen: 100 }) });
  assert.deepEqual(send(ws, { t: 'machine', machine: machine([entry('a')], { lastSeen: 200 }) }), [], 'online: lastSeen is not shown');
  const off = send(ws, { t: 'machine', machine: machine([], { online: false, lastSeen: 300 }) });
  assert.equal(off[0].machine.lastSeen, 300);
  assert.deepEqual(send(ws, { t: 'machine', machine: machine([], { online: false, lastSeen: 400 }) })[0]?.machine?.lastSeen, 400, 'offline: it is');
});

test('a page that applies the messages ends with the computer the Hub has, over many changes', () => {
  const ws = socket();
  let page = [];
  let hub;
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  let list = ids.slice(0, 10).map((id) => entry(id));
  for (let step = 0; step < 200; step++) {
    // Something happens: entries change, come, go; the computer goes offline and back.
    for (let k = Math.floor(rnd() * 4); k > 0; k--) {
      const id = ids[Math.floor(rnd() * ids.length)];
      const at = list.findIndex((e) => e.id === id);
      const r = rnd();
      if (r < 0.4 && at !== -1) list[at] = { ...list[at], busy: !list[at].busy, updatedAt: list[at].updatedAt + 1 };
      else if (r < 0.7 && at === -1) list.unshift(entry(id));
      else if (at !== -1) list.splice(at, 1);
    }
    hub = machine(structuredClone(list), { online: rnd() > 0.1, lastSeen: step });
    if (!hub.online) hub.sessions = [];
    for (const m of send(ws, { t: 'machine', machine: hub })) {
      if (m.t === 'machine') page = [m.machine];
      else {
        const r = patchMachine(page, m);
        assert.ok(r, 'the page has the computer');
        page = [r.machine];
      }
    }
    if (!hub.online) list = []; // an offline computer lists nothing; what it had is gone
    const byId = (x) => [...x.sessions].sort((a, b) => a.id.localeCompare(b.id));
    // (An online computer's lastSeen is not shown, so a page may hold an older one; an offline one's is.)
    const shown = (m) => ({ ...m, lastSeen: m.online ? 'not shown' : m.lastSeen, sessions: byId(m) });
    assert.deepEqual(shown(page[0]), shown(hub), `step ${step}`);
  }
});

test('a kimi.session for a worker\'s conversation is not sent; one for another is, and the next report of the computer does not repeat it', () => {
  const ws = socket();
  send(ws, { t: 'machine', machine: machine([entry('a')]) });
  assert.deepEqual(send(ws, { t: 'kimi.session', machineId: 'm1', session: entry('nat_w1', { busy: true }) }), []);
  const b = entry('b', { busy: true });
  assert.equal(send(ws, { t: 'kimi.session', machineId: 'm1', session: b }).length, 1);
  const next = send(ws, { t: 'machine', machine: machine([entry('a'), b]) });
  assert.deepEqual(next, [], 'the page already has b from the kimi.session');
  assert.equal(send(ws, { t: 'kimi.session', machineId: 'm1', id: 'b', removed: true }).length, 1);
  const after = send(ws, { t: 'machine', machine: machine([entry('a')]) });
  assert.deepEqual(after, [], 'and b is gone from what the Hub thinks the page has');
});

test('two pages are told apart: what one was sent says nothing about what the other has', () => {
  const a = socket();
  const b = socket();
  send(a, { t: 'machine', machine: machine([entry('x')]) });
  send(b, { t: 'machine', machine: machine([entry('x')]) });
  // Only page A hears of y by a kimi.session.
  send(a, { t: 'kimi.session', machineId: 'm1', session: entry('y') });
  const next = machine([entry('x'), entry('y')]);
  assert.deepEqual(send(a, { t: 'machine', machine: next }), [], 'A has y');
  const forB = send(b, { t: 'machine', machine: next });
  assert.deepEqual(forB[0].upsert.map((e) => e.id), ['y'], 'B does not, and is told');
});

test('a "machines" message makes the page ask again, so the next computer message is whole', () => {
  const ws = socket();
  send(ws, { t: 'machine', machine: machine([entry('a')]) });
  assert.equal(send(ws, { t: 'machines' }).length, 1);
  assert.equal(send(ws, { t: 'machine', machine: machine([entry('a')]) })[0].t, 'machine');
});

const cluster = (over = {}) => ({
  id: 'c_1', parentId: 's_p', status: 'running', createdAt: 1,
  throughput: { windowMs: 60000, outTokens: 100, tokensPerSecond: 1.7, workersCounted: 3 },
  workers: Array.from({ length: 6 }, (_, i) => ({ sessionId: `w${i}`, title: `工作者 ${i}`, task: 'x'.repeat(300), status: 'running', progress: '▸ 做事', speed: { windowMs: 300000, outTokens: 50 * i, requests: i }, subagents: [], subagentCounts: { total: 0, awaiting: 0 }, hidden: false })),
  tasks: [], memory: { path: '/m.md', bytes: 10 }, ...over,
});

test('a cluster: whole the first time, nothing if it did not change, then the difference - and a page that applies it has the cluster the Hub has', () => {
  const ws = socket();
  const sync = createClusterSync();
  const c1 = cluster();
  const first = send(ws, { t: 'cluster', cluster: c1 });
  assert.equal(first[0].t, 'cluster');
  assert.deepEqual(sync.whole(first[0].cluster), c1);
  assert.deepEqual(send(ws, { t: 'cluster', cluster: structuredClone(c1) }), []);

  const c2 = structuredClone(c1);
  c2.throughput.windowMs = 61000;
  c2.workers[3].speed.requests = 9;
  c2.workers[3].progress = '▸ 另一件事';
  const second = send(ws, { t: 'cluster', cluster: c2 });
  assert.equal(second[0].t, 'cluster.patch');
  assert.ok(JSON.stringify(second[0]).length < JSON.stringify({ t: 'cluster', cluster: c2 }).length / 5, 'a small part of the cluster');
  assert.deepEqual(sync.patch(second[0]), c2);

  // A worker joins, a task appears, a field goes away.
  const c3 = structuredClone(c2);
  c3.workers.push({ ...c3.workers[0], sessionId: 'w6' });
  c3.tasks.push({ index: 0, title: 't', status: 'pending' });
  delete c3.memory.bytes;
  const third = send(ws, { t: 'cluster', cluster: c3 });
  assert.deepEqual(sync.patch(third[0]), c3);

  // A page that never got this cluster whole cannot apply a patch.
  assert.equal(createClusterSync().patch(third[0]), null);
  // Another page is unaffected by what this one was sent.
  assert.equal(send(socket(), { t: 'cluster', cluster: c3 })[0].t, 'cluster');
});

test('a cluster page never gets a patch bigger than the cluster', () => {
  const ws = socket();
  send(ws, { t: 'cluster', cluster: cluster({ workers: [] }) });
  const different = cluster({ status: 'done', workers: Array.from({ length: 2 }, (_, i) => ({ sessionId: `n${i}` })), memory: { x: 1 }, tasks: [{ a: 1 }], throughput: null });
  const [m] = send(ws, { t: 'cluster', cluster: different });
  assert.ok(JSON.stringify(m).length <= JSON.stringify({ t: 'cluster', cluster: different }).length + 40);
});

const summary = (id, over = {}) => ({ id, title: id, status: 'idle', clusterRole: null, updatedAt: 1, meta: { owner: 'x', models: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` })), skills: [{ name: 's' }], queue: [{ text: 'q' }], todos: [{ title: 't' }], tps: 5 }, ...over });

test('a summary: the whole one only to the page that shows that conversation, the listed one to the others, the same one twice in a row once', () => {
  const watching = socket({ watch: 's1' });
  const idle = socket();
  const m = { t: 'session', session: summary('s1') };
  const [whole] = send(watching, m);
  assert.ok(whole.session.meta.models, 'the open conversation gets everything');
  assert.equal(whole.session.slim, undefined);
  const [listed] = send(idle, m);
  assert.equal(listed.session.slim, true);
  assert.equal(listed.session.meta.models, undefined);
  assert.equal(listed.session.meta.queue, undefined);
  assert.equal(listed.session.meta.todos, undefined);
  assert.equal(listed.session.meta.owner, 'x', 'what the sidebar reads stays');
  assert.equal(listed.session.meta.tps, 5);
  assert.ok(JSON.stringify(listed).length < JSON.stringify(whole).length, 'and it is smaller');
  assert.deepEqual(send(idle, m), [], 'the same again: nothing');
  assert.deepEqual(send(watching, m), []);
  // It changes: sent again.
  assert.equal(send(idle, { t: 'session', session: summary('s1', { status: 'running' }) }).length, 1);
  // The page opened the conversation: what it was sent before says nothing about what it holds now.
  forgetSession(idle, 's1');
  assert.equal(send(idle, { t: 'session', session: summary('s1', { status: 'running' }) }).length, 1);
});

test('a cluster worker\'s summary goes only to the page that shows that worker', () => {
  const m = { t: 'session', session: summary('w1', { clusterRole: 'worker' }) };
  assert.deepEqual(send(socket(), m), []);
  assert.deepEqual(send(socket({ watch: 's_other' }), m), []);
  const [got] = send(socket({ watch: 'w1' }), m);
  assert.equal(got.session.id, 'w1');
  assert.ok(got.session.meta.models, 'whole');
});

test('what has no slim form goes as it is', () => {
  for (const msg of [{ t: 'claude', account: {} }, { t: 'deepseek' }, { t: 'agents' }, { t: 'deleted', sid: 'x' }, { t: 'machine' }, { t: 'cluster' }]) assert.equal(prepare(msg, deps), null, msg.t);
});

test('the memory of what a page was sent is bounded', () => {
  const ws = socket();
  for (let i = 0; i < 1500; i++) send(ws, { t: 'session', session: summary(`s${i}`) });
  assert.ok(ws.sent.sessions.size <= 400);
});
