// Agent Hub server: REST API for actions, one WebSocket for the live event
// stream, static files for the UI.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as runner from './runner.js';
import * as workspace from './workspace.js';
import { ADAPTERS, TYPE_LABELS } from './adapters/index.js';
import { TEMPLATES } from './adapters/presets.js';
import { disposeAll } from './adapters/acp.js';
import * as machines from './machines.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// Agents can run shell commands (here and on every connected machine), so the
// hub always requires a login token, generated once and kept in data/hub.json.
// Machines connect with a separate bridge key. AGENT_HUB_TOKEN=none turns the
// login off for purely local use.
function loadSecrets() {
  const file = path.join(store.DATA_DIR, 'hub.json');
  let secrets = {};
  try {
    secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  let dirty = false;
  if (!secrets.token) (secrets.token = crypto.randomBytes(16).toString('hex')), (dirty = true);
  if (!secrets.bridgeKey) (secrets.bridgeKey = `bk_${crypto.randomBytes(18).toString('hex')}`), (dirty = true);
  if (dirty) fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}
const SECRETS = loadSecrets();
const TOKEN = process.env.AGENT_HUB_TOKEN === 'none' ? '' : process.env.AGENT_HUB_TOKEN || SECRETS.token;
const BRIDGE_KEY = process.env.AGENT_HUB_BRIDGE_KEY || SECRETS.bridgeKey;

store.loadAgents();
store.loadSessions();

const app = express();
app.use(express.json({ limit: '25mb' }));

function secretEq(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tokenOk = (provided) => !TOKEN || secretEq(provided, TOKEN);

app.use('/api', (req, res, next) => {
  if (tokenOk(req.get('x-hub-token') || req.query.token)) return next();
  res.status(401).json({ error: '需要存取權杖（token）' });
});

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
};

function mustSession(id) {
  const s = store.getSession(id);
  if (!s) throw Object.assign(new Error('找不到 session'), { status: 404 });
  return s;
}

function publicAgent(a) {
  const adapter = ADAPTERS[a.type];
  const availability = adapter ? adapter.available(a) : { ok: false, reason: `未知類型 ${a.type}` };
  const { apiKey, ...rest } = a;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    apiKeyFromEnv: Boolean(a.apiKeyEnv && process.env[a.apiKeyEnv]),
    typeLabel: TYPE_LABELS[a.type] || a.type,
    available: availability.ok,
    reason: availability.reason || '',
    loginCommand: a.type === 'acp' ? a.login || '' : '',
  };
}

const EDITABLE = ['name', 'enabled', 'color', 'command', 'args', 'env', 'login', 'install', 'cliKind', 'model', 'baseUrl', 'apiKeyEnv', 'temperature', 'systemPrompt', 'url', 'description'];

// ------------------------------------------------------------------ meta

// Defaults for new conversations (model, thinking, permission, plan mode),
// kept on the hub so every browser and phone gets the same ones.
const SETTINGS_FILE = path.join(store.DATA_DIR, 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { defaults: {} };
  }
}

app.get('/api/config', wrap(() => ({
  version: '0.3.0',
  workspacesDir: store.WORKSPACES_DIR,
  home: os.homedir(),
  host: HOST,
  settings: readSettings(),
})));

app.put('/api/settings', wrap((req) => {
  const d = req.body?.defaults || {};
  const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : '');
  const defaults = {
    model: str(d.model),
    effort: str(d.effort),
    permission: ['manual', 'yolo', 'auto'].includes(d.permission) ? d.permission : 'manual',
    planMode: Boolean(d.planMode),
  };
  const settings = { ...readSettings(), defaults };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}));

app.get('/api/fs/dirs', wrap(async (req) => {
  if (req.query.machine) {
    const mid = String(req.query.machine);
    let p = req.query.path ? String(req.query.path) : '';
    if (!p) p = (await machines.kimiApi(mid, 'GET', '/api/v1/fs:home')).home;
    const r = await machines.kimiApi(mid, 'GET', `/api/v1/fs:browse?path=${encodeURIComponent(p)}`);
    return { path: r.path, parent: r.parent, git: false, dirs: (r.entries || []).map((e) => e.name).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)) };
  }
  const dir = workspace.validateDir(String(req.query.path || os.homedir()));
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    path: dir,
    parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
    git: await workspace.isGitRepo(dir),
    dirs: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300),
  };
}));

// ---------------------------------------------------------------- agents

app.get('/api/agents', wrap(() => [...store.listAgents(), ...runner.remoteAgents()].map(publicAgent)));
app.get('/api/templates', wrap(() => TEMPLATES.map(({ apiKey, ...t }) => ({ ...t, typeLabel: TYPE_LABELS[t.type] }))));

