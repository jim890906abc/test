// The Claude API account the hub talks to Claude with: an API key made in
// the Claude Console (console.anthropic.com → API Keys, "sk-ant-…"),
// billed per token to that Console organization's credits.
//
// Only that. The hub never runs Claude Code and never reads a Claude Code /
// claude.ai sign-in: a subscription OAuth token (sk-ant-oat…, sk-ant-ort…)
// is refused, and the client below is built with the key alone: no
// Authorization header, no credential profile, no ANTHROPIC_BASE_URL — every
// request goes to https://api.anthropic.com with `x-api-key`.
//
// The key is kept in data/claude.json (readable by this user only) and never
// sent to a browser; pages see only its last four characters. The file is
// written whole or not at all (flushed to disk first), and a file that is there
// but cannot be used is never taken for "no key": it is copied into
// data/damaged-config/, said, shown to the person (`damaged` in the account),
// and written over only when they type the key in again (store.GuardedConfig).
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR, GuardedConfig } from './store.js';

const FILE = path.join(DATA_DIR, 'claude.json');
export const API_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-opus-5-5';

// The tests run the hub against a local fake of the API. Nothing else can
// point it anywhere but api.anthropic.com.
function baseURL() {
  const u = process.env.AGENT_HUB_CLAUDE_TEST_URL;
  return u && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u) ? u : API_URL;
}

// --------------------------------------------------------------- the key

// Why `key` cannot be used, or null when it is a Console API key.
export function checkKey(key) {
  const k = String(key || '').trim();
  if (!k) return '請貼上 API key';
  if (/^sk-ant-o(at|rt)/i.test(k)) return '這是 Claude Code／Claude 訂閱帳號的登入 token，不是 API key。中控台只用 Claude Console 的 API key：到 console.anthropic.com → API Keys 建立一把（sk-ant- 開頭）。';
  if (/^sk-ant-admin/i.test(k)) return '這是 Admin API key，不能拿來對話。請在 Claude Console 建立一般的 API key（sk-ant- 開頭）。';
  // Other sk-ant-… keys made in the Console (sk-ant-api…, and newer kinds)
  // are let through: whether one works is for Anthropic to say, and it is
  // checked against the API before it is saved. Only ever sent as x-api-key.
  if (!/^sk-ant-[a-z]+\d*-[\w-]{20,}$/i.test(k)) return '這不是 Claude Console 的 API key（應該是 sk-ant- 開頭的一長串）。';
  return null;
}

const keyFile = new GuardedConfig(FILE, {
  tag: 'claude',
  what: 'Claude API key',
  lost: 'Claude API key 已無法載入，請重新輸入或從備份還原（左下角「⋯」→「Claude API…」）',
  until: '重新輸入 API key',
});
let saved = keyFile.read().value ?? {};

// `next` becomes the saved state only once it is on disk. `explicit`: the
// person typed a key in (the thing a damaged file lost), which may replace it.
function save(next, { explicit = false } = {}) {
  keyFile.write(next, { mode: 0o600, explicit });
  saved = next;
}

// Why the saved key cannot be used (its file is damaged or cannot be read), or
// null. Said instead of "no key is set" wherever that would be said.
export const keyProblem = () => keyFile.describe();

// ANTHROPIC_API_KEY works too (when it holds a Console API key), unless a
// key was saved in the hub.
const envKey = () => {
  const k = String(process.env.ANTHROPIC_API_KEY || '').trim();
  return k && !checkKey(k) ? k : '';
};
export const apiKey = () => saved.apiKey || envKey();
export const keySource = () => (saved.apiKey ? 'hub' : envKey() ? 'env' : null);
const masked = (k) => (k ? `${k.split('-').slice(0, 3).join('-')}…${k.slice(-4)}` : '');

export function setKey(key) {
  const k = String(key || '').trim();
  const why = checkKey(k);
  if (why) throw Object.assign(new Error(why), { status: 400 });
  save({ ...saved, apiKey: k }, { explicit: true });
  modelCache = null;
}

export function clearKey() {
  const { apiKey: _, ...rest } = saved;
  save(rest);
  modelCache = null;
}

// A client that can only spend this key. Headers the environment might add
// (ANTHROPIC_CUSTOM_HEADERS) cannot swap the key or add a bearer token.
export function client(key = apiKey()) {
  if (!key) throw Object.assign(new Error(keyProblem() || '還沒有設定 Claude API key。在「設定」→「Claude API…」貼上 Claude Console 的 API key。'), { status: 409, code: keyProblem() ? 'key_unusable' : 'no_key' });
  return new Anthropic({
    apiKey: key,
    authToken: null,
    baseURL: baseURL(),
    maxRetries: 3,
    timeout: 20 * 60_000,
    defaultHeaders: { 'X-Api-Key': key, Authorization: null },
  });
}

// ------------------------------------------------------------- settings

const EFFORTS = ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSIONS = ['manual', 'edits', 'auto'];

