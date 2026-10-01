// Agent Hub server: REST API for actions, one WebSocket for the live event
// stream, static files for the UI.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as runner from './runner.js';
import * as workspace from './workspace.js';
import { ADAPTERS, TYPE_LABELS } from './adapters/index.js';
import { TEMPLATES } from './adapters/presets.js';
import { splitArgs, loginHint, disposeAll } from './adapters/acp.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// Agents can run shell commands on this machine, so anything reachable from
// the network must be protected by a token.
const TOKEN = process.env.AGENT_HUB_TOKEN || (LOOPBACK ? '' : crypto.randomBytes(16).toString('hex'));

store.loadAgents();
store.loadSessions();

const app = express();
app.use(express.json({ limit: '25mb' }));

function tokenOk(provided) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

app.get('/api/config', wrap(() => ({
  version: '0.1.0',
  workspacesDir: store.WORKSPACES_DIR,
  home: os.homedir(),
  host: HOST,
})));

app.get('/api/fs/dirs', wrap(async (req) => {
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

app.get('/api/agents', wrap(() => store.listAgents().map(publicAgent)));
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

// Runs an agent's own login command (e.g. `kimi login`, a device-code flow)
// and streams its output to the browser, so a subscription account can be
// connected without opening a terminal.
const logins = new Map();
app.post('/api/agents/:id/login', wrap((req) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) throw Object.assign(new Error('找不到 agent'), { status: 404 });
  logins.get(agent.id)?.kill('SIGTERM');
  const [cmd, ...args] = splitArgs(agent.login || loginHint(agent));
  const child = spawn(cmd, args, { env: { ...process.env, ...(agent.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  logins.set(agent.id, child);
  const send = (text) => broadcast({ t: 'login', agentId: agent.id, text });
  send(`$ ${[cmd, ...args].join(' ')}\n`);
  child.stdout.on('data', (d) => send(d.toString('utf8')));
  child.stderr.on('data', (d) => send(d.toString('utf8')));
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    send(`\n${err.code === 'ENOENT' ? `找不到指令 ${cmd}` : err.message}\n`);
    broadcast({ t: 'login_end', agentId: agent.id, code: -1 });
  });
  child.on('close', (code) => {
    if (logins.get(agent.id) === child) logins.delete(agent.id);
    broadcast({ t: 'login_end', agentId: agent.id, code });
  });
  return { ok: true };
}));
app.post('/api/agents/:id/login/input', wrap((req) => {
  const child = logins.get(req.params.id);
  if (!child) throw Object.assign(new Error('登入程序未在執行'), { status: 409 });
  child.stdin.write(`${req.body?.text ?? ''}\n`);
}));
app.post('/api/agents/:id/login/cancel', wrap((req) => {
  logins.get(req.params.id)?.kill('SIGTERM');
}));

// -------------------------------------------------------------- sessions

app.get('/api/sessions', wrap(() =>
  store.listSessions().map(runner.summarize).sort((a, b) => b.updatedAt - a.updatedAt),
));

app.post('/api/sessions', wrap(async (req) => {
  const { agentId, prompt, cwd, permissionMode, images } = req.body || {};
  const dir = cwd ? workspace.validateDir(cwd) : undefined;
  const s = await runner.newSession({ agentId, cwd: dir, permissionMode, nameHint: prompt });
  if (prompt?.trim() || images?.length) runner.startTurn(s, prompt || '', { images });
  return runner.summarize(s);
}));

app.get('/api/sessions/:id', wrap((req) => {
  const s = mustSession(req.params.id);
  return { ...runner.summarize(s), seq: s.seq || 0, events: s.events, allowedTools: s.allowedTools, handoffFrom: s.handoffFrom };
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
  const images = req.body?.images || [];
  if (!text.trim() && !images.length) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  runner.startTurn(s, text, { images });
}));

app.post('/api/sessions/:id/interrupt', wrap((req) => {
  runner.interrupt(mustSession(req.params.id).id);
}));

app.post('/api/sessions/:id/permissions/:eventId', wrap((req) => {
  const ok = runner.resolvePermission(req.params.id, req.params.eventId, req.body?.optionId);
  if (!ok) throw Object.assign(new Error('這個權限請求已經失效'), { status: 409 });
}));

app.post('/api/sessions/:id/config', wrap(async (req) => {
  await runner.configure(mustSession(req.params.id), req.body || {});
}));

app.post('/api/sessions/:id/handoff', wrap(async (req) => {
  const s = mustSession(req.params.id);
  return runner.summarize(await runner.handoff(s, req.body || {}));
}));

app.get('/api/sessions/:id/files', wrap((req) => workspace.listDir(mustSession(req.params.id).cwd, String(req.query.path || '.'))));
app.get('/api/sessions/:id/file', wrap((req) => workspace.readFile(mustSession(req.params.id).cwd, String(req.query.path || ''))));
app.get('/api/sessions/:id/changes', wrap((req) => workspace.getChanges(mustSession(req.params.id).cwd)));

// ----------------------------------------------------------- compare mode

app.post('/api/compare', wrap(async (req) => {
  const { agentIds, prompt, cwd, permissionMode } = req.body || {};
  if (!prompt?.trim()) throw Object.assign(new Error('請輸入提示詞'), { status: 400 });
  return runner.newCompareGroup({ agentIds, prompt, cwd: cwd ? workspace.validateDir(cwd) : undefined, permissionMode });
}));

app.post('/api/groups/:gid/messages', wrap((req) => {
  const text = String(req.body?.text ?? '');
  if (!text.trim()) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  const sessions = store.listSessions().filter((s) => s.groupId === req.params.gid);
  let sent = 0;
  for (const s of sessions) {
    if (runner.isRunning(s.id)) continue;
    runner.startTurn(s, text);
    sent++;
  }
  return { sent };
}));

// ---------------------------------------------------------------- static

const ROOT = store.ROOT_DIR;
app.get('/vendor/marked.esm.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/marked/lib/marked.esm.js')));
app.get('/vendor/purify.es.mjs', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/dompurify/dist/purify.es.mjs')));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api|ws|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

// ------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
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

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}/${TOKEN ? `#token=${TOKEN}` : ''}`;
  console.log(`\n  Agent Hub 已啟動 → ${url}\n`);
  if (!LOOPBACK && !process.env.AGENT_HUB_TOKEN) console.log('  （對外開放模式：已自動產生存取權杖，請使用上面的完整網址）\n');
});

function shutdown() {
  store.flushAll();
  disposeAll();
  for (const child of logins.values()) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
