// What the public-mode start scripts (scripts/start-public.sh and .ps1) must
// not do, run for real against stand-ins for node, cloudflared and kimi:
//   - go public with the login switched off (AGENT_HUB_TOKEN=none);
//   - put the bridge key on a command line, where `ps` shows it to every user;
//   - leave the login password in a log in the temp folder (Windows);
//   - connect this computer's Kimi when NO_BRIDGE says not to;
//   - mistake a missing `wait -n` (bash older than 4.3, e.g. macOS's 3.2) for a
//     dropped tunnel and reconnect over and over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PS1, SH, delay, freePortSync, guardLeaks, isAlive, psFakeNode, psStubHub, realPath, removeProject, runScript, setupProject, waitUntil, writeExec } from './start-public-fixtures.mjs';

// Every script group this file starts is ended with the file, and no stand-in
// may outlive it.
guardLeaks();

const shText = fs.readFileSync(SH, 'utf8');
const ps1Text = fs.readFileSync(PS1, 'utf8');
const readPid = (file) => Number(fs.readFileSync(file, 'utf8').trim());
const ONLINE = /Agent Hub 已上線/;

async function withSh(opts, body) {
  const proj = setupProject({ installedCloudflared: true, ...(opts.project || {}) });
  const run = runScript(proj, { env: opts.env || {} });
  try {
    return await body({ proj, run, gate: proj.gate, file: (...p) => path.join(proj.gate, ...p) });
  } finally {
    await run.stop();
    removeProject(proj);
  }
}

// ---------------------------------------------------------------- AGENT_HUB_TOKEN=none
const NONE_SPELLINGS = ['none', 'NONE', 'None', 'nOnE', ' none ', 'none\n'];

