// Agent Hub — Kimi Code on all your machines, in one window. One kind of
// conversation: Kimi Code on a computer, with any model as the main model
// (Kimi subscription, DeepSeek by a gateway's API key, Claude by an Anthropic
// API key) and any model for its subagents. The color scheme (配色) is a
// choice of its own, not something a model decides.
import { h, fill, icon, relTime, dayGroup, shortPath, baseName, copyText, clockTime, fmtCountdown } from './dom.js';
import { get, post, put, del, patch as apiPatch, connect, setToken } from './api.js';
import { renderHunks, parseUnifiedDiff, renderMarkdown } from './markdown.js';
import { openMenu, closeMenu, menuOpen, pointAnchor } from './menu.js';
import { Transcript, todoList } from './transcript.js';
import { Composer, PERMISSION_LABELS, CLAUDE_PERMISSION_LABELS, EFFORT_LABELS, autoPauseStatus, whenText, agentName, fmtUsd } from './composer.js';
import { ArtifactView, downloadHtml, htmlTitle } from './artifacts.js';

const S = {
  config: null,
  machines: [],
  sessions: new Map(), // hub sessions: Kimi conversations taken over by the hub (and old Claude API conversations)
  claude: null, // the Claude API account: { hasKey, keyHint, keySource, webTools }
  deepseek: null, // the DeepSeek account: { gateway, hasKey, keyHint, gateways }
  cur: null, // { id, summary, seq, transcript }
  route: null,
  panel: null, // { tab: 'artifact' | 'changes', path, version, wide }
  artifacts: [],
  home: loadHome(),
  query: '',
  seen: new Map(), // row key -> status, for "needs you" notifications
  online: true,
  pins: loadPins(),
};

const INIT_PROMPT =
  '請分析這個專案：找出主要的設定檔、技術架構、建置與測試方式、程式碼的組織方式與開發慣例，然後把整理好的內容寫進專案根目錄的 AGENTS.md。已經有這個檔案的話，先讀它，保留仍然正確的部分，整理成一份完整的新版本。AGENTS.md 是給 AI coding agent 看的說明，讀者完全不了解這個專案。請使用這個專案的註解與文件主要使用的語言。';
const CLAUDE_INIT_PROMPT =
  '請分析這個專案：找出主要的設定檔、技術架構、建置與測試方式、程式碼的組織方式與開發慣例，然後把整理好的內容寫進專案根目錄的 CLAUDE.md。已經有這個檔案的話，先讀它，保留仍然正確的部分，整理成一份完整的新版本。CLAUDE.md 是給 Claude 看的專案說明，之後在這個資料夾開的 Claude 對話一開始就會讀到它；讀者完全不了解這個專案。請使用這個專案的註解與文件主要使用的語言。';

// ------------------------------------------------------------- helpers

function loadHome() {
  try {
    // What the home screen kept for the three separate modes is not used any more.
    const { agent, claude, deepseek, ...home } = JSON.parse(localStorage.getItem('hubHome') || '{}');
    return home;
  } catch {
    return {};
  }
}
function loadPins() {
  try {
    return new Set(JSON.parse(localStorage.getItem('hubPins') || '[]'));
  } catch {
    return new Set();
  }
}
function togglePin(key) {
  if (S.pins.has(key)) S.pins.delete(key);
  else S.pins.add(key);
  try {
    localStorage.setItem('hubPins', JSON.stringify([...S.pins]));
  } catch {}
  renderSidebar();
}

// New conversations start from the defaults in 設定; what is picked on the
// home screen applies to that one conversation. 子代理 model: 'primary' (the
// conversation's own model) or a model alias.
const defaults = () => S.config?.settings?.defaults || {};
function resetHomeChoices() {
  const d = defaults();
  Object.assign(S.home, { model: d.model || '', effort: d.effort || '', permission: d.permission || 'manual', planMode: Boolean(d.planMode), subagentModel: d.subagentModel || 'primary' });
  saveHome();
  updateHomeComposer();
}

function saveHome() {
  try {
    localStorage.setItem('hubHome', JSON.stringify(S.home));
  } catch {}
}

const machineById = (id) => S.machines.find((m) => m.id === id);
const busy = (status) => status === 'running' || status === 'awaiting_permission';
// An old conversation the hub ran itself through the Claude API (before
// Claude moved into Kimi Code); it still opens and works as it did.
const isLegacyClaude = (s) => s?.agentId === 'claude';
// What a model belongs to: Kimi's own, or one of the hub's providers in Kimi
// (DeepSeek by a gateway key, Claude by an Anthropic key).
const FAMILIES = ['kimi', 'deepseek', 'claude'];
const modelFamily = (id) => (typeof id === 'string' && id.startsWith('agent-hub-deepseek/') ? 'deepseek' : typeof id === 'string' && id.startsWith('agent-hub-claude/') ? 'claude' : 'kimi');
// The server says (`family`, from the conversation's current model); older
// conversations are told apart by `mode` or by their model.
const familyOf = (s) => (isLegacyClaude(s) ? 'claude' : FAMILIES.includes(s?.family) ? s.family : s?.mode === 'deepseek' ? 'deepseek' : modelFamily(s?.meta?.model));
// DeepSeek and Claude models are paid per use, not from the Kimi plan: no
// plan quota, no auto-pause.
const isMetered = (s) => !isLegacyClaude(s) && familyOf(s) !== 'kimi';
const nameFor = (s) => agentName(familyOf(s));
const hostName = () => S.config?.hostname || '這台電腦';

function toast(text, { action, onAction, kind = '' } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, h('span', null, text), action ? h('button', { class: 'om-btn om-btn--plain om-btn--sm', type: 'button', onclick: () => (onAction(), el.remove()) }, action) : null);
  $toasts.append(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4600);
}
const fail = (err) => toast(err?.message || String(err), { kind: 'error' });

function notify(title, body, onClick) {
  try {
    if (document.hasFocus() || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag: title });
    n.onclick = () => (window.focus(), onClick?.(), n.close());
  } catch {}
}

// --------------------------------------------------------------- shell

const $app = document.getElementById('app');
const $toasts = h('div', { class: 'om toasts', 'aria-live': 'polite' });
document.body.append($toasts);

const $search = h('input', { class: 'om-input', type: 'search', placeholder: '搜尋對話', 'aria-label': '搜尋對話', oninput: () => ((S.query = $search.value.trim().toLowerCase()), renderSidebar()) });
const $list = h('div', { class: 'side-list', role: 'list' });
const $foot = h('div', { class: 'side-foot' });
let $artifactsLink;
const $sidebar = h(
  'nav',
  { class: 'sidebar om-sidebar', 'aria-label': '對話' },
  h(
    'div',
    { class: 'om-sidebar__top' },
    h('span', { class: 'brand' }, 'Agent Hub'),
    h('span', { class: 'om-toolbar__spacer' }),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '收合側欄', 'aria-label': '收合側欄', onclick: () => toggleSidebar(false) }, icon('sidebar')),
  ),
  h('a', { class: 'om-sidebar__item new-item', href: '#/' }, icon('plus'), '新對話'),
  ($artifactsLink = h('a', { class: 'om-sidebar__item new-item', href: '#/artifacts', onclick: () => closeDrawer() }, icon('artifact'), 'Artifacts')),
  h('label', { class: 'om-search side-search' }, icon('search'), $search),
  $list,
  $foot,
);
const $toolbar = h('header', { class: 'om-toolbar toolbar' });
const $view = h('div', { class: 'view' });
const $main = h('main', { class: 'main om-window__main' }, $toolbar, $view);
const $panel = h('aside', { class: 'panel', hidden: true, 'aria-label': '側邊面板' });
const $scrim = h('div', { class: 'scrim', onclick: () => closeDrawer() });
fill($app, $sidebar, $main, $panel, $scrim);
$app.className = 'app om';

// After picking a conversation on a phone.
function closeDrawer() {
  $app.classList.remove('drawer');
}

function toggleSidebar(open) {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  if (mobile) $app.classList.toggle('drawer', open ?? !$app.classList.contains('drawer'));
  else {
    $app.classList.toggle('no-sidebar', open === undefined ? undefined : !open);
    try {
      localStorage.setItem('hubSidebar', $app.classList.contains('no-sidebar') ? 'hidden' : '');
    } catch {}
  }
  renderToolbar();
}
try {
  if (localStorage.getItem('hubSidebar') === 'hidden') $app.classList.add('no-sidebar');
} catch {}

// --------------------------------------------------------------- theme

// Light until someone chooses otherwise; 跟系統一樣 is stored as a choice
// of its own, so it is not mistaken for "nothing chosen yet".
const savedTheme = () => {
  try {
    return localStorage.getItem('hubTheme') || 'light';
  } catch {
    return 'light';
  }
};
function applyTheme(t, { save = true } = {}) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  if (!save) return;
  try {
    localStorage.setItem('hubTheme', t === 'light' || t === 'dark' ? t : 'auto');
  } catch {}
}
const theme = () => document.documentElement.dataset.theme || 'auto';

// 配色: the color scheme is the user's choice (設定 → 配色), the same on the
// home screen, in every conversation and in every dialog; it does not follow
// the model or the kind of conversation. Three looks that are tokens in
// app.css: Kimi's Oatmeal (the default, with 淺色／深色／跟系統 above), Claude's
// black and orange (data-look="claude") and DeepSeek's blue and white
// (data-look="deepseek"); the last two are one fixed scheme, whatever the theme.
// `swatch`: the colors of the little preview (fixed, not the live tokens).
const LOOKS = {
  kimi: { name: 'Kimi', desc: 'Oatmeal 米色，可以選淺色、深色或跟系統一樣', color: null, swatch: { bg: '#f6f0e4', side: '#ece3d2', raised: '#fdfaf4', ink: '#2b241b', accent: '#94501b' } },
  claude: { name: 'Claude 黑橘', desc: '近黑底色配橘色', color: '#141413', swatch: { bg: '#141413', side: '#0f0f0e', raised: '#1f1e1c', ink: '#faf9f5', accent: '#d97757' } },
  deepseek: { name: 'DeepSeek 藍白', desc: '白底配 DeepSeek 藍', color: '#ffffff', swatch: { bg: '#ffffff', side: '#f7f9ff', raised: '#f5f8ff', ink: '#1b1f33', accent: '#4d6bfe' } },
};
const LOOK_KEY = 'hubLookChoice';
const savedLook = () => {
  try {
    const v = localStorage.getItem(LOOK_KEY);
    return LOOKS[v] ? v : null;
  } catch {
    return null;
  }
};
const look = () => document.documentElement.dataset.look || 'kimi';
function applyLook(next, { save = true } = {}) {
  const l = LOOKS[next] ? next : 'kimi';
  const root = document.documentElement;
  if (l !== 'kimi') root.dataset.look = l;
  else delete root.dataset.look;
  // The browser's own bar follows (Kimi: light and dark as before).
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.dataset.base ??= m.content;
    m.content = LOOKS[l].color || m.dataset.base;
  }
  if (!save) return;
  // index.html puts it back on before the first paint of the next visit.
  try {
    localStorage.setItem(LOOK_KEY, l);
  } catch {}
}

// PUT /api/settings replaces the defaults it is sent: always send them whole.
async function saveSettings(patch = {}) {
  const cur = S.config?.settings || {};
  const body = { ...cur, ...patch, defaults: { ...(cur.defaults || {}), ...(patch.defaults || {}) } };
  const r = await put('/settings', body);
  if (r && typeof r === 'object' && S.config) S.config.settings = r;
  return S.config?.settings;
}

// A look chosen here is kept in this browser (it is what the page paints
// first) and, when the hub keeps it too (settings.look), for other browsers
// that have not chosen yet; a hub that ignores it changes nothing.
function chooseLook(next) {
  applyLook(next);
  if (S.config?.settings) S.config.settings.look = next;
  saveSettings({ look: next }).catch(() => {});
}

// ------------------------------------------------------------- sidebar

// One row per Kimi conversation on any connected machine: the ones the hub
// already follows plus everything the machines report.
function rows() {
  const out = [];
  const followed = new Map();
  for (const s of S.sessions.values()) if (s.kimiSessionId) followed.set(`${s.machineId}:${s.kimiSessionId}`, s);
  for (const m of S.machines) {
    for (const k of m.sessions || []) {
      const key = `${m.id}:${k.id}`;
      const s = followed.get(key);
      followed.delete(key);
      const status = s ? s.status : k.busy ? (k.pending && k.pending !== 'none' ? 'awaiting_permission' : 'running') : k.lastTurn === 'failed' ? 'error' : 'idle';
      out.push({ key, hub: s, kimi: k, machine: m, title: s?.title || k.title || '新對話', cwd: s?.cwd || k.cwd, status, family: s ? familyOf(s) : modelFamily(k.model), updatedAt: Math.max(s?.updatedAt || 0, k.updatedAt || 0) });
    }
  }
  for (const [key, s] of followed) out.push({ key, hub: s, machine: machineById(s.machineId), title: s.title, cwd: s.cwd, status: s.status, family: familyOf(s), updatedAt: s.updatedAt, offline: !machineById(s.machineId)?.online });
  // Claude conversations live on the hub itself.
  for (const s of S.sessions.values()) if (isLegacyClaude(s)) out.push({ key: `claude:${s.id}`, hub: s, claude: true, family: 'claude', title: s.title || '新對話', cwd: s.cwd, status: s.status, updatedAt: s.updatedAt });
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

let sideRaf = 0;
let lastSidebar = '';
function renderSidebar() {
  if (sideRaf) return;
  sideRaf = requestAnimationFrame(() => {
    sideRaf = 0;
    drawSidebar();
  });
}

function drawSidebar() {
  const all = rows();
  checkAttention(all);
  const list = S.query ? all.filter((r) => r.title.toLowerCase().includes(S.query) || (r.cwd || '').toLowerCase().includes(S.query)) : all;
  const multi = S.machines.length > 1;
  const groups = new Map();
  for (const r of list) {
    const g = S.pins.has(r.key) ? '已釘選' : dayGroup(r.updatedAt || Date.now());
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const current = S.cur?.summary;
  // Conversations update every few seconds; redraw only what would change.
  const sig = JSON.stringify([
    current?.id,
    multi,
    all.length,
    S.machines.some((m) => m.online),
    [...groups].map(([g, rs]) => [g, rs.map((r) => [r.key, r.title, r.cwd, r.status, r.offline, r.claude, r.family, r.kimi?.owner || r.hub?.meta?.owner, r.machine?.name, relTime(r.updatedAt)])]),
  ]);
  if (sig === lastSidebar) return;
  lastSidebar = sig;
  const items = [];
  for (const [g, rs] of groups) {
    items.push(h('div', { class: 'om-sidebar__section' }, g));
    for (const r of rs) {
      const href = r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine.id}/${r.kimi.id}`;
      const active = current && ((r.hub && r.hub.id === current.id) || (r.kimi && current.kimiSessionId === r.kimi.id && current.machineId === r.machine?.id));
      const owner = r.kimi?.owner || r.hub?.meta?.owner;
      const sub = (r.claude ? [r.hub.machineId ? r.hub.meta?.machineName || machineById(r.hub.machineId)?.name : null, r.cwd ? baseName(r.cwd) : null] : [owner === 'tui' ? '終端機' : null, multi && r.machine ? r.machine.name : null, r.cwd ? baseName(r.cwd) : null]).filter(Boolean).join(' · ');
      items.push(
        h(
          'a',
          {
            class: `side-row${r.offline ? ' offline' : ''}`,
            href,
            role: 'listitem',
            'aria-current': active ? 'page' : null,
            title: r.cwd || '',
            onclick: closeDrawer,
            oncontextmenu: (e) => {
              e.preventDefault();
              rowMenu(r, pointAnchor(e.clientX, e.clientY));
            },
          },
          h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, r.title), h('span', { class: 'row-sub' }, familyTag(r), sub || relTime(r.updatedAt))),
          r.status === 'awaiting_permission'
            ? h('span', { class: 'om-badge om-badge--warning' }, '需要你')
            : r.status === 'running'
              ? h('span', { class: 'spinner', 'aria-label': '執行中' })
              : r.status === 'error'
                ? h('span', { class: 'row-err', title: '上一輪沒有完成' }, icon('alert'))
                : null,
          h(
            'button',
            {
              class: 'row-more',
              type: 'button',
              title: '更多',
              'aria-label': `「${r.title}」的選項`,
              'aria-haspopup': 'menu',
              onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                rowMenu(r, e.currentTarget);
              },
            },
            icon('dots'),
          ),
        ),
      );
    }
  }
  if (!all.length) {
    items.push(h('div', { class: 'side-empty' }, S.machines.some((m) => m.online) ? '在任一台電腦的 Kimi 裡輸入 /web，或在這裡開一個新對話。' : '連接一台電腦，對話會出現在這裡。'));
  }
  fill($list, ...items);
  $search.parentElement.hidden = all.length < 8 && !S.query;
  drawFoot();
  updateTitle();
}

// The tag on a conversation whose model is not Kimi's own.
function familyTag(r) {
  if (r.family === 'deepseek') return h('span', { class: 'row-tag ds', title: '用 DeepSeek 模型，費用算在閘道的 API key，不用 Kimi 訂閱' }, 'DeepSeek');
  if (r.family === 'claude') return h('span', { class: 'row-tag cl', title: r.claude ? 'Claude API 對話（中控台直接執行），按用量計費' : '用 Claude 模型，費用算在 Anthropic 的 API key，不用 Kimi 訂閱' }, 'Claude');
  return null;
}

// Right-click (or the … button) on a conversation in the sidebar.
function rowMenu(r, anchor) {
  if (r.claude) return claudeRowMenu(r, anchor);
  const href = r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine?.id}/${r.kimi?.id}`;
  const reachable = r.machine?.online && r.machine.kimi?.available;
  const kid = r.kimi?.id || r.hub?.kimiSessionId;
  const mid = r.machine?.id || r.hub?.machineId;
  openMenu(
    anchor,
    [
      { label: '在新分頁開啟', onSelect: () => window.open(`${location.pathname}${href}`, '_blank', 'noopener') },
      { label: '重新命名…', disabled: !reachable, onSelect: () => renameRow(r, mid, kid) },
      { label: S.pins.has(r.key) ? '取消釘選' : '釘選', onSelect: () => togglePin(r.key) },
      r.cwd ? { label: '複製資料夾路徑', onSelect: () => copyText(r.cwd).then(() => toast('已複製')) } : null,
      { separator: true },
      reachable || !r.hub ? { label: '刪除…', destructive: true, disabled: !reachable, onSelect: () => deleteRow(r, mid, kid) } : { label: '從中控台移除…', destructive: true, onSelect: () => forgetRow(r) },
    ].filter(Boolean),
    { width: 200 },
  );
}

function claudeRowMenu(r, anchor) {
  openMenu(
    anchor,
    [
      { label: '在新分頁開啟', onSelect: () => window.open(`${location.pathname}#/s/${r.hub.id}`, '_blank', 'noopener') },
      { label: '重新命名…', onSelect: () => renameClaude(r.hub) },
      { label: S.pins.has(r.key) ? '取消釘選' : '釘選', onSelect: () => togglePin(r.key) },
      r.cwd ? { label: '複製資料夾路徑', onSelect: () => copyText(r.cwd).then(() => toast('已複製')) } : null,
      { separator: true },
      { label: '刪除…', destructive: true, onSelect: () => deleteClaude(r.hub) },
    ].filter(Boolean),
    { width: 200 },
  );
}

async function renameClaude(s) {
  const title = await promptDialog({ title: '要把對話改成什麼名稱？', value: s.title, action: '重新命名' });
  if (!title?.trim() || title.trim() === s.title) return;
  try {
    upsertSession(await apiPatch(`/sessions/${s.id}`, { title: title.trim() }));
  } catch (err) {
    fail(err);
  }
}

async function deleteClaude(s) {
  const ok = await confirmDialog({ title: `要刪除「${s.title}」嗎？`, body: '對話紀錄會從中控台刪除。資料夾裡的檔案不會動。', action: '刪除', destructive: true });
  if (!ok) return;
  try {
    await del(`/sessions/${s.id}`);
    S.pins.delete(`claude:${s.id}`);
    if (S.cur?.id === s.id) go('#/');
    toast('已刪除對話');
  } catch (err) {
    fail(err);
  }
}

async function renameRow(r, mid, kid) {
  const title = await promptDialog({ title: '要把對話改成什麼名稱？', value: r.title, action: '重新命名' });
  if (!title?.trim() || title.trim() === r.title) return;
  try {
    await post(`/machines/${mid}/kimi/${kid}/title`, { title: title.trim() });
  } catch (err) {
    fail(err);
  }
}

async function deleteRow(r, mid, kid) {
  const ok = await confirmDialog({ title: `要刪除「${r.title}」嗎？`, body: '它會從中控台和 Kimi 的對話清單移除。Kimi 會把它封存，紀錄仍留在那台電腦上。', action: '刪除', destructive: true });
  if (!ok) return;
  const here = S.cur?.summary && S.cur.summary.kimiSessionId === kid;
  try {
    await post(`/machines/${mid}/kimi/${kid}/archive`);
    S.pins.delete(r.key);
    if (here) go('#/');
    toast('已刪除對話');
  } catch (err) {
    fail(err);
  }
}

async function forgetRow(r) {
  const ok = await confirmDialog({ title: `要從中控台移除「${r.title}」嗎？`, body: '那台電腦目前離線。這只會移除中控台裡的紀錄，不會動到 Kimi。', action: '移除', destructive: true });
  if (!ok) return;
  try {
    await del(`/sessions/${r.hub.id}`);
    if (S.cur?.id === r.hub.id) go('#/');
  } catch (err) {
    fail(err);
  }
}

function drawFoot() {
  const online = S.machines.filter((m) => m.online);
  const ready = online.filter((m) => m.kimi?.available);
  const label = !S.machines.length ? '連接電腦…' : online.length === 1 ? online[0].name : online.length ? `${online.length} 台電腦` : '電腦都離線了';
  const state = !S.machines.length ? '' : !online.length ? 'off' : ready.length < online.length ? 'warn' : 'on';
  fill(
    $foot,
    h('button', { class: 'om-sidebar__item machines-item', type: 'button', onclick: openMachines }, icon('computer'), h('span', { class: 'machines-label' }, label), state ? h('span', { class: `dot ${state}`, 'aria-hidden': 'true' }) : null, !S.online ? h('span', { class: 'om-badge om-badge--danger' }, '離線') : null),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '設定', 'aria-label': '設定', onclick: (e) => settingsMenu(e.currentTarget) }, icon('dots')),
  );
}

function settingsMenu(anchor) {
  const t = theme();
  // 淺色／深色 belong to the Kimi look; the other two looks are one scheme.
  const kimi = look() === 'kimi';
  const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'default';
  openMenu(
    anchor,
    [
      { section: '外觀' },
      { label: '跟系統一樣', checked: t === 'auto', disabled: !kimi, onSelect: () => applyTheme(null) },
      { label: '淺色', checked: t === 'light', disabled: !kimi, onSelect: () => applyTheme('light') },
      { label: '深色', checked: t === 'dark', disabled: !kimi, onSelect: () => applyTheme('dark') },
      kimi ? null : { node: h('div', { class: 'menu-note' }, `${LOOKS[look()].name} 配色固定一種明暗，淺色／深色只用在 Kimi 配色`) },
      { label: '配色…', hint: LOOKS[look()].name, onSelect: openSettings },
      { separator: true },
      canNotify ? { label: '開啟通知', description: 'Kimi 需要你的時候通知你', onSelect: () => Notification.requestPermission().then(() => toast('已開啟通知')) } : null,
      { label: '設定…', description: '配色、模型來源、新對話的預設', onSelect: openSettings },
      { label: 'Claude API…', description: 'API key（Claude 模型的來源）', onSelect: claudeDialog },
      { label: 'DeepSeek…', description: '閘道與 API key（DeepSeek 模型的來源）', onSelect: deepseekDialog },
      { label: 'Google Drive 備份…', description: '/backup 把專案資料夾備份到你的 Google Drive', onSelect: gdriveDialog },
      { label: 'GitHub…', description: '讓 Claude 和 Kimi 用你的 GitHub 帳號', onSelect: githubDialog },
      { label: '連接電腦…', onSelect: openMachines },
      { label: '登出', destructive: true, onSelect: logout },
    ].filter(Boolean),
    { side: 'auto', width: 240 },
  );
}

function logout() {
  setToken('');
  location.hash = '#/';
  location.reload();
}

// A conversation that starts waiting for you gets a toast (and a system
// notification when the tab is in the background).
function checkAttention(all) {
  for (const r of all) {
    const prev = S.seen.get(r.key);
    S.seen.set(r.key, r.status);
    // A Claude turn that stopped by itself (another model answered, a
    // refusal, an API error) is said too, so it is never missed.
    const stopped = r.claude && r.status === 'error';
    if (prev === undefined || prev === r.status || (r.status !== 'awaiting_permission' && !stopped)) continue;
    const here = S.cur?.summary && r.hub?.id === S.cur.summary.id;
    if (here && document.hasFocus() && !stopped) continue;
    const open = () => go(r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine.id}/${r.kimi.id}`);
    if (stopped) {
      toast(`「${r.title}」停下來了，沒有完成，原因寫在對話裡`, { kind: 'error', ...(here ? {} : { action: '查看', onAction: open }) });
      notify('Claude 停下來了', r.title, open);
      continue;
    }
    if (!here) toast(`「${r.title}」需要你核准`, { action: '查看', onAction: open });
    notify(`${agentName(r.family)} 需要你`, r.title, open);
  }
}

function updateTitle() {
  const n = [...S.seen.values()].filter((s) => s === 'awaiting_permission').length;
  const base = S.cur?.summary?.title || 'Agent Hub';
  document.title = `${n ? `(${n}) ` : ''}${base}`;
}

// ------------------------------------------------------------- routing

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

window.addEventListener('hashchange', route);

async function route() {
  const hash = location.hash || '#/';
  closeMenu();
  $artifactsLink.removeAttribute('aria-current');
  let m;
  if ((m = hash.match(/^#\/s\/([\w-]+)/))) return openSession(m[1]);
  if ((m = hash.match(/^#\/k\/([\w-]+)\/([\w-]+)/))) return attachAndOpen(m[1], m[2]);
  if (hash.startsWith('#/artifacts')) return showArtifacts();
  return showHome();
}

// All pages Kimi made, across conversations, like Claude's Artifacts list.
async function showArtifacts() {
  leaveSession();
  hidePanel();
  S.route = 'artifacts';
  $artifactsLink.setAttribute('aria-current', 'page');
  renderSidebar();
  fill($toolbar, sidebarToggle(), h('div', { class: 'toolbar-titles' }, h('div', { class: 'om-toolbar__title' }, 'Artifacts')));
  const body = h('div', { class: 'artifacts-page' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  fill($view, body);
  let list = [];
  try {
    list = await get('/artifacts');
  } catch (err) {
    return fill(body, h('div', { class: 'panel-empty' }, err.message));
  }
  if (S.route !== 'artifacts') return;
  if (!list.length) return fill(body, h('div', { class: 'artifacts-empty' }, h('div', { class: 'large-title' }, '還沒有 Artifact'), h('p', { class: 'home-lead' }, '請 Kimi 或 Claude 做一個頁面（例如輸入 /artifact 做一個進度頁），它寫的 HTML 會出現在這裡。')));
  fill(
    body,
    h(
      'div',
      { class: 'artifacts-grid' },
      ...list.map((a) =>
        h(
          'a',
          { class: 'artifact-tile', href: `#/s/${a.sessionId}`, onclick: () => (S.openArtifact = a.path) },
          h('span', { class: 'artifact-card-icon' }, icon('artifact')),
          h('span', { class: 'artifact-tile-title' }, a.title),
          h('span', { class: 'artifact-tile-sub' }, a.sessionTitle || ''),
          h('span', { class: 'artifact-tile-meta' }, [machineById(a.machineId)?.name, relTime(a.updatedAt), a.versions > 1 ? `${a.versions} 個版本` : null].filter(Boolean).join(' · ')),
        ),
      ),
    ),
  );
}

