// Kimi Code sessions on remote machines, driven through the bridge and Kimi's
// own Server API (`kimi web`). Unlike the turn-based adapters this one is
// *live*: a hub session mirrors a Kimi session continuously, so turns started
// in the Kimi TUI / web UI, approvals answered elsewhere and the Kimi-side
// title all show up in the hub as they happen.
import * as machines from '../machines.js';

export const live = true;

const mirrors = new Map(); // hub session id -> Mirror
const byKimi = new Map(); // `${machineId}:${kimiSessionId}` -> hub session id
let liveContext = null; // injected by the runner (avoids an import cycle)

export function init(makeContext) {
  liveContext = makeContext;
}

const PERM = { ask: 'manual', auto_edits: 'yolo', bypass: 'auto' };
const APPROVAL_OPTIONS = [
  { optionId: 'approved', name: '允許', kind: 'allow_once' },
  { optionId: 'approved_session', name: '本次對話一律允許', kind: 'allow_always' },
  { optionId: 'rejected', name: '拒絕', kind: 'reject_once' },
];

export function available(agent) {
  const m = machines.getMachine(agent.machineId);
  if (!m) return { ok: false, reason: '找不到這台機器' };
  if (!m.online) return { ok: false, reason: `機器「${m.name}」目前離線（在那台機器上執行連接器）` };
  if (!m.kimi?.available) return { ok: false, reason: `機器「${m.name}」上沒有執行中的 Kimi 伺服器：在 Kimi 裡輸入 /web，或執行 kimi web` };
  return { ok: true };
}

// --------------------------------------------------------------- helpers

