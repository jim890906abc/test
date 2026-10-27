// Artifacts: HTML pages Kimi writes (Write/Edit on *.html) are rendered live
// in a sandboxed side panel while the tool call streams. Pages can message
// the conversation through window.agentHub.send() / .fill().
//
// Which tool calls make a page, and what it looks like after each, is
// artifact-rules.js: the Hub applies the same rule to the part of a
// conversation the page does not hold.
import { h, icon } from './dom.js';
import { htmlTitle } from './artifact-rules.js';

export { isHtmlPath, decodePartial, partialField, artifactOf, htmlTitle, collectArtifacts, mergeArtifactIndex } from './artifact-rules.js';

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
      h('span', { class: 'artifact-card-title' }, v?.html != null ? htmlTitle(v.html, art.path) : art.title || htmlTitle(null, art.path)),
      h('span', { class: 'artifact-card-sub' }, streaming ? '正在產生…' : `HTML 頁面${art.versions.length > 1 ? ` · 第 ${n} 版` : ''}`),
    ),
    streaming ? h('span', { class: 'spinner' }) : h('span', { class: 'artifact-card-open' }, '開啟'),
  );
}

