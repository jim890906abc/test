// Every source of models (server/providers.js): which family a model belongs
// to, what Kimi is given for DeepSeek and Claude, and how the hub keeps each
// computer's Kimi supplied: the providers of the sources with a key, then
// the pool of subagent models. The bridge is a fake that records what it is
// asked. No network, Kimi or account needed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-providers-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
delete process.env.ANTHROPIC_API_KEY;

const DS_KEY = 'sk-oc-go-0123456789abcd';
const CLAUDE_KEY = 'sk-ant-api03-0123456789abcdefghijklmnop';
const SUB = 'managed:kimi-code/kimi-for-coding';
const K3 = 'managed:kimi-code/k3-256k';
const DS_FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
const DS_PRO = 'agent-hub-deepseek/deepseek-v4-pro';
const OPUS = 'agent-hub-claude/claude-opus-5-5';
const HAIKU = 'agent-hub-claude/claude-haiku-4-5';
const NEW = { name: '新電腦', bridgeVersion: '0.9.0' };
const OLD = { name: '舊電腦', bridgeVersion: '0.8.0' };

let P; // providers.js
let deepseek;
let claude;
let store;

before(async () => {
  P = await import('../server/providers.js');
  deepseek = await import('../server/deepseek-account.js');
  claude = await import('../server/claude-account.js');
  store = await import('../server/store.js');
});

after(() => setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300));

beforeEach(() => {
  P.reset();
  for (const gw of Object.keys(deepseek.GATEWAYS)) deepseek.clearKey(gw);
  claude.clearKey();
  store.writeSettings({ defaults: {} });
});

