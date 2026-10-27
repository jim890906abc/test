// The switch itself: one switch at a time per conversation, a waiting switch
// that can be called off and survives a restart, nothing half-made visible
// or left behind, the hand-off taken at the last moment, and everything that
// sends "later" going to the current leaf.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupHub, until, wait } from './fixtures/hub-harness.mjs';
import { createScheduler } from '../server/schedule.js';

let hub;
before(async () => {
  hub = await setupHub('chain-core');
});
after(() => hub.close());

const file = (id) => path.join(hub.TMP, 'data', 'sessions', `${id}.json`);
const disk = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
const leavesOf = (a) => hub.store.listLeaves().filter((x) => x.conversationId === a.conversationId).map((x) => x.id);
const gate = () => {
  let release;
  const p = new Promise((r) => (release = r));
  return { p, release };
};
const busy = (n) => {
  n.status = 'running';
  n.meta = { ...(n.meta || {}), turnProvider: 'kimi', turnModel: 'kimi/k2', turnEffort: 'on' };
  return n;
};
const idle = (n) => hub.runner.liveContext(n).setStatus('idle');
// Wait until a NEW Claude create has started (earlier tests already made some).
const claudeEntered = (n0) => until(() => hub.claude.entered.length > n0 && hub.claude.entered.at(-1), 2000, 'a Claude create to start');

// ------------------------------------------------------------ waiting switch

test('choosing the original provider again calls off the waiting switch; the last choice wins', async () => {
  const a = busy(hub.kimiNode());
  const waiting = await hub.runner.switchProvider(a, hub.CLAUDE);
  assert.equal(waiting.pendingProvider.provider, 'claude');
  const back = await hub.runner.switchProvider(a, hub.KIMI);
  assert.equal(back.pendingProvider, null, 'the summary no longer promises Claude');
  assert.equal(a.state.pendingProvider ?? null, null);
  assert.equal(a.meta.pendingSwitch, undefined);
  assert.ok(a.events.some((e) => e.type === 'info' && /取消/.test(e.text)), 'the cancellation is visible in the conversation');
  const creates = hub.claude.calls.create.length;
  idle(a);
  await wait(150);
  assert.equal(a.continuedTo, null, 'the turn ending does not switch');
  assert.equal(hub.claude.calls.create.length, creates, 'Claude was never created or asked');
  assert.deepEqual(leavesOf(a), [a.id]);
});

test('a second choice replaces the first waiting one', async () => {
  const a = busy(hub.kimiNode());
  await hub.runner.switchProvider(a, hub.CLAUDE);
  const second = await hub.runner.switchProvider(a, hub.DEEPSEEK);
  assert.equal(second.pendingProvider.provider, 'deepseek');
  const creates = hub.claude.calls.create.length;
  idle(a);
  await until(() => a.provider === 'deepseek', 3000, 'the Kimi→DeepSeek change at idle');
  assert.equal(hub.claude.calls.create.length, creates, 'the replaced choice (Claude) never ran');
  assert.equal(a.continuedTo, null, 'same Kimi runtime: no new node');
});

test('Kimi↔DeepSeek during a turn waits for the turn to end instead of calling /profile at once', async () => {
  const a = busy(hub.kimiNode());
  const before = hub.kimi.calls.configure.length;
  const r = await hub.runner.switchProvider(a, hub.DEEPSEEK);
  assert.equal(hub.kimi.calls.configure.length, before, 'no /profile while the turn runs');
  assert.equal(a.provider, 'kimi', 'the running turn is still Kimi');
  assert.equal(a.modelConfig.provider, 'kimi');
  assert.equal(r.pendingProvider.provider, 'deepseek');
  assert.equal(a.meta.turnProvider, 'kimi');
  idle(a);
  await until(() => a.provider === 'deepseek', 3000, 'applied at idle');
  const calls = hub.kimi.calls.configure.slice(before).filter((c) => c.id === a.id);
  assert.equal(calls.length, 1, 'exactly one /profile, after the turn');
  assert.equal(calls[0].status, 'idle', 'made when the turn was over');
  assert.equal(a.state.pendingProvider ?? null, null);
});

