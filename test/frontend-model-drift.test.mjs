// The page's reading of summary.modelDrift and of the context hint
// (public/js/model-drift.js), in node: the words, the sidebar tag, and what it
// does with a summary that lacks the fields or has them half filled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftOf, driftText, driftTag, modelName, contextHint, dismissContextHint } from '../public/js/model-drift.js';
import { rowProviderView } from '../public/js/sidebar-model.js';

const DS = 'agent-hub-deepseek/deepseek-v4.1-flash';
const K3 = 'kimi-code/k3.1-pro';
const drift = (over = {}) => ({ kind: 'provider', expected: { provider: 'deepseek', model: DS, effort: 'max' }, actual: { provider: 'kimi', model: K3, effort: 'max' }, since: 1_700_000_000_000, ...over });
const names = { [DS]: 'DeepSeek V4.1 Flash', [K3]: 'Kimi K3.1 Pro' };
const nameOf = (_p, id) => names[id] || '';

test('the drift is read from the summary; a summary without it, or with half of it, is no drift and breaks nothing', () => {
  assert.equal(driftOf({}), null);
  assert.equal(driftOf(null), null);
  assert.equal(driftOf({ modelDrift: null }), null);
  assert.equal(driftOf({ modelDrift: 'x' }), null);
  assert.equal(driftOf({ modelDrift: { expected: {} } }), null, 'no actual side: nothing to show');
  const half = driftOf({ modelDrift: { actual: { provider: 'kimi', model: K3 } } });
  assert.equal(half.actual.model, K3);
  assert.deepEqual(half.expected, { provider: '', model: '', effort: '' });
  assert.equal(driftOf({ modelDrift: drift() }).kind, 'provider');
});

test('the words: what really runs, that it differs from the choice, and the button back', () => {
  const t = driftText(driftOf({ modelDrift: drift() }), nameOf);
  assert.equal(t.actual, '實際：Kimi K3.1 Pro');
  assert.equal(t.differs, '與你選的 DeepSeek V4.1 Flash 不同');
  assert.equal(t.restore, '改回 DeepSeek V4.1 Flash');
  assert.match(t.title, /費用會計到「實際」那一家/);
});

test('without a name in the list the alias is made readable; without a model to go back to there is no button', () => {
  const t = driftText(driftOf({ modelDrift: drift() }));
  assert.equal(t.actual, '實際：Kimi K3.1 Pro');
  assert.equal(t.restore, '改回 DeepSeek V4.1 Flash');
  const none = driftText(driftOf({ modelDrift: drift({ expected: { provider: 'deepseek', model: '', effort: '' } }) }));
  assert.equal(none.restore, '');
  assert.equal(none.differs, '與你選的 DeepSeek 不同');
  assert.equal(modelName('managed:kimi-code/kimi-for-coding'), 'Kimi For Coding');
});

test('an effort-only drift says so', () => {
  const t = driftText(driftOf({ modelDrift: drift({ kind: 'effort', expected: { provider: 'deepseek', model: DS, effort: 'max' }, actual: { provider: 'deepseek', model: DS, effort: 'low' } }) }), nameOf);
  assert.equal(t.actual, '實際：思考 low');
  assert.equal(t.differs, '與你選的思考 max 不同');
});

test('the sidebar tag of an idle drifted conversation names the provider that runs, not the label', () => {
  const s = { id: 's', provider: 'deepseek', status: 'idle', meta: { model: K3 }, modelConfig: { provider: 'deepseek', model: DS, effort: 'max' }, nextProvider: 'deepseek', nextModel: DS, nextEffort: 'max', modelDrift: drift() };
  const v = rowProviderView({ hub: s, status: 'idle', provider: 'deepseek' });
  assert.equal(v.text, '實際 Kimi');
  assert.equal(v.provider, 'kimi');
  assert.equal(v.pending, true);
  assert.match(v.title, /標示是 DeepSeek/);
  // not drifted: as before
  const same = rowProviderView({ hub: { ...s, modelDrift: null }, status: 'idle', provider: 'deepseek' });
  assert.equal(same.text, 'DeepSeek');
  // a same-provider drift keeps the provider's name (the model differs, the bill does not move)
  const sameProvider = rowProviderView({ hub: { ...s, modelDrift: drift({ kind: 'model', actual: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4-pro', effort: 'max' } }) }, status: 'idle', provider: 'deepseek' });
  assert.equal(sameProvider.text, 'DeepSeek');
  assert.equal(sameProvider.pending, true);
  assert.equal(driftTag(driftOf({ modelDrift: drift() })).text, '實際 Kimi');
});

// A storage that remembers, like localStorage.
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('context hint: nothing below 80%, one line from 80%, put away per conversation and band', () => {
  const ctx = (pct) => ({ used: pct * 10, size: 1000 });
  const storage = memory();
  assert.equal(contextHint(ctx(79), 'c1', storage), null);
  assert.equal(contextHint(ctx(0), 'c1', storage), null);
  const at80 = contextHint(ctx(81), 'c1', storage);
  assert.equal(at80.text, '上下文已用 81%，接近自動壓縮；回應會變慢，可用 /compact 或開新對話');
  assert.equal(at80.band, 0.8);
  // another conversation is its own
  assert.ok(contextHint(ctx(81), 'c2', storage));
  // put away: the same band stays quiet, also at 84%
  dismissContextHint('c1', at80.band, storage);
  assert.equal(contextHint(ctx(81), 'c1', storage), null);
  assert.equal(contextHint(ctx(84), 'c1', storage), null);
  // the next band is new
  const at90 = contextHint(ctx(91), 'c1', storage);
  assert.equal(at90.band, 0.9);
  dismissContextHint('c1', at90.band, storage);
  assert.equal(contextHint(ctx(96), 'c1', storage).band, 0.95);
  // remembered in the storage, so a reload keeps it quiet
  assert.equal(JSON.parse(storage.getItem('hub.ctxHint')).c1, 0.9);
});

test('context hint: missing numbers, no storage and a storage that throws all still work', () => {
  assert.equal(contextHint(undefined, 'x', null), null);
  assert.equal(contextHint({ used: 5 }, 'x', null), null);
  assert.equal(contextHint({ used: 900, size: 1000 }, '', null), null, 'no conversation id: nowhere to remember it');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const hint = contextHint({ used: 850, size: 1000 }, 'no-storage', throwing);
  assert.equal(hint.band, 0.8);
  assert.doesNotThrow(() => dismissContextHint('no-storage', hint.band, throwing));
  assert.equal(contextHint({ used: 850, size: 1000 }, 'no-storage', throwing), null, 'put away for this visit even though nothing could be stored');
  assert.ok(contextHint({ used: 850, size: 1000 }, 'no-storage-2', null), 'null storage: the hint works');
});
