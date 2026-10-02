// Agent Hub — Kimi Code on all your machines, in one window.
import { h, fill, icon, relTime, dayGroup, shortPath, baseName, copyText } from './dom.js';
import { get, post, put, del, connect, setToken } from './api.js';
import { renderHunks, parseUnifiedDiff, renderMarkdown } from './markdown.js';
import { openMenu, closeMenu, menuOpen, pointAnchor } from './menu.js';
import { Transcript, todoList } from './transcript.js';
import { Composer, PERMISSION_LABELS, EFFORT_LABELS } from './composer.js';
import { ArtifactView, downloadHtml, htmlTitle } from './artifacts.js';

const S = {
  config: null,
  machines: [],
  sessions: new Map(), // hub sessions (Kimi conversations taken over by the hub)
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

// ------------------------------------------------------------- helpers

function loadHome() {
  try {
    return JSON.parse(localStorage.getItem('hubHome') || '{}');
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
// home screen applies to that one conversation.
const defaults = () => S.config?.settings?.defaults || {};
function resetHomeChoices() {
  const d = defaults();
  Object.assign(S.home, { model: d.model || '', effort: d.effort || '', permission: d.permission || 'manual', planMode: Boolean(d.planMode) });
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
const $toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
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

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try {
    if (t) localStorage.setItem('hubTheme', t);
    else localStorage.removeItem('hubTheme');
  } catch {}
}
const theme = () => document.documentElement.dataset.theme || 'auto';

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
      out.push({ key, hub: s, kimi: k, machine: m, title: s?.title || k.title || '新對話', cwd: s?.cwd || k.cwd, status, updatedAt: Math.max(s?.updatedAt || 0, k.updatedAt || 0) });
    }
  }
  for (const [key, s] of followed) out.push({ key, hub: s, machine: machineById(s.machineId), title: s.title, cwd: s.cwd, status: s.status, updatedAt: s.updatedAt, offline: !machineById(s.machineId)?.online });
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
    [...groups].map(([g, rs]) => [g, rs.map((r) => [r.key, r.title, r.cwd, r.status, r.offline, r.kimi?.owner || r.hub?.meta?.owner, r.machine?.name, relTime(r.updatedAt)])]),
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
      const sub = [owner === 'tui' ? '終端機' : null, multi && r.machine ? r.machine.name : null, r.cwd ? baseName(r.cwd) : null].filter(Boolean).join(' · ');
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
          h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, r.title), h('span', { class: 'row-sub' }, sub || relTime(r.updatedAt))),
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
    items.push(h('div', { class: 'side-empty' }, S.machines.some((m) => m.online) ? '在任一台電腦的 Kimi 裡輸入 /web，或在這裡開一個新對話。' : '連接一台電腦後，它的 Kimi 對話會出現在這裡。'));
  }
  fill($list, ...items);
  $search.parentElement.hidden = all.length < 8 && !S.query;
  drawFoot();
  updateTitle();
}

