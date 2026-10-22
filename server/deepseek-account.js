// DeepSeek mode: DeepSeek models run inside the Kimi Code CLI of a connected
// computer, so Kimi's own harness (context compaction, subagents, plan mode,
// reasoning replay) does the work. The model comes from one custom Kimi
// provider, `agent-hub-deepseek`, which the hub has the bridge create on
// that computer (bridge op kimi.deepseek.provision), pointing at an
// OpenAI-compatible gateway that serves DeepSeek and billed to that
// gateway's API key, never to the Kimi subscription.
//
// This file is the hub's side of it: the gateway keys and the defaults for
// new DeepSeek conversations, the DeepSeek models a key can use, and keeping
// that provider provisioned on each computer.
//
// Keys are kept in data/deepseek.json (readable by this user only) and never
// sent to a browser; pages see only the last four characters. They do go to
// the bridge, which writes the one key of the gateway in use into Kimi's
// config on that computer (Kimi keeps provider keys in its config.toml).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import * as machines from './machines.js';

const FILE = path.join(DATA_DIR, 'deepseek.json');

// The provider the bridge creates in Kimi; a DeepSeek model's alias in Kimi
// is `agent-hub-deepseek/<model id at the gateway>`.
export const PROVIDER_ID = 'agent-hub-deepseek';
export const MODEL_PREFIX = `${PROVIDER_ID}/`;

// The gateways, in one place (id → address, models). `base` is the address
// Kimi sends chat completions to (the bridge keeps its own copy of id → base,
// DS_GATEWAYS in bridge/agent-hub-bridge.mjs: the hub names a gateway to it,
// never an address, so a change of `base` here needs the same change there);
// `list` is where the hub asks for the models a key can use. `models` are the
// DeepSeek models to offer when that list cannot be read, with the ones new
// conversations start on named by DEFAULT_MODEL below. Ids are the gateway's
// own, vendor prefix and all. `site` is where its keys are made.
export const GATEWAYS = {
  // The OpenCode Go subscription.
  'opencode-go': {
    label: 'OpenCode Go',
    base: 'https://opencode.ai/inference/go/openai/v1',
    list: 'https://opencode.ai/inference/go/v1/models',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro'],
    site: 'https://opencode.ai',
  },
  // OpenCode pay-as-you-go (formerly Zen).
  opencode: {
    label: 'OpenCode（按量計費）',
    base: 'https://opencode.ai/inference/openai/v1',
    list: 'https://opencode.ai/inference/v1/models',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash-free'],
    site: 'https://opencode.ai',
  },
  // Needs a plan with API access (Provider, GOAT, Pro, Max, Team); the Go
  // plan is refused with 403 upgrade_required.
  commandcode: {
    label: 'Command Code',
    base: 'https://api.commandcode.ai/provider/v1',
    list: 'https://api.commandcode.ai/provider/v1/models',
    models: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-fast', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-fast', 'deepseek/deepseek-v4-flash-vision-exp'],
    site: 'https://commandcode.ai',
  },
};
export const DEFAULT_GATEWAY = 'opencode-go';
// New conversations start on this one when the gateway has it.
const DEFAULT_MODEL = /deepseek-v4\.1-flash$/i;
// The models that take images: V4.1 Flash, and any vision one.
const IMAGE_MODELS = /v4\.1-flash|vision/i;

// What every DeepSeek model gets in Kimi: a 1M window, up to 384k of output,
// always reasoning (which keeps "off" out of its choices), the efforts the
// gateways take as reasoning_effort, and tools.
export const CONTEXT_SIZE = 1_000_000;
export const MAX_OUTPUT = 384_000;
export const EFFORTS = ['low', 'high', 'max'];
export const DEFAULT_EFFORT = 'max';

// The tests run the hub against a local fake gateway: every gateway then
// answers at <that address>/<gateway id>. Nothing else can point it anywhere
// but the addresses above.
function listUrl(gateway) {
  const t = process.env.AGENT_HUB_DEEPSEEK_TEST_URL;
  if (t && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(t)) return `${t}/${gateway}/models`;
  return GATEWAYS[gateway].list;
}

// ------------------------------------------------------------- storage

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
let saved = load();

function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// For the tests: read the file again.
export function reload() {
  saved = load();
  provisioned.clear();
}

export const isGateway = (id) => Object.hasOwn(GATEWAYS, id);

