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
// sent to a browser; pages see only the last four characters. The file is
// written whole or not at all (flushed to disk first), and a file that is there
// but cannot be used is never taken for "no keys": it is copied into
// data/damaged-config/, said, shown to the person (`damaged` in the account),
// and written over only when they type a key in again (store.GuardedConfig).
// They go to the
// bridge over its authenticated channel. New pool connectors keep them in
// private bridge state and put only a random local credential in Kimi; the
// legacy single-key direct mode may still put that one key in Kimi's config.
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, GuardedConfig } from './store.js';
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

export const isGateway = (id) => Object.hasOwn(GATEWAYS, id);

const newKeyId = () => `dk_${crypto.randomBytes(8).toString('hex')}`;
// The gap between real requests that look again at an exhausted key whose
// gateway named no reset time (milliseconds; AGENT_HUB_DEEPSEEK_RETRY_MS, default
// 30 seconds). It is how often a probe may happen, never a guess of when the
// key comes back: that is only ever a time the gateway STATED (retryAt). The
// same number goes to every connector in a provision, so the hub and the
// proxies agree on when a key may be looked at again.
export const retryMs = () => {
  const n = Number(process.env.AGENT_HUB_DEEPSEEK_RETRY_MS);
  return Number.isInteger(n) && n >= 1000 && n <= 35 * 86_400_000 ? n : 30_000;
};
// A key its gateway REFUSES (HTTP 401, 2026-10-29) is not a key that is out of
// quota: it has its own fields - authFailedAt, authFailures (refusals in a row)
// and authRetryAt (when a real request may look at it again, as the connector
// scheduled it) - and no reset time, because a 401 says nothing about when a key
// might work again. The gaps are the connector's: 1 minute after the first
// refusal, double with each new one, 60 minutes at most. They are only how often
// the key is probed. A key is refused or exhausted, never both.
const MIN_MS = 60_000;
const AUTH_FIRST_GAP_MS = 60_000;
const AUTH_MAX_GAP_MS = 3_600_000;
const AUTH_MAX_FAILURES = 60;
export const authGapMs = (failures) => {
  const n = Math.min(Math.max(1, Math.round(Number(failures)) || 1), AUTH_MAX_FAILURES);
  return Math.min(AUTH_MAX_GAP_MS, AUTH_FIRST_GAP_MS * 2 ** Math.min(n - 1, 40));
};
// Out of use: exhausted (quota, a gateway's word or a person's mark) or refused.
const isBlocked = (k) => Boolean(k?.exhaustedAt || k?.authFailedAt);
// Refused by its gateway (and not, since, exhausted).
const isRefused = (k) => Boolean(k?.authFailedAt && !k.exhaustedAt);
const dropAuth = (k) => {
  delete k.authFailedAt;
  delete k.authFailures;
  delete k.authRetryAt;
};
const dropExhaustion = (k) => {
  delete k.exhaustedAt;
  delete k.retryAt;
  delete k.exhaustedRev;
};
// When a blocked key may be looked at again (0: it is not out of use; Infinity:
// a person marked it full, only a person clears that).
export const retryAtOf = (k) => {
  if (isRefused(k)) return k.authRetryAt || k.authFailedAt + authGapMs(k.authFailures);
  return k?.exhaustedAt ? (k.manual ? Infinity : k.retryAt || k.exhaustedAt + retryMs()) : 0;
};
// A key a request may use: healthy, or out of use with its wait over (the
// connector's next real request is then the probe). Never one a person marked.
const isUsable = (k, now = Date.now()) => !isBlocked(k) || (!k.manual && retryAtOf(k) <= now);
const firstUsable = (keys, now = Date.now()) => keys.find((k) => !isBlocked(k)) || keys.find((k) => isUsable(k, now)) || keys[0] || null;
// Out of quota, but the gateway STATED when it comes back (retryAt) and that time has
// passed (2026-10-30): the key is not "full" any more, it only waits for the next real
// request to confirm it. A connector that says `pool_reset_due` puts such a key back
// into its rotation by itself. A key with no stated time is not due (it is probed the
// old way), and neither is one a person marked or one the gateway refused (401).
export const isResetDue = (k, now = Date.now()) => Boolean(k?.exhaustedAt && !k.manual && k.retryAt && k.retryAt <= now);
// In use as far as the Hub knows: not set aside, or only waiting to be confirmed.
const isAvailable = (k, now = Date.now()) => !isBlocked(k) || isResetDue(k, now);

const cleanFailures = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(AUTH_MAX_FAILURES, Math.max(1, Math.round(n))) : 1;
};
// The connector's schedule for the next real try of a refused key, or 0 when it
// is not believable (not after the failure, or further away than the longest gap).
const cleanAuthRetryAt = (v, failedAt) => {
  const t = Number(v);
  return Number.isFinite(t) && t >= failedAt && t <= failedAt + AUTH_MAX_GAP_MS ? Math.round(t) : 0;
};

// One gateway's keys: the old single string (one key) and the current
// { revision, activeId, keys[] } both load into the same shape, so an update
// never loses a key a user already saved.
function normalizePool(raw) {
  const pool = { revision: 1, activeId: '', keys: [] };
  const seen = new Set();
  if (typeof raw === 'string') {
    const key = raw.trim();
    if (key) pool.keys.push({ id: newKeyId(), key, addedAt: Date.now() });
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.keys)) {
    for (const item of raw.keys) {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const id = typeof item.id === 'string' && /^[\w-]{1,64}$/.test(item.id) && !pool.keys.some((k) => k.id === item.id) ? item.id : newKeyId();
      const out = { id, key, addedAt: Number(item.addedAt) || Date.now() };
      const exhaustedAt = Number(item.exhaustedAt);
      if (Number.isFinite(exhaustedAt) && exhaustedAt > 0) {
        out.exhaustedAt = exhaustedAt;
        const retryAt = Number(item.retryAt);
        if (item.retryAt != null && Number.isFinite(retryAt) && retryAt > 0) out.retryAt = retryAt;
        const exhaustedRev = Number(item.exhaustedRev);
        if (Number.isInteger(exhaustedRev) && exhaustedRev > 0) out.exhaustedRev = exhaustedRev;
        if (item.manual === true) out.manual = true;
      }
      // A refused key (see isRefused): the later of the two facts stands, and a
      // person's mark is never replaced.
      const authFailedAt = Number(item.authFailedAt);
      if (Number.isFinite(authFailedAt) && authFailedAt > 0 && !out.manual && !(out.exhaustedAt && out.exhaustedAt >= authFailedAt)) {
        dropExhaustion(out);
        out.authFailedAt = authFailedAt;
        out.authFailures = cleanFailures(item.authFailures);
        const authRetryAt = cleanAuthRetryAt(item.authRetryAt, authFailedAt);
        if (authRetryAt) out.authRetryAt = authRetryAt;
      }
      pool.keys.push(out);
    }
    const revision = Number(raw.revision);
    if (Number.isInteger(revision) && revision > 0) pool.revision = revision;
    if (typeof raw.activeId === 'string' && pool.keys.some((k) => k.id === raw.activeId)) pool.activeId = raw.activeId;
  }
  if (!pool.activeId) pool.activeId = firstUsable(pool.keys)?.id || '';
  return pool;
}

function normalizeSaved(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  let dirty = false;
  const pools = {};
  const rawPools = data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys) ? data.keys : {};
  for (const id of Object.keys(GATEWAYS)) {
    if (!rawPools[id]) continue;
    const pool = normalizePool(rawPools[id]);
    if (JSON.stringify(rawPools[id]) !== JSON.stringify(pool)) dirty = true;
    pools[id] = pool;
  }
  if (JSON.stringify(rawPools) !== JSON.stringify(pools)) dirty = true;
  data.keys = pools;

  // The one order the keys are used in, across gateways. A file from before it
  // existed (one pool per gateway) becomes one list in the order it already had:
  // the gateway that was in use first, the others after it, each gateway's keys
  // in their own order. A key the saved order does not name goes to the end;
  // a name that is no key any more is dropped. No key is lost or changed.
  const selected = isGateway(data.gateway) ? data.gateway : DEFAULT_GATEWAY;
  const gatewayOrder = [selected, ...Object.keys(GATEWAYS).filter((g) => g !== selected)];
  const order = [];
  const have = new Set(gatewayOrder.flatMap((g) => (pools[g]?.keys || []).map((k) => k.id)));
  if (Array.isArray(data.order)) for (const id of data.order) if (typeof id === 'string' && have.has(id) && !order.includes(id)) order.push(id);
  for (const g of gatewayOrder) for (const k of pools[g]?.keys || []) if (!order.includes(k.id)) order.push(k.id);
  // (A file that has no order yet is not rewritten for it: the same order comes
  // out of the same file next time, and the first change saves it.)
  if (Array.isArray(data.order) && JSON.stringify(data.order) !== JSON.stringify(order)) dirty = true;
  data.order = order;
  // Moves that belong to no gateway's pool (a new order, a person's mark) count
  // here, so the whole list has a revision that only goes up.
  const epoch = Number(data.epoch);
  const cleanEpoch = Number.isInteger(epoch) && epoch > 0 ? epoch : 0;
  if (data.epoch !== undefined && data.epoch !== cleanEpoch) dirty = true;
  data.epoch = cleanEpoch;

  // How keys are given out (see distribution()): only the two names mean
  // anything; a file that says something else is read as the default.
  if (data.distribution !== undefined && data.distribution !== 'sticky' && data.distribution !== 'relay') {
    delete data.distribution;
    dirty = true;
  }

  // Each machine's latest report, kept across a hub restart. Only known
  // gateways, revisions and string ids get this far; no key material.
  const activity = {};
  const rawActivity = data.activity && typeof data.activity === 'object' && !Array.isArray(data.activity) ? data.activity : {};
  for (const [machineId, a] of Object.entries(rawActivity)) {
    if (!a || !isGateway(a.gateway)) continue;
    const revision = Number(a.revision);
    if (!Number.isInteger(revision) || revision < 1) continue;
    activity[String(machineId).slice(0, 64)] = {
      gateway: a.gateway,
      activeId: typeof a.activeId === 'string' ? a.activeId.slice(0, 64) : null,
      revision,
      at: Number(a.at) || Date.now(),
      ...(a.rotation === true ? { rotation: true } : {}),
    };
  }
  if (JSON.stringify(rawActivity) !== JSON.stringify(activity)) dirty = true;
  data.activity = activity;
  return { data, dirty };
}