// A bridge of 0.9.0 that records what it is asked, and answers like the real one.
function bridge({ force = false, noEfforts = false, failSync = null, failProvision = {} } = {}) {
  const calls = [];
  const rpc = async (machineId, op, args) => {
    calls.push({ machineId, op, args: JSON.parse(JSON.stringify(args)) });
    switch (op) {
      case 'kimi.hub.provision':
        if (failProvision[args.provider]) throw new Error(failProvision[args.provider]);
        return { ok: true, created: true, models: args.models.map((m) => `agent-hub-${args.provider}/${m.model}`), sessionHeader: true };
      case 'kimi.hub.remove':
        return { ok: true, removed: true };
      case 'kimi.subagents.sync':
        if (failSync) throw new Error(failSync);
        if (force) return { ok: true, skipped: 'force', pool: null, warning: 'locked' };
        return { ok: true, pool: { defaultModel: SUB, models: Object.keys(args.models) }, merged: true, efforts: noEfforts ? null : args.efforts, added: [], removed: [] };
      case 'kimi.deepseek.provision':
        return { ok: true, created: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`), sessionHeader: true };
      case 'kimi.deepseek.remove':
        return { ok: true, removed: true };
      default:
        throw new Error(`未知的操作：${op}`);
    }
  };
  return { calls, rpc, ops: () => calls.map((c) => c.op) };
}
const kimiModels = async () => [
  { id: SUB, name: 'kimi-for-coding' },
  { id: K3, name: 'K3-256k' },
];
const claudeModels = async () => ['claude-opus-5-5', 'claude-haiku-4-5'];
const ensure = (b, id = 'm1', opts = {}) => P.ensureProviders(id, { rpc: b.rpc, machine: NEW, kimiModels, claudeModels, ...opts });

test('a model\'s family is its provider\'s; a conversation\'s is its model\'s', () => {
  assert.equal(P.familyOf(DS_FLASH), 'deepseek');
  assert.equal(P.familyOf(OPUS), 'claude');
  assert.equal(P.familyOf(SUB), 'kimi');
  assert.equal(P.familyOf('agent-hub-deepseekish/x'), 'kimi', 'only the hub\'s own providers');
  assert.equal(P.familyOf(''), 'kimi');
  assert.equal(P.familyOf(undefined), 'kimi');
  assert.equal(P.aliasOf('claude', 'claude-opus-5-5'), OPUS);

  const kimi = (extra) => ({ kimiSessionId: 'k1', state: {}, ...extra });
  assert.equal(P.sessionFamily(kimi({ meta: { model: DS_PRO } })), 'deepseek');
  assert.equal(P.sessionFamily(kimi({ meta: { model: OPUS } })), 'claude');
  assert.equal(P.sessionFamily(kimi({ meta: { model: SUB } })), 'kimi');
  assert.equal(P.sessionFamily(kimi({})), 'kimi', 'no model yet');
  // Before it has a model: the one it was made for.
  assert.equal(P.sessionFamily(kimi({ state: { intendedModel: OPUS } })), 'claude');
  // The old DeepSeek mode, with or without a model; the model wins once it has one.
  assert.equal(P.sessionFamily(kimi({ mode: 'deepseek' })), 'deepseek');
  assert.equal(P.sessionFamily(kimi({ mode: 'deepseek', state: { deepseek: { model: DS_FLASH } } })), 'deepseek');
  assert.equal(P.sessionFamily(kimi({ mode: 'deepseek', meta: { model: SUB } })), 'kimi');
  // The Claude daemon's conversations are billed to the Claude API key; other agents have none.
  assert.equal(P.sessionFamily({ agentId: 'claude' }), 'claude');
  assert.equal(P.sessionFamily({ agentId: 'openai' }), null);
  assert.equal(P.sessionFamily(null), null);

  assert.equal(P.versionAtLeast('0.9.0', '0.9.0'), true);
  assert.equal(P.versionAtLeast('0.10.1', '0.9.0'), true);
  assert.equal(P.versionAtLeast('1.0.0', '0.9.5'), true);
  assert.equal(P.versionAtLeast('0.8.9', '0.9.0'), false);
  assert.equal(P.versionAtLeast(undefined, '0.9.0'), false);
  assert.equal(P.hubCapable({ bridgeVersion: '0.9.0' }), true);
  assert.equal(P.hubCapable({ bridgeVersion: '0.8.0' }), false);
  assert.equal(P.hubCapable(undefined), false);
});

test('where the tokens go, in words; the line after a model moves to another source', () => {
  assert.equal(P.billingOf('kimi'), 'Kimi 訂閱');
  assert.equal(P.billingOf('deepseek'), 'OpenCode Go 的 API key');
  assert.match(P.billingOf('claude'), /Claude Console 的 API key/);
  assert.equal(P.switchNote('DeepSeek V4.1 Flash', 'deepseek'), '改用 DeepSeek V4.1 Flash：之後的回合算在 OpenCode Go 的 API key，不用 Kimi 訂閱');
  assert.equal(P.switchNote('Claude Opus 5.5', 'claude'), '改用 Claude Opus 5.5：之後的回合算在 Claude Console 的 API key（按量計費），不用 Kimi 訂閱');
  assert.equal(P.switchNote('K3.1 Pro', 'kimi'), '改用 K3.1 Pro：之後的回合算在 Kimi 訂閱');
});

test('Claude models are given to Kimi as the Claude adapter thinks: always, off, adaptive or budget', () => {
  // Opus 5.5 cannot turn thinking off.
  assert.deepEqual(claude.kimiModel('claude-opus-5-5'), {
    model: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    max_context_size: 1_000_000,
    max_output_size: 128_000,
    capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'],
    support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    adaptive_thinking: true,
  });
  // Sonnet 5.5 can.
  const sonnet = claude.kimiModel('claude-sonnet-5-5');
  assert.deepEqual(sonnet.capabilities, ['thinking', 'tool_use', 'image_in']);
  assert.equal(sonnet.adaptive_thinking, true);
  // Opus 4.6 has no xhigh.
  assert.deepEqual(claude.kimiModel('claude-opus-4-6').support_efforts, ['low', 'medium', 'high', 'max']);
  // Haiku 4.5 takes a thinking budget only, and a smaller window.
  const haiku = claude.kimiModel('claude-haiku-4-5');
  assert.deepEqual([haiku.adaptive_thinking, haiku.support_efforts, haiku.max_context_size, haiku.max_output_size], [false, ['low', 'medium', 'high'], 200_000, 64_000]);
  // Only what the bridge allows.
  for (const id of ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-future-9']) {
    const m = claude.kimiModel(id);
    assert.ok(m.capabilities.every((c) => ['thinking', 'always_thinking', 'tool_use', 'image_in'].includes(c)), id);
    assert.ok(m.support_efforts.every((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)), id);
  }
  // As the composer shows them: what Kimi's /effort picker would offer.
  const info = (id) => P.modelInfo(claude.kimiModel(id), P.aliasOf('claude', id));
  assert.deepEqual([info('claude-opus-5-5').efforts, info('claude-opus-5-5').defaultEffort, info('claude-opus-5-5').family], [['low', 'medium', 'high', 'xhigh', 'max'], 'medium', 'claude']);
  assert.deepEqual(info('claude-sonnet-5-5').efforts, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(info('claude-haiku-4-5').image, true);
  const ds = P.modelInfo(deepseek.kimiModel('deepseek-v4-pro'), DS_PRO);
  assert.deepEqual([ds.efforts, ds.defaultEffort, ds.family, ds.deepseek], [['low', 'high', 'max'], 'max', 'deepseek', true]);
});

test('providers first, then the pool: every keyed source is provisioned, then one sync with every model', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  claude.setKey(CLAUDE_KEY);
  const b = bridge();
  const r = await ensure(b);
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
  assert.deepEqual(b.ops(), ['kimi.hub.provision', 'kimi.hub.provision', 'kimi.subagents.sync'], 'the sync comes last, after every provision');

  const ds = b.calls[0].args;
  assert.deepEqual(Object.keys(ds).sort(), ['apiKey', 'gateway', 'models', 'provider']);
  assert.deepEqual([ds.provider, ds.gateway, ds.apiKey], ['deepseek', 'opencode-go', DS_KEY]);
  assert.deepEqual(ds.models.map((m) => m.model), ['deepseek-v4.1-flash', 'deepseek-v4-pro']);
  assert.ok(!JSON.stringify(ds).includes('http'), 'a gateway is named, never an address');
  const cl = b.calls[1].args;
  assert.deepEqual(Object.keys(cl).sort(), ['apiKey', 'models', 'provider'], 'Claude has no gateway');
  assert.deepEqual([cl.provider, cl.apiKey], ['claude', CLAUDE_KEY]);
  assert.deepEqual(cl.models.map((m) => m.model), ['claude-opus-5-5', 'claude-haiku-4-5']);
  assert.deepEqual(cl.models[0], claude.kimiModel('claude-opus-5-5'));

  const sync = b.calls[2].args;
  assert.deepEqual(Object.keys(sync.models), [SUB, K3, DS_FLASH, DS_PRO, OPUS, HAIKU], 'Kimi\'s own models and every keyed source\'s');
  // Family, billing and what each is for.
  assert.match(sync.models[SUB], /Kimi.*訂閱/);
  assert.match(sync.models[DS_FLASH], /DeepSeek.*DeepSeek 閘道 key.*fast and cheap/);
  assert.match(sync.models[DS_PRO], /deeper reasoning/);
  assert.match(sync.models[OPUS], /Claude.*Claude API key.*strongest/);
  assert.match(sync.models[HAIKU], /fast and cheap/);
  assert.ok(Object.values(sync.models).every((d) => d.length < 200));
  // DeepSeek at max (Kimi would fall back to high); Claude and Kimi nothing to set.
  assert.deepEqual(sync.efforts, { [DS_FLASH]: 'max', [DS_PRO]: 'max' });
  assert.deepEqual(r.pool.models, Object.keys(sync.models));
  assert.equal(P.poolState('m1', NEW).available, true);
  assert.equal(P.poolState('m1', NEW).scope, 'per-model');
});

test('asked again: nothing is sent while keys, models and efforts are the same', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const b = bridge();
  await ensure(b);
  assert.equal(b.calls.length, 2);
  const again = await ensure(b);
  assert.equal(again.cached, true);
  assert.equal(b.calls.length, 2, 'cached by signature');
  // At the same time: one request.
  const b2 = bridge();
  const [x, y] = await Promise.all([ensure(b2, 'm2'), ensure(b2, 'm2')]);
  assert.equal(b2.calls.length, 2);
  assert.equal(x.cached, y.cached);
  // Another computer has its own.
  await ensure(b2, 'm3');
  assert.equal(b2.calls.length, 4);
});

test('a new key or model list is provisioned again, and the pool is sent after EVERY provision (a provision drops the efforts)', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const b = bridge();
  await ensure(b);
  b.calls.length = 0;
  // Same models, another key: the pool does not change, but a provision drops what it had set.
  deepseek.setKey('opencode-go', 'sk-oc-go-other-key-000000');
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.hub.provision', 'kimi.subagents.sync']);
  assert.equal(b.calls[0].args.apiKey, 'sk-oc-go-other-key-000000');
  assert.deepEqual(b.calls[1].args.efforts, { [DS_FLASH]: 'max', [DS_PRO]: 'max' }, 'the efforts go again');
  b.calls.length = 0;
  // A bridge that reconnects starts over.
  P.forget('m1');
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.hub.provision', 'kimi.subagents.sync']);
  b.calls.length = 0;
  // Another gateway.
  deepseek.setKey('opencode', 'sk-oc-pay-0123456789');
  deepseek.setSettings({ gateway: 'opencode' });
  await ensure(b);
  assert.equal(b.calls[0].args.gateway, 'opencode');
  assert.deepEqual(b.calls[0].args.models.map((m) => m.model), ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash-free']);
  assert.ok(Object.keys(b.calls[1].args.models).includes('agent-hub-deepseek/deepseek-v4.1-flash-free'));
  deepseek.setSettings({ gateway: 'opencode-go' });
});

test('subagent efforts: per model alias, from 設定; only what the model has, DeepSeek at max otherwise', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  claude.setKey(CLAUDE_KEY);
  const b = bridge();
  await ensure(b);
  b.calls.length = 0;
  store.writeSettings({ defaults: {}, subagentEfforts: { [DS_PRO]: 'low', [OPUS]: 'xhigh', [HAIKU]: 'max', [SUB]: 'high', [DS_FLASH]: 'turbo' } });
  assert.deepEqual(P.subagentEfforts(), { [DS_PRO]: 'low', [OPUS]: 'xhigh', [HAIKU]: 'max' }, 'Kimi\'s own models have nothing to set; garbage is dropped');
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.subagents.sync'], 'only the pool changed');
  assert.deepEqual(b.calls[0].args.efforts, { [DS_FLASH]: 'max', [DS_PRO]: 'low', [OPUS]: 'xhigh' }, 'Haiku 4.5 has no max; Flash\'s "turbo" is not an effort');
  // The catalog says what each model is set to.
  const cat = await P.catalog('m1', { machine: { ...NEW, online: true, kimi: { server: true } }, machineModels: async () => null, claudeModels });
  const set = Object.fromEntries(cat.sources.flatMap((s) => s.models.map((m) => [m.id, m.subagentEffort])));
  assert.equal(set[DS_PRO], 'low');
  assert.equal(set[DS_FLASH], 'max');
  assert.equal(set[OPUS], 'xhigh');
  assert.equal(set[HAIKU], null);
});

test('removing a key takes the provider off, then the pool is sent again without its models', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  claude.setKey(CLAUDE_KEY);
  const b = bridge();
  await ensure(b);
  b.calls.length = 0;
  claude.clearKey();
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.hub.remove', 'kimi.subagents.sync'], 'removed first, then synced');
  assert.deepEqual(b.calls[0].args, { provider: 'claude' });
  assert.deepEqual(Object.keys(b.calls[1].args.models), [SUB, K3, DS_FLASH, DS_PRO]);
  b.calls.length = 0;
  deepseek.clearKey('opencode-go');
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.hub.remove', 'kimi.subagents.sync']);
  assert.deepEqual(b.calls[0].args, { provider: 'deepseek' });
  assert.deepEqual(Object.keys(b.calls[1].args.models), [SUB, K3], 'only Kimi\'s own models are left in the pool');
  assert.deepEqual(b.calls[1].args.efforts, {});
  // Nothing more to do.
  b.calls.length = 0;
  await ensure(b);
  assert.equal(b.calls.length, 0);
  // A key removed while this process never provisioned it (a restart): `purge` takes it off anyway.
  P.reset();
  await ensure(b, 'm9', { purge: ['claude'] });
  assert.deepEqual(b.calls.map((c) => [c.op, c.args.provider]).filter(([op]) => op !== 'kimi.subagents.sync'), [['kimi.hub.remove', 'claude']]);
});

test('without a key the source cannot be asked for, and says so; one source failing does not stop the other', async () => {
  const b = bridge({ failProvision: { claude: '連線失敗' } });
  await assert.rejects(ensure(b, 'm1', { need: 'deepseek' }), (e) => e.status === 409 && e.code === 'no_key' && /DeepSeek/.test(e.message));
  await assert.rejects(ensure(b, 'm1', { need: 'claude' }), (e) => e.status === 409 && e.code === 'no_key' && /Claude API key/.test(e.message));
  // Nothing keyed: Kimi's own models still go to the pool.
  assert.deepEqual(b.ops(), ['kimi.subagents.sync']);
  deepseek.setKey('opencode-go', DS_KEY);
  claude.setKey(CLAUDE_KEY);
  P.reset();
  b.calls.length = 0;
  const r = await ensure(b);
  assert.deepEqual(r.provisioned, ['deepseek']);
  assert.equal(r.errors.claude.message, '連線失敗');
  assert.ok(!Object.keys(b.calls.at(-1).args.models).some((a) => a.startsWith('agent-hub-claude/')), 'a provider Kimi does not have is not in the pool');
  // The caller that needs Claude is told; one that needs DeepSeek is not.
  await assert.rejects(ensure(b, 'm1', { need: 'claude' }), /連線失敗/);
  assert.equal((await ensure(b, 'm1', { need: 'deepseek' })).ok, true);
  // An error is not remembered: it is asked again.
  const n = b.calls.filter((c) => c.op === 'kimi.hub.provision' && c.args.provider === 'claude').length;
  await assert.rejects(ensure(b, 'm1', { need: 'claude' }), /連線失敗/);
  assert.equal(b.calls.filter((c) => c.op === 'kimi.hub.provision' && c.args.provider === 'claude').length, n + 1);
});

test('an old bridge: DeepSeek as before, no pool, and Claude and subagent models want the 連接器 run again', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const b = bridge();
  const old = (opts = {}) => P.ensureProviders('old', { rpc: b.rpc, machine: OLD, kimiModels, claudeModels, ...opts });
  const r = await old();
  assert.deepEqual(b.ops(), ['kimi.deepseek.provision'], 'the op it knows; no pool');
  assert.deepEqual(Object.keys(b.calls[0].args).sort(), ['apiKey', 'gateway', 'models']);
  assert.equal(r.synced, false);
  const pool = P.poolState('old', OLD);
  assert.equal(pool.available, false);
  assert.equal(pool.scope, 'none');
  assert.match(pool.reason, /連接器太舊.*子代理模型/);
  await old();
  assert.equal(b.calls.length, 1, 'cached');
  // Claude: the 連接器 must be run again.
  claude.setKey(CLAUDE_KEY);
  await assert.rejects(old({ need: 'claude' }), (e) => e.status === 409 && /連接器太舊.*Claude/.test(e.message) && /連接指令/.test(e.message));
  assert.equal(b.calls.length, 1, 'nothing was asked');
  assert.equal((await old()).provisioned.length, 0, 'without `need` the rest goes on');
  // The key leaves with the old op.
  deepseek.clearKey('opencode-go');
  claude.clearKey();
  b.calls.length = 0;
  await old();
  assert.deepEqual(b.ops(), ['kimi.deepseek.remove']);
  // A bridge that says it is new but does not know the op is old all the same.
  deepseek.setKey('opencode-go', DS_KEY);
  P.reset();
  await assert.rejects(P.ensureProviders('liar', { rpc: async () => { throw new Error('未知的操作：kimi.hub.provision'); }, machine: NEW, kimiModels, need: 'deepseek' }), /連接器太舊/);
});

test('the pool the user\'s Kimi locks (force) is left alone, and said so; efforts the bridge cannot write turn the scope off', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const locked = bridge({ force: true });
  await ensure(locked, 'locked');
  const ps = P.poolState('locked', NEW);
  assert.equal(ps.available, false);
  assert.match(ps.reason, /鎖定了子代理模型（force），中控台沒有改它/);
  assert.equal(ps.scope, 'none');

  const flat = bridge({ noEfforts: true });
  await ensure(flat, 'flat');
  assert.equal(P.poolState('flat', NEW).available, true);
  assert.equal(P.poolState('flat', NEW).scope, 'none');
  const cat = await P.catalog('flat', { machine: { ...NEW, online: true, kimi: { server: true } }, machineModels: async () => null });
  assert.equal(cat.subagentEffortScope, 'none');
});

test('a pool that cannot be written is reported, not thrown; and not asked again at once', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const b = bridge({ failSync: '子代理模型沒有設定，已還原：config.toml 不能寫' });
  const r = await ensure(b);
  assert.equal(r.ok, true, 'the providers are there; a conversation can still start');
  assert.equal(r.synced, false);
  assert.match(P.poolState('m1', NEW).warning, /子代理模型沒有設定，已還原/);
  const n = b.calls.length;
  await ensure(b);
  assert.equal(b.calls.length, n, 'not again within a minute');
});

test('while Kimi\'s own models cannot be read (its server is down), the pool is left alone', async () => {
  deepseek.setKey('opencode-go', DS_KEY);
  const b = bridge();
  const r = await P.ensureProviders('m1', { rpc: b.rpc, machine: NEW, kimiModels: async () => null });
  assert.deepEqual(b.ops(), ['kimi.hub.provision'], 'a pool without Kimi\'s own models would drop them');
  assert.equal(r.syncSkipped, true);
  await ensure(b);
  assert.deepEqual(b.ops(), ['kimi.hub.provision', 'kimi.subagents.sync']);
});

test('the catalog: every source with its models, ready or not, and whether subagent models work', async () => {
  const kimiInfo = (id, name, extra = {}) => ({ id, name, efforts: ['off', 'low', 'high'], defaultEffort: null, image: true, context: 262144, family: 'kimi', ...extra });
  const machineModels = async () => ({
    defaultModel: SUB,
    models: [kimiInfo(SUB, 'kimi-for-coding'), kimiInfo(K3, 'K3-256k'), kimiInfo(DS_FLASH, 'DeepSeek V4.1 Flash', { family: 'deepseek' })],
  });
  const online = { id: 'm1', name: '新電腦', bridgeVersion: '0.9.0', online: true, kimi: { server: true } };
  // Only Kimi without keys; the hub's own providers are not "Kimi's".
  let cat = await P.catalog('m1', { machine: online, machineModels, claudeModels });
  assert.deepEqual(cat.sources.map((s) => s.id), ['kimi']);
  assert.deepEqual(cat.sources[0].models.map((m) => m.id), [SUB, K3], 'listed whatever Kimi\'s global default is; the hub providers\' models are not Kimi\'s');
  assert.deepEqual([cat.sources[0].ready, cat.sources[0].billing, cat.sources[0].defaultModel], [true, 'Kimi 訂閱', SUB]);

  deepseek.setKey('opencode-go', DS_KEY);
  claude.setKey(CLAUDE_KEY);
  cat = await P.catalog('m1', { machine: online, machineModels, claudeModels });
  assert.deepEqual(cat.sources.map((s) => s.id), ['kimi', 'deepseek', 'claude']);
  const [kimi, ds, cl] = cat.sources;
  assert.deepEqual([ds.label, ds.billing, ds.ready, ds.gateway], ['DeepSeek', 'OpenCode Go 的 API key', true, { id: 'opencode-go', label: 'OpenCode Go' }]);
  assert.deepEqual(ds.models.map((m) => m.id), [DS_FLASH, DS_PRO]);
  assert.deepEqual(ds.models[0], { id: DS_FLASH, name: 'DeepSeek V4.1 Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'max', image: true, context: 1_000_000, family: 'deepseek', deepseek: true, subagentEffort: 'max' });
  assert.equal(ds.defaultModel, DS_FLASH);
  assert.deepEqual([cl.label, cl.ready, cl.defaultModel], ['Claude', true, OPUS]);
  assert.deepEqual(cl.models.map((m) => [m.id, m.name, m.family]), [[OPUS, 'Claude Opus 5.5', 'claude'], [HAIKU, 'Claude Haiku 4.5', 'claude']]);
  assert.equal(kimi.models.every((m) => m.family === 'kimi'), true);
  assert.equal(cat.subagentEffortScope, 'per-model');
  assert.equal(cat.subagents.available, true);

  // The computer's connector is too old for Claude and for subagent models; DeepSeek still works.
  const old = { ...online, bridgeVersion: '0.8.0' };
  cat = await P.catalog('m1', { machine: old, machineModels, claudeModels });
  assert.equal(cat.sources.find((s) => s.id === 'deepseek').ready, true);
  const oldClaude = cat.sources.find((s) => s.id === 'claude');
  assert.equal(oldClaude.ready, false);
  assert.match(oldClaude.note, /連接器太舊/);
  assert.equal(cat.subagentEffortScope, 'none');
  assert.equal(cat.subagents.available, false);
  assert.match(cat.subagents.reason, /連接指令/);

  // Offline, or Kimi not started, or no computer chosen.
  cat = await P.catalog('m1', { machine: { ...online, online: false }, machineModels, claudeModels });
  assert.deepEqual([cat.sources[0].ready, cat.sources[0].models.length, cat.sources[1].ready], [false, 0, false]);
  assert.match(cat.sources[0].note, /離線/);
  cat = await P.catalog('m1', { machine: { ...online, kimi: { server: false } }, machineModels, claudeModels });
  assert.match(cat.sources[0].note, /Kimi 還沒啟動/);
  assert.equal(cat.sources[1].ready, true, 'the models of a key are known without the computer\'s Kimi');
  cat = await P.catalog('', { claudeModels });
  assert.equal(cat.sources[0].ready, false);
  assert.equal(cat.sources.length, 3);
});
