// The small squares of the cluster screens from a Kimi's frames to the pixels, with
// nothing between them faked but the computer's Kimi: a real Hub (runner,
// kimi-remote adapter, cluster.js, timing.js) serving the real page, and a real
// Chromium that only clicks and reads. The page's own requests are NOT
// intercepted or answered. The fake computer speaks the frames the real Kimi 2.3.3
// sends for an AgentSwarm (one call; per member `subagent.spawned`, `.started`,
// `.completed`; the member's own steps carry its agentId), and the connector's
// request records the DeepSeek proxy writes.
//
// What it settles that the scripted-Hub tests (ui-cluster-squares) cannot: the
// numbers on the page are the numbers the Hub computes from those frames, live
// and without a reload, in the tile, in the band, in the drawer, in the list of
// every cluster and in the sidebar - and they are the same numbers everywhere.
//
// Skips, saying why, when there is no Chromium. CLUSTER_UI_SHOTS=<dir> saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skipReason, launchBrowser } from './browser-harness.mjs';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';
import { summarizeCluster, totalsOf } from '../public/js/cluster-model.js';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
const MID = 'm_fake';
const FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
let hub;
let b;
let page;
let DEEPSEEK;
const S = {};

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const newDeepseek = (extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd: hub.TMP, model: DEEPSEEK.model, effort: 'max', permission: 'auto', ...extra });
const dispatch = (parent, n, extra = {}) => hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: Array.from({ length: n }, (_, i) => ({ title: `任務 ${i + 1}`, prompt: `做第 ${i + 1} 條` })), isolate: false, workers: n, ...extra });
const shot = async (name) => SHOTS && (await b.sleep(400), b.shot(path.join(SHOTS, name)));
const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.trim() ?? null`);
const statNum = (key) => text(`[data-stat="${key}"] [data-field="num"]`);
const tileCount = (sid) => text(`.cluster-worker[data-session="${sid}"] [data-field="subcount"]`);

// A frame stream of one worker's conversation.
const stream = async (sid) => {
  const kid = await kidOf(sid);
  const f = (type, payload) => hub.machine.frame(kid, type, payload);
  return {
    kid,
    f,
    working() {
      f('turn.started', { turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, prompt: 'x' });
      f('event.session.work_changed', { busy: true, pending_interaction: 'none' });
    },
    swarm(call, ids) {
      f('tool.call.started', { toolCallId: call, name: 'AgentSwarm', args: { description: '群', items: ids }, description: 'Launching agent swarm: 群' });
      ids.forEach((id, i) => {
        f('subagent.spawned', { subagentId: id, subagentName: 'coder', parentToolCallId: call, parentAgentId: 'main', callerAgentId: 'main', description: `群 #${i + 1} (coder)`, swarmIndex: i + 1, runInBackground: false, model: FLASH, thinkingEffort: 'max' });
        f('subagent.started', { subagentId: id });
      });
    },
    step(agentId, n, command, finish = true) {
      f('tool.call.started', { agentId, toolCallId: `${agentId}-t${n}`, name: 'Bash', args: { command }, description: command });
      if (finish) f('tool.result', { agentId, toolCallId: `${agentId}-t${n}`, output: 'ok' });
    },
    done: (id) => f('subagent.completed', { subagentId: id, resultSummary: 'ok' }),
    failed: (id) => f('subagent.failed', { subagentId: id, error: '壞了' }),
  };
};

before(async () => {
  if (skip) return;
  hub = await startRealHub('cluster-squares');
  await hub.setDeepseekKey();
  hub.machine.autoReply = false;
  hub.machine.send({ t: 'broker.ready', broker: 1, capabilities: ['pool', 'pool_cross', 'handoff', 'pool_timing'] });
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID).capabilities.includes('pool_timing'), 5000, 'pool_timing');
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  DEEPSEEK = { model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id };
  b = await launchBrowser({ width: 1280, height: 900 });
  page = clusterPage({ b, base: `http://127.0.0.1:${hub.PORT}/`, cluster: getCluster });
});
after(async () => {
  await b?.close();
  await hub?.stop();
});

