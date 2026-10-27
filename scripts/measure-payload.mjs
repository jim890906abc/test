#!/usr/bin/env node
// Measures what it costs to open a conversation: how big the snapshot is, how
// long the first answer takes over HTTP and over the WebSocket, how much CPU
// the Hub spends, and whether the Hub stays responsive meanwhile. Run it
// before and after a change to the snapshot path and compare the two tables.
//
//   node scripts/measure-payload.mjs --src <dir with *.json sessions> [--port 8911]
//        [--top 3] [--runs 5] [--label name] [--out result.json]
//
// Each conversation is opened --runs times (default 1) and every number in the
// table is the median of those runs.
//
// The sessions are COPIED into a fresh temp folder first, so the source is
// never touched and every run starts from the same bytes. No machine, no key
// and no network is involved: the Hub is started with AGENT_HUB_TOKEN=none on
// 127.0.0.1 with an empty machine list.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const SRC = arg('src');
if (!SRC) {
  console.error('usage: node scripts/measure-payload.mjs --src <sessions dir> [--port N] [--top N] [--label X] [--out file]');
  process.exit(2);
}
const PORT = Number(arg('port', 8911));
const TOP = Number(arg('top', 3));
const RUNS = Number(arg('runs', 1));
const LABEL = arg('label', 'run');
const OUT = arg('out', '');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-measure-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
for (const f of fs.readdirSync(SRC)) if (f.endsWith('.json')) fs.copyFileSync(path.join(SRC, f), path.join(DATA, 'sessions', f));

const hub = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), CLAUDE_CONFIG_DIR: path.join(TMP, '.noclaude') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
hub.stdout.on('data', (d) => (log += d));
hub.stderr.on('data', (d) => (log += d));

