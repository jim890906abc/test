// The stand-ins the start-public tests use (a fake `node`, a fake `cloudflared`,
// the PowerShell tests' stub hub) must never wait for ever. They used to loop on
// "is there a stop file yet?" — and once a test timed out, was killed, or deleted
// its folder, nobody would ever write it: 175 of them piled up, each forking
// every 50 ms, 130% CPU. Each check starts the real stand-in and removes what
// it waits for; each was made to fail first by deleting the matching condition
// from the wait guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isRunning } from '../scripts/proc-scan.mjs';
import { FAKE_CLOUDFLARED, FAKE_CLOUDFLARED_TRACKED, FAKE_NODE, freePortSync, psFakeNode, psStubHub, shimFuncs, writeExec } from './start-public-fixtures.mjs';
import { spawnGroup } from './fixtures/proc-group.mjs';
import { delay, gone, leakKit, until } from './fixtures/leak-kit.mjs';

const { mk, track } = leakKit();

// ------------------------------------------------------------ the stand-ins

// Each stand-in, how to start it and what shows it is up.
const SHIMS = [
  { name: 'fake node (hub)', file: 'node', body: FAKE_NODE, args: ['server/index.js'], up: 'hub.pid' },
  { name: 'fake node (bridge)', file: 'node', body: FAKE_NODE, args: ['bridge/agent-hub-bridge.mjs', '--hub', 'x'], up: 'bridge.pid' },
  { name: 'fake cloudflared', file: 'cloudflared', body: FAKE_CLOUDFLARED, args: ['tunnel'], up: 'cf-1.pid' },
  { name: 'fake cloudflared (tracking)', file: 'cloudflared', body: FAKE_CLOUDFLARED_TRACKED, args: ['tunnel'], up: 'cf-1.pid' },
  { name: 'PowerShell-test node (bridge)', file: 'node', body: psFakeNode('/nonexistent-stub.mjs', { record: true }), args: ['bridge/agent-hub-bridge.mjs', '--hub', 'x'], up: 'bridge.pid' },
];

function startShim(shim, { detachFromTest = false } = {}) {
  const tmp = mk('shim');
  const gate = path.join(tmp, 'gate');
  fs.mkdirSync(gate);
  const bin = path.join(tmp, 'fakebin', shim.file);
  fs.mkdirSync(path.dirname(bin));
  writeExec(bin, shim.body);
  const env = { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH}`, GATE_DIR: gate };
  // The stand-in's parent is a launcher that stays alive (or, for the
  // parent-gone check, one we kill): `bash -c 'stand-in & echo pid; wait'`.
  const launcher = spawnGroup('bash', ['-c', 'cd "$1"; shift; "$@" >/dev/null 2>&1 & echo $!; wait', 'launcher', tmp, bin, ...shim.args], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'ignore'] });
  track(launcher.pid);
  return new Promise((resolve, reject) => {
    let out = '';
    launcher.stdout.on('data', (d) => {
      out += d;
      const pid = Number(out.trim().split('\n')[0]);
      if (pid) resolve({ tmp, gate, launcher, shimPid: track(pid) });
    });
    launcher.once('exit', () => reject(new Error('launcher ended early')));
    setTimeout(() => reject(new Error('stand-in did not start')), 8000);
  });
}

for (const shim of SHIMS) {
  test(`${shim.name}: ends by itself when its gate folder is deleted, with no stop file`, async () => {
    const s = await startShim(shim);
    await until(() => fs.existsSync(path.join(s.gate, shim.up)), 8000, `${shim.up}`);
    assert.ok(isRunning(s.shimPid), 'it waits while its folder exists');
    await delay(500);
    assert.ok(isRunning(s.shimPid), 'and keeps waiting');
    fs.rmSync(s.gate, { recursive: true, force: true });
    await until(() => gone(s.shimPid), 4000, 'the stand-in to leave after its gate folder was deleted');
  });

  test(`${shim.name}: ends by itself when the process that started it is gone`, async () => {
    const s = await startShim(shim);
    await until(() => fs.existsSync(path.join(s.gate, shim.up)), 8000, `${shim.up}`);
    assert.ok(isRunning(s.shimPid));
    process.kill(s.launcher.pid, 'SIGKILL'); // its parent dies without cleaning up (a SIGKILL after a slow shutdown)
    await until(() => gone(s.shimPid), 4000, 'the stand-in to leave after its parent died');
  });

  test(`${shim.name}: leaves on TERM too`, async () => {
    const s = await startShim(shim);
    await until(() => fs.existsSync(path.join(s.gate, shim.up)), 8000, `${shim.up}`);
    process.kill(s.shimPid, 'SIGTERM');
    await until(() => gone(s.shimPid), 4000, 'the stand-in to leave on SIGTERM');
  });
}

test('the stand-in hub of the PowerShell tests ends by itself when its folder is deleted, when its parent is gone', async () => {
  const tmp = mk('stub');
  const gate = path.join(tmp, 'gate');
  fs.mkdirSync(gate);
  fs.writeFileSync(path.join(tmp, 'stub.mjs'), psStubHub());
  const env = { ...process.env, GATE_DIR: gate };
  const launch = () => {
    const l = spawnGroup('bash', ['-c', `"$0" "$1" >/dev/null 2>&1 & echo $!; wait`, process.execPath, path.join(tmp, 'stub.mjs')], { cwd: tmp, env: { ...env, PORT: String(freePortSync()) }, stdio: ['ignore', 'pipe', 'ignore'] });
    track(l.pid);
    return new Promise((resolve) => l.stdout.once('data', (d) => resolve({ l, pid: track(Number(String(d).trim())) })));
  };
  let { l, pid } = await launch();
  await until(() => fs.existsSync(path.join(gate, 'hub.pid')), 8000, 'stub hub up');
  assert.ok(isRunning(pid));
  fs.rmSync(gate, { recursive: true, force: true });
  await until(() => gone(pid), 4000, 'the stub hub to leave after its gate folder was deleted');

  fs.mkdirSync(gate);
  ({ l, pid } = await launch());
  await until(() => fs.existsSync(path.join(gate, 'hub.pid')), 8000, 'stub hub up again');
  process.kill(l.pid, 'SIGKILL');
  await until(() => gone(pid), 4000, 'the stub hub to leave after its parent died');
});

test('the wait guard also stops a stand-in after its time limit', async () => {
  const tmp = mk('ttl');
  const gate = path.join(tmp, 'gate');
  fs.mkdirSync(gate);
  const script = path.join(tmp, 'ttl.sh');
  writeExec(script, `#!/usr/bin/env bash\n${shimFuncs(2)}\nwhile shim_alive; do sleep 0.2; done\n`);
  const child = spawn(script, [], { env: { ...process.env, GATE_DIR: gate }, stdio: 'ignore' });
  track(child.pid);
  await delay(800);
  assert.ok(isRunning(child.pid), 'still waiting before the limit');
  await until(() => gone(child.pid), 4000, 'the stand-in to leave at its time limit');
});

