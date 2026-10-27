// The Hub's server-side hardening, checked against a real running Hub process
// (no part of the Hub is mocked): what an anonymous client can make it do
// before it has shown a token, what an error looks like from outside, the
// "no token on a public address" interlock, the WebSocket Origin rule and
// frame limits, the response headers, and the permissions of data/.
//
// Every Hub here has its own scratch data folder and a free port; nothing
// reads or writes the real data/ folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { stopDaemonsSync } from './fixtures/stop-daemons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hardening-'));
const TOKEN = 'hardening-test-token-0123456789';
const hubs = new Set();

after(() => {
  for (const h of hubs) h.proc.kill('SIGKILL');
  // A Hub with a Claude conversation starts a daemon that outlives it: end those
  // (they are found by their --dir inside TMP) before TMP goes.
  stopDaemonsSync(TMP);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A conversation in the shape the Hub stores it, loadable from disk.
const sessionRecord = (id) => ({
  id, conversationId: id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {},
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1000, updatedAt: 1000, provider: 'claude', agentId: 'claude', cwd: TMP, meta: {}, origin: 'hub',
});

// Starts `node server/index.js` on a free port. `up` resolves true once it says
// it is listening, false if it exits first.
async function launch({ token = TOKEN, host, env = {}, data, sessions = [] } = {}) {
  const port = await freePort();
  const dataDir = data || path.join(TMP, `data-${port}`);
  if (sessions.length) fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  for (const id of sessions) fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.json`), JSON.stringify(sessionRecord(id)));
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...(host ? { HOST: host } : {}), AGENT_HUB_TOKEN: token, AGENT_HUB_DATA: dataDir, AGENT_HUB_WORKSPACES: path.join(TMP, `ws-${port}`), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  const up = new Promise((resolve) => {
    const t = setInterval(() => log.includes('已啟動') && (clearInterval(t), resolve(true)), 20);
    exited.then(() => (clearInterval(t), resolve(false)));
  });
  const hub = {
    port,
    data: dataDir,
    proc,
    exited,
    up,
    log: () => log,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    api: (p, init = {}) => fetch(hub.url(`/api${p}`), { ...init, headers: { 'x-hub-token': token, ...(init.headers || {}) } }),
  };
  hubs.add(hub);
  return hub;
}

async function start(opts) {
  const hub = await launch(opts);
  assert.equal(await hub.up, true, `the Hub should start\n${hub.log()}`);
  return hub;
}

const stop = async (hub) => {
  hub.proc.kill('SIGTERM');
  await Promise.race([hub.exited, sleep(3000)]);
  hub.proc.kill('SIGKILL');
  hubs.delete(hub);
};

// POST a JSON-ish body of about `bytes` bytes, sent in 1 MB pieces; resolves with
// whatever answer comes first (the Hub may answer before the body is all in).
// Keep-alive, because a server that closes a connection it has not read to the
// end may reset it, and the answer can be lost on its way to the client.
const keepAlive = new http.Agent({ keepAlive: true });
after(() => keepAlive.destroy());
function postBig(hub, pathName, bytes, { headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const head = Buffer.from('{"pad":"');
    const tail = Buffer.from('"}');
    const chunk = Buffer.alloc(1 << 20, 0x61);
    const total = head.length + bytes + tail.length;
    let answered = false;
    const req = http.request(
      { host: '127.0.0.1', port: hub.port, path: pathName, method: 'POST', agent: keepAlive, headers: { 'content-type': 'application/json', 'content-length': total, ...(token ? { 'x-hub-token': token } : {}), ...headers } },
      (res) => {
        answered = true;
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() }));
      },
    );
    req.on('error', (err) => !answered && reject(err));
    (async () => {
      req.write(head);
      let left = bytes;
      while (left > 0 && !req.destroyed) {
        const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= piece.length;
        if (!req.write(piece)) await new Promise((r) => req.once('drain', r));
      }
      req.end(tail);
    })().catch(() => {});
  });
}

// An already-gzipped body that is `inflated` bytes of valid JSON once inflated.
function gzipBomb(inflated) {
  const head = Buffer.from('{"pad":"');
  const tail = Buffer.from('"}');
  const gz = zlib.createGzip({ level: 1 });
  const parts = [];
  gz.on('data', (d) => parts.push(d));
  return new Promise((resolve) => {
    gz.on('end', () => resolve(Buffer.concat(parts)));
    gz.write(head);
    const chunk = Buffer.alloc(1 << 20, 0x61);
    for (let left = inflated; left > 0; left -= chunk.length) gz.write(left >= chunk.length ? chunk : chunk.subarray(0, left));
    gz.end(tail);
  });
}

const rawPost = (hub, pathName, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: hub.port, path: pathName, method: 'POST', agent: false, headers: { 'content-length': body.length, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });

// Peak resident memory (kB) of a process, from /proc (Linux).
const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc/self/status');
const peakKb = (pid) => Number(/VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);

// Nothing in an error answer may tell the caller where the Hub is installed.
function assertNoLeak(text, what) {
  assert.ok(!text.includes('node_modules'), `${what}: names node_modules\n${text.slice(0, 300)}`);
  assert.ok(!text.includes(ROOT), `${what}: names the install folder\n${text.slice(0, 300)}`);
  assert.ok(!/\n\s+at /.test(text), `${what}: has a stack trace\n${text.slice(0, 300)}`);
  assert.ok(!/(^|[^\w:<.])\/[\w.-]+\/[\w.-]+/.test(text), `${what}: has an absolute path\n${text.slice(0, 300)}`);
}

const isJsonError = (r) => {
  assert.match(String(r.headers['content-type']), /application\/json/);
  const body = JSON.parse(r.text);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
  return body;
};

// ---------------------------------------------------------------- P1-1

test('a request without the token is turned away before its body is read: bad JSON gets a JSON 401, not a parse error with a stack trace', async () => {
  const hub = await start();
  const bad = await rawPost(hub, '/api/sessions', Buffer.from('{bad'), { 'content-type': 'application/json' });
  assert.equal(bad.status, 401, bad.text.slice(0, 200));
  isJsonError(bad);
  assertNoLeak(bad.text, 'anonymous bad JSON');
  // The same through a gzip-encoded body.
  const gz = await rawPost(hub, '/api/sessions', zlib.gzipSync('{bad'), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
  assert.equal(gz.status, 401, gz.text.slice(0, 200));
  assertNoLeak(gz.text, 'anonymous gzip bad JSON');
  // A wrong token is no better than none.
  const wrong = await rawPost(hub, '/api/sessions', Buffer.from('{bad'), { 'content-type': 'application/json', 'x-hub-token': 'nope' });
  assert.equal(wrong.status, 401);
  await stop(hub);
});

test('anonymous large and compressed bodies cost the Hub no memory (60 MB × 3 and a 70 MB gzip bomb, on the upload route with the biggest limit)', { skip: !HAS_PROC && 'needs /proc' }, async () => {
  const hub = await start();
  await sleep(300);
  const before = peakKb(hub.proc.pid);
  const t0 = Date.now();
  const answers = await Promise.all([1, 2, 3].map(() => postBig(hub, '/api/sessions', 60 * 1024 * 1024)));
  const bomb = await rawPost(hub, '/api/sessions/s1/messages', await gzipBomb(70 * 1024 * 1024), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
  const took = Date.now() - t0;
  for (const a of answers) assert.equal(a.status, 401, a.text.slice(0, 200));
  assert.equal(bomb.status, 401, bomb.text.slice(0, 200));
  const grewMb = (peakKb(hub.proc.pid) - before) / 1024;
  console.log(`# anonymous 3×60 MB + 70 MB gzip bomb: Hub peak memory grew ${grewMb.toFixed(0)} MB, ${took} ms`);
  // Reading even one of those bodies would cost at least its own size (60 MB).
  assert.ok(grewMb < 60, `Hub peak memory grew ${grewMb.toFixed(0)} MB while answering anonymous requests`);
  assert.ok(hub.alive());
  await stop(hub);
});

test('a signed-in request with bad JSON, a body over the limit or a missing route gets a JSON { error } with no stack trace and no path', async () => {
  const hub = await start();
  const json = { 'content-type': 'application/json' };
  const bad = await rawPost(hub, '/api/agents', Buffer.from('{bad'), { ...json, 'x-hub-token': TOKEN });
  assert.equal(bad.status, 400, bad.text.slice(0, 200));
  isJsonError(bad);
  assertNoLeak(bad.text, 'bad JSON');
  const badGz = await rawPost(hub, '/api/agents', zlib.gzipSync('{bad'), { ...json, 'content-encoding': 'gzip', 'x-hub-token': TOKEN });
  assert.equal(badGz.status, 400);
  assertNoLeak(badGz.text, 'bad gzip JSON');
  const notGz = await rawPost(hub, '/api/agents', Buffer.from('{"a":1}'), { ...json, 'content-encoding': 'gzip', 'x-hub-token': TOKEN });
  assert.ok(notGz.status >= 400 && notGz.status < 500, `a body that is not gzip: ${notGz.status}`);
  assertNoLeak(notGz.text, 'body that is not gzip');
  const unsupported = await rawPost(hub, '/api/agents', Buffer.from('{}'), { ...json, 'content-encoding': 'x-nope', 'x-hub-token': TOKEN });
  assert.equal(unsupported.status, 415);
  assertNoLeak(unsupported.text, 'unsupported encoding');
  const big = await postBig(hub, '/api/agents', 2 * 1024 * 1024, { token: TOKEN });
  assert.equal(big.status, 413, big.text.slice(0, 200));
  isJsonError(big);
  assertNoLeak(big.text, 'body over the limit');
  const none = await hub.api('/no-such-route');
  assert.equal(none.status, 404);
  isJsonError({ headers: Object.fromEntries(none.headers), text: await none.text() });
  assert.ok(hub.alive());
  await stop(hub);
});

test('the routes that take attachments and images keep their large limit; every other route is held to a small one', async () => {
  const hub = await start({ sessions: ['s_up'] });
  const pad = 3 * 1024 * 1024; // above the small limit, far below the large one
  // POST /api/sessions: it reads the body and then rejects the made-up provider.
  const create = await postBig(hub, '/api/sessions', pad, { token: TOKEN });
  assert.equal(create.status, 400, `${create.status} ${create.text.slice(0, 160)}`);
  // POST /api/sessions/:id/messages: it reads the body and then finds the message empty.
  const message = await postBig(hub, '/api/sessions/s_up/messages', pad, { token: TOKEN });
  assert.equal(message.status, 400, `${message.status} ${message.text.slice(0, 160)}`);
  assert.match(JSON.parse(message.text).error, /訊息是空的/);
  // Other routes: the same body is too large.
  for (const [p, status] of [
    ['/api/sessions/s_up/config', 413],
    ['/api/sessions/s_up/command', 413],
    ['/api/agents', 413],
    ['/api/deepseek/test', 413],
  ]) {
    const r = await postBig(hub, p, pad, { token: TOKEN });
    assert.equal(r.status, status, `${p}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  await stop(hub);
});

// A WebSocket upgrade request with a text frame of `size` bytes sent in the same write, so the
// Hub has the frame in hand the moment the socket is upgraded (before it can close it).
function upgradeWithFrame(port, pathName, size) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const head = [`GET ${pathName} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n');
    const mask = crypto.randomBytes(4);
    const frame = Buffer.concat([Buffer.from([0x81, 0xfe, size >> 8, size & 255]), mask, Buffer.alloc(size, 0x78).map((b, i) => b ^ mask[i % 4])]);
    socket.on('error', () => {});
    socket.on('close', () => resolve());
    socket.write(Buffer.concat([Buffer.from(head), frame]));
    setTimeout(() => (socket.destroy(), resolve()), 5000).unref();
  });
}

// ---------------------------------------------------------------- P1-2

test('no token on a public address: the Hub refuses to start; on this computer only it starts and warns', async () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
    const hub = await launch({ token: 'none', host });
    const code = await Promise.race([hub.exited, sleep(8000).then(() => 'still running')]);
    assert.equal(code, 1, `AGENT_HUB_TOKEN=none with HOST=${host} should exit 1\n${hub.log()}`);
    assert.match(hub.log(), /AGENT_HUB_TOKEN=none/, hub.log());
    assert.match(hub.log(), /HOST/, hub.log());
    assert.ok(!hub.log().includes('已啟動'), 'it must not have come up');
    hubs.delete(hub);
  }
  for (const host of [undefined, '127.0.0.1', 'localhost']) {
    const hub = await launch({ token: 'none', host });
    assert.equal(await hub.up, true, `HOST=${host}\n${hub.log()}`);
    assert.match(hub.log(), /警告[^\n]*AGENT_HUB_TOKEN=none|AGENT_HUB_TOKEN=none[^\n]*警告/, `no warning line for HOST=${host}\n${hub.log()}`);
    const open = await fetch(`http://${host || '127.0.0.1'}:${hub.port}/api/config`);
    assert.equal(open.status, 200, 'none still means no login here');
    await stop(hub);
  }
});

