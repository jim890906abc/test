// Renders a session's normalized event stream. Streaming deltas update nodes
// in place; markdown is re-rendered at most once per animation frame.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { h, fill, icon, fmtTokens, fmtDuration } from './dom.js';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  const div = h('div', { class: 'md', html });
  for (const a of div.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  for (const pre of div.querySelectorAll('pre')) {
    const btn = h('button', { class: 'btn sm ghost copy', title: '複製' }, icon('copy'));
    btn.onclick = () => {
      navigator.clipboard?.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
      fill(btn, icon('check'));
      setTimeout(() => fill(btn, icon('copy')), 1200);
    };
    pre.append(btn);
  }
  return div;
}

// ------------------------------------------------------------------ diffs

export function lineDiff(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  if (!oldText) return b.map((s) => ({ t: '+', s }));
  if (a.length * b.length > 2_500_000) {
    return [...a.map((s) => ({ t: '-', s })), ...b.map((s) => ({ t: '+', s }))];
  }
  // Trim common prefix/suffix, LCS on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      mid.push({ t: ' ', s: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ t: '-', s: A[i++] });
    else mid.push({ t: '+', s: B[j++] });
  }
  while (i < n) mid.push({ t: '-', s: A[i++] });
  while (j < m) mid.push({ t: '+', s: B[j++] });
  return [...a.slice(0, pre).map((s) => ({ t: ' ', s })), ...mid, ...b.slice(b.length - suf).map((s) => ({ t: ' ', s }))];
}

export function renderLineDiff(path, oldText, newText) {
  const lines = lineDiff(oldText, newText);
  const box = h('div', { class: 'diff' });
  if (path) box.append(h('div', { class: 'diff-file' }, path));
  const CONTEXT = 3;
  const keep = lines.map((l, i) => l.t !== ' ' || lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.t !== ' '));
  let skipped = 0;
  const flush = () => {
    if (skipped) box.append(h('div', { class: 'dl hunk' }, `⋯ ${skipped} 行未變更`));
    skipped = 0;
  };
  lines.forEach((l, i) => {
    if (!keep[i]) return skipped++;
    flush();
    box.append(h('div', { class: `dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}` }, `${l.t} ${l.s}`));
  });
  flush();
  return box;
}

export function renderUnifiedDiff(text) {
  const box = h('div', { class: 'diff' });
  for (const line of String(text || '').split('\n')) {
    let cls = '';
    if (line.startsWith('diff --git')) {
      box.append(h('div', { class: 'diff-file' }, line.replace(/^diff --git a\/(.+?) b\/.*/, '$1')));
      continue;
    }
    if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+++') || line.startsWith('---') || /^(index|new file|deleted file|similarity|rename|old mode|new mode)/.test(line)) cls = 'meta';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    box.append(h('div', { class: `dl ${cls}` }, line || ' '));
  }
  return box;
}

// ------------------------------------------------------------ tool cards

const HUB_LABELS = {
  bash: '執行',
  read_file: '讀取',
  write_file: '寫入',
  edit_file: '編輯',
  list_files: '列出',
  search: '搜尋',
  delegate_to_agent: '委派',
};
const KIND_LABELS = {
  read: '讀取',
  edit: '編輯',
  delete: '刪除',
  move: '移動',
  search: '搜尋',
  execute: '執行',
  think: '思考',
  fetch: '擷取',
  switch_mode: '切換模式',
  other: '工具',
};

function statusIcon(status) {
  const s = h('span', { class: `tstat ${status || ''}` });
  if (status === 'running') s.append(h('span', { class: 'spinner' }));
  else if (status === 'done') s.append(icon('check'));
  else if (status === 'error' || status === 'denied') s.append(icon('x'));
  else if (status === 'awaiting') s.append(icon('hand'));
  else if (status === 'interrupted') s.append(icon('stop'));
  else s.append(h('span', { class: 'pend' }));
  return s;
}

