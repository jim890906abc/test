// The workers of clusters in the sidebar and the listed form of a summary
// (public/js/list-form.js, sidebar-model.js), tested directly in node on the
// modules the page loads: the stubs a cluster's workers are kept as, how a
// cluster's news keeps them current, what the list leaves out of a summary, and
// how the workers are counted and searched instead of listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listForm, workerStub, isClusterWorker, mergeWhole, syncWorkers, OMITTED_FROM_LIST } from '../public/js/list-form.js';
import { buildRows, splitWorkers, workersLine, sidebarSections } from '../public/js/sidebar-model.js';

const cluster = (workers) => ({ id: 'c_1', parentId: 's_p', workers });
const wk = (id, over = {}) => ({ sessionId: id, title: `工作者 ${id}`, status: 'running', hidden: false, subagentCounts: { awaiting: 0 }, ...over });

test('a cluster\'s workers keep the sidebar\'s stubs current: status, title, a subagent that waits for you, hidden, new, deleted', () => {
  const stubs = new Map([['w1', workerStub({ id: 'w1', title: 'old', status: 'running', cwd: '/p', clusterId: 'c_1', provider: 'deepseek', updatedAt: 5 })]]);
  assert.equal(syncWorkers(stubs, cluster([wk('w1', { title: 'old' })]), { now: 9 }), false, 'nothing moved');
  assert.equal(stubs.get('w1').updatedAt, 5);
  assert.equal(syncWorkers(stubs, cluster([wk('w1', { title: 'old', status: 'awaiting_permission' })]), { now: 10 }), true);
  assert.deepEqual([stubs.get('w1').status, stubs.get('w1').updatedAt, stubs.get('w1').provider], ['awaiting_permission', 10, 'deepseek']);
  syncWorkers(stubs, cluster([wk('w1', { title: 'old', subagentCounts: { awaiting: 2 } })]), { now: 11 });
  assert.equal(stubs.get('w1').pendingChildPermission, true);
  syncWorkers(stubs, cluster([wk('w1', { title: 'new', hidden: true })]), { now: 12 });
  assert.deepEqual([stubs.get('w1').title, stubs.get('w1').clusterHidden, stubs.get('w1').pendingChildPermission], ['new', true, false]);
  // A worker the page has not heard of takes the computer and folder of the conversation that dispatched the cluster.
  syncWorkers(stubs, cluster([wk('w2')]), { parent: { cwd: '/proj', machineId: 'm1', agentId: 'kimi@m1', provider: 'deepseek' }, now: 13 });
  assert.deepEqual([stubs.get('w2').cwd, stubs.get('w2').machineId, stubs.get('w2').clusterRole, stubs.get('w2').stub], ['/proj', 'm1', 'worker', true]);
  assert.equal(syncWorkers(stubs, cluster([wk('w2', { status: 'deleted' })])), true);
  assert.equal(stubs.has('w2'), false, 'a worker whose conversation was deleted is gone');
});

const NOWS = 1_700_000_000_000;
const hub = (id, patch = {}) => ({ id, conversationId: id, title: id, status: 'idle', origin: 'hub', provider: 'kimi', updatedAt: NOWS, continuedFrom: null, continuedTo: null, meta: {}, ...patch });
const stub = (id, patch = {}) => workerStub(hub(id, { clusterId: 'c_1', clusterRole: 'worker', agentId: 'kimi@m1', machineId: 'm1', ...patch }));

test('the workers are rows of the model but not of the list: counted, found by a search by name, and a worker that waits for you is still seen', () => {
  const sessions = [hub('main', { updatedAt: NOWS + 5 }), stub('w1', { title: '改設定檔', status: 'running', updatedAt: NOWS + 4 }), stub('w2', { title: '寫測試', status: 'awaiting_permission', updatedAt: NOWS + 3 }), stub('w3', { title: '舊的', clusterHidden: true })];
  const rows = buildRows({ sessions, machines: [{ id: 'm1', name: 'box', online: true, kimi: { available: true }, sessions: [] }] });
  assert.deepEqual(rows.map((r) => r.hub.id), ['main', 'w1', 'w2'], 'the model has the workers (hidden ones apart): the attention check reads these');
  const plain = splitWorkers(rows, { query: '' });
  assert.deepEqual(plain.listed.map((r) => r.hub.id), ['main']);
  assert.deepEqual(plain.workers.map((r) => r.hub.id), ['w1', 'w2']);
  const line = workersLine(plain.workers);
  assert.deepEqual([line.count, line.working, line.needsYou, line.title], [2, 2, true, '叢集工作者 2 個']);
  assert.equal(workersLine([]), null, 'no workers, no line');
  // The worker that is open is listed like any open conversation, so the page shows where it is.
  const open = splitWorkers(rows, { query: '', currentId: 'w2' });
  assert.deepEqual(open.listed.map((r) => r.hub.id), ['main', 'w2']);
  assert.deepEqual(open.workers.map((r) => r.hub.id), ['w1', 'w2'], 'and it is still one of the workers');
  // A search lists them with the rest and the section code finds them by name.
  const searching = splitWorkers(rows, { query: '測試' });
  assert.equal(searching.listed.length, 3);
  const { list } = sidebarSections(searching.listed, { query: '測試' });
  assert.deepEqual(list.map((r) => r.hub.id), ['w2']);
  assert.equal(list[0].hub.clusterRole, 'worker', 'and the row can say it is a worker');
});

