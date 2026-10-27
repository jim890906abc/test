// The one secret-masking implementation in Agent Hub. Everything that must
// not leak a credential goes through here: the hand-off text a switch sends
// to another provider (server/handoff.js, and Claude's daemon once more
// before the first request), every event before it is stored or broadcast
// (server/runner.js), and the broker's mirrored child events.
//
// It is built from the secrets this system really holds and meets:
//   • exact values the Hub keeps (registerSecretSource): its login token, the
//     bridge key, the Claude key, every DeepSeek pool key;
//   • the formats of the credentials we mint or that users paste: Anthropic
//     and gateway keys (sk-ant-…, sk-…), delegation tokens (hb_…), bridge
//     keys (bk_…), GitHub, AWS, Slack, Google, JWT, Bearer/Basic, PEM blocks,
//     Cookie headers and user:password@ URLs;
//   • structured fields: JSON "apiKey"/"token"/"password"… members, and (in
//     the stricter 'full' mode) KEY=VALUE lines such as DEEPSEEK_API_KEY=….
//
// Two strengths, because they serve two jobs:
//   redactSecrets — credential shapes, exact values and JSON secret members.
//                   High precision; used on live events, which are the
//                   user's own conversation.
//   redact        — all of the above plus free-text KEY=VALUE, `password: x`
//                   and `curl -u`. Over-masking is the safe side for text
//                   that is about to leave for another company.
// Both are pure, idempotent and never throw on odd input.

export const MASK = '[redacted]';

// ------------------------------------------------------ exact secret values

const sources = new Set();

// `fn()` returns the secret values the Hub holds right now (strings; empty
// and short ones are ignored). It is asked on every call, so a key saved a
// second ago is already covered.
export function registerSecretSource(fn) {
  sources.add(fn);
  return () => sources.delete(fn);
}

const MIN_EXACT = 8;
function exactSecrets() {
  const out = new Set();
  for (const fn of sources) {
    let list;
    try {
      list = fn();
    } catch {
      continue;
    }
    for (const v of Array.isArray(list) ? list : [list]) if (typeof v === 'string' && v.length >= MIN_EXACT && !/\s/.test(v)) out.add(v);
  }
  // Longest first, so a secret that contains another is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}

// --------------------------------------------------------------- the rules

// Not inside a longer identifier or a base64 run.
const B = '(?<![A-Za-z0-9+/_-])';
const NAMES = 'api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?key|signing[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|passwd|passphrase|credentials?|authorization|cookie|bearer';

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|$)/g;

