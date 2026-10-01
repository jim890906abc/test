// The OpenAI-compatible adapter against a local fake /chat/completions
// endpoint: streamed text, a streamed tool call executed in the workspace
// (after approval), and the tool result fed back to the model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-openai-'));
const PORT = 20000 + Math.floor(Math.random() * 2000);
let fake;
let fakePort;
let server;
const requests = [];

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...c }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, body: j });
      const last = j.messages.at(-1);
      if (last.role === 'user') {
        const args = JSON.stringify({ path: 'hi.txt', content: 'hello from fake model\n' });
        sse(res, [
          { delta: { role: 'assistant', content: '我來建立檔案。' } },
          { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: args.slice(0, 10) } }] } },
          { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] } },
          { delta: {}, finish_reason: 'tool_calls' },
        ]);
      } else {
        sse(res, [{ delta: { content: `工具回傳：${last.content}` } }, { delta: {}, finish_reason: 'stop' }]);
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
});

after(() => {
  server.kill('SIGTERM');
  fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
};

test('OpenAI-compatible agent: streaming, tool call with approval, tool result round-trip', async () => {
  const a = await api('POST', '/agents', { type: 'openai', name: 'Fake API', baseUrl: `http://127.0.0.1:${fakePort}/v1`, model: 'fake-1', apiKey: 'sk-test' });
  assert.equal(a.available, true);
  const s = await api('POST', '/sessions', { agentId: a.id, prompt: '建立 hi.txt', permissionMode: 'ask' });
  const ev = await until(async () => (await api('GET', `/sessions/${s.id}`)).events.find((e) => e.permission && !e.permission.chosen));
  assert.equal(ev.name, 'write_file');
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'allow' });
  const snap = await until(async () => {
    const x = await api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && x;
  });
  const texts = snap.events.filter((e) => e.type === 'text').map((e) => e.text);
  assert.deepEqual(texts, ['我來建立檔案。', '工具回傳：Created hi.txt (2 lines)']);
  assert.equal(fs.readFileSync(path.join(snap.cwd, 'hi.txt'), 'utf8'), 'hello from fake model\n');
  assert.equal(requests[0].auth, 'Bearer sk-test');
  assert.equal(requests[0].body.tools.length >= 6, true);
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'call_1');
});
