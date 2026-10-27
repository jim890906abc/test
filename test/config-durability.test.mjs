// The small config files the Hub cannot start or reconnect without —
// hub.json (login token + bridge key), machines.json (the registered
// computers), claude-deleted.json (conversations that must stay deleted) and
// the Claude daemon's daemon.json — are written whole or not at all:
//   • a kill in the middle of a write leaves the OLD file, never half of a new
//     one (the old code truncated the file first and wrote into it);
//   • the data is forced to disk before the rename that makes it the file, and
//     the folder entry after it; hub.json and daemon.json stay private (0600).
// Every test runs a REAL process (the Hub, the daemon) on a temp folder; the
// "kill in the middle of a write" is a real SIGKILL (test/fixtures/disk-chaos.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, procs, cleanup, scratch, spawnHub, connectMachine, readJson, opsOf, aroundRename } from './fixtures/hub-process.mjs';

const CHAOS = new URL('./fixtures/disk-chaos.mjs', import.meta.url).href;
after(cleanup);

const OLD_MACHINES = [
  { id: 'm_old1', name: '舊電腦甲', platform: 'linux', home: '/home/a', lastSeen: 1000, capabilities: ['pool'] },
  { id: 'm_old2', name: '舊電腦乙', platform: 'darwin', home: '/Users/b', lastSeen: 2000, capabilities: [] },
];

// ------------------------------------------------------------ hub.json

test('hub.json: a kill in the middle of the rewrite leaves the old file whole, and the next start keeps the old login token', async () => {
  const sc = scratch('hubjson-kill');
  // An older hub.json without a bridge key: the start rewrites it.
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 'tok-old-keep' }), { mode: 0o600 });
  const hub = await spawnHub(sc, { chaos: { mark: '"bridgeKey"' } });
  const end = await hub.stopsWithin();
  assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${hub.out()}`);
  const after = readJson(sc.file('hub.json')); // half a file does not parse
  assert.equal(after.token, 'tok-old-keep');

  // Starting again: same token, a bridge key now, and nothing half-written left lying around.
  const again = await spawnHub(sc);
  await again.ready;
  try {
    const now = readJson(sc.file('hub.json'));
    assert.equal(now.token, 'tok-old-keep');
    assert.match(now.bridgeKey, /^bk_[0-9a-f]{36}$/);
    assert.deepEqual(fs.readdirSync(sc.data).filter((f) => f.endsWith('.tmp')), [], 'no half-written leftovers');
  } finally {
    await again.stop();
  }
});

test('hub.json: written private (0600), the data synced before the rename and the folder after', async () => {
  const sc = scratch('hubjson-order');
  const log = path.join(sc.dir, 'ops.log');
  const hub = await spawnHub(sc, { chaos: { log } });
  await hub.ready;
  await hub.stop();
  const { before, after, opens } = aroundRename(opsOf(log), 'hub.json');
  assert.equal(before, 'fsync', 'the data is on disk right before the rename');
  assert.equal(after, 'fsync-dir', 'the folder entry is synced right after');
  assert.match(opens.at(-1), /^open hub\.json\.\d+\.tmp w 600$/, 'created private from the start');
  assert.equal(fs.statSync(sc.file('hub.json')).mode & 0o777, 0o600);
});

test('a half-written temporary file of a process that is gone is cleaned up at the next start; a live process\'s is not touched', async () => {
  const sc = scratch('stale-tmp');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.once('exit', r));
  const stale = [`hub.json.${dead.pid}.tmp`, `machines.json.${dead.pid}.tmp`, `claude-deleted.json.${dead.pid}.tmp`];
  for (const f of stale) fs.writeFileSync(sc.file(f), '{"half":');
  const alive = sc.file(`hub.json.${process.pid}.tmp`); // this test process is alive
  fs.writeFileSync(alive, '{"being":"written"}');
  const hub = await spawnHub(sc);
  await hub.ready;
  await hub.stop();
  for (const f of stale) assert.equal(fs.existsSync(sc.file(f)), false, `${f} is cleaned up`);
  assert.equal(fs.readFileSync(alive, 'utf8'), '{"being":"written"}', 'a live process\'s file is left alone');
});

// -------------------------------------------------------- machines.json

test('machines.json: a kill in the middle of a rewrite leaves the registered computers whole', async () => {
  const sc = scratch('machines-kill');
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 't', bridgeKey: 'bk_test' }), { mode: 0o600 });
  fs.writeFileSync(sc.file('machines.json'), JSON.stringify(OLD_MACHINES, null, 2));
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' }, chaos: { mark: '"lastSeen"' } });
  await hub.ready;
  const ws = connectMachine(hub.port, 'bk_test', 'm_new', '新電腦'); // its hello makes the Hub write the list
  const end = await hub.stopsWithin();
  ws.terminate();
  assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${hub.out()}`);
  const after = readJson(sc.file('machines.json')); // half a file does not parse
  assert.deepEqual(after.map((m) => m.id), ['m_old1', 'm_old2']);
});

