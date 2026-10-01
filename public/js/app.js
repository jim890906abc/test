// Agent Hub UI: sidebar of sessions, conversation view, compare grid,
// workspace panel and agent settings — all driven by one WebSocket stream.
import { h, fill, icon, initials, relTime, dayGroup, shortPath, linkify, fmtTokens } from './dom.js';
import { get, post, put, patch, del, connect } from './api.js';
import { Conversation, renderUnifiedDiff } from './render.js';

const PERM_LABELS = { ask: '每次詢問', auto_edits: '自動接受編輯', bypass: '全部自動允許' };
const TYPE_ORDER = ['acp', 'cli', 'openai', 'demo'];
const TYPE_TITLES = { acp: 'ACP agents（訂閱帳號登入）', cli: 'CLI agents', openai: 'API（API key）', demo: '示範' };

const S = {
  config: null,
  agents: [],
  sessions: new Map(),
  connected: false,
  search: '',
  drafts: new Map(),
  home: { mode: 'single', agentId: null, agentIds: new Set(), cwd: '', perm: 'ask' },
  panel: { open: false, tab: 'changes' },
  settings: null,
  view: null,
};
try {
  S.panel.open = localStorage.getItem('hubPanel') === '1';
  S.home.agentId = localStorage.getItem('hubAgent');
  S.home.perm = localStorage.getItem('hubPerm') || 'ask';
} catch {}

const $app = document.getElementById('app');
const agentById = (id) => S.agents.find((a) => a.id === id);
const agentColor = (id) => agentById(id)?.color || '#8b887e';
const agentName = (id) => agentById(id)?.name || id;

// ------------------------------------------------------------- toasts

function toast(text, { error = false, action, timeout = 4200 } = {}) {
  const t = h('div', { class: `toast ${error ? 'err' : ''}` }, h('span', null, text));
  if (action) t.append(h('button', { onclick: () => (action.run(), t.remove()) }, action.label));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), timeout);
}
const fail = (err) => toast(err.message || String(err), { error: true });

// -------------------------------------------------------------- menus

let openMenuEl = null;
function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
function openMenu(anchor, items, { align = 'left', above = false } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === 'sep') menu.append(h('div', { class: 'sep' }));
    else if (it.header) menu.append(h('div', { class: 'mh' }, it.header));
    else {
      const row = h(
        'button',
        { class: `mi ${it.disabled ? 'disabled' : ''}`, title: it.title || '' },
        it.color ? h('span', { class: 'status-dot', style: { '--c': it.color, marginTop: 0 } }) : it.icon ? icon(it.icon) : null,
        h('span', { class: 'grow' }, it.label, it.sub ? h('span', { class: 'sub' }, it.sub) : null),
        it.checked ? icon('check', 'check') : null,
      );
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.disabled && !it.allowDisabled) return;
        if (!it.keepOpen) closeMenu();
        it.run?.();
      };
      menu.append(row);
    }
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = above || r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenuEl = menu;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (openMenuEl === menu) e.stopPropagation();
    closeMenu();
    document.removeEventListener('keydown', onKey, true);
  };
  document.addEventListener('keydown', onKey, true);
}

// -------------------------------------------------------------- modal

function modal(content, { small = false, onClose } = {}) {
  const box = h('div', { class: `modal ${small ? 'small' : ''}` }, content);
  const ov = h('div', { class: 'overlay' }, box);
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  return { close, box };
}

// ------------------------------------------------------------- layout

const L = {};
function buildLayout() {
  L.sideList = h('div', { class: 'session-list' });
  L.agentsCount = h('span', { class: 'count' });
  L.themeBtn = h('button', { class: 'icon-btn', title: '切換深淺色', onclick: toggleTheme });
  const search = h('input', {
    type: 'search',
    placeholder: '搜尋 sessions',
    oninput: (e) => {
      S.search = e.target.value.trim().toLowerCase();
      renderSidebar();
    },
  });
  L.sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'logo' }, icon('logo')),
      'Agent Hub',
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn hide-mobile', title: '收合側欄', onclick: () => toggleSidebar() }, icon('sidebar')),
      h('button', { class: 'icon-btn only-mobile', title: '關閉', onclick: () => toggleSidebar(false) }, icon('x')),
    ),
    h('button', { class: 'new-btn', onclick: () => go('#/') }, icon('plus'), '新工作'),
    h('div', { class: 'side-search' }, icon('search'), search),
    L.sideList,
    h(
      'div',
      { class: 'side-foot' },
      h('button', { class: 'agents-btn', onclick: () => openSettings() }, icon('gear'), 'Agents 設定', L.agentsCount),
      L.themeBtn,
    ),
  );
  L.main = h('main', { class: 'main' });
  L.panel = h('aside', { class: 'panel hidden' });
  L.root = h('div', { class: 'layout' }, L.sidebar, L.main, L.panel);
  fill($app, L.root);
  updateThemeBtn();
}

function toggleSidebar(force) {
  if (innerWidth <= 760) {
    const open = force ?? !L.root.classList.contains('sidebar-open');
    L.root.classList.toggle('sidebar-open', open);
    L.scrim?.remove();
    if (open) {
      L.scrim = h('div', { class: 'scrim', onclick: () => toggleSidebar(false) });
      document.body.append(L.scrim);
    }
  } else {
    L.root.classList.toggle('sidebar-collapsed', force === undefined ? undefined : !force);
    const collapsed = L.root.classList.contains('sidebar-collapsed');
    for (const b of document.querySelectorAll('.sb-toggle')) b.style.display = collapsed ? '' : 'none';
  }
}

