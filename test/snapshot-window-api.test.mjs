// Opening a big conversation sends only its newest window, not the whole
// history: the snapshot (HTTP) carries the last events of the chain and says
// where they sit (`window: { total, firstIndex, hasEarlier }`); older ones come
// page by page from GET /events?before=; one huge field in a window event is
// cut to a preview (`truncated`) and fetched whole from /events/:id?full=1;
// nothing cut for the page is ever written back to disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-window-'));
const DATA = path.join(TMP, 'data');
const PORT = 30000 + Math.floor(Math.random() * 900);
let server;
let log = '';

const WINDOW_EVENTS = 20;
const PAGE_BYTES = 6000;
const FIELD_LIMIT = 16384;
const PREVIEW = 4096;

const node = (id, patch) => ({
  id, conversationId: id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {},
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1000, updatedAt: 1000, provider: 'kimi',
  agentId: 'plain', cwd: TMP, meta: {}, seq: 0, ...patch,
});
const put = (s) => fs.writeFileSync(path.join(DATA, 'sessions', `${s.id}.json`), JSON.stringify(s));
const text = (id, ts, extra = {}) => ({ id, ts, type: 'text', text: `event ${id}`, ...extra });

// Three nodes whose events interleave in time: a0 b0 a1 b1 … then all of c.
const A = Array.from({ length: 30 }, (_, i) => text(`a${i}`, 1000 + i * 10));
const B = Array.from({ length: 30 }, (_, i) => text(`b${i}`, 1005 + i * 10));
const C = Array.from({ length: 30 }, (_, i) => text(`c${i}`, 5000 + i));
const CHAIN_ORDER = [...A.flatMap((a, i) => [a.id, B[i].id]), ...C.map((c) => c.id)];

const big = (n, ch = 'x') => ch.repeat(n);
const BIG_OUTPUT = big(100_000, 'o');
const BIG_THINK = `想${big(40_000, '法')}`; // multi-byte: 40k characters, 120k bytes
const BIG_INPUT = { path: '/tmp/x.txt', content: big(50_000, 'c') };
const IMAGES = [{ mime: 'image/png', data: big(20_000, 'i') }];

const get = (p, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: `/api${p}`, headers }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = raw.toString('utf8'); }
        resolve({ status: r.statusCode, headers: r.headers, wireBytes: raw.length, body: json });
      });
    }).on('error', reject);
  });
