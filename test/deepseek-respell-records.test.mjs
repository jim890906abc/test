// When the gateway the DeepSeek model names follow changes (the first key of a
// new gateway, or the choice in the settings), the Hub's own records of the
// conversations - the model each chose, the sub-agent setting, a switch that waits
// for the turn to end - are rewritten in the new gateway's spelling of the same
// model. Only the Hub's record: what the native reported (meta.model) is its own
// word, a turn in progress is left alone, and a model the new gateway does not
// have stays as it was (the person is told when they choose). The runner and the
// store are real (test/fixtures/hub-harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupHub } from './fixtures/hub-harness.mjs';

let hub;
before(async () => {
  hub = await setupHub('ds-respell');
});
after(() => hub?.close());

const PFX = 'agent-hub-deepseek/';
const GO = (id) => `${PFX}${id}`;
const CC = (id) => `${PFX}deepseek/${id}`;
const gw = (id) => hub.deepseek.setSettings({ gateway: id });

// A conversation as one made while Command Code's spelling was in use.
const ccNode = (over = {}) => hub.deepseekNode({
  modelConfig: { provider: 'deepseek', model: CC('deepseek-v4.1-flash'), effort: 'max' },
  state: { defaultsApplied: true, userSet: { model: true, effort: true }, deepseek: { gateway: 'commandcode', model: CC('deepseek-v4.1-flash') } },
  meta: { model: CC('deepseek-v4.1-flash'), effort: 'max', subagent: { provider: 'deepseek', model: CC('deepseek-v4-pro'), effort: 'high' } },
  ...over,
});

test('changing the gateway rewrites each conversation\'s own record in the new spelling, and nothing else', () => {
  gw('commandcode');
  const s = ccNode();
  const claude = hub.claudeNode({ meta: { subagent: { provider: 'deepseek', model: CC('deepseek-v4.1-flash'), effort: 'max' } } });
  const kimi = hub.kimiNode();
  const events = [{ id: 'e1', type: 'info', text: 'old', model: CC('deepseek-v4.1-flash') }];
  s.events = events;
  s.state.pendingProvider = { provider: 'deepseek', model: CC('deepseek-v4-pro'), effort: 'high', machineId: 'm1' };
  s.meta.pendingSwitch = { ...s.state.pendingProvider };
  const stamp = [s.updatedAt, claude.updatedAt];

  gw('opencode-go');

  assert.equal(s.modelConfig.model, GO('deepseek-v4.1-flash'));
  assert.equal(s.modelConfig.effort, 'max');
  assert.deepEqual(s.state.deepseek, { gateway: 'opencode-go', model: GO('deepseek-v4.1-flash') });
  assert.deepEqual(s.meta.subagent, { provider: 'deepseek', model: GO('deepseek-v4-pro'), effort: 'high' });
  assert.equal(s.state.pendingProvider.model, GO('deepseek-v4-pro'));
  assert.equal(s.meta.pendingSwitch.model, GO('deepseek-v4-pro'));
  assert.equal(s.meta.model, CC('deepseek-v4.1-flash'), 'what the native reported is its own word, not the Hub\'s record');
  assert.equal(s.events[0].model, CC('deepseek-v4.1-flash'), 'history is history');
  assert.equal(claude.meta.subagent.model, GO('deepseek-v4.1-flash'), 'a Claude conversation\'s DeepSeek sub-agent follows too');
  assert.equal(claude.modelConfig.model, 'claude-opus-5-5');
  assert.equal(kimi.modelConfig.model, 'kimi/k2');
  assert.deepEqual([s.updatedAt, claude.updatedAt], stamp, 'a rewrite of the record is not activity: the sidebar order does not move');
});

test('and back: Command Code\'s spelling again when the names follow Command Code', () => {
  gw('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: GO('deepseek-v4-pro'), effort: 'high' }, meta: { subagent: { provider: 'deepseek', model: GO('deepseek-v4.1-flash'), effort: 'max' } } });
  gw('commandcode');
  assert.equal(s.modelConfig.model, CC('deepseek-v4-pro'));
  assert.equal(s.meta.subagent.model, CC('deepseek-v4.1-flash'));
});

test('a turn in progress is not rewritten; a model the new gateway does not have is left as it was', () => {
  gw('commandcode');
  const busy = ccNode();
  busy.status = 'running';
  const awaiting = ccNode();
  awaiting.status = 'awaiting_permission';
  const only = ccNode({ modelConfig: { provider: 'deepseek', model: CC('deepseek-v4-flash-fast'), effort: 'max' }, meta: { subagent: { provider: 'deepseek', model: CC('deepseek-v4-flash-fast'), effort: 'max' } } });
  gw('opencode-go');
  assert.equal(busy.modelConfig.model, CC('deepseek-v4.1-flash'), 'running');
  assert.equal(awaiting.modelConfig.model, CC('deepseek-v4.1-flash'), 'waiting for an answer');
  assert.equal(only.modelConfig.model, CC('deepseek-v4-flash-fast'), 'no counterpart: not guessed');
  assert.equal(only.meta.subagent.model, CC('deepseek-v4-flash-fast'));
  // the same pass later (the turn ended) rewrites what was waiting
  busy.status = 'idle';
  assert.ok(hub.runner.respellDeepseekRecords() >= 1);
  assert.equal(busy.modelConfig.model, GO('deepseek-v4.1-flash'));
  assert.equal(awaiting.modelConfig.model, CC('deepseek-v4.1-flash'), 'still waiting');
  assert.equal(hub.runner.respellDeepseekRecords(), 0, 'nothing left to do: the pass is idempotent');
});

test('the first key of a gateway decides the names too, and the Hub starting up repairs a store that was left behind', () => {
  gw('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: GO('deepseek-v4-pro'), effort: 'high' } });
  for (const g of ['opencode-go', 'opencode', 'commandcode']) hub.deepseek.clearKey(g);
  hub.deepseek.setKey('commandcode', 'sk-test-first-key-commandcode');
  assert.equal(hub.deepseek.gateway(), 'commandcode');
  assert.equal(s.modelConfig.model, CC('deepseek-v4-pro'));

  // a store written before this existed: the names changed gateway while nothing rewrote the records
  const behind = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: GO('deepseek-v4-pro'), effort: 'high' } });
  hub.runner.restoreLiveSessions();
  assert.equal(behind.modelConfig.model, CC('deepseek-v4-pro'));
  hub.deepseek.setKey('opencode-go', 'sk-test');
  gw('opencode-go');
});