// Right-click (or the … button) on a conversation in the sidebar.
function rowMenu(r, anchor) {
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
  const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'default';
  openMenu(
    anchor,
    [
      { section: '外觀' },
      { label: '跟系統一樣', checked: t === 'auto', onSelect: () => applyTheme(null) },
      { label: '淺色', checked: t === 'light', onSelect: () => applyTheme('light') },
      { label: '深色', checked: t === 'dark', onSelect: () => applyTheme('dark') },
      { separator: true },
      canNotify ? { label: '開啟通知', description: 'Kimi 需要你的時候通知你', onSelect: () => Notification.requestPermission().then(() => toast('已開啟通知')) } : null,
      { label: '設定…', description: '新對話預設的模型、思考強度、權限', onSelect: openSettings },
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
    if (prev === undefined || prev === r.status || r.status !== 'awaiting_permission') continue;
    const here = S.cur?.summary && r.hub?.id === S.cur.summary.id;
    if (here && document.hasFocus()) continue;
    const open = () => go(r.hub ? `#/s/${r.hub.id}` : `#/k/${r.machine.id}/${r.kimi.id}`);
    if (!here) toast(`「${r.title}」需要你核准`, { action: '查看', onAction: open });
    notify('Kimi 需要你', r.title, open);
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
  if (!list.length) return fill(body, h('div', { class: 'artifacts-empty' }, h('div', { class: 'large-title' }, '還沒有 Artifact'), h('p', { class: 'home-lead' }, '請 Kimi 做一個頁面（例如輸入 /artifact 做一個進度頁），它寫的 HTML 會出現在這裡。')));
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

function homeMachine() {
  const ready = S.machines.filter((m) => m.online && m.kimi?.available);
  return machineById(S.home.machineId && ready.some((m) => m.id === S.home.machineId) ? S.home.machineId : ready[0]?.id) || null;
}

async function showHome() {
  leaveSession();
  S.route = 'home';
  hidePanel();
  renderToolbar();
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
          h('p', { class: 'home-lead' }, '中控台透過你電腦上的連接器操作 Kimi Code。Kimi 只在你自己的電腦上登入，中控台不需要你的 Kimi 帳號。'),
          h('button', { class: 'om-btn om-btn--primary om-btn--lg', type: 'button', onclick: openMachines }, '連接電腦…'),
        ),
      ),
    );
    return;
  }
  homeComposer ??= new Composer({
    home: true,
    placeholder: '要讓 Kimi 做什麼？輸入 / 看指令',
    onSend: startSession,
    onCommand: homeCommand,
    onStop: () => {},
    onConfig: (c) => {
      if (c.model) S.home.model = c.model;
      if (c.effort) S.home.effort = c.effort;
      if (c.permission) S.home.permission = c.permission;
      if ('planMode' in c) S.home.planMode = c.planMode;
      saveHome();
      updateHomeComposer();
    },
    onPickMachine: machineMenu,
    onPickFolder: folderMenu,
    onError: (t) => toast(t),
  });
  homeComposer.setKey('home');
  fill(
    $view,
    h(
      'div',
      { class: 'home' },
      h(
        'div',
        { class: 'home-inner' },
        h('div', { class: 'large-title' }, '要讓 Kimi 做什麼？'),
        homeComposer.el,
        h('p', { class: 'home-hint' }, m ? `會在「${m.name}」上的 Kimi 執行，用那台電腦登入的帳號。` : '連接的電腦目前都沒有執行中的 Kimi。在那台電腦的 Kimi 裡輸入 /web，或執行 kimi web。'),
      ),
    ),
  );
  updateHomeComposer();
  homeComposer.focus();
  loadMachineModels(m);
}

const machineModels = new Map(); // machine id -> { models, defaultModel }
async function loadMachineModels(m) {
  if (!m || machineModels.has(m.id)) return;
  try {
    machineModels.set(m.id, await get(`/machines/${m.id}/models`));
    updateHomeComposer();
  } catch {}
}

function updateHomeComposer() {
  if (!homeComposer) return;
  const m = homeMachine();
  const mm = m ? machineModels.get(m.id) : null;
  const folder = S.home.cwdByMachine?.[m?.id];
  homeComposer.update({
    machineName: m?.name,
    folderName: folder === null ? '新資料夾' : folder ? baseName(folder) : '新資料夾',
    models: mm?.models || [],
    defaultModel: mm?.defaultModel,
    model: S.home.model && mm?.models?.some((x) => x.id === S.home.model) ? S.home.model : '',
    effort: S.home.effort,
    permission: S.home.permission || 'manual',
    planMode: Boolean(S.home.planMode),
  });
}

