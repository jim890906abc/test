// Shared harness for the tests that drive the real UI in a real browser:
// a scratch Hub (own data folder and port, no token) seeded with sessions, and
// a headless Chromium controlled over the DevTools protocol (the `ws` package
// the Hub already depends on). Nothing here touches the user's data folder.
//
// Without a Chromium the browser tests skip, and say why: set CHROMIUM_BIN to
// point at one (CHROME_BIN works too).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { assertNoLeaksSync, snapshot } from './fixtures/leak-guard.mjs';
import { stopHubAndDaemons } from './fixtures/stop-daemons.mjs';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function findChromium() {
  const wanted = [process.env.CHROMIUM_BIN, process.env.CHROME_BIN].filter(Boolean);
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) wanted.push(r.stdout.trim());
  }
  return wanted.find((p) => fs.existsSync(p)) || null;
}

// The reason to give node:test's `skip`, or false when the browser tests can run.
export function skipReason() {
  return findChromium() ? false : 'no Chromium found (install chromium, or set CHROMIUM_BIN to its path); the real-browser UI checks were not run';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A session in the shape the Hub stores it.
export function seedSession(patch) {
  const now = Date.now();
  return {
    status: 'idle',
    permissionMode: 'ask',
    allowedTools: [],
    state: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now - 1e6,
    updatedAt: now,
    events: [],
    origin: 'hub',
    meta: {},
    ...patch,
  };
}

// Start a scratch Hub with `sessions` already on disk. `seed(dataDir)` runs
// before it starts (to put files there that are not sessions, or are damaged);
// `restart()` stops it and starts it again on the same data and port, the way a
// Hub restart looks to a page that stays open.
export async function startHub(sessions = [], { port = 25000 + Math.floor(Math.random() * 3000), env = {}, seed } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ui-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  for (const s of sessions) fs.writeFileSync(path.join(data, 'sessions', `${s.id}.json`), JSON.stringify(s));
  seed?.(data);
  const before = snapshot(); // for the check in stop(): nothing of this Hub may outlive it
  let log = '';
  let proc = null;
  const launch = async () => {
    proc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(tmp, 'ws'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mine = proc;
    mine.stderr.on('data', (d) => (log += d));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`hub did not start\n${log}`)), 15000);
      mine.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
      mine.once('exit', (code) => (clearTimeout(t), reject(new Error(`hub exited ${code}\n${log}`))));
    });
  };
  await launch();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    data,
    api: async (p, init) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${p}`, init);
      const text = await r.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {}
      if (!r.ok) throw Object.assign(new Error(body?.error || text), { status: r.status });
      return body;
    },
    async restart() {
      const old = proc;
      const gone = new Promise((r) => old.once('exit', r));
      old.kill('SIGTERM');
      await gone;
      await launch();
    },
    stop() {
      // Opening a Claude conversation starts that computer's Claude daemon, a
      // separate process that outlives the Hub. End the Hub (until it is really
      // gone: a Hub that still runs starts a new daemon), then the daemons
      // started on this scratch folder — found by their --dir, never by text.
      stopHubAndDaemons(proc, tmp);
      // ... and it fails here, naming them, if a process of this Hub is still
      // running (that used to pile up, one daemon per test, unnoticed).
      assertNoLeaksSync(before, { dirs: [tmp], stamp: false });
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// A headless Chromium with one page.
export async function launchBrowser({ width = 1280, height = 900 } = {}) {
  const bin = findChromium();
  if (!bin) throw new Error('no Chromium');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chromium-'));
  const port = 29000 + Math.floor(Math.random() * 3000);
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!targets) {
    proc.kill();
    throw new Error('Chromium did not start');
  }
  const page = targets.find((t) => t.type === 'page') || (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json());
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  const listeners = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.method) for (const fn of listeners.get(m.method) || []) fn(m.params);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    else if (m.method === 'Runtime.exceptionThrown') logs.push(`EXC ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const browser = {
    logs,
    send,
    // Listen for a DevTools event (`Tracing.tracingComplete`, `Page.screencastFrame`, …); returns a function that stops listening.
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method).delete(fn);
    },
    async size(w, h, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    },
    async goto(url, settle = 800) {
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(100);
      await send('Page.navigate', { url });
      await sleep(settle);
    },
    // Evaluate an expression (or an async function body via `(async()=>{…})()`).
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`page error: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
      return r.result?.result?.value;
    },
    // Poll until the expression is truthy.
    async waitFor(expression, { timeout = 8000, label = expression } = {}) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try {
          last = await browser.eval(expression);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
    },
    // Run `source` in every page before its own scripts do (to wrap fetch, say).
    async beforeLoad(source) {
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      return r.result?.identifier;
    },
    async removeBeforeLoad(identifier) {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    // Move the pointer onto the first element matching `selector` (for :hover).
    async hover(selector) {
      const r = await browser.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!r) throw new Error(`nothing matches ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await sleep(150);
    },
    async click(selector) {
      const ok = await browser.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
      if (!ok) throw new Error(`nothing matches ${selector}`);
      await sleep(150);
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return file;
    },
    sleep,
    async close() {
      try {
        ws.close();
      } catch {}
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  await browser.size(width, height);
  return browser;
}