function pretty(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function clip(s, n = 20000) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n… (已截斷 ${s.length - n} 字元)` : s;
}

function toolBody(ev, ctx) {
  const parts = [];
  const sec = (label, node) => parts.push(h('div', { class: 'sec-label' }, label), node);
  if (ev.source === 'acp') {
    const content = Array.isArray(ev.content) ? ev.content : [];
    const hasDiff = content.some((c) => c.type === 'diff');
    if (ev.input != null && !hasDiff && pretty(ev.input).trim()) sec('輸入', h('pre', { class: 'term' }, clip(pretty(ev.input), 4000)));
    for (const c of content) {
      if (c.type === 'diff') parts.push(renderLineDiff(c.path, c.oldText, c.newText));
      else if (c.type === 'terminal') parts.push(h('div', { class: 'muted' }, `終端機 ${c.terminalId}`));
      else if (c.type === 'content' && c.content?.type === 'text') parts.push(h('pre', { class: 'term' }, clip(c.content.text)));
      else if (c.type === 'content' && c.content?.type === 'image') parts.push(h('img', { src: `data:${c.content.mimeType};base64,${c.content.data}`, style: { maxWidth: '100%', borderRadius: '8px' } }));
      else if (c.type === 'content' && c.content) parts.push(h('pre', { class: 'term' }, clip(pretty(c.content), 4000)));
    }
    if (!content.length && ev.rawOutput != null && pretty(ev.rawOutput).trim()) sec('輸出', h('pre', { class: 'term' }, clip(pretty(ev.rawOutput))));
    if (ev.locations?.length) {
      parts.push(h('div', { class: 'locs' }, ev.locations.map((l) => h('span', { class: 'chip path', title: l.path }, `${ctx.relPath?.(l.path) ?? l.path}${l.line != null ? `:${l.line}` : ''}`))));
    }
  } else {
    const input = ev.input || {};
    if (ev.name === 'bash') sec('指令', h('pre', { class: 'term' }, `$ ${input.command ?? ''}`));
    else if (ev.name === 'write_file') parts.push(renderLineDiff(input.path, '', clip(input.content, 30000)));
    else if (ev.name === 'edit_file') parts.push(renderLineDiff(input.path, input.old_string, input.new_string));
    else if (ev.name === 'delegate_to_agent') sec(`交給 ${input.agent_id}`, h('div', { class: 'md' }, input.task));
    else if (Object.keys(input).length) sec('輸入', h('pre', { class: 'term' }, clip(pretty(input), 4000)));
    if (ev.childSessionId) {
      parts.push(h('a', { class: 'child-link', href: `#/s/${ev.childSessionId}` }, '開啟子 session →'));
    }
    if (ev.output) sec('輸出', h('pre', { class: 'term out' }, clip(ev.output)));
  }
  if (!parts.length) parts.push(h('div', { class: 'muted', style: { fontSize: '13px' } }, '（沒有更多細節）'));
  return parts;
}

function renderPermission(ev, ctx) {
  const p = ev.permission;
  if (!p) return null;
  if (p.chosen) {
    const opt = p.options?.find((o) => o.optionId === p.chosen);
    const text = p.chosen === 'cancelled' ? '已取消' : `${p.auto ? '依權限模式自動選擇' : '已選擇'}：${opt?.name ?? p.chosen}`;
    return h('div', { class: 'perm-note' }, text);
  }
  const btns = (p.options || []).map((o) => {
    const cls = o.kind?.startsWith('reject') ? 'btn sm danger' : o.kind === 'allow_once' ? 'btn sm primary' : 'btn sm';
    return h('button', { class: cls, onclick: (e) => (e.currentTarget.disabled = true, ctx.onPermission(ev.id, o.optionId)) }, o.name);
  });
  return h('div', { class: 'perm' }, h('div', { class: 'q' }, `${ctx.agentName()} 想要${KIND_LABELS[ev.kind] || HUB_LABELS[ev.name] || '使用工具'}：${ev.title || ev.name}`), h('div', { class: 'opts' }, btns));
}