function homeCommand(name) {
  if (name === 'usage' || name === 'status') return homeMachine() ? accountDialog(homeMachine().id) : openMachines();
  if (['model', 'effort', 'permission'].includes(name)) return homeComposer.openControl(name) || toast('這台電腦的 Kimi 沒有提供這個選項');
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

function folderMenu(anchor) {
  const m = homeMachine();
  if (!m) return openMachines();
  const recent = [...new Set((m.sessions || []).map((s) => s.cwd).filter(Boolean))].slice(0, 6);
  const pick = (cwd) => {
    S.home.cwdByMachine = { ...(S.home.cwdByMachine || {}), [m.id]: cwd };
    saveHome();
    updateHomeComposer();
  };
  openMenu(
    anchor,
    [
      recent.length ? { section: '最近使用' } : null,
      ...recent.map((p) => ({ label: baseName(p), description: shortPath(p, m.home, 4), onSelect: () => pick(p) })),
      recent.length ? { separator: true } : null,
      { label: '瀏覽資料夾…', onSelect: () => browseFolders(m, pick) },
      { label: '新的空白資料夾', description: '在 ~/agent-hub-workspaces 建立', onSelect: () => pick(null) },
    ].filter(Boolean),
    { width: 300 },
  );
}

async function startSession({ text, images }) {
  const m = homeMachine();
  if (!m) return openMachines();
  const cwd = S.home.cwdByMachine?.[m.id] || undefined;
  const mm = machineModels.get(m.id);
  const model = S.home.model && mm?.models?.some((x) => x.id === S.home.model) ? S.home.model : undefined;
  const effort = model ? S.home.effort : undefined;
  homeComposer.el.classList.add('sending');
  try {
    const s = await post('/sessions', { machineId: m.id, cwd, prompt: text, images, model, effort, permission: S.home.permission, planMode: S.home.planMode || undefined });
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

function leaveSession() {
  if (!S.cur) return;
  if (['agents', 'todos'].includes(S.panel?.tab)) hidePanel();
  clearInterval(S.cur.ping);
  S.cur.transcript.destroy();
  S.cur = null;
  S.artifacts = [];
  artifactView?.destroy();
  artifactView = null;
}

async function openSession(id) {
  if (S.cur?.id === id) return;
  leaveSession();
  S.route = `s:${id}`;
  if (S.panel?.tab === 'artifact') hidePanel();
  const summary = S.sessions.get(id);
  const cur = { id, summary, seq: 0, transcript: null, loading: true };
  S.cur = cur;
  // Keeps the conversation followed on the machine while it is open.
  cur.ping = setInterval(() => document.visibilityState === 'visible' && post(`/sessions/${id}/viewing`).catch(() => {}), 60_000);
  cur.transcript = new Transcript({
    cwd: summary?.cwd,
    onRespond: respond,
    onOpenArtifact: (path, version) => showArtifact(path, version),
    onArtifacts: (list) => {
      // A page Kimi starts writing now opens beside the conversation, so it
      // can be watched as it is generated.
      const fresh = !cur.loading && cur.knownArtifacts ? list.find((a) => !cur.knownArtifacts.has(a.path)) : null;
      S.artifacts = list;
      cur.knownArtifacts = new Set(list.map((a) => a.path));
      renderToolbar();
      if (fresh && window.matchMedia('(min-width: 1100px)').matches) showArtifact(fresh.path);
      else syncArtifact();
    },
    artifactsCache: () => S.artifacts,
    activeArtifact: () => (S.panel?.tab === 'artifact' ? S.panel.path : null),
    onImage: lightbox,
    onLoadEarlier: () => post(`/sessions/${id}/earlier`).catch(fail),
    // Working subagents go to the tray under the conversation.
    onFlush: (ids) => {
      if (S.cur !== cur || !composer) return;
      syncAgentPanel(ids);
      const agents = cur.transcript.runningAgents();
      const sig = JSON.stringify(agents);
      if (sig === cur.agentSig) return;
      cur.agentSig = sig;
      composer.update({ agents });
    },
  });
  composer ??= new Composer({
    onSend: sendMessage,
    onCommand: sessionCommand,
    onStop: interrupt,
    onConfig: configure,
    onCancelQueued: (pid) => S.cur && del(`/sessions/${S.cur.id}/queue/${pid}`).catch(fail),
    onSteerQueued: (pid) => S.cur && post(`/sessions/${S.cur.id}/queue/${pid}/steer`).catch(fail),
    onUnlock: () => S.cur && post(`/sessions/${S.cur.id}/unlock`).catch(fail),
    onError: (t) => toast(t),
    onHelp: openMachines,
    onFocusAgent: (aid) => showAgents(aid),
    onOpenTodos: showTodos,
  });
  composer.setKey(id);
  composer.update({ agents: [] });
  fill($view, h('div', { class: 'session' }, cur.transcript.el, h('div', { class: 'composer-dock' }, composer.el)));
  renderToolbar();
  renderSidebar();
  try {
    const full = await get(`/sessions/${id}`);
    if (S.cur !== cur) return;
    applySnapshot(full);
  } catch (err) {
    if (S.cur !== cur) return;
    if (err.status === 404) return go('#/');
    fill($view, h('div', { class: 'loading' }, err.message));
  }
  composer.focus();
}

function applySnapshot(full) {
  const cur = S.cur;
  const { events, seq, ...summary } = full;
  cur.summary = summary;
  cur.seq = seq;
  cur.loading = false;
  S.sessions.set(summary.id, summary);
  cur.transcript.opts.cwd = summary.cwd;
  cur.transcript.load(events);
  cur.transcript.setStatus(summary.status, busy(summary.status) ? lastUserTs(events) : null);
  S.artifacts = cur.transcript.artifacts();
  cur.knownArtifacts = new Set(S.artifacts.map((a) => a.path));
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

async function resync() {
  if (!S.cur) return;
  const cur = S.cur;
  try {
    const full = await get(`/sessions/${cur.id}`);
    if (S.cur === cur) applySnapshot(full);
  } catch {}
}

function updateComposer() {
  const s = S.cur?.summary;
  if (!s || !composer) return;
  if (S.panel?.tab === 'todos' && JSON.stringify(s.meta?.todos || []) !== S.panel.todosSig) {
    S.panel.todosSig = JSON.stringify(s.meta?.todos || []);
    drawTodos();
  }
  const meta = s.meta || {};
  composer.update({
    running: s.status === 'running',
    awaiting: s.status === 'awaiting_permission',
    queue: meta.queue || [],
    todos: meta.todos || [],
    models: meta.models || [],
    model: meta.model,
    defaultModel: meta.defaultModel,
    effort: meta.effort,
    permission: meta.permission,
    planMode: meta.planMode,
    context: meta.context,
    skills: meta.skills || [],
    terminal: meta.owner === 'tui',
    controllable: Boolean(meta.controllable),
    guess: Boolean(meta.guess),
  });
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
  const sub = [m?.name || s.meta?.machineName, s.cwd ? shortPath(s.cwd, m?.home, 3) : null].filter(Boolean).join(' · ');
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
        s.meta?.owner === 'tui' ? h('span', { class: 'om-badge', title: s.meta.guess ? '同一個資料夾有終端機的 Kimi 開著，可能正在用這個對話，這裡先只能看' : s.meta.controllable ? '在終端機的 Kimi 裡執行，可以從這裡操作' : '在終端機的 Kimi 裡執行，這裡只能看' }, s.meta.controllable ? '終端機' : '終端機 · 唯讀') : null,
      ),
    ),
    h('span', { class: 'om-toolbar__spacer' }),
    arts ? h('button', { class: `om-btn om-btn--toolbar wide${S.panel?.tab === 'artifact' ? ' on' : ''}`, type: 'button', title: 'Artifact', onclick: () => (S.panel?.tab === 'artifact' ? hidePanel() : showArtifact()) }, icon('artifact'), h('span', { class: 'btn-label' }, 'Artifact'), arts > 1 ? h('span', { class: 'om-sidebar__count' }, String(arts)) : null) : null,
    h('button', { class: `om-btn om-btn--toolbar wide${S.panel?.tab === 'changes' ? ' on' : ''}`, type: 'button', title: '檔案變更', onclick: () => (S.panel?.tab === 'changes' ? hidePanel() : showChanges()) }, icon('diff'), h('span', { class: 'btn-label' }, '變更')),
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '更多', 'aria-label': '更多', onclick: (e) => sessionMenu(e.currentTarget) }, icon('dots')),
  );
}

