// Kimi Code sessions on remote machines, driven through the bridge and Kimi's
// own Server API (`kimi web`). The adapter is *live*: a hub session mirrors a
// Kimi session continuously, so turns started in Kimi's own UI, approvals
// answered elsewhere, subagents and the Kimi-side title all show up in the
// hub as they happen.
import crypto from 'node:crypto';
import * as machines from '../machines.js';
import * as store from '../store.js';

export const live = true;

const mirrors = new Map(); // hub session id -> Mirror
const byKimi = new Map(); // `${machineId}:${kimiSessionId}` -> hub session id
let liveContext = null; // injected by the runner (avoids an import cycle)

export function init(makeContext) {
  liveContext = makeContext;
}

const APPROVAL_OPTIONS = [
  { optionId: 'approved', name: '允許', kind: 'allow_once' },
  { optionId: 'approved_session', name: '這個對話都允許', kind: 'allow_always' },
  { optionId: 'rejected', name: '拒絕', kind: 'reject_once' },
];
const PERMISSIONS = ['manual', 'yolo', 'auto'];
// Turns loaded when a conversation is opened, and per 「載入更早的對話」.
const HISTORY_TURNS = 10;
// A conversation nobody has open, that is not working, stops following the
// machine after this long; opening it again catches up from Kimi's journal.
const IDLE_FOLLOW_MS = 15 * 60_000;
const MAX_IMAGE_URL = 600_000; // history images larger than this become a placeholder
// How often a message waiting to cut in (插隊) is offered to Kimi again.
const CUT_IN_RETRY_MS = 2000;
// How long an urgent message Kimi has taken in may wait for foreground work
// before that work is moved to the background (Ctrl+B).
const URGENT_DETACH_MS = 10_000 * (Number(process.env.AGENT_HUB_AUTOPAUSE_SCALE) || 1);

export function available(agent) {
  const m = machines.getMachine(agent.machineId);
  if (!m) return { ok: false, reason: '找不到這台電腦' };
  if (!m.online) return { ok: false, reason: `「${m.name}」目前離線。在那台電腦上執行連接器` };
  return { ok: true };
}

// Starting or messaging a conversation from the hub needs `kimi web` on the
// machine; the bridge starts one in the background when there is none.
export async function ensureServer(machineId) {
  const m = machines.getMachine(machineId);
  if (m?.kimi?.server) return;
  const st = await machines.rpc(machineId, 'kimi.start', {}, 40_000);
  if (m) m.kimi = st;
}

const modelCache = new Map(); // machine id -> { at, models, defaultModel }
async function machineModels(machineId) {
  const c = modelCache.get(machineId);
  if (c && Date.now() - c.at < 60_000) return c;
  const [config, list] = await Promise.all([
    machines.kimiApi(machineId, 'GET', '/api/v1/config').catch(() => ({})),
    machines.kimiApi(machineId, 'GET', '/api/v1/models'),
  ]);
  const v = { at: Date.now(), defaultModel: config.default_model || '', models: (list.items || []).map(modelInfo) };
  modelCache.set(machineId, v);
  // K3-256k is the default model in 設定 unless one was chosen (once).
  store.migrateSettings('model-k3-256k', (d) => {
    const k3 = v.models.find((m) => /k3[-_ ]?256k/i.test(`${m.id} ${m.name}`));
    if (!k3) return false;
    if (!d.model) d.model = k3.id;
  });
  return v;
}
export const modelsFor = (machineId) => machineModels(machineId).then(({ models, defaultModel }) => ({ models, defaultModel }));

// --------------------------------------------------------------- helpers

function toolTitle(name, input, display) {
  if (display?.kind === 'command') return display.command;
  if (display?.kind === 'agent_call') return display.prompt?.split('\n')[0] || name;
  if (display?.path) return display.path;
  if (display?.kind === 'search') return display.query;
  if (display?.kind === 'url_fetch') return display.url;
  if (display?.kind === 'skill_call') return `/${display.skill_name}${display.args ? ` ${display.args}` : ''}`;
  if (input == null || typeof input !== 'object') return name;
  return input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || input.skill || name;
}

function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const texts = output.map((p) => (typeof p === 'string' ? p : p?.text)).filter((t) => typeof t === 'string');
    if (texts.length === output.length) return texts.join('\n');
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

