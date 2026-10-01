// Agent Client Protocol (ACP) adapter — https://agentclientprotocol.com
//
// The hub acts as an ACP *client* (the role Zed or JetBrains play): it spawns
// the agent (`kimi acp`, `gemini --experimental-acp`, …), talks JSON-RPC over
// stdio, and relays every `session/update` to the browser the moment it
// arrives. The agent keeps its own login, model, tools and permission policy,
// so a subscription-based login (e.g. Kimi Code OAuth) works unchanged.
//
// One agent process per hub session, kept alive between turns so follow-ups
// start instantly and keep full context. If the process goes away (idle
// timeout, server restart) the conversation is re-attached with
// session/resume or session/load when the agent supports it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL_VERSION = 1;
const IDLE_MS = 30 * 60_000;
const CLIENT_INFO = { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' };

const connections = new Map(); // hub session id -> AcpConnection

// --------------------------------------------------------------- helpers

export function splitArgs(input) {
  if (Array.isArray(input)) return input.map(String);
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(input || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

const whichCache = new Map();
export function commandExists(cmd) {
  if (!cmd) return false;
  const hit = whichCache.get(cmd);
  if (hit && Date.now() - hit.at < 10_000) return hit.ok;
  let ok = false;
  if (cmd.includes('/')) ok = fs.existsSync(cmd);
  else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir && fs.existsSync(path.join(dir, cmd))) {
        ok = true;
        break;
      }
    }
  }
  whichCache.set(cmd, { ok, at: Date.now() });
  return ok;
}

class AcpError extends Error {
  constructor(error) {
    super(error?.message || 'ACP error');
    this.code = error?.code;
    this.data = error?.data;
  }
}

function isAuthError(err) {
  return err instanceof AcpError && (err.code === -32000 || /auth/i.test(err.message));
}

function contentToText(block) {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text ?? '';
    case 'image':
      return '\n[image]\n';
    case 'audio':
      return '\n[audio]\n';
    case 'resource_link':
      return `[${block.name || block.uri}](${block.uri})`;
    case 'resource':
      return block.resource?.text ?? `[${block.resource?.uri ?? 'resource'}]`;
    default:
      return '';
  }
}

const TOOL_STATUS = { pending: 'pending', in_progress: 'running', completed: 'done', failed: 'error' };

function toolFields(u) {
  const f = {};
  if (u.title != null) f.title = u.title;
  if (u.kind != null) f.kind = u.kind;
  if (u.name != null) f.name = u.name;
  if (u.status != null) {
    f.status = TOOL_STATUS[u.status] ?? u.status;
    f.isError = u.status === 'failed';
  }
  if (u.content != null) f.content = u.content;
  if (u.locations != null) f.locations = u.locations;
  if (u.rawInput !== undefined) f.input = u.rawInput;
  if (u.rawOutput !== undefined) f.rawOutput = u.rawOutput;
  return f;
}

// ------------------------------------------------------------ connection

class AcpConnection {
  constructor(agent, cwd) {
    this.agentKey = JSON.stringify([agent.command, agent.args, agent.env]);
    this.nextId = 1;
    this.pending = new Map();
    this.alive = true;
    this.stderr = '';
    this.acpSessionId = null;
    this.replaying = false;
    this.onUpdate = null; // (update) => void
    this.onPermission = null; // async (params) => outcome
    this.proc = spawn(agent.command, splitArgs(agent.args), {
      cwd,
      env: { ...process.env, ...(agent.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ready = new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve);
      this.proc.once('error', reject);
    });
    this.exited = new Promise((resolve) => {
      const done = (why) => {
        if (!this.alive) return;
        this.alive = false;
        clearTimeout(this.idleTimer);
        const err = new Error(`${agent.name} 程序已結束（${why}）${this.stderr ? `\n${this.stderrTail()}` : ''}`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        resolve(err);
      };
      this.proc.on('exit', (code, signal) => done(signal ? `signal ${signal}` : `exit code ${code}`));
      this.proc.on('error', (err) => done(err.message));
    });
    this.proc.stdin.on('error', () => {});

    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.stderr = (this.stderr + line + '\n').slice(-8000);
          continue;
        }
        this.dispatch(msg);
      }
    });
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000);
    });
  }

  stderrTail(lines = 8) {
    return this.stderr.trim().split('\n').slice(-lines).join('\n');
  }

  send(msg) {
    if (!this.alive) throw new Error('agent 程序已結束');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try {
      this.send({ method, params });
    } catch {}
  }

  async dispatch(msg) {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(msg.error));
      else p.resolve(msg.result ?? {});
      return;
    }
    // Notification from the agent.
    if (msg.id === undefined) {
      if (msg.method === 'session/update' && msg.params?.update) this.onUpdate?.(msg.params.update);
      return;
    }
    // Request from the agent (reverse RPC).
    try {
      let result;
      if (msg.method === 'session/request_permission') {
        result = this.onPermission ? await this.onPermission(msg.params) : { outcome: { outcome: 'cancelled' } };
      } else {
        // We advertise no fs/terminal capabilities, so the agent uses its own.
        return this.send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      this.send({ id: msg.id, result });
    } catch (err) {
      try {
        this.send({ id: msg.id, error: { code: -32603, message: err.message } });
      } catch {}
    }
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  kill() {
    clearTimeout(this.idleTimer);
    if (!this.alive) return;
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill('SIGTERM');
    setTimeout(() => this.alive && this.proc.kill('SIGKILL'), 3000).unref?.();
  }
}