function sessionMenu(anchor) {
  const s = S.cur?.summary;
  if (!s) return;
  openMenu(
    anchor,
    [
      { label: '重新命名…', onSelect: renameSession },
      { label: '複製成新對話', hint: '/fork', onSelect: () => sessionCommand('fork', '') },
      { label: '壓縮對話', hint: '/compact', onSelect: () => sessionCommand('compact', '') },
      { label: '複製資料夾路徑', onSelect: () => copyText(s.cwd || '').then(() => toast('已複製')) },
      { separator: true },
      { label: '刪除對話…', destructive: true, onSelect: () => deleteRow({ key: `${s.machineId}:${s.kimiSessionId}`, title: s.title }, s.machineId, s.kimiSessionId) },
    ],
    { align: 'end', width: 220 },
  );
}

async function renameSession() {
  const s = S.cur?.summary;
  const title = await promptDialog({ title: '要把對話改成什麼名稱？', value: s.title, action: '重新命名' });
  if (title?.trim()) sessionCommand('title', title.trim());
}

async function sendMessage({ text, images, steer }, from) {
  const s = S.cur?.summary;
  if (!s) return;
  try {
    await post(`/sessions/${s.id}/messages`, { text, images, from, steer: Boolean(steer) });
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
  const meta = s.meta || {};
  switch (name) {
    case 'model':
    case 'effort':
    case 'permission':
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
      return toast('已複製 Kimi 的回覆');
    }
    case 'init':
      return sendMessage({ text: INIT_PROMPT, images: [] });
    case 'usage':
      return accountDialog(s.machineId);
    case 'status': {
      const model = (meta.models || []).find((x) => x.id === meta.model);
      const ctx = meta.context;
      return accountDialog(s.machineId, [
        ['模型', model?.name || meta.model || 'Kimi 的預設模型'],
        meta.effort ? ['思考強度', EFFORT_LABELS[meta.effort] || meta.effort] : null,
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

// --------------------------------------------------------------- panel

// Drag the panel's left edge to share the width with the conversation.
const $grip = h('div', { class: 'panel-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖曳調整寬度', tabindex: '0', title: '拖曳調整寬度，按兩下還原' });
function panelWidth(w) {
  const side = $app.classList.contains('no-sidebar') ? 0 : $sidebar.offsetWidth;
  const max = window.innerWidth - side - 360;
  if (w == null) {
    $panel.style.removeProperty('--panel-w');
    try {
      localStorage.removeItem('hubPanelW');
    } catch {}
    return;
  }
  w = Math.round(Math.max(320, Math.min(w, max)));
  // On the panel itself: set on .app it would restyle the whole page.
  $panel.style.setProperty('--panel-w', `${w}px`);
  try {
    localStorage.setItem('hubPanelW', String(w));
  } catch {}
}
try {
  const w = Number(localStorage.getItem('hubPanelW'));
  if (w) $panel.style.setProperty('--panel-w', `${w}px`);
} catch {}
$grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $grip.setPointerCapture(e.pointerId);
  $app.classList.add('resizing');
  let raf = 0;
  let x = e.clientX;
  const move = (ev) => {
    x = ev.clientX;
    raf ||= requestAnimationFrame(() => ((raf = 0), panelWidth(window.innerWidth - x)));
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
$grip.addEventListener('dblclick', () => panelWidth(null));
$grip.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  panelWidth($panel.offsetWidth + (e.key === 'ArrowLeft' ? 32 : -32));
});

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
      S.artifacts.length ? h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'artifact'), onclick: () => showArtifact() }, 'Artifact') : null,
      h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'changes'), onclick: showChanges }, '變更'),
      S.cur?.transcript?.agentIds.length ? h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'agents'), onclick: () => showAgents() }, '子代理') : null,
      S.cur?.summary?.meta?.todos?.length ? h('button', { class: 'om-seg__item', type: 'button', 'aria-pressed': String(tab === 'todos'), onclick: showTodos }, '待辦') : null,
    ),
    h('span', { class: 'om-toolbar__spacer' }),
    ...right,
    h('button', { class: 'om-btn om-btn--toolbar', type: 'button', title: '關閉', 'aria-label': '關閉面板', onclick: hidePanel }, icon('x')),
  );
}