async function attachAndOpen(machineId, kimiSessionId) {
  leaveSession();
  S.route = `k:${kimiSessionId}`;
  fill($toolbar, sidebarToggle(), h('div', { class: 'toolbar-titles' }, h('div', { class: 'om-toolbar__title' }, rows().find((r) => r.kimi?.id === kimiSessionId)?.title || '載入中…')));
  fill($view, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), '正在載入對話…'));
  try {
    const s = await post(`/machines/${machineId}/kimi/${kimiSessionId}/attach`);
    S.sessions.set(s.id, s);
    if (S.route === `k:${kimiSessionId}`) location.replace(`#/s/${s.id}`);
  } catch (err) {
    fill($view, h('div', { class: 'loading' }, err.message));
  }
}

// ---------------------------------------------------------------- home

let homeComposer = null;
let homeEls = null; // { title, hint }: follow the main model chosen

function homeMachine() {
  const ready = S.machines.filter((m) => m.online && m.kimi?.available);
  return machineById(S.home.machineId && ready.some((m) => m.id === S.home.machineId) ? S.home.machineId : ready[0]?.id) || null;
}

// ------------------------------------------------------- model sources

// The models a computer can run, by where they come from: Kimi's own
// (subscription), DeepSeek (a gateway's API key) and Claude (an Anthropic API
// key). GET /api/models?machineId= says which are set up (`ready`) and lists
// their models; an older hub is read from the machine's own model list.
const SOURCE_NAMES = { kimi: 'Kimi 訂閱', deepseek: 'DeepSeek', claude: 'Claude API' };
const BILLING_TAGS = { subscription: '訂閱', plan: '訂閱', gateway: '閘道計費', metered: '按量計費', api: '按量計費', usage: '按量計費' };
const billingTag = (b) => BILLING_TAGS[b] || (typeof b === 'string' ? b : '');
const dsGateway = () => (S.deepseek?.gateways || []).find((g) => g.id === S.deepseek?.gateway) || null;
const dsLabel = () => dsGateway()?.label || 'DeepSeek 閘道';
function sourceTitle(src) {
  const label = src.label || SOURCE_NAMES[src.id] || src.id;
  if (src.id === 'deepseek' && !/[（(]/.test(label) && dsGateway()) return `${label}（${dsGateway().label}）`;
  return label;
}

const catalogs = new Map(); // machine id -> { cat, p }
const catalogOf = (machineId) => (machineId ? catalogs.get(machineId)?.cat || null : null);
const allModels = (cat) => (cat?.sources || []).flatMap((x) => x.models);

function normalizeCatalog(r, legacy) {
  const fix = (m, family) => ({ ...m, name: m.name || String(m.id).split('/').pop(), efforts: Array.isArray(m.efforts) ? m.efforts : [], family: FAMILIES.includes(m.family) ? m.family : family });
  let sources = Array.isArray(r?.sources) ? r.sources.filter((x) => x && typeof x.id === 'string').map((x) => ({ ...x, ready: x.ready !== false, models: (x.models || []).filter((m) => m?.id).map((m) => fix(m, x.id)) })) : null;
  if (!sources) {
    if (!Array.isArray(legacy?.models)) return null;
    const own = [];
    const ds = [];
    for (const m of legacy.models) (m.deepseek ? ds : own).push(fix(m, m.deepseek ? 'deepseek' : 'kimi'));
    sources = [{ id: 'kimi', billing: 'subscription', ready: true, models: own }, ...(ds.length ? [{ id: 'deepseek', billing: 'gateway', ready: true, models: ds }] : [])];
  }
  const has = (id) => id && sources.some((x) => x.models.some((m) => m.id === id));
  const defaultModel = [r?.defaultModel, legacy?.defaultModel].find(has) || sources.find((x) => x.id === 'kimi')?.models[0]?.id || sources.flatMap((x) => x.models)[0]?.id || '';
  return { sources, scope: r?.subagentEffortScope || 'none', defaultModel };
}

function loadCatalog(machineId, force = false) {
  if (!machineId) return Promise.resolve(null);
  const have = catalogs.get(machineId);
  if (have && !force) return have.p;
  const e = { cat: have?.cat || null };
  const q = encodeURIComponent(machineId);
  e.p = Promise.all([get(`/models?machineId=${q}`).catch(() => null), get(`/machines/${q}/models`).catch(() => null)]).then(([r, legacy]) => {
    const cat = normalizeCatalog(r, legacy);
    if (!cat) {
      if (catalogs.get(machineId) === e) catalogs.delete(machineId); // try again next time
      return e.cat;
    }
    e.cat = cat;
    catalogChanged(machineId);
    return cat;
  });
  catalogs.set(machineId, e);
  return e.p;
}

// A key was set or removed (here or elsewhere): every list is read again.
function refreshCatalogs() {
  const ids = new Set([homeMachine()?.id, S.cur?.summary?.machineId].filter(Boolean));
  catalogs.clear();
  for (const id of ids) loadCatalog(id);
}

// New models on screen: the home composer, the open conversation's controls and
// its subagent cards (which name their model).
function catalogChanged(machineId) {
  if (S.route === 'home') updateHomeComposer();
  const cur = S.cur;
  if (cur && cur.summary?.machineId === machineId) {
    cur.composerSig = '';
    updateComposer();
    for (const id of cur.transcript.agentIds) cur.transcript.markDirty(id);
  }
}

// The groups of the model menus: a header, a billing tag and, for a source
// that is not set up, one 「設定…」 row.
const menuSources = (cat) =>
  (cat?.sources || []).map((src) => ({ id: src.id, title: sourceTitle(src), tag: billingTag(src.billing), ready: src.ready, setupLabel: src.ready ? null : src.id === 'kimi' ? '連接電腦…' : '設定…', models: src.models }));

// A model's name, wherever it is known.
function modelName(alias) {
  if (!alias || alias === 'primary') return '';
  for (const e of catalogs.values()) {
    const m = allModels(e.cat).find((x) => x.id === alias);
    if (m) return m.name;
  }
  return (S.cur?.summary?.meta?.models || []).find((x) => x.id === alias)?.name || String(alias).split('/').pop();
}

// 子代理: which model its subagents run on, and where their thinking comes
// from. How hard a model thinks as a subagent is one setting per model, shared
// by every conversation (設定); there is no per-conversation control for it.
const subagentLabel = (sub) => (!sub || sub === 'primary' ? '跟主模型一樣' : modelName(sub));
const subagentEffortOf = (alias, m) => defaults().subagentEfforts?.[alias] || m?.subagentDefaultEffort || m?.defaultEffort || '';
function subagentNote(sub, cat) {
  if (!sub || sub === 'primary') return '思考強度跟主模型';
  const m = allModels(cat).find((x) => x.id === sub);
  if ((m?.family || modelFamily(sub)) === 'kimi') return '思考強度由 Kimi 決定';
  if (cat?.scope !== 'per-model') return '子代理用模型自己的預設思考強度';
  const e = subagentEffortOf(sub, m);
  return e ? `思考強度：${EFFORT_LABELS[e] || e}（依模型設定，在「設定」改）` : '思考強度依模型設定，在「設定」改';
}

// What a subagent card says about its model: 「模型 · 思考 強度」, and whether
// that is the conversation's own model (子代理「跟主模型一樣」).
function subagentInfo(sub) {
  if (!sub) return null;
  const s = S.cur?.summary;
  const alias = sub.model || sub.served || '';
  const primary = sub.primary === true || (s?.subagent?.model === 'primary' && (!alias || alias === s?.meta?.model));
  const text = [modelName(alias), sub.effort ? `思考 ${EFFORT_LABELS[sub.effort] || sub.effort}` : ''].filter(Boolean).join(' · ');
  return text || primary ? { text, primary } : null;
}

// A key (Claude, DeepSeek) or a computer to connect: where a source is set up.
function setupSource(id) {
  if (id === 'deepseek') return deepseekDialog();
  if (id === 'claude') return claudeDialog();
  return openMachines();
}

// ---------------------------------------------------------- the new conversation

// What the home screen has chosen, resolved against what the computer offers.
function homeSelection() {
  const m = homeMachine();
  const cat = m ? catalogOf(m.id) : null;
  const models = allModels(cat);
  const chosen = S.home.model && models.some((x) => x.id === S.home.model) ? S.home.model : '';
  const used = models.find((x) => x.id === (chosen || cat?.defaultModel)) || null;
  // The thinking chosen (or from 設定), when the model that will be used
  // (the one picked, or the default) offers it.
  const effort = S.home.effort && used?.efforts?.includes(S.home.effort) ? S.home.effort : '';
  const sub = S.home.subagentModel && S.home.subagentModel !== 'primary' && models.some((x) => x.id === S.home.subagentModel) ? S.home.subagentModel : 'primary';
  return { m, cat, models, chosen, used, effort, sub };
}

const homeFamily = (used) => used?.family || (used ? modelFamily(used.id) : 'kimi');

function homeHint(m, family) {
  if (!m) return '連接的電腦目前都沒有執行中的 Kimi。在那台電腦的 Kimi 裡輸入 /web，或執行 kimi web。';
  if (family === 'deepseek') return `會在「${m.name}」上的 Kimi Code 用 DeepSeek 模型執行，費用算在 ${dsLabel()} 的 API key，不用 Kimi 訂閱。${(S.deepseek?.warnings || []).some((w) => w.machineId === m.id) ? `注意：那台電腦的 DeepSeek 模型來源沒能加上 session 標頭，${dsLabel()} 可能會限流。` : ''}`;
  if (family === 'claude') return `會在「${m.name}」上的 Kimi Code 用 Claude 模型執行，費用按用量從 Claude Console 帳戶扣款，不用 Kimi 訂閱。`;
  return `會在「${m.name}」上的 Kimi 執行，用那台電腦登入的帳號。`;
}

async function showHome() {
  leaveSession();
  S.route = 'home';
  hidePanel();
  renderToolbar();
  homeEls = null;
  const m = homeMachine();
  if (!S.machines.length) {
    fill(
      $view,
      h(
        'div',
        { class: 'home' },
        h(
          'div',
          { class: 'home-inner empty' },
          h('div', { class: 'large-title' }, '先連接一台電腦'),
          h('p', { class: 'home-lead' }, '中控台透過你電腦上的連接器操作 Kimi Code。Kimi 只在你自己的電腦上登入，中控台不需要你的 Kimi 帳號。Claude 和 DeepSeek 模型也在那台電腦的 Kimi Code 裡執行。'),
          h('button', { class: 'om-btn om-btn--primary om-btn--lg', type: 'button', onclick: openMachines }, '連接電腦…'),
        ),
      ),
    );
    return;
  }
  homeComposer ??= new Composer({
    home: true,
    homePlaceholder: (name) => `要讓 ${name} 做什麼？輸入 / 看指令`,
    onSend: startSession,
    onCommand: homeCommand,
    onPickUploadDir: (anchor, cur, set) => homeMachine() && uploadDirMenu(anchor, homeMachine(), null, cur, set),
    onStop: () => {},
    onConfig: (c) => {
      if (c.model) S.home.model = c.model;
      if (c.effort) S.home.effort = c.effort;
      if (c.permission) S.home.permission = c.permission;
      if ('planMode' in c) S.home.planMode = c.planMode;
      if (c.subagent?.model) S.home.subagentModel = c.subagent.model;
      saveHome();
      updateHomeComposer();
    },
    onSetupSource: setupSource,
    onPickMachine: machineMenu,
    onPickFolder: folderMenu,
    onError: (t) => toast(t),
  });
  homeComposer.setKey('home');
  const title = h('div', { class: 'large-title' }, '要讓 Kimi 做什麼？');
  const hint = h('p', { class: 'home-hint' });
  homeEls = { title, hint };
  fill($view, h('div', { class: 'home' }, h('div', { class: 'home-inner' }, title, homeComposer.el, hint)));
  updateHomeComposer();
  homeComposer.focus();
  loadCatalog(m?.id);
}

function updateHomeComposer() {
  if (!homeComposer) return;
  const { m, cat, models, chosen, used, effort, sub } = homeSelection();
  const folder = S.home.cwdByMachine?.[m?.id];
  const family = homeFamily(used);
  homeComposer.update({
    machineName: m?.name,
    folderName: homeRepo(m) ? homeRepo(m).full : folder === null ? '新資料夾' : folder ? baseName(folder) : '新資料夾',
    folderIcon: homeRepo(m) ? 'branch' : 'folder',
    agent: 'kimi',
    family,
    models,
    sources: models.length ? menuSources(cat) : undefined,
    defaultModel: cat?.defaultModel,
    model: chosen,
    effort,
    permission: S.home.permission || 'manual',
    planMode: Boolean(S.home.planMode),
    subagent: models.length ? { model: sub } : null,
    subagentLabel: subagentLabel(sub),
    subagentNote: subagentNote(sub, cat),
  });
  if (homeEls) {
    homeEls.title.textContent = `要讓 ${agentName(family)} 做什麼？`;
    homeEls.hint.textContent = homeHint(m, family);
  }
}

function homeCommand(name) {
  if (name === 'usage' || name === 'status') return homeMachine() ? (homeFamily(homeSelection().used) === 'kimi' ? accountDialog(homeMachine().id) : openSettings()) : openMachines();
  if (['model', 'effort', 'permission', 'subagent'].includes(name)) return homeComposer.openControl(name) || toast('這台電腦的 Kimi 沒有提供這個選項');
  if (name === 'plan') return homeComposer.opts.onConfig({ planMode: !S.home.planMode });
  if (['yolo', 'auto', 'manual'].includes(name)) return homeComposer.opts.onConfig({ permission: name });
}

function machineMenu(anchor) {
  const cur = homeMachine();
  openMenu(
    anchor,
    [
      ...S.machines.map((m) => ({
        label: m.name,
        description: !m.online ? '離線' : !m.kimi?.available ? '沒有執行中的 Kimi' : m.platform,
        checked: cur?.id === m.id,
        disabled: !m.online || !m.kimi?.available,
        onSelect: () => {
          S.home.machineId = m.id;
          saveHome();
          showHome();
        },
      })),
      { separator: true },
      { label: '連接其他電腦…', onSelect: openMachines },
    ],
    { width: 260 },
  );
}

// A GitHub repository a new conversation on `m` is bound to.
const homeRepo = (m) => (m ? S.home.repoByMachine?.[m.id] || null : null);

function folderMenu(anchor) {
  const m = homeMachine();
  if (!m) return openMachines();
  const recent = [...new Set((m.sessions || []).map((s) => s.cwd).filter(Boolean))].slice(0, 6);
  const pick = (cwd) => {
    S.home.cwdByMachine = { ...(S.home.cwdByMachine || {}), [m.id]: cwd };
    S.home.repoByMachine = { ...(S.home.repoByMachine || {}), [m.id]: null };
    saveHome();
    showHome();
  };
  const repo = homeRepo(m);
  openMenu(
    anchor,
    [
      { section: 'GitHub' },
      { label: repo ? `${repo.full}（${repo.branch || '新分支'}）` : '綁定一個 GitHub repo…', description: repo ? '換一個 repo 或分支' : 'clone 下來，所有程式碼都 commit 並 push 到那裡', checked: Boolean(repo), onSelect: () => repoDialog(m, null) },
      { separator: true },
      recent.length ? { section: '最近使用' } : null,
      ...recent.map((p) => ({ label: baseName(p), description: shortPath(p, m.home, 4), onSelect: () => pick(p) })),
      recent.length ? { separator: true } : null,
      { label: '瀏覽資料夾…', onSelect: () => browseFolders(m, pick) },
      { label: '新的空白資料夾', description: '在 ~/agent-hub-workspaces 建立', onSelect: () => pick(null) },
    ].filter(Boolean),
    { width: 300 },
  );
}

async function startSession({ text, images, files, uploadDir }) {
  const m = homeMachine();
  if (!m) return openMachines();
  if (!catalogOf(m.id)) await loadCatalog(m.id);
  const { chosen, effort, sub } = homeSelection();
  const repo = homeRepo(m);
  const cwd = repo ? undefined : S.home.cwdByMachine?.[m.id] || undefined;
  homeComposer.el.classList.add('sending');
  try {
    const s = await post('/sessions', {
      machineId: m.id,
      cwd,
      files,
      uploadDir,
      repo: repo?.full,
      branch: repo?.branch || undefined,
      prompt: text,
      images,
      model: chosen || undefined,
      effort: effort || undefined,
      permission: S.home.permission,
      planMode: S.home.planMode || undefined,
      subagent: { model: sub },
    });
    S.sessions.set(s.id, s);
    resetHomeChoices(); // the next new conversation starts from the defaults again
    go(`#/s/${s.id}`);
  } catch (err) {
    homeComposer.setText(text);
    fail(err);
  } finally {
    homeComposer.el.classList.remove('sending');
  }
}

// ------------------------------------------------------------- session

let composer = null;
let artifactView = null;

// The conversation on screen is followed over the socket: { t: 'watch' }
// brings a snapshot of it, then its events, in order on the same socket.
// Asking again (a gap, a reset, a reconnect) starts over from a snapshot;
// until it arrives, events are left alone (the snapshot has them).
let socket = null;
function watchCurrent() {
  if (S.cur) S.cur.syncing = true;
  socket?.send({ t: 'watch', sid: S.cur?.id || null });
}

function leaveSession() {
  if (!S.cur) return;
  if (['agents', 'todos'].includes(S.panel?.tab)) hidePanel();
  clearInterval(S.cur.ping);
  S.cur.transcript.destroy();
  S.cur = null;
  S.artifacts = [];
  artifactView?.destroy();
  artifactView = null;
  watchCurrent();
}

async function openSession(id) {
  if (S.cur?.id === id) return;
  leaveSession();
  S.route = `s:${id}`;
  if (S.panel?.tab === 'artifact') hidePanel();
  const summary = S.sessions.get(id);
  const cur = { id, summary, seq: 0, transcript: null, loading: true, syncing: true };
  S.cur = cur;
  // Keeps the conversation followed on the machine while it is open.
  cur.ping = setInterval(() => document.visibilityState === 'visible' && post(`/sessions/${id}/viewing`).catch(() => {}), 60_000);
  cur.transcript = new Transcript({
    cwd: summary?.cwd,
    agentName: nameFor(summary),
    subagentInfo,
    onRespond: respond,
    onOpenArtifact: (path, version) => showArtifact(path, version),
    onArtifacts: (list) => {
      // A page Kimi starts writing now opens beside the conversation, so it
      // can be watched as it is generated.
      const fresh = !cur.loading && cur.knownArtifacts ? list.find((a) => !cur.knownArtifacts.has(a.path)) : null;
      S.artifacts = withOpened(list);
      cur.knownArtifacts = new Set(list.map((a) => a.path));
      renderToolbar();
      if (fresh && window.matchMedia('(min-width: 1100px)').matches) showArtifact(fresh.path);
      else syncArtifact();
    },
    artifactsCache: () => S.artifacts,
    activeArtifact: () => (S.panel?.tab === 'artifact' ? S.panel.path : null),
    onImage: lightbox,
    onLoadEarlier: () => post(`/sessions/${id}/earlier`).catch(fail),
    onLink: openFileLink,
    // Working subagents go to the tray under the conversation.
    onFlush: (ids) => {
      if (S.cur !== cur || !composer) return;
      syncAgentPanel(ids);
      // The tray shows only how many: redraw when that changes.
      const n = cur.transcript.runningCount();
      const fg = cur.transcript.foregroundCount();
      if (n === cur.agentsWorking && fg === cur.foreground) return;
      cur.agentsWorking = n;
      cur.foreground = fg;
      composer.update({ agentsWorking: n, foreground: fg });
    },
  });
  composer ??= new Composer({
    onSend: sendMessage,
    onCommand: sessionCommand,
    onPickUploadDir: (anchor, cur, set) => {
      const s = S.cur?.summary;
      if (s) uploadDirMenu(anchor, s.machineId ? machineById(s.machineId) || { id: s.machineId, name: s.meta?.machineName || '那台電腦' } : { id: null, name: hostName(), home: S.config?.home }, s.cwd, cur, set);
    },
    onStop: interrupt,
    onConfig: configure,
    onSetupSource: setupSource,
    onCancelQueued: (pid) => S.cur && del(`/sessions/${S.cur.id}/queue/${pid}`).catch(fail),
    onSteerQueued: (pid) => S.cur && post(`/sessions/${S.cur.id}/queue/${pid}/steer`).catch(fail),
    onUnlock: () => S.cur && post(`/sessions/${S.cur.id}/unlock`).catch(fail),
    onError: (t) => toast(t),
    onHelp: openMachines,
    onFocusAgent: (aid) => showAgents(aid),
    onQuotaNode: quotaMenuNode,
    onOpenTodos: showTodos,
    onAutoPause: autoPauseDialog,
    onCancelAutoResume: cancelAutoResume,
    onArmResume: () => armResumeAfterReset(),
    onCancelScheduled: cancelScheduled,
    onBackground: moveToBackground,
  });
  composer.setKey(id);
  composer.update({ agent: isLegacyClaude(summary) ? 'claude' : 'kimi', family: familyOf(summary), agentsWorking: 0, foreground: 0 });
  cur.composerSig = '';
  if (summary?.machineId && !isLegacyClaude(summary)) loadCatalog(summary.machineId);
  fill($view, h('div', { class: 'session' }, cur.transcript.el, h('div', { class: 'composer-dock' }, composer.el)));
  renderToolbar();
  renderSidebar();
  watchCurrent();
  composer.focus();
  // No socket yet (it is still connecting, or down): over HTTP after a
  // moment, so the conversation shows anyway.
  setTimeout(async () => {
    if (S.cur !== cur || !cur.loading || S.socketOpen) return;
    try {
      const full = await get(`/sessions/${id}`);
      if (S.cur === cur && cur.loading) applySnapshot(full);
    } catch (err) {
      if (S.cur !== cur) return;
      if (err.status === 404) return go('#/');
      fill($view, h('div', { class: 'loading' }, err.message));
    }
  }, S.socketOpen ? 0 : 2500);
}

function applySnapshot(full) {
  const cur = S.cur;
  const { events, seq, ...summary } = full;
  cur.summary = summary;
  cur.seq = seq;
  cur.loading = true; // pages already there are not "new" while it loads
  S.sessions.set(summary.id, summary);
  cur.transcript.opts.cwd = summary.cwd;
  cur.transcript.opts.agentName = nameFor(summary);
  if (summary.machineId && !isLegacyClaude(summary)) loadCatalog(summary.machineId);
  cur.transcript.load(events);
  cur.loading = false;
  cur.transcript.setServed(summary.meta?.servedModel?.name);
  cur.transcript.setStatus(summary.status, busy(summary.status) ? lastUserTs(events) : null, summary.meta?.tps || 0);
  S.artifacts = withOpened(cur.transcript.artifacts());
  cur.knownArtifacts = new Set(S.artifacts.map((a) => a.path));
  // A fresh copy (after a reconnect or a hub restart) may have stopped the
  // subagents the tray still counts.
  cur.agentsWorking = cur.transcript.runningCount();
  cur.foreground = cur.transcript.foregroundCount();
  composer?.update({ agentsWorking: cur.agentsWorking, foreground: cur.foreground });
  updateComposer();
  renderToolbar();
  renderSidebar();
  // Opened from the Artifacts page.
  const want = S.openArtifact;
  S.openArtifact = null;
  if (want && S.artifacts.some((a) => a.path === want)) showArtifact(want);
  else syncArtifact();
}

function lastUserTs(events) {
  return [...events].reverse().find((e) => e.type === 'user')?.ts || Date.now();
}

function updateComposer() {
  const s = S.cur?.summary;
  if (!s || !composer) return;
  if (S.panel?.tab === 'todos' && JSON.stringify(s.meta?.todos || []) !== S.panel.todosSig) {
    S.panel.todosSig = JSON.stringify(s.meta?.todos || []);
    drawTodos();
  }
  const meta = s.meta || {};
  const legacy = isLegacyClaude(s);
  // The models to choose from: what the computer offers, grouped by source; the
  // conversation's own list until that has arrived (an old hub has only that).
  let models;
  let sources;
  const cat = legacy ? null : catalogOf(s.machineId);
  if (legacy) models = meta.models || [];
  else if (cat) {
    models = allModels(cat);
    sources = menuSources(cat);
  } else {
    models = (meta.models || []).map((x) => ({ ...x, family: x.family || (x.deepseek ? 'deepseek' : 'kimi') }));
    const ds = models.filter((x) => x.family === 'deepseek');
    sources = ds.length ? menuSources({ sources: [{ id: 'kimi', billing: 'subscription', ready: true, models: models.filter((x) => x.family !== 'deepseek') }, { id: 'deepseek', billing: 'gateway', ready: true, models: ds }] }) : undefined;
  }
  const sub = s.subagent?.model || 'primary';
  const state = {
    agent: legacy ? 'claude' : 'kimi',
    family: familyOf(s),
    cost: legacy ? s.usage?.costUsd || 0 : null,
    budget: meta.budget || null,
    running: s.status === 'running',
    awaiting: s.status === 'awaiting_permission',
    queue: meta.queue || [],
    todos: meta.todos || [],
    models,
    sources,
    model: meta.model,
    defaultModel: meta.defaultModel,
    effort: meta.effort,
    permission: meta.permission,
    planMode: meta.planMode,
    turnModel: meta.turnModel,
    turnEffort: meta.turnEffort,
    servedModel: meta.servedModel || null,
    context: meta.context,
    skills: meta.skills || [],
    terminal: meta.owner === 'tui',
    controllable: Boolean(meta.controllable),
    autoPause: s.autoPause || null,
    scheduled: s.scheduled || [],
    subagent: !legacy && models.length ? { model: sub } : null,
    subagentLabel: subagentLabel(sub),
    subagentNote: subagentNote(sub, cat),
  };
  // Summaries arrive many times a second while Kimi works (speed, context);
  // redraw the controls only when something they show changed.
  const sig = JSON.stringify(state);
  if (S.cur.composerSig === sig) return;
  S.cur.composerSig = sig;
  composer.update(state);
}

function sidebarToggle() {
  const hidden = $app.classList.contains('no-sidebar');
  return h('button', { class: `om-btn om-btn--toolbar sidebar-toggle${hidden ? ' show' : ''}`, type: 'button', title: '顯示側欄', 'aria-label': '顯示側欄', onclick: () => toggleSidebar(true) }, icon('sidebar'));
}

function renderToolbar() {
  const s = S.cur?.summary;
  if (!s) {
    fill($toolbar, sidebarToggle(), h('div', { class: 'toolbar-titles' }, h('div', { class: 'om-toolbar__title' }, '新對話')));
    return;
  }
  const m = machineById(s.machineId);
  const sub = (isLegacyClaude(s) ? ['Claude API', s.meta?.machineName || hostName(), s.repo ? `${s.repo.full} · ${s.repo.branch}` : s.cwd ? shortPath(s.cwd, s.machineId ? m?.home : S.config?.home, 3) : null] : [familyOf(s) !== 'kimi' ? agentName(familyOf(s)) : null, m?.name || s.meta?.machineName, s.repo ? `${s.repo.full} · ${s.repo.branch}` : s.cwd ? shortPath(s.cwd, m?.home, 3) : null]).filter(Boolean).join(' · ');
  const arts = S.artifacts.length;
  fill(
    $toolbar,
    sidebarToggle(),
    h(
      'div',
      { class: 'toolbar-titles' },
      h('div', { class: 'om-toolbar__title', title: s.title }, s.title || '新對話'),
      h(
        'div',
        { class: 'om-toolbar__subtitle', title: s.cwd || '' },
        sub,
        m && !m.online ? h('span', { class: 'om-badge om-badge--danger' }, '電腦離線') : null,
        s.meta?.owner === 'tui' ? h('span', { class: 'om-badge', title: s.meta.controllable ? '在終端機的 Kimi 裡執行，可以從這裡操作' : '在終端機的 Kimi 裡執行，這裡只能看' }, s.meta.controllable ? '終端機' : '終端機 · 唯讀') : null,
        autoPauseBadge(s),
        isLegacyClaude(s) && s.meta?.budget ? h('button', { class: `om-badge${(s.usage?.costUsd || 0) >= s.meta.budget ? ' om-badge--warning' : ''}`, type: 'button', title: '這個對話的花費上限', onclick: budgetDialog }, `上限 ${fmtUsd(s.meta.budget)}`) : null,
      ),
    ),
    h('span', { class: 'om-toolbar__spacer' }),
    h('button', { class: `om-btn om-btn--toolbar wide${S.panel ? ' on' : ''}`, type: 'button', title: '面板：Artifact、變更、子代理、待辦', onclick: () => (S.panel ? hidePanel() : openPanel()) }, icon('panelRight'), h('span', { class: 'btn-label' }, '面板')),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '更多', 'aria-label': '更多', onclick: (e) => sessionMenu(e.currentTarget) }, icon('dots')),
  );
}

