// Terminal Kimi control routing, without a Kimi CLI: a scripted machine
// speaks the bridge protocol and records every request. It proves that an
// uncontrollable terminal, and a terminal queue left over after control is
// gone, use Kimi's Server API and never `kimi.tui.input`; a controllable
// terminal still uses the TUI. DeepSeek sends provision their provider first,
// whichever route they take, and a cached provider costs no extra RPC.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-kimi-terminal-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
// The urgent-message wait (10 s) is read when kimi-remote loads: scale it so
// the tests below can wait for it.
process.env.AGENT_HUB_AUTOPAUSE_SCALE = '0.02';

let kimi;
let machines;
let store;
let deepseek;
let runner;
const bridges = new Map(); // machine id -> its fake bridge socket
const sessionInfo = new Map(); // Kimi session id -> the bridge's info() answer
const calls = []; // { op, args } the hub sent to the machines
let onTui = null; // (args) => void; throwing makes that kimi.tui.input fail like the bridge does
let taskItems = []; // what GET …/tasks lists
let promptStatus = 'started'; // what POST …/prompts answers: 'queued' when Kimi is busy
let promptError = null; // when set, POST …/prompts fails with this message

const KID = 'session_terminal_unit';
const MID = 'm_terminal_unit';

// The machine side: answers the bridge ops kimi-remote uses while attaching,
// and the Kimi Server API envelope for every request it is asked to make.
// Each machine needs its own socket: the bridge protocol keys replies by the
// socket, like one connector per computer.
function fakeBridge(machine) {
  if (bridges.has(machine)) return bridges.get(machine);
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req') return;
    calls.push({ op: msg.op, args: msg.args });
    if (msg.op === 'kimi.tui.input' && onTui) {
      try {
        onTui(msg.args);
      } catch (err) {
        queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: false, error: err.message })));
        return;
      }
    }
    let data = {};
    if (msg.op === 'kimi.request') {
      const { method, path: p } = msg.args;
      if (method === 'GET' && p === '/api/v1/config') data = { code: 0, data: { default_model: 'fake' } };
      else if (method === 'GET' && p === '/api/v1/models') data = { code: 0, data: { items: [] } };
      else if (method === 'GET' && /\/skills$/.test(p)) data = { code: 0, data: { skills: [] } };
      else if (method === 'GET' && /\/tasks$/.test(p)) data = { code: 0, data: { items: taskItems } };
      else if (method === 'GET' && /\/approvals/.test(p)) data = { code: 0, data: { items: [] } };
      else if (method === 'POST' && /\/prompts$/.test(p)) data = promptError ? { code: 50000, msg: promptError } : { code: 0, data: { status: promptStatus } };
      else data = { code: 0, data: {} };
    } else if (msg.op === 'kimi.history') {
      const info = sessionInfo.get(msg.args.sessionId);
      data = { frames: [], more: false, before: 0, info };
    } else if (msg.op === 'kimi.deepseek.provision') {
      data = { ok: true, created: true, models: ['agent-hub-deepseek/deepseek-v4.1-flash'], sessionHeader: true };
    }
    queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: true, data })));
  };
  machines.attachBridge(ws);
  ws.emit(
    'message',
    JSON.stringify({
      t: 'hello',
      machineId: machine,
      name: machine,
      platform: 'linux',
      home: TMP,
      bridgeVersion: '0.9.1',
      broker: 1,
      status: { available: true, server: true, version: '2.3.1' },
    }),
  );
  bridges.set(machine, ws);
  return ws;
}

function contextFor(session) {
  return {
    session,
    emit(fields) {
      const ev = { id: `e_${session.events.length}`, ts: Date.now(), ...fields };
      session.events.push(ev);
      return ev;
    },
    patch(ev, fields) {
      Object.assign(ev, fields);
    },
    delta(ev, text, field = 'text') {
      ev[field] = (ev[field] || '') + text;
    },
    setStatus(st) {
      session.status = st;
    },
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
    },
    setTitle(title) {
      session.title = title;
    },
    replaceEvents(events) {
      session.events = events;
    },
  };
}

async function makeSession({ id, kid, machine = MID, controllable = false, guess = false, mode = null, model = 'fake', extra = {} }) {
  fakeBridge(machine);
  const m = machines.getMachine(machine);
  m.sessions = [{ id: kid, title: '終端機對話', owner: 'tui', controllable, guess, busy: false, pending: 'none' }];
  sessionInfo.set(kid, {
    id: kid,
    title: '終端機對話',
    owner: 'tui',
    controllable,
    guess,
    busy: false,
    pending_interaction: 'none',
    last_turn_reason: 'completed',
    model,
    permission: 'manual',
    workspace_id: 'ws',
    todos: [],
  });
  const session = store.createSession({
    id,
    machineId: machine,
    kimiSessionId: kid,
    agentId: `kimi@${machine}`,
    title: '終端機對話',
    status: 'idle',
    meta: { owner: 'tui', controllable, guess, model },
    ...(mode ? { mode, provider: 'deepseek' } : {}),
    ...extra,
  });
  kimi.init((s) => contextFor(s));
  kimi.restore(session);
  await kimi.attach(session);
  return session;
}

