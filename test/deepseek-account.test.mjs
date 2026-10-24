// The DeepSeek account (server/deepseek-account.js): keys kept and masked,
// the key check against a gateway (a fake one here), the DeepSeek models it
// lists and the one new conversations start on. No network or account needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-deepseek-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const GOOD = 'sk-good-0123456789abcd';
// What each gateway answers at /<gateway>/models, by name.
const answers = {
  // A live list with V4.1 Flash among other vendors' models (the Go list).
  'opencode-go': () => ({ status: 200, body: { object: 'list', data: [{ id: 'kimi-k2' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }, { id: 'DeepSeek-V4-Flash' }, { id: 'qwen3-coder' }] } }),
  // A live list without it (pay-as-you-go).
  opencode: () => ({ status: 200, body: { data: [{ id: 'gpt-5' }, { id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] } }),
  // Refuses with upgrade_required.
  commandcode: () => ({ status: 403, body: { error: { code: 'upgrade_required', message: 'plan' } } }),
};
let gateway;
let asked = [];
let account;

before(async () => {
  gateway = http.createServer((req, res) => {
    const m = req.url.match(/^\/([\w-]+)\/models$/);
    asked.push({ url: req.url, auth: req.headers.authorization });
    if (!m || !answers[m[1]]) return (res.statusCode = 404), res.end('{}');
    if (req.headers.authorization !== `Bearer ${GOOD}`) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    const a = answers[m[1]]();
    res.statusCode = a.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(a.body));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${gateway.address().port}`;
  account = await import('../server/deepseek-account.js');
});

after(() => {
  gateway?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('keys are kept for the hub only: a page sees the last four characters, the file is private', () => {
  assert.equal(account.gateway(), 'opencode-go', 'a key saved without a choice goes to OpenCode Go');
  assert.equal(account.publicAccount().hasKey, false);
  assert.match(account.checkKey(''), /API key/);
  assert.match(account.checkKey('has space'), /空白/);
  assert.match(account.checkKey('line\nbreak'), /空白/);
  assert.match(account.checkKey('x'.repeat(501)), /太長/);
  assert.equal(account.checkKey(GOOD), null);

  account.setKey('opencode-go', GOOD);
  account.setKey('commandcode', 'cmd-key-wxyz');
  const pub = account.publicAccount();
  assert.equal(pub.gateway, 'opencode-go');
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, 'abcd');
  assert.deepEqual(pub.gateways.map((g) => [g.id, g.hasKey, g.keyHint]), [['opencode-go', true, 'abcd'], ['opencode', false, ''], ['commandcode', true, 'wxyz']]);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes(GOOD) && !text.includes('cmd-key'), 'no key in what pages are sent');
  const file = path.join(TMP, 'data', 'deepseek.json');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by this user only');
  assert.ok(fs.readFileSync(file, 'utf8').includes(GOOD));
  assert.throws(() => account.setKey('evil', GOOD), /閘道/);

  account.clearKey('commandcode');
  assert.equal(account.apiKey('commandcode'), '');
  assert.equal(account.apiKey('opencode-go'), GOOD);
});

test('the key check reads the gateway\'s models; only DeepSeek ones are kept', async () => {
  asked = [];
  const r = await account.refreshModels('opencode-go', GOOD);
  assert.equal(r.live, true);
  assert.deepEqual(r.ids, ['deepseek-v4-pro', 'deepseek-v4.1-flash', 'DeepSeek-V4-Flash']);
  assert.deepEqual(asked, [{ url: '/opencode-go/models', auth: `Bearer ${GOOD}` }]);
  // Kept for the gateway: the composer's list is that one.
  const list = account.models('opencode-go');
  assert.equal(list.live, true);
  assert.deepEqual(list.models.map((m) => m.id), r.ids);
  assert.deepEqual(list.models.map((m) => m.name), ['DeepSeek V4 Pro', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Flash']);
});

test('the model new conversations start on: V4.1 Flash when the live list has it, else the first', async () => {
  // Live list with V4.1 Flash (not first in it).
  assert.equal(account.pickDefaultModel(['deepseek-v4-pro', 'deepseek-v4.1-flash']), 'deepseek-v4.1-flash');
  assert.equal(account.pickDefaultModel(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash']), 'deepseek/deepseek-v4.1-flash');
  assert.equal(account.models('opencode-go').defaultModel, 'deepseek-v4.1-flash');

  // Live list without it.
  account.setKey('opencode', GOOD);
  const pay = await account.refreshModels('opencode', GOOD);
  assert.deepEqual(pay.ids, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(account.models('opencode').defaultModel, 'deepseek-v4-flash', 'the first DeepSeek model of the list');
  assert.equal(account.pickDefaultModel([]), '');
  // The -fast and -free variants are not "the" V4.1 Flash.
  assert.equal(account.pickDefaultModel(['deepseek/deepseek-v4.1-flash-fast', 'deepseek/deepseek-v4-pro']), 'deepseek/deepseek-v4.1-flash-fast', 'only when none is exactly V4.1 Flash, the first');
  assert.equal(account.pickDefaultModel(['deepseek-v4.1-flash-free', 'deepseek-v4.1-flash']), 'deepseek-v4.1-flash');

  // The gateway has no list (404): the built-in one, whose V4.1 Flash is the default.
  answers.opencode = () => ({ status: 404, body: { error: 'not found' } });
  const none = await account.refreshModels('opencode', GOOD);
  assert.equal(none.live, false);
  // ...but a list read before still stands.
  assert.match(none.note, /沿用上次/);
  assert.deepEqual(none.ids, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.deepEqual(account.models('opencode').models.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  // Without one: the built-in list, whose V4.1 Flash is the default.
  account.clearKey('opencode');
  const builtin = await account.refreshModels('opencode', GOOD);
  assert.equal(builtin.live, false);
  assert.match(builtin.note, /內建/);
  assert.deepEqual(builtin.ids, ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash-free']);
  assert.equal(account.models('opencode').live, false);
  assert.deepEqual(account.models('opencode').models.map((m) => m.id), builtin.ids);
  assert.equal(account.models('opencode').defaultModel, 'deepseek-v4.1-flash');

  // The gateway cannot be reached at all: the key is not accepted, and what
  // the composer offers is still the built-in list (the first read had failed).
  const real = process.env.AGENT_HUB_DEEPSEEK_TEST_URL;
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  process.env.AGENT_HUB_DEEPSEEK_TEST_URL = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(account.refreshModels('commandcode', GOOD), /連不到閘道/);
  } finally {
    process.env.AGENT_HUB_DEEPSEEK_TEST_URL = real;
  }
  const cc = account.models('commandcode');
  assert.equal(cc.live, false);
  assert.deepEqual(cc.models.map((m) => m.id), ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-fast', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-fast', 'deepseek/deepseek-v4-flash-vision-exp']);
  assert.equal(cc.defaultModel, 'deepseek/deepseek-v4.1-flash');
  // The gateway table: where each is asked, and the models it has.
  assert.deepEqual(Object.keys(account.GATEWAYS), ['opencode-go', 'opencode', 'commandcode']);
  assert.deepEqual(account.GATEWAYS['opencode-go'].models, ['deepseek-v4.1-flash', 'deepseek-v4-pro']);
  assert.equal(account.GATEWAYS['opencode-go'].base, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(account.GATEWAYS['opencode-go'].list, 'https://opencode.ai/inference/go/v1/models');
  assert.equal(account.GATEWAYS.opencode.base, 'https://opencode.ai/inference/openai/v1');
  assert.equal(account.GATEWAYS.opencode.list, 'https://opencode.ai/inference/v1/models');
  assert.equal(account.GATEWAYS.commandcode.list, 'https://api.commandcode.ai/provider/v1/models');
});

test('a refused key says why, in Chinese', async () => {
  await assert.rejects(account.refreshModels('opencode-go', 'wrong-key'), (e) => /金鑰無效/.test(e.message) && e.code === 'bad_key');
  await assert.rejects(account.refreshModels('commandcode', GOOD), (e) => e.message === 'Command Code 的 Go 方案不含 API 存取，請升級到 GOAT/Pro/Max 等含 API 的方案');
  // A 403 for another reason is not that message.
  assert.match(account.explain('opencode', { status: 403, body: 'nope' }), /沒有權限/);
  assert.match(account.explain('opencode', { err: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }), /連不到閘道.*ENOTFOUND/);
  assert.match(account.explain('opencode', { err: Object.assign(new Error('t'), { name: 'TimeoutError' }) }), /連不到閘道.*15 秒/);
});

test('settings: defaults per gateway, the gateway in use, and a model from another gateway is not kept', () => {
  account.setSettings({ gateway: 'opencode-go' });
  assert.deepEqual(account.settings().defaults, { model: 'deepseek-v4.1-flash', effort: 'max', permission: 'manual', planMode: false });
  account.setSettings({ defaults: { model: 'deepseek-v4-pro', effort: 'high', permission: 'yolo', planMode: true } });
  assert.deepEqual(account.settings().defaults, { model: 'deepseek-v4-pro', effort: 'high', permission: 'yolo', planMode: true });
  // Garbage is ignored.
  account.setSettings({ defaults: { effort: 'medium', permission: 'root' } });
  assert.equal(account.settings().defaults.effort, 'high');
  assert.equal(account.settings().defaults.permission, 'yolo');
  account.setSettings({ defaults: { effort: 'low' } });
  assert.equal(account.settings().defaults.effort, 'low');
  account.setSettings({ defaults: { effort: 'high' } });
  // On a gateway that does not have that model, the gateway's own default.
  account.setSettings({ defaults: { model: 'deepseek-v4.1-flash' } });
  assert.equal(account.settings().defaults.model, 'deepseek-v4.1-flash');
  account.setSettings({ gateway: 'commandcode' });
  assert.equal(account.settings().defaults.model, 'deepseek/deepseek-v4.1-flash');
  assert.throws(() => account.setSettings({ gateway: 'x' }), /閘道/);
  account.setSettings({ gateway: 'opencode-go' });
});

test('every DeepSeek model gets a 1M window, 384k output, always-thinking, low, high and max', () => {
  const m = account.kimiModel('deepseek/deepseek-v4.1-flash');
  assert.deepEqual(m, {
    model: 'deepseek/deepseek-v4.1-flash',
    display_name: 'DeepSeek V4.1 Flash',
    max_context_size: 1_000_000,
    max_output_size: 384_000,
    capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'],
    support_efforts: ['low', 'high', 'max'],
  });
  // Images: V4.1 Flash and the vision ones, not V4 Pro or plain V4 Flash.
  const caps = (id) => account.kimiModel(id).capabilities;
  assert.ok(caps('deepseek-v4.1-flash-free').includes('image_in'));
  assert.ok(caps('deepseek/deepseek-v4-flash-vision-exp').includes('image_in'));
  assert.deepEqual(caps('deepseek-v4-pro'), ['thinking', 'always_thinking', 'tool_use']);
  assert.deepEqual(caps('deepseek/deepseek-v4-flash-fast'), ['thinking', 'always_thinking', 'tool_use']);
  const info = account.models('opencode-go').models[0];
  assert.deepEqual([info.efforts, info.defaultEffort, info.context, info.deepseek], [['low', 'high', 'max'], 'max', 1_000_000, true]);
  assert.equal(account.displayName('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(account.displayName('deepseek/deepseek-v4-flash'), 'DeepSeek V4 Flash');
  assert.equal(account.displayName('deepseek-v4.1-flash-free'), 'DeepSeek V4.1 Flash Free');
  assert.equal(account.displayName('deepseek/deepseek-v4.1-flash-fast'), 'DeepSeek V4.1 Flash Fast');
});

// Giving Kimi the provider (once per computer, gateway, key and model list)
// and the pool of subagent models is test/providers.test.mjs.

test('which conversations are DeepSeek ones; a computer\'s [secondary_model]', async () => {
  assert.equal(account.isDeepseek({ mode: 'deepseek' }), true);
  assert.equal(account.isDeepseek({ meta: { model: 'agent-hub-deepseek/deepseek-v4-pro' } }), true);
  assert.equal(account.isDeepseek({ meta: { model: 'managed:kimi-code/kimi-for-coding' } }), false);
  assert.equal(account.isDeepseek({}), false);
  assert.equal(account.aliasFor('deepseek/x'), 'agent-hub-deepseek/deepseek/x');

  assert.equal(account.secondaryOf({}), null);
  assert.deepEqual(account.secondaryOf({ secondary_model: { defaultModel: 'managed:kimi-code/kimi-for-coding', force: true } }), { model: 'managed:kimi-code/kimi-for-coding', models: [], force: true });
  assert.deepEqual(account.secondaryOf({ secondary_model: { models: { 'a/b': 'x', 'c/d': '' }, default_model: 'c/d' } }), { model: 'c/d', models: ['a/b', 'c/d'], force: false });
  const list = await account.secondaryModels({
    list: () => [{ id: 'a', name: 'A', online: true, kimi: { server: true } }, { id: 'b', name: 'B', online: true, kimi: { server: true } }, { id: 'c', name: 'C', online: false, kimi: { server: true } }],
    rpc: async (id) => ({ data: id === 'a' ? { secondary_model: { model: 'kimi/k2' } } : {} }),
  });
  assert.deepEqual(list, [{ machineId: 'a', machineName: 'A', model: 'kimi/k2', models: [], force: false }]);
});
