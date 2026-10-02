// The conversation view. Events arrive one at a time (event / patch / delta)
// and each maps to one DOM node that is re-rendered in place, at most once
// per animation frame, so long conversations stay fast while streaming.
// Subagent events carry `parent` and render inside their Agent card.
import { h, fill, icon, fmtDuration } from './dom.js';
import { markdownInto, renderMarkdown, renderLineDiff, diffStats } from './markdown.js';
import { artifactOf, collectArtifacts, artifactCard } from './artifacts.js';

export const TOOLS = {
  Bash: ['terminal', '執行'],
  Shell: ['terminal', '執行'],
  Read: ['eye', '讀取'],
  ReadFile: ['eye', '讀取'],
  Write: ['filePlus', '寫入'],
  WriteFile: ['filePlus', '寫入'],
  Edit: ['pencil', '編輯'],
  MultiEdit: ['pencil', '編輯'],
  StrReplaceFile: ['pencil', '編輯'],
  Glob: ['files', '找檔案'],
  Grep: ['search', '搜尋'],
  FetchURL: ['globe', '讀取網頁'],
  WebFetch: ['globe', '讀取網頁'],
  WebSearch: ['globe', '搜尋網路'],
  SearchWeb: ['globe', '搜尋網路'],
  Agent: ['agents', '子代理'],
  AgentSwarm: ['agents', '子代理群'],
  Task: ['agents', '子代理'],
  btw: ['question', '順便問'],
  TodoList: ['todo', '待辦'],
  TodoWrite: ['todo', '待辦'],
  SetTodoList: ['todo', '待辦'],
  AskUserQuestion: ['question', '提問'],
  EnterPlanMode: ['map', '進入計畫模式'],
  ExitPlanMode: ['map', '計畫'],
  Skill: ['bolt', '技能'],
  TaskList: ['clock', '背景工作'],
  TaskOutput: ['clock', '背景工作輸出'],
  TaskStop: ['clock', '停止背景工作'],
  WaitFor: ['clock', '等待背景工作'],
  CronCreate: ['clock', '建立排程'],
  CronList: ['clock', '排程'],
  CronDelete: ['clock', '刪除排程'],
  CreateGoal: ['sparkle', '設定目標'],
  GetGoal: ['sparkle', '目標'],
  UpdateGoal: ['sparkle', '更新目標'],
  SetGoalBudget: ['sparkle', '目標預算'],
};

const ACTIVE = ['pending', 'running', 'awaiting'];
// Look-around tools: a run of them folds into one line, like Claude Code.
const LOOK = /^(Read|ReadFile|ReadMediaFile|Glob|Grep|FetchURL|WebFetch|WebSearch|SearchWeb)$/;
const lineCount = (t) => (t ? String(t).replace(/\n+$/, '').split('\n').length : 0);
const isAgent = (ev) => Boolean(ev.subagent) || /^(Agent|AgentSwarm|Task)$/.test(ev.name);
const isTodo = (ev) => /^(TodoList|TodoWrite|SetTodoList)$/.test(ev.name);

