#!/usr/bin/env node
// Agent Hub bridge — runs on every computer whose Kimi Code you want to use
// from the hub. It connects *out* to the hub (no open ports, works behind
// NAT) and relays:
//   • conversations: read live from Kimi's own session files, so the hub
//     follows Kimi wherever it runs — the terminal (TUI) or `kimi web`;
//   • actions: a whitelisted subset of Kimi's Server API (`kimi web`), or
//     keystrokes into a terminal Kimi started with `agent-hub-bridge.mjs kimi`.
// Kimi keeps running on this computer, with this computer's Kimi login.
//
//   node agent-hub-bridge.mjs --hub https://your-hub.example.com --key <bridge key>
//   node agent-hub-bridge.mjs kimi [Kimi options]    # Kimi in this terminal, controllable from the hub
//
// Options:
//   --name <name>        Computer name shown in the hub (default: hostname)
//   --start-kimi         Start `kimi web --no-open` if no Kimi server is running
//   --kimi-bin <path>    Kimi Code CLI executable (default: kimi)
//   --kimi-home <dir>    Kimi data directory (default: $KIMI_CODE_HOME or ~/.kimi-code)
//   --no-skill           Do not install the /artifact skill into Kimi
//
// Requires Node.js 22+ (built-in fetch and WebSocket). No dependencies. The
// `kimi` mode also needs python3 (for the pseudo-terminal) on macOS / Linux.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.0';
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
    const c = spawn(KIMI_BIN, args, { stdio: 'inherit', env });
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
    STATE.kimiVersion = execFileSync(KIMI_BIN, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).match(/\d+\.\d+\.\d+/)?.[0] || STATE.kimiVersion;
  } catch {
    log(`… 找不到 Kimi Code（${KIMI_BIN}）。安裝：npm i -g @moonshot-ai/kimi-code`);
  }
  installSkill();
  listenLocal();
  if (START_KIMI) await server.start().catch((err) => log(`✗ ${err.message}`));
  else await server.discover();
  disk.scan();
  hub.connect(MACHINE_ID);

  setInterval(() => hub.send({ t: 'ping' }), 25_000);
  setInterval(() => !server.instance && server.discover(), 4000);
  setInterval(() => disk.scan(), 2000);
  setInterval(() => disk.poll(), 150);
  setInterval(() => procs.scan(), 2000);
  setInterval(() => hub.pushSessions(true), 30_000);
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
  ['GET', /^\/api\/v1\/fs:(browse|home)(\?.*)?$/],
  ['GET', /^\/api\/v1\/sessions(\?.*)?$/],
  ['GET', /^\/api\/v1\/workspaces\/[\w.-]+\/skills$/],
  ['POST', /^\/api\/v1\/sessions$/],
  ['GET', /^\/api\/v1\/sessions\/session_[\w-]+(\/[\w./:-]*)?(\?.*)?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+(:(abort|compact|fork|undo|btw|archive))?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/(prompts|prompts:steer|prompts\/[\w-]+:(abort|steer)|approvals\/[\w-]+|questions\/[\w-]+(:dismiss)?|profile|skills\/[\w.%-]+:activate)$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/fs:(list|read|stat|git_status|diff|search|grep)$/],
];
const allowed = (method, p) => ALLOW.some(([m, re]) => m === method && re.test(p));

