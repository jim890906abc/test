// The Hub keeps its own record of which model a conversation runs on
// (`modelConfig`), and the native Kimi reports what it really runs on
// (`meta.model`, from agent.status.updated or the journal). They can disagree:
// a config.update from somewhere else, a global default applied to the wrong
// conversation, a change typed into the terminal. This module is the one place
// that names the difference, so the summary, the send path and the switch path
// all read the same answer.
//
// Kept free of the runner and of the adapters (both import it).
import * as store from './store.js';
import * as deepseek from './deepseek-account.js';

const PROVIDERS = ['kimi', 'claude', 'deepseek'];

// Which provider a model alias belongs to, by its form alone (what the native
// reports is an alias, never the conversation's label):
//   agent-hub-deepseek/<gateway id>    the DeepSeek provider the bridge made
//   deepseek-… , deepseek/deepseek-…   a bare / vendor-prefixed gateway id
//   claude-…                           Anthropic
//   anything else (kimi-code/…, managed:kimi-code/…)   Kimi
export function providerOfAlias(id) {
  const m = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!m) return null;
  if (deepseek.isDeepseekModel(m)) return 'deepseek';
  if (/^(deepseek\/)?deepseek-/i.test(m)) return 'deepseek';
  if (/^claude/i.test(m)) return 'claude';
  return 'kimi';
}

// One spelling for one model: the Hub says `agent-hub-deepseek/deepseek-v4.1-flash`,
// a gateway lists `deepseek-v4.1-flash` or `deepseek/deepseek-v4.1-flash`, Kimi's
// own list prefixes `managed:`.
export function canonicalModel(id) {
  return String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/^managed:/, '')
    .replace(/^agent-hub-deepseek\//, '')
    .replace(/^deepseek\/(?=deepseek)/, '');
}

// The last part of an alias: `kimi-code/k3.1-pro` and a bare `k3.1-pro` name the
// same model when the native leaves its provider prefix out.
const tail = (id) => canonicalModel(id).replace(/^.*\//, '');

export const sameModel = (a, b) => {
  const x = canonicalModel(a);
  const y = canonicalModel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return providerOfAlias(a) === providerOfAlias(b) && tail(a) === tail(b);
};

// The provider a conversation was made for. The conversation's own field
// wins; an old record without it is read from what it kept (the legacy mode,
// the DeepSeek marker, a DeepSeek model in its settings or in what the native
// last reported).
export function providerOf(s) {
  return store.nodeProvider(s);
}

// Whether a conversation may be a DeepSeek one, for the code that must never
// put a Kimi setting on one. A provider the user or a switch set is believed
// either way (a Kimi conversation that once was DeepSeek keeps its old marker
// but is Kimi now). An old record whose provider was only worked out is read
// widely - the legacy mode, the marker, a DeepSeek model in its settings or in
// what the native last said - because one wrongly cleared would be moved onto
// the Kimi subscription, one wrongly suspected is merely left alone.
export function isDeepseekFamily(s) {
  if (!s) return false;
  if (PROVIDERS.includes(s.provider) && !s.providerInferred) return s.provider === 'deepseek';
  return (
    providerOf(s) === 'deepseek' ||
    s.mode === 'deepseek' ||
    Boolean(s.state?.deepseek) ||
    providerOfAlias(s.meta?.model) === 'deepseek' ||
    providerOfAlias(s.modelConfig?.model) === 'deepseek'
  );
}

// What the native conversation reported last, or null while it has not said
// (a conversation just attached, a journal that has not recorded it yet).
export function nativeOf(s) {
  const model = typeof s?.meta?.model === 'string' ? s.meta.model.trim() : '';
  if (!model) return null;
  const effort = typeof s.meta.effort === 'string' ? s.meta.effort : '';
  return { provider: providerOfAlias(model), model, effort, at: s.meta.modelAt || null };
}

// A Kimi-runtime conversation's drift: the Hub's choice against what the
// native really runs. null when they agree, when nothing is known about the
// native yet (never guessed into a drift), and for conversations this does not
// apply to (Claude, a sub-agent child, an old node of a chain).
//
//   { kind: 'provider'|'model'|'effort',
//     expected: { provider, model, effort },   what the Hub recorded / the user chose
//     actual:   { provider, model, effort },   what the native reports
//     since }                                   when the native last changed its model
export function driftOf(s, provider = providerOf(s)) {
  if (!s?.kimiSessionId || s.parentId || s.continuedTo) return null;
  if (provider !== 'kimi' && provider !== 'deepseek') return null;
  const native = nativeOf(s);
  if (!native) return null;
  const mc = s.modelConfig || {};
  // A record that names a model of the wrong family (an old Hub followed the
  // native onto it) is no statement of what the user chose.
  let model = typeof mc.model === 'string' ? mc.model : '';
  if (model && providerOfAlias(model) !== provider) model = '';
  if (!model && provider === 'deepseek' && deepseek.isDeepseekModel(s.state?.deepseek?.model)) model = s.state.deepseek.model;
  const effort = typeof mc.effort === 'string' ? mc.effort : '';
  const expected = { provider, model, effort };
  const actual = { provider: native.provider, model: native.model, effort: native.effort };
  let kind = null;
  if (native.provider !== provider) kind = 'provider';
  else if (model && !sameModel(model, native.model)) kind = 'model';
  else if (effort && s.state?.userSet?.effort && native.effort && native.effort !== 'off' && native.effort !== effort) kind = 'effort';
  return kind ? { kind, expected, actual, since: native.at } : null;
}

// Does the native already run on this target? Unknown is not a yes.
export function nativeMatches(s, target) {
  const native = nativeOf(s);
  if (!native || !sameModel(native.model, target.model)) return false;
  if (!target.effort) return true;
  return native.effort === target.effort;
}

// Who decides when the two disagree, for the code that would put the Hub's
// choice back. The Hub's choice is the user's when they picked the model in
// the Hub (userSet.model) or when the family itself is off (a DeepSeek
// conversation running a Kimi model, or the reverse): the conversation's
// provider is always chosen by the user, never by a default.
export const userChose = (s, drift) => drift?.kind === 'provider' || Boolean(s?.state?.userSet?.model);

export { PROVIDERS };
