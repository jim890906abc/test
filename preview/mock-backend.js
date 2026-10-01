// Browser-only stand-in for the Agent Hub server, used to build the hosted
// preview page (scripts/build-preview.mjs). It answers the same REST and
// WebSocket messages as server/ so the real UI code runs unchanged, with
// simulated machines, simulated Kimi conversations and an in-memory file
// system. Nothing here talks to a real machine or a real Kimi account.

const MOCK = (() => {
  const HOME = '/Users/you';
  const listeners = [];
  let n = 1;
  const nid = (p) => `${p}${(n++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  let fast = false;
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      if (fast) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
    });
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const minutes = (m) => Date.now() - m * 60_000;

  // ------------------------------------------------------ virtual files

  const PROJECT = {
    'package.json': '{\n  "name": "shop-api",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    'src/cart.js': "export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return sum;\n}\n",
    'src/server.js': "import http from 'node:http';\nimport { total } from './cart.js';\n\nhttp.createServer((req, res) => res.end(String(total([])))).listen(3000);\n",
    'test/cart.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('total', () => assert.equal(total([{ price: 2, qty: 3 }]), 6));\n",
    'README.md': '# shop-api\n\n購物車 API。\n',
  };
  const workspaces = new Map();
  function ws(cwd) {
    if (!workspaces.has(cwd)) {
      const files = new Map(/shop-api/.test(cwd) ? Object.entries(PROJECT) : []);
      workspaces.set(cwd, { files, base: new Map(files) });
    }
    return workspaces.get(cwd);
  }
  const tree = (w) => [...w.files.keys()].sort().join('\n') || '(空的資料夾)';

  function changes(cwd) {
    const w = ws(cwd);
    let diff = '';
    for (const p of [...new Set([...w.base.keys(), ...w.files.keys()])].sort()) {
      const a = w.base.get(p);
      const b = w.files.get(p);
      if (a === b) continue;
      const lines = (a == null ? (b || '').split('\n').map((s) => ({ t: '+', s })) : lineDiff(a, b ?? '')).filter((l, i, arr) => !(i === arr.length - 1 && l.s === ''));
      const add = lines.filter((l) => l.t === '+').length;
      const del = lines.filter((l) => l.t === '-').length;
      diff += `diff --git a/${p} b/${p}\n${a == null ? 'new file mode 100644\n' : ''}--- ${a == null ? '/dev/null' : `a/${p}`}\n+++ b/${p}\n@@ -1,${lines.length - add} +1,${lines.length - del} @@\n${lines.map((l) => `${l.t}${l.s}`).join('\n')}\n`;
    }
    return { git: true, files: summarizeDiff(diff), diff };
  }
  function summarizeDiff(diff) {
    const files = [];
    let cur = null;
    for (const line of diff.split('\n')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) files.push((cur = { path: m[2], added: 0, removed: 0, status: 'modified' }));
      else if (!cur) continue;
      else if (line.startsWith('new file')) cur.status = 'added';
      else if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
      else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
    }
    return files;
  }
  const DIRS = { [HOME]: ['Desktop', 'code', 'agent-hub-workspaces'], [`${HOME}/code`]: ['shop-api', 'blog', 'scripts'] };

  // ------------------------------------------------- machines and agents

  const machines = [
    {
      id: 'laptop', name: '我的筆電', platform: 'darwin arm64', home: HOME, online: true, lastSeen: Date.now(), bridgeVersion: '0.2.0',
      kimi: { available: true, version: '2.1.1', port: 58627, auth: { models_ready: true } },
      sessions: [
        { id: 'session_pay', title: '修正結帳金額計算錯誤', cwd: `${HOME}/code/shop-api`, busy: true, pending: 'approval', updatedAt: minutes(2) },
        { id: 'session_blog', title: '幫部落格加上 RSS', cwd: `${HOME}/code/blog`, busy: false, pending: 'none', updatedAt: minutes(55) },
        { id: 'session_tidy', title: '整理 scripts 資料夾', cwd: `${HOME}/code/scripts`, busy: false, pending: 'none', updatedAt: minutes(60 * 26) },
      ],
    },
    { id: 'office', name: '公司桌機', platform: 'win32 x64', home: 'C:\\Users\\you', online: false, lastSeen: minutes(60 * 5), kimi: { available: false }, sessions: [] },
  ];
  const machine = (id) => machines.find((m) => m.id === id);
  const publicMachine = (m) => ({ ...clone(m), sessions: m.online ? clone(m.sessions) : [] });

  const agents = [
    { id: 'gemini-cli', name: 'Gemini CLI', type: 'acp', command: 'gemini', args: '--experimental-acp', color: '#4285f4', enabled: true, builtin: true, unavailable: '找不到指令「gemini」，安裝方式：npm i -g @google/gemini-cli', install: 'npm i -g @google/gemini-cli', description: 'Google Gemini CLI 的 ACP 模式（預覽中示範「尚未安裝」的狀態）。' },
    { id: 'kimi', name: 'Kimi Code（本機）', type: 'acp', command: 'kimi', args: 'acp', login: 'kimi login', color: '#1a73e8', enabled: false, builtin: true, unavailable: '找不到指令「kimi」', description: '在中控台這台機器上以 `kimi acp` 執行。要操控其他電腦上的 Kimi，請用「連接機器」。' },
    { id: 'aider', name: 'Aider', type: 'cli', command: 'aider', cliKind: 'aider', args: '', color: '#14a37f', enabled: false, builtin: true, unavailable: '找不到指令「aider」' },
    { id: 'openai', name: 'OpenAI API', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKeyEnv: 'OPENAI_API_KEY', color: '#10a37f', enabled: false, builtin: true, unavailable: '需要 API key' },
    { id: 'demo', name: 'Demo Agent', type: 'demo', color: '#d97757', enabled: true, builtin: true, description: '不需要帳號的示範 agent。' },
  ];
  const remoteAgents = () =>
    machines.map((m) => ({
      id: `kimi@${m.id}`, name: `Kimi Code · ${m.name}`, type: 'kimi-remote', machineId: m.id, color: '#1a73e8', enabled: true, remote: true,
      unavailable: !m.online ? `機器「${m.name}」目前離線（在那台機器上執行連接器）` : null,
      description: `${m.name} 上的 Kimi Code（透過連接器）`,
    }));
  const TYPE_LABELS = { acp: 'ACP Agent', cli: 'CLI', openai: 'OpenAI 相容 API', demo: 'Demo', 'kimi-remote': 'Kimi · 遠端機器' };
  const agentFor = (id) => agents.find((a) => a.id === id) || remoteAgents().find((a) => a.id === id);
  const publicAgent = (a) => {
    const { unavailable, ...rest } = a;
    return { ...clone(rest), typeLabel: TYPE_LABELS[a.type], available: !unavailable, reason: unavailable || '', hasApiKey: false, apiKeyFromEnv: false, loginCommand: a.login || '' };
  };

  // ------------------------------------------------------------ sessions

  const sessions = new Map();
  const running = new Map();
  const pendingPerm = new Map();
  const broadcast = (msg) => {
    const copy = clone(msg);
    for (const fn of listeners) setTimeout(() => fn(clone(copy)), 0);
  };
  const summarize = (s) => {
    const { events, state, ...rest } = s;
    return clone(rest);
  };
  function emit(s, f) {
    const ev = { id: nid('e_'), ts: Date.now(), ...f };
    s.events.push(ev);
    s.seq++;
    s.updatedAt = Date.now();
    broadcast({ t: 'event', sid: s.id, seq: s.seq, ev });
    return ev;
  }
  function patch(s, ev, f) {
    Object.assign(ev, f);
    s.seq++;
    broadcast({ t: 'patch', sid: s.id, seq: s.seq, id: ev.id, fields: f });
  }
  function delta(s, ev, text, field = 'text') {
    ev[field] = (ev[field] || '') + text;
    s.seq++;
    broadcast({ t: 'delta', sid: s.id, seq: s.seq, id: ev.id, field, text });
  }
  function setStatus(s, status) {
    if (s.status === status) return;
    s.status = status;
    s.updatedAt = Date.now();
    broadcast({ t: 'session', session: summarize(s) });
  }
  function setMeta(s, f) {
    s.meta = { ...(s.meta || {}), ...f };
    broadcast({ t: 'session', session: summarize(s) });
  }
  function createSession(f) {
    const s = { id: nid('s_'), title: 'New session', status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {}, seq: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: Date.now(), updatedAt: Date.now(), ...f };
    sessions.set(s.id, s);
    broadcast({ t: 'session', session: summarize(s) });
    return s;
  }
  async function stream(ctx, type, text, ev) {
    ev ??= ctx.emit({ type, text: '' });
    for (const p of text.match(/[\s\S]{1,3}/g) || []) {
      await sleep(12 + Math.random() * 18, ctx.signal);
      ctx.delta(ev, p);
    }
    return ev;
  }
  function makeCtx(s, ac) {
    return {
      s, signal: ac.signal, usage: { inputTokens: 0, outputTokens: 0 },
      emit: (f) => emit(s, f), patch: (ev, f) => patch(s, ev, f), delta: (ev, t, f) => delta(s, ev, t, f), setMeta: (f) => setMeta(s, f),
      async askUser(ev, options) {
        patch(s, ev, { status: 'awaiting', permission: { options, chosen: null } });
        setStatus(s, 'awaiting_permission');
        const chosen = await new Promise((resolve) => {
          if (ac.signal.aborted) return resolve(null);
          pendingPerm.set(`${s.id}:${ev.id}`, resolve);
          ac.signal.addEventListener('abort', () => resolve(null), { once: true });
        });
        pendingPerm.delete(`${s.id}:${ev.id}`);
        if (!ac.signal.aborted) setStatus(s, 'running');
        patch(s, ev, { status: 'pending', permission: { options, chosen: chosen ?? 'cancelled' } });
        return chosen;
      },
    };
  }

  // ------------------------------------------------- simulated Kimi turns

  const KIMI_OPTIONS = [
    { optionId: 'approved', name: '允許', kind: 'allow_once' },
    { optionId: 'approved_session', name: '本次對話一律允許', kind: 'allow_always' },
    { optionId: 'rejected', name: '拒絕', kind: 'reject_once' },
  ];
  // ask = manual (asks for edits and commands), auto_edits = yolo (asks only
  // for risky commands), bypass = auto (never asks).
  function needsApproval(s, name) {
    if (s.state.allowed?.[name]) return false;
    if (s.permissionMode === 'bypass') return false;
    if (s.permissionMode === 'auto_edits') return name === 'Bash' && /rm |git push/.test(s.state.lastCmd || '');
    return name === 'Bash' || name === 'Edit' || name === 'Write';
  }
  async function kimiTool(ctx, fields, { output, apply } = {}) {
    const s = ctx.s;
    const ev = ctx.emit({ type: 'tool_use', source: 'kimi', toolCallId: nid('call_'), status: 'pending', ...fields });
    await sleep(250, ctx.signal);
    if (needsApproval(s, fields.name)) {
      const chosen = await ctx.askUser(ev, KIMI_OPTIONS);
      if (chosen === 'approved_session') (s.state.allowed ??= {})[fields.name] = true;
      if (!chosen || chosen === 'rejected') {
        ctx.patch(ev, { status: ctx.signal.aborted ? 'interrupted' : 'error', isError: true, output: `Tool "${fields.name}" was not run because the user rejected it.` });
        return false;
      }
    }
    ctx.patch(ev, { status: 'running', output: '' });
    await sleep(200, ctx.signal);
    apply?.();
    for (const line of (output || '').split('\n').filter(Boolean)) {
      await sleep(70, ctx.signal);
      ctx.delta(ev, `${line}\n`, 'output');
    }
    ctx.patch(ev, { status: 'done' });
    return true;
  }

  async function runKimi(ctx, text) {
    const s = ctx.s;
    const w = ws(s.cwd);
    const isProject = w.files.has('src/cart.js');
    await stream(ctx, 'thinking', `使用者要求：「${text.slice(0, 50)}」。${isProject ? '先看 src/cart.js 和測試，找出金額計算的問題。' : '先看看資料夾裡有什麼。'}`);
    await stream(ctx, 'text', isProject ? '我先看一下專案結構和計算邏輯。' : '我先看看這個資料夾。');
    await kimiTool(ctx, { name: 'Glob', title: '**/*', input: { pattern: '**/*' }, display: { kind: 'search', query: '**/*' } }, { output: tree(w) });
    let file;
    let before;
    let after;
    let cmd;
    if (isProject) {
      file = 'src/cart.js';
      before = w.files.get(file);
      after = before.includes('discount')
        ? before
        : "export function total(items, { discount = 0 } = {}) {\n  const sum = items.reduce((acc, i) => acc + i.price * i.qty, 0);\n  return Math.round(sum * (1 - discount) * 100) / 100;\n}\n";
      await kimiTool(ctx, { name: 'Read', title: file, input: { path: file }, display: { kind: 'file_io', operation: 'read', path: file } }, { output: before.trimEnd() });
      cmd = 'npm test';
    } else {
      file = 'NOTES.md';
      before = w.files.get(file) ?? '';
      after = `${before}# 筆記\n\n- ${text.replace(/\n/g, ' ').slice(0, 80)}\n`;
      cmd = 'ls -la';
    }
    await stream(ctx, 'text', `\n接下來修改 \`${file}\`：`);
    const edited = await kimiTool(ctx, { name: 'Edit', title: file, input: { path: file }, display: { kind: 'diff', path: file, before, after } }, { apply: () => w.files.set(file, after) });
    if (!edited) return stream(ctx, 'text', '\n修改沒有被允許，我先停在這裡。要換個做法嗎？');
    s.state.lastCmd = cmd;
    const out = isProject ? '> shop-api@1.0.0 test\n> node --test\n\n✔ total (0.6ms)\n✔ total with discount (0.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0' : tree(w);
    const ran = await kimiTool(ctx, { name: 'Bash', title: cmd, input: { command: cmd }, display: { kind: 'command', command: cmd, language: 'bash' } }, { output: out });
    s.state.turns = (s.state.turns || 0) + 1;
    setMeta(s, { context: { used: 18000 + s.state.turns * 9000, size: 262144 } });
    ctx.usage = { inputTokens: 21000, outputTokens: 860 };
    await stream(
      ctx,
      'text',
      isProject
        ? `\n\n完成 ✅\n\n- \`total()\` 改用 \`reduce\`，並支援折扣參數\n- 金額四捨五入到小數第二位，修正浮點數誤差（例如 0.1 + 0.2）\n${ran ? '- `npm test` 全部通過' : '- 測試沒有執行'}\n\n右上角的工作區面板可以看到完整 diff。`
        : `\n\n完成 ✅ 已更新 \`${file}\`。`,
    );
  }

  // ---------------------------------------------- simulated demo agent

  const DEMO_KIND = { bash: 'exec', write_file: 'edit', list_files: 'read' };
  async function hubTool(ctx, name, input, output, apply) {
    const s = ctx.s;
    const titles = { bash: input.command, write_file: input.path, list_files: '.' };
    const ev = ctx.emit({ type: 'tool_use', name, input, title: titles[name], status: 'pending' });
    const kind = DEMO_KIND[name];
    if (!s.allowedTools.includes(name) && kind !== 'read' && s.permissionMode !== 'bypass' && !(s.permissionMode === 'auto_edits' && kind === 'edit')) {
      const chosen = await ctx.askUser(ev, [
        { optionId: 'allow', name: '允許', kind: 'allow_once' },
        { optionId: 'always', name: `本 session 一律允許 ${name}`, kind: 'allow_always' },
        { optionId: 'deny', name: '拒絕', kind: 'reject_once' },
      ]);
      if (chosen === 'always') s.allowedTools.push(name);
      if (chosen !== 'allow' && chosen !== 'always') {
        ctx.patch(ev, { status: ctx.signal.aborted ? 'interrupted' : 'denied', output: '使用者拒絕了這個操作。', isError: true });
        return false;
      }
    }
    ctx.patch(ev, { status: 'running', output: '' });
    await sleep(250, ctx.signal);
    apply?.();
    ctx.patch(ev, { status: 'done', output });
    return true;
  }
  async function runDemo(ctx, text) {
    const w = ws(ctx.s.cwd);
    const code = 'def main():\n    print("Hello from Agent Hub (Python)!")\n\n\nif __name__ == "__main__":\n    main()\n';
    ctx.setMeta({ agentInfo: { name: 'Demo Agent', version: '1.0' }, protocol: 'built-in' });
    await stream(ctx, 'thinking', `需求：「${text.slice(0, 60)}」。先看工作區，再建立 hello.py 並執行。`);
    await stream(ctx, 'text', '好的，我先看一下工作區。');
    await hubTool(ctx, 'list_files', { path: '.' }, tree(w));
    const ok = await hubTool(ctx, 'write_file', { path: 'hello.py', content: code }, 'Created hello.py (6 lines)', () => w.files.set('hello.py', code));
    if (!ok) return stream(ctx, 'text', '\n寫入沒有被允許，我先停在這裡。');
    await hubTool(ctx, 'bash', { command: 'python3 hello.py' }, 'Hello from Agent Hub (Python)!\n[exit code 0]');
    ctx.usage = { inputTokens: 1200, outputTokens: 400 };
    await stream(ctx, 'text', '\n\n完成了 ✅ 建立了 `hello.py` 並執行成功。');
  }

  async function runTurn(s, text, images = []) {
    if (running.has(s.id)) throw httpError(409, '這個 session 正在執行中');
    const agent = agentFor(s.agentId);
    const ac = new AbortController();
    running.set(s.id, ac);
    emit(s, { type: 'user', text, images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) });
    if (!s.titled) {
      s.title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || s.title;
      s.titled = true;
    }
    setStatus(s, 'running');
    const ctx = makeCtx(s, ac);
    const start = s.events.length;
    const t0 = Date.now();
    let error = null;
    try {
      if (agent?.unavailable) throw new Error(agent.unavailable);
      if (agent?.type === 'kimi-remote') await runKimi(ctx, text);
      else await runDemo(ctx, text);
    } catch (err) {
      if (ac.signal.aborted) emit(s, { type: 'info', text: '已中斷' });
      else emit(s, { type: 'error', text: (error = err.message) });
    } finally {
      running.delete(s.id);
      for (const ev of s.events.slice(start)) if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) patch(s, ev, { status: 'interrupted' });
      s.usage.inputTokens += ctx.usage.inputTokens;
      s.usage.outputTokens += ctx.usage.outputTokens;
      emit(s, { type: 'turn_end', durationMs: fast ? 8000 + Math.random() * 9000 : Date.now() - t0, usage: ctx.usage, interrupted: ac.signal.aborted, error: Boolean(error) });
      setStatus(s, error ? 'error' : 'idle');
      const k = s.kimiSessionId && machine(s.machineId)?.sessions.find((x) => x.id === s.kimiSessionId);
      if (k) Object.assign(k, { busy: false, pending: 'none', updatedAt: Date.now() });
    }
  }
  const startTurn = (s, text, images) => {
    if (running.has(s.id)) throw httpError(409, '這個 session 正在執行中');
    runTurn(s, text, images).catch(console.error);
  };

  // Conversation history that "Kimi on the machine" already has.
  function kimiHistory(k) {
    const t = Date.parse(new Date(k.updatedAt).toISOString()) - 120_000;
    if (k.id === 'session_pay') {
      return [
        { type: 'user', text: '結帳金額有時候會多出 0.0000001，幫我修好，並加上折扣功能', source: 'kimi', ts: t },
        { type: 'text', text: '我先看一下計算金額的程式。', ts: t + 5000 },
        { type: 'tool_use', source: 'kimi', name: 'Read', title: 'src/cart.js', input: { path: 'src/cart.js' }, display: { kind: 'file_io', operation: 'read', path: 'src/cart.js' }, status: 'done', output: PROJECT['src/cart.js'].trimEnd(), ts: t + 9000 },
        { type: 'text', text: '問題在浮點數相乘後沒有四捨五入。我要改寫 `total()`：', ts: t + 15000 },
      ];
    }
    return [
      { type: 'user', text: k.title, source: 'kimi', ts: t },
      { type: 'text', text: '好的，我看過了，已經完成。主要改動在 `index.js`，你可以在工作區面板看 diff。', ts: t + 30000 },
      { type: 'turn_end', durationMs: 41000, usage: { inputTokens: 15200, outputTokens: 700 }, ts: t + 41000 },
    ];
  }

  function attach(m, k) {
    const existing = [...sessions.values()].find((s) => s.kimiSessionId === k.id);
    if (existing) return existing;
    const history = kimiHistory(k).map((e) => ({ id: nid('k_'), ...e }));
    const s = createSession({
      agentId: `kimi@${m.id}`, machineId: m.id, kimiSessionId: k.id, cwd: k.cwd, title: k.title, titled: true, events: history, createdAt: k.updatedAt - 180_000,
      meta: {
        agentInfo: { name: `Kimi Code · ${m.name}`, version: m.kimi.version }, protocol: `Kimi Server API · ${m.name}`, imageInput: true,
        context: { used: 23000, size: 262144 },
        configOptions: [{ id: 'model', name: '模型', type: 'select', currentValue: '', options: [{ value: '', name: 'Kimi 預設（kimi-for-coding）' }, { value: 'kimi-k2-turbo', name: 'kimi-k2-turbo' }] }],
      },
    });
    s.events.push({ id: nid('k_'), ts: Date.now(), type: 'info', text: `已載入 Kimi 對話紀錄（${history.length} 則訊息）` });
    if (k.pending === 'approval') {
      const w = ws(s.cwd);
      const before = w.files.get('src/cart.js');
      const after = "export function total(items) {\n  const sum = items.reduce((acc, i) => acc + i.price * i.qty, 0);\n  return Math.round(sum * 100) / 100;\n}\n";
      const ev = { id: nid('k_'), ts: Date.now(), type: 'tool_use', source: 'kimi', name: 'Edit', title: 'src/cart.js', input: { path: 'src/cart.js' }, display: { kind: 'diff', path: 'src/cart.js', before, after }, status: 'awaiting', permission: { options: KIMI_OPTIONS, chosen: null } };
      s.events.push(ev);
      s.status = 'awaiting_permission';
      s.state.waiting = { ev, apply: () => w.files.set('src/cart.js', after) };
    }
    broadcast({ t: 'session', session: summarize(s) });
    return s;
  }

  // Finish the turn that was waiting for approval when the session was taken over.
  async function continueWaiting(s, optionId) {
    const { ev, apply } = s.state.waiting;
    s.state.waiting = null;
    const ac = new AbortController();
    running.set(s.id, ac);
    const ctx = makeCtx(s, ac);
    patch(s, ev, { permission: { ...ev.permission, chosen: optionId } });
    if (optionId === 'approved_session') (s.state.allowed ??= {}).Edit = true;
    setStatus(s, 'running');
    try {
      if (optionId === 'rejected') {
        patch(s, ev, { status: 'error', isError: true, output: 'Tool "Edit" was not run because the user rejected it.' });
        await stream(ctx, 'text', '好的，我不改這個檔案。你希望用什麼方式處理？');
      } else {
        patch(s, ev, { status: 'running' });
        await sleep(300);
        apply();
        patch(s, ev, { status: 'done' });
        s.state.lastCmd = 'npm test';
        await kimiTool(ctx, { name: 'Bash', title: 'npm test', input: { command: 'npm test' }, display: { kind: 'command', command: 'npm test' } }, { output: '> shop-api@1.0.0 test\n> node --test\n\n✔ total (0.5ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0' });
        await stream(ctx, 'text', '\n\n完成 ✅ `total()` 現在會四捨五入到小數第二位，測試通過。要我接著加上折扣功能嗎？');
      }
    } catch {}
    running.delete(s.id);
    emit(s, { type: 'turn_end', durationMs: 152000, usage: { inputTokens: 26000, outputTokens: 1100 } });
    setStatus(s, 'idle');
    const k = machine(s.machineId).sessions.find((x) => x.id === s.kimiSessionId);
    Object.assign(k, { busy: false, pending: 'none', updatedAt: Date.now() });
    broadcast({ t: 'machine', machine: publicMachine(machine(s.machineId)) });
  }

  // --------------------------------------------------------------- routes

  async function handle(method, url, body = {}) {
    const [path, qs] = url.split('?');
    const q = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    await seeded;
    const S = (id) => sessions.get(id) || (() => { throw httpError(404, '找不到 session'); })();

    if (path === '/config') return { version: 'preview', workspacesDir: `${HOME}/agent-hub/workspaces`, home: HOME, host: 'preview' };
    if (path === '/hub') return { bridgeKey: 'bk_預覽版示意金鑰_實際啟動後會顯示你的金鑰', bridgePath: '/bridge/agent-hub-bridge.mjs' };
    if (path === '/agents' && method === 'GET') return [...agents, ...remoteAgents()].map(publicAgent);
    if (path === '/templates') return agents.map(publicAgent);
    if (path === '/machines') return machines.map(publicMachine);
    if (parts[0] === 'machines') {
      const m = machine(parts[1]);
      if (!m) throw httpError(404, '找不到這台機器');
      if (method === 'DELETE') {
        machines.splice(machines.indexOf(m), 1);
        broadcast({ t: 'machines' });
        return { ok: true };
      }
      if (parts[2] === 'kimi' && parts[4] === 'attach') {
        const k = m.sessions.find((x) => x.id === parts[3]);
        if (!k) throw httpError(404, '找不到這個 Kimi 對話');
        await sleep(400);
        const s = attach(m, k);
        broadcast({ t: 'machine', machine: publicMachine(m) });
        return summarize(s);
      }
      return { ok: true };
    }
    if (parts[0] === 'agents') {
      if (method === 'POST' && !parts[1]) {
        const tpl = agentFor(body.templateId) || {};
        const a = { ...clone(tpl), ...body, id: nid('a_'), builtin: false, enabled: true };
        agents.push(a);
        broadcast({ t: 'agents' });
        return publicAgent(a);
      }
      const a = agentFor(parts[1]);
      if (!a) throw httpError(404, '找不到 agent');
      if (method === 'PUT') {
        Object.assign(a, body);
        broadcast({ t: 'agents' });
        return publicAgent(a);
      }
      if (parts[2] === 'test') {
        await sleep(500);
        return a.unavailable ? { ok: false, message: a.unavailable } : { ok: true, message: `預覽模式：${a.name} 可以使用。` };
      }
      if (parts[2] === 'login' && !parts[3]) {
        setTimeout(() => broadcast({ t: 'login', agentId: a.id, text: `$ ${a.login || `${a.command} login`}\n預覽版沒有真正的 ${a.command} 程式。實際使用時，這裡會顯示授權網址與代碼。\n` }), 200);
        setTimeout(() => broadcast({ t: 'login_end', agentId: a.id, code: 1 }), 500);
      }
      return { ok: true };
    }
    if (path === '/fs/dirs') {
      const p = q.get('path') || HOME;
      return { path: p, parent: p === HOME ? null : p.split('/').slice(0, -1).join('/') || '/', git: /shop-api|blog/.test(p), dirs: DIRS[p] || [] };
    }
    if (path === '/sessions' && method === 'GET') return [...sessions.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
    if (path === '/sessions' && method === 'POST') {
      const a = agentFor(body.agentId);
      if (!a) throw httpError(400, '找不到 agent');
      if (a.unavailable) throw httpError(409, a.unavailable);
      const slug = (body.prompt || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'workspace';
      const cwd = body.cwd || `${HOME}/agent-hub-workspaces/2026-10-01-${slug}`;
      const extra = a.type === 'kimi-remote' ? { machineId: a.machineId, kimiSessionId: nid('session_'), meta: { agentInfo: { name: a.name, version: '2.1.1' }, protocol: `Kimi Server API · ${machine(a.machineId).name}`, imageInput: true } } : {};
      const s = createSession({ agentId: a.id, cwd, permissionMode: body.permissionMode || 'ask', ...extra });
      if (extra.kimiSessionId) machine(a.machineId).sessions.unshift({ id: extra.kimiSessionId, title: body.prompt?.slice(0, 40) || '新對話', cwd, busy: true, pending: 'none', updatedAt: Date.now() });
      if (body.prompt?.trim() || body.images?.length) startTurn(s, body.prompt || '', body.images);
      return summarize(s);
    }
    if (path === '/compare') {
      const groupId = nid('g_');
      const list = (body.agentIds || []).map((id) => {
        const a = agentFor(id);
        const extra = a.type === 'kimi-remote' ? { machineId: a.machineId, kimiSessionId: nid('session_') } : {};
        return createSession({ agentId: id, cwd: `${HOME}/agent-hub-workspaces/compare-${id.replace(/\W/g, '')}`, groupId, permissionMode: body.permissionMode || 'ask', ...extra });
      });
      for (const s of list) startTurn(s, body.prompt);
      return { groupId, sessions: list.map(summarize) };
    }
    if (parts[0] === 'groups') {
      let sent = 0;
      for (const s of sessions.values()) if (s.groupId === parts[1] && !running.has(s.id)) (startTurn(s, body.text), sent++);
      return { sent };
    }
    if (parts[0] === 'sessions') {
      const s = S(parts[1]);
      const sub = parts[2];
      if (!sub && method === 'GET') return { ...summarize(s), events: clone(s.events), allowedTools: clone(s.allowedTools) };
      if (!sub && method === 'PATCH') {
        if (body.title) (s.title = body.title), (s.titled = true);
        if (body.permissionMode) s.permissionMode = body.permissionMode;
        broadcast({ t: 'session', session: summarize(s) });
        return summarize(s);
      }
      if (!sub && method === 'DELETE') {
        running.get(s.id)?.abort();
        sessions.delete(s.id);
        broadcast({ t: 'deleted', sid: s.id });
        if (s.machineId) broadcast({ t: 'machine', machine: publicMachine(machine(s.machineId)) });
        return { ok: true };
      }
      if (sub === 'messages') return startTurn(s, body.text || '', body.images), { ok: true };
      if (sub === 'interrupt') return running.get(s.id)?.abort(), { ok: true };
      if (sub === 'permissions') {
        if (s.state.waiting && s.state.waiting.ev.id === parts[3]) {
          continueWaiting(s, String(body.optionId));
          return { ok: true };
        }
        const resolve = pendingPerm.get(`${s.id}:${parts[3]}`);
        if (!resolve) throw httpError(409, '這個權限請求已經失效');
        resolve(String(body.optionId));
        return { ok: true };
      }
      if (sub === 'config') {
        if (body.configId) setMeta(s, { configOptions: (s.meta?.configOptions || []).map((o) => (o.id === body.configId ? { ...o, currentValue: body.value } : o)) });
        return { ok: true };
      }
      if (sub === 'handoff') {
        const ns = createSession({ agentId: body.agentId, cwd: s.cwd, permissionMode: s.permissionMode, title: s.title, titled: true });
        startTurn(ns, `接手先前的工作：${s.title}${body.text ? `\n\n${body.text}` : ''}`);
        return summarize(ns);
      }
      if (sub === 'changes') return changes(s.cwd);
      if (sub === 'files') {
        const rel = q.get('path') || '.';
        const prefix = rel === '.' ? '' : `${rel}/`;
        const seen = new Map();
        for (const p of ws(s.cwd).files.keys()) {
          if (!p.startsWith(prefix)) continue;
          const [name, ...more] = p.slice(prefix.length).split('/');
          seen.set(name, more.length > 0 || seen.get(name) === true);
        }
        return [...seen].map(([name, dir]) => ({ name, path: prefix + name, dir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      }
      if (sub === 'file') {
        const content = ws(s.cwd).files.get(q.get('path'));
        if (content == null) throw httpError(404, '找不到檔案');
        return { path: q.get('path'), size: content.length, content };
      }
    }
    throw httpError(404, `Not found: ${method} ${path}`);
  }

  // A finished conversation already taken over, plus a demo session.
  const seeded = (async () => {
    fast = true;
    const m = machine('laptop');
    const blog = attach(m, m.sessions.find((k) => k.id === 'session_blog'));
    blog.updatedAt = minutes(50);
    const d = createSession({ agentId: 'demo', cwd: `${HOME}/agent-hub-workspaces/2026-10-01-python-hello`, permissionMode: 'bypass', createdAt: minutes(95) });
    await runTurn(d, '寫一個 python hello world 並執行');
    d.permissionMode = 'ask';
    d.updatedAt = minutes(90);
    fast = false;
  })();

  return { handle, subscribe: (fn) => listeners.push(fn) };
})();

// ----------------------------------------- api.js-compatible surface

function setToken() {}
async function api(method, path, body) {
  await new Promise((r) => setTimeout(r, 40));
  return JSON.parse(JSON.stringify((await MOCK.handle(method, path, body)) ?? { ok: true }));
}
const get = (p) => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);
const put = (p, b) => api('PUT', p, b);
const patch = (p, b) => api('PATCH', p, b);
const del = (p) => api('DELETE', p);
function connect(onMessage, onStatus) {
  MOCK.subscribe(onMessage);
  setTimeout(() => onStatus(true), 0);
}