const call = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (events) => events.map((e) => e.id);

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  put(node('s_a', { continuedTo: 's_b', events: A }));
  put(node('s_b', { continuedFrom: 's_a', continuedTo: 's_c', conversationId: 's_a', events: B }));
  put(node('s_c', { continuedFrom: 's_b', conversationId: 's_a', events: C, seq: 77 }));
  put(node('s_small', { events: [text('m0', 1), text('m1', 2), text('m2', 3)] }));
  // Events of ~2 KB each: a page of 6000 bytes holds two or three of them.
  put(node('s_fat', { events: Array.from({ length: 12 }, (_, i) => text(`f${i}`, 100 + i, { text: big(2000, String(i % 10)) })) }));
  put(node('s_huge', {
    events: [
      { id: 'u1', ts: 1, type: 'user', text: 'run it', images: IMAGES },
      { id: 'tool_big', ts: 2, type: 'tool_use', name: 'Bash', title: 'cat big', status: 'done', input: { command: 'cat big' }, output: BIG_OUTPUT, isError: false },
      { id: 'think_big', ts: 3, type: 'thinking', text: BIG_THINK },
      { id: 'write_big', ts: 4, type: 'tool_use', name: 'Write', title: 'x.txt', status: 'done', input: BIG_INPUT, display: { kind: 'file_io', diff: big(30_000, 'd') }, output: 'ok' },
      { id: 'tool_run', ts: 5, type: 'tool_use', name: 'Write', title: 'big.txt', status: 'pending', argsText: BIG_OUTPUT },
      { id: 'page', ts: 7, type: 'tool_use', name: 'Write', title: 'progress.html', status: 'done', input: { path: '/work/progress.html', content: `<html>${big(60_000, 'p')}</html>` }, output: 'ok' },
      { id: 'tool_small', ts: 6, type: 'tool_use', name: 'Bash', title: 'ls', status: 'done', input: { command: 'ls' }, output: 'a\nb' },
    ],
  }));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'),
      AGENT_HUB_WINDOW_EVENTS: String(WINDOW_EVENTS), AGENT_HUB_WINDOW_TURNS: '1000', AGENT_HUB_PAGE_BYTES: String(PAGE_BYTES),
      AGENT_HUB_FIELD_LIMIT: String(FIELD_LIMIT), AGENT_HUB_PREVIEW_BYTES: String(PREVIEW),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 15000);
    server.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
  });
});
after(() => {
  server?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the snapshot holds only the newest window of the whole chain, in chain order, and says where it sits', async () => {
  const r = await get('/sessions/s_c');
  assert.equal(r.status, 200);
  const s = r.body;
  assert.deepEqual(ids(s.events), CHAIN_ORDER.slice(-WINDOW_EVENTS));
  assert.deepEqual(s.window, { total: 90, firstIndex: 70, hasEarlier: true });
  assert.equal(s.seq, 77, 'the stream position is the snapshot\'s, whatever part of the history it carries');
  assert.deepEqual(s.chain.map((n) => n.id), ['s_a', 's_b', 's_c'], 'the chain is still described whole');
  assert.ok(s.events.every((e) => e.nodeId === 's_c' && e.conversationId === 's_a' && e.nodeIndex === 2), 'each event keeps its node');
});

test('an old node of the chain gets the same window as the leaf (index counted along the whole chain)', async () => {
  const viaOld = (await get('/sessions/s_a')).body;
  const viaLeaf = (await get('/sessions/s_c')).body;
  assert.deepEqual(ids(viaOld.events), ids(viaLeaf.events));
  assert.deepEqual(viaOld.window, viaLeaf.window);
  assert.equal(viaOld.redirectedFrom, 's_a');
});

test('paging and single events work through the id of an old node of the chain, like through the leaf', async () => {
  const viaOld = (await get('/sessions/s_a/events?before=70&limit=10')).body;
  const viaLeaf = (await get('/sessions/s_c/events?before=70&limit=10')).body;
  assert.deepEqual(viaOld, viaLeaf);
  assert.deepEqual(ids(viaOld.events), CHAIN_ORDER.slice(60, 70));
  assert.equal((await get('/sessions/s_b/events/c5?full=1')).body.event.nodeId, 's_c', 'an event of the leaf, asked through a node before it');
});

test('a page from the interleaved part of the chain keeps each event\'s own node', async () => {
  // Chain order is a0 b0 a1 b1 … so index 4..9 alternates between node a and node b.
  const page = (await get('/sessions/s_c/events?before=10&limit=6')).body;
  assert.deepEqual(ids(page.events), CHAIN_ORDER.slice(4, 10));
  assert.deepEqual(page.events.map((e) => e.nodeId), ['s_a', 's_b', 's_a', 's_b', 's_a', 's_b']);
  assert.deepEqual(page.events.map((e) => e.nodeIndex), [0, 1, 0, 1, 0, 1]);
});

test('?window=all is the whole history, as before, with no window field', async () => {
  const s = (await get('/sessions/s_c?window=all')).body;
  assert.deepEqual(ids(s.events), CHAIN_ORDER);
  assert.equal(s.window, undefined);
});

test('a conversation that fits is returned whole and says nothing is earlier', async () => {
  const s = (await get('/sessions/s_small')).body;
  assert.deepEqual(ids(s.events), ['m0', 'm1', 'm2']);
  assert.deepEqual(s.window, { total: 3, firstIndex: 0, hasEarlier: false });
});