test('a waiting switch is written at once, not 1.5 s later (a restart right after still has it)', async () => {
  const a = busy(hub.kimiNode());
  await hub.runner.switchProvider(a, hub.CLAUDE);
  const seen = await until(() => {
    try {
      return disk(a.id).state?.pendingProvider;
    } catch {
      return null;
    }
  }, 600, 'the waiting switch on disk well inside the save delay');
  assert.equal(seen.provider, 'claude');
  await hub.runner.switchProvider(a, hub.KIMI); // tidy: call it off
});

test('a waiting switch survives a real reload from disk and runs exactly once when its machine is online', async () => {
  const a = busy(hub.kimiNode());
  a.events.push({ id: 'e_before', ts: 10, type: 'user', text: 'before the restart' });
  await hub.runner.switchProvider(a, hub.CLAUDE);
  hub.store.flushAll();
  await until(() => disk(a.id).state?.pendingProvider, 1500, 'persisted');
  // "Restart": the sessions come back from the files, a running turn becomes idle.
  hub.store.loadSessions();
  const reloaded = hub.store.getSession(a.id);
  assert.notEqual(reloaded, a, 'this is a different object, read from the file');
  assert.equal(reloaded.status, 'idle');
  assert.equal(reloaded.state.pendingProvider.provider, 'claude');
  const creates = hub.claude.calls.create.length;
  hub.runner.restoreLiveSessions();
  hub.runner.resumePendingSwitches('m1'); // the machine's hello fires this too
  await until(() => reloaded.continuedTo, 3000, 'the switch after the restart');
  await wait(150);
  assert.equal(hub.claude.calls.create.length, creates + 1, 'attempted once');
  const node = hub.store.getSession(reloaded.continuedTo);
  assert.equal(node.provider, 'claude');
  assert.match(node.handoff.text, /before the restart/);
  assert.equal(reloaded.state.pendingProvider ?? null, null);
});

// ------------------------------------------------------------------ one at a time

test('two switches at once make one node; the other is refused, and nothing is left over', async () => {
  const a = hub.kimiNode();
  const g = gate();
  hub.claude.gate = g.p;
  const n0 = hub.claude.entered.length;
  const first = hub.runner.switchProvider(a, hub.CLAUDE);
  await claudeEntered(n0);
  const before = hub.claude.entered.length;
  await assert.rejects(hub.runner.switchProvider(a, hub.CLAUDE), (e) => e.status === 409 && /切換/.test(e.message));
  await assert.rejects(hub.runner.switchProvider(a, hub.DEEPSEEK), (e) => e.status === 409);
  assert.equal(hub.claude.entered.length, before, 'the refused switch never reached Claude');
  g.release();
  const node = await first;
  assert.deepEqual(leavesOf(a), [node.id], 'exactly one leaf');
  assert.equal(hub.claude.calls.create.filter((c) => hub.store.getSession(c.id)?.conversationId === a.conversationId || c.id === node.id).length, 1, 'Claude was created once for this conversation');
});

test('while a switch is in progress the old leaf takes no message (it would miss the hand-off), and takes them again after', async () => {
  const a = hub.kimiNode();
  const g = gate();
  hub.claude.gate = g.p;
  const n0 = hub.claude.entered.length;
  const sw = hub.runner.switchProvider(a, hub.CLAUDE);
  await claudeEntered(n0);
  assert.throws(() => hub.runner.startTurn(a, 'SECOND-MESSAGE'), (e) => e.status === 409);
  await assert.rejects(hub.runner.deliver(a, 'SECOND-MESSAGE'), /切換/);
  assert.equal(a.events.some((e) => /SECOND-MESSAGE/.test(e.text || '')), false, 'nothing was written into the old node');
  assert.equal(hub.runner.isSwitching(a), true);
  g.release();
  await sw;
  assert.equal(hub.runner.isSwitching(a), false, 'the lock is released');
});

