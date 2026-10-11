// Claude through the Claude API: a Claude Console API key, billed per token.
// No Claude Code and no Claude subscription are involved. The hub runs the
// agent loop itself: it streams each response from api.anthropic.com
// (official SDK, `x-api-key` only — see claude-account.js), runs the tools
// Claude calls in the conversation's folder on this computer (asking first,
// as the permission mode says), sends the results back, and repeats until
// Claude answers without a tool.
//
// The adapter is *live* like Kimi's: messages sent while Claude works wait
// in the queue (or slip into the running turn: 插隊), approvals and questions
// wait on their cards, and the hub can send on its own (定時送出).
//
// The request history is append-only, so the prompt cache keeps hitting and
// thinking blocks stay valid: the system prompt is fixed when the
// conversation starts, the tool set never changes, and plan-mode changes are
// told to Claude as a note after the user's message.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from '../store.js';
import * as account from '../claude-account.js';
import { apiTools, toolKind, validate, titleOf, execute } from './claude-tools.js';

export const live = true;
export const AGENT = { id: 'claude', name: 'Claude', type: 'claude', enabled: true };

const PERMISSIONS = ['manual', 'edits', 'auto'];
const MAX_STEPS = 200; // requests per turn
const SUB_STEPS = 100; // per subagent
const SUB_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
const SERVER_TOOLS = { web_search: 'WebSearch', web_fetch: 'WebFetch', code_execution: 'CodeExecution', bash_code_execution: 'CodeExecution', text_editor_code_execution: 'CodeExecution' };
const APPROVAL_OPTIONS = [
  { optionId: 'approved', name: '允許', kind: 'allow_once' },
  { optionId: 'approved_session', name: '這個對話都允許', kind: 'allow_always' },
  { optionId: 'rejected', name: '拒絕', kind: 'reject_once' },
];
const PLAN_OPTIONS = [
  { optionId: 'plan:edits', name: '同意，自動接受編輯', label: '同意，自動接受編輯', description: '開始實作：修改檔案不再詢問，執行指令前仍會問你' },
  { optionId: 'plan:manual', name: '同意，每次詢問', label: '同意，每次詢問', description: '開始實作：每個修改與指令都先問你' },
];
const COMPACT_PROMPT =
  'Write a summary of our conversation so far, so the work can continue in a fresh context from it alone. Cover: what the user asked for and their goals and preferences; decisions made and why; what has been done (files created or changed, commands run, their results); the current state; open problems; and the next steps. Keep exact file paths, names, commands and error messages that matter. Write it in the language the user writes in. Reply with the summary only.';
const RESUME_PREFIX = 'This conversation continues from an earlier part that was summarized to save context. The summary:';

let liveContext = null; // injected by the runner (avoids an import cycle)
export function init(makeContext) {
  liveContext = makeContext;
}

const runs = new Map(); // session id -> Run: a turn (or a compaction) in progress
const queuedImages = new Map(); // prompt id -> images of a queued message (kept out of meta)

export function available() {
  return account.apiKey() ? { ok: true } : { ok: false, reason: '還沒有設定 Claude API key' };
}

// Refuse up front what cannot be sent.
export function cannotSend() {
  if (!account.apiKey()) return '還沒有設定 Claude API key：在左下角「⋯」→「Claude API…」貼上 Claude Console 的 API key（sk-ant-…）。';
  return null;
}

// ---------------------------------------------------------------- state

// The conversation as the API sees it, kept with the session.
function st(session) {
  session.state.claude ??= { messages: [], turns: [], usage: emptyUsage() };
  return session.state.claude;
}
const emptyUsage = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0, requests: 0, cost: 0 });
const queue = (session) => session.meta?.queue || [];
const fmtUsd = (n) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));

// A new conversation: settings from what was picked (or Claude's defaults
// in 設定), and the system prompt, fixed from now on.
export function setup(session, config = {}) {
  const { defaults: d, webTools } = account.settings();
  const c = st(session);
  c.system = systemPrompt(session.cwd);
  c.subSystem = subSystemPrompt(session.cwd);
  c.web = webTools;
  const model = typeof config.model === 'string' && config.model ? config.model : d.model;
  session.meta = {
    ...(session.meta || {}),
    agent: 'claude',
    machineName: os.hostname(),
    model,
    effort: typeof config.effort === 'string' && config.effort ? config.effort : d.effort,
    permission: PERMISSIONS.includes(config.permission) ? config.permission : d.permission,
    planMode: typeof config.planMode === 'boolean' ? config.planMode : d.planMode,
    queue: [],
    todos: [],
  };
  store.saveSession(session);
  refreshModels(session, true);
}