const contentText = (parts) => (parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

function contentImages(parts) {
  return (parts || [])
    .filter((p) => p.type === 'image')
    .map((p) => {
      const s = p.source || {};
      if (s.kind === 'url' && /^data:image\//.test(s.url) && s.url.length < MAX_IMAGE_URL) return s.url;
      if (s.kind === 'base64' && s.data && s.data.length < MAX_IMAGE_URL) return `data:${s.media_type};base64,${s.data}`;
      return null; // shown as a placeholder
    });
}

// The thinking-effort choices Kimi's own /effort picker offers for a model.
function effortsFor(model) {
  const caps = model.capabilities || [];
  const efforts = model.support_efforts || [];
  const always = caps.includes('always_thinking');
  if (efforts.length) return always ? efforts : ['off', ...efforts];
  if (always) return ['on'];
  if (caps.includes('thinking') || model.adaptive_thinking) return ['off', 'on'];
  return [];
}

export const modelInfo = (m) => ({
  id: m.model,
  name: m.display_name || m.model.split('/').pop(),
  efforts: effortsFor(m),
  defaultEffort: m.default_effort || null,
  image: (m.capabilities || []).includes('image_in'),
  context: m.max_context_size || null,
});

// Text a user typed (or a slash command) for a turn Kimi started.
function promptLabel(p) {
  const o = p.origin || {};
  if (o.kind === 'skill_activation') return `/${o.skillName}${o.skillArgs ? ` ${o.skillArgs}` : ''}`;
  if (o.kind === 'plugin_command') return `/${o.commandName}${o.commandArgs ? ` ${o.commandArgs}` : ''}`;
  if (o.kind === 'shell_command') return `! ${p.prompt || ''}`;
  if (o.kind === 'user') return p.prompt || '';
  return null;
}

const now = () => Date.now();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newPromptId = () => `hub_${crypto.randomBytes(9).toString('hex')}`;

// ---------------------------------------------------------------- mirror

class Mirror {
  constructor(session) {
    this.session = session;
    this.machineId = session.machineId;
    this.kid = session.kimiSessionId;
    this.mine = new Set(session.state.mine || []); // prompt ids sent from the hub
    this.live = false; // subscribed to the machine and caught up
    this.viewedAt = 0; // last time someone had it open
    this.reset();
  }

  reset() {
    this.blocks = new Map(); // agentId -> open text/thinking block { type, turnId, ev }
    this.tools = new Map(); // `${agentId}:${toolCallId}` -> ev
    this.agents = new Map(); // subagent id -> { parent: event id, btw? }
    this.early = new Map(); // subagent id -> frames that arrived before subagent.spawned
    this.turn = null;
  }

  // While replaying history, events collect in a batch instead of being
  // broadcast one by one.
  get ctx() {
    return this.batch?.ctx || liveContext(this.session);
  }

  events() {
    return this.batch ? this.batch.events : this.session.events;
  }

  // The machine's view of this conversation: busy, and who runs it.
  entry() {
    return machines.getMachine(this.machineId)?.sessions?.find((s) => s.id === this.kid) || null;
  }

  inTerminal() {
    return (this.entry()?.owner || this.session.meta?.owner) === 'tui';
  }

  api(method, p, body) {
    return machines.kimiApi(this.machineId, method, p, body);
  }

  path(p = '') {
    return `/api/v1/sessions/${this.kid}${p}`;
  }

  // Shallow meta update that only broadcasts what actually changed.
  meta(fields) {
    const cur = this.session.meta || {};
    const changed = {};
    for (const [k, v] of Object.entries(fields)) if (!same(cur[k], v)) changed[k] = v;
    if (Object.keys(changed).length) this.ctx.setMeta(changed);
  }

  // Subscribe, then rebuild the conversation from Kimi's own journal (read
  // by the bridge, one round trip). Falls back to the server's message API
  // for bridges that cannot read the journal.
  async attach() {
    await machines.rpc(this.machineId, 'kimi.subscribe', { sessionIds: [this.kid] });
    const machine = machines.getMachine(this.machineId);
    this.meta({ machineName: machine?.name || '', kimiVersion: machine?.kimi?.version || '' });
    let info = null;
    try {
      const h = await machines.rpc(this.machineId, 'kimi.history', { sessionId: this.kid, turns: HISTORY_TURNS }, 30_000);
      this.replay(h.frames, { more: h.more, before: h.before });
      info = h.info;
    } catch (err) {
      if (!machine?.kimi?.server) throw err;
      await this.importHistory();
      info = await this.api('GET', this.path()).catch(() => null);
    }
    if (info) this.applyInfo(info);
    await Promise.all([this.loadModels(), this.loadSkills(info?.workspace_id)].map((p) => p.catch(() => {})));
    this.touch();
    this.live = true;
    // Waiting to cut in from before (the hub restarted meanwhile).
    if (this.queue().some((q) => q.cutIn && !q.steered)) this.retryCutIns();
    await this.applyDefaults();
  }

  // The first time the hub opens a conversation, it gets the model,
  // thinking and permission from 設定 (plan mode is left as it was).
  // Changed afterwards in the conversation, it stays changed.
  async applyDefaults() {
    if (this.session.state.defaultsApplied || this.inTerminal()) return;
    const d = store.readSettings().defaults || {};
    const meta = this.session.meta || {};
    const change = {};
    const model = d.model && (meta.models || []).find((x) => x.id === d.model);
    if (model && meta.model !== d.model) change.model = d.model;
    const efforts = (model || (meta.models || []).find((x) => x.id === meta.model))?.efforts || [];
    if (d.effort && efforts.includes(d.effort) && meta.effort !== d.effort) change.effort = d.effort;
    if (PERMISSIONS.includes(d.permission) && meta.permission !== d.permission) change.permission = d.permission;
    this.session.state.defaultsApplied = true;
    store.saveSession(this.session);
    if (!Object.keys(change).length) return;
    await this.configure(change).catch((err) => console.warn(`[kimi] defaults for ${this.session.id}: ${err.message}`));
  }

  // Follow the machine again before acting on a conversation that stopped.
  async ensureLive() {
    this.viewedAt = now();
    if (!this.live) await (this.attaching ??= this.attach().finally(() => (this.attaching = null)));
  }

  busy() {
    return ['running', 'awaiting_permission'].includes(this.session.status) || this.queue().length > 0 || (this.tuiPending?.length ?? 0) > 0;
  }

  // Stop following a conversation nobody is looking at (frees the machine
  // from polling and streaming it).
  release() {
    if (!this.live || this.busy() || now() - this.viewedAt < IDLE_FOLLOW_MS) return;
    this.live = false;
    machines.rpc(this.machineId, 'kimi.unsubscribe', { sessionIds: [this.kid] }).catch(() => {});
  }

  // Conversation state as the bridge sees it on disk (or the server reports).
  applyInfo(info) {
    if (info.title) this.ctx.setTitle(info.title);
    const busy = Boolean(info.busy);
    const pending = info.pending_interaction && info.pending_interaction !== 'none';
    this.ctx.setStatus(busy ? (pending ? 'awaiting_permission' : 'running') : info.last_turn_reason === 'failed' ? 'error' : 'idle');
    const f = { owner: info.owner || null, controllable: info.controllable ?? null, guess: Boolean(info.guess) };
    if (Array.isArray(info.todos)) f.todos = info.todos;
    this.meta(f);
    this.applyStatus({ model: info.model, effort: info.effort, permission: info.permission, contextTokens: info.contextTokens || undefined });
  }

  touch() {
    this.session.state.syncedAt = now();
  }

  remember(promptId, note) {
    this.mine.add(promptId);
    this.session.state.mine = [...this.mine].slice(-50);
    // What the hub said about a message it sent ("從 Artifact 送出", "自動暫停…"),
    // kept so the note is still there when the conversation is rebuilt
    // from Kimi's journal.
    if (note) this.session.state.notes = Object.fromEntries([...Object.entries(this.session.state.notes || {}), [promptId, note]].slice(-50));
  }

  async loadModels() {
    const { models, defaultModel } = await machineModels(this.machineId);
    // Sessions created over the API do not pick up Kimi's default model by
    // themselves, so it is sent with prompts until the session has one.
    this.defaultModel = defaultModel;
    this.meta({ models, defaultModel });
    this.applyStatus({});
  }

  applyStatus({ model, effort, permission, planMode, context, contextTokens }) {
    const f = {};
    if (model !== undefined && model !== null) f.model = model || '';
    if (effort !== undefined && effort !== null) f.effort = effort || 'off';
    if (PERMISSIONS.includes(permission)) f.permission = permission;
    if (planMode !== undefined) f.planMode = Boolean(planMode);
    // The journal only has the token count; the window size comes from the
    // model list.
    if (contextTokens != null) this.contextUsed = contextTokens;
    if (context?.used != null) this.contextUsed = context.used;
    const used = this.contextUsed ?? this.session.meta?.context?.used;
    const id = f.model ?? this.session.meta?.model ?? this.defaultModel;
    const size = context?.size || (this.session.meta?.models || []).find((m) => m.id === id)?.context || this.session.meta?.context?.size;
    if (used != null && size) f.context = { used, size };
    this.meta(f);
  }

  async loadSkills(workspaceId) {
    const r = workspaceId ? await this.api('GET', `/api/v1/workspaces/${workspaceId}/skills`) : await this.api('GET', this.path('/skills'));
    const skills = (r.skills || [])
      .filter((s) => !s.type || s.type === 'inline' || s.type === 'prompt')
      .map((s) => ({ name: s.name, description: s.description || '', source: s.source }));
    this.meta({ skills });
  }

  async loadApprovals() {
    const r = await this.api('GET', this.path('/approvals?status=pending'));
    for (const a of r.items || []) this.onApproval(a);
  }

  async loadQuestions() {
    const r = await this.api('GET', this.path('/questions?status=pending'));
    for (const q of r.items || []) this.onQuestion(q);
  }

  // Replay journal frames into a fresh transcript, in one broadcast.
  replay(frames, { more = false, before = 0, prepend = false } = {}) {
    const events = [];
    const session = this.session;
    let status = null;
    const tag = `w${this.kid.slice(-6)}${prepend ? `p${before}` : ''}`;
    let n = 0;
    const saved = { blocks: this.blocks, tools: this.tools, agents: this.agents, early: this.early, turn: this.turn };
    this.reset();
    this.batch = {
      events,
      ctx: {
        session,
        emit: (fields) => {
          const ev = { id: `${tag}_${n++}`, ts: fields.ts || this.batchTime || now(), ...fields };
          events.push(ev);
          return ev;
        },
        patch: (ev, fields) => Object.assign(ev, fields),
        delta: (ev, text, field = 'text') => {
          ev[field] = (ev[field] || '') + text;
        },
        setStatus: (st) => (status = st),
        setMeta: (fields) => (session.meta = { ...(session.meta || {}), ...fields }),
        setTitle: () => {},
        replaceEvents: () => {},
      },
    };
    try {
      for (const fr of frames) {
        this.batchTime = fr.time || undefined;
        this.onFrame(fr);
      }
    } finally {
      this.batch = null;
      this.batchTime = undefined;
    }
    if (more) events.unshift({ id: `${tag}_more`, ts: events[0]?.ts || now(), type: 'info', text: '更早的對話沒有載入', more: true, before });
    if (prepend) {
      // Older turns are complete; keep the live state of the newer ones.
      Object.assign(this, saved);
      const rest = session.events.filter((e) => !e.more);
      this.ctx.replaceEvents([...events, ...rest]);
      return;
    }
    this.ctx.replaceEvents(events);
    if (status) this.ctx.setStatus(status);
    this.ctx.setMeta({});
  }

  async loadEarlier() {
    const marker = this.session.events.find((e) => e.more);
    if (!marker) return;
    this.viewedAt = now();
    const h = await machines.rpc(this.machineId, 'kimi.history', { sessionId: this.kid, turns: HISTORY_TURNS, before: marker.before }, 30_000);
    this.replay(h.frames, { more: h.more, before: h.before, prepend: true });
  }

  async loadQueue() {
    const r = await this.api('GET', this.path('/prompts'));
    const keep = new Map((this.session.meta?.queue || []).map((q) => [q.promptId, q]));
    const queue = (r.queued || []).map((p) => keep.get(p.prompt_id) || { promptId: p.prompt_id, text: contentText(p.content), images: contentImages(p.content), foreign: !this.mine.has(p.prompt_id) });
    this.meta({ queue });
  }

  // ------------------------------------------------------------- history

  async importHistory() {
    const items = [];
    let before = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.api('GET', this.path(`/messages?page_size=100${before ? `&before_id=${encodeURIComponent(before)}` : ''}`));
      items.push(...(r.items || []));
      if (!r.has_more || !r.items?.length) break;
      before = r.items[r.items.length - 1].id;
    }
    items.reverse();
    const events = [];
    const tools = new Map();
    let n = 0;
    const tag = this.kid.slice(-6);
    const ev = (fields, ts) => {
      const e = { id: `k_${tag}_${n++}`, ts, ...fields };
      events.push(e);
      return e;
    };
    let todos = null;
    for (const m of items) {
      const ts = Date.parse(m.created_at) || now();
      const origin = m.metadata?.origin || {};
      if (m.role === 'user') {
        let text = contentText(m.content);
        if (origin.kind === 'skill_activation') text = promptLabel({ origin, prompt: text });
        else if (origin.kind && origin.kind !== 'user') continue; // Kimi's own reminders and injections
        const images = contentImages(m.content);
        if (text || images.length) ev({ type: 'user', text, images, promptId: m.prompt_id || m.id, source: 'kimi' }, ts);
      } else if (m.role === 'assistant') {
        for (const p of m.content || []) {
          if (p.type === 'thinking' && (p.thinking || p.text)) ev({ type: 'thinking', text: p.thinking || p.text }, ts);
          else if (p.type === 'text' && p.text) ev({ type: 'text', text: p.text }, ts);
          else if (p.type === 'tool_use') {
            const t = ev({ type: 'tool_use', agentId: 'main', name: p.tool_name, toolCallId: p.tool_call_id, input: p.input, title: toolTitle(p.tool_name, p.input), status: 'done' }, ts);
            if (p.tool_name === 'TodoList' && Array.isArray(p.input?.todos)) todos = t.todos = p.input.todos;
            tools.set(p.tool_call_id, t);
          }
        }
      } else if (m.role === 'tool') {
        for (const p of m.content || []) {
          if (p.type !== 'tool_result') continue;
          const t = tools.get(p.tool_call_id);
          if (t) Object.assign(t, { output: outputText(p.output), status: p.is_error ? 'error' : 'done', isError: Boolean(p.is_error) });
        }
      }
    }
    await this.importSubagents(events, ev).catch((err) => console.warn(`[kimi] subagent history: ${err.message}`));
    this.reset();
    this.ctx.replaceEvents(events);
    this.meta({ todos: todos || [] });
  }

  // Subagent conversations live in their own transcripts; the Agent tool's
  // result names the subagent ("agent_id: agent-0").
  async importSubagents(events, ev) {
    const calls = events.filter((e) => e.type === 'tool_use' && /^Agent/.test(e.name) && /agent_id:\s*\S+/.test(e.output || '')).slice(-12);
    await Promise.all(
      calls.map(async (call) => {
        const agentId = call.output.match(/agent_id:\s*([\w.-]+)/)[1];
        const status = call.output.match(/\nstatus:\s*(\w+)/)?.[1] || 'completed';
        const summary = call.output.match(/\[summary\]\n([\s\S]*?)(\n\nresume_hint:|$)/)?.[1]?.trim();
        call.subagent = {
          id: agentId,
          name: call.output.match(/actual_subagent_type:\s*(\S+)/)?.[1] || 'subagent',
          description: call.input?.description || '',
          status: status === 'completed' ? 'done' : status,
          summary,
        };
        const r = await this.api('GET', this.path(`/transcript?agent_id=${encodeURIComponent(agentId)}&page_size=100`));
        for (const turn of r.items || []) {
          for (const step of turn.steps || []) {
            const ts = Date.parse(turn.endedAt) || call.ts;
            for (const f of step.frames || []) {
              if (f.kind === 'text' && f.text) ev({ type: f.role === 'thinking' ? 'thinking' : 'text', text: f.text, parent: call.id, agentId }, ts);
              else if (f.kind === 'thinking' && f.text) ev({ type: 'thinking', text: f.text, parent: call.id, agentId }, ts);
              else if (f.kind === 'tool') {
                ev({ type: 'tool_use', agentId, parent: call.id, name: f.name, toolCallId: f.toolCallId, input: f.input, title: toolTitle(f.name, f.input), output: outputText(f.output), status: f.state === 'error' || f.isError ? 'error' : 'done' }, ts);
              }
            }
          }
        }
      }),
    );
  }

  // ------------------------------------------------------------- events

  closeBlock(agentId) {
    if (agentId) this.blocks.delete(agentId);
    else this.blocks.clear();
  }

  stream(agentId, type, text, turnId, parent) {
    if (!text) return;
    let b = this.blocks.get(agentId);
    if (!b || b.type !== type || b.turnId !== turnId) {
      b = { type, turnId, ev: this.ctx.emit({ type, text: '', ...(parent ? { parent, agentId } : {}) }) };
      this.blocks.set(agentId, b);
    }
    this.ctx.delta(b.ev, text);
  }

  tool(agentId, id, fields = {}, parent) {
    const key = `${agentId}:${id}`;
    let ev = this.tools.get(key);
    if (!ev) {
      this.closeBlock(agentId);
      ev = this.ctx.emit({ type: 'tool_use', agentId, toolCallId: id, name: fields.name || 'tool', title: '', status: 'pending', ...(parent ? { parent } : {}), ...fields });
      this.tools.set(key, ev);
    } else if (Object.keys(fields).length) {
      this.ctx.patch(ev, fields);
    }
    return ev;
  }

  findTool(test) {
    for (const ev of this.tools.values()) if (test(ev)) return ev;
    return this.events().find((e) => e.type === 'tool_use' && test(e));
  }

  parentOf(agentId) {
    return agentId === 'main' ? undefined : this.agents.get(agentId)?.parent;
  }

  onApproval(a) {
    const agentId = a.agent_id || a.agentId || 'main';
    const display = a.tool_input_display || a.display;
    const ev = this.tool(agentId, a.tool_call_id || a.approval_id, { name: a.tool_name }, this.parentOf(agentId));
    const plan = display?.kind === 'plan_review';
    this.ctx.patch(ev, {
      approvalId: a.approval_id,
      title: ev.title && ev.title !== ev.name ? ev.title : toolTitle(a.tool_name, ev.input || {}, display) || a.action,
      display: display || ev.display,
      action: a.action,
      status: 'awaiting',
      permission: plan
        ? { kind: 'plan', plan: display.plan, path: display.path, options: (display.options || []).map((o, i) => ({ optionId: `plan:${i}`, name: o.label || o, label: o.label || o, description: o.description })), chosen: null }
        : { kind: 'approval', options: APPROVAL_OPTIONS, chosen: null },
    });
    this.ctx.setStatus('awaiting_permission');
  }

  onQuestion(q) {
    const items = q.questions || [];
    if (!items.length) return;
    const agentId = q.agent_id || q.agentId || 'main';
    const ev = this.tool(agentId, q.tool_call_id || q.question_id, { name: 'AskUserQuestion' }, this.parentOf(agentId));
    this.ctx.patch(ev, {
      questionId: q.question_id,
      title: items[0].question || items[0].header || 'Kimi 有問題要問你',
      status: 'awaiting',
      permission: { kind: 'question', questions: items, chosen: null },
    });
    this.ctx.setStatus('awaiting_permission');
  }

  onSubagent(type, p) {
    const id = p.subagentId;
    if (type === 'subagent.spawned') {
      const parentAgent = p.parentAgentId || p.callerAgentId || 'main';
      const known = this.agents.get(id);
      let parent = known ? this.events().find((e) => e.id === known.parent) : this.tools.get(`${parentAgent}:${p.parentToolCallId}`);
      // Attached mid-run: no tool card for the Agent call yet, so make one.
      if (!parent) parent = this.tool(parentAgent, p.parentToolCallId || `agent:${id}`, { name: 'Agent', title: p.description || p.subagentName, status: 'running' }, this.parentOf(parentAgent));
      this.agents.set(id, { ...known, parent: parent.id, background: Boolean(p.runInBackground) });
      this.ctx.patch(parent, { subagent: { ...parent.subagent, id, name: known?.btw ? 'btw' : p.subagentName || 'subagent', description: p.description || parent.subagent?.description || '', status: 'running', background: Boolean(p.runInBackground) } });
      this.flushEarly(id);
      return;
    }
    const a = this.agents.get(id);
    const parent = a && this.events().find((e) => e.id === a.parent);
    if (!parent?.subagent) return;
    const status = { 'subagent.started': 'running', 'subagent.completed': 'done', 'subagent.failed': 'error', 'subagent.cancelled': 'cancelled', 'subagent.suspended': 'suspended' }[type];
    if (!status) return;
    this.closeBlock(id);
    this.ctx.patch(parent, { subagent: { ...parent.subagent, status, summary: p.resultSummary ?? parent.subagent.summary, error: p.error } });
  }

  flushEarly(agentId) {
    const early = this.early.get(agentId) || [];
    this.early.delete(agentId);
    for (const f of early) this.onFrame(f);
  }

  queue() {
    return this.session.meta?.queue || [];
  }

  dequeue(promptId) {
    const q = this.queue().find((x) => x.promptId === promptId);
    if (q) this.meta({ queue: this.queue().filter((x) => x.promptId !== promptId) });
    return q;
  }

  // A turn opens with a prompt. Prompts sent from the hub are already in the
  // transcript; queued ones join it now; anything else was typed in Kimi.
  showPrompt(promptId, text, images, extra = {}) {
    if (this.batch) {
      const note = this.session.state.notes?.[promptId];
      return text || images?.length ? this.ctx.emit({ type: 'user', text, images, promptId, source: this.mine.has(promptId) ? 'hub' : 'kimi', ...(note ? { note } : {}), ...extra }) : null;
    }
    // Typed into a terminal Kimi from the hub: matched by text.
    const t = this.tuiPending?.findIndex((x) => x.text === text) ?? -1;
    if (t !== -1) {
      const [x] = this.tuiPending.splice(t, 1);
      if (x.queued) {
        this.dequeue(x.promptId);
        return this.ctx.emit({ type: 'user', text, images, promptId, source: 'hub', ...extra });
      }
      return null;
    }
    const q = promptId && this.dequeue(promptId);
    if (q) return this.ctx.emit({ type: 'user', text: q.text, images: q.images, promptId, source: q.foreign ? 'kimi' : 'hub', note: q.note, ...extra });
    if (promptId && this.mine.has(promptId)) return null;
    if (text == null || (!text && !images?.length)) return null;
    return this.ctx.emit({ type: 'user', text, images, promptId, source: 'kimi', note: this.inTerminal() ? '在終端機送出' : '在 Kimi 端送出', ...extra });
  }

  onFrame(frame) {
    const p = frame.payload || {};
    const type = frame.type || p.type;
    const agentId = p.agentId || 'main';
    this.touch();
    if (type.startsWith('subagent.')) return this.onSubagent(type, p);
    if (agentId !== 'main' && !this.agents.has(agentId)) {
      // A subagent's first events arrive just before subagent.spawned.
      if (type === 'turn.started' || type === 'context.spliced') return;
      const q = this.early.get(agentId) || [];
      if (q.length < 500) q.push(frame);
      this.early.set(agentId, q);
      return;
    }
    const main = agentId === 'main';
    const parent = this.parentOf(agentId);
    switch (type) {
      case 'turn.started': {
        if (!main) return;
        // A new turn may be one Kimi lets a waiting message into.
        if (!this.batch && this.cutInTimer) setTimeout(() => this.tryCutIns(), 300);
        this.closeBlock();
        this.turn = { started: now(), input: 0, output: 0, id: p.turnId };
        // Kimi fixes the model and thinking for the whole turn when it
        // starts: a change made during it applies from the next one.
        this.meta({ turnModel: this.session.meta?.model || '', turnEffort: this.session.meta?.effort || '' });
        const kind = p.origin?.kind;
        const text = promptLabel(p);
        if (text != null) this.showPrompt(p.promptId, text, contentImages(p.promptAttachments));
        else if (kind === 'cron_job') this.ctx.emit({ type: 'info', text: '排程時間到了，Kimi 開始處理' });
        else if (kind === 'task' || kind === 'background_task') this.ctx.emit({ type: 'info', text: '背景工作結束，Kimi 接著處理' });
        this.ctx.setStatus('running');
        return;
      }
      case 'turn.steer':
        // A message slipped into the running turn (sent while Kimi was busy).
        if (!main) return;
        this.closeBlock();
        for (const id of p.promptIds || [p.messageId]) this.showPrompt(id, contentText(p.input), contentImages(p.input), { steered: true });
        return;
      case 'prompt.queued':
        if (main && !this.mine.has(p.promptId) && !this.queue().some((q) => q.promptId === p.promptId)) {
          this.meta({ queue: [...this.queue(), { promptId: p.promptId, text: contentText(p.content), images: contentImages(p.content), foreign: true }] });
        }
        return;
      case 'prompt.steered':
        if (main) this.meta({ queue: this.queue().map((q) => ((p.promptIds || []).includes(q.promptId) ? { ...q, steered: true } : q)) });
        return;
      case 'prompt.aborted':
        if (main) this.dequeue(p.promptId);
        return;
      case 'assistant.delta':
        this.stream(agentId, 'text', p.delta, p.turnId, parent);
        return;
      case 'thinking.delta':
        this.stream(agentId, 'thinking', p.delta, p.turnId, parent);
        return;
      case 'tool.call.delta': {
        const ev = this.tool(agentId, p.toolCallId, { name: p.name || 'tool' }, parent);
        if (p.argumentsPart) this.ctx.delta(ev, p.argumentsPart, 'argsText');
        return;
      }
      case 'tool.call.started': {
        const ev = this.tool(agentId, p.toolCallId, { name: p.name }, parent);
        const fields = {
          name: p.name,
          input: p.args,
          display: p.display,
          title: toolTitle(p.name, p.args, p.display) || p.description || p.name,
          description: p.description,
          status: ev.permission && !ev.permission.chosen ? 'awaiting' : 'running',
        };
        if (p.name === 'TodoList' && Array.isArray(p.args?.todos)) {
          fields.todos = p.args.todos;
          if (main) this.meta({ todos: p.args.todos });
        }
        this.ctx.patch(ev, fields);
        return;
      }
      case 'tool.progress': {
        const ev = this.tools.get(`${agentId}:${p.toolCallId}`);
        const text = p.update?.text;
        if (!ev || typeof text !== 'string') return;
        if (p.update.replace) this.ctx.patch(ev, { output: text });
        else this.ctx.delta(ev, text, 'output');
        return;
      }
      case 'tool.result': {
        const ev = this.tool(agentId, p.toolCallId, {}, parent);
        this.ctx.patch(ev, { status: p.isError ? 'error' : 'done', isError: Boolean(p.isError), output: outputText(p.output) });
        return;
      }
      case 'event.approval.requested':
        this.onApproval(p);
        return;
      case 'event.approval.resolved': {
        const ev = this.findTool((e) => e.approvalId === p.approval_id);
        if (ev && !ev.permission?.chosen) {
          const chosen = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : 'cancelled';
          this.ctx.patch(ev, { status: chosen === 'approved' ? 'running' : 'pending', permission: { ...ev.permission, chosen } });
        }
        return;
      }
      case 'event.question.requested':
        this.onQuestion(p);
        return;
      case 'event.question.answered':
      case 'event.question.dismissed': {
        const ev = this.findTool((e) => e.questionId === p.question_id);
        if (ev && !ev.permission?.chosen) this.ctx.patch(ev, { status: 'done', permission: { ...ev.permission, chosen: type.endsWith('dismissed') ? '__dismiss' : 'answered' } });
        return;
      }
      case 'turn.step.completed':
        if (main && this.turn && p.usage) {
          this.turn.input += (p.usage.inputOther || 0) + (p.usage.inputCacheRead || 0) + (p.usage.inputCacheCreation || 0);
          this.turn.output += p.usage.output || 0;
          // Kimi times each step's streaming, so tokens per second is the
          // generated tokens over the time actually spent generating.
        }
        // Kimi times each step's streaming and counts what it generated, so
        // the recent steps give a generation rate. A rolling window keeps it
        // steady: it stays put while a tool runs, instead of blinking out.
        if (main && p.usage?.output > 0 && p.llmStreamDurationMs > 0) {
          this.rates = [...(this.rates || []), { tokens: p.usage.output, ms: p.llmStreamDurationMs }].slice(-10);
          const tokens = this.rates.reduce((a, r) => a + r.tokens, 0);
          const ms = this.rates.reduce((a, r) => a + r.ms, 0);
          if (ms >= 100) this.meta({ tps: Math.round((tokens / ms) * 1000) });
        }
        return;
      case 'turn.ended':
        if (main) return this.endTurn(p);
        this.closeBlock(agentId);
        if (this.agents.get(agentId)?.btw) {
          const ev = this.events().find((e) => e.id === parent);
          if (ev) this.ctx.patch(ev, { status: p.reason === 'failed' ? 'error' : 'done', subagent: { ...ev.subagent, status: p.reason === 'completed' ? 'done' : p.reason } });
        }
        return;
      case 'event.session.work_changed':
        if (p.busy) this.ctx.setStatus(p.pending_interaction && p.pending_interaction !== 'none' ? 'awaiting_permission' : 'running');
        else this.ctx.setStatus(p.last_turn_reason === 'failed' ? 'error' : 'idle');
        return;
      case 'agent.status.updated':
        if (main) {
          this.applyStatus({
            model: p.model,
            effort: p.thinkingEffort,
            permission: p.permission,
            planMode: p.planMode,
            context: p.maxContextTokens ? { used: p.contextTokens || 0, size: p.maxContextTokens } : undefined,
            contextTokens: p.contextTokens,
          });
        } else if (p.model || p.thinkingEffort) {
          // A subagent's own model and thinking, shown with it.
          const a = this.agents.get(agentId);
          const card = a && this.events().find((e) => e.id === a.parent);
          if (card?.subagent) this.ctx.patch(card, { subagent: { ...card.subagent, model: p.model || card.subagent.model, effort: p.thinkingEffort || card.subagent.effort } });
        }
        return;
      case 'hub.todos':
        if (main) this.meta({ todos: p.todos || [] });
        return;
      case 'session.meta.updated':
        if (p.title) this.ctx.setTitle(p.title);
        return;
      case 'compaction.started':
        if (main) this.ctx.emit({ type: 'info', text: '正在壓縮對話內容…' });
        return;
      case 'compaction.completed':
        if (main) this.ctx.emit({ type: 'info', text: `已壓縮對話${p.result?.tokensBefore ? `（${p.result.tokensBefore} → ${p.result.tokensAfter} tokens）` : ''}` });
        return;
      case 'goal.updated':
        if (main) {
          const g = p.snapshot;
          if (g?.objective && g.status !== this.session.meta?.goal?.status) this.ctx.emit({ type: 'info', text: `目標${{ active: '進行中', paused: '已暫停', blocked: '卡住了', complete: '已完成' }[g.status] || ''}：${g.objective}` });
          this.meta({ goal: g ? { objective: g.objective, status: g.status } : null });
        }
        return;
      case 'warning':
        if (main && p.message) this.ctx.emit({ type: 'info', text: p.message });
        return;
      case 'error':
        // Turn failures are reported by turn.ended; show only stray errors.
        if (main && !this.turn && p.message && now() - (this.lastFailureAt || 0) > 3000) this.ctx.emit({ type: 'error', text: p.message });
        return;
      default:
    }
  }

  endTurn(p) {
    this.closeBlock();
    if (p.reason === 'failed') this.lastFailureAt = now();
    if (p.reason === 'failed' && p.error) {
      const code = p.error.code || '';
      const auth = /^auth\./.test(code) || /model\.not_configured/.test(code);
      this.ctx.emit({ type: 'error', text: auth ? `${p.error.message}。在那台電腦上執行 kimi login，或在 Kimi 裡用 /model 選擇模型。` : p.error.message });
    }
    // Background subagents keep running after the turn that started them.
    const lives = (ev) => (ev.subagent?.background && ev.subagent.status === 'running') || this.agents.get(ev.agentId)?.background;
    for (const ev of this.tools.values()) {
      if (['pending', 'running', 'awaiting'].includes(ev.status) && !lives(ev)) this.ctx.patch(ev, { status: p.reason === 'cancelled' ? 'interrupted' : 'ended' });
    }
    const usage = { inputTokens: this.turn?.input || 0, outputTokens: this.turn?.output || 0, costUsd: 0 };
    this.session.usage.inputTokens += usage.inputTokens;
    this.session.usage.outputTokens += usage.outputTokens;
    this.ctx.emit({
      type: 'turn_end',
      durationMs: p.durationMs ?? (this.turn ? now() - this.turn.started : 0),
      usage,
      interrupted: p.reason === 'cancelled',
      error: p.reason === 'failed',
    });
    this.turn = null;
    this.meta({ turnModel: null, turnEffort: null });
    for (const [key, ev] of this.tools) if (!lives(ev)) this.tools.delete(key);
    if (!this.batch && this.inTerminal()) setTimeout(() => this.flushTerminalQueue(), 400);
  }

  // ------------------------------------------------------------ actions

  content(text, images) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images) content.push({ type: 'image', source: { kind: 'base64', media_type: img.mimeType, data: img.data } });
    return content;
  }

  // Sending while Kimi is busy queues the message: it runs after the current
  // turn. "Steer" (插隊, Kimi's Ctrl-S) slips it into the running turn so Kimi
  // reads it at its next step, without stopping anything. Queued messages
  // wait above the composer and can be steered or cancelled there.
  // A conversation open in a terminal Kimi is driven by typing into it (only
  // when that Kimi was started through the bridge); everything else goes
  // through Kimi's server.
  async tui(args) {
    return machines.rpc(this.machineId, 'kimi.tui.input', { sessionId: this.kid, ...args });
  }

  // A terminal Kimi gets queued messages from the hub only when its turn
  // ends (Enter) or when you steer them (Ctrl-S), so they stay steerable.
  async sendToTerminal(text, images, note, steer) {
    if (images.length) throw Object.assign(new Error('終端機裡的 Kimi 沒辦法從中控台接收圖片'), { status: 400 });
    this.tuiPending ??= [];
    const busy = ['running', 'awaiting_permission'].includes(this.session.status);
    const item = { text, queued: busy, promptId: `tui_${crypto.randomBytes(5).toString('hex')}` };
    this.tuiPending.push(item);
    if (busy) {
      this.meta({ queue: [...this.queue(), { promptId: item.promptId, text, images: [], note, steered: Boolean(steer), terminal: true }] });
      if (!steer) return;
    } else {
      this.ctx.emit({ type: 'user', text, images: [], source: 'hub', note });
      this.ctx.setStatus('running');
    }
    try {
      await this.tui({ action: 'send', text, mode: busy ? 'steer' : 'enter' });
    } catch (err) {
      this.tuiPending.splice(this.tuiPending.indexOf(item), 1);
      if (busy) this.dequeue(item.promptId);
      throw err;
    }
    return { ok: true };
  }

  // After a terminal turn, type the next held message into Kimi.
  async flushTerminalQueue() {
    const next = this.queue().find((q) => q.terminal && !q.steered);
    if (!next || ['running', 'awaiting_permission'].includes(this.session.status)) return;
    this.meta({ queue: this.queue().map((q) => (q === next ? { ...q, steered: true } : q)) });
    await this.tui({ action: 'send', text: next.text, mode: 'enter' }).catch(() => this.dequeue(next.promptId));
  }

  async steerQueued(promptId) {
    const q = this.queue().find((x) => x.promptId === promptId);
    if (!q || q.steered) return;
    if (q.terminal) {
      this.markQueued(promptId, { steered: true });
      const busy = ['running', 'awaiting_permission'].includes(this.session.status);
      await this.tui({ action: 'send', text: q.text, mode: busy ? 'steer' : 'enter' });
    } else {
      this.markQueued(promptId, { cutIn: true });
      const post = this.inflight?.get(promptId);
      if (post && (await post.catch(() => null))?.status !== 'queued') return;
      await this.steer(promptId);
    }
  }

  // Resolves to { ok } — false (with the error, already shown in the
  // conversation) when Kimi did not take the message.
  // `urgent` (「優雅暫停」): once Kimi has taken it in, foreground work that
  // keeps it from being read is moved to the background (watchUrgent).
  async send(text, images = [], { note, steer, urgent } = {}) {
    if (this.inTerminal()) return this.sendToTerminal(text, images, note, steer);
    await ensureServer(this.machineId);
    const ctx = this.ctx;
    const promptId = newPromptId();
    this.remember(promptId, note);
    const thumbs = images.map((i) => i.thumb || `data:${i.mimeType};base64,${i.data}`);
    const busy = ['running', 'awaiting_permission'].includes(this.session.status);
    if (busy) this.meta({ queue: [...this.queue(), { promptId, text, images: thumbs, note, ...(steer ? { cutIn: true } : {}), ...(steer && urgent ? { urgent: true } : {}) }] });
    else {
      ctx.emit({ type: 'user', text, images: thumbs, promptId, source: 'hub', note });
      ctx.setStatus('running');
    }
    const body = { prompt_id: promptId, content: this.content(text, images) };
    if (this.defaultModel === undefined) await this.loadModels().catch(() => {});
    if (!this.session.meta?.model && this.defaultModel) body.model = this.defaultModel;
    // 插隊 from the tray can come before Kimi has the prompt: it waits.
    const post = this.api('POST', this.path('/prompts'), body);
    (this.inflight ??= new Map()).set(promptId, post);
    try {
      const r = await post;
      if (r?.status === 'queued' && steer) await this.steer(promptId);
      return { ok: true, promptId };
    } catch (err) {
      this.dequeue(promptId);
      ctx.emit({ type: 'error', text: err.message });
      if (!busy) ctx.setStatus('idle');
      return { ok: false, error: err.message };
    } finally {
      this.inflight.delete(promptId);
    }
  }

  // Kimi takes a message into the running turn only when a message started
  // that turn; a turn it started itself (to go on after a background
  // subagent finished, say) refuses it. So a message asked to cut in waits
  // as `cutIn` and is offered again every few seconds and whenever a turn
  // starts, until Kimi takes it, it starts as a turn of its own (at the
  // latest when this turn ends), or it is cancelled. Nothing is stopped.
  async steer(promptId) {
    try {
      await this.api('POST', this.path(`/prompts/${promptId}:steer`), {});
      this.markQueued(promptId, { steered: true, cutIn: false });
      if (this.queue().find((q) => q.promptId === promptId)?.urgent) this.watchUrgent(promptId);
      return true;
    } catch {
      this.markQueued(promptId, { cutIn: true });
      this.retryCutIns();
      return false;
    }
  }

  markQueued(promptId, fields) {
    if (this.queue().some((q) => q.promptId === promptId)) this.meta({ queue: this.queue().map((q) => (q.promptId === promptId ? { ...q, ...fields } : q)) });
  }

  retryCutIns() {
    if (this.cutInTimer) return;
    this.cutInTimer = setInterval(() => this.tryCutIns(), CUT_IN_RETRY_MS);
    this.cutInTimer.unref?.();
  }

  // Kimi reads a message it has taken in at its next step, and a step lasts
  // until what it runs in the foreground (a subagent, a long command) is
  // done. An urgent message still unread after a while gets that work moved
  // to the background, as Ctrl+B does: the work goes on, the message is read
  // now. Only the conversation's own foreground work, only for this.
  watchUrgent(promptId, round = 0) {
    const t = setTimeout(async () => {
      const q = this.queue().find((x) => x.promptId === promptId);
      if (!q?.steered || !['running', 'awaiting_permission'].includes(this.session.status)) return; // read, or gone
      const moved = await this.detachForeground().catch(() => 0);
      if (moved) this.ctx.emit({ type: 'info', text: `為了讓 Kimi 馬上讀到「${q.text}」，把它在前景等的 ${moved} 個工作移到背景（跟 Ctrl+B 一樣，工作會繼續跑）` });
      if (round < 5) this.watchUrgent(promptId, round + 1);
    }, URGENT_DETACH_MS);
    t.unref?.();
  }

  async detachForeground() {
    const r = await this.api('GET', this.path('/tasks'));
    const mine = new Set([...this.tools.keys()].filter((k) => k.startsWith('main:')).map((k) => k.slice(5)));
    const fg = (r?.items || []).filter((t) => t.run_in_background === false && t.status === 'running' && mine.has(t.parent_tool_call_id));
    let moved = 0;
    for (const t of fg) {
      try {
        await this.api('POST', this.path(`/tasks/${t.id}:detach`), {});
        moved++;
      } catch {}
    }
    return moved;
  }

  async tryCutIns() {
    const waiting = this.queue().filter((q) => q.cutIn && !q.steered && !q.terminal);
    // Kimi starts a waiting message itself once it stops.
    if (!waiting.length || !['running', 'awaiting_permission'].includes(this.session.status)) {
      clearInterval(this.cutInTimer);
      this.cutInTimer = null;
      return;
    }
    if (this.cuttingIn) return;
    this.cuttingIn = true;
    try {
      for (const q of waiting) if (!this.inflight?.has(q.promptId)) await this.steer(q.promptId);
    } finally {
      this.cuttingIn = false;
    }
  }

  async cancelQueued(promptId) {
    const q = this.queue().find((x) => x.promptId === promptId);
    if (q?.terminal) {
      if (q.steered) throw Object.assign(new Error('這則訊息已經送進終端機了'), { status: 409 });
      this.tuiPending = (this.tuiPending || []).filter((x) => x.promptId !== promptId);
      return this.dequeue(promptId);
    }
    await this.api('POST', this.path(`/prompts/${promptId}:abort`), {}).catch(() => {});
    return this.dequeue(promptId);
  }

  async interrupt() {
    if (this.inTerminal()) return this.tui({ action: 'interrupt' });
    await this.api('POST', this.path(':abort'), {});
  }

  async respond(eventId, optionId, { answers, feedback } = {}) {
    const ev = this.session.events.find((e) => e.id === eventId);
    if (!ev?.permission || ev.permission.chosen) return false;
    let chosen = optionId;
    if (this.inTerminal()) {
      if (ev.approvalId && ev.permission.kind !== 'plan') await this.tui({ action: 'approve', decision: optionId, feedback });
      else if (ev.questionId && (ev.permission.questions || []).length === 1 && !ev.permission.questions[0].multi_select) {
        const q = ev.permission.questions[0];
        const id = answers?.[q.id]?.option_id ?? optionId;
        const index = (q.options || []).findIndex((o) => o.id === id);
        if (index === -1) throw Object.assign(new Error('請在終端機回答這個問題'), { status: 400 });
        await this.tui({ action: 'answer', index });
        chosen = 'answered';
      } else throw Object.assign(new Error('這個請求請在終端機的 Kimi 裡回答'), { status: 400 });
      this.ctx.patch(ev, { permission: { ...ev.permission, chosen, feedback: feedback?.trim() || undefined } });
      return true;
    }
    if (ev.approvalId) {
      let body;
      if (ev.permission.kind === 'plan') {
        const opt = ev.permission.options.find((o) => o.optionId === optionId);
        body = optionId === 'rejected' ? { decision: 'rejected' } : { decision: 'approved', selected_label: opt?.label };
      } else {
        body = optionId === 'rejected' ? { decision: 'rejected' } : optionId === 'approved_session' ? { decision: 'approved', scope: 'session' } : { decision: 'approved' };
      }
      if (feedback?.trim()) body.feedback = feedback.trim();
      await this.api('POST', this.path(`/approvals/${ev.approvalId}`), body);
    } else if (ev.questionId) {
      if (optionId === '__dismiss') {
        // Dismissal "succeeds" with envelope code 40909, so skip the unwrap.
        await machines.rpc(this.machineId, 'kimi.request', { method: 'POST', path: this.path(`/questions/${ev.questionId}:dismiss`), body: {} });
      } else {
        const items = ev.permission.questions || [];
        const out = {};
        items.forEach((q, i) => {
          const a = answers?.[q.id] ?? (i === 0 && optionId ? { kind: 'single', option_id: optionId } : null);
          out[q.id] = a || { kind: 'skipped' };
        });
        await this.api('POST', this.path(`/questions/${ev.questionId}`), { answers: out, method: 'click' });
        chosen = 'answered';
        this.ctx.patch(ev, { answers: out });
      }
    } else return false;
    const declined = optionId === 'rejected' || optionId === '__dismiss';
    this.ctx.patch(ev, { status: declined ? 'pending' : 'running', permission: { ...ev.permission, chosen, feedback: feedback?.trim() || undefined } });
    if (this.session.status === 'awaiting_permission' && !this.session.events.some((e) => e.permission && !e.permission.chosen)) this.ctx.setStatus('running');
    return true;
  }

  async configure({ model, effort, permission, planMode }) {
    if (this.inTerminal()) {
      // Kimi's own slash commands; /model and /yolo /auto open a picker that
      // is confirmed with Enter. The model first: a new model may not keep
      // the thinking set before it.
      if (typeof model === 'string' && model) await this.tui({ action: 'command', text: `/model ${model}`, confirm: true });
      if (typeof effort === 'string') await this.tui({ action: 'command', text: `/effort ${effort}` });
      if (typeof planMode === 'boolean') await this.tui({ action: 'command', text: `/plan ${planMode ? 'on' : 'off'}` });
      if (permission === 'yolo' || permission === 'auto') await this.tui({ action: 'command', text: `/${permission}`, confirm: true });
      else if (permission) throw Object.assign(new Error('要改回「每次詢問」，請在終端機的 Kimi 裡輸入 /permission'), { status: 400 });
      // Kimi journals these with its next turn; show them now.
      this.applyStatus({ model: model || undefined, effort, permission, planMode });
      return;
    }
    const agentConfig = {};
    if (typeof model === 'string' && model) agentConfig.model = model;
    if (typeof effort === 'string' && effort) agentConfig.thinking = effort;
    if (PERMISSIONS.includes(permission)) agentConfig.permission_mode = permission;
    if (typeof planMode === 'boolean') agentConfig.plan_mode = planMode;
    if (!Object.keys(agentConfig).length) throw Object.assign(new Error('沒有要變更的設定'), { status: 400 });
    await this.api('POST', this.path('/profile'), { agent_config: agentConfig });
    // Kimi echoes the change in agent.status.updated; reflect it right away.
    this.applyStatus({ model: agentConfig.model, effort: agentConfig.thinking, permission: agentConfig.permission_mode, planMode: agentConfig.plan_mode });
  }

  async command(name, args = '') {
    if (this.inTerminal()) {
      if (name === 'archive') throw Object.assign(new Error('這個對話正在終端機執行。先關掉那個 Kimi，再從這裡刪除'), { status: 409 });
      await this.tui({ action: 'command', text: `/${name}${args ? ` ${args}` : ''}` });
      return {};
    }
    await ensureServer(this.machineId);
    switch (name) {
      case 'compact':
        await this.api('POST', this.path(':compact'), args ? { instruction: args } : {});
        return {};
      case 'undo': {
        await this.api('POST', this.path(':undo'), { count: 1 });
        await this.importHistory();
        return {};
      }
      case 'fork':
        return { kimiSessionId: (await this.api('POST', this.path(':fork'), args ? { title: args } : {})).id };
      case 'archive':
        await this.api('POST', this.path(':archive'), {});
        return {};
      case 'title':
        if (!args) throw Object.assign(new Error('在 /title 後面輸入新標題'), { status: 400 });
        await this.api('POST', this.path('/profile'), { title: args });
        this.ctx.setTitle(args);
        return {};
      case 'goal': {
        if (!args) throw Object.assign(new Error('在 /goal 後面輸入目標，或 pause、resume、cancel'), { status: 400 });
        const control = ['pause', 'resume', 'cancel'].includes(args.trim()) ? args.trim() : null;
        await this.api('POST', this.path('/profile'), { agent_config: control ? { goal_control: control } : { goal_objective: args } });
        return {};
      }
      case 'btw': {
        if (!args) throw Object.assign(new Error('在 /btw 後面輸入你想順便問的問題'), { status: 400 });
        const { agent_id: agentId } = await this.api('POST', this.path(':btw'), {});
        const ev = this.ctx.emit({ type: 'tool_use', agentId: 'main', name: 'btw', title: args, status: 'running', subagent: { id: agentId, name: 'btw', description: args, status: 'running' } });
        this.agents.set(agentId, { parent: ev.id, btw: true });
        this.flushEarly(agentId);
        const promptId = newPromptId();
        this.remember(promptId);
        await this.api('POST', this.path('/prompts'), { prompt_id: promptId, agent_id: agentId, content: [{ type: 'text', text: args }] });
        return {};
      }
      default: {
        // Anything else is one of Kimi's skills: /<skill> args
        const skill = (this.session.meta?.skills || []).find((s) => s.name === name);
        if (!skill) throw Object.assign(new Error(`沒有 /${name} 這個指令`), { status: 400 });
        await this.api('POST', this.path(`/skills/${encodeURIComponent(name)}:activate`), args ? { args } : {});
        return {};
      }
    }
  }
}

