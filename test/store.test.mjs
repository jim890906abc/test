// Saving conversations (server/store.js): written in slices in the
// background, the same JSON as written in one go; never brought back after
// being deleted mid-write; flushed whole on shutdown. A big conversation is
// never turned into one giant string or buffer (the event loop would stand
// still for that long), the old file stays whole until the new one is on disk,
// and many changes in a short time make one write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-store-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');
const file = (id) => path.join(TMP, 'sessions', `${id}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (n) => Array.from({ length: n }, (_, i) => ({ id: `e_${i}`, type: i % 2 ? 'text' : 'tool_use', text: `第 ${i} 段 "引號" \\ 反斜線 \n 換行`, output: 'x'.repeat(i % 50), nested: { a: [i, null, true] } }));

test('written in slices, it is the same JSON as written in one go', async () => {
  for (const n of [0, 1, 199, 200, 201, 1234]) {
    const s = { id: 's', title: '標題', meta: { models: [{ id: 'm' }] }, events: big(n), usage: { inputTokens: 1 } };
    const sliced = await store.jsonInSlices(s, 'events');
    assert.deepEqual(JSON.parse(sliced), s, `${n} events`);
  }
  assert.deepEqual(JSON.parse(await store.jsonInSlices({ events: big(3) }, 'events')), { events: big(3) });
});

test('saved in the background; changes made meanwhile get written too', async () => {
  const s = store.createSession({ title: '存檔', events: big(3000) });
  await sleep(50);
  s.events.push({ id: 'last', type: 'text', text: '最後一筆' });
  store.saveSession(s, { immediate: true });
  await (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if (JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.at(-1)?.id === 'last') return;
      } catch {}
      await sleep(20);
    }
    throw new Error('not written');
  })();
});

test('deleted while being written, it does not come back', async () => {
  const s = store.createSession({ title: '要刪掉', events: big(5000) });
  store.saveSession(s, { immediate: true });
  store.deleteSession(s.id);
  await sleep(500);
  assert.equal(fs.existsSync(file(s.id)), false);
  assert.deepEqual(fs.readdirSync(path.join(TMP, 'sessions')).filter((f) => f.endsWith('.tmp')), []);
});

// Watches what the store does with files under sessions/: which calls, in what
// order, and how big each piece written is.
function spyOnDisk({ beforeWrite } = {}) {
  const log = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  const realRename = fs.renameSync;
  const realWriteFile = fs.promises.writeFile.bind(fs.promises);
  const mine = (f) => String(f).includes(`${path.sep}sessions${path.sep}`);
  fs.promises.open = async (f, ...rest) => {
    const fh = await realOpen(f, ...rest);
    if (!mine(f)) return fh;
    log.push({ op: 'open', file: String(f) });
    const write = fh.write.bind(fh);
    const sync = fh.sync.bind(fh);
    const close = fh.close.bind(fh);
    fh.write = async (data, ...r) => (log.push({ op: 'write', bytes: Buffer.byteLength(data), file: String(f) }), beforeWrite?.(String(f)), write(data, ...r));
    fh.sync = async () => (log.push({ op: 'sync', file: String(f) }), sync());
    fh.close = async () => (log.push({ op: 'close', file: String(f) }), close());
    return fh;
  };
  fs.promises.writeFile = async (f, data, ...r) => (mine(f) && log.push({ op: 'writeFile', bytes: Buffer.byteLength(data), file: String(f) }), realWriteFile(f, data, ...r));
  fs.renameSync = (a, b) => (mine(a) && log.push({ op: 'rename', from: String(a), to: String(b) }), realRename(a, b));
  return {
    log,
    restore() {
      fs.promises.open = realOpen;
      fs.promises.writeFile = realWriteFile;
      fs.renameSync = realRename;
    },
  };
}

test('a big conversation is written piece by piece: no piece is much larger than the budget', async () => {
  const s = store.createSession({ title: '很大', events: [] });
  await store.persistNow(s);
  s.events = Array.from({ length: 4000 }, (_, i) => ({ id: `e_${i}`, type: 'text', text: `行 ${i} ${'內容'.repeat(300)}` })); // ~2.6 MB
  const spy = spyOnDisk();
  try {
    await store.persistNow(s);
  } finally {
    spy.restore();
  }
  const writes = spy.log.filter((x) => x.op === 'write' || x.op === 'writeFile');
  const total = writes.reduce((a, x) => a + x.bytes, 0);
  assert.ok(total > 2_000_000, `the whole conversation went out (${total} bytes)`);
  assert.equal(writes.filter((x) => x.op === 'writeFile').length, 0, 'never as one writeFile of everything');
  assert.ok(writes.length >= 8, `in pieces (${writes.length})`);
  assert.ok(Math.max(...writes.map((x) => x.bytes)) < 700_000, `largest piece ${Math.max(...writes.map((x) => x.bytes))} bytes`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events, s.events, 'and it is the same conversation on disk');
});

test('one event larger than the budget is still written, whole', async () => {
  const s = store.createSession({ title: '一個超大事件', events: [{ id: 'huge', type: 'tool_use', output: 'z'.repeat(3_000_000) }, { id: 'after', type: 'text', text: 'ok' }] });
  await store.persistNow(s);
  const disk = JSON.parse(fs.readFileSync(file(s.id), 'utf8'));
  assert.equal(disk.events[0].output.length, 3_000_000);
  assert.equal(disk.events[1].id, 'after');
});

test('the new file is on disk (flushed) before it replaces the old one, which stays whole until then', async () => {
  const s = store.createSession({ title: '換檔', events: [{ id: 'old', type: 'text', text: '舊的' }] });
  await store.persistNow(s);
  s.events = Array.from({ length: 3000 }, (_, i) => ({ id: `n_${i}`, type: 'text', text: `新的 ${i} ${'x'.repeat(400)}` }));
  const during = [];
  // At every piece, the file other readers see is still the complete old one.
  const spy = spyOnDisk({ beforeWrite: () => during.push(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.map((e) => e.id).join()) });
  try {
    await store.persistNow(s);
  } finally {
    spy.restore();
  }
  assert.ok(during.length >= 3);
  assert.ok(during.every((ids) => ids === 'old'), 'a reader never sees a half-written file');
  const ops = spy.log.map((x) => x.op);
  assert.ok(ops.includes('sync'), 'flushed');
  assert.ok(ops.indexOf('sync') < ops.indexOf('rename'), 'flushed before the rename');
  assert.ok(ops.indexOf('close') < ops.indexOf('rename'), 'closed before the rename');
  const rename = spy.log.find((x) => x.op === 'rename');
  assert.ok(rename.from.endsWith('.tmp') && rename.to === file(s.id));
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.length, 3000);
});

test('many changes in a short time make one write, started after the delay (not one per change)', async () => {
  const s = store.createSession({ title: '合併', events: [] });
  await store.persistNow(s);
  const spy = spyOnDisk();
  try {
    for (let i = 0; i < 300; i++) {
      s.events.push({ id: `c_${i}`, type: 'text', text: `${i}` });
      store.saveSession(s);
      if (i % 50 === 0) await sleep(5);
    }
    await sleep(100);
    assert.equal(spy.log.filter((x) => x.op === 'rename').length, 0, 'nothing written yet: the changes are being gathered');
    await sleep(1800);
  } finally {
    spy.restore();
  }
  assert.equal(spy.log.filter((x) => x.op === 'rename').length, 1, 'one write for all of them');
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.length, 300);
});

test('the delay does not slide: a stream of changes is written every ~1.5 s, never held back for ever', async () => {
  const s = store.createSession({ title: '不會一直等', events: [] });
  await store.persistNow(s);
  const spy = spyOnDisk();
  try {
    const end = Date.now() + 3300;
    while (Date.now() < end) {
      s.events.push({ id: `d_${s.events.length}`, type: 'text', text: 'x' });
      store.saveSession(s);
      await sleep(20);
    }
    await sleep(1700);
  } finally {
    spy.restore();
  }
  const writes = spy.log.filter((x) => x.op === 'rename').length;
  assert.ok(writes >= 2 && writes <= 5, `${writes} writes in ~3 s of constant change`);
});

test('shutdown with a write half-way: the final flush still leaves the whole conversation, flushed', async () => {
  const s = store.createSession({ title: '寫到一半關機', events: [] });
  await store.persistNow(s);
  s.events = Array.from({ length: 3000 }, (_, i) => ({ id: `s_${i}`, type: 'text', text: `${i} ${'y'.repeat(300)}` }));
  store.saveSession(s, { immediate: true }); // in flight
  store.flushAll();
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.length, 3000);
  await sleep(300); // let the abandoned write finish or give up
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.length, 3000);
});

test('deleted halfway through a big write, it stops writing at once instead of finishing a file nobody wants', async () => {
  const s = store.createSession({ title: '寫一半被刪', events: [] });
  await store.persistNow(s);
  s.events = Array.from({ length: 6000 }, (_, i) => ({ id: `g_${i}`, type: 'text', text: `${i} ${'w'.repeat(400)}` })); // ~2.6 MB, many pieces
  let pieces = 0;
  const spy = spyOnDisk({ beforeWrite: () => { if (++pieces === 2) store.deleteSession(s.id); } });
  try {
    store.saveSession(s, { immediate: true });
    await sleep(600);
  } finally {
    spy.restore();
  }
  const wrote = spy.log.filter((x) => x.op === 'write').length;
  assert.ok(wrote >= 2 && wrote <= 4, `${wrote} pieces written, not all of them`);
  assert.equal(fs.existsSync(file(s.id)), false);
  assert.deepEqual(fs.readdirSync(path.join(TMP, 'sessions')).filter((f) => f.endsWith('.tmp')), []);
});

test('on shutdown, whatever is waiting is written right away', () => {
  const s = store.createSession({ title: '關機前', events: [] });
  s.events.push({ id: 'x', type: 'text', text: '還沒存' });
  store.saveSession(s); // debounced
  store.flushAll();
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.at(-1).text, '還沒存');
});

test('a write left half-done by a stop is cleaned up at the next start', () => {
  fs.writeFileSync(path.join(TMP, 'sessions', 's_dead.json.123.w.tmp'), '{"half');
  store.loadSessions();
  assert.equal(fs.existsSync(path.join(TMP, 'sessions', 's_dead.json.123.w.tmp')), false);
});

test('a change to the defaults is made once; one that cannot be made yet is tried again', () => {
  store.writeSettings({ defaults: { permission: 'auto' } });
  assert.equal(store.migrateSettings('a', (d) => void (d.effort = 'max')), true);
  assert.deepEqual(store.readSettings().defaults, { permission: 'auto', effort: 'max' });
  // Chosen differently afterwards: stays.
  store.writeSettings({ ...store.readSettings(), defaults: { effort: 'high' } });
  assert.equal(store.migrateSettings('a', (d) => void (d.effort = 'max')), false);
  assert.equal(store.readSettings().defaults.effort, 'high');
  assert.equal(store.migrateSettings('b', () => false), false);
  assert.ok(!store.readSettings().migrated.includes('b'));
  assert.equal(store.migrateSettings('b', (d) => void (d.model = 'k3')), true);
  assert.equal(store.readSettings().defaults.model, 'k3');
});