function sessionMenu(anchor) {
  const s = S.cur?.summary;
  if (!s) return;
  if (isLegacyClaude(s)) return claudeSessionMenu(s, anchor);
  openMenu(
    anchor,
    [
      { label: '重新命名…', onSelect: renameSession },
      { label: '複製成新對話', hint: '/fork', onSelect: () => sessionCommand('fork', '') },
      { label: '壓縮對話', hint: '/compact', onSelect: () => sessionCommand('compact', '') },
      isMetered(s) ? null : { label: '自動暫停…', hint: s.autoPause?.enabled ? `${s.autoPause.threshold}%` : '關', onSelect: autoPauseDialog },
      { label: '定時送出…', hint: s.scheduled?.length ? `${s.scheduled.length} 則` : '/later', onSelect: () => scheduleDialog() },
      backupItem(s),
      s.kimiSessionId
        ? s.repo
          ? { label: `GitHub：${s.repo.full}`, description: `分支 ${s.repo.branch}（已綁定）`, onSelect: () => window.open(s.repo.url, '_blank', 'noopener') }
          : { label: '綁定 GitHub repo…', description: '之後的程式碼都 commit 並 push 到那裡', onSelect: () => repoDialog(machineById(s.machineId) || { id: s.machineId, name: s.meta?.machineName || '那台電腦' }, s) }
        : null,
      { label: '複製資料夾路徑', onSelect: () => copyText(s.cwd || '').then(() => toast('已複製')) },
      { separator: true },
      { label: '刪除對話…', destructive: true, onSelect: () => deleteRow({ key: `${s.machineId}:${s.kimiSessionId}`, title: s.title }, s.machineId, s.kimiSessionId) },
    ].filter(Boolean),
    { align: 'end', width: 220 },
  );
}

function claudeSessionMenu(s, anchor) {
  openMenu(
    anchor,
    [
      { label: '重新命名…', onSelect: renameSession },
      { label: '複製成新對話', hint: '/fork', onSelect: () => sessionCommand('fork', '') },
      { label: '壓縮對話', hint: '/compact', onSelect: () => sessionCommand('compact', '') },
      { label: '撤回上一輪', hint: '/undo', onSelect: () => sessionCommand('undo', '') },
      { label: '用量與花費', hint: '/cost', onSelect: claudeCostDialog },
      { label: '花費上限…', hint: s.meta?.budget ? fmtUsd(s.meta.budget) : '關', onSelect: budgetDialog },
      { label: '定時送出…', hint: s.scheduled?.length ? `${s.scheduled.length} 則` : '/later', onSelect: () => scheduleDialog() },
      backupItem(s),
      s.repo
        ? { label: `GitHub：${s.repo.full}`, description: `分支 ${s.repo.branch}（已綁定）`, onSelect: () => window.open(s.repo.url, '_blank', 'noopener') }
        : { label: '綁定 GitHub repo…', description: '之後的程式碼都 commit 並 push 到那裡', onSelect: () => repoDialog(s.machineId ? machineById(s.machineId) || { id: s.machineId, name: s.meta?.machineName || '那台電腦' } : { id: null, name: hostName() }, s) },
      { label: '複製資料夾路徑', onSelect: () => copyText(s.cwd || '').then(() => toast('已複製')) },
      { separator: true },
      { label: '刪除對話…', destructive: true, onSelect: () => deleteClaude(s) },
    ],
    { align: 'end', width: 220 },
  );
}

// Where the files attached to a message are saved, on the conversation's
// computer: its folder's .agent-hub/attachments (default), the folder
// itself, or any folder picked there.
function uploadDirMenu(anchor, m, cwd, cur, set) {
  openMenu(
    anchor,
    [
      { label: '對話資料夾（預設）', description: '.agent-hub/attachments/時間/，不會進 git 和備份', checked: !cur, onSelect: () => set(null) },
      cwd ? { label: '對話資料夾本身', description: shortPath(cwd, m.home || S.config?.home, 4), checked: cur === cwd, onSelect: () => set(cwd) } : null,
      cur && cur !== cwd ? { label: baseName(cur), description: shortPath(cur, m.home || S.config?.home, 4), checked: true, onSelect: () => set(cur) } : null,
      { separator: true },
      { label: '選擇資料夾…', description: `「${m.name}」上的任何資料夾`, onSelect: () => browseFolders(m, (dir) => set(dir), cur || cwd || undefined) },
    ].filter(Boolean),
    { width: 300 },
  );
}

// /backup: the conversation's folder to Google Drive (server/gdrive.js).
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const backupItem = (s) => ({ label: '備份到 Google Drive', hint: '/backup', description: s.lastBackup ? `上次備份：${relTime(s.lastBackup.at)}` : '這個專案的資料夾，最新一份＋每日快照', onSelect: () => backupSession(s) });
let backingUp = false;
async function backupSession(s) {
  if (backingUp) return toast('正在備份中…');
  backingUp = true;
  toast('備份到 Google Drive 中…');
  try {
    const r = await post(`/sessions/${s.id}/backup`);
    toast(`已備份到 Google Drive：${r.files} 個檔案（${fmtBytes(r.bytes)}）→ ${r.dest}`);
  } catch (err) {
    if (err.status === 409) {
      fail(err);
      gdriveDialog();
    } else fail(err);
  } finally {
    backingUp = false;
  }
}

async function renameSession() {
  const s = S.cur?.summary;
  const title = await promptDialog({ title: '要把對話改成什麼名稱？', value: s.title, action: '重新命名' });
  if (title?.trim()) sessionCommand('title', title.trim());
}

async function sendMessage({ text, images, files, uploadDir, steer }, from) {
  const s = S.cur?.summary;
  if (!s) return;
  // What you send is what you want to see: back to the newest message.
  if (!from) S.cur.transcript.toEnd();
  try {
    await post(`/sessions/${s.id}/messages`, { text, images, files, uploadDir, from, steer: Boolean(steer) });
  } catch (err) {
    if (!from) composer.setText(text);
    fail(err);
  }
}

async function interrupt() {
  const s = S.cur?.summary;
  if (!s || !busy(s.status)) return;
  try {
    await post(`/sessions/${s.id}/interrupt`);
  } catch (err) {
    fail(err);
  }
}

async function configure(change) {
  const s = S.cur?.summary;
  if (!s) return;
  try {
    await post(`/sessions/${s.id}/config`, change);
    // The subagent model is on screen right away; the hub's own update follows.
    if (change.subagent && S.cur?.summary === s) {
      S.cur.summary = { ...s, subagent: { ...(s.subagent || {}), ...change.subagent } };
      S.sessions.set(s.id, S.cur.summary);
      updateComposer();
    }
    // The agent keeps the turn it is in on what it started with.
    if (busy(s.status) && (change.model || change.effort)) {
      const what = change.effort ? `思考強度改成「${EFFORT_LABELS[change.effort] || change.effort}」` : '模型已切換';
      toast(`${what}，從下一輪開始生效：${nameFor(s)} 每一輪開始時就固定模型和思考強度，正在進行的這一輪不變`);
    }
  } catch (err) {
    fail(err);
  }
}

async function respond(ev, optionId, extra = {}) {
  const s = S.cur?.summary;
  try {
    await post(`/sessions/${s.id}/permissions/${ev.id}`, { optionId, ...extra });
  } catch (err) {
    fail(err);
    throw err;
  }
}

async function sessionCommand(name, args) {
  const s = S.cur?.summary;
  if (!s) return;
  if (name === 'backup') return backupSession(s);
  if (name === 'steer') {
    try {
      const r = await post(`/sessions/${s.id}/queue/steer-all`);
      if (!r.count) return toast('沒有在排隊的訊息');
      // A turn the agent started itself (a background task finished) takes no
      // steer: the hub stops it at the next safe point and sends the messages again.
      if (r.waiting) return toast(`${nameFor(s)} 自己接續的回合不收插隊：${r.waiting} 則訊息會在下一個安全點接手，停下這一輪、重新送出（背景工作不受影響，也不會中斷正在跑的工具）`);
      return toast(`${r.count} 則訊息插隊：下一步一起讀到`);
    } catch (err) {
      return fail(err);
    }
  }
  if (isLegacyClaude(s)) return claudeCommand(s, name, args);
  const meta = s.meta || {};
  switch (name) {
    case 'model':
    case 'effort':
    case 'permission':
    case 'subagent':
      if (!composer.openControl(name)) toast('這個模型沒有提供這個選項');
      return;
    case 'plan':
      return configure({ planMode: !meta.planMode });
    case 'yolo':
    case 'auto':
    case 'manual':
      await configure({ permission: name });
      return toast(`權限模式：${PERMISSION_LABELS[name]}`);
    case 'new':
      S.home.machineId = s.machineId;
      S.home.cwdByMachine = { ...(S.home.cwdByMachine || {}), [s.machineId]: s.cwd };
      saveHome();
      return go('#/');
    case 'copy': {
      const last = S.cur.transcript.all().reverse().find((e) => e.type === 'text' && !e.parent && e.text?.trim());
      if (!last) return toast('還沒有回覆可以複製');
      await copyText(last.text);
      return toast(`已複製 ${nameFor(s)} 的回覆`);
    }
    case 'init':
      return sendMessage({ text: INIT_PROMPT, images: [] });
    case 'bg':
    case 'background':
      return moveToBackground();
    case 'usage':
      if (isMetered(s)) return toast(familyOf(s) === 'claude' ? 'Claude 對話不用 Kimi 訂閱，沒有方案額度。費用按用量從 Claude Console 帳戶扣款，請到 Claude Console 查看。' : 'DeepSeek 對話不用 Kimi 訂閱，沒有方案額度。費用算在閘道的帳戶，請到閘道的網站查看用量。');
      return accountDialog(s.machineId);
    case 'autopause': {
      if (isMetered(s)) return toast(`自動暫停看的是 Kimi 訂閱的 5 小時額度，${nameFor(s)} 對話不用它。要延後送出訊息，請用 /later 30 繼續。`, { kind: 'error' });
      const a = args.trim().toLowerCase().replace(/\s*%$/, '');
      if (!a) return autoPauseDialog();
      if (['off', '關', '關閉'].includes(a)) return setAutoPause({ enabled: false });
      if (['on', '開', '開啟'].includes(a)) return setAutoPause({ enabled: true });
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= 100) return setAutoPause({ enabled: true, threshold: n });
      return toast('用法：/autopause 90（用到 90% 暫停）、/autopause off，或只輸入 /autopause 打開設定', { kind: 'error' });
    }
    case 'later':
      return laterCommand(args);
    case 'status': {
      if (isMetered(s)) return meteredStatusDialog();
      const model = (meta.models || []).find((x) => x.id === meta.model);
      const ctx = meta.context;
      return accountDialog(s.machineId, [
        ['模型', model?.name || meta.model || 'Kimi 的預設模型'],
        meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
        ['子代理', subagentLabel(s.subagent?.model)],
        ['權限', `${PERMISSION_LABELS[meta.permission] || PERMISSION_LABELS.manual}${meta.planMode ? ' · 計畫模式' : ''}`],
        ctx?.size ? ['Context', `${Math.round((ctx.used / ctx.size) * 100)}% · ${fmtK(ctx.used)} / ${fmtK(ctx.size)} tokens`] : null,
        ['資料夾', s.cwd || '—'],
        meta.owner === 'tui' ? ['執行在', meta.controllable ? '終端機（kimi-hub，可操作）' : '終端機（唯讀）'] : null,
      ]);
    }
  }
  try {
    const r = await post(`/sessions/${s.id}/command`, { name, args });
    if (r.session) {
      S.sessions.set(r.session.id, r.session);
      toast('已複製成新對話', { action: '開啟', onAction: () => go(`#/s/${r.session.id}`) });
    } else if (name === 'undo') toast('已撤回上一輪');
    else if (name === 'goal') toast('已更新目標');
  } catch (err) {
    fail(err);
  }
}

// Slash commands in a Claude conversation. What the hub does on its own
// (compact, undo, fork, title, budget) goes to the server.
async function claudeCommand(s, name, args) {
  const meta = s.meta || {};
  switch (name) {
    case 'model':
    case 'effort':
    case 'permission':
      if (!composer.openControl(name)) toast('這個模型沒有提供這個選項');
      return;
    case 'plan':
      return configure({ planMode: !meta.planMode });
    case 'manual':
    case 'edits':
    case 'auto':
      await configure({ permission: name });
      return toast(`權限模式：${CLAUDE_PERMISSION_LABELS[name]}`);
    case 'new':
      // New conversations run in Kimi Code on a computer: the same computer
      // and folder, when this old one had one.
      if (s.machineId) {
        S.home.machineId = s.machineId;
        S.home.cwdByMachine = { ...(S.home.cwdByMachine || {}), [s.machineId]: s.cwd };
        saveHome();
      }
      return go('#/');
    case 'copy': {
      const last = S.cur.transcript.all().reverse().find((e) => e.type === 'text' && !e.parent && e.text?.trim());
      if (!last) return toast('還沒有回覆可以複製');
      await copyText(last.text);
      return toast('已複製 Claude 的回覆');
    }
    case 'init':
      return sendMessage({ text: CLAUDE_INIT_PROMPT, images: [] });
    case 'cost':
    case 'usage':
      return claudeCostDialog();
    case 'status':
      return claudeStatusDialog();
    case 'later':
      return laterCommand(args);
    case 'bg':
    case 'background':
      return toast('Claude 由中控台直接執行，沒有前景工作需要移到背景');
    case 'autopause':
      return toast('自動暫停看的是 Kimi 方案的 5 小時額度。Claude API 按用量計費，可以用 /budget 設定這個對話的花費上限。');
  }
  try {
    const r = await post(`/sessions/${s.id}/command`, { name, args });
    if (r.session) {
      S.sessions.set(r.session.id, r.session);
      renderSidebar();
      toast('已複製成新對話', { action: '開啟', onAction: () => go(`#/s/${r.session.id}`) });
    } else if (name === 'undo') toast('已撤回上一輪對話（檔案的修改不會還原）');
    else if (name === 'compact') toast('已壓縮對話');
    else if (name === 'budget') toast(/^(|off|關|關閉|0)$/i.test(String(args).trim()) ? '已關閉花費上限' : `花費上限：US$${String(args).trim().replace(/^us\$|^\$/i, '')}`);
  } catch (err) {
    fail(err);
  }
}

// --------------------------------------------------------------- panel