function sidebarButton() {
  return h(
    'button',
    {
      class: 'icon-btn sb-toggle',
      title: '側欄',
      onclick: () => toggleSidebar(innerWidth <= 760 ? true : undefined),
      style: innerWidth > 760 && !L.root.classList.contains('sidebar-collapsed') ? { display: 'none' } : null,
    },
    icon(innerWidth <= 760 ? 'menu' : 'sidebar'),
  );
}

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('hubTheme', next);
  } catch {}
  updateThemeBtn();
}
function updateThemeBtn() {
  fill(L.themeBtn, icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
}

// ------------------------------------------------------------ sidebar

let sideRaf = 0;
function renderSidebar() {
  if (sideRaf) return;
  sideRaf = requestAnimationFrame(() => {
    sideRaf = 0;
    drawSidebar();
  });
}

function statusClass(st) {
  return st === 'running' ? 'running' : st === 'awaiting_permission' ? 'awaiting' : st === 'error' ? 'error' : '';
}

function drawSidebar() {
  const all = [...S.sessions.values()];
  const ready = S.agents.filter((a) => a.enabled && a.available).length;
  L.agentsCount.textContent = `${ready} 可用`;
  const q = S.search;
  const match = (s) => !q || s.title.toLowerCase().includes(q) || agentName(s.agentId).toLowerCase().includes(q);

  // Top-level entries: plain sessions and compare groups; delegated child
  // sessions are nested under their parent.
  const entries = [];
  const groups = new Map();
  for (const s of all) {
    if (s.parentId && S.sessions.has(s.parentId)) continue;
    if (s.groupId) {
      if (!groups.has(s.groupId)) groups.set(s.groupId, []);
      groups.get(s.groupId).push(s);
    } else entries.push({ kind: 's', s, at: s.updatedAt });
  }
  for (const [gid, list] of groups) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    entries.push({ kind: 'g', gid, list, at: Math.max(...list.map((x) => x.updatedAt)) });
  }
  entries.sort((a, b) => b.at - a.at);

  const route = S.view || {};
  const frag = document.createDocumentFragment();
  let lastGroup = null;
  let shown = 0;
  const awaiting = all.filter((s) => s.status === 'awaiting_permission').length;
  document.title = awaiting ? `(${awaiting}) 等待確認 · Agent Hub` : 'Agent Hub';

  for (const e of entries) {
    if (e.kind === 's' ? !match(e.s) : !e.list.some(match)) continue;
    const label = dayGroup(e.at);
    if (label !== lastGroup) {
      frag.append(h('div', { class: 'group-label' }, label));
      lastGroup = label;
    }
    shown++;
    if (e.kind === 's') {
      frag.append(sessionItem(e.s, route.sid === e.s.id));
      for (const c of all.filter((x) => x.parentId === e.s.id).sort((a, b) => a.createdAt - b.createdAt)) {
        frag.append(sessionItem(c, route.sid === c.id, true));
      }
    } else {
      const st = e.list.find((s) => s.status === 'awaiting_permission')
        ? 'awaiting_permission'
        : e.list.find((s) => s.status === 'running')
          ? 'running'
          : 'idle';
      const busy = statusClass(st);
      frag.append(
        h(
          'a',
          { class: `s-item ${route.gid === e.gid ? 'active' : ''}`, href: `#/g/${e.gid}`, onclick: () => toggleSidebar(false) },
          busy
            ? h('span', { class: `status-dot ${busy}` })
            : h('span', { class: 'stack-dots' }, e.list.slice(0, 4).map((s) => h('span', { style: { '--c': agentColor(s.agentId) } }))),
          h(
            'div',
            { class: 's-main' },
            h('div', { class: 's-title' }, e.list[0].title),
            h('div', { class: 's-meta' }, `比較 · ${e.list.map((s) => agentName(s.agentId)).join(' / ')}`),
          ),
        ),
      );
    }
  }
  if (!shown) frag.append(h('div', { class: 'empty-side' }, q ? '沒有符合的 session' : '還沒有任何 session。\n從「新工作」開始吧。'));
  fill(L.sideList, frag);
}

function sessionItem(s, active, child = false) {
  const st = statusClass(s.status);
  const meta = h('div', { class: 's-meta' });
  if (s.status === 'awaiting_permission') meta.append(h('span', { class: 'waiting' }, '等待確認'), ` · ${agentName(s.agentId)}`);
  else if (s.status === 'error') meta.append(h('span', { class: 'err' }, '發生錯誤'), ` · ${agentName(s.agentId)}`);
  else meta.append(`${agentName(s.agentId)} · ${relTime(s.updatedAt)}`);
  return h(
    'a',
    { class: `s-item ${active ? 'active' : ''} ${child ? 'child' : ''}`, href: `#/s/${s.id}`, onclick: () => toggleSidebar(false) },
    h('span', { class: `status-dot ${st}`, style: { '--c': agentColor(s.agentId) } }),
    h('div', { class: 's-main' }, h('div', { class: 's-title' }, child ? `↳ ${s.title}` : s.title), meta),
  );
}

// ------------------------------------------------------------- router

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function teardownView() {
  S.view?.conv?.destroy();
  for (const c of S.view?.convs?.values() || []) c.destroy();
  S.view = null;
}

function route() {
  closeMenu();
  teardownView();
  const [, kind, id] = location.hash.match(/^#\/(s|g)\/([\w-]+)/) || [];
  if (kind === 's') showSession(id);
  else if (kind === 'g') showGroup(id);
  else showHome();
  renderSidebar();
}

// ----------------------------------------------------------- composer

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`;
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('只支援圖片'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('圖片太大（上限 8MB）'));
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ url, mimeType: file.type, data: url.slice(url.indexOf(',') + 1) });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// A composer box. `opts.pills()` returns the controls shown under the text,
// `opts.submit(text, images)` sends, `opts.busy()` toggles the stop button.
function createComposer(opts) {
  const ta = h('textarea', { rows: 1, placeholder: opts.placeholder || '' });
  const attachRow = h('div', { class: 'attach-row hidden' });
  const row = h('div', { class: 'row' });
  const pop = h('div', { class: 'slash-pop hidden' });
  const box = h('div', { class: 'composer' }, pop, attachRow, ta, row);
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  box.append(fileInput);
  let images = [];
  let slashSel = 0;
  let slashItems = [];

  const key = opts.draftKey;
  if (key && S.drafts.has(key)) ta.value = S.drafts.get(key);

  const drawAttach = () => {
    attachRow.classList.toggle('hidden', !images.length);
    fill(attachRow, 
      ...images.map((img, i) =>
        h('div', { class: 'att' }, h('img', { src: img.url }), h('button', { title: '移除', onclick: () => (images.splice(i, 1), drawAttach(), drawRow()) }, icon('x'))),
      ),
    );
  };
  const addFiles = async (files) => {
    for (const f of files) {
      try {
        images.push(await readImage(f));
      } catch (err) {
        fail(err);
      }
    }
    drawAttach();
    drawRow();
  };
  fileInput.onchange = () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  };

  const canSend = () => (ta.value.trim() || images.length) && !(opts.busy?.() && !opts.allowWhileBusy);
  let sendBtn;
  const drawRow = () => {
    const busy = opts.busy?.();
    const pills = opts.pills?.() || [];
    if (opts.images?.()) pills.unshift(h('button', { class: 'icon-btn', title: '附加圖片', onclick: () => fileInput.click() }, icon('image')));
    sendBtn = busy && opts.stop
      ? h('button', { class: 'send-btn stop', title: '停止 (Esc)', onclick: () => opts.stop() }, icon('stop'))
      : h('button', { class: 'send-btn', title: '送出 (Enter)', disabled: !canSend(), onclick: submit }, icon('up'));
    fill(row, ...pills, h('span', { class: 'spacer' }), ...(opts.extras?.() || []), sendBtn);
  };

  const submit = async () => {
    const text = ta.value;
    if (!canSend()) return;
    const imgs = images;
    ta.value = '';
    images = [];
    if (key) S.drafts.delete(key);
    autoGrow(ta);
    drawAttach();
    hideSlash();
    try {
      await opts.submit(text, imgs.map(({ mimeType, data }) => ({ mimeType, data })));
    } catch (err) {
      ta.value = text;
      images = imgs;
      drawAttach();
      fail(err);
    }
    drawRow();
  };

  const hideSlash = () => {
    pop.classList.add('hidden');
    slashItems = [];
  };
  const drawSlash = () => {
    const cmds = opts.commands?.() || [];
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m || !cmds.length) return hideSlash();
    slashItems = cmds.filter((c) => c.name.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 30);
    if (!slashItems.length) return hideSlash();
    slashSel = Math.min(slashSel, slashItems.length - 1);
    fill(pop, 
      ...slashItems.map((c, i) =>
        h('div', { class: `opt ${i === slashSel ? 'sel' : ''}`, onmousedown: (e) => (e.preventDefault(), pickSlash(i)) }, h('span', { class: 'n' }, `/${c.name}`), h('span', { class: 'd' }, c.description || '')),
      ),
    );
    pop.classList.remove('hidden');
  };
  const pickSlash = (i) => {
    const c = slashItems[i];
    if (!c) return;
    ta.value = `/${c.name} `;
    hideSlash();
    ta.focus();
    drawRow();
  };

  ta.addEventListener('input', () => {
    autoGrow(ta);
    if (key) S.drafts.set(key, ta.value);
    slashSel = 0;
    drawSlash();
    if (sendBtn && !sendBtn.classList.contains('stop')) sendBtn.disabled = !canSend();
  });
  ta.addEventListener('keydown', (e) => {
    if (slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
        return drawSlash();
      }
      if ((e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) || e.key === 'Tab') {
        e.preventDefault();
        return pickSlash(slashSel);
      }
      if (e.key === 'Escape') return hideSlash();
    }
    // Never send while an IME (Chinese/Japanese input) is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && opts.busy?.() && opts.stop) opts.stop();
  });
  ta.addEventListener('paste', (e) => {
    if (!opts.images?.()) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  box.addEventListener('dragover', (e) => opts.images?.() && e.preventDefault());
  box.addEventListener('drop', (e) => {
    if (!opts.images?.()) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  drawRow();
  requestAnimationFrame(() => autoGrow(ta));
  return { el: box, ta, refresh: drawRow, focus: () => ta.focus() };
}

function permPill(value, onChange) {
  const sel = h(
    'select',
    { onchange: (e) => onChange(e.target.value), title: '權限模式：agent 要執行指令或修改檔案時的處理方式' },
    Object.entries(PERM_LABELS).map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
  return h('label', { class: `pill ${value === 'bypass' ? 'warn' : ''}` }, icon('shield'), sel);
}

function contextRing(ctx) {
  if (!ctx?.size) return null;
  const pct = Math.min(1, ctx.used / ctx.size);
  const c = 2 * Math.PI * 8;
  const color = pct > 0.85 ? 'var(--danger)' : pct > 0.6 ? 'var(--warn)' : 'var(--text-3)';
  const wrap = h('span', { class: 'ctx', title: `Context 使用量：${fmtTokens(ctx.used)} / ${fmtTokens(ctx.size)} tokens` });
  wrap.innerHTML = `<span>${Math.max(1, Math.round(pct * 100))}%</span><svg class="ctx-ring" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="var(--border-strong)" stroke-width="2.5"/><circle cx="11" cy="11" r="8" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 11 11)" stroke-linecap="round"/></svg>`;
  return wrap;
}

