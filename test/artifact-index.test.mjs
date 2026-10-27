// The Artifact panel (in the page) and the Hub apply ONE rule to decide which
// tool calls write a page and what each version of it is. These tests keep the
// two from drifting: the list the Hub sends for the part of a conversation the
// page does not hold, and the version it replays, must agree with what the
// page itself makes of the same events — for hand-made awkward cases and for a
// few thousand random ones — and the page's merge of the two must give the
// same pages as holding everything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collectArtifacts, mergeArtifactIndex, artifactIndex, replayVersion, artifactOf } from '../public/js/artifact-rules.js';
import { isArtifactEvent } from '../server/snapshot-window.js';
import { startHub } from './browser-harness.mjs';
import { artifactScene, storedSession, WINDOW_ENV } from './fixtures/window-scenes.mjs';

const T = (title, body) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
let n = 0;
const ev = (name, input, extra = {}) => ({ id: `x${++n}`, ts: 1_790_000_000_000 + n, type: 'tool_use', agentId: 'main', name, status: 'done', input, ...extra });

// The awkward ones, by hand.
function handMade() {
  const out = [];
  out.push(ev('Write', { path: '/p/a.html', content: T('甲', 'one two three') }));
  out.push(ev('Edit', { path: '/p/a.html', old_string: 'one', new_string: '1' }));
  out.push(ev('Edit', { path: '/p/a.html', old_string: 'does not occur', new_string: 'x' })); // cannot apply: version without html
  out.push(ev('Edit', { path: '/p/a.html', old_string: 'two', new_string: '2' })); // the base is gone, so it stays unknown
  out.push(ev('Write', { file_path: '/p/b.htm', content: 'bee', mode: 'append' })); // appends to nothing
  out.push(ev('Write', { file_path: '/p/b.htm', content: 'bee2', mode: 'append' }));
  out.push(ev('MultiEdit', { file_path: '/p/b.htm', edits: [{ old_string: 'bee', new_string: 'B' }, { old_string: 'B', new_string: 'BB' }] }));
  out.push(ev('Write', { path: '/p/a.html', content: T('乙', 'fresh start') }, { status: 'error' })); // failed write
  out.push(ev('Edit', { path: '/p/a.html', old_string: 'x', new_string: 'y' }, { status: 'error' }));
  out.push(ev('WriteFile', { path: '/p/c.html', content: T('丙', 'c') }));
  out.push(ev('StrReplaceFile', { path: '/p/c.html', old_string: 'c', new_string: 'cc' }));
  out.push(ev('Write', { path: '/p/notes.md', content: 'not a page' }));
  out.push(ev('Bash', { command: 'cat /p/a.html' }));
  out.push(ev('Read', { path: '/p/a.html' }));
  out.push(ev('Write', { path: '/p/still-writing.html' }, { status: 'running', argsText: '{"path":"/p/still-writing.html","content":"<html><head><title>Half</title>' }));
  out.push(ev('Write', {}, { status: 'pending', argsText: '{"file_path": "/p/only-args.html", "content": "ab\\ncd' }));
  out.push({ id: `x${++n}`, ts: 1_790_000_000_000 + n, type: 'text', text: 'Write /p/a.html' });
  return out;
}

// A few thousand random ones, deterministic.
function fuzz(seed, length) {
  let a = seed >>> 0 || 1;
  const rand = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const paths = ['/f/a.html', '/f/b.htm', '/f/c.md', '/f/d.html', '/f/e.HTML'];
  const tokens = ['alpha', 'beta', 'gamma', 'delta', 'omega'];
  const out = [];
  for (let i = 0; i < length; i++) {
    const path = pick(paths);
    const status = pick(['done', 'done', 'done', 'done', 'error', 'running', 'pending', 'interrupted']);
    const k = rand();
    const key = rand() < 0.5 ? 'path' : 'file_path';
    if (k < 0.25) out.push(ev('Write', { [key]: path, content: T(`t${i}`, tokens.join(' ')), ...(rand() < 0.2 ? { mode: 'append' } : {}) }, { status }));
    else if (k < 0.55) out.push(ev(pick(['Edit', 'StrReplaceFile']), { [key]: path, old_string: pick(tokens), new_string: pick(tokens), ...(rand() < 0.2 ? { replace_all: true } : {}) }, { status }));
    else if (k < 0.65) out.push(ev('MultiEdit', { [key]: path, edits: [{ old_string: pick(tokens), new_string: pick(tokens) }, { old_string: pick(tokens), new_string: pick(tokens) }] }, { status }));
    else if (k < 0.72) out.push(ev('WriteFile', { [key]: path, content: tokens.join(' ') }, { status }));
    else if (k < 0.8) out.push(ev(pick(['Write', 'Edit']), undefined, { status, argsText: `{"${key}":"${path}","content":"par` }));
    else if (k < 0.9) out.push(ev(pick(['Bash', 'Read', 'Grep']), { [key]: path, command: path }, { status }));
    else out.push({ id: `x${++n}`, ts: 1_790_000_000_000 + n, type: pick(['text', 'user', 'thinking']), text: path });
  }
  return out;
}

