// 叢集 (cluster) from the screen to the disk, with NOTHING between them faked:
// a real Hub (runner, kimi-remote adapter, cluster.js, timing.js) serving the
// real page, a real Chromium driven only by clicks and keys, a computer whose
// shell really runs bash (so the git worktrees, branches, commits and merges
// below are real git in real folders) and a Kimi that is played by the fake
// machine. The page's own requests are NOT intercepted or answered: whatever
// the cluster page shows is what the Hub said, and whatever a button sends is
// what the Hub got. The unit-level screen tests (ui-cluster) answer the page
// from a script and the back end tests (cluster) have no screen; this file is
// the one that joins them.
//
// Skips, saying why, when there is no Chromium. CLUSTER_UI_SHOTS=<dir> also
// saves screenshots of the real flow to that folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { skipReason, launchBrowser, CONTRAST_JS, ROOT } from './browser-harness.mjs';
import { startRealHub, until, wait } from './fixtures/real-hub.mjs';
import { startFakeMachine } from './fixtures/fake-machine.mjs';
import { clusterPage } from './fixtures/cluster-page.mjs';

const skip = skipReason();
const SHOTS = process.env.CLUSTER_UI_SHOTS || '';
const MID = 'm_fake';
const T = 1_790_000_000_000; // a moment, in Kimi's epoch milliseconds
let hub;
let b;
let KIMI;
let DEEPSEEK;
let CLAUDE;
let N = 0;

// A git that knows nobody: no identity, no global config.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function makeRepo(name) {
  const dir = path.join(hub.TMP, `${name}-${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const snap = (id) => hub.api('GET', `/sessions/${id}`);
const newKimi = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'kimi', machineId: MID, cwd, model: KIMI.model, effort: KIMI.effort, permission: 'auto', ...extra });
const newDeepseek = (cwd, extra = {}) => hub.api('POST', '/sessions', { provider: 'deepseek', machineId: MID, cwd, model: DEEPSEEK.model, effort: 'max', permission: 'auto', ...extra });
const getCluster = (cid) => hub.api('GET', `/clusters/${cid}`);
const clustersOf = (sid) => hub.api('GET', `/sessions/${sid}/clusters`);
const prompts = (kid) => hub.machine.prompts.filter((p) => p.sid === kid);
const reminders = (prompt) => prompt.body.content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text);
const kidOf = async (sid) => (await snap(sid)).kimiSessionId;
const idle = (sid) => until(async () => (await snap(sid)).status === 'idle' && snap(sid), 15000, `${sid} idle`);
const shot = async (name) => {
  if (!SHOTS) return;
  await b.sleep(450); // the dialog's own fade-in and the page's transitions are over
  await b.shot(path.join(SHOTS, name));
};

// ------------------------------------------------------------ driving the page

let page; // the driver of the screens (test/fixtures/cluster-page.mjs), made once the browser is up
const open = (hash) => page.open(hash);
const press = (key) => page.press(key);
const typeInto = (selector, text) => page.typeInto(selector, text);
const fillTask = (i, title, prompt) => page.fillTask(i, title, prompt);
const cards = () => page.cards();
const confirm = () => page.confirm();
const submitDialog = () => page.submitDialog();
const openDialogFromComposer = (id) => page.openDialog(id);
// Dispatch a cluster of `titles` from `parent` through the screen; returns the cluster as the Hub has it.
const dispatchFromScreen = (parent, titles, opts) => page.dispatch(parent, titles.map((t, i) => ({ title: t, prompt: `請處理：${t}（第 ${i + 1} 項）` })), opts);

before(async () => {
  if (skip) return;
  hub = await startRealHub('cluster-ui', { claude: true });
  await hub.setDeepseekKey();
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  const { groups } = await hub.api('GET', `/models?machine=${MID}`);
  const pick = (p) => groups.find((g) => g.provider === p).models[0];
  KIMI = { model: pick('kimi').id, effort: pick('kimi').efforts[0] };
  DEEPSEEK = { model: groups.find((g) => g.provider === 'deepseek').models.find((m) => /flash/.test(m.id)).id };
  CLAUDE = { model: pick('claude').id, effort: pick('claude').efforts?.[0] };
  b = await launchBrowser({ width: 1280, height: 900 });
  page = clusterPage({ b, base: `http://127.0.0.1:${hub.PORT}/`, cluster: getCluster });
});
after(async () => {
  await b?.close();
  await hub?.stop();
});

// The state the tests below hand to each other: one repo, one main conversation, the clusters made so far.
const S = {};

// ----------------------------------------------------------------- dispatch

test('/cluster in a Kimi conversation: the dialog, two tasks, a wait while the workers are opened, then the cluster page of what the Hub really made', { skip }, async () => {
  S.repo = makeRepo('proj');
  S.parent = await newKimi(S.repo, { prompt: '聊天 先說一句背景 BACKGROUND_LINE' });
  await idle(S.parent.id);
  hub.machine.autoReply = false; // the workers stay at work until the test says their turn is over

  // A slow computer: the git worktrees take a moment, as they do for a big project.
  hub.machine.shHook = async (a) => {
    if (/worktree add/.test(a.command)) await wait(700);
  };
  await openDialogFromComposer(S.parent.id);
  await shot('01-dialog-empty-1280-light.png');
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-task').length`), 1);
  await b.click('[data-action="add-task"]');
  await fillTask(0, '改登入頁', '把登入頁的錯誤訊息改好 TASK_ALPHA');
  await fillTask(1, '', '掃描所有路由，列出沒有權限檢查的 TASK_BETA');
  await typeInto('textarea[name="note"]', '大家都用 NOTE_E2E 這個慣例');
  await shot('02-dialog-filled-1280-light.png');
  const before = await clustersOf(S.parent.id);
  assert.deepEqual(before, []);

  await submitDialog();
  // The wait is real: the Hub answers when every worker is open and has its brief.
  await b.waitFor(`document.querySelector('.cluster-sending') && !document.querySelector('.cluster-sending').hidden`);
  assert.equal(await b.eval(`document.querySelector('.cluster-dialog button[type="submit"]').innerText.trim()`), '派工中…');
  await b.eval(`(() => { const d = document.querySelector('.dialog'); if (d) d.scrollTop = d.scrollHeight; })()`);
  await shot('03-dialog-waiting-1280-light.png');
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 20000 });
  hub.machine.shHook = null;
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false, 'the dialog closed');

  const list = await clustersOf(S.parent.id);
  assert.equal(list.length, 1, 'the Hub made one cluster');
  S.c = list[0];
  assert.equal(await b.eval('location.hash'), `#/cluster/${S.c.id}`);
  assert.equal(S.c.workers.length, 2);
  assert.deepEqual(S.c.warnings, []);
  assert.equal(S.c.mode, 'brief');
  assert.equal(S.c.isolate, true);
  assert.equal(S.c.swarm, true);
});

test('the cluster page shows the workers the Hub really made: title, task, branch, worktree, Kimi\'s own swarm mode, state', { skip }, async () => {
  const c = await getCluster(S.c.id);
  S.c = c;
  const real = fs.realpathSync(S.repo);
  const shown = await cards();
  assert.equal(shown.length, 2);
  for (const [i, w] of c.workers.entries()) {
    const card = shown[i];
    const s = await snap(w.sessionId);
    assert.equal(card.session, w.sessionId);
    // A task left without a name is named after its first line.
    assert.equal(card.title, ['改登入頁', '掃描所有路由，列出沒有權限檢查的 TASK_BETA'][i]);
    assert.equal(card.title, w.title, 'the card has the name of the worker\'s conversation');
    assert.equal(s.title, w.title);
    assert.ok(card.task.includes(['TASK_ALPHA', 'TASK_BETA'][i]));
    assert.equal(card.branch, `cluster/${c.id}/w${i + 1}`);
    assert.equal(card.worktree, `${path.dirname(real)}/${path.basename(real)}-cluster-${c.id}/w${i + 1}`);
    assert.equal(card.branch, w.branch);
    assert.equal(card.worktree, w.worktree);
    // ...and these are real: a checkout on disk, on that branch, and a Kimi conversation running in it.
    assert.ok(fs.existsSync(path.join(card.worktree, 'a.txt')));
    assert.equal(git(card.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), card.branch);
    assert.equal(fs.realpathSync(hub.machine.sessions.get(s.kimiSessionId).cwd), fs.realpathSync(card.worktree));
    assert.equal(s.clusterId, c.id);
    assert.equal(s.clusterRole, 'worker');
    assert.equal(card.swarm, '原生 Swarm 開');
    assert.equal(hub.machine.sessions.get(s.kimiSessionId).swarm, true, 'and the computer\'s Kimi says swarm mode is on');
    assert.equal(card.state, '執行中');
    assert.equal(card.open, `#/s/${w.sessionId}`);
  }
  const head = await b.eval(`({ status: document.querySelector('[data-field="status"]').innerText.trim(), text: document.querySelector('.cluster-head').innerText, parent: document.querySelector('[data-action="open-parent"]')?.getAttribute('href') })`);
  assert.equal(head.status, '進行中');
  assert.match(head.text, /0\/2 完成/);
  assert.match(head.text, /簡報起跑/);
  assert.match(head.text, /每個工作者獨立 worktree/);
  assert.match(head.text, /原生 Swarm 開/);
  assert.equal(head.parent, `#/s/${S.parent.id}`);
  // The first thing each worker's Kimi was sent is its brief.
  for (const [i, w] of c.workers.entries()) {
    const first = prompts(await kidOf(w.sessionId))[0];
    const text = first.body.content.map((x) => x.text).join('\n');
    assert.ok(text.includes(`你是叢集 ${c.id} 的工作者 w${i + 1}`) && text.includes(['TASK_ALPHA', 'TASK_BETA'][i]) && text.includes('NOTE_E2E') && text.includes('BACKGROUND_LINE'));
  }
  await shot('04-cluster-page-running-1280-light.png');
});

