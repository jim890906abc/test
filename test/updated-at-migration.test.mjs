// updatedAt is the sidebar's only sort key: starting the Hub on an old store
// (filling in a missing sub-agent default, clearing a stale switch marker,
// rebuilding broker mirrors) must not move any conversation's last-activity
// time. Several distinct old dates, so "everything became the same" shows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoLeaks, snapshot } from './fixtures/leak-guard.mjs';
import { stopHubAndDaemons } from './fixtures/stop-daemons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-updated-'));
const leaksBefore = snapshot();
const DATA = path.join(TMP, 'data');
const PORT = 25000 + Math.floor(Math.random() * 1000);
const T = {
  kimiOld: Date.parse('2026-01-01T00:00:00Z'),
  kimiMid: Date.parse('2026-04-02T00:00:00Z'),
  claude: Date.parse('2026-06-03T00:00:00Z'),
  stale: Date.parse('2026-09-04T00:00:00Z'),
  child: Date.parse('2026-09-05T00:00:00Z'),
  kid: Date.parse('2026-09-06T00:00:00Z'),
  chainA: Date.parse('2026-02-06T00:00:00Z'),
  chainB: Date.parse('2026-02-07T00:00:00Z'),
};
let server;
let log = '';

const node = (id, patch) => ({
  id, conversationId: id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {},
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1000, provider: 'kimi', agentId: 'kimi@m1',
  machineId: 'm1', kimiSessionId: `k_${id}`, cwd: '/tmp', meta: {}, ...patch,
});
const put = (s) => fs.writeFileSync(path.join(DATA, 'sessions', `${s.id}.json`), JSON.stringify(s));
const api = async (p) => (await fetch(`http://127.0.0.1:${PORT}/api${p}`)).json();

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  put(node('s_old', { updatedAt: T.kimiOld }));
  put(node('s_mid', { updatedAt: T.kimiMid }));
  put({ ...node('s_claude', { updatedAt: T.claude, agentId: 'claude', provider: 'claude' }), machineId: undefined, kimiSessionId: undefined });
  // A switch marker a crash left behind (cleared at start), a pending target kept.
  put(node('s_stale', { updatedAt: T.stale, state: { pendingSwitching: true, pendingProvider: { provider: 'claude', model: 'claude-opus-5-5', machineId: 'm_never' } } }));
  // A broker child and its parent (the Hub rebuilds the parent's mirror at start).
  put(node('s_parent', { updatedAt: T.child, events: [{ id: 'e_card', ts: 1, type: 'tool_use', name: 'delegate_to_provider', status: 'done', input: { task: 'do x' }, childSessionId: 's_kid' }] }));
  put(node('s_kid', { updatedAt: T.kid, parentId: 's_parent', origin: 'external', events: [{ id: 'k1', ts: 2, type: 'user', text: 'do x' }, { id: 'k2', ts: 3, type: 'text', text: 'done' }, { id: 'k3', ts: 4, type: 'turn_end' }], state: { broker: { parentId: 's_parent', parentEventId: 'e_card' } } }));
  // A two-node chain.
  put(node('s_chain_a', { updatedAt: T.chainA, continuedTo: 's_chain_b' }));
  put(node('s_chain_b', { updatedAt: T.chainB, continuedFrom: 's_chain_a', conversationId: 's_chain_a' }));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 15000);
    server.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
  });
});
after(async () => {
  // A stored Claude conversation makes the Hub start the Claude daemon, which
  // outlives it: the Hub first, then the daemon of this scratch folder.
  stopHubAndDaemons(server, TMP);
  try {
    await assertNoLeaks(leaksBefore, { dirs: [TMP] });
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

const EXPECT = { s_old: T.kimiOld, s_mid: T.kimiMid, s_claude: T.claude, s_stale: T.stale, s_parent: T.child, s_kid: T.kid, s_chain_b: T.chainB };

test('starting on an old store leaves every conversation\'s updatedAt as it was (API)', async () => {
  const list = await api('/sessions');
  const got = Object.fromEntries(list.map((s) => [s.id, s.updatedAt]));
  for (const [id, want] of Object.entries(EXPECT)) assert.equal(got[id], want, `${id}: ${new Date(got[id]).toISOString()} instead of ${new Date(want).toISOString()}`);
  assert.equal(new Set(list.map((s) => s.updatedAt)).size, list.length, 'they are not all one moment');
  // Still sorted newest-first by their own times.
  assert.deepEqual(list.map((s) => s.id), Object.keys(EXPECT).sort((a, b) => EXPECT[b] - EXPECT[a]));
});

test('... and so are the files on disk once the debounced writes have landed', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const disk = (id) => JSON.parse(fs.readFileSync(path.join(DATA, 'sessions', `${id}.json`), 'utf8'));
  for (const [id, want] of Object.entries({ ...EXPECT, s_chain_a: T.chainA })) assert.equal(disk(id).updatedAt, want, `${id} on disk`);
  // The migration itself still happened: the default sub-agent was filled in,
  // the stale marker cleared, the pending target kept.
  assert.ok(disk('s_old').meta.subagent, 'default sub-agent filled in');
  assert.equal(disk('s_stale').state.pendingSwitching, undefined);
  assert.ok(disk('s_stale').state.pendingProvider);
});

test('real activity still moves updatedAt', async () => {
  const before = (await api('/sessions')).find((s) => s.id === 's_mid').updatedAt;
  const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions/s_mid`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'renamed' }) });
  assert.equal(r.ok, true);
  const after = (await api('/sessions')).find((s) => s.id === 's_mid').updatedAt;
  assert.ok(after > before, 'renaming is user activity');
});
