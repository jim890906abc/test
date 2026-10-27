// Deleting a conversation deletes the conversation: every node of its chain
// and every sub-agent conversation under any of them, from every entry point
// (the API, a Kimi row's 刪除 in the sidebar, the /archive command); the old
// nodes do not come back, the sub-agents' Kimi sessions do not turn up as
// "子session", and a continuation link is never mistaken for a parent link.
// A real Hub, a fake Kimi machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';

let hub;
const MID = 'm_fake';
const node = (id, patch = {}) => ({
  id, conversationId: id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {},
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1000, updatedAt: 1000, provider: 'kimi',
  agentId: `kimi@${MID}`, machineId: MID, kimiSessionId: `session_${id}`, cwd: '/tmp/project', meta: {}, origin: 'hub', ...patch,
});
const put = (DATA, s) => fs.writeFileSync(path.join(DATA, 'sessions', `${s.id}.json`), JSON.stringify(s));
const ids = async () => (await hub.api('GET', '/sessions')).map((s) => s.id).sort();
const natives = () => [...hub.machine.sessions.keys()];

before(async () => {
  hub = await startRealHub('delete', {
    seed: (DATA) => {
      // chain 1: old (with a child) -> leaf (with a child that has a child)
      put(DATA, node('d1', { continuedTo: 'd2' }));
      put(DATA, node('d2', { continuedFrom: 'd1', conversationId: 'd1' }));
      put(DATA, node('d1kid', { parentId: 'd1', origin: 'external' }));
      put(DATA, node('d2kid', { parentId: 'd2', origin: 'external' }));
      put(DATA, node('d2gk', { parentId: 'd2kid', origin: 'external' }));
      // not part of it: an unrelated conversation, and one that merely names a chain node in continuedFrom
      put(DATA, node('other'));
      put(DATA, node('fork', { continuedFrom: 'd1' }));
      // chain 2 and 3, for the other two entry points
      put(DATA, node('a1', { continuedTo: 'a2' }));
      put(DATA, node('a2', { continuedFrom: 'a1', conversationId: 'a1' }));
      put(DATA, node('a2kid', { parentId: 'a2', origin: 'external' }));
      put(DATA, node('c1', { continuedTo: 'c2' }));
      put(DATA, node('c2', { continuedFrom: 'c1', conversationId: 'c1' }));
    },
  });
  for (const id of ['d1', 'd2', 'd1kid', 'd2kid', 'd2gk', 'other', 'fork', 'a1', 'a2', 'a2kid', 'c1', 'c2']) hub.machine.add(`session_${id}`, { title: id });
  hub.machine.pushSessions();
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID)?.sessions?.length > 0, 8000, 'the machine\'s sessions listed');
});
after(() => hub.stop());

const machineList = async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID).sessions;

test('the machine list says which native sessions are sub-agents of which Hub conversation, and hides old chain nodes', async () => {
  const list = await machineList();
  const byId = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.equal(byId.session_d1, undefined, 'an old chain node is not a row');
  assert.equal(byId.session_a1, undefined);
  assert.equal(byId.session_d2.hubSessionId, 'd2');
  assert.equal(byId.session_d2.isLeaf, true);
  assert.equal(byId.session_d1kid.parentId, 'd1', 'a sub-agent\'s entry names its parent');
  assert.equal(byId.session_d2kid.parentId, 'd2');
  assert.equal(byId.session_d2gk.parentId, 'd2kid');
  assert.equal(byId.session_other.parentId ?? null, null);
  assert.equal(byId.session_fork.parentId ?? null, null, 'a continuation is not a parent');
});

test('DELETE through an old node removes the whole chain and every sub-agent under it, and nothing else', async () => {
  hub.machine.autoRemoveOnArchive = false; // as if the archive did not reach Kimi's list yet
  const r = await hub.api('DELETE', '/sessions/d1');
  assert.equal(r.ok, true);
  const left = await ids();
  for (const gone of ['d1', 'd2', 'd1kid', 'd2kid', 'd2gk']) assert.equal(left.includes(gone), false, `${gone} is gone`);
  assert.deepEqual(left.filter((x) => ['other', 'fork', 'a2', 'c2'].includes(x)), ['a2', 'c2', 'fork', 'other'], 'and the others are not touched (a continuedFrom link is not a parent)');
  await until(async () => hub.machine.archived.includes('session_d2gk'), 5000, 'sub-agent natives archived');
  for (const kid of ['session_d1kid', 'session_d2kid', 'session_d2gk']) assert.ok(hub.machine.archived.includes(kid), `${kid} archived on the machine`);
  assert.equal(hub.machine.archived.includes('session_d1'), false, 'the conversation\'s own Kimi sessions are not archived by deleting it');
  assert.equal(hub.machine.archived.includes('session_d2'), false);
  // Kimi has not dropped them from its list yet; the Hub must not show them as 子session meanwhile.
  const list = await machineList();
  for (const hidden of ['session_d1kid', 'session_d2kid', 'session_d2gk']) assert.equal(list.some((e) => e.id === hidden), false, `${hidden} must not surface as a native session`);
  hub.machine.autoRemoveOnArchive = true;
  await assert.rejects(hub.api('GET', '/sessions/d2'), (e) => e.status === 404);
});

test('the sidebar\'s 刪除 on a Kimi row deletes the chain the row stands for, not just that node', async () => {
  const before = await ids();
  assert.ok(before.includes('a2'));
  await hub.api('POST', `/machines/${MID}/kimi/session_a2/archive`, {});
  const after = await ids();
  assert.equal(after.includes('a2'), false);
  assert.equal(after.includes('a1'), false, 'the old node did not come back as a leaf');
  assert.equal(after.includes('a2kid'), false, 'its sub-agent went too');
  assert.ok(hub.machine.archived.includes('session_a2'), 'the row\'s own Kimi session was archived, as before');
  assert.ok(hub.machine.archived.includes('session_a2kid'));
  assert.ok(after.includes('other'));
  await assert.rejects(hub.api('GET', '/sessions/a1'), (e) => e.status === 404);
});

test('the /archive command deletes the chain too', async () => {
  await hub.api('POST', '/sessions/c1/command', { name: 'archive' });
  const after = await ids();
  assert.equal(after.includes('c1'), false);
  assert.equal(after.includes('c2'), false, 'the leaf the command resolved to is gone with the chain');
  assert.ok(hub.machine.archived.includes('session_c2'));
  assert.ok(after.includes('other'));
});

test('deleting is not undone by a restart: no deleted node is on disk', async () => {
  await wait(2300);
  const files = fs.readdirSync(path.join(hub.DATA, 'sessions')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(files.filter((f) => /^(d|a|c)\d|kid|gk/.test(f)), []);
  assert.ok(files.includes('other') && files.includes('fork'));
});
