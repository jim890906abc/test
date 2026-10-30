// 叢集 (cluster): hand several tasks to several worker conversations at once.
// This file draws the three places it shows up - the dispatch dialog, the cluster
// page (#/cluster/<id>) and the note on the conversations it touches - and
// holds what the page has been told about clusters. What is decided (what a
// dispatch sends, how timing is laid out) is in cluster-model.js.
//
// Naming (spec §0): a cluster is never called a Swarm here. "Swarm" on these
// screens is only Kimi's own mode, which a worker can be started in; every place
// that says it is marked data-native-swarm and says whose it is.
import { h, fill, icon, relTime } from './dom.js';
import { get, post } from './api.js';
import { busy as sessionBusy } from './providers.js';
import { WorkerTile, WorkerDrawer, ClusterListPage, TONE_BADGE, CLUSTER_BADGE, barEl, elapsedText } from './cluster-tiles.js';
import { confirmPurge, purgeResultEl, purgeBatchResultEl, purgedListEl } from './cluster-purge.js';
import {
  CLUSTER_NAME_MAX,
  autoClusterName,
  cleanClusterName,
  clusterNameOf,
  parentLine,
  purgeAvailability,
  CLUSTER_MAX_TASKS,
  CLUSTER_MAX_WORKERS,
  CLUSTER_DEFAULTS,
  CLUSTER_MODES,
  cleanupAvailability,
  cleanupPlanView,
  cleanupResultView,
  clusterStatusLabel,
  clusterElapsed,
  contextWarnings,
  defaultWorkers,
  draftProblems,
  failedText,
  fmtBytes,
  isActive,
  isStoppable,
  memoryNote,
  mergeAvailability,
  MEMORY_MAX_CHARS,
  parseTaskLines,
  progressOf,
  queueAdvice,
  queueView,
  requestBody,
  outputView,
  speedView,
  stepsView,
  genShareView,
  summarizeCluster,
  taskBar,
  totalsOf,
  workingSubagents,
  workersFor,
} from './cluster-model.js';

// ---------------------------------------------------------- what we know

const known = new Map(); // cluster id -> the newest cluster this page has seen
const loadedFor = new Set(); // clusters of a worker whose cluster was fetched this page load
const askedFor = new Map(); // main conversation id -> the list of its cluster ids the cluster list was last fetched for

// One light line per cluster (summarizeCluster: the same function the Hub's
// GET /api/clusters uses), kept for the page that lists them all and for the
// number beside its link in the sidebar. Told about a cluster, it is redrawn
// only if the line changed.
const summaries = new Map();
const listeners = new Set();
const sigs = new Map();
export const onClusterRows = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const noteRows = () => {
  for (const fn of listeners) fn();
};
export const clusterRows = () => [...summaries.values()];
export const clusterTotals = () => totalsOf(clusterRows());
const keepRow = (row) => {
  const sig = JSON.stringify(row);
  summaries.set(row.id, row);
  if (sigs.get(row.id) === sig) return false;
  sigs.set(row.id, sig);
  return true;
};

export const rememberCluster = (c) => {
  if (c?.id) {
    known.set(c.id, c);
    if (keepRow(summarizeCluster(c))) noteRows();
  }
  return c;
};

// The list of every cluster, from the Hub (once when the page starts, and again when asked to).
export async function loadClusterRows() {
  const list = await get('/clusters');
  let changed = false;
  for (const r of Array.isArray(list) ? list : []) {
    if (!r?.id) continue;
    changed = keepRow(r) || changed;
  }
  if (changed) noteRows();
}
export const clusterById = (id) => known.get(id) || null;

// A cluster that is gone (a full purge took it): forgotten by every list and count.
export function forgetCluster(id) {
  let changed = known.delete(id);
  changed = summaries.delete(id) || changed;
  sigs.delete(id);
  loadedFor.delete(id);
  if (changed) noteRows();
}

