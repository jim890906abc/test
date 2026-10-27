// Portable hand-off text for a runtime switch. It is built from the visible
// events of the whole continuation chain, never from a provider's private
// transcript, and is deterministic: no extra model is asked to summarize.
// The original events stay untouched; this module only projects them.
import * as store from './store.js';
import { redact } from './redact.js';

export const DEFAULT_MAX_CHARS = 48_000;
const TOOL_OUTPUT_CHARS = 400;
const TOOL_TITLE_CHARS = 240;

// The one secret filter (server/redact.js) is applied to every piece of text
// that goes into the hand-off, before it is clipped: a key cut in half by the
// clip must never survive as its first half.
export { redact };

export const providerName = (p) => ({ kimi: 'Kimi', claude: 'Claude', deepseek: 'DeepSeek' })[p] || p || '未知';

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// One readable block per visible event. Tool output is clipped and redacted;
// a cut output says so instead of pretending it was complete.
function block(ev) {
  if (ev.type === 'user') return ev.text ? `User: ${redact(ev.text)}` : null;
  if (ev.type === 'text') return ev.text?.trim() ? `Assistant: ${redact(ev.text.trim())}` : null;
  if (ev.type === 'thinking') return null;
  if (ev.type === 'tool_use') {
    const title = clip(redact(ev.title || ev.input?.command || ev.input?.path || ev.input?.description || ''), TOOL_TITLE_CHARS);
    let line = `[tool ${ev.name || 'tool'}]${title ? ` ${title}` : ''}${ev.status ? ` (${ev.status})` : ''}`;
    if (ev.isError) line += ' [error]';
    if (ev.output) {
      const out = redact(ev.output).trim();
      line += `\n  result: ${out.length > TOOL_OUTPUT_CHARS ? `${out.slice(0, TOOL_OUTPUT_CHARS)}… [output truncated]` : out}`;
    }
    if (ev.subagent?.model) line += `\n  subagent: ${providerName(ev.subagent.provider)} ${ev.subagent.model}${ev.subagent.effort ? ` / ${ev.subagent.effort}` : ''}`;
    return line;
  }
  if (ev.type === 'info' || ev.type === 'error') return `[${ev.type}] ${redact(ev.text || '')}`;
  return null;
}

// Deterministic truncation: the beginning and the end are kept, with an
// explicit marker saying how much was left out. Nothing is silently dropped.
export function truncateText(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, omitted: 0 };
  const marker = (n) => `\n\n[... ${n} characters omitted; the full events remain in Agent Hub ...]\n\n`;
  const budget = Math.max(0, maxChars - marker(String(s.length).length).length);
  const head = Math.max(1, Math.floor(budget * 0.35));
  const tail = Math.max(0, budget - head);
  const omitted = s.length - head - tail;
  return { text: `${s.slice(0, head)}${marker(omitted)}${s.slice(s.length - tail)}`, omitted };
}

// The runtimes a chain has run on, in order, one entry per stretch
// (Kimi → Claude → Kimi is three entries).
const providersOf = (nodes) => nodes.map((n) => store.nodeProvider(n)).filter((p, i, all) => i === 0 || p !== all[i - 1]);

// `source` is the runtime being LEFT: the leaf the history is handed over
// from, which is what the new runtime's model needs to be told. The chain
// start and the whole trail are kept beside it, never in its place.
export function chainTranscript(session, { maxChars = DEFAULT_MAX_CHARS, beforeTs = null, beforeIndex = null } = {}) {
  const leaf = store.leafOf(session) || session;
  const nodes = store.chainOf(leaf);
  const source = store.nodeProvider(leaf);
  const chainStart = store.nodeProvider(nodes[0] || leaf);
  const trail = providersOf(nodes);
  const cwd = leaf?.cwd || nodes[0]?.cwd || '';
  const blocks = [];
  for (const node of nodes) {
    const provider = store.nodeProvider(node);
    for (const [index, ev] of (node.events || []).entries()) {
      if (node === leaf && beforeIndex != null && index >= beforeIndex) continue;
      if (beforeTs != null && (ev.ts || 0) > beforeTs) continue;
      const b = block(ev);
      if (b) blocks.push(`[${provider}] ${b}`);
    }
  }
  const header = [
    `This is prior conversation history from ${providerName(source)}.`,
    ...(trail.length > 1 ? [`This conversation has run on ${trail.map(providerName).join(' → ')} so far; each block below is tagged with the runtime it came from.`] : []),
    `Working directory: ${cwd || '(unknown)'}`,
    'It is NOT a new user request. Do not answer it. Use it only as context for the user\'s next message.',
    'History begins below.',
    '',
  ].join('\n');
  const meta = { nodes: nodes.length, sourceProvider: source, chainStartProvider: chainStart, chainProviders: trail, sourceNodeId: leaf?.id || null, cwd };
  if (!blocks.length) return { text: '', omitted: 0, chars: 0, ...meta };
  // Each block was masked on its own; the joined text is masked once more
  // (idempotent) so nothing that spans two blocks survives.
  const raw = redact(`${header}${blocks.join('\n\n')}\n\nEnd of prior history.`);
  const { text, omitted } = truncateText(raw, maxChars);
  return { text, omitted, chars: text.length, ...meta };
}

// Metadata kept with the target node. The text itself is not repeated into
// every event; it is sent once, on the first real prompt.
export function handoffFor(session, target = {}) {
  const r = chainTranscript(session);
  return {
    fromProvider: r.sourceProvider,
    fromNodeId: r.sourceNodeId,
    chainStartProvider: r.chainStartProvider,
    chainProviders: r.chainProviders,
    fromCwd: r.cwd,
    targetProvider: target.provider || null,
    targetModel: target.model || null,
    targetEffort: target.effort || null,
    text: r.text,
    chars: r.chars,
    omitted: r.omitted,
    nodes: r.nodes,
    createdAt: Date.now(),
    consumedAt: null,
  };
}