// --------------------------------------------------------------- home

function agentAvailable(a) {
  return a && a.enabled && a.available;
}

function showHome() {
  const enabled = S.agents.filter((a) => a.enabled);
  if (!agentAvailable(agentById(S.home.agentId))) S.home.agentId = (enabled.find((a) => a.available) || enabled[0])?.id || null;
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了' : hour < 11 ? '早安' : hour < 14 ? '午安' : hour < 18 ? '午後好' : '晚安';

  const composer = createComposer({
    placeholder: '交代一個任務，例如：幫我看看這個專案的結構，並修正測試失敗的地方',
    draftKey: 'home',
    images: () => S.home.mode === 'single' && agentById(S.home.agentId)?.type === 'acp',
    pills: () => {
      const pills = [];
      if (S.home.mode === 'single') {
        const a = agentById(S.home.agentId);
        const pill = h('button', { class: 'pill' }, h('span', { class: 'dot', style: { '--c': a?.color } }), a ? a.name : '選擇 agent', icon('down'));
        pill.onclick = (e) => {
          e.stopPropagation();
          openMenu(pill, agentMenuItems((id) => {
            S.home.agentId = id;
            try {
              localStorage.setItem('hubAgent', id);
            } catch {}
            composer.refresh();
          }, S.home.agentId), { above: innerHeight - pill.getBoundingClientRect().bottom < 360 });
        };
        pills.push(pill);
      } else {
        const sel = [...S.home.agentIds].filter((id) => agentAvailable(agentById(id)));
        const pill = h(
          'button',
          { class: 'pill', dataset: { role: 'agents-pill' } },
          sel.length ? h('span', { class: 'stack-dots', style: { marginTop: 0 } }, sel.map((id) => h('span', { style: { '--c': agentColor(id), borderColor: 'var(--surface)' } }))) : null,
          sel.length ? `${sel.length} 個 agents` : '選擇要比較的 agents',
          icon('down'),
        );
        pill.onclick = (e) => {
          e.stopPropagation();
          const items = agentMenuItems((id) => {
            S.home.agentIds.has(id) ? S.home.agentIds.delete(id) : S.home.agentIds.add(id);
            composer.refresh();
            composer.el.querySelector('[data-role="agents-pill"]')?.click();
          }, null, S.home.agentIds);
          openMenu(pill, items.map((i) => (typeof i === 'object' ? { ...i, keepOpen: true } : i)));
        };
        pills.push(pill);
      }
      const seg = h(
        'span',
        { class: 'seg' },
        h('button', { class: S.home.mode === 'single' ? 'on' : '', onclick: () => ((S.home.mode = 'single'), composer.refresh()) }, '單一'),
        h('button', { class: S.home.mode === 'compare' ? 'on' : '', title: '同一個任務交給多個 agent 平行執行並排比較', onclick: () => ((S.home.mode = 'compare'), composer.refresh()) }, icon('columns'), '比較'),
      );
      const ws = h('button', { class: 'pill', title: S.home.cwd || '為這次工作建立一個新的空白資料夾' }, icon('folder'), S.home.cwd ? shortPath(S.home.cwd, S.config?.home) : '新工作區', icon('down'));
      ws.onclick = (e) => {
        e.stopPropagation();
        const recent = [...new Set([...S.sessions.values()].filter((s) => !s.branch).sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.cwd))]
          .filter((p) => p && !p.startsWith(S.config?.workspacesDir || '\0'))
          .slice(0, 6);
        openMenu(ws, [
          { label: '新的空白工作區', sub: '自動建立資料夾並初始化 git', icon: 'plus', checked: !S.home.cwd, run: () => ((S.home.cwd = ''), composer.refresh()) },
          { label: '選擇資料夾…', sub: '在既有專案中工作', icon: 'folder', run: () => pickFolder((p) => ((S.home.cwd = p), composer.refresh())) },
          ...(recent.length ? ['sep', { header: '最近使用' }, ...recent.map((p) => ({ label: shortPath(p, S.config?.home), sub: p, checked: S.home.cwd === p, run: () => ((S.home.cwd = p), composer.refresh()) }))] : []),
        ], { above: innerHeight - ws.getBoundingClientRect().bottom < 320 });
      };
      pills.push(seg, ws, permPill(S.home.perm, (v) => {
        S.home.perm = v;
        try {
          localStorage.setItem('hubPerm', v);
        } catch {}
        composer.refresh();
      }));
      return pills;
    },
    submit: async (text, images) => {
      if (S.home.mode === 'compare') {
        const ids = [...S.home.agentIds].filter((id) => agentAvailable(agentById(id)));
        if (ids.length < 1) throw new Error('請先選擇至少一個可用的 agent');
        const r = await post('/compare', { agentIds: ids, prompt: text, cwd: S.home.cwd || undefined, permissionMode: S.home.perm });
        for (const s of r.sessions) S.sessions.set(s.id, s);
        go(`#/g/${r.groupId}`);
      } else {
        const a = agentById(S.home.agentId);
        if (!a) throw new Error('請先選擇 agent');
        if (!a.available) throw new Error(`${a.name} 目前無法使用：${a.reason}`);
        const s = await post('/sessions', { agentId: a.id, prompt: text, images, cwd: S.home.cwd || undefined, permissionMode: S.home.perm });
        S.sessions.set(s.id, s);
        go(`#/s/${s.id}`);
      }
    },
  });

  const cards = h('div', { class: 'cards' });
  for (const a of enabled.sort((x, y) => Number(y.available) - Number(x.available))) {
    cards.append(
      h(
        'button',
        {
          class: 'acard',
          onclick: () => {
            if (!a.available) return openSettings(a.id);
            S.home.mode = 'single';
            S.home.agentId = a.id;
            composer.refresh();
            composer.focus();
          },
        },
        h('div', { class: 'top' }, h('span', { class: 'avatar', style: { '--c': a.color } }, initials(a.name)), a.name, h('span', { class: 'tag', style: { marginLeft: 'auto' } }, a.type.toUpperCase())),
        h('div', { class: `st ${a.available ? 'ok' : ''}` }, a.available ? '● 可以使用' : a.reason),
      ),
    );
  }

  fill(L.main, 
    h('header', { class: 'topbar bare' }, sidebarButton(), h('span', { class: 'spacer' })),
    h(
      'div',
      { class: 'home' },
      h('h1', { class: 'greet' }, icon('logo'), `${greet}，今天要交給哪個 agent？`),
      h('p', { class: 'sub' }, '一個介面操控各家 coding agent —— Kimi Code、Gemini CLI、Qwen Code、OpenCode…'),
      h('div', { class: 'composer-wrap' }, composer.el),
      h('div', { class: 'agent-cards' }, h('h3', null, '已啟用的 agents', h('button', { class: 'btn sm ghost', onclick: () => openSettings() }, icon('gear'), '管理')), cards),
    ),
  );
  hidePanel();
  S.view = { kind: 'home', composer };
  composer.focus();
}

