// A cluster has a name of its own. The owner (2026-10-30): "I named none of my
// clusters 'VPS框架開發', yet every one of them shows that" - the overview and the
// cluster page printed the main conversation's title, so every cluster sent from
// one conversation read the same. What must hold: the name is the cluster's
// (given, or made from its tasks), the main conversation is a small line under
// it (or says it is gone), an old cluster with no name gets one made the same
// way and keeps it, and the person can rename it from the cluster page.
//
// Through the REAL Hub process (server/index.js); only the Kimi of the computer
// is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { autoClusterName, cleanClusterName, CLUSTER_NAME_MAX } from '../public/js/cluster-model.js';

const MID = 'm_fake';
let hub;
let KIMI;
const hubs = [];

// (`title` is set the way a person does: /title.)
async function newKimi(h, { title, ...extra } = {}) {
  const s = await h.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: path.join(h.TMP, 'proj'), model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
  if (title) await h.api('POST', `/sessions/${s.id}/command`, { name: 'title', args: title });
  return s;
}
const cluster = (h, id, body) => h.api('POST', `/sessions/${id}/cluster`, body);
const tasks = (...titles) => titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` }));
const rejects = async (promise, status, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected a ${status}, got success`);
  assert.equal(err.status, status, `${err.message}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
};
const rowOf = async (h, cid) => (await h.api('GET', '/clusters')).find((r) => r.id === cid);
const done = (h, cid) => until(async () => (await h.api('GET', `/clusters/${cid}`)).status === 'done', 15000, `cluster ${cid} done`);

function watchWs(h) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.PORT}/ws`);
  const msgs = [];
  ws.on('message', (d) => {
    try {
      msgs.push(JSON.parse(d));
    } catch {}
  });
  return { msgs, ready: new Promise((r) => ws.on('open', r)), close: () => ws.close() };
}

before(async () => {
  hub = await startRealHub('cluster-name', { claude: true });
  hubs.push(hub);
  await hub.setDeepseekKey();
  fs.mkdirSync(path.join(hub.TMP, 'proj'), { recursive: true });
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
});
after(async () => {
  for (const h of hubs.reverse()) await h.stop();
});

// ------------------------------------------------------------- the rule

test('the name made from the tasks: one task is named after it; several after the first (cut to about 24 characters) and how many there are', () => {
  assert.equal(autoClusterName([{ title: '修登入' }]), '修登入');
  assert.equal(autoClusterName([{ title: '修登入' }, { title: '改文件' }, { title: '補測試' }]), '修登入 等 3 條');
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  assert.equal(autoClusterName([{ title: long }, { title: 'b' }]), `${Array.from(long).slice(0, 23).join('')}… 等 2 條`, 'cut to 24 characters including the ellipsis');
  assert.equal(Array.from(autoClusterName([{ title: long.repeat(3) }])).length, CLUSTER_NAME_MAX, 'one task: cut to the name limit');
  assert.equal(autoClusterName([{ title: '  多   餘\n空白  ' }]), '多 餘 空白');
  assert.equal(autoClusterName([]), '');
  assert.equal(cleanClusterName('  a \t b\n'), 'a b');
});

// ------------------------------------------------------------- creating

test('a cluster is named after its tasks, never after the main conversation: two clusters from one conversation read differently, and the main conversation is the small line', async () => {
  const parent = await newKimi(hub, { title: 'VPS框架開發' });
  assert.equal((await hub.api('GET', `/sessions/${parent.id}`)).title, 'VPS框架開發', 'the premise: the conversation has that title');
  const one = (await cluster(hub, parent.id, { tasks: tasks('修登入') })).cluster;
  const many = (await cluster(hub, parent.id, { tasks: tasks('補測試', '改文件', '清雜訊') })).cluster;
  assert.equal(one.name, '修登入');
  assert.equal(many.name, '補測試 等 3 條');
  for (const c of [one, many]) assert.ok(!c.name.includes('VPS框架開發'), 'not the main conversation\'s title');
  assert.equal(one.parentTitle, 'VPS框架開發');
  await Promise.all([done(hub, one.id), done(hub, many.id)]);
  const rows = await hub.api('GET', '/clusters');
  assert.deepEqual([one.id, many.id].map((id) => rows.find((r) => r.id === id)).map((r) => [r.name, r.parentTitle]), [['修登入', 'VPS框架開發'], ['補測試 等 3 條', 'VPS框架開發']]);
  assert.deepEqual((await hub.api('GET', `/sessions/${parent.id}/clusters`)).map((c) => c.name).sort(), ['修登入', '補測試 等 3 條']);
});

test('a name given when sending is kept (cleaned up); one that is not text or is too long is refused, and nothing is made', async () => {
  const parent = await newKimi(hub);
  const named = (await cluster(hub, parent.id, { tasks: tasks('甲', '乙'), name: '  登入   大改造 ' })).cluster;
  assert.equal(named.name, '登入 大改造');
  const blank = (await cluster(hub, parent.id, { tasks: tasks('丙'), name: '   ' })).cluster;
  assert.equal(blank.name, '丙', 'a blank name is no name: the made one is used');
  const before = (await hub.api('GET', `/sessions/${parent.id}/clusters`)).length;
  await rejects(cluster(hub, parent.id, { tasks: tasks('丁'), name: 'x'.repeat(CLUSTER_NAME_MAX + 1) }), 400, /叢集名稱最多 60/);
  await rejects(cluster(hub, parent.id, { tasks: tasks('丁'), name: 12 }), 400, /name/);
  assert.equal((await hub.api('GET', `/sessions/${parent.id}/clusters`)).length, before, 'a refused request made no cluster');
  assert.equal((await cluster(hub, parent.id, { tasks: tasks('戊'), name: 'x'.repeat(CLUSTER_NAME_MAX) })).cluster.name.length, CLUSTER_NAME_MAX, 'exactly the limit is fine');
});

