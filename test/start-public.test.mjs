import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE_CLOUDFLARED_TRACKED, FAKE_NODE, guardLeaks, removeProject, trackDir } from './start-public-fixtures.mjs';
import { killGroup, spawnGroup } from './fixtures/proc-group.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'start-public.sh');

// Every process this file starts is ended with it, and none may outlive it
// (the stand-ins used to loop for ever once their folder was deleted).
guardLeaks();

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  return Number(fs.readFileSync(file, 'utf8').trim());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exitWithin(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function waitUntil(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function collectOutput(child) {
  let text = '';
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) fn(); };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { text += chunk; notify(); });
  child.stderr.on('data', (chunk) => { text += chunk; notify(); });
  return {
    get text() { return text; },
    waitFor(re, timeout, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${label}; output:\n${text}`));
        }, timeout);
        const check = () => {
          if (re.test(text)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(text);
          }
        };
        listeners.add(check);
        check();
      });
    },
  };
}

function setupProject() {
  const tmp = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-start-public-')));
  const gate = path.join(tmp, 'gate');
  const fakebin = path.join(tmp, 'fakebin');
  fs.mkdirSync(gate);
  fs.mkdirSync(fakebin);
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.mkdirSync(path.join(tmp, 'server'));
  fs.mkdirSync(path.join(tmp, 'bridge'));
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.mkdirSync(path.join(tmp, 'data'));

  fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'start-public.sh'));
  fs.writeFileSync(path.join(tmp, 'server', 'index.js'), '');
  fs.writeFileSync(path.join(tmp, 'bridge', 'agent-hub-bridge.mjs'), '');
  const lock = '{"lockfileVersion":3}\n';
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(tmp, 'node_modules', '.agent-hub-lock.json'), lock);
  fs.writeFileSync(path.join(tmp, 'data', 'hub.json'), JSON.stringify({
    token: 'test-token', bridgeKey: 'test-bridge-key',
  }));

  writeExec(path.join(fakebin, 'node'), FAKE_NODE);
  writeExec(path.join(fakebin, 'cloudflared'), FAKE_CLOUDFLARED_TRACKED);
  writeExec(path.join(fakebin, 'kimi'), '#!/usr/bin/env bash\nexit 0\n');
  return { tmp, gate, fakebin };
}

async function launch() {
  const { tmp, gate, fakebin } = setupProject();
  const child = spawnGroup('bash', [path.join(tmp, 'scripts', 'start-public.sh')], {
    cwd: tmp,
    env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, GATE_DIR: gate, PORT: '18787' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return { tmp, gate, child, output, exited };
}

// The script and everything it started, then the folder (stop files first).
async function teardown(env) {
  await killGroup(env.child);
  removeProject({ gate: env.gate, tmp: env.tmp });
}

test('a dropped tunnel reconnects while the hub stays up, then hub exit cleans every child', { timeout: 60000 }, async () => {
  const env = await launch();
  const { tmp, gate, child, output, exited } = env;
  try {
    await output.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 20000, 'first tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'hub.pid')), 5000, 'hub pid file');
    await waitUntil(() => fs.existsSync(path.join(gate, 'bridge.pid')), 5000, 'bridge pid file');
    const hubPid = readPid(path.join(gate, 'hub.pid'));
    const bridgePid = readPid(path.join(gate, 'bridge.pid'));
    const cf1 = readPid(path.join(gate, 'cf-1.pid'));
    assert.ok(isAlive(hubPid), 'hub is running after the first tunnel connects');
    assert.ok(isAlive(cf1), 'first tunnel is running');
    assert.ok(isAlive(bridgePid), 'bridge is running');

    // What the first print gave away: the password (twice: in the address
    // and on its own line) and the bridge key. A reconnect must not give
    // them again — this script runs unattended (systemd, nohup) and its
    // output ends up in a log.
    const count = (word) => output.text.split(word).length - 1;
    const first = { token: count('test-token'), key: count('test-bridge-key'), box: count('Agent Hub 已上線') };
    assert.deepEqual(first, { token: 2, key: 1, box: 1 }, output.text);

    fs.writeFileSync(path.join(gate, 'stop-cf-1'), '');

    await output.waitFor(/https:\/\/tunnel-2\.trycloudflare\.com/, 20000, 'second tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'cf-2.pid')), 5000, 'second tunnel pid file');
    const cf2 = readPid(path.join(gate, 'cf-2.pid'));
    await waitUntil(() => !isAlive(cf1), 5000, 'first tunnel to exit');

    assert.ok(isAlive(hubPid), 'hub survives the tunnel dropping');
    assert.ok(isAlive(cf2), 'second tunnel is running');
    assert.ok(isAlive(bridgePid), 'bridge is not restarted or killed during reconnect');
    assert.equal(fs.existsSync(path.join(gate, 'violations.log')), false, 'never two tunnels at once');
    assert.equal(fs.existsSync(path.join(gate, 'cf-3.pid')), false, 'only one reconnect');
    assert.match(output.text, /公網通道已重新建立/);
    assert.match(output.text, /登入密碼：\s+test-token/);
    assert.match(output.text, /網址都可能不同/);
    assert.match(output.text, /新的公網網址：\s*https:\/\/tunnel-2\.trycloudflare\.com/, 'the new address is printed');
    assert.deepEqual({ token: count('test-token'), key: count('test-bridge-key'), box: count('Agent Hub 已上線') }, first, 'the reconnect did not print the password or the bridge key again');
    assert.doesNotMatch(output.text, /tunnel-2\.trycloudflare\.com\/#token=/, 'nor the password inside the address');

    fs.writeFileSync(path.join(gate, 'stop-hub'), '');
    const { code } = await exitWithin(exited, 20000, `script did not exit; output:\n${output.text}`);
    assert.equal(code, 1, 'script ends because the hub ended');
    await waitUntil(() => !isAlive(cf2) && !isAlive(bridgePid) && !isAlive(hubPid), 5000, 'all children to be cleaned up');
    assert.equal(isAlive(cf2), false, 'current tunnel is killed on cleanup');
    assert.equal(isAlive(bridgePid), false, 'bridge is killed on cleanup');
    assert.equal(isAlive(hubPid), false, 'hub is gone');
  } finally {
    await teardown(env);
  }
});

test('the bridge exiting does not end the hub or the tunnel', { timeout: 60000 }, async () => {
  const env = await launch();
  const { gate, child, output, exited } = env;
  try {
    await output.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 20000, 'tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'bridge.pid')), 5000, 'bridge pid file');
    const hubPid = readPid(path.join(gate, 'hub.pid'));
    const bridgePid = readPid(path.join(gate, 'bridge.pid'));
    const cf1 = readPid(path.join(gate, 'cf-1.pid'));

    fs.writeFileSync(path.join(gate, 'stop-bridge'), '');
    await waitUntil(() => !isAlive(bridgePid), 5000, 'bridge to exit');
    await delay(500);

    assert.equal(child.exitCode, null, 'script keeps running after the bridge exits');
    assert.ok(isAlive(hubPid), 'hub survives the bridge exiting');
    assert.ok(isAlive(cf1), 'tunnel survives the bridge exiting');

    fs.writeFileSync(path.join(gate, 'stop-hub'), '');
    const { code } = await exitWithin(exited, 20000, `script did not exit; output:\n${output.text}`);
    assert.equal(code, 1);
    await waitUntil(() => !isAlive(cf1) && !isAlive(hubPid), 5000, 'tunnel and hub cleanup');
    assert.equal(fs.existsSync(path.join(gate, 'violations.log')), false, 'never two tunnels at once');
  } finally {
    await teardown(env);
  }
});
