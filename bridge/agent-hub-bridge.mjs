#!/usr/bin/env node
// Agent Hub bridge — runs on every computer whose Kimi Code you want to use
// from the hub. It connects *out* to the hub (no open ports, works behind
// NAT) and relays:
//   • conversations: read live from Kimi's own session files, so the hub
//     follows Kimi wherever it runs — the terminal (TUI) or `kimi web`;
//   • actions: a whitelisted subset of Kimi's Server API (`kimi web`), or
//     keystrokes into a terminal Kimi started with `agent-hub-bridge.mjs kimi`.
// Kimi keeps running on this computer, with this computer's Kimi login.
// The hub's own models (DeepSeek through a gateway, Claude through the Claude
// API) are put into this computer's Kimi as custom providers, and Kimi's
// subagent model pool is kept up to date, so that a Kimi conversation can run
// on any of them and have subagents on any of them (kimi.hub.provision,
// kimi.hub.remove, kimi.subagents.sync). Kimi's login and global default
// model are never touched.
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
//
// Requires Node.js 22+ (built-in fetch and WebSocket). No dependencies. The
// `kimi` mode also needs python3 (for the pseudo-terminal) on macOS / Linux.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.9.0';
const SCRIPT = fileURLToPath(import.meta.url);

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const MODE = argv[0] === 'kimi' ? 'kimi' : 'bridge';
const flags = MODE === 'kimi' ? [] : argv;
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

