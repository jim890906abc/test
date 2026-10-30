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
import * as clusters from './cluster.js';
import * as clusterPurge from './cluster-purge.js';
import * as clusterTrash from './cluster-trash.js';
import * as sessionList from './session-list.js';
import * as pagePush from './page-push.js';
import * as workspace from './workspace.js';
import { ADAPTERS, TYPE_LABELS } from './adapters/index.js';
import { TEMPLATES } from './adapters/presets.js';
import { disposeAll } from './adapters/acp.js';
import * as machines from './machines.js';
import * as subagentBroker from './subagent-broker.js';
import { registerSecretSource } from './redact.js';
import { createAutoPause, activityOf, timings, isActive } from './autopause.js';
import { createKeyRecover } from './key-recover.js';
import { createScheduler, scheduleTimings } from './schedule.js';
import { mergeQuota, countsOf } from './quota.js';
import * as claudeAccount from './claude-account.js';
import * as deepseekAccount from './deepseek-account.js';
import * as timing from './timing.js';
import * as github from './github.js';
import * as gdrive from './gdrive.js';
import { localHost, remoteHost } from './adapters/claude-tools.js';
import { parseRepo, validBranch, newBranch } from './adapters/claude-repo.js';
import * as snapshotWindow from './snapshot-window.js';
import { artifactOf, artifactIndex, replayVersion } from './artifacts.js';
import { compressResponses } from './http-compress.js';
import { loadSecrets } from './secrets.js';
import { isLoopbackHost, parseAllowedOrigins, originAllowed, jsonBody, errorHandler, notFound, securityHeaders, inlineScriptHashes, loosePermissionsWarning } from './hardening.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// Agents can run shell commands (here and on every connected machine), so the
// hub always requires a login token, generated once and kept in data/hub.json.
// Machines connect with a separate bridge key. AGENT_HUB_TOKEN=none turns the
// login off for purely local use.
let SECRETS;
try {
  SECRETS = loadSecrets(store.DATA_DIR);
} catch (err) {
  // Said plainly, once: not a stack trace.
  console.error(`[hub] ${err.message}`);
  process.exit(1);
}
const TOKEN = process.env.AGENT_HUB_TOKEN === 'none' ? '' : process.env.AGENT_HUB_TOKEN || SECRETS.token;
const BRIDGE_KEY = process.env.AGENT_HUB_BRIDGE_KEY || SECRETS.bridgeKey;
// No login (AGENT_HUB_TOKEN=none) is for this computer alone: anyone who can
// reach the Hub without one can run commands and read files on every computer
// connected to it. So it does not start on an address others can reach (a
// public tunnel, a container, 0.0.0.0), and says so loudly even on this one.
if (!TOKEN && !isLoopbackHost(HOST)) {
  console.error(
    `\n  ✗ 不能啟動：AGENT_HUB_TOKEN=none 關掉了登入，但 HOST=${HOST} 不是只有這台電腦連得到的位址（127.0.0.1、::1、localhost）。\n` +
      '    沒有登入的 Hub，任何連得到它的人都能在你的電腦上執行指令、讀寫檔案。\n' +
      '    請擇一：拿掉 AGENT_HUB_TOKEN=none（Hub 會自己產生登入密碼），或把 HOST 設成 127.0.0.1。\n',
  );
  process.exit(1);
}
if (!TOKEN) console.warn('\n  ⚠ 警告：AGENT_HUB_TOKEN=none，登入已關閉：這台電腦上的任何程式與網頁都能使用這個 Hub（含執行指令）。只限純本機使用，絕對不要搭配公網通道。\n');
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.AGENT_HUB_ALLOWED_ORIGINS);
// Every secret value the Hub holds is masked wherever text could carry it out
// (live events, hand-offs): its login token, the bridge key, the Claude key
// and every DeepSeek pool key. Asked on each use, so a key saved a moment ago
// is already covered.
registerSecretSource(() => [
  TOKEN,
  BRIDGE_KEY,
  claudeAccount.apiKey(),
  ...Object.keys(deepseekAccount.GATEWAYS).flatMap((gw) => (deepseekAccount.poolOf(gw)?.keys || []).map((k) => k.key)),
]);

const looseData = loosePermissionsWarning(store.DATA_DIR);
if (looseData) console.warn(looseData);

store.loadAgents();
store.loadSessions();
// New conversations think as hard as the model allows, unless 設定 says
// otherwise (set once; K3-256k as the model is set when a machine lists it).
store.migrateSettings('effort-max', (d) => {
  if (!d.effort) d.effort = 'max';
});

const app = express();
app.disable('x-powered-by');
const STRICT_CSP = process.env.AGENT_HUB_CSP === 'strict';
app.use(securityHeaders({ strict: STRICT_CSP, scriptHashes: STRICT_CSP ? inlineScriptHashes(fs.readFileSync(path.join(store.ROOT_DIR, 'public', 'index.html'), 'utf8')) : [] }));

function secretEq(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tokenOk = (provided) => !TOKEN || secretEq(provided, TOKEN);

// The login comes before anything is read of a request: a client without the
// token is turned away without its body being parsed (or inflated) at all.
// Only the header counts on a REST route; a WebSocket upgrade cannot carry
// one, so /ws takes the token in its query (below).
app.use('/api', (req, res, next) => {
  if (!tokenOk(req.get('x-hub-token'))) return res.status(401).json({ error: '需要存取權杖（token）' });
  // Without a login nothing proves a request is the user's own, so a page on
  // another site may not make this computer's browser send one.
  if (!TOKEN && !originAllowed(req, ALLOWED_ORIGINS)) return res.status(403).json({ error: '不允許從其他網站來的請求' });
  next();
});
app.use('/api', jsonBody());
// Big JSON answers (a conversation, the list) are gzipped for clients that accept it.
app.use('/api', compressResponses());

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
};

// A conversation is a continuation chain; only its leaf is a live runtime.
// Every /api/sessions/:id/... request is resolved to that leaf once, here
// (see the middleware below), so an old node's URL, still held by a browser
// tab or a link, acts on the conversation and never on a dead node.
// `leafOf(req)` is the session a handler works on; `nodeOf(req)` is the node
// the URL named, for the few things that are about the node itself.
const leafOf = (req) => req.hub.leaf;
const nodeOf = (req) => req.hub.node;

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

