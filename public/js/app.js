// Agent Hub — Kimi Code on all your machines, DeepSeek models inside that Kimi
// (billed to a gateway's API key), and Claude through the Claude API (run by
// the hub on this computer), in one window.
import { h, fill, icon, relTime, shortPath, baseName, copyText, clockTime, fmtCountdown } from './dom.js';
import { get, post, put, del, patch as apiPatch, connect, setToken } from './api.js';
import { renderHunks, parseUnifiedDiff, renderMarkdown } from './markdown.js';
import { openMenu, closeMenu, menuOpen, pointAnchor } from './menu.js';
import { Transcript, todoList, warmTranscript } from './transcript.js';
import { Composer, PERMISSION_LABELS, CLAUDE_PERMISSION_LABELS, EFFORT_LABELS, permissionLabels, autoPauseStatus, whenText, agentName, fmtUsd } from './composer.js';
import { ArtifactView, downloadHtml, htmlTitle } from './artifacts.js';
import { PROVIDERS, PROVIDER_LABELS, isProvider, busy, providerOf, conversationIdOf, isLeaf, modelConfigOf, turnOf } from './providers.js';
import { driftOf, contextHint, dismissContextHint } from './model-drift.js';
import { turnStartTs } from './window-state.js';
import { salvageView, damagedView, damagedHeadline, backupPath, configProblemText, UNSAVED_LABEL, BACKUP_DIR } from './damaged.js';
import { fadeColors } from './color-fade.js';
import { buildRows, newChildIndex, rememberChildren, parseSideSections, sidebarSections, rowProviderView } from './sidebar-model.js';
import { ClusterPage, openClusterDialog, openClusterList, drawClusterNote, rememberCluster, loadClustersOf, clusterHash } from './cluster.js';
import { DEFAULT_SUBAGENT, modeIn, subagentPayload, subagentChoiceText, subagentModeText, providerDefaultsFor as providerDefaultsOf, runWithRollback } from './home-state.js';

const S = {
  config: null,
  machines: [],
  sessions: new Map(), // hub sessions: Kimi conversations taken over by the hub, and Claude conversations
  claude: null, // the Claude API account: { hasKey, keyHint, keySource, defaults, webTools }
  claudeModels: null, // { defaultModel, models } this key can use
  deepseek: null, // the DeepSeek account: { gateway, hasKey, keyHint, keyCount, gateways, activity, defaults }
  deepseekModels: null, // { gateway, defaultModel, models } of the gateway in use
  modelCatalog: null, // GET /api/models?session=… for the open conversation
  cur: null, // { id, summary, seq, transcript }
  route: null,
  panel: null, // { tab: 'artifact' | 'changes', path, version, wide }
  artifacts: [],
  home: loadHome(),
  query: '',
  seen: new Map(), // row key -> status, for "needs you" notifications
  online: true,
};

const INIT_PROMPT =
  '請分析這個專案：找出主要的設定檔、技術架構、建置與測試方式、程式碼的組織方式與開發慣例，然後把整理好的內容寫進專案根目錄的 AGENTS.md。已經有這個檔案的話，先讀它，保留仍然正確的部分，整理成一份完整的新版本。AGENTS.md 是給 AI coding agent 看的說明，讀者完全不了解這個專案。請使用這個專案的註解與文件主要使用的語言。';
const CLAUDE_INIT_PROMPT =
  '請分析這個專案：找出主要的設定檔、技術架構、建置與測試方式、程式碼的組織方式與開發慣例，然後把整理好的內容寫進專案根目錄的 CLAUDE.md。已經有這個檔案的話，先讀它，保留仍然正確的部分，整理成一份完整的新版本。CLAUDE.md 是給 Claude 看的專案說明，之後在這個資料夾開的 Claude 對話一開始就會讀到它；讀者完全不了解這個專案。請使用這個專案的註解與文件主要使用的語言。';

// ------------------------------------------------------------- helpers

function loadHome() {
  try {
    return JSON.parse(localStorage.getItem('hubHome') || '{}');
  } catch {
    return {};
  }
}
function loadSideSections() {
  try {
    return parseSideSections(localStorage.getItem('hubSideSections'));
  } catch {
    return parseSideSections(null);
  }
}
const sideSections = loadSideSections();
function toggleSideSection(key) {
  sideSections[key] = !sideSections[key];
  try {
    localStorage.setItem('hubSideSections', JSON.stringify(sideSections));
  } catch {}
  lastSidebar = '';
  renderSidebar();
}
// Older local pins are left in place (hubPins is not rewritten or deleted);
// the two source categories have replaced pinning in the list.

// New conversations start from the defaults in 設定; what is picked on the
// home screen applies to that one conversation.
const defaults = () => S.config?.settings?.defaults || {};
// defaults.byProvider is authoritative per provider. Top-level defaults are
// the legacy Kimi defaults; Claude/DeepSeek fall back to their account
// defaults only when an old server has no byProvider entry.
function providerDefaultsFor(provider, d = defaults()) {
  const account = provider === 'claude' ? S.claude?.defaults : provider === 'deepseek' ? S.deepseek?.defaults : null;
  return providerDefaultsOf(provider, d, account);
}
// A home choice made in this page is a temporary override. It must not be
// replaced by a server default arriving with config/machine updates, but a
// fresh page load starts from the server default (or the legacy local value
// only when the server has none).
let homeProviderTouched = false;
function resetHomeChoices({ fromSettings = false } = {}) {
  // A temporary choice made in this page (provider, model, effort, …) stays
  // until a new conversation is created or the settings dialog saves; an
  // account/config update must not silently replace it.
  if (homeProviderTouched && !fromSettings) {
    updateHomeComposer();
    return;
  }
  const d = defaults();
  const serverProvider = isProvider(d.provider) ? d.provider : '';
  const currentProvider = isProvider(S.home.provider) ? S.home.provider : isProvider(S.home.agent) ? S.home.agent : '';
  const explicit = serverProvider && (!homeProviderTouched || fromSettings) ? serverProvider : currentProvider;
  // Every provider has its own default; the selected provider only chooses
  // which home opens. Kimi falls back to legacy top-level defaults;
  // Claude/DeepSeek fall back to their account defaults on old data.
  Object.assign(S.home, providerDefaultsFor('kimi', d), explicit ? { provider: explicit, agent: explicit } : {});
  S.home.claude = { ...(S.home.claude || {}), ...providerDefaultsFor('claude', d) };
  S.home.deepseek = { ...(S.home.deepseek || {}), ...providerDefaultsFor('deepseek', d) };
  saveHome();
  updateHomeComposer();
}

function saveHome() {
  try {
    localStorage.setItem('hubHome', JSON.stringify(S.home));
  } catch {}
}

const machineById = (id) => S.machines.find((m) => m.id === id);

const isClaude = (s) => providerOf(s) === 'claude';
const isDeepseek = (s) => providerOf(s) === 'deepseek';
const agentOf = (s) => providerOf(s);
const nameFor = (s) => agentName(agentOf(s));
const hostName = () => S.config?.hostname || '這台電腦';

function toast(text, { action, onAction, kind = '' } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, h('span', null, text), action ? h('button', { class: 'om-btn om-btn--plain om-btn--sm', type: 'button', onclick: () => (onAction(), el.remove()) }, action) : null);
  $toasts.append(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4600);
}
const fail = (err) => toast(err?.message || String(err), { kind: 'error' });
// What the cluster screens (cluster.js) use from this page.
const clusterCtx = {
  dialog: (...a) => dialog(...a),
  confirmDialog: (...a) => confirmDialog(...a),
  toast,
  fail,
  go: (hash) => go(hash),
  parentTitle: (id) => S.sessions.get(id)?.title || '',
  session: (id) => S.sessions.get(id),
  onTitle: (c) => renderClusterToolbar(c),
  onCreated: (c) => S.cur?.id === c.parentId && drawCurrentClusterNote(),
};

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
// Conversation files that are damaged on disk and could not be loaded (see drawDamaged).
const $damaged = h('div', { class: 'damaged-slot', hidden: true });
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
  $damaged,
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

// ------------------------------------------------------------- motion
// Durations and curves are the --dur-* / --ease-* tokens in app.css; JS that
// animates reads them from there, so a change (or reduced motion) reaches both.

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssMs = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0;
};
const cssValue = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The sidebar and the conversation next to it slide to their new places.
// The layout has already changed (once); each moves from where it was with a
// transform only, so nothing is laid out while it moves.
function slideSidebar(closing) {
  if (reducedMotion() || !$main.animate) return;
  const w = $sidebar.getBoundingClientRect().width || parseFloat(cssValue('--side-w')) || 248;
  const timing = { duration: cssMs('--dur-slow'), easing: cssValue('--ease-move') || 'ease' };
  const width = closing ? parseFloat(cssValue('--side-w')) || 248 : w;
  $app.classList.add('sliding');
  const moves = [
    $main.animate([{ transform: `translateX(${closing ? width : -width}px)` }, { transform: 'none' }], timing),
    $sidebar.animate(closing ? [{ transform: 'none' }, { transform: 'translateX(-100%)' }] : [{ transform: 'translateX(-100%)' }, { transform: 'none' }], timing),
  ];
  Promise.allSettled(moves.map((m) => m.finished)).then(() => $app.classList.remove('sliding'));
}

// After picking a conversation on a phone.
function closeDrawer() {
  $app.classList.remove('drawer');
}