// Every draggable divider in one table: the CSS variable it drives, its
// default and its bounds. What gets dragged is kept in one localStorage
// entry holding only the dividers that were actually moved, so a new
// version can change a default without touching anyone's own layout.
const PANES = {
  panelW: {
    v: '--panel-w',
    def: () => Math.min(window.innerWidth * 0.32, 620),
    min: () => 320,
    max: () => window.innerWidth - ($app.classList.contains('no-sidebar') ? 0 : $sidebar.offsetWidth) - 360,
  },
  // 子代理: the list and the report can each go from just their header to
  // everything the steps leave (down to the steps' own header).
  agentListH: { v: '--agent-list-h', def: () => 230, min: () => agentBar(), max: () => agentRoom() - agentBar() - reportShown() },
  agentReportH: { v: '--agent-report-h', def: () => 240, min: () => agentBar(), max: () => agentRoom() - agentBar() - Math.min(rawPane('agentListH'), agentRoom()) },
};
// The 子代理 pane's height below its tabs, and one section header's.
const agentPane = () => $panel.querySelector('.panel-agents');
const agentBar = () => agentPane()?.querySelector('.agent-sec')?.offsetHeight || 28;
function agentRoom() {
  const el = agentPane();
  return el ? el.clientHeight - (el.querySelector('.panel-head')?.offsetHeight || 48) : $panel.offsetHeight - 48;
}
const reportShown = () => {
  const r = agentPane()?.querySelector('.agent-report');
  return r && !r.hidden ? Math.min(rawPane('agentReportH'), agentRoom()) : 0;
};

function savedPanes() {
  try {
    return JSON.parse(localStorage.getItem('hubLayout') || '{}');
  } catch {
    return {};
  }
}
// What was dragged, else the default. Raw, so bounds can use it without
// asking each other in circles.
const rawPane = (key) => Number(savedPanes()[key]) || PANES[key].def();
function pane(key) {
  const p = PANES[key];
  const lo = p.min();
  return Math.round(Math.min(Math.max(rawPane(key), lo), Math.max(lo, p.max())));
}
function applyPanes() {
  for (const [key, p] of Object.entries(PANES)) $panel.style.setProperty(p.v, `${pane(key)}px`);
}
// A size in px, or null to go back to the default.
function setPane(key, px) {
  const p = PANES[key];
  const next = { ...savedPanes() };
  if (px == null) delete next[key];
  else {
    const lo = p.min();
    next[key] = Math.round(Math.min(Math.max(px, lo), Math.max(lo, p.max())));
  }
  try {
    localStorage.setItem('hubLayout', JSON.stringify(next));
  } catch {}
  applyPanes();
}
// Sizes saved by the versions before this table.
try {
  if (!localStorage.getItem('hubLayout')) {
    const old = {};
    const w = Number(localStorage.getItem('hubPanelW'));
    if (w) old.panelW = w;
    const agents = JSON.parse(localStorage.getItem('hubAgentPanes') || 'null');
    if (agents?.list) old.agentListH = agents.list;
    if (agents?.report) old.agentReportH = agents.report;
    if (Object.keys(old).length) localStorage.setItem('hubLayout', JSON.stringify(old));
  }
} catch {}
applyPanes();
window.addEventListener('resize', applyPanes);

// Drag the panel's left edge to share the width with the conversation.
const $grip = h('div', { class: 'panel-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖曳調整寬度', tabindex: '0', title: '拖曳調整寬度，按兩下還原' });
$grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $grip.setPointerCapture(e.pointerId);
  $app.classList.add('resizing');
  let raf = 0;
  let x = e.clientX;
  const move = (ev) => {
    x = ev.clientX;
    raf ||= requestAnimationFrame(() => ((raf = 0), setPane('panelW', window.innerWidth - x)));
  };
  const up = () => {
    $app.classList.remove('resizing');
    $grip.removeEventListener('pointermove', move);
    $grip.removeEventListener('pointerup', up);
    $grip.removeEventListener('pointercancel', up);
  };
  $grip.addEventListener('pointermove', move);
  $grip.addEventListener('pointerup', up);
  $grip.addEventListener('pointercancel', up);
});
$grip.addEventListener('dblclick', () => setPane('panelW', null));
$grip.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  setPane('panelW', $panel.offsetWidth + (e.key === 'ArrowLeft' ? 32 : -32));
});

// A pane with nothing in it yet: the tabs stay, so the others are a click
// away.
function emptyPane(tab, text) {
  artifactView?.destroy();
  artifactView = null;
  closeAgentPanel();
  showPanel(tab);
  fill($panel, $grip, h('div', { class: 'panel-changes' }, panelHead(), h('div', { class: 'panel-body' }, h('div', { class: 'panel-empty' }, text))));
}

// The panel's default tab when opened from the toolbar: whatever is most
// useful right now. Every available pane shows as a tab in the head.
function openPanel() {
  if (S.artifacts.length) return showArtifact();
  if (S.cur?.transcript?.runningCount()) return showAgents();
  if (S.cur?.summary?.meta?.todos?.length) return showTodos();
  return showChanges();
}

function showPanel(tab) {
  S.panel = { ...(S.panel || {}), tab };
  $panel.hidden = false;
  $app.classList.add('with-panel');
  renderToolbar();
}

function hidePanel() {
  closeAgentPanel();
  S.panel = null;
  $panel.hidden = true;
  $app.classList.remove('with-panel');
  artifactView?.destroy();
  artifactView = null;
  fill($panel);
  renderToolbar();
  S.cur?.transcript && S.artifacts.length && S.cur.transcript.order.forEach((id) => S.cur.transcript.get(id)?.name && S.cur.transcript.markDirty(id));
}

function panelHead(...right) {
  const tab = S.panel?.tab;
  return h(
    'div',
    { class: 'panel-head' },
    h(
      'div',
      { class: 'om-seg om-seg--sm', role: 'group' },
      // Every pane is always listed, so the panel button brings them all
      // out; an empty one says so when opened.
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'artifact'), onclick: () => showArtifact() }, 'Artifact', S.artifacts.length > 1 ? h('span', { class: 'tab-count' }, String(S.artifacts.length)) : null),
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'changes'), onclick: showChanges }, '變更'),
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'agents'), onclick: () => showAgents() }, '子代理', S.cur?.transcript?.agentIds.length ? h('span', { class: 'tab-count' }, String(S.cur.transcript.agentIds.length)) : null),
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'todos'), onclick: showTodos }, '待辦'),
    ),
    h('span', { class: 'om-toolbar__spacer' }),
    ...right,
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '關閉', 'aria-label': '關閉面板', onclick: hidePanel }, icon('x')),
  );
}

// Artifact tab: the newest version of the chosen page, kept in sync while
// Kimi writes it.
function showArtifact(path, version) {
  if (!S.artifacts.length) return emptyPane('artifact', `${nameFor(S.cur?.summary)} 還沒有在這個對話裡做出頁面。它寫的 HTML 會顯示在這裡。`);
  const wasArtifact = S.panel?.tab === 'artifact';
  const art = S.artifacts.find((a) => a.path === (path || S.panel?.path)) || S.artifacts.at(-1);
  closeAgentPanel();
  showPanel('artifact');
  S.panel.path = art.path;
  S.panel.version = version && version !== art.versions.at(-1).id ? version : null;
  if (!artifactView) {
    artifactView = new ArtifactView({
      onSend: (text) => {
        sendMessage({ text, images: [] }, 'artifact');
        toast('已從 Artifact 送出訊息');
      },
      onFill: (text) => composer?.setText(text),
    });
  }
  if (!wasArtifact || !$panel.contains(artifactView.el)) {
    fill($panel, $grip, h('div', { class: 'panel-artifact' }, (S.panel.headEl = h('div')), artifactView.el));
  }
  drawArtifactHead();
  syncArtifact(true);
  S.cur?.transcript && markArtifactRows();
}

function markArtifactRows() {
  const t = S.cur.transcript;
  for (const a of S.artifacts) for (const v of a.versions) t.markDirty(v.id);
}

function drawArtifactHead() {
  if (S.panel?.tab !== 'artifact' || !S.panel.headEl) return;
  const art = S.artifacts.find((a) => a.path === S.panel.path);
  if (!art) return;
  const v = art.versions.find((x) => x.id === S.panel.version) || art.versions.at(-1);
  const idx = art.versions.indexOf(v);
  const step = (d) => {
    const next = art.versions[idx + d];
    if (!next) return;
    S.panel.version = idx + d === art.versions.length - 1 ? null : next.id;
    drawArtifactHead();
    syncArtifact(true);
  };
  const head = panelHead(
    art.versions.length > 1
      ? h(
          'div',
          { class: 'versions' },
          h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '上一版', 'aria-label': '上一版', disabled: idx === 0, onclick: () => step(-1) }, icon('back')),
          h('span', { class: 'versions-label' }, `${idx + 1}/${art.versions.length}`),
          h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '下一版', 'aria-label': '下一版', disabled: idx === art.versions.length - 1, onclick: () => step(1) }, icon('chev')),
        )
      : null,
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '重新載入', 'aria-label': '重新載入', onclick: () => syncArtifact(true, true) }, icon('refresh')),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '下載 HTML', 'aria-label': '下載 HTML', onclick: () => artifactView?.html && downloadHtml(artifactView.html, art.path) }, icon('download')),
    h('button', { class: 'om-btn om-btn--toolbar wide-only', type: 'button', title: '放大', 'aria-label': '放大面板', onclick: () => setPane('panelW', window.innerWidth) }, icon('expand')),
  );
  const titles = h(
    'div',
    { class: 'artifact-titles' },
    S.artifacts.length > 1
      ? h(
          'button',
          {
            class: 'artifact-pick',
            type: 'button',
            onclick: (e) => openMenu(e.currentTarget, S.artifacts.map((a) => ({ label: a.title, description: a.path, checked: a.path === art.path, onSelect: () => showArtifact(a.path) })), { width: 300 }),
          },
          h('span', null, htmlTitle(v.html, art.path)),
          icon('down', 'caret'),
        )
      : h('span', { class: 'artifact-name' }, htmlTitle(v.html, art.path)),
    h('span', { class: 'artifact-path' }, art.path),
  );
  fill(S.panel.headEl, head, titles);
}

// Push the selected version into the frame. Versions we can only read from
// disk (edits made before the hub saw the file) are fetched.
async function syncArtifact(force = false, reload = false) {
  if (S.panel?.tab !== 'artifact' || !artifactView) return;
  const art = S.artifacts.find((a) => a.path === S.panel.path);
  if (!art) return;
  const v = art.versions.find((x) => x.id === S.panel.version) || art.versions.at(-1);
  drawArtifactHead();
  if (v.html != null && !reload) return artifactView.show(v.html, { streaming: v.streaming });
  if (v.streaming) return artifactView.placeholder('正在產生頁面…');
  const isLatest = v === art.versions.at(-1);
  if (!isLatest) return artifactView.placeholder('沒辦法顯示這個版本');
  if (!force && artifactView.loadedFrom === v.id) return;
  artifactView.loadedFrom = v.id;
  try {
    const cwd = S.cur.summary.cwd;
    const rel = cwd && art.path.startsWith(`${cwd}/`) ? art.path.slice(cwd.length + 1) : art.path;
    const f = await get(`/sessions/${S.cur.id}/file?path=${encodeURIComponent(rel)}`);
    if (f.content != null) artifactView.show(f.content);
  } catch (err) {
    artifactView.placeholder(`沒辦法讀取 ${art.path}：${err.message}`);
  }
}

// Pages opened from a link in the conversation (not written in the loaded
// turns) join the conversation's artifacts.
function withOpened(list) {
  const extra = (S.cur?.opened || []).filter((x) => !list.some((a) => a.path === x.path));
  return [...list, ...extra];
}

// A link in Kimi's reply to an .html file on the machine: show it in the
// Artifact panel. Relative links are tried against the conversation's
// folder and the folders of the pages already known.
function openFileLink(href) {
  if (!S.cur || !href || /^(https?|mailto|data|javascript):/i.test(href) || href.startsWith('#')) return false;
  let p = href.replace(/^file:\/\//i, '').replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {}
  if (!/\.html?$/i.test(p)) return false;
  const rel = p.replace(/^\.\//, '');
  const known = S.artifacts.find((a) => a.path === p || a.path.endsWith(`/${rel}`));
  if (known) {
    showArtifact(known.path);
    return true;
  }
  const absolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const dirs = [S.cur.summary?.cwd, ...S.artifacts.map((a) => a.path.replace(/\/[^/]*$/, ''))].filter(Boolean);
  const candidates = absolute ? [p] : [...new Set(dirs.map((d) => `${d}/${rel}`))];
  (async () => {
    for (const c of candidates) {
      try {
        const f = await get(`/sessions/${S.cur.id}/file?path=${encodeURIComponent(c)}`);
        if (f.content == null) continue;
        const art = { path: c, versions: [{ id: `file:${c}`, html: f.content }], title: htmlTitle(f.content, c), updated: `file:${c}` };
        S.cur.opened = [...(S.cur.opened || []).filter((x) => x.path !== c), art];
        S.artifacts = withOpened(S.artifacts.filter((a) => a.path !== c));
        renderToolbar();
        showArtifact(c);
        return;
      } catch {}
    }
    toast(`找不到 ${rel}`, { kind: 'error' });
  })();
  return true;
}

// 子代理 tab: every subagent of the conversation, and the steps of the
// chosen one, live while it works.
let agentPanel = null; // { id, transcript, list, summary, ids:Set, sig }

function closeAgentPanel() {
  agentPanel?.transcript.destroy();
  agentPanel = null;
}

function showAgents(id) {
  const t = S.cur?.transcript;
  if (!t) return;
  const all = t.agentList();
  if (!all.length) return emptyPane('agents', '這個對話還沒有用到子代理。');
  const pick = id || agentPanel?.id || all.findLast((a) => a.running)?.id || all.at(-1).id;
  artifactView?.destroy();
  artifactView = null;
  closeAgentPanel();
  showPanel('agents');
  const steps = new Transcript({ cwd: S.cur.summary?.cwd, agentName: nameFor(S.cur.summary), subagentInfo, onRespond: respond, onImage: lightbox, onLink: openFileLink });
  const section = (label, ...right) => h('div', { class: 'agent-sec' }, h('span', { class: 'agent-sec-label' }, label), h('span', { class: 'om-toolbar__spacer' }), ...right);
  applyPanes();
  agentPanel = {
    id: pick,
    transcript: steps,
    list: h('div', { class: 'agent-list' }),
    summary: h('div', { class: 'agent-report-body' }),
    count: h('span', { class: 'agent-sec-count' }),
    stepsLabel: h('span', { class: 'agent-sec-sub' }),
    ids: new Set([pick]),
    sig: '',
  };
  const evs = t.descendants(pick);
  for (const e of evs) agentPanel.ids.add(e.id);
  steps.load(evs.map((e) => ({ ...e, parent: e.parent === pick ? undefined : e.parent })));
  steps.setStatus(t.agentList().find((a) => a.id === pick)?.running ? 'running' : 'idle');
  const stepsBar = section('步驟', agentPanel.stepsLabel);
  const reportBar = section('子代理回報');
  agentSplit(stepsBar, 'agentListH', 1);
  agentSplit(reportBar, 'agentReportH', -1);
  agentPanel.report = h('div', { class: 'agent-report' }, reportBar, agentPanel.summary);
  fill(
    $panel,
    $grip,
    h(
      'div',
      { class: 'panel-agents' },
      panelHead(),
      h('div', { class: 'agent-pane agent-top' }, section('子代理', agentPanel.count), agentPanel.list),
      h('div', { class: 'agent-pane agent-steps' }, stepsBar, steps.el),
      agentPanel.report,
    ),
  );
  drawAgentList();
}

// The 子代理 panes: the list is short (about three subagents) and the
// steps take the rest. The 步驟 and 子代理回報 bars double as splitters,
// so the shares can be dragged; double-click resets one.
// A section bar that doubles as a horizontal splitter for the pane above
// it (`grow` 1) or below it (-1).
function agentSplit(bar, key, grow) {
  bar.classList.add('agent-sec--grip');
  bar.title = '拖曳調整高度，按兩下還原';
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const from = pane(key);
    let raf = 0;
    let y = startY;
    const move = (ev) => {
      y = ev.clientY;
      raf ||= requestAnimationFrame(() => ((raf = 0), setPane(key, from + (y - startY) * grow)));
    };
    const up = () => {
      cancelAnimationFrame(raf);
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
  bar.addEventListener('dblclick', () => setPane(key, null));
}

// Rows are built once per subagent and then only have their text updated
// (the list is drawn several times a second while they work); rebuilding
// them would also restart their spinners.
function drawAgentList() {
  if (!agentPanel || !S.cur) return;
  const all = S.cur.transcript.agentList();
  const status = (a) => (a.running ? h('span', { class: 'spinner', 'aria-label': '執行中' }) : a.failed ? h('span', { class: 'om-badge om-badge--danger' }, '失敗') : a.stopped ? h('span', { class: 'om-badge' }, '已中斷') : h('span', { class: 'om-badge om-badge--success' }, '完成'));
  const rows = (agentPanel.rows ??= new Map());
  const els = [...all].reverse().map((a) => {
    const shape = JSON.stringify([a.id === agentPanel.id, a.name, a.background, a.info, a.running, a.failed, a.stopped]);
    let r = rows.get(a.id);
    if (r?.shape !== shape) {
      const desc = h('span', { class: 'agent-item-desc' });
      const meta = h('span', { class: 'agent-item-meta' });
      const el = h(
        'button',
        { class: `agent-item${a.id === agentPanel.id ? ' on' : ''}`, type: 'button', onclick: () => a.id !== agentPanel.id && showAgents(a.id) },
        icon('agents'),
        h('span', { class: 'agent-item-text' }, h('span', { class: 'agent-item-name' }, a.name ? `子代理 · ${a.name}` : '子代理', a.background ? h('span', { class: 'om-badge' }, '背景') : null), a.info ? h('span', { class: 'agent-item-model' }, a.info.text, a.info.primary ? h('span', { class: 'agent-model-tag' }, '跟主模型') : null) : null, desc),
        meta,
        status(a),
      );
      r = { shape, el, desc, meta };
      rows.set(a.id, r);
    }
    const d = a.running && a.activity ? `${a.description} · ${a.activity}` : a.description;
    if (r.desc.textContent !== d) r.desc.textContent = d;
    const m = a.steps ? `${a.steps} 步` : '';
    if (r.meta.textContent !== m) r.meta.textContent = m;
    r.meta.hidden = !a.steps;
    return r.el;
  });
  const list = agentPanel.list;
  if (els.length !== list.children.length || els.some((el, i) => list.children[i] !== el)) list.replaceChildren(...els);
  const cur = all.find((a) => a.id === agentPanel.id);
  agentPanel.transcript.setStatus(cur?.running ? 'running' : 'idle');
  const working = all.filter((a) => a.running).length;
  agentPanel.count.textContent = [all.length > 1 ? `${all.length} 個` : '', working ? `${working} 個在工作` : ''].filter(Boolean).join(' · ');
  const label = cur ? JSON.stringify([cur.name, cur.description, cur.running]) : '';
  if (agentPanel.labelKey !== label) {
    agentPanel.labelKey = label;
    fill(agentPanel.stepsLabel, cur ? [cur.name ? `${cur.name} · ` : '', cur.description || '', cur.running ? h('span', { class: 'spinner' }) : null] : null);
  }
  if (agentPanel.summaryText !== (cur?.summary || '')) {
    agentPanel.summaryText = cur?.summary || '';
    fill(agentPanel.summary, cur?.summary ? renderMarkdown(cur.summary) : null);
  }
  if (agentPanel.report.hidden !== !cur?.summary) {
    agentPanel.report.hidden = !cur?.summary;
    applyPanes(); // the list may now have more room, or less
  }
}

// New steps of the chosen subagent, as the conversation updates.
function syncAgentPanel(ids) {
  if (!agentPanel || S.panel?.tab !== 'agents' || !S.cur) return;
  const t = S.cur.transcript;
  for (const id of ids) {
    const e = t.get(id);
    if (!e?.parent || !agentPanel.ids.has(e.parent)) continue;
    agentPanel.ids.add(id);
    agentPanel.transcript.add({ ...e, parent: e.parent === agentPanel.id ? undefined : e.parent });
  }
  // The list (each one's latest step) a few times a second is plenty.
  agentPanel.listTimer ??= setTimeout(() => {
    if (agentPanel) agentPanel.listTimer = null;
    drawAgentList();
  }, 200);
}

// 待辦 tab: the conversation's whole todo list.
function showTodos() {
  if (!S.cur) return;
  artifactView?.destroy();
  artifactView = null;
  closeAgentPanel();
  showPanel('todos');
  drawTodos();
}

function drawTodos() {
  if (S.panel?.tab !== 'todos' || !S.cur) return;
  const todos = S.cur.summary?.meta?.todos || [];
  const done = todos.filter((t) => t.status === 'done' || t.status === 'completed').length;
  fill(
    $panel,
    $grip,
    h(
      'div',
      { class: 'panel-todos' },
      panelHead(),
      h(
        'div',
        { class: 'panel-body' },
        todos.length
          ? [h('div', { class: 'todo-sum' }, h('span', { class: 'todo-progress' }, `${done}/${todos.length} 完成`), h('div', { class: 'quota-bar' }, h('span', { style: { width: `${Math.round((done / todos.length) * 100)}%` } }))), todoList(todos)]
          : h('div', { class: 'panel-empty' }, `${nameFor(S.cur?.summary)} 還沒有列待辦。`),
      ),
    ),
  );
}

async function showChanges() {
  const s = S.cur?.summary;
  if (!s) return;
  showPanel('changes');
  closeAgentPanel();
  artifactView?.destroy();
  artifactView = null;
  const body = h('div', { class: 'panel-body' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), '正在讀取變更…'));
  const refresh = h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '重新整理', 'aria-label': '重新整理', onclick: showChanges }, icon('refresh'));
  fill($panel, $grip, h('div', { class: 'panel-changes' }, panelHead(refresh), body));
  try {
    const r = await get(`/sessions/${s.id}/changes`);
    if (S.panel?.tab !== 'changes') return;
    if (!r.git) return fill(body, h('div', { class: 'panel-empty' }, '這個資料夾不是 git 專案，沒辦法列出變更。'));
    const files = parseUnifiedDiff(r.diff);
    if (!files.length) return fill(body, h('div', { class: 'panel-empty' }, r.branch ? `${r.branch} 上沒有未提交的變更。` : '沒有未提交的變更。'));
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const tree = changesTreeView();
    const toggle = h(
      'div',
      { class: 'om-seg om-seg--sm', role: 'group', 'aria-label': '檢視方式' },
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(!tree), onclick: () => setChangesTreeView(false) }, '清單'),
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tree), onclick: () => setChangesTreeView(true) }, '樹狀'),
    );
    fill(
      body,
      h('div', { class: 'changes-sum' }, `${files.length} 個檔案`, h('span', { class: 'plus' }, ` +${added}`), h('span', { class: 'minus' }, ` −${removed}`), r.branch ? h('span', { class: 'muted' }, ` · ${r.branch}`) : null, toggle),
      tree ? changesTree(files) : h('div', { class: 'changes-flat' }, ...files.map((f) => changeDetails(f, files.length <= 6))),
    );
  } catch (err) {
    fill(body, h('div', { class: 'panel-empty' }, err.message));
  }
}

// One changed file, expandable to its diff.
function changeDetails(f, open) {
  const d = h('details', { class: 'change', open });
  d.append(
    h(
      'summary',
      null,
      icon('chev', 'chev'),
      h('span', { class: 'change-path' }, f.path),
      f.status === 'added' ? h('span', { class: 'om-badge om-badge--success' }, '新增') : f.status === 'deleted' ? h('span', { class: 'om-badge om-badge--danger' }, '刪除') : null,
      h('span', { class: 'change-stat' }, h('span', { class: 'plus' }, `+${f.added}`), h('span', { class: 'minus' }, ` −${f.removed}`)),
    ),
    renderHunks(f.lines),
  );
  return d;
}

const changesTreeView = () => {
  try {
    return localStorage.getItem('hubChangesTree') === '1';
  } catch {
    return false;
  }
};
function setChangesTreeView(on) {
  try {
    localStorage.setItem('hubChangesTree', on ? '1' : '');
  } catch {}
  showChanges();
}