const tuiCalls = () => calls.filter((c) => c.op === 'kimi.tui.input');
const apiCalls = () => calls.filter((c) => c.op === 'kimi.request');
const apiPaths = () => apiCalls().map((c) => `${c.args.method} ${c.args.path}`);
const reset = () => calls.splice(0);
// Frames Kimi's server pushes, as the bridge relays them.
const frame = (machine, kid, type, payload = {}) => bridges.get(machine).emit('message', JSON.stringify({ t: 'kimi.event', frame: { session_id: kid, type, payload } }));
const working = (machine, kid, busy) => frame(machine, kid, 'event.session.work_changed', { busy, last_turn_reason: busy ? undefined : 'completed' });
const endTurn = (machine, kid) => {
  frame(machine, kid, 'turn.ended', { reason: 'completed' });
  working(machine, kid, false);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const userEvents = (session, text) => session.events.filter((e) => e.type === 'user' && e.text === text);
const posted = () => apiCalls().filter((c) => /\/prompts$/.test(c.args.path));
const backgroundCalls = () => tuiCalls().filter((c) => c.args.action === 'background');

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  kimi = await import('../server/adapters/kimi-remote.js');
  deepseek = await import('../server/deepseek-account.js');
  runner = await import('../server/runner.js');
});

after(async () => {
  for (const ws of bridges.values()) ws.emit('close');
  store.flushAll();
  // Let the last sliced writes finish before the temporary folder goes.
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('an uncontrollable terminal uses the server API for every action, never the TUI', async () => {
  reset();
  const session = await makeSession({ id: 's_terminal_api', kid: KID });
  assert.equal(session.meta.controllable, false);
  assert.equal(kimi.cannotSend(session), null);
  reset();

  const sent = await kimi.send(session, '聊天 從 API 送');
  assert.equal(sent.ok, true);
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}/prompts`), apiPaths().join(', '));

  reset();
  await kimi.configure(session, { model: 'fake', effort: 'on', permission: 'auto', planMode: true });
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}/profile`), apiPaths().join(', '));

  reset();
  await kimi.interrupt(session);
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}:abort`), apiPaths().join(', '));

  reset();
  const ev = { id: 'ap_ev', approvalId: 'ap_1', permission: { kind: 'approval', options: [], chosen: null } };
  session.events.push(ev);
  assert.equal(await kimi.respond(session, ev.id, 'approved'), true);
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}/approvals/ap_1`), apiPaths().join(', '));

  reset();
  await kimi.command(session, 'compact');
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}:compact`), apiPaths().join(', '));

  // Archiving is not refused merely because a terminal still has it open.
  reset();
  await kimi.command(session, 'archive');
  assert.ok(apiPaths().includes(`POST /api/v1/sessions/${KID}:archive`), apiPaths().join(', '));

  reset();
  const bg = await kimi.moveToBackground(session);
  assert.deepEqual(bg, { moved: 0 });
  assert.ok(apiPaths().includes(`GET /api/v1/sessions/${KID}/tasks`), apiPaths().join(', '));

  assert.equal(tuiCalls().length, 0, JSON.stringify(tuiCalls()));
  kimi.dispose(session);
});

test('a terminal queue left over after control is lost is delivered over the API', async () => {
  reset();
  const session = await makeSession({ id: 's_terminal_stale', kid: 'session_terminal_stale' });
  session.status = 'idle';
  session.meta = {
    ...session.meta,
    queue: [{ promptId: 'tui_stale', text: '聊天 舊終端排隊', images: [], terminal: true, steered: false }],
  };
  reset();

  // The turn ends while the terminal is no longer controllable.
  bridges.get(MID).emit('message', JSON.stringify({ t: 'kimi.event', frame: { session_id: 'session_terminal_stale', type: 'turn.ended', payload: { reason: 'completed' } } }));
  const end = Date.now() + 3000;
  while (Date.now() < end && !apiPaths().some((p) => p === 'POST /api/v1/sessions/session_terminal_stale/prompts')) await new Promise((r) => setTimeout(r, 50));

  assert.ok(apiPaths().includes('POST /api/v1/sessions/session_terminal_stale/prompts'), apiPaths().join(', '));
  const posted = apiCalls().find((c) => c.args.path === '/api/v1/sessions/session_terminal_stale/prompts');
  assert.match(JSON.stringify(posted.args.body), /聊天 舊終端排隊/);
  assert.equal(tuiCalls().length, 0, JSON.stringify(tuiCalls()));
  assert.equal(session.meta.queue.length, 0);
  kimi.dispose(session);
});

test('a terminal whose controllable state is unknown is not driven through the TUI', async () => {
  reset();
  const session = await makeSession({ id: 's_terminal_unknown', kid: 'session_terminal_unknown', machine: 'm_unknown', controllable: true });
  // The live entry says nothing about control, even though an earlier meta
  // snapshot used to say true: null/missing is not control.
  machines.getMachine('m_unknown').sessions[0].controllable = null;
  session.meta = { ...session.meta, owner: 'tui', controllable: true };
  reset();

  assert.equal((await kimi.send(session, '聊天 未知控制')).ok, true);
  assert.ok(apiPaths().includes('POST /api/v1/sessions/session_terminal_unknown/prompts'), apiPaths().join(', '));
  assert.equal(tuiCalls().length, 0, JSON.stringify(tuiCalls()));
  kimi.dispose(session);
});

test('a controllable terminal still uses the TUI, and archiving there is still refused', async () => {
  reset();
  const session = await makeSession({ id: 's_terminal_tui', kid: 'session_terminal_tui', controllable: true });
  assert.equal(session.meta.controllable, true);
  reset();

  assert.deepEqual(await kimi.send(session, '聊天 用終端機'), { ok: true });
  assert.equal(tuiCalls().length, 1);
  assert.equal(apiCalls().filter((c) => /\/prompts$/.test(c.args.path)).length, 0);

  reset();
  await kimi.configure(session, { model: 'fake', effort: 'on' });
  assert.ok(tuiCalls().length >= 2, JSON.stringify(tuiCalls()));
  assert.equal(apiCalls().length, 0);

  reset();
  await kimi.interrupt(session);
  assert.equal(tuiCalls().length, 1);
  assert.equal(apiCalls().length, 0);

  reset();
  const ev = { id: 'tui_ap', approvalId: 'ap_tui', permission: { kind: 'approval', options: [], chosen: null } };
  session.events.push(ev);
  assert.equal(await kimi.respond(session, ev.id, 'approved'), true);
  assert.equal(tuiCalls().length, 1);
  assert.equal(apiCalls().length, 0);

  reset();
  await kimi.command(session, 'compact');
  assert.equal(tuiCalls().length, 1);
  assert.equal(apiCalls().length, 0);

  reset();
  await kimi.moveToBackground(session);
  assert.equal(tuiCalls().length, 1);
  assert.equal(apiCalls().length, 0);

  reset();
  await assert.rejects(kimi.command(session, 'archive'), (e) => e.status === 409);
  assert.equal(tuiCalls().length, 0);
  assert.equal(apiCalls().length, 0);
  kimi.dispose(session);
});

test('DeepSeek sends provision the provider first on both routes, and a cached one costs no RPC', async () => {
  const DS_MODEL = 'agent-hub-deepseek/deepseek-v4.1-flash';
  const dsExtra = {
    provider: 'deepseek',
    mode: 'deepseek',
    modelConfig: { provider: 'deepseek', model: DS_MODEL, effort: 'max' },
    state: { userSet: { model: true, effort: true }, promptModel: true, deepseek: { gateway: 'opencode-go', model: DS_MODEL } },
  };

  // Connect before adding the key so this case exercises the explicit send
  // path rather than the independent automatic hello provision.
  reset();
  const api = await makeSession({ id: 's_ds_api', kid: 'session_ds_api', machine: 'm_ds_api', mode: 'deepseek', model: DS_MODEL, extra: dsExtra });
  deepseek.setKey('opencode-go', 'sk-unit-test-key');
  reset();
  assert.equal((await kimi.send(api, '聊天 DS API 一')).ok, true);
  assert.equal(calls.filter((c) => c.op === 'kimi.deepseek.provision').length, 1, JSON.stringify(calls));
  assert.ok(apiPaths().includes('POST /api/v1/sessions/session_ds_api/prompts'), apiPaths().join(', '));
  assert.equal(calls.filter((c) => c.op === 'kimi.start').length, 0);

  reset();
  assert.equal((await kimi.send(api, '聊天 DS API 二')).ok, true);
  assert.equal(calls.filter((c) => c.op === 'kimi.deepseek.provision').length, 0, 'cached provider must not be re-provisioned');
  assert.equal(tuiCalls().length, 0);

  // The TUI route also starts without a key at hello, then provisions before
  // typing into the terminal; the second send adds no provisioning RPC.
  reset();
  deepseek.clearKey('opencode-go');
  const tui = await makeSession({ id: 's_ds_tui', kid: 'session_ds_tui', machine: 'm_ds_tui', controllable: true, mode: 'deepseek', model: DS_MODEL, extra: dsExtra });
  deepseek.setKey('opencode-go', 'sk-unit-test-key');
  reset();
  assert.deepEqual(await kimi.send(tui, '聊天 DS TUI 一'), { ok: true });
  const order = calls.map((c) => c.op);
  assert.ok(order.indexOf('kimi.deepseek.provision') !== -1, order.join(', '));
  assert.ok(order.indexOf('kimi.deepseek.provision') < order.indexOf('kimi.tui.input'), order.join(', '));
  assert.equal(apiCalls().filter((c) => /\/prompts$/.test(c.args.path)).length, 0);

  reset();
  assert.deepEqual(await kimi.send(tui, '聊天 DS TUI 二', { steer: true }), { ok: true });
  assert.equal(calls.filter((c) => c.op === 'kimi.deepseek.provision').length, 0, 'cached provider must not be re-provisioned');
  assert.equal(tuiCalls().length, 1);

  // A Kimi conversation is unaffected: no provisioning at all.
  reset();
  const plain = await makeSession({ id: 's_plain', kid: 'session_plain', machine: 'm_plain' });
  reset();
  assert.equal((await kimi.send(plain, '聊天 Kimi')).ok, true);
  assert.equal(calls.filter((c) => c.op === 'kimi.deepseek.provision').length, 0);
  kimi.dispose(api);
  kimi.dispose(tui);
  kimi.dispose(plain);
});

// ------------------------------------------------ the routing rule itself

test('canDriveTerminal: only the machine\'s current entry, exactly a controllable terminal; anything unknown is not control', async () => {
  const mid = 'm_contract';
  const kid = 'session_contract';
  fakeBridge(mid);
  const m = machines.getMachine(mid);
  const drive = (entry) => {
    m.sessions = entry ? [{ id: kid, ...entry }] : [];
    return kimi.canDriveTerminal(mid, kid);
  };
  assert.equal(drive({ owner: 'tui', controllable: true, guess: false }), true);
  assert.equal(drive({ owner: 'tui', controllable: true }), true, 'no guess flag is not a guess');
  // Unknown is not control.
  assert.equal(drive(null), false, 'no entry on the machine');
  assert.equal(drive({ owner: 'tui', controllable: null }), false);
  assert.equal(drive({ owner: 'tui' }), false, 'control not reported at all');
  assert.equal(drive({ owner: 'tui', controllable: false }), false);
  assert.equal(drive({ owner: 'tui', controllable: 'true' }), false, 'only boolean true');
  assert.equal(drive({ owner: 'tui', controllable: 1 }), false);
  assert.equal(drive({ owner: 'tui', controllable: true, guess: true }), false, 'a guess in the same folder is never control');
  assert.equal(drive({ owner: null, controllable: true }), false, 'not a terminal');
  assert.equal(drive({ owner: 'server', controllable: true }), false);
  assert.equal(drive({ controllable: true }), false);
  // Another conversation\'s entry, or another machine, is not this one\'s.
  m.sessions = [{ id: 'session_other', owner: 'tui', controllable: true }];
  assert.equal(kimi.canDriveTerminal(mid, kid), false);
  assert.equal(kimi.canDriveTerminal('m_nobody', kid), false);
  assert.equal(kimi.canDriveTerminal(mid, undefined), false);
  assert.equal(kimi.canDriveTerminal(undefined, undefined), false);
});

test('a conversation whose machine entry is missing, or a guess, is driven over the API for every action, whatever its saved meta says', async () => {
  for (const kind of ['missing', 'guess']) {
    reset();
    const mid = `m_route_${kind}`;
    const kid = `session_route_${kind}`;
    // The saved meta still says the terminal was controllable.
    const session = await makeSession({ id: `s_route_${kind}`, kid, machine: mid, controllable: true });
    const m = machines.getMachine(mid);
    if (kind === 'missing') m.sessions = [];
    else Object.assign(m.sessions[0], { controllable: true, guess: true });
    assert.equal(session.meta.controllable, true, 'the stale snapshot is what this case is about');
    reset();

    assert.equal((await kimi.send(session, `${kind} send`)).ok, true);
    await kimi.configure(session, { model: 'fake', effort: 'on' });
    await kimi.interrupt(session);
    await kimi.command(session, 'compact');
    await kimi.moveToBackground(session);
    const ev = { id: `ap_${kind}`, approvalId: `ap_${kind}`, permission: { kind: 'approval', options: [], chosen: null } };
    session.events.push(ev);
    assert.equal(await kimi.respond(session, ev.id, 'approved'), true);

    assert.equal(tuiCalls().length, 0, `${kind}: ${JSON.stringify(tuiCalls())}`);
    const paths = apiPaths();
    for (const want of [`POST /api/v1/sessions/${kid}/prompts`, `POST /api/v1/sessions/${kid}/profile`, `POST /api/v1/sessions/${kid}:abort`, `POST /api/v1/sessions/${kid}:compact`, `GET /api/v1/sessions/${kid}/tasks`, `POST /api/v1/sessions/${kid}/approvals/${ev.approvalId}`]) {
      assert.ok(paths.includes(want), `${kind}: missing ${want} in ${paths.join(', ')}`);
    }
    kimi.dispose(session);
  }
});

// ----------------------------------------- terminal queue: no silent loss

async function heldTerminalMessage(tag, text) {
  const mid = `m_${tag}`;
  const kid = `session_${tag}`;
  const session = await makeSession({ id: `s_${tag}`, kid, machine: mid, controllable: true });
  working(mid, kid, true);
  assert.equal(session.status, 'running');
  await kimi.send(session, text);
  assert.equal(session.meta.queue.length, 1, 'held until the turn ends');
  assert.equal(tuiCalls().length, 0, 'held, not typed');
  return { mid, kid, session, entry: machines.getMachine(mid).sessions[0] };
}

test('a held terminal message the TUI refuses at the flush is not lost: the terminal lost control meanwhile, so it goes over the API', async () => {
  reset();
  const { mid, kid, session, entry } = await heldTerminalMessage('flush_a', '聊天 held a');
  reset();
  // Between the decision and the typing, control is gone (the bridge refuses).
  onTui = () => {
    entry.controllable = false;
    throw new Error('這個對話正在終端機的 Kimi 裡執行，但那個 Kimi 不是用 kimi-hub 啟動的');
  };
  try {
    endTurn(mid, kid);
    await until(() => posted().length, 4000, 'the held message re-routed over the API');
  } finally {
    onTui = null;
  }
  assert.equal(tuiCalls().length, 1, 'the one refused attempt');
  assert.match(JSON.stringify(posted()[0].args.body), /聊天 held a/);
  assert.equal(session.meta.queue.length, 0);
  assert.equal(userEvents(session, '聊天 held a').length, 1, 'shown once, as sent');
  kimi.dispose(session);
});

test('a held terminal message the TUI refuses while control still looks fine stays queued with an error shown, and can be retried', async () => {
  reset();
  const { mid, kid, session } = await heldTerminalMessage('flush_b', '聊天 held b');
  const tuiId = session.meta.queue[0].promptId;
  reset();
  onTui = () => {
    throw new Error('終端機沒有回應');
  };
  try {
    endTurn(mid, kid);
    await until(() => session.events.some((e) => e.type === 'error'), 4000, 'an error shown');
  } finally {
    onTui = null;
  }
  assert.match(session.events.find((e) => e.type === 'error').text, /終端機沒有回應/);
  assert.equal(posted().length, 0, 'not silently sent another way while the terminal is still believed controllable');
  assert.equal(session.meta.queue.length, 1, 'the message is still there');
  assert.equal(session.meta.queue[0].promptId, tuiId);
  assert.equal(!!session.meta.queue[0].steered, false, 'not marked as typed');
  assert.equal(kimi.isBusy(session), true, 'it is still waiting');

  // Retry (the tray\'s 插隊 / send button): typed now, and Kimi starting its turn shows it once.
  reset();
  await kimi.steerQueued(session, tuiId);
  assert.equal(tuiCalls().length, 1);
  assert.equal(tuiCalls()[0].args.text, '聊天 held b');
  frame(mid, kid, 'turn.started', { turnId: 't1', promptId: 'kimi_p_b', origin: { kind: 'user' }, prompt: '聊天 held b' });
  working(mid, kid, true);
  await sleep(50);
  assert.equal(userEvents(session, '聊天 held b').length, 1);
  assert.equal(session.meta.queue.length, 0);
  endTurn(mid, kid);
  await sleep(50);
  assert.equal(kimi.isBusy(session), false);
  kimi.dispose(session);
});

test('a stale terminal queue delivered over the API shows its message once and leaves nothing waiting (turn.started included)', async () => {
  reset();
  const { mid, kid, session, entry } = await heldTerminalMessage('stale_c', '聊天 stale c');
  entry.controllable = false; // control lost while it was held
  reset();
  endTurn(mid, kid);
  await until(() => posted().length, 4000, 'delivered over the API');
  assert.equal(tuiCalls().length, 0);
  const pid = posted()[0].args.body.prompt_id;
  // Kimi starts the turn for that prompt.
  frame(mid, kid, 'turn.started', { turnId: 't2', promptId: pid, origin: { kind: 'user' }, prompt: '聊天 stale c' });
  await sleep(100);
  const shown = userEvents(session, '聊天 stale c');
  assert.equal(shown.length, 1, JSON.stringify(shown.map((e) => e.promptId)));
  assert.equal(shown[0].promptId, pid);
  assert.equal(session.meta.queue.length, 0);
  endTurn(mid, kid);
  await sleep(50);
  assert.equal(kimi.isBusy(session), false, 'nothing left typed-but-unconfirmed');
  kimi.dispose(session);
});

test('steering a held terminal message after control is lost goes over the API, and Kimi reading it clears it from the queue', async () => {
  reset();
  promptStatus = 'queued';
  try {
    const { mid, kid, session, entry } = await heldTerminalMessage('steer_d', '聊天 steer d');
    const tuiId = session.meta.queue[0].promptId;
    entry.controllable = false;
    reset();
    await kimi.steerQueued(session, tuiId);
    assert.equal(tuiCalls().length, 0);
    assert.equal(posted().length, 1);
    const pid = posted()[0].args.body.prompt_id;
    assert.deepEqual(session.meta.queue.map((q) => q.promptId), [pid], 'only the API entry waits');
    frame(mid, kid, 'turn.steer', { turnId: 't1', input: [{ type: 'text', text: '聊天 steer d' }], promptIds: [pid] });
    await sleep(100);
    assert.equal(userEvents(session, '聊天 steer d').length, 1);
    assert.equal(session.meta.queue.length, 0, 'read, so no longer waiting');
    working(mid, kid, false);
    await sleep(50);
    assert.equal(kimi.isBusy(session), false);
    kimi.dispose(session);
  } finally {
    promptStatus = 'started';
  }
});

test('when the API route does not take a rerouted terminal message either, it is put back with an error shown, and goes out on the next try', async () => {
  reset();
  const { mid, kid, session, entry } = await heldTerminalMessage('reroute_fail', '聊天 reroute fail');
  const tuiId = session.meta.queue[0].promptId;
  entry.controllable = false;
  promptError = 'Kimi 暫時不收';
  try {
    reset();
    endTurn(mid, kid);
    await until(() => session.events.some((e) => e.type === 'error'), 4000, 'the failure shown');
  } finally {
    promptError = null;
  }
  assert.match(session.events.find((e) => e.type === 'error').text, /Kimi 暫時不收/);
  assert.deepEqual(session.meta.queue.map((q) => q.promptId), [tuiId], 'the message is still waiting');
  assert.equal(kimi.isBusy(session), true);
  assert.equal(tuiCalls().length, 0);

  reset();
  await kimi.steerQueued(session, tuiId);
  assert.equal(posted().length, 1);
  assert.match(JSON.stringify(posted()[0].args.body), /聊天 reroute fail/);
  assert.equal(session.meta.queue.some((q) => q.promptId === tuiId), false, 'gone once Kimi took it');
  kimi.dispose(session);
});

test('steering a held terminal message the TUI refuses reports it and leaves it held (not "already typed"), so it can still be cancelled', async () => {
  reset();
  const { mid, kid, session } = await heldTerminalMessage('steer_fail', '聊天 steer fail');
  const tuiId = session.meta.queue[0].promptId;
  onTui = () => {
    throw new Error('終端機關掉了');
  };
  try {
    await assert.rejects(kimi.steerQueued(session, tuiId), /終端機關掉了/);
  } finally {
    onTui = null;
  }
  assert.equal(!!session.meta.queue[0].steered, false);
  await kimi.cancelQueued(session, tuiId); // refused with 409 when it is marked as typed
  assert.equal(session.meta.queue.length, 0);
  working(mid, kid, false);
  assert.equal(kimi.isBusy(session), false, 'nothing left typed-but-unconfirmed either');
  kimi.dispose(session);
});

// ------------------------------------------ 「優雅暫停」: urgent routing

test('an urgent steer into a controllable terminal that stays unread moves the foreground work aside (Ctrl+B) and stops once Kimi reads it', async () => {
  reset();
  const mid = 'm_urg_tui';
  const kid = 'session_urg_tui';
  const session = await makeSession({ id: 's_urg_tui', kid, machine: mid, controllable: true });
  working(mid, kid, true);
  reset();
  await kimi.send(session, '優雅暫停', { steer: true, urgent: true, note: '自動暫停：測試' });
  assert.equal(tuiCalls().length, 1);
  assert.equal(tuiCalls()[0].args.mode, 'steer', 'slipped into the running turn');
  assert.equal(session.meta.queue[0].urgent, true);
  assert.equal(session.meta.queue[0].steered, true);

  await until(() => backgroundCalls().length >= 1, 3000, 'Ctrl+B pressed for the unread urgent message');
  assert.ok(session.events.some((e) => e.type === 'info' && /Ctrl\+B/.test(e.text)), 'said so in the conversation');
  assert.equal(apiPaths().filter((p) => /:detach$/.test(p)).length, 0, 'through the terminal, not the server');

  // Kimi reads it: no more.
  frame(mid, kid, 'turn.steer', { turnId: 't1', input: [{ type: 'text', text: '優雅暫停' }], promptIds: ['kimi_msg_1'] });
  await sleep(50);
  assert.equal(userEvents(session, '優雅暫停').length, 1);
  assert.equal(userEvents(session, '優雅暫停')[0].note, '自動暫停：測試', 'the note it was sent with stays with the message');
  assert.equal(session.meta.queue.length, 0);
  reset();
  await sleep(700);
  assert.equal(backgroundCalls().length, 0, 'read, so nothing more is moved');
  kimi.dispose(session);
});

test('a plain steer or queued message is never moved to the background, on either route', async () => {
  reset();
  // A controllable terminal.
  const mid = 'm_plain_tui';
  const kid = 'session_plain_tui';
  const tui = await makeSession({ id: 's_plain_tui', kid, machine: mid, controllable: true });
  working(mid, kid, true);
  reset();
  await kimi.send(tui, '插隊但不急', { steer: true });
  await kimi.send(tui, '排隊的', {});
  assert.equal(tui.meta.queue.length, 2);
  assert.equal(tui.meta.queue.some((q) => q.urgent), false);

  // An uncontrollable one, over the API.
  const mid2 = 'm_plain_api';
  const kid2 = 'session_plain_api';
  const api = await makeSession({ id: 's_plain_api', kid: kid2, machine: mid2, controllable: false });
  working(mid2, kid2, true);
  promptStatus = 'queued';
  try {
    await kimi.send(api, '插隊但不急', { steer: true });
  } finally {
    promptStatus = 'started';
  }
  assert.equal(api.meta.queue[0].steered, true);
  assert.equal(api.meta.queue.some((q) => q.urgent), false);
  reset();
  await sleep(900); // several waits of the scaled 10 s
  assert.equal(backgroundCalls().length, 0, JSON.stringify(tuiCalls()));
  assert.equal(apiPaths().filter((p) => /\/tasks/.test(p)).length, 0, apiPaths().join(', '));
  kimi.dispose(tui);
  kimi.dispose(api);
});

test('an urgent steer over the API route still looks at the foreground tasks (the positive control for the test above)', async () => {
  reset();
  const mid = 'm_urg_api';
  const kid = 'session_urg_api';
  const api = await makeSession({ id: 's_urg_api', kid, machine: mid, controllable: false });
  working(mid, kid, true);
  promptStatus = 'queued';
  try {
    await kimi.send(api, '優雅暫停', { steer: true, urgent: true });
  } finally {
    promptStatus = 'started';
  }
  reset();
  await until(() => apiPaths().some((p) => /\/tasks$/.test(p)), 3000, 'foreground tasks looked at');
  assert.equal(backgroundCalls().length, 0, 'not through a TUI that is not controllable');
  frame(mid, kid, 'turn.steer', { turnId: 't1', input: [{ type: 'text', text: '優雅暫停' }], promptIds: [api.meta.queue[0].promptId] });
  await sleep(50);
  kimi.dispose(api);
});

test('the wait is decided by the terminal state when it is over: control lost meanwhile means the server route', async () => {
  reset();
  const mid = 'm_urg_flip';
  const kid = 'session_urg_flip';
  const session = await makeSession({ id: 's_urg_flip', kid, machine: mid, controllable: true });
  working(mid, kid, true);
  await kimi.send(session, '優雅暫停', { steer: true, urgent: true });
  machines.getMachine(mid).sessions[0].controllable = false;
  reset();
  await until(() => apiPaths().some((p) => /\/tasks$/.test(p)), 3000, 'the server route');
  assert.equal(backgroundCalls().length, 0);
  kimi.dispose(session);
});

test('after the hub restarts, an 「優雅暫停」 still waiting in the saved queue is watched again and still matches Kimi reading it', async () => {
  reset();
  const mid = 'm_urg_restart';
  const kid = 'session_urg_restart';
  const session = await makeSession({ id: 's_urg_restart', kid, machine: mid, controllable: true });
  working(mid, kid, true);
  await kimi.send(session, '優雅暫停', { steer: true, urgent: true });
  assert.equal(session.meta.queue.length, 1);

  // The hub goes down before the wait is over, and comes back.
  kimi.dispose(session);
  await sleep(10);
  sessionInfo.get(kid).busy = true; // Kimi is still working
  reset();
  kimi.restore(session);
  await kimi.attach(session);
  assert.equal(session.meta.queue.length, 1, 'the saved queue is what is left');
  await until(() => backgroundCalls().length >= 1, 3000, 'watched again after the restart');

  // The terminal message is recognised when Kimi reads it (no stuck queue).
  frame(mid, kid, 'turn.steer', { turnId: 't1', input: [{ type: 'text', text: '優雅暫停' }], promptIds: ['kimi_msg_9'] });
  await sleep(50);
  assert.equal(session.meta.queue.length, 0);
  assert.equal(userEvents(session, '優雅暫停').length, 1);
  working(mid, kid, false);
  await sleep(20);
  assert.equal(kimi.isBusy(session), false);
  kimi.dispose(session);
});

// ------------------------------------- the turn snapshot (本回合 / 下一回合)

const SUB = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };

// A conversation whose running turn started on modelA/high, then the user
// moved the conversation to modelB/max with a subagent default (all of which
// belong to the next turn).
async function runningOnModelA(tag) {
  const mid = `m_${tag}`;
  const kid = `session_${tag}`;
  const session = await makeSession({ id: `s_${tag}`, kid, machine: mid, controllable: false, model: 'modelA' });
  session.provider = 'kimi';
  session.modelConfig = { provider: 'kimi', model: 'modelA', effort: 'high' };
  session.meta.effort = 'high';
  frame(mid, kid, 'turn.started', { turnId: 't1', promptId: 'p_first', origin: { kind: 'user' }, prompt: '第一則' });
  working(mid, kid, true);
  assert.equal(session.status, 'running');
  assert.deepEqual([session.meta.turnProvider, session.meta.turnModel, session.meta.turnEffort, session.meta.turnSubagent], ['kimi', 'modelA', 'high', null]);
  return { mid, kid, session };
}
const changeToNext = (session) => {
  session.modelConfig = { provider: 'kimi', model: 'modelB', effort: 'max' };
  session.meta = { ...session.meta, model: 'modelB', effort: 'max', subagent: SUB };
};
const turnOf = (m) => [m.turnProvider, m.turnModel, m.turnEffort, m.turnSubagent];

test('sending while a turn runs does not rewrite that turn\'s snapshot; the queued message\'s turn gets the new settings when it starts', async () => {
  reset();
  const { mid, kid, session } = await runningOnModelA('snap_run');
  changeToNext(session);
  await runner.startTurn(session, '排在後面的一則');
  assert.deepEqual(turnOf(session.meta), ['kimi', 'modelA', 'high', null], 'the running turn keeps what it actually uses');

  // The summary says both, separately.
  const sum = runner.summarize(session);
  assert.deepEqual(turnOf(sum), ['kimi', 'modelA', 'high', null]);
  assert.deepEqual([sum.nextProvider, sum.nextModel, sum.nextEffort, sum.nextSubagent], ['kimi', 'modelB', 'max', SUB]);

  // Kimi finishes, then starts the queued message: that turn is modelB/max.
  endTurn(mid, kid);
  frame(mid, kid, 'turn.started', { turnId: 't2', promptId: posted()[0].args.body.prompt_id, origin: { kind: 'user' }, prompt: '排在後面的一則' });
  working(mid, kid, true);
  assert.deepEqual(turnOf(session.meta), ['kimi', 'modelB', 'max', SUB]);
  assert.deepEqual(turnOf(runner.summarize(session)), ['kimi', 'modelB', 'max', SUB]);
  endTurn(mid, kid);
  kimi.dispose(session);
});

test('an idle conversation has no 本回合 in its summary, only 下一回合', async () => {
  reset();
  const session = await makeSession({ id: 's_snap_idle', kid: 'session_snap_idle', machine: 'm_snap_idle', controllable: false, model: 'modelA' });
  session.provider = 'kimi';
  session.modelConfig = { provider: 'kimi', model: 'modelB', effort: 'max' };
  session.meta = { ...session.meta, turnProvider: 'kimi', turnModel: 'left over', subagent: SUB };
  const sum = runner.summarize(session);
  assert.deepEqual(turnOf(sum), [null, null, null, null], 'no turn is running');
  assert.deepEqual([sum.nextProvider, sum.nextModel, sum.nextEffort, sum.nextSubagent], ['kimi', 'modelB', 'max', SUB]);
  kimi.dispose(session);
});

test('a pending cross-runtime switch is the 下一回合 in the summary while this turn keeps its own', async () => {
  reset();
  const { session } = await runningOnModelA('snap_pending');
  session.state = { ...(session.state || {}), pendingProvider: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
  const sum = runner.summarize(session);
  assert.deepEqual(turnOf(sum), ['kimi', 'modelA', 'high', null]);
  assert.deepEqual([sum.nextProvider, sum.nextModel, sum.nextEffort], ['claude', 'claude-opus-5-5', 'high']);
  kimi.dispose(session);
});

test('runner.deliver (auto-pause 「繼續」, 定時送出) snapshots the turn it starts, and leaves a running turn alone', async () => {
  reset();
  const session = await makeSession({ id: 's_snap_deliver', kid: 'session_snap_deliver', machine: 'm_snap_deliver', controllable: false, model: 'modelA' });
  session.provider = 'kimi';
  session.modelConfig = { provider: 'kimi', model: 'modelA', effort: 'high' };
  await runner.startTurn(session, '先做一輪');
  assert.equal(session.meta.turnProvider, 'kimi');
  // The turn ended; the conversation moved to DeepSeek with a subagent default.
  endTurn('m_snap_deliver', 'session_snap_deliver');
  session.status = 'idle';
  session.provider = 'deepseek';
  session.modelConfig = { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' };
  session.meta = { ...session.meta, subagent: SUB };
  await runner.deliver(session, '繼續', {});
  assert.deepEqual(turnOf(session.meta), ['deepseek', 'agent-hub-deepseek/deepseek-v4.1-flash', 'max', SUB], 'the auto-sent turn is what the settings were when it started');

  // Delivered while a turn is running: that turn\'s snapshot stays.
  session.status = 'running';
  session.provider = 'kimi';
  session.modelConfig = { provider: 'kimi', model: 'modelC', effort: 'low' };
  await runner.deliver(session, '又一則', {});
  assert.deepEqual(turnOf(session.meta), ['deepseek', 'agent-hub-deepseek/deepseek-v4.1-flash', 'max', SUB]);
  kimi.dispose(session);
});

test('a turn Kimi starts by itself (a background task finished) gets a full snapshot too', async () => {
  reset();
  const session = await makeSession({ id: 's_snap_self', kid: 'session_snap_self', machine: 'm_snap_self', controllable: false, model: 'modelA' });
  session.provider = 'kimi';
  session.meta = { ...session.meta, effort: 'low', subagent: SUB, turnProvider: 'claude', turnSubagent: null };
  frame('m_snap_self', 'session_snap_self', 'turn.started', { turnId: 'tb', origin: { kind: 'background_task' } });
  assert.deepEqual(turnOf(session.meta), ['kimi', 'modelA', 'low', SUB]);
  endTurn('m_snap_self', 'session_snap_self');
  assert.deepEqual(turnOf(session.meta), [null, null, null, null], 'cleared when the turn ends');
  kimi.dispose(session);
});
