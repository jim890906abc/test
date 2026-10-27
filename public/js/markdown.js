// Markdown and diff rendering.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { h, fill, icon, copyText } from './dom.js';

marked.setOptions({ gfm: true, breaks: false });

// The HTML for Markdown `text`, safe to put in a page, as a fragment.
function fragmentOf(html) {
  const t = document.createElement('template');
  t.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  const root = t.content;
  for (const a of root.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  for (const pre of root.querySelectorAll('pre')) {
    const btn = h('button', { class: 'code-copy', type: 'button', title: '複製', 'aria-label': '複製' }, icon('copy'));
    btn.onclick = async () => {
      await copyText(pre.querySelector('code')?.innerText ?? pre.innerText);
      fill(btn, icon('check'));
      setTimeout(() => fill(btn, icon('copy')), 1200);
    };
    pre.append(btn);
  }
  return root;
}

export function markdownInto(el, text) {
  el.replaceChildren(fragmentOf(marked.parse(text || '')));
  return el;
}

// A reply that is still being written. Text only grows, so everything but its
// last block is final: those blocks are drawn once and left alone, and only
// the last block (the one still changing) is parsed and drawn again with
// each addition. A long reply then costs about as much per update as a short
// one, and the part already on screen is not laid out again. The finished
// reply is always drawn whole by markdownInto, so any difference this could
// make lives only while it is being written.
//
// Reference-style links ([text][ref] with "[ref]: url" somewhere) are the
// one thing a later block can change in an earlier one; text that has any is
// drawn whole each time.
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/m;
// Blocks that the block after them can still become part of (a list gets
// another item, a quote another line, a table another row).
const OPEN_ENDED = new Set(['list', 'blockquote', 'table']);
// Raw HTML can leave a tag open for a later block to close, and the browser
// then nests the later block inside it: it cannot be drawn in separate pieces.
const hasHtml = (t) => t.type === 'html' || Boolean(t.tokens?.some(hasHtml)) || Boolean(t.items?.some(hasHtml));

export class MarkdownStream {
  constructor(el) {
    this.el = el;
    this.reset();
  }

  reset() {
    this.text = '';
    this.fixedLen = 0; // characters of the text that are final
    this.fixedNodes = 0; // child nodes of the element that draw them
  }

  update(text) {
    text = text || '';
    if (!text.startsWith(this.text) || REF_DEF.test(text) || text.includes('\r')) {
      this.reset();
      if (REF_DEF.test(text) || text.includes('\r')) {
        markdownInto(this.el, text);
        this.text = text;
        return this.el;
      }
    }
    const tokens = marked.lexer(text.slice(this.fixedLen));
    // Final: every block before the last one, except a block the next one can
    // still join, and anything from the first raw HTML on.
    let cut = tokens.length - 1;
    while (cut >= 0 && tokens[cut].type === 'space') cut--;
    cut = Math.max(0, cut);
    for (;;) {
      let j = cut - 1;
      while (j >= 0 && tokens[j].type === 'space') j--;
      if (j >= 0 && OPEN_ENDED.has(tokens[j].type)) cut = j;
      else break;
    }
    const html = tokens.findIndex(hasHtml);
    if (html !== -1) cut = Math.min(cut, html);
    const stable = tokens.slice(0, cut);
    const live = tokens.slice(cut);
    // what was drawn for the changing part goes; what is final stays
    while (this.el.childNodes.length > this.fixedNodes) this.el.lastChild.remove();
    if (stable.length) {
      const frag = fragmentOf(marked.parser(stable));
      this.fixedNodes += frag.childNodes.length;
      this.fixedLen += stable.reduce((n, t) => n + t.raw.length, 0);
      this.el.append(frag);
    }
    if (live.length) this.el.append(fragmentOf(marked.parser(live)));
    this.text = text;
    return this.el;
  }
}

export const renderMarkdown = (text, cls = 'md') => markdownInto(h('div', { class: cls }), text);

// ------------------------------------------------------------------ diffs

export function lineDiff(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  if (!oldText) return b.map((s) => ({ t: '+', s }));
  if (a.length * b.length > 2_500_000) return [...a.map((s) => ({ t: '-', s })), ...b.map((s) => ({ t: '+', s }))];
  // Trim the common prefix and suffix, LCS on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      mid.push({ t: ' ', s: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ t: '-', s: A[i++] });
    else mid.push({ t: '+', s: B[j++] });
  }
  while (i < n) mid.push({ t: '-', s: A[i++] });
  while (j < m) mid.push({ t: '+', s: B[j++] });
  return [...a.slice(0, pre).map((s) => ({ t: ' ', s })), ...mid, ...b.slice(b.length - suf).map((s) => ({ t: ' ', s }))];
}

export function renderLineDiff(oldText, newText, { context = 3 } = {}) {
  const lines = lineDiff(oldText, newText);
  const box = h('div', { class: 'diff' });
  const keep = lines.map((l, i) => l.t !== ' ' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.t !== ' '));
  let skipped = 0;
  const flush = () => {
    if (skipped) box.append(h('div', { class: 'dl gap' }, `⋯ ${skipped} 行沒有變更`));
    skipped = 0;
  };
  lines.forEach((l, i) => {
    if (!keep[i]) return skipped++;
    flush();
    box.append(h('div', { class: `dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}` }, h('span', { class: 'dm' }, l.t === ' ' ? '' : l.t), l.s || ' '));
  });
  flush();
  return box;
}

export function diffStats(oldText, newText) {
  const lines = lineDiff(oldText, newText);
  return { added: lines.filter((l) => l.t === '+').length, removed: lines.filter((l) => l.t === '-').length };
}

// A `git diff` split per file: [{ path, status, added, removed, lines }].
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      files.push((cur = { path: m[2], status: 'modified', added: 0, removed: 0, lines: [] }));
      continue;
    }
    if (!cur) continue;
    if (/^new file/.test(line)) cur.status = 'added';
    else if (/^deleted file/.test(line)) cur.status = 'deleted';
    else if (/^(index|similarity|rename|old mode|new mode|---|\+\+\+)/.test(line)) continue;
    else {
      if (line.startsWith('+')) cur.added++;
      else if (line.startsWith('-')) cur.removed++;
      cur.lines.push(line);
    }
  }
  return files;
}

export function renderHunks(lines) {
  const box = h('div', { class: 'diff' });
  for (const line of lines) {
    if (line.startsWith('@@')) box.append(h('div', { class: 'dl hunk' }, line.replace(/^@@ (.*?) @@.*/, '$1')));
    else if (line.startsWith('+')) box.append(h('div', { class: 'dl add' }, h('span', { class: 'dm' }, '+'), line.slice(1) || ' '));
    else if (line.startsWith('-')) box.append(h('div', { class: 'dl del' }, h('span', { class: 'dm' }, '-'), line.slice(1) || ' '));
    else if (line.startsWith('\\')) continue;
    else box.append(h('div', { class: 'dl' }, h('span', { class: 'dm' }), line.slice(1) || ' '));
  }
  return box;
}