// Artifact tab: the newest version of the chosen page, kept in sync while
// Kimi writes it.
function showArtifact(path, version) {
  if (!S.artifacts.length) return;
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
    h('button', { class: 'om-btn om-btn--toolbar wide-only', type: 'button', title: '放大', 'aria-label': '放大面板', onclick: () => panelWidth(window.innerWidth) }, icon('expand')),
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
  if (!all.length) return;
  const pick = id || agentPanel?.id || all.findLast((a) => a.running)?.id || all.at(-1).id;
  artifactView?.destroy();
  artifactView = null;
  closeAgentPanel();
  showPanel('agents');
  const steps = new Transcript({ cwd: S.cur.summary?.cwd, onRespond: respond, onImage: lightbox });
  agentPanel = { id: pick, transcript: steps, list: h('div', { class: 'agent-list' }), summary: h('div', { class: 'agent-report' }), ids: new Set([pick]), sig: '' };
  const evs = t.descendants(pick);
  for (const e of evs) agentPanel.ids.add(e.id);
  steps.load(evs.map((e) => ({ ...e, parent: e.parent === pick ? undefined : e.parent })));
  steps.setStatus(t.agentList().find((a) => a.id === pick)?.running ? 'running' : 'idle');
  fill($panel, $grip, h('div', { class: 'panel-agents' }, panelHead(), agentPanel.list, steps.el, agentPanel.summary));
  drawAgentList();
}

