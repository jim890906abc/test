// Measuring how the front end FEELS, in a real Chromium: how long a click on a
// conversation takes to show its newest messages, how smooth a divider drag and
// a stream of tokens are, how fast typing and menus answer, and whether
// switching between big conversations lets go of what it built.
//
// Shared by scripts/perf-ui.mjs (a table for a person) and
// test/ui-perf-budget.test.mjs (generous limits that keep it from regressing).
// Nothing here touches a real data folder: a Hub is started on a copy, or on a
// synthetic conversation built below.
import { spawn } from 'node:child_process';
import { stopHubAndDaemons } from './fixtures/stop-daemons.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, ROOT } from './browser-harness.mjs';
import { synthEvents, synthSession, synthMarkdown } from './fixtures/synth-conversation.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const percentile = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

export { synthEvents, synthSession, synthMarkdown };

// A page an assistant could have written (Write → report.html): moving bars, and
// a script that tells the page around it how many times it has ticked. The tick
// count going on without a gap, and never back to 1, shows the page was not
// reloaded or paused by whatever happened to the page around it.
export const ARTIFACT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>進度頁</title><style>
body{margin:0;padding:24px;font:15px system-ui,sans-serif;background:linear-gradient(135deg,#fff3e0,#e8f0ff);color:#1d2433}
h1{margin:0 0 12px}.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 4px 18px #0002;margin:12px 0}
.bar{height:14px;border-radius:7px;background:#e07b39;animation:grow 2s ease-in-out infinite alternate}
@keyframes grow{from{width:10%}to{width:95%}}
</style></head><body><h1>進度</h1><div class="card"><div class="bar"></div></div><div class="card">tick <b id="n">0</b></div>
<script>let n=0;setInterval(()=>{n++;document.getElementById('n').textContent=n;parent.postMessage({tick:n},'*')},50)<\/script></body></html>`;

// `session` with that page written by an assistant as its last reply, so the
// side panel has an Artifact to show.
export function withArtifact(session) {
  const last = session.events.at(-1);
  const ts = (last?.ts || 1_790_000_000_000) + 1000;
  session.events.push(
    { id: 'art_use', ts, type: 'tool_use', agentId: 'main', toolCallId: 'call_art', name: 'Write', title: '/work/report.html', status: 'done', input: { path: '/work/report.html', content: ARTIFACT_HTML }, display: { kind: 'file_io', operation: 'write', path: '/work/report.html' }, isError: false, output: 'Wrote report.html' },
    { id: 'art_text', ts: ts + 1, type: 'text', agentId: 'main', text: '做好了一個進度頁。' },
    { id: 'art_end', ts: ts + 2, type: 'turn_end', durationMs: 2000, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 }, interrupted: false, error: false },
  );
  return session;
}

// ------------------------------------------------------------------ the Hub

// A Hub on its own copy of `dataDir` (or, when `sessions` is given instead, on
// a fresh folder holding those). The real folder is never opened for writing.
export async function startHubOn({ dataDir = null, sessions = [], env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-perf-'));
  const data = path.join(tmp, 'data');
  if (dataDir) fs.cpSync(dataDir, data, { recursive: true });
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  for (const s of sessions) fs.writeFileSync(path.join(data, 'sessions', `${s.id}.json`), JSON.stringify(s));
  const port = 25000 + Math.floor(Math.random() * 3000);
  let log = '';
  // HUB_ROOT: run another checkout's Hub and page (to measure how it was before a change).
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: process.env.HUB_ROOT || ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(tmp, 'ws'), CLAUDE_CONFIG_DIR: path.join(tmp, '.noclaude'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start\n${log}`)), 30000);
    proc.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
    proc.once('exit', (code) => (clearTimeout(t), reject(new Error(`hub exited ${code}\n${log}`))));
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    data,
    stop() {
      // The Hub until it is really gone, then the Claude daemons started on this
      // scratch folder (they outlive the Hub; found by --dir, never by text).
      stopHubAndDaemons(proc, tmp);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ------------------------------------------------------------------ the page

// Recorders that run in every page before its own scripts: long tasks, long
// animation frames, and the size/time of the big JSON a snapshot is parsed from.
export const PROBES = `(() => {
  const P = (window.__P = { longtasks: [], loaf: [], parse: [], frames: [], inputs: [] });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.loaf.push({ s: e.startTime, d: e.duration, block: e.blockingDuration }); }).observe({ type: 'long-animation-frame', buffered: true }); } catch {}
  // Timers still running: a transcript that is left must stop its clocks.
  const live = new Set();
  const si = window.setInterval.bind(window);
  const ci = window.clearInterval.bind(window);
  window.setInterval = (...a) => { const id = si(...a); live.add(id); return id; };
  window.clearInterval = (id) => { live.delete(id); return ci(id); };
  P.intervals = () => live.size;
  const jp = JSON.parse;
  JSON.parse = function (s, rv) { const t = performance.now(); const v = jp.call(JSON, s, rv); if (typeof s === 'string' && s.length > 100000) P.parse.push({ at: t, len: s.length, ms: performance.now() - t }); return v; };
  // Frame gaps: one rAF loop at a time (a new start retires the old loop), switched on and off by the measurement.
  let gen = 0; let last = 0;
  const loop = (mine) => (t) => { if (mine !== gen) return; if (last) P.frames.push(t - last); last = t; requestAnimationFrame(loop(mine)); };
  P.frameStart = () => { P.frames.length = 0; last = 0; gen++; requestAnimationFrame(loop(gen)); };
  P.frameStop = () => { gen++; return P.frames.slice(); };
  P.reset = () => { P.longtasks.length = 0; P.loaf.length = 0; P.parse.length = 0; };
})()`;

export async function newPage({ width = 1280, height = 900, mobile = false } = {}) {
  const b = await launchBrowser({ width, height });
  if (mobile) await b.size(width, height, true);
  await b.beforeLoad(PROBES);
  await b.beforeLoad(THEME_PROBE);
  return b;
}

export async function openHome(b, url) {
  await b.goto(url, 500);
  await b.waitFor(`document.querySelectorAll('.side-row').length > 0`, { timeout: 20000 });
  await b.eval(`window.__P.reset()`);
}

// "Newest message visible": at least one row of the conversation, with text,
// inside the scroll area. `paint` is two frames later (what the person sees).
const VISIBLE_JS = `((was) => {
  const tr = document.querySelector('.transcript');
  if (!tr || tr === was) return 0;
  const box = tr.getBoundingClientRect();
  let n = 0;
  for (const e of tr.querySelectorAll('.column > .ev')) {
    const r = e.getBoundingClientRect();
    if (r.bottom > box.top && r.top < box.bottom && r.height > 4 && e.textContent.trim().length > 0) n++;
  }
  return n;
})`;

// Click the sidebar row of conversation `id` and time it until its newest
// messages are on screen. When `from` is a hash, go there first.
export async function measureSwitch(b, id, { from = '#/', settle = 400 } = {}) {
  if (from !== null) {
    await b.eval(`location.hash = ${JSON.stringify(from)}`);
    await sleep(700);
  }
  await b.eval(`window.__P.reset()`);
  const r = await b.eval(`(async () => {
    const P = window.__P;
    const row = document.querySelector('a.side-row[href="#/s/${id}"]');
    if (!row) return { missing: true };
    const was = document.querySelector('.transcript');
    const visible = () => ${VISIBLE_JS}(was);
    const t0 = performance.now();
    let first;
    let paint;
    await new Promise((resolve) => {
      const poll = () => {
        if (first === undefined && visible() > 0) {
          first = performance.now() - t0;
          requestAnimationFrame(() => requestAnimationFrame(() => ((paint = performance.now() - t0), resolve())));
          return;
        }
        if (performance.now() - t0 < 20000) requestAnimationFrame(poll);
        else resolve();
      };
      row.click();
      requestAnimationFrame(poll);
    });
    return { first, paint, t0 };
  })()`);
  if (r.missing) throw new Error(`no sidebar row for ${id}`);
  await sleep(settle);
  const after = await b.eval(`(() => {
    const P = window.__P;
    const t0 = ${r.t0};
    const col = document.querySelector('.transcript .column');
    return {
      nodes: document.getElementsByTagName('*').length,
      rows: col ? col.children.length : 0,
      parseMs: P.parse.reduce((a, x) => a + x.ms, 0),
      parseBytes: P.parse.reduce((a, x) => a + x.len, 0),
      // work done in the first second after the click
      longest: Math.max(0, ...P.longtasks.filter((x) => x.s >= t0 && x.s < t0 + 1500).map((x) => x.d)),
      longtasks: P.longtasks.filter((x) => x.s >= t0).length,
    };
  })()`);
  return { first: r.first, paint: r.paint, ...after };
}

// ------------------------------------------------------------ frame statistics

export function frameStats(gaps) {
  if (!gaps.length) return { frames: 0, fps: NaN, p95: NaN, max: NaN };
  const total = gaps.reduce((a, x) => a + x, 0);
  return { frames: gaps.length, fps: (gaps.length / total) * 1000, p95: percentile(gaps, 95), max: Math.max(...gaps) };
}

// Drag the panel's left edge across `distance` px in `steps` mouse moves at
// about 120Hz while recording the gaps between frames and the longest task.
export async function measureDrag(b, { grip = '.panel-grip', distance = 360, steps = 90, pace = 8, axis = 'x' } = {}) {
  const meter = await busyMeter(b);
  const at = await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(grip)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(200, r.height / 2) }; })()`);
  if (!at) throw new Error(`no ${grip}`);
  await b.eval(`window.__P.reset(); window.__P.frameStart()`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  const t0 = await b.eval('performance.now()');
  await meter();
  const pos = (f) => (axis === 'x' ? { x: at.x - distance * f, y: at.y } : { x: at.x, y: at.y - distance * f });
  for (let i = 1; i <= steps; i++) {
    // there and back, so the divider ends where it began
    const f = i <= steps / 2 ? i / (steps / 2) : 2 - i / (steps / 2);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos(f), button: 'left', buttons: 1 });
    await sleep(pace);
  }
  const busy = await meter();
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  const out = await b.eval(`(() => { const P = window.__P; const g = P.frameStop(); return { gaps: g, longest: Math.max(0, ...P.longtasks.filter((x) => x.s >= ${t0}).map((x) => x.d)) }; })()`);
  const st = frameStats(out.gaps);
  // main-thread work per frame: how much room is left in a 16.7 ms frame
  return { ...st, longest: out.longest, taskPerFrame: busy.task / Math.max(1, st.frames), layoutPerFrame: busy.layout / Math.max(1, st.frames), layoutsPerFrame: busy.layouts / Math.max(1, st.frames), stylePerFrame: busy.style / Math.max(1, st.frames) };
}

// ------------------------------------------------------------ memory

export async function heap(b) {
  await b.send('HeapProfiler.collectGarbage');
  await sleep(100);
  await b.send('HeapProfiler.collectGarbage');
  const m = await b.send('Runtime.getHeapUsage');
  const counts = await b.eval(`({ nodes: document.getElementsByTagName('*').length, intervals: window.__P.intervals() })`);
  // listeners held by the page's long-lived objects
  const listeners = {};
  for (const [name, expr] of [['document', 'document'], ['window', 'window'], ['body', 'document.body']]) {
    const obj = (await b.send('Runtime.evaluate', { expression: expr })).result.result;
    const l = await b.send('DOMDebugger.getEventListeners', { objectId: obj.objectId });
    listeners[name] = l.result.listeners.length;
  }
  return { usedMB: m.result.usedSize / 1048576, nodes: counts.nodes, intervals: counts.intervals, listeners };
}

// ------------------------------------------------------------ main-thread load

// The main thread's busy time since the last call, in ms, and the wall time.
export async function busyMeter(b) {
  await b.send('Performance.enable');
  const read = async () => {
    const m = (await b.send('Performance.getMetrics')).result.metrics;
    const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
    return { task: get('TaskDuration') * 1000, script: get('ScriptDuration') * 1000, layout: get('LayoutDuration') * 1000, style: get('RecalcStyleDuration') * 1000, layouts: get('LayoutCount'), styles: get('RecalcStyleCount'), at: get('Timestamp') * 1000 };
  };
  let last = await read();
  return async () => {
    const now = await read();
    const d = { task: now.task - last.task, script: now.script - last.script, layout: now.layout - last.layout, style: now.style - last.style, layouts: now.layouts - last.layouts, styles: now.styles - last.styles, wall: now.at - last.at };
    last = now;
    return d;
  };
}

// A reply of `chars` characters streamed in as `perSec` deltas a second into an
// open conversation (through the windowing stand-in, which plays the Hub), while
// recording frame gaps, long tasks and how busy the main thread was.
export async function measureStream(b, proxy, sid, { chars = 12000, perSec = 30, seconds = Math.max(4, Math.min(25, Math.round(chars / 4000))), id = 'live_reply' } = {}) {
  const live = proxy.live(sid);
  const text = synthMarkdown(chars);
  const per = Math.ceil(chars / (perSec * seconds));
  const deltas = [];
  for (let i = 0; i < text.length; i += per) deltas.push(text.slice(i, i + per));
  const meter = await busyMeter(b);
  live.status('running');
  live.event({ id, type: 'text', agentId: 'main', text: '' });
  await sleep(150);
  await b.eval(`window.__P.reset(); window.__P.frameStart()`);
  await meter();
  const t0 = await b.eval('performance.now()');
  const start = Date.now();
  for (let i = 0; i < deltas.length; i++) {
    live.delta(id, 'text', deltas[i]);
    const due = start + ((i + 1) * 1000) / perSec;
    await sleep(Math.max(0, due - Date.now()));
  }
  await sleep(300);
  const busy = await meter();
  const out = await b.eval(`(() => { const P = window.__P; const g = P.frameStop(); return { gaps: g, longest: Math.max(0, ...P.longtasks.filter((x) => x.s >= ${t0}).map((x) => x.d)), got: document.querySelector('[data-id="${id}"] .md')?.textContent.length || 0 }; })()`);
  live.status('idle');
  return { ...frameStats(out.gaps), longest: out.longest, busyPct: (busy.task / busy.wall) * 100, scriptMs: busy.script, layoutMs: busy.layout, styleMs: busy.style, deltas: deltas.length, drawn: out.got };
}

// ------------------------------------------------------------ typing and menus

// How long the page takes to answer: typing into the message box, opening the
// `/` command menu and the model menu. Each is the time from the event (its own
// timeStamp, taken when the browser received it) to the frame that shows the
// result being started (a rAF callback, then the task after it). Needs a
// conversation open, with the message box in it.
export async function measureInput(b, { keys = 40, streaming = null } = {}) {
  await b.eval(`(() => {
    const P = window.__P;
    P.inputs = [];
    P.after = (t0, label) => new Promise((resolve) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { const v = performance.now() - t0; if (label) P.inputs.push({ label, ms: v }); resolve(v); }; ch.port2.postMessage(0); }));
    const ta = document.querySelector('.composer-input');
    ta.focus();
    ta.addEventListener('input', (e) => P.after(e.timeStamp, 'type'));
  })()`);
  const key = async (ch) => {
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  };
  // streaming: { proxy, sid }: a long reply comes in at 30 deltas a second while typing
  let stopStream = false;
  let feeding = null;
  if (streaming) {
    const live = streaming.proxy.live(streaming.sid);
    live.status('running');
    live.event({ id: 'typing_reply', type: 'text', agentId: 'main', text: '' });
    const text = synthMarkdown(60000, 5);
    feeding = (async () => {
      for (let i = 0; i < text.length && !stopStream; i += 130) {
        live.delta('typing_reply', 'text', text.slice(i, i + 130));
        await sleep(33);
      }
    })();
    await sleep(300);
  }
  for (let i = 0; i < keys; i++) {
    await key('abcdefghij'[i % 10]);
    await sleep(25);
  }
  await sleep(200);
  stopStream = true;
  await feeding;
  const typing = await b.eval(`window.__P.inputs.filter((x) => x.label === 'type').map((x) => x.ms)`);
  if (streaming) {
    streaming.proxy.live(streaming.sid).status('idle');
    return { typing: { median: median(typing), p95: percentile(typing, 95), max: Math.max(...typing), n: typing.length } };
  }
  // the `/` menu: clear, type "/", and wait for the menu to show
  const menu = async (name, open, selector) => {
    const ms = [];
    for (let i = 0; i < 5; i++) {
      await b.eval(`(() => { document.querySelector('.composer-input').value = ''; document.querySelector('.composer-input').dispatchEvent(new Event('input')); document.body.click(); })()`);
      await sleep(150);
      const p = b.eval(`new Promise((resolve) => {
        const t0 = performance.now();
        const watch = new MutationObserver(() => { if (document.querySelector(${JSON.stringify(selector)})) { watch.disconnect(); window.__P.after(t0).then(resolve); } });
        watch.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { watch.disconnect(); resolve(NaN); }, 4000);
      })`);
      await open();
      ms.push(await p);
      await sleep(100);
      await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.composer-input').value = ''; document.querySelector('.composer-input').dispatchEvent(new Event('input'));`);
    }
    return ms;
  };
  const slash = await menu('slash', () => key('/'), '.slash-menu .om-menu__item');
  const modelMenu = await menu('model', () => b.eval(`document.querySelector('[data-control="model"]')?.click()`), '.model-menu .om-menu__item');
  return { typing: { median: median(typing), p95: percentile(typing, 95), max: Math.max(...typing), n: typing.length }, slash: median(slash), model: median(modelMenu) };
}