// The changed files as a folder tree: directories collapse, leaves are the
// file rows (each expandable to its diff). Folders with a single child fold
// into one row (a/b/c), like a file explorer.
function changesTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ ...f, name });
  }
  const wrap = h('div', { class: 'change-tree' });
  const sumOf = (node) => {
    let a = 0;
    let r = 0;
    for (const f of node.files) (a += f.added), (r += f.removed);
    for (const [, c] of node.dirs) {
      const s = sumOf(c);
      a += s.a;
      r += s.r;
    }
    return { a, r };
  };
  const build = (node, depth, into) => {
    const dirs = [...node.dirs.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    for (let [label, child] of dirs) {
      // Fold a chain of single-child directories into one row.
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [cn, cc] = [...child.dirs.entries()][0];
        label = `${label}/${cn}`;
        child = cc;
      }
      const d = h('details', { class: 'change-dir', open: depth < 1 });
      const s = sumOf(child);
      d.append(
        h(
          'summary',
          { style: { paddingLeft: `${depth * 14}px` } },
          icon('chev', 'chev'),
          icon('folder'),
          h('span', { class: 'change-dir-name' }, label),
          h('span', { class: 'change-stat' }, s.a ? h('span', { class: 'plus' }, `+${s.a}`) : null, s.r ? h('span', { class: 'minus' }, ` −${s.r}`) : null),
        ),
      );
      const kids = h('div');
      build(child, depth + 1, kids);
      d.append(kids);
      into.append(d);
    }
    for (const f of node.files.sort((x, y) => x.name.localeCompare(y.name))) {
      const d = changeDetails(f, false);
      d.classList.add('in-tree');
      d.querySelector('.change-path').textContent = f.name;
      d.querySelector('summary').style.paddingLeft = `${depth * 14}px`;
      into.append(d);
    }
  };
  build(root, 0, wrap);
  return wrap;
}

// ------------------------------------------------------------- dialogs

let dialogClose = null;

function dialog(content, { wide = false, onClose } = {}) {
  dialogClose?.();
  const box = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'om dialog-back', onclick: (e) => e.target === back && close() }, box);
  const prevFocus = document.activeElement;
  function close() {
    back.remove();
    dialogClose = null;
    onClose?.();
    prevFocus?.focus?.();
  }
  dialogClose = close;
  document.body.append(back);
  setTimeout(() => box.querySelector('[autofocus], input, .om-btn--primary')?.focus(), 0);
  return { box, close };
}

function confirmDialog({ title, body, action, destructive }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const d = dialog(
      h(
        'div',
        { class: 'alert' },
        h('div', { class: 'om-alert__title' }, title),
        body ? h('p', { class: 'om-alert__body' }, body) : null,
        h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => finish(false) }, '取消'), h('button', { class: `om-btn ${destructive ? 'om-btn--destructive' : 'om-btn--primary'}`, type: 'button', autofocus: true, onclick: () => finish(true) }, action)),
      ),
      { onClose: () => finish(false) },
    );
  });
}

function promptDialog({ title, value = '', action }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'om-input', type: 'text', value, autofocus: true });
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const form = h(
      'form',
      { class: 'alert', onsubmit: (e) => (e.preventDefault(), finish(input.value)) },
      h('div', { class: 'om-alert__title' }, title),
      input,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => finish(null) }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, action)),
    );
    const d = dialog(form, { onClose: () => finish(null) });
    setTimeout(() => input.select(), 0);
  });
}

let machinesDialog = null;

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n || 0));

// /usage and /status: the plan quota of the Kimi account on that machine,
// plus (for /status) the conversation's own settings.
const QUOTA_WINDOWS = { limit5h: '5 小時', limit7d: '7 天', monthTotal: '本月總額度', monthCode: '本月 Code 額度' };
// To the minute, like Kimi's /usage ("2 小時 13 分後重置").
const resetIn = (t) => {
  const ms = Date.parse(t) - Date.now();
  if (!Number.isFinite(ms)) return '';
  return ms > 0 ? `${fmtCountdown(ms)}後重置` : '已重置';
};

// The plan's quota windows, as Kimi reports them. `only` picks which.
function quotaBars(quota, only) {
  return Object.entries(quota?.usages || {})
    .filter(([k, v]) => v && typeof v.usedRatio === 'number' && (!only || only.includes(k)))
    .sort(([a], [b]) => (only ? only.indexOf(a) - only.indexOf(b) : 0))
    .map(([k, v]) => {
      const pct = Math.round(Math.min(1, v.usedRatio) * 100);
      // Corrected by the hub from the counts Kimi sent along (server/quota.js).
      const why = v.counted
        ? `Kimi 回報的百分比是 ${v.reported == null ? '（沒有）' : `${Math.round(v.reported * 100)}%`}，同一份回應裡的次數卻是已用 ${v.counted.used} / ${v.counted.limit}：這是 Kimi 官方已知的問題，這裡以次數為準`
        : undefined;
      return h(
        'div',
        { class: 'quota', title: why },
        h('div', { class: 'quota-head' }, h('span', null, QUOTA_WINDOWS[k] || k), h('span', { class: 'muted' }, `已用 ${pct}%`)),
        h('div', { class: `quota-bar${pct >= 90 ? ' danger' : pct >= 75 ? ' warning' : ''}` }, h('span', { style: { width: `${pct}%` } })),
        // A line of its own: squeezed next to the share, it broke apart.
        v.resetAt ? h('div', { class: 'quota-reset muted' }, resetIn(v.resetAt)) : null,
      );
    });
}

// Shared by the context menu and 用量; a minute of cache keeps the menu
// from asking the machine on every click.
const usageCache = new Map();
function fetchUsage(machineId) {
  const c = usageCache.get(machineId);
  if (c && Date.now() - c.at < 60_000) return c.p;
  const p = get(`/machines/${machineId}/usage`).catch((err) => ({ usage: { kind: 'error', message: err.message } }));
  usageCache.set(machineId, { at: Date.now(), p });
  return p;
}

// The 5-hour and 7-day quota under the context ring's menu (for Claude:
// what the conversation has cost, and the API's rate limits).
function quotaMenuNode() {
  if (isLegacyClaude(S.cur?.summary)) return claudeCostNode();
  // DeepSeek and Claude are billed by their own keys, not against the Kimi plan.
  if (S.cur?.summary && isMetered(S.cur.summary)) return null;
  const mid = S.cur?.summary?.machineId;
  if (!mid) return null;
  const box = h('div', { class: 'menu-quota' }, h('div', { class: 'muted' }, '讀取方案用量…'));
  fetchUsage(mid).then((data) => {
    const u = data.usage;
    const bars = u?.kind === 'ok' ? quotaBars(u.quota, ['limit5h', 'limit7d']) : [];
    if (bars.length) return fill(box, ...bars);
    const msg = u?.kind === 'error' ? (/no token|login/i.test(u.message || '') ? '這台電腦的 Kimi 沒有用 Kimi 帳號登入' : '讀不到方案用量') : '這個帳號沒有方案額度';
    fill(box, h('div', { class: 'muted' }, msg));
  });
  return box;
}

async function accountDialog(machineId, rows = null) {
  const m = machineById(machineId);
  const body = h('div', { class: 'account' }, h('div', { class: 'dialog-title' }, rows ? '狀態' : '用量'), h('div', { class: 'muted' }, '讀取中…'));
  const d = dialog(body);
  usageCache.delete(machineId); // this dialog is where someone checks on purpose
  const data = await fetchUsage(machineId);
  const u = data.usage;
  const quota = u?.kind === 'ok' ? u.quota : null;
  const bars = quotaBars(quota);
  const wins = Object.values(quota?.usages || {}).filter((v) => v && typeof v.usedRatio === 'number');
  // Kimi's ratios are known to stick at 0 (MoonshotAI/kimi-code#3817,
  // #3908, #4133): say what is shown instead, or where to check.
  const note = wins.some((v) => v.counted)
    ? 'Kimi 回報的百分比和同一份回應裡的已用次數對不上（官方已知的問題，常卡在 0%；Kimi 終端機的 /usage 和網頁版顯示的就是那個百分比），這裡以次數為準。'
    : wins.length && !u?.counts && wins.every((v) => v.usedRatio === 0)
      ? '如果這段時間確實有在用、這裡卻是 0%：這是 Kimi 官方已知的問題（回報的百分比卡在 0%），Kimi 這次也沒有附上次數可以換算，請以 Kimi 網站會員頁的數字為準。'
      : null;
  const x = quota?.extraUsage;
  const money = (c) => `${(c / 100).toFixed(2)} ${x?.currency || ''}`.trim();
  const info = [
    ...(rows || []).filter(Boolean),
    data.user ? ['帳號', [data.user.nickname, data.user.userLevelName].filter(Boolean).join(' · ')] : null,
    m ? ['電腦', `${m.name}${m.kimi?.version ? ` · Kimi Code ${m.kimi.version}` : ''}`] : null,
    x ? ['加購額度', `餘額 ${money(x.balanceCents)}${x.monthlyUsedCents ? ` · 本月用了 ${money(x.monthlyUsedCents)}` : ''}`] : null,
  ].filter(Boolean);
  fill(
    body,
    h('div', { class: 'dialog-title' }, rows ? '狀態' : '用量'),
    bars.length ? h('div', { class: 'quotas' }, bars) : h('p', { class: 'dialog-text muted' }, u?.kind === 'error' ? (/no token|login/i.test(u.message || '') ? '這台電腦的 Kimi 沒有用 Kimi 帳號登入，看不到方案用量。在那台電腦執行 kimi login。' : `讀不到方案用量：${u.message}`) : '這個帳號沒有方案額度資訊（例如用 API key 而不是 Kimi 帳號登入）。'),
    note ? h('p', { class: 'quota-note muted' }, note) : null,
    info.length ? h('dl', { class: 'kv' }, info.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
  );
}

// ----------------------------------------------------------- Claude API

const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';
const CONSOLE_BILLING = 'https://console.anthropic.com/settings/billing';

// Claude API 設定: the Console API key (sent here once, never shown again in
// full). With it, Claude models run in the Kimi Code on a computer, as the main
// model of a conversation or as a subagent's model. Which model a new
// conversation starts with is in 設定.
async function claudeDialog() {
  let acc = S.claude || {};
  try {
    acc = S.claude = await get('/claude');
  } catch {}
  const form = h('form', { class: 'settings claude-settings' });
  const keyInput = h('input', { class: 'om-input', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: acc.hasKey ? '貼上新的 key 來更換' : 'sk-ant-…', 'aria-label': 'Claude API key' });
  const keyNote = h('span', { class: 'om-field__help' });
  const testOut = h('div', { class: 'claude-test', role: 'status' });
  const drawKey = () => {
    fill(
      keyNote,
      acc.hasKey
        ? acc.keySource === 'env'
          ? `目前用的是環境變數 ANTHROPIC_API_KEY（${acc.keyHint}）。在這裡貼上 key 會改用這把。`
          : `已設定：${acc.keyHint}。key 只存在這台中控台，不會再傳回瀏覽器。`
        : '還沒有設定。',
    );
  };
  drawKey();
  const web = h('input', { class: 'om-switch', type: 'checkbox', checked: acc.webTools !== false });
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? (typeof help === 'string' ? h('span', { class: 'om-field__help' }, help) : help) : null);
  const test = async () => {
    fill(testOut, h('span', { class: 'spinner' }), ' 連線中…');
    testOut.className = 'claude-test';
    try {
      const r = await post('/claude/test');
      testOut.className = `claude-test ${r.ok ? 'ok' : 'bad'}`;
      fill(testOut, r.message);
      if (r.ok) refreshCatalogs();
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
    }
  };
  const removeKey = async () => {
    if (!(await confirmDialog({ title: '要移除這把 API key 嗎？', body: '移除後，Claude 模型要等你再設定一把 key 才能用（正在用它的對話也一樣）。這不會撤銷 key 本身，要撤銷請到 Claude Console。', action: '移除', destructive: true }))) return;
    try {
      acc = S.claude = await put('/claude', { clearKey: true });
      drawKey();
      fill(testOut);
      refreshCatalogs();
      toast('已移除 API key');
    } catch (err) {
      fail(err);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    fill(testOut, key ? [h('span', { class: 'spinner' }), ' 向 Anthropic 確認這把 key…'] : null);
    testOut.className = 'claude-test';
    try {
      acc = S.claude = await put('/claude', { apiKey: key || undefined, webTools: web.checked });
      refreshCatalogs();
      d.close();
      toast(key ? '已設定 Claude API key' : '已儲存 Claude 設定');
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
    }
  };
  fill(
    form,
    h('div', { class: 'dialog-title' }, 'Claude API'),
    h(
      'p',
      { class: 'dialog-text settings-lead' },
      'Claude 模型用你在 Claude Console 建立的 API key，在你電腦的 Kimi Code 裡執行（api.anthropic.com），依用量（token）從 Console 帳戶的額度扣款。任何對話都可以用 Claude 當主模型，也可以只讓子代理用 Claude。不會用到 Claude Pro／Max 訂閱；訂閱帳號的登入 token（sk-ant-oat…）會被拒絕。',
    ),
    field('API key', keyInput, keyNote),
    h(
      'div',
      { class: 'claude-key-actions' },
      h('a', { class: 'om-btn om-btn--sm', href: CONSOLE_KEYS, target: '_blank', rel: 'noopener' }, '到 Claude Console 建立 key'),
      acc.hasKey ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: test }, '測試連線') : null,
      acc.hasKey && acc.keySource === 'hub' ? h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', onclick: removeKey }, '移除 key') : null,
    ),
    testOut,
    h('label', { class: 'settings-switch' }, web, h('span', null, h('span', { class: 'om-field__label' }, '網路搜尋與讀取網頁'), h('span', { class: 'om-field__help' }, '只對早期以 Claude API 直接執行的對話有效；Anthropic 端執行，搜尋每 1000 次 US$10 另計'))),
    h('p', { class: 'om-field__help' }, '新對話預設用哪個模型、思考強度與權限，在「設定」裡選。'),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  form.addEventListener('submit', save);
  const d = dialog(form);
  if (!acc.hasKey) setTimeout(() => keyInput.focus(), 0);
}

// ------------------------------------------------------------- DeepSeek

// DeepSeek 設定: which gateway the DeepSeek models come from, and its API key
// (sent here once, never shown again in full). With a key, DeepSeek models run
// in the Kimi Code on a computer, as the main model of a conversation or as a
// subagent's model. Which model a new conversation starts with is in 設定.
async function deepseekDialog() {
  let acc = S.deepseek || { gateways: [] };
  try {
    acc = S.deepseek = await get('/deepseek');
  } catch {}
  let gw = acc.gateway;
  const form = h('form', { class: 'settings deepseek-settings' });
  const keyInput = h('input', { class: 'om-input', type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': 'DeepSeek 閘道的 API key' });
  const keyNote = h('span', { class: 'om-field__help' });
  const keyActions = h('div', { class: 'claude-key-actions' });
  const testOut = h('div', { class: 'claude-test', role: 'status' });
  const gwBox = h('div', { class: 'gw-list', role: 'radiogroup', 'aria-label': '閘道' });
  const secondaryBox = h('div', { class: 'callout small ds-secondary', hidden: true });
  const gwNote = h('p', { class: 'om-field__help ds-note' });
  const GATEWAY_NOTES = {
    'opencode-go': 'OpenCode Go 訂閱。OpenCode 把 Kimi Code 列為沒有送 session 標頭、可能被限流的用戶端，所以中控台會替那台電腦 Kimi 裡的 DeepSeek 模型來源加上固定的 x-opencode-session 標頭。',
    opencode: 'OpenCode 按量計費（原本的 Zen）。',
    commandcode: 'Command Code 要有含 API 存取的方案（Provider／GOAT／Pro／Max／Team）；Go 方案不含 API。',
  };
  const SWITCH_NOTE = '換閘道之後，舊的 DeepSeek 對話要在輸入框重新選一次模型。';
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? (typeof help === 'string' ? h('span', { class: 'om-field__help' }, help) : help) : null);
  const cur = () => (acc.gateways || []).find((g) => g.id === gw) || { id: gw, label: gw };

  const drawGateways = () => {
    gwNote.textContent = `${GATEWAY_NOTES[gw] || ''}${gw !== acc.gateway ? SWITCH_NOTE : ''}`;
    return fill(
      gwBox,
      ...(acc.gateways || []).map((g) =>
        h(
          'label',
          { class: `gw-item${g.id === gw ? ' on' : ''}` },
          h('input', { type: 'radio', name: 'gateway', value: g.id, checked: g.id === gw, onchange: () => ((gw = g.id), drawGateways(), drawKey(), fill(testOut)) }),
          h('span', { class: 'gw-name' }, g.label),
          h('span', { class: 'gw-state' }, g.hasKey ? `已設定 …${g.keyHint}` : '還沒有 key'),
        ),
      ),
    );
  };
  const drawKey = () => {
    const g = cur();
    keyInput.placeholder = g.hasKey ? '貼上新的 key 來更換' : `貼上 ${g.label} 的 API key`;
    fill(keyNote, g.hasKey ? `已設定：…${g.keyHint}。key 只存在這台中控台，不會再傳回瀏覽器。` : '這個閘道還沒有 key。');
    fill(keyActions, g.site ? h('a', { class: 'om-btn om-btn--sm', href: g.site, target: '_blank', rel: 'noopener' }, `到 ${g.label} 取得 key`) : null, g.hasKey ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: test }, '測試連線') : null, g.hasKey ? h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', onclick: removeKey }, '移除 key') : null);
  };
  const test = async () => {
    fill(testOut, h('span', { class: 'spinner' }), ' 連線中…');
    testOut.className = 'claude-test';
    try {
      const r = await post('/deepseek/test', { gateway: gw });
      testOut.className = `claude-test ${r.ok ? 'ok' : 'bad'}`;
      fill(testOut, r.message);
      if (r.ok) refreshCatalogs();
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
    }
  };
  const removeKey = async () => {
    if (!(await confirmDialog({ title: `要移除 ${cur().label} 的 API key 嗎？`, body: '移除後，DeepSeek 模型要等你再設定一把 key 才能用（正在用它的對話也一樣）。連接的電腦上 Kimi 裡的 DeepSeek 模型來源（含這把 key）也會一併移除。這不會撤銷 key 本身，要撤銷請到閘道的網站。', action: '移除', destructive: true }))) return;
    try {
      acc = S.deepseek = await put('/deepseek', { gateway: gw, clearKey: true });
      drawGateways();
      drawKey();
      fill(testOut);
      refreshCatalogs();
      toast('已移除 API key');
    } catch (err) {
      fail(err);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    fill(testOut, key ? [h('span', { class: 'spinner' }), ` 向 ${cur().label} 確認這把 key…`] : null);
    testOut.className = 'claude-test';
    try {
      acc = S.deepseek = await put('/deepseek', { gateway: gw, apiKey: key || undefined });
      refreshCatalogs();
      dlg.close();
      toast(key ? `已設定 ${cur().label} 的 API key` : '已儲存 DeepSeek 設定');
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
    }
  };
  drawGateways();
  drawKey();
  fill(
    form,
    h('div', { class: 'dialog-title' }, 'DeepSeek'),
    h(
      'p',
      { class: 'dialog-text settings-lead' },
      'DeepSeek 模型在你電腦上的 Kimi Code 裡執行，所以 Kimi 的自動壓縮、子代理、計畫模式都照常運作。任何對話都可以用 DeepSeek 當主模型，也可以只讓子代理用 DeepSeek。模型從你選的閘道呼叫，費用算在那個閘道的 API key，不用 Kimi 訂閱。',
    ),
    h('div', { class: 'dialog-subtitle first' }, '閘道'),
    gwBox,
    gwNote,
    field('API key', keyInput, keyNote),
    keyActions,
    testOut,
    h('p', { class: 'om-field__help ds-note' }, '中控台只會在那台電腦的 Kimi 裡新增一個叫 agent-hub-deepseek 的模型來源，不會更動 Kimi 訂閱的登入，也不會改 Kimi 的預設模型；一般的 Kimi 對話照舊用訂閱的模型。新對話預設用哪個模型，在「設定」裡選。'),
    secondaryBox,
    ...(acc.warnings || []).map((w) => h('div', { class: 'callout small ds-secondary' }, icon('alert'), h('div', { class: 'callout-text' }, `「${w.machineName}」的 DeepSeek 模型來源沒有加上 session 標頭：${w.text}。閘道可能會對這台電腦的請求限流。`))),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => dlg.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  form.addEventListener('submit', save);
  const dlg = dialog(form);
  if (!cur().hasKey) setTimeout(() => keyInput.focus(), 0);
  // A [secondary_model] in a computer's Kimi: subagents may run on it.
  get('/deepseek/secondary')
    .then((list) => {
      if (!list.length) return;
      secondaryBox.hidden = false;
      fill(
        secondaryBox,
        icon('alert'),
        h('div', { class: 'callout-text' }, list.map((x) => `「${x.machineName}」的 Kimi 設定了子代理模型（[secondary_model]：${x.model}${x.force ? '，強制' : ''}）。子代理可能改用它，那可能是 Kimi 訂閱的模型。中控台不會更動這個設定；要自己決定子代理用哪個模型，在那台電腦的 config.toml 拿掉 [secondary_model]，再到對話或「設定」選子代理模型。`).join('\n')),
      );
    })
    .catch(() => {});
}

// /status in a DeepSeek or Claude conversation (running in Kimi, paid by their own key).
function meteredStatusDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const meta = s.meta || {};
  const family = familyOf(s);
  const model = (meta.models || []).find((x) => x.id === meta.model);
  const ctx = meta.context;
  const acc = family === 'claude' ? S.claude || {} : S.deepseek || {};
  const rows = [
    ['模型', model?.name || modelName(meta.model) || '—'],
    meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
    ['子代理', subagentLabel(s.subagent?.model)],
    ['權限', `${PERMISSION_LABELS[meta.permission] || PERMISSION_LABELS.manual}${meta.planMode ? ' · 計畫模式' : ''}`],
    ctx?.size ? ['Context', `${Math.round((ctx.used / ctx.size) * 100)}% · ${fmtK(ctx.used)} / ${fmtK(ctx.size)} tokens（Kimi 用到約 85% 會自動壓縮）`] : null,
    ['資料夾', s.cwd || '—'],
    ['執行在', `「${machineById(s.machineId)?.name || s.meta?.machineName || '那台電腦'}」的 Kimi Code${meta.kimiVersion ? ` ${meta.kimiVersion}` : ''}`],
    ['計費', family === 'claude' ? 'Claude API 的 key（Anthropic Console 帳戶，按 token），不用 Kimi 訂閱' : `${dsLabel()} 的 API key，不用 Kimi 訂閱`],
    ['API key', acc.hasKey ? `${family === 'claude' ? acc.keyHint : `…${acc.keyHint}`}${acc.keySource === 'env' ? '（環境變數）' : ''}` : '還沒有設定'],
  ].filter(Boolean);
  const body = h(
    'div',
    { class: 'account' },
    h('div', { class: 'dialog-title' }, '狀態'),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => (d.close(), family === 'claude' ? claudeDialog() : deepseekDialog()) }, family === 'claude' ? 'Claude API 設定…' : 'DeepSeek 設定…'), h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
  );
  const d = dialog(body);
}