const keyFile = new GuardedConfig(FILE, {
  tag: 'deepseek',
  what: 'DeepSeek 金鑰池',
  lost: 'DeepSeek 金鑰池（API key）已無法載入，請重新輸入或從備份還原（左下角「⋯」→「DeepSeek…」）',
  until: '重新輸入 API key',
});

function load() {
  return normalizeSaved(keyFile.read().value ?? {});
}
const loaded = load();
let saved = loaded.data;
if (loaded.dirty) save();

// Why the saved pool cannot be used (its file is damaged or cannot be read), or
// null. Said instead of "no key is set" wherever that would be said.
export const keyProblem = () => keyFile.describe();

// The state in memory, on disk whole or not at all (private, flushed first).
// Without `explicit` this is the Hub's own bookkeeping (a rotated key's health,
// a computer's report, the model list a key can see): it is not worth writing
// over a file that cannot be used, so it is kept in memory only (false). With
// it, a person typed a key in, which may replace a damaged file (throws
// ConfigBlockedError when nothing may be written).
function save({ explicit = false } = {}) {
  if (explicit) keyFile.write(saved, { mode: 0o600, explicit });
  else return keyFile.writeIfAllowed(saved, { mode: 0o600 });
  return true;
}

// For the tests: read the file again.
export function reload() {
  saved = load().data;
  provisioned.clear();
  stickyReports.clear();
  rateReports.clear();
  headerWarnings.clear();
  jobs.clear();
  tails.clear();
  epochs.clear();
  secondary.clear();
  provisionWarnings.clear();
  autoFailures.clear();
  scheduledProvisions.clear();
  for (const r of retries.values()) clearTimeout(r.timer);
  retries.clear();
}

// The gateway whose model names conversations use (Kimi's provider is made from
// its list; a request to a key on another gateway gets that gateway's spelling
// of the same model, see modelMapFor). It is not the gateway "in use": the keys
// are used in one order across gateways. A key saved without choosing one goes
// to OpenCode Go.
export const gateway = () => (isGateway(saved.gateway) ? saved.gateway : DEFAULT_GATEWAY);

