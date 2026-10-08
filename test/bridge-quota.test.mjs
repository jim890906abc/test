// The bridge reading the whole /usages answer for the hub: with the login
// Kimi saved for the address Kimi uses, and only when the answer is about
// the windows Kimi just reported (the same account). A fake Kimi server and
// a fake Kimi API on this computer; no account needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-quota-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const R5 = new Date(Date.now() + 2 * 3600_000).toISOString();
const R7 = new Date(Date.now() + 90 * 3600_000).toISOString();
let bridge;
let kimi;
let hubWss;
let hubWs;
const asked = []; // what reached the Kimi API: { token, accept }

// Kimi's server (what the bridge asks for the region and the provider) and
// the Kimi API (/coding/v1/usages), on one port.
function fakeKimi() {
  const srv = http.createServer((req, res) => {
    const json = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
    const base = `http://127.0.0.1:${srv.address().port}/coding/v1`;
    if (req.url === '/api/v1/healthz') return json({ ok: true });
    if (req.url === '/api/v1/oauth/region') return json({ code: 0, data: { region: 'global' } });
    if (req.url === '/api/v1/providers') return json({ code: 0, data: { items: [{ id: 'managed:kimi-code', type: 'kimi', base_url: base, has_api_key: false, status: 'ok' }] } });
    if (req.url === '/coding/v1/usages') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      asked.push({ token, accept: req.headers.accept });
      if (token !== 'tok-mine') return (res.statusCode = 401), json({ error: 'unauthorized' });
      return json({
        user: { userId: 'u1', region: 'REGION_OVERSEA' },
        usage: { limit: '100', used: '19', remaining: '81', resetTime: R7 },
        limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '40', remaining: '60', resetTime: R5 } }],
        parallel: { limit: 20 },
        usages: { limit_5h: { used_ratio: 0, reset_time: R5 }, limit_7d: { used_ratio: 0, reset_time: R7 } },
      });
    }
    res.statusCode = 404;
    json({ code: 404 });
  });
  new WebSocketServer({ server: srv, path: '/api/v1/ws' });
  return srv;
}

const slot = (host, base) => `kimi-code-env-${crypto.createHash('sha256').update(JSON.stringify({ oauthHost: host, baseUrl: base })).digest('hex').slice(0, 16)}`;
const saveLogin = (name, token, expiresAt) => fs.writeFileSync(path.join(KIMI_HOME, 'credentials', `${name}.json`), JSON.stringify({ access_token: token, refresh_token: 'r', expires_at: expiresAt, scope: '', token_type: 'Bearer', expires_in: 900 }));

const pending = new Map();
const ask = (args) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    pending.set(id, resolve);
    hubWs.send(JSON.stringify({ t: 'req', id, op: 'kimi.usage', args }));
    setTimeout(() => reject(new Error('no answer')), 20000);
  });

before(async () => {
  kimi = fakeKimi();
  await new Promise((r) => kimi.listen(0, '127.0.0.1', r));
  const port = kimi.address().port;
  fs.mkdirSync(path.join(KIMI_HOME, 'server', 'instances'), { recursive: true });
  fs.mkdirSync(path.join(KIMI_HOME, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(KIMI_HOME, 'server', 'instances', 'a.json'), JSON.stringify({ port, host: '127.0.0.1', pid: process.pid, server_id: 'srv1', started_at: Date.now() }));
  fs.writeFileSync(path.join(KIMI_HOME, 'server.token'), 'server-token');
  // The global login for this provider's address. (No mainland one: that
  // would be tried against Kimi's real servers.)
  saveLogin(slot('https://auth.kimi.ai', `http://127.0.0.1:${port}/coding/v1`), 'tok-mine', Date.now() / 1000 + 600);

  hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => hubWss.on('listening', r));
  const connected = new Promise((resolve) => {
    hubWss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') (hubWs = ws), resolve();
        if (m.t === 'res' && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
      });
    });
  });
  const env = { ...process.env, HOME: TMP };
  for (const k of ['KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'KIMI_CODE_HOME']) delete env[k];
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill'], { env, stdio: 'ignore' });
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge did not connect')), 15000))]);
});

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  kimi?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the same windows Kimi reported: the whole answer, nothing else', async () => {
  const r = await ask({ expect: { limit5h: R5, limit7d: R7 } });
  assert.equal(r.ok, true);
  assert.equal(r.data.ok, true);
  assert.deepEqual(Object.keys(r.data.payload).sort(), ['limits', 'usage', 'usages']);
  assert.equal(r.data.payload.limits[0].detail.used, '40');
  assert.equal(r.data.payload.usage.used, '19');
  assert.deepEqual(asked.at(-1), { token: 'tok-mine', accept: 'application/json' });
  // Nothing to compare with: Kimi's own login still answers.
  assert.equal((await ask({})).data.ok, true);
});

test('another account (other reset times), or no usable login: nothing', async () => {
  const n = asked.length;
  const r = await ask({ expect: { limit5h: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(r.data.ok, false);
  assert.equal(asked.length, n + 1, 'asked once, with the one login there is');
  // Expired: Kimi no longer uses it, so it is not sent at all.
  saveLogin(slot('https://auth.kimi.ai', `http://127.0.0.1:${kimi.address().port}/coding/v1`), 'tok-mine', Date.now() / 1000 - 5);
  assert.equal((await ask({ expect: { limit5h: R5 } })).data.ok, false);
  assert.equal(asked.length, n + 1);
});