test('machines.json: the data is synced before the rename and the folder after', async () => {
  const sc = scratch('machines-order');
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 't', bridgeKey: 'bk_test' }), { mode: 0o600 });
  fs.writeFileSync(sc.file('machines.json'), JSON.stringify(OLD_MACHINES, null, 2));
  const log = path.join(sc.dir, 'ops.log');
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' }, chaos: { log } });
  await hub.ready;
  const ws = connectMachine(hub.port, 'bk_test', 'm_new', '新電腦');
  try {
    const deadline = Date.now() + 10000;
    while (!readJson(sc.file('machines.json')).some((m) => m.id === 'm_new')) {
      assert.ok(Date.now() < deadline, 'the new computer was written');
      await new Promise((r) => setTimeout(r, 50));
    }
    const { before, after } = aroundRename(opsOf(log), 'machines.json');
    assert.equal(before, 'fsync');
    assert.equal(after, 'fsync-dir');
    assert.deepEqual(readJson(sc.file('machines.json')).map((m) => m.id).sort(), ['m_new', 'm_old1', 'm_old2']);
  } finally {
    ws.terminate();
    await hub.stop();
  }
});

// ----------------------------------------------------- claude-deleted.json

// A Claude conversation on a computer that is not connected (so no daemon is
// involved); deleting it is what writes claude-deleted.json.
function seedClaudeConversation(sc, id) {
  fs.mkdirSync(path.join(sc.data, 'sessions'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sc.data, 'sessions', `${id}.json`), JSON.stringify({ id, agentId: 'claude', title: '要刪的', titled: true, cwd: '/tmp', machineId: 'm_gone_box', status: 'idle', events: [], meta: {}, state: {}, allowedTools: [], permissionMode: 'auto', createdAt: now, updatedAt: now }));
}

test('claude-deleted.json: deleting a conversation records it (control), and a kill in the middle of that write keeps the old list whole', async () => {
  // Control: the delete reaches the file.
  const ok = scratch('gone-ok');
  seedClaudeConversation(ok, 'c_ctl000000001');
  const hub = await spawnHub(ok, { env: { AGENT_HUB_TOKEN: 'none' } });
  await hub.ready;
  try {
    await hub.api('/sessions/c_ctl000000001', { method: 'DELETE' });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ok.file('claude-deleted.json')) || !('c_ctl000000001' in readJson(ok.file('claude-deleted.json')))) {
      assert.ok(Date.now() < deadline, 'the deleted conversation is recorded');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await hub.stop();
  }

  // The same delete, killed while the list is written.
  const sc = scratch('gone-kill');
  seedClaudeConversation(sc, 'c_kill00000001');
  fs.writeFileSync(sc.file('claude-deleted.json'), JSON.stringify({ c_earlier: null }));
  const victim = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' }, chaos: { mark: '"c_kill00000001":"m_gone_box"' } });
  await victim.ready;
  victim.api('/sessions/c_kill00000001', { method: 'DELETE' }).catch(() => {});
  const end = await victim.stopsWithin();
  assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${victim.out()}`);
  assert.deepEqual(readJson(sc.file('claude-deleted.json')), { c_earlier: null }); // half a file does not parse
});

test('claude-deleted.json: the data is synced before the rename and the folder after', async () => {
  const sc = scratch('gone-order');
  seedClaudeConversation(sc, 'c_ord000000001');
  const log = path.join(sc.dir, 'ops.log');
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' }, chaos: { log } });
  await hub.ready;
  try {
    await hub.api('/sessions/c_ord000000001', { method: 'DELETE' });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(log) || !opsOf(log).includes('rename claude-deleted.json')) {
      assert.ok(Date.now() < deadline, 'the list was written');
      await new Promise((r) => setTimeout(r, 50));
    }
    const { before, after } = aroundRename(opsOf(log), 'claude-deleted.json');
    assert.equal(before, 'fsync');
    assert.equal(after, 'fsync-dir');
  } finally {
    await hub.stop();
  }
});

// ----------------------------------------------------------- daemon.json

test('daemon.json (the Claude daemon): private (0600), the data synced before the rename and the folder after', async () => {
  const sc = scratch('daemon-json');
  const dir = path.join(sc.dir, 'claude');
  const log = path.join(sc.dir, 'ops.log');
  const proc = spawn(process.execPath, ['--import', CHAOS, 'server/claude-daemon.js', '--dir', dir], { cwd: ROOT, env: { ...process.env, HOME: sc.dir, AH_OP_LOG: log }, stdio: 'ignore' });
  procs.add(proc);
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(dir, 'daemon.json'))) {
      assert.ok(Date.now() < deadline, 'the daemon wrote daemon.json');
      await new Promise((r) => setTimeout(r, 50));
    }
    const info = readJson(path.join(dir, 'daemon.json'));
    assert.equal(info.pid, proc.pid);
    assert.ok(info.port > 0 && info.token);
    const { before, after, opens } = aroundRename(opsOf(log), 'daemon.json');
    assert.equal(before, 'fsync');
    assert.equal(after, 'fsync-dir');
    assert.match(opens.at(-1), /^open daemon\.json\.\d+\.tmp w 600$/);
    assert.equal(fs.statSync(path.join(dir, 'daemon.json')).mode & 0o777, 0o600);
  } finally {
    proc.kill('SIGTERM');
  }
});
