// Kimi Code sessions on remote machines, driven through the bridge and Kimi's
// own Server API (`kimi web`). The adapter is *live*: a hub session mirrors a
// Kimi session continuously, so turns started in Kimi's own UI, approvals
// answered elsewhere, subagents and the Kimi-side title all show up in the
// hub as they happen.
import crypto from 'node:crypto';
import * as machines from '../machines.js';
import * as store from '../store.js';
import * as repoBind from './claude-repo.js';
import * as deepseek from '../deepseek-account.js';
import * as modelDrift from '../model-drift.js';
import { issueToken, revokeSession } from '../subagent-broker.js';
import * as policy from '../subagent-policy.js';
import { remoteHost } from './claude-tools.js';
import * as clusterMemory from '../cluster-memory.js';
import * as timing from '../timing.js';

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
// What can be moved to the background: Kimi's server calls them subagent
// and bash (its terminal, agent and process).
const DETACHABLE = new Set(['subagent', 'bash', 'agent', 'process']);
// Kimi's name for the Agent Hub delegation MCP tool.
const DELEGATE_TOOL = /(^|__)delegate_to_provider$/;
// The note on Agent Hub's own reminders to commit and push (see checkRepo).
const REPO_CHECK_NOTE = 'Agent Hub 檢查：還有沒上傳到 GitHub 的工作';
// Turns loaded when a conversation is opened, and per 「載入更早的對話」.
const HISTORY_TURNS = 10;
// A conversation nobody has open, that is not working, stops following the
// machine after this long; opening it again catches up from Kimi's journal.
const IDLE_FOLLOW_MS = 15 * 60_000;
// How long a message the hub showed may wait for Kimi's journal to hold it.
const UNJOURNALED_MS = 10 * 60_000;
const MAX_IMAGE_URL = 600_000; // history images larger than this become a placeholder
// How long a change of model sent to the native waits for the native to say
// what it took (agent.status.updated) before it counts as accepted. Kimi
// journals a change with its next turn, so a quiet native is normal; a native
// that answers with ANOTHER model is not.
const PROFILE_CONFIRM_MS = Number(process.env.AGENT_HUB_PROFILE_CONFIRM_MS) || 800;
// How long a terminal Kimi takes to put up a picker after the command that
// opens it. A key that comes before the picker is up goes to the input box
// instead, so this is generous (the real Kimi 2.3.3 takes well under a second).
const TUI_PICKER_MS = Number(process.env.AGENT_HUB_TUI_PICKER_MS) || 1500;
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
  // Kimi's models only: the DeepSeek ones are not Kimi's to default to.
  store.migrateSettings('model-k3-256k', (d) => {
    const k3 = v.models.filter((m) => !m.deepseek).find((m) => /k3[-_ ]?256k/i.test(`${m.id} ${m.name}`));
    if (!k3) return false;
    if (!d.model) d.model = k3.id;
  });
  return v;
}
export const modelsFor = (machineId) => machineModels(machineId).then(({ models, defaultModel }) => ({ models, defaultModel }));
// The machine's Kimi got (or lost) the DeepSeek provider: list its models again.
export const forgetModels = (machineId) => modelCache.delete(machineId);

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

// `deepseek`: one of the DeepSeek provider's models (server/deepseek-account.js),
// which only DeepSeek conversations offer; DeepSeek thinks at max unless told.
export const modelInfo = (m) => {
  const ds = deepseek.isDeepseekModel(m.model);
  return {
    id: m.model,
    name: m.display_name || m.model.split('/').pop(),
    efforts: effortsFor(m),
    defaultEffort: ds ? deepseek.DEFAULT_EFFORT : m.default_effort || null,
    image: (m.capabilities || []).includes('image_in'),
    context: m.max_context_size || null,
    ...(ds ? { deepseek: true } : {}),
  };
};

// Text a user typed (or a slash command) for a turn Kimi started.
function promptLabel(p) {
  const o = p.origin || {};
  if (o.kind === 'skill_activation') return `/${o.skillName}${o.skillArgs ? ` ${o.skillArgs}` : ''}`;
  if (o.kind === 'plugin_command') return `/${o.commandName}${o.commandArgs ? ` ${o.commandArgs}` : ''}`;
  if (o.kind === 'shell_command') return `! ${p.prompt || ''}`;
  if (o.kind === 'user') return p.prompt || '';
  return null;
}

// The one rule for typing into a terminal Kimi from the hub. Callable for a
// conversation the hub follows or not: it needs only the machine and Kimi's
// session id. Only the machine's current entry counts, and only a terminal
// the bridge controls (`owner === 'tui'`, `controllable === true`, not a
// guess). A missing entry, `null`/missing control or a guess is NOT control:
// the caller uses Kimi's server API instead.
export function canDriveTerminal(machineId, kimiSessionId) {
  const entry = machines.getMachine(machineId)?.sessions?.find((s) => s.id === kimiSessionId);
  return Boolean(entry) && entry.owner === 'tui' && entry.controllable === true && !entry.guess;
}

const now = () => Date.now();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newPromptId = () => `hub_${crypto.randomBytes(9).toString('hex')}`;

// ---------------------------------------------------------------- mirror

