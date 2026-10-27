// The catch-up that rebuilds a conversation from Kimi's journal must not take
// back what the user sent after the journal was read.
//
// Two ways it did (the transcript lost the user's message, and in the second
// also the answer to it):
//   1. a message sent while a catch-up was between "read the journal" and
//      "replace the transcript": the journal read had not been written yet;
//   2. the machine coming back starts a catch-up that nobody else knew about,
//      a message sent meanwhile started a second one, and the slower (older)
//      one replaced the newer transcript with its stale read.
//
// The REAL runner context (replaceEvents, seq, broadcast) and the REAL
// kimi-remote adapter run in this process; only the machine is scripted: its
// journal, and when the journal read is answered.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-attach-keeps-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

let kimi;
let machines;
let store;
let runner;
let bridge;
let n = 0;
const MID = 'm_attach_keeps';
const requests = []; // { op, args } the hub sent to the machine
const journals = new Map(); // Kimi session id -> frames written so far
const prompts = []; // bodies POSTed to /prompts
let historyGate = null; // one-shot: the next kimi.history answer waits for this promise
let autoReply = false; // Kimi writes the turn and streams it as soon as it has the prompt
let promptError = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The frames of one finished turn, as Kimi writes them to its journal.
const turnFrames = (kid, promptId, text, answer) => [
  { type: 'turn.started', session_id: kid, time: 1_000_000 + n++, payload: { agentId: 'main', turnId: `t_${promptId}`, promptId, origin: { kind: 'user' }, prompt: text } },
  { type: 'assistant.delta', session_id: kid, time: 1_000_000 + n++, payload: { agentId: 'main', turnId: `t_${promptId}`, delta: answer } },
  { type: 'turn.ended', session_id: kid, time: 1_000_000 + n++, payload: { agentId: 'main', reason: 'completed' } },
];
// Kimi takes a prompt: it writes the turn to the journal and streams it to
// whoever is subscribed.
function nativeAnswers(kid, promptId, text) {
  const frames = turnFrames(kid, promptId, text, `Kimi 收到：${text}`);
  journals.get(kid).push(...frames);
  for (const f of frames) bridge.emit('message', JSON.stringify({ t: 'kimi.event', frame: f }));
  bridge.emit('message', JSON.stringify({ t: 'kimi.event', frame: { type: 'event.session.work_changed', session_id: kid, payload: { busy: false, last_turn_reason: 'completed' } } }));
}

function fakeBridge() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req') return;
    requests.push({ op: msg.op, args: msg.args });
    const reply = (data) => queueMicrotask(() => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: true, data })));
    if (msg.op === 'kimi.history') {
      // The journal is read now; the answer may be late.
      const kid = msg.args.sessionId;
      const data = { frames: [...(journals.get(kid) || [])], more: false, before: 0, info: { id: kid, title: 'x', busy: false, pending_interaction: 'none', last_turn_reason: 'completed', owner: null, controllable: null, guess: false, model: 'fake' } };
      const gate = historyGate;
      historyGate = null;
      if (gate) await gate;
      return reply(data);
    }
    let data = {};
    if (msg.op === 'kimi.request') {
      const { method, path: p, body } = msg.args;
      if (method === 'GET' && p === '/api/v1/config') data = { code: 0, data: { default_model: 'fake' } };
      else if (method === 'GET' && p === '/api/v1/models') data = { code: 0, data: { items: [] } };
      else if (method === 'GET' && /\/skills$/.test(p)) data = { code: 0, data: { skills: [] } };
      else if (method === 'GET' && /\/(approvals|questions)/.test(p)) data = { code: 0, data: { items: [] } };
      else if (method === 'POST' && /\/prompts$/.test(p)) {
        if (promptError) data = { code: 50000, msg: promptError };
        else {
          prompts.push(body);
          const kid = p.match(/sessions\/([^/]+)\//)[1];
          const said = (body.content || []).filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');
          if (autoReply) setTimeout(() => nativeAnswers(kid, body.prompt_id, said), 20);
          data = { code: 0, data: { status: 'started' } };
        }
      } else data = { code: 0, data: {} };
    }
    reply(data);
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: MID, name: MID, platform: 'linux', home: TMP, bridgeVersion: '0.9.1', broker: 1, status: { available: true, server: true, version: '2.3.1' } }));
  return ws;
}

let sessionNo = 0;
async function newSession() {
  const kid = `session_keeps_${++sessionNo}`;
  journals.set(kid, turnFrames(kid, `p_old_${sessionNo}`, 'old question', 'old answer'));
  machines.getMachine(MID).sessions = [{ id: kid, title: 't', owner: null, controllable: null, guess: false, busy: false, pending: 'none' }];
  const session = store.createSession({ id: `s_keeps_${sessionNo}`, machineId: MID, kimiSessionId: kid, agentId: `kimi@${MID}`, title: 't', status: 'idle', meta: { model: 'fake' } });
  kimi.restore(session);
  await kimi.attach(session);
  return { session, kid };
}

const users = (session) => session.events.filter((e) => e.type === 'user').map((e) => e.text);
const texts = (session) => session.events.filter((e) => e.type === 'text').map((e) => e.text);
const historyReads = () => requests.filter((r) => r.op === 'kimi.history').length;

