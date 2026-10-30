// What the cluster screens (cluster.js) need to decide, kept free of the DOM so
// it can be tested directly in node: what a dispatch sends (spec §2), what keeps
// it from being sent, how far a cluster is, and how the timing figures (spec §5)
// are laid out.
//
// The rule that shapes the timing part: a figure the Hub did not measure is
// shown as 量不到 with the reason the Hub gave. This file never works one out from
// the others, never fills a gap, and never gives the part of the total that no
// field accounts for a name of its own (the owner, 2026-10-21: no estimating).

// More tasks than workers is fine: a worker that finishes one is given the next
// (the queue). So the two limits are separate: how many tasks, how many workers.
export const CLUSTER_MAX_TASKS = 64;
export const CLUSTER_MAX_WORKERS = 8;
// By default as many workers as tasks, but not more than this (every worker is a conversation that spends quota).
export const CLUSTER_DEFAULT_WORKER_CAP = 4;
export const CLUSTER_DEFAULTS = Object.freeze({ mode: 'brief', isolate: true, swarm: true });
export const CLUSTER_MODES = ['brief', 'fork'];
// From this share of the main conversation's context on, a full fork is a poor start (spec §2).
export const FORK_CONTEXT_WARN = 0.5;

// --------------------------------------------------------------- the name

// A cluster has a name of its own (never the main conversation's title: several
// clusters are sent from one conversation and would all read the same). Given
// by the person when it is sent, else made from its tasks: one task is named
// after it, several after the first (cut to about 24 characters) and how many
// there are. The Hub and the dispatch dialog use this one function, so what
// the dialog shows as the suggestion is what the Hub will call it.
export const CLUSTER_NAME_MAX = 60;
const NAME_FIRST_MAX = 24;
const cutChars = (text, n) => {
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : text;
};
export const cleanClusterName = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim();
export function autoClusterName(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const first = cleanClusterName(list[0]?.title);
  if (!first) return '';
  return list.length <= 1 ? cutChars(first, CLUSTER_NAME_MAX) : `${cutChars(first, NAME_FIRST_MAX)} 等 ${list.length} 條`;
}

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

// How many workers a dispatch of `taskCount` tasks opens when the person has not said.
export const defaultWorkers = (taskCount) => Math.max(1, Math.min(Number(taskCount) || 1, CLUSTER_DEFAULT_WORKER_CAP));

// The worker count that is really sent: what the person chose (a whole number
// from 1 to 8), or the default; never more than there are tasks, because a
// worker with no task would only sit there.
export function workersFor(draft) {
  const n = Array.isArray(draft?.tasks) ? draft.tasks.length : 0;
  const chosen = draft?.workers;
  const asked = Number.isInteger(chosen) && chosen >= 1 && chosen <= CLUSTER_MAX_WORKERS ? chosen : defaultWorkers(n);
  return Math.max(1, Math.min(asked, n || 1));
}

// What a person has to fix before the dispatch can be sent (an empty list: send).
export function draftProblems(draft) {
  const problems = [];
  const tasks = Array.isArray(draft?.tasks) ? draft.tasks : [];
  if (!CLUSTER_MODES.includes(draft?.mode)) problems.push('起跑方式要選「簡報起跑」或「完整分叉」');
  if (!tasks.length) problems.push('至少要有 1 個任務');
  if (tasks.length > CLUSTER_MAX_TASKS) problems.push(`一次最多 ${CLUSTER_MAX_TASKS} 個任務`);
  if (Array.from(cleanClusterName(draft?.name)).length > CLUSTER_NAME_MAX) problems.push(`叢集名稱最多 ${CLUSTER_NAME_MAX} 個字`);
  if (draft?.workers !== undefined && draft?.workers !== null && (!Number.isInteger(draft.workers) || draft.workers < 1 || draft.workers > CLUSTER_MAX_WORKERS)) problems.push(`工作者數要是 1 到 ${CLUSTER_MAX_WORKERS} 的整數`);
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
    workers: workersFor(draft),
  };
  const note = String(draft.note ?? '').trim();
  if (note) body.note = note;
  const name = cleanClusterName(draft.name);
  if (name) body.name = name;
  return body;
}

// Many tasks pasted at once: one task per line. Blank lines are skipped, and a
// list marker the line was copied with ("- ", "* ", "1. ", "2) ", "• ") is not
// part of the task. A line is the task's whole text; its name is made from it.
const LIST_MARK = /^\s*(?:[-*•‧·]|\d{1,3}[.)、])\s+/;
export function parseTaskLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(LIST_MARK, '').trim())
    .filter(Boolean)
    .map((prompt) => ({ title: titleFromPrompt(prompt), prompt }));
}

// What the dialog suggests, from the task list alone. Only a suggestion: it
// never changes what the person chose, and it is made from the words of the
// tasks (so it can be wrong - it says "看起來").
//   · 3 tasks or fewer: a cluster costs more than it saves; do it in this conversation.
//   · many tasks that all only read: Kimi's own swarm mode in ONE conversation sends them all at once.
//   · tasks that change files while the workers share one folder: give each its own worktree.
const WRITES = /修改|修正|修復|修掉|改成|改寫|改為|重構|重寫|新增|加上|加入|實作|實現|寫入|寫一個|刪除|移除|產生|生成|建立|更新|升級|遷移|commit|fix\b|implement|refactor|rewrite|write\b|create\b|delete\b|remove\b|edit\b|patch\b|migrate|update\b|add\b/i;
const READS = /審查|檢查|審視|審閱|閱讀|讀取|分析|列出|盤點|調查|查看|查出|找出|掃描|比對|研究|說明|總結|摘要|review|audit|inspect|read\b|analy[sz]e|list\b|scan|summari[sz]e|explain|find\b|check\b/i;
export const FEW_TASKS = 3;
export const MANY_READONLY = 5;
export const looksLikeWriting = (task) => WRITES.test(`${task?.title ?? ''} ${task?.prompt ?? ''}`);
export const looksReadOnly = (task) => READS.test(`${task?.title ?? ''} ${task?.prompt ?? ''}`) && !looksLikeWriting(task);
export function queueAdvice({ tasks, isolate } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => String(t?.prompt ?? '').trim());
  const out = [];
  if (!list.length) return out;
  if (list.length <= FEW_TASKS) out.push({ id: 'few', text: `任務很少（${list.length} 條），直接在這個對話做通常最快：叢集要另外開對話、讀簡報，多花的時間和額度不一定賺得回來。` });
  if (list.length >= MANY_READONLY && list.every(looksReadOnly)) out.push({ id: 'readonly-swarm', text: `這 ${list.length} 條看起來都是只讀的同類任務：也可以在單一對話用 Kimi 原生的 Swarm 模式一次派出，不用另外開工作者。` });
  if (isolate === false && list.some(looksLikeWriting)) out.push({ id: 'isolate', text: '有任務看起來要改檔，而工作者共用同一個資料夾：建議每個工作者獨立 worktree，才不會互相覆蓋。' });
  return out;
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

