#!/usr/bin/env node
// Agent Hub bridge — runs on every computer whose Kimi Code you want to use
// from the hub. It connects *out* to the hub (no open ports, works behind
// NAT) and relays:
//   • conversations: read live from Kimi's own session files, so the hub
//     follows Kimi wherever it runs — the terminal (TUI) or `kimi web`;
//   • actions: a whitelisted subset of Kimi's Server API (`kimi web`), or
//     keystrokes into a terminal Kimi started with `agent-hub-bridge.mjs kimi`.
// Kimi keeps running on this computer, with this computer's Kimi login.
// Claude conversations (Claude API, with the hub's API key) can also work in
// a folder here: they run in a Claude daemon the bridge starts on this
// computer (downloaded from the hub), which keeps them going when the hub or
// the bridge is closed; the bridge relays the hub's requests and the
// daemon's events. Their tools are commands, and files read and written
// inside the conversation's folder.
//
//   node agent-hub-bridge.mjs --hub https://your-hub.example.com --key <bridge key>
//   node agent-hub-bridge.mjs kimi [Kimi options]    # Kimi in this terminal, controllable from the hub
//
// Options:
//   --name <name>        Computer name shown in the hub (default: hostname)
//   --start-kimi         Start `kimi web --no-open` if no Kimi server is running
//   --kimi-bin <path>    Kimi Code CLI executable (default: kimi)
//   --kimi-home <dir>    Kimi data directory (default: $KIMI_CODE_HOME or ~/.kimi-code)
//   --no-skill           Do not install the /artifact and /github skills into Kimi
//   --no-broker          Do not install the sub-agent broker (MCP + hook) into Kimi
//   --state-dir <dir>    Where the bridge keeps its state (default: ~/.agent-hub)
//
// DeepSeek key pool (the loopback proxy), environment, all optional:
//   AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS  wait for a gateway's first byte (default 120000)
//   AGENT_HUB_DEEPSEEK_IDLE_MS        longest silence inside a stream (default 300000)
//   AGENT_HUB_DEEPSEEK_RETRY_MS       gap between real requests that look again at an exhausted key whose
//                                     gateway stated no reset time (default 30000)
//   AGENT_HUB_DAEMON_RECHECK_MS       how often a stale Claude daemon is looked at (default 15000)
// The hello names what this version supports (`capabilities`); a Claude daemon
// that lacks what the hub's features need is replaced as soon as it is idle.
//
// Requires Node.js 22+ (built-in fetch and WebSocket). No dependencies. The
// `kimi` mode also needs python3 (for the pseudo-terminal) on macOS / Linux.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 0.11.0: the first connector that says what it can do (`capabilities` in its
// hello) and that refuses to hand work to a Claude daemon too old for it.
const VERSION = '0.11.0';
const BROKER_VERSION = 1;
let brokerReady = false;
const SCRIPT = fileURLToPath(import.meta.url);

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const MODE = ['kimi', 'mcp', 'hook'].includes(argv[0]) ? argv[0] : 'bridge';
const flags = MODE === 'kimi' || MODE === 'mcp' || MODE === 'hook' ? argv.slice(1) : argv;
const opt = (name, fallback) => {
  const i = flags.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = flags[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
if (MODE === 'bridge' && (argv.includes('--help') || argv.includes('-h'))) {
  console.log(fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

// ---- durable-write:begin
// A file written whole or not at all: the new content goes next to it, is forced
// to disk, replaces the file with a rename, and the folder entry is forced too.
// A kill (or a power cut) in the middle leaves the old file, never half of a new
// one nor a full-sized file of zeros; `mode` keeps a private file private from
// its first byte. The same shape as writeJsonAtomic in server/store.js (this
// connector is one file and imports nothing of the Hub).
function writeFileDurable(file, data, mode) {
  const fd = fs.openSync(file, 'w', mode ?? 0o666);
  try {
    // A file that was already there keeps its own permissions: a private one must not inherit them.
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}
function writeFileAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileDurable(tmp, data, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(path.dirname(file));
}
// What a process killed in the middle of writeFileAtomic leaves behind:
// `<name>.<pid>.tmp`. Removed once that process is gone; a live process's file
// is its write in progress.
function removeStaleTmp(file) {
  const base = `${path.basename(file)}.`;
  let names;
  try {
    names = fs.readdirSync(path.dirname(file));
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.startsWith(base) && /^(\d+)\.tmp$/.exec(name.slice(base.length));
    if (!m || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), 0);
      continue; // alive
    } catch (err) {
      if (err.code === 'EPERM') continue; // alive, somebody else's
    }
    fs.rmSync(path.join(path.dirname(file), name), { force: true });
  }
}
// ---- durable-write:end

const STATE_DIR = path.resolve(String(opt('state-dir', path.join(os.homedir(), '.agent-hub'))));
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');
// bridge.json holds the hub address, the bridge key and the DeepSeek key pool:
// a file that is there but cannot be used is not taken for "no state" in
// silence. A damaged one is copied (byte for byte, private, named after its
// content so the same damage is kept once) before a new state is written; one
// that cannot be read is not written over at all (the connector goes on without
// saving). Said on stderr: the `mcp` mode's stdout is its protocol.
let stateWritable = true;
function loadState() {
  removeStaleTmp(STATE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    stateWritable = false;
    console.error(`[agent-hub] 讀不到 ${STATE_FILE}（${err.code || err.message}）。為了不蓋掉可能還好好的內容，這次不會寫入它（連接器照常執行，但這台電腦的代號每次啟動都會重新產生，重新啟動後也要再帶 --hub 與 --key）。`);
    return {};
  }
  try {
    const state = JSON.parse(raw.toString('utf8'));
    if (state && typeof state === 'object' && !Array.isArray(state)) return state;
  } catch {}
  const copy = `${STATE_FILE}.damaged-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(copy)) writeFileDurable(copy, raw, 0o600);
    console.error(`[agent-hub] ${STATE_FILE} 損壞，無法載入。原檔已原封不動備份到 ${copy}；DeepSeek 號池要等中控台重新送來，hub 位址與連接金鑰以這次的 --hub、--key 為準；這台電腦在中控台的代號會重新產生（中控台會當成新電腦），要沿用舊的就把備份裡的 "ids" 抄回新檔。`);
  } catch (err) {
    stateWritable = false;
    console.error(`[agent-hub] ${STATE_FILE} 損壞，而且沒能先備份原檔（${err.message}）。為了不蓋掉唯一的一份，這次不會寫入它。`);
  }
  return {};
}
function saveState(state) {
  if (!stateWritable) return;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}
const STATE = loadState();
try {
  fs.chmodSync(STATE_FILE, 0o600);
} catch {}

const KIMI_HOME = path.resolve(String(opt('kimi-home', process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'))));
const IS_WIN = process.platform === 'win32';
const KIMI_BIN = String(opt('kimi-bin', process.env.AGENT_HUB_KIMI_BIN || STATE.kimiBin || 'kimi'));
const HUB = String(opt('hub', process.env.AGENT_HUB_URL || '')).replace(/\/+$/, '');
const KEY = String(opt('key', process.env.AGENT_HUB_BRIDGE_KEY || ''));
const NAME = String(opt('name', os.hostname()));
const START_KIMI = Boolean(opt('start-kimi', false));
const INSTALL_SKILL = !flags.includes('--no-skill');
const WORKSPACES = path.join(os.homedir(), 'agent-hub-workspaces');
const SESSIONS_DIR = path.join(KIMI_HOME, 'sessions');
const HOME_TAG = crypto.createHash('sha1').update(KIMI_HOME).digest('hex').slice(0, 10);
// Local control channel for terminal Kimis (unix socket paths max ~104 bytes).
const SOCK =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-hub-${HOME_TAG}`
    : path.join(STATE_DIR, `bridge-${HOME_TAG}.sock`).length < 100
      ? path.join(STATE_DIR, `bridge-${HOME_TAG}.sock`)
      : path.join(os.tmpdir(), `agent-hub-${process.getuid?.() ?? 0}-${HOME_TAG}.sock`);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error(`需要 Node.js 22 以上版本（內建 WebSocket）。目前版本：${process.version}`);
  process.exit(1);
}

// ============================================================ kimi mode
// Runs the Kimi TUI in a pseudo-terminal (via python3's pty module) so it
// works exactly as usual in this terminal, while the bridge can type into it
// on the hub's behalf: messages, approvals, Esc to stop.

const PTY_PY = String.raw`
import os, sys, pty, tty, termios, fcntl, select, signal, json
argv = json.loads(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write('cannot start %s: %s\n' % (argv[0], e))
        os._exit(127)
CTL = 3
try:
    os.write(CTL, (json.dumps({'pid': pid}) + '\n').encode())
except OSError:
    pass
tty_in = os.isatty(0)
def resize(*_):
    if not tty_in:
        return
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
    except OSError:
        pass
signal.signal(signal.SIGWINCH, resize)
resize()
saved = termios.tcgetattr(0) if tty_in else None
if tty_in:
    tty.setraw(0)
def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
            data = data[n:]
        except BlockingIOError:
            select.select([], [fd], [])
fds = [master, 0, CTL]
try:
    while True:
        r, _, _ = select.select(fds, [], [])
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            write_all(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                fds.remove(0)
        if CTL in r:
            try:
                data = os.read(CTL, 65536)
            except OSError:
                data = b''
            if data:
                write_all(master, data)
            else:
                fds.remove(CTL)
finally:
    if saved:
        termios.tcsetattr(0, termios.TCSAFLUSH, saved)
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
`;

function findPython() {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import pty, termios'], { stdio: 'ignore' });
      return py;
    } catch {}
  }
  return null;
}

function connectSock() {
  return new Promise((resolve) => {
    const c = net.connect(SOCK);
    c.once('connect', () => resolve(c));
    c.once('error', () => resolve(null));
  });
}

// Connect to the running bridge; start one in the background (with the hub
// address saved by the last run) if there is none.
async function daemonConnection() {
  let c = await connectSock();
  if (c || !STATE.hub || !STATE.key) return c;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(path.join(STATE_DIR, 'bridge.log'), 'a');
  const args = [SCRIPT, '--hub', STATE.hub, '--key', STATE.key, '--name', STATE.name || os.hostname(), '--kimi-home', KIMI_HOME];
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 25 && !c; i++) {
    await new Promise((r) => setTimeout(r, 200));
    c = await connectSock();
  }
  return c;
}

async function runKimi(args) {
  const py = process.platform === 'win32' ? null : findPython();
  const env = { ...process.env, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME || KIMI_HOME };
  if (!py) {
    console.error('（找不到 python3：中控台沒辦法把輸入直接打進這個終端機的 Kimi。終端機照常使用；中控台改經 Kimi 伺服器操作同一個對話，兩邊可以並存）');
    const c = spawn(KIMI_BIN, args, { stdio: 'inherit', env, shell: IS_WIN });
    c.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  let conn = await daemonConnection();
  if (!conn) console.error('（連接器沒有在執行，這個 Kimi 暫時不能從中控台操作。先在這台電腦執行一次中控台給你的連接指令）');
  const child = spawn(py, ['-c', PTY_PY, JSON.stringify([KIMI_BIN, ...args])], { stdio: ['inherit', 'inherit', 'inherit', 'pipe'], env });
  const ctl = child.stdio[3];
  let kimiPid = null;
  let head = '';
  const hello = () => conn?.write(`${JSON.stringify({ t: 'hello', pid: kimiPid, cwd: process.cwd(), startedAt: Date.now() })}\n`);
  ctl.on('data', (d) => {
    if (kimiPid) return;
    head += d;
    const i = head.indexOf('\n');
    if (i === -1) return;
    try {
      kimiPid = JSON.parse(head.slice(0, i)).pid;
    } catch {}
    hello();
  });
  ctl.on('error', () => {});
  const listen = (c) => {
    let buf = '';
    c.setEncoding('utf8'); // a character cut at a chunk boundary stays whole
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.t === 'input' && m.data) ctl.write(Buffer.from(m.data, 'base64'));
        } catch {}
      }
    });
    c.on('error', () => {});
    c.on('close', () => {
      conn = null;
      // The bridge restarted: register again once it is back.
      const retry = setInterval(async () => {
        const n = await connectSock();
        if (!n) return;
        clearInterval(retry);
        conn = n;
        listen(n);
        if (kimiPid) hello();
      }, 3000);
      retry.unref();
    });
  };
  if (conn) listen(conn);
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ========================================================== bridge mode

async function runBridge() {
  if (!HUB || !KEY || HUB === 'true' || KEY === 'true') {
    console.error('用法：node agent-hub-bridge.mjs --hub https://你的中控台網址 --key 連接金鑰');
    process.exit(1);
  }
  // Only one bridge per Kimi home: a second one would fight over the hub link.
  const other = await connectSock();
  if (other) {
    other.end();
    console.log('這台電腦的連接器已經在執行了。');
    process.exit(0);
  }
  STATE.ids ??= {};
  STATE.ids[KIMI_HOME] ??= `m_${crypto.randomBytes(5).toString('hex')}`;
  Object.assign(STATE, { hub: HUB, key: KEY, name: NAME });
  if (opt('kimi-bin', null)) STATE.kimiBin = KIMI_BIN;
  saveState(STATE);
  const MACHINE_ID = STATE.ids[KIMI_HOME];
  installSelf();

  log(`Agent Hub 連接器 ${VERSION} · Kimi 資料夾 ${KIMI_HOME}`);
  try {
    STATE.kimiVersion = execFileSync(KIMI_BIN, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], shell: IS_WIN, windowsHide: true }).match(/\d+\.\d+\.\d+/)?.[0] || STATE.kimiVersion;
  } catch {
    log(`… 找不到 Kimi Code（${KIMI_BIN}）。安裝：npm i -g @moonshot-ai/kimi-code`);
  }
  installSkill();
  listenLocal();
  if (START_KIMI) await server.start().catch((err) => log(`✗ ${err.message}`));
  else await server.discover();
  disk.scan();
  // Install the MCP/hook before the bridge announces itself. The hook service
  // only reads config at Kimi startup, so installBroker may restart an idle
  // server; waiting here keeps early hub messages from racing that restart.
  let brokerTrying = false;
  const ensureBroker = async () => {
    if (brokerReady || brokerTrying || flags.includes('--no-broker') || !server.instance) return;
    brokerTrying = true;
    try {
      await installBroker();
      brokerReady = true;
      if (hub.ws?.readyState === 1) hub.send({ t: 'broker.ready', broker: BROKER_VERSION, capabilities: connectorCapabilities() });
    } catch (err) {
      log(`… 子代理 broker 未安裝：${err.message}`);
    } finally {
      brokerTrying = false;
    }
  };
  await ensureBroker();
  // A pool provisioned before the bridge restarted is live again: its local
  // proxy comes back on the same port when possible, so existing DeepSeek
  // conversations keep working while the hub reconnects.
  try {
    await proxy.resume();
  } catch (err) {
    log(`… DeepSeek 號池 proxy 沒有啟動：${err.message}`);
  }
  hub.connect(MACHINE_ID);
  setInterval(ensureBroker, 10_000).unref();
  // A Claude daemon from an earlier run may still be running conversations.
  if (fs.existsSync(path.join(daemon.dir, 'daemon.json'))) daemon.follow();

  setInterval(() => hub.send({ t: 'ping' }), 25_000);
  setInterval(() => !server.instance && server.discover(), 4000);
  setInterval(() => disk.scan(), 2000);
  setInterval(() => disk.poll(), 150);
  setInterval(() => procs.scan(), 2000);
  setInterval(() => procs.tuis.length && procs.webbed.length && procs.check(), 3000);
  setInterval(() => hub.pushSessions(true), 30_000);
  // The Claude daemon is left running: it is not ours to stop.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

// A stable copy for `alias kimi=…`, wherever the bridge was downloaded to.
function installSelf() {
  const dest = path.join(STATE_DIR, 'agent-hub-bridge.mjs');
  try {
    if (path.resolve(SCRIPT) !== dest && fs.readFileSync(SCRIPT, 'utf8') !== (fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '')) fs.copyFileSync(SCRIPT, dest);
  } catch {}
}

// ------------------------------------------------------- local Kimi server

// Only these Kimi Server API calls may be made through the bridge. Anything
// that reads arbitrary host files, opens desktop apps, changes providers or
// shuts the server down is refused here, whatever the hub asks for.
const ALLOW = [
  ['GET', /^\/api\/v1\/(meta|auth|models|healthz|config)$/],
  ['GET', /^\/api\/v1\/oauth\/(usage|userinfo|region)$/],
  ['GET', /^\/api\/v1\/providers$/],
  ['GET', /^\/api\/v1\/fs:(browse|home)(\?.*)?$/],
  ['GET', /^\/api\/v1\/sessions(\?.*)?$/],
  ['GET', /^\/api\/v1\/workspaces\/[\w.-]+\/skills$/],
  ['POST', /^\/api\/v1\/sessions$/],
  ['GET', /^\/api\/v1\/sessions\/session_[\w-]+(\/[\w./:-]*)?(\?.*)?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+(:(abort|compact|fork|undo|btw|archive))?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/(prompts|prompts:steer|prompts\/[\w-]+:(abort|steer)|approvals\/[\w-]+|questions\/[\w-]+(:dismiss)?|profile|skills\/[\w.%-]+:activate)$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/fs:(list|read|stat|git_status|diff|search|grep)$/],
  // Ctrl+B: move work running in the foreground to the background.
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/tasks\/[\w-]+:detach$/],
];
const allowed = (method, p) => ALLOW.some(([m, re]) => m === method && re.test(p));

const server = {
  instance: null,
  token: null,
  ws: null,
  subs: new Set(),
  acks: new Map(), // ws request id -> resolve(ack)
  version: null,
  seen: new Map(), // session id -> last time the server reported activity for it
  busy: new Set(), // sessions the server says are busy
  mine: new Map(), // session id -> when the hub created, drove or unlocked it through the server

  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  },

  // Running `kimi web` servers register under <home>/server/instances/.
  async discover() {
    const dir = path.join(KIMI_HOME, 'server', 'instances');
    let best = null;
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.json')) continue;
      try {
        const inst = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!inst.port || (inst.pid && !this.alive(inst.pid))) continue;
        const res = await fetch(`http://${inst.host === '0.0.0.0' ? '127.0.0.1' : inst.host || '127.0.0.1'}:${inst.port}/api/v1/healthz`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        if (!best || (inst.started_at || 0) > (best.started_at || 0)) best = inst;
      } catch {}
    }
    let token = null;
    try {
      token = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
    } catch {}
    const changed = best?.server_id !== this.instance?.server_id;
    this.instance = best && token ? { ...best, host: best.host === '0.0.0.0' ? '127.0.0.1' : best.host || '127.0.0.1' } : null;
    this.token = token;
    this.version = this.instance?.host_version || this.version;
    if (changed) {
      this.ws?.close();
      this.ws = null;
      if (this.instance) {
        log(`✓ 找到 Kimi 伺服器（${this.version || '?'}，port ${this.instance.port}），可以從中控台送訊息`);
        this.connect();
      } else {
        log('… 目前沒有執行中的 Kimi 伺服器：中控台仍看得到所有 Kimi 對話（包含終端機裡的）；從中控台操作時連接器會自動啟動一個，不需要先關閉終端機');
      }
      hub.sendStatus();
    }
    return this.instance;
  },

  // The cached instance can be stale for a few seconds after it exits.
  async healthy() {
    if (Date.now() - (this.okAt || 0) < 5000) return true;
    try {
      const ok = (await fetch(`${this.base()}/api/v1/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
      if (ok) this.okAt = Date.now();
      return ok;
    } catch {
      await this.discover();
      return Boolean(this.instance);
    }
  },

  base() {
    return `http://${this.instance.host}:${this.instance.port}`;
  },

  // Whether the server at `base` has the conversation loaded (its model is
  // only reported then; asking does not load it) and is running a turn in it.
  async holds(base, sid) {
    try {
      const token = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
      const res = await fetch(`${base}/api/v1/sessions/${sid}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
      const d = (await res.json())?.data;
      return d ? { live: Boolean(d.agent_config?.model) || Boolean(d.busy), busy: Boolean(d.busy) } : null;
    } catch {
      return null;
    }
  },

  // `internal`: a call the bridge makes itself, with a path it built (the
  // DeepSeek provider below). Never set from what the hub sends: the hub's
  // `kimi.request` always goes through ALLOW.
  async request(method, p, body, { retried = false, internal = false, taken = false } = {}) {
    // The server may have gone away (closed with the Kimi that ran /web):
    // start one in the background instead of failing.
    if (!this.instance || !(await this.healthy())) await this.start();
    await this.ready;
    if (!internal && !allowed(method, p)) throw new Error(`連接器拒絕了這個請求：${method} ${p.split('?')[0]}`);
    // A conversation a terminal Kimi also has open is driven through Kimi's
    // Server API like any other. The user has accepted the double-write risk
    // permanently; only `tui.input` still needs a controllable terminal.
    const sid = p.match(/^\/api\/v1\/sessions\/(session_[\w-]+)/)?.[1];
    if (sid && method === 'POST' && /\/prompts$/.test(p)) this.seen.set(sid, Date.now()), this.mine.set(sid, Date.now());
    if (sid && method === 'POST') await this.follow(sid);
    const res = await fetch(this.base() + p, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      // A restarted server writes a new token: read it again and retry once.
      if (j?.code === 40101 && !retried) {
        let token = this.token;
        try {
          token = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
        } catch {}
        if (token !== this.token) {
          this.token = token;
          this.ws?.close();
          this.ws = null;
          this.connect();
        }
        await new Promise((r) => setTimeout(r, 500));
        return this.request(method, p, body, { retried: true, internal, taken });
      }
      // Kimi's server holds a per-session lock. A terminal Kimi that owns it
      // makes every Server API call fail with 40931, so the connector takes
      // the lock over once (Kimi's own `:takeover` action) and retries the
      // same allowed request. The TUI is not asked to stop; the user has
      // accepted that both may write this conversation.
      if (j?.code === 40931 && !taken && sid && disk.owner(sid)?.kind === 'tui') {
        await this.request('POST', `/api/v1/sessions/${sid}:takeover`, undefined, { internal: true, taken: true, retried });
        return this.request(method, p, body, { retried, internal, taken: true });
      }
      if (method === 'POST' && p.split('?')[0] === '/api/v1/sessions' && j?.data?.id) this.mine.set(j.data.id, Date.now());
      return j;
    } catch {
      return { code: res.status === 200 ? 0 : res.status, msg: text.slice(0, 300), data: null };
    }
  },

  connect() {
    if (!this.instance) return;
    const ws = new WebSocket(`ws://${this.instance.host}:${this.instance.port}/api/v1/ws`, [`kimi-code.bearer.${this.token}`]);
    this.ws = ws;
    this.accepted = new Set(); // subscriptions this server took
    // Requests wait for this, so no event of what they start is missed.
    let ready;
    this.ready = new Promise((r) => (ready = r));
    setTimeout(ready, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'client_hello', id: 'hello', payload: { client_id: `agent-hub-bridge-${HOME_TAG}` } }));
      if (this.subs.size) ws.send(JSON.stringify({ type: 'subscribe', id: 'resub', payload: { session_ids: [...this.subs] } }));
      else ready();
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', payload: m.payload }));
      if (m.type === 'ack' && m.id === 'resub') ready();
      if (m.type === 'ack') {
        for (const id of m.payload?.accepted || []) this.accepted.add(id);
        this.acks.get(m.id)?.(m);
        this.acks.delete(m.id);
      }
      if (m.type === 'server_hello' || m.type === 'ack' || m.type === 'pong') return;
      const sid = m.session_id || m.payload?.sessionId;
      if (sid) {
        this.seen.set(sid, Date.now());
        if (m.type === 'event.session.work_changed') {
          if (m.payload?.busy) this.busy.add(sid);
          else this.busy.delete(sid);
        }
      }
      hub.send({ t: 'kimi.event', frame: m });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      setTimeout(async () => {
        this.instance = null;
        await this.discover();
      }, 2000);
    };
    ws.onerror = () => {};
  },

  subscribe(ids) {
    for (const id of ids) this.subs.add(id);
    if (this.ws?.readyState !== 1) return Promise.resolve(null);
    const id = crypto.randomUUID();
    const acked = new Promise((r) => {
      this.acks.set(id, r);
      setTimeout(() => (this.acks.delete(id), r(null)), 5000);
    });
    this.ws.send(JSON.stringify({ type: 'subscribe', id, payload: { session_ids: ids } }));
    return acked;
  },

  // A server only streams a conversation it has loaded: one it has not
  // opened yet answers a subscription with not_found, and everything Kimi
  // then does in it would never reach the hub. Load it, then subscribe,
  // before the request that makes Kimi work.
  async follow(sid) {
    if (!this.subs.has(sid) || this.accepted?.has(sid)) return;
    // Reading its status is what makes the server load a conversation.
    await fetch(`${this.base()}/api/v1/sessions/${sid}/status`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => {});
    await this.subscribe([sid]);
  },

  unsubscribe(ids) {
    for (const id of ids) this.subs.delete(id);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'unsubscribe', id: crypto.randomUUID(), payload: { session_ids: ids } }));
  },

  // One start at a time, however many requests are waiting for it.
  start() {
    this.starting ??= this.launch().finally(() => (this.starting = null));
    return this.starting;
  },

  // Kimi loads external hooks when its server process starts, so restart only
  // when no turn is running and no session is busy. The MCP broker and the
  // per-prompt disabled_tools guard remain active without that restart; the
  // hook is a second gate, never a reason to keep every conversation waiting.
  async restartForHooks() {
    const inst = this.instance;
    if (!inst?.pid) return false;
    if (disk.list().some((s) => s.busy || s.owner === 'tui') || this.busy.size) return false;
    log('重新啟動 Kimi 伺服器以載入子代理 hook（目前沒有執行中的回合）…');
    try {
      process.kill(inst.pid, 'SIGTERM');
    } catch {
      return false;
    }
    for (let i = 0; i < 25 && this.alive(inst.pid); i++) await new Promise((r) => setTimeout(r, 200));
    if (this.alive(inst.pid)) {
      try {
        process.kill(inst.pid, 'SIGKILL');
      } catch {}
      for (let i = 0; i < 25 && this.alive(inst.pid); i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (this.alive(inst.pid)) return false;
    try {
      this.ws?.close();
    } catch {}
    this.restartPort = inst.port || null;
    this.instance = null;
    this.token = null;
    try {
      await this.start();
    } catch (err) {
      log(`✗ 重啟 Kimi 失敗：${err.message}`);
      return false;
    }
    return Boolean(this.instance);
  },

  async launch() {
    if (await this.discover()) return this.instance;
    log('啟動 kimi web --no-open …');
    const args = ['web', '--no-open'];
    if (this.restartPort) args.push('--port', String(this.restartPort));
    let failed = null;
    let exited = null;
    const child = spawn(KIMI_BIN, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: IS_WIN, env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME } });
    child.on('error', (err) => (failed = err.code === 'ENOENT' ? `找不到 Kimi Code 的指令「${KIMI_BIN}」。安裝 Kimi Code，或用 --kimi-bin 指定路徑` : err.message));
    child.on('exit', (code) => (exited = code));
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.discover()) return this.instance;
      if (failed) throw new Error(`無法啟動 Kimi：${failed}`);
      if (exited !== null && i > 4) throw new Error(`kimi web 啟動後馬上結束了（代碼 ${exited}）。在這台電腦執行 kimi web 看看錯誤訊息，也確認已經 kimi login`);
    }
    throw new Error('Kimi 伺服器沒有在 20 秒內啟動');
  },
};

