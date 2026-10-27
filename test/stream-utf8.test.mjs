// Text that comes out of a child process or a socket in pieces must be decoded
// as a stream: a multi-byte character (any Chinese character, an emoji) cut at
// a chunk boundary was turned into U+FFFD by decoding each chunk on its own.
//
// Property: whatever the byte offsets of the cuts, what the Hub (or the
// connector, or the Claude background program) hands on is the whole text.
// Every reader below is run for the same text cut at every byte offset of it,
// and at random pairs of offsets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { runCommand } from '../server/tools.js';
import * as cli from '../server/adapters/cli.js';
import * as acp from '../server/adapters/acp.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WRITER = path.join(ROOT, 'test/fixtures/split-writer.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-utf8-'));

const TEXT = '完成：修復中文輸出 🙂 與 emoji 🚀、ñ é — 結束';
const BYTES = Buffer.from(TEXT);
const b64 = (s) => Buffer.from(s).toString('base64');
// Offsets that fall inside a multi-byte character: the cuts that matter.
const inside = [];
for (let i = 1; i < BYTES.length; i++) if ((BYTES[i] & 0xc0) === 0x80) inside.push(i);
// A fixed pseudo-random sequence, so a failure is reproducible.
let seed = 20261027;
const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
const pairs = Array.from({ length: 12 }, () => {
  const a = 1 + rand(BYTES.length - 2);
  const b = 1 + rand(BYTES.length - 2);
  return [Math.min(a, b), Math.max(a, b)].join(',');
});
const CUTS = [...inside.map(String), ...pairs];

// Run `fn` for every cut set, a few at a time.
async function eachCut(fn, width = 8) {
  const queue = [...CUTS];
  await Promise.all(Array.from({ length: width }, async () => {
    while (queue.length) {
      const cuts = queue.shift();
      await fn(cuts);
    }
  }));
}
const shEsc = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test('the cut offsets really cut characters in the middle (the property is not vacuous)', () => {
  assert.ok(inside.length > 30, `${inside.length} offsets inside a character`);
  assert.ok(BYTES.length > TEXT.length * 1.5);
});

test('bash tool output: the text is whole whatever the cuts, on stdout and on stderr', async () => {
  for (const stream of ['stdout', 'stderr']) {
    await eachCut(async (cuts) => {
      const chunks = [];
      const r = await runCommand(`${shEsc(process.execPath)} ${shEsc(WRITER)} raw ${b64(TEXT)} ${cuts} ${stream}`, { cwd: TMP, onData: (s) => chunks.push(s) });
      assert.equal(r.exitCode, 0);
      assert.equal(r.output, TEXT, `${stream} cut at ${cuts}`);
      assert.ok(!chunks.join('').includes('�'), `${stream} streamed to the page cut at ${cuts}`);
      assert.equal(chunks.join(''), TEXT);
    });
  }
});

test('bash tool output: a character cut off by the end of the stream is flushed, not dropped', async () => {
  // Three bytes of a four-byte emoji, then the process ends: the reader must
  // say so (U+FFFD) rather than lose the text before it.
  const r = await runCommand(`printf 'ok \\xf0\\x9f\\x99'`, { cwd: TMP });
  assert.match(r.output, /^ok �/);
});

test('the generic CLI adapter: terminal output is whole whatever the cuts', async () => {
  await eachCut(async (cuts) => {
    const events = [];
    const ctx = {
      agent: { command: process.execPath, args: [WRITER, 'raw', b64(`${TEXT}\n`), cuts] },
      session: { cwd: TMP, permissionMode: 'ask' },
      previousTranscript: () => '',
      signal: new AbortController().signal,
      emit: (f) => (events.push({ ...f }), events.at(-1)),
      delta: (ev, text) => (ev.text += text),
    };
    await cli.run(ctx, 'hi');
    assert.equal(events.map((e) => e.text).join(''), `${TEXT}\n`, `cut at ${cuts}`);
  });
});

