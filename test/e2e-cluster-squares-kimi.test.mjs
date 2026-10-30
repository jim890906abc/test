// The subagent squares of a cluster worker against the REAL Kimi Code CLI: a real
// Hub, a real bridge, a real Kimi server behind a scripted local model (no
// account, no network) and a real Chromium that only clicks and reads. The model
// answers a worker's task with ONE AgentSwarm call of six items - exactly what a
// worker with Kimi's swarm mode does - and the page has to show six subagents,
// each with the status, model, steps and last action Kimi really reported, while
// the conversation itself holds a single AgentSwarm card.
//
// Skipped (out loud) unless a kimi CLI and a Chromium are available; run inside a
// network namespace so even Kimi's own telemetry cannot leave:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-cluster-squares-kimi.test.mjs'
//
// CLUSTER_UI_SHOTS=<dir> also saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';
import { skipReason, launchBrowser, ROOT } from './browser-harness.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';
import { summarizeCluster } from '../public/js/cluster-model.js';

const { KIMI, SKIP: NO_KIMI } = kimiGate('e2e-cluster-squares-kimi');
const SKIP = NO_KIMI || skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-esq-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 31000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 33000 + Math.floor(Math.random() * 2000);
const TOKEN = 'none';
const procs = [];
let fake;
const seen = [];
let kimiToken;
let machineId;
let b;
let page;

// A scripted model. A worker whose task says SWARM_ONCE asks for one AgentSwarm of six; each subagent
// answers "做完 <item>", the first four at once and the last two after a while (so the page can be
// read while some still work); the main model then says it is done.
function startFakeModel() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      seen.push({ url: req.url, body: j });
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs.filter((m) => m.role === 'user').map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const lastUser = users.at(-1) || '';
      const send = (chunks, delay = 0) => {
        const go = () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        };
        if (delay) setTimeout(go, delay);
        else go();
      };
      const text = (t) => [{ delta: { role: 'assistant', content: t } }, { delta: {}, finish_reason: 'stop' }];
      const call = (pre, name, args) => [
        { delta: { role: 'assistant', content: pre } },
        { delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ];
      // A subagent: it is asked "SUBAGENT_TASK <item>".
      const sub = users.map((u) => /SUBAGENT_TASK (\S+)/.exec(u)?.[1]).filter(Boolean).at(-1);
      if (sub) return send(text(`做完 ${sub}`), ['戊', '己'].includes(sub) ? 6000 : 0);
      if (lastUser.includes('SWARM_ONCE') && last.role !== 'tool') return send(call('開一群子代理。', 'AgentSwarm', { description: '六個一起', prompt_template: 'SUBAGENT_TASK {{item}}', items: ['甲', '乙', '丙', '丁', '戊', '己'] }));
      if (last.role === 'tool') return send(text('六個子代理都回報了。'));
      return send(text(`收到：${lastUser.split('\n')[0].slice(0, 60)}`));
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', r));
}

function run(cmd, args, env, ready) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${cmd} did not become ready:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      if (ready.test(out)) (clearTimeout(t), resolve(p));
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
}
const kimiApi = async (method, p, body) => {
  try {
    kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  } catch {}
  const r = await fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return (await r.json()).data;
};
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.trim() ?? null`);
const shot = async (name) => SHOTS && (await b.sleep(400), b.shot(path.join(SHOTS, name)));

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-squares-test' });
  b = await launchBrowser({ width: 1280, height: 900 });
  page = clusterPage({ b, base: `http://127.0.0.1:${HUB_PORT}/`, cluster: (cid) => api('GET', `/clusters/${cid}`) });
});

