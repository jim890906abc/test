#!/usr/bin/env node
// Retakes the three screenshots the README shows (docs/conversation.png,
// docs/artifact.png, docs/mobile-dark.png) from the real front end, with
// invented data only.
//
//   node scripts/take-screenshots.mjs                 # writes into docs/
//   node scripts/take-screenshots.mjs --out DIR       # somewhere else
//
// What it does: starts a throwaway Hub (its own temporary data folder, a
// random port, a made-up login token, a clean environment: no keys, no real
// home folder), lets a pretend computer called "my-computer" connect to it the
// way a connector does, seeds fictional conversations about an imaginary
// "shop-api" project, and photographs the page in a headless Chromium. Nothing
// of yours is read and nothing leaves this machine. The page's clock is set
// to a fixed day and animations are switched off, so a rerun changes no
// pixel unless the front end changed.
//
// Without a Chromium it says so and exits 0 (CHROMIUM_BIN points at one).
//
// When the front end changes (a theme switch, new chips), rerun this and
// look at the three pictures: the selectors below (.side-row, .artifact-card,
// the localStorage keys hubTheme / hubPalette) are the only places that know
// the page's structure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { ROOT, findChromium, launchBrowser, seedSession, skipReason } from '../test/browser-harness.mjs';
import { stopHubAndDaemons } from '../test/fixtures/stop-daemons.mjs';