function toolTitle(name, input = {}, display) {
  if (display?.kind === 'command') return display.command;
  if (display?.path) return display.path;
  if (display?.kind === 'search') return display.query;
  if (display?.kind === 'url_fetch') return display.url;
  if (input == null || typeof input !== 'object') return name;
  return input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || name;
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

function contentText(parts) {
  return (parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

const now = () => Date.now();

// ---------------------------------------------------------------- mirror

class Mirror {
  constructor(session) {
    this.session = session;
    this.machineId = session.machineId;
    this.kid = session.kimiSessionId;
    this.reset();
  }

  reset() {
    this.open = null; // { type, ev, turnId }
    this.tools = new Map(); // toolCallId -> ev
    this.pendingTexts = []; // prompts we sent whose turn has not started yet
    this.myPromptIds = new Set();
    this.turn = null; // { started, input, output }
  }

  get ctx() {
    return liveContext(this.session);
  }

  api(method, p, body) {
    return machines.kimiApi(this.machineId, method, p, body);
  }

  // Subscribe, then rebuild from Kimi's history if we may have missed
  // anything (first attach, or the hub/bridge was offline for a while).
  async attach({ force = false } = {}) {
    await machines.rpc(this.machineId, 'kimi.subscribe', { sessionIds: [this.kid] });
    const info = await this.api('GET', `/api/v1/sessions/${this.kid}`);
    const kimiUpdated = Date.parse(info.updated_at) || 0;
    const stale = force || !this.session.events.length || kimiUpdated > (this.session.state.syncedAt || 0) + 1000;
    if (stale) await this.importHistory();
    if (info.title) this.ctx.setTitle(info.title);
    const machine = machines.getMachine(this.machineId);
    this.ctx.setMeta({
      agentInfo: { name: `Kimi Code · ${machine?.name || ''}`, version: machine?.kimi?.version || '' },
      protocol: `Kimi Server API · ${machine?.name || ''}`,
      imageInput: true,
      commands: [],
    });
    await this.loadModels().catch(() => {});
    if (info.busy) this.ctx.setStatus(info.pending_interaction === 'none' ? 'running' : 'awaiting_permission');
    else this.ctx.setStatus('idle');
    if (info.pending_interaction === 'approval') await this.loadApprovals();
    this.touch();
  }

  touch() {
    this.session.state.syncedAt = now();
  }

  async loadModels() {
    // Sessions created over the API do not pick up Kimi's default model by
    // themselves, so remember it and send it with every prompt.
    try {
      this.defaultModel = (await this.api('GET', '/api/v1/config')).default_model || '';
    } catch {}
    const r = await this.api('GET', '/api/v1/models');
    const items = r.items || [];
    if (!items.length) return;
    this.ctx.setMeta({
      configOptions: [
        {
          id: 'model',
          name: '模型',
          type: 'select',
          currentValue: this.session.state.model || '',
          options: [{ value: '', name: `Kimi 預設${this.defaultModel ? `（${this.defaultModel}）` : ''}` }, ...items.map((m) => ({ value: m.model, name: m.display_name || m.model }))],
        },
      ],
    });
  }

  async loadApprovals() {
    const r = await this.api('GET', `/api/v1/sessions/${this.kid}/approvals?status=pending`);
    for (const a of r.items || []) this.onApproval(a);
  }

  async importHistory() {
    const items = [];
    let before = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.api('GET', `/api/v1/sessions/${this.kid}/messages?page_size=100${before ? `&before_id=${encodeURIComponent(before)}` : ''}`);
      items.push(...(r.items || []));
      if (!r.has_more || !r.items?.length) break;
      before = r.items[r.items.length - 1].id;
    }
    items.reverse();
    const events = [];
    const tools = new Map();
    let n = 0;
    const ev = (fields, ts) => {
      const e = { id: `k_${this.kid.slice(-6)}_${n++}`, ts, ...fields };
      events.push(e);
      return e;
    };
    for (const m of items) {
      const ts = Date.parse(m.created_at) || now();
      const origin = m.metadata?.origin?.kind;
      if (m.role === 'user') {
        if (origin && origin !== 'user') continue; // Kimi's own reminders and injections
        const text = contentText(m.content);
        const images = (m.content || []).filter((p) => p.type === 'image').length;
        if (text || images) ev({ type: 'user', text: text || (images ? '(圖片)' : ''), source: 'kimi' }, ts);
      } else if (m.role === 'assistant') {
        for (const p of m.content || []) {
          if (p.type === 'thinking' && (p.thinking || p.text)) ev({ type: 'thinking', text: p.thinking || p.text }, ts);
          else if (p.type === 'text' && p.text) ev({ type: 'text', text: p.text }, ts);
          else if (p.type === 'tool_use') {
            const t = ev({ type: 'tool_use', source: 'kimi', name: p.tool_name, toolCallId: p.tool_call_id, input: p.input, title: toolTitle(p.tool_name, p.input), status: 'done' }, ts);
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
    if (items.length) events.push({ id: `k_${this.kid.slice(-6)}_${n++}`, ts: now(), type: 'info', text: `已載入 Kimi 對話紀錄（${items.length} 則訊息）` });
    this.reset();
    this.ctx.replaceEvents(events);
  }

  // ------------------------------------------------------------- events

  closeBlock() {
    this.open = null;
  }

  stream(type, text, turnId) {
    if (!text) return;
    if (!this.open || this.open.type !== type || this.open.turnId !== turnId) {
      this.open = { type, turnId, ev: this.ctx.emit({ type, text: '' }) };
    }
    this.ctx.delta(this.open.ev, text);
  }

  tool(id, fields = {}) {
    let ev = this.tools.get(id);
    if (!ev) {
      this.closeBlock();
      ev = this.ctx.emit({ type: 'tool_use', source: 'kimi', toolCallId: id, name: fields.name || 'tool', title: fields.name || '', status: 'pending', ...fields });
      this.tools.set(id, ev);
    } else if (Object.keys(fields).length) {
      this.ctx.patch(ev, fields);
    }
    return ev;
  }

  onApproval(a) {
    const ev = this.tool(a.tool_call_id || a.approval_id, { name: a.tool_name });
    this.ctx.patch(ev, {
      approvalId: a.approval_id,
      title: ev.title && ev.title !== ev.name ? ev.title : a.action || toolTitle(a.tool_name, a.tool_input || {}, a.tool_input_display),
      display: a.tool_input_display || ev.display,
      action: a.action,
      status: 'awaiting',
      permission: { options: APPROVAL_OPTIONS, chosen: null },
    });
    this.ctx.setStatus('awaiting_permission');
  }

  onQuestion(q) {
    const items = q.questions || [];
    const first = items[0];
    if (!first) return;
    const ev = this.tool(q.tool_call_id || q.question_id, { name: 'AskUserQuestion' });
    this.ctx.patch(ev, {
      questionId: q.question_id,
      questionItems: items,
      title: first.question || first.header || 'Kimi 有問題要問你',
      status: 'awaiting',
      permission: {
        question: true,
        options: [...(first.options || []).map((o) => ({ optionId: o.id, name: o.label, kind: 'allow_once', description: o.description })), { optionId: '__dismiss', name: '略過', kind: 'reject_once' }],
        chosen: null,
      },
    });
    this.ctx.setStatus('awaiting_permission');
  }

  onFrame(frame) {
    const p = frame.payload || {};
    const type = frame.type || p.type;
    const main = !p.agentId || p.agentId === 'main';
    this.touch();
    switch (type) {
      case 'turn.started': {
        if (!main) return;
        this.closeBlock();
        this.turn = { started: now(), input: 0, output: 0, id: p.turnId };
        const text = p.prompt ?? (p.origin?.skillName ? `/${p.origin.skillName} ${p.origin.skillArgs || ''}`.trim() : '');
        const mine = this.myPromptIds.has(p.promptId) || this.pendingTexts.indexOf(text) !== -1;
        if (mine) this.pendingTexts.splice(this.pendingTexts.indexOf(text), 1);
        else if (text) this.ctx.emit({ type: 'user', text, source: 'kimi', note: '在 Kimi 端送出' });
        this.ctx.setStatus('running');
        return;
      }
      case 'assistant.delta':
        if (main) this.stream('text', p.delta, p.turnId);
        return;
      case 'thinking.delta':
        if (main) this.stream('thinking', p.delta, p.turnId);
        return;
      case 'tool.call.delta': {
        if (!main) return;
        const ev = this.tool(p.toolCallId, { name: p.name || 'tool' });
        if (p.argumentsPart) this.ctx.delta(ev, p.argumentsPart, 'argsText');
        return;
      }
      case 'tool.call.started': {
        if (!main) return;
        const ev = this.tool(p.toolCallId, { name: p.name });
        this.ctx.patch(ev, {
          name: p.name,
          input: p.args,
          display: p.display,
          title: p.display ? toolTitle(p.name, p.args, p.display) : p.description || toolTitle(p.name, p.args),
          description: p.description,
          status: ev.permission && !ev.permission.chosen ? 'awaiting' : 'running',
        });
        return;
      }
      case 'tool.progress': {
        if (!main) return;
        const ev = this.tools.get(p.toolCallId);
        const text = p.update?.text;
        if (!ev || typeof text !== 'string') return;
        if (p.update.replace) this.ctx.patch(ev, { output: text });
        else this.ctx.delta(ev, text, 'output');
        return;
      }
      case 'tool.result': {
        if (!main) return;
        const ev = this.tool(p.toolCallId);
        this.ctx.patch(ev, { status: p.isError ? 'error' : 'done', isError: Boolean(p.isError), output: outputText(p.output) });
        return;
      }
      case 'event.approval.requested':
        if (main) this.onApproval(p);
        return;
      case 'event.approval.resolved': {
        const ev = [...this.tools.values()].find((e) => e.approvalId === p.approval_id);
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
        const ev = [...this.tools.values()].find((e) => e.questionId === p.question_id);
        if (ev && !ev.permission?.chosen) this.ctx.patch(ev, { status: 'done', permission: { ...ev.permission, chosen: type.endsWith('dismissed') ? '__dismiss' : 'answered' } });
        return;
      }
      case 'turn.step.completed':
        if (main && this.turn && p.usage) {
          this.turn.input += (p.usage.inputOther || 0) + (p.usage.inputCacheRead || 0) + (p.usage.inputCacheCreation || 0);
          this.turn.output += p.usage.output || 0;
        }
        return;
      case 'turn.ended': {
        if (!main) return;
        this.closeBlock();
        if (p.reason === 'failed') this.lastFailureAt = now();
        if (p.reason === 'failed' && p.error) {
          const auth = /^auth\./.test(p.error.code || '') || /model\.not_configured/.test(p.error.code || '');
          this.ctx.emit({ type: 'error', text: auth ? `${p.error.message}（在那台機器上執行 kimi login，或在 Kimi 裡用 /model 選擇模型）` : p.error.message });
        }
        for (const ev of this.tools.values()) {
          if (['pending', 'running', 'awaiting'].includes(ev.status)) this.ctx.patch(ev, { status: p.reason === 'cancelled' ? 'interrupted' : 'ended' });
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
        this.tools.clear();
        return;
      }
      case 'event.session.work_changed':
        if (p.busy) this.ctx.setStatus(p.pending_interaction && p.pending_interaction !== 'none' ? 'awaiting_permission' : 'running');
        else this.ctx.setStatus(p.last_turn_reason === 'failed' ? 'error' : 'idle');
        return;
      case 'agent.status.updated':
        if (main && p.maxContextTokens) {
          const ctx = { used: p.contextTokens || 0, size: p.maxContextTokens };
          const prev = this.session.meta?.context;
          if (!prev || prev.used !== ctx.used || prev.size !== ctx.size) this.ctx.setMeta({ context: ctx });
        }
        return;
      case 'session.meta.updated':
        if (p.title) this.ctx.setTitle(p.title);
        return;
      case 'subagent.spawned':
        this.closeBlock();
        this.ctx.emit({ type: 'info', text: `派出子代理 ${p.subagentName}${p.description ? `：${p.description}` : ''}` });
        return;
      case 'subagent.completed':
      case 'subagent.failed':
        this.ctx.emit({ type: 'info', text: `子代理${type.endsWith('failed') ? '失敗' : '完成'}` });
        return;
      case 'compaction.completed':
        this.ctx.emit({ type: 'info', text: `已壓縮對話（${p.result?.tokensBefore ?? '?'} → ${p.result?.tokensAfter ?? '?'} tokens）` });
        return;
      case 'goal.updated':
        if (p.snapshot?.objective) this.ctx.emit({ type: 'info', text: `目標（${p.snapshot.status}）：${p.snapshot.objective}` });
        return;
      case 'warning':
        if (main) this.ctx.emit({ type: 'info', text: p.message });
        return;
      case 'error':
        // Turn failures are reported by turn.ended; show only stray errors.
        if (!this.turn && p.message && now() - (this.lastFailureAt || 0) > 3000) this.ctx.emit({ type: 'error', text: p.message });
        return;
      default:
    }
  }

  // ------------------------------------------------------------ actions

  async send(text, images = []) {
    const ctx = this.ctx;
    ctx.emit({ type: 'user', text, images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) });
    this.pendingTexts.push(text);
    // Running from the moment it is sent; Kimi's turn events follow shortly.
    ctx.setStatus('running');
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images) content.push({ type: 'image', source: { kind: 'base64', media_type: img.mimeType, data: img.data } });
    const body = { content, permission_mode: PERM[this.session.permissionMode] || 'manual' };
    if (this.defaultModel === undefined) await this.loadModels().catch(() => {});
    const model = this.session.state.model || this.defaultModel;
    if (model) body.model = model;
    try {
      const r = await this.api('POST', `/api/v1/sessions/${this.kid}/prompts`, body);
      if (r?.prompt_id) this.myPromptIds.add(r.prompt_id);
      if (r?.status === 'queued') ctx.emit({ type: 'info', text: 'Kimi 正在處理上一則訊息，這則已排入佇列' });
    } catch (err) {
      this.pendingTexts.splice(this.pendingTexts.indexOf(text), 1);
      ctx.emit({ type: 'error', text: err.message });
      ctx.setStatus('idle');
    }
  }

  async interrupt() {
    await this.api('POST', `/api/v1/sessions/${this.kid}:abort`, {});
  }

  async respond(eventId, optionId) {
    const ev = this.session.events.find((e) => e.id === eventId);
    if (!ev?.permission || ev.permission.chosen) return false;
    if (ev.approvalId) {
      const body = optionId === 'rejected' ? { decision: 'rejected' } : optionId === 'approved_session' ? { decision: 'approved', scope: 'session' } : { decision: 'approved' };
      await this.api('POST', `/api/v1/sessions/${this.kid}/approvals/${ev.approvalId}`, body);
    } else if (ev.questionId) {
      if (optionId === '__dismiss') {
        // Dismissal "succeeds" with envelope code 40909, so call the bridge directly.
        await machines.rpc(this.machineId, 'kimi.request', { method: 'POST', path: `/api/v1/sessions/${this.kid}/questions/${ev.questionId}:dismiss`, body: {} });
      } else {
        const answers = {};
        (ev.questionItems || []).forEach((q, i) => {
          answers[q.id] = i === 0 ? { kind: 'single', option_id: optionId } : { kind: 'skipped' };
        });
        await this.api('POST', `/api/v1/sessions/${this.kid}/questions/${ev.questionId}`, { answers, method: 'click' });
      }
    } else return false;
    this.ctx.patch(ev, { status: optionId === 'rejected' || optionId === '__dismiss' ? 'pending' : 'running', permission: { ...ev.permission, chosen: optionId } });
    if (this.session.status === 'awaiting_permission') this.ctx.setStatus('running');
    return true;
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

export async function onMachineOnline(machineId, sessions) {
  for (const s of sessions) {
    if (s.machineId !== machineId || !s.kimiSessionId) continue;
    try {
      await mirrorFor(s).attach();
    } catch (err) {
      console.warn(`[kimi] re-attach ${s.id} failed: ${err.message}`);
    }
  }
}

export async function attach(session, opts) {
  await mirrorFor(session).attach(opts);
}

export async function createRemote({ machineId, cwd, nameHint }) {
  let dir = cwd;
  if (!dir) dir = (await machines.rpc(machineId, 'workspace.create', { name: nameHint || 'kimi' })).path;
  const s = await machines.kimiApi(machineId, 'POST', '/api/v1/sessions', { metadata: { cwd: dir } });
  return { kimiSessionId: s.id, cwd: s.metadata?.cwd || dir };
}

export async function send(session, text, { images = [] } = {}) {
  const m = mirrorFor(session);
  if (!session.events.length && !session.state.syncedAt) await m.attach();
  await m.send(text, images);
}

export async function interrupt(session) {
  await mirrorFor(session).interrupt();
}

export async function respond(session, eventId, optionId) {
  return mirrorFor(session).respond(eventId, optionId);
}

export async function configure(session, change) {
  if (change.configId === 'model') {
    session.state.model = change.value || '';
    const opts = (session.meta?.configOptions || []).map((o) => (o.id === 'model' ? { ...o, currentValue: session.state.model } : o));
    return { configOptions: opts };
  }
  throw Object.assign(new Error('Kimi 對話目前只支援切換模型'), { status: 400 });
}

export function dispose(session) {
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