test('the main conversation carries the banner; the workers carry the 叢集 tag in the sidebar and a note of where they belong', { skip }, async () => {
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  const banner = await b.eval(`({ text: document.querySelector('.cluster-banner').innerText.trim(), href: document.querySelector('.cluster-banner a').getAttribute('href') })`);
  assert.match(banner.text, /叢集進行中 0\/2 完成/);
  assert.equal(banner.href, `#/cluster/${S.c.id}`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-worker-note'))`), false, 'the main conversation is not a worker');
  await shot('05-main-conversation-banner-1280-light.png');
  await b.click('.cluster-banner a');
  await b.waitFor(`location.hash === '#/cluster/${S.c.id}'`);

  // The sidebar: both workers carry the tag; the main conversation does not.
  const rows = await b.eval(`[...document.querySelectorAll('.sidebar .side-row')].map((r) => ({ title: r.querySelector('.row-title')?.innerText.trim(), tag: r.querySelector('.row-tag.cluster')?.innerText.trim() ?? null }))`);
  for (const w of S.c.workers) {
    const row = rows.find((r) => r.title === w.title);
    assert.ok(row, `${w.title} is in the sidebar: ${JSON.stringify(rows)}`);
    assert.equal(row.tag, '叢集');
  }
  assert.equal(rows.find((r) => r.title === S.parent.title)?.tag ?? null, null);

  // A worker's own conversation says where it belongs and links back.
  await open(`#/s/${S.c.workers[0].sessionId}`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  const note = await b.eval(`({ text: document.querySelector('.cluster-worker-note').innerText, links: [...document.querySelectorAll('.cluster-worker-note a')].map((a) => a.getAttribute('href')) })`);
  assert.match(note.text, /叢集的工作者/);
  assert.equal(note.links[0], `#/cluster/${S.c.id}`);
});

test('a worker\'s conversation opened straight (after a reload, a bookmark) still links back to the main conversation', { skip }, async () => {
  // The page has not been told about any cluster: all it has is the worker's own summary (clusterId).
  await open(`#/s/${S.c.workers[1].sessionId}`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker-note a').length === 2`, { label: 'both links: the cluster and the main conversation' });
  const links = await b.eval(`[...document.querySelectorAll('.cluster-worker-note a')].map((a) => a.getAttribute('href'))`);
  assert.deepEqual(links, [`#/cluster/${S.c.id}`, `#/s/${S.parent.id}`]);
});

// ------------------------------------------------- the workers work, the page follows

// What Kimi writes for one finished turn, with its own times on it (as the
// journal has them): 10 s long, two model steps (1.0 s and 0.5 s), two
// overlapping tool calls (2.0 s together), a 1 s compaction, two subagents put
// back in the rate-limit queue (4 s together).
const RL = 'Provider rate limit; subagent requeued for retry.';
function timedTurn(kid, promptId, text, answer, turn = 't1') {
  const f = (type, time, payload) => hub.machine.frameAt(kid, type, time, payload);
  f('turn.started', T, { turnId: turn, promptId, origin: { kind: 'user' }, prompt: text });
  f('assistant.delta', T + 500, { turnId: turn, delta: answer });
  f('turn.step.completed', T + 1000, { turnId: turn, step: 1, stepId: `s1-${turn}`, llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 700 });
  f('tool.call.started', T + 1100, { turnId: turn, toolCallId: `c1-${turn}`, name: 'Bash' });
  f('tool.call.started', T + 1200, { turnId: turn, toolCallId: `c2-${turn}`, name: 'Bash' });
  f('tool.result', T + 2200, { turnId: turn, toolCallId: `c2-${turn}`, output: 'x' });
  f('tool.result', T + 3100, { turnId: turn, toolCallId: `c1-${turn}`, output: 'x' });
  f('turn.step.completed', T + 3600, { turnId: turn, step: 2, stepId: `s2-${turn}`, llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 });
  f('compaction.started', T + 3700, { trigger: 'auto' });
  f('compaction.completed', T + 4700, { result: { tokensBefore: 9, tokensAfter: 3 } });
  f('subagent.spawned', T + 4800, { subagentId: 'a1', subagentName: 'coder' });
  f('subagent.spawned', T + 4850, { subagentId: 'a2', subagentName: 'coder' });
  f('subagent.suspended', T + 5000, { subagentId: 'a1', reason: RL });
  f('subagent.suspended', T + 6000, { subagentId: 'a2', reason: RL });
  f('subagent.started', T + 7000, { subagentId: 'a2' });
  f('subagent.started', T + 9000, { subagentId: 'a1' });
  f('turn.ended', T + 10000, { turnId: turn, reason: 'completed', durationMs: 10000 });
  hub.machine.frame(kid, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
}

test('a worker finishing its turn reaches the open page by itself (socket, no reload): its card, the progress line, the header', { skip }, async () => {
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  const [w1, w2] = S.c.workers;
  S.k = [await kidOf(w1.sessionId), await kidOf(w2.sessionId)];
  const first = (kid) => prompts(kid)[0];
  const textOf = (p) => p.body.content.map((x) => x.text).join('\n');
  assert.equal((await cards()).map((c) => c.state).join(), '執行中,執行中');

  timedTurn(S.k[0], first(S.k[0]).body.prompt_id, textOf(first(S.k[0])), '改好了登入頁：W1_DONE_LINE\n其餘細節在後面');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${w1.sessionId}"] .cluster-worker-state')?.innerText.trim() === '已完成'`, { label: 'w1 reads 已完成 without a reload' });
  assert.equal((await cards())[1].state, '執行中', 'the other one is still at work');
  let head = await b.eval(`({ status: document.querySelector('[data-field="status"]').innerText.trim(), text: document.querySelector('.cluster-progress').innerText.trim() })`);
  assert.deepEqual(head, { status: '進行中', text: '任務 1/2 完成' });
  // Its progress line is the Hub's own one-line reading of its last words.
  const api1 = (await getCluster(S.c.id)).workers[0];
  assert.match(api1.progress, /W1_DONE_LINE/);
  assert.equal((await cards())[0].progress, api1.progress);

  const f2 = first(S.k[1]);
  hub.machine.reply(S.k[1], f2.body.prompt_id, '乙的簡報');
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`, { label: 'the cluster reads 已完成' });
  head = await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`);
  assert.equal(head, '任務 2/2 完成');
  assert.equal((await cards()).map((c) => c.state).join(), '已完成,已完成');
  assert.equal((await getCluster(S.c.id)).status, 'done', 'and that is what the Hub says');
  // The stop button has nothing to stop any more.
  assert.equal(await b.eval(`document.querySelector('[data-action="stop"]').disabled`), true);
  assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), false);
  // The banner on the main conversation goes away with it.
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.sleep(600);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-banner'))`), false, 'no banner for a cluster that is over');
});

test('the time breakdown is the Hub\'s own measure for each worker: what Kimi timed is drawn, what nobody timed says 量不到 and why', { skip }, async () => {
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  const [w1, w2] = S.c.workers;
  const t1 = await hub.api('GET', `/sessions/${w1.sessionId}/timing`);
  const t2 = await hub.api('GET', `/sessions/${w2.sessionId}/timing`);
  assert.deepEqual({ turns: t1.turns, wallMs: t1.wallMs, modelMs: t1.modelMs, toolMs: t1.toolMs, compactMs: t1.compactMs, rateLimitWaitMs: t1.rateLimitWaitMs }, { turns: 1, wallMs: 10000, modelMs: 1500, toolMs: 2000, compactMs: 1000, rateLimitWaitMs: 4000 });

  // The time breakdown is in the worker's drawer: open it, read it, close it.
  const timing = async (sid) => {
    await page.openDrawer(sid);
    await b.waitFor(`!document.querySelector('.cluster-drawer [data-sec="time"] .cluster-timing-loading')`, { timeout: 8000 });
    const r = await b.eval(`(() => {
    const c = document.querySelector('.cluster-drawer');
    const part = (k) => { const li = c.querySelector('.cluster-legend [data-part="' + k + '"]'); return li ? li.querySelector('.cluster-legend-value').innerText.trim() : null; };
    const reasons = [...c.querySelectorAll('.cluster-reason')].map((p) => p.innerText.trim());
    const bar = Object.fromEntries([...c.querySelectorAll('.cluster-bar [data-seg]')].map((s) => [s.dataset.seg, s.style.width]));
    return { total: c.querySelector('.cluster-timing-total')?.innerText.trim(), failed: c.querySelector('.cluster-timing-failed')?.innerText.trim() ?? null, model: part('modelMs'), tool: part('toolMs'), wait: part('rateLimitWaitMs'), compact: part('compactMs'), bar, reasons, facts: c.querySelector('.cluster-timing-facts')?.innerText.trim() ?? null };
  })()`);
    await page.closeDrawer();
    return r;
  };
  const a = await timing(w1.sessionId);
  assert.equal(a.failed, null);
  assert.equal(a.total, '總時間 10.0 秒');
  assert.deepEqual([a.model, a.tool, a.wait, a.compact], ['1.5 秒', '2.0 秒', '4.0 秒', '1.0 秒']);
  // The bar: each part's share of the 10 s turn.
  assert.deepEqual(Object.fromEntries(Object.entries(a.bar).map(([k, v]) => [k, parseFloat(v)])), { modelMs: 15, toolMs: 20, rateLimitWaitMs: 40, compactMs: 10 });
  assert.match(a.facts, /回合 1/);
  assert.match(a.facts, /子代理 2/);
  assert.match(a.facts, /子代理限流重排 2/);
  // What the Hub could not measure is said with the Hub's own reason, nothing is worked out in its place.
  for (const u of t1.unmeasured) assert.ok(a.reasons.some((r) => r.endsWith(u.split('：').slice(1).join('：'))), `the page says "${u}": ${JSON.stringify(a.reasons)}`);

  // The other worker's turn was written without times: the Hub says so, and so does the page.
  const z = await timing(w2.sessionId);
  assert.equal(t2.wallMs, null);
  assert.equal(z.total, '總時間 量不到');
  assert.equal(z.model, '量不到');
  assert.equal(z.tool, '量不到');
  assert.deepEqual(z.bar, {}, 'no segment is drawn for what was not measured');
  for (const f of ['wallMs', 'modelMs', 'toolMs']) {
    const why = t2.unmeasured.find((u) => u.startsWith(`${f}：`));
    assert.ok(why, `the Hub explains ${f}`);
    assert.ok(z.reasons.some((r) => r.endsWith(why.slice(f.length + 1))), `the page repeats the Hub's reason for ${f}: ${JSON.stringify(z.reasons)}`);
  }
  await shot('06-cluster-page-timing-1280-light.png');
});

// ------------------------------------------------------------------- memory

test('a decision added on the page is written to the memory file, shown, and told to a worker with ITS next message, once', { skip }, async () => {
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('任務')`);
  const path0 = await b.eval(`document.querySelector('.cluster-memory-path').innerText.trim()`);
  assert.equal(path0, S.c.memory.path);
  const shown0 = await b.eval(`document.querySelector('.cluster-memory-text').textContent`);
  const api0 = await hub.api('GET', `/clusters/${S.c.id}/memory`);
  assert.equal(shown0, api0.text, 'the page shows the file as the Hub read it');
  assert.equal(shown0, fs.readFileSync(S.c.memory.path, 'utf8'), 'and that is the file on the computer\'s disk');
  assert.ok(shown0.includes('NOTE_E2E') && shown0.includes('改登入頁'));
  // The file is outside every worktree and outside git.
  assert.ok(!S.c.workers.some((w) => S.c.memory.path.startsWith(w.worktree)), 'not in a worktree');
  assert.equal(git(S.repo, 'status', '--porcelain'), '', 'and not a change in the main folder');

  assert.equal(await b.eval(`document.querySelector('[data-action="add-memory"]').disabled`), true, 'nothing to add yet');
  await typeInto('textarea[name="decision"]', '決定：DECISION_E2E 全部用 tabs，API 前綴是 /v2');
  assert.equal(await b.eval(`document.querySelector('[data-action="add-memory"]').disabled`), false);
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('DECISION_E2E')`);
  assert.equal(await b.eval(`document.querySelector('textarea[name="decision"]').value`), '', 'the box is emptied');
  const api1 = await hub.api('GET', `/clusters/${S.c.id}/memory`);
  assert.match(api1.text, /## 主對話決定（\d{4}-\d\d-\d\d \d\d:\d\d）\n\n決定：DECISION_E2E 全部用 tabs，API 前綴是 \/v2\n$/);
  assert.ok(api1.text.startsWith(api0.text), 'only appended');
  assert.equal(fs.readFileSync(S.c.memory.path, 'utf8'), api1.text);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-text').textContent`), api1.text);
  assert.match(await b.eval(`document.querySelector('.cluster-memory-meta').innerText`), new RegExp(`${api1.bytes} B`));
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-memory .cluster-error')?.innerText.trim())`), false, 'no error shown');
  await shot('07-cluster-memory-1280-light.png');

  // The worker is told with its next message - sent from the worker's own conversation, by a person typing.
  const [w1] = S.c.workers;
  const sent = prompts(S.k[0]).length;
  await open(`#/s/${w1.sessionId}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await typeInto('.composer-input', '下一句話 NEXT_ONE');
  await press('Enter');
  await until(async () => prompts(S.k[0]).length === sent + 1, 10000, 'the message reached Kimi');
  const told = reminders(prompts(S.k[0]).at(-1)).filter((r) => r.includes(S.c.memory.path));
  assert.equal(told.length, 1, 'one reminder about the memory in front of it');
  assert.ok(told[0].includes('DECISION_E2E'));
  assert.ok(!told[0].includes('NOTE_E2E'), 'only what is new since its brief');
  hub.machine.reply(S.k[0], prompts(S.k[0]).at(-1).body.prompt_id, '下一句話 NEXT_ONE');
  await idle(w1.sessionId);
  await b.sleep(300);
  await typeInto('.composer-input', '再一句 NEXT_TWO');
  await press('Enter');
  await until(async () => prompts(S.k[0]).length === sent + 2, 10000, 'the second message reached Kimi');
  assert.ok(!reminders(prompts(S.k[0]).at(-1)).some((r) => r.includes('DECISION_E2E')), 'told once');
  hub.machine.reply(S.k[0], prompts(S.k[0]).at(-1).body.prompt_id, '再一句 NEXT_TWO');
  await idle(w1.sessionId);
  // The other worker has not been sent anything since: it is told, once, when it is.
  const sent2 = prompts(S.k[1]).length;
  await hub.api('POST', `/sessions/${S.c.workers[1].sessionId}/messages`, { text: '乙的下一句' });
  await until(async () => prompts(S.k[1]).length === sent2 + 1, 10000, 'w2\'s message');
  assert.ok(reminders(prompts(S.k[1]).at(-1)).some((r) => r.includes('DECISION_E2E')));
  hub.machine.reply(S.k[1], prompts(S.k[1]).at(-1).body.prompt_id, '乙的下一句');
  await idle(S.c.workers[1].sessionId);
});

// -------------------------------------------------------------------- merge

test('merge from the page: the confirmation says what it will do; cancelling merges nothing; confirming makes the new branch with both workers\' commits and leaves the main folder alone', { skip }, async () => {
  const [w1, w2] = S.c.workers;
  fs.writeFileSync(path.join(w1.worktree, 'alpha.txt'), 'alpha\n');
  git(w1.worktree, 'add', '-A');
  git(w1.worktree, 'commit', '-q', '-m', 'alpha');
  fs.writeFileSync(path.join(w2.worktree, 'beta.txt'), 'beta\n');
  git(w2.worktree, 'add', '-A');
  git(w2.worktree, 'commit', '-q', '-m', 'beta');
  const headBefore = git(S.repo, 'rev-parse', 'HEAD');
  const mergedBranch = `cluster/${S.c.id}/merged`;

  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('[data-action="merge"]')`);
  assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), false);
  await b.click('[data-action="merge"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  const asked = await b.eval(`document.querySelector('.dialog').innerText`);
  assert.match(asked, /要合併各工作者的分支嗎/);
  assert.ok(asked.includes(mergedBranch), 'it names the new branch');
  assert.doesNotMatch(asked, /沒做完/, 'both workers are done: nothing to warn about');
  await shot('08-merge-confirm-1280-light.png');
  // Cancel: nothing happens.
  await b.click('.dialog .dialog-actions .om-btn:first-child');
  await b.waitFor(`!document.querySelector('.dialog')`);
  await b.sleep(300);
  assert.equal(git(S.repo, 'branch', '--list', mergedBranch), '', 'no branch was made');
  assert.equal((await getCluster(S.c.id)).merge, null);

  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 15000 });
  const m = await b.eval(`({ branch: document.querySelector('[data-field="merge-branch"]').innerText.trim(), rows: [...document.querySelectorAll('.cluster-merge-list > li')].map((li) => ({ ok: li.dataset.ok, session: li.dataset.session, name: li.querySelector('.cluster-merge-name').innerText.trim(), badge: li.querySelector('.om-badge').innerText.trim(), branch: li.querySelector('.cluster-merge-branchname').innerText.trim() })) })`);
  assert.equal(m.branch, mergedBranch);
  assert.deepEqual(m.rows, S.c.workers.map((w) => ({ ok: 'true', session: w.sessionId, name: w.title, badge: '已合併', branch: w.branch })));
  // The disk agrees.
  assert.equal(git(S.repo, 'show', `${mergedBranch}:alpha.txt`), 'alpha');
  assert.equal(git(S.repo, 'show', `${mergedBranch}:beta.txt`), 'beta');
  assert.equal(git(S.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the main folder is still on its branch');
  assert.equal(git(S.repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(S.repo, 'status', '--porcelain'), '', 'and untouched');
  assert.ok(!git(S.repo, 'worktree', 'list').includes('/merged'), 'the merge\'s own worktree is gone');
  const api = await getCluster(S.c.id);
  assert.deepEqual(api.merge.results.map((r) => r.ok), [true, true]);
  assert.equal(api.merge.branch, mergedBranch);
  // A cluster merges once: the button says so and cannot be pressed.
  const btn = await b.eval(`({ disabled: document.querySelector('[data-action="merge"]').disabled, title: document.querySelector('[data-action="merge"]').title })`);
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /已經合併過/);
  await b.eval(`document.querySelector('.cluster-merge').scrollIntoView()`);
  await shot('09-merge-result-1280-light.png');

  // Reload: the result is the Hub's, not the page's memory.
  await open(`#/cluster/${S.c.id}`);
  await b.waitFor(`document.querySelector('.cluster-merge [data-field="merge-branch"]')`);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-merge-list > li').length`), 2);

  // The main conversation was told, as a system line (not as something the user said).
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.body.innerText.includes('${S.c.id} 合併完成')`, { timeout: 10000 });
  const line = await b.eval(`(() => { const el = [...document.querySelectorAll('.transcript *')].filter((e) => e.children.length === 0 && e.innerText?.includes('合併完成')).pop(); return el ? { text: el.innerText, inUserBubble: Boolean(el.closest('.msg-user, .user, [data-role="user"]')) } : null; })()`);
  assert.ok(line, 'the system line is in the main conversation');
  assert.ok(line.text.includes(mergedBranch) && line.text.includes('成功：w1、w2'));
  assert.equal(line.inUserBubble, false);
  const parentEvents = (await snap(S.parent.id)).events;
  assert.ok(parentEvents.some((e) => e.type === 'info' && e.text.includes('合併完成')));
  assert.ok(!parentEvents.some((e) => e.type === 'user' && e.text.includes('合併完成')), 'not a made-up message from the user');
});

test('merge with trouble: a clash is listed with its files, a branch that is gone says so, the rest still merge, nothing is left half done', { skip }, async () => {
  // A second cluster of three from the same main conversation, made from the page.
  const c = await dispatchFromScreen(S.parent, ['改甲', '改乙', '改丙']);
  S.c2 = c;
  assert.equal(c.workers.length, 3);
  const finish = async () => {
    for (const w of c.workers) {
      const kid = await kidOf(w.sessionId);
      const p = prompts(kid)[0];
      hub.machine.reply(kid, p.body.prompt_id, '簡報');
    }
    await until(async () => (await getCluster(c.id)).status === 'done', 10000, 'all three done');
  };
  await finish();
  const [w1, w2, w3] = c.workers;
  const edit = (w, line) => {
    const f = path.join(w.worktree, 'a.txt');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('one', line));
    git(w.worktree, 'commit', '-q', '-am', line);
  };
  edit(w1, 'ONE_FROM_W1');
  edit(w2, 'ONE_FROM_W2'); // the same line: it clashes with w1
  // w3's branch goes (someone cleaned up by hand).
  git(S.repo, 'worktree', 'remove', '--force', w3.worktree);
  git(S.repo, 'branch', '-D', w3.branch);
  const headBefore = git(S.repo, 'rev-parse', 'HEAD');

  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 3`);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 15000 });
  const rows = await b.eval(`[...document.querySelectorAll('.cluster-merge-list > li')].map((li) => ({ ok: li.dataset.ok, name: li.querySelector('.cluster-merge-name').innerText.trim(), badge: li.querySelector('.om-badge').innerText.trim(), files: [...li.querySelectorAll('.cluster-conflicts code')].map((e) => e.innerText), error: li.querySelector('.om-field__error')?.innerText.trim() ?? null, text: li.innerText }))`);
  assert.deepEqual(rows.map((r) => [r.ok, r.name, r.badge]), [['true', '改甲', '已合併'], ['false', '改乙', '衝突 1 個檔案'], ['false', '改丙', '合併失敗']]);
  assert.deepEqual(rows[1].files, ['a.txt']);
  assert.match(rows[1].text, /沒有合進去/);
  assert.match(rows[2].error, new RegExp(`找不到分支 ${w3.branch}`));
  await b.eval(`document.querySelector('.cluster-merge').scrollIntoView()`);
  await shot('10-merge-conflict-1280-light.png');
  // The Hub says the same.
  const api = await getCluster(c.id);
  assert.deepEqual(api.merge.results.map((r) => [r.ok, r.conflicts]), [[true, []], [false, ['a.txt']], [false, []]]);
  // And the disk: w1's change is in the merged branch, w2's is not, no merge is hanging in the main folder.
  const merged = `cluster/${c.id}/merged`;
  assert.equal(git(S.repo, 'show', `${merged}:a.txt`).split('\n')[0], 'ONE_FROM_W1');
  assert.equal(git(S.repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(S.repo, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(S.repo, '.git', 'MERGE_HEAD')), false);
  assert.ok(!git(S.repo, 'worktree', 'list').includes('/merged'));
  assert.equal(git(S.repo, 'status', '--porcelain', '-b', '--', 'a.txt').includes('UU'), false);
  // The main conversation is told which ones did not go in, and why.
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.body.innerText.includes('${c.id} 合併完成')`, { timeout: 10000 });
  const text = (await snap(S.parent.id)).events.filter((e) => e.type === 'info' && e.text.includes(c.id)).at(-1).text;
  assert.match(text, /成功：w1。/);
  assert.match(text, /w2（衝突 a\.txt）/);
  assert.match(text, /w3（找不到分支/);
});

// --------------------------------------------------------------------- stop

test('全部停止: the confirmation, the interrupt of every working worker (nothing deleted), and the page reads 已停止 once Kimi says the turns are over', { skip }, async () => {
  const c = await dispatchFromScreen(S.parent, ['停甲', '停乙']);
  S.c3 = c;
  assert.equal(c.status, 'running');
  const kids = await Promise.all(c.workers.map((w) => kidOf(w.sessionId)));
  const aborts = () => hub.machine.requests.filter((r) => r.path.endsWith(':abort')).map((r) => r.path);
  const base = aborts().length;
  assert.equal(await b.eval(`document.querySelector('[data-action="stop"]').disabled`), false, 'a running cluster can be stopped');

  await b.click('[data-action="stop"]');
  await b.waitFor(`document.querySelector('.dialog')`);
  assert.match(await b.eval(`document.querySelector('.dialog').innerText`), /停止全部工作者/);
  await shot('11-stop-confirm-1280-light.png');
  await b.click('.dialog .dialog-actions .om-btn:first-child'); // cancel
  await b.waitFor(`!document.querySelector('.dialog')`);
  await b.sleep(300);
  assert.equal(aborts().length, base, 'cancelling interrupts nothing');

  await b.click('[data-action="stop"]');
  await confirm();
  await until(async () => aborts().length === base + 2, 8000, 'both workers interrupted');
  assert.deepEqual(aborts().slice(base).sort(), kids.map((k) => `/api/v1/sessions/${k}:abort`).sort(), 'each worker, once');
  // Kimi reports each turn over.
  for (const k of kids) hub.machine.frame(k, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已停止'`, { label: 'the header reads 已停止 by itself' });
  assert.equal((await getCluster(c.id)).status, 'stopped');
  assert.equal(await b.eval(`document.querySelector('[data-action="stop"]').disabled`), true, 'nothing left to stop');
  // Nothing was deleted: the conversations, the worktrees and the branches are all there.
  for (const w of c.workers) {
    assert.ok((await snap(w.sessionId)).id);
    assert.ok(fs.existsSync(w.worktree));
    assert.notEqual(git(S.repo, 'branch', '--list', w.branch), '');
  }
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-worker').length`), 2);
  await shot('12-stopped-1280-light.png');
  // The banner on the main conversation is gone for a cluster that is no longer running.
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.sleep(500);
  const banners = await b.eval(`[...document.querySelectorAll('.cluster-banner')].map((e) => e.querySelector('a').getAttribute('href'))`);
  assert.ok(!banners.includes(`#/cluster/${c.id}`), 'no banner for the stopped one');
});

