// The tools that find and end what the tests start (scripts/proc-scan.mjs,
// scripts/check-leaks.mjs, test/fixtures/{proc-group,stop-daemons,leak-guard,
// leak-net}.mjs), run against real processes and the real process table. Each
// check was made to fail first by removing what it guards:
//   - a Claude daemon outlives its Hub, so clean-up must find it by the folder it
//     was started with — not by `pkill -f "<command text>"`, which matches text;
//   - a script run as a group is ended as a group, however it died;
//   - "mine" for --kill-mine means certain: anything unsure is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_RUN, descendantsOf, findDaemons, findLeaks, isRunning, listProcesses, stopDaemons } from '../scripts/proc-scan.mjs';
import { killLeaks, splitMine, staleOnly } from '../scripts/check-leaks.mjs';
import { assertNoLeaks, snapshot } from './fixtures/leak-guard.mjs';
import { groupMembers, killGroup, spawnGroup } from './fixtures/proc-group.mjs';
import { delay, gone, leakKit, until } from './fixtures/leak-kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mk, track, scratch } = leakKit();

// ------------------------------------------------------------ process groups

test('killGroup ends the leader that ignores TERM and the grandchildren it started', async () => {
  const tmp = mk('group');
  const marker = path.join(tmp, 'pids');
  const child = spawnGroup('bash', ['-c', `trap '' TERM; (trap '' TERM; sleep 300) & echo $! >> "$1"; sleep 300 & echo $! >> "$1"; wait`, 'x', marker], { cwd: tmp, stdio: 'ignore' });
  await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim().split('\n').length === 2, 5000, 'children started');
  const pids = fs.readFileSync(marker, 'utf8').trim().split('\n').map(Number);
  track(child.pid);
  for (const p of pids) track(p);
  assert.ok([child.pid, ...pids].every(isRunning));
  const res = await killGroup(child, { termMs: 400, killMs: 3000 });
  assert.equal(res.forced, true, 'TERM was ignored, so it had to be KILL');
  assert.deepEqual([child.pid, ...pids].filter(isRunning), [], 'the leader and both grandchildren are gone');
  assert.equal(groupMembers(child.pid).length, 0);
});

test('killGroup also ends what is left of a group whose leader already exited', async () => {
  const tmp = mk('group2');
  const marker = path.join(tmp, 'pid');
  const child = spawnGroup('bash', ['-c', `(trap '' TERM; sleep 300) & echo $! > "$1"; exit 0`, 'x', marker], { cwd: tmp, stdio: 'ignore' });
  track(child.pid);
  await until(() => fs.existsSync(marker) && child.exitCode !== null, 5000, 'leader gone, grandchild left');
  const pid = track(Number(fs.readFileSync(marker, 'utf8')));
  assert.ok(isRunning(pid));
  await killGroup(child, { termMs: 300, killMs: 3000 });
  assert.equal(isRunning(pid), false);
});

test('killGroup leaves a process that is not in the group alone', async () => {
  const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
  track(bystander.pid);
  const child = spawnGroup('sleep', ['300'], { stdio: 'ignore' });
  track(child.pid);
  await killGroup(child, { termMs: 500 });
  assert.equal(isRunning(child.pid), false);
  assert.equal(isRunning(bystander.pid), true, 'a process outside the group is not touched');
  bystander.kill('SIGKILL');
});

// ------------------------------------------------------------ the Claude daemon

const FAKE_DAEMON = path.join(ROOT, 'test', 'fixtures', 'fake-claude-daemon.mjs');
function startFakeDaemon(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(process.execPath, [FAKE_DAEMON, '--dir', dir], { stdio: 'ignore', detached: true });
  p.unref();
  track(p.pid);
  return until(() => fs.existsSync(path.join(dir, 'daemon.json')), 8000, 'daemon.json').then(() => p);
}