// GitHub for the agents, one computer at a time: Claude and Kimi use git and
// the GitHub CLI (gh) there, signed in once from here. The sign-in stays in
// gh on that computer; the hub keeps no GitHub token.
const GITHUB_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow,gist&description=Agent%20Hub';
async function githubDialog() {
  const list = h('div', { class: 'gh-list' }, h('div', { class: 'claude-test' }, h('span', { class: 'spinner' }), ' 檢查各台電腦的 GitHub 登入狀態…'));
  let timer = null;
  let open = true;
  const d = dialog(
    h(
      'div',
      { class: 'settings' },
      h('div', { class: 'dialog-title' }, 'GitHub'),
      h(
        'p',
        { class: 'dialog-text settings-lead' },
        'Claude 和 Kimi 在每台電腦上用 git 與 GitHub CLI（gh）操作 GitHub：clone、開分支、push、開 Pull Request、看 Issue 和 Actions。每台電腦登入一次，那台電腦上的對話就都能用。登入資料只存在那台電腦的 gh 裡，中控台不會保存。會改到 GitHub 的動作（push、開 PR、留言）它們會先問過你。',
      ),
      list,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '完成')),
    ),
    { onClose: () => ((open = false), clearTimeout(timer)) },
  );
  const call = (c, action, body) => post(`/github/${encodeURIComponent(c.id)}/${action}`, body);
  const card = (c) => {
    const box = h('div', { class: 'gh-card' });
    const out = h('div', { class: 'claude-test', role: 'status' });
    const busy = (text) => {
      out.className = 'claude-test';
      fill(out, h('span', { class: 'spinner' }), ` ${text}`);
    };
    const bad = (err) => {
      out.className = 'claude-test bad';
      fill(out, err.message || String(err));
    };
    const redraw = (next) => {
      Object.assign(c, next);
      box.replaceWith(card(c));
    };
    const act = async (label, action, body) => {
      busy(label);
      try {
        redraw(action === 'web' ? { pending: await call(c, 'web') } : await call(c, action, body));
      } catch (err) {
        bad(err);
      }
    };
    const head = h(
      'div',
      { class: 'gh-card__head' },
      h('span', { class: 'gh-card__name' }, c.name, c.hub ? h('span', { class: 'gh-card__tag' }, '中控台這台') : null),
      h('span', { class: `gh-card__state${c.login ? ' ok' : ''}` }, c.offline ? '離線' : c.error ? '無法檢查' : c.gh === null ? '沒有 gh' : c.login ? `@${c.login}` : c.pending ? '等你授權' : '未登入'),
    );
    const body = [];
    if (c.offline) body.push(h('div', { class: 'om-field__help' }, '這台電腦的連接器沒有連上。連上後再回來這裡登入。'));
    else if (c.error) body.push(h('div', { class: 'om-field__help warn' }, c.error));
    else if (c.gh === null)
      body.push(
        h('div', { class: 'om-field__help' }, '這台電腦還沒有安裝 GitHub CLI（gh）。在那台電腦的終端機執行：'),
        h('div', { class: 'gh-cmd' }, h('code', null, c.install), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => copyText(c.install).then(() => toast('已複製')) }, '複製')),
        h('div', { class: 'claude-key-actions' }, h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => act('重新檢查…', 'status') }, '裝好了，重新檢查'), h('a', { class: 'om-btn om-btn--sm', href: 'https://cli.github.com', target: '_blank', rel: 'noopener' }, '其他安裝方式')),
      );
    else if (c.login)
      body.push(
        h('div', { class: 'om-field__help' }, `已登入 ${c.account ? `${c.account}（@${c.login}）` : `@${c.login}`}。`, c.git?.email ? `commit 署名：${c.git.name || ''} <${c.git.email}>` : ''),
        h(
          'div',
          { class: 'claude-key-actions' },
          h(
            'button',
            {
              class: 'om-btn om-btn--sm om-btn--destructive',
              type: 'button',
              // Asked in a dialog of its own; this one opens again after.
              onclick: async () => {
                const ok = await confirmDialog({ title: `讓「${c.name}」登出 GitHub？`, body: '那台電腦上的 Claude 和 Kimi 之後就不能 push 或開 PR，直到你再登入。這不會撤銷 GitHub 上的授權，要撤銷請到 GitHub 的 Settings → Applications。', action: '登出', destructive: true });
                if (ok) {
                  try {
                    await call(c, 'logout');
                    toast(`「${c.name}」已登出 GitHub`);
                  } catch (err) {
                    fail(err);
                  }
                }
                githubDialog();
              },
            },
            '登出',
          ),
        ),
      );
    else if (c.pending) {
      body.push(
        h('div', { class: 'om-field__help' }, '1. 複製這組代碼　2. 打開 GitHub 的裝置登入頁貼上　3. 按 Authorize。完成後這裡會自動更新。'),
        h('div', { class: 'gh-code' }, h('code', null, c.pending.code), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => copyText(c.pending.code).then(() => toast('已複製代碼')) }, '複製')),
        h(
          'div',
          { class: 'claude-key-actions' },
          h('a', { class: 'om-btn om-btn--sm om-btn--primary', href: c.pending.url || 'https://github.com/login/device', target: '_blank', rel: 'noopener', onclick: () => copyText(c.pending.code) }, '打開 GitHub 登入頁'),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => act('取消中…', 'cancel') }, '取消'),
        ),
      );
      const poll = async () => {
        if (!open || !box.isConnected) return;
        try {
          const next = await call(c, 'status');
          if (!next.pending) {
            c.pending = null;
            redraw(next);
            if (next.login) toast(`「${c.name}」已登入 GitHub：@${next.login}`);
            return;
          }
        } catch {}
        timer = setTimeout(poll, 2500);
      };
      timer = setTimeout(poll, 2500);
    } else {
      const tokenInput = h('input', { class: 'om-input', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'ghp_… 或 github_pat_…', 'aria-label': 'GitHub token' });
      const tokenForm = h(
        'form',
        { class: 'gh-token', hidden: true },
        tokenInput,
        h('div', { class: 'om-field__help' }, '需要 repo、read:org、workflow 權限。', h('a', { href: GITHUB_TOKEN_URL, target: '_blank', rel: 'noopener' }, '在 GitHub 建立一個'), '。token 直接交給那台電腦的 gh，中控台不保存。'),
        h('div', { class: 'claude-key-actions' }, h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'submit' }, '登入')),
      );
      tokenForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (tokenInput.value.trim()) act('向 GitHub 確認…', 'login', { token: tokenInput.value.trim() });
      });
      if (c.problem) body.push(h('div', { class: 'om-field__help warn' }, c.problem));
      body.push(
        h(
          'div',
          { class: 'claude-key-actions' },
          h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'button', onclick: () => act('向 GitHub 要登入代碼…', 'web') }, '用瀏覽器登入'),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => ((tokenForm.hidden = !tokenForm.hidden), tokenForm.hidden || tokenInput.focus()) }, '改用 token'),
        ),
        tokenForm,
      );
    }
    fill(box, head, ...body, out);
    return box;
  };
  const draw = (computers) => fill(list, ...(computers.length ? computers.map(card) : [h('div', { class: 'om-field__help' }, '沒有可以設定的電腦。')]));
  try {
    const computers = await get('/github');
    if (open) draw(computers);
  } catch (err) {
    fill(list, h('div', { class: 'claude-test bad' }, err.message));
  }
}

// Google Drive backups, one computer at a time: rclone there, signed in to
// Google once from here (the sign-in stays in rclone on that computer).
async function gdriveDialog() {
  const list = h('div', { class: 'gh-list' }, h('div', { class: 'claude-test' }, h('span', { class: 'spinner' }), ' 檢查各台電腦的 Google Drive 登入狀態…'));
  let timer = null;
  let open = true;
  const d = dialog(
    h(
      'div',
      { class: 'settings' },
      h('div', { class: 'dialog-title' }, 'Google Drive 備份'),
      h(
        'p',
        { class: 'dialog-text settings-lead' },
        '在對話裡輸入 /backup（或對話右上「⋯」→「備份到 Google Drive」），中控台就用 rclone 把那個對話的專案資料夾備份到你的 Google Drive：「Agent Hub 備份／電腦／資料夾」底下有一份「最新」，加上每天一個壓縮檔快照（保留 30 天）。.gitignore 排除的檔案、.git、node_modules、虛擬環境和快取不會備份。這是中控台自己做的，不經過 Claude 或 Kimi，不花 token。每台電腦登入 Google 一次就好，登入資料只存在那台電腦的 rclone 裡。',
      ),
      list,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '完成')),
    ),
    { onClose: () => ((open = false), clearTimeout(timer)) },
  );
  const call = (c, action, body) => post(`/gdrive/${encodeURIComponent(c.id)}/${action}`, body);
  const card = (c) => {
    const box = h('div', { class: 'gh-card' });
    const out = h('div', { class: 'claude-test', role: 'status' });
    const busy = (text) => {
      out.className = 'claude-test';
      fill(out, h('span', { class: 'spinner' }), ` ${text}`);
    };
    const redraw = (next) => {
      Object.assign(c, next);
      box.replaceWith(card(c));
    };
    const act = async (label, action, body) => {
      busy(label);
      try {
        redraw(action === 'web' ? { pending: await call(c, 'web') } : await call(c, action, body));
      } catch (err) {
        out.className = 'claude-test bad';
        fill(out, err.message);
      }
    };
    const state = c.offline ? '離線' : c.error ? '無法檢查' : c.rclone === null ? '沒有 rclone' : c.signedIn ? '已登入' : c.pending ? '等你登入' : '未登入';
    const head = h('div', { class: 'gh-card__head' }, h('span', { class: 'gh-card__name' }, c.name, c.hub ? h('span', { class: 'gh-card__tag' }, '中控台這台') : null), h('span', { class: `gh-card__state${c.signedIn ? ' ok' : ''}` }, state));
    const body = [];
    if (c.offline) body.push(h('div', { class: 'om-field__help' }, '這台電腦的連接器沒有連上。連上後再回來這裡登入。'));
    else if (c.error) body.push(h('div', { class: 'om-field__help warn' }, c.error));
    else if (c.rclone === null)
      body.push(
        h('div', { class: 'om-field__help' }, '這台電腦還沒有安裝 rclone（開源的雲端同步工具，官方支援 Google Drive）。在那台電腦的終端機執行：'),
        h('div', { class: 'gh-cmd' }, h('code', null, c.install), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => copyText(c.install).then(() => toast('已複製')) }, '複製')),
        h('div', { class: 'claude-key-actions' }, h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => act('重新檢查…', 'status') }, '裝好了，重新檢查'), h('a', { class: 'om-btn om-btn--sm', href: 'https://rclone.org/install/', target: '_blank', rel: 'noopener' }, '其他安裝方式')),
      );
    else if (c.signedIn)
      body.push(
        h('div', { class: 'om-field__help' }, `已登入 Google Drive${c.quota?.total ? `（已用 ${fmtBytes(c.quota.used || 0)} / ${fmtBytes(c.quota.total)}）` : ''}。在這台電腦上跑的對話都可以用 /backup。`),
        h(
          'div',
          { class: 'claude-key-actions' },
          h(
            'button',
            {
              class: 'om-btn om-btn--sm om-btn--destructive',
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog({ title: `讓「${c.name}」登出 Google Drive？`, body: '那台電腦上的對話之後就不能 /backup，直到你再登入。已經備份的檔案還在 Drive 上。這不會撤銷 Google 帳號裡的授權，要撤銷請到 Google 帳戶的「第三方應用程式和服務」。', action: '登出', destructive: true });
                if (ok) {
                  try {
                    await call(c, 'logout');
                    toast(`「${c.name}」已登出 Google Drive`);
                  } catch (err) {
                    fail(err);
                  }
                }
                gdriveDialog();
              },
            },
            '登出',
          ),
        ),
      );
    else if (c.pending) {
      body.push(
        h('div', { class: 'om-field__help warn' }, `這個登入網址只能在「${c.name}」這台電腦上的瀏覽器打開（它最後會回到那台電腦的 127.0.0.1）。在那台電腦上打開、選你的 Google 帳號、按「允許」，完成後這裡會自動更新。`),
        h('div', { class: 'gh-cmd' }, h('code', null, c.pending.url), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => copyText(c.pending.url).then(() => toast('已複製網址')) }, '複製')),
        h(
          'div',
          { class: 'claude-key-actions' },
          h('a', { class: 'om-btn om-btn--sm om-btn--primary', href: c.pending.url, target: '_blank', rel: 'noopener' }, '打開（我就在這台電腦上）'),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => act('取消中…', 'cancel') }, '取消'),
        ),
      );
      const poll = async () => {
        if (!open || !box.isConnected) return;
        try {
          const next = await call(c, 'status');
          if (!next.pending) {
            c.pending = null;
            redraw(next);
            if (next.signedIn) toast(`「${c.name}」已登入 Google Drive`);
            return;
          }
        } catch {}
        timer = setTimeout(poll, 2500);
      };
      timer = setTimeout(poll, 2500);
    } else {
      const tokenInput = h('textarea', { class: 'om-input', rows: 3, autocomplete: 'off', spellcheck: false, placeholder: '{"access_token":"…","token_type":"Bearer","refresh_token":"…","expiry":"…"}', 'aria-label': 'rclone token' });
      const tokenForm = h(
        'form',
        { class: 'gh-token', hidden: true },
        h('div', { class: 'om-field__help' }, '在任何一台有瀏覽器、裝了 rclone 的電腦執行 rclone authorize "drive"，登入後把它印出的那一段 {…} 貼在這裡。'),
        tokenInput,
        h('div', { class: 'claude-key-actions' }, h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'submit' }, '登入')),
      );
      tokenForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (tokenInput.value.trim()) act('向 Google 確認…', 'login', { token: tokenInput.value.trim() });
      });
      if (c.problem) body.push(h('div', { class: 'om-field__help warn' }, c.problem));
      body.push(
        h(
          'div',
          { class: 'claude-key-actions' },
          h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'button', onclick: () => act('向 rclone 要登入網址…', 'web') }, '用瀏覽器登入'),
          h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: () => ((tokenForm.hidden = !tokenForm.hidden), tokenForm.hidden || tokenInput.focus()) }, '用其他電腦登入'),
        ),
        tokenForm,
      );
    }
    fill(box, head, ...body, out);
    return box;
  };
  try {
    const computers = await get('/gdrive');
    if (open) fill(list, ...(computers.length ? computers.map(card) : [h('div', { class: 'om-field__help' }, '沒有可以設定的電腦。')]));
  } catch (err) {
    fill(list, h('div', { class: 'claude-test bad' }, err.message));
  }
}

// A new Claude conversation bound to a GitHub repository: cloned on the
// chosen computer, on a branch of its own (or one named here), and every
// change committed and pushed there.
// With `session`: that conversation, bound from now on (an old Claude API
// conversation is the one kind that is not Kimi Code on a computer).
async function repoDialog(m, session = null) {
  const kimi = !isLegacyClaude(session);
  const who = session ? nameFor(session) : 'Agent';
  const cur = (session ? null : homeRepo(m)) || {};
  const store = (value) => {
    S.home.repoByMachine = { ...(S.home.repoByMachine || {}), [m.id]: value };
    saveHome();
    showHome();
  };
  const repoInput = h('input', { class: 'om-input', type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'owner/repo 或 GitHub 網址', value: cur.full || '', 'aria-label': 'GitHub repo' });
  const list = h('div', { class: 'repo-list' }, h('div', { class: 'claude-test' }, h('span', { class: 'spinner' }), ` 讀取「${m.name}」上的 GitHub 帳號能 push 的 repo…`));
  const newBranchRadio = h('input', { type: 'radio', name: 'branch-mode', value: 'new', checked: !cur.branch });
  const namedRadio = h('input', { type: 'radio', name: 'branch-mode', value: 'named', checked: Boolean(cur.branch) });
  const branchInput = h('input', { class: 'om-input', type: 'text', autocomplete: 'off', spellcheck: false, placeholder: '例如 main，或已經存在的分支', value: cur.branch || '', 'aria-label': '分支名稱' });
  const out = h('div', { class: 'claude-test bad', role: 'status' });
  let repos = [];
  const drawList = () => {
    const q = repoInput.value.trim().toLowerCase();
    const shown = repos.filter((r) => !q || r.full.toLowerCase().includes(q)).slice(0, 50);
    fill(
      list,
      ...shown.map((r) =>
        h(
          'button',
          { class: `repo-row${r.full === repoInput.value.trim() ? ' on' : ''}`, type: 'button', onclick: () => ((repoInput.value = r.full), drawList()) },
          h('span', { class: 'repo-row__name' }, r.full, r.private ? h('span', { class: 'gh-card__tag' }, '私人') : null),
          r.description ? h('span', { class: 'repo-row__desc' }, r.description) : null,
        ),
      ),
      repos.length && !shown.length ? h('div', { class: 'om-field__help' }, '清單裡沒有符合的 repo；直接輸入 owner/repo 也可以。') : null,
    );
  };
  repoInput.addEventListener('input', drawList);
  branchInput.addEventListener('focus', () => (namedRadio.checked = true));
  const submit = h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '綁定');
  const save = async (e) => {
    e.preventDefault();
    const full = repoInput.value.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]/i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return fill(out, 'repo 要寫成 owner/repo（或貼上 GitHub 網址）');
    const branch = namedRadio.checked ? branchInput.value.trim() : '';
    if (namedRadio.checked && !branch) return fill(out, '請輸入分支名稱，或選「開一個新分支」');
    if (session) {
      out.className = 'claude-test';
      fill(out, h('span', { class: 'spinner' }), ` 綁定中（必要時 clone ${full}，可能要一點時間）…`);
      submit.disabled = true;
      try {
        await post(`/sessions/${session.id}/repo`, { repo: full, branch: branch || undefined });
        d.close();
        toast(`這個對話已綁定 ${full}`);
      } catch (err) {
        out.className = 'claude-test bad';
        fill(out, err.message);
        submit.disabled = false;
      }
      return;
    }
    store({ full, branch: branch || null });
    d.close();
    toast(`新對話會綁定 ${full}`);
  };
  const unbind = () => {
    store(null);
    d.close();
  };
  const form = h(
    'form',
    { class: 'settings' },
    h('div', { class: 'dialog-title' }, session ? '把這個對話綁定到 GitHub repo' : '綁定 GitHub repo'),
    h(
      'p',
      { class: 'dialog-text settings-lead' },
      session && kimi
        ? `綁定後就不能再換。這個對話的資料夾如果本來就是這個 repo，會留在原地、切到選的分支；不是的話，會把 repo clone 到對話資料夾裡的一個子資料夾。綁定後會馬上傳一則訊息給 Kimi（會用掉一輪），請它把屬於這個專案的檔案搬進 repo，commit 並 push。之後每一輪結束都會檢查，沒上傳的會提醒 Kimi，再不行就自動 commit 並 push。Kimi 問你要不要執行指令時，推到其他分支、force push、改 remote 的指令會自動拒絕（全部自動模式下 Kimi 不會先問，這一項就擋不了，但每輪的檢查照樣會把工作推上去）。`
        : session
        ? `綁定後就不能再換。這個對話的資料夾如果本來就是這個 repo，會留在原地、切到選的分支；不是的話，會把 repo clone 到「${m.name}」上的新資料夾，對話改到那裡工作（原本的資料夾保持不動），下一輪 Claude 會先把屬於這個專案的檔案搬進 repo，commit 並 push。之後每一輪結束都會檢查，沒上傳的會提醒 Claude，再不行就自動 commit 並 push；推到其他分支、force push、改 remote 都會被擋下。Claude 的系統提示會加上綁定規則，所以壓縮對話也不會忘；代價是下一輪要重新讀一次整段對話（一次性多花一些 token）。`
        : `新對話開始時，會把 repo clone 到「${m.name}」上的一個新資料夾，在一個分支上工作。${who} 寫的所有程式碼都會 commit 並 push 到那個分支；每一輪結束時 Agent Hub 都會檢查，沒上傳的會提醒 ${who}，再不行就自動 commit 並 push。綁定會一直跟著這個對話，不會忘記；推到其他分支、force push 或改 remote 的指令${kimi ? '在 Kimi 問你要不要執行時會自動拒絕（全部自動模式下擋不了，但每輪的檢查照樣會把工作推上去）' : '都會被擋下'}。`,
    ),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, 'Repo'), repoInput),
    list,
    h('div', { class: 'dialog-subtitle' }, '分支'),
    h('label', { class: 'settings-switch' }, newBranchRadio, h('span', null, h('span', { class: 'om-field__label' }, '開一個新分支'), h('span', { class: 'om-field__help' }, session ? '開出 claude/日期-編號（資料夾本來就是這個 repo 時，從它現在的位置開，未 commit 的變更會帶著走）' : '從預設分支開出 claude/日期-編號，跟 Claude Code 網頁版一樣，之後再合併'))),
    h('label', { class: 'settings-switch' }, namedRadio, h('span', null, h('span', { class: 'om-field__label' }, '指定分支'), h('span', { class: 'om-field__help' }, '已經存在就接著它做；不存在就從預設分支開出這個名字。填 main 會直接推到 main。'))),
    branchInput,
    out,
    h(
      'div',
      { class: 'dialog-actions' },
      cur.full ? h('button', { class: 'om-btn', type: 'button', onclick: unbind }, '不綁定') : null,
      h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'),
      submit,
    ),
  );
  form.addEventListener('submit', save);
  const d = dialog(form);
  setTimeout(() => repoInput.focus(), 0);
  try {
    repos = await post(`/github/${encodeURIComponent(m.id || 'local')}/repos`);
    drawList();
  } catch (err) {
    fill(
      list,
      h('div', { class: 'om-field__help warn' }, `${err.message}。直接輸入 owner/repo 也可以（公開 repo 不用登入就能 clone，但要 push 一定要登入）。`),
      h('div', { class: 'claude-key-actions' }, h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: githubDialog }, 'GitHub 登入…')),
    );
  }
}

// "已用 12 / 50": one of the API's rate limits, as of the last response.
const RATE_LIMITS = { requests: '每分鐘請求', 'input-tokens': '每分鐘輸入 tokens', 'output-tokens': '每分鐘輸出 tokens', tokens: '每分鐘 tokens' };
function rateBars(rl, only) {
  if (!rl) return [];
  return Object.entries(RATE_LIMITS)
    .filter(([k]) => rl[k]?.limit && (!only || only.includes(k)))
    .map(([k, label]) => {
      const { limit, remaining, reset } = rl[k];
      const pct = Math.round(Math.min(1, Math.max(0, (limit - remaining) / limit)) * 100);
      return h(
        'div',
        { class: 'quota' },
        h('div', { class: 'quota-head' }, h('span', null, label), h('span', { class: 'muted' }, `剩 ${fmtK(remaining)} / ${fmtK(limit)}`)),
        h('div', { class: `quota-bar${pct >= 90 ? ' danger' : pct >= 75 ? ' warning' : ''}` }, h('span', { style: { width: `${pct}%` } })),
      );
    });
}

// Under the context ring: what this conversation cost, against its cap.
function claudeCostNode() {
  const s = S.cur?.summary;
  const meta = s?.meta || {};
  const cost = s?.usage?.costUsd || 0;
  const cap = meta.budget;
  const pct = cap ? Math.round(Math.min(1, cost / cap) * 100) : 0;
  return h(
    'div',
    { class: 'menu-quota' },
    h(
      'div',
      { class: 'quota' },
      h('div', { class: 'quota-head' }, h('span', null, '這個對話'), h('span', { class: 'muted' }, cap ? `約 ${fmtUsd(cost)} / 上限 ${fmtUsd(cap)}` : `約 ${fmtUsd(cost)}`)),
      cap ? h('div', { class: `quota-bar${pct >= 90 ? ' danger' : pct >= 75 ? ' warning' : ''}` }, h('span', { style: { width: `${pct}%` } })) : null,
    ),
    ...rateBars(meta.rateLimits, ['requests', 'output-tokens']),
  );
}

function claudeCostDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const meta = s.meta || {};
  const u = meta.claudeUsage || {};
  const t = (n) => `${fmtK(n || 0)} tokens`;
  const rows = [
    ['這個對話', `約 ${fmtUsd(s.usage?.costUsd || 0)}${u.unpriced ? '（有用到中控台不知道價格的模型，那部分沒算進去）' : ''}`],
    ['API 請求', `${u.requests || 0} 次`],
    ['輸入', t(u.input)],
    ['快取讀取', `${t(u.cacheRead)}（約 1 折）`],
    ['快取寫入', `${t(u.cacheWrite)}（1.25 倍）`],
    ['輸出', `${t(u.output)}（含思考）`],
    u.searches ? ['網路搜尋', `${u.searches} 次`] : null,
    ['花費上限', meta.budget ? fmtUsd(meta.budget) : '沒有設定'],
  ].filter(Boolean);
  const bars = rateBars(meta.rateLimits);
  const body = h(
    'div',
    { class: 'account' },
    h('div', { class: 'dialog-title' }, '用量與花費'),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    bars.length ? [h('div', { class: 'dialog-subtitle' }, 'API 速率限制（最近一次回應）'), h('div', { class: 'quotas' }, bars)] : null,
    h(
      'p',
      { class: 'quota-note muted' },
      '金額是中控台依 Claude API 公開價格估計的，實際以 Claude Console 的帳單為準。一般 API key 讀不到帳戶餘額，請到 ',
      h('a', { href: CONSOLE_BILLING, target: '_blank', rel: 'noopener' }, 'Claude Console → Billing'),
      ' 查看。',
    ),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => (d.close(), budgetDialog()) }, '花費上限…'), h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
  );
  const d = dialog(body);
}

function claudeStatusDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const meta = s.meta || {};
  const model = (meta.models || []).find((x) => x.id === meta.model);
  const ctx = meta.context;
  const acc = S.claude || {};
  const rows = [
    ['模型', model?.name || meta.model || '—'],
    meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
    ['權限', `${CLAUDE_PERMISSION_LABELS[meta.permission] || CLAUDE_PERMISSION_LABELS.manual}${meta.planMode ? ' · 計畫模式' : ''}`],
    ctx?.size ? ['Context', `${Math.round((ctx.used / ctx.size) * 100)}% · ${fmtK(ctx.used)} / ${fmtK(ctx.size)} tokens`] : null,
    ['花費', `約 ${fmtUsd(s.usage?.costUsd || 0)}${meta.budget ? `（上限 ${fmtUsd(meta.budget)}）` : ''}`],
    ['資料夾', s.cwd || '—'],
    ['執行在', s.machineId ? `「${s.meta?.machineName || machineById(s.machineId)?.name || '那台電腦'}」（工具透過連接器執行，API key 留在中控台）` : `中控台這台電腦（${hostName()}）`],
    ['計費', 'Claude API · Console 帳戶，按 token'],
    ['API key', acc.hasKey ? `${acc.keyHint}${acc.keySource === 'env' ? '（環境變數）' : ''}` : '還沒有設定'],
  ].filter(Boolean);
  const body = h(
    'div',
    { class: 'account' },
    h('div', { class: 'dialog-title' }, '狀態'),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => (d.close(), claudeDialog()) }, 'Claude API 設定…'), h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
  );
  const d = dialog(body);
}

// 花費上限: the conversation stops (between steps) once it has cost this much.
function budgetDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const cap = s.meta?.budget;
  const on = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(cap) });
  const amount = h('input', { class: 'om-input ap-pct', type: 'number', min: '0.01', step: '0.5', inputmode: 'decimal', value: String(cap || 5), 'aria-label': '上限（美元）' });
  const err = h('div', { class: 'om-field__error', role: 'alert' });
  const save = async (e) => {
    e.preventDefault();
    const n = Number(amount.value);
    if (on.checked && !(n > 0)) return (err.textContent = '請輸入大於 0 的金額');
    try {
      await post(`/sessions/${s.id}/command`, { name: 'budget', args: on.checked ? String(n) : 'off' });
      d.close();
      toast(on.checked ? `花費上限：${fmtUsd(Math.round(n * 100) / 100)}` : '已關閉花費上限');
    } catch (x) {
      err.textContent = x.message;
    }
  };
  const form = h(
    'form',
    { class: 'settings autopause', onsubmit: save },
    h('div', { class: 'dialog-title' }, '花費上限'),
    h('p', { class: 'dialog-text settings-lead' }, `這個對話（含子代理）花到這個金額，Claude 做完手上這一步就停下，不會再送出新的請求。目前約 ${fmtUsd(s.usage?.costUsd || 0)}。之後調高或關閉上限，再送出「繼續」就好。`),
    h('label', { class: 'settings-switch' }, on, h('span', null, h('span', { class: 'om-field__label' }, '開啟花費上限'), h('span', { class: 'om-field__help' }, '只對這個對話'))),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '上限'), h('div', { class: 'ap-pct-row' }, h('span', null, 'US$'), amount)),
    err,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  const d = dialog(form);
}

// ----------------------------------------------------------- auto-pause

// 移到背景 (Kimi's Ctrl+B): what Kimi waits on goes on in the background.
async function moveToBackground() {
  const s = S.cur?.summary;
  if (!s) return;
  try {
    const r = await post(`/sessions/${s.id}/background`);
    if (r?.terminal) return toast('已在終端機的 Kimi 按下 Ctrl+B');
    if (r?.moved) return toast(`已把 ${r.moved} 個工作移到背景，會繼續跑`);
    if (!r?.swarm) return toast('目前沒有在前景跑的子代理或指令');
    // A subagent swarm: Kimi cannot move it to the background.
    const sw = r.swarm;
    if (!sw.waiting) return toast(`「${sw.description}」是子代理群，Kimi 不支援把它移到背景（Kimi 自己的 Ctrl+B 也不行）。先送出要插隊的訊息，再按一次「移到背景」，可以中斷它讓 Kimi 先讀你的訊息`);
    const ok = await confirmDialog({
      title: '子代理群沒辦法移到背景',
      body: `「${sw.description}」是一個子代理群${sw.agents ? `（${sw.agents} 個子代理）` : ''}，Kimi 不支援把它移到背景（Kimi 自己的 Ctrl+B 也不行），所以你那 ${sw.waiting} 則插隊訊息要等它全部做完才會被讀到。要讓 Kimi 現在就讀到，只能中斷它：中斷後你的訊息會重新送出，並告訴 Kimi 哪些子代理被中斷、之後可以接續（resume），不用從頭來。`,
      action: '中斷並送出訊息',
      destructive: true,
    });
    if (!ok) return;
    const x = await post(`/sessions/${s.id}/background`, { interruptSwarm: true });
    toast(x.sent ? `已中斷子代理群，${x.sent} 則訊息重新送出` : '已中斷子代理群');
  } catch (err) {
    fail(err);
  }
}

// The hub watches the 5-hour quota and types 「優雅暫停」 / 「繼續」 itself;
// these only turn it on and off and show what it is doing.
function autoPauseBadge(s) {
  const st = autoPauseStatus(s.autoPause, s.meta?.queue);
  if (!st) return null;
  return h('button', { class: `om-badge ap-badge${st.tone ? ` om-badge--${st.tone}` : ''}`, type: 'button', title: st.detail, onclick: autoPauseDialog }, icon('pause'), st.label);
}

async function setAutoPause(change) {
  const s = S.cur?.summary;
  if (!s) return null;
  try {
    const r = await post(`/sessions/${s.id}/autopause`, change);
    upsertSession(r);
    if ('enabled' in change) toast(r.autoPause?.enabled ? `已開啟自動暫停：5 小時額度用到 ${r.autoPause.threshold}% 時送出「優雅暫停」` : '已關閉自動暫停');
    return r;
  } catch (err) {
    fail(err);
    return null;
  }
}

async function cancelAutoResume() {
  const s = S.cur?.summary;
  const ap = s?.autoPause;
  if (ap?.phase !== 'paused') return;
  const text = ap.resumeText || '繼續';
  const ok = await confirmDialog({
    title: `不要在額度恢復後送出「${text}」？`,
    body: ap.enabled ? '自動暫停會保持開啟，下一個 5 小時視窗照常運作。這個對話之後要繼續，請自己送出訊息。' : '這個對話之後要繼續，請自己送出訊息。',
    action: '不要送出',
  });
  if (!ok) return;
  try {
    upsertSession(await post(`/sessions/${s.id}/autopause`, { cancelResume: true }));
    toast(`已取消：額度恢復後不會送出「${text}」`);
  } catch (err) {
    fail(err);
  }
}

// 「額度恢復後送出」: for a conversation already paused (you told Kimi to
// stop). The hub reads the quota now to know which window to wait out.
async function armResumeAfterReset(text = '繼續') {
  const s = S.cur?.summary;
  if (!s) return false;
  if (isMetered(s)) {
    toast(`${nameFor(s)} 對話不用 Kimi 訂閱，沒有 5 小時額度。用 /later 30 繼續 定時送出。`, { kind: 'error' });
    return false;
  }
  if (busy(s.status) && !(await confirmDialog({ title: 'Kimi 還在工作', body: `要等它停下、而且 5 小時額度恢復後，再送出「${text}」嗎？`, action: '好' }))) return false;
  try {
    const r = await post(`/sessions/${s.id}/autopause`, { resumeAfterReset: true, text });
    upsertSession(r);
    const at = r.autoPause?.resetAt;
    toast(`已設定：${at ? `約 ${whenText(at)}` : ''}5 小時額度恢復後送出「${text}」`);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

// 定時送出 at a time (ms).
async function scheduleMessage(text, at) {
  const s = S.cur?.summary;
  if (!s) return false;
  try {
    upsertSession(await post(`/sessions/${s.id}/schedule`, { text, at }));
    toast(`已排定：${whenText(at)}送出「${text}」`);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

async function cancelScheduled(itemId) {
  const s = S.cur?.summary;
  if (!s) return;
  try {
    upsertSession(await del(`/sessions/${s.id}/schedule/${encodeURIComponent(itemId)}`));
    toast('已取消定時訊息');
  } catch (err) {
    fail(err);
  }
}

// "15:30" → the next 15:30 (today, or tomorrow once it has passed).
function nextClock(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const d = new Date();
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// /later 30 繼續 · /later 1.5h 繼續 · /later 15:30 繼續 · /later reset 繼續
function laterCommand(args) {
  const a = args.trim();
  if (!a) return scheduleDialog();
  const [, when, rest] = a.match(/^(\S+)\s*([\s\S]*)$/);
  const text = rest.trim() || '繼續';
  const w = when.toLowerCase();
  const noQuota = isLegacyClaude(S.cur?.summary) || isMetered(S.cur?.summary);
  if (['reset', '額度', '恢復'].includes(w)) return noQuota ? toast(`${nameFor(S.cur.summary)} 沒有 5 小時額度，請用分鐘數或時間：/later 30 繼續、/later 15:30 繼續`, { kind: 'error' }) : armResumeAfterReset(text);
  let m;
  let at = null;
  if (/^\d{1,2}:\d{2}$/.test(w)) at = nextClock(w);
  else if ((m = w.match(/^(\d+(?:\.\d+)?)(m|min|分|分鐘)?$/))) at = Date.now() + Math.round(parseFloat(m[1]) * 60_000);
  else if ((m = w.match(/^(\d+(?:\.\d+)?)(h|hr|小時)$/))) at = Date.now() + Math.round(parseFloat(m[1]) * 3_600_000);
  if (!at || at - Date.now() < 30_000) return toast(noQuota ? '用法：/later 30 繼續（30 分鐘後）、/later 15:30 繼續' : '用法：/later 30 繼續（30 分鐘後）、/later 15:30 繼續、/later reset 繼續（5 小時額度恢復後）', { kind: 'error' });
  return scheduleMessage(text, at);
}

// 定時送出: a message, and when — in some minutes, at a time, or once the
// 5-hour quota is back. Lists what is already waiting.
function scheduleDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const sid = s.id;
  const text = h('textarea', { class: 'om-input sched-text', rows: 2, 'aria-label': '要送出的訊息' }, '繼續');
  const minutes = h('input', { class: 'om-input sched-num', type: 'number', min: '1', max: '43200', step: '1', inputmode: 'numeric', value: '30', 'aria-label': '幾分鐘後' });
  const later = new Date(Date.now() + 3_600_000);
  const clock = h('input', { class: 'om-input sched-clock', type: 'time', value: `${String(later.getHours()).padStart(2, '0')}:00`, 'aria-label': '送出時間' });
  const preview = h('span', { class: 'om-field__help' });
  const usageNote = h('p', { class: 'dialog-text muted' }, '讀取 5 小時額度…');
  const err = h('div', { class: 'om-field__error', role: 'alert' });
  const pending = h('div', { class: 'sched-pending' });
  // Claude's and DeepSeek's bills are not a Kimi plan with a 5-hour quota.
  const claude = isLegacyClaude(s) || isMetered(s);
  const modes = claude ? { minutes: '幾分鐘後', clock: '指定時間' } : { minutes: '幾分鐘後', clock: '指定時間', reset: '5 小時額度恢復後' };
  let mode = 'minutes';
  const seg = h('div', { class: 'om-seg om-seg--sm', role: 'group', 'aria-label': '什麼時候送出' });
  const panes = {
    minutes: h('div', { class: 'sched-when' }, minutes, h('span', null, '分鐘後'), preview),
    clock: h('div', { class: 'sched-when' }, clock, h('span', { class: 'om-field__help sched-clock-note' })),
    reset: h('div', { class: 'sched-when sched-reset' }, usageNote),
  };
  const when = () => (mode === 'minutes' ? Date.now() + Math.round(Number(minutes.value)) * 60_000 : mode === 'clock' ? nextClock(clock.value) : null);
  const drawWhen = () => {
    fill(seg, ...Object.entries(modes).map(([k, label]) => h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(k === mode), onclick: () => ((mode = k), drawWhen()) }, label)));
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== mode;
    const n = Number(minutes.value);
    preview.textContent = Number.isInteger(n) && n >= 1 ? `${clockTime(Date.now() + n * 60_000)} 送出` : '';
    const at = nextClock(clock.value);
    panes.clock.lastChild.textContent = at ? `${new Date(at).toDateString() === new Date().toDateString() ? '今天' : '明天'} ${whenText(at)}` : '';
    err.textContent = '';
  };
  minutes.addEventListener('input', drawWhen);
  clock.addEventListener('input', drawWhen);

  // What is waiting to go out in this conversation.
  const drawPending = () => {
    const cur = S.sessions.get(sid) || s;
    const ap = autoPauseStatus(cur.autoPause, cur.meta?.queue);
    const rows = [
      ...(ap?.paused ? [h('div', { class: 'sched-item' }, icon('pause'), h('span', { class: 'sched-item-text' }, ap.detail), h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '不要送出', 'aria-label': '不要送出', onclick: cancelAutoResume }, icon('x')))] : []),
      ...(cur.scheduled || []).map((q) => h('div', { class: `sched-item${q.gaveUp ? ' danger' : ''}` }, icon('clock'), h('span', { class: 'sched-item-text' }, `${q.at > Date.now() ? whenText(q.at) : ''}送出「${q.text}」`, q.error || q.wait ? h('span', { class: 'muted' }, ` · ${q.wait === 'offline' ? '電腦離線，連上後送出' : q.error}`) : null), h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '取消', 'aria-label': '取消這則定時訊息', onclick: () => cancelScheduled(q.id) }, icon('x')))),
    ];
    fill(pending, rows.length ? [h('div', { class: 'dialog-subtitle' }, '等著送出'), ...rows] : null);
  };

  const save = async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) return (err.textContent = '要送出的訊息是空的');
    let ok;
    if (mode === 'reset') ok = await armResumeAfterReset(msg);
    else {
      const at = when();
      if (!at || !Number.isFinite(at) || (mode === 'minutes' && !(Number.isInteger(Number(minutes.value)) && Number(minutes.value) >= 1))) return (err.textContent = mode === 'minutes' ? '分鐘數要是 1 以上的整數' : '請選一個時間');
      ok = await scheduleMessage(msg, at);
    }
    if (ok) d.close();
  };

  const form = h(
    'form',
    { class: 'settings schedule', onsubmit: save },
    h('div', { class: 'dialog-title' }, '定時送出'),
    h('p', { class: 'dialog-text settings-lead' }, `到時候由中控台替你在這個對話送出訊息，關掉網頁也照常。${nameFor(s)} 正在工作時，會排在這一輪之後。`),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '訊息'), text),
    h('div', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '什麼時候'), seg, ...Object.values(panes)),
    err,
    pending,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '排定')),
  );
  const d = dialog(form, { onClose: () => S.scheduleDraw === drawPending && (S.scheduleDraw = null) });
  S.scheduleDraw = drawPending;
  drawWhen();
  drawPending();
  if (claude) return;
  fetchUsage(s.machineId).then((data) => {
    const u = data.usage;
    const h5 = u?.kind === 'ok' ? u.quota?.usages?.limit5h : null;
    fill(
      usageNote,
      h5
        ? `目前 5 小時額度已用 ${Math.round(Math.min(1, h5.usedRatio) * 100)}%${h5.resetAt ? `，${resetIn(h5.resetAt)}` : ''}。等 Kimi 停下、而且額度確實恢復後才送出；這之前若有人又讓 Kimi 開始工作，就不送。`
        : u?.kind === 'error'
          ? `讀不到 5 小時額度（${u.message}），這個選項沒辦法用。`
          : '這個帳號沒有 5 小時額度資訊，這個選項沒辦法用。',
    );
  });
}

function autoPauseDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const sid = s.id;
  const ap0 = s.autoPause || {};
  const on = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(ap0.enabled) });
  const pct = h('input', { class: 'om-input ap-pct', type: 'number', min: '1', max: '100', step: '1', inputmode: 'numeric', value: String(ap0.threshold || 90), 'aria-label': '暫停門檻（%）' });
  const err = h('div', { class: 'om-field__error', role: 'alert' });
  const offHint = h('span', { class: 'om-field__help' }, '只對這個對話');
  // Turning it off while paused also drops the 「繼續」 it is waiting to send.
  on.addEventListener('change', () => {
    const paused = S.sessions.get(sid)?.autoPause?.phase === 'paused';
    offHint.textContent = !on.checked && paused ? '這個對話正在等額度恢復：關閉後就不會自動送出「繼續」' : '只對這個對話';
    offHint.classList.toggle('warn', !on.checked && paused);
  });
  const usageBox = h('div', { class: 'quotas' }, h('div', { class: 'muted' }, '讀取方案用量…'));
  const statusBox = h('div', { class: 'ap-status' });
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? h('span', { class: 'om-field__help' }, help) : null);

  // What it is doing now, its problems and its recent actions. Redrawn as
  // the conversation updates, without touching what is being edited above.
  const drawStatus = () => {
    const cur = S.sessions.get(sid) || s;
    const ap = cur.autoPause || {};
    const st = autoPauseStatus(ap, cur.meta?.queue);
    const readOnly = cur.meta?.owner === 'tui' && !cur.meta?.controllable;
    fill(
      statusBox,
      st ? h('div', { class: `ap-now${st.tone ? ` ${st.tone}` : ''}` }, icon('pause'), h('div', null, h('div', { class: 'ap-now-label' }, st.label), h('div', { class: 'ap-now-detail' }, st.detail)), st.paused ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: cancelAutoResume }, '取消繼續') : null) : null,
      readOnly ? h('div', { class: 'callout small ap-warn' }, icon('terminal'), h('div', { class: 'callout-text' }, '這個對話正在終端機的 Kimi 裡執行（唯讀），中控台沒辦法替它送出訊息。改用 kimi-hub 啟動 Kimi，或在那個 Kimi 裡輸入 /web。')) : null,
      ap.log?.length
        ? [h('div', { class: 'dialog-subtitle' }, '最近紀錄'), h('ol', { class: 'ap-log' }, ...[...ap.log].reverse().map((l) => h('li', null, h('span', { class: 'ap-log-time' }, clockTime(l.ts)), h('span', null, l.text))))]
        : null,
    );
  };

  const save = async (e) => {
    e.preventDefault();
    const n = Number(pct.value);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      err.textContent = '門檻要是 1 到 100 之間的整數';
      pct.focus();
      return;
    }
    const r = await setAutoPause({ enabled: on.checked, threshold: n });
    if (r) d.close();
  };

  const form = h(
    'form',
    { class: 'settings autopause', onsubmit: save },
    h('div', { class: 'dialog-title' }, '自動暫停'),
    h('p', { class: 'dialog-text settings-lead' }, '5 小時額度用到設定的比例時，在這個對話送出「優雅暫停」（插隊，Kimi 下一步就會讀到）；5 小時額度恢復後再送出「繼續」。只在 Kimi 工作時暫停，每個 5 小時視窗最多一次。由中控台執行，關掉網頁也照常運作。'),
    h('label', { class: 'settings-switch' }, on, h('span', null, h('span', { class: 'om-field__label' }, '開啟自動暫停'), offHint)),
    field('暫停門檻', h('div', { class: 'ap-pct-row' }, pct, h('span', null, '%')), '5 小時額度用到這個比例就暫停（1–100）'),
    err,
    h('div', { class: 'dialog-subtitle' }, '目前額度'),
    usageBox,
    statusBox,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  const d = dialog(form, { onClose: () => S.autoPauseDraw === drawStatus && (S.autoPauseDraw = null) });
  S.autoPauseDraw = drawStatus;
  drawStatus();
  usageCache.delete(s.machineId);
  fetchUsage(s.machineId).then((data) => {
    const u = data.usage;
    const bars = u?.kind === 'ok' ? quotaBars(u.quota, ['limit5h', 'limit7d']) : [];
    if (bars.length) return fill(usageBox, ...bars);
    const msg = u?.kind === 'error' ? (/no token|login/i.test(u.message || '') ? '這台電腦的 Kimi 沒有用 Kimi 帳號登入，讀不到 5 小時額度，自動暫停沒辦法運作。在那台電腦執行 kimi login。' : `讀不到方案用量：${u.message}`) : '這個帳號沒有 5 小時額度資訊，自動暫停沒辦法運作。';
    fill(usageBox, h('p', { class: 'dialog-text muted' }, msg));
  });
}