function renderTool(ev, ctx, conv) {
  const awaiting = ev.permission && !ev.permission.chosen;
  const label = ev.source === 'acp' ? KIND_LABELS[ev.kind] || ev.name || '工具' : HUB_LABELS[ev.name] || ev.name;
  const wasOpen = conv.openState.get(ev.id);
  const autoOpen = awaiting || (ev.source === 'acp' && ev.kind === 'edit' && ev.content?.some?.((c) => c.type === 'diff'));
  const open = wasOpen ?? autoOpen;
  const card = h('div', { class: `tool ${open ? 'open' : ''} ${awaiting ? 'awaiting' : ''}` });
  const head = h(
    'div',
    { class: 'tool-head' },
    statusIcon(awaiting ? 'awaiting' : ev.status),
    h('span', { class: 'label' }, label),
    h('span', { class: 't-title', title: ev.title || '' }, ev.title || ''),
    icon('chev', 'chev'),
  );
  head.onclick = () => {
    const now = !card.classList.contains('open');
    card.classList.toggle('open', now);
    conv.openState.set(ev.id, now);
  };
  card.append(head, h('div', { class: 'tool-body' }, toolBody(ev, ctx)));
  const perm = renderPermission(ev, ctx);
  if (perm) card.append(perm);
  return card;
}

// ---------------------------------------------------------- other events

function renderEvent(ev, ctx, conv) {
  switch (ev.type) {
    case 'user': {
      const long = (ev.text || '').length > 700 || (ev.text || '').split('\n').length > 14;
      const box = h('div', { class: `ev-user ${long ? 'long' : ''}` });
      if (ev.images?.length) box.append(h('div', { class: 'imgs' }, ev.images.map((src) => h('img', { src }))));
      box.append(h('div', { class: 'body' }, ev.text));
      if (long) {
        const more = h('button', { class: 'more' }, '顯示全部');
        more.onclick = () => {
          box.classList.toggle('expanded');
          more.textContent = box.classList.contains('expanded') ? '收合' : '顯示全部';
        };
        box.append(more);
      }
      return box;
    }
    case 'text':
      if (ev.mono) return h('div', { class: 'ev-text' }, h('pre', { class: 'term' }, ev.text));
      return h('div', { class: 'ev-text' }, renderMarkdown(ev.text));
    case 'thinking': {
      const d = h('details', { class: 'ev-thinking' });
      const last = (ev.text || '').trim().split('\n').pop() || '';
      d.append(
        h('summary', null, icon('chev', 'chev'), h('span', null, '思考過程'), h('span', { class: 'preview' }, last.slice(-160))),
        h('div', { class: 'body' }, ev.text),
      );
      if (conv.openState.get(ev.id)) d.open = true;
      d.addEventListener('toggle', () => conv.openState.set(ev.id, d.open));
      return d;
    }
    case 'tool_use':
      return renderTool(ev, ctx, conv);
    case 'plan':
      return h(
        'div',
        { class: 'ev-plan' },
        h('div', { class: 'ph' }, icon('list'), '計畫'),
        (ev.entries || []).map((e) => h('div', { class: `plan-item ${e.status}` }, h('span', { class: 'box' }), h('span', { class: 'txt' }, e.content))),
      );
    case 'info':
      return h('div', { class: 'ev-info' }, ev.text);
    case 'error': {
      const body = h('div', null, ev.text);
      if (/尚未登入/.test(ev.text) && ctx.canLogin()) {
        body.append(h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => ctx.openLogin() }, icon('login'), '在網頁登入')));
      }
      return h('div', { class: 'ev-error' }, icon('alert'), body);
    }
    case 'turn_end': {
      const u = ev.usage || {};
      const bits = [ev.interrupted ? '已中斷' : ev.error ? '未完成' : '完成', fmtDuration(ev.durationMs || 0)];
      if (u.inputTokens || u.outputTokens) bits.push(`↑${fmtTokens(u.inputTokens)} ↓${fmtTokens(u.outputTokens)} tokens`);
      return h('div', { class: 'ev-turn' }, bits.join(' · '));
    }
    default:
      return h('div', { class: 'ev-info' }, `[${ev.type}]`);
  }
}

// ------------------------------------------------------------ the thread

const VERBS = ['思考中', '處理中', '執行中', '撰寫中', '分析中', '整理中'];

