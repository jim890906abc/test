// What the sidebar lists (public/js/sidebar-model.js, spec §14), tested directly
// in node on the module the page loads: the two source categories, which
// sessions never get a row, how a search and the saved fold state combine, and
// the provider a row names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, newChildIndex, rememberChildren, parseSideSections, sidebarSections, rowProviderView, originOf } from '../public/js/sidebar-model.js';
import { providerOf, modelConfigOf } from '../public/js/providers.js';

// ---------------------------------------------------------- sidebar

const NOWS = 1_700_000_000_000;
const hubSession = (id, patch = {}) => ({ id, conversationId: id, title: id, status: 'idle', origin: 'hub', provider: 'kimi', updatedAt: NOWS, continuedFrom: null, continuedTo: null, meta: {}, ...patch });
const sample = () => [
  hubSession('k', { provider: 'kimi', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'nk', updatedAt: NOWS + 5 }),
  hubSession('c', { provider: 'claude', agentId: 'claude', updatedAt: NOWS + 4 }),
  hubSession('d', { provider: 'deepseek', mode: 'deepseek', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'nd', updatedAt: NOWS + 3 }),
  hubSession('t', { provider: 'kimi', origin: 'external', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'nt', updatedAt: NOWS + 2 }),
  hubSession('kid', { provider: 'claude', agentId: 'claude', parentId: 'k', origin: 'external', updatedAt: NOWS + 9 }),
];
const machine = (sessions = []) => ({ id: 'm1', name: 'box', online: true, kimi: { available: true }, sessions });

test('spec §14: conversations made in the hub, of all three providers, are 聊天室; terminal ones are 子session; a subagent child is neither', () => {
  const rows = buildRows({ sessions: sample(), machines: [machine()] });
  assert.deepEqual(rows.map((r) => r.conversationId), ['k', 'c', 'd', 't'], 'newest first, and the child has no row');
  const { sections } = sidebarSections(rows);
  const [chat, sub] = sections;
  assert.equal(chat.label, '聊天室');
  assert.deepEqual(chat.rows.map((r) => [r.conversationId, r.provider]), [['k', 'kimi'], ['c', 'claude'], ['d', 'deepseek']]);
  assert.equal(sub.label, '子session');
  assert.deepEqual(sub.rows.map((r) => r.conversationId), ['t']);
  assert.ok(!rows.some((r) => r.hub?.id === 'kid'));
});

test('a subagent child\'s native session does not turn into an external row, whichever way we learn it is a child', () => {
  const native = (id, extra = {}) => ({ id, title: 'child', cwd: '/x', updatedAt: NOWS + 20, ...extra });
  // (1) the hub record is in the list
  const children = rememberChildren(newChildIndex(), sample());
  // the child has no native id in sample(); give it one
  const withNative = sample().map((s) => (s.id === 'kid' ? { ...s, machineId: 'm1', kimiSessionId: 'nkid' } : s));
  const idx = rememberChildren(newChildIndex(), withNative);
  const rows1 = buildRows({ sessions: withNative, machines: [machine([native('nkid')])], children: idx });
  assert.ok(!rows1.some((r) => r.kimi?.id === 'nkid'), 'known child: no row');
  // (2) the page has seen it earlier; the hub record is gone with its parent
  const rows2 = buildRows({ sessions: withNative.filter((s) => s.id !== 'kid'), machines: [machine([native('nkid')])], children: idx });
  assert.ok(!rows2.some((r) => r.kimi?.id === 'nkid'), 'remembered child: still no row after its hub record is deleted');
  // (3) the machine entry says it itself
  const rows3 = buildRows({ sessions: [], machines: [machine([native('nz', { parentId: 'k' })])], children });
  assert.ok(!rows3.some((r) => r.kimi?.id === 'nz'), 'an entry carrying parentId is a child');
  // control: a plain native session IS an external row
  const rows4 = buildRows({ sessions: [], machines: [machine([native('plain')])], children: newChildIndex() });
  assert.deepEqual(rows4.map((r) => [r.kimi?.id, r.origin]), [['plain', 'external']]);
});

