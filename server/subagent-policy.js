// What a conversation's subagent setting can really do, decided at the moment
// it matters (a prompt is about to be sent, a hook is asked, the setting is
// changed) and never assumed from the stored value.
//
// Kimi's native Agent/AgentSwarm run on the computer's global
// [secondary_model]; the stored setting of a conversation is only what was
// *requested*. This module reads what the computer really has and says which
// route can honour the request:
//
//   native-rule  no setting: Kimi's own rule, nothing promised
//   native       DeepSeek is requested and the computer's [secondary_model]
//                is that model (Hub never rewrites that file)
//   broker       the Hub starts the subagent as a child conversation on the
//                requested provider/model/effort: every cross-provider
//                choice, and an explicit DeepSeek choice that differs from
//                the computer's own default
//   blocked      the request cannot be honoured. A subagent must never run
//                on the main model and be shown as the chosen one, so the
//                native tools are held back and the conversation says why
//                and how to fix it
//
// The scope is explicit: a native subagent is machine-global, a broker one is
// per conversation.
import * as machines from './machines.js';
import * as deepseek from './deepseek-account.js';
import * as store from './store.js';

export const CAP = { BROKER: 'broker', HANDOFF: 'handoff', SUBAGENT_CONFIG: 'subagent_config' };
const SECONDARY_TTL_MS = 10_000;
const NATIVE_TOOLS = ['agent', 'agentswarm', 'agent_swarm', 'task'];

export const isNativeTool = (name) => NATIVE_TOOLS.includes(String(name || '').toLowerCase());

// The capabilities a connector declared in its hello. `broker: 1` is the
// number connector 0.10 says; it counts as the 'broker' capability.
export function machineCaps(machine) {
  const caps = new Set(Array.isArray(machine?.capabilities) ? machine.capabilities.map(String) : []);
  if (Number(machine?.broker) >= 1) caps.add(CAP.BROKER);
  return caps;
}

export function machineHas(machineId, cap) {
  const m = machines.getMachine(machineId);
  return Boolean(m?.online && machineCaps(m).has(cap));
}

export function connectorOldError(machineId, what) {
  const m = machines.getMachine(machineId);
  return Object.assign(new Error(`「${m?.name || machineId}」的連接器太舊，沒有${what}。在那台電腦重新執行連接指令（左下角「連接電腦…」）更新後再試。`), { status: 409, code: 'connector_old' });
}

// ---------------------------------------------------- the machine's native default

const secondaryCache = new Map(); // machine id -> { at, value }

/**
 * What the computer's Kimi really has as [secondary_model]:
 *  { state: 'ok', secondary: {model, models, force, effort?} }
 *  { state: 'absent' }                 Kimi answered; there is no such section
 *  { state: 'unknown', error }         could not be read (offline, timeout)
 */
export async function readSecondary(machineId, { force = false, rpc = machines.rpc, now = Date.now() } = {}) {
  const hit = secondaryCache.get(machineId);
  // Only a present section is served from the cache: "absent" and "unknown"
  // are exactly what changes when a provision lands or Kimi comes back, and a
  // stale one would block a prompt for a problem that is already fixed.
  if (!force && hit && hit.value.state === 'ok' && now - hit.at < SECONDARY_TTL_MS) return { ...hit.value, fromCache: true };
  let value;
  try {
    // Short: this sits in front of a prompt, and 'unknown' lets it through.
    const env = await rpc(machineId, 'kimi.request', { method: 'GET', path: '/api/v1/config' }, 4000);
    if (env && env.code !== undefined && env.code !== 0) value = { state: 'unknown', error: `Kimi 回報錯誤 ${env.code}` };
    else {
      const secondary = deepseek.secondaryOf(env?.data ?? env);
      value = secondary ? { state: 'ok', secondary } : { state: 'absent' };
    }
  } catch (err) {
    value = { state: 'unknown', error: err.message };
  }
  // A failed read must not erase what was known a moment ago.
  if (value.state === 'unknown' && hit?.value.state !== 'unknown' && hit && now - hit.at < 5 * 60_000) return { ...hit.value, stale: true };
  secondaryCache.set(machineId, { at: now, value });
  return value;
}

export const forgetSecondary = (machineId) => (machineId ? secondaryCache.delete(machineId) : secondaryCache.clear());
export const cachedSecondary = (machineId) => secondaryCache.get(machineId)?.value || null;

const effectiveOf = (value) => (value?.state === 'ok'
  ? { provider: deepseek.isDeepseekModel(value.secondary.model) ? 'deepseek' : 'kimi', model: value.secondary.model, effort: value.secondary.effort || '', force: value.secondary.force === true, pool: value.secondary.models || [], source: 'secondary_model' }
  : null);