function toggleSidebar(open) {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  if (mobile) $app.classList.toggle('drawer', open ?? !$app.classList.contains('drawer'));
  else {
    const wasClosed = $app.classList.contains('no-sidebar');
    $app.classList.toggle('no-sidebar', open === undefined ? undefined : !open);
    if ($app.classList.contains('no-sidebar') !== wasClosed) slideSidebar($app.classList.contains('no-sidebar'));
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

// ---- palette (independent of the current provider) -----------------------
// The user's chosen look is a UI preference, not conversation state. It is
// stored per browser (like the theme and home choices) and applied before the
// first paint by index.html. Only the explicit appearance control writes it.
const LOOKS = ['kimi', 'claude', 'deepseek'];
const LOOK_LABELS = { kimi: 'Kimi（米色）', claude: 'Claude（近黑）', deepseek: 'DeepSeek（藍白）' };
const LOOK_COLORS = { claude: '#141413', deepseek: '#ffffff' };
function palette() {
  try {
    const saved = localStorage.getItem('hubPalette');
    if (LOOKS.includes(saved)) return saved;
    // The old key was auto-written on every route; treat it as "the look the
    // user last saw" once, then stop writing it.
    const legacy = localStorage.getItem('hubLook');
    const look = LOOKS.includes(legacy) ? legacy : 'kimi';
    localStorage.setItem('hubPalette', look);
    return look;
  } catch {
    return 'kimi';
  }
}
function applyLook(look, { save = false } = {}) {
  const next = LOOKS.includes(look) ? look : 'kimi';
  document.documentElement.dataset.look = next;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.dataset.base ||= m.content;
    m.content = next === 'kimi' ? m.dataset.base : LOOK_COLORS[next];
  }
  if (save) {
    try {
      localStorage.setItem('hubPalette', next);
    } catch {}
  }
}
// The current view's provider, for labels and diagnostics only. No color rule
// in app.css may depend on it.
function applyProvider(provider) {
  const root = document.documentElement;
  if (isProvider(provider)) root.dataset.provider = provider;
  else delete root.dataset.provider;
}

// ------------------------------------------------------------- sidebar

// The sidebar's rows are worked out in sidebar-model.js. Children seen by this
// page are remembered there, so a subagent whose hub record disappears with its
// parent (or is not in the list yet) never turns into an external row.
const childNatives = newChildIndex();
const knownChainNative = new Set(); // old native ids seen in a leaf's chain

function rows() {
  rememberChildren(childNatives, S.sessions.values());
  return buildRows({ sessions: S.sessions.values(), machines: S.machines, knownChainNative, children: childNatives });
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
  // Both categories are display-only: 聊天室 is one updatedAt-ordered list,
  // 子session is native/external sessions only (subagent children stay in their
  // parent's 子代理 panel). A search opens both for the moment without
  // touching the saved choice.
  const { searching, list, sections: groups } = sidebarSections(all, { query: S.query, saved: sideSections });
  const multi = S.machines.length > 1;
  const sections = groups.map((g) => [g.key, g.label, g.rows, g.open]);
  const current = S.cur?.summary;
  // Conversations update every few seconds; redraw only what would change.
  const sig = JSON.stringify([
    current?.id,
    multi,
    all.length,
    S.query,
    S.machines.some((m) => m.online),
    [sideSections.chat, sideSections.sub],
    sections.map(([key, , rs, isOpen]) => [key, isOpen, rs.map((r) => [r.key, r.title, r.cwd, r.status, r.offline, r.provider, r.conversationId, rowProviderView(r).text, r.hub?.clusterRole === 'worker' ? r.hub.clusterId : null, r.childWaiting, r.kimi?.owner || r.hub?.meta?.owner, r.machine?.name, relTime(r.updatedAt), salvageView(r.hub?.meta?.salvaged)?.title])]),
  ]);
  if (sig === lastSidebar) return;
  lastSidebar = sig;
  const items = [];
  if (!list.length) {
    items.push(h('div', { class: 'side-empty' }, all.length ? '沒有符合搜尋的對話。' : S.machines.some((m) => m.online) ? '在任一台電腦的 Kimi 裡開一個對話，或在這裡開新對話；終端機與外部 session 會放在「子session」。' : '在這裡開一個 Claude 對話，或連接一台電腦使用 Kimi，對話會出現在這裡。'));
  }
  for (const [key, label, rs, isOpen] of sections) {
    const folded = !isOpen;
    const head = h(
      searching ? 'div' : 'button',
      {
        class: 'om-sidebar__section side-group-head',
        type: searching ? null : 'button',
        'aria-expanded': String(!folded),
        title: searching ? '搜尋時暫時展開，不會改動已保存的摺疊設定' : folded ? `展開${label}` : `收合${label}`,
        onclick: searching ? null : () => toggleSideSection(key),
      },
      icon('chev', 'chev'),
      h('span', { class: 'side-group-name' }, label),
      h('span', { class: 'side-group-count' }, String(rs.length)),
    );
    items.push(h('div', { class: `side-group${folded ? '' : ' open'}` }, head, folded ? null : rs.map((r) => sideRow(r, current, multi))));
  }
  fill($list, ...items);
  $search.parentElement.hidden = all.length < 8 && !S.query;
  drawFoot();
  updateTitle();
}

function sideRow(r, current, multi) {
  const href = r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine.id}/${r.kimi.id}`;
  const active = current && ((r.hub && (r.hub.id === current.id || (r.conversationId && r.conversationId === conversationIdOf(current)))) || (r.kimi && current.kimiSessionId === r.kimi.id && current.machineId === r.machine?.id));
  const owner = r.kimi?.owner || r.hub?.meta?.owner;
  const machineName = r.machine?.name || (r.hub?.machineId ? r.hub.meta?.machineName || machineById(r.hub.machineId)?.name : null);
  const sub = [owner === 'tui' ? '終端機' : null, multi && machineName ? machineName : null, r.cwd ? baseName(r.cwd) : null].filter(Boolean).join(' · ');
  // While a turn runs the tag says what is working and what comes next; idle,
  // it names only the provider the next turn will use (never a stale one).
  const view = rowProviderView(r);
  const providerTag = h('span', { class: `row-tag ${view.provider}${view.pending ? ' pending' : ''}`, title: view.title }, view.text);
  // A conversation whose file was damaged and repaired says so, where it is listed.
  const repaired = salvageView(r.hub?.meta?.salvaged);
  const repairedTag = repaired ? h('span', { class: `row-tag salvaged${repaired.unsaved ? ' unsaved' : ''}`, title: repaired.title }, repaired.label) : null;
  // A worker of a cluster (叢集) says so; the cluster page lists its siblings.
  const clusterTag = r.hub?.clusterRole === 'worker' ? h('span', { class: 'row-tag cluster', title: '叢集的工作者對話：它的任務、進度與合併都在叢集頁' }, '叢集') : null;
  return h(
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
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, r.title), h('span', { class: `row-sub${view.pending ? ' pending' : ''}` }, providerTag, clusterTag, repairedTag, h('span', { class: 'row-sub-text' }, sub || relTime(r.updatedAt)))),
    r.status === 'awaiting_permission'
      ? h('span', { class: 'om-badge om-badge--warning' }, '需要你')
      : r.childWaiting
        ? h('span', { class: 'om-badge om-badge--warning child-waiting', title: '這個對話的子代理在等你核准；打開它的「子代理」面板處理' }, '子代理需要你')
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
  );
}


// Right-click (or the … button) on a conversation in the sidebar.
function rowMenu(r, anchor) {
  if (r.provider === 'claude') return claudeRowMenu(r, anchor);
  const href = r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine?.id}/${r.kimi?.id}`;
  const reachable = r.machine?.online && r.machine.kimi?.available;
  const kid = r.kimi?.id || r.hub?.kimiSessionId;
  const mid = r.machine?.id || r.hub?.machineId;
  openMenu(
    anchor,
    [
      { label: '在新分頁開啟', onSelect: () => window.open(`${location.pathname}${href}`, '_blank', 'noopener') },
      { label: '重新命名…', disabled: !reachable, onSelect: () => renameRow(r, mid, kid) },
      { label: '分叉', disabled: !reachable, onSelect: () => forkRow(r) },
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
      { label: '分叉', onSelect: () => forkRow(r) },
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

// 分叉: the conversation copied into a new one, opened right away. One that
// Kimi has but the Hub has not taken over yet is taken over first, so the fork
// is made the same way as from an open conversation.
const forking = new Set();
async function forkRow(r) {
  const key = r.hub?.id || r.kimi?.id;
  if (!key || forking.has(key)) return;
  forking.add(key);
  try {
    const id = r.hub?.id || (await post(`/machines/${r.machine.id}/kimi/${r.kimi.id}/attach`)).id;
    const { session } = await post(`/sessions/${id}/command`, { name: 'fork', args: '' });
    if (!session?.id) throw new Error('分叉沒有回傳新的對話');
    toast('已分叉成新對話');
    go(`#/s/${session.id}`);
  } catch (err) {
    fail(err);
  } finally {
    forking.delete(key);
  }
}

async function deleteRow(r, mid, kid) {
  const ok = await confirmDialog({ title: `要刪除「${r.title}」嗎？`, body: '它會從中控台和 Kimi 的對話清單移除。Kimi 會把它封存，紀錄仍留在那台電腦上。', action: '刪除', destructive: true });
  if (!ok) return;
  const here = S.cur?.summary && S.cur.summary.kimiSessionId === kid;
  try {
    await post(`/machines/${mid}/kimi/${kid}/archive`);
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
  const look = palette();
  const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'default';
  openMenu(
    anchor,
    [
      { section: '外觀配色（不隨模型改變）' },
      ...LOOKS.map((id) => ({
        label: LOOK_LABELS[id],
        checked: look === id,
        onSelect: () => {
          fadeColors(() => {
            applyLook(id, { save: true });
            if (id === 'kimi') applyTheme(savedTheme(), { save: false });
          });
          toast(`配色：${LOOK_LABELS[id]}`);
        },
      })),
      // Light/dark are Kimi's own variants. Claude and DeepSeek keep their
      // fixed visuals, so showing them there would do nothing.
      ...(look === 'kimi'
        ? [
            { separator: true },
            { section: 'Kimi 主題' },
            { label: '跟系統一樣', checked: t === 'auto', onSelect: () => fadeColors(() => applyTheme(null)) },
            { label: '淺色', checked: t === 'light', onSelect: () => fadeColors(() => applyTheme('light')) },
            { label: '深色', checked: t === 'dark', onSelect: () => fadeColors(() => applyTheme('dark')) },
          ]
        : []),
      { separator: true },
      canNotify ? { label: '開啟通知', description: 'Kimi 或 Claude 需要你的時候通知你', onSelect: () => Notification.requestPermission().then(() => toast('已開啟通知')) } : null,
      { label: '設定…', description: '新對話預設的供應商、模型、思考強度與權限', onSelect: openSettings },
      { label: 'Claude API…', description: 'API key 與 Claude 新對話的預設', onSelect: claudeDialog },
      { label: 'DeepSeek…', description: '閘道、API key 與 DeepSeek 新對話的預設', onSelect: deepseekDialog },
      { label: 'Google Drive 備份…', description: '/backup 把專案資料夾備份到你的 Google Drive', onSelect: gdriveDialog },
      { label: 'GitHub…', description: '讓 Claude 和 Kimi 用你的 GitHub 帳號', onSelect: githubDialog },
      { label: '連接電腦…', onSelect: openMachines },
      { label: '登出', destructive: true, onSelect: logout },
    ].filter(Boolean),
    { side: 'auto', width: 260 },
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
    // A subagent waiting for approval is invisible in the list (it has no row);
    // the parent's row says so, and it is said once, like the parent's own.
    const childKey = `${r.key}#child`;
    const prevChild = S.seen.get(childKey);
    S.seen.set(childKey, r.childWaiting ? 'awaiting_permission' : '');
    if (r.childWaiting && prevChild === '') {
      const goChild = () => go(r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine.id}/${r.kimi.id}`);
      const hereNow = S.cur?.summary && r.hub?.id === S.cur.summary.id && document.hasFocus();
      if (!hereNow) toast(`「${r.title}」的子代理需要你核准`, { action: '查看', onAction: goChild });
      notify(`${PROVIDER_LABELS[r.provider] || 'Agent Hub'} 的子代理需要你`, r.title, goChild);
    }
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
    notify(`${r.claude ? 'Claude' : r.deepseek ? 'DeepSeek' : 'Kimi'} 需要你`, r.title, open);
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
  clusterPage?.destroy();
  clusterPage = null;
  let m;
  if ((m = hash.match(/^#\/s\/([\w-]+)/))) return openSession(m[1]);
  if ((m = hash.match(/^#\/cluster\/([\w-]+)/))) return showCluster(m[1]);
  if ((m = hash.match(/^#\/k\/([\w-]+)\/([\w-]+)/))) return attachAndOpen(m[1], m[2]);
  if (hash.startsWith('#/artifacts')) return showArtifacts();
  return showHome();
}

// A cluster (叢集): its workers, their time, the shared memory, stop and merge.
let clusterPage = null;
function showCluster(cid) {
  applyProvider(null);
  leaveSession();
  hidePanel();
  S.route = `cluster:${cid}`;
  renderSidebar();
  renderClusterToolbar(null);
  clusterPage = new ClusterPage(clusterCtx, cid);
  fill($view, clusterPage.el);
  clusterPage.load();
}

function renderClusterToolbar(c) {
  if (!S.route?.startsWith('cluster:')) return;
  const parent = c ? S.sessions.get(c.parentId) : null;
  fill($toolbar, sidebarToggle(), h('div', { class: 'toolbar-titles' }, h('div', { class: 'om-toolbar__title' }, '叢集'), h('div', { class: 'om-toolbar__subtitle' }, [parent?.title, c?.id].filter(Boolean).join(' · '))));
}

// All pages Kimi made, across conversations, like Claude's Artifacts list.
async function showArtifacts() {
  applyProvider(null);
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
    applyProvider(providerOf(s));
    if (s.continuedTo) {
      const leaf = await resolveLeaf(s);
      if (leaf?.id) return location.replace(`#/s/${leaf.id}`);
    }
    if (S.route === `k:${kimiSessionId}`) location.replace(`#/s/${s.id}`);
  } catch (err) {
    fill($view, h('div', { class: 'loading' }, err.message));
  }
}

// ---------------------------------------------------------------- home

let homeComposer = null;
const modelCatalogs = new Map(); // query key -> { at, data }
let homeCatalog = null;
let homeCatalogKey = '';
let homeCatalogToken = 0;

function homeMachine() {
  const ready = S.machines.filter((m) => m.online && m.kimi?.available);
  return machineById(S.home.machineId && ready.some((m) => m.id === S.home.machineId) ? S.home.machineId : ready[0]?.id) || null;
}

// The provider chosen for the next new conversation. The palette has nothing
// to do with this value.
function homeProvider() {
  const stated = S.home.provider || S.home.agent;
  if (isProvider(stated)) return stated;
  const kimi = S.machines.some((m) => m.online && m.kimi?.available);
  if (kimi) return 'kimi';
  if (S.claude?.hasKey) return 'claude';
  if (S.deepseek?.hasKey) return 'deepseek';
  return S.machines.length ? 'kimi' : 'claude';
}
function setHomeProvider(provider, { touch = true } = {}) {
  if (!isProvider(provider)) return;
  S.home.provider = provider;
  S.home.agent = provider; // backward-compatible read for older builds
  if (touch) homeProviderTouched = true;
  saveHome();
}
function homeState(provider = homeProvider()) {
  if (provider === 'claude') return (S.home.claude ??= {});
  if (provider === 'deepseek') return (S.home.deepseek ??= {});
  return S.home;
}
function homePlacement(provider = homeProvider()) {
  if (provider === 'claude') {
    const m = claudeHomeMachine();
    return { machine: m, cwd: claudeCwd(m), repo: claudeRepo(m), host: !m.id };
  }
  const m = homeMachine();
  return { machine: m, cwd: S.home.cwdByMachine?.[m?.id], repo: kimiRepo(m), host: false };
}
// The subagent for the next new conversation, as the three different things it
// can be (home-state.js): nothing chosen (the server's default applies), the
// native rules chosen on purpose, or a model.
function homeSubagentChoice() {
  const mode = modeIn(S.home);
  return { mode, value: mode === 'custom' ? S.home.subagent : null };
}
// A conversation's own: its meta has the key once the server has set it.
function sessionSubagentChoice(s) {
  const raw = Object.hasOwn(s?.meta || {}, 'subagent') ? s.meta.subagent : s?.subagent;
  const mode = raw === undefined ? 'default' : raw === null ? 'follow' : 'custom';
  return { mode, value: mode === 'custom' ? raw : null };
}
function modelNameOf(provider, id) {
  if (!id) return '';
  const group = homeCatalog?.byProvider?.[provider];
  const m = findModel(group?.models, id) || findModel(S.modelCatalog?.byProvider?.[provider]?.models, id);
  return m?.name || String(id).split('/').pop();
}

// GET /api/models?session=<id> or ?machine=<id>: the one catalog shared by
// the home, the session control and the subagent dialog.
function emptyCatalog(reason = '') {
  const providers = PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id], available: false, reason: reason || '模型清單尚未載入', models: [], defaultModel: '' }));
  return { providers, byProvider: Object.fromEntries(providers.map((p) => [p.id, p])), models: [], error: reason };
}
function normalizeModel(provider, raw, key) {
  if (typeof raw === 'string') raw = { id: raw };
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.model || raw.value || key || '';
  if (!id) return null;
  const efforts = Array.isArray(raw.efforts) ? raw.efforts : Array.isArray(raw.support_efforts) ? raw.support_efforts : Array.isArray(raw.thinking) ? raw.thinking : [];
  return {
    id: String(id),
    alias: raw.alias || '',
    name: raw.name || raw.display_name || raw.label || String(id).split('/').pop(),
    provider,
    efforts,
    defaultEffort: raw.defaultEffort ?? raw.default_effort ?? raw.default ?? '',
    available: raw.available !== false && raw.disabled !== true,
    reason: raw.reason || raw.disabledReason || raw.why || '',
    image: Boolean(raw.image ?? raw.supportsImages),
    context: raw.context ?? raw.max_context_size ?? null,
    maxOut: raw.maxOut ?? raw.max_output_size ?? null,
    deepseek: Boolean(raw.deepseek),
    priced: Boolean(raw.priced),
    adaptive: Boolean(raw.adaptive),
  };
}
function normalizeCatalog(raw) {
  const out = emptyCatalog();
  if (!raw || typeof raw !== 'object') return out;
  let groups = raw.providers ?? raw.groups ?? raw;
  let flat = null;
  if (Array.isArray(raw)) {
    if (raw.some((x) => x && (x.provider || x.agent) && (x.model || x.id))) flat = raw;
    else groups = Object.fromEntries(raw.filter(Boolean).map((p) => [p.id || p.provider || p.name, p]));
  } else if (Array.isArray(raw.models) && raw.models.some((x) => x && (x.provider || x.agent))) {
    flat = raw.models;
  }
  if (Array.isArray(groups)) groups = Object.fromEntries(groups.filter(Boolean).map((p) => [p.id || p.provider || p.name, p]));
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const id of PROVIDERS) {
      const g = groups[id] ?? groups[`${id}_models`];
      if (!g || typeof g !== 'object') continue;
      let list = g.models ?? g.list ?? g.items ?? g.availableModels ?? [];
      if (!Array.isArray(list) && list && typeof list === 'object') list = Object.entries(list).map(([key, v]) => (typeof v === 'string' ? { id: v } : { id: key, ...v }));
      const available = g.available ?? g.enabled ?? g.hasKey ?? true;
      const reason = g.reason || g.why || g.error || '';
      const p = out.byProvider[id];
      p.available = Boolean(available);
      p.reason = reason || (p.available ? '' : '這個供應商目前不可用');
      p.defaultModel = g.defaultModel || g.default_model || g.default || '';
      p.models = (Array.isArray(list) ? list : []).map((m) => normalizeModel(id, m)).filter(Boolean);
    }
  }
  if (Array.isArray(flat)) {
    for (const m of flat) {
      const id = m?.provider || m?.agent;
      if (!isProvider(id)) continue;
      const p = out.byProvider[id];
      const model = normalizeModel(id, m);
      if (!model) continue;
      if (!p.models.some((x) => x.id === model.id)) p.models.push(model);
      p.available = p.available || m.available !== false;
    }
  }
  // A provider's models may be given directly as an array on the root.
  for (const [id, value] of Object.entries(raw)) {
    if (!isProvider(id) || !Array.isArray(value) || value === groups?.[id]) continue;
    const p = out.byProvider[id];
    p.models = value.map((m) => normalizeModel(id, m)).filter(Boolean);
    p.available = p.models.length > 0;
  }
  out.providers = PROVIDERS.map((id) => out.byProvider[id]);
  out.models = out.providers.flatMap((p) =>
    p.models.map((m) => ({
      ...m,
      provider: p.id,
      providerLabel: p.label,
      providerAvailable: p.available,
      disabled: !p.available || m.available === false,
      reason: m.reason || (p.available ? '' : p.reason),
    })),
  );
  return out;
}
async function loadModels({ session = '', machine = '', force = false } = {}) {
  const query = session ? `?session=${encodeURIComponent(session)}` : machine ? `?machine=${encodeURIComponent(machine)}` : '';
  const key = query || 'all';
  const hit = modelCatalogs.get(key);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.data;
  const raw = await get(`/models${query}`);
  const data = normalizeCatalog(raw);
  modelCatalogs.set(key, { at: Date.now(), data });
  return data;
}
const sameModel = (m, id) => Boolean(m) && (m.id === id || (m.alias && m.alias === id));
const modelKey = (m) => m.alias || m.id;
const findModel = (list, id) => (list || []).find((m) => sameModel(m, id)) || null;
const groupedModels = (catalog, provider) => catalog?.byProvider?.[provider]?.models || [];

function updateHomeComposer() {
  if (!homeComposer) return;
  const provider = homeProvider();
  const st = homeState(provider);
  const placement = homePlacement(provider);
  const group = homeCatalog?.byProvider?.[provider];
  const models = group?.models || [];
  const chosen = st.model && models.some((m) => sameModel(m, st.model)) ? st.model : group?.defaultModel || '';
  const folderName = placement.repo ? placement.repo.full : placement.cwd === null ? '新資料夾' : placement.cwd ? baseName(placement.cwd) : '新資料夾';
  homeComposer.update({
    agent: provider,
    provider,
    machineName: provider === 'claude' ? (placement.machine.id ? placement.machine.name : hostName()) : placement.machine?.name,
    folderName,
    folderIcon: placement.repo ? 'branch' : 'folder',
    models: homeCatalog?.models || [],
    providers: homeCatalog?.providers || [],
    defaultModel: group?.defaultModel,
    model: chosen,
    effort: st.effort,
    permission: st.permission || 'manual',
    planMode: Boolean(st.planMode),
    ...(({ mode, value }) => ({ subagentMode: mode, subagent: value }))(homeSubagentChoice()),
    modelsLoading: !homeCatalog,
  });
}

async function ensureHomeModels(force = false) {
  const placement = homePlacement(homeProvider());
  const machine = placement.machine?.id || '';
  const key = machine || 'host';
  if (!force && homeCatalog && homeCatalogKey === key) {
    updateHomeComposer();
    return;
  }
  const token = ++homeCatalogToken;
  try {
    const data = await loadModels({ machine, force });
    if (token !== homeCatalogToken || S.route !== 'home') return;
    homeCatalog = data;
    homeCatalogKey = key;
  } catch (err) {
    if (token !== homeCatalogToken || S.route !== 'home') return;
    homeCatalog = emptyCatalog(err.message);
    homeCatalogKey = key;
    toast(`讀不到模型清單：${err.message}`, { kind: 'error' });
  }
  updateHomeComposer();
}

// The key file the Hub could not use: said where the key would be asked for.
function configDamagedNote(damaged) {
  const text = configProblemText(damaged);
  return text ? h('div', { class: 'callout danger small config-damaged', role: 'alert' }, icon('alert'), h('div', { class: 'callout-text' }, text)) : null;
}

function homeNotice(provider, placement) {
  if (provider === 'claude' && !S.claude?.hasKey)
    return h(
      'div',
      { class: 'callout claude-key' },
      icon('alert'),
      h('div', { class: 'callout-text' }, configProblemText(S.claude?.damaged) || '還沒有設定 Claude API key。中控台用你在 Claude Console 建立的 API key 呼叫 Claude API，按用量從 Console 帳戶的額度扣款。'),
      h('button', { class: 'om-btn om-btn--primary om-btn--sm', type: 'button', onclick: claudeDialog }, '設定 API key…'),
    );
  if (provider === 'deepseek' && !S.deepseek?.hasKey)
    return h(
      'div',
      { class: 'callout deepseek-key' },
      icon('alert'),
      h('div', { class: 'callout-text' }, configProblemText(S.deepseek?.damaged) || `還沒有設定 ${dsLabel()} 的 API key。DeepSeek 對話用這個閘道號池裡的 key 呼叫 DeepSeek 模型，費用算在這個閘道的帳戶；不會用到 Kimi 訂閱。`),
      h('button', { class: 'om-btn om-btn--primary om-btn--sm', type: 'button', onclick: deepseekDialog }, '設定 API key…'),
    );
  if (provider !== 'claude' && !placement.machine)
    return h(
      'div',
      { class: 'callout' },
      icon('alert'),
      h('div', { class: 'callout-text' }, S.machines.length ? '連接的電腦目前都沒有可用的 Kimi。確認那台電腦已安裝 Kimi Code 並用 kimi login 登入（需要時中控台會自己啟動它）；也可以直接改用 Claude。' : '還沒有連接電腦。Kimi 與 DeepSeek 需要一台執行 Kimi Code 的電腦；Claude 可以在中控台這台電腦直接執行。'),
      h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: openMachines }, '連接電腦…'),
    );
  return null;
}
function homeHint(provider, placement) {
  if (provider === 'claude') {
    if (placement.repo) return `會把 ${placement.repo.full} clone 到「${placement.machine.id ? placement.machine.name : hostName()}」上，在${placement.repo.branch ? `分支 ${placement.repo.branch}` : '一個新分支'}上工作，所有程式碼都 commit 並 push 到那裡。`;
    return placement.machine.id ? `工具在「${placement.machine.name}」上執行，用中控台的 Claude API key 按用量計費。` : `在中控台這台電腦（${hostName()}）上執行，用 Claude API key 按用量計費。`;
  }
  if (provider === 'deepseek') {
    const m = placement.machine;
    return m ? `會在「${m.name}」上的 Kimi Code 用 DeepSeek 模型執行，費用算在 ${dsLabel()} 的 API key，不用 Kimi 訂閱。` : 'DeepSeek 對話在你電腦上的 Kimi Code 裡執行，只是把模型換成 DeepSeek；先連接一台有 Kimi 的電腦。';
  }
  const m = placement.machine;
  return m ? `會在「${m.name}」上的 Kimi 執行，用那台電腦登入的帳號。` : 'Kimi 只在你自己的電腦上登入；先連接一台有執行中 Kimi 的電腦。';
}