const CLUSTER_STATUS = { starting: '啟動中', running: '進行中', merging: '合併中', purging: '清除中', done: '已完成', stopped: '已停止', error: '出錯' };
export const clusterStatusLabel = (status) => CLUSTER_STATUS[status] || String(status ?? '');
export const isActive = (cluster) => ['starting', 'running', 'merging'].includes(cluster?.status);
// A cluster stop can still do something for: workers are working or about to.
export const isStoppable = (cluster) => ['starting', 'running'].includes(cluster?.status);

// "任務 x/y 完成". With the queue it counts TASKS (what is done, over all
// tasks; a task that failed is counted on its own, not as done). A cluster that
// came without tasks (an older Hub) is counted the way it always was: workers
// that have a finish time and neither failed nor had their conversation deleted.
export function progressOf(cluster) {
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  const deleted = workers.filter((w) => w?.status === 'deleted').length;
  const tasks = Array.isArray(cluster?.tasks) ? cluster.tasks : [];
  if (tasks.length) {
    const is = (status) => tasks.filter((t) => t?.status === status).length;
    return { done: is('done'), total: tasks.length, failed: is('failed'), deleted };
  }
  const is = (status) => workers.filter((w) => w?.status === status).length;
  return { done: workers.filter((w) => w?.finishedAt && w.status !== 'error' && w.status !== 'deleted').length, total: workers.length, failed: is('error'), deleted };
}

// ------------------------------------------------------------- the queue

// "2 條失敗" for a cluster that counts tasks, "2 個出錯" for one that counts workers.
export const failedText = (cluster, n) => (Array.isArray(cluster?.tasks) && cluster.tasks.length ? `${n} 條失敗` : `${n} 個出錯`);

