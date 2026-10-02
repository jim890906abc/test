// The message box: auto-growing input, / commands, images, and the
// model / thinking / permission controls. Used on the home screen (new
// conversation) and under every conversation.
import { h, fill, icon, fmtTokens } from './dom.js';
import { openMenu, closeMenu, place } from './menu.js';
import { todoList } from './transcript.js';

export const PERMISSION_LABELS = { manual: '每次詢問', yolo: '需要時詢問', auto: '全部自動' };
const PERMISSION_DESC = {
  manual: '每個指令與檔案修改都先問你',
  yolo: '一般修改與指令直接做，有風險的才問',
  auto: '全部自動決定，不會打斷你',
};
export const EFFORT_LABELS = { off: '關閉', on: '開啟', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const MAX_IMAGES = 8;

// Built-in commands; Kimi skills are appended from the session.
export const COMMANDS = [
  { name: 'model', description: '切換模型' },
  { name: 'effort', description: '調整思考強度' },
  { name: 'plan', description: '開關計畫模式：先規劃，你同意後才動手' },
  { name: 'permission', description: '選擇權限模式' },
  { name: 'yolo', description: '需要時詢問：只有風險高的動作才問你' },
  { name: 'auto', description: '全部自動：不再詢問' },
  { name: 'manual', description: '每次詢問' },
  { name: 'compact', description: '壓縮對話內容，騰出 context 空間', args: true, hint: '[補充指示]' },
  { name: 'undo', description: '撤回上一輪對話' },
  { name: 'btw', description: '順便問一個問題，不影響主對話', args: true, hint: '<問題>' },
  { name: 'goal', description: '設定讓 Kimi 自主完成的目標', args: true, hint: '<目標> | pause | resume | cancel' },
  { name: 'init', description: '分析專案並寫出 AGENTS.md' },
  { name: 'fork', description: '複製這個對話成新的對話' },
  { name: 'title', description: '修改對話標題', args: true, hint: '<標題>' },
  { name: 'new', description: '在同一個資料夾開新對話', aliases: ['clear'] },
  { name: 'copy', description: '複製 Kimi 最後一則回覆' },
];
const HOME_COMMANDS = ['model', 'effort', 'plan', 'permission', 'yolo', 'auto', 'manual'];
// A Kimi running in a terminal runs its own slash commands; these are the
// ones that work without its on-screen pickers.
const TERMINAL_COMMANDS = [
  { name: 'compact', description: '壓縮對話內容，騰出 context 空間', args: true, hint: '[補充指示]' },
  { name: 'undo', description: '撤回上一輪對話' },
  { name: 'btw', description: '順便問一個問題，不影響主對話', args: true, hint: '<問題>' },
  { name: 'goal', description: '設定讓 Kimi 自主完成的目標', args: true, hint: '<目標> | pause | resume | cancel' },
  { name: 'plan', description: '計畫模式', args: true, hint: 'on | off' },
  { name: 'effort', description: '調整思考強度', args: true, hint: '<off | low | medium | high | max>' },
  { name: 'model', description: '切換模型', args: true, hint: '<模型>' },
  { name: 'yolo', description: '需要時詢問：只有風險高的動作才問你' },
  { name: 'auto', description: '全部自動：不再詢問' },
  { name: 'init', description: '分析專案並寫出 AGENTS.md' },
  { name: 'fork', description: '複製這個對話成新的對話' },
  { name: 'title', description: '修改對話標題', args: true, hint: '<標題>' },
  { name: 'copy', description: '複製 Kimi 最後一則回覆' },
];

export class Composer {
  // opts: { home, placeholder, onSend({ text, images }), onCommand(name, args),
  //         onStop(), onConfig(change), onCancelQueued(promptId), onPickMachine(btn), onPickFolder(btn), onPaste? }
  constructor(opts) {
    this.opts = opts;
    this.state = {};
    this.images = [];
    this.drafts = new Map();
    this.key = null;
    this.input = h('textarea', { class: 'composer-input', rows: 1, placeholder: opts.placeholder || '回覆 Kimi…', 'aria-label': '訊息' });
    this.thumbs = h('div', { class: 'composer-images', hidden: true });
    this.left = h('div', { class: 'composer-tools' });
    this.right = h('div', { class: 'composer-actions' });
    this.file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => (this.addFiles(this.file.files), (this.file.value = '')) });
    this.box = h('div', { class: 'composer-box' }, this.thumbs, this.input, h('div', { class: 'composer-bar' }, this.left, this.right), this.file);
    this.tray = h('div', { class: 'composer-tray' });
    this.slash = null;
    this.el = h('div', { class: `composer${opts.home ? ' home' : ''}` }, this.tray, this.box);
    this.bind();
  }

  bind() {
    const input = this.input;
    input.addEventListener('input', () => {
      this.grow();
      this.updateSlash();
      this.renderActions();
    });
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
    this.box.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
        e.preventDefault();
        this.box.classList.add('drop');
      }
    });
    this.box.addEventListener('dragleave', () => this.box.classList.remove('drop'));
    this.box.addEventListener('drop', (e) => {
      this.box.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
    this.box.addEventListener('click', (e) => {
      if (e.target === this.box) input.focus();
    });
  }

  // Remember unsent text per conversation.
  setKey(key) {
    if (this.key) this.drafts.set(this.key, this.input.value);
    this.key = key;
    this.input.value = this.drafts.get(key) || '';
    this.images = [];
    this.renderImages();
    this.grow();
    this.renderActions();
  }

  focus() {
    if (window.matchMedia('(hover: hover)').matches) this.input.focus({ preventScroll: true });
  }

  setText(text) {
    this.input.value = text;
    this.grow();
    this.renderActions();
    this.input.focus();
    this.input.setSelectionRange(text.length, text.length);
  }

  grow() {
    const el = this.input;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  // state: { running, awaiting, queue, todos, models, model, defaultModel,
  //          effort, permission, planMode, context, skills, machineName, folderName }
  update(state) {
    this.state = { ...this.state, ...state };
    const readOnly = this.state.terminal && !this.state.controllable;
    this.box.hidden = readOnly;
    if (readOnly) {
      this.note ??= h('div', { class: 'composer-note' });
      // A terminal Kimi in the same folder might have it open: two Kimis on
      // one conversation would overwrite each other, so only on request.
      const unlock = () => {
        if (confirm('確定終端機的 Kimi 沒有開著這個對話嗎？\n\n如果它開著，兩邊會各自寫入同一個對話、互相覆蓋。')) this.opts.onUnlock?.();
      };
      fill(
        this.note,
        icon('terminal'),
        this.state.guess
          ? h('div', { class: 'composer-note-text' }, h('div', { class: 'composer-note-title' }, '這個資料夾有終端機的 Kimi 開著'), h('div', null, '看不出它開的是不是這個對話，為了避免兩邊互相覆蓋，這裡先只能看。關掉那個 Kimi 就會解除。'))
          : h('div', { class: 'composer-note-text' }, h('div', { class: 'composer-note-title' }, '這個對話正在終端機的 Kimi 裡執行'), h('div', null, '這裡會即時同步。要從這裡操作，在那個 Kimi 裡輸入 /web，或之後用 kimi-hub 啟動 Kimi。')),
        this.state.guess && this.opts.onUnlock
          ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: unlock }, '仍要從這裡操作')
          : this.opts.onHelp
            ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => this.opts.onHelp() }, '說明…')
            : null,
      );
      if (!this.note.isConnected) this.el.append(this.note);
    } else this.note?.remove();
    this.renderTools();
    this.renderActions();
    this.renderTray();
  }

  // ------------------------------------------------------------- tools

  currentModel() {
    const s = this.state;
    const id = s.model || s.defaultModel;
    return (s.models || []).find((m) => m.id === id) || null;
  }

  renderTools() {
    const s = this.state;
    const chip = (label, onclick, { iconName, title, active, control } = {}) =>
      h('button', { class: `chip${active ? ' active' : ''}`, type: 'button', title: title || '', 'aria-haspopup': 'menu', dataset: { control }, onclick: (e) => onclick(e.currentTarget) }, iconName ? icon(iconName) : null, h('span', null, label), icon('down', 'caret'));
    const model = this.currentModel();
    const efforts = model?.efforts || [];
    fill(
      this.left,
      s.terminal ? null : h('button', { class: 'chip icon-only', type: 'button', title: '加入圖片', 'aria-label': '加入圖片', onclick: () => this.file.click() }, icon('attach')),
      s.terminal ? h('span', { class: 'chip static', title: '這個對話在終端機的 Kimi 裡執行，你的訊息會打進那個終端機' }, icon('terminal'), h('span', null, '終端機')) : null,
      this.opts.home ? chip(s.machineName || '選擇電腦', (b) => this.opts.onPickMachine(b), { iconName: 'computer', title: '要在哪一台電腦上執行', control: 'machine' }) : null,
      this.opts.home ? chip(s.folderName || '選擇資料夾', (b) => this.opts.onPickFolder(b), { iconName: 'folder', title: '工作資料夾', control: 'folder' }) : null,
      chip(s.planMode ? '計畫模式' : PERMISSION_LABELS[s.permission] || PERMISSION_LABELS.manual, (b) => this.permissionMenu(b), { iconName: s.planMode ? 'map' : 'shield', title: '權限模式', active: s.planMode, control: 'permission' }),
      s.models?.length ? chip(model?.name || 'Kimi 預設模型', (b) => this.modelMenu(b), { title: '模型', control: 'model' }) : null,
      efforts.length > 1 ? chip(`思考 ${EFFORT_LABELS[s.effort] || s.effort || EFFORT_LABELS[model.defaultEffort] || '預設'}`, (b) => this.effortMenu(b), { title: '思考強度', control: 'effort' }) : null,
    );
  }

  // Open the menu behind a control (for /model, /effort, /permission).
  openControl(name) {
    const btn = this.left.querySelector(`[data-control="${name}"]`);
    if (btn) btn.click();
    return Boolean(btn);
  }

  permissionMenu(anchor) {
    const s = this.state;
    openMenu(
      anchor,
      [
        ...['manual', 'yolo', 'auto'].map((p) => ({ label: PERMISSION_LABELS[p], description: PERMISSION_DESC[p], checked: (s.permission || 'manual') === p, onSelect: () => this.opts.onConfig({ permission: p }) })),
        { separator: true },
        { label: '計畫模式', description: '先寫好計畫，你同意後才開始修改', checked: Boolean(s.planMode), onSelect: () => this.opts.onConfig({ planMode: !s.planMode }) },
      ],
      { side: 'auto', width: 280 },
    );
  }

  modelMenu(anchor) {
    const s = this.state;
    const cur = s.model || s.defaultModel;
    openMenu(
      anchor,
      (s.models || []).map((m) => ({ label: m.name, description: m.id !== m.name ? m.id : null, checked: m.id === cur, onSelect: () => this.opts.onConfig({ model: m.id }) })),
      { width: 260 },
    );
  }

  effortMenu(anchor) {
    const s = this.state;
    const model = this.currentModel();
    if (!model?.efforts?.length) return;
    const cur = s.effort || model.defaultEffort;
    openMenu(
      anchor,
      [{ section: '思考強度' }, ...model.efforts.map((e) => ({ label: EFFORT_LABELS[e] || e, hint: e === model.defaultEffort ? '預設' : '', checked: e === cur, onSelect: () => this.opts.onConfig({ effort: e }) }))],
      { width: 200 },
    );
  }

  // ----------------------------------------------------------- actions

  hasContent() {
    return Boolean(this.input.value.trim() || this.images.length);
  }

  renderActions() {
    const s = this.state;
    const busy = s.running || s.awaiting;
    const ctx = s.context;
    const ring = ctx?.size ? contextRing(ctx, () => this.opts.onCommand('compact', '')) : null;
    const stop = busy && !this.hasContent();
    fill(
      this.right,
      ring,
      // While Kimi works: Enter queues the message for after this turn;
      // 插隊 (Ctrl+S, like Kimi's CLI) slips it into the running turn.
      busy && this.hasContent() ? h('button', { class: 'om-btn om-btn--sm steer-btn', type: 'button', title: '插隊：讓 Kimi 在下一步就讀到，不會中斷它（Ctrl+S）', onclick: () => this.submit({ steer: true }) }, '插隊') : null,
      stop
        ? h('button', { class: 'send stop', type: 'button', title: '停止（Esc）', 'aria-label': '停止', onclick: () => this.opts.onStop() }, icon('stop'))
        : h('button', { class: 'send', type: 'button', title: busy ? '排隊：這一輪結束後送出（Enter）' : '送出（Enter）', 'aria-label': busy ? '排隊送出' : '送出', disabled: !this.hasContent(), onclick: () => this.submit() }, icon('up')),
    );
  }

  renderTray() {
    const s = this.state;
    const queue = s.queue || [];
    const todos = s.todos || [];
    const open = todos.filter((t) => t.status !== 'done' && t.status !== 'completed');
    const items = [];
    for (const q of queue) {
      items.push(
        h(
          'div',
          { class: 'queued' },
          h('span', { class: 'queued-label' }, q.steered ? '下一步插入' : '排隊中'),
          h('span', { class: 'queued-text' }, q.text || (q.images?.length ? `${q.images.length} 張圖片` : '')),
          !q.steered && !q.foreign ? h('button', { class: 'om-btn om-btn--sm', type: 'button', title: '讓 Kimi 在下一步就讀到這則訊息，不會中斷它', onclick: () => this.opts.onSteerQueued(q.promptId) }, '插隊') : null,
          q.foreign ? null : h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '取消這則訊息', 'aria-label': '取消這則訊息', onclick: () => this.opts.onCancelQueued(q.promptId) }, icon('x')),
        ),
      );
    }
    if (todos.length && open.length && (s.running || s.awaiting)) {
      const done = todos.length - open.length;
      const now = todos.find((t) => t.status === 'in_progress') || open[0];
      const btn = h(
        'button',
        { class: 'todo-chip', type: 'button', 'aria-expanded': String(Boolean(this.todosOpen)), onclick: () => ((this.todosOpen = !this.todosOpen), this.renderTray()) },
        icon('todo'),
        h('span', { class: 'todo-progress' }, `${done}/${todos.length}`),
        h('span', { class: 'todo-now' }, now?.title || ''),
        icon(this.todosOpen ? 'down' : 'chev', 'caret'),
      );
      items.push(h('div', { class: 'todo-tray' }, btn, this.todosOpen ? todoList(todos) : null));
    }
    fill(this.tray, ...items);
    this.tray.hidden = !items.length;
  }

  // -------------------------------------------------------------- keys

  onKey(e) {
    if (this.slash) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSlash(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
        const item = this.slash.items[this.slash.index];
        if (item) {
          e.preventDefault();
          this.pickSlash(item, e.key === 'Tab');
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSlash();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      this.submit();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && (this.state.running || this.state.awaiting)) {
      e.preventDefault();
      this.submit({ steer: true });
    } else if (e.key === 'Escape' && (this.state.running || this.state.awaiting)) {
      e.preventDefault();
      this.opts.onStop();
    }
  }

  submit({ steer = false } = {}) {
    const raw = this.input.value;
    const text = raw.trim();
    if (!text && !this.images.length) return;
    const m = text.match(/^\/([\w.:-]+)(?:\s+([\s\S]*))?$/);
    if (m && !this.images.length && this.commands().some((c) => c.name === m[1] || c.aliases?.includes(m[1]))) {
      const cmd = this.commands().find((c) => c.name === m[1] || c.aliases?.includes(m[1]));
      this.clear();
      this.opts.onCommand(cmd.name, (m[2] || '').trim());
      return;
    }
    const images = this.images.map(({ mimeType, data, thumb }) => ({ mimeType, data, thumb }));
    this.clear();
    this.opts.onSend({ text, images, steer });
  }

  clear() {
    this.input.value = '';
    this.images = [];
    if (this.key) this.drafts.delete(this.key);
    this.renderImages();
    this.grow();
    this.closeSlash();
    this.renderActions();
  }

  // ------------------------------------------------------------- slash

  commands() {
    const skills = (this.state.skills || []).map((s) => ({ name: s.name, description: s.description, skill: true, args: true, source: s.source }));
    const base = this.opts.home ? COMMANDS.filter((c) => HOME_COMMANDS.includes(c.name)) : this.state.terminal ? TERMINAL_COMMANDS : COMMANDS;
    const names = new Set(base.map((c) => c.name));
    return [...base, ...skills.filter((s) => !names.has(s.name))];
  }

  updateSlash() {
    const m = this.input.value.match(/^\/([\w.:-]*)$/);
    if (!m) return this.closeSlash();
    const q = m[1].toLowerCase();
    const all = this.commands();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
    const rest = q ? all.filter((c) => !starts.includes(c) && (c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))) : [];
    const items = [...starts, ...rest].slice(0, 50);
    if (!items.length) return this.closeSlash();
    const index = Math.min(this.slash?.index || 0, items.length - 1);
    this.renderSlash(items, index);
  }

  renderSlash(items, index) {
    closeMenu();
    if (!this.slash) {
      const el = h('div', { class: 'om-menu popover slash-menu', role: 'listbox', 'aria-label': '指令' });
      document.body.append(el);
      const away = (e) => {
        if (!el.contains(e.target) && e.target !== this.input) this.closeSlash();
      };
      document.addEventListener('pointerdown', away, true);
      this.slash = { el, away };
    }
    this.slash.items = items;
    this.slash.index = index;
    const el = this.slash.el;
    fill(
      el,
      ...items.map((c, i) =>
        h(
          'div',
          {
            class: 'om-menu__item slash-item',
            role: 'option',
            'aria-selected': String(i === index),
            onpointerdown: (e) => e.preventDefault(),
            onclick: () => this.pickSlash(c),
            onmousemove: () => {
              if (this.slash.index !== i) this.renderSlash(items, i);
            },
          },
          h('span', { class: 'slash-name' }, `/${c.name}`, c.hint ? h('span', { class: 'slash-hint' }, ` ${c.hint}`) : null),
          h('span', { class: 'slash-desc' }, c.description || ''),
          c.skill ? h('span', { class: 'om-menu__shortcut' }, { builtin: '內建', user: '你的', project: '專案', extra: '外掛' }[c.source] || '技能') : null,
        ),
      ),
    );
    el.style.width = `${Math.min(520, this.box.offsetWidth)}px`;
    place(el, this.box, { side: 'auto' });
    el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  moveSlash(d) {
    const { items, index } = this.slash;
    this.renderSlash(items, (index + d + items.length) % items.length);
  }

  pickSlash(cmd, completeOnly = false) {
    if (cmd.args || completeOnly) {
      this.setText(`/${cmd.name} `);
      this.closeSlash();
      return;
    }
    this.clear();
    this.opts.onCommand(cmd.name, '');
  }

  closeSlash() {
    if (!this.slash) return;
    document.removeEventListener('pointerdown', this.slash.away, true);
    this.slash.el.remove();
    this.slash = null;
  }

  // ------------------------------------------------------------ images

  async addFiles(files) {
    for (const f of [...files].slice(0, MAX_IMAGES - this.images.length)) {
      try {
        this.images.push(await readImage(f));
      } catch {
        this.opts.onError?.(`沒辦法讀取「${f.name}」。請改用 PNG 或 JPEG。`);
      }
    }
    this.renderImages();
    this.renderActions();
    this.input.focus();
  }

  renderImages() {
    fill(
      this.thumbs,
      ...this.images.map((img, i) =>
        h(
          'div',
          { class: 'thumb' },
          h('img', { src: img.thumb, alt: img.name || '圖片' }),
          h('button', { class: 'thumb-x', type: 'button', title: '移除', 'aria-label': '移除圖片', onclick: () => (this.images.splice(i, 1), this.renderImages(), this.renderActions()) }, icon('x')),
        ),
      ),
    );
    this.thumbs.hidden = !this.images.length;
    const model = this.currentModel();
    if (this.images.length && model && !model.image) this.opts.onError?.(`${model.name} 可能看不懂圖片`);
  }
}