test('stopDaemons ends the daemons whose --dir is inside the folder, and only those', async () => {
  const a = mk('dA');
  const b = mk('dB');
  const aSibling = `${a}-extra`; // same prefix, a different folder
  fs.mkdirSync(aSibling);
  scratch.push(aSibling);
  const inA = await startFakeDaemon(path.join(a, 'data', 'claude-daemon'));
  const inA2 = await startFakeDaemon(path.join(a, 'machine-claude'));
  const inB = await startFakeDaemon(path.join(b, 'data', 'claude-daemon'));
  const inSibling = await startFakeDaemon(path.join(aSibling, 'claude-daemon'));
  // Not a daemon, but its command line has the folder in it (text matching would take it).
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--dir', path.join(a, 'data', 'claude-daemon')], { stdio: 'ignore' });
  track(bystander.pid);

  const found = findDaemons(a).map((p) => p.pid).sort();
  assert.deepEqual(found, [inA.pid, inA2.pid].sort(), 'found by --dir: both in A, none of B, the sibling or the bystander');
  const res = await stopDaemons(a);
  assert.equal(res.stuck.length, 0);
  await until(() => gone(inA.pid) && gone(inA2.pid), 5000, 'the daemons of A to end');
  assert.equal(isRunning(inB.pid), true, 'B\'s daemon is not touched');
  assert.equal(isRunning(inSibling.pid), true, 'a folder that only shares A\'s prefix is not touched');
  assert.equal(isRunning(bystander.pid), true, 'a process that only mentions the folder is not touched');
  await stopDaemons(b);
  await stopDaemons(aSibling);
  bystander.kill('SIGKILL');
});

test('stopHubAndDaemons ends the Hub for good before it touches the daemons', async () => {
  // A Hub that is slow to stop (here 1.2 s after TERM) and writes down whether
  // its daemon still existed at the moment it ended. A Hub that still runs starts
  // a new daemon two seconds after the old one ended, so the daemon must outlive it.
  const dir = mk('order');
  // The daemon is not this test's child (a real one is the Hub's, reaped by init): started by a shell that ends.
  const dd = path.join(dir, 'data', 'claude-daemon');
  const started = spawnSync('bash', ['-c', '"$0" "$1" --dir "$2" >/dev/null 2>&1 & echo $!', process.execPath, FAKE_DAEMON, dd], { encoding: 'utf8' });
  const daemon = { pid: track(Number(started.stdout.trim())) };
  await until(() => fs.existsSync(path.join(dd, 'daemon.json')), 8000, 'daemon.json');
  const out = path.join(dir, 'order.txt');
  const hub = spawn('bash', ['-c', `trap 'sleep 1.2; if kill -0 ${daemon.pid} 2>/dev/null; then echo daemon-alive > "$1"; else echo daemon-gone > "$1"; fi; exit 0' TERM; while :; do sleep 0.2; done`, 'hub', out], { stdio: 'ignore' });
  track(hub.pid);
  await delay(300);
  const { stopHubAndDaemons } = await import('./fixtures/stop-daemons.mjs');
  stopHubAndDaemons(hub, dir);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), 'daemon-alive', 'the Hub was already gone when the daemon was stopped, not the other way round');
  assert.equal(isRunning(daemon.pid), false, 'and then the daemon was stopped');
});

test('stopDaemons refuses a folder that could reach daemons of real data', async () => {
  const outside = (p) => !p.startsWith(`${os.tmpdir()}${path.sep}`); // a home folder inside the temp folder would be a scratch folder
  const bad = ['/', '', 'relative/dir', '/etc', os.tmpdir(), ...[os.homedir(), path.join(os.homedir(), '.agent-hub')].filter(outside)];
  for (const dir of bad) {
    await assert.rejects(() => stopDaemons(dir), /stopDaemons/, `refused: ${JSON.stringify(dir)}`);
  }
});

// ------------------------------------------------------------ the check itself

test('assertNoLeaks fails on a process this test left, names it, and passes once it is ended', async () => {
  const before = snapshot();
  const p = spawn('sleep', ['300'], { stdio: 'ignore' }); // inherits this file\'s stamp
  track(p.pid);
  await assert.rejects(() => assertNoLeaks(before, { settleMs: 300 }), (err) => err.message.includes(String(p.pid)) && /left 1 process/.test(err.message));
  p.kill('SIGKILL');
  await assertNoLeaks(before, { settleMs: 3000 });
});

test('assertNoLeaks finds a stand-in by its folder even when it was started with a clean environment', async () => {
  const dir = mk('clean');
  const before = snapshot();
  const p = spawn('sleep', ['300'], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'ignore' });
  track(p.pid);
  await assert.rejects(() => assertNoLeaks(before, { dirs: [dir], settleMs: 300 }), (err) => err.message.includes(String(p.pid)));
  await assertNoLeaks(before, { dirs: [mk('other')], settleMs: 300 }); // not ours: another folder
  p.kill('SIGKILL');
  await assertNoLeaks(before, { dirs: [dir], settleMs: 3000 });
});