// ---------------------------------------------------------------- the decision

const providerOf = (s) => (s?.provider === 'kimi' || s?.provider === 'claude' || s?.provider === 'deepseek' ? s.provider : store.nodeProvider(s));
const requestedOf = (sub) => (sub ? { provider: sub.provider, model: sub.model || '', effort: sub.effort || '' } : null);
const mark = (s) => (s.state?.subagentExplicit === true ? 'explicit' : 'default');

function whyNoSecondary(machine) {
  const p = machine?.provision;
  if (p && p.ok === false) return { reason: `這台電腦的原生 DeepSeek 子代理設定沒有成功：${p.reason || '原因未知'}`, fix: '到「設定 → DeepSeek」確認 key 與閘道，修好後重新連接這台電腦；或把這個對話的子代理改成「原生規則」。' };
  if (p && p.ok === true) return { reason: '設定流程回報成功，但這台電腦的 Kimi 設定裡仍沒有 [secondary_model]', fix: '重新啟動那台電腦的 Kimi，或重新連接這台電腦後再試。' };
  return { reason: '這台電腦的 Kimi 沒有 [secondary_model]，Kimi 會讓子代理沿用主模型，而不是 DeepSeek', fix: '在「設定 → DeepSeek」貼上 DeepSeek key 並重新連接這台電腦（連接器要是新版）；或把這個對話的子代理改成「原生規則」。' };
}

/**
 * Decide the route for a Kimi/DeepSeek conversation. Never throws.
 * Returns { route, scope, ready, code, reason, fix, requested, effective, enforce, explicit, checkedAt }.
 */
export async function decide(session, opts = {}) {
  const sub = session?.meta?.subagent || null;
  const requested = requestedOf(sub);
  const base = { requested, effective: null, checkedAt: Date.now(), explicit: mark(session) === 'explicit', enforce: false };
  const machine = session?.machineId ? machines.getMachine(session.machineId) : null;
  // Claude's own subagents are the daemon's Task, per conversation.
  if (providerOf(session) === 'claude') {
    const route = !sub ? 'native-rule' : sub.provider === 'claude' ? 'native' : 'broker';
    if (!sub) return { ...base, route, scope: 'conversation', ready: true, code: 'ok', reason: '', fix: '' };
    // The daemon has to understand the setting, or it is accepted and ignored.
    let support = { ok: true, missing: [] };
    try {
      support = await (await import('./adapters/claude-mirror.js')).subagentSupport(session);
    } catch (err) {
      return { ...base, route, scope: 'conversation', ready: null, code: 'unknown', reason: `無法確認這台電腦的 Claude 背景程式（${err.message}）`, fix: '' };
    }
    if (support.ok) return { ...base, route, scope: 'conversation', ready: true, code: 'ok', reason: '', fix: '' };
    const label = machine?.name || '這台電腦';
    return { ...base, route: 'native-rule', refuse: base.explicit, scope: 'conversation', ready: false, code: 'daemon_old', reason: `「${label}」的 Claude 背景程式太舊（缺少：${support.missing.join('、')}），這個子代理設定不會被套用，Task 會用 Claude 的原生規則`, fix: '在那台電腦重新執行連接指令（左下角「連接電腦…」）更新。' };
  }
  if (!sub) return { ...base, route: 'native-rule', scope: 'machine-global', ready: true, code: 'ok', reason: '', fix: '' };

  if (sub.provider !== 'deepseek') return brokerOrBlock(session, machine, base);

  // A DeepSeek request: honoured natively only when the computer's own
  // [secondary_model] is that model and effort.
  if (!machine?.online) return { ...base, route: 'native', scope: 'machine-global', ready: null, code: 'unknown', reason: '這台電腦目前不在線，無法確認它的原生子代理設定', fix: '' };
  let read = await readSecondary(machine.id, opts);
  let problem = findProblem(read, sub, machine, base);
  // A problem found in a remembered answer is checked again against the
  // computer itself before it is believed.
  if (problem && read.fromCache) {
    read = await readSecondary(machine.id, { ...opts, force: true });
    problem = findProblem(read, sub, machine, base);
  }
  const effective = effectiveOf(read);
  if (read.state === 'unknown') return { ...base, effective, route: 'native', scope: 'machine-global', ready: null, code: 'unknown', reason: `無法讀取這台電腦的原生子代理設定（${read.error}）`, fix: '' };

  if (problem) problem = { ...problem, effective };
  if (problem) {
    // An explicit, different choice is honoured by the broker (per
    // conversation, guaranteed). The unmarked default is not promoted to a
    // broker: it is reported.
    if (session.state?.subagentExplicit === true) {
      const via = brokerOrBlock(session, machine, base);
      if (via.route === 'broker') return { ...via, effective, note: problem.reason };
      return { ...via, effective, reason: `${problem.reason}；而且${via.reason}` };
    }
    return { ...problem, route: 'blocked', scope: 'machine-global', ready: false };
  }

  // The model matches. Another pool entry could still be picked by the main
  // model (Kimi lets it pass `model`); the PreToolUse hook refuses that, so it
  // is only guaranteed where the hook is installed.
  const escape = !effective.force && effective.pool.some((m) => m !== sub.model);
  if (escape && !machineCaps(machine).has(CAP.BROKER)) {
    return { ...base, effective, route: 'blocked', scope: 'machine-global', ready: false, code: 'pool_escape', reason: '這台電腦的原生子代理清單裡還有別的模型，主模型可以自己挑走，而連接器太舊、擋不住', fix: '更新那台電腦的連接器（重新執行連接指令），或把 [secondary_model] 設成 force。' };
  }
  return { ...base, effective, route: 'native', scope: 'machine-global', ready: true, code: 'ok', reason: '', fix: '', enforce: escape };
}