test('the hand-off is taken at the last moment: a change in the old leaf during the switch cancels it explicitly, and a retry carries it', async () => {
  const a = hub.kimiNode();
  a.events.push({ id: 'e1', ts: 1, type: 'user', text: 'first question' });
  const g = gate();
  hub.claude.gate = g.p;
  const n0 = hub.claude.entered.length;
  const sw = hub.runner.switchProvider(a, hub.CLAUDE);
  const failed = assert.rejects(sw, (e) => e.status === 409 && /再試|重試|再選/.test(e.message));
  const nodeId = await claudeEntered(n0);
  // Something reaches the old node anyway (a person typing in the terminal).
  a.events.push({ id: 'e2', ts: 2, type: 'user', text: 'typed in the terminal meanwhile' });
  g.release();
  await failed;
  assert.equal(a.continuedTo, null, 'the old leaf is still the leaf');
  assert.equal(hub.store.getSession(nodeId), undefined, 'the half-made node is gone');
  assert.ok(hub.claude.calls.dispose.includes(nodeId), 'its Claude session was disposed');
  assert.deepEqual(leavesOf(a), [a.id]);
  const retry = await hub.runner.switchProvider(a, hub.CLAUDE);
  assert.match(hub.store.getSession(retry.id).handoff.text, /typed in the terminal meanwhile/);
  assert.equal(hub.claude.calls.create.findLast((c) => c.id === retry.id).handoff.includes('typed in the terminal meanwhile'), true, 'and Claude was handed it');
});

// ------------------------------------------------------- half-made nodes

test('while it is made the new node is provisional: hidden from the leaf list and from the broadcasts', async () => {
  const a = hub.claudeNode();
  const seen = [];
  const original = hub.ADAPTERS['kimi-remote'].attach;
  const g = gate();
  hub.ADAPTERS['kimi-remote'].attach = async (s) => {
    const n = hub.store.getSession(s.id);
    seen.push({ provisional: n.provisional, leaves: hub.store.listLeaves().map((x) => x.id), upstreamTo: a.continuedTo });
    hub.runner.liveContext(n).setMeta({ note: 'adapter talks about the new node' });
    await g.p;
    return original(s);
  };
  try {
    const sw = hub.runner.switchProvider(a, hub.KIMI);
    await until(() => seen.length, 2000, 'attach reached');
    const nodeId = [...hub.store.listSessions()].find((x) => x.continuedFrom === a.id)?.id;
    assert.ok(nodeId, 'the node exists in the store');
    assert.equal(seen[0].provisional, true);
    assert.equal(seen[0].leaves.includes(nodeId), false, 'not listed as a leaf');
    assert.equal(seen[0].leaves.includes(a.id), true, 'the old leaf is still the leaf');
    assert.equal(seen[0].upstreamTo, null);
    assert.equal(hub.broadcasts.some((m) => (m.t === 'session' && m.session.id === nodeId) || m.sid === nodeId), false, 'nothing about it was broadcast yet');
    g.release();
    await sw;
    assert.equal(hub.store.getSession(nodeId).provisional, undefined);
    assert.equal(a.continuedTo, nodeId);
    assert.deepEqual(leavesOf(a), [nodeId]);
  } finally {
    hub.ADAPTERS['kimi-remote'].attach = original;
  }
});

test('a Hub that stopped while a node was being made recovers: the orphan is removed, its sessions are cleaned up, the old leaf stays the leaf', async () => {
  for (const [label, make, target] of [
    ['Claude target', () => hub.kimiNode(), hub.CLAUDE],
    ['Kimi target', () => hub.claudeNode(), hub.KIMI],
  ]) {
    const a = make();
    const g = gate();
    const originalAttach = hub.ADAPTERS['kimi-remote'].attach;
    if (target.provider === 'claude') hub.claude.gate = g.p;
    else hub.ADAPTERS['kimi-remote'].attach = async (s) => { await g.p; return originalAttach(s); };
    const sw = hub.runner.switchProvider(a, target);
    sw.catch(() => {});
    const orphanId = await until(() => [...hub.store.listSessions()].find((x) => x.provisional && x.continuedFrom === a.id)?.id, 2000, `${label}: provisional node stored`);
    hub.store.flushAll();
    await until(() => { try { return disk(orphanId).provisional; } catch { return null; } }, 1500, `${label}: provisional node on disk`);
    const nativeOfOrphan = hub.store.getSession(orphanId).kimiSessionId;
    // The old one finished before the "crash"; reload everything from the files.
    hub.store.flushAll();
    await wait(100);
    hub.store.loadSessions();
    const rpcBefore = hub.rpc.length;
    hub.runner.restoreLiveSessions();
    assert.equal(hub.store.getSession(orphanId), undefined, `${label}: orphan node removed at start`);
    const old = hub.store.getSession(a.id);
    assert.equal(old.continuedTo ?? null, null);
    assert.deepEqual(leavesOf(old), [a.id], `${label}: the old node is the one leaf`);
    assert.deepEqual(hub.store.chainOf(old).map((x) => x.id), [a.id]);
    if (target.provider === 'claude') assert.ok(hub.claude.calls.dispose.includes(orphanId), 'Claude session disposed');
    else {
      await until(() => hub.rpc.slice(rpcBefore).some((r) => r.op === 'kimi.request' && /:archive/.test(JSON.stringify(r.args)) && JSON.stringify(r.args).includes(nativeOfOrphan)), 2000, 'the orphan\'s native Kimi session archived');
    }
    // Let the abandoned call end without trace.
    hub.claude.failCreate = new Error('abandoned');
    hub.kimi.failConfigure = new Error('abandoned');
    g.release();
    await sw.catch(() => {});
    hub.claude.failCreate = null;
    hub.kimi.failConfigure = null;
    hub.ADAPTERS['kimi-remote'].attach = originalAttach;
  }
});