app.get('/api/config', wrap(() => ({
  version: '0.3.0',
  workspacesDir: store.WORKSPACES_DIR,
  home: os.homedir(),
  hostname: os.hostname(),
  host: HOST,
  settings: readSettings(),
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
  const account = claudeAccount.publicAccount();
  broadcast({ t: 'claude', account });
  return account;
}));

app.post('/api/claude/test', wrap(async () => {
  try {
    const models = await claudeAccount.models({ fresh: true });
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

const DEEPSEEK_PUT_FIELDS = new Set(['gateway', 'keyGateway', 'apiKey', 'clearKey', 'activateKeyId', 'removeKeyId', 'retryKeyId', 'markFullKeyId', 'clearMarkKeyId', 'moveKeyId', 'direction', 'distribution', 'defaults', 'autoResume']);
const DEEPSEEK_TEST_FIELDS = new Set(['gateway', 'keyId']);

function deepseekBody(req, allowed) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) throw Object.assign(new Error(`不支援的欄位：${unknown.join('、')}`), { status: 400 });
  return body;
}

// The keys are one list used in one order across gateways. `apiKey` adds a key
// (to `keyGateway`, else `gateway`, else the gateway in use; only `gateway`
// changes which gateway's model names conversations use), the *KeyId fields act
// on one key by its id (whatever gateway it is on), `markFullKeyId` and
// `clearMarkKeyId` are a person saying a key is full / is fine, `moveKeyId`
// moves a key in the order (`direction`: up, down or top), and `clearKey`
// removes a whole gateway's keys, and `distribution` ('sticky' or 'relay') chooses
// how the keys are given out: each conversation keeps one key, or every
// conversation uses the key in use until it runs out. Exactly one operation per
// request keeps the revision and the computers in step.
app.put('/api/deepseek', wrap(async (req) => {
  const body = deepseekBody(req, DEEPSEEK_PUT_FIELDS);
  const { gateway: chosen, keyGateway, apiKey, clearKey, activateKeyId, removeKeyId, retryKeyId, markFullKeyId, clearMarkKeyId, moveKeyId, direction, distribution, defaults, autoResume } = body;
  if (chosen !== undefined && !deepseekAccount.isGateway(chosen)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  if (keyGateway !== undefined && !deepseekAccount.isGateway(keyGateway)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const gw = keyGateway ?? chosen ?? deepseekAccount.gateway();
  const byId = [['activateKeyId', activateKeyId], ['removeKeyId', removeKeyId], ['retryKeyId', retryKeyId], ['markFullKeyId', markFullKeyId], ['clearMarkKeyId', clearMarkKeyId], ['moveKeyId', moveKeyId]];
  for (const [name, id] of byId) {
    if (id !== undefined && (typeof id !== 'string' || !id)) throw Object.assign(new Error(`${name} 要是 API key 的 id`), { status: 400 });
  }
  if (apiKey !== undefined && typeof apiKey !== 'string') throw Object.assign(new Error('apiKey 要是字串'), { status: 400 });
  if (direction !== undefined && moveKeyId === undefined) throw Object.assign(new Error('direction 要搭配 moveKeyId'), { status: 400 });
  const ops = [
    typeof apiKey === 'string' && apiKey.trim() ? 'apiKey' : '',
    ...byId.filter(([, id]) => id !== undefined).map(([name]) => name),
    clearKey ? 'clearKey' : '',
    distribution !== undefined ? 'distribution' : '',
  ].filter(Boolean);
  if (ops.length > 1) throw Object.assign(new Error('一次只能新增、啟用、移除、重新啟用、標記、移動、清除一組 key，或切換分配方式'), { status: 400 });
  // A key is named by its id, which is one across gateways.
  const ownerOf = (id) => deepseekAccount.gatewayOfKey(id) || gw;

  const beforeGateway = deepseekAccount.gateway();
  if (ops[0] === 'apiKey') {
    const why = deepseekAccount.checkKey(apiKey);
    if (why) throw Object.assign(new Error(why), { status: 400 });
    // Saved only once the gateway accepts it (its models list is read with it).
    const r = await deepseekAccount.refreshModels(gw, apiKey.trim());
    deepseekAccount.setKey(gw, apiKey);
    if (r.note) console.warn(`[deepseek] ${r.note}`);
  } else if (ops[0] === 'activateKeyId') deepseekAccount.activateKey(ownerOf(activateKeyId), activateKeyId);
  else if (ops[0] === 'removeKeyId') deepseekAccount.removeKey(ownerOf(removeKeyId), removeKeyId);
  else if (ops[0] === 'retryKeyId') await deepseekAccount.retryKey(ownerOf(retryKeyId), retryKeyId);
  else if (ops[0] === 'markFullKeyId') deepseekAccount.markFull(markFullKeyId);
  else if (ops[0] === 'clearMarkKeyId') deepseekAccount.clearMark(clearMarkKeyId);
  else if (ops[0] === 'moveKeyId') deepseekAccount.moveKey(moveKeyId, direction ?? 'up');
  else if (ops[0] === 'clearKey') deepseekAccount.clearKey(gw);
  else if (ops[0] === 'distribution') deepseekAccount.setDistribution(distribution);
  deepseekAccount.setSettings({ gateway: chosen, defaults, autoResume });
  // (A key came back, or the automatic 「繼續」 was turned on: conversations waiting for it are looked at now.)
  keyRecover.evaluate();

  // Every online Kimi gets the key/pool for native DeepSeek subagents; with
  // no key left for the gateway in use, the provider is taken off them.
  if (!deepseekAccount.apiKey()) deepseekAccount.removeProviders().catch(() => {});
  else if (ops.length || chosen !== undefined && chosen !== beforeGateway) {
    deepseekAccount.reprovision().then((ids) => ids.forEach((id) => kimiRemote.forgetModels(id))).catch(() => {});
  }
  const account = deepseekAccount.publicAccount();
  broadcast({ t: 'deepseek', account });
  return account;
}));

app.post('/api/deepseek/test', wrap(async (req) => {
  const body = deepseekBody(req, DEEPSEEK_TEST_FIELDS);
  if (body.keyId !== undefined && (typeof body.keyId !== 'string' || !body.keyId)) throw Object.assign(new Error('keyId 要是 API key 的 id'), { status: 400 });
  // A key is named by its id, which is one across gateways: its own gateway wins.
  const gw = (body.keyId && deepseekAccount.gatewayOfKey(body.keyId)) || body.gateway || deepseekAccount.gateway();
  if (!deepseekAccount.isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const chosen = body.keyId ? deepseekAccount.keyById(gw, body.keyId) : null;
  if (body.keyId && !chosen) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  const key = chosen?.key || (!body.keyId ? deepseekAccount.apiKey(gw) : '');
  if (!key) return { ok: false, message: '這個閘道還沒有設定 API key' };
  try {
    const r = await deepseekAccount.refreshModels(gw, key);
    const models = deepseekAccount.models(gw);
    return { ok: true, message: r.live ? `連線成功：這把 API key 可以使用 ${r.ids.length} 個 DeepSeek 模型` : `金鑰沒有被拒絕。${r.note}`, ...models };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}));

// How long things took (server/timing.js): only measured times, null with the
// reason where none could be. Per key: requests, the most at once, 429s, time to
// the first byte, tokens per second. The concurrency measure costs real
// requests on a real key, so it is only for a person who was told how many
// (`confirmedRequests` is the total of `levels`); the key never leaves the
// computer whose connector does it.
app.get('/api/deepseek/keys/timing', wrap(() => timing.keysTiming()));
app.post('/api/deepseek/keys/:keyId/measure', wrap((req) => {
  const body = deepseekBody(req, new Set(['levels', 'confirmedRequests', 'machineId']));
  return timing.measureKey({ keyId: req.params.keyId, levels: body.levels, confirmedRequests: body.confirmedRequests, machineId: body.machineId });
}));

app.get('/api/deepseek/models', wrap((req) => {
  const gw = req.query.gateway ? String(req.query.gateway) : deepseekAccount.gateway();
  if (!deepseekAccount.isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  return deepseekAccount.models(gw);
}));

// Computers whose Kimi has a [secondary_model] (subagents may run on it).
app.get('/api/deepseek/secondary', wrap(async () => deepseekAccount.secondaryModels()));

const SETTINGS_PROVIDERS = ['kimi', 'claude', 'deepseek'];
const PERMISSIONS_FOR = { kimi: ['manual', 'yolo', 'auto'], deepseek: ['manual', 'yolo', 'auto'], claude: ['manual', 'edits', 'auto'] };
const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : '');

function defaultsByProvider(raw = {}) {
  const by = raw.byProvider && typeof raw.byProvider === 'object' ? raw.byProvider : {};
  const out = {};
  for (const p of SETTINGS_PROVIDERS) {
    const old = by[p] && typeof by[p] === 'object' ? by[p] : {};
    const legacyKimi = p === 'kimi' ? raw : {};
    out[p] = {
      model: str(old.model ?? legacyKimi.model),
      effort: str(old.effort ?? legacyKimi.effort),
      permission: PERMISSIONS_FOR[p].includes(old.permission ?? legacyKimi.permission) ? old.permission ?? legacyKimi.permission : 'manual',
      planMode: Boolean(old.planMode ?? legacyKimi.planMode),
    };
  }
  return out;
}

async function validateSettingsProvider(provider, value, groups) {
  const group = groups.find((g) => g.provider === provider);
  const permission = PERMISSIONS_FOR[provider].includes(value.permission) ? value.permission : 'manual';
  let model = str(value.model);
  let effort = str(value.effort);
  if (!group?.available) {
    // Without a machine/key the catalog cannot be checked. Old Kimi settings
    // still save; another provider's model is not accepted without a catalog.
    if (provider !== 'kimi' && model) throw Object.assign(new Error(`「${group?.label || provider}」目前不可用，不能儲存它的預設模型`), { status: 409 });
    return { model, effort, permission, planMode: Boolean(value.planMode) };
  }
  const hit = group.models.find((m) => m.id === model || m.alias === model);
  if (model && !hit) throw Object.assign(new Error(`${group.label} 沒有 ${model} 這個模型`), { status: 400 });
  if (!model) model = group.defaultModel || group.models[0]?.id || '';
  const chosen = group.models.find((m) => m.id === model || m.alias === model);
  if (!chosen) throw Object.assign(new Error(`${group.label} 沒有可用的預設模型`), { status: 400 });
  model = chosen.id;
  if (effort && !(chosen.efforts || []).includes(effort)) throw Object.assign(new Error(`${chosen.name || model} 不支援思考強度「${effort}」`), { status: 400 });
  if (!effort) effort = chosen.defaultEffort || '';
  return { model, effort, permission, planMode: Boolean(value.planMode) };
}

app.put('/api/settings', wrap(async (req) => {
  const d = req.body?.defaults || {};
  const current = readSettings().defaults || {};
  const by = defaultsByProvider(current);
  const provider = SETTINGS_PROVIDERS.includes(d.provider) ? d.provider : SETTINGS_PROVIDERS.includes(current.provider) ? current.provider : 'kimi';
  const groups = (await runner.providerGroups({ machineId: d.machineId ? String(d.machineId) : null })).groups;

  // A full byProvider patch is the explicit contract for all three.
  if (d.byProvider && typeof d.byProvider === 'object') {
    for (const p of SETTINGS_PROVIDERS) {
      const patch = d.byProvider[p];
      if (!patch || typeof patch !== 'object') continue;
      const merged = { ...by[p], ...patch };
      if (p === 'kimi' && deepseekAccount.isDeepseekModel(merged.model)) {
        by.kimi = { ...merged, model: '' };
        continue;
      }
      by[p] = await validateSettingsProvider(p, merged, groups);
    }
  }

  const hasTop = ['model', 'effort', 'permission', 'planMode'].some((k) => d[k] !== undefined);
  if (hasTop) {
    const target = d.provider === undefined ? 'kimi' : provider;
    const candidate = { ...by[target], ...(d.model !== undefined ? { model: d.model } : {}), ...(d.effort !== undefined ? { effort: d.effort } : {}), ...(d.permission !== undefined ? { permission: d.permission } : {}), ...(d.planMode !== undefined ? { planMode: d.planMode } : {}) };
    if (d.model === undefined && d.effort === undefined) {
      // Permission/plan-only saves must not re-validate an unchanged model
      // against a catalog that changed since it was saved.
      by[target] = { ...by[target], permission: PERMISSIONS_FOR[target].includes(d.permission) ? d.permission : by[target].permission, ...(d.planMode !== undefined ? { planMode: Boolean(d.planMode) } : {}) };
    } else if (target === 'kimi' && deepseekAccount.isDeepseekModel(candidate.model)) {
      by.kimi = { ...candidate, model: '' };
      // Continue with the legacy fields but never validate a DeepSeek alias
      // against Kimi's catalog.
    } else try {
      by[target] = await validateSettingsProvider(target, candidate, groups);
    } catch (err) {
      // Older UIs send the legacy Kimi model/effort with a new provider. Do
      // not let that overwrite the selected provider's defaults; any other
      // invalid explicit value still fails.
      if (target !== 'kimi' && d.model === by.kimi.model) {
        // Keep the existing byProvider[target].
      } else throw err;
    }
  }

  // Legacy top-level fields stay Kimi only. A DeepSeek alias must never leak
  // into the Kimi default (or into kimi-remote's settings migration).
  if (deepseekAccount.isDeepseekModel(by.kimi.model)) by.kimi.model = '';
  const defaults = {
    ...by.kimi,
    provider,
    byProvider: by,
  };
  const settings = { ...readSettings(), defaults };
  store.writeSettings(settings, { explicit: true });
  return settings;
}));

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

// Unified model catalog: Kimi, Claude and DeepSeek in one answer, with the
// real effort lists and explicit availability/reasons. Never includes keys.
app.get('/api/models', wrap(async (req) => {
  const found = req.query.session ? store.getSession(String(req.query.session)) : null;
  if (req.query.session && !found) throw Object.assign(new Error('找不到 session'), { status: 404 });
  const session = found ? store.leafOf(found) : null;
  return runner.providerGroups({ session, machineId: req.query.machine ? String(req.query.machine) : null });
}));

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
      if (ev.status === 'error') continue;
      const art = artifactOf(ev);
      if (!art) continue;
      const p = art.path;
      const a = byPath.get(p) || { sessionId: s.id, sessionTitle: s.title, machineId: s.machineId, path: p, versions: 0, title: '' };
      a.versions++;
      a.updatedAt = ev.ts;
      const t = typeof art.content === 'string' && /<title[^>]*>([^<]*)<\/title>/i.exec(art.content)?.[1]?.trim();
      if (t) a.title = t;
      byPath.set(p, a);
    }
    out.push(...byPath.values());
  }
  return out.map((a) => ({ ...a, title: a.title || a.path.split(/[\\/]/).pop() })).sort((a, b) => b.updatedAt - a.updatedAt);
}));

app.use('/api/sessions/:id', (req, res, next) => {
  const node = store.getSession(req.params.id);
  if (!node) return res.status(404).json({ error: '找不到 session' });
  req.hub = { node, leaf: store.leafOf(node) || node };
  next();
});

// `?for=sidebar`: what the sidebar lists (server/session-list.js) - the summaries
// without the model/skill lists, and each cluster worker as a stub (`stub: true`).
// Without it, every conversation whole, as always.
app.get('/api/sessions', wrap((req) =>
  req.query.for === 'sidebar'
    ? sessionList.sidebarSessions()
    : store
      .listLeaves()
      .map(runner.summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt),
));

// Conversation files that were damaged on disk: the ones repaired and loaded
// (salvaged: true, see also meta.salvaged on the conversation) and the ones
// that could not be loaded at all (salvaged: false). Each original is kept
// untouched under data/sessions-damaged/ (`backup`).
app.get('/api/damaged-sessions', wrap(() => store.listDamaged()));

// New conversation. On a connected machine ({ machineId, cwd }) the folder is
// a path on that machine; otherwise a local agent ({ agentId }) is used.
// { agent: 'claude', cwd } starts a Claude API conversation in a folder on
// this computer.
app.post('/api/sessions', wrap(async (req) => {
  const { agentId, machineId, agent, prompt, cwd, permissionMode, images, provider, subagent } = req.body || {};
  let { model, effort, permission, planMode } = req.body || {};
  const unified = ['kimi', 'claude', 'deepseek'].includes(provider);
  if (provider !== undefined && !unified) throw Object.assign(new Error('供應商必須是 Kimi、Claude 或 DeepSeek'), { status: 400 });
  const claude = unified ? provider === 'claude' : agent === 'claude' || agentId === 'claude';
  // { agent: 'deepseek', machineId, … }: a Kimi conversation on that computer
  // that runs a DeepSeek model of the gateway in use.
  const ds = unified ? provider === 'deepseek' : agent === 'deepseek';
  if (unified && ds) {
    if (!machineId) throw Object.assign(new Error('DeepSeek 對話在一台電腦的 Kimi 裡執行：請選一台電腦'), { status: 400 });
    if (!deepseekAccount.apiKey()) throw Object.assign(new Error(deepseekAccount.keyProblem() || '還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409 });
    const d = deepseekAccount.settings().defaults;
    model ||= d.model;
    effort = deepseekAccount.EFFORTS.includes(effort) ? effort : d.effort;
    permission = ['manual', 'yolo', 'auto'].includes(permission) ? permission : d.permission;
    planMode ??= d.planMode || undefined;
  }
  if (ds && !unified) {
    if (!machineId) throw Object.assign(new Error('DeepSeek 對話在一台電腦的 Kimi 裡執行：請選一台電腦'), { status: 400 });
    if (!deepseekAccount.apiKey()) throw Object.assign(new Error(deepseekAccount.keyProblem() || '還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409 });
    const d = deepseekAccount.settings().defaults;
    const ids = deepseekAccount.modelIds();
    if (model && !ids.includes(model)) throw Object.assign(new Error(`${deepseekAccount.GATEWAYS[deepseekAccount.gateway()].label} 沒有 ${String(model).slice(0, 60)} 這個模型`), { status: 400 });
    model = deepseekAccount.aliasFor(model || d.model);
    effort = deepseekAccount.EFFORTS.includes(effort) ? effort : d.effort;
    permission = ['manual', 'yolo', 'auto'].includes(permission) ? permission : d.permission;
    planMode ??= d.planMode || undefined;
  }
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
  const remote = unified ? provider !== 'claude' || Boolean(machineId) : machineId || (!claude && String(agentId || '').startsWith('kimi@'));
  const dir = cwd ? (remote ? String(cwd) : workspace.validateDir(cwd)) : undefined;
  const targetProvider = unified ? provider : ds ? 'deepseek' : claude ? 'claude' : 'kimi';
  if (subagent && targetProvider !== 'claude') {
    if (!machineId) throw Object.assign(new Error('子代理預設需要一台已連接的電腦與其 Kimi broker'), { status: 409 });
    if (!subagentBroker.supportsBroker(machineId)) throw Object.assign(new Error(`「${machines.getMachine(machineId)?.name || machineId}」的連接器太舊，沒有子代理 broker。在那台電腦重新執行連接指令（左下角「連接電腦…」）更新後再設定子代理。`), { status: 409, code: 'broker_old' });
  }
  const s = await runner.newSession({
    agentId: unified ? (provider === 'claude' ? 'claude' : `kimi@${machineId}`) : claude ? 'claude' : machineId ? `kimi@${machineId}` : agentId,
    machineId: machineId || undefined,
    cwd: dir,
    permissionMode,
    nameHint: prompt,
    mode: ds && !unified ? 'deepseek' : undefined,
    provider: unified ? provider : undefined,
    subagent,
    config: remote || claude ? { model, effort, permission, planMode, ...(repo ? { repo } : {}) } : undefined,
  });
  const files = req.body?.files || [];
  const attached = await saveAttachments(s, files, req.body?.uploadDir);
  if (prompt?.trim() || images?.length || files.length) runner.startTurn(s, `${prompt?.trim() || (files.length ? '請看附件。' : '')}${attached}`, { images });
  return runner.summarize(s);
}));

// A conversation as of `seq`: its summary, the chain it belongs to and, by
// default, only the newest window of the chain's events (see
// snapshot-window.js) with `window: { total, firstIndex, hasEarlier }` saying
// which part that is. `{ window: false }` is the whole history, no `window`
// field (for tools that want everything). Taken in one go (the window is cut
// from references, quick) and written out in slices, so a big one does not
// hold up the live stream.
const isBusy = (s) => s.status === 'running' || s.status === 'awaiting_permission';
const snapshotOf = (s, { window = true } = {}) => {
  const leaf = store.leafOf(s) || s;
  const nodes = store.chainOf(leaf).map((n) => runner.summarize(n));
  const items = store.chainItems(leaf);
  const cut = window ? snapshotWindow.latestWindow(items, { busy: isBusy(leaf) }) : null;
  return {
    ...runner.summarize(leaf),
    seq: leaf.seq || 0,
    allowedTools: leaf.allowedTools,
    events: cut ? cut.events : items.map((item) => store.annotate(item)),
    ...(cut ? { window: cut.window } : {}),
    ...(cut?.outside ? { outside: cut.outside } : {}),
    chain: nodes,
    redirectedFrom: s.id !== leaf.id ? s.id : undefined,
  };
};

const viewed = (s) => {
  const leaf = store.leafOf(s) || s;
  if (leaf.kimiSessionId) kimiRemote.view(leaf);
  else if (leaf.agentId === 'claude') ADAPTERS.claude.view(leaf);
};

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const s = leafOf(req);
    viewed(s);
    const snap = snapshotOf(s, { window: req.query.window !== 'all' });
    if (nodeOf(req).id !== s.id) snap.redirectedFrom = nodeOf(req).id;
    res.type('json').send(await store.jsonInSlices(snap, 'events'));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Older history, a page at a time: the events before index `before` of the
// chain (the `firstIndex` of what the page already has), newest of them
// first-to-last in the answer, at most `limit` and at most a byte budget, at
// least one. `beforeId` (the id of the first event the page shows) wins over
// `before` when history has shifted under the index. { events, firstIndex,
// hasEarlier, total }.
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const wholeNumber = (v, name) => {
  if (!/^\d+$/.test(String(v))) throw badRequest(`${name} 必須是 0 或正整數`);
  return Number(v);
};
// Where the time of a conversation went (all of its chain): model, tools,
// compaction, waiting for a rate limit, requests and 429s - measured only.
app.get('/api/sessions/:id/timing', wrap((req) => {
  const leaf = leafOf(req);
  return timing.sessionTiming(store.chainOf(leaf));
}));

app.get('/api/sessions/:id/events', wrap((req) => {
  const leaf = leafOf(req);
  const items = store.chainItems(leaf);
  let before = req.query.before === undefined ? items.length : wholeNumber(req.query.before, 'before');
  if (req.query.beforeId !== undefined) {
    before = items.findIndex((it) => it.ev.id === String(req.query.beforeId));
    if (before === -1) throw Object.assign(new Error('找不到那個事件'), { status: 404 });
  }
  const limit = req.query.limit === undefined ? undefined : wholeNumber(req.query.limit, 'limit');
  if (limit === 0) throw badRequest('limit 必須是正整數');
  return snapshotWindow.pageBefore(items, before, { limit, busy: isBusy(leaf) });
}));

// One event of the chain: as the snapshot shows it, or whole with ?full=1
// (what a preview with `truncated` stands for).
app.get('/api/sessions/:id/events/:eventId', wrap((req) => {
  const item = store.chainItems(leafOf(req)).find((it) => it.ev.id === req.params.eventId);
  if (!item) throw Object.assign(new Error('找不到那個事件'), { status: 404 });
  return { event: snapshotWindow.oneEvent(item, { full: req.query.full === '1' || req.query.full === 'true' }) };
}));

// The pages (Artifact panel) this conversation made, over the WHOLE chain, not
// only the window the snapshot holds: one entry per tool call that wrote or
// edited a page, oldest first, { path, eventId, ts, kind, status, append?,
// title? } (what the page needs to list the pages and number their versions;
// the content of a version is one request away). The rule is the page's own
// (artifacts.js).
app.get('/api/sessions/:id/artifacts', wrap((req) => {
  const items = store.chainItems(leafOf(req));
  return { artifacts: artifactIndex(items.map((it) => it.ev)), total: items.length };
}));

// One version of a page as it was after event `eventId`: { path, eventId,
// html }, html null when it cannot be derived (an Edit whose Write is not in
// this conversation: the page is then read from disk).
app.get('/api/sessions/:id/artifacts/:eventId', wrap((req) => {
  const events = store.chainItems(leafOf(req)).map((it) => it.ev);
  const ev = events.find((e) => e.id === req.params.eventId);
  const art = ev && artifactOf(ev);
  if (!art) throw Object.assign(new Error('那個事件不是 Artifact 頁面'), { status: 404 });
  return replayVersion(events, art.path, ev.id);
}));

// The page pings while a conversation is open, so it stays followed.
app.post('/api/sessions/:id/viewing', wrap((req) => {
  viewed(leafOf(req));
}));

app.patch('/api/sessions/:id', wrap((req) => {
  const s = leafOf(req);
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

// Deleting a conversation removes the whole thing (see runner.deleteConversation);
// any node's id names it.
app.delete('/api/sessions/:id', wrap((req) => runner.deleteConversation(nodeOf(req))));

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
  const s = leafOf(req);
  const files = req.body?.files || [];
  const text = String(req.body?.text ?? '');
  const images = (req.body?.images || []).slice(0, 10);
  if (!text.trim() && !images.length && !files.length) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  const note = req.body?.from === 'artifact' ? '從 Artifact 送出' : undefined;
  const attached = await saveAttachments(s, files, req.body?.uploadDir);
  await runner.startTurn(s, `${text.trim() || (files.length ? '請看附件。' : '')}${attached}`, { images, note, steer: Boolean(req.body?.steer) });
}));

// An existing Claude conversation bound to a GitHub repository, for good.
app.post('/api/sessions/:id/repo', wrap(async (req) => {
  const s = leafOf(req);
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
  const s = leafOf(req);
  const r = await runner.command(s, name, String(req.body?.args ?? '').trim());
  if (name === 'archive') runner.deleteConversation(s);
  return r;
}));

app.post('/api/sessions/:id/earlier', wrap(async (req) => {
  const s = leafOf(req);
  if (!s.kimiSessionId) return {};
  await ADAPTERS['kimi-remote'].loadEarlier(s);
}));

// 自動暫停: { enabled, threshold } turns it on or off and sets the share of
// the 5-hour quota to pause at; { resumeAfterReset: true, text } sends `text`
// (「繼續」) once the 5-hour quota has reset, for a conversation paused by
// hand; { cancelResume: true } calls off the message waiting to go out.
app.post('/api/sessions/:id/autopause', wrap(async (req) => {
  const s = leafOf(req);
  if (!s.kimiSessionId) throw Object.assign(new Error('只有 Kimi 對話可以自動暫停'), { status: 400 });
  const { enabled, threshold, cancelResume, resumeAfterReset, text } = req.body || {};
  // It watches the Kimi subscription's 5-hour quota, which a DeepSeek
  // conversation does not use. A conversation that was switched over from
  // Kimi may still carry the state it had there (auto-pause on, or waiting to
  // send 「繼續」): that can always be switched off, though never set up again.
  if (deepseekAccount.isDeepseek(s)) {
    const leftOver = (enabled === false && s.autoPause?.enabled) || (cancelResume && s.autoPause?.phase === 'paused');
    if (!leftOver) throw Object.assign(new Error('DeepSeek 對話不用 Kimi 訂閱，沒有 5 小時額度，不能自動暫停，也不能設定「額度恢復後送出」。要延後送出訊息，請用 /later 30 繼續 或「定時送出…」。'), { status: 400 });
  }
  if (cancelResume) autoPause.cancelResume(s);
  else if (resumeAfterReset) await autoPause.armResume(s, { text });
  else autoPause.configure(s, { enabled, threshold });
  return runner.summarize(s);
}));

// 定時送出: { text, at } (ms) adds a message to send at that time.
app.post('/api/sessions/:id/schedule', wrap((req) => {
  const s = leafOf(req);
  if (!s.kimiSessionId && s.agentId !== 'claude') throw Object.assign(new Error('這個對話不能定時送出'), { status: 400 });
  scheduler.add(s, req.body || {});
  return runner.summarize(s);
}));
app.delete('/api/sessions/:id/schedule/:item', wrap((req) => {
  const s = leafOf(req);
  scheduler.cancel(s, req.params.item);
  return runner.summarize(s);
}));

// 插隊: slip a queued message into the running turn (Kimi's Ctrl-S).
app.post('/api/sessions/:id/queue/steer-all', wrap((req) => runner.steerAll(leafOf(req))));
app.post('/api/sessions/:id/queue/:promptId/steer', wrap(async (req) => {
  await runner.steerQueued(leafOf(req), req.params.promptId);
}));

// 移到背景 (Kimi's Ctrl+B).
app.post('/api/sessions/:id/background', wrap(async (req) => {
  const s = leafOf(req);
  if (!s.kimiSessionId) throw Object.assign(new Error('這個對話不支援移到背景'), { status: 400 });
  return ADAPTERS['kimi-remote'].moveToBackground(s, { interruptSwarm: Boolean(req.body?.interruptSwarm) });
}));

app.post('/api/sessions/:id/unlock', wrap(async (req) => {
  const s = leafOf(req);
  if (!s.kimiSessionId) throw Object.assign(new Error('這個對話不需要解除'), { status: 400 });
  await ADAPTERS['kimi-remote'].unlock(s);
}));

app.delete('/api/sessions/:id/queue/:promptId', wrap(async (req) => {
  await runner.cancelQueued(leafOf(req), req.params.promptId);
}));

app.post('/api/sessions/:id/interrupt', wrap(async (req) => {
  await runner.interrupt(leafOf(req).id);
}));

app.post('/api/sessions/:id/permissions/:eventId', wrap(async (req) => {
  const { optionId, answers, feedback } = req.body || {};
  // The request lives where its card does: the leaf, unless the card is on an
  // earlier node of the chain.
  const leaf = leafOf(req);
  const holder = store.chainOf(leaf).findLast((n) => n.events?.some((e) => e.id === req.params.eventId)) || leaf;
  const ok = await runner.resolvePermission(holder.id, req.params.eventId, optionId, { answers, feedback });
  if (!ok) throw Object.assign(new Error('這個請求已經處理過了'), { status: 409 });
}));

app.post('/api/sessions/:id/config', wrap(async (req) => {
  const s = leafOf(req);
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'subagent')) {
    if (body.subagent && runner.providerOf(s) !== 'claude' && !subagentBroker.supportsBroker(s.machineId)) {
      throw Object.assign(new Error(`「${machines.getMachine(s.machineId)?.name || s.machineId}」的連接器太舊，沒有子代理 broker。在那台電腦重新執行連接指令（左下角「連接電腦…」）更新後再設定子代理。`), { status: 409, code: 'broker_old' });
    }
    await runner.setSubagent(s, body.subagent);
  }
  const rest = { ...body };
  delete rest.subagent;
  if (Object.keys(rest).length) await runner.configure(s, rest);
  return runner.summarize(s);
}));

// The one control for changing the main model/provider of an existing
// conversation. Same provider/runtime is a profile change; a runtime switch
// creates a new leaf node linked by the continuation chain.
app.post('/api/sessions/:id/provider', wrap(async (req) => {
  const s = leafOf(req);
  const { provider, model, effort, machineId, force } = req.body || {};
  return runner.switchProvider(s, { provider, model, effort, machineId, force: force === true });
}));

// Call off a switch that is waiting for the turn to end.
app.delete('/api/sessions/:id/pending-switch', wrap((req) => runner.cancelPendingSwitch(leafOf(req))));

const kimiRemote = ADAPTERS['kimi-remote'];
// A Claude conversation on a connected computer reads its folder there.
const remoteClaude = (s) => s.agentId === 'claude' && s.machineId;
app.get('/api/sessions/:id/files', wrap((req) => {
  const s = leafOf(req);
  const rel = String(req.query.path || '.');
  if (remoteClaude(s)) return ADAPTERS.claude.listFiles(s, rel);
  return s.kimiSessionId ? kimiRemote.listFiles(s, rel) : workspace.listDir(s.cwd, rel);
}));
app.get('/api/sessions/:id/file', wrap((req) => {
  const s = leafOf(req);
  const rel = String(req.query.path || '');
  if (remoteClaude(s)) return ADAPTERS.claude.readFile(s, rel);
  return s.kimiSessionId ? kimiRemote.readFile(s, rel) : workspace.readFile(s.cwd, rel);
}));
app.get('/api/sessions/:id/changes', wrap((req) => {
  const s = leafOf(req);
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
  const s = leafOf(req);
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

// ---------------------------------------------------------------- 叢集
// One conversation hands several tasks to several workers (server/cluster.js).
// Not Kimi's /swarm: a worker may have that mode on, which is Kimi's own.
app.post('/api/sessions/:id/cluster', wrap((req) => clusters.create(leafOf(req), req.body)));
app.get('/api/sessions/:id/clusters', wrap((req) => clusters.listFor(leafOf(req))));
app.get('/api/clusters', wrap(() => clusters.listAll()));
// (before /api/clusters/:cid) the backups of purged clusters that are still kept.
app.get('/api/clusters/trash', wrap(() => ({ days: clusterTrash.TRASH_DAYS, items: clusterPurge.listPurged() })));
app.get('/api/clusters/:cid', wrap((req) => clusters.get(req.params.cid)));
app.post('/api/clusters/:cid/stop', wrap((req) => clusters.stop(req.params.cid)));
app.post('/api/clusters/:cid/merge', wrap((req) => clusters.merge(req.params.cid)));
app.post('/api/clusters/:cid/name', wrap((req) => clusters.rename(req.params.cid, req.body?.name)));
// Clean-up after the work is merged (worktrees, worker branches, sidebar rows); the plan is a dry run for the confirmation.
app.get('/api/clusters/:cid/cleanup/plan', wrap((req) => clusters.cleanupPlan(req.params.cid)));
app.post('/api/clusters/:cid/cleanup', wrap((req) => clusters.cleanup(req.params.cid)));
// 完全清除: what it would do with these options (the boxes), and doing it.
const purgeOptions = (src) => ({ discardDirty: [true, '1', 'true'].includes(src?.discardDirty), deleteUnmerged: [true, '1', 'true'].includes(src?.deleteUnmerged), deleteMerged: [true, '1', 'true'].includes(src?.deleteMerged), noBackup: [true, '1', 'true'].includes(src?.noBackup) });
app.get('/api/clusters/:cid/purge/plan', wrap((req) => clusterPurge.plan(req.params.cid, purgeOptions(req.query))));
app.post('/api/clusters/:cid/purge', wrap((req) => clusterPurge.purge(req.params.cid, purgeOptions(req.body))));
app.post('/api/clusters/:cid/unhide', wrap((req) => clusters.unhide(req.params.cid, req.body?.sessionId)));
app.get('/api/clusters/:cid/memory', wrap((req) => clusters.readMemoryOf(req.params.cid)));
app.post('/api/clusters/:cid/memory', wrap((req) => clusters.appendDecision(req.params.cid, req.body?.text)));

// `?for=sidebar`: without the Kimi conversations of cluster workers (see machines.sidebarView).
app.get('/api/machines', wrap((req) => (req.query.for === 'sidebar' ? machines.listMachines().map(machines.sidebarView) : machines.listMachines())));
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
// A conversation the hub already follows goes through the adapter's one
// routing rule. A native one it does not follow yet can still be a terminal:
// the same rule (kimiRemote.canDriveTerminal) decides — only a terminal whose
// controllable state is exactly true is typed into; owner=tui alone, null,
// guess and an unknown conversation all use Kimi's Server API.
app.post('/api/machines/:mid/kimi/:kid/:action', wrap(async (req) => {
  const { mid, kid, action } = req.params;
  if (!['title', 'archive'].includes(action)) throw Object.assign(new Error('不支援的操作'), { status: 404 });
  let title = '';
  if (action === 'title') {
    title = String(req.body?.title || '').trim().slice(0, 120);
    if (!title) throw Object.assign(new Error('標題是空的'), { status: 400 });
  }
  const hubId = kimiRemote.findByKimi(mid, kid);
  const s = hubId ? store.getSession(hubId) : null;
  if (s) {
    // kimi-remote.command() makes the same canDriveTerminal/API decision as
    // every other action, and updates the title or archives through Kimi.
    await kimiRemote.command(s, action, title);
  } else {
    const controllable = kimiRemote.canDriveTerminal(mid, kid);
    if (action === 'archive' && controllable) throw Object.assign(new Error('這個對話正在終端機執行。先關掉那個 Kimi，再從這裡刪除'), { status: 409 });
    if (action === 'title' && controllable) await machines.rpc(mid, 'kimi.tui.input', { sessionId: kid, action: 'command', text: `/title ${title}` });
    else if (action === 'title') {
      await kimiRemote.ensureServer(mid);
      await machines.kimiApi(mid, 'POST', `/api/v1/sessions/${kid}/profile`, { title });
    } else {
      await kimiRemote.ensureServer(mid);
      await machines.kimiApi(mid, 'POST', `/api/v1/sessions/${kid}:archive`, {});
    }
  }
  if (action === 'archive' && s) runner.deleteConversation(s);
  return {};
}));

// ---------------------------------------------------------------- static

const ROOT = store.ROOT_DIR;
// Files are sent by path relative to a root, never by absolute path: a folder
// with a dot in its name (a checkout under ~/.claude/…) is not a "dotfile",
// and only the part below the root is judged.
app.get('/vendor/marked.esm.js', (req, res) => res.sendFile('node_modules/marked/lib/marked.esm.js', { root: ROOT }));
app.get('/vendor/purify.es.mjs', (req, res) => res.sendFile('node_modules/dompurify/dist/purify.es.mjs', { root: ROOT }));
// The one-file Claude daemon bridges download to run Claude on their computer.
app.get('/bridge/claude-daemon.mjs', (req, res) => res.type('text/javascript').sendFile('bridge/claude-daemon.mjs', { root: ROOT }));
// The bridge script holds no secrets; serving it lets machines fetch it with curl.
app.get('/bridge/agent-hub-bridge.mjs', (req, res) => res.type('text/javascript').sendFile('bridge/agent-hub-bridge.mjs', { root: ROOT }));

// public/ is served without a login (the page has to load before anyone can
// sign in), so it serves a list, not the folder: the page, and what the page
// loads from css/ and js/. A report, a screenshot or a note that ends up in
// public/ is not readable over the network (a new kind of product file is
// added here on purpose). Dot files and anything outside the list are 404.
const PUBLIC_DIR = path.join(ROOT, 'public');
const PUBLIC_TREES = { css: /\.css$/, js: /\.js$/ };
function publicFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel === '/') return 'index.html';
  if (!rel.startsWith('/') || /[\\\0]/.test(rel)) return null;
  const parts = rel.slice(1).split('/');
  if (parts.some((x) => !x || x.startsWith('.'))) return null;
  if (parts.length === 1) return parts[0] === 'index.html' ? 'index.html' : null;
  return PUBLIC_TREES[parts[0]]?.test(rel) ? parts.join('/') : null;
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const rel = publicFile(req.path);
  if (!rel) return next();
  res.sendFile(rel, { root: PUBLIC_DIR, dotfiles: 'deny', index: false }, (err) => {
    if (err && !res.headersSent) next();
  });
});
// Any other path is a page route of the single-page UI, unless it names a
// file (report.png) or goes through a dot folder (.git/config, .env): that is
// a file that is not served.
app.get(/^\/(?!api|ws|vendor|bridge).*/, (req, res) => {
  const parts = req.path.split('/');
  if (parts.at(-1).includes('.') || parts.some((x) => x.startsWith('.'))) return res.status(404).type('text/plain').send('Not found');
  res.sendFile('index.html', { root: PUBLIC_DIR });
});
// Whatever is left is an error, answered as JSON { error } (no stack, no path).
app.use(notFound());
app.use(errorHandler());

// ------------------------------------------------------------- websocket

const server = http.createServer(app);
// Pages talk to /ws. A message above 1 KB (a snapshot, a bundle of a busy
// stream) is deflated, off the main thread; smaller ones (a delta, a hello) go
// out as they are, as compressing them costs more than it saves. No context is
// kept between messages (no memory held per connection), and at most 4
// messages are deflated at once so a burst cannot take every core. A page
// only ever sends tiny messages, so what it sends is capped (a bomb).
const WS_DEFLATE = {
  threshold: 1024,
  concurrencyLimit: 4,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 3, memLevel: 8 },
  zlibInflateOptions: { chunkSize: 8 * 1024 },
};
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: WS_DEFLATE, maxPayload: 1024 * 1024 });
// A connector's biggest legitimate frame is a file read (20 MB, as base64:
// 27 MB); a conversation's history is cut from at most 24 MB of its log plus
// 8 MB per sub-agent. A frame over this closes that connector's socket only.
const BRIDGE_MAX_FRAME = (Number(process.env.AGENT_HUB_BRIDGE_MAX_FRAME_MB) || 64) * 1024 * 1024;
const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_FRAME });
// A connector with the wrong key is told so (close code 4401: it stops and
// says why) but is held to a tiny frame size meanwhile.
const strangerWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
// A frame over the limit is an 'error' on that socket (ws closes it with 1009);
// without a listener it would be an uncaught exception, the whole Hub down.
const onSocketError = (what) => (err) => console.warn(`[${what}] socket closed: ${err.message}`);
const refuse = (socket, status) => {
  socket.on('error', () => {});
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  // A page of another site may not open either socket; a program that sends no Origin may (it still needs the token or key).
  if ((url.pathname === '/bridge' || url.pathname === '/ws') && !originAllowed(req, ALLOWED_ORIGINS)) return refuse(socket, '403 Forbidden');
  if (url.pathname === '/bridge') {
    const keyOk = secretEq(url.searchParams.get('key'), BRIDGE_KEY);
    return (keyOk ? bridgeWss : strangerWss).handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', onSocketError('bridge'));
      if (!keyOk) return ws.close(4401, 'bad key');
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      machines.attachBridge(ws);
    });
  }
  if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'))) return refuse(socket, '401 Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', onSocketError('ws'));
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      // { t: 'watch', sid, window: 'all' } asks for the whole history in the
      // snapshot instead of its newest window (kept for tools; the page uses the window).
      if (m.t === 'watch') {
        ws.windowAll = m.window === 'all';
        // A page that keeps the slim forms (server/page-push.js) says so; one that does not gets every message whole.
        ws.slim = m.slim === 1 || m.slim === true;
        watch(ws, typeof m.sid === 'string' ? m.sid : null).catch((err) => console.warn('[ws] watch:', err.message));
      }
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
  ws.out ??= [];
  ws.behind = false;
  const token = (ws.watchToken = (ws.watchToken || 0) + 1);
  if (!sid) {
    ws.watch = sid;
    return;
  }
  const requested = store.getSession(sid);
  const s = requested && store.leafOf(requested);
  if (!s) {
    ws.watch = sid;
    return queue(ws, JSON.stringify({ t: 'snapshot', sid, error: '找不到 session' }));
  }
  // The chain has one live leaf. An old node URL follows that leaf.
  ws.watch = s.id;
  viewed(s);
  // Taken now, in order with the stream: what happens while it is being
  // written out is queued behind it.
  const snap = snapshotOf(s, { window: !ws.windowAll });
  if (requested.id !== s.id) snap.redirectedFrom = requested.id;
  // The snapshot carries the summary: what the page was sent of this conversation before it no longer says what it holds.
  pagePush.forgetSession(ws, s.id);
  ws.holding = (ws.holding || 0) + 1;
  try {
    const body = await store.jsonInSlices(snap, 'events');
    // Only the newest watch counts (pages switch, resync).
    if (ws.watchToken === token) {
      ws.out.unshift(`{"t":"snapshot","sid":${JSON.stringify(s.id)},"session":${body}}`);
      ws.sentSnapshot = true;
    }
  } finally {
    ws.holding--;
  }
  if (!ws.holding) flushOut(ws);
}