test('a continued conversation is one row, in the category of its leaf', () => {
  const chain = [hubSession('a', { continuedTo: 'b', updatedAt: NOWS }), hubSession('b', { conversationId: 'a', continuedFrom: 'a', provider: 'claude', agentId: 'claude', updatedAt: NOWS + 1 })];
  const rows = buildRows({ sessions: chain, machines: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hub.id, 'b');
  assert.equal(rows[0].origin, 'hub');
});

test('folding: the saved choice is the default, and a search opens groups for the moment without changing it', () => {
  const rows = buildRows({ sessions: sample(), machines: [machine()] });
  assert.deepEqual(parseSideSections(null), { chat: true, sub: false }, '聊天室 open, 子session folded by default');
  const saved = parseSideSections('{"sub":true}');
  assert.deepEqual(saved, { chat: true, sub: true });
  assert.deepEqual(parseSideSections('not json'), { chat: true, sub: false });

  const before = JSON.stringify(saved);
  const plain = sidebarSections(rows, { query: '', saved: parseSideSections(null) });
  assert.deepEqual(plain.sections.map((g) => [g.key, g.open]), [['chat', true], ['sub', false]]);

  const found = sidebarSections(rows, { query: 'T', saved: parseSideSections(null) }); // matches only the terminal session
  assert.equal(found.searching, true);
  assert.deepEqual(found.sections.map((g) => [g.key, g.open]), [['sub', true]], 'the folded group opens for the search; an empty one is left out');
  assert.equal(JSON.stringify(saved), before, 'the saved object was not touched by a search');
  assert.deepEqual(parseSideSections(before), saved);
});

test('origin: a parentId node is always external; an old record without origin is a main chat', () => {
  assert.equal(originOf({ parentId: 'x', origin: 'hub' }), 'external');
  assert.equal(originOf({}), 'hub');
  assert.equal(originOf({ origin: 'external' }), 'external');
});

test('a parent whose subagent waits for approval is flagged on its row', () => {
  const rows = buildRows({ sessions: [hubSession('p', { pendingChildPermission: true }), hubSession('q')], machines: [] });
  assert.deepEqual(rows.map((r) => [r.conversationId, r.childWaiting]).sort(), [['p', true], ['q', false]]);
});

// ------------------------------------------------- the provider tag

const rowOf = (hub, status) => ({ hub, status, provider: providerOf(hub) });

test('idle: the tag names the provider the NEXT turn uses, not the stale one of an earlier turn (K then D in the same runtime)', () => {
  const s = hubSession('s', { provider: 'deepseek', mode: 'deepseek', modelConfig: { provider: 'deepseek', model: 'agent-hub-deepseek/x', effort: 'max' }, meta: { turnProvider: 'kimi' } });
  const v = rowProviderView(rowOf(s, 'idle'));
  assert.equal(v.text, 'DeepSeek');
  assert.equal(v.provider, 'deepseek');
  assert.equal(v.pending, false);
  assert.match(v.title, /下一回合/);
});

test('running: the turn\'s own provider is what works; a different next provider is shown as such', () => {
  const s = hubSession('s', { provider: 'kimi', modelConfig: { provider: 'deepseek', model: 'm', effort: '' }, meta: { turnProvider: 'kimi' } });
  const v = rowProviderView(rowOf(s, 'running'));
  assert.equal(v.text, '本回合 Kimi／下一回合 DeepSeek');
  assert.equal(v.pending, true);
  // Same provider: just the name.
  const same = hubSession('s2', { provider: 'claude', agentId: 'claude', modelConfig: { provider: 'claude', model: 'm', effort: '' }, meta: { turnProvider: 'claude' } });
  assert.equal(rowProviderView(rowOf(same, 'running')).text, 'Claude');
});

test('idle with a switch queued to another runtime: the next provider is named as the next turn\'s', () => {
  const s = hubSession('s', { provider: 'kimi', meta: { pendingSwitch: { provider: 'claude', model: 'm', effort: '' } } });
  assert.equal(modelConfigOf(s).provider, 'claude');
  assert.equal(rowProviderView(rowOf(s, 'idle')).text, '下一回合 Claude');
});

test('a native row that the hub does not follow is labelled by what the machine reports', () => {
  const v = rowProviderView({ hub: null, provider: 'deepseek', status: 'idle' });
  assert.equal(v.text, 'DeepSeek');
});

// ------------------------------------------- workers a cluster clean-up hid

test('a worker the cluster clean-up hid (clusterHidden) has no row, whichever way the sidebar would have found it; one that is not hidden still has', () => {
  const worker = (id, patch = {}) => hubSession(id, { provider: 'kimi', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: `n${id}`, clusterId: 'c_0123456789ab', clusterRole: 'worker', ...patch });
  const native = (id) => ({ id, title: 'worker', cwd: '/x', updatedAt: NOWS + 20 });
  const sessions = [worker('w1', { clusterHidden: true }), worker('w2', { clusterHidden: false }), hubSession('main', { provider: 'kimi', agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'nmain' })];

  // The machine lists the worker's native session too: that must not bring the row back as an external one.
  const withMachine = buildRows({ sessions, machines: [machine([native('nw1'), native('nw2'), native('nmain')])] });
  assert.deepEqual(withMachine.map((r) => r.conversationId).sort(), ['main', 'w2']);
  assert.ok(!withMachine.some((r) => r.kimi?.id === 'nw1'), 'and not as a session the hub does not know');

  // The computer is not listed at all (offline, not yet reported): the hub's own record must not bring it back either.
  const noMachine = buildRows({ sessions, machines: [] });
  assert.deepEqual(noMachine.map((r) => r.conversationId).sort(), ['main', 'w2']);

  // Put back: the flag is false, the row is there again.
  const back = buildRows({ sessions: sessions.map((s) => (s.id === 'w1' ? { ...s, clusterHidden: false } : s)), machines: [machine([native('nw1'), native('nw2'), native('nmain')])] });
  assert.deepEqual(back.map((r) => r.conversationId).sort(), ['main', 'w1', 'w2']);

  // A search does not find a hidden worker either.
  const { list } = sidebarSections(withMachine, { query: 'w1' });
  assert.deepEqual(list.map((r) => r.conversationId), []);
});