test('a worker stub is enough for a row: its provider tag, its link and its status', () => {
  const s = stub('w1', { provider: 'deepseek', mode: 'deepseek', nextProvider: 'deepseek', status: 'running' });
  const [row] = buildRows({ sessions: [s], machines: [] });
  assert.deepEqual([row.provider, row.status, row.conversationId, row.hub.id, row.origin], ['deepseek', 'running', 'w1', 'w1', 'hub']);
});

test('a listed summary leaves out the model and skill lists, the queue and the to-do list, marks itself, and keeps what a row reads', () => {
  const full = { id: 's1', title: 't', status: 'idle', meta: { models: [1], skills: [2], queue: [3], todos: [4], owner: 'tui', machineName: 'box', salvaged: { x: 1 }, tps: 3, budget: 5, permission: 'auto' }, usage: { a: 1 } };
  const listed = listForm(full);
  assert.deepEqual(Object.keys(listed.meta).sort(), ['budget', 'machineName', 'owner', 'permission', 'salvaged', 'tps']);
  assert.equal(listed.slim, true);
  assert.deepEqual(OMITTED_FROM_LIST.sort(), ['models', 'queue', 'skills', 'todos']);
  assert.ok(full.meta.models, 'the summary it was made from is untouched');
  assert.equal(listForm(listed), listed, 'a listed summary is already listed');
  assert.equal(listForm(null), null);
  assert.equal(listForm({ id: 'x', meta: null }).meta, null);
  assert.equal(isClusterWorker({ clusterRole: 'worker' }), true);
  assert.equal(isClusterWorker({ clusterRole: null }), false);
});

test('a worker that went on in a new node of its chain is one stub: the cluster names the first node, the list has the leaf', () => {
  const stubs = new Map([['w1b', workerStub({ id: 'w1b', conversationId: 'w1', title: 'first', status: 'running', clusterId: 'c_1', kimiSessionId: 'k_b' })]]);
  assert.equal(syncWorkers(stubs, cluster([wk('w1', { title: 'first', status: 'awaiting_permission' })]), { now: 7 }), true);
  assert.deepEqual([...stubs.keys()], ['w1b'], 'no second stub for the same conversation');
  assert.equal(stubs.get('w1b').status, 'awaiting_permission');
  assert.equal(syncWorkers(stubs, cluster([wk('w1', { status: 'deleted' })])), true);
  assert.equal(stubs.size, 0);
});

test('a list read again keeps the heavy parts of the conversation that is open: what the page already holds whole is not made listed by a refresh', () => {
  const whole = { id: 's1', status: 'idle', meta: { owner: 'x', models: [1, 2], skills: [3], queue: [{ text: 'q' }], todos: [{ title: 't' }] } };
  const fresh = listForm({ id: 's1', status: 'running', meta: { owner: 'y', models: [], skills: [] } });
  const merged = mergeWhole(fresh, whole);
  assert.equal(merged.status, 'running', 'the fresh word wins');
  assert.equal(merged.meta.owner, 'y');
  assert.deepEqual([merged.meta.models, merged.meta.skills, merged.meta.queue, merged.meta.todos], [[1, 2], [3], [{ text: 'q' }], [{ title: 't' }]], 'and the lists the list left out come from what the page holds');
  assert.equal(merged.slim, undefined, 'so it is whole again');
  assert.equal(mergeWhole(fresh, listForm(whole)), fresh, 'nothing to keep from a listed one');
  assert.equal(mergeWhole(fresh, null), fresh);
  assert.equal(mergeWhole(fresh, { id: 'other', meta: { models: [9] } }), fresh, 'and only for the same conversation');
});