// ------------------------------------------------------------- the turn

// Turns ACP session/update notifications into hub events, preserving order:
// consecutive chunks of the same kind stream into one block, and any tool
// call or plan closes the current block so later text appears after it.
class TurnSink {
  constructor(ctx) {
    this.ctx = ctx;
    this.open = null;
    this.tools = new Map();
    this.planEv = null;
  }

  chunk(type, content, messageId) {
    const text = contentToText(content);
    if (!text) return;
    const o = this.open;
    if (!o || o.type !== type || (messageId && o.messageId && messageId !== o.messageId)) {
      this.open = { type, messageId, ev: this.ctx.emit({ type, text: '' }) };
    }
    this.ctx.delta(this.open.ev, text);
  }

  tool(u) {
    this.open = null;
    const fields = toolFields(u);
    let ev = this.tools.get(u.toolCallId);
    if (!ev) {
      ev = this.ctx.emit({
        type: 'tool_use',
        source: 'acp',
        toolCallId: u.toolCallId,
        name: u.kind || 'tool',
        status: 'pending',
        ...fields,
      });
      this.tools.set(u.toolCallId, ev);
    } else if (Object.keys(fields).length) {
      this.ctx.patch(ev, fields);
    }
    return ev;
  }

  update(u) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk('text', u.content, u.messageId);
      case 'agent_thought_chunk':
        return this.chunk('thinking', u.content, u.messageId);
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(u);
      case 'plan':
        this.open = null;
        if (this.planEv) this.ctx.patch(this.planEv, { entries: u.entries || [] });
        else this.planEv = this.ctx.emit({ type: 'plan', entries: u.entries || [] });
        return;
      case 'notice':
        return this.ctx.emit({ type: 'info', text: u.message || u.text || JSON.stringify(u).slice(0, 300) });
      default:
    }
  }

  async permission(params) {
    const { ctx } = this;
    const tc = params.toolCall || {};
    const ev = tc.toolCallId ? this.tool(tc) : ctx.emit({ type: 'tool_use', source: 'acp', name: 'permission', title: tc.title || '需要確認', status: 'pending' });
    const options = Array.isArray(params.options) ? params.options : [];
    // The hub's permission mode can auto-answer on the user's behalf, always
    // with a one-time allow so the agent's own remembered rules stay untouched.
    const mode = ctx.session.permissionMode;
    const kind = tc.kind || ev.kind;
    const autoKinds = ['read', 'search', 'think', 'fetch', 'edit', 'delete', 'move'];
    if (mode === 'bypass' || (mode === 'auto_edits' && autoKinds.includes(kind))) {
      const opt = options.find((o) => o.kind === 'allow_once') || options.find((o) => o.kind === 'allow_always');
      if (opt) {
        ctx.patch(ev, { permission: { options, chosen: opt.optionId, auto: true } });
        return { outcome: { outcome: 'selected', optionId: opt.optionId } };
      }
    }
    const chosen = await ctx.askUser(ev, options);
    if (!chosen || !options.some((o) => o.optionId === chosen)) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: chosen } };
  }
}

// Session-level metadata (modes, models, slash commands, context usage) is
// tracked whether or not a turn is running.
function metaFromUpdate(u, session) {
  switch (u.sessionUpdate) {
    case 'available_commands_update':
      return {
        commands: (u.availableCommands || []).map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint })),
      };
    case 'current_mode_update':
      return session.meta?.modes ? { modes: { ...session.meta.modes, currentModeId: u.currentModeId } } : null;
    case 'config_option_update':
      return { configOptions: u.configOptions || [] };
    case 'usage_update':
      return { context: { used: u.used, size: u.size }, cost: u.cost ?? session.meta?.cost };
    default:
      return null;
  }
}

