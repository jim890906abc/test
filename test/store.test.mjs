// Saving conversations (server/store.js): written in slices in the
// background, the same JSON as written in one go; never brought back after
// being deleted mid-write; flushed whole on shutdown.
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