// ------------------------------------------------- DeepSeek in Kimi
// DeepSeek conversations are ordinary Kimi conversations whose model comes
// from one custom Kimi provider, `agent-hub-deepseek`, which the hub asks
// for here. This is the only way the hub changes Kimi's providers: ALLOW
// above still refuses every provider path, so the hub cannot create,
// replace or delete just any provider through `kimi.request`.
//
// What it must never do is touch the Kimi subscription login: no logout, no
// change to the `managed:kimi-code` provider, to [thinking], or to Kimi's
// global default model. The last one is dangerous: creating a provider SEEDS
// default_model with the new provider's model when none is set (Kimi's
// createProvider). So before creating, an empty default is pinned to the
// subscription's own model, and afterwards the default is read again and put
// back if it moved.
//
// An EMPTY [secondary_model] gets this gateway's DeepSeek V4.1 Flash alias
// with default_effort=max (no `force`, so native model/primary stay). Existing
// effort, force, other models and descriptions are preserved. If a gateway
// change breaks Hub-owned aliases, only those references are repaired: map
// the same model when possible, keep the default in the pool, never guess.
// Removing the provider removes only the section this hub created; if the
// user has since added other secondary entries, removal stops instead of
// leaving an alias that no longer resolves.
const DS_PROVIDER = 'agent-hub-deepseek';
const DS_MANAGED = 'managed:kimi-code';
const DS_FLASH = 'deepseek-v4.1-flash';
const DS_SECONDARY_EFFORT = 'max';

// Equality of a [secondary_model] across snapshots: the values that decide
// what a subagent actually runs on, not formatting or descriptions.
const secondaryKey = (s) => JSON.stringify([s?.model ?? null, [...(s?.models || [])].sort(), s?.force === true, s?.effort ?? null]);
const UNSET = Symbol('unset');
// The gateway → address table is the bridge's own: the hub names a gateway,
// never a URL, so it cannot point the key anywhere else.
// (server/deepseek-account.js has the same ids, with the models of each.)
const DS_GATEWAYS = {
  'opencode-go': 'https://opencode.ai/inference/go/openai/v1',
  opencode: 'https://opencode.ai/inference/openai/v1',
  commandcode: 'https://api.commandcode.ai/provider/v1',
};
// The header that tells a gateway which session a request belongs to. Kimi
// sends none, and OpenCode Go lists Kimi Code among the clients that get
// throttled for that: the provider gets one, the same for every request from
// this computer (Command Code's own CLI sends x-session-id).
const DS_SESSION_HEADERS = { 'opencode-go': 'x-opencode-session', opencode: 'x-opencode-session', commandcode: 'x-session-id' };
const DS_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Kimi's capability names (kosong): thinking, always_thinking, tool_use, image_in.
const DS_CAPABILITIES = ['thinking', 'always_thinking', 'tool_use', 'image_in'];
// The loopback proxy's limits. The request body is kept once so a retry sends
// the very same bytes; an upstream error body is only read to explain itself.
const DS_PROXY_MAX_BODY = 64 * 1024 * 1024;
const DS_PROXY_MAX_ERROR = 1024 * 1024;
const DS_LOCAL_TOKEN = /^ah_local_[0-9a-f]{32}$/;
const dsBad = (m) => Object.assign(new Error(m), { status: 400 });
// What a gateway's error says about THIS KEY's money or allowance (see
// proxy.quota). Codes are compared with case, spaces, "_" and "-" taken out, so
// `insufficient_quota`, `InsufficientQuota` and OpenCode's `CreditsError` are one
// spelling each.
const dsCodeKey = (c) => String(c).toLowerCase().replace(/[^a-z0-9]/g, '');
const DS_QUOTA_CODES = /^(insufficientquota|quotaexceeded|quotaexhausted|usagelimit(?:reached|exceeded)?(?:error)?|insufficientcredits?|credits?exhausted|creditserror|insufficientbalance|balanceexhausted|outofcredits?|monthlylimit(?:reached|exceeded)?(?:error)?|(?:subscription|free|user|workspace)(?:usage)?limit(?:error)?)$/;
const DS_RATE_CODES = /^(ratelimit|ratelimited|ratelimitexceeded|ratelimiterror|toomanyrequests|requests|tokens|throttled|overloaded)$/;
// Envelope types that name no cause (OpenAI's invalid_request_error, Anthropic's
// {type:'error'}, a bare HTTP status): the message decides then.
const DS_GENERIC_TYPES = /^(error|invalidrequesterror|apierror|badrequest|invalidrequest|\d{3})$/;
// The wording of an account-level statement: this key has no credit, quota,
// balance or usage allowance left.
const DS_QUOTA_PHRASE = new RegExp(
  [
    String.raw`insufficient[_\s-]*(?:quota|credits?|balance|funds)`,
    String.raw`\b(?:quota|credits?|balance)\b[\s\S]{0,12}\b(?:exceeded|exhausted|depleted|used up)\b`,
    String.raw`\bexceed(?:ed|s)? (?:your|the) (?:current )?(?:quota|usage limit|spending limit)`,
    String.raw`out of credits?`,
    String.raw`\bno (?:remaining )?credits?\b`,
    String.raw`balance (?:is )?(?:too low|insufficient|exhausted|zero)`,
    String.raw`\b(?:purchase|buy|add) (?:more )?credits\b`,
    String.raw`\b(?:usage|monthly|weekly|daily|hourly|spend(?:ing)?|5[- ]?hour|subscription)[ _-]?(?:limit|quota)\b[\s\S]{0,40}\b(?:reached|exceeded|hit)\b`,
    String.raw`\b(?:reached|hit|exceeded)\b[\s\S]{0,30}\b(?:usage|monthly|weekly|daily|hourly|spend(?:ing)?|5[- ]?hour|subscription)[ _-]?(?:limit|quota)\b`,
  ].join('|'),
  'i',
);
// "Slow down" wording: a per-second/minute limit is not an empty account.
const DS_RATE_PHRASE = /per[-\s]?(?:second|minute|min|sec)\b|too many requests|rate[-\s]?limit|retry (?:in|after) \d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?)\b/i;
// Words that make a quota phrase an echo of the refused request, not a
// statement about the account ("Your request mentioned insufficient credits").
const DS_ECHO_VERB = String.raw`(?:mention(?:s|ed|ing)?|contain(?:s|ed|ing)?|includ(?:e|es|ed|ing)|echo(?:es|ed|ing)?|quot(?:e|es|ed|ing)|refer(?:s|red|ring)?)`;
const DS_ECHO_PHRASE = new RegExp(String.raw`\b(?:request|prompt|input|message|content|text)\b[^.]{0,40}\b${DS_ECHO_VERB}\b|\b${DS_ECHO_VERB}\b[^.]{0,40}\b(?:request|prompt|input|message|content)\b`, 'i');
// Statuses a gateway uses to say a key is out: 402 and 429 by the book; 400
// (OpenCode: "You have insufficient credits to make this request") and 403 are
// also plain bad requests and plan refusals, so there the wording must be an
// account-level statement and not an echo.
const DS_QUOTA_STATUSES = new Set([400, 402, 403, 429]);
const DS_STRICT_STATUSES = new Set([400, 403]);
const DS_LABELS = { 'opencode-go': 'OpenCode Go', opencode: 'OpenCode', commandcode: 'Command Code' };
// The time zone a stated reset time must carry (Z, UTC, GMT, +08:00): without it
// the time is not read, never guessed.
const DS_ISO_RESET = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z\b|UTC\b|GMT\b|[+-]\d{2}:?\d{2}\b)/i;
const DS_SESSION_NAMES = [...new Set(Object.values(DS_SESSION_HEADERS))];


// The address of a gateway, or null. Only the fixed table (and the loopback
// fake gateway the tests use) can ever be reached.
function dsBase(gateway) {
  if (!Object.hasOwn(DS_GATEWAYS, gateway)) return null;
  const testBase = process.env.AGENT_HUB_DEEPSEEK_TEST_URL;
  if (testBase && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(testBase)) return `${testBase.replace(/\/+$/, '')}/${gateway}`;
  return DS_GATEWAYS[gateway];
}

const dsKeyOk = (key) => typeof key === 'string' && key.length > 0 && key.length <= 500 && !/\s/.test(key);

// A model name the connector may put in a request or a table (a gateway's own
// ids: letters, digits and . / : - _, no empty, "." or ".." parts).
const dsModelOk = (m) => typeof m === 'string' && /^[\w.\/:-]{1,100}$/.test(m) && !/(^|\/)\.{0,2}(\/|$)/.test(m);

// The hub's {revision, activeId, keys:[{id, apiKey, gateway?, exhaustedAt?}],
// rotation?, modelMap?}, rebuilt field by field. This is the only place a pool
// enters the connector. A key's `gateway` (a hub that rotates across gateways
// names one per key) defaults to the pool's own; `modelMap` is the hub's table
// { gateway: { the model id Kimi uses -> that gateway's id for the same model } }.
function cleanPool(raw, defaultGateway = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw dsBad('號池格式不正確');
  const revision = Number(raw.revision);
  if (!Number.isInteger(revision) || revision < 1) throw dsBad('號池的 revision 不正確');
  if (!Array.isArray(raw.keys) || raw.keys.length < 1 || raw.keys.length > 100) throw dsBad('號池要有 1 到 100 把 API key');
  const ids = new Set();
  const keys = raw.keys.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id)) throw dsBad('號池裡的 key id 不合法');
    if (ids.has(item.id)) throw dsBad(`號池裡的 key id 重複：${item.id}`);
    ids.add(item.id);
    if (!dsKeyOk(item.apiKey)) throw dsBad('號池裡的 API key 不能是空的、超過 500 字，或含有空白與換行');
    const key = { id: item.id, apiKey: item.apiKey };
    const gateway = item.gateway === undefined || item.gateway === null ? defaultGateway : item.gateway;
    if (gateway) {
      if (typeof gateway !== 'string' || !Object.hasOwn(DS_GATEWAYS, gateway)) throw dsBad(`號池裡的 key 指定了不支援的閘道：${String(gateway).slice(0, 40)}`);
      key.gateway = gateway;
    }
    if (item.exhaustedAt !== undefined && item.exhaustedAt !== null) {
      const at = Number(item.exhaustedAt);
      if (!Number.isFinite(at) || at <= 0) throw dsBad('號池裡的 exhaustedAt 不正確');
      key.exhaustedAt = at;
      // When the gateway said it comes back (optional; see proxy.resetAt).
      const retry = Number(item.retryAt);
      if (item.retryAt != null && Number.isFinite(retry) && retry > 0) key.retryAt = retry;
      // A person marked it full: it stays aside until a person clears the mark.
      if (item.manual === true) key.manual = true;
    }
    // A real request succeeded on a key that had been exhausted: when, and
    // which exhaustion that proved wrong. Reported to the hub as evidence.
    const recovered = Number(item.recoveredAt);
    if (item.recoveredAt != null && Number.isFinite(recovered) && recovered > 0 && !key.exhaustedAt) {
      key.recoveredAt = recovered;
      const from = Number(item.recoveredFrom);
      if (Number.isFinite(from) && from > 0) key.recoveredFrom = from;
    }
    return key;
  });
  let activeId = typeof raw.activeId === 'string' ? raw.activeId : '';
  if (activeId && !ids.has(activeId)) throw dsBad('號池的 activeId 不在 key 清單裡');
  if (!activeId) activeId = keys.find((k) => !k.exhaustedAt)?.id || keys[0].id;
  // How long an exhausted key whose gateway named no reset time waits before a
  // real request looks again (a gap between probes, not a guess of the reset).
  const wait = Number(raw.retryMs);
  const retryMs = Number.isFinite(wait) && wait >= 1000 && wait <= 35 * 86_400_000 ? Math.round(wait) : undefined;
  let modelMap;
  if (raw.modelMap !== undefined && raw.modelMap !== null) {
    if (typeof raw.modelMap !== 'object' || Array.isArray(raw.modelMap)) throw dsBad('號池的 modelMap 格式不正確');
    modelMap = {};
    for (const [gw, table] of Object.entries(raw.modelMap)) {
      if (!Object.hasOwn(DS_GATEWAYS, gw)) throw dsBad(`modelMap 指定了不支援的閘道：${gw.slice(0, 40)}`);
      if (!table || typeof table !== 'object' || Array.isArray(table) || Object.keys(table).length > 50) throw dsBad(`modelMap 的 ${gw} 項目格式不正確`);
      const out = Object.create(null);
      for (const [from, to] of Object.entries(table)) {
        if (!dsModelOk(from) || !dsModelOk(to)) throw dsBad(`modelMap 裡的模型名稱不合法：${from.slice(0, 40)}`);
        out[from] = to;
      }
      modelMap[gw] = out;
    }
  }
  return { revision, activeId, keys, ...(retryMs ? { retryMs } : {}), ...(raw.rotation === 1 || raw.rotation === true ? { rotation: true } : {}), ...(modelMap ? { modelMap } : {}) };
}

// ---- toml:begin
// A scanner for the STRUCTURE of Kimi's config.toml: tables, array tables and
// key/value statements with their exact line spans, so an edit changes only
// the lines it means to. It does not decode values (only plain strings and
// keys). Anything it cannot read exactly - an unterminated string, an escape
// it does not know, text after a value - throws TomlUnsupported, and the
// caller then does not touch the file.
//   header forms handled: [a.b] [ a . b ] ["a"."b/c"] ['a'] [[a]] with a
//   trailing comment; key forms: bare, "basic" and 'literal' (dotted too);
//   values: strings (also """ and ''' multi-line), numbers, booleans, dates,
//   arrays and inline tables across lines.
class TomlUnsupported extends Error {}
const tomlBad = (m) => new TomlUnsupported(m);
const TOML_BARE = /[A-Za-z0-9_-]/;

// The end (exclusive) of the quoted string starting at lines[l][c], as {l, c}.
function tomlSkipString(lines, l, c) {
  const q = lines[l][c];
  const triple = lines[l].startsWith(q.repeat(3), c);
  if (!triple) {
    let i = c + 1;
    for (; i < lines[l].length; i++) {
      if (q === '"' && lines[l][i] === '\\') i++;
      else if (lines[l][i] === q) return { l, c: i + 1 };
    }
    throw tomlBad('字串沒有結尾');
  }
  let ll = l;
  let i = c + 3;
  for (;;) {
    if (ll >= lines.length) throw tomlBad('多行字串沒有結尾');
    const text = lines[ll];
    for (; i < text.length; i++) {
      if (q === '"' && text[i] === '\\') {
        i++;
        continue;
      }
      if (text[i] === q && text.startsWith(q.repeat(3), i)) {
        let run = 3;
        while (text[i + run] === q) run++;
        if (run > 5) throw tomlBad('多行字串的結尾不正確');
        return { l: ll, c: i + run };
      }
    }
    ll++;
    i = 0;
  }
}

// The end (exclusive) of the value starting at lines[l][c].
function tomlSkipValue(lines, l, c) {
  const first = lines[l][c];
  if (first === '"' || first === "'") return tomlSkipString(lines, l, c);
  if (first === '[' || first === '{') {
    let depth = 0;
    let ll = l;
    let i = c;
    for (;;) {
      if (ll >= lines.length) throw tomlBad('陣列或 inline table 沒有結尾');
      const text = lines[ll];
      if (i >= text.length) {
        ll++;
        i = 0;
        continue;
      }
      const ch = text[i];
      if (ch === '#') {
        i = text.length;
        continue;
      }
      if (ch === '"' || ch === "'") {
        ({ l: ll, c: i } = tomlSkipString(lines, ll, i));
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return { l: ll, c: i + 1 };
        if (depth < 0) throw tomlBad('括號不成對');
      }
      i++;
    }
  }
  let i = c;
  while (i < lines[l].length && !/[\s#]/.test(lines[l][i])) i++;
  if (i === c) throw tomlBad('缺少值');
  return { l, c: i };
}

// A key path at lines[l][c]: { path: [decoded...], spans: [{start, end}], end }.
function tomlKeyPath(text, c) {
  const path = [];
  const spans = [];
  let i = c;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    const start = i;
    let key;
    if (text[i] === '"') {
      if (text.startsWith('"""', i)) throw tomlBad('鍵名不能是多行字串');
      const end = tomlSkipString([text], 0, i).c;
      try {
        key = JSON.parse(text.slice(i, end));
      } catch {
        throw tomlBad('鍵名裡有無法判讀的跳脫字元');
      }
      i = end;
    } else if (text[i] === "'") {
      if (text.startsWith("'''", i)) throw tomlBad('鍵名不能是多行字串');
      const end = tomlSkipString([text], 0, i).c;
      key = text.slice(i + 1, end - 1);
      i = end;
    } else {
      while (i < text.length && TOML_BARE.test(text[i])) i++;
      if (i === start) throw tomlBad('找不到鍵名');
      key = text.slice(start, i);
    }
    path.push(key);
    spans.push({ start, end: i });
    let j = i;
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] === '.') {
      i = j + 1;
      continue;
    }
    return { path, spans, end: i };
  }
}

const tomlRest = (text, c) => {
  let i = c;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (i < text.length && text[i] !== '#') throw tomlBad('值後面還有無法判讀的內容');
};

// text -> { eol, lines, stmts }. stmts, in file order:
//   { type: 'table'|'aot', path, start, end }               a header line
//   { type: 'kv', path, table, start, end, key: {start, end}, value: {l, c, el, ec} }
// `table` is the path of the header the key sits under ([] before any).
function tomlScan(text) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const stmts = [];
  let table = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const t = line.trimStart();
    if (!t || t[0] === '#') {
      i++;
      continue;
    }
    const indent = line.length - t.length;
    if (t[0] === '[') {
      const aot = t[1] === '[';
      const k = tomlKeyPath(line, indent + (aot ? 2 : 1));
      let j = k.end;
      while (line[j] === ' ' || line[j] === '\t') j++;
      for (const ch of aot ? ']]' : ']') {
        if (line[j] !== ch) throw tomlBad('表頭沒有正確結尾');
        j++;
      }
      tomlRest(line, j);
      stmts.push({ type: aot ? 'aot' : 'table', path: k.path, start: i, end: i });
      table = k.path;
      i++;
      continue;
    }
    const k = tomlKeyPath(line, indent);
    let j = k.end;
    while (line[j] === ' ' || line[j] === '\t') j++;
    if (line[j] !== '=') throw tomlBad('鍵後面沒有 =');
    j++;
    while (line[j] === ' ' || line[j] === '\t') j++;
    if (j >= line.length) throw tomlBad('缺少值');
    const end = tomlSkipValue(lines, i, j);
    tomlRest(lines[end.l], end.c);
    stmts.push({ type: 'kv', path: k.path, table, start: i, end: end.l, key: k.spans[0], value: { l: i, c: j, el: end.l, ec: end.c } });
    i = end.l + 1;
  }
  return { eol, lines, stmts };
}

const tomlSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The last line of the table whose header is stmts[idx]: up to the line before
// the next header.
function tomlTableEnd(doc, stmt) {
  const next = doc.stmts.find((s) => s.start > stmt.start && (s.type === 'table' || s.type === 'aot'));
  return next ? next.start - 1 : doc.lines.length - 1;
}