test('with no login, a page of another site cannot make the browser call the API either (Origin is checked on REST routes)', async () => {
  const hub = await start({ token: 'none' });
  const call = (headers) => rawPost(hub, '/api/sessions/s_none/interrupt', Buffer.alloc(0), headers);
  assert.equal((await call({})).status, 404, 'no Origin: a script on this computer');
  assert.equal((await call({ Origin: `http://127.0.0.1:${hub.port}` })).status, 404, 'the Hub\'s own page');
  for (const origin of ['https://evil.example', 'null', `http://localhost:${hub.port}`]) {
    const r = await call({ Origin: origin });
    assert.equal(r.status, 403, origin);
    isJsonError(r);
  }
  await stop(hub);
  // With a token, the custom header already keeps another site out: the Origin does not matter.
  const withToken = await start({ env: { AGENT_HUB_ALLOWED_ORIGINS: '' } });
  const r = await rawPost(withToken, '/api/sessions/s_none/interrupt', Buffer.alloc(0), { Origin: 'https://evil.example', 'x-hub-token': TOKEN });
  assert.equal(r.status, 404);
  await stop(withToken);
});

test('with a token, a public address is allowed (and the login still holds)', async () => {
  const hub = await start({ host: '0.0.0.0' });
  assert.ok(!/警告[^\n]*AGENT_HUB_TOKEN=none/.test(hub.log()));
  assert.equal((await fetch(hub.url('/api/config'))).status, 401);
  assert.equal((await hub.api('/config')).status, 200);
  await stop(hub);
});

