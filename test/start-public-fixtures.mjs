// Shared pieces for the tests that run scripts/start-public.sh and
// scripts/start-public.ps1 in a throw-away copy of the project with stand-ins
// for node, cloudflared, kimi and uname — and, for the download checks, a real
// HTTP server on loopback in place of github.com. Nothing here touches the
// network or the real data folder.
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { after } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_PROC } from '../scripts/proc-scan.mjs';
import { assertNoLeaks, snapshot } from './fixtures/leak-guard.mjs';
import { killAllGroups, killGroup, releaseGate, spawnGroup } from './fixtures/proc-group.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SH = path.join(REPO, 'scripts', 'start-public.sh');
export const PS1 = path.join(REPO, 'scripts', 'start-public.ps1');

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const isAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export async function waitUntil(fn, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const writeExec = (file, body) => {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
};

// Every stand-in below waits for something (a stop file, a signal). None of
// them may wait for ever: a test that timed out, was killed or deleted its
// folder must not leave them looping — each one cost a fork every 50 ms until
// the machine was full of them. So every wait loop runs only while
//   - the gate folder still exists (the test has not deleted its project),
//   - the process that started us is still alive (the script, or PowerShell),
//   - and for at most SHIM_TTL seconds (longer than any single test),
// and the stand-in leaves on TERM/INT. The loop sleeps in steps of 0.2 s.
export const SHIM_TTL = 240;
// `ttl`: seconds (the tests of the guard itself use a short one).
export const shimFuncs = (ttl = SHIM_TTL) => String.raw`shim_t0=$SECONDS
shim_alive() { [ -d "$GATE_DIR" ] && kill -0 "$PPID" 2>/dev/null && [ $((SECONDS - shim_t0)) -lt @{SHIM_TTL} ]; }`
  .replaceAll('@{SHIM_TTL}', String(ttl));
export const SHIM_FUNCS = shimFuncs();
export const SHIM_PRELUDE = `${SHIM_FUNCS}\ntrap 'exit 0' TERM INT`;

// A stand-in `node`: answers the version probes and "runs" the hub and bridge
// as scripts that wait for a flag file.
export const FAKE_NODE = String.raw`#!/usr/bin/env bash
set +u
@{SHIM_PRELUDE}
case "$1" in
  -p)
    expr="$2"
    case "$expr" in
      *process.versions.node.split*) printf '22\n' ;;
      *process.versions.node*) printf '22.0.0\n' ;;
      *hub.json*token*) sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' data/hub.json | head -n1 ;;
      *hub.json*bridgeKey*) sed -n 's/.*"bridgeKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' data/hub.json | head -n1 ;;
      *) echo "fake node: unsupported -p $expr" >&2; exit 1 ;;
    esac
    ;;
  -v)
    printf 'v22.0.0\n'
    ;;
  server/index.js)
    printf '已啟動\n'
    printf '%s\n' "$$" > "$GATE_DIR/hub.pid"
    while shim_alive && [ ! -e "$GATE_DIR/stop-hub" ]; do sleep 0.2; done
    ;;
  bridge/agent-hub-bridge.mjs)
    printf '%s\n' "$$" > "$GATE_DIR/bridge.pid"
    printf '%s\n' "$*" > "$GATE_DIR/bridge.args"
    printf '%s\n' "@{AGENT_HUB_BRIDGE_KEY-<unset>}" > "$GATE_DIR/bridge.envkey"
    while shim_alive && [ ! -e "$GATE_DIR/stop-bridge" ]; do sleep 0.2; done
    ;;
  *)
    echo "fake node: unsupported arguments: $*" >&2
    exit 1
    ;;
esac
`.replaceAll('@{SHIM_PRELUDE}', SHIM_PRELUDE).replaceAll('@{', '${'); // (String.raw would read ${...} as its own substitution)

// A stand-in cloudflared: opens "tunnel N" (prints its address) and waits.
// Also leaves a mark that it was really executed.
export const FAKE_CLOUDFLARED = String.raw`#!/usr/bin/env bash
set +u
@{SHIM_FUNCS}
GATE="$GATE_DIR"
: > "$GATE/cloudflared.executed"
n=1
while ! mkdir "$GATE/cf-lock-$n" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 100 ]; then echo "fake cloudflared: too many attempts" >&2; exit 1; fi
done
printf '%s\n' "$$" > "$GATE/cf-$n.pid"
printf '%s\n' "@{AGENT_HUB_BRIDGE_KEY-<unset>}" > "$GATE/cf-$n.envkey"
printf 'INF  https://tunnel-%s.trycloudflare.com\n' "$n" >&2   # like the real one: the address goes to stderr
stop=0
trap 'stop=1' TERM INT
while [ "$stop" -eq 0 ] && shim_alive && [ ! -e "$GATE/stop-cf-$n" ]; do sleep 0.2; done
exit 0
`.replaceAll('@{SHIM_FUNCS}', SHIM_FUNCS).replaceAll('@{', '${');

// The same, and it also records when two tunnels run at the same time
// (violations.log), which the reconnect tests assert never happens.
export const FAKE_CLOUDFLARED_TRACKED = String.raw`#!/usr/bin/env bash
set +u
@{SHIM_FUNCS}
GATE="$GATE_DIR"
n=1
while ! mkdir "$GATE/cf-lock-$n" 2>/dev/null; do n=$((n + 1)); [ "$n" -gt 100 ] && exit 1; done
if [ -e "$GATE/active-cf.pid" ]; then
  other="$(cat "$GATE/active-cf.pid" 2>/dev/null)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then printf 'double tunnel: %s and %s\n' "$other" "$$" >> "$GATE/violations.log"; fi
fi
printf '%s\n' "$$" > "$GATE/active-cf.pid"
printf '%s\n' "$$" > "$GATE/cf-$n.pid"
printf 'INF  https://tunnel-%s.trycloudflare.com\n' "$n" >&2
stop=0
trap 'stop=1' TERM INT
while [ "$stop" -eq 0 ] && shim_alive && [ ! -e "$GATE/stop-cf-$n" ]; do sleep 0.2; done
rm -f "$GATE/active-cf.pid"
exit 0
`.replaceAll('@{SHIM_FUNCS}', SHIM_FUNCS);

// The stand-in hub for the PowerShell script: a real listener on PORT that
// ends when stop-hub appears — or when its gate folder or its parent is gone,
// or after SHIM_TTL seconds. `announce`: print a line like the real hub's.
export const psStubHub = ({ announce = false } = {}) => String.raw`
import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
const gate = process.env.GATE_DIR;
const parent = process.ppid;
const deadline = Date.now() + ${SHIM_TTL} * 1000;
fs.writeFileSync(path.join(gate, 'hub.pid'), String(process.pid));
${announce ? "console.log('Agent Hub 已啟動 登入密碼 test-token');" : ''}
const srv = net.createServer((s) => s.end()).listen(Number(process.env.PORT), '127.0.0.1');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => {
  if (fs.existsSync(path.join(gate, 'stop-hub')) || !fs.existsSync(gate) || !alive(parent) || Date.now() > deadline) { srv.close(); process.exit(0); }
}, 100);
`;

// The stand-in `node` for the PowerShell script: the hub is psStubHub (exec'd),
// the bridge waits for stop-bridge. `record`: also write what the bridge was
// given (arguments, bridge key) for the tests that check them.
export const psFakeNode = (stubPath, { record = false } = {}) => `#!/usr/bin/env bash
${SHIM_PRELUDE}
case "$1" in
  -v) echo v22.0.0 ;;
  server/index.js) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubPath)} ;;
  bridge/agent-hub-bridge.mjs)
    echo $$ > "$GATE_DIR/bridge.pid"
${record ? `    printf '%s\\n' "$*" > "$GATE_DIR/bridge.args"
    printf '%s\\n' "\${AGENT_HUB_BRIDGE_KEY-<unset>}" > "$GATE_DIR/bridge.envkey"
` : ''}    while shim_alive && [ ! -e "$GATE_DIR/stop-bridge" ]; do sleep 0.2; done ;;
  *) echo "fake node: $*" >&2; exit 1 ;;
esac
`;

// uname answers from FAKE_UNAME_S / FAKE_UNAME_M so one machine can pretend to
// be every platform the download table covers.
const FAKE_UNAME = String.raw`#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\n' "@{FAKE_UNAME_S:-Linux}" ;;
  -m) printf '%s\n' "@{FAKE_UNAME_M:-x86_64}" ;;
  *) echo "fake uname: $*" >&2; exit 1 ;;
esac
`.replaceAll('@{', '${');

// The tools the scripts use, and nothing else, behind one directory — so a
// cloudflared that happens to be installed on the machine running the tests
// is not on the PATH, and a missing sha256 tool can be simulated.
const TOOLS = ['bash', 'env', 'dirname', 'basename', 'mkdir', 'mktemp', 'cat', 'seq', 'sleep', 'grep', 'head', 'tail', 'cp', 'cmp', 'rm', 'tr', 'awk', 'sed', 'curl', 'tar', 'gzip', 'mv', 'chmod', 'touch', 'printf', 'kill', 'date', 'ls', 'wc', 'sha256sum', 'shasum', 'openssl'];
export function toolbox(dir, { omit = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of TOOLS) {
    if (omit.includes(name)) continue;
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    const found = r.status === 0 ? r.stdout.trim() : '';
    if (found && found.startsWith('/')) fs.symlinkSync(found, path.join(dir, name));
  }
  return dir;
}
// A TCP port nobody is listening on, asked of the kernel (the stand-in hub of
// the PowerShell tests really listens). A random port in a fixed range collided
// with the stand-ins that earlier test runs had left behind, and the script
// then talked to the wrong "hub".
export const freePortSync = () => Number(spawnSync(process.execPath, ['-e', "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });"], { encoding: 'utf8' }).stdout.trim());
export const realPath = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();

// Every project folder made in this file's process: the leak check looks for
// processes that still point into one of them (see guardLeaks).
const projectDirs = new Set();
export const trackDir = (dir) => (projectDirs.add(dir), dir);

// Delete a project folder the safe way: the stop files the stand-ins wait for
// are written first, so one that somehow still runs ends instead of waiting for
// a file in a folder that is gone. (Not in run.stop(): a project is reused by
// several runs one after the other, and a stale stop file would end the next.)
export function removeProject(project) {
  releaseGate(project.gate);
  fs.rmSync(project.tmp, { recursive: true, force: true });
}

// In the test file's top level: when the file is done every script group is
// ended, and no process that began after this call may still point into one of
// the project folders (or carry this file's stamp). The failing list names them.
export function guardLeaks() {
  const before = snapshot();
  after(async () => {
    await killAllGroups();
    await assertNoLeaks(before, { dirs: [...projectDirs] });
  });
}

// A throw-away copy of the project the scripts can run in.
// hubJson: what data/hub.json holds (an object), a raw string, or null for no file.
export function setupProject({ script = SH, installedCloudflared = false, kimi = true, omitTools = [], extraFiles = {}, hubJson = { token: 'test-token', bridgeKey: 'test-bridge-key' } } = {}) {
  const tmp = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-start-public-')));
  const gate = path.join(tmp, 'gate');
  const fakebin = path.join(tmp, 'fakebin');
  const tools = path.join(tmp, 'tools');
  for (const d of ['gate', 'fakebin', 'scripts', 'server', 'bridge', 'node_modules', 'data', 'temp']) fs.mkdirSync(path.join(tmp, d));
  fs.copyFileSync(script, path.join(tmp, 'scripts', path.basename(script)));
  fs.writeFileSync(path.join(tmp, 'server', 'index.js'), '');
  fs.writeFileSync(path.join(tmp, 'bridge', 'agent-hub-bridge.mjs'), '');
  const lock = '{"lockfileVersion":3}\n';
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(tmp, 'node_modules', '.agent-hub-lock.json'), lock);
  if (hubJson !== null) fs.writeFileSync(path.join(tmp, 'data', 'hub.json'), typeof hubJson === 'string' ? hubJson : JSON.stringify(hubJson));
  toolbox(tools, { omit: omitTools });
  writeExec(path.join(fakebin, 'node'), FAKE_NODE);
  writeExec(path.join(fakebin, 'uname'), FAKE_UNAME);
  if (installedCloudflared) writeExec(path.join(fakebin, 'cloudflared'), FAKE_CLOUDFLARED);
  if (kimi) writeExec(path.join(fakebin, 'kimi'), '#!/usr/bin/env bash\nexit 0\n');
  for (const [rel, body] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), body);
  }
  return { tmp, gate, fakebin, tools, path: `${fakebin}:${tools}` };
}

