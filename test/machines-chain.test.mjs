import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-machines-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let machines;

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  store.createSession({ id: 's_a', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_a', provider: 'kimi', continuedTo: 's_b', conversationId: 's_a' });
  store.createSession({ id: 's_b', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_b', provider: 'kimi', continuedFrom: 's_a', conversationId: 's_a' });
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
  ws.emit('message', JSON.stringify({
    t: 'kimi.sessions',
    items: [
      { id: 'session_a', title: 'A', metadata: { cwd: '/tmp' }, model: 'kimi/k2' },
      { id: 'session_b', title: 'B', metadata: { cwd: '/tmp' }, model: 'kimi/k2' },
      { id: 'session_pure', title: 'pure native', metadata: { cwd: '/tmp' }, model: 'kimi/k2' },
    ],
  }));
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a native old chain node is hidden, its leaf keeps chain metadata, and an unattached native session stays', () => {
  const list = machines.listMachines()[0].sessions;
  assert.deepEqual(list.map((s) => s.id).sort(), ['session_b', 'session_pure']);
  const leaf = list.find((s) => s.id === 'session_b');
  assert.equal(leaf.hubSessionId, 's_b');
  assert.equal(leaf.conversationId, 's_a');
  assert.equal(leaf.chainLength, 2);
  assert.equal(leaf.isLeaf, true);
  const pure = list.find((s) => s.id === 'session_pure');
  assert.equal(pure.hubSessionId, undefined);
});

// ---- chain fields are worked out when read, not when the machine reported ----

function bridge(id) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  machines.attachBridge(ws);
  const say = (m) => ws.emit('message', JSON.stringify(m));
  say({ t: 'hello', machineId: id, name: id, platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } });
  return say;
}
const rows = (id) => machines.listMachines().find((m) => m.id === id).sessions;
const native = (id) => ({ id, title: id, metadata: { cwd: '/tmp' }, model: 'kimi/k2' });

test('a link made after the machine reported is shown at once (the new native session is not an "external" one)', () => {
  const say = bridge('m_late');
  say({ t: 'kimi.sessions', items: [native('late_a'), native('late_b')] });
  assert.deepEqual(rows('m_late').map((r) => r.id).sort(), ['late_a', 'late_b'], 'nothing is attached yet: both are plain native sessions');
  assert.equal(rows('m_late').find((r) => r.id === 'late_b').hubSessionId, undefined);

  // The Hub makes the nodes and links them afterwards; the machine says nothing more.
  const a = store.createSession({ id: 's_late_a', agentId: 'kimi@m_late', machineId: 'm_late', kimiSessionId: 'late_a', provider: 'kimi', conversationId: 's_late_a' });
  const b = store.createSession({ id: 's_late_b', agentId: 'kimi@m_late', machineId: 'm_late', kimiSessionId: 'late_b', provider: 'kimi', conversationId: 's_late_a', continuedFrom: a.id, provisional: true });
  assert.deepEqual(rows('m_late').map((r) => r.id), ['late_a'], 'a node still being made is not a row; the old one still is');
  delete b.provisional;
  a.continuedTo = b.id;
  const after = rows('m_late');
  assert.deepEqual(after.map((r) => r.id), ['late_b'], 'linked: the leaf stands for the conversation, the old node is hidden');
  assert.equal(after[0].hubSessionId, 's_late_b');
  assert.equal(after[0].isLeaf, true);
  assert.equal(after[0].chainLength, 2);
  assert.equal(after[0].continuedFrom, 's_late_a');
});

test('a native session announced after its node exists is not listed as external either', () => {
  const say = bridge('m_new');
  const a = store.createSession({ id: 's_new_a', agentId: 'kimi@m_new', machineId: 'm_new', kimiSessionId: 'new_a', provider: 'kimi', conversationId: 's_new_a', continuedTo: 's_new_b' });
  store.createSession({ id: 's_new_b', agentId: 'kimi@m_new', machineId: 'm_new', kimiSessionId: 'new_b', provider: 'kimi', conversationId: 's_new_a', continuedFrom: a.id });
  say({ t: 'kimi.event', frame: { type: 'event.session.created', session_id: 'new_a', payload: { session: native('new_a') } } });
  say({ t: 'kimi.event', frame: { type: 'event.session.created', session_id: 'new_b', payload: { session: native('new_b') } } });
  assert.deepEqual(rows('m_new').map((r) => r.id), ['new_b']);
  assert.equal(rows('m_new')[0].hubSessionId, 's_new_b');
});

test('a sub-agent\'s native session carries its parent; a continuation link is not a parent', () => {
  const say = bridge('m_kid');
  store.createSession({ id: 's_kid_p', agentId: 'kimi@m_kid', machineId: 'm_kid', kimiSessionId: 'kid_p', provider: 'kimi' });
  store.createSession({ id: 's_kid_c', agentId: 'kimi@m_kid', machineId: 'm_kid', kimiSessionId: 'kid_c', provider: 'kimi', parentId: 's_kid_p', origin: 'external' });
  store.createSession({ id: 's_kid_f', agentId: 'kimi@m_kid', machineId: 'm_kid', kimiSessionId: 'kid_f', provider: 'kimi', continuedFrom: 's_kid_p' });
  say({ t: 'kimi.sessions', items: [native('kid_p'), native('kid_c'), native('kid_f')] });
  const by = Object.fromEntries(rows('m_kid').map((r) => [r.id, r]));
  assert.equal(by.kid_c.parentId, 's_kid_p');
  assert.equal(by.kid_p.parentId, null);
  assert.equal(by.kid_f.parentId, null);
});

test('a link made or undone is pushed to the pages: the machine list is re-sent', () => {
  const sent = [];
  machines.setBroadcast((m) => sent.push(m));
  bridge('m_push');
  machines.chainChanged({ machineId: 'm_push' });
  assert.ok(sent.some((m) => m.t === 'machine' && m.machine.id === 'm_push'));
  sent.length = 0;
  machines.chainChanged({ machineId: 'm_unrelated' });
  assert.equal(sent.filter((m) => m.t === 'machine' && m.machine.id === 'm_push').length, 0, 'only the machines involved');
});

test('the lookup from a native session to its node does not scan every conversation', () => {
  for (let i = 0; i < 2000; i++) store.createSession({ id: `s_bulk_${i}`, agentId: 'kimi@m_bulk', machineId: 'm_bulk', kimiSessionId: `bulk_${i}`, provider: 'kimi' });
  assert.equal(store.findByNative('m_bulk', 'bulk_1999').id, 's_bulk_1999');
  assert.equal(store.findByNative('m_bulk', 'nope'), null);
  store.deleteSession('s_bulk_1999');
  assert.equal(store.findByNative('m_bulk', 'bulk_1999'), null, 'a deleted node is not found');
});
