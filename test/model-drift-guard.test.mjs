// A DeepSeek conversation whose native Kimi has moved to a Kimi model (a drift
// seen in real use) and the user writes to it again: what the Hub does before
// the message goes out, and what choosing the same model again does. The real
// Hub runs against the fake machine; assertions are on the order and content of
// what the machine received.
//
// The policy under test (decided in the work package, see the report):
//  - the native is moved back to the user's choice with one confirmed /profile
//    change BEFORE the prompt, and said in the conversation;
//  - if that fails the message is NOT sent (a turn on the wrong provider is
//    worse than a message that waits), and it says why;
//  - a conversation that runs in a terminal is never overwritten: it is said
//    once, the message goes where the native is, and the page offers a button.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.AGENT_HUB_PROFILE_CONFIRM_MS = '200';
const { startRealHub, until, wait } = await import('./fixtures/real-hub.mjs');
const { DS, SUB } = await import('./fixtures/fake-machine.mjs');

const MID = 'm_fake';
const ALIAS = `${DS}/deepseek-v4.1-flash`;
let hub;
let CWD;
before(async () => {
  hub = await startRealHub('drift-guard', { seed: (DATA) => { CWD = path.join(path.dirname(DATA), 'project'); fs.mkdirSync(CWD, { recursive: true }); } });
  await hub.setDeepseekKey();
});
after(() => hub?.stop());

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newDs = () => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model: 'deepseek-v4.1-flash', effort: 'max' });
async function say(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}
// The conversation, written to once, then the native moves to Kimi K3.1 Pro at
// max - the 10-24 state - and the Hub has been told.
async function drifted() {
  const s = await newDs();
  await say(s.id, 'before the drift');
  hub.machine.nativeChange(s.kimiSessionId, { model: SUB, thinking: 'max' });
  await until(async () => (await snap(s.id)).modelDrift?.kind === 'provider', 5000, 'the drift to show');
  return s;
}
// What the machine received for one native session, in order: 'profile:<model>' and 'prompt'.
const wire = (nativeSid) => hub.machine.requests
  .filter((r) => r.method === 'POST' && r.path.startsWith(`/api/v1/sessions/${nativeSid}/`))
  .map((r) => (r.path.endsWith('/profile') ? (r.body.agent_config?.model ? `profile:${r.body.agent_config.model}` : 'profile:other') : r.path.endsWith('/prompts') ? 'prompt' : r.path))
  .filter((x) => x === 'prompt' || x.startsWith('profile:'));
const reset = () => {
  hub.machine.echoProfile = false;
  hub.machine.refuseProfile = false;
  hub.machine.autoReply = true;
};

test('the drift is on the summary before anything is sent: the label says DeepSeek, the native says Kimi', async () => {
  reset();
  const s = await drifted();
  const sum = await snap(s.id);
  assert.equal(sum.provider, 'deepseek');
  assert.equal(sum.nativeModel, SUB);
  assert.equal(sum.modelDrift.expected.model, ALIAS);
  assert.equal(sum.modelDrift.actual.model, SUB);
});

test('a message to a drifted conversation first puts the native back (confirmed), then goes out, and the conversation says so', async () => {
  reset();
  hub.machine.echoProfile = true;
  const s = await drifted();
  const before = wire(s.kimiSessionId).length;
  const after = await say(s.id, 'after the drift');
  assert.deepEqual(wire(s.kimiSessionId).slice(before), [`profile:${ALIAS}`, 'prompt'], 'the change came first, then the prompt');
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).model, ALIAS, 'the native is on DeepSeek again');
  assert.equal(after.modelDrift, null);
  assert.equal(after.nativeModel, ALIAS);
  const info = after.events.find((e) => e.type === 'info' && /偵測到原生對話正在用/.test(e.text));
  assert.ok(info, 'said in the conversation');
  assert.match(info.text, /Kimi/);
  assert.match(info.text, /已依你的選擇改回/);
  assert.match(info.text, /DeepSeek/);
  const prompt = hub.machine.prompts.filter((p) => p.sid === s.kimiSessionId).at(-1);
  assert.notEqual(prompt.body.model, SUB, 'and the prompt itself does not name Kimi');
});