function agentMenuItems(onPick, current, multi) {
  const items = [];
  for (const type of TYPE_ORDER) {
    const list = S.agents.filter((a) => a.enabled && a.type === type);
    if (!list.length) continue;
    if (items.length) items.push('sep');
    items.push({ header: TYPE_TITLES[type] });
    for (const a of list) {
      items.push({
        label: a.name,
        sub: a.available ? a.model || a.command || a.typeLabel : a.reason,
        color: a.color,
        disabled: !a.available,
        checked: multi ? multi.has(a.id) : a.id === current,
        run: () => (a.available ? onPick(a.id) : openSettings(a.id)),
        allowDisabled: true,
      });
    }
  }
  items.push('sep', { label: '管理 agents…', icon: 'gear', run: () => openSettings() });
  return items;
}

// ------------------------------------------------------------ session

// Live messages for a session that arrive while its snapshot is loading are
// buffered and merged by sequence number.
const pending = new Map();

async function loadInto(conv) {
  pending.set(conv.sid, []);
  try {
    const snap = await get(`/sessions/${conv.sid}`);
    conv.seq = snap.seq;
    conv.setEvents(snap.events);
    for (const msg of pending.get(conv.sid) || []) applyToConv(conv, msg);
    return snap;
  } finally {
    pending.delete(conv.sid);
  }
}

function applyToConv(conv, msg) {
  if (msg.seq != null && conv.seq != null && msg.seq <= conv.seq) return;
  if (msg.seq != null) conv.seq = msg.seq;
  if (msg.t === 'event') conv.append(msg.ev);
  else if (msg.t === 'delta') conv.delta(msg.id, msg.field, msg.text);
  else if (msg.t === 'patch') conv.patch(msg.id, msg.fields);
}

function convCtx(sid) {
  const sAgent = () => agentById(S.sessions.get(sid)?.agentId);
  return {
    agentName: () => sAgent()?.name || 'Agent',
    relPath: (p) => {
      const cwd = S.sessions.get(sid)?.cwd;
      return cwd && p?.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
    },
    onPermission: (eventId, optionId) => post(`/sessions/${sid}/permissions/${eventId}`, { optionId }).catch(fail),
    canLogin: () => sAgent()?.type === 'acp',
    openLogin: () => sAgent() && openSettings(sAgent().id, { login: true }),
  };
}

async function showSession(sid) {
  const conv = new Conversation({ sid, ctx: convCtx(sid) });
  const scroller = h('div', { class: 'scroller' }, conv.el);
  const top = h('header', { class: 'topbar' });
  const composer = createComposer({
    placeholder: '回覆…（Enter 送出，Shift+Enter 換行，/ 叫出指令）',
    draftKey: sid,
    allowWhileBusy: false,
    busy: () => ['running', 'awaiting_permission'].includes(S.sessions.get(sid)?.status),
    stop: () => post(`/sessions/${sid}/interrupt`).catch(fail),
    images: () => {
      const s = S.sessions.get(sid);
      return agentById(s?.agentId)?.type === 'acp' && s?.meta?.imageInput !== false;
    },
    commands: () => S.sessions.get(sid)?.meta?.commands || [],
    pills: () => sessionPills(sid),
    extras: () => [contextRing(S.sessions.get(sid)?.meta?.context)],
    submit: (text, images) => post(`/sessions/${sid}/messages`, { text, images }),
  });
  fill(L.main, top, scroller, h('div', { class: 'composer-wrap' }, composer.el));
  S.view = { kind: 'session', sid, conv, composer, top };
  drawTopbar();
  if (S.panel.open) showPanel();
  else hidePanel();
  try {
    const snap = await loadInto(conv);
    S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...stripEvents(snap) });
    conv.setStatus(S.sessions.get(sid));
    drawTopbar();
    composer.refresh();
    renderSidebar();
  } catch (err) {
    if (err.status === 404) {
      toast('找不到這個 session');
      return go('#/');
    }
    fail(err);
  }
  if (innerWidth > 760) composer.focus();
}

function stripEvents(snap) {
  const { events, ...rest } = snap;
  return rest;
}

function sessionPills(sid) {
  const s = S.sessions.get(sid);
  if (!s) return [];
  const pills = [permPill(s.permissionMode, (v) => patch(`/sessions/${sid}`, { permissionMode: v }).catch(fail))];
  const meta = s.meta || {};
  const cfg = (body) => post(`/sessions/${sid}/config`, body).catch(fail);
  if (meta.modes?.availableModes?.length) {
    pills.push(
      h(
        'label',
        { class: 'pill', title: 'Agent 的模式' },
        icon('bolt'),
        h('select', { onchange: (e) => cfg({ modeId: e.target.value }) }, meta.modes.availableModes.map((m) => h('option', { value: m.id, selected: m.id === meta.modes.currentModeId }, m.name))),
      ),
    );
  }
  for (const o of meta.configOptions || []) {
    if (o.id === 'mode' && meta.modes?.availableModes?.length) continue;
    if (o.type === 'boolean') {
      pills.push(
        h('label', { class: 'pill', title: o.description || o.name }, h('input', { type: 'checkbox', checked: !!o.currentValue, onchange: (e) => cfg({ configId: o.id, value: e.target.checked }) }), o.name),
      );
    } else if (o.type === 'select' || Array.isArray(o.options)) {
      const flat = (o.options || []).flatMap((x) => (x.options ? x.options.map((y) => ({ ...y, group: x.name })) : [x]));
      pills.push(
        h(
          'label',
          { class: 'pill', title: o.description || o.name },
          h('span', { class: 'muted' }, o.name),
          h('select', { onchange: (e) => cfg({ configId: o.id, value: e.target.value }) }, flat.map((x) => h('option', { value: x.value, selected: x.value === o.currentValue }, x.name))),
        ),
      );
    }
  }
  return pills;
}