// [pattern, replacement]. Credential shapes: each is a format with a
// distinctive prefix, so these do not touch ordinary prose or hashes.
const SHAPES = [
  [new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{8,}`, 'g'), MASK],
  [new RegExp(`${B}sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}`, 'g'), MASK],
  [new RegExp(`${B}sk_(?:live|test)_[A-Za-z0-9]{16,}`, 'g'), MASK],
  [new RegExp(`${B}hb_[A-Za-z0-9]{16,}`, 'g'), MASK],
  [new RegExp(`${B}bk_[A-Za-z0-9_-]{8,}`, 'g'), MASK],
  [new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'), MASK],
  [new RegExp(`(?<![A-Za-z0-9+/_-])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}(?![A-Z0-9])`, 'g'), MASK],
  [new RegExp(`${B}xox[abposr]-[A-Za-z0-9-]{10,}`, 'g'), MASK],
  [new RegExp(`${B}AIza[A-Za-z0-9_-]{35}`, 'g'), MASK],
  [new RegExp(`${B}npm_[A-Za-z0-9]{36}`, 'g'), MASK],
  [new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, 'g'), MASK],
  // Bearer / Token credentials: a long token, or a shorter one with a digit
  // ("Bearer authentication" in prose is left alone).
  [/\b(Bearer|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${MASK}`],
  [/\bBasic\s+(?=[A-Za-z0-9+/]*[\d+/])[A-Za-z0-9+/]{8,}={0,2}/g, `Basic ${MASK}`],
  // user:password@host
  [/(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@"'<>]+:)[^\s/@"'<>]+(@)/gi, `$1${MASK}$2`],
  // Cookie / Set-Cookie header values (name=value…), up to the end of the line
  [/\b((?:set-)?cookie\s*:\s*)[^\s=;"']+=[^\r\n"']*/gi, `$1${MASK}`],
  // Credential headers
  [/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-access-token)(\s*:\s*)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;]{4,}/gi, `$1$2${MASK}`],
];

// "apiKey": "…" members of JSON, in plain and in escaped (JSON inside a
// JSON string) form, and the single-quoted form of a dict dump.
const JSON_FIELDS = [
  [new RegExp(`("[A-Za-z0-9_.-]{0,40}?(?:${NAMES})"\\s*:\\s*)"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"`, 'gi'), `$1"${MASK}"`],
  [new RegExp(`('[A-Za-z0-9_.-]{0,40}?(?:${NAMES})'\\s*:\\s*)'[^'\\\\\\r\\n]*(?:\\\\.[^'\\\\\\r\\n]*)*'`, 'gi'), `$1'${MASK}'`],
  [new RegExp(`(\\\\"[A-Za-z0-9_.-]{0,40}?(?:${NAMES})\\\\"\\s*:\\s*)\\\\"[^"\\\\]*\\\\"`, 'gi'), `$1\\"${MASK}\\"`],
];

// KEY=VALUE in free text (.env lines, `password: hunter2`, `--token abc`).
// The name must END with the keyword (max_tokens is not a token) and the
// value is not a number, boolean or an already masked value.
const KV_NAME = `[A-Za-z0-9_.-]{0,40}?(?:${NAMES})`;
const KV = [
  [new RegExp(`(?<![A-Za-z0-9])(${KV_NAME})(?![A-Za-z0-9])(["']?\\s*[:=]\\s*)(["'])(?!\\[redacted\\])((?:(?!\\3)[^\\r\\n]){1,500})\\3`, 'gi'), `$1$2$3${MASK}$3`],
  [new RegExp(`(?<![A-Za-z0-9])(${KV_NAME})(?![A-Za-z0-9])(["']?\\s*[:=]\\s*)(?!["'])(?!\\[redacted)(?!(?:true|false|null|none|undefined|\\d+)(?![A-Za-z0-9]))[^\\s"',;}\\])]{4,}`, 'gi'), `$1$2${MASK}`],
  [/(\bcurl\b[^\r\n]*?\s(?:-u|--user)[\s=]+)("[^"]*"|'[^']*'|\S+)/g, `$1${MASK}`],
];

// A cheap test run before the regexes, so ordinary text costs one scan.
const TRIGGER = new RegExp(`${NAMES}|sk-|sk_|hb_|bk_|gh[pousr]_|github_pat_|AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|xox|AIza|npm_|eyJ|BEGIN|basic|api-key|auth-token|access-token|://|curl`, 'i');

function applyAll(text, rules) {
  for (const [re, to] of rules) {
    re.lastIndex = 0;
    text = text.replace(re, to);
  }
  return text;
}

function mask(text, full) {
  let out = text;
  for (const secret of exactSecrets()) if (out.includes(secret)) out = out.split(secret).join(MASK);
  if (!TRIGGER.test(out)) return out;
  out = out.replace(PEM, '[redacted private key]');
  out = applyAll(out, SHAPES);
  out = applyAll(out, JSON_FIELDS);
  if (full) out = applyAll(out, KV);
  return out;
}

// Strict: everything that can be a credential, including free-text KEY=VALUE.
export function redact(text) {
  return mask(String(text ?? ''), true);
}

// Credential shapes, exact values and JSON secret members only.
export function redactSecrets(text) {
  return mask(String(text ?? ''), false);
}

// True when `text` still holds something these rules would mask.
export const hasSecret = (text) => redact(text) !== String(text ?? '');

// ------------------------------------------------------------ structured data

// A key whose value is a credential by name: token, apiKey, client_secret,
// Authorization… It must END with the word, so max_tokens and tokenCount are
// not secrets.
const SECRET_KEY = /(^|_)(token|secret|secret_key|password|passwd|passphrase|authorization|cookie|set_cookie|api_?key|access_?key|private_?key|auth_?key|credentials?|bearer)$/;
export function isSecretKey(key) {
  const k = String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-.\s]+/g, '_');
  return SECRET_KEY.test(k);
}

// An opaque blob (an inline image) is not text to scan.
const isBlob = (s) => s.length > 4096 && !/\s/.test(s) && /^[A-Za-z0-9+/=_-]+$/.test(s);