function projectNotes(cwd) {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const text = fs.readFileSync(path.join(cwd, file), 'utf8').trim();
      if (text) return { file, text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut; Read the file for the rest)` : text };
    } catch {}
  }
  return null;
}

function systemPrompt(cwd) {
  const notes = projectNotes(cwd);
  return [
    'You are Claude, working as a coding agent for the user through Agent Hub, a control center they open in a browser or on their phone. You act on their computer only through your tools, which run in the working directory below.',
    '',
    '# Environment',
    `- Working directory: ${cwd}`,
    `- Platform: ${os.platform()} ${os.release()}; shell: bash`,
    `- This conversation started on ${new Date().toISOString().slice(0, 10)}.`,
    fs.existsSync(path.join(cwd, '.git')) ? '- The working directory is a git repository.' : '- The working directory is not a git repository.',
    '',
    '# How to work',
    '- Look before you change anything: Read files before editing them, and find your way with Grep and Glob rather than guessing paths.',
    '- Change existing files with Edit; use Write for new files or full rewrites. Keep changes to what was asked.',
    '- Use Bash for builds, tests, git and package managers, and run the relevant checks after changing code.',
    '- For work with several steps, keep a todo list with TodoWrite and update it as you go.',
    '- Hand self-contained research or independent parts of the work to subagents with Task; run several at once when they do not depend on each other.',
    "- When you need a decision that is the user's to make, ask with AskUserQuestion instead of guessing.",
    "- Some tool calls wait for the user's approval. If one is rejected, do not retry it unchanged: read their feedback in the result, then adjust or ask.",
    '- HTML files you write are shown to the user live in a side panel, so a page is a good way to present a report, a dashboard or a prototype.',
    '- Write to the user in the language they write to you in. Be concise and use Markdown. When you finish, say what you changed and what they should check.',
    '',
    '# Plan mode',
    'When a note says plan mode is on, change nothing: read and research only (Write, Edit and Bash are refused), then call ExitPlanMode with your plan. Once the user approves it, plan mode is off and you carry it out.',
    notes ? `\n# Project instructions\nThe working directory has instructions for agents in ${notes.file}. Follow them:\n\n${notes.text}` : '',
  ]
    .join('\n')
    .trim();
}

function subSystemPrompt(cwd) {
  return [
    `You are a subagent of Claude, doing one self-contained task in the working directory ${cwd} (${os.platform()}, bash).`,
    'The main agent gave you a brief and sees only your final message, so end with a complete report of what you found or did: paths, names, commands, results.',
    "You can read and search files, run commands with Bash and edit files; some calls wait for the user's approval, and a rejected call should not be retried unchanged. Do only what the brief asks.",
  ].join('\n');
}

// The models this key can use, for the picker (refreshed now and then).
const modelsAt = new Map(); // session id -> when they were last read
async function refreshModels(session, force = false) {
  if (!force && Date.now() - (modelsAt.get(session.id) || 0) < 5 * 60_000) return;
  modelsAt.set(session.id, Date.now());
  try {
    const list = (await account.models()).map(({ id, name, efforts, defaultEffort, image, context }) => ({ id, name, efforts, defaultEffort, image, context }));
    if (store.getSession(session.id) !== session) return;
    const meta = session.meta || {};
    const fields = {};
    if (JSON.stringify(meta.models) !== JSON.stringify(list)) fields.models = list;
    if (meta.defaultModel !== account.DEFAULT_MODEL) fields.defaultModel = account.DEFAULT_MODEL;
    const size = list.find((m) => m.id === meta.model)?.context;
    if (size && meta.context && meta.context.size !== size) fields.context = { ...meta.context, size };
    if (Object.keys(fields).length) liveContext(session).setMeta(fields);
  } catch {}
}

// Someone has the conversation open.
export function view(session) {
  refreshModels(session);
}

// ------------------------------------------------------------------ turns

class Run {
  constructor(session) {
    this.session = session;
    this.ctx = liveContext(session);
    this.ac = new AbortController();
    this.waits = new Map(); // event id -> resolve(answer | null)
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.started = Date.now();
    this.firstEvent = session.events.length;
    this.subs = 0;
  }

  get aborted() {
    return this.ac.signal.aborted;
  }
}

// Resolves to { ok, promptId } once the message is on its way: a new turn,
// or (while Claude works) the queue — `steer` (插隊) has Claude read it at
// its next step instead of after the turn.
export async function send(session, text, { images = [], note, steer } = {}) {
  const why = cannotSend();
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const promptId = `p_${crypto.randomBytes(6).toString('hex')}`;
  const thumbs = images.map((i) => i.thumb || `data:${i.mimeType};base64,${i.data}`);
  if (runs.has(session.id)) {
    if (images.length) queuedImages.set(promptId, images);
    liveContext(session).setMeta({ queue: [...queue(session), { promptId, text, images: thumbs, ...(note ? { note } : {}), ...(steer ? { steered: true } : {}) }] });
    return { ok: true, promptId, queued: true };
  }
  startTurn(session, { text, images, thumbs, note, promptId });
  return { ok: true, promptId };
}

function startTurn(session, prompt) {
  const run = new Run(session);
  runs.set(session.id, run);
  run.done = turn(run, prompt)
    .catch((err) => console.error(`[claude] ${session.id}:`, err))
    .finally(() => {
      runs.delete(session.id);
      next(session);
    });
  return run;
}

// After a turn, the next message that waited for it.
function next(session) {
  if (runs.has(session.id) || store.getSession(session.id) !== session) return;
  const q = queue(session)[0];
  if (!q) return;
  liveContext(session).setMeta({ queue: queue(session).slice(1) });
  const images = queuedImages.get(q.promptId) || [];
  queuedImages.delete(q.promptId);
  startTurn(session, { text: q.text, images, thumbs: q.images, note: q.note, promptId: q.promptId });
}

const imageBlock = (i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } });

