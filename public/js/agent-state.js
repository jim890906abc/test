// What a subagent card may claim, kept free of the DOM so the rules can be
// tested directly in node. The conversation card and the 子代理 panel both
// read these two functions; neither works out a status or a model on its own.
//
// Two rules the card must not break:
//  1. A spinner is "someone is working", so it needs evidence that someone is.
//     A stored `running` is a claim, not evidence: a restart, a lost final
//     frame or a tool call that already ended all leave it behind.
//  2. The model is what the runtime reported. What was asked for is a second,
//     separate fact. The conversation's current setting is never used to fill
//     in either of them.
import { busy, modelWithProvider, PROVIDER_LABELS } from './providers.js';

// How long a live subagent may wait for its model report before the card says
// the model is unconfirmed, and how long an idle conversation's subagent may be
// silent before its spinner is dropped. Both can be changed per call (ctx.limits).
export const LIVENESS = { modelReportWaitMs: 60_000, silentMs: 60_000 };

const TOOL_ACTIVE = ['pending', 'running', 'awaiting'];
const SUB_RUNNING = ['running', 'pending'];
const SUB_FAILED = ['error', 'failed'];
const SUB_STOPPED = ['cancelled', 'stopped', 'suspended'];

export const LIFE_REASONS = {
  interrupted: '呼叫這個子代理的工具被中斷了（例如中控台重新啟動過），它沒有回報結果',
  'parent-error': '呼叫這個子代理的工具失敗了',
  'parent-ended': '呼叫這個子代理的工具已經結束，但它沒有回報最終狀態',
  'session-idle': '這個對話已經閒置，沒有它仍在工作的證據',
  silent: '這個對話已經閒置，而且它很久沒有任何新的活動',
  'child-idle': '它的子對話已經閒置，但卡片沒有收到最終狀態',
};

function life(state, reason = '') {
  return { state, running: state === 'running', failed: state === 'failed', stopped: state === 'stopped', unknown: state === 'unknown', done: state === 'done', reason, reasonText: LIFE_REASONS[reason] || '' };
}

// ctx: {
//   now,              ms clock (tests pass their own)
//   sessionStatus,    the conversation's status, when known (undefined = not known)
//   childStatus(id),  status of a broker child's own conversation, when the page has it
//   lastActivity,     ms of the subagent's newest event
//   limits,           overrides for LIVENESS
// }
export function agentLife(ev, ctx = {}) {
  const sub = ev?.subagent || {};
  const claimed = sub.status || '';
  const toolStatus = ev?.status || '';
  const limits = { ...LIVENESS, ...(ctx.limits || {}) };
  const now = ctx.now ?? Date.now();

  const claimsRunning = claimed ? SUB_RUNNING.includes(claimed) : TOOL_ACTIVE.includes(toolStatus);
  if (!claimsRunning) {
    if (claimed) {
      if (SUB_FAILED.includes(claimed)) return life('failed');
      if (!SUB_STOPPED.includes(claimed)) return life('done');
      // The Hub settles a card its restart cut to "cancelled" (store.js): the
      // subagent no longer claims to run, but the call that started it still
      // says it was interrupted, and that is the answer to "why did it stop?".
      // Said the same as for a stale "running" claim below; a subagent that
      // stopped while its call went on has nothing more to add.
      return toolStatus === 'interrupted' || toolStatus === 'cancelled' ? life('stopped', 'interrupted') : life('stopped');
    }
    return toolStatus === 'error' ? life('failed') : toolStatus === 'interrupted' || toolStatus === 'cancelled' ? life('stopped') : life('done');
  }

  // From here on the card only CLAIMS the subagent is running.
  const background = Boolean(sub.background || ev?.input?.run_in_background);
  const child = ev?.childSessionId || sub.childSessionId || '';
  const childStatus = child ? ctx.childStatus?.(child) : undefined;
  // A hub-run (broker) child is its own conversation: what became of the tool
  // call that waits for it says nothing about the child (spec §4.1), exactly
  // like a background subagent's.
  const detached = background || Boolean(child) || sub.broker === true;

  // A broker child is its own conversation. When the page has it, that is the
  // authority, whatever the card or the parent's tool call says.
  if (child && childStatus) return busy(childStatus) ? life('running') : life('unknown', 'child-idle');

  // The tool call that started a foreground subagent ended: it cannot still be
  // running behind it. (A background subagent outlives its tool call, and a
  // broker child is judged by its own conversation above.)
  if (!TOOL_ACTIVE.includes(toolStatus) && toolStatus && !detached) {
    if (toolStatus === 'interrupted' || toolStatus === 'cancelled') return life('stopped', 'interrupted');
    if (toolStatus === 'error') return life('failed', 'parent-error');
    return life('unknown', 'parent-ended');
  }

  const sessionKnown = ctx.sessionStatus !== undefined && ctx.sessionStatus !== null;
  const sessionIdle = sessionKnown && !busy(ctx.sessionStatus);
  if (sessionIdle) {
    // Idle and nothing says it lives on: a foreground subagent cannot outlive
    // the turn it blocks.
    if (!detached) return life('unknown', 'session-idle');
    // A background one (or a broker child we have no view of) may legitimately
    // go on while the conversation is idle, but not silently forever.
    const last = ctx.lastActivity ?? ev?.ts ?? now;
    if (now - last > limits.silentMs) return life('unknown', 'silent');
  }
  return life('running');
}

