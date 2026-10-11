// Claude through the Claude API, against a local fake of api.anthropic.com:
// the key (only a Console API key, sent as x-api-key and nothing else, even
// with Claude-Code-style variables in the environment), streaming, a tool
// call run after approval, 插隊 into the running turn, plan mode, questions,
// subagents, stopping, /undo, /compact and the cost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFakeClaude, wait } from './fixtures/fake-anthropic.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-claude-'));
const PORT = 22000 + Math.floor(Math.random() * 2000);
const KEY = `sk-ant-api03-${'k'.repeat(40)}-test`;
let fake;
let server;
let log = '';
let requests = [];

// The hub, on the test's data folder (started again by the restart test).
let hubEnv;
async function startHub(env = hubEnv) {
  hubEnv = env;
  const p = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...env,
      PORT: String(PORT),
      AGENT_HUB_TOKEN: 'none',
      AGENT_HUB_DATA: path.join(TMP, 'data'),
      AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'),
      AGENT_HUB_CLAUDE_TEST_URL: fake.url,
      // What a machine with Claude Code signed in might have around. None of
      // it may reach the request.
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-should-never-be-sent',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-ant-oat01-custom\nX-Api-Key: sk-ant-oat01-custom',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => (log += d));
  await new Promise((resolve) => p.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
  return p;
}

before(async () => {
  fake = await startFakeClaude(KEY);
  requests = fake.requests;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  server = await startHub(env);
});

// The Claude daemon outlives the hub (that is its point): stop it here.
function stopDaemon() {
  try {
    process.kill(JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'claude-daemon', 'daemon.json'), 'utf8')).pid, 'SIGTERM');
  } catch {}
}

after(() => {
  stopDaemon();
  server.kill('SIGTERM');
  fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error), { status: res.status });
  return j;
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(25);
  }
  throw new Error(`timeout\n${log}`);
};
const snap = (id) => api('GET', `/sessions/${id}`);
const idle = (id) => until(async () => {
  const s = await snap(id);
  return s.status !== 'running' && s.status !== 'awaiting_permission' && !(s.meta?.queue || []).length && s;
});
const waiting = (id) => until(async () => (await snap(id)).events.find((e) => e.permission && !e.permission.chosen));
const messagesSent = () => requests.filter((r) => r.url.startsWith('/v1/messages'));