// ---------------------------------------------------------- module api

machines.onKimiEvent((machineId, frame) => {
  const kid = frame.session_id || frame.payload?.sessionId;
  const sid = kid && byKimi.get(`${machineId}:${kid}`);
  if (sid) mirrors.get(sid)?.onFrame(frame);
});

function mirrorFor(session) {
  let m = mirrors.get(session.id);
  if (!m) {
    m = new Mirror(session);
    mirrors.set(session.id, m);
    byKimi.set(`${session.machineId}:${session.kimiSessionId}`, session.id);
  }
  return m;
}

export function findByKimi(machineId, kimiSessionId) {
  return byKimi.get(`${machineId}:${kimiSessionId}`);
}

// Register persisted sessions at startup so events route to them, and
// re-attach whenever their machine comes (back) online.
export function restore(session) {
  mirrorFor(session);
}

// A machine (re)connected: catch up only the conversations someone has
// open or that are working; the rest catch up when they are opened.
export async function onMachineOnline(machineId, sessions) {
  for (const s of sessions) {
    if (s.machineId !== machineId || !s.kimiSessionId) continue;
    const m = mirrorFor(s);
    m.live = false;
    if (!m.busy() && now() - m.viewedAt > IDLE_FOLLOW_MS) continue;
    try {
      await m.attach();
    } catch (err) {
      console.warn(`[kimi] re-attach ${s.id} failed: ${err.message}`);
    }
  }
}

