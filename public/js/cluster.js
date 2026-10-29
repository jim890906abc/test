// 叢集 (cluster): hand several tasks to several worker conversations at once.
// This file draws the three places it shows up - the dispatch dialog, the cluster
// page (#/cluster/<id>) and the note on the conversations it touches - and
// holds what the page has been told about clusters. What is decided (what a
// dispatch sends, how timing is laid out) is in cluster-model.js.
//
// Naming (spec §0): a cluster is never called a Swarm here. "Swarm" on these
// screens is only Kimi's own mode, which a worker can be started in; every place
// that says it is marked data-native-swarm and says whose it is.
import { h, fill, icon, relTime, copyText, baseName } from './dom.js';
import { get, post } from './api.js';
import { busy as sessionBusy } from './providers.js';
import {
  CLUSTER_MAX_TASKS,
  CLUSTER_DEFAULTS,
  CLUSTER_MODES,
  clusterStatusLabel,
  contextWarnings,
  draftProblems,
  fmtBytes,
  fmtMs,
  isActive,
  isStoppable,
  memoryNote,
  mergeAvailability,
  MEMORY_MAX_CHARS,
  progressOf,
  requestBody,
  timingView,
  workerState,
} from './cluster-model.js';

// ---------------------------------------------------------- what we know

const known = new Map(); // cluster id -> the newest cluster this page has seen
const loadedFor = new Set(); // clusters of a worker whose cluster was fetched this page load
const askedFor = new Map(); // main conversation id -> the list of its cluster ids the cluster list was last fetched for

export const rememberCluster = (c) => {
  if (c?.id) known.set(c.id, c);
  return c;
};
export const clusterById = (id) => known.get(id) || null;
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
          h('span', { class: 'cluster-banner-text' }, `${c.status === 'merging' ? '叢集合併中' : '叢集進行中'} ${done}/${total} 完成`, failed ? `，${failed} 個出錯` : ''),
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
  const draft = { tasks: [{ title: '', prompt }], ...CLUSTER_DEFAULTS, note: '' };
  let dirty = Boolean(prompt);
  let sending = false;
  let closed = false;
  const live = () => ctx.session?.(session.id) || session;

  const tasksBox = h('div', { class: 'cluster-tasks' });
  const count = h('span', { class: 'cluster-count' });
  const addBtn = h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'add-task' }, onclick: () => addTask() }, icon('plus'), '新增任務');
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
    submit.disabled = sending || problems.length > 0;
    submit.textContent = sending ? '派工中…' : `派出 ${n} 個工作者`;
    cancel.disabled = sending;
    fields.disabled = sending;
    sendingNote.hidden = !sending;
  }

  // Everything the person typed or chose; locked while the dispatch is on its way.
  const fields = h(
    'fieldset',
    { class: 'cluster-fields' },
    h('p', { class: 'dialog-text settings-lead' }, '把任務分給幾個工作者，各自開一個新的對話同時做；做完可以一鍵合併。每個工作者都是一個要花額度的對話。'),
    h('div', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '任務'), tasksBox, h('div', { class: 'cluster-tasks-foot' }, count, addBtn)),
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
            h('span', { class: 'cluster-list-text' }, `${modeLabel(c.mode)} · ${done}/${total} 完成`),
            h('span', { class: 'muted' }, relTime(c.createdAt)),
          );
        }),
      ),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '關閉')),
    ),
  );
}

// ------------------------------------------------------------ the page

const TONE_BADGE = { busy: 'cluster-badge-busy', warn: 'om-badge--warning', danger: 'om-badge--danger', ok: 'om-badge--success', idle: '' };
const CLUSTER_BADGE = { starting: 'cluster-badge-busy', running: 'cluster-badge-busy', merging: 'cluster-badge-busy', done: 'om-badge--success', stopped: '', error: 'om-badge--danger' };
const DELETED_TIMING = { error: new Error('這個工作者的對話已被刪除，沒有耗時資料') };
const TIMING_REFRESH_MS = 10_000;