// ------------------------------------------------ hand-off names the runtime left

test('the hand-off names the runtime the user just left, not the first one of the chain', async () => {
  const a = hub.kimiNode();
  a.events.push({ id: 'k1', ts: 1, type: 'user', text: 'asked on Kimi' });
  const b = hub.store.getSession((await hub.runner.switchProvider(a, hub.CLAUDE)).id);
  b.events.push({ id: 'c1', ts: 2, type: 'user', text: 'asked on Claude' });
  const c = hub.store.getSession((await hub.runner.switchProvider(b, hub.DEEPSEEK)).id);
  assert.equal(c.handoff.fromProvider, 'claude');
  assert.equal(c.handoff.chainStartProvider, 'kimi');
  assert.deepEqual(c.handoff.chainProviders, ['kimi', 'claude']);
  assert.match(c.handoff.text, /prior conversation history from Claude/);
  assert.doesNotMatch(c.handoff.text, /prior conversation history from Kimi/);
  assert.match(c.handoff.text, /Kimi/, 'the earlier runtime is still named');
  const note = c.events.find((e) => e.type === 'info' && /已從/.test(e.text));
  assert.match(note.text, /已從 Claude 接續/);
  // And on to a fourth node: the source is DeepSeek now.
  const d = hub.store.getSession((await hub.runner.switchProvider(c, hub.CLAUDE)).id);
  assert.equal(d.handoff.fromProvider, 'deepseek');
  assert.deepEqual(d.handoff.chainProviders, ['kimi', 'claude', 'deepseek']);
});

// ------------------------------------------------ things sent "later"

test('messages set to go out later follow the leaf; the old node and its auto-pause are retired', async () => {
  hub.kimi.live = true;
  hub.claude.live = true;
  try {
    const a = hub.kimiNode();
    const t = Date.now() - 1000;
    a.scheduled = [{ id: 'q1', text: 'ping later', at: t, createdAt: t - 5, attempts: 0, retryAt: 0, error: null, wait: null }];
    a.autoPause = { enabled: true, threshold: 90, phase: 'paused', reason: 'manual', resumeText: '繼續', log: [] };
    assert.ok(hub.runner.autoPauseSessions().some((s) => s.id === a.id));
    const leaf = hub.store.getSession((await hub.runner.switchProvider(a, hub.CLAUDE)).id);

    assert.deepEqual((leaf.scheduled || []).map((x) => x.id), ['q1'], 'the scheduled message moved to the new leaf');
    assert.deepEqual(a.scheduled || [], [], 'and is no longer on the old node');
    assert.equal(a.autoPause, null, 'the old node\'s auto-pause is cleared, not just unwatched');
    assert.equal(hub.runner.schedulableSessions().some((s) => s.id === a.id), false);
    assert.equal(hub.runner.schedulableSessions().some((s) => s.id === leaf.id), true);
    assert.equal(hub.runner.autoPauseSessions().some((s) => s.id === a.id), false, 'the old Kimi node is no longer watched');
    assert.ok(leaf.events.some((e) => e.type === 'info' && /自動暫停/.test(e.text)), 'the retirement is said in the conversation');

    const sched = createScheduler({
      sessions: () => hub.runner.schedulableSessions(),
      online: () => true,
      send: (s, text, opts) => hub.runner.deliver(s, text, opts),
      cannotSend: () => null,
      changed: () => {},
      newId: () => 'q_x',
      timings: { tick: 5000, retry: [30000], late: 120000 },
    });
    await sched.tick();
    assert.equal(hub.claude.calls.send.filter((c) => c.id === leaf.id && c.text === 'ping later').length, 1, 'delivered to the Claude leaf');
    assert.equal(hub.kimi.calls.send.some((c) => c.id === a.id && c.text === 'ping later'), false, 'never to the old Kimi node');
    assert.deepEqual(leaf.scheduled, [], 'and it is done');
  } finally {
    hub.kimi.live = false;
    hub.claude.live = false;
  }
});

