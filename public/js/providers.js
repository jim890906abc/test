// What every part of the page needs to know about a conversation's provider,
// kept free of the DOM so it can be tested directly in node.
//
// A conversation is logically one thing even when it moves between runtimes:
// the server keeps a leaf node per runtime and links the nodes with
// conversationId / continuedFrom / continuedTo. The palette is never derived
// from any of this.

export const PROVIDERS = ['kimi', 'claude', 'deepseek'];
export const PROVIDER_LABELS = { kimi: 'Kimi', claude: 'Claude', deepseek: 'DeepSeek' };
export const DEEPSEEK_PREFIX = 'agent-hub-deepseek/';

// "Provider · model" in words, for every place that names the pair (the model
// chip, a subagent card and the 子代理 panel, the subagent choice, the drift
// notice). A model's own name usually starts with its provider already -
// "DeepSeek V4.1 Flash", "Claude Opus 5.5", or an id's tail such as
// "deepseek-v4.1-flash" - and then the provider is not said a second time:
// "DeepSeek · DeepSeek V4.1 Flash" repeated itself. The word has to be the whole
// first word ("Kimiko" does not start with "Kimi", a hyphen, space or Chinese
// character after it does); the case does not matter.
// `label` is the provider's name as shown (PROVIDER_LABELS), `sep` what goes
// between the two when both are said.
export function modelWithProvider(label, name, sep = ' · ') {
  const l = String(label ?? '').trim();
  const n = String(name ?? '').trim();
  if (!n) return l;
  if (!l) return n;
  if (n.toLowerCase().startsWith(l.toLowerCase()) && !/[a-z0-9]/i.test(n.charAt(l.length))) return n;
  return `${l}${sep}${n}`;
}

export const isDsModel = (id) => typeof id === 'string' && id.startsWith(DEEPSEEK_PREFIX);
export const isProvider = (p) => PROVIDERS.includes(p);
export const busy = (status) => status === 'running' || status === 'awaiting_permission';

// The runtime a conversation runs on right now.
export function providerOf(s) {
  // session.provider is the running runtime. modelConfig.provider is the
  // next-turn target, so it is only a last-resort fallback for old summaries.
  if (isProvider(s?.provider)) return s.provider;
  if (s?.agentId === 'claude') return 'claude';
  if (s?.mode === 'deepseek' || isDsModel(s?.meta?.model) || isDsModel(s?.modelConfig?.model)) return 'deepseek';
  if (isProvider(s?.modelConfig?.provider)) return s.modelConfig.provider;
  return 'kimi';
}

export const conversationIdOf = (s) => s?.conversationId || s?.id || '';
export const isLeaf = (s) => Boolean(s) && !s.continuedTo && s.isLeaf !== false;

// The provider/model/effort the NEXT turn will use. The server states it in the
// summary (nextProvider/nextModel/nextEffort); an older summary has only
// `modelConfig` (the next-turn target) and meta.pendingSwitch (a queued
// runtime switch), which are read as before, without ever calling the target
// "current".
export function modelConfigOf(s) {
  if (isProvider(s?.nextProvider)) {
    return { provider: s.nextProvider, model: s.nextModel ?? '', effort: s.nextEffort ?? '' };
  }
  const mc = s?.modelConfig || {};
  const runtime = providerOf(s);
  const pending = s?.meta?.pendingSwitch || s?.pendingSwitch || null;
  const mcProvider = isProvider(mc.provider) ? mc.provider : '';
  const pendingProvider = isProvider(pending?.provider) ? pending.provider : '';
  let provider = mcProvider || pendingProvider || runtime;
  if (pendingProvider && pendingProvider !== runtime && (!mcProvider || mcProvider === runtime)) provider = pendingProvider;
  const pendingApplies = Boolean(pendingProvider && pendingProvider === provider);
  return {
    provider,
    model: (pendingApplies ? pending?.model : mc.model) ?? pending?.model ?? s?.meta?.model ?? '',
    effort: (pendingApplies ? pending?.effort : mc.effort) ?? pending?.effort ?? s?.meta?.effort ?? '',
  };
}

// What THIS turn actually runs on, while one runs; null when idle (nothing is
// "the current turn" then, so a value left from an earlier turn must not be
// shown). The server's summary gives it as turnProvider/turnModel/turnEffort/
// turnSubagent, null until the turn's snapshot exists: then nothing is known to
// differ from the next-turn values, which stand in. An older server has only
// meta.turn*; those are read the way they always were.
export function turnOf(s, working = busy(s?.status)) {
  if (!working) return null;
  const next = modelConfigOf(s);
  const meta = s?.meta || {};
  const fromServer = Object.hasOwn(s || {}, 'turnProvider');
  const has = (v) => v !== null && v !== undefined && v !== '';
  const pick = (top, legacy, fallback) => (fromServer ? (has(top) ? top : fallback) : has(legacy) ? legacy : fallback);
  // The summary's null is both "native rules" and "no snapshot yet" for the
  // subagent; the conversation's own meta tells them apart (absent = no snapshot).
  let subagent;
  if (s?.turnSubagent && typeof s.turnSubagent === 'object') subagent = s.turnSubagent;
  else if (Object.hasOwn(meta, 'turnSubagent')) subagent = meta.turnSubagent;
  else subagent = meta.turn?.subagent;
  const wanted = fromServer ? s.turnProvider : meta.turnProvider || meta.turn?.provider;
  return {
    provider: isProvider(wanted) ? wanted : fromServer ? next.provider : providerOf(s),
    model: pick(s?.turnModel, meta.turnModel || meta.turn?.model, next.model),
    effort: pick(s?.turnEffort, meta.turnEffort ?? meta.turn?.effort, next.effort),
    subagent,
  };
}