app.post('/api/agents', wrap((req) => {
  const body = req.body || {};
  const template = TEMPLATES.find((t) => t.id === body.templateId) || {};
  const agent = { ...template, ...body, builtin: false, enabled: body.enabled ?? true };
  delete agent.templateId;
  agent.id = store.getAgent(agent.id) || !agent.id ? `${workspace.slugify(agent.name || template.id, 'agent')}-${store.newId().slice(0, 4)}` : agent.id;
  if (!ADAPTERS[agent.type]) throw Object.assign(new Error(`未知類型 ${agent.type}`), { status: 400 });
  store.upsertAgent(agent);
  broadcast({ t: 'agents' });
  return publicAgent(agent);
}));

app.put('/api/agents/:id', wrap((req) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) throw Object.assign(new Error('找不到 agent'), { status: 404 });
  const body = req.body || {};
  for (const key of EDITABLE) if (key in body) agent[key] = body[key];
  if (typeof body.apiKey === 'string' && body.apiKey !== '••••••••') agent.apiKey = body.apiKey.trim();
  store.upsertAgent(agent);
  broadcast({ t: 'agents' });
  return publicAgent(agent);
}));

app.delete('/api/agents/:id', wrap((req) => {
  store.deleteAgent(req.params.id);
  broadcast({ t: 'agents' });
}));

app.post('/api/agents/:id/test', wrap(async (req) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) throw Object.assign(new Error('找不到 agent'), { status: 404 });
  const adapter = ADAPTERS[agent.type];
  const availability = adapter.available(agent);
  if (!availability.ok) return { ok: false, message: availability.reason };
  try {
    return { ok: true, message: await adapter.test(agent) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}));

// -------------------------------------------------------------- sessions

// Every HTML page Kimi wrote (Write / Edit on *.html) in the conversations
// the hub follows, newest first — the "Artifacts" page.
app.get('/api/artifacts', wrap(() => {
  const out = [];
  for (const s of store.listSessions()) {
    if (!s.kimiSessionId) continue;
    const byPath = new Map();
    for (const ev of s.events || []) {
      if (ev.type !== 'tool_use' || !/^(Write|Edit|MultiEdit|WriteFile|StrReplaceFile)$/.test(ev.name) || ev.status === 'error') continue;
      const p = ev.input?.path || ev.input?.file_path;
      if (!/\.html?$/i.test(p || '')) continue;
      const a = byPath.get(p) || { sessionId: s.id, sessionTitle: s.title, machineId: s.machineId, path: p, versions: 0, title: '' };
      a.versions++;
      a.updatedAt = ev.ts;
      const t = typeof ev.input?.content === 'string' && /<title[^>]*>([^<]*)<\/title>/i.exec(ev.input.content)?.[1]?.trim();
      if (t) a.title = t;
      byPath.set(p, a);
    }
    out.push(...byPath.values());
  }
  return out.map((a) => ({ ...a, title: a.title || a.path.split(/[\\/]/).pop() })).sort((a, b) => b.updatedAt - a.updatedAt);
}));

app.get('/api/sessions', wrap(() =>
  store.listSessions().map(runner.summarize).sort((a, b) => b.updatedAt - a.updatedAt),
));

// New conversation. On a connected machine ({ machineId, cwd }) the folder is
// a path on that machine; otherwise a local agent ({ agentId }) is used.
app.post('/api/sessions', wrap(async (req) => {
  const { agentId, machineId, prompt, cwd, permissionMode, images, model, effort, permission, planMode } = req.body || {};
  const remote = machineId || String(agentId || '').startsWith('kimi@');
  const dir = cwd ? (remote ? String(cwd) : workspace.validateDir(cwd)) : undefined;
  const s = await runner.newSession({
    agentId: machineId ? `kimi@${machineId}` : agentId,
    cwd: dir,
    permissionMode,
    nameHint: prompt,
    config: remote ? { model, effort, permission, planMode } : undefined,
  });
  if (prompt?.trim() || images?.length) runner.startTurn(s, prompt || '', { images });
  return runner.summarize(s);
}));

app.get('/api/sessions/:id', wrap((req) => {
  const s = mustSession(req.params.id);
  if (s.kimiSessionId) kimiRemote.view(s);
  return { ...runner.summarize(s), seq: s.seq || 0, events: s.events, allowedTools: s.allowedTools };
}));

// The page pings while a conversation is open, so it stays followed.
app.post('/api/sessions/:id/viewing', wrap((req) => {
  const s = mustSession(req.params.id);
  if (s.kimiSessionId) kimiRemote.view(s);
}));