// Runs scripts/start-public.sh in `project`. `env` is added to a minimal
// environment (no inherited PATH, token or bridge key).
export function runScript(project, { env = {}, script = SH, command = realPath('bash'), args = null, inherit = false } = {}) {
  // PowerShell needs its own environment (.NET looks at it); nothing of this
  // project's — token, bridge key — is inherited either way.
  const base = inherit ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AGENT_HUB_|HUB_|NO_BRIDGE$|PORT$)/.test(k))) : {};
  // A group of its own (spawnGroup): stop() ends the script AND everything it started.
  const child = spawnGroup(command, args || [path.join(project.tmp, 'scripts', path.basename(script))], {
    cwd: project.tmp,
    env: { ...base, [ENV_PROC]: process.env[ENV_PROC], HOME: project.tmp, PATH: project.path, GATE_DIR: project.gate, PORT: '18787', TMPDIR: path.join(project.tmp, 'temp'), TEMP: path.join(project.tmp, 'temp'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (c) => (text += c));
  }
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return {
    child,
    exited,
    get text() {
      return text;
    },
    async waitFor(re, timeout = 20000, label = String(re)) {
      await waitUntil(() => re.test(text), timeout, `${label}; output so far:\n${text}`);
    },
    async finished(timeout = 20000) {
      return Promise.race([exited, delay(timeout).then(() => { throw new Error(`script did not exit within ${timeout} ms; output:\n${text}`); })]);
    },
    async stop() {
      await killGroup(child);
    },
  };
}

// A local stand-in for github.com/cloudflare/cloudflared/releases/download:
// `files` maps a request path to the bytes to serve (anything else is 404).
export async function startAssetServer(files = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = files[req.url];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}/releases/download`,
    requests,
    files,
    close: () => new Promise((r) => server.close(r)),
  };
}
