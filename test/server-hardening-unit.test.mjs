// The pieces server/hardening.js is made of, one by one (the Hub as a whole,
// running, is checked in server-hardening.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { isLoopbackHost, parseAllowedOrigins, originAllowed, inlineScriptHashes, strictCsp, errorHandler, notFound, loosePermissionsWarning } from '../server/hardening.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('isLoopbackHost: only addresses this computer alone can reach', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '::', '', undefined, null, '198.51.100.7', '203.0.113.9', '192.0.2.5', 'example.com', 'localhost.evil.example', '127.0.0.1.evil.example', '1270.0.0.1', '128.0.0.1', '::2']) assert.equal(isLoopbackHost(h), false, String(h));
});

const req = (headers) => ({ headers });

test('originAllowed: no Origin passes; an Origin must be the address the Hub was reached at or a listed one', () => {
  const none = new Set();
  assert.equal(originAllowed(req({ host: 'a.test' }), none), true);
  assert.equal(originAllowed(req({ host: 'a.test:8787', origin: 'http://a.test:8787' }), none), true);
  assert.equal(originAllowed(req({ host: 'A.TEST', origin: 'https://a.test' }), none), true, 'case and scheme do not matter for the same address');
  assert.equal(originAllowed(req({ host: '[::1]:8787', origin: 'http://[::1]:8787' }), none), true);
  assert.equal(originAllowed(req({ host: '127.0.0.1:1', origin: 'http://a.test' }), none), false);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'http://a.test:81' }), none), false, 'another port is another site');
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'null' }), none), false);
  assert.equal(originAllowed(req({ host: 'a.test', origin: '' }), none), false);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'file://' }), none), false);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'not an origin' }), none), false);
  // Behind a proxy that rewrites Host.
  assert.equal(originAllowed(req({ host: '127.0.0.1:8787', 'x-forwarded-host': 'hub.test, inner', origin: 'https://hub.test' }), none), true);
  assert.equal(originAllowed(req({ host: '127.0.0.1:8787', 'x-forwarded-host': 'hub.test', origin: 'https://evil.test' }), none), false);
  const listed = parseAllowedOrigins(' https://ok.test ,HTTPS://Other.test:8443/, ,');
  assert.deepEqual([...listed].sort(), ['https://ok.test', 'https://other.test:8443']);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'https://ok.test' }), listed), true);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'https://other.test:8443' }), listed), true);
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'http://ok.test' }), listed), false, 'the scheme is part of a listed origin');
  assert.equal(originAllowed(req({ host: 'a.test', origin: 'https://sub.ok.test' }), listed), false);
  assert.deepEqual([...parseAllowedOrigins(undefined)], []);
});

test('inlineScriptHashes hashes the inline scripts of a page, not the ones that load a file; strictCsp uses them and nothing inline otherwise', () => {
  const html = '<head><script>let a = 1;</script><script type="module" src="/js/app.js"></script><script src = "/x.js"></script><script type="module">import "/y.js";</script></head>';
  const hash = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
  assert.deepEqual(inlineScriptHashes(html), [hash('let a = 1;'), hash('import "/y.js";')]);
  const csp = strictCsp({ host: '127.0.0.1:8787', scriptHashes: inlineScriptHashes(html) });
  assert.match(csp, /script-src 'self' 'sha256-[^']+' 'sha256-[^']+'(;|$)/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts but the hashed ones');
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:8787 wss:\/\/127\.0\.0\.1:8787/);
  for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "default-src 'self'"]) assert.ok(csp.includes(d), d);
  // A Host header is attacker-chosen text: nothing but a host name goes into the policy.
  assert.ok(!strictCsp({ host: "x; script-src *" }).includes('script-src *'));
  assert.ok(!strictCsp({ host: undefined }).includes('ws://'));
});

function serve(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('errorHandler answers JSON { error } with the error\'s own status, and never repeats the error\'s text', async () => {
  const app = express();
  const secret = '/srv/hub-secret-install/node_modules/pkg/index.js';
  app.get('/boom', () => {
    throw new Error(`ENOENT: no such file, open '${secret}'`);
  });
  app.get('/teapot', () => {
    throw Object.assign(new Error(`short and stout at ${secret}`), { status: 418 });
  });
  app.get('/weird-status', () => {
    throw Object.assign(new Error(secret), { status: 'oops' });
  });
  app.get('/string', () => {
    throw secret; // eslint-disable-line no-throw-literal
  });
  app.get('/half', (req, res, next) => {
    res.write('partial');
    next(new Error(secret));
  });
  app.use(notFound());
  app.use(errorHandler());
  const { server, base } = await serve(app);
  const errors = console.error;
  console.error = () => {}; // the 500s are logged, by design
  try {
    for (const [p, status] of [['/boom', 500], ['/teapot', 418], ['/weird-status', 500], ['/string', 500], ['/missing', 404]]) {
      const r = await fetch(base + p);
      const text = await r.text();
      assert.equal(r.status, status, p);
      assert.match(r.headers.get('content-type'), /application\/json/, p);
      assert.deepEqual(Object.keys(JSON.parse(text)), ['error'], p);
      assert.ok(!text.includes('/srv') && !text.includes('node_modules') && !text.includes('ENOENT') && !text.includes('stout'), `${p}: ${text}`);
    }
    // An answer already begun cannot become JSON: the connection is cut, not a half page finished.
    await assert.rejects(async () => (await fetch(`${base}/half`)).text());
  } finally {
    console.error = errors;
    server.close();
  }
});

test('loosePermissionsWarning: one line for a data folder open to others, nothing for a private one, nothing changed', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-perm-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    fs.chmodSync(data, 0o700);
    assert.equal(loosePermissionsWarning(data), null);
    assert.equal(loosePermissionsWarning(path.join(dir, 'missing')), null, 'a folder that is not there is not a finding');
    fs.chmodSync(data, 0o750);
    const w = loosePermissionsWarning(data);
    assert.ok(w && !w.includes('\n') && w.includes('750') && w.includes('chmod'), w);
    assert.equal(fs.statSync(data).mode & 0o777, 0o750, 'it only looks');
    fs.chmodSync(data, 0o700);
    fs.writeFileSync(path.join(data, 'hub.json'), '{}', { mode: 0o644 });
    fs.chmodSync(path.join(data, 'hub.json'), 0o644);
    assert.match(loosePermissionsWarning(data), /hub\.json 是 644/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
