// What saving a big conversation costs while an agent streams into it, and how
// much a crash can take with it (server/store.js).
//
// The shape of the problem: a working agent changes its conversation 20+ times
// a second, and every change used to end in a timer that rewrote the WHOLE
// file (tens of MB of JSON.stringify, write, fsync) every ~1.5 s. On a Hub with
// a handful of such workers that was a fifth of the CPU of the one thread that
// serves every request. Now a big conversation is rewritten no more often than
// its own last write cost allows, with a hard ceiling on how long a change may
// wait, and a turn that ends is written at once.
//
// The numbers are measured against the machine they run on (the cost of one
// whole write is taken first, and the stream is judged against what the old
// every-1.5-seconds rule would have spent), so a slow machine does not fail it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEvents } from './fixtures/big-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-save-perf-'));
const scratch = [TMP];
const children = new Set();
after(() => {
  for (const c of children) {
    try {
      process.kill(c.pid, 'SIGKILL');
    } catch {}
  }
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');
const file = (id) => path.join(TMP, 'sessions', `${id}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Counts what reaches sessions/: whole files put in place (renames) and the
// bytes written into them. It watches the disk, not the store's own functions,
// so it measures the same thing before and after a change to how it saves.
function spyOnDisk() {
  const log = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  const realRename = fs.renameSync;
  const mine = (f) => String(f).includes(`${path.sep}sessions${path.sep}`);
  fs.promises.open = async (f, ...rest) => {
    const fh = await realOpen(f, ...rest);
    if (!mine(f)) return fh;
    const write = fh.write.bind(fh);
    fh.write = async (data, ...r) => (log.push({ op: 'write', bytes: Buffer.byteLength(data) }), write(data, ...r));
    return fh;
  };
  fs.renameSync = (a, b) => (mine(a) && log.push({ op: 'rename', at: performance.now() }), realRename(a, b));
  return {
    log,
    get renames() {
      return log.filter((x) => x.op === 'rename').length;
    },
    get bytes() {
      return log.filter((x) => x.op === 'write').reduce((a, x) => a + x.bytes, 0);
    },
    restore() {
      fs.promises.open = realOpen;
      fs.renameSync = realRename;
    },
  };
}

// What one whole write of `s` costs on this machine: wall ms and CPU ms (the
// second of two, the first warms things up).
async function oneWrite(s) {
  await store.persistNow(s);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await store.persistNow(s);
  const c = process.cpuUsage(cpu0);
  return { wallMs: performance.now() - t0, cpuMs: (c.user + c.system) / 1000 };
}

// Resolves once nothing has been written for a while (a write in flight ends).
async function untilQuiet(spy, quietMs) {
  let seen = -1;
  let since = performance.now();
  for (const end = performance.now() + 30_000; performance.now() < end; ) {
    if (spy.log.length !== seen) {
      seen = spy.log.length;
      since = performance.now();
    } else if (performance.now() - since >= quietMs) return;
    await sleep(25);
  }
  throw new Error('writes never stopped');
}

const STREAM_SECONDS = 30;
const TICK_MS = 50; // 20 changes a second

test(`streaming into a 40 MB conversation for ${STREAM_SECONDS} s: whole-file rewrites and CPU stay well under the old every-1.5-s rule`, async (t) => {
  const s = store.createSession({ title: '大對話', events: makeEvents({ mb: 40 }) });
  const one = await oneWrite(s);
  const size = fs.statSync(file(s.id)).size;
  assert.ok(size > 39e6, `a conversation of ${(size / 1e6).toFixed(1)} MB`);

  const live = { id: 'think_live', type: 'thinking', text: '' };
  s.events.push(live);
  const spy = spyOnDisk();
  let elapsed;
  let cpuMs;
  try {
    s.status = 'running';
    store.saveSession(s); // runner.setStatus
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < STREAM_SECONDS * 1000) {
      live.text += 'tok '; // runner.delta: append to the open event, then save
      s.seq = ++n;
      store.saveSession(s);
      await sleep(TICK_MS);
    }
    elapsed = (performance.now() - t0) / 1000;
    s.status = 'idle';
    store.saveSession(s); // the turn is over
    await untilQuiet(spy, 3 * one.wallMs + 300);
    const c = process.cpuUsage(cpu0);
    cpuMs = (c.user + c.system) / 1000;
  } finally {
    spy.restore();
  }

  // What the old rule (one whole write per 1.5 s timer, the next change after a
  // write starting the next timer) would have spent over the same stretch.
  const oldWrites = elapsed / (1.5 + one.wallMs / 1000);
  t.diagnostic(`size ${(size / 1e6).toFixed(1)} MB; one whole write ${one.wallMs.toFixed(0)} ms wall / ${one.cpuMs.toFixed(0)} ms CPU`);
  t.diagnostic(`${elapsed.toFixed(1)} s of streaming, ${(1000 / TICK_MS).toFixed(0)} changes/s: ${spy.renames} whole-file writes, ${(spy.bytes / 1e6).toFixed(0)} MB written, ${cpuMs.toFixed(0)} ms CPU`);
  t.diagnostic(`the old every-1.5-s rule: ~${oldWrites.toFixed(1)} writes, ~${(oldWrites * size / 1e6).toFixed(0)} MB, ~${(oldWrites * one.cpuMs).toFixed(0)} ms CPU`);

  assert.ok(spy.renames >= 2, `it did save during the stream and at the end (${spy.renames})`);
  assert.ok(spy.renames <= Math.ceil(0.4 * oldWrites), `${spy.renames} whole-file writes; the old rule would make ~${oldWrites.toFixed(1)}, this must be at most 40% of that`);
  assert.ok(spy.bytes <= 0.4 * oldWrites * size * 1.05 + size, `${(spy.bytes / 1e6).toFixed(0)} MB written`);
  assert.ok(cpuMs <= 0.6 * oldWrites * one.cpuMs, `${cpuMs.toFixed(0)} ms CPU against ~${(oldWrites * one.cpuMs).toFixed(0)} ms for the old rule`);

  // And none of it was given up: what is on disk is the conversation as it ended.
  const disk = JSON.parse(fs.readFileSync(file(s.id), 'utf8'));
  assert.equal(disk.status, 'idle');
  assert.equal(disk.seq, s.seq);
  assert.equal(disk.events.length, s.events.length);
  assert.equal(disk.events.at(-1).text, live.text);
  store.deleteSession(s.id);
});

test('a turn that ends is written at once, however long the wait of a big conversation was', async () => {
  const s = store.createSession({ title: '回合結束', events: makeEvents({ mb: 12 }) });
  const one = await oneWrite(s);
  const live = { id: 'think_live', type: 'thinking', text: '' };
  s.events.push(live);
  s.status = 'running';
  store.saveSession(s);
  for (let i = 0; i < 6; i++) {
    live.text += 'tok ';
    store.saveSession(s);
    await sleep(50);
  }
  live.text += 'THE END';
  s.status = 'idle';
  store.saveSession(s); // runner.setStatus('idle')
  await sleep(4 * one.wallMs + 250);
  const disk = JSON.parse(fs.readFileSync(file(s.id), 'utf8'));
  assert.equal(disk.status, 'idle');
  const written = disk.events.find((e) => e.id === 'think_live');
  assert.ok(written?.text.endsWith('THE END'), `the last words of the turn are on disk without waiting for any timer (${written ? `found "${written.text.slice(-12)}"` : 'the event is not in the file yet'})`);
  store.deleteSession(s.id);
});

test('a conversation that flips between working and idle all the time is not written on every flip', async () => {
  const s = store.createSession({ title: '一直切換', events: makeEvents({ mb: 12 }) });
  await oneWrite(s);
  const spy = spyOnDisk();
  const seconds = 3;
  try {
    const t0 = performance.now();
    for (let i = 0; performance.now() - t0 < seconds * 1000; i++) {
      s.status = i % 2 ? 'idle' : 'running';
      s.seq = i;
      store.saveSession(s);
      await sleep(100);
    }
    s.status = 'idle';
    store.saveSession(s);
    await untilQuiet(spy, 600);
  } finally {
    spy.restore();
  }
  // Never worse than the old one-per-1.5-s timer, plus the write for the end.
  assert.ok(spy.renames <= Math.ceil(seconds / 1.5) + 2, `${spy.renames} writes for 30 flips in ${seconds} s`);
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).status, 'idle');
  store.deleteSession(s.id);
});

// --------------------------------------------------------------- the crash

// A stand-in Hub that streams into a big conversation, killed with SIGKILL (no
// handler runs, nothing is flushed), and then what the next start finds.
const CAP_MS = 2000; // AGENT_HUB_SAVE_MAX_DEFER_MS for the stand-ins: short, so the test is
const RATE = 20;

function streamer({ mb, endAfter }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-save-crash-'));
  scratch.push(dir);
  const child = spawn(process.execPath, [path.join(HERE, 'fixtures', 'store-stream-child.mjs'), dir, String(mb), String(RATE), String(endAfter)], {
    env: { ...process.env, AGENT_HUB_SAVE_MAX_DEFER_MS: String(CAP_MS) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.add(child);
  const ticks = []; // [ts] by n
  const marks = {};
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1; ) {
      const [kind, a, b] = buf.slice(0, i).split(' ');
      buf = buf.slice(i + 1);
      if (kind === 'tick') ticks[Number(a)] = Number(b);
      else marks[kind] = { a: Number(a), b: Number(b), at: Date.now() };
    }
  });
  const waitFor = async (what, ok, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (ok()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return {
    dir,
    ticks,
    marks,
    waitFor,
    async killNow() {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await exited;
      children.delete(child);
    },
  };
}

function readAfterCrash(dir) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(HERE, 'fixtures', 'store-read-child.mjs'), dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`reader exited ${code}`))));
  });
}

test('Hub killed while a big conversation streams: at most the ceiling (+ one write) of the stream is gone, and the file is whole', async (t) => {
  const runs = await Promise.all(
    [5.5, 7.2, 9.1].map(async (killAfter) => {
      const w = streamer({ mb: 30, endAfter: 'never' });
      await w.waitFor('ready', () => w.marks.ready);
      const wallMs = w.marks.ready.a; // what one whole write of it took
      await w.waitFor('the stream', () => w.ticks.length > 0);
      await sleep(killAfter * 1000);
      const produced = w.ticks.length - 1;
      await w.killNow();
      const found = await readAfterCrash(w.dir);
      return { killAfter, wallMs, produced, found, ts: w.ticks };
    }),
  );
  for (const r of runs) {
    assert.equal(r.found.loaded, true, 'the conversation is there');
    assert.equal(r.found.damaged, 0, 'and it is not damaged: the file is whole (the old one or the new one)');
    assert.ok(r.found.last >= 0, `part of the stream is on disk (last event ${r.found.last} of ${r.produced})`);
    const lostEvents = r.produced - r.found.last;
    const lostSeconds = (r.ts[r.produced] - r.ts[r.found.last]) / 1000;
    const bound = CAP_MS / 1000 + (2 * r.wallMs) / 1000 + 1;
    t.diagnostic(`killed ${r.killAfter} s into the stream: ${r.produced + 1} events made, ${lostEvents} lost (${lostSeconds.toFixed(2)} s); ceiling ${(CAP_MS / 1000).toFixed(0)} s + 2 writes of ${r.wallMs} ms`);
    assert.ok(lostSeconds <= bound, `lost ${lostSeconds.toFixed(2)} s of stream (${lostEvents} events); the bound is ${bound.toFixed(2)} s`);
    assert.ok(lostEvents <= RATE * bound + 2, `lost ${lostEvents} events`);
  }
});

test('Hub killed right after a turn ended: nothing of the turn is lost', async () => {
  const w = streamer({ mb: 30, endAfter: 3 });
  await w.waitFor('ready', () => w.marks.ready);
  const wallMs = w.marks.ready.a;
  await w.waitFor('the turn to end', () => w.marks['turn-end']);
  const last = w.marks['turn-end'].a; // the last event the turn made
  await sleep(2 * wallMs + 200); // the write for the end of the turn (twice at worst: one already in flight) - well under the old 1.5 s timer
  await w.killNow();
  const found = await readAfterCrash(w.dir);
  assert.equal(found.damaged, 0);
  assert.equal(found.last, last, `every event of the turn (${last + 1}) is on disk`);
});

// ------------------------------------------------------- the file format

test('a conversation file written before this change loads as it is, and the file written now reads as it always did', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-save-compat-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  // The way an older Hub wrote one: the whole conversation in one JSON.stringify, no
  // field this version added since (modelConfig, conversationId, origin...).
  const legacy = {
    id: 's_stream',
    title: '舊版寫的對話',
    status: 'idle',
    permissionMode: 'ask',
    allowedTools: [],
    state: {},
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    events: [
      { id: 'n_0', ts: 1, type: 'text', text: '第一句' },
      { id: 'n_1', ts: 2, type: 'tool_use', name: 'Shell', status: 'running', input: { command: 'ls' } },
    ],
  };
  fs.writeFileSync(path.join(dir, 'sessions', 's_stream.json'), JSON.stringify(legacy));
  const found = await readAfterCrash(dir);
  assert.deepEqual(found, { loaded: true, damaged: 0, events: 2, last: 1 });
  // And what this version writes is the same plain JSON, whole, with `events` in it.
  const s = store.createSession({ title: '新版寫的', events: makeEvents({ mb: 3 }) });
  await store.persistNow(s);
  const disk = JSON.parse(fs.readFileSync(file(s.id), 'utf8'));
  assert.equal(disk.id, s.id);
  assert.equal(disk.events.length, s.events.length);
  assert.deepEqual(Object.keys(disk).sort(), Object.keys(JSON.parse(JSON.stringify(s))).sort());
  store.deleteSession(s.id);
});
