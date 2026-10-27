// Server-side hardening that does not depend on the rest of the Hub: who may
// open a WebSocket, how big a request body may be and who gets to send one,
// what an error looks like from outside, the response headers, and a check
// of the data folder's permissions. server/index.js wires these in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// ------------------------------------------------------------- addresses

// An address only this computer can reach. Anything else (0.0.0.0, ::, a LAN
// or public address, a name) is, for the login, "the network".
export function isLoopbackHost(host) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127(\.\d{1,3}){3}$/.test(h) || h === '::ffff:127.0.0.1';
}

// ---------------------------------------------------------------- origins

// Origins (besides the Hub's own address) whose pages may open a WebSocket:
// AGENT_HUB_ALLOWED_ORIGINS="https://hub.example.com, https://other.example:8443".
export function parseAllowedOrigins(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean),
  );
}

// A browser always says which page a WebSocket (or a cross-site request)
// comes from, in `Origin`, and a page cannot change it. A program that is not
// a browser (the connector, a script) sends none. So: no Origin is let
// through (the token or key is still needed); an Origin must be the address
// the Hub was reached at (Host, or X-Forwarded-Host behind a proxy that
// rewrites Host; a page cannot set either) or one that is listed.
export function originAllowed(req, extra = new Set()) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const text = String(origin).trim();
  let host;
  try {
    host = new URL(text).host.toLowerCase();
  } catch {
    return false; // "null" (a sandboxed page, a file), or not an origin at all
  }
  if (!host) return false;
  const own = [req.headers.host, String(req.headers['x-forwarded-host'] || '').split(',')[0]].map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  if (own.includes(host)) return true;
  return extra.has(text.replace(/\/+$/, '').toLowerCase());
}

// ------------------------------------------------------------ request body

// The routes that carry attachments and pictures (the only big bodies); every
// other route takes a small JSON body.
export const SMALL_JSON_LIMIT = '1mb';
export const LARGE_JSON_LIMIT = '80mb';
const UPLOAD_ROUTES = [/^\/sessions\/?$/i, /^\/sessions\/[^/]+\/messages\/?$/i];

// Mounted on /api after the login check, so a body is only ever read for a
// client that has shown the token.
export function jsonBody() {
  const small = express.json({ limit: SMALL_JSON_LIMIT });
  const large = express.json({ limit: LARGE_JSON_LIMIT });
  return (req, res, next) => (req.method === 'POST' && UPLOAD_ROUTES.some((re) => re.test(req.path)) ? large : small)(req, res, next);
}

// ----------------------------------------------------------------- errors

const mb = (bytes) => `${Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10} MB`;
const BODY_ERRORS = {
  'entity.parse.failed': () => '請求內容不是有效的 JSON',
  'entity.too.large': (err) => `請求內容太大（這個端點最多 ${mb(err.limit)}）`,
  'encoding.unsupported': () => '不支援這種內容編碼（Content-Encoding）',
  'charset.unsupported': () => '不支援這種字元集',
  'request.aborted': () => '請求在傳送途中中斷',
  'request.size.invalid': () => '請求內容的大小與標頭不符',
};
const BY_STATUS = { 400: '請求有誤', 401: '需要存取權杖（token）', 403: '不允許', 404: '找不到', 413: '請求內容太大', 415: '不支援的內容類型', 429: '請求太頻繁' };

// The last error handler: every error is answered as JSON { error }, with the
// status it carries (400, 413 …) and a message that never carries a stack, a
// path or the text of the error itself (which may name files on this
// computer). The full error goes to the Hub's own log.
export function errorHandler() {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const code = Number.isInteger(err?.status) ? err.status : Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    const status = code >= 400 && code < 600 ? code : 500;
    if (status >= 500) console.error(`[http] ${req.method} ${req.path}:`, err?.stack || err);
    const known = BODY_ERRORS[err?.type];
    res.status(status).json({ error: known ? known(err) : status >= 500 ? '伺服器發生錯誤' : BY_STATUS[status] || '請求無法處理' });
  };
}

export const notFound = () => (req, res) => res.status(404).json({ error: BY_STATUS[404] });

// --------------------------------------------------------------- headers

// The Hub's pages are served by the Hub and load nothing from anywhere else,
// so what the page may do is spelled out; but the pages the Hub shows in its
// side panel (an Artifact: a page a model wrote, in a sandboxed srcdoc
// iframe) inherit this policy, and they carry inline scripts and styles and
// often load libraries, fonts and pictures from a CDN. So the default policy
// leaves scripts, styles, images and connections alone and closes the rest:
// nobody can frame the Hub, plugins and <base> are off. AGENT_HUB_CSP=strict
// is the full policy (own scripts only, nothing inline but the page's
// bootstrap script, no outside connections); Artifact previews do not run under it.
export const DEFAULT_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

// 'sha256-…' sources for the inline <script>s of a page (the palette
// bootstrap in index.html), so the strict policy needs no 'unsafe-inline'.
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  }
  return out;
}

export function strictCsp({ host, scriptHashes = [] } = {}) {
  // `'self'` already covers a same-origin WebSocket in current browsers; naming the
  // address too keeps older Safari working. Only the characters of a host name.
  const safeHost = /^[\w.:\[\]-]+$/.test(host || '') ? host : null;
  const ws = safeHost ? ` ws://${safeHost} wss://${safeHost}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${ws}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders({ strict = false, scriptHashes = [] } = {}) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', strict ? strictCsp({ host: req.headers.host, scriptHashes }) : DEFAULT_CSP);
    next();
  };
}

// ------------------------------------------------------------ data folder

// One warning line when the data folder (conversations, tokens) or the file
// with the login token is open to other users of this computer; null when
// all is private. Existing permissions are never changed: that is the
// owner's call.
export function loosePermissionsWarning(dataDir) {
  if (process.platform === 'win32') return null;
  const loose = [];
  for (const [label, p] of [['data/', dataDir], ['data/hub.json', path.join(dataDir, 'hub.json')]]) {
    try {
      const mode = fs.statSync(p).mode & 0o777;
      if (mode & 0o077) loose.push(`${label} 是 ${mode.toString(8)}`);
    } catch {}
  }
  if (!loose.length) return null;
  return `⚠ 資料夾權限過寬：${loose.join('、')}（建議資料夾 700、檔案 600），同一台電腦的其他使用者讀得到對話紀錄與登入權杖。Hub 不會自己改既有權限；要收緊請執行 chmod 700 "${dataDir}"`;
}
