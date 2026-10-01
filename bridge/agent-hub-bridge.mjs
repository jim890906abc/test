#!/usr/bin/env node
// Agent Hub bridge — run this on every machine whose Kimi Code sessions you
// want to control from the hub. It connects *out* to the hub (no open ports,
// works behind NAT), finds the local Kimi Code server (`kimi web`, or a
// session handed off with `/web` inside Kimi), and relays:
//   hub → bridge : a whitelisted subset of Kimi's Server API (sessions,
//                  prompts, approvals, questions, session files)
//   bridge → hub : Kimi's live WebSocket events and the session list
// Kimi keeps running on this machine with this machine's Kimi login.
//
//   node agent-hub-bridge.mjs --hub https://your-hub.example.com --key <bridge key>
//
// Options:
//   --name <name>        Machine name shown in the hub (default: hostname)
//   --start-kimi         Start `kimi web --no-open` if no Kimi server is running
//   --kimi-bin <path>    Kimi Code CLI executable (default: kimi)
//   --kimi-home <dir>    Kimi data directory (default: $KIMI_CODE_HOME or ~/.kimi-code)
//
// Requires Node.js 22+ (built-in fetch and WebSocket). No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const VERSION = '0.2.0';

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const HUB = String(opt('hub', process.env.AGENT_HUB_URL || '')).replace(/\/+$/, '');
const KEY = String(opt('key', process.env.AGENT_HUB_BRIDGE_KEY || ''));
const NAME = String(opt('name', os.hostname()));
const START_KIMI = Boolean(opt('start-kimi', false));
const KIMI_BIN = String(opt('kimi-bin', 'kimi'));
const KIMI_HOME = path.resolve(String(opt('kimi-home', process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'))));
const WORKSPACES = path.join(os.homedir(), 'agent-hub-workspaces');

if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error('需要 Node.js 22 以上版本（內建 WebSocket）。目前版本：' + process.version);
  process.exit(1);
}
if (!HUB || !KEY || HUB === 'true' || KEY === 'true') {
  console.error('用法：node agent-hub-bridge.mjs --hub https://你的中控台網址 --key 連接金鑰');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// A stable id per machine (and per Kimi home), kept across restarts.
const STATE_FILE = path.join(os.homedir(), '.agent-hub', 'bridge.json');
function machineId() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  state.ids ??= {};
  if (!state.ids[KIMI_HOME]) {
    state.ids[KIMI_HOME] = `m_${crypto.randomBytes(5).toString('hex')}`;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  return state.ids[KIMI_HOME];
}
const MACHINE_ID = machineId();

// ------------------------------------------------------- local Kimi server

// Only these Kimi Server API calls may be made through the bridge. Anything
// that reads arbitrary host files, opens desktop apps, changes providers or
// shuts the server down is refused here, whatever the hub asks for.
const ALLOW = [
  ['GET', /^\/api\/v1\/(meta|auth|models|healthz|config)$/],
  ['GET', /^\/api\/v1\/fs:(browse|home)(\?.*)?$/],
  ['GET', /^\/api\/v1\/sessions(\?.*)?$/],
  ['POST', /^\/api\/v1\/sessions$/],
  ['GET', /^\/api\/v1\/sessions\/session_[\w-]+(\/[\w./:-]*)?(\?.*)?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+(:(abort|compact|fork))?$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/(prompts|prompts:steer|prompts\/[\w-]+:(abort|steer)|approvals\/[\w-]+|questions\/[\w-]+(:dismiss)?|profile)$/],
  ['POST', /^\/api\/v1\/sessions\/session_[\w-]+\/fs:(list|read|stat|git_status|diff|search|grep)$/],
];
const allowed = (method, p) => ALLOW.some(([m, re]) => m === method && re.test(p));

const kimi = {
  instance: null,
  token: null,
  ws: null,
  subs: new Set(),
  version: null,

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
    this.version = this.instance?.host_version || null;
    if (changed) {
      this.ws?.close();
      this.ws = null;
      if (this.instance) {
        log(`✓ 找到 Kimi Code 伺服器（${this.version || '?'}，port ${this.instance.port}）`);
        this.connect();
      } else {
        log('… 沒有偵測到執行中的 Kimi Code 伺服器。在 Kimi 裡輸入 /web，或執行 `kimi web`（也可以加上 --start-kimi 讓連接器自動啟動）');
      }
      hub.sendStatus();
    }
    return this.instance;
  },

  base() {
    return `http://${this.instance.host}:${this.instance.port}`;
  },

  async request(method, p, body) {
    if (!this.instance) throw new Error('這台機器沒有執行中的 Kimi Code 伺服器（在 Kimi 裡輸入 /web 或執行 kimi web）');
    if (!allowed(method, p)) throw new Error(`連接器拒絕了這個請求：${method} ${p.split('?')[0]}`);
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
      ws.send(JSON.stringify({ type: 'client_hello', id: 'hello', payload: { client_id: `agent-hub-bridge-${MACHINE_ID}` } }));
      if (this.subs.size) ws.send(JSON.stringify({ type: 'subscribe', id: 'resub', payload: { session_ids: [...this.subs] } }));
      hub.pushSessionsSoon();
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
      hub.send({ t: 'kimi.event', frame: m });
      if (/^event\.session\.|^session\.meta\.updated$/.test(m.type)) hub.pushSessionsSoon();
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
    const child = spawn(KIMI_BIN, ['web', '--no-open'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME },
    });
    child.on('error', (err) => log(`✗ 無法啟動 Kimi：${err.code === 'ENOENT' ? `找不到指令 ${KIMI_BIN}` : err.message}`));
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.discover()) return this.instance;
    }
    throw new Error('Kimi 伺服器沒有在 20 秒內啟動');
  },
};