const TASK_STATUS = {
  pending: { label: '等待中', tone: 'idle' },
  running: { label: '進行中', tone: 'busy' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失敗', tone: 'danger' },
};
export const taskStatus = (status) => TASK_STATUS[status] || { label: String(status ?? ''), tone: 'idle' };

// The queue as the cluster page lists it: per task its state, who is doing or
// did it, and the Hub's own times (the moment it was handed over, the moment
// the Hub saw that worker go quiet; the length is the one minus the other, both
// measured). `workerNo` is the worker's place in the cluster ("w1").
export function queueView(cluster) {
  const tasks = Array.isArray(cluster?.tasks) ? cluster.tasks : [];
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  const rows = tasks.map((t) => {
    const at = workers.findIndex((w) => w?.sessionId === t.workerSessionId);
    const st = taskStatus(t.status);
    const started = fmtStamp(t.startedAt);
    const ended = fmtStamp(t.finishedAt);
    const span = isMoment(t.startedAt) && isMoment(t.finishedAt) && t.finishedAt >= t.startedAt ? fmtMs(t.finishedAt - t.startedAt) : null;
    return {
      index: t.index,
      no: (Number.isInteger(t.index) ? t.index : 0) + 1,
      title: t.title,
      status: t.status,
      label: st.label,
      tone: st.tone,
      workerNo: at >= 0 ? at + 1 : null,
      workerTitle: at >= 0 ? workers[at].title : null,
      started,
      ended,
      span,
      attempts: Number.isInteger(t.attempts) ? t.attempts : 0,
      // Handed back to the queue once already, whatever it is now.
      handedBack: (t.attempts || 0) > 1 || (t.status === 'pending' && (t.attempts || 0) > 0),
      error: t.error || null,
    };
  });
  const count = (status) => rows.filter((r) => r.status === status).length;
  const sum = { total: rows.length, done: count('done'), running: count('running'), pending: count('pending'), failed: count('failed') };
  // A stop ends the dispatching for good: tasks still waiting then were never sent.
  const neverSent = cluster?.status === 'stopped' ? sum.pending : 0;
  return { rows, sum, neverSent };
}

// One worker's line about the queue: the task it is on, how many it has done.
export function workerQueueLine(w, cluster) {
  const tasks = Array.isArray(cluster?.tasks) ? cluster.tasks : [];
  if (!tasks.length) return null;
  const current = Number.isInteger(w?.taskIndex) ? tasks.find((t) => t.index === w.taskIndex) : null;
  const done = Number.isInteger(w?.done) ? w.done : 0;
  const parts = [];
  if (current) parts.push(`正在做第 ${current.index + 1}/${tasks.length} 條「${current.title}」`);
  else parts.push(w?.status === 'deleted' ? '對話已刪除' : tasks.some((t) => t.status === 'pending') && cluster?.status !== 'stopped' ? '等待下一條' : '手上沒有任務');
  parts.push(`已完成 ${done} 條`);
  return parts.join(' · ');
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
  if (cluster.status === 'purging') return { ok: false, why: '正在完全清除' };
  if (cluster.status === 'starting') return { ok: false, why: '工作者還在啟動' };
  if (busy) return { ok: false, why: '上一個操作還沒完成' };
  const tasks = Array.isArray(cluster?.tasks) ? cluster.tasks : [];
  if (tasks.length) {
    const open = tasks.filter((t) => t?.status === 'pending' || t?.status === 'running').length;
    const failed = tasks.filter((t) => t?.status === 'failed').length;
    if (open || failed) return { ok: true, why: `${[open ? `還有 ${open} 條任務沒做完` : '', failed ? `${failed} 條任務失敗或被中斷` : ''].filter(Boolean).join('、')}；現在合併只會合進各工作者已 commit 的內容${open ? '，之後做完的要另外再合' : ''}` };
    return { ok: true, why: '把各工作者的分支合進一個新分支' };
  }
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
  if (cluster.status === 'purging') return { ok: false, why: '正在完全清除' };
  if (workers.some(isWorking)) return { ok: false, why: '工作者還在跑，先全部停止' };
  // Tasks still waiting (or handed out and not ended) count as work, unless a stop ended the dispatching.
  if (cluster.status !== 'stopped' && (Array.isArray(cluster.tasks) ? cluster.tasks : []).some((t) => t?.status === 'pending' || t?.status === 'running')) return { ok: false, why: '佇列還有任務沒做完：等它們做完，或先全部停止' };
  if (isCleanedUp(cluster)) return { ok: false, why: '已經清理乾淨了：沒有留下可以再清的 worktree、分支或側欄對話' };
  if (!cluster.isolate) return { ok: true, why: '工作者共用同一個資料夾，沒有 worktree 或分支要清；只把工作者對話從側欄收起' };
  return {
    ok: true,
    why: cluster.merge ? '移除乾淨的 worktree、刪除已經併進合併分支的工作者分支、把工作者對話從側欄收起；有未提交修改或沒併進去的會保留' : '還沒合併過：只清掉沒有任何新 commit 的 worktree 與分支；有 commit 的會保留',
  };
}

// Whether 完全清除 works, and what to say either way (the Hub says 409 to the
// same cases). A cluster that is over - done, stopped, or failed - can be purged.
export function purgeAvailability(cluster, busy = false) {
  const workers = Array.isArray(cluster?.workers) ? cluster.workers : [];
  if (!cluster) return { ok: false, why: '' };
  if (busy) return { ok: false, why: '上一個操作還沒完成' };
  if (cluster.status === 'starting') return { ok: false, why: '工作者還在啟動' };
  if (cluster.status === 'merging') return { ok: false, why: '正在合併' };
  if (cluster.status === 'purging') return { ok: false, why: '正在完全清除' };
  if (workers.some(isWorking)) return { ok: false, why: '叢集還在跑，先全部停止' };
  if (cluster.status === 'running') return { ok: false, why: '叢集還在跑：等它們做完，或先全部停止' };
  return { ok: true, why: cluster.purge?.partial ? '上次只清除了一部分：再按一次，繼續清掉剩下的' : '把這個叢集整個清掉：工作者對話、worktree、分支、記憶檔與叢集本身；主對話不動。刪除前預設先備份，保留 7 天' };
}

// On the page of every cluster: the ones that can be picked for a batch purge.
export const isPurgeableRow = (row) => ['done', 'stopped', 'error'].includes(row?.status) && !(row?.workersRunning > 0);

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

// ------------------------------------------------------------ full purge
//
// 完全清除 takes a finished cluster away whole: its worker conversations (the
// Hub's record and Kimi's, subagents with them), worktrees, worker branches,
// memory file and the cluster's own record. The main conversation is never
// touched. What is thrown away is decided by three boxes, all off by default,
// and the decision is ONE function used by the Hub (to do it) and by the dialog
// (to show it before it is done), so the two cannot disagree.

export const PURGE_DAYS = 7;
export const PURGE_OPTIONS = Object.freeze({ discardDirty: false, deleteUnmerged: false, deleteMerged: false, noBackup: false });
export const purgeOptions = (raw) => ({
  discardDirty: raw?.discardDirty === true,
  deleteUnmerged: raw?.deleteUnmerged === true,
  deleteMerged: raw?.deleteMerged === true,
  noBackup: raw?.noBackup === true,
});

// facts: what the computer said of one worker's worktree and branch (the Hub's
// inspectWorker): { hasWorktree, dir, registered, dirty, statusError, tip, safe, unique, checkedOutAt }.
//   worktree  'none' shared folder · 'gone' already missing · 'remove' clean · 'discard' dirty, removed with force · 'keep'
//   branch    'none' · 'gone' · 'delete' every commit is somewhere else · 'delete-unmerged' commits found nowhere else · 'keep'
// What is kept says why (`why`) and whose choice it is (`keptBy`): 'option' is
// a box left unticked - the person chose it - and 'problem' is something that
// stops the purge from taking it (git does not know the folder, a branch is
// checked out elsewhere), which makes the purge partial.
export function decidePurgeWorker(f, opts = {}) {
  const o = purgeOptions(opts);
  const out = { worktree: 'none', branch: 'none', reasons: [], why: { worktree: '', branch: '' }, keptBy: { worktree: null, branch: null } };
  if (!f?.hasWorktree) return out;
  const keep = (part, kind, why) => {
    out[part] = 'keep';
    out.why[part] = why;
    out.keptBy[part] = kind;
    out.reasons.push(why);
  };
  if (!f.dir) out.worktree = 'gone';
  else if (!f.registered) keep('worktree', 'problem', 'git 不認得這個資料夾是 worktree，沒有動它');
  else if (f.statusError) keep('worktree', 'problem', `看不到 worktree 的狀態：${f.statusError}`);
  else if (f.dirty > 0) {
    if (o.discardDirty) out.worktree = 'discard';
    else keep('worktree', 'option', `有 ${f.dirty} 項未提交的修改或未追蹤的檔案（沒勾「也丟掉未提交的修改」，所以保留）`);
  } else out.worktree = 'remove';
  if (!f.tip) out.branch = 'gone';
  else if (Array.isArray(f.checkedOutAt) && f.checkedOutAt.length) keep('branch', 'problem', `分支正被 ${f.checkedOutAt[0]} 檢出，沒有動它`);
  else if (!f.safe && !o.deleteUnmerged) keep('branch', 'option', `分支有 ${f.unique} 個 commit 沒合併進去（沒勾「也刪除沒合併進去的分支」，所以保留）`);
  else out.branch = f.safe ? 'delete' : 'delete-unmerged';
  // A branch cannot go while the worktree that has it checked out stays.
  if ((out.branch === 'delete' || out.branch === 'delete-unmerged') && out.worktree === 'keep') keep('branch', out.keptBy.worktree, `分支還被保留下來的 worktree 使用中${out.keptBy.worktree === 'option' ? '（沒勾「也丟掉未提交的修改」）' : ''}`);
  return out;
}

// cluster/<id>/merged: the product of the merge. Deleted only when asked.
export function decidePurgeMerged(exists, opts = {}) {
  if (!exists) return { state: 'none', reason: '' };
  return purgeOptions(opts).deleteMerged ? { state: 'delete', reason: '' } : { state: 'keep', reason: '沒勾「也刪除合併分支」，所以保留' };
}

// ---- the confirmation: GET /clusters/:id/purge/plan laid out for the dialog.
// The plan carries the facts of every worktree and branch, so what each box
// would change is worked out here, with the very function the Hub runs.
export function purgePlanView(plan, rawOpts = {}) {
  const opts = purgeOptions(rawOpts);
  const workers = Array.isArray(plan?.workers) ? plan.workers : [];
  const rows = workers.map((w) => {
    const d = decidePurgeWorker(w.facts, opts);
    const will = [];
    if (w.exists) will.push(`對話（Hub 紀錄${w.conversation?.kimiSessions ? '＋Kimi 紀錄' : ''}${w.conversation?.kimiSubagents ? `，含子代理 ${w.conversation.kimiSubagents} 個` : ''}）`);
    if (d.worktree === 'remove') will.push('移除 worktree');
    if (d.worktree === 'discard') will.push('移除 worktree（連同未提交的修改）');
    if (d.branch === 'delete') will.push('刪除分支');
    if (d.branch === 'delete-unmerged') will.push('刪除分支（含沒合併進去的 commit）');
    return { sessionId: w.sessionId, n: w.n, title: w.title, exists: Boolean(w.exists), worktreePath: w.worktree || null, branchName: w.branch || null, will, keeps: d.worktree === 'keep' || d.branch === 'keep', reasons: d.reasons, decision: d };
  });
  const count = (f) => rows.filter(f).length;
  const merged = decidePurgeMerged(plan?.merged?.exists, opts);
  const totals = {
    conversations: count((r) => r.exists),
    kimiSessions: Number(plan?.totals?.kimiSessions) || 0,
    kimiSubagents: Number(plan?.totals?.kimiSubagents) || 0,
    worktrees: count((r) => r.decision.worktree === 'remove' || r.decision.worktree === 'discard'),
    discarded: count((r) => r.decision.worktree === 'discard'),
    branches: count((r) => r.decision.branch === 'delete' || r.decision.branch === 'delete-unmerged'),
    kept: count((r) => r.keeps) + (merged.state === 'keep' ? 1 : 0),
  };
  const facts = workers.filter((w) => w.facts?.hasWorktree);
  return {
    rows,
    totals,
    merged: { ...merged, branch: plan?.merged?.branch || '', exists: Boolean(plan?.merged?.exists) },
    // What the three boxes could change: how many things each one would take (so a box with nothing behind it can say so).
    boxes: {
      dirty: facts.filter((w) => w.facts.dir && w.facts.registered && !w.facts.statusError && w.facts.dirty > 0).length,
      unmerged: facts.filter((w) => w.facts.tip && !w.facts.safe && !(w.facts.checkedOutAt || []).length).length,
      merged: Boolean(plan?.merged?.exists),
    },
    memory: plan?.memory || null,
    connector: plan?.connector || null,
    days: Number(plan?.days) || PURGE_DAYS,
  };
}

// The outcome of POST /clusters/:id/purge in the words of the result page.
export function purgeResultView(r) {
  if (!r) return null;
  const workers = Array.isArray(r.workers) ? r.workers : [];
  const n = (f) => workers.filter(f).length;
  if (r.aborted) return { tone: 'aborted', title: '沒有清除：什麼都沒有刪', summary: r.reason || '', deleted: [], kept: [], failed: [], backup: null, connectorNote: null, cluster: false };
  const deleted = [];
  const conv = n((w) => w.conversation === 'deleted' || w.conversation === 'archived');
  if (conv) deleted.push(`${conv} 個工作者對話（Hub 紀錄${r.connectorNote ? '；Kimi 紀錄只封存' : '＋Kimi 紀錄與子代理'}）`);
  const wt = n((w) => w.worktree === 'removed' || w.worktree === 'discarded');
  if (wt) deleted.push(`${wt} 個 worktree${n((w) => w.worktree === 'discarded') ? `（其中 ${n((w) => w.worktree === 'discarded')} 個連同未提交的修改）` : ''}`);
  const br = n((w) => w.branch === 'deleted');
  if (br) deleted.push(`${br} 個工作者分支`);
  if (r.merged?.state === 'deleted') deleted.push(`合併分支 ${r.merged.branch}`);
  if (r.memory?.state === 'deleted') deleted.push('叢集記憶檔與資料夾');
  if (r.removed) deleted.push('叢集紀錄本身（已從總覽移除）');
  const kept = Array.isArray(r.kept) ? [...r.kept] : [];
  const failed = Array.isArray(r.failed) ? [...r.failed] : [];
  const b = r.backup || {};
  const backup = b.enabled
    ? { enabled: true, days: Number(b.days) || PURGE_DAYS, expiresAt: b.expiresAt || null, hub: b.hub ? { file: b.hub.file, bytes: b.hub.bytes } : null, machine: b.machine ? { name: b.machine.machineName, path: b.machine.path, bytes: b.machine.bytes, missing: b.machine.missing || [] } : null }
    : { enabled: false };
  const partial = Boolean(r.partial);
  return {
    tone: partial ? 'partial' : 'ok',
    title: partial ? `部分清除：有 ${failed.length} 項沒清掉` : kept.length ? '清除完成（有些東西依你的選擇保留了）' : '清除完成',
    summary: partial ? '叢集還在總覽裡，標著「部分清除」；排除問題後再按一次「完全清除」，只會處理剩下的。' : '',
    deleted,
    kept,
    failed,
    backup,
    connectorNote: r.connectorNote || null,
    cluster: Boolean(r.removed),
  };
}

// ---- the name and the main conversation under it
export const clusterNameOf = (c, liveParentTitle = '') => (typeof c?.name === 'string' && c.name.trim() ? c.name.trim() : liveParentTitle || (typeof c?.parentTitle === 'string' ? c.parentTitle : '') || '（未命名叢集）');
// The small line: "主對話：<title>", or that it is gone. `live`: the title the page itself knows.
export function parentLine(c, live = '') {
  const title = live || (typeof c?.parentTitle === 'string' ? c.parentTitle : '');
  if (title) return { text: `主對話：${title}`, title, gone: false };
  if (c && 'parentTitle' in c && c.parentTitle === null) return { text: '主對話已刪除', title: '', gone: true };
  return c?.parentId ? { text: '主對話', title: '', gone: false } : { text: '', title: '', gone: false };
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

// ------------------------------------------------------------- subagents

// What a square says about a subagent. `group` is what it is counted with:
// "失敗或取消" is one group (a subagent that was cut short did not finish
// either), the squares and the legend say it with a glyph as well as a colour.
// The words are the conversation's own (agent-state.js lifeBadge).
export const SUBAGENT_STATES = {
  running: { group: 'running', label: '執行中', glyph: '' },
  awaiting: { group: 'awaiting', label: '等你核准', glyph: '!' },
  done: { group: 'done', label: '完成', glyph: '✓' },
  failed: { group: 'failed', label: '失敗', glyph: '✕' },
  cancelled: { group: 'failed', label: '已中斷', glyph: '✕' },
  unknown: { group: 'unknown', label: '狀態未知', glyph: '?' },
};
// The legend, in the order the count line uses.
export const SUBAGENT_LEGEND = [
  { group: 'running', label: '執行中', glyph: '' },
  { group: 'awaiting', label: '等你核准', glyph: '!' },
  { group: 'done', label: '完成', glyph: '✓' },
  { group: 'failed', label: '失敗或取消', glyph: '✕' },
  { group: 'unknown', label: '狀態未知', glyph: '?' },
];
export const subagentState = (status) => SUBAGENT_STATES[status] || SUBAGENT_STATES.unknown;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// The counts the Hub sends, by group.
export function groupCounts(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  return { total: num(c.total), running: num(c.running), awaiting: num(c.awaiting), done: num(c.done), failed: num(c.failed) + num(c.cancelled), unknown: num(c.unknown) };
}

// "子代理 8：5 執行中・3 完成"; only the groups that have any, in the legend's order.
export function subagentLine(counts, older = 0) {
  const g = groupCounts(counts);
  if (!g.total && !older) return '沒有開過子代理';
  const parts = SUBAGENT_LEGEND.filter((l) => g[l.group]).map((l) => `${g[l.group]} ${l.label}`);
  return `子代理 ${g.total}${parts.length ? `：${parts.join('・')}` : ''}${older ? `（另有 ${older} 個更早的不在清單裡）` : ''}`;
}

// A subagent is at work: running, or waiting for a person's approval (it is alive).
export const workingSubagents = (counts) => groupCounts(counts).running + groupCounts(counts).awaiting;

// How many squares fit before "+N": the rest are one button away.
export const SQUARES_SHOWN = 40;
export function squaresView(list, { all = false, max = SQUARES_SHOWN } = {}) {
  const items = Array.isArray(list) ? list : [];
  const shown = all || items.length <= max ? items : items.slice(0, max);
  return { shown, hidden: items.length - shown.length };
}

// The aria-label of one square: whose, what state, and the one thing it is doing.
export function squareLabel(s, i = 0) {
  const st = subagentState(s?.status);
  return [`子代理 ${i + 1}`, s?.title ? `「${s.title}」` : '', st.label, s?.lastAction ? `最新動作 ${s.lastAction}` : ''].filter(Boolean).join('，');
}

// What the detail of a subagent says; `—` for what was not measured, and why in `why`.
export function subagentDetail(s, { now = Date.now(), modelText = (p, m) => m, effortLabel = (e) => e } = {}) {
  const st = subagentState(s?.status);
  const active = st.group === 'running' || st.group === 'awaiting';
  const started = isMoment(s?.startedAt) ? s.startedAt : null;
  const ended = isMoment(s?.finishedAt) ? s.finishedAt : null;
  const span = started && (active ? now - started : ended && ended >= started ? ended - started : null);
  return {
    state: st,
    title: s?.title || s?.name || '子代理',
    model: s?.model ? `${modelText(s.provider, s.model)}${s.effort ? ` · 思考 ${effortLabel(s.effort)}` : ''}` : null,
    modelWhy: s?.model ? null : s?.modelReason || '沒有回報',
    steps: Number.isFinite(s?.steps) ? s.steps : null,
    lastAction: s?.lastAction || null,
    startedAt: started,
    started: fmtStamp(started),
    finishedAt: ended,
    finished: fmtStamp(ended),
    span: span !== null && span >= 0 ? (active ? `已跑 ${fmtMs(span)}` : `跑了 ${fmtMs(span)}`) : null,
    reason: s?.reason || null,
    background: Boolean(s?.background),
    eventId: s?.eventId || null,
  };
}

// ----------------------------------------------------------------- speed

// Three different numbers, never to be mistaken for one another:
//  - 生成速度 (a worker's `gen`): how fast the model writes when it really writes -
//    the chat room's own number, from the tokens Kimi counted over the time it
//    measured them streaming. Only a running worker has one;
//  - 叢集總產出 (the cluster's `throughput`): what the whole cluster, its subagents
//    included, produced in the last minute, one window (the Hub's recentOutput);
//  - 平均產出 (a worker's `speed`): the connector's request records of the last five
//    minutes added up, waiting and tools in the divisor (the Hub's recentSpeed).
// Each is null where the Hub cannot say, with the reason; nothing here estimates,
// and nothing here says how long anything will take.
export function fmtRate(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
}
export const fmtWindow = (ms) => (isCount(ms) && ms > 0 ? (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分鐘`) : null);

// 步數 of one cluster: how many steps it has taken, as the chat room counts them
// ("483 個步驟" on a subagent card is the number of tool calls under it). Said
// for the cluster only; it is not added up over clusters.
export function stepsView(steps, unknown = 0) {
  if (typeof steps !== 'number' || !Number.isFinite(steps) || steps < 0) return { shown: false, text: '', long: '', title: '' };
  const n = Math.round(steps);
  return {
    shown: true,
    n,
    text: `${n.toLocaleString('en-US')} 步`,
    long: `共 ${n.toLocaleString('en-US')} 步`,
    title: `一步＝一次工具呼叫，工作者主代理與所有子代理的加總（和聊天室子代理卡片的「N 個步驟」同一個算法）${unknown ? `；有 ${unknown} 個工作者的對話已刪除、沒有紀錄，沒算進去` : ''}`,
  };
}

// 工作者生成時約 X tok/s，約有 Y% 時間在生成: why the band's cluster output (averaged over the last
// minute, idle time in it) reads lower than one working tile. Only from numbers the Hub
// measured, by dividing: Σ = the generation speeds of the workers that are working now;
// X = Σ ÷ how many; Y = the cluster output ÷ Σ. It needs every working worker's speed
// (one missing makes Σ too small), a cluster that is working and measured, and a Y that
// can be one (above 100% the output holds subagents' text the workers' speeds do not,
// and nothing is said). Otherwise the line is not shown.
export function genShareView(c) {
  const none = (why) => ({ shown: false, why });
  if (!isActive(c)) return none('叢集不在跑');
  const out = c?.throughput?.tokensPerSecond;
  if (typeof out !== 'number' || !Number.isFinite(out) || out < 0) return none('量不到叢集總產出');
  const working = (Array.isArray(c?.workers) ? c.workers : []).filter(isWorking);
  if (!working.length) return none('沒有工作者在跑');
  const speeds = working.map((w) => w?.gen?.tokensPerSecond);
  if (!speeds.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return none('有在跑的工作者量不到生成速度');
  const sum = speeds.reduce((a, v) => a + v, 0);
  const x = sum / working.length;
  const y = (out / sum) * 100;
  if (y > 100) return none('總產出比工作者的生成速度合計還大（含子代理的字數），算不出占比');
  const xs = fmtRate(x);
  const ys = Math.max(1, Math.round(y));
  return {
    shown: true,
    x: xs,
    y: ys,
    text: `工作者生成時約 ${xs} tok/s，約有 ${ys}% 時間在生成，其餘在跑工具或等待`,
    title: `${working.length} 個工作者現在的生成速度合計 ${fmtRate(sum)} tok/s；叢集總產出 ${fmtRate(out)} tok/s ÷ ${fmtRate(sum)} ≈ ${ys}%。兩個數字都是量到的，只做除法。`,
  };
}

// The worker tile's speed: 生成 (what it writes while it writes, the chat room's number) beside
// 平均 (its last five minutes, waiting and tools in it). "—" where it is not working.
export function tileSpeedView(w) {
  const gen = genView(w?.gen);
  if (!gen.measured) return { measured: false, text: '—', title: `生成速度：${gen.tip}。現在量不到（原因在詳細裡）` };
  const avg = speedView(w?.speed);
  const avgText = avg.measured ? String(fmtRate(w.speed.tokensPerSecond)) : '—';
  return {
    measured: true,
    text: `生成 ${fmtRate(w.gen.tokensPerSecond)} · 平均 ${avgText}`,
    title: `生成 ${gen.text}：${gen.tip}（和聊天室狀態列同一個數字）。平均 ${avg.measured ? avg.text : '量不到'}：${avg.tip}`,
  };
}

// One sentence of how each is worked out (the tooltips and the drawer say it).
export const TIP_GEN = '模型實際吐字時每秒的字數，不含等工具與等第一個字';
export const TIP_OUTPUT = '最近 1 分鐘所有代理（含子代理）實際產出的字數 ÷ 60 秒；字數在每個請求結束時才計入，所以會略有跳動';
export const TIP_AVG = '最近 5 分鐘內產出的字數 ÷ 300 秒，含等待與工具時間';
export const OUTPUT_FULL_WINDOW_MS = 60_000;

// One worker's 平均產出 as the page draws it: the short text, and the longer
// lines for the drawer.
export function speedView(speed) {
  const tps = fmtRate(speed?.tokensPerSecond);
  const rpm = fmtRate(speed?.requestsPerMinute);
  const win = fmtWindow(speed?.windowMs);
  const label = `平均產出（最近 ${win || '5 分鐘'}，含等待）`;
  return {
    measured: tps !== null,
    text: tps === null ? '—' : `${tps} tok/s`,
    label,
    tip: TIP_AVG,
    tokens: tps === null ? null : `${label}：${tps} tok/s`,
    requests: rpm === null ? null : `請求 ${rpm}／分`,
    why: tps === null ? speed?.unmeasured || '伺服器沒有回報速度' : null,
  };
}

// One worker's 生成速度: the small square's text ("103 tok/s", or "—") and why.
export function genView(gen) {
  const tps = fmtRate(gen?.tokensPerSecond);
  return {
    measured: tps !== null,
    text: tps === null ? '—' : `${tps} tok/s`,
    tip: TIP_GEN,
    why: tps === null ? gen?.unmeasured || '伺服器沒有回報生成速度' : null,
  };
}

// A cluster's 叢集總產出 (its `throughput`, as the summary passes it on): the big
// number and the small line under it. A window shorter than a minute is said
// (a young cluster can only be measured over the time it has lived); so is how
// many workers the records could speak for. A cluster that is over has no
// "last minute" to say: a dash.
export function outputView(throughput, { active = true } = {}) {
  const tps = fmtRate(throughput?.tokensPerSecond);
  if (!active) return { measured: false, num: '—', text: '—', unit: '', sub: '叢集已結束', tip: TIP_OUTPUT, why: '叢集已結束，沒有「最近 1 分鐘」可說' };
  if (tps === null) {
    const why = throughput?.unmeasured || '伺服器沒有回報叢集總產出';
    return { measured: false, num: '—', text: '—', unit: '', sub: '量不到', tip: TIP_OUTPUT, why };
  }
  const win = fmtWindow(throughput.windowMs);
  const short = isCount(throughput.windowMs) && throughput.windowMs < OUTPUT_FULL_WINDOW_MS;
  const counted = isCount(throughput.workersCounted) ? throughput.workersCounted : null;
  const total = isCount(throughput.workers) ? throughput.workers : null;
  const sub = [short ? `最近 ${win}（叢集才跑了這麼久）・所有代理（含子代理）` : '最近 1 分鐘・所有代理（含子代理）', counted !== null && total !== null && counted < total ? `${counted}/${total} 個工作者量得到` : null].filter(Boolean).join('・');
  return { measured: true, num: tps, text: `${tps} tok/s`, unit: 'tok/s', sub, tip: short ? `${TIP_OUTPUT}（叢集才跑了 ${win}，所以只算這段時間，÷ ${Math.round(throughput.windowMs / 1000)} 秒）` : TIP_OUTPUT, why: null };
}

// The same over every working cluster (the big number of the list of clusters),
// from totalsOf(): the sum of the clusters that are working and measured one.
export function outputTotalView(totals) {
  const tps = fmtRate(totals?.outputTokensPerSecond);
  if (tps === null) {
    const none = isCount(totals?.active) && totals.active > 0;
    return { measured: false, num: '—', sub: none ? '量不到' : '沒有進行中的叢集', tip: TIP_OUTPUT, why: none ? '進行中的叢集都沒有請求紀錄可算（不是 DeepSeek 號池，或連接器還沒回報）' : '沒有進行中的叢集，沒有「最近 1 分鐘」可說' };
  }
  const n = isCount(totals.outputMeasured) ? totals.outputMeasured : 0;
  return { measured: true, num: tps, sub: `最近 1 分鐘・${n} 個進行中叢集合計`, tip: TIP_OUTPUT, why: null };
}

// ------------------------------------------------------ the whole cluster

// The one line the list of clusters (GET /api/clusters) and the page's reading
// of a pushed cluster are both made from, so the two cannot disagree.
export function summarizeCluster(c) {
  const workers = Array.isArray(c?.workers) ? c.workers : [];
  const p = progressOf(c);
  const tasks = Array.isArray(c?.tasks) ? c.tasks : [];
  const have = workers.filter((w) => w?.subagentCounts && typeof w.subagentCounts === 'object');
  const sum = { total: 0, running: 0, awaiting: 0, done: 0, failed: 0, cancelled: 0, unknown: 0 };
  let older = 0;
  for (const w of have) {
    for (const k of Object.keys(sum)) sum[k] += num(w.subagentCounts[k]);
    older += num(w.subagentsOlder);
  }
  const rates = workers.map((w) => w?.speed).filter((s) => s && fmtRate(s.tokensPerSecond) !== null);
  const reqRates = workers.map((w) => w?.speed).filter((s) => s && fmtRate(s.requestsPerMinute) !== null);
  return {
    id: c?.id,
    // The cluster's own name (the Hub makes one if the person gave none); the main conversation is a small line under it.
    name: typeof c?.name === 'string' ? c.name : '',
    parentId: c?.parentId ?? null,
    // The main conversation's title; null: it no longer exists. Absent (an older Hub): not said.
    ...(c && 'parentTitle' in c ? { parentTitle: c.parentTitle } : {}),
    status: c?.status,
    purgePartial: Boolean(c?.purge?.partial),
    // 步數 (the tool calls of its workers and their subagents); null: not said (an older Hub, or never counted). Not added up over clusters.
    steps: typeof c?.steps === 'number' && Number.isFinite(c.steps) && c.steps >= 0 ? c.steps : null,
    stepsUnknown: typeof c?.stepsUnknown === 'number' ? c.stepsUnknown : 0,
    createdAt: c?.createdAt ?? null,
    tasks: { done: p.done, total: p.total, failed: p.failed, running: tasks.filter((t) => t?.status === 'running').length, pending: tasks.filter((t) => t?.status === 'pending').length },
    workers: workers.length,
    workersRunning: workers.filter((w) => w?.status === 'running' || w?.status === 'awaiting_permission').length,
    // null when no worker said (an older Hub): not zero.
    subagents: have.length ? { ...sum, older } : null,
    speed: {
      tokensPerSecond: rates.length ? Math.round(rates.reduce((a, s) => a + s.tokensPerSecond, 0) * 10) / 10 : null,
      requestsPerMinute: reqRates.length ? Math.round(reqRates.reduce((a, s) => a + s.requestsPerMinute, 0) * 10) / 10 : null,
      workersMeasured: rates.length,
      workers: workers.length,
      unmeasured: rates.length ? null : workers.map((w) => w?.speed?.unmeasured).find(Boolean) || '沒有任何工作者量得到速度',
    },
    // What the whole cluster produced in the last minute: the Hub's own line, passed on as it is (not a sum of the workers' averages).
    throughput: c?.throughput && typeof c.throughput === 'object' ? c.throughput : { windowMs: null, outTokens: null, tokensPerSecond: null, requests: null, requestsPerMinute: null, unmeasured: '伺服器沒有回報叢集總產出（較舊的 Hub）', workersCounted: 0, workers: workers.length },
  };
}

// Active clusters first, each group newest first.
export function sortClusters(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (b.createdAt || 0) - (a.createdAt || 0));
}

// The big numbers over all clusters: from the same one-line summaries.
export function totalsOf(list) {
  const rows = Array.isArray(list) ? list : [];
  const active = rows.filter(isActive);
  const withSub = rows.filter((r) => r.subagents);
  const speeds = rows.map((r) => r.speed?.tokensPerSecond).filter((v) => fmtRate(v) !== null);
  // 叢集總產出 over everything: the clusters that are working and measured one.
  const outputs = active.map((r) => r.throughput?.tokensPerSecond).filter((v) => fmtRate(v) !== null);
  const round1 = (list) => Math.round(list.reduce((a, v) => a + v, 0) * 10) / 10;
  return {
    clusters: rows.length,
    active: active.length,
    workersRunning: rows.reduce((a, r) => a + num(r.workersRunning), 0),
    subagentsRunning: withSub.reduce((a, r) => a + r.subagents.running + r.subagents.awaiting, 0),
    subagentsOpened: withSub.reduce((a, r) => a + r.subagents.total + r.subagents.older, 0),
    // Some cluster did not say how many subagents it has: the numbers above are what the others said.
    subagentsPartial: withSub.length < rows.length,
    outputTokensPerSecond: outputs.length ? round1(outputs) : null,
    outputMeasured: outputs.length,
    // 平均產出: the sum of the clusters' five-minute averages (every cluster that said).
    avgTokensPerSecond: speeds.length ? round1(speeds) : null,
  };
}

// How long the cluster has been going: since it was made, to now while it works,
// and to the last moment the Hub saw any of its tasks end once it is over.
export function clusterElapsed(c, now = Date.now()) {
  if (!isMoment(c?.createdAt)) return null;
  if (isActive(c)) return Math.max(0, now - c.createdAt);
  const ends = [...(Array.isArray(c.tasks) ? c.tasks : []).map((t) => t?.finishedAt), ...(Array.isArray(c.workers) ? c.workers : []).map((w) => w?.finishedAt)].filter(isMoment);
  return ends.length ? Math.max(0, Math.max(...ends) - c.createdAt) : null;
}

// The bar over the whole cluster: parts of the tasks (as shares of the total).
export function taskBar(c) {
  const tasks = Array.isArray(c?.tasks) ? c.tasks : [];
  const total = tasks.length || progressOf(c).total;
  if (!total) return { total: 0, done: 0, running: 0, failed: 0 };
  if (!tasks.length) {
    const p = progressOf(c);
    return { total, done: p.done / total, running: 0, failed: p.failed / total };
  }
  const share = (status) => tasks.filter((t) => t?.status === status).length / total;
  return { total, done: share('done'), running: share('running'), failed: share('failed') };
}

// A worker's small square: which task it is on, how many it finished, and its share of the whole.
export function workerSquare(w, cluster) {
  const tasks = Array.isArray(cluster?.tasks) ? cluster.tasks : [];
  const total = tasks.length || 0;
  const done = Number.isInteger(w?.done) ? w.done : 0;
  const onIndex = Number.isInteger(w?.taskIndex) ? w.taskIndex : null;
  let place;
  if (!total) place = null;
  else if (w?.status === 'deleted') place = '已刪除';
  else if (onIndex !== null) place = `第 ${onIndex + 1}/${total} 條`;
  else place = done ? `做完 ${done} 條` : '待命';
  return { place, share: total ? done / total : 0, working: onIndex !== null, done, total };
}

// --------------------------------------------------------- the key it uses

// Which key of the DeepSeek pool a worker's requests went out with, as the Hub's
// timing answer says it (`currentKey`): the name of the gateway and the last four
// characters, nothing else - not its id, not the computer it ran on, not when.
// null from here: the Hub does not say (an older one), so the page says nothing.
const GATEWAY_LABELS = { 'opencode-go': 'OpenCode Go', opencode: 'OpenCode', commandcode: 'Command Code' };
export function keyView(timing) {
  if (!timing || typeof timing !== 'object' || !Object.hasOwn(timing, 'currentKey')) return null;
  const k = timing.currentKey;
  if (k === null || typeof k !== 'object') return { state: 'none', text: '還沒有請求紀錄', note: null };
  const label = String(k.gatewayLabel || GATEWAY_LABELS[k.gateway] || k.gateway || '').trim();
  // The key is no longer in the list, or the Hub has nothing to name it by.
  if (k.removed || !k.hint) return { state: 'removed', text: 'key 已從清單移除', note: null };
  return { state: 'ok', text: `${label ? `${label} ` : ''}…${String(k.hint).slice(-4)}`, note: k.distribution === 'sticky' ? '這個對話固定用這一把' : null };
}