test('whatever still holds an old node (a resume, a late result) delivers to the current leaf', async () => {
  hub.kimi.live = true;
  hub.claude.live = true;
  try {
    const a = hub.kimiNode();
    const leaf = hub.store.getSession((await hub.runner.switchProvider(a, hub.CLAUDE)).id);
    await hub.runner.deliver(a, '繼續');
    assert.equal(hub.claude.calls.send.filter((c) => c.id === leaf.id && c.text === '繼續').length, 1);
    assert.equal(hub.kimi.calls.send.some((c) => c.id === a.id), false);
  } finally {
    hub.kimi.live = false;
    hub.claude.live = false;
  }
});

test('a background sub-agent that finishes after its parent was switched reports to the new leaf', async () => {
  hub.claude.live = true;
  try {
    const parent = hub.kimiNode({ meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } } });
    const g = gate();
    hub.kimi.runGate = g.p;
    const started = await hub.runner.delegateToProvider(parent, { task: 'long job', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true });
    assert.equal(started.background, true);
    const leaf = hub.store.getSession((await hub.runner.switchProvider(parent, hub.CLAUDE)).id);
    assert.ok(leaf.events.some((e) => e.type === 'info' && /背景子代理/.test(e.text)), 'the switch says a background sub-agent is still running');
    g.release();
    await until(() => hub.claude.calls.send.some((c) => c.id === leaf.id && /long job/.test(c.text)) || leaf.events.some((e) => e.type === 'info' && /long job/.test(e.text)), 3000, 'the result reaches the new leaf');
    const sent = hub.claude.calls.send.find((c) => c.id === leaf.id && /long job/.test(c.text));
    assert.match(sent.text, /kimi reply/, 'with the child\'s answer');
  } finally {
    hub.claude.live = false;
  }
});

// ------------------------------------------------ the default sub-agent

test('filling in the default sub-agent does not touch updatedAt', () => {
  const s = hub.kimiNode();
  delete s.meta.subagent;
  s.updatedAt = 1234;
  hub.runner.ensureDefaultSubagent(s);
  assert.ok(s.meta.subagent, 'the default was filled in');
  assert.equal(s.updatedAt, 1234);
});

test('only leaves are ever offered to the scheduler and to auto-pause, whatever an old node still holds', () => {
  const oldNode = hub.kimiNode({ continuedTo: 'does-not-matter' });
  const leaf = hub.kimiNode({ conversationId: oldNode.conversationId, continuedFrom: oldNode.id });
  oldNode.continuedTo = leaf.id;
  const item = { id: 'q_stranded', text: 'x', at: 1, createdAt: 1, attempts: 0, retryAt: 0, error: null, wait: null };
  oldNode.scheduled = [item];
  oldNode.autoPause = { enabled: true, threshold: 90, phase: 'watching', log: [] };
  leaf.scheduled = [{ ...item, id: 'q_leaf' }];
  leaf.autoPause = { enabled: true, threshold: 90, phase: 'watching', log: [] };
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(hub.runner.schedulableSessions()).filter((id) => [oldNode.id, leaf.id].includes(id)), [leaf.id]);
  assert.deepEqual(ids(hub.runner.autoPauseSessions()).filter((id) => [oldNode.id, leaf.id].includes(id)), [leaf.id]);
  oldNode.scheduled = [];
  oldNode.autoPause = null;
  leaf.scheduled = [];
  leaf.autoPause = null;
});

