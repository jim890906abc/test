import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chain-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let handoff;

before(async () => {
  store = await import('../server/store.js');
  handoff = await import('../server/handoff.js');
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('continuation chain keeps every node, lists only the leaf and merges history in time order', () => {
  const a = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_a', provider: 'kimi', title: 'A', cwd: '/tmp/a', origin: 'hub' });
  a.events.push({ id: 'e1', ts: 100, type: 'user', text: 'hello' });
  a.events.push({ id: 'e2', ts: 200, type: 'text', text: 'hi' });
  const b = store.createSession({ agentId: 'claude', conversationId: a.conversationId, continuedFrom: a.id, provider: 'claude', title: 'B', origin: 'hub' });
  a.continuedTo = b.id;
  b.events.push({ id: 'e3', ts: 150, type: 'user', text: 'from B' });
  const c = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_c', conversationId: a.conversationId, continuedFrom: b.id, provider: 'kimi', title: 'C', origin: 'hub' });
  b.continuedTo = c.id;
  c.events.push({ id: 'e4', ts: 300, type: 'text', text: 'C' });

  assert.deepEqual(store.chainOf(a).map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.chainOf(a).map((x) => x.origin), ['hub', 'hub', 'hub']);
  assert.equal(store.leafOf(a).id, c.id);
  assert.deepEqual(store.listLeaves().map((x) => x.id), [c.id]);
  assert.deepEqual(store.chainEvents(a).map((x) => [x.id, x.nodeId]), [['e1', a.id], ['e3', b.id], ['e2', a.id], ['e4', c.id]]);
  assert.equal(a.kimiSessionId, 'session_a', 'a switched-away node keeps its native binding');
  assert.equal(c.kimiSessionId, 'session_c');
});

test('portable transcript includes source/cwd, tool work and redacts secrets; truncation is explicit', () => {
  const a = store.createSession({ agentId: 'claude', provider: 'claude', cwd: '/work/x' });
  a.events.push({ id: 'u', ts: 1, type: 'user', text: 'read the key sk-ant-api03-abcdefghijklmnop' });
  a.events.push({ id: 't', ts: 2, type: 'tool_use', name: 'Bash', title: 'curl -H "Authorization: Bearer bk_abcdefgh"', status: 'done', output: 'secret sk-ant-api03-xyzxyzxyz' });
  a.events.push({ id: 'a', ts: 3, type: 'text', text: 'done' });
  const r = handoff.chainTranscript(a, { maxChars: 10_000 });
  assert.match(r.text, /prior conversation history from Claude/);
  assert.match(r.text, /Working directory: \/work\/x/);
  assert.match(r.text, /NOT a new user request/);
  assert.match(r.text, /\[tool Bash\]/);
  assert.ok(!r.text.includes('sk-ant-api03-abcdefghijklmnop'));
  assert.ok(!r.text.includes('bk_abcdefgh'));
  const cut = handoff.chainTranscript(a, { maxChars: 120 });
  assert.match(cut.text, /characters omitted/);
  assert.ok(cut.omitted > 0);
});

test('a conversation with no visible history has no handoff preamble', () => {
  const empty = store.createSession({ agentId: 'acp-empty', provider: 'kimi' });
  assert.equal(handoff.chainTranscript(empty).text, '');
  empty.events.push({ id: 'future', ts: 100, type: 'user', text: 'not in this turn yet' });
  assert.equal(handoff.chainTranscript(empty, { beforeIndex: 0 }).text, '');
});
