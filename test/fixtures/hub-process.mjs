// The REAL Hub (server/index.js) as a child process on a temp data folder, for
// the tests of what it does with its own files at start and at shutdown.
// Nothing of the Hub is replaced. (test/fixtures/real-hub.mjs is the heavier
// one with a fake Kimi machine and a fake Claude API around it.)
//
//   const sc = scratch('name');            // { dir, data, file(name) }
//   const hub = await spawnHub(sc, { env, chaos });
//   await hub.ready; await hub.stop();
//
// `env`: overrides (a key set to undefined is removed; AGENT_HUB_TOKEN and
// AGENT_HUB_BRIDGE_KEY are not inherited). `chaos`: { mark, log } for
// test/fixtures/disk-chaos.mjs. Call cleanup() in an `after` hook.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { stopDaemonsSync } from './stop-daemons.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHAOS = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'disk-chaos.mjs')).href;
export const procs = new Set();
const dirs = [];

export function cleanup() {
  for (const p of procs) p.kill('SIGKILL');
  // A Hub that had a Claude conversation started a Claude daemon, which outlives
  // it: end the daemons of these scratch folders (found by their --dir), then
  // delete the folders.
  for (const d of dirs) stopDaemonsSync(d);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// A temp folder with a data/ inside.
export function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-cfg-${name}-`));
  dirs.push(dir);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  return { dir, data, file: (n) => path.join(data, n) };
}

// A port nobody is listening on (other test runs share this machine).
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export async function spawnHub(sc, { env = {}, chaos = {} } = {}) {
  const port = await freePort();
  const e = { ...process.env, HOME: sc.dir, PORT: String(port), AGENT_HUB_DATA: sc.data, AGENT_HUB_WORKSPACES: path.join(sc.dir, 'ws') };
  delete e.AGENT_HUB_TOKEN;
  delete e.AGENT_HUB_BRIDGE_KEY;
  delete e.ANTHROPIC_API_KEY;
  if (chaos.mark) e.AH_CRASH_MARK = chaos.mark;
  if (chaos.log) e.AH_OP_LOG = chaos.log;
  for (const [k, v] of Object.entries(env)) v === undefined ? delete e[k] : (e[k] = v);
  const args = chaos.mark || chaos.log ? ['--import', CHAOS, 'server/index.js'] : ['server/index.js'];
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(proc);
  let out = '';
  const exited = new Promise((r) => proc.once('exit', (code, signal) => (procs.delete(proc), r({ code, signal }))));
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Hub did not start:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      if (out.includes('已啟動')) (clearTimeout(t), resolve());
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    exited.then(({ code, signal }) => (clearTimeout(t), reject(new Error(`Hub stopped before it was ready (${code ?? signal}):\n${out}`))));
  });
  ready.catch(() => {});
  return {
    proc,
    port,
    ready,
    exited,
    out: () => out,
    // The Hub is expected to stop by itself (it was killed, or refused to start).
    async stopsWithin(ms = 15000) {
      let timer;
      const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the Hub did not stop within ${ms} ms:\n${out}`)), ms)));
      try {
        return await Promise.race([exited, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    // `token`: the login token to send (the Hub started without AGENT_HUB_TOKEN needs one).
    async api(p, init = {}) {
      const { token = e.AGENT_HUB_TOKEN, ...rest } = init;
      const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { ...rest, headers: { 'content-type': 'application/json', ...(token ? { 'x-hub-token': token } : {}), ...(rest.headers || {}) } });
      return r.json();
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        await exited;
      }
    },
  };
}

// A computer that says hello to the Hub (what makes the Hub write machines.json).
export function connectMachine(port, key, id, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?key=${encodeURIComponent(key)}`);
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', machineId: id, name, platform: 'test', home: '/home/x', bridgeVersion: '0.9.0', status: { available: false } })));
  return ws;
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const opsOf = (log) => fs.readFileSync(log, 'utf8').trim().split('\n');
// Around `rename <name>` in an op log (test/fixtures/disk-chaos.mjs): what was
// synced right before it, what right after, and the opens of that file before it.
export function aroundRename(ops, name) {
  const i = ops.indexOf(`rename ${name}`);
  if (i <= 0) throw new Error(`${name} is not put in place with a rename (${ops.join(' | ')})`);
  return { before: ops[i - 1], after: ops.slice(i + 1).find((l) => !l.startsWith('open ')), opens: ops.slice(0, i).filter((l) => l.startsWith('open ') && l.includes(name)) };
}
export const waitFor = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