async function showHome() {
  leaveSession();
  S.route = 'home';
  hidePanel();
  renderToolbar();
  const provider = homeProvider();
  applyProvider(provider);
  const placement = homePlacement(provider);
  homeComposer ??= new Composer({
    home: true,
    placeholder: '要做什麼？輸入 / 看指令',
    onSend: startHomeSession,
    onCommand: homeCommand,
    onPickUploadDir: (anchor, cur, set) => {
      const place = homePlacement(homeProvider());
      const m = place.machine || { id: null, name: hostName(), home: S.config?.home };
      if (homeProvider() === 'claude' || place.machine) uploadDirMenu(anchor, m, null, cur, set);
    },
    onStop: () => {},
    onConfig: homeConfig,
    onPickMachine: machineMenu,
    onPickFolder: folderMenu,
    onOpenSubagent: () => openSubagentDialog({ home: true }),
    onError: (t) => toast(t),
  });
  homeComposer.opts.onPickMachine = (anchor) => (homeProvider() === 'claude' ? claudeMachineMenu : machineMenu)(anchor);
  homeComposer.opts.onPickFolder = (anchor) => (homeProvider() === 'claude' ? claudeFolderMenu : folderMenu)(anchor);
  homeComposer.setKey('home');
  fill(
    $view,
    h(
      'div',
      { class: 'home' },
      h(
        'div',
        { class: 'home-inner' },
        h('div', { class: 'large-title' }, '要讓 Agent Hub 做什麼？'),
        homeNotice(provider, placement),
        homeComposer.el,
        h('p', { class: 'home-hint' }, homeHint(provider, placement), provider === 'claude' ? h('button', { class: 'linklike', type: 'button', onclick: claudeDialog }, 'Claude API 設定…') : provider === 'deepseek' ? h('button', { class: 'linklike', type: 'button', onclick: deepseekDialog }, 'DeepSeek 設定…') : null),
      ),
    ),
  );
  updateHomeComposer();
  homeComposer.focus();
  await ensureHomeModels();
}

function homeConfig(change) {
  const previousProvider = homeProvider();
  const provider = isProvider(change.provider) ? change.provider : previousProvider;
  if (change.provider) setHomeProvider(provider);
  const switched = provider !== previousProvider;
  const st = homeState(provider);
  if (change.model) {
    st.model = change.model;
    const m = findModel(homeCatalog?.byProvider?.[provider]?.models, change.model);
    if (m) {
      // The model menu has one click, so it also carries the previous
      // provider's effort. On a provider switch, that value belongs to the
      // old provider: use the target provider's stored/account effort instead.
      const inherited = switched ? st.effort : change.effort === undefined ? st.effort : change.effort;
      st.effort = m.efforts.includes(inherited) ? inherited : m.defaultEffort || '';
    }
  } else if (change.effort !== undefined) st.effort = change.effort;
  if (change.permission) st.permission = change.permission;
  if ('planMode' in change) st.planMode = Boolean(change.planMode);
  if (change.provider && !Object.hasOwn(permissionLabels(provider), st.permission || 'manual')) st.permission = 'manual';
  saveHome();
  applyProvider(provider);
  if (switched) {
    // The machine/folder/key hint and the key callout belong to the provider;
    // redraw the one home, keeping the draft (showHome uses the same key).
    showHome();
    return;
  }
  updateHomeComposer();
}

function startHomeSession(payload) {
  const p = homeProvider();
  if (p === 'claude') return startClaudeSession(payload);
  if (p === 'deepseek') return startDeepseekSession(payload);
  return startSession(payload);
}