// A copy of `value` with every string masked and every secret-named member's
// value replaced (or, with `drop`, the member left out). Returns the SAME
// object when nothing changed, so a clean event costs no copy. `strict`
// selects redact() over redactSecrets().
export function redactDeep(value, { strict = false, drop = false, depth = 0 } = {}) {
  const opts = { strict, drop, depth: depth + 1 };
  if (typeof value === 'string') return value && !isBlob(value) ? (strict ? redact(value) : redactSecrets(value)) : value;
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) {
    let out = null;
    value.forEach((v, i) => {
      const r = redactDeep(v, opts);
      if (r !== v && !out) out = value.slice();
      if (out) out[i] = r;
    });
    return out || value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  let out = null;
  for (const [k, v] of Object.entries(value)) {
    const secret = isSecretKey(k) && v != null && v !== '' && typeof v !== 'boolean' && typeof v !== 'object';
    if (secret && drop) {
      out ??= { ...value };
      delete out[k];
      continue;
    }
    const r = secret ? MASK : redactDeep(v, opts);
    if (r !== v && !out) out = { ...value };
    if (out) out[k] = r;
  }
  return out || value;
}

// ---------------------------------------------------------- streamed fields

// A tool call's arguments and output arrive in pieces, and a secret can be
// cut between two of them. The stored field is therefore always the masked
// form of everything received so far. Only a recent window (WINDOW to 2×) is
// kept unmasked and scanned again as pieces arrive; what scrolls out of it is
// folded into a masked head at a whitespace boundary. While the window holds
// nothing that could be (part of) a secret, a piece costs one small probe.
const WINDOW = 2048;
const streams = new WeakMap(); // event -> Map(field -> { head, tail, tailRed, clean, stored })

// A private key block that has begun and not ended: its body must stay in the
// window (and masked as one) until the END line comes.
function openPem(text) {
  const at = text.lastIndexOf('-----BEGIN ');
  return at !== -1 && /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(text.slice(at, at + 60)) && !text.includes('-----END ', at);
}

// Could `text` hold, or be completing, something mask() would change?
function couldHoldSecret(text, exact) {
  if (TRIGGER.test(text)) return true;
  for (const secret of exact) if (text.includes(secret)) return true;
  return false;
}

// Appends `chunk` to `ev[field]`, masked. Returns { delta } (the masked text
// that was added; a client can append it) or { replaced: true } when text
// already shown had to change (a secret finished arriving), in which case the
// whole field must be sent again. A secret is withheld only once it is
// recognizable: up to its first 16 characters can show before a token's
// format is complete, which is nothing to use.
export function appendRedacted(ev, field, chunk) {
  const text = String(chunk ?? '');
  const before = typeof ev[field] === 'string' ? ev[field] : '';
  let fields = streams.get(ev);
  if (!fields) streams.set(ev, (fields = new Map()));
  let st = fields.get(field);
  // The field was set by someone else since: trust it (it was masked on the way in).
  if (!st || st.stored !== before) st = { head: before, tail: '', tailRed: '', clean: true, stored: before };
  fields.set(field, st);
  const exact = exactSecrets();
  const reach = exact.reduce((n, x) => Math.max(n, x.length), 32);
  if (st.clean && st.tail.length + text.length <= 2 * WINDOW && !couldHoldSecret(st.tail.slice(-reach) + text, exact)) {
    st.tail += text;
    st.tailRed = st.tail;
    st.stored = st.head + st.tail;
    ev[field] = st.stored;
    return { delta: text };
  }
  const previous = st.tailRed;
  st.tail += text;
  let folded = '';
  if (st.tail.length > 2 * WINDOW) {
    const limit = st.tail.length - WINDOW;
    let cut = Math.max(st.tail.lastIndexOf('\n', limit), st.tail.lastIndexOf(' ', limit)) + 1;
    if (!cut && st.tail.length > 16 * WINDOW) cut = limit;
    // Never fold the start of a private key away from its end.
    if (cut && st.tail.length <= 64 * WINDOW && openPem(st.tail.slice(0, cut))) cut = 0;
    if (cut) {
      folded = redactSecrets(st.tail.slice(0, cut));
      st.head += folded;
      st.tail = st.tail.slice(cut);
    }
  }
  const now = redactSecrets(st.tail);
  const visible = folded + now; // what the old tail plus this chunk looks like, masked
  st.tailRed = now;
  st.clean = !couldHoldSecret(st.tail, exact);
  st.stored = st.head + now;
  ev[field] = st.stored;
  return visible.startsWith(previous) ? { delta: visible.slice(previous.length) } : { replaced: true };
}
