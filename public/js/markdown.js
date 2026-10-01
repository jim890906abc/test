// Markdown and diff rendering.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { h, fill, icon, copyText } from './dom.js';

marked.setOptions({ gfm: true, breaks: false });

export function markdownInto(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  for (const a of el.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  for (const pre of el.querySelectorAll('pre')) {
    const btn = h('button', { class: 'code-copy', type: 'button', title: '複製', 'aria-label': '複製' }, icon('copy'));
    btn.onclick = async () => {
      await copyText(pre.querySelector('code')?.innerText ?? pre.innerText);
      fill(btn, icon('check'));
      setTimeout(() => fill(btn, icon('copy')), 1200);
    };
    pre.append(btn);
  }
  return el;
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
