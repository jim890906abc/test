// Auto-pause end to end: the real hub, and a scripted machine that speaks
// the bridge protocol and plays Kimi (turns, the prompt queue, steering and
// the plan's 5-hour quota). No Kimi or account needed. Waits are scaled
// down with AGENT_HUB_AUTOPAUSE_SCALE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-autopause-'));
const PORT = 26000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ap-token';
const MID = 'm_fake';
const KID = 'session_fake1';
let hub;
let bridge;

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
// Kimi starts a turn a moment after a message reaches it: end it once it has.
const finishTurn = async () => {
  await until(async () => bridge.busy, 5000, 'Kimi working');
  bridge.endTurn();
};

// ------------------------------------------------------- the fake machine

function fakeMachine(key) {
  const k = {
    busy: false,
    turn: 0,
    prompts: [], // { promptId, text, at }
    steers: [], // prompt ids
    frames: [], // everything sent, for kimi.history
    win: { used: 0.5, resetAt: Date.now() + 3600_000, next: 0.05 },
  };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const entry = () => ({ id: KID, title: '大工程', metadata: { cwd: '/tmp/project' }, busy: k.busy, pending_interaction: 'none', last_turn_reason: 'completed', updated_at: new Date().toISOString(), owner: null, controllable: null });
  const frame = (type, payload) => {
    const f = { type, session_id: KID, time: Date.now(), payload: { agentId: 'main', ...payload, sessionId: KID } };
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
  // The plan's quota, the way Kimi's server reports it; a new window
  // starts when the reset time passes.
  const usage = () => {
    if (Date.now() >= k.win.resetAt) k.win = { used: k.win.next, resetAt: Date.now() + 5 * 3600_000, next: 0.05 };
    const iso = (t) => new Date(t).toISOString();
    return { kind: 'ok', quota: { usages: { limit5h: { usedRatio: k.win.used, resetAt: iso(k.win.resetAt) }, limit7d: { usedRatio: 0.2, resetAt: iso(Date.now() + 90 * 3600_000) } }, extraUsage: null } };
  };
  const info = () => ({ id: KID, title: '大工程', metadata: { cwd: '/tmp/project' }, busy: k.busy, pending_interaction: 'none', last_turn_reason: 'completed', owner: null, controllable: null });
  const request = (method, p, body) => {
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') return ok({ default_model: 'fake/fake-1' });
    if (p === '/api/v1/models') return ok({ items: [{ model: 'fake/fake-1', display_name: 'Fake', capabilities: [], max_context_size: 128000 }] });
    if (p === '/api/v1/oauth/usage') return ok(usage());
    if (p === `/api/v1/sessions/${KID}/skills`) return ok({ skills: [] });
    if (method === 'POST' && p === `/api/v1/sessions/${KID}/prompts`) {
      const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      k.prompts.push({ promptId: body.prompt_id, text, at: Date.now(), busy: k.busy });
      if (k.busy) return ok({ prompt_id: body.prompt_id, status: 'queued' });
      setTimeout(() => k.startTurn(text, body.prompt_id), 20);
      return ok({ prompt_id: body.prompt_id, status: 'started' });
    }
    const steer = p.match(/\/prompts\/([\w-]+):steer$/);
    if (method === 'POST' && steer) {
      k.steers.push(steer[1]);
      const q = k.prompts.find((x) => x.promptId === steer[1]);
      setTimeout(() => frame('turn.steer', { turnId: `t${k.turn}`, input: [{ type: 'text', text: q?.text || '' }], promptIds: [steer[1]] }), 20);
      return ok({});
    }
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'fake-machine', platform: 'test', bridgeVersion: '0.3.0', home: '/home/fake', status });
    send({ t: 'kimi.sessions', items: [entry()] });
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
        out = info();
        break;
      case 'kimi.history':
        out = { frames: k.frames, more: false, before: 0, info: info() };
        break;
      case 'kimi.request':
        out = request(a.method, a.path, a.body);
        break;
      default:
        out = { ok: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => ws.close();
  k.texts = () => k.prompts.map((x) => x.text);
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
  bridge = fakeMachine(key);
  await bridge.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === MID && m.online && m.sessions.length), 10000, 'machine online');
});

