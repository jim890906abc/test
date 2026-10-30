// "One key for each conversation" on the Hub's side (2026-10-29): the setting
// (which of the two ways keys are given out - `sticky`, the default, or `relay`),
// what a connector is sent for it, what a connector reports back (how many
// conversations each key has) and what the pages are shown. The connector's own
// behaviour is bridge-sticky.test.mjs; here a fake connector says and hears what
// a real one does. Nothing here reads a real key or leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-sticky-'));
const DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const OCG = 'opencode-go';
const GO1 = 'sk-sticky-go-one-0000000001';
const GO2 = 'sk-sticky-go-two-0000000002';
const CC1 = 'sk-sticky-cc-one-0000000003';
const ALL_KEYS = [GO1, GO2, CC1];
fs.mkdirSync(DATA, { recursive: true });
// (No `distribution` in the file: a file from before it existed.)
fs.writeFileSync(
  path.join(DATA, 'deepseek.json'),
  JSON.stringify({
    gateway: OCG,
    keys: {
      [OCG]: {
        revision: 3,
        activeId: 'k_go1',
        keys: [
          { id: 'k_go1', key: GO1, addedAt: 1000 },
          { id: 'k_go2', key: GO2, addedAt: 2000 },
        ],
      },
      commandcode: { revision: 2, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: CC1, addedAt: 500 }] },
    },
    order: ['k_go1', 'k_go2', 'k_cc1'],
    activity: {},
  }),
  { mode: 0o600 },
);

let account;
let machines;
let gateway;
const file = () => path.join(DATA, 'deepseek.json');
const disk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const scan = (v) => JSON.stringify(v);
const view = () => account.publicAccount().rotation.keys;
const sessionsOf = () => Object.fromEntries(view().map((k) => [k.id, k.sessions]));
const report = (machineId, counts, over = {}) =>
  account.applyPoolReport(machineId, {
    t: 'deepseek.pool',
    gateway: OCG,
    rotation: 1,
    revision: account.rotationRevision(),
    activeId: 'k_go1',
    distribution: 'sticky',
    keys: Object.entries(counts).map(([id, sessions]) => ({ id, sessions })),
    ...over,
  });

const sockets = new Map();
function connect(machineId, extra = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = () => {};
  sockets.set(machineId, ws);
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId, name: machineId, platform: 'test', home: TMP, bridgeVersion: '0.12.0', status: { available: true, server: false }, ...extra }));
}
// What the Hub would send this computer now (asked afresh every time, never from its memory of the last answer).
const provisionArgs = async (machineId) => {
  let seen;
  account.forgetProvider(machineId);
  await account.ensureProvider(machineId, { rpc: async (id, op, args) => ((seen = args), { ok: true, models: [] }) });
  return seen;
};

before(async () => {
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4.1-flash' }] }));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${gateway.address().port}`;
  account = await import('../server/deepseek-account.js');
  machines = await import('../server/machines.js');
  connect('m_new', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'pool_sticky'] });
  connect('m_new2', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'pool_sticky'] });
  connect('m_old', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth'] });
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a hub that never chose is on "sticky": one key for each conversation is the default, and the file is not rewritten for it', () => {
  assert.equal(account.distribution(), 'sticky');
  assert.equal(account.publicAccount().distribution, 'sticky');
  assert.equal('distribution' in disk(), false, 'nothing is written until a person chooses');
});

test('a connector that can give each conversation its own key is told the way; one that cannot is told nothing about it', async () => {
  const fresh = await provisionArgs('m_new');
  assert.equal(fresh.pool.distribution, 'sticky');
  assert.equal(fresh.pool.rotation, 1);
  const old = await provisionArgs('m_old');
  assert.equal('distribution' in old.pool, false, 'an older connector is given the list as it always was');
  for (const k of ALL_KEYS) assert.ok(!scan(account.publicAccount()).includes(k));
});

test('choosing "relay" is saved, changes the version of the list so every computer is sent it again, and choosing the same again changes nothing', async () => {
  const before = account.rotationRevision();
  let calls = 0;
  const rpc = async (id, op, args) => (calls++, { ok: true, models: [], seen: args });
  await account.ensureProvider('m_new', { rpc });
  const base = calls;
  assert.equal((await account.ensureProvider('m_new', { rpc })).cached, true, 'nothing changed: nothing is sent');
  assert.equal(calls, base);

  assert.equal(account.setDistribution('relay'), true);
  assert.equal(account.distribution(), 'relay');
  assert.equal(disk().distribution, 'relay');
  assert.ok(account.rotationRevision() > before, 'a new version of the list');
  assert.equal(account.publicAccount().distribution, 'relay');
  const answer = await account.ensureProvider('m_new', { rpc });
  assert.ok(!answer.cached, 'sent again');
  assert.equal((await provisionArgs('m_new')).pool.distribution, 'relay');
  assert.equal('distribution' in (await provisionArgs('m_old')).pool, false);

  const rev = account.rotationRevision();
  assert.equal(account.setDistribution('relay'), false, 'already so');
  assert.equal(account.rotationRevision(), rev);
  assert.equal(fs.statSync(file()).mode & 0o077, 0, 'still private');

  assert.equal(account.setDistribution('sticky'), true);
  assert.equal(disk().distribution, 'sticky');
  assert.equal((await provisionArgs('m_new')).pool.distribution, 'sticky');
});