function openSocket(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (req, res) => {
      resolve({ ok: false, status: res.statusCode });
      req.destroy();
    });
    ws.once('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
// The close code of a socket, or 'still open' if it is not closed within `ms` (a test must fail, never hang).
const closeCode = (ws, ms = 10_000) => new Promise((resolve) => {
  ws.once('close', (code) => resolve(code));
  setTimeout(() => resolve('still open'), ms).unref();
});

test('/ws and /bridge accept a browser only from the Hub\'s own origin (or one that is listed); a client with no Origin is let in as before', async () => {
  const hub = await start();
  const key = (await (await hub.api('/hub')).json()).bridgeKey;
  const ws = (headers) => openSocket(`ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`, headers);
  const bridge = (headers, k = key) => openSocket(`ws://127.0.0.1:${hub.port}/bridge?key=${encodeURIComponent(k)}`, headers);
  const closeBoth = (r) => r.ws?.terminate();

  // The page itself: its Origin is the address it was loaded from.
  let r = await ws({ Origin: `http://127.0.0.1:${hub.port}` });
  assert.equal(r.ok, true, 'same origin');
  closeBoth(r);
  // Behind a proxy or tunnel the Host is the public name and so is the Origin.
  r = await ws({ Host: 'hub.example.test', Origin: 'https://hub.example.test' });
  assert.equal(r.ok, true, 'same origin under another name');
  closeBoth(r);
  r = await ws({});
  assert.equal(r.ok, true, 'no Origin (a script, a connector)');
  closeBoth(r);
  // Another site\'s page, holding a valid token or not.
  for (const origin of ['https://evil.example', `http://127.0.0.1:${hub.port + 1}`, `http://localhost:${hub.port}`, 'null', 'file://']) {
    r = await ws({ Origin: origin });
    assert.deepEqual([r.ok, r.status], [false, 403], `Origin ${origin} should be refused`);
  }
  assert.equal((await ws({ Origin: 'https://evil.example' })).ok, false);
  // The token is still required, with or without an Origin.
  r = await openSocket(`ws://127.0.0.1:${hub.port}/ws?token=wrong`, {});
  assert.deepEqual([r.ok, r.status], [false, 401]);
  r = await openSocket(`ws://127.0.0.1:${hub.port}/ws?token=wrong`, { Origin: `http://127.0.0.1:${hub.port}` });
  assert.equal(r.ok, false);

  // The connector channel: no Origin (a Node program) + the key; a page is refused even with the key.
  r = await bridge({});
  assert.equal(r.ok, true, 'connector with the key');
  closeBoth(r);
  r = await bridge({ Origin: 'https://evil.example' });
  assert.deepEqual([r.ok, r.status], [false, 403], 'a page on another site, with the key');
  r = await bridge({}, 'bk_wrong');
  assert.equal(r.ok, true, 'a wrong key is still answered with the close code the connector understands');
  assert.equal(await closeCode(r.ws), 4401);
  assert.ok(hub.alive());
  await stop(hub);
});

test('AGENT_HUB_ALLOWED_ORIGINS lists extra origins that may open /ws', async () => {
  const hub = await start({ env: { AGENT_HUB_ALLOWED_ORIGINS: ' https://ok.example.test , https://other.example.test:8443/ ' } });
  const ws = (origin) => openSocket(`ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`, { Origin: origin });
  for (const origin of ['https://ok.example.test', 'https://other.example.test:8443']) {
    const r = await ws(origin);
    assert.equal(r.ok, true, origin);
    r.ws.terminate();
  }
  for (const origin of ['https://evil.example', 'http://ok.example.test', 'https://other.example.test', 'https://ok.example.test.evil.example']) {
    const r = await ws(origin);
    assert.deepEqual([r.ok, r.status], [false, 403], origin);
  }
  await stop(hub);
});

test('WebSocket frames over the limit close that socket (1009) and never take the Hub down; a connector can still send a big, legitimate frame', async () => {
  const hub = await start();
  const key = (await (await hub.api('/hub')).json()).bridgeKey;

  // A page sends tiny messages only: 1 MiB is the limit.
  const page = await openSocket(`ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`, {});
  assert.equal(page.ok, true);
  page.ws.on('error', () => {});
  const pageClosed = closeCode(page.ws);
  page.ws.send('x'.repeat(2 * 1024 * 1024));
  assert.equal(await pageClosed, 1009);
  assert.ok(hub.alive(), `the Hub died on an oversized page frame\n${hub.log().slice(-600)}`);

  // A connector\'s biggest legitimate frame is a 20 MB file read, as base64 (about 27 MB).
  const conn = await openSocket(`ws://127.0.0.1:${hub.port}/bridge?key=${encodeURIComponent(key)}`, {});
  assert.equal(conn.ok, true);
  conn.ws.on('error', () => {});
  conn.ws.send(JSON.stringify({ t: 'hello', machineId: 'm_big', name: 'big', platform: 'test', bridgeVersion: '0.3.0', home: '/h', status: { available: false } }));
  conn.ws.send(JSON.stringify({ t: 'res', id: 'nobody-waits', ok: true, data: { data: 'A'.repeat(27 * 1024 * 1024) } }));
  await sleep(1500);
  assert.equal(conn.ws.readyState, WebSocket.OPEN, 'a 27 MB connector frame must be accepted');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(hub.data, 'machines.json')).mode & 0o777).toString(8), '600', 'the list of connected computers the hello created');
  assert.equal((await hub.api('/hub')).status, 200);

  // Far beyond anything a connector sends: refused, that connection only.
  const closed = closeCode(conn.ws);
  conn.ws.send(JSON.stringify({ t: 'res', id: 'nobody-waits', ok: true, data: { data: 'A'.repeat(80 * 1024 * 1024) } }));
  assert.equal(await closed, 1009);
  assert.ok(hub.alive(), `the Hub died on an oversized connector frame\n${hub.log().slice(-600)}`);
  assert.equal((await hub.api('/hub')).status, 200);

  // A connector with a wrong key is shut out with 4401, and held to a tiny frame size while it is told so.
  const logged = hub.log().length;
  await upgradeWithFrame(hub.port, '/bridge?key=bk_wrong', 4096);
  const tooBig = () => /\[bridge\] socket closed: Max payload size exceeded/.test(hub.log().slice(logged));
  for (let i = 0; i < 100 && !tooBig(); i++) await sleep(30);
  assert.ok(tooBig(), `a 4 KB frame from a socket with the wrong key is over its limit\n${hub.log().slice(logged)}`);
  assert.ok(hub.alive(), `the Hub died on a frame from a wrong-key socket\n${hub.log().slice(-600)}`);
  await stop(hub);
});

