// The Hub's copy of a Claude conversation follows its daemon (the mirror), but
// `session.meta` is not the daemon's alone: the Hub keeps some of its own
// fields in it (the scheduled switch, the repaired-conversation note, the
// provider of the turn that is running, the subagent default). Taking the
// daemon's meta over whole at every sync threw those away — a conversation's
// "this turn runs on …" label vanished the moment the daemon pushed anything,
// a repair note and a scheduled switch were forgotten. Only the daemon's own
// fields are taken from it now.
//
// Part 1 is the real thing: a real Hub, a real daemon, a turn that is running.
// Part 2 pins the rule for every field the Hub writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRealHub, until } from './fixtures/real-hub.mjs';

// ------------------------------------------------ part 1: through a real Hub

let hub;
before(async () => {
  hub = await startRealHub('mirror-meta', { claude: true });
});
after(() => hub?.stop());

test('a Claude turn that is running keeps the Hub\'s "this turn runs on" provider while the daemon pushes its own fields', async () => {
  const cwd = path.join(hub.TMP, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const s = await hub.api('POST', '/sessions', { agent: 'claude', cwd, prompt: 'SLOW', permission: 'auto' });
  // A message sent while the turn runs is queued by the DAEMON (meta.queue is
  // its field): when it shows in the Hub's copy, a daemon push has been applied.
  await until(async () => (await hub.api('GET', `/sessions/${s.id}`)).status === 'running', 10000, 'the turn to start');
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'and then this' });
  const running = await until(async () => {
    const x = await hub.api('GET', `/sessions/${s.id}`);
    return x.status === 'running' && x.meta?.queue?.length === 1 && x;
  }, 10000, "the daemon's queue to reach the Hub's copy");
  assert.equal(running.meta.queue[0].text, 'and then this', "the daemon's field was taken over");
  assert.equal(running.meta.turnProvider, 'claude', "the Hub's own field is still there");
  assert.equal(running.turnProvider, 'claude', 'and the summary the browser shows says so');
});

// ------------------------------------------- part 2: the rule, field by field

process.env.AGENT_HUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-mirror-meta-'));
process.env.AGENT_HUB_WORKSPACES = path.join(process.env.AGENT_HUB_DATA, 'ws');
const { mirrorMeta, HUB_OWNED_META } = await import('../server/adapters/claude-mirror.js');

// Written here, not read from the module: an emptied list must not make the tests pass.
const HUB_KEYS = ['salvaged', 'pendingSwitch', 'turnProvider'];
const clone = (x) => structuredClone(x);
const hubMeta = () => ({
  salvaged: { at: 1, removedBytes: 10, originalBytes: 100, backup: 'x.json.1', kinds: ['nul'], reason: '曾損壞' },
  pendingSwitch: { provider: 'kimi', model: 'k', effort: 'high', machineId: 'm1' },
  turnProvider: 'claude',
  subagent: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' },
  // The daemon's, as the Hub last saw them.
  model: 'old-model',
  queue: [{ promptId: 'p_old', text: 'old' }],
  todos: [],
});
const daemonMeta = () => ({
  agent: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  permission: 'auto',
  planMode: false,
  queue: [],
  todos: [{ content: 'a', status: 'pending' }],
  context: { used: 10, size: 100 },
  claudeUsage: { input: 1 },
  servedModel: { id: 'claude-opus-5-5' },
  // What a daemon holds from an earlier hand-over of the Hub's copy: stale.
  pendingSwitch: { provider: 'claude', model: 'stale' },
  salvaged: { stale: true },
  turnProvider: 'kimi',
  subagent: { provider: 'claude', model: 'x', effort: '' },
  // A field this Hub has never heard of: must still arrive (a newer daemon).
  someNewDaemonField: 7,
});

test('a sync takes the daemon\'s fields and keeps every field the Hub owns, bit for bit', () => {
  const session = { meta: hubMeta() };
  const hubBefore = clone(session.meta);
  const out = mirrorMeta(session, { ...daemonMeta(), machineName: 'box' });
  assert.deepEqual([...HUB_OWNED_META].sort(), [...HUB_KEYS].sort());
  for (const key of HUB_KEYS) assert.deepEqual(out[key], hubBefore[key], `${key} is the Hub's`);
  assert.deepEqual(out.subagent, hubBefore.subagent, "subagent is the Hub's");
  assert.equal(out.model, 'claude-opus-5-5');
  assert.deepEqual(out.queue, []);
  assert.deepEqual(out.todos, [{ content: 'a', status: 'pending' }]);
  assert.deepEqual(out.context, { used: 10, size: 100 });
  assert.equal(out.machineName, 'box');
  assert.equal(out.someNewDaemonField, 7, "a field only the daemon knows still arrives");
  assert.deepEqual(session.meta, hubBefore, "the Hub's copy is not changed in place");
});

test('a Hub field the Hub no longer has is not brought back by a daemon\'s stale copy', () => {
  // The Hub cleared its scheduled switch and has no repair note; the daemon
  // still holds what it was handed over earlier.
  const session = { meta: { model: 'm' } };
  const out = mirrorMeta(session, daemonMeta());
  for (const key of [...HUB_KEYS, 'subagent']) assert.equal(key in out, false, `${key} stays gone`);
  assert.equal(out.model, 'claude-opus-5-5');
});

test('a field the daemon dropped is dropped, and a first look at a conversation (adopt) takes the daemon\'s copy whole', () => {
  const session = { meta: { ...hubMeta(), todos: [{ content: 'gone' }], budget: 3 } };
  const out = mirrorMeta(session, { agent: 'claude' });
  assert.equal('todos' in out, false);
  assert.equal('budget' in out, false);
  assert.deepEqual(out.salvaged, hubMeta().salvaged);

  const fresh = mirrorMeta({ meta: {} }, daemonMeta(), { adopt: true });
  assert.deepEqual(fresh, daemonMeta());
});

test('the daemon\'s engine never writes a field on the Hub-owned list (or a sync could not keep them apart)', () => {
  const src = fs.readFileSync(new URL('../server/adapters/claude.js', import.meta.url), 'utf8');
  const writes = (key) => new RegExp(`(?:setMeta\\([^\\n]*\\b${key}\\s*[:,}]|\\bmeta\\.${key}\\s*=[^=]|\\bfields\\.${key}\\s*=[^=])`).test(src);
  for (const key of ['queue', 'todos', 'turnModel', 'context']) assert.equal(writes(key), true, `the scan sees the daemon write ${key} (control)`);
  for (const key of HUB_OWNED_META) assert.equal(writes(key), false, `${key} is written by the Hub only`);
});