// A plain one-line string value ("..." or '...'): its text, else null.
function tomlString(doc, kv) {
  const { l, c, el, ec } = kv.value;
  if (l !== el) return null;
  const raw = doc.lines[l].slice(c, ec);
  if (raw.startsWith('"""') || raw.startsWith("'''")) return null;
  if (raw[0] === "'" && raw.length >= 2) return raw.slice(1, -1);
  if (raw[0] === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

// What `others()` compares for one statement's value: the decoded text of a
// plain string (so 'x' and "x" are equal, as after Kimi rewrites the file),
// else the raw value with whitespace collapsed.
function tomlValueKey(doc, kv) {
  const s = tomlString(doc, kv);
  if (s !== null) return `s:${s}`;
  const parts = [];
  for (let l = kv.value.l; l <= kv.value.el; l++) parts.push(doc.lines[l].slice(l === kv.value.l ? kv.value.c : 0, l === kv.value.el ? kv.value.ec : undefined));
  return `r:${parts.join('\n').replace(/\s+/g, ' ').trim()}`;
}

// A path inside the DeepSeek provider's own tables, or the [secondary_model]
// this hub may edit: what `tomlOthers` leaves out (exact names, not prefixes).
const tomlOurs = (full) => (full[0] === 'providers' && full[1] === DS_PROVIDER) || (full[0] === 'models' && typeof full[1] === 'string' && full[1].startsWith(`${DS_PROVIDER}/`)) || full[0] === 'secondary_model';

// config.toml as its settings, minus the DeepSeek provider's tables and
// [secondary_model]: what must come out the same after those are edited.
// Order, comments and quoting style do not matter ('x' equals "x": Kimi
// rewrites the file in its own style when it saves).
function tomlOthers(text) {
  const doc = tomlScan(text);
  const groups = new Map();
  const group = (p) => {
    const k = JSON.stringify(p);
    if (!groups.has(k)) groups.set(k, []);
    return groups.get(k);
  };
  for (const st of doc.stmts) {
    if (st.type === 'kv') {
      if (tomlOurs([...st.table, ...st.path])) continue;
      group(st.table).push(`${JSON.stringify(st.path)}=${tomlValueKey(doc, st)}`);
    } else if (!tomlOurs(st.path)) group(st.path);
  }
  return JSON.stringify([...groups].map(([k, v]) => [k, v.sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// Every line outside the [secondary_model] tables, verbatim. Two texts with
// the same value differ nowhere but in [secondary_model].
function tomlOutside(text) {
  const doc = tomlScan(text);
  const inside = new Set();
  for (const st of doc.stmts) if (st.type !== 'kv' && st.path[0] === 'secondary_model') for (let l = st.start; l <= tomlTableEnd(doc, st); l++) inside.add(l);
  return doc.lines.filter((_, i) => !inside.has(i));
}

// The text with the [secondary_model] table this hub wrote removed (just
// default_model pointing at our provider, plus default_effort), or null when
// the table is anything else - a pool, an inline table, extra keys.
function tomlStripHub(text) {
  let doc;
  try {
    doc = tomlScan(text);
  } catch {
    return null;
  }
  if (doc.stmts.some((s) => s.type === 'kv' && s.table.length === 0 && s.path[0] === 'secondary_model')) return null;
  const tables = doc.stmts.filter((s) => s.type !== 'kv' && s.path[0] === 'secondary_model');
  if (tables.length !== 1 || tables[0].type !== 'table' || tables[0].path.length !== 1) return null;
  const parent = tables[0];
  const kvs = doc.stmts.filter((s) => s.type === 'kv' && tomlSame(s.table, ['secondary_model']));
  if (kvs.some((k) => k.path.length !== 1 || (k.path[0] !== 'default_model' && k.path[0] !== 'default_effort'))) return null;
  const dm = kvs.find((k) => k.path[0] === 'default_model');
  const model = dm ? tomlString(doc, dm) : null;
  if (typeof model !== 'string' || !model.startsWith(`${DS_PROVIDER}/`)) return null;
  return [...doc.lines.slice(0, parent.start), ...doc.lines.slice(tomlTableEnd(doc, parent) + 1)].join(doc.eol);
}

// The config.toml text with the hub's alias repair applied (plan: see
// deepseek.secondaryRepairPlan), or throws why the file cannot be repaired
// safely. Edits only: a default_model value, the key of an entry in
// [secondary_model.models], the removal of an entry (or of a whole
// [secondary_model.models."alias"] table, whose description moves to a direct
// entry) and added entries. Every other line stays byte for byte; the result
// is scanned again and checked against the original before it is returned.
function tomlRepair(before, plan) {
  const doc = tomlScan(before);
  for (const st of doc.stmts) {
    const full = st.type === 'kv' ? [...st.table, ...st.path] : st.path;
    if (full[0] !== 'secondary_model') continue;
    if (st.type === 'aot') throw tomlBad('[secondary_model] 寫成 array of tables');
    if (st.type === 'kv' && st.table.length === 0) throw tomlBad('[secondary_model] 寫成 inline table 或 dotted key');
    if (st.type === 'kv' && tomlSame(st.table, ['secondary_model']) && (st.path[0] === 'models' || (st.path[0] === 'default_model' && st.path.length > 1))) throw tomlBad('[secondary_model] 裡的 models 寫成 inline table 或 dotted key');
    if (st.type === 'kv' && tomlSame(st.table, ['secondary_model', 'models']) && st.path.length > 1 && plan.mappings.has(st.path[0])) throw tomlBad('[secondary_model.models] 裡的項目寫成 dotted key');
    if (st.type === 'table' && st.path.length > 3 && st.path[1] === 'models' && plan.mappings.has(st.path[2])) throw tomlBad('要改的模型底下還有更深的表格');
  }
  const sec = doc.stmts.find((s) => s.type === 'table' && tomlSame(s.path, ['secondary_model']));
  const pool = doc.stmts.find((s) => s.type === 'table' && tomlSame(s.path, ['secondary_model', 'models']));
  const lines = doc.lines.slice();
  const drop = new Set();
  const insertBefore = new Map();
  const insertAfter = new Map();
  const put = (map, at, add) => map.set(at, [...(map.get(at) || []), ...add]);
  const valueText = (st) => {
    const { l, c, el, ec } = st.value;
    const parts = [];
    for (let i = l; i <= el; i++) parts.push(doc.lines[i].slice(i === l ? c : 0, i === el ? ec : undefined));
    return parts.join('\n');
  };
  const pending = [];
  let description = '';
  let defaultWritten = false;
  let haveDefault = plan.existing.has(plan.wanted.model);
  for (const st of doc.stmts) {
    if (st.type === 'kv' && sec && tomlSame(st.table, ['secondary_model']) && tomlSame(st.path, ['default_model'])) {
      if (plan.oldDefault !== plan.wanted.model) {
        if (tomlString(doc, st) === null) throw tomlBad('default_model 不是單行字串');
        lines[st.start] = lines[st.start].slice(0, st.value.c) + JSON.stringify(plan.wanted.model) + lines[st.start].slice(st.value.ec);
      }
      defaultWritten = true;
    } else if (st.type === 'kv' && tomlSame(st.table, ['secondary_model', 'models']) && st.path.length === 1 && plan.mappings.has(st.path[0])) {
      const name = st.path[0];
      const next = plan.mappings.get(name);
      if (name === plan.oldDefault) description = valueText(st);
      if (next && plan.owners.get(next) === name) {
        lines[st.start] = lines[st.start].slice(0, st.key.start) + JSON.stringify(next) + lines[st.start].slice(st.key.end);
        if (next === plan.wanted.model) haveDefault = true;
      } else for (let l = st.start; l <= st.end; l++) drop.add(l);
    } else if (st.type === 'table' && st.path.length === 3 && st.path[0] === 'secondary_model' && st.path[1] === 'models' && plan.mappings.has(st.path[2])) {
      const name = st.path[2];
      const next = plan.mappings.get(name);
      const own = doc.stmts.find((d) => d.type === 'kv' && tomlSame(d.table, st.path) && tomlSame(d.path, ['description']));
      const desc = own ? valueText(own) : '';
      if (name === plan.oldDefault) description = desc;
      if (next && plan.owners.get(next) === name) {
        pending.push(`${JSON.stringify(next)} = ${desc || JSON.stringify('DeepSeek V4.1 Flash')}`);
        if (next === plan.wanted.model) haveDefault = true;
      }
      for (let l = st.start; l <= tomlTableEnd(doc, st); l++) drop.add(l);
    }
  }
  const lastLine = (t) => {
    let at = t.start;
    for (let l = tomlTableEnd(doc, t); l > t.start; l--) {
      if (!drop.has(l) && lines[l].trim() !== '') {
        at = l;
        break;
      }
    }
    return at;
  };
  if (!defaultWritten && plan.oldDefault !== plan.wanted.model) {
    if (!sec) throw tomlBad('找不到 [secondary_model] 表格');
    put(insertAfter, sec.start, [`default_model = ${JSON.stringify(plan.wanted.model)}`]);
  }
  const entries = [...pending];
  if (plan.wanted.models.length && !haveDefault) entries.push(`${JSON.stringify(plan.wanted.model)} = ${description || JSON.stringify('DeepSeek V4.1 Flash')}`);
  if (entries.length) {
    if (pool) put(insertAfter, lastLine(pool), entries);
    else {
      if (!sec) throw tomlBad('找不到 [secondary_model] 表格');
      const nested = doc.stmts.find((s) => s.type === 'table' && s.path[0] === 'secondary_model' && s.path[1] === 'models');
      if (nested) put(insertBefore, nested.start, ['[secondary_model.models]', ...entries, '']);
      else put(insertAfter, lastLine(sec), ['', '[secondary_model.models]', ...entries]);
    }
  }
  const out = [];
  lines.forEach((line, i) => {
    out.push(...(insertBefore.get(i) || []));
    if (!drop.has(i)) out.push(line);
    out.push(...(insertAfter.get(i) || []));
  });
  const after = out.join(doc.eol);
  if (after === before) throw tomlBad('沒有可套用的修復');
  // Proof, before anything is written: the result reads back, nothing but
  // [secondary_model] differs in its lines, and no other setting changed.
  try {
    if (JSON.stringify(tomlOutside(after)) !== JSON.stringify(tomlOutside(before)) || tomlOthers(after) !== tomlOthers(before)) throw tomlBad('修復結果會改到 [secondary_model] 以外的內容');
  } catch (err) {
    throw err instanceof TomlUnsupported ? err : tomlBad(`修復結果無法再讀回：${err.message}`);
  }
  return after;
}
// ---- toml:end

const deepseek = {
  // Everything the hub sent, checked and rebuilt field by field. Nothing
  // else is passed on to Kimi.
  clean({ gateway, apiKey, models, pool } = {}) {
    const bad = dsBad;
    // Loopback-only fake gateway for the real bridge's e2e tests, matching the
    // hub's rule. Production gateway addresses remain fixed and uneditable.
    const base = dsBase(gateway);
    if (!base) throw bad(`不支援的閘道：${String(gateway).slice(0, 40)}`);
    if (pool === undefined || pool === null) {
      if (!dsKeyOk(apiKey)) throw bad('API key 不能是空的、超過 500 字，或含有空白與換行');
    }
    if (!Array.isArray(models) || models.length < 1 || models.length > 20) throw bad('模型清單要有 1 到 20 個模型');
    const seen = new Set();
    const out = models.map((m) => {
      const model = m?.model;
      // Letters, digits and . / : - _ (a gateway's own ids): no empty, "." or ".." parts.
      if (!dsModelOk(model)) throw bad(`模型名稱不合法：${String(model).slice(0, 40)}`);
      if (seen.has(model)) throw bad(`模型重複：${model}`);
      seen.add(model);
      const size = (v, what, min, max) => {
        if (!Number.isInteger(v) || v < min || v > max) throw bad(`${model} 的 ${what} 不合理：${String(v).slice(0, 20)}`);
        return v;
      };
      const entry = { model, max_context_size: size(m.max_context_size, 'max_context_size', 1_000, 10_000_000) };
      if (m.max_output_size !== undefined) entry.max_output_size = size(m.max_output_size, 'max_output_size', 1, 10_000_000);
      if (m.display_name !== undefined) {
        if (typeof m.display_name !== 'string' || !/^[^\x00-\x1f\x7f]{1,100}$/.test(m.display_name)) throw bad(`${model} 的顯示名稱不合法`);
        entry.display_name = m.display_name;
      }
      for (const [field, allowed] of [['capabilities', DS_CAPABILITIES], ['support_efforts', DS_EFFORTS]]) {
        if (m[field] === undefined) continue;
        if (!Array.isArray(m[field]) || m[field].length > 10 || m[field].some((x) => !allowed.includes(x))) throw bad(`${model} 的 ${field} 不在允許的清單裡`);
        entry[field] = [...new Set(m[field])];
      }
      return entry;
    });
    return { base, key: pool === undefined || pool === null ? apiKey : null, models: out, pool: pool === undefined || pool === null ? null : cleanPool(pool, gateway) };
  },

  // One call to Kimi's server (the bridge's own paths: not through ALLOW).
  // `secret` never appears in an error.
  async call(method, p, body, secret) {
    const j = await server.request(method, p, body, { internal: true });
    if (j?.code === 0 || j?.code === 204) return j.data;
    let msg = String(j?.msg || '');
    if (secret) msg = msg.split(secret).join('***');
    throw new Error(`Kimi 回報錯誤 ${j?.code ?? ''}：${msg.slice(0, 300)}`);
  },

  async config() {
    return (await this.call('GET', '/api/v1/config')) || {};
  },

  async snapshot() {
    const cfg = await this.config();
    const providers = (await this.call('GET', '/api/v1/providers'))?.items || [];
    const models = ((await this.call('GET', '/api/v1/models').catch(() => null))?.items || []).map((m) => m.model);
    const secondary = this.secondary(cfg);
    // Providers other than our own must not move, not even to add a header.
    // `default_model` is left out: GET /providers derives it from the global
    // default for a provider without its own, and that pointer is checked
    // separately (and pinned when it was empty).
    const others = providers
      .filter((p) => p.id !== DS_PROVIDER)
      .map((p) => ({ id: p.id, type: p.type ?? null, base_url: p.base_url ?? null, has_api_key: p.has_api_key ?? null, models: [...(p.models || [])].sort() }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return {
      defaultModel: typeof cfg.default_model === 'string' ? cfg.default_model.trim() : '',
      // The settings that must come out the same as they went in (apart from
      // the default model, which is put back if it moved). [secondary_model]
      // is compared on its own: the hub may make exactly one approved change.
      fixed: JSON.stringify([cfg.default_provider ?? null, cfg.thinking ?? null]),
      providerState: JSON.stringify(others),
      secondary,
      secondaryPresent: this.secondaryPresent(cfg),
      secondaryKey: secondaryKey(secondary),
      providers,
      models,
    };
  },

  // [secondary_model]: the model Kimi may run subagents on (the pool in
  // resolveSubagentModelPool), if the computer's Kimi has one set. `effort` is
  // Kimi's default_effort; absent when the user has not set one.
  secondary(cfg) {
    const s = cfg?.secondary_model;
    if (!s || typeof s !== 'object') return undefined;
    const pick = (camel, snake) => s[camel] ?? s[snake];
    const pool = pick('models', 'models');
    const models = Object.keys(pool && typeof pool === 'object' ? pool : {});
    const model = pick('defaultModel', 'default_model') ?? pick('model', 'model') ?? models[0];
    if (!model) return undefined;
    const effort = pick('defaultEffort', 'default_effort');
    return { model: String(model), models, force: pick('force', 'force') === true, ...(typeof effort === 'string' && effort ? { effort } : {}) };
  },

  // Whether the user has a [secondary_model] of any kind - even one with only a
  // default_effort. Then the table is theirs: the hub reports it and fills in
  // nothing (spec 2.4). Only a table that does not exist is "empty".
  secondaryPresent(cfg) {
    const s = cfg?.secondary_model;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    return Object.entries(s).some(([k, v]) => (k === 'force' ? v === true : v && typeof v === 'object' ? Object.keys(v).length > 0 : v != null && v !== ''));
  },

  // The subscription's own model, as the alias Kimi lists it under.
  subscriptionModel(snap) {
    const managed = snap.providers.find((p) => p.id === DS_MANAGED);
    if (!managed) return null;
    const d = managed.default_model;
    const candidates = [d, d && `${DS_MANAGED}/${d}`, ...(managed.models || [])].filter(Boolean);
    return candidates.find((a) => snap.models.includes(a)) || null;
  },

  async pin(alias) {
    await this.call('POST', `/api/v1/models/${encodeURIComponent(alias)}:set_default`, {});
  },

  // This gateway's V4.1 Flash, as the alias Kimi will list for the provider
  // (`deepseek-v4.1-flash`, or Command Code's `deepseek/deepseek-v4.1-flash`).
  flashAlias(models) {
    const flash = (models || []).find((m) => String(m?.model).split('/').pop() === DS_FLASH);
    return flash ? `${DS_PROVIDER}/${flash.model}` : null;
  },

  // The one change the hub is allowed to make to [secondary_model]. No
  // `force`: subagents still accept `model` and `primary`.
  async setSecondary(alias) {
    await this.call('POST', '/api/v1/config', { secondary_model: { default_model: alias, default_effort: DS_SECONDARY_EFFORT } });
  },

  secondaryRepairPlan(s, aliases, flash) {
    if (!s) return null;
    const prefix = `${DS_PROVIDER}/`;
    const refs = [s.model, ...(s.models || [])].filter((m) => String(m).startsWith(prefix));
    if (!refs.length) return null;
    const mappings = new Map();
    for (const old of new Set(refs.filter((m) => !aliases.includes(m)))) {
      const tail = old.split('/').pop();
      const candidates = aliases.filter((m) => m.split('/').pop() === tail);
      if (candidates.length > 1) throw new Error(`子代理模型 ${old} 在目前閘道有超過一個對應，已停止而不猜測`);
      mappings.set(old, candidates[0] || null);
    }
    let model = s.model;
    if (model.startsWith(prefix) && mappings.has(model)) {
      model = mappings.get(model);
      if (!model && this.oursSecondary(s)) model = flash;
      if (!model) throw new Error(`目前閘道沒有子代理模型 ${s.model}，為了保留既有 [secondary_model] 設定，已停止而不改用其他模型`);
    }
    const existing = new Set((s.models || []).filter((m) => !mappings.has(m)));
    const owners = new Map();
    for (const [old, next] of mappings) if (next && !existing.has(next) && !owners.has(next)) owners.set(next, old);
    if (mappings.get(s.model) && !existing.has(mappings.get(s.model))) owners.set(mappings.get(s.model), s.model);
    const models = [];
    for (const old of s.models || []) {
      const next = mappings.has(old) ? mappings.get(old) : old;
      if (next && (!mappings.has(old) || owners.get(next) === old) && !models.includes(next)) models.push(next);
    }
    if ((s.models || []).length && !models.includes(model)) models.push(model);
    if (model === s.model && models.length === (s.models || []).length && models.every((m, i) => m === s.models[i])) return null;
    return { oldDefault: s.model, wanted: { ...s, model, models }, mappings, owners, existing };
  },

  async repairSecondary(plan) {
    const file = path.join(KIMI_HOME, 'config.toml');
    const before = fs.readFileSync(file, 'utf8');
    let after;
    try {
      after = tomlRepair(before, plan);
    } catch (err) {
      if (!(err instanceof TomlUnsupported)) throw err;
      throw new Error(`這台電腦 Kimi 的 config.toml 裡 [secondary_model] 的寫法無法安全修復（${err.message}），沒有改動這個檔案`);
    }
    const backup = path.join(STATE_DIR, 'config.toml.before-secondary-repair');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileDurable(backup, before, 0o600);
    const restore = () => writeFileAtomic(file, before, { mode: 0o600 });
    try {
      // Kimi (or the user) may have saved the file since it was read: then
      // this repair describes a file that is gone, and is not written.
      if (fs.readFileSync(file, 'utf8') !== before) throw new Error('config.toml 在修復前被改動了，已放棄這次修復');
      writeFileAtomic(file, after, { mode: 0o600 });
      const reloaded = await this.waitSecondary((next) => secondaryKey(next) === secondaryKey(plan.wanted));
      if (reloaded === undefined) throw new Error('Kimi 沒有在 4 秒內重新載入修復後的 secondary_model');
      if (this.others(fs.readFileSync(file, 'utf8')) !== this.others(before)) throw new Error('修復後 config.toml 出現預期以外的變動');
      fs.rmSync(backup, { force: true });
      return reloaded;
    } catch (err) {
      try {
        if (fs.readFileSync(file, 'utf8') !== before) restore();
        fs.rmSync(backup, { force: true });
      } catch {}
      throw err;
    }
  },

  // Poll GET /config until `ok(secondary)` holds: Kimi reloads config.toml
  // through its own watcher. undefined when it did not happen in time.
  async waitSecondary(ok, ms = 4000) {
    const until = Date.now() + ms;
    for (;;) {
      try {
        const s = this.secondary(await this.config());
        if (ok(s)) return s || null;
      } catch {}
      if (Date.now() >= until) return undefined;
      await new Promise((r) => setTimeout(r, 150));
    }
  },

  // After any write: the default model, the other global settings and every
  // other provider are as they were. `allowedSecondary` is the one secondary
  // value this call may have introduced (null: this call removed it).
  async check(before, expected, allowedSecondary = UNSET) {
    const now = await this.snapshot();
    if (now.defaultModel !== expected) {
      let restored = false;
      if (expected) {
        await this.pin(expected).catch(() => {});
        restored = (await this.snapshot()).defaultModel === expected;
      }
      throw new Error(`Kimi 的全域預設模型被改動了（${expected || '（沒有設定）'} → ${now.defaultModel || '（沒有設定）'}）。${restored ? '已還原成原來的模型' : '沒辦法還原，請在這台電腦的 Kimi 用 /model 選回你的模型'}。DeepSeek 設定已中止。`);
    }
    if (now.fixed !== before.fixed) throw new Error('Kimi 的 default_provider 或 [thinking] 在設定 DeepSeek 時被改動了，已中止。請檢查這台電腦的 Kimi 設定。');
    if (now.providerState !== before.providerState) throw new Error('Kimi 的其他模型來源在設定 DeepSeek 時被改動了，已中止。請檢查這台電腦的 Kimi 設定。');
    const allowed = allowedSecondary !== UNSET && now.secondaryKey === secondaryKey(allowedSecondary);
    if (now.secondaryKey !== before.secondaryKey && !allowed) throw new Error('Kimi 的 [secondary_model] 在設定 DeepSeek 時被改動了，已中止。請檢查這台電腦的 Kimi 設定。');
    return now;
  },

  // Whether a [secondary_model] points at the provider this hub owns.
  secondaryDs(s) {
    if (!s) return false;
    const prefix = `${DS_PROVIDER}/`;
    return String(s.model || '').startsWith(prefix) || (s.models || []).some((m) => String(m).startsWith(prefix));
  },

  // A DeepSeek default at max without force follows the gateway when its old
  // alias stops resolving. Other pool entries and their descriptions stay put.
  oursSecondary(s) {
    return Boolean(s) && !s.force && s.effort === DS_SECONDARY_EFFORT && String(s.model).startsWith(`${DS_PROVIDER}/`);
  },

  // config.toml's settings minus the DeepSeek provider's own tables and the
  // approved [secondary_model] (see tomlOthers): what must come out the same
  // after the header is added. [secondary_model] is checked separately, so
  // ignoring it here cannot let an unrelated change through.
  others(text) {
    return tomlOthers(text);
  },

  // Remove the [secondary_model] table this hub created, or null when the
  // table is not exactly ours (a nested pool, an inline table or any other key
  // means the user has edited it since).
  stripHubSecondary(text) {
    return tomlStripHub(text);
  },

  // Kimi's config API merges a domain, so it can set [secondary_model] but
  // cannot delete one of its keys. The table this hub wrote is removed from
  // config.toml instead (the same file Kimi watches and reloads), then the
  // removal is proven through GET /config before the provider is deleted.
  async cleanSecondary(snap) {
    const s = snap.secondary;
    if (!s || !this.secondaryDs(s)) return false;
    if (!this.oursSecondary(s)) {
      throw new Error('這台電腦的 Kimi [secondary_model] 除了 Agent Hub 建立的 DeepSeek 別名外還有其他設定，不能只移除 DeepSeek。請先在那台電腦的 Kimi 移除這個別名，再移除 DeepSeek；這次沒有留下無效引用。');
    }
    const file = path.join(KIMI_HOME, 'config.toml');
    let before;
    try {
      before = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error('找不到這台電腦 Kimi 的 config.toml，不能清掉 Agent Hub 建立的 [secondary_model]；這次沒有刪除 DeepSeek。');
    }
    const after = this.stripHubSecondary(before);
    if (after === null) {
      throw new Error('這台電腦的 Kimi [secondary_model] 不是 Agent Hub 建立的樣式，不能安全地只移除 DeepSeek 別名。請先在那台電腦的 Kimi 移除它，再移除 DeepSeek；這次沒有留下無效引用。');
    }
    if (this.others(after) !== this.others(before)) {
      throw new Error('清理 [secondary_model] 會改到 Kimi 的其他設定，已中止；這次沒有刪除 DeepSeek。');
    }
    const backup = path.join(STATE_DIR, 'config.toml.before-secondary-cleanup');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileDurable(backup, before, 0o600);
    const restore = () => writeFileAtomic(file, before, { mode: 0o600 });
    try {
      if (fs.readFileSync(file, 'utf8') !== before) throw new Error('config.toml 在清理前被改動了，已放棄；這次沒有刪除 DeepSeek。');
      writeFileAtomic(file, after, { mode: 0o600 });
      const reloaded = await this.waitSecondary((next) => !this.secondaryDs(next));
      if (reloaded === undefined) throw new Error('Kimi 沒有在 4 秒內重新載入清理後的 [secondary_model]');
      if (this.others(fs.readFileSync(file, 'utf8')) !== this.others(before)) throw new Error('清理 [secondary_model] 後 config.toml 出現了預期以外的變動');
      fs.rmSync(backup, { force: true });
      return true;
    } catch (err) {
      try {
        if (fs.readFileSync(file, 'utf8') !== before) restore();
        fs.rmSync(backup, { force: true });
      } catch {}
      throw err;
    }
  },

  // This computer's session id for the gateways, made once and kept.
  sessionId() {
    if (!/^ses_agenthub_[0-9a-f]{16}$/.test(STATE.dsSession || '')) {
      STATE.dsSession = `ses_agenthub_${crypto.randomBytes(8).toString('hex')}`;
      saveState(STATE);
    }
    return STATE.dsSession;
  },

  // Put the session header on the provider (custom_headers in its table in
  // config.toml). Kimi writes it itself, through its own config API (a merge
  // into [providers] that leaves the other providers alone, serialized with
  // Kimi's own writes, and picked up at once: no restart, and no hand edit
  // of the file). Then config.toml is read again: the DeepSeek provider's
  // tables are the only thing that may differ; if anything else does, the
  // file is put back as it was. Returns null, or why it could not be done.
  async sessionHeader(gateway) {
    const name = DS_SESSION_HEADERS[gateway];
    const file = path.join(KIMI_HOME, 'config.toml');
    let before;
    try {
      before = fs.readFileSync(file, 'utf8');
    } catch {
      return '找不到這台電腦 Kimi 的 config.toml，沒辦法加上 session 標頭';
    }
    const backup = path.join(STATE_DIR, 'config.toml.before-deepseek');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileDurable(backup, before, 0o600);
    const value = this.sessionId();
    const restore = () => writeFileAtomic(file, before, { mode: 0o600 });
    try {
      await this.call('POST', '/api/v1/config', { providers: { [DS_PROVIDER]: { custom_headers: { [name]: value } } } });
      // Kimi writes the file just before it answers.
      const after = fs.readFileSync(file, 'utf8');
      const has = new RegExp(`\\[providers\\.agent-hub-deepseek\\.custom_headers\\][^\\[]*${name}\\s*=\\s*"${value}"|custom_headers\\s*=\\s*\\{[^}]*${name}\\s*=\\s*"${value}"`).test(after);
      if (this.others(after) !== this.others(before) || !has) {
        restore();
        return 'Kimi 的 config.toml 在加上 session 標頭時出現了預期以外的變動，已還原';
      }
      fs.rmSync(backup, { force: true });
      return null;
    } catch (err) {
      // Whatever went wrong, config.toml is as it was.
      try {
        if (fs.readFileSync(file, 'utf8') !== before) restore();
        fs.rmSync(backup, { force: true });
      } catch {}
      return `加不上 session 標頭：${err.message}`;
    }
  },

  async provision(args) {
    const { base, key, models, pool } = this.clean(args);
    // A pool goes through the loopback proxy; Kimi only ever gets its local
    // token. The direct form stays for connectors/hubs that predate the pool.
    if (pool && proxy.route?.gateway === args.gateway && pool.revision < proxy.route.pool.revision) {
      throw Object.assign(new Error(`號池 revision ${pool.revision} 比目前的 ${proxy.route.pool.revision} 舊，已忽略`), { status: 409, code: 'stale_pool' });
    }
    if (pool) await proxy.start();
    const providerKey = pool ? proxy.token : key;
    const providerBase = pool ? proxy.localBase(args.gateway) : base;
    const before = await this.snapshot();
    const had = before.providers.some((p) => p.id === DS_PROVIDER);
    const aliases = models.map((m) => `${DS_PROVIDER}/${m.model}`);
    const alias = this.flashAlias(models);
    const repair = this.secondaryRepairPlan(before.secondary, aliases, alias);
    if (repair) {
      try {
        fs.accessSync(path.join(KIMI_HOME, 'config.toml'), fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        throw new Error('這台電腦的 secondary 有失效的 DeepSeek 模型，但 config.toml 無法安全修復；provider 尚未改動');
      }
    }
    let expected = before.defaultModel;
    // Creating a provider would make it Kimi's default when there is none:
    // pin the subscription's model first, or do not create at all.
    if (!had && !expected) {
      expected = this.subscriptionModel(before);
      if (!expected) throw new Error('這台電腦的 Kimi 沒有設定預設模型，也找不到訂閱帳號的模型。為了不讓 DeepSeek 變成 Kimi 的預設模型，沒有建立。請先在那台電腦執行 kimi login。');
      await this.pin(expected);
    }
    // Never `default_model` in the body: that is Kimi's own pointer.
    const body = { type: 'openai', api_key: providerKey, base_url: providerBase, models };
    let failure = null;
    try {
      if (had) await this.call('PUT', `/api/v1/providers/${DS_PROVIDER}`, body, providerKey);
      else await this.call('POST', '/api/v1/providers', { id: DS_PROVIDER, ...body }, providerKey);
    } catch (err) {
      failure = err;
    }
    // The provider already points at the proxy, so the pool is live as soon
    // as the write succeeded; a later check failure must not leave it unset.
    if (!failure) {
      if (pool) proxy.commit({ gateway: args.gateway, base, pool }, models);
      else proxy.clear();
    }
    const after = await this.check(before, expected);
    if (failure) throw failure;
    // The session header, which a gateway may want (see DS_SESSION_HEADERS).
    // Without it the provider still works; the hub is told it is missing.
    const noHeader = await this.sessionHeader(args.gateway);
    const afterHeader = await this.check(after, expected);
    // An empty secondary gets Flash at max. Existing settings keep their
    // effort, force and descriptions; only aliases that no longer resolve are
    // remapped or removed, with the default kept in the pool when one exists.
    // The provider above is already live: whatever goes wrong from here on is
    // a warning about the native subagent default, not a failure to provide
    // the DeepSeek model (the main conversation must not wait on it).
    let secondary = afterHeader.secondary;
    let secondarySet = false;
    let secondaryWarning = '';
    try {
      if (afterHeader.secondaryPresent && !secondary) {
        // A [secondary_model] with no model (say only default_effort): theirs.
        secondaryWarning = '這台電腦的 Kimi 已經有 [secondary_model]，但沒有設 default_model（例如只設了 default_effort）。為了不覆蓋你的設定，Agent Hub 沒有替你補；原生子代理會沿用主模型，要用 DeepSeek 請自己在 [secondary_model] 設 default_model。';
      } else if (!secondary) {
        if (!alias) throw new Error(`模型清單裡沒有 ${DS_FLASH}，沒辦法設定預設子代理模型；DeepSeek 模型來源已設定，但這台電腦的 [secondary_model] 沒有改動。`);
        const wanted = { model: alias, models: [], force: false, effort: DS_SECONDARY_EFFORT };
        await this.setSecondary(alias);
        secondary = (await this.check(afterHeader, expected, wanted)).secondary;
        secondarySet = true;
      } else if (repair) {
        secondary = await this.repairSecondary(repair);
        secondary = (await this.check(afterHeader, expected, repair.wanted)).secondary;
        secondarySet = true;
      }
    } catch (err) {
      secondaryWarning = String(err?.message || err).slice(0, 400);
      secondary = (await this.snapshot().catch(() => null))?.secondary ?? afterHeader.secondary;
    }
    return {
      ok: true,
      created: !had,
      models: models.map((m) => `${DS_PROVIDER}/${m.model}`),
      sessionHeader: !noHeader,
      ...(noHeader ? { warning: noHeader } : {}),
      ...(pool ? { pool: { revision: pool.revision, activeId: proxy.route?.pool.activeId || null } } : {}),
      ...(secondary ? { secondaryModel: secondary } : {}),
      ...(secondarySet && !secondaryWarning ? { secondaryChanged: true } : {}),
      ...(secondaryWarning ? { secondaryWarning } : {}),
    };
  },

  async remove() {
    const before = await this.snapshot();
    const present = before.providers.some((p) => p.id === DS_PROVIDER);
    if (!present) {
      const cleaned = await this.cleanSecondary(before);
      proxy.clear();
      return { ok: true, removed: false, ...(cleaned ? { secondaryRemoved: true } : {}) };
    }
    // Deleting would leave Kimi's default pointing at a model that is gone.
    if (before.defaultModel.startsWith(`${DS_PROVIDER}/`)) throw new Error('Kimi 的全域預設模型是 DeepSeek 模型：先在那台電腦的 Kimi 用 /model 換回你的模型，再移除。');
    // Before the provider is gone: remove only the [secondary_model] table
    // this hub wrote, and prove through Kimi's own API that it reloaded.
    // If it is not exactly ours, stop instead of leaving a dangling alias.
    const cleaned = await this.cleanSecondary(before);
    await this.call('DELETE', `/api/v1/providers/${DS_PROVIDER}`);
    try {
      // `cleaned` allows exactly one secondary change: the removed table.
      await this.check(before, before.defaultModel, cleaned ? null : undefined);
    } finally {
      // The provider is gone: no pool secret or local proxy token stays.
      proxy.clear();
    }
    return { ok: true, removed: true, ...(cleaned ? { secondaryRemoved: true } : {}) };
  },
};

// ------------------------------------------------ DeepSeek key pool proxy
// The connector's loopback-only OpenAI-compatible endpoint. Kimi's provider
// points at http://127.0.0.1:<random>/<gateway> with a random local token, so
// Kimi's config never holds an upstream key. The proxy starts each request on
// the pool's active key and moves to the next only when the gateway clearly
// says that key's quota/credit/balance is exhausted and nothing has been sent
// downstream yet. The request body is buffered once (64 MiB at most) so every
// attempt sends exactly the same model, effort and prompt.
const proxy = {
  server: null,
  port: 0,
  token: '',
  route: null, // { gateway, base, pool } — the pool currently provisioned
  models: [],
  starting: null,
  lastReport: '',

  localBase(gateway) {
    return `http://127.0.0.1:${this.port}/${gateway}`;
  },

  async start(saved = STATE.deepseekPool) {
    if (this.server) return this;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const listen = (port) =>
        new Promise((resolve, reject) => {
          const srv = http.createServer((req, res) => {
            this.handle(req, res);
          });
          srv.on('clientError', (err, sock) => {
            try {
              sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            } catch {}
          });
          srv.once('error', reject);
          srv.listen(port, '127.0.0.1', () => {
            srv.removeListener('error', reject);
            srv.on('error', () => {});
            resolve(srv);
          });
        });
      let token = saved && DS_LOCAL_TOKEN.test(String(saved.token || '')) ? saved.token : `ah_local_${crypto.randomBytes(16).toString('hex')}`;
      let srv = null;
      // Keep the port and token across a bridge restart when possible: the
      // provider already in Kimi's config then keeps working.
      if (saved?.port) {
        try {
          srv = await listen(saved.port);
        } catch {}
      }
      if (!srv) {
        if (saved?.port) token = `ah_local_${crypto.randomBytes(16).toString('hex')}`;
        srv = await listen(0);
      }
      this.server = srv;
      this.port = srv.address().port;
      this.token = token;
      srv.on('close', () => {
        if (this.server === srv) {
          this.server = null;
          this.port = 0;
        }
      });
      return this;
    })().finally(() => (this.starting = null));
    return this.starting;
  },

  // After a bridge restart: the persisted pool is live again. Kimi's provider
  // still points here when the same port came back; otherwise the hub's next
  // provision rewrites it.
  async resume() {
    const saved = STATE.deepseekPool;
    if (!saved || typeof saved !== 'object') return;
    const base = dsBase(saved.gateway);
    if (!base) return this.clear();
    let pool;
    try {
      pool = cleanPool({ revision: saved.revision, activeId: saved.activeId, keys: saved.keys, retryMs: saved.retryMs, rotation: saved.rotation, modelMap: saved.modelMap }, saved.gateway);
    } catch {
      return this.clear();
    }
    await this.start(saved);
    this.route = { gateway: saved.gateway, base, pool };
    this.models = Array.isArray(saved.models) ? saved.models : [];
    this.save();
  },

  commit(route, models) {
    this.route = route;
    this.models = models;
    this.save();
    this.report(true);
  },

  clear() {
    this.route = null;
    this.models = [];
    this.lastReport = '';
    if (this.server) {
      const srv = this.server;
      this.server = null;
      this.port = 0;
      this.token = '';
      try {
        srv.close();
      } catch {}
    }
    if (STATE.deepseekPool) {
      delete STATE.deepseekPool;
      saveState(STATE);
    }
  },

  save() {
    const route = this.route;
    if (!route) return;
    STATE.deepseekPool = {
      port: this.port,
      token: this.token,
      gateway: route.gateway,
      revision: route.pool.revision,
      activeId: route.pool.activeId,
      models: this.models,
      ...(route.pool.retryMs ? { retryMs: route.pool.retryMs } : {}),
      ...(route.pool.rotation ? { rotation: 1 } : {}),
      ...(route.pool.modelMap ? { modelMap: route.pool.modelMap } : {}),
      keys: route.pool.keys.map((k) => ({
        id: k.id,
        apiKey: k.apiKey,
        ...(k.gateway ? { gateway: k.gateway } : {}),
        ...(k.exhaustedAt ? { exhaustedAt: k.exhaustedAt, ...(k.retryAt ? { retryAt: k.retryAt } : {}), ...(k.manual ? { manual: true } : {}) } : {}),
        ...(k.recoveredAt ? { recoveredAt: k.recoveredAt, ...(k.recoveredFrom ? { recoveredFrom: k.recoveredFrom } : {}) } : {}),
      })),
    };
    saveState(STATE);
  },

  // What the hub is told: ids and health only, never a key or the local token.
  report(force = false) {
    const route = this.route;
    if (!route) return;
    const active = route.pool.keys.find((k) => k.id === route.pool.activeId) || null;
    const msg = {
      t: 'deepseek.pool',
      // A pool that rotates across gateways says which gateway the key in use is
      // on (and that it is one); the old shape says the pool's own.
      gateway: route.pool.rotation ? active?.gateway || route.gateway : route.gateway,
      ...(route.pool.rotation ? { rotation: 1 } : {}),
      activeId: active ? active.id : null,
      revision: route.pool.revision,
      // Health is only ever said when there is something to say: a key with
      // no field is "this connector has no news", not "healthy" (the hub
      // never clears an exhaustion from silence). Evidence of recovery is a
      // successful real request after the exhaustion it names.
      keys: route.pool.keys.map((k) =>
        k.exhaustedAt
          ? { id: k.id, exhaustedAt: k.exhaustedAt, ...(k.retryAt ? { retryAt: k.retryAt } : {}) }
          : k.recoveredAt
            ? { id: k.id, recoveredAt: k.recoveredAt, ...(k.recoveredFrom ? { recoveredFrom: k.recoveredFrom } : {}) }
            : { id: k.id },
      ),
    };
    const json = JSON.stringify(msg);
    if (!force && json === this.lastReport) return;
    this.lastReport = json;
    hub.send(msg);
  },

  authorized(req) {
    const given = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim())?.[1] || '';
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return Boolean(this.token) && a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  json(res, status, code, message, extra = {}) {
    if (res.destroyed) return;
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    const body = Buffer.from(JSON.stringify({ error: { code, type: code, message, ...extra } }));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
    res.end(body);
  },

  async readBody(req, res) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DS_PROXY_MAX_BODY) {
      req.resume();
      this.json(res, 413, 'body_too_large', `請求超過 ${DS_PROXY_MAX_BODY / 1048576} MiB，已拒絕`);
      return null;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > DS_PROXY_MAX_BODY) {
          this.json(res, 413, 'body_too_large', `請求超過 ${DS_PROXY_MAX_BODY / 1048576} MiB，已拒絕`);
          req.destroy();
          return null;
        }
        chunks.push(chunk);
      }
    } catch {
      if (!res.headersSent) this.json(res, 400, 'bad_request', '讀不到請求內容');
      return null;
    }
    return Buffer.concat(chunks, size);
  },

  async readUpTo(stream, max) {
    if (!stream) return Buffer.alloc(0);
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (size + buf.length > max) {
          chunks.push(buf.subarray(0, max - size));
          size = max;
          break;
        }
        chunks.push(buf);
        size += buf.length;
        if (size >= max) break;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
    return Buffer.concat(chunks, size);
  },

  // Only the headers a gateway needs, rebuilt: the upstream key replaces the
  // local one, and nothing about the hub or the client's cookies is passed on.
  // The session id Kimi sends (under the name of the gateway its provider was made
  // for) goes on under the name of the gateway THIS key belongs to.
  upstreamHeaders(req, key, route) {
    const out = {};
    const allow = /^(content-type|accept|user-agent|openai-[\w-]+|anthropic-[\w-]+|x-[\w-]+)$/i;
    const drop = new Set(['x-api-key', 'api-key', 'openai-api-key', 'x-goog-api-key', 'x-auth-token', 'cookie']);
    for (const [name, value] of Object.entries(req.headers)) {
      if (!allow.test(name) || drop.has(name.toLowerCase()) || /^x-agent-hub/i.test(name) || value === undefined) continue;
      out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    let session = '';
    for (const name of DS_SESSION_NAMES) {
      if (out[name] === undefined) continue;
      session ||= out[name];
      delete out[name];
    }
    const own = DS_SESSION_HEADERS[key.gateway || route.gateway];
    if (session && own) out[own] = session;
    out.authorization = `Bearer ${key.apiKey}`;
    out['accept-encoding'] = 'identity';
    return out;
  },

  // What goes to this key's gateway: its address and the request body with the
  // model's name as that gateway spells it. null: this key cannot serve this
  // request (its gateway has no counterpart of the model), which is not an
  // exhaustion and marks nothing.
  prepare(route, key, body) {
    const gateway = key.gateway || route.gateway;
    const base = gateway === route.gateway ? route.base : dsBase(gateway);
    if (!base) return null;
    if (gateway === route.gateway || !body?.length) return { base, body };
    let j;
    try {
      j = JSON.parse(body.toString('utf8'));
    } catch {
      return { base, body };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.model !== 'string') return { base, body };
    const table = route.pool.modelMap?.[gateway];
    const to = table && Object.hasOwn(table, j.model) ? table[j.model] : null;
    if (!to) return null;
    return to === j.model ? { base, body } : { base, body: Buffer.from(JSON.stringify({ ...j, model: to })) };
  },

  downHeaders(headers) {
    const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']);
    const out = {};
    headers.forEach((value, name) => {
      if (!hop.has(name.toLowerCase())) out[name] = value;
    });
    return out;
  },

  drain(res) {
    return new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
    });
  },

  // Whether an upstream error says THIS KEY's quota/credit/balance/usage
  // allowance is gone. Decided from the error's own fields and status only:
  //   - status must be 402, 429, or 400/403 (see DS_QUOTA_STATUSES). 401, 404,
  //     409, 422 and 5xx are credential, request or server problems: they reach
  //     Kimi unchanged;
  //   - an explicit quota code (insufficient_quota, quota_exceeded,
  //     usage_limit(_reached), insufficient_credits, CreditsError, MonthlyLimit
  //     Error, ...) in error.code / error.type / code / type is enough on its own;
  //   - a rate-limit code is never quota, whatever the message says, and neither
  //     is upgrade_required (a plan without API access);
  //   - otherwise the error's message field (or a short plain-text body) must
  //     carry a quota/credit/balance/usage-limit phrase and no per-second/minute
  //     rate-limit phrase; on 400 and 403 (also plain bad requests and plan
  //     refusals) it must also not read as an echo of the refused request.
  // Words elsewhere in the body (an upstream echoing the refused request) are
  // never looked at.
  quota(status, text) {
    if (!DS_QUOTA_STATUSES.has(status)) return false;
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
    const obj = j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    const err = obj && typeof obj.error === 'object' && obj.error ? obj.error : null;
    const codes = [err?.code, err?.type, obj?.code, obj?.type].filter((x) => typeof x === 'string' && x).map(dsCodeKey).filter((c) => c && !DS_GENERIC_TYPES.test(c));
    if (codes.some((c) => DS_RATE_CODES.test(c) || c === 'upgraderequired')) return false;
    if (codes.some((c) => DS_QUOTA_CODES.test(c))) return true;
    const message = obj ? [err?.message, typeof obj.error === 'string' ? obj.error : '', obj.message].find((x) => typeof x === 'string' && x) || '' : String(text || '').trim();
    const short = message.slice(0, 500);
    if (!short || DS_RATE_PHRASE.test(short) || !DS_QUOTA_PHRASE.test(short)) return false;
    return !(DS_STRICT_STATUSES.has(status) && DS_ECHO_PHRASE.test(short));
  },

  // A time a message STATES: "resets at 2026-10-21T12:25:07.170Z" (the zone must
  // be there), "resets in 2 hours 15 minutes", "Retry in 2hr 3min". With several
  // the last one that can be read wins; one that cannot be read (no zone, a clock
  // time alone, nonsense) is left out, never guessed. null: none.
  messageReset(message, now = Date.now()) {
    const hits = [];
    for (const m of message.matchAll(/\bresets?\s+(?:at|on)\s+/gi)) hits.push({ pos: m.index, absolute: true, tail: message.slice(m.index + m[0].length, m.index + m[0].length + 80).split('\n')[0] });
    for (const m of message.matchAll(/\b(?:resets?|retry|try again)\s+(?:in|after)\s+/gi)) hits.push({ pos: m.index, absolute: false, tail: message.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/[.\n]/)[0] });
    hits.sort((a, b) => b.pos - a.pos);
    for (const hit of hits) {
      let t = null;
      if (hit.absolute) {
        const iso = DS_ISO_RESET.exec(hit.tail);
        if (iso) {
          const [, y, mo, d, hh, mi, ss, frac, zone] = iso;
          const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss || 0), Number(String(frac || '0').slice(0, 3).padEnd(3, '0')));
          const z = /^[+-]/.test(zone) ? /^([+-])(\d{2}):?(\d{2})$/.exec(zone) : null;
          const offset = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60_000 : 0;
          t = Number.isFinite(ms) ? ms - offset : null;
        }
      } else {
        let secs = 0;
        for (const [, num, unit] of hit.tail.matchAll(/(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ou)?rs?|h|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
          const u = unit.toLowerCase();
          secs += Number(num) * (u.startsWith('d') ? 86400 : u.startsWith('h') ? 3600 : u.startsWith('m') ? 60 : 1);
        }
        t = secs > 0 ? now + secs * 1000 : null;
      }
      if (t != null && Number.isFinite(t) && t > now && t <= now + 35 * 86_400_000) return Math.round(t);
    }
    return null;
  },

  // When the gateway says the exhausted key comes back: a Retry-After header
  // (seconds or an HTTP date), a reset field of the error object (epoch
  // seconds/ms, ISO date, or seconds from now), or a time its message states
  // (see messageReset). null when it says nothing believable (in the past, or
  // more than 35 days away): the expiry is then unknown, and a real request
  // finds out (no time is made up).
  resetAt(headers, text, now = Date.now()) {
    const sane = (t) => (Number.isFinite(t) && t > now && t <= now + 35 * 86_400_000 ? Math.round(t) : null);
    const fromNumber = (n, unit) => (unit === 'delta-s' ? now + n * 1000 : unit === 'delta-ms' ? now + n : n > 1e11 ? n : n * 1000);
    const retry = headers?.get?.('retry-after');
    if (retry) {
      const secs = Number(retry);
      const t = Number.isFinite(secs) ? now + secs * 1000 : Date.parse(retry);
      const ok = sane(t);
      if (ok) return ok;
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
    const obj = j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    const err = obj && typeof obj.error === 'object' && obj.error ? obj.error : {};
    for (const src of [err, obj || {}]) {
      for (const [field, unit] of [['resets_at', 'abs'], ['reset_at', 'abs'], ['resetsAt', 'abs'], ['resets_in_seconds', 'delta-s'], ['retry_after', 'delta-s'], ['retry_after_seconds', 'delta-s'], ['retry_after_ms', 'delta-ms']]) {
        const v = src[field];
        if (v == null) continue;
        const t = typeof v === 'number' ? fromNumber(v, unit) : Number.isFinite(Number(v)) ? fromNumber(Number(v), unit) : Date.parse(String(v));
        const ok = sane(t);
        if (ok) return ok;
      }
    }
    const message = obj ? [err.message, typeof obj.error === 'string' ? obj.error : '', obj.message].find((x) => typeof x === 'string' && x) || '' : String(text || '');
    return this.messageReset(message.slice(0, 2000), now);
  },

  // The order this request tries keys in: the active one first, then the rest
  // of the pool in list order, wrapping once. A key this request already tried
  // is never used twice, and a request never jumps to the key another request
  // may be about to try.
  order(pool) {
    const n = pool.keys.length;
    let start = pool.keys.findIndex((k) => k.id === pool.activeId);
    if (start < 0) start = 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push(pool.keys[(start + i) % n]);
    return out;
  },

  nextUsable(pool, id) {
    const n = pool.keys.length;
    let i = pool.keys.findIndex((k) => k.id === id);
    if (i < 0) i = 0;
    for (let j = 1; j <= n; j++) {
      const key = pool.keys[(i + j) % n];
      if (!key.exhaustedAt) return key;
    }
    return null;
  },

  // The gap between real requests that look again at an exhausted key whose
  // gateway named no reset time: the hub's `retryMs` for this pool, else
  // AGENT_HUB_DEEPSEEK_RETRY_MS, else 30 seconds. It is how often a probe may
  // happen, not a guess of when the key comes back (that is only ever a time
  // the gateway stated): the next real request after the gap finds out.
  retryMs(route) {
    return route.pool.retryMs || this.ms('AGENT_HUB_DEEPSEEK_RETRY_MS', 30_000);
  },

  // When this exhausted key may be looked at again: the time its gateway
  // stated, else after the gap since it was marked; never, for a key a person
  // marked full (only a person clears that).
  retryAt(route, key) {
    if (!key.exhaustedAt) return 0;
    if (key.manual) return Infinity;
    return key.retryAt || key.exhaustedAt + this.retryMs(route);
  },

  // An exhausted key whose time has come. The next real request that finds
  // no healthy key tries it: that request is the probe, so recovery costs no
  // extra traffic and proves the key works before it is trusted again.
  due(route, key, now = Date.now()) {
    return Boolean(key.exhaustedAt) && this.retryAt(route, key) <= now;
  },

  // Mark a key exhausted (or, for a due key whose retry failed again, exhausted
  // afresh with a new wait) and move the shared active pointer only if it still
  // points at that key (compare-and-swap): concurrent failures on the same
  // key cannot make the pool skip over an untried key.
  fail(route, key, resetAt = null) {
    if (this.route !== route) return false;
    const pool = route.pool;
    const found = pool.keys.find((k) => k.id === key.id);
    if (!found) return false;
    if (!found.exhaustedAt || this.due(route, found)) {
      found.exhaustedAt = Date.now();
      if (resetAt) found.retryAt = resetAt;
      else delete found.retryAt;
      delete found.recoveredAt;
      delete found.recoveredFrom;
    }
    if (pool.activeId === found.id) pool.activeId = this.nextUsable(pool, found.id)?.id || '';
    this.save();
    this.report();
    return true;
  },

  // A successful request makes its key the pool's actual active one, unless
  // that key was meanwhile confirmed exhausted by another request. A key that
  // was exhausted when the request started (`was`) and still carries that very
  // exhaustion has just been proven healthy: the mark is cleared and the
  // proof (when, and which exhaustion) goes to the hub in the next report.
  ok(route, key, was = 0) {
    if (this.route !== route) return;
    const found = route.pool.keys.find((k) => k.id === key.id);
    if (!found) return;
    if (found.exhaustedAt) {
      if (!was || found.exhaustedAt !== was) return;
      found.recoveredAt = Date.now();
      found.recoveredFrom = was;
      delete found.exhaustedAt;
      delete found.retryAt;
      route.pool.activeId = found.id;
      this.save();
      this.report();
      return;
    }
    if (route.pool.activeId !== found.id) {
      route.pool.activeId = found.id;
      this.save();
      this.report();
    }
  },

  // How long the proxy waits on a gateway that has gone silent (milliseconds,
  // 50 ms to 1 hour; anything else falls back to the default):
  //   AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS  from sending the request to the first
  //                                     byte of the answer body (default 120 s)
  //   AGENT_HUB_DEEPSEEK_IDLE_MS        longest silence inside a stream that
  //                                     has started (default 300 s)
  // A timeout is a 504 `upstream_timeout` while nothing has gone downstream,
  // otherwise the stream is cut; it never counts as a quota signal.
  ms(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n >= 50 && n <= 3_600_000 ? n : fallback;
  },

  async attempt(req, res, route, key, target, rest) {
    const method = String(req.method || 'GET').toUpperCase();
    const was = key.exhaustedAt || 0;
    const firstByte = this.ms('AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS', 120_000);
    const idle = this.ms('AGENT_HUB_DEEPSEEK_IDLE_MS', 300_000);
    const controller = new AbortController();
    let timedOut = '';
    let timer = null;
    const disarm = () => {
      clearTimeout(timer);
      timer = null;
    };
    const arm = (ms, what) => {
      disarm();
      timer = setTimeout(() => {
        timedOut = what;
        controller.abort();
      }, ms);
    };
    const abort = () => controller.abort();
    res.once('close', abort);
    const finish = () => {
      disarm();
      res.removeListener('close', abort);
    };
    const timeoutReply = () => {
      if (res.headersSent || res.destroyed) return;
      const secs = Math.max(1, Math.round((timedOut === 'idle' ? idle : firstByte) / 1000));
      this.json(res, 504, 'upstream_timeout', `DeepSeek 閘道（${key.gateway || route.gateway}）${timedOut === 'idle' ? `傳輸中斷了 ${secs} 秒沒有新資料` : `${secs} 秒內沒有回應`}，已停止等待；沒有換 key。`);
    };
    arm(firstByte, 'first_byte');
    let upstream;
    try {
      upstream = await fetch(target.base + rest, {
        method,
        headers: this.upstreamHeaders(req, key, route),
        body: method === 'GET' || method === 'HEAD' ? undefined : target.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      finish();
      if (timedOut) return timeoutReply(), { done: true };
      // A network error is not a quota signal: no other key is tried.
      if (!res.headersSent && !res.destroyed) this.json(res, 502, 'upstream_unreachable', `連不到 DeepSeek 閘道：${key.gateway || route.gateway}`);
      return { done: true };
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      try {
        // Nothing goes downstream before the first body byte: a gateway that
        // sends headers and then nothing is a clean 504, not an empty 200.
        let started = false;
        const start = () => {
          if (started) return;
          started = true;
          res.writeHead(upstream.status, this.downHeaders(upstream.headers));
        };
        const reader = upstream.body?.getReader();
        if (reader) {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (res.destroyed) {
              await reader.cancel().catch(() => {});
              break;
            }
            start();
            // A slow reader downstream is not a silent gateway.
            disarm();
            if (!res.write(Buffer.from(value))) await this.drain(res);
            arm(idle, 'idle');
          }
        }
        start();
        res.end();
        this.ok(route, key, was);
      } catch {
        if (timedOut && !res.headersSent) timeoutReply();
        else {
          // Bytes may already be downstream: this request is never replayed.
          try {
            res.destroy();
          } catch {}
        }
      } finally {
        finish();
      }
      return { done: true };
    }

    let errBody;
    try {
      errBody = await this.readUpTo(upstream.body, DS_PROXY_MAX_ERROR);
    } catch {
      finish();
      if (timedOut) return timeoutReply(), { done: true };
      if (!res.headersSent && !res.destroyed) this.json(res, 502, 'upstream_unreachable', `讀不到 DeepSeek 閘道的錯誤回應：${key.gateway || route.gateway}`);
      return { done: true };
    }
    finish();
    const errText = errBody.toString('utf8');
    if (this.quota(upstream.status, errText)) return { quota: true, resetAt: this.resetAt(upstream.headers, errText) };
    if (res.destroyed) return { done: true };
    const headers = this.downHeaders(upstream.headers);
    headers['content-length'] = String(errBody.length);
    res.writeHead(upstream.status, headers);
    res.end(errBody);
    return { done: true };
  },

  // Every key was tried, is waiting, or cannot serve this request: one answer
  // that lists each key by gateway and last four characters (never a key) with
  // its state, and the earliest time the gateways stated, so the conversation
  // says what is going on.
  allOut(res, route, order, skipped, model = '') {
    const now = Date.now();
    const when = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false });
    const usable = order.filter((k) => !skipped.has(k.id));
    if (!usable.length) {
      const names = order.map((k) => DS_LABELS[k.gateway || route.gateway] || k.gateway || route.gateway);
      return this.json(res, 400, 'model_not_available', `號池裡的 key（${[...new Set(names)].join('、')}）都沒有這次要求的模型${model ? ` ${model.slice(0, 80)}` : ''}，沒有送出請求。`);
    }
    const lines = order.map((k, i) => {
      const gw = DS_LABELS[k.gateway || route.gateway] || k.gateway || route.gateway;
      let state;
      if (skipped.has(k.id)) state = `這個閘道沒有這次要求的模型${model ? ` ${model.slice(0, 80)}` : ''}`;
      else if (k.manual) state = '手動標記已滿';
      else if (k.exhaustedAt && k.retryAt && k.retryAt > now) state = `已滿，${when(k.retryAt)} 重置`;
      else if (k.exhaustedAt) state = '已滿，重置時間未知（有請求時會再試）';
      else state = '可用';
      return `${i + 1}. ${gw} …${String(k.apiKey).slice(-4)}：${state}`;
    });
    const stated = order.filter((k) => k.exhaustedAt && !k.manual && k.retryAt && k.retryAt > now).map((k) => k.retryAt);
    const next = Math.min(...order.filter((k) => k.exhaustedAt && !k.manual).map((k) => this.retryAt(route, k)).filter(Number.isFinite));
    const earliest = stated.length ? `；最早已知的重置時間 ${when(Math.min(...stated))}` : '';
    const text = [`DeepSeek 的 API key 都已用盡（共 ${order.length} 把）${earliest}。`, ...lines, '有請求時會自動再試：已知重置時間的 key 到時間才試，重置時間未知的 key 下一個真實請求就會再試。要現在恢復：到 Agent Hub「設定」→「DeepSeek…」對那把按「重新啟用」或「清除標記」，或加入新的 key。'].join('\n');
    this.json(res, 402, 'insufficient_quota', text, Number.isFinite(next) ? { retry_at: next } : {});
  },

  async handle(req, res) {
    try {
      if (!this.authorized(req)) return this.json(res, 401, 'invalid_local_token', '本機 DeepSeek proxy 的憑證不正確');
      const raw = String(req.url || '');
      const q = raw.indexOf('?');
      const pathname = q === -1 ? raw : raw.slice(0, q);
      const search = q === -1 ? '' : raw.slice(q);
      const gateway = pathname.startsWith('/') ? pathname.slice(1).split('/')[0] : '';
      const route = this.route;
      if (!route || gateway !== route.gateway) return this.json(res, 404, 'unknown_gateway', '這個本機 proxy 沒有設定這個閘道');
      const rest = pathname.slice(1 + gateway.length) + search;
      if (!rest.startsWith('/') || /[\r\n]/.test(rest)) return this.json(res, 400, 'bad_path', '請求路徑不正確');
      const body = await this.readBody(req, res);
      if (body === null) return;

      const pool = route.pool;
      const order = this.order(pool);
      const tried = new Set();
      const skipped = new Set(); // keys whose gateway has no counterpart of this request's model
      for (;;) {
        if (this.route !== route) return this.json(res, 409, 'pool_changed', 'DeepSeek 號池已更新，請重試');
        // Healthy keys first; only when none is left, an exhausted key whose
        // wait is over (this request is its probe). The order is one list for
        // every gateway: the next key may be on another one.
        const key = order.find((k) => !tried.has(k.id) && !k.exhaustedAt) || order.find((k) => !tried.has(k.id) && this.due(route, k));
        if (!key) break;
        tried.add(key.id);
        const target = this.prepare(route, key, body);
        if (!target) {
          skipped.add(key.id);
          continue;
        }
        const result = await this.attempt(req, res, route, key, target, rest);
        if (result.done) return;
        if (result.quota) {
          this.fail(route, key, result.resetAt);
          continue;
        }
        return;
      }
      if (!res.headersSent && !res.destroyed) {
        let model = '';
        if (skipped.size) {
          try {
            model = String(JSON.parse(body.toString('utf8')).model || '');
          } catch {}
        }
        this.allOut(res, route, order, skipped, model);
      }
    } catch {
      if (!res.headersSent && !res.destroyed) this.json(res, 502, 'proxy_error', '本機 DeepSeek proxy 發生錯誤');
      else {
        try {
          res.destroy();
        } catch {}
      }
    }
  },
};