// ---------------------------------------------------------------- P2

test('the token is read from the x-hub-token header on REST routes only; the WebSocket upgrade still takes it in the query', async () => {
  const hub = await start();
  assert.equal((await fetch(hub.url(`/api/config?token=${TOKEN}`))).status, 401, '?token= on a REST route');
  assert.equal((await fetch(hub.url('/api/config'), { headers: { 'x-hub-token': TOKEN } })).status, 200);
  const r = await openSocket(`ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`, {});
  assert.equal(r.ok, true, 'a WebSocket cannot carry a custom header');
  r.ws.terminate();
  await stop(hub);
});

test('every response carries the security headers; X-Powered-By is gone', async () => {
  const hub = await start();
  const seen = [
    await fetch(hub.url('/')),
    await fetch(hub.url('/js/app.js')),
    await fetch(hub.url('/vendor/marked.esm.js')),
    await fetch(hub.url('/api/config'), { headers: { 'x-hub-token': TOKEN } }),
    await fetch(hub.url('/api/config')), // a 401
    await fetch(hub.url('/s/some/page')),
    await fetch(hub.url('/.git/config')), // a 404
  ];
  for (const r of seen) {
    const where = `${r.url} (${r.status})`;
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', where);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', where);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', where);
    assert.equal(r.headers.get('x-powered-by'), null, where);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, where);
    assert.match(csp, /frame-ancestors 'none'/, where);
    assert.match(csp, /object-src 'none'/, where);
    assert.match(csp, /base-uri 'self'/, where);
  }
  await stop(hub);
});