async function turn(run, { text, images = [], thumbs, note, promptId }) {
  const { session, ctx } = run;
  const c = st(session);
  repair(c);
  const userEv = ctx.emit({ type: 'user', text, images: thumbs || [], promptId, source: 'hub', ...(note ? { note } : {}) });
  c.turns = [...c.turns, { msg: c.messages.length, event: userEv.id, toldPlan: c.toldPlan ?? null }].slice(-50);
  if (!session.titled) ctx.setTitle(text.replace(/\s+/g, ' ').trim().slice(0, 80) || '新對話');
  ctx.setStatus('running');
  // The model and thinking are fixed for the whole turn (a change made
  // during it applies from the next one), which also keeps the cache warm.
  const model = session.meta?.model || account.DEFAULT_MODEL;
  const effort = session.meta?.effort || '';
  ctx.setMeta({ turnModel: model, turnEffort: effort });
  refreshModels(session);

  const content = [...images.map(imageBlock), { type: 'text', text: text || '（圖片）' }];
  const note2 = planNote(session, c);
  const sysNote = note2 && account.supportsSystemMessages(model) ? { role: 'system', content: note2 } : null;
  if (note2 && !sysNote) content.push({ type: 'text', text: `<system-reminder>${note2}</system-reminder>` });
  c.messages.push({ role: 'user', content });
  if (sysNote) c.messages.push(sysNote);

  let error = null;
  try {
    await loop(run, { messages: c.messages, model, effort, main: true, system: c.system, tools: mainTools(session, model) });
  } catch (err) {
    if (!run.aborted) {
      error = account.explain(err);
      ctx.emit({ type: 'error', text: error });
    }
  } finally {
    finishTurn(run, error);
  }
}

// Plan mode, told to Claude when it changes (append-only: never by editing
// the system prompt).
function planNote(session, c) {
  const plan = Boolean(session.meta?.planMode);
  const told = c.toldPlan ?? false;
  if (plan === told) return null;
  c.toldPlan = plan;
  return plan
    ? "Plan mode is on: change nothing. Research with the read-only tools, then present your plan with ExitPlanMode and wait for the user's approval."
    : "Plan mode is off: you may change files and run commands again (the user's permission mode still applies).";
}

const mainTools = (session, model) => [...apiTools(), ...(st(session).web ? account.webTools(model) : [])];
const subTools = (session, model) => [...apiTools(SUB_TOOLS), ...(st(session).web ? account.webTools(model) : [])];

// The history must be valid before a turn adds to it: tool calls the hub
// never answered (it stopped meanwhile) get an answer, and a note that no
// reply followed goes.
function repair(c) {
  // A note pops back off; Claude was last told the opposite of what it said.
  while (c.messages.at(-1)?.role === 'system') c.toldPlan = !/^Plan mode is on/.test(c.messages.pop().content);
  const last = c.messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const ids = last.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (ids.length) c.messages.push({ role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Not run: the turn ended before this tool call was answered.' })) });
  }
}

function finishTurn(run, error) {
  const { session, ctx } = run;
  for (const ev of session.events.slice(run.firstEvent)) {
    if (ev.permission && !ev.permission.chosen) ctx.patch(ev, { permission: { ...ev.permission, chosen: 'cancelled' } });
    if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) ctx.patch(ev, { status: run.aborted || ev.status === 'awaiting' ? 'interrupted' : 'ended' });
    if (ev.subagent?.status === 'running') ctx.patch(ev, { subagent: { ...ev.subagent, status: run.aborted ? 'cancelled' : 'error' } });
  }
  ctx.emit({ type: 'turn_end', durationMs: Date.now() - run.started, usage: { ...run.usage }, interrupted: run.aborted, error: Boolean(error) });
  ctx.setMeta({ turnModel: null, turnEffort: null });
  ctx.setStatus(error ? 'error' : 'idle');
  store.saveSession(session, { immediate: true });
}

// One agent's loop — the conversation's, or a subagent's — on its own
// history: ask Claude, run the tools it calls, send back the results, until
// it answers without a tool. Resolves to { finalText, aborted?, … }.
async function loop(run, opts) {
  const { session, ctx } = run;
  const { messages, main, scope = {} } = opts;
  const where = scope.parent ? { parent: scope.parent, agentId: scope.agentId } : {};
  let finalText = '';
  for (let step = 0; step < (main ? MAX_STEPS : SUB_STEPS); step++) {
    if (run.aborted) return { finalText, aborted: true };
    const budget = session.meta?.budget;
    if (budget && (session.usage?.costUsd || 0) >= budget) {
      if (!run.budgetSaid) ctx.emit({ type: 'info', text: `已達這個對話的花費上限 US$${budget}（目前約 US$${fmtUsd(session.usage.costUsd)}），先停在這裡。要繼續，在「⋯」→「花費上限…」調高或關閉，再送出「繼續」。` });
      run.budgetSaid = true;
      return { finalText, budget: true };
    }
    const r = await ask(run, opts);
    if (r.aborted) {
      if (r.partial) messages.push(r.partial);
      return { finalText, aborted: true };
    }
    const msg = r.message;
    count(run, opts, r);
    if (msg.stop_reason === 'refusal') {
      // Not kept: a declined answer is no use to the next request.
      const d = msg.stop_details || {};
      for (const ev of r.byId.values()) ctx.patch(ev, { status: 'ended' });
      ctx.emit({ type: 'error', text: `Claude 婉拒了這個請求${d.category ? `（安全分類：${d.category}）` : ''}。${d.explanation || ''}`.trim(), ...where });
      return { finalText, refused: true };
    }
    messages.push({ role: 'assistant', content: msg.content });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text.trim()) finalText = text;
    if (msg.stop_reason === 'pause_turn') continue; // a long server-side search: let it go on
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      if (msg.stop_reason === 'max_tokens') ctx.emit({ type: 'info', text: '回覆到達長度上限，被截斷了', ...where });
      if (msg.stop_reason === 'model_context_window_exceeded') ctx.emit({ type: 'info', text: '對話已經塞滿模型的 context。用 /compact 壓縮對話後再繼續。', ...where });
      return { finalText };
    }
    let results;
    if (msg.stop_reason === 'max_tokens') {
      // A call cut off mid-input would run on half an input: not run.
      const why = 'Your response hit the output limit, so this tool call was cut off and was not run. Do the work in smaller pieces (for a big file, Write a first part and add the rest with Edit).';
      results = uses.map((u) => {
        const ev = r.byId.get(u.id);
        if (ev) ctx.patch(ev, { status: 'error', isError: true, output: '輸出到達長度上限，這個工具呼叫被截斷，沒有執行' });
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: why };
      });
    } else results = await runTools(run, uses, r.byId, opts);
    const content = [...results];
    if (main && !run.aborted) content.push(...takeSteered(run));
    messages.push({ role: 'user', content });
  }
  ctx.emit({ type: 'info', text: `已達單次回合 ${main ? MAX_STEPS : SUB_STEPS} 步上限，先停在這裡`, ...where });
  return { finalText };
}

