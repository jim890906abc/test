// Timing against the REAL stack: the Hub, the connector with its DeepSeek key
// proxy, and the real Kimi Code CLI (`kimi web`) talking to a scripted fake
// gateway on loopback. The expected numbers do not come from the code under
// test: the turn's length, each step's timing and each tool call's duration are
// read from Kimi's own journal (wire.jsonl), the requests are counted by the
// fake gateway itself, and the conversation each request belongs to is the
// `prompt_cache_key` the gateway saw in the body.
//
// Skipped (out loud, with the reason; REQUIRE_KIMI=1 makes it a failure) unless
// the kimi CLI is available (KIMI_BIN or `kimi` on PATH). No account or network
// is needed; run where nothing can leave the machine if that matters
// (`unshare -rn`, then `ip link set lo up`).
//
//   node --test test/e2e-timing.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-timing');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-timing-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 32000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 34000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-timing-token';
const KEY = 'sk-e2e-timing-key-0001';
const procs = [];
let fake;
let machineId;
const gatewayCalls = []; // { session, auth } of every chat completion the fake gateway answered

// A scripted model. A turn that says "工具" runs one slow Bash command; anything
// else is answered in a sentence. Every answer streams (with small gaps) and
// ends with the usage chunk a real gateway sends.
function startFakeGateway() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (/\/models$/.test(req.url)) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
      }
      const j = JSON.parse(raw || '{}');
      gatewayCalls.push({ session: j.prompt_cache_key || null, auth: req.headers.authorization });
      if (!j.stream) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      }
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs.filter((m) => m.role === 'user').map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const wantsTool = (users.at(-1) || '').includes('工具') && last.role !== 'tool';
      const chunks = wantsTool
        ? [
            { delta: { role: 'assistant', content: '先跑一個慢指令。' } },
            { delta: { tool_calls: [{ index: 0, id: 'call_slow', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 1 && echo slow-done' }) } }] } },
            { delta: {}, finish_reason: 'tool_calls' },
          ]
        : [{ delta: { role: 'assistant', content: '做完了。' } }, { delta: {}, finish_reason: 'stop' }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) {
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 } })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunks[i++] }] })}\n\n`);
        setTimeout(tick, 120);
      };
      setTimeout(tick, 150);
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', r));
}

function run(cmd, args, env, ready) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${cmd} did not become ready:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      if (ready.test(out)) (clearTimeout(t), resolve(p));
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
}

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': TOKEN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// What Kimi wrote to a conversation's journal, as records.
function journal(kimiSessionId) {
  const root = path.join(KIMI_HOME, 'sessions');
  for (const w of fs.readdirSync(root)) {
    const file = path.join(root, w, kimiSessionId, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(file)) continue;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }
  return [];
}

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  await startFakeGateway();
  const gw = `http://127.0.0.1:${fake.address().port}`;
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  // Kimi needs a default model of its own before the Hub will add DeepSeek next to it.
  const kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  const kimiApi = (method, p, body) => fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `${gw}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: gw }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: gw }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 15000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: KEY });
});
after(() => {
  for (const p of procs) p.kill('SIGTERM');
  try {
    for (const f of fs.readdirSync(path.join(KIMI_HOME, 'server', 'instances'))) {
      try {
        process.kill(JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'server', 'instances', f), 'utf8')).pid, 'SIGTERM');
      } catch {}
    }
  } catch {}
  fake?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 500);
});

test('a real DeepSeek conversation: the Hub\'s numbers equal Kimi\'s own journal and the gateway\'s own count', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '請跑一個工具', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await until(async () => {
    const x = await api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && x.events.some((e) => e.type === 'turn_end') && x;
  }, 60000, 'the turn to end');
  const kid = (await api('GET', `/sessions/${s.id}`)).kimiSessionId;
  assert.ok(kid, 'the conversation has its Kimi session');

  // What Kimi measured, from its journal.
  const records = await until(async () => {
    const r = journal(kid);
    return r.some((x) => x.type === 'turn.ended') && r;
  }, 15000, 'the journal');
  const ended = records.filter((r) => r.type === 'turn.ended' && (r.agentId || 'main') === 'main');
  const steps = records.filter((r) => r.type === 'context.append_loop_event' && r.event?.type === 'step.end' && (r.agentId || 'main') === 'main');
  const tools = records.filter((r) => r.type === 'context.append_loop_event' && r.event?.type === 'tool.result' && (r.agentId || 'main') === 'main');
  assert.equal(steps.length, 2, 'a tool call and the answer after it');
  assert.equal(tools.length, 1);
  const wall = ended.reduce((a, r) => a + r.durationMs, 0);
  const model = steps.reduce((a, r) => a + r.event.llmFirstTokenLatencyMs + r.event.llmStreamDurationMs, 0);
  const toolReported = tools[0].event.result.durationMs;
  assert.ok(toolReported >= 1000, `Kimi\'s own duration of the sleep: ${toolReported}`);

  const t = await until(async () => {
    const x = await api('GET', `/sessions/${s.id}/timing`);
    return x.turns === ended.length && x.requests === 2 && x;
  }, 20000, 'the Hub\'s timing');
  assert.equal(t.wallMs, wall, 'the turn\'s length is Kimi\'s durationMs');
  assert.equal(t.modelMs, model, 'the model time is the steps\' own first-token and stream times');
  assert.ok(t.toolMs >= 1000 && t.toolMs <= wall, `tool time ${t.toolMs} holds the 1 s sleep and is inside the turn (${wall})`);
  assert.ok(Math.abs(t.toolMs - toolReported) < 600, `from the call to the result (${t.toolMs}) is close to Kimi\'s own duration of the tool (${toolReported})`);
  assert.equal(t.compactMs, 0);
  assert.equal(t.rateLimitWaitMs, 0);
  assert.deepEqual(t.subagents, { spawned: 0, requeuedForRateLimit: 0 });
  assert.equal(t.http429, 0);
  // The requests the proxy sent for this conversation are the ones the gateway saw with its session id.
  const seen = gatewayCalls.filter((c) => c.session === kid);
  assert.equal(seen.length, 2);
  assert.equal(t.requests, seen.length, 'counted by the proxy, equal to what the gateway received');
  assert.deepEqual(t.unmeasured, [], JSON.stringify(t.unmeasured));
  assert.ok(t.since > 0 && t.requestsSince > 0);

  // The key's own numbers, from the same records.
  const keys = await api('GET', '/deepseek/keys/timing');
  const k = keys.keys[0];
  assert.equal(k.requests, gatewayCalls.length, 'every request that reached the gateway is the key\'s');
  assert.ok(k.peakConcurrent >= 1);
  assert.ok(k.firstByteMs.p50 >= 100, `the gateway waited 150 ms before its first byte: ${JSON.stringify(k.firstByteMs)}`);
  assert.ok(k.tokensPerSecond > 0, 'the stream ended with usage');
  assert.ok(!JSON.stringify(keys).includes(KEY), 'no key value');
});

test('a conversation on the same gateway but another turn adds its own requests, not the first one\'s', { skip: SKIP }, async () => {
  const s = await api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: '聊天', model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' });
  await until(async () => {
    const x = await api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && x.events.some((e) => e.type === 'turn_end') && x;
  }, 60000, 'the turn to end');
  const kid = (await api('GET', `/sessions/${s.id}`)).kimiSessionId;
  const t = await until(async () => {
    const x = await api('GET', `/sessions/${s.id}/timing`);
    return x.requests === 1 && x;
  }, 20000, 'the Hub\'s timing');
  assert.equal(gatewayCalls.filter((c) => c.session === kid).length, 1);
  assert.equal(t.turns, 1);
  assert.equal(t.toolMs, 0, 'no tool call in this turn');
});