// The gateway in use. A key saved without choosing one goes to OpenCode Go.
export const gateway = () => (isGateway(saved.gateway) ? saved.gateway : DEFAULT_GATEWAY);

// ------------------------------------------------------------- the keys

// Why `key` cannot be a gateway key, or null.
export function checkKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return '請貼上 API key';
  if (k.length > 500) return 'API key 太長了（最多 500 個字元）';
  if (/\s/.test(k)) return 'API key 裡不能有空白或換行，請確認複製的是完整的一把 key';
  return null;
}

export const apiKey = (gw = gateway()) => (isGateway(gw) && typeof saved.keys?.[gw] === 'string' ? saved.keys[gw] : '');
// The last four characters: all a page is ever told of a key.
const hint = (k) => (k ? k.slice(-4) : '');

export function setKey(gw, key) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const why = checkKey(key);
  if (why) throw Object.assign(new Error(why), { status: 400 });
  saved.keys = { ...(saved.keys || {}), [gw]: String(key).trim() };
  save();
}

export function clearKey(gw) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const keys = { ...(saved.keys || {}) };
  delete keys[gw];
  saved.keys = keys;
  if (saved.models) delete saved.models[gw];
  save();
}

// ------------------------------------------------------------- settings

const PERMISSIONS = ['manual', 'yolo', 'auto'];

// The model new conversations start on: the V4.1 Flash of the gateway when
// it is among `ids`, else the first DeepSeek model.
export function pickDefaultModel(ids) {
  return ids.find((id) => DEFAULT_MODEL.test(id)) || ids[0] || '';
}

export function settings(gw = gateway()) {
  const d = saved.defaults || {};
  const ids = modelIds(gw);
  return {
    gateway: gw,
    defaults: {
      model: typeof d.model === 'string' && ids.includes(d.model) ? d.model : pickDefaultModel(ids),
      effort: EFFORTS.includes(d.effort) ? d.effort : DEFAULT_EFFORT,
      permission: PERMISSIONS.includes(d.permission) ? d.permission : 'manual',
      planMode: Boolean(d.planMode),
    },
  };
}

export function setSettings({ gateway: gw, defaults } = {}) {
  if (gw !== undefined) {
    if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
    saved.gateway = gw;
  }
  if (defaults && typeof defaults === 'object') {
    const d = { ...(saved.defaults || {}) };
    if (typeof defaults.model === 'string' && defaults.model.length <= 100) d.model = defaults.model;
    if (EFFORTS.includes(defaults.effort)) d.effort = defaults.effort;
    if (PERMISSIONS.includes(defaults.permission)) d.permission = defaults.permission;
    if ('planMode' in defaults) d.planMode = Boolean(defaults.planMode);
    saved.defaults = d;
  }
  save();
}

export function publicAccount() {
  const gw = gateway();
  // Computers where the provider could not be given its session header (the
  // bridge says why): the gateway may throttle those.
  const warnings = [...headerWarnings].map(([id, text]) => ({ machineId: id, machineName: machines.getMachine(id)?.name || id, text }));
  const gateways = Object.entries(GATEWAYS).map(([id, g]) => ({ id, label: g.label, site: g.site, hasKey: Boolean(apiKey(id)), keyHint: hint(apiKey(id)) }));
  const cur = gateways.find((g) => g.id === gw);
  return { gateway: gw, hasKey: cur.hasKey, keyHint: cur.keyHint, gateways, defaults: settings(gw).defaults, warnings };
}

// -------------------------------------------------------------- models

const titleCase = (w) => (/^v\d/i.test(w) ? `V${w.slice(1)}` : /^deepseek$/i.test(w) ? 'DeepSeek' : w.charAt(0).toUpperCase() + w.slice(1));

