// Claude through the Claude API: a Claude Console API key, billed per token.
// No Claude Code and no Claude subscription are involved. The hub runs the
// agent loop itself: it streams each response from api.anthropic.com
// (official SDK, `x-api-key` only — see claude-account.js), runs the tools
// Claude calls in the conversation's folder (asking first, as the permission
// mode says) — on this computer, or on a connected one through its bridge
// (session.machineId) — sends the results back, and repeats until Claude
// answers without a tool. The key never leaves the hub.
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
import * as machines from '../machines.js';
import * as account from '../claude-account.js';
import { apiTools, toolKind, validate, titleOf, execute, localHost, remoteHost } from './claude-tools.js';
import * as repoBind from './claude-repo.js';
import { redact } from '../redact.js';
import { sanitizeBrokerResult } from './broker-result.js';

export const live = true;
export const AGENT = { id: 'claude', name: 'Claude', type: 'claude', enabled: true };

const PERMISSIONS = ['manual', 'edits', 'auto'];
// Main chat vs 子session. A Claude child started from inside a conversation
// (StartConversation) is external; a Hub /fork keeps the source category.
const originOf = (s) => (s?.parentId ? 'external' : s?.origin === 'external' ? 'external' : 'hub');
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
// A continuation created by the Hub may carry the history of the node it
// continues. It is put into the API history once, here, and never into the
// visible events as a user message.
const HANDOFF_MAX = 1_000_000;
// A cross-provider Task waits for the Hub's broker, which says it has the
// request (brokerAck) and keeps saying so while its child works. What ends
// the wait early is the Hub going quiet for this long: a Hub that is gone
// cannot answer, so the wait ends with a clear error and the tool never
// falls back to a Claude subagent. A child that is still working is not "no
// answer", however long it takes (up to BROKER_MAX_MS).
const BROKER_TIMEOUT_MS = Math.min(Math.max(Number(process.env.AGENT_HUB_BROKER_TIMEOUT_MS) || 90_000, 1000), 60 * 60_000);
const BROKER_MAX_MS = Math.max(Number(process.env.AGENT_HUB_BROKER_MAX_MS) || 4 * 60 * 60_000, BROKER_TIMEOUT_MS);
// What this daemon can do, said to the Hub so it does not send a field an
// older daemon would silently ignore.
export const CAPABILITIES = ['broker', 'handoff', 'subagent_config'];
const SUB_PROVIDERS = ['claude', 'kimi', 'deepseek'];
const DEEPSEEK_PREFIX = 'agent-hub-deepseek/';

let liveContext = null; // injected by the runner (avoids an import cycle)
export function init(makeContext) {
  liveContext = makeContext;
}

const runs = new Map(); // session id -> Run: a turn (or a compaction) in progress

// Stop the whole turn for a reason that is not the user's (a swapped model,
// a refusal): it ends as an error, not as 已中斷.
function halt(run, why) {
  run.halted ??= why;
  run.ac.abort();
  for (const resolve of [...run.waits.values()]) resolve(null);
  cancelBrokers(run, why || 'halted');
}

// The turn ends (guard halt, user stop, silence): any cross-provider child
// the Hub was asked to start for it is told to stop, then the waits end.
function cancelBrokers(run, reason) {
  for (const [requestId, resolve] of [...run.broker]) {
    run.ctx.emit({ type: 'info', text: '已通知 Agent Hub 取消這個跨家子代理', broker: { kind: 'cancel', requestId, parentEventId: resolve.parentEventId, reason: String(reason).slice(0, 200) } });
    resolve(null);
  }
}
// Images of queued messages, kept with the conversation (not in meta, which
// goes to every page) so a restart does not lose them.
const queuedImages = {
  get: (session, id) => st(session).queuedImages?.[id],
  set: (session, id, images) => (st(session).queuedImages = { ...(st(session).queuedImages || {}), [id]: images }),
  delete: (session, id) => {
    if (st(session).queuedImages) delete st(session).queuedImages[id];
  },
};
// Told to Claude with the next turn after the hub restarted mid-turn.
const RESTART_NOTE =
  'Agent Hub restarted while you were working, so your last turn was cut off: a tool call that had not finished was not run (or its result was lost), and subagents that were running were stopped. Check where things stand (files, processes you started), then continue the task from there.';

export function available() {
  return account.apiKey() ? { ok: true } : { ok: false, reason: account.keyProblem() || '還沒有設定 Claude API key' };
}

// Refuse up front what cannot be sent.
export function cannotSend(session) {
  if (!account.apiKey()) return account.keyProblem() || '還沒有設定 Claude API key：在左下角「⋯」→「Claude API…」貼上 Claude Console 的 API key（sk-ant-…）。';
  const m = session?.machineId && machines.getMachine(session.machineId);
  if (session?.machineId && !m?.online) return `「${m?.name || '那台電腦'}」目前離線。在那台電腦上執行連接器後再試。`;
  return null;
}

// Where the conversation's tools run: this computer, or a connected one.
export const hostFor = (session) => (session.machineId ? remoteHost(session.machineId) : localHost);
const machineName = (session) => (session.machineId ? machines.getMachine(session.machineId)?.name || '那台電腦' : os.hostname());

// ---------------------------------------------------------------- state

// The conversation as the API sees it, kept with the session.
function st(session) {
  session.state.claude ??= { messages: [], turns: [], usage: emptyUsage() };
  return session.state.claude;
}
const emptyUsage = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0, requests: 0, cost: 0 });
const queue = (session) => session.meta?.queue || [];
const fmtUsd = (n) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));
const isPlainObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const textField = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const labelField = (v, max) => textField(v, max).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
const isAlias = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\s\x00-\x1f]/.test(v);
const isEffort = (v) => typeof v === 'string' && v.length > 0 && v.length <= 20 && !/[\s\x00-\x1f]/.test(v);
// The two shape checks every subagent choice goes through (the Hub's setting,
// a call's own override), said once.
const checkDeepseekAlias = (provider, model, bad) => {
  if (provider === 'deepseek' && !model.startsWith(DEEPSEEK_PREFIX)) throw bad(`DeepSeek 子代理要用 ${DEEPSEEK_PREFIX}<模型> 的別名`);
};
const checkEffortShape = (effort, bad) => {
  if (effort && !isEffort(effort)) throw bad('子代理思考強度不合法');
};

