// One key for each conversation against the REAL stack: the Hub, the connector
// with its DeepSeek key proxy, and the real Kimi Code CLI (`kimi web`) talking to
// a scripted fake gateway on loopback. The thing this checks is the claim the
// whole feature stands on: the requests of a conversation's main agent AND of its
// native subagent reach the connector with the same `prompt_cache_key`, so the
// proxy can keep them on one key. Nothing here is told which key to use; the
// expected split is read off what the gateway itself saw (its Authorization
// header and the session id in each body).
//
// Skipped (out loud, with the reason; REQUIRE_KIMI=1 makes it a failure) unless
// the kimi CLI is available (KIMI_BIN or `kimi` on PATH). No account or network
// is needed; run where nothing can leave the machine
// (`unshare -rn sh -c 'ip link set lo up && exec node --test ...'`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-deepseek-sticky-kimi');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-sticky-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 32000 + Math.floor(Math.random() * 2000);
const KIMI_PORT = 34000 + Math.floor(Math.random() * 2000);
const TOKEN = 'e2e-sticky-token';
const KEY_1 = 'sk-e2e-sticky-key-AAAA-0001';
const KEY_2 = 'sk-e2e-sticky-key-BBBB-0002';
const procs = [];
let fake;
let machineId;
const calls = []; // every chat completion the fake gateway answered: { session, key, sub }

function startFakeGateway() {
  const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (/\/models$/.test(req.url)) return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-pro' }] }));
      const j = JSON.parse(raw || '{}');
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const users = msgs.filter((m) => m.role === 'user').map((m) => str(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const sub = users.some((u) => u.includes('SUBAGENT_TASK'));
      calls.push({ session: j.prompt_cache_key || null, key, sub, stream: Boolean(j.stream) });
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const lastUser = users.at(-1) || '';
      const prevCall = msgs.at(-2)?.tool_calls?.[0]?.function?.name;
      const send = (chunks) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) {
            res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 } })}\n\n`);
            return res.end('data: [DONE]\n\n');
          }
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunks[i++] }] })}\n\n`);
          setTimeout(tick, 60);
        };
        setTimeout(tick, 100);
      };
      const text = (t) => [{ delta: { role: 'assistant', content: t } }, { delta: {}, finish_reason: 'stop' }];
      const call = (pre, name, args) => [
        { delta: { role: 'assistant', content: pre } },
        { delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ];
      if (sub) return send(last.role === 'tool' ? text('子代理結論：專案裡有檔案。') : call('子代理：先看看檔案。', 'Bash', { command: 'ls' }));
      if (last.role === 'tool') return send(text(prevCall === 'Agent' ? '子代理回報完成。' : '做完了。'));
      if (lastUser.includes('子代理')) return send(call('我派一個子代理去看。', 'Agent', { description: '檢查專案檔案', prompt: 'SUBAGENT_TASK：列出專案檔案' }));
      return send(text('收到。'));
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

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  await startFakeGateway();
  const gw = `http://127.0.0.1:${fake.address().port}`;
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME, HOME }, /Kimi server ready/);
  const kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  const kimiApi = (method, p, body) => fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `${gw}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  await run(process.execPath, ['server/index.js'], { PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: gw }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'e2e-machine', '--kimi-bin', KIMI, '--no-broker', '--no-skill'], { KIMI_CODE_HOME: KIMI_HOME, HOME, AGENT_HUB_DEEPSEEK_TEST_URL: gw }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server), 15000, 'machine online');
  machineId = m.id;
  await api('PUT', '/deepseek', { gateway: 'opencode-go', apiKey: KEY_1 });
  await api('PUT', '/deepseek', { apiKey: KEY_2 });
  await until(async () => {
    const x = (await api('GET', '/machines')).find((y) => y.id === machineId);
    return x.provision?.ok && x.capabilities.includes('pool_sticky');
  }, 30000, 'the connector provisioned with both keys');
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

const idle = async (id) =>
  until(async () => {
    const x = await api('GET', `/sessions/${id}`);
    return x.status === 'idle' && x.events.some((e) => e.type === 'turn_end') && x;
  }, 90000, 'the turn to end');

test('real Kimi: the main agent and its native subagent send the same session id, so each conversation stays on one key and four conversations split two and two', { skip: SKIP }, async () => {
  const names = ['甲', '乙', '丙', '丁'];
  const made = await Promise.all(names.map((n) => api('POST', '/sessions', { provider: 'deepseek', machineId, cwd: PROJECT, prompt: `${n}：請派一個子代理去看專案檔案`, model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' })));
  await Promise.all(made.map((s) => idle(s.id)));
  const kids = await Promise.all(made.map(async (s) => (await api('GET', `/sessions/${s.id}`)).kimiSessionId));
  assert.ok(kids.every(Boolean), 'each conversation has its Kimi session');
  assert.equal(new Set(kids).size, 4);

  const keyName = (auth) => (auth === KEY_1 ? 'one' : auth === KEY_2 ? 'two' : auth);
  const per = kids.map((kid) => {
    const mine = calls.filter((c) => c.session === kid);
    return { kid, main: mine.filter((c) => !c.sub), sub: mine.filter((c) => c.sub), keys: new Set(mine.map((c) => keyName(c.key))) };
  });
  for (const p of per) {
    assert.ok(p.main.length >= 2, `${p.kid}: the main agent asked at least twice (the call, then the answer): ${p.main.length}`);
    assert.ok(p.sub.length >= 2, `${p.kid}: its subagent really asked through the proxy with the SAME session id: ${p.sub.length}`);
    assert.equal(p.keys.size, 1, `${p.kid}: main agent and subagent on one key, saw ${[...p.keys]}`);
  }
  // The gateway never saw the proxy's local token, and no request came without the conversation's id.
  assert.ok(calls.every((c) => c.key === KEY_1 || c.key === KEY_2), 'only upstream keys reached the gateway');
  const own = calls.filter((c) => c.stream);
  assert.ok(own.every((c) => c.session), 'every streamed request names its conversation');
  // Four conversations, two keys: two each.
  const split = per.reduce((n, p) => ((n[[...p.keys][0]] = (n[[...p.keys][0]] || 0) + 1), n), {});
  assert.deepEqual(split, { one: 2, two: 2 }, JSON.stringify(split));

  // The Hub is told: per-key counts, and each conversation's own key.
  const acc = await until(async () => {
    const a = await api('GET', '/deepseek');
    return a.rotation.keys.every((k) => k.sessions === 2) && a;
  }, 20000, 'two conversations on each key');
  assert.equal(acc.distribution, 'sticky');
  const hintOf = { one: KEY_1.slice(-4), two: KEY_2.slice(-4) };
  for (const [i, s] of made.entries()) {
    const t = await until(async () => {
      const x = await api('GET', `/sessions/${s.id}/timing`);
      return x.currentKey && x;
    }, 20000, 'the key in the timing');
    assert.equal(t.currentKey.hint, hintOf[[...per[i].keys][0]], `conversation ${i}: the Hub names the key the gateway saw`);
    assert.equal(t.currentKey.distribution, 'sticky');
  }
  assert.ok(!JSON.stringify(acc).includes(KEY_1) && !JSON.stringify(acc).includes(KEY_2), 'no key value in the account');
});