const shape = (arts) => arts.map((a) => ({ path: a.path, versions: a.versions.map((v) => `${v.id}${v.failed ? '!' : ''}`) }));

const sets = [['hand-made', handMade()], ...[1, 2, 3, 4, 5].map((seed) => [`random #${seed}`, fuzz(seed, 600)])];

test('the Hub rule is the page rule: the same events are artifact events, and isArtifactEvent says so', () => {
  for (const [name, events] of sets) {
    for (const e of events) assert.equal(isArtifactEvent(e), artifactOf(e) !== null, `${name}: ${e.id} ${e.name}`);
    const listed = artifactIndex(events).map((x) => x.eventId);
    const kept = events.filter((e) => artifactOf(e)).map((e) => e.id);
    assert.deepEqual(listed, kept, `${name}: one entry per artifact event, in order`);
  }
  // …and only those: a note, a read, a command naming the page, a message
  const own = artifactIndex(handMade()).map((x) => x.path);
  assert.ok(!own.includes('/p/notes.md'), 'a .md file is not a page');
  assert.ok(own.includes('/p/only-args.html') && own.includes('/p/still-writing.html'), 'a page still being written (its path only in the argument text so far) is one');
});

test('the list has, per page, exactly the versions the page makes from the events, failed ones marked', () => {
  for (const [name, events] of sets) {
    const fromHub = new Map();
    for (const e of artifactIndex(events)) fromHub.set(e.path, [...(fromHub.get(e.path) || []), `${e.eventId}${e.status === 'error' ? '!' : ''}`]);
    assert.deepEqual(
      shape(collectArtifacts(events)).map((a) => [a.path, a.versions]),
      [...fromHub.entries()],
      name,
    );
  }
});

test('the version the Hub replays is the version the page makes, for every version (an unknown one is null in both)', () => {
  let compared = 0;
  let unknown = 0;
  for (const [name, events] of sets) {
    for (const art of collectArtifacts(events)) {
      for (const v of art.versions) {
        const r = replayVersion(events, art.path, v.id);
        assert.ok(r, `${name}: ${v.id} is found`);
        assert.equal(r.html ?? null, v.html ?? null, `${name}: ${art.path} ${v.id}`);
        assert.equal(r.failed, v.failed);
        compared++;
        if (v.html == null) unknown++;
      }
    }
  }
  assert.ok(compared > 500, `compared ${compared} versions`);
  assert.ok(unknown > 20 && unknown < compared, `of them ${unknown} with no content known: both kinds were there`);
  assert.equal(replayVersion(handMade(), '/p/a.html', 'nope'), null, 'no such version');
});

test('the page holding only the newest part, plus the Hub\'s list, has the same pages and versions as holding everything', () => {
  let cuts = 0;
  for (const [name, events] of sets) {
    const whole = collectArtifacts(events);
    const list = artifactIndex(events);
    for (const cut of [0, 1, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length - 5, events.length - 1, events.length]) {
      const held = events.slice(Math.max(0, cut));
      const merged = mergeArtifactIndex(collectArtifacts(held), list);
      assert.deepEqual(shape(merged), shape(whole), `${name} cut at ${cut}`);
      const byId = new Map(whole.flatMap((a) => a.versions.map((v) => [v.id, v])));
      const heldIds = new Set(held.map((e) => e.id));
      for (const art of merged) {
        for (const v of art.versions) {
          if (heldIds.has(v.id)) assert.ok(!v.remote, `${v.id} is held`);
          else assert.ok(v.remote && v.html === null, `${v.id} is not held: a stand-in with no content`);
          // What is held keeps its content (it was made from what the page holds, so it may know less than the whole, never something else)
          if (v.html != null) assert.equal(v.html, byId.get(v.id).html, `${v.id} has the content the whole conversation gives it`);
        }
        assert.equal(art.partial, art.versions.some((v) => !heldIds.has(v.id)), `${art.path}: partial says whether stand-ins are in it`);
      }
      cuts++;
    }
  }
  assert.ok(cuts > 30);
});