// Someone has this conversation open: keep it followed, catching up first
// if it had stopped (in the background; a catch-up resets the view).
export function view(session) {
  const m = mirrorFor(session);
  m.viewedAt = now();
  if (!m.live && machines.getMachine(session.machineId)?.online) m.ensureLive().catch((err) => console.warn(`[kimi] catch up ${session.id} failed: ${err.message}`));
}

setInterval(() => {
  for (const m of mirrors.values()) m.release();
}, 60_000).unref();

export async function attach(session, opts) {
  await mirrorFor(session).attach(opts);
}

export async function createRemote({ machineId, cwd, nameHint }) {
  await ensureServer(machineId);
  let dir = cwd;
  if (!dir) dir = (await machines.rpc(machineId, 'workspace.create', { name: nameHint || 'kimi' })).path;
  const s = await machines.kimiApi(machineId, 'POST', '/api/v1/sessions', { metadata: { cwd: dir } });
  return { kimiSessionId: s.id, cwd: s.metadata?.cwd || dir };
}

export async function send(session, text, { images = [], note, steer, urgent } = {}) {
  const m = mirrorFor(session);
  await m.ensureLive();
  return m.send(text, images, { note, steer, urgent });
}
// Followed right now (subscribed to the machine and caught up), so the
// hub's status for it is current.
export const isLive = (session) => Boolean(mirrors.get(session.id)?.live);
export const steerQueued = (session, promptId) => mirrorFor(session).steerQueued(promptId);
// Take a conversation locked only because a terminal Kimi runs in its folder.
export const unlock = (session) => machines.rpc(session.machineId, 'kimi.unlock', { sessionId: session.kimiSessionId });