// ------------------------------------------------- what moves while a page is open

test('a cluster made elsewhere puts the banner on an open main conversation, and what a worker says moves its progress line, with no reload', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  S.p2 = parent;
  await open(`#/s/${parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-banner'))`), false);
  // Made by someone else (another tab, the API): this page is only told over the socket.
  const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '即時甲', prompt: '請處理即時甲' }] });
  S.c4 = c;
  await b.waitFor(`document.querySelector('.cluster-banner')`, { label: 'the banner appears by itself' });
  assert.match(await b.eval(`document.querySelector('.cluster-banner').innerText`), /叢集進行中 0\/1 完成/);
  assert.equal(await b.eval(`document.querySelector('.cluster-banner a').getAttribute('href')`), `#/cluster/${c.id}`);

  await b.eval(`document.querySelector('.cluster-banner a').click()`);
  await b.waitFor(`document.querySelector('.cluster-worker')`);
  await page.openDrawer(c.workers[0].sessionId);
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-progress').innerText.trim()`), '還沒有進度');
  const kid = await kidOf(c.workers[0].sessionId);
  hub.machine.frame(kid, 'turn.started', { turnId: 'live1', promptId: 'p_live', origin: { kind: 'user' }, prompt: 'x' });
  hub.machine.frame(kid, 'assistant.delta', { turnId: 'live1', delta: '正在讀 LIVE_PROGRESS 相關的檔案' });
  await b.waitFor(`document.querySelector('.cluster-worker-progress').innerText.includes('LIVE_PROGRESS')`, { label: 'the progress line follows the worker' });
  assert.equal((await getCluster(c.id)).workers[0].progress, await b.eval(`document.querySelector('.cluster-worker-progress').innerText.trim()`), 'it is the Hub\'s own line');
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-state').innerText.trim()`), '執行中');
});

