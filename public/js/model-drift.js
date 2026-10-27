// Two small notices next to the message box, kept apart from the composer so
// they can be read (and tested) on their own:
//
//  1. The model drift. The conversation is recorded on one model (the user's
//     choice) while the native Kimi reports another - the server states it as
//     summary.modelDrift. The label then names what really runs, says it is not
//     what was chosen, and offers one button that puts the choice back.
//  2. The context hint. Kimi compacts a conversation on its own around 85%;
//     from 80% the page says once that replies will slow down.
//
// The pure parts have no DOM and are imported by node tests; the DOM builders
// take `h` from the caller.

import { modelWithProvider } from './providers.js';

export const PROVIDER_NAMES = { kimi: 'Kimi', claude: 'Claude', deepseek: 'DeepSeek' };
const DS_PREFIX = 'agent-hub-deepseek/';

const text = (v) => (typeof v === 'string' ? v : '');
const known = (p) => Object.hasOwn(PROVIDER_NAMES, p);

// "agent-hub-deepseek/deepseek-v4.1-flash" -> "DeepSeek V4.1 Flash",
// "kimi-code/k3.1-pro" -> "K3.1 Pro" when the server's list has no name for it.
export function modelName(id) {
  const raw = text(id).replace(/^managed:/, '').replace(DS_PREFIX, '').replace(/^.*\//, '');
  if (!raw) return '';
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^deepseek$/i.test(w) ? 'DeepSeek' : /^v\d/i.test(w) ? `V${w.slice(1)}` : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// What the page needs from summary.modelDrift, read defensively: an older
// server has none, and a half-filled one must not break the composer.
export function driftOf(summary) {
  const d = summary?.modelDrift;
  if (!d || typeof d !== 'object') return null;
  const side = (x) => ({ provider: known(x?.provider) ? x.provider : '', model: text(x?.model), effort: text(x?.effort) });
  const expected = side(d.expected);
  const actual = side(d.actual);
  if (!actual.model && !actual.provider) return null;
  return { kind: ['provider', 'model', 'effort'].includes(d.kind) ? d.kind : 'model', expected, actual, since: Number.isFinite(d.since) ? d.since : null };
}

// The words for one drift. `nameOf(provider, modelId)` gives the model's name
// from the page's model list (or nothing, and the id is made readable).
export function driftText(drift, nameOf = () => '') {
  const name = (side) => {
    const model = nameOf(side.provider, side.model) || modelName(side.model);
    return modelWithProvider(PROVIDER_NAMES[side.provider] || '', model, ' ');
  };
  const actual = name(drift.actual);
  const expected = drift.expected.model || drift.expected.provider ? name(drift.expected) : '';
  const effortOnly = drift.kind === 'effort';
  const actualEffort = drift.actual.effort && drift.actual.effort !== 'off' ? drift.actual.effort : '';
  return {
    actual: effortOnly ? `實際：思考 ${actualEffort}` : `實際：${actual}`,
    differs: effortOnly ? `與你選的思考 ${drift.expected.effort} 不同` : expected ? `與你選的 ${expected} 不同` : '不是你選的模型',
    // Without a model to go back to there is nothing to press.
    restore: drift.expected.model ? `改回 ${expected}` : '',
    title: [
      `這個對話的原生 Kimi 目前回報用的是「${actual}」${actualEffort && !effortOnly ? `（思考 ${actualEffort}）` : ''}，`,
      expected ? `不是你選的「${expected}」。` : '不是你選的模型。',
      drift.kind === 'provider' ? '供應商不同，費用會計到「實際」那一家。' : '',
      '可能是別處（終端機、全域預設、其他用戶端）改了原生對話的模型。',
    ].join(''),
  };
}

// The sidebar tag for a drifted conversation: what runs, not the label.
export function driftTag(drift) {
  const actual = PROVIDER_NAMES[drift.actual.provider] || '';
  const expected = PROVIDER_NAMES[drift.expected.provider] || '';
  if (drift.kind === 'provider' && actual) return { provider: drift.actual.provider, text: `實際 ${actual}`, title: `標示是 ${expected}，但原生對話目前用的是 ${actual} 的模型（${modelName(drift.actual.model)}）` };
  return { provider: drift.expected.provider, text: expected, title: `${expected}；原生對話的模型與你選的不同` };
}

// The chips beside the model chip. `onRestore(drift)` is called by the button.
export function driftChips({ h, drift, nameOf, onRestore, running = false }) {
  const t = driftText(drift, nameOf);
  const nodes = [
    h('span', { class: 'chip static drift-warn', title: t.title, dataset: { control: 'model-drift' } }, h('span', null, t.actual), h('span', { class: 'drift-differs' }, t.differs)),
  ];
  if (t.restore && onRestore) {
    nodes.push(
      h(
        'button',
        { class: 'chip drift-restore', type: 'button', title: running ? '從下一回合起改回；現在這一輪不變' : '把原生對話的模型改回你選的', dataset: { control: 'model-restore' }, onclick: () => onRestore(drift) },
        h('span', null, t.restore),
      ),
    );
  }
  return nodes;
}

// ------------------------------------------------------------ context hint

export const HINT_FROM = 0.8;
// A hint is remembered per conversation and per band, so it comes back only
// when the context grows into the next one.
const BANDS = [0.95, 0.9, 0.8];
const bandOf = (pct) => BANDS.find((b) => pct >= b) || 0;
const STORE_KEY = 'hub.ctxHint';
const seenInMemory = new Map();

function readSeen(storage) {
  try {
    const o = JSON.parse(storage?.getItem(STORE_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

// null, or { text, band, percent }: shown from 80% used, unless the person
// already put this band away for this conversation. Missing numbers, a missing
// storage or a storage that throws only mean the hint is not remembered across
// reloads; it still works.
export function contextHint(context, id, storage = null) {
  const used = Number(context?.used);
  const size = Number(context?.size);
  if (!(used >= 0) || !(size > 0) || !id) return null;
  const pct = used / size;
  const band = bandOf(pct);
  if (!band) return null;
  const seen = Math.max(seenInMemory.get(id) || 0, Number(readSeen(storage)[id]) || 0);
  if (seen >= band) return null;
  const percent = Math.round(Math.min(1, pct) * 100);
  return { band, percent, text: `上下文已用 ${percent}%，接近自動壓縮；回應會變慢，可用 /compact 或開新對話` };
}

export function dismissContextHint(id, band, storage = null) {
  seenInMemory.set(id, Math.max(seenInMemory.get(id) || 0, band));
  try {
    const all = readSeen(storage);
    all[id] = Math.max(Number(all[id]) || 0, band);
    storage?.setItem(STORE_KEY, JSON.stringify(all));
  } catch {}
}

export function contextHintNode({ h, hint, onDismiss }) {
  return h(
    'span',
    { class: 'ctx-hint', role: 'status', title: hint.text },
    h('span', { class: 'ctx-hint__text' }, hint.text),
    h('button', { class: 'ctx-hint__x', type: 'button', 'aria-label': '知道了，不再提示', title: '知道了，這個用量不再提示', onclick: () => onDismiss(hint) }, '×'),
  );
}