function broadcast(msg) {
  // Keep each node's stream on its own sid. The chain snapshot already merges
  // history; rewriting an old node's events to the leaf would replay them
  // again in the leaf's live transcript.
  if (msg.ev && msg.sid) {
    const node = store.getSession(msg.sid);
    if (node) {
      const nodes = store.chainOf(store.leafOf(node) || node);
      msg = {
        ...msg,
        ev: {
          ...msg.ev,
          nodeId: node.id,
          conversationId: node.conversationId || node.id,
          nodeProvider: store.nodeProvider(node),
          nodeIndex: Math.max(0, nodes.findIndex((n) => n.id === node.id)),
        },
      };
    }
  }
  // A cluster worker's progress line follows what it says, and a worker whose
  // conversation is deleted reads 已刪除 on the pages that show its cluster.
  if (msg.sid && (msg.t === 'event' || msg.t === 'patch' || msg.t === 'delta' || msg.t === 'deleted')) clusters.noteActivity(msg.sid);
  // A worker's generation speed lives in its conversation's meta, which moves with
  // no event beside it (a step's end): the summary that carries it is activity too.
  else if (msg.t === 'session' && msg.session?.id) clusters.noteActivity(msg.session.id);
  // The clusters a deleted conversation started say its name is gone.
  if (msg.sid && msg.t === 'deleted') clusters.noteDeleted(msg.sid);
  // Written out once, and only if some page needs it whole.
  let text = null;
  const whole = () => (text ??= JSON.stringify(msg));
  const sid = STREAM.has(msg.t) ? msg.sid : null;
  // Pages that keep the slim forms are sent what changed since they were last told (server/page-push.js).
  let slim;
  const slimWay = () => (slim === undefined ? (slim = sid ? null : pagePush.prepare(msg, { sidebarView: machines.sidebarView, isWorkerNative: machines.isWorkerNative })) : slim);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.watch === undefined) {
      ws.send(whole());
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
    const way = ws.slim ? slimWay() : null;
    if (way) {
      for (const part of way.deliver(ws, whole)) queue(ws, part);
      continue;
    }
    queue(ws, whole());
  }
}
runner.setBroadcast(broadcast);
machines.setBroadcast(broadcast);
clusters.setBroadcast(broadcast);
clusters.load();
clusterTrash.startSweeper();
// A connector reports which key of its provisioned pool it is on, and which
// ones its proxy found exhausted. The account validates it (known gateway
// and key ids only, never a secret) and the settings pages see it at once.
machines.onBridgeMessage((machineId, msg) => {
  if (msg?.t !== 'deepseek.pool') return;
  try {
    if (deepseekAccount.applyPoolReport(machineId, msg)) {
      broadcast({ t: 'deepseek', account: deepseekAccount.publicAccount() });
      // A key may be available now that was not (a proven key, a cooldown over): conversations waiting for one are looked at.
      keyRecover.evaluate();
    }
  } catch (err) {
    console.warn(`[deepseek] pool report from ${machineId}: ${err.message}`);
  }
});
subagentBroker.install();
timing.install();
runner.restoreLiveSessions();