test('an AgentSwarm of six in one worker: the tile, the band and the drawer show six squares and follow the members live, with no reload', { skip }, async () => {
  S.p1 = await newDeepseek();
  S.c1 = (await dispatch(S.p1, 2)).cluster;
  const [w1, w2] = S.c1.workers;
  S.w1 = await stream(w1.sessionId);
  S.w2 = await stream(w2.sessionId);
  await page.open(`#/cluster/${S.c1.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  assert.equal(await statNum('subagents'), '0', 'nothing opened yet');
  assert.match(await text('[data-stat="subagents"] [data-field="sub"]'), /共開過 0 個/);

  S.w1.working();
  S.w1.swarm('SW', ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  await b.waitFor(`document.querySelector('[data-stat="subagents"] [data-field="num"]')?.innerText.trim() === '6'`, { label: 'the band counts the six members, not one swarm card' });
  assert.equal(await tileCount(w1.sessionId), '子代理 6/6');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker[data-session="${w1.sessionId}"] .cw-mini').length`), 6);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker[data-session="${w2.sessionId}"] .cw-mini').length`), 0);

  // Members work, two finish, one fails.
  S.w1.step('m0', 1, 'ls');
  S.w1.step('m0', 2, 'wc -l /home/user/proj/AGENTS.md', false);
  S.w1.step('m1', 1, 'git status');
  S.w1.done('m2');
  S.w1.done('m3');
  S.w1.failed('m4');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${w1.sessionId}"] [data-field="subcount"]')?.innerText.trim() === '子代理 3/6'`, { label: 'three are still working' });
  assert.equal(await statNum('subagents'), '3');
  assert.match(await text('[data-stat="subagents"] [data-field="sub"]'), /共開過 6 個/);
  // What the Hub says is what the page says: one function, two places.
  const api = await getCluster(S.c1.id);
  const sum = summarizeCluster(api);
  assert.deepEqual([sum.subagents.running, sum.subagents.done, sum.subagents.failed, sum.subagents.total], [3, 2, 1, 6]);
  assert.equal(await statNum('subagents'), String(sum.subagents.running + sum.subagents.awaiting));
  assert.equal(await statNum('workers'), String(sum.workersRunning));

  // The drawer: six squares with the glyph of their state, and the detail of one.
  await page.openDrawer(w1.sessionId);
  const squares = await b.eval(`[...document.querySelectorAll('.cluster-drawer .sa-cell')].map((c) => [c.dataset.status, c.innerText.trim()])`);
  assert.deepEqual(squares, [['running', ''], ['running', ''], ['done', '✓'], ['done', '✓'], ['failed', '✕'], ['running', '']], 'in the order they were opened');
  assert.equal(await text('.cluster-drawer [data-field="subagent-line"]'), '子代理 6：3 執行中・2 完成・1 失敗或取消');
  await b.click('.cluster-drawer .sa-cell[data-id="m0"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  assert.equal(await text('.sa-detail [data-field="title"]'), '群 #1 (coder)');
  assert.equal(await text('.sa-detail [data-field="steps"]'), '2 步');
  assert.equal(await text('.sa-detail [data-field="last-action"]'), '執行 wc -l /home/user/proj/AGENTS.md');
  assert.match(await text('.sa-detail [data-field="model"]'), /deepseek-v4\.1-flash.* · 思考 max/i);
  await shot('e2e-squares-drawer-1280.png');
  // ... and follows it: that member takes another step and finishes; the open detail moves with it.
  S.w1.step('m0', 3, 'echo 做完了');
  await b.waitFor(`document.querySelector('.sa-detail [data-field="steps"]')?.innerText.trim() === '3 步'`);
  assert.equal(await text('.sa-detail [data-field="last-action"]'), '執行 echo 做完了');
  S.w1.done('m0');
  await b.waitFor(`document.querySelector('.sa-detail [data-field="state"]')?.innerText.trim() === '完成'`);
  assert.match(await text('.sa-detail [data-field="finished"]'), /^\d{4}-/);
  assert.match(await text('.sa-detail [data-field="span"]'), /^跑了 /);
  assert.equal(await text('.cluster-drawer [data-field="subagent-line"]'), '子代理 6：2 執行中・3 完成・1 失敗或取消');
  await page.closeDrawer();
  await shot('e2e-squares-page-1280.png');
});