// Messages sent with 插隊 go in with the tool results, so Claude reads them
// at its next step.
function takeSteered(run) {
  const { session, ctx } = run;
  const items = queue(session).filter((q) => q.steered);
  if (!items.length) return [];
  ctx.setMeta({ queue: queue(session).filter((q) => !q.steered) });
  const blocks = [];
  for (const q of items) {
    ctx.emit({ type: 'user', text: q.text, images: q.images || [], promptId: q.promptId, source: 'hub', steered: true, ...(q.note ? { note: q.note } : {}) });
    const images = queuedImages.get(q.promptId) || [];
    queuedImages.delete(q.promptId);
    blocks.push(...images.map(imageBlock), { type: 'text', text: `The user sent this while you were working:\n${q.text || '(images)'}` });
  }
  return blocks;
}

// Tokens, cost, context, speed and rate limits after a response.
function count(run, opts, r) {
  const { session, ctx } = run;
  const c = st(session);
  const msg = r.message;
  const u = msg.usage || {};
  const price = account.costOf(msg.model || opts.model, u);
  const cost = price ?? 0;
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const out = u.output_tokens || 0;
  c.usage = { ...emptyUsage(), ...c.usage };
  c.usage.input += u.input_tokens || 0;
  c.usage.cacheWrite += u.cache_creation_input_tokens || 0;
  c.usage.cacheRead += u.cache_read_input_tokens || 0;
  c.usage.output += out;
  c.usage.searches += u.server_tool_use?.web_search_requests || 0;
  c.usage.requests += 1;
  c.usage.cost += cost;
  if (price === null) c.usage.unpriced = true;
  session.usage.inputTokens += prompt;
  session.usage.outputTokens += out;
  session.usage.costUsd += cost;
  run.usage.inputTokens += prompt;
  run.usage.outputTokens += out;
  run.usage.costUsd += cost;
  const fields = { claudeUsage: { ...c.usage } };
  if (opts.main && !opts.quiet) {
    fields.context = { used: prompt + out, size: account.modelInfo(opts.model).context };
    // Generated tokens over the time spent generating them, over the last
    // few responses, so it stays put while a tool runs.
    if (r.firstAt && out > 0) {
      c.rates = [...(c.rates || []), { tokens: out, ms: Math.max(1, r.endAt - r.firstAt) }].slice(-10);
      const tokens = c.rates.reduce((a, x) => a + x.tokens, 0);
      const ms = c.rates.reduce((a, x) => a + x.ms, 0);
      if (ms >= 100) fields.tps = Math.round((tokens / ms) * 1000);
    }
  }
  const limits = account.rateLimits(r.headers);
  if (limits) fields.rateLimits = limits;
  ctx.setMeta(fields);
}

