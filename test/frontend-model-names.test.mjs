// "DeepSeek · DeepSeek V4.1 Flash" said the provider twice: the model's own name
// already starts with it. One function (providers.js modelWithProvider) now
// joins a provider and a model name, and every place that shows the pair goes
// through it: the model chip's words, a subagent card, the 子代理 panel, the
// subagent choice in the dialog and the chip, and the drift notice. Node only,
// no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelWithProvider, PROVIDER_LABELS } from '../public/js/providers.js';
import { subagentModelView } from '../public/js/agent-state.js';
import { subagentChoiceText, subagentModeText } from '../public/js/home-state.js';
import { driftText } from '../public/js/model-drift.js';

// ------------------------------------------------------ the one function

test('a model name that already starts with its provider is said once, whatever the case or the form', () => {
  // DeepSeek: the catalog's name, the lower-case alias tail, shouting, a hyphen after the word
  assert.equal(modelWithProvider('DeepSeek', 'DeepSeek V4.1 Flash'), 'DeepSeek V4.1 Flash');
  assert.equal(modelWithProvider('DeepSeek', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(modelWithProvider('DeepSeek', 'DEEPSEEK V4 Pro'), 'DEEPSEEK V4 Pro');
  assert.equal(modelWithProvider('DeepSeek', 'deepseek/deepseek-v4.1-flash'), 'deepseek/deepseek-v4.1-flash');
  // Kimi
  assert.equal(modelWithProvider('Kimi', 'Kimi K3.1 Pro'), 'Kimi K3.1 Pro');
  assert.equal(modelWithProvider('Kimi', 'kimi-code/k3.1-pro'), 'kimi-code/k3.1-pro');
  // Claude, including the page's own fallback "Claude 預設模型"
  assert.equal(modelWithProvider('Claude', 'Claude Opus 5.5'), 'Claude Opus 5.5');
  assert.equal(modelWithProvider('Claude', 'claude-haiku-4'), 'claude-haiku-4');
  assert.equal(modelWithProvider('Claude', 'Claude 預設模型'), 'Claude 預設模型');
});

test('a model name that does not start with its provider gets the provider in front, with the separator asked for', () => {
  assert.equal(modelWithProvider('DeepSeek', 'V4.1 Flash'), 'DeepSeek · V4.1 Flash');
  assert.equal(modelWithProvider('Kimi', 'K3-256k'), 'Kimi · K3-256k');
  assert.equal(modelWithProvider('Claude', 'Opus 5.5'), 'Claude · Opus 5.5');
  assert.equal(modelWithProvider('Kimi', 'K3.1 Pro', ' '), 'Kimi K3.1 Pro', 'the drift notice joins with a space');
  // another provider's name inside is not the provider's own
  assert.equal(modelWithProvider('Kimi', 'DeepSeek V4.1 Flash'), 'Kimi · DeepSeek V4.1 Flash');
});

test('"starts with the provider" means the word, not the letters', () => {
  assert.equal(modelWithProvider('Kimi', 'Kimiko K1'), 'Kimi · Kimiko K1');
  assert.equal(modelWithProvider('Claude', 'Claudette 2'), 'Claude · Claudette 2');
  assert.equal(modelWithProvider('DeepSeek', 'DeepSeeker'), 'DeepSeek · DeepSeeker');
  // the name is not "inside" either: only a prefix counts
  assert.equal(modelWithProvider('DeepSeek', 'Flash by DeepSeek'), 'DeepSeek · Flash by DeepSeek');
});

test('nothing to join: the provider alone, the name alone, or nothing; blanks are trimmed', () => {
  assert.equal(modelWithProvider('DeepSeek', ''), 'DeepSeek');
  assert.equal(modelWithProvider('DeepSeek', undefined), 'DeepSeek');
  assert.equal(modelWithProvider('', 'V4.1 Flash'), 'V4.1 Flash');
  assert.equal(modelWithProvider('', ''), '');
  assert.equal(modelWithProvider('  DeepSeek ', '  DeepSeek V4.1 Flash '), 'DeepSeek V4.1 Flash');
  assert.equal(modelWithProvider('Kimi', '  K3-256k '), 'Kimi · K3-256k');
});

test('the labels it is meant for are the page\'s three', () => {
  assert.deepEqual(Object.values(PROVIDER_LABELS), ['Kimi', 'Claude', 'DeepSeek']);
});

// ------------------------------------------ every place that shows the pair

const NAMES = { 'agent-hub-deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'kimi-code/k3.1-pro': 'Kimi K3.1 Pro', 'kimi-code/k3-256k': 'K3-256k', 'claude-opus-5': 'Claude Opus 5.5' };
const nameOf = (_p, id) => NAMES[id] || String(id).split('/').pop();
const card = (sub) => ({ id: 'c', ts: Date.now(), type: 'tool_use', name: 'Agent', status: 'done', subagent: { id: 'a', status: 'done', ...sub } });
const done = { running: false };

test('subagent cards and the 子代理 panel (one view): the model chip, the request line and the tooltip say the provider once', () => {
  const ds = { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' };
  const v = subagentModelView(card({ requested: { ...ds, effort: 'high' }, actual: ds }), done, { modelName: nameOf });
  assert.equal(v.text, 'DeepSeek V4.1 Flash · 思考 max');
  assert.equal(v.mismatch, true);
  assert.match(v.title, /這個子代理實際使用：DeepSeek V4\.1 Flash · 思考 max（執行時回報）。與建立時的要求不同：DeepSeek V4\.1 Flash · 思考 high/);
  const unconfirmed = subagentModelView(card({ requested: ds, actual: null }), done, { modelName: nameOf });
  assert.equal(unconfirmed.requestedText, '要求：DeepSeek V4.1 Flash · 思考 max');
  // the other two providers, with a name from the catalog and with a plain id
  assert.equal(subagentModelView(card({ actual: { provider: 'kimi', model: 'kimi-code/k3.1-pro', effort: 'high' } }), done, { modelName: nameOf }).text, 'Kimi K3.1 Pro · 思考 high');
  assert.equal(subagentModelView(card({ actual: { provider: 'kimi', model: 'kimi-code/k3-256k', effort: '' } }), done, { modelName: nameOf }).text, 'Kimi · K3-256k', 'a name without the provider keeps it in front');
  assert.equal(subagentModelView(card({ actual: { provider: 'claude', model: 'claude-opus-5', effort: 'max' } }), done, { modelName: nameOf }).text, 'Claude Opus 5.5 · 思考 max');
  assert.equal(subagentModelView(card({ actual: { provider: 'claude', model: 'claude-haiku-4', effort: 'low' } }), done).text, 'claude-haiku-4 · 思考 low', 'no catalog: the id\'s own tail, still said once');
});

test('the subagent choice (dialog lead line, session menu, chip) says the provider once', () => {
  const ds = { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' };
  assert.equal(subagentChoiceText(ds, { nameOf }), 'DeepSeek V4.1 Flash · 思考 max');
  assert.equal(subagentModeText('custom', ds, { nameOf }), 'DeepSeek V4.1 Flash · 思考 max');
  assert.equal(subagentModeText('default', null, { nameOf }), 'DeepSeek V4.1 Flash · 思考 max（預設）');
  assert.equal(subagentChoiceText({ provider: 'kimi', model: 'kimi-code/k3.1-pro', effort: '' }, { nameOf }), 'Kimi K3.1 Pro');
  assert.equal(subagentChoiceText({ provider: 'kimi', model: 'kimi-code/k3-256k', effort: 'high' }, { nameOf }), 'Kimi · K3-256k · 思考 high');
  assert.equal(subagentChoiceText({ provider: 'claude', model: 'claude-opus-5', effort: '' }, { nameOf }), 'Claude Opus 5.5');
  assert.equal(subagentChoiceText(null), '跟隨主模型／原生規則');
});

test('the drift notice keeps its wording (it already said it once) through the same function', () => {
  const DS = 'agent-hub-deepseek/deepseek-v4.1-flash';
  const K3 = 'kimi-code/k3.1-pro';
  const drift = { kind: 'provider', expected: { provider: 'deepseek', model: DS, effort: 'max' }, actual: { provider: 'kimi', model: K3, effort: 'max' }, since: 1 };
  const t = driftText(drift, (p, id) => ({ [DS]: 'DeepSeek V4.1 Flash', [K3]: 'K3.1 Pro' })[id] || '');
  assert.equal(t.actual, '實際：Kimi K3.1 Pro', 'a name without the provider gets it');
  assert.equal(t.differs, '與你選的 DeepSeek V4.1 Flash 不同', 'a name with it does not get it twice');
  // and with the lower-case forms the old test (^Label\s) did not catch
  const raw = driftText({ ...drift, expected: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: '' } }, (_p, id) => id);
  assert.equal(raw.differs, '與你選的 deepseek-v4.1-flash 不同');
});
