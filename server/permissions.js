// Permission modes across providers.
//
// Each runtime has its own vocabulary, and the same word does NOT mean the
// same thing in both:
//
//   Kimi runtime (Kimi and DeepSeek conversations; `kimi --help`):
//     manual  every action asks.
//     yolo    "Ask When Needed": routine edits and commands run on their
//             own; risky actions, questions and plans still ask.
//     auto    "Never Ask": everything runs and is decided automatically.
//   Claude daemon (server/adapters/claude.js needsPermission):
//     manual  every file change and command asks.
//     edits   file changes go through; commands ask.
//     auto    nothing asks.
//   Hub-level permissionMode (runner.js needsPermission, Hub's own tools):
//     ask / auto_edits / bypass.
//
// Moving a conversation (or a sub-agent) from one runtime to the other must
// never make it ask LESS than before. Each mode is therefore described by the
// kinds of action it lets through without asking, and a mode is only ever
// mapped to the most permissive mode of the other vocabulary whose grants are
// all among the source's. Where nothing in between exists the result is
// stricter (down to `manual`), and the caller says so. A value that is not in
// the source vocabulary grants nothing: it becomes `manual`, never a
// passed-through string the other side might read differently.
//
// This module is pure (no imports): the one place the mapping lives.

export const KIMI_MODES = Object.freeze(['manual', 'yolo', 'auto']);
export const CLAUDE_MODES = Object.freeze(['manual', 'edits', 'auto']);
export const HUB_MODES = Object.freeze(['ask', 'auto_edits', 'bypass']);

const EDIT = ['edit.routine', 'edit.risky'];
const EXEC = ['exec.routine', 'exec.risky'];
// `prompt`: the model's own questions and plan approvals. Only Kimi's
// "Never Ask" answers those by itself.
const ALL = [...EDIT, ...EXEC, 'prompt'];

// What each mode lets through without asking the user.
export const GRANTS = Object.freeze({
  kimi: Object.freeze({ manual: [], yolo: ['edit.routine', 'exec.routine'], auto: ALL }),
  claude: Object.freeze({ manual: [], edits: EDIT, auto: [...EDIT, ...EXEC] }),
  hub: Object.freeze({ ask: [], auto_edits: EDIT, bypass: [...EDIT, ...EXEC] }),
});

// The vocabulary a provider's conversations speak. DeepSeek runs inside Kimi.
export function vocabularyOf(provider) {
  if (provider === 'claude') return 'claude';
  if (provider === 'kimi' || provider === 'deepseek') return 'kimi';
  return null;
}

const LABELS = Object.freeze({
  kimi: { manual: '每次詢問', yolo: '需要時詢問', auto: '全部自動' },
  claude: { manual: '每次詢問', edits: '自動接受編輯', auto: '全部自動' },
});
const PROVIDER_NAME = { kimi: 'Kimi', deepseek: 'DeepSeek', claude: 'Claude' };

export const isMode = (vocab, mode) => Boolean(vocab && GRANTS[vocab] && Object.hasOwn(GRANTS[vocab], mode));

const grantsOf = (vocab, mode) => (isMode(vocab, mode) ? GRANTS[vocab][mode] : []);
const within = (a, b) => a.every((x) => b.includes(x));

// The most permissive mode of `vocab` that grants nothing beyond `grants`.
// `manual`/`ask` grant nothing, so there is always one.
function strongestWithin(vocab, grants) {
  let best = null;
  for (const [mode, g] of Object.entries(GRANTS[vocab])) {
    if (within(g, grants) && (best === null || g.length > GRANTS[vocab][best].length)) best = mode;
  }
  return best;
}

// Map `mode` (in the vocabulary of `fromProvider`) to the vocabulary of
// `toProvider`. Never returns a mode that asks less than the source did.
//   → { permission, exact, tightened, invalid, from, to, note }
export function mapPermission(fromProvider, mode, toProvider) {
  const fromVocab = vocabularyOf(fromProvider);
  const toVocab = vocabularyOf(toProvider);
  if (!toVocab) throw new TypeError(`unknown provider: ${String(toProvider)}`);
  const invalid = !isMode(fromVocab, mode);
  const given = grantsOf(fromVocab, mode);
  const permission = !invalid && fromVocab === toVocab ? mode : strongestWithin(toVocab, given);
  const target = GRANTS[toVocab][permission];
  // "Same" is judged on what the target vocabulary can express at all: Claude
  // has no mode that answers its own questions and plans, so a source that
  // does is still matched by Claude's most open mode.
  const expressible = new Set(Object.values(GRANTS[toVocab]).flat());
  const wanted = given.filter((x) => expressible.has(x));
  const exact = !invalid && target.length === wanted.length && within(target, wanted);
  const tightened = !exact;
  const labelOf = (vocab, m) => LABELS[vocab]?.[m] || m;
  const from = invalid ? `${PROVIDER_NAME[fromProvider] || fromProvider || '未知'}「${String(mode ?? '（無）')}」` : `${PROVIDER_NAME[fromProvider]}「${labelOf(fromVocab, mode)}」`;
  const to = `${PROVIDER_NAME[toProvider]}「${labelOf(toVocab, permission)}」`;
  const note = exact
    ? ''
    : invalid
      ? `權限：${from} 不是可辨識的模式，改用 ${to}（最嚴格）`
      : `權限：${from}→${to}（${PROVIDER_NAME[toProvider]}沒有相同範圍的模式，取較嚴格的一檔，不會少問）`;
  return { permission, exact, tightened, invalid, from, to, note };
}

// The native mode a conversation is really running with, in its own
// vocabulary. `meta.permission` is what the runtime reported; an absent or
// unrecognised one falls back to the Hub-level mode, translated the same
// strict way.
export function nativePermission(session, provider) {
  const vocab = vocabularyOf(provider);
  if (!vocab) return 'manual';
  const reported = session?.meta?.permission;
  if (isMode(vocab, reported)) return reported;
  const hub = session?.permissionMode;
  if (isMode('hub', hub)) return strongestWithin(vocab, GRANTS.hub[hub]);
  return 'manual';
}

// Hub-level mode for a node, never above `ceiling` (the old node's own).
export function hubModeFor(provider, mode, ceiling = null) {
  const vocab = vocabularyOf(provider);
  const derived = strongestWithin('hub', grantsOf(vocab, mode));
  if (!isMode('hub', ceiling)) return derived;
  return within(GRANTS.hub[derived], GRANTS.hub[ceiling]) ? derived : ceiling;
}

// The permission a new node/child of `toProvider` gets from `session`
// (a conversation of `fromProvider`).
export function inheritPermission(session, fromProvider, toProvider) {
  return mapPermission(fromProvider, nativePermission(session, fromProvider), toProvider);
}