// What stops this computer's [secondary_model] from being the requested
// DeepSeek model, or null. `read` is a readSecondary answer.
function findProblem(read, sub, machine, base) {
  if (read.state === 'unknown') return null;
  const miss = (code, reason, fix) => ({ ...base, code, reason, fix });
  if (read.state === 'absent') {
    const why = whyNoSecondary(machine);
    return miss('no_secondary', why.reason, why.fix);
  }
  const eff = effectiveOf(read);
  if (eff.provider !== 'deepseek') return miss('secondary_not_deepseek', `這台電腦的原生子代理預設是 ${eff.model}，不是 DeepSeek（Agent Hub 不會改你的 Kimi 設定）`, '把這個對話的子代理明確選成 DeepSeek 模型（改走橋接），或自己把那台電腦 [secondary_model] 的預設改成 DeepSeek。');
  if (eff.model !== sub.model) return miss('secondary_mismatch', `這台電腦的原生子代理預設是 ${eff.model}，和這個對話選的 ${sub.model} 不同；原生路徑是整台電腦共用的，每個對話不能不同`, '');
  if (sub.effort && eff.effort !== sub.effort) return miss('secondary_mismatch', `這台電腦的原生子代理思考強度是 ${eff.effort || '（未設）'}，和這個對話選的 ${sub.effort} 不同；原生路徑是整台電腦共用的`, '');
  return null;
}

function brokerOrBlock(session, machine, base) {
  const sub = session.meta.subagent;
  if (!machine?.online) return { ...base, route: 'blocked', refuse: true, scope: 'conversation', ready: false, code: 'machine_offline', reason: '這台電腦目前不在線，跨供應商子代理要經過它的連接器', fix: '讓那台電腦的連接器連上後再送出。' };
  if (!machineCaps(machine).has(CAP.BROKER)) {
    return { ...base, route: 'blocked', refuse: true, scope: 'conversation', ready: false, code: 'broker_unsupported', reason: `「${machine.name}」的連接器太舊，沒有子代理 broker，無法用 ${sub.provider} 當子代理`, fix: '在那台電腦重新執行連接指令（左下角「連接電腦…」）更新連接器；或把這個對話的子代理改成「原生規則」。' };
  }
  return { ...base, route: 'broker', scope: 'conversation', ready: true, code: 'ok', reason: '', fix: '' };
}

// ------------------------------------------------------- remembered / shown

const last = new Map(); // session id -> last decision

const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const signature = (p) => JSON.stringify([p.route, p.ready, p.code, p.reason, p.effective, p.requested]);

export async function refresh(session, opts) {
  const was = last.get(session.id);
  const p = await decide(session, opts);
  last.set(session.id, p);
  if (!was || signature(was) !== signature(p)) for (const fn of listeners) try { fn(session, p); } catch {}
  return p;
}

// Read what the computer has, at most every `ms`, without waiting. For a
// conversation that was just opened.
export function refreshSoon(session, ms = 30_000) {
  const was = last.get(session?.id);
  if (!session || (was && Date.now() - was.checkedAt < ms)) return;
  refresh(session).catch(() => {});
}
export const peek = (session) => last.get(session?.id) || null;
export const forget = (sessionId) => last.delete(sessionId);