function homeCommand(name) {
  const p = homeProvider();
  const st = homeState(p);
  if (name === 'status' || name === 'usage') {
    if (p === 'claude') return claudeDialog();
    if (p === 'deepseek') return deepseekDialog();
    return homeMachine() ? accountDialog(homeMachine().id) : openMachines();
  }
  if (['model', 'effort', 'permission'].includes(name)) return homeComposer.openControl(name) || toast('這個模型沒有提供這個選項');
  if (name === 'plan') return homeConfig({ planMode: !st.planMode });
  const labels = permissionLabels(p);
  if (Object.hasOwn(labels, name)) return homeConfig({ permission: name });
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

// A GitHub repository a new Kimi conversation on `m` is bound to.
const kimiRepo = (m) => (m ? S.home.repoByMachine?.[m.id] || null : null);

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
  const repo = kimiRepo(m);
  openMenu(
    anchor,
    [
      { section: 'GitHub' },
      { label: repo ? `${repo.full}（${repo.branch || '新分支'}）` : '綁定一個 GitHub repo…', description: repo ? '換一個 repo 或分支' : 'clone 下來，所有程式碼都 commit 並 push 到那裡', checked: Boolean(repo), onSelect: () => repoDialog(m, null, homeProvider() === 'deepseek' ? 'deepseek' : 'kimi') },
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

// ---------------------------------------------------------- Claude placement

// Claude placement is shared by the single home and the Claude account dialog.

async function loadClaudeModels(force = false) {
  if (S.claudeModels && !force) return S.claudeModels;
  try {
    S.claudeModels = await get('/claude/models');
    updateHomeComposer();
  } catch {}
  return S.claudeModels;
}

// Where a new Claude conversation's tools run: the hub's own computer
// ({ id: null }), or a connected one (its bridge runs them).
const bridgeReady = (m) => m.online && !/^0\.[0-4]\./.test(m.bridgeVersion || '0.0.0');
function claudeHomeMachine() {
  const id = S.home.claude?.machineId;
  const m = id && machineById(id);
  if (m && bridgeReady(m)) return m;
  return { id: null, name: hostName(), home: S.config?.home };
}
const claudeCwd = (m) => S.home.claude?.cwdByMachine?.[m.id || 'hub'];
// Or a GitHub repository ({ full, branch? }) to clone and bind to.
const claudeRepo = (m) => S.home.claude?.repoByMachine?.[m.id || 'hub'] || null;

function claudeMachineMenu(anchor) {
  const cur = claudeHomeMachine();
  const pick = (id) => {
    S.home.claude = { ...(S.home.claude || {}), machineId: id };
    saveHome();
    showHome();
  };
  openMenu(
    anchor,
    [
      { label: `中控台這台電腦（${hostName()}）`, description: '工具在中控台所在的電腦上執行', checked: !cur.id, onSelect: () => pick(null) },
      ...(S.machines.length ? [{ section: '已連接的電腦' }] : []),
      ...S.machines.map((m) => ({
        label: m.name,
        description: !m.online ? '離線' : !bridgeReady(m) ? '連接器太舊：在那台電腦重新執行連接指令' : m.platform,
        checked: cur.id === m.id,
        disabled: !bridgeReady(m),
        onSelect: () => pick(m.id),
      })),
      { separator: true },
      { label: '連接其他電腦…', onSelect: openMachines },
    ],
    { width: 280 },
  );
}

// Folders on the computer Claude's tools will run on.
function claudeFolderMenu(anchor) {
  const m = claudeHomeMachine();
  const recent = [...new Set([...S.sessions.values()].filter((s) => isClaude(s) && (s.machineId || null) === m.id).sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.cwd).filter(Boolean))].slice(0, 6);
  const pick = (cwd) => {
    const x = (S.home.claude ??= {});
    x.cwdByMachine = { ...(x.cwdByMachine || {}), [m.id || 'hub']: cwd };
    x.repoByMachine = { ...(x.repoByMachine || {}), [m.id || 'hub']: null };
    saveHome();
    showHome();
  };
  const home = m.home || S.config?.home;
  const repo = claudeRepo(m);
  openMenu(
    anchor,
    [
      { section: 'GitHub' },
      { label: repo ? `${repo.full}（${repo.branch || '新分支'}）` : '綁定一個 GitHub repo…', description: repo ? '換一個 repo 或分支' : 'clone 下來，所有程式碼都 commit 並 push 到那裡', checked: Boolean(repo), onSelect: () => repoDialog(m) },
      { separator: true },
      recent.length ? { section: '最近使用' } : null,
      ...recent.map((p) => ({ label: baseName(p), description: shortPath(p, home, 4), onSelect: () => pick(p) })),
      recent.length ? { separator: true } : null,
      { label: '瀏覽資料夾…', description: `「${m.name}」上的資料夾`, onSelect: () => browseFolders(m, pick, claudeCwd(m)) },
      { label: '新的空白資料夾', description: m.id ? '在 ~/agent-hub-workspaces 建立' : S.config?.workspacesDir ? `在 ${shortPath(S.config.workspacesDir, home, 3)} 建立` : null, onSelect: () => pick(null) },
    ].filter(Boolean),
    { width: 300 },
  );
}

const dsGateway = () => (S.deepseek?.gateways || []).find((g) => g.id === S.deepseek?.gateway) || null;
const dsLabel = () => dsGateway()?.label || 'DeepSeek 閘道';
const effortFor = (wanted, model) => {
  const effort = wanted || model?.defaultEffort || '';
  return model && model.efforts?.includes(effort) ? effort : undefined;
};

async function startClaudeSession({ text, images, files, uploadDir }) {
  if (!S.claude?.hasKey) {
    homeComposer.setText(text);
    return claudeDialog();
  }
  const x = S.home.claude || {};
  const models = groupedModels(homeCatalog, 'claude');
  const preferred = x.model || homeCatalog?.byProvider?.claude?.defaultModel || S.claude?.defaults?.model;
  const used = findModel(models, preferred);
  const model = used ? modelKey(used) : preferred && !models.length ? preferred : undefined;
  const effort = effortFor(x.effort, used);
  homeComposer.el.classList.add('sending');
  try {
    const m = claudeHomeMachine();
    const repo = claudeRepo(m);
    const s = normalizeSummary(await post('/sessions', { provider: 'claude', machineId: m.id || undefined, cwd: repo ? undefined : claudeCwd(m) || undefined, files, uploadDir, repo: repo?.full, branch: repo?.branch || undefined, prompt: text, images, model, effort, permission: x.permission, planMode: x.planMode || undefined, subagent: subagentPayload(S.home) }));
    S.sessions.set(s.id, s);
    homeProviderTouched = false;
    resetHomeChoices();
    go(`#/s/${s.id}`);
  } catch (err) {
    homeComposer.setText(text);
    fail(err);
  } finally {
    homeComposer.el.classList.remove('sending');
  }
}

async function startSession({ text, images, files, uploadDir }) {
  const m = homeMachine();
  if (!m) {
    homeComposer.setText(text);
    return openMachines();
  }
  const repo = kimiRepo(m);
  const cwd = repo ? undefined : S.home.cwdByMachine?.[m.id] || undefined;
  const models = groupedModels(homeCatalog, 'kimi');
  const preferred = S.home.model || homeCatalog?.byProvider?.kimi?.defaultModel || defaults().model;
  const used = findModel(models, preferred);
  const model = used ? modelKey(used) : preferred && !models.length ? preferred : undefined;
  const effort = effortFor(S.home.effort, used);
  homeComposer.el.classList.add('sending');
  try {
    const s = normalizeSummary(await post('/sessions', { provider: 'kimi', machineId: m.id, cwd, files, uploadDir, repo: repo?.full, branch: repo?.branch || undefined, prompt: text, images, model, effort, permission: S.home.permission, planMode: S.home.planMode || undefined, subagent: subagentPayload(S.home) }));
    S.sessions.set(s.id, s);
    homeProviderTouched = false;
    resetHomeChoices(); // the next new conversation starts from the defaults again
    go(`#/s/${s.id}`);
  } catch (err) {
    homeComposer.setText(text);
    fail(err);
  } finally {
    homeComposer.el.classList.remove('sending');
  }
}

async function startDeepseekSession({ text, images, files, uploadDir }) {
  if (!S.deepseek?.hasKey) {
    homeComposer.setText(text);
    return deepseekDialog();
  }
  const m = homeMachine();
  if (!m) {
    homeComposer.setText(text);
    return openMachines();
  }
  const x = S.home.deepseek || {};
  const models = groupedModels(homeCatalog, 'deepseek');
  const preferred = x.model || homeCatalog?.byProvider?.deepseek?.defaultModel || S.deepseek?.defaults?.model;
  const used = findModel(models, preferred);
  const model = used ? modelKey(used) : preferred && !models.length ? preferred : undefined;
  const effort = effortFor(x.effort, used);
  const repo = kimiRepo(m);
  const cwd = repo ? undefined : S.home.cwdByMachine?.[m.id] || undefined;
  homeComposer.el.classList.add('sending');
  try {
    const s = normalizeSummary(await post('/sessions', { provider: 'deepseek', machineId: m.id, cwd, files, uploadDir, repo: repo?.full, branch: repo?.branch || undefined, prompt: text, images, model, effort, permission: x.permission, planMode: x.planMode || undefined, subagent: subagentPayload(S.home) }));
    S.sessions.set(s.id, s);
    homeProviderTouched = false;
    resetHomeChoices();
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

function normalizeSummary(raw) {
  const src = raw?.session || raw?.summary || raw || {};
  return src && typeof src === 'object' ? src : {};
}

// Follow continuedTo to the leaf. The leaf is the only node that may run the
// next turn; old URLs are redirected to it without changing conversationId.
async function resolveLeaf(summary) {
  let leaf = normalizeSummary(summary);
  const seen = new Set();
  while (leaf?.continuedTo && !seen.has(leaf.continuedTo)) {
    seen.add(leaf.id);
    let next = S.sessions.get(leaf.continuedTo);
    if (!next) {
      try {
        const full = await get(`/sessions/${leaf.continuedTo}`);
        next = normalizeSummary(full);
      } catch {
        break;
      }
    }
    if (!next?.id) break;
    leaf = next;
  }
  return leaf;
}

let sessionCatalog = null;
let sessionCatalogKey = '';
let sessionCatalogToken = 0;

function legacyCatalog(summary) {
  const provider = providerOf(summary);
  const cat = emptyCatalog('模型目錄暫時無法取得');
  const models = (summary?.meta?.models || []).map((m) => normalizeModel(provider, m)).filter(Boolean);
  const p = cat.byProvider[provider];
  p.available = true;
  p.reason = '';
  p.models = models;
  p.defaultModel = summary?.meta?.defaultModel || models[0]?.id || '';
  cat.providers = PROVIDERS.map((id) => cat.byProvider[id]);
  cat.models = cat.providers.flatMap((x) => x.models.map((m) => ({ ...m, provider: x.id, providerLabel: x.label, providerAvailable: x.available, disabled: !x.available || m.available === false, reason: m.reason || (x.available ? '' : x.reason) })));
  return cat;
}

async function ensureSessionModels(summary, force = false) {
  if (!summary?.id) return;
  const id = summary.id;
  if (!force && sessionCatalog && sessionCatalogKey === id) {
    updateComposer();
    return;
  }
  const token = ++sessionCatalogToken;
  try {
    const data = await loadModels({ session: id, force });
    if (token !== sessionCatalogToken || S.cur?.summary?.id !== id) return;
    sessionCatalog = data;
    sessionCatalogKey = id;
    S.modelCatalog = data;
    S.cur?.transcript?.refreshAgents(); // model names on subagent cards
  } catch {
    if (token !== sessionCatalogToken || S.cur?.summary?.id !== id) return;
    sessionCatalog = legacyCatalog(summary);
    sessionCatalogKey = id;
    S.modelCatalog = sessionCatalog;
  }
  updateComposer();
}

// A broker child opened by URL (it has no sidebar row by design). Say what it
// is and offer its parent instead of leaving an apparently empty agent panel.
function drawChildNote(slot, summary) {
  if (!slot) return;
  slot.hidden = !summary?.parentId;
  if (slot.hidden) return fill(slot);
  const parent = summary.parentId ? S.sessions.get(summary.parentId) : null;
  fill(
    slot,
    h(
      'div',
      { class: 'callout small child-note' },
      icon('agents'),
      h(
        'div',
        { class: 'callout-text' },
        h('strong', null, '這是子代理對話'),
        parent?.title ? `（父對話「${parent.title}」）` : '',
        ' 它不會出現在側邊欄，只會顯示在父對話的「子代理」面板；直接開啟這個網址不會影響它的進度。',
        h('button', { class: 'linklike', type: 'button', onclick: () => openParentOfChild(summary) }, '開啟父對話'),
      ),
    ),
  );
}

const drawCurrentClusterNote = () => S.cur && drawClusterNote(S.cur.clusterNote, S.cur.summary);
// The link to the Hub is back: what was said about this conversation's clusters meanwhile (one finished) was missed, so ask again.
function refreshClusterNote() {
  const cur = S.cur;
  if (cur?.summary) loadClustersOf(cur.summary, { force: true }).then((fresh) => fresh && S.cur === cur && drawCurrentClusterNote());
}

// What the server says changed when this conversation moved to another runtime
// (summary.handoff.notes), for example a permission mode that had to become
// stricter. Said as the server gives it; the page maps nothing itself.
const dismissedHandoff = new Set();
function drawHandoffNote(slot, summary) {
  if (!slot) return;
  const h0 = summary?.handoff;
  const notes = Array.isArray(h0?.notes) ? h0.notes.filter((n) => typeof n === 'string' && n.trim()) : [];
  const key = `${summary?.id}|${notes.join('\n')}`;
  slot.hidden = !notes.length || dismissedHandoff.has(key);
  if (slot.hidden) return fill(slot);
  const trail = (Array.isArray(h0.chainProviders) ? h0.chainProviders : []).map((p) => PROVIDER_LABELS[p?.provider || p] || '').filter(Boolean);
  fill(
    slot,
    h(
      'div',
      { class: 'callout small child-note handoff-note', role: 'note' },
      icon('alert'),
      h(
        'div',
        { class: 'callout-text' },
        h('strong', null, '切換時有變更'),
        ...notes.map((n) => h('div', null, n)),
        trail.length > 1 ? h('div', null, `前段歷史來自：${trail.join(' → ')}`) : null,
        h('button', { class: 'linklike', type: 'button', onclick: () => (dismissedHandoff.add(key), drawHandoffNote(slot, summary)) }, '知道了'),
      ),
    ),
  );
}

async function openParentOfChild(child) {
  const pid = child?.parentId;
  if (!pid) return;
  try {
    const parent = normalizeSummary(await get(`/sessions/${pid}`));
    if (!parent?.id) throw new Error('找不到父對話');
    S.sessions.set(parent.id, parent);
    // The parent's snapshot opens the matching card in the 子代理 panel.
    S.pendingAgentFocus = child.id;
    go(`#/s/${parent.id}`);
  } catch (err) {
    fail(err);
  }
}

async function openSession(id) {  if (S.cur?.id === id) return;
  const known = S.sessions.get(id);
  if (known?.continuedTo || known?.isLeaf === false) {
    let leaf = null;
    try {
      leaf = known.continuedTo ? await resolveLeaf(known) : known.leafId ? normalizeSummary(await get(`/sessions/${known.leafId}`)) : null;
    } catch {}
    if (leaf?.id && leaf.id !== id) {
      S.sessions.set(leaf.id, leaf);
      location.replace(`#/s/${leaf.id}`);
      return;
    }
  }
  leaveSession();
  sessionCatalog = null;
  sessionCatalogKey = '';
  S.modelCatalog = null;
  S.route = `s:${id}`;
  if (S.panel?.tab === 'artifact') hidePanel();
  const summary = S.sessions.get(id);
  // Not known yet: the snapshot decides. The palette is not touched here.
  if (summary) applyProvider(providerOf(summary));
  const cur = { id, conversationId: conversationIdOf(summary) || id, summary, seq: 0, transcript: null, loading: true, syncing: true };
  S.cur = cur;
  cur.childNote = h('div', { class: 'child-note-slot', hidden: !summary?.parentId });
  drawChildNote(cur.childNote, summary);
  cur.handoffNote = h('div', { class: 'child-note-slot handoff-note-slot', hidden: true });
  drawHandoffNote(cur.handoffNote, summary);
  cur.clusterNote = h('div', { class: 'child-note-slot cluster-note-slot', hidden: true });
  drawClusterNote(cur.clusterNote, summary);
  loadClustersOf(summary).then((fresh) => fresh && S.cur === cur && drawCurrentClusterNote());
  // Keeps the conversation followed on the machine while it is open.
  cur.ping = setInterval(() => document.visibilityState === 'visible' && post(`/sessions/${id}/viewing`).catch(() => {}), 60_000);
  cur.transcript = new Transcript({
    cwd: summary?.cwd,
    agentName: nameFor(summary),
    ...subagentOpts,
    onRespond: respond,
    onOpenArtifact: (path, version) => showArtifact(path, version),
    onArtifacts: (list, { older = false } = {}) => {
      // A page Kimi starts writing now opens beside the conversation, so it
      // can be watched as it is generated. Pages found in older messages
      // (loaded as you scroll up) are not new.
      const fresh = !cur.loading && !older && cur.knownArtifacts ? list.find((a) => !cur.knownArtifacts.has(a.path)) : null;
      S.artifacts = withOpened(list);
      cur.knownArtifacts = new Set(list.map((a) => a.path));
      // Older versions came into the list: the cards of the pages in view say which version they are.
      if (older) markArtifactRows();
      renderToolbar();
      if (fresh && window.matchMedia('(min-width: 1100px)').matches) showArtifact(fresh.path);
      else syncArtifact();
    },
    artifactsCache: () => S.artifacts,
    activeArtifact: () => (S.panel?.tab === 'artifact' ? S.panel.path : null),
    onImage: lightbox,
    onLoadEarlier: () => post(`/sessions/${id}/earlier`).catch(fail),
    // The Hub sends the newest part of a long conversation; the slice before
    // it comes as you scroll up, and an event cut short is fetched whole when
    // its row is opened.
    // `beforeId` anchors the page to the event itself: Kimi's own 「載入更早」
    // puts older events in front and shifts every index, an id does not move.
    // A Hub that does not know the id (404) is asked again by position alone.
    fetchEarlier: async ({ before, beforeId, limit }) => {
      const base = `/sessions/${cur.id}/events?before=${before}&limit=${limit}`;
      if (!beforeId) return get(base);
      try {
        return await get(`${base}&beforeId=${encodeURIComponent(beforeId)}`);
      } catch (err) {
        if (err?.status === 404) return get(base);
        throw err;
      }
    },
    fetchFull: async (ev) => {
      const r = await get(`/sessions/${cur.id}/events/${encodeURIComponent(ev.id)}?full=1`);
      return r?.event || r;
    },
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
    // Put the native conversation back on the model that was chosen: the same
    // switch as choosing it again, with force (the server skips its shortcut).
    onRestoreModel: (d) => configure({ provider: d.expected.provider, model: d.expected.model, effort: d.expected.effort, force: true }),
    onDismissCtxHint: (hint) => {
      const s = S.cur?.summary;
      if (!s) return;
      dismissContextHint(conversationIdOf(s), hint.band, hintStorage());
      updateComposer();
    },
    onOpenSubagent: () => openSubagentDialog({ session: S.cur?.summary }),
    onCancelQueued: (pid) => S.cur && del(`/sessions/${S.cur.id}/queue/${pid}`).catch(fail),
    onSteerQueued: (pid) => S.cur && post(`/sessions/${S.cur.id}/queue/${pid}/steer`).catch(fail),
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
  composer.setKey(conversationIdOf(summary) || id);
  composer.update({ agent: summary ? providerOf(summary) : 'kimi', provider: summary ? providerOf(summary) : 'kimi', agentsWorking: 0, foreground: 0 });
  cur.composerSig = '';
  fill($view, h('div', { class: 'session' }, cur.childNote, cur.handoffNote, cur.clusterNote, cur.transcript.el, h('div', { class: 'composer-dock' }, composer.el)));
  renderToolbar();
  renderSidebar();
  watchCurrent();
  composer.focus();
  if (summary) ensureSessionModels(summary);
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

async function applySnapshot(full) {
  const cur = S.cur;
  if (!cur) return;
  const source = full?.session ? { ...full.session, events: full.events ?? full.session.events, seq: full.seq ?? full.session.seq, chain: full.chain ?? full.session.chain } : full?.summary ? { ...full.summary, events: full.events ?? full.summary.events, seq: full.seq ?? full.summary.seq, chain: full.chain ?? full.summary.chain } : full;
  // The snapshot's chain tells us which native sessions are old nodes. The
  // machine list itself does not carry that mapping, so remember it for the
  // sidebar (the current leaf's native id is protected in rows()).
  if (Array.isArray(source?.chain)) for (const n of source.chain) if (n?.kimiSessionId) knownChainNative.add(n.kimiSessionId);
  const { events = [], seq = 0, chain: _chain, window: eventWindow, outside, ...summary } = source || {};
  // An old chain node was opened: the leaf is the one that may run.
  if (summary.continuedTo || summary.isLeaf === false) {
    let leaf = null;
    try {
      leaf = summary.continuedTo ? await resolveLeaf(summary) : summary.leafId && summary.leafId !== summary.id ? normalizeSummary(await get(`/sessions/${summary.leafId}`)) : null;
    } catch {}
    if (leaf?.id && leaf.id !== summary.id) {
      S.sessions.set(leaf.id, leaf);
      location.replace(`#/s/${leaf.id}`);
      return;
    }
  }
  if (summary.id && summary.id !== cur.id) {
    S.sessions.set(summary.id, summary);
    location.replace(`#/s/${summary.id}`);
    return;
  }
  if (S.cur !== cur) return;
  cur.id = summary.id || cur.id;
  cur.conversationId = conversationIdOf(summary) || cur.id;
  cur.summary = summary;
  drawChildNote(cur.childNote, summary);
  drawHandoffNote(cur.handoffNote, summary);
  drawClusterNote(cur.clusterNote, summary);
  loadClustersOf(summary).then((fresh) => fresh && S.cur === cur && drawCurrentClusterNote());
  cur.seq = seq;
  applyProvider(providerOf(summary));
  cur.loading = true; // pages already there are not "new" while it loads
  S.sessions.set(summary.id, summary);
  cur.transcript.opts.cwd = summary.cwd;
  cur.transcript.opts.agentName = nameFor(summary);
  cur.transcript.load(events, { window: eventWindow, outside });
  cur.loading = false;
  cur.transcript.setServed(summary.meta?.servedModel?.name);
  cur.transcript.setStatus(summary.status, busy(summary.status) ? turnStartTs(events, outside) : null, summary.meta?.tps || 0);
  S.artifacts = withOpened(cur.transcript.artifacts());
  cur.knownArtifacts = new Set(S.artifacts.map((a) => a.path));
  loadArtifactIndex(cur);
  // A fresh copy (after a reconnect or a hub restart) may have stopped the
  // subagents the tray still counts.
  cur.agentsWorking = cur.transcript.runningCount();
  cur.foreground = cur.transcript.foregroundCount();
  if (composer && composer.key !== cur.conversationId) composer.setKey(cur.conversationId);
  composer?.update({ agent: providerOf(summary), provider: providerOf(summary), agentsWorking: cur.agentsWorking, foreground: cur.foreground });
  updateComposer();
  ensureSessionModels(summary);
  renderToolbar();
  renderSidebar();
  // Opened from the Artifacts page.
  const want = S.openArtifact;
  S.openArtifact = null;
  if (want && S.artifacts.some((a) => a.path === want)) showArtifact(want);
  else syncArtifact();
  // Opened a child through its parent link: bring that card up when the
  // parent's transcript actually has it. A missing projection is explained,
  // not shown as an empty panel.
  const focus = S.pendingAgentFocus;
  S.pendingAgentFocus = null;
  if (focus) {
    const agent = cur.transcript.agentList().find((a) => {
      if (a.id === focus) return true;
      const ev = cur.transcript.get(a.id);
      return ev?.childSessionId === focus || ev?.subagent?.id === focus || ev?.subagent?.childSessionId === focus;
    });
    if (agent) showAgents(agent.id);
    else toast('已開啟父對話；子代理的即時過程在「面板」→「子代理」裡。');
  }
}

// The Hub sends only the newest window of a long conversation, so the pages
// written before it are not among the events held. It lists them separately
// (over the whole conversation); they join the panel without opening it.
async function loadArtifactIndex(cur) {
  const t = cur.transcript;
  if (!t || !t.hasEarlier || t.localEarlier) return; // everything is held (or held aside: it counts)
  let r;
  try {
    r = await get(`/sessions/${cur.id}/artifacts`);
  } catch {
    return; // a Hub without the list: the pages of the window are all there is
  }
  if (S.cur === cur && cur.transcript === t) t.setArtifactIndex(r?.artifacts);
}

// One version of a page, as the Hub replays it from the whole conversation
// (null: it cannot be derived there either).
async function artifactVersionHtml(cur, id) {
  cur.artifactHtml ??= new Map();
  if (cur.artifactHtml.has(id)) return cur.artifactHtml.get(id);
  try {
    const r = await get(`/sessions/${cur.id}/artifacts/${encodeURIComponent(id)}`);
    const html = typeof r?.html === 'string' ? r.html : null;
    cur.artifactHtml.set(id, html);
    return html;
  } catch {
    return null;
  }
}

function legacyModelsFor(summary) {
  const provider = providerOf(summary);
  return (summary?.meta?.models || [])
    .map((m) => normalizeModel(provider, m))
    .filter(Boolean)
    .map((m) => ({ ...m, provider, providerLabel: PROVIDER_LABELS[provider], providerAvailable: true }));
}

// localStorage, or nothing: a page that cannot use it (private window, blocked
// site data) still works, it just does not remember what was put away.
function hintStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}
const modelDriftOf = (summary) => driftOf(summary);

function updateComposer() {
  const s = S.cur?.summary;
  if (!s || !composer) return;
  if (S.panel?.tab === 'todos' && JSON.stringify(s.meta?.todos || []) !== S.panel.todosSig) {
    S.panel.todosSig = JSON.stringify(s.meta?.todos || []);
    drawTodos();
  }
  const meta = s.meta || {};
  const runtimeProvider = providerOf(s);
  const mc = modelConfigOf(s);
  const turn = turnOf(s);
  const provider = mc.provider;
  const cat = sessionCatalogKey === s.id ? sessionCatalog : null;
  const group = cat?.byProvider?.[provider];
  const models = cat?.models?.length ? cat.models : legacyModelsFor(s);
  const state = {
    agent: runtimeProvider,
    provider,
    runtimeProvider,
    cost: isClaude(s) ? s.usage?.costUsd || 0 : null,
    budget: meta.budget || null,
    running: s.status === 'running',
    awaiting: s.status === 'awaiting_permission',
    queue: meta.queue || [],
    todos: meta.todos || [],
    models,
    providers: cat?.providers || [],
    model: mc.model || group?.defaultModel || '',
    defaultModel: group?.defaultModel || meta.defaultModel || '',
    effort: mc.effort,
    // Shown as the server gives it: the mapping between the providers' permission
    // vocabularies is the server's (permissions.js), never done here.
    permission: meta.permission || '',
    planMode: Boolean(meta.planMode),
    swarmMode: Boolean(meta.swarmMode),
    // This turn's own values while one runs (null/absent when idle, and equal to
    // the next turn's when no snapshot exists yet); the chips only compare them.
    turnModel: turn?.model || '',
    turnEffort: turn?.effort ?? '',
    turnProvider: turn?.provider || runtimeProvider,
    turnSubagent: turn?.subagent,
    ...(({ mode, value }) => ({ subagentMode: mode, subagent: value }))(sessionSubagentChoice(s)),
    pendingSwitch: meta.pendingSwitch || s.state?.pendingProvider || null,
    subagentOptions: cat?.providers || [],
    modelsLoading: !cat,
    servedModel: meta.servedModel || null,
    context: meta.context,
    // The native runs another model than the one chosen, and the nudge from
    // 80% of the context (never for Claude: it has no such compaction).
    drift: driftOf(s),
    ctxHint: isClaude(s) ? null : contextHint(meta.context, conversationIdOf(s), hintStorage()),
    skills: meta.skills || [],
    terminal: meta.owner === 'tui',
    controllable: Boolean(meta.controllable),
    guess: Boolean(meta.guess),
    autoPause: s.autoPause || null,
    scheduled: s.scheduled || [],
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

// At the top of a conversation whose file was damaged and repaired: that it
// was, what it cost (tooltip), and, while the repaired version has not been
// written back to the file yet, that too.
function salvageBadges(s) {
  const v = salvageView(s?.meta?.salvaged);
  if (!v) return [];
  return [h('span', { class: 'om-badge om-badge--warning salvaged-badge', title: v.title }, icon('alert'), v.label), v.unsaved ? h('span', { class: 'om-badge om-badge--danger salvaged-unsaved', title: v.title }, UNSAVED_LABEL) : null].filter(Boolean);
}

// ---------------------------------------------- damaged conversation files

const DAMAGED_DISMISS_KEY = 'hubDamagedDismissed';
const dismissedDamaged = () => {
  try {
    return localStorage.getItem(DAMAGED_DISMISS_KEY) || '';
  } catch {
    return '';
  }
};

// Asked for when the page loads and each time the socket comes back (the Hub
// may have been restarted and found another file). Nothing shown when the
// list is empty, when it cannot be had, or while the person has put exactly
// this set away: it comes back when a different file is on the list.
let damagedBusy = null;
function loadDamaged() {
  damagedBusy ??= get('/damaged-sessions')
    .then((list) => {
      S.damaged = damagedView(list);
    })
    .catch(() => {
      // A Hub without the list, or not reachable: say nothing, keep what was shown.
    })
    .finally(() => {
      damagedBusy = null;
      drawDamaged();
    });
  return damagedBusy;
}

function drawDamaged() {
  const d = S.damaged;
  const hidden = !d?.count || dismissedDamaged() === d.signature;
  $damaged.hidden = hidden;
  if (hidden) return fill($damaged);
  const open = Boolean(S.damagedOpen);
  const dismiss = () => {
    try {
      localStorage.setItem(DAMAGED_DISMISS_KEY, d.signature);
    } catch {}
    S.damagedOpen = false;
    drawDamaged();
  };
  fill(
    $damaged,
    h(
      'div',
      { class: 'damaged-banner', role: 'status' },
      h(
        'div',
        { class: 'damaged-bar' },
        h(
          'button',
          { class: 'damaged-head', type: 'button', 'aria-expanded': String(open), title: open ? '收合清單' : '看是哪些檔案', onclick: () => ((S.damagedOpen = !open), drawDamaged()) },
          icon('alert'),
          h('span', { class: 'damaged-text' }, damagedHeadline(d.count)),
          icon('chev', 'chev'),
        ),
        h('button', { class: 'damaged-close', type: 'button', title: '暫時關閉（出現不同的損壞檔時才會再提醒）', 'aria-label': '暫時關閉損壞檔提醒', onclick: dismiss }, icon('x')),
      ),
      open
        ? h(
            'div',
            { class: 'damaged-list' },
            h('p', { class: 'damaged-note' }, `原檔都沒有被改動，備份在 Hub 那台機器的 ${BACKUP_DIR} 資料夾。`),
            ...d.items.map((i) =>
              h(
                'div',
                { class: 'damaged-item' },
                h('div', { class: 'damaged-file' }, i.file),
                h('div', { class: 'damaged-reason' }, i.reason),
                h('div', { class: 'damaged-backup' }, backupPath(i.backup) ? `備份：${backupPath(i.backup)}` : '沒有備份；原檔仍在 data/sessions/ 原處'),
              ),
            ),
          )
        : null,
    ),
  );
}

function renderToolbar() {
  const s = S.cur?.summary;
  if (!s) {
    fill($toolbar, sidebarToggle(), h('div', { class: 'toolbar-titles' }, h('div', { class: 'om-toolbar__title' }, '新對話')));
    return;
  }
  const m = machineById(s.machineId);
  const sub = (isClaude(s) ? ['Claude API', s.meta?.machineName || m?.name || hostName(), s.repo ? `${s.repo.full} · ${s.repo.branch}` : s.cwd ? shortPath(s.cwd, s.machineId ? m?.home : S.config?.home, 3) : null] : [isDeepseek(s) ? 'DeepSeek' : null, m?.name || s.meta?.machineName, s.repo ? `${s.repo.full} · ${s.repo.branch}` : s.cwd ? shortPath(s.cwd, m?.home, 3) : null]).filter(Boolean).join(' · ');
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
        ...salvageBadges(s),
        s.meta?.owner === 'tui' ? h('span', { class: 'om-badge', title: s.meta.guess ? '同一個資料夾有終端機的 Kimi 開著；這個對話仍可直接從 Hub 送出訊息與操作' : s.meta.controllable ? '這個對話在終端機的 Kimi 裡執行；你的訊息會打進那個可控終端機，也可以從 Hub 操作' : '這個對話在終端機的 Kimi 裡執行；Hub 的訊息與操作會經 Kimi Server API 送出，不會打進那個終端機' }, '終端機') : null,
        autoPauseBadge(s),
        isClaude(s) && s.meta?.budget ? h('button', { class: `om-badge${(s.usage?.costUsd || 0) >= s.meta.budget ? ' om-badge--warning' : ''}`, type: 'button', title: '這個對話的花費上限', onclick: budgetDialog }, `上限 ${fmtUsd(s.meta.budget)}`) : null,
      ),
    ),
    h('span', { class: 'om-toolbar__spacer' }),
    h('button', { class: `om-btn om-btn--toolbar wide${S.panel ? ' on' : ''}`, type: 'button', title: '面板：Artifact、變更、子代理、待辦', onclick: () => (S.panel ? hidePanel() : openPanel()) }, icon('panelRight'), h('span', { class: 'btn-label' }, '面板')),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '更多', 'aria-label': '更多', onclick: (e) => sessionMenu(e.currentTarget) }, icon('dots')),
  );
}

// "DeepSeek · V4.1 Flash · 思考 max" for a subagent choice; the native rules for none.
const subagentText = (sub) => subagentChoiceText(sub, { nameOf: (p, id) => modelNameOf(p, id), effortLabel: (e) => EFFORT_LABELS[e] || e });
const subagentModeLabel = (mode, value) => subagentModeText(mode, value, { nameOf: (p, id) => modelNameOf(p, id), effortLabel: (e) => EFFORT_LABELS[e] || e });
const subagentItem = (s) => ({ label: '子代理設定…', description: (({ mode, value }) => subagentModeLabel(mode, value))(sessionSubagentChoice(s)), onSelect: () => openSubagentDialog({ session: s }) });

// What the transcript needs to judge a subagent card (see agent-state.js): the
// names of models, whether the conversation is working, and the state of a
// broker child's own conversation. Cards and the panel get the same ones.
const subagentOpts = {
  modelName: (provider, id) => modelNameOf(provider, id) || String(id).split('/').pop(),
  effortLabel: (e) => EFFORT_LABELS[e] || e,
  sessionStatus: () => S.cur?.summary?.status,
  childStatus: (id) => S.sessions.get(id)?.status,
};

async function openSubagentDialog({ home = false, session = null } = {}) {
  const s = home ? null : session || S.cur?.summary;
  if (!home && !s) {
    // The chip of the conversation shown a moment ago is still on screen while
    // the new one loads: say so, rather than let a click do nothing.
    toast('這個對話還在載入，請稍後再按一次');
    return;
  }
  let cat = home ? homeCatalog : s && sessionCatalogKey === s.id ? sessionCatalog : null;
  if (!cat) {
    if (home) await ensureHomeModels(true);
    else await ensureSessionModels(s, true);
    cat = home ? homeCatalog : s && sessionCatalogKey === s.id ? sessionCatalog : null;
  }
  if (!cat) {
    toast('模型清單載入失敗，請稍後再試', { kind: 'error' });
    return;
  }
  // 'default' (home only): nothing chosen, the server's default applies;
  // 'follow': the native rules on purpose; 'custom': a model. The fields below
  // start from what the new conversation would get.
  const choice = home ? homeSubagentChoice() : sessionSubagentChoice(s);
  const current = choice.mode === 'custom' ? choice.value : choice.mode === 'default' ? DEFAULT_SUBAGENT : null;
  const currentProvider = isProvider(current?.provider) ? current.provider : providerOf(s || { provider: homeProvider() });
  const providerSel = h(
    'select',
    { class: 'om-input', name: 'subagent-provider' },
    ...PROVIDERS.map((id) => {
      const g = cat.byProvider[id];
      const why = g?.available ? '' : `（不可用：${g?.reason || '沒有可用模型'}）`;
      return h('option', { value: id, disabled: !g?.available }, `${PROVIDER_LABELS[id]}${why}`);
    }),
  );
  providerSel.value = currentProvider;
  const modelSel = h('select', { class: 'om-input', name: 'subagent-model' });
  const effortSel = h('select', { class: 'om-input', name: 'subagent-effort' });
  const help = h('div', { class: 'om-field__help' });
  const modeSel = h(
    'select',
    { class: 'om-input', name: 'subagent-mode' },
    home ? h('option', { value: 'default' }, `預設：${subagentText(DEFAULT_SUBAGENT)}`) : null,
    h('option', { value: 'follow' }, '跟隨主模型／原生規則'),
    h('option', { value: 'custom' }, '指定子代理供應商、模型與思考強度'),
  );
  modeSel.value = home ? choice.mode : choice.mode === 'follow' ? 'follow' : 'custom';
  const fields = h('div', { class: 'subagent-fields' });
  const drawModels = () => {
    const provider = providerSel.value;
    const g = cat.byProvider[provider];
    const list = g?.models || [];
    const keep = current?.provider === provider ? current.model : '';
    const keepModel = findModel(list, keep) || list.find((m) => m.available !== false) || null;
    fill(modelSel, ...(list.length ? list.map((m) => h('option', { value: modelKey(m), disabled: !g.available || m.available === false }, `${m.name}${m.available === false ? `（不可用：${m.reason || '模型不可用'}）` : ''}`)) : [h('option', { value: '' }, '沒有可用模型')]));
    modelSel.value = keepModel ? modelKey(keepModel) : '';
    drawEfforts();
    help.textContent = g?.available ? list.length ? '' : g.reason || '這個供應商沒有可用模型' : g?.reason || '這個供應商目前不可用';
  };
  const drawEfforts = () => {
    const provider = providerSel.value;
    const g = cat.byProvider[provider];
    const m = findModel(g?.models, modelSel.value);
    const keep = current?.provider === provider && sameModel(m, current?.model) ? current.effort || '' : m?.defaultEffort || '';
    fill(effortSel, h('option', { value: '' }, '模型預設'), ...(m?.efforts || []).map((e) => h('option', { value: e }, `${EFFORT_LABELS[e] || e}${e === m.defaultEffort ? '（模型預設）' : ''}`)));
    effortSel.value = keep === '' || (m?.efforts || []).includes(keep) ? keep : '';
    effortSel.disabled = !m || !m.efforts.length;
  };
  providerSel.addEventListener('change', drawModels);
  modelSel.addEventListener('change', drawEfforts);
  const drawMode = () => {
    const custom = modeSel.value === 'custom';
    fields.hidden = !custom;
    providerSel.disabled = !custom;
    modelSel.disabled = !custom;
    effortSel.disabled = !custom || !modelSel.value;
  };
  modeSel.addEventListener('change', drawMode);
  drawModels();
  fields.append(
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '供應商'), providerSel),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '模型'), modelSel),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '思考強度'), effortSel),
    help,
  );
  drawMode();
  const form = h(
    'form',
    { class: 'settings subagent-settings' },
    h('div', { class: 'dialog-title' }, '子代理設定'),
    h('p', { class: 'dialog-text settings-lead' }, `沒有自訂的對話，子代理一律是 ${subagentText(DEFAULT_SUBAGENT)}；只影響之後新建的子代理，已在跑的不變。`),
    h('div', { class: 'dialog-subtitle first' }, '目前：', subagentModeLabel(choice.mode, choice.value)),
    h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '設定'), modeSel),
    fields,
    h('p', { class: 'om-field__help' }, cat.error ? `模型目錄：${cat.error}` : '實際模型、思考強度與即時步驟會顯示在子代理面板。'),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  const d = dialog(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = modeSel.value;
    let value = null;
    if (mode === 'custom') {
      const provider = providerSel.value;
      const g = cat.byProvider[provider];
      const m = findModel(g?.models, modelSel.value);
      if (!g?.available || !m || m.available === false) {
        toast(g?.reason || m?.reason || '這個子代理組合目前不可用', { kind: 'error' });
        return;
      }
      value = { provider, model: modelKey(m), effort: effortSel.disabled ? '' : effortSel.value || '' };
    }
    if (home) {
      // Three different requests: say nothing (default), say "native rules"
      // (null), or name a model. None of them is turned into another.
      if (mode === 'default') delete S.home.subagent;
      else S.home.subagent = value;
      saveHome();
      updateHomeComposer();
      d.close();
      toast(`新對話的子代理：${subagentModeLabel(mode, value)}`);
      return;
    }
    d.close();
    await configure({ subagent: value });
  });
}