test('only a Claude Console API key is accepted, and kept to the hub', async () => {
  const before = await api('GET', '/claude');
  assert.equal(before.hasKey, false);
  await assert.rejects(api('PUT', '/claude', { apiKey: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz' }), /訂閱帳號/);
  await assert.rejects(api('PUT', '/claude', { apiKey: 'sk-ant-api03-wrong-key-xxxxxxxxxxxxxxxxxxx' }), /API key 無效/);
  // Other Console key kinds go to Anthropic to be checked, not refused here.
  await assert.rejects(api('PUT', '/claude', { apiKey: 'sk-ant-usr01-some-other-kind-of-key-xxxxxxxx' }), /API key 無效/);
  await assert.rejects(api('PUT', '/claude', { apiKey: 'sk-ant-admin01-xxxxxxxxxxxxxxxxxxxxxxxx' }), /Admin API key/);
  await assert.rejects(api('POST', '/sessions', { agent: 'claude', prompt: 'hi' }), /還沒有設定 Claude API key/);
  const acc = await api('PUT', '/claude', { apiKey: KEY });
  assert.equal(acc.hasKey, true);
  assert.equal(acc.keyHint, `sk-ant-api03…${KEY.slice(-4)}`);
  assert.equal(JSON.stringify(acc).includes(KEY), false);
  const st = fs.statSync(path.join(TMP, 'data', 'claude.json'));
  assert.equal(st.mode & 0o077, 0);
  const t = await api('POST', '/claude/test');
  assert.equal(t.ok, true);
});

test('a turn: streamed thinking and text, a Write run after approval, the result sent back', async () => {
  const n0 = messagesSent().length;
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'WRITE hi.txt', permission: 'manual' });
  assert.equal(s.agentId, 'claude');
  assert.equal(s.meta.model, 'claude-opus-5-5');
  const ev = await waiting(s.id);
  assert.equal(ev.name, 'Write');
  assert.equal(ev.input.file_path, 'hi.txt');
  assert.equal(ev.permission.kind, 'approval');
  assert.equal((await snap(s.id)).status, 'awaiting_permission');
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'approved' });
  const done = await idle(s.id);
  assert.equal(fs.readFileSync(path.join(done.cwd, 'hi.txt'), 'utf8'), 'hello from claude\n');
  const types = done.events.map((e) => e.type);
  assert.deepEqual(types, ['user', 'thinking', 'text', 'tool_use', 'text', 'turn_end']);
  assert.equal(done.events[1].text, '先建立檔案。');
  assert.match(done.events.at(-2).text, /^完成：Created hi\.txt/);
  assert.equal(done.title, 'WRITE hi.txt');
  // Opus 5.5 list prices: 2000 in + 300 out, then 1000 in + 100 out.
  assert.ok(Math.abs(done.usage.costUsd - (3000 * 4 + 400 * 20) / 1e6) < 1e-9, String(done.usage.costUsd));
  assert.equal(done.meta.rateLimits.requests.limit, 50);
  assert.equal(done.meta.context.size, 1000000);
  // The model that answered, as Anthropic reported it, after each response.
  assert.equal(done.meta.servedModel.id, 'claude-opus-5-5');
  assert.equal(done.meta.servedModel.name, 'Claude Opus 5.5');
  assert.deepEqual(done.events.at(-1).models, [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]);

  const [r1, r2] = messagesSent().slice(n0);
  // The key and nothing else: no bearer token, whatever the environment says.
  for (const r of [r1, r2]) {
    assert.equal(r.headers['x-api-key'], KEY);
    assert.equal(r.headers.authorization, undefined);
    assert.ok(r.headers['anthropic-version']);
  }
  const b = r1.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.stream, true);
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(b.output_config, { effort: 'high' });
  // No server-side fallback: only the chosen model answers.
  assert.equal(b.fallbacks, undefined);
  assert.doesNotMatch(r1.headers['anthropic-beta'] || '', /fallback/);
  assert.ok(b.tools.some((t) => t.name === 'Bash' && t.eager_input_streaming === true));
  assert.ok(b.tools.some((t) => t.type === 'web_search_20260209'));
  // Append-only: the second request starts with the first one's messages.
  assert.deepEqual(r2.body.system, b.system);
  assert.deepEqual(r2.body.tools, b.tools);
  assert.deepEqual(r2.body.messages.slice(0, b.messages.length), b.messages);
  const assistant = r2.body.messages.at(-2);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: '先建立檔案。', signature: 'sig_fake' });
  const result = r2.body.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'toolu_w1');
});

test('插隊: a message sent while Claude works goes in with the next tool results', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'BASH', permission: 'manual' });
  const ev = await waiting(s.id);
  assert.equal(ev.name, 'Bash');
  await api('POST', `/sessions/${s.id}/messages`, { text: '順便看一下 README', steer: true });
  await until(async () => (await snap(s.id)).meta.queue?.[0]?.steered);
  const n0 = messagesSent().length;
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'approved' });
  const done = await idle(s.id);
  const sent = messagesSent()[n0].body.messages.at(-1).content;
  assert.equal(sent[0].type, 'tool_result');
  assert.match(sent[0].content, /bash-ran/);
  assert.equal(sent[1].type, 'text');
  assert.match(sent[1].text, /順便看一下 README/);
  const steered = done.events.find((e) => e.type === 'user' && e.steered);
  assert.equal(steered.text, '順便看一下 README');
  // Queued (not steered): its own turn after this one.
  const q = await api('POST', '/sessions', { agent: 'claude', prompt: 'BASH', permission: 'manual' });
  const qev = await waiting(q.id);
  await api('POST', `/sessions/${q.id}/messages`, { text: '下一個問題' });
  await api('POST', `/sessions/${q.id}/permissions/${qev.id}`, { optionId: 'rejected', feedback: '不要跑' });
  const qdone = await until(async () => {
    const x = await snap(q.id);
    return x.events.filter((e) => e.type === 'turn_end').length === 2 && x.status === 'idle' && x;
  });
  assert.equal(qdone.events.filter((e) => e.type === 'user').map((e) => e.text).join('|'), 'BASH|下一個問題');
  assert.equal(qdone.events.find((e) => e.name === 'Bash').status, 'denied');
});