// The page for one cluster. ctx: { confirmDialog, toast, fail, go, parentTitle(id), onTitle(cluster) }.
export class ClusterPage {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.cluster = clusterById(id);
    this.timings = new Map(); // worker session id -> { timing } | { error }
    this.cards = new Map(); // worker session id -> { el, sig, state, progress, timingSlot, shown }
    this.sigs = {}; // what each part of the page was last drawn from
    this.busy = null; // 'stop' | 'merge' while that request is out
    this.actionError = ''; // what the Hub said to the last stop / merge it refused
    this.started = false; // the first cluster has come in: the time and the memory are then read
    this.memSeen = null; // { bytes, updatedAt } of the memory file as last read
    this.memAsked = ''; // the change of the file the page last tried to read
    this.dead = false;
    this.sig = '';
    this.head = h('div', { class: 'cluster-head' });
    this.warns = h('div', { class: 'cluster-warns' });
    this.workers = h('div', { class: 'cluster-workers' });
    this.count = h('span', { class: 'muted' });
    this.mergeBox = h('div', { class: 'cluster-merge-slot' });
    this.memoryBox = h('section', { class: 'cluster-section cluster-memory' });
    this.body = h('div', { class: 'cluster-body' });
    this.el = h('div', { class: 'cluster-page' }, this.body);
    this.buildMemory();
    this.timer = setInterval(() => document.visibilityState === 'visible' && this.cluster && isActive(this.cluster) && this.loadTimings(), TIMING_REFRESH_MS);
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
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
    if (this.dead || !c || c.id !== this.id) return;
    const first = !this.started;
    this.started = true;
    this.cluster = rememberCluster(c);
    this.draw();
    // Time is asked for again when a worker's state moved, and on a timer while it runs.
    const sig = JSON.stringify((c.workers || []).map((w) => [w.sessionId, w.status, w.finishedAt]));
    if (first || sig !== this.sig) this.loadTimings();
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
  // few times a second while workers run; a card, a button or a text being
  // selected must not be torn down for a line that moved somewhere else.
  draw() {
    const c = this.cluster;
    if (!c) return;
    this.ctx.onTitle?.(c);
    if (this.body.firstChild !== this.head) {
      fill(
        this.body,
        this.head,
        this.warns,
        h('section', { class: 'cluster-section' }, h('div', { class: 'cluster-section-title' }, h('span', null, '工作者'), this.count), this.workers),
        this.mergeBox,
        this.memoryBox,
      );
      this.sigs = {};
    }
    this.drawHead();
    this.drawWarnings();
    this.drawWorkers();
    this.drawMerge();
  }

  changed(part, value) {
    const sig = JSON.stringify(value);
    if (this.sigs[part] === sig) return false;
    this.sigs[part] = sig;
    return true;
  }

  drawHead() {
    const c = this.cluster;
    const { done, total, failed, deleted } = progressOf(c);
    const merge = mergeAvailability(c, Boolean(this.busy));
    const stoppable = isStoppable(c) && !this.busy;
    const parentTitle = c.parentId ? this.ctx.parentTitle?.(c.parentId) : '';
    this.count.textContent = `${total} 個`;
    // The "x minutes ago" moves on by itself, so it is part of what this is drawn from.
    if (!this.changed('head', [c.status, done, total, failed, deleted, c.mode, c.isolate, c.swarm, c.parentId, parentTitle, merge, stoppable, this.busy, this.actionError, Math.floor(Date.now() / 60_000)])) return;
    const parent = c.parentId;
    fill(
      this.head,
      h(
        'div',
        { class: 'cluster-head-main' },
        h(
          'div',
          { class: 'cluster-head-line' },
          h('span', { class: `om-badge ${CLUSTER_BADGE[c.status] || ''}`, dataset: { field: 'status' } }, clusterStatusLabel(c.status)),
          h('span', { class: 'cluster-progress' }, `${done}/${total} 完成`),
          failed ? h('span', { class: 'om-badge om-badge--danger' }, `${failed} 個出錯`) : null,
          deleted ? h('span', { class: 'om-badge' }, `${deleted} 個已刪除`) : null,
          h('span', { class: 'muted' }, `建立於 ${relTime(c.createdAt)}`),
        ),
        h('div', { class: 'cluster-head-facts' }, h('span', null, modeLabel(c.mode)), h('span', null, c.isolate ? '每個工作者獨立 worktree' : '共用同一個資料夾'), nativeSwarm(c.swarm)),
        c.isolate && (c.workers || []).some((w) => w.branch) ? null : h('div', { class: 'om-field__help', dataset: { field: 'no-merge' } }, '沒有獨立 worktree，沒有分支可以合併；工作者改的都在同一個資料夾裡。'),
        parent ? h('a', { class: 'linklike', href: `#/s/${parent}`, dataset: { action: 'open-parent' } }, `回主對話${parentTitle ? `「${parentTitle}」` : ''}`) : null,
        this.actionError ? h('div', { class: 'om-field__error cluster-error', role: 'alert' }, this.actionError) : null,
      ),
      h(
        'div',
        { class: 'cluster-actions' },
        h('button', { class: 'om-btn om-btn--destructive', type: 'button', dataset: { action: 'stop' }, disabled: !stoppable, title: stoppable ? '中斷每個工作者目前這一輪（對話、分支與 worktree 都保留）' : '叢集已經不在跑了', onclick: () => this.stop() }, icon('stop'), '全部停止'),
        h('button', { class: 'om-btn om-btn--primary', type: 'button', dataset: { action: 'merge' }, disabled: !merge.ok, title: merge.why, onclick: () => this.merge() }, icon('branch'), '合併工作者分支'),
      ),
    );
  }