// 設定: 配色, where models come from (模型來源), and what a new conversation
// starts with (model, thinking, permission, 子代理 model; and, for a model that
// is a subagent, how hard it thinks).
async function openSettings() {
  const m = homeMachine();
  const cat = m ? await loadCatalog(m.id) : null;
  const models = allModels(cat);
  const d0 = defaults();
  const form = h('form', { class: 'settings all-settings' });
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? h('span', { class: 'om-field__help' }, help) : null);

  // ---- 配色: applied and kept at once, whatever happens to the form below.
  const swatch = (c) =>
    h(
      'span',
      { class: 'look-swatch', style: { '--sw-bg': c.bg, '--sw-side': c.side, '--sw-raised': c.raised, '--sw-ink': c.ink, '--sw-accent': c.accent }, 'aria-hidden': 'true' },
      h('span', { class: 'sw-side' }),
      h('span', { class: 'sw-main' }, h('span', { class: 'sw-line' }), h('span', { class: 'sw-line short' }), h('span', { class: 'sw-box' }, h('span', { class: 'sw-send' }))),
    );
  const lookBox = h('div', { class: 'look-list', role: 'radiogroup', 'aria-label': '配色' });
  const lookNote = h('p', { class: 'om-field__help look-note' });
  const themeSeg = h('div', { class: 'om-seg om-seg--sm', role: 'group', 'aria-label': '淺色或深色' });
  const themeNote = h('span', { class: 'om-field__help' });
  const drawLook = () => {
    const cur = look();
    fill(
      lookBox,
      ...Object.entries(LOOKS).map(([id, l]) =>
        h(
          'button',
          {
            class: `look-card${cur === id ? ' on' : ''}`,
            type: 'button',
            role: 'radio',
            'aria-checked': String(cur === id),
            onclick: () => (chooseLook(id), drawLook()),
          },
          swatch(l.swatch),
          h('span', { class: 'look-name' }, l.name),
        ),
      ),
    );
    lookNote.textContent = LOOKS[cur].desc;
    const kimi = cur === 'kimi';
    const t = theme();
    fill(
      themeSeg,
      ...[['auto', '跟系統'], ['light', '淺色'], ['dark', '深色']].map(([v, label]) => h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(t === v), disabled: !kimi, onclick: () => (applyTheme(v === 'auto' ? null : v), drawLook()) }, label)),
    );
    themeNote.textContent = kimi ? '' : `淺色／深色只用在 Kimi 配色；${LOOKS[cur].name} 固定一種明暗`;
  };
  drawLook();

  // ---- 模型來源
  const ready = (id, key) => cat?.sources.find((x) => x.id === id)?.ready ?? Boolean(key);
  const sourceRow = (title, status, ok, action) =>
    h(
      'div',
      { class: 'src-row' },
      h('div', { class: 'src-text' }, h('div', { class: 'src-title' }, title, h('span', { class: `om-badge${ok ? ' om-badge--success' : ''}` }, ok ? '可用' : '未設定')), h('div', { class: 'om-field__help' }, status)),
      h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: action.run }, action.label),
    );
  const ds = S.deepseek || {};
  const cl = S.claude || {};
  const sources = h(
    'div',
    { class: 'src-list' },
    sourceRow('Kimi 訂閱', m ? `${m.name} 的 Kimi 帳號${m.kimi?.version ? ` · Kimi Code ${m.kimi.version}` : ''}` : '沒有可用的電腦：連接一台有 Kimi Code 的電腦，並在那台執行 kimi login', Boolean(m), m ? { label: '用量…', run: () => accountDialog(m.id) } : { label: '連接電腦…', run: openMachines }),
    sourceRow(`DeepSeek（${dsLabel()}）`, ds.hasKey ? `API key …${ds.keyHint}，費用算在閘道的帳戶` : '還沒有閘道的 API key', ready('deepseek', ds.hasKey), { label: '設定…', run: deepseekDialog }),
    sourceRow('Claude API', cl.hasKey ? `API key ${cl.keyHint}${cl.keySource === 'env' ? '（環境變數）' : ''}，費用從 Claude Console 帳戶扣款` : '還沒有 Anthropic 的 API key', ready('claude', cl.hasKey), { label: '設定…', run: claudeDialog }),
  );

  // ---- 新對話的預設
  const options = (selected) => {
    const opt = (x) => h('option', { value: x.id, selected: x.id === selected }, x.name || x.id);
    const shown = (cat?.sources || []).filter((src) => src.ready && src.models.length);
    return shown.length > 1 ? shown.map((src) => h('optgroup', { label: sourceTitle(src) }, ...src.models.map(opt))) : models.map(opt);
  };
  const modelSel = h('select', { class: 'om-input', name: 'model' }, h('option', { value: '' }, '預設模型'), ...options(d0.model));
  if (d0.model && !models.some((x) => x.id === d0.model)) modelSel.append(h('option', { value: d0.model, selected: true }, modelName(d0.model)));
  const effortSel = h('select', { class: 'om-input', name: 'effort' });
  const fillEfforts = () => {
    // The default model has thinking choices too.
    const mod = models.find((x) => x.id === (modelSel.value || cat?.defaultModel));
    const list = mod?.efforts || [];
    const cur = effortSel.value || d0.effort;
    fill(effortSel, h('option', { value: '' }, '模型預設'), ...list.map((e) => h('option', { value: e, selected: e === cur }, `${EFFORT_LABELS[e] || e}${e === mod.defaultEffort ? '（模型預設）' : ''}`)));
    effortSel.disabled = list.length < 2;
  };
  modelSel.addEventListener('change', fillEfforts);
  fillEfforts();
  const permSel = h('select', { class: 'om-input', name: 'permission' }, ...Object.entries(PERMISSION_LABELS).map(([k, v]) => h('option', { value: k, selected: k === (d0.permission || 'manual') }, v)));
  const plan = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(d0.planMode) });
  const subSel = h('select', { class: 'om-input', name: 'subagent' }, h('option', { value: 'primary', selected: !d0.subagentModel || d0.subagentModel === 'primary' }, '跟主模型一樣'), ...options(d0.subagentModel));
  if (d0.subagentModel && d0.subagentModel !== 'primary' && !models.some((x) => x.id === d0.subagentModel)) subSel.append(h('option', { value: d0.subagentModel, selected: true }, modelName(d0.subagentModel)));

  // How hard a model thinks as a subagent: one setting per model, shared by
  // every conversation on every computer; the hub says whether it can be set.
  const perModel = cat?.scope === 'per-model';
  const efforts = { ...(d0.subagentEfforts || {}) };
  const subModels = models.filter((x) => x.family !== 'kimi' && x.efforts.length);
  const effortRows = subModels.map((x) => {
    const sel = h('select', { class: 'om-input', 'aria-label': `${x.name} 的子代理思考強度`, onchange: () => (efforts[x.id] = sel.value) }, ...x.efforts.map((e) => h('option', { value: e, selected: e === subagentEffortOf(x.id, x) }, `${EFFORT_LABELS[e] || e}${e === x.defaultEffort ? '（模型預設）' : ''}`)));
    return h('div', { class: 'sub-effort-row' }, h('span', { class: 'sub-effort-name' }, x.name), sel);
  });
  const subEffortBox = perModel
    ? h(
        'div',
        { class: 'om-field' },
        h('span', { class: 'om-field__label' }, '子代理思考強度（依模型，所有聊天室共用）'),
        effortRows.length ? h('div', { class: 'sub-efforts' }, effortRows) : null,
        h('span', { class: 'om-field__help' }, effortRows.length ? '每個模型當子代理時用的思考強度，這台中控台的所有對話都一樣。「跟主模型一樣」的子代理用主對話的思考強度；Kimi 訂閱的模型由 Kimi 決定，不能設定。' : '設定好 DeepSeek 或 Claude 之後，這裡可以選它們當子代理時的思考強度。Kimi 訂閱的模型由 Kimi 決定，不能設定。'),
      )
    : h('span', { class: 'om-field__help' }, '子代理用模型自己的預設思考強度');

  const save = async (e) => {
    e.preventDefault();
    try {
      await saveSettings({ defaults: { model: modelSel.value, effort: effortSel.disabled ? '' : effortSel.value, permission: permSel.value, planMode: plan.checked, subagentModel: subSel.value, ...(perModel ? { subagentEfforts: efforts } : {}) } });
      resetHomeChoices();
      d.close();
      toast('已儲存設定');
    } catch (err) {
      fail(err);
    }
  };
  fill(
    form,
    h('div', { class: 'dialog-title' }, '設定'),
    h('div', { class: 'dialog-subtitle first' }, '配色'),
    lookBox,
    lookNote,
    h('div', { class: 'theme-row' }, h('span', { class: 'om-field__label' }, '明暗'), themeSeg),
    themeNote,
    h('div', { class: 'dialog-subtitle' }, '模型來源'),
    sources,
    h('div', { class: 'dialog-subtitle' }, '新對話的預設'),
    h('p', { class: 'dialog-text settings-lead' }, '從中控台開新對話、或第一次在中控台打開舊對話時，會套用這些設定。之後在對話裡改的，會保留在那個對話。'),
    field('模型', modelSel, models.length ? (m && S.machines.length > 1 ? `「${m.name}」上可用的模型` : null) : '連上一台有 Kimi 的電腦後，就能選擇模型'),
    field('思考強度', effortSel),
    field('權限', permSel, '每次詢問：每個指令與修改都先問你 · 需要時詢問：只有風險高的才問 · 全部自動：不會打斷你'),
    h('label', { class: 'settings-switch' }, plan, h('span', null, h('span', { class: 'om-field__label' }, '計畫模式'), h('span', { class: 'om-field__help' }, '先規劃，你同意後才動手'))),
    field('子代理模型', subSel, '每個對話也有自己的子代理模型，可以在輸入框的「子代理」改'),
    subEffortBox,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  form.addEventListener('submit', save);
  const d = dialog(form, { wide: true });
}

async function openMachines() {
  let hub = { bridgeKey: '', bridgePath: '/bridge/agent-hub-bridge.mjs' };
  try {
    hub = await get('/hub');
  } catch {}
  const content = h('div', { class: 'machines' });
  const d = dialog(content, { wide: true, onClose: () => (machinesDialog = null) });
  machinesDialog = { draw: () => drawMachines(content, hub, d), close: d.close };
  machinesDialog.draw();
}

function drawMachines(content, hub, d) {
  const origin = location.origin;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const unix = `curl -fsSL ${origin}${hub.bridgePath} -o agent-hub-bridge.mjs && node agent-hub-bridge.mjs --hub ${origin} --key ${hub.bridgeKey}`;
  const win = `curl.exe -fsSL ${origin}${hub.bridgePath} -o agent-hub-bridge.mjs; node agent-hub-bridge.mjs --hub ${origin} --key ${hub.bridgeKey}`;
  // The machine being connected is usually Linux or a Mac, whatever this
  // browser runs on; Windows stays one click away.
  const os = d.os || 'unix';
  const cmd = os === 'win' ? win : unix;
  const status = (m) => (!m.online ? h('span', { class: 'om-badge' }, '離線') : h('span', { class: 'om-badge om-badge--success' }, icon('check'), '在線上'));
  const wrap = 'node ~/.agent-hub/agent-hub-bridge.mjs kimi';
  fill(
    content,
    h('div', { class: 'dialog-title' }, '你的電腦'),
    S.machines.length
      ? h(
          'div',
          { class: 'om-group' },
          ...S.machines.map((m) =>
            h(
              'div',
              { class: 'om-group__row machine-row' },
              icon('computer'),
              h(
                'div',
                { class: 'om-group__text' },
                h('div', { class: 'om-group__label' }, m.name),
                h('div', { class: 'om-group__hint' }, [m.platform, m.kimi?.version ? `Kimi Code ${m.kimi.version}` : null, m.online ? `${(m.sessions || []).length} 個對話` : `上次連線：${relTime(m.lastSeen || 0)}`].filter(Boolean).join(' · ')),
              ),
              h('div', { class: 'machine-right' }, status(m), !m.online ? h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', onclick: () => removeMachine(m) }, '移除…') : null),
            ),
          ),
        )
      : h('p', { class: 'dialog-text' }, '還沒有連接任何電腦。'),
    h('div', { class: 'dialog-subtitle' }, '連接一台電腦'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, '在那台電腦安裝 Node.js 22 以上與 ', h('a', { href: 'https://github.com/MoonshotAI/kimi-code', target: '_blank', rel: 'noopener' }, 'Kimi Code'), '，並執行 ', h('code', null, 'kimi login'), ' 登入你的 Kimi 帳號。'),
      h(
        'li',
        null,
        '在那台電腦的終端機執行：',
        h(
          'div',
          { class: 'om-seg om-seg--sm os-seg', role: 'group' },
          h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(os === 'unix'), onclick: () => ((d.os = 'unix'), drawMachines(content, hub, d)) }, 'macOS / Linux'),
          h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(os === 'win'), onclick: () => ((d.os = 'win'), drawMachines(content, hub, d)) }, 'Windows'),
        ),
        h('div', { class: 'cmd' }, h('code', null, cmd), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: (e) => copyText(cmd).then(() => ((e.target.textContent = '已複製'), setTimeout(() => (e.target.textContent = '複製'), 1500))) }, '複製')),
        local ? h('div', { class: 'om-field__help' }, '目前是用本機網址開啟。其他電腦要連上，請改用公網網址（npm run public 會印出來）開啟這個畫面再複製。') : null,
      ),
      h('li', null, '完成。那台電腦的 Kimi 對話（包含終端機裡正在跑的）會即時出現在左邊。'),
    ),
    h('div', { class: 'dialog-subtitle' }, '從這裡操作終端機裡的 Kimi'),
    h('p', { class: 'dialog-text' }, '終端機裡的 Kimi 會自動同步到這裡。想從這裡送訊息、核准或停止它，改用這個指令啟動 Kimi（macOS / Linux，需要 python3）：'),
    h('div', { class: 'cmd' }, h('code', null, wrap), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: (e) => copyText(wrap).then(() => ((e.target.textContent = '已複製'), setTimeout(() => (e.target.textContent = '複製'), 1500))) }, '複製')),
    h('p', { class: 'dialog-text muted' }, "可以加進 ~/.bashrc 或 ~/.zshrc：alias kimi-hub='node ~/.agent-hub/agent-hub-bridge.mjs kimi'。正在跑的 Kimi 也可以輸入 /web，把對話交給這裡。"),
    h('p', { class: 'dialog-text muted' }, '連接器只會轉送 Kimi 的對話、權限請求與對話資料夾的檔案；Kimi 的登入資料留在那台電腦上。'),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: d.close }, '完成')),
  );
}

async function removeMachine(m) {
  const ok = await confirmDialog({ title: `要移除「${m.name}」嗎？`, body: '之後要再連接時，在那台電腦重新執行連接指令就好。', action: '移除', destructive: true });
  if (!ok) return;
  try {
    await del(`/machines/${m.id}`);
    await loadMachines();
  } catch (err) {
    fail(err);
  }
  openMachines();
}

// A folder tree on the machine: click a row to select it, the caret (or
// clicking the selected row again) to open it; double-click picks it.
// `m` with no id: this computer (the hub's own folders, for Claude).
function browseFolders(m, pick, start = S.home.cwdByMachine?.[m.id]) {
  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': '資料夾' });
  const chosen = h('div', { class: 'tree-path' });
  const up = h('button', { class: 'om-btn om-btn--sm', type: 'button', disabled: true }, '上一層');
  let selected = null;
  let root = null;
  const join = (p, name) => `${p.replace(/\/$/, '')}/${name}`;
  const list = (path) => get(`/fs/dirs?${new URLSearchParams({ ...(m.id ? { machine: m.id } : {}), ...(path ? { path } : {}) })}`);
  const choose = h('button', { class: 'om-btn om-btn--primary', type: 'button', disabled: true, onclick: () => selected && (pick(selected), d.close()) }, '選擇這個資料夾');
  const select = (path, row) => {
    selected = path;
    for (const r of tree.querySelectorAll('.tree-row[aria-selected="true"]')) r.setAttribute('aria-selected', 'false');
    row?.setAttribute('aria-selected', 'true');
    chosen.textContent = shortPath(path, m.home, 8);
    choose.disabled = false;
  };
  // One folder: its row, and its subfolders once opened.
  const node = (path, name, depth) => {
    const kids = h('div', { class: 'tree-kids', role: 'group', hidden: true });
    const caret = h('span', { class: 'tree-caret', 'aria-hidden': 'true' });
    const row = h('div', { class: 'tree-row', role: 'treeitem', tabindex: '0', 'aria-expanded': 'false', 'aria-selected': 'false', style: { paddingLeft: `${8 + depth * 16}px` } }, caret, h('span', { class: 'tree-name' }, name));
    const el = h('div', { class: 'tree-node' }, row, kids);
    let loaded = false;
    el.toggle = async (open = kids.hidden) => {
      if (open && !loaded) {
        loaded = true;
        fill(kids, h('div', { class: 'tree-note', style: { paddingLeft: `${28 + depth * 16}px` } }, '讀取中…'));
        try {
          const r = await list(path);
          fill(kids, ...r.dirs.map((n) => node(join(r.path, n), n, depth + 1)), !r.dirs.length ? h('div', { class: 'tree-note', style: { paddingLeft: `${28 + depth * 16}px` } }, '沒有子資料夾') : null);
        } catch (err) {
          loaded = false;
          fill(kids, h('div', { class: 'tree-note', style: { paddingLeft: `${28 + depth * 16}px` } }, err.message));
        }
      }
      kids.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
    };
    caret.addEventListener('click', (e) => (e.stopPropagation(), el.toggle()));
    row.addEventListener('click', () => (selected === path ? el.toggle() : (select(path, row), el.toggle(true))));
    row.addEventListener('dblclick', () => (pick(path), d.close()));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (pick(path), d.close());
      else if (e.key === 'ArrowRight') el.toggle(true);
      else if (e.key === 'ArrowLeft') el.toggle(false);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = [...tree.querySelectorAll('.tree-row')].filter((x) => x.offsetParent);
        rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      } else return;
      e.preventDefault();
    });
    row.addEventListener('focus', () => select(path, row));
    el.path = path;
    return el;
  };
  // Show `path` as the top of the tree, opened; then open down to `target`.
  const showRoot = async (path, target) => {
    fill(tree, h('div', { class: 'tree-note' }, '讀取中…'));
    try {
      root = await list(path);
      up.disabled = !root.parent;
      const top = node(root.path, shortPath(root.path, m.home, 8), 0);
      fill(tree, top);
      await top.toggle(true);
      select(root.path, top.firstChild);
      if (target && target.startsWith(`${root.path.replace(/\/$/, '')}/`)) {
        let at = top;
        for (const name of target.slice(root.path.replace(/\/$/, '').length + 1).split('/').filter(Boolean)) {
          at = [...at.lastChild.children].find((c) => c.path === join(at.path, name));
          if (!at) break;
          await at.toggle(true);
          select(at.path, at.firstChild);
        }
        tree.querySelector('.tree-row[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
      }
    } catch (err) {
      fill(tree, h('div', { class: 'tree-note' }, err.message));
    }
  };
  up.addEventListener('click', () => root?.parent && showRoot(root.parent, selected));
  const d = dialog(
    h(
      'div',
      { class: 'browse' },
      h('div', { class: 'browse-head' }, h('div', { class: 'dialog-title' }, `「${m.name}」上的資料夾`), up),
      tree,
      h('div', { class: 'browse-foot' }, h('span', { class: 'muted' }, '選擇：'), chosen),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), choose),
    ),
    { wide: true },
  );
  showRoot('', start);
}

function lightbox(src) {
  const d = dialog(h('img', { class: 'lightbox-img', src, alt: '圖片', onclick: () => d.close() }), { wide: true });
  d.box.classList.add('lightbox');
}

// ---------------------------------------------------------------- login

function showLogin(message) {
  $app.className = 'app om login-mode';
  const input = h('input', { class: 'om-input', type: 'password', placeholder: '登入密碼', autocomplete: 'current-password', autofocus: true, 'aria-label': '登入密碼' });
  const err = h('div', { class: 'om-field__error', role: 'alert' }, message || '');
  fill(
    $app,
    h(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          setToken(input.value.trim());
          try {
            await get('/config');
            location.reload();
          } catch {
            err.textContent = '密碼不正確。';
            input.select();
          }
        },
      },
      h('div', { class: 'login-mark' }, icon('sparkle')),
      h('div', { class: 'login-title' }, 'Agent Hub'),
      h('p', { class: 'login-text' }, '輸入中控台的登入密碼。密碼在啟動中控台時會印在終端機上。'),
      input,
      err,
      h('button', { class: 'om-btn om-btn--primary om-btn--lg om-btn--block', type: 'submit' }, '登入'),
    ),
  );
  setTimeout(() => input.focus(), 0);
}

// ------------------------------------------------------------ live data

async function loadMachines() {
  S.machines = await get('/machines');
  renderSidebar();
}

async function loadSessions() {
  const list = await get('/sessions');
  S.sessions = new Map(list.filter((s) => s.kimiSessionId || isLegacyClaude(s)).map((s) => [s.id, s]));
  renderSidebar();
}

function upsertSession(s) {
  if (!s.kimiSessionId && !isLegacyClaude(s)) return;
  const prev = S.sessions.get(s.id);
  S.sessions.set(s.id, s);
  renderSidebar();
  if (S.cur?.id === s.id) {
    const was = S.cur.summary?.status;
    S.cur.summary = s;
    S.cur.transcript.opts.agentName = nameFor(s);
    const tps = s.meta?.tps || 0;
    if (s.meta?.servedModel?.name !== prev?.meta?.servedModel?.name) S.cur.transcript.setServed(s.meta?.servedModel?.name);
    if (was !== s.status || tps !== (prev?.meta?.tps || 0)) S.cur.transcript.setStatus(s.status, busy(s.status) && !busy(was) ? Date.now() : null, tps);
    updateComposer();
    const apChanged = JSON.stringify(prev?.autoPause || null) !== JSON.stringify(s.autoPause || null);
    const schedChanged = JSON.stringify(prev?.scheduled || []) !== JSON.stringify(s.scheduled || []);
    if (prev?.title !== s.title || prev?.cwd !== s.cwd || apChanged) renderToolbar();
    if (apChanged || schedChanged) {
      S.autoPauseDraw?.();
      S.scheduleDraw?.();
    }
    if (was && busy(was) && !busy(s.status) && S.panel?.tab === 'changes') showChanges();
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'session':
      return upsertSession(m.session);
    case 'deleted':
      S.sessions.delete(m.sid);
      if (S.cur?.id === m.sid) go('#/');
      return renderSidebar();
    case 'batch':
      for (const x of m.items) onMessage(x);
      return;
    case 'snapshot': {
      const cur = S.cur;
      if (!cur || cur.id !== m.sid) return;
      if (m.error) return cur.loading ? go('#/') : undefined;
      cur.syncing = false;
      return applySnapshot(m.session);
    }
    case 'event':
    case 'patch':
    case 'delta':
    case 'reset': {
      const cur = S.cur;
      if (!cur || cur.id !== m.sid || cur.syncing) return;
      if (m.t === 'reset') return watchCurrent();
      if (m.seq <= cur.seq) return; // already in the snapshot
      if (m.seq !== cur.seq + 1) return watchCurrent();
      cur.seq = m.seq;
      const t = cur.transcript;
      if (m.t === 'event') t.add(m.ev);
      else if (m.t === 'patch') t.patch(m.id, m.fields);
      else t.delta(m.id, m.field, m.text);
      return;
    }
    case 'machine': {
      const i = S.machines.findIndex((x) => x.id === m.machine.id);
      const before = i === -1 ? null : S.machines[i];
      if (i === -1) S.machines.push(m.machine);
      else S.machines[i] = m.machine;
      renderSidebar();
      machinesDialog?.draw();
      if (S.route === 'home' && (!before || before.online !== m.machine.online || before.kimi?.available !== m.machine.kimi?.available)) showHome();
      return;
    }
    case 'machines':
      return loadMachines().then(() => machinesDialog?.draw());
    case 'claude':
    case 'deepseek':
      // A key was set or removed (here or in another window): the models of
      // that source come and go.
      S[m.t] = m.account;
      if (S.config) S.config[m.t] = m.account;
      refreshCatalogs();
      return;
    case 'kimi.session': {
      const mc = machineById(m.machineId);
      if (!mc) return;
      mc.sessions ??= [];
      if (m.removed) mc.sessions = mc.sessions.filter((x) => x.id !== m.id);
      else {
        const i = mc.sessions.findIndex((x) => x.id === m.session.id);
        if (i === -1) mc.sessions.unshift(m.session);
        else mc.sessions[i] = m.session;
      }
      return renderSidebar();
    }
  }
}

// ------------------------------------------------------------- startup

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    if (dialogClose) return dialogClose();
    if (menuOpen()) return closeMenu();
    if ($app.classList.contains('drawer')) return closeDrawer();
    if (S.cur && busy(S.cur.summary?.status) && !e.target.closest?.('input, textarea')) interrupt();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    go('#/');
  }
});
window.addEventListener('focus', updateTitle);

async function start() {
  try {
    applyTheme(savedTheme(), { save: false });
    // The look as this browser chose it is already on (index.html); a browser
    // that has not chosen yet takes the one the hub keeps, when it keeps one.
    localStorage.removeItem('hubLook'); // what the modes used to set
  } catch {}
  try {
    S.config = await get('/config');
    S.claude = S.config.claude || null;
    S.deepseek = S.config.deepseek || null;
    const kept = S.config.settings?.look;
    if (!savedLook() && LOOKS[kept] && kept !== 'kimi') applyLook(kept);
    resetHomeChoices();
  } catch (err) {
    if (err.status === 401) return showLogin();
    fill($view, h('div', { class: 'loading' }, `連不上中控台：${err.message}`));
    return;
  }
  await Promise.all([loadMachines(), loadSessions()]).catch(fail);
  socket = connect(onMessage, (ok) => {
    const was = S.online;
    S.online = ok;
    S.socketOpen = ok;
    drawFoot();
    if (ok) watchCurrent();
    if (ok && !was) Promise.all([loadMachines(), loadSessions()]).catch(() => {});
  });
  route();
}

start();