test('plan mode: told as a note, edits refused, ExitPlanMode approval turns it off', async () => {
  const n0 = messagesSent().length;
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'PLAN 改 a.txt', planMode: true });
  const ev = await waiting(s.id);
  assert.equal(ev.permission.kind, 'plan');
  assert.match(ev.permission.plan, /改 a\.txt/);
  const first = messagesSent()[n0].body.messages;
  assert.equal(first.at(-1).role, 'system');
  assert.match(first.at(-1).content, /Plan mode is on/);
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'plan:edits' });
  const done = await idle(s.id);
  assert.equal(done.meta.planMode, false);
  assert.equal(done.meta.permission, 'edits');
  assert.match(messagesSent().at(-1).body.messages.at(-1).content[0].content, /approved the plan/);
});

test('AskUserQuestion waits for the answer and sends it back as text', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'ASK' });
  const ev = await waiting(s.id);
  assert.equal(ev.permission.kind, 'question');
  const q = ev.permission.questions[0];
  await api('POST', `/sessions/${s.id}/permissions/${ev.id}`, { optionId: 'answer', answers: { [q.id]: { kind: 'single', option_id: q.options[1].id } } });
  await idle(s.id);
  assert.match(messagesSent().at(-1).body.messages.at(-1).content[0].content, /要用哪個框架？ → Vue/);
});

test('Task: two subagents run side by side and report back', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'TASK', permission: 'auto' });
  const done = await idle(s.id);
  const cards = done.events.filter((e) => e.name === 'Task');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.subagent.status), ['done', 'done']);
  assert.deepEqual(cards.map((c) => c.subagent.served), ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.equal(cards[0].subagent.summary, '子代理報告：find A');
  const inside = done.events.filter((e) => e.parent === cards[1].id);
  assert.equal(inside[0].text, '子代理報告：find B');
  assert.match(done.events.filter((e) => e.type === 'text' && !e.parent).at(-1).text, /find A \/ 子代理報告：find B/);
  const sub = messagesSent().find((r) => r.body.system[0].text.includes('You are a subagent'));
  assert.equal(sub.body.tools.some((t) => t.name === 'Task'), false);
});

test('stopping keeps what was written; /undo, /compact, /fork and the budget', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'SLOW' });
  await until(async () => (await snap(s.id)).events.some((e) => e.type === 'text' && e.text.length > 20));
  await api('POST', `/sessions/${s.id}/interrupt`);
  const stopped = await idle(s.id);
  assert.equal(stopped.events.at(-1).interrupted, true);
  await api('POST', `/sessions/${s.id}/messages`, { text: '繼續' });
  await until(async () => (await snap(s.id)).events.filter((e) => e.type === 'turn_end').length === 2);
  const msgs = messagesSent().at(-1).body.messages;
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.match(msgs.at(-2).content[0].text, /^這是一段會慢慢寫出來的回覆/);

  await api('POST', `/sessions/${s.id}/command`, { name: 'undo' });
  const undone = await snap(s.id);
  assert.equal(undone.events.filter((e) => e.type === 'user').length, 1);

  await api('POST', `/sessions/${s.id}/command`, { name: 'compact' });
  await api('POST', `/sessions/${s.id}/messages`, { text: '還記得嗎' });
  await until(async () => (await snap(s.id)).events.filter((e) => e.type === 'turn_end').length === 2);
  // The summary, then the new message (the API reads them as one user turn).
  const after = messagesSent().at(-1).body.messages;
  assert.deepEqual(after.map((m) => m.role), ['user', 'user']);
  assert.match(after.map((m) => m.content.map((b) => b.text).join('\n')).join('\n'), /摘要：建立了 hi\.txt。[\s\S]*還記得嗎/);

  const f = await api('POST', `/sessions/${s.id}/command`, { name: 'fork', args: '分支' });
  assert.equal(f.session.title, '分支');
  assert.equal(f.session.agentId, 'claude');

  await api('POST', `/sessions/${s.id}/command`, { name: 'budget', args: '0.01' });
  await api('POST', `/sessions/${s.id}/messages`, { text: '再一次' });
  const capped = await until(async () => {
    const x = await snap(s.id);
    return x.events.filter((e) => e.type === 'turn_end').length === 3 && x;
  });
  assert.match(capped.events.findLast((e) => e.type === 'info').text, /花費上限/);
});

test('sessions show in the list and the files panel reads their folder', async () => {
  const list = await api('GET', '/sessions');
  const s = list.find((x) => x.agentId === 'claude' && x.title === 'WRITE hi.txt');
  assert.ok(s);
  const files = await api('GET', `/sessions/${s.id}/files`);
  assert.ok(files.some((f) => f.name === 'hi.txt'));
  const changes = await api('GET', `/sessions/${s.id}/changes`);
  assert.ok(changes.files.some((f) => f.path === 'hi.txt'));
});