// "deepseek/deepseek-v4.1-flash" → "DeepSeek V4.1 Flash".
export function displayName(id) {
  return String(id)
    .replace(/^.*\//, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
}

// One model as Kimi's provider is given it (the bridge checks every field).
export function kimiModel(id) {
  const caps = ['thinking', 'always_thinking', 'tool_use'];
  if (IMAGE_MODELS.test(id)) caps.push('image_in');
  return { model: id, display_name: displayName(id), max_context_size: CONTEXT_SIZE, max_output_size: MAX_OUTPUT, capabilities: caps, support_efforts: [...EFFORTS] };
}

// One model as the composer shows it (same shape as Kimi's model list).
function info(id) {
  return { id, name: displayName(id), efforts: [...EFFORTS], defaultEffort: DEFAULT_EFFORT, image: IMAGE_MODELS.test(id), context: CONTEXT_SIZE, maxOut: MAX_OUTPUT, deepseek: true };
}

// The DeepSeek model ids of a gateway: the live list read when its key was
// last tested or saved, else the built-in one.
export function modelIds(gw = gateway()) {
  const live = saved.models?.[gw]?.ids;
  return Array.isArray(live) && live.length ? live : [...GATEWAYS[gw].models];
}

export function models(gw = gateway()) {
  const ids = modelIds(gw);
  return { gateway: gw, live: Boolean(saved.models?.[gw]?.ids?.length), defaultModel: settings(gw).defaults.model, models: ids.map(info) };
}

// What the gateway's /models answer says, said plainly.
export function explain(gw, { status, body, err } = {}) {
  const label = GATEWAYS[gw]?.label || '閘道';
  if (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `連不到閘道：${label} 15 秒內沒有回應`;
    return `連不到閘道：${label}（${err.cause?.code || err.code || err.message}）`;
  }
  if (status === 401) return `金鑰無效：${label} 不接受這把 API key（401）`;
  if (status === 403) {
    if (/upgrade_required/i.test(body || '')) return 'Command Code 的 Go 方案不含 API 存取，請升級到 GOAT/Pro/Max 等含 API 的方案';
    return `這把 API key 沒有權限使用 ${label}（403）${body ? `：${String(body).slice(0, 200)}` : ''}`;
  }
  return `${label} 回應了 HTTP ${status}${body ? `：${String(body).slice(0, 200)}` : ''}`;
}

// The DeepSeek models `key` can use at the gateway: GET its model list, ids
// containing "deepseek". { ids, live }: `live` is false when the gateway
// has no usable list (the built-in one is used then) but did not refuse the
// key. Throws, with a plain message, when the key is refused or the gateway
// cannot be reached.
export async function fetchModels(gw, key) {
  let res;
  let text = '';
  try {
    res = await fetch(listUrl(gw), { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    text = await res.text();
  } catch (err) {
    throw Object.assign(new Error(explain(gw, { err })), { status: 400, code: 'unreachable' });
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(explain(gw, { status: res.status, body: text })), { status: 400, code: res.status === 401 ? 'bad_key' : 'forbidden' });
  const fallback = (note) => ({ ids: [...GATEWAYS[gw].models], live: false, note });
  if (!res.ok) return fallback(`${GATEWAYS[gw].label} 沒有提供模型清單（HTTP ${res.status}）`);
  let list;
  try {
    const j = JSON.parse(text);
    list = Array.isArray(j) ? j : j?.data || j?.models;
  } catch {}
  if (!Array.isArray(list)) return fallback(`${GATEWAYS[gw].label} 的模型清單看不懂`);
  const ids = [...new Set(list.map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && /^[\w.\/:-]{1,100}$/.test(id) && /deepseek/i.test(id)))];
  if (!ids.length) return fallback(`${GATEWAYS[gw].label} 的模型清單裡沒有 DeepSeek 模型`);
  return { ids, live: true };
}

// Read the live list with `key` and remember it for the gateway.
export async function refreshModels(gw, key) {
  const r = await fetchModels(gw, key);
  if (r.live) {
    saved.models = { ...(saved.models || {}), [gw]: { at: Date.now(), ids: r.ids } };
    save();
  } else if (saved.models?.[gw]) {
    // The gateway gave no list this time: the one read before still stands.
    return { ...r, ids: saved.models[gw].ids, note: `${r.note}，沿用上次讀到的清單` };
  }
  return r.note ? { ...r, note: `${r.note}，先用內建的 DeepSeek 模型清單` } : r;
}

// ------------------------------------------------- Kimi on the computers

const provisioned = new Map(); // machine id -> { sig, at }
const headerWarnings = new Map(); // machine id -> why the provider has no session header
const provisioning = new Map(); // machine id -> Promise

const sigOf = (gw, key, ids) => crypto.createHash('sha256').update(JSON.stringify([gw, key, ids])).digest('hex');

// An older bridge does not know the op.
const tooOld = (err, m) => (/未知的操作/.test(err?.message || '') ? Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，不支援 DeepSeek 模式。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409 }) : err);

