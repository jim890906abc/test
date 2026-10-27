// The Hub records a conversation on DeepSeek while the native Kimi reports a
// Kimi model (a drift seen in real use): what the summary says about it, and
// what choosing the same model again does. The Hub's runner and store are real;
// the Kimi adapter is a recorder at its boundary (test/fixtures/hub-harness.mjs),
// whose configure() answers like Kimi: the native model becomes what was sent.
// What the REAL adapter sends to the machine is in model-drift-matrix.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupHub } from './fixtures/hub-harness.mjs';

let hub;
before(async () => {
  hub = await setupHub('model-drift');
});
after(() => hub?.close());

const DS = 'agent-hub-deepseek/deepseek-v4.1-flash';
const K3 = 'kimi-code/k3.1-pro';
const summary = (s) => hub.runner.summarize(s);
const configures = (s) => hub.kimi.calls.configure.filter((c) => c.id === s.id);

// The conversation as it stood on 10-27: the Hub's record says DeepSeek, the
// native says it runs Kimi K3.1 Pro at max.
const drifted = (over = {}) => hub.deepseekNode({ meta: { model: K3, effort: 'max' }, ...over });

test('the summary states what the native runs and names the disagreement with the Hub\'s record', () => {
  const s = drifted();
  const sum = summary(s);
  assert.equal(sum.provider, 'deepseek', 'the Hub\'s label is unchanged: it is the record');
  assert.equal(sum.modelConfig.model, DS);
  assert.equal(sum.nativeModel, K3);
  assert.equal(sum.nativeProvider, 'kimi', 'the provider comes from the native alias, not from the conversation\'s label');
  assert.equal(sum.modelDrift.kind, 'provider');
  assert.deepEqual(sum.modelDrift.expected, { provider: 'deepseek', model: DS, effort: 'max' });
  assert.deepEqual(sum.modelDrift.actual, { provider: 'kimi', model: K3, effort: 'max' });
});

test('no disagreement is no drift, in every spelling of the same DeepSeek model; an unreported native is unknown, not drift', () => {
  for (const reported of [DS, 'deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', DS.toUpperCase()]) {
    const sum = summary(hub.deepseekNode({ meta: { model: reported, effort: 'max' } }));
    assert.equal(sum.modelDrift, null, reported);
    assert.equal(sum.nativeModel, reported);
  }
  // Kimi's own models, with and without the provider prefix the list puts on them
  for (const reported of [K3, `managed:${K3}`, 'k3.1-pro']) {
    assert.equal(summary(hub.kimiNode({ modelConfig: { provider: 'kimi', model: K3, effort: 'max' }, meta: { model: reported, effort: 'max' } })).modelDrift, null, reported);
  }
  assert.equal(summary(hub.kimiNode({ modelConfig: { provider: 'kimi', model: K3, effort: 'max' }, meta: { model: 'kimi-code/k3-256k', effort: 'max' } })).modelDrift.kind, 'model');
  const unknown = summary(hub.deepseekNode({ meta: {} }));
  assert.equal(unknown.nativeModel, null);
  assert.equal(unknown.modelDrift, null, 'nothing reported is not a disagreement');
});

test('another model of the same family, a Kimi conversation on a DeepSeek alias, and an effort the user set are drifts too', () => {
  const pro = summary(hub.deepseekNode({ meta: { model: `${hub.deepseek.MODEL_PREFIX}deepseek-v4-pro`, effort: 'max' } }));
  assert.equal(pro.modelDrift.kind, 'model');
  const reverse = summary(hub.kimiNode({ meta: { model: DS, effort: 'on' } }));
  assert.equal(reverse.modelDrift.kind, 'provider');
  assert.equal(reverse.modelDrift.actual.provider, 'deepseek');
  const effort = summary(hub.deepseekNode({ meta: { model: DS, effort: 'low' } }));
  assert.equal(effort.modelDrift.kind, 'effort');
  // not set by the user: the Hub follows the native, there is nothing to put back
  const unset = summary(hub.deepseekNode({ meta: { model: DS, effort: 'low' }, state: { defaultsApplied: true } }));
  assert.equal(unset.modelDrift, null);
});

test('Claude conversations, sub-agent children and old nodes of a chain carry no drift', () => {
  assert.equal(summary(hub.claudeNode({ meta: { model: 'claude-sonnet-5-5' } })).modelDrift, null);
  assert.equal(summary(drifted({ parentId: 'someone' })).modelDrift, null);
  const old = drifted();
  old.continuedTo = 'later';
  assert.equal(summary(old).modelDrift, null);
});

test('choosing the DeepSeek model the Hub already shows still reaches a native that runs something else', async () => {
  const s = drifted();
  assert.equal(configures(s).length, 0);
  const out = await hub.runner.switchProvider(s, hub.DEEPSEEK);
  // The shortcut used to compare only the Hub's own record, so this sent nothing.
  assert.equal(configures(s).length, 1, 'a /profile change was sent');
  assert.equal(configures(s)[0].model, DS);
  assert.equal(configures(s)[0].effort, 'max');
  assert.equal(out.nativeModel, DS, 'and the summary now carries what the native took');
  assert.equal(out.modelDrift, null);
});

test('choosing what the native already runs is no change; an unreported native, and the page\'s force flag, are sent anyway', async () => {
  const agreed = hub.deepseekNode({ meta: { model: DS, effort: 'max' } });
  await hub.runner.switchProvider(agreed, hub.DEEPSEEK);
  assert.equal(configures(agreed).length, 0, 'recorded and reported the same: nothing is touched');

  const unknown = hub.deepseekNode({ meta: {} });
  await hub.runner.switchProvider(unknown, hub.DEEPSEEK);
  assert.equal(configures(unknown).length, 1, 'unknown is not "already there"');

  await hub.runner.switchProvider(agreed, { ...hub.DEEPSEEK, force: true });
  assert.equal(configures(agreed).length, 1, 'force skips the shortcut');
});

test('a native that does not take the change is an error, and the drift stays on the summary', async () => {
  const s = drifted();
  hub.kimi.failConfigure = Object.assign(new Error('model not found'), { status: 502 });
  try {
    await assert.rejects(() => hub.runner.switchProvider(s, hub.DEEPSEEK), /model not found/);
  } finally {
    hub.kimi.failConfigure = null;
  }
  assert.equal(s.meta.model, K3, 'nothing was claimed');
  assert.equal(summary(s).modelDrift.kind, 'provider');
});

test('K→D from a Kimi conversation whose native sits on a DeepSeek alias is not short-circuited either', async () => {
  const s = hub.kimiNode({ meta: { model: DS, effort: 'on' } });
  assert.equal(summary(s).modelDrift.kind, 'provider');
  await hub.runner.switchProvider(s, hub.KIMI);
  assert.equal(configures(s).length, 1, 'putting the Kimi model back is sent');
  assert.equal(configures(s)[0].model, 'kimi/k2');
});
