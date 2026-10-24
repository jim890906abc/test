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
import { createAutoPause, activityOf, timings, isActive } from './autopause.js';
import { createScheduler, scheduleTimings } from './schedule.js';
import { mergeQuota, countsOf } from './quota.js';
import * as claudeAccount from './claude-account.js';
import * as deepseekAccount from './deepseek-account.js';
import * as providers from './providers.js';
import * as github from './github.js';
import * as gdrive from './gdrive.js';
import { localHost, remoteHost } from './adapters/claude-tools.js';
import { parseRepo, validBranch, newBranch } from './adapters/claude-repo.js';

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
// New conversations think as hard as the model allows, unless 設定 says
// otherwise (set once; K3-256k as the model is set when a machine lists it).
store.migrateSettings('effort-max', (d) => {
  if (!d.effort) d.effort = 'max';
});

const app = express();
app.use(express.json({ limit: '80mb' }));

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

const { readSettings } = store;
// The defaults pages see: what 設定 holds, plus the subagent model every new
// conversation starts with ('primary': the main model) and the efforts of
// the subagent models (global, per model alias).
const settingsView = (st = readSettings()) => ({ ...st, defaults: { ...(st.defaults || {}), subagentModel: st.defaults?.subagentModel || 'primary' }, subagentEfforts: providers.subagentEfforts(st) });

app.get('/api/config', wrap(() => ({
  version: '0.3.0',
  workspacesDir: store.WORKSPACES_DIR,
  home: os.homedir(),
  hostname: os.hostname(),
  host: HOST,
  settings: settingsView(),
  claude: claudeAccount.publicAccount(),
  deepseek: deepseekAccount.publicAccount(),
})));

// ------------------------------------------------------------ Claude API

// The Claude Console API key (only ever sent here, never back), and the
// defaults for new Claude conversations.
app.get('/api/claude', wrap(() => claudeAccount.publicAccount()));

app.put('/api/claude', wrap(async (req) => {
  const { apiKey, clearKey, defaults, webTools } = req.body || {};
  if (clearKey) claudeAccount.clearKey();
  else if (typeof apiKey === 'string' && apiKey.trim()) {
    const why = claudeAccount.checkKey(apiKey);
    if (why) throw Object.assign(new Error(why), { status: 400 });
    // Saved only once Anthropic accepts it.
    try {
      await claudeAccount.client(apiKey.trim()).models.list({ limit: 1 });
    } catch (err) {
      throw Object.assign(new Error(claudeAccount.explain(err)), { status: 400 });
    }
    claudeAccount.setKey(apiKey);
  }
  if (defaults || typeof webTools === 'boolean') claudeAccount.setSettings({ defaults, webTools });
  // The key is also Claude's way into the computers' Kimi (a provider there):
  // a new one goes to them, a removed one leaves them.
  if (clearKey || (typeof apiKey === 'string' && apiKey.trim())) providers.refreshAll({ purge: clearKey ? ['claude'] : [] }).catch(() => {});
  const account = claudeAccount.publicAccount();
  broadcast({ t: 'claude', account });
  return account;
}));

app.post('/api/claude/test', wrap(async () => {
  try {
    const models = await claudeAccount.models({ fresh: true });
    providers.refreshAll().catch(() => {});
    return { ok: true, message: `連線成功：這把 API key 可以使用 ${models.length} 個模型`, models };
  } catch (err) {
    return { ok: false, message: claudeAccount.explain(err) };
  }
}));

app.get('/api/claude/models', wrap(async () => ({ defaultModel: claudeAccount.DEFAULT_MODEL, models: await claudeAccount.models() })));

// -------------------------------------------------------------- DeepSeek

// DeepSeek mode runs DeepSeek models inside the Kimi Code of a connected
// computer (server/deepseek-account.js). Here: the gateway keys (only ever
// sent here, never back) and the defaults for new DeepSeek conversations.
app.get('/api/deepseek', wrap(() => deepseekAccount.publicAccount()));