// ------------------------------------------------------------- renaming

test('POST /clusters/:id/name renames, tells every page, keeps it across a restart of the Hub, and refuses a blank or too long name', async () => {
  const parent = await newKimi(hub, { title: '主對話標題' });
  const c = (await cluster(hub, parent.id, { tasks: tasks('甲', '乙') })).cluster;
  await done(hub, c.id);
  const ws = watchWs(hub);
  await ws.ready;
  const out = await hub.api('POST', `/clusters/${c.id}/name`, { name: '  新的   名字 ' });
  assert.equal(out.name, '新的 名字');
  assert.equal((await hub.api('GET', `/clusters/${c.id}`)).name, '新的 名字');
  assert.equal((await rowOf(hub, c.id)).name, '新的 名字', 'the overview too');
  await until(async () => ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.name === '新的 名字'), 5000, 'the cluster message with the new name');
  ws.close();
  await rejects(hub.api('POST', `/clusters/${c.id}/name`, { name: '   ' }), 400, /空/);
  await rejects(hub.api('POST', `/clusters/${c.id}/name`, {}), 400);
  await rejects(hub.api('POST', `/clusters/${c.id}/name`, { name: 'y'.repeat(CLUSTER_NAME_MAX + 1) }), 400, /最多 60/);
  await rejects(hub.api('POST', '/clusters/c_000000000000/name', { name: 'z' }), 404);
  assert.equal((await hub.api('GET', `/clusters/${c.id}`)).name, '新的 名字', 'a refused rename changed nothing');
  const file = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'clusters', `${c.id}.json`), 'utf8'));
  assert.equal(file.name, '新的 名字', 'on disk');
});

// ------------------------------------------------------------- old clusters

test('a cluster saved before names has one made from its tasks when it is read, and keeps it once saved again; a record from before the queue (no tasks) is named from its workers', async () => {
  const first = await startRealHub('cluster-name-old-1', { claude: true });
  hubs.push(first);
  await first.setDeepseekKey();
  fs.mkdirSync(path.join(first.TMP, 'proj'), { recursive: true });
  const parent = await newKimi(first, { title: '舊主對話' });
  const a = (await cluster(first, parent.id, { tasks: tasks('甲', '乙', '丙') })).cluster;
  const b = (await cluster(first, parent.id, { tasks: tasks('丁', '戊') })).cluster;
  await Promise.all([done(first, a.id), done(first, b.id)]);
  await first.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-name-keep-'));
  fs.cpSync(first.DATA, keep, { recursive: true });
  const read = (id) => JSON.parse(fs.readFileSync(path.join(keep, 'clusters', `${id}.json`), 'utf8'));
  const write = (id, rec) => fs.writeFileSync(path.join(keep, 'clusters', `${id}.json`), JSON.stringify(rec));
  // a: from before names (tasks are there). b: from before the queue as well (no tasks, no name).
  const ra = read(a.id);
  assert.equal(ra.name, '甲 等 3 條', 'the premise: a new cluster saves its name');
  delete ra.name;
  write(a.id, ra);
  const rb = read(b.id);
  delete rb.name;
  delete rb.tasks;
  delete rb.halted;
  write(b.id, rb);

  const second = await startRealHub('cluster-name-old-2', { claude: true, seed: (DATA) => fs.cpSync(keep, DATA, { recursive: true }) });
  hubs.push(second);
  fs.rmSync(keep, { recursive: true, force: true });
  assert.equal((await second.api('GET', `/clusters/${a.id}`)).name, '甲 等 3 條');
  assert.equal((await second.api('GET', `/clusters/${b.id}`)).name, '丁 等 2 條', 'from its workers\' tasks');
  assert.deepEqual((await second.api('GET', '/clusters')).map((r) => r.name).sort(), ['丁 等 2 條', '甲 等 3 條']);
  // Saved again (any change saves), the name is written down.
  await second.api('POST', `/clusters/${a.id}/stop`);
  await second.api('POST', `/clusters/${b.id}/stop`);
  for (const [id, name] of [[a.id, '甲 等 3 條'], [b.id, '丁 等 2 條']]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(second.DATA, 'clusters', `${id}.json`), 'utf8')).name, name, `${id} on disk`);
  }
});

// ------------------------------------------------------------- the main conversation

test('the main conversation deleted: the cluster keeps its name, says its main conversation is gone (parentTitle null), and every page is told', async () => {
  const parent = await newKimi(hub, { title: '會被刪掉的主對話' });
  const c = (await cluster(hub, parent.id, { tasks: tasks('甲') })).cluster;
  await done(hub, c.id);
  assert.equal((await rowOf(hub, c.id)).parentTitle, '會被刪掉的主對話');
  const ws = watchWs(hub);
  await ws.ready;
  await hub.api('DELETE', `/sessions/${parent.id}`);
  const row = await rowOf(hub, c.id);
  assert.equal(row.name, '甲');
  assert.equal(row.parentTitle, null);
  const page = await hub.api('GET', `/clusters/${c.id}`);
  assert.equal(page.name, '甲');
  assert.equal(page.parentTitle, null);
  await until(async () => ws.msgs.some((m) => m.t === 'cluster' && m.cluster.id === c.id && m.cluster.parentTitle === null), 5000, 'the cluster message that says its main conversation is gone');
  ws.close();
});
