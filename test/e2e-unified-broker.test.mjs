// Real 3×3 subagent execution: a real Kimi CLI and Claude daemon, a real Hub
// and bridge, with only the model HTTP endpoints faked locally. No account or
// external network is used. The MCP path is exercised for Kimi/DeepSeek, and
// the daemon broker path for Claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeClaude } from './fixtures/fake-anthropic.mjs';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { KIMI, SKIP } = kimiGate('e2e-unified-broker');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-unified-broker-'));
const KIMI_HOME = path.join(TMP, 'kimi-home');
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');
const HUB_PORT = 28000 + Math.floor(Math.random() * 1500);
const KIMI_PORT = 26000 + Math.floor(Math.random() * 1500);
const TOKEN = 'unified-broker-token';
const CLAUDE_KEY = `sk-ant-api03-${'u'.repeat(40)}-test`;
const DS_KEY = 'unified-ds-test-key';
const procs = [];
const seen = [];
let fake;
let claude;
let machineId;
let kimiToken;

const textOf = (content) => (typeof content === 'string' ? content : (content || []).map((p) => p.text || '').join(''));
const lastUserText = (body) => {
  const users = (body?.messages || []).filter((m) => m.role === 'user').map((m) => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
  return users.at(-1) || '';
};
function startFakeModel() {
  const text = (value) => [{ delta: { role: 'assistant', content: value } }, { delta: {}, finish_reason: 'stop' }];
  const call = (name, args) => [
    { delta: { role: 'assistant', content: '使用 Agent Hub 子代理。' } },
    { delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 9)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
    { delta: {}, finish_reason: 'tool_calls' },
  ];
  const send = (res, chunks) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) return res.end('data: [DONE]\n\n');
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunks[i++] }] })}\n\n`);
      setTimeout(tick, 1);
    };
    tick();
  };
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        const ds = req.url.startsWith('/opencode-go');
        return res.end(JSON.stringify({ data: (ds ? ['deepseek-v4.1-flash'] : ['fake-1', 'kimi-k3']).map((id) => ({ id })) }));
      }
      const j = JSON.parse(raw || '{}');
      seen.push({ url: req.url, body: j });
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const messages = j.messages || [];
      const last = messages.at(-1) || {};
      const users = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean);
      const lastUser = users.at(-1) || '';
      if (lastUser.includes('NATIVE_TASK')) return send(res, last.role === 'tool' ? text('NATIVE_CHILD_OK') : call('Bash', { command: 'echo native-child' }));
      if (last.role === 'tool') return send(res, text(lastUser.includes('NATIVE_DELEGATE') ? 'main native delegation finished' : 'main MCP delegation finished'));
      if (lastUser.includes('NATIVE_DELEGATE') && last.role !== 'tool') return send(res, call('Agent', { description: '原生子代理', prompt: 'NATIVE_TASK' }));
      if (lastUser.includes('長工作') && last.role !== 'tool') return send(res, call('Bash', { command: 'sleep 6 && echo long-done' }));
      if (lastUser.includes('MCP_DELEGATE')) {
        const all = JSON.stringify(messages);
        const token = all.match(/token\s+\\?"(hb_[0-9a-f]+)\\?"/)?.[1];
        if (!token) return send(res, text('missing delegation token'));
        return send(res, call('mcp__agent-hub__delegate_to_provider', { task: 'MCP_TASK', token }));
      }
      if (lastUser.includes('MCP_TASK')) return send(res, text('MCP child completed'));
      return send(res, text('ordinary model answer'));
    });
  });
  return new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
}

function run(cmd, args, env, ready) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} did not become ready:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      if (ready.test(out)) {
        clearTimeout(timer);
        resolve(p);
      }
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
const kimiApi = async (method, p, body) => {
  try {
    kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  } catch {}
  const r = await fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${kimiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.data;
};
async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const session = (id) => api('GET', `/sessions/${id}`);
const idle = async (id) => {
  try {
    return await until(async () => (await session(id)).status === 'idle' && session(id), 45000, `idle ${id}`);
  } catch (err) {
    const s = await session(id);
    throw new Error(`${err.message}\n${JSON.stringify(s.events.slice(-8))}`);
  }
};

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  await startFakeModel();
  claude = await startFakeClaude(CLAUDE_KEY);
  await run(KIMI, ['web', '--no-open', '--port', String(KIMI_PORT)], { KIMI_CODE_HOME: KIMI_HOME }, /Kimi server ready/);
  kimiToken = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  const models = ['fake-1', 'kimi-k3'].map((model) => ({ model, max_context_size: 128000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'], default_effort: 'high' }));
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  const data = path.join(TMP, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'deepseek.json'), JSON.stringify({ gateway: 'opencode-go', keys: { 'opencode-go': DS_KEY }, defaults: { model: 'deepseek-v4.1-flash', effort: 'max', permission: 'auto' } }));
  await run(process.execPath, ['server/index.js'], {
    PORT: String(HUB_PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'),
    AGENT_HUB_CLAUDE_TEST_URL: claude.url, ANTHROPIC_API_KEY: CLAUDE_KEY,
    AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}`,
  }, /已啟動/);
  const key = JSON.parse(fs.readFileSync(path.join(data, 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'unified-broker-machine', '--kimi-bin', KIMI], {
    KIMI_CODE_HOME: KIMI_HOME, HOME,
    AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}`,
    AGENT_HUB_CLAUDE_TEST_URL: claude.url, ANTHROPIC_API_KEY: CLAUDE_KEY,
  }, /已連上中控台/);
  const m = await until(async () => (await api('GET', '/machines')).find((x) => x.online && x.kimi.server && x.broker >= 1), 20000, 'machine and broker online');
  machineId = m.id;
  // The saved key plus bridge hello must provision native subagents by itself;
  // no warm-up DeepSeek parent conversation is allowed here.
  const secondary = await until(async () => {
    const cfg = await kimiApi('GET', '/config');
    const s = cfg?.secondary_model || cfg?.secondaryModel;
    if (!s) return null;
    return { model: s.default_model ?? s.defaultModel ?? s.model, effort: s.default_effort ?? s.defaultEffort, force: (s.force ?? false) === true };
  }, 20000, 'Kimi [secondary_model]');
  assert.deepEqual(secondary, { model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max', force: false });
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
  for (const dir of [path.join(TMP, 'data', 'claude-daemon'), path.join(HOME, '.agent-hub', 'claude'), path.join(TMP, 'busy-kimi-home', '.agent-hub', 'claude')]) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
      process.kill(info.pid, 'SIGTERM');
    } catch {}
  }
  fake?.close();
  claude?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 500);
});

const targets = {
  kimi: { provider: 'kimi', model: 'fake/kimi-k3', effort: 'high', wireModel: 'kimi-k3', wirePath: '/v1/chat/completions' },
  claude: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', wireModel: 'claude-opus-5-5', wirePath: '/v1/messages' },
  deepseek: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max', wireModel: 'deepseek-v4.1-flash', wirePath: '/opencode-go/chat/completions' },
};
const mains = {
  kimi: { provider: 'kimi', model: 'fake/fake-1', effort: 'low', prompt: 'MCP_DELEGATE', wireModel: 'fake-1' },
  claude: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', prompt: 'TASKBROKERAUTO', wireModel: 'claude-sonnet-5-5' },
  deepseek: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'low', prompt: 'MCP_DELEGATE', wireModel: 'deepseek-v4.1-flash' },
};

async function verifyBroker(mainProvider, targetProvider, mid = machineId, override = {}) {
  const main = mains[mainProvider];
  const target = { ...targets[targetProvider], ...override };
  // Only requests made by this run count: the same task text was sent by the
  // run before it, with another effort.
  const sinceFake = seen.length;
  const sinceClaude = claude.requests.length;
  const created = await api('POST', '/sessions', {
    provider: mainProvider, machineId: mid, cwd: PROJECT, prompt: main.prompt, permission: 'auto',
    model: main.model, effort: main.effort,
    subagent: { provider: target.provider, model: target.model, effort: target.effort },
  });
  const done = await (async () => {
    let last = null;
    try {
      return await until(async () => {
        const x = await session(created.id);
        last = x;
        const card = x.events.find((e) => e.childSessionId || e.subagent?.childSessionId || e.subagent?.id);
        return x.status === 'idle' && card?.subagent?.status === 'done' && x;
      }, 20000);
    } catch (err) {
      throw new Error(`${err.message} for ${mainProvider}→${targetProvider}\nevents=${JSON.stringify(last?.events?.slice(-10))}`);
    }
  })();
  assert.equal(done.status, 'idle', JSON.stringify(done.events.at(-3)));
  const card = done.events.find((e) => e.childSessionId || e.subagent?.childSessionId || e.subagent?.id);
  assert.ok(card, `no subagent card for ${mainProvider}→${targetProvider}: ${JSON.stringify(done.events)}`);
  const childId = card.childSessionId || card.subagent.childSessionId || card.subagent.id;
  assert.equal(card.subagent.provider, target.provider);
  assert.equal(card.subagent.model, target.model);
  assert.equal(card.subagent.effort, target.effort);
  assert.equal(card.subagent.status, 'done', `${mainProvider}→${targetProvider}: ${JSON.stringify({ cardStatus: card.status, output: card.output, subagent: card.subagent })}`);
  if (mainProvider === 'claude' && targetProvider === 'claude' && !card.childSessionId && !card.subagent.childSessionId) {
    assert.ok(card.subagent.id, 'native Claude subagent id is missing');
  } else {
    const child = await session(childId);
    assert.equal(child.parentId, created.id);
    assert.equal(child.provider, target.provider);
    assert.deepEqual(child.modelConfig, { provider: target.provider, model: target.model, effort: target.effort });
    assert.equal(child.status, 'idle');
  }

  const task = mainProvider === 'claude' ? 'find the configured provider' : 'MCP_TASK';
  if (targetProvider === 'claude') {
    const request = claude.requests.slice(sinceClaude).find((r) => r.url === target.wirePath && r.body?.model === target.wireModel && lastUserText(r.body) === task);
    assert.ok(request, `no real Claude request for ${mainProvider}→${targetProvider}`);
    assert.equal(request.body.output_config?.effort, target.effort);
  } else {
    const request = seen.slice(sinceFake).find((r) => r.url === target.wirePath && r.body?.model === target.wireModel && lastUserText(r.body) === task);
    assert.ok(request, `no real ${targetProvider} request for ${mainProvider}→${targetProvider}: ${seen.map((r) => `${r.url}:${r.body?.model}`).join(', ')}`);
    assert.equal(request.body.reasoning_effort, target.effort);
  }
  return { parent: created.id, child: childId };
}

// Kimi/DeepSeek main × DeepSeek subagent is Kimi's own Agent/AgentSwarm on
// the provisioned [secondary_model]: there is no Hub child session and no MCP
// token. Prove the real native run: the spawned id, the model and effort on
// the card, the subagent's own tool process/result, and the DeepSeek request
// itself (model and reasoning_effort), not just the stored setting.
async function verifyNative(mainProvider, targetProvider, mid = machineId) {
  const main = mains[mainProvider];
  const target = targets[targetProvider];
  const created = await api('POST', '/sessions', {
    provider: mainProvider, machineId: mid, cwd: PROJECT, prompt: 'NATIVE_DELEGATE', permission: 'auto',
    model: main.model, effort: main.effort,
    subagent: { provider: target.provider, model: target.model, effort: target.effort },
  });
  const done = await (async () => {
    let last = null;
    try {
      return await until(async () => {
        const x = await session(created.id);
        last = x;
        const card = x.events.find((e) => e.type === 'tool_use' && e.name === 'Agent' && e.subagent?.status === 'done');
        return x.status === 'idle' && card && x;
      }, 30000);
    } catch (err) {
      const recent = seen.slice(-8).map((r) => `${r.url}:${r.body?.model}:${lastUserText(r.body).slice(0, 30)}`).join(' | ');
      throw new Error(`${err.message} for ${mainProvider}→${targetProvider}\nevents=${JSON.stringify(last?.events?.slice(-10))}\nrequests=${recent}`);
    }
  })();
  const card = done.events.find((e) => e.type === 'tool_use' && e.name === 'Agent' && e.subagent?.status === 'done');
  assert.ok(card, `no native Agent card for ${mainProvider}→${targetProvider}: ${JSON.stringify(done.events.slice(-8))}`);
  assert.ok(card.subagent.id, 'a real native subagent id is missing');
  assert.equal(card.subagent.model, target.model);
  assert.equal(card.subagent.effort, target.effort);
  assert.ok(!card.subagent.broker, 'the native path must not be a Hub broker child');
  assert.equal(card.childSessionId, undefined, 'a native subagent has no Hub child session');
  assert.equal(card.subagent.childSessionId, undefined);
  assert.ok(!done.events.some((e) => /delegate_to_provider/.test(e.name || '')), 'the MCP broker tool was not used');
  const nested = done.events.find((e) => e.type === 'tool_use' && e.parent === card.id && e.name === 'Bash');
  assert.ok(nested, `the subagent's own tool run is missing: ${JSON.stringify(done.events.slice(-8))}`);
  assert.match(nested.output, /native-child/);
  assert.match(card.subagent.summary || '', /NATIVE_CHILD_OK/);

  const mainPath = mainProvider === 'deepseek' ? targets.deepseek.wirePath : '/v1/chat/completions';
  const promptReq = seen.find((r) => r.url === mainPath && r.body?.model === main.wireModel && lastUserText(r.body) === 'NATIVE_DELEGATE');
  assert.ok(promptReq, `no main request for ${mainProvider}→${targetProvider}`);
  assert.doesNotMatch(JSON.stringify(promptReq.body.messages), /hb_[0-9a-f]{48}|delegate_to_provider|不要使用原生 Agent/);
  const childReq = seen.find((r) => r.url === target.wirePath && r.body?.model === target.wireModel && lastUserText(r.body) === 'NATIVE_TASK');
  assert.ok(childReq, `no real DeepSeek subagent request for ${mainProvider}→${targetProvider}`);
  assert.equal(childReq.body.reasoning_effort, target.effort);
  return { parent: created.id, card };
}

// A DeepSeek target is native for Kimi/DeepSeek mains; every other combination
// (including a cross-provider choice on those mains) still goes through the
// broker, with its token, permission, child session and projection.
// A DeepSeek choice that is not the computer's own [secondary_model] (flash,
// max) is not native either: the native tools would run on the computer's
// default, so it goes through the broker, per conversation.
async function verify(mainProvider, targetProvider, mid = machineId, override = {}) {
  const asked = { ...targets[targetProvider], ...override };
  const native = targetProvider === 'deepseek' && (mainProvider === 'kimi' || mainProvider === 'deepseek') && asked.model === targets.deepseek.model && asked.effort === targets.deepseek.effort;
  return native ? verifyNative(mainProvider, targetProvider, mid) : verifyBroker(mainProvider, targetProvider, mid, override);
}

for (const mainProvider of Object.keys(mains)) {
  test(`${mainProvider} main × all three subagent providers (native DeepSeek + broker, real CLI/daemon/bridge)`, { skip: SKIP }, async () => {
    for (const targetProvider of Object.keys(targets)) await verify(mainProvider, targetProvider);
  });
}

// The same nine combinations with a different thinking effort than the
// default each target had above (and a different Claude model): the request
// each runtime really received must carry the chosen one. A DeepSeek choice
// that differs from the computer's [secondary_model] (low, not max) is the
// case a native Agent cannot honour; it must still reach DeepSeek with low.
const altTargets = {
  kimi: { effort: 'low' },
  claude: { model: 'claude-sonnet-5-5', effort: 'low', wireModel: 'claude-sonnet-5-5' },
  deepseek: { effort: 'low' },
};
for (const mainProvider of Object.keys(mains)) {
  test(`${mainProvider} main × all three subagent providers at another effort (the request carries it)`, { skip: SKIP }, async () => {
    for (const targetProvider of Object.keys(targets)) await verify(mainProvider, targetProvider, machineId, altTargets[targetProvider]);
  });
}

test('broker installs while Kimi is busy without restarting it', { skip: SKIP }, async () => {
  const home2 = path.join(TMP, 'busy-kimi-home');
  const port2 = KIMI_PORT + 1000;
  const secondApi = async (method, p, body) => {
    const token = fs.readFileSync(path.join(home2, 'server.token'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${port2}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (j.error || (j.code !== undefined && j.code !== 0)) throw new Error(JSON.stringify(j.error || j));
    return j.data;
  };
  const secondKimi = await run(KIMI, ['web', '--no-open', '--port', String(port2)], { KIMI_CODE_HOME: home2 }, /Kimi server ready/);
  const models = ['fake-1', 'kimi-k3'].map((model) => ({ model, max_context_size: 128000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'], default_effort: 'high' }));
  await secondApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.address().port}/v1`, default_model: 'fake-1', models });
  await secondApi('POST', '/models/fake%2Ffake-1:set_default');
  const native = await secondApi('POST', '/sessions', { metadata: { cwd: PROJECT }, title: 'busy install' });
  const nativeId = native.id || native.session_id;
  await secondApi('POST', `/sessions/${nativeId}/profile`, { agent_config: { model: 'fake/fake-1', thinking: 'high', permission_mode: 'auto' } });
  await secondApi('POST', `/sessions/${nativeId}/prompts`, { prompt_id: 'busy-install-prompt', content: [{ type: 'text', text: '長工作' }] });
  await new Promise((r) => setTimeout(r, 500));
  await until(async () => {
    const s = await secondApi('GET', `/sessions/${nativeId}/status`);
    return s.busy === true || s.main_turn_active === true;
  }, 15000, 'native turn is busy');
  const pid = secondKimi.pid;
  const key = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  await run(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${HUB_PORT}`, '--key', key, '--name', 'busy-install-machine', '--kimi-bin', KIMI], {
    KIMI_CODE_HOME: home2, HOME,
    AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${fake.address().port}`,
    AGENT_HUB_CLAUDE_TEST_URL: claude.url, ANTHROPIC_API_KEY: CLAUDE_KEY,
  }, /已連上中控台/);
  const m2 = await until(async () => (await api('GET', '/machines')).find((x) => x.name === 'busy-install-machine' && x.broker >= 1), 20000, 'broker comes online while busy');
  assert.equal(process.kill(pid, 0), true, 'the original Kimi process was restarted');
  await until(async () => (await secondApi('GET', `/sessions/${nativeId}/status`)).busy !== true, 20000, 'busy native turn completes');
  assert.equal(process.kill(pid, 0), true, 'the original Kimi process did not survive');
  await verify('kimi', 'kimi', m2.id);
});

test('Chromium shows the real native subagent and concise settings', { skip: SKIP }, async (t) => {
  const chromium = process.env.CHROMIUM_BIN || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
  if (!chromium) return t.skip('Chromium not installed (set CHROMIUM_BIN)');
  const native = await verifyNative('kimi', 'deepseek');
  const chrome = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${path.join(TMP, 'chromium')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(chrome);
  let chromeLog = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${chromeLog}`)), 15000);
    chrome.stderr.on('data', (d) => {
      chromeLog += d;
      const m = chromeLog.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    chrome.once('error', reject);
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (!msg.id) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result || {});
  };
  socket.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Chromium disconnected'));
    pending.clear();
  };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'Browser evaluation failed');
    return r.result?.value;
  };
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await call('Page.enable', {}, sessionId);
  await call('Page.navigate', { url: `http://127.0.0.1:${HUB_PORT}/#token=${TOKEN}` }, sessionId);
  await until(() => evaluate(`document.readyState === 'complete' && (document.querySelector('.om-sidebar') || document.querySelector('.login input[type="password"]'))`), 20000, 'Agent Hub login or home');
  if (await evaluate(`!!document.querySelector('.login input[type="password"]')`)) {
    await evaluate(`document.querySelector('.login input[type="password"]').value = ${JSON.stringify(TOKEN)}; document.querySelector('.login').requestSubmit();`);
  }
  try {
    await until(() => evaluate(`document.readyState === 'complete' && !!document.querySelector('.om-sidebar')`), 20000, 'Agent Hub home');
  } catch (err) {
    const debug = await evaluate(`JSON.stringify({ url: location.href, ready: document.readyState, text: document.body.innerText.slice(0, 1200), html: document.documentElement.outerHTML.slice(0, 500) })`);
    throw new Error(`${err.message}: ${debug}`);
  }
  await evaluate(`location.hash = ${JSON.stringify(`#/s/${native.parent}`)}`);
  await until(() => evaluate(`document.body.innerText.includes('NATIVE_DELEGATE') && !!document.querySelector('.subagent-model')`), 20000, 'native Agent card');

  await evaluate(`document.querySelector('button[title^="面板："]')?.click()`);
  await until(() => evaluate(`!!document.querySelector('.om-seg__item')`), 5000, 'side panel');
  await evaluate(`[...document.querySelectorAll('.om-seg__item')].find((b) => b.textContent.startsWith('子代理'))?.click()`);
  const panelText = await until(() => evaluate(`document.querySelector('.panel-agents')?.innerText.includes('NATIVE_CHILD_OK') && document.querySelector('.panel-agents').innerText`), 10000, 'native subagent panel');
  assert.match(panelText, /DeepSeek V4\.1 Flash/);
  assert.match(panelText, /思考 max/);
  assert.match(panelText, /[1-9]\d* 步/);
  assert.doesNotMatch(panelText, /delegate_to_provider|broker/);
  const nativeShot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(TMP, 'native-panel.png'), Buffer.from(nativeShot.data, 'base64'));

  await evaluate(`document.querySelector('button[aria-label="更多"]')?.click()`);
  await until(() => evaluate(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('子代理設定'))`), 5000, 'session menu');
  await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('子代理設定'))?.click()`);
  const subagentText = await until(() => evaluate(`document.querySelector('.subagent-settings')?.innerText`), 10000, 'subagent settings');
  // The dialog's lead line was reworded (and now names provider, model and
  // thinking in full); it still has to say what the default is and that it only
  // reaches subagents made from now on.
  assert.match(subagentText, /子代理一律是 DeepSeek V4\.1 Flash · 思考 max/);
  assert.match(subagentText, /只影響之後新建的子代理，已在跑的不變/);
  await evaluate(`document.querySelector('.subagent-settings .dialog-actions button')?.click()`);

  await evaluate(`document.querySelector('button[aria-label="設定"]')?.click()`);
  await until(() => evaluate(`[...document.querySelectorAll('.om-menu__item')].some((e) => e.textContent.includes('DeepSeek…'))`), 5000, 'settings menu');
  await evaluate(`[...document.querySelectorAll('.om-menu__item')].find((e) => e.textContent.includes('DeepSeek…'))?.click()`);
  const deepseekText = await until(() => evaluate(`document.querySelector('.deepseek-settings')?.innerText.includes('各機原生子代理') && document.querySelector('.deepseek-settings').innerText`), 10000, 'DeepSeek settings');
  assert.match(deepseekText, /各閘道各自保存 key；額度用盡自動換同閘道下一把，不切供應商或模型/);
  assert.match(deepseekText, /各機實際 key/);
  assert.match(deepseekText, /agent-hub-deepseek\/deepseek-v4\.1-flash · 思考 max/);
  assert.doesNotMatch(deepseekText, /DeepSeek 對話是在你電腦上的|中控台不會更動這個設定/);
  const settingsShot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(TMP, 'deepseek-settings.png'), Buffer.from(settingsShot.data, 'base64'));
  socket.close();
  chrome.kill('SIGTERM');
});
