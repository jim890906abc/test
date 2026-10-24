// Every source of models a conversation can run on, and putting them into the
// Kimi Code CLI of each connected computer.
//
// A conversation is ONE kind of thing: a Kimi conversation on a computer,
// whatever its model. The model comes from one of three sources:
//   kimi      the computer's own models (the Kimi subscription); always there
//   deepseek  DeepSeek through a gateway's API key (the Kimi provider
//             `agent-hub-deepseek`), present when that key is set
//   claude    Claude through the Anthropic API key (the Kimi provider
//             `agent-hub-claude`, of type `anthropic`), present when that key
//             is set
// Any of them can be the main model, and any can be a subagent's model: the
// hub keeps Kimi's global `[secondary_model]` pool (through the bridge's
// kimi.subagents.sync) with every model of every source, and tells each
// conversation, in a hidden note, which one its subagents use.
//
// What the hub never does: make a DeepSeek or Claude model Kimi's global
// default (the bridge guards that too), or touch the Kimi subscription login.
//
// The bridge ops (0.9.0 and later):
//   kimi.hub.provision { provider: 'deepseek' | 'claude', gateway?, apiKey, models }
//   kimi.hub.remove { provider }
//   kimi.subagents.sync { models: { alias: description }, efforts: { alias: effort } }
// An older bridge only has kimi.deepseek.provision / kimi.deepseek.remove:
// DeepSeek works as before, but Claude and subagent models need the 連接器
// run again on that computer.
import crypto from 'node:crypto';
import * as store from './store.js';
import * as machines from './machines.js';
import * as deepseek from './deepseek-account.js';
import * as claude from './claude-account.js';

export const SOURCES = ['kimi', 'deepseek', 'claude'];
export const PROVIDER_IDS = { deepseek: 'agent-hub-deepseek', claude: 'agent-hub-claude' };
export const MIN_BRIDGE = '0.9.0';
// What a subagent's thinking can be set to (the provider models' efforts).
const EFFORT_NAMES = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PROVIDER_MODELS = 20; // what the bridge takes per provider

// ------------------------------------------------------- recognizing one

// Where a model comes from (and so where its tokens are billed): the alias
// is `agent-hub-deepseek/<id>` or `agent-hub-claude/<id>`; anything else is
// Kimi's (the subscription, or whatever the computer's own Kimi has).
export function familyOf(alias) {
  const a = String(alias ?? '');
  if (a.startsWith(`${PROVIDER_IDS.deepseek}/`)) return 'deepseek';
  if (a.startsWith(`${PROVIDER_IDS.claude}/`)) return 'claude';
  return 'kimi';
}
export const aliasOf = (source, id) => `${PROVIDER_IDS[source]}/${id}`;
export const FAMILY_NAME = { kimi: 'Kimi', deepseek: 'DeepSeek', claude: 'Claude' };

// A conversation's family: that of the model it runs on now. Before it has
// one, the model it was made for; for DeepSeek conversations made before the
// modes were merged (mode: 'deepseek'), DeepSeek. The old Claude daemon
// conversations are Claude (billed to the Claude API key); other agents
// (ACP, OpenAI, CLI) have none (null).
export function sessionFamily(s) {
  if (!s) return null;
  if (s.agentId === 'claude') return 'claude';
  if (!s.kimiSessionId) return null;
  const model = s.meta?.model || s.state?.intendedModel || s.state?.deepseek?.model;
  if (model) return familyOf(model);
  return s.mode === 'deepseek' ? 'deepseek' : 'kimi';
}

// Where the tokens go, in words.
export function billingOf(family) {
  if (family === 'deepseek') return `${deepseek.GATEWAYS[deepseek.gateway()]?.label || 'DeepSeek 閘道'} 的 API key`;
  if (family === 'claude') return 'Claude Console 的 API key（按量計費）';
  return 'Kimi 訂閱';
}

// The line shown after a conversation's model moves to another source.
export function switchNote(name, to) {
  return to === 'kimi' ? `改用 ${name}：之後的回合算在 Kimi 訂閱` : `改用 ${name}：之後的回合算在 ${billingOf(to)}，不用 Kimi 訂閱`;
}