test('a page found only in the list is titled from the Hub\'s list, and one that is held from its own content', () => {
  const events = [
    ev('Write', { path: '/t/old.html', content: T('標題在清單裡', 'x') }),
    ev('Write', { path: '/t/kept.html', content: T('舊的標題', 'k') }),
    ev('Write', { path: '/t/kept.html', content: T('新的標題', 'k2') }),
  ];
  const merged = mergeArtifactIndex(collectArtifacts(events.slice(2)), artifactIndex(events));
  assert.deepEqual(merged.map((a) => [a.path, a.title]), [['/t/old.html', '標題在清單裡'], ['/t/kept.html', '新的標題']]);
  // no title anywhere: the file name, as before
  const bare = [ev('Write', { path: '/t/plain.html', content: 'no title here' }), ev('Write', { path: '/t/z.html', content: 'z' })];
  assert.equal(mergeArtifactIndex(collectArtifacts(bare.slice(1)), artifactIndex(bare)).find((a) => a.path === '/t/plain.html').title, 'plain.html');
});

test('without a list (a Hub that has none, or one that failed) the page keeps exactly what it holds', () => {
  const events = handMade();
  const local = collectArtifacts(events.slice(8));
  assert.equal(mergeArtifactIndex(local, null), local);
  assert.equal(mergeArtifactIndex(local, []), local);
  assert.equal(mergeArtifactIndex(local, [{ nonsense: true }, null, { path: 5, eventId: 'x' }]).length, local.length, 'entries that are not entries are ignored');
});

// ------------------------------------------------------------ over the API

let hub;
const scene = artifactScene();
before(async () => {
  hub = await startHub([storedSession(scene.events)], { env: WINDOW_ENV });
});
after(() => hub?.stop());

test('GET /sessions/:id/artifacts lists the pages of the whole conversation, though the snapshot holds only its newest window', async () => {
  const snap = await hub.api('/sessions/s_scene');
  assert.ok(snap.window.hasEarlier && snap.events.length < scene.events.length / 2, 'the snapshot is a window');
  const r = await hub.api('/sessions/s_scene/artifacts');
  assert.equal(r.total, scene.events.length);
  const whole = (await hub.api('/sessions/s_scene?window=all')).events;
  assert.deepEqual(shape(mergeArtifactIndex([], r.artifacts)), shape(collectArtifacts(whole)), 'what the page makes of everything');
  assert.deepEqual(
    r.artifacts.map((e) => [e.path.split('/').pop(), e.kind]),
    [['old.html', 'write'], ['old.html', 'edit'], ['other.html', 'write'], ['old.html', 'edit'], ['new.html', 'write']],
  );
  assert.equal(r.artifacts[0].title, '舊頁面');
  assert.ok(r.artifacts.every((e) => typeof e.eventId === 'string' && typeof e.ts === 'number' && e.status === 'done'));
  assert.ok(!JSON.stringify(r).includes('第一版'), 'the list carries no page content');
});

test('GET /sessions/:id/artifacts/:eventId replays a version, also one whose Write is not in the snapshot', async () => {
  const whole = (await hub.api('/sessions/s_scene?window=all')).events;
  const list = (await hub.api('/sessions/s_scene/artifacts')).artifacts;
  const reference = new Map(collectArtifacts(whole).flatMap((a) => a.versions.map((v) => [v.id, v.html])));
  for (const e of list) {
    const r = await hub.api(`/sessions/s_scene/artifacts/${e.eventId}`);
    assert.equal(r.path, e.path);
    assert.equal(r.html, reference.get(e.eventId), `${e.eventId}`);
  }
  const last = list.filter((e) => e.path.endsWith('old.html')).at(-1);
  assert.match((await hub.api(`/sessions/s_scene/artifacts/${last.eventId}`)).html, /第三版/);
  await assert.rejects(hub.api('/sessions/s_scene/artifacts/nope'), (e) => e.status === 404);
  await assert.rejects(hub.api(`/sessions/s_scene/artifacts/${scene.events[0].id}`), (e) => e.status === 404, 'an event that is not a page');
  await assert.rejects(hub.api('/sessions/s_nope/artifacts'), (e) => e.status === 404);
});

test('the Artifacts page (all conversations) still lists each page once with its versions and title', async () => {
  const list = await hub.api('/artifacts');
  const mine = list.filter((a) => a.sessionId === 's_scene').sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    mine.map((a) => [a.path, a.versions, a.title]),
    [['/site/new.html', 1, '新頁面'], ['/site/old.html', 3, '舊頁面'], ['/site/other.html', 1, '其他頁']],
  );
});
