// The choices behind the home screen and 設定, kept free of the DOM so they can
// be tested directly in node.
import { isProvider, modelWithProvider, PROVIDER_LABELS } from './providers.js';

// What the server gives a new conversation that names no subagent (spec §4).
// The server decides; this is only what the screen says about it.
export const DEFAULT_SUBAGENT = Object.freeze({ provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' });

// A subagent choice has three states, and they are three different requests:
//   'default'  nothing chosen   -> send nothing; the server applies its default
//   'follow'   chosen: native   -> send null  ("跟隨主模型／原生規則")
//   'custom'   chosen: a model  -> send { provider, model, effort }
// `undefined` and `null` must never be folded into one another.
const validChoice = (s) => Boolean(s) && typeof s === 'object' && isProvider(s.provider) && typeof s.model === 'string' && s.model !== '';

export function subagentMode(value) {
  if (value === undefined) return 'default';
  if (value === null) return 'follow';
  return validChoice(value) ? 'custom' : 'default';
}

// The mode of a store that may not have the key at all (the home choices in
// localStorage, a conversation's meta).
export function modeIn(obj) {
  if (!obj || !Object.hasOwn(obj, 'subagent')) return 'default';
  return subagentMode(obj.subagent);
}

// What to put in POST /api/sessions for `subagent`: undefined (leave it out),
// null (native rules) or the choice.
export function subagentPayload(obj) {
  switch (modeIn(obj)) {
    case 'follow':
      return null;
    case 'custom':
      return { provider: obj.subagent.provider, model: obj.subagent.model, effort: obj.subagent.effort || '' };
    default:
      return undefined;
  }
}

// What the new conversation will really get, as the same shape a stored value has.
export function effectiveSubagent(mode, value) {
  if (mode === 'follow') return null;
  if (mode === 'custom') return value;
  return { ...DEFAULT_SUBAGENT };
}

// Text for a subagent choice: "DeepSeek V4.1 Flash · 思考 max" (the provider is
// said once, see modelWithProvider). `nameOf(provider, model)`
// turns a model id into the name people know.
export function subagentChoiceText(sub, { nameOf = (p, id) => String(id).split('/').pop(), effortLabel = (e) => e } = {}) {
  if (!sub) return '跟隨主模型／原生規則';
  return [modelWithProvider(PROVIDER_LABELS[sub.provider], nameOf(sub.provider, sub.model) || sub.model), sub.effort ? `思考 ${effortLabel(sub.effort)}` : ''].filter(Boolean).join(' · ');
}

// The same text for the three modes, for chips and dialogs.
export function subagentModeText(mode, value, opts) {
  if (mode === 'follow') return '跟隨主模型';
  if (mode === 'custom') return subagentChoiceText(value, opts);
  return `${subagentChoiceText(DEFAULT_SUBAGENT, opts)}（預設）`;
}

// A server default for a provider, with the account defaults as the fallback
// for an old server that has no byProvider entry. `defaults.byProvider[p]` is
// the one place the new-conversation defaults live.
export function providerDefaultsFor(provider, serverDefaults = {}, account = null) {
  const d = serverDefaults || {};
  const by = d.byProvider && typeof d.byProvider === 'object' && !Array.isArray(d.byProvider) ? d.byProvider[provider] : null;
  const legacyKimi = { model: d.model || '', effort: d.effort || '', permission: d.permission || 'manual', planMode: Boolean(d.planMode) };
  const acc = account || {};
  const fallback = provider === 'kimi' ? legacyKimi : { model: acc.model || '', effort: acc.effort || '', permission: acc.permission || 'manual', planMode: Boolean(acc.planMode) };
  if (!by || typeof by !== 'object') return fallback;
  const has = (key) => Object.hasOwn(by, key);
  return {
    model: has('model') ? (typeof by.model === 'string' ? by.model : '') : fallback.model,
    effort: has('effort') ? (typeof by.effort === 'string' ? by.effort : '') : fallback.effort,
    permission: has('permission') ? by.permission || fallback.permission : fallback.permission,
    planMode: has('planMode') ? Boolean(by.planMode) : fallback.planMode,
  };
}

// Run steps in order; if one fails, undo the ones already done (newest first)
// and rethrow its error. Used where saving one dialog takes more than one
// request, so a failure in the last cannot leave the first half applied.
export async function runWithRollback(steps) {
  const done = [];
  let current = null;
  try {
    for (const step of steps) {
      if (!step) continue;
      current = step;
      await step.run();
      done.push(step);
    }
  } catch (err) {
    err.failedStep = current?.name || '';
    const failed = [];
    for (const step of done.reverse()) {
      try {
        await step.undo?.();
      } catch (undoErr) {
        failed.push(step.name || 'step');
        void undoErr;
      }
    }
    if (failed.length) err.rollbackFailed = failed;
    throw err;
  }
}