test('a store written before this fix, with messages still scheduled on an old node, hands them to the leaf at start (nothing is silently lost)', () => {
  const oldNode = hub.kimiNode();
  const leaf = hub.kimiNode({ conversationId: oldNode.conversationId, continuedFrom: oldNode.id });
  oldNode.continuedTo = leaf.id;
  const stamp = oldNode.updatedAt = leaf.updatedAt = 4321;
  oldNode.scheduled = [{ id: 'q_old', text: 'send me later', at: Date.now() + 60000, createdAt: 1, attempts: 0, retryAt: 0, error: null, wait: null }];
  oldNode.autoPause = { enabled: true, threshold: 90, phase: 'paused', reason: 'manual', resumeText: '繼續', log: [] };
  hub.runner.restoreLiveSessions();
  assert.deepEqual((leaf.scheduled || []).map((x) => x.id), ['q_old']);
  assert.deepEqual(oldNode.scheduled || [], []);
  assert.equal(oldNode.autoPause, null);
  assert.ok(leaf.events.some((e) => e.type === 'info' && /定時送出/.test(e.text)), 'said in the conversation');
  assert.equal(leaf.updatedAt, stamp, 'start-up repair is not activity');
  leaf.scheduled = [];
});

test('a crash after the old end was written but before the new node was made real: the next start removes the orphan and unlinks the old leaf', async () => {
  const oldNode = hub.claudeNode();
  const orphan = hub.store.createSession({ agentId: 'claude', provider: 'claude', conversationId: oldNode.conversationId, continuedFrom: oldNode.id, provisional: true, cwd: '/tmp/a' });
  oldNode.continuedTo = orphan.id; // the old end already says "continued"
  await hub.store.persistNow(oldNode);
  await hub.store.persistNow(orphan);
  hub.store.loadSessions();
  hub.runner.restoreLiveSessions();
  const old = hub.store.getSession(oldNode.id);
  assert.equal(hub.store.getSession(orphan.id), undefined);
  assert.equal(old.continuedTo ?? null, null);
  assert.deepEqual(leavesOf(old), [old.id]);
});

// ------------------------------------------------ a hidden sub-agent waiting for you

test('a sub-agent waiting for permission shows on its parent conversation (the sidebar hides the sub-agent itself)', async () => {
  const parent = hub.kimiNode({ meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } } });
  const g = gate();
  hub.kimi.runGate = g.p;
  const started = await hub.runner.delegateToProvider(parent, { task: 'needs approval', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true });
  const child = hub.store.getSession(started.childSessionId);
  assert.equal(hub.runner.summarize(parent).pendingChildPermission, false);
  const mark = hub.broadcasts.length;

  hub.runner.liveContext(child).setStatus('awaiting_permission');
  assert.equal(hub.runner.summarize(parent).pendingChildPermission, true);
  const told = hub.broadcasts.slice(mark).filter((m) => m.t === 'session' && m.session.id === parent.id);
  assert.ok(told.length && told.at(-1).session.pendingChildPermission === true, 'the page is told about the parent, not only about the hidden child');
  assert.equal(hub.runner.summarize(parent).status, 'idle', 'the parent\'s own status is left alone');

  hub.runner.liveContext(child).setStatus('running');
  assert.equal(hub.runner.summarize(parent).pendingChildPermission, false);
  assert.equal(hub.broadcasts.slice(mark).filter((m) => m.t === 'session' && m.session.id === parent.id).at(-1).session.pendingChildPermission, false, 'and told when it clears');
  g.release();
  await until(() => !hub.runner.summarize(parent).pendingChildPermission && child.events.some((e) => e.type === 'turn_end'), 3000, 'the child finished');
});