const STATE_DIR = path.join(os.homedir(), '.agent-hub');
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}
const STATE = loadState();

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
    console.error('（找不到 python3，這個 Kimi 只能在終端機使用。要從中控台操作，請在 Kimi 裡輸入 /web）');
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
  hub.connect(MACHINE_ID);
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
        log('… 沒有執行中的 Kimi 伺服器：中控台仍看得到所有 Kimi 對話（包含終端機裡的），要從中控台送訊息，請在 Kimi 裡輸入 /web、執行 kimi web，或用「agent-hub-bridge.mjs kimi」啟動 Kimi');
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
  async request(method, p, body, { retried = false, internal = false } = {}) {
    // The server may have gone away (closed with the Kimi that ran /web):
    // start one in the background instead of failing.
    if (!this.instance || !(await this.healthy())) await this.start();
    await this.ready;
    if (!internal && !allowed(method, p)) throw new Error(`連接器拒絕了這個請求：${method} ${p.split('?')[0]}`);
    // A conversation running in a terminal must not be loaded by the server
    // too: two processes would write the same session.
    const sid = p.match(/^\/api\/v1\/sessions\/(session_[\w-]+)/)?.[1];
    if (sid && disk.owner(sid)?.kind === 'tui') return { code: 40999, msg: '這個對話可能正在終端機的 Kimi 裡執行', data: null };
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
        return this.request(method, p, body, { retried: true, internal });
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

  async launch() {
    if (await this.discover()) return this.instance;
    log('啟動 kimi web --no-open …');
    let failed = null;
    let exited = null;
    const child = spawn(KIMI_BIN, ['web', '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true, shell: IS_WIN, env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME } });
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

// ------------------------------------------------- hub models inside Kimi
// Every conversation the hub starts is an ordinary Kimi conversation. Models
// other than the subscription's come from custom Kimi providers the hub asks
// for here: `agent-hub-deepseek` (an OpenAI-compatible gateway serving
// DeepSeek) and `agent-hub-claude` (Anthropic's API, with a Claude Console
// API key). This is the only way the hub changes Kimi's providers: ALLOW
// above still refuses every provider path, so the hub cannot create,
// replace or delete just any provider through `kimi.request`.
//
// What it must never do is touch the Kimi subscription login: no logout, no
// change to the `managed:kimi-code` provider or to [thinking], and no change
// to Kimi's global default model. The last one is the dangerous one:
// creating a provider SEEDS default_model with the new provider's model when
// none is set (Kimi's createProvider). So before creating, an empty default
// is pinned to the subscription's own model, and afterwards the default is
// read again and put back if it moved.
//
// The second thing here is Kimi's subagent model pool ([secondary_model]),
// which is what makes Kimi's Agent / AgentSwarm tools take a `model`
// argument at all (see `pool` below).
const DS_MANAGED = 'managed:kimi-code';
const HUB_PREFIX = 'agent-hub-';
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
// Where Claude is: Anthropic's API, in the form Kimi's anthropic client takes
// (the SDK adds /v1/messages itself; a base_url ending in /v1 would double it).
const CLAUDE_BASE = 'https://api.anthropic.com';
// The tests point both at a local fake; nothing else can move them.
const loopback = (u) => (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(String(u || '')) ? String(u) : null);

const HUB_PROVIDERS = {
  deepseek: { id: 'agent-hub-deepseek', label: 'DeepSeek', type: 'openai' },
  claude: { id: 'agent-hub-claude', label: 'Claude', type: 'anthropic' },
};

// One change to Kimi's configuration at a time.
let configChain = Promise.resolve();
const configLock = (fn) => {
  const run = configChain.then(fn, fn);
  configChain = run.then(() => undefined, () => undefined);
  return run;
};

const hubProviders = {
  def(name) {
    if (!Object.hasOwn(HUB_PROVIDERS, name)) throw Object.assign(new Error(`不支援的模型來源：${String(name).slice(0, 40)}`), { status: 400 });
    return HUB_PROVIDERS[name];
  },

  // Everything the hub sent, checked and rebuilt field by field. Nothing
  // else is passed on to Kimi.
  clean(P, { gateway, apiKey, models } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    let base;
    if (P.type === 'anthropic') {
      base = loopback(process.env.AGENT_HUB_CLAUDE_TEST_URL) || CLAUDE_BASE;
      if (typeof apiKey !== 'string' || !/^sk-ant-(?!o[ar]t|admin)[\w-]{20,}$/i.test(apiKey) || apiKey.length > 500) throw bad('這不是 Claude Console 的 API key（應該是 sk-ant- 開頭的一長串，不能是訂閱帳號的 token）');
    } else {
      base = Object.hasOwn(DS_GATEWAYS, gateway) ? DS_GATEWAYS[gateway] : null;
      if (!base) throw bad(`不支援的閘道：${String(gateway).slice(0, 40)}`);
      const t = loopback(process.env.AGENT_HUB_DEEPSEEK_TEST_URL);
      if (t) base = `${t}/${gateway}/v1`;
      if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 500 || /\s/.test(apiKey)) throw bad('API key 不能是空的、超過 500 字，或含有空白與換行');
    }
    if (!Array.isArray(models) || models.length < 1 || models.length > 40) throw bad('模型清單要有 1 到 40 個模型');
    const seen = new Set();
    const out = models.map((m) => {
      const model = m?.model;
      // Letters, digits and . / : - _ (a gateway's own ids): no empty, "." or ".." parts.
      if (typeof model !== 'string' || !/^[\w.\/:-]{1,100}$/.test(model) || /(^|\/)\.{0,2}(\/|$)/.test(model)) throw bad(`模型名稱不合法：${String(model).slice(0, 40)}`);
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
      if (m.adaptive_thinking !== undefined) {
        if (typeof m.adaptive_thinking !== 'boolean') throw bad(`${model} 的 adaptive_thinking 不合法`);
        entry.adaptive_thinking = m.adaptive_thinking;
      }
      return entry;
    });
    return { base, key: apiKey, models: out };
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

  async snapshot() {
    const cfg = (await this.call('GET', '/api/v1/config')) || {};
    const providers = (await this.call('GET', '/api/v1/providers'))?.items || [];
    const items = (await this.call('GET', '/api/v1/models').catch(() => null))?.items || [];
    return {
      cfg,
      defaultModel: typeof cfg.default_model === 'string' ? cfg.default_model.trim() : '',
      // What must come out the same as it went in (apart from the default
      // model, which is put back if it moved). The pool is a thing of its
      // own (`pool` below): provider changes leave it alone, pool changes
      // leave out `fixedPool`.
      fixed: JSON.stringify([cfg.default_provider ?? null, cfg.thinking ?? null, cfg.secondary_model ?? null]),
      fixedPool: JSON.stringify([cfg.default_provider ?? null, cfg.thinking ?? null]),
      secondary: this.secondary(cfg),
      providers,
      models: items.map((m) => m.model),
      items,
    };
  },

  // [secondary_model]: the model Kimi may run subagents on (the pool in
  // resolveSubagentModelPool), if the computer's Kimi has one set.
  secondary(cfg) {
    const s = cfg?.secondary_model;
    if (!s || typeof s !== 'object') return undefined;
    const pick = (camel, snake) => s[camel] ?? s[snake];
    const models = Object.keys(pick('models', 'models') && typeof pick('models', 'models') === 'object' ? pick('models', 'models') : {});
    const model = pick('defaultModel', 'default_model') ?? pick('model', 'model') ?? models[0];
    return model ? { model: String(model), models, force: pick('force', 'force') === true } : undefined;
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

  // After any write: the default model and the rest are as they were.
  async check(before, expected, what = 'DeepSeek') {
    const now = await this.snapshot();
    if (now.defaultModel !== expected) {
      let restored = false;
      if (expected) {
        await this.pin(expected).catch(() => {});
        restored = (await this.snapshot()).defaultModel === expected;
      }
      throw new Error(`Kimi 的全域預設模型被改動了（${expected || '（沒有設定）'} → ${now.defaultModel || '（沒有設定）'}）。${restored ? '已還原成原來的模型' : '沒辦法還原，請在這台電腦的 Kimi 用 /model 選回你的模型'}。${what} 設定已中止。`);
    }
    if (now.fixed !== before.fixed) throw new Error(`Kimi 的 default_provider、[thinking] 或 [secondary_model] 在設定 ${what} 時被改動了，已中止。請檢查這台電腦的 Kimi 設定。`);
    return now;
  },

  // This computer's session id for the gateways, made once and kept.
  sessionId() {
    if (!/^ses_agenthub_[0-9a-f]{16}$/.test(STATE.dsSession || '')) {
      STATE.dsSession = `ses_agenthub_${crypto.randomBytes(8).toString('hex')}`;
      saveState(STATE);
    }
    return STATE.dsSession;
  },

  // config.toml split into its tables, minus the hub's own ([providers.
  // agent-hub-…] and their [models."agent-hub-…/…"], and with `pool` the
  // [secondary_model…] tables): what must come out the same after the hub
  // has written its part.
  others(text, { pool = false } = {}) {
    const tables = new Map();
    let head = '';
    for (const line of String(text).split('\n')) {
      const t = line.trim();
      if (/^\[.*\]$/.test(t)) head = t.replace(/\s+/g, '');
      if (/^\[(providers\.["']?agent-hub-|models\."?'?agent-hub-)/.test(head)) continue;
      if (pool && /^\[secondary_model(\.|\])/.test(head)) continue;
      if (t) tables.set(head, [...(tables.get(head) || []), t].sort());
    }
    // Kimi regroups the tables whenever it writes the file: order does not count.
    return JSON.stringify([...tables].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  },

  // Put the session header on the provider (custom_headers in its table in
  // config.toml). Kimi writes it itself, through its own config API (a merge
  // into [providers] that leaves the other providers alone, serialized with
  // Kimi's own writes, and picked up at once: no restart, and no hand edit
  // of the file). Then config.toml is read again: the hub's provider tables
  // are the only thing that may differ; if anything else does, the
  // file is put back as it was. Returns null, or why it could not be done.
  async sessionHeader(P, gateway) {
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
    fs.writeFileSync(backup, before, { mode: 0o600 });
    const value = this.sessionId();
    const restore = () => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, before, { mode: 0o600 });
      fs.renameSync(tmp, file);
    };
    try {
      await this.call('POST', '/api/v1/config', { providers: { [P.id]: { custom_headers: { [name]: value } } } });
      // Kimi writes the file just before it answers.
      const after = fs.readFileSync(file, 'utf8');
      const has = new RegExp(`\\[providers\\.${P.id}\\.custom_headers\\][^\\[]*${name}\\s*=\\s*"${value}"|custom_headers\\s*=\\s*\\{[^}]*${name}\\s*=\\s*"${value}"`).test(after);
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

  provision(args = {}) {
    return configLock(() => this.doProvision(args));
  },

  async doProvision(args) {
    const P = this.def(args.provider || 'deepseek');
    const { base, key, models } = this.clean(P, args);
    const before = await this.snapshot();
    const had = before.providers.some((p) => p.id === P.id);
    let expected = before.defaultModel;
    // Creating a provider would make it Kimi's default when there is none:
    // pin the subscription's model first, or do not create at all.
    if (!had && !expected) {
      expected = this.subscriptionModel(before);
      if (!expected) throw new Error(`這台電腦的 Kimi 沒有設定預設模型，也找不到訂閱帳號的模型。為了不讓 ${P.label} 變成 Kimi 的預設模型，沒有建立。請先在那台電腦執行 kimi login。`);
      await this.pin(expected);
    }
    // Never `default_model` in the body: that is Kimi's own pointer.
    const body = { type: P.type, api_key: key, base_url: base, models };
    let failure = null;
    try {
      if (had) await this.call('PUT', `/api/v1/providers/${P.id}`, body, key);
      else await this.call('POST', '/api/v1/providers', { id: P.id, ...body }, key);
    } catch (err) {
      failure = err;
    }
    const after = await this.check(before, expected, P.label);
    if (failure) throw failure;
    // The session header, which a gateway may want (see DS_SESSION_HEADERS).
    // Without it the provider still works; the hub is told it is missing.
    let noHeader = null;
    let last = after;
    if (P.type === 'openai') {
      noHeader = await this.sessionHeader(P, args.gateway);
      last = await this.check(after, expected, P.label);
    }
    return {
      ok: true,
      created: !had,
      models: models.map((m) => `${P.id}/${m.model}`),
      ...(P.type === 'openai' ? { sessionHeader: !noHeader } : {}),
      ...(noHeader ? { warning: noHeader } : {}),
      ...(last.secondary ? { secondaryModel: last.secondary } : {}),
    };
  },

  remove(name = 'deepseek') {
    return configLock(() => this.doRemove(name));
  },

  async doRemove(name) {
    const P = this.def(name);
    const before = await this.snapshot();
    if (!before.providers.some((p) => p.id === P.id)) return { ok: true, removed: false };
    // Deleting would leave Kimi's default pointing at a model that is gone.
    if (before.defaultModel.startsWith(`${P.id}/`)) throw new Error(`Kimi 的全域預設模型是 ${P.label} 模型：先在那台電腦的 Kimi 用 /model 換回你的模型，再移除。`);
    // Its models leave the subagent pool first: a pool entry that names a
    // model Kimi no longer has is a broken pool.
    const dropped = await pool.doDropPrefix(`${P.id}/`);
    const mid = await this.snapshot();
    await this.call('DELETE', `/api/v1/providers/${P.id}`);
    await this.check(mid, before.defaultModel, P.label);
    return { ok: true, removed: true, ...(dropped.removed?.length ? { poolRemoved: dropped.removed } : {}) };
  },
};

// ------------------------------------------------- the subagent model pool
// Kimi's Agent and AgentSwarm tools have a `model` argument only when the
// computer's Kimi has a subagent model pool: [secondary_model] with a
// `models` table (alias → description the main model reads) and a
// `default_model` (resolveSubagentModelPool, exposesSubagentModelChoice,
// Kimi 2.1.1). Without a pool every subagent silently runs on the main
// model, whatever the main model was told. The pool also decides which model
// an Agent call that names none gets: the pool's default.
//
// The hub keeps this pool up to date: the Kimi subscription's models and
// every model of the hub's providers, with the pool's default_model = Kimi's
// own default model (the subscription's), so a terminal Kimi behaves as
// before apart from being able to pick. Never `force` (it would take the
// choice away). A pool the user wrote is kept: their entries and their
// default stay, the hub's are added, and the aliases the hub added are
// remembered here (STATE.pools) so taking them away takes away only those.
//
// Kimi's REST config only merges (a null cannot delete a key of a table), so
// additions go through it (serialized with Kimi's own writes, validated by
// Kimi), and removals are made in config.toml itself, in the two small
// tables of the pool and nothing else; Kimi's file watcher picks that up.
// Either way config.toml is checked afterwards, and put back as it was if
// anything outside the pool (and the hub's providers) differs.
const POOL_ALIAS = /^[\w.\/:@+-]{1,160}$/;

// Kimi's rule for a pool-wide [secondary_model].default_effort
// (assertValidSubagentDefaultEffort): every model in the pool has to take
// it, or the pool is turned down. `item` is the model as Kimi lists it.
function takesDefaultEffort(item, effort) {
  const caps = item?.capabilities || [];
  if (effort === 'off') return !caps.includes('always_thinking');
  if (!caps.includes('thinking') && !caps.includes('always_thinking') && !item?.adaptive_thinking) return false;
  const levels = item?.support_efforts || [];
  return levels.length === 0 || effort === 'on' || levels.includes(effort);
}

// The key of a `"alias" = "…"` / `alias = "…"` line of a TOML table.
function tomlKey(line) {
  const m = line.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=/);
  if (!m) return null;
  if (m[1] !== undefined) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return null;
    }
  }
  return m[2] !== undefined ? m[2] : m[3];
}

// config.toml with `remove` taken out of [secondary_model.models] (and the
// default_model line of [secondary_model] with `dropDefault`), and the
// tables themselves when nothing is left in them. Throws when the pool is
// written in a way this does not understand (inline tables, dotted keys):
// nothing is guessed.
function editPoolTables(text, { remove = [], dropDefault = false } = {}) {
  const gone = new Set(remove);
  const lines = String(text).split('\n');
  const out = [];
  let table = null;
  const cannot = (what) => Object.assign(new Error(`這台電腦的 Kimi 設定檔把 [secondary_model] 寫成這個中控台看不懂的形式（${what}），沒辦法自動移除子代理模型。請在 config.toml 自己整理 [secondary_model]。`), { status: 409 });
  for (const line of lines) {
    const t = line.trim();
    if (/^\[.*\]/.test(t)) {
      const head = t.replace(/\s+/g, '').replace(/#.*$/, '');
      table = head === '[secondary_model]' ? 'section' : head === '[secondary_model.models]' ? 'models' : /^\[\[?secondary_model/.test(head) ? 'other' : null;
      out.push(line);
      continue;
    }
    if (table === 'models' && t && !t.startsWith('#')) {
      const key = tomlKey(line);
      if (key === null) throw cannot('一行看不懂');
      if (gone.has(key)) continue;
    } else if (table === 'section' && t && !t.startsWith('#')) {
      if (/^\s*models\s*[.=]/.test(line) && gone.size) throw cannot('models 寫成內嵌表格或點號鍵');
      if (dropDefault && tomlKey(line) === 'default_model') continue;
    } else if (table === 'other' && gone.size) throw cannot('[secondary_model] 底下還有別的表格');
    out.push(line);
  }
  // Tables with nothing left: the header goes too (the inner table first,
  // so the outer one can be seen to be empty).
  let cur = out;
  for (let round = 0; round < 3; round++) {
    const result = [];
    let gap = false; // a table was taken out here: keep one blank line between its neighbours
    for (let i = 0; i < cur.length; i++) {
      const head = cur[i].trim().replace(/\s+/g, '');
      if (head === '[secondary_model]' || head === '[secondary_model.models]') {
        let j = i + 1;
        let empty = true;
        for (; j < cur.length && !/^\s*\[/.test(cur[j]); j++) if (cur[j].trim() && !cur[j].trim().startsWith('#')) empty = false;
        const nested = head === '[secondary_model]' && cur.slice(j).some((l) => /^\s*\[secondary_model\./.test(l.replace(/\s+/g, '')));
        if (empty && !nested) {
          i = j - 1;
          while (result.length && !result.at(-1).trim()) result.pop();
          gap = result.length > 0;
          continue;
        }
      }
      if (gap && cur[i].trim()) result.push('');
      if (cur[i].trim()) gap = false;
      result.push(cur[i]);
    }
    if (result.length === cur.length) break;
    cur = result;
  }
  return cur.join('\n');
}

const pool = {
  file: () => path.join(KIMI_HOME, 'config.toml'),

  // What the hub put in this computer's pool (kept per Kimi home).
  state() {
    STATE.pools ??= {};
    const st = (STATE.pools[KIMI_HOME] ??= {});
    st.owned = Array.isArray(st.owned) ? st.owned.filter((a) => typeof a === 'string') : [];
    return st;
  },

  clean({ models, efforts } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!models || typeof models !== 'object' || Array.isArray(models)) throw bad('子代理模型要是 { 別名: 說明 } 的物件');
    const entries = Object.entries(models);
    if (entries.length > 60) throw bad('子代理模型最多 60 個');
    const outModels = {};
    for (const [alias, desc] of entries) {
      if (!POOL_ALIAS.test(alias) || alias === 'primary') throw bad(`子代理模型的別名不合法：${alias.slice(0, 40)}`);
      if (typeof desc !== 'string' || !/^[^\x00-\x1f\x7f]{0,400}$/.test(desc)) throw bad(`${alias} 的說明不合法（單行，最多 400 字）`);
      outModels[alias] = desc;
    }
    const outEfforts = {};
    // Subagent thinking is the hub's to set for its own models only (the
    // subscription's models, and the user's, are Kimi's and theirs); a model
    // of another kind in the list is passed over.
    for (const [alias, effort] of Object.entries(efforts && typeof efforts === 'object' ? efforts : {})) {
      if (!POOL_ALIAS.test(alias) || /(^|\/)\.{1,2}(\/|$)/.test(alias)) throw bad(`子代理思考強度的模型別名不合法：${alias.slice(0, 40)}`);
      if (!DS_EFFORTS.includes(effort)) throw bad(`${alias} 的思考強度不合法：${String(effort).slice(0, 20)}`);
      if (alias.startsWith(HUB_PREFIX)) outEfforts[alias] = effort;
    }
    return { models: outModels, efforts: outEfforts };
  },

  // The pool in Kimi's GET /config answer (camelCase; the v1 snake_case
  // spellings too).
  read(cfg) {
    const s = cfg?.secondary_model && typeof cfg.secondary_model === 'object' ? cfg.secondary_model : {};
    const pick = (camel, snake) => s[camel] ?? s[snake];
    const models = pick('models', 'models');
    return {
      exists: Object.keys(s).length > 0,
      force: pick('force', 'force') === true,
      models: models && typeof models === 'object' && !Array.isArray(models) ? { ...models } : {},
      hasModels: models !== undefined && models !== null,
      defaultModel: pick('defaultModel', 'default_model') ?? undefined,
      legacyModel: pick('model', 'model') ?? undefined,
      defaultEffort: pick('defaultEffort', 'default_effort') ?? undefined,
    };
  },

  // {models: {}} takes the hub's entries out of the pool, and what the hub
  // wrote around them (a pool the hub made is removed whole; a pool the
  // user made keeps its entries and its default).
  sync(args) {
    const want = this.clean(args);
    return configLock(() => this.apply({ ...want, dropAll: !Object.keys(want.models).length }));
  },

  // A provider is going away: its models leave the pool (inside configLock
  // already).
  async doDropPrefix(prefix) {
    const st = this.state();
    if (!st.owned.some((a) => a.startsWith(prefix))) return { removed: [] };
    const snap = await hubProviders.snapshot();
    const cur = this.read(snap.cfg);
    const keep = Object.fromEntries(st.owned.filter((a) => !a.startsWith(prefix) && a in cur.models).map((a) => [a, cur.models[a]]));
    const r = await this.apply({ models: keep, efforts: {} });
    return { removed: r.removed || [] };
  },

  async apply({ models: hubWant, efforts = {}, dropAll = false }) {
    const file = this.file();
    let before;
    try {
      before = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error('找不到這台電腦 Kimi 的 config.toml，沒辦法設定子代理模型');
    }
    const snap = await hubProviders.snapshot();
    const cur = this.read(snap.cfg);
    // `force` pins every subagent to one model and cannot be combined with a
    // pool: the user chose that, the hub leaves it.
    if (cur.force) return { ok: true, skipped: 'force', pool: null, merged: false, warning: '這台電腦的 Kimi 設了 [secondary_model] force（所有子代理固定用同一個模型），中控台沒有動它，子代理不能選模型' };
    const st = this.state();
    const owned = new Set(st.owned);
    const catalog = new Set(snap.models);
    const describe = (alias) => snap.items.find((m) => m.model === alias)?.display_name || '';

    // What the user has there: everything not put there by the hub. A pool
    // written the old way (one `model` / default_model, no table) is one
    // entry of theirs.
    const user = {};
    for (const [a, d] of Object.entries(cur.models)) if (!owned.has(a)) user[a] = typeof d === 'string' ? d : '';
    const legacy = !cur.hasModels ? cur.defaultModel ?? cur.legacyModel : undefined;
    if (legacy) user[legacy] = '';

    // The hub's entries: only models Kimi has (a pool entry that names a
    // model Kimi cannot resolve is a broken pool).
    const hub = {};
    const skipped = [];
    // A pool-wide default effort the user set has to suit every model in the
    // pool: the models that do not take it are not added.
    const poolEffort = cur.defaultEffort;
    const unfit = [];
    if (!dropAll) {
      for (const [a, d] of Object.entries(hubWant)) {
        if (a in user) continue;
        if (!catalog.has(a)) skipped.push(a);
        else if (poolEffort !== undefined && !takesDefaultEffort(snap.items.find((m) => m.model === a), poolEffort)) unfit.push(a);
        else hub[a] = d;
      }
    }

    // The default: the user's own stays; otherwise Kimi's global default
    // model (the subscription's), which has to be in the pool.
    const hubWroteDefault = Boolean(st.defaultWritten) && cur.defaultModel === st.defaultWritten;
    const userDefault = cur.defaultModel !== undefined && !hubWroteDefault ? cur.defaultModel : legacy;
    let def = userDefault;
    if (def === undefined && !dropAll) def = snap.defaultModel || hubProviders.subscriptionModel(snap) || Object.keys(user)[0] || undefined;
    if (def !== undefined && !(def in user) && !(def in hub) && !dropAll) {
      if (!catalog.has(def)) throw new Error(`Kimi 的預設模型「${def}」不在 Kimi 的模型清單裡，沒辦法放進子代理模型。`);
      hub[def] = hubWant[def] ?? describe(def);
    }
    // Nothing left to offer (no model of the hub's, none of the user's, no
    // default to anchor on): the hub's part of the pool goes whole.
    if (!dropAll && !Object.keys({ ...user, ...hub }).length) {
      dropAll = true;
      def = undefined;
    }

    const desired = { ...user, ...hub };
    const newOwned = Object.keys(hub);
    const remove = [...owned].filter((a) => !newOwned.includes(a) && a in cur.models);
    const add = Object.fromEntries(Object.entries(desired).filter(([a, d]) => cur.models[a] !== d));
    // A pool written the old way (one `model`) gets a table the first time:
    // its model is listed, and is the default.
    const defaultChange = !dropAll && def !== undefined && def !== cur.defaultModel;
    const dropDefault = dropAll && hubWroteDefault && !Object.keys(user).length;
    const err = this.validate(desired, def);
    if (err) throw new Error(err);

    // Subagents' thinking, model by model: a hub model's default_effort
    // (the pool cannot carry one per model, and a subagent without it
    // thinks at the middle of the model's levels, not at the level the
    // hub's conversations use).
    const effortWrites = {};
    if (!dropAll) {
      for (const [a, e] of Object.entries(efforts)) {
        const item = snap.items.find((m) => m.model === a);
        if (!item || !(item.support_efforts || []).includes(e) || item.default_effort === e) continue;
        effortWrites[a] = e;
      }
    }
    const nothing = !remove.length && !Object.keys(add).length && !defaultChange && !dropDefault && !Object.keys(effortWrites).length;
    st.owned = [...newOwned];
    if (nothing) {
      this.remember(st, { hubWroteDefault: hubWroteDefault && !dropDefault, def: hubWroteDefault ? cur.defaultModel : undefined });
      return this.result({ desired, def, user, skipped, unfit, remove: [], add: {}, effortWrites: {}, unchanged: true });
    }

    const backup = path.join(STATE_DIR, 'config.toml.before-pool');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(backup, before, { mode: 0o600 });
    const restore = async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, before, { mode: 0o600 });
      fs.renameSync(tmp, file);
      // Kimi reads its file again: wait until it shows what it showed.
      const was = JSON.stringify(Object.keys(cur.models).sort());
      for (let i = 0; i < 30; i++) {
        const now = this.read((await hubProviders.call('GET', '/api/v1/config').catch(() => ({}))) || {});
        if (JSON.stringify(Object.keys(now.models).sort()) === was) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const prev = { owned: [...owned], defaultWritten: st.defaultWritten };
    try {
      // 1. Removals: in the file, then wait for Kimi to read it again (a
      //    REST write made before that would write the old table back).
      if (remove.length || dropDefault) {
        const edited = editPoolTables(before, { remove, dropDefault });
        if (edited !== before) {
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, edited, { mode: 0o600 });
          fs.renameSync(tmp, file);
          let seen = false;
          for (let i = 0; i < 40 && !seen; i++) {
            const now = this.read((await hubProviders.call('GET', '/api/v1/config')) || {});
            seen = remove.every((a) => !(a in now.models)) && (!dropDefault || now.defaultModel === undefined);
            if (!seen) await new Promise((r) => setTimeout(r, 200));
          }
          if (!seen) throw new Error('Kimi 沒有重新讀取 config.toml（可能關掉了設定檔監看），沒辦法移除子代理模型');
        }
      }
      // 2. Additions and the default: through Kimi.
      const patch = {};
      if (Object.keys(add).length) patch.models = add;
      if (defaultChange) patch.default_model = def;
      if (Object.keys(patch).length) await hubProviders.call('POST', '/api/v1/config', { secondary_model: patch });
      // 3. Subagent thinking of the hub's models.
      if (Object.keys(effortWrites).length) await hubProviders.call('POST', '/api/v1/config', { models: Object.fromEntries(Object.entries(effortWrites).map(([a, e]) => [a, { default_effort: e }])) });
      // 4. What is there now is what was meant, and nothing else moved.
      const after = fs.readFileSync(file, 'utf8');
      if (hubProviders.others(after, { pool: true }) !== hubProviders.others(before, { pool: true })) throw new Error('Kimi 的 config.toml 在設定子代理模型時出現了預期以外的變動');
      const snap2 = await hubProviders.snapshot();
      const now = this.read(snap2.cfg);
      if (snap2.defaultModel !== snap.defaultModel || snap2.fixedPool !== snap.fixedPool) throw new Error('Kimi 的全域預設模型、default_provider 或 [thinking] 在設定子代理模型時被改動了');
      if (!dropAll) {
        for (const a of Object.keys(desired)) if (!(a in now.models)) throw new Error(`Kimi 沒有收下子代理模型「${a}」`);
        if (def !== undefined && now.defaultModel !== def) throw new Error(`Kimi 的子代理預設模型不是預期的「${def}」`);
        if (now.force) throw new Error('子代理模型被設成 force，會讓 Kimi 的子代理不能選模型');
        const bad = this.validate(now.models, now.defaultModel);
        if (bad) throw new Error(bad);
      }
      for (const a of remove) if (a in now.models) throw new Error(`子代理模型「${a}」沒有移除`);
    } catch (e) {
      // Whatever went wrong, config.toml is as it was.
      st.owned = prev.owned;
      st.defaultWritten = prev.defaultWritten;
      await restore().catch(() => {});
      fs.rmSync(backup, { force: true });
      throw Object.assign(new Error(`子代理模型沒有設定，已還原：${e.message}`), { status: e.status });
    }
    fs.rmSync(backup, { force: true });
    this.remember(st, { hubWroteDefault: !dropAll && (hubWroteDefault || (userDefault === undefined && def !== undefined)), def });
    return this.result({ desired, def, user, skipped, unfit, remove, add, effortWrites });
  },

  // The answer to the hub: the pool as it is now.
  result({ desired, def, user, skipped, unfit = [], remove, add, effortWrites, unchanged = false }) {
    const warning = [skipped.length ? `Kimi 沒有這些模型，沒有放進子代理模型：${skipped.join('、')}` : '', unfit.length ? `這台電腦的 Kimi 設了 [secondary_model].default_effort，這些模型不支援那個思考強度，沒有放進子代理模型：${unfit.join('、')}` : ''].filter(Boolean).join('；') || undefined;
    return {
      ok: true,
      pool: Object.keys(desired).length ? { defaultModel: def, models: Object.keys(desired) } : null,
      merged: Object.keys(user).length > 0,
      efforts: effortWrites,
      ...(unchanged ? { unchanged: true } : {}),
      added: Object.keys(add),
      removed: remove,
      ...(warning ? { warning } : {}),
    };
  },

  remember(st, { hubWroteDefault, def }) {
    st.defaultWritten = hubWroteDefault ? def : undefined;
    saveState(STATE);
  },

  // Kimi's own rules for a pool (assertValidSubagentModelPool), so a pool it
  // would turn away is not written.
  validate(models, def) {
    if (!Object.keys(models).length) return null;
    if (Object.hasOwn(models, 'primary')) return '子代理模型的別名不能叫 primary（Kimi 保留給「跟主模型一樣」）';
    if (def === undefined) return 'Kimi 的子代理模型一定要有預設模型（default_model）';
    if (!Object.hasOwn(models, def)) return `子代理預設模型「${def}」不在子代理模型的清單裡`;
    return null;
  },
};

// The old name: DeepSeek was the first of the hub's providers.
const deepseek = {
  provision: (args) => hubProviders.provision({ ...args, provider: 'deepseek' }),
  remove: () => hubProviders.remove('deepseek'),
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
      controllable: o?.kind === 'tui' ? Boolean(tui.byPid.get(o.pid)) : null,
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
  // its folder it wrote since it started is surely it, and only that one is
  // the terminal's (the hub then types into that Kimi). Another conversation
  // in the same folder might be open there too (with /resume or -c, not
  // written yet), but that is a guess, and a guess is not a reason to lock a
  // conversation: it is driven through the Kimi server like any other, and
  // if both sides do write to it, they conflict, as they would anyway.
  owner(id) {
    const pid = this.best.get(id);
    return pid ? { kind: 'tui', pid, exact: true } : null;
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
    return o?.kind === 'tui' ? this.byPid.get(o.pid) || null : null;
  },

  async input(sid, args) {
    const { action, text = '', decision, feedback, index, confirm } = args;
    const o = disk.owner(sid);
    const c = this.controller(sid);
    if (!o) throw new Error('這個對話沒有在終端機裡執行');
    if (!c) throw new Error('這個對話正在終端機的 Kimi 裡執行，但那個 Kimi 不是用 kimi-hub 啟動的，所以中控台只能看、不能操作。在那個 Kimi 裡輸入 /web 交給中控台，或之後改用 kimi-hub 啟動 Kimi。');
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

function listenLocal() {
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(SOCK);
    } catch {}
  }
  const srv = net.createServer((sock) => {
    let buf = '';
    let pid = null;
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
      fs.writeFileSync(file, text);
      log(done);
    } catch (err) {
      log(`… 沒辦法安裝 ${dir} skill：${err.message}`);
    }
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
      const collect = (chunk) => {
        const t = chunk.toString();
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

const daemon = {
  file: path.join(STATE_DIR, 'claude-daemon.mjs'),
  dir: path.join(STATE_DIR, 'claude'),
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

  async launch(version) {
    const h = await this.health();
    if (h && this.current(h, version)) return h;
    if (h) {
      // Stopping it would stop the conversations running in it: the old code
      // serves until they are done (a later call updates it).
      if (h.running?.length) return h;
      log('更新 Claude 背景程式 …');
      try {
        process.kill(h.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 25 && server.alive(h.pid); i++) await sleep(200);
      // Two daemons on the same folder would both write its conversations.
      if (server.alive(h.pid)) {
        log('… 舊的 Claude 背景程式沒有結束，先繼續用它');
        return h;
      }
    }
    if (!fs.existsSync(this.file) || (version && this.versionOf(this.file) !== version)) await this.download();
    const started = await this.spawn();
    if (version && started.version !== version) this.settled.set(version, started.version);
    return started;
  },

  async download() {
    log('從中控台下載 Claude 背景程式 …');
    const res = await fetch(`${HUB}/bridge/claude-daemon.mjs`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`無法從中控台下載 Claude 背景程式（HTTP ${res.status}）`);
    const body = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Written whole, then swapped in: a daemon starting meanwhile never runs half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.file);
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

// ------------------------------------------------------------- the hub

const hub = {
  ws: null,
  backoff: 1000,
  sent: new Map(), // session id -> last summary sent
  machineId: null,

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
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
      // The hub's model providers inside this computer's Kimi (DeepSeek,
      // Claude: see `hubProviders` above), and Kimi's subagent model pool.
      case 'kimi.hub.provision':
        return hubProviders.provision(args);
      case 'kimi.hub.remove':
        return hubProviders.remove(String(args.provider || ''));
      case 'kimi.subagents.sync':
        return pool.sync(args);
      // The first of them, under its old names (hubs before 0.9).
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
      if (process.platform !== 'win32') log(`  想從中控台操作終端機裡的 Kimi：用「node ${path.join(STATE_DIR, 'agent-hub-bridge.mjs')} kimi」啟動 Kimi（可以設成 alias kimi-hub）`);
      this.send({
        t: 'hello',
        machineId,
        name: NAME,
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        bridgeVersion: VERSION,
        node: process.version,
        home: os.homedir(),
        status: await this.status(),
        claudeSessions: daemon.count(),
      });
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
      if (m.t === 'req') {
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

// ------------------------------------------------------------------ main

if (MODE === 'kimi') await runKimi(argv.slice(1));
else await runBridge();
