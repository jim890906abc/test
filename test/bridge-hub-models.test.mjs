// The bridge putting the hub's models into a computer's Kimi: the Claude provider next to
// DeepSeek's (kimi.hub.provision / kimi.hub.remove, and the old kimi.deepseek.* names), and the
// subagent model pool (kimi.subagents.sync): what is written, what is kept, what is put back.
// A fake Kimi that merges config writes the way Kimi 2.1.1 does and reads config.toml again when
// it is changed under it (test/fixtures/fake-kimi-config.mjs), and the real bridge, spawned.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createFakeKimi, SUB, MANAGED } from './fixtures/fake-kimi-config.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hubmodels-'));
const DS = 'agent-hub-deepseek';
const CL = 'agent-hub-claude';
const CLAUDE_KEY = 'sk-ant-api03-0123456789abcdefghijklmnop';
const ALIASES = { ds: `${DS}/deepseek-v4.1-flash`, ds2: `${DS}/deepseek-v4-pro`, opus: `${CL}/claude-opus-5-5`, haiku: `${CL}/claude-haiku-4-5` };
const running = [];

const dsModels = (names = ['deepseek-v4.1-flash', 'deepseek-v4-pro']) =>
  names.map((model) => ({ model, display_name: `DS ${model}`, max_context_size: 1_000_000, max_output_size: 384_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] }));
