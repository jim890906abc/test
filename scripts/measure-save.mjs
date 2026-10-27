#!/usr/bin/env node
// Measures what saving a big conversation costs the Hub's event loop: one
// write of the whole file, then a stretch of live streaming (a delta every
// 33 ms, as the runner does) with the store saving on every change.
//
//   node scripts/measure-save.mjs --src <dir with *.json sessions>
//        [--seconds 10] [--rate 30] [--label name] [--out result.json]
//
// The sessions are COPIED into a fresh temp folder; the source is never
// touched. The store is used directly (no HTTP, no machine, no network).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const SRC = arg('src');
if (!SRC) {
  console.error('usage: node scripts/measure-save.mjs --src <sessions dir> [--seconds N] [--rate N] [--label X] [--out file]');
  process.exit(2);
}
const SECONDS = Number(arg('seconds', 10));
const RATE = Number(arg('rate', 30));
const LABEL = arg('label', 'run');
const OUT = arg('out', '');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-measure-save-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
for (const f of fs.readdirSync(SRC)) if (f.endsWith('.json')) fs.copyFileSync(path.join(SRC, f), path.join(DATA, 'sessions', f));
process.env.AGENT_HUB_DATA = DATA;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

// Count what really goes to disk, however the store writes it: whole-file
// writeFile, or a file handle written piece by piece.
const disk = { writes: 0, bytes: 0, pieces: 0, largestPieceKB: 0, syncs: 0 };
const mine = (file) => String(file).includes('/sessions/');
const count = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data.length);
const realWriteFile = fs.promises.writeFile.bind(fs.promises);
fs.promises.writeFile = async (file, data, ...rest) => {
  if (mine(file)) {
    disk.writes++;
    disk.pieces++;
    disk.bytes += count(data);
    disk.largestPieceKB = Math.max(disk.largestPieceKB, Math.round(count(data) / 1024));
  }
  return realWriteFile(file, data, ...rest);
};
const realOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = async (file, ...rest) => {
  const fh = await realOpen(file, ...rest);
  if (!mine(file)) return fh;
  disk.writes++; // one file written
  const write = fh.write.bind(fh);
  const sync = fh.sync.bind(fh);
  fh.write = async (data, ...r) => {
    disk.pieces++;
    disk.bytes += count(data);
    disk.largestPieceKB = Math.max(disk.largestPieceKB, Math.round(count(data) / 1024));
    return write(data, ...r);
  };
  fh.sync = async () => (disk.syncs++, sync());
  return fh;
};

const store = await import(path.join(ROOT, 'server/store.js'));
store.loadSessions();
const big = store.listSessions().sort((a, b) => b.events.length - a.events.length)[0];
const fileOf = (s) => path.join(DATA, 'sessions', `${s.id}.json`);
const sizeMB = () => +(fs.statSync(fileOf(big)).size / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sample() {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  return () => {
    h.disable();
    const c = process.cpuUsage(cpu0);
    return {
      wallMs: Math.round(performance.now() - t0),
      cpuMs: Math.round((c.user + c.system) / 1000),
      loopMaxMs: +(h.max / 1e6).toFixed(1),
      loopP99Ms: +(h.percentile(99) / 1e6).toFixed(1),
    };
  };
}

const result = { label: LABEL, node: process.version, session: { events: big.events.length, fileMB: sizeMB() } };

// 1. one write of the whole file, nothing else going on
{
  Object.assign(disk, { writes: 0, bytes: 0, pieces: 0, largestPieceKB: 0, syncs: 0 });
  const done = sample();
  await store.persistNow(big);
  const s = done();
  result.oneWrite = { ...s, writes: disk.writes, pieces: disk.pieces, largestPieceKB: disk.largestPieceKB, syncs: disk.syncs, wroteMB: +(disk.bytes / 1048576).toFixed(1) };
}

// 2. the SIGTERM path: everything pending, written synchronously
{
  store.saveSession(big); // pending
  const t0 = performance.now();
  store.flushAll();
  result.flushAllMs = Math.round(performance.now() - t0);
}

// 3. live streaming into the biggest conversation
{
  const thinking = [...big.events].reverse().find((e) => e.type === 'thinking') || big.events.at(-1);
  Object.assign(disk, { writes: 0, bytes: 0, pieces: 0, largestPieceKB: 0, syncs: 0 });
  const done = sample();
  const end = performance.now() + SECONDS * 1000;
  let deltas = 0;
  while (performance.now() < end) {
    thinking.text = `${thinking.text || ''}tok `; // runner.delta: append to the event, then save
    big.seq = (big.seq || 0) + 1;
    store.saveSession(big);
    deltas++;
    await sleep(1000 / RATE);
  }
  const s = done();
  // Let the trailing write finish, so the totals are complete.
  const drain = performance.now();
  await store.persistNow(big);
  result.stream = { seconds: SECONDS, ratePerSec: RATE, deltas, ...s, writes: disk.writes, largestPieceKB: disk.largestPieceKB, wroteMB: +(disk.bytes / 1048576).toFixed(1), drainMs: Math.round(performance.now() - drain) };
  result.stream.mbPerSecond = +(disk.bytes / 1048576 / SECONDS).toFixed(1);
}

// 4. what is on disk afterwards is still the whole conversation
{
  const onDisk = JSON.parse(fs.readFileSync(fileOf(big), 'utf8'));
  result.diskIntact = onDisk.events.length === big.events.length && onDisk.seq === big.seq;
}

if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