// Refuse up front what cannot be delivered (a terminal Kimi not started
// through the bridge only mirrors).
export function cannotSend(session) {
  const m = mirrorFor(session);
  if (m.inTerminal() && !(m.entry()?.controllable ?? session.meta?.controllable)) {
    return '這個對話正在終端機的 Kimi 裡執行，中控台只能看。在那個 Kimi 裡輸入 /web，或之後用 kimi-hub 啟動 Kimi，就能從這裡操作。';
  }
  return null;
}

export const interrupt = (session) => mirrorFor(session).interrupt();
export const respond = (session, eventId, optionId, extra) => mirrorFor(session).respond(eventId, optionId, extra);
const followed = async (session) => {
  const m = mirrorFor(session);
  await m.ensureLive();
  return m;
};
export const configure = async (session, change) => (await followed(session)).configure(change);
export const command = async (session, name, args) => (await followed(session)).command(name, args);
export const cancelQueued = (session, promptId) => mirrorFor(session).cancelQueued(promptId);
export const loadEarlier = (session) => mirrorFor(session).loadEarlier();

// Who runs a followed conversation (terminal or server) shows next to it.
machines.onSessionChange((machineId, entry) => {
  const sid = byKimi.get(`${machineId}:${entry.id}`);
  const m = sid && mirrors.get(sid);
  if (!m) return;
  m.meta({ owner: entry.owner || null, controllable: entry.controllable ?? null, guess: Boolean(entry.guess) });
});