function drawTopbar() {
  const v = S.view;
  if (v?.kind !== 'session' || v.top.querySelector('.title-edit')) return;
  const s = S.sessions.get(v.sid);
  if (!s) return;
  const a = agentById(s.agentId);
  const info = s.meta?.agentInfo;
  const title = h('div', { class: 'title', title: '點擊重新命名' }, s.title);
  title.onclick = () => renameInline(title, s);
  const handoffBtn = h('button', { class: 'btn sm ghost hide-mobile', title: '把這個工作交給另一個 agent 接手' }, icon('swap'), '交接');
  handoffBtn.onclick = (e) => {
    e.stopPropagation();
    openMenu(handoffBtn, [
      { header: '交給哪個 agent 接手？（同一個工作區）' },
      ...S.agents
        .filter((x) => x.enabled && x.id !== s.agentId)
        .map((x) => ({
          label: x.name,
          sub: x.available ? '帶著目前的對話紀錄接手' : x.reason,
          color: x.color,
          disabled: !x.available,
          run: async () => {
            const text = v.composer.ta.value;
            const ns = await post(`/sessions/${s.id}/handoff`, { agentId: x.id, text }).catch(fail);
            if (ns) {
              v.composer.ta.value = '';
              S.sessions.set(ns.id, ns);
              go(`#/s/${ns.id}`);
            }
          },
        })),
    ], { align: 'right' });
  };
  const more = h('button', { class: 'icon-btn', title: '更多' }, icon('dots'));
  more.onclick = (e) => {
    e.stopPropagation();
    openMenu(more, [
      { label: '重新命名', icon: 'pencil', run: () => renameInline(title, s) },
      { label: '複製工作區路徑', icon: 'copy', run: () => (navigator.clipboard?.writeText(s.cwd), toast('已複製路徑')) },
      ...(s.parentId ? [{ label: '回到上層 session', icon: 'back', run: () => go(`#/s/${s.parentId}`) }] : []),
      ...(s.groupId ? [{ label: '回到比較檢視', icon: 'columns', run: () => go(`#/g/${s.groupId}`) }] : []),
      'sep',
      {
        label: '刪除 session',
        icon: 'trash',
        run: async () => {
          if (!confirm('確定要刪除這個 session？（工作區資料夾不會被刪除）')) return;
          await del(`/sessions/${s.id}`).catch(fail);
        },
      },
    ], { align: 'right' });
  };
  fill(v.top, 
    sidebarButton(),
    title,
    h('span', { class: 'chip', title: s.meta?.protocol || '' }, h('span', { class: 'dot', style: { '--c': a?.color } }), info?.name && info.name !== a?.name ? `${a?.name ?? ''} · ${info.name}${info.version ? ` ${info.version}` : ''}` : `${a?.name ?? s.agentId}${info?.version ? ` ${info.version}` : ''}`),
    h('span', { class: 'chip path hide-mobile', title: s.cwd }, s.branch ? icon('branch') : icon('folder'), s.branch || shortPath(s.cwd, S.config?.home)),
    h('span', { class: 'spacer' }),
    handoffBtn,
    h('button', { class: `icon-btn ${S.panel.open ? 'active' : ''}`, title: '工作區（變更 / 檔案）', onclick: () => togglePanel() }, icon('panel')),
    more,
  );
}

function renameInline(titleEl, s) {
  const input = h('input', { class: 'title-edit', value: s.title });
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== s.title) await patch(`/sessions/${s.id}`, { title: input.value.trim() }).catch(fail);
    drawTopbar();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

// ------------------------------------------------------------- groups

async function showGroup(gid) {
  const top = h('header', { class: 'topbar' });
  const grid = h('div', { class: 'grid-view' });
  const convs = new Map();
  const heads = new Map();
  const composer = createComposer({
    placeholder: '傳送後續指示給所有 agent…',
    busy: () => [...convs.keys()].some((id) => ['running', 'awaiting_permission'].includes(S.sessions.get(id)?.status)),
    allowWhileBusy: true,
    stop: () => Promise.all([...convs.keys()].map((id) => post(`/sessions/${id}/interrupt`))).catch(fail),
    submit: async (text) => {
      const r = await post(`/groups/${gid}/messages`, { text });
      if (r.sent < convs.size) toast(`已傳送給 ${r.sent} 個 agent（其餘仍在執行中）`);
    },
  });
  fill(L.main, top, grid, h('div', { class: 'composer-wrap' }, composer.el));
  hidePanel();
  S.view = { kind: 'group', gid, convs, heads, composer, top };

  const sessions = [...S.sessions.values()].filter((s) => s.groupId === gid).sort((a, b) => a.createdAt - b.createdAt);
  if (!sessions.length) {
    toast('找不到這個比較群組');
    return go('#/');
  }
  top.append(sidebarButton(), h('div', { class: 'title', style: { cursor: 'default' } }, `比較：${sessions[0].title}`), h('span', { class: 'spacer' }), h('span', { class: 'chip hide-mobile' }, icon('columns'), `${sessions.length} 個 agents`));
  for (const s of sessions) {
    const conv = new Conversation({ sid: s.id, ctx: convCtx(s.id), compact: true });
    const head = h('div', { class: 'gcol-head' });
    heads.set(s.id, head);
    convs.set(s.id, conv);
    grid.append(h('div', { class: 'gcol' }, head, h('div', { class: 'scroller' }, conv.el)));
    drawGroupHead(s.id);
    loadInto(conv)
      .then(() => conv.setStatus(S.sessions.get(s.id)))
      .catch(fail);
  }
}

function drawGroupHead(sid) {
  const head = S.view?.heads?.get(sid);
  const s = S.sessions.get(sid);
  if (!head || !s) return;
  const st = statusClass(s.status);
  fill(head, 
    h('span', { class: `status-dot ${st}`, style: { '--c': agentColor(s.agentId), marginTop: 0 } }),
    agentName(s.agentId),
    s.branch ? h('span', { class: 'chip path', title: s.cwd }, icon('branch'), s.branch.split('/').pop()) : null,
    h('span', { class: 'spacer' }),
    h('a', { class: 'btn sm ghost', href: `#/s/${sid}`, title: '單獨開啟' }, icon('ext')),
  );
}

// -------------------------------------------------------------- panel

function hidePanel() {
  L.panel.classList.add('hidden');
}
function togglePanel(force) {
  S.panel.open = force ?? !S.panel.open;
  try {
    localStorage.setItem('hubPanel', S.panel.open ? '1' : '0');
  } catch {}
  if (S.panel.open) showPanel();
  else hidePanel();
  drawTopbar();
}

function showPanel() {
  const sid = S.view?.sid;
  if (!sid) return hidePanel();
  L.panel.classList.remove('hidden');
  const body = h('div', { class: 'panel-body' });
  const badge = h('span', { class: 'badge hidden' });
  const tabs = h(
    'div',
    { class: 'tabs' },
    h('button', { class: S.panel.tab === 'changes' ? 'on' : '', onclick: () => ((S.panel.tab = 'changes'), showPanel()) }, '變更', badge),
    h('button', { class: S.panel.tab === 'files' ? 'on' : '', onclick: () => ((S.panel.tab = 'files'), showPanel()) }, '檔案'),
  );
  fill(L.panel, 
    h(
      'div',
      { class: 'panel-head' },
      tabs,
      h('span', { class: 'spacer', style: { flex: 1 } }),
      h('button', { class: 'icon-btn', title: '重新整理', onclick: () => showPanel() }, icon('refresh')),
      h('button', { class: 'icon-btn', title: '關閉', onclick: () => togglePanel(false) }, icon('x')),
    ),
    body,
  );
  S.panelState = { sid, body, badge };
  if (S.panel.tab === 'changes') loadChanges(sid, body, badge);
  else loadFiles(sid, body);
}