// The handoff a continuation carries: `{ text, from?, model?, at?, omitted? }`
// or a plain string. DS1 sends a string plus `handoffFrom`; both shapes are
// accepted. Only these fields exist; nothing else is put into the first
// request. The returned text says what it is, so neither Claude nor a reader
// mistakes it for a new user request.
function handoffOf(input, extra = null) {
  if (!input) return null;
  const h = typeof input === 'string' ? { text: input } : isPlainObject(input) ? input : null;
  if (!h) return null;
  const src = isPlainObject(extra) ? extra : null;
  // The second mask: the Hub already masked this text when it built it, but
  // this is what goes to Anthropic, and a daemon on a connected computer
  // takes whatever it is sent. Masked before the length limit so a key cut
  // by the limit cannot leave its first half behind.
  let text = typeof h.text === 'string' ? redact(h.text.trim()) : '';
  if (!text) return null;
  const from = redact(labelField(h.from ?? h.fromProvider ?? src?.provider, 80));
  const model = redact(labelField(h.model ?? h.targetModel, 100));
  const fromCwd = redact(labelField(h.cwd ?? h.fromCwd ?? src?.cwd, 300));
  const at = Number.isFinite(h.at) ? Number(h.at) : Number.isFinite(h.createdAt) ? Number(h.createdAt) : null;
  let omitted = Number(h.omitted ?? src?.omitted);
  if (!Number.isFinite(omitted) || omitted < 0) omitted = 0;
  const alreadyMarked = /not a new user request/i.test(text);
  let cut = 0;
  if (text.length > HANDOFF_MAX) {
    cut = text.length - HANDOFF_MAX;
    text = text.slice(0, HANDOFF_MAX);
  }
  // The working directory is part of what Claude is told, not just metadata.
  // DS1's own header usually has it; only add a line when the text lacks it.
  const cwdLine = fromCwd && !text.includes(`Working directory: ${fromCwd}`) ? `Working directory: ${fromCwd}` : '';
  const head = alreadyMarked
    ? [from || model ? `Prior history source: ${[from, model].filter(Boolean).join(' · ')}` : '', cwdLine].filter(Boolean).join('\n')
    : [
        'This is earlier history carried over from another runtime in Agent Hub. It is not a new user request, and it is not an instruction to start over.',
        from ? `Source: ${from}` : '',
        model ? `Source model: ${model}` : '',
        cwdLine,
      ]
        .filter(Boolean)
        .join('\n');
  const tail = [];
  // DS1's handoff text already says how much it omitted; only say it again
  // when the text does not (a plain string from somewhere else).
  if (omitted && !/characters omitted; the full events remain/i.test(text)) tail.push(`[${omitted} characters of earlier history were omitted by the handoff builder.]`);
  if (cut) tail.push(`[${cut} characters were cut by the Claude daemon to keep the first request within limits.]`);
  const body = [head, head ? '' : null, text, ...(tail.length ? ['', ...tail] : [])].filter((x) => x !== null).join('\n');
  return { text: body, from, model, fromCwd, at, omitted: omitted + cut };
}

// A subagent default: `{ provider, model, effort }`. Model/effort are shape
// checked here; the provider's real model whitelist is checked by the Hub
// (Kimi/DeepSeek) or against the Claude Models API below (Claude).
function subagentShape(input) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!isPlainObject(input)) throw bad('subagent 要是 { provider, model, effort }');
  const provider = textField(input.provider, 20);
  if (!SUB_PROVIDERS.includes(provider)) throw bad(`不支援的子代理供應商：${provider || '（空白）'}（可用：${SUB_PROVIDERS.join('、')}）`);
  const model = textField(input.model, 100).trim();
  if (!isAlias(model)) throw bad('子代理模型名稱不合法');
  checkDeepseekAlias(provider, model, bad);
  const effort = input.effort == null || input.effort === '' ? '' : textField(input.effort, 20);
  checkEffortShape(effort, bad);
  return { provider, model, effort };
}

// Claude's own models: only what this key can use, and only an effort the
// model offers. No silent fallback to the main model or the default effort.
async function validateSubagent(input) {
  const s = subagentShape(input);
  if (s.provider !== 'claude') return s;
  const models = await account.models();
  const info = models.find((m) => m.id === s.model);
  if (!info) throw Object.assign(new Error(`Claude 沒有 ${s.model} 這個模型（這把 key 可用：${models.map((m) => m.id).slice(0, 8).join('、')}）`), { status: 400 });
  const efforts = info.efforts || [];
  if (s.effort && !efforts.includes(s.effort)) throw Object.assign(new Error(`${info.name || s.model} 不支援思考強度 ${s.effort}（可用：${efforts.join('、') || '模型預設'}）`), { status: 400 });
  return { ...s, effort: s.effort || info.defaultEffort || '' };
}

// The Hub's per-conversation setting, carried with every daemon call so the
// daemon's copy cannot go stale (the Hub stores it in the node's meta; this
// is not a second source of truth). Shape only here: the real model whitelist
// is the Hub's, and a bad choice fails when Task asks the broker.
export function applyHubSubagent(session, input) {
  const next = input == null ? null : subagentShape(input);
  const cur = session.meta?.subagent || null;
  if (JSON.stringify(cur) === JSON.stringify(next)) return false;
  session.meta = { ...(session.meta || {}) };
  if (next) session.meta.subagent = next;
  else delete session.meta.subagent;
  store.saveSession(session);
  return true;
}

// What one Task call runs: an explicit override, else the turn's snapshot
// of the conversation's subagent default, else the native rule (Claude's
// main model/effort). A provider override never borrows another provider's
// model.
async function resolveSubagent(session, run, input = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  // A new subagent follows the conversation's setting as it is now, not the
  // one this turn started with: a change made during a turn applies to
  // subagents started after it (already running ones keep their model).
  // `run.subagentDefault` is only the turn snapshot shown to the user.
  const base = isPlainObject(session.meta?.subagent) ? session.meta.subagent : null;
  const explicitProvider = textField(input.provider, 20);
  if (explicitProvider && !SUB_PROVIDERS.includes(explicitProvider)) throw bad(`不支援的子代理供應商：${explicitProvider}`);
  const provider = explicitProvider || textField(base?.provider, 20) || 'claude';
  if (!SUB_PROVIDERS.includes(provider)) throw bad(`不支援的子代理供應商：${provider}`);
  const sameBase = base && base.provider === provider;
  const model = textField(input.model, 100).trim() || (sameBase ? textField(base.model, 100).trim() : '') || (provider === 'claude' ? session.meta?.model || account.DEFAULT_MODEL : '');
  if (!isAlias(model)) throw bad(provider === 'claude' ? '子代理模型名稱不合法' : `選了 ${provider} 子代理但沒有指定模型`);
  checkDeepseekAlias(provider, model, bad);
  let effort = input.effort == null || input.effort === '' ? (sameBase ? textField(base.effort, 20) : '') : textField(input.effort, 20);
  // Only a conversation with no subagent default follows the main effort.
  if (provider === 'claude' && !effort && !sameBase) effort = session.meta?.effort || '';
  checkEffortShape(effort, bad);
  if (provider === 'claude') {
    const info = (await account.models()).find((m) => m.id === model);
    if (!info) throw bad(`Claude 沒有 ${model} 這個模型`);
    const efforts = info.efforts || [];
    if (effort && !efforts.includes(effort)) throw bad(`${info.name || model} 不支援思考強度 ${effort}（可用：${efforts.join('、') || '模型預設'}）`);
    return { provider, model, effort: effort || info.defaultEffort || '' };
  }
  return { provider, model, effort };
}