// --------------------------------------------------------- plan quota
// Kimi's /usages answer carries the plan quota twice: as ratios
// (usages.limit_5h.used_ratio …), which is all Kimi Code reads and shows,
// and as counts (usage for the week, limits[] for the 5-hour window). The
// ratios have been seen stuck at 0 while the counts, and the 403 "limit
// reached", say otherwise (MoonshotAI/kimi-code#3817, #3908, #3951, #4133).
// So the hub asks for the whole answer: the same request Kimi makes, with
// the login Kimi saved, to the address Kimi uses. Read only: the login is
// never refreshed or written here (Kimi refreshes it when the hub asks it
// for usage first), and it goes nowhere but Kimi's own servers.
const REGIONS = {
  'mainland-cn': ['https://auth.kimi.com', 'https://api.kimi.com/coding/v1'],
  global: ['https://auth.kimi.ai', 'https://api.kimi.ai/coding/v1'],
};
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

const quota = {
  // Where Kimi keeps the login for a sign-in host and API address (its
  // resolveKimiCodeOAuthKey).
  slotOf(host, base) {
    if (host === REGIONS['mainland-cn'][0] && base === REGIONS['mainland-cn'][1]) return 'kimi-code';
    return `kimi-code-env-${crypto.createHash('sha256').update(JSON.stringify({ oauthHost: host, baseUrl: base })).digest('hex').slice(0, 16)}`;
  },

  token(slot) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'credentials', `${slot}.json`), 'utf8'));
      const at = typeof t?.access_token === 'string' ? t.access_token : '';
      // An expired one is a login Kimi no longer uses (it just refreshed the
      // one it does).
      if (!at || (typeof t.expires_at === 'number' && t.expires_at > 0 && t.expires_at < Date.now() / 1000 + 30)) return null;
      return at;
    } catch {
      return null;
    }
  },

  // The (login, address) pairs to try: Kimi's own first.
  async candidates() {
    const data = async (p) => (await server.request('GET', p).catch(() => null))?.data;
    const [region, providers] = await Promise.all([data('/api/v1/oauth/region'), data('/api/v1/providers')]);
    const [rHost, rBase] = REGIONS[region?.region] || REGIONS['mainland-cn'];
    const envHost = trimUrl(process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST);
    const envBase = trimUrl(process.env.KIMI_CODE_BASE_URL);
    const configured = trimUrl((providers?.items || []).find((p) => p.id === 'managed:kimi-code')?.base_url);
    const base = envBase || configured || rBase;
    const pairs = [[envHost || (base === REGIONS.global[1] ? REGIONS.global[0] : rHost), base], REGIONS['mainland-cn'], REGIONS.global];
    const out = [];
    pairs.forEach(([host, b], i) => {
      // The login is only ever sent to an address Kimi itself uses, over
      // https (or to this computer).
      if (!/^https:\/\//.test(b) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(b)) return;
      const slot = this.slotOf(host, b);
      if (!out.some((c) => c.slot === slot && c.base === b)) out.push({ slot, base: b, own: i === 0 });
    });
    return out;
  },

  // `expect`: the reset times Kimi itself just reported, by window. An
  // answer counts only if it is about the same windows (the same account),
  // or, with nothing to compare, if it came from Kimi's own login.
  async read({ expect = {} } = {}) {
    const want = Object.entries(expect).filter(([, v]) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
    const KEYS = { limit5h: 'limit_5h', limit7d: 'limit_7d' };
    const same = (j) => want.every(([k, v]) => Math.abs(Date.parse(j?.usages?.[KEYS[k] || k]?.reset_time) - Date.parse(v)) <= 5000);
    for (const c of await this.candidates()) {
      if (!want.length && !c.own) continue;
      const token = this.token(c.slot);
      if (!token) continue;
      try {
        const res = await fetch(`${c.base}/usages`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const j = await res.json();
        if (!same(j)) continue;
        return { ok: true, payload: { usage: j?.usage ?? null, limits: Array.isArray(j?.limits) ? j.limits : null, usages: j?.usages ?? null } };
      } catch {}
    }
    return { ok: false };
  },
};

// ------------------------------------------------------ Kimi session files
// Kimi keeps every conversation under <home>/sessions/<workspace>/<session>/:
// state.json (title, folder, times) and agents/<agent>/wire.jsonl, a journal
// that whichever process runs the conversation (the TUI or a server) appends
// to as things happen. Reading it is how the hub sees a conversation running
// in a terminal, which Kimi's Server API cannot.

const KEEP = new Set([
  'turn.prompt',
  'turn.steer',
  'turn.ended',
  'turn.step.interrupted',
  'context.append_loop_event',
  'interaction.request',
  'interaction.resolved',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'subagent.suspended',
  'token_counting.turn_recorded',
  'profile.bind',
  // A model or thinking change (/model, /effort, the hub's controls) is
  // recorded as config.update, not as a new profile.bind.
  'config.update',
  'permission.set_mode',
  'plan_mode.set',
  // Swarm mode on and off (Kimi 2.3.3): what makes the Hub's swarm switch
  // follow a /swarm typed in the terminal itself.
  'swarm_mode.enter',
  'swarm_mode.exit',
  'tools.update_store',
  'prompt.steered',
  'prompt.aborted',
  'compaction.started',
  'compaction.completed',
  'goal.updated',
]);
const MAX_OUTPUT = 24_000;
const MAX_ARG = 400_000;

function record(line) {
  const t = /^\{"type":"([^"]+)"/.exec(line)?.[1];
  if (!t || !KEEP.has(t)) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const clipText = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}\n…（內容太長，只顯示前 ${max} 字）` : s);
function clipOutput(o) {
  if (typeof o === 'string') return clipText(o, MAX_OUTPUT);
  if (Array.isArray(o)) return o.map((p) => (p && typeof p.text === 'string' ? { ...p, text: clipText(p.text, MAX_OUTPUT) } : p?.type === 'image' ? { type: 'text', text: '（圖片）' } : p));
  return o;
}
function clipArgs(a) {
  if (!a || typeof a !== 'object') return a;
  const out = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' ? clipText(v, MAX_ARG) : v;
  return out;
}
const textOf = (parts) => (parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

// A journal record → the same frames Kimi's server pushes over WebSocket, so
// the hub handles conversations from either source the same way.
function translate(rec, sid, fileAgent = 'main') {
  const a = rec.agentId || fileAgent;
  const f = (type, payload) => ({ type, session_id: sid, via: 'wire', time: rec.time, payload: { agentId: a, ...payload, sessionId: sid } });
  const work = (busy, pending = 'none', reason) => (a === 'main' ? f('event.session.work_changed', { busy, main_turn_active: busy, pending_interaction: pending, last_turn_reason: reason }) : null);
  switch (rec.type) {
    case 'turn.prompt':
      return [f('turn.started', { turnId: rec.turnId, promptId: rec.promptId, origin: rec.origin, prompt: textOf(rec.input), promptAttachments: (rec.input || []).filter((p) => p.type === 'image') }), work(true)];
    case 'turn.steer':
      return [f('turn.steer', { input: rec.input, promptIds: rec.promptIds, messageId: rec.messageId, turnId: rec.turnId })];
    case 'turn.ended':
      return [f('turn.ended', { turnId: rec.turnId, reason: rec.reason, durationMs: rec.durationMs, error: rec.error }), work(false, 'none', rec.reason)];
    case 'turn.step.interrupted':
      return rec.reason === 'error' && rec.message ? [f('warning', { message: rec.message })] : [];
    case 'context.append_loop_event': {
      const e = rec.event || {};
      const turnId = e.turnId;
      if (e.type === 'content.part') {
        const p = e.part || {};
        if (p.type === 'text' && p.text) return [f('assistant.delta', { turnId, delta: p.text })];
        if (p.type === 'think' && p.think && !p.hidden) return [f('thinking.delta', { turnId, delta: p.think })];
        return [];
      }
      if (e.type === 'tool.call') return [f('tool.call.started', { turnId, toolCallId: e.toolCallId, name: e.name, args: clipArgs(e.args), display: e.display, description: e.description })];
      if (e.type === 'tool.result') return [f('tool.result', { turnId, toolCallId: e.toolCallId, output: clipOutput(e.result?.output), isError: Boolean(e.result?.isError ?? e.result?.is_error) })];
      if (e.type === 'step.end') return [f('turn.step.completed', { turnId, usage: e.usage, llmStreamDurationMs: e.llmStreamDurationMs })];
      return [];
    }
    case 'interaction.request': {
      const r = rec.request || {};
      if (rec.kind === 'approval') {
        return [
          f('event.approval.requested', { approval_id: rec.id, agent_id: a, tool_call_id: rec.toolCallId || r.toolCallId, tool_name: r.toolName, action: r.action, tool_input_display: r.display }),
          f('event.session.work_changed', { agentId: 'main', busy: true, main_turn_active: true, pending_interaction: 'approval' }),
        ];
      }
      if (rec.kind === 'question') {
        return [
          f('event.question.requested', { question_id: rec.id, agent_id: a, tool_call_id: rec.toolCallId || r.toolCallId, questions: r.questions || [] }),
          f('event.session.work_changed', { agentId: 'main', busy: true, main_turn_active: true, pending_interaction: 'question' }),
        ];
      }
      return [];
    }
    case 'interaction.resolved': {
      const d = rec.response?.decision;
      return [
        d ? f('event.approval.resolved', { approval_id: rec.id, decision: d }) : f(rec.response?.dismissed ? 'event.question.dismissed' : 'event.question.answered', { question_id: rec.id }),
        f('event.session.work_changed', { agentId: 'main', busy: true, main_turn_active: true, pending_interaction: 'none' }),
      ];
    }
    case 'subagent.spawned':
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'subagent.cancelled':
    case 'subagent.suspended': {
      const { type, time, ...rest } = rec;
      return [f(type, rest)];
    }
    case 'token_counting.turn_recorded':
      return a === 'main' ? [f('agent.status.updated', { contextTokens: rec.tokens })] : [];
    case 'profile.bind':
      // Subagents bind their own model and thinking too.
      return [f('agent.status.updated', { model: rec.modelAlias, thinkingEffort: rec.thinkingEffort })];
    case 'config.update': {
      const effort = rec.thinkingEffort ?? rec.thinkingLevel;
      if (rec.modelAlias === undefined && effort === undefined) return [];
      return [f('agent.status.updated', { model: rec.modelAlias, thinkingEffort: effort })];
    }
    case 'permission.set_mode':
      return a === 'main' ? [f('agent.status.updated', { permission: rec.mode })] : [];
    case 'swarm_mode.enter':
      // The model's own tool call can enter it too ("tool"); Kimi does not
      // report that as a mode the person turned on, and neither does this.
      return a === 'main' && rec.trigger !== 'tool' ? [f('agent.status.updated', { swarmMode: true })] : [];
    case 'swarm_mode.exit':
      return a === 'main' ? [f('agent.status.updated', { swarmMode: false })] : [];
    case 'tools.update_store':
      return rec.key === 'todo' && a === 'main' ? [f('hub.todos', { todos: rec.value || [] })] : [];
    case 'prompt.steered':
    case 'prompt.aborted':
    case 'goal.updated':
    case 'compaction.started':
    case 'compaction.completed': {
      const { type, time, ...rest } = rec;
      return [f(type, rest)];
    }
    default:
      return [];
  }
}

class Wire {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
  }

  size() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return -1;
    }
  }

  // Complete new lines since the last read.
  readNew(max = 16 * 1024 * 1024) {
    const size = this.size();
    if (size < 0 || size === this.offset) return [];
    if (size < this.offset) Object.assign(this, { offset: 0, partial: '', decoder: new StringDecoder('utf8') });
    const len = Math.min(size - this.offset, max);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += len;
    const lines = (this.partial + this.decoder.write(buf)).split('\n');
    this.partial = lines.pop();
    return lines;
  }

  // Records in [from, to) of the file, whole lines only.
  static slice(file, from, to) {
    const len = Math.max(0, to - from);
    if (!len) return { lines: [], start: from };
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, from);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    let start = from;
    if (from > 0) {
      const i = text.indexOf('\n');
      start = from + Buffer.byteLength(text.slice(0, i + 1));
      text = text.slice(i + 1);
    }
    const lines = text.split('\n');
    if (!text.endsWith('\n')) lines.pop();
    return { lines, start };
  }
}

class DiskSession {
  constructor(id, dir) {
    this.id = id;
    this.dir = dir;
    this.wires = new Map(); // agent id -> Wire
    this.status = { busy: false, pending: new Map(), lastTurn: null, model: '', effort: '', permission: '', contextTokens: 0, todos: [], lastPrompt: '' };
    this.state = null;
    this.stateMtime = 0;
    this.mtime = 0;
    this.subscribed = false;
    this.outbox = []; // frames waiting for the source check
    this.init();
  }

  realCwd() {
    const cwd = this.state?.cwd;
    if (!cwd) return null;
    if (this.cwdKey !== cwd) {
      this.cwdKey = cwd;
      try {
        this.cwdReal = fs.realpathSync(cwd);
      } catch {
        this.cwdReal = cwd;
      }
    }
    return this.cwdReal;
  }

  wireFile(agent) {
    return path.join(this.dir, 'agents', agent, 'wire.jsonl');
  }

  wire(agent) {
    let w = this.wires.get(agent);
    if (!w) this.wires.set(agent, (w = new Wire(this.wireFile(agent))));
    return w;
  }

  agentIds() {
    try {
      return fs.readdirSync(path.join(this.dir, 'agents'));
    } catch {
      return ['main'];
    }
  }

  // Status from the head (model, permission) and tail (open turn, pending
  // approvals) of the journals, without reading whole files.
  init() {
    for (const agent of this.agentIds()) {
      const w = this.wire(agent);
      const size = w.size();
      if (size < 0) continue;
      const tag = (r) => (r && !r.agentId ? Object.assign(r, { agentId: agent }) : r);
      const HEAD = 96 * 1024;
      const TAIL = 512 * 1024;
      if (agent === 'main') {
        for (const line of Wire.slice(w.file, 0, Math.min(size, HEAD)).lines) this.apply(tag(record(line)));
        // A long conversation: the model, thinking and permission set in
        // between, or it would show what it started with.
        if (size > HEAD + TAIL) this.scanSettings(w.file, HEAD, size - TAIL, tag);
      }
      const { lines } = Wire.slice(w.file, Math.max(0, size - TAIL), size);
      for (const line of lines) this.apply(tag(record(line)));
      w.offset = size;
    }
    this.readState();
  }

  // Only the settings records of a stretch of a journal, read in chunks.
  scanSettings(file, from, to, tag) {
    const CHUNK = 4 * 1024 * 1024;
    let rest = '';
    let first = from > 0;
    for (let at = from; at < to; at += CHUNK) {
      const len = Math.min(CHUNK, to - at);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, len, at);
      } finally {
        fs.closeSync(fd);
      }
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop();
      if (first) lines.shift(); // the cut line before it
      first = false;
      for (const line of lines) if (/set_mode|config\.update|profile\.bind/.test(line)) this.apply(tag(record(line)));
    }
  }

  readState() {
    try {
      const st = fs.statSync(path.join(this.dir, 'state.json'));
      if (st.mtimeMs !== this.stateMtime) {
        this.stateMtime = st.mtimeMs;
        this.state = JSON.parse(fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'));
      }
    } catch {}
    try {
      this.mtime = Math.max(this.stateMtime, fs.statSync(this.wireFile('main')).mtimeMs);
    } catch {
      this.mtime = this.stateMtime;
    }
  }

  apply(rec) {
    if (!rec) return false;
    const s = this.status;
    const main = (rec.agentId || 'main') === 'main';
    const before = JSON.stringify([s.busy, [...s.pending.values()], s.lastTurn]);
    switch (rec.type) {
      case 'turn.prompt':
        if (main) (s.busy = true), (s.lastPrompt = textOf(rec.input) || s.lastPrompt);
        break;
      case 'turn.ended':
        if (main) (s.busy = false), (s.lastTurn = rec.reason), s.pending.clear();
        break;
      case 'interaction.request':
        s.pending.set(rec.id, { kind: rec.kind, agentId: rec.agentId || 'main', at: rec.time, toolCallId: rec.toolCallId });
        break;
      case 'interaction.resolved':
        s.pending.delete(rec.id);
        break;
      case 'profile.bind':
        if (main) (s.model = rec.modelAlias || s.model), (s.effort = rec.thinkingEffort || s.effort);
        break;
      case 'config.update':
        if (main) (s.model = rec.modelAlias || s.model), (s.effort = rec.thinkingEffort || rec.thinkingLevel || s.effort);
        break;
      case 'permission.set_mode':
        if (main) s.permission = rec.mode || s.permission;
        break;
      case 'token_counting.turn_recorded':
        if (main) s.contextTokens = rec.tokens || s.contextTokens;
        break;
      case 'tools.update_store':
        if (main && rec.key === 'todo') s.todos = rec.value || [];
        break;
    }
    return JSON.stringify([s.busy, [...s.pending.values()], s.lastTurn]) !== before;
  }

  // Read what was appended; forward it if the hub follows this conversation.
  poll() {
    let changed = false;
    const frames = [];
    for (const agent of this.agentIds()) {
      const w = this.wire(agent);
      const lines = w.readNew();
      for (const line of lines) {
        const rec = record(line);
        if (!rec) continue;
        if (!rec.agentId) rec.agentId = agent;
        if (this.apply(rec)) changed = true;
        if (this.subscribed) frames.push(...translate(rec, this.id, agent).filter(Boolean));
      }
    }
    if (frames.length) {
      frames.sort((x, y) => (x.time || 0) - (y.time || 0));
      const at = Date.now();
      for (const fr of frames) this.outbox.push({ at, fr });
    }
    if (changed) this.readState();
    return changed;
  }

  // Wire frames are only forwarded when no Kimi server is running this
  // conversation (the server's own events carry token-by-token streaming).
  flush(now) {
    if (!this.outbox.length) return;
    const ready = [];
    while (this.outbox.length && now - this.outbox[0].at >= 250) ready.push(this.outbox.shift().fr);
    if (!ready.length) return;
    const ownedByServer = this.owner()?.kind !== 'tui' && (server.busy.has(this.id) || now - (server.seen.get(this.id) || 0) < 3000);
    if (ownedByServer) return;
    for (const fr of ready) hub.send({ t: 'kimi.event', frame: fr });
  }

  owner() {
    return disk.owner(this.id);
  }

  summary() {
    const st = this.state || {};
    const s = this.status;
    const pending = [...s.pending.values()][0];
    const o = this.owner();
    // A turn left open by a Kimi that is gone (crash, kill) is not running.
    const stale = s.busy && !o && !server.busy.has(this.id) && Date.now() - this.mtime > 10 * 60_000;
    return {
      id: this.id,
      title: st.title || st.lastPrompt || s.lastPrompt || '',
      last_prompt: st.lastPrompt || s.lastPrompt || '',
      metadata: { cwd: st.cwd },
      workspace_id: path.basename(path.dirname(this.dir)),
      busy: s.busy && !stale,
      pending_interaction: s.busy && !stale && pending ? pending.kind : 'none',
      last_turn_reason: s.lastTurn || st.lastTurnReason || null,
      updated_at: new Date(this.mtime || st.updatedAt || Date.now()).toISOString(),
      archived: Boolean(st.archived),
      owner: o?.kind || (server.busy.has(this.id) ? 'server' : null),
      model: s.model || '',
      controllable: o?.kind === 'tui' ? o.exact && Boolean(tui.byPid.get(o.pid)) : null,
      // Not sure the terminal Kimi has this one open; locked to be safe.
      guess: o?.kind === 'tui' && !o.exact ? true : undefined,
    };
  }

  info() {
    const s = this.status;
    return { ...this.summary(), model: s.model, effort: s.effort, permission: s.permission, contextTokens: s.contextTokens, todos: s.todos, pending: [...s.pending.entries()].map(([id, p]) => ({ id, ...p })) };
  }

  // The newest `turns` turns of the conversation (main agent plus the
  // subagents it started there) as frames, and the offset to read earlier.
  history({ turns = 60, before } = {}) {
    const main = this.wire('main');
    const end = before ?? main.offset;
    const { lines, start } = Wire.slice(main.file, Math.max(0, end - 24 * 1024 * 1024), end);
    const items = [];
    let off = start;
    for (const line of lines) {
      const rec = record(line);
      if (rec) items.push({ rec, off });
      off += Buffer.byteLength(line) + 1;
    }
    const prompts = items.map((x, i) => (x.rec.type === 'turn.prompt' && (x.rec.agentId || 'main') === 'main' ? i : -1)).filter((i) => i !== -1);
    const cut = prompts.length > turns ? prompts[prompts.length - turns] : 0;
    const kept = items.slice(cut).map((x) => x.rec);
    const more = cut > 0 || start > 0;
    const beforeOffset = cut > 0 ? items[cut].off : start;
    const frames = [];
    const s = this.status;
    // Settings in effect at the start of the window.
    frames.push({ type: 'agent.status.updated', session_id: this.id, via: 'wire', time: 0, payload: { agentId: 'main', model: s.model, thinkingEffort: s.effort, permission: s.permission, sessionId: this.id } });
    const subagents = new Set();
    for (const r of kept) {
      if (r.type === 'subagent.spawned') subagents.add(r.subagentId);
      frames.push(...translate(r, this.id, 'main').filter(Boolean));
    }
    // Subagents (and theirs) started in this window, up to where the live
    // tail continues.
    for (const agent of subagents) {
      const w = this.wire(agent);
      const to = before == null ? w.offset : w.size();
      const sub = Wire.slice(w.file, Math.max(0, to - 8 * 1024 * 1024), to);
      for (const line of sub.lines) {
        const r = record(line);
        if (!r) continue;
        if (r.type === 'subagent.spawned') subagents.add(r.subagentId);
        frames.push(...translate(r, this.id, agent).filter(Boolean));
      }
    }
    frames.sort((x, y) => (x.time || 0) - (y.time || 0));
    return { frames, more, before: more ? beforeOffset : 0, info: this.info() };
  }
}

const disk = {
  sessions: new Map(), // id -> DiskSession
  tuis: [], // terminal Kimis: { pid, cwd, started }
  best: new Map(), // session id -> pid of the terminal Kimi that surely has it open
  lastList: '',

  get(id) {
    let s = this.sessions.get(id);
    if (s) return s;
    for (const ws of this.workspaceDirs()) {
      const dir = path.join(SESSIONS_DIR, ws, id);
      if (fs.existsSync(path.join(dir, 'agents'))) {
        s = new DiskSession(id, dir);
        this.sessions.set(id, s);
        return s;
      }
    }
    return null;
  },

  workspaceDirs() {
    try {
      return fs.readdirSync(SESSIONS_DIR).filter((d) => !d.startsWith('.'));
    } catch {
      return [];
    }
  },

  // Find conversations, newest first; keep the 60 most recent in memory.
  scan() {
    const found = [];
    for (const ws of this.workspaceDirs()) {
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(SESSIONS_DIR, ws));
      } catch {}
      for (const id of entries) {
        if (!id.startsWith('session_')) continue;
        const dir = path.join(SESSIONS_DIR, ws, id);
        let mtime = 0;
        for (const f of ['state.json', 'agents/main/wire.jsonl']) {
          try {
            mtime = Math.max(mtime, fs.statSync(path.join(dir, f)).mtimeMs);
          } catch {}
        }
        if (mtime) found.push({ id, dir, mtime });
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const keep = new Set();
    for (const f of found.slice(0, 60)) {
      keep.add(f.id);
      if (!this.sessions.has(f.id)) this.sessions.set(f.id, new DiskSession(f.id, f.dir));
      const s = this.sessions.get(f.id);
      if (f.mtime !== s.mtime) s.readState();
    }
    for (const [id, s] of this.sessions) if (!keep.has(id) && !s.subscribed) this.sessions.delete(id);
    hub.pushSessions();
  },

  poll() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Followed conversations every tick; the rest about once a second.
      if (!s.subscribed && now < (s.nextPoll || 0)) continue;
      s.nextPoll = now + 1000;
      if (s.poll()) hub.pushSession(s);
      s.flush(now);
    }
  },

  // A terminal Kimi does not say which conversation it has open. The one in
  // its folder it wrote since it started is surely it; any other in that
  // folder might be (opened with /resume or -c and not written yet), so it
  // is locked too unless the hub drove it through the server since then, or
  // a terminal Kimi handed it over with /web (procs.serverHolds).
  owner(id) {
    const pid = this.best.get(id);
    if (pid) return { kind: 'tui', pid, exact: true };
    if (!this.tuis.length || procs.serverHolds(id)) return null;
    const cwd = (this.sessions.get(id) || this.get(id))?.realCwd();
    const mine = server.mine.get(id) || 0;
    const p = cwd && this.tuis.find((t) => t.cwd === cwd && mine < t.started);
    return p ? { kind: 'tui', pid: p.pid, exact: false } : null;
  },

  list() {
    return [...this.sessions.values()].map((s) => s.summary()).filter((x) => !x.archived).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  },
};

// --------------------------------------------- Kimi running in terminals
// Which conversations are open in a terminal Kimi (the TUI): a Kimi process
// that is not a server, whose working folder is the conversation's folder
// and that wrote the conversation's journal since it started.

const procs = {
  last: '',
  tuis: [],
  picks: new Map(), // terminal Kimi pid -> { id, webAt }: the conversation it surely has open, when it ran /web
  webbed: [], // servers that were a terminal Kimi until it ran /web: base urls
  held: new Map(), // session id -> its journal's time when it was surely a server's
  busyAt: new Map(), // session id -> when such a server was last seen running a turn in it
  checked: '', // what `held` was last worked out with
  checking: null,

  // /web turns a terminal Kimi into a server, which lets go of the
  // conversation it had open (it is loaded again when it is opened in the
  // web page). That conversation is then the hub's to drive, not another
  // terminal Kimi's that happens to be in the same folder: until something
  // writes to it while no server runs it, which is a terminal Kimi that
  // opened it.
  serverHolds(id) {
    const at = this.held.get(id);
    const s = disk.sessions.get(id);
    return at !== undefined && Boolean(s) && s.mtime <= at;
  },

  // While a server that was a terminal Kimi has the conversation loaded (the
  // Kimi web page opened it) and runs turns in it, its writes are its own.
  check() {
    if (this.checking) return this.checking;
    const { tuis, webbed } = this;
    this.checking = (async () => {
      const cwds = new Set(tuis.map((p) => p.cwd));
      const near = webbed.length ? [...disk.sessions.values()].filter((s) => cwds.has(s.realCwd())).sort((a, b) => b.mtime - a.mtime).slice(0, 40) : [];
      await Promise.all(
        near.map(async (s) => {
          const seen = (await Promise.all(webbed.map((b) => server.holds(b, s.id)))).filter(Boolean);
          if (!seen.some((x) => x.live)) return;
          const now = Date.now();
          if (seen.some((x) => x.busy) || server.busy.has(s.id)) this.busyAt.set(s.id, now);
          const quiet = [this.busyAt.get(s.id), server.seen.get(s.id), server.mine.get(s.id)].every((t) => now - (t || 0) > 6000);
          if (!this.held.has(s.id) || !quiet) this.held.set(s.id, s.mtime);
        }),
      ).catch(() => {});
      this.checked = JSON.stringify([tuis.map((p) => p.pid), webbed]);
    })().finally(() => (this.checking = null));
    return this.checking;
  },

  // The conversation a terminal Kimi surely has open: the newest in its
  // folder written since it started.
  pick(p) {
    let pick = null;
    for (const s of disk.sessions.values()) {
      if (s.realCwd() !== p.cwd || s.mtime < p.started - 2000) continue;
      if ((server.mine.get(s.id) || 0) >= p.started || this.serverHolds(s.id)) continue;
      if (!pick || s.mtime > pick.mtime) pick = s;
    }
    return pick;
  },

  scan() {
    let list = [];
    try {
      if (process.platform === 'linux') list = this.linux();
      else if (process.platform === 'darwin') list = this.mac();
    } catch {}
    const servers = new Map(); // pid -> base url
    try {
      for (const f of fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances'))) {
        try {
          const inst = JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8'));
          servers.set(inst.pid, `http://${inst.host === '0.0.0.0' ? '127.0.0.1' : inst.host || '127.0.0.1'}:${inst.port}`);
        } catch {}
      }
    } catch {}
    const real = (d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return d;
      }
    };
    const tuis = list.filter((p) => !servers.has(p.pid) && p.pid !== process.pid).map((p) => ({ ...p, cwd: real(p.cwd) }));
    // A terminal Kimi that is a server now ran /web: its conversation is handed over.
    const now = Date.now();
    for (const [pid, pick] of this.picks) {
      if (servers.has(pid) && !pick.webAt) {
        pick.webAt = now;
        log(`… 終端機的 Kimi（pid ${pid}）輸入了 /web：它的對話交給中控台`);
      }
      // Its last writes land as it stops.
      const s = pick.webAt && disk.sessions.get(pick.id);
      if (s && now - pick.webAt < 8000) this.held.set(pick.id, s.mtime);
      if (!servers.has(pid) && !tuis.some((p) => p.pid === pid)) this.picks.delete(pid);
    }
    const webbed = [...this.picks].filter(([pid, x]) => x.webAt && servers.has(pid)).map(([pid]) => servers.get(pid)).sort();
    this.tuis = tuis;
    this.webbed = webbed;
    if (webbed.length && tuis.length && JSON.stringify([tuis.map((p) => p.pid), webbed]) !== this.checked && !this.checking) this.check().then(() => this.scan());
    for (const id of this.held.keys()) if (!disk.sessions.has(id)) this.held.delete(id);
    const best = new Map();
    for (const p of tuis) {
      const pick = this.pick(p);
      if (!pick) {
        this.picks.delete(p.pid);
        continue;
      }
      this.picks.set(p.pid, { id: pick.id });
      // Two terminal Kimis in one folder: the one that started it, or else the newest.
      const other = tuis.find((q) => q.pid === best.get(pick.id));
      const made = (q) => Date.parse(pick.state?.created_at || '') >= q.started - 2000;
      if (!other || (made(p) && !made(other)) || (made(p) === made(other) && p.started > other.started)) best.set(pick.id, p.pid);
    }
    const held = [...this.held.keys()].filter((id) => this.serverHolds(id));
    const key = JSON.stringify([tuis.map((p) => [p.pid, p.cwd]), [...best], [...server.mine.keys()], held]);
    if (key !== this.last) {
      disk.tuis = tuis;
      disk.best = best;
      this.last = key;
      for (const s of disk.sessions.values()) hub.pushSession(s);
    }
  },

  linux() {
    const out = [];
    const ticks = 100;
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8'));
    const boot = Date.now() - uptime * 1000;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let cmd;
      try {
        cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        continue;
      }
      if (!/^kimi-code\b|\/kimi(\s|$)|kimi-code\/dist\/main\.mjs/.test(cmd) || /agent-hub-bridge|^python/.test(cmd)) continue;
      try {
        const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').find((e) => e.startsWith('KIMI_CODE_HOME='));
        const home = env ? path.resolve(env.slice(15)) : path.join(os.homedir(), '.kimi-code');
        if (home !== KIMI_HOME) continue;
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.push({ pid: Number(d), cwd: fs.readlinkSync(`/proc/${d}/cwd`), started: boot + (Number(fields[19]) / ticks) * 1000 });
      } catch {}
    }
    return out;
  },

  mac() {
    const ps = execFileSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' });
    const found = [];
    for (const line of ps.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
      if (m && /^kimi-code\b|\/kimi(\s|$)|kimi-code\/dist\/main\.mjs/.test(m[3]) && !/agent-hub-bridge|python/.test(m[3])) found.push({ pid: Number(m[1]), started: Date.parse(m[2]) });
    }
    if (!found.length) return [];
    const lsof = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', found.map((p) => p.pid).join(',')], { encoding: 'utf8' });
    let pid = null;
    for (const l of lsof.split('\n')) {
      if (l.startsWith('p')) pid = Number(l.slice(1));
      else if (l.startsWith('n') && pid) {
        const p = found.find((x) => x.pid === pid);
        if (p) p.cwd = l.slice(1);
      }
    }
    return found.filter((p) => p.cwd);
  },
};

