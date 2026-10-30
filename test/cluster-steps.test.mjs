// 步數 of a cluster: how many steps it has taken. The owner (2026-10-30): "show how
// many steps the cluster has gone, in the overview too - like the chat room, only
// the steps of that cluster, nothing added up across clusters". A step is what the
// chat room's subagent card counts when it says "483 個步驟": a tool call. A
// cluster's steps are those of all its workers' main agents and all their
// subagents - the old ones that have rolled out of the newest-160 list as well,
// because the count is taken over the conversation's events, not over the list.
//
// Through the REAL Hub process with a fake Kimi that speaks the frames the real
// one sends for an AgentSwarm (as test/cluster-subagents.test.mjs does). The chat
// room's own counting (transcript.js stepCount) is run over the very same events
// and must give the same numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { startRealHub, until } from './fixtures/real-hub.mjs';

// transcript.js imports the browser vendor bundles; keep the UI logic under test with tiny local modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-steps-'));
fs.writeFileSync(path.join(TMP, 'marked.mjs'), 'export const marked = { setOptions() {}, parse: (s) => String(s ?? "") };');
fs.writeFileSync(path.join(TMP, 'purify.mjs'), 'export default { sanitize: (s) => s };');
registerHooks({
  resolve(spec, context, next) {
    if (spec === '/vendor/marked.esm.js') return { url: pathToFileURL(path.join(TMP, 'marked.mjs')).href, shortCircuit: true };
    if (spec === '/vendor/purify.es.mjs') return { url: pathToFileURL(path.join(TMP, 'purify.mjs')).href, shortCircuit: true };
    return next(spec, context);
  },
});
const { Transcript } = await import('../public/js/transcript.js');
const { isStep, countSteps } = await import('../public/js/agent-activity.js');
const { stepsView } = await import('../public/js/cluster-model.js');

const MID = 'm_fake';
const hubs = [];
let hub;
let KIMI;

const snap = (h, id) => h.api('GET', `/sessions/${id}`);
const getCluster = (h, cid) => h.api('GET', `/clusters/${cid}`);
const newKimi = (h) => h.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: h.TMP, model: KIMI.model, effort: KIMI.effort, permission: 'auto' });

async function oneWorker(h, { tasks = [{ title: '甲', prompt: '做甲' }] } = {}) {
  const parent = await newKimi(h);
  const r = await h.api('POST', `/sessions/${parent.id}/cluster`, { tasks, isolate: false });
  const worker = r.cluster.workers[0];
  const kid = (await snap(h, worker.sessionId)).kimiSessionId;
  const f = (type, payload) => h.machine.frame(kid, type, payload);
  f('turn.started', { turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, prompt: '做甲' });
  f('event.session.work_changed', { busy: true, pending_interaction: 'none' });
  await until(async () => (await snap(h, worker.sessionId)).status === 'running', 8000, 'the worker is at work');
  return { cid: r.cluster.id, sid: worker.sessionId, kid, f };
}
const tool = (f, id, command, agentId) => {
  f('tool.call.started', { ...(agentId ? { agentId } : {}), toolCallId: id, name: 'Bash', args: { command }, description: command });
  f('tool.result', { ...(agentId ? { agentId } : {}), toolCallId: id, output: 'ok' });
};
const swarmCall = (f, id, items) => f('tool.call.started', { toolCallId: id, name: 'AgentSwarm', args: { description: '群', items: Array.from({ length: items }, (_, i) => `項${i}`) }, description: 'Launching agent swarm: 群' });
const member = (f, i, call) => {
  const subagentId = `agent-${i}`;
  f('subagent.spawned', { subagentId, subagentName: 'coder', parentToolCallId: call, parentAgentId: 'main', callerAgentId: 'main', description: `群 #${i + 1} (coder)`, swarmIndex: i + 1, runInBackground: false });
  f('subagent.started', { subagentId });
  return subagentId;
};
const stepsNow = async (h, cid) => (await getCluster(h, cid)).steps;
const settled = (h, cid, n, what) => until(async () => (await stepsNow(h, cid)) === n, 15000, what);