test('a native that stays quiet after the change (Kimi journals it with the next turn) is accepted, and the message goes out', async () => {
  reset();
  const s = await drifted();
  const before = wire(s.kimiSessionId).length;
  await say(s.id, 'quiet native');
  assert.deepEqual(wire(s.kimiSessionId).slice(before), [`profile:${ALIAS}`, 'prompt']);
});

test('when the change cannot be made the message is NOT sent, and it says which model is running and why', async () => {
  reset();
  const s = await drifted();
  const before = wire(s.kimiSessionId).length;
  hub.machine.refuseProfile = true;
  await assert.rejects(
    () => hub.api('POST', `/sessions/${s.id}/messages`, { text: 'must not go out' }),
    (err) => err.status === 502 && /訊息沒有送出/.test(err.message) && /Kimi/.test(err.message) && /DeepSeek/.test(err.message),
  );
  hub.machine.refuseProfile = false;
  const sum = await snap(s.id);
  assert.deepEqual(wire(s.kimiSessionId).slice(before).filter((x) => x === 'prompt'), [], 'no prompt reached the native');
  assert.ok(sum.events.some((e) => e.type === 'error' && /訊息沒有送出/.test(e.text)), 'the error is in the conversation');
  assert.equal(hub.machine.sessions.get(s.kimiSessionId).model, SUB, 'the native was not touched');
  assert.equal(sum.modelDrift.kind, 'provider', 'and the drift is still shown');
  assert.equal(sum.status, 'idle');
});

test('a native that answers the change with another model fails it: nothing is claimed, nothing is sent', async () => {
  reset();
  const s = await drifted();
  const before = wire(s.kimiSessionId).length;
  hub.machine.echoProfile = (sid) => ({ model: SUB, thinking: 'max' });
  await assert.rejects(() => hub.api('POST', `/sessions/${s.id}/messages`, { text: 'still must not go out' }), (err) => err.status === 502 && /訊息沒有送出/.test(err.message));
  const sum = await snap(s.id);
  assert.deepEqual(wire(s.kimiSessionId).slice(before).filter((x) => x === 'prompt'), []);
  assert.equal(sum.nativeModel, SUB, 'the summary carries the native\'s own word, not the model that was asked for');
  assert.equal(sum.modelDrift.kind, 'provider');
});

test('a turn is running: a failed change is an error in the conversation and the running turn is left alone (no exception, no idle)', async () => {
  reset();
  const s = await drifted();
  hub.machine.autoReply = false;
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'a long job' });
  await until(async () => (await snap(s.id)).status === 'running', 5000, 'the turn to run');
  // The first message found the native drifted and put it back before going
  // out. The native moves again meanwhile (another client), and now refuses.
  hub.machine.nativeChange(s.kimiSessionId, { model: SUB, thinking: 'max' });
  await until(async () => (await snap(s.id)).modelDrift?.kind === 'provider', 5000, 'the drift to come back');
  hub.machine.refuseProfile = true;
  const before = hub.machine.prompts.filter((p) => p.sid === s.kimiSessionId).length;
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'queued behind it' });
  const sum = await snap(s.id);
  assert.equal(sum.status, 'running', 'the running turn is still running');
  assert.equal(hub.machine.prompts.filter((p) => p.sid === s.kimiSessionId).length, before, 'the second message did not go out');
  assert.ok(sum.events.some((e) => e.type === 'error' && /訊息沒有送出/.test(e.text)));
});

test('a conversation that runs in a terminal is never overwritten: said once, the message goes to where the native is', async () => {
  reset();
  hub.machine.echoProfile = true;
  const s = await drifted();
  const native = hub.machine.sessions.get(s.kimiSessionId);
  native.owner = 'tui';
  native.controllable = false;
  hub.machine.pushSessions();
  await until(async () => (await snap(s.id)).meta.owner === 'tui', 5000, 'the terminal to be seen');
  const before = wire(s.kimiSessionId).length;
  const first = await say(s.id, 'typed while the terminal owns it');
  assert.deepEqual(wire(s.kimiSessionId).slice(before), ['prompt'], 'no /profile change');
  assert.equal(native.model, SUB, 'the native still runs what the terminal chose');
  const notices = (x) => x.events.filter((e) => e.type === 'info' && /不會覆寫你在終端機做的選擇/.test(e.text));
  assert.equal(notices(first).length, 1);
  assert.equal(first.modelDrift.kind, 'provider', 'and the page is told, so it can offer the button');
  const second = await say(s.id, 'and again');
  assert.equal(notices(second).length, 1, 'said once for the same drift, not at every message');
});