// Terminal Kimis started with `agent-hub-bridge.mjs kimi` register here and
// accept keystrokes from the hub.
const tui = {
  byPid: new Map(), // kimi pid -> { sock, cwd }

  controller(sid) {
    const o = disk.owner(sid);
    return o?.kind === 'tui' && o.exact ? this.byPid.get(o.pid) || null : null;
  },

  async input(sid, args) {
    const { action, text = '', decision, feedback, index, confirm } = args;
    const o = disk.owner(sid);
    const c = this.controller(sid);
    if (!o) throw new Error('這個對話沒有在終端機裡執行');
    if (!o.exact) throw new Error('這個資料夾有終端機的 Kimi 開著，但看不出它開的是不是這個對話，所以不能把按鍵送進那個終端機；中控台會改經 Kimi 伺服器操作這個對話，不需要關閉終端機。');
    if (!c) throw new Error('這個對話正在終端機的 Kimi 裡執行，但那個 Kimi 不是用 kimi-hub 啟動的，所以中控台不能把按鍵送進那個終端機；中控台會改經 Kimi 伺服器操作這個對話，終端機照常使用，不需要關閉它或輸入 /web。');
    const s = disk.get(sid);
    const paste = (t) => `\x1b[200~${t}\x1b[201~`;
    const keys = [];
    switch (action) {
      case 'send':
        // Enter starts a turn; while Kimi works, Ctrl-S slips the message
        // into the running turn (Kimi's "add guidance").
        keys.push(paste(text), (args.mode ? args.mode === 'steer' : s?.status.busy) ? '\x13' : '\r');
        break;
      case 'command':
        keys.push(text, '\r');
        if (confirm) keys.push({ wait: 500 }, '\r');
        break;
      case 'approve': {
        const pending = [...(s?.status.pending.entries() || [])].filter(([, p]) => p.kind === 'approval');
        if (!pending.length) throw new Error('這個核准已經處理過了');
        if (decision === 'rejected' && feedback) keys.push('4', paste(feedback), '\r');
        else keys.push({ approved: '1', approved_session: '2', rejected: '3' }[decision] || '3');
        break;
      }
      case 'answer':
        keys.push(String((index ?? 0) + 1));
        break;
      case 'interrupt':
        keys.push('\x1b');
        break;
      case 'background':
        keys.push('\x02'); // Ctrl+B
        break;
      default:
        throw new Error(`未知的操作：${action}`);
    }
    for (const k of keys) {
      if (typeof k === 'object') {
        await new Promise((r) => setTimeout(r, k.wait));
        continue;
      }
      c.sock.write(`${JSON.stringify({ t: 'input', data: Buffer.from(k).toString('base64') })}\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
    return { ok: true };
  },
};

function localReply(sock, id, ok, data, error) {
  try {
    sock.write(`${JSON.stringify({ t: 'res', id, ok, ...(ok ? { data } : { error }) })}\n`);
  } catch {}
}

// A stdio MCP server or a PreToolUse hook asks the bridge; the bridge only
// relays over its authenticated Hub WebSocket. No local API key is passed.
function handleLocalBroker(sock, m) {
  const kind = m.t === 'hook' ? 'hook' : 'broker';
  const timeout = kind === 'hook' ? 15_000 : 30 * 60_000;
  const args = kind === 'hook'
    ? { sessionId: m.sessionId, toolName: m.toolName, toolInput: m.toolInput }
    : { token: m.token, provider: m.provider, model: m.model, effort: m.effort, task: m.task, parentEventId: m.parentEventId, background: m.background === true };
  hub
    .call(kind, args, timeout)
    .then((data) => localReply(sock, m.id, true, data))
    .catch((err) => localReply(sock, m.id, false, null, err.message));
}

function listenLocal() {
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(SOCK);
    } catch {}
  }
  const srv = net.createServer((sock) => {
    let buf = '';
    let pid = null;
    sock.setEncoding('utf8'); // a character cut at a chunk boundary stays whole
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.t === 'hello' && m.pid) {
            pid = m.pid;
            tui.byPid.set(pid, { sock, cwd: m.cwd });
            log(`✓ 終端機的 Kimi（pid ${pid}，${m.cwd}）可以從中控台操作`);
            for (const [sid, p] of disk.best) if (p === pid) hub.pushSession(disk.sessions.get(sid), true);
          } else if (m.t === 'hook' || m.t === 'broker') {
            handleLocalBroker(sock, m);
          }
        } catch {}
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (pid && tui.byPid.get(pid)?.sock === sock) tui.byPid.delete(pid);
    });
  });
  srv.on('error', (err) => log(`… 本機控制通道沒有開啟：${err.message}`));
  srv.listen(SOCK, () => {
    if (process.platform !== 'win32') fs.chmodSync(SOCK, 0o600);
  });
}

// ----------------------------------------------------------------- GitHub

// GitHub for the agents here (Kimi, and Claude conversations working on this
// computer): signed in once with the GitHub CLI, from the hub's "GitHub…".
// github:begin — generated from server/github.js by scripts/sync-bridge-github.mjs
const github = (() => {
  const GH = process.env.AGENT_HUB_GH || 'gh';
  const HOST = 'github.com';
  // Asked for on top of gh's own (repo, read:org, gist): pushing changes to
  // .github/workflows needs it.
  const EXTRA_SCOPES = ['workflow'];
  // gh never waits for an answer that will not come.
  const ENV = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' };

  function run(cmd, args, { input, timeoutMs = 20_000 } = {}) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...ENV }, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
        resolve({ ok: !err, missing: err?.code === 'ENOENT', out: String(stdout).trim(), err: String(stderr).trim() }),
      );
      child.stdin?.on('error', () => {});
      if (input != null) child.stdin?.end(input);
    });
  }

  const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

  // How to install gh here, for the user to run.
  function installHint() {
    if (process.platform === 'darwin') return 'brew install gh';
    if (process.platform === 'win32') return 'winget install --id GitHub.cli';
    let osr = '';
    try {
      osr = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
    } catch {}
    if (/fedora|rhel|centos|rocky|alma/.test(osr)) return 'sudo dnf install gh';
    if (/arch|manjaro/.test(osr)) return 'sudo pacman -S github-cli';
    if (/alpine/.test(osr)) return 'sudo apk add github-cli';
    // GitHub's own apt repository: not every Debian-based system carries gh
    // (Kali does not).
    const apt = [
      'mkdir -p -m 755 /etc/apt/keyrings',
      'wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg',
      'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      'apt update',
      'apt install -y gh',
    ].join(' && ');
    return process.getuid?.() === 0 ? apt : `sudo sh -c '${apt}'`;
  }

  async function gitIdentity() {
    const [name, email] = await Promise.all([run('git', ['config', '--global', 'user.name']), run('git', ['config', '--global', 'user.email'])]);
    return { name: name.out || null, email: email.out || null };
  }

  // After signing in: git pushes over https with gh's sign-in, and commits get
  // the account's name (and its private noreply address) unless git already has
  // an identity.
  async function finish() {
    const setup = await run(GH, ['auth', 'setup-git', '--hostname', HOST]);
    if (!setup.ok) throw new Error(`gh auth setup-git 失敗：${firstLine(setup.err)}`);
    const u = await run(GH, ['api', 'user', '--hostname', HOST]);
    if (!u.ok) return;
    const user = JSON.parse(u.out);
    const id = await gitIdentity();
    if (!id.name) await run('git', ['config', '--global', 'user.name', user.name || user.login]);
    if (!id.email) await run('git', ['config', '--global', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`]);
  }

  // A sign-in in the browser (gh's device flow): gh shows a code, the user
  // enters it at github.com/login/device, gh finishes on its own.
  let web = null; // { child, code, url, state: 'waiting' | 'failed', error }

  async function status() {
    const v = await run(GH, ['--version']);
    if (v.missing) return { gh: null, install: installHint() };
    const base = { gh: v.out.match(/\d+\.\d+\.\d+/)?.[0] || '?', git: await gitIdentity() };
    if (web?.state === 'waiting') return { ...base, login: null, pending: { code: web.code, url: web.url } };
    const failed = web?.state === 'failed' ? web.error : null;
    web = null;
    const token = await run(GH, ['auth', 'token', '--hostname', HOST]);
    if (!token.ok) return { ...base, login: null, problem: failed };
    const u = await run(GH, ['api', 'user', '--hostname', HOST]);
    if (!u.ok) return { ...base, login: null, problem: `有登入資料，但 GitHub 不接受（${firstLine(u.err) || '連不上 GitHub'}）。重新登入一次。` };
    const user = JSON.parse(u.out);
    return { ...base, login: user.login, account: user.name || null };
  }

  async function loginToken(token) {
    token = String(token || '').trim();
    if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(token)) throw Object.assign(new Error('這不像 GitHub token（ghp_… 或 github_pat_…）'), { status: 400 });
    const r = await run(GH, ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--with-token'], { input: `${token}\n`, timeoutMs: 30_000 });
    if (r.missing) throw Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 });
    if (!r.ok) throw Object.assign(new Error(`GitHub 不接受這個 token：${firstLine(r.err)}`), { status: 400 });
    await finish();
    return status();
  }

  async function loginWeb() {
    if (web?.state === 'waiting') return { code: web.code, url: web.url };
    const child = spawn(GH, ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--web', '--skip-ssh-key', ...EXTRA_SCOPES.flatMap((s) => ['--scopes', s])], {
      env: { ...process.env, ...ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const job = { child, code: null, url: null, state: 'waiting', error: null };
    web = job;
    let out = '';
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    const shown = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const read = (d) => {
        out += d;
        job.code ??= out.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] || null;
        job.url ??= out.match(/https:\/\/\S+\/login\/device\S*/)?.[0] || null;
        if (job.code) resolve({ code: job.code, url: job.url || `https://${HOST}/login/device` });
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (err) => reject(err.code === 'ENOENT' ? Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 }) : err));
      child.on('close', async (code) => {
        clearTimeout(timer);
        reject(new Error(firstLine(out) || 'gh 沒有給出登入碼'));
        if (web !== job) return;
        if (code === 0) {
          try {
            await finish();
            web = null;
          } catch (err) {
            Object.assign(job, { state: 'failed', error: err.message });
          }
        } else Object.assign(job, { state: 'failed', error: job.code ? '沒有完成登入（逾時或被拒絕），再試一次。' : firstLine(out) });
      });
    });
    try {
      return await Promise.race([shown, new Promise((_, reject) => setTimeout(() => reject(new Error('gh 沒有在時間內給出登入碼')), 30_000))]);
    } catch (err) {
      if (web === job) web = null;
      child.kill();
      throw err;
    }
  }

  async function cancelWeb() {
    const job = web;
    web = null;
    job?.child.kill();
    return status();
  }

  // The repositories this account can push to, most recently pushed first
  // (its own, its organizations', and those it collaborates on).
  async function repos() {
    const r = await run(GH, ['api', '--hostname', HOST, 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'], { timeoutMs: 30_000 });
    if (r.missing) throw Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 });
    if (!r.ok) throw Object.assign(new Error(`讀不到 repo 清單：${firstLine(r.err) || '這台電腦還沒登入 GitHub'}`), { status: 409 });
    return JSON.parse(r.out)
      .filter((x) => x.permissions?.push !== false)
      .map((x) => ({ full: x.full_name, private: Boolean(x.private), description: x.description || '', defaultBranch: x.default_branch, pushedAt: x.pushed_at }));
  }

  async function logout() {
    await cancelWeb();
    const s = await status();
    if (s.login) {
      let r = await run(GH, ['auth', 'logout', '--hostname', HOST, '--user', s.login]);
      // gh before 2.40 has one account per host and no --user.
      if (!r.ok && /unknown flag/.test(r.err)) r = await run(GH, ['auth', 'logout', '--hostname', HOST]);
      if (!r.ok) throw new Error(`登出失敗：${firstLine(r.err)}`);
    }
    return status();
  }
  return { status, loginToken, loginWeb, cancelWeb, repos, logout };
})();
// github:end