test('the net at the end of a test file ends what the file started and did not end', async () => {
  const dir = mk('net');
  const pidFile = path.join(dir, 'pid');
  const child = spawnSync(process.execPath, ['-e', `
    import('${new URL('./fixtures/leak-net.mjs', import.meta.url).href}').then(() => {
      const { spawn } = require('node:child_process');
      const p = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(p.pid));
      p.unref();
    });
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  track(pid);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /\[leak-net\].*1 process\(es\) still running/, 'it says what it had to end');
  assert.equal(isRunning(pid), false, 'the sleep the file left behind was ended when the file ended');
});

test('check-leaks sees an orphan of a test folder, and --kill-mine only takes what is certainly from the run', async () => {
  const dir = mk('orphan');
  const record = { runId: 'run-A', startedAt: Date.now() - 5000, before: [] };
  // Two orphans of a folder that exists; one carries the run's stamp, one nothing.
  const orphan = async (env) => {
    const l = spawn('bash', ['-c', '(sleep 300 & echo $!) ; exit 0'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = await new Promise((resolve) => l.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    return track(pid);
  };
  const stamped = await orphan({ PATH: process.env.PATH, [ENV_RUN]: 'run-A' });
  const plain = await orphan({ PATH: process.env.PATH });
  const other = await orphan({ PATH: process.env.PATH, [ENV_RUN]: 'run-B' });
  await until(() => [stamped, plain, other].every((pid) => findLeaks().some((l) => l.pid === pid)), 5000, 'the orphans to show up');
  const leaks = findLeaks().filter((l) => [stamped, plain, other].includes(l.pid));
  assert.ok(leaks.every((l) => l.owner === dir && l.ownerExists));

  const { mine, other: rest } = splitMine(leaks, record);
  assert.deepEqual(mine.map((l) => l.pid), [stamped], 'only the one with this run\'s stamp');
  assert.deepEqual(rest.map((l) => l.pid).sort(), [plain, other].sort(), 'no stamp, or another run\'s: left alone');
  assert.ok(rest.every((l) => l.why), 'and each says why');

  // Its folder deleted: nobody can use it any more — then it is the run's to end.
  fs.rmSync(dir, { recursive: true, force: true });
  const after2 = findLeaks().filter((l) => [stamped, plain, other].includes(l.pid));
  assert.ok(after2.every((l) => l.ownerExists === false));
  assert.deepEqual(splitMine(after2, record).mine.map((l) => l.pid).sort(), [stamped, plain].sort(), 'stamp or deleted folder; another run\'s stamp still not');
  assert.deepEqual(staleOnly(after2).map((l) => l.pid).sort(), [stamped, plain, other].sort());
  // Started before the run began: never "mine".
  assert.equal(splitMine(after2, { ...record, startedAt: Date.now() + 60_000 }).mine.length, 0);
  // Already there when the run began: never "mine".
  assert.equal(splitMine(after2, { ...record, before: after2.map((l) => [l.pid, l.startTicks]) }).mine.length, 0);

  const res = await killLeaks(splitMine(after2, record).mine);
  assert.equal(res.stuck.length, 0);
  assert.equal(isRunning(stamped), false);
  assert.equal(isRunning(plain), false);
  assert.equal(isRunning(other), true, 'another run\'s orphan is still there');
  process.kill(other, 'SIGKILL');
});

test('check-leaks lists nothing for a process that has a live parent', async () => {
  const dir = mk('parented');
  const p = spawn('sleep', ['300'], { cwd: dir, stdio: 'ignore' });
  track(p.pid);
  assert.equal(findLeaks().some((l) => l.pid === p.pid), false, 'a running test\'s child is not a leftover');
  const kids = descendantsOf(listProcesses(), process.pid).map((x) => x.pid);
  assert.ok(kids.includes(p.pid));
  p.kill('SIGKILL');
});


test('esbuild\'s own service process (it ends with the process that built something) is not a leftover', async (t) => {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    return t.skip('esbuild is not installed');
  }
  const before = snapshot();
  await esbuild.build({ stdin: { contents: 'export const a = 1' }, write: false, logLevel: 'silent' });
  try {
    assert.ok(listProcesses().some((p) => p.ppid === process.pid && p.args.some((a) => a.startsWith('--service='))), 'the service is running now');
    await assertNoLeaks(before, { settleMs: 300 });
  } finally {
    await esbuild.stop();
  }
});
