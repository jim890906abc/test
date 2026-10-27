import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chain-api-'));
const DATA = path.join(TMP, 'data');
const PORT = 24000 + Math.floor(Math.random() * 1000);
let server;
let log = '';

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  const node = (id, patch) => ({
    id, conversationId: 's_a', title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [],
    state: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1, updatedAt: 1, provider: 'kimi',
    agentId: 'kimi@m1', cwd: '/tmp', meta: {}, ...patch,
  });
  fs.writeFileSync(path.join(DATA, 'sessions', 's_a.json'), JSON.stringify(node('s_a', {
    conversationId: 's_a', continuedTo: 's_b', events: [{ id: 'a1', ts: 1, type: 'user', text: 'A' }, { id: 'a2', ts: 2, type: 'text', text: 'A2' }],
  })));
  fs.writeFileSync(path.join(DATA, 'sessions', 's_b.json'), JSON.stringify(node('s_b', {
    continuedFrom: 's_a', continuedTo: 's_c', events: [{ id: 'b1', ts: 3, type: 'user', text: 'B' }],
  })));
  fs.writeFileSync(path.join(DATA, 'sessions', 's_c.json'), JSON.stringify(node('s_c', {
    continuedFrom: 's_b', events: [{ id: 'c1', ts: 4, type: 'text', text: 'C' }],
  })));
  // A conversation attached from a native runtime: still one leaf, external.
  fs.writeFileSync(path.join(DATA, 'sessions', 's_ext.json'), JSON.stringify(node('s_ext', {
    conversationId: 's_ext', origin: 'external', updatedAt: 0,
  })));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 10000);
    server.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
  });
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
});

const api = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`);
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};

test('the list is leaves only; an old node URL returns the leaf with merged chain history', async () => {
  const list = await api('/sessions');
  assert.deepEqual(list.map((s) => s.id), ['s_c', 's_ext']);
  assert.equal(list[0].leafId, 's_c');
  assert.equal(list[0].chainLength, 3);
  // A legacy store without origin is a main chat, not a hidden 子session.
  assert.equal(list[0].origin, 'hub');
  assert.equal(list[1].origin, 'external');
  assert.equal(list[1].leafId, 's_ext');

  const old = await api('/sessions/s_a');
  assert.equal(old.id, 's_c');
  assert.equal(old.redirectedFrom, 's_a');
  assert.equal(old.continuedFrom, 's_b');
  assert.deepEqual(old.events.map((e) => e.id), ['a1', 'a2', 'b1', 'c1']);
  assert.equal(new Set(old.events.map((e) => e.id)).size, old.events.length, 'chain history has no repeated event');
  assert.deepEqual(old.chain.map((n) => [n.id, n.isLeaf, n.origin]), [['s_a', false, 'hub'], ['s_b', false, 'hub'], ['s_c', true, 'hub']]);

  const leaf = await api('/sessions/s_c');
  assert.equal(leaf.redirectedFrom, undefined);
  assert.equal(leaf.events.length, 4);
});

test('the unified models endpoint returns all three groups, even when unavailable', async () => {
  const r = await api('/models?session=s_c');
  assert.deepEqual(r.groups.map((g) => g.provider), ['kimi', 'claude', 'deepseek']);
  assert.equal(r.provider, 'kimi');
  assert.equal(r.session, 's_c');
});

test('deleting an old node deletes the whole chain instead of reviving it', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions/s_a`, { method: 'DELETE' });
  assert.equal(r.ok, true);
  assert.deepEqual((await api('/sessions')).map((s) => s.id), ['s_ext']);
  const gone = await fetch(`http://127.0.0.1:${PORT}/api/sessions/s_c`);
  assert.equal(gone.ok, false);

  const ext = await fetch(`http://127.0.0.1:${PORT}/api/sessions/s_ext`, { method: 'DELETE' });
  assert.equal(ext.ok, true);
  assert.deepEqual((await api('/sessions')).map((s) => s.id), []);
});