test('a worker waiting for an approval reads awaiting everywhere: its square, the tile count, the band', { skip }, async () => {
  const f = S.w1.f;
  f('tool.call.started', { agentId: 'm1', toolCallId: 'ap1', name: 'Bash', args: { command: 'rm -rf build' }, description: 'rm -rf build' });
  f('event.approval.requested', { agent_id: 'm1', tool_call_id: 'ap1', approval_id: 'AP1', tool_name: 'Bash', action: 'run', tool_input_display: { kind: 'command', command: 'rm -rf build' } });
  await b.waitFor(`document.querySelector('[data-stat="subagents"] [data-field="sub"]')?.innerText.includes('1 個等你核准')`);
  await page.openDrawer(S.c1.workers[0].sessionId);
  assert.deepEqual(await b.eval(`(() => { const c = document.querySelector('.cluster-drawer .sa-cell[data-id="m1"]'); return [c.dataset.status, c.innerText.trim(), c.getAttribute('aria-label')]; })()`), ['awaiting', '!', '子代理 2，「群 #2 (coder)」，等你核准，最新動作 執行 rm -rf build']);
  await page.closeDrawer();
  f('event.approval.resolved', { approval_id: 'AP1', decision: 'approved' });
  await b.waitFor(`!document.querySelector('[data-stat="subagents"] [data-field="sub"]')?.innerText.includes('等你核准')`);
});

test('the three numbers: a tile says the worker\'s 生成速度 (the chat room\'s own number), the band says 叢集總產出 (the last minute of every agent, subagents included) with the 平均產出 it used to say small under it; "—" for a worker with no step; no time left anywhere', { skip }, async () => {
  const [w1, w2] = S.c1.workers;
  // The window cannot be longer than the cluster's life: a few seconds of it, then records inside it.
  await wait(Math.max(0, 6500 - (Date.now() - S.c1.createdAt)));
  // Worker 1 generates: Kimi counts what a step wrote and times its streaming (300 tokens in 1.0 s, then 100 in 3.0 s).
  S.w1.f('turn.step.completed', { turnId: 't1', step: 1, stepId: 'e2e-g1', usage: { output: 300 }, llmStreamDurationMs: 1000 });
  S.w1.f('turn.step.completed', { turnId: 't1', step: 2, stepId: 'e2e-g2', usage: { output: 100 }, llmStreamDurationMs: 3000 });
  const now = Date.now();
  hub.machine.send({
    t: 'deepseek.requests',
    boot: 'b1',
    since: now - 3_600_000,
    replay: false,
    records: [
      // Worker 1's conversation: its own request and a subagent\'s (the same session id)...
      { id: 'sq-1', req: 1, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: S.w1.kid, recvAt: now - 4000, startAt: now - 3900, headersMs: 50, firstByteMs: 80, endMs: 900, status: 200, outcome: 'ok', inflight: 1, outTokens: 300 },
      { id: 'sq-2', req: 2, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: S.w1.kid, recvAt: now - 2500, startAt: now - 2400, headersMs: 50, firstByteMs: 80, endMs: 900, status: 200, outcome: 'ok', inflight: 1, outTokens: 500 },
      // ...and worker 2\'s.
      { id: 'sq-3', req: 3, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: S.w2.kid, recvAt: now - 2000, startAt: now - 1900, headersMs: 50, firstByteMs: 80, endMs: 900, status: 200, outcome: 'ok', inflight: 1, outTokens: 200 },
    ],
  });
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${w1.sessionId}"] [data-field="gen"]')?.innerText.trim().startsWith('生成 100 · 平均')`, { timeout: 10000, label: 'the tile shows worker 1\'s generation speed' });
  const api = await getCluster(S.c1.id);
  // The tile is the chat room\'s number: the very meta.tps of the conversation (400 tokens over 4.0 s of streaming).
  assert.equal((await snap(w1.sessionId)).meta.tps, 100);
  assert.equal(api.workers[0].gen.tokensPerSecond, 100);
  // ...with the worker's five-minute average beside it (the Hub's own, waiting in it: a different number, and said as one).
  assert.match(await text(`.cluster-worker[data-session="${w1.sessionId}"] [data-field="gen"]`), /^生成 100 · 平均 \d+(\.\d)?$/);
  // Worker 2 has no step done: nothing was measured, so a dash - not 0, and not worker 1\'s.
  assert.equal(api.workers[1].gen.tokensPerSecond, null);
  assert.equal(await text(`.cluster-worker[data-session="${w2.sessionId}"] [data-field="gen"]`), '—');
  // The band: 1000 tokens of the whole cluster over one window no longer than the cluster has lived.
  const t = api.throughput;
  assert.equal(t.outTokens, 1000);
  assert.deepEqual([t.workersCounted, t.workers], [2, 2]);
  assert.ok(t.windowMs >= 5000 && t.windowMs <= Date.now() - S.c1.createdAt + 50, `the window is the cluster\'s age: ${t.windowMs} ms`);
  assert.equal(t.tokensPerSecond, Math.round((1000 / (t.windowMs / 1000)) * 10) / 10);
  const near = (x, y) => Math.abs(x - y) <= Math.max(2, y * 0.25);
  await b.waitFor(`document.querySelector('[data-stat="output"] [data-field="num"]')?.innerText.trim() !== '—'`, { timeout: 10000, label: 'the band shows the cluster\'s output' });
  assert.equal(await text('[data-stat="output"] .ch-stat-label'), '叢集總產出');
  assert.ok(near(Number(await statNum('output')), (await getCluster(S.c1.id)).throughput.tokensPerSecond), 'band vs Hub');
  assert.match(await text('[data-stat="output"] [data-field="sub"]'), /^最近 \d+ 秒（叢集才跑了這麼久）・所有代理（含子代理）$/, 'a cluster a few seconds old says the window it was measured over');
  assert.match(await text('[data-stat="output"] [data-field="avg"]'), /^平均產出（最近 5 分鐘）\d+(\.\d)? tok\/s$/, 'and the average it used to say is still there, small');
  assert.equal(await b.eval(`document.querySelector('[data-stat="output"]').title.startsWith('最近 1 分鐘所有代理（含子代理）實際產出的字數 ÷ 60 秒')`), true);
  await shot('e2e-squares-numbers-1280.png');
  // The drawer says each in words: 生成速度, then 平均產出 with its window and the requests.
  await page.openDrawer(w1.sessionId);
  assert.equal(await text('[data-sec="generation"] [data-field="gen"]'), '100 tok/s');
  assert.match(await text('[data-sec="speed"] h3'), /^平均產出（最近 \d+ 秒，含等待）$/);
  assert.match(await text('[data-field="tokens"]'), /^平均產出（最近 \d+ 秒，含等待）：\d+(\.\d)? tok\/s$/);
  assert.match(await text('[data-field="requests"]'), /^請求 \d+(\.\d)?／分$/);
  await shot('e2e-squares-numbers-drawer-1280.png');
  await page.closeDrawer();
  await page.openDrawer(w2.sessionId);
  assert.match(await text('[data-field="gen-why"]'), /^—　量不到：這一輪還沒有完成任何一步/);
  await page.closeDrawer();
  const everything = await b.eval(`document.body.innerText`);
  assert.doesNotMatch(everything, /ETA|剩餘|預計|預估|還要|remaining/i, 'nowhere does the page say how long anything will take');
});

