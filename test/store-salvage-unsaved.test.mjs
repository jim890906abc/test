// A repaired conversation whose original could not be backed up (or whose
// repaired copy could not be written over it) is marked meta.salvaged.unsaved:
// "not written back to the original file yet", and the original is left alone.
// The next ordinary save DOES write the conversation to disk — and the mark
// stayed (in memory, and written into the file), so after a restart the badge
// still said 尚未寫回原檔 about a file that had long been written. Now an
// ordinary save that lands clears the mark — in the file it writes and in
// memory — and one that fails leaves it standing.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-unsaved-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');

const SESSIONS = path.join(TMP, 'sessions');
const DAMAGED = path.join(TMP, 'sessions-damaged');
const file = (id) => path.join(SESSIONS, `${id}.json`);
let counter = 0;
const freshId = () => `s_unsv${String(++counter).padStart(4, '0')}`;
const make = (id, n = 6) => ({
  title: '還沒寫回的對話',
  status: 'idle',
  permissionMode: 'ask',
  allowedTools: [],
  state: {},
  usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
  createdAt: 1000,
  updatedAt: 2000,
  id,
  meta: { model: 'm1' },
  events: Array.from({ length: n }, (_, i) => ({ id: `e_${i}`, ts: 10 + i, type: 'text', text: `E${i}:` + `abcdefghij${i}`.repeat(200) })),
});
const bytes = (o) => Buffer.from(JSON.stringify(o));
const zero = (buf, from, to) => Buffer.concat([buf.subarray(0, from), Buffer.alloc(to - from), buf.subarray(to)]);
const at = (buf, needle, plus = 0) => buf.indexOf(needle) + plus;
const onDisk = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
const entry = (id) => store.listDamaged().find((d) => d.file === `${id}.json`);

// A repaired conversation that is "unsaved": the place for the copy of the
// original is taken by a plain file, so no copy could be made.
function loadUnsaved() {
  const id = freshId();
  const full = bytes(make(id));
  const bad = zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100));
  fs.writeFileSync(file(id), bad);
  fs.rmSync(DAMAGED, { recursive: true, force: true });
  fs.writeFileSync(DAMAGED, 'in the way');
  const m = mock.method(console, 'warn', () => {});
  try {
    store.loadSessions();
  } finally {
    m.mock.restore();
    fs.rmSync(DAMAGED, { force: true });
  }
  assert.equal(store.getSession(id).meta.salvaged.unsaved, true, 'positive control: it starts unsaved');
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'positive control: the original is left alone');
  return { id, bad };
}

test('an ordinary save that lands clears the mark, in the file it writes and in memory — so a restart does not show the badge again', async () => {
  const { id } = loadUnsaved();
  const s = store.getSession(id);
  s.title = '改過標題';
  store.saveSession(s, { immediate: true });
  await store.persistNow(s);

  assert.equal(s.meta.salvaged.unsaved, undefined, 'cleared in memory');
  assert.equal(entry(id).unsaved, false, 'the list of damaged files no longer says so');
  const written = onDisk(id);
  assert.equal(written.title, '改過標題', 'the file really was written');
  assert.equal(written.meta.salvaged.unsaved, undefined, 'and the mark is not in it');
  assert.ok(written.meta.salvaged.removedBytes > 0, 'the rest of the repair note is kept');

  // A restart (loading the files again) shows nothing unsaved.
  const m = mock.method(console, 'warn', () => {});
  try {
    store.loadSessions();
  } finally {
    m.mock.restore();
  }
  assert.equal(store.getSession(id).meta.salvaged.unsaved, undefined);
  assert.equal(entry(id).unsaved, false);
});

test('a save that fails leaves the mark standing, in memory and in the original file; the next save that lands clears it', async () => {
  const { id, bad } = loadUnsaved();
  const s = store.getSession(id);
  // The temporary file the save writes next to the conversation is a folder: the write cannot happen.
  const tmp = `${file(id)}.${process.pid}.w.tmp`;
  fs.mkdirSync(tmp);
  const m = mock.method(console, 'warn', () => {});
  try {
    store.saveSession(s, { immediate: true });
    await store.persistNow(s);
  } finally {
    m.mock.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(s.meta.salvaged.unsaved, true, 'the save did not land: still not written back');
  assert.equal(entry(id).unsaved, true);
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'and the original is as it was');

  store.saveSession(s, { immediate: true });
  await store.persistNow(s);
  assert.equal(s.meta.salvaged.unsaved, undefined);
  assert.equal(onDisk(id).meta.salvaged.unsaved, undefined);
});

test('the save at shutdown clears the mark in the file it writes, too', () => {
  const { id } = loadUnsaved();
  const s = store.getSession(id);
  store.saveSession(s); // the debounced save is pending: flushAll writes it now
  store.flushAll();
  assert.equal(onDisk(id).meta.salvaged.unsaved, undefined);
  assert.equal(s.meta.salvaged.unsaved, undefined);
});

test('a conversation that was repaired and written back at once (not unsaved) is untouched by saving, and one that never was damaged gets no note', async () => {
  const id = freshId();
  const full = bytes(make(id));
  fs.writeFileSync(file(id), zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100)));
  const m = mock.method(console, 'warn', () => {});
  try {
    store.loadSessions();
  } finally {
    m.mock.restore();
  }
  const s = store.getSession(id);
  assert.equal(s.meta.salvaged.unsaved, undefined, 'a repair that was written back is not "unsaved" (control)');
  const note = structuredClone(s.meta.salvaged);
  store.saveSession(s, { immediate: true });
  await store.persistNow(s);
  assert.deepEqual(onDisk(id).meta.salvaged, note, 'the note is exactly what it was');

  const plain = store.createSession({ id: freshId(), title: 'plain', meta: { model: 'm' } });
  await store.persistNow(plain);
  assert.equal(onDisk(plain.id).meta.salvaged, undefined);
});