export class Mirror {
  constructor(session) {
    this.session = session;
    this.machineId = session.machineId;
    this.kid = session.kimiSessionId;
    this.mine = new Set(session.state.mine || []); // prompt ids sent from the hub
    // User messages the hub has shown (sent over Kimi's server API) that Kimi's
    // journal may not hold yet: prompt id -> { id: event id, at }. A catch-up
    // rebuilds the transcript from the journal; these are kept through it until
    // the journal has them (see replay). In memory only.
    this.unjournaled = new Map();
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

  // Whether the hub may type into this conversation's terminal Kimi: the
  // module's canDriveTerminal() rule, on the machine's current entry. The
  // saved `meta` (owner/controllable) is for display only and never decides.
  canDriveTerminal() {
    return canDriveTerminal(this.machineId, this.kid);
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
    policy.refreshSoon(this.session);
    // Waiting to cut in from before (the hub restarted meanwhile).
    if (this.queue().some((q) => q.cutIn && !q.steered)) this.retryCutIns();
    this.resumeQueue();
    await this.applyDefaults();
  }

  // What the hub only held in memory about its queue, from the saved queue
  // (the hub restarted, or the machine reconnected): messages typed into a
  // terminal, to match Kimi's turn.start/turn.steer for them, and the timer
  // that moves foreground work aside for an 「優雅暫停」 not read yet.
  resumeQueue() {
    this.tuiPending ??= [];
    for (const q of this.queue()) {
      if (q.terminal && !this.tuiPending.some((x) => x.promptId === q.promptId)) this.tuiPending.push({ text: q.text, queued: true, promptId: q.promptId });
      if (q.urgent && q.steered && !this.urgentTimers?.has(q.promptId)) this.watchUrgent(q.promptId);
    }
  }

  // The first time the hub opens a conversation, it gets the model,
  // thinking and permission from 設定 (plan mode is left as it was).
  // Changed afterwards in the conversation, it stays changed.
  // Every time the hub opens a conversation: what was not chosen in it from
  // the hub (model, thinking, permission) is set as 設定 says, whatever Kimi
  // started it with or fell back to. What was chosen in it stays.
  async applyDefaults() {
    // Not the old read-only lock: an existing terminal conversation keeps the
    // model/effort/permission it already has (the rule just below), so merely
    // opening one must not rewrite its profile through any route.
    if (this.inTerminal()) return;
    // Global defaults belong to new conversations only. An existing native
    // conversation keeps the model/effort it was already running; otherwise
    // merely opening it from the Hub would rewrite its choice.
    if (this.session.state?.defaultsApplied) return;
    if (this.session.meta?.model) {
      const { modelUnconfirmed, ...state } = this.session.state || {};
      this.session.state = { ...state, defaultsApplied: true };
      store.saveSession(this.session);
      return;
    }
    // The native has not said which model it runs (a journal that is behind,
    // a status not read yet). That is not "a conversation without a model":
    // the machine-wide defaults must not be laid over something that is
    // merely not known yet. They are left alone, and the conversation is
    // marked unconfirmed; the next time it is opened and the native has
    // spoken, this runs again and (with a model known) only records that.
    this.session.state = { ...(this.session.state || {}), modelUnconfirmed: true };
    store.saveSession(this.session, { touch: false });
    // The one default that is not about the model, still given to a
    // conversation that has never had it.
    const d = store.readSettings().defaults || {};
    const chosen = this.session.state.userSet || {};
    if (!PERMISSIONS.includes(d.permission) || chosen.permission || modelDrift.isDeepseekFamily(this.session)) return;
    this.session.state.defaultsApplied = true;
    store.saveSession(this.session);
    await this.configure({ permission: d.permission }).catch((err) => console.warn(`[kimi] defaults for ${this.session.id}: ${err.message}`));
  }

  // Follow the machine again before acting on a conversation that stopped.
  async ensureLive() {
    this.viewedAt = now();
    if (!this.live) await (this.attaching ?? this.startAttach());
  }

  // Every catch-up that makes the conversation "live" goes through here, so
  // that whoever needs it (a message being sent, a page opened, the machine
  // coming back) waits for the one in progress instead of starting a second.
  // Two at once is how a message typed in between was lost: the slower one
  // rebuilt the transcript from a journal read made before the message, over
  // the message and the answer already shown.
  startAttach() {
    const p = this.attach().finally(() => {
      if (this.attaching === p) this.attaching = null;
    });
    this.attaching = p;
    return p;
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

  applyStatus({ model, effort, permission, planMode, swarmMode, context, contextTokens }) {
    const f = {};
    if (model !== undefined && model !== null) f.model = model || '';
    if (effort !== undefined && effort !== null) f.effort = effort || 'off';
    if (PERMISSIONS.includes(permission)) f.permission = permission;
    if (planMode !== undefined) f.planMode = Boolean(planMode);
    if (swarmMode !== undefined) f.swarmMode = Boolean(swarmMode);
    // When the native's model last changed (a replayed record carries its own
    // time): how long a disagreement with the Hub's record has stood.
    if (f.model && f.model !== this.session.meta?.model) f.modelAt = this.batchTime || now();
    // The journal only has the token count; the window size comes from the
    // model list.
    if (contextTokens != null) this.contextUsed = contextTokens;
    if (context?.used != null) this.contextUsed = context.used;
    const used = this.contextUsed ?? this.session.meta?.context?.used;
    const id = f.model ?? this.session.meta?.model ?? this.defaultModel;
    const size = context?.size || (this.session.meta?.models || []).find((m) => m.id === id)?.context || this.session.meta?.context?.size;
    if (used != null && size) f.context = { used, size };
    this.meta(f);
    if (!model) return;
    const session = this.session;
    // An old record has no provider of its own and was read from what it
    // kept. The native's alias settles it (spec 3.1): a conversation whose
    // native runs the DeepSeek provider is a DeepSeek one. One look only; a
    // provider the user or a switch set carries no such mark.
    if (session.providerInferred) {
      delete session.providerInferred;
      if (modelDrift.providerOfAlias(model) === 'deepseek' && session.provider !== 'deepseek') {
        session.provider = 'deepseek';
        session.mode = 'deepseek';
        session.state = { ...(session.state || {}), deepseek: session.state?.deepseek || { gateway: deepseek.gateway(), model } };
        session.modelConfig = { provider: 'deepseek', model, effort: effort ?? session.modelConfig?.effort ?? '' };
      }
      store.saveSession(session, { touch: false });
    }
    // A terminal/other client may have changed the native profile. Follow it
    // unless this conversation's own user choice is what should win, and only
    // inside the conversation's own family: a native that moved to another
    // provider's model (a DeepSeek conversation reporting a Kimi model) is a
    // disagreement to show, never the Hub's record of what was chosen.
    if (!session.state?.userSet?.model) {
      const provider = session.provider === 'deepseek' || session.mode === 'deepseek' ? 'deepseek' : 'kimi';
      if (modelDrift.providerOfAlias(model) !== provider) return;
      session.modelConfig = {
        ...(session.modelConfig || {}),
        provider,
        model,
        effort: effort ?? session.modelConfig?.effort ?? '',
      };
      store.saveSession(session);
    }
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
    this.ctx.replaceEvents([...events, ...this.carriedOver(events)]);
    if (status) this.ctx.setStatus(status);
    this.ctx.setMeta({});
  }

  // What the hub showed of its own that the journal just read does not hold
  // yet: a message sent from the hub (its prompt id is the key) whose turn
  // Kimi has not written down. The journal is the truth about what happened,
  // but it is only as new as the moment it was read; replacing the transcript
  // with it must not take back a message the user sent after that. Once the
  // journal has the prompt, its copy is the one shown and the hub's is
  // dropped. A message the journal never gets (Kimi refused it, the machine
  // lost it) is not kept for ever: after UNJOURNALED_MS it is let go.
  // Not covered: a message typed into a terminal from the hub (sendToTerminal).
  // Its event has no prompt id the journal could be matched by (Kimi's own turn
  // carries another id), and matching by text would drop a repeated "好".
  carriedOver(journaled) {
    const have = new Set(journaled.filter((e) => e.type === 'user' && e.promptId).map((e) => e.promptId));
    const kept = [];
    for (const [promptId, entry] of this.unjournaled) {
      const ev = this.session.events.find((e) => e.id === entry.id);
      if (have.has(promptId) || !ev || now() - entry.at > UNJOURNALED_MS) this.unjournaled.delete(promptId);
      else kept.push(ev);
    }
    return kept;
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
          ...policy.contract({ requested: null, actual: null, reason: policy.UNVERIFIED.replay }),
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

  // The Agent Hub delegation tool is one card per delegation. The Hub's
  // request can arrive before Kimi's own frame for the same call: then the
  // card the delegation already made is Kimi's card too, found by the task
  // it was given (the MCP protocol carries no call id to match on).
  adoptDelegation(p) {
    const task = String(p.args?.task || '').replace(/\s+/g, ' ').trim();
    if (!task) return null;
    return (
      this.events().find(
        (e) => e.type === 'tool_use' && e.brokerSynthetic && !e.brokerChildId && !e.toolCallId && String(e.input?.task || '').replace(/\s+/g, ' ').trim() === task,
      ) || null
    );
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
    // Bound to a GitHub repository: a push elsewhere, a force push or a
    // change of remote is refused for the user.
    const repo = this.session.repo;
    const command = ev.input?.command || display?.command;
    const why = !plan && repo && /^(Bash|Shell)$/.test(a.tool_name) && typeof command === 'string' && repoBind.guard(command, repo);
    if (why) {
      this.ctx.emit({ type: 'info', text: `Agent Hub 擋下了這個指令：這個對話綁定 ${repo.full} 的 ${repo.branch}` });
      this.respond(ev.id, 'rejected', { feedback: `Refused by Agent Hub: ${why}. This conversation is bound to ${repo.full}, branch ${repo.branch}; push your commits there with \`git push -u origin ${repo.branch}\`, and never force-push.` }).catch(() => {});
    }
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
      // The spawned frame carries the model and effort the subagent actually
      // runs on; showing them here means the card is right from the start,
      // not only after the first status update.
      this.ctx.patch(parent, {
        subagent: {
          ...parent.subagent,
          id,
          name: known?.btw ? 'btw' : p.subagentName || 'subagent',
          description: p.description || parent.subagent?.description || '',
          status: 'running',
          background: Boolean(p.runInBackground),
          ...(p.model ? { model: p.model } : {}),
          ...(p.thinkingEffort ? { effort: p.thinkingEffort } : {}),
          ...this.contractAt(parent, known, p.model, p.thinkingEffort),
        },
      });
      this.flushEarly(id);
      return;
    }
    const a = this.agents.get(id);
    const parent = (a && this.events().find((e) => e.id === a.parent)) || this.events().find((e) => e.subagent?.id === id);
    if (!parent?.subagent) return;
    if (!a) this.agents.set(id, { parent: parent.id, background: Boolean(parent.subagent.background) });
    const status = { 'subagent.started': 'running', 'subagent.completed': 'done', 'subagent.failed': 'error', 'subagent.cancelled': 'cancelled', 'subagent.suspended': 'suspended' }[type];
    if (!status) return;
    this.closeBlock(id);
    this.ctx.patch(parent, { subagent: { ...parent.subagent, status, summary: p.resultSummary ?? parent.subagent.summary, error: p.error } });
  }

  // The request/actual/unverified part of a subagent card. `requested` is the
  // snapshot taken when the card was made (or, for a card first seen now, the
  // setting as it is now); `actual` only ever comes from what Kimi reported.
  contractAt(card, known, model, effort) {
    const was = card.subagent || {};
    const requested = was.requested !== undefined ? was.requested : policy.requestedSnapshot(this.session);
    const actual = policy.actualOf(model, effort) || (was.actual && !known?.btw ? was.actual : null);
    return policy.contract({ requested, actual, reason: known?.btw ? policy.UNVERIFIED.btw : policy.UNVERIFIED.noModel });
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
        // The note it was sent with (「自動暫停：…」) stays with the message.
        const q = this.dequeue(x.promptId);
        return this.ctx.emit({ type: 'user', text, images, promptId, source: 'hub', ...(q?.note ? { note: q.note } : {}), ...extra });
      }
      return null;
    }
    const q = promptId && this.dequeue(promptId);
    if (q) return this.ctx.emit({ type: 'user', text: q.text, images: q.images, promptId, source: q.foreign ? 'kimi' : 'hub', note: q.note, ...extra });
    if (promptId && this.mine.has(promptId)) {
      this.unjournaled.delete(promptId); // Kimi has started its turn: the journal has it
      return null;
    }
    if (text == null || (!text && !images?.length)) return null;
    return this.ctx.emit({ type: 'user', text, images, promptId, source: 'kimi', note: this.inTerminal() ? '在終端機送出' : '在 Kimi 端送出', ...extra });
  }

