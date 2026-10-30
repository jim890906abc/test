// What the page does with the Hub's slim messages (public/js/page-sync.js), tested
// directly in node on the module the page loads: a computer's patch and a
// cluster rebuilt from a whole one and its patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchMachine, createClusterSync } from '../public/js/page-sync.js';

const m1 = (sessions = [], over = {}) => ({ id: 'm1', name: 'box', online: true, kimi: { available: true }, sessions, ...over });
const ent = (id, over = {}) => ({ id, title: id, updatedAt: 1, ...over });

test('a machine patch: an entry that changed is replaced where it is, a new one goes first, a gone one goes, the computer\'s own fields are replaced only if sent', () => {
  const machines = [m1([ent('a'), ent('b'), ent('c')])];
  const r = patchMachine(machines, { id: 'm1', upsert: [ent('b', { title: 'B!' }), ent('d')], remove: ['c'] });
  assert.deepEqual(r.machine.sessions.map((e) => [e.id, e.title]), [['d', 'd'], ['a', 'a'], ['b', 'B!']]);
  assert.equal(r.machine.name, 'box', 'without a `machine` the computer\'s own fields stay');
  assert.equal(r.before, machines[0]);
  assert.deepEqual(machines[0].sessions.map((e) => e.id), ['a', 'b', 'c'], 'the machines it was given are not changed');
  const renamed = patchMachine(machines, { id: 'm1', machine: m1([], { online: false, name: 'box2' }), upsert: [], remove: ['a', 'b', 'c'] });
  assert.deepEqual([renamed.machine.online, renamed.machine.name, renamed.machine.sessions], [false, 'box2', []]);
  assert.equal(patchMachine(machines, { id: 'nobody', upsert: [], remove: [] }), null, 'a computer the page does not have: it must ask');
});

test('a cluster is rebuilt from a whole one and its patches, keeps its own copy, and says when it never had the cluster', () => {
  const sync = createClusterSync();
  const whole = { id: 'c_1', workers: [{ sessionId: 'w1', status: 'running' }], n: 1 };
  assert.equal(sync.whole(whole), whole, 'the page gets the very object the Hub sent');
  whole.workers[0].status = 'changed by the page'; // the page may do what it likes with it
  const next = sync.patch({ id: 'c_1', patch: { o: { n: { s: 2 } } } });
  assert.deepEqual(next, { id: 'c_1', workers: [{ sessionId: 'w1', status: 'running' }], n: 2 }, 'the patch applies to what the Hub sent, not to what the page did to it');
  next.n = 99;
  assert.equal(sync.patch({ id: 'c_1', patch: { o: { workers: { a: { 0: { o: { status: { s: 'done' } } } }, l: 1 } } } }).n, 2);
  assert.equal(sync.patch({ id: 'c_unknown', patch: { o: {} } }), null);
  assert.equal(sync.patch({ id: 'c_1' }), null, 'a message with no patch is not applied');
});