let panelTimer = 0;
function refreshPanelSoon(sid) {
  if (!S.panel.open || S.view?.sid !== sid || S.panel.tab !== 'changes') return;
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => S.view?.sid === sid && showPanel(), 700);
}

async function loadChanges(sid, body, badge) {
  fill(body, h('div', { class: 'panel-empty' }, '載入中…'));
  try {
    const ch = await get(`/sessions/${sid}/changes`);
    if (!ch.git) return fill(body, h('div', { class: 'panel-empty' }, '這個工作區不是 git repo，無法顯示變更。\n可以切到「檔案」分頁瀏覽。'));
    badge.textContent = ch.files.length;
    badge.classList.toggle('hidden', !ch.files.length);
    if (!ch.files.length) return fill(body, h('div', { class: 'panel-empty' }, '目前沒有任何變更'));
    // Split the combined diff per file so each row can expand on its own.
    const chunks = new Map();
    let cur = null;
    for (const line of ch.diff.split('\n')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        cur = m[2];
        chunks.set(cur, []);
      }
      if (cur) chunks.get(cur).push(line);
    }
    const tot = ch.files.reduce((n, f) => [n[0] + f.added, n[1] + f.removed], [0, 0]);
    fill(body, 
      h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 8px 8px' } }, `${ch.files.length} 個檔案 · `, h('span', { class: 'add', style: { color: 'var(--diff-add-text)' } }, `+${tot[0]}`), ' ', h('span', { style: { color: 'var(--diff-del-text)' } }, `-${tot[1]}`)),
      ...ch.files.map((f) => {
        const holder = h('div');
        const rowEl = h(
          'div',
          { class: 'change-row', title: f.path },
          h('span', { class: `st-badge ${f.status}` }, f.status[0].toUpperCase()),
          h('span', { class: 'p' }, f.path),
          h('span', { class: 'add' }, `+${f.added}`),
          h('span', { class: 'del' }, `-${f.removed}`),
        );
        rowEl.onclick = () => {
          if (holder.firstChild) fill(holder);
          else fill(holder, renderUnifiedDiff((chunks.get(f.path) || []).join('\n')));
        };
        if (ch.files.length <= 3) holder.append(renderUnifiedDiff((chunks.get(f.path) || []).join('\n')));
        return h('div', { style: { marginBottom: '6px' } }, rowEl, holder);
      }),
    );
  } catch (err) {
    fill(body, h('div', { class: 'panel-empty' }, err.message));
  }
}

async function loadFiles(sid, body) {
  const tree = h('div');
  fill(body, tree);
  const renderDir = async (container, rel, depth) => {
    let items;
    try {
      items = await get(`/sessions/${sid}/files?path=${encodeURIComponent(rel)}`);
    } catch (err) {
      return fill(container, h('div', { class: 'panel-empty' }, err.message));
    }
    if (!items.length && depth === 0) return fill(container, h('div', { class: 'panel-empty' }, '工作區是空的'));
    fill(container, 
      ...items.map((it) => {
        const kids = h('div');
        const rowEl = h('div', { class: 'file-row', style: { paddingLeft: `${8 + depth * 14}px` } }, icon(it.dir ? 'folder' : 'file'), h('span', { class: 'name' }, it.name));
        rowEl.onclick = () => {
          if (!it.dir) return openFile(sid, body, it.path, () => loadFiles(sid, body));
          if (kids.firstChild) fill(kids);
          else renderDir(kids, it.path, depth + 1);
        };
        return h('div', null, rowEl, kids);
      }),
    );
  };
  renderDir(tree, '.', 0);
}

async function openFile(sid, body, path, back) {
  fill(body, h('div', { class: 'panel-empty' }, '載入中…'));
  try {
    const f = await get(`/sessions/${sid}/file?path=${encodeURIComponent(path)}`);
    const head = h('div', { class: 'viewer-head' }, h('button', { class: 'icon-btn', onclick: back, title: '返回' }, icon('back')), h('span', { title: path }, path));
    if (f.tooLarge || f.binary) return fill(body, head, h('div', { class: 'panel-empty' }, f.binary ? '二進位檔案，無法預覽' : '檔案太大，無法預覽'));
    const lines = f.content.split('\n');
    fill(body, head, h('div', { class: 'code-view' }, h('div', { class: 'ln' }, lines.map((_, i) => i + 1).join('\n')), h('div', { class: 'src' }, f.content)));
  } catch (err) {
    fill(body, h('div', { class: 'panel-empty' }, err.message));
  }
}

// ---------------------------------------------------- folder picker

