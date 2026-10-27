// A message sent while the Hub is still catching a conversation up from its
// machine (the machine just came back) must not vanish from the conversation.
//
// The catch-up rebuilds the whole transcript from Kimi's journal and replaces
// what the Hub holds. A user message the Hub has shown but Kimi's journal does
// not hold yet used to be replaced away: the answer to it still arrived, under
// no question. The real Hub process runs (runner, kimi-remote adapter,
// store); only the machine is fake, and its journal read can be held, like a
// slow disk or a long round trip. (Whether the old code lost the message here
// depended on which of two catch-ups finished last; the deterministic version
// of each ordering is in kimi-attach-keeps-sent.test.mjs.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';
import { startFakeMachine } from './fixtures/fake-machine.mjs';

const MID = 'm_fake';
let hub;
let CWD;

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const kinds = (s) => s.events.map((e) => `${e.type}:${e.text ?? ''}`.slice(0, 60));
const userTexts = (s) => s.events.filter((e) => e.type === 'user').map((e) => e.text);

async function say(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}

// The machine goes away and comes back (a new connection with the same
// identity, holding the same Kimi conversations).
async function reconnect({ hold = false } = {}) {
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  const carried = new Map([...hub.machine.sessions.entries()].map(([sid, st]) => [sid, { ...st, history: [...st.history] }]));
  hub.machine.close();
  await until(async () => !(await hub.api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'the machine to be seen gone');
  const again = startFakeMachine({ port: hub.PORT, key, id: MID });
  let release;
  if (hold) again.historyGate = new Promise((r) => (release = r));
  await again.ready;
  for (const [sid, st] of carried) again.add(sid, st);
  hub.machine = again;
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID && m.online), 10000, 'the machine to be back');
  return { machine: again, release };
}
const historyReads = (m) => m.rpcs.filter((r) => r.op === 'kimi.history').length;

before(async () => {
  hub = await startRealHub('reconnect-race');
  CWD = path.join(hub.TMP, 'project');
  fs.mkdirSync(CWD, { recursive: true });
});
after(() => hub?.stop());

test('a message sent while the reconnect catch-up is still reading the journal stays in the conversation, once, before its answer', async () => {
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const kimi = groups.find((g) => g.provider === 'kimi').models[0];
  const s = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD, model: kimi.id, effort: kimi.efforts?.[0] });
  await say(s.id, 'first question');
  const before = await snap(s.id);
  assert.deepEqual(userTexts(before), ['first question']);

  const { machine, release } = await reconnect({ hold: true });
  // The catch-up has asked for the journal and is waiting for it.
  await until(async () => historyReads(machine) >= 1, 10000, 'the catch-up to read the journal');
  // The user types now. The Hub answers the request only once it is following
  // the conversation again, so it is not awaited here.
  const sent = hub.api('POST', `/sessions/${s.id}/messages`, { text: 'typed during catch-up' }).catch((e) => e);
  await wait(400);
  release();
  const posted = await sent;
  assert.ok(!(posted instanceof Error), `the message was accepted (${posted?.message})`);

  const done = await until(async () => {
    const x = await snap(s.id);
    return x.status === 'idle' && x.events.some((e) => e.type === 'text' && /typed during catch-up/.test(e.text)) && x.events.at(-1).type === 'turn_end' && x;
  }, 25000, 'the answer to the message sent during the catch-up').catch(async (err) => {
    err.message += `\n${JSON.stringify(kinds(await snap(s.id)))}`;
    throw err;
  });

  assert.deepEqual(userTexts(done), ['first question', 'typed during catch-up'], 'both questions are in the conversation, each once');
  const order = done.events.map((e) => (e.type === 'user' ? `U:${e.text}` : e.type === 'text' ? `A:${e.text}` : e.type));
  const at = (x) => order.indexOf(x);
  assert.ok(at('U:first question') < at('A:Kimi 收到：first question'), `order: ${order}`);
  assert.ok(at('A:Kimi 收到：first question') < at('U:typed during catch-up'), `order: ${order}`);
  assert.ok(at('U:typed during catch-up') < at('A:Kimi 收到：typed during catch-up'), `order: ${order}`);
  assert.equal(new Set(done.events.map((e) => e.id)).size, done.events.length, 'no event twice');
  assert.ok(done.seq > before.seq, 'the sequence only moves forward');
  // Kimi really got the message once.
  assert.equal(machine.prompts.filter((p) => p.body.content.some((c) => c.text === 'typed during catch-up')).length, 1);

  // The machine comes back once more; this time the journal it reads has the
  // message. The journal's copy is the one shown, nothing doubles.
  const second = await reconnect();
  await until(async () => historyReads(second.machine) >= 1, 10000, 'the catch-up');
  await wait(1200);
  const again = await snap(s.id);
  assert.deepEqual(userTexts(again), ['first question', 'typed during catch-up']);
  assert.equal(new Set(again.events.map((e) => e.id)).size, again.events.length);
});
