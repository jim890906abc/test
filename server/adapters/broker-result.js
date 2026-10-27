// What may cross between the Hub and a Claude daemon as the answer to a
// cross-provider Task: only these fields, capped, so nothing else (no token,
// no key, no stray object) can reach the conversation. Used by both ends so
// the two cannot drift; part of the daemon's engine (see claude-link.js).
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export function sanitizeBrokerResult(input, { cutBy = 'the daemon' } = {}) {
  const r = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let text = str(r.text, 100_000);
  if (typeof r.text === 'string' && r.text.length > text.length) text += `\n[… ${r.text.length - text.length} characters cut by ${cutBy}]`;
  return {
    childSessionId: str(r.childSessionId, 100) || null,
    provider: str(r.provider, 20),
    model: str(r.model, 100),
    effort: str(r.effort, 20),
    text,
    error: str(r.error, 4000) || null,
  };
}