function pickFolder(onPick) {
  const list = h('div', { class: 'dir-list' });
  const pathInput = h('input', { type: 'text', class: 'mono', style: { width: '100%' } });
  const gitNote = h('span', { class: 'muted', style: { fontSize: '12.5px' } });
  let cur = null;
  const load = async (p) => {
    try {
      const r = await get(`/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      cur = r.path;
      pathInput.value = r.path;
      gitNote.textContent = r.git ? '✓ git repo（比較模式會為每個 agent 建立獨立的 worktree）' : '';
      fill(list, 
        ...(r.parent ? [h('div', { class: 'file-row', onclick: () => load(r.parent) }, icon('back'), '..')] : []),
        ...r.dirs.map((d) => h('div', { class: 'file-row', onclick: () => load(`${r.path}/${d}`) }, icon('folder'), h('span', { class: 'name' }, d))),
      );
    } catch (err) {
      fail(err);
    }
  };
  pathInput.onkeydown = (e) => e.key === 'Enter' && !e.isComposing && load(pathInput.value);
  const m = modal(
    [
      h('div', { class: 'modal-head' }, h('h2', null, '選擇工作資料夾'), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: () => m.close() }, icon('x'))),
      h(
        'div',
        { style: { padding: '14px 16px' } },
        h('div', { class: 'field' }, pathInput),
        list,
        gitNote,
        h('div', { class: 'form-actions', style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => m.close() }, '取消'), h('button', { class: 'btn primary', onclick: () => (onPick(cur), m.close()) }, '使用這個資料夾')),
      ),
    ],
    { small: true },
  );
  load(S.home.cwd || '');
}

// ------------------------------------------------------------ settings

function openSettings(selectId, { login = false } = {}) {
  const listEl = h('div', { class: 'alist' });
  const formEl = h('div', { class: 'aform' });
  const st = { selected: selectId || S.agents.find((a) => a.type === 'acp')?.id || S.agents[0]?.id, listEl, formEl, loginOut: null };
  const m = modal(
    [
      h('div', { class: 'modal-head' }, icon('gear'), h('h2', null, 'Agents 設定'), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: () => m.close() }, icon('x'))),
      h('div', { class: 'settings' }, listEl, formEl),
    ],
    { onClose: () => (S.settings = null) },
  );
  st.close = m.close;
  S.settings = st;
  drawSettings();
  if (login) startLogin(st.selected);
}

function drawSettings() {
  const st = S.settings;
  if (!st) return;
  const rows = [h('button', { class: 'btn sm', style: { width: '100%', justifyContent: 'center', marginBottom: '4px' }, onclick: openTemplates }, icon('plus'), '新增 agent')];
  for (const type of TYPE_ORDER) {
    const list = S.agents.filter((a) => a.type === type);
    if (!list.length) continue;
    rows.push(h('div', { class: 'grp' }, TYPE_TITLES[type]));
    for (const a of list) {
      rows.push(
        h(
          'div',
          { class: `arow ${a.id === st.selected ? 'on' : ''} ${a.enabled ? '' : 'off'}`, onclick: () => ((st.selected = a.id), (st.test = null), drawSettings()) },
          h('span', { class: 'avatar', style: { '--c': a.color } }, initials(a.name)),
          h('span', { class: 'nm' }, a.name),
          h('span', { class: `ok-dot ${a.enabled && a.available ? 'ok' : ''}`, title: a.available ? '可用' : a.reason }),
        ),
      );
    }
  }
  fill(st.listEl, ...rows);
  drawAgentForm();
}

function drawAgentForm() {
  const st = S.settings;
  const a = agentById(st.selected);
  if (!a) return fill(st.formEl, h('div', { class: 'panel-empty' }, '選擇左側的 agent'));
  const draft = { ...a };
  const field = (label, key, { type = 'text', help, placeholder, mono, textarea } = {}) => {
    const input = textarea
      ? h('textarea', { placeholder: placeholder || '', oninput: (e) => (draft[key] = e.target.value) }, draft[key] ?? '')
      : h('input', { type, value: draft[key] ?? '', placeholder: placeholder || '', class: mono ? 'mono' : '', oninput: (e) => (draft[key] = e.target.value) });
    return h('div', { class: 'field' }, h('label', null, label), input, help ? h('div', { class: 'help' }, help) : null);
  };
  const envText = Object.entries(a.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  draft.envText = envText;

  const parts = [
    h(
      'h3',
      null,
      h('span', { class: 'avatar', style: { '--c': a.color, width: '30px', height: '30px', borderRadius: '9px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '13px', background: a.color } }, initials(a.name)),
      a.name,
      h('span', { class: 'tag' }, a.typeLabel),
      h('span', { style: { flex: 1 } }),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: a.enabled, onchange: (e) => saveAgent(a.id, { enabled: e.target.checked }) }), '啟用'),
    ),
    a.description ? h('p', { class: 'desc' }, a.description) : null,
  ];
  if (!a.available) parts.push(h('div', { class: 'test-result bad', style: { marginTop: 0, marginBottom: '14px' } }, a.reason));

  if (a.type === 'acp') {
    parts.push(
      h(
        'div',
        { class: 'callout' },
        '這類 agent 透過 ',
        h('b', null, 'Agent Client Protocol (ACP)'),
        ' 連線：中控台啟動 agent 程序，即時串流它的回覆、思考、工具呼叫與權限請求。登入沿用 agent 自己的帳號（例如 Kimi 會員訂閱），不需要 API key。',
        a.install ? h('div', { style: { marginTop: '6px' } }, '安裝：', h('code', null, a.install)) : null,
        a.login ? h('div', { style: { marginTop: '4px' } }, '登入：', h('code', null, a.login), '（或按下方「登入」在網頁完成）') : null,
      ),
      h('div', { class: 'fields-2' }, field('名稱', 'name'), field('顏色', 'color', { type: 'color' })),
      h('div', { class: 'fields-2' }, field('啟動指令', 'command', { mono: true, help: '找不到時請填完整路徑（which kimi）' }), field('參數', 'args', { mono: true, help: '例如 Kimi Code：acp' })),
      field('登入指令', 'login', { mono: true, placeholder: 'kimi login', help: '「登入」按鈕會執行這個指令並把輸出顯示在下方' }),
      field('環境變數', 'envText', { textarea: true, placeholder: 'KEY=VALUE（每行一個）' }),
    );
  } else if (a.type === 'cli') {
    parts.push(
      h('div', { class: 'fields-2' }, field('名稱', 'name'), field('顏色', 'color', { type: 'color' })),
      h('div', { class: 'fields-2' }, field('指令', 'command', { mono: true }), field('參數', 'args', { mono: true, help: '{prompt} 會被替換成提示詞' })),
      h('div', { class: 'fields-2' }, field('模型（選填）', 'model', { mono: true }), h('div', { class: 'field' }, h('label', null, '輸出格式'), h('select', { onchange: (e) => (draft.cliKind = e.target.value) }, ['plain', 'aider'].map((k) => h('option', { value: k, selected: draft.cliKind === k }, k === 'plain' ? '一般（自動解析 JSON lines）' : 'Aider'))))),
      field('環境變數', 'envText', { textarea: true, placeholder: 'KEY=VALUE（每行一個）' }),
    );
  } else if (a.type === 'openai') {
    parts.push(
      h('div', { class: 'callout' }, '透過 OpenAI 相容 API 呼叫模型（需要 API key，按量計費）。中控台提供工具（執行指令、讀寫檔案、搜尋、委派其他 agent）讓模型在工作區內工作。'),
      h('div', { class: 'fields-2' }, field('名稱', 'name'), field('顏色', 'color', { type: 'color' })),
      field('Base URL', 'baseUrl', { mono: true, placeholder: 'https://api.example.com/v1' }),
      h('div', { class: 'fields-2' }, field('模型', 'model', { mono: true }), field('API key 環境變數', 'apiKeyEnv', { mono: true, help: a.apiKeyFromEnv ? '✓ 已偵測到此環境變數' : '未偵測到' })),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'API key（選填，會以明文存在本機 data/agents.json）'),
        h('input', { type: 'password', placeholder: a.hasApiKey ? '已設定（留空則不變更）' : '貼上 API key', oninput: (e) => (draft.apiKey = e.target.value) }),
      ),
      field('額外系統提示（選填）', 'systemPrompt', { textarea: true }),
    );
  } else {
    parts.push(h('div', { class: 'fields-2' }, field('名稱', 'name'), field('顏色', 'color', { type: 'color' })));
  }

  const actions = h(
    'div',
    { class: 'form-actions' },
    h(
      'button',
      {
        class: 'btn primary',
        onclick: () => {
          const body = {};
          for (const k of ['name', 'color', 'command', 'args', 'login', 'model', 'baseUrl', 'apiKeyEnv', 'systemPrompt', 'cliKind']) if (draft[k] !== a[k]) body[k] = draft[k];
          if (draft.apiKey) body.apiKey = draft.apiKey;
          if (draft.envText !== envText) {
            body.env = Object.fromEntries(
              draft.envText
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.includes('='))
                .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
            );
          }
          saveAgent(a.id, body, true);
        },
      },
      '儲存',
    ),
    h('button', { class: 'btn', onclick: () => testAgent(a.id) }, icon('bolt'), '測試連線'),
    a.type === 'acp' ? h('button', { class: 'btn', onclick: () => startLogin(a.id) }, icon('login'), '登入') : null,
    h('span', { style: { flex: 1 } }),
    !a.builtin ? h('button', { class: 'btn danger', onclick: () => confirm(`刪除 ${a.name}？`) && del(`/agents/${a.id}`).then(() => ((S.settings.selected = null), loadAgents())).catch(fail) }, icon('trash'), '刪除') : null,
  );
  parts.push(actions);
  if (st.test) parts.push(h('div', { class: `test-result ${st.test.ok ? 'ok' : 'bad'}` }, st.test.message));
  if (st.login && st.login.agentId === a.id) parts.push(loginTerminal(a));
  fill(st.formEl, ...parts.filter(Boolean));
}

async function saveAgent(id, body, notify) {
  try {
    await put(`/agents/${id}`, body);
    await loadAgents();
    if (notify) toast('已儲存');
  } catch (err) {
    fail(err);
  }
}

async function testAgent(id) {
  const st = S.settings;
  st.test = { ok: true, message: '測試中…（ACP agent 可能需要幾秒啟動）' };
  drawAgentForm();
  try {
    st.test = await post(`/agents/${id}/test`);
  } catch (err) {
    st.test = { ok: false, message: err.message };
  }
  if (S.settings === st && st.selected === id) drawAgentForm();
}

function startLogin(id) {
  const st = S.settings;
  if (!st) return;
  st.selected = id;
  st.login = { agentId: id, text: '', running: true };
  drawSettings();
  post(`/agents/${id}/login`).catch((err) => {
    st.login.text += `\n${err.message}\n`;
    st.login.running = false;
    drawAgentForm();
  });
}

function loginTerminal(a) {
  const st = S.settings;
  const out = h('pre', { class: 'term', html: linkify(st.login.text) || '啟動中…' });
  st.loginOut = out;
  const input = h('input', { placeholder: '需要輸入時在這裡回覆（Enter 送出）' });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      post(`/agents/${a.id}/login/input`, { text: input.value }).catch(fail);
      input.value = '';
    }
  };
  const box = h('div', { class: 'login-term' });
  requestAnimationFrame(() => {
    out.scrollTop = out.scrollHeight;
    if (!st.login.scrolled) {
      st.login.scrolled = true;
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  return fill(
    box,
    h('div', { class: 'sec-label', style: { fontSize: '12.5px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-2)' } }, st.login.running ? '登入中 — 打開下方網址並輸入代碼，用你的帳號（例如 Kimi 會員）授權' : '登入程序已結束'),
    out,
    st.login.running ? h('div', { class: 'in' }, input, h('button', { class: 'btn sm', onclick: () => post(`/agents/${a.id}/login/cancel`) }, '取消')) : null,
  );
}

function openTemplates() {
  const grid = h('div', { class: 'tpl-grid' });
  const m = modal([h('div', { class: 'modal-head' }, h('h2', null, '新增 agent'), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: () => m.close() }, icon('x'))), grid], { small: true });
  get('/templates')
    .then((tpls) => {
      fill(grid, 
        ...tpls.map((t) =>
          h(
            'button',
            {
              class: 'acard',
              onclick: async () => {
                try {
                  const a = await post('/agents', { templateId: t.id, name: t.name });
                  await loadAgents();
                  m.close();
                  if (S.settings) {
                    S.settings.selected = a.id;
                    drawSettings();
                  }
                } catch (err) {
                  fail(err);
                }
              },
            },
            h('div', { class: 'top' }, h('span', { class: 'avatar', style: { '--c': t.color } }, initials(t.name)), t.name),
            h('div', { class: 'st' }, t.description || t.typeLabel),
          ),
        ),
      );
    })
    .catch(fail);
}

// ----------------------------------------------------------- live data

async function loadAgents() {
  S.agents = await get('/agents');
  renderSidebar();
  if (S.settings) drawSettings();
  if (S.view?.kind === 'home') S.view.composer.refresh();
}

async function loadSessions() {
  const list = await get('/sessions');
  S.sessions = new Map(list.map((s) => [s.id, s]));
  renderSidebar();
}

function visibleConvs(sid) {
  const v = S.view;
  if (!v) return [];
  if (v.kind === 'session' && v.sid === sid) return [v.conv];
  if (v.kind === 'group' && v.convs.has(sid)) return [v.convs.get(sid)];
  return [];
}

const notified = new Set();
function onMessage(msg) {
  switch (msg.t) {
    case 'event':
    case 'delta':
    case 'patch': {
      const buf = pending.get(msg.sid);
      if (buf) buf.push(msg);
      else for (const conv of visibleConvs(msg.sid)) applyToConv(conv, msg);
      const st = msg.t === 'patch' ? msg.fields?.status : msg.t === 'event' ? msg.ev.status : null;
      if (st === 'done' || st === 'error' || (msg.t === 'event' && msg.ev.type === 'turn_end')) refreshPanelSoon(msg.sid);
      break;
    }
    case 'session': {
      const prev = S.sessions.get(msg.session.id);
      S.sessions.set(msg.session.id, msg.session);
      renderSidebar();
      for (const conv of visibleConvs(msg.session.id)) conv.setStatus(msg.session);
      const v = S.view;
      if (v?.kind === 'session' && v.sid === msg.session.id) {
        drawTopbar();
        v.composer.refresh();
      } else if (v?.kind === 'group' && v.heads.has(msg.session.id)) {
        drawGroupHead(msg.session.id);
        v.composer.refresh();
      }
      // Surface approvals needed by sessions that are not on screen.
      if (msg.session.status === 'awaiting_permission' && prev?.status !== 'awaiting_permission' && !visibleConvs(msg.session.id).length) {
        if (!notified.has(msg.session.id)) {
          notified.add(msg.session.id);
          setTimeout(() => notified.delete(msg.session.id), 3000);
          toast(`${agentName(msg.session.agentId)} 需要你的確認：${msg.session.title}`, { action: { label: '前往', run: () => go(`#/s/${msg.session.id}`) }, timeout: 9000 });
        }
      }
      break;
    }
    case 'deleted':
      S.sessions.delete(msg.sid);
      renderSidebar();
      if (S.view?.sid === msg.sid || (S.view?.kind === 'group' && S.view.convs.has(msg.sid))) go('#/');
      break;
    case 'agents':
      loadAgents().catch(() => {});
      break;
    case 'login': {
      const st = S.settings;
      if (st?.login?.agentId === msg.agentId) {
        st.login.text += msg.text;
        if (st.loginOut) {
          st.loginOut.innerHTML = linkify(st.login.text);
          st.loginOut.scrollTop = st.loginOut.scrollHeight;
        }
      }
      break;
    }
    case 'login_end': {
      const st = S.settings;
      if (st?.login?.agentId === msg.agentId) {
        st.login.running = false;
        st.login.text += `\n[結束，代碼 ${msg.code}]\n`;
        drawAgentForm();
        if (msg.code === 0) testAgent(msg.agentId);
      }
      break;
    }
    default:
  }
}

