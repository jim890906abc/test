// 叢集 (cluster) from the screen with the REAL Kimi Code CLI behind it: a real
// Hub, a real bridge (its own sh.run for git and the memory file), a real
// Kimi server talking to a local scripted model (no account, no network), and
// a real Chromium. Nothing the page asks for is intercepted. What the fake
// machine of e2e-cluster-ui.test.mjs can only imitate is settled here:
//   - the swarm chip is what Kimi's own status says;
//   - a worker's progress line is what the model really answered;
//   - the time bars are Kimi's own journal timing, laid out exactly as the
//     Hub's timing API says (and 量不到 with the Hub's reason where it has none);
//   - what a person types in a worker's conversation reaches the model with the
//     memory in front of it;
//   - 全部停止 really cuts a turn that Kimi is in the middle of (a model that
//     never answers), and the page does not call that worker finished;
//   - the merge, from the page, of what the workers really committed.
//
// Skipped (out loud) unless a kimi CLI and a Chromium are available:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-cluster-ui-kimi.test.mjs'
//
// CLUSTER_UI_SHOTS=<dir> also saves screenshots of the real flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';
import { skipReason, launchBrowser } from './browser-harness.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';
import { fmtMs } from '../public/js/cluster-model.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP: NO_KIMI } = kimiGate('e2e-cluster-ui-kimi');
const NO_BROWSER = skipReason();
const SKIP = NO_KIMI || NO_BROWSER;
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ecui-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 26000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 28000 + Math.floor(Math.random() * 2000);
const TOKEN = 'none'; // no token: the page and the tests talk to the Hub the way the other browser tests do
const procs = [];
let fake;
const seen = []; // every chat request the scripted model got
const hung = new Set(); // requests the model is holding open on purpose
let kimiToken;
let machineId;
let b;

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