// The page that lists every cluster (#/clusters). ctx.parentTitle(id): the main conversation's name as the page knows it now.
export const createClusterList = (ctx) =>
  new ClusterListPage({
    ctx,
    rows: clusterRows,
    // The big title is the cluster's own name; the main conversation is the small line under it (or says it is gone).
    name: (r) => clusterNameOf(r, r.name ? '' : ctx.parentTitle?.(r.parentId)),
    // (A cluster the Hub gave no name - an older Hub - is called by its main conversation; the small line would only say it twice.)
    parent: (r) => (r.name ? parentLine(r, ctx.parentTitle?.(r.parentId) || '') : { text: '', gone: false }),
    load: loadClusterRows,
    confirmPurge: (entries) => confirmPurge(ctx, entries),
    onPurged: (items) => {
      const d = ctx.dialog(h('div', { class: 'settings cluster-purge-batch-dialog' }, h('div', { class: 'dialog-title' }, '清除結果'), purgeBatchResultEl(items, ctx), h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', dataset: { action: 'close-result' }, onclick: () => d.close() }, '關閉'))), { wide: true });
    },
    loadPurged: async () => {
      try {
        return await get('/clusters/trash');
      } catch {
        return { items: [] };
      }
    },
    purgedEl: (r) => purgedListEl(r?.items, { days: r?.days, ctx }),
  });
// The clusters a main conversation started, newest first. A cluster names the
// node of the conversation's chain it was made from (parentId); once the
// conversation has moved on to another node (a model on another runtime and
// back) that is not the id of the node the page shows, whose own summary
// lists every cluster of the chain (clusterIds).
export const clustersOf = (summary) => {
  const mine = new Set(summary?.clusterIds || []);
  return [...known.values()].filter((c) => c.parentId === summary?.id || mine.has(c.id)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};
export const clusterHash = (id) => `#/cluster/${id}`;

// A main conversation that says it has clusters (summary.clusterIds): ask the
// Hub for them, so the banner is there when it is opened - and again when the
// summary names a cluster this page has not heard of (one dispatched while the
// page's link to the Hub was down: the push that announces a cluster is not
// repeated), or when asked to (`force`, the link is back). A worker (a page opened straight on it, after a reload) knows only
// its cluster's id, and its note needs the main conversation's: ask for that
// cluster once. One that belongs to no cluster asks for nothing.
export async function loadClustersOf(summary, { force = false } = {}) {
  const id = summary?.id;
  if (!id) return false;
  if (summary.clusterRole === 'worker' && summary.clusterId) {
    const cid = summary.clusterId;
    if (clusterById(cid) || loadedFor.has(cid)) return false;
    loadedFor.add(cid);
    try {
      rememberCluster(await get(`/clusters/${cid}`));
      return true;
    } catch {
      loadedFor.delete(cid); // try again the next time it is opened
      return false;
    }
  }
  const ids = summary.clusterIds || [];
  const key = ids.join(',');
  // `force`: the link to the Hub was down, so what was said about these clusters meanwhile (that one finished) was missed.
  if (!ids.length || (!force && (askedFor.get(id) === key || ids.every((cid) => known.has(cid))))) return false;
  askedFor.set(id, key);
  try {
    const list = await get(`/sessions/${id}/clusters`);
    for (const c of Array.isArray(list) ? list : list?.clusters || []) rememberCluster(c);
    return true;
  } catch {
    askedFor.delete(id); // try again the next time it is opened
    return false;
  }
}

const modeLabel = (mode) => (mode === 'fork' ? '完整分叉' : '簡報起跑');
// Kimi's own swarm mode, said as such wherever it is said.
const nativeSwarm = (on) => h('span', { class: `cluster-chip${on ? ' on' : ''}`, dataset: { nativeSwarm: '' }, title: on ? '這個叢集的工作者開著 Kimi 原生的 Swarm 模式（同 /swarm）' : '這個叢集的工作者沒有開 Kimi 原生的 Swarm 模式' }, `原生 Swarm ${on ? '開' : '關'}`);

// -------------------------------------------- the note on a conversation

// On a main conversation: a line per running cluster. On a worker: where it
// belongs. `slot` is the (hidden when empty) box the page keeps for it.
export function drawClusterNote(slot, summary) {
  if (!slot) return;
  const nodes = [];
  if (summary?.clusterRole === 'worker' && summary.clusterId) {
    const parent = clusterById(summary.clusterId)?.parentId;
    nodes.push(
      h(
        'div',
        { class: 'callout small child-note cluster-worker-note' },
        icon('cluster'),
        h(
          'div',
          { class: 'callout-text' },
          h('strong', null, '這是叢集的工作者對話'),
          ' 它的任務、進度與合併都在叢集頁。',
          summary.clusterHidden ? '清理之後它已從側欄收起，在叢集頁可以放回。' : null,
          h('a', { class: 'linklike', href: clusterHash(summary.clusterId) }, '查看叢集'),
          parent ? h('a', { class: 'linklike', href: `#/s/${parent}` }, '回主對話') : null,
        ),
      ),
    );
  } else if (summary?.id) {
    for (const c of clustersOf(summary).filter(isActive)) {
      const { done, total, failed } = progressOf(c);
      nodes.push(
        h(
          'div',
          { class: 'callout small child-note cluster-banner', role: 'status' },
          icon('cluster'),
          h('span', { class: 'cluster-banner-text' }, `${c.status === 'merging' ? '叢集合併中' : '叢集進行中'} ${done}/${total} 完成`, failed ? `，${failedText(c, failed)}` : ''),
          h('a', { class: 'linklike', href: clusterHash(c.id) }, '查看 →'),
        ),
      );
    }
  }
  slot.hidden = !nodes.length;
  fill(slot, nodes);
}

// ----------------------------------------------------- the dispatch dialog

// ctx: { dialog, toast, fail, go } from the page. `session`: the main conversation.
export function openClusterDialog(ctx, session, { prompt = '' } = {}) {
  // `workers: null` is "not chosen": the Hub's default (one per task, at most 4) follows the number of tasks.
  const draft = { tasks: [{ title: '', prompt }], ...CLUSTER_DEFAULTS, workers: null, note: '', name: '' };
  let dirty = Boolean(prompt);
  let sending = false;
  let closed = false;
  const live = () => ctx.session?.(session.id) || session;

  const tasksBox = h('div', { class: 'cluster-tasks' });
  const count = h('span', { class: 'cluster-count' });
  const addBtn = h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'add-task' }, onclick: () => addTask() }, icon('plus'), '新增任務');
  // The cluster's own name; left empty it is made from the tasks (the box shows what it would be).
  const nameInput = h('input', { class: 'om-input', type: 'text', name: 'cluster-name', maxLength: CLUSTER_NAME_MAX, autocomplete: 'off', 'aria-label': '叢集名稱（選填）', oninput: () => ((draft.name = nameInput.value), (dirty = true), drawState()) });
  const workersInput = h('input', {
    class: 'om-input cluster-workers-input',
    type: 'number',
    name: 'workers',
    min: 1,
    max: CLUSTER_MAX_WORKERS,
    step: 1,
    inputmode: 'numeric',
    'aria-label': '工作者數',
    oninput: () => {
      const raw = workersInput.value.trim();
      // Emptied: back to the default, which follows the number of tasks.
      draft.workers = raw === '' ? null : Number(raw);
      dirty = true;
      drawState();
    },
  });
  const workersHelp = h('span', { class: 'om-field__help', dataset: { field: 'workers-help' } });
  const adviceBox = h('div', { class: 'cluster-advice', dataset: { field: 'advice' } });
  const lines = h('textarea', { class: 'om-input', name: 'task-lines', rows: 4, placeholder: '一行一條任務，可以一次貼上很多行（前面的「- 」「1. 」會自動去掉）', 'aria-label': '一次貼上多條任務，每行一條' });
  const linesNote = h('span', { class: 'om-field__help', dataset: { field: 'lines-note' }, role: 'status' });
  const addLinesBtn = h('button', { class: 'om-btn', type: 'button', dataset: { action: 'add-lines' }, onclick: () => addLines() }, icon('plus'), '加入清單');
  const modeBox = h('div', { class: 'om-seg', role: 'group', 'aria-label': '起跑方式', dataset: { field: 'mode' } });
  const modeHelp = h('span', { class: 'om-field__help' });
  const warnBox = h('div', { class: 'cluster-warns' });
  const problemBox = h('div', { class: 'om-field__help cluster-problems' });
  const errorBox = h('div', { class: 'om-field__error cluster-error', role: 'alert' });
  const submit = h('button', { class: 'om-btn om-btn--primary', type: 'submit' });
  const cancel = h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消');
  // Opening the workers takes the Hub seconds: it answers when every one is open and has its brief.
  const sendingNote = h('div', { class: 'cluster-sending callout small', role: 'status', hidden: true }, h('span', { class: 'spinner' }), h('div', { class: 'callout-text' }, '正在開工作者對話並送出簡報：要等所有工作者都開好才會完成，通常要幾秒，工作者多或電腦慢會更久。請先不要關掉這個視窗。'));

  const isolate = h('input', { class: 'om-switch', type: 'checkbox', name: 'isolate', checked: draft.isolate, onchange: () => ((draft.isolate = isolate.checked), drawState()) });
  const swarm = h('input', { class: 'om-switch', type: 'checkbox', name: 'swarm', checked: draft.swarm, onchange: () => (draft.swarm = swarm.checked) });
  const note = h('textarea', { class: 'om-input', name: 'note', rows: 2, placeholder: '例如：先讀 README，再動手；不要碰 migrations 資料夾', 'aria-label': '給全部工作者的話', oninput: () => (draft.note = note.value) });

  const MODE_TEXT = {
    brief: { label: '簡報起跑（建議）', help: '每個工作者開一個全新的對話，第一則訊息是簡報：任務、叢集記憶檔的位置、規則，加上主對話最近的內容摘錄（金鑰與權杖字串已去除）。' },
    fork: { label: '完整分叉', help: '每個工作者複製主對話的完整歷史再開工，什麼都記得，但每一個都要先讀完整段歷史。工作者的資料夾是主對話的資料夾。' },
  };

  function drawTasks() {
    fill(
      tasksBox,
      draft.tasks.map((t, i) =>
        h(
          'div',
          { class: 'cluster-task' },
          h(
            'div',
            { class: 'cluster-task-head' },
            h('span', { class: 'cluster-task-no' }, `任務 ${i + 1}`),
            h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: `移除任務 ${i + 1}`, 'aria-label': `移除任務 ${i + 1}`, disabled: draft.tasks.length <= 1, dataset: { action: 'remove-task' }, onclick: () => removeTask(i) }, icon('x')),
          ),
          // Enter in a text box would send the whole form (and spend the quota); here it goes on to the content.
          h('input', { class: 'om-input', type: 'text', name: 'task-title', value: t.title, placeholder: '名稱（留空就用內容的第一行）', 'aria-label': `任務 ${i + 1} 的名稱`, oninput: (e) => ((t.title = e.target.value), (dirty = true), drawState()), onkeydown: (e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), e.target.parentElement.querySelector('textarea')?.focus()) }),
          h('textarea', { class: 'om-input', name: 'task-prompt', rows: 3, placeholder: '要這個工作者做什麼？寫到另一個人不用問你就能開工', 'aria-label': `任務 ${i + 1} 的內容`, oninput: (e) => ((t.prompt = e.target.value), (dirty = true), drawState()) }, t.prompt),
        ),
      ),
    );
    drawState();
  }
  // The pasted lines become tasks at the end of the list (the one empty task a new dialog starts with is replaced).
  function addLines() {
    const parsed = parseTaskLines(lines.value);
    if (!parsed.length) return fill(linesNote, '沒有可以加入的內容：每行一條任務，空行會略過。');
    const kept = draft.tasks.filter((t) => t.title.trim() || t.prompt.trim());
    const room = CLUSTER_MAX_TASKS - kept.length;
    // The name is left empty: it is made from the task's first line when sent (the box says so), so the line is not written twice.
    const taken = parsed.slice(0, Math.max(0, room)).map((t) => ({ title: '', prompt: t.prompt }));
    draft.tasks = [...kept, ...taken];
    if (!draft.tasks.length) draft.tasks = [{ title: '', prompt: '' }];
    lines.value = taken.length < parsed.length ? parsed.slice(taken.length).map((t) => t.prompt).join('\n') : '';
    fill(linesNote, taken.length < parsed.length ? `加了 ${taken.length} 條；最多 ${CLUSTER_MAX_TASKS} 條，其餘 ${parsed.length - taken.length} 條還留在上面的框裡。` : `加了 ${taken.length} 條。`);
    dirty = true;
    drawTasks();
  }
  function addTask() {
    if (draft.tasks.length >= CLUSTER_MAX_TASKS) return;
    draft.tasks.push({ title: '', prompt: '' });
    dirty = true;
    drawTasks();
    tasksBox.lastElementChild?.querySelector('input')?.focus();
  }
  function removeTask(i) {
    if (draft.tasks.length <= 1) return;
    draft.tasks.splice(i, 1);
    drawTasks();
  }
  function drawMode() {
    fill(modeBox, CLUSTER_MODES.map((m) => h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(draft.mode === m), onclick: () => ((draft.mode = m), drawMode(), drawState()) }, MODE_TEXT[m].label)));
    fill(modeHelp, MODE_TEXT[draft.mode].help);
  }
  function drawState() {
    const n = draft.tasks.length;
    count.textContent = `${n} / ${CLUSTER_MAX_TASKS}`;
    addBtn.disabled = n >= CLUSTER_MAX_TASKS;
    for (const b of tasksBox.querySelectorAll('[data-action="remove-task"]')) b.disabled = n <= 1;
    const warns = contextWarnings({ mode: draft.mode, isolate: draft.isolate, context: live().meta?.context, busy: sessionBusy(live().status) });
    fill(warnBox, warns.map((w) => h('div', { class: 'callout small cluster-warn' }, icon('warn'), h('div', { class: 'callout-text' }, w))));
    const problems = draftProblems(draft);
    fill(problemBox, dirty && problems.length ? problems.join('；') : null);
    // The number of workers: what the person chose, or the default that follows the tasks. A box left empty shows the default.
    const w = workersFor(draft);
    if (document.activeElement !== workersInput) workersInput.value = draft.workers === null ? String(w) : String(draft.workers);
    workersInput.placeholder = String(defaultWorkers(n));
    const chosen = draft.workers !== null && Number.isInteger(draft.workers) ? draft.workers : null;
    fill(
      workersHelp,
      chosen !== null && chosen > n && chosen <= CLUSTER_MAX_WORKERS
        ? `任務只有 ${n} 條，所以只會開 ${w} 個工作者。`
        : n > w
          ? `${n} 條任務、${w} 個工作者：每個工作者一次做一條，做完在同一個對話裡自動領下一條。每個工作者是一個要花額度的對話。`
          : `${w} 個工作者各做一條。任務比工作者多時，做完的會自動領下一條。`,
    );
    nameInput.placeholder = autoClusterName(requestBody(draft).tasks) || '留空就用任務的名稱（例如「第一條任務 等 3 條」）';
    const advice = queueAdvice({ tasks: draft.tasks, workers: w, isolate: draft.isolate, mode: draft.mode });
    fill(adviceBox, advice.map((a) => h('div', { class: 'callout small cluster-advice-item', dataset: { advice: a.id } }, icon('sparkle'), h('div', { class: 'callout-text' }, a.text))));
    submit.disabled = sending || problems.length > 0;
    // One task per worker is what it always was; with a queue the label says both numbers.
    submit.textContent = sending ? '派工中…' : n === w ? `派出 ${w} 個工作者` : `派出 ${n} 條任務（${w} 個工作者）`;
    cancel.disabled = sending;
    fields.disabled = sending;
    sendingNote.hidden = !sending;
  }

  // Everything the person typed or chose; locked while the dispatch is on its way.
  const fields = h(
    'fieldset',
    { class: 'cluster-fields' },
    h('p', { class: 'dialog-text settings-lead' }, '把任務分給幾個工作者，各自開一個新的對話同時做；做完可以一鍵合併。每個工作者都是一個要花額度的對話。'),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '叢集名稱（選填）'), nameInput, h('span', { class: 'om-field__help' }, `最多 ${CLUSTER_NAME_MAX} 個字。留空會用任務的名稱自動取；之後可以在叢集頁改名。`)),
    h('div', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '任務'), tasksBox, h('div', { class: 'cluster-tasks-foot' }, count, addBtn)),
    h('div', { class: 'om-field cluster-lines' }, h('label', { class: 'om-field__label' }, '一次貼上多條任務（選填）', lines), h('div', { class: 'cluster-lines-foot' }, linesNote, addLinesBtn)),
    h('div', { class: 'om-field' }, h('label', { class: 'om-field__label' }, '工作者數（1 到 8）', workersInput), workersHelp),
    adviceBox,
    h('div', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '起跑方式'), modeBox, modeHelp),
    h(
      'label',
      { class: 'settings-switch' },
      isolate,
      h('span', null, h('span', { class: 'om-field__label' }, '每個工作者獨立 worktree'), h('span', { class: 'om-field__help' }, '各自一個 git worktree 與分支（cluster/…），不會互相覆蓋，做完可以合併。資料夾不是 git 專案、或沒有 commit 時，會共用同一個資料夾，派完工會在叢集頁說明。')),
    ),
    h(
      'label',
      { class: 'settings-switch', dataset: { nativeSwarm: '' } },
      swarm,
      h('span', null, h('span', { class: 'om-field__label' }, '工作者開啟 Kimi 原生 Swarm 模式'), h('span', { class: 'om-field__help' }, '這裡的 Swarm 是 Kimi 內建的功能（同 /swarm）：每個工作者還可以再派出自己的子代理，用量可能是平常的好幾倍。叢集本身不是 Swarm。')),
    ),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '給全部工作者的話（選填）'), note),
  );
  const form = h('form', { class: 'settings cluster-dialog' }, h('div', { class: 'dialog-title' }, '叢集派工'), fields, warnBox, problemBox, errorBox, sendingNote, h('div', { class: 'dialog-actions' }, cancel, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || draftProblems(draft).length) return;
    sending = true;
    fill(errorBox);
    drawState();
    try {
      const r = await post(`/sessions/${session.id}/cluster`, requestBody(draft));
      const cluster = r?.cluster || r;
      if (!cluster?.id) throw new Error('中控台沒有回傳叢集');
      const warnings = [...new Set([...(cluster.warnings || []), ...(r?.warnings || [])])];
      rememberCluster({ ...cluster, warnings });
      ctx.onCreated?.(cluster);
      if (closed) {
        // The person closed the dialog while it was on its way: do not take them anywhere, but say it exists.
        ctx.toast(`叢集已建立${warnings.length ? `，有 ${warnings.length} 則警告` : ''}`, { action: '查看', onAction: () => ctx.go(clusterHash(cluster.id)) });
        return;
      }
      d.close();
      // One warning is said as it is; several are all on the cluster page, so the toast only counts them.
      if (warnings.length === 1) ctx.toast(warnings[0]);
      else if (warnings.length) ctx.toast(`派工完成，但有 ${warnings.length} 則警告，在叢集頁上方`);
      ctx.go(clusterHash(cluster.id));
    } catch (err) {
      sending = false;
      if (closed) return ctx.fail(err);
      fill(errorBox, err.message || String(err));
      drawState();
    }
  });

  const d = ctx.dialog(form, { wide: true, onClose: () => (closed = true) });
  drawMode();
  drawTasks();
  return d;
}

