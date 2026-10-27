// Looking at, and ending, the processes the tests start. Shared by
// scripts/check-leaks.mjs, scripts/run-tests.mjs, scripts/take-screenshots.mjs
// and the test fixtures (test/fixtures/leak-guard.mjs, stop-daemons.mjs ...).
//
// Why this exists: a test that starts a Hub, a stand-in `node` or a browser and
// does not end it leaves a process behind that nobody will ever collect (the
// Claude daemon is even built to outlive its Hub). The old clean-up was
// `pkill -f "<command text>"`, which matches by text and so can hit a process
// that is not ours. Everything here matches by identity instead:
//   - a process belongs to a test when its command line, its working folder or
//     its environment points into a `<tmp>/agent-hub-*` folder (what every test
//     creates with mkdtemp), or it carries the AGENT_HUB_TEST_* stamp that
//     test/fixtures/leak-net.mjs puts in the environment;
//   - a signal is only sent to a PID whose start time is still the one we saw
//     (a recycled PID is not ours), and only after the match was re-checked.
//
// Linux reads /proc (command line, working folder, environment, start time).
// Elsewhere (macOS) it falls back to `ps`, which has the command text only:
// the matching by folder still works, the environment stamp does not. On
// Windows there is nothing to scan and every function reports "nothing".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HAS_PROC = fs.existsSync('/proc/self/stat');
export const CAN_SCAN = HAS_PROC || process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'linux';

// The environment stamps (set by test/fixtures/leak-net.mjs and
// scripts/run-tests.mjs, inherited by every child a test starts).
export const ENV_PROC = 'AGENT_HUB_TEST_PROC'; // the PID of the test file's process
export const ENV_RUN = 'AGENT_HUB_TEST_RUN'; // the id of one `npm test`

// Parents that adopt orphans: a process whose parent is one of these lost its own.
const ADOPTERS = new Set(['systemd', 'init', 'launchd', 'tini', 'dumb-init', 'docker-init', 'catatonit', 's6-svscan', 'runit']);

// Environment variables that name a folder a test owns.
const ENV_DIR_KEYS = ['GATE_DIR', 'AGENT_HUB_DATA', 'AGENT_HUB_WORKSPACES', 'HOME', 'TMPDIR', 'TEMP', 'PWD'];

export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let clkTck = 0;
function ticksPerSecond() {
  if (clkTck) return clkTck;
  const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
  clkTck = Number.parseInt(r.stdout, 10) || 100;
  return clkTck;
}
let bootMs = 0;
function bootTimeMs() {
  if (bootMs) return bootMs;
  try {
    const m = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    bootMs = m ? Number(m[1]) * 1000 : 0;
  } catch {
    bootMs = 0;
  }
  return bootMs;
}

// ------------------------------------------------------------------ reading processes

function readOne(pid, procRoot) {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'latin1');
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    const f = stat.slice(close + 2).split(' ');
    let args = [];
    try {
      args = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0');
      if (args[args.length - 1] === '') args.pop();
    } catch {}
    let cwd = null;
    try {
      cwd = fs.readlinkSync(`${procRoot}/${pid}/cwd`);
    } catch {}
    const startTicks = Number(f[19]);
    return {
      pid,
      ppid: Number(f[1]),
      pgid: Number(f[2]),
      state: f[0],
      comm: stat.slice(open + 1, close),
      startTicks,
      startMs: bootTimeMs() ? bootTimeMs() + (startTicks / ticksPerSecond()) * 1000 : null,
      args,
      cwd,
    };
  } catch {
    return null; // gone while we looked
  }
}

// Every process we can see: [{ pid, ppid, pgid, state, comm, startTicks, startMs, args, cwd }]
export function listProcesses({ procRoot = '/proc' } = {}) {
  if (HAS_PROC) {
    const out = [];
    for (const name of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      const p = readOne(Number(name), procRoot);
      if (p) out.push(p);
    }
    return out;
  }
  if (!CAN_SCAN) return [];
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[5].split(/\s+/);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), state: m[4][0], comm: path.basename(args[0] || ''), startTicks: null, startMs: null, args, cwd: null });
  }
  return out;
}