export function dispose(session) {
  clearInterval(mirrors.get(session.id)?.cutInTimer);
  mirrors.delete(session.id);
  byKimi.delete(`${session.machineId}:${session.kimiSessionId}`);
  machines.rpc(session.machineId, 'kimi.unsubscribe', { sessionIds: [session.kimiSessionId] }).catch(() => {});
}

// --- workspace panel, served by Kimi's session file APIs on the machine

export async function listFiles(session, rel = '.') {
  const r = await machines.kimiApi(session.machineId, 'POST', `/api/v1/sessions/${session.kimiSessionId}/fs:list`, { path: rel, depth: 1, limit: 500 });
  return (r.items || []).map((e) => ({ name: e.name, path: rel === '.' ? e.name : `${rel}/${e.name}`, dir: e.kind === 'directory' }));
}

export async function readFile(session, rel) {
  // A page outside the conversation's folder: the bridge reads it, if Kimi
  // wrote it in this conversation.
  const viaBridge = () => machines.rpc(session.machineId, 'kimi.artifact', { sessionId: session.kimiSessionId, path: rel }).then((r) => ({ path: rel, size: r.content.length, binary: false, content: r.content }));
  if (/\.html?$/i.test(rel) && (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('..'))) return viaBridge();
  try {
    return await readInFolder(session, rel);
  } catch (err) {
    if (/\.html?$/i.test(rel)) return viaBridge().catch(() => Promise.reject(err));
    throw err;
  }
}