export function settings() {
  const d = saved.defaults || {};
  return {
    defaults: {
      model: typeof d.model === 'string' && d.model ? d.model : DEFAULT_MODEL,
      effort: EFFORTS.includes(d.effort) ? d.effort : 'high',
      permission: PERMISSIONS.includes(d.permission) ? d.permission : 'manual',
      planMode: Boolean(d.planMode),
    },
    webTools: saved.webTools !== false,
  };
}

// `explicit`: the settings come from the one who owns them (the Hub tells a
// computer's Claude daemon its settings), not from a person's change here.
export function setSettings({ defaults, webTools } = {}, { explicit = false } = {}) {
  const next = { ...saved };
  if (defaults && typeof defaults === 'object') {
    const d = { ...(saved.defaults || {}) };
    if (typeof defaults.model === 'string' && defaults.model.length <= 100) d.model = defaults.model;
    if (EFFORTS.includes(defaults.effort)) d.effort = defaults.effort;
    if (PERMISSIONS.includes(defaults.permission)) d.permission = defaults.permission;
    if ('planMode' in defaults) d.planMode = Boolean(defaults.planMode);
    next.defaults = d;
  }
  if (typeof webTools === 'boolean') next.webTools = webTools;
  // The daemon is told the same settings with every request: not a write each time.
  if (!keyFile.problem && JSON.stringify(next) === JSON.stringify(saved)) return;
  save(next, { explicit });
}

export function publicAccount() {
  const key = apiKey();
  return { hasKey: Boolean(key), keySource: keySource(), keyHint: masked(key), apiUrl: API_URL, ...settings(), damaged: keyFile.public() };
}

// --------------------------------------------------------------- models

// What the hub knows about each model beyond what the Models API says:
// US$ per million tokens (input, output, cache read; cache writes are 1.25×
// input), how thinking is set, and which thinking levels it offers. `off`
// is how to turn thinking off, when the model allows it at its default
// effort. `sys`: takes `role: "system"` messages mid-conversation. `web`:
// web search / fetch with dynamic filtering (2026-02-09), else basic search.
// `summarized`: shows its thinking without being asked (the 4.6 models).
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const KNOWN = [
  ['claude-opus-5-5', 'Claude Opus 5.5', { price: [4, 20, 0.2], efforts: FIVE, def: 'medium', sys: true, web: true}],
  ['claude-fable-5-1', 'Claude Fable 5.1', { price: [10, 50, 0.25], efforts: FIVE, def: 'high', sys: true}],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', { price: [2, 10, 0.2], efforts: FIVE, def: 'high', off: 'between_tools', sys: true, web: true}],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', { price: [0.1, 0.5, 0.01], longPrice: [0.5, 2.5, 0.05], efforts: FIVE, def: 'medium', off: 'disabled', sys: true }],
  ['claude-opus-5', 'Claude Opus 5', { price: [5, 25, 0.5], efforts: FIVE, def: 'high', off: 'disabled', sys: true, web: true}],
  ['claude-fable-5', 'Claude Fable 5', { price: [10, 50, 1], efforts: FIVE, def: 'high', sys: true }],
  ['claude-sonnet-5', 'Claude Sonnet 5', { price: [2, 10, 0.2], efforts: FIVE, def: 'high', off: 'disabled', web: true }],
  ['claude-opus-4-8', 'Claude Opus 4.8', { price: [5, 25, 0.5], efforts: FIVE, def: 'high', off: 'disabled', sys: true, web: true }],
  ['claude-opus-4-7', 'Claude Opus 4.7', { price: [5, 25, 0.5], efforts: FIVE, def: 'high', off: 'disabled', web: true }],
  ['claude-opus-4-6', 'Claude Opus 4.6', { price: [5, 25, 0.5], efforts: ['low', 'medium', 'high', 'max'], def: 'high', off: 'disabled', web: true, summarized: true }],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', { price: [3, 15, 0.3], efforts: ['low', 'medium', 'high', 'max'], def: 'high', off: 'disabled', web: true, summarized: true }],
  ['claude-haiku-4-5', 'Claude Haiku 4.5', { price: [1, 5, 0.1], budget: true, context: 200_000, maxOut: 64_000 }],
].map(([id, name, x], order) => ({ id, name, order, context: 1_000_000, maxOut: 128_000, ...x }));
const known = (id) => KNOWN.find((m) => m.id === id) || null;

// The shape the composer shows (same as Kimi's model list), plus the
// hub's own details.
function info(id, live) {
  const k = known(id);
  const caps = live?.capabilities || {};
  let efforts = k?.efforts;
  if (!efforts && caps.effort?.supported) efforts = FIVE.filter((e) => caps.effort[e]?.supported);
  const adaptive = k ? !k.budget : Boolean(caps.thinking?.types?.adaptive?.supported);
  efforts = k?.budget ? ['off', 'on'] : [...(k?.off ? ['off'] : []), ...(efforts || [])];
  return {
    id,
    name: live?.display_name || k?.name || id,
    efforts,
    defaultEffort: k?.budget ? 'off' : k?.def || (efforts.includes('high') ? 'high' : efforts[0] || null),
    image: caps.image_input ? Boolean(caps.image_input.supported) : true,
    context: live?.max_input_tokens || k?.context || 200_000,
    maxOut: live?.max_tokens || k?.maxOut || 64_000,
    adaptive,
    priced: Boolean(k?.price),
  };
}

