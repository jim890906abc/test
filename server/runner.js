// The session runner: owns turn execution, the permission gate, interrupts,
// sub-agent delegation, hand-offs and compare groups. Adapters only translate
// between a vendor's agent and the hub's normalized event stream.
import * as store from './store.js';
import { TOOL_DEFS, toolKind, validateInput, executeTool } from './tools.js';
import { ADAPTERS } from './adapters/index.js';
import { createWorkspace, createWorktree, isGitRepo } from './workspace.js';
import * as machines from './machines.js';

let broadcast = () => {};
export function setBroadcast(fn) {
  broadcast = fn;
}

const running = new Map(); // sessionId -> { ac }
const pendingPermissions = new Map(); // `${sid}:${eventId}` -> resolve(decision)

export function summarize(s) {
  return {
    id: s.id,
    title: s.title,
    agentId: s.agentId,
    status: s.status,
    cwd: s.cwd,
    branch: s.branch,
    parentId: s.parentId,
    groupId: s.groupId,
    permissionMode: s.permissionMode,
    machineId: s.machineId,
    kimiSessionId: s.kimiSessionId,
    meta: s.meta,
    usage: s.usage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function setStatus(session, status) {
  if (session.status === status) return;
  session.status = status;
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
}

// ----------------------------------------------------------- event helpers

function emit(session, fields) {
  const ev = { id: store.newId('e_'), ts: Date.now(), ...fields };
  session.events.push(ev);
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  broadcast({ t: 'event', sid: session.id, seq: session.seq, ev });
  return ev;
}

function patch(session, ev, fields) {
  Object.assign(ev, fields);
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  broadcast({ t: 'patch', sid: session.id, seq: session.seq, id: ev.id, fields });
}

function delta(session, ev, text, field = 'text') {
  if (!text) return;
  ev[field] = (ev[field] || '') + text;
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  broadcast({ t: 'delta', sid: session.id, seq: session.seq, id: ev.id, field, text });
}

// ----------------------------------------------------------- agents

// Agents come from the store, plus one virtual "Kimi Code" agent per machine
// connected through the bridge.
export function remoteAgents() {
  return machines.listMachines().map((m) => ({
    id: `kimi@${m.id}`,
    name: `Kimi Code · ${m.name}`,
    type: 'kimi-remote',
    machineId: m.id,
    color: '#1a73e8',
    enabled: true,
    remote: true,
    description: `${m.name} 上的 Kimi Code（透過連接器，使用那台機器登入的 Kimi 帳號）`,
  }));
}

export function agentFor(id) {
  if (String(id).startsWith('kimi@')) return remoteAgents().find((a) => a.id === id) || null;
  return store.getAgent(id);
}

const adapterFor = (session) => ADAPTERS[agentFor(session.agentId)?.type];

// Context for live adapters (Kimi on a remote machine), which push events at
// any time rather than only inside a hub-started turn.
export function liveContext(session) {
  return {
    session,
    emit: (fields) => emit(session, fields),
    patch: (ev, fields) => patch(session, ev, fields),
    delta: (ev, text, field) => delta(session, ev, text, field),
    setStatus: (st) => setStatus(session, st),
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    setTitle(title) {
      if (!title || title === session.title) return;
      session.title = title;
      session.titled = true;
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    replaceEvents(events) {
      session.events = events;
      session.seq = (session.seq || 0) + 1;
      store.saveSession(session);
      broadcast({ t: 'reset', sid: session.id, seq: session.seq });
    },
  };
}
ADAPTERS['kimi-remote'].init(liveContext);

export function restoreLiveSessions() {
  for (const s of store.listSessions()) if (s.kimiSessionId) ADAPTERS['kimi-remote'].restore(s);
  machines.onMachineOnline((machineId) => ADAPTERS['kimi-remote'].onMachineOnline(machineId, store.listSessions()));
}

// Plain-text transcript of a session, used for hand-offs and for CLI agents
// that cannot resume their own conversation.
export function transcriptText(session, { maxChars = 12_000, beforeIndex } = {}) {
  const parts = [];
  for (const ev of session.events.slice(0, beforeIndex ?? session.events.length)) {
    if (ev.type === 'user') parts.push(`User: ${ev.text}`);
    else if (ev.type === 'text' && ev.text?.trim()) parts.push(`Assistant: ${ev.text.trim()}`);
    else if (ev.type === 'tool_use') parts.push(`[tool ${ev.name}: ${ev.title || JSON.stringify(ev.input ?? {}).slice(0, 200)}]`);
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = `…${text.slice(-maxChars)}`;
  return text;
}

// --------------------------------------------------------------- tools

function delegateDef(session) {
  const others = store
    .listAgents()
    .filter((a) => a.enabled && a.id !== session.agentId && ADAPTERS[a.type]?.available(a).ok);
  if (!others.length || (session.depth ?? 0) > 0) return null;
  return {
    name: 'delegate_to_agent',
    kind: 'delegate',
    description:
      'Hand a self-contained sub-task to another agent connected to the hub. It works in the same workspace and its final answer is returned to you. Use it to get a second opinion, parallelize, or use a specialist. Available agents:\n' +
      others.map((a) => `- ${a.id}: ${a.name} (${a.type}${a.model ? `, ${a.model}` : ''})`).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', enum: others.map((a) => a.id), description: 'Which agent to delegate to.' },
        task: { type: 'string', description: 'A complete, self-contained description of the sub-task.' },
      },
      required: ['agent_id', 'task'],
    },
  };
}

export function toolDefsFor(session) {
  const d = delegateDef(session);
  return d ? [...TOOL_DEFS, d] : [...TOOL_DEFS];
}

function needsPermission(session, name) {
  if (session.allowedTools?.includes(name)) return false;
  const kind = toolKind(name);
  if (kind === 'read') return false;
  if (session.permissionMode === 'bypass') return false;
  if (session.permissionMode === 'auto_edits' && kind === 'edit') return false;
  return true;
}

export function toolTitle(name, input = {}) {
  switch (name) {
    case 'bash':
      return input.command;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return input.path;
    case 'list_files':
      return input.path || '.';
    case 'search':
      return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'delegate_to_agent':
      return `→ ${input.agent_id}: ${String(input.task || '').slice(0, 120)}`;
    default:
      return typeof input === 'string' ? input : JSON.stringify(input).slice(0, 160);
  }
}

// --------------------------------------------------------------- turns

function makeContext(session, agent, ac) {
  const ctx = {
    session,
    agent,
    cwd: session.cwd,
    signal: ac.signal,
    state: session.state,
    turnUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    emit: (fields) => emit(session, fields),
    patch: (ev, fields) => patch(session, ev, fields),
    delta: (ev, text, field) => delta(session, ev, text, field),
    addUsage({ inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
      ctx.turnUsage.inputTokens += inputTokens;
      ctx.turnUsage.outputTokens += outputTokens;
      ctx.turnUsage.costUsd += costUsd;
    },
    toolDefs: () => toolDefsFor(session),
    // Show a choice on the tool card and wait for the user. `options` follow
    // the ACP PermissionOption shape ({ optionId, name, kind }), so an ACP
    // agent's own buttons are shown verbatim. Resolves to the chosen optionId,
    // or null if the turn was interrupted.
    async askUser(ev, options) {
      const prevStatus = ev.status;
      patch(session, ev, { status: 'awaiting', permission: { options, chosen: null } });
      setStatus(session, 'awaiting_permission');
      const key = `${session.id}:${ev.id}`;
      const chosen = await new Promise((resolve) => {
        if (ac.signal.aborted) return resolve(null);
        pendingPermissions.set(key, resolve);
        ac.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      pendingPermissions.delete(key);
      if (!ac.signal.aborted) setStatus(session, 'running');
      patch(session, ev, {
        status: prevStatus === 'awaiting' ? 'pending' : prevStatus,
        permission: { options, chosen: chosen ?? 'cancelled' },
      });
      return chosen;
    },
    // Permission gate for hub-provided tools. Resolves to 'allow' | 'deny'.
    async requestPermission(ev) {
      if (!needsPermission(session, ev.name)) return 'allow';
      const chosen = await ctx.askUser(ev, [
        { optionId: 'allow', name: '允許', kind: 'allow_once' },
        { optionId: 'always', name: `本 session 一律允許 ${ev.name}`, kind: 'allow_always' },
        { optionId: 'deny', name: '拒絕', kind: 'reject_once' },
      ]);
      if (chosen === 'always' && !session.allowedTools.includes(ev.name)) session.allowedTools.push(ev.name);
      return chosen === 'allow' || chosen === 'always' ? 'allow' : 'deny';
    },
    // Agent-reported metadata (modes, models, slash commands, context usage)
    // shown in the UI next to the composer.
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    setTitle(title) {
      if (!title) return;
      session.title = title;
      session.titled = true;
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    // Validate → permission → execute → record, for hub-provided tools.
    async runTool(name, input, ev) {
      ev ??= emit(session, { type: 'tool_use', name, input, title: toolTitle(name, input), status: 'pending' });
      const def = toolDefsFor(session).find((t) => t.name === name);
      if (!def) {
        patch(session, ev, { status: 'error', output: `Unknown tool "${name}"`, isError: true });
        return { output: `Unknown tool "${name}"`, isError: true };
      }
      const invalid = validateInput(def.parameters, input);
      if (invalid) {
        const output = `Invalid input: ${invalid}. Received: ${JSON.stringify(input).slice(0, 500)}`;
        patch(session, ev, { status: 'error', output, isError: true });
        return { output, isError: true };
      }
      const decision = await ctx.requestPermission(ev);
      if (decision === 'deny') {
        const output = ac.signal.aborted ? 'Interrupted by user.' : 'The user denied this tool call. Ask them how to proceed or try a different approach.';
        patch(session, ev, { status: ac.signal.aborted ? 'interrupted' : 'denied', output, isError: true });
        return { output, isError: true };
      }
      patch(session, ev, { status: 'running', output: '' });
      let result;
      if (name === 'delegate_to_agent') {
        result = await delegate(session, input, ev, ac.signal);
      } else {
        let pending = '';
        let timer = null;
        result = await executeTool(name, input, {
          cwd: session.cwd,
          signal: ac.signal,
          // Stream long-running command output into the card, batched.
          onData: (chunk) => {
            pending += chunk;
            timer ??= setTimeout(() => {
              delta(session, ev, pending, 'output');
              pending = '';
              timer = null;
            }, 150);
          },
        });
        clearTimeout(timer);
      }
      patch(session, ev, { status: result.isError ? 'error' : 'done', output: result.output, isError: result.isError });
      return result;
    },
    previousTranscript: () => transcriptText(session, { beforeIndex: ctx.turnStartIndex - 1 }),
    turnStartIndex: 0,
  };
  return ctx;
}

async function delegate(parent, input, ev, signal) {
  const agent = store.getAgent(input.agent_id);
  if (!agent) return { output: `No agent with id "${input.agent_id}"`, isError: true };
  const child = store.createSession({
    agentId: agent.id,
    cwd: parent.cwd,
    branch: parent.branch,
    parentId: parent.id,
    depth: (parent.depth ?? 0) + 1,
    permissionMode: parent.permissionMode,
    title: String(input.task).slice(0, 80),
  });
  broadcast({ t: 'session', session: summarize(child) });
  patch(parent, ev, { childSessionId: child.id });
  const onAbort = () => interrupt(child.id);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const { text, error } = await runTurn(child, input.task);
    if (error) return { output: `${agent.name} failed: ${error}\n${text}`.trim(), isError: true };
    return { output: text || `(${agent.name} finished without a text answer)`, isError: false };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function runTurn(session, text, opts = {}) {
  if (running.has(session.id)) throw Object.assign(new Error('這個 session 正在執行中'), { status: 409 });
  const agent = agentFor(session.agentId);
  if (!agent) throw Object.assign(new Error(`找不到 agent：${session.agentId}`), { status: 400 });
  const adapter = ADAPTERS[agent.type];
  if (!adapter) throw Object.assign(new Error(`不支援的 agent 類型：${agent.type}`), { status: 400 });

  const ac = new AbortController();
  running.set(session.id, { ac });
  const images = (opts.images || []).slice(0, 8);
  emit(session, { type: 'user', text, images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) });
  if (!session.titled) {
    session.title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || session.title;
    session.titled = true;
  }
  setStatus(session, 'running');

  const ctx = makeContext(session, agent, ac);
  ctx.turnStartIndex = session.events.length;
  const started = Date.now();
  let error = null;
  try {
    const availability = adapter.available(agent);
    if (!availability.ok) throw new Error(availability.reason);
    await adapter.run(ctx, text, { images });
  } catch (err) {
    if (ac.signal.aborted) {
      emit(session, { type: 'info', text: '已中斷' });
    } else {
      error = err.message || String(err);
      emit(session, { type: 'error', text: error });
    }
  } finally {
    running.delete(session.id);
    for (const ev of session.events.slice(ctx.turnStartIndex)) {
      // Tool calls the agent never closed: interrupted if the user stopped
      // the turn, otherwise left neutral rather than guessing an outcome.
      if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) {
        patch(session, ev, { status: ac.signal.aborted || ev.status === 'awaiting' ? 'interrupted' : 'ended' });
      }
    }
    const u = ctx.turnUsage;
    session.usage.inputTokens += u.inputTokens;
    session.usage.outputTokens += u.outputTokens;
    session.usage.costUsd += u.costUsd;
    emit(session, { type: 'turn_end', durationMs: Date.now() - started, usage: u, interrupted: ac.signal.aborted, error: Boolean(error) });
    setStatus(session, error ? 'error' : 'idle');
    store.saveSession(session, { immediate: true });
  }
  const turnText = session.events
    .slice(ctx.turnStartIndex)
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('\n\n')
    .trim();
  return { text: turnText, error };
}

// Fire-and-forget entry point for HTTP handlers.
export function startTurn(session, text, opts) {
  const adapter = adapterFor(session);
  if (adapter?.live) {
    if (['running', 'awaiting_permission'].includes(session.status)) throw Object.assign(new Error('Kimi 正在處理中，請等它完成或先中斷'), { status: 409 });
    adapter.send(session, text, opts).catch((err) => {
      emit(session, { type: 'error', text: err.message });
      setStatus(session, 'idle');
    });
    return;
  }
  if (running.has(session.id)) throw Object.assign(new Error('這個 session 正在執行中'), { status: 409 });
  runTurn(session, text, opts).catch((err) => console.error(`[runner] ${session.id}:`, err));
}

export function isRunning(id) {
  return running.has(id);
}

export function interrupt(id) {
  running.get(id)?.ac.abort();
  const session = store.getSession(id);
  const adapter = session && adapterFor(session);
  if (adapter?.live) return adapter.interrupt(session);
}

export async function resolvePermission(sid, eventId, optionId) {
  const resolve = pendingPermissions.get(`${sid}:${eventId}`);
  if (resolve) {
    resolve(String(optionId));
    return true;
  }
  const session = store.getSession(sid);
  const adapter = session && adapterFor(session);
  if (adapter?.live) return adapter.respond(session, eventId, String(optionId));
  return false;
}

// Mode / model / config changes requested from the UI, forwarded to adapters
// that support them (ACP agents).
export async function configure(session, change) {
  const adapter = adapterFor(session);
  if (!adapter?.configure) throw Object.assign(new Error('此 agent 不支援切換設定'), { status: 400 });
  const meta = await adapter.configure(session, change);
  if (meta) {
    session.meta = { ...(session.meta || {}), ...meta };
    store.saveSession(session);
    broadcast({ t: 'session', session: summarize(session) });
  }
}

export function disposeSession(session) {
  running.get(session.id)?.ac.abort();
  adapterFor(session)?.dispose?.(session);
}

// ------------------------------------------------------- session creation

export async function newSession({ agentId, cwd, prompt, nameHint, permissionMode = 'ask', groupId, branch, title }) {
  const agent = agentFor(agentId);
  if (!agent) throw Object.assign(new Error(`找不到 agent：${agentId}`), { status: 400 });
  let session;
  if (agent.type === 'kimi-remote') {
    const availability = ADAPTERS['kimi-remote'].available(agent);
    if (!availability.ok) throw Object.assign(new Error(availability.reason), { status: 409 });
    const r = await ADAPTERS['kimi-remote'].createRemote({ machineId: agent.machineId, cwd, nameHint: nameHint || prompt });
    session = store.createSession({ agentId, cwd: r.cwd, machineId: agent.machineId, kimiSessionId: r.kimiSessionId, permissionMode, groupId, title: title || 'New session' });
    ADAPTERS['kimi-remote'].restore(session);
    await ADAPTERS['kimi-remote'].attach(session);
  } else {
    const dir = cwd || (await createWorkspace(nameHint || prompt || agent.name));
    session = store.createSession({ agentId, cwd: dir, permissionMode, groupId, branch, title: title || 'New session' });
  }
  broadcast({ t: 'session', session: summarize(session) });
  if (prompt) startTurn(session, prompt);
  return session;
}

// Same prompt to several agents, each in its own workspace (fresh folders, or
// git worktrees of an existing repo), shown side by side in the UI.
export async function newCompareGroup({ agentIds, prompt, cwd, permissionMode = 'ask' }) {
  if (!agentIds?.length) throw Object.assign(new Error('請至少選擇一個 agent'), { status: 400 });
  const groupId = store.newId('g_');
  const sessions = [];
  const git = cwd ? await isGitRepo(cwd) : false;
  for (const agentId of agentIds) {
    let dir;
    let branch;
    if (agentFor(agentId)?.type === 'kimi-remote') dir = undefined;
    else if (!cwd) dir = await createWorkspace(`${prompt}-${agentId}`);
    else if (git) ({ dir, branch } = await createWorktree(cwd, agentId));
    else dir = cwd;
    const s = await newSession({ agentId, cwd: dir, branch, permissionMode, groupId, nameHint: prompt });
    if (cwd && !git && dir) emit(s, { type: 'info', text: '此資料夾不是 git repo，所有 agent 共用同一個工作區' });
    sessions.push(s);
  }
  for (const s of sessions) startTurn(s, prompt);
  return { groupId, sessions: sessions.map(summarize) };
}

export async function handoff(from, { agentId, text }) {
  const prev = agentFor(from.agentId);
  const target = agentFor(agentId);
  // A workspace can only be shared with an agent on the same machine.
  const sameMachine = (target?.machineId || null) === (from.machineId || null);
  const transcript = transcriptText(from);
  const prompt =
    `You are taking over a task that another agent (${prev?.name ?? from.agentId}) was working on in this same workspace.\n` +
    `Here is the conversation so far:\n\n<previous_conversation>\n${transcript}\n</previous_conversation>\n\n` +
    (text?.trim() ? `New request from the user:\n${text.trim()}` : 'Review the current state of the workspace and continue the task.');
  const s = await newSession({ agentId, cwd: sameMachine ? from.cwd : undefined, branch: from.branch, permissionMode: from.permissionMode, title: `${from.title}`, nameHint: from.title });
  s.handoffFrom = from.id;
  s.titled = true;
  startTurn(s, prompt);
  return s;
}

// Take over a Kimi session that already exists on a machine (e.g. one handed
// to the local Kimi server with /web). Reuses the hub session if attached.
export async function attachKimi(machineId, kimiSessionId) {
  const existing = ADAPTERS['kimi-remote'].findByKimi(machineId, kimiSessionId);
  if (existing && store.getSession(existing)) {
    const s = store.getSession(existing);
    await ADAPTERS['kimi-remote'].attach(s).catch(() => {});
    return s;
  }
  const info = await machines.kimiApi(machineId, 'GET', `/api/v1/sessions/${kimiSessionId}`);
  const session = store.createSession({
    agentId: `kimi@${machineId}`,
    machineId,
    kimiSessionId,
    cwd: info.metadata?.cwd,
    title: info.title || info.last_prompt || 'Kimi 對話',
    titled: true,
  });
  ADAPTERS['kimi-remote'].restore(session);
  broadcast({ t: 'session', session: summarize(session) });
  await ADAPTERS['kimi-remote'].attach(session, { force: true });
  return session;
}
