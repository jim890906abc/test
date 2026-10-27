// The Hub's public DeepSeek projection carries the ACTUAL [secondary_model]
// each computer's bridge reported (model, force, effort), not the Hub's wish.
// A temp data directory, a fake bridge RPC, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ds-secondary-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const DS = 'agent-hub-deepseek';
const ALIAS = `${DS}/deepseek-v4.1-flash`;
let account;

before(async () => {
  account = await import('../server/deepseek-account.js');
});

after(() => setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300));

test('secondaryOf keeps the actual effort when Kimi has one', () => {
  assert.deepEqual(account.secondaryOf({ secondary_model: { default_model: ALIAS, default_effort: 'max' } }), { model: ALIAS, models: [], force: false, effort: 'max' });
  // A camelCase answer (Kimi's config API) reads the same way.
  assert.deepEqual(account.secondaryOf({ secondary_model: { defaultModel: ALIAS, defaultEffort: 'high', models: { [ALIAS]: 'x' }, force: true } }), { model: ALIAS, models: [ALIAS], force: true, effort: 'high' });
  assert.deepEqual(account.secondaryOf({ secondary_model: { default_model: ALIAS } }), { model: ALIAS, models: [], force: false });
});

test('publicAccount projects the bridge-reported secondary with its real effort', async () => {
  account.setKey('opencode-go', 'sk-secondary-test-1234');
  const rpc = async (machineId, op, args) => {
    assert.equal(op, 'kimi.deepseek.provision');
    return {
      ok: true,
      models: args.models.map((m) => `${DS}/${m.model}`),
      ...(machineId === 'm1' ? { secondaryModel: { model: ALIAS, models: [], force: false, effort: 'max' } } : {}),
    };
  };
  await account.ensureProvider('m1', { rpc });
  await account.ensureProvider('m2', { rpc });
  const pub = account.publicAccount();
  assert.deepEqual(pub.secondaryModels, [{ machineId: 'm1', machineName: 'm1', model: ALIAS, models: [], force: false, effort: 'max' }]);
  // A cached answer does not lose the projection.
  assert.equal((await account.ensureProvider('m1', { rpc })).cached, true);
  assert.deepEqual(account.publicAccount().secondaryModels.map((x) => x.model), [ALIAS]);
});

test('removing the provider drops the projected secondary too', async () => {
  await account.removeProviders({ rpc: async () => ({ ok: true }) });
  assert.deepEqual(account.publicAccount().secondaryModels, []);
});
