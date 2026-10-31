// The key moves from OpenCode Go to Command Code (or back): the model names
// follow the gateway, and conversations made before still carry the old spelling.
// A REAL Hub on a fake machine and a fake gateway that lists the DeepSeek models
// in each gateway's own spelling. Assertions are on what the Hub answers and on
// what the machine (the native Kimi) receives, in order.
//
//  1. the gateway in use is OpenCode Go: every place that takes a model also takes
//     Command Code's spelling of it (and says so plainly when the model is Command
//     Code's alone);
//  2. the gateway changes: the records of the conversations are rewritten in the new
//     spelling, a turn in progress is left alone, and the native Kimi is told the new
//     spelling before the next message goes out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.AGENT_HUB_PROFILE_CONFIRM_MS = '200';
const { startRealHub, until } = await import('./fixtures/real-hub.mjs');
const { DS, SUB, GATEWAY_KEY, GATEWAY_KEY_CC } = await import('./fixtures/fake-machine.mjs');

const MID = 'm_fake';
const GO = (id) => `${DS}/${id}`; // OpenCode Go's spelling, as the alias
const CC = (id) => `${DS}/deepseek/${id}`; // Command Code's
let hub;
let CWD;
before(async () => {
  hub = await startRealHub('ds-gateway-switch', { seed: (DATA) => { CWD = path.join(path.dirname(DATA), 'project'); fs.mkdirSync(CWD, { recursive: true }); } });
  await hub.setDeepseekKey(); // OpenCode Go, the first key: the model names follow it
});
after(() => hub?.stop());

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newDs = (model = 'deepseek-v4.1-flash', extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: CWD, model, effort: 'max', ...extra });
const idle = (id) => until(async () => (await snap(id)).status === 'idle', 10000, 'idle');
async function say(id, text) {
  const known = new Set((await snap(id)).events.map((e) => e.id));
  await hub.api('POST', `/sessions/${id}/messages`, { text });
  return until(async () => {
    const s = await snap(id);
    const fresh = s.events.filter((e) => !known.has(e.id));
    return s.status === 'idle' && fresh.some((e) => e.type === 'user' && e.text === text) && fresh.some((e) => e.type === 'turn_end') && s;
  }, 25000, `the answer to "${text}"`);
}
// What the machine received for one native session, in order: 'profile:<model>' and 'prompt'.
const wire = (nativeSid) => hub.machine.requests
  .filter((r) => r.method === 'POST' && r.path.startsWith(`/api/v1/sessions/${nativeSid}/`))
  .map((r) => (r.path.endsWith('/profile') ? (r.body.agent_config?.model ? `profile:${r.body.agent_config.model}` : `profile:thinking:${r.body.agent_config?.thinking}`) : r.path.endsWith('/prompts') ? 'prompt' : r.path))
  .filter((x) => x === 'prompt' || x.startsWith('profile:'));
const providerModels = () => hub.machine.dsModels;

test('1. on OpenCode Go the new-conversation default and a new conversation take Command Code\'s spelling of a model', async () => {
  const saved = await hub.api('PUT', '/settings', { defaults: { provider: 'deepseek', model: 'deepseek/deepseek-v4-pro', effort: 'high' } });
  assert.equal(saved.defaults.byProvider.deepseek.model, 'deepseek-v4-pro', 'saved as this gateway\'s id');
  await assert.rejects(
    () => hub.api('PUT', '/settings', { defaults: { provider: 'deepseek', model: 'deepseek/deepseek-v4-flash-fast' } }),
    (err) => err.status === 400 && /deepseek-v4-flash-fast 只有 Command Code 有/.test(err.message) && /目前依 OpenCode Go/.test(err.message),
  );
  const made = await newDs(CC('deepseek-v4-pro'));
  assert.equal(made.modelConfig.model, GO('deepseek-v4-pro'));
  assert.equal(hub.machine.sessions.get(made.kimiSessionId).model, GO('deepseek-v4-pro'), 'and the native was given the alias it has');
  const legacy = await hub.api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: CWD, model: 'deepseek/deepseek-v4.1-flash' });
  assert.equal(legacy.modelConfig.model, GO('deepseek-v4.1-flash'));
  await assert.rejects(
    () => hub.api('POST', '/sessions', { agent: 'deepseek', machineId: MID, cwd: CWD, model: 'deepseek/deepseek-v4-flash-fast' }),
    (err) => err.status === 400 && /只有 Command Code 有/.test(err.message),
  );
});