test('the ACP adapter: a JSON line from the agent is whole whatever the cuts', async () => {
  // `initialize` answers with the title; the cuts are offsets into the JSON line.
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { title: TEXT, version: '1' }, agentCapabilities: {} } })}\n`);
  const start = line.indexOf(Buffer.from(TEXT));
  const cutsOf = [...inside.map((i) => String(start + i)), ...pairs.map((p) => p.split(',').map((x) => start + Number(x)).join(','))];
  const queue = [...cutsOf];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const cuts = queue.shift();
      const said = await acp.test({ name: 'fixture', command: process.execPath, args: [WRITER, 'acp', b64(TEXT), cuts] });
      assert.ok(said.includes(TEXT), `cut at ${cuts}: ${said}`);
    }
  }));
});

// ------------------------------------------------------- the connector's own shell

let wss;
let bridge;
const answers = new Map();
let helloSocket;
let bridgeLog = '';
const KIMI_HOME = path.join(TMP, 'kimi');
const STATE_DIR = path.join(TMP, 'state');
before(async () => {
  wss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => wss.on('listening', r));
  const connected = new Promise((resolve) =>
    wss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') (helloSocket = ws), resolve();
        if (m.t === 'res') answers.get(m.id)?.(m);
      });
    }),
  );
  fs.mkdirSync(path.join(TMP, 'kimi'), { recursive: true });
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${wss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], {
    env: { ...process.env, HOME: TMP },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (d) => (bridgeLog += d));
  await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('the connector did not connect')), 15000))]);
});
after(() => {
  bridge?.kill('SIGTERM');
  wss?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let reqNo = 0;
const ask = (op, args) =>
  new Promise((resolve, reject) => {
    const id = `r${++reqNo}`;
    const t = setTimeout(() => reject(new Error(`no answer to ${op}`)), 15000);
    answers.set(id, (m) => (clearTimeout(t), resolve(m)));
    helloSocket.send(JSON.stringify({ t: 'req', id, op, args }));
  });

test('the connector\'s shell (sh.run) returns the text whole whatever the cuts', async () => {
  await eachCut(async (cuts) => {
    const id = `sh_${cuts.replace(/,/g, '_')}`;
    const m = await ask('sh.run', { cwd: TMP, id, command: `${shEsc(process.execPath)} ${shEsc(WRITER)} raw ${b64(TEXT)} ${cuts}` });
    assert.equal(m.ok, true);
    assert.equal(m.data.output, TEXT, `cut at ${cuts}`);
  }, 6);
});

test('the connector\'s local channel (a terminal Kimi saying hello) reads a line whole whatever the cuts', async () => {
  // Where the connector listens: next to its state, named by its Kimi home.
  const tag = crypto.createHash('sha1').update(KIMI_HOME).digest('hex').slice(0, 10);
  const sock = path.join(STATE_DIR, `bridge-${tag}.sock`);
  assert.ok(sock.length < 100 && fs.existsSync(sock), `the local channel is at ${sock}`);
  const cwd = `/work/專案/修復🙂/${TEXT}`;
  const cwdBytes = Buffer.from(cwd);
  const offsets = [];
  for (let i = 1; i < cwdBytes.length; i++) if ((cwdBytes[i] & 0xc0) === 0x80) offsets.push(i);
  let n = 0;
  for (const off of offsets.filter((_, i) => i % 3 === 0)) {
    const pid = 4300 + n++;
    const one = Buffer.from(`${JSON.stringify({ t: 'hello', pid, cwd })}\n`);
    const at = one.indexOf(cwdBytes) + off;
    const c = net.createConnection(sock);
    await new Promise((r) => c.once('connect', r));
    c.write(one.subarray(0, at));
    await new Promise((r) => setTimeout(r, 40));
    c.end(one.subarray(at));
    const seen = `（pid ${pid}，${cwd}）`;
    const end = Date.now() + 5000;
    while (!bridgeLog.includes(seen) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(bridgeLog.includes(seen), `cut ${off} bytes into the path: the connector saw ${JSON.stringify(bridgeLog.split('\n').filter((l) => l.includes(`pid ${pid}`)))}`);
  }
});