// ------------------------------------------------------------ transitions

// The sidebar closing and opening, the side panel coming in, a menu opening: how
// many times the page was laid out while it moved, how steady the frames were,
// and how many animations the browser was running. (A page laid out once for the
// whole move is moving with transform and opacity; once a frame is not.)
export async function measureMotion(b, { switchTo = null } = {}) {
  const meter = await busyMeter(b);
  const out = [];
  const run = async (name, click, wait = 450) => {
    await b.eval(`window.__P.reset(); window.__P.frameStart()`);
    await meter();
    const t0 = await b.eval('performance.now()');
    await click();
    await sleep(60);
    const animations = await b.eval(`document.getAnimations().length`);
    await sleep(wait);
    const busy = await meter();
    const r = await b.eval(`(() => { const P = window.__P; const g = P.frameStop(); return { gaps: g, longest: Math.max(0, ...P.longtasks.filter((x) => x.s >= ${t0}).map((x) => x.d)) }; })()`);
    const st = frameStats(r.gaps);
    out.push({ name, layouts: busy.layouts, fps: st.fps, max: st.max, longest: r.longest, animations });
  };
  const clickSel = (sel) => () => b.eval(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  await run('側欄收合', clickSel('button[title="收合側欄"]'));
  await run('側欄展開', clickSel('button[title="顯示側欄"]'));
  await run('面板開', clickSel('button[title^="面板"]'));
  await run('面板關', clickSel('button[title^="面板"]'));
  await run('模型選單', clickSel('[data-control="model"]'), 250);
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  // 設定's menu, a dialog from it, and the conversation fading in when another is opened
  await run('設定選單', clickSel('.side-foot button[aria-label="設定"]'), 250);
  await run('對話框', async () => {
    await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.querySelector('.menu-label')?.textContent.trim().startsWith('GitHub'))?.click()`);
  }, 350);
  await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  if (switchTo) await run('切換對話', clickSel(`a.side-row[href="#/s/${switchTo}"]`), 700);
  return out;
}

// ------------------------------------------------------------ colour changes

// Runs in the page before its own scripts (add it with `b.beforeLoad`): notes
// every view transition the page starts, and records frames and a colour
// fingerprint of a few big surfaces while a colour change is measured.
export const THEME_PROBE = `(() => {
  const T = (window.__T = { vt: [], rec: null });
  const begin = document.startViewTransition ? document.startViewTransition.bind(document) : null;
  if (begin) {
    document.startViewTransition = function (...args) {
      const rec = { at: performance.now(), applied: null, ready: null, finished: null, skipped: false };
      T.vt.push(rec);
      const tr = begin(...args);
      tr.updateCallbackDone.then(() => (rec.applied = performance.now()), () => {});
      tr.ready.then(() => (rec.ready = performance.now()), () => (rec.skipped = true));
      tr.finished.then(() => (rec.finished = performance.now()), () => (rec.finished = performance.now()));
      return tr;
    };
  }
  const probes = ['.app', '.sidebar', '.main', '.composer-box', '.toolbar', 'body'];
  const sig = () => {
    let s = '';
    for (const q of probes) {
      const e = document.querySelector(q);
      if (!e) continue;
      const c = getComputedStyle(e);
      s += c.backgroundColor + c.color + c.borderTopColor + ';';
    }
    return s;
  };
  // Start recording: a frame loop, the moment of the next click, and when the
  // look/theme attributes change.
  T.arm = () => {
    T.stop?.();
    const rec = (T.rec = { frames: [], sigs: [], t0: null, applied: null, vt0: T.vt.length });
    const mo = new MutationObserver(() => { if (rec.t0 != null && rec.applied == null) rec.applied = performance.now(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-look', 'data-theme'] });
    const onClick = (e) => { if (rec.t0 == null) rec.t0 = e.timeStamp; };
    window.addEventListener('click', onClick, true);
    const loop = (t) => { if (T.rec !== rec) return; rec.frames.push(t); rec.sigs.push(sig()); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    T.stop = () => {
      mo.disconnect();
      window.removeEventListener('click', onClick, true);
      T.rec = null;
      T.stop = null;
      const P = window.__P;
      return { ...rec, vt: T.vt.slice(rec.vt0), longtasks: P ? P.longtasks.filter((x) => rec.t0 != null && x.s >= rec.t0 - 5).map((x) => x.d) : [], loaf: P ? P.loaf.filter((x) => rec.t0 != null && x.s >= rec.t0 - 5).map((x) => ({ d: x.d, block: x.block })) : [] };
    };
  };
})()`;

// Where a look/theme change takes place, as the person does it: 設定 (the gear
// in the sidebar) → a menu entry.
export const THEME_STEPS = [
  { name: 'Kimi→Claude', item: 'Claude', look: 'claude' },
  { name: 'Claude→DeepSeek', item: 'DeepSeek', look: 'deepseek' },
  { name: 'DeepSeek→Kimi', item: 'Kimi（', look: 'kimi' },
  { name: '淺色→深色', item: '深色', look: 'kimi', theme: 'dark' },
  { name: '深色→淺色', item: '淺色', look: 'kimi', theme: 'light' },
];

const REF_FRAME = 1000 / 60;

// The numbers of one colour change from what the page recorded.
export function summariseTheme(rec, busy) {
  const { frames, sigs, t0 } = rec;
  if (t0 == null || !frames.length) return null;
  // The last frame before the click is where the window starts.
  let i0 = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i] <= t0) i0 = i;
  // When the surfaces reached the colours they end with (and stayed there).
  const end = sigs.at(-1);
  let k = sigs.length;
  while (k > 0 && sigs[k - 1] === end) k--;
  const visual = k >= sigs.length ? NaN : Math.max(0, frames[k] - t0);
  // A view transition is over when it says so.
  const vt = rec.vt.find((x) => x.finished != null);
  const settle = Math.max(Number.isFinite(visual) ? visual : 0, vt ? vt.finished - t0 : 0);
  let iEnd = frames.findIndex((f, i) => i > i0 && f >= t0 + settle);
  if (iEnd < 0) iEnd = frames.length - 1;
  const gaps = [];
  for (let i = i0 + 1; i <= iEnd; i++) gaps.push(frames[i] - frames[i - 1]);
  const st = frameStats(gaps);
  const dropped = gaps.reduce((a, g) => a + Math.max(0, Math.round(g / REF_FRAME) - 1), 0);
  const inside = rec.longtasks.filter((d) => d > 0);
  // For a view transition, the frames of the fade itself (after the old and the
  // new picture have been taken, which a compositor without a GPU is slow at).
  let fade = null;
  if (vt?.ready != null) {
    const g = [];
    for (let i = 1; i < frames.length; i++) if (frames[i - 1] >= vt.ready && frames[i] <= vt.finished + REF_FRAME) g.push(frames[i] - frames[i - 1]);
    if (g.length) fade = frameStats(g);
  }
  return {
    // the click until the colours are in the page / until nothing moves any more
    applyMs: rec.applied != null ? rec.applied - t0 : NaN,
    settleMs: settle,
    frames: st.frames,
    fps: st.fps,
    p95: st.p95,
    max: st.max,
    dropped,
    over33: gaps.filter((g) => g > 33.4).length,
    gaps: gaps.map((g) => Math.round(g * 10) / 10),
    longest: inside.length ? Math.max(...inside) : 0,
    longtasks: inside.length,
    viaViewTransition: Boolean(vt),
    fadeFps: fade ? fade.fps : NaN,
    fadeMax: fade ? fade.max : NaN,
    fadeFrames: fade ? fade.frames : 0,
    startMs: vt?.ready != null ? vt.ready - t0 : NaN,
    ...(busy
      ? {
          styleCount: busy.styles,
          styleMs: busy.style,
          layoutCount: busy.layouts,
          layoutMs: busy.layout,
          taskMs: busy.task,
          scriptMs: busy.script,
        }
      : {}),
  };
}

// The longest main-thread task, style recalculations (and the elements they
// covered) and layouts of whatever `action` does, from a Chrome trace.
export async function traceMainThread(b, action, { settle = 700 } = {}) {
  const events = [];
  let stream = null;
  const done = new Promise((resolve) => {
    const off = b.on('Tracing.tracingComplete', (p) => (off(), (stream = p.stream), resolve()));
  });
  await b.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
  await sleep(100);
  await action();
  await sleep(settle);
  await b.send('Tracing.end');
  await done;
  let text = '';
  for (;;) {
    const r = (await b.send('IO.read', { handle: stream, size: 1 << 20 })).result;
    text += r.data;
    if (r.eof) break;
  }
  await b.send('IO.close', { handle: stream });
  let all;
  try {
    all = JSON.parse(text);
  } catch {
    all = [];
  }
  const list = Array.isArray(all) ? all : all.traceEvents || [];
  const mains = new Set(list.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const main = list.filter((e) => mains.has(`${e.pid}:${e.tid}`) && e.ph === 'X');
  // trace time is in microseconds; the window starts at the click's dispatch
  const runs = main.filter((e) => e.name === 'RunTask').sort((a, c) => a.ts - c.ts);
  const t0 = list.find((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'click' && mains.has(`${e.pid}:${e.tid}`))?.ts ?? runs[0]?.ts ?? 0;
  const win = (e) => e.ts >= t0 - 2000 && e.ts <= t0 + settle * 1000;
  const tasks = runs.filter(win);
  const style = main.filter((e) => e.name === 'UpdateLayoutTree' && win(e));
  const layout = main.filter((e) => e.name === 'Layout' && win(e));
  const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);
  return {
    longestTaskMs: Math.max(0, ...tasks.map((e) => e.dur / 1000)),
    tasksOver16: tasks.filter((e) => e.dur > 16700).length,
    tasksOver50: tasks.filter((e) => e.dur > 50000).length,
    styleRecalcs: style.length,
    styleMs: sum(style, (e) => e.dur) / 1000,
    styleLongestMs: Math.max(0, ...style.map((e) => e.dur / 1000)),
    styleElements: sum(style, (e) => e.args?.elementCount || 0),
    layouts: layout.length,
    layoutMs: sum(layout, (e) => e.dur) / 1000,
    taskMsTotal: sum(tasks, (e) => e.dur) / 1000,
  };
}

// Open 設定 and choose `step.item`, with a real pointer, while the page records
// frames. Returns the summary of that one change.
async function themeOnce(b, step, { settle = 750, trace = false } = {}) {
  const mouse = async (x, y) => {
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const centre = (js) => b.eval(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  // the quiet before: no toast left over, no menu open
  await b.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
  const gear = await centre(`document.querySelector('.side-foot button[aria-label="設定"]')`);
  if (!gear) throw new Error('no 設定 button');
  await mouse(gear.x, gear.y);
  await b.waitFor(`document.querySelector('.om-menu__item')`, { timeout: 4000 });
  await sleep(300); // the menu finished entering
  const target = JSON.stringify(step.item);
  const at = await centre(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.querySelector('.menu-label')?.textContent.trim().startsWith(${target}))`);
  if (!at) throw new Error(`no menu entry ${step.item}`);
  await b.eval(`window.__P.reset(); window.__T.arm()`);
  await sleep(80); // a few idle frames recorded first
  const meter = await busyMeter(b);
  await meter();
  const action = async () => mouse(at.x, at.y);
  let traced = null;
  if (trace) traced = await traceMainThread(b, action, { settle });
  else {
    await action();
    await sleep(settle);
  }
  const busy = await meter();
  const rec = await b.eval(`window.__T.stop()`);
  const look = await b.eval(`document.documentElement.dataset.look`);
  if (look !== step.look) throw new Error(`${step.name}: expected look ${step.look}, page has ${look}`);
  if (step.theme && (await b.eval(`document.documentElement.dataset.theme`)) !== step.theme) throw new Error(`${step.name}: expected theme ${step.theme}`);
  return { ...summariseTheme(rec, busy), traced };
}

const THEME_KEYS = ['applyMs', 'settleMs', 'fps', 'p95', 'max', 'dropped', 'over33', 'longest', 'styleCount', 'styleMs', 'layoutCount', 'layoutMs', 'taskMs', 'fadeFps', 'fadeMax', 'startMs'];

// The five changes in turn (Kimi→Claude→DeepSeek→Kimi, light→dark→light), `runs`
// times each, the page starting on Kimi light. The medians per change, and the
// worst of them all. `trace` adds one traced round for the longest task.
export async function measureTheme(b, { runs = 5, trace = false, steps = THEME_STEPS, log = () => {} } = {}) {
  await b.eval(`localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubTheme', 'light')`);
  await b.eval(`(() => { const r = document.documentElement; r.dataset.look = 'kimi'; r.dataset.theme = 'light'; })()`);
  await sleep(500);
  const all = steps.map(() => []);
  for (let r = 0; r < runs; r++) {
    for (let s = 0; s < steps.length; s++) {
      const row = await themeOnce(b, steps[s]);
      all[s].push(row);
      log(`theme ${steps[s].name} #${r}: settle ${row.settleMs.toFixed(0)} ms, ${row.fps.toFixed(1)} fps, max ${row.max.toFixed(0)} ms, style ${row.styleCount} × ${row.styleMs.toFixed(1)} ms`);
      await sleep(250);
    }
  }
  const traced = [];
  if (trace) {
    for (let s = 0; s < steps.length; s++) {
      const row = await themeOnce(b, steps[s], { trace: true });
      traced.push(row.traced);
      await sleep(250);
    }
  }
  const per = steps.map((st, s) => {
    const med = Object.fromEntries(THEME_KEYS.map((k) => [k, median(all[s].map((x) => x[k]))]));
    return { name: st.name, ...med, viaViewTransition: all[s].every((x) => x.viaViewTransition), traced: traced[s] || null };
  });
  const worst = {
    maxFrameGap: Math.max(...per.map((x) => x.max)),
    minFps: Math.min(...per.map((x) => x.fps)),
    longest: Math.max(...all.flat().map((x) => x.longest)),
    dropped: Math.max(...per.map((x) => x.dropped)),
    settleMs: Math.max(...per.map((x) => x.settleMs)),
    styleMs: Math.max(...per.map((x) => x.styleMs)),
    longestTraced: traced.length ? Math.max(...traced.map((t) => t.longestTaskMs)) : null,
  };
  return { steps: per, worst, raw: all };
}
