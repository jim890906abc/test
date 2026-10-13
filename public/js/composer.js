// The message box: auto-growing input, / commands, images, and the
// model / thinking / permission controls. Used on the home screen (new
// conversation) and under every conversation, for Kimi and for Claude
// (state.agent === 'claude': Claude through the Claude API, run by the hub).
import { h, fill, icon, fmtTokens, clockTime, fmtCountdown } from './dom.js';
import { openMenu, closeMenu, place } from './menu.js';
import { todoList } from './transcript.js';

export const PERMISSION_LABELS = { manual: '每次詢問', yolo: '需要時詢問', auto: '全部自動' };
const PERMISSION_DESC = {
  manual: '每個指令與檔案修改都先問你',
  yolo: '一般修改與指令直接做，有風險的才問',
  auto: '全部自動決定，不會打斷你',
};
// Thinking levels by their official names (Kimi's and Claude's alike).
export const EFFORT_LABELS = { off: 'off', on: 'on', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
// Claude's permission modes, as Claude Code names them.
export const CLAUDE_PERMISSION_LABELS = { manual: '每次詢問', edits: '自動接受編輯', auto: '全部自動' };
const CLAUDE_PERMISSION_DESC = {
  manual: '每個檔案修改與指令都先問你',
  edits: '修改檔案直接做，執行指令前先問你',
  auto: '全部直接做，不會打斷你',
};
export const permissionLabels = (agent) => (agent === 'claude' ? CLAUDE_PERMISSION_LABELS : PERMISSION_LABELS);
export const agentName = (agent) => (agent === 'claude' ? 'Claude' : 'Kimi');
// US$, with more digits while it is small.
export const fmtUsd = (n) => `US$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : (n || 0).toFixed(4)}`;
const MAX_IMAGES = 8;
// Text files (Markdown, HTML, code, logs…): read here and sent with the
// message as text, so Claude and Kimi both get them.
const MAX_DOCS = 15;
const MAX_DOC_BYTES = 1_000_000;
const DOC_EXT = /\.(md|markdown|mdx|txt|text|html?|xhtml|css|js|mjs|cjs|jsx|ts|tsx|json|jsonl|ya?ml|toml|ini|cfg|conf|env\.example|csv|tsv|log|xml|svg|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|r|lua|swift|vue|svelte|tex|rst|org|diff|patch)$/i;
const MAX_ZIP_BYTES = 20_000_000;
const isZip = (f) => /\.zip$/i.test(f.name || '') || /zip/.test(f.type || '');
const isDoc = (f) => isZip(f) || DOC_EXT.test(f.name || '') || /^text\//.test(f.type || '') || /json|xml|javascript/.test(f.type || '');
const isImage = (f) => /^image\//.test(f.type || '') && !/svg/.test(f.type || '');
const DOC_ACCEPT = '.zip,.md,.markdown,.mdx,.txt,.html,.htm,.css,.js,.mjs,.jsx,.ts,.tsx,.json,.jsonl,.yaml,.yml,.toml,.ini,.cfg,.conf,.csv,.tsv,.log,.xml,.svg,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.hpp,.cs,.php,.sh,.ps1,.sql,.lua,.swift,.vue,.svelte,.tex,.rst,.diff,.patch';

// Built-in commands; Kimi skills are appended from the session.
const BG_DESCRIPTION = '移到背景（Ctrl+B）：Kimi 正在等的子代理或指令改到背景繼續跑，Kimi 不用再等它';

export const COMMANDS = [
  { name: 'model', description: '切換模型' },
  { name: 'effort', description: '調整思考強度' },
  { name: 'plan', description: '開關計畫模式：先規劃，你同意後才動手' },
  { name: 'permission', description: '選擇權限模式' },
  { name: 'yolo', description: '需要時詢問：只有風險高的動作才問你' },
  { name: 'auto', description: '全部自動：不再詢問' },
  { name: 'manual', description: '每次詢問' },
  { name: 'compact', description: '壓縮對話內容，騰出 context 空間', args: true, hint: '[補充指示]' },
  { name: 'bg', description: BG_DESCRIPTION, aliases: ['background'] },
  { name: 'undo', description: '撤回上一輪對話' },
  { name: 'btw', description: '順便問一個問題，不影響主對話', args: true, hint: '<問題>' },
  { name: 'goal', description: '設定讓 Kimi 自主完成的目標', args: true, hint: '<目標> | pause | resume | cancel' },
  { name: 'init', description: '分析專案並寫出 AGENTS.md' },
  { name: 'fork', description: '複製這個對話成新的對話' },
  { name: 'title', description: '修改對話標題', args: true, hint: '<標題>' },
  { name: 'new', description: '在同一個資料夾開新對話', aliases: ['clear'] },
  { name: 'copy', description: '複製 Kimi 最後一則回覆' },
  { name: 'usage', description: '方案用量：5 小時、7 天與本月額度' },
  { name: 'status', description: '目前的模型、權限、context、帳號與電腦' },
  { name: 'autopause', description: '自動暫停：5 小時額度用到設定的 % 送出「優雅暫停」，恢復後送出「繼續」', args: true, hint: '[% | off]' },
  { name: 'later', description: '定時送出：幾分鐘後、指定時間，或 5 小時額度恢復後送出訊息', args: true, hint: '[30 | 15:30 | reset] [訊息]' },
  { name: 'backup', description: '把這個專案的資料夾備份到你的 Google Drive（中控台自己做，不花 token）' },
  { name: 'steer', description: '全部插隊：排隊中、等待插隊的訊息一次全部送進正在跑的這一輪，下一步一起讀到', aliases: ['steerall', 'flush'] },
];
const HOME_COMMANDS = ['model', 'effort', 'plan', 'permission', 'yolo', 'auto', 'manual', 'usage', 'status'];
// Claude through the Claude API: the hub runs it, so these are the hub's.
export const CLAUDE_COMMANDS = [
  { name: 'model', description: '切換模型' },
  { name: 'effort', description: '調整思考強度' },
  { name: 'plan', description: '開關計畫模式：先規劃，你同意後才動手' },
  { name: 'permission', description: '選擇權限模式' },
  { name: 'manual', description: '每次詢問：修改檔案與執行指令前都先問你' },
  { name: 'edits', description: '自動接受編輯：修改檔案直接做，執行指令前先問你', aliases: ['accept-edits'] },
  { name: 'auto', description: '全部自動：不再詢問' },
  { name: 'compact', description: '壓縮對話：讓 Claude 寫摘要取代前面的內容，省下之後每一輪的 token', args: true, hint: '[補充指示]' },
  { name: 'undo', description: '撤回上一輪對話（檔案的修改不會還原）', aliases: ['rewind'] },
  { name: 'init', description: '分析專案並寫出 CLAUDE.md' },
  { name: 'fork', description: '複製這個對話成新的對話', args: true, hint: '[標題]' },
  { name: 'title', description: '修改對話標題', args: true, hint: '<標題>' },
  { name: 'new', description: '在同一個資料夾開新對話', aliases: ['clear'] },
  { name: 'copy', description: '複製 Claude 最後一則回覆' },
  { name: 'cost', description: '這個對話花了多少（依 API 用量估計）與速率限制', aliases: ['usage'] },
  { name: 'budget', description: '花費上限：這個對話花到這個金額就先停下', args: true, hint: '<美元> | off' },
  { name: 'status', description: '目前的模型、權限、context、API key 與資料夾' },
  { name: 'later', description: '定時送出：幾分鐘後或指定時間送出訊息', args: true, hint: '[30 | 15:30] [訊息]' },
  { name: 'backup', description: '把這個專案的資料夾備份到你的 Google Drive（中控台自己做，不花 token）' },
  { name: 'steer', description: '全部插隊：排隊中、等待插隊的訊息一次全部送進正在跑的這一輪，下一步一起讀到', aliases: ['steerall', 'flush'] },
];
const CLAUDE_HOME_COMMANDS = ['model', 'effort', 'plan', 'permission', 'manual', 'edits', 'auto', 'status'];
// A Kimi running in a terminal runs its own slash commands; these are the
// ones that work without its on-screen pickers.
const TERMINAL_COMMANDS = [
  { name: 'bg', description: BG_DESCRIPTION, aliases: ['background'] },
  { name: 'usage', description: '方案用量：5 小時、7 天與本月額度' },
  { name: 'status', description: '目前的模型、權限、context、帳號與電腦' },
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
  { name: 'autopause', description: '自動暫停：5 小時額度用到設定的 % 送出「優雅暫停」，恢復後送出「繼續」', args: true, hint: '[% | off]' },
  { name: 'later', description: '定時送出：幾分鐘後、指定時間，或 5 小時額度恢復後送出訊息', args: true, hint: '[30 | 15:30 | reset] [訊息]' },
  { name: 'backup', description: '把這個專案的資料夾備份到你的 Google Drive（中控台自己做，不花 token）' },
  { name: 'steer', description: '全部插隊：排隊中、等待插隊的訊息一次全部送進正在跑的這一輪，下一步一起讀到', aliases: ['steerall', 'flush'] },
];

// "15:42（2 小時 13 分後）", or just the time once it has passed.
export function whenText(ts) {
  const left = fmtCountdown(ts - Date.now());
  return left ? `${clockTime(ts)}（${left}後）` : clockTime(ts);
}

// What auto-pause is doing for a conversation: a short label (badge) and a
// sentence (tray, dialog). Null when it is off.
// Also covers 「額度恢復後送出」 set by hand (auto-pause itself may be off).
// `queue`: the conversation's waiting messages, to tell whether 「優雅暫停」
// is still waiting to cut in.
export function autoPauseStatus(ap, queue = []) {
  if (!ap?.enabled && ap?.phase !== 'paused') return null;
  const w = ap.wait || {};
  const at = whenText;
  const text = ap.resumeText || '繼續';
  const resume = (until) => (until ? `${at(until)}額度恢復後送出「${text}」` : `額度恢復後送出「${text}」`);
  if (ap.phase === 'paused') {
    const manual = ap.reason === 'manual';
    let detail;
    if (ap.error) detail = `${ap.error}（會再試）`;
    else if (w.kind === 'offline') detail = '電腦離線，連上後繼續';
    else if (w.kind === 'stopping' && !manual && (queue || []).some((q) => q.promptId === ap.pausePrompt && !q.steered)) detail = `「優雅暫停」等待插隊（${CUT_IN_WHY}），之後${resume(ap.resetAt)}`;
    else if (w.kind === 'stopping') detail = `等 Kimi ${manual ? '' : '收尾'}停下，之後${resume(ap.resetAt)}`;
    else if (w.kind === 'usage') detail = `5 小時額度還沒恢復（已用 ${Math.round(w.used * 100)}%）${w.until ? `，${at(w.until)}重置後再看` : '，稍後再看'}`;
    else if (w.kind === 'confirm') detail = `重置時間到了，確認 5 小時額度恢復後送出「${text}」`;
    else if (w.kind === 'week') detail = `7 天額度已用完，${w.until ? at(w.until) : ''}重置後才送出「${text}」`;
    else detail = resume(ap.resetAt);
    return { label: manual ? '等額度恢復' : '已自動暫停', detail, tone: ap.error ? 'danger' : 'warning', paused: true, text };
  }
  const label = `自動暫停 ${ap.threshold}%`;
  if (ap.error) return { label, detail: ap.error, tone: 'danger' };
  if (w.kind === 'offline') return { label, detail: '電腦離線，連上後繼續監看', tone: '' };
  if (w.kind === 'quiet') return { label, detail: `這個 5 小時視窗已經暫停過，${at(w.until)}重置後重新監看`, tone: '' };
  return { label, detail: `5 小時額度用到 ${ap.threshold}% 時送出「優雅暫停」`, tone: '' };
}

const CUT_IN_WHY = 'Kimi 正在跑它自己開的這一輪，例如處理背景子代理的結果，這種回合 Kimi 不收插隊；每 2 秒再試一次，最晚這一輪結束時第一個讀到';

export class Composer {
  // opts: { home, placeholder, onSend({ text, images }), onCommand(name, args),
  //         onStop(), onConfig(change), onCancelQueued(promptId), onPickMachine(btn), onPickFolder(btn), onPaste? }
  constructor(opts) {
    this.opts = opts;
    this.state = {};
    this.images = [];
    this.docs = [];
    this.drafts = new Map();
    this.key = null;
    this.input = h('textarea', { class: 'composer-input', rows: 1, placeholder: opts.placeholder || `回覆 ${agentName(opts.agent)}…`, 'aria-label': '訊息' });
    this.thumbs = h('div', { class: 'composer-images', hidden: true });
    this.left = h('div', { class: 'composer-tools' });
    this.right = h('div', { class: 'composer-actions' });
    this.file = h('input', { type: 'file', accept: `image/*,${DOC_ACCEPT}`, multiple: true, hidden: true, onchange: () => (this.addFiles(this.file.files), (this.file.value = '')) });
    this.box = h('div', { class: 'composer-box' }, this.thumbs, this.input, h('div', { class: 'composer-bar' }, this.left, this.right), this.file);
    this.tray = h('div', { class: 'composer-tray' });
    this.slash = null;
    this.el = h('div', { class: `composer${opts.home ? ' home' : ''}` }, this.tray, this.box);
    this.bind();
    // Countdowns in the tray ("12 分後") keep up with the clock.
    setInterval(() => {
      if (this.el.isConnected && (this.state.scheduled?.length || this.state.autoPause?.phase === 'paused')) this.renderTray();
    }, 20_000);
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
      const files = [...(e.clipboardData?.files || [])].filter((f) => isImage(f) || isDoc(f));
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
      const files = [...(e.dataTransfer?.files || [])].filter((f) => isImage(f) || isDoc(f));
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
    this.docs = [];
    this.uploadDir = null; // each conversation starts with its own folder
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
    if (!this.opts.placeholder) this.input.placeholder = `回覆 ${agentName(this.agent())}…`;
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

  agent() {
    return this.state.agent || this.opts.agent || 'kimi';
  }

  claude() {
    return this.agent() === 'claude';
  }

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
    // Kimi fixes the model and thinking when a turn starts: changed during
    // it, they say so, until the next turn picks them up.
    const working = s.running || s.awaiting;
    const nameOf = (id) => (s.models || []).find((m) => m.id === id)?.name || id;
    const nextModel = working && s.turnModel && s.model && s.turnModel !== s.model;
    const nextEffort = working && s.turnEffort && s.effort && s.turnEffort !== s.effort;
    const effortName = (e) => EFFORT_LABELS[e] || e;
    fill(
      this.left,
      s.terminal ? null : h('button', { class: 'chip icon-only', type: 'button', title: '加入圖片', 'aria-label': '加入圖片', onclick: () => this.file.click() }, icon('attach')),
      s.terminal ? h('span', { class: 'chip static', title: '這個對話在終端機的 Kimi 裡執行，你的訊息會打進那個終端機' }, icon('terminal'), h('span', null, '終端機')) : null,
      this.opts.home && this.opts.onPickMachine ? chip(s.machineName || '選擇電腦', (b) => this.opts.onPickMachine(b), { iconName: 'computer', title: '要在哪一台電腦上執行', control: 'machine' }) : null,
      // Claude runs on the hub's own computer.
      this.opts.home && !this.opts.onPickMachine && s.machineName ? h('span', { class: 'chip static', title: 'Claude 由中控台執行，工具在這台電腦上跑' }, icon('computer'), h('span', null, s.machineName)) : null,
      this.opts.home ? chip(s.folderName || '選擇資料夾', (b) => this.opts.onPickFolder(b), { iconName: s.folderIcon || 'folder', title: s.folderIcon === 'branch' ? '綁定的 GitHub repo' : '工作資料夾', control: 'folder' }) : null,
      chip(s.planMode ? '計畫模式' : permissionLabels(this.agent())[s.permission] || PERMISSION_LABELS.manual, (b) => this.permissionMenu(b), { iconName: s.planMode ? 'map' : 'shield', title: '權限模式', active: s.planMode, control: 'permission' }),
      s.models?.length
        ? chip(`${model?.name || `${agentName(this.agent())} 預設模型`}${nextModel ? '（下一輪）' : ''}`, (b) => this.modelMenu(b), {
            title: nextModel ? `這一輪是用「${nameOf(s.turnModel)}」開始的。${agentName(this.agent())} 每一輪開始時就固定模型，「${nameOf(s.model)}」從下一輪起使用` : '模型',
            control: 'model',
          })
        : null,
      // Which model Anthropic says answered, as of the last response.
      this.claude() && s.servedModel ? servedChip(s) : null,
      efforts.length > 1
        ? chip(`思考 ${EFFORT_LABELS[s.effort] || s.effort || EFFORT_LABELS[model.defaultEffort] || '預設'}${nextEffort ? '（下一輪）' : ''}`, (b) => this.effortMenu(b), {
            title: nextEffort ? `這一輪是用「${effortName(s.turnEffort)}」開始的。${agentName(this.agent())} 每一輪開始時就固定思考強度，「${effortName(s.effort)}」從下一輪起使用` : '思考強度',
            control: 'effort',
          })
        : null,
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
    const labels = permissionLabels(this.agent());
    const desc = this.claude() ? CLAUDE_PERMISSION_DESC : PERMISSION_DESC;
    openMenu(
      anchor,
      [
        ...Object.keys(labels).map((p) => ({ label: labels[p], description: desc[p], checked: (s.permission || 'manual') === p, onSelect: () => this.opts.onConfig({ permission: p }) })),
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
      [
        ...(s.running || s.awaiting ? [{ section: '模型 · 從下一輪起使用' }] : []),
        ...(s.models || []).map((m) => ({ label: m.name, description: m.id !== m.name ? m.id : null, checked: m.id === cur, onSelect: () => this.opts.onConfig({ model: m.id }) })),
      ],
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
      [{ section: s.running || s.awaiting ? '思考強度 · 從下一輪起使用' : '思考強度' }, ...model.efforts.map((e) => ({ label: EFFORT_LABELS[e] || e, hint: e === model.defaultEffort ? '預設' : '', checked: e === cur, onSelect: () => this.opts.onConfig({ effort: e }) }))],
      { width: 200 },
    );
  }

  // ----------------------------------------------------------- actions

  hasContent() {
    return Boolean(this.input.value.trim() || this.images.length || this.docs.length);
  }

  renderActions() {
    const s = this.state;
    const busy = s.running || s.awaiting;
    const ctx = s.context;
    const claude = this.claude();
    const name = agentName(this.agent());
    // 自動暫停 watches Kimi's plan quota; Claude's API key has none.
    const ap = this.opts.onAutoPause && !claude ? { state: s.autoPause, open: this.opts.onAutoPause, arm: this.opts.onArmResume } : null;
    const ring = ctx?.size ? contextRing(ctx, () => this.opts.onCommand('compact', ''), this.opts.onQuotaNode, ap, claude ? '花費' : '方案用量') : null;
    const stop = busy && !this.hasContent();
    fill(
      this.right,
      // What this conversation has cost so far (Claude API, per token).
      claude && !this.opts.home && s.cost != null
        ? h('button', { class: `cost-chip${s.budget && s.cost >= s.budget ? ' over' : ''}`, type: 'button', title: `這個對話到目前約花了 ${fmtUsd(s.cost)}（依 Claude API 公開價格估計）${s.budget ? `，上限 ${fmtUsd(s.budget)}` : ''}。點一下看明細`, onclick: () => this.opts.onCommand('cost', '') }, fmtUsd(s.cost))
        : null,
      ring,
      // While the agent works: Enter slips the message into the running turn
      // (插隊, read at its next step with any others waiting); 排隊 keeps it
      // for after the turn.
      busy && this.hasContent() ? h('button', { class: 'om-btn om-btn--sm steer-btn', type: 'button', title: `排隊：等 ${name} 這一輪做完才送出`, onclick: () => this.submit({ steer: false }) }, '排隊') : null,
      // Kimi waiting on a subagent or a command in the foreground.
      stop && s.foreground && !claude ? h('button', { class: 'om-btn om-btn--sm bg-btn', type: 'button', title: BG_DESCRIPTION, onclick: () => this.opts.onBackground?.() }, '移到背景') : null,
      stop
        ? h('button', { class: 'send stop', type: 'button', title: '停止（Esc）', 'aria-label': '停止', onclick: () => this.opts.onStop() }, icon('stop'))
        : h('button', { class: 'send', type: 'button', title: busy ? `插隊：${name} 下一步就讀到，不會中斷它（Enter）` : '送出（Enter）', 'aria-label': busy ? '插隊送出' : '送出', disabled: !this.hasContent(), onclick: () => this.submit() }, icon('up')),
    );
  }

  renderTray() {
    const s = this.state;
    const queue = s.queue || [];
    const todos = s.todos || [];
    const open = todos.filter((t) => t.status !== 'done' && t.status !== 'completed');
    const items = [];
    // Auto-pause, while it has paused the conversation or has a problem.
    const ap = autoPauseStatus(s.autoPause, queue);
    if (ap && (ap.paused || ap.tone === 'danger')) {
      items.push(
        h(
          'div',
          { class: `queued autopause-row${ap.tone === 'danger' ? ' danger' : ''}` },
          icon('pause'),
          h('span', { class: 'queued-label' }, ap.label),
          h('span', { class: 'queued-text', title: ap.detail }, ap.detail),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', title: '狀態、設定與紀錄', onclick: () => this.opts.onAutoPause?.() }, '詳情'),
          ap.paused ? h('button', { class: 'om-btn om-btn--sm', type: 'button', title: `這次不自動送出「${ap.text}」`, onclick: () => this.opts.onCancelAutoResume?.() }, '取消') : null,
        ),
      );
    }
    // 定時送出, until they have gone out.
    for (const q of s.scheduled || []) {
      const note = q.gaveUp ? q.error : q.wait === 'offline' ? '電腦離線，連上後送出' : q.error;
      items.push(
        h(
          'div',
          { class: `queued sched-row${q.gaveUp ? ' danger' : ''}` },
          icon('clock'),
          h('span', { class: 'queued-label' }, q.gaveUp ? '沒送出' : '定時'),
          h('span', { class: 'queued-text', title: [q.text, note].filter(Boolean).join('\n') }, `${q.at > Date.now() ? whenText(q.at) : '正在'}送出「${q.text}」`, note ? h('span', { class: 'muted' }, ` · ${note}`) : null),
          h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '取消這則定時訊息', 'aria-label': '取消這則定時訊息', onclick: () => this.opts.onCancelScheduled?.(q.id) }, icon('x')),
        ),
      );
    }
    // More than one waiting: all of them into the turn at once (/steer).
    if (queue.filter((q) => !q.steered).length > 1 && this.opts.onCommand && !this.opts.home)
      items.push(
        h(
          'div',
          { class: 'queued queued-all' },
          h('span', { class: 'queued-text muted' }, `${queue.filter((q) => !q.steered).length} 則訊息還沒進這一輪`),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', title: `全部插隊：${agentName(this.agent())} 下一步一起讀到，不會中斷它（/steer）`, onclick: () => this.opts.onCommand('steer', '') }, '全部插隊'),
        ),
      );
    for (const q of queue) {
      items.push(
        h(
          'div',
          { class: 'queued' },
          h('span', { class: 'queued-label', title: q.cutIn && !q.steered ? CUT_IN_WHY : undefined }, q.steered ? '下一步插入' : q.cutIn ? '等待插隊' : '排隊中'),
          h('span', { class: 'queued-text' }, q.text || (q.images?.length ? `${q.images.length} 張圖片` : '')),
          !q.steered && !q.cutIn && !q.foreign ? h('button', { class: 'om-btn om-btn--sm', type: 'button', title: `讓 ${agentName(this.agent())} 在下一步就讀到這則訊息，不會中斷它`, onclick: () => this.opts.onSteerQueued(q.promptId) }, '插隊') : null,
          q.foreign ? null : h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '取消這則訊息', 'aria-label': '取消這則訊息', onclick: () => this.opts.onCancelQueued(q.promptId) }, icon('x')),
        ),
      );
    }
    // Subagents at work and the todo list stay here, under the
    // conversation, for as long as they are unfinished. Subagents only as
    // a count: who they are and what each is doing is in the 子代理 pane,
    // which this row opens.
    const working = s.agentsWorking || 0;
    if (working) {
      items.push(
        h(
          'button',
          { class: 'agent-tray', type: 'button', title: '在側邊面板看每個子代理在做什麼', onclick: () => this.opts.onFocusAgent?.() },
          icon('agents'),
          h('span', { class: 'agent-tray-name' }, '子代理'),
          h('span', { class: 'agent-tray-desc' }, `${working} 個在工作`),
          h('span', { class: 'spinner', 'aria-label': '執行中' }),
          icon('chev', 'caret'),
        ),
      );
    }
    if (todos.length && open.length) {
      const done = todos.length - open.length;
      const now = todos.find((t) => t.status === 'in_progress') || open[0];
      const btn = h(
        'button',
        { class: 'todo-chip', type: 'button', title: '看完整的待辦清單', onclick: () => (this.opts.onOpenTodos ? this.opts.onOpenTodos() : ((this.todosOpen = !this.todosOpen), this.renderTray())) },
        icon('todo'),
        h('span', { class: 'todo-progress' }, `${done}/${todos.length}`),
        h('span', { class: 'todo-now' }, now?.title || ''),
        icon(this.todosOpen && !this.opts.onOpenTodos ? 'down' : 'chev', 'caret'),
      );
      items.push(h('div', { class: 'todo-tray' }, btn, this.todosOpen && !this.opts.onOpenTodos ? todoList(todos) : null));
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
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'b' && this.state.running && this.opts.onBackground && !this.claude()) {
      // Like Kimi's Ctrl+B, only while it works.
      e.preventDefault();
      this.opts.onBackground();
    } else if (e.key === 'Escape' && (this.state.running || this.state.awaiting)) {
      e.preventDefault();
      this.opts.onStop();
    }
  }

  // While the agent works, a message cuts in (插隊) by default: it and any
  // others waiting go into the running turn together at its next step.
  // `steer: false` (排隊) waits for the turn to end instead.
  submit({ steer } = {}) {
    if (steer === undefined) steer = Boolean(this.state.running || this.state.awaiting) && !this.opts.home;
    const raw = this.input.value;
    const text = raw.trim();
    if (!text && !this.images.length && !this.docs.length) return;
    const m = text.match(/^\/([\w.:-]+)(?:\s+([\s\S]*))?$/);
    if (m && !this.images.length && !this.docs.length && this.commands().some((c) => c.name === m[1] || c.aliases?.includes(m[1]))) {
      const cmd = this.commands().find((c) => c.name === m[1] || c.aliases?.includes(m[1]));
      this.clear();
      this.opts.onCommand(cmd.name, (m[2] || '').trim());
      return;
    }
    const images = this.images.map(({ mimeType, data, thumb }) => ({ mimeType, data, thumb }));
    // Saved in the conversation's folder by the hub; the message says where.
    const files = this.docs.map(({ name, content, data }) => (data ? { name, data } : { name, content }));
    const uploadDir = files.length ? this.uploadDir || undefined : undefined;
    this.clear();
    this.opts.onSend({ text, images, files, uploadDir, steer });
  }

  clear() {
    this.input.value = '';
    this.images = [];
    this.docs = [];
    if (this.key) this.drafts.delete(this.key);
    this.renderImages();
    this.grow();
    this.closeSlash();
    this.renderActions();
  }

  // ------------------------------------------------------------- slash

  commands() {
    const skills = (this.state.skills || []).map((s) => ({ name: s.name, description: s.description, skill: true, args: true, source: s.source }));
    if (this.claude()) return this.opts.home ? CLAUDE_COMMANDS.filter((c) => CLAUDE_HOME_COMMANDS.includes(c.name)) : CLAUDE_COMMANDS;
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
      const el = h('div', { class: 'om om-menu popover slash-menu', role: 'listbox', 'aria-label': '指令' });
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
    const all = [...files];
    const docs = all.filter((f) => !isImage(f) && isDoc(f));
    const images = all.filter((f) => isImage(f));
    for (const f of all) if (!docs.includes(f) && !images.includes(f)) this.opts.onError?.(`沒辦法讀取「${f.name}」：支援圖片（PNG、JPEG…）和文字檔（.md、.html、.txt、程式碼…）`);
    if (docs.length > MAX_DOCS - this.docs.length) this.opts.onError?.(`一次最多附 ${MAX_DOCS} 個檔案，多的沒有加入`);
    for (const f of docs.slice(0, Math.max(0, MAX_DOCS - this.docs.length))) {
      const zip = isZip(f);
      if (f.size > (zip ? MAX_ZIP_BYTES : MAX_DOC_BYTES)) {
        this.opts.onError?.(`「${f.name}」超過 ${zip ? '20' : '1'} MB，沒有加入`);
        continue;
      }
      try {
        // A .zip goes as base64 and is unpacked on the conversation's computer.
        if (zip) this.docs.push({ name: f.name, data: await base64Of(f), size: f.size, zip: true });
        else this.docs.push({ name: f.name, content: await f.text(), size: f.size });
      } catch {
        this.opts.onError?.(`沒辦法讀取「${f.name}」`);
      }
    }
    for (const f of images.slice(0, MAX_IMAGES - this.images.length)) {
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
      ...this.docs.map((d, i) =>
        h(
          'div',
          { class: 'doc-chip', title: `${d.name}（${d.size >= 1000 ? `${Math.round(d.size / 1000)} KB` : `${d.size} B`}）` },
          icon('document'),
          h('span', { class: 'doc-chip__name' }, d.name),
          h('button', { class: 'thumb-x', type: 'button', title: '移除', 'aria-label': `移除 ${d.name}`, onclick: () => (this.docs.splice(i, 1), this.renderImages(), this.renderActions()) }, icon('x')),
        ),
      ),
    );
    // Where the files go: picked here (the conversation's folder by default).
    if (this.docs.length && this.opts.onPickUploadDir)
      this.thumbs.append(
        h(
          'button',
          {
            class: 'upload-dir',
            type: 'button',
            title: this.uploadDir || '對話資料夾裡的 .agent-hub/attachments（不會進 git）',
            onclick: (e) =>
              this.opts.onPickUploadDir(e.currentTarget, this.uploadDir, (dir) => {
                this.uploadDir = dir;
                this.renderImages();
              }),
          },
          icon('folder'),
          h('span', null, `上傳到：${this.uploadDir ? this.uploadDir.split('/').filter(Boolean).slice(-2).join('/') || '/' : '對話資料夾（預設）'}`),
          icon('down', 'caret'),
        ),
      );
    this.thumbs.hidden = !this.images.length && !this.docs.length;
    const model = this.currentModel();
    if (this.images.length && model && !model.image) this.opts.onError?.(`${model.name} 可能看不懂圖片`);
  }
}

