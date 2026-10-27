import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-default-subagent-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let runner;

before(async () => {
  fs.mkdirSync(process.env.AGENT_HUB_DATA, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_HUB_DATA, 'deepseek.json'), JSON.stringify({
    gateway: 'commandcode', keys: { commandcode: 'test-only-key' },
    models: { commandcode: { ids: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro'] } },
    defaults: { model: 'deepseek/deepseek-v4-pro', effort: 'high' },
  }));
  store = await import('../server/store.js');
  runner = await import('../server/runner.js');
});

after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('old and new conversations default to DeepSeek V4.1 Flash max, independent of their main model', async () => {
  const old = store.createSession({ agentId: 'claude', provider: 'claude', modelConfig: { provider: 'claude', model: 'claude-opus-5-5', effort: 'low' } });
  runner.ensureDefaultSubagent(old);
  assert.deepEqual(old.meta.subagent, { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek/deepseek-v4.1-flash', effort: 'max' });
  assert.equal(old.modelConfig.provider, 'claude');
  assert.equal(old.modelConfig.effort, 'low');

  store.upsertAgent({ id: 'demo', name: 'Demo', type: 'demo', enabled: true });
  const fresh = await runner.newSession({ agentId: 'demo', cwd: TMP });
  assert.deepEqual(fresh.meta.subagent, { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek/deepseek-v4.1-flash', effort: 'max' });
  // This is Kimi's native Agent/AgentSwarm rule (the [secondary_model] the
  // bridge provisions), not a broker-only choice; applying it again is a no-op.
  assert.equal(fresh.meta.subagent.provider, 'deepseek');
  const settled = JSON.stringify(fresh.meta.subagent);
  runner.ensureDefaultSubagent(fresh);
  assert.equal(JSON.stringify(fresh.meta.subagent), settled, 'the default is idempotent');
  assert.equal(fresh.state.nativeSubagentDisabled, undefined, 'nothing disabled the native tools');
});

test('a custom choice and an explicit native rule are not overwritten', async () => {
  const custom = store.createSession({ agentId: 'claude', provider: 'claude', meta: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } } });
  runner.ensureDefaultSubagent(custom);
  assert.deepEqual(custom.meta.subagent, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });

  store.upsertAgent({ id: 'demo', name: 'Demo', type: 'demo', enabled: true });
  const native = await runner.newSession({ agentId: 'demo', cwd: TMP, subagent: null });
  assert.equal(native.meta?.subagent, undefined);
  assert.equal(native.state.subagentExplicit, true);
  runner.ensureDefaultSubagent(native);
  assert.equal(native.meta?.subagent, undefined);
});