// One request, streamed into the conversation: thinking and text as they
// are written, tool calls as soon as Claude starts them (their input too, so
// a page being written shows up live). Resolves to { message, byId } — the
// tool events by tool_use id — or { aborted, partial }.
async function ask(run, { messages, model, effort, system, tools, scope = {}, quiet = false, toolChoice }) {
  const { session, ctx } = run;
  const c = st(session);
  const where = scope.parent ? { parent: scope.parent, agentId: scope.agentId } : {};
  const body = {
    model,
    max_tokens: Math.min(64_000, account.modelInfo(model).maxOut || 64_000),
    // The fixed prefix (tools + system) and, automatically, the history so far.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
    cache_control: { type: 'ephemeral' },
    ...account.thinkingFor(model, effort),
  };
  if (toolChoice) body.tool_choice = toolChoice;
  const betas = [];
  // A request the model declines goes to another model on Anthropic's side
  // instead of failing (server-side fallback).
  if (account.supportsFallback(model) && body.thinking?.type !== 'between_tools' && !c.noFallback) {
    body.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }
  const client = account.client();
  for (let attempt = 0; ; attempt++) {
    const evs = new Map(); // content index -> event (or a placeholder until text arrives)
    const byId = new Map();
    let firstAt = 0;
    const emit = (fields) => (quiet ? { ...fields, id: '' } : ctx.emit({ ...fields, ...where }));
    try {
      const params = betas.length ? { ...body, betas } : body;
      const stream = betas.length ? client.beta.messages.stream(params, { signal: run.ac.signal }) : client.messages.stream(params, { signal: run.ac.signal });
      for await (const e of stream) {
        if (e.type === 'content_block_start') {
          const b = e.content_block;
          if (b.type === 'tool_use') {
            const ev = emit({ type: 'tool_use', name: b.name, toolCallId: b.id, title: '', status: 'pending', argsText: '' });
            evs.set(e.index, ev);
            byId.set(b.id, ev);
          } else if (b.type === 'server_tool_use') {
            evs.set(e.index, emit({ type: 'tool_use', name: SERVER_TOOLS[b.name] || b.name, toolCallId: b.id, server: true, title: '', status: 'running', argsText: '' }));
          } else if (b.type === 'text' || b.type === 'thinking') {
            evs.set(e.index, { lazy: b.type, text: b.text || b.thinking || '' });
          } else if (/tool_result$/.test(b.type) && b.tool_use_id && !quiet) {
            serverResult(run, b);
          } else if (b.type === 'fallback' && !quiet) {
            ctx.emit({ type: 'info', text: `${modelName(b.from?.model)} 婉拒了這個請求，改由 ${modelName(b.to?.model)} 接手`, ...where });
          }
        } else if (e.type === 'content_block_delta') {
          const d = e.delta;
          let ev = evs.get(e.index);
          if (!ev) continue;
          if (d.type === 'text_delta' || d.type === 'thinking_delta') {
            const t = d.type === 'text_delta' ? d.text : d.thinking;
            if (!t) continue;
            firstAt ||= Date.now();
            if (quiet) continue;
            if (ev.lazy) {
              const real = ctx.emit({ type: ev.lazy, text: ev.text, ...where });
              evs.set(e.index, real);
              ev = real;
            }
            ctx.delta(ev, t);
          } else if (d.type === 'input_json_delta' && d.partial_json && !ev.lazy) {
            firstAt ||= Date.now();
            if (!quiet) ctx.delta(ev, d.partial_json, 'argsText');
          }
        }
      }
      const message = await stream.finalMessage();
      if (!quiet) {
        message.content.forEach((b, i) => {
          const ev = evs.get(i);
          if (!ev || ev.lazy) return;
          if (b.type === 'tool_use' || b.type === 'server_tool_use') ctx.patch(ev, { input: b.input, title: titleOf(ev.name, b.input, session.cwd), argsText: '' });
        });
      }
      return { message, byId, headers: stream.response?.headers, firstAt, endAt: Date.now() };
    } catch (err) {
      if (run.aborted) return { aborted: true, partial: partialOf(evs) };
      const msg = String(err?.error?.error?.message || err?.message || '');
      if (!quiet) for (const ev of byId.values()) ctx.patch(ev, { status: 'ended' });
      // A 400 before anything was written: fixable once by asking differently.
      if (attempt === 0 && err?.status === 400 && body.fallbacks && /fallback/i.test(msg)) {
        c.noFallback = true;
        delete body.fallbacks;
        betas.length = 0;
        continue;
      }
      if (attempt === 0 && err?.status === 400 && /signature|thinking/i.test(msg) && stripThinking(messages)) continue;
      throw err;
    }
  }
}

// What Claude had written of an answer that was stopped: its text, so the
// next turn knows what it already said.
function partialOf(evs) {
  const text = [...evs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ev]) => (ev.type === 'text' ? ev.text : ''))
    .join('')
    .trimEnd();
  return text ? { role: 'assistant', content: [{ type: 'text', text }] } : null;
}

// The documented way back when the API refuses earlier thinking blocks:
// drop them all, once.
function stripThinking(messages) {
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    n += m.content.length - kept.length;
    m.content = kept.length ? kept : [{ type: 'text', text: '…' }];
  }
  return n > 0;
}

function modelName(id) {
  return account.modelInfo(id || '').name || id || 'Claude';
}

function findTool(session, toolUseId) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i];
    if (ev.type === 'tool_use' && ev.toolCallId === toolUseId) return ev;
  }
  return null;
}

// Web search / fetch results arrive whole, as a block of their own.
function serverResult(run, b) {
  const ev = findTool(run.session, b.tool_use_id);
  if (!ev) return;
  const x = b.content;
  let output = '';
  let isError = false;
  if (Array.isArray(x)) {
    output = x.filter((r) => r.type === 'web_search_result').map((r) => `${r.title || r.url}\n  ${r.url}`).join('\n') || '沒有結果';
  } else if (x && /error/.test(x.type || '')) {
    isError = true;
    output = `失敗：${x.error_code || 'unknown'}`;
  } else if (x?.type === 'web_fetch_result') {
    output = [x.content?.title, x.url].filter(Boolean).join('\n');
  } else if (x && typeof x === 'object') {
    output = [x.stdout, x.stderr].filter(Boolean).join('\n') || (x.return_code != null ? `exit ${x.return_code}` : '');
  }
  run.ctx.patch(ev, { status: isError ? 'error' : 'done', isError, output });
}

// --------------------------------------------------------------- tools

// Subagents run side by side; everything else one after another.
async function runTools(run, uses, byId, opts) {
  const results = new Map();
  const one = async (u) => results.set(u.id, await runTool(run, u, byId.get(u.id), opts));
  const tasks = uses.filter((u) => u.name === 'Task');
  const parallel = Promise.all(tasks.map(one));
  for (const u of uses) if (u.name !== 'Task') await one(u);
  await parallel;
  return uses.map((u) => {
    const r = results.get(u.id);
    const content = typeof r.content === 'string' ? r.content || '(no output)' : r.content;
    return { type: 'tool_result', tool_use_id: u.id, content, ...(r.isError ? { is_error: true } : {}) };
  });
}