test('merging takes a while: the page says 合併中, the buttons wait, then the result', { skip }, async () => {
  const c = S.c4;
  const w = c.workers[0];
  const kid = await kidOf(w.sessionId);
  hub.machine.frame(kid, 'assistant.delta', { turnId: 'live1', delta: '做完了' });
  hub.machine.frame(kid, 'turn.ended', { reason: 'completed' });
  hub.machine.frame(kid, 'event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`);
  fs.writeFileSync(path.join(w.worktree, 'live.txt'), 'live\n');
  git(w.worktree, 'add', '-A');
  git(w.worktree, 'commit', '-q', '-m', 'live');
  // A slow disk: the merge's own git work takes a moment.
  hub.machine.shHook = async (a) => {
    if (/merge --no-ff/.test(a.command)) await wait(1500);
  };
  try {
    await b.click('[data-action="merge"]');
    await confirm();
    await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '合併中'`, { label: 'the header reads 合併中 while it runs' });
    assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), true, 'the merge button waits');
    assert.equal(await b.eval(`document.querySelector('[data-action="stop"]').disabled`), true);
    await shot('13-cluster-merging-1280-light.png');
    await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 15000 });
    assert.equal(await b.eval(`document.querySelector('[data-field="status"]').innerText.trim()`), '已完成');
    assert.equal(await b.eval(`document.querySelector('.cluster-merge-list > li').dataset.ok`), 'true');
  } finally {
    hub.machine.shHook = null;
  }
});

test('a worker whose conversation was deleted reads 已刪除 on an open page (no link to open, no time to read), the rest are as they were', { skip }, async () => {
  const c = S.c3;
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  const [w1, w2] = c.workers;
  await hub.api('DELETE', `/sessions/${w1.sessionId}`);
  assert.equal((await getCluster(c.id)).workers[0].status, 'deleted', 'the Hub says so');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${w1.sessionId}"] .cluster-worker-state')?.innerText.trim() === '已刪除'`, { label: 'the card follows the deletion', timeout: 8000 });
  await page.openDrawer(w1.sessionId);
  const card = await b.eval(`(() => { const c = document.querySelector('.cluster-drawer'); return { open: Boolean(c.querySelector('[data-action="open-worker"]') && !c.querySelector('[data-action="open-worker"]').hidden), timing: c.querySelector('.cluster-timing-failed')?.innerText ?? null }; })()`);
  await page.closeDrawer();
  assert.equal(card.open, false);
  assert.match(card.timing, /已被刪除/);
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /1 個已刪除/);
  // The other one was cut off by the stop above: still there, still not a finished worker.
  assert.equal(await b.eval(`document.querySelector('.cluster-worker[data-session="${w2.sessionId}"] .cluster-worker-state').innerText.trim()`), '閒置');
});

test('after 全部停止 a worker that was cut off in the middle is not 已完成 and is not counted as done; one that had finished before stays done', { skip }, async () => {
  const c = await dispatchFromScreen(S.parent, ['先做完', '被打斷']);
  const [done, cut] = c.workers;
  const kd = await kidOf(done.sessionId);
  const kc = await kidOf(cut.sessionId);
  hub.machine.reply(kd, prompts(kd)[0].body.prompt_id, '簡報');
  await b.waitFor(`document.querySelector('.cluster-worker[data-session="${done.sessionId}"] .cluster-worker-state').innerText.trim() === '已完成'`);
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 1/2 完成');

  await b.click('[data-action="stop"]');
  await confirm();
  await until(async () => hub.machine.requests.some((r) => r.path === `/api/v1/sessions/${kc}:abort`), 8000, 'the cut-off worker interrupted');
  hub.machine.frame(kc, 'event.session.work_changed', { busy: false, last_turn_reason: 'interrupted', pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已停止'`);
  const states = await b.eval(`Object.fromEntries([...document.querySelectorAll('.cluster-worker')].map((c) => [c.dataset.session, c.querySelector('.cluster-worker-state').innerText.trim()]))`);
  assert.equal(states[done.sessionId], '已完成', 'it had finished before the stop');
  assert.notEqual(states[cut.sessionId], '已完成', 'it did not finish: it was stopped');
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 1/2 完成', 'only the one that finished is counted');
  const api = await getCluster(c.id);
  assert.equal(api.status, 'stopped');
  assert.equal(api.workers.find((w) => w.sessionId === cut.sessionId).finishedAt, null, 'the Hub does not say it finished');
  assert.ok(api.workers.find((w) => w.sessionId === done.sessionId).finishedAt);
  // The merge button tells that one worker is not done.
  assert.match(await b.eval(`document.querySelector('[data-action="merge"]').title`), /1 條任務失敗或被中斷/);
  // Going on with the stopped worker (a message to it) makes the cluster a running one again.
  await hub.api('POST', `/sessions/${cut.sessionId}/messages`, { text: '接著做' });
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '進行中'`, { label: 'running again' });
  hub.machine.reply(kc, prompts(kc).at(-1).body.prompt_id, '接著做');
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`, { label: 'done once it has finished' });
  assert.equal(await b.eval(`document.querySelector('.cluster-progress').innerText.trim()`), '任務 2/2 完成');
});

// ------------------------------------------------------- other kinds of folder

test('a folder that is not a git project: the warning (toast and page), workers sharing the folder, no branch, no merge, the memory in the folder', { skip }, async () => {
  const plain = path.join(hub.TMP, `plain-${++N}`);
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'notes.txt'), 'hello\n');
  const parent = await newKimi(plain);
  await idle(parent.id);
  await openDialogFromComposer(parent.id);
  await fillTask(0, '整理筆記', '把 notes.txt 整理一下');
  await submitDialog();
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 20000 });
  await b.waitFor(`document.querySelector('.cluster-worker')`);
  const warning = '不是 git 專案，工作者共用同一個資料夾，可能互相覆蓋';
  await b.waitFor(`document.querySelector('.toast')?.innerText.includes('不是 git 專案')`, { label: 'the warning is said' });
  const cid = await b.eval('location.hash.slice(10)');
  const c = await getCluster(cid);
  assert.deepEqual(c.warnings, [warning]);
  assert.equal(c.isolate, false);
  assert.equal(await b.eval(`document.querySelector('.cluster-warns').innerText`), warning);
  const card = (await cards())[0];
  assert.equal(card.branch, null);
  assert.equal(card.worktree, null);
  assert.equal(await b.eval(`Boolean(document.querySelector('[data-field="no-merge"]'))`), true, 'the page says why there is nothing to merge');
  const btn = await b.eval(`({ disabled: document.querySelector('[data-action="merge"]').disabled, title: document.querySelector('[data-action="merge"]').title })`);
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /沒有分支可以合併/);
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /共用同一個資料夾/);
  // Really: both the worker and the memory are in the project's own folder.
  const kid = await kidOf(c.workers[0].sessionId);
  assert.equal(fs.realpathSync(hub.machine.sessions.get(kid).cwd), fs.realpathSync(plain));
  assert.equal(c.memory.path, `${plain}/.agent-hub-cluster/${cid}/memory.md`);
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('整理筆記')`);
  // The Hub refuses a merge outright.
  await assert.rejects(hub.api('POST', `/clusters/${cid}/merge`), (e) => e.status === 409);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await idle(c.workers[0].sessionId);
});

test('完整分叉 from the page: Kimi\'s own :fork per worker, the history comes along; a busy main conversation is refused with the Hub\'s reason, shown in the dialog', { skip }, async () => {
  hub.machine.autoReply = true;
  const parent = await newKimi(S.repo, { prompt: '聊天 分叉前的話 FORK_HISTORY' });
  await idle(parent.id);
  hub.machine.autoReply = false;
  const forks0 = hub.machine.forks.length;
  const c = await dispatchFromScreen(parent, ['叉甲', '叉乙'], { fork: true });
  assert.equal(c.mode, 'fork');
  assert.equal(hub.machine.forks.length, forks0 + 2, 'one native :fork per worker');
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /完整分叉/);
  // The page shows the worktree each worker is to edit in, and says (the Hub's warning) that a fork starts in the main folder.
  const shown = await cards();
  assert.deepEqual(shown.map((x) => x.branch), c.workers.map((w) => w.branch));
  const warns = await b.eval(`[...document.querySelectorAll('.cluster-warns .cluster-warn')].map((e) => e.innerText.trim())`);
  assert.equal(warns.length, c.warnings.length);
  assert.ok(warns.some((w) => /完整分叉的工作者從主對話的資料夾起跑/.test(w)));
  const forked = await snap(c.workers[0].sessionId);
  assert.ok(forked.events.some((e) => e.type === 'user' && /FORK_HISTORY/.test(e.text)), 'the history came with the fork');
  assert.equal(forked.clusterRole, 'worker');

  // Now the main conversation is at work: a fork is refused, and the dialog says why before and after.
  await hub.api('POST', `/sessions/${parent.id}/messages`, { text: '正在忙的一句話' });
  await until(async () => (await snap(parent.id)).status === 'running', 8000, 'the main conversation running');
  await openDialogFromComposer(parent.id);
  await fillTask(0, '被擋', '這個會被擋下');
  await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
  await b.waitFor(`document.querySelector('.cluster-dialog .cluster-warn')`);
  assert.match(await b.eval(`document.querySelector('.cluster-dialog .cluster-warns').innerText`), /等它閒下來/, 'said before sending');
  const clustersBefore = (await clustersOf(parent.id)).length;
  await submitDialog();
  await b.waitFor(`document.querySelector('.cluster-dialog .cluster-error')?.innerText.trim()`);
  const err = await b.eval(`document.querySelector('.cluster-dialog .cluster-error').innerText.trim()`);
  assert.match(err, /主對話正在執行中/);
  assert.equal(await b.eval('location.hash'), `#/s/${parent.id}`, 'nobody was taken anywhere');
  assert.equal((await clustersOf(parent.id)).length, clustersBefore, 'and nothing was made');
  assert.equal(await b.eval(`document.querySelector('.cluster-task input[name="task-title"]').value`), '被擋', 'what was typed is still there');
  await shot('14-dialog-refused-1280-light.png');
  hub.machine.reply(parent.kimiSessionId, prompts(parent.kimiSessionId).at(-1).body.prompt_id, '正在忙的一句話');
  await idle(parent.id);
});

test('a DeepSeek conversation dispatches DeepSeek workers; the request count and 429s of the connector\'s proxy reach the time breakdown', { skip }, async () => {
  const parent = await newDeepseek(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['深甲']);
  const w = c.workers[0];
  const s = await snap(w.sessionId);
  assert.equal(s.provider, 'deepseek');
  assert.equal(s.clusterRole, 'worker');
  const rows = await b.eval(`[...document.querySelectorAll('.sidebar .side-row')].find((r) => r.querySelector('.row-title')?.innerText.trim() === '深甲')?.querySelectorAll('.row-tag').length ? [...[...document.querySelectorAll('.sidebar .side-row')].find((r) => r.querySelector('.row-title')?.innerText.trim() === '深甲').querySelectorAll('.row-tag')].map((e) => e.innerText.trim()) : null`);
  assert.ok(rows?.includes('叢集') && rows.some((x) => /deepseek/i.test(x)), `the worker's row says DeepSeek and 叢集: ${JSON.stringify(rows)}`);

  // The connector's proxy reports what it sent for this worker's conversation: 3 requests, one a 429.
  hub.machine.send({ t: 'broker.ready', broker: 1, capabilities: ['pool', 'pool_timing'] });
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID).capabilities.includes('pool_timing'), 5000, 'pool_timing');
  const kid = s.kimiSessionId;
  const rec = (n, patch = {}) => ({ id: `r${n}-${kid}`, req: n, key: 'k_page', startAt: T + 100 * n, headersMs: 50, firstByteMs: 120, endMs: 900, status: 200, outcome: 'ok', session: kid, outTokens: 40, ...patch });
  hub.machine.send({ t: 'deepseek.requests', since: T - 1000, records: [rec(1), rec(2, { status: 429, outcome: 'http_error' }), rec(3)] });
  hub.machine.frameAt(kid, 'turn.started', T, { turnId: 'd1', promptId: 'p_d', origin: { kind: 'user' }, prompt: 'x' });
  hub.machine.frameAt(kid, 'turn.ended', T + 5000, { turnId: 'd1', reason: 'completed', durationMs: 5000 });
  const t = await until(async () => {
    const x = await hub.api('GET', `/sessions/${w.sessionId}/timing`);
    return x.requests === 3 && x;
  }, 8000, 'the requests counted');
  assert.equal(t.http429, 1);
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelector('.cluster-worker')`);
  await page.openDrawer(w.sessionId);
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing-facts')?.innerText.includes('請求 3')`, { label: 'the page shows the proxy\'s own count' });
  const facts = await b.eval(`document.querySelector('.cluster-drawer .cluster-timing-facts').innerText.trim()`);
  assert.match(facts, /請求 3/);
  assert.match(facts, /429 次數 1/);
  assert.equal(await b.eval(`document.querySelector('.cluster-drawer .cluster-timing-total').innerText.trim()`), '總時間 5.0 秒');
  assert.doesNotMatch(await b.eval(`document.querySelector('.cluster-drawer .cluster-timing').innerText`), /不是 DeepSeek 號池/, 'no "not a DeepSeek conversation" note for a DeepSeek one');
  await shot('15-cluster-deepseek-1280-light.png');
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
});

