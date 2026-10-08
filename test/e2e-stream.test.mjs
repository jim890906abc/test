// The live stream to the browser: a page watching a conversation gets a
// snapshot and then every change after it, in order, with nothing missing or
// repeated — also when it asks for a new snapshot in the middle of heavy
// streaming. Pages not watching it get none of its stream; pages that never
// say what they watch (an older page) get everything as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-stream-'));
const PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'stream-token';
const KID = 'session_stream1';
let hub;
let machine;

const api = async (method, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'x-hub-token': TOKEN } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A machine that streams a conversation.
function fakeMachine(key) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const info = { id: KID, title: '串流', metadata: { cwd: '/tmp/p' }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed' };
  ws.on('open', () => {
    send({ t: 'hello', machineId: 'm_s', name: 'm', platform: 'test', bridgeVersion: '0.3.0', home: '/h', status: { available: true, server: true } });
    send({ t: 'kimi.sessions', items: [{ ...info, updated_at: new Date().toISOString() }] });
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t !== 'req') return;
    const a = m.args || {};
    let out = { ok: true };
    if (m.op === 'kimi.info') out = info;
    else if (m.op === 'kimi.history') out = { frames: [], more: false, before: 0, info };
    else if (m.op === 'kimi.request') out = { code: 0, data: a.path === '/api/v1/models' ? { items: [] } : {} };
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  const frame = (type, payload) => send({ t: 'kimi.event', frame: { type, session_id: KID, payload: { agentId: 'main', ...payload, sessionId: KID } } });
  return { ws, frame, ready: new Promise((r) => ws.on('open', r)) };
}

// A browser page, reduced to what it keeps: the conversation it watches.
function page({ watch } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const p = { ws, got: [], raw: 0, batches: 0, snapshots: 0, view: null, seq: 0, problems: [] };
  ws.on('message', (d) => {
    p.raw++;
    const m = JSON.parse(d);
    const items = m.t === 'batch' ? (p.batches++, m.items) : [m];
    for (const x of items) {
      p.got.push(x);
      if (x.t === 'snapshot') {
        if (x.error) continue;
        p.snapshots++;
        p.view = new Map(x.session.events.map((e) => [e.id, structuredClone(e)]));
        p.order = x.session.events.map((e) => e.id);
        p.seq = x.session.seq;
        continue;
      }
      if (!['event', 'patch', 'delta'].includes(x.t) || !p.view) continue;
      if (x.seq <= p.seq) continue; // in the snapshot already
      if (x.seq !== p.seq + 1) p.problems.push(`gap: ${p.seq} → ${x.seq}`);
      p.seq = x.seq;
      if (x.t === 'event') {
        p.view.set(x.ev.id, structuredClone(x.ev));
        p.order.push(x.ev.id);
      } else if (x.t === 'patch') Object.assign(p.view.get(x.id), x.fields);
      else p.view.get(x.id)[x.field] = (p.view.get(x.id)[x.field] || '') + x.text;
    }
  });
  p.watch = (sid) => ws.send(JSON.stringify({ t: 'watch', sid }));
  p.ready = new Promise((r) => ws.on('open', () => (watch !== undefined && p.watch(watch), r())));
  return p;
}

let sid;
before(async () => {
  hub = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => hub.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
  machine = fakeMachine(JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey);
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.online && m.sessions.length), 10000, 'machine');
  sid = (await api('POST', `/machines/m_s/kimi/${KID}/attach`)).id;
});

after(() => {
  machine?.ws.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a watching page gets a snapshot and every change after it, also across new snapshots taken mid-stream', async () => {
  const watcher = page({ watch: sid });
  const home = page({ watch: null });
  const legacy = page();
  await Promise.all([watcher.ready, home.ready, legacy.ready]);
  await until(async () => watcher.snapshots === 1, 5000, 'first snapshot');

  // Heavy streaming: a turn with text, thinking and tool output, in bursts.
  machine.frame('turn.started', { turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, prompt: '開始' });
  machine.frame('event.session.work_changed', { busy: true, pending_interaction: 'none' });
  for (let burst = 0; burst < 40; burst++) {
    for (let k = 0; k < 25; k++) {
      machine.frame(k % 3 ? 'assistant.delta' : 'thinking.delta', { turnId: 't1', delta: `[${burst}.${k}]` });
      if (k === 12) {
        machine.frame('tool.call.started', { turnId: 't1', toolCallId: `c${burst}`, name: 'Bash', args: { command: `echo ${burst}` } });
        machine.frame('tool.progress', { toolCallId: `c${burst}`, update: { text: `out ${burst}\n` } });
        machine.frame('tool.result', { turnId: 't1', toolCallId: `c${burst}`, output: `out ${burst}\n` });
      }
    }
    // The page asks again in the middle of it (a gap, a reconnect).
    if (burst % 10 === 5) watcher.watch(sid);
    await sleep(15);
  }
  machine.frame('turn.ended', { turnId: 't1', reason: 'completed' });
  machine.frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' });

  const final = await until(async () => {
    const s = await api('GET', `/sessions/${sid}`);
    return s.status === 'idle' && s.events.some((e) => e.type === 'turn_end') && s;
  }, 10000, 'turn over');
  await until(async () => watcher.seq === final.seq, 5000, 'page caught up');

  assert.deepEqual(watcher.problems, []);
  assert.ok(watcher.snapshots >= 5, `re-watched mid-stream (${watcher.snapshots} snapshots)`);
  const pick = (e) => ({ id: e.id, type: e.type, text: e.text, output: e.output, status: e.status });
  assert.deepEqual(watcher.order.map((id) => pick(watcher.view.get(id))), final.events.map(pick), 'the page shows exactly what the hub has');
  assert.ok(watcher.batches > 0 && watcher.raw < watcher.got.length, 'sent in bundles');

  // Not watching it: none of its stream.
  assert.equal(home.got.filter((m) => ['event', 'patch', 'delta', 'reset'].includes(m.t)).length, 0);
  assert.ok(home.got.some((m) => m.t === 'session'), 'conversation summaries still arrive (sidebar)');
  // An older page: everything, one message at a time.
  assert.equal(legacy.batches, 0);
  const seqs = legacy.got.filter((m) => m.sid === sid && m.seq).map((m) => m.seq);
  assert.ok(seqs.length > 900);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);

  for (const p of [watcher, home, legacy]) p.ws.close();
});

test('watching a conversation that does not exist says so; switching to another stops the first one', async () => {
  const p = page({ watch: 's_nope' });
  await p.ready;
  await until(async () => p.got.find((m) => m.t === 'snapshot'), 5000, 'answer');
  assert.equal(p.got.find((m) => m.t === 'snapshot').error, '找不到 session');
  p.watch(sid);
  await until(async () => p.snapshots === 1, 5000, 'snapshot');
  p.watch(null);
  await sleep(100);
  const before = p.got.length;
  machine.frame('turn.started', { turnId: 't2', promptId: 'p2', origin: { kind: 'user' }, prompt: '再一次' });
  machine.frame('assistant.delta', { turnId: 't2', delta: '你好' });
  machine.frame('turn.ended', { turnId: 't2', reason: 'completed' });
  await sleep(300);
  assert.equal(p.got.slice(before).filter((m) => ['event', 'patch', 'delta'].includes(m.t)).length, 0);
  p.ws.close();
});
