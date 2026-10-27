// The Hub side of the 3×3 subagent broker. A Kimi/DeepSeek main agent reaches
// it through the bridge's local MCP channel when the conversation's subagent
// choice is cross-provider (Kimi or Claude); a DeepSeek choice is Kimi's own
// native Agent/AgentSwarm on its [secondary_model] and never comes here.
// Claude's daemon reaches the same runner.delegateToProvider contract through
// DS2. Tokens are short-lived, random, bound to one Hub node / Kimi native
// session / machine, and are never returned by the public API or stored in an
// event.
import crypto from 'node:crypto';
import * as store from './store.js';
import * as machines from './machines.js';
import * as policy from './subagent-policy.js';

export const BROKER_VERSION = 1;
const TTL_MS = 15 * 60_000;
// A turn can outlast the token it was given (a long task, a pending
// approval): while the conversation that got it is still working, it stays
// valid, for at most this long from when it was issued.
const HARD_MAX_MS = 6 * 60 * 60_000;
const tokens = new Map(); // token -> { hubSessionId, conversationId, kimiSessionId, machineId, issuedAt, ttl, exp }

const working = (id) => ['running', 'awaiting_permission'].includes(store.getSession(id)?.status);

// A token is live until it expires; an expired one lives on while its
// conversation is still working the turn that received it.
function live(r, now) {
  if (r.exp > now) return true;
  if (working(r.hubSessionId) && now - r.issuedAt < HARD_MAX_MS) {
    r.exp = now + r.ttl;
    return true;
  }
  return false;
}

function prune(now = Date.now()) {
  for (const [t, r] of tokens) if (!r || !live(r, now)) tokens.delete(t);
}

export function supportsBroker(machineId) {
  return policy.machineHas(machineId, policy.CAP.BROKER);
}

// One live token per conversation: it is reused while it has most of its life
// left, so the conversation's history never fills with different tokens (a
// model picking an old one gets "expired"), and a new one replaces the old.
export function issueToken(session, { ttlMs = TTL_MS } = {}) {
  if (!session?.kimiSessionId || !session.machineId) return null;
  prune();
  const ttl = Math.min(Math.max(Number(ttlMs) || TTL_MS, 1000), TTL_MS);
  const now = Date.now();
  for (const [t, r] of tokens) {
    if (r.hubSessionId !== session.id) continue;
    if (r.kimiSessionId === session.kimiSessionId && r.machineId === session.machineId && r.exp - now > ttl / 2) return t;
    tokens.delete(t);
  }
  const token = `hb_${crypto.randomBytes(24).toString('hex')}`;
  tokens.set(token, {
    hubSessionId: session.id,
    conversationId: session.conversationId || session.id,
    kimiSessionId: session.kimiSessionId,
    machineId: session.machineId,
    issuedAt: now,
    ttl,
    exp: now + ttl,
  });
  return token;
}

export function validateToken(token, { hubSessionId = null, machineId = null, kimiSessionId = null } = {}) {
  prune();
  const r = tokens.get(String(token || ''));
  if (!r) throw Object.assign(new Error('子代理 delegation token 無效或已過期；請重新送出訊息取得新的指示'), { status: 403, code: 'bad_token' });
  if (hubSessionId && r.hubSessionId !== hubSessionId) throw Object.assign(new Error('delegation token 不屬於這個對話'), { status: 403, code: 'bad_token' });
  if (machineId && r.machineId !== machineId) throw Object.assign(new Error('delegation token 不屬於這台電腦'), { status: 403, code: 'bad_token' });
  if (kimiSessionId && r.kimiSessionId !== kimiSessionId) throw Object.assign(new Error('delegation token 不屬於這個 Kimi 對話'), { status: 403, code: 'bad_token' });
  return r;
}

// The conversation stopped using the broker (setting changed, native route,
// node replaced): its tokens are dead from now on.
export function revokeSession(hubSessionId) {
  for (const [t, r] of tokens) if (r.hubSessionId === hubSessionId) tokens.delete(t);
}

export function dropToken(token) {
  tokens.delete(String(token || ''));
}

// Only called inside the Hub process (never exposed over HTTP).
export function tokenSession(token) {
  const r = validateToken(token);
  return store.getSession(r.hubSessionId) || null;
}