// ---------------------------------------------------------------- the model

const clean = (c) => {
  if (!c || typeof c !== 'object') return null;
  const out = { provider: typeof c.provider === 'string' ? c.provider : '', model: typeof c.model === 'string' ? c.model : '', effort: typeof c.effort === 'string' ? c.effort : '' };
  return out.provider || out.model || out.effort ? out : null;
};
const tail = (id) => String(id || '').split('/').pop().toLowerCase();

// The model a subagent card may show. `requested` is what the server recorded
// when the subagent was created; `actual` is what the runtime reported, or null
// when nothing was. A server that does not send the two fields yet still has
// the older flat fields (provider/model/effort on the subagent), which were
// always runtime reports.
export function subagentModelView(ev, lifeState, ctx = {}) {
  const sub = ev?.subagent || {};
  const providerLabel = ctx.providerLabel || ((p) => PROVIDER_LABELS[p] || p || '');
  const modelName = ctx.modelName || ((p, id) => String(id).split('/').pop());
  const effortLabel = ctx.effortLabel || ((e) => e);
  const now = ctx.now ?? Date.now();
  const limits = { ...LIVENESS, ...(ctx.limits || {}) };
  const fmt = (c) => [modelWithProvider(providerLabel(c.provider), c.model ? modelName(c.provider, c.model) : ''), c.effort ? `思考 ${effortLabel(c.effort)}` : ''].filter(Boolean).join(' · ');

  const requested = clean(sub.requested);
  let actual;
  if (Object.hasOwn(sub, 'actual')) actual = clean(sub.actual);
  else actual = clean({ provider: sub.provider, model: sub.served || sub.model, effort: sub.effort });
  const confirmed = Boolean(actual?.model);

  const mismatch = Boolean(
    confirmed &&
      requested &&
      ((requested.provider && actual.provider && requested.provider !== actual.provider) || (requested.model && tail(requested.model) !== tail(actual.model)) || (requested.effort && actual.effort && requested.effort !== actual.effort)),
  );

  const started = Number.isFinite(ev?.ts) ? ev.ts : now;
  const running = Boolean(lifeState?.running);
  const waiting = !confirmed && running && now - started < limits.modelReportWaitMs;
  const reason = confirmed ? '' : waiting ? '' : String(sub.unverifiedReason || '').trim() || (running ? '子代理執行了一段時間，仍沒有收到它實際使用的模型' : '沒有收到子代理實際使用的模型');

  const text = confirmed ? fmt(actual) : waiting ? '等待回報模型…' : '模型未確認';
  const requestedText = requested && (!confirmed || mismatch) ? `要求：${fmt(requested)}` : '';
  const title = confirmed
    ? `這個子代理實際使用：${fmt(actual)}（執行時回報）${mismatch ? `。與建立時的要求不同：${fmt(requested)}` : ''}`
    : waiting
      ? '子代理剛建立，還在等它回報實際使用的模型'
      : `${reason}${requested ? `。建立時的要求（不一定是實際值）：${fmt(requested)}` : ''}`;
  // `note` is only what the server said about why it could not confirm; the
  // generic reason is for the tooltip, so cards with nothing to add stay quiet.
  const note = confirmed || waiting ? '' : String(sub.unverifiedReason || '').trim();
  return { confirmed, waiting, mismatch, actual, requested, text, requestedText, reason, note, title };
}

// The word on a subagent's status badge (null while it spins).
export function lifeBadge(l) {
  if (l.running) return null;
  if (l.failed) return '失敗';
  if (l.stopped) return '已中斷';
  if (l.unknown) return '狀態未知';
  return '完成';
}