const server = {
  instance: null,
  token: null,
  ws: null,
  subs: new Set(),
  version: null,
  seen: new Map(), // session id -> last time the server reported activity for it
  busy: new Set(), // sessions the server says are busy

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

  base() {
    return `http://${this.instance.host}:${this.instance.port}`;
  },

  async request(method, p, body) {
    if (!this.instance) throw new Error('這台電腦沒有執行中的 Kimi 伺服器。在 Kimi 裡輸入 /web，或執行 kimi web');
    if (!allowed(method, p)) throw new Error(`連接器拒絕了這個請求：${method} ${p.split('?')[0]}`);
    // A conversation running in a terminal must not be loaded by the server
    // too: two processes would write the same session.
    const sid = p.match(/^\/api\/v1\/sessions\/(session_[\w-]+)/)?.[1];
    if (sid && disk.owner(sid)?.kind === 'tui') return { code: 40999, msg: '這個對話正在終端機的 Kimi 裡執行', data: null };
    if (sid && method === 'POST' && /\/prompts$/.test(p)) this.seen.set(sid, Date.now());
    const res = await fetch(this.base() + p, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { code: res.status === 200 ? 0 : res.status, msg: text.slice(0, 300), data: null };
    }
  },

  connect() {
    if (!this.instance) return;
    const ws = new WebSocket(`ws://${this.instance.host}:${this.instance.port}/api/v1/ws`, [`kimi-code.bearer.${this.token}`]);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'client_hello', id: 'hello', payload: { client_id: `agent-hub-bridge-${HOME_TAG}` } }));
      if (this.subs.size) ws.send(JSON.stringify({ type: 'subscribe', id: 'resub', payload: { session_ids: [...this.subs] } }));
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', payload: m.payload }));
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
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), payload: { session_ids: ids } }));
  },

  unsubscribe(ids) {
    for (const id of ids) this.subs.delete(id);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'unsubscribe', id: crypto.randomUUID(), payload: { session_ids: ids } }));
  },

  async start() {
    if (await this.discover()) return this.instance;
    log('啟動 kimi web --no-open …');
    const child = spawn(KIMI_BIN, ['web', '--no-open'], { detached: true, stdio: 'ignore', env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME } });
    child.on('error', (err) => log(`✗ 無法啟動 Kimi：${err.code === 'ENOENT' ? `找不到指令 ${KIMI_BIN}` : err.message}`));
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.discover()) return this.instance;
    }
    throw new Error('Kimi 伺服器沒有在 20 秒內啟動');
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
      if (e.type === 'step.end') return [f('turn.step.completed', { turnId, usage: e.usage })];
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
      return a === 'main' ? [f('agent.status.updated', { model: rec.modelAlias, thinkingEffort: rec.thinkingEffort })] : [];
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
      if (agent === 'main') for (const line of Wire.slice(w.file, 0, Math.min(size, 96 * 1024)).lines) this.apply(tag(record(line)));
      const { lines } = Wire.slice(w.file, Math.max(0, size - 512 * 1024), size);
      for (const line of lines) this.apply(tag(record(line)));
      w.offset = size;
    }
    this.readState();
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
  owners: new Map(), // session id -> { kind: 'tui', pid }
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

  owner(id) {
    return this.owners.get(id) || null;
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
  scan() {
    let list = [];
    try {
      if (process.platform === 'linux') list = this.linux();
      else if (process.platform === 'darwin') list = this.mac();
    } catch {}
    const servers = new Set();
    try {
      for (const f of fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances'))) {
        try {
          servers.add(JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8')).pid);
        } catch {}
      }
    } catch {}
    const tuis = list.filter((p) => !servers.has(p.pid) && p.pid !== process.pid);
    const owners = new Map();
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    for (const p of tuis) {
      let best = null;
      for (const s of disk.sessions.values()) {
        const cwd = s.state?.cwd;
        if (!cwd || real(cwd) !== p.cwd) continue;
        if (s.mtime < p.started - 2000) continue;
        if (!best || s.mtime > best.mtime) best = s;
      }
      if (best) owners.set(best.id, { kind: 'tui', pid: p.pid });
    }
    const key = JSON.stringify([...owners]);
    if (key !== this.last) {
      const changed = new Set([...owners.keys(), ...disk.owners.keys()]);
      disk.owners = owners;
      this.last = key;
      for (const id of changed) {
        const s = disk.sessions.get(id);
        if (s) hub.pushSession(s, true);
      }
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
      if (m && /^kimi-code\b|\/kimi(\s|$)/.test(m[3])) found.push({ pid: Number(m[1]), started: Date.parse(m[2]) });
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
            for (const [sid, o] of disk.owners) if (o.pid === pid) hub.pushSession(disk.sessions.get(sid), true);
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

function installSkill() {
  if (!INSTALL_SKILL) return;
  const file = path.join(KIMI_HOME, 'skills', 'agent-hub-artifact', 'SKILL.md');
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur === ARTIFACT_SKILL) return;
    if (cur && !cur.includes(SKILL_MARK)) return; // not ours: leave it alone
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ARTIFACT_SKILL);
    log('✓ 已把 /artifact skill 加進 Kimi（Kimi 寫的 HTML 頁面會顯示在中控台）');
  } catch (err) {
    log(`… 沒辦法安裝 /artifact skill：${err.message}`);
  }
}

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
      case 'kimi.tui.input':
        return tui.input(String(args.sessionId || ''), args);
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
        platform: `${os.platform()} ${os.arch()}`,
        bridgeVersion: VERSION,
        node: process.version,
        home: os.homedir(),
        status: await this.status(),
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
          this.send({ t: 'res', id: m.id, ok: false, error: err.message });
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
