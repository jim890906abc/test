// scripts/start-public.ps1 (Windows) behaves like scripts/start-public.sh:
// a dropped quick tunnel is restarted while the hub keeps running, the bridge
// is started once, the password and the bridge key are printed once (not at
// every reconnect), and only the hub exiting ends the script. Run here under
// PowerShell 7 on Linux with a stand-in hub (a real TCP listener), bridge and
// cloudflared; skipped, saying so, when `pwsh` is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE_CLOUDFLARED_TRACKED, freePortSync, guardLeaks, psFakeNode, psStubHub, removeProject, trackDir } from './start-public-fixtures.mjs';
import { killGroup, spawnGroup } from './fixtures/proc-group.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'start-public.ps1');
const PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0 ? 'pwsh' : null;
const SKIP = PWSH ? false : 'pwsh (PowerShell 7) is not installed: scripts/start-public.ps1 was not run';
if (SKIP) console.error(`[start-public-ps1] ${SKIP}`);

// pwsh does not end what it started when it is stopped: every process this
// file starts is ended with its group, and none may outlive the file.
guardLeaks();

const writeExec = (file, body) => (fs.writeFileSync(file, body), fs.chmodSync(file, 0o755));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (file) => Number(fs.readFileSync(file, 'utf8').trim());
async function waitUntil(fn, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// `hubJson`: what data/hub.json holds (an object, a raw string, or null for no file); `env` is added to the script's environment.
function launch({ env = {}, hubJson = { token: 'test-token', bridgeKey: 'test-bridge-key' } } = {}) {
  const tmp = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-start-public-ps1-')));
  const gate = path.join(tmp, 'gate');
  const fakebin = path.join(tmp, 'fakebin');
  for (const d of ['gate', 'fakebin', 'scripts', 'server', 'bridge', 'node_modules', 'data', 'temp']) fs.mkdirSync(path.join(tmp, d));
  fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'start-public.ps1'));
  fs.writeFileSync(path.join(tmp, 'server', 'index.js'), '');
  fs.writeFileSync(path.join(tmp, 'bridge', 'agent-hub-bridge.mjs'), '');
  const lock = '{"lockfileVersion":3}\n';
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(tmp, 'node_modules', '.agent-hub-lock.json'), lock);
  if (hubJson !== null) fs.writeFileSync(path.join(tmp, 'data', 'hub.json'), typeof hubJson === 'string' ? hubJson : JSON.stringify(hubJson));
  fs.writeFileSync(path.join(tmp, 'stub-hub.mjs'), psStubHub());
  writeExec(path.join(fakebin, 'node'), psFakeNode(path.join(tmp, 'stub-hub.mjs')));
  writeExec(path.join(fakebin, 'cloudflared'), FAKE_CLOUDFLARED_TRACKED);
  writeExec(path.join(fakebin, 'kimi'), '#!/usr/bin/env bash\nexit 0\n');
  const port = freePortSync();
  const child = spawnGroup(PWSH, ['-NoProfile', '-File', path.join(tmp, 'scripts', 'start-public.ps1')], {
    cwd: tmp,
    env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, GATE_DIR: gate, PORT: String(port), TEMP: path.join(tmp, 'temp'), TMPDIR: path.join(tmp, 'temp'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (c) => (text += c));
  }
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const waitFor = async (re, timeout, label) => {
    await waitUntil(() => re.test(text), timeout, `${label}; output:\n${text}`);
  };
  return { tmp, gate, child, exited, waitFor, get text() { return text; } };
}

async function teardown(env) {
  await killGroup(env.child);
  removeProject({ gate: env.gate, tmp: env.tmp });
}