function needsPermission(session, name, kind) {
  if (kind !== 'edit' && kind !== 'exec') return false;
  if (session.allowedTools?.includes(name)) return false;
  const mode = session.meta?.permission || 'manual';
  if (mode === 'auto') return false;
  if (mode === 'edits' && kind === 'edit') return false;
  return true;
}

const interrupted = (run, ev) => {
  if (ev) run.ctx.patch(ev, { status: 'interrupted' });
  return { content: 'Interrupted by the user.', isError: true };
};

async function runTool(run, u, ev, opts) {
  const { session, ctx } = run;
  ev ??= ctx.emit({ type: 'tool_use', name: u.name, toolCallId: u.id, input: u.input, title: titleOf(u.name, u.input, session.cwd), status: 'pending' });
  if (run.aborted) return interrupted(run, ev);
  const invalid = validate(u.name, u.input);
  if (invalid) {
    const text = `Invalid input: ${invalid}. Received: ${JSON.stringify(u.input).slice(0, 400)}`;
    ctx.patch(ev, { status: 'error', isError: true, output: text });
    return { content: text, isError: true };
  }
  const kind = toolKind(u.name);
  if (kind === 'todo') {
    const todos = u.input.todos.map((t) => ({ title: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, content: t.content, status: t.status }));
    ctx.patch(ev, { todos, status: 'done' });
    if (opts.main) ctx.setMeta({ todos });
    return { content: 'Todo list updated. Keep it current as you work.', isError: false };
  }
  if (kind === 'ask') return askQuestions(run, ev, u.input);
  if (kind === 'plan') return planReview(run, ev, u.input);
  if (kind === 'agent') return subagent(run, ev, u.input, opts);
  if ((kind === 'edit' || kind === 'exec') && session.meta?.planMode) {
    st(session).toldPlan = true;
    ctx.patch(ev, { status: 'denied', output: '計畫模式中：還不能修改或執行' });
    return { content: 'Plan mode is on, so nothing can be changed or run yet. Keep researching with Read, Grep and Glob, then present your plan with ExitPlanMode.', isError: true };
  }
  if (needsPermission(session, u.name, kind)) {
    const a = await askUser(run, ev, { kind: 'approval', options: APPROVAL_OPTIONS });
    if (!a) return interrupted(run, ev);
    if (a.optionId === 'rejected') {
      ctx.patch(ev, { status: 'denied' });
      return { content: `The user rejected this ${u.name} call.${a.feedback ? ` What they said: ${a.feedback}` : ' Do not retry it unchanged; ask them how to proceed if it is unclear.'}`, isError: true };
    }
    if (a.optionId === 'approved_session' && !session.allowedTools.includes(u.name)) session.allowedTools.push(u.name);
  }
  ctx.patch(ev, { status: 'running', output: '' });
  // A long command's output streams onto its card, a few times a second.
  let pending = '';
  let timer = null;
  const r = await execute(u.name, u.input, {
    cwd: session.cwd,
    signal: run.ac.signal,
    onData: (chunk) => {
      pending += chunk;
      timer ??= setTimeout(() => {
        ctx.delta(ev, pending, 'output');
        pending = '';
        timer = null;
      }, 150);
    },
  });
  clearTimeout(timer);
  ctx.patch(ev, { status: run.aborted ? 'interrupted' : r.isError ? 'error' : 'done', output: r.output, isError: r.isError });
  return { content: r.content, isError: r.isError };
}

// Show a choice on the card and wait. Resolves to { optionId, answers,
// feedback }, or null when the turn is stopped.
function askUser(run, ev, permission) {
  const { ctx } = run;
  ctx.patch(ev, { status: 'awaiting', permission: { ...permission, chosen: null } });
  ctx.setStatus('awaiting_permission');
  return new Promise((resolve) => {
    if (run.aborted) return resolve(null);
    run.waits.set(ev.id, resolve);
  }).then((answer) => {
    run.waits.delete(ev.id);
    if (!run.waits.size && !run.aborted) ctx.setStatus('running');
    return answer;
  });
}

export async function respond(session, eventId, optionId, { answers, feedback } = {}) {
  const run = runs.get(session.id);
  const resolve = run?.waits.get(eventId);
  const ev = session.events.find((e) => e.id === eventId);
  if (!resolve || !ev?.permission || ev.permission.chosen) return false;
  const note = String(feedback || '').trim();
  run.ctx.patch(ev, { permission: { ...ev.permission, chosen: optionId === 'answer' ? 'answered' : optionId, ...(note ? { feedback: note } : {}) }, ...(answers ? { answers } : {}) });
  resolve({ optionId, answers, feedback: note });
  return true;
}