function drawAgentList() {
  if (!agentPanel || !S.cur) return;
  const all = S.cur.transcript.agentList();
  const sig = JSON.stringify([agentPanel.id, all]);
  if (sig === agentPanel.sig) return;
  agentPanel.sig = sig;
  const status = (a) => (a.running ? h('span', { class: 'spinner', 'aria-label': '執行中' }) : a.failed ? h('span', { class: 'om-badge om-badge--danger' }, '失敗') : a.stopped ? h('span', { class: 'om-badge' }, '已中斷') : h('span', { class: 'om-badge om-badge--success' }, '完成'));
  fill(
    agentPanel.list,
    ...[...all].reverse().map((a) =>
      h(
        'button',
        { class: `agent-item${a.id === agentPanel.id ? ' on' : ''}`, type: 'button', onclick: () => a.id !== agentPanel.id && showAgents(a.id) },
        icon('agents'),
        h('span', { class: 'agent-item-text' }, h('span', { class: 'agent-item-name' }, a.name ? `子代理 · ${a.name}` : '子代理', a.background ? h('span', { class: 'om-badge' }, '背景') : null), h('span', { class: 'agent-item-desc' }, a.running && a.activity ? `${a.description} · ${a.activity}` : a.description)),
        a.steps ? h('span', { class: 'agent-item-meta' }, `${a.steps} 步`) : null,
        status(a),
      ),
    ),
  );
  const cur = all.find((a) => a.id === agentPanel.id);
  agentPanel.transcript.setStatus(cur?.running ? 'running' : 'idle');
  fill(agentPanel.summary, cur?.summary ? [h('div', { class: 'agent-summary-label' }, '子代理回報'), renderMarkdown(cur.summary)] : null);
  agentPanel.summary.hidden = !cur?.summary;
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
  drawAgentList();
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
          : h('div', { class: 'panel-empty' }, 'Kimi 還沒有列待辦。'),
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
    fill(
      body,
      h('div', { class: 'changes-sum' }, `${files.length} 個檔案`, h('span', { class: 'plus' }, ` +${added}`), h('span', { class: 'minus' }, ` −${removed}`), r.branch ? h('span', { class: 'muted' }, ` · ${r.branch}`) : null),
      ...files.map((f) => {
        const d = h('details', { class: 'change', open: files.length <= 6 });
        d.append(
          h('summary', null, icon('chev', 'chev'), h('span', { class: 'change-path' }, f.path), f.status === 'added' ? h('span', { class: 'om-badge om-badge--success' }, '新增') : f.status === 'deleted' ? h('span', { class: 'om-badge om-badge--danger' }, '刪除') : null, h('span', { class: 'change-stat' }, h('span', { class: 'plus' }, `+${f.added}`), h('span', { class: 'minus' }, ` −${f.removed}`))),
          renderHunks(f.lines),
        );
        return d;
      }),
    );
  } catch (err) {
    fill(body, h('div', { class: 'panel-empty' }, err.message));
  }
}

// ------------------------------------------------------------- dialogs

let dialogClose = null;