// Auto-pause and 定時送出 run here on the hub, whether or not a browser is open.
const persist = (s, { immediate }) => {
  if (store.getSession(s.id) !== s) return; // deleted meanwhile
  store.saveSession(s, { immediate });
  broadcast({ t: 'session', session: runner.summarize(s) });
};
const autoPause = createAutoPause({
  sessions: () => runner.autoPauseSessions(),
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
// A DeepSeek conversation whose turn ended on a quota or rate-limit error gets 「繼續」 by itself once a key is
// available that was not (server/key-recover.js). Its state is kept with the conversation.
const keyRecover = createKeyRecover({
  isDeepseek: (s) => deepseekAccount.isDeepseek(s),
  sessions: () => store.listLeaves(),
  getSession: (id) => store.getSession(id),
  enabled: () => deepseekAccount.autoResumeEnabled(),
  availability: () => deepseekAccount.availability(),
  send: (s, text) => runner.deliver(s, text),
  info: (s, text) => runner.liveContext(s).emit({ type: 'info', text }),
  changed: (s) => persist(s, { immediate: false }),
  log: (err) => console.warn(`[key-recover] ${err?.message || err}`),
});
runner.onStatus((s) => keyRecover.observe(s));
keyRecover.start();
// Claude conversations run here, so they are always "online".
const isClaude = (s) => s.agentId === 'claude';
const scheduler = createScheduler({
  sessions: () => runner.schedulableSessions(),
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
  clusters.flush();
  store.flushAll();
  disposeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