async function askQuestions(run, ev, input) {
  const questions = input.questions.slice(0, 4).map((q, i) => ({
    id: `q${i}`,
    question: q.question,
    header: q.header || '',
    multi_select: Boolean(q.multiSelect),
    allow_other: true,
    other_label: '其他答案',
    options: (q.options || []).map((o, j) => ({ id: `o${j}`, label: o.label, description: o.description || '' })),
  }));
  run.ctx.patch(ev, { title: questions[0]?.question || 'Claude 有問題要問你' });
  const a = await askUser(run, ev, { kind: 'question', questions });
  if (!a) return interrupted(run, ev);
  if (a.optionId === '__dismiss') {
    run.ctx.patch(ev, { status: 'done' });
    return { content: 'The user skipped the questions without answering. Go on with your best judgment, or ask again in plain words if you cannot.', isError: false };
  }
  const label = (q, id) => q.options.find((o) => o.id === id)?.label || id;
  const lines = questions.map((q) => {
    const x = a.answers?.[q.id];
    let t = '(skipped)';
    if (x?.kind === 'single') t = label(q, x.option_id);
    else if (x?.kind === 'multi') t = x.option_ids.map((id) => label(q, id)).join(', ');
    else if (x?.kind === 'other') t = x.text;
    else if (x?.kind === 'multi_with_other') t = [...x.option_ids.map((id) => label(q, id)), x.other_text].join(', ');
    return `- ${q.question} → ${t}`;
  });
  run.ctx.patch(ev, { status: 'done', output: lines.join('\n') });
  return { content: `The user answered:\n${lines.join('\n')}`, isError: false };
}

async function planReview(run, ev, input) {
  const { session, ctx } = run;
  if (!session.meta?.planMode) {
    ctx.patch(ev, { status: 'done' });
    return { content: 'Plan mode is not on, so there is nothing to approve: go ahead with the work.', isError: false };
  }
  const a = await askUser(run, ev, { kind: 'plan', plan: input.plan, options: PLAN_OPTIONS });
  if (!a) return interrupted(run, ev);
  if (a.optionId === 'rejected') {
    ctx.patch(ev, { status: 'denied' });
    return { content: `The user did not approve the plan.${a.feedback ? ` Their feedback: ${a.feedback}` : ''} You are still in plan mode: revise the plan and call ExitPlanMode again, or ask what they want changed.`, isError: false };
  }
  const permission = a.optionId === 'plan:edits' ? 'edits' : 'manual';
  ctx.setMeta({ planMode: false, permission });
  st(session).toldPlan = false;
  ctx.patch(ev, { status: 'done' });
  return { content: `The user approved the plan. Plan mode is off now${permission === 'edits' ? ', and file edits no longer need their approval (commands still do)' : ''}. Carry out the plan.`, isError: false };
}

async function subagent(run, ev, input, { model, effort }) {
  const { session, ctx } = run;
  const id = `sub-${++run.subs}-${crypto.randomBytes(3).toString('hex')}`;
  const sub = { id, name: 'subagent', description: input.description, status: 'running', model, effort };
  ctx.patch(ev, { status: 'running', title: input.description, subagent: sub });
  const c = st(session);
  let out;
  try {
    out = await loop(run, {
      messages: [{ role: 'user', content: input.prompt }],
      model,
      effort,
      main: false,
      scope: { parent: ev.id, agentId: id },
      system: c.subSystem || subSystemPrompt(session.cwd),
      tools: subTools(session, model),
    });
  } catch (err) {
    if (run.aborted) {
      ctx.patch(ev, { subagent: { ...sub, status: 'cancelled' } });
      return interrupted(run, ev);
    }
    const text = account.explain(err);
    ctx.patch(ev, { status: 'error', isError: true, output: text, subagent: { ...sub, status: 'error', error: text } });
    return { content: `The subagent failed: ${text}`, isError: true };
  }
  if (out.aborted) {
    ctx.patch(ev, { subagent: { ...sub, status: 'cancelled' } });
    return interrupted(run, ev);
  }
  const summary = out.finalText.trim();
  ctx.patch(ev, { status: 'done', output: summary, subagent: { ...sub, status: 'done', summary } });
  return { content: summary || '(The subagent finished without a report.)', isError: false };
}

// ------------------------------------------------------------- controls

export async function interrupt(session) {
  const run = runs.get(session.id);
  if (!run) return;
  run.ac.abort();
  for (const resolve of [...run.waits.values()]) resolve(null);
}

export function steerQueued(session, promptId) {
  const q = queue(session).find((x) => x.promptId === promptId);
  if (!q || q.steered) return;
  liveContext(session).setMeta({ queue: queue(session).map((x) => (x.promptId === promptId ? { ...x, steered: true } : x)) });
}

export function cancelQueued(session, promptId) {
  queuedImages.delete(promptId);
  liveContext(session).setMeta({ queue: queue(session).filter((x) => x.promptId !== promptId) });
}

// Model, thinking, permission and plan mode. A model or thinking change
// made while Claude works applies from the next turn.
export async function configure(session, { model, effort, permission, planMode }) {
  const f = {};
  if (typeof model === 'string' && model) {
    f.model = model;
    const m = account.modelInfo(model);
    const e = session.meta?.effort;
    if (e && m.efforts.length && !m.efforts.includes(e)) f.effort = m.efforts.includes('high') ? 'high' : m.defaultEffort || '';
  }
  if (typeof effort === 'string' && effort) f.effort = effort;
  if (PERMISSIONS.includes(permission)) f.permission = permission;
  if (typeof planMode === 'boolean') f.planMode = planMode;
  if (!Object.keys(f).length) throw Object.assign(new Error('沒有要變更的設定'), { status: 400 });
  liveContext(session).setMeta(f);
  return null;
}

const busyError = () => Object.assign(new Error('Claude 正在工作，等這一輪結束再試'), { status: 409 });