// ------------------------------------------------------- limits and odd states

test('a very large memory file: the page shows its last part and says so with the Hub\'s numbers; a file that is gone says so, and reading again after it is back works', { skip }, async () => {
  const c = S.c4;
  const orig = fs.readFileSync(c.memory.path, 'utf8');
  // A worker that wrote a lot: 100 KB, with multi-byte text so a cut can land inside a character.
  const big = `${'工作者的長筆記，一行一行寫下去。\n'.repeat(3000)}LAST_LINE_OF_MEMORY\n`;
  fs.appendFileSync(c.memory.path, big);
  const total = fs.statSync(c.memory.path).size;
  assert.ok(total > 90 * 1024);
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelector('.cluster-memory-truncated') && !document.querySelector('.cluster-memory-truncated').hidden`, { label: 'the truncation note' });
  const api = await hub.api('GET', `/clusters/${c.id}/memory`);
  assert.equal(api.truncated, true);
  assert.equal(api.bytes, total);
  const note = await b.eval(`document.querySelector('.cluster-memory-truncated').innerText`);
  assert.match(note, /只顯示最後一段/);
  assert.ok(note.includes(`第 ${api.from} 個位元組`), `the note carries the Hub's "from": ${note}`);
  const shown = await b.eval(`document.querySelector('.cluster-memory-text').textContent`);
  assert.equal(shown, api.text);
  assert.ok(shown.endsWith('LAST_LINE_OF_MEMORY\n'), 'the end of the file is what is shown');
  assert.ok(Buffer.byteLength(shown) <= total - api.from, 'and it is the tail from `from`');
  assert.ok(!shown.includes('主對話決定'), 'not the beginning');
  await b.eval(`document.querySelector('.cluster-memory').scrollIntoView()`);
  await shot('16-memory-truncated-1280-light.png');
  await b.eval(`window.scrollTo(0, 0); document.querySelector('.view')?.scrollTo?.(0, 0)`);

  // The file is deleted (a worker tidied up): the page says it cannot read it, with the Hub's reason.
  fs.rmSync(c.memory.path);
  await b.click('[data-action="reload-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-none') && !document.querySelector('.cluster-memory-none').hidden`);
  assert.match(await b.eval(`document.querySelector('.cluster-memory-none').innerText`), /讀不到叢集記憶：叢集記憶檔不見了/);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-text').hidden`), true);
  // The file is back: reading again works and the notes of the failure are gone.
  fs.writeFileSync(c.memory.path, orig);
  await b.click('[data-action="reload-memory"]');
  await b.waitFor(`!document.querySelector('.cluster-memory-text').hidden && document.querySelector('.cluster-memory-text').textContent.includes('即時甲')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-none').hidden`), true);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-truncated').hidden`), true);
});

test('a cluster that does not exist says so with a way to try again; a task title over the Hub\'s limit is refused with its reason and nothing is made', { skip }, async () => {
  await open('#/cluster/c_000000000000');
  await b.waitFor(`document.querySelector('.cluster-none')`);
  assert.match(await b.eval(`document.querySelector('.cluster-none').innerText`), /沒有這個叢集/);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-none [data-action="retry"]'))`), true);

  const parent = S.p2;
  const before = (await clustersOf(parent.id)).length;
  await openDialogFromComposer(parent.id);
  await fillTask(0, 'x'.repeat(121), '標題太長');
  await submitDialog();
  await b.waitFor(`document.querySelector('.cluster-dialog .cluster-error')?.innerText.trim() || /^#\\/cluster\\//.test(location.hash)`, { timeout: 10000 });
  const err = await b.eval(`document.querySelector('.cluster-dialog .cluster-error')?.innerText.trim() ?? null`);
  const titleBox = await b.eval(`document.querySelector('.cluster-task input[name="task-title"]')?.value.length ?? null`);
  // Either the box does not take more than the Hub does, or the Hub's refusal is shown: never a dialog that closes on nothing.
  assert.ok(titleBox === 120 || /標題最多 120/.test(err || ''), `limit enforced: box=${titleBox} error=${err}`);
  assert.equal((await clustersOf(parent.id)).length, before, 'nothing was made');
});

test('eight workers (the most) when asked for, each with its worktree, and the page and the sidebar hold them', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const titles = Array.from({ length: 8 }, (_, i) => `並行任務 ${i + 1}`);
  const c = await dispatchFromScreen(parent, titles, { workers: 8 });
  assert.equal(c.workers.length, 8);
  assert.deepEqual(c.workers.map((w) => w.title), titles);
  assert.equal((await cards()).length, 8);
  assert.equal(new Set(c.workers.map((w) => w.worktree)).size, 8, 'a worktree each');
  for (const w of c.workers) assert.ok(fs.existsSync(path.join(w.worktree, 'a.txt')));
  assert.match(await b.eval(`document.querySelector('.cluster-head').innerText`), /0\/8 完成/);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 8`);
  S.c8 = c;
  await shot('17-cluster-eight-1280-light.png');
  for (const w of c.workers) {
    const kid = await kidOf(w.sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  }
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成' && document.querySelector('.cluster-progress').innerText.trim() === '任務 8/8 完成'`);
});

// ------------------------------------------- coming back to what was dispatched

test('/cluster with a first task typed after it opens the dialog with that task in; 查看叢集… in the … menu lists every cluster of the conversation, newest first, and opens the one you pick', { skip }, async () => {
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await typeInto('.composer-input', '/cluster 掃描安全問題 ARGS_TASK');
  await press('Enter');
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-task textarea[name="task-prompt"]').value`), '掃描安全問題 ARGS_TASK');
  assert.equal(await b.eval(`document.querySelector('.composer-input').value`), '', 'and what was typed in the box is not left there');
  await b.eval(`document.querySelector('.dialog .dialog-actions .om-btn:not([type="submit"])').click()`);
  await b.waitFor(`!document.querySelector('.cluster-dialog')`);

  const mine = await clustersOf(S.parent.id);
  assert.ok(mine.length >= 3, 'this conversation has dispatched several');
  assert.deepEqual(mine.map((c) => c.createdAt), [...mine.map((c) => c.createdAt)].sort((a, b) => b - a), 'the Hub lists them newest first');
  await b.waitFor(`document.querySelector('.toolbar button[aria-label="更多"]')`);
  await b.click('.toolbar button[aria-label="更多"]');
  await b.waitFor(`document.querySelector('.om-menu .om-menu__item')`);
  const entry = await b.eval(`(() => { const i = [...document.querySelectorAll('.om-menu .om-menu__item')].find((e) => e.innerText.includes('查看叢集')); return i ? i.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
  assert.ok(entry, 'the menu has 查看叢集…');
  assert.ok(entry.includes(`${mine.length} 個叢集`), `it counts them: ${entry}`);
  await b.eval(`[...document.querySelectorAll('.om-menu .om-menu__item')].find((e) => e.innerText.includes('查看叢集')).click()`);
  await b.waitFor(`document.querySelector('.cluster-list .cluster-list-item')`);
  const items = await b.eval(`[...document.querySelectorAll('.cluster-list-item')].map((a) => ({ href: a.getAttribute('href'), text: a.innerText.replace(/\\s+/g, ' ').trim() }))`);
  assert.deepEqual(items.map((i) => i.href), mine.map((c) => `#/cluster/${c.id}`), 'every cluster, in the Hub\'s order');
  for (const [i, c] of mine.entries()) {
    const done = c.workers.filter((w) => w.finishedAt && w.status !== 'error' && w.status !== 'deleted').length;
    assert.ok(items[i].text.includes(`${done}/${c.workers.length} 完成`), `${c.id}: ${items[i].text}`);
    assert.ok(items[i].text.includes(c.mode === 'fork' ? '完整分叉' : '簡報起跑'));
  }
  await shot('24-cluster-list-1280-light.png');
  const pick = mine.at(-1); // the oldest
  await b.eval(`document.querySelector('.cluster-list-item[href="#/cluster/${pick.id}"]').click()`);
  await b.waitFor(`location.hash === '#/cluster/${pick.id}'`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === ${pick.workers.length}`);
  assert.equal(await b.eval(`!document.querySelector('.cluster-list')`), true, 'the list closed');
});

test('two clusters running at once on one conversation: a banner line each, each with its own count and link', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const mk = (n) => hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: Array.from({ length: n }, (_, i) => ({ title: `同時 ${n}-${i + 1}`, prompt: `請處理 ${n}-${i + 1}` })) });
  const { cluster: a } = await mk(1);
  const { cluster: c2 } = await mk(2);
  await open(`#/s/${parent.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-banner').length === 2`);
  const lines = await b.eval(`[...document.querySelectorAll('.cluster-banner')].map((e) => ({ text: e.innerText.replace(/\\s+/g, ' ').trim(), href: e.querySelector('a').getAttribute('href') }))`);
  assert.deepEqual(lines.map((l) => l.href).sort(), [`#/cluster/${a.id}`, `#/cluster/${c2.id}`].sort());
  const of = (id) => lines.find((l) => l.href === `#/cluster/${id}`).text;
  assert.match(of(a.id), /0\/1 完成/);
  assert.match(of(c2.id), /0\/2 完成/);
  // One of them finishes: only its line goes, the other stays, live.
  const kid = await kidOf(a.workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await b.waitFor(`document.querySelectorAll('.cluster-banner').length === 1`);
  assert.equal(await b.eval(`document.querySelector('.cluster-banner a').getAttribute('href')`), `#/cluster/${c2.id}`);
  for (const w of c2.workers) {
    const k = await kidOf(w.sessionId);
    hub.machine.reply(k, prompts(k)[0].body.prompt_id, '簡報');
  }
  await b.waitFor(`document.querySelectorAll('.cluster-banner').length === 0`);
});

test('a merge branch that is already there is refused by the Hub with its reason, which the page shows; nothing is merged, and the same press works once the branch is gone', { skip }, async () => {
  const c = S.c8;
  const branch = `cluster/${c.id}/merged`;
  git(S.repo, 'branch', branch); // left over, or made by hand
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 8`);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')`);
  assert.match(await b.eval(`document.querySelector('.cluster-head .cluster-error').innerText`), new RegExp(`${branch.replace(/\//g, '\\/')} 已經存在`));
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-merge'))`), false, 'no result shown');
  assert.equal((await getCluster(c.id)).merge, null);
  assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), false, 'the button is usable again');
  git(S.repo, 'branch', '-D', branch);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 20000 });
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-merge-list > li[data-ok="true"]').length`), 8, 'all eight merge (they changed nothing, so they are no-ops)');
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-head .cluster-error'))`), false, 'and the old refusal is gone');
});

// ------------------------------------------------ odd input, odd moments