// 叢集派工: only from a Kimi or DeepSeek conversation whose computer is on (the
// workers are made there). The Hub refuses a Claude one; the menu never offers it.
const clusterReachable = (s) => {
  const m = machineById(s.machineId);
  return Boolean(m?.online && m.kimi?.available);
};
const clusterItem = (s) => {
  const ok = clusterReachable(s);
  return { label: '叢集派工…', hint: '/cluster', description: ok ? null : '那台電腦離線', disabled: !ok, onSelect: () => clusterCommand(s) };
};
function clusterCommand(s, args = '') {
  if (!clusterReachable(s)) return toast('這個對話的電腦現在離線，叢集要在那台電腦上開工作者；等它連上再派工。', { kind: 'error' });
  openClusterDialog(clusterCtx, s, { prompt: args });
}

function sessionMenu(anchor) {
  const s = S.cur?.summary;
  if (!s) return;
  if (isClaude(s)) return claudeSessionMenu(s, anchor);
  openMenu(
    anchor,
    [
      { label: '重新命名…', onSelect: renameSession },
      { label: '複製成新對話', hint: '/fork', onSelect: () => sessionCommand('fork', '') },
      { label: '壓縮對話', hint: '/compact', onSelect: () => sessionCommand('compact', '') },
      subagentItem(s),
      clusterItem(s),
      s.clusterIds?.length ? { label: '查看叢集…', description: `${s.clusterIds.length} 個叢集`, onSelect: () => openClusterList(clusterCtx, s) } : null,
      isDeepseek(s) ? null : { label: '自動暫停…', hint: s.autoPause?.enabled ? `${s.autoPause.threshold}%` : '關', onSelect: autoPauseDialog },
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
      subagentItem(s),
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

function mergeSummary(old, next) {
  const n = normalizeSummary(next);
  if (!n.id) return null;
  return { ...(old || {}), ...n, meta: n.meta ? { ...(old?.meta || {}), ...n.meta } : old?.meta, modelConfig: n.modelConfig || old?.modelConfig };
}
function leafFromResponse(r) {
  const raw = r?.leaf || r?.session || r?.summary || (r?.id ? r : null);
  const leaf = raw ? normalizeSummary(raw) : null;
  return leaf?.id && !leaf.continuedTo ? leaf : null;
}
async function applyProviderLeaf(s, leaf) {
  if (!leaf?.id) return false;
  // A new chain node has its own meta. Do not carry the old runtime's queue,
  // todos, turn snapshot or permission into it.
  const next = leaf.id !== s.id ? { ...leaf, meta: leaf.meta || {} } : mergeSummary(s, leaf);
  S.sessions.set(next.id, next);
  if (next.id !== s.id) {
    // Only the leaf is a sidebar row. The old node stays on the server and its
    // URL resolves to this leaf.
    S.sessions.delete(s.id);
    sessionCatalog = null;
    sessionCatalogKey = '';
    S.modelCatalog = null;
    location.replace(`#/s/${next.id}`);
    return true;
  }
  if (S.cur?.id === next.id) {
    S.cur.summary = next;
    S.cur.conversationId = conversationIdOf(next);
    applyProvider(providerOf(next));
    ensureSessionModels(next, true);
    updateComposer();
    renderToolbar();
    renderSidebar();
  }
  return true;
}

async function configure(change) {
  const s = S.cur?.summary;
  if (!s) return;
  const provider = providerOf(s);
  try {
    if (Object.hasOwn(change, 'subagent')) {
      const r = await post(`/sessions/${s.id}/config`, { subagent: change.subagent });
      const leaf = leafFromResponse(r);
      if (leaf) await applyProviderLeaf(s, leaf);
      else {
        s.meta = { ...(s.meta || {}), subagent: change.subagent };
        S.sessions.set(s.id, s);
      }
      updateComposer();
      toast(change.subagent ? '已更新這個對話的子代理設定；只影響之後新建的子代理' : '子代理改回跟隨主模型／原生規則');
      return;
    }
    const modelChange = change.model !== undefined || change.effort !== undefined || change.provider !== undefined;
    if (modelChange) {
      const targetProvider = isProvider(change.provider) ? change.provider : provider;
      const mc = modelConfigOf(s);
      const targetModel = change.model ?? mc.model;
      const modelMeta = (S.modelCatalog?.models || []).find((m) => m.provider === targetProvider && sameModel(m, targetModel));
      const wantedEffort = change.effort !== undefined ? change.effort : mc.effort;
      const targetEffort = modelMeta ? (modelMeta.efforts.includes(wantedEffort) ? wantedEffort : modelMeta.defaultEffort || '') : wantedEffort;
      const r = await post(`/sessions/${s.id}/provider`, { provider: targetProvider, model: targetModel, effort: targetEffort || '', ...(change.force ? { force: true } : {}) });
      const leaf = leafFromResponse(r);
      if (leaf) {
        const moved = await applyProviderLeaf(s, leaf);
        if (!moved && S.cur?.summary) {
          S.cur.summary = mergeSummary(s, leaf) || s;
          sessionCatalog = null;
          sessionCatalogKey = '';
          ensureSessionModels(S.cur.summary, true);
          updateComposer();
        }
      } else {
        // The switch may have happened server-side but the response did not
        // carry the new leaf. Never pretend we know it: resync the stream.
        watchCurrent();
      }
      if (leaf) {
        const nextRuntime = providerOf(leaf);
        const nextTarget = modelConfigOf(leaf).provider;
        if (nextRuntime === provider && nextTarget !== provider) toast(`已排定本回合結束後切換到 ${PROVIDER_LABELS[nextTarget]}；本回合仍使用 ${PROVIDER_LABELS[provider]}`);
        else if (nextRuntime !== provider) toast(`已切換到 ${PROVIDER_LABELS[nextRuntime]}；對話歷史保留`);
        else if (busy(s.status)) toast(`已更新模型／思考強度；${PROVIDER_LABELS[provider]} 這一輪不變，下一輪才使用`);
      } else if (targetProvider !== provider) {
        // The response did not carry the leaf: do not claim the switch landed.
        toast(`已送出切換到 ${PROVIDER_LABELS[targetProvider]} 的要求；等待伺服器確認目前回合與下一回合`);
      } else if (busy(s.status)) {
        toast(`已更新模型／思考強度；${PROVIDER_LABELS[provider]} 這一輪不變，下一輪才使用`);
      }
      if (change.force && leaf && !modelDriftOf(leaf)) toast('已把原生對話改回你選的模型');
      return;
    }
    const r = await post(`/sessions/${s.id}/config`, change);
    const leaf = leafFromResponse(r);
    if (leaf) await applyProviderLeaf(s, leaf);
    else updateComposer();
    if (typeof change.swarmMode === 'boolean') swarmToast(change.swarmMode, (leaf || r)?.meta);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

// What a person should know when swarm mode is turned on (Kimi's own notice in
// its terminal says the same), and a plain confirmation when it is turned off.
function swarmToast(on, meta) {
  if (!on) return toast('Swarm 模式已關閉');
  const ask = (meta?.permission || 'manual') === 'manual' ? ' 目前權限是「每次詢問」，子代理可能停下來等你核准。' : '';
  toast(`Swarm 模式已開啟：用量可能是一般的好幾倍，用完請 /swarm off。${ask}`);
}

// /swarm: on / off / nothing (switch) / a task (turn it on, then send the task;
// it stays on until it is turned off - the hub cannot ask Kimi for the one-shot
// "task" swarm Kimi's own terminal has).
async function swarmCommand(s, args) {
  const on = Boolean(s.meta?.swarmMode);
  const word = args.trim().toLowerCase();
  if (word === '' || word === 'on' || word === 'off') {
    const next = word === '' ? !on : word === 'on';
    if (next === on) return toast(on ? 'Swarm 模式已經是開的' : 'Swarm 模式已經是關的');
    await configure({ swarmMode: next });
    return;
  }
  if (!on && !(await configure({ swarmMode: true }))) return;
  return sendMessage({ text: args.trim(), images: [] });
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
      return toast(r.count ? `${r.count} 則訊息插隊：下一步一起讀到${isClaude(s) ? '' : `（${nameFor(s)} 自己開的這一輪不收插隊的話，下一輪一開始就一起送進去）`}` : '沒有在排隊的訊息');
    } catch (err) {
      return fail(err);
    }
  }
  if (isClaude(s)) return claudeCommand(s, name, args);
  const meta = s.meta || {};
  switch (name) {
    case 'model':
    case 'effort':
    case 'permission':
      if (!composer.openControl(name)) toast('這個模型沒有提供這個選項');
      return;
    case 'plan':
      return configure({ planMode: !meta.planMode });
    case 'swarm':
      return swarmCommand(s, args);
    case 'cluster':
      return clusterCommand(s, args);
    case 'yolo':
    case 'auto':
    case 'manual':
      await configure({ permission: name });
      return toast(`權限模式：${PERMISSION_LABELS[name]}`);
    case 'new':
      setHomeProvider(providerOf(s));
      S.home.machineId = s.machineId;
      S.home.cwdByMachine = { ...(S.home.cwdByMachine || {}), [s.machineId]: s.cwd };
      saveHome();
      return go('#/');
    case 'copy': {
      const last = await S.cur.transcript.lastReply();
      if (!last) return toast('還沒有回覆可以複製');
      await copyText(last);
      return toast(`已複製 ${nameFor(s)} 的回覆`);
    }
    case 'init':
      return sendMessage({ text: INIT_PROMPT, images: [] });
    case 'bg':
    case 'background':
      return moveToBackground();
    case 'usage':
      if (isDeepseek(s)) return toast('DeepSeek 對話不用 Kimi 訂閱，沒有方案額度。費用算在閘道的帳戶，請到閘道的網站查看用量。');
      return accountDialog(s.machineId);
    case 'autopause': {
      if (isDeepseek(s)) return toast('自動暫停看的是 Kimi 訂閱的 5 小時額度，DeepSeek 對話不用它。要延後送出訊息，請用 /later 30 繼續。', { kind: 'error' });
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
      if (isDeepseek(s)) return deepseekStatusDialog();
      const model = (meta.models || []).find((x) => x.id === meta.model);
      const ctx = meta.context;
      return accountDialog(s.machineId, [
        ['模型', model?.name || meta.model || 'Kimi 的預設模型'],
        meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
        ['權限', `${PERMISSION_LABELS[meta.permission] || PERMISSION_LABELS.manual}${meta.planMode ? ' · 計畫模式' : ''}${meta.swarmMode ? ' · Swarm 模式' : ''}`],
        ctx?.size ? ['Context', `${Math.round((ctx.used / ctx.size) * 100)}% · ${fmtK(ctx.used)} / ${fmtK(ctx.size)} tokens`] : null,
        ['資料夾', s.cwd || '—'],
        meta.owner === 'tui' ? ['執行在', meta.controllable ? '終端機（可控；Hub 的輸入會打進那個終端機）' : '終端機（Hub 經 Kimi Server API 操作，不會打進那個終端機）'] : null,
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
      setHomeProvider('claude');
      S.home.claude = { ...(S.home.claude || {}), machineId: s.machineId || null, cwdByMachine: { ...(S.home.claude?.cwdByMachine || {}), [s.machineId || 'hub']: s.cwd } };
      saveHome();
      return go('#/');
    case 'copy': {
      const last = await S.cur.transcript.lastReply();
      if (!last) return toast('還沒有回覆可以複製');
      await copyText(last);
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
    max: () => window.innerWidth - ($app.classList.contains('no-sidebar') ? 0 : sidebarWidth()) - 360,
  },
  // 子代理: the list and the report can each go from just their header to
  // everything the steps leave (down to the steps' own header).
  agentListH: { v: '--agent-list-h', def: () => 230, min: () => agentBar(), max: () => agentRoom() - agentBar() - reportShown() },
  agentReportH: { v: '--agent-report-h', def: () => 240, min: () => agentBar(), max: () => agentRoom() - agentBar() - Math.min(rawPane('agentListH'), agentRoom()) },
};
// While a divider is being dragged, what it needs to know about the layout is
// measured once, before the first move, and the sizes live in memory: reading
// the layout (offsetWidth and the like) after each write would make the
// browser lay the whole page out twice per frame, and the saved copy is
// written once, when the divider is let go.
let dragMetrics = null; // { sidebarW, room, bar }
let dragPanes = null; // sizes as they are being dragged
const sidebarWidth = () => dragMetrics?.sidebarW ?? $sidebar.offsetWidth;
// The 子代理 pane's height below its tabs, and one section header's.
const agentPane = () => $panel.querySelector('.panel-agents');
const agentBar = () => dragMetrics?.bar ?? (agentPane()?.querySelector('.agent-sec')?.offsetHeight || 28);
function agentRoom() {
  if (dragMetrics) return dragMetrics.room;
  const el = agentPane();
  return el ? el.clientHeight - (el.querySelector('.panel-head')?.offsetHeight || 48) : $panel.offsetHeight - 48;
}
const reportShown = () => {
  const r = agentPane()?.querySelector('.agent-report');
  return r && !r.hidden ? Math.min(rawPane('agentReportH'), agentRoom()) : 0;
};

function savedPanes() {
  if (dragPanes) return dragPanes;
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
function saveLayout(next) {
  try {
    localStorage.setItem('hubLayout', JSON.stringify(next));
  } catch {}
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
  if (dragPanes) dragPanes = next;
  else saveLayout(next);
  applyPanes();
}

// Dragging a divider: pointer events (so it keeps working over an iframe or
// off the window), at most one size change per frame, nothing read from the
// layout while it moves, and the saved copy written when it is let go.
// `axis` 'x' for a vertical divider, 'y' for a horizontal one; `sign` says
// which way the pointer moving grows the pane.
function dragPane(el, e, { key, axis, sign }) {
  if (e.button !== 0) return;
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  dragMetrics = { sidebarW: $sidebar.offsetWidth, room: agentRoom(), bar: agentBar() };
  dragPanes = { ...savedPanes() };
  const start = axis === 'x' ? e.clientX : e.clientY;
  const from = pane(key);
  $app.classList.add('resizing', axis === 'x' ? 'resizing-col' : 'resizing-row');
  $panel.classList.add('dragging');
  let raf = 0;
  let at = start;
  const apply = () => {
    raf = 0;
    setPane(key, axis === 'x' ? window.innerWidth - at : from + (at - start) * sign);
  };
  const move = (ev) => {
    at = axis === 'x' ? ev.clientX : ev.clientY;
    raf ||= requestAnimationFrame(apply);
  };
  let done = false;
  const up = () => {
    if (done) return; // pointerup, then the capture being lost
    done = true;
    if (raf) apply();
    cancelAnimationFrame(raf);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', up);
    const final = dragPanes;
    dragPanes = null;
    dragMetrics = null;
    saveLayout(final);
    applyPanes();
    $app.classList.remove('resizing', 'resizing-col', 'resizing-row');
    $panel.classList.remove('dragging');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
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
$grip.addEventListener('pointerdown', (e) => dragPane($grip, e, { key: 'panelW', axis: 'x', sign: -1 }));
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

// A version's own title when its page is at hand (held, or replayed by the
// Hub); the page's title otherwise (a version only listed by the Hub).
function versionTitle(art, v) {
  const html = v.html ?? S.cur?.artifactHtml?.get(v.id) ?? null;
  return html != null ? htmlTitle(html, art.path) : art.title;
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
          h('span', null, versionTitle(art, v)),
          icon('down', 'caret'),
        )
      : h('span', { class: 'artifact-name' }, versionTitle(art, v)),
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
  // Some of this page's versions are older than what the page holds: the Hub
  // has the whole conversation and replays the version asked for. (Reload
  // means the file as it is on disk now, not a replay.)
  if (art.partial && !reload) {
    const cur = S.cur;
    const ask = `${art.path}\n${v.id}`;
    artifactView.hubAsk = ask;
    const html = await artifactVersionHtml(cur, v.id);
    // Moved on to another page, version or conversation meanwhile.
    if (S.cur !== cur || S.panel?.tab !== 'artifact' || artifactView?.hubAsk !== ask) return;
    if (html != null) {
      drawArtifactHead();
      return artifactView.show(html);
    }
  }
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
  const steps = new Transcript({ cwd: S.cur.summary?.cwd, agentName: nameFor(S.cur.summary), ...subagentOpts, onRespond: respond, onImage: lightbox, onLink: openFileLink });
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
    dragPane(bar, e, { key, axis: 'y', sign: grow });
  });
  bar.addEventListener('dblclick', () => setPane(key, null));
}

// Rows are built once per subagent and then only have their text updated
// (the list is drawn several times a second while they work); rebuilding
// them would also restart their spinners.
function drawAgentList() {
  if (!agentPanel || !S.cur) return;
  const all = S.cur.transcript.agentList();
  // The spinner and the word beside it come from the same judgement the card
  // in the conversation uses (agent-state.js); the panel adds nothing of its own.
  const status = (a) => (a.running ? h('span', { class: 'spinner', 'aria-label': '執行中' }) : h('span', { class: `om-badge${a.failed ? ' om-badge--danger' : a.unknown ? ' om-badge--warning' : a.stopped ? '' : ' om-badge--success'}`, title: a.life.reasonText }, a.badge));
  const rows = (agentPanel.rows ??= new Map());
  const els = [...all].reverse().map((a) => {
    const mv = a.modelView;
    const shape = JSON.stringify([a.id === agentPanel.id, a.name, a.background, mv.text, mv.requestedText, mv.note, mv.mismatch, a.life.state, a.life.reason]);
    let r = rows.get(a.id);
    if (r?.shape !== shape) {
      const desc = h('span', { class: 'agent-item-desc' });
      const meta = h('span', { class: 'agent-item-meta' });
      const notes = [mv.requestedText, mv.note, a.life.reasonText && !a.running && !a.done ? a.life.reasonText : ''].filter(Boolean);
      const el = h(
        'button',
        { class: `agent-item${a.id === agentPanel.id ? ' on' : ''}`, type: 'button', onclick: () => a.id !== agentPanel.id && showAgents(a.id) },
        icon('agents'),
        h(
          'span',
          { class: 'agent-item-text' },
          h('span', { class: 'agent-item-name' }, h('span', { class: 'agent-item-label' }, a.name ? `子代理 · ${a.name}` : '子代理'), a.background ? h('span', { class: 'om-badge' }, '背景') : null, h('span', { class: `agent-item-model${mv.confirmed ? '' : ' unconfirmed'}${mv.mismatch ? ' mismatch' : ''}`, title: mv.title }, mv.text), mv.mismatch ? h('span', { class: 'om-badge om-badge--warning', title: mv.title }, '與要求不同') : null),
          desc,
          ...notes.map((t) => h('span', { class: 'agent-item-note' }, t)),
        ),
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

// `over`: open on top of the dialog that is open (a confirmation asked while
// editing something) instead of replacing it. Escape and the backdrop close the
// top one only, and the one underneath is the open dialog again afterwards.
function dialog(content, { wide = false, onClose, over = false } = {}) {
  const below = over ? dialogClose : null;
  if (!over) dialogClose?.();
  const box = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'om dialog-back', onclick: (e) => e.target === back && close() }, box);
  const prevFocus = document.activeElement;
  function close() {
    back.remove();
    dialogClose = below;
    onClose?.();
    prevFocus?.focus?.();
  }
  dialogClose = close;
  document.body.append(back);
  setTimeout(() => box.querySelector('[autofocus], input, .om-btn--primary')?.focus(), 0);
  return { box, close };
}

function confirmDialog({ title, body, action, destructive, over = false }) {
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
      { onClose: () => finish(false), over },
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
  if (isClaude(S.cur?.summary)) return claudeCostNode();
  // DeepSeek is billed by the gateway, not against the Kimi plan.
  if (isDeepseek(S.cur?.summary)) return null;
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

// Claude API 設定: the Console API key (sent here once, never shown again
// in full) and the defaults for new Claude conversations.
async function claudeDialog() {
  let acc = S.claude || {};
  try {
    acc = S.claude = await get('/claude');
  } catch {}
  const list = (await loadClaudeModels())?.models || [];
  // What new Claude conversations start from: the one place that is read back
  // (providerDefaultsFor), the same one the home screen uses.
  const d0 = providerDefaultsFor('claude');
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
        : acc.damaged
          ? '已儲存的 key 無法載入（見上方說明），請在這裡重新貼上一把。'
          : '還沒有設定。',
    );
  };
  drawKey();
  const modelSel = h('select', { class: 'om-input', name: 'model' }, ...list.map((x) => h('option', { value: x.id, selected: x.id === d0.model }, x.name || x.id)));
  if (d0.model && !list.some((x) => x.id === d0.model)) modelSel.append(h('option', { value: d0.model, selected: true }, d0.model));
  const effortSel = h('select', { class: 'om-input', name: 'effort' });
  const fillEfforts = () => {
    const mod = list.find((x) => x.id === modelSel.value);
    const efforts = mod?.efforts || [];
    const cur = effortSel.value || d0.effort;
    fill(effortSel, ...efforts.map((e) => h('option', { value: e, selected: e === cur }, `${EFFORT_LABELS[e] || e}${e === mod.defaultEffort ? '（模型預設）' : ''}`)));
    effortSel.disabled = efforts.length < 2;
  };
  modelSel.addEventListener('change', fillEfforts);
  fillEfforts();
  const permSel = h('select', { class: 'om-input', name: 'permission' }, ...Object.entries(CLAUDE_PERMISSION_LABELS).map(([k, v]) => h('option', { value: k, selected: k === (d0.permission || 'manual') }, v)));
  const plan = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(d0.planMode) });
  const web = h('input', { class: 'om-switch', type: 'checkbox', checked: acc.webTools !== false });
  // The defaults are saved only when the person changed one of them here: a save
  // for a key or the web switch must not turn what the form happened to show
  // into a new default (nor fail because of it).
  let defaultsTouched = false;
  for (const el of [modelSel, effortSel, permSel, plan]) el.addEventListener('change', () => (defaultsTouched = true));
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? (typeof help === 'string' ? h('span', { class: 'om-field__help' }, help) : help) : null);
  const test = async () => {
    fill(testOut, h('span', { class: 'spinner' }), ' 連線中…');
    testOut.className = 'claude-test';
    try {
      const r = await post('/claude/test');
      testOut.className = `claude-test ${r.ok ? 'ok' : 'bad'}`;
      fill(testOut, r.message);
      if (r.ok) S.claudeModels = { defaultModel: S.claudeModels?.defaultModel, models: r.models };
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
    }
  };
  const removeKey = async () => {
    if (!(await confirmDialog({ title: '要移除這把 API key 嗎？', body: '移除後，Claude 對話要等你再設定一把 key 才能繼續。這不會撤銷 key 本身，要撤銷請到 Claude Console。', action: '移除', destructive: true }))) return;
    try {
      acc = S.claude = await put('/claude', { clearKey: true });
      drawKey();
      fill(testOut);
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
      const next = { model: modelSel.value, effort: effortSel.disabled ? '' : effortSel.value, permission: permSel.value, planMode: plan.checked };
      const webBefore = acc.webTools !== false;
      // The account (key, web tools) and the new-conversation defaults are two
      // different stores. A failure to save the defaults puts the account
      // settings back; a key that was just accepted stays (that was a separate,
      // explicit step) and the error says so.
      await runWithRollback([
        {
          name: 'account',
          run: async () => {
            acc = S.claude = await put('/claude', { apiKey: key || undefined, webTools: web.checked });
          },
          undo: async () => {
            acc = S.claude = await put('/claude', { webTools: webBefore });
          },
        },
        defaultsTouched ? { name: 'defaults', run: () => saveNewChatDefaults({ byProvider: { claude: next } }) } : null,
      ]).catch((err) => {
        if (key && err.failedStep === 'defaults') err.message = `API key 已儲存，但新對話預設沒有存成：${err.message}`;
        throw err;
      });
      if (key) loadClaudeModels(true);
      afterNewChatDefaultsSaved();
      d.close();
      toast(key ? '已設定 Claude API key' : '已儲存 Claude 設定');
      if (S.route === 'home') showHome();
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
      '使用 Claude Console API key，依 token 計費；不使用 Claude Code 或 Pro／Max 訂閱。',
    ),
    configDamagedNote(acc.damaged),
    field('API key', keyInput, keyNote),
    h(
      'div',
      { class: 'claude-key-actions' },
      h('a', { class: 'om-btn om-btn--sm', href: CONSOLE_KEYS, target: '_blank', rel: 'noopener' }, '到 Claude Console 建立 key'),
      acc.hasKey ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: test }, '測試連線') : null,
      acc.hasKey && acc.keySource === 'hub' ? h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', onclick: removeKey }, '移除 key') : null,
    ),
    testOut,
    h('div', { class: 'dialog-subtitle' }, '新對話的預設'),
    field('模型', modelSel, list.length ? null : '設定 API key 後，會列出這把 key 能用的模型'),
    field('思考強度', effortSel, '越高越仔細，也花越多 token'),
    field('權限', permSel, '每次詢問：修改檔案和執行指令前都問你 · 自動接受編輯：只有指令要問 · 全部自動：不會打斷你'),
    h('label', { class: 'settings-switch' }, plan, h('span', null, h('span', { class: 'om-field__label' }, '計畫模式'), h('span', { class: 'om-field__help' }, '先規劃，你同意後才動手'))),
    h('label', { class: 'settings-switch' }, web, h('span', null, h('span', { class: 'om-field__label' }, '網路搜尋與讀取網頁'), h('span', { class: 'om-field__help' }, 'Anthropic 端執行；搜尋每 1000 次 US$10 另計'))),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  form.addEventListener('submit', save);
  const d = dialog(form);
  if (!acc.hasKey) setTimeout(() => keyInput.focus(), 0);
}

// ------------------------------------------------------------- DeepSeek

// The concurrency levels the key measure goes through, one level after the other
// (the total is what the person is told before anything is sent).
const MEASURE_LEVELS = [1, 2, 4, 8, 16];

// DeepSeek 設定: which gateway the DeepSeek models come from, that gateway's
// key pool (added here once, never shown in full again), the defaults for new
// DeepSeek conversations, and what each computer currently uses.
async function deepseekDialog() {
  let acc = S.deepseek || { gateways: [], defaults: {}, activity: [] };
  try {
    acc = S.deepseek = await get('/deepseek');
  } catch {}
  let gw = acc.gateway;
  const d0 = providerDefaultsFor('deepseek');
  let models = [];
  let defaultModel = d0.model;
  const form = h('form', { class: 'settings deepseek-settings' });
  const keyInput = h('input', { class: 'om-input', type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': 'DeepSeek 閘道的 API key' });
  // Which gateway a pasted key belongs to: any of them goes into the same list.
  const addGw = h('select', { class: 'om-input ds-key-gw-select', name: 'keyGateway', 'aria-label': '這把 key 屬於哪個閘道' }, ...(acc.gateways || []).map((g) => h('option', { value: g.id, selected: g.id === gw }, g.label)));
  const keyNote = h('span', { class: 'om-field__help' });
  const keyActions = h('div', { class: 'claude-key-actions' });
  const errBox = h('div', { class: 'om-field__error ds-error', role: 'alert' });
  const testOut = h('div', { class: 'claude-test', role: 'status' });
  const gwBox = h('div', { class: 'gw-list', role: 'radiogroup', 'aria-label': '閘道' });
  const keyHead = h('div', { class: 'ds-key-head' });
  const keyBox = h('div', { class: 'ds-key-list' });
  const allOutBox = h('div', { class: 'ds-all-out-box' });
  const machineBox = h('div', { class: 'ds-machines' });
  const modelSel = h('select', { class: 'om-input', name: 'model' });
  const effortSel = h('select', { class: 'om-input', name: 'effort' });
  const permSel = h('select', { class: 'om-input', name: 'permission' }, ...Object.entries(PERMISSION_LABELS).map(([k, v]) => h('option', { value: k, selected: k === (d0.permission || 'manual') }, v)));
  const plan = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(d0.planMode) });
  // Saved as new-conversation defaults only if the person changed one of them
  // here (a gateway change on its own must not depend on them).
  let defaultsTouched = false;
  for (const el of [modelSel, effortSel, permSel, plan]) el.addEventListener('change', () => (defaultsTouched = true));
  const secondaryBox = h('div', { class: 'callout small', hidden: true });
  const gwNote = h('p', { class: 'om-field__help ds-note' });
  const GATEWAY_NOTES = {
    'opencode-go': 'OpenCode Go 訂閱。',
    opencode: 'OpenCode 按量計費。',
    commandcode: 'Command Code 需要含 API 的方案（Go 不含）。',
  };
  const SWITCH_NOTE = '換閘道後，舊對話請重選模型。';
  const STORAGE_NOTE = 'key 只顯示尾碼，保存在中控台與受控 connector（0600）。';
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? (typeof help === 'string' ? h('span', { class: 'om-field__help' }, help) : help) : null);
  const cur = () => (acc.gateways || []).find((g) => g.id === gw) || { id: gw, label: gw, keys: [] };
  const keysOf = (g = cur()) => (Array.isArray(g.keys) ? g.keys : []);
  const showError = (err) => {
    errBox.textContent = err?.message || String(err || '');
  };
  const clearError = () => {
    errBox.textContent = '';
  };
  const action = (label, onclick, { destructive = false, act, title } = {}) => h('button', { class: `om-btn om-btn--sm${destructive ? ' om-btn--destructive' : ''}`, type: 'button', onclick, ...(act ? { 'data-act': act } : {}), ...(title ? { title, 'aria-label': title } : {}) }, label);

  const drawModels = () => {
    const keep = modelSel.value || defaultModel;
    fill(modelSel, ...models.map((x) => h('option', { value: x.id, selected: x.id === keep }, x.name || x.id)));
    if (!models.some((x) => x.id === modelSel.value)) modelSel.value = models.find((x) => x.id === defaultModel)?.id || models[0]?.id || '';
    const efforts = models[0]?.efforts || ['high', 'max'];
    fill(effortSel, ...efforts.map((e) => h('option', { value: e, selected: e === (effortSel.value || d0.effort) }, `${EFFORT_LABELS[e] || e}${e === models[0]?.defaultEffort ? '（預設）' : ''}`)));
  };
  const loadModels = async () => {
    const target = gw;
    try {
      const r = await get(`/deepseek/models?gateway=${encodeURIComponent(target)}`);
      if (gw !== target) return;
      models = r.models;
      defaultModel = r.defaultModel;
      if (target === acc.gateway) S.deepseekModels = r;
    } catch {
      if (gw !== target) return;
      models = [];
    }
    drawModels();
  };
  const drawGateways = () => {
    gwNote.textContent = `${GATEWAY_NOTES[gw] || ''}${gw !== acc.gateway ? SWITCH_NOTE : ''}`;
    return fill(
      gwBox,
      ...(acc.gateways || []).map((g) =>
        h(
          'label',
          { class: `gw-item${g.id === gw ? ' on' : ''}` },
          h('input', { type: 'radio', name: 'gateway', value: g.id, checked: g.id === gw, onchange: () => ((gw = g.id), clearError(), fill(testOut), drawGateways(), drawKeyNote(), drawKeys(), drawKeyActions(), drawMachines(), loadModels()) }),
          h('span', { class: 'gw-name' }, g.label),
          h('span', { class: 'gw-state' }, g.hasKey ? `${g.keyCount || keysOf(g).length} 把 key` : '還沒有 key'),
        ),
      ),
    );
  };
  const rot = () => (Array.isArray(acc.rotation?.keys) ? acc.rotation.keys : []);
  const drawKeyNote = () => {
    const n = rot().length;
    keyInput.placeholder = n ? '貼上要加入清單的另一把 key' : '貼上 API key';
    fill(keyNote, n ? '' : '加入第一把 key 才能使用 DeepSeek。');
  };
  const drawKeyActions = () => {
    const n = rot().length;
    const picked = (acc.gateways || []).find((g) => g.id === addGw.value);
    fill(
      keyActions,
      picked?.site ? h('a', { class: 'om-btn om-btn--sm', href: picked.site, target: '_blank', rel: 'noopener' }, `到 ${picked.label} 取得 key`) : null,
      n ? action('測試使用中的 key', () => test()) : null,
      n ? action(`清空全部 ${n} 把 key…`, clearAll, { destructive: true }) : null,
    );
  };
  // How a key stands, in words; a reset time is shown only when its gateway
  // stated one, and "unknown" is said as unknown.
  const keyState = (k) => {
    if (k.state === 'manual' || k.manual) return { text: '手動標記已滿', badge: 'warning' };
    if (k.state === 'exhausted' || k.exhaustedAt) {
      if (k.expiryKnown && k.resetAt) return { text: `已滿，${new Date(k.resetAt).toLocaleString()} 重置`, badge: 'warning' };
      if (k.resetAt) return { text: '已滿，閘道說的重置時間已過（下一個真實請求會再試）', badge: 'warning' };
      return { text: '已滿，重置時間未知（下一個真實請求會再試）', badge: 'warning' };
    }
    return k.active ? { text: '使用中', badge: 'success' } : { text: '待命', badge: '' };
  };
  // Every key out: say whether any gateway named a time, and how to get going.
  const allOutText = () => {
    const keys = rot();
    const r = acc.rotation || {};
    const head = `全部 ${keys.length} 把 key 都用盡了。`;
    if (keys.every((k) => k.state === 'manual')) return `${head}都是你手動標記的，不會自動再試；按「清除標記」才會再用，或加入新的 key。`;
    const when = r.nextResetAt ? `閘道說過最早的重置時間是 ${new Date(r.nextResetAt).toLocaleString()}。` : '沒有任何閘道說過重置時間。';
    return `${head}${when}重置時間未知的 key 下一個真實請求會再試；現在要恢復：對那把按「重新啟用」（會真的送一次很小的請求確認）或「清除標記」，或加入新的 key。`;
  };
  // The last concurrency measure of each key (kept here while the dialog is open;
  // the Hub keeps the latest one, loaded below): { running } | { error } | the result.
  const measureOf = new Map();
  const measureView = (k) => {
    const m = measureOf.get(k.id);
    if (!m) return null;
    if (m.running) return h('div', { class: 'ds-measure', role: 'status' }, h('span', { class: 'spinner' }), ` 量測中：依序以 ${MEASURE_LEVELS.join('、')} 個並行送出，共 ${m.total} 個請求（由連接器那台電腦送出）…`);
    if (m.error) return h('div', { class: 'ds-measure bad', role: 'alert' }, m.error);
    const cell = (v, cls) => h('td', cls ? { class: cls } : null, v);
    return h(
      'div',
      { class: 'ds-measure' },
      h('div', { class: 'ds-measure-head' }, `並行上限量測 · 在「${m.machineName || m.machineId}」量 · ${new Date(m.at).toLocaleString()} · 共送出 ${m.totalRequests} 個請求`),
      h(
        'div',
        { class: 'ds-measure-scroll' },
        h(
          'table',
          { class: 'ds-measure-table' },
          h('thead', null, h('tr', null, ...['並行數', '成功', '429', '其他失敗', '延遲 p50', '延遲 p95'].map((c) => h('th', { scope: 'col' }, c)))),
          h(
            'tbody',
            null,
            ...m.levels.map((l) =>
              h(
                'tr',
                { 'data-concurrency': String(l.concurrency) },
                cell(String(l.concurrency)),
                cell(`${l.ok}／${l.requests}`),
                cell(String(l.http429), l.http429 ? 'warn' : ''),
                cell(String(l.errors), l.errors ? 'bad' : ''),
                cell(l.latencyMs ? `${l.latencyMs.p50} ms` : '—'),
                cell(l.latencyMs ? `${l.latencyMs.p95} ms` : '—'),
              ),
            ),
          ),
        ),
      ),
      m.stoppedEarly ? h('div', { class: 'ds-measure-note' }, m.stoppedEarly) : null,
      m.levels.some((l) => l.codes?.length) ? h('div', { class: 'ds-measure-note' }, `閘道回的錯誤代碼：${[...new Set(m.levels.flatMap((l) => l.codes || []))].join('、')}`) : null,
    );
  };
  // Costs real requests on this key, so it asks first and says how many; the
  // Hub refuses unless it is told that very number. The key itself never
  // leaves the computer whose connector sends them.
  const measure = async (k) => {
    if (measureOf.get(k.id)?.running) return;
    const total = MEASURE_LEVELS.reduce((a, b) => a + b, 0);
    const go = await confirmDialog({
      title: `要量 …${k.hint} 的並行上限嗎？`,
      body: `會送出共 ${total} 個極小請求、花少量額度：只對這一把 key，依序以 ${MEASURE_LEVELS.join('、')} 個並行送出。請求由連接器那台電腦送出，key 不會離開那台電腦。結果會列出每一級有幾個成功、幾個被擋（HTTP 429）和延遲。`,
      action: `送出 ${total} 個請求`,
      over: true,
    });
    if (!go) return;
    measureOf.set(k.id, { running: true, total });
    drawKeys();
    try {
      measureOf.set(k.id, await post(`/deepseek/keys/${encodeURIComponent(k.id)}/measure`, { levels: MEASURE_LEVELS, confirmedRequests: total }));
    } catch (err) {
      measureOf.set(k.id, { error: `量測失敗：${err.message}` });
    }
    drawKeys();
  };
  const drawKeys = () => {
    const keys = rot();
    fill(keyHead, h('span', { class: 'om-field__label' }, '全部 API key（依序使用，用完自動換下一把）'), h('span', { class: 'om-toolbar__spacer' }), h('span', { class: 'ds-key-count' }, keys.length ? `${keys.length} 把` : ''));
    fill(allOutBox, ...(keys.length && acc.rotation?.allExhausted ? [h('div', { class: 'callout small ds-all-out', role: 'status' }, icon('alert'), h('div', { class: 'callout-text' }, allOutText()))] : []));
    fill(
      keyBox,
      keys.length
        ? keys.map((k, i) => {
            const st = keyState(k);
            const out = k.state !== 'ready';
            return h(
              'div',
              { class: `ds-key${k.active ? ' on' : ''}${out ? ' exhausted' : ''}`, 'data-key-id': k.id },
              h(
                'div',
                { class: 'ds-key-main' },
                h('span', { class: 'ds-key-pos' }, `${k.position}`),
                h('span', { class: 'ds-key-gw' }, k.gatewayLabel || k.gateway),
                h('span', { class: 'ds-key-hint' }, `…${k.hint || '????'}`),
                h('span', { class: `om-badge${st.badge ? ` om-badge--${st.badge}` : ''} ds-key-state` }, st.text),
                h('span', { class: 'ds-key-added', title: k.addedAt ? new Date(k.addedAt).toLocaleString() : '' }, k.addedAt ? `加入於 ${relTime(k.addedAt)}` : ''),
              ),
              h(
                'div',
                { class: 'ds-key-actions' },
                i > 0 ? action('移到最前', () => move(k, 'top'), { act: 'top', title: `把 …${k.hint} 移到最前面（最先使用）` }) : null,
                i > 0 ? action('↑', () => move(k, 'up'), { act: 'up', title: `把 …${k.hint} 往前移一位` }) : null,
                i < keys.length - 1 ? action('↓', () => move(k, 'down'), { act: 'down', title: `把 …${k.hint} 往後移一位` }) : null,
                out ? action('清除標記', () => clearMark(k), { act: 'clear', title: '不問閘道，直接當作可用；下一個真實請求會確認，還是用盡就會再標記' }) : action('標記已滿', () => markFull(k), { act: 'mark', title: '你知道這把用完了：先放一邊，不會被使用也不會被探測，直到你清除標記' }),
                out ? action('重新啟用', () => retry(k), { act: 'retry', title: '真的送一次很小的請求確認額度回來了，成功才恢復' }) : null,
                action('測試', () => test(k.id), { act: 'test' }),
                action(measureOf.get(k.id)?.running ? '量測中…' : '量並行上限', () => measure(k), { act: 'measure', title: `對 …${k.hint} 依序以 ${MEASURE_LEVELS.join('、')} 個並行送極小請求，看它同時能收幾個（會花少量額度，送出前會先問你）` }),
                action('刪除', () => remove(k), { destructive: true, act: 'remove' }),
              ),
              measureView(k),
            );
          })
        : h('p', { class: 'om-field__help' }, '還沒有 key。加入後會顯示家別與尾碼；完整 key 不會再出現在畫面上。'),
    );
  };
  const drawMachines = () => {
    const rows = acc.activity || [];
    const label = (id) => (acc.gateways || []).find((g) => g.id === id)?.label || id;
    fill(
      machineBox,
      rows.length
        ? rows.map((a) => {
            const key = rot().find((k) => k.id === a.activeId);
            const out = key && key.state !== 'ready' ? (key.state === 'manual' ? '（手動標記已滿）' : '（額度用盡）') : '';
            return h(
              'div',
              { class: 'ds-machine' },
              icon('computer'),
              h('span', { class: 'ds-machine-name' }, a.machineName || a.machineId),
              h(
                'span',
                { class: 'ds-machine-key' },
                key ? `${key.gatewayLabel || key.gateway} …${key.hint || '????'}${out}` : a.activeId ? '回報的 key 已不在清單' : '尚未回報使用中的 key',
                // A connector from before keys rotated across gateways only rotates inside one.
                a.rotation ? null : h('span', { class: 'ds-machine-old' }, `（舊版連接器，只在 ${label(a.gateway)} 內換；重新執行連接指令更新後才會跨家）`),
              ),
              h('span', { class: 'ds-machine-rev', title: '這台電腦最近回報的清單版本（清單有變動就會增加）' }, `v${a.revision}`),
            );
          })
        : h('p', { class: 'om-field__help' }, '還沒有電腦回報實際使用中的 key。換 key、加入 key 或電腦重新連上後，連接器會回報；沒回報的電腦不代表沒在用。'),
    );
  };
  const draw = () => {
    acc = S.deepseek || acc;
    drawGateways();
    drawKeyNote();
    drawKeys();
    drawKeyActions();
    drawMachines();
  };

  const test = async (keyId) => {
    clearError();
    fill(testOut, h('span', { class: 'spinner' }), ' 連線中…');
    testOut.className = 'claude-test';
    try {
      const head = acc.rotation?.activeId || rot()[0]?.id;
      const r = await post('/deepseek/test', keyId ? { keyId } : head ? { keyId: head } : { gateway: gw });
      testOut.className = `claude-test ${r.ok ? 'ok' : 'bad'}`;
      fill(testOut, r.message);
      if (!r.ok) showError(r.message);
      else {
        if (Array.isArray(r.models)) models = r.models;
        if (r.defaultModel) defaultModel = r.defaultModel;
        drawModels();
        draw();
      }
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
      showError(err);
    }
  };
  let opBusy = false;
  const keyOp = async (body, label, { quiet = false } = {}) => {
    // One operation at a time: a second click while one is out would act on a list that is about to change.
    if (opBusy) return null;
    opBusy = true;
    try {
      return await keyOpNow(body, label, { quiet });
    } finally {
      opBusy = false;
    }
  };
  const keyOpNow = async (body, label, { quiet = false } = {}) => {
    clearError();
    fill(testOut, h('span', { class: 'spinner' }), ` ${label}…`);
    testOut.className = 'claude-test';
    try {
      // (No `gateway`: the choice of whose model names are used is saved with
      // the dialog, not by a key operation.)
      acc = S.deepseek = await put('/deepseek', body);
      S.deepseekModels = null;
      modelCatalogs.clear();
      homeCatalog = null;
      draw();
      fill(testOut);
      if (!quiet) {
        testOut.className = 'claude-test ok';
        fill(testOut, `已${label}`);
        toast(`已${label}`);
      }
      loadModels();
      if (S.route === 'home') showHome();
      return acc;
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
      showError(err);
      return null;
    }
  };
  const addKey = async () => {
    const value = keyInput.value.trim();
    if (!value) {
      showError('請貼上要加入的 API key');
      keyInput.focus();
      return;
    }
    const r = await keyOp({ apiKey: value, keyGateway: addGw.value }, '加入 key');
    if (r) {
      keyInput.value = '';
      keyInput.focus();
    }
  };
  const retry = (k) => keyOp({ retryKeyId: k.id }, '重新啟用');
  const move = (k, direction) => keyOp({ moveKeyId: k.id, direction }, '調整順序', { quiet: true });
  const markFull = (k) => keyOp({ markFullKeyId: k.id }, '標記已滿', { quiet: true });
  const clearMark = (k) => keyOp({ clearMarkKeyId: k.id }, '清除標記', { quiet: true });
  const remove = async (k) => {
    if (!(await confirmDialog({ title: `要刪除 ${k.gatewayLabel || ''} …${k.hint} 這把 key 嗎？`, body: '只會移除這一把；清單裡其他的 key 不受影響。刪到一把不剩時，DeepSeek 對話要等你再加入 key 才能繼續，連接的電腦上 Kimi 裡的 DeepSeek 模型來源也會一併移除。這不會撤銷 key 本身，要撤銷請到閘道的網站。', action: '刪除', destructive: true, over: true }))) return;
    await keyOp({ removeKeyId: k.id }, '刪除 key');
  };
  const clearAll = async () => {
    const withKeys = (acc.gateways || []).filter((g) => g.keyCount > 0);
    const n = rot().length;
    if (!(await confirmDialog({ title: `要清空全部 ${n} 把 key 嗎？`, body: '清單裡所有閘道的 key 都會從中控台與受控 connector 移除。DeepSeek 對話要等你再加入 key 才能繼續。這不會撤銷 key 本身，要撤銷請到閘道的網站。', action: '清空', destructive: true, over: true }))) return;
    for (const g of withKeys) await keyOp({ keyGateway: g.id, clearKey: true }, '清空 key', { quiet: g !== withKeys.at(-1) });
  };
  const save = async (e) => {
    e.preventDefault();
    clearError();
    fill(testOut, h('span', { class: 'spinner' }), ' 儲存設定…');
    testOut.className = 'claude-test';
    try {
      const next = { model: modelSel.value, effort: effortSel.value, permission: permSel.value, planMode: plan.checked };
      const gatewayBefore = acc.gateway;
      // The gateway comes first (the model list belongs to it); the defaults are
      // checked against that list. If they are refused, the gateway goes back.
      await runWithRollback([
        gw === gatewayBefore
          ? null
          : {
              name: 'gateway',
              run: async () => {
                acc = S.deepseek = await put('/deepseek', { gateway: gw });
              },
              undo: async () => {
                acc = S.deepseek = await put('/deepseek', { gateway: gatewayBefore });
              },
            },
        defaultsTouched ? { name: 'defaults', run: () => saveNewChatDefaults({ byProvider: { deepseek: next } }) } : null,
      ]);
      S.deepseekModels = null;
      afterNewChatDefaultsSaved();
      dlg.close();
      toast('已儲存 DeepSeek 設定');
      if (S.route === 'home') showHome();
    } catch (err) {
      testOut.className = 'claude-test bad';
      fill(testOut, err.message);
      showError(err);
    }
  };
  keyInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addKey();
  });
  draw();
  addGw.addEventListener('change', drawKeyActions);
  fill(
    form,
    h('div', { class: 'dialog-title' }, 'DeepSeek'),
    h(
      'p',
      { class: 'dialog-text settings-lead' },
      'OpenCode 與 Command Code 的 key 放在同一份清單，依序使用：目前這把額度真的用完（閘道回了額度錯誤）就自動換下一把，不論是哪一家；換家時網址、模型名稱與標頭會一起換，對話看不到錯誤。模型仍只有 DeepSeek V4.1 Flash。',
    ),
    configDamagedNote(acc.damaged),
    h('div', { class: 'dialog-subtitle first' }, 'API key（所有閘道一份清單）'),
    keyHead,
    allOutBox,
    keyBox,
    h('div', { class: 'om-field' }, h('span', { class: 'om-field__label' }, '加入 API key'), h('div', { class: 'ds-key-add' }, addGw, keyInput, h('button', { class: 'om-btn om-btn--sm om-btn--primary', type: 'button', onclick: addKey }, '加入 key')), keyNote),
    keyActions,
    testOut,
    errBox,
    h('p', { class: 'om-field__help ds-note' }, STORAGE_NOTE),
    h('div', { class: 'dialog-subtitle' }, '各機實際 key'),
    machineBox,
    h('div', { class: 'dialog-subtitle' }, '模型名稱來源'),
    gwBox,
    gwNote,
    h('div', { class: 'dialog-subtitle' }, '新對話的預設'),
    field('模型', modelSel),
    field('思考強度', effortSel, 'max 最仔細，也花最多 token'),
    field('權限', permSel),
    h('label', { class: 'settings-switch' }, plan, h('span', null, h('span', { class: 'om-field__label' }, '計畫模式'), h('span', { class: 'om-field__help' }, '先規劃再執行'))),
    h('p', { class: 'om-field__help ds-note' }, '保留 Kimi 登入、主模型與既有子代理設定。'),
    secondaryBox,
    ...(acc.warnings || []).map((w) => h('div', { class: 'callout small ds-secondary' }, icon('alert'), h('div', { class: 'callout-text' }, `「${w.machineName}」：${w.text}`))),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => dlg.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
  form.addEventListener('submit', save);
  const dlg = dialog(form, { onClose: () => S.deepseekDraw === draw && (S.deepseekDraw = null) });
  // A broadcast (another browser, or a connector reporting a rotated key)
  // redraws the pool without touching what is typed into the key field.
  S.deepseekDraw = draw;
  if (!cur().hasKey) setTimeout(() => keyInput.focus(), 0);
  loadModels();
  // The last concurrency measure of each key, if one was made (the Hub keeps it).
  get('/deepseek/keys/timing')
    .then((t) => {
      for (const e of t.keys || []) if (e.measure && !measureOf.has(e.id)) measureOf.set(e.id, e.measure);
      if (measureOf.size) drawKeys();
    })
    .catch(() => {});
  // Show each machine's actual native default, including a preserved custom one.
  get('/deepseek/secondary')
    .then((list) => {
      if (!list.length) return;
      secondaryBox.hidden = false;
      fill(
        secondaryBox,
        icon('computer'),
        h('div', { class: 'callout-text' }, ['各機原生子代理', ...list.map((x) => `「${x.machineName}」：${x.model}${x.effort ? ` · 思考 ${EFFORT_LABELS[x.effort] || x.effort}` : ''}${x.force ? ' · 強制' : ''}`)].join('\n')),
      );
    })
    .catch(() => {});
}


// /status in a DeepSeek conversation.
function deepseekStatusDialog() {
  const s = S.cur?.summary;
  if (!s) return;
  const meta = s.meta || {};
  const model = (meta.models || []).find((x) => x.id === meta.model);
  const ctx = meta.context;
  const acc = S.deepseek || {};
  const list = acc.rotation?.keys || [];
  const active = list.find((k) => k.active);
  const rows = [
    ['模型', model?.name || meta.model || '—'],
    meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
    ['權限', `${PERMISSION_LABELS[meta.permission] || PERMISSION_LABELS.manual}${meta.planMode ? ' · 計畫模式' : ''}${meta.swarmMode ? ' · Swarm 模式' : ''}`],
    ctx?.size ? ['Context', `${Math.round((ctx.used / ctx.size) * 100)}% · ${fmtK(ctx.used)} / ${fmtK(ctx.size)} tokens（Kimi 用到約 85% 會自動壓縮）`] : null,
    ['資料夾', s.cwd || '—'],
    ['執行在', `「${machineById(s.machineId)?.name || s.meta?.machineName || '那台電腦'}」的 Kimi Code${meta.kimiVersion ? ` ${meta.kimiVersion}` : ''}`],
    ['計費', `${active?.gatewayLabel || dsLabel()} 的 API key，不用 Kimi 訂閱`],
    ['API key', acc.hasKey ? `${list.length || 1} 把（依序使用），使用中 ${active ? `${active.gatewayLabel} …${active.hint}` : '—（全部用盡）'}` : '還沒有設定'],
  ].filter(Boolean);
  const body = h(
    'div',
    { class: 'account' },
    h('div', { class: 'dialog-title' }, '狀態'),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => (d.close(), deepseekDialog()) }, 'DeepSeek 設定…'), h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
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
        '每台電腦用 gh 登入一次；登入資料不會存進中控台。',
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
        '用 rclone 備份對話資料夾；保留最新版與 30 天每日快照。',
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
// With `session`: that conversation, bound from now on.
// `agent`: whose new conversations ('claude' or 'kimi').
async function repoDialog(m, session = null, agent = session ? agentOf(session) : 'claude') {
  const kimi = agent === 'kimi' || agent === 'deepseek';
  const who = agent === 'deepseek' ? 'DeepSeek' : kimi ? 'Kimi' : 'Claude';
  const key = kimi ? m.id : m.id || 'hub';
  const cur = (session ? null : kimi ? kimiRepo(m) : claudeRepo(m)) || {};
  const store = (value) => {
    if (kimi) S.home.repoByMachine = { ...(S.home.repoByMachine || {}), [key]: value };
    else {
      const x = (S.home.claude ??= {});
      x.repoByMachine = { ...(x.repoByMachine || {}), [key]: value };
    }
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
  if (isDeepseek(s)) {
    toast('DeepSeek 對話不用 Kimi 訂閱，沒有 5 小時額度。用 /later 30 繼續 定時送出。', { kind: 'error' });
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
  const noQuota = isClaude(S.cur?.summary) || isDeepseek(S.cur?.summary);
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
  const claude = isClaude(s) || isDeepseek(s);
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
    fill(
      statusBox,
      st ? h('div', { class: `ap-now${st.tone ? ` ${st.tone}` : ''}` }, icon('pause'), h('div', null, h('div', { class: 'ap-now-label' }, st.label), h('div', { class: 'ap-now-detail' }, st.detail)), st.paused ? h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: cancelAutoResume }, '取消繼續') : null) : null,
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

// The one place the new-conversation defaults are written: PUT /api/settings
// with defaults.byProvider (spec §6). 設定, Claude API… and DeepSeek… all come
// through here, and all of them read back through providerDefaultsFor(), so a
// save in any of them is what the home screen starts from.
async function saveNewChatDefaults({ provider, byProvider }) {
  const saved = await put('/settings', { defaults: { ...(provider ? { provider } : {}), byProvider } });
  if (saved && typeof saved === 'object') S.config.settings = saved;
  return saved;
}
function afterNewChatDefaultsSaved({ fromSettings = false } = {}) {
  modelCatalogs.clear();
  homeCatalog = null;
  resetHomeChoices({ fromSettings });
  updateHomeComposer();
}

async function openSettings() {
  const m = homeMachine();
  let cat = homeCatalog;
  try {
    cat = await loadModels({ machine: m?.id || '', force: true });
  } catch (err) {
    cat = cat || emptyCatalog(err.message);
  }
  // If the user made a temporary home choice, the dialog starts there; after
  // saving, that choice becomes the stored default. Otherwise the server
  // default (already reflected by resetHomeChoices) is shown.
  let provider = homeProvider();
  const providerSel = h(
    'select',
    { class: 'om-input', name: 'provider' },
    ...PROVIDERS.map((id) => {
      const g = cat.byProvider[id];
      return h('option', { value: id, selected: id === provider, disabled: !g?.available }, `${PROVIDER_LABELS[id]}${g?.available ? '' : `（不可用：${g?.reason || '沒有可用模型'}）`}`);
    }),
  );
  providerSel.value = provider;
  const modelSel = h('select', { class: 'om-input', name: 'model' });
  const effortSel = h('select', { class: 'om-input', name: 'effort' });
  const permSel = h('select', { class: 'om-input', name: 'permission' });
  const plan = h('input', { class: 'om-switch', type: 'checkbox' });
  const lookSel = h(
    'select',
    {
      class: 'om-input',
      name: 'palette',
      onchange: () =>
        fadeColors(() => {
          applyLook(lookSel.value, { save: true });
          if (lookSel.value === 'kimi') applyTheme(savedTheme(), { save: false });
        }),
    },
    ...LOOKS.map((id) => h('option', { value: id, selected: id === palette() }, LOOK_LABELS[id])),
  );
  const help = h('div', { class: 'om-field__help' });
  const field = (label, control, hint) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, hint ? (typeof hint === 'string' ? h('span', { class: 'om-field__help' }, hint) : hint) : null);
  const providerDefaults = (p) => (p === homeProvider() ? homeState(p) : providerDefaultsFor(p));
  const fillEfforts = (preferred = '') => {
    const group = cat.byProvider[provider];
    const mod = findModel(group?.models, modelSel.value);
    const list = mod?.efforts || [];
    const cur = preferred || (list.includes(effortSel.value) ? effortSel.value : '');
    fill(effortSel, h('option', { value: '' }, '模型預設'), ...list.map((e) => h('option', { value: e }, `${EFFORT_LABELS[e] || e}${e === mod.defaultEffort ? '（模型預設）' : ''}`)));
    effortSel.value = list.includes(cur) ? cur : '';
    effortSel.disabled = !list.length;
  };
  const drawProvider = () => {
    provider = providerSel.value;
    const group = cat.byProvider[provider];
    const d0 = providerDefaults(provider);
    const list = group?.models || [];
    const keep = d0.model && findModel(list, d0.model) ? d0.model : group?.defaultModel || list.find((x) => x.available !== false)?.id || '';
    const keepModel = findModel(list, keep) || list.find((x) => x.available !== false) || null;
    fill(modelSel, ...(list.length ? list.map((x) => h('option', { value: modelKey(x), disabled: x.available === false }, `${x.name}${x.available === false ? `（不可用：${x.reason || '模型不可用'}）` : ''}`)) : [h('option', { value: '' }, '沒有可用模型')]));
    modelSel.value = keepModel ? modelKey(keepModel) : '';
    fillEfforts(d0.effort || '');
    fill(permSel, ...Object.entries(permissionLabels(provider)).map(([k, v]) => h('option', { value: k, selected: k === (d0.permission || 'manual') }, v)));
    plan.checked = Boolean(d0.planMode);
    help.textContent = group?.available ? (list.length ? (group.reason || '') : '這個供應商沒有可用模型') : group?.reason || '這個供應商目前不可用';
    saveBtn.disabled = !group?.available || !list.some((x) => sameModel(x, modelSel.value) && x.available !== false);
  };
  providerSel.addEventListener('change', drawProvider);
  modelSel.addEventListener('change', () => fillEfforts());
  const saveBtn = h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存');
  const save = async (e) => {
    e.preventDefault();
    const group = cat.byProvider[provider];
    const model = findModel(group?.models, modelSel.value);
    if (!group?.available || !model || model.available === false) return fail(new Error(group?.reason || model?.reason || '這個供應商目前不可用'));
    // The settings API stores the provider's own id (the session/provider API
    // is the one that takes the Kimi alias).
    const d0 = { model: model.id, effort: effortSel.disabled ? '' : effortSel.value, permission: permSel.value, planMode: plan.checked };
    try {
      // One request, so it either all lands or none of it does.
      await saveNewChatDefaults({ provider, byProvider: { [provider]: d0 } });
      homeProviderTouched = false;
      setHomeProvider(provider, { touch: false });
      afterNewChatDefaultsSaved({ fromSettings: true });
      d.close();
      if (S.route === 'home') showHome();
      toast(`已儲存新對話預設：${PROVIDER_LABELS[provider]}`);
    } catch (err) {
      fail(err);
    }
  };
  const form = h('form', { class: 'settings' });
  fill(
    form,
    h('div', { class: 'dialog-title' }, '設定'),
    h('div', { class: 'dialog-subtitle first' }, '新對話的預設'),
    h('p', { class: 'dialog-text settings-lead' }, '只套用於之後的新對話；既有對話不變。'),
    field('供應商', providerSel),
    field('模型', modelSel, help),
    field('思考強度', effortSel),
    field('權限', permSel),
    h('label', { class: 'settings-switch' }, plan, h('span', null, h('span', { class: 'om-field__label' }, '計畫模式'), h('span', { class: 'om-field__help' }, '先規劃，你同意後才動手'))),
    field('配色', lookSel, '只改變外觀，與目前或下一個模型無關。Kimi 配色另有淺色／深色。'),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), saveBtn),
  );
  drawProvider();
  form.addEventListener('submit', save);
  const d = dialog(form);
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
      h('li', null, '完成。那台電腦的 Kimi 對話（包含終端機裡正在跑的）會即時出現在左邊的「子session」。'),
    ),
    h('div', { class: 'dialog-subtitle' }, '終端機裡的 Kimi'),
    h('p', { class: 'dialog-text' }, '終端機裡的 Kimi 會自動同步到這裡。無論終端機是否可控，都能直接從 Hub 送出訊息、核准與停止；不可控的終端機會經 Kimi Server API 操作，不會收到 TUI 按鍵。想讓 Hub 的輸入打進那個終端機，才需要用這個指令啟動（macOS / Linux，需要 python3）：'),
    h('div', { class: 'cmd' }, h('code', null, wrap), h('button', { class: 'om-btn om-btn--sm', type: 'button', onclick: (e) => copyText(wrap).then(() => ((e.target.textContent = '已複製'), setTimeout(() => (e.target.textContent = '複製'), 1500))) }, '複製')),
    h('p', { class: 'dialog-text muted' }, "可以加進 ~/.bashrc 或 ~/.zshrc：alias kimi-hub='node ~/.agent-hub/agent-hub-bridge.mjs kimi'。這只影響 Hub 的輸入要不要走終端機；不是用它啟動的 Kimi 一樣可以從 Hub 操作。"),
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
  const r = await get('/sessions');
  const list = Array.isArray(r) ? r : r?.sessions || [];
  // The server returns each chain's leaf. Keep that contract even if an older
  // hub still sends every node: retain one leaf per conversationId.
  const byConversation = new Map();
  const rank = (s, cid) => (s.continuedFrom ? 2 : s.id === cid ? 1 : 0);
  for (const s of list) {
    if (!s?.id || s.continuedTo || s.isLeaf === false) continue;
    const cid = conversationIdOf(s);
    const prev = byConversation.get(cid);
    if (!prev || rank(s, cid) > rank(prev, cid) || (rank(s, cid) === rank(prev, cid) && (s.updatedAt || 0) >= (prev.updatedAt || 0))) byConversation.set(cid, s);
  }
  S.sessions = new Map([...byConversation.values()].map((s) => [s.id, s]));
  renderSidebar();
}

function upsertSession(summary) {
  const s = normalizeSummary(summary);
  if (!s.id) return;
  // An old chain node is not a sidebar entry. If it is the one on screen, go
  // to the leaf it was continued into.
  if (s.continuedTo || s.isLeaf === false) {
    if (S.cur?.id === s.id) {
      (async () => {
        let leaf = null;
        try {
          leaf = s.continuedTo ? await resolveLeaf(s) : s.leafId ? normalizeSummary(await get(`/sessions/${s.leafId}`)) : null;
        } catch {}
        if (leaf?.id && leaf.id !== s.id) {
          S.sessions.set(leaf.id, leaf);
          location.replace(`#/s/${leaf.id}`);
        }
      })();
    }
    return;
  }
  if (!s.kimiSessionId && !isClaude(s) && !s.provider) return;
  if (S.cur?.id === s.continuedFrom) {
    S.sessions.set(s.id, s);
    location.replace(`#/s/${s.id}`);
    return;
  }
  // Do not let an old first node reappear after a newer leaf arrived.
  const newer = [...S.sessions.values()].find((x) => x.id !== s.id && conversationIdOf(x) === conversationIdOf(s) && x.continuedFrom && !s.continuedFrom);
  if (newer) return;
  const prev = S.sessions.get(s.id);
  if (s.continuedFrom) S.sessions.delete(s.continuedFrom);
  S.sessions.set(s.id, s);
  renderSidebar();
  if (S.cur?.id === s.id) {
    const was = S.cur.summary?.status;
    const wasProvider = S.cur.summary ? providerOf(S.cur.summary) : '';
    S.cur.summary = s;
    S.cur.conversationId = conversationIdOf(s);
    applyProvider(providerOf(s));
    drawHandoffNote(S.cur.handoffNote, s);
    drawClusterNote(S.cur.clusterNote, s);
    loadClustersOf(s).then((fresh) => fresh && S.cur?.id === s.id && drawCurrentClusterNote());
    S.cur.transcript.opts.agentName = nameFor(s);
    const tps = s.meta?.tps || 0;
    if (s.meta?.servedModel?.name !== prev?.meta?.servedModel?.name) S.cur.transcript.setServed(s.meta?.servedModel?.name);
    if (was !== s.status || tps !== (prev?.meta?.tps || 0)) S.cur.transcript.setStatus(s.status, busy(s.status) && !busy(was) ? Date.now() : null, tps);
    if (wasProvider !== providerOf(s) || !sessionCatalog || sessionCatalogKey !== s.id) {
      sessionCatalog = null;
      sessionCatalogKey = '';
      ensureSessionModels(s, true);
    }
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
    case 'cluster': {
      if (!m.cluster?.id) return;
      rememberCluster(m.cluster);
      clusterPage?.update(m.cluster);
      return drawCurrentClusterNote();
    }
    case 'deleted':
      S.sessions.delete(m.sid);
      if (S.cur?.id === m.sid) go('#/');
      return renderSidebar();
    case 'batch':
      for (const x of m.items) onMessage(x);
      return;
    case 'snapshot': {
      const cur = S.cur;
      if (!cur) return;
      // Opening an old chain node: the server's watch resolves it to the
      // leaf and sends the snapshot under the leaf id. Follow it at once
      // instead of waiting for the HTTP fallback.
      if (cur.id !== m.sid) {
        const leaf = normalizeSummary(m.session);
        if (leaf.id === m.sid && S.route === `s:${cur.id}`) {
          S.sessions.set(m.sid, leaf);
          location.replace(`#/s/${m.sid}`);
        }
        return;
      }
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
      if (S.route === 'home' && (!before || before.online !== m.machine.online || before.kimi?.available !== m.machine.kimi?.available)) {
        modelCatalogs.clear();
        homeCatalog = null;
        showHome();
      }
      return;
    }
    case 'machines':
      return loadMachines().then(() => machinesDialog?.draw());
    case 'claude':
      S.claude = m.account;
      if (S.config) S.config.claude = m.account;
      modelCatalogs.clear();
      if (S.route === 'home') {
        homeCatalog = null;
        showHome();
      }
      return;
    case 'deepseek':
      S.deepseek = m.account;
      if (S.config) S.config.deepseek = m.account;
      S.deepseekModels = null;
      modelCatalogs.clear();
      // An open 設定 page redraws the pool but keeps the key being typed.
      S.deepseekDraw?.();
      if (S.route === 'home') {
        homeCatalog = null;
        showHome();
      }
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
    applyLook(palette(), { save: false });
    applyTheme(savedTheme(), { save: false });
  } catch {}
  try {
    S.config = await get('/config');
    S.claude = S.config.claude || null;
    S.deepseek = S.config.deepseek || null;
    resetHomeChoices();
  } catch (err) {
    if (err.status === 401) return showLogin();
    fill($view, h('div', { class: 'loading' }, `連不上中控台：${err.message}`));
    return;
  }
  // Sessions first: their origin/parentId tells the sidebar which machine
  // sessions are broker children (never listed) before the machine list is
  // drawn.
  await loadSessions().catch(fail);
  await loadMachines().catch(fail);
  loadDamaged();
  socket = connect(onMessage, (ok) => {
    const was = S.online;
    S.online = ok;
    S.socketOpen = ok;
    drawFoot();
    if (ok) watchCurrent();
    if (ok) clusterPage?.load();
    if (ok) refreshClusterNote();
    if (ok) loadDamaged();
    if (ok && !was) loadSessions().then(loadMachines).catch(() => {});
  });
  route();
  // Run the rendering code once while idle, so the first conversation opened is not the one that pays for it.
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => warmTranscript(), { timeout: 2000 });
}

start();
