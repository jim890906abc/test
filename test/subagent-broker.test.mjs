import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-broker-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
let store;
let broker;

before(async () => {
  store = await import('../server/store.js');
  broker = await import('../server/subagent-broker.js');
});
after(async () => {
  store.flushAll();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('delegation tokens are random, scoped to one node/native session/machine and expire', () => {
  const s = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_t', provider: 'kimi' });
  s.meta = { subagent: { provider: 'deepseek', model: 'agent-hub-deepseek/x', effort: 'max' } };
  const token = broker.issueToken(s, { ttlMs: 1000 });
  assert.match(token, /^hb_[0-9a-f]{48}$/);
  assert.equal(broker.validateToken(token, { hubSessionId: s.id, machineId: 'm1', kimiSessionId: 'session_t' }).hubSessionId, s.id);
  assert.throws(() => broker.validateToken(token, { machineId: 'm2' }), /不屬於這台電腦/);
  assert.throws(() => broker.validateToken(token, { kimiSessionId: 'other' }), /不屬於這個 Kimi/);
  return new Promise((resolve) => setTimeout(() => {
    assert.throws(() => broker.validateToken(token), /無效或已過期/);
    resolve();
  }, 1100));
});

test('a PreToolUse hook only redirects native Agent/AgentSwarm for a non-DeepSeek broker choice', async () => {
  const s = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_hook', provider: 'kimi' });
  s.meta = { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'on' } };
  const deny = await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_hook', toolName: 'Agent' } });
  assert.equal(deny.deny, true);
  assert.match(deny.reason, /MCP tool/);
  assert.equal((await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_hook', toolName: 'AgentSwarm' } })).deny, true);
  const plain = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_plain', provider: 'kimi' });
  assert.equal((await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_plain', toolName: 'Agent' } })).deny, false);
  assert.equal((await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_hook', toolName: 'Bash' } })).deny, false);
  assert.equal(plain.meta, undefined);
});

test('the DeepSeek default is the native Agent/AgentSwarm path: the hook lets it run, with no broker token', async () => {
  const s = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_native', provider: 'kimi' });
  s.meta = { subagent: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' } };
  for (const toolName of ['Agent', 'AgentSwarm', 'agent', 'agent_swarm']) {
    assert.deepEqual(await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_native', toolName } }), { deny: false });
  }
  // A cross-provider choice on the same conversation is still the broker.
  s.meta = { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
  const deny = await broker.handleBridgeRequest('m1', { kind: 'hook', args: { sessionId: 'session_native', toolName: 'Agent' } });
  assert.equal(deny.deny, true);
  assert.match(deny.reason, /mcp__agent-hub__delegate_to_provider/);
});
