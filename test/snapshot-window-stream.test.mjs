// The live side of a windowed snapshot: a page that watches a conversation is
// sent only the newest window, and then every change after it with nothing
// missing and nothing repeated — also when it takes a fresh snapshot in the
// middle of heavy streaming.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeMachine, page as makePage, sleep, until } from './hub-ws-fixtures.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-window-ws-'));
const DATA = path.join(TMP, 'data');
const PORT = 30900 + Math.floor(Math.random() * 900);
const TOKEN = 'window-token';
const KID = 'session_window1';
const WINDOW_EVENTS = 30;
let hub;
let machine;
let sid;
const page = (opts = {}) => makePage({ port: PORT, token: TOKEN, ...opts });

const api = async (method, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'x-hub-token': TOKEN } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_WINDOW_EVENTS: String(WINDOW_EVENTS), AGENT_HUB_WINDOW_TURNS: '1000', AGENT_HUB_WINDOW_LATEST_EVENTS: String(WINDOW_EVENTS), AGENT_HUB_LIVE_TAIL: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => hub.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
  machine = fakeMachine({ port: PORT, key: JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey, kid: KID });
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.online && m.sessions.length), 10000, 'machine');
  sid = (await api('POST', `/machines/m_w/kimi/${KID}/attach`)).id;
});

after(() => {
  machine?.ws.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('a page watching a conversation longer than the window gets the window, then the live stream with no gap and no repeat — also across fresh snapshots mid-stream', async () => {
  // History first: a long turn with many tool calls, before any page is watching.
  machine.frame('turn.started', { turnId: 'h1', promptId: 'ph', origin: { kind: 'user' }, prompt: '先做很多事' });
  machine.frame('event.session.work_changed', { busy: true, pending_interaction: 'none' });
  for (let i = 0; i < 80; i++) {
    machine.frame('tool.call.started', { turnId: 'h1', toolCallId: `h${i}`, name: 'Bash', args: { command: `echo ${i}` } });
    machine.frame('tool.result', { turnId: 'h1', toolCallId: `h${i}`, output: `${i}\n` });
  }
  machine.frame('turn.ended', { turnId: 'h1', reason: 'completed' });
  machine.frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' });
  const before = await until(async () => {
    const all = await api('GET', `/sessions/${sid}?window=all`);
    return all.events.length > 80 && all.status === 'idle' && all;
  }, 10000, 'history');

  const watcher = page({ watch: sid });
  await watcher.ready;
  await until(async () => watcher.snapshots === 1, 5000, 'first snapshot');
  assert.equal(watcher.order.length, WINDOW_EVENTS, 'only the newest window came');
  assert.deepEqual(watcher.window, { total: before.events.length, firstIndex: before.events.length - WINDOW_EVENTS, hasEarlier: true });
  assert.deepEqual(watcher.order, before.events.slice(-WINDOW_EVENTS).map((e) => e.id));

  // Heavy streaming into it, with fresh snapshots asked for in the middle.
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
    if (burst % 10 === 5) watcher.watch(sid);
    await sleep(15);
  }
  machine.frame('turn.ended', { turnId: 't1', reason: 'completed' });
  machine.frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' });

  const final = await until(async () => {
    const s = await api('GET', `/sessions/${sid}?window=all`);
    return s.status === 'idle' && s.events.some((e) => e.type === 'turn_end' && e.ts > before.events.at(-1).ts) && s;
  }, 10000, 'turn over');
  await until(async () => watcher.seq === final.seq, 5000, 'page caught up');

  assert.deepEqual(watcher.problems, []);
  assert.ok(watcher.snapshots >= 4, `re-watched mid-stream (${watcher.snapshots} snapshots)`);
  // The page holds exactly the end of the history, from where its last window began.
  const first = watcher.window.firstIndex;
  const pick = (e) => ({ id: e.id, type: e.type, text: e.text, output: e.output, status: e.status });
  assert.deepEqual(watcher.order, final.events.slice(first).map((e) => e.id), 'same events, same order, none twice');
  assert.deepEqual(watcher.order.map((id) => pick(watcher.view.get(id))), final.events.slice(first).map(pick), 'and the same content');
  assert.equal(watcher.unknownTargets, 0, 'every patch and delta found its event in the window');
  // …and what came before the window is one page away, adjoining exactly.
  const older = await api('GET', `/sessions/${sid}/events?before=${first}&limit=500`);
  assert.deepEqual(older.events.map((e) => e.id), final.events.slice(older.firstIndex, first).map((e) => e.id));
  watcher.ws.close();
});

test('{ window: "all" } on watch is the whole history in the snapshot, with no window field', async () => {
  const p = page({ watch: sid, window: 'all' });
  await p.ready;
  await until(async () => p.snapshots === 1, 5000, 'snapshot');
  const all = await api('GET', `/sessions/${sid}?window=all`);
  assert.equal(p.order.length, all.events.length);
  assert.ok(p.order.length > WINDOW_EVENTS);
  assert.equal(p.window, undefined);
  p.ws.close();
});

test('a page that never says what it watches is not given snapshots, as before', async () => {
  const legacy = page();
  await legacy.ready;
  machine.frame('turn.started', { turnId: 't9', promptId: 'p9', origin: { kind: 'user' }, prompt: '舊頁面' });
  machine.frame('assistant.delta', { turnId: 't9', delta: 'hi' });
  machine.frame('turn.ended', { turnId: 't9', reason: 'completed' });
  await until(async () => legacy.got.some((m) => m.t === 'event'), 5000, 'events');
  assert.equal(legacy.snapshots, 0);
  legacy.ws.close();
});