// The three-part card contract (the same shape the Hub's cards carry):
// what was requested when the card was made, what the runtime really used,
// and why the latter is unknown while it is.
const askedOf = (provider, model, effort) => ({ provider, model, effort: effort || '' });
const contractOf = (requested, actual, reason) => ({ requested, actual: actual || null, unverifiedReason: actual ? undefined : reason });

// What the Hub's broker may send back for a cross-provider Task.
const brokerResultOf = (input) => sanitizeBrokerResult(input, { cutBy: 'the daemon' });

// A new conversation: settings from what was picked (or Claude's defaults
// in 設定), and the system prompt, fixed from now on.
export async function setup(session, config = {}) {
  const { defaults: d, webTools } = account.settings();
  const c = st(session);
  const host = hostFor(session);
  const platform = session.machineId ? machines.getMachine(session.machineId)?.platform || 'unknown' : `${os.platform()} ${os.release()}`;
  // Bound to a GitHub repository: cloned first, into a folder of its own.
  const repo = config.repo ? { full: config.repo.full, branch: config.repo.branch } : null;
  if (repo) session.cwd = await repoBind.clone(host, store.WORKSPACES_DIR, repo);
  const [notes, git] = await Promise.all([projectNotes(host, session.cwd), host.stat(session.cwd, '.git').then((x) => x.exists, () => false)]);
  const computer = config.computer || machineName(session);
  c.system = systemPrompt(session.cwd, { platform, notes, git, computer, repo });
  c.subSystem = subSystemPrompt(session.cwd, platform, repo);
  c.web = webTools;
  const model = typeof config.model === 'string' && config.model ? config.model : d.model;
  session.meta = {
    ...(session.meta || {}),
    agent: 'claude',
    machineName: computer,
    model,
    effort: typeof config.effort === 'string' && config.effort ? config.effort : d.effort,
    permission: PERMISSIONS.includes(config.permission) ? config.permission : d.permission,
    planMode: typeof config.planMode === 'boolean' ? config.planMode : d.planMode,
    queue: [],
    todos: [],
    ...(repo ? { repo: { ...repo, url: `https://github.com/${repo.full}/tree/${repo.branch}` } } : {}),
  };
  // A new continuation node inherits the conversation's subagent default
  // from the Hub's node metadata (passed in config).
  if (Object.prototype.hasOwnProperty.call(config, 'subagent')) {
    const sub = config.subagent == null ? null : await validateSubagent(config.subagent);
    if (sub) session.meta.subagent = sub;
    else delete session.meta.subagent;
  }
  // A continuation's history goes into the API messages, not into the
  // visible events: there is no fake user message to show or to resend.
  const handoff = handoffOf(config.handoff, config.handoffFrom);
  if (handoff) {
    c.messages.push({ role: 'user', content: [{ type: 'text', text: handoff.text }] });
    c.handoff = { from: handoff.from || null, model: handoff.model || null, fromCwd: handoff.fromCwd || null, at: handoff.at, chars: handoff.text.length, omitted: handoff.omitted };
  }
  store.saveSession(session);
  refreshModels(session, true);
  if (handoff) {
    const from = handoff.from ? `（${handoff.from}${handoff.model ? ` · ${handoff.model}` : ''}）` : '';
    liveContext?.(session)?.emit({
      type: 'info',
      text: `已接續先前對話${from}：這是前段歷史，不是新的使用者要求。`,
      handoff: { from: handoff.from || null, model: handoff.model || null, fromCwd: handoff.fromCwd || null, at: handoff.at, chars: handoff.text.length, omitted: handoff.omitted },
    });
  }
}

async function projectNotes(host, cwd) {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const text = (await host.read(cwd, file)).buf.toString('utf8').trim();
      if (text) return { file, text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut; Read the file for the rest)` : text };
    } catch {}
  }
  return null;
}

function systemPrompt(cwd, { platform, notes, git, computer, repo, started = Date.now() }) {
  return [
    'You are Claude, working as a coding agent for the user through Agent Hub, a control center they open in a browser or on their phone. You act on their computer only through your tools, which run in the working directory below.',
    '',
    '# Environment',
    `- Working directory: ${cwd}`,
    `- Computer: ${computer} (${platform}); shell: bash`,
    `- This conversation started on ${new Date(started).toISOString().slice(0, 10)}.`,
    git ? '- The working directory is a git repository.' : '- The working directory is not a git repository.',
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
    "- When the user asks for other conversations or agents they can watch (a second opinion, an adversarial reviewer or opponent, a parallel job), start them with StartConversation and follow them with ReadConversation and MessageConversation. Never start Claude Code (the `claude` command) or another AI tool from Bash: those are not part of Agent Hub, the user cannot see them, and they are billed elsewhere.",
    '- For GitHub (cloning, branches, pushing, pull requests, issues, Actions), use git and the GitHub CLI (gh) through Bash. The user signs this computer in to GitHub from Agent Hub (⋯ → GitHub…); if `gh auth status` shows it is not signed in or gh is missing, ask them to do that there. Never ask for a token in the chat, run `gh auth login`, or print a token. Unless the user asked for it, ask before anything that changes GitHub (push, opening, merging or closing a pull request or issue, commenting); work on a new branch rather than the default one, and never force-push unless told to.',
    '- Write to the user in the language they write to you in. Be concise and use Markdown. When you finish, say what you changed and what they should check.',
    '',
    '# Plan mode',
    'When a note says plan mode is on, change nothing: read and research only (Write, Edit and Bash are refused), then call ExitPlanMode with your plan. Once the user approves it, plan mode is off and you carry it out.',
    repo ? `\n${repoBind.promptSection(repo)}` : '',
    notes ? `\n# Project instructions\nThe working directory has instructions for agents in ${notes.file}. Follow them:\n\n${notes.text}` : '',
  ]
    .join('\n')
    .trim();
}