test('a second cluster: the list of every cluster, the big numbers over both, the sidebar number - all from the same summaries, live', { skip }, async () => {
  S.p2 = await newDeepseek();
  S.c2 = (await dispatch(S.p2, 1)).cluster;
  S.w3 = await stream(S.c2.workers[0].sessionId);
  S.w3.working();
  S.w3.swarm('SW3', ['n0', 'n1', 'n2']);
  await until(async () => (await getCluster(S.c2.id)).workers[0].subagentCounts.running === 3, 8000, 'three members');
  await page.open('#/clusters');
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 2`);
  // Two clusters, the newer first (both are working).
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => c.dataset.cluster)`), [S.c2.id, S.c1.id]);
  const rows = await hub.api('GET', '/clusters');
  assert.equal(rows.length, 2);
  const t = totalsOf(rows);
  assert.equal(t.subagentsOpened, 9);
  assert.equal(await text('.cl-stat[data-stat="subagents-running"] [data-field="num"]'), String(t.subagentsRunning));
  assert.match(await text('.cl-stat[data-stat="subagents-running"] [data-field="sub"]'), /共開過 9 個/);
  assert.equal(await text('.cl-stat[data-stat="workers-running"] [data-field="num"]'), String(t.workersRunning));
  assert.equal(t.workersRunning, 3);
  assert.equal(await text('.cluster-nav-count'), String(t.subagentsRunning), 'the sidebar says the same');
  assert.equal(await text(`.cluster-card[data-cluster="${S.c2.id}"] [data-field="subagents"]`), '子代理 3/3');
  assert.equal(await text(`.cluster-card[data-cluster="${S.c1.id}"] [data-field="subagents"]`), '子代理 3/6'.replace('3/6', `${rows.find((r) => r.id === S.c1.id).subagents.running + rows.find((r) => r.id === S.c1.id).subagents.awaiting}/6`));
  // The card is called by the cluster's own name; the conversation it was sent from is the small line under it.
  assert.equal(await text(`.cluster-card[data-cluster="${S.c1.id}"] .cc-title`), (await getCluster(S.c1.id)).name);
  assert.equal(await text(`.cluster-card[data-cluster="${S.c1.id}"] .cc-parent`), `主對話：${(await snap(S.p1.id)).title}`);
  await shot('e2e-squares-list-1280.png');

  // Live, with no reload: two of the new members finish.
  S.w3.done('n0');
  S.w3.done('n1');
  await b.waitFor(`document.querySelector('.cluster-card[data-cluster="${S.c2.id}"] [data-field="subagents"]')?.innerText.trim() === '子代理 1/3'`);
  const after = totalsOf(await hub.api('GET', '/clusters'));
  assert.equal(await text('.cl-stat[data-stat="subagents-running"] [data-field="num"]'), String(after.subagentsRunning));
  assert.equal(await text('.cluster-nav-count'), String(after.subagentsRunning));
  assert.equal(after.subagentsRunning, t.subagentsRunning - 2);

  // A card is a link to its cluster.
  await b.click(`.cluster-card[data-cluster="${S.c1.id}"]`);
  await b.waitFor(`location.hash === '#/cluster/${S.c1.id}'`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
});