// ------------------------------------------------------- /artifact skill

// Teaches Kimi that the hub renders the HTML files it writes in a side panel
// (live, while the Write call streams) and that pages can talk back. Kimi
// picks up skills in <KIMI_HOME>/skills without a restart.
const SKILL_MARK = '<!-- agent-hub-artifact v1 -->';
const ARTIFACT_SKILL = [
  '---',
  'name: artifact',
  'description: 做一個 HTML 頁面（Artifact），在 Agent Hub 中控台的側邊面板即時顯示給使用者：進度報告、狀態儀表板、計畫、比較表、介面草稿，或讓使用者點選回覆的頁面。使用者要求 artifact、視覺化、報告頁，或頁面比文字清楚時使用。',
  '---',
  SKILL_MARK,
  '',
  '# Artifact（Agent Hub）',
  '',
  '使用者透過 Agent Hub 網頁中控台在看這個對話。你用 Write 工具寫出的 `.html` 檔，中控台會在側邊面板即時顯示（邊寫邊顯示），使用者不必另外開檔案。',
  '',
  '## 做法',
  '',
  '1. 用 **Write** 工具寫一個完整、獨立的 HTML 檔（含 `<!doctype html>` 與 `<title>`），預設放在工作目錄的 `.artifacts/` 底下，例如 `.artifacts/progress.html`。檔名用英文小寫加連字號。',
  '2. CSS 與 JavaScript 都寫在同一個檔案裡。需要函式庫時從 cdnjs.cloudflare.com 或 cdn.jsdelivr.net 載入。',
  '3. 要更新同一頁就寫回同一個路徑（整份重寫用 Write，小改用 Edit），中控台會換成新版本。',
  '4. `<title>` 是面板上的標題，取一個簡短的名字。',
  '',
  '## 讓使用者從頁面回覆你',
  '',
  '頁面裡可以呼叫 `agentHub.send(文字)`，以使用者的身分把訊息送回這個對話；`agentHub.fill(文字)` 只把文字放進使用者的輸入框，讓他確認後再送出。`agentHub` 只在中控台裡存在，呼叫前先檢查：',
  '',
  '```html',
  '<button onclick="window.agentHub && agentHub.send(\'採用方案 B\')">採用方案 B</button>',
  '```',
  '',
  '## 適合的時機',
  '',
  '- 長時間任務的進度頁：每完成一個階段就更新一次。',
  '- 請使用者做選擇：列出方案，每個方案附一個按鈕。',
  '- 表格、圖表、流程圖、介面草稿這類用文字不好表達的內容。',
  '',
  '## 注意',
  '',
  '- 頁面在沙箱 iframe 裡執行，存取不到中控台的資料。',
  '- 不要把 token、密碼等機密寫進頁面。',
  '- 寫完後在回覆裡用一句話說明這個頁面是什麼。',
  '',
].join('\n');