// "實際 Claude Opus 5.5": the model that produced the last response,
// updated with each one. Red when it is not the one chosen (the turn has
// then been stopped).
function servedChip(s) {
  const x = s.servedModel;
  const bad = Boolean(x.asked) && !x.id.startsWith(x.asked);
  const title = `Anthropic 回報最近一次回應（${clockTime(x.at)}）是由 ${x.id} 產生的。每次回應都會更新；跟你選的模型不同時，這一輪會立刻停下。`;
  return h('span', { class: `chip static served${bad ? ' bad' : ''}`, title }, h('span', { class: 'served-dot', 'aria-hidden': 'true' }), h('span', null, `實際 ${x.name || x.id}`));
}

const base64Of = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = reject;
    r.readAsDataURL(file);
  });

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

function contextRing(ctx, onCompact, quotaNode, autoPause, quotaLabel) {
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
    onclick: (e) => {
      // Context first, then the plan's 5-hour and 7-day quota.
      const quota = quotaNode?.();
      openMenu(
        e.currentTarget,
        [
          { section: 'Context' },
          { node: h('div', { class: 'menu-quota' }, h('div', { class: 'quota' }, h('div', { class: 'quota-head' }, h('span', null, `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.size)}`), h('span', { class: 'muted' }, `已用 ${Math.round(pct * 100)}%`)), h('div', { class: `quota-bar${level ? ` ${level}` : ''}` }, h('span', { style: { width: `${Math.round(pct * 100)}%` } })))) },
          ...(quota ? [{ separator: true }, { section: quotaLabel }, { node: quota }] : []),
          ...(autoPause
            ? [
                { label: '自動暫停…', hint: autoPause.state?.enabled ? `${autoPause.state.threshold}%` : '關', onSelect: autoPause.open },
                // Already paused (by hand): just 「繼續」 once the quota is back.
                autoPause.state?.phase === 'paused'
                  ? { label: `額度恢復後送出「${autoPause.state.resumeText || '繼續'}」`, hint: '已設定', onSelect: autoPause.open }
                  : { label: '額度恢復後送出「繼續」', description: '你已經讓 Kimi 停下時用', onSelect: () => autoPause.arm?.() },
              ]
            : []),
          { separator: true },
          { label: '壓縮對話', hint: '/compact', onSelect: onCompact },
        ],
        { align: 'end', width: 260 },
      );
    },
    html: `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}" class="track"/><circle cx="9" cy="9" r="${r}" class="bar" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}"/></svg><span class="ctx-label">${Math.round(pct * 100)}% · ${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)}</span>`,
  });
  return btn;
}
