// Auto-pause and the turn snapshot on a conversation that runs in a
// controllable terminal Kimi, end to end: the real hub, and a scripted machine
// that speaks the bridge protocol and plays a terminal Kimi (it takes keystrokes
// through kimi.tui.input, reads a steered message only at its next step, and
// reports the plan's 5-hour quota). e2e-autopause.test.mjs covers the Server
// API route with a machine whose conversation is owned by nobody; this file
// is the same promises with `owner: 'tui', controllable: true`, where the
// hub types into the terminal and must never post to Kimi's prompt API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-terminal-autopause-'));
const PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'tap-token';
const MID = 'm_term';
const KID = 'session_term1'; // in a controllable terminal
const KID_DS = 'session_term_ds'; // in a terminal; ends up on a DeepSeek model
const DS_MODEL = 'agent-hub-deepseek/deepseek-v4.1-flash';
let hub;
let machine;

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- the fake machine

function fakeMachine(key) {
  const k = {
    busy: false,
    turn: 0,
    typed: [], // every kimi.tui.input the hub sent: { action, text?, mode? }
    api: [], // every Kimi Server API call: `METHOD path`
    held: [], // steered texts Kimi has not read yet (it reads at its next step)
    holdSteer: true,
    controllable: true, // what the bridge reports for KID
    win: { used: 0.5, resetAt: Date.now() + 3600_000, next: 0.05 },
    frames: [],
    model: 'fake/fake-1',
    extra: [], // other conversations the machine lists (never attached)
  };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const entry = (id = KID) => ({ id, title: '終端機裡的對話', metadata: { cwd: '/tmp/project' }, busy: id === KID ? k.busy : false, pending_interaction: 'none', last_turn_reason: 'completed', updated_at: new Date().toISOString(), owner: 'tui', controllable: id === KID ? k.controllable : true, guess: false, model: id === KID ? k.model : 'fake/fake-1' });
  const frame = (type, payload, id = KID) => {
    const f = { type, session_id: id, time: Date.now(), payload: { agentId: 'main', ...payload, sessionId: id } };
    k.frames.push(f);
    send({ t: 'kimi.event', frame: f });
  };
  const work = (busy) => frame('event.session.work_changed', { busy, main_turn_active: busy, pending_interaction: 'none', last_turn_reason: busy ? undefined : 'completed' });
  k.startTurn = (text, promptId = `k_${Math.random().toString(36).slice(2, 8)}`) => {
    k.busy = true;
    k.turn++;
    frame('turn.started', { turnId: `t${k.turn}`, promptId, origin: { kind: 'user' }, prompt: text });
    work(true);
  };
  k.endTurn = () => {
    frame('turn.ended', { turnId: `t${k.turn}`, reason: 'completed' });
    k.busy = false;
    work(false);
  };
  // Kimi reads what it was handed at its next step.
  k.read = (text) => frame('turn.steer', { turnId: `t${k.turn}`, input: [{ type: 'text', text }], promptIds: [`kimi_msg_${Math.random().toString(36).slice(2, 8)}`] });
  k.releaseHeld = () => k.held.splice(0).forEach((t) => k.read(t));
  k.frame = frame;
  k.sendSessions = () => send({ t: 'kimi.sessions', items: [entry(), entry(KID_DS), ...k.extra] });
  const usage = () => {
    if (Date.now() >= k.win.resetAt) k.win = { used: k.win.next, resetAt: Date.now() + 5 * 3600_000, next: 0.05 };
    const iso = (t) => new Date(t).toISOString();
    return { kind: 'ok', quota: { usages: { limit5h: { usedRatio: k.win.used, resetAt: iso(k.win.resetAt) }, limit7d: { usedRatio: 0.2, resetAt: iso(Date.now() + 90 * 3600_000) } }, extraUsage: null } };
  };
  const info = (id) => ({ ...entry(id), model: id === KID_DS ? k.dsModel || 'fake/fake-1' : k.model });
  const request = (method, p, body) => {
    k.api.push(`${method} ${p}`);
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') return ok({ default_model: 'fake/fake-1' });
    if (p === '/api/v1/models') return ok({ items: [{ model: 'fake/fake-1', display_name: 'Fake', capabilities: [], max_context_size: 128000 }] });
    if (p === '/api/v1/oauth/usage') return ok(usage());
    if (/\/skills$/.test(p)) return ok({ skills: [] });
    if (/\/tasks$/.test(p)) return ok({ items: [] });
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'fake-terminal-machine', platform: 'test', bridgeVersion: '0.3.0', home: '/home/fake', status });
    k.sendSessions();
  });
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t !== 'req') return;
    const a = m.args || {};
    let out;
    switch (m.op) {
      case 'kimi.status':
      case 'kimi.start':
        out = status;
        break;
      case 'kimi.info':
        out = info(a.sessionId);
        break;
      case 'kimi.history':
        out = { frames: a.sessionId === KID ? k.frames : [], more: false, before: 0, info: info(a.sessionId) };
        break;
      case 'kimi.request':
        out = request(a.method, a.path, a.body);
        break;
      case 'kimi.tui.input': {
        k.typed.push({ action: a.action, text: a.text, mode: a.mode, sessionId: a.sessionId });
        if (a.sessionId === KID) {
          if (a.action === 'send') {
            if (a.mode === 'steer') {
              if (k.holdSteer) k.held.push(a.text);
              else setTimeout(() => k.read(a.text), 20);
            } else setTimeout(() => k.startTurn(a.text), 20);
          }
          // Ctrl+B: what Kimi waited on goes to the background, so the step is
          // over and what it was handed is read now.
          if (a.action === 'background') setTimeout(() => k.releaseHeld(), 20);
        }
        out = { ok: true };
        break;
      }
      case 'kimi.usage':
        out = { ok: false };
        break;
      default:
        out = { ok: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  k.texts = () => k.typed.filter((x) => x.action === 'send').map((x) => x.text);
  k.backgrounds = () => k.typed.filter((x) => x.action === 'background').length;
  k.promptPosts = () => k.api.filter((x) => /^POST .*\/prompts$/.test(x));
  return k;
}

before(async () => {
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_AUTOPAUSE_SCALE: '0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start:\n${out}`)), 15000);
    const on = (d) => {
      out += d;
      if (out.includes('已啟動')) (clearTimeout(t), resolve());
    };
    hub.stdout.on('data', on);
    hub.stderr.on('data', on);
  });
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  machine = fakeMachine(key);
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID && m.online && m.sessions.length), 10000, 'machine online');
});