test('text with markup in it (titles, tasks, the note, a decision, what a worker says) is shown as text, everywhere it is shown, and nothing runs', { skip }, async () => {
  const evil = '<img src=x onerror="window.__pwned=1"> <b>粗</b> "引號" \'單引號\' &amp; </pre><script>window.__pwned=2</script>';
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, [`標題 ${evil}`], { note: `備註 ${evil}` });
  assert.ok(c.workers[0].title.includes('<img src=x'), 'the Hub kept it as text');
  // The cluster screens build their text as text: no element may come out of it. A conversation's own
  // transcript renders Markdown (sanitised), where <b> is allowed, so there only what could run is checked.
  const check = async (where, { markdown = false } = {}) => {
    const bad = await b.eval(`({ pwned: window.__pwned ?? null, tags: document.querySelectorAll('${markdown ? '.view script, [onerror], [onload], [onclick]' : '.view img, .view script, .view b, .sidebar img, .sidebar b, .toolbar img'}').length })`);
    assert.equal(bad.pwned, null, `${where}: nothing ran`);
    assert.equal(bad.tags, 0, `${where}: no element came out of the text`);
  };
  const cardTitle = (await cards())[0].title;
  assert.ok(cardTitle.includes('<img src=x onerror='), 'the card shows the tag as typed');
  await check('cluster page');
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('備註')`);
  assert.ok((await b.eval(`document.querySelector('.cluster-memory-text').textContent`)).includes('<script>window.__pwned=2</script>'), 'the memory shows the note as typed');
  await typeInto('textarea[name="decision"]', `決定 ${evil}`);
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('決定 <img')`);
  await check('after a decision');
  // What the worker says goes to its progress line as text too.
  const kid = await kidOf(c.workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, evil);
  await b.waitFor(`document.querySelector('.cluster-worker-state').innerText.trim() === '已完成'`);
  await page.openDrawer(c.workers[0].sessionId);
  await b.waitFor(`document.querySelector('.cluster-worker-progress').innerText.includes('<img')`);
  await check('worker progress');
  await open(`#/s/${parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.sleep(400);
  await check('main conversation', { markdown: true });
  await open(`#/s/${c.workers[0].sessionId}`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  await b.sleep(400);
  await check('worker conversation', { markdown: true });
});

test('a double press on 派出 makes one cluster; going to a worker\'s conversation from its card and back brings the cluster page back whole', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const sessionsBefore = (await hub.api('GET', '/sessions')).length;
  await openDialogFromComposer(parent.id);
  await fillTask(0, '只派一次', '雙擊也只派一次');
  await b.eval(`(() => { const e = document.querySelector('.cluster-dialog button[type="submit"]'); e.click(); e.click(); e.click(); })()`);
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 20000 });
  await b.waitFor(`document.querySelector('.cluster-worker')`);
  await b.sleep(800); // anything a second press would have made has been made by now
  const list = await clustersOf(parent.id);
  assert.equal(list.length, 1, 'one cluster');
  assert.equal((await hub.api('GET', '/sessions')).length, sessionsBefore + 1, 'one worker conversation, and nothing else');
  assert.equal(git(S.repo, 'worktree', 'list').split('\n').filter((l) => l.includes(`-cluster-${list[0].id}/`)).length, 1, 'one worktree');

  // 開啟對話 from the card, and back.
  const cid = list[0].id;
  await page.openDrawer(list[0].workers[0].sessionId);
  await b.click('.cluster-drawer [data-action="open-worker"]');
  await b.waitFor(`location.hash === '#/s/${list[0].workers[0].sessionId}'`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  await b.eval(`history.back()`);
  await b.waitFor(`location.hash === '#/cluster/${cid}'`);
  await b.waitFor(`document.querySelector('.cluster-worker')`);
  assert.equal((await cards()).length, 1);
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-page').length`), 1, 'one page, not two on top of each other');
  assert.ok(!(await b.eval(`document.body.innerText`)).includes('沒有這個叢集'));
  const kid = await kidOf(list[0].workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
});

test('a worker waiting for the person\'s approval reads 等你核准 on the card and in the sidebar, the cluster is still running, and it goes back to 執行中 when answered', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['等核准的']);
  const w = c.workers[0];
  const kid = await kidOf(w.sessionId);
  hub.machine.frame(kid, 'event.session.work_changed', { busy: true, last_turn_reason: null, pending_interaction: 'approval' });
  await b.waitFor(`document.querySelector('.cluster-worker-state').innerText.trim() === '等你核准'`, { label: 'the card asks for the person' });
  assert.equal(await b.eval(`document.querySelector('[data-field="status"]').innerText.trim()`), '進行中', 'the cluster is not stuck or done');
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-state').classList.contains('om-badge--warning')`), true, 'drawn as something to act on');
  await page.openDrawer(w.sessionId);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-drawer [data-action="open-worker"]') && !document.querySelector('.cluster-drawer [data-action="open-worker"]').hidden)`), true, 'with the way to the conversation where it is answered, in its drawer');
  await page.closeDrawer();
  const row = await b.eval(`[...document.querySelectorAll('.sidebar .side-row')].find((r) => r.querySelector('.row-title')?.innerText.trim() === '等核准的')?.innerText ?? null`);
  assert.match(row, /需要你/, 'the sidebar says it too');
  assert.equal((await getCluster(c.id)).workers[0].status, 'awaiting_permission');
  await shot('26-worker-awaiting-approval-1280-light.png');
  hub.machine.frame(kid, 'event.session.work_changed', { busy: true, last_turn_reason: null, pending_interaction: 'none' });
  await b.waitFor(`document.querySelector('.cluster-worker-state').innerText.trim() === '執行中'`);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`);
});

test('the main conversation is deleted: the cluster and its workers stay, the page reads, and the way back does not break anything', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['孤兒甲']);
  const kid = await kidOf(c.workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`);
  await hub.api('DELETE', `/sessions/${parent.id}`);
  const api = await getCluster(c.id);
  assert.equal(api.workers[0].status, 'idle', 'the worker is a conversation of its own: it is still there');
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 1`);
  assert.equal(await b.eval(`document.querySelector('.cluster-worker-state').innerText.trim()`), '已完成');
  const link = await b.eval(`({ text: document.querySelector('[data-action="open-parent"]')?.innerText ?? null, href: document.querySelector('[data-action="open-parent"]')?.getAttribute('href') ?? null })`);
  assert.ok(!/「」/.test(link.text || ''), `no empty quotes where the title was: ${JSON.stringify(link)}`);
  await b.click('[data-action="open-parent"]');
  await b.sleep(600);
  // Wherever it goes, the page is alive (not blank, no raw error) and the worker's own conversation still opens.
  assert.ok((await b.eval(`document.body.innerText.length`)) > 20);
  await shot('27-parent-deleted-then-back-1280-light.png');
  await open(`#/s/${c.workers[0].sessionId}`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  const note = await b.eval(`[...document.querySelectorAll('.cluster-worker-note a')].map((a) => a.getAttribute('href'))`);
  assert.equal(note[0], `#/cluster/${c.id}`);
});

test('after the main conversation went through another runtime and came back (new nodes in its chain) its running cluster still shows on it: the banner under either address, and the way back from the cluster page', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '換執行環境前派的', prompt: '請處理' }] });
  const toClaude = await hub.api('POST', `/sessions/${parent.id}/provider`, { provider: 'claude', model: CLAUDE.model, ...(CLAUDE.effort ? { effort: CLAUDE.effort } : {}) });
  assert.notEqual(toClaude.id, parent.id, 'a Claude node is a new node of the chain');
  const back = await hub.api('POST', `/sessions/${toClaude.id}/provider`, { provider: 'kimi', model: KIMI.model, effort: KIMI.effort });
  const leafId = back.id;
  assert.ok(leafId && leafId !== parent.id && leafId !== toClaude.id, 'and back on Kimi is another');
  assert.equal((await clustersOf(leafId)).length, 1, 'the Hub lists the cluster under the leaf');
  assert.equal((await snap(leafId)).clusterIds?.[0] ?? null, c.id, 'and the leaf\'s summary says so');
  await open(`#/s/${leafId}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.waitFor(`document.querySelector('.cluster-banner')`, { label: 'the banner is on the continued conversation' });
  assert.equal(await b.eval(`document.querySelector('.cluster-banner a').getAttribute('href')`), `#/cluster/${c.id}`);
  // The same through the first node's address (a link made before the move).
  await open(`#/s/${parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.waitFor(`document.querySelector('.cluster-banner')`, { label: 'and through the old node\'s address' });
  // The cluster page leads back to the conversation, which opens with its banner.
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelector('[data-action="open-parent"]')`);
  await b.click('[data-action="open-parent"]');
  await b.waitFor(`document.querySelector('.composer-input')`);
  await b.waitFor(`document.querySelector('.cluster-banner')`, { label: 'back on the conversation, its banner is there' });
  const kid = await kidOf(c.workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await until(async () => (await getCluster(c.id)).status === 'done', 8000, 'done');
});

test('a worker whose own conversation moved to another runtime and back is still a worker: the tag, the note on its page, and the memory told to it with its next message', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['換過環境的工作者']);
  const w = c.workers[0];
  const k0 = await kidOf(w.sessionId);
  hub.machine.reply(k0, prompts(k0)[0].body.prompt_id, '簡報');
  await b.waitFor(`document.querySelector('.cluster-worker-state').innerText.trim() === '已完成'`);
  const toClaude = await hub.api('POST', `/sessions/${w.sessionId}/provider`, { provider: 'claude', model: CLAUDE.model, ...(CLAUDE.effort ? { effort: CLAUDE.effort } : {}) });
  const back = await hub.api('POST', `/sessions/${toClaude.id}/provider`, { provider: 'kimi', model: KIMI.model, effort: KIMI.effort });
  const leaf = await snap(back.id);
  assert.notEqual(leaf.id, w.sessionId, 'the worker\'s conversation went on in a new node');
  assert.equal(leaf.clusterId, c.id, 'the new node still knows its cluster');
  assert.equal(leaf.clusterRole, 'worker');
  // On screen: the tag in the sidebar, and the note on the conversation's page with both links.
  await open(`#/s/${leaf.id}`);
  await b.waitFor(`document.querySelector('.cluster-worker-note')`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker-note a').length === 2`);
  const tag = await b.eval(`[...document.querySelectorAll('.sidebar .side-row')].find((r) => r.getAttribute('href') === '#/s/${leaf.id}')?.querySelector('.row-tag.cluster')?.innerText ?? null`);
  assert.equal(tag, '叢集', 'the worker\'s row in the sidebar carries the tag');
  // The memory still reaches it: a decision added now is in front of its next message, once.
  await hub.api('POST', `/clusters/${c.id}/memory`, { text: '換環境之後的決定 DECISION_AFTER_SWITCH' });
  const kid = leaf.kimiSessionId;
  const sent = prompts(kid).length;
  await typeInto('.composer-input', '換環境後的第一句');
  await press('Enter');
  await until(async () => prompts(kid).length === sent + 1, 15000, 'the message at Kimi');
  // (The new node's first prompt also carries the hand-off of its history, which mentions the memory file.)
  const told = reminders(prompts(kid).at(-1)).filter((r) => r.includes('DECISION_AFTER_SWITCH'));
  assert.equal(told.length, 1, 'the new decision is told to the worker in its new node, once');
  assert.ok(told[0].includes('有新內容') && told[0].includes(c.memory.path), 'by the memory\'s own reminder');
  // The cluster page still has its card, found through the chain, and what the worker says in its new node moves the card's progress line.
  assert.equal((await getCluster(c.id)).workers[0].sessionId, w.sessionId);
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 1`);
  await page.openDrawer(w.sessionId);
  await b.waitFor(`document.querySelector('.cluster-drawer .cluster-timing, .cluster-drawer .cluster-timing-failed')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-drawer .cluster-timing-failed'))`), false, 'its time is read through the chain, not "量不到" for a missing conversation');
  hub.machine.frame(kid, 'assistant.delta', { turnId: 'after-switch', delta: '新節點裡說的話 SWITCHED_PROGRESS' });
  await b.waitFor(`document.querySelector('.cluster-worker-progress').innerText.includes('SWITCHED_PROGRESS')`, { label: 'the progress line follows the worker in its new node' });
  hub.machine.reply(kid, prompts(kid).at(-1).body.prompt_id, '換環境後的第一句');
});