function dialog(content, { wide = false, onClose } = {}) {
  dialogClose?.();
  const box = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'dialog-back', onclick: (e) => e.target === back && close() }, box);
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
async function accountDialog(machineId, rows = null) {
  const m = machineById(machineId);
  const body = h('div', { class: 'account' }, h('div', { class: 'dialog-title' }, rows ? '狀態' : '用量'), h('div', { class: 'muted' }, '讀取中…'));
  const d = dialog(body);
  let data = {};
  try {
    data = await get(`/machines/${machineId}/usage`);
  } catch (err) {
    data = { usage: { kind: 'error', message: err.message } };
  }
  const WINDOWS = { limit5h: '5 小時', limit7d: '7 天', monthTotal: '本月總額度', monthCode: '本月 Code 額度' };
  const until = (t) => {
    const ms = Date.parse(t) - Date.now();
    if (!(ms > 0)) return '';
    const hrs = ms / 3_600_000;
    return hrs < 1 ? `${Math.ceil(ms / 60_000)} 分鐘後重置` : hrs < 48 ? `${Math.round(hrs)} 小時後重置` : `${Math.round(hrs / 24)} 天後重置`;
  };
  const u = data.usage;
  const quota = u?.kind === 'ok' ? u.quota : null;
  const bars = Object.entries(quota?.usages || {})
    .filter(([, v]) => v && typeof v.usedRatio === 'number')
    .map(([k, v]) => {
      const pct = Math.round(Math.min(1, v.usedRatio) * 100);
      return h(
        'div',
        { class: 'quota' },
        h('div', { class: 'quota-head' }, h('span', null, WINDOWS[k] || k), h('span', { class: 'muted' }, `已用 ${pct}%${v.resetAt ? ` · ${until(v.resetAt)}` : ''}`)),
        h('div', { class: `quota-bar${pct >= 90 ? ' danger' : pct >= 75 ? ' warning' : ''}` }, h('span', { style: { width: `${pct}%` } })),
      );
    });
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
    info.length ? h('dl', { class: 'kv' }, info.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => d.close() }, '好')),
  );
}

async function openSettings() {
  const m = homeMachine();
  if (m) await loadMachineModels(m);
  const models = (m && machineModels.get(m.id)?.models) || [];
  const d0 = defaults();
  const form = h('form', { class: 'settings' });
  const modelSel = h('select', { class: 'om-input', name: 'model' }, h('option', { value: '' }, 'Kimi 的預設模型'), ...models.map((x) => h('option', { value: x.id, selected: x.id === d0.model }, x.name || x.id)));
  if (d0.model && !models.some((x) => x.id === d0.model)) modelSel.append(h('option', { value: d0.model, selected: true }, d0.model));
  const effortSel = h('select', { class: 'om-input', name: 'effort' });
  const fillEfforts = () => {
    const mod = models.find((x) => x.id === modelSel.value);
    const list = mod?.efforts || [];
    const cur = effortSel.value || d0.effort;
    fill(effortSel, h('option', { value: '' }, '模型預設'), ...list.map((e) => h('option', { value: e, selected: e === cur }, `${EFFORT_LABELS[e] || e}${e === mod.defaultEffort ? '（模型預設）' : ''}`)));
    effortSel.disabled = list.length < 2;
  };
  modelSel.addEventListener('change', fillEfforts);
  fillEfforts();
  const permSel = h('select', { class: 'om-input', name: 'permission' }, ...Object.entries(PERMISSION_LABELS).map(([k, v]) => h('option', { value: k, selected: k === (d0.permission || 'manual') }, v)));
  const plan = h('input', { class: 'om-switch', type: 'checkbox', checked: Boolean(d0.planMode) });
  const field = (label, control, help) => h('label', { class: 'om-field' }, h('span', { class: 'om-field__label' }, label), control, help ? h('span', { class: 'om-field__help' }, help) : null);
  const save = async (e) => {
    e.preventDefault();
    try {
      S.config.settings = await put('/settings', { defaults: { model: modelSel.value, effort: effortSel.disabled ? '' : effortSel.value, permission: permSel.value, planMode: plan.checked } });
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
    h('div', { class: 'dialog-subtitle first' }, '新對話的預設'),
    h('p', { class: 'dialog-text settings-lead' }, '從中控台開新對話、或第一次在中控台打開舊對話時，會套用這些設定。之後在對話裡改的，會保留在那個對話。'),
    field('模型', modelSel, models.length ? (m && S.machines.length > 1 ? `「${m.name}」上可用的模型` : null) : '連上一台有 Kimi 的電腦後，就能選擇模型'),
    field('思考強度', effortSel),
    field('權限', permSel, '每次詢問：每個指令與修改都先問你 · 需要時詢問：只有風險高的才問 · 全部自動：不會打斷你'),
    h('label', { class: 'settings-switch' }, plan, h('span', null, h('span', { class: 'om-field__label' }, '計畫模式'), h('span', { class: 'om-field__help' }, '先規劃，你同意後才動手'))),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: 'om-btn om-btn--primary', type: 'submit' }, '儲存')),
  );
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
  const os = d.os || (/Win/.test(navigator.platform) ? 'win' : 'unix');
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
              { class: 'om-group__row' },
              icon('computer'),
              h(
                'div',
                { class: 'om-group__text' },
                h('div', { class: 'om-group__label' }, m.name),
                h('div', { class: 'om-group__hint' }, [m.platform, m.kimi?.version ? `Kimi Code ${m.kimi.version}` : null, m.online ? `${(m.sessions || []).length} 個對話` : `上次連線：${relTime(m.lastSeen || 0)}`].filter(Boolean).join(' · ')),
              ),
              status(m),
              !m.online ? h('button', { class: 'om-btn om-btn--sm om-btn--destructive', type: 'button', onclick: () => removeMachine(m) }, '移除…') : null,
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

