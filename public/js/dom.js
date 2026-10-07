// Tiny DOM toolkit: h() element builder, Oatmeal line icons, formatting.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (val == null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      } else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

// replaceChildren() that skips null/false like h() does.
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// 24×24 line icons, stroke 1.6, round caps; drawn for Oatmeal.
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  document: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4"/>',
  chev: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  x: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  up: '<path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  attach: '<path d="m19.5 11.5-7.1 7.1a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3.1 3.1 0 0 1 4.4 4.4l-7.4 7.4a1.5 1.5 0 0 1-2.2-2.2l6.8-6.8"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.8-4.8-9.7 8.3"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  pencil: '<path d="M15.6 4.6a2.1 2.1 0 0 1 3 3L8.4 17.8l-4 1 1-4z"/>',
  filePlus: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M12 11.5v6M9 14.5h6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  files: '<path d="M8.5 7.5V5.5a2 2 0 0 1 2-2H15l4.5 4.5v8.5a2 2 0 0 1-2 2h-1.5"/><path d="M12.5 7.5h-6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-6.5z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z"/>',
  agent: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19.5c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/>',
  agents: '<circle cx="9" cy="8.5" r="2.8"/><path d="M3.5 18.5c.5-3 2.6-4.8 5.5-4.8s5 1.8 5.5 4.8"/><path d="M15 6.2a2.8 2.8 0 0 1 0 5.2M17 13.9c2 .6 3.2 2.2 3.5 4.6"/>',
  todo: '<path d="m4.5 7 1.8 1.8L9.5 5.5M4.5 14l1.8 1.8 3.2-3.3M12.5 7.5h7M12.5 14.5h7"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.5a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2.1-2.3 3.6M12 16.8v.1"/>',
  map: '<path d="M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>',
  bolt: '<path d="M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z"/>',
  check: '<path d="m5 12.5 4.5 4.5 9.5-10"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
  warn: '<path d="M10.3 4.6 3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.9v.1"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3l2.2 2.2"/><path d="M19.5 4.5v4.4h-4.4"/>',
  expand: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  shrink: '<path d="M19.5 9.5h-5v-5M4.5 14.5h5v5M14.5 9.5l6-6M9.5 14.5l-6 6"/>',
  computer: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 19.5h6M12 16v3.5"/>',
  dots: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v1.9M12 19.3v1.9M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.8 12h1.9M19.3 12h1.9M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M19.8 14.6A8 8 0 0 1 9.4 4.2a8 8 0 1 0 10.4 10.4z"/>',
  logout: '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10.5 16.5 6 12l4.5-4.5M6 12h9.5"/>',
  artifact: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 8.5h17M8.5 12.5l-2 2 2 2M15.5 12.5l2 2-2 2"/>',
  panelRight: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  diff: '<path d="M7 3.5v11M3.5 9h7M14 15h7"/><circle cx="17.5" cy="7" r="2.5"/><circle cx="6.5" cy="18" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sparkle: '<path d="M12 3.5c.6 4.4 2.1 5.9 6.5 6.5-4.4.6-5.9 2.1-6.5 6.5-.6-4.4-2.1-5.9-6.5-6.5 4.4-.6 5.9-2.1 6.5-6.5z"/><path d="M18.5 15.5c.3 1.9.9 2.5 2.5 2.8-1.6.3-2.2.9-2.5 2.7-.3-1.8-.9-2.4-2.5-2.7 1.6-.3 2.2-.9 2.5-2.8z"/>',
  brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 7 17.5a2.5 2.5 0 0 0 5 .5V6a2 2 0 0 0-3-1.5zM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3 3 3 0 0 1-2.5 4.7 2.5 2.5 0 0 1-5 .5"/>',
  shield: '<path d="M12 3.5 5 6.2v5.5c0 4.3 2.9 7.3 7 8.8 4.1-1.5 7-4.5 7-8.8V6.2z"/>',
  slash: '<path d="m15.5 4.5-7 15"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="om-icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  return span.firstChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 45) return '剛剛';
  if (d < 3600) return `${Math.round(d / 60)} 分鐘前`;
  if (d < 86400) return `${Math.round(d / 3600)} 小時前`;
  if (d < 172800) return '昨天';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

export function dayGroup(ts) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (ts >= start.getTime()) return '今天';
  if (ts >= start.getTime() - 86400000) return '昨天';
  if (ts >= start.getTime() - 6 * 86400000) return '過去 7 天';
  return '更早';
}

// Time left the way Kimi's own /usage counts it: days, hours and minutes
// ("2 小時 13 分"), seconds only under a minute. Empty once it has passed.
export function fmtCountdown(ms) {
  const total = Math.floor(ms / 1000);
  if (!(total > 0)) return '';
  const parts = [];
  const d = Math.floor(total / 86400);
  const hr = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) parts.push(`${d} 天`);
  if (hr) parts.push(`${hr} 小時`);
  if (m) parts.push(`${m} 分`);
  if (!parts.length) parts.push(`${total % 60} 秒`);
  return parts.join(' ');
}

// "15:30", or "10/8 15:30" when it is not today.
export function clockTime(ts) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function fmtDuration(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)} 秒`;
  return `${Math.floor(s / 60)} 分 ${Math.floor(s % 60)} 秒`;
}

// Last path segments, with the home folder shown as ~.
export function shortPath(p, home, keep = 2) {
  if (!p) return '';
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`;
  const parts = p.split('/').filter(Boolean);
  return parts.length > keep ? parts.slice(-keep).join('/') : p;
}

export const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || p || '';

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