const TICK = 100; // Linux USER_HZ
const cpuMs = () => {
  const f = fs.readFileSync(`/proc/${hub.pid}/stat`, 'utf8');
  const after = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return ((Number(after[11]) + Number(after[12])) * 1000) / TICK;
};
const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${hub.pid}/status`, 'utf8'))[1]) / 1024;

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, headers }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({ ms: performance.now() - t0, status: r.statusCode, wireBytes: raw.length, encoding: r.headers['content-encoding'] || 'identity', raw });
        });
      })
      .on('error', reject);
  });
}
const decode = (r) => {
  const t0 = performance.now();
  const buf = r.encoding === 'gzip' ? zlib.gunzipSync(r.raw) : r.encoding === 'br' ? zlib.brotliDecompressSync(r.raw) : r.raw;
  const text = buf.toString('utf8');
  const decodeMs = performance.now() - t0;
  const t1 = performance.now();
  const json = JSON.parse(text);
  return { json, textBytes: buf.length, decodeMs, parseMs: performance.now() - t1 };
};

// While `fn` runs, a tiny request every 10 ms: the slowest answer shows how
// long the Hub's event loop was held up.
async function withProbe(fn) {
  let stop = false;
  let worst = 0;
  let count = 0;
  const loop = (async () => {
    while (!stop) {
      const r = await get('/api/config').catch(() => null);
      if (r) {
        worst = Math.max(worst, r.ms);
        count++;
      }
      await new Promise((res) => setTimeout(res, 10));
    }
  })();
  const out = await fn();
  stop = true;
  await loop;
  return { ...out, probeWorstMs: worst, probes: count };
}

function watchOnce(sid, wsOpts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, wsOpts);
    let t0;
    let bytesBefore = 0;
    const timer = setTimeout(() => reject(new Error('no snapshot in 20s')), 20_000);
    ws.on('open', () => {
      // the socket carries the hello frame already; count from now on
      setTimeout(() => {
        bytesBefore = ws._socket.bytesRead;
        t0 = performance.now();
        ws.send(JSON.stringify({ t: 'watch', sid }));
      }, 50);
    });
    ws.on('message', (data) => {
      const text = data.toString();
      if (!text.startsWith('{"t":"snapshot"')) return;
      const ms = performance.now() - t0;
      const wireBytes = ws._socket.bytesRead - bytesBefore;
      const t1 = performance.now();
      const msg = JSON.parse(text);
      const parseMs = performance.now() - t1;
      clearTimeout(timer);
      const deflate = String(ws.extensions || '').includes('permessage-deflate') ? 'on' : 'off';
      ws.close();
      resolve({ ms, wireBytes, textBytes: Buffer.byteLength(text), parseMs, session: msg.session, deflate });
    });
    ws.on('error', reject);
  });
}

// Field by field median of the runs' rows (numbers); other values from the
// first run. CPU is read from /proc in 10 ms ticks, too coarse for a median:
// those fields are averaged instead.
function median(runs) {
  const walk = (vals, key) => {
    const first = vals[0];
    if (typeof first === 'number') {
      if (/cpu/i.test(key)) return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
      const sorted = vals.slice().sort((a, b) => a - b);
      return +sorted[Math.floor(sorted.length / 2)].toFixed(1);
    }
    if (first && typeof first === 'object' && !Array.isArray(first)) return Object.fromEntries(Object.keys(first).map((k) => [k, walk(vals.map((v) => v[k]), k)]));
    return first;
  };
  return walk(runs, '');
}

const summaryOf = (s) => ({ events: s.events?.length ?? 0, window: s.window || null, seq: s.seq });

try {
  for (let i = 0; i < 300; i++) {
    const r = await get('/api/sessions').catch(() => null);
    if (r?.status === 200) break;
    if (i === 299) throw new Error(`hub did not start\n${log.slice(-800)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  const list = JSON.parse((await get('/api/sessions')).raw.toString());
  const sizes = list
    .map((s) => ({ id: s.id, title: (s.title || '').slice(0, 24), fileMB: fs.statSync(path.join(DATA, 'sessions', `${s.id}.json`)).size / 1048576 }))
    .sort((a, b) => b.fileMB - a.fileMB)
    .slice(0, TOP);
  await new Promise((res) => setTimeout(res, 800)); // let start-up writes settle
  const rows = [];
  const once = async (s) => {
    const row = { title: s.title, fileMB: +s.fileMB.toFixed(1) };

    const c0 = cpuMs();
    const idr = await withProbe(async () => get(`/api/sessions/${s.id}`, { 'accept-encoding': 'identity' }));
    const idd = decode(idr);
    Object.assign(row, { httpMs: +idr.ms.toFixed(1), httpKB: Math.round(idr.wireBytes / 1024), httpParseMs: +idd.parseMs.toFixed(1), httpProbeWorstMs: +idr.probeWorstMs.toFixed(1), httpCpuMs: Math.round(cpuMs() - c0), ...summaryOf(idd.json) });

    const c1 = cpuMs();
    const gz = await get(`/api/sessions/${s.id}`, { 'accept-encoding': 'gzip' });
    row.httpGzipMs = +gz.ms.toFixed(1);
    row.httpGzipKB = Math.round(gz.wireBytes / 1024);
    row.httpGzipEncoding = gz.encoding;
    row.httpGzipCpuMs = Math.round(cpuMs() - c1);

    for (const [name, opts] of [['wsDeflate', undefined], ['wsPlain', { perMessageDeflate: false }]]) {
      const c2 = cpuMs();
      const w = await withProbe(() => watchOnce(s.id, opts));
      row[name] = { ms: +w.ms.toFixed(1), wireKB: Math.round(w.wireBytes / 1024), textKB: Math.round(w.textBytes / 1024), parseMs: +w.parseMs.toFixed(1), probeWorstMs: +w.probeWorstMs.toFixed(1), cpuMs: Math.round(cpuMs() - c2), negotiated: w.deflate, events: w.session?.events?.length ?? 0 };
    }
    return row;
  };
  for (const s of sizes) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await once(s));
    const row = median(runs);
    rows.push(row);
    await new Promise((res) => setTimeout(res, 300));
  }
  const result = { label: LABEL, node: process.version, hubRssMB: Math.round(rssMb()), rows };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  hub.kill('SIGTERM');
  setTimeout(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  }, 400);
}