app.patch('/api/sessions/:id', wrap((req) => {
  const s = mustSession(req.params.id);
  const { title, permissionMode } = req.body || {};
  if (typeof title === 'string' && title.trim()) {
    s.title = title.trim().slice(0, 120);
    s.titled = true;
  }
  if (['ask', 'auto_edits', 'bypass'].includes(permissionMode)) s.permissionMode = permissionMode;
  store.saveSession(s);
  broadcast({ t: 'session', session: runner.summarize(s) });
  return runner.summarize(s);
}));

app.delete('/api/sessions/:id', wrap((req) => {
  const s = mustSession(req.params.id);
  for (const child of store.listSessions().filter((c) => c.parentId === s.id)) {
    runner.disposeSession(child);
    store.deleteSession(child.id);
    broadcast({ t: 'deleted', sid: child.id });
  }
  runner.disposeSession(s);
  store.deleteSession(s.id);
  broadcast({ t: 'deleted', sid: s.id });
}));

app.post('/api/sessions/:id/messages', wrap((req) => {
  const s = mustSession(req.params.id);
  const text = String(req.body?.text ?? '');
  const images = (req.body?.images || []).slice(0, 10);
  if (!text.trim() && !images.length) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  const note = req.body?.from === 'artifact' ? '從 Artifact 送出' : undefined;
  runner.startTurn(s, text, { images, note, steer: Boolean(req.body?.steer) });
}));

app.post('/api/sessions/:id/command', wrap(async (req) => {
  const name = String(req.body?.name || '').replace(/^\//, '');
  if (!name) throw Object.assign(new Error('缺少指令名稱'), { status: 400 });
  const s = mustSession(req.params.id);
  const r = await runner.command(s, name, String(req.body?.args ?? '').trim());
  if (name === 'archive') {
    runner.disposeSession(s);
    store.deleteSession(s.id);
    broadcast({ t: 'deleted', sid: s.id });
  }
  return r;
}));

app.post('/api/sessions/:id/earlier', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId) return {};
  await ADAPTERS['kimi-remote'].loadEarlier(s);
}));

// 插隊: slip a queued message into the running turn (Kimi's Ctrl-S).
app.post('/api/sessions/:id/queue/:promptId/steer', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId) throw Object.assign(new Error('這個對話不支援插隊'), { status: 400 });
  await ADAPTERS['kimi-remote'].steerQueued(s, req.params.promptId);
}));

app.post('/api/sessions/:id/unlock', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId) throw Object.assign(new Error('這個對話不需要解除'), { status: 400 });
  await ADAPTERS['kimi-remote'].unlock(s);
}));

app.delete('/api/sessions/:id/queue/:promptId', wrap(async (req) => {
  await runner.cancelQueued(mustSession(req.params.id), req.params.promptId);
}));

app.post('/api/sessions/:id/interrupt', wrap(async (req) => {
  await runner.interrupt(mustSession(req.params.id).id);
}));

app.post('/api/sessions/:id/permissions/:eventId', wrap(async (req) => {
  const { optionId, answers, feedback } = req.body || {};
  const ok = await runner.resolvePermission(req.params.id, req.params.eventId, optionId, { answers, feedback });
  if (!ok) throw Object.assign(new Error('這個請求已經處理過了'), { status: 409 });
}));

app.post('/api/sessions/:id/config', wrap(async (req) => {
  await runner.configure(mustSession(req.params.id), req.body || {});
}));

const kimiRemote = ADAPTERS['kimi-remote'];
app.get('/api/sessions/:id/files', wrap((req) => {
  const s = mustSession(req.params.id);
  const rel = String(req.query.path || '.');
  return s.kimiSessionId ? kimiRemote.listFiles(s, rel) : workspace.listDir(s.cwd, rel);
}));
app.get('/api/sessions/:id/file', wrap((req) => {
  const s = mustSession(req.params.id);
  const rel = String(req.query.path || '');
  return s.kimiSessionId ? kimiRemote.readFile(s, rel) : workspace.readFile(s.cwd, rel);
}));
app.get('/api/sessions/:id/changes', wrap((req) => {
  const s = mustSession(req.params.id);
  return s.kimiSessionId ? kimiRemote.getChanges(s, workspace.summarizeDiff) : workspace.getChanges(s.cwd);
}));

// ------------------------------------------------------------- machines