test('paging back with before= reaches every older event exactly once, in order, whatever the page size', async () => {
  for (const limit of [1, 7, 13, 50]) {
    const first = (await get('/sessions/s_c')).body;
    let before = first.window.firstIndex;
    const older = [];
    let guard = 0;
    for (;;) {
      const r = (await get(`/sessions/s_c/events?before=${before}&limit=${limit}`)).body;
      assert.ok(r.events.length >= 1 && r.events.length <= limit, `page of ${r.events.length} for limit ${limit}`);
      assert.equal(r.firstIndex, before - r.events.length, 'firstIndex counts down by exactly what was returned');
      assert.equal(r.hasEarlier, r.firstIndex > 0);
      older.unshift(...ids(r.events));
      before = r.firstIndex;
      if (!r.hasEarlier) break;
      assert.ok(++guard < 200, 'paging must end');
    }
    assert.deepEqual([...older, ...ids(first.events)], CHAIN_ORDER, `limit ${limit}: nothing missing, nothing repeated`);
  }
});

test('before=0 has nothing earlier; a before beyond the end is the newest page; bad numbers are refused', async () => {
  const none = (await get('/sessions/s_c/events?before=0&limit=5')).body;
  assert.deepEqual(none, { events: [], firstIndex: 0, hasEarlier: false, total: 90 });
  const tail = (await get('/sessions/s_c/events?before=9999&limit=3')).body;
  assert.deepEqual(ids(tail.events), CHAIN_ORDER.slice(-3));
  assert.equal(tail.firstIndex, 87);
  for (const q of ['before=-1', 'before=abc', 'before=1.5', 'before=5&limit=0', 'before=5&limit=x']) {
    assert.equal((await get(`/sessions/s_c/events?${q}`)).status, 400, q);
  }
  assert.equal((await get('/sessions/s_nope/events?before=3')).status, 404);
});

test('a page follows an event id when the history shifted under the index (older events slipped in)', async () => {
  // The client says "before the event I show first": the id wins over a stale index.
  const r = (await get('/sessions/s_c/events?before=3&beforeId=c0&limit=2')).body;
  assert.deepEqual(ids(r.events), CHAIN_ORDER.slice(58, 60));
  assert.equal(r.firstIndex, 58);
  assert.equal((await get('/sessions/s_c/events?before=3&beforeId=e_unknown&limit=2')).status, 404);
});

test('a page has a byte budget too: long events make it shorter than the limit, never empty', async () => {
  const r = (await get('/sessions/s_fat/events?before=12&limit=100')).body;
  assert.ok(r.events.length >= 1 && r.events.length < 12, `only part of it fits (${r.events.length})`);
  const bytes = Buffer.byteLength(JSON.stringify(r.events));
  assert.ok(r.events.length === 1 || bytes <= PAGE_BYTES * 1.2, `${bytes} bytes for a ${PAGE_BYTES} budget`);
  assert.equal(r.hasEarlier, r.firstIndex > 0);
  // …and the window itself, being events-bound here, is not cut by the page budget.
  const s = (await get('/sessions/s_fat')).body;
  assert.equal(s.events.length, 12);
});

