#!/usr/bin/env node
// A small but protocol-faithful ACP agent used to verify the hub end to end
// without any account. It mirrors what Kimi Code CLI announces in
// `initialize` and exercises every update type the hub renders.
//
//   node test/fixtures/mock-acp-agent.mjs        (stdio, newline-delimited JSON-RPC)
//
// MOCK_LATENCY=1 prefixes each streamed chunk with ⟦t=<epoch ms>⟧ so a test
// can measure agent→browser latency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LATENCY = process.env.MOCK_LATENCY === '1';
const REQUIRE_AUTH = process.env.MOCK_REQUIRE_AUTH === '1';
const sessions = new Map();
let nextId = 1;
const waiting = new Map();

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `a${nextId++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: '預設（需要時詢問）' },
    { id: 'plan', name: '規劃模式' },
    { id: 'yolo', name: '自動執行' },
  ],
};
const CONFIG = () => [
  {
    id: 'model',
    name: '模型',
    type: 'select',
    category: 'model',
    currentValue: 'mock-k2',
    options: [
      { value: 'mock-k2', name: 'Mock K2' },
      { value: 'mock-k2-turbo', name: 'Mock K2 Turbo' },
    ],
  },
  { id: 'thinking', name: '思考', type: 'boolean', currentValue: true },
];

async function stream(sessionId, kind, text, s) {
  const parts = text.match(/[\s\S]{1,4}/g) || [];
  for (const p of parts) {
    if (s.cancelled) return;
    const chunk = LATENCY ? `⟦t=${Date.now()}⟧${p}` : p;
    notify(sessionId, { sessionUpdate: kind, content: { type: 'text', text: chunk } });
    await sleep(8);
  }
}

async function prompt(params) {
  const s = sessions.get(params.sessionId);
  if (!s) throw Object.assign(new Error('unknown session'), { code: -32602 });
  s.cancelled = false;
  s.turns++;
  const text = params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const images = params.prompt.filter((b) => b.type === 'image').length;
  const sid = params.sessionId;

  if (/slow/.test(text)) {
    // Long turn used to test cancellation.
    for (let i = 0; i < 400 && !s.cancelled; i++) {
      notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } });
      await sleep(25);
    }
    return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
  }

  if (s.turns === 1) {
    notify(sid, { sessionUpdate: 'session_info_update', title: `Mock: ${text.slice(0, 30)}` });
  }
  await stream(sid, 'agent_thought_chunk', `使用者說「${text.slice(0, 40)}」。我會先規劃再動手。`, s);
  notify(sid, {
    sessionUpdate: 'plan',
    entries: [
      { content: '讀取專案', priority: 'high', status: 'in_progress' },
      { content: '寫入 mock.txt', priority: 'high', status: 'pending' },
    ],
  });
  await stream(sid, 'agent_message_chunk', `第 ${s.turns} 回合，收到${images ? ` ${images} 張圖片與` : ''}你的訊息：**${text}**\n\n`, s);

  // A tool that needs approval, exactly like Kimi's shell tool.
  const callId = `call_${crypto.randomBytes(3).toString('hex')}`;
  notify(sid, { sessionUpdate: 'tool_call', toolCallId: callId, title: 'Shell: echo hello', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello' } });
  const perm = await request('session/request_permission', {
    sessionId: sid,
    toolCall: { toolCallId: callId, title: 'Shell: echo hello', kind: 'execute', status: 'pending' },
    options: [
      { optionId: 'approve', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'approve_session', name: 'Approve for this session', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  if (s.cancelled || perm?.outcome?.outcome === 'cancelled') return { stopReason: 'cancelled' };
  const approved = perm?.outcome?.optionId?.startsWith('approve');
  notify(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'in_progress' });
  await sleep(30);
  notify(sid, {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: approved ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: approved ? 'hello\n' : 'Rejected by user' } }],
  });

  // An edit with a diff; the file is really written so git sees it.
  const file = path.join(s.cwd, 'mock.txt');
  const oldText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const newText = `${oldText ?? ''}turn ${s.turns}: ${text}\n`;
  fs.writeFileSync(file, newText);
  const editId = `call_${crypto.randomBytes(3).toString('hex')}`;
  notify(sid, {
    sessionUpdate: 'tool_call',
    toolCallId: editId,
    title: 'Edit mock.txt',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: file, line: s.turns }],
    content: [{ type: 'diff', path: 'mock.txt', oldText, newText }],
  });
  notify(sid, {
    sessionUpdate: 'plan',
    entries: [
      { content: '讀取專案', priority: 'high', status: 'completed' },
      { content: '寫入 mock.txt', priority: 'high', status: 'completed' },
    ],
  });
  await stream(sid, 'agent_message_chunk', approved ? '完成 ✅ 指令已執行並更新 mock.txt。' : '指令被拒絕，只更新了 mock.txt。', s);
  notify(sid, { sessionUpdate: 'usage_update', used: 12000 * s.turns, size: 262144, cost: { amount: 0.01 * s.turns, currency: 'USD' } });
  return { stopReason: s.cancelled ? 'cancelled' : 'end_turn', usage: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } };
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {} },
    },
    authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Mock account', args: ['--login'] }],
    agentInfo: { name: 'Mock ACP Agent', version: '1.0.0' },
  }),
  'session/new': (p) => {
    if (REQUIRE_AUTH) throw Object.assign(new Error('Authentication required'), { code: -32000 });
    const sessionId = `mock_${crypto.randomBytes(4).toString('hex')}`;
    sessions.set(sessionId, { cwd: p.cwd, turns: 0, cancelled: false });
    setTimeout(
      () =>
        notify(sessionId, {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'init', description: '分析專案並產生 AGENTS.md' },
            { name: 'compact', description: '壓縮對話內容' },
            { name: 'review', description: '審查目前的變更', input: { hint: '要審查的範圍' } },
          ],
        }),
      10,
    );
    return { sessionId, modes: MODES, configOptions: CONFIG() };
  },
  'session/resume': (p) => {
    sessions.set(p.sessionId, sessions.get(p.sessionId) || { cwd: p.cwd, turns: 0, cancelled: false, resumed: true });
    return { modes: MODES, configOptions: CONFIG() };
  },
  'session/load': (p) => handlers['session/resume'](p),
  'session/prompt': prompt,
  'session/set_mode': (p) => {
    MODES.currentModeId = p.modeId;
    notify(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId });
    return {};
  },
  'session/set_config_option': (p) => {
    const opts = CONFIG().map((o) => (o.id === p.configId ? { ...o, currentValue: p.value } : o));
    return { configOptions: opts };
  },
};

let buf = '';
process.stdin.on('data', async (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg.result);
      waiting.delete(msg.id);
      continue;
    }
    if (msg.method === 'session/cancel') {
      const s = sessions.get(msg.params?.sessionId);
      if (s) s.cancelled = true;
      for (const [id, resolve] of waiting) {
        resolve({ outcome: { outcome: 'cancelled' } });
        waiting.delete(id);
      }
      continue;
    }
    const fn = handlers[msg.method];
    if (msg.id === undefined) continue;
    if (!fn) {
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      continue;
    }
    Promise.resolve()
      .then(() => fn(msg.params || {}))
      .then((result) => send({ id: msg.id, result }))
      .catch((err) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