after(() => {
  bridge?.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('auto-pause: 「優雅暫停」 at the mark, 「繼續」 after the 5-hour reset; a message in between calls it off', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID}/attach`);
  const session = () => api('GET', `/sessions/${s.id}`);

  // Settings are checked; on, at 80%.
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 0 }), (e) => e.status === 400);
  await assert.rejects(api('POST', `/sessions/${s.id}/autopause`, { cancelResume: true }), (e) => e.status === 409);
  const on = await api('POST', `/sessions/${s.id}/autopause`, { enabled: true, threshold: 80 });
  assert.equal(on.autoPause.enabled, true);
  assert.equal(on.autoPause.threshold, 80);
  // Kept with the conversation on disk (written in the background).
  await until(async () => JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'sessions', `${s.id}.json`), 'utf8')).autoPause?.enabled, 5000, 'saved');

  // Kimi works under the mark: nothing.
  bridge.startTurn('做一個大工程');
  await until(async () => (await session()).status === 'running', 5000, 'running');
  await sleep(2500);
  assert.deepEqual(bridge.texts(), []);

  // Past the mark: 「優雅暫停」, slipped into the running turn. This window
  // resets a few seconds from now.
  bridge.win = { used: 0.85, resetAt: Date.now() + 7000, next: 0.05 };
  await until(async () => bridge.prompts.find((x) => x.text === '優雅暫停'), 10000, '優雅暫停');
  const pause = bridge.prompts.find((x) => x.text === '優雅暫停');
  assert.equal(pause.busy, true);
  await until(async () => bridge.steers.includes(pause.promptId), 5000, 'steered');
  let cur = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'paused' && x.events.some((e) => e.type === 'user' && e.text === '優雅暫停') && x;
  }, 5000, 'paused, shown in the conversation');
  const bubble = cur.events.find((e) => e.type === 'user' && e.text === '優雅暫停');
  assert.equal(bubble.steered, true);
  assert.match(bubble.note, /自動暫停：5 小時額度已用 85%（門檻 80%）/);
  assert.equal(bridge.prompts.filter((x) => x.text === '優雅暫停').length, 1);

  // Rebuilt from Kimi's journal, the message keeps its note.
  await api('POST', `/machines/${MID}/kimi/${KID}/attach`);
  cur = await session();
  assert.match(cur.events.find((e) => e.type === 'user' && e.text === '優雅暫停')?.note || '', /自動暫停/);

  // Kimi wraps up, then the window resets.
  bridge.endTurn();
  await until(async () => (await session()).autoPause.wait?.kind === 'reset', 5000, 'waiting for the reset');
  assert.deepEqual(bridge.texts(), ['優雅暫停']);
  await until(async () => bridge.prompts.find((x) => x.text === '繼續'), 15000, '繼續');
  const resume = bridge.prompts.find((x) => x.text === '繼續');
  assert.equal(resume.busy, false);
  assert.ok(!bridge.steers.includes(resume.promptId), 'a turn of its own');
  cur = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'watching' && x.events.some((e) => e.type === 'user' && e.text === '繼續') && x;
  }, 5000, 'watching again');
  assert.match(cur.events.find((e) => e.type === 'user' && e.text === '繼續').note, /自動送出：5 小時額度已恢復/);
  // Its own 「繼續」 running is not someone taking over.
  await sleep(1500);
  assert.equal((await session()).autoPause.phase, 'watching');
  assert.ok(!(await session()).autoPause.log.some((l) => /取消自動/.test(l.text)));
  await finishTurn();
  await until(async () => (await session()).status === 'idle', 5000, 'idle');

  // The next window: paused again, then a message from the hub (someone
  // took over) calls off 「繼續」.
  bridge.win = { used: 0.9, resetAt: Date.now() + 8000, next: 0.05 };
  bridge.startTurn('再做一個');
  await until(async () => bridge.prompts.filter((x) => x.text === '優雅暫停').length === 2, 10000, 'second 優雅暫停');
  bridge.endTurn();
  await until(async () => (await session()).autoPause.settled, 5000, 'settled');
  await api('POST', `/sessions/${s.id}/messages`, { text: '先問一下進度' });
  cur = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'watching' && x;
  }, 5000, 'called off');
  assert.ok(cur.autoPause.log.some((l) => /取消自動「繼續」/.test(l.text)));
  assert.ok(cur.events.some((e) => e.type === 'info' && /不會自動送出「繼續」/.test(e.text)));
  await finishTurn();
  await sleep(6000); // past the reset
  assert.equal(bridge.prompts.filter((x) => x.text === '繼續').length, 1, 'no second 繼續');

  // Off.
  const off = await api('POST', `/sessions/${s.id}/autopause`, { enabled: false });
  assert.equal(off.autoPause.enabled, false);
});

test('額度恢復後送出, set by hand after pausing Kimi yourself; 定時送出 at a time', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID}/attach`);
  const session = () => api('GET', `/sessions/${s.id}`);
  assert.equal((await session()).autoPause.enabled, false, 'auto-pause is off');
  await until(async () => (await session()).status === 'idle', 5000, 'idle');
  const before = bridge.prompts.length;

  // Kimi was stopped by hand at 60%: under any mark, so only a reset counts.
  bridge.win = { used: 0.6, resetAt: Date.now() + 5000, next: 0.02 };
  const armed = await api('POST', `/sessions/${s.id}/autopause`, { resumeAfterReset: true, text: '請接著做' });
  assert.equal(armed.autoPause.phase, 'paused');
  assert.equal(armed.autoPause.reason, 'manual');
  await sleep(3000);
  assert.equal(bridge.prompts.length, before, 'not before the reset');
  await until(async () => bridge.prompts.find((x) => x.text === '請接著做'), 15000, '請接著做');
  const cur = await until(async () => {
    const x = await session();
    return x.autoPause.phase === 'watching' && x.events.some((e) => e.type === 'user' && e.text === '請接著做') && x;
  }, 5000, 'sent');
  assert.match(cur.events.find((e) => e.type === 'user' && e.text === '請接著做').note, /5 小時額度已恢復/);
  await finishTurn();
  await until(async () => (await session()).status === 'idle', 5000, 'idle');

  // 定時送出: checked, cancellable, and sent at its time.
  await assert.rejects(api('POST', `/sessions/${s.id}/schedule`, { text: '', at: Date.now() + 60_000 }), (e) => e.status === 400);
  await assert.rejects(api('POST', `/sessions/${s.id}/schedule`, { text: '太早', at: Date.now() - 600_000 }), (e) => e.status === 400);
  await assert.rejects(api('DELETE', `/sessions/${s.id}/schedule/q_nope`), (e) => e.status === 404);
  const far = await api('POST', `/sessions/${s.id}/schedule`, { text: '明天再說', at: Date.now() + 86_400_000 });
  assert.equal(far.scheduled.length, 1);
  const gone = await api('DELETE', `/sessions/${s.id}/schedule/${far.scheduled[0].id}`);
  assert.equal(gone.scheduled.length, 0);
  const soon = await api('POST', `/sessions/${s.id}/schedule`, { text: '定時測試', at: Date.now() + 1500 });
  assert.equal(soon.scheduled[0].text, '定時測試');
  await sleep(500);
  assert.ok(!bridge.prompts.some((x) => x.text === '定時測試'), 'not before its time');
  await until(async () => bridge.prompts.find((x) => x.text === '定時測試'), 8000, '定時測試');
  const done = await until(async () => {
    const x = await session();
    return !x.scheduled.length && x.events.some((e) => e.type === 'user' && e.text === '定時測試') && x;
  }, 5000, 'sent and removed');
  assert.equal(done.events.find((e) => e.type === 'user' && e.text === '定時測試').note, '定時送出');
  assert.equal(bridge.prompts.filter((x) => x.text === '定時測試').length, 1);
  await finishTurn();
});