// A model that answers at once with "收到：<the user's first line>", except for
// a message that says HANG_FOREVER: that one it never answers (until the client
// goes away), as a model stuck on a long job.
function startFakeModel() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/opencode-go/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      const j = JSON.parse(body || '{}');
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      seen.push({ url: req.url, body: j });
      const users = (j.messages || []).filter((m) => m.role === 'user').map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const lastUser = users.at(-1) || '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (lastUser.includes('HANG_FOREVER')) {
        hung.add(res);
        res.write(': waiting\n\n');
        // (A request's own 'close' means "fully read", not "the client left": only the response tells that.)
        res.on('close', () => hung.delete(res));
        return;
      }
      const text = `收到：${lastUser.split('\n')[0].slice(0, 60)}`;
      // A little time per answer, so the time bars have something to measure.
      setTimeout(() => {
        for (const c of [{ delta: { role: 'assistant', content: text } }, { delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, 300);
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
const session = (sid) => api('GET', `/sessions/${sid}`);
const idle = (sid) => until(async () => (await session(sid)).status === 'idle' && session(sid), 30000, `${sid} idle`);
const getCluster = (cid) => api('GET', `/clusters/${cid}`);
const sentSince = (n) => seen.slice(n).map((x) => JSON.stringify(x.body.messages));
const shot = async (name) => {
  if (!SHOTS) return;
  await b.sleep(450);
  await b.shot(path.join(SHOTS, name));
};

// ------------------------------------------------------------ driving the page

let page; // the driver of the screens (test/fixtures/cluster-page.mjs), made once the browser is up
const open = (hash) => page.open(hash);
const press = (key) => page.press(key);
const typeInto = (selector, text) => page.typeInto(selector, text);
const confirm = () => page.confirm();
const cards = () => page.cards();
const dispatchFromScreen = (parent, tasks, opts) => page.dispatch(parent, tasks, opts);

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  git(PROJECT, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(PROJECT, 'a.txt'), 'one\ntwo\n');
  git(PROJECT, 'add', '-A');
  git(PROJECT, 'commit', '-q', '-m', 'first');
  await startFakeModel();
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, ...GIT_ENV, AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}` }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 10000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: 'sk-cluster-test' });
  b = await launchBrowser({ width: 1280, height: 900 });
  page = clusterPage({ b, base: `http://127.0.0.1:${HUB_PORT}/`, cluster: getCluster });
});

after(async () => {
  await b?.close();
  for (const res of hung) {
    try {
      res.destroy();
    } catch {}
  }
  // End everything this file started and wait until it is really gone (the leak net of the browser
  // harness names whatever outlives the file): the Hub, the bridge, `kimi web` and the Kimi server it started.
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

test('real Kimi: dispatch from the screen, the page shows what Kimi really has (swarm mode, folder, the model\'s own answer as the progress line)', { skip: SKIP }, async () => {
  S.parent = await api('POST', '/sessions', { provider: 'kimi', machineId, cwd: PROJECT, prompt: '聊天 主對話先說一句背景', permission: 'auto', subagent: null });
  await idle(S.parent.id);
  const n0 = seen.length;
  S.c = await dispatchFromScreen(S.parent, [{ title: '改甲', prompt: '請改甲 TASK_ALPHA' }, { title: '改乙', prompt: '請改乙 TASK_BETA' }], { note: '大家都用 NOTE_E2E 這個慣例' });
  const real = fs.realpathSync(PROJECT);
  const shown = await cards();
  assert.equal(shown.length, 2);
  for (const [i, w] of S.c.workers.entries()) {
    const s = await session(w.sessionId);
    const native = await kimiApi('GET', `/sessions/${s.kimiSessionId}`);
    assert.equal(shown[i].session, w.sessionId);
    assert.equal(shown[i].title, ['改甲', '改乙'][i]);
    assert.equal(native.title, shown[i].title, 'Kimi\'s own title is the card\'s');
    assert.equal(shown[i].worktree, `${path.dirname(real)}/${path.basename(real)}-cluster-${S.c.id}/w${i + 1}`);
    assert.equal(fs.realpathSync(native.metadata.cwd), fs.realpathSync(shown[i].worktree), 'Kimi runs the worker in the folder the card shows');
    assert.equal((await kimiApi('GET', `/sessions/${s.kimiSessionId}/status`)).swarm_mode, true, 'Kimi says swarm mode is on');
    assert.equal(shown[i].swarm, '原生 Swarm 開');
  }
  // The real model answered each brief; its first line is the progress line.
  await until(async () => (await Promise.all(S.c.workers.map((w) => session(w.sessionId)))).every((s) => s.status === 'idle' && s.events.some((e) => e.type === 'turn_end')), 40000, 'both workers answered');
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`, { timeout: 15000, label: 'the page reads 已完成 over the socket' });
  const after = await cards();
  assert.deepEqual(after.map((c) => c.state), ['已完成', '已完成']);
  const api2 = await getCluster(S.c.id);
  for (const [i, w] of api2.workers.entries()) {
    assert.match(w.progress, /^收到：/, 'what the model really said');
    assert.equal(after[i].progress, w.progress);
  }
  // The brief the model got first has the task and the note.
  const asked = sentSince(n0);
  for (const [i, w] of S.c.workers.entries()) {
    const mine = asked.filter((m) => m.includes(`你是叢集 ${S.c.id} 的工作者 w${i + 1}`));
    assert.ok(mine.length >= 1 && mine[0].includes(['TASK_ALPHA', 'TASK_BETA'][i]) && mine[0].includes('NOTE_E2E') && mine[0].includes(w.worktree));
  }
  await shot('k1-cluster-real-kimi-1280-light.png');
});

test('real Kimi: the time bars are what the Hub\'s timing API says about each worker - Kimi\'s own numbers drawn as they are, 量不到 with the Hub\'s reason for the rest', { skip: SKIP }, async () => {
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`, { timeout: 15000 });
  for (const w of S.c.workers) {
    const t = await api('GET', `/sessions/${w.sessionId}/timing`);
    // The time breakdown is in the worker's drawer.
    await page.openDrawer(w.sessionId);
    await b.waitFor(`!document.querySelector('.cluster-drawer [data-sec="time"] .cluster-timing-loading')`, { timeout: 15000 });
    const dom = await b.eval(`(() => {
      const c = document.querySelector('.cluster-drawer');
      const part = (k) => c.querySelector('.cluster-legend [data-part="' + k + '"] .cluster-legend-value')?.innerText.trim() ?? null;
      return { total: c.querySelector('.cluster-timing-total')?.innerText.trim() ?? null, failed: c.querySelector('.cluster-timing-failed')?.innerText.trim() ?? null, parts: { wallMs: null, modelMs: part('modelMs'), toolMs: part('toolMs'), rateLimitWaitMs: part('rateLimitWaitMs'), compactMs: part('compactMs') }, reasons: [...c.querySelectorAll('.cluster-reason')].map((p) => p.innerText.trim()), segs: [...c.querySelectorAll('.cluster-bar [data-seg]')].map((s) => s.dataset.seg) };
    })()`);
    assert.equal(dom.failed, null, 'the timing was read');
    assert.ok(t.turns >= 1, `Kimi's journal has the turn: ${JSON.stringify(t)}`);
    // The total is Kimi's own length of the turn; here the model took >= 300 ms and the whole turn is a few seconds.
    assert.ok(t.wallMs > 250 && t.wallMs < 60_000, `a believable turn length: ${t.wallMs}`);
    assert.equal(dom.total, `總時間 ${fmtMs(t.wallMs)}`);
    for (const k of ['modelMs', 'toolMs', 'rateLimitWaitMs', 'compactMs']) {
      if (t[k] === null) {
        assert.equal(dom.parts[k], '量不到', `${k} was not measured`);
        const why = t.unmeasured.find((u) => u.startsWith(`${k}：`));
        assert.ok(why, `the Hub gives a reason for ${k}`);
        assert.ok(dom.reasons.some((r) => r.endsWith(why.slice(k.length + 1))), `the page repeats it: ${JSON.stringify(dom.reasons)}`);
      } else {
        assert.equal(dom.parts[k], fmtMs(t[k]), `${k} is what the Hub measured`);
        if (t[k] > 0) assert.ok(dom.segs.includes(k), `${k} is drawn in the bar`);
      }
    }
    // The model's own time, when Kimi gave it, is at most the turn.
    if (t.modelMs !== null) assert.ok(t.modelMs <= t.wallMs + 50, `model ${t.modelMs} within the turn ${t.wallMs}`);
    for (const k of ['modelMs', 'toolMs', 'rateLimitWaitMs', 'compactMs']) if (t[k] !== null && !dom.segs.includes(k) && t[k] > 0) assert.fail(`${k} missing from the bar`);
    await shot('k2-time-bars-real-kimi-1280-light.png');
    await page.closeDrawer();
  }
});

test('real Kimi: a decision typed on the page reaches the model of the worker in front of what a person types in that worker\'s conversation, once; the files are committed and merged from the page', { skip: SKIP }, async () => {
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('改甲')`);
  await typeInto('textarea[name="decision"]', '決定：DECISION_E2E 全部用 tabs');
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('DECISION_E2E')`);
  const mem = await api('GET', `/clusters/${S.c.id}/memory`);
  assert.equal(fs.readFileSync(S.c.memory.path, 'utf8'), mem.text);

  const w1 = S.c.workers[0];
  await open(`#/s/${w1.sessionId}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  const n1 = seen.length;
  await typeInto('.composer-input', '下一句話 NEXT_ONE');
  await press('Enter');
  await until(async () => (await session(w1.sessionId)).events.filter((e) => e.type === 'turn_end').length >= 2, 30000, 'the second turn');
  const told = sentSince(n1).filter((m) => m.includes('DECISION_E2E'));
  assert.ok(told.length >= 1, 'the model was sent the decision');
  assert.match(told[0], /system-reminder/);
  assert.ok(told[0].includes('NEXT_ONE'), 'together with what the person typed');
  await typeInto('.composer-input', '再一句話 NEXT_TWO');
  await press('Enter');
  await until(async () => (await session(w1.sessionId)).events.filter((e) => e.type === 'turn_end').length >= 3, 30000, 'the third turn');
  const last = JSON.stringify(seen.at(-1).body.messages);
  assert.equal(last.split('DECISION_E2E').length - 1, 1, 'told once: one copy in Kimi\'s own history, not two');

  // The workers' work: really committed, merged from the page.
  const [a, c2] = S.c.workers;
  fs.writeFileSync(path.join(a.worktree, 'alpha.txt'), 'alpha\n');
  git(a.worktree, 'add', '-A');
  git(a.worktree, 'commit', '-q', '-m', 'alpha');
  fs.writeFileSync(path.join(c2.worktree, 'beta.txt'), 'beta\n');
  git(c2.worktree, 'add', '-A');
  git(c2.worktree, 'commit', '-q', '-m', 'beta');
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('[data-action="merge"]') && !document.querySelector('[data-action="merge"]').disabled`);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 20000 });
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-merge-list > li[data-ok="true"]').length`), 2);
  const merged = `cluster/${S.c.id}/merged`;
  assert.equal(git(PROJECT, 'show', `${merged}:alpha.txt`), 'alpha');
  assert.equal(git(PROJECT, 'show', `${merged}:beta.txt`), 'beta');
  assert.equal(git(PROJECT, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(PROJECT, 'status', '--porcelain'), '');
  await shot('k3-merge-real-kimi-1280-light.png');
});