test('a dialog closed (Esc) while the workers are being opened: nobody is taken away, the cluster is made all the same, and a note with a way to it appears', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  hub.machine.shHook = async (a) => {
    if (/worktree add/.test(a.command)) await wait(1200);
  };
  try {
    await openDialogFromComposer(parent.id);
    await fillTask(0, '關掉視窗也照派', '派工途中關掉視窗');
    await submitDialog();
    await b.waitFor(`document.querySelector('.cluster-sending') && !document.querySelector('.cluster-sending').hidden`);
    await press('Escape');
    await b.sleep(300);
    assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false, 'the dialog closed');
    assert.equal(await b.eval('location.hash'), `#/s/${parent.id}`, 'and the person stays where they are');
    await b.waitFor(`document.querySelector('.toast')?.innerText.includes('叢集已建立')`, { timeout: 20000, label: 'the note that it was made' });
    const list = await clustersOf(parent.id);
    assert.equal(list.length, 1, 'it was made, once');
    await b.eval(`[...document.querySelectorAll('.toast button')].find((x) => /查看/.test(x.innerText))?.click()`);
    await b.waitFor(`location.hash === '#/cluster/${list[0].id}'`);
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 1`);
    const kid = await kidOf(list[0].workers[0].sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  } finally {
    hub.machine.shHook = null;
  }
});

test('a project folder with spaces, a quote, a dollar sign and Chinese in its name: worktrees, the memory file and the merge all work from the page', { skip }, async () => {
  const dir = path.join(hub.TMP, `我的 專案's $HOME "repo" ${++N}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  const parent = await newKimi(dir);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['怪名字甲', '怪名字乙'], { note: '備註' });
  assert.deepEqual(c.warnings, []);
  const shown = await cards();
  const real = fs.realpathSync(dir);
  for (const [i, card] of shown.entries()) {
    assert.equal(card.worktree, `${path.dirname(real)}/${path.basename(real)}-cluster-${c.id}/w${i + 1}`);
    assert.ok(fs.existsSync(path.join(card.worktree, 'a.txt')), 'a real checkout');
    assert.equal(git(card.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), card.branch);
  }
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('怪名字甲')`);
  assert.equal(await b.eval(`document.querySelector('.cluster-memory-path').innerText.trim()`), c.memory.path);
  assert.ok(fs.existsSync(c.memory.path));
  await typeInto('textarea[name="decision"]', '怪路徑也寫得進去');
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('怪路徑也寫得進去')`);
  for (const [i, w] of c.workers.entries()) {
    const kid = await kidOf(w.sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
    fs.writeFileSync(path.join(w.worktree, `f${i}.txt`), `${i}\n`);
    git(w.worktree, 'add', '-A');
    git(w.worktree, 'commit', '-q', '-m', `f${i}`);
  }
  await b.waitFor(`document.querySelector('[data-field="status"]').innerText.trim() === '已完成'`);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 15000 });
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-merge-list > li[data-ok="true"]').length`), 2);
  const merged = `cluster/${c.id}/merged`;
  assert.equal(git(dir, 'show', `${merged}:f0.txt`), '0');
  assert.equal(git(dir, 'show', `${merged}:f1.txt`), '1');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a dispatch that fails half way (the second conversation cannot be opened; the second brief is refused after the first started): the Hub\'s reason is in the dialog, and when it is over the sidebar, the disk and the Hub hold nothing of it', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const sessionsBefore = (await hub.api('GET', '/sessions')).length;
  const worktreesBefore = git(S.repo, 'worktree', 'list');
  const branchesBefore = git(S.repo, 'branch', '--list', 'cluster/*');
  const noTraces = async (what) => {
    assert.equal(git(S.repo, 'worktree', 'list'), worktreesBefore, `${what}: no worktree left`);
    assert.equal(git(S.repo, 'branch', '--list', 'cluster/*'), branchesBefore, `${what}: no branch left`);
    assert.deepEqual(await clustersOf(parent.id), [], `${what}: no cluster`);
    await until(async () => (await hub.api('GET', '/sessions')).length === sessionsBefore, 8000, `${what}: the half-made conversations are gone from the Hub's list`);
    await b.waitFor(`![...document.querySelectorAll('.sidebar .side-row .row-title')].some((e) => e.innerText.includes('半途'))`, { label: `${what}: and from the sidebar` });
  };
  const tryDispatch = async () => {
    await openDialogFromComposer(parent.id);
    await b.click('[data-action="add-task"]');
    await fillTask(0, '半途甲', '第一個');
    await fillTask(1, '半途乙', '第二個');
    await submitDialog();
    await b.waitFor(`document.querySelector('.cluster-dialog .cluster-error')?.innerText.trim()`, { timeout: 20000 });
    assert.equal(await b.eval('location.hash'), `#/s/${parent.id}`, 'nobody was taken anywhere');
    assert.equal(await b.eval(`document.querySelector('.cluster-task input[name="task-title"]').value`), '半途甲', 'what was typed is still there');
    return b.eval(`document.querySelector('.cluster-dialog .cluster-error').innerText.trim()`);
  };

  let created = 0;
  hub.machine.createHook = () => (++created === 2 ? { code: 50001, msg: 'simulated: no room for another conversation', data: null } : null);
  try {
    assert.match(await tryDispatch(), /simulated: no room/);
  } finally {
    hub.machine.createHook = null;
  }
  await noTraces('conversation not opened');
  await b.eval(`(() => { const d = document.querySelector('.dialog'); if (d) d.scrollTop = d.scrollHeight; })()`);
  await shot('29-dispatch-failed-1280-light.png');

  let asked = 0;
  hub.machine.refusePrompts = () => ++asked === 2;
  try {
    assert.match(await tryDispatch(), /refused/);
  } finally {
    hub.machine.refusePrompts = false;
  }
  await noTraces('brief refused');
  // The same dialog, once the computer is willing, makes the cluster: nothing the failures left behind is in the way.
  hub.machine.refusePrompts = false;
  await submitDialog();
  await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 20000 });
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  const list = await clustersOf(parent.id);
  assert.equal(list.length, 1);
  for (const w of list[0].workers) {
    const kid = await kidOf(w.sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  }
});

test('a page whose link to the Hub was down while a cluster was dispatched elsewhere shows its banner once the link is back, without a reload', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  // It already has a finished cluster, so the page has asked the Hub for this conversation's clusters before.
  const { cluster: first } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '先前派的', prompt: '請處理' }] });
  const k1 = await kidOf(first.workers[0].sessionId);
  hub.machine.reply(k1, prompts(k1)[0].body.prompt_id, '簡報');
  await until(async () => (await getCluster(first.id)).status === 'done', 8000, 'the first cluster done');
  // A flaky link: the page's socket is cut and its reconnects go nowhere until the test lets them through.
  // (The data still comes from the real Hub; only the connection is played with.)
  const hook = await b.beforeLoad(`(() => {
    const Real = window.WebSocket;
    window.__socks = [];
    window.__blockWS = false;
    window.WebSocket = class extends Real {
      constructor(url, ...rest) { super(window.__blockWS ? 'ws://127.0.0.1:1/' : url, ...rest); window.__socks.push(this); }
    };
  })()`);
  try {
    await open(`#/s/${parent.id}`);
    await b.waitFor(`document.querySelector('.composer-input') && window.__socks.length > 0`);
    await b.eval(`window.__blockWS = true; window.__socks.forEach((s) => s.close())`);
    await b.waitFor(`document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 10000, label: 'the page knows the link is down' });
    const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '斷線時派的', prompt: '請處理' }] });
    await b.sleep(800);
    assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-banner'))`), false, 'the page cannot know yet');
    await b.eval(`window.__blockWS = false`);
    await b.waitFor(`!document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 30000, label: 'the link is back' });
    await b.waitFor(`document.querySelector('.cluster-banner')`, { timeout: 10000, label: 'the banner of the cluster made while the link was down' });
    assert.equal(await b.eval(`document.querySelector('.cluster-banner a').getAttribute('href')`), `#/cluster/${c.id}`);
    const kid = await kidOf(c.workers[0].sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
    await b.waitFor(`!document.querySelector('.cluster-banner')`, { label: 'and it goes when the cluster is done' });
  } finally {
    await b.eval(`window.__blockWS = false`);
    await b.removeBeforeLoad(hook);
  }
});

test('a cluster that finished while the page\'s link to the Hub was down does not keep its banner once the link is back', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const { cluster: c } = await hub.api('POST', `/sessions/${parent.id}/cluster`, { tasks: [{ title: '斷線時做完的', prompt: '請處理' }] });
  const hook = await b.beforeLoad(`(() => {
    const Real = window.WebSocket;
    window.__socks = [];
    window.__blockWS = false;
    window.WebSocket = class extends Real {
      constructor(url, ...rest) { super(window.__blockWS ? 'ws://127.0.0.1:1/' : url, ...rest); window.__socks.push(this); }
    };
  })()`);
  try {
    await open(`#/s/${parent.id}`);
    await b.waitFor(`document.querySelector('.cluster-banner') && window.__socks.length > 0`);
    assert.match(await b.eval(`document.querySelector('.cluster-banner').innerText`), /0\/1 完成/);
    await b.eval(`window.__blockWS = true; window.__socks.forEach((s) => s.close())`);
    await b.waitFor(`document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 10000 });
    const kid = await kidOf(c.workers[0].sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
    await until(async () => (await getCluster(c.id)).status === 'done', 8000, 'done at the Hub');
    await b.sleep(600);
    await b.eval(`window.__blockWS = false`);
    await b.waitFor(`!document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 30000, label: 'the link is back' });
    await b.waitFor(`!document.querySelector('.cluster-banner')`, { timeout: 10000, label: 'the banner is gone: the cluster is over' });
  } finally {
    await b.eval(`window.__blockWS = false`);
    await b.removeBeforeLoad(hook);
  }
});

test('what a worker writes to the memory file shows on an open cluster page without pressing 重新讀取 (the Hub says the file changed; the page reads it)', { skip }, async () => {
  const parent = await newKimi(S.repo);
  await idle(parent.id);
  const c = await dispatchFromScreen(parent, ['寫記憶的工作者']);
  await b.waitFor(`document.querySelector('.cluster-memory-text')?.textContent.includes('寫記憶的工作者')`);
  assert.ok(!(await b.eval(`document.querySelector('.cluster-memory-text').textContent`)).includes('WORKER_NOTE_LIVE'));
  // The worker appends to the file the way its brief tells it to (cat >> file), then finishes its turn.
  fs.appendFileSync(c.memory.path, '\n## w1 的筆記\n\n介面前綴改成 /v3 WORKER_NOTE_LIVE\n');
  const kid = await kidOf(c.workers[0].sessionId);
  hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  await until(async () => (await getCluster(c.id)).memory.bytes === fs.statSync(c.memory.path).size, 8000, 'the Hub knows the new size');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('WORKER_NOTE_LIVE')`, { timeout: 8000, label: 'the page shows what the worker wrote, by itself' });
  assert.match(await b.eval(`document.querySelector('.cluster-memory-meta').innerText`), new RegExp(`${fs.statSync(c.memory.path).size} B`), 'with the new size');
});

// ------------------------------------------------- a phone, and the dark look

const LOOK = (theme) => b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
async function openLook(hash, { width = 1280, height = 900, theme = 'light' } = {}) {
  await b.size(width, height, width < 700);
  await b.goto(`http://127.0.0.1:${hub.PORT}/#/`, 300);
  await LOOK(theme);
  await open(hash);
  await b.sleep(400);
}
const overflow = () => b.eval(`({ page: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth, wide: [...document.querySelectorAll('.cluster-page *, .cluster-dialog *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.cluster-memory-text, pre')).slice(0, 5).map((e) => e.className || e.tagName) })`);

test('on a phone (390) the dispatch dialog, the cluster page with its time bars and the merge result fit the screen with nothing cut off or scrolling sideways', { skip }, async () => {
  await openLook(`#/cluster/${S.c.id}`, { width: 390, height: 844 });
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2 && document.querySelector('.cluster-merge')`);
  let o = await overflow();
  assert.ok(o.page <= 0 && o.body <= 0, `no sideways scroll: ${JSON.stringify(o)}`);
  assert.deepEqual(o.wide, [], 'nothing sticks out past the right edge');
  const buttons = await b.eval(`[...document.querySelectorAll('.cluster-actions button')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= 0 && r.right <= innerWidth }; })`);
  assert.equal(buttons.length, 3, '全部停止, 合併, 清理');
  for (const bt of buttons) assert.ok(bt.inside && bt.h >= 24, `${bt.text} is whole and at least the 24 px a finger target needs (WCAG 2.2): ${JSON.stringify(bt)}`);
  await shot('18-cluster-page-390-light.png');
  await b.eval(`document.querySelector('.cluster-merge').scrollIntoView()`);
  await shot('19-merge-result-390-light.png');

  // A cluster that is running, for the banner on the main conversation.
  const { cluster: live } = await hub.api('POST', `/sessions/${S.p2.id}/cluster`, { tasks: [{ title: '手機上看的進行中叢集', prompt: '請處理' }, { title: '第二個', prompt: '請處理第二個' }] });
  await openLook(`#/s/${S.p2.id}`, { width: 390, height: 844 });
  await b.waitFor(`document.querySelector('.cluster-banner')`);
  o = await overflow();
  assert.ok(o.page <= 0, `the banner row fits: ${JSON.stringify(o)}`);
  await shot('20-main-banner-390-light.png');
  await b.click('.composer-input');
  await typeInto('.composer-input', '/cluster');
  await b.waitFor(`document.querySelector('.slash-menu .slash-item')`);
  await press('Enter');
  await b.waitFor(`document.querySelector('.cluster-dialog')`);
  await b.sleep(500);
  await b.click('[data-action="add-task"]');
  await fillTask(0, '手機上寫的任務', '在手機上也能派工');
  await fillTask(1, '', '第二個任務');
  o = await overflow();
  assert.ok(o.page <= 0 && o.body <= 0, `the dialog fits: ${JSON.stringify(o)}`);
  assert.deepEqual(o.wide, []);
  const submit = await b.eval(`(() => { const e = document.querySelector('.cluster-dialog button[type="submit"]'); e.scrollIntoView(); const r = e.getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1, h: Math.round(r.height), disabled: e.disabled }; })()`);
  assert.ok(submit.inside && submit.h >= 24 && !submit.disabled, `the send button can be reached and pressed: ${JSON.stringify(submit)}`);
  await shot('21-dialog-390-light.png');
  await b.eval(`document.querySelector('.cluster-dialog button[type="button"]:not([data-action])')?.click()`);
  for (const w of live.workers) {
    const kid = await kidOf(w.sessionId);
    hub.machine.reply(kid, prompts(kid)[0].body.prompt_id, '簡報');
  }
  await until(async () => (await getCluster(live.id)).status === 'done', 8000, 'the cluster done');
});