let banner = null;
let everConnected = false;
function onStatus(ok) {
  S.connected = ok;
  if (ok) {
    banner?.remove();
    banner = null;
    if (everConnected) {
      // Resync everything that may have changed while disconnected.
      Promise.all([loadAgents(), loadSessions()]).then(() => route()).catch(() => {});
    }
    everConnected = true;
  } else if (!banner && everConnected) {
    banner = h('div', { class: 'conn-banner' }, '與伺服器的連線中斷，重新連線中…');
    L.main.append(banner);
  }
}

// --------------------------------------------------------------- boot

async function boot() {
  buildLayout();
  try {
    S.config = await get('/config');
  } catch (err) {
    if (err.status === 401) {
      const t = prompt('這個 Agent Hub 需要存取權杖（啟動時印在終端機的網址中 #token= 後面）：');
      if (t) {
        (await import('./api.js')).setToken(t.trim());
        return location.reload();
      }
    }
    fill(L.main, h('div', { class: 'panel-empty' }, `無法連線到伺服器：${err.message}`));
    return;
  }
  await Promise.all([loadAgents(), loadSessions()]);
  connect(onMessage, onStatus);
  addEventListener('hashchange', route);
  addEventListener('resize', () => S.view?.kind && drawTopbar());
  route();
}

boot();