// The pictures: file name, what it shows. test/screenshots.test.mjs and the
// README read this list, so a name changes in one place.
export const SHOTS = [
  { file: 'conversation.png', width: 1280, height: 860, scale: 2, theme: 'light', session: 's_orders', what: '桌面、淺色：進行中的示範對話（側欄兩個分類、工具步驟、子代理卡、統一模型選單）' },
  { file: 'artifact.png', width: 1280, height: 860, scale: 2, theme: 'light', session: 's_dashboard', sidebar: 'hidden', what: '桌面、淺色：右側 Artifact 即時預覽面板' },
  { file: 'mobile-dark.png', width: 390, height: 844, scale: 2, theme: 'dark', session: 's_orders', phone: true, what: '手機寬度、深色：對話畫面' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the story

// One fixed day, so nothing in the pictures depends on when they were taken.
const NOW = Date.UTC(2026, 2, 14, 10, 30, 0);
const ago = (sec) => NOW - sec * 1000;
export const TOKEN = 'screenshotdemotoken01';
const BRIDGE_KEY = 'screenshot-demo-bridge-key';
export const MACHINE = { id: 'm_demo', name: 'my-computer', home: '/h' };
const CWD = `${MACHINE.home}/projects/shop-api`; // shown as ~/projects/shop-api
const K3 = 'kimi-code/k3-256k';
const DS_FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
const SUBAGENT = { provider: 'deepseek', model: DS_FLASH, effort: 'max' };

const user = (id, text, ts) => ({ id, ts, type: 'user', text });
const text = (id, body, ts, extra = {}) => ({ id, ts, type: 'text', agentId: 'main', text: body, ...extra });
const tool = (id, ts, name, input, output, extra = {}) => ({ id, ts, type: 'tool_use', agentId: 'main', name, status: 'done', input, output, ...extra });

const ORDERS_ROUTE = `router.post('/orders', async (req, res) => {
  const order = await createOrder(req.body);
  await reserveStock(order.items);
  res.status(201).json(order);
});`;

// The main conversation. The phone picture has no subagent card (a card's
// one-line header is wider than a phone), so `phone` leaves it out.
function ordersEvents({ phone }) {
  const events = [
    user('e01', '訂單 API 偶爾回 500，幫我查原因並修好', ago(900)),
    { id: 'e02', ts: ago(890), type: 'thinking', agentId: 'main', text: '先看路由與資料表，再決定怎麼修。' },
    text('e03', phone ? '我先看一下訂單相關的程式碼。' : '我先看一下訂單相關的程式碼，同時請一個子代理去檢查資料庫的索引。', ago(880)),
    tool('e04', ago(870), 'TodoWrite', { todos: [] }, '', {
      todos: [
        { title: '找出 500 的原因', status: 'done' },
        { title: '修正並補上測試', status: 'in_progress' },
        { title: '跑完整測試', status: 'pending' },
      ],
    }),
    tool('e05', ago(860), 'Read', { path: 'src/routes/orders.js' }, ORDERS_ROUTE),
    tool('e06', ago(850), 'Read', { path: 'src/db/stock.js' }, 'export async function reserveStock(items) {\n  // ...\n}'),
    tool('e07', ago(840), 'Grep', { pattern: 'reserveStock' }, 'src/routes/orders.js:3\nsrc/db/stock.js:1'),
  ];
  if (!phone) {
    events.push(
      tool('e08', ago(830), 'Agent', { description: '檢查訂單表的索引' }, '', {
        title: '檢查訂單表的索引',
        subagent: {
          id: 'a1',
          name: 'explore',
          description: '檢查訂單表的索引',
          status: 'done',
          // What was asked for, and what the runtime says it ran: they differ
          // in the thinking effort, and the card says so.
          requested: SUBAGENT,
          actual: { provider: 'deepseek', model: DS_FLASH, effort: 'high' },
          summary: 'orders.user_id 沒有索引，結帳高峰時會全表掃描；庫存不足時 reserveStock 會直接丟出例外。',
        },
      }),
      tool('e09', ago(820), 'Read', { path: 'db/schema.sql' }, 'CREATE TABLE orders (\n  id INTEGER PRIMARY KEY,\n  user_id INTEGER NOT NULL\n);', { parent: 'e08', agentId: 'a1' }),
      tool('e10', ago(815), 'Grep', { pattern: 'CREATE INDEX' }, '（沒有符合的結果）', { parent: 'e08', agentId: 'a1' }),
    );
  }
  events.push(
    text('e11', '找到原因了：`reserveStock` 在庫存不足時會丟出例外，`/orders` 沒有接住，所以偶爾變成 **500**。我來修正。', ago(800)),
    tool(
      'e12',
      ago(790),
      'Edit',
      {
        path: 'src/routes/orders.js',
        old_string: '  await reserveStock(order.items);',
        new_string: '  const ok = await reserveStock(order.items);\n  if (!ok) return res.sendStatus(409);',
      },
      '已更新 src/routes/orders.js',
    ),
    tool('e13', ago(760), 'Bash', { command: 'npm test' }, '✔ 14 個測試全部通過', { title: 'npm test' }),
    text('e14', '修好了：庫存不足時改回 **409**，不再變成 500，14 個測試全部通過。要我順便替 `orders.user_id` 補上索引嗎？', ago(740)),
  );
  return events;
}

function artifactEvents(html) {
  return [
    user('d01', '幫我做一個訂單儀表板', ago(3000)),
    text('d02', '好，我做一個單頁的訂單儀表板，寫好的部分會直接顯示在右邊。', ago(2990)),
    tool('d03', ago(2980), 'Write', { path: 'dashboard.html', content: html }, '已寫入 dashboard.html'),
    text('d04', '儀表板做好了：上面是三個重點數字，中間是每日訂單長條圖，下面是最近訂單，可以依狀態篩選。要接上真的 `/orders` API 嗎？', ago(2960)),
  ];
}

const kimiModelInfo = [
  { model: K3, display_name: 'K3-256k', capabilities: ['thinking', 'image_in'], support_efforts: ['low', 'medium', 'high'], default_effort: 'high', max_context_size: 262144 },
  { model: 'kimi-code/k3-turbo', display_name: 'K3 Turbo', capabilities: ['thinking'], support_efforts: ['low', 'medium', 'high'], default_effort: 'medium', max_context_size: 131072 },
];

export function demoSessions({ html, phone }) {
  const kimi = (patch) =>
    seedSession({
      agentId: `kimi@${MACHINE.id}`,
      machineId: MACHINE.id,
      provider: 'kimi',
      cwd: CWD,
      createdAt: ago(86400),
      modelConfig: { provider: 'kimi', model: K3, effort: 'high' },
      ...patch,
      // subagent: null = new subagents follow the main model.
      meta: { model: K3, effort: 'high', permission: 'auto', machineName: MACHINE.name, subagent: null, ...(patch.meta || {}) },
    });
  return [
    kimi({ id: 's_orders', title: '訂單 API 偶爾回 500', updatedAt: ago(740), events: ordersEvents({ phone }), meta: { context: { used: 42_000, size: 262_144 } } }),
    kimi({ id: 's_dashboard', title: '幫我做一個訂單儀表板', updatedAt: ago(2960), events: artifactEvents(html), meta: { context: { used: 18_000, size: 262_144 } } }),
    // A DeepSeek and a Claude conversation, so the sidebar shows all three providers.
    seedSession({
      id: 's_readme',
      title: '整理 README 的安裝說明',
      agentId: `kimi@${MACHINE.id}`,
      machineId: MACHINE.id,
      provider: 'deepseek',
      mode: 'deepseek',
      cwd: CWD,
      updatedAt: ago(7200),
      modelConfig: { provider: 'deepseek', model: DS_FLASH, effort: 'max' },
      meta: { model: DS_FLASH, effort: 'max', machineName: MACHINE.name, subagent: null },
      events: [user('r01', '整理 README 的安裝說明', ago(7300)), text('r02', '好的，我來整理。', ago(7290))],
    }),
    seedSession({
      id: 's_ci',
      title: '幫我看看 CI 為什麼變慢',
      agentId: 'claude',
      provider: 'claude',
      cwd: CWD,
      updatedAt: ago(10_800),
      meta: { model: 'claude-sonnet-5', subagent: null },
      events: [user('c01', '幫我看看 CI 為什麼變慢', ago(10_900)), text('c02', '我先看最近幾次的執行紀錄。', ago(10_890))],
    }),
    // Sessions seen from a terminal: the folded 子session group.
    ...[
      ['s_term1', '重構 payment 模組', 14_400],
      ['s_term2', '清掉 lint 警告', 18_000],
    ].map(([id, title, secs]) =>
      seedSession({
        id,
        title,
        agentId: `kimi@${MACHINE.id}`,
        machineId: MACHINE.id,
        kimiSessionId: `k_${id}`,
        provider: 'kimi',
        origin: 'external',
        cwd: CWD,
        updatedAt: ago(secs),
        meta: { owner: 'tui', controllable: false, model: K3, machineName: MACHINE.name },
        events: [user(`${id}_u`, title, ago(secs + 60))],
      }),
    ),
  ];
}

// ------------------------------------------------- the pretend computer

// Answers what the Hub asks of a connector, with just enough to list Kimi's
// models. Nothing here runs a model or reads a file.
function connectPretendComputer({ port }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?key=${encodeURIComponent(BRIDGE_KEY)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ws.on('open', () => {
    send({ t: 'hello', machineId: MACHINE.id, name: MACHINE.name, hostname: MACHINE.name, platform: 'linux', bridgeVersion: pkg.version, home: MACHINE.home, status: { available: true, server: true, version: '1.0.0' } });
    send({ t: 'kimi.sessions', items: [] });
  });
  const ok = (data) => ({ code: 0, msg: 'ok', data });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'req') return;
    let data = {};
    if (m.op === 'kimi.request') {
      const p = m.args?.path;
      if (p === '/api/v1/config') data = ok({ default_model: K3 });
      else if (p === '/api/v1/models') data = ok({ items: kimiModelInfo });
      else data = ok({});
    }
    send({ t: 'res', id: m.id, ok: true, data });
  });
  return { ready: new Promise((r) => ws.on('open', r)), close: () => ws.close() };
}

