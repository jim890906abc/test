// The gateways spell one DeepSeek model differently (OpenCode: `deepseek-v4.1-flash`;
// Command Code: `deepseek/deepseek-v4.1-flash`), and a conversation keeps the
// spelling of the gateway in use when it chose. When the gateway the model names
// follow changes, every check that compared a model to "the gateway in use" turned
// the conversation away with 「DeepSeek 沒有 … 這個模型」 (2026-10-31, after the key
// moved to Command Code). These tests run the Hub's runner for real (see
// test/fixtures/hub-harness.mjs for what is replaced) and assert on what the checks
// ANSWER: accepted in either spelling, written in the spelling of the gateway in use,
// and a model the gateway in use really does not have refused with the reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupHub } from './fixtures/hub-harness.mjs';

let hub;
before(async () => {
  hub = await setupHub('ds-model-names');
});
after(() => hub?.close());

const PFX = 'agent-hub-deepseek/';
const GO = (id) => `${PFX}${id}`; // OpenCode Go's spelling, as the alias
const CC = (id) => `${PFX}deepseek/${id}`; // Command Code's
const useGateway = (gw) => hub.deepseek.setSettings({ gateway: gw });
const choose = (model, extra = {}) => hub.runner.validateChoice({ provider: 'deepseek', model, ...extra });

test('on OpenCode Go a Command Code spelling (alias or bare id) is the same model, written the OpenCode way', async () => {
  useGateway('opencode-go');
  assert.equal((await choose(CC('deepseek-v4.1-flash'))).model, GO('deepseek-v4.1-flash'));
  assert.equal((await choose('deepseek/deepseek-v4-pro')).model, GO('deepseek-v4-pro'));
  // the spelling of the gateway in use is left as it is, alias or bare
  assert.equal((await choose(GO('deepseek-v4-pro'))).model, GO('deepseek-v4-pro'));
  assert.equal((await choose('deepseek-v4.1-flash')).model, GO('deepseek-v4.1-flash'));
});

test('on Command Code an OpenCode spelling is the same model, written the Command Code way', async () => {
  useGateway('commandcode');
  assert.equal((await choose(GO('deepseek-v4.1-flash'))).model, CC('deepseek-v4.1-flash'));
  assert.equal((await choose('deepseek-v4-pro')).model, CC('deepseek-v4-pro'));
  assert.equal((await choose(CC('deepseek-v4-pro'))).model, CC('deepseek-v4-pro'));
  assert.equal((await choose('deepseek/deepseek-v4.1-flash-fast')).model, CC('deepseek-v4.1-flash-fast'));
});

test('thinking strength is still checked against the model it turned out to be', async () => {
  useGateway('opencode-go');
  const ok = await choose(CC('deepseek-v4.1-flash'), { effort: 'high' });
  assert.deepEqual([ok.model, ok.effort], [GO('deepseek-v4.1-flash'), 'high']);
  await assert.rejects(() => choose(CC('deepseek-v4.1-flash'), { effort: 'off' }), (err) => err.status === 400 && /不支援思考強度/.test(err.message));
});

test('a model only the other gateway has is refused, and the reason names who has it and what the names follow now', async () => {
  useGateway('opencode-go');
  await assert.rejects(() => choose(CC('deepseek-v4-flash-fast')), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /deepseek-v4-flash-fast/);
    assert.match(err.message, /只有 Command Code 有/);
    assert.match(err.message, /目前依 OpenCode Go/);
    assert.match(err.message, /模型選單重選/);
    return true;
  });
  useGateway('commandcode');
  await assert.rejects(() => choose('deepseek-v4.1-flash-free'), (err) => err.status === 400 && /deepseek-v4\.1-flash-free 只有 OpenCode（按量計費） 有/.test(err.message) && /目前依 Command Code/.test(err.message));
});

test('a model no gateway has keeps the plain refusal', async () => {
  useGateway('opencode-go');
  await assert.rejects(() => choose('deepseek-v9-nothing'), (err) => err.status === 400 && err.message === 'DeepSeek 沒有 deepseek-v9-nothing 這個模型');
  await assert.rejects(() => choose(CC('deepseek-v9-nothing')), (err) => err.status === 400 && /deepseek-v9-nothing 這個模型/.test(err.message) && !/只有/.test(err.message));
});

test('the sub-agent setting takes the other gateway\'s spelling too', async () => {
  useGateway('opencode-go');
  const sub = await hub.runner.normalizeSubagent({ provider: 'deepseek', model: CC('deepseek-v4-pro'), effort: 'high' });
  assert.deepEqual(sub, { provider: 'deepseek', model: GO('deepseek-v4-pro'), effort: 'high' });
});

test('thinking strength only: a conversation recorded in the other gateway\'s spelling is accepted, and the record is written in the gateway\'s', async () => {
  useGateway('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: CC('deepseek-v4.1-flash'), effort: 'max' } });
  const before = hub.kimi.calls.configure.length;
  await hub.runner.configure(s, { effort: 'high' });
  const sent = hub.kimi.calls.configure.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].effort, 'high');
  assert.equal(sent[0].model, undefined, 'only the thinking strength was asked of the native');
  assert.equal(s.modelConfig.model, GO('deepseek-v4.1-flash'), 'the Hub\'s record now follows the gateway');
  assert.equal(s.modelConfig.effort, 'high');
});