// Downscale to at most 2000px (and a small thumbnail for the transcript).
async function readImage(file) {
  const bmp = await createImageBitmap(file);
  const draw = (max, type, q) => {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = h('canvas', { width: Math.max(1, Math.round(bmp.width * scale)), height: Math.max(1, Math.round(bmp.height * scale)) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL(type, q);
  };
  let dataUrl;
  if (Math.max(bmp.width, bmp.height) <= 2000 && file.size <= 3_500_000 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  } else dataUrl = draw(2000, 'image/jpeg', 0.9);
  const thumb = draw(480, 'image/jpeg', 0.82);
  const [, mimeType, data] = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  return { mimeType, data, thumb, name: file.name };
}

function contextRing(ctx, onCompact) {
  const pct = Math.min(1, ctx.used / ctx.size);
  const r = 7;
  const c = 2 * Math.PI * r;
  const level = pct > 0.9 ? 'danger' : pct > 0.75 ? 'warning' : '';
  const title = `已使用 ${fmtTokens(ctx.used)} / ${fmtTokens(ctx.size)} tokens（${Math.round(pct * 100)}%）`;
  const btn = h('button', {
    class: `ctx-ring ${level}`,
    'data-pct': `${Math.round(pct * 100)}%`,
    type: 'button',
    title: `${title}\n點一下可以壓縮對話`,
    'aria-label': title,
    onclick: (e) =>
      openMenu(e.currentTarget, [{ section: title }, { label: '壓縮對話', hint: '/compact', onSelect: onCompact }], { align: 'end', width: 260 }),
    html: `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}" class="track"/><circle cx="9" cy="9" r="${r}" class="bar" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}"/></svg><span class="ctx-label">${Math.round(pct * 100)}% · ${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)}</span>`,
  });
  return btn;
}