// WCAG contrast of a text colour on the colour it actually sits on, measured
// in the page (the effective background is composited from the ancestors, so a
// translucent tag over a coloured row is judged as it is drawn).
export const CONTRAST_JS = `(sel) => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return [0,0,0,1]; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
  const over = (top, bottom) => { const a = top[3]; return [top[0]*a + bottom[0]*(1-a), top[1]*a + bottom[1]*(1-a), top[2]*a + bottom[2]*(1-a), 1]; };
  const lum = ([r,g,b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return null;
  const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n);
  let bg = [255,255,255,1];
  for (const n of chain.reverse()) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) bg = over(c, bg); }
  const fgRaw = parse(getComputedStyle(el).color);
  const op = chain.reduce((a, n) => a * (parseFloat(getComputedStyle(n).opacity) || 0), 1);
  const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * op], bg);
  const l1 = lum(fg), l2 = lum(bg);
  return { ratio: (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05), fg: fg.map(Math.round), bg: bg.map(Math.round) };
}`;

// ---------------------------------------------------------------------------
// A whole UI session for a test file: a scratch Hub seeded with `sessions`,
// a Claude account whose key is accepted by a fake of the Claude API, and a
// browser whose page records every call that changes something (`calls()`) and
// lets a test answer some of them itself (`answer()`), so that nothing real is
// started or changed by a click.
export async function uiSession(sessions, { claude = true } = {}) {
  const { startFakeClaude } = await import('./fixtures/fake-anthropic.mjs');
  const KEY = 'sk-ant-api03-fakeuitestkey0123456789abcdef';
  const fake = await startFakeClaude(KEY);
  const hub = await startHub(sessions, { env: { AGENT_HUB_CLAUDE_TEST_URL: fake.url } });
  if (claude) await hub.api('/claude', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: KEY }) });
  const b = await launchBrowser();
  await b.beforeLoad(`(() => {
    window.__calls = [];
    window.__rules = [];
    window.__delays = [];
    const real = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const d = window.__delays.find((x) => u.startsWith(x.prefix));
        if (d) await new Promise((r) => setTimeout(r, d.ms));
      }
      if (u.startsWith('/api/') && method !== 'GET') {
        window.__calls.push({ method, url: u, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
        const rule = window.__rules.find((r) => r.method === method && u === r.url);
        if (rule) return new Response(JSON.stringify(rule.body), { status: rule.status, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
  })()`);
  const ui = {
    hub,
    b,
    fake,
    calls: () => b.eval('window.__calls'),
    clearCalls: () => b.eval('window.__calls.length = 0'),
    // Answer a change-making call (method + exact /api path) with `status`/`body` instead of sending it.
    answer: (method, url, status, body) => b.eval(`window.__rules.push(${JSON.stringify({ method, url, status, body })})`),
    stopAnswering: () => b.eval('window.__rules = []'),
    // Hold back every GET whose path starts with `prefix` by `ms`, in the pages
    // loaded from now on (and this one).
    async delay(prefix, ms) {
      const push = `window.__delays.push(${JSON.stringify({ prefix, ms })})`;
      await b.eval(push);
      ui.delayScripts.push(await b.beforeLoad(push));
    },
    async stopDelaying() {
      await b.eval('window.__delays = []');
      for (const id of ui.delayScripts.splice(0)) await b.removeBeforeLoad(id);
    },
    delayScripts: [],
    async openApp(hash = '#/', { viewport } = {}) {
      if (viewport) await b.size(viewport[0], viewport[1], viewport[0] < 700);
      else await b.size(1280, 900);
      await b.goto(hub.url + hash, 400);
      await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
    },
    textOf: (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`),
    async stop() {
      await b.close();
      hub.stop();
      fake.close();
    },
  };
  return ui;
}