// The chat room's own counting over the events of a conversation: the main agent's tool calls
// that are not under a card, and per card what stepCount says (the number on "N 個步驟").
function chatRoom(events) {
  const t = Object.create(Transcript.prototype);
  Object.assign(t, { events: new Map(), order: [], users: [], agentIds: [], mainTools: [], kids: new Map(), lastOf: new Map(), nodes: new Map(), dirty: new Set(), deferred: new Set(), dirtyGroups: new Set(), stepsOlder: new Map() });
  t.markDirty = () => {};
  t.makeNode = () => ({});
  t.mount = () => {};
  for (const ev of events) t.add(structuredClone(ev));
  const cards = events.filter((e) => e.type === 'tool_use' && !e.parent && e.subagent);
  return { perCard: cards.map((c) => t.stepCount(c.id)), mainLevel: events.filter((e) => isStep(e) && !e.parent).length };
}

before(async () => {
  hub = await startRealHub('cluster-steps');
  hubs.push(hub);
  await hub.setDeepseekKey();
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const k = groups.find((g) => g.provider === 'kimi').models[0];
  KIMI = { model: k.id, effort: k.efforts[0] };
  hub.machine.autoReply = false;
});
after(async () => {
  for (const h of hubs.reverse()) await h.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a step is a tool call, counted by one definition: the same events give the same number in the chat room\'s card and in the cluster', async () => {
  const w = await oneWorker(hub);
  // The main agent: two calls, then a swarm of five whose members take three steps each, then one more call.
  tool(w.f, 'M1', 'ls');
  tool(w.f, 'M2', 'git status');
  swarmCall(w.f, 'SW', 5);
  const ids = [0, 1, 2, 3, 4].map((i) => member(w.f, i, 'SW'));
  for (const id of ids) for (const n of [1, 2, 3]) tool(w.f, `${id}-t${n}`, `step ${n}`, id);
  tool(w.f, 'M3', 'npm test');
  // 3 main-agent calls + the AgentSwarm call itself (a call of the main agent) + 15 of the members.
  await settled(hub, w.cid, 19, 'the cluster counted 19 steps');
  const c = await getCluster(hub, w.cid);
  assert.equal(c.steps, 19);
  assert.equal(c.workers[0].steps, 19);
  assert.equal(c.stepsUnknown, 0);

  const events = (await snap(hub, w.sid)).events;
  const room = chatRoom(events);
  assert.deepEqual(room.perCard, [15], 'the chat room\'s card for the swarm says 15 個步驟');
  assert.equal(room.mainLevel, 4, 'and the main agent\'s own calls are the rest');
  assert.equal(room.perCard.reduce((a, n) => a + n, 0) + room.mainLevel, c.steps, 'the cluster is the sum of the two, nothing else');
  assert.equal(countSteps(events), c.steps, 'one function counts them');
  assert.equal(c.workers[0].subagents.reduce((a, s) => a + s.steps, 0), 15, 'and the subagents\' own list says the same 15');
  // The overview row has it, too.
  assert.equal((await hub.api('GET', '/clusters')).find((r) => r.id === w.cid).steps, 19);
});

test('the subagents that rolled out of the newest-160 list are counted all the same: the count is over the conversation\'s events, not over the list', async () => {
  const w = await oneWorker(hub);
  swarmCall(w.f, 'SW', 170);
  const ids = Array.from({ length: 170 }, (_, i) => member(w.f, i, 'SW'));
  for (const id of ids) {
    tool(w.f, `${id}-a`, 'one', id);
    tool(w.f, `${id}-b`, 'two', id);
  }
  // 1 swarm call + 340 steps of 170 subagents.
  await settled(hub, w.cid, 341, 'every step of the 170 subagents');
  const worker = (await getCluster(hub, w.cid)).workers[0];
  assert.equal(worker.subagents.length, 160, 'the premise: the list holds only the newest 160');
  assert.ok(worker.subagents.reduce((a, s) => a + s.steps, 0) < 340, 'so the list alone would count fewer');
  assert.equal(worker.steps, 341);
});

test('it follows the cluster live: the next step is in the next pushed cluster, and the number only counts what happened (no worker, no total over clusters)', async () => {
  const w = await oneWorker(hub);
  const ws = new WebSocket(`ws://127.0.0.1:${hub.PORT}/ws`);
  const msgs = [];
  ws.on('message', (d) => {
    try {
      msgs.push(JSON.parse(d));
    } catch {}
  });
  await new Promise((r) => ws.on('open', r));
  tool(w.f, 'L1', 'ls');
  await until(async () => msgs.some((m) => m.t === 'cluster' && m.cluster.id === w.cid && m.cluster.steps === 1), 6000, 'a pushed cluster with 1 step');
  tool(w.f, 'L2', 'ls -la');
  tool(w.f, 'L3', 'pwd');
  await until(async () => msgs.some((m) => m.t === 'cluster' && m.cluster.id === w.cid && m.cluster.steps === 3), 6000, 'a pushed cluster with 3 steps');
  ws.close();
  // Two clusters side by side each say their own; the Hub adds nothing up.
  const rows = await hub.api('GET', '/clusters');
  const mine = rows.find((r) => r.id === w.cid);
  assert.equal(mine.steps, 3);
  assert.ok(rows.length > 1);
  assert.ok(!Object.keys(rows).some((k) => /steps|total/i.test(k)), 'a list of rows, no summary object');
});

test('a worker whose conversation was deleted keeps the steps it had when last seen; a worker never counted is said to be unknown, not zero', async () => {
  const w = await oneWorker(hub);
  tool(w.f, 'D1', 'ls');
  tool(w.f, 'D2', 'ls');
  await settled(hub, w.cid, 2, 'two steps');
  await hub.api('DELETE', `/sessions/${w.sid}`);
  const c = await getCluster(hub, w.cid);
  assert.equal(c.workers[0].status, 'deleted');
  assert.equal(c.steps, 2, 'what it had done is not forgotten');
  assert.equal(c.stepsUnknown, 0);

  // A record from before steps were counted, whose conversation is gone: unknown, and the cluster does not pretend.
  const first = await startRealHub('cluster-steps-old-1');
  hubs.push(first);
  await first.setDeepseekKey();
  const parent = await newKimi(first);
  const r = await first.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '甲', prompt: '做甲' }], isolate: false });
  await until(async () => (await getCluster(first, r.cluster.id)).status === 'done', 15000, 'done');
  await first.halt();
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-steps-keep-'));
  fs.cpSync(first.DATA, keep, { recursive: true });
  const file = path.join(keep, 'clusters', `${r.cluster.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete rec.workers[0].stepsSeen;
  fs.writeFileSync(file, JSON.stringify(rec));
  fs.rmSync(path.join(keep, 'sessions', `${r.cluster.workers[0].sessionId}.json`), { force: true });
  const second = await startRealHub('cluster-steps-old-2', { seed: (DATA) => fs.cpSync(keep, DATA, { recursive: true }) });
  hubs.push(second);
  fs.rmSync(keep, { recursive: true, force: true });
  const old = await getCluster(second, r.cluster.id);
  assert.equal(old.workers[0].status, 'deleted');
  assert.equal(old.steps, null);
  assert.equal(old.stepsUnknown, 1);
  const view = stepsView(old.steps, old.stepsUnknown);
  assert.equal(view.shown, false, 'nothing is shown rather than a made-up 0');
});

test('how the number reads: "483 步" on a card, "共 483 步" in the head, the unknown said in the tip, nothing for a cluster that did not say', () => {
  assert.deepEqual([stepsView(483).text, stepsView(483).long], ['483 步', '共 483 步']);
  assert.equal(stepsView(12345).text, '12,345 步');
  assert.equal(stepsView(0).text, '0 步', 'a measured zero is a zero');
  assert.match(stepsView(5, 2).title, /有 2 個工作者的對話已刪除/);
  for (const bad of [null, undefined, NaN, -1, '12']) assert.equal(stepsView(bad).shown, false);
});