app.get('/api/hub', wrap(() => ({ bridgeKey: BRIDGE_KEY, bridgePath: '/bridge/agent-hub-bridge.mjs' })));
app.get('/api/machines', wrap(() => machines.listMachines()));
app.delete('/api/machines/:id', wrap((req) => machines.removeMachine(req.params.id)));
app.post('/api/machines/:id/refresh', wrap((req) => machines.rpc(req.params.id, 'kimi.status')));
app.post('/api/machines/:id/kimi/start', wrap((req) => machines.rpc(req.params.id, 'kimi.start', {}, 40_000)));
// Models the machine's Kimi offers, for the new-conversation screen.
// The Kimi account's plan quota and who is logged in on that machine.
app.get('/api/machines/:id/usage', wrap(async (req) => {
  await kimiRemote.ensureServer(req.params.id);
  const [usage, user] = await Promise.all([
    machines.kimiApi(req.params.id, 'GET', '/api/v1/oauth/usage').catch((err) => ({ kind: 'error', message: err.message })),
    machines.kimiApi(req.params.id, 'GET', '/api/v1/oauth/userinfo').catch(() => null),
  ]);
  return { usage, user: user?.kind === 'ok' ? user.userInfo : null };
}));

app.get('/api/machines/:id/models', wrap(async (req) => {
  if (!machines.getMachine(req.params.id)?.kimi?.server) return { defaultModel: '', models: [] };
  return kimiRemote.modelsFor(req.params.id);
}));
app.post('/api/machines/:mid/kimi/:kid/attach', wrap(async (req) => runner.summarize(await runner.attachKimi(req.params.mid, req.params.kid))));
// Rename or archive a Kimi conversation straight from the sidebar, followed
// by the hub or not. Kimi has no delete; archiving removes it from its lists.
app.post('/api/machines/:mid/kimi/:kid/:action', wrap(async (req) => {
  const { mid, kid, action } = req.params;
  if (!['title', 'archive'].includes(action)) throw Object.assign(new Error('不支援的操作'), { status: 404 });
  const hubId = kimiRemote.findByKimi(mid, kid);
  const s = hubId ? store.getSession(hubId) : null;
  const entry = machines.getMachine(mid)?.sessions?.find((x) => x.id === kid);
  const terminal = entry?.owner === 'tui';
  if (terminal && action === 'archive') throw Object.assign(new Error('這個對話正在終端機的 Kimi 裡執行。先關掉那個 Kimi，再從這裡刪除'), { status: 409 });
  if (action === 'title') {
    const title = String(req.body?.title || '').trim().slice(0, 120);
    if (!title) throw Object.assign(new Error('標題是空的'), { status: 400 });
    if (terminal) await machines.rpc(mid, 'kimi.tui.input', { sessionId: kid, action: 'command', text: `/title ${title}` });
    else {
      await kimiRemote.ensureServer(mid);
      await machines.kimiApi(mid, 'POST', `/api/v1/sessions/${kid}/profile`, { title });
    }
    if (s) {
      s.title = title;
      s.titled = true;
      store.saveSession(s);
      broadcast({ t: 'session', session: runner.summarize(s) });
    }
    return {};
  }
  await kimiRemote.ensureServer(mid);
  await machines.kimiApi(mid, 'POST', `/api/v1/sessions/${kid}:archive`, {});
  if (s) {
    runner.disposeSession(s);
    store.deleteSession(s.id);
    broadcast({ t: 'deleted', sid: s.id });
  }
  return {};
}));

// ---------------------------------------------------------------- static

const ROOT = store.ROOT_DIR;
app.get('/vendor/marked.esm.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/marked/lib/marked.esm.js')));
app.get('/vendor/purify.es.mjs', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/dompurify/dist/purify.es.mjs')));
// The bridge script holds no secrets; serving it lets machines fetch it with curl.
app.get('/bridge/agent-hub-bridge.mjs', (req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'bridge/agent-hub-bridge.mjs')));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api|ws|vendor|bridge).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

// ------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const bridgeWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/bridge') {
    return bridgeWss.handleUpgrade(req, socket, head, (ws) => {
      if (!secretEq(url.searchParams.get('key'), BRIDGE_KEY)) return ws.close(4401, 'bad key');
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      machines.attachBridge(ws);
    });
  }
  if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.send(JSON.stringify({ t: 'hello' }));
  });
});

// Each delta is pushed immediately — no batching — so the browser sees the
// agent's output with only local-pipe latency.
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}
runner.setBroadcast(broadcast);
machines.setBroadcast(broadcast);
runner.restoreLiveSessions();

setInterval(() => {
  for (const ws of [...wss.clients, ...bridgeWss.clients]) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}/${TOKEN ? `#token=${TOKEN}` : ''}`;
  console.log(`\n  Agent Hub 已啟動 → ${url}`);
  if (TOKEN) console.log(`  登入密碼（token）：${TOKEN}`);
  console.log('  連接其他電腦：在網頁左下角點「連接電腦…」取得指令\n');
});

function shutdown() {
  store.flushAll();
  disposeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