test('every working cluster ends: the numbers go to zero, the sidebar number goes away, and what ended is listed after the working ones', { skip }, async () => {
  await page.open('#/clusters');
  await b.waitFor(`document.querySelectorAll('.cluster-card').length === 2`);
  // Everything ends: every member done, every worker's turn over.
  for (const [w, ids] of [[S.w1, ['m0', 'm1', 'm5']], [S.w3, ['n2']]]) {
    for (const id of ids) w.done(id);
  }
  hub.machine.reply(S.w1.kid, (hub.machine.prompts.filter((p) => p.sid === S.w1.kid)[0]).body.prompt_id, '做完了');
  hub.machine.reply(S.w2.kid, (hub.machine.prompts.filter((p) => p.sid === S.w2.kid)[0]).body.prompt_id, '做完了');
  hub.machine.reply(S.w3.kid, (hub.machine.prompts.filter((p) => p.sid === S.w3.kid)[0]).body.prompt_id, '做完了');
  await b.waitFor(`document.querySelector('.cluster-nav-count')?.hidden === true`, { timeout: 15000, label: 'the sidebar number goes away' });
  assert.equal(await text('.cl-stat[data-stat="subagents-running"] [data-field="num"]'), '0');
  assert.equal(await text('.cl-stat[data-stat="workers-running"] [data-field="num"]'), '0');
  assert.deepEqual(await b.eval(`[...document.querySelectorAll('.cluster-card')].map((c) => c.dataset.status)`), ['done', 'done']);
  const t = totalsOf(await hub.api('GET', '/clusters'));
  assert.deepEqual([t.active, t.subagentsRunning, t.workersRunning], [0, 0, 0]);
  assert.equal(t.subagentsOpened, 9, 'what was opened stays counted');
  assert.match(await text('.cl-stat[data-stat="subagents-running"] [data-field="sub"]'), /共開過 9 個/);
});

test('在對話中查看: from a subagent in the drawer to the worker\'s conversation, with the swarm\'s card there', { skip }, async () => {
  await page.open(`#/cluster/${S.c1.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  const w1 = S.c1.workers[0];
  await page.openDrawer(w1.sessionId);
  await b.click('.cluster-drawer .sa-cell[data-id="m3"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  await b.click('[data-action="view-in-chat"]');
  await b.waitFor(`location.hash === '#/s/${w1.sessionId}'`);
  await b.waitFor(`document.querySelector('.tool.agent, .panel-agents')`, { timeout: 15000, label: 'the conversation shows its swarm card or the subagent panel' });
  // The card of the swarm is in the conversation (one card, six subagents): it is the one the squares point at.
  const card = (await snap(w1.sessionId)).events.find((e) => e.name === 'AgentSwarm');
  assert.ok(card, 'the conversation has the AgentSwarm card');
  const api = await getCluster(S.c1.id);
  assert.ok(api.workers[0].subagents.every((s) => s.eventId === card.id), 'every square points at that one card');
  await shot('e2e-squares-conversation-1280.png');
});