export class Conversation {
  constructor({ sid, ctx, compact = false }) {
    this.sid = sid;
    this.ctx = ctx;
    this.compact = compact;
    this.events = [];
    this.nodes = new Map();
    this.openState = new Map();
    this.dirty = new Set();
    this.el = h('div', { class: 'thread' });
    this.working = h('div', { class: 'working hidden' });
    this.el.append(this.working);
    this.raf = 0;
  }

  get scroller() {
    return this.el.closest('.scroller');
  }

  nearBottom() {
    const s = this.scroller;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  scrollToEnd(force) {
    const s = this.scroller;
    if (s && (force || this.stick)) s.scrollTop = s.scrollHeight;
  }

  setEvents(events) {
    this.events = events;
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
    const frag = document.createDocumentFragment();
    for (const ev of events) {
      const node = renderEvent(ev, this.ctx, this);
      this.nodes.set(ev.id, node);
      frag.append(node);
    }
    this.el.insertBefore(frag, this.working);
    this.stick = true;
    requestAnimationFrame(() => this.scrollToEnd(true));
  }

  append(ev) {
    this.stick = this.nearBottom();
    this.events.push(ev);
    const node = renderEvent(ev, this.ctx, this);
    this.nodes.set(ev.id, node);
    this.el.insertBefore(node, this.working);
    if (ev.type === 'text' || ev.type === 'thinking') this.markStreaming(ev.id);
    this.scrollToEnd();
  }

  find(id) {
    return this.events.find((e) => e.id === id);
  }

  delta(id, field, text) {
    const ev = this.find(id);
    if (!ev) return;
    ev[field] = (ev[field] || '') + text;
    const node = this.nodes.get(id);
    if (!node) return;
    this.stick = this.nearBottom();
    // Fast paths that avoid re-rendering the whole node.
    if (ev.type === 'tool_use' && field === 'output') {
      const out = node.querySelector('.term.out');
      if (out) {
        out.textContent += text;
        out.scrollTop = out.scrollHeight;
        return this.scrollToEnd();
      }
    }
    if (ev.type === 'thinking') {
      node.querySelector('.body').textContent = ev.text;
      node.querySelector('.preview').textContent = (ev.text.trim().split('\n').pop() || '').slice(-160);
      this.markStreaming(id);
      return this.scrollToEnd();
    }
    if (ev.type === 'text' && ev.mono) {
      node.querySelector('pre').textContent = ev.text;
      return this.scrollToEnd();
    }
    this.markStreaming(id);
    this.dirty.add(id);
    this.schedule();
  }

  markStreaming(id) {
    if (this.streamingId !== id) this.nodes.get(this.streamingId)?.classList.remove('streaming');
    this.streamingId = id;
    this.nodes.get(id)?.classList.add('streaming');
  }

  patch(id, fields) {
    const ev = this.find(id);
    if (!ev) return;
    Object.assign(ev, fields);
    this.dirty.add(id);
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      for (const id of this.dirty) {
        const ev = this.find(id);
        const old = this.nodes.get(id);
        if (!ev || !old) continue;
        const node = renderEvent(ev, this.ctx, this);
        if (id === this.streamingId) node.classList.add('streaming');
        old.replaceWith(node);
        this.nodes.set(id, node);
      }
      this.dirty.clear();
      this.scrollToEnd();
    });
  }

  setStatus(summary) {
    const st = summary?.status;
    clearInterval(this.timer);
    if (st !== 'running' && st !== 'awaiting_permission') {
      this.working.classList.add('hidden');
      this.nodes.get(this.streamingId)?.classList.remove('streaming');
      this.streamingId = null;
      return;
    }
    const lastUser = [...this.events].reverse().find((e) => e.type === 'user');
    const started = lastUser?.ts || Date.now();
    const awaiting = st === 'awaiting_permission';
    this.working.className = `working ${awaiting ? 'awaiting' : ''}`;
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
      const verb = awaiting ? '等待你的確認' : VERBS[Math.floor(secs / 4) % VERBS.length];
      fill(this.working, h('span', { class: 'star' }, icon('logo')), h('span', null, `${verb}…`), h('span', { class: 'el' }, `${secs} 秒`));
    };
    tick();
    this.timer = setInterval(tick, 1000);
    this.stick = this.nearBottom();
    this.scrollToEnd();
  }

  destroy() {
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
  }
}