function kimiSessionFor(machineId, kimiSessionId) {
  return store.listSessions().find((s) => s.machineId === machineId && s.kimiSessionId === kimiSessionId && !s.continuedTo) || null;
}

async function handleHook(machineId, args = {}) {
  if (!policy.isNativeTool(args.toolName)) return { deny: false };
  const s = kimiSessionFor(machineId, String(args.sessionId || ''));
  const sub = s?.meta?.subagent;
  // No custom subagent setting: leave Kimi's native subagent behaviour alone.
  if (!sub) return { deny: false };
  // A cross-provider (Kimi/Claude) choice can only run through the Hub's
  // broker: a native call would silently use Kimi's own model instead.
  if (sub.provider !== 'deepseek') {
    return {
      deny: true,
      reason: '這個對話的子代理設定走 Agent Hub 的跨供應商 broker。請不要使用原生 Agent／AgentSwarm；改用 MCP tool mcp__agent-hub__delegate_to_provider，並帶上這則對話 hidden system-reminder 裡的 token。',
    };
  }
  // DeepSeek is the native path, but only while the computer's own
  // [secondary_model] really is the requested model. Anything else is
  // reported before a subagent starts, never run on the main model.
  const p = await policy.refresh(s).catch(() => null);
  if (!p) return { deny: false };
  if (p.route === 'broker') {
    return { deny: true, reason: '這個對話的子代理（DeepSeek）和這台電腦的原生預設不同，要走 Agent Hub 的 broker。請不要使用原生 Agent／AgentSwarm；改用 MCP tool mcp__agent-hub__delegate_to_provider，並帶上這則對話 hidden system-reminder 裡的 token。' };
  }
  if (p.route === 'blocked') return { deny: true, reason: `${policy.noticeText(p)}` };
  if (p.route === 'native' && p.enforce) {
    // Kimi lets the main model pick another model of the pool (or "primary")
    // per call; this conversation's subagent is the DeepSeek one.
    const other = policy.modelsNamed(args.toolInput).filter((m) => m !== sub.model);
    if (other.length) return { deny: true, reason: `這個對話的子代理固定是 DeepSeek（${sub.model}）。請省略 model 參數（或只用這個模型），不要指定 ${other[0]}。` };
  }
  return { deny: false };
}

async function handleDelegate(machineId, args = {}) {
  const r = validateToken(args.token, { machineId });
  const parent = store.getSession(r.hubSessionId);
  if (!parent) throw Object.assign(new Error('找不到這個對話'), { status: 404 });
  if (parent.continuedTo) throw Object.assign(new Error('這個節點已被接續；請從最新的對話使用子代理'), { status: 409 });
  // The binding is checked against the conversation as it is now, not only
  // against what the token said when it was issued: its native session must
  // still be the one the token was for, and it must still choose the broker.
  validateToken(args.token, { hubSessionId: parent.id, machineId: parent.machineId, kimiSessionId: parent.kimiSessionId });
  const p = await policy.decide(parent);
  if (p.route !== 'broker') {
    revokeSession(parent.id);
    throw Object.assign(new Error('這個對話的子代理設定已經改變（現在不走 Agent Hub broker），這張 token 已失效；請重新送出訊息'), { status: 403, code: 'bad_token' });
  }
  const runner = await import('./runner.js');
  return runner.delegateToProvider(parent, {
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    task: args.task,
    parentEventId: args.parentEventId,
    background: args.background === true,
    token: args.token,
  });
}

// Registered once by index.js. The bridge sends {t:'bridge.req', kind,
// args}; this returns the result and machines.js writes it back to the bridge.
export async function handleBridgeRequest(machineId, msg) {
  if (msg.kind === 'hook') return handleHook(machineId, msg.args || {});
  if (msg.kind === 'broker') return handleDelegate(machineId, msg.args || {});
  throw Object.assign(new Error(`未知的 bridge request：${String(msg.kind).slice(0, 40)}`), { status: 400 });
}

let installed = false;
export function install() {
  if (installed) return;
  installed = true;
  machines.onBridgeRequest(handleBridgeRequest);
}

export const _tokens = tokens; // tests only