function subSystemPrompt(cwd, platform = os.platform(), repo = null) {
  return [
    `You are a subagent of Claude, doing one self-contained task in the working directory ${cwd} (${platform}, bash).`,
    'The main agent gave you a brief and sees only your final message, so end with a complete report of what you found or did: paths, names, commands, results.',
    "You can read and search files, run commands with Bash and edit files; some calls wait for the user's approval, and a rejected call should not be retried unchanged. Do only what the brief asks.",
    repo ? `The working directory is a clone of the GitHub repository ${repo.full} on the branch ${repo.branch}. Do not commit, push or switch branches: the main agent does that.` : '',
  ]
    .filter(Boolean)
    .join('\n');
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
    // The conversation's subagent default as it was when this turn started.
    // Changing it later in the turn affects the next turn, not this one.
    this.subagentDefault = isPlainObject(session.meta?.subagent) ? { ...session.meta.subagent } : null;
    this.broker = new Map(); // request id -> resolve(result | null), with .parentEventId
    this.brokerAcks = new Map(); // request id -> () => the Hub is alive (restarts the silence timer)
    this.subagents = new Map(); // tool event id -> { provider, model, effort, childSessionId, status }
  }

  get aborted() {
    return this.ac.signal.aborted;
  }
}

// Resolves to { ok, promptId } once the message is on its way: a new turn,
// or (while Claude works) the queue — `steer` (插隊) has Claude read it at
// its next step instead of after the turn.
export async function send(session, text, { images = [], note, steer } = {}) {
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const promptId = `p_${crypto.randomBytes(6).toString('hex')}`;
  const thumbs = images.map((i) => i.thumb || `data:${i.mimeType};base64,${i.data}`);
  if (runs.has(session.id)) {
    if (images.length) queuedImages.set(session, promptId, images);
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
  const images = queuedImages.get(session, q.promptId) || [];
  queuedImages.delete(session, q.promptId);
  startTurn(session, { text: q.text, images, thumbs: q.images, note: q.note, promptId: q.promptId });
}

const imageBlock = (i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } });

// `resume`: no message of the user's; the turn the hub was in when it
// stopped goes on (see restore()).
async function turn(run, { text, images = [], thumbs, note, promptId, resume }) {
  const { session, ctx } = run;
  const c = st(session);
  repair(c);
  const userEv = resume
    ? ctx.emit({ type: 'info', text: '中控台重新啟動了：Claude 接著剛才被中斷的工作繼續' })
    : ctx.emit({ type: 'user', text, images: thumbs || [], promptId, source: 'hub', ...(note ? { note } : {}) });
  c.turns = [...c.turns, { msg: c.messages.length, event: userEv.id, toldPlan: c.toldPlan ?? null }].slice(-50);
  // The title: what was said, without the files attached to it.
  if (!session.titled && !resume) ctx.setTitle(text.replace(/<file name="[^"]*">[\s\S]*?<\/file>/g, '').replace(/\n*\[附件\][\s\S]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 80) || '新對話');
  // Kept until the turn ends, so a restart in between knows to go on.
  c.active = { since: Date.now() };
  ctx.setStatus('running');
  store.saveSession(session, { immediate: true });
  // The model and thinking are fixed for the whole turn (a change made
  // during it applies from the next one), which also keeps the cache warm.
  const model = session.meta?.model || account.DEFAULT_MODEL;
  const effort = session.meta?.effort || '';
  ctx.setMeta({ turnModel: model, turnEffort: effort, turnSubagent: run.subagentDefault });
  refreshModels(session);

  const content = resume ? [] : [...images.map(imageBlock), { type: 'text', text: text || '（圖片）' }];
  // After a restart, the next turn (going on by itself, or the user's own
  // message) first says what happened.
  if (c.restarted) {
    content.unshift({ type: 'text', text: `<system-reminder>${RESTART_NOTE}</system-reminder>` });
    c.restarted = false;
  }
  // Bound to a repository since the last turn: said once, here (the system
  // prompt, rewritten then, keeps saying it).
  if (c.bindNote) {
    content.unshift({ type: 'text', text: `<system-reminder>${c.bindNote}</system-reminder>` });
    c.bindNote = null;
  }
  // Other messages slipped in (插隊) that are still waiting come with it.
  if (!resume) content.push(...takeSteered(run));
  if (!content.length) content.push({ type: 'text', text: 'Continue.' });
  const note2 = planNote(session, c);
  const sysNote = note2 && account.supportsSystemMessages(model) ? { role: 'system', content: note2 } : null;
  if (note2 && !sysNote) content.push({ type: 'text', text: `<system-reminder>${note2}</system-reminder>` });
  c.messages.push({ role: 'user', content });
  if (sysNote) c.messages.push(sysNote);

  let error = null;
  try {
    const opts = { messages: c.messages, model, effort, main: true, system: c.system, tools: mainTools(session, model) };
    let r = await loop(run, opts);
    const ended = (x) => !x.aborted && !x.halted && !x.budget && !run.aborted && !run.halted;
    // Messages slipped in (插隊) while Claude wrote its last answer had no
    // next step to go into: all of them are read now, in this turn.
    for (let blocks; ended(r) && (blocks = takeSteered(run)).length; ) {
      c.messages.push({ role: 'user', content: blocks });
      r = await loop(run, opts);
    }
    // Bound to a repository: nothing may stay behind uncommitted or unpushed.
    // Claude is told (twice at most), then Agent Hub saves it itself.
    const repo = session.meta?.repo;
    const finished = (x) => ended(x) && !session.meta?.planMode;
    if (repo && finished(r)) {
      let left = await repoBind.check(hostFor(session), session.cwd, repo);
      for (let i = 0; left && i < 2 && finished(r); i++) {
        ctx.emit({ type: 'info', text: `Agent Hub 檢查：${left.zh}，提醒 Claude commit 並 push 到 ${repo.branch}` });
        c.messages.push({ role: 'user', content: [{ type: 'text', text: `<system-reminder>${left.en}</system-reminder>` }] });
        r = await loop(run, opts);
        left = finished(r) ? await repoBind.check(hostFor(session), session.cwd, repo) : null;
      }
      if (left && finished(r)) {
        const saved = await repoBind.autoSave(hostFor(session), session.cwd, repo, left);
        ctx.emit({ type: saved.ok ? 'info' : 'error', text: saved.text });
      }
    }
    error = run.halted || null;
  } catch (err) {
    if (run.halted) error = run.halted;
    else if (!run.aborted) {
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
  st(session).active = null;
  for (const ev of session.events.slice(run.firstEvent)) {
    if (ev.permission && !ev.permission.chosen) ctx.patch(ev, { permission: { ...ev.permission, chosen: 'cancelled' } });
    if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) ctx.patch(ev, { status: run.aborted || ev.status === 'awaiting' ? 'interrupted' : 'ended' });
    if (ev.subagent?.status === 'running') ctx.patch(ev, { subagent: { ...ev.subagent, status: run.aborted ? 'cancelled' : 'error' } });
  }
  const models = [...(run.models || new Map())].map(([id, name]) => ({ id, name }));
  const subagents = [...(run.subagents || new Map()).values()].map((x) => ({ ...x }));
  ctx.emit({ type: 'turn_end', durationMs: Date.now() - run.started, usage: { ...run.usage }, models, subagents, interrupted: run.aborted && !run.halted, error: Boolean(error) });
  ctx.setMeta({ turnModel: null, turnEffort: null, turnSubagent: null });
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
    // Only the model that was chosen may go on. An answer from any other
    // (Anthropic routing the request elsewhere) or a refusal stops the whole
    // turn, subagents included, before anything it asked for runs. Neither
    // is kept in the history.
    const served = msg.model || opts.model;
    noteServed(run, opts, served);
    const swapped = !served.startsWith(opts.model);
    if (swapped || msg.stop_reason === 'refusal') {
      const d = msg.stop_details || {};
      for (const ev of r.byId.values()) ctx.patch(ev, { status: 'ended' });
      const who = opts.main ? '' : '子代理：';
      const text = swapped
        ? `${who}這一步是由 ${modelName(served)}（${served}）回覆的，不是你選的 ${modelName(opts.model)}——可能被 Anthropic 降級或改由其他模型接手。為了不在你不知道的情況下用別的模型繼續，已停止這一輪，它要求的工具都沒有執行。要繼續請再送出訊息（或先換模型）。`
        : `${who}${modelName(opts.model)} 拒絕了這個請求${d.category ? `（安全分類：${d.category}）` : ''}，已停止這一輪。${d.explanation || ''}`.trim();
      ctx.emit({ type: 'error', text, model: served, ...where });
      halt(run, text);
      return { finalText, halted: true };
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
    const images = queuedImages.get(session, q.promptId) || [];
    queuedImages.delete(session, q.promptId);
    blocks.push(...images.map(imageBlock), { type: 'text', text: `The user sent this while you were working:\n${q.text || '(images)'}` });
  }
  return blocks;
}

// The model Anthropic says produced a response, shown as it comes: next to
// the composer (the conversation's own), on a subagent's card, and with
// the turn when it ends.
function noteServed(run, opts, served) {
  const name = modelName(served);
  (run.models ??= new Map()).set(served, name);
  if (opts.quiet) return;
  if (opts.main) return run.ctx.setMeta({ servedModel: { id: served, name, asked: opts.model, at: Date.now() } });
  const card = opts.scope?.parent && run.session.events.find((e) => e.id === opts.scope.parent);
  if (card?.subagent) run.ctx.patch(card, { subagent: { ...card.subagent, served, servedAt: Date.now(), ...contractOf(card.subagent.requested ?? null, { provider: 'claude', model: served, effort: opts.effort || '' }) } });
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
  // No server-side fallback: a request the chosen model declines stops
  // rather than going on with another model (see loop()).
  const betas = [];
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
  if (kind === 'agent') {
    let choice;
    try {
      choice = await resolveSubagent(session, run, u.input);
    } catch (err) {
      const text = err.message || String(err);
      ctx.patch(ev, { status: 'error', isError: true, output: text, subagent: { provider: textField(u.input?.provider, 20) || null, model: textField(u.input?.model, 100) || null, effort: textField(u.input?.effort, 20) || null, status: 'error', error: text, ...contractOf(askedOf(textField(u.input?.provider, 20) || null, textField(u.input?.model, 100) || '', textField(u.input?.effort, 20)), null, `子代理沒有啟動：${text}`) } });
      return { content: `子代理沒有啟動：${text}`, isError: true };
    }
    const rec = noteSubagent(run, ev, choice);
    return choice.provider === 'claude' ? subagent(run, ev, u.input, choice, rec) : brokerSubagent(run, ev, u.input, choice, rec);
  }
  if ((kind === 'edit' || kind === 'exec') && session.meta?.planMode) {
    st(session).toldPlan = true;
    ctx.patch(ev, { status: 'denied', output: '計畫模式中：還不能修改或執行' });
    return { content: 'Plan mode is on, so nothing can be changed or run yet. Keep researching with Read, Grep and Glob, then present your plan with ExitPlanMode.', isError: true };
  }
  if (u.name === 'Bash' && startsAiCli(u.input.command)) {
    ctx.patch(ev, { status: 'denied', output: 'Agent Hub 拒絕：Claude API 對話不能啟動 Claude Code 或其他 AI 工具' });
    return {
      content:
        'Refused by Agent Hub: this conversation runs on the Claude API with the user\'s Console API key and must not start Claude Code (the `claude` command) or other AI command-line tools: the user cannot see those sessions in Agent Hub, and they are billed to another account. To run another Claude conversation the user can watch, use StartConversation; for a self-contained subtask, use Task.',
      isError: true,
    };
  }
  const repo = session.meta?.repo;
  const refused = repo && u.name === 'Bash' && repoBind.guard(u.input.command, repo);
  if (refused) {
    ctx.patch(ev, { status: 'denied', output: `Agent Hub 拒絕：這個對話綁定 ${repo.full} 的 ${repo.branch}` });
    return { content: `Refused by Agent Hub: ${refused}. This conversation is bound to ${repo.full}, branch ${repo.branch}; push your commits there with \`git push -u origin ${repo.branch}\`, and never force-push.`, isError: true };
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
  if (CONVERSATION_TOOLS.has(u.name)) return conversationTool(run, ev, u);
  ctx.patch(ev, { status: 'running', output: '' });
  // A long command's output streams onto its card, a few times a second.
  let pending = '';
  let timer = null;
  const r = await execute(u.name, u.input, {
    host: hostFor(session),
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

// Claude Code (or another AI CLI) started from a Bash command: `claude …`,
// `npx @anthropic-ai/claude-code`, also behind sudo, nohup, env, timeout or
// inside quotes (tmux, sh -c).
const AI_CLIS = new Set(['claude', 'claude-code']);
function startsAiCli(command) {
  const text = String(command || '');
  if (/@anthropic-ai\/claude-code\b/.test(text)) return true;
  for (const part of text.split(/&&|\|\||[;|\n&()`]|\$\(/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']+|["']+$/g, ''));
    for (let i = 0; i < words.length; i++) {
      const base = words[i].split('/').pop();
      if (!AI_CLIS.has(base)) continue;
      // The command itself (after VAR=…, sudo, nohup…), or followed by its flags.
      const before = words.slice(0, i).every((w) => /^\w+=/.test(w) || ['sudo', 'nohup', 'exec', 'env', 'time', 'command', 'setsid', 'nice', 'stdbuf', 'timeout'].includes(w) || /^-|^\d+[smh]?$/.test(w));
      if (before || /^-/.test(words[i + 1] || '') || i === words.length - 1) return true;
    }
  }
  return false;
}

// ------------------------------------------- conversations of their own
// Claude can start other conversations in Agent Hub (StartConversation):
// shown in the sidebar like any other, run by this daemon on the same key.
// It can only read and message the ones it started.
const CONVERSATION_TOOLS = new Set(['StartConversation', 'MessageConversation', 'ReadConversation']);

function childOf(session, id) {
  const s = store.getSession(String(id || ''));
  if (!s || s.meta?.parent?.id !== session.id) throw new Error(`No conversation ${id} started by this one. Use the id StartConversation returned.`);
  return s;
}

const STATUS_EN = { running: 'working', awaiting_permission: "waiting for the user's approval or answer (in that conversation)", idle: 'idle (its turn is over)', error: 'stopped on an error' };

async function conversationTool(run, ev, u) {
  const { session, ctx } = run;
  const input = u.input;
  ctx.patch(ev, { status: 'running', output: '' });
  try {
    let text;
    if (u.name === 'StartConversation') {
      const folder = input.folder === 'new' ? path.join(store.WORKSPACES_DIR, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`) : session.cwd;
      if (input.folder === 'new') fs.mkdirSync(folder, { recursive: true });
      const s = store.createSession({ agentId: 'claude', cwd: folder, permissionMode: session.permissionMode, title: String(input.title).slice(0, 120), origin: 'external' });
      s.titled = true;
      await setup(s, { model: input.model || session.meta?.model, effort: input.effort || session.meta?.effort, permission: session.meta?.permission, computer: session.meta?.machineName });
      liveContext(s).setMeta({ parent: { id: session.id, title: session.title } });
      await send(s, input.prompt, { note: `由「${session.title}」開啟` });
      ctx.patch(ev, { conversation: { id: s.id, title: s.title } });
      text = `Started the conversation "${s.title}" (id ${s.id}, model ${s.meta.model}${s.meta.effort ? `, effort ${s.meta.effort}` : ''}) in ${folder}. It is working on your prompt and shows in the user's sidebar. Read its answer with ReadConversation (wait: true).`;
    } else if (u.name === 'MessageConversation') {
      const s = childOf(session, input.id);
      const r = await send(s, input.text, { note: `由「${session.title}」送出` });
      text = r.queued ? `Queued: "${s.title}" is working; it reads this when its current turn ends.` : `Sent to "${s.title}"; it is working on it.`;
    } else {
      const s = childOf(session, input.id);
      if (input.wait) {
        const until = Date.now() + 30 * 60_000;
        while (runs.has(s.id) && s.status !== 'awaiting_permission' && !run.aborted && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
        if (run.aborted) return interrupted(run, ev);
      }
      const n = Math.min(Math.max(Number(input.replies) || 1, 1), 10);
      const replies = [];
      let cur = '';
      for (const e of s.events) {
        if (e.type === 'user' && !e.steered) cur = '';
        else if (e.type === 'text' && !e.parent && e.text?.trim()) cur = e.text;
        else if (e.type === 'turn_end' && cur) replies.push(cur);
      }
      if (runs.has(s.id) && cur) replies.push(`${cur}\n(…still working)`);
      const last = replies.slice(-n).map((t) => (t.length > 20_000 ? `${t.slice(0, 20_000)}\n… (cut)` : t));
      text = [
        `"${s.title}" (id ${s.id}) is ${STATUS_EN[runs.has(s.id) ? (s.status === 'awaiting_permission' ? 'awaiting_permission' : 'running') : s.status] || s.status}. Cost so far: US$${fmtUsd(s.usage?.costUsd || 0)}.`,
        last.length ? `Its last ${last.length === 1 ? 'reply' : `${last.length} replies`}:\n\n${last.join('\n\n---\n\n')}` : 'No reply yet.',
      ].join('\n\n');
    }
    ctx.patch(ev, { status: 'done', output: text });
    return { content: text, isError: false };
  } catch (err) {
    ctx.patch(ev, { status: 'error', isError: true, output: err.message });
    return { content: err.message, isError: true };
  }
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

function noteSubagent(run, ev, choice) {
  const rec = { toolEventId: ev.id, provider: choice.provider, model: choice.model, effort: choice.effort || '', childSessionId: null, status: 'running' };
  run.subagents.set(ev.id, rec);
  return rec;
}

async function subagent(run, ev, input, { model, effort }, rec) {
  const { session, ctx } = run;
  const id = `sub-${++run.subs}-${crypto.randomBytes(3).toString('hex')}`;
  const sub = { id, name: 'subagent', description: input.description, provider: 'claude', status: 'running', model, effort, ...contractOf(askedOf('claude', model, effort), null, '還在等 Claude 第一次回覆，確認實際模型') };
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
      ctx.patch(ev, { subagent: { ...ev.subagent, status: 'cancelled' } });
      if (rec) rec.status = 'cancelled';
      return interrupted(run, ev);
    }
    const text = account.explain(err);
    ctx.patch(ev, { status: 'error', isError: true, output: text, subagent: { ...ev.subagent, status: 'error', error: text } });
    if (rec) rec.status = 'error';
    return { content: `The subagent failed: ${text}`, isError: true };
  }
  if (out.halted) {
    ctx.patch(ev, { status: 'error', subagent: { ...ev.subagent, status: 'error', error: run.halted } });
    if (rec) rec.status = 'error';
    return { content: 'Stopped.', isError: true };
  }
  if (out.aborted) {
    ctx.patch(ev, { subagent: { ...ev.subagent, status: 'cancelled' } });
    if (rec) rec.status = 'cancelled';
    return interrupted(run, ev);
  }
  const summary = out.finalText.trim();
  ctx.patch(ev, { status: 'done', output: summary, subagent: { ...ev.subagent, status: 'done', summary } });
  if (rec) rec.status = 'done';
  return { content: summary || '(The subagent finished without a report.)', isError: false };
}

// A Task on another provider: the Claude daemon asks the Hub's broker to run
// it in a child conversation of its own runtime, and waits for its answer.
// The request goes out as a visible info event (no token, no key); the Hub
// answers with a brokerResult call. Nothing here can fall back to Claude.
async function brokerSubagent(run, ev, input, choice, rec) {
  const { ctx } = run;
  const requestId = `b_${crypto.randomBytes(6).toString('hex')}`;
  ctx.patch(ev, {
    status: 'running',
    title: input.description,
    subagent: { name: 'subagent', description: input.description, provider: choice.provider, model: choice.model, effort: choice.effort || '', status: 'running', ...contractOf(askedOf(choice.provider, choice.model, choice.effort), null, '還在等 Agent Hub 建立子對話並回報它實際用的模型') },
  });
  ctx.emit({
    type: 'info',
    text: `跨家子代理：${choice.provider} ${choice.model}${choice.effort ? ` · ${choice.effort}` : ''}（等待 Agent Hub broker）`,
    broker: { kind: 'delegate', requestId, provider: choice.provider, model: choice.model, effort: choice.effort || '', parentEventId: ev.id },
  });
  const started = Date.now();
  const result = await new Promise((resolve) => {
    let timer;
    const fail = (error) => {
      clearTimeout(timer);
      run.broker.delete(requestId);
      run.brokerAcks.delete(requestId);
      // The Hub may still be running a child for this request: tell it to stop.
      ctx.emit({ type: 'info', text: '已通知 Agent Hub 取消這個跨家子代理', broker: { kind: 'cancel', requestId, parentEventId: ev.id, reason: 'timeout' } });
      resolve({ error });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(`Agent Hub 在 ${Math.round(BROKER_TIMEOUT_MS / 1000)} 秒內沒有回應（Hub 可能離線，或 broker 尚未接上）。這次跨家子代理沒有執行，也沒有改用 Claude 子代理。`),
        BROKER_TIMEOUT_MS,
      );
    };
    arm();
    // Every sign of life restarts the silence timer, up to the hard cap.
    run.brokerAcks.set(requestId, () => {
      if (Date.now() - started > BROKER_MAX_MS) return fail(`這個跨家子代理已經跑了超過 ${Math.round(BROKER_MAX_MS / 60_000)} 分鐘，先停止等待；沒有改用 Claude 子代理。`);
      arm();
    });
    const answer = (r) => {
      clearTimeout(timer);
      run.broker.delete(requestId);
      run.brokerAcks.delete(requestId);
      resolve(r);
    };
    answer.parentEventId = ev.id;
    run.broker.set(requestId, answer);
  });
  if (result === null) {
    ctx.patch(ev, { subagent: { ...ev.subagent, status: 'cancelled' } });
    if (rec) rec.status = 'cancelled';
    return interrupted(run, ev);
  }
  const r = brokerResultOf(result);
  if (!r.error && (!r.provider || !r.model)) r.error = 'Agent Hub broker 沒有回報實際的子代理模型，這次結果不採用';
  if (!r.error && (r.provider !== choice.provider || r.model !== choice.model)) r.error = `Agent Hub broker 回報的 ${r.provider} ${r.model} 與要求的 ${choice.provider} ${choice.model} 不同，這次結果不採用`;
  // An effort the Task asked for must be the effort the child really ran
  // with. A missing or different one is a failure; only an empty choice
  // (the model's default) accepts and shows whatever the broker reports.
  if (!r.error && choice.effort && r.effort !== choice.effort) {
    r.error = r.effort
      ? `Agent Hub broker 回報的思考強度 ${r.effort} 與要求的 ${choice.effort} 不同，這次結果不採用`
      : `Agent Hub broker 沒有回報實際的思考強度（要求 ${choice.effort}），這次結果不採用`;
  }
  const sub = {
    ...ev.subagent,
    id: r.childSessionId || ev.subagent?.id || null,
    provider: r.provider || choice.provider,
    model: r.model || choice.model,
    // On a failure, never show the requested effort as the one that ran.
    effort: r.error ? r.effort || '' : r.effort || choice.effort || '',
    ...(r.error && choice.effort ? { requestedEffort: choice.effort } : {}),
    childSessionId: r.childSessionId || null,
    status: r.error ? 'error' : 'done',
    ...(r.error ? { error: r.error } : {}),
    // Only a child that exists and reported what it runs on has an actual;
    // when that differs from the request, both are shown (and it is an error).
    ...contractOf(ev.subagent?.requested ?? askedOf(choice.provider, choice.model, choice.effort), r.childSessionId && r.provider && r.model ? { provider: r.provider, model: r.model, effort: r.effort } : null, `沒有子對話回報實際用的模型：${r.error || '（沒有說明）'}`),
  };
  if (rec) Object.assign(rec, { provider: sub.provider, model: sub.model, effort: sub.effort, childSessionId: sub.childSessionId, status: sub.status });
  if (r.error) {
    ctx.patch(ev, { status: 'error', isError: true, output: r.error, subagent: sub });
    return { content: `跨家子代理（${choice.provider} ${choice.model}）失敗：${r.error}`, isError: true };
  }
  const text = r.text.trim();
  ctx.patch(ev, { status: 'done', output: text, ...(r.childSessionId ? { childSessionId: r.childSessionId } : {}), subagent: { ...sub, summary: text } });
  return { content: text || '(The subagent finished without a report.)', isError: false };
}

// ------------------------------------------------------------- controls

export async function interrupt(session) {
  const run = runs.get(session.id);
  if (!run) return;
  run.ac.abort();
  for (const resolve of [...run.waits.values()]) resolve(null);
  cancelBrokers(run, '使用者停止');
}

// The Hub has the request and is working on it (and says so again from time
// to time): the wait is for the child, not for a Hub that may be gone.
export function brokerAck(session, requestId) {
  const run = runs.get(session.id);
  const ack = run?.brokerAcks.get(String(requestId || ''));
  if (!ack) return false;
  ack();
  return true;
}

// The Hub's answer to a cross-provider Task. Only the request that is still
// waiting is answered; a late answer after a timeout is ignored.
export function brokerResult(session, requestId, result) {
  const run = runs.get(session.id);
  const resolve = run?.broker.get(String(requestId || ''));
  if (!resolve) return false;
  resolve(result || {});
  return true;
}

// /steer: every message still waiting goes in at the next step.
export function steerAll(session) {
  const waiting = queue(session).filter((q) => !q.steered);
  if (waiting.length) liveContext(session).setMeta({ queue: queue(session).map((x) => ({ ...x, steered: true })) });
  return { count: waiting.length };
}

export function steerQueued(session, promptId) {
  const q = queue(session).find((x) => x.promptId === promptId);
  if (!q || q.steered) return;
  liveContext(session).setMeta({ queue: queue(session).map((x) => (x.promptId === promptId ? { ...x, steered: true } : x)) });
}

export function cancelQueued(session, promptId) {
  queuedImages.delete(session, promptId);
  liveContext(session).setMeta({ queue: queue(session).filter((x) => x.promptId !== promptId) });
}

// Model, thinking, permission and plan mode. A model or thinking change
// made while Claude works applies from the next turn.
export async function configure(session, change = {}) {
  const { model, effort, permission, planMode, subagent } = change || {};
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
  if ('subagent' in (change || {})) f.subagent = subagent == null ? null : await validateSubagent(subagent);
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
        ...(session.machineId ? { machineId: session.machineId } : {}),
        permissionMode: session.permissionMode,
        title: args || `${session.title}（複製）`,
        titled: true,
        origin: originOf(session),
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
  const why = cannotSend(session);
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

// --- files and changes panels for a conversation on a connected computer

// An existing conversation bound to a GitHub repository, for good. A folder
// that is already a clone of it stays (on `branch`); any other folder is
// left as it is and the conversation moves to a new clone, Claude being told
// to bring over what belongs in it. The system prompt is rewritten with the
// binding (once: the next request reads the conversation again, uncached).
export async function bindRepo(session, { full, branch }) {
  if (runs.has(session.id)) throw Object.assign(new Error('Claude 正在工作：等這一輪結束（或先停止）再綁定'), { status: 409 });
  if (session.meta?.repo) throw Object.assign(new Error(`這個對話已經綁定 ${session.meta.repo.full} 的 ${session.meta.repo.branch}，不能再換`), { status: 409 });
  const host = hostFor(session);
  const c = st(session);
  const old = session.cwd;
  const origin = await host.run(old, 'git config --get remote.origin.url', { timeoutMs: 15_000 }).catch(() => null);
  const same = origin?.exitCode === 0 && repoBind.parseRepo(origin.output.trim())?.toLowerCase() === full.toLowerCase();
  if (same) await repoBind.useBranch(host, old, { full, branch });
  else session.cwd = await repoBind.clone(host, store.WORKSPACES_DIR, { full, branch });
  const repo = { full, branch };
  const platform = session.machineId ? machines.getMachine(session.machineId)?.platform || 'unknown' : `${os.platform()} ${os.release()}`;
  const notes = await projectNotes(host, session.cwd);
  const computer = session.meta?.machineName || machineName(session);
  c.system = systemPrompt(session.cwd, { platform, notes, git: true, computer, repo, started: session.createdAt });
  c.subSystem = subSystemPrompt(session.cwd, platform, repo);
  c.bindNote = same
    ? `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. The working directory ${old} is already a clone of it and is now on \`${branch}\`. Follow the rules in the system prompt: commit what you have done so far that belongs to the task, push it to \`${branch}\`, and keep doing so.`
    : `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. It was cloned into ${session.cwd}, which is your working directory from now on (it was ${old}, which is unchanged; your earlier work is still there). First bring over into the repository what belongs to the user's task from ${old} (code, docs, configs; not secrets, data dumps, build output or tool caches), commit it with a clear message and push it to \`${branch}\`; tell the user briefly what you brought over and what you left out. Then follow the rules in the system prompt.`;
  liveContext(session).setMeta({ repo: { ...repo, url: `https://github.com/${full}/tree/${branch}` } });
  liveContext(session).emit({
    type: 'info',
    text: same
      ? `已綁定 ${full} 的 ${branch}：資料夾本來就是這個 repo，已切到 ${branch}。之後的程式碼都會 commit 並 push 到那裡。`
      : `已綁定 ${full} 的 ${branch}：repo clone 到 ${session.cwd}，這個對話之後在那裡工作（原本的資料夾 ${old} 保持不動）。下一輪 Claude 會先把屬於這個專案的檔案搬進 repo，commit 並 push。`,
  });
  store.saveSession(session, { immediate: true });
  return { cwd: session.cwd, moved: !same };
}

export async function listFiles(session, rel = '.') {
  const host = hostFor(session);
  const { files } = await host.walk(session.cwd, rel, 2000);
  const base = rel === '.' ? '' : `${rel.replace(/\/$/, '')}/`;
  const seen = new Map();
  for (const [r] of files) {
    const [first, ...more] = r.split('/');
    if (!seen.has(first)) seen.set(first, { name: first, path: `${base}${first}`, dir: more.length > 0 });
  }
  return [...seen.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function readFile(session, rel) {
  const f = await hostFor(session).read(session.cwd, rel);
  if (f.size > 2 * 1024 * 1024) return { path: rel, size: f.size, tooLarge: true };
  const binary = f.buf.subarray(0, 8000).includes(0);
  return { path: rel, size: f.size, binary, content: binary ? '' : f.buf.toString('utf8') };
}

export async function getChanges(session, summarize) {
  const host = hostFor(session);
  const r = await host.run(
    session.cwd,
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo __NOGIT__; exit 0; }; git diff HEAD --no-color --no-ext-diff 2>/dev/null; git ls-files --others --exclude-standard -z | head -z -n 100 | xargs -0 -r -I{} git diff --no-color --no-index -- /dev/null {}; exit 0',
    { timeoutMs: 60_000 },
  );
  if (r.output.includes('__NOGIT__')) return { git: false, files: [], diff: '' };
  const diff = r.output === '(no output)' ? '' : `${r.output.replace(/\n\[[^\]]*\]$/, '')}\n`;
  return { git: true, files: summarize(diff), diff };
}

// At startup: what was in progress when the hub stopped is over — and the
// turn it was in goes on by itself (Claude is told the hub restarted), with
// the messages that were waiting for it after.
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
  if (meta.turnModel || meta.turnEffort) {
    meta.turnModel = null;
    meta.turnEffort = null;
    changed = true;
  }
  const c = st(session);
  const wasWorking = Boolean(c.active);
  if (wasWorking) {
    c.active = null;
    c.restarted = true;
    session.events.push({ id: store.newId('e_'), ts: Date.now(), type: 'turn_end', durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, interrupted: true, restarted: true });
    changed = true;
  }
  if (changed) store.saveSession(session);
  if (wasWorking || meta.queue?.length) resumeLater(session, wasWorking);
}

// Once Claude can be reached (a key, its computer online), and only if
// nobody has started anything in the conversation meanwhile.
function resumeLater(session, wasWorking, tries = 0) {
  const t = setTimeout(() => {
    if (store.getSession(session.id) !== session || runs.has(session.id)) return;
    if (cannotSend(session)) {
      if (tries < 120) resumeLater(session, wasWorking, tries + 1);
      else if (queue(session).length) liveContext(session).emit({ type: 'info', text: '中控台重新啟動後一直沒辦法接著做（電腦離線或沒有 API key），排隊中的訊息還在，可以自己送出「繼續」' });
      return;
    }
    if (wasWorking && st(session).restarted) startTurn(session, { resume: true });
    else next(session);
  }, tries ? 5000 : 1500);
  t.unref?.();
}

export function dispose(session) {
  for (const q of queue(session)) queuedImages.delete(session, q.promptId);
  interrupt(session);
  modelsAt.delete(session.id);
}
