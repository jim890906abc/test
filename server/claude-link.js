// How the hub reaches the Claude daemons (server/claude-daemon.js), which run
// Claude conversations on their own — so closing the hub stops none of them:
//   • this computer's: started here by the hub (detached: it outlives the
//     hub) and spoken to over 127.0.0.1;
//   • a connected computer's: started there by its bridge, which relays
//     calls and the daemon's event stream (bridge 0.5+).
// Every daemon's events reach `onEvent(machineId | null, msg)`; a { t:
// 'resync' } message means events may have been missed (reconnected).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as machines from './machines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, 'claude-daemon.js');
// What the daemon runs on: its own code and the engine's. A daemon on other
// code is restarted (when nothing is running) so updates reach it.
const ENGINE = ['claude-daemon.js', 'store.js', 'tools.js', 'machines.js', 'claude-account.js', 'adapters/claude.js', 'adapters/claude-tools.js', 'adapters/claude-repo.js', 'adapters/broker-result.js', 'adapters/presets.js', 'redact.js'];
const engineHash = () => {
  const h = crypto.createHash('sha1');
  for (const f of ENGINE) h.update(fs.readFileSync(path.join(HERE, f)));
  return h.digest('hex').slice(0, 12);
};
const LOCAL_ENV_VERSION = engineHash();
const LOCAL_VERSION = crypto.createHash('sha1').update(fs.readFileSync(DAEMON)).update(LOCAL_ENV_VERSION).digest('hex').slice(0, 12);
// The one-file daemon the bridges download (npm run build:daemon).
const BUNDLE = path.join(HERE, '..', 'bridge', 'claude-daemon.mjs');
export const bundleVersion = () => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(BUNDLE)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
};
const BUNDLE_VERSION = bundleVersion();

let onEvent = () => {};
export function setHandler(fn) {
  onEvent = fn;
}

// ----------------------------------------------------- this computer's

const DIR = path.join(store.DATA_DIR, 'claude-daemon');

const local = {
  info: null, // { port, token, pid }
  starting: null,
  stream: null,

  read() {
    try {
      return JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.json'), 'utf8'));
    } catch {
      return null;
    }
  },

  async request(info, method, p, body, timeoutMs = 120_000) {
    const res = await fetch(`http://127.0.0.1:${info.port}${p}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-daemon-token': info.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  },

  async health(info = this.read()) {
    if (!info) return null;
    try {
      const h = await this.request(info, 'GET', '/health', undefined, 2000);
      return h?.ok ? { ...h, info } : null;
    } catch {
      return null;
    }
  },

  // Running, and on this hub's code: restarted when it is not and nothing
  // is running in it (otherwise later, see recheck()).
  async ensure() {
    return (this.starting ??= this.start().finally(() => (this.starting = null)));
  },

  async start() {
    let h = await this.health();
    if (h && h.version !== LOCAL_VERSION && !h.running.length) {
      await stopPid(h.info.pid);
      h = null;
    }
    if (!h) {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const log = fs.openSync(path.join(DIR, 'daemon.log'), 'a');
      const child = spawn(process.execPath, [DAEMON, '--dir', DIR], {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, AGENT_HUB_DATA: DIR, AGENT_HUB_WORKSPACES: store.WORKSPACES_DIR, AGENT_HUB_DAEMON_VERSION: LOCAL_ENV_VERSION },
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(log);
      for (let i = 0; i < 150 && !h; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const info = this.read();
        if (info?.pid === child.pid) h = await this.health(info);
      }
      if (!h) throw Object.assign(new Error(`Claude 背景程式沒有啟動起來，請看 ${path.join(DIR, 'daemon.log')}`), { status: 502 });
    }
    this.info = h.info;
    this.listen();
    return h.info;
  },

  // The daemon's event stream, kept open (and reopened) while it runs.
  listen() {
    if (this.stream) return;
    const info = this.info;
    const ac = new AbortController();
    this.stream = ac;
    (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/events`, { headers: { 'x-daemon-token': info.token }, signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onEvent(null, { t: 'resync' });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                onEvent(null, JSON.parse(line.slice(5)));
              } catch (err) {
                console.warn('[claude] event:', err.message);
              }
            }
          }
        }
      } catch {}
      if (this.stream !== ac) return;
      this.stream = null;
      // Gone (stopped, restarted): back when it answers again.
      setTimeout(() => this.ensure().catch(() => {}), 2000).unref();
    })();
  },

  async rpc(op, args, timeoutMs) {
    const info = await this.ensure();
    const r = await this.request(info, 'POST', '/rpc', { op, args }, timeoutMs);
    if (!r.ok) throw Object.assign(new Error(r.error || 'Claude 背景程式回報錯誤'), { status: r.status || 500 });
    return r.data;
  },
};

async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
}

// A daemon on older code, busy at the time: updated once it is idle.
setInterval(async () => {
  if (!local.info) return;
  const h = await local.health(local.info);
  if (h && h.version !== LOCAL_VERSION && !h.running.length) {
    local.stream?.abort();
    local.stream = null;
    await local.ensure().catch(() => {});
  }
}, 60_000).unref();

// ------------------------------------------------ a connected computer's

machines.onBridgeMessage((machineId, msg) => {
  if (msg.t === 'claude.event' && msg.msg) onEvent(machineId, msg.msg);
});

function tooOld(err, machineId) {
  if (/未知的操作/.test(err?.message || '')) {
    const m = machines.getMachine(machineId);
    return Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，跑不了 Claude。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409 });
  }
  return err;
}

// ------------------------------------------------------------------ api

// Calls `op` on the daemon of `machineId` (null: this computer).
export async function rpc(machineId, op, args = {}, timeoutMs = 120_000) {
  if (!machineId) return local.rpc(op, args, timeoutMs);
  try {
    return await machines.rpc(machineId, 'claude.rpc', { op, args, version: BUNDLE_VERSION, timeoutMs }, timeoutMs + 30_000);
  } catch (err) {
    throw tooOld(err, machineId);
  }
}

// Start this computer's daemon now (at hub start: its conversations show
// what happened while the hub was closed).
export const startLocal = () => local.ensure();