test('real Kimi: 全部停止 cuts a turn Kimi is really in the middle of; the page reads 已停止, the cut-off worker is not counted as done, the one that had finished is', { skip: SKIP }, async () => {
  const c = await dispatchFromScreen(S.parent, [{ title: '一下就好', prompt: '很快就好的一件事' }, { title: '卡住的', prompt: 'HANG_FOREVER 這個任務模型永遠不回答' }]);
  const [quick, stuck] = c.workers;
  await until(async () => (await session(quick.sessionId)).status === 'idle' && (await session(quick.sessionId)).events.some((e) => e.type === 'turn_end'), 30000, 'the quick one done');
  await until(async () => (await session(stuck.sessionId)).status === 'running' && hung.size >= 1, 30000, 'the other one in the middle of its turn, the model not answering');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${quick.sessionId}"] .cluster-worker-state').innerText.trim() === '已完成' && document.querySelector('.cluster-worker[data-session="${stuck.sessionId}"] .cluster-worker-state').innerText.trim() === '執行中'`, { timeout: 15000 });
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 1/2 完成');
  await shot('k4-one-stuck-real-kimi-1280-light.png');

  await b.click('[data-action="stop"]');
  await confirm();
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已停止'`, { timeout: 30000, label: 'Kimi ended the turn and the page reads 已停止' });
  const states = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-worker')].map((x) => [x.dataset.session, x.querySelector('.cluster-worker-state').innerText.trim()]))`);
  assert.equal(states[quick.sessionId], '已完成');
  assert.notEqual(states[stuck.sessionId], '已完成', 'a worker that was cut off did not finish');
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 1/2 完成');
  const api2 = await getCluster(c.id);
  assert.equal(api2.status, 'stopped');
  assert.equal(api2.workers.find((w) => w.sessionId === stuck.sessionId).finishedAt, null);
  assert.equal((await session(stuck.sessionId)).status, 'idle');
  // Nothing was deleted.
  for (const w of c.workers) assert.ok(fs.existsSync(w.worktree));
  await shot('k5-stopped-real-kimi-1280-light.png');
  // It can be sent on: the cluster runs again and ends done.
  await api('POST', `/sessions/${stuck.sessionId}/messages`, { text: '改做別的事，很快就好' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`, { timeout: 40000, label: 'done once the stopped worker has been through a turn' });
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 2/2 完成');
});
