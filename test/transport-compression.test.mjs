// What travels between the Hub and a page is compressed when it is big and
// the other side can take it: JSON answers over HTTP (gzip, Node's zlib) and
// the page's WebSocket (permessage-deflate above 1 KB). Small messages go out
// as they are, a client that did not ask gets none, and the answer is the same
// message either way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fakeMachine, rawSocket, sleep, until } from './hub-ws-fixtures.mjs';
import { acceptsGzip } from '../server/http-compress.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-compress-'));
const DATA = path.join(TMP, 'data');
const PORT = 31800 + Math.floor(Math.random() * 900);
const TOKEN = 'compress-token';
const KID = 'session_compress1';
let hub;
let machine;
let live;

const get = (p, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: `/api${p}`, headers: { 'x-hub-token': TOKEN, ...headers } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const raw = Buffer.concat(chunks);
        const body = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw;
        resolve({ status: r.statusCode, headers: r.headers, wireBytes: raw.length, text: body.toString('utf8') });
      });
    }).on('error', reject);
  });

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  const now = Date.now();
  // A stored conversation with a lot of (repetitive, as real output is) text.
  fs.writeFileSync(path.join(DATA, 'sessions', 's_fat.json'), JSON.stringify({
    id: 's_fat', conversationId: 's_fat', title: 'fat', status: 'idle', permissionMode: 'ask', allowedTools: [], state: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now, updatedAt: now, provider: 'kimi', agentId: 'plain', cwd: TMP, meta: {}, seq: 5,
    events: Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, ts: i + 1, type: 'text', text: `paragraph ${i}: ${'the quick brown fox jumps over the lazy dog '.repeat(20)}` })),
  }));
  fs.writeFileSync(path.join(DATA, 'sessions', 's_tiny.json'), JSON.stringify({
    id: 's_tiny', conversationId: 's_tiny', title: 'tiny', status: 'idle', permissionMode: 'ask', allowedTools: [], state: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now, updatedAt: now, provider: 'kimi', agentId: 'plain', cwd: TMP, meta: {}, seq: 0, events: [{ id: 't0', ts: 1, type: 'text', text: 'hi' }],
  }));
  hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: TOKEN, AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_WINDOW_EVENTS: '40', AGENT_HUB_WINDOW_LATEST_EVENTS: '40' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => hub.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
  machine = fakeMachine({ port: PORT, key: JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey, kid: KID, machineId: 'm_c' });
  await machine.ready;
  await until(async () => (await get('/machines')).text.includes(KID), 10000, 'machine');
  live = JSON.parse((await (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/machines/m_c/kimi/${KID}/attach`, { method: 'POST', headers: { 'x-hub-token': TOKEN } });
    return r.text();
  })())).id;
});

after(() => {
  machine?.ws.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the Accept-Encoding header is read the way HTTP says: gzip or *, unless refused with q=0', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('GZIP'), true);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('br;q=1.0, gzip;q=0.8'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0, identity'), false);
  assert.equal(acceptsGzip('identity'), false);
  assert.equal(acceptsGzip('deflate, br'), false);
  assert.equal(acceptsGzip(''), false);
  assert.equal(acceptsGzip(undefined), false);
});

test('big JSON answers are gzip-compressed for a client that accepts it; small ones and refusals are not', async () => {
  const plain = await get('/sessions/s_fat', { 'accept-encoding': 'identity' });
  assert.equal(plain.headers['content-encoding'], undefined);
  const gz = await get('/sessions/s_fat', { 'accept-encoding': 'gzip, deflate' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.match(String(gz.headers.vary), /Accept-Encoding/i);
  assert.equal(gz.text, plain.text, 'the same answer, byte for byte, once unpacked');
  assert.ok(gz.wireBytes < plain.wireBytes / 3, `${gz.wireBytes} on the wire against ${plain.wireBytes}`);
  assert.equal(JSON.parse(gz.text).events.length, 40);

  const list = await get('/sessions', { 'accept-encoding': 'gzip' });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(JSON.parse(list.text)), 'every JSON answer of the API goes through it, the list too');

  const small = await get('/sessions/s_tiny/events?before=0', { 'accept-encoding': 'gzip' });
  assert.equal(small.headers['content-encoding'], undefined, 'too small to be worth it');
  assert.deepEqual(JSON.parse(small.text), { events: [], firstIndex: 0, hasEarlier: false, total: 1 });

  const refused = await get('/sessions/s_fat', { 'accept-encoding': 'gzip;q=0, identity' });
  assert.equal(refused.headers['content-encoding'], undefined, 'gzip;q=0 means no gzip');
  const unknown = await get('/sessions/s_fat');
  assert.equal(unknown.headers['content-encoding'], undefined, 'no Accept-Encoding, no compression');
  const error = await get('/sessions/s_nope', { 'accept-encoding': 'gzip' });
  assert.equal(error.status, 404);
  assert.match(error.text, /找不到/);
});

test('the socket compresses a big snapshot and leaves the small frames alone', async () => {
  const on = await rawSocket({ port: PORT, token: TOKEN, deflate: true });
  assert.match(on.negotiated, /permessage-deflate/);
  assert.match(on.negotiated, /server_no_context_takeover/, 'no memory held per connection between messages');
  const hello = await on.frame((t) => t.includes('"hello"'));
  assert.equal(hello.rsv1, false, 'a hello is too small to be worth compressing');
  on.send(JSON.stringify({ t: 'watch', sid: 's_fat' }));
  const snap = await on.frame((t) => t.startsWith('{"t":"snapshot"'));
  assert.equal(snap.rsv1, true, 'the snapshot travels compressed');
  assert.ok(snap.wireBytes < snap.textBytes / 3, `${snap.wireBytes} on the wire for ${snap.textBytes}`);
  assert.equal(JSON.parse(snap.text).session.window.hasEarlier, true);

  // A client that did not ask for compression gets none.
  const off = await rawSocket({ port: PORT, token: TOKEN, deflate: false });
  assert.doesNotMatch(off.negotiated, /permessage-deflate/);
  off.send(JSON.stringify({ t: 'watch', sid: 's_fat' }));
  const plain = await off.frame((t) => t.startsWith('{"t":"snapshot"'));
  assert.equal(plain.rsv1, false);
  assert.equal(plain.text, snap.text, 'the same message either way');
  on.close();
  off.close();
});

test('a small stream message is not compressed even on a socket that negotiated compression', async () => {
  const on = await rawSocket({ port: PORT, token: TOKEN, deflate: true });
  on.send(JSON.stringify({ t: 'watch', sid: live }));
  await on.frame((t) => t.startsWith('{"t":"snapshot"'));
  machine.frame('turn.started', { turnId: 't10', promptId: 'p10', origin: { kind: 'user' }, prompt: '小訊息' });
  await sleep(250); // the summaries a new turn brings go out first
  machine.frame('assistant.delta', { turnId: 't10', delta: 'tiny-delta-marker' });
  const small = await on.frame((t) => t.includes('tiny-delta-marker'));
  assert.ok(small.textBytes < 1024, `${small.textBytes} bytes`);
  assert.equal(small.rsv1, false);
  assert.equal(small.wireBytes, small.textBytes + 4, 'a 4-byte header and the text as it is, nothing else');
  machine.frame('turn.ended', { turnId: 't10', reason: 'completed' });
  on.close();
});