test('a terminal the Hub drives (controllable): not overwritten either', async () => {
  reset();
  hub.machine.echoProfile = true;
  const s = await drifted();
  const native = hub.machine.sessions.get(s.kimiSessionId);
  native.owner = 'tui';
  native.controllable = true;
  hub.machine.pushSessions();
  await until(async () => (await snap(s.id)).meta.controllable === true, 5000, 'the terminal to be seen as controllable');
  const before = hub.machine.requests.length;
  const typedBefore = hub.machine.rpcs.length;
  await hub.api('POST', `/sessions/${s.id}/messages`, { text: 'into the terminal' }).catch(() => {});
  await wait(300);
  const posted = hub.machine.requests.slice(before).filter((r) => r.method === 'POST' && r.path.endsWith('/profile'));
  assert.deepEqual(posted, [], 'no /profile change was sent for a terminal the Hub types into');
  // what was typed into that terminal: the message, and never a /model command
  const asked = hub.machine.rpcs.slice(typedBefore);
  const typed = asked.filter((r) => r.op === 'kimi.tui.input').map((r) => r.args.text || r.args.action);
  // (A conversation with a subagent default that needs the prompt body goes by Kimi's API even
  // when the terminal is controllable; either way the message reached the native.)
  const delivered = typed.includes('into the terminal') || asked.some((r) => r.op === 'kimi.request' && /\/prompts$/.test(r.args.path));
  assert.ok(delivered, `the message reached the native (${JSON.stringify(asked.map((r) => r.op))})`);
  assert.deepEqual(typed.filter((t) => /^\/(model|effort)/.test(t)), [], 'the Hub did not type /model or /effort into the user\'s terminal');
  assert.equal(native.model, SUB);
});

test('choosing DeepSeek again from the page (force) reaches the native; without the flag it also does while they disagree; a failure is an error', async () => {
  reset();
  hub.machine.echoProfile = true;
  const s = await drifted();
  const before = wire(s.kimiSessionId).length;
  const out = await hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  assert.deepEqual(wire(s.kimiSessionId).slice(before), [`profile:${ALIAS}`]);
  assert.equal(out.modelDrift, null);
  assert.equal(out.nativeModel, ALIAS);
  // agreeing now: no change without force, one with it
  await hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  assert.equal(wire(s.kimiSessionId).length, before + 1, 'already there: nothing sent');
  await hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max', force: true });
  assert.equal(wire(s.kimiSessionId).length, before + 2, 'force sends it');
  // the native refuses: an error, and the drift is not hidden
  hub.machine.nativeChange(s.kimiSessionId, { model: SUB, thinking: 'max' });
  await until(async () => (await snap(s.id)).modelDrift, 5000, 'the drift to come back');
  hub.machine.refuseProfile = true;
  await assert.rejects(() => hub.api('POST', `/sessions/${s.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max', force: true }), (err) => err.status >= 400);
  hub.machine.refuseProfile = false;
  assert.equal((await snap(s.id)).modelDrift.kind, 'provider');
});

test('a turn the native starts by itself on the Kimi model is recorded as a Kimi turn, whatever the conversation is labelled', async () => {
  reset();
  const s = await drifted();
  // Someone else (a terminal, a schedule) starts a turn: the Hub never saw the prompt.
  hub.machine.frame(s.kimiSessionId, 'turn.started', { turnId: 't_elsewhere', promptId: 'p_elsewhere', origin: { kind: 'user' }, prompt: 'started elsewhere' });
  const running = await until(async () => {
    const x = await snap(s.id);
    return x.status === 'running' && x.turnModel === SUB && x;
  }, 5000, 'the turn to be recorded');
  assert.equal(running.provider, 'deepseek', 'the label is the record');
  assert.equal(running.turnProvider, 'kimi', 'the turn ran on Kimi');
  hub.machine.frame(s.kimiSessionId, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(s.kimiSessionId, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await until(async () => (await snap(s.id)).status === 'idle', 5000, 'the turn to end');
});