test('in the dark look the cluster page text can be read: the tiles, the drawer with its time bars and reasons, the merge result and the memory all keep their contrast', { skip }, async () => {
  const pageSels = ['.cluster-worker-title', '.cluster-merge-name', '.cluster-merge-branchname', '.cluster-memory-text', '.cluster-memory-path', '.cluster-head .om-badge', '.cluster-worker-state', '.cluster-merge .om-badge', '.cw-line', '.cw-gen'];
  const drawerSels = ['.cd-task', '.cluster-kv code', '.cluster-drawer .cluster-worker-progress', '.cluster-timing-total', '.cluster-legend-label', '.cluster-legend-value', '.cluster-reason', '.cluster-timing-facts', '.cluster-drawer .cluster-chip', '.cd-sec h3'];
  // The second worker's turn was written without times: its unmeasured parts.
  const unmeasuredSels = ['.cluster-legend li.unmeasured .cluster-legend-value', '.cluster-reason'];
  const check = async (theme, sels) => {
    for (const sel of sels) {
      const r = await b.eval(`(${CONTRAST_JS})(${JSON.stringify(sel)})`);
      assert.ok(r, `${theme}: ${sel} is on the page`);
      assert.ok(r.ratio >= 4.5, `${theme}: ${sel} contrast ${r.ratio.toFixed(2)} (text ${r.fg} on ${r.bg})`);
    }
  };
  for (const theme of ['dark', 'light']) {
    await openLook(`#/cluster/${S.c.id}`, { theme });
    await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2 && document.querySelector('.cluster-merge') && document.querySelector('.cluster-memory-text')?.textContent`);
    const bg = await b.eval(`getComputedStyle(document.body).backgroundColor`);
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    if (theme === 'dark') assert.ok(lum(bg) < 0.25, `the page is dark: ${bg}`);
    else assert.ok(lum(bg) > 0.6, `the page is light: ${bg}`);
    await check(theme, pageSels);
    if (theme === 'dark') {
      await shot('22-cluster-page-1280-dark.png');
      await b.eval(`document.querySelector('.cluster-merge').scrollIntoView()`);
      await shot('23-merge-result-1280-dark.png');
    }
    // The drawer of the first worker: its whole task, where it works, its time with the reasons.
    await page.openDrawer(S.c.workers[0].sessionId);
    await b.waitFor(`!document.querySelector('.cluster-drawer [data-sec="time"] .cluster-timing-loading')`, { timeout: 8000 });
    await check(theme, drawerSels);
    // The coloured parts of the bar are told apart from the track they sit on.
    const segs = await b.eval(`[...document.querySelectorAll('.cluster-drawer .cluster-bar [data-seg]')].map((s) => getComputedStyle(s).backgroundColor + '|' + getComputedStyle(s).backgroundImage.slice(0, 30))`);
    assert.equal(new Set(segs).size, 4, `${theme}: four different looks for the four parts: ${JSON.stringify(segs)}`);
    if (theme === 'dark') await shot('22b-cluster-drawer-1280-dark.png');
    await page.closeDrawer();
    await page.openDrawer(S.c.workers[1].sessionId);
    await b.waitFor(`!document.querySelector('.cluster-drawer [data-sec="time"] .cluster-timing-loading')`, { timeout: 8000 });
    await check(theme, unmeasuredSels);
    await page.closeDrawer();
  }
  await LOOK('light');
});

// ------------------------------------------------- the computer goes away and comes back

test('the computer goes off: the dispatch says so instead of opening, memory / merge say why they cannot, the status still reads; when it is back the same buttons work', { skip }, async () => {
  const c = S.c3; // stopped, two workers cut off, never merged
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  hub.machine.close();
  await until(async () => !(await hub.api('GET', '/machines')).find((m) => m.id === MID).online, 8000, 'the machine offline');

  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2`);
  await b.waitFor(`document.querySelector('.cluster-memory-none') && !document.querySelector('.cluster-memory-none').hidden`);
  const none = await b.eval(`document.querySelector('.cluster-memory-none').innerText`);
  assert.match(none, /讀不到叢集記憶/);
  assert.match(none, /離線/, 'with the Hub\'s reason');
  assert.equal((await getCluster(c.id)).status, 'stopped', 'the status itself needs no computer');
  assert.equal(await b.eval(`document.querySelector('[data-field="status"]').innerText.trim()`), '已停止');

  await typeInto('textarea[name="decision"]', '離線時寫的決定');
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory .cluster-error')?.innerText.trim()`);
  assert.match(await b.eval(`document.querySelector('.cluster-memory .cluster-error').innerText`), /離線/);
  assert.equal(await b.eval(`document.querySelector('textarea[name="decision"]').value`), '離線時寫的決定', 'what was typed is kept for another try');

  const mergedBranch = `cluster/${c.id}/merged`;
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-head .cluster-error')`);
  assert.match(await b.eval(`document.querySelector('.cluster-head .cluster-error').innerText`), /離線/);
  assert.equal(git(S.repo, 'branch', '--list', mergedBranch), '');
  assert.equal((await getCluster(c.id)).merge, null);
  assert.equal(await b.eval(`document.querySelector('[data-field="status"]').innerText.trim()`), '已停止', 'not stuck in 合併中');
  assert.equal(await b.eval(`document.querySelector('[data-action="merge"]').disabled`), false);
  await shot('25-cluster-offline-1280-light.png');

  // The dispatch on the main conversation: said, not opened.
  await open(`#/s/${S.parent.id}`);
  await b.waitFor(`document.querySelector('.composer-input')`);
  await typeInto('.composer-input', '/cluster');
  await press('Enter');
  await b.waitFor(`document.body.innerText.includes('離線')`);
  assert.equal(await b.eval(`Boolean(document.querySelector('.cluster-dialog'))`), false);
  await b.eval(`document.querySelector('.composer-input').select?.()`);
  await b.send('Input.insertText', { text: '' });

  // It comes back (a connector that reconnects): the page's own buttons work again, no reload of the Hub needed.
  hub.machine = startFakeMachine({ port: hub.PORT, key, id: MID });
  await hub.machine.ready;
  await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID)?.online, 8000, 'the machine back');
  hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelector('.cluster-memory-text') && !document.querySelector('.cluster-memory-text').hidden && document.querySelector('.cluster-memory-text').textContent.length > 0`, { label: 'the memory reads again' });
  await typeInto('textarea[name="decision"]', '回來之後寫的決定 BACK_ONLINE');
  await b.click('[data-action="add-memory"]');
  await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('BACK_ONLINE')`);
  await b.click('[data-action="merge"]');
  await confirm();
  await b.waitFor(`document.querySelector('.cluster-merge')`, { timeout: 15000 });
  assert.equal(await b.eval(`document.querySelectorAll('.cluster-merge-list > li[data-ok="true"]').length`), 2);
  assert.notEqual(git(S.repo, 'branch', '--list', mergedBranch), '');
});

test('the Hub restarts while a cluster page is open: the page says 離線, comes back by itself, asks for the cluster again, and the cluster (workers, merge result, memory) is what it was', { skip }, async () => {
  const c = S.c;
  await open(`#/cluster/${c.id}`);
  await b.waitFor(`document.querySelectorAll('.cluster-worker').length === 2 && document.querySelector('.cluster-merge') && document.querySelector('.cluster-memory-text')?.textContent.length > 0`);
  const before = { cards: (await cards()).map((x) => [x.session, x.title, x.state, x.branch]), memory: await b.eval(`document.querySelector('.cluster-memory-text').textContent`), merge: await b.eval(`document.querySelector('.cluster-merge').innerText`) };
  const asked = [];
  const stopListening = b.on('Network.requestWillBeSent', (p) => asked.push({ url: p.request.url, at: Date.now() }));
  const key = JSON.parse(fs.readFileSync(path.join(hub.DATA, 'hub.json'), 'utf8')).bridgeKey;
  await hub.halt(); // the Hub writes what it holds on SIGTERM, and is gone
  await b.waitFor(`document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 10000, label: 'the page says it is offline' });
  assert.equal((await cards()).length, 2, 'the page keeps showing what it had');
  await shot('28-hub-gone-1280-light.png');

  // The same Hub folder and port again, as a restart is.
  const restartedAt = Date.now();
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(hub.PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: hub.DATA, AGENT_HUB_WORKSPACES: path.join(hub.TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: hub.gateway.url }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let log = '';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the Hub did not start again:\n${log}`)), 30000);
      const on = (d) => {
        log += d;
        if (log.includes('已啟動')) (clearTimeout(t), resolve());
      };
      proc.stdout.on('data', on);
      proc.stderr.on('data', on);
    });
    hub.machine = startFakeMachine({ port: hub.PORT, key, id: MID });
    hub.machine.shEnv = { ...GIT_ENV, HOME: hub.TMP };
    await hub.machine.ready;
    await b.waitFor(`!document.querySelector('.sidebar')?.innerText.includes('離線')`, { timeout: 30000, label: 'the page is back online by itself' });
    await until(async () => asked.some((r) => r.at >= restartedAt && r.url.endsWith(`/api/clusters/${c.id}`)), 15000, 'the page asking for the cluster again');
    // The cluster is what it was: the Hub kept it on disk.
    const after = await getCluster(c.id);
    assert.equal(after.id, c.id);
    assert.deepEqual(after.merge.results.map((r) => r.ok), [true, true]);
    assert.deepEqual(after.workers.map((w) => w.sessionId), c.workers.map((w) => w.sessionId));
    assert.deepEqual((await cards()).map((x) => [x.session, x.title, x.state, x.branch]), before.cards);
    assert.equal(await b.eval(`document.querySelector('.cluster-merge').innerText`), before.merge);
    assert.equal(await b.eval(`document.querySelector('.cluster-memory-text').textContent`), before.memory);
    // And it is usable: a decision from the page reaches the file through the new Hub.
    await until(async () => (await hub.api('GET', '/machines')).find((m) => m.id === MID)?.online, 10000, 'the machine back');
    await b.click('[data-action="reload-memory"]');
    await typeInto('textarea[name="decision"]', '重啟之後寫的決定 AFTER_RESTART');
    await b.click('[data-action="add-memory"]');
    await b.waitFor(`document.querySelector('.cluster-memory-text').textContent.includes('AFTER_RESTART')`);
    assert.ok(fs.readFileSync(c.memory.path, 'utf8').includes('AFTER_RESTART'));
  } finally {
    stopListening();
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([gone, wait(8000)]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});