before(async () => {
  store = await import('../server/store.js');
  machines = await import('../server/machines.js');
  kimi = await import('../server/adapters/kimi-remote.js');
  runner = await import('../server/runner.js'); // wires the live context into the adapter
  kimi.init(runner.liveContext);
  bridge = fakeBridge();
});
after(async () => {
  bridge?.emit('close');
  store.flushAll();
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a message sent after the journal was read, before the transcript is replaced, stays - once, and the journal catching up does not double it', async () => {
  const { session, kid } = await newSession();
  assert.deepEqual(users(session), ['old question']);
  const seqBefore = session.seq;

  let release;
  historyGate = new Promise((r) => (release = r));
  const reads = historyReads();
  const catchUp = kimi.attach(session); // reads the journal now; the answer is slow
  await until(() => historyReads() > reads, 4000, 'the journal read');

  // The conversation is followed already (live), so sending does not wait. The
  // journal as read does not have this message.
  const sent = await kimi.send(session, 'typed meanwhile');
  assert.equal(sent.ok, true);
  assert.deepEqual(users(session), ['old question', 'typed meanwhile']);

  release();
  await catchUp;
  assert.deepEqual(users(session), ['old question', 'typed meanwhile'], 'the replaced transcript still has the message, once');
  const order = session.events.map((e) => (e.type === 'user' ? `U:${e.text}` : e.type === 'text' ? `A:${e.text}` : e.type));
  assert.deepEqual(order.filter((x) => /^[UA]:/.test(x)), ['U:old question', 'A:old answer', 'U:typed meanwhile'], 'after the history, in order');
  assert.equal(new Set(session.events.map((e) => e.id)).size, session.events.length, 'no event twice');
  assert.ok(session.seq > seqBefore, 'the sequence moved forward (clients re-read)');
  const mine = session.events.find((e) => e.text === 'typed meanwhile');
  assert.equal(mine.source, 'hub');
  assert.equal(mine.promptId, prompts.at(-1).prompt_id, 'it is the message Kimi was sent');

  // Kimi now starts the turn: live frames, then a later catch-up that reads a
  // journal which has it. Neither makes a second copy.
  nativeAnswers(kid, prompts.at(-1).prompt_id, 'typed meanwhile');
  await until(() => texts(session).includes('Kimi 收到：typed meanwhile'), 4000, 'the answer');
  assert.deepEqual(users(session), ['old question', 'typed meanwhile']);
  await kimi.attach(session);
  assert.deepEqual(users(session), ['old question', 'typed meanwhile'], 'the journal\'s copy replaced the hub\'s, nothing doubled');
  assert.deepEqual(texts(session), ['old answer', 'Kimi 收到：typed meanwhile']);
  assert.equal(session.events.filter((e) => e.type === 'user' && e.text === 'typed meanwhile').length, 1);
});

test('the journal already holding the message at replace time: the journal\'s copy is the one shown', async () => {
  const { session, kid } = await newSession();
  autoReply = false;
  const sent = await kimi.send(session, 'already written');
  assert.equal(sent.ok, true);
  const promptId = prompts.at(-1).prompt_id;
  // Kimi wrote the turn (no live frames reached the hub), then a catch-up.
  journals.get(kid).push(...turnFrames(kid, promptId, 'already written', 'reply'));
  await kimi.attach(session);
  assert.deepEqual(users(session), ['old question', 'already written']);
  assert.deepEqual(texts(session), ['old answer', 'reply']);
});

test('the machine comes back: a message sent during the catch-up waits for it, and neither the message nor its answer is replaced away', async () => {
  const { session } = await newSession();
  kimi.view(session); // someone has it open, so the machine's return catches it up
  autoReply = true;
  let release;
  historyGate = new Promise((r) => (release = r));
  const reads = historyReads();
  const postsBefore = prompts.length;
  const online = kimi.onMachineOnline(MID, [session]); // what the Hub does when a machine connects
  await until(() => historyReads() > reads, 4000, 'the catch-up to read the journal');

  const sending = kimi.send(session, 'typed after reconnect');
  await sleep(150);
  release();
  assert.equal((await sending).ok, true);
  await online;
  await until(() => texts(session).includes('Kimi 收到：typed after reconnect'), 4000, 'the answer to the message');
  autoReply = false;

  assert.equal(prompts.length, postsBefore + 1, 'Kimi was sent the message once');
  assert.deepEqual(users(session), ['old question', 'typed after reconnect']);
  assert.deepEqual(texts(session), ['old answer', 'Kimi 收到：typed after reconnect']);
  assert.equal(historyReads(), reads + 1, 'one catch-up, not one for the machine and another for the message');
  assert.equal(session.status, 'idle');
});

test('a message Kimi refused is not kept by a later catch-up', async () => {
  const { session } = await newSession();
  promptError = 'Kimi 拒絕了';
  const sent = await kimi.send(session, 'refused one');
  promptError = null;
  assert.equal(sent.ok, false);
  await kimi.attach(session);
  assert.deepEqual(users(session), ['old question'], 'what the journal has is what is shown');
});