function browseFolders(m, pick) {
  const list = h('div', { class: 'dirs' });
  const crumb = h('div', { class: 'crumb' });
  let current = null;
  const choose = h('button', { class: 'om-btn om-btn--primary', type: 'button', onclick: () => (pick(current), d.close()) }, '選擇這個資料夾');
  const d = dialog(h('div', { class: 'browse' }, h('div', { class: 'dialog-title' }, `「${m.name}」上的資料夾`), crumb, list, h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => d.close() }, '取消'), choose)), { wide: true });
  const load = async (path) => {
    fill(list, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    try {
      const r = await get(`/fs/dirs?machine=${encodeURIComponent(m.id)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
      current = r.path;
      fill(crumb, icon('folder'), h('span', null, shortPath(r.path, m.home, 6)));
      fill(
        list,
        r.parent ? h('button', { class: 'dir up', type: 'button', onclick: () => load(r.parent) }, icon('back'), '上一層') : null,
        ...r.dirs.map((name) => h('button', { class: 'dir', type: 'button', ondblclick: () => (pick(`${r.path}/${name}`), d.close()), onclick: () => load(`${r.path.replace(/\/$/, '')}/${name}`) }, icon('folder'), name)),
        !r.dirs.length ? h('div', { class: 'panel-empty' }, '這裡沒有子資料夾。') : null,
      );
    } catch (err) {
      fill(list, h('div', { class: 'panel-empty' }, err.message));
    }
  };
  load(S.home.cwdByMachine?.[m.id] || '');
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
  S.sessions = new Map(list.filter((s) => s.kimiSessionId).map((s) => [s.id, s]));
  renderSidebar();
}

function upsertSession(s) {
  if (!s.kimiSessionId) return;
  const prev = S.sessions.get(s.id);
  S.sessions.set(s.id, s);
  renderSidebar();
  if (S.cur?.id === s.id) {
    const was = S.cur.summary?.status;
    S.cur.summary = s;
    if (was !== s.status) S.cur.transcript.setStatus(s.status, busy(s.status) && !busy(was) ? Date.now() : null);
    updateComposer();
    if (prev?.title !== s.title || prev?.cwd !== s.cwd) renderToolbar();
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
    case 'event':
    case 'patch':
    case 'delta':
    case 'reset': {
      const cur = S.cur;
      if (!cur || cur.id !== m.sid || cur.loading) return;
      if (m.t === 'reset' || m.seq !== cur.seq + 1) return resync();
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
    applyTheme(localStorage.getItem('hubTheme'));
  } catch {}
  try {
    S.config = await get('/config');
    resetHomeChoices();
  } catch (err) {
    if (err.status === 401) return showLogin();
    fill($view, h('div', { class: 'loading' }, `連不上中控台：${err.message}`));
    return;
  }
  await Promise.all([loadMachines(), loadSessions()]).catch(fail);
  connect(onMessage, (ok) => {
    const was = S.online;
    S.online = ok;
    drawFoot();
    if (ok && !was) Promise.all([loadMachines(), loadSessions()]).then(resync).catch(() => {});
  });
  route();
}

start();
