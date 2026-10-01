#!/usr/bin/env node
// Builds a single self-contained HTML preview of the Agent Hub UI: the real
// frontend modules plus preview/mock-backend.js (simulated machines, Kimi
// conversations and files) inlined into one page, suitable for static hosting.
//
//   node scripts/build-preview.mjs [output.html]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist/agent-hub-preview.html'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const lock = JSON.parse(read('package-lock.json')).packages;
const v = (name) => lock[`node_modules/${name}`].version;

// ES modules → one module scope: drop imports, keep declarations.
const strip = (src) => src.replace(/^import .*?;\s*$/gm, '').replace(/^export (?=(async )?function|class|const|let)/gm, '');

function mustReplace(src, from, to) {
  if (!src.includes(from)) throw new Error(`build-preview: pattern not found: ${from.slice(0, 60)}`);
  return src.replace(from, to);
}

let app = strip(read('public/js/app.js'));
// Viewers of a static page have no hub URL; show a placeholder in the
// connect-a-machine commands, and confirm() is unavailable in sandboxed frames.
app = mustReplace(app, 'const origin = location.origin;', "const origin = 'https://你的中控台網址';");
app = mustReplace(app, "const local = /^(localhost|127\\.|\\[::1\\])/.test(location.hostname);", 'const local = false;');
app = app.replace(/\bconfirm\(/g, 'previewConfirm(');
app = mustReplace(app, "'一個介面操控各家 coding agent —— Kimi Code、Gemini CLI、Qwen Code、OpenCode…'", "'介面預覽：側欄的機器與 Kimi 對話都是模擬資料，可以點來試試接管、核准、送訊息。'");
app = mustReplace(app, "h('span', { class: 'logo' }, icon('logo')),\n      'Agent Hub',", "h('span', { class: 'logo' }, icon('logo')),\n      'Agent Hub',\n      h('span', { class: 'tag', title: '介面預覽：機器與 Kimi 對話都是模擬的' }, '預覽'),");

const html = `<title>Agent Hub 預覽</title>
<style>
${read('public/css/app.css')}
html, body { height: 100%; }
.layout { height: 100%; }
.brand .tag { margin-left: 2px; background: var(--accent-soft); color: var(--accent); border-color: transparent; }
</style>
<script>
  try {
    const t = localStorage.getItem('hubTheme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {}
</script>
<div id="app"></div>
<div id="toasts" aria-live="polite"></div>
<script src="https://cdn.jsdelivr.net/npm/marked@${v('marked')}/lib/marked.umd.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@${v('dompurify')}/dist/purify.min.js"></script>
<script type="module">
const marked = window.marked.marked ?? window.marked;
const DOMPurify = window.DOMPurify;
const previewConfirm = () => true;
${strip(read('public/js/dom.js'))}
${strip(read('public/js/render.js'))}
${read('preview/mock-backend.js')}
${app}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`preview written to ${out} (${Math.round(html.length / 1024)} KB)`);