export async function command(session, name, args = '') {
  const ctx = liveContext(session);
  switch (name) {
    case 'compact':
      await compact(session, args);
      return {};
    case 'undo': {
      if (runs.has(session.id)) throw busyError();
      const c = st(session);
      const t = c.turns.at(-1);
      if (!t) throw Object.assign(new Error('沒有可以撤回的對話（壓縮過的部分不能撤回）'), { status: 400 });
      c.turns = c.turns.slice(0, -1);
      c.messages.length = Math.min(t.msg, c.messages.length);
      c.toldPlan = t.toldPlan ?? undefined;
      const i = session.events.findIndex((e) => e.id === t.event);
      if (i !== -1) ctx.replaceEvents(session.events.slice(0, i));
      store.saveSession(session, { immediate: true });
      return {};
    }
    case 'fork': {
      const c = st(session);
      const copy = store.createSession({
        agentId: AGENT.id,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        title: args || `${session.title}（複製）`,
        titled: true,
        allowedTools: [...(session.allowedTools || [])],
        meta: { ...structuredClone(session.meta || {}), queue: [], turnModel: null, turnEffort: null, claudeUsage: null },
        state: { claude: { ...structuredClone(c), turns: [], usage: emptyUsage(), rates: [] } },
        events: structuredClone(session.events),
      });
      return { session: copy };
    }
    case 'title':
      if (!args) throw Object.assign(new Error('在 /title 後面輸入新標題'), { status: 400 });
      ctx.setTitle(args.slice(0, 120));
      return {};
    case 'budget': {
      const a = String(args).trim().toLowerCase().replace(/^us\$|^\$/, '');
      if (['', 'off', '關', '關閉', '0'].includes(a)) {
        ctx.setMeta({ budget: null });
        return {};
      }
      const n = Number(a);
      if (!Number.isFinite(n) || n <= 0 || n > 100_000) throw Object.assign(new Error('用法：/budget 5（這個對話最多花 US$5）、/budget off'), { status: 400 });
      ctx.setMeta({ budget: Math.round(n * 100) / 100 });
      return {};
    }
    default:
      throw Object.assign(new Error(`沒有 /${name} 這個指令`), { status: 400 });
  }
}

// /compact: Claude summarizes the conversation and the summary replaces the
// history (the conversation shown stays as it is).
async function compact(session, instruction) {
  if (runs.has(session.id)) throw busyError();
  const why = cannotSend();
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const c = st(session);
  repair(c);
  if (!c.messages.length) throw Object.assign(new Error('還沒有對話內容可以壓縮'), { status: 400 });
  const run = new Run(session);
  runs.set(session.id, run);
  const { ctx } = run;
  ctx.setStatus('running');
  const note = ctx.emit({ type: 'info', text: '正在壓縮對話內容…' });
  const model = session.meta?.model || account.DEFAULT_MODEL;
  const opts = {
    messages: [...c.messages, { role: 'user', content: COMPACT_PROMPT + (instruction ? `\n\nAlso: ${instruction}` : '') }],
    model,
    effort: session.meta?.effort || '',
    main: true,
    quiet: true,
    system: c.system,
    tools: mainTools(session, model),
    toolChoice: { type: 'none' },
  };
  try {
    const r = await ask(run, opts);
    if (r.aborted) return ctx.patch(note, { text: '已取消壓縮' });
    count(run, opts, r);
    const summary = r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!summary) throw new Error('Claude 沒有寫出摘要');
    const before = session.meta?.context?.used;
    c.messages = [{ role: 'user', content: [{ type: 'text', text: `${RESUME_PREFIX}\n\n${summary}` }] }];
    c.turns = [];
    c.toldPlan = undefined;
    const after = Math.round(summary.length / 3);
    ctx.setMeta({ context: { used: after, size: account.modelInfo(model).context } });
    ctx.patch(note, { text: `已壓縮對話${before ? `（context 約 ${Math.round(before / 1000)}k → ${Math.max(1, Math.round(after / 1000))}k tokens）` : ''}。上面的內容仍然看得到，Claude 之後只記得摘要。` });
  } catch (err) {
    ctx.patch(note, { text: '壓縮失敗' });
    throw Object.assign(new Error(account.explain(err)), { status: 502 });
  } finally {
    runs.delete(session.id);
    ctx.setStatus('idle');
    store.saveSession(session, { immediate: true });
    next(session);
  }
}

export const isRunning = (session) => runs.has(session.id);

// At startup: whatever was in progress when the hub stopped is over.
export function restore(session) {
  let changed = false;
  for (const ev of session.events) {
    if (ev.permission && !ev.permission.chosen) {
      ev.permission = { ...ev.permission, chosen: 'cancelled' };
      changed = true;
    }
    if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) {
      ev.status = 'interrupted';
      changed = true;
    }
    if (ev.subagent?.status === 'running') {
      ev.subagent = { ...ev.subagent, status: 'cancelled' };
      changed = true;
    }
  }
  const meta = session.meta || {};
  if (meta.queue?.length) {
    session.events.push({ id: store.newId('e_'), ts: Date.now(), type: 'info', text: `中控台重新啟動了，這些排隊中的訊息沒有送出：${meta.queue.map((q) => `「${q.text}」`).join('、')}` });
    meta.queue = [];
    changed = true;
  }
  if (meta.turnModel || meta.turnEffort) {
    meta.turnModel = null;
    meta.turnEffort = null;
    changed = true;
  }
  if (changed) store.saveSession(session);
}

export function dispose(session) {
  for (const q of queue(session)) queuedImages.delete(q.promptId);
  interrupt(session);
  modelsAt.delete(session.id);
}