test('a dropped tunnel is restarted without printing the password or the bridge key again; the hub ending ends the script', { skip: SKIP, timeout: 90_000 }, async () => {
  const env = launch();
  const { gate } = env;
  try {
    await env.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 40_000, 'first tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'bridge.pid')), 10_000, 'bridge pid file');
    const hubPid = readPid(path.join(gate, 'hub.pid'));
    const bridgePid = readPid(path.join(gate, 'bridge.pid'));
    const cf1 = readPid(path.join(gate, 'cf-1.pid'));
    assert.ok(isAlive(hubPid) && isAlive(cf1) && isAlive(bridgePid));
    const count = (word) => env.text.split(word).length - 1;
    const first = { token: count('test-token'), key: count('test-bridge-key'), box: count('Agent Hub 已上線') };
    assert.deepEqual(first, { token: 2, key: 1, box: 1 }, env.text);
    assert.match(env.text, /登入密碼：\s+test-token/);

    fs.writeFileSync(path.join(gate, 'stop-cf-1'), '');
    await env.waitFor(/https:\/\/tunnel-2\.trycloudflare\.com/, 40_000, 'second tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'cf-2.pid')), 10_000, 'second tunnel pid file');
    const cf2 = readPid(path.join(gate, 'cf-2.pid'));
    await waitUntil(() => !isAlive(cf1), 10_000, 'first tunnel to exit');
    assert.ok(isAlive(hubPid), 'the hub survives the tunnel dropping');
    assert.ok(isAlive(cf2));
    assert.ok(isAlive(bridgePid), 'the bridge is not restarted or killed during a reconnect');
    assert.equal(fs.existsSync(path.join(gate, 'violations.log')), false, 'never two tunnels at once');
    assert.match(env.text, /公網通道已重新建立/);
    assert.match(env.text, /新的公網網址：\s*https:\/\/tunnel-2\.trycloudflare\.com/);
    assert.deepEqual({ token: count('test-token'), key: count('test-bridge-key'), box: count('Agent Hub 已上線') }, first, 'the reconnect printed neither the password nor the bridge key again');
    assert.doesNotMatch(env.text, /tunnel-2\.trycloudflare\.com\/#token=/);

    fs.writeFileSync(path.join(gate, 'stop-hub'), '');
    const { code } = await Promise.race([env.exited, delay(30_000).then(() => { throw new Error(`script did not exit; output:\n${env.text}`); })]);
    assert.equal(code, 1, 'the script ends because the hub ended');
    await waitUntil(() => !isAlive(cf2) && !isAlive(bridgePid) && !isAlive(hubPid), 10_000, 'every child to be cleaned up').catch((err) => {
      // Say which one is still there and what it is doing (a zombie or a running process).
      const state = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'latin1').replace(/^.*\) /, '')[0]; } catch { return '?'; } };
      throw new Error(`${err.message}; still there: ${[['tunnel', cf2], ['bridge', bridgePid], ['hub', hubPid]].filter(([, pid]) => isAlive(pid)).map(([name, pid]) => `${name} ${pid} (state ${state(pid)})`).join(', ')}`);
    });
  } finally {
    await teardown(env);
  }
});

test('the bridge exiting does not end the hub or the tunnel', { skip: SKIP, timeout: 90_000 }, async () => {
  const env = launch();
  const { gate } = env;
  try {
    await env.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 40_000, 'tunnel URL');
    await waitUntil(() => fs.existsSync(path.join(gate, 'bridge.pid')), 10_000, 'bridge pid file');
    const hubPid = readPid(path.join(gate, 'hub.pid'));
    const bridgePid = readPid(path.join(gate, 'bridge.pid'));
    const cf1 = readPid(path.join(gate, 'cf-1.pid'));
    fs.writeFileSync(path.join(gate, 'stop-bridge'), '');
    await waitUntil(() => !isAlive(bridgePid), 10_000, 'bridge to exit');
    await delay(800);
    assert.equal(env.child.exitCode, null, 'the script keeps running after the bridge exits');
    assert.ok(isAlive(hubPid) && isAlive(cf1));
    fs.writeFileSync(path.join(gate, 'stop-hub'), '');
    const { code } = await Promise.race([env.exited, delay(30_000).then(() => { throw new Error(`script did not exit; output:\n${env.text}`); })]);
    assert.equal(code, 1);
    await waitUntil(() => !isAlive(cf1) && !isAlive(hubPid), 10_000, 'tunnel and hub cleanup');
  } finally {
    await teardown(env);
  }
});

test('the .ps1 file keeps its Windows form: UTF-8 with a BOM and CRLF line ends', () => {
  const bytes = fs.readFileSync(SCRIPT);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 needs the BOM to read the Chinese text');
  const text = bytes.toString('utf8');
  assert.ok(!/[^\r]\n/.test(text), 'every line ends with CRLF');
});