test('...also from a sub-agent of a sub-agent, and through a switched parent', async () => {
  const parent = hub.kimiNode({ meta: { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } } });
  const g1 = gate();
  hub.kimi.runGate = g1.p;
  const a = await hub.runner.delegateToProvider(parent, { task: 'level one', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true });
  const child = hub.store.getSession(a.childSessionId);
  child.meta = { ...child.meta, subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } };
  const g2 = gate();
  hub.kimi.runGate = g2.p;
  const b = await hub.runner.delegateToProvider(child, { task: 'level two', provider: 'kimi', model: 'kimi/k2', effort: 'on', background: true });
  const grandchild = hub.store.getSession(b.childSessionId);
  hub.runner.liveContext(grandchild).setStatus('awaiting_permission');
  assert.equal(hub.runner.summarize(parent).pendingChildPermission, true, 'two levels down still reaches the conversation');
  const leaf = hub.store.getSession((await hub.runner.switchProvider(parent, hub.CLAUDE)).id);
  assert.equal(hub.runner.summarize(leaf).pendingChildPermission, true, 'and the new leaf of the chain carries it');
  hub.runner.liveContext(grandchild).setStatus('running');
  g1.release();
  g2.release();
  await until(() => !hub.runner.summarize(leaf).pendingChildPermission, 3000, 'cleared');
});

// ------------------------------------------------ the rest of the lifecycle

test('a waiting switch can be called off on its own, without choosing a provider', async () => {
  const a = busy(hub.kimiNode());
  await hub.runner.switchProvider(a, hub.CLAUDE);
  const r = hub.runner.cancelPendingSwitch(a);
  assert.equal(r.pendingProvider, null);
  assert.equal(a.state.pendingProvider ?? null, null);
  assert.ok(a.events.some((e) => e.type === 'info' && /取消/.test(e.text)));
  // Nothing waiting: not an error, nothing changes.
  assert.equal(hub.runner.cancelPendingSwitch(a).pendingProvider, null);
  const creates = hub.claude.calls.create.length;
  idle(a);
  await wait(150);
  assert.equal(hub.claude.calls.create.length, creates);
});

test('a conversation in the middle of a switch cannot be deleted from under it', async () => {
  const a = hub.kimiNode();
  const g = gate();
  hub.claude.gate = g.p;
  const n0 = hub.claude.entered.length;
  const sw = hub.runner.switchProvider(a, hub.CLAUDE);
  await claudeEntered(n0);
  assert.throws(() => hub.runner.deleteConversation(a), (e) => e.status === 409 && /切換/.test(e.message));
  assert.ok(hub.store.getSession(a.id), 'still there');
  g.release();
  const node = await sw;
  assert.equal(hub.runner.deleteConversation(a).ok, true);
  assert.equal(hub.store.getSession(node.id), undefined);
  assert.equal(hub.store.getSession(a.id), undefined);
});

test('after a restart a waiting switch holds back while Kimi itself still says the conversation is working, then goes ahead', async () => {
  const a = busy(hub.kimiNode());
  await hub.runner.switchProvider(a, hub.CLAUDE);
  hub.store.flushAll();
  await until(() => disk(a.id).state?.pendingProvider, 1500, 'persisted');
  hub.store.loadSessions(); // restart: the Hub's status for it is idle...
  const node = hub.store.getSession(a.id);
  // ...and the machine connects again, without having said anything yet.
  hub.ws.emit('message', JSON.stringify({ t: 'hello', machineId: 'm1', name: 'M1', platform: 'linux', home: '/tmp', bridgeVersion: '0.9.0', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
  const creates = hub.claude.calls.create.length;
  hub.runner.restoreLiveSessions();
  hub.runner.resumePendingSwitches('m1');
  await wait(200);
  assert.equal(node.continuedTo ?? null, null, 'not switched before the machine says what it is doing');
  // It lists its conversations: Kimi says this one is still working.
  hub.ws.emit('message', JSON.stringify({ t: 'kimi.sessions', items: [{ id: node.kimiSessionId, title: 'x', busy: true, metadata: { cwd: '/tmp' } }] }));
  hub.runner.resumePendingSwitches('m1');
  await wait(200);
  assert.equal(node.continuedTo ?? null, null, 'not switched under a turn Kimi is still running');
  assert.equal(hub.claude.calls.create.length, creates);
  assert.ok(node.state.pendingProvider, 'and still waiting');
  // Kimi finishes; the machine says so.
  hub.ws.emit('message', JSON.stringify({ t: 'kimi.session.update', item: { id: node.kimiSessionId, title: 'x', busy: false, metadata: { cwd: '/tmp' } } }));
  await until(() => node.continuedTo, 3000, 'the switch once Kimi stopped');
  assert.equal(hub.claude.calls.create.length, creates + 1);
});