const mode = (p) => fs.statSync(p).mode & 0o777;
const oct = (n) => n.toString(8);

test('a new data folder is created private (0700) with private files (0600)', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const hub = await start({ data: path.join(TMP, 'brand-new', 'data') });
  assert.equal(oct(mode(hub.data)), '700', 'data/');
  assert.equal(oct(mode(path.join(hub.data, 'sessions'))), '700', 'data/sessions/');
  for (const f of fs.readdirSync(hub.data).filter((n) => n.endsWith('.json'))) assert.equal(oct(mode(path.join(hub.data, f))), '600', `data/${f}`);
  assert.ok(fs.readdirSync(hub.data).includes('agents.json'), 'the check saw the files the Hub writes at start');
  assert.ok(!/權限/.test(hub.log()), `a folder the Hub just made needs no warning\n${hub.log()}`);
  await stop(hub);
});

test('an existing data folder is not chmod-ed, but a too-open one is warned about; files the Hub rewrites become 0600', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const data = path.join(TMP, 'old-open', 'data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.chmodSync(data, 0o755);
  fs.chmodSync(path.join(data, 'sessions'), 0o755);
  const file = path.join(data, 'sessions', 's_old.json');
  fs.writeFileSync(file, JSON.stringify(sessionRecord('s_old')), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const hub = await start({ data });
  assert.equal(oct(mode(data)), '755', 'an existing folder keeps its mode');
  const warning = hub.log().split('\n').filter((l) => /權限/.test(l));
  assert.equal(warning.length, 1, `exactly one warning line\n${hub.log()}`);
  assert.match(warning[0], /755/);
  assert.ok(warning[0].includes('chmod'), 'it says what to do');
  // The Hub rewrites the conversation file (a rename): the new file is private. First the
  // normal save, 1.5 s after the change ...
  const rename = (title) => hub.api('/sessions/s_old', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
  assert.equal((await rename('renamed')).status, 200);
  for (let i = 0; i < 200 && !fs.readFileSync(file, 'utf8').includes('renamed'); i++) await sleep(50);
  assert.ok(fs.readFileSync(file, 'utf8').includes('renamed'), 'the Hub saved the conversation');
  assert.equal(oct(mode(file)), '600', 'the conversation file after a normal save');
  // ... then the save at shutdown.
  fs.chmodSync(file, 0o644);
  assert.equal((await rename('renamed again')).status, 200);
  await stop(hub);
  assert.ok(fs.readFileSync(file, 'utf8').includes('renamed again'));
  assert.equal(oct(mode(file)), '600', 'the conversation file after the save at shutdown');
  assert.equal(oct(mode(data)), '755', 'the folder is still as it was');
});