after(async () => {
  await b?.close();
  const pids = [];
  try {
    for (const f of fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances'))) {
      try {
        pids.push(JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8')).pid);
      } catch {}
    }
  } catch {}
  for (const p of procs) p.kill('SIGTERM');
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && (procs.some((p) => p.exitCode === null && p.signalCode === null) || pids.some(alive)); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) {
    try {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.close();
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
});

const S = {};

test('real Kimi: a worker\'s AgentSwarm of six is six squares while it runs, with what Kimi reported for each, and they are the same numbers in the tile, the band, the list and the sidebar', { skip: SKIP }, async () => {
  S.parent = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 先說一句', permission: 'auto', subagent: null });
  await until(async () => (await api('GET', `/sessions/${S.parent.id}`)).status === 'idle', 30000, 'parent idle');
  const { cluster: c } = await api('POST', `/sessions/${S.parent.id}/cluster`, { tasks: [{ title: '派六個', prompt: '請開子代理群 SWARM_ONCE' }], isolate: false, swarm: true });
  S.c = c;
  const w = c.workers[0];
  assert.equal((await kimiApi('GET', `/sessions/${(await api('GET', `/sessions/${w.sessionId}`)).kimiSessionId}/status`)).swarm_mode, true, 'the worker has Kimi\'s swarm mode on');
  await page.open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 1`);

  // Six subagents appear, from Kimi's own frames: not one swarm card.
  await b.waitFor(`document.querySelector('[data-stat="subagents"] [data-field="sub"]')?.innerText.includes('共開過 6 個')`, { timeout: 40000, label: 'six subagents are opened' });
  // The last two answer only after six seconds: until then, the page says four are done and two work.
  await b.waitFor(`document.querySelector('.cluster-worker [data-field="subcount"]')?.innerText.trim() === '子代理 2/6'`, { timeout: 30000, label: 'four done, two working' });
  assert.equal(await text('[data-stat="subagents"] [data-field="num"]'), '2');
  const mid = await api('GET', `/clusters/${c.id}`);
  const subs = mid.workers[0].subagents;
  assert.equal(subs.length, 6);
  // (Which of them are the two that still work is Kimi's to say: it numbers the members as it starts them, not as the items were listed.)
  assert.deepEqual(subs.map((s) => s.status).sort(), ['done', 'done', 'done', 'done', 'running', 'running']);
  const finished = subs.filter((s) => s.status === 'done');
  const working = subs.filter((s) => s.status === 'running');
  assert.deepEqual(subs.map((s) => s.title.replace(/ \(coder\)$/, '')).sort(), ['六個一起 #1', '六個一起 #2', '六個一起 #3', '六個一起 #4', '六個一起 #5', '六個一起 #6'], 'Kimi\'s own description of each member');
  for (const s of subs) {
    assert.ok(s.model, `Kimi reported a model for ${s.id}`);
    assert.ok(s.startedAt > c.createdAt, `${s.id} was seen to start after the cluster was made`);
  }
  assert.ok(finished.every((s) => s.finishedAt >= s.startedAt), 'the ones that ended have their end');
  assert.ok(working.every((s) => s.finishedAt === null));
  assert.deepEqual(finished.map((s) => s.lastAction).sort(), ['做完 乙', '做完 丁', '做完 丙', '做完 甲'].sort(), 'the last thing each said');

  // The drawer: six squares, in order, with the detail of one.
  await page.openDrawer(w.sessionId);
  assert.deepEqual((await b.eval(`[...document.querySelectorAll('.cluster-drawer .sa-cell')].map((c) => [c.dataset.status, c.innerText.trim()])`)).map((x) => x.join('|')).sort(), ['done|✓', 'done|✓', 'done|✓', 'done|✓', 'running|', 'running|']);
  assert.equal(await text('.cluster-drawer [data-field="subagent-line"]'), '子代理 6：2 執行中・4 完成');
  await b.click('.cluster-drawer .sa-cell[data-id="' + working[0].id + '"]');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  assert.match(await text('.sa-detail [data-field="title"]'), /六個一起 #\d/);
  assert.equal(await text('.sa-detail [data-field="state"]'), '執行中');
  assert.match(await text('.sa-detail [data-field="span"]'), /^已跑 /);
  await shot('ek1-squares-real-kimi-drawer-1280.png');
  await page.closeDrawer();

  // The list and the sidebar say the same, from the same summaries.
  const rows = await api('GET', '/clusters');
  assert.deepEqual(rows.find((r) => r.id === c.id).subagents, summarizeCluster(mid).subagents);
  await page.open('#/clusters');
  await b.waitFor(`document.querySelector('.cluster-card')`);
  assert.equal(await text('.cluster-card [data-field="subagents"]'), '子代理 2/6');
  assert.equal(await text('.cluster-nav-count'), '2');
  await shot('ek2-list-real-kimi-1280.png');
});

test('real Kimi: when the last two finish the squares are all done, the numbers go to zero by themselves, and the conversation holds ONE AgentSwarm card that every square points at', { skip: SKIP }, async () => {
  await page.open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('.cluster-worker [data-field="subcount"]')`);
  await until(async () => {
    const x = await api('GET', `/clusters/${S.c.id}`);
    return x.status === 'done' && x.workers[0].subagentCounts.done === 6 && x;
  }, 40000, 'the swarm is over');
  await b.waitFor(`document.querySelector('[data-stat="subagents"] [data-field="num"]')?.innerText.trim() === '0'`, { timeout: 10000 });
  assert.match(await text('[data-stat="subagents"] [data-field="sub"]'), /共開過 6 個/);
  const done = await api('GET', `/clusters/${S.c.id}`);
  assert.ok(done.workers[0].subagents.every((s) => s.status === 'done' && s.finishedAt));
  const conv = await api('GET', `/sessions/${S.c.workers[0].sessionId}`);
  const cards = conv.events.filter((e) => e.type === 'tool_use' && e.name === 'AgentSwarm');
  assert.equal(cards.length, 1, 'the conversation holds one card for the whole swarm');
  assert.ok(done.workers[0].subagents.every((s) => s.eventId === cards[0].id), 'and every square points at it');
  assert.equal(cards[0].subagent.id, done.workers[0].subagents.at(-1).id, 'the card itself only knows the last member');
  await b.waitFor(`document.querySelector('.cluster-nav-count')?.hidden === true`, { timeout: 10000, label: 'the sidebar number goes away with the last working subagent' });
  await page.openDrawer(S.c.workers[0].sessionId);
  await b.click('.cluster-drawer .sa-cell:first-child');
  await b.waitFor(`!document.querySelector('.sa-detail').hidden`);
  await b.click('[data-action="view-in-chat"]');
  await b.waitFor(`location.hash === '#/s/${S.c.workers[0].sessionId}'`);
  await b.waitFor(`document.querySelector('.tool.agent')`, { timeout: 15000, label: 'the conversation shows the swarm card' });
  await shot('ek3-conversation-real-kimi-1280.png');
});