let modelCache = null; // { at, models }
// The models this key can use, newest first (the Models API), with the
// hub's details. Without a key, or when the API cannot be reached, the
// hub's own list.
export async function models({ fresh = false } = {}) {
  if (!fresh && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  let list = null;
  if (apiKey()) {
    try {
      const out = [];
      for await (const m of client().models.list({ limit: 100 })) out.push(m);
      list = out;
    } catch (err) {
      if (fresh) throw err;
    }
  }
  const ids = list ? list.map((m) => m.id) : KNOWN.map((m) => m.id);
  const byId = new Map((list || []).map((m) => [m.id, m]));
  const out = ids
    .filter((id) => /^claude-/.test(id))
    .map((id) => info(id, byId.get(id)))
    .sort((a, b) => (known(a.id)?.order ?? 99) - (known(b.id)?.order ?? 99));
  if (list) modelCache = { at: Date.now(), models: out };
  return out;
}

export function modelInfo(id) {
  return modelCache?.models.find((m) => m.id === id) || info(id, null);
}

// How a request asks for thinking at `effort` on `model`: the `thinking`
// and `output_config` fields, or nothing to leave the model's default.
export function thinkingFor(model, effort) {
  const k = known(model);
  const m = modelInfo(model);
  if (k?.budget) return effort === 'on' ? { thinking: { type: 'enabled', budget_tokens: 16_000 } } : {};
  const efforts = m.efforts || [];
  if (effort === 'off' && efforts.includes('off')) return { thinking: { type: k?.off || 'disabled' } };
  const e = efforts.includes(effort) && effort !== 'off' ? effort : m.defaultEffort && m.defaultEffort !== 'off' ? m.defaultEffort : null;
  const out = {};
  // Summarized thinking: the newer models send it empty unless asked.
  if (m.adaptive) out.thinking = k?.summarized ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' };
  if (e && efforts.length) out.output_config = { effort: e };
  return out;
}

export const supportsSystemMessages = (model) => Boolean(known(model)?.sys);

// Server-side web tools for `model`. Declared from the first request of a
// conversation, so the prompt stays cacheable.
export function webTools(model) {
  if (known(model)?.web) {
    return [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
    ];
  }
  return [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
}

// What one response cost, in US$, from its usage (estimated with the list
// prices above; null for a model the hub has no prices for).
export function costOf(model, usage = {}) {
  const k = known(model);
  if (!k?.price) return null;
  const input = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const [pin, pout, pread] = k.longPrice && input + write + read > 100_000 ? k.longPrice : k.price;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * pin + write * pin * 1.25 + read * pread + (usage.output_tokens || 0) * pout) / 1e6 + searches * 0.01;
}

// The rate limits Anthropic reports with each response.
export function rateLimits(headers) {
  if (!headers?.get) return null;
  const out = {};
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const limit = headers.get(`anthropic-ratelimit-${kind}-limit`);
    if (limit == null) continue;
    out[kind] = { limit: Number(limit), remaining: Number(headers.get(`anthropic-ratelimit-${kind}-remaining`)), reset: headers.get(`anthropic-ratelimit-${kind}-reset`) || null };
  }
  return Object.keys(out).length ? { ...out, at: Date.now() } : null;
}

// An API error, said plainly.
export function explain(err) {
  const status = err?.status;
  const msg = err?.error?.error?.message || err?.message || String(err);
  if (status === 401) return 'Claude API key 無效或已被撤銷。到「設定」→「Claude API…」換一把 Claude Console 的 API key。';
  if (status === 403) return `這把 API key 沒有權限：${msg}`;
  if (status === 404) return `找不到這個模型，或這把 API key 不能用它：${msg}`;
  if (status === 429) return `達到 Claude API 的速率限制（重試後仍然失敗）。稍等一下再試，或到 Claude Console 查看限制。${msg ? `\n${msg}` : ''}`;
  if (status === 529 || /overloaded/i.test(msg)) return 'Anthropic 的伺服器目前忙碌（overloaded），請稍後再試。';
  if (/credit balance/i.test(msg)) return 'Claude Console 帳戶的額度不足。到 console.anthropic.com → Billing 儲值後再試。';
  if (status === 400) return `Claude API 拒絕了這個請求：${msg}`;
  if (status >= 500) return `Anthropic 的伺服器發生錯誤（${status}），請稍後再試。`;
  if (err?.name === 'APIConnectionError' || /fetch failed|ENOTFOUND|ECONNRE/i.test(msg)) return `連不上 api.anthropic.com：${msg}`;
  return msg;
}
