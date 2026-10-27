// "This turn" and "next turn" as the page reads them from a conversation's
// summary (public/js/providers.js), in node. The server's summary has
// nextProvider/nextModel/nextEffort/nextSubagent (always) and
// turnProvider/turnModel/turnEffort/turnSubagent (null when idle, and null
// while a turn runs that has no snapshot yet). An older server has neither, only
// modelConfig, meta.pendingSwitch and meta.turn*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelConfigOf, turnOf } from '../public/js/providers.js';
import { rowProviderView } from '../public/js/sidebar-model.js';

const base = (patch = {}) => ({ id: 's', provider: 'kimi', status: 'running', meta: {}, modelConfig: { provider: 'kimi', model: 'k', effort: '' }, ...patch });
const server = (patch = {}) => base({ nextProvider: 'kimi', nextModel: 'k', nextEffort: '', nextSubagent: null, turnProvider: null, turnModel: null, turnEffort: null, turnSubagent: null, ...patch });

test('the next turn is what the server says it is; an older summary is read as before', () => {
  assert.deepEqual(modelConfigOf(server({ nextProvider: 'deepseek', nextModel: 'agent-hub-deepseek/x', nextEffort: 'max' })), { provider: 'deepseek', model: 'agent-hub-deepseek/x', effort: 'max' });
  // next* wins over a modelConfig that disagrees (it is the server's statement)
  assert.equal(modelConfigOf(server({ nextProvider: 'claude', modelConfig: { provider: 'kimi', model: 'k' } })).provider, 'claude');
  // older summary: modelConfig, then a queued switch
  assert.equal(modelConfigOf(base()).provider, 'kimi');
  assert.equal(modelConfigOf(base({ meta: { pendingSwitch: { provider: 'claude', model: 'm', effort: '' } } })).provider, 'claude');
});

test('idle: there is no "this turn", whatever an earlier turn left behind', () => {
  assert.equal(turnOf(server({ status: 'idle' })), null);
  assert.equal(turnOf(base({ status: 'idle', meta: { turnProvider: 'kimi', turnModel: 'old' } })), null, 'a stale meta.turn* is not shown when idle');
});

test('running with a snapshot: this turn\'s values, next turn\'s kept apart', () => {
  const s = server({ nextProvider: 'deepseek', nextModel: 'd', nextEffort: 'max', turnProvider: 'kimi', turnModel: 'k', turnEffort: 'high', turnSubagent: { provider: 'claude', model: 'c', effort: '' } });
  assert.deepEqual(turnOf(s), { provider: 'kimi', model: 'k', effort: 'high', subagent: { provider: 'claude', model: 'c', effort: '' } });
  assert.equal(modelConfigOf(s).provider, 'deepseek');
  const v = rowProviderView({ hub: s, status: 'running', provider: 'kimi' });
  assert.equal(v.text, '本回合 Kimi／下一回合 DeepSeek');
  assert.equal(v.pending, true);
});

test('running but the turn has no snapshot yet (the server says null): the next turn\'s values stand in, nothing is shown as different', () => {
  const s = server({ nextProvider: 'deepseek', nextModel: 'd', nextEffort: 'max' });
  assert.deepEqual(turnOf(s), { provider: 'deepseek', model: 'd', effort: 'max', subagent: undefined });
  const v = rowProviderView({ hub: s, status: 'running', provider: 'kimi' });
  assert.equal(v.text, 'DeepSeek');
  assert.equal(v.pending, false);
});

test('this turn\'s subagent: the summary\'s null is "native rules" or "no snapshot"; the conversation\'s own meta says which', () => {
  const native = server({ meta: { turnSubagent: null } });
  assert.equal(turnOf(native).subagent, null, 'meta has the key: the turn started with native rules');
  const none = server({ meta: {} });
  assert.equal(turnOf(none).subagent, undefined, 'no key: nothing known, nothing claimed');
  const given = server({ turnSubagent: { provider: 'claude', model: 'c', effort: 'low' } });
  assert.equal(turnOf(given).subagent.provider, 'claude');
});

test('an older server (no turn*/next* in the summary) still shows the turn it recorded in meta while running', () => {
  const s = base({ provider: 'kimi', modelConfig: { provider: 'deepseek', model: 'd', effort: '' }, meta: { turnProvider: 'kimi', turnModel: 'k' } });
  assert.equal(turnOf(s).provider, 'kimi');
  assert.equal(turnOf(s).model, 'k');
  assert.equal(rowProviderView({ hub: s, status: 'running', provider: 'kimi' }).text, '本回合 Kimi／下一回合 DeepSeek');
  // and without any record, the runtime is the turn's provider
  assert.equal(turnOf(base({ meta: {} })).provider, 'kimi');
});