test('a field above the limit is cut to a preview in the snapshot and marked; what is small is untouched', async () => {
  const s = (await get('/sessions/s_huge')).body;
  const byId = Object.fromEntries(s.events.map((e) => [e.id, e]));
  const out = byId.tool_big;
  assert.ok(Buffer.byteLength(out.output) <= PREVIEW, 'preview, not the whole output');
  assert.ok(BIG_OUTPUT.startsWith(out.output) && out.output.length > 100, 'the preview is the start of the output');
  assert.deepEqual(out.truncated.field, 'output');
  assert.equal(out.truncated.bytes, BIG_OUTPUT.length);
  assert.equal(out.input.command, 'cat big');
  assert.equal(out.status, 'done');

  const think = byId.think_big;
  assert.ok(Buffer.byteLength(think.text) <= PREVIEW && BIG_THINK.startsWith(think.text), 'multi-byte text is cut on a character, within the byte limit');
  assert.ok(!think.text.includes('�'));
  assert.equal(think.truncated.field, 'text');
  assert.equal(think.truncated.bytes, Buffer.byteLength(BIG_THINK));

  const wr = byId.write_big;
  assert.equal(wr.input.path, '/tmp/x.txt', 'an object keeps its shape; only its long strings are cut');
  assert.ok(Buffer.byteLength(wr.input.content) <= PREVIEW && BIG_INPUT.content.startsWith(wr.input.content));
  assert.ok(wr.truncated.fields.input > FIELD_LIMIT && wr.truncated.fields.display > FIELD_LIMIT);
  assert.ok(['input', 'display'].includes(wr.truncated.field));
  assert.equal(wr.output, 'ok');

  assert.equal(byId.page.input.content.length, 60_000 + 13, 'a page written for the Artifact panel is whole');
  assert.equal(byId.page.truncated, undefined);
  assert.equal(byId.tool_small.truncated, undefined);
  assert.equal(byId.tool_small.output, 'a\nb');
  assert.deepEqual(byId.u1.images, IMAGES, 'an image cannot be shown cut: kept whole');
  assert.equal(byId.u1.truncated, undefined);
});

test('an event that is still being written (pending) is sent whole: later deltas must be able to continue it', async () => {
  const run = (await get('/sessions/s_huge')).body.events.find((e) => e.id === 'tool_run');
  assert.equal(run.argsText, BIG_OUTPUT);
  assert.equal(run.truncated, undefined);
});

test('the whole event is fetched from /events/:id?full=1; without full it is the same preview as in the snapshot', async () => {
  const full = (await get('/sessions/s_huge/events/tool_big?full=1')).body.event;
  assert.equal(full.output, BIG_OUTPUT);
  assert.equal(full.truncated, undefined);
  assert.equal(full.nodeId, 's_huge');
  const think = (await get('/sessions/s_huge/events/think_big?full=1')).body.event;
  assert.equal(think.text, BIG_THINK);
  const write = (await get('/sessions/s_huge/events/write_big?full=1')).body.event;
  assert.deepEqual(write.input, BIG_INPUT);
  assert.equal(write.display.diff.length, 30_000);
  const cut = (await get('/sessions/s_huge/events/tool_big')).body.event;
  assert.ok(Buffer.byteLength(cut.output) <= PREVIEW && cut.truncated.field === 'output');
  assert.equal((await get('/sessions/s_huge/events/e_nope?full=1')).status, 404);
  // An event of an earlier node of the chain is found through the leaf.
  const old = (await get('/sessions/s_c/events/a3?full=1')).body.event;
  assert.equal(old.nodeId, 's_a');
});

test('what was cut for the page is never written back: the file still holds the whole output after a save', async () => {
  await get('/sessions/s_huge'); // opened (snapshot taken)
  const r = await call('PATCH', '/sessions/s_huge', { title: 'renamed so it is saved' });
  assert.equal(r.status, 200);
  const file = path.join(DATA, 'sessions', 's_huge.json');
  let saved;
  for (let i = 0; i < 100 && saved?.title !== 'renamed so it is saved'; i++) {
    await sleep(100);
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  assert.equal(saved.title, 'renamed so it is saved', 'it was saved');
  const byId = Object.fromEntries(saved.events.map((e) => [e.id, e]));
  assert.equal(byId.tool_big.output, BIG_OUTPUT);
  assert.equal(byId.tool_big.truncated, undefined);
  assert.equal(byId.think_big.text, BIG_THINK);
  assert.deepEqual(byId.write_big.input, BIG_INPUT);
  assert.equal(saved.events.length, 7);
  assert.equal(byId.tool_run.argsText, BIG_OUTPUT);
});