// ------------------------------------------------------ the throwaway Hub

async function startDemoHub(sessions) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-shots-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'home'));
  for (const s of sessions) fs.writeFileSync(path.join(data, 'sessions', `${s.id}.json`), JSON.stringify(s));
  // The Hub names its own computer by os.hostname(); here that is "my-computer".
  const shim = path.join(tmp, 'hostname.mjs');
  fs.writeFileSync(shim, `import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.hostname = () => ${JSON.stringify(MACHINE.name)};\nsyncBuiltinESMExports();\n`);
  const port = 25000 + Math.floor(Math.random() * 3000);
  let log = '';
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // A clean environment on purpose: no API keys, no real home folder.
    env: { PATH: process.env.PATH, HOME: path.join(tmp, 'home'), PORT: String(port), HOST: '127.0.0.1', AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_BRIDGE_KEY: BRIDGE_KEY, AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(tmp, 'ws'), NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the Hub did not start\n${log}`)), 20_000);
    proc.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
    proc.once('exit', (code) => (clearTimeout(t), reject(new Error(`the Hub exited with ${code}\n${log}`))));
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    stop() {
      // A Claude conversation in the list makes the Hub start that computer's
      // Claude daemon, a separate process that outlives the Hub: end the Hub,
      // then the daemons started on this scratch folder (found by their --dir,
      // not by text), then the folder.
      stopHubAndDaemons(proc, tmp);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ------------------------------------------------------------- the camera

// Page code that runs before the page's own: a fixed clock, the colour look
// the shot wants, and nothing that moves.
const beforeLoad = (shot) => `(() => {
  const real = Date, start = real.now(), T = ${NOW};
  class FixedDate extends real { constructor(...a) { a.length ? super(...a) : super(T + (real.now() - start)); } static now() { return T + (real.now() - start); } }
  window.Date = FixedDate;
  try { localStorage.setItem('hubTheme', ${JSON.stringify(shot.theme)}); localStorage.setItem('hubPalette', 'kimi'); localStorage.setItem('hubToken', ${JSON.stringify(TOKEN)}); localStorage.setItem('hubSidebar', ${JSON.stringify(shot.sidebar || '')}); } catch {}
  const quiet = document.createElement('style');
  quiet.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';
  document.addEventListener('DOMContentLoaded', () => document.head.append(quiet));
})()`;

// What no picture may show. Checked against the text the page really shows,
// so a later change to the front end that starts printing a path, the login
// token or a real address stops the run before anything is written.
const NOT_IN_A_PICTURE = [TOKEN, BRIDGE_KEY, os.homedir(), os.tmpdir(), '/root', '/home/', '/Users/'].filter((x) => x.length > 2);
const FAKE_MAIL_DOMAINS = /(^|\.)example\.(com|net|org)$/i;

export async function guardPage(b, hubUrl) {
  const seen = await b.eval(`JSON.stringify({ text: document.body.innerText, resources: performance.getEntriesByType('resource').map((e) => e.name) })`);
  const { text, resources } = JSON.parse(seen);
  // This computer's real name (the Hub is told it is "my-computer"; a name that
  // is also an ordinary word on the page, like "test", would be a false alarm).
  const host = os.hostname().toLowerCase();
  const words = text.toLowerCase().split(/[^a-z0-9_-]+/);
  if (host.length >= 4 && host !== MACHINE.name && words.includes(host)) throw new Error(`the page shows this computer's real name (${host.slice(0, 1)}…), or a word that is the same as it`);
  for (const bad of NOT_IN_A_PICTURE) if (text.includes(bad)) throw new Error(`the page shows text that must not be in a picture (${bad.slice(0, 2)}…): check the demo data and the front end`);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) if (!FAKE_MAIL_DOMAINS.test(m[1])) throw new Error('the page shows an e-mail address outside example.com/.net/.org');
  const origin = new URL(hubUrl).origin;
  const outside = resources.filter((r) => !r.startsWith(origin) && !/^(data|blob):/.test(r));
  if (outside.length) throw new Error(`the page loaded something from outside the throwaway Hub: ${outside[0]}`);
}