test('thinking strength only, on a model this gateway does not have: refused with the reason, nothing sent', async () => {
  useGateway('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: CC('deepseek-v4-flash-fast'), effort: 'max' } });
  const before = hub.kimi.calls.configure.length;
  await assert.rejects(() => hub.runner.configure(s, { effort: 'high' }), (err) => err.status === 400 && /只有 Command Code 有/.test(err.message));
  assert.equal(hub.kimi.calls.configure.length, before);
  assert.equal(s.modelConfig.model, CC('deepseek-v4-flash-fast'), 'a record that cannot be translated is left as it was');
});

test('choosing the same model again (the page re-sends it) reaches the native in the gateway\'s spelling', async () => {
  useGateway('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: CC('deepseek-v4.1-flash'), effort: 'max' }, meta: { model: CC('deepseek-v4.1-flash'), effort: 'max' } });
  const before = hub.kimi.calls.configure.length;
  await hub.runner.switchProvider(s, { provider: 'deepseek', model: CC('deepseek-v4.1-flash'), effort: 'max' });
  const sent = hub.kimi.calls.configure.slice(before);
  assert.equal(sent.length, 1, 'the native is told: its spelling is not the gateway\'s');
  assert.equal(sent[0].model, GO('deepseek-v4.1-flash'));
  assert.equal(s.modelConfig.model, GO('deepseek-v4.1-flash'));
  assert.equal(s.meta.model, GO('deepseek-v4.1-flash'), 'and the native took it');
});

test('new-conversation default saved in the other gateway\'s spelling is the same model here, not a silent fall back to Flash', async () => {
  useGateway('opencode-go');
  hub.deepseek.setSettings({ defaults: { model: 'deepseek/deepseek-v4-pro' } });
  assert.equal(hub.deepseek.settings().defaults.model, 'deepseek-v4-pro');
  useGateway('commandcode');
  hub.deepseek.setSettings({ defaults: { model: 'deepseek-v4-pro' } });
  assert.equal(hub.deepseek.settings().defaults.model, 'deepseek/deepseek-v4-pro');
  // a default the gateway in use cannot map is still replaced by its own default model, as before
  hub.deepseek.setSettings({ defaults: { model: 'deepseek-v4.1-flash-free' } });
  assert.equal(hub.deepseek.settings().defaults.model, 'deepseek/deepseek-v4.1-flash');
});

// ---- what the native reports: one model to the person, but a name the provider may no longer have

test('a native on the other gateway\'s alias is the same model for the drift (no warning), yet it is not "already on" the target', () => {
  useGateway('opencode-go');
  const s = hub.deepseekNode({ modelConfig: { provider: 'deepseek', model: GO('deepseek-v4.1-flash'), effort: 'max' }, meta: { model: CC('deepseek-v4.1-flash'), effort: 'max' } });
  assert.equal(hub.runner.summarize(s).modelDrift, null, 'the person sees one model');
  const target = { provider: 'deepseek', model: GO('deepseek-v4.1-flash'), effort: 'max' };
  assert.equal(hub.modelDrift.nativeMatches(s, target), false, 'but the provider on the computer has no alias of that spelling');
  s.meta.model = GO('deepseek-v4.1-flash');
  assert.equal(hub.modelDrift.nativeMatches(s, target), true);
  assert.equal(hub.runner.summarize(s).modelDrift, null);
});

test('staleNativeAlias names the alias to put on a native whose alias the provider no longer has, and only then', () => {
  useGateway('opencode-go');
  const on = (reported, over = {}) => hub.deepseekNode({ meta: { model: reported, effort: 'max' }, ...over });
  assert.deepEqual(hub.modelDrift.staleNativeAlias(on(CC('deepseek-v4-pro'))), { from: CC('deepseek-v4-pro'), to: GO('deepseek-v4-pro') });
  assert.equal(hub.modelDrift.staleNativeAlias(on(GO('deepseek-v4-pro'))), null, 'already the gateway\'s alias');
  assert.equal(hub.modelDrift.staleNativeAlias(on(CC('deepseek-v4-flash-fast'))), null, 'the gateway has no such model: not guessed');
  assert.equal(hub.modelDrift.staleNativeAlias(on('deepseek/deepseek-v4-pro')), null, 'not an alias of the provider: the existing drift rules handle it');
  assert.equal(hub.modelDrift.staleNativeAlias(on('kimi-code/k3.1-pro')), null, 'a Kimi model is not touched');
  assert.equal(hub.modelDrift.staleNativeAlias(hub.deepseekNode({ meta: {} })), null, 'unknown is not stale');
  assert.equal(hub.modelDrift.staleNativeAlias(hub.kimiNode({ meta: { model: CC('deepseek-v4-pro') } })), null, 'a Kimi conversation on a DeepSeek alias is a provider drift, not a respelling');
});

test('a new conversation (what a cluster worker is made with) takes the other gateway\'s spelling and is recorded in the gateway\'s', async () => {
  useGateway('opencode-go');
  const s = await hub.runner.newSession({ provider: 'deepseek', machineId: 'm1', cwd: '/tmp/a', config: { model: CC('deepseek-v4-pro'), effort: 'high' } });
  assert.equal(s.modelConfig.model, GO('deepseek-v4-pro'));
  assert.deepEqual(s.state.deepseek, { gateway: 'opencode-go', model: GO('deepseek-v4-pro') });
  assert.equal(hub.kimi.calls.configure.filter((c) => c.id === s.id).at(-1).model, GO('deepseek-v4-pro'), 'and the native was given the alias it has');
});
