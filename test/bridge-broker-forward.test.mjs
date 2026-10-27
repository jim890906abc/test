import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ahbf-'));
const STATE = path.join(TMP, 's');
const KIMI_HOME = path.join(TMP, 'k');
let bridge;
let wss;
let client;

after(() => {
  client?.destroy();
  bridge?.kill('SIGTERM');
  wss?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 200);
});

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('bridge broker forwarding timeout');
};

test('the local broker socket preserves background through the Hub request and MCP result', async () => {
  wss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => wss.on('listening', r));
  const calls = [];
  let hello = false;
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'hello') hello = true;
      if (msg.t !== 'bridge.req') return;
      calls.push(msg);
      ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, data: { childSessionId: 's_child', provider: 'kimi', model: 'fake/fake-1', effort: 'high', background: true, status: 'running', text: 'started', error: null } }));
    });
  });
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--state-dir', STATE, '--kimi-home', KIMI_HOME, '--hub', `http://127.0.0.1:${wss.address().port}`, '--key', 'fixture', '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill'], {
    cwd: ROOT,
    env: { ...process.env, HOME: TMP },
    stdio: 'ignore',
  });
  const socket = path.join(STATE, `bridge-${crypto.createHash('sha1').update(KIMI_HOME).digest('hex').slice(0, 10)}.sock`);
  await until(() => hello && fs.existsSync(socket));
  client = net.createConnection(socket);
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  const frames = [];
  client.on('data', (raw) => {
    for (const line of String(raw).split('\n')) if (line.trim()) frames.push(JSON.parse(line));
  });
  client.write(`${JSON.stringify({ t: 'broker', id: 'background-check', token: 'fixture-token', task: 'independent work', background: true })}\n`);
  await until(() => calls.length && frames.some((f) => f.id === 'background-check'));
  const request = calls.find((c) => c.kind === 'broker');
  assert.equal(request.args.background, true);
  assert.equal(request.args.task, 'independent work');
  const reply = frames.find((f) => f.id === 'background-check');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.background, true);
  assert.equal(reply.data.status, 'running');
});