// The few things a picture promises. When the front end changes on purpose,
// change these with it; a wrong picture is worse than a stopped run.
async function checkScene(b, shot) {
  const must = async (label, expr) => {
    if (!(await b.eval(expr))) throw new Error(`the ${shot.file} scene is not what it should be: ${label}`);
  };
  await must('the page is as wide as the picture', `innerWidth === ${shot.width}`);
  await must('the conversation is on screen', `Boolean(document.querySelector('.ev-text'))`);
  if (shot.file === 'conversation.png') {
    await must('the sidebar has 聊天室 and 子session', `JSON.stringify([...document.querySelectorAll('.side-group-name')].map((e) => e.innerText)) === ${JSON.stringify(JSON.stringify(['聊天室', '子session']))}`);
    await must('子session is folded and counted', `(() => { const h = document.querySelector('.side-group-head[title*="子session"]'); return h?.getAttribute('aria-expanded') === 'false' && h.querySelector('.side-group-count')?.innerText === '2'; })()`);
    await must('a subagent card shows what was asked for', `/^要求/.test(document.querySelector('.agent-note')?.innerText || '')`);
    await must('the model chip names the model', `/K3-256k/.test(document.querySelector('[data-control="model"]')?.innerText || '') && /high/.test(document.querySelector('[data-control="effort"]')?.innerText || '')`);
  }
  if (shot.file === 'artifact.png') await must('the artifact panel is open', `Boolean(document.querySelector('.artifact-frame'))`);
}