// Make sure `machineId`'s Kimi has the agent-hub-deepseek provider for the
// gateway and key in use, with its models. Asked of the bridge once per
// (computer, gateway, key, model list); again when any of those changes, when
// the computer reconnects, or after an error. Resolves to the bridge's
// answer ({ ok, models: [alias], secondaryModel? }), or { cached: true }.
export async function ensureProvider(machineId, { rpc = machines.rpc } = {}) {
  const gw = gateway();
  const key = apiKey(gw);
  if (!key) throw Object.assign(new Error('還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409, code: 'no_key' });
  const ids = modelIds(gw);
  const sig = sigOf(gw, key, ids);
  if (provisioned.get(machineId)?.sig === sig) return { ok: true, cached: true, models: ids.map(aliasFor) };
  const pending = provisioning.get(machineId);
  if (pending?.sig === sig) return pending.promise;
  const promise = (async () => {
    try {
      const r = await rpc(machineId, 'kimi.deepseek.provision', { gateway: gw, apiKey: key, models: ids.map(kimiModel) }, 60_000);
      provisioned.set(machineId, { sig, at: Date.now() });
      if (r?.secondaryModel) secondary.set(machineId, r.secondaryModel);
      else secondary.delete(machineId);
      if (r?.sessionHeader === false) headerWarnings.set(machineId, r.warning || '沒有加上 session 標頭');
      else headerWarnings.delete(machineId);
      return r;
    } catch (err) {
      provisioned.delete(machineId);
      throw tooOld(err, machines.getMachine(machineId));
    } finally {
      provisioning.delete(machineId);
    }
  })();
  provisioning.set(machineId, { sig, promise });
  return promise;
}

// The key or gateway changed: the computers that have the provider get the
// new one now (best effort), so a revoked key does not linger in their Kimi.
// Resolves to the ids of the computers it was changed on.
export async function reprovision({ rpc = machines.rpc } = {}) {
  const done = [];
  if (!apiKey()) return done;
  await Promise.all(
    [...provisioned.keys()].map(async (id) => {
      try {
        const r = await ensureProvider(id, { rpc });
        if (!r.cached) done.push(id);
      } catch {}
    }),
  );
  return done;
}

// The computer's Kimi may have lost the provider (its config was edited, or
// it was reinstalled): ask for it again next time.
export const forgetProvider = (machineId) => provisioned.delete(machineId);
machines.onBridgeHello((id) => forgetProvider(id));

// Take the provider (and the key in it) off the computers it was put on.
export async function removeProviders({ rpc = machines.rpc } = {}) {
  const ids = [...provisioned.keys()];
  await Promise.all(ids.map((id) => rpc(id, 'kimi.deepseek.remove', {}, 30_000).catch(() => null)));
  provisioned.clear();
  headerWarnings.clear();
}

// A computer's [secondary_model], as the bridge last saw it (see
// secondaryModels for asking).
const secondary = new Map();

// The computers whose Kimi has a [secondary_model]: subagents of a DeepSeek
// conversation may run on it, and it may be a subscription model. The hub
// never changes it; the settings dialog says so.
export async function secondaryModels({ rpc = machines.rpc, list = machines.listMachines } = {}) {
  const out = [];
  await Promise.all(
    list()
      .filter((m) => m.online && m.kimi?.server)
      .map(async (m) => {
        try {
          const env = await rpc(m.id, 'kimi.request', { method: 'GET', path: '/api/v1/config' }, 10_000);
          const s = secondaryOf(env?.data);
          if (s) out.push({ machineId: m.id, machineName: m.name, ...s });
        } catch {}
      }),
  );
  return out;
}

// [secondary_model] in Kimi's GET /config answer (the same reading the
// bridge makes).
export function secondaryOf(cfg) {
  const s = cfg?.secondary_model;
  if (!s || typeof s !== 'object') return null;
  const pick = (camel, snake) => s[camel] ?? s[snake];
  const pool = pick('models', 'models');
  const names = pool && typeof pool === 'object' ? Object.keys(pool) : [];
  const model = pick('defaultModel', 'default_model') ?? pick('model', 'model') ?? names[0];
  return model ? { model: String(model), models: names, force: pick('force', 'force') === true } : null;
}

// ------------------------------------------------------- recognizing one

export const aliasFor = (id) => `${MODEL_PREFIX}${id}`;
export const isDeepseekModel = (id) => typeof id === 'string' && id.startsWith(MODEL_PREFIX);
// A conversation is a DeepSeek one if it was started as such, or its model
// is one of the DeepSeek provider's.
export const isDeepseek = (s) => s?.mode === 'deepseek' || isDeepseekModel(s?.meta?.model);