  onFrame(frame) {
    // The time of the conversation is added up from the frames as Kimi stamped
    // them (server/timing.js); a frame seen again changes nothing there.
    timing.observe(this.session.id, frame);
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
        // A new turn may be one Kimi lets the waiting messages into: all of
        // them go in now (when Kimi's own turn refused them, the turn it
        // starts for the first one takes the others).
        if (!this.batch && this.queue().some((q) => q.cutIn && !q.steered && !q.terminal)) setTimeout(() => this.tryCutIns(), 300);
        this.closeBlock();
        this.turn = { started: now(), input: 0, output: 0, id: p.turnId };
        // Kimi fixes the model and thinking for the whole turn when it
        // starts: a change made during it applies from the next one.
        // The same moment fixes what this turn is: provider, model, thinking
        // and the subagent default (whoever started the turn: the user, an
        // auto-send, a queued message, or Kimi itself).
        this.meta({
          // What runs the turn is what the native reports, not the label of
          // the conversation: a DeepSeek conversation whose native sits on a
          // Kimi model runs this turn on the Kimi subscription.
          turnProvider: modelDrift.providerOfAlias(this.session.meta?.model) || (this.session.provider === 'deepseek' || this.session.mode === 'deepseek' ? 'deepseek' : 'kimi'),
          turnModel: this.session.meta?.model || '',
          turnEffort: this.session.meta?.effort || '',
          turnSubagent: this.session.meta?.subagent || null,
        });
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
        // Kimi's own frames for the Agent Hub delegation tool wait until the
        // call is complete (tool.call.started): the delegation may already
        // have a card, and the two must be one card (see adoptDelegation).
        if (DELEGATE_TOOL.test(p.name || '') && !this.tools.has(`${agentId}:${p.toolCallId}`)) return;
        const ev = this.tool(agentId, p.toolCallId, { name: p.name || 'tool' }, parent);
        if (p.argumentsPart) this.ctx.delta(ev, p.argumentsPart, 'argsText');
        return;
      }
      case 'tool.call.started': {
        if (DELEGATE_TOOL.test(p.name || '') && !this.tools.has(`${agentId}:${p.toolCallId}`)) {
          const card = this.adoptDelegation(p);
          if (card) {
            this.tools.set(`${agentId}:${p.toolCallId}`, card);
            this.ctx.patch(card, { toolCallId: p.toolCallId, agentId, display: p.display });
            return;
          }
        }
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
        // An Agent call is a subagent card from the start: what the
        // conversation asked for is fixed now; what really runs is known
        // only when Kimi says so (subagent.spawned).
        if (/^(Agent|AgentSwarm)$/.test(p.name) && !ev.subagent) fields.subagent = { status: 'pending', ...policy.contract({ requested: policy.requestedSnapshot(this.session), reason: policy.UNVERIFIED.pending }) };
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
        const output = outputText(p.output);
        const fields = { status: p.isError ? 'error' : 'done', isError: Boolean(p.isError), output };
        const end = ev.subagent && /^status:\s*(completed|failed|cancelled)\s*$/m.exec(output);
        if (end && !(p.isError && end[1] === 'completed')) {
          const summaryAt = output.indexOf('[summary]');
          const summary = summaryAt >= 0 ? output.slice(summaryAt + '[summary]'.length).trim() : '';
          fields.subagent = {
            ...ev.subagent,
            status: { completed: 'done', failed: 'error', cancelled: 'cancelled' }[end[1]],
            ...(summary ? { summary } : {}),
          };
        } else if (ev.subagent && !ev.subagent.broker && ['running', 'pending', undefined, ''].includes(ev.subagent.status)) {
          // The tool call is over, so its subagent cannot still be running:
          // a card that stays "running" under a finished call spins for ever.
          // A transport error (even one whose text says "completed") is an
          // error; a clean result without a status line is done. Only a
          // background launch (the call returns at once) keeps going, and
          // Kimi says when it ends.
          if (p.isError) fields.subagent = { ...ev.subagent, status: 'error', error: output.slice(0, 2000) || '子代理失敗' };
          else if (!(ev.subagent.background && ev.subagent.status === 'running')) fields.subagent = { ...ev.subagent, status: 'done', ...(output.trim() && !ev.subagent.summary ? { summary: output.trim().slice(0, 20_000) } : {}) };
        }
        this.ctx.patch(ev, fields);
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
          // Someone waits for the native to name the model it took.
          if (!this.batch && p.model) for (const w of this.statusWaiters?.splice(0) || []) w(p.model);
          this.applyStatus({
            model: p.model,
            effort: p.thinkingEffort,
            permission: p.permission,
            planMode: p.planMode,
            swarmMode: p.swarmMode,
            context: p.maxContextTokens ? { used: p.contextTokens || 0, size: p.maxContextTokens } : undefined,
            contextTokens: p.contextTokens,
          });
        } else if (p.model || p.thinkingEffort) {
          // A subagent's own model and thinking, shown with it.
          const a = this.agents.get(agentId);
          const card = a && this.events().find((e) => e.id === a.parent);
          if (card?.subagent) {
            const model = p.model || card.subagent.model;
            const effort = p.thinkingEffort || card.subagent.effort;
            this.ctx.patch(card, { subagent: { ...card.subagent, model, effort, ...policy.contract({ requested: card.subagent.requested ?? null, actual: policy.actualOf(model, effort), reason: policy.UNVERIFIED.noModel }) } });
          }
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
    this.meta({ turnProvider: null, turnModel: null, turnEffort: null, turnSubagent: null });
    for (const [key, ev] of this.tools) if (!lives(ev)) this.tools.delete(key);
    if (this.session.repo && !this.batch && p.reason !== 'cancelled' && p.reason !== 'failed') setTimeout(() => this.checkRepo().catch((err) => console.warn(`[kimi] repo check: ${err.message}`)), 300);
    // Also after the terminal is gone: a held message is still delivered, by
    // whichever route is valid then (flushTerminalQueue decides).
    if (!this.batch && (this.inTerminal() || this.queue().some((q) => q.terminal && !q.steered))) setTimeout(() => this.flushTerminalQueue(), 400);
  }

