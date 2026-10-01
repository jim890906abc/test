// Artifacts: HTML pages Kimi writes (Write/Edit on *.html) are rendered live
// in a sandboxed side panel while the tool call streams. Pages can message
// the conversation through window.agentHub.send() / .fill().
import { h, icon } from './dom.js';

export const isHtmlPath = (p) => /\.html?$/i.test(String(p || ''));

// Decode the body of a JSON string that may be cut off mid-stream.
export function decodePartial(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) return out;
    i++;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'u') {
      const hex = s.slice(i + 1, i + 5);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

export function partialField(text, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text || '');
  return m ? decodePartial(text.slice(m.index + m[0].length)) : null;
}

// The artifact a tool event writes, if any: { path, kind, content? }.
export function artifactOf(ev) {
  if (ev.type !== 'tool_use' || !/^(Write|Edit|MultiEdit|WriteFile|StrReplaceFile)$/.test(ev.name)) return null;
  const input = ev.input && typeof ev.input === 'object' ? ev.input : null;
  const path = input?.path || input?.file_path || partialField(ev.argsText, 'path') || partialField(ev.argsText, 'file_path');
  if (!isHtmlPath(path)) return null;
  const write = /Write/.test(ev.name);
  let content = null;
  if (write) content = typeof input?.content === 'string' ? input.content : partialField(ev.argsText, 'content');
  return { path, kind: write ? 'write' : 'edit', content, input, append: input?.mode === 'append' };
}

function applyEdits(base, input) {
  if (base == null || !input) return null;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  let out = base;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || !out.includes(e.old_string)) return null;
    out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string);
  }
  return out;
}

export const htmlTitle = (html, path) => (html && /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()) || String(path || '').split('/').pop();

// All artifacts in a session, oldest first, each with its versions. A
// version's html is null when it can only be read from disk (an Edit whose
// base we never saw).
export function collectArtifacts(events) {
  const byPath = new Map();
  for (const ev of events) {
    const a = artifactOf(ev);
    if (!a) continue;
    let art = byPath.get(a.path);
    if (!art) byPath.set(a.path, (art = { path: a.path, versions: [] }));
    const prev = art.versions.at(-1)?.html ?? null;
    let html = null;
    if (a.kind === 'write') html = a.append ? (prev ?? '') + (a.content ?? '') : a.content;
    else if (['done', 'running'].includes(ev.status)) html = applyEdits(prev, a.input);
    else html = prev;
    const streaming = ev.status === 'pending' || (ev.status === 'running' && !ev.input);
    art.versions.push({ id: ev.id, html, streaming, failed: ev.status === 'error' });
  }
  for (const art of byPath.values()) {
    const v = art.versions.filter((x) => !x.failed);
    art.title = htmlTitle(v.at(-1)?.html, art.path);
    art.updated = art.versions.at(-1).id;
  }
  return [...byPath.values()];
}

// ---------------------------------------------------------------- panel

const BRIDGE = (nonce, follow) =>
  `<script>(function(){var n=${JSON.stringify(nonce)};function p(t,x){parent.postMessage({agentHub:n,type:t,text:String(x==null?'':x)},'*')}` +
  `window.agentHub={send:function(x){p('send',x)},fill:function(x){p('fill',x)}};` +
  (follow ? "addEventListener('load',function(){scrollTo(0,document.documentElement.scrollHeight)});" : '') +
  '})();<\/script>';

function withBridge(html, nonce, follow) {
  const s = BRIDGE(nonce, follow);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + s);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + s);
  return s + html;
}

export class ArtifactView {
  // onSend(text) / onFill(text): messages from the page; readFile(path) for
  // versions that only exist on disk.
  constructor({ onSend, onFill, readFile }) {
    this.onSend = onSend;
    this.onFill = onFill;
    this.readFile = readFile;
    this.nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.frames = [0, 1].map(() => h('iframe', { class: 'artifact-frame', sandbox: 'allow-scripts allow-forms allow-popups allow-modals', referrerpolicy: 'no-referrer', title: 'Artifact' }));
    this.front = 0;
    this.frames[1].classList.add('back');
    this.empty = h('div', { class: 'artifact-empty' }, '正在產生頁面…');
    this.el = h('div', { class: 'artifact-view' }, ...this.frames, this.empty);
    this.html = null;
    this.timer = null;
    this.lastAt = 0;
    this.lastSend = 0;
    this.onMessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d.agentHub !== this.nonce) return;
      if (!this.frames.some((f) => f.contentWindow === e.source)) return;
      const text = String(d.text || '').slice(0, 8000);
      if (!text.trim()) return;
      if (d.type === 'fill') this.onFill?.(text);
      else if (d.type === 'send') {
        if (Date.now() - this.lastSend < 1500) return;
        this.lastSend = Date.now();
        this.onSend?.(text);
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    clearTimeout(this.timer);
  }

  // Show html; while streaming, re-render at most every 300 ms and follow
  // the bottom of the page. Two frames swap so the page never flashes.
  show(html, { streaming = false } = {}) {
    if (html == null) return;
    this.empty.hidden = true;
    if (html === this.html && !this.dirtyFollow) return;
    this.html = html;
    this.streaming = streaming;
    clearTimeout(this.timer);
    const wait = streaming ? Math.max(0, 300 - (Date.now() - this.lastAt)) : 0;
    this.timer = setTimeout(() => this.paint(), wait);
  }

  paint() {
    this.lastAt = Date.now();
    const back = this.frames[this.front ^ 1];
    const front = this.frames[this.front];
    back.onload = () => {
      back.onload = null;
      back.classList.remove('back');
      front.classList.add('back');
      this.front ^= 1;
    };
    back.srcdoc = withBridge(this.html, this.nonce, this.streaming);
  }

  placeholder(text) {
    this.html = null;
    this.empty.textContent = text;
    this.empty.hidden = false;
    for (const f of this.frames) f.classList.add('back');
  }
}

export function downloadHtml(html, path) {
  const a = h('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: String(path || 'artifact.html').split('/').pop() });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

export function artifactCard(art, version, { onOpen, active }) {
  const v = art.versions.find((x) => x.id === version) || art.versions.at(-1);
  const n = art.versions.indexOf(v) + 1;
  const streaming = v?.streaming;
  return h(
    'button',
    { class: `artifact-card${active ? ' active' : ''}`, type: 'button', onclick: () => onOpen(art.path, v?.id) },
    h('span', { class: 'artifact-card-icon' }, icon('artifact')),
    h(
      'span',
      { class: 'artifact-card-text' },
      h('span', { class: 'artifact-card-title' }, htmlTitle(v?.html, art.path)),
      h('span', { class: 'artifact-card-sub' }, streaming ? '正在產生…' : `HTML 頁面${art.versions.length > 1 ? ` · 第 ${n} 版` : ''}`),
    ),
    streaming ? h('span', { class: 'spinner' }) : h('span', { class: 'artifact-card-open' }, '開啟'),
  );
}