test('2. the names move to Command Code and back: records follow, the native is told the new spelling before the next message, a turn in progress is left alone', async () => {
  hub.machine.echoProfile = true;
  await hub.api('PUT', '/deepseek', { apiKey: GATEWAY_KEY_CC, keyGateway: 'commandcode' });
  await hub.api('PUT', '/deepseek', { gateway: 'commandcode' });
  await until(async () => providerModels().includes(CC('deepseek-v4-pro')), 10000, 'the provider to carry Command Code\'s names');
  assert.ok(!providerModels().includes(GO('deepseek-v4-pro')));

  // three conversations made while Command Code's spelling is in use
  const a = await newDs(GO('deepseek-v4.1-flash')); // (the other gateway's spelling is taken, and written as Command Code's)
  assert.equal(a.modelConfig.model, CC('deepseek-v4.1-flash'));
  await say(a.id, 'a: before the switch');
  const c = await newDs(CC('deepseek-v4-pro'));
  await say(c.id, 'c: before the switch');
  const b = await newDs(CC('deepseek-v4-pro'));
  hub.machine.autoReply = false;
  await hub.api('POST', `/sessions/${b.id}/messages`, { text: 'b: a long job' });
  await until(async () => (await snap(b.id)).status === 'running', 5000, 'b to be running');
  hub.machine.autoReply = true;

  // the names move back to OpenCode Go
  await hub.api('PUT', '/deepseek', { gateway: 'opencode-go' });
  await until(async () => providerModels().includes(GO('deepseek-v4-pro')) && !providerModels().includes(CC('deepseek-v4-pro')), 10000, 'the provider to carry OpenCode Go\'s names');

  // idle ones: the Hub's record follows at once; the native has not been asked anything, and that is no "drift"
  const wireA = wire(a.kimiSessionId).length;
  for (const [x, model] of [[a, 'deepseek-v4.1-flash'], [c, 'deepseek-v4-pro']]) {
    const sum = await snap(x.id);
    assert.equal(sum.modelConfig.model, GO(model));
    assert.equal(sum.model, GO(model), 'the label the page matches against its menu');
    assert.equal(sum.modelDrift, null, 'two spellings of one model are no drift');
    assert.equal(sum.meta.subagent.model, GO('deepseek-v4.1-flash'), 'the sub-agent setting follows too');
  }
  assert.equal((await snap(a.id)).nativeModel, CC('deepseek-v4.1-flash'), 'the native\'s own word is not rewritten');
  assert.equal(wire(a.kimiSessionId).length, wireA, 'and nothing was sent to it by the switch');
  // the running turn is not touched
  const running = await snap(b.id);
  assert.equal(running.status, 'running');
  assert.equal(running.modelConfig.model, CC('deepseek-v4-pro'));

  // A: the next message first tells the native the model's name now, then goes out
  const answeredA = await say(a.id, 'a: after the switch');
  assert.deepEqual(wire(a.kimiSessionId).slice(wireA), [`profile:${GO('deepseek-v4.1-flash')}`, 'prompt']);
  assert.equal(hub.machine.sessions.get(a.kimiSessionId).model, GO('deepseek-v4.1-flash'));
  assert.equal(answeredA.nativeModel, GO('deepseek-v4.1-flash'));
  assert.equal(answeredA.modelDrift, null);
  assert.ok(answeredA.events.some((e) => e.type === 'info' && /DeepSeek 模型名稱/.test(e.text)), 'said in the conversation');
  await say(a.id, 'a: and again');
  assert.deepEqual(wire(a.kimiSessionId).slice(wireA), [`profile:${GO('deepseek-v4.1-flash')}`, 'prompt', 'prompt'], 'once, not at every message');

  // C: choosing the same model again from the page is not "already there": the native's name for it is dead
  const wireC = wire(c.kimiSessionId).length;
  const picked = await hub.api('POST', `/sessions/${c.id}/provider`, { provider: 'deepseek', model: CC('deepseek-v4-pro'), effort: 'max' });
  assert.deepEqual(wire(c.kimiSessionId).slice(wireC), [`profile:${GO('deepseek-v4-pro')}`]);
  assert.equal(picked.nativeModel, GO('deepseek-v4-pro'));
  await say(c.id, 'c: after picking');
  assert.deepEqual(wire(c.kimiSessionId).slice(wireC), [`profile:${GO('deepseek-v4-pro')}`, 'prompt']);

  // B: the turn ends; its record was left in Command Code's spelling. Only the thinking strength
  // changes (the page's effort menu), then a message.
  hub.machine.frame(b.kimiSessionId, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(b.kimiSessionId, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await idle(b.id);
  assert.equal((await snap(b.id)).modelConfig.model, CC('deepseek-v4-pro'), 'still what it chose with');
  const wireB = wire(b.kimiSessionId).length;
  const changed = await hub.api('POST', `/sessions/${b.id}/config`, { effort: 'high' });
  assert.equal(changed.modelConfig.model, GO('deepseek-v4-pro'), 'the thinking-only change went through, and the record follows the gateway');
  assert.equal(changed.modelConfig.effort, 'high');
  assert.deepEqual(wire(b.kimiSessionId).slice(wireB), ['profile:thinking:high']);
  await say(b.id, 'b: after the switch');
  assert.deepEqual(wire(b.kimiSessionId).slice(wireB), ['profile:thinking:high', `profile:${GO('deepseek-v4-pro')}`, 'prompt']);
  assert.equal(hub.machine.sessions.get(b.kimiSessionId).model, GO('deepseek-v4-pro'));
});

// Move the names to `gw` and wait until the computer's provider carries them.
async function moveNamesTo(gw, probe) {
  await hub.api('PUT', '/deepseek', { gateway: gw });
  await until(async () => providerModels().includes(probe), 10000, `the provider to carry ${gw}'s names`);
}

test('3. when the native cannot be given the new spelling the message is NOT sent, and it says why', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.echoProfile = true;
  hub.machine.refuseProfile = false;
  const x = await newDs(GO('deepseek-v4.1-flash'));
  await say(x.id, 'x: before');
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  const mark = wire(x.kimiSessionId).length;
  hub.machine.refuseProfile = true;
  await assert.rejects(
    () => hub.api('POST', `/sessions/${x.id}/messages`, { text: 'x: must not go out' }),
    (err) => err.status === 502 && /訊息沒有送出/.test(err.message) && /DeepSeek 模型名稱現在依 Command Code/.test(err.message) && err.message.includes(GO('deepseek-v4.1-flash')) && err.message.includes(CC('deepseek-v4.1-flash')),
  );
  hub.machine.refuseProfile = false;
  assert.deepEqual(wire(x.kimiSessionId).slice(mark).filter((w) => w === 'prompt'), [], 'no prompt reached the native');
  const sum = await snap(x.id);
  assert.equal(sum.status, 'idle');
  assert.ok(sum.events.some((e) => e.type === 'error' && /訊息沒有送出/.test(e.text)));
  // refusing is not giving up: once the native takes the change the same conversation goes on
  const done = await say(x.id, 'x: now it can');
  assert.equal(done.nativeModel, CC('deepseek-v4.1-flash'));
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});

test('4. a conversation that runs in a terminal is never given a /profile change by this: the message goes where the native is', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.echoProfile = true;
  hub.machine.refuseProfile = false;
  const t = await newDs(GO('deepseek-v4.1-flash'));
  await say(t.id, 't: before');
  const native = hub.machine.sessions.get(t.kimiSessionId);
  native.owner = 'tui';
  native.controllable = false;
  hub.machine.pushSessions();
  await until(async () => (await snap(t.id)).meta.owner === 'tui', 5000, 'the terminal to be seen');
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  const mark = wire(t.kimiSessionId).length;
  const after = await say(t.id, 't: typed while the terminal owns it');
  assert.deepEqual(wire(t.kimiSessionId).slice(mark), ['prompt'], 'no /profile change');
  assert.equal(native.model, GO('deepseek-v4.1-flash'));
  assert.equal(after.modelDrift, null, 'and no drift is shown for two spellings of one model');
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});