  // Bound to a GitHub repository: at the end of a turn, nothing may stay
  // uncommitted or unpushed. Kimi is reminded (twice at most, the rules
  // with it), then Agent Hub commits and pushes what is left itself.
  async checkRepo() {
    const repo = this.session.repo;
    if (!repo || this.session.meta?.planMode || this.queue().length || ['running', 'awaiting_permission'].includes(this.session.status)) return;
    const host = remoteHost(this.machineId);
    const left = await repoBind.check(host, repo.dir, repo);
    if (!left) return void (this.repoNudges = 0);
    if ((this.repoNudges || 0) < 2) {
      this.repoNudges = (this.repoNudges || 0) + 1;
      await this.send(`${left.en}\n\n${repoBind.rulesNote(repo)}`, [], { note: REPO_CHECK_NOTE });
      return;
    }
    this.repoNudges = 0;
    const saved = await repoBind.autoSave(host, repo.dir, repo, left);
    this.ctx.emit({ type: saved.ok ? 'info' : 'error', text: saved.text.replaceAll('Claude', 'Kimi') });
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
  // `urgent` (「優雅暫停」) is kept with the queued message, like on the API
  // route: once Kimi has taken it in, watchUrgent moves foreground work aside.
  async sendToTerminal(text, images, note, steer, urgent) {
    if (images.length) throw Object.assign(new Error('終端機裡的 Kimi 沒辦法從中控台接收圖片'), { status: 400 });
    this.tuiPending ??= [];
    const busy = ['running', 'awaiting_permission'].includes(this.session.status);
    const item = { text, queued: busy, promptId: `tui_${crypto.randomBytes(5).toString('hex')}` };
    this.tuiPending.push(item);
    if (busy) {
      this.meta({ queue: [...this.queue(), { promptId: item.promptId, text, images: [], note, steered: Boolean(steer), terminal: true, ...(steer && urgent ? { urgent: true } : {}) }] });
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
    if (busy && urgent) this.watchUrgent(item.promptId);
    return { ok: true };
  }

  // A terminal queue item moves to the route that is valid now (Kimi's server
  // API), leaving nothing of the terminal route behind: its entry in
  // tuiPending would otherwise match Kimi's turn for it a second time (a
  // duplicate message, a queue that never empties). When the API route does
  // not take it either, the item is put back, so it can be tried again.
  async rerouteTerminalItem(item, { steer = false } = {}) {
    const pending = (this.tuiPending || []).find((x) => x.promptId === item.promptId);
    this.dequeue(item.promptId);
    this.tuiPending = (this.tuiPending || []).filter((x) => x.promptId !== item.promptId);
    const putBack = () => {
      if (!this.queue().some((q) => q.promptId === item.promptId)) this.meta({ queue: [item, ...this.queue()] });
      if (!this.tuiPending.some((x) => x.promptId === item.promptId)) this.tuiPending.push(pending || { text: item.text, queued: true, promptId: item.promptId });
    };
    let r;
    try {
      r = await this.send(item.text, item.images || [], { note: item.note, steer });
    } catch (err) {
      putBack();
      throw err;
    }
    if (r?.ok === false) putBack();
    return r;
  }

  // After a terminal turn, type the next held message into Kimi. A terminal
  // queue item left over from before the hub lost control must not be typed
  // into that terminal: it goes through Kimi's server API instead. When the
  // terminal refuses the typing, the route is decided again on the machine's
  // current state; if it is still the terminal, the message stays queued (not
  // marked as typed) with an error shown, to be steered or cancelled by hand.
  async flushTerminalQueue() {
    const next = this.queue().find((q) => q.terminal && !q.steered);
    if (!next || ['running', 'awaiting_permission'].includes(this.session.status)) return;
    // The caller is a timer that is not awaited: report a failed send here.
    const reroute = () => this.rerouteTerminalItem(next).catch((err) => this.ctx.emit({ type: 'error', text: err.message }));
    if (!this.canDriveTerminal()) return reroute();
    this.markQueued(next.promptId, { steered: true });
    try {
      await this.tui({ action: 'send', text: next.text, mode: 'enter' });
    } catch (err) {
      this.markQueued(next.promptId, { steered: false });
      if (!this.canDriveTerminal()) return reroute();
      this.ctx.emit({ type: 'error', text: `終端機沒有收下排隊的訊息「${next.text}」：${err.message}。訊息還在佇列裡，可以再送出或取消。` });
    }
  }

  async steerQueued(promptId) {
    const q = this.queue().find((x) => x.promptId === promptId);
    if (!q || q.steered) return;
    if (q.terminal && this.canDriveTerminal()) {
      this.markQueued(promptId, { steered: true });
      const busy = ['running', 'awaiting_permission'].includes(this.session.status);
      try {
        await this.tui({ action: 'send', text: q.text, mode: busy ? 'steer' : 'enter' });
      } catch (err) {
        // Not typed: it is still held, not "already in the terminal".
        this.markQueued(promptId, { steered: false });
        throw err;
      }
    } else if (q.terminal) {
      // The terminal is no longer controllable: deliver the held message the
      // way a new one is delivered now, keeping the steer intent.
      await this.rerouteTerminalItem(q, { steer: true });
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
  // `hidden`: a note for Kimi only, sent with the message (not shown here).
  failSend(promptId, text, busy) {
    this.dequeue(promptId);
    this.unjournaled.delete(promptId);
    this.ctx.emit({ type: 'error', text });
    if (!busy) this.ctx.setStatus('idle');
    return { ok: false, error: text };
  }

  // A terminal Kimi takes the message by typing into it only while the hub
  // controls that terminal; any other conversation (including one in an
  // uncontrollable terminal) goes through Kimi's server API. A DeepSeek turn
  // needs its provider on the computer first, whichever route it takes.
  async send(text, images = [], { note, steer, urgent, hidden } = {}) {
    if (deepseek.isDeepseek(this.session)) {
      await ensureServer(this.machineId);
      await deepseek.ensureProvider(this.machineId);
    }
    // A conversation the Hub has recorded on one model must not quietly run a
    // turn on another (a different provider means a different bill).
    const refused = await this.guardNativeModel();
    if (refused) return refused;
    // The subagent policy is decided for every prompt, whichever route takes
    // it: what the conversation asks for is only honoured if it can be. The
    // API route decides it once the message is shown and the conversation is
    // marked running (a read of the computer must not delay that); only the
    // terminal route needs it first, to know whether typing is enough.
    if (this.canDriveTerminal()) {
      const subagent = await this.subagentPolicy();
      if (!this.policyNeedsPromptBody(subagent)) return this.sendToTerminal(text, images, note, steer, urgent);
      return this.sendViaApi(text, images, { note, steer, urgent, hidden, subagent });
    }
    return this.sendViaApi(text, images, { note, steer, urgent, hidden });
  }

  // "Kimi K3.1 Pro" / "DeepSeek V4.1 Flash" for a model alias, as the page's
  // model list names it.
  modelText(model) {
    const provider = modelDrift.providerOfAlias(model);
    const label = { kimi: 'Kimi', deepseek: 'DeepSeek', claude: 'Claude' }[provider] || '';
    const name = (this.session.meta?.models || []).find((m) => m.id === model)?.name || deepseek.displayName(model);
    return new RegExp(`^${label}\\s`, 'i').test(name) ? name : `${label} · ${name}`.trim();
  }

  // The model to put back on the native, from what the Hub recorded: the
  // recorded model (only if it belongs to the conversation's family), else
  // the one a DeepSeek conversation was made with. Never a default: with
  // nothing the user chose there is nothing to put back.
  restoreTarget(expected) {
    const own = (m) => m && modelDrift.providerOfAlias(m) === expected.provider;
    const model = own(expected.model) ? expected.model : own(this.session.state?.deepseek?.model) && expected.provider === 'deepseek' ? this.session.state.deepseek.model : '';
    if (!model) return null;
    const info = (this.session.meta?.models || []).find((m) => m.id === model);
    const efforts = info?.efforts || [];
    const effort = expected.effort && (!efforts.length || efforts.includes(expected.effort)) ? expected.effort : info?.defaultEffort || undefined;
    return { model, effort };
  }

  // Before a message goes out: if the native reports a model other than the
  // one the user chose in the Hub, put the choice back first (one /profile
  // change, confirmed), or do not send. Spec 2: no silent change of provider
  // or of billing, in either direction.
  //  - A conversation that runs in a terminal (the user may have changed the
  //    model there on purpose) is never overwritten: it is said once in the
  //    conversation, and the page offers the button.
  //  - Nothing the user chose in the Hub (the model was never set by them, the
  //    Hub only followed the native) is nothing to restore.
  //  - A restore that fails is a refusal to send, said in the conversation.
  async guardNativeModel() {
    const session = this.session;
    const drift = modelDrift.driftOf(session);
    if (!drift) {
      if (session.state?.driftNoticed) {
        session.state = { ...session.state, driftNoticed: null };
        store.saveSession(session, { touch: false });
      }
      return null;
    }
    const asked = drift.expected.model ? this.modelText(drift.expected.model) : { kimi: 'Kimi', deepseek: 'DeepSeek' }[drift.expected.provider];
    const running = this.modelText(drift.actual.model);
    if (this.inTerminal()) {
      const sig = `${drift.actual.model}|${drift.expected.model}`;
      if (session.state?.driftNoticed !== sig) {
        session.state = { ...(session.state || {}), driftNoticed: sig };
        store.saveSession(session, { touch: false });
        this.ctx.emit({ type: 'info', text: `注意：這個對話在終端機的 Kimi 裡，原生目前用的是「${running}」，與你在 Hub 選的「${asked}」不同。Hub 不會覆寫你在終端機做的選擇；這則訊息照原生目前的模型執行。要改回「${asked}」，按輸入框旁的按鈕。` });
      }
      return null;
    }
    if (!modelDrift.userChose(session, drift)) return null;
    const target = this.restoreTarget(drift.expected);
    const busy = ['running', 'awaiting_permission'].includes(session.status);
    const refuse = (why) => {
      const text = `訊息沒有送出：這個對話在原生 Kimi 裡用的是「${running}」，與你選的「${asked}」不同，${why}。為了不讓這一輪在不是你選的模型上執行（可能計到另一家的帳），先停下；請在輸入框重新選一次模型再送出。`;
      if (!busy) throw Object.assign(new Error(text), { status: 502 });
      // A turn is running: an exception would be taken for that turn failing.
      this.ctx.emit({ type: 'error', text });
      return { ok: false, error: text };
    };
    if (!target) return refuse('也找不到可以改回的模型');
    try {
      await (this.restoring ??= this.configure({ model: target.model, effort: target.effort, confirm: true }).finally(() => (this.restoring = null)));
    } catch (err) {
      return refuse(`改回時失敗（${err.message}）`);
    }
    this.ctx.emit({ type: 'info', text: `偵測到原生對話正在用「${running}」，已依你的選擇改回「${this.modelText(target.model)}」${target.effort ? `（思考 ${target.effort}）` : ''}，再送出這則訊息。` });
    return null;
  }

  // What the conversation's subagent setting can really do right now (see
  // subagent-policy.js); a problem is said once in the conversation.
  async subagentPolicy() {
    const p = await policy.refresh(this.session).catch((err) => ({ route: 'native-rule', ready: null, code: 'unknown', reason: err.message, requested: null }));
    policy.announce(this.session, p, this.ctx);
    return p;
  }

  // Tool policy and the delegation token travel in a prompt body. Typing
  // into a terminal carries neither (and a token must never be typed where it
  // would be shown), so a prompt that needs them, or that has to put the
  // native tools back, is sent over Kimi's server API.
  policyNeedsPromptBody(p) {
    return p?.route === 'broker' || p?.route === 'blocked' || this.session.state?.nativeSubagentDisabled === true;
  }

  // The Kimi Server API route (everything the hub cannot type into a
  // terminal): queueing, steering, attachments and the prompt body are Kimi's.
  async sendViaApi(text, images = [], { note, steer, urgent, hidden, subagent: decided } = {}) {
    await ensureServer(this.machineId);
    const ctx = this.ctx;
    const promptId = newPromptId();
    this.remember(promptId, note);
    const thumbs = images.map((i) => i.thumb || `data:${i.mimeType};base64,${i.data}`);
    const busy = ['running', 'awaiting_permission'].includes(this.session.status);
    if (busy) this.meta({ queue: [...this.queue(), { promptId, text, images: thumbs, note, ...(steer ? { cutIn: true } : {}), ...(steer && urgent ? { urgent: true } : {}) }] });
    else {
      const shown = ctx.emit({ type: 'user', text, images: thumbs, promptId, source: 'hub', note });
      if (shown?.id) this.unjournaled.set(promptId, { id: shown.id, at: now() });
      ctx.setStatus('running');
    }
    const body = { prompt_id: promptId, content: this.content(text, images) };
    if (hidden) body.content.push({ type: 'text', text: `<system-reminder>${hidden}</system-reminder>` });
    // Bound to a GitHub repository: the rules go with the first message (and
    // with every reminder after).
    const repo = this.session.repo;
    if (repo && !repo.told) {
      body.content.unshift({ type: 'text', text: `<system-reminder>${repoBind.rulesNote(repo)}</system-reminder>` });
      this.session.repo = { ...repo, told: true };
      store.saveSession(this.session);
    }
    if (note !== REPO_CHECK_NOTE) this.repoNudges = 0;
    if (this.defaultModel === undefined) await this.loadModels().catch(() => {});

    // The next turn's explicit choice travels with this prompt, so it cannot
    // race a UI change made while the previous turn was still running.
    const mc = this.session.modelConfig || {};
    const dsChat = modelDrift.providerOf(this.session) === 'deepseek';
    if (mc.model && this.session.state.userSet?.model) {
      if (dsChat && !deepseek.isDeepseekModel(mc.model)) return this.failSend(promptId, 'DeepSeek 對話不能用 Kimi 的模型；已停止送出', busy);
      if (!dsChat && deepseek.isDeepseekModel(mc.model)) return this.failSend(promptId, 'Kimi 對話不能用 DeepSeek 的模型；已停止送出', busy);
      // A runtime switch uses the prompt-level model so the next turn is
      // atomic. New conversations already got their profile at creation.
      if (this.session.state.promptModel) body.model = mc.model;
    }
    if (mc.effort && this.session.state.userSet?.effort && this.session.state.promptModel) body.thinking = mc.effort;

    if (!this.session.meta?.model && !body.model) {
      // The native has not said which model it runs. What the Hub recorded
      // for the conversation (of the conversation's own family) is what it is
      // sent; only a Kimi conversation with nothing recorded falls back to
      // Kimi's default. A DeepSeek one - judged by any sign it keeps, not only
      // the legacy `mode` - must not fall back to Kimi's default (the
      // subscription's): it gets its own model, or nothing.
      const recorded = [mc.model, this.session.state.deepseek?.model];
      if (dsChat || modelDrift.isDeepseekFamily(this.session)) {
        const dsModel = recorded.find((m) => deepseek.isDeepseekModel(m));
        if (!dsModel) return this.failSend(promptId, '這個 DeepSeek 對話還沒有模型，為了不誤用 Kimi 訂閱的模型，沒有送出。請在輸入框選一個 DeepSeek 模型。', busy);
        body.model = dsModel;
      } else {
        const own = recorded.find((m) => m && modelDrift.providerOfAlias(m) === 'kimi');
        if (own) body.model = own;
        else if (this.defaultModel) body.model = this.defaultModel;
      }
    }

    // A runtime switch hands off on the first real prompt only. It is a
    // system reminder, not a fake user turn, and is cleared only after Kimi
    // accepted the prompt.
    const ho = this.session.handoff;
    if (ho?.text && !ho.consumedAt) {
      body.content.unshift({ type: 'text', text: `<system-reminder>${String(ho.text).replaceAll('</system-reminder>', '</ system-reminder>')}</system-reminder>` });
    }
    // The route the policy picked decides the tools of this prompt. Native:
    // Kimi's own Agent/AgentSwarm on the computer's [secondary_model], no
    // tool disabled and no token. Broker: the native tools are removed for
    // the session and a scoped token (this Hub node, this native session,
    // this machine; never an API key, never in a Hub event) goes with the
    // prompt, and only both together. Blocked: the request cannot be
    // honoured, so the native tools are held back rather than let a subagent
    // run on the main model while the card names another.
    const route = decided || (await this.subagentPolicy());
    this.session.state ??= {};
    const hold = ['Agent', 'AgentSwarm', 'agent', 'agent_swarm'];
    if (route.route === 'broker') {
      const sub = route.requested;
      const token = issueToken(this.session);
      if (!token) return this.failSend(promptId, 'Agent Hub 發不出這個對話的子代理 token（找不到它在這台電腦上的 Kimi 對話），沒有送出；子代理工具也沒有被停用。', busy);
      body.disabled_tools = hold;
      if (!this.session.state.nativeSubagentDisabled) {
        this.session.state.nativeSubagentDisabled = true;
        store.saveSession(this.session);
      }
      body.content.unshift({
        type: 'text',
        text: `<system-reminder>Agent Hub 已為這個對話設定子代理預設（${sub.provider}/${sub.model}${sub.effort ? `/${sub.effort}` : ''}）。需要子代理時，請呼叫 MCP tool mcp__agent-hub__delegate_to_provider，並在參數帶上 token "${token}"；不要使用原生 Agent 或 AgentSwarm。token 只對這個對話有效，會過期。</system-reminder>`,
      });
    } else if (route.route === 'blocked') {
      // A connector that cannot run the chosen route is an error, not a
      // reason to half-apply a policy: nothing is disabled and nothing sent.
      if (route.refuse) return this.failSend(promptId, `${route.reason}。${route.fix}`, busy);
      body.disabled_tools = hold;
      if (!this.session.state.nativeSubagentDisabled) {
        this.session.state.nativeSubagentDisabled = true;
        store.saveSession(this.session);
      }
    } else {
      // A native route has no token in force, and puts back any tool an
      // earlier prompt held back (broker, or a problem that is gone): Kimi
      // keeps the session's tool policy until a prompt replaces it.
      revokeSession(this.session.id);
      if (this.session.state.nativeSubagentDisabled) {
        body.disabled_tools = [];
        this.session.state.nativeSubagentDisabled = false;
        store.saveSession(this.session);
      }
    }

    // A worker of a cluster is told what was added to the cluster's memory
    // file since its last prompt (only that part), the same way a hand-off is:
    // a system reminder in front of the message, marked as told only once
    // Kimi took the prompt.
    const memo = await clusterMemory.pending(this.session);
    if (memo) body.content.unshift({ type: 'text', text: `<system-reminder>${memo.text.replaceAll('</system-reminder>', '</ system-reminder>')}</system-reminder>` });

    // 插隊 from the tray can come before Kimi has the prompt: it waits.
    const post = this.api('POST', this.path('/prompts'), body);
    (this.inflight ??= new Map()).set(promptId, post);
    try {
      const r = await post;
      if (r?.status === 'queued' && steer) await this.steer(promptId);
      if (ho && !ho.consumedAt) {
        ho.consumedAt = Date.now();
        store.saveSession(this.session);
      }
      clusterMemory.consumed(this.session, memo);
      return { ok: true, promptId };
    } catch (err) {
      clusterMemory.release(this.session, memo);
      this.dequeue(promptId);
      this.unjournaled.delete(promptId);
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
  // now. Only the conversation's own foreground work, only for this. Through
  // the terminal it is Ctrl+B itself (the route is decided when the wait is
  // over); through Kimi's server it is the conversation's own foreground
  // tasks. The wait is not kept across a restart: resumeQueue() starts it
  // again for a message still waiting in the saved queue.
  watchUrgent(promptId, round = 0) {
    this.urgentTimers ??= new Map();
    clearTimeout(this.urgentTimers.get(promptId));
    const t = setTimeout(async () => {
      this.urgentTimers.delete(promptId);
      const q = this.queue().find((x) => x.promptId === promptId);
      if (!q?.steered || !['running', 'awaiting_permission'].includes(this.session.status)) return; // read, or gone
      if (this.canDriveTerminal()) {
        const sent = await this.tui({ action: 'background' }).then(() => true, () => false);
        if (sent && round === 0) this.ctx.emit({ type: 'info', text: `為了讓 Kimi 馬上讀到「${q.text}」，在終端機按了 Ctrl+B，把它在前景等的工作移到背景（有的話會繼續跑）` });
      } else {
        const moved = await this.detachForeground().catch(() => 0);
        if (moved) this.ctx.emit({ type: 'info', text: `為了讓 Kimi 馬上讀到「${q.text}」，把它在前景等的 ${moved} 個工作移到背景（跟 Ctrl+B 一樣，工作會繼續跑）` });
      }
      if (round < 5) this.watchUrgent(promptId, round + 1);
    }, URGENT_DETACH_MS);
    t.unref?.();
    this.urgentTimers.set(promptId, t);
  }

  // `all`: every foreground subagent and command, as Kimi's own Ctrl+B
  // does; otherwise only what the conversation itself waits on.
  async detachForeground({ all = false } = {}) {
    const r = await this.api('GET', this.path('/tasks'));
    const mine = new Set([...this.tools.keys()].filter((k) => k.startsWith('main:')).map((k) => k.slice(5)));
    const fg = (r?.items || []).filter((t) => (t.run_in_background === false || t.detached === false) && t.status === 'running' && DETACHABLE.has(t.kind) && (all || mine.has(t.parent_tool_call_id)));
    let moved = 0;
    for (const t of fg) {
      try {
        await this.api('POST', this.path(`/tasks/${t.id}:detach`), {});
        moved++;
      } catch {
        continue;
      }
      // Its card: a background subagent from now on, kept running past the turn.
      const card = [...this.tools.entries()].find(([k]) => k.endsWith(`:${t.parent_tool_call_id}`))?.[1];
      if (card?.subagent) {
        this.ctx.patch(card, { subagent: { ...card.subagent, background: true } });
        const a = this.agents.get(card.subagent.id);
        if (a) a.background = true;
      }
    }
    return moved;
  }

  // 移到背景 (Ctrl+B) from the hub: what Kimi runs in the foreground goes
  // on in the background, and Kimi carries on without waiting for it.
  // A subagent swarm (AgentSwarm) cannot be moved there: Kimi has no way to
  // (its own Ctrl+B skips it too). It is said, with how many messages wait
  // for it, so the user can have it stopped instead (`interruptSwarm`).
  async moveToBackground({ interruptSwarm = false } = {}) {
    if (this.canDriveTerminal()) {
      await this.tui({ action: 'background' });
      return { terminal: true };
    }
    if (interruptSwarm) return this.interruptSwarm();
    const moved = await this.detachForeground({ all: true });
    if (moved) this.ctx.emit({ type: 'info', text: `已把 ${moved} 個前景工作移到背景（工作會繼續跑，Kimi 不用再等它）` });
    const swarm = this.foregroundSwarm();
    return { moved, ...(swarm ? { swarm: { description: swarm.description, agents: swarm.ids.length, waiting: this.queue().filter((q) => !q.terminal).length } } : {}) };
  }

  // The AgentSwarm call the main agent waits on, with its subagents' ids.
  foregroundSwarm() {
    const ev = [...this.tools.values()].find((e) => e.name === 'AgentSwarm' && !e.parent && ['pending', 'running', 'awaiting'].includes(e.status));
    if (!ev) return null;
    const ids = new Set();
    for (const e of [ev, ...this.events().filter((x) => x.parent === ev.id)]) if (e.subagent?.id) ids.add(e.subagent.id);
    for (const [id, a] of this.agents) if (a.parent === ev.id) ids.add(id);
    return { ev, ids: [...ids], description: ev.input?.description || ev.title || '子代理群' };
  }

  // Stop the swarm so Kimi reads the messages waiting for it now. They are
  // withdrawn from Kimi first (it would run them after the stop on its
  // own), then the turn is stopped, and they go again as one, telling Kimi
  // which subagents it can resume.
  async interruptSwarm() {
    const swarm = this.foregroundSwarm();
    const waiting = this.queue().filter((q) => !q.terminal);
    for (const q of waiting) await this.api('POST', this.path(`/prompts/${q.promptId}:abort`), {}).catch(() => {});
    await this.api('POST', this.path(':abort'), {});
    for (let i = 0; i < 75 && ['running', 'awaiting_permission'].includes(this.session.status); i++) await new Promise((r) => setTimeout(r, 200));
    for (const q of waiting) this.dequeue(q.promptId);
    const desc = swarm?.description || '子代理群';
    const ids = swarm?.ids || [];
    this.ctx.emit({ type: 'info', text: `已中斷子代理群「${desc}」，讓 Kimi 先讀你的訊息${ids.length ? `；Kimi 之後可以接續那 ${ids.length} 個子代理` : ''}` });
    const text = waiting.map((q) => q.text).filter(Boolean).join('\n\n');
    const images = waiting.flatMap((q) => q.images || []).map((url) => url.match(/^data:([^;]+);base64,(.*)$/)).filter(Boolean).map(([, mimeType, data]) => ({ mimeType, data }));
    if (!text && !images.length) return { interrupted: true, sent: 0 };
    const hidden = `The user stopped the AgentSwarm "${desc}" so that you read the message above now. Its subagents stopped where they were${ids.length ? ` (agent ids: ${ids.join(', ')})` : ''}. Deal with the message first. If their work is still needed afterwards, continue them with AgentSwarm's resume_agent_ids (map each id to "continue") instead of starting over.`;
    await this.send(text || '（圖片）', images, { note: '中斷子代理群後送出', hidden });
    return { interrupted: true, sent: waiting.length };
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
    if (this.canDriveTerminal()) return this.tui({ action: 'interrupt' });
    await this.api('POST', this.path(':abort'), {});
  }

  async respond(eventId, optionId, { answers, feedback } = {}) {
    const ev = this.session.events.find((e) => e.id === eventId);
    if (!ev?.permission || ev.permission.chosen) return false;
    let chosen = optionId;
    if (this.canDriveTerminal()) {
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

  // The model the native names in its next status update, or null when it
  // says nothing within `ms`. Start waiting BEFORE sending the change: the
  // answer can come back while the request is still being acknowledged.
  statusAfter(ms) {
    let done;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), ms);
      const finish = (v) => {
        clearTimeout(timer);
        this.statusWaiters = (this.statusWaiters || []).filter((w) => w !== finish);
        resolve(v);
      };
      done = finish;
      (this.statusWaiters ??= []).push(finish);
    });
    return { promise, cancel: () => done(null) };
  }

  // `confirm`: the change is a correction of what the native runs, so it is
  // not taken as done on the server's "ok" alone. If the native answers with a
  // different model the change failed (and the answer, being the native's own
  // word, stays on the conversation as drift); silence is "accepted" - Kimi
  // journals a change with its next turn - and the drift clears or returns
  // with the native's next report.
  async configure({ model, effort, permission, planMode, swarmMode, confirm }) {
    if (this.canDriveTerminal()) {
      // Kimi's own slash commands; /model and /yolo /auto open a picker that
      // is confirmed with Enter. The model first: a new model may not keep
      // the thinking set before it.
      if (typeof model === 'string' && model) await this.tui({ action: 'command', text: `/model ${model}`, confirm: true });
      if (typeof effort === 'string') await this.tui({ action: 'command', text: `/effort ${effort}` });
      if (typeof planMode === 'boolean') await this.tui({ action: 'command', text: `/plan ${planMode ? 'on' : 'off'}` });
      if (permission === 'yolo' || permission === 'auto') await this.tui({ action: 'command', text: `/${permission}`, confirm: true });
      else if (permission) throw Object.assign(new Error('要改回「每次詢問」，請在終端機的 Kimi 裡輸入 /permission'), { status: 400 });
      // After the permission: whether Kimi asks about approvals depends on it.
      if (typeof swarmMode === 'boolean') await this.swarmInTerminal(swarmMode, PERMISSIONS.includes(permission) ? permission : this.session.meta?.permission);
      // Kimi journals these with its next turn; show them now.
      this.applyStatus({ model: model || undefined, effort, permission, planMode, swarmMode: typeof swarmMode === 'boolean' ? swarmMode : undefined });
      return;
    }
    const agentConfig = {};
    if (typeof model === 'string' && model) agentConfig.model = model;
    if (typeof effort === 'string' && effort) agentConfig.thinking = effort;
    if (PERMISSIONS.includes(permission)) agentConfig.permission_mode = permission;
    if (typeof planMode === 'boolean') agentConfig.plan_mode = planMode;
    if (typeof swarmMode === 'boolean') agentConfig.swarm_mode = swarmMode;
    if (!Object.keys(agentConfig).length) throw Object.assign(new Error('沒有要變更的設定'), { status: 400 });
    const waiting = confirm && agentConfig.model ? this.statusAfter(PROFILE_CONFIRM_MS) : null;
    try {
      await this.api('POST', this.path('/profile'), { agent_config: agentConfig });
    } catch (err) {
      waiting?.cancel();
      throw err;
    }
    if (waiting) {
      const said = await waiting.promise;
      if (said && !modelDrift.sameModel(said, agentConfig.model)) {
        throw Object.assign(new Error(`Kimi 收下了設定，但回報這個原生對話用的是「${said}」，不是「${agentConfig.model}」`), { status: 502 });
      }
    }
    // A Kimi that predates swarm mode takes the key without a word and does
    // nothing with it. Its own status says whether it took it, so a switch
    // that did not happen is never shown as one that did.
    if (typeof agentConfig.swarm_mode === 'boolean') await this.confirmSwarm(agentConfig.swarm_mode);
    // Kimi echoes the change in agent.status.updated; reflect it right away.
    this.applyStatus({ model: agentConfig.model, effort: agentConfig.thinking, permission: agentConfig.permission_mode, planMode: agentConfig.plan_mode, swarmMode: agentConfig.swarm_mode });
  }

  async confirmSwarm(wanted) {
    // Unreadable is not a refusal: the native's own report follows either way.
    const status = await this.api('GET', this.path('/status')).catch(() => null);
    if (!status) return;
    if (typeof status.swarm_mode !== 'boolean') {
      throw Object.assign(new Error('這台電腦的 Kimi 沒有 swarm 模式（它的狀態裡沒有 swarm_mode）：請更新那台電腦的 Kimi Code'), { status: 502 });
    }
    if (status.swarm_mode !== wanted) {
      // Kimi's word wins over the Hub's record.
      this.applyStatus({ swarmMode: status.swarm_mode });
      throw Object.assign(new Error(`Kimi 收下了設定，但回報 swarm 模式仍是「${status.swarm_mode ? '開' : '關'}」`), { status: 502 });
    }
  }

  // Kimi's own /swarm on|off, in the terminal. It is sent pasted, the way a
  // message is, not as the bridge's `command` (typed, then Enter 60 ms later):
  // Kimi 2.3.3 takes a burst of typing followed that fast by Enter as a paste
  // and the Enter as a new line, so that command is never submitted.
  //
  // Turning it on while approvals are "ask every time" opens a picker ("Start
  // a swarm task with approvals on?") whose first choice, the one Enter takes,
  // switches the terminal to Never Ask. The Hub never changes the permission a
  // person did not ask it to change, so it takes the third choice, "Start in
  // Always Ask": two Downs, then the Enter the bridge adds to a command. When
  // Kimi is not asking (already in Never Ask or Ask When Needed, or already
  // on) the keys land in an empty input box and do nothing.
  async swarmInTerminal(on, permission) {
    await this.tui({ action: 'send', text: `/swarm ${on ? 'on' : 'off'}`, mode: 'enter' });
    if (!on || permission === 'yolo' || permission === 'auto') return;
    await new Promise((r) => setTimeout(r, TUI_PICKER_MS));
    await this.tui({ action: 'command', text: '\x1b[B\x1b[B' });
  }

  async command(name, args = '') {
    if (this.canDriveTerminal()) {
      // Archiving cannot be typed into a terminal; the hub refuses it while
      // it drives that terminal. An uncontrollable one archives over the API.
      if (name === 'archive') throw Object.assign(new Error('這個對話正在終端機執行。先關掉那個 Kimi，再從這裡刪除'), { status: 409 });
      // A /fork typed into the terminal moves THAT terminal onto the fork and
      // makes no Hub conversation, so nothing would open here and the person's
      // terminal would silently be somewhere else. (Kimi's own :fork over the
      // API on a conversation a terminal holds is refused after the first try.)
      if (name === 'fork') throw Object.assign(new Error('這個對話正在終端機執行：分叉會讓那個終端機換到新的對話。先關掉那個 Kimi 再分叉，或直接在終端機輸入 /fork'), { status: 409 });
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
        const ev = this.ctx.emit({ type: 'tool_use', agentId: 'main', name: 'btw', title: args, status: 'running', subagent: { id: agentId, name: 'btw', description: args, status: 'running', ...policy.contract({ requested: null, actual: null, reason: policy.UNVERIFIED.btw }) } });
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
      // A new read for the new connection (a catch-up begun on the old one
      // fails with it); a message sent meanwhile waits for this one.
      await m.startAttach();
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
  policy.refreshSoon(session);
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
export const isBusy = (session) => Boolean(mirrors.get(session.id)?.busy());
export const steerQueued = (session, promptId) => mirrorFor(session).steerQueued(promptId);
export async function moveToBackground(session, opts) {
  const m = mirrorFor(session);
  await m.ensureLive();
  return m.moveToBackground(opts);
}
// Take a conversation locked only because a terminal Kimi runs in its folder.
export const unlock = (session) => machines.rpc(session.machineId, 'kimi.unlock', { sessionId: session.kimiSessionId });

// Nothing about a terminal, a guessed conversation in its folder or a
// controllable state refuses a message any more: send() picks the terminal
// when the hub controls it and Kimi's server API otherwise.
export function cannotSend() {
  return null;
}

export const interrupt = (session) => mirrorFor(session).interrupt();
export const respond = (session, eventId, optionId, extra) => mirrorFor(session).respond(eventId, optionId, extra);
const followed = async (session) => {
  const m = mirrorFor(session);
  await m.ensureLive();
  return m;
};
// Chosen in the conversation from the hub: kept from then on (applyDefaults).
export const configure = async (session, change) => {
  const m = await followed(session);
  await m.configure(change);
  const keys = ['model', 'effort', 'permission'].filter((k) => change?.[k] != null && change[k] !== '');
  if (keys.length) {
    session.state.userSet = { ...(session.state.userSet || {}), ...Object.fromEntries(keys.map((k) => [k, true])) };
    store.saveSession(session);
  }
};
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

// An existing Kimi conversation bound to a GitHub repository, for good. Its
// folder stays (Kimi's conversations live in theirs): when it is not a clone
// of the repository, the repository is cloned into it, in a folder of its
// own. Kimi is told at once, and brings its work over.
export async function bindRepo(session, { full, branch }) {
  if (session.repo) throw Object.assign(new Error(`這個對話已經綁定 ${session.repo.full} 的 ${session.repo.branch}，不能再換`), { status: 409 });
  if (['running', 'awaiting_permission'].includes(session.status)) throw Object.assign(new Error('Kimi 正在工作：等這一輪結束（或先停止）再綁定'), { status: 409 });
  const host = remoteHost(session.machineId);
  const origin = await host.run(session.cwd, 'git config --get remote.origin.url', { timeoutMs: 15_000 }).catch(() => null);
  const same = origin?.exitCode === 0 && repoBind.parseRepo(String(origin.output).trim())?.toLowerCase() === full.toLowerCase();
  if (same) await repoBind.useBranch(host, session.cwd, { branch });
  const dir = same ? session.cwd : await repoBind.clone(host, session.cwd, { full, branch }, { name: full.split('/')[1] });
  session.repo = { full, branch, url: `https://github.com/${full}/tree/${branch}`, dir, told: true };
  store.saveSession(session);
  const ctx = liveContext(session);
  ctx.emit({ type: 'info', text: same ? `已綁定 ${full} 的 ${branch}：資料夾本來就是這個 repo，已切到 ${branch}。` : `已綁定 ${full} 的 ${branch}：repo clone 到 ${dir}（在對話資料夾裡）。Kimi 會先把屬於這個專案的檔案搬進去，commit 並 push。` });
  ctx.setMeta({});
  const intro = same
    ? `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. Your working directory is already a clone of it and is now on \`${branch}\`. Commit what you have done so far that belongs to the task, push it, and tell the user briefly.`
    : `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. It was cloned into ${dir}, inside your working directory. Bring over into it what belongs to the user's task from your earlier work (code, docs, configs; not secrets, data dumps, build output or tool caches), commit it with a clear message, push it, and tell the user briefly what you brought over and what you left out.`;
  await send(session, `${intro}\n\n${repoBind.rulesNote(session.repo)}`, { note: '綁定 GitHub repo' });
  return session;
}

export function dispose(session) {
  clearInterval(mirrors.get(session.id)?.cutInTimer);
  for (const t of mirrors.get(session.id)?.urgentTimers?.values() || []) clearTimeout(t);
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