/**
 * The shape the browser gets with every session summary. `scope` is the
 * honest part: a native subagent is machine-global and its effective value
 * is whatever the computer has, not the conversation's stored choice.
 */
export function infoOf(session) {
  const sub = session?.meta?.subagent || null;
  const p = peek(session);
  const provider = providerOf(session);
  if (provider === 'claude') return { scope: 'conversation', requested: requestedOf(sub), effective: requestedOf(sub), ready: p?.ready ?? null, code: p?.code || 'unchecked', reason: p?.reason || '', fix: p?.fix || '' };
  const cached = session?.machineId ? effectiveOf(cachedSecondary(session.machineId)) : null;
  const native = !sub || sub.provider === 'deepseek';
  if (!p) return { scope: native ? 'machine-global' : 'conversation', requested: requestedOf(sub), effective: native ? cached : requestedOf(sub), ready: null, code: 'unchecked', reason: '', fix: '' };
  return {
    scope: p.scope,
    route: p.route,
    requested: p.requested,
    // Where the machine decides, show what the machine has; where the
    // Hub decides (broker), the request is what will run.
    effective: p.route === 'broker' ? p.requested : p.effective,
    ready: p.ready,
    code: p.code,
    reason: p.reason,
    fix: p.fix,
    checkedAt: p.checkedAt,
  };
}

// The sentence put into the conversation when the request cannot be honoured.
export function noticeText(p) {
  const want = p.requested ? `${p.requested.provider} · ${p.requested.model}${p.requested.effort ? ` · ${p.requested.effort}` : ''}` : '原生規則';
  return `子代理沒有啟動：這個對話要的子代理是 ${want}，但現在無法保證它真的用這個模型。${p.reason}。${p.fix ? `修復：${p.fix}` : ''}（為了不讓子代理悄悄用主模型，原生子代理工具先停用。）`;
}

/**
 * Say it once per distinct problem. Returns true when it was said now.
 */
export function announce(session, p, ctx) {
  const sig = p.ready === false ? `${p.code}|${p.requested?.model || ''}|${p.requested?.effort || ''}|${p.reason}` : '';
  session.state ??= {};
  if ((session.state.subagentNotice || '') === sig) return false;
  session.state.subagentNotice = sig;
  store.saveSession(session);
  if (sig) ctx.emit({ type: 'info', text: noticeText(p), subagentNotice: { code: p.code, scope: p.scope } });
  return Boolean(sig);
}

// For the PreToolUse hook: a native Agent call that names another model.
export function modelsNamed(toolInput, depth = 0) {
  const out = [];
  if (!toolInput || typeof toolInput !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(toolInput)) {
    if (/^model$/i.test(k) && typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (v && typeof v === 'object') out.push(...modelsNamed(v, depth + 1));
  }
  return out;
}

// ------------------------------------------------ the card contract
//
// Every subagent card carries three things, so nobody has to guess:
//   requested        what the conversation asked for when the card was made
//                    (a snapshot; later setting changes do not touch it)
//   actual           what the runtime itself reported, or null
//   unverifiedReason why `actual` is null (waiting, not reported, replayed…)
export const UNVERIFIED = {
  pending: '子代理還沒啟動（工具呼叫還在等待核准或排隊），所以還沒有實際模型',
  noModel: 'Kimi 回報子代理啟動，但事件裡沒有帶出模型名稱（這個版本的 Kimi 沒有回報），所以無法確認實際用的模型',
  replay: '這是從 Kimi 紀錄還原的歷史卡片，紀錄沒有保留這個子代理實際用的模型',
  btw: 'btw 側問不是一般子代理，Kimi 不回報它用的模型',
  child: '子對話還沒有回報實際使用的模型',
  waitingClaude: '還在等 Claude 第一次回覆，確認實際模型',
};
export const providerOfModel = (model) => (deepseek.isDeepseekModel(model) ? 'deepseek' : /^claude-/.test(String(model || '')) ? 'claude' : 'kimi');
export const actualOf = (model, effort) => (model ? { provider: providerOfModel(model), model: String(model), effort: effort || '' } : null);
export const requestedSnapshot = (session) => requestedOf(session?.meta?.subagent || null);
/** Fields of a card's `subagent` object for the three-part contract. */
export function contract({ requested, actual = null, reason = '' }) {
  // `unverifiedReason: undefined` overrides a stale reason when the card is
  // rebuilt by spreading its previous subagent object.
  return { requested: requested ? { ...requested } : null, actual: actual ? { ...actual } : null, unverifiedReason: actual ? undefined : reason || UNVERIFIED.pending };
}