  drawWarnings() {
    const warnings = this.cluster.warnings || [];
    if (!this.changed('warnings', warnings)) return;
    fill(this.warns, warnings.map((w) => h('div', { class: 'callout small cluster-warn' }, icon('warn'), h('div', { class: 'callout-text' }, w))));
  }

  // One card per worker, kept as long as what it shows apart from its state,
  // progress and time is the same; those three are updated in place.
  drawWorkers() {
    const list = this.cluster.workers || [];
    const els = [];
    const seen = new Set();
    for (const w of list) {
      const sig = JSON.stringify([w.title, w.task, w.branch, w.worktree, w.swarm, w.status === 'deleted']);
      let card = this.cards.get(w.sessionId);
      if (!card || card.sig !== sig) {
        card = this.buildCard(w, sig);
        this.cards.set(w.sessionId, card);
      }
      this.updateCard(card, w);
      els.push(card.el);
      seen.add(w.sessionId);
    }
    for (const id of [...this.cards.keys()]) if (!seen.has(id)) this.cards.delete(id);
    const now = [...this.workers.children];
    if (now.length !== els.length || now.some((e, i) => e !== els[i])) this.workers.replaceChildren(...els);
  }

  buildCard(w, sig) {
    const state = h('span', { class: 'om-badge cluster-worker-state' });
    const progress = h('p', { class: 'cluster-worker-progress' });
    const timingSlot = h('div', { class: 'cluster-timing-slot' });
    const deleted = w.status === 'deleted';
    const el = h(
      'article',
      { class: 'cluster-worker', dataset: { session: w.sessionId } },
      h('header', { class: 'cluster-worker-head' }, h('div', { class: 'cluster-worker-title', title: w.title }, w.title), state),
      h('p', { class: 'cluster-worker-task', title: w.task }, w.task),
      w.branch || w.worktree
        ? h(
            'dl',
            { class: 'cluster-kv' },
            w.branch ? [h('dt', null, '分支'), h('dd', null, h('code', { dataset: { field: 'branch' } }, w.branch))] : null,
            w.worktree
              ? [
                  h('dt', null, 'worktree'),
                  h('dd', null, h('code', { dataset: { field: 'worktree' } }, w.worktree), h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', dataset: { action: 'copy-path' }, title: '複製路徑', 'aria-label': `複製 ${w.title} 的 worktree 路徑`, onclick: () => copyText(w.worktree).then(() => this.ctx.toast('已複製')) }, icon('copy'))),
                ]
              : null,
          )
        : null,
      h('div', { class: 'cluster-worker-meta' }, nativeSwarm(w.swarm), deleted ? null : h('a', { class: 'om-btn om-btn--sm', href: `#/s/${w.sessionId}`, dataset: { action: 'open-worker' } }, '開啟對話')),
      progress,
      timingSlot,
    );
    return { el, sig, state, progress, timingSlot, shown: null, stateKey: '', progressText: null };
  }

  updateCard(card, w) {
    const st = workerState(w);
    const stateKey = `${st.label}|${st.tone}`;
    if (card.stateKey !== stateKey) {
      card.stateKey = stateKey;
      card.state.className = `om-badge cluster-worker-state ${TONE_BADGE[st.tone] || ''}`;
      card.state.textContent = st.label;
    }
    const text = w.progress || '';
    if (card.progressText !== text) {
      card.progressText = text;
      card.progress.className = `cluster-worker-progress${text ? '' : ' muted'}`;
      card.progress.title = text;
      card.progress.textContent = text || '還沒有進度';
    }
    const got = w.status === 'deleted' ? DELETED_TIMING : this.timings.get(w.sessionId) || null;
    if (card.shown !== got) {
      card.shown = got;
      fill(card.timingSlot, this.timingBox(got));
    }
  }

  // The time breakdown of one worker's conversation (spec §5). What the Hub did
  // not measure says 量不到 and why; nothing is worked out from the rest.
  timingBox(got) {
    if (!got) return h('div', { class: 'cluster-timing-loading muted' }, '耗時讀取中…');
    const v = timingView(got.timing, got.error);
    if (v.failed) return h('div', { class: 'cluster-timing' }, h('div', { class: 'cluster-timing-failed' }, `耗時量不到：${v.failed}`));
    const total = v.total.ms === null ? `量不到` : fmtMs(v.total.ms);
    return h(
      'div',
      { class: 'cluster-timing' },
      h('div', { class: 'cluster-timing-head' }, h('span', null, '耗時'), h('span', { class: 'cluster-timing-total' }, `總時間 ${total}`)),
      h(
        'div',
        { class: 'cluster-bar', role: 'img', 'aria-label': `耗時拆解：${v.segments.map((s) => `${s.label} ${fmtMs(s.ms) || '量不到'}`).join('、')}` },
        v.segments.filter((s) => s.share).map((s) => h('span', { class: `cluster-seg part-${s.key}`, dataset: { seg: s.key }, style: { width: `${(s.share * 100).toFixed(1)}%` } })),
      ),
      h(
        'ul',
        { class: 'cluster-legend' },
        v.segments.map((s) => h('li', { dataset: { part: s.key }, class: s.ms === null ? 'unmeasured' : '' }, h('span', { class: `cluster-swatch part-${s.key}` }), h('span', { class: 'cluster-legend-label' }, s.label), h('span', { class: 'cluster-legend-value' }, s.ms === null ? '量不到' : fmtMs(s.ms)))),
      ),
      ...v.segments.filter((s) => s.ms === null).map((s) => h('p', { class: 'cluster-reason', dataset: { part: s.key } }, `${s.label}：${s.reason}`)),
      ...(v.total.ms === null ? [h('p', { class: 'cluster-reason', dataset: { part: 'wallMs' } }, `總時間：${v.total.reason}`)] : []),
      ...v.notes.map((n) => h('p', { class: 'cluster-reason', dataset: { part: 'note' } }, n)),
      v.facts.length ? h('p', { class: 'cluster-timing-facts' }, v.facts.map(([k, n]) => `${k} ${n}`).join(' · ')) : null,
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

  // ---- time

  async loadTimings() {
    const c = this.cluster;
    if (!c) return;
    const ids = (c.workers || []).filter((w) => w.status !== 'deleted').map((w) => w.sessionId);
    await Promise.all(
      ids.map(async (sid) => {
        try {
          this.timings.set(sid, { timing: await get(`/sessions/${sid}/timing`) });
        } catch (err) {
          this.timings.set(sid, { error: err });
        }
      }),
    );
    if (!this.dead && this.cluster) this.drawWorkers();
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
    const unfinished = (c.workers || []).filter((w) => !w.finishedAt && w.status !== 'deleted').length;
    const body = `會從主對話目前的 HEAD 開新分支 cluster/${c.id}/merged，依工作者的順序合併各自的分支；只會合進各分支上已 commit 的內容。不動主對話正在用的分支與工作樹。有衝突的工作者會跳過並列出檔案，其餘照常合併。${unfinished ? `\n\n還有 ${unfinished} 個工作者沒做完，它們之後才 commit 的內容不會在這次合併裡。` : ''}`;
    const ok = await this.ctx.confirmDialog({ title: '要合併各工作者的分支嗎？', body, action: '合併' });
    if (ok) await this.run('merge');
  }

  async run(what) {
    this.busy = what;
    this.actionError = '';
    this.drawHead();
    try {
      const r = await post(`/clusters/${this.id}/${what}`);
      const next = r?.cluster || (r?.id === this.id ? r : null) || (await get(`/clusters/${this.id}`));
      this.busy = null;
      this.update(next);
    } catch (err) {
      this.busy = null;
      this.actionError = err.message || String(err);
      this.drawHead();
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
    fill(
      this.memoryBox,
      h('div', { class: 'cluster-section-title' }, h('span', null, '叢集記憶'), this.reloadBtn),
      h('p', { class: 'om-field__help' }, '所有工作者共用的一份記憶檔（memory.md），放在工作者那台電腦、所有 worktree 之外，不會進 git。'),
      h('div', { class: 'cluster-memory-head' }, this.memPath, this.memMeta),
      this.memNone,
      this.memTruncated,
      this.memText,
      form,
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
