import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-mcp-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
fs.mkdirSync(KIMI_HOME, { recursive: true });
const procs = [];
after(() => {
  for (const p of procs) p.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
});

function bridge(args) {
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  return { p, out: () => out };
}

test('bridge mcp speaks MCP and exposes the broker tool', async () => {
  const { p, out } = bridge(['mcp', '--kimi-home', KIMI_HOME]);
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const end = Date.now() + 5000;
  while (Date.now() < end && !out().includes('"id":2')) await new Promise((r) => setTimeout(r, 25));
  const lines = out().trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].result.serverInfo.name, 'agent-hub');
  const tool = lines[1].result.tools.find((t) => t.name === 'delegate_to_provider');
  assert.ok(tool);
  assert.match(tool.description, /DeepSeek uses native Agent\/AgentSwarm/);
  assert.match(tool.description, /without it, do not call/);
  assert.doesNotMatch(tool.description, /Use this instead of the native/);
  assert.equal(tool.inputSchema.properties.background.default, false);
  assert.deepEqual(tool.inputSchema.required, ['token', 'task']);
  p.kill('SIGTERM');
});

test('hook without a local bridge allows instead of breaking native Kimi', async () => {
  const { p } = bridge(['hook', '--kimi-home', KIMI_HOME]);
  p.stdin.end(JSON.stringify({ event: 'PreToolUse', session_id: 'session_x', tool_name: 'Agent' }));
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 0);
});