test('on a connected computer: Claude runs in that computer\'s daemon, started by its bridge', async () => {
  const home = path.join(TMP, 'box-home');
  const folder = path.join(TMP, 'box-folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '在這個專案裡用繁體中文回答。\n');
  const keyFile = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  const bridge = spawn(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${PORT}`, '--key', keyFile, '--name', 'box', '--no-skill'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: path.join(home, '.kimi-code'), PATH: process.env.PATH, AGENT_HUB_CLAUDE_TEST_URL: fake.url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const m = await until(async () => (await api('GET', '/machines')).find((x) => x.name === 'box' && x.online));
    const dirs = await api('GET', `/fs/dirs?machine=${m.id}&path=${encodeURIComponent(TMP)}`);
    assert.ok(dirs.dirs.includes('box-folder'));
    const n0 = messagesSent().length;
    const s = await api('POST', '/sessions', { agent: 'claude', machineId: m.id, cwd: folder, prompt: 'WRITE', permission: 'auto' });
    assert.equal(s.machineId, m.id);
    assert.equal(s.meta.machineName, 'box');
    const done = await idle(s.id);
    assert.equal(fs.readFileSync(path.join(folder, 'hi.txt'), 'utf8'), 'hello from claude\n');
    const system = messagesSent()[n0].body.system[0].text;
    assert.match(system, /Computer: box/);
    assert.match(system, /用繁體中文回答/);
    assert.match(done.events.at(-2).text, /Created hi\.txt/);
    // Commands too, their output streaming back.
    await api('POST', `/sessions/${s.id}/messages`, { text: 'BASH' });
    const bashed = await until(async () => {
      const x = await snap(s.id);
      return x.events.filter((e) => e.type === 'turn_end').length === 2 && x.status === 'idle' && x;
    });
    assert.match(bashed.events.find((e) => e.name === 'Bash').output, /bash-ran/);
    const files = await api('GET', `/sessions/${s.id}/files`);
    assert.ok(files.some((f) => f.name === 'hi.txt'));
    const f = await api('GET', `/sessions/${s.id}/file?path=hi.txt`);
    assert.equal(f.content, 'hello from claude\n');
  } finally {
    bridge.kill();
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(home, '.agent-hub', 'claude', 'daemon.json'), 'utf8')).pid, 'SIGTERM');
    } catch {}
  }
});

test('another model answering (a downgrade) or a refusal stops the turn, and says so', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'SWAP', permission: 'auto' });
  const done = await idle(s.id);
  assert.equal(done.status, 'error');
  const err = done.events.find((e) => e.type === 'error');
  assert.match(err.text, /claude-opus-4-8/);
  assert.equal(done.meta.servedModel.id, 'claude-opus-4-8');
  assert.equal(done.meta.servedModel.asked, 'claude-opus-5-5');
  assert.match(err.text, /已停止這一輪/);
  assert.equal(done.events.at(-1).error, true);
  assert.equal(fs.existsSync(path.join(done.cwd, 'swapped.txt')), false);
  assert.notEqual(done.events.find((e) => e.name === 'Bash')?.status, 'done');
  // Not kept: the next request does not carry the other model's answer.
  await api('POST', `/sessions/${s.id}/messages`, { text: '好' });
  await until(async () => (await snap(s.id)).events.filter((e) => e.type === 'turn_end').length === 2);
  assert.equal(messagesSent().at(-1).body.messages.some((m) => m.role === 'assistant'), false);

  const r = await api('POST', '/sessions', { agent: 'claude', prompt: 'REFUSE' });
  const refused = await idle(r.id);
  assert.equal(refused.status, 'error');
  assert.match(refused.events.find((e) => e.type === 'error').text, /拒絕了這個請求，已停止這一輪/);
});

test('closing the hub stops nothing: Claude goes on in its daemon, the hub catches up', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'SLOW' });
  await until(async () => (await snap(s.id)).events.some((e) => e.type === 'text' && e.text.length > 20));
  await api('POST', `/sessions/${s.id}/messages`, { text: '排隊的問題' });
  const n0 = messagesSent().length;
  await new Promise((r) => (server.once('exit', r), server.kill('SIGTERM')));
  // With the hub gone, the turn finishes and the queued message goes out.
  await until(() => messagesSent().slice(n0).some((r) => JSON.stringify(r.body.messages.at(-1)).includes('排隊的問題')), 20000);
  await wait(300);
  server = await startHub();
  const done = await until(async () => {
    const x = await snap(s.id);
    return x.events.filter((e) => e.type === 'turn_end').length === 2 && x.status === 'idle' && x;
  }, 20000);
  assert.equal(done.events.some((e) => e.type === 'turn_end' && (e.interrupted || e.restarted)), false);
  assert.match(done.events.find((e) => e.type === 'text').text, /慢慢寫出來的回覆/);
  assert.equal(done.events.filter((e) => e.type === 'user').at(-1).text, '排隊的問題');
});

test('the daemon itself stopping mid-turn: it is started again and the turn goes on', async () => {
  const s = await api('POST', '/sessions', { agent: 'claude', prompt: 'SLOW' });
  await until(async () => (await snap(s.id)).events.some((e) => e.type === 'text' && e.text.length > 20));
  const n0 = messagesSent().length;
  const pid = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'claude-daemon', 'daemon.json'), 'utf8')).pid;
  process.kill(pid, 'SIGKILL');
  const done = await until(async () => {
    const x = await snap(s.id);
    return x.events.filter((e) => e.type === 'turn_end').length === 2 && x.status === 'idle' && x;
  }, 30000);
  assert.ok(done.events.some((e) => e.type === 'turn_end' && e.restarted));
  assert.ok(done.events.some((e) => e.type === 'info' && /接著剛才被中斷的工作/.test(e.text)));
  assert.match(JSON.stringify(messagesSent()[n0].body.messages.at(-1)), /Agent Hub restarted/);
});

test('a conversation the hub ran itself (before daemons) moves into the daemon, history and all', async () => {
  const id = 's_legacy000001';
  const cwd = fs.mkdtempSync(path.join(TMP, 'legacy-'));
  const legacy = {
    id,
    agentId: 'claude',
    title: '舊的 Claude 對話',
    titled: true,
    status: 'running',
    cwd,
    permissionMode: 'ask',
    allowedTools: [],
    events: [
      { id: 'e_old1', ts: 1, type: 'user', text: '之前問的問題', source: 'hub' },
      { id: 'e_old2', ts: 2, type: 'text', text: '之前的回答' },
    ],
    meta: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', permission: 'auto', planMode: false, queue: [], todos: [] },
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 1.5 },
    state: { claude: { system: 'You are Claude (old system prompt).', subSystem: 'sub', web: false, messages: [{ role: 'user', content: [{ type: 'text', text: '之前問的問題' }] }, { role: 'assistant', content: [{ type: 'text', text: '之前的回答' }] }], turns: [], usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5, searches: 0, requests: 1, cost: 1.5 }, active: { since: 1 } } },
    createdAt: 1,
    updatedAt: 2,
  };
  await new Promise((r) => (server.once('exit', r), server.kill('SIGTERM')));
  fs.writeFileSync(path.join(TMP, 'data', 'sessions', `${id}.json`), JSON.stringify(legacy));
  const n0 = messagesSent().length;
  server = await startHub();
  // It was working when the hub stopped: the daemon goes on with it.
  const done = await until(async () => {
    const x = await snap(id);
    return x.events.some((e) => e.type === 'turn_end' && !e.restarted) && x.status === 'idle' && x;
  }, 20000);
  assert.equal(done.events[0].text, '之前問的問題');
  assert.equal(done.usage.costUsd > 1.5, true);
  const req = messagesSent()[n0].body;
  assert.equal(req.system[0].text, 'You are Claude (old system prompt).');
  assert.equal(req.messages[0].content[0].text, '之前問的問題');
  assert.equal(req.messages[1].content[0].text, '之前的回答');
  // The hub no longer keeps the API history itself.
  const file = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'sessions', `${id}.json`), 'utf8'));
  assert.equal(file.state.claude, undefined);
});

test('the daemon bundle the bridges download is built from the current code', async (t) => {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    return t.skip('esbuild is not installed');
  }
  const out = path.join(TMP, 'bundle-check.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const banner = pkg.scripts['build:daemon'].match(/--banner:js=(.*)"$/)[1];
  await esbuild.build({ entryPoints: [path.join(ROOT, 'server/claude-daemon.js')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, banner: { js: banner }, logLevel: 'silent' });
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(ROOT, 'bridge/claude-daemon.mjs'), 'utf8'), 'bridge/claude-daemon.mjs is stale: run npm run build:daemon');
});