// Teaches Kimi to use GitHub the way this computer is set up for it: git and
// the GitHub CLI, signed in from the hub (never with a token in the chat).
const GITHUB_SKILL_MARK = '<!-- agent-hub-github v1 -->';
const GITHUB_SKILL = [
  '---',
  'name: github',
  'description: 用 git 與 GitHub CLI（gh）操作 GitHub：clone、建立分支、commit、push、Pull Request、Issue、Actions、Release。使用者提到 GitHub、repo、PR、issue、push、CI 時使用。',
  '---',
  GITHUB_SKILL_MARK,
  '',
  '# GitHub（Agent Hub）',
  '',
  '這台電腦的 GitHub 帳號由使用者在 Agent Hub 中控台登入（左下角「⋯」→「GitHub…」），登入資料存在 GitHub CLI（gh）裡；git 透過 gh 用 https 取得權限，所以 `git push`、`gh pr create` 等都可以直接用。',
  '',
  '## 先確認',
  '',
  '- 執行 `gh auth status` 看有沒有登入、登入的是哪個帳號。',
  '- 沒安裝 gh 或還沒登入：請使用者到 Agent Hub 的「⋯」→「GitHub…」幫這台電腦登入。不要在對話裡跟使用者要 token，也不要自己執行 `gh auth login`。',
  '',
  '## 常用指令',
  '',
  '- 取得 repo：`gh repo clone owner/repo`；看 repo：`gh repo view owner/repo`',
  '- Pull Request：`gh pr create --title … --body …`、`gh pr list`、`gh pr view 123`、`gh pr diff 123`、`gh pr checks 123`、`gh pr checkout 123`',
  '- Issue：`gh issue list`、`gh issue view 45`、`gh issue create --title … --body …`',
  '- Actions：`gh run list`、`gh run view <id> --log-failed`',
  '- 其他：`gh api repos/{owner}/{repo}/…`（REST API）、`gh release list`',
  '- 長的內容（PR 說明、issue 內文）先寫進暫存檔再用 `--body-file` 傳，避免引號出錯。',
  '',
  '## 規則',
  '',
  '- push、開 PR／issue、留言、合併、關閉、刪除分支、建立 release 這些會改到 GitHub 上的動作：使用者沒有明確要求就先問過再做。',
  '- 新工作開新分支，不要直接 push 到預設分支（main／master），除非使用者要求。',
  '- 不要 force push、不要改寫已經 push 的歷史，除非使用者明確要求。',
  '- commit 訊息寫清楚做了什麼；push 前先跑專案的測試或檢查。',
  '- 不要印出、複製或寫進檔案任何 token（不要執行 `gh auth token`）。',
  '- 做完後回報：分支名稱、commit、PR 連結。',
  '',
].join('\n');

function installSkill() {
  if (!INSTALL_SKILL) return;
  const skills = [
    { dir: 'agent-hub-artifact', text: ARTIFACT_SKILL, mark: SKILL_MARK, done: '✓ 已把 /artifact skill 加進 Kimi（Kimi 寫的 HTML 頁面會顯示在中控台）' },
    { dir: 'agent-hub-github', text: GITHUB_SKILL, mark: GITHUB_SKILL_MARK, done: '✓ 已把 /github skill 加進 Kimi（用 git 與 gh 操作 GitHub）' },
  ];
  for (const { dir, text, mark, done } of skills) {
    const file = path.join(KIMI_HOME, 'skills', dir, 'SKILL.md');
    try {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (cur === text) continue;
      if (cur && !cur.includes(mark)) continue; // not ours: leave it alone
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, text);
      log(done);
    } catch (err) {
      log(`… 沒辦法安裝 ${dir} skill：${err.message}`);
    }
  }
}

// ------------------------------------------------------- broker install
// The MCP server and the PreToolUse hook are the only ways a Kimi/DeepSeek
// main agent can reach the Hub's 3×3 broker. They are installed into Kimi's
// own config, and the guard proves the three settings we must never touch
// (default model/provider, [thinking], [secondary_model]) stayed identical.
const PROTECTED_CONFIG = (cfg) => JSON.stringify([
  cfg?.default_model ?? null,
  cfg?.default_provider ?? null,
  cfg?.thinking ?? null,
  cfg?.secondary_model ?? null,
]);

function shellQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function installBroker() {
  const dest = path.join(STATE_DIR, 'agent-hub-bridge.mjs');
  const mcpFile = path.join(KIMI_HOME, 'mcp.json');
  let mcp = {};
  try {
    mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  } catch {}
  mcp.mcpServers = { ...(mcp.mcpServers || {}) };
  mcp.mcpServers['agent-hub'] = {
    command: process.execPath,
    args: [dest, 'mcp', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR],
    toolTimeoutMs: 30 * 60_000,
  };
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  writeFileAtomic(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });

  const before = await server.request('GET', '/api/v1/config', undefined, { internal: true });
  if (before?.code !== 0 || !before.data) throw new Error(before?.msg || '讀不到 Kimi 設定');
  const protectedBefore = PROTECTED_CONFIG(before.data);
  const command = `${shellQuote(process.execPath)} ${shellQuote(dest)} hook --kimi-home ${shellQuote(KIMI_HOME)} --state-dir ${shellQuote(STATE_DIR)}`;
  const hooks = (Array.isArray(before.data.hooks) ? before.data.hooks : []).filter((h) => !String(h?.command || '').includes('agent-hub-bridge.mjs hook'));
  hooks.push({ event: 'PreToolUse', matcher: '.*', command, timeout: 10 });
  const written = await server.request('POST', '/api/v1/config', { hooks }, { internal: true });
  if (written?.code !== 0) throw new Error(written?.msg || 'Kimi 不接受 hooks 設定');
  const after = await server.request('GET', '/api/v1/config', undefined, { internal: true });
  if (after?.code !== 0 || PROTECTED_CONFIG(after.data) !== protectedBefore) {
    throw new Error('安裝 broker 時 Kimi 的 default_model／[thinking]／[secondary_model] 被改動，已停止；請檢查那台電腦的 config.toml');
  }
  if (await server.restartForHooks()) {
    log('✓ 已安裝 Agent Hub 子代理 broker（MCP + PreToolUse hook）');
  } else {
    // Only a conversation that explicitly selects a non-DeepSeek broker has
    // native tools removed per prompt. DeepSeek and native-rule conversations
    // keep Agent/AgentSwarm; a delayed hook must not hold up any of them.
    log('✓ 已啟用可選的跨供應商子代理 broker；Kimi 忙碌中，hook 於下次啟動載入；原生 Agent／DeepSeek 預設不受影響');
  }
}

// ------------------------------------------------------- Claude's tools

// A path inside a conversation's folder (symlinks included), or an error.
function inFolder(cwd, p) {
  const root = fs.realpathSync(path.resolve(String(cwd || '')));
  const target = path.resolve(root, String(p || '.'));
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, target));
  for (const c of [target, real]) {
    const rel = path.relative(root, c);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`path "${p}" is outside the working directory`);
  }
  return { abs: target, rel: path.relative(root, target).split(path.sep).join('/') || '.' };
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', 'dist', 'build', '.turbo']);
const shells = new Map(); // id -> running command