test('sh: AGENT_HUB_TOKEN=none (any case) is refused before anything starts, and is never printed as a password', async () => {
  for (const value of NONE_SPELLINGS) {
    await withSh({ env: { AGENT_HUB_TOKEN: value } }, async ({ proj, run, gate }) => {
      const { code } = await run.finished();
      assert.equal(code, 1, `${JSON.stringify(value)}\n${run.text}`);
      assert.match(run.text, /公網/, 'says why: the hub goes onto the public internet');
      assert.match(run.text, /整台電腦/, 'and what no login means');
      assert.doesNotMatch(run.text, /登入密碼|#token=|已上線/, 'no password, no address, no "online" box');
      assert.equal(fs.existsSync(path.join(gate, 'hub.pid')), false, 'the hub was not started');
      assert.equal(fs.existsSync(path.join(gate, 'cloudflared.executed')), false, 'no tunnel was opened');
      assert.equal(fs.existsSync(path.join(proj.tmp, 'bin')), false, 'nothing was created in the project');
    });
  }
});

test('sh: a login password that merely contains or resembles "none" still works, and the custom password is shown', async () => {
  for (const value of ['none-of-your-business', 'nonexistent', 'abc123']) {
    await withSh({ env: { AGENT_HUB_TOKEN: value } }, async ({ run }) => {
      await run.waitFor(ONLINE, 20000, `${value}: the online box`);
      assert.match(run.text, new RegExp(`登入密碼：\\s+${value}`));
    });
  }
});

test('sh: with AGENT_HUB_TOKEN and AGENT_HUB_BRIDGE_KEY both set, no data/hub.json is needed (a fresh folder has none)', async () => {
  await withSh({ project: { hubJson: null }, env: { AGENT_HUB_TOKEN: 'env-token', AGENT_HUB_BRIDGE_KEY: 'env-bridge-key' } }, async ({ proj, run }) => {
    assert.equal(fs.existsSync(path.join(proj.tmp, 'data', 'hub.json')), false);
    await run.waitFor(ONLINE);
    assert.match(run.text, /登入密碼：\s+env-token/);
    assert.match(run.text, /AGENT_HUB_BRIDGE_KEY=env-bridge-key node agent-hub-bridge\.mjs/);
  });
});

// ---------------------------------------------------------------- bridge key off the command line
test('sh: the bridge key reaches the local bridge through its environment, never its command line, and the connect command for other computers does the same', async () => {
  await withSh({}, async ({ run, file }) => {
    await run.waitFor(ONLINE);
    await waitUntil(() => fs.existsSync(file('bridge.pid')), 5000, 'the local bridge');
    const args = fs.readFileSync(file('bridge.args'), 'utf8').trim();
    assert.equal(args, 'bridge/agent-hub-bridge.mjs --hub http://127.0.0.1:18787', 'no --key');
    assert.doesNotMatch(args, /test-bridge-key/);
    assert.equal(fs.readFileSync(file('bridge.envkey'), 'utf8').trim(), 'test-bridge-key', 'the key is in its environment');
    // What `ps` would show every user of this computer.
    const pid = readPid(file('bridge.pid'));
    if (fs.existsSync(`/proc/${pid}/cmdline`)) {
      assert.doesNotMatch(fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1'), /test-bridge-key/, 'the key is not in /proc/<pid>/cmdline');
      assert.match(fs.readFileSync(`/proc/${pid}/environ`, 'latin1'), /AGENT_HUB_BRIDGE_KEY=test-bridge-key/);
    }
    // The command printed for other computers.
    assert.match(run.text, /AGENT_HUB_BRIDGE_KEY=test-bridge-key node agent-hub-bridge\.mjs --hub https:\/\/tunnel-1\.trycloudflare\.com\b/);
    assert.doesNotMatch(run.text, /--key/, 'no --key anywhere in what is printed');
    // The bridge's own environment is the only place besides that command: the tunnel never saw the key.
    assert.equal(fs.readFileSync(file('cf-1.envkey'), 'utf8').trim(), '<unset>');
  });
});

// ---------------------------------------------------------------- NO_BRIDGE
test('sh: NO_BRIDGE=1 (also true/yes, any case) leaves this computer unconnected and says so; 0, false and unset connect it', async () => {
  for (const value of ['1', 'true', 'YES', 'on']) {
    await withSh({ env: { NO_BRIDGE: value } }, async ({ proj, run, file }) => {
      await run.waitFor(ONLINE);
      await run.waitFor(/NO_BRIDGE，略過本機 Kimi 連接/, 5000, `${value}: the skip message`);
      await delay(600);
      assert.equal(fs.existsSync(file('bridge.pid')), false, `${value}: no bridge was started`);
      assert.equal(fs.existsSync(path.join(proj.tmp, '.agent-hub')), false, 'and nothing under the home folder');
    });
  }
  for (const value of ['0', 'false', 'No', '']) {
    await withSh({ env: { NO_BRIDGE: value } }, async ({ run, file }) => {
      await run.waitFor(ONLINE);
      await waitUntil(() => fs.existsSync(file('bridge.pid')), 5000, `${JSON.stringify(value)}: the bridge`);
      assert.doesNotMatch(run.text, /NO_BRIDGE/);
    });
  }
});

// ---------------------------------------------------------------- bash without `wait -n`
// The test bash has `wait -n`, so it is made to fail as it does on bash 3.2 (a
// function of the same name, loaded through BASH_ENV, fails -n at once).
test('sh: when `wait -n` fails at once (bash 3.2) a working tunnel is kept, and a tunnel that really ends is still replaced', async () => {
  const broken = path.join(setupProject().tmp, 'no-wait-n.sh');
  fs.writeFileSync(broken, 'wait() { if [ "${1:-}" = "-n" ]; then return 2; fi; builtin wait "$@"; }\n');
  try {
    await withSh({ env: { BASH_ENV: broken } }, async ({ run, file }) => {
      await run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
      const cf1 = readPid(file('cf-1.pid'));
      await delay(2500); // the old code reconnected within about a second
      assert.doesNotMatch(run.text, /公網通道中斷/, `the tunnel is not taken for dropped:\n${run.text}`);
      assert.doesNotMatch(run.text, /tunnel-2\.trycloudflare/);
      assert.ok(isAlive(cf1), 'and was not killed');
      // A tunnel that does end is noticed all the same.
      fs.writeFileSync(file('stop-cf-1'), '');
      await run.waitFor(/https:\/\/tunnel-2\.trycloudflare\.com/, 20000, 'the replacement tunnel');
      assert.match(run.text, /公網通道中斷/);
      // And so is the hub ending.
      fs.writeFileSync(file('stop-hub'), '');
      const { code } = await run.finished();
      assert.equal(code, 1);
    });
  } finally {
    fs.rmSync(path.dirname(broken), { recursive: true, force: true });
  }
});

test('sh: wait_n_supported says yes only from bash 4.3 on, comparing numbers (4.10 is later than 4.3)', () => {
  const fn = /^wait_n_supported\(\) \{\n[\s\S]*?\n\}$/m.exec(shText)?.[0];
  assert.ok(fn, 'the function is in the script');
  const answer = (...v) => {
    const r = spawnBash(`${fn}\nif wait_n_supported ${v.join(' ')}; then echo yes; else echo no; fi`);
    return r.stdout.trim();
  };
  const table = [[[3, 2], 'no'], [[3, 9], 'no'], [[4, 0], 'no'], [[4, 2], 'no'], [[4, 3], 'yes'], [[4, 4], 'yes'], [[4, 10], 'yes'], [[5, 0], 'yes'], [[5, 3], 'yes'], [[10, 0], 'yes']];
  for (const [v, want] of table) assert.equal(answer(...v), want, `bash ${v.join('.')}`);
  // With no arguments it asks the bash that is running it.
  const here = spawnBash(fn + '\nif wait_n_supported; then echo yes; else echo no; fi\necho "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"').stdout.trim().split('\n');
  const [major, minor] = here[1].split(' ').map(Number);
  assert.equal(here[0], major > 4 || (major === 4 && minor >= 3) ? 'yes' : 'no', 'this bash is asked');
});

function spawnBash(script) {
  return spawnSync(realPath('bash'), ['-c', script], { encoding: 'utf8' });
}

test('sh: the script has no syntax errors and uses nothing newer than bash 3.2 except `wait -n`, which only runs after the version check', () => {
  const syntax = spawnSync(realPath('bash'), ['-n', SH], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  // A real shellcheck, when this machine has one.
  const shellcheck = realPath('shellcheck');
  if (shellcheck) {
    const r = spawnSync(shellcheck, ['-s', 'bash', '-S', 'error', SH], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  // Features that exist only in bash 4 and later (macOS's /bin/bash is 3.2).
  const newer = [
    [/\bdeclare\s+-[a-zA-Z]*A/, 'associative arrays'],
    [/\b(mapfile|readarray)\b/, 'mapfile/readarray'],
    [/\$\{[^}]*(,,|\^\^)[^}]*\}/, 'case-changing expansions ${x,,} ${x^^}'],
    [/\|&/, '|&'],
    [/&>>/, '&>>'],
    [/\bcoproc\b/, 'coproc'],
    [/;;&|;&/, 'case ;;& ;&'],
    [/\blocal\s+-n\b/, 'namerefs'],
    [/printf\s+['"]%\(/, 'printf %(...)T'],
    [/\$EPOCH(SECONDS|REALTIME)/, '$EPOCHSECONDS'],
    [/\bread\s+(-[a-zA-Z]*\s+)*-t\s+[0-9]*\./, 'fractional read -t'],
    [/\bwait\s+-[a-z]*p\b/, 'wait -p'],
  ];
  const code = shText.replace(/^\s*#.*$/gm, '');
  for (const [re, what] of newer) assert.doesNotMatch(code, re, `bash 4+ only: ${what}`);
  const uses = [...code.matchAll(/\bwait\s+-n\b/g)];
  assert.equal(uses.length, 1, 'wait -n is used once');
  assert.match(code, /if wait_n_supported; then\n\s+wait -n /, 'and only behind the version check');
});

// ---------------------------------------------------------------- start-public.ps1
const PWSH = realPath('pwsh');
const SKIP_PS = PWSH ? false : 'pwsh (PowerShell 7) is not installed: scripts/start-public.ps1 was not run';
if (SKIP_PS) console.error(`[start-public-hardening] ${SKIP_PS}`);

// A stand-in hub that really listens on the port (the script checks that) and,
// like the real one, prints the login password to its output.
function psProject() {
  const proj = setupProject({ script: PS1, installedCloudflared: true });
  fs.writeFileSync(path.join(proj.tmp, 'stub-hub.mjs'), psStubHub({ announce: true }));
  writeExec(path.join(proj.fakebin, 'node'), psFakeNode(path.join(proj.tmp, 'stub-hub.mjs'), { record: true }));
  return proj;
}
// A free port of its own: the stand-in hub really listens, and another test run may hold a fixed one.
function psRun(proj, env = {}) {
  proj.port = freePortSync();
  return runScript(proj, { script: PS1, command: PWSH, args: ['-NoProfile', '-File', path.join(proj.tmp, 'scripts', 'start-public.ps1')], inherit: true, env: { PORT: String(proj.port), ...env } });
}
async function withPs(env, body) {
  const proj = psProject();
  const run = psRun(proj, env);
  try {
    return await body({ proj, run, gate: proj.gate, file: (...p) => path.join(proj.gate, ...p), temp: path.join(proj.tmp, 'temp') });
  } finally {
    await run.stop();
    removeProject(proj);
  }
}
const agentHubTempDirs = (temp) => fs.readdirSync(temp).filter((n) => n.startsWith('agent-hub-'));

test('ps1: AGENT_HUB_TOKEN=none (any case) is refused before anything starts, and is never printed as a password', { skip: SKIP_PS, timeout: 120_000 }, async () => {
  for (const value of ['none', 'NONE', ' None ']) {
    await withPs({ AGENT_HUB_TOKEN: value }, async ({ proj, run, gate, temp }) => {
      const { code } = await run.finished(60_000);
      assert.equal(code, 1, `${JSON.stringify(value)}\n${run.text}`);
      assert.match(run.text, /公網/);
      assert.match(run.text, /整台電腦/);
      assert.doesNotMatch(run.text, /登入密碼|#token=|已上線/);
      assert.equal(fs.existsSync(path.join(gate, 'hub.pid')), false, 'the hub was not started');
      assert.equal(fs.existsSync(path.join(proj.tmp, 'bin')), false, 'nothing was created in the project');
      assert.deepEqual(agentHubTempDirs(temp), [], 'no log folder either');
    });
  }
});

test('ps1: the logs, which hold the login password, are gone from the temp folder once the script ends', { skip: SKIP_PS, timeout: 120_000 }, async () => {
  await withPs({}, async ({ run, file, temp }) => {
    await run.waitFor(ONLINE, 60_000, 'the online box');
    // While it runs the hub's log is there and holds the password (that is why it must not stay).
    const dirs = agentHubTempDirs(temp);
    assert.equal(dirs.length, 1, `one log folder while running: ${dirs}`);
    const hubLog = path.join(temp, dirs[0], 'hub.log');
    await waitUntil(() => fs.existsSync(hubLog) && /test-token/.test(fs.readFileSync(hubLog, 'utf8')), 10_000, 'the hub log with the password in it');
    fs.writeFileSync(file('stop-hub'), '');
    const { code } = await run.finished(60_000);
    assert.equal(code, 1, 'the script ends because the hub ended');
    assert.deepEqual(agentHubTempDirs(temp), [], `the log folder was removed; still there: ${agentHubTempDirs(temp)}`);
  });
});

test('ps1: the bridge key reaches the local bridge through its environment, never its command line, and does not leak to later children', { skip: SKIP_PS, timeout: 120_000 }, async () => {
  await withPs({}, async ({ proj, run, file }) => {
    await run.waitFor(ONLINE, 60_000);
    await waitUntil(() => fs.existsSync(file('bridge.pid')), 10_000, 'the local bridge');
    const args = fs.readFileSync(file('bridge.args'), 'utf8').trim();
    assert.equal(args, `bridge/agent-hub-bridge.mjs --hub http://127.0.0.1:${proj.port}`, 'no --key');
    assert.equal(fs.readFileSync(file('bridge.envkey'), 'utf8').trim(), 'test-bridge-key');
    assert.match(run.text, /\$env:AGENT_HUB_BRIDGE_KEY = 'test-bridge-key'; node agent-hub-bridge\.mjs --hub https:\/\/tunnel-1\.trycloudflare\.com\b/);
    assert.doesNotMatch(run.text, /--key/);
    assert.equal(run.text.split('test-bridge-key').length - 1, 1, 'the key is still printed once');
    // A tunnel started after the bridge (a reconnect) does not inherit the key.
    fs.writeFileSync(file('stop-cf-1'), '');
    await run.waitFor(/https:\/\/tunnel-2\.trycloudflare\.com/, 60_000, 'the second tunnel');
    await waitUntil(() => fs.existsSync(file('cf-2.envkey')), 5000, 'second tunnel env record');
    assert.equal(fs.readFileSync(file('cf-2.envkey'), 'utf8').trim(), '<unset>');
  });
});

test('ps1: NO_BRIDGE=1 leaves this PC unconnected and says so; 0 connects it', { skip: SKIP_PS, timeout: 120_000 }, async () => {
  await withPs({ NO_BRIDGE: '1' }, async ({ run, file }) => {
    await run.waitFor(ONLINE, 60_000);
    await run.waitFor(/NO_BRIDGE，略過本機 Kimi 連接/, 5000, 'the skip message');
    await delay(800);
    assert.equal(fs.existsSync(file('bridge.pid')), false);
  });
  await withPs({ NO_BRIDGE: '0' }, async ({ run, file }) => {
    await run.waitFor(ONLINE, 60_000);
    await waitUntil(() => fs.existsSync(file('bridge.pid')), 10_000, 'the bridge');
    assert.doesNotMatch(run.text, /NO_BRIDGE/);
  });
});

test('ps1: the script keeps its Windows form (UTF-8 with a BOM, CRLF)', () => {
  const bytes = fs.readFileSync(PS1);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(!/[^\r]\n/.test(bytes.toString('utf8')), 'every line ends with CRLF');
});