app.put('/api/deepseek', wrap(async (req) => {
  const { gateway: chosen, apiKey, clearKey, defaults } = req.body || {};
  if (chosen !== undefined && !deepseekAccount.isGateway(chosen)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const gw = chosen ?? deepseekAccount.gateway();
  let removed = false;
  if (clearKey) {
    removed = Boolean(deepseekAccount.apiKey(gw));
    deepseekAccount.clearKey(gw);
  } else if (typeof apiKey === 'string' && apiKey.trim()) {
    const why = deepseekAccount.checkKey(apiKey);
    if (why) throw Object.assign(new Error(why), { status: 400 });
    // Saved only once the gateway accepts it (its models list is read with it).
    const r = await deepseekAccount.refreshModels(gw, apiKey.trim());
    deepseekAccount.setKey(gw, apiKey);
    if (r.note) console.warn(`[deepseek] ${r.note}`);
  }
  deepseekAccount.setSettings({ gateway: chosen, defaults });
  // A key removed leaves the computers' Kimi too (it sits in its config there);
  // a new key or gateway goes to them.
  providers.refreshAll({ purge: removed && !deepseekAccount.apiKey() ? ['deepseek'] : [] }).catch(() => {});
  const account = deepseekAccount.publicAccount();
  broadcast({ t: 'deepseek', account });
  return account;
}));

app.post('/api/deepseek/test', wrap(async (req) => {
  const gw = req.body?.gateway ?? deepseekAccount.gateway();
  if (!deepseekAccount.isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const key = deepseekAccount.apiKey(gw);
  if (!key) return { ok: false, message: '這個閘道還沒有設定 API key' };
  try {
    const r = await deepseekAccount.refreshModels(gw, key);
    const models = deepseekAccount.models(gw);
    providers.refreshAll().catch(() => {});
    return { ok: true, message: r.live ? `連線成功：這把 API key 可以使用 ${r.ids.length} 個 DeepSeek 模型` : `金鑰沒有被拒絕。${r.note}`, ...models };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}));

app.get('/api/deepseek/models', wrap((req) => {
  const gw = req.query.gateway ? String(req.query.gateway) : deepseekAccount.gateway();
  if (!deepseekAccount.isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  return deepseekAccount.models(gw);
}));

// Computers whose Kimi has a [secondary_model] (subagents may run on it).
app.get('/api/deepseek/secondary', wrap(async () => deepseekAccount.secondaryModels()));

// Where 設定 defaults are kept: the main model for new conversations (any
// source's alias: a DeepSeek or Claude one is chosen for a conversation when
// it is made, never put on Kimi's global default), thinking, permission, plan
// mode and the subagent model; and `subagentEfforts` ({ alias: effort },
// global: Kimi keeps a subagent's effort per model), sent to every computer.
app.put('/api/settings', wrap((req) => {
  const d = req.body?.defaults || {};
  const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : '');
  const prev = readSettings();
  const defaults = {
    model: str(d.model),
    effort: str(d.effort),
    permission: ['manual', 'yolo', 'auto'].includes(d.permission) ? d.permission : 'manual',
    planMode: Boolean(d.planMode),
    subagentModel: str(d.subagentModel) || prev.defaults?.subagentModel || 'primary',
  };
  const settings = { ...prev, defaults };
  const efforts = req.body?.subagentEfforts ?? d.subagentEfforts;
  if (efforts && typeof efforts === 'object') settings.subagentEfforts = providers.cleanEfforts(efforts);
  store.writeSettings(settings);
  if (JSON.stringify(providers.subagentEfforts(prev)) !== JSON.stringify(providers.subagentEfforts(settings))) providers.refreshAll().catch(() => {});
  return settingsView(settings);
}));

// Every model a new conversation on a computer can start on, by source, and
// whether the computer takes subagent models (see providers.catalog).
app.get('/api/models', wrap((req) => providers.catalog(req.query.machineId ? String(req.query.machineId) : '')));

app.get('/api/fs/dirs', wrap(async (req) => {
  if (req.query.machine) {
    const mid = String(req.query.machine);
    // The bridge lists folders itself (0.4+); older ones through Kimi's server.
    try {
      return { ...(await machines.rpc(mid, 'fs.dirs', { path: req.query.path ? String(req.query.path) : '' })), git: false };
    } catch (err) {
      if (!/未知的操作/.test(err.message)) throw err;
    }
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
    if (!s.kimiSessionId && s.agentId !== 'claude') continue;
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

// What a new conversation on a computer starts with. The main model is any
// source's alias (Kimi's own, `agent-hub-deepseek/…`, `agent-hub-claude/…`);
// one of the last two needs its key. DeepSeek and Claude models think as
// they offer (the model's own default when the thinking asked for is not
// one of theirs). `legacy`: { agent: 'deepseek' } as the old DeepSeek mode
// sent it: the gateway's own model id, and the DeepSeek defaults of 設定.
async function startOptions(body, { legacy = false } = {}) {
  const d = readSettings().defaults || {};
  const ds = legacy ? deepseekAccount.settings().defaults : {};
  const perms = ['manual', 'yolo', 'auto'];
  let model = typeof body.model === 'string' ? body.model.trim() : '';
  if (legacy) model = model ? (deepseekAccount.isDeepseekModel(model) ? model : deepseekAccount.aliasFor(model)) : deepseekAccount.aliasFor(ds.model);
  // The default main model of 設定, when it is one of the hub's own sources
  // and its key is there (Kimi's own is applied with the conversation's
  // defaults).
  const hasKey = { deepseek: () => Boolean(deepseekAccount.apiKey()), claude: () => Boolean(claudeAccount.apiKey()) };
  if (!model && d.model && providers.familyOf(d.model) !== 'kimi' && hasKey[providers.familyOf(d.model)]()) model = d.model;
  const family = providers.familyOf(model);
  let { effort, permission, planMode } = body;
  if (family === 'deepseek') {
    if (!hasKey.deepseek()) throw Object.assign(new Error('還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409 });
    const id = model.slice(providers.PROVIDER_IDS.deepseek.length + 1);
    if (!deepseekAccount.modelIds().includes(id)) throw Object.assign(new Error(`${deepseekAccount.GATEWAYS[deepseekAccount.gateway()].label} 沒有 ${id.slice(0, 60)} 這個模型`), { status: 400 });
  } else if (family === 'claude') {
    if (!hasKey.claude()) throw Object.assign(new Error('還沒有設定 Claude API key。在「設定」→「Claude API…」貼上 Claude Console 的 API key。'), { status: 409 });
    const id = model.slice(providers.PROVIDER_IDS.claude.length + 1);
    if (!(await providers.claudeModelIds()).includes(id)) throw Object.assign(new Error(`Claude 沒有 ${id.slice(0, 60)} 這個模型，或這把 API key 不能用它`), { status: 400 });
  }
  if (family !== 'kimi') {
    const info = providers.hubModelInfo(model);
    effort = info.efforts.includes(effort) ? effort : legacy && info.efforts.includes(ds.effort) ? ds.effort : info.defaultEffort;
  }
  permission = perms.includes(permission) ? permission : legacy ? ds.permission : undefined;
  planMode ??= legacy ? ds.planMode || undefined : undefined;
  // The model of its subagents: asked for, else the default of 設定.
  const asked = typeof body.subagent === 'string' ? body.subagent : body.subagent?.model;
  const subagent = { model: typeof asked === 'string' && asked && asked.length <= 200 ? asked : d.subagentModel || 'primary' };
  return { model: model || undefined, effort, permission, planMode, subagent };
}

// New conversation. On a connected machine ({ machineId, cwd }) the folder is
// a path on that machine: a Kimi conversation there, whatever its model
// ({ model: alias, effort, permission, planMode, subagent: { model: alias |
// 'primary' } }; `agent: 'kimi'` is the same). { agent: 'deepseek', machineId }
// is accepted as before (the old DeepSeek mode). Otherwise a local agent
// ({ agentId }) is used. { agent: 'claude', cwd } starts a conversation in the
// Claude daemon, as before (a folder on this computer, or on `machineId`).
app.post('/api/sessions', wrap(async (req) => {
  const { agentId, machineId, agent, prompt, cwd, permissionMode, images } = req.body || {};
  let { model, effort, permission, planMode } = req.body || {};
  const claude = agent === 'claude' || agentId === 'claude';
  const ds = agent === 'deepseek';
  if (ds && !machineId) throw Object.assign(new Error('DeepSeek 對話在一台電腦的 Kimi 裡執行：請選一台電腦'), { status: 400 });
  const remote = machineId || (!claude && String(agentId || '').startsWith('kimi@'));
  let subagent;
  if (remote && !claude) ({ model, effort, permission, planMode, subagent } = await startOptions(req.body || {}, { legacy: ds }));
  // A Claude conversation bound to a GitHub repository (cloned on its
  // computer, on `branch`: an existing one, or a new one made from the
  // default branch).
  let repo;
  if ((claude || machineId) && req.body?.repo) {
    const full = parseRepo(req.body.repo);
    if (!full) throw Object.assign(new Error('GitHub repo 要寫成 owner/repo（或貼上 GitHub 網址）'), { status: 400 });
    const branch = req.body.branch ? validBranch(req.body.branch) : newBranch();
    if (!branch) throw Object.assign(new Error(`分支名稱不合法：${req.body.branch}`), { status: 400 });
    repo = { full, branch };
  }
  const dir = cwd ? (remote ? String(cwd) : workspace.validateDir(cwd)) : undefined;
  const s = await runner.newSession({
    agentId: claude ? 'claude' : machineId ? `kimi@${machineId}` : agentId,
    machineId: claude ? machineId || undefined : undefined,
    cwd: dir,
    permissionMode,
    nameHint: prompt,
    subagent,
    config: remote || claude ? { model, effort, permission, planMode, ...(repo ? { repo } : {}) } : undefined,
  });
  const files = req.body?.files || [];
  const attached = await saveAttachments(s, files, req.body?.uploadDir);
  if (prompt?.trim() || images?.length || files.length) runner.startTurn(s, `${prompt?.trim() || (files.length ? '請看附件。' : '')}${attached}`, { images });
  return runner.summarize(s);
}));

// A conversation with all its events, as of `seq`. Taken in one go (the
// events are copied, which is quick) and written out in slices, so a big
// one does not hold up the live stream.
const snapshotOf = (s) => ({ ...runner.summarize(s), seq: s.seq || 0, allowedTools: s.allowedTools, events: s.events.map((e) => ({ ...e })) });

const viewed = (s) => {
  if (s.kimiSessionId) kimiRemote.view(s);
  else if (s.agentId === 'claude') ADAPTERS.claude.view(s);
};

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const s = mustSession(req.params.id);
    viewed(s);
    res.type('json').send(await store.jsonInSlices(snapshotOf(s), 'events'));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The page pings while a conversation is open, so it stays followed.
app.post('/api/sessions/:id/viewing', wrap((req) => {
  viewed(mustSession(req.params.id));
}));

app.patch('/api/sessions/:id', wrap((req) => {
  const s = mustSession(req.params.id);
  const { title, permissionMode } = req.body || {};
  if (typeof title === 'string' && title.trim()) {
    s.title = title.trim().slice(0, 120);
    s.titled = true;
    if (s.agentId === 'claude') ADAPTERS.claude.setTitle(s, s.title).catch(() => {});
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

// Files attached to a message (text files: .md, .html, code…): saved in the
// conversation's folder on its computer, and the message says where, so the
// agent reads them with its file tools when it needs them (sent inline they
// would fill the message, and Kimi refuses large ones).
const MAX_ATTACHMENTS = 15;
// `uploadDir`: a folder picked for them (absolute, on that computer); else
// .agent-hub/attachments/<time> in the conversation's folder.
async function saveAttachments(s, files, uploadDir) {
  if (!Array.isArray(files) || !files.length) return '';
  if (files.length > MAX_ATTACHMENTS) throw Object.assign(new Error(`一次最多附 ${MAX_ATTACHMENTS} 個檔案`), { status: 400 });
  if (!s.cwd) throw Object.assign(new Error('這個對話沒有資料夾，沒辦法放附件'), { status: 400 });
  const host = s.machineId ? remoteHost(s.machineId) : localHost;
  const picked = typeof uploadDir === 'string' && uploadDir.trim() ? uploadDir.trim().replace(/\/+$/, '') || '/' : null;
  if (picked && !picked.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(picked)) throw Object.assign(new Error('上傳位置要是完整路徑'), { status: 400 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  // Files are written inside `base`, at `dir/…`.
  const base = picked || s.cwd;
  const dir = picked ? '' : `.agent-hub/attachments/${stamp}`;
  const at = (p) => (dir ? `${dir}/${p}` : p);
  const shown = (p) => (picked ? `${picked === '/' ? '' : picked}/${p}` : at(p));
  // Not part of the project: git (and the backups, the GitHub auto-save) leave them out.
  if (!picked) await host.write(s.cwd, '.agent-hub/.gitignore', '*\n');
  const m = s.machineId && machines.getMachine(s.machineId);
  if (m && files.some((f) => f?.data) && /^0\.[0-6]\./.test(m.bridgeVersion || '0.0.0')) throw Object.assign(new Error(`「${m.name}」的連接器太舊，收不了 .zip：在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試`), { status: 409 });
  const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`);
  const used = new Set();
  const lines = [];
  for (const f of files) {
    // A .zip comes as base64 and is unpacked there; text files as text.
    const zip = Boolean(f?.data);
    const content = zip ? Buffer.from(String(f.data), 'base64') : String(f?.content ?? '');
    const bytes = zip ? content.length : Buffer.byteLength(content);
    if (bytes > (zip ? 20_000_000 : 1_000_000)) throw Object.assign(new Error(`「${f?.name}」超過 ${zip ? '20' : '1'} MB`), { status: 400 });
    let name = String(f?.name || 'file.txt').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').slice(0, 120) || 'file.txt';
    for (let i = 2; used.has(name); i++) name = name.replace(/(\.[^.]*)?$/, (ext) => `-${i}${ext}`);
    used.add(name);
    await host.write(base, at(name), content);
    if (!zip) {
      lines.push(`- ${shown(name)}（${size(bytes)}）`);
      continue;
    }
    let folder = name.replace(/\.zip$/i, '') || 'zip';
    // Picked folder: next to what is there, never into it.
    if (picked) {
      const taken = await host.stat(base, folder).then((x) => x.exists, () => false);
      if (taken) folder = `${folder}-${stamp}`;
    }
    const into = at(folder);
    const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
    // Python's zipfile keeps everything inside the folder (no ../, no absolute paths).
    const r = await host.run(base, [
      `mkdir -p ${q(into)}`,
      `if command -v python3 >/dev/null; then python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' ${q(at(name))} ${q(into)}; else unzip -q -o ${q(at(name))} -d ${q(into)}; fi`,
      `rm -f ${q(at(name))}`,
      `cd ${q(into)} && find . -type f | sed 's|^\\./||' | sort | head -200; echo "AGENT_HUB_FILES=$(find . -type f | wc -l)"`,
    ].join(' && '), { timeoutMs: 120_000 });
    const out = String(r.output || '');
    const count = out.match(/AGENT_HUB_FILES=\s*(\d+)/)?.[1];
    if (r.exitCode !== 0 || count == null) throw Object.assign(new Error(`沒辦法解壓縮「${f.name}」：${out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`), { status: 400 });
    const inside = out.split('\n').filter((l) => l && !l.startsWith('AGENT_HUB_FILES=')).slice(0, 50);
    lines.push(`- ${f.name}（${size(bytes)}）已解壓到 ${shown(folder)}/，共 ${count} 個檔案${Number(count) > inside.length ? `（列出前 ${inside.length} 個）` : ''}：`, ...inside.map((p) => `  - ${shown(folder)}/${p}`));
  }
  return `\n\n[附件] ${files.length} 個已存到${picked ? ` ${picked}` : '工作資料夾'}，需要時用讀檔工具讀取：\n${lines.join('\n')}`;
}

app.post('/api/sessions/:id/messages', wrap(async (req) => {
  const s = mustSession(req.params.id);
  const files = req.body?.files || [];
  const text = String(req.body?.text ?? '');
  const images = (req.body?.images || []).slice(0, 10);
  if (!text.trim() && !images.length && !files.length) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  const note = req.body?.from === 'artifact' ? '從 Artifact 送出' : undefined;
  const attached = await saveAttachments(s, files, req.body?.uploadDir);
  runner.startTurn(s, `${text.trim() || (files.length ? '請看附件。' : '')}${attached}`, { images, note, steer: Boolean(req.body?.steer) });
}));

// An existing Claude conversation bound to a GitHub repository, for good.
app.post('/api/sessions/:id/repo', wrap(async (req) => {
  const s = mustSession(req.params.id);
  const kimi = Boolean(s.kimiSessionId);
  if (s.agentId !== 'claude' && !kimi) throw Object.assign(new Error('只有 Claude 和 Kimi 對話可以綁定 GitHub repo'), { status: 400 });
  const full = parseRepo(req.body?.repo);
  if (!full) throw Object.assign(new Error('GitHub repo 要寫成 owner/repo（或貼上 GitHub 網址）'), { status: 400 });
  const branch = req.body?.branch ? validBranch(req.body.branch) : newBranch();
  if (!branch) throw Object.assign(new Error(`分支名稱不合法：${req.body.branch}`), { status: 400 });
  await (kimi ? ADAPTERS['kimi-remote'] : ADAPTERS.claude).bindRepo(s, { full, branch });
  broadcast({ t: 'session', session: runner.summarize(s) });
  return runner.summarize(s);
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

// 自動暫停: { enabled, threshold } turns it on or off and sets the share of
// the 5-hour quota to pause at; { resumeAfterReset: true, text } sends `text`
// (「繼續」) once the 5-hour quota has reset, for a conversation paused by
// hand; { cancelResume: true } calls off the message waiting to go out.
app.post('/api/sessions/:id/autopause', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId) throw Object.assign(new Error('只有 Kimi 對話可以自動暫停'), { status: 400 });
  const { enabled, threshold, cancelResume, resumeAfterReset, text } = req.body || {};
  // It watches the Kimi subscription's 5-hour quota, which a conversation on
  // a DeepSeek or Claude model does not use: turning it off is all that can
  // be done (it comes back when the model is Kimi's again).
  const family = providers.sessionFamily(s);
  if (family !== 'kimi' && !(cancelResume || enabled === false)) throw Object.assign(new Error(`這個對話現在用的是 ${providers.FAMILY_NAME[family] || '其他'} 的模型，算在 ${providers.billingOf(family)}，不用 Kimi 訂閱，沒有 5 小時額度，不能自動暫停，也不能設定「額度恢復後送出」。要延後送出訊息，請用 /later 30 繼續 或「定時送出…」。`), { status: 400 });
  if (cancelResume) autoPause.cancelResume(s);
  else if (resumeAfterReset) await autoPause.armResume(s, { text });
  else autoPause.configure(s, { enabled, threshold });
  return runner.summarize(s);
}));

// 定時送出: { text, at } (ms) adds a message to send at that time.
app.post('/api/sessions/:id/schedule', wrap((req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId && s.agentId !== 'claude') throw Object.assign(new Error('這個對話不能定時送出'), { status: 400 });
  scheduler.add(s, req.body || {});
  return runner.summarize(s);
}));
app.delete('/api/sessions/:id/schedule/:item', wrap((req) => {
  const s = mustSession(req.params.id);
  scheduler.cancel(s, req.params.item);
  return runner.summarize(s);
}));

// 插隊: slip a queued message into the running turn (Kimi's Ctrl-S).
app.post('/api/sessions/:id/queue/steer-all', wrap((req) => runner.steerAll(mustSession(req.params.id))));
app.post('/api/sessions/:id/queue/:promptId/steer', wrap(async (req) => {
  await runner.steerQueued(mustSession(req.params.id), req.params.promptId);
}));

// 移到背景 (Kimi's Ctrl+B).
app.post('/api/sessions/:id/background', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.kimiSessionId) throw Object.assign(new Error('這個對話不支援移到背景'), { status: 400 });
  return ADAPTERS['kimi-remote'].moveToBackground(s, { interruptSwarm: Boolean(req.body?.interruptSwarm) });
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
// A Claude conversation on a connected computer reads its folder there.
const remoteClaude = (s) => s.agentId === 'claude' && s.machineId;
app.get('/api/sessions/:id/files', wrap((req) => {
  const s = mustSession(req.params.id);
  const rel = String(req.query.path || '.');
  if (remoteClaude(s)) return ADAPTERS.claude.listFiles(s, rel);
  return s.kimiSessionId ? kimiRemote.listFiles(s, rel) : workspace.listDir(s.cwd, rel);
}));
app.get('/api/sessions/:id/file', wrap((req) => {
  const s = mustSession(req.params.id);
  const rel = String(req.query.path || '');
  if (remoteClaude(s)) return ADAPTERS.claude.readFile(s, rel);
  return s.kimiSessionId ? kimiRemote.readFile(s, rel) : workspace.readFile(s.cwd, rel);
}));
app.get('/api/sessions/:id/changes', wrap((req) => {
  const s = mustSession(req.params.id);
  if (remoteClaude(s)) return ADAPTERS.claude.getChanges(s, workspace.summarizeDiff);
  return s.kimiSessionId ? kimiRemote.getChanges(s, workspace.summarizeDiff) : workspace.getChanges(s.cwd);
}));

// ------------------------------------------------------------- machines

app.get('/api/hub', wrap(() => ({ bridgeKey: BRIDGE_KEY, bridgePath: '/bridge/agent-hub-bridge.mjs' })));
// GitHub for the agents, computer by computer: this one (the hub's own,
// where its Claude conversations run) and the connected ones (bridge 0.6+).
// A connected computer that is this one stands for it.
const GITHUB_BRIDGE = /^0\.[0-5]\./;
function githubTarget(target) {
  if (target === 'local') {
    const ops = { status: github.status, login: (a) => github.loginToken(a.token), web: github.loginWeb, cancel: github.cancelWeb, logout: github.logout, repos: github.repos };
    return { call: (op, args) => ops[op](args || {}) };
  }
  const m = machines.getMachine(target);
  if (!m) throw Object.assign(new Error('找不到這台電腦'), { status: 404 });
  if (!m.online) throw Object.assign(new Error(`「${m.name}」目前離線`), { status: 409 });
  if (GITHUB_BRIDGE.test(m.bridgeVersion || '0.0.0')) throw Object.assign(new Error(`「${m.name}」的連接器太舊，在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409 });
  return { call: (op, args) => machines.rpc(target, `github.${op}`, args || {}, op === 'login' || op === 'web' ? 60_000 : 30_000).catch((err) => Promise.reject(machines.tooOld(err, m))) };
}
app.get('/api/github', wrap(async () => {
  const all = machines.listMachines().map((m) => ({ ...m, hostname: machines.getMachine(m.id)?.hostname }));
  const here = os.hostname();
  const computers = [
    ...(all.some((m) => m.online && m.hostname === here) ? [] : [{ id: 'local', name: here, hub: true }]),
    ...all.map((m) => ({ id: m.id, name: m.name, platform: m.platform, online: m.online, hub: m.hostname === here })),
  ];
  return Promise.all(
    computers.map(async (c) => {
      if (c.id !== 'local' && !c.online) return { ...c, offline: true };
      try {
        return { ...c, ...(await githubTarget(c.id).call('status')) };
      } catch (err) {
        return { ...c, error: err.message };
      }
    }),
  );
}));
app.post('/api/github/:target/:action', wrap(async (req) => {
  const { target, action } = req.params;
  if (!['status', 'login', 'web', 'cancel', 'logout', 'repos'].includes(action)) throw Object.assign(new Error('不支援的操作'), { status: 404 });
  return githubTarget(target).call(action, action === 'login' ? { token: String(req.body?.token || '') } : {});
}));

// Google Drive backups (server/gdrive.js), computer by computer like GitHub:
// run through the computer's shell (bridge 0.5+ for a connected one).
function driveHost(target) {
  if (target === 'local') return localHost;
  const m = machines.getMachine(target);
  if (!m) throw Object.assign(new Error('找不到這台電腦'), { status: 404 });
  if (!m.online) throw Object.assign(new Error(`「${m.name}」目前離線`), { status: 409 });
  if (/^0\.[0-4]\./.test(m.bridgeVersion || '0.0.0')) throw Object.assign(new Error(`「${m.name}」的連接器太舊，在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409 });
  return remoteHost(target);
}
app.get('/api/gdrive', wrap(async () => {
  const all = machines.listMachines().map((m) => ({ ...m, hostname: machines.getMachine(m.id)?.hostname }));
  const here = os.hostname();
  const computers = [
    ...(all.some((m) => m.online && m.hostname === here) ? [] : [{ id: 'local', name: here, hub: true }]),
    ...all.map((m) => ({ id: m.id, name: m.name, platform: m.platform, online: m.online, hub: m.hostname === here })),
  ];
  return Promise.all(
    computers.map(async (c) => {
      if (c.id !== 'local' && !c.online) return { ...c, offline: true };
      try {
        return { ...c, ...(await gdrive.status(driveHost(c.id))) };
      } catch (err) {
        return { ...c, error: err.message };
      }
    }),
  );
}));
app.post('/api/gdrive/:target/:action', wrap(async (req) => {
  const host = driveHost(req.params.target);
  const ops = { status: () => gdrive.status(host), web: () => gdrive.loginWeb(host), login: () => gdrive.loginToken(host, req.body?.token), cancel: () => gdrive.cancel(host), logout: () => gdrive.logout(host) };
  if (!ops[req.params.action]) throw Object.assign(new Error('不支援的操作'), { status: 404 });
  return ops[req.params.action]();
}));
// /backup: the conversation's folder to Google Drive, on its computer.
app.post('/api/sessions/:id/backup', wrap(async (req) => {
  const s = mustSession(req.params.id);
  if (!s.cwd) throw Object.assign(new Error('這個對話沒有資料夾'), { status: 400 });
  const kimi = Boolean(s.kimiSessionId);
  if (s.agentId !== 'claude' && !kimi) throw Object.assign(new Error('只有 Claude 和 Kimi 對話可以備份'), { status: 400 });
  const host = s.machineId ? driveHost(s.machineId) : localHost;
  const computer = s.machineId ? machines.getMachine(s.machineId)?.name || s.meta?.machineName : os.hostname();
  const r = await gdrive.backup(host, s.cwd, computer);
  s.lastBackup = r;
  store.saveSession(s);
  broadcast({ t: 'session', session: runner.summarize(s) });
  return r;
}));

app.get('/api/machines', wrap(() => machines.listMachines()));
app.delete('/api/machines/:id', wrap((req) => machines.removeMachine(req.params.id)));
app.post('/api/machines/:id/refresh', wrap((req) => machines.rpc(req.params.id, 'kimi.status')));
app.post('/api/machines/:id/kimi/start', wrap((req) => machines.rpc(req.params.id, 'kimi.start', {}, 40_000)));
// The Kimi account's plan quota and who is logged in on that machine.
app.get('/api/machines/:id/usage', wrap(async (req) => {
  await kimiRemote.ensureServer(req.params.id);
  const [usage, user] = await Promise.all([
    readQuota(req.params.id, { shared: true }).catch((err) => ({ kind: 'error', message: err.message })),
    machines.kimiApi(req.params.id, 'GET', '/api/v1/oauth/userinfo').catch(() => null),
  ]);
  return { usage, user: user?.kind === 'ok' ? user.userInfo : null };
}));

// The plan quota as Kimi reads it, with the counts of the same answer folded
// in (server/quota.js). Pages asking at once share one reading (`shared`);
// auto-pause always reads anew, so a reading is never older than its ask.
const quotaReads = new Map();
function readQuota(mid, { shared = false } = {}) {
  if (shared && quotaReads.has(mid)) return quotaReads.get(mid);
  const p = (async () => {
    await kimiRemote.ensureServer(mid);
    const usage = await machines.kimiApi(mid, 'GET', '/api/v1/oauth/usage', undefined, 20_000);
    if (usage?.kind !== 'ok' || !usage.quota) return usage;
    const u = usage.quota.usages || {};
    const expect = Object.fromEntries(['limit5h', 'limit7d'].filter((k) => u[k]?.resetAt).map((k) => [k, u[k].resetAt]));
    // A bridge older than this does not know it: Kimi's reading as it is.
    const raw = await machines.rpc(mid, 'kimi.usage', { expect }, 15_000).catch(() => null);
    const counts = raw?.ok && Object.keys(countsOf(raw.payload)).length > 0;
    return { ...usage, quota: counts ? mergeQuota(usage.quota, raw.payload) : usage.quota, counts };
  })().finally(() => quotaReads.get(mid) === p && quotaReads.delete(mid));
  quotaReads.set(mid, p);
  return p;
}

// Models the machine's Kimi offers, for the new-conversation screen.
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
// The one-file Claude daemon bridges download to run Claude on their computer.
app.get('/bridge/claude-daemon.mjs', (req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'bridge/claude-daemon.mjs')));
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
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.t === 'watch') watch(ws, typeof m.sid === 'string' ? m.sid : null).catch((err) => console.warn('[ws] watch:', err.message));
    });
    ws.send(JSON.stringify({ t: 'hello' }));
  });
});

// The live stream. A page says which conversation it shows ({ t: 'watch',
// sid }); from then on it gets that conversation's events only, starting
// with a snapshot sent down the same socket, so nothing can fall between
// the snapshot and the stream. Messages are sent in bundles, at most one
// per frame (16 ms). A page that is not keeping up (a slow phone link) is
// sent no more of the stream until it has caught up, then a fresh
// snapshot. Pages that never said what they show (an older page still
// open) get everything, one message at a time, as before.
const STREAM = new Set(['event', 'patch', 'delta', 'reset']);
const BUNDLE_MS = 16;
const BEHIND = 4 * 1024 * 1024; // bytes still waiting to go out, beyond a snapshot
const CAUGHT_UP = 256 * 1024;

function queue(ws, data) {
  ws.out.push(data);
  if (!ws.timer && !ws.holding) ws.timer = setTimeout(() => flushOut(ws), BUNDLE_MS);
}

function flushOut(ws) {
  ws.timer = null;
  if (ws.readyState !== 1 || ws.holding || !ws.out.length) return;
  const out = ws.out;
  ws.out = [];
  const lag = ws.bufferedAmount; // not yet out from earlier sends
  ws.send(out.length === 1 ? out[0] : `{"t":"batch","items":[${out.join(',')}]}`);
  // A snapshot takes a while to go out on a slow link: measure falling
  // behind from what was left right after it, as that drains.
  if (ws.sentSnapshot) {
    ws.sentSnapshot = false;
    ws.base = ws.bufferedAmount;
  } else {
    ws.base = Math.min(ws.base || 0, lag);
    if (lag > ws.base + BEHIND) ws.behind = true;
  }
}

async function watch(ws, sid) {
  ws.watch = sid;
  ws.out ??= [];
  ws.behind = false;
  const token = (ws.watchToken = (ws.watchToken || 0) + 1);
  if (!sid) return;
  const s = store.getSession(sid);
  if (!s) return queue(ws, JSON.stringify({ t: 'snapshot', sid, error: '找不到 session' }));
  viewed(s);
  // Taken now, in order with the stream: what happens while it is being
  // written out is queued behind it.
  const snap = snapshotOf(s);
  ws.holding = (ws.holding || 0) + 1;
  try {
    const body = await store.jsonInSlices(snap, 'events');
    // Only the newest watch counts (pages switch, resync).
    if (ws.watchToken === token) {
      ws.out.unshift(`{"t":"snapshot","sid":${JSON.stringify(sid)},"session":${body}}`);
      ws.sentSnapshot = true;
    }
  } finally {
    ws.holding--;
  }
  if (!ws.holding) flushOut(ws);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  const sid = STREAM.has(msg.t) ? msg.sid : null;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.watch === undefined) {
      ws.send(data);
      continue;
    }
    if (sid) {
      if (ws.watch !== sid) continue;
      if (ws.behind) {
        if (ws.bufferedAmount > CAUGHT_UP) continue;
        // Caught up: start it over from a snapshot.
        watch(ws, sid).catch(() => {});
        continue;
      }
    }
    queue(ws, data);
  }
}
runner.setBroadcast(broadcast);
machines.setBroadcast(broadcast);
// A computer's providers or pool of subagent models changed: pages ask for GET /api/models again.
providers.onChange((machineId) => broadcast({ t: 'models', machineId }));
runner.restoreLiveSessions();

// Auto-pause and 定時送出 run here on the hub, whether or not a browser is open.
const persist = (s, { immediate }) => {
  if (store.getSession(s.id) !== s) return; // deleted meanwhile
  store.saveSession(s, { immediate });
  broadcast({ t: 'session', session: runner.summarize(s) });
};
const autoPause = createAutoPause({
  sessions: () => store.listSessions().filter((s) => s.kimiSessionId && isActive(s.autoPause) && providers.sessionFamily(s) === 'kimi'),
  activity: (s) => activityOf(s, machines.getMachine(s.machineId), kimiRemote.isLive(s)),
  readUsage: (mid) => readQuota(mid),
  send: (s, text, opts) => runner.deliver(s, text, opts),
  cannotSend: (s) => kimiRemote.cannotSend(s),
  changed: persist,
  info: (s, text) => runner.liveContext(s).emit({ type: 'info', text }),
  timings: timings(Number(process.env.AGENT_HUB_AUTOPAUSE_SCALE) || 1),
});
// Status changes are seen as they happen, not only at the next check.
runner.onStatus((s) => isActive(s.autoPause) && autoPause.observe(s));
machines.onSessionChange((mid, entry) => {
  const s = store.getSession(kimiRemote.findByKimi(mid, entry.id));
  if (isActive(s?.autoPause)) autoPause.observe(s);
});
autoPause.start();
// Claude conversations run here, so they are always "online".
const isClaude = (s) => s.agentId === 'claude';
const scheduler = createScheduler({
  sessions: () => store.listSessions().filter((s) => (s.kimiSessionId || isClaude(s)) && s.scheduled?.length),
  online: (s) => isClaude(s) || activityOf(s, machines.getMachine(s.machineId), kimiRemote.isLive(s)).online,
  send: (s, text, opts) => runner.deliver(s, text, opts),
  cannotSend: (s) => (isClaude(s) ? ADAPTERS.claude.cannotSend(s) : kimiRemote.cannotSend(s)),
  changed: persist,
  newId: () => store.newId('q_'),
  timings: scheduleTimings(Number(process.env.AGENT_HUB_AUTOPAUSE_SCALE) || 1),
});
scheduler.start();

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