test('5. putting the choice back on a native that wandered off uses the gateway\'s spelling, also when the Hub\'s record was left in the old one', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.echoProfile = true;
  hub.machine.refuseProfile = false;
  const d = await newDs(GO('deepseek-v4.1-flash'));
  await say(d.id, 'd: before');
  // a turn is running when the names move, so the record is not rewritten
  hub.machine.autoReply = false;
  await hub.api('POST', `/sessions/${d.id}/messages`, { text: 'd: a long job' });
  await until(async () => (await snap(d.id)).status === 'running', 5000, 'd to be running');
  hub.machine.autoReply = true;
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  hub.machine.frame(d.kimiSessionId, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(d.kimiSessionId, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await idle(d.id);
  // and something else (a global default, another client) moves the native to a Kimi model
  hub.machine.nativeChange(d.kimiSessionId, { model: SUB, thinking: 'max' });
  await until(async () => (await snap(d.id)).modelDrift?.kind === 'provider', 5000, 'the drift to show');
  assert.equal((await snap(d.id)).modelConfig.model, GO('deepseek-v4.1-flash'), 'the record is still in the old spelling');
  const mark = wire(d.kimiSessionId).length;
  const done = await say(d.id, 'd: after the drift');
  assert.deepEqual(wire(d.kimiSessionId).slice(mark), [`profile:${CC('deepseek-v4.1-flash')}`, 'prompt'], 'put back as the name the provider has now');
  assert.equal(done.nativeModel, CC('deepseek-v4.1-flash'));
  assert.equal(done.modelConfig.model, CC('deepseek-v4.1-flash'));
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});

test('6. a conversation that sends its model with each prompt sends the gateway\'s spelling, also while the turn is running and the record has not been rewritten', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.echoProfile = true;
  const k = await hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd: CWD });
  await say(k.id, 'k: before');
  // Kimi -> DeepSeek in the same runtime: the choice travels with the prompt from now on
  await hub.api('POST', `/sessions/${k.id}/provider`, { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' });
  assert.equal((await snap(k.id)).modelConfig.model, GO('deepseek-v4.1-flash'));
  hub.machine.autoReply = false;
  await hub.api('POST', `/sessions/${k.id}/messages`, { text: 'k: a long job' });
  await until(async () => (await snap(k.id)).status === 'running', 5000, 'k to be running');
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  assert.equal((await snap(k.id)).modelConfig.model, GO('deepseek-v4.1-flash'), 'a running turn: the record is left as it was');
  await hub.api('POST', `/sessions/${k.id}/messages`, { text: 'k: queued behind it' }).catch(() => {});
  const sent = hub.machine.prompts.filter((p) => p.sid === k.kimiSessionId).at(-1);
  assert.equal(sent.body.model, CC('deepseek-v4.1-flash'), 'the prompt names the model the provider has');
  hub.machine.autoReply = true;
  hub.machine.frame(k.kimiSessionId, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(k.kimiSessionId, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await idle(k.id);
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});

test('7. the same while the turn is still running: the record is not rewritten, yet the native is put back on the gateway\'s spelling', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.echoProfile = true;
  const e = await newDs(GO('deepseek-v4.1-flash'));
  await say(e.id, 'e: before');
  hub.machine.autoReply = false;
  await hub.api('POST', `/sessions/${e.id}/messages`, { text: 'e: a long job' });
  await until(async () => (await snap(e.id)).status === 'running', 5000, 'e to be running');
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  hub.machine.nativeChange(e.kimiSessionId, { model: SUB, thinking: 'max' });
  await until(async () => (await snap(e.id)).modelDrift?.kind === 'provider', 5000, 'the drift to show');
  const mark = wire(e.kimiSessionId).length;
  await hub.api('POST', `/sessions/${e.id}/messages`, { text: 'e: queued behind it' });
  assert.deepEqual(wire(e.kimiSessionId).slice(mark).slice(0, 1), [`profile:${CC('deepseek-v4.1-flash')}`], 'put back as the name the provider has');
  const sum = await snap(e.id);
  assert.equal(sum.status, 'running');
  assert.equal(sum.modelConfig.model, GO('deepseek-v4.1-flash'), 'and the record of a turn in progress is still left alone');
  hub.machine.autoReply = true;
  hub.machine.frame(e.kimiSessionId, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(e.kimiSessionId, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await idle(e.id);
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});

test('8. a native that answers the change with the old spelling did not take it: nothing is claimed, nothing is sent', async () => {
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro')); // (a test before this one may have stopped half way)
  hub.machine.refuseProfile = false;
  hub.machine.echoProfile = true;
  const w = await newDs(GO('deepseek-v4.1-flash'));
  await say(w.id, 'w: before');
  await moveNamesTo('commandcode', CC('deepseek-v4-pro'));
  const mark = wire(w.kimiSessionId).length;
  hub.machine.echoProfile = (sid, c) => ({ model: GO('deepseek-v4.1-flash'), thinking: c.thinking }); // "ok", and still on the old name
  await assert.rejects(
    () => hub.api('POST', `/sessions/${w.id}/messages`, { text: 'w: must not go out' }),
    (err) => err.status === 502 && /訊息沒有送出/.test(err.message),
  );
  assert.deepEqual(wire(w.kimiSessionId).slice(mark).filter((x) => x === 'prompt'), [], 'no prompt reached the native');
  hub.machine.echoProfile = true;
  await moveNamesTo('opencode-go', GO('deepseek-v4-pro'));
});