function loginHint(agent, init) {
  if (agent.login) return agent.login;
  const m = init?.authMethods?.[0];
  const t = m?._meta?.['terminal-auth'];
  if (t?.command) return [path.basename(t.command), ...(t.args || [])].join(' ');
  if (m?.args) return [agent.command, ...m.args].join(' ');
  return agent.command;
}

async function connect(ctx) {
  const { agent, session } = ctx;
  const conn = new AcpConnection(agent, session.cwd);
  connections.set(session.id, conn);
  try {
    await conn.ready;
  } catch (err) {
    connections.delete(session.id);
    if (err.code === 'ENOENT') {
      throw new Error(`找不到指令「${agent.command}」。請先安裝 ${agent.name}${agent.install ? `：${agent.install}` : ''}，或在設定中填入完整路徑。`);
    }
    throw err;
  }

  const fail = async (err) => {
    conn.kill();
    connections.delete(session.id);
    throw err;
  };

  let init;
  try {
    init = await Promise.race([
      conn.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      }),
      conn.exited.then((e) => Promise.reject(e)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${agent.name} 在 60 秒內沒有回應 initialize`)), 60_000)),
    ]);
  } catch (err) {
    return fail(err);
  }
  conn.init = init;
  const caps = init.agentCapabilities || {};

  // Metadata can arrive at any time, including during session/load replay.
  conn.onUpdate = (u) => {
    const meta = metaFromUpdate(u, session);
    if (meta) ctx.setMeta(meta);
    if (u.sessionUpdate === 'session_info_update' && u.title) ctx.setTitle(u.title);
  };

  const params = { cwd: session.cwd, mcpServers: [] };
  const prevId = ctx.state.acpSessionId;
  let result = null;
  let how = 'new';
  if (prevId && caps.sessionCapabilities?.resume) {
    try {
      result = await conn.request('session/resume', { ...params, sessionId: prevId });
      how = 'resume';
    } catch (err) {
      if (isAuthError(err)) return fail(authError(agent, init));
    }
  }
  if (how === 'new' && prevId && caps.loadSession) {
    conn.replaying = true;
    try {
      result = await conn.request('session/load', { ...params, sessionId: prevId });
      how = 'load';
    } catch (err) {
      if (isAuthError(err)) return fail(authError(agent, init));
    } finally {
      conn.replaying = false;
    }
  }
  if (how === 'new') {
    try {
      result = await conn.request('session/new', params);
    } catch (err) {
      return fail(isAuthError(err) ? authError(agent, init) : err);
    }
    conn.acpSessionId = result.sessionId;
    ctx.state.acpSessionId = result.sessionId;
  } else {
    conn.acpSessionId = prevId;
  }

  const meta = {
    agentInfo: init.agentInfo || { name: agent.name },
    protocol: `ACP v${init.protocolVersion ?? PROTOCOL_VERSION}`,
    acpSessionId: conn.acpSessionId,
    imageInput: !!caps.promptCapabilities?.image,
  };
  if (result?.modes) meta.modes = result.modes;
  if (result?.configOptions) meta.configOptions = result.configOptions;
  ctx.setMeta(meta);
  const info = init.agentInfo ? `${init.agentInfo.title || init.agentInfo.name} ${init.agentInfo.version || ''}`.trim() : agent.name;
  ctx.emit({
    type: 'info',
    text: `已連線 ${info} · ${meta.protocol}${how === 'resume' || how === 'load' ? ' · 已續接先前的對話' : ''}`,
  });
  return { conn, fresh: how === 'new' };
}

function authError(agent, init) {
  const hint = loginHint(agent, init);
  const method = init?.authMethods?.[0]?.name;
  return Object.assign(
    new Error(
      `${agent.name} 尚未登入${method ? `（${method}）` : ''}。請在終端機執行 \`${hint}\` 完成登入（可使用訂閱帳號），或點設定裡的「登入」按鈕，然後再送出一次訊息。`,
    ),
    { auth: true },
  );
}

// ------------------------------------------------------------ interface

export function available(agent) {
  if (!agent.command) return { ok: false, reason: '尚未設定啟動指令' };
  if (!commandExists(agent.command)) {
    return { ok: false, reason: `找不到指令「${agent.command}」${agent.install ? `，安裝方式：${agent.install}` : ''}` };
  }
  return { ok: true };
}

