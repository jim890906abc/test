// What the cluster screens (cluster.js) need to decide, kept free of the DOM so
// it can be tested directly in node: what a dispatch sends (spec §2), what keeps
// it from being sent, how far a cluster is, and how the timing figures (spec §5)
// are laid out.
//
// The rule that shapes the timing part: a figure the Hub did not measure is
// shown as 量不到 with the reason the Hub gave. This file never works one out from
// the others, never fills a gap, and never gives the part of the total that no
// field accounts for a name of its own (the owner, 2026-10-21: no estimating).

export const CLUSTER_MAX_TASKS = 8;
export const CLUSTER_DEFAULTS = Object.freeze({ mode: 'brief', isolate: true, swarm: true });
export const CLUSTER_MODES = ['brief', 'fork'];
// From this share of the main conversation's context on, a full fork is a poor start (spec §2).
export const FORK_CONTEXT_WARN = 0.5;

// --------------------------------------------------------------- dispatch

// A task without a name is named after the first line of what it says.
const TITLE_MAX = 30;
export function titleFromPrompt(prompt) {
  const line = String(prompt ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  const chars = Array.from(line);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : line;
}

// What a person has to fix before the dispatch can be sent (an empty list: send).
export function draftProblems(draft) {
  const problems = [];
  const tasks = Array.isArray(draft?.tasks) ? draft.tasks : [];
  if (!CLUSTER_MODES.includes(draft?.mode)) problems.push('起跑方式要選「簡報起跑」或「完整分叉」');
  if (!tasks.length) problems.push('至少要有 1 個任務');
  if (tasks.length > CLUSTER_MAX_TASKS) problems.push(`一次最多 ${CLUSTER_MAX_TASKS} 個任務`);
  tasks.forEach((t, i) => {
    if (!String(t?.prompt ?? '').trim()) problems.push(`任務 ${i + 1} 還沒寫要做什麼`);
  });
  return problems;
}

// The body of POST /api/sessions/:id/cluster (spec §2). `note` goes only when there is one.
export function requestBody(draft) {
  const body = {
    tasks: draft.tasks.map((t) => {
      const prompt = String(t.prompt ?? '').trim();
      return { title: String(t.title ?? '').trim() || titleFromPrompt(prompt), prompt };
    }),
    mode: draft.mode,
    isolate: Boolean(draft.isolate),
    swarm: Boolean(draft.swarm),
  };
  const note = String(draft.note ?? '').trim();
  if (note) body.note = note;
  return body;
}

// Said in the dialog before anything is sent. `context` is the conversation's
// own { used, size }; without it nothing is said about it.
export function contextWarnings({ mode, isolate, context, busy } = {}) {
  const out = [];
  if (isolate === false) out.push('沒有獨立 worktree：所有工作者共用同一個資料夾，改到同一批檔案時可能互相覆蓋，也沒有分支可以合併。');
  // The Hub refuses a full fork of a conversation that is in the middle of a turn.
  if (mode === 'fork' && busy) out.push('主對話現在正在工作：完整分叉要等它閒下來才能開始（簡報起跑沒有這個限制）。');
  if (mode === 'fork' && context?.size > 0 && context.used / context.size >= FORK_CONTEXT_WARN) {
    const pct = Math.round((context.used / context.size) * 100);
    out.push(`主對話的上下文已用 ${pct}%（${Math.round(FORK_CONTEXT_WARN * 100)}% 以上建議改用「簡報起跑」）：完整分叉會讓每個工作者都帶著這麼長的歷史開工，每一個都先花一輪額度去讀它。`);
  }
  return out;
}

// ----------------------------------------------------------------- state

const CLUSTER_STATUS = { starting: '啟動中', running: '進行中', merging: '合併中', done: '已完成', stopped: '已停止', error: '出錯' };
export const clusterStatusLabel = (status) => CLUSTER_STATUS[status] || String(status ?? '');
export const isActive = (cluster) => ['starting', 'running', 'merging'].includes(cluster?.status);
// A cluster stop can still do something for: workers are working or about to.
export const isStoppable = (cluster) => ['starting', 'running'].includes(cluster?.status);

// "x/y 完成": workers that have a finish time and neither failed nor had their
// conversation deleted, over all workers. A worker that stopped with an error has
// finished but is not 完成; a deleted one is gone. Each is counted on its own.
export function progressOf(cluster) {
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  const is = (status) => workers.filter((w) => w?.status === status).length;
  return { done: workers.filter((w) => w?.finishedAt && w.status !== 'error' && w.status !== 'deleted').length, total: workers.length, failed: is('error'), deleted: is('deleted') };
}

// A worker is a conversation, so it has that conversation's status; a finish
// time turns a quiet one into 已完成, but never hides a failure.
export function workerState(w) {
  switch (w?.status) {
    case 'running':
      return { label: '執行中', tone: 'busy' };
    case 'awaiting_permission':
      return { label: '等你核准', tone: 'warn' };
    case 'error':
      return { label: '出錯', tone: 'danger' };
    case 'deleted':
      return { label: '已刪除', tone: 'idle' };
    case 'idle':
      return w.finishedAt ? { label: '已完成', tone: 'ok' } : { label: '閒置', tone: 'idle' };
    default:
      return { label: String(w?.status ?? ''), tone: 'idle' };
  }
}

// ----------------------------------------------------------- merge, memory

// Whether the merge button works, and what to say either way (its tooltip, and
// the line under the buttons when the reason is a lasting one). The Hub merges
// once per cluster: a second press is refused (409), so it is not offered.
export function mergeAvailability(cluster, busy = false) {
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  if (!cluster?.isolate || !workers.some((w) => w?.branch)) return { ok: false, why: '沒有獨立 worktree，沒有分支可以合併' };
  if (cluster.merge) return { ok: false, why: '已經合併過了：第一版不支援重新合併，結果在下面' };
  if (cluster.status === 'merging') return { ok: false, why: '正在合併' };
  if (cluster.status === 'starting') return { ok: false, why: '工作者還在啟動' };
  if (busy) return { ok: false, why: '上一個操作還沒完成' };
  const unfinished = workers.filter((w) => !w?.finishedAt && w?.status !== 'deleted').length;
  return { ok: true, why: unfinished ? `還有 ${unfinished} 個工作者沒做完；現在合併只會合進它們已 commit 的內容` : '把各工作者的分支合進一個新分支' };
}

// --------------------------------------------------------------- clean up

// A worker is working: the Hub refuses to clean up under it (409).
const isWorking = (w) => w?.status === 'running' || w?.status === 'awaiting_permission';

// Everything the last clean-up was meant to take away is gone and every worker
// that has a conversation is off the sidebar: pressing it again would do nothing.
function isCleanedUp(cluster) {
  const results = cluster?.cleanup?.results;
  if (!Array.isArray(results) || !results.length) return false;
  const workers = Array.isArray(cluster.workers) ? cluster.workers : [];
  return results.every((r) => {
    const deleted = workers.find((w) => w?.sessionId === r.sessionId)?.status === 'deleted';
    return r.worktree !== 'kept' && r.branch !== 'kept' && (r.hidden || deleted);
  });
}

// Whether the 清理 button works, and what to say either way. What the Hub
// would refuse is not offered; what it would do is said in the tooltip.
export function cleanupAvailability(cluster, busy = false) {
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  if (!workers.length) return { ok: false, why: '沒有工作者可以清理' };
  if (busy) return { ok: false, why: '上一個操作還沒完成' };
  if (cluster.status === 'starting') return { ok: false, why: '工作者還在啟動' };
  if (cluster.status === 'merging') return { ok: false, why: '正在合併' };
  if (workers.some(isWorking)) return { ok: false, why: '工作者還在跑，先全部停止' };
  if (isCleanedUp(cluster)) return { ok: false, why: '已經清理乾淨了：沒有留下可以再清的 worktree、分支或側欄對話' };
  if (!cluster.isolate) return { ok: true, why: '工作者共用同一個資料夾，沒有 worktree 或分支要清；只把工作者對話從側欄收起' };
  return {
    ok: true,
    why: cluster.merge ? '移除乾淨的 worktree、刪除已經併進合併分支的工作者分支、把工作者對話從側欄收起；有未提交修改或沒併進去的會保留' : '還沒合併過：只清掉沒有任何新 commit 的 worktree 與分支；有 commit 的會保留',
  };
}

// GET /clusters/:id/cleanup/plan laid out for the confirmation: per worker what
// will be done and what is kept (with why), and the counts of what will really
// happen (a worktree that was already gone is not "removed" by this).
export function cleanupPlanView(plan, workers = []) {
  const results = Array.isArray(plan?.results) ? plan.results : [];
  const acts = new Map((Array.isArray(plan?.actions) ? plan.actions : []).map((a) => [a.sessionId, a]));
  const titleOf = (sid) => (Array.isArray(workers) ? workers : []).find((w) => w?.sessionId === sid)?.title || sid;
  const rows = results.map((r) => {
    const a = acts.get(r.sessionId) || {};
    return {
      sessionId: r.sessionId,
      title: titleOf(r.sessionId),
      will: [a.removeWorktree ? '移除 worktree' : null, a.deleteBranch ? '刪除分支' : null, a.hide ? '從側欄收起對話' : null].filter(Boolean),
      keeps: r.worktree === 'kept' || r.branch === 'kept',
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
    };
  });
  const count = (key) => [...acts.values()].filter((a) => a[key]).length;
  const totals = { worktrees: count('removeWorktree'), branches: count('deleteBranch'), hidden: count('hide'), kept: rows.filter((r) => r.keeps).length };
  return { rows, totals, nothing: !totals.worktrees && !totals.branches && !totals.hidden };
}

// One worker's entry of cluster.cleanup.results in the words of the screen. A
// worker with no worktree of its own (a shared folder) has nothing to say about one.
export function cleanupResultView(r) {
  if (!r) return null;
  const part = (state, done) => (state === 'kept' ? { text: '保留', kept: true } : state === done ? { text: done === 'removed' ? '已移除' : '已刪除', kept: false } : null);
  const worktree = part(r.worktree, 'removed');
  const branch = part(r.branch, 'deleted');
  return { worktree, branch, hidden: Boolean(r.hidden), reasons: Array.isArray(r.reasons) ? r.reasons : [], kept: Boolean(worktree?.kept || branch?.kept) };
}

// The most one decision may be (the Hub answers 400 above it).
export const MEMORY_MAX_CHARS = 20_000;

export function fmtBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`;
}

// The Hub sends only the last part of a very large memory file (`truncated`,
// and `from`, where that part starts).
export function memoryNote(m) {
  if (!m?.truncated) return null;
  const where = Number.isFinite(m.from) ? `，這裡從第 ${m.from} 個位元組起` : '';
  const size = Number.isFinite(m.bytes) && m.bytes > 0 ? `檔案共 ${fmtBytes(m.bytes)}` : '檔案很大';
  return `只顯示最後一段（${size}${where}）；完整內容在上面的路徑。`;
}

// ---------------------------------------------------------------- timing

// The four parts the bar draws, in the order they are drawn.
export const TIMING_PARTS = [
  ['modelMs', '模型'],
  ['toolMs', '工具'],
  ['rateLimitWaitMs', '等限流'],
  ['compactMs', '壓縮'],
];
const FIELD_LABELS = { wallMs: '總時間', ...Object.fromEntries(TIMING_PARTS), turns: '回合', requests: '請求', http429: '429 次數', subagents: '子代理', since: '起算時間', requestsSince: '請求紀錄起算' };

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isMoment = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && !Number.isNaN(new Date(v).getTime());

// A moment the Hub sent (epoch milliseconds) as a local date and time to the
// second, "2026-10-29 14:03:22". The number written as a date, nothing else.
export function fmtStamp(ms) {
  if (!isMoment(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 59.9 秒, 3 分 12 秒, 1 小時 2 分. Never rounds up into the next unit.
export function fmtMs(ms) {
  if (!isCount(ms)) return null;
  if (ms < 60_000) return ms === 0 ? '0 秒' : `${(Math.floor(ms / 100) / 10).toFixed(1)} 秒`;
  const s = Math.floor(ms / 1000);
  const hr = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  return hr ? `${hr} 小時 ${min} 分` : `${min} 分 ${s % 60} 秒`;
}

// The Hub's `unmeasured` entries are "欄位：原因". Those about a field the bar
// draws belong to that field; any other is kept, as said, in `notes`.
function readUnmeasured(list) {
  const byKey = new Map();
  const notes = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const line = String(raw);
    const m = line.match(/^\s*([A-Za-z_][\w.]*)\s*[：:]\s*([\s\S]*)$/);
    if (!m) notes.push(line);
    else if (TIMING_PARTS.some(([k]) => k === m[1]) || m[1] === 'wallMs') byKey.set(m[1], m[2].trim());
    else notes.push(`${FIELD_LABELS[m[1].split('.')[0]] || m[1]}：${m[2].trim()}`);
  }
  return { byKey, notes };
}

// GET /api/sessions/:id/timing laid out for the bar. `error`: the request failed.
// → { segments: [{ key, label, ms|null, share|null, reason|null }], total: { ms|null, reason|null },
//     facts: [[label, count]]  (only the counts the Hub reported: the cluster card's line),
//     counts: [{ key, label, n|null }]  (every count, null where the Hub did not report it),
//     coverage: [{ key, label, ms|null }]  (from when the figures, and the request records, cover),
//     notes: [string], failed: string|null }
export function timingView(timing, error = null) {
  if (!timing || typeof timing !== 'object') {
    const failed = error ? error.message || String(error) : '伺服器沒有回報這個對話的耗時';
    return { segments: [], total: { ms: null, reason: failed }, facts: [], counts: [], coverage: [], notes: [], failed };
  }
  const { byKey, notes } = readUnmeasured(timing.unmeasured);
  const missing = (v) => (v === undefined ? '伺服器沒有回報這個欄位' : '回報的值不是有效的時間');
  const part = (key, label) => {
    const v = timing[key];
    const ms = isCount(v) ? v : null;
    return { key, label, ms, share: null, reason: ms === null ? byKey.get(key) || missing(v) : null };
  };
  const segments = TIMING_PARTS.map(([key, label]) => part(key, label));
  const wall = part('wallMs', FIELD_LABELS.wallMs);
  const total = { ms: wall.ms, reason: wall.reason };
  // The bar is the reported parts over the reported total. When the total is
  // missing, or smaller than the parts (clocks that overlap), over the parts
  // themselves. The rest of the track stays empty: it is not named or summed.
  const sum = segments.reduce((a, s) => a + (s.ms ?? 0), 0);
  const whole = total.ms !== null && total.ms >= sum ? total.ms : sum;
  for (const s of segments) s.share = s.ms === null ? null : whole > 0 ? s.ms / whole : 0;
  const sub = timing.subagents && typeof timing.subagents === 'object' ? timing.subagents : {};
  const counts = [
    ['turns', '回合', timing.turns],
    ['requests', '請求', timing.requests],
    ['http429', '429 次數', timing.http429],
    ['spawned', '子代理', sub.spawned],
    ['requeued', '子代理限流重排', sub.requeuedForRateLimit],
  ].map(([key, label, v]) => ({ key, label, n: isCount(v) ? v : null }));
  const facts = counts.filter((c) => c.n !== null).map((c) => [c.label, c.n]);
  const coverage = ['since', 'requestsSince'].map((key) => ({ key, label: FIELD_LABELS[key], ms: isMoment(timing[key]) ? timing[key] : null }));
  return { segments, total, facts, counts, coverage, notes, failed: null };
}