// The environment a process started with, or null (not ours to read, or gone,
// or this platform has none).
export function environOf(pid, { procRoot = '/proc' } = {}) {
  if (!HAS_PROC) return null;
  try {
    const env = new Map();
    for (const entry of fs.readFileSync(`${procRoot}/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0) env.set(entry.slice(0, i), entry.slice(i + 1));
    }
    return env;
  } catch {
    return null;
  }
}

// Still running (a zombie that only waits to be reaped does not count).
export function isRunning(pid) {
  if (HAS_PROC) {
    const p = readOne(pid, '/proc');
    return !!p && p.state !== 'Z' && p.state !== 'X';
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '' && !r.stdout.trim().startsWith('Z');
}

// The same process as when we looked? (a PID can be given to someone else.)
function sameProcess(proc) {
  if (!HAS_PROC || proc.startTicks == null) return isRunning(proc.pid);
  const now = readOne(proc.pid, '/proc');
  return !!now && now.startTicks === proc.startTicks && now.state !== 'Z' && now.state !== 'X';
}

export function ancestorsOf(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set();
  for (let p = byPid.get(pid); p && p.ppid > 0 && !out.has(p.ppid); p = byPid.get(p.ppid)) out.add(p.ppid);
  return out;
}

export function descendantsOf(procs, pid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([pid]);
  const stack = [...(kids.get(pid) || [])];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    stack.push(...(kids.get(p.pid) || []));
  }
  return out;
}

// ------------------------------------------------------------------ whose is it

export function tmpRoots() {
  const set = new Set();
  for (const d of [os.tmpdir(), '/tmp', '/var/tmp']) {
    if (!d) continue;
    set.add(d.replace(/\/+$/, ''));
    try {
      set.add(fs.realpathSync(d).replace(/\/+$/, ''));
    } catch {}
  }
  return [...set];
}

// "<tmp>/agent-hub-xxx" when `text` mentions such a folder (anywhere inside a
// longer path, an option like --dir=..., or a command line), else null.
export function ownerFromText(text, roots = tmpRoots()) {
  if (!text) return null;
  for (const root of roots) {
    const needle = `${root}/agent-hub-`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? '' : text[at - 1];
      if (before === '' || /[\s=:'"@]/.test(before)) {
        const rest = text.slice(at + root.length + 1);
        const name = /^[^/\s'"]+/.exec(rest)[0];
        return `${root}/${name}`;
      }
      from = at + 1;
    }
  }
  return null;
}

// The test folder a process belongs to, or null. `env` (optional) is read
// lazily when the command line and the working folder say nothing.
export function ownerDirOf(proc, { env } = {}) {
  const roots = tmpRoots();
  for (const a of proc.args) {
    const o = ownerFromText(a, roots);
    if (o) return o;
  }
  const c = ownerFromText(proc.cwd, roots);
  if (c) return c;
  const e = env === undefined ? environOf(proc.pid) : env;
  if (e) {
    for (const k of ENV_DIR_KEYS) {
      const o = ownerFromText(e.get(k), roots);
      if (o) return o;
    }
  }
  return null;
}

export function stampsOf(proc, env = environOf(proc.pid)) {
  return { proc: env?.get(ENV_PROC) || null, run: env?.get(ENV_RUN) || null, known: !!env };
}

const isDaemonScript = (a) => /^claude-daemon[^/]*\.(m|c)?js$|^fake-claude-daemon[^/]*\.(m|c)?js$/.test(path.basename(a));

// esbuild's JS API keeps one `esbuild --service=...` child for the life of the
// process that built something; it ends by itself when that process does. Not a
// leftover, and not worth a warning when a test file uses esbuild.
export const isSelfEnding = (proc) => path.basename(proc.args[0] || '') === 'esbuild' && proc.args.some((a) => a.startsWith('--service='));

// 'claude-daemon' | 'fakebin' | 'hub' | 'bridge' | 'chromium' | 'other'
export function classify(proc) {
  if (proc.args.some((a) => isDaemonScript(a))) return 'claude-daemon';
  if (proc.args.some((a) => /\/fakebin\/|(^|\/)stub-hub\.mjs$/.test(a))) return 'fakebin';
  if (proc.args.some((a) => /(^|\/)server\/index\.js$/.test(a))) return 'hub';
  if (proc.args.some((a) => /agent-hub-bridge\.mjs$/.test(a))) return 'bridge';
  if (/chrom/i.test(path.basename(proc.args[0] || proc.comm))) return 'chromium';
  return 'other';
}

// The folder a Claude daemon was started with (`--dir X` / `--dir=X`), resolved.
export function daemonDirOf(proc) {
  if (!proc.args.some((a) => isDaemonScript(a))) return null;
  for (let i = 0; i < proc.args.length; i++) {
    const a = proc.args[i];
    let v = null;
    if (a === '--dir') v = proc.args[i + 1];
    else if (a.startsWith('--dir=')) v = a.slice(6);
    if (v) return path.resolve(proc.cwd || '/', v);
  }
  return null;
}

export function isUnder(root, candidate) {
  const norm = (p) => path.resolve(p).replace(/\/+$/, '');
  const real = (p) => {
    try {
      return fs.realpathSync(p).replace(/\/+$/, '');
    } catch {
      return norm(p);
    }
  };
  for (const [r, c] of [[norm(root), norm(candidate)], [real(root), real(candidate)]]) {
    if (c === r || c.startsWith(r + path.sep)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ leftovers

export function isOrphan(proc, byPid) {
  if (proc.ppid <= 1) return true;
  const parent = byPid.get(proc.ppid);
  if (!parent) return true;
  return ADOPTERS.has(parent.comm);
}

// Test leftovers: processes that belong to a test (see ownerDirOf) and whose
// parent is gone. Only the roots are listed; what hangs below them is counted.
// `ignore`: PIDs that are never leftovers (default: this process and its ancestors).
export function findLeaks({ procs = listProcesses(), ignore } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const skip = ignore || new Set([process.pid, ...ancestorsOf(procs, process.pid)]);
  const now = Date.now();
  const leaks = [];
  for (const p of procs) {
    if (skip.has(p.pid) || p.state === 'Z' || p.state === 'X') continue;
    if (!isOrphan(p, byPid)) continue;
    const env = environOf(p.pid);
    const stamps = stampsOf(p, env);
    const owner = ownerDirOf(p, { env }) || (stamps.proc || stamps.run ? '(stamp)' : null);
    if (!owner) continue;
    leaks.push({
      pid: p.pid,
      ppid: p.ppid,
      kind: classify(p),
      owner,
      ownerExists: owner !== '(stamp)' && fs.existsSync(owner),
      startMs: p.startMs,
      startTicks: p.startTicks,
      ageSec: p.startMs ? Math.max(0, Math.round((now - p.startMs) / 1000)) : null,
      stamps,
      args: p.args,
      below: descendantsOf(procs, p.pid),
    });
  }
  return leaks;
}

// ------------------------------------------------------------------ ending processes

const signal = (pid, sig) => {
  try {
    process.kill(pid, sig);
  } catch {}
};

// TERM, wait, KILL — only the given processes (re-checked: same PID, same start
// time). Returns { ended, killed, stuck } as PID lists.
export function terminateSync(targets, { graceMs = 3000, killMs = 2000 } = {}) {
  const live = targets.filter(sameProcess);
  const result = { ended: [], killed: [], stuck: [] };
  for (const t of live) signal(t.pid, 'SIGTERM');
  let left = live;
  for (const until = Date.now() + graceMs; left.length && Date.now() < until;) {
    sleepSync(40);
    left = left.filter((t) => sameProcess(t));
  }
  result.ended = live.filter((t) => !left.includes(t)).map((t) => t.pid);
  for (const t of left) if (sameProcess(t)) signal(t.pid, 'SIGKILL');
  for (const until = Date.now() + killMs; left.length && Date.now() < until;) {
    sleepSync(40);
    left = left.filter((t) => sameProcess(t));
  }
  result.killed = live.filter((t) => !left.includes(t) && !result.ended.includes(t.pid)).map((t) => t.pid);
  result.stuck = left.map((t) => t.pid);
  return result;
}

export async function terminate(targets, { graceMs = 3000, killMs = 2000 } = {}) {
  const live = targets.filter(sameProcess);
  const result = { ended: [], killed: [], stuck: [] };
  for (const t of live) signal(t.pid, 'SIGTERM');
  let left = live;
  for (const until = Date.now() + graceMs; left.length && Date.now() < until;) {
    await delay(40);
    left = left.filter((t) => sameProcess(t));
  }
  result.ended = live.filter((t) => !left.includes(t)).map((t) => t.pid);
  for (const t of left) if (sameProcess(t)) signal(t.pid, 'SIGKILL');
  for (const until = Date.now() + killMs; left.length && Date.now() < until;) {
    await delay(40);
    left = left.filter((t) => sameProcess(t));
  }
  result.killed = live.filter((t) => !left.includes(t) && !result.ended.includes(t.pid)).map((t) => t.pid);
  result.stuck = left.map((t) => t.pid);
  return result;
}

// ------------------------------------------------------------------ the Claude daemon

// The folder must be a scratch folder: an empty path or "/" would otherwise
// match every daemon on the machine, and a daemon of a real data folder must
// never be touched by a test's clean-up.
function checkScratch(root, allowOutsideTmp) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) {
    throw new Error(`stopDaemons: need an absolute folder, got ${JSON.stringify(root)}`);
  }
  if (!allowOutsideTmp && !tmpRoots().some((t) => isUnder(t, root) && path.resolve(root) !== t)) {
    throw new Error(`stopDaemons: ${root} is not inside the temp folder (${tmpRoots().join(', ')}); refusing to stop daemons there`);
  }
}

// Daemons (server/claude-daemon.js, the bundled bridge/claude-daemon.mjs, the
// test stand-in) whose --dir is `root` or lies inside it.
export function findDaemons(root, { procs = listProcesses(), allowOutsideTmp = false } = {}) {
  checkScratch(root, allowOutsideTmp);
  const skip = new Set([process.pid, ...ancestorsOf(procs, process.pid)]);
  return procs.filter((p) => {
    if (skip.has(p.pid) || p.state === 'Z' || p.state === 'X') return false;
    const dir = daemonDirOf(p);
    return !!dir && isUnder(root, dir);
  });
}

// End the Claude daemons of one test's data folder — only those. End the Hub
// first: a Hub that still runs starts a new daemon two seconds after its
// daemon went away. Never `pkill -f`: that matches text, this matches the
// folder the daemon was started with.
export async function stopDaemons(root, opts = {}) {
  return terminate(findDaemons(root, opts), opts);
}
export function stopDaemonsSync(root, opts = {}) {
  return terminateSync(findDaemons(root, opts), opts);
}

// Stop a child process we started and wait until it is really gone (not just
// signalled): the way to end a Hub before its daemon.
export function stopChildSync(child, { graceMs = 5000, killMs = 3000 } = {}) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null && child.exitCode !== undefined) return; // gone (and its PID may be someone else's by now)
  if (child.signalCode) return;
  const proc = HAS_PROC ? readOne(child.pid, '/proc') : { pid: child.pid, startTicks: null };
  if (!proc || (HAS_PROC && proc.state === 'Z')) return;
  terminateSync([proc], { graceMs, killMs });
}
