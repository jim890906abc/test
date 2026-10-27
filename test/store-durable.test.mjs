// Saving conversations durably (server/store.js): the data is forced to disk
// before the rename that makes it the file, and the folder entry after it.
// A crash in between used to leave a file of full size with blocks that were
// never written (a 7.8 MB conversation came back with 745,472 NUL bytes in
// the middle); a rename alone is atomic for readers, not durable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-durable-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');
const file = (id) => path.join(TMP, 'sessions', `${id}.json`);
const events = (n) => Array.from({ length: n }, (_, i) => ({ id: `e_${i}`, ts: i, type: 'text', text: `事件 ${i}` }));

// The crash that did this leaves a full-sized file with unwritten blocks: the
// data has to be forced to disk before the rename makes it *the* file.
function spyOnDisk() {
  const log = [];
  const realOpen = fs.promises.open;
  const fsyncSync = fs.fsyncSync;
  const renameSync = fs.renameSync;
  fs.fsyncSync = (fd) => (log.push('fsync'), fsyncSync(fd));
  fs.renameSync = (a, b) => (log.push(`rename:${path.basename(b)}`), renameSync(a, b));
  fs.promises.open = async (p, ...rest) => {
    const fh = await realOpen(p, ...rest);
    const sync = fh.sync.bind(fh);
    fh.sync = async () => (log.push(fs.statSync(p).isDirectory() ? 'fsync-dir' : 'fsync'), sync());
    return fh;
  };
  return {
    log,
    stop() {
      fs.fsyncSync = fsyncSync;
      fs.renameSync = renameSync;
      fs.promises.open = realOpen;
    },
  };
}

test('a conversation is on disk before the rename that makes it the file, and the folder entry after', async () => {
  const s = store.createSession({ title: '耐久', events: events(5) });
  await store.persistNow(s);
  const spy = spyOnDisk();
  try {
    s.events.push({ id: 'e_new', ts: 99, type: 'text', text: 'new' });
    await store.persistNow(s);
  } finally {
    spy.stop();
  }
  const rename = spy.log.indexOf(`rename:${s.id}.json`);
  assert.ok(rename > 0, `renamed (${spy.log})`);
  assert.equal(spy.log[rename - 1], 'fsync', `the data is synced right before the rename (${spy.log})`);
  assert.equal(spy.log[rename + 1], 'fsync-dir', `the folder is synced right after (${spy.log})`);
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.at(-1).id, 'e_new');
});

test('shutdown flush and the small settings files are synced before their rename too', () => {
  const s = store.createSession({ title: '關機', events: [] });
  s.events.push({ id: 'x', type: 'text', text: '還沒存' });
  store.saveSession(s); // debounced
  const spy = spyOnDisk();
  try {
    store.flushAll();
    store.writeSettings({ defaults: { effort: 'high' } });
  } finally {
    spy.stop();
  }
  const renames = spy.log.map((l, i) => [l, i]).filter(([l]) => l.startsWith('rename:'));
  assert.deepEqual(renames.map(([l]) => l), [`rename:${s.id}.json`, 'rename:settings.json']);
  for (const [, i] of renames) assert.equal(spy.log[i - 1], 'fsync', spy.log.join());
  assert.equal(JSON.parse(fs.readFileSync(file(s.id), 'utf8')).events.at(-1).text, '還沒存');
});
