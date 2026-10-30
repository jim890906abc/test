// The small squares of the cluster screens (叢集): a worker as one tile, the
// subagents of a worker as squares, the drawer that opens when a tile is
// pressed, and the one-line card of a cluster on the page that lists them all.
//
// What the screen shows is only what the Hub sent: a number it did not measure
// is "—" (the reason is in the drawer, never on the tile), and nothing says how
// long anything will take. What is decided (how a count line reads, which group
// a subagent belongs to, how a speed is written) is in cluster-model.js; this
// file draws it.
import { h, fill, icon, relTime, copyText } from './dom.js';
import { modelWithProvider, PROVIDER_LABELS } from './providers.js';
import { timingBox } from './timing-box.js';
import {
  SUBAGENT_LEGEND,
  clusterElapsed,
  clusterStatusLabel,
  fmtMs,
  genView,
  groupCounts,
  isActive,
  keyView,
  outputTotalView,
  outputView,
  sortClusters,
  speedView,
  squareLabel,
  squaresView,
  subagentDetail,
  subagentLine,
  subagentState,
  taskBar,
  totalsOf,
  workerQueueLine,
  workerSquare,
  workerState,
  workingSubagents,
} from './cluster-model.js';

export const TONE_BADGE = { busy: 'cluster-badge-busy', warn: 'om-badge--warning', danger: 'om-badge--danger', ok: 'om-badge--success', idle: '' };
export const CLUSTER_BADGE = { starting: 'cluster-badge-busy', running: 'cluster-badge-busy', merging: 'cluster-badge-busy', done: 'om-badge--success', stopped: '', error: 'om-badge--danger' };
// A tile has room for one row of little squares: the ones that need a look first.
const MINIS_SHOWN = 12;
const MINI_ORDER = { awaiting: 0, running: 1, unknown: 2, failed: 3, cancelled: 3, done: 4 };
const DASH = '—';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A bar of the tasks: the part that is done, the part at work (breathing), the part that failed.
function barEl(cls = '') {
  const done = h('span', { class: 'cw-bar-done' });
  const run = h('span', { class: 'cw-bar-run' });
  const bad = h('span', { class: 'cw-bar-bad' });
  const el = h('div', { class: `cw-bar ${cls}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, done, run, bad);
  el.set = ({ done: d = 0, running: r = 0, failed: f = 0 }, label) => {
    const pct = (v) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;
    done.style.width = pct(d);
    run.style.width = pct(Math.min(r, 1 - d - f));
    bad.style.width = pct(f);
    el.setAttribute('aria-valuenow', String(Math.round(d * 100)));
    el.setAttribute('aria-label', label);
  };
  return el;
}

// ------------------------------------------------------------- the squares

// One square per subagent, in the order they were opened. The glyph says what
// the colour says (✓ done, ✕ failed or cut, ! waiting for you, ? not known, and
// a breathing dot while running), so a square never relies on colour alone. One
// stop for the keyboard (arrow keys move between squares), Enter opens it.
export class SubagentSquares {
  constructor({ label = '子代理', onPick, onMore }) {
    this.onPick = onPick;
    this.onMore = onMore;
    this.cells = new Map();
    this.more = null;
    this.active = null; // the one square that is a stop for the Tab key
    this.el = h('div', { class: 'sa-grid', role: 'group', 'aria-label': label, onkeydown: (e) => this.key(e) });
  }

  cell(id) {
    let c = this.cells.get(id);
    if (!c) {
      c = h('button', { class: 'sa-cell', type: 'button', tabindex: '-1', dataset: { id }, onclick: () => this.onPick?.(id) }, h('span', { class: 'sa-glyph', 'aria-hidden': 'true' }));
      this.cells.set(id, c);
    }
    return c;
  }

  // list: the Hub's entries; selected: the id whose detail is open; all: show every square.
  set({ list, selected = null, all = false }) {
    const view = squaresView(list, { all });
    const keep = new Set(view.shown.map((s) => s.id));
    for (const id of [...this.cells.keys()]) if (!keep.has(id)) this.cells.delete(id);
    if (keep.has(selected)) this.active = selected;
    else if (!keep.has(this.active)) this.active = view.shown[0]?.id ?? null;
    const active = this.active;
    const els = view.shown.map((s, i) => {
      const c = this.cell(s.id);
      const st = subagentState(s.status);
      const label = squareLabel(s, i);
      c.dataset.status = s.status;
      c.dataset.group = st.group;
      c.setAttribute('aria-label', label);
      c.title = label;
      c.setAttribute('aria-expanded', String(selected === s.id));
      c.tabIndex = s.id === active ? 0 : -1;
      const g = c.firstChild;
      if (g.textContent !== st.glyph) g.textContent = st.glyph;
      return c;
    });
    if (view.hidden > 0) {
      this.more ||= h('button', { class: 'sa-more', type: 'button', onclick: () => this.onMore?.() });
      this.more.textContent = `+${view.hidden}`;
      this.more.setAttribute('aria-label', `再顯示 ${view.hidden} 個子代理`);
      els.push(this.more);
    }
    const now = [...this.el.children];
    if (now.length !== els.length || now.some((e, i) => e !== els[i])) this.el.replaceChildren(...els);
  }

  key(e) {
    const cells = [...this.el.querySelectorAll('.sa-cell')];
    const at = cells.indexOf(document.activeElement);
    if (at < 0) return;
    // Squares in one row share a top: that is how far "down" is.
    const cols = Math.max(1, cells.filter((c) => c.offsetTop === cells[0].offsetTop).length);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: cells.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = cells[Math.max(0, Math.min(cells.length - 1, to))];
    this.active = next.dataset.id;
    for (const c of cells) c.tabIndex = c === next ? 0 : -1;
    next.focus();
  }

  focusCell(id) {
    this.cells.get(id)?.focus();
  }
}

// The legend: every glyph and colour once, in words.
export function legendEl() {
  return h(
    'ul',
    { class: 'sa-legend', 'aria-label': '圖例' },
    SUBAGENT_LEGEND.map((l) => h('li', { dataset: { group: l.group } }, h('span', { class: 'sa-key', dataset: { group: l.group }, 'aria-hidden': 'true' }, l.glyph), l.label)),
  );
}

// ------------------------------------------------- one subagent's detail

// Opened by a square: what the subagent is, how far it got, what it did last.
// What was not measured says so in words and why (here, not on the tile).
export class SubagentDetail {
  constructor({ ctx, onClose, onView }) {
    this.ctx = ctx;
    this.onView = onView;
    this.sig = '';
    this.s = null;
    this.closeBtn = h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '關閉子代理詳細', 'aria-label': '關閉子代理詳細', onclick: () => onClose?.() }, icon('x'));
    this.head = h('div', { class: 'sa-detail-head' });
    this.rows = h('dl', { class: 'sa-detail-rows' });
    this.foot = h('div', { class: 'sa-detail-foot' });
    this.el = h('section', { class: 'sa-detail', role: 'region', 'aria-label': '子代理詳細', hidden: true, tabindex: '-1' }, this.head, this.rows, this.foot);
  }

  get shown() {
    return !this.el.hidden;
  }

  hide() {
    this.el.hidden = true;
    this.s = null;
    this.sig = '';
  }

  modelText(provider, model) {
    const name = this.ctx.modelName?.(provider, model) || String(model).split('/').pop();
    return modelWithProvider(PROVIDER_LABELS[provider] || provider || '', name);
  }

  // `worker`: the worker's session id (where 在對話中查看 goes).
  show(s, index, worker, now = Date.now()) {
    this.s = s;
    this.index = index;
    this.worker = worker;
    this.el.hidden = false;
    const d = subagentDetail(s, { now, modelText: (p, m) => this.modelText(p, m), effortLabel: (e) => this.ctx.effortLabel?.(e) || e });
    this.d = d;
    const sig = JSON.stringify({ ...d, span: null, i: index });
    if (sig !== this.sig) {
      this.sig = sig;
      const row = (k, v, field) => (v === null || v === undefined ? null : [h('dt', null, k), h('dd', { dataset: { field } }, v)]);
      fill(
        this.head,
        h('span', { class: 'sa-key', dataset: { group: d.state.group }, 'aria-hidden': 'true' }, d.state.glyph),
        h('div', { class: 'sa-detail-title' }, h('div', { class: 'sa-detail-name', dataset: { field: 'title' } }, d.title), h('div', { class: 'sa-detail-state', dataset: { field: 'state' } }, d.state.label, d.background ? '・背景執行' : '')),
        this.closeBtn,
      );
      fill(
        this.rows,
        row('為什麼', d.reason, 'reason'),
        row('實際模型', d.model ?? `${DASH}（${d.modelWhy}）`, 'model'),
        row('步驟數', d.steps === null ? DASH : `${d.steps} 步`, 'steps'),
        row('最新動作', d.lastAction ?? DASH, 'last-action'),
        row('開始', d.started ?? DASH, 'started'),
        row('結束', d.state.group === 'running' || d.state.group === 'awaiting' ? null : d.finished ?? DASH, 'finished'),
        h('dt', null, '時間'),
        (this.spanEl = h('dd', { dataset: { field: 'span' } }, d.span ?? DASH)),
      );
      fill(this.foot, h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'view-in-chat' }, onclick: () => this.onView?.(this.worker, this.s) }, icon('chev'), '在對話中查看'));
    } else if (this.spanEl) this.spanEl.textContent = d.span ?? DASH;
  }
}

// ------------------------------------------------------------ worker tile

// One worker in a small square: its name, its state, which task it is on, how
// fast it goes, its share of the work, and its subagents as little squares. No
// long text: pressing it opens the drawer.
export class WorkerTile {
  constructor({ sessionId, onOpen }) {
    this.sessionId = sessionId;
    this.title = h('span', { class: 'cluster-worker-title' });
    this.state = h('span', { class: 'om-badge cluster-worker-state' });
    this.place = h('span', { class: 'cluster-worker-queue cw-place' });
    this.gen = h('span', { class: 'cw-gen', dataset: { field: 'gen' } });
    this.bar = barEl();
    this.minis = h('span', { class: 'cw-minis', 'aria-hidden': 'true' });
    this.count = h('span', { class: 'cw-subcount', dataset: { field: 'subcount' } });
    this.last = {};
    this.el = h(
      'article',
      { class: 'cluster-worker', role: 'button', tabindex: '0', 'aria-haspopup': 'dialog', dataset: { session: sessionId }, onclick: () => onOpen(sessionId, this.el), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === this.el && (e.preventDefault(), onOpen(sessionId, this.el)) },
      h('div', { class: 'cw-top' }, this.title),
      h('div', { class: 'cw-meta' }, this.state, this.gen),
      h('div', { class: 'cw-line' }, this.place, this.count),
      this.bar,
      this.minis,
    );
  }

  set(key, value, apply) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }

  update(w, cluster) {
    const st = workerState(w);
    const sq = workerSquare(w, cluster);
    const gv = genView(w.gen);
    const counts = w.subagentCounts;
    const g = groupCounts(counts);
    const line = subagentLine(counts, w.subagentsOlder);
    this.set('title', w.title, (v) => ((this.title.textContent = v), (this.title.title = v)));
    this.set('state', `${st.label}|${st.tone}`, () => {
      this.state.className = `om-badge cluster-worker-state ${TONE_BADGE[st.tone] || ''}`;
      this.state.dataset.tone = st.tone;
      this.state.textContent = st.label;
    });
    this.set('place', sq.place, (v) => ((this.place.hidden = !v), (this.place.textContent = v || '')));
    // 生成速度, the chat room's number: a dash where the worker is not running or no step is done; why is in the drawer.
    this.set('gen', gv.text, (v) => {
      this.gen.textContent = v;
      this.gen.classList.toggle('none', !gv.measured);
      this.gen.title = gv.measured ? `生成速度：${gv.tip}（和聊天室狀態列同一個數字）` : `生成速度：${gv.tip}。現在量不到（原因在詳細裡）`;
    });
    this.set('bar', JSON.stringify([sq.share, sq.working, w.status]), () => {
      const total = sq.total || 1;
      this.bar.set({ done: sq.share, running: sq.working && (w.status === 'running' || w.status === 'awaiting_permission') ? 1 / total : 0 }, `這個工作者做完 ${sq.done}／${sq.total || '?'} 條`);
      this.bar.classList.toggle('cw-live', sq.working);
    });
    const list = Array.isArray(w.subagents) ? w.subagents : [];
    // (The squares that need a look come first; the rest is "+N", and the whole of it is in the drawer.)
    const first = [...list].sort((a, b) => (MINI_ORDER[a.status] ?? 2) - (MINI_ORDER[b.status] ?? 2)).slice(0, MINIS_SHOWN);
    const rest = Math.max(0, (g.total || list.length) - first.length);
    this.set('minis', `${first.map((s) => s.status).join(',')}|${rest}`, () => {
      fill(
        this.minis,
        first.map((s) => h('span', { class: 'cw-mini', dataset: { group: subagentState(s.status).group } })),
        rest ? h('span', { class: 'cw-mini-more' }, `+${rest}`) : null,
      );
    });
    this.set('count', `${counts ? `${workingSubagents(counts)}/${g.total}` : DASH}|${line}`, () => {
      this.count.hidden = !counts || !g.total;
      this.count.textContent = counts && g.total ? `子代理 ${workingSubagents(counts)}/${g.total}` : '';
      this.count.title = line;
    });
    this.set('aria', `${w.title}|${st.label}|${sq.place}|${gv.text}|${line}`, () => {
      this.el.setAttribute('aria-label', `${w.title}，${st.label}${sq.place ? `，${sq.place}` : ''}，生成速度 ${gv.measured ? gv.text : '量不到'}，${line}。按下查看詳細`);
    });
  }
}

// ----------------------------------------------------------------- drawer

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, textarea, select';

// The detail of one worker, from the right edge of the page (from the bottom
// on a phone): the whole task, where it works, the time breakdown, its
// subagents and each one's detail. Esc closes the subagent's detail first, then
// the drawer; the focus goes back to the tile it came from.
export class WorkerDrawer {
  constructor({ ctx, cleanupState, onNeedTiming, timingOf }) {
    this.ctx = ctx;
    this.cleanupState = cleanupState;
    this.onNeedTiming = onNeedTiming;
    this.timingOf = timingOf;
    this.sid = null;
    this.selected = null;
    this.all = false;
    this.parts = {};
    this.squares = new SubagentSquares({ onPick: (id) => this.pick(id), onMore: () => ((this.all = true), this.draw()) });
    this.detail = new SubagentDetail({ ctx, onClose: () => this.unpick(true), onView: (sid, s) => ctx.focusAgent?.(sid, s?.eventId || null) });
    this.scrim = h('div', { class: 'cd-scrim', hidden: true, onclick: () => this.close() });
    this.title = h('h2', { class: 'cd-title', id: 'cd-title' });
    this.state = h('span', { class: 'om-badge cluster-worker-state' });
    this.openLink = h('a', { class: 'om-btn om-btn--sm', dataset: { action: 'open-worker' } }, '開啟對話');
    this.closeBtn = h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '關閉', 'aria-label': '關閉工作者詳細', dataset: { action: 'close-drawer' }, onclick: () => this.close() }, icon('x'));
    this.body = h('div', { class: 'cd-body' });
    this.el = h(
      'aside',
      { class: 'om cluster-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cd-title', hidden: true, tabindex: '-1', onkeydown: (e) => this.key(e) },
      h('header', { class: 'cd-head' }, h('div', { class: 'cd-head-main' }, this.title, h('div', { class: 'cd-head-line' }, this.state, this.openLink)), this.closeBtn),
      this.body,
    );
    document.body.append(this.scrim, this.el);
    this.onDocKey = (e) => e.key === 'Escape' && this.isOpen && (e.stopPropagation(), this.back());
    document.addEventListener('keydown', this.onDocKey, true);
    this.tick = setInterval(() => this.isOpen && this.detail.shown && this.drawDetail(), 1000);
  }

  get isOpen() {
    return this.sid !== null;
  }

  destroy() {
    clearInterval(this.tick);
    clearTimeout(this.hideTimer);
    document.removeEventListener('keydown', this.onDocKey, true);
    this.el.remove();
    this.scrim.remove();
  }

  open(sid, opener) {
    this.sid = sid;
    this.opener = opener || document.activeElement;
    this.selected = null;
    this.all = false;
    this.parts = {};
    this.detail.hide();
    fill(this.body);
    clearTimeout(this.hideTimer);
    this.scrim.hidden = false;
    this.el.hidden = false;
    // (One frame later, so that the transition has somewhere to start from.)
    requestAnimationFrame(() => {
      this.scrim.classList.add('on');
      this.el.classList.add('on');
    });
    this.onNeedTiming?.(sid);
    this.draw();
    this.closeBtn.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    const opener = this.opener;
    this.sid = null;
    this.scrim.classList.remove('on');
    this.el.classList.remove('on');
    this.hideTimer = setTimeout(() => {
      this.el.hidden = true;
      this.scrim.hidden = true;
    }, 220);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  // Esc: the subagent's detail first, then the drawer.
  back() {
    if (this.detail.shown) this.unpick(true);
    else this.close();
  }

  key(e) {
    if (e.key !== 'Tab') return;
    const f = [...this.el.querySelectorAll(FOCUSABLE)].filter((x) => !x.closest('[hidden]') && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f.at(-1);
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }

  worker() {
    return (this.cluster?.workers || []).find((w) => w.sessionId === this.sid) || null;
  }

  pick(id) {
    this.selected = this.selected === id ? null : id;
    this.draw();
    if (this.selected) this.detail.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  unpick(refocus) {
    const was = this.selected;
    this.selected = null;
    this.detail.hide();
    this.draw();
    if (refocus && was) this.squares.focusCell(was);
  }

  drawDetail() {
    const w = this.worker();
    const list = Array.isArray(w?.subagents) ? w.subagents : [];
    const at = list.findIndex((s) => s.id === this.selected);
    if (this.selected && at >= 0) this.detail.show(list[at], at, w.sessionId);
    else if (this.selected) {
      // It is no longer in what the Hub sent (the oldest are let go).
      this.selected = null;
      this.detail.hide();
    }
  }

  update(cluster) {
    this.cluster = cluster;
    if (!this.isOpen) return;
    if (!this.worker()) return this.close();
    this.draw();
  }

  // A part is drawn again only when what it shows changed (the drawer is
  // updated several times a second while workers run; a selection, a scroll
  // position or a copied path must survive it).
  part(key, sig, build) {
    const s = JSON.stringify(sig);
    if (this.parts[key]?.sig === s) return this.parts[key].el;
    const old = this.parts[key]?.el;
    const el = build();
    this.parts[key] = { sig: s, el };
    if (old && old.isConnected) old.replaceWith(el);
    return el;
  }

  draw() {
    const w = this.worker();
    const c = this.cluster;
    if (!w || !c) return;
    const st = workerState(w);
    this.title.textContent = w.title;
    this.state.className = `om-badge cluster-worker-state ${TONE_BADGE[st.tone] || ''}`;
    this.state.textContent = st.label;
    const deleted = w.status === 'deleted';
    this.openLink.hidden = deleted;
    this.openLink.href = `#/s/${w.sessionId}`;

    const sp = speedView(w.speed);
    const gv = genView(w.gen);
    const list = Array.isArray(w.subagents) ? w.subagents : [];
    const queue = workerQueueLine(w, c);
    const got = deleted ? { error: new Error('這個工作者的對話已被刪除，沒有耗時資料') } : this.timingOf?.(w.sessionId) || null;
    const keyOf = keyView(got?.timing);
    const sections = [
      this.part('task', [w.task, queue, w.progress], () =>
        h(
          'section',
          { class: 'cd-sec', dataset: { sec: 'task' } },
          h('h3', null, '任務'),
          h('p', { class: 'cd-task', dataset: { field: 'task' } }, w.task || DASH),
          queue ? h('p', { class: 'cluster-worker-queue', dataset: { field: 'worker-queue' } }, queue) : null,
          h('p', { class: `cluster-worker-progress${w.progress ? '' : ' muted'}`, dataset: { field: 'progress' } }, w.progress || '還沒有進度'),
        ),
      ),
      // 生成速度: the chat room's number (the last ten model steps); a dash and why where the worker is not running or no step is done.
      this.part('gen', gv, () =>
        h(
          'section',
          { class: 'cd-sec', dataset: { sec: 'generation' } },
          h('h3', { title: gv.tip }, '生成速度'),
          gv.measured ? h('p', { class: 'cd-gen', dataset: { field: 'gen' } }, gv.text) : h('p', { class: 'cd-none', dataset: { field: 'gen-why' } }, `${DASH}　量不到：${gv.why}`),
          h('p', { class: 'om-field__help' }, `${gv.tip}。和聊天室狀態列同一個數字：Kimi 數的字數 ÷ 它量的串流時間，看最近 10 個模型步驟；只有執行中的工作者才有。`),
        ),
      ),
      // 平均產出: the connector's request records of the last five minutes, waiting and tools in the divisor.
      this.part('speed', [sp, w.speed?.requests], () =>
        h(
          'section',
          { class: 'cd-sec', dataset: { sec: 'speed' } },
          h('h3', { title: sp.tip }, sp.label),
          sp.measured
            ? h('ul', { class: 'cd-lines' }, h('li', { dataset: { field: 'tokens' } }, sp.tokens), sp.requests ? h('li', { dataset: { field: 'requests' } }, sp.requests) : null)
            : h('p', { class: 'cd-none', dataset: { field: 'speed-why' } }, `${DASH}　量不到：${sp.why}`),
          h('p', { class: 'om-field__help' }, `${sp.tip}。只算連接器記下的請求：窗內結束的請求輸出的 token 數，除以窗的秒數；沒有任何推算。`),
        ),
      ),
      // Which key of the pool its requests go out with (the Hub's timing answer says it): the gateway and the last four characters, nothing more.
      this.part('key', keyOf, () =>
        keyOf
          ? h(
              'section',
              { class: 'cd-sec cd-key', dataset: { sec: 'key' } },
              h('p', { class: 'cd-key-line', dataset: { field: 'key', state: keyOf.state } }, h('span', { class: 'cd-key-label' }, '用的 key：'), keyOf.text),
              keyOf.note ? h('p', { class: 'om-field__help', dataset: { field: 'key-note' } }, keyOf.note) : null,
            )
          : h('section', { class: 'cd-sec cd-key', dataset: { sec: 'key' }, hidden: true }),
      ),
      this.part('subs', [subagentLine(w.subagentCounts, w.subagentsOlder), list.length > 0], () => {
        return h(
          'section',
          { class: 'cd-sec', dataset: { sec: 'subagents' } },
          h('h3', null, '子代理'),
          h('p', { class: 'sa-count', dataset: { field: 'subagent-line' }, role: 'status' }, subagentLine(w.subagentCounts, w.subagentsOlder)),
          list.length ? [legendEl(), this.squares.el, this.detail.el] : null,
        );
      }),
      this.part('where', [w.branch, w.worktree, w.swarm, deleted, c.cleanup], () =>
        h(
          'section',
          { class: 'cd-sec', dataset: { sec: 'where' } },
          h('h3', null, '分支與位置'),
          w.branch || w.worktree
            ? h(
                'dl',
                { class: 'cluster-kv' },
                w.branch ? [h('dt', null, '分支'), h('dd', null, h('code', { dataset: { field: 'branch' } }, w.branch))] : null,
                w.worktree
                  ? [h('dt', null, 'worktree'), h('dd', null, h('code', { dataset: { field: 'worktree' } }, w.worktree), h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', dataset: { action: 'copy-path' }, title: '複製路徑', 'aria-label': `複製 ${w.title} 的 worktree 路徑`, onclick: () => copyText(w.worktree).then(() => this.ctx.toast('已複製')) }, icon('copy')))]
                  : null,
              )
            : h('p', { class: 'om-field__help' }, '共用同一個資料夾，沒有獨立的分支與 worktree。'),
          h('div', { class: 'cluster-worker-meta' }, h('span', { class: `cluster-chip${w.swarm ? ' on' : ''}`, dataset: { nativeSwarm: '' }, title: w.swarm ? '這個工作者開著 Kimi 原生的 Swarm 模式（同 /swarm）' : '這個工作者沒有開 Kimi 原生的 Swarm 模式' }, `原生 Swarm ${w.swarm ? '開' : '關'}`)),
          this.cleanupState?.(w),
        ),
      ),
    ];
    // The squares are updated in place every time (they keep their own elements), whatever else was kept.
    this.squares.set({ list, selected: this.selected, all: this.all });
    // The time breakdown has its own source (it is asked for when the drawer opens, and again now and then).
    const timing = this.part('time', [got ? (got.timing ? 't' : 'e') : 'n', got?.timing, got?.error?.message], () => h('section', { class: 'cd-sec cluster-timing-slot', dataset: { sec: 'time' } }, timingBox(got)));
    const all = [...sections, timing];
    if (this.body.children.length !== all.length || all.some((el, i) => this.body.children[i] !== el)) this.body.replaceChildren(...all);
    this.drawDetail();
  }
}

// -------------------------------------------- the list of every cluster

// One cluster as a card of the page that lists them all: whose it is, how far
// it is, how fast it goes, how many subagents are working. A link: it takes
// you to the cluster's own page.
export class ClusterCard {
  constructor() {
    this.title = h('span', { class: 'cc-title' });
    this.badge = h('span', { class: 'om-badge cc-state' });
    this.bar = barEl('cc-bar');
    this.progress = h('span', { class: 'cc-progress' });
    this.outNum = h('span', { class: 'cc-output-num' });
    this.outUnit = h('span', { class: 'cc-output-unit' }, 'tok/s 總產出');
    this.workers = h('span', { class: 'cc-fact', dataset: { field: 'workers' } });
    this.subs = h('span', { class: 'cc-fact', dataset: { field: 'subagents' } });
    this.el = h(
      'a',
      { class: 'cluster-card' },
      h('div', { class: 'cc-top' }, this.title, this.badge),
      h('div', { class: 'cc-mid' }, h('div', { class: 'cc-prog' }, this.bar, this.progress), h('div', { class: 'cc-output', dataset: { field: 'output' } }, this.outNum, this.outUnit)),
      h('div', { class: 'cc-facts' }, this.workers, this.subs),
    );
    this.last = {};
  }

  set(key, value, apply) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }

  // row: summarizeCluster(); title: the main conversation's name.
  update(row, title) {
    const live = isActive(row);
    const ov = outputView(row.throughput, { active: live });
    const t = row.tasks;
    this.el.href = `#/cluster/${row.id}`;
    this.el.dataset.cluster = row.id;
    this.el.dataset.status = row.status;
    this.set('title', title, (v) => ((this.title.textContent = v), (this.title.title = v)));
    this.set('badge', row.status, () => {
      this.badge.className = `om-badge cc-state ${CLUSTER_BADGE[row.status] || ''}`;
      this.badge.textContent = clusterStatusLabel(row.status);
    });
    this.set('bar', JSON.stringify(t), () => {
      const total = t.total || 1;
      this.bar.set({ done: t.done / total, running: t.running / total, failed: t.failed / total }, `任務 ${t.done}／${t.total} 完成`);
      this.progress.textContent = `${t.done}/${t.total}`;
    });
    // 叢集總產出 (the last minute, every agent of the cluster); a dash where it cannot be said or the cluster is over.
    this.set('output', ov.text, () => {
      this.outNum.textContent = ov.num;
      this.outUnit.hidden = !ov.measured;
      this.el.querySelector('.cc-output').classList.toggle('none', !ov.measured);
      this.el.querySelector('.cc-output').title = ov.measured ? `叢集總產出：${ov.tip}` : `叢集總產出：量不到：${ov.why}`;
    });
    this.set('workers', `${row.workersRunning}/${row.workers}|${live}`, () => (this.workers.textContent = `工作者 ${row.workersRunning}/${row.workers}`));
    const sub = row.subagents;
    this.set('subs', JSON.stringify(sub), () => {
      this.subs.textContent = sub ? `子代理 ${sub.running + sub.awaiting}/${sub.total + sub.older}` : `子代理 ${DASH}`;
      this.subs.title = sub ? subagentLine(sub, sub.older) : '量不到';
    });
    this.set('aria', `${title}|${row.status}|${t.done}|${t.total}|${ov.text}|${JSON.stringify(sub)}`, () => {
      this.el.setAttribute('aria-label', `${title}，${clusterStatusLabel(row.status)}，任務 ${t.done}／${t.total} 完成，叢集總產出 ${ov.measured ? ov.text : '量不到'}，${sub ? subagentLine(sub, sub.older) : '子代理量不到'}`);
    });
  }
}

// The page that lists every cluster: the totals over all of them in big
// numbers, then one card each, the working ones first.
export class ClusterListPage {
  constructor({ rows, title, load }) {
    this.rows = rows;
    this.title = title;
    this.loadRows = load;
    this.cards = new Map();
    this.sig = '';
    this.stat = {};
    this.statsEl = h('div', { class: 'cl-stats', role: 'status', 'aria-label': '全部叢集合計' });
    this.grid = h('div', { class: 'cl-grid' });
    this.empty = h('div', { class: 'cl-empty', hidden: true }, h('div', { class: 'large-title' }, '還沒有叢集'), h('p', { class: 'home-lead' }, '在 Kimi 或 DeepSeek 對話裡輸入 /cluster，把任務分給幾個工作者同時做。'));
    this.el = h('div', { class: 'cluster-page cluster-list-page' }, h('div', { class: 'cluster-body' }, this.statsEl, this.grid, this.empty));
    this.draw();
  }

  async load() {
    try {
      await this.loadRows();
    } catch (err) {
      fill(this.grid, h('div', { class: 'om-field__error' }, `叢集清單讀不到：${err.message}`));
      return;
    }
    this.draw();
  }

  // `extra`: { avg, avgTitle, title } - a second small line under the first, and a tooltip for the box.
  stat1(key, label, value, sub, tone = '', extra = {}) {
    let el = this.stat[key];
    if (!el) {
      el = this.stat[key] = { el: h('div', { class: 'cl-stat', dataset: { stat: key } }), sig: '' };
    }
    const sig = JSON.stringify([label, value, sub, tone, extra]);
    if (el.sig !== sig) {
      el.sig = sig;
      el.el.className = `cl-stat${tone ? ` ${tone}` : ''}`;
      el.el.title = extra.title || '';
      fill(
        el.el,
        h('div', { class: 'cl-stat-num', dataset: { field: 'num' } }, value),
        h('div', { class: 'cl-stat-label' }, label),
        sub ? h('div', { class: 'cl-stat-sub', dataset: { field: 'sub' } }, sub) : null,
        extra.avg ? h('div', { class: 'cl-stat-sub cl-stat-avg', dataset: { field: 'avg' }, title: extra.avgTitle || '' }, extra.avg) : null,
      );
    }
    return el.el;
  }

  draw() {
    const rows = this.rows();
    const t = totalsOf(rows);
    const ov = outputTotalView(t);
    const avg = speedView({ tokensPerSecond: t.avgTokensPerSecond });
    const known = rows.some((r) => r.subagents);
    fill(
      this.statsEl,
      this.stat1('subagents-running', '執行中子代理', rows.length && known ? String(t.subagentsRunning) : DASH, rows.length ? (known ? `共開過 ${t.subagentsOpened} 個${t.subagentsPartial ? '（有叢集量不到）' : ''}` : '量不到') : null, t.subagentsRunning ? 'live' : ''),
      this.stat1('workers-running', '執行中工作者', String(t.workersRunning), `${t.active} 個叢集進行中`, t.workersRunning ? 'live' : ''),
      this.stat1('output', '叢集總產出', ov.num, ov.measured ? `tok/s・${ov.sub}` : ov.sub, '', {
        title: ov.measured ? ov.tip : `量不到：${ov.why}`,
        avg: `平均產出（最近 5 分鐘）${avg.measured ? avg.text : DASH}`,
        avgTitle: avg.measured ? avg.tip : `量不到：${avg.why}`,
      }),
    );
    const sorted = sortClusters(rows);
    this.empty.hidden = sorted.length > 0;
    const els = sorted.map((r) => {
      let c = this.cards.get(r.id);
      if (!c) this.cards.set(r.id, (c = new ClusterCard()));
      c.update(r, this.title(r));
      return c.el;
    });
    for (const id of [...this.cards.keys()]) if (!sorted.some((r) => r.id === id)) this.cards.delete(id);
    const now = [...this.grid.children];
    if (now.length !== els.length || now.some((e, i) => e !== els[i])) this.grid.replaceChildren(...els);
  }
}


// Used by the cluster page's own head too.
export const elapsedText = (c, now) => {
  const ms = clusterElapsed(c, now);
  return ms === null ? null : fmtMs(ms);
};
export { taskBar, barEl, relTime };