async function capture(b) {
  const r = await b.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  return Buffer.from(r.result.data, 'base64');
}

// ------------------------------------------------------------------- main

// Largest picture the README should carry.
export const MAX_BYTES = 400 * 1024;

export async function takeScreenshots({ out, log = console.log } = {}) {
  const dir = path.resolve(out || path.join(ROOT, 'docs'));
  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'screenshot-demo', 'orders-dashboard.html'), 'utf8');
  const written = [];
  // One throwaway Hub and one fresh browser per picture: nothing one shot
  // leaves behind (an open panel, a saved preference) can reach the next.
  for (const shot of SHOTS) {
    const hub = await startDemoHub(demoSessions({ html, phone: Boolean(shot.phone) }));
    const machine = connectPretendComputer({ port: hub.port });
    let b;
    try {
      await machine.ready;
      b = await launchBrowser({ width: shot.width, height: shot.height });
      await b.beforeLoad(beforeLoad(shot));
      await b.send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: shot.scale, mobile: Boolean(shot.phone) });
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
      await b.goto(`${hub.url}#/s/${shot.session}`, 600);
      await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.ev-text')`, { timeout: 25_000 });
      if (shot.file === 'artifact.png') {
        await b.click('.artifact-card');
        await b.waitFor(`document.querySelector('.artifact-frame')`, { timeout: 25_000 });
        await b.sleep(800);
      }
      await b.eval(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      await b.sleep(300);
      await checkScene(b, shot);
      await guardPage(b, hub.url);
      const png = await capture(b);
      const file = path.join(dir, shot.file);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, png);
      written.push({ file, bytes: png.length, width: shot.width * shot.scale, height: shot.height * shot.scale });
      log(`  ${shot.file}  ${shot.width * shot.scale}x${shot.height * shot.scale}  ${(png.length / 1024).toFixed(0)} KB${png.length > MAX_BYTES ? '  （超過 400 KB，README 載入會偏慢）' : ''}`);
    } finally {
      await b?.close();
      machine.close();
      hub.stop();
    }
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/take-screenshots.mjs [--out DIR]\n  Retakes docs/conversation.png, docs/artifact.png and docs/mobile-dark.png (or into DIR).');
    process.exit(0);
  }
  if (i !== -1 && !args[i + 1]) {
    console.error('--out needs a folder');
    process.exit(2);
  }
  const why = skipReason();
  if (why) {
    console.log(`take-screenshots: skipped — ${why}`);
    process.exit(0);
  }
  console.log(`take-screenshots: Chromium ${findChromium()}`);
  try {
    await takeScreenshots({ out: i === -1 ? null : args[i + 1] });
  } catch (err) {
    console.error(`take-screenshots: ${err.stack || err.message}`);
    process.exit(1);
  }
  process.exit(0);
}