const claudeModels = () => [
  { model: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_context_size: 1_000_000, max_output_size: 128_000, capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'], support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive_thinking: true },
  { model: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_context_size: 200_000, max_output_size: 64_000, capabilities: ['thinking', 'tool_use', 'image_in'], support_efforts: ['low', 'medium', 'high'], adaptive_thinking: false },
];

// config.toml split into its tables, minus the hub's own and the pool's: what must not move.
function others(text, pool = true) {
  const tables = new Map();
  let head = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) head = t.replace(/\s+/g, '');
    if (/^\[(providers\.["']?agent-hub-|models\."agent-hub-)/.test(head)) continue;
    if (pool && /^\[secondary_model(\.|\])/.test(head)) continue;
    if (t) tables.set(head, [...(tables.get(head) || []), t].sort());
  }
  return JSON.stringify([...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// A fake Kimi and the real bridge on it, for one test.
async function setup(name, { fakeEnv = {} } = {}) {
  const dir = path.join(TMP, name);
  const home = path.join(dir, 'kimi');
  const kimi = createFakeKimi({ home });
  kimi.reset();
  await kimi.listen();
  const wss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => wss.on('listening', r));
  const pending = new Map();
  let hubWs;
  const connected = new Promise((resolve) => wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'hello') (hubWs = ws), resolve(m);
    if (m.t === 'res' && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  })));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${wss.address().port}`, '--key', 'k', '--kimi-home', home, '--kimi-bin', path.join(dir, 'no-kimi'), '--no-skill'], { env: { ...process.env, HOME: path.join(dir, 'state'), ...fakeEnv }, stdio: 'ignore' });
  const hello = await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge did not connect')), 15000))]);
  const t = {
    kimi,
    hello,
    cfg: () => fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
    ask: (op, args, ms = 30000) =>
      new Promise((resolve, reject) => {
        const id = `q${Math.random().toString(36).slice(2)}`;
        pending.set(id, resolve);
        hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
        setTimeout(() => reject(new Error(`no answer to ${op}`)), ms);
      }),
    stop: () => {
      bridge.kill('SIGTERM');
      wss.close();
      kimi.server.close();
    },
  };
  t.provisionAll = async () => {
    assert.equal((await t.ask('kimi.hub.provision', { provider: 'deepseek', gateway: 'opencode-go', apiKey: 'sk-test-key-1234', models: dsModels() })).ok, true);
    assert.equal((await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() })).ok, true);
    kimi.writes.length = 0;
  };
  t.sync = (models, efforts) => t.ask('kimi.subagents.sync', { models, ...(efforts ? { efforts } : {}) });
  t.poolKeys = () => Object.keys(kimi.state.secondary?.models || {});
  running.push(t);
  return t;
}
after(() => {
  for (const t of running) t.stop();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const POOL = () => ({ [SUB]: 'Kimi subscription', [ALIASES.ds]: 'DeepSeek flash', [ALIASES.ds2]: 'DeepSeek pro', [ALIASES.opus]: 'Claude Opus', [ALIASES.haiku]: 'Claude Haiku' });

// ---------------------------------------------------------------- the Claude provider

test('the bridge reports 0.9.0 and takes the generic ops', async () => {
  const t = await setup('version');
  assert.equal(t.hello.bridgeVersion, '0.9.0');
});

test('kimi.hub.provision makes agent-hub-claude: type anthropic, Anthropic\'s own address, the key, each model with its thinking details; Kimi\'s default stays', async () => {
  const t = await setup('claude');
  const before = t.cfg();
  const r = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.models, [ALIASES.opus, ALIASES.haiku]);
  assert.equal(r.data.created, true);
  assert.equal(r.data.sessionHeader, undefined, 'a session header is a gateway thing');
  // Only the provider was written: not a header, not a default.
  assert.deepEqual(t.kimi.writes.map(([m, p]) => `${m} ${p}`), ['POST /api/v1/providers']);
  const body = t.kimi.writes[0][2];
  assert.equal(body.id, CL);
  assert.equal(body.type, 'anthropic');
  assert.equal(body.base_url, 'https://api.anthropic.com', 'no /v1: the Anthropic client adds /v1/messages itself');
  assert.equal(body.api_key, CLAUDE_KEY);
  assert.equal(body.default_model, undefined);
  assert.deepEqual(body.models[0], { model: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_context_size: 1_000_000, max_output_size: 128_000, capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'], support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive_thinking: true });
  assert.equal(body.models[1].adaptive_thinking, false);
  assert.equal(t.kimi.state.defaultModel, SUB);
  assert.equal(others(t.cfg()), others(before), 'nothing but the hub\'s tables changed');
  // Again: replaced, not created twice.
  const again = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() });
  assert.equal(again.data.created, false);
  assert.equal(t.kimi.writes.at(-1)[0], 'PUT');
});

test('a Claude key must be a Console API key: subscription tokens, admin keys and anything odd are refused before Kimi hears of it', async () => {
  const t = await setup('claude-key');
  for (const apiKey of ['', 'sk-ant-oat01-0123456789abcdefghijklmnop', 'sk-ant-ort01-0123456789abcdefghijklmnop', 'sk-ant-admin01-0123456789abcdefghijklmnop', 'sk-ant-short', 'sk-live-0123456789abcdefghijklmnopq', 'sk-ant-api03-has space 0123456789', 'x'.repeat(501), 12345]) {
    const r = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey, models: claudeModels() });
    assert.equal(r.ok, false, String(apiKey).slice(0, 30));
    assert.match(r.error, /Claude Console 的 API key/);
  }
  for (const provider of ['openai', '__proto__', undefined]) {
    const r = await t.ask('kimi.hub.provision', { provider: provider === undefined ? 'nope' : provider, apiKey: CLAUDE_KEY, models: claudeModels() });
    assert.equal(r.ok, false);
    assert.match(r.error, /不支援的模型來源/);
  }
  assert.deepEqual(t.kimi.writes, []);
});

test('Claude models take adaptive_thinking and Claude\'s effort names, and nothing the bridge does not know', async () => {
  const t = await setup('claude-fields');
  const bad = [
    [{ adaptive_thinking: 'yes' }, /adaptive_thinking/],
    [{ support_efforts: ['low', 'ludicrous'] }, /support_efforts/],
    [{ capabilities: ['tool_use', 'root_access'] }, /capabilities/],
    [{ max_context_size: 5 }, /max_context_size/],
  ];
  for (const [over, why] of bad) {
    const r = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: [{ ...claudeModels()[0], ...over }] });
    assert.equal(r.ok, false);
    assert.match(r.error, why);
  }
  assert.deepEqual(t.kimi.writes, []);
  const m = { ...claudeModels()[0], base_url: 'https://evil.example', api_key: 'sneaky', extra: 1 };
  const r = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: [m] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(t.kimi.writes[0][2].models[0]).sort(), ['adaptive_thinking', 'capabilities', 'display_name', 'max_context_size', 'max_output_size', 'model', 'support_efforts']);
});

test('the Claude provider never becomes Kimi\'s default: an empty default is pinned to the subscription first, and a default that moved is put back', async () => {
  const t = await setup('claude-guard');
  t.kimi.state.defaultModel = '';
  const r = await t.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() });
  assert.equal(r.ok, true, r.error);
  assert.equal(t.kimi.state.defaultModel, SUB, 'pinned to the subscription\'s model');
  assert.ok(t.kimi.writes.findIndex(([, p]) => p.endsWith(':set_default')) < t.kimi.writes.findIndex(([, p]) => p === '/api/v1/providers'), 'pinned before the provider was made');
  // Kimi moves the default anyway: put back, and the call fails.
  const t2 = await setup('claude-hijack');
  t2.kimi.hijack = true;
  const bad = await t2.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /全域預設模型被改動了.*已還原/);
  assert.equal(t2.kimi.state.defaultModel, SUB);
  // No subscription model to pin to: not created at all.
  const t3 = await setup('claude-nosub');
  Object.assign(t3.kimi.state, { defaultModel: '', managedDefault: '' });
  delete t3.kimi.state.providers[MANAGED];
  const none = await t3.ask('kimi.hub.provision', { provider: 'claude', apiKey: CLAUDE_KEY, models: claudeModels() });
  assert.equal(none.ok, false);
  assert.match(none.error, /kimi login/);
  assert.deepEqual(t3.kimi.writes, []);
});

test('DeepSeek and Claude live side by side; kimi.hub.remove takes one away and the old kimi.deepseek.* names still work', async () => {
  const t = await setup('both');
  await t.provisionAll();
  assert.deepEqual(Object.keys(t.kimi.state.providers).sort(), [CL, DS, MANAGED, 'other'].sort());
  // The DeepSeek session header is still added, with the Claude provider's tables in the file.
  assert.equal(t.kimi.state.providers[DS].custom_headers['x-opencode-session'].startsWith('ses_agenthub_'), true);
  const rm = await t.ask('kimi.hub.remove', { provider: 'claude' });
  assert.deepEqual([rm.ok, rm.data.removed], [true, true]);
  assert.equal(t.kimi.state.providers[CL], undefined);
  assert.ok(t.kimi.state.providers[DS] && t.kimi.state.providers.other, 'nothing else went');
  assert.equal((await t.ask('kimi.hub.remove', { provider: 'claude' })).data.removed, false, 'already gone');
  // The old names: DeepSeek only.
  const old = await t.ask('kimi.deepseek.provision', { gateway: 'opencode-go', apiKey: 'sk-test-key-1234', models: dsModels(['deepseek-v4-pro']) });
  assert.equal(old.ok, true, old.error);
  assert.deepEqual(old.data.models, [ALIASES.ds2]);
  assert.equal((await t.ask('kimi.deepseek.remove', {})).data.removed, true);
  assert.equal(t.kimi.state.providers[DS], undefined);
  assert.equal(t.kimi.state.defaultModel, SUB);
  // Removing refuses while a hub model is Kimi's default.
  await t.provisionAll();
  t.kimi.state.defaultModel = ALIASES.opus;
  const no = await t.ask('kimi.hub.remove', { provider: 'claude' });
  assert.equal(no.ok, false);
  assert.match(no.error, /Claude 模型/);
});

// ------------------------------------------------------------------- the subagent pool

test('subagents.sync makes the pool: every model given, default_model = Kimi\'s own default, never force; only POST /config is used', async () => {
  const t = await setup('pool-fresh');
  await t.provisionAll();
  const before = t.cfg();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool.defaultModel, SUB);
  assert.deepEqual(r.data.pool.models.sort(), Object.keys(POOL()).sort());
  assert.equal(r.data.merged, false);
  // Kimi's pool, as GET /config shows it, and as it is in the file.
  assert.deepEqual(t.kimi.state.secondary, { defaultModel: SUB, models: POOL() });
  const text = t.cfg();
  assert.match(text, /\[secondary_model\]\ndefault_model = "managed:kimi-code\/kimi-for-coding"\n\n\[secondary_model\.models\]\n"managed:kimi-code\/kimi-for-coding" = "Kimi subscription"/);
  assert.ok(!/force/.test(text));
  assert.deepEqual([...new Set(t.kimi.writes.map(([m, p]) => `${m} ${p}`))], ['POST /api/v1/config']);
  assert.ok(t.kimi.writes.every(([, , b]) => b.force === undefined && b.secondary_model?.force === undefined));
  // Nothing outside the pool moved: Kimi's default, the providers, the other tables.
  assert.equal(t.kimi.state.defaultModel, SUB);
  assert.equal(others(text), others(before));
  // The same again is a no-op.
  t.kimi.writes.length = 0;
  const again = await t.sync(POOL());
  assert.equal(again.data.unchanged, true);
  assert.deepEqual(t.kimi.writes, []);
});

test('the pool\'s default follows Kimi\'s global default while the hub made it, and models Kimi does not have are left out with a warning', async () => {
  const t = await setup('pool-default');
  await t.provisionAll();
  await t.sync(POOL());
  t.kimi.state.defaultModel = 'other/m'; // the user chose another model in Kimi
  t.kimi.save();
  const r = await t.sync({ ...POOL(), 'other/m': 'custom', 'agent-hub-claude/not-provisioned': 'ghost' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool.defaultModel, 'other/m');
  assert.equal(t.kimi.state.secondary.defaultModel, 'other/m');
  assert.ok(!('agent-hub-claude/not-provisioned' in t.kimi.state.secondary.models));
  assert.match(r.data.warning, /not-provisioned/);
  assert.equal(t.kimi.state.defaultModel, 'other/m', 'Kimi\'s default is only read, never set');
});

test('a pool the user wrote is merged into: their entries and their default stay, the hub\'s are added, and taking the hub\'s away leaves theirs', async () => {
  const t = await setup('pool-merge');
  await t.provisionAll();
  t.kimi.state.secondary = { defaultModel: 'other/n', models: { 'other/n': 'my small model', 'other/m': 'my other model' } };
  t.kimi.save();
  const before = t.cfg();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.merged, true);
  assert.equal(r.data.pool.defaultModel, 'other/n', 'their default stays');
  assert.deepEqual(t.kimi.state.secondary.models, { 'other/n': 'my small model', 'other/m': 'my other model', ...POOL() });
  // One of the hub's goes (a provider dropped a model): only that one.
  const { [ALIASES.haiku]: _gone, ...rest } = POOL();
  const r2 = await t.sync(rest);
  assert.deepEqual(r2.data.removed, [ALIASES.haiku]);
  assert.deepEqual(t.poolKeys().sort(), ['other/m', 'other/n', ...Object.keys(rest)].sort());
  // All of the hub's go: theirs is exactly what it was, in Kimi and in the file.
  const r3 = await t.sync({});
  assert.equal(r3.ok, true, r3.error);
  assert.deepEqual(t.kimi.state.secondary, { defaultModel: 'other/n', models: { 'other/n': 'my small model', 'other/m': 'my other model' } });
  assert.match(t.cfg(), /\[secondary_model\]\ndefault_model = "other\/n"\n\n\[secondary_model\.models\]\n"other\/n" = "my small model"\n"other\/m" = "my other model"/);
  assert.equal(others(t.cfg()), others(before));
});

test('a pool the user already has with the same alias keeps their description and is not the hub\'s to remove', async () => {
  const t = await setup('pool-same-alias');
  await t.provisionAll();
  t.kimi.state.secondary = { defaultModel: SUB, models: { [SUB]: 'my words for it' } };
  t.kimi.save();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true, r.error);
  assert.equal(t.kimi.state.secondary.models[SUB], 'my words for it');
  await t.sync({});
  assert.deepEqual(t.kimi.state.secondary, { defaultModel: SUB, models: { [SUB]: 'my words for it' } });
});

test('a pool the hub made is removed whole with {models: {}}: the tables are gone from config.toml and nothing else changed', async () => {
  const t = await setup('pool-remove');
  await t.provisionAll();
  const before = t.cfg();
  await t.sync(POOL());
  const r = await t.sync({});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pool, null);
  assert.equal(t.kimi.state.secondary, undefined);
  assert.ok(!/secondary_model/.test(t.cfg()), t.cfg());
  assert.equal(others(t.cfg()), others(before));
  assert.equal(t.kimi.state.defaultModel, SUB);
  // And it can be made again.
  assert.equal((await t.sync(POOL())).ok, true);
  assert.equal(t.poolKeys().length, 5);
});

test('a pool written the old way (one `model`) is kept as the user\'s entry and default', async () => {
  const t = await setup('pool-legacy');
  await t.provisionAll();
  t.kimi.state.secondary = { model: 'other/m' };
  t.kimi.save();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.merged, true);
  assert.equal(r.data.pool.defaultModel, 'other/m');
  assert.equal(t.kimi.state.secondary.models['other/m'], '');
  assert.equal(t.kimi.state.secondary.model, 'other/m', 'their key is left alone');
  await t.sync({});
  assert.deepEqual(Object.keys(t.kimi.state.secondary.models), ['other/m']);
  assert.equal(t.kimi.state.secondary.defaultModel, 'other/m');
});

test('a pool-wide default_effort the user set has to suit every model in the pool (Kimi turns the pool down otherwise): the models that do not take it are left out', async () => {
  const t = await setup('pool-effort-global');
  await t.provisionAll();
  t.kimi.state.secondary = { defaultModel: 'other/m', defaultEffort: 'medium', models: { 'other/m': 'mine' } };
  t.kimi.save();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true, r.error);
  // DeepSeek's levels are low/high/max: no medium.
  assert.deepEqual(t.poolKeys().sort(), ['other/m', SUB, ALIASES.opus, ALIASES.haiku].sort());
  assert.match(r.data.warning, /default_effort.*deepseek-v4\.1-flash.*deepseek-v4-pro/);
  assert.equal(t.kimi.state.secondary.defaultEffort, 'medium', 'theirs is untouched');
});

test('[secondary_model] force is the user\'s choice: nothing is written, and the hub is told', async () => {
  const t = await setup('pool-force');
  await t.provisionAll();
  t.kimi.state.secondary = { force: true, defaultModel: 'other/m' };
  t.kimi.save();
  const before = t.cfg();
  const r = await t.sync(POOL());
  assert.equal(r.ok, true);
  assert.equal(r.data.skipped, 'force');
  assert.equal(r.data.pool, null);
  assert.match(r.data.warning, /force/);
  assert.deepEqual(t.kimi.writes, []);
  assert.equal(t.cfg(), before);
});

test('subagent thinking is set per hub model (default_effort), only for hub models and levels the model has, and again after a provider is replaced', async () => {
  const t = await setup('pool-efforts');
  await t.provisionAll();
  const efforts = { [ALIASES.ds]: 'max', [ALIASES.opus]: 'xhigh', [ALIASES.haiku]: 'xhigh', [ALIASES.ds2]: 'medium', [SUB]: 'high' };
  const r = await t.sync(POOL(), efforts);
  assert.equal(r.ok, true, r.error);
  // haiku has no xhigh, ds2 no medium; the subscription's model is Kimi's to decide.
  assert.deepEqual(r.data.efforts, { [ALIASES.ds]: 'max', [ALIASES.opus]: 'xhigh' });
  assert.equal(t.kimi.state.models[ALIASES.ds].default_effort, 'max');
  assert.equal(t.kimi.state.models[ALIASES.opus].default_effort, 'xhigh');
  assert.equal(t.kimi.state.models[SUB].default_effort, undefined);
  assert.match(t.cfg().split('[models."agent-hub-deepseek/deepseek-v4.1-flash"]')[1].split('\n\n')[0], /default_effort = "max"/);
  // Changing one is one write.
  t.kimi.writes.length = 0;
  const r2 = await t.sync(POOL(), { ...efforts, [ALIASES.ds]: 'low' });
  assert.deepEqual(r2.data.efforts, { [ALIASES.ds]: 'low' });
  // A provider put again loses them (Kimi's replace rewrites the entries): they come back with the next sync.
  await t.ask('kimi.hub.provision', { provider: 'deepseek', gateway: 'opencode-go', apiKey: 'sk-test-key-1234', models: dsModels() });
  assert.equal(t.kimi.state.models[ALIASES.ds].default_effort, undefined);
  const r3 = await t.sync(POOL(), { ...efforts, [ALIASES.ds]: 'low' });
  assert.deepEqual(r3.data.efforts, { [ALIASES.ds]: 'low' });
  // The kinds of thing the hub may set are checked.
  for (const bad of [{ [ALIASES.ds]: 'ludicrous' }, { 'agent-hub-x/../y': 'low' }]) {
    const e = await t.sync(POOL(), bad);
    assert.equal(e.ok, false, JSON.stringify(bad));
  }
  assert.equal((await t.sync(POOL(), { 'other/m': 'high' })).ok, true, 'not a hub model: passed over');
});

test('a pool Kimi turns down is not written: config.toml is put back as it was, and the hub is told', async () => {
  const t = await setup('pool-reject');
  await t.provisionAll();
  const before = t.cfg();
  t.kimi.rejectPool = true;
  const r = await t.sync(POOL());
  assert.equal(r.ok, false);
  assert.match(r.error, /子代理模型沒有設定，已還原/);
  assert.equal(t.cfg(), before);
  assert.equal(t.kimi.state.secondary, undefined);
  // Not remembered as the hub's: a later try is a fresh start.
  t.kimi.rejectPool = false;
  const ok = await t.sync(POOL());
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.merged, false);
});

test('a write that moves something outside the pool is undone', async () => {
  const t = await setup('pool-corrupt');
  await t.provisionAll();
  const before = t.cfg();
  t.kimi.corruptConfig = true;
  const r = await t.sync(POOL());
  assert.equal(r.ok, false);
  assert.match(r.error, /已還原.*預期以外的變動/);
  assert.equal(t.cfg(), before, 'config.toml is as it was');
});

test('if Kimi does not read config.toml again the removal is undone, not half done', async () => {
  const t = await setup('pool-nowatch');
  await t.provisionAll();
  await t.sync(POOL());
  const before = t.cfg();
  t.kimi.watch = false;
  const r = await t.ask('kimi.subagents.sync', { models: { [SUB]: 'Kimi subscription' } }, 60000);
  assert.equal(r.ok, false);
  assert.match(r.error, /沒有重新讀取 config\.toml/);
  assert.equal(t.cfg(), before);
});

test('a pool written in a form the bridge does not understand is never edited by guess', async () => {
  const t = await setup('pool-odd');
  await t.provisionAll();
  await t.sync(POOL());
  // The user turns [secondary_model.models] into an inline table.
  const inline = t.cfg().replace(/\[secondary_model\.models\][\s\S]*?(\n\n|$)/, '') .replace('[secondary_model]', `[secondary_model]\nmodels = { "${SUB}" = "x", "${ALIASES.ds}" = "y" }`);
  fs.writeFileSync(path.join(TMP, 'pool-odd', 'kimi', 'config.toml'), inline);
  t.kimi.state.secondary = { defaultModel: SUB, models: { [SUB]: 'x', [ALIASES.ds]: 'y' } };
  t.kimi.written = inline;
  const r = await t.sync({ [SUB]: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /看不懂/);
  assert.equal(t.cfg(), inline);
});

test('removing a provider takes its models out of the pool first (a pool entry for a model Kimi no longer has is a broken pool)', async () => {
  const t = await setup('pool-drop');
  await t.provisionAll();
  await t.sync(POOL());
  const r = await t.ask('kimi.hub.remove', { provider: 'claude' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.poolRemoved.sort(), [ALIASES.opus, ALIASES.haiku].sort());
  assert.deepEqual(t.poolKeys().sort(), [SUB, ALIASES.ds, ALIASES.ds2].sort());
  const w = t.kimi.writes.filter(([m]) => m === 'DELETE');
  assert.equal(w.length, 1);
  // The last provider: the pool keeps the subscription's model and the default.
  await t.ask('kimi.hub.remove', { provider: 'deepseek' });
  assert.deepEqual(t.poolKeys(), [SUB]);
  // And with no pool of the hub's at all, removing a provider writes no pool.
  const t2 = await setup('pool-drop2');
  await t2.provisionAll();
  const r2 = await t2.ask('kimi.hub.remove', { provider: 'deepseek' });
  assert.equal(r2.data.poolRemoved, undefined);
  assert.equal(t2.kimi.state.secondary, undefined);
});

test('what the hub may put in the pool is checked: aliases, descriptions, levels', async () => {
  const t = await setup('pool-clean');
  await t.provisionAll();
  const cases = [
    [{ primary: 'x' }, /不合法/],
    [{ 'a b': 'x' }, /不合法/],
    [{ ['x'.repeat(161)]: 'x' }, /不合法/],
    [{ [SUB]: 'line\nbreak' }, /說明不合法/],
    [{ [SUB]: 'x'.repeat(401) }, /說明不合法/],
    [{ [SUB]: 5 }, /說明不合法/],
    [Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`m${i}`, 'x'])), /最多 60/],
  ];
  for (const [models, why] of cases) {
    const r = await t.ask('kimi.subagents.sync', { models });
    assert.equal(r.ok, false, JSON.stringify(models).slice(0, 60));
    assert.match(r.error, why);
  }
  for (const models of [null, 'x', ['a']]) assert.equal((await t.ask('kimi.subagents.sync', { models })).ok, false);
  assert.deepEqual(t.kimi.writes, []);
});

test('Kimi\'s global default model, default provider and thinking never move through any of it', async () => {
  const t = await setup('pool-global');
  await t.provisionAll();
  const snap = () => JSON.stringify([t.kimi.state.defaultModel, t.kimi.state.defaultProvider, t.kimi.state.thinking]);
  const s0 = snap();
  await t.sync(POOL(), { [ALIASES.ds]: 'max' });
  await t.sync({ [SUB]: 'x' });
  await t.sync({});
  await t.ask('kimi.hub.remove', { provider: 'claude' });
  assert.equal(snap(), s0);
  assert.ok(!t.kimi.writes.some(([, p]) => p.endsWith(':set_default')), 'no pin was needed');
});