export class Transcript {
  // opts: { cwd, onRespond(ev, optionId, extra), onOpenArtifact(path, versionId), onCopy }
  constructor(opts) {
    this.opts = opts;
    this.column = h('div', { class: 'column' });
    this.working = h('div', { class: 'working', hidden: true });
    // Back to the newest message when scrolled up (lit when more arrived).
    this.jump = h('button', { class: 'jump-end', type: 'button', title: '到最新訊息', 'aria-label': '到最新訊息', onclick: () => this.toEnd() }, icon('down'));
    this.jumpBar = h('div', { class: 'jump-bar', hidden: true }, this.jump);
    this.el = h('div', { class: 'transcript', tabindex: '-1' }, this.column, this.working, this.jumpBar);
    this.events = new Map();
    this.order = [];
    this.nodes = new Map();
    this.waiting = new Map(); // parent id -> child ids that arrived first
    this.groupOf = new Map(); // event id -> the look-around group it sits in
    this.dirtyGroups = new Set();
    this.dirty = new Set();
    this.open = new Set(); // ids the user expanded
    this.shut = new Set(); // ids the user collapsed
    this.stick = true;
    this.raf = 0;
    this.status = 'idle';
    this.el.addEventListener('scroll', () => {
      const atEnd = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
      if (this.jumping && !atEnd) return; // mid smooth-scroll to the end
      this.jumping = false;
      this.stick = atEnd;
      this.jumpBar.hidden = this.stick;
      if (this.stick) this.jump.classList.remove('new');
    });
    this.tick = setInterval(() => this.renderWorking(), 1000);
    // Messages out of view are laid out lazily (content-visibility), so the
    // column keeps settling after a render: stay pinned to the end while
    // following it.
    this.resize = new ResizeObserver(() => this.stick && this.scrollToEnd());
    this.resize.observe(this.column);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.tick);
    this.resize.disconnect();
  }

  load(events) {
    this.events.clear();
    this.order = [];
    this.nodes.clear();
    this.waiting.clear();
    this.groupOf.clear();
    this.column.replaceChildren();
    for (const ev of events) this.add(ev, true);
    this.flush();
    this.scrollToEnd();
  }

  add(ev, batch = false) {
    if (this.events.has(ev.id)) return this.patch(ev.id, ev);
    this.events.set(ev.id, ev);
    this.order.push(ev.id);
    this.grew = true;
    const node = this.makeNode(ev);
    this.nodes.set(ev.id, node);
    this.mount(node);
    this.markDirty(ev.id, batch);
    if (ev.parent) this.markDirty(ev.parent, batch); // parent shows the latest activity
    if (artifactOf(ev)) this.artifactsChanged = true;
  }

  patch(id, fields) {
    const ev = this.events.get(id);
    if (!ev) return;
    Object.assign(ev, fields);
    this.markDirty(id);
    if (ev.parent) this.markDirty(ev.parent);
    if (ev.type === 'tool_use' && (artifactOf(ev) || 'input' in fields)) this.artifactsChanged = true;
  }

  delta(id, field, text) {
    const ev = this.events.get(id);
    if (!ev) return;
    ev[field] = (ev[field] || '') + text;
    this.grew = true;
    this.markDirty(id);
    if (ev.parent) this.markDirty(ev.parent);
    if (field === 'argsText' && artifactOf(ev)) this.artifactsChanged = true;
  }

  get(id) {
    return this.events.get(id);
  }

  all() {
    return this.order.map((id) => this.events.get(id));
  }

  artifacts() {
    return collectArtifacts(this.all());
  }

  setStatus(status, since) {
    this.status = status;
    if (since) this.since = since;
    this.renderWorking();
    // The last open thinking/tool rows reflect whether Kimi is still going.
    for (const id of this.order.slice(-6)) this.markDirty(id);
  }

  markDirty(id, batch) {
    this.dirty.add(id);
    const g = this.groupOf.get(id);
    if (g) this.dirtyGroups.add(g);
    if (!batch && !this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.raf = 0;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) this.render(node);
    }
    for (const g of this.dirtyGroups) this.renderGroup(g);
    this.dirtyGroups.clear();
    if (this.artifactsChanged) {
      this.artifactsChanged = false;
      this.opts.onArtifacts?.(this.artifacts());
    }
    if (this.stick) this.scrollToEnd();
    else if (this.grew) this.jump.classList.add('new');
    this.grew = false;
  }

  scrollToEnd() {
    this.el.scrollTop = this.el.scrollHeight;
  }

  toEnd() {
    this.stick = true;
    this.jumping = true;
    this.jumpBar.hidden = true;
    this.jump.classList.remove('new');
    this.el.scrollTo({ top: this.el.scrollHeight, behavior: 'smooth' });
  }

  // ------------------------------------------------------------ nodes

  makeNode(ev) {
    const el = h('div', { class: `ev ev-${ev.type}`, dataset: { id: ev.id } });
    const node = { ev, el, children: null };
    if (ev.type === 'tool_use') {
      node.head = h('div', { class: 'tool-head' });
      node.body = h('div', { class: 'tool-body' });
      node.children = h('div', { class: 'tool-children' });
      el.append(node.head, node.body, node.children);
    }
    return node;
  }

  mount(node) {
    const { ev } = node;
    if (ev.parent) {
      const parent = this.nodes.get(ev.parent);
      if (parent?.children) parent.children.append(node.el);
      else {
        const list = this.waiting.get(ev.parent) || [];
        list.push(ev.id);
        this.waiting.set(ev.parent, list);
      }
    } else if ((ev.type === 'tool_use' && LOOK.test(ev.name)) || ev.type === 'thinking') this.joinGroup(node);
    else this.column.append(node.el);
    const kids = this.waiting.get(ev.id);
    if (kids && node.children) {
      this.waiting.delete(ev.id);
      for (const k of kids) node.children.append(this.nodes.get(k).el);
    }
  }

  render(node) {
    const ev = node.ev;
    switch (ev.type) {
      case 'user':
        return this.renderUser(node);
      case 'text':
        if (!node.md) node.el.append((node.md = h('div', { class: 'md' })));
        markdownInto(node.md, ev.text);
        node.el.hidden = !ev.text?.trim();
        return;
      case 'thinking':
        return this.renderThinking(node);
      case 'tool_use':
        return this.renderTool(node);
      case 'info':
        if (ev.more) return fill(node.el, h('button', { class: 'om-btn om-btn--sm load-earlier', type: 'button', onclick: (e) => ((e.currentTarget.disabled = true), this.opts.onLoadEarlier?.()) }, '載入更早的對話'));
        return fill(node.el, h('span', { class: 'note' }, ev.text));
      case 'error':
        return fill(node.el, h('div', { class: 'callout danger' }, icon('alert'), h('div', { class: 'callout-text' }, ev.text)));
      case 'turn_end':
        node.el.hidden = !(ev.interrupted || ev.error);
        return fill(node.el, h('span', { class: 'note' }, ev.interrupted ? '已中斷' : '這一輪沒有完成'));
      default:
        node.el.hidden = true;
    }
  }

  renderUser(node) {
    const ev = node.ev;
    const images = (ev.images || []).map((src) => (src ? h('img', { class: 'user-img', src, alt: '附加的圖片', loading: 'lazy', onclick: () => this.opts.onImage?.(src) }) : h('span', { class: 'user-img placeholder' }, icon('image'), '圖片')));
    const note = ev.steered ? '在 Kimi 工作時插入' : ev.note;
    fill(
      node.el,
      h('div', { class: 'bubble' }, images.length ? h('div', { class: 'user-imgs' }, images) : null, ev.text ? h('div', { class: 'user-text' }, ev.text) : null),
      note ? h('div', { class: 'bubble-note' }, note) : null,
    );
  }

  renderThinking(node) {
    const ev = node.ev;
    const live = this.isLive(ev);
    const open = this.open.has(ev.id);
    fill(
      node.el,
      h(
        'button',
        { class: `fold${live ? ' live' : ''}`, type: 'button', 'aria-expanded': String(open), onclick: () => this.toggle(ev.id, open) },
        icon('brain'),
        h('span', null, live ? '思考中' : '思考過程'),
        icon('chev', 'chev'),
      ),
      open ? h('div', { class: 'thinking-text' }, ev.text) : null,
    );
  }

  // The newest unfinished row while Kimi is working.
  isLive(ev) {
    if (this.status !== 'running') return false;
    const siblings = this.order.filter((id) => (this.events.get(id).parent || null) === (ev.parent || null));
    return siblings.at(-1) === ev.id;
  }

  toggle(id, wasOpen) {
    if (wasOpen) (this.open.delete(id), this.shut.add(id));
    else (this.open.add(id), this.shut.delete(id));
    if (id.startsWith('g:')) this.markDirty(id.slice(2));
    else this.markDirty(id);
  }

  expanded(ev, byDefault) {
    if (this.open.has(ev.id)) return true;
    if (this.shut.has(ev.id)) return false;
    return byDefault;
  }

  // ------------------------------------------------------------ groups
  // Reads, searches and the thinking between them collapse into one row
  // ("讀取 3 個檔案、搜尋 2 次") that opens to show each step.

  joinGroup(node) {
    const last = this.column.lastElementChild;
    let g = last && this.groupEls?.get(last);
    if (!g) {
      g = { id: `g:${node.ev.id}`, members: [], head: h('div', { class: 'tool-head' }), body: h('div', { class: 'group-body' }) };
      g.el = h('div', { class: 'ev tool-group' }, g.head, g.body);
      (this.groupEls ??= new WeakMap()).set(g.el, g);
      this.column.append(g.el);
    }
    g.members.push(node.ev.id);
    g.body.append(node.el);
    this.groupOf.set(node.ev.id, g);
    this.dirtyGroups.add(g);
  }

  renderGroup(g) {
    const evs = g.members.map((id) => this.events.get(id));
    const tools = evs.filter((e) => e.type === 'tool_use');
    const solo = tools.length < 2;
    g.el.className = `ev tool-group ${solo ? `solo ev-${(tools[0] || evs[0]).type}` : 'ev-tool_use'}`;
    if (solo) {
      fill(g.head);
      g.body.hidden = false;
      return;
    }
    const busy = tools.some((e) => ACTIVE.includes(e.status) && this.status === 'running');
    const urgent = tools.some((e) => e.status === 'error' || (e.permission && !e.permission.chosen));
    const open = urgent || this.expanded({ id: g.id }, false);
    const n = (re) => tools.filter((e) => re.test(e.name)).length;
    const parts = [
      [n(/^Read/), (k) => `讀取 ${k} 個檔案`],
      [n(/^Grep$/), (k) => `搜尋 ${k} 次`],
      [n(/^Glob$/), (k) => `找檔案 ${k} 次`],
      [n(/^(WebSearch|SearchWeb)$/), (k) => `搜尋網路 ${k} 次`],
      [n(/^(FetchURL|WebFetch)$/), (k) => `讀取 ${k} 個網頁`],
    ]
      .filter(([k]) => k)
      .map(([k, f]) => f(k));
    const current = busy ? tools.at(-1) : null;
    fill(
      g.head,
      h(
        'button',
        { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => !urgent && this.toggle(g.id, open) },
        h('span', { class: 'tool-icon' }, icon('search')),
        h('span', { class: 'tool-verb' }, parts.join('、')),
        h('span', { class: 'tool-target' }, current ? this.target(current) : null),
        busy ? h('span', { class: 'spinner', 'aria-label': '執行中' }) : null,
        urgent ? null : icon('chev', 'chev'),
      ),
    );
    g.body.hidden = !open;
  }

  // ------------------------------------------------------------- tools

  renderTool(node) {
    const ev = node.ev;
    const [ic, verb] = TOOLS[ev.name] || ['bolt', ev.name.replace(/^mcp__/, '').replace(/__/g, ' · ')];
    const waiting = ev.permission && !ev.permission.chosen;
    const art = artifactOf(ev);
    node.el.className = `ev ev-tool_use tool status-${ev.status}${waiting ? ' waiting' : ''}${isAgent(ev) ? ' agent' : ''}${ev.parent ? ' nested' : ''}`;

    if (art && !waiting) return this.renderArtifactTool(node, art);
    if (isTodo(ev) && (ev.todos || ev.input?.todos)) return this.renderTodos(node);
    if (isAgent(ev)) return this.renderAgent(node, ic, verb);

    const open = waiting || this.expanded(ev, ['Edit', 'MultiEdit', 'StrReplaceFile'].includes(ev.name) || ev.status === 'error');
    fill(
      node.head,
      h(
        'button',
        { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => !waiting && this.toggle(ev.id, open) },
        h('span', { class: 'tool-icon' }, icon(ic)),
        h('span', { class: 'tool-verb' }, verb),
        h('span', { class: 'tool-target' }, this.target(ev)),
        this.meta(ev),
        this.statusMark(ev),
        waiting ? null : icon('chev', 'chev'),
      ),
    );
    fill(node.body, ...(open ? this.toolBody(ev) : this.peek(ev)));
    if (waiting) node.body.append(this.permissionUI(ev));
    else if (ev.permission?.chosen && !/^approved/.test(ev.permission.chosen)) node.body.append(this.permissionResult(ev));
  }

  target(ev) {
    const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
    const rel = (p) => {
      const cwd = this.opts.cwd;
      return cwd && p?.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
    };
    if (ev.name === 'Bash' || ev.name === 'Shell') return h('code', null, (input.command || ev.title || '').split('\n')[0]);
    if (input.path || input.file_path) return h('code', null, rel(input.path || input.file_path));
    if (input.pattern) return h('code', null, input.pattern);
    if (input.url) return h('span', null, input.url);
    if (ev.name === 'AskUserQuestion') return h('span', null, ev.title);
    if (ev.name === 'Skill') return h('code', null, `/${input.skill || ''}`);
    const t = ev.title && ev.title !== ev.name ? ev.title : '';
    if (!t && ev.argsText && ev.status === 'pending') return h('span', { class: 'muted' }, '…');
    return h('span', null, rel(t));
  }

  meta(ev) {
    const input = ev.input || {};
    if (/^(Edit|MultiEdit|StrReplaceFile)$/.test(ev.name) && typeof input.old_string === 'string') {
      const s = diffStats(input.old_string, input.new_string);
      return h('span', { class: 'tool-meta' }, h('span', { class: 'plus' }, `+${s.added}`), h('span', { class: 'minus' }, `−${s.removed}`));
    }
    if (/^Write/.test(ev.name) && typeof input.content === 'string') return h('span', { class: 'tool-meta' }, h('span', { class: 'plus' }, `+${input.content.split('\n').length}`));
    return null;
  }

  statusMark(ev) {
    if (ev.permission && !ev.permission.chosen) return h('span', { class: 'om-badge om-badge--warning' }, ev.permission.kind === 'question' ? '等你回答' : '等你核准');
    if (ev.status === 'pending' || ev.status === 'running') return h('span', { class: 'spinner', 'aria-label': '執行中' });
    if (ev.status === 'error') return h('span', { class: 'mark danger', title: '失敗' }, icon('alert'));
    if (ev.status === 'interrupted') return h('span', { class: 'mark-text' }, '已中斷');
    if (ev.permission?.chosen === 'rejected') return h('span', { class: 'mark-text' }, '已拒絕');
    return null;
  }

  // Collapsed rows still show what matters: live output while a command
  // runs, the first line of an error.
  // Finished ones get a one-line result under them, like Claude Code's
  // "⎿ Read 120 lines": the first lines of a command's output, how many
  // lines were read, how many matches were found.
  peek(ev) {
    const bash = /^(Bash|Shell)$/.test(ev.name);
    if (ev.status === 'running' && ev.output && bash) {
      return [h('pre', { class: 'tail' }, ev.output.replace(/\n$/, '').split('\n').slice(-3).join('\n'))];
    }
    if (ev.status !== 'done') return [];
    const out = String(ev.output || '').replace(/\s+$/, '');
    const n = lineCount(out);
    const line = (text) => [h('div', { class: 'result' }, text)];
    if (bash) {
      if (!out) return line('（沒有輸出）');
      const lines = out.split('\n');
      return [h('pre', { class: 'result-out' }, lines.slice(0, 3).join('\n')), lines.length > 3 ? h('div', { class: 'result' }, `… 還有 ${lines.length - 3} 行`) : null].filter(Boolean);
    }
    if (/^Read/.test(ev.name)) return line(n ? `讀了 ${n} 行` : '空的檔案');
    if (ev.name === 'Grep') return line(n ? `找到 ${n} 筆` : '沒有找到');
    if (ev.name === 'Glob') return line(n ? `找到 ${n} 個檔案` : '沒有找到');
    if (/^(Write|WriteFile|Edit|MultiEdit|StrReplaceFile|TodoList|TodoWrite|SetTodoList|ExitPlanMode|EnterPlanMode|AskUserQuestion)$/.test(ev.name)) return [];
    if (!out) return [];
    const first = out.split('\n')[0];
    return line(n > 1 ? `${first.slice(0, 120)} …` : first.slice(0, 160));
  }

  toolBody(ev) {
    const input = ev.input && typeof ev.input === 'object' ? ev.input : null;
    const out = [];
    const output = (text, cls = '') => text && out.push(h('pre', { class: `out ${cls}` }, text.replace(/\n$/, '')));
    switch (ev.name) {
      case 'Bash':
      case 'Shell':
        if (input?.command?.includes('\n')) out.push(h('pre', { class: 'out cmd' }, input.command));
        output(ev.output, ev.status === 'error' ? 'err' : '');
        break;
      case 'Edit':
      case 'StrReplaceFile':
        if (typeof input?.old_string === 'string') out.push(renderLineDiff(input.old_string, input.new_string ?? '', { context: 2 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'MultiEdit':
        for (const e of input?.edits || []) out.push(renderLineDiff(e.old_string, e.new_string ?? '', { context: 2 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'Write':
      case 'WriteFile':
        if (typeof input?.content === 'string') out.push(renderLineDiff('', input.content, { context: 0 }));
        if (ev.status === 'error') output(ev.output, 'err');
        break;
      case 'ExitPlanMode':
        if (input?.plan) out.push(renderMarkdown(input.plan, 'md plan'));
        else output(ev.output);
        break;
      default:
        if (input && !/^(Read|ReadFile|Glob|Grep)$/.test(ev.name)) {
          const keys = Object.keys(input).filter((k) => input[k] !== '' && input[k] != null);
          if (keys.length) out.push(h('pre', { class: 'out args' }, keys.map((k) => `${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`).join('\n')));
        } else if (!input && ev.argsText) out.push(h('pre', { class: 'out args' }, ev.argsText));
        output(ev.output, ev.status === 'error' ? 'err' : '');
    }
    return out;
  }

  // --------------------------------------------------------- special

  renderTodos(node) {
    const ev = node.ev;
    const todos = ev.todos || ev.input?.todos || [];
    const done = todos.filter((t) => t.status === 'done' || t.status === 'completed').length;
    fill(node.head, h('div', { class: 'tool-row static' }, h('span', { class: 'tool-icon' }, icon('todo')), h('span', { class: 'tool-verb' }, '待辦'), h('span', { class: 'tool-target muted' }, `${done}/${todos.length} 完成`)));
    fill(node.body, todoList(todos));
  }

  renderAgent(node, ic, verb) {
    const ev = node.ev;
    const sub = ev.subagent || {};
    const input = ev.input || {};
    const kids = this.order.filter((id) => this.events.get(id).parent === ev.id).map((id) => this.events.get(id));
    const running = sub.status === 'running' || (!sub.status && ACTIVE.includes(ev.status));
    const open = this.expanded(ev, false);
    const steps = kids.filter((k) => k.type === 'tool_use').length;
    const last = [...kids].reverse().find((k) => k.type === 'tool_use' || (k.type === 'text' && k.text?.trim()));
    let activity = '';
    if (running && last) activity = last.type === 'tool_use' ? `${(TOOLS[last.name] || [null, last.name])[1]} ${last.title || ''}` : last.text.trim().split('\n').pop();
    const label = ev.name === 'btw' ? verb : `${verb}${sub.name && sub.name !== 'subagent' && sub.name !== 'btw' ? ` · ${sub.name}` : ''}`;
    const statusEl = running
      ? h('span', { class: 'spinner' })
      : sub.status === 'error' || ev.status === 'error'
        ? h('span', { class: 'mark danger', title: '失敗' }, icon('alert'))
        : sub.status === 'cancelled' || ev.status === 'interrupted'
          ? h('span', { class: 'mark-text' }, '已中斷')
          : null;
    fill(
      node.head,
      h(
        'button',
        { class: 'tool-row', type: 'button', 'aria-expanded': String(open), onclick: () => this.toggle(ev.id, open) },
        h('span', { class: 'tool-icon' }, icon(ic)),
        h('span', { class: 'tool-verb' }, label),
        h('span', { class: 'tool-target' }, sub.description || input.description || ev.title || ''),
        steps ? h('span', { class: 'tool-meta' }, `${steps} 個步驟`) : null,
        sub.background ? h('span', { class: 'om-badge' }, '背景') : null,
        statusEl,
        icon('chev', 'chev'),
      ),
    );
    const summary = sub.summary;
    fill(
      node.body,
      !open && running && activity ? h('div', { class: 'agent-activity' }, activity) : null,
      !open && !running && summary ? h('div', { class: 'agent-summary clamp' }, summary) : null,
      sub.error ? h('div', { class: 'callout danger small' }, icon('alert'), h('div', { class: 'callout-text' }, sub.error)) : null,
    );
    node.children.hidden = !open;
    if (open && summary && !running) {
      node.summary ??= h('div', { class: 'agent-summary' });
      fill(node.summary, h('div', { class: 'agent-summary-label' }, '子代理回報'), renderMarkdown(summary));
      node.children.append(node.summary);
    } else node.summary?.remove();
    if (ev.permission && !ev.permission.chosen) node.body.append(this.permissionUI(ev));
  }

  renderArtifactTool(node, art) {
    const ev = node.ev;
    const all = this.opts.artifactsCache?.() || this.artifacts();
    const a = all.find((x) => x.path === art.path) || { path: art.path, versions: [{ id: ev.id, html: art.content, streaming: true }] };
    fill(node.head);
    fill(node.body, artifactCard(a, ev.id, { onOpen: (path, id) => this.opts.onOpenArtifact?.(path, id), active: this.opts.activeArtifact?.() === art.path }));
    if (ev.status === 'error') node.body.append(h('pre', { class: 'out err' }, String(ev.output || '').replace(/\n$/, '')));
  }

  // -------------------------------------------------------- permission

  permissionUI(ev) {
    const p = ev.permission;
    if (p.kind === 'question') return this.questionForm(ev);
    const box = h('div', { class: 'ask' });
    const send = (optionId, extra) => {
      for (const b of box.querySelectorAll('button, textarea, input')) b.disabled = true;
      this.opts.onRespond(ev, optionId, extra).catch(() => {
        for (const b of box.querySelectorAll('button, textarea, input')) b.disabled = false;
      });
    };
    if (p.kind === 'plan') {
      if (p.plan) box.append(renderMarkdown(p.plan, 'md plan'));
      box.append(
        h('div', { class: 'ask-q' }, '要照這個計畫進行嗎？'),
        h(
          'div',
          { class: 'ask-actions' },
          ...p.options.map((o, i) => h('button', { class: `om-btn${i === 0 ? ' om-btn--primary' : ''}`, type: 'button', title: o.description || '', onclick: () => send(o.optionId) }, o.name)),
          this.rejectButton(box, send, '先不要'),
        ),
      );
      return box;
    }
    const verb = /^(Bash|Shell)$/.test(ev.name) ? '執行這個指令' : /^(Write|Edit|MultiEdit|StrReplaceFile)$/.test(ev.name) ? '修改這個檔案' : `使用 ${ev.name}`;
    box.append(
      h('div', { class: 'ask-q' }, `要讓 Kimi ${verb}嗎？`),
      h(
        'div',
        { class: 'ask-actions' },
        h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => send('approved') }, '允許'),
        h('button', { class: 'om-btn', type: 'button', title: `這個對話接下來的 ${ev.name} 都不再詢問`, onclick: () => send('approved_session') }, '這個對話都允許'),
        this.rejectButton(box, send, '拒絕…'),
      ),
    );
    return box;
  }

  // Reject, optionally telling Kimi what to do instead.
  rejectButton(box, send, label) {
    return h(
      'button',
      {
        class: 'om-btn',
        type: 'button',
        onclick: (e) => {
          const actions = e.currentTarget.parentElement;
          const ta = h('textarea', { class: 'om-input', rows: 2, placeholder: '告訴 Kimi 要改成怎麼做（可以留白）' });
          const form = h(
            'div',
            { class: 'ask-reject' },
            ta,
            h(
              'div',
              { class: 'ask-actions' },
              h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => send('rejected', { feedback: ta.value }) }, '拒絕'),
              h('button', { class: 'om-btn om-btn--plain', type: 'button', onclick: () => (form.remove(), (actions.hidden = false)) }, '返回'),
            ),
          );
          ta.addEventListener('keydown', (k) => {
            if (k.key === 'Enter' && !k.shiftKey && !k.isComposing) {
              k.preventDefault();
              send('rejected', { feedback: ta.value });
            }
          });
          actions.hidden = true;
          box.append(form);
          ta.focus();
        },
      },
      label,
    );
  }

  questionForm(ev) {
    const items = ev.permission.questions || [];
    const box = h('form', { class: 'ask question' });
    const fields = items.map((q, qi) => {
      const name = `${ev.id}-${qi}`;
      const multi = Boolean(q.multi_select);
      const options = (q.options || []).map((o) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { class: multi ? 'om-check' : 'om-radio', type: multi ? 'checkbox' : 'radio', name, value: o.id }),
          h('span', { class: 'choice-text' }, h('span', null, o.label), o.description ? h('span', { class: 'choice-desc' }, o.description) : null),
        ),
      );
      const other = q.allow_other ? h('input', { class: 'om-input other', type: 'text', placeholder: q.other_label || '其他答案' }) : null;
      box.append(
        h('fieldset', { class: 'q' }, h('legend', null, q.header ? h('span', { class: 'q-header' }, q.header) : null, q.question), q.body ? h('div', { class: 'q-body' }, q.body) : null, ...options, other),
      );
      return { q, name, multi, other };
    });
    const answers = () => {
      const out = {};
      for (const f of fields) {
        const picked = [...box.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value);
        const text = f.other?.value.trim();
        if (f.multi) out[f.q.id] = text ? { kind: 'multi_with_other', option_ids: picked, other_text: text } : picked.length ? { kind: 'multi', option_ids: picked } : { kind: 'skipped' };
        else out[f.q.id] = text ? { kind: 'other', text } : picked[0] ? { kind: 'single', option_id: picked[0] } : { kind: 'skipped' };
      }
      return out;
    };
    const send = (optionId, extra) => {
      for (const b of box.querySelectorAll('button, input')) b.disabled = true;
      this.opts.onRespond(ev, optionId, extra).catch(() => {
        for (const b of box.querySelectorAll('button, input')) b.disabled = false;
      });
    };
    // A single single-choice question answers on click, like the CLI.
    if (items.length === 1 && !fields[0].multi && !fields[0].other) {
      for (const input of box.querySelectorAll('input')) input.addEventListener('change', () => send('answer', { answers: answers() }));
    }
    box.append(
      h(
        'div',
        { class: 'ask-actions' },
        h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '送出答案'),
        h('button', { class: 'om-btn om-btn--plain', type: 'button', onclick: () => send('__dismiss') }, '略過'),
      ),
    );
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      send('answer', { answers: answers() });
    });
    return box;
  }

  permissionResult(ev) {
    const p = ev.permission;
    const text =
      p.kind === 'question'
        ? p.chosen === '__dismiss'
          ? '已略過'
          : `已回答${answerSummary(ev)}`
        : p.chosen === 'rejected'
          ? `已拒絕${p.feedback ? `：${p.feedback}` : ''}`
          : p.chosen === 'approved_session'
            ? '已允許（這個對話都允許）'
            : p.chosen === 'cancelled'
              ? '已取消'
              : p.kind === 'plan'
                ? `已選擇：${p.options.find((o) => o.optionId === p.chosen)?.name || '同意'}`
                : '已允許';
    return h('div', { class: 'ask-done' }, text);
  }

  // ---------------------------------------------------------- working

  renderWorking() {
    const s = this.status;
    if (s !== 'running' && s !== 'awaiting_permission') {
      this.working.hidden = true;
      return;
    }
    this.working.hidden = false;
    const secs = this.since ? fmtDuration(Date.now() - this.since) : '';
    fill(
      this.working,
      s === 'running'
        ? h('div', { class: 'working-line' }, h('span', { class: 'pulse' }), h('span', null, 'Kimi 正在處理'), secs ? h('span', { class: 'muted' }, ` · ${secs}`) : null, h('span', { class: 'muted hint' }, ' · Esc 停止'))
        : h('div', { class: 'working-line' }, h('span', { class: 'om-badge om-badge--warning' }, '等你回應'), h('span', { class: 'muted' }, '在上面的卡片選擇怎麼做')),
    );
  }
}

function answerSummary(ev) {
  const a = ev.answers;
  const q = ev.permission.questions || [];
  if (!a) return '';
  const parts = [];
  for (const item of q) {
    const x = a[item.id];
    if (!x || x.kind === 'skipped') continue;
    const label = (id) => item.options?.find((o) => o.id === id)?.label || id;
    if (x.kind === 'single') parts.push(label(x.option_id));
    else if (x.kind === 'multi') parts.push(x.option_ids.map(label).join('、'));
    else if (x.kind === 'other') parts.push(x.text);
    else if (x.kind === 'multi_with_other') parts.push([...x.option_ids.map(label), x.other_text].join('、'));
  }
  return parts.length ? `：${parts.join('；')}` : '';
}

export function todoList(todos) {
  return h(
    'ul',
    { class: 'todos' },
    todos.map((t) => {
      const st = t.status === 'completed' ? 'done' : t.status;
      return h(
        'li',
        { class: `todo ${st}` },
        h('span', { class: 'todo-box', 'aria-hidden': 'true' }, st === 'done' ? icon('check') : null),
        h('span', { class: 'todo-text' }, t.title || t.content || ''),
        st === 'in_progress' ? h('span', { class: 'om-badge' }, '進行中') : null,
      );
    }),
  );
}