// ---------------------------------------------------------- the bridge

export function versionAtLeast(version, min) {
  const parts = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
export const hubCapable = (m) => versionAtLeast(m?.bridgeVersion, MIN_BRIDGE);

const oldConnector = (m) => `「${m?.name || '這台電腦'}」的連接器太舊，不支援 Claude 模型和子代理模型。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`;
// The user's own Kimi locks its subagent models ([secondary_model].force).
export const FORCED = '這台電腦的 Kimi 鎖定了子代理模型（force），中控台沒有改它';
// An older bridge does not know an op.
const isUnknownOp = (err) => /未知的操作/.test(err?.message || '');
const asOld = (err, m) => (isUnknownOp(err) ? Object.assign(new Error(oldConnector(m)), { status: 409, code: 'old_connector' }) : err);

const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// What the hub needs from Kimi's side, set by the adapter (avoids an import
// cycle): `machineModels(machineId)` → { models: [info], defaultModel, pool },
// and `forgetModels(machineId)` for when the computer's Kimi changed.
const deps = { machineModels: async () => null, forgetModels: () => {} };
export function init(d) {
  Object.assign(deps, d);
}

// ------------------------------------------------------------- one model

// The thinking-effort choices Kimi's own /effort picker offers for a model.
export function effortsFor(model) {
  const caps = model.capabilities || [];
  const efforts = model.support_efforts || [];
  const always = caps.includes('always_thinking');
  if (efforts.length) return always ? efforts : ['off', ...efforts];
  if (always) return ['on'];
  if (caps.includes('thinking') || model.adaptive_thinking) return ['off', 'on'];
  return [];
}

// One model as the composer shows it. `m` is a Kimi model (the shape of
// Kimi's GET /models, and of what the hub gives a provider); `alias` its id.
export function modelInfo(m, alias = m.model) {
  const family = familyOf(alias);
  const defaultEffort = family === 'deepseek' ? deepseek.DEFAULT_EFFORT : family === 'claude' ? claude.modelInfo(String(alias).slice(PROVIDER_IDS.claude.length + 1)).defaultEffort || m.default_effort || null : m.default_effort || null;
  return {
    id: alias,
    name: m.display_name || String(alias).split('/').pop(),
    efforts: effortsFor(m),
    defaultEffort,
    image: (m.capabilities || []).includes('image_in'),
    context: m.max_context_size || null,
    family,
    ...(family === 'deepseek' ? { deepseek: true } : {}),
  };
}

// A DeepSeek or Claude model as the composer shows it, from what the hub
// knows (a Kimi model is the computer's to say); null for any other alias.
export function hubModelInfo(alias) {
  const family = familyOf(alias);
  const id = String(alias).slice(PROVIDER_IDS[family]?.length + 1);
  if (family === 'deepseek') return modelInfo(deepseek.kimiModel(id), alias);
  if (family === 'claude') return modelInfo(claude.kimiModel(id), alias);
  return null;
}

// What a model is for, in a line the main model reads to pick a subagent's.
function strengthOf(alias, name) {
  const t = `${alias} ${name || ''}`.toLowerCase();
  switch (familyOf(alias)) {
    case 'claude':
      if (/opus|fable|mythos/.test(t)) return 'strongest Claude: hard coding, review and planning';
      if (/haiku/.test(t)) return 'fast and cheap: simple lookups and edits';
      return 'balanced Claude: everyday coding and writing';
    case 'deepseek':
      if (/pro/.test(t) && !/flash/.test(t)) return 'deeper reasoning for hard problems';
      return 'fast and cheap: reading many files, searching, simple edits';
    default:
      if (/flash|mini|lite|fast/.test(t)) return 'fast and light work';
      return 'general coding and long-context work';
  }
}

// The text Kimi shows the main model for a pool entry.
export function describeModel(alias, name) {
  const family = familyOf(alias);
  const billing = { kimi: '訂閱', deepseek: 'DeepSeek 閘道 key', claude: 'Claude API key' }[family];
  return `${name || alias.split('/').pop()} (${FAMILY_NAME[family]}, ${billing}) - ${strengthOf(alias, name)}`.slice(0, 200);
}

// --------------------------------------------------- the keyed sources

// The Claude models given to Kimi: the ones the key can use, the hub's known
// ones first, at most what the bridge takes.
export async function claudeModelIds(opts = {}) {
  const list = opts.claudeModels ? await opts.claudeModels() : await claude.models();
  return [...new Set(list.map((m) => (typeof m === 'string' ? m : m.id)))].slice(0, MAX_PROVIDER_MODELS);
}

// What a keyed source gives Kimi: the bridge request, and the models as
// { alias, id, spec }. null when it has no key.
async function wanted(source, opts = {}) {
  if (source === 'deepseek') {
    const gw = deepseek.gateway();
    const key = deepseek.apiKey(gw);
    if (!key) return null;
    const ids = deepseek.modelIds(gw);
    const specs = ids.map((id) => deepseek.kimiModel(id));
    return { source, sig: hash([gw, key, specs]), request: { provider: 'deepseek', gateway: gw, apiKey: key, models: specs }, models: ids.map((id, i) => ({ alias: deepseek.aliasFor(id), id, spec: specs[i] })) };
  }
  const key = claude.apiKey();
  if (!key) return null;
  const ids = await claudeModelIds(opts);
  const specs = ids.map((id) => claude.kimiModel(id));
  return { source, sig: hash([key, specs]), request: { provider: 'claude', apiKey: key, models: specs }, models: ids.map((id, i) => ({ alias: aliasOf('claude', id), id, spec: specs[i] })) };
}

// Subagent efforts set in 設定, per model alias (global to every computer:
// Kimi keeps a subagent's effort per model, not per conversation).
export function cleanEfforts(v) {
  const out = {};
  if (v && typeof v === 'object') {
    for (const [alias, effort] of Object.entries(v)) {
      if (typeof alias === 'string' && alias.length <= 200 && familyOf(alias) !== 'kimi' && EFFORT_NAMES.includes(effort)) out[alias] = effort;
    }
  }
  return out;
}
export const subagentEfforts = (settings = store.readSettings()) => cleanEfforts(settings.subagentEfforts);

// The efforts the pool is given: what 設定 says for a DeepSeek or Claude
// model that has the effort; DeepSeek otherwise at max (Kimi falls back to
// high when a model has none). Kimi's own models have nothing to set.
const effortOf = (source, alias, spec, saved) => {
  const want = saved[alias] ?? (source === 'deepseek' ? deepseek.DEFAULT_EFFORT : undefined);
  return want && (spec.support_efforts || []).includes(want) ? want : null;
};
function poolEfforts(sources, saved) {
  const out = {};
  for (const w of sources) for (const x of w.models) if (effortOf(w.source, x.alias, x.spec, saved)) out[x.alias] = effortOf(w.source, x.alias, x.spec, saved);
  return out;
}

// ------------------------------------------------- Kimi on the computers

// Per computer: which provider requests Kimi has (by signature), what the
// pool was last synced to, and what the bridge said about it.
const states = new Map();
const stateOf = (id) => {
  let s = states.get(id);
  if (!s) states.set(id, (s = { providers: {}, errors: {}, sync: null, pool: null, forced: false, scope: 'per-model', warning: null, poolError: null, failedAt: 0 }));
  return s;
};
const running = new Map(); // machine id -> { epoch, promise }
let epoch = 0; // bumped when keys or models change: a run started before it is not shared

const noKey = (source) =>
  Object.assign(new Error(source === 'claude' ? '還沒有設定 Claude API key。在「設定」→「Claude API…」貼上 Claude Console 的 API key。' : '還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409, code: 'no_key' });

async function provisionOne(machineId, w, { rpc, hub, m }) {
  if (hub) return rpc(machineId, 'kimi.hub.provision', w.request, 60_000).catch((err) => Promise.reject(asOld(err, m)));
  // An older bridge: DeepSeek as before; Claude needs the connector run again.
  if (w.source !== 'deepseek') throw Object.assign(new Error(oldConnector(m)), { status: 409, code: 'old_connector' });
  const { gateway, apiKey, models } = w.request;
  return rpc(machineId, 'kimi.deepseek.provision', { gateway, apiKey, models }, 60_000).catch((err) => Promise.reject(asOld(err, m)));
}

async function removeOne(machineId, source, { rpc, hub }) {
  try {
    if (hub) await rpc(machineId, 'kimi.hub.remove', { provider: source }, 30_000);
    else if (source === 'deepseek') await rpc(machineId, 'kimi.deepseek.remove', {}, 30_000);
  } catch {}
}

// Tell Kimi the models subagents may run on. Resolves to what happened.
async function syncPool(machineId, st, { rpc, m }, kimiList, sources, force) {
  const models = {};
  for (const k of kimiList) models[k.id] = describeModel(k.id, k.name);
  for (const w of sources) for (const x of w.models) models[x.alias] = describeModel(x.alias, x.spec.display_name);
  const efforts = poolEfforts(sources, subagentEfforts());
  const sig = hash([models, efforts]);
  if (!force && st.sync === sig) return { cached: true };
  // Not again and again after an error.
  if (!force && st.failedAt && Date.now() - st.failedAt < 60_000) return { cached: true, failed: true };
  try {
    const r = await rpc(machineId, 'kimi.subagents.sync', { models, efforts }, 60_000);
    st.sync = sig;
    st.failedAt = 0;
    st.poolError = null;
    st.forced = r?.skipped === 'force';
    st.pool = st.forced ? null : r?.pool && typeof r.pool === 'object' ? { defaultModel: r.pool.defaultModel || '', models: Array.isArray(r.pool.models) ? r.pool.models : Object.keys(r.pool.models || {}) } : null;
    st.scope = st.forced || r?.efforts === null ? 'none' : 'per-model';
    st.warning = r?.warning ? String(r.warning) : null;
    st.written = r?.efforts && typeof r.efforts === 'object' ? r.efforts : {};
    if (st.forced) st.poolError = FORCED;
    return { synced: true, result: r };
  } catch (err) {
    st.sync = null;
    st.failedAt = Date.now();
    st.poolError = asOld(err, m).message;
    console.warn(`[providers] subagent models on ${machineId}: ${st.poolError}`);
    return { failed: true, error: err };
  }
}

async function run(machineId, opts) {
  const rpc = opts.rpc || ((...a) => machines.rpc(...a));
  const m = opts.machine || machines.getMachine(machineId);
  const hub = opts.hub ?? hubCapable(m);
  const ctx = { rpc, hub, m };
  const st = stateOf(machineId);
  const out = { provisioned: [], removed: [], errors: {}, have: {}, synced: false };
  const sources = [];
  for (const source of ['deepseek', 'claude']) {
    // Claude needs the new ops: an old bridge cannot have it.
    if (source === 'claude' && !hub && claude.apiKey()) {
      out.have.claude = true;
      out.errors.claude = Object.assign(new Error(oldConnector(m)), { status: 409, code: 'old_connector' });
      st.errors.claude = out.errors.claude.message;
      continue;
    }
    const w = await wanted(source, opts);
    out.have[source] = Boolean(w);
    if (!w) {
      // The key is gone (or was asked to be): the provider leaves Kimi.
      if (st.providers[source] || (opts.purge || []).includes(source)) {
        await removeOne(machineId, source, ctx);
        delete st.providers[source];
        out.removed.push(source);
      }
      delete st.errors[source];
      if (source === 'deepseek') deepseek.setHeaderWarning(machineId, null);
      continue;
    }
    // Only a provider Kimi has has models for the pool.
    if (st.providers[source] === w.sig) {
      sources.push(w);
      continue;
    }
    try {
      const r = await provisionOne(machineId, w, ctx);
      st.providers[source] = w.sig;
      sources.push(w);
      delete st.errors[source];
      out.provisioned.push(source);
      if (source === 'deepseek') deepseek.setHeaderWarning(machineId, r?.sessionHeader === false ? r.warning || '沒有加上 session 標頭' : null);
    } catch (err) {
      delete st.providers[source];
      st.errors[source] = err.message;
      out.errors[source] = err;
    }
  }
  const changed = out.provisioned.length > 0 || out.removed.length > 0;
  if (hub) {
    // Kimi's own models, for the pool (skipped while its server is not running).
    const kimiList = await (async () => {
      if (opts.kimiModels) return opts.kimiModels(machineId);
      const v = await deps.machineModels(machineId);
      return v && v.models.filter((x) => familyOf(x.id) === 'kimi').map((x) => ({ id: x.id, name: x.name }));
    })().catch(() => null);
    if (kimiList) {
      // A provisioned provider loses what the pool had set for its models:
      // the pool is sent again after every provision.
      const r = await syncPool(machineId, st, ctx, kimiList, sources, changed);
      out.synced = Boolean(r.synced);
      if (r.synced) out.sync = r.result;
      if (r.failed && !r.cached) out.syncError = r.error;
    } else out.syncSkipped = true;
  } else {
    st.pool = null;
    st.sync = null;
    st.forced = false;
    st.scope = 'none';
    st.poolError = oldConnector(m);
  }
  if (changed || out.synced) deps.forgetModels(machineId);
  return out;
}

// Make sure `machineId`'s Kimi has the providers of every source with a key,
// and the pool of subagent models. Asked of the bridge once per (computer,
// keys, models, efforts); again when any of those changes, when the computer
// reconnects (its bridge said hello), or after an error. A source that fails
// does not stop the others; `need` names the source the caller cannot do
// without ('deepseek' | 'claude'), whose failure (or missing key) throws.
// Resolves to { ok, cached, provisioned, removed, errors, synced, pool }.
// opts: need, purge ([source]: take that provider off even if this process
// did not put it there), and the pieces tests replace (rpc, machine,
// kimiModels, claudeModels).
export async function ensureProviders(machineId, opts = {}) {
  const cur = running.get(machineId);
  let promise;
  if (cur && cur.epoch === epoch && !opts.purge) promise = cur.promise;
  else {
    const before = cur ? cur.promise.catch(() => {}) : Promise.resolve();
    promise = before.then(() => run(machineId, opts));
    const mine = { epoch, promise };
    running.set(machineId, mine);
    promise.catch(() => {}).finally(() => running.get(machineId) === mine && running.delete(machineId));
  }
  const r = await promise;
  if (opts.need) {
    if (!r.have[opts.need]) throw noKey(opts.need);
    if (r.errors[opts.need]) throw r.errors[opts.need];
  }
  const st = stateOf(machineId);
  return { ok: true, cached: !r.provisioned.length && !r.removed.length && !r.synced, ...r, pool: st.pool };
}

// Keys or models changed: every computer that has the providers (or runs
// Kimi now) gets the new ones, best effort, and a key that was removed
// leaves their Kimi. `purge`: the sources whose key was removed.
export async function refreshAll({ purge = [], ...opts } = {}) {
  epoch++;
  const targets = machines.listMachines().filter((m) => m.online && (states.has(m.id) || m.kimi?.server || (purge.length && m.kimi?.available)));
  await Promise.all(
    targets.map((m) =>
      ensureProviders(m.id, { ...opts, ...(purge.length ? { purge } : {}) }).catch((err) => console.warn(`[providers] ${m.id}: ${err.message}`)),
    ),
  );
}

// The computer's Kimi may have lost the providers (its config was edited, or
// it was reinstalled): ask for them again next time.
export function forget(machineId) {
  states.delete(machineId);
  deepseek.setHeaderWarning(machineId, null);
  epoch++;
}
// A computer reconnected: start over with it; its Kimi gets the providers
// and the pool again if it is running.
machines.onBridgeHello((id) => {
  forget(id);
  if (machines.getMachine(id)?.kimi?.server) ensureProviders(id).catch((err) => console.warn(`[providers] ${id}: ${err.message}`));
});

// The subagent pool of a computer, as the hub knows it: `available` is false
// when the bridge is too old or the user's Kimi locks the pool (force);
// `models` are the aliases Kimi has in it.
export function poolState(machineId, m = machines.getMachine(machineId)) {
  const st = states.get(machineId);
  if (m && !hubCapable(m)) return { available: false, reason: oldConnector(m), models: [], defaultModel: '', synced: false, scope: 'none', warning: null };
  if (st?.forced) return { available: false, reason: st.poolError, models: [], defaultModel: '', synced: true, scope: 'none', warning: null };
  return {
    available: true,
    reason: null,
    models: st?.pool?.models || [],
    defaultModel: st?.pool?.defaultModel || '',
    synced: Boolean(st?.pool),
    scope: st?.scope || 'per-model',
    warning: st?.warning || st?.poolError || null,
  };
}

// For tests: forget everything this process knows.
export function reset() {
  states.clear();
  running.clear();
  epoch++;
}

// -------------------------------------------------------- the catalog

const SOURCE_LABEL = { kimi: 'Kimi', deepseek: 'DeepSeek', claude: 'Claude' };

// GET /api/models: every model a new conversation on `machineId` can start
// on, by source, and whether the computer takes subagent models.
export async function catalog(machineId, opts = {}) {
  const m = opts.machine ?? (machineId ? machines.getMachine(machineId) : null);
  const online = Boolean(m?.online);
  const hub = hubCapable(m);
  const sources = [];
  const saved = subagentEfforts();

  // kimi: the computer's own models (not the providers the hub made).
  let kimi = null;
  if (online && m.kimi?.server) kimi = await (opts.machineModels || deps.machineModels)(machineId).catch(() => null);
  sources.push({
    id: 'kimi',
    label: SOURCE_LABEL.kimi,
    billing: billingOf('kimi'),
    ready: Boolean(kimi),
    ...(kimi ? {} : { note: !machineId ? '請先選一台電腦' : !m ? '找不到這台電腦' : !online ? `「${m.name}」目前離線` : 'Kimi 還沒啟動（建立對話時會自動啟動）' }),
    defaultModel: kimi?.defaultModel || '',
    models: (kimi?.models || []).filter((x) => familyOf(x.id) === 'kimi').map((x) => ({ ...x, family: 'kimi' })),
  });

  // deepseek: its key's models (the old bridges take them too).
  if (deepseek.apiKey()) {
    const gw = deepseek.gateway();
    const st = states.get(machineId);
    const ids = deepseek.modelIds(gw);
    sources.push({
      id: 'deepseek',
      label: SOURCE_LABEL.deepseek,
      billing: billingOf('deepseek'),
      gateway: { id: gw, label: deepseek.GATEWAYS[gw].label },
      ready: !machineId || online,
      ...(st?.errors.deepseek ? { note: st.errors.deepseek } : machineId && !online ? { note: '電腦離線' } : {}),
      defaultModel: deepseek.aliasFor(deepseek.settings(gw).defaults.model),
      models: ids.map((id) => ({ ...modelInfo(deepseek.kimiModel(id), deepseek.aliasFor(id)), subagentEffort: effortOf('deepseek', deepseek.aliasFor(id), deepseek.kimiModel(id), saved) })),
    });
  }

  // claude: its key's models, in a Kimi provider (a bridge from 0.9.0).
  if (claude.apiKey()) {
    const st = states.get(machineId);
    const ids = await claudeModelIds(opts).catch(() => []);
    sources.push({
      id: 'claude',
      label: SOURCE_LABEL.claude,
      billing: billingOf('claude'),
      ready: !machineId || (online && hub),
      ...(machineId && online && !hub ? { note: oldConnector(m) } : st?.errors.claude ? { note: st.errors.claude } : machineId && !online ? { note: '電腦離線' } : {}),
      defaultModel: aliasOf('claude', claude.DEFAULT_MODEL),
      models: ids.map((id) => ({ ...modelInfo(claude.kimiModel(id), aliasOf('claude', id)), subagentEffort: effortOf('claude', aliasOf('claude', id), claude.kimiModel(id), saved) })),
    });
  }

  const pool = machineId && m ? poolState(machineId, m) : { available: true, reason: null, models: [], defaultModel: '', synced: false, scope: 'per-model', warning: null };
  return {
    sources,
    // Kimi keeps a subagent's effort per model (not per conversation): set
    // for all conversations on a computer; 'none' where the computer's Kimi
    // takes no subagent models.
    subagentEffortScope: pool.scope,
    subagents: { available: pool.available, reason: pool.reason, synced: pool.synced, pool: pool.models, warning: pool.warning },
  };
}