async function readInFolder(session, rel) {
  const r = await machines.kimiApi(session.machineId, 'POST', `/api/v1/sessions/${session.kimiSessionId}/fs:read`, { path: rel, encoding: 'auto' });
  const binary = r.encoding === 'base64' || r.is_binary;
  return { path: rel, size: r.size, binary, tooLarge: r.truncated && r.size > 2 * 1024 * 1024, content: binary ? '' : r.content };
}

export async function getChanges(session, summarize) {
  let st;
  try {
    st = await machines.kimiApi(session.machineId, 'POST', `/api/v1/sessions/${session.kimiSessionId}/fs:git_status`, {});
  } catch {
    return { git: false, files: [], diff: '' };
  }
  let diff = '';
  const entries = Object.entries(st.entries || {}).filter(([, s]) => s !== 'clean' && s !== 'ignored').slice(0, 60);
  for (const [p, status] of entries) {
    if (status === 'untracked' || status === 'added') {
      try {
        const f = await readFile(session, p);
        const lines = f.binary ? ['(二進位檔案)'] : (f.content || '').replace(/\n$/, '').split('\n');
        diff += `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
        continue;
      } catch {}
    }
    try {
      const d = await machines.kimiApi(session.machineId, 'POST', `/api/v1/sessions/${session.kimiSessionId}/fs:diff`, { path: p });
      if (d.diff) diff += d.diff.endsWith('\n') ? d.diff : `${d.diff}\n`;
    } catch {}
  }
  return { git: true, branch: st.branch, files: summarize(diff), diff };
}
