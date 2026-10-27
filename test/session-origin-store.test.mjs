// Session origin (server/store.js): new low-level records default to
// external, callers can claim hub, children are always external, and stores
// from before origin existed migrate without hiding old hub conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-origin-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');

const SESSIONS = path.join(TMP, 'sessions');
const file = (id) => path.join(SESSIONS, `${id}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Let background writes finish before a loadSessions() deletes their .tmp.
async function settleWrites() {
  for (let quiet = 0, i = 0; i < 100 && quiet < 3; i++) {
    quiet = fs.readdirSync(SESSIONS).some((f) => f.endsWith('.tmp')) ? 0 : quiet + 1;
    if (quiet < 3) await sleep(10);
  }
}

function legacy(fields) {
  return {
    title: 'legacy',
    status: 'idle',
    events: [],
    state: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...fields,
  };
}

function write(session) {
  fs.writeFileSync(file(session.id), JSON.stringify(session));
}

test('a new record without origin is external; a caller can explicitly claim hub', () => {
  const external = store.createSession({ title: '發現自終端機' });
  assert.equal(external.origin, 'external');
  const hub = store.createSession({ title: 'Hub 建立', origin: 'hub' });
  assert.equal(hub.origin, 'hub');
});

test('a parentId is always external, even when the caller passes hub', () => {
  const child = store.createSession({ title: 'broker child', parentId: 's_parent' });
  assert.equal(child.origin, 'external');
  assert.equal(child.parentId, 's_parent');
  const forced = store.createSession({ title: 'forced child', parentId: 's_parent', origin: 'hub' });
  assert.equal(forced.origin, 'external');
});

test('an origin outside the whitelist is rejected before the session exists', () => {
  const before = store.listSessions().length;
  for (const origin of ['', 'HUB', 'native', 0, false, {}]) {
    assert.throws(() => store.createSession({ title: 'bad', origin }), /origin/);
    assert.throws(() => store.createSession({ title: 'bad child', parentId: 's_parent', origin }), /origin/);
  }
  assert.equal(store.listSessions().length, before);
});

test('old records without origin migrate: parentId external, the rest hub', async () => {
  write(
    legacy({
      id: 's_legacy_main',
      title: '舊主聊天',
      provider: 'claude',
      conversationId: 's_legacy_main',
      continuedFrom: null,
      continuedTo: 's_legacy_leaf',
      meta: { model: 'claude-x', effort: 'high' },
      events: [{ id: 'e_1', type: 'text', text: 'hi', ts: 1 }],
    }),
  );
  write(
    legacy({
      id: 's_legacy_leaf',
      title: '舊接續',
      provider: 'deepseek',
      conversationId: 's_legacy_main',
      continuedFrom: 's_legacy_main',
      continuedTo: null,
      meta: { model: 'agent-hub-deepseek/x' },
      events: [{ id: 'e_2', type: 'text', text: 'continued', ts: 2 }],
    }),
  );
  write(
    legacy({
      id: 's_legacy_child',
      title: '舊 broker child',
      parentId: 's_legacy_main',
      provider: 'kimi',
      conversationId: 's_legacy_main',
      meta: { model: 'kimi-k3' },
      events: [{ id: 'e_3', type: 'text', text: 'child', ts: 3 }],
    }),
  );
  // A value outside the whitelist is not trusted either.
  write(legacy({ id: 's_legacy_bad', origin: 'bogus' }));
  write(legacy({ id: 's_legacy_bad_child', origin: 'bogus', parentId: 's_legacy_main' }));

  await settleWrites();
  store.loadSessions();

  const main = store.getSession('s_legacy_main');
  assert.equal(main.origin, 'hub');
  assert.equal(main.provider, 'claude');
  assert.equal(main.conversationId, 's_legacy_main');
  assert.equal(main.continuedFrom, null);
  assert.equal(main.continuedTo, 's_legacy_leaf');
  assert.deepEqual(main.events, [{ id: 'e_1', type: 'text', text: 'hi', ts: 1 }]);
  assert.deepEqual(store.chainOf(main).map((s) => s.id), ['s_legacy_main', 's_legacy_leaf']);

  const leaf = store.getSession('s_legacy_leaf');
  assert.equal(leaf.origin, 'hub');
  assert.equal(leaf.provider, 'deepseek');
  assert.equal(leaf.continuedFrom, 's_legacy_main');
  assert.deepEqual(leaf.events, [{ id: 'e_2', type: 'text', text: 'continued', ts: 2 }]);

  const child = store.getSession('s_legacy_child');
  assert.equal(child.origin, 'external');
  assert.equal(child.parentId, 's_legacy_main');
  assert.equal(child.provider, 'kimi');
  assert.deepEqual(child.events, [{ id: 'e_3', type: 'text', text: 'child', ts: 3 }]);

  assert.equal(store.getSession('s_legacy_bad').origin, 'hub');
  assert.equal(store.getSession('s_legacy_bad_child').origin, 'external');
});

test('origins and the fields around them survive a reload', async () => {
  const hub = store.createSession({
    title: 'Hub 聊天',
    origin: 'hub',
    events: [{ id: 'e_h', type: 'text', text: 'hello', ts: 10 }],
  });
  const external = store.createSession({
    title: '終端機聊天',
    provider: 'claude',
    events: [{ id: 'e_x', type: 'text', text: 'world', ts: 11 }],
  });
  const child = store.createSession({
    title: 'child',
    parentId: hub.id,
    provider: 'deepseek',
    continuedFrom: hub.id,
  });
  store.flushAll();
  await settleWrites();

  const fresh = await import(`../server/store.js?reload=${Date.now()}`);
  fresh.loadSessions();

  const h = fresh.getSession(hub.id);
  const x = fresh.getSession(external.id);
  const c = fresh.getSession(child.id);
  assert.equal(h.origin, 'hub');
  assert.equal(x.origin, 'external');
  assert.equal(c.origin, 'external');

  // History, provider and continuation fields are untouched by the origin.
  assert.equal(h.provider, 'kimi');
  assert.equal(h.conversationId, hub.id);
  assert.equal(h.continuedFrom, null);
  assert.equal(h.continuedTo, null);
  assert.deepEqual(h.events, [{ id: 'e_h', type: 'text', text: 'hello', ts: 10 }]);
  assert.equal(x.provider, 'claude');
  assert.equal(x.conversationId, external.id);
  assert.deepEqual(x.events, [{ id: 'e_x', type: 'text', text: 'world', ts: 11 }]);
  assert.equal(c.continuedFrom, hub.id);
  assert.equal(c.parentId, hub.id);

  // Old files re-migrate to the same classes as well.
  assert.equal(fresh.getSession('s_legacy_main').origin, 'hub');
  assert.equal(fresh.getSession('s_legacy_leaf').origin, 'hub');
  assert.equal(fresh.getSession('s_legacy_child').origin, 'external');
});