// The login password and the bridge key come from the environment when it
// gives them; data/hub.json is read only for what is missing. (With both
// variables set on a fresh folder the hub writes no hub.json at all.)
test('both AGENT_HUB_TOKEN and AGENT_HUB_BRIDGE_KEY set and no data/hub.json: the script runs on the environment values', { skip: SKIP, timeout: 90_000 }, async () => {
  const env = launch({ env: { AGENT_HUB_TOKEN: 'env-token', AGENT_HUB_BRIDGE_KEY: 'env-bridge-key' }, hubJson: null });
  try {
    assert.equal(fs.existsSync(path.join(env.tmp, 'data', 'hub.json')), false, 'the folder is fresh');
    await env.waitFor(/Agent Hub 已上線/, 40_000, 'the online box');
    await env.waitFor(/AGENT_HUB_BRIDGE_KEY = '[^']*'/, 20_000, 'the connect command (it is printed a few lines after the box starts)');
    assert.match(env.text, /登入密碼：\s+env-token/);
    assert.match(env.text, /AGENT_HUB_BRIDGE_KEY = 'env-bridge-key'/);
    assert.doesNotMatch(env.text, /讀不到登入密碼/);
    assert.doesNotMatch(env.text, /test-token|test-bridge-key/);
  } finally {
    await teardown(env);
  }
});

test('the environment wins over data/hub.json; hub.json fills in only what the environment leaves out', { skip: SKIP, timeout: 90_000 }, async () => {
  const file = { token: 'file-token', bridgeKey: 'file-bridge-key' };
  const both = launch({ env: { AGENT_HUB_TOKEN: 'env-token', AGENT_HUB_BRIDGE_KEY: 'env-bridge-key' }, hubJson: file });
  try {
    await both.waitFor(/Agent Hub 已上線/, 40_000, 'the online box');
    await both.waitFor(/AGENT_HUB_BRIDGE_KEY = '[^']*'/, 20_000, 'the connect command');
    assert.match(both.text, /登入密碼：\s+env-token/);
    assert.match(both.text, /AGENT_HUB_BRIDGE_KEY = 'env-bridge-key'/);
    assert.doesNotMatch(both.text, /file-token|file-bridge-key/);
  } finally {
    await teardown(both);
  }
  const mixed = launch({ env: { AGENT_HUB_TOKEN: 'env-token' }, hubJson: file });
  try {
    await mixed.waitFor(/Agent Hub 已上線/, 40_000, 'the online box');
    await mixed.waitFor(/AGENT_HUB_BRIDGE_KEY = '[^']*'/, 20_000, 'the connect command');
    assert.match(mixed.text, /登入密碼：\s+env-token/, 'the password is the environment\'s');
    assert.match(mixed.text, /AGENT_HUB_BRIDGE_KEY = 'file-bridge-key'/, 'the key the environment did not give comes from hub.json');
  } finally {
    await teardown(mixed);
  }
});

test('a secret that neither the environment nor data/hub.json gives is a plain Chinese error, before any tunnel is opened', { skip: SKIP, timeout: 120_000 }, async () => {
  const cases = [
    ['only the password in the environment, no hub.json', { env: { AGENT_HUB_TOKEN: 'env-token' }, hubJson: null }],
    ['nothing in the environment, no hub.json', { env: {}, hubJson: null }],
    ['nothing in the environment, hub.json is not JSON', { env: {}, hubJson: '{not json' }],
    ['hub.json has no bridgeKey', { env: {}, hubJson: { token: 'file-token' } }],
  ];
  for (const [label, opts] of cases) {
    const env = launch(opts);
    try {
      const { code } = await Promise.race([env.exited, delay(60_000).then(() => { throw new Error(`${label}: script did not exit; output:\n${env.text}`); })]);
      assert.equal(code, 1, `${label}\n${env.text}`);
      assert.match(env.text, /讀不到登入密碼或連接金鑰/, label);
      assert.match(env.text, /hub\.json/, label);
      assert.doesNotMatch(env.text, /Agent Hub 已上線|trycloudflare/, `${label}: no tunnel`);
      assert.doesNotMatch(env.text, /Cannot find path|ConvertFrom-Json|Conversion from JSON failed/, `${label}: not PowerShell's own wording`);
    } finally {
      await teardown(env);
    }
  }
});