test('anything but "sticky" or "relay" is refused and nothing changes', () => {
  const rev = account.rotationRevision();
  for (const bad of ['round-robin', '', null, undefined, 1, true, {}, ['sticky']]) {
    assert.throws(() => account.setDistribution(bad), (e) => e.status === 400 && /sticky|relay|平均|接力/.test(e.message), `refused: ${scan(bad)}`);
  }
  assert.equal(account.rotationRevision(), rev);
  assert.equal(account.distribution(), 'sticky');
});

test('a file that names something else is read as "sticky", and a chosen "relay" survives a reload', () => {
  const raw = disk();
  fs.writeFileSync(file(), JSON.stringify({ ...raw, distribution: 'banana' }), { mode: 0o600 });
  account.reload();
  assert.equal(account.distribution(), 'sticky');
  assert.equal(account.publicAccount().distribution, 'sticky');
  account.setDistribution('relay');
  account.reload();
  assert.equal(account.distribution(), 'relay');
  account.setDistribution('sticky');
});

test('a connector says how many conversations each key has: the Hub shows it per key, adds the computers up, and ignores what cannot be a count', () => {
  assert.deepEqual(sessionsOf(), { k_go1: null, k_go2: null, k_cc1: null }, 'before any report: not known, not zero');
  assert.equal(report('m_new', { k_go1: 3, k_go2: 2, k_cc1: 0 }), true);
  assert.deepEqual(sessionsOf(), { k_go1: 3, k_go2: 2, k_cc1: 0 });
  assert.equal(report('m_new', { k_go1: 3, k_go2: 2, k_cc1: 0 }), false, 'the same report again changes nothing');
  assert.equal(report('m_new2', { k_go1: 1, k_go2: 1, k_cc1: 4 }), true);
  assert.deepEqual(sessionsOf(), { k_go1: 4, k_go2: 3, k_cc1: 4 }, 'two computers: added up');
  // Not counts: no key goes by them, and an id the Hub does not know is dropped.
  report('m_new2', { k_go1: -1, k_go2: 1.5, k_cc1: 'many', k_unknown: 7 });
  assert.deepEqual(sessionsOf(), { k_go1: 3, k_go2: 2, k_cc1: 0 }, 'm_new2 now says nothing usable');
  report('m_new2', { k_go1: 1, k_go2: 1, k_cc1: 4 });
  // A computer that is not on the way of giving out any more (a relay) has no counts.
  assert.equal(report('m_new2', {}, { distribution: 'relay', keys: [{ id: 'k_go1' }] }), true);
  assert.deepEqual(sessionsOf(), { k_go1: 3, k_go2: 2, k_cc1: 0 });
  for (const k of ALL_KEYS) assert.ok(!scan(account.publicAccount()).includes(k));
  assert.equal('sessions' in disk().keys[OCG].keys[0], false, 'counts are not written to the key file');
});

test('a computer that went offline no longer counts, and one that came back counts again only when it says so', () => {
  report('m_new2', { k_go1: 1, k_go2: 1, k_cc1: 4 });
  assert.deepEqual(sessionsOf(), { k_go1: 4, k_go2: 3, k_cc1: 4 });
  sockets.get('m_new2').emit('close');
  assert.deepEqual(sessionsOf(), { k_go1: 3, k_go2: 2, k_cc1: 0 }, 'its conversations are not on any key now');
  connect('m_new2', { pool: 1, capabilities: ['pool', 'pool_cross', 'pool_auth', 'pool_sticky'] });
  // (A connector that comes back reports again after its next provision: until then it says nothing.)
  assert.deepEqual(sessionsOf(), { k_go1: 3, k_go2: 2, k_cc1: 0 });
});

test('each computer\'s line says whether it can give each conversation its own key, and which way it is on', () => {
  report('m_new', { k_go1: 3, k_go2: 2, k_cc1: 0 });
  const rows = Object.fromEntries(account.publicAccount().activity.map((a) => [a.machineId, a]));
  assert.equal(rows.m_new.stickyCapable, true);
  assert.equal(rows.m_new.distribution, 'sticky');
  // A computer that reported before it could (an older connector): said as old, not as sticky.
  account.applyPoolReport('m_old', { t: 'deepseek.pool', gateway: OCG, rotation: 1, revision: account.rotationRevision(), activeId: 'k_go1', keys: [{ id: 'k_go1' }] });
  const rows2 = Object.fromEntries(account.publicAccount().activity.map((a) => [a.machineId, a]));
  assert.ok(!rows2.m_old.stickyCapable, 'an older connector is not said to be able');
  assert.notEqual(rows2.m_old.distribution, 'sticky');
});