after(() => {
  machine?.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('auto-pause in a controllable terminal: 「優雅暫停」 and 「繼續」 are typed into it (never posted), an unread pause moves the work aside, a plain steer does not', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID}/attach`);
  const session = () => api('GET', `/sessions/${s.id}`);
  assert.equal((await session()).meta.controllable, true);
  await api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 80 });

  // Kimi works in the terminal, under the mark.
  machine.startTurn('做一個大工程');
  await until(async () => (await session()).status === 'running', 5000, 'running');
  const first = await session();
  assert.equal(first.turnModel, 'fake/fake-1', 'the running turn\'s snapshot, in the summary');
  assert.equal(first.turnProvider, 'kimi');

  // A plain 插隊 from the hub is slipped into the terminal, and never moved to the background.
  await api('POST', `/sessions/${s.id}/messages`, { text: '順便看一下 README', steer: true });
  await until(async () => machine.held.includes('順便看一下 README'), 5000, 'typed into the terminal');
  await sleep(1800); // longer than the (scaled) 10 s wait
  assert.equal(machine.backgrounds(), 0, 'a plain steer is not urgent');
  machine.releaseHeld(); // Kimi reads it at its next step
  await until(async () => (await session()).meta.queue.length === 0, 5000, 'the plain steer was read');

  // Past the mark: 「優雅暫停」 typed into the terminal, in the running turn.
  machine.win = { used: 0.85, resetAt: Date.now() + 8000, next: 0.05 };
  await until(async () => machine.held.includes('優雅暫停'), 10000, '優雅暫停 typed into the terminal');
  const typed = machine.typed.find((x) => x.text === '優雅暫停');
  assert.equal(typed.mode, 'steer');
  assert.deepEqual(machine.promptPosts(), [], 'nothing posted to Kimi\'s prompt API');
  // Taken in but unread: after the wait the foreground work is moved aside (Ctrl+B) and it is read.
  await until(async () => machine.backgrounds() >= 1, 8000, 'the unread 優雅暫停 moved the foreground work to the background');
  const cur = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'paused' && x.meta.queue.length === 0 && x.events.some((e) => e.type === 'user' && e.text === '優雅暫停') && x;
  }, 8000, 'paused, read, shown in the conversation');
  assert.equal(cur.events.filter((e) => e.type === 'user' && e.text === '優雅暫停').length, 1);
  assert.match(cur.events.find((e) => e.type === 'user' && e.text === '優雅暫停').note, /自動暫停：5 小時額度已用 85%（門檻 80%）/);
  assert.ok(cur.events.some((e) => e.type === 'info' && /Ctrl\+B/.test(e.text)), 'said so in the conversation');
  const moved = machine.backgrounds();
  await sleep(1800);
  assert.equal(machine.backgrounds(), moved, 'read, so nothing more is moved');

  // Kimi wraps up; after the window resets, 「繼續」 is typed in as a turn of its own.
  machine.endTurn();
  await until(async () => (await session()).autoPause.wait?.kind === 'reset', 5000, 'waiting for the reset');
  await until(async () => machine.texts().includes('繼續'), 15000, '繼續 typed into the terminal');
  const resume = machine.typed.find((x) => x.text === '繼續');
  assert.equal(resume.mode, 'enter', 'a turn of its own, not slipped into one');
  assert.deepEqual(machine.promptPosts(), [], 'still nothing posted to Kimi\'s prompt API');
  const after = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'watching' && x.status === 'running' && x.events.some((e) => e.type === 'user' && e.text === '繼續') && x;
  }, 8000, 'watching again, running 繼續');
  assert.match(after.events.find((e) => e.type === 'user' && e.text === '繼續').note, /自動送出：5 小時額度已恢復/);
  // The turn 「繼續」 started has its own snapshot (taken when the hub delivered it).
  assert.equal(after.turnProvider, 'kimi');
  assert.ok(after.turnModel, JSON.stringify([after.turnModel, after.meta.turnModel]));
  machine.endTurn();
  await until(async () => (await session()).status === 'idle', 5000, 'idle');
  assert.equal((await session()).turnModel, null, 'no turn, no 本回合');
  await api('POST', `/sessions/${s.id}/autopause`, { enabled: false });
});

test('a conversation not followed yet: rename and archive follow the same routing rule (a guess is never typed into, a controllable terminal is)', async () => {
  const before = machine.typed.length;
  // A controllable terminal is typed into for the title and refuses archiving.
  await api('POST', `/machines/${MID}/kimi/${KID}/title`, { title: '終端機改名' }).catch((e) => e);
  // An untracked one, in the same folder as a terminal but only guessed to be it, even if it claims control.
  machine.extra.push({ id: 'session_guess_tui', title: '猜的', metadata: { cwd: '/tmp/project' }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', updated_at: new Date().toISOString(), owner: 'tui', controllable: true, guess: true });
  machine.sendSessions();
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID).sessions.some((x) => x.id === 'session_guess_tui'), 5000, 'listed');
  machine.api.length = 0;
  await api('POST', `/machines/${MID}/kimi/session_guess_tui/title`, { title: '猜的也走 API' });
  assert.ok(machine.api.includes('POST /api/v1/sessions/session_guess_tui/profile'), machine.api.join(', '));
  assert.equal(machine.typed.slice(before).filter((x) => x.sessionId === 'session_guess_tui').length, 0, 'not typed into');
  await api('POST', `/machines/${MID}/kimi/session_guess_tui/archive`);
  assert.ok(machine.api.includes('POST /api/v1/sessions/session_guess_tui:archive'), machine.api.join(', '));
});

test('a DeepSeek conversation that still has the auto-pause state it had on Kimi can switch it off, but never set it up again', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID_DS}/attach`);
  const session = () => api('GET', `/sessions/${s.id}`);
  assert.equal((await session()).mode, null, 'a Kimi conversation to begin with');
  await until(async () => (await session()).status === 'idle', 5000, 'idle');
  // On Kimi it is set up: auto-pause on, and a 「繼續」 waiting for the reset.
  machine.win = { used: 0.5, resetAt: Date.now() + 3600_000, next: 0.05 };
  await api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 80 });
  await api('POST', `/sessions/${s.id}/autopause`, { resumeAfterReset: true, text: '繼續' });
  assert.equal((await session()).autoPause.phase, 'paused');

  // Then the conversation moves to a DeepSeek model.
  machine.frame('agent.status.updated', { model: DS_MODEL }, KID_DS);
  await until(async () => (await session()).mode === 'deepseek', 5000, 'now DeepSeek');
  const refused = (e) => e.status === 400 && /不用 Kimi 訂閱/.test(e.message);
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 70 }), refused, 'cannot be set up on DeepSeek');
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { resumeAfterReset: true, text: '繼續' }), refused);

  // What is left over can be switched off.
  const called = await api('POST', `/sessions/${s.id}/autopause`, { cancelResume: true });
  assert.equal(called.autoPause.phase, 'watching');
  const off = await api('POST', `/sessions/${s.id}/autopause`, { enabled: false });
  assert.equal(off.autoPause.enabled, false);
  // Nothing left: the old answer.
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { enabled: false }), refused);
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { cancelResume: true }), refused);
});