const tools = {
  stat({ cwd, path: p }) {
    const at = inFolder(cwd, p);
    const st = fs.statSync(at.abs, { throwIfNoEntry: false });
    return { ...at, exists: Boolean(st), dir: Boolean(st?.isDirectory()), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
  },
  read({ cwd, path: p }) {
    const at = inFolder(cwd, p);
    const st = fs.statSync(at.abs);
    if (st.isDirectory()) throw new Error(`${p} is a directory`);
    if (st.size > 20 * 1024 * 1024) throw new Error(`the file is ${Math.round(st.size / 1048576)} MB (at most 20 MB)`);
    return { ...at, size: st.size, data: fs.readFileSync(at.abs).toString('base64') };
  },
  // `encoding: 'base64'`: a binary file (an attached .zip).
  write({ cwd, path: p, content, encoding }) {
    const at = inFolder(cwd, p);
    const existed = fs.existsSync(at.abs);
    fs.mkdirSync(path.dirname(at.abs), { recursive: true });
    fs.writeFileSync(at.abs, encoding === 'base64' ? Buffer.from(String(content ?? ''), 'base64') : String(content ?? ''));
    return { ...at, existed };
  },
  walk({ cwd, path: p, limit = 2000 }) {
    const at = inFolder(cwd, p);
    const files = [];
    let seen = 0;
    const walk = (dir, rel) => {
      if (seen > 50_000 || files.length >= limit) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        seen++;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!WALK_SKIP.has(e.name)) walk(path.join(dir, e.name), r);
        } else if (files.length < limit) files.push([r, fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.mtimeMs || 0]);
      }
    };
    walk(at.abs, '');
    return { rel: at.rel, files };
  },
  dirs({ path: p }) {
    const dir = path.resolve(String(p || os.homedir()).replace(/^~(?=$|[\\/])/, os.homedir()));
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      path: dir,
      parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
      home: os.homedir(),
      dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 300),
    };
  },
  // A command in the folder; its output streams to the hub as it comes.
  run({ cwd, command, timeoutMs, id }) {
    const dir = fs.realpathSync(path.resolve(String(cwd || '')));
    const ms = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000);
    return new Promise((resolve) => {
      const child = spawn(IS_WIN ? 'cmd.exe' : 'bash', IS_WIN ? ['/d', '/s', '/c', String(command)] : ['-c', String(command)], {
        cwd: dir,
        detached: !IS_WIN,
        env: { ...process.env, TERM: 'dumb', CI: process.env.CI ?? '1', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let pending = '';
      let flush = null;
      let killedBy = null;
      const kill = (why) => {
        killedBy = why;
        try {
          if (IS_WIN) child.kill();
          else process.kill(-child.pid, 'SIGKILL');
        } catch {}
      };
      shells.set(id, kill);
      const timer = setTimeout(() => kill('timeout'), ms);
      // Decoded as a stream (one decoder per pipe): a character cut at a chunk
      // boundary stays whole.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const collect = (t) => {
        if (out.length < 120_000) out += t;
        pending += t;
        flush ??= setTimeout(() => {
          hub.send({ t: 'sh.data', id, chunk: pending.slice(0, 20_000) });
          pending = '';
          flush = null;
        }, 150);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const done = (exitCode) => {
        clearTimeout(timer);
        clearTimeout(flush);
        shells.delete(id);
        resolve({ output: out, exitCode, killedBy });
      };
      child.on('error', (err) => ((out += err.message), done(-1)));
      child.on('close', (code) => done(code ?? -1));
    });
  },
};

// ------------------------------------------------------- the Claude daemon
// Claude conversations run in a process of their own on this computer (the
// hub's bridge/claude-daemon.mjs, one file), started here and detached from
// the bridge: closing the bridge, its terminal, or the hub leaves them
// running. The bridge only starts it, relays the hub's calls to it and
// forwards what it streams.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the Claude daemon's /health says it can do (`capabilities`), by the names
// the hub's features need. A daemon from before that field has none.
//   handoff          takes a continuation's handoff text in `create`
//   broker           asks the hub for cross-provider subagents / takes the answer
//   subagent_config  keeps a conversation's subagent default (auth.subagent)
const DAEMON_NEEDS = ['handoff', 'broker', 'subagent_config'];
// Calls that start work or set the subagent default, and so would silently drop
// a field an old daemon does not know. Everything else (stop, answer a
// permission, read, delete) stays open: a stale daemon must never trap a
// running conversation.
const DAEMON_WORK_OPS = new Set(['create', 'send', 'command', 'steerQueued', 'steerAll', 'configure']);
const wantsNewDaemon = (op, a = {}) => DAEMON_WORK_OPS.has(op) && (a.auth?.subagent != null || a.config?.subagent != null || a.config?.handoff != null || a.config?.handoffFrom != null || a.change?.subagent != null);

const daemon = {
  file: path.join(STATE_DIR, 'claude-daemon.mjs'),
  dir: path.join(STATE_DIR, 'claude'),
  // A daemon that is running with work in it and lacks what the hub's build
  // needs: { pid, version, missing, reason, since }. null when the daemon on
  // this computer is the hub's own build, or none runs.
  stale: null,
  recheck: null,
  // Conversations kept here: told to the hub, which then has them all shown
  // (and the daemon started, so they go on after a restart of this computer).
  count() {
    try {
      return fs.readdirSync(path.join(this.dir, 'sessions')).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  },
  starting: null,
  checked: null, // { at, health }: the last good health check
  settled: new Map(), // version the hub asked for -> version the daemon it got reports
  streaming: false,
  wake: null, // cuts the forwarder's wait short

  // What the daemon reports as its version (with no AGENT_HUB_DAEMON_VERSION).
  versionOf(file) {
    try {
      return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    } catch {
      return null;
    }
  },

  info() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'daemon.json'), 'utf8'));
    } catch {
      return null;
    }
  },

  async health() {
    const info = this.info();
    if (!info?.port || !info.token) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { 'x-daemon-token': info.token }, signal: AbortSignal.timeout(2000) });
      const h = res.ok ? await res.json() : null;
      if (h?.ok) this.checked = { at: Date.now(), health: h };
      return h?.ok ? h : null;
    } catch {
      return null;
    }
  },

  // The hub asks for its own build. A hub whose version is not simply the
  // file's hash would otherwise have the daemon restarted on every call.
  current(h, version) {
    return !version || h.version === version || this.settled.get(version) === h.version;
  },

  // A daemon on the code the hub has, started if need be. Every call goes
  // through here, so a recent check is trusted for a few seconds.
  async ensure(version) {
    const c = this.checked;
    if (c && Date.now() - c.at < 5000 && this.current(c.health, version)) {
      this.follow();
      return c.health;
    }
    this.starting ??= this.launch(version).finally(() => (this.starting = null));
    const h = await this.starting;
    this.follow(true);
    return h;
  },

  // The capabilities of `h` that the hub's features need but it lacks.
  missing(h) {
    const have = Array.isArray(h?.capabilities) ? h.capabilities : [];
    return DAEMON_NEEDS.filter((c) => !have.includes(c));
  },

  // Record (and tell the hub about) whether the daemon here is too old to be
  // given work that uses new fields. While it is, look again every few
  // seconds: the moment nothing runs in it, it is replaced.
  setStale(next) {
    const was = this.stale;
    this.stale = next;
    if (next && !this.recheck) {
      this.recheck = setInterval(async () => {
        if (this.starting) return;
        try {
          // A stale daemon that has gone away is not replaced here: the next
          // call that needs a daemon starts the hub's build.
          if (!(await this.health())) return this.setStale(null);
          await this.ensure(next.hubVersion);
        } catch {}
      }, Number(process.env.AGENT_HUB_DAEMON_RECHECK_MS) || 15_000);
      this.recheck.unref?.();
    }
    if (!next && this.recheck) {
      clearInterval(this.recheck);
      this.recheck = null;
    }
    if (Boolean(was) !== Boolean(next) || was?.reason !== next?.reason) hub.send({ t: 'daemon.state', stale: Boolean(next), ...(next ? { reason: next.reason } : {}) });
  },

  async launch(version) {
    const h = await this.health();
    // The hub's own build is what it asked for: consistent with the hub by
    // definition, whatever it reports about itself.
    if (h && this.current(h, version)) {
      this.setStale(null);
      return h;
    }
    if (h) {
      // Stopping it would stop the conversations running in it: the old code
      // serves until they are done (a later call updates it) - but only for
      // work it can do. If it lacks what the hub's features need, it is
      // reported as stale and calls that depend on those features are refused
      // (see wantsNewDaemon) instead of being silently half-done; it is
      // replaced as soon as it is idle.
      if (h.running?.length) {
        const missing = this.missing(h);
        this.setStale(
          missing.length
            ? {
                pid: h.pid,
                version: h.version,
                missing,
                hubVersion: version,
                reason: `這台電腦的 Claude 背景程式是舊版本（缺少：${missing.join('、')}），而且還有 ${h.running.length} 個對話正在跑，現在不能換新；等它們結束後會自動升級。在那之前，用到子代理預設或接續歷史的操作會被拒絕。`,
              }
            : null,
        );
        return h;
      }
      log('更新 Claude 背景程式 …');
      try {
        process.kill(h.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 25 && server.alive(h.pid); i++) await sleep(200);
      // Two daemons on the same folder would both write its conversations.
      if (server.alive(h.pid)) {
        log('… 舊的 Claude 背景程式沒有結束，先繼續用它');
        const missing = this.missing(h);
        this.setStale(missing.length ? { pid: h.pid, version: h.version, missing, hubVersion: version, reason: `這台電腦舊的 Claude 背景程式（缺少：${missing.join('、')}）沒有照要求結束，暫時還在用它；用到子代理預設或接續歷史的操作會被拒絕。` } : null);
        return h;
      }
    }
    if (!fs.existsSync(this.file) || (version && this.versionOf(this.file) !== version)) await this.download();
    const started = await this.spawn();
    if (version && started.version !== version) this.settled.set(version, started.version);
    // What the hub gave us to run is, by definition, what it expects.
    this.setStale(null);
    return started;
  },

  async download() {
    log('從中控台下載 Claude 背景程式 …');
    const res = await fetch(`${HUB}/bridge/claude-daemon.mjs`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`無法從中控台下載 Claude 背景程式（HTTP ${res.status}）`);
    const body = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Written whole, then swapped in: a daemon starting meanwhile never runs half a file.
    writeFileAtomic(this.file, body);
  },

  async spawn() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const logFile = path.join(this.dir, 'daemon.log');
    const out = fs.openSync(logFile, 'a');
    let failed = null;
    let exited = null;
    // Its own process group (session): Ctrl+C in the bridge's terminal, or
    // the bridge exiting, does not reach it.
    const child = spawn(process.execPath, [this.file, '--dir', this.dir], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
    fs.closeSync(out);
    child.on('error', (err) => (failed = err.message));
    child.on('exit', (code, signal) => (exited = code ?? signal));
    child.unref();
    for (let i = 0; i < 75; i++) {
      await sleep(200);
      if (failed) throw new Error(`無法啟動 Claude 背景程式：${failed}`);
      if (exited !== null) throw new Error(`Claude 背景程式啟動後馬上結束了（代碼 ${exited}），請看 ${logFile}`);
      if (this.info()?.pid !== child.pid) continue;
      const h = await this.health();
      if (h?.pid === child.pid) {
        log(`✓ Claude 背景程式已啟動（${h.version}，pid ${h.pid}）`);
        return h;
      }
    }
    throw new Error(`Claude 背景程式沒有在 15 秒內啟動，請看 ${logFile}`);
  },

  async rpc(op, args, timeoutMs) {
    timeoutMs = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 900_000);
    const info = this.info();
    if (!info?.port) throw new Error('Claude 背景程式沒有在執行');
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-daemon-token': info.token },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.checked = null; // gone: the next call starts it again
      throw Object.assign(new Error(`連不上 Claude 背景程式：${err.message}`), { refused: err.cause?.code === 'ECONNREFUSED' });
    }
    const j = await res.json().catch(() => null);
    if (!j?.ok) throw Object.assign(new Error(j?.error || `Claude 背景程式回應 HTTP ${res.status}`), { status: j?.status });
    return j.data;
  },

  // Forward the daemon's event stream to the hub for as long as there is a
  // daemon. Only ensure() starts one: a daemon that is gone is waited for.
  follow(now = false) {
    // Just (re)started: connect to it now, not after the backoff.
    if (this.streaming) return now && this.wake?.();
    this.streaming = true;
    this.stream().finally(() => (this.streaming = false));
  },

  async stream() {
    let backoff = 1000;
    while (fs.existsSync(path.join(this.dir, 'daemon.json'))) {
      const info = this.info();
      try {
        const res = await fetch(`http://127.0.0.1:${info?.port}/events`, { headers: { 'x-daemon-token': info?.token || '' } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoff = 1000;
        // Whatever happened while not connected was not seen: the hub reloads.
        hub.send({ t: 'claude.event', msg: { t: 'resync' } });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n');
            if (!data) continue; // `: ping`
            try {
              hub.send({ t: 'claude.event', msg: JSON.parse(data) });
            } catch {}
          }
        }
      } catch {}
      await new Promise((r) => {
        this.wake = r;
        setTimeout(r, backoff);
      });
      this.wake = null;
      backoff = Math.min(backoff * 2, 30_000);
    }
  },
};

// What this connector tells the hub it can do (the hello's `capabilities`).
// Names are fixed (server/machines.js lists them); only what THIS version really
// supports is named, and `broker` only while the broker channel is installed.
//   pool             the DeepSeek key pool's loopback proxy
//   pool_cross       that pool rotating across gateways: one order of keys, each
//                    with its own gateway, the model id and session header of
//                    the gateway the request goes to
//   secondary_model  setting/repairing Kimi's native subagent default
//   broker           cross-provider subagents through the local channel
//   handoff          carrying a continuation's handoff to the Claude daemon, and
//                    never using a daemon that cannot take it (see daemon.stale)
function connectorCapabilities() {
  return ['pool', 'pool_cross', 'secondary_model', ...(brokerReady ? ['broker'] : []), 'handoff'];
}

// ------------------------------------------------------------- the hub

const hub = {
  ws: null,
  backoff: 1000,
  sent: new Map(), // session id -> last summary sent
  pending: new Map(), // request id -> { resolve, reject, timer }
  machineId: null,

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  },

  // A request from the local broker/hook channel. It travels over the same
  // authenticated bridge WebSocket as every other Hub request; no public
  // HTTP port is opened for it.
  call(kind, args = {}, timeoutMs = 120_000) {
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(new Error('與中控台的連線中斷'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('中控台沒有在時間內回應'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'bridge.req', id, kind, args });
    });
  },

  async status() {
    let auth = null;
    if (server.instance) {
      try {
        auth = (await server.request('GET', '/api/v1/auth')).data;
      } catch {}
    }
    return {
      available: true, // conversations are always readable from disk
      server: Boolean(server.instance),
      version: server.version || STATE.kimiVersion || null,
      port: server.instance?.port ?? null,
      auth,
      terminals: process.platform !== 'win32',
    };
  },

  async sendStatus() {
    this.send({ t: 'kimi.status', status: await this.status() });
  },

  // The whole list when conversations appear or disappear; otherwise only
  // the ones whose state changed.
  pushSessions(force = false) {
    const list = disk.list();
    const key = list.map((s) => s.id).join(',');
    if (!force && key === disk.lastList) {
      for (const s of list) this.pushSession(disk.sessions.get(s.id));
      return;
    }
    disk.lastList = key;
    for (const s of list) this.sent.set(s.id, JSON.stringify(s));
    this.send({ t: 'kimi.sessions', items: list });
  },

  pushSession(s, force = false) {
    if (!s) return;
    const item = s.summary();
    const json = JSON.stringify(item);
    if (!force && this.sent.get(s.id) === json) return;
    this.sent.set(s.id, json);
    this.send({ t: 'kimi.session.update', item });
  },

  async handle(op, args = {}) {
    switch (op) {
      case 'kimi.status':
        await server.discover();
        return this.status();
      case 'kimi.start':
        await server.start();
        return this.status();
      case 'kimi.request':
        return server.request(String(args.method || 'GET').toUpperCase(), String(args.path || ''), args.body);
      case 'kimi.usage':
        return quota.read({ expect: args.expect && typeof args.expect === 'object' ? args.expect : {} });
      // DeepSeek models inside this computer's Kimi (see `deepseek` above).
      case 'kimi.deepseek.provision':
        return deepseek.provision(args);
      case 'kimi.deepseek.remove':
        return deepseek.remove();
      case 'kimi.subscribe':
        server.subscribe(args.sessionIds || []);
        for (const id of args.sessionIds || []) {
          const s = disk.get(id);
          if (s) s.subscribed = true;
        }
        return { ok: true };
      case 'kimi.unsubscribe':
        server.unsubscribe(args.sessionIds || []);
        for (const id of args.sessionIds || []) {
          const s = disk.sessions.get(id);
          if (s) (s.subscribed = false), (s.outbox = []);
        }
        return { ok: true };
      case 'kimi.history': {
        const s = disk.get(String(args.sessionId || ''));
        if (!s) throw new Error('找不到這個 Kimi 對話的紀錄檔');
        if (args.before == null) {
          // Read up to the end, then follow live from exactly there.
          s.subscribed = false;
          s.poll();
          s.outbox = [];
          s.subscribed = true;
        }
        return s.history({ turns: args.turns || 60, before: args.before ?? undefined });
      }
      case 'kimi.info': {
        const s = disk.get(String(args.sessionId || ''));
        return s ? s.info() : null;
      }
      // An HTML page Kimi wrote in this conversation, wherever it is (Kimi's
      // own file API only reads inside the conversation's folder). Only
      // .html files whose path appears in the conversation's journal.
      case 'kimi.artifact': {
        const s = disk.get(String(args.sessionId || ''));
        if (!s) throw new Error('找不到這個 Kimi 對話');
        const p = String(args.path || '');
        if (!/\.html?$/i.test(p)) throw new Error('只能讀取 HTML 頁面');
        const abs = path.resolve(s.state?.cwd || os.homedir(), p);
        const esc = (x) => JSON.stringify(x).slice(1, -1);
        const needles = [...new Set([p, abs, path.relative(s.state?.cwd || '', abs)])].filter(Boolean).flatMap((x) => [esc(x), esc(esc(x))]);
        const agents = (() => {
          try {
            return fs.readdirSync(path.join(s.dir, 'agents'));
          } catch {
            return [];
          }
        })();
        const known = agents.some((a) => {
          try {
            const text = fs.readFileSync(path.join(s.dir, 'agents', a, 'wire.jsonl'), 'utf8');
            return needles.some((n) => text.includes(n));
          } catch {
            return false;
          }
        });
        if (!known) throw new Error('這個頁面不是 Kimi 在這個對話裡寫的');
        const st = fs.statSync(abs);
        if (st.size > 5 * 1024 * 1024) throw new Error('頁面超過 5 MB');
        return { path: abs, content: fs.readFileSync(abs, 'utf8') };
      }
      case 'kimi.unlock': {
        const sid = String(args.sessionId || '');
        // Also one a terminal Kimi surely had open: the user says it is not open any more.
        server.mine.set(sid, Date.now());
        procs.scan();
        return { ok: true };
      }
      case 'kimi.tui.input':
        return tui.input(String(args.sessionId || ''), args);
      case 'fs.stat':
        return tools.stat(args);
      case 'fs.read':
        return tools.read(args);
      case 'fs.write':
        return tools.write(args);
      case 'fs.walk':
        return tools.walk(args);
      case 'fs.dirs':
        return tools.dirs(args);
      case 'sh.run':
        return tools.run(args);
      // GitHub on this computer (server/github.js has the hub's own).
      case 'github.status':
        return github.status();
      case 'github.login':
        return github.loginToken(args.token);
      case 'github.web':
        return github.loginWeb();
      case 'github.cancel':
        return github.cancelWeb();
      case 'github.logout':
        return github.logout();
      case 'github.repos':
        return github.repos();
      case 'sh.kill':
        shells.get(String(args.id || ''))?.('interrupted');
        return { ok: true };
      // Claude conversations: calls into this computer's Claude daemon,
      // started (or updated to the hub's build) first if need be.
      case 'claude.rpc':
        await daemon.ensure(args.version);
        // The daemon here is too old and busy: work that depends on what it
        // lacks is refused, not handed over to have the new fields dropped.
        if (daemon.stale && wantsNewDaemon(String(args.op), args.args)) {
          throw Object.assign(new Error(`${daemon.stale.reason} 這個操作需要新版功能，為了不讓它被悄悄略過，已拒絕；對話結束或停止後再試一次。`), { status: 409 });
        }
        try {
          return await daemon.rpc(String(args.op), args.args || {}, args.timeoutMs);
        } catch (err) {
          // It went away since it was last seen (the call never reached it):
          // start it again and ask once more.
          if (!err.refused) throw err;
          await daemon.ensure(args.version);
          return daemon.rpc(String(args.op), args.args || {}, args.timeoutMs);
        }
      case 'claude.health':
        return daemon.health();
      case 'workspace.create': {
        const slug = String(args.name || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
        let dir = path.join(WORKSPACES, `${new Date().toISOString().slice(0, 10)}-${slug}`);
        for (let i = 2; fs.existsSync(dir); i++) dir = path.join(WORKSPACES, `${new Date().toISOString().slice(0, 10)}-${slug}-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
          execFileSync('git', ['init', '-q'], { cwd: dir });
          execFileSync('git', ['-c', 'user.name=Agent Hub', '-c', 'user.email=agent-hub@localhost', 'commit', '-q', '--allow-empty', '-m', 'Agent Hub workspace'], { cwd: dir });
        } catch {}
        return { path: dir };
      }
      default:
        throw new Error(`未知的操作：${op}`);
    }
  },

  connect(machineId) {
    this.machineId = machineId;
    const url = `${HUB.replace(/^http/, 'ws')}/bridge?key=${encodeURIComponent(KEY)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => {
      this.backoff = 1000;
      log(`✓ 已連上中控台 ${HUB}（電腦名稱：${NAME}）`);
      if (process.platform !== 'win32') log(`  想讓中控台把輸入直接打進終端機裡的 Kimi：用「node ${path.join(STATE_DIR, 'agent-hub-bridge.mjs')} kimi」啟動 Kimi（可以設成 alias kimi-hub）；不這樣做也行，中控台會經 Kimi 伺服器操作，終端機與中控台並存`);
      this.send({
        t: 'hello',
        machineId,
        name: NAME,
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        bridgeVersion: VERSION,
        pool: 1,
        broker: brokerReady ? BROKER_VERSION : 0,
        capabilities: connectorCapabilities(),
        daemonStale: Boolean(daemon.stale),
        ...(daemon.stale ? { daemonStaleReason: daemon.stale.reason } : {}),
        node: process.version,
        home: os.homedir(),
        status: await this.status(),
        claudeSessions: daemon.count(),
      });
      // A restarted bridge tells the hub the pool it still has, without any
      // key material; the hub then knows this machine's actual active key.
      proxy.report(true);
      this.sent.clear();
      this.pushSessions(true);
    };
    ws.onmessage = async (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'res' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(Object.assign(new Error(m.error || '中控台回報錯誤'), { status: m.status }));
      } else if (m.t === 'req') {
        try {
          this.send({ t: 'res', id: m.id, ok: true, data: await this.handle(m.op, m.args) });
        } catch (err) {
          this.send({ t: 'res', id: m.id, ok: false, error: err.message, status: err.status });
        }
      } else if (m.t === 'error') {
        log(`✗ 中控台拒絕連線：${m.message}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('與中控台的連線中斷'));
        this.pending.delete(id);
      }
      if (e.code === 4401) {
        log('✗ 連接金鑰錯誤，請到中控台的「連接電腦」重新複製指令');
        process.exit(1);
      }
      log(`… 與中控台的連線中斷，${Math.round(this.backoff / 1000)} 秒後重試`);
      setTimeout(() => this.connect(machineId), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => {};
  },
};

// --------------------------------------------------------- MCP / hook modes
// Both are deliberately tiny stdio processes. They never hold an API key:
// the MCP process only sees the short-lived delegation token that Kimi puts
// in the prompt, and hands it to the bridge over the local socket.

function localCall(message, timeoutMs = 30 * 60_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('本機連接器沒有在時間內回應')), timeoutMs);
    sock.setEncoding('utf8'); // a character cut at a chunk boundary stays whole
    sock.on('connect', () => sock.write(`${JSON.stringify(message)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i === -1) return;
      try {
        const r = JSON.parse(buf.slice(0, i));
        if (r.ok) finish(null, r.data);
        else finish(new Error(r.error || '本機連接器回報錯誤'));
      } catch (err) {
        finish(err);
      }
    });
    sock.on('error', (err) => finish(err));
  });
}

function mcpWrite(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const DELEGATE_TOOL = {
  name: 'delegate_to_provider',
  description:
    'Optional cross-provider subagent broker. Use only for a non-DeepSeek Kimi/Claude choice or an explicit cross-provider override; DeepSeek uses native Agent/AgentSwarm. Only self-contained work that benefits from delegation, never trivial work. Use background:true for independent parallel tasks. Requires the token in the hidden Agent Hub reminder; without it, do not call this tool. Progress and results stay visible in Agent Hub.',
  inputSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'The short-lived token from the hidden Agent Hub system reminder.' },
      task: { type: 'string', description: 'A complete, self-contained brief for the subagent.' },
      provider: { type: 'string', enum: ['kimi', 'claude', 'deepseek'], description: 'Optional one-shot provider override.' },
      model: { type: 'string', description: 'Optional one-shot model override.' },
      effort: { type: 'string', description: 'Optional one-shot thinking effort override.' },
      background: { type: 'boolean', default: false, description: 'Return after the child starts; its result is delivered to this conversation when done.' },
    },
    required: ['token', 'task'],
    additionalProperties: false,
  },
};

async function runMcp() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const id = req.id;
      const method = req.method;
      if (method === 'initialize') {
        mcpWrite({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-hub', version: String(BROKER_VERSION) } } });
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        // notification: no response
      } else if (method === 'ping') {
        mcpWrite({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        mcpWrite({ jsonrpc: '2.0', id, result: { tools: [DELEGATE_TOOL] } });
      } else if (method === 'tools/call') {
        const name = req.params?.name;
        const args = req.params?.arguments || {};
        if (name !== DELEGATE_TOOL.name) {
          mcpWrite({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } });
          continue;
        }
        try {
          const r = await localCall({ t: 'broker', id: crypto.randomBytes(8).toString('hex'), token: args.token, provider: args.provider, model: args.model, effort: args.effort, task: args.task, background: args.background === true }, 30 * 60_000);
          const text = r?.error ? `${r.error}${r.text ? `\n\n${r.text}` : ''}` : String(r?.text || '(子代理完成，但沒有文字回覆)');
          mcpWrite({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              ...(r?.error ? { isError: true } : {}),
              structuredContent: r ? { childSessionId: r.childSessionId, provider: r.provider, model: r.model, effort: r.effort, ...(r.background ? { background: true, status: r.status } : {}) } : undefined,
            },
          });
        } catch (err) {
          mcpWrite({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
        }
      } else if (id !== undefined) {
        mcpWrite({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function runHook() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  try {
    const r = await localCall({ t: 'hook', id: crypto.randomBytes(8).toString('hex'), sessionId: input.sessionId || input.session_id, toolName: input.toolName || input.tool_name, toolInput: input.toolInput || input.tool_input }, 8_000);
    if (r?.deny) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: r.reason || 'Agent Hub：請使用 MCP delegate_to_provider' } }));
    }
  } catch {
    // Bridge/Hub offline: do not break native Kimi behaviour globally. The
    // MCP token path is equally unavailable then; the user sees the failure
    // when they ask for the subagent.
  }
  process.exit(0);
}

// ------------------------------------------------------------------ main

if (MODE === 'mcp') await runMcp();
else if (MODE === 'hook') await runHook();
else if (MODE === 'kimi') await runKimi(argv.slice(1));
else await runBridge();