// ------------------------------------------------- a main conversation's clusters

// "查看叢集": one goes straight to its page, several are listed (newest first).
export async function openClusterList(ctx, session) {
  let list = [];
  try {
    const r = await get(`/sessions/${session.id}/clusters`);
    list = Array.isArray(r) ? r : r?.clusters || [];
  } catch (err) {
    return ctx.fail(err);
  }
  list.forEach(rememberCluster);
  if (!list.length) return ctx.toast('這個對話還沒有派過叢集');
  if (list.length === 1) return ctx.go(clusterHash(list[0].id));
  const d = ctx.dialog(
    h(
      'div',
      { class: 'settings' },
      h('div', { class: 'dialog-title' }, '這個對話的叢集'),
      h(
        'div',
        { class: 'cluster-list' },
        list.map((c) => {
          const { done, total } = progressOf(c);
          return h(
            'a',
            { class: 'cluster-list-item', href: clusterHash(c.id), onclick: () => d.close() },
            h('span', { class: `om-badge${isActive(c) ? ' cluster-badge-busy' : ''}` }, clusterStatusLabel(c.status)),
            h('span', { class: 'cluster-list-text' }, `${clusterNameOf(c)} · ${modeLabel(c.mode)} · 任務 ${done}/${total} 完成`),
            h('span', { class: 'muted' }, relTime(c.createdAt)),
          );
        }),
      ),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '關閉')),
    ),
  );
}

// ------------------------------------------------------------ the page

const TIMING_REFRESH_MS = 10_000;
const DASH = '—';