// ------------------------------------------------------------- the hub

const hub = {
  ws: null,
  backoff: 1000,
  sessionsTimer: null,

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  },

  async status() {
    let auth = null;
    if (kimi.instance) {
      try {
        auth = (await kimi.request('GET', '/api/v1/auth')).data;
      } catch {}
    }
    return {
      available: Boolean(kimi.instance),
      version: kimi.version,
      port: kimi.instance?.port ?? null,
      auth,
    };
  },

  async sendStatus() {
    this.send({ t: 'kimi.status', status: await this.status() });
  },

  pushSessionsSoon() {
    clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => this.pushSessions(), 400);
  },

  async pushSessions() {
    if (!kimi.instance) return;
    try {
      const r = await kimi.request('GET', '/api/v1/sessions?page_size=40&exclude_empty=true');
      if (r.code === 0) this.send({ t: 'kimi.sessions', items: r.data.items });
    } catch {}
  },

  async handle(op, args = {}) {
    switch (op) {
      case 'kimi.status':
        await kimi.discover();
        return this.status();
      case 'kimi.start':
        await kimi.start();
        return this.status();
      case 'kimi.request':
        return kimi.request(String(args.method || 'GET').toUpperCase(), String(args.path || ''), args.body);
      case 'kimi.subscribe':
        kimi.subscribe(args.sessionIds || []);
        return { ok: true };
      case 'kimi.unsubscribe':
        kimi.unsubscribe(args.sessionIds || []);
        return { ok: true };
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

  connect() {
    const url = `${HUB.replace(/^http/, 'ws')}/bridge?key=${encodeURIComponent(KEY)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => {
      this.backoff = 1000;
      log(`✓ 已連上中控台 ${HUB}（機器名稱：${NAME}）`);
      this.send({
        t: 'hello',
        machineId: MACHINE_ID,
        name: NAME,
        platform: `${os.platform()} ${os.arch()}`,
        bridgeVersion: VERSION,
        node: process.version,
        home: os.homedir(),
        status: await this.status(),
      });
      this.pushSessions();
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
        log('✗ 連接金鑰錯誤，請到中控台的「連接機器」重新複製指令');
        process.exit(1);
      }
      log(`… 與中控台的連線中斷，${Math.round(this.backoff / 1000)} 秒後重試`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => {};
  },
};

// ------------------------------------------------------------------ main

log(`Agent Hub 連接器 ${VERSION} · Kimi 資料夾 ${KIMI_HOME}`);
if (START_KIMI) await kimi.start().catch((err) => log(`✗ ${err.message}`));
else await kimi.discover();
hub.connect();

// Keep the hub link warm (proxies drop idle WebSockets) and notice Kimi
// servers that start or stop later.
setInterval(() => hub.send({ t: 'ping' }), 25_000);
setInterval(async () => {
  if (!kimi.instance) await kimi.discover();
}, 4000);
setInterval(() => hub.pushSessions(), 20_000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
