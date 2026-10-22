// 插隊 (cut-in) into a turn Kimi started itself, end to end: the real hub and a
// scripted machine that speaks the bridge protocol and plays Kimi's prompt
// queue the way Kimi 2.1.1 does:
//   • `:steer` is refused with 40402 "no active prompt to steer into" while the
//     running turn was not started by a message (a background task finished,
//     a cron job), and taken in a turn a message started;
//   • `GET /prompts` shows an `active` prompt only for such a turn;
//   • aborting a queued prompt takes it out of the queue, aborting the
//     session ends the turn, and the next queued message then starts;
//   • stopping a turn leaves background tasks alone (the fake records any call
//     that would stop one, and the tests expect none).
// The hub waits for a safe point before it takes over (see
// server/adapters/kimi-remote.js: maybeHandoff). Waits are scaled down:
// AGENT_HUB_HANDOFF_GRACE_MS=1500, AGENT_HUB_CUTIN_RETRY_MS=500 and
// AGENT_HUB_AUTOPAUSE_SCALE=0.1 (a foreground tool holds a message 1 s before
// it is moved to the background).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeMachine } from './fixtures/fake-kimi-queue.mjs';
import { cutInWhyText } from '../public/js/cutin.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-cutin-'));
const PORT = 30000 + Math.floor(Math.random() * 2000);
const TOKEN = 'ci-token';
const MID = 'm_cutin';
const GRACE = 1500;
const RETRY = 500; // how often a refused message is offered to Kimi again
const DS_MODEL = 'agent-hub-deepseek/deepseek-v4-pro';
let hub;
let hubOut = '';
let machine;
let kimi; // a Kimi conversation
let deep; // a DeepSeek one (by its model)
let kimiS; // the hub's session for each
let deepS;

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_AUTOPAUSE_SCALE: '0.1', AGENT_HUB_HANDOFF_GRACE_MS: String(GRACE), AGENT_HUB_CUTIN_RETRY_MS: String(RETRY) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start:\n${hubOut}`)), 15000);
    const on = (d) => {
      hubOut += d;
      if (hubOut.includes('已啟動')) (clearTimeout(t), resolve());
    };
    hub.stdout.on('data', on);
    hub.stderr.on('data', on);
  });
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  machine = fakeMachine({ port: PORT, key, machineId: MID, models: [{ model: DS_MODEL, display_name: 'DeepSeek V4 Pro', capabilities: ['thinking', 'always_thinking'], max_context_size: 1000000, support_efforts: ['low', 'high', 'max'] }] });
  kimi = machine.add('session_cut1');
  deep = machine.add('session_cutds', { model: DS_MODEL });
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((x) => x.id === MID && x.online && x.sessions.length === 2), 10000, 'machine online');
  kimiS = await api('POST', `/machines/${MID}/kimi/session_cut1/attach`);
  deepS = await api('POST', `/machines/${MID}/kimi/session_cutds/attach`);
});

after(() => {
  machine?.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

// ---------------------------------------------------------------- helpers

const view = (hs) => () => api('GET', `/sessions/${hs.id}`);
const queueOf = async (hs) => (await view(hs)()).meta.queue || [];
const infos = async (hs) => (await view(hs)()).events.filter((e) => e.type === 'info').map((e) => e.text);
// Sends a message as 插隊 and waits until it has reached Kimi; resolves to its prompt id.
async function say(hs, text, extra = {}) {
  const k = hs === deepS ? deep : kimi;
  const n = k.prompts.length;
  await api('POST', `/sessions/${hs.id}/messages`, { text, steer: true, ...extra });
  await until(async () => k.prompts.length > n, 5000, 'the message reaching Kimi');
  return k.prompts.at(-1).promptId;
}
const logLines = (re) => hubOut.split('\n').filter((l) => re.test(l));

// Back to an idle conversation with nothing waiting and nothing scripted.
async function settle(k, hs) {
  k.steerMode = 'real';
  k.onGetPrompts = k.afterPromptAbort = null;
  k.tasks = [];
  k.pending = 'none';
  k.abortDelay = 40;
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    // (a message sent a moment ago may start its turn only now)
    if (k.active) k.endTurn();
    k.queue.length = 0;
    await sleep(120);
    const x = await view(hs)().catch(() => null);
    if (x && !k.active && x.status === 'idle' && !(x.meta.queue || []).length) return;
  }
  throw new Error('the conversation did not settle');
}

// A test that always leaves the conversation idle, so one failure does not spill into the next.
function scenario(name, fn, which = 'kimi') {
  test(name, async () => {
    const [k, hs] = which === 'kimi' ? [kimi, kimiS] : [deep, deepS];
    // The counts start from nothing in each test (except stopped tasks: none, ever).
    Object.assign(k, { steers: [], refused: [], promptAborts: [], sessionAborts: 0, abortAt: 0, detached: [] });
    try {
      await fn(k, hs);
    } finally {
      await settle(k, hs).catch(() => {});
    }
  });
}

// A turn Kimi started itself (a background task finished) that is running a command.
async function ownTurnWithTool(k, hs, { kind = 'background_task', tool = ['call_1', 'Bash', { command: 'pytest -x' }] } = {}) {
  k.startOwnTurn(kind);
  await until(async () => (await view(hs)()).status === 'running', 5000, 'running');
  if (tool) {
    k.toolStart(...tool);
    await until(async () => (await view(hs)()).events.filter((e) => e.toolCallId === tool[0]).at(-1)?.status === 'running', 5000, 'tool running');
  }
}

// The hub's calls, in order, from `from` on.
const callsSince = (k, from) => k.log.slice(from);
const position = (calls, label) => calls.findIndex((c) => c === label || (label instanceof RegExp && label.test(c)));

// ------------------------------------------------------------------ tests

scenario('a Kimi-started turn refuses the steer: the hub waits out the grace period and the running tool, then takes over at the step boundary and sends the messages again as one', async (k, hs) => {
  await ownTurnWithTool(k, hs);
  const from = k.log.length;
  const png = Buffer.from('a-full-size-picture-'.repeat(40)).toString('base64');
  const t0 = Date.now();
  const a = await say(hs, '先看一下測試結果');
  const b = await say(hs, '順便看這張圖', { images: [{ mimeType: 'image/png', data: png, thumb: 'data:image/png;base64,dGlueQ==' }] });

  // Refused, and the reason is kept on each waiting message.
  let cur = await until(async () => {
    const x = await view(hs)();
    const q = x.meta.queue || [];
    return q.length === 2 && q.every((i) => i.cutIn && i.cutInWhy === 'kimi-turn' && i.handoff === 'grace') && x;
  }, 5000, 'refused, in the grace period');
  assert.match(cur.meta.queue[0].cutInMsg, /no active prompt to steer into/);
  assert.equal(cur.status, 'running');
  assert.equal(cutInWhyText(cur.meta.queue[0], 'Kimi').includes('不收插隊'), true, 'and says so in the tray');

  // The grace period: nothing is stopped.
  await sleep(500);
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.promptAborts, []);

  // Over, but a command is still running: the hub waits for it (it is never stopped).
  cur = await until(async () => {
    const x = await view(hs)();
    return (x.meta.queue || []).length === 2 && x.meta.queue.every((i) => i.handoff === 'tool') && x;
  }, GRACE + 3000, 'waiting for the running tool');
  assert.ok(Date.now() - t0 >= GRACE, 'not before the grace period is over');
  await sleep(1500); // longer than the wait before foreground work is moved aside
  assert.equal(k.sessionAborts, 0, 'the tool is still running');
  assert.deepEqual(k.promptAborts, []);
  assert.deepEqual(k.detached, [], 'nothing Kimi could move to the background');

  // The tool is done: a step boundary. The messages are taken back, the turn is
  // stopped, and they go again as ONE new message, images at full size.
  const posts = k.prompts.length;
  k.toolResult('call_1', 'ok');
  k.stepDone();
  await until(async () => k.prompts.length === posts + 1, 8000, 'sent again');
  const calls = callsSince(k, from);
  const withdrawn = [position(calls, `prompt-abort:${a}`), position(calls, `prompt-abort:${b}`)];
  assert.ok(withdrawn.every((i) => i >= 0), "both taken back from Kimi's queue");
  assert.ok(Math.max(...withdrawn) < position(calls, 'session-abort'), 'taken back first, then the turn is stopped');
  assert.ok(calls.findLastIndex((c) => c.startsWith('post:')) > position(calls, 'session-abort'), 'then sent again');
  assert.equal(k.sessionAborts, 1);
  const again = k.prompts.at(-1);
  assert.ok(![a, b].includes(again.promptId));
  assert.equal(again.text, '先看一下測試結果\n\n順便看這張圖');
  assert.equal(again.images.length, 1);
  assert.equal(again.images[0].source.data, png, 'the picture at full size, not the thumbnail');
  assert.match(again.hidden.join('\n'), /arrived while you were continuing on your own after a background task finished/);
  assert.match(again.hidden.join('\n'), /at a step boundary/);
  assert.match(again.hidden.join('\n'), /no tool was interrupted and background tasks are still running/);

  // In the conversation: what the hub did, and one message from the user.
  cur = await until(async () => {
    const x = await view(hs)();
    return !(x.meta.queue || []).length && x.events.some((e) => e.type === 'user' && e.text === again.text) && x;
  }, 8000, 'in the conversation');
  assert.ok(cur.events.some((e) => e.type === 'info' && /不收插隊；已在步驟之間接手，讓它先讀你的訊息（背景工作照常進行，沒有中斷任何工具）/.test(e.text)));
  const bubbles = cur.events.filter((e) => e.type === 'user' && /先看一下測試結果|順便看這張圖/.test(e.text));
  assert.equal(bubbles.length, 1, 'one message, not two');
  assert.equal(bubbles[0].source, 'hub');
  assert.equal(bubbles[0].images.length, 1);
  assert.match(bubbles[0].note, /插隊/);
  // Refusals are logged once per reason, not at every retry.
  assert.equal(logLines(new RegExp(`cut-in refused .*${a}`)).length, 1);
  assert.match(logLines(new RegExp(`cut-in refused .*${a}`))[0], /kimi-turn 40402 "no active prompt to steer into"/);

  // The new turn is a message's: it takes steers from now on.
  await until(async () => k.active?.promptId === again.promptId, 5000, 'the new turn');
  await say(hs, '收到了嗎');
  await until(async () => k.steers.length >= 1, 5000, 'steered');
  await sleep(300);
  assert.equal(k.sessionAborts, 1, 'no second stop');
  assert.deepEqual(k.taskKills, []);
});

scenario('while the main agent is only writing (no tool), the hub takes over once the grace period is over; the unfinished step is dropped and Kimi is told', async (k, hs) => {
  await ownTurnWithTool(k, hs, { kind: 'cron_job', tool: null });
  k.think('想了很久…');
  await sleep(100);
  const t0 = Date.now();
  await say(hs, '停一下，先回答我');
  await until(async () => (await queueOf(hs))[0]?.handoff === 'grace', 5000, 'in the grace period');
  await sleep(500);
  assert.equal(k.sessionAborts, 0, 'not within the grace period');
  const again = await until(async () => k.sessionAborts === 1 && k.prompts.at(-1).text === '停一下，先回答我' && k.prompts.at(-1).hidden.length && k.prompts.at(-1), GRACE + 4000, 'taken over');
  assert.ok(Date.now() - t0 >= GRACE);
  assert.match(again.hidden.join('\n'), /after a scheduled job fired/);
  assert.match(again.hidden.join('\n'), /in the middle of a step/);
  const cur = await until(async () => {
    const x = await view(hs)();
    return x.events.some((e) => e.type === 'user' && e.text === '停一下，先回答我') && x;
  }, 5000, 'in the conversation');
  assert.ok(cur.events.some((e) => e.type === 'info' && /思考或輸出的途中接手/.test(e.text) && /那一步還沒寫完的內容沒有保留/.test(e.text)));
  assert.deepEqual(k.taskKills, []);
});

scenario('全部插隊 does not wait for the grace period', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  const t0 = Date.now();
  await say(hs, '第一件事');
  await say(hs, '第二件事');
  await until(async () => (await queueOf(hs)).length === 2 && (await queueOf(hs)).every((q) => q.handoff === 'grace'), 5000, 'both waiting');
  const r = await api('POST', `/sessions/${hs.id}/queue/steer-all`);
  assert.deepEqual(r, { count: 2, steered: 0, waiting: 2 });
  await until(async () => k.sessionAborts === 1, 4000, 'taken over');
  assert.ok(k.abortAt - t0 < GRACE - 300, `at once (${k.abortAt - t0} ms), not after ${GRACE} ms`);
  const again = await until(async () => k.prompts.at(-1).text === '第一件事\n\n第二件事' && k.prompts.at(-1), 5000, 'one message');
  assert.equal(again.hidden.length, 1);
  assert.deepEqual(k.taskKills, []);
});

scenario('全部插隊 with foreground work running: it is moved to the background first (never stopped), then the hub takes over', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: ['call_fg', 'Agent', { description: '跑全量測試', prompt: '跑全量測試' }] });
  k.tasks = [
    { id: 'agent-fg1', kind: 'agent', status: 'running', run_in_background: false, parent_tool_call_id: 'call_fg' },
    { id: 'agent-bg1', kind: 'agent', status: 'running', run_in_background: true, parent_tool_call_id: 'call_old' },
  ];
  const from = k.log.length;
  await say(hs, '先暫停一下');
  await say(hs, '再回答我一個問題');
  await until(async () => (await queueOf(hs)).length === 2 && (await queueOf(hs)).every((q) => q.cutInWhy === 'kimi-turn'), 5000, 'refused');
  await api('POST', `/sessions/${hs.id}/queue/steer-all`);
  await until(async () => k.sessionAborts === 1, 5000, 'taken over');
  assert.deepEqual(k.detached, ['agent-fg1'], "only the conversation's own foreground work");
  const calls = callsSince(k, from);
  assert.ok(position(calls, 'detach:agent-fg1') >= 0 && position(calls, 'detach:agent-fg1') < position(calls, 'session-abort'), 'moved first');
  const cur = await until(async () => {
    const x = await view(hs)();
    return x.events.some((e) => e.type === 'user' && e.text === '先暫停一下\n\n再回答我一個問題') && x;
  }, 5000, 'sent again');
  assert.ok(cur.events.some((e) => e.type === 'info' && /移到背景/.test(e.text)));
  assert.deepEqual(k.taskKills, []);
});

scenario('a message sent as 插隊 never stops a running tool: it waits, and only then moves foreground work to the background', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: ['call_fg', 'Agent', { description: '跑全量測試', prompt: '跑全量測試' }] });
  k.tasks = [{ id: 'agent-fg1', kind: 'agent', status: 'running', run_in_background: false, parent_tool_call_id: 'call_fg' }];
  const t0 = Date.now();
  await say(hs, '有空的時候回答我');
  await until(async () => (await queueOf(hs))[0]?.handoff === 'grace', 5000, 'in the grace period');
  await sleep(800);
  assert.deepEqual(k.detached, [], 'not within the grace period');
  assert.equal(k.sessionAborts, 0);
  await until(async () => k.detached.length === 1, GRACE + 4000, 'moved to the background');
  assert.ok(Date.now() - t0 >= GRACE + 800, 'after the grace period and a wait of its own');
  assert.deepEqual(k.detached, ['agent-fg1']);
  await until(async () => k.sessionAborts === 1, 5000, 'taken over');
  assert.equal(k.prompts.at(-1).text, '有空的時候回答我');
  assert.deepEqual(k.taskKills, []);
});

scenario("a turn a message started takes steers: a refusal there is a race, retried, and nothing is ever stopped", async (k, hs) => {
  k.startTurn('做一件事', { tracked: true, kind: 'user' });
  await until(async () => (await view(hs)()).status === 'running', 5000, 'running');
  k.steerMode = 'refuse';
  const before = k.prompts.length;
  await say(hs, '請也看一下這個');
  const q = await until(async () => (await queueOf(hs)).find((x) => x.cutInWhy === 'kimi-turn'), 5000, 'refused');
  assert.equal(q.handoff, undefined, 'no handoff planned');
  assert.match(cutInWhyText(q, 'Kimi'), /暫時沒收這則插隊/);
  await sleep(GRACE + 1200);
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.promptAborts, []);
  assert.ok(k.refused.length >= 2, 'offered again');
  assert.equal(k.prompts.length, before + 1, 'sent once');
  k.steerMode = 'real';
  await until(async () => k.steers.includes(q.promptId), 5000, 'taken in');
  await until(async () => !(await queueOf(hs)).length, 5000, 'out of the tray');
});

scenario('Kimi takes the message in during the grace period: no stop, no second copy', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  const before = k.prompts.length;
  const id = await say(hs, '請接著做這個');
  await until(async () => (await queueOf(hs))[0]?.cutInWhy === 'kimi-turn', 5000, 'refused');
  k.steerMode = 'accept';
  await until(async () => k.steers.includes(id), 5000, 'taken in');
  await until(async () => !(await queueOf(hs)).length, 5000, 'out of the tray');
  await sleep(GRACE + 500);
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.promptAborts, []);
  assert.equal(k.prompts.length, before + 1, 'no second copy');
});

scenario("the turn ends during the grace period: Kimi runs the first message and takes the others into that turn; nothing is stopped or sent twice", async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  const before = k.prompts.length;
  const a = await say(hs, '甲');
  const b = await say(hs, '乙');
  await until(async () => (await queueOf(hs)).length === 2 && (await queueOf(hs)).every((q) => q.cutInWhy === 'kimi-turn'), 5000, 'both refused');
  k.endTurn();
  await until(async () => k.steers.includes(b), 6000, 'the second taken into the first one\'s turn');
  assert.equal(k.active.promptId, a);
  await until(async () => !(await queueOf(hs)).length, 5000, 'out of the tray');
  await sleep(GRACE + 300);
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.promptAborts, []);
  assert.equal(k.prompts.length, before + 2, 'each sent once');
});

scenario("the turn ends just as the hub looks (the handoff's last check): the message's turn is left alone", async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  const before = k.prompts.length;
  const a = await say(hs, '甲');
  const b = await say(hs, '乙');
  await until(async () => (await queueOf(hs)).length === 2 && (await queueOf(hs)).every((q) => q.cutInWhy === 'kimi-turn'), 5000, 'both refused');
  // Kimi's own turn ends at the very moment the hub asks what it is running.
  k.onGetPrompts = () => {
    k.onGetPrompts = null;
    k.endTurn();
  };
  await until(async () => k.active?.promptId === a, GRACE + 4000, 'Kimi runs the first message');
  await until(async () => k.steers.includes(b), 6000, 'the second taken in');
  await sleep(500);
  assert.equal(k.sessionAborts, 0, "the message's turn is never stopped");
  assert.deepEqual(k.promptAborts, []);
  assert.equal(k.prompts.length, before + 2);
});

scenario('the turn ends by itself while the hub takes the message back: it is sent again once, without a stop', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  const before = k.prompts.length;
  const id = await say(hs, '單獨一則');
  await until(async () => (await queueOf(hs))[0]?.cutInWhy === 'kimi-turn', 5000, 'refused');
  k.afterPromptAbort = () => k.endTurn();
  await until(async () => k.prompts.length === before + 2, GRACE + 5000, 'sent again');
  assert.equal(k.sessionAborts, 0, 'nothing left to stop');
  assert.deepEqual(k.promptAborts, [id]);
  assert.equal(k.prompts.at(-1).text, '單獨一則');
  await sleep(500);
  assert.equal(k.prompts.length, before + 2, 'once');
  const cur = await view(hs)();
  assert.equal(cur.events.filter((e) => e.type === 'user' && e.text === '單獨一則').length, 1);
});

scenario('messages sent again by the hub are never handed off a second time, even if Kimi goes straight on to another turn of its own', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  k.nudgeAfterAbort = true;
  const before = k.prompts.length;
  await say(hs, '只接手一次');
  await until(async () => k.sessionAborts === 1, GRACE + 4000, 'taken over');
  const again = await until(async () => k.prompts.length === before + 2 && k.prompts.at(-1), 5000, 'sent again');
  // Kimi's new turn of its own refuses it: it waits there, for good reason, and is not handed off again.
  const q = await until(async () => (await queueOf(hs)).find((x) => x.promptId === again.promptId && x.cutInWhy === 'kimi-turn'), 5000, 'refused again');
  assert.equal(q.handedOff, true);
  assert.match(cutInWhyText(q, 'Kimi'), /已經接手重送過一次，不會再停它/);
  await sleep(GRACE + 1500);
  assert.equal(k.sessionAborts, 1, 'not stopped a second time');
  assert.deepEqual(k.promptAborts.length, 1);
  assert.equal(k.prompts.length, before + 2);
  // That turn ends: Kimi reads it.
  k.endTurn();
  await until(async () => k.active?.promptId === again.promptId, 5000, 'Kimi runs it');
  await until(async () => !(await queueOf(hs)).length, 5000, 'out of the tray');
});

scenario('background tasks keep Kimi\'s session busy with no turn: the hub waits for the turn to end, not for an idle session', async (k, hs) => {
  k.bgBusy = true; // as in real use: a long background task is running
  try {
    await ownTurnWithTool(k, hs, { tool: null });
    await say(hs, '背景工作還在跑，先回答我');
    await until(async () => k.sessionAborts === 1, GRACE + 4000, 'taken over');
    // Sent again at once (a wait for an idle session would take 15 s, which never comes).
    const again = await until(async () => k.prompts.at(-1).hidden.length && k.prompts.at(-1).text === '背景工作還在跑，先回答我' && k.prompts.at(-1), 3000, 'sent again at once');
    assert.ok(Date.now() - k.abortAt < 2500, 'not after a long wait');
    const cur = await until(async () => {
      const x = await view(hs)();
      return x.events.some((e) => e.type === 'user' && e.text === again.text) && !(x.meta.queue || []).length && x;
    }, 5000, 'in the conversation');
    assert.equal(cur.events.filter((e) => e.type === 'user' && e.text === again.text).length, 1);
    assert.deepEqual(k.taskKills, []);
  } finally {
    k.bgBusy = false;
    k.endTurn();
    k.work(false);
  }
});

scenario('a subagent swarm in the foreground cannot be moved: nothing is stopped; the existing interrupt path still works', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: ['call_sw', 'AgentSwarm', { description: '掃描所有模組' }] });
  await say(hs, '先回答我');
  await until(async () => (await queueOf(hs))[0]?.handoff === 'swarm', GRACE + 4000, 'waiting for the swarm');
  await sleep(1500);
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.detached, []);
  assert.match(cutInWhyText((await queueOf(hs))[0], 'Kimi'), /子代理群/);
  // 全部插隊 does not stop it either.
  await say(hs, '還有一件事');
  await api('POST', `/sessions/${hs.id}/queue/steer-all`);
  await sleep(1200);
  assert.equal(k.sessionAborts, 0, "not even by hand: that needs the swarm's own confirmation");
  // The user's choice (移到背景 → 中斷並送出訊息): the existing path.
  const r = await api('POST', `/sessions/${hs.id}/background`, { interruptSwarm: true });
  assert.equal(r.interrupted, true);
  assert.equal(k.sessionAborts, 1);
  const again = k.prompts.at(-1);
  assert.equal(again.text, '先回答我\n\n還有一件事');
  assert.match(again.hidden.join('\n'), /AgentSwarm/);
  assert.deepEqual(k.taskKills, []);
});

scenario('a question or approval waiting for you is never skipped: the hub takes over after you answer, at the next boundary', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: ['call_a', 'Bash', { command: 'rm -rf build' }] });
  k.pending = 'approval';
  k.frame('event.approval.requested', { approval_id: 'ap1', tool_call_id: 'call_a', tool_name: 'Bash', action: 'run command', display: { kind: 'command', command: 'rm -rf build' } });
  await until(async () => (await view(hs)()).status === 'awaiting_permission', 5000, 'awaiting');
  await say(hs, '等一下');
  await until(async () => (await queueOf(hs))[0]?.handoff === 'approval', GRACE + 4000, 'waiting for the approval');
  await sleep(1200);
  assert.equal(k.sessionAborts, 0);
  // Approved: the command runs, then ends; only then.
  k.pending = 'none';
  k.frame('event.approval.resolved', { approval_id: 'ap1', decision: 'approved' });
  k.frame('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
  await sleep(1200);
  assert.equal(k.sessionAborts, 0, 'the command is running');
  k.toolResult('call_a');
  k.stepDone();
  await until(async () => k.sessionAborts === 1, 5000, 'taken over');
  assert.equal(k.prompts.at(-1).text, '等一下');
  assert.deepEqual(k.taskKills, []);
});

scenario('another failure is shown and retried, never a handoff', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  k.steerMode = 'other';
  const id = await say(hs, '會失敗的插隊');
  const q = await until(async () => (await queueOf(hs))[0]?.cutInWhy === 'other' && (await queueOf(hs))[0], 5000, 'refused for another reason');
  assert.equal(q.cutInMsg, 'boom');
  assert.equal(q.handoff, undefined);
  assert.match(cutInWhyText(q, 'Kimi'), /boom/);
  await sleep(1600);
  assert.ok(k.refused.filter((x) => x === id).length >= 2, 'retried');
  assert.equal(logLines(new RegExp(`cut-in refused .*${id}`)).length, 1, 'said once, not at every retry');
  assert.equal(k.sessionAborts, 0);
});

scenario('a message Kimi has lost is let go after a second look, saying so', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  k.steerMode = 'notpending';
  k.onGetPrompts = () => {
    k.queue.length = 0;
  };
  await say(hs, '被 Kimi 弄丟的');
  const lost = await until(async () => (await queueOf(hs))[0]?.cutInWhy === 'not-pending' && (await queueOf(hs))[0], 5000, 'not pending');
  assert.match(cutInWhyText(lost, 'Kimi'), /找不到這則排隊的訊息/);
  await until(async () => !(await queueOf(hs)).length, 8000, 'let go');
  assert.ok((await infos(hs)).some((t) => /找不到這則排隊的訊息「被 Kimi 弄丟的」/.test(t)));
  assert.equal(k.sessionAborts, 0);
  assert.deepEqual(k.promptAborts, []);
});

scenario('a DeepSeek conversation works the same way, in its own name', async (k, hs) => {
  await ownTurnWithTool(k, hs, { tool: null });
  assert.equal((await view(hs)()).meta.model, DS_MODEL);
  await say(hs, 'DeepSeek 先回答我');
  await until(async () => (await queueOf(hs))[0]?.handoff === 'grace', 5000, 'in the grace period');
  assert.match(cutInWhyText((await queueOf(hs))[0], 'DeepSeek'), /^DeepSeek 正在自己接續的回合/);
  await until(async () => k.sessionAborts === 1, GRACE + 4000, 'taken over');
  const cur = await until(async () => {
    const x = await view(hs)();
    return x.events.some((e) => e.type === 'user' && e.text === 'DeepSeek 先回答我') && x;
  }, 5000, 'sent again');
  assert.ok(cur.events.some((e) => e.type === 'info' && /^DeepSeek 正在自己接續的回合不收插隊；已在/.test(e.text)));
  assert.deepEqual(k.taskKills, []);
}, 'deep');

test('what the tray says about a waiting message', () => {
  const q = (f) => ({ cutIn: true, cutInWhy: 'kimi-turn', ...f });
  assert.equal(cutInWhyText({ text: 'x' }, 'Kimi'), null, 'not waiting to cut in');
  assert.equal(cutInWhyText(q({ steered: true }), 'Kimi'), null, 'already taken in');
  assert.equal(cutInWhyText({ cutIn: true }, 'Kimi'), null, 'not refused yet');
  for (const h of ['grace', 'tool', 'swarm', 'approval']) assert.match(cutInWhyText(q({ handoff: h }), 'Kimi'), /^Kimi 正在自己接續的回合（背景工作完成後自動開始），這種回合不收插隊。/, h);
  assert.match(cutInWhyText(q({ handoff: 'grace' }), 'Kimi'), /下一個安全點接手/);
  assert.match(cutInWhyText(q({ handoff: 'tool' }), 'DeepSeek'), /^DeepSeek .*等這個工具做完就接手，不會中斷工具/);
  assert.match(cutInWhyText(q({ handoff: 'working' }), 'Kimi'), /正在接手/);
  assert.match(cutInWhyText(q({}), 'Kimi'), /暫時沒收這則插隊/);
  assert.match(cutInWhyText({ cutIn: true, cutInWhy: 'other', cutInMsg: 'boom' }, 'Kimi'), /Kimi 沒收下這則插隊（boom）/);
  assert.match(cutInWhyText({ cutIn: true, cutInWhy: 'not-pending' }, 'Kimi'), /找不到這則排隊的訊息/);
});

test('no call in any of this stopped a background task', () => {
  assert.deepEqual(kimi.taskKills, []);
  assert.deepEqual(deep.taskKills, []);
});