// The page for one cluster: how far it is and how fast it goes, then its
// workers as small tiles; a tile opens the worker's drawer (the whole task,
// where it works, its time, its subagents). Nothing long sits on the page
// itself. ctx: { confirmDialog, toast, fail, go, parentTitle(id), onTitle(cluster), focusAgent(sid, eventId), modelName, effortLabel }.
export class ClusterPage {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.cluster = clusterById(id);
    this.timings = new Map(); // worker session id -> { timing } | { error }, for the worker whose drawer is open
    this.tiles = new Map(); // worker session id -> WorkerTile
    this.sigs = {}; // what each part of the page was last drawn from
    this.busy = null; // 'stop' | 'merge' | 'cleanup' | 'unhide' | 'purge' | 'rename' while that request is out
    this.actionError = ''; // what the Hub said to the last stop / merge it refused
    this.started = false; // the first cluster has come in: the memory is then read
    this.memSeen = null; // { bytes, updatedAt } of the memory file as last read
    this.memAsked = ''; // the change of the file the page last tried to read
    this.fold = { queue: false, memory: false }; // which of the folded parts the person opened
    this.dead = false;
    this.sig = '';
    this.nameRow = h('div', { class: 'ch-namerow' });
    this.resultBox = h('div', { class: 'cluster-purge-slot' }); // the outcome of the last full purge
    this.result = null; // { r, name }
    this.gone = false; // the cluster was purged: only the result is left to show
    this.headTop = h('div', { class: 'ch-top' });
    this.bar = barEl('ch-bar');
    this.elapsed = h('span', { class: 'ch-elapsed', dataset: { field: 'elapsed' } });
    this.stats = { output: this.statBox('output', '叢集總產出', { avg: true, share: true }), workers: this.statBox('workers', '執行中工作者'), subs: this.statBox('subagents', '執行中子代理') };
    this.facts = h('div', { class: 'ch-facts' });
    this.head = h('div', { class: 'cluster-head' }, this.nameRow, this.headTop, h('div', { class: 'ch-barrow' }, this.bar, this.elapsed), h('div', { class: 'ch-stats' }, this.stats.output.el, this.stats.workers.el, this.stats.subs.el), this.facts);
    this.warns = h('div', { class: 'cluster-warns' });
    this.workers = h('div', { class: 'cluster-workers' });
    this.count = h('span', { class: 'muted cluster-workers-count' });
    this.queueBox = h('div', { class: 'cluster-queue-slot' });
    this.mergeBox = h('div', { class: 'cluster-merge-slot' });
    this.cleanupBox = h('div', { class: 'cluster-cleanup-slot' });
    this.memoryBox = h('details', { class: 'cluster-fold cluster-memory', ontoggle: (e) => (this.fold.memory = e.target.open) });
    this.body = h('div', { class: 'cluster-body' });
    this.el = h('div', { class: 'cluster-page' }, this.body);
    this.drawer = new WorkerDrawer({ ctx, cleanupState: (w) => this.cleanupSlot(w), onNeedTiming: (sid) => this.loadTiming(sid), timingOf: (sid) => this.timings.get(sid) });
    this.buildMemory();
    // Time is asked for only for the worker whose drawer is open.
    this.timer = setInterval(() => document.visibilityState === 'visible' && this.cluster && isActive(this.cluster) && this.drawer.isOpen && this.loadTiming(this.drawer.sid), TIMING_REFRESH_MS);
    this.clock = setInterval(() => this.drawElapsed(), 1000);
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    clearInterval(this.clock);
    this.drawer.destroy();
  }

  // The cluster, from the Hub. A cluster this page already knows (just made, or
  // pushed down the socket) is drawn at once and corrected by the answer.
  async load() {
    if (this.cluster) this.draw();
    else fill(this.body, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    try {
      const c = await get(`/clusters/${this.id}`);
      if (this.dead) return;
      this.update(c);
    } catch (err) {
      if (this.dead) return;
      if (this.cluster) return this.ctx.fail(err);
      fill(
        this.body,
        h(
          'div',
          { class: 'cluster-none' },
          h('div', { class: 'large-title' }, err.status === 404 ? '沒有這個叢集' : '叢集讀不到'),
          h('p', { class: 'home-lead' }, err.status === 404 ? '網址可能打錯了，或這個叢集已經不在中控台。' : err.message),
          h('button', { class: 'om-btn', type: 'button', dataset: { action: 'retry' }, onclick: () => this.load() }, '再試一次'),
        ),
      );
    }
  }

  // A cluster arrived (from the Hub or down the socket); other clusters' news is not ours.
  update(c) {
    if (this.dead || this.gone || !c || c.id !== this.id) return;
    const first = !this.started;
    this.started = true;
    this.cluster = rememberCluster(c);
    this.draw();
    // The open drawer's time is asked for again when its worker's state moved.
    const sig = JSON.stringify((c.workers || []).map((w) => [w.sessionId, w.status, w.finishedAt]));
    if (this.drawer.isOpen && sig !== this.sig) this.loadTiming(this.drawer.sid);
    if (first) this.loadMemory();
    else this.followMemory(c.memory);
    this.sig = sig;
  }

  // The Hub says (in the cluster it sends) how big the memory file is and when it changed. A worker wrote to
  // it: read it again, once for each change (a read that fails is not tried again until the file changes).
  followMemory(m) {
    if (!m || !this.memSeen) return;
    const sig = `${m.bytes}|${m.updatedAt}`;
    if (sig === `${this.memSeen.bytes}|${this.memSeen.updatedAt}` || sig === this.memAsked) return;
    this.memAsked = sig;
    this.loadMemory();
  }

  // ---- drawing

  // Each part is drawn again only when what it shows changed. Progress comes a
  // few times a second while workers run; a tile, a button or a text being
  // selected must not be torn down for a line that moved somewhere else.
  draw() {
    const c = this.cluster;
    if (!c) return;
    this.ctx.onTitle?.(c);
    if (this.body.firstChild !== this.resultBox) {
      fill(
        this.body,
        this.resultBox,
        this.head,
        this.warns,
        h('section', { class: 'cluster-section' }, h('div', { class: 'cluster-section-title' }, h('span', null, '工作者'), this.count), this.workers),
        this.mergeBox,
        this.cleanupBox,
        this.queueBox,
        this.memoryBox,
      );
      this.sigs = {};
    }
    this.drawResult();
    this.drawHead();
    this.drawStats();
    this.drawWarnings();
    this.drawWorkers();
    this.drawQueue();
    this.drawMerge();
    this.drawCleanup();
    this.drawer.update(c);
  }

  changed(part, value) {
    const sig = JSON.stringify(value);
    if (this.sigs[part] === sig) return false;
    this.sigs[part] = sig;
    return true;
  }

  // One of the big numbers under the progress bar; its parts are updated in place (they change every second).
  // `avg`: a second small line under the first (the five-minute average beside the last minute's output).
  statBox(key, label, { avg = false, share = false } = {}) {
    const num = h('span', { class: 'ch-stat-num', dataset: { field: 'num' } });
    const unit = h('span', { class: 'ch-stat-unit' });
    const sub = h('div', { class: 'ch-stat-sub', dataset: { field: 'sub' } });
    const second = avg ? h('div', { class: 'ch-stat-sub ch-stat-avg', dataset: { field: 'avg' } }) : null;
    // (the share of time the workers spend writing: shown only where it can be worked out)
    const third = share ? h('div', { class: 'ch-stat-sub ch-stat-share', dataset: { field: 'gen-share' }, hidden: true }) : null;
    const el = h('div', { class: 'ch-stat', dataset: { stat: key } }, h('div', { class: 'ch-stat-label' }, label), h('div', { class: 'ch-stat-value' }, num, unit), sub, second, third);
    return { el, num, unit, sub, avg: second, share: third };
  }

  setStat(box, { num, unit = '', sub = '', title = '', live = false, none = false, avg = '', avgTitle = '', share = null }) {
    if (box.num.textContent !== num) box.num.textContent = num;
    if (box.unit.textContent !== unit) box.unit.textContent = unit;
    if (box.sub.textContent !== sub) box.sub.textContent = sub;
    if (box.avg) {
      if (box.avg.textContent !== avg) box.avg.textContent = avg;
      box.avg.title = avgTitle;
    }
    if (box.share) {
      const text = share?.shown ? share.text : '';
      if (box.share.textContent !== text) box.share.textContent = text;
      box.share.hidden = !share?.shown;
      box.share.title = share?.shown ? share.title : '';
    }
    box.el.title = title;
    box.el.classList.toggle('live', live);
    box.el.classList.toggle('none', none);
  }

  drawStats() {
    const c = this.cluster;
    const sum = summarizeCluster(c);
    // 叢集總產出: the last minute of every agent of the cluster, subagents included (the Hub's one window); beside it, small, the five-minute 平均產出 it used to say.
    const out = outputView(sum.throughput, { active: isActive(c) });
    const avg = speedView(sum.speed);
    const part = sum.speed.workersMeasured < sum.speed.workers ? `・${sum.speed.workersMeasured}/${sum.speed.workers} 個工作者量得到` : '';
    this.setStat(this.stats.output, {
      num: out.num,
      unit: out.unit,
      sub: out.sub,
      title: out.measured ? out.tip : `量不到：${out.why}`,
      live: out.measured && isActive(c),
      none: !out.measured,
      avg: avg.measured ? `平均產出（最近 5 分鐘）${avg.text}${part}` : '平均產出（最近 5 分鐘）—',
      avgTitle: avg.measured ? [avg.tip, sum.speed.requestsPerMinute !== null ? `請求 ${speedView({ tokensPerSecond: 0, requestsPerMinute: sum.speed.requestsPerMinute }).requests.replace('請求 ', '')}` : null].filter(Boolean).join('；') : `量不到：${avg.why}`,
      share: genShareView(c),
    });
    this.setStat(this.stats.workers, { num: String(sum.workersRunning), unit: `／${sum.workers}`, sub: '個在工作', live: sum.workersRunning > 0 });
    const sub = sum.subagents;
    this.setStat(this.stats.subs, sub ? { num: String(sub.running + sub.awaiting), sub: `共開過 ${sub.total + sub.older} 個${sub.awaiting ? `・${sub.awaiting} 個等你核准` : ''}`, live: sub.running + sub.awaiting > 0 } : { num: DASH, sub: '量不到', none: true });
    const bar = taskBar(c);
    const { done, total } = progressOf(c);
    if (this.changed('bar', [bar, done, total])) this.bar.set(bar, `任務 ${done}／${total} 完成`);
    this.drawElapsed();
  }

  drawElapsed() {
    const c = this.cluster;
    if (!c || this.dead) return;
    const text = elapsedText(c, Date.now());
    const label = text ? `${isActive(c) ? '已跑' : '共跑'} ${text}` : DASH;
    if (this.elapsed.textContent !== label) this.elapsed.textContent = label;
  }

  drawHead() {
    const c = this.cluster;
    const { done, total, failed, deleted } = progressOf(c);
    const merge = mergeAvailability(c, Boolean(this.busy));
    const cleanup = cleanupAvailability(c, Boolean(this.busy));
    const purge = purgeAvailability(c, Boolean(this.busy));
    const stoppable = isStoppable(c) && !this.busy;
    // The page may know the main conversation's title better than the cluster's last news (it was renamed since).
    const parentTitle = c.parentId ? this.ctx.parentTitle?.(c.parentId) || '' : '';
    const name = clusterNameOf(c, c.name ? '' : parentTitle);
    const pl = parentLine(c, parentTitle);
    // The heading over the tiles counts workers; `total` counts tasks once a queue is used.
    this.count.textContent = `${(c.workers || []).length} 個`;
    // The "x minutes ago" moves on by itself, so it is part of what this is drawn from.
    if (!this.changed('head', [c.status, done, total, failed, deleted, c.mode, c.isolate, c.swarm, c.parentId, name, pl, merge, cleanup, purge, Boolean(c.purge?.partial), stoppable, this.busy, this.actionError, Math.floor(Date.now() / 60_000), (c.workers || []).some((w) => w.branch), c.steps, c.stepsUnknown])) return;
    const parent = c.parentId;
    fill(
      this.nameRow,
      h('div', { class: 'ch-nameline' }, h('h2', { class: 'ch-name', dataset: { field: 'name' }, title: name }, name), h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', dataset: { action: 'rename' }, 'aria-label': '重新命名叢集', title: '重新命名', disabled: Boolean(this.busy) || c.status === 'purging', onclick: () => this.rename() }, icon('pencil'))),
      // The main conversation is the small line under the name (a link while it exists).
      pl.text ? (pl.gone || !parent ? h('div', { class: 'ch-parent gone', dataset: { field: 'parent' } }, pl.text) : h('a', { class: 'linklike ch-parent', href: `#/s/${parent}`, dataset: { action: 'open-parent', field: 'parent' }, title: '回主對話' }, pl.text)) : null,
    );
    fill(
      this.headTop,
      h(
        'div',
        { class: 'ch-title' },
        h('span', { class: `om-badge ${CLUSTER_BADGE[c.status] || ''}`, dataset: { field: 'status' } }, clusterStatusLabel(c.status)),
        h('span', { class: 'cluster-progress', dataset: { field: 'progress' } }, `任務 ${done}/${total} 完成`),
        failed ? h('span', { class: 'om-badge om-badge--danger' }, failedText(c, failed)) : null,
        deleted ? h('span', { class: 'om-badge' }, `${deleted} 個已刪除`) : null,
        c.purge?.partial ? h('span', { class: 'om-badge om-badge--warning', dataset: { field: 'purge-partial' }, title: (c.purge.failed || []).join('\n') }, '部分清除') : null,
      ),
      h(
        'div',
        { class: 'cluster-actions' },
        h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', dataset: { action: 'stop' }, 'aria-label': '全部停止', disabled: !stoppable, title: stoppable ? '中斷每個工作者目前這一輪（對話、分支與 worktree 都保留）' : '叢集已經不在跑了', onclick: () => this.stop() }, icon('stop'), h('span', { class: 'btn-label' }, '全部停止')),
        h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'button', dataset: { action: 'merge' }, 'aria-label': '合併工作者分支', disabled: !merge.ok, title: merge.why, onclick: () => this.merge() }, icon('branch'), h('span', { class: 'btn-label' }, '合併工作者分支')),
        h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'cleanup' }, 'aria-label': '清理', disabled: !cleanup.ok, title: cleanup.why, onclick: () => this.cleanup() }, icon('sparkle'), h('span', { class: 'btn-label' }, '清理')),
        h('button', { class: 'om-btn om-btn--sm om-btn--destructive cluster-purge-btn', type: 'button', dataset: { action: 'purge' }, 'aria-label': c.purge?.partial ? '再清除一次' : '完全清除', disabled: !purge.ok, title: purge.why, onclick: () => this.purge() }, icon('trash'), h('span', { class: 'btn-label' }, c.purge?.partial ? '再清除一次' : '完全清除')),
      ),
    );
    fill(
      this.facts,
      h('span', null, `建立於 ${relTime(c.createdAt)}`),
      // 共 N 步: its own steps, as the chat room counts them (follows every pushed cluster).
      stepsView(c.steps, c.stepsUnknown).shown ? h('span', { dataset: { field: 'steps' }, title: stepsView(c.steps, c.stepsUnknown).title }, stepsView(c.steps, c.stepsUnknown).long) : null,
      h('span', null, modeLabel(c.mode)),
      h('span', null, c.isolate ? '每個工作者獨立 worktree' : '共用同一個資料夾'),
      nativeSwarm(c.swarm),
      c.isolate && (c.workers || []).some((w) => w.branch) ? null : h('div', { class: 'om-field__help ch-note', dataset: { field: 'no-merge' } }, '沒有獨立 worktree，沒有分支可以合併；工作者改的都在同一個資料夾裡。'),
      this.actionError ? h('div', { class: 'om-field__error cluster-error ch-note', role: 'alert' }, this.actionError) : null,
    );
  }

  // The outcome of the last full purge, over the cluster (when it is partly purged the cluster is still under it).
  drawResult() {
    const r = this.result;
    if (!this.changed('result', [r?.r, this.gone])) return;
    if (!r) return fill(this.resultBox);
    const el = purgeResultEl(r.r, { name: r.name, ctx: this.ctx });
    fill(
      this.resultBox,
      el,
      this.gone
        ? h('div', { class: 'cluster-gone' }, h('p', { class: 'om-field__help' }, '這個叢集已經從總覽移除了。'), h('a', { class: 'om-btn om-btn--primary', href: '#/clusters', dataset: { action: 'back-to-list' } }, '回叢集總覽'))
        : h('div', { class: 'cluster-purge-actions' }, h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'dismiss-result' }, onclick: () => ((this.result = null), this.drawResult()) }, '知道了')),
    );
  }

  drawWarnings() {
    const warnings = this.cluster.warnings || [];
    if (!this.changed('warnings', warnings)) return;
    fill(this.warns, warnings.map((w) => h('div', { class: 'callout small cluster-warn' }, icon('warn'), h('div', { class: 'callout-text' }, w))));
  }

  // One small tile per worker, kept as long as the worker is; every part of
  // it is updated in place. Pressing it opens the drawer.
  drawWorkers() {
    const list = this.cluster.workers || [];
    const els = [];
    const seen = new Set();
    for (const w of list) {
      let tile = this.tiles.get(w.sessionId);
      if (!tile) this.tiles.set(w.sessionId, (tile = new WorkerTile({ sessionId: w.sessionId, onOpen: (sid, opener) => this.openWorker(sid, opener) })));
      tile.update(w, this.cluster);
      els.push(tile.el);
      seen.add(w.sessionId);
    }
    for (const id of [...this.tiles.keys()]) if (!seen.has(id)) this.tiles.delete(id);
    const now = [...this.workers.children];
    if (now.length !== els.length || now.some((e, i) => e !== els[i])) this.workers.replaceChildren(...els);
  }

  openWorker(sid, opener) {
    this.drawer.cluster = this.cluster;
    this.drawer.open(sid, opener);
  }

  // What the clean-up did to one worker, and the way back to the sidebar: in its drawer.
  cleanupSlot(w) {
    const view = cleanupResultView(this.cluster?.cleanup?.results?.find((r) => r.sessionId === w.sessionId));
    return view ? h('div', { class: 'cluster-worker-cleanup' }, this.cleanupState(view, w)) : null;
  }

  // 任務佇列: every task, its state, who does it and when it started and ended (the Hub's clock). Folded.
  drawQueue() {
    const c = this.cluster;
    const view = queueView(c);
    if (!this.changed('queue', [view.rows, view.neverSent])) return;
    if (!view.rows.length) return fill(this.queueBox);
    const { sum } = view;
    const worker = (r) => (r.workerNo === null ? null : h('span', { class: 'cluster-chip', title: r.workerTitle || '', dataset: { field: 'task-worker' } }, `w${r.workerNo}`));
    const times = (r) => {
      if (!r.started) return null;
      const bits = [`開始 ${r.started}`];
      if (r.ended) bits.push(`結束 ${r.ended}`);
      if (r.span) bits.push(`用了 ${r.span}`);
      return bits.join(' · ');
    };
    // (Whether the person had it open is read from the box being replaced: the toggle event that says it comes a moment after.)
    const was = this.queueBox.querySelector('details');
    if (was) this.fold.queue = was.open;
    fill(
      this.queueBox,
      h(
        'details',
        { class: 'cluster-fold cluster-queue', open: this.fold.queue, ontoggle: (e) => (this.fold.queue = e.target.open) },
        h('summary', null, h('span', { class: 'cf-title' }, '任務佇列'), h('span', { class: 'muted', dataset: { field: 'queue-sum' } }, `${sum.done}/${sum.total} 完成${sum.running ? ` · ${sum.running} 條進行中` : ''}${sum.pending ? ` · ${sum.pending} 條等待中` : ''}${sum.failed ? ` · ${sum.failed} 條失敗` : ''}`)),
        h('div', { class: 'cf-body' },
        h('div', { class: 'om-field__help' }, '工作者做完一條，會在同一個對話裡自動領下一條；時間是中控台自己的時鐘：交給工作者的那一刻，到看見它停下的那一刻。'),
        view.neverSent ? h('div', { class: 'callout small cluster-warn', dataset: { field: 'never-sent' }, role: 'status' }, icon('warn'), h('div', { class: 'callout-text' }, `已經停止派工：還有 ${view.neverSent} 條任務沒有派出去，不會再自動派。`)) : null,
        h(
          'ol',
          { class: 'cluster-queue-list' },
          view.rows.map((r) =>
            h(
              'li',
              { class: 'cluster-queue-row', dataset: { task: String(r.index), status: r.status } },
              h('div', { class: 'cluster-queue-main' }, h('span', { class: 'cluster-queue-no' }, `#${r.no}`), h('span', { class: 'cluster-queue-title', title: r.title }, r.title), worker(r), h('span', { class: `om-badge ${TONE_BADGE[r.tone] || ''}`, dataset: { field: 'task-status' } }, r.label)),
              times(r) ? h('div', { class: 'cluster-queue-times muted', dataset: { field: 'task-times' } }, times(r)) : null,
              r.handedBack && r.status !== 'failed' ? h('div', { class: 'cluster-queue-note om-field__help', dataset: { field: 'task-note' } }, r.status === 'pending' ? r.error || '退回佇列等別的工作者接手' : '這條已經退回佇列重派過一次。') : null,
              r.status === 'failed' && r.error ? h('div', { class: 'cluster-queue-note om-field__error', dataset: { field: 'task-note' } }, r.error) : null,
            ),
          ),
        ),
        ),
      ),
    );
  }

  drawMerge() {
    const m = this.cluster.merge;
    const workers = this.cluster.workers || [];
    if (!this.changed('merge', [m, workers.map((w) => [w.sessionId, w.title])])) return;
    if (!m) return fill(this.mergeBox);
    const title = (sid) => workers.find((w) => w.sessionId === sid)?.title || sid;
    // A worker that did not go in either clashed (files listed) or failed for another reason (the Hub says which).
    const badge = (r) => (r.ok ? '已合併' : r.conflicts?.length ? `衝突 ${r.conflicts.length} 個檔案` : '合併失敗');
    fill(
      this.mergeBox,
      h(
        'section',
        { class: 'cluster-section cluster-merge' },
        h('div', { class: 'cluster-section-title' }, h('span', null, '合併結果'), h('span', { class: 'muted' }, relTime(m.at))),
        h('div', { class: 'cluster-merge-branch' }, '合併到新分支 ', h('code', { dataset: { field: 'merge-branch' } }, m.branch), '（主對話正在用的分支沒有被動到）'),
        h('div', { class: 'om-field__help' }, '每個叢集只合併一次：第一版不支援重新合併。'),
        h(
          'ul',
          { class: 'cluster-merge-list' },
          (m.results || []).map((r) =>
            h(
              'li',
              { class: r.ok ? 'ok' : 'fail', dataset: { session: r.sessionId, ok: String(Boolean(r.ok)) } },
              h('div', { class: 'cluster-merge-row' }, h('span', { class: 'cluster-merge-name' }, title(r.sessionId)), h('span', { class: `om-badge ${r.ok ? 'om-badge--success' : 'om-badge--danger'}` }, badge(r))),
              h('code', { class: 'cluster-merge-branchname' }, r.branch),
              !r.ok && r.conflicts?.length ? h('ul', { class: 'cluster-conflicts' }, r.conflicts.map((p) => h('li', null, h('code', null, p)))) : null,
              !r.ok && r.error ? h('div', { class: 'om-field__error' }, r.error) : null,
              !r.ok ? h('div', { class: 'om-field__help' }, '這個工作者沒有合進去，合併已中止；其餘照常。') : null,
            ),
          ),
        ),
      ),
    );
  }

  // The three facts about one worker after a clean-up, why anything was kept, and the button that puts it back.
  cleanupState(view, w) {
    const chip = (field, text, tone) => h('span', { class: `om-badge ${tone}`, dataset: { field } }, text);
    const part = (field, label, p) => (p ? chip(field, `${label}${p.text}`, p.kept ? 'om-badge--warning' : 'om-badge--success') : null);
    return [
      h('div', { class: 'cluster-cleanup-state' }, part('cleanup-worktree', 'worktree ', view.worktree), part('cleanup-branch', '分支', view.branch), chip('cleanup-hidden', view.hidden ? '已從側欄收起' : '在側欄', view.hidden ? '' : 'cluster-badge-busy')),
      view.reasons.length ? h('ul', { class: 'cluster-cleanup-reasons om-field__help' }, view.reasons.map((r) => h('li', null, r))) : null,
      view.worktree && !view.worktree.kept ? h('div', { class: 'om-field__help cluster-cleanup-gone' }, '它的 worktree 已移除：對話的紀錄還在，要接著改檔請另開對話。') : null,
      view.hidden && w.status !== 'deleted' ? h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'unhide', session: w.sessionId }, onclick: () => this.unhide(w.sessionId) }, '放回側欄') : null,
    ];
  }

  drawCleanup() {
    const c = this.cluster;
    const cl = c.cleanup;
    const workers = c.workers || [];
    if (!this.changed('cleanup', [cl, workers.map((w) => [w.sessionId, w.title, w.worktree, w.status === 'deleted']), Math.floor(Date.now() / 60_000), Boolean(this.busy)])) return;
    if (!cl) return fill(this.cleanupBox);
    const views = (cl.results || []).map((r) => ({ v: cleanupResultView(r), w: workers.find((x) => x.sessionId === r.sessionId) })).filter((x) => x.v);
    const count = (f) => views.filter(f).length;
    const kept = views.filter((x) => x.v.kept);
    const summary = [`${count((x) => x.v.worktree && !x.v.worktree.kept)} 個 worktree 已移除`, `${count((x) => x.v.branch && !x.v.branch.kept)} 個分支已刪除`, `${count((x) => x.v.hidden)} 個對話已從側欄收起`, kept.length ? `${kept.length} 個工作者有東西保留` : null].filter(Boolean).join(' · ');
    const anyHidden = views.some((x) => x.v.hidden && x.w?.status !== 'deleted');
    fill(
      this.cleanupBox,
      h(
        'section',
        { class: 'cluster-section cluster-cleanup' },
        h('div', { class: 'cluster-section-title' }, h('span', null, '清理結果'), h('span', { class: 'muted' }, `${cl.auto ? '合併全部成功後自動執行' : '手動'} · ${relTime(cl.at)}`)),
        h('div', { class: 'cluster-cleanup-summary', dataset: { field: 'cleanup-summary' } }, summary),
        h('div', { class: 'om-field__help' }, `${c.merge ? `${c.merge.branch} 與` : ''}叢集記憶檔都沒有動。工作者的對話沒有刪：從各工作者卡片的「開啟對話」進去；收起的可以放回側欄。`),
        kept.length
          ? h(
              'div',
              { class: 'cluster-cleanup-kept' },
              h('div', { class: 'cluster-cleanup-kept-title' }, '留下來的（沒有動，請你處理）'),
              h(
                'ul',
                null,
                kept.map(({ v, w }) =>
                  h(
                    'li',
                    { dataset: { session: w?.sessionId || '' } },
                    h('span', { class: 'cluster-merge-name' }, w?.title || ''),
                    w?.worktree ? h('code', null, w.worktree) : null,
                    h('ul', { class: 'cluster-cleanup-reasons om-field__help' }, v.reasons.map((r) => h('li', null, r))),
                  ),
                ),
              ),
            )
          : null,
        anyHidden ? h('div', { class: 'cluster-cleanup-actions' }, h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'unhide-all' }, onclick: () => this.unhide() }, '全部放回側欄')) : null,
      ),
    );
  }

  // ---- time

  // The time breakdown of one worker's conversation (spec §5): asked for when its drawer opens, again now and then while it is open.
  async loadTiming(sid) {
    if (!sid || this.dead) return;
    const w = (this.cluster?.workers || []).find((x) => x.sessionId === sid);
    if (!w || w.status === 'deleted') return;
    try {
      this.timings.set(sid, { timing: await get(`/sessions/${sid}/timing`) });
    } catch (err) {
      this.timings.set(sid, { error: err });
    }
    if (!this.dead && this.cluster) this.drawer.update(this.cluster);
  }

  // ---- stop and merge

  async stop() {
    if (this.busy) return;
    const ok = await this.ctx.confirmDialog({ title: '要停止全部工作者嗎？', body: '會中斷每個工作者目前這一輪。對話、分支與 worktree 都會保留，之後還可以開著繼續。', action: '全部停止', destructive: true });
    if (ok) await this.run('stop');
  }

  async merge() {
    if (this.busy) return;
    const c = this.cluster;
    const tasks = Array.isArray(c.tasks) ? c.tasks : [];
    const unfinished = tasks.length ? tasks.filter((t) => t.status === 'pending' || t.status === 'running').length : (c.workers || []).filter((w) => !w.finishedAt && w.status !== 'deleted').length;
    const body = `會從主對話目前的 HEAD 開新分支 cluster/${c.id}/merged，依工作者的順序合併各自的分支；只會合進各分支上已 commit 的內容。不動主對話正在用的分支與工作樹。有衝突的工作者會跳過並列出檔案，其餘照常合併。\n\n如果全部工作者都合併成功，會接著自動清理：移除乾淨的 worktree、刪除已經併進去的工作者分支、把工作者對話從側欄收起（對話不會刪）；有未提交修改、或沒合進去的工作者會原封不動留著。${unfinished ? `\n\n還有 ${unfinished} ${tasks.length ? '條任務' : '個工作者'}沒做完，之後才 commit 的內容不會在這次合併裡。` : ''}`;
    const ok = await this.ctx.confirmDialog({ title: '要合併各工作者的分支嗎？', body, action: '合併' });
    if (ok) await this.run('merge');
  }

  // 清理: ask the Hub what it would do (a dry run), list it, and only then do it.
  async cleanup() {
    if (this.busy) return;
    this.busy = 'cleanup';
    this.actionError = '';
    this.drawHead();
    let plan;
    try {
      plan = await get(`/clusters/${this.id}/cleanup/plan`);
    } catch (err) {
      this.busy = null;
      this.actionError = err.message || String(err);
      this.drawHead();
      return;
    }
    this.busy = null;
    this.drawHead();
    if (this.dead) return;
    if (await this.confirmCleanup(plan)) await this.run('cleanup');
  }

  confirmCleanup(plan) {
    const c = this.cluster;
    const view = cleanupPlanView(plan, c.workers);
    const t = view.totals;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        d.close();
        resolve(v);
      };
      const summary = view.nothing
        ? `現在沒有可以清理的東西${t.kept ? '：有東西要保留的工作者都列在下面，原因寫在旁邊' : ''}。`
        : `會移除 ${t.worktrees} 個 worktree、刪除 ${t.branches} 個分支、從側欄收起 ${t.hidden} 個工作者對話；保留 ${t.kept} 個工作者。`;
      const rows = view.rows.map((r) => {
        const path = c.workers.find((w) => w.sessionId === r.sessionId)?.worktree;
        return h(
          'li',
          { dataset: { session: r.sessionId, keeps: String(r.keeps) } },
          h('div', { class: 'cluster-merge-row' }, h('span', { class: 'cluster-merge-name' }, r.title), h('span', { class: `om-badge ${r.keeps ? 'om-badge--warning' : r.will.length ? 'om-badge--success' : ''}` }, r.keeps ? '保留' : r.will.length ? '清理' : '沒有要做的')),
          r.will.length ? h('div', { class: 'om-field__help' }, r.will.join('、')) : null,
          r.keeps ? [path ? h('code', null, path) : null, h('ul', { class: 'cluster-cleanup-reasons om-field__help' }, r.reasons.map((x) => h('li', null, x)))] : null,
        );
      });
      const d = this.ctx.dialog(
        h(
          'div',
          { class: 'alert cluster-cleanup-dialog' },
          h('div', { class: 'om-alert__title' }, '要清理這個叢集嗎？'),
          h('p', { class: 'cluster-cleanup-summary' }, summary),
          h('p', { class: 'om-field__help cluster-cleanup-note' }, `${c.merge ? `合併用的分支 ${c.merge.branch} 與` : ''}叢集記憶檔都會保留。對話不會刪，只是從側欄收起，之後可以在這一頁開啟（看紀錄），或「放回側欄」；worktree 移除後，要接著改檔請另開對話。`),
          h('p', { class: 'om-field__help cluster-cleanup-note' }, '只有乾淨的 worktree（沒有未提交的修改、沒有未追蹤的檔案）會移除；被 .gitignore 忽略的檔案（例如 node_modules）會跟著 worktree 一起移除。分支要它的 commit 都已經在合併分支或主對話的 HEAD 上才會刪。'),
          h('ul', { class: 'cluster-cleanup-list' }, rows),
          h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => finish(false) }, '取消'), h('button', { class: 'om-btn om-btn--destructive', type: 'button', disabled: view.nothing, onclick: () => finish(true) }, '清理')),
        ),
        { wide: true, onClose: () => finish(false) },
      );
    });
  }

  // 放回側欄: one worker's conversation, or (no id) all of them.
  async unhide(sessionId) {
    if (this.busy) return;
    await this.run('unhide', sessionId ? { sessionId } : {});
  }

  async run(what, body) {
    this.busy = what;
    this.actionError = '';
    this.drawHead();
    try {
      const r = await post(`/clusters/${this.id}/${what}`, body);
      const next = r?.cluster || (r?.id === this.id ? r : null) || (await get(`/clusters/${this.id}`));
      this.busy = null;
      this.update(next);
    } catch (err) {
      this.busy = null;
      this.actionError = err.message || String(err);
      this.drawHead();
    }
  }

  // ---- the name

  // The pencil: a small dialog with the name in a box. The Hub refuses a blank or too long one (400) and says so there.
  rename() {
    if (this.busy || this.gone) return;
    const c = this.cluster;
    const input = h('input', { class: 'om-input', type: 'text', name: 'cluster-name', value: clusterNameOf(c), maxLength: CLUSTER_NAME_MAX, autocomplete: 'off', autofocus: true, 'aria-label': '叢集名稱' });
    const error = h('div', { class: 'om-field__error', role: 'alert', dataset: { field: 'rename-error' } });
    const save = h('button', { class: 'om-btn om-btn--primary', type: 'submit', dataset: { action: 'rename-save' } }, '儲存');
    const form = h(
      'form',
      {
        class: 'settings cluster-rename-dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = cleanClusterName(input.value);
          fill(error);
          if (!name) return fill(error, '名稱不能是空的');
          if (Array.from(name).length > CLUSTER_NAME_MAX) return fill(error, `名稱最多 ${CLUSTER_NAME_MAX} 個字`);
          save.disabled = true;
          try {
            const next = await post(`/clusters/${this.id}/name`, { name });
            d.close();
            this.update(next);
          } catch (err) {
            save.disabled = false;
            fill(error, err.message || String(err));
          }
        },
      },
      h('div', { class: 'dialog-title' }, '重新命名叢集'),
      h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '叢集名稱'), input, h('span', { class: 'om-field__help' }, `最多 ${CLUSTER_NAME_MAX} 個字。只改叢集的名字，不影響工作者、分支或主對話。`)),
      error,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), save),
    );
    const d = this.ctx.dialog(form);
  }

  // ---- 完全清除

  // Ask the Hub what it would do (a dry run), say it with the three boxes, and only then do it.
  async purge() {
    if (this.busy || this.gone) return;
    this.busy = 'purge';
    this.actionError = '';
    this.drawHead();
    let plan;
    try {
      plan = await get(`/clusters/${this.id}/purge/plan`);
    } catch (err) {
      this.busy = null;
      this.actionError = err.message || String(err);
      this.drawHead();
      return;
    }
    this.busy = null;
    this.drawHead();
    if (this.dead) return;
    const name = clusterNameOf(this.cluster);
    const opts = await confirmPurge(this.ctx, [{ id: this.id, name, plan }]);
    if (!opts || this.dead) return;
    this.busy = 'purge';
    this.drawHead();
    try {
      const r = await post(`/clusters/${this.id}/purge`, opts);
      this.busy = null;
      await this.showResult(r, name);
    } catch (err) {
      this.busy = null;
      this.actionError = err.message || String(err);
      this.drawHead();
    }
  }

  // The result goes over the cluster. Purged away: it is all that is left of the page. Partly: the cluster is under it, marked.
  async showResult(r, name) {
    this.result = { r, name };
    if (r.removed) {
      this.gone = true;
      forgetCluster(this.id);
      this.drawResult();
      return fill(this.body, this.resultBox);
    }
    this.drawResult();
    try {
      this.update(await get(`/clusters/${this.id}`));
    } catch {}
  }

  // Told (down the socket) that this cluster no longer exists.
  removed() {
    if (this.dead || this.gone) return;
    this.gone = true;
    forgetCluster(this.id);
    if (!this.result) {
      this.result = null;
      fill(this.body, h('div', { class: 'cluster-none' }, h('div', { class: 'large-title' }, '這個叢集已被清除'), h('p', { class: 'home-lead' }, '它的工作者對話、worktree 與記憶檔都已刪除（備份保留 7 天，見叢集總覽）。'), h('a', { class: 'om-btn om-btn--primary', href: '#/clusters', dataset: { action: 'back-to-list' } }, '回叢集總覽')));
    }
  }

  // ---- memory (spec §3)

  buildMemory() {
    this.memText = h('pre', { class: 'cluster-memory-text' });
    this.memPath = h('code', { class: 'cluster-memory-path' });
    this.memMeta = h('span', { class: 'muted cluster-memory-meta' });
    this.memNone = h('div', { class: 'cluster-memory-none om-field__help', hidden: true });
    this.memError = h('div', { class: 'om-field__error cluster-error', role: 'alert' });
    this.memTruncated = h('p', { class: 'om-field__help cluster-memory-truncated', hidden: true });
    this.decision = h('textarea', { class: 'om-input', name: 'decision', rows: 2, maxLength: MEMORY_MAX_CHARS, placeholder: '例如：登入改用 cookie，不用 token', 'aria-label': '要追加的主對話決定', oninput: () => this.drawAdd() });
    this.addBtn = h('button', { class: 'om-btn om-btn--primary', type: 'submit', dataset: { action: 'add-memory' }, disabled: true }, '追加到記憶');
    this.reloadBtn = h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'reload-memory' }, onclick: () => this.loadMemory() }, icon('refresh'), '重新讀取');
    const form = h('form', { class: 'cluster-memory-add', onsubmit: (e) => (e.preventDefault(), this.addMemory()) }, h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '追加一條主對話決定'), this.decision, h('span', { class: 'om-field__help' }, `會以「主對話決定（時間）」為標題追加在記憶檔後面；每個工作者下一則 prompt 前會讀到新增的部分。一次最多 ${MEMORY_MAX_CHARS.toLocaleString('en-US')} 字。`)), this.memError, h('div', { class: 'dialog-actions' }, this.addBtn));
    this.memoryBox.open = this.fold.memory;
    fill(
      this.memoryBox,
      h('summary', null, h('span', { class: 'cf-title' }, '叢集記憶'), this.memMeta),
      h(
        'div',
        { class: 'cf-body' },
        h('div', { class: 'cluster-section-title' }, h('span', { class: 'om-field__help' }, '所有工作者共用的一份記憶檔（memory.md），放在工作者那台電腦、所有 worktree 之外，不會進 git。'), this.reloadBtn),
        h('div', { class: 'cluster-memory-head' }, this.memPath),
        this.memNone,
        this.memTruncated,
        this.memText,
        form,
      ),
    );
  }

  drawAdd() {
    this.addBtn.disabled = !this.decision.value.trim() || Boolean(this.adding);
  }

  showMemory(m) {
    this.memSeen = { bytes: m.bytes, updatedAt: m.updatedAt };
    this.memNone.hidden = true;
    this.memText.hidden = false;
    this.memPath.hidden = false;
    this.memPath.textContent = m.path || '';
    this.memMeta.textContent = [fmtBytes(m.bytes), m.updatedAt ? `${relTime(m.updatedAt)}更新` : null].filter(Boolean).join(' · ');
    // Read again while someone reads it (a worker wrote to the file): keep their place.
    const top = this.memText.scrollTop;
    this.memText.textContent = m.text || '（還沒有內容）';
    this.memText.scrollTop = top;
    const note = memoryNote(m);
    this.memTruncated.hidden = !note;
    this.memTruncated.textContent = note || '';
  }

  async loadMemory() {
    try {
      const m = await get(`/clusters/${this.id}/memory`);
      if (this.dead) return;
      this.showMemory(m);
    } catch (err) {
      if (this.dead) return;
      this.memText.hidden = true;
      this.memPath.hidden = true;
      this.memMeta.textContent = '';
      this.memNone.hidden = false;
      this.memTruncated.hidden = true;
      this.memNone.textContent = `讀不到叢集記憶：${err.message}`;
    }
  }

  async addMemory() {
    const text = this.decision.value.trim();
    if (!text || this.adding) return;
    this.adding = true;
    this.drawAdd();
    fill(this.memError);
    try {
      const m = await post(`/clusters/${this.id}/memory`, { text });
      this.decision.value = '';
      this.showMemory(m);
    } catch (err) {
      fill(this.memError, err.message || String(err));
    } finally {
      this.adding = false;
      this.drawAdd();
    }
  }
}