// Whoever keeps a record that holds a model name (the conversations) asks to be
// told when the gateway the names follow changes - by the first key of a gateway
// or by the choice in the settings, the only two ways - so one place decides
// what a change of names means for what was already written with the old ones.
const gatewayListeners = new Set();
export const onGatewayChange = (fn) => {
  gatewayListeners.add(fn);
  return () => gatewayListeners.delete(fn);
};
function gatewayMayHaveChanged(before) {
  const now = gateway();
  if (now === before) return;
  for (const fn of gatewayListeners) {
    try {
      fn(now, before);
    } catch (err) {
      console.warn(`[deepseek] gateway change listener: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------- the keys

// Why `key` cannot be a gateway key, or null.
export function checkKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return '請貼上 API key';
  if (k.length > 500) return 'API key 太長了（最多 500 個字元）';
  if (/\s/.test(k)) return 'API key 裡不能有空白或換行，請確認複製的是完整的一把 key';
  return null;
}

// The gateway's pool, or null. `keys` keeps the secret; nothing public may
// serialize this object.
export const poolOf = (gw = gateway()) => (isGateway(gw) ? saved.keys?.[gw] || null : null);
export const poolRevision = (gw = gateway()) => poolOf(gw)?.revision || 0;
export const keyById = (gw, id) => poolOf(gw)?.keys.find((k) => k.id === id) || null;

// ---- one list across gateways
// The keys live in one pool per gateway (what an older connector gets), and are
// USED in one order across them: `saved.order`, ids only. Every entry is
// { gw, k }; `k` is the stored key (secret included: never serialize it).
export function rotationEntries() {
  const found = new Map();
  for (const gw of Object.keys(GATEWAYS)) for (const k of saved.keys?.[gw]?.keys || []) found.set(k.id, { gw, k });
  const out = [];
  for (const id of saved.order || []) {
    const e = found.get(id);
    if (e) {
      out.push(e);
      found.delete(id);
    }
  }
  return [...out, ...found.values()];
}
// What a page may be told of a key by its id: its gateway and the last four
// characters, never the key. null: the Hub has no such key (it was removed).
export function keyIdentity(id) {
  const e = rotationEntries().find((x) => x.k.id === id);
  return e ? { id, gateway: e.gw, gatewayLabel: GATEWAYS[e.gw].label, hint: hint(e.k.key) } : null;
}
// The gateway a key is on, or null.
export const gatewayOfKey = (id) => rotationEntries().find((e) => e.k.id === id)?.gw || null;
// The revision of the whole list: it goes up with every change to any pool and
// with every change that belongs to none (an order, a person's mark).
export const rotationRevision = () => Object.values(saved.keys || {}).reduce((n, p) => n + (p.revision || 0), 0) + (saved.epoch || 0);
const syncOrder = () => {
  saved.order = rotationEntries().map((e) => e.k.id);
};
const bumpEpoch = () => {
  saved.epoch = (saved.epoch || 0) + 1;
};
const hasCap = (machine, name) => Array.isArray(machine?.capabilities) && machine.capabilities.includes(name);

// ---- how the keys are given out
//   'sticky'  every conversation keeps one key (the key with the fewest
//             conversations takes a new one), so the gateway's cache for it is not
//             lost and the conversations share the keys' throughput; only a key
//             that runs out or is refused moves its own conversations. The default,
//             also for a file from before this existed.
//   'relay'   every conversation uses the key in use, and the next one is taken
//             only when that runs out (the order of the list).
// It goes to the connectors with the list, but only to one that says `pool_sticky`;
// an older one relays whatever is chosen here.
export const distribution = () => (saved.distribution === 'relay' ? 'relay' : 'sticky');

// True when it changed. A change is a new version of the whole list (like a new
// order), so every computer is sent it again.
export function setDistribution(mode) {
  if (mode !== 'sticky' && mode !== 'relay') throw Object.assign(new Error('key 的分配方式只能是平均分配（sticky：每個對話固定一把）或接力（relay：用完才換下一把）'), { status: 400 });
  if (distribution() === mode) return false;
  // A file that cannot be used is not written over for this (the person is told).
  keyFile.check();
  saved.distribution = mode;
  bumpEpoch();
  save();
  return true;
}

// What each connector last said about how many conversations each key has (a
// connector in a sticky pool says it in its pool report), by computer:
// { distribution: 'sticky' | 'relay', counts: { key id: n } }. Live numbers: kept
// in memory only, forgotten when the computer reconnects (it says them again
// with its next provision) and left out while it is offline.
const stickyReports = new Map();

// ---- what connectors say about rate limits (2026-10-30)
// A connector that says `pool_rate` counts each key's requests and rate limits (429 that is not
// about quota), lends a request that got one to another key and cools a key down after a few.
// Its pool report says, per key it is cooling: { rateCooldown: { until, n429, windowMs, level } } and,
// for a key it has lent away from, cooled or resent: { rateStats: { borrows, cooldowns, resendOk,
// resendFail } } (whole numbers since that connector started). Each report replaces the computer's
// last one; it is kept in memory only (forgotten when the computer reconnects, left out while it is
// offline) and believed only from a connector that said it watches.
//   machine id -> { cool: { key id: { until, n429, windowMs, level } }, stats: { key id: { borrows, ... } } }
const rateReports = new Map();
const wholeNumber = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const STAT_NAMES = ['borrows', 'cooldowns', 'resendOk', 'resendFail'];
function cleanRateReport(items, known, now = Date.now()) {
  const cool = {};
  const stats = {};
  for (const item of items.slice(0, 100)) {
    if (!item || typeof item.id !== 'string' || !known.has(item.id)) continue;
    const c = item.rateCooldown;
    if (c && typeof c === 'object') {
      const until = Number(c.until);
      const n429 = wholeNumber(c.n429, 1_000_000);
      const windowMs = wholeNumber(c.windowMs, 3_600_000);
      const level = c.level === undefined ? 0 : wholeNumber(c.level, 20);
      // (A cooldown is minutes long: one that ends in more than a day is not one.)
      if (typeof c.until === 'number' && Number.isFinite(until) && until <= now + 86_400_000 && n429 !== null && windowMs !== null && windowMs >= 1000 && level !== null) cool[item.id] = { until, n429, windowMs, level };
    }
    const st = item.rateStats;
    if (st && typeof st === 'object') stats[item.id] = Object.fromEntries(STAT_NAMES.map((name) => [name, wholeNumber(st[name], 1_000_000_000) ?? 0]));
  }
  return { cool, stats };
}
const onlineRateReports = () => [...rateReports].filter(([id]) => machines.getMachine(id)?.online).map(([, r]) => r);
// The cooldown of a key, over the computers that are online: the later end, the more 429s, how many say so.
function rateCooldownOf(keyId, now = Date.now()) {
  let out = null;
  for (const r of onlineRateReports()) {
    const c = r.cool[keyId];
    if (!c || c.until <= now) continue;
    out = out ? { until: Math.max(out.until, c.until), n429: out.n429 + c.n429, windowMs: Math.max(out.windowMs, c.windowMs), level: Math.max(out.level, c.level), machines: out.machines + 1 } : { ...c, machines: 1 };
  }
  return out;
}
function rateStatsOf(keyId) {
  let out = null;
  for (const r of onlineRateReports()) {
    const st = r.stats[keyId];
    if (!st) continue;
    out = out ? Object.fromEntries(STAT_NAMES.map((name) => [name, out[name] + st[name]])) : { ...st };
  }
  return out;
}
// { catalog gateway's model id -> the id of the same model at gateway g }, for
// the gateways other than the catalog's that hold a key. "The same model" is
// idAt's judgment (the one used everywhere); a model with no counterpart, or two,
// is left out and the connector never sends it there.
function modelMapFor(catalog, catalogIds, gateways) {
  const out = {};
  for (const g of gateways) {
    if (g === catalog) continue;
    const table = {};
    for (const id of catalogIds) {
      const theirs = idAt(g, id);
      if (theirs) table[id] = theirs;
    }
    out[g] = table;
  }
  return out;
}

// The key old callers mean: the gateway's preferred active key (even when it
// is marked exhausted; ensureProvider says so with pool_exhausted instead).
export function apiKey(gw) {
  const of = (g) => {
    const pool = poolOf(g);
    return pool ? (pool.keys.find((k) => k.id === pool.activeId) || firstUsable(pool.keys))?.key || '' : '';
  };
  if (gw !== undefined) return of(gw);
  // Without a gateway: "is there a key" - the model names' gateway's preferred
  // one, else the first key of the list (keys are used across gateways).
  return of(gateway()) || rotationEntries().find((e) => isUsable(e.k))?.k.key || rotationEntries()[0]?.k.key || '';
}

const keyForAttempt = (gw) => {
  const pool = poolOf(gw);
  if (!pool) return null;
  const now = Date.now();
  const usable = pool.keys.filter((k) => isUsable(k, now));
  return usable.find((k) => k.id === pool.activeId && !isBlocked(k)) || usable.find((k) => !isBlocked(k)) || usable[0] || null;
};

// The last four characters: all a page is ever told of a key.
const hint = (k) => (k ? k.slice(-4) : '');

function putPool(gw, pool) {
  saved.keys = { ...(saved.keys || {}), [gw]: pool };
}

// Add and prefer `key`. The old single-key callers keep working: the key
// becomes the gateway's preferred active one. Pasting the same key again
// keeps one entry (and prefers it) instead of duplicating the secret.
export function setKey(gw, key) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const why = checkKey(key);
  if (why) throw Object.assign(new Error(why), { status: 400 });
  // Refused before anything changes in memory.
  keyFile.check({ explicit: true });
  const text = String(key).trim();
  const namesBefore = gateway();
  const pool = poolOf(gw) || { revision: 0, activeId: '', keys: [] };
  const existing = pool.keys.find((k) => k.key === text);
  if (existing) {
    if (pool.activeId !== existing.id) {
      pool.activeId = existing.id;
      pool.revision += 1;
      putPool(gw, pool);
      save({ explicit: true });
    }
    return existing.id;
  }
  const id = newKeyId();
  // The first key there is decides which gateway's model names conversations use.
  const first = rotationEntries().length === 0;
  pool.keys.push({ id, key: text, addedAt: Date.now() });
  pool.activeId = id;
  pool.revision += 1;
  putPool(gw, pool);
  if (first) saved.gateway = gw;
  // A new key goes to the end of the order: it is used when the keys before it
  // are out (move it up to use it first).
  saved.order = [...rotationEntries().map((e) => e.k.id).filter((x) => x !== id), id];
  save({ explicit: true });
  gatewayMayHaveChanged(namesBefore);
  return id;
}

// Prefer an existing key. No revision bump when it already is the one.
export function activateKey(gw, id) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const pool = poolOf(gw);
  const key = pool?.keys.find((k) => k.id === id);
  if (!pool || !key) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  if (pool.activeId === id) return false;
  pool.activeId = id;
  pool.revision += 1;
  save();
  return true;
}

// Remove one key. Removing the preferred one prefers the next usable key.
export function removeKey(gw, id) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const pool = poolOf(gw);
  const i = pool ? pool.keys.findIndex((k) => k.id === id) : -1;
  if (i === -1) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  pool.keys.splice(i, 1);
  if (pool.activeId === id) pool.activeId = firstUsable(pool.keys)?.id || '';
  pool.revision += 1;
  syncOrder();
  if (!pool.keys.length) {
    // Keep the (empty) pool so its revision stays ahead of every connector's
    // last one; a new key can never look like an older, already-seen state.
    if (saved.models) delete saved.models[gw];
    for (const [machineId, a] of Object.entries(saved.activity || {})) if (a.gateway === gw) delete saved.activity[machineId];
  }
  save();
  return pool.keys.length;
}

// A real chat request needs the gateway's chat-completions address (the same
// base Kimi is pointed at); tests answer it at <fake>/<gateway>/chat/completions.
function chatUrl(gateway) {
  const t = process.env.AGENT_HUB_DEEPSEEK_TEST_URL;
  if (t && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(t)) return `${t}/${gateway}/chat/completions`;
  return `${GATEWAYS[gateway].base}/chat/completions`;
}

// What a refused probe said, in the gateway's own error fields only, with
// every key in the pool masked.
function gatewayReason(text) {
  let reason = '';
  try {
    const j = JSON.parse(text);
    const e = j && typeof j.error === 'object' && j.error ? j.error : j || {};
    reason = [e.code, e.type, e.message].filter((x) => typeof x === 'string' && x).join(' / ');
    if (!reason && typeof j?.error === 'string') reason = j.error;
  } catch {}
  return provisionWarning({ message: reason.slice(0, 160) });
}

// Is this key usable RIGHT NOW? One tiny real completion (a handful of tokens)
// with that key: /models answers for a key whose quota is gone, so it cannot
// tell. Resolves only on a completion; otherwise throws why not.
export async function probeKey(gw, key) {
  const ids = modelIds(gw);
  const model = pickDefaultModel(ids);
  let res;
  let text = '';
  try {
    res = await fetch(chatUrl(gw), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch (err) {
    throw Object.assign(new Error(`無法確認這把 key 是否恢復：${explain(gw, { err })}`), { status: 502, code: 'probe_unreachable' });
  }
  if (res.ok) return true;
  const why = gatewayReason(text);
  if (res.status === 402 || res.status === 429) throw Object.assign(new Error(`這把 key 的額度還沒恢復（閘道回 HTTP ${res.status}${why ? `：${why}` : ''}）。等額度重置後再試，或加入新的 key。`), { status: 409, code: 'still_exhausted' });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`閘道現在不接受這把 key（HTTP ${res.status}${why ? `：${why}` : ''}）`), { status: 409, code: 'key_refused' });
  throw Object.assign(new Error(`無法確認這把 key 是否恢復：閘道回 HTTP ${res.status}${why ? `：${why}` : ''}`), { status: 502, code: 'probe_failed' });
}

// Re-enable a key the gateway refused for quota. Only a real completion with
// that key clears the exhaustion and makes it the preferred key again; a
// refused or failed probe changes nothing.
export async function retryKey(gw, id) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const pool = poolOf(gw);
  const key = pool?.keys.find((k) => k.id === id);
  if (!pool || !key) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  await refreshModels(gw, key.key);
  await probeKey(gw, key.key);
  // The pool may have moved while the probe was out.
  const now = poolOf(gw)?.keys.find((k) => k.id === id);
  if (!now) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  dropExhaustion(now);
  dropAuth(now);
  delete now.manual;
  const live = poolOf(gw);
  live.activeId = now.id;
  live.revision += 1;
  save();
  return true;
}

export function clearKey(gw) {
  if (!isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  const pool = poolOf(gw);
  if (!pool) return;
  // Empty, not gone: the revision must keep moving so replacing the last key
  // cannot match a connector's cached provision.
  saved.keys = { ...(saved.keys || {}), [gw]: { revision: pool.revision + 1, activeId: '', keys: [] } };
  if (saved.models) delete saved.models[gw];
  for (const [machineId, a] of Object.entries(saved.activity || {})) if (a.gateway === gw) delete saved.activity[machineId];
  syncOrder();
  save();
}

// ---- what a person can say about a key (the "user marked it" signal)
const locateKey = (id) => {
  const e = rotationEntries().find((x) => x.k.id === id);
  if (!e) throw Object.assign(new Error('找不到這把 API key'), { status: 404 });
  return e;
};

// Mark a key full by hand: it is set aside, never used and never probed, until
// a person clears the mark (or re-enables it with a real request). True when
// something changed.
export function markFull(id) {
  const { k } = locateKey(id);
  if (k.exhaustedAt && k.manual) return false;
  k.exhaustedAt = Date.now();
  delete k.retryAt;
  delete k.exhaustedRev;
  dropAuth(k);
  k.manual = true;
  bumpEpoch();
  save();
  return true;
}

// Clear a key's mark by hand - out of quota as a gateway said it, refused by its
// gateway (HTTP 401), or marked full by a person - without asking the gateway:
// the next real request that uses it finds out (and it is marked again, with
// whatever the gateway says, if it is still out or still refused). True when
// something changed.
export function clearMark(id) {
  const { k } = locateKey(id);
  if (!isBlocked(k)) return false;
  dropExhaustion(k);
  dropAuth(k);
  delete k.manual;
  bumpEpoch();
  save();
  return true;
}

// Move a key in the order the keys are used in: 'up', 'down' or 'top'. True
// when it moved.
export function moveKey(id, direction) {
  if (!['up', 'down', 'top'].includes(direction)) throw Object.assign(new Error('direction 要是 up、down 或 top'), { status: 400 });
  locateKey(id);
  const order = rotationEntries().map((e) => e.k.id);
  const from = order.indexOf(id);
  const to = direction === 'top' ? 0 : direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= order.length || to === from) return false;
  order.splice(from, 1);
  order.splice(to, 0, id);
  saved.order = order;
  bumpEpoch();
  save();
  return true;
}

// A connector's {t:'deepseek.pool'} report: only known gateways and key ids,
// never secret material or an address. `activeId` is that machine's actual
// key, not the hub's preferred one: it never rewrites the pool's activeId.
// A report older than the pool must not undo a newer key change.
// A connector that rotates across gateways says `rotation: 1`: its report is
// about the whole list (its revision is rotationRevision(), `gateway` is the
// gateway of the key it is on, ids are looked up in every pool). An older one
// reports on the one gateway it was given.
export function applyPoolReport(machineId, msg) {
  if (!machineId || !msg || typeof msg !== 'object') return false;
  const gw = msg.gateway;
  if (!isGateway(gw)) return false;
  const revision = Number(msg.revision);
  if (!Number.isInteger(revision) || revision < 1) return false;
  const rotation = msg.rotation === 1;
  const activeId = typeof msg.activeId === 'string' ? msg.activeId.slice(0, 64) : null;
  const pool = poolOf(gw);
  if (!rotation && !pool) return false;
  const entries = rotation ? rotationEntries() : pool.keys.map((k) => ({ gw, k }));
  if (!entries.length) return false;
  const known = new Map(entries.map((e) => [e.k.id, e.k]));
  const current = rotation ? rotationRevision() : pool.revision;
  let changed = false;

  const id = String(machineId).slice(0, 64);
  // How many conversations each key has on this computer (sticky pools only).
  // Whole numbers for keys the Hub knows, nothing else; each report replaces the
  // last one of the computer. Not a fact about the keys, so it needs no revision.
  const mode = msg.distribution === 'sticky' || msg.distribution === 'relay' ? msg.distribution : null;
  if (mode) {
    const counts = {};
    if (mode === 'sticky' && Array.isArray(msg.keys)) {
      for (const item of msg.keys.slice(0, 100)) {
        if (item && typeof item.id === 'string' && known.has(item.id) && Number.isInteger(item.sessions) && item.sessions >= 0 && item.sessions <= 1_000_000) counts[item.id] = item.sessions;
      }
    }
    const next = { distribution: mode, counts };
    if (JSON.stringify(stickyReports.get(id)) !== JSON.stringify(next)) {
      stickyReports.set(id, next);
      changed = true;
    }
  } else if (stickyReports.delete(id)) changed = true;
  // Rate-limit news: live, replaces the computer's last, from a connector that says it watches.
  let live = false;
  if (machines.hasCapability(id, 'pool_rate') && Array.isArray(msg.keys)) {
    const next = cleanRateReport(msg.keys, known);
    if (JSON.stringify(rateReports.get(id)) !== JSON.stringify(next)) {
      rateReports.set(id, next);
      live = true;
    }
  } else if (rateReports.delete(id)) live = true;
  const prev = saved.activity?.[id];
  // The newest report by revision wins for a machine's activity. A different
  // gateway is a new fact even when its revision counter is lower (another
  // gateway has its own counter).
  if (!prev || prev.gateway !== gw || Boolean(prev.rotation) !== rotation || revision >= prev.revision) {
    const next = { gateway: gw, activeId: known.has(activeId) ? activeId : null, revision, at: Date.now(), ...(rotation ? { rotation: true } : {}) };
    if (!prev || prev.gateway !== next.gateway || prev.activeId !== next.activeId || prev.revision !== next.revision || Boolean(prev.rotation) !== rotation) {
      saved.activity = { ...(saved.activity || {}), [id]: next };
      changed = true;
    }
  }

  // Key health only from a report that matches the hub's current revision, and
  // only what a report actually SAYS about a key:
  //   - { exhaustedAt[, retryAt] }  the newest exhaustion any computer saw wins;
  //     retryAt is only ever a time a gateway stated;
  //   - { authFailedAt, authFailures[, authRetryAt] }  the gateway refused the key
  //     (HTTP 401): its own state, not an exhaustion, with no reset time; the
  //     newest of exhaustion and refusal any computer saw is the one that stands;
  //   - { recoveredAt, recoveredFrom }  a real request succeeded on that key;
  //     it clears the exhaustion (or refusal) only if it is later than that and
  //     not from the future: a wrong clock is not evidence;
  //   - { exhaustedAt: null }  an explicit reset, honoured only from a revision
  //     newer than the one the exhaustion was recorded at;
  //   - no field at all  this computer has no news about the key. That is not
  //     "healthy": another computer's view must never undo an exhaustion.
  // A key a person marked full is theirs to clear: no report touches it.
  if (revision === current && Array.isArray(msg.keys)) {
    const now = Date.now();
    for (const item of msg.keys.slice(0, 100)) {
      if (!item || typeof item.id !== 'string') continue;
      const key = known.get(item.id);
      if (!key || key.manual) continue;
      const exhaustedAt = Number(item.exhaustedAt);
      const authFailedAt = Number(item.authFailedAt);
      const recoveredAt = Number(item.recoveredAt);
      // The newest word about this key so far, whichever kind.
      const standing = Math.max(key.exhaustedAt || 0, key.authFailedAt || 0);
      if (item.exhaustedAt != null) {
        if (Number.isFinite(exhaustedAt) && exhaustedAt > 0 && exhaustedAt >= standing && (key.exhaustedAt !== exhaustedAt || (item.retryAt != null && key.retryAt !== Number(item.retryAt)))) {
          const retryAt = Number(item.retryAt);
          key.exhaustedAt = exhaustedAt;
          if (item.retryAt != null && Number.isFinite(retryAt) && retryAt > 0) key.retryAt = retryAt;
          else delete key.retryAt;
          key.exhaustedRev = revision;
          dropAuth(key);
          changed = true;
        }
      } else if (item.authFailedAt != null) {
        const failures = cleanFailures(item.authFailures);
        const retryAt = cleanAuthRetryAt(item.authRetryAt, authFailedAt);
        if (Number.isFinite(authFailedAt) && authFailedAt > 0 && authFailedAt >= standing && (key.authFailedAt !== authFailedAt || key.authFailures !== failures || (key.authRetryAt || 0) !== retryAt)) {
          dropExhaustion(key);
          key.authFailedAt = authFailedAt;
          key.authFailures = failures;
          if (retryAt) key.authRetryAt = retryAt;
          else delete key.authRetryAt;
          changed = true;
        }
      } else if (item.recoveredAt != null) {
        if (standing && Number.isFinite(recoveredAt) && recoveredAt > standing && recoveredAt <= now + 60_000) {
          dropExhaustion(key);
          dropAuth(key);
          changed = true;
        }
      } else if (item.exhaustedAt === null && key.exhaustedAt && revision > (key.exhaustedRev ?? Infinity)) {
        delete key.exhaustedAt;
        delete key.retryAt;
        delete key.exhaustedRev;
        changed = true;
      }
    }
  }
  if (changed) save();
  return changed || live;
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
      // A default saved in the other gateway's spelling is the same model here.
      model: (typeof d.model === 'string' && idAt(gw, d.model)) || pickDefaultModel(ids),
      effort: EFFORTS.includes(d.effort) ? d.effort : DEFAULT_EFFORT,
      permission: PERMISSIONS.includes(d.permission) ? d.permission : 'manual',
      planMode: Boolean(d.planMode),
    },
  };
}

// Whether the Hub sends 「繼續」 by itself to a DeepSeek conversation whose turn ended on a quota or
// rate-limit error, once a key is available again (server/key-recover.js). On unless a person turns it off.
export const autoResumeEnabled = () => saved.autoResume !== false;

export function setSettings({ gateway: gw, defaults, autoResume } = {}) {
  if (gw !== undefined && !isGateway(gw)) throw Object.assign(new Error('不支援的閘道'), { status: 400 });
  if (autoResume !== undefined && typeof autoResume !== 'boolean') throw Object.assign(new Error('autoResume 要是 true 或 false'), { status: 400 });
  const next = { ...saved };
  if (autoResume === false) next.autoResume = false;
  else if (autoResume === true) delete next.autoResume;
  if (gw !== undefined) next.gateway = gw;
  if (defaults && typeof defaults === 'object') {
    const d = { ...(saved.defaults || {}) };
    if (typeof defaults.model === 'string' && defaults.model.length <= 100) d.model = defaults.model;
    if (EFFORTS.includes(defaults.effort)) d.effort = defaults.effort;
    if (PERMISSIONS.includes(defaults.permission)) d.permission = defaults.permission;
    if ('planMode' in defaults) d.planMode = Boolean(defaults.planMode);
    next.defaults = d;
  }
  if (JSON.stringify(next) === JSON.stringify(saved)) return;
  // Not the key: a file that cannot be used is not written over for this (the
  // person is told, and types the key in again).
  keyFile.check();
  const namesBefore = gateway();
  saved = next;
  save();
  gatewayMayHaveChanged(namesBefore);
}

// The conversations on a key, from the computers that are online and said they
// give each conversation its own key; null when none has said anything about it.
function sessionsOn(keyId) {
  let n = null;
  for (const [machineId, r] of stickyReports) {
    if (r.distribution !== 'sticky' || !machines.getMachine(machineId)?.online || !Object.hasOwn(r.counts, keyId)) continue;
    n = (n || 0) + r.counts[keyId];
  }
  return n;
}

// True while some computer that is online says this key is cooling down because of rate limits.
export const keyCooling = (keyId, now = Date.now()) => rateCooldownOf(keyId, now) !== null;

// Which keys a stuck turn can count on right now: with quota (a key only waiting to be confirmed after
// its stated reset time counts), and not cooling down because of rate limits (as the computers that
// watch say). `nextAt`: the next time that is going to change, from a time somebody STATED - a key's
// reset time or the end of a cooldown - or null. Nothing here is estimated: a key out of quota with
// no stated time stays out until a real request or a person says otherwise.
export function availability(now = Date.now()) {
  const ids = new Set();
  let nextAt = Infinity;
  for (const { k } of rotationEntries()) {
    if (!isAvailable(k, now)) {
      if (k.exhaustedAt && !k.manual && k.retryAt && k.retryAt > now) nextAt = Math.min(nextAt, k.retryAt);
      continue;
    }
    const cooling = rateCooldownOf(k.id, now);
    if (cooling) nextAt = Math.min(nextAt, cooling.until);
    else ids.add(k.id);
  }
  return { ids, nextAt: Number.isFinite(nextAt) ? nextAt : null };
}

export function publicAccount() {
  const gw = gateway();
  // Session-header and native-subagent provisioning problems stay visible;
  // both maps contain only non-secret explanations.
  const warnings = [
    ...[...headerWarnings].map(([id, text]) => ({ machineId: id, machineName: machines.getMachine(id)?.name || id, text: `DeepSeek session 標頭未設定：${text}（閘道可能限流）` })),
    ...[...provisionWarnings].map(([id, text]) => ({ machineId: id, machineName: machines.getMachine(id)?.name || id, text: `原生 DeepSeek 子代理尚未就緒：${text}` })),
  ];
  const now = Date.now();
  // How a key stands, said plainly and without a made-up time:
  //   resetAt     the reset time its gateway STATED (null: none was)
  //   expiryKnown true only with a stated time; an exhausted key without one is
  //               looked at again by the next real request after a short gap
  //   manual      a person marked it full (and only a person clears that)
  //   retryAt     when a real request may next look at it (null: healthy, or manual)
  //   authFailed  the gateway refused the key (HTTP 401): not an exhaustion, and it has no
  //               reset time; authFailedAt/authFailures say when and how many in a row, and
  //               authRetryAt is the connector's own schedule for the next real try (a
  //               probing time of ours, never a time the gateway stated)
  const keyView = (k, pool) => ({
    id: k.id,
    hint: hint(k.key),
    addedAt: k.addedAt,
    active: k.id === pool?.activeId,
    exhaustedAt: k.exhaustedAt ?? null,
    retryAt: isBlocked(k) && !k.manual ? retryAtOf(k) : null,
    resetAt: k.exhaustedAt && !k.manual && k.retryAt ? k.retryAt : null,
    expiryKnown: Boolean(k.exhaustedAt && !k.manual && k.retryAt && k.retryAt > now),
    // The gateway's stated time has passed: "waiting for the next request to confirm it", not "full".
    resetDue: isResetDue(k, now),
    // Rate limits, as the computers that watch say (null: nothing reported): cooling down until a time
    // on a count of 429s, and how often the key was lent away from, cooled and resent.
    rateCooldown: rateCooldownOf(k.id, now),
    rateStats: rateStatsOf(k.id),
    manual: Boolean(k.exhaustedAt && k.manual),
    authFailed: isRefused(k),
    authFailedAt: isRefused(k) ? k.authFailedAt : null,
    authFailures: isRefused(k) ? cleanFailures(k.authFailures) : null,
    authRetryAt: isRefused(k) ? retryAtOf(k) : null,
  });
  const gateways = Object.entries(GATEWAYS).map(([id, g]) => {
    const pool = poolOf(id);
    const keys = pool?.keys || [];
    const active = keys.find((k) => k.id === pool?.activeId) || null;
    const nextTries = keys.map(retryAtOf).filter(Number.isFinite);
    return {
      id,
      label: g.label,
      site: g.site,
      hasKey: keys.length > 0,
      // The preferred key's last four characters, as before; then the whole
      // key list (ids and hints only, never the secrets).
      keyHint: hint(active?.key),
      keyCount: keys.length,
      // retryAt: when an exhausted key is next tried automatically (null for a
      // healthy key). allExhausted/nextRetryAt: the whole gateway is out, and
      // the earliest automatic try.
      keys: keys.map((k) => keyView(k, pool)),
      allExhausted: keys.length > 0 && keys.every((k) => isBlocked(k) && !isResetDue(k, now)),
      nextRetryAt: keys.length > 0 && keys.every((k) => isBlocked(k) && !isResetDue(k, now)) && nextTries.length ? Math.min(...nextTries) : null,
    };
  });
  // The one list the keys are used in, across gateways: each key with its
  // gateway, place and state. `active` is the first key not known to be out.
  const entries = rotationEntries();
  const head = entries.find((e) => isAvailable(e.k, now))?.k.id || null;
  const stated = entries.filter((e) => e.k.exhaustedAt && !e.k.manual && e.k.retryAt && e.k.retryAt > now).map((e) => e.k.retryAt);
  const rotation = {
    revision: rotationRevision(),
    activeId: head,
    keys: entries.map((e, i) => ({
      ...keyView(e.k, poolOf(e.gw)),
      gateway: e.gw,
      gatewayLabel: GATEWAYS[e.gw].label,
      position: i + 1,
      active: e.k.id === head,
      state: e.k.exhaustedAt ? (e.k.manual ? 'manual' : isResetDue(e.k, now) ? 'reset_due' : 'exhausted') : isRefused(e.k) ? 'auth_failed' : 'ready',
      // How many conversations are on this key right now, added up over the
      // computers that are online and give each conversation its own key; null
      // when none of them has said (not zero: nobody has counted).
      sessions: sessionsOn(e.k.id),
    })),
    allExhausted: entries.length > 0 && entries.every((e) => isBlocked(e.k) && !isResetDue(e.k, now)),
    nextResetAt: stated.length ? Math.min(...stated) : null,
  };
  const cur = gateways.find((g) => g.id === gw);
  // Each computer's latest actual key. This is not the hub's preferred one:
  // the hub must not force every computer back onto the same key.
  const activity = Object.entries(saved.activity || {})
    .map(([machineId, a]) => ({
      machineId,
      machineName: machines.getMachine(machineId)?.name || machineId,
      gateway: a.gateway,
      activeId: a.activeId,
      revision: a.revision,
      ...(a.rotation ? { rotation: true } : {}),
      // Present only when there is something to say: this computer's connector can
      // give each conversation its own key (`stickyCapable`), and the way it last
      // said it gives them out (`distribution`). Neither: an older connector.
      ...(machines.hasCapability(machineId, 'pool_sticky') ? { stickyCapable: true } : {}),
      // This computer's connector puts a key whose stated reset time has passed back into
      // its rotation by itself; an older one waits until every other key is out.
      ...(machines.hasCapability(machineId, 'pool_reset_due') ? { resetDueCapable: true } : {}),
      // This computer's connector watches for rate limits (lends a request that got a 429, cools a key);
      // an older one does neither.
      ...(machines.hasCapability(machineId, 'pool_rate') ? { rateCapable: true } : {}),
      ...(stickyReports.get(machineId)?.distribution ? { distribution: stickyReports.get(machineId).distribution } : {}),
    }))
    .sort((a, b) => a.machineId.localeCompare(b.machineId));
  // What each computer's Kimi actually has as [secondary_model], as the
  // bridge last reported it. This is the real value (model, effort, force),
  // never the Hub's preference; a machine with none is absent.
  const secondaryModels = [...secondary]
    .map(([machineId, s]) => ({ machineId, machineName: machines.getMachine(machineId)?.name || machineId, ...s }))
    .sort((a, b) => a.machineId.localeCompare(b.machineId));
  return { gateway: gw, hasKey: cur.hasKey || rotation.keys.length > 0, keyHint: cur.keyHint, gateways, rotation, distribution: distribution(), autoResume: autoResumeEnabled(), defaults: settings(gw).defaults, warnings, activity, secondaryModels, damaged: keyFile.public() };
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

// ---- one model, two spellings
// The gateways name a model differently (`deepseek-v4.1-flash` at OpenCode,
// `deepseek/deepseek-v4.1-flash` at Command Code) and a conversation keeps the
// spelling of the gateway that was in use when it chose. This is the ONE
// judgment of "what is this model called at gateway g": the last name part is
// the same, and exactly one id there has it. Whoever must tell a stale spelling
// from a wrong model (a check on a chosen model, the connector's name table, the
// records of old conversations, the native's alias) asks here.
const lastPart = (id) => String(id).toLowerCase().replace(/^.*\//, '');

// The gateway's id without Kimi's provider prefix (an alias or a bare id in).
export const bareId = (model) => {
  const t = String(model ?? '').trim();
  return t.startsWith(MODEL_PREFIX) ? t.slice(MODEL_PREFIX.length) : t;
};

// The id at gateway `gw` of the model `model` names (in any gateway's
// spelling, alias or bare), or null when `gw` has no such model.
export function idAt(gw, model) {
  const raw = bareId(model);
  if (!raw || !lastPart(raw) || !isGateway(gw)) return null;
  const theirs = modelIds(gw);
  if (theirs.includes(raw)) return raw;
  const same = theirs.filter((x) => lastPart(x) === lastPart(raw));
  return same.length === 1 ? same[0] : null;
}

// The same, as the alias Kimi's provider has it under.
export const aliasAt = (gw, model) => {
  const id = idAt(gw, model);
  return id ? aliasFor(id) : null;
};

// Why `model` is not at gateway `gw` (default: the one the names follow) when
// another gateway has it: a sentence that names who has it and what the names
// follow now. null when no gateway has it (it is simply not a model).
export function notAtGateway(model, gw = gateway()) {
  const others = Object.keys(GATEWAYS).filter((g) => g !== gw && idAt(g, model));
  if (!others.length) return null;
  return `${bareId(model).replace(/^.*\//, '')} 只有 ${others.map((g) => GATEWAYS[g].label).join('、')} 有；DeepSeek 模型名稱目前依 ${GATEWAYS[gw].label}，請在模型選單重選`;
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

const provisioned = new Map(); // machine id -> { sig, at }: the last answer known to match the connector
const headerWarnings = new Map(); // machine id -> why the provider has no session header
const jobs = new Map(); // machine id -> { promise }: the provision under way, joined by every caller
const tails = new Map(); // machine id -> Promise: this machine's provisions and removals, in order
const epochs = new Map(); // machine id -> number: an explicit forget makes an answer already out obsolete
const secondary = new Map(); // machine id -> the actual [secondary_model] the bridge last reported
const provisionWarnings = new Map(); // machine id -> why native DeepSeek subagents are not ready
const autoFailures = new Map(); // machine id -> { sig, at }; no retry storm on repeated hello
const scheduledProvisions = new Set();
const AUTO_RETRY_MS = 60_000;
// Backoff for a provision that failed for a reason that can pass by itself (the
// connector or Kimi was busy or restarting, a network blip). machine id ->
// { timer, attempt }. After the last delay it stops: the next hello, Kimi
// server start, key change or retryProvision() tries again.
const retries = new Map();
let retryDelays = (process.env.AGENT_HUB_DEEPSEEK_PROVISION_RETRY_MS || '5000,30000,120000,600000')
  .split(',')
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x) && x >= 0);
// For tests: other delays (milliseconds, one per retry).
export function setProvisionRetryDelays(delays) {
  retryDelays = delays.map(Number).filter((x) => Number.isFinite(x) && x >= 0);
}
// Failures a retry cannot fix: say so and wait for someone to change something.
const FINAL_CODES = new Set(['no_key', 'pool_exhausted', 'pool_unsupported', 'connector_old']);

function provisionWarning(err) {
  let text = String(err?.message || err);
  for (const gw of Object.keys(GATEWAYS)) {
    for (const k of poolOf(gw)?.keys || []) if (k.key) text = text.replaceAll(k.key, `[key …${hint(k.key)}]`);
  }
  return text.slice(0, 500);
}

// The gateway's own revision and model list: a runtime key report does not
// change this, so it must not make every computer provision again.
const sigOf = (gw, revision, ids, map = null) => crypto.createHash('sha256').update(JSON.stringify(map ? [gw, revision, ids, map] : [gw, revision, ids])).digest('hex');

// An older bridge does not know the op.
const tooOld = (err, m) => (/未知的操作/.test(err?.message || '') ? Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，不支援 DeepSeek 模式。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409, code: 'connector_old' }) : err);

const noKey = () => Object.assign(new Error('還沒有設定 DeepSeek 的 API key。在「設定」→「DeepSeek…」貼上閘道的 API key。'), { status: 409, code: 'no_key' });
// Every key is out of use (out of quota, refused by its gateway with HTTP 401, or
// marked full by a person) and none may be looked at yet. Lists each key by
// gateway and last four characters (never the key) with its state, says the
// earliest reset time a gateway STATED, when a real request tries again by
// itself and what to do right now. `retryAt` is the earliest such try. Keys out of
// quota and keys the gateway refused are counted and listed apart: a refused key
// is not an empty account, and the time a real request looks at it again is our
// probing schedule, not a reset time anybody stated. With no refused key the
// words are the ones this message always had.
// `entries` are { gw, k } in the order the keys are used in.
const poolExhausted = (entries) => {
  const now = Date.now();
  const when = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false });
  const tries = entries.map((e) => retryAtOf(e.k)).filter((t) => Number.isFinite(t) && t > 0);
  const retryAt = tries.length ? Math.min(...tries) : NaN;
  const stated = entries.filter((e) => e.k.exhaustedAt && !e.k.manual && e.k.retryAt && e.k.retryAt > now).map((e) => e.k.retryAt);
  const lines = entries.map((e, i) => {
    let state;
    if (e.k.manual) state = '手動標記已滿';
    else if (isRefused(e.k)) {
      const at = retryAtOf(e.k);
      state = `認證失敗（HTTP 401），上次 ${when(e.k.authFailedAt)}；${at > now ? `${when(at)} 之後的真實請求會再試` : '下一個真實請求會再試'}（這是排好的探測時間，不是供應商給的重置時間）`;
    } else state = e.k.retryAt && e.k.retryAt > now ? `已滿，${when(e.k.retryAt)} 重置` : '已滿，重置時間未知（下一個真實請求會再試）';
    return `${i + 1}. ${GATEWAYS[e.gw].label} …${hint(e.k.key)}：${state}`;
  });
  const nAuth = entries.filter((e) => isRefused(e.k)).length;
  const nManual = entries.filter((e) => e.k.exhaustedAt && e.k.manual).length;
  const nQuota = entries.filter((e) => e.k.exhaustedAt && !e.k.manual).length;
  const earliest = stated.length ? `；最早已知的重置時間 ${when(Math.min(...stated))}` : '';
  const head = nAuth
    ? `DeepSeek 的 API key 都不能用（共 ${entries.length} 把）：${[`認證失敗（HTTP 401）${nAuth} 把`, nQuota ? `額度用完 ${nQuota} 把` : '', nManual ? `手動標記已滿 ${nManual} 把` : ''].filter(Boolean).join('、')}${earliest}。`
    : `DeepSeek 的 API key 都已用盡（共 ${entries.length} 把）${earliest}。`;
  const dur = (ms) => (ms >= MIN_MS ? `${Math.round(ms / MIN_MS)} 分鐘` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
  const auto = Number.isFinite(retryAt)
    ? nAuth
      ? `有請求時會自動再試：認證失敗的 key 在失敗 ${dur(AUTH_FIRST_GAP_MS)}後由真實請求探測，每再失敗一次間隔加倍、最長 ${dur(AUTH_MAX_GAP_MS)}；${nQuota ? '已知重置時間的 key 到時間才試，重置時間未知的 key 下一個真實請求就會再試。' : ''}認證失敗通常是 key 失效、被撤銷或貼錯，請到供應商確認。`
      : '有請求時會自動再試：已知重置時間的 key 到時間才試，重置時間未知的 key 下一個真實請求就會再試。'
    : '沒有可以自動再試的 key（都是手動標記）。';
  const confirm = nAuth ? 'key 能用了' : '額度回來了';
  return Object.assign(new Error(`${head}\n${lines.join('\n')}\n${auto}要現在恢復：在「設定」→「DeepSeek…」對其中一把按「重新啟用」（會用一次很小的請求確認${confirm}）或「清除標記」，或加入新的 key。`), {
    status: 409,
    code: 'pool_exhausted',
    ...(Number.isFinite(retryAt) ? { retryAt } : {}),
  });
};
const poolUnsupported = (m) =>
  Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，只能使用一把 DeepSeek API key。這個閘道已有多把 key，請在那台電腦重新執行連接指令，更新到 connector 0.10 以上；在那之前不會只用其中一把。`), {
    status: 409,
    code: 'pool_unsupported',
  });

// Which key a computer should start on: the one it last reported using, when
// it is still in the pool and usable, else the hub's preferred key. A report
// from one computer must not move every other computer.
function keyForMachine(machineId, gw, pool) {
  const recent = saved.activity?.[machineId];
  if (recent?.gateway === gw) {
    const k = pool.keys.find((x) => x.id === recent.activeId);
    if (k && !isBlocked(k)) return k.id;
  }
  const preferred = pool.keys.find((k) => k.id === pool.activeId);
  if (preferred && !isBlocked(preferred)) return preferred.id;
  return pool.keys.find((k) => !isBlocked(k))?.id || firstUsable(pool.keys)?.id || '';
}

// Everything a provision needs, read at the moment it is about to be sent.
// The gateway, pool and revision may have changed while an older request was
// out; that older request must not be sent again, and its answer must not be
// taken for the current state.
//   - a connector with `pool_cross` gets every key of every gateway in the one
//     order they are used in, each with its gateway, and the table of the
//     model's names at the other gateways; it starts on the first key not known
//     to be out (the order is the priority);
//   - an older `pool` connector gets the keys of the gateway whose model names
//     conversations use, as before (keys a person marked full are left out: it
//     cannot know the mark);
//   - an older one still gets exactly one key, never silently one of several.
function planFor(machineId) {
  const gw = gateway();
  const machine = machines.getMachine(machineId);
  const all = rotationEntries();
  if (!all.length) throw noKey();
  const ids = modelIds(gw);
  let args;
  let sig;
  if (hasCap(machine, 'pool_cross')) {
    const now = Date.now();
    if (!all.some((e) => isUsable(e.k, now))) throw poolExhausted(all);
    const map = modelMapFor(gw, ids, new Set(all.map((e) => e.gw)));
    const revision = rotationRevision();
    sig = sigOf(gw, revision, ids, map);
    // (A key whose stated reset time has passed counts as not out: the connector takes the first
    // such key of the list in the order of the list, a relay starts on it.)
    const first = all.find((e) => isAvailable(e.k, now)) || all.find((e) => isUsable(e.k, now));
    // A refused key (HTTP 401) goes with its own fields to a connector that says
    // it reads them (`pool_auth`); one that does not gets the key as it always
    // did, and is still started on a key the Hub does not know to be refused.
    const auth = hasCap(machine, 'pool_auth');
    args = {
      gateway: gw,
      models: ids.map(kimiModel),
      pool: {
        revision,
        activeId: first.k.id,
        retryMs: retryMs(),
        rotation: 1,
        modelMap: map,
        // (Only to a connector that says it can: see distribution().)
        ...(hasCap(machine, 'pool_sticky') ? { distribution: distribution() } : {}),
        keys: all.map((e) => ({
          id: e.k.id,
          apiKey: e.k.key,
          gateway: e.gw,
          ...(e.k.exhaustedAt ? { exhaustedAt: e.k.exhaustedAt, ...(e.k.retryAt ? { retryAt: e.k.retryAt } : {}), ...(e.k.manual ? { manual: true } : {}) } : {}),
          ...(auth && isRefused(e.k) ? { authFailedAt: e.k.authFailedAt, authFailures: cleanFailures(e.k.authFailures) } : {}),
        })),
      },
    };
    return { sig, ids, args, machine };
  }
  // (An older connector: one gateway's keys. The model names' gateway, or the
  // first gateway that has keys when that one has none.)
  const own = poolOf(gw)?.keys.length ? gw : all[0].gw;
  const pool = poolOf(own);
  if (!pool?.keys.length) throw noKey();
  if (!keyForAttempt(own)) throw poolExhausted(pool.keys.map((k) => ({ gw: own, k })));
  const legacyIds = modelIds(own);
  sig = sigOf(own, pool.revision, legacyIds);
  if ((Number(machine?.pool) || 0) >= 1) {
    const keys = pool.keys.filter((k) => !k.manual);
    args = {
      gateway: own,
      models: legacyIds.map(kimiModel),
      pool: {
        revision: pool.revision,
        activeId: keyForMachine(machineId, own, { ...pool, keys }),
        retryMs: retryMs(),
        keys: keys.map((k) => ({ id: k.id, apiKey: k.key, ...(k.exhaustedAt ? { exhaustedAt: k.exhaustedAt, ...(k.retryAt ? { retryAt: k.retryAt } : {}) } : {}) })),
      },
    };
  } else {
    if (pool.keys.length > 1) throw poolUnsupported(machine);
    const key = keyForAttempt(own);
    args = { gateway: own, apiKey: key.key, models: legacyIds.map(kimiModel) };
  }
  return { sig, ids: legacyIds, args, machine };
}

// One machine's operations run one after another; different machines do not
// wait for each other. `run` also runs after a failed operation, so one bad
// provision cannot wedge a machine.
function enqueue(machineId, run) {
  const prev = tails.get(machineId) || Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.catch(() => {});
  tails.set(machineId, tail);
  const clear = () => {
    if (tails.get(machineId) === tail) tails.delete(machineId);
  };
  tail.then(clear, clear);
  return next;
}

async function removeQuietly(machineId, rpc) {
  try {
    await rpc(machineId, 'kimi.deepseek.remove', {}, 30_000);
  } catch {}
}

// The provision loop. It reads the current state immediately before each
// request, and once more when the bridge answers. An answer for a state that
// has been replaced in the meantime is never cached: the loop asks again for
// whatever is current now, so a slower, older request cannot put an old key
// pool back on the computer or overwrite the newer signature.
async function runProvision(machineId, rpc) {
  let replaced = false;
  for (;;) {
    const plan = planFor(machineId);
    if (!replaced && provisioned.get(machineId)?.sig === plan.sig) return { ok: true, cached: true, models: plan.ids.map(aliasFor) };
    const epoch = epochs.get(machineId) || 0;
    let answer;
    try {
      answer = await rpc(machineId, 'kimi.deepseek.provision', plan.args, 60_000);
    } catch (err) {
      // A failed attempt is never a cached provider: the next caller tries
      // again against whatever the state is then.
      provisioned.delete(machineId);
      throw tooOld(err, plan.machine);
    }
    let after;
    try {
      after = planFor(machineId);
    } catch (err) {
      provisioned.delete(machineId);
      // The key was removed or cleared while the request was out: the bridge
      // may just have installed the old one. Take it off before saying there
      // is no key, so the removed key cannot linger on that computer.
      if (err?.code === 'no_key') await removeQuietly(machineId, rpc);
      throw err;
    }
    if (after.sig !== plan.sig || (epochs.get(machineId) || 0) !== epoch) {
      // The answer describes a state that is no longer current (or a provider
      // this hub was told to forget). Never cache it; the computer has to end
      // on the state that is current now.
      provisioned.delete(machineId);
      replaced = true;
      continue;
    }
    provisioned.set(machineId, { sig: plan.sig, at: Date.now() });
    if (answer?.secondaryModel) secondary.set(machineId, answer.secondaryModel);
    else secondary.delete(machineId);
    if (answer?.sessionHeader === false) headerWarnings.set(machineId, answer.warning || '沒有加上 session 標頭');
    else headerWarnings.delete(machineId);
    // The provider is live; a problem with the native subagent default
    // ([secondary_model]) is a warning about that default, never a failed
    // provision (the main conversation does not wait on it).
    if (answer?.secondaryWarning) provisionWarnings.set(machineId, provisionWarning({ message: answer.secondaryWarning }));
    else provisionWarnings.delete(machineId);
    return answer;
  }
}

function queueProvision(machineId, rpc) {
  const job = { superseded: false };
  const promise = enqueue(machineId, () => runProvision(machineId, rpc));
  job.promise = promise;
  jobs.set(machineId, job);
  const clear = () => {
    if (jobs.get(machineId) === job) jobs.delete(machineId);
  };
  promise.then(clear, clear);
  return promise;
}

// Make sure `machineId`'s Kimi has the agent-hub-deepseek provider for the
// gateway and key pool in use, with its models. Asked of the bridge once per
// (computer, gateway, revision, model list); again when any of those changes,
// when the computer reconnects, or after an error. Calls for one computer are
// answered by one ordered provision and share its promise; other computers
// proceed in parallel. Connectors with pool:1 get every key and start on their
// own last reported one; an older connector may still use exactly one key, but
// never silently takes just one of several.
// Resolves to the bridge's answer ({ ok, models: [alias], secondaryModel? }),
// or { cached: true }.
export async function ensureProvider(machineId, { rpc = machines.rpc } = {}) {
  try {
    const answer = await ensureProviderInner(machineId, { rpc });
    // A cached answer changes nothing: the last real attempt stays on record.
    if (!answer?.cached) recordProvision(machineId, answer);
    return answer;
  } catch (err) {
    recordProvision(machineId, null, err);
    throw err;
  }
}

// What the machine's status carries about its last provision, for the pages
// and for the checks other modules make before they rely on a computer:
//   { ok, at, reason, warning, code, retry }
//   ok       the DeepSeek provider is on that computer
//   reason   why not (ok: false), plain text with every key masked
//   warning  ok, but the native subagent default ([secondary_model]) is not
//            what it should be, and why
//   code     no_key / pool_exhausted / pool_unsupported / connector_old for
//            failures only a person can fix; absent for transient ones
//   retry    { attempt, at }: the next automatic try, when one is scheduled
function recordProvision(machineId, answer, err = null) {
  if (!machines.getMachine(machineId)) return;
  const at = Date.now();
  if (err) {
    machines.setProvision(machineId, { ok: false, at, reason: provisionWarning(err), ...(err.code ? { code: String(err.code) } : {}) });
    return;
  }
  const warning = answer?.secondaryWarning ? provisionWarning({ message: answer.secondaryWarning }) : '';
  machines.setProvision(machineId, { ok: true, at, reason: null, ...(warning ? { warning } : {}) });
}

async function ensureProviderInner(machineId, { rpc }) {
  const plan = planFor(machineId); // no key, every key exhausted or an old connector fails at once
  const job = jobs.get(machineId);
  if (job && !job.superseded) return job.promise;
  // A queued removal for this machine must go first: until it has run, a
  // previous answer is not the truth on that computer. A job that a removal
  // superseded is not joined; the new one is queued behind the removal.
  if (!tails.has(machineId) && provisioned.get(machineId)?.sig === plan.sig) {
    return { ok: true, cached: true, models: plan.ids.map(aliasFor) };
  }
  return queueProvision(machineId, rpc);
}

async function provisionOne(machineId, { rpc, sig, throttle }) {
  const previous = autoFailures.get(machineId);
  if (throttle && previous?.sig === sig && Date.now() - previous.at < AUTO_RETRY_MS) {
    return { machineId, ok: false, throttled: true, error: provisionWarnings.get(machineId) || previous.error };
  }
  try {
    const answer = await ensureProvider(machineId, { rpc });
    // A provision that worked ends any backoff. (A secondary warning in the
    // answer was recorded by runProvision and stays visible.)
    stopRetry(machineId);
    if (!answer.secondaryWarning) provisionWarnings.delete(machineId);
    autoFailures.delete(machineId);
    return { machineId, ok: true, cached: Boolean(answer.cached), secondaryModel: answer.secondaryModel || secondary.get(machineId) || null };
  } catch (err) {
    const error = provisionWarning(err);
    provisionWarnings.set(machineId, error);
    autoFailures.set(machineId, { sig, at: Date.now(), error });
    scheduleRetry(machineId, err, rpc);
    return { machineId, ok: false, error };
  }
}

function stopRetry(machineId) {
  const r = retries.get(machineId);
  if (r) clearTimeout(r.timer);
  retries.delete(machineId);
}

// After a failure that may pass by itself, try again later: delays grow
// (5 s, 30 s, 2 min, 10 min by default) and then stop for good until a new
// trigger. Failures a person has to fix (no key, every key out, a connector
// that is too old) are not retried.
function scheduleRetry(machineId, err, rpc) {
  const prev = retries.get(machineId);
  if (prev) clearTimeout(prev.timer);
  const attempt = (prev?.attempt ?? -1) + 1;
  if (FINAL_CODES.has(err?.code) || attempt >= retryDelays.length) {
    if (attempt >= retryDelays.length && !FINAL_CODES.has(err?.code)) retries.set(machineId, { attempt, timer: null, spent: true });
    else retries.delete(machineId);
    return;
  }
  const at = Date.now() + retryDelays[attempt];
  const timer = setTimeout(() => {
    const cur = retries.get(machineId);
    if (!cur || cur.timer !== timer) return;
    cur.timer = null;
    const m = machines.getMachine(machineId);
    if (!m?.online || !m.kimi?.server || !apiKey()) return retries.delete(machineId);
    provisionOne(machineId, { rpc, sig: sigOf(gateway(), rotationRevision(), modelIds()), throttle: false }).catch(() => {});
  }, retryDelays[attempt]);
  timer.unref?.();
  retries.set(machineId, { attempt, timer, at });
  const m = machines.getMachine(machineId);
  if (m?.provision && !m.provision.ok) machines.setProvision(machineId, { ...m.provision, retry: { attempt: attempt + 1, at } });
}

// Try a computer's provision now, whatever failed or was throttled before
// (a settings page's "retry" button, a person fixing the connector). Resets
// the backoff. Resolves to provisionOne's result.
export function retryProvision(machineId, { rpc = machines.rpc } = {}) {
  stopRetry(machineId);
  autoFailures.delete(machineId);
  const m = machines.getMachine(machineId);
  if (!m?.online || !m.kimi?.server) return Promise.resolve({ machineId, ok: false, error: '這台電腦現在連不上 Kimi 伺服器' });
  if (!apiKey()) return Promise.resolve({ machineId, ok: false, error: '還沒有設定 DeepSeek 的 API key' });
  return provisionOne(machineId, { rpc, sig: sigOf(gateway(), rotationRevision(), modelIds()), throttle: false });
}

// Best-effort provisioning for native DeepSeek subagents. Only the automatic
// path is throttled; an explicit provision or a changed key can retry at once.
export async function provisionOnline({ rpc = machines.rpc, list = machines.listMachines, ids = null } = {}) {
  if (!apiKey()) return [];
  const wanted = ids && new Set(ids);
  const online = list().filter((m) => m.online && m.kimi?.server && (!wanted || wanted.has(m.id)));
  const sig = sigOf(gateway(), rotationRevision(), modelIds());
  return Promise.all(online.map((m) => provisionOne(m.id, { rpc, sig, throttle: true })));
}

// A key or gateway change also reaches computers that already had the provider.
// Offline machines are not dropped from this existing explicit contract.
export async function reprovision({ rpc = machines.rpc, list = machines.listMachines } = {}) {
  if (!apiKey()) return [];
  const online = list().filter((m) => m.online && m.kimi?.server).map((m) => m.id);
  const ids = new Set([...provisioned.keys(), ...jobs.keys(), ...online]);
  const sig = sigOf(gateway(), rotationRevision(), modelIds());
  const results = await Promise.all([...ids].map((id) => provisionOne(id, { rpc, sig, throttle: false })));
  return results.filter((r) => r.ok && !r.cached).map((r) => r.machineId);
}

function scheduleProvision(machineId) {
  if (scheduledProvisions.has(machineId)) return;
  scheduledProvisions.add(machineId);
  queueMicrotask(() => {
    scheduledProvisions.delete(machineId);
    const m = machines.getMachine(machineId);
    if (!m?.online || !m.kimi?.server || !apiKey()) return;
    provisionOnline({ ids: [machineId] }).catch(() => {});
  });
}

// The computer's Kimi may have lost the provider (its config was edited, or
// it was reinstalled): ask for it again next time. An answer already out is
// not trusted after this.
export const forgetProvider = (machineId) => {
  provisioned.delete(machineId);
  epochs.set(machineId, (epochs.get(machineId) || 0) + 1);
};
// Every moment Kimi can newly be provisioned: the connector (re)connected, or
// Kimi's server came up on a computer that was already connected (the hello
// had said it was not up). Both start fresh: no stale backoff or throttle.
machines.onBridgeHello((id) => {
  stickyReports.delete(id);
  rateReports.delete(id);
  forgetProvider(id);
  stopRetry(id);
  autoFailures.delete(id);
  scheduleProvision(id);
});
machines.onKimiServer((id) => {
  stopRetry(id);
  autoFailures.delete(id);
  scheduleProvision(id);
});

// Take the provider (and the key in it) off the computers it was put on. The
// removal is ordered after a provision that is already out for that machine
// (whose result could otherwise put the old key back afterwards); a provision
// asked for after this removal queues behind it.
export async function removeProviders({ rpc = machines.rpc } = {}) {
  const ids = new Set([...provisioned.keys(), ...jobs.keys()]);
  // New callers must not join a request that is being superseded; they queue
  // behind the removal instead (reprovision can still see the machine here).
  for (const id of ids) {
    const job = jobs.get(id);
    if (job) job.superseded = true;
  }
  await Promise.all(
    [...ids].map((id) =>
      enqueue(id, async () => {
        await removeQuietly(id, rpc);
        // A provision queued after this removal runs later; one before it has
        // just been undone and must not remain cached.
        provisioned.delete(id);
        headerWarnings.delete(id);
        provisionWarnings.delete(id);
        autoFailures.delete(id);
        secondary.delete(id);
        stopRetry(id);
        machines.setProvision(id, null);
      }),
    ),
  );
}

// The computers whose Kimi has a [secondary_model]: subagents of a DeepSeek
// conversation may run on it, and it may be a subscription model. The bridge
// only creates the DeepSeek default when the section is empty; this live read
// reports whatever is actually there.
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
// bridge makes). `effort` is present only when Kimi has a default_effort.
export function secondaryOf(cfg) {
  const s = cfg?.secondary_model;
  if (!s || typeof s !== 'object') return null;
  const pick = (camel, snake) => s[camel] ?? s[snake];
  const pool = pick('models', 'models');
  const names = pool && typeof pool === 'object' ? Object.keys(pool) : [];
  const model = pick('defaultModel', 'default_model') ?? pick('model', 'model') ?? names[0];
  const effort = pick('defaultEffort', 'default_effort');
  return model ? { model: String(model), models: names, force: pick('force', 'force') === true, ...(typeof effort === 'string' && effort ? { effort } : {}) } : null;
}

// ------------------------------------------------------- recognizing one

export const aliasFor = (id) => `${MODEL_PREFIX}${id}`;
export const isDeepseekModel = (id) => typeof id === 'string' && id.startsWith(MODEL_PREFIX);
// A conversation is a DeepSeek one if it was started as such, or its model
// is one of the DeepSeek provider's.
export const isDeepseek = (s) => s?.mode === 'deepseek' || isDeepseekModel(s?.meta?.model);
