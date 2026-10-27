// meta.turnProvider is the Hub's own note of "this turn runs on …", made when it
// starts a turn (runner.snapshotTurn). The Kimi adapter clears it when the turn
// ends; for a Claude conversation nobody did, so the note of the last turn stayed
// in meta (and in the file) for ever. Now the Claude mirror clears it when the
// turn ends — from the daemon's turn_end event, and from a copy of the
// conversation that shows the turn is over (the Hub was stopped, or the stream
// broke, while it ended) — without undoing what W9b made it keep while the turn
// RUNS: the daemon's pushes still do not take the note away.
//
// Part 1 is the real thing (a real Hub, a real daemon, a real turn); part 2 takes
// a copy of a conversation over, with the real runner's live context, to check
// the cases a real turn does not show.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRealHub, until } from './fixtures/real-hub.mjs';

let hub;
before(async () => {
  hub = await startRealHub('turn-provider', { claude: true });
});
after(() => hub?.stop());

const read = (id) => JSON.parse(fs.readFileSync(path.join(hub.DATA, 'sessions', `${id}.json`), 'utf8'));

test('a Claude turn: the note is there while it runs (and the daemon\'s pushes do not take it away), and gone from the API and from the file once it ends', async () => {
  const cwd = path.join(hub.TMP, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const s = await hub.api('POST', '/sessions', { agent: 'claude', cwd, prompt: 'SLOW', permission: 'auto' });
  await until(async () => (await hub.api('GET', `/sessions/${s.id}`)).status === 'running', 10000, 'the turn to start');
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'and then this' });
  const running = await until(async () => {
    const x = await hub.api('GET', `/sessions/${s.id}`);
    return x.status === 'running' && x.meta?.queue?.length === 1 && x;
  }, 10000, "the daemon's queue to reach the Hub's copy");
  assert.equal(running.meta.turnProvider, 'claude', 'while the turn runs the note stands (control)');

  // Both turns (the queued message makes a second one) end. The daemon's word
  // that it is idle and its turn_end event are two messages: the note goes with
  // the second, so wait for it rather than for the first.
  const idle = await until(async () => {
    const x = await hub.api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && !x.meta?.queue?.length && !x.meta?.turnProvider && x;
  }, 60000, 'the turns to end and the note to go');
  assert.equal(idle.turnProvider, null, 'the summary the browser shows has none');
  await until(async () => {
    const file = read(s.id);
    return file.status === 'idle' && !file.meta?.turnProvider;
  }, 10000, 'the cleared note to be on disk');
});

test('a second turn on the same conversation makes its own note again, and clears it again', async () => {
  const cwd = path.join(hub.TMP, 'project2');
  fs.mkdirSync(cwd, { recursive: true });
  const s = await hub.api('POST', '/sessions', { agent: 'claude', cwd, prompt: 'hello', permission: 'auto' });
  await until(async () => {
    const x = await hub.api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && !x.meta.turnProvider;
  }, 20000, 'the first turn to end and its note to go');
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'SLOW' });
  await until(async () => (await hub.api('GET', `/sessions/${s.id}`)).meta?.turnProvider === 'claude', 10000, 'the second turn\'s note');
  await until(async () => {
    const x = await hub.api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && !x.meta.turnProvider;
  }, 60000, 'the second turn to end and its note to go');
});

test('a short turn that begins and ends while the send call is still out: its turn_end is seen before the answer, and the note still goes once the answer is in', async () => {
  // A conversation on a connected computer: the call goes through the fake
  // computer, which can hold the answer to `send` while the daemon (real) runs
  // the turn and streams its events (what a fast turn on a slow link looks like).
  const cwd = path.join(hub.TMP, 'project3');
  fs.mkdirSync(cwd, { recursive: true });
  let release;
  hub.machine.claudeGate.send = new Promise((r) => (release = r));
  const created = hub.api('POST', '/sessions', { agent: 'claude', machineId: 'm_fake', cwd, prompt: 'hello', permission: 'auto' });
  // The turn ran and ended (the Hub heard the daemon say so) while the answer is held.
  const id = await until(async () => (await hub.api('GET', '/sessions')).find((x) => x.cwd === cwd)?.id, 20000, 'the conversation to exist');
  await until(async () => {
    const x = await hub.api('GET', `/sessions/${id}`);
    return x.events.some((e) => e.type === 'turn_end') && x;
  }, 20000, 'the turn to end while the send call is still out');
  assert.equal(hub.machine.claudeGate.send, null, 'positive control: the held call is the send, and it was made');
  release();
  await created;
  const done = await until(async () => {
    const x = await hub.api('GET', `/sessions/${id}`);
    return x.status === 'idle' && !x.meta.turnProvider && x;
  }, 20000, 'the note to go once the answer is in');
  assert.equal(done.turnProvider, null);
});

// --------------------------------------- part 2: a copy of the conversation

process.env.AGENT_HUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-turn-note-'));
process.env.AGENT_HUB_WORKSPACES = path.join(process.env.AGENT_HUB_DATA, 'ws');
const store = await import('../server/store.js');
await import('../server/runner.js'); // starts the adapters with the real live context
const mirror = await import('../server/adapters/claude-mirror.js');
const applySnapshot = (...args) => mirror.applySnapshot(...args);

const snapshot = (events, status, seq = 10) => ({ id: 'c1', title: 't', titled: true, status, cwd: '/tmp', meta: { model: 'claude-opus-5-5', turnProvider: 'kimi' /* a stale copy of the Hub's own note */ }, usage: {}, allowedTools: [], seq, events });
const turnEnd = (error = false) => ({ id: 'e_end', ts: 2, type: 'turn_end', durationMs: 5, usage: {}, ...(error ? { error: true } : {}) });
const user = { id: 'e_user', ts: 1, type: 'user', text: 'hi' };
const session = (id) => store.createSession({ id, agentId: 'claude', origin: 'hub', cwd: '/tmp', title: 't', status: 'running', meta: { model: 'claude-opus-5-5', turnProvider: 'claude' } });

test('a copy of the conversation in which the turn is over clears the note (the Hub was not looking when it ended)', () => {
  const s = session('c_ended_000001');
  applySnapshot(s, snapshot([user, turnEnd()], 'idle'));
  assert.equal(s.status, 'idle');
  assert.equal(s.meta.turnProvider ?? null, null);
  const failed = session('c_failed_000001');
  applySnapshot(failed, snapshot([user, turnEnd(true)], 'error'));
  assert.equal(failed.status, 'error');
  assert.equal(failed.meta.turnProvider ?? null, null, 'a turn that ended in an error ended too');
});

test('a copy of the conversation in which the turn is still running keeps the Hub\'s note, and the daemon\'s stale copy of it does not replace it', () => {
  const s = session('c_running_00001');
  applySnapshot(s, snapshot([user], 'running'));
  assert.equal(s.status, 'running');
  assert.equal(s.meta.turnProvider, 'claude', 'the Hub\'s note, not the daemon\'s stale "kimi"');
});

test('a conversation that never had a note gets none made up', () => {
  const s = store.createSession({ id: 'c_nonote_000001', agentId: 'claude', origin: 'hub', cwd: '/tmp', title: 't', status: 'idle', meta: { model: 'claude-opus-5-5' } });
  applySnapshot(s, snapshot([user, turnEnd()], 'idle'));
  assert.ok(!s.meta.turnProvider);
});