export async function run(ctx, text, { images = [] } = {}) {
  const { session, agent } = ctx;
  let conn = connections.get(session.id);
  if (conn && (!conn.alive || conn.agentKey !== JSON.stringify([agent.command, agent.args, agent.env]))) {
    conn.kill();
    conn = null;
  }
  let preamble = '';
  if (!conn) {
    const r = await connect(ctx);
    conn = r.conn;
    // The agent could not restore the old conversation: give it a transcript.
    const history = ctx.previousTranscript();
    if (r.fresh && history) {
      preamble = `<previous_conversation>\n${history}\n</previous_conversation>\n\nContinue from the conversation above.\n\n`;
    }
  }
  clearTimeout(conn.idleTimer);

  const sink = new TurnSink(ctx);
  const baseOnUpdate = conn.onUpdate;
  conn.onUpdate = (u) => {
    baseOnUpdate?.(u);
    if (!conn.replaying) sink.update(u);
  };
  conn.onPermission = (params) => sink.permission(params);

  let cancelTimer;
  const onAbort = () => {
    conn.notify('session/cancel', { sessionId: conn.acpSessionId });
    // Agents must answer the prompt with stopReason "cancelled"; if one
    // doesn't, stop waiting and restart it next turn.
    cancelTimer = setTimeout(() => conn.kill(), 8000);
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  const prompt = [{ type: 'text', text: preamble + text }];
  for (const img of images) prompt.push({ type: 'image', data: img.data, mimeType: img.mimeType });

  try {
    const res = await Promise.race([
      conn.request('session/prompt', { sessionId: conn.acpSessionId, prompt }),
      conn.exited.then((e) => Promise.reject(e)),
    ]);
    if (res.usage) ctx.addUsage({ inputTokens: res.usage.inputTokens || 0, outputTokens: res.usage.outputTokens || 0 });
    const notes = {
      max_tokens: '已達到輸出 token 上限',
      max_turn_requests: '已達到單回合請求次數上限',
      refusal: 'Agent 拒絕繼續此請求',
    };
    if (notes[res.stopReason]) ctx.emit({ type: 'info', text: notes[res.stopReason] });
  } catch (err) {
    if (isAuthError(err)) {
      conn.kill();
      throw authError(agent, conn.init);
    }
    throw err;
  } finally {
    clearTimeout(cancelTimer);
    ctx.signal.removeEventListener('abort', onAbort);
    conn.onUpdate = baseOnUpdate;
    conn.onPermission = null;
    if (conn.alive) conn.touch();
  }
}

export async function configure(session, change) {
  const conn = connections.get(session.id);
  if (!conn?.alive || !conn.acpSessionId) throw Object.assign(new Error('Agent 尚未啟動，請先送出一則訊息'), { status: 409 });
  if (change.modeId) {
    await conn.request('session/set_mode', { sessionId: conn.acpSessionId, modeId: change.modeId });
    return session.meta?.modes ? { modes: { ...session.meta.modes, currentModeId: change.modeId } } : null;
  }
  if (change.configId) {
    const params = { sessionId: conn.acpSessionId, configId: change.configId, value: change.value };
    if (typeof change.value === 'boolean') params.type = 'boolean';
    const res = await conn.request('session/set_config_option', params);
    if (res?.configOptions) return { configOptions: res.configOptions };
    const configOptions = (session.meta?.configOptions || []).map((o) => (o.id === change.configId ? { ...o, currentValue: change.value } : o));
    return { configOptions };
  }
  return null;
}

export function dispose(session) {
  connections.get(session.id)?.kill();
  connections.delete(session.id);
}

export function disposeAll() {
  for (const conn of connections.values()) conn.kill();
  connections.clear();
}

export async function test(agent) {
  if (!commandExists(agent.command)) throw new Error(available(agent).reason);
  const conn = new AcpConnection(agent, process.cwd());
  try {
    await conn.ready;
    const init = await Promise.race([
      conn.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      }),
      conn.exited.then((e) => Promise.reject(e)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('60 秒內沒有回應')), 60_000)),
    ]);
    const name = init.agentInfo ? `${init.agentInfo.title || init.agentInfo.name} ${init.agentInfo.version || ''}`.trim() : agent.name;
    // Creating a throwaway session is the only portable way to check login.
    try {
      const s = await conn.request('session/new', { cwd: process.cwd(), mcpServers: [] });
      if (init.agentCapabilities?.sessionCapabilities?.delete) {
        await conn.request('session/delete', { sessionId: s.sessionId }).catch(() => {});
      }
      return `連線成功：${name}（ACP v${init.protocolVersion}），已登入，可以使用。`;
    } catch (err) {
      if (isAuthError(err)) return `已連上 ${name}（ACP v${init.protocolVersion}），但尚未登入：請執行 \`${loginHint(agent, init)}\`。`;
      throw err;
    }
  } finally {
    conn.kill();
  }
}

export { loginHint };
