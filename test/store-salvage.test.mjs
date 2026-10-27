// A conversation file that no longer parses is not silently dropped
// (server/store.js loadSessions, server/salvage.js). Real case: a crash in the
// middle of a write left a 7.8 MB file with 745,472 NUL bytes in the middle;
// the conversation vanished from the sidebar and nothing said why.
//
// Fixtures are made by damaging well-formed session files byte by byte, the way
// the crash did. Every case asserts what is loaded, what is on disk afterwards
// (the original is never lost) and what the user can see.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-salvage-'));
process.env.AGENT_HUB_DATA = TMP;
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const store = await import('../server/store.js');
const { salvage, stripControlRuns, cutBackToLastEvent } = await import('../server/salvage.js');

const SESSIONS = path.join(TMP, 'sessions');
const DAMAGED = path.join(TMP, 'sessions-damaged');
const file = (id) => path.join(SESSIONS, `${id}.json`);
let counter = 0;
const freshId = () => `s_salv${String(++counter).padStart(4, '0')}`;

// A session the way jsonInSlices writes it: everything else first, `events`
// last, each event's text its last key.
function make(id, n = 12) {
  return {
    title: '救援測試',
    status: 'idle',
    permissionMode: 'ask',
    allowedTools: [],
    state: {},
    usage: { inputTokens: 5, outputTokens: 6, costUsd: 0 },
    createdAt: 1000,
    updatedAt: 2000,
    id,
    meta: { model: 'm1' },
    events: Array.from({ length: n }, (_, i) => ({ id: `e_${i}`, ts: 10 + i, type: 'text', text: `E${i}:` + `abcdefghij${i}`.repeat(400) })),
  };
}
const bytes = (obj) => Buffer.from(JSON.stringify(obj));
const at = (buf, needle, plus = 0) => {
  const i = buf.indexOf(needle);
  assert.ok(i >= 0, `${needle} in the fixture`);
  return i + plus;
};
const zero = (buf, from, to) => Buffer.concat([buf.subarray(0, from), Buffer.alloc(to - from), buf.subarray(to)]);
const put = (id, buf) => fs.writeFileSync(file(id), buf);
const backups = (id) => (fs.existsSync(DAMAGED) ? fs.readdirSync(DAMAGED).filter((f) => f.startsWith(`${id}.json.`) && /\.\d+$/.test(f)) : []);
const damagedEntry = (id) => store.listDamaged().find((d) => d.file === `${id}.json`);
const load = () => {
  const warns = [];
  const m = mock.method(console, 'warn', (...a) => void warns.push(a.join(' ')));
  try {
    store.loadSessions();
  } finally {
    m.mock.restore();
  }
  return warns;
};

test('a NUL run in the middle of the strings: the conversation comes back, the gap is marked, the original is kept', () => {
  const id = freshId();
  const orig = bytes(make(id));
  const from = at(orig, 'E3:', 300);
  const to = at(orig, 'E6:', 300);
  const damaged = zero(orig, from, to);
  put(id, damaged);

  const warns = load();

  const s = store.getSession(id);
  assert.ok(s, 'the conversation is loaded');
  // E4 and E5 are gone for good; E3's head and E6's tail now touch.
  assert.deepEqual(s.events.slice(0, 3).map((e) => e.id), ['e_0', 'e_1', 'e_2']);
  assert.deepEqual(s.events.slice(3, -1).map((e) => e.id), ['e_3', 'e_7', 'e_8', 'e_9', 'e_10', 'e_11']);
  const spliced = s.events[3].text;
  assert.ok(spliced.startsWith('E3:abcdefghij3'), 'the head of E3 is kept');
  assert.match(spliced, /〔損壞區段：\d+ 位元組已移除，內容無法還原〕/, 'the gap is marked where it is');
  assert.ok(spliced.endsWith('abcdefghij6'), 'the tail of E6 is kept');
  // Nothing outside the gap was touched.
  assert.deepEqual(s.events.slice(4, -1).map((e) => e.text), make(id).events.slice(7).map((e) => e.text));
  assert.equal(s.title, '救援測試');
  assert.deepEqual(s.usage, { inputTokens: 5, outputTokens: 6, costUsd: 0 });
  assert.equal(s.updatedAt, 2000, 'repairing a file is not user activity: the sidebar order does not move');

  // What the user is told.
  const note = s.meta.salvaged;
  assert.equal(note.removedBytes, to - from);
  assert.equal(note.originalBytes, damaged.length);
  assert.equal(s.meta.model, 'm1', 'other meta survives');
  const info = s.events.at(-1);
  assert.equal(info.type, 'info');
  assert.match(info.text, /曾損壞/);
  assert.ok(info.text.includes(String(to - from).replace(/\B(?=(\d{3})+$)/g, ',')), 'says how many bytes');
  assert.ok(info.text.includes(path.join(DAMAGED, note.backup)), 'says where the original is');
  assert.ok(warns.some((w) => w.includes(`${id}.json`)), 'the start-up log names the file');

  // The original, untouched, in a folder that is not a sessions folder.
  assert.equal(backups(id).length, 1);
  assert.equal(note.backup, backups(id)[0]);
  assert.ok(fs.readFileSync(path.join(DAMAGED, note.backup)).equals(damaged), 'bit for bit');
  assert.equal(fs.statSync(path.join(DAMAGED, note.backup)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(DAMAGED).mode & 0o777, 0o700);
  assert.ok(!fs.readdirSync(SESSIONS).some((f) => f.includes('sessions-damaged')), 'never inside the sessions folder');

  // The file on disk is now valid and carries the same marks.
  const onDisk = JSON.parse(fs.readFileSync(file(id), 'utf8'));
  assert.equal(onDisk.events.length, s.events.length);
  assert.equal(onDisk.meta.salvaged.backup, note.backup);

  // And it is listed.
  assert.deepEqual(
    (({ file: f, bytes: b, salvaged, backup }) => ({ file: f, bytes: b, salvaged, backup }))(damagedEntry(id)),
    { file: `${id}.json`, bytes: damaged.length, salvaged: true, backup: note.backup },
  );
});

test('the next start finds a clean file: no second backup, no second notice, the marks stay', async () => {
  const id = freshId();
  put(id, zero(bytes(make(id)), at(bytes(make(id)), 'E2:', 100), at(bytes(make(id)), 'E4:', 100)));
  load();
  const first = store.getSession(id);
  const eventsBefore = first.events.length;
  const note = first.meta.salvaged;

  const fresh = await import(`../server/store.js?restart=${Date.now()}`);
  fresh.loadSessions();
  const again = fresh.getSession(id);
  assert.equal(again.events.length, eventsBefore, 'the notice is not added again');
  assert.deepEqual(again.meta.salvaged, note);
  assert.equal(backups(id).length, 1);
  assert.equal(fresh.listDamaged().find((d) => d.file === `${id}.json`)?.salvaged, true, 'still listed after the repair was written back');
});

test('a file that stays damaged is backed up once, however many times it is seen', () => {
  const id = freshId();
  const junk = Buffer.from('{"id":"' + id + '","events":[{{{ not json');
  put(id, junk);
  load();
  load();
  load();
  assert.equal(backups(id).length, 1);
});

test('cut off in the middle of an event: back to the last whole event, said plainly', () => {
  const id = freshId();
  const full = bytes(make(id));
  const cut = full.subarray(0, at(full, 'E8:', 700));
  put(id, cut);
  load();
  const s = store.getSession(id);
  assert.ok(s);
  assert.deepEqual(s.events.slice(0, -1).map((e) => e.id), Array.from({ length: 8 }, (_, i) => `e_${i}`));
  assert.deepEqual(s.events.slice(0, 8).map((e) => e.text), make(id).events.slice(0, 8).map((e) => e.text), 'the kept events are whole');
  assert.deepEqual(s.meta.salvaged.kinds, ['truncated']);
  assert.ok(s.meta.salvaged.droppedBytes > 600);
  assert.equal(s.meta.salvaged.removedBytes, 0);
  assert.match(s.events.at(-1).text, /捨棄檔尾不完整/);
  assert.ok(fs.readFileSync(path.join(DAMAGED, s.meta.salvaged.backup)).equals(cut));
  assert.equal(JSON.parse(fs.readFileSync(file(id), 'utf8')).events.length, 9, 'written back whole');
});

test('cut off after the events list, in a key behind it: the events are all kept', () => {
  const text = '{"id":"s_x","title":"t","events":[{"type":"a","text":"1"},{"type":"b","text":"2"}],"usage":{"inputTokens":4,"outpu';
  const r = salvage(Buffer.from(text), 's_x');
  assert.equal(r.ok, true);
  assert.equal(r.session.events.length, 2);
  assert.deepEqual(r.session.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, 'a key that was lost gets its default');
  assert.deepEqual(r.kinds, ['truncated']);
});

test('a NUL run and a cut end in the same file: both are repaired', () => {
  const id = freshId();
  const full = bytes(make(id));
  const bad = zero(full, at(full, 'E2:', 50), at(full, 'E4:', 50)).subarray(0, at(full, 'E9:', 200));
  put(id, bad);
  load();
  const s = store.getSession(id);
  assert.ok(s);
  assert.deepEqual(s.meta.salvaged.kinds, ['control-chars', 'truncated']);
  assert.equal(s.events.filter((e) => e.type === 'text').length, 9 - 2, 'E3 is lost, E2 and E4 touch, E9 is cut');
});

test('NULs between tokens, outside any string: nothing is guessed, nothing is loaded, the file is untouched and listed', () => {
  const id = freshId();
  const full = bytes(make(id));
  const comma = at(full, '},{"id":"e_5"');
  const bad = Buffer.from(full);
  bad[comma + 1] = 0; // the comma between two events
  put(id, bad);
  load();
  assert.equal(store.getSession(id), undefined, 'a wrong conversation is worse than a missing one');
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'the original stays where it is');
  assert.equal(backups(id).length, 1);
  const d = damagedEntry(id);
  assert.equal(d.salvaged, false);
  assert.equal(d.code, 'control-chars-outside-strings');
  assert.match(d.reason, /不在字串內/);
  assert.equal(d.backup, backups(id)[0]);
});

test('a NUL run that swallows a closing quote turns the rest into nonsense: that is not a successful repair either', () => {
  const id = freshId();
  const full = bytes(make(id));
  // From the middle of E4's text to just past its closing quote and brace,
  // so the string the run is in never closes where the parser expects.
  const from = at(full, 'E4:', 100);
  const to = at(full, '"},{"id":"e_5"', 3);
  const bad = zero(full, from, to);
  put(id, bad);
  load();
  assert.equal(store.getSession(id), undefined);
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'the original is untouched');
  assert.equal(damagedEntry(id).salvaged, false);
  assert.equal(backups(id).length, 1);
});

test('damage in the middle that is not a cut file is not passed off as one (the later events are not thrown away)', () => {
  // A stray quote in E2 throws the string/structure bookkeeping off for the
  // rest of the file. E1 alone would "parse" if cut there; E3 is intact and
  // must not be silently dropped.
  const r = salvage(Buffer.from('{"id":"s_x","events":[{"type":"a","text":"1"},{"type":"b","text":"2"x"},{"type":"c","text":"3"}]}'), 's_x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unparseable');
});

test('beyond repair: not loaded, original untouched, backed up, listed with the reason', () => {
  const cases = {
    garbage: Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x13, 0x37]),
    empty: Buffer.alloc(0),
    allZero: Buffer.alloc(8192),
    notASession: Buffer.from('{"id":"__ID__","events":{"a":1}}'),
  };
  for (const [name, buf0] of Object.entries(cases)) {
    const id = freshId();
    const buf = Buffer.from(buf0.toString('latin1').replace('__ID__', id), 'latin1');
    put(id, buf);
    const warns = load();
    assert.equal(store.getSession(id), undefined, name);
    assert.ok(fs.readFileSync(file(id)).equals(buf), `${name}: untouched`);
    const d = damagedEntry(id);
    assert.ok(d, `${name}: listed`);
    assert.equal(d.salvaged, false, name);
    assert.equal(d.bytes, buf.length, name);
    assert.ok(d.reason.length > 10, name);
    assert.ok(warns.some((w) => w.includes(`${id}.json`) && w.includes(d.reason.slice(0, 10))), `${name}: said at start-up`);
    // Valid JSON that is no conversation parses; nothing is going to be
    // changed in it, so there is nothing to back up.
    assert.equal(backups(id).length, name === 'notASession' ? 0 : 1, name);
    if (name !== 'notASession') assert.ok(fs.readFileSync(path.join(DAMAGED, backups(id)[0])).equals(buf), `${name}: backup is identical`);
  }
  assert.match(store.listDamaged().find((d) => d.code === 'empty').reason, /空的/);
  assert.equal(store.listDamaged().find((d) => d.code === 'all-zero').bytes, 8192);
});

test('a repairable file under the wrong name is not loaded as someone else', () => {
  const id = freshId();
  const other = freshId();
  const full = bytes(make(other));
  const bad = zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100));
  put(id, bad); // the content says `other`
  load();
  assert.equal(store.getSession(other), undefined);
  assert.equal(store.getSession(id), undefined);
  const d = damagedEntry(id);
  assert.equal(d.salvaged, false);
  assert.equal(d.code, 'bad-structure');
  assert.match(d.reason, /不一致/);
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'the original is untouched');
});

test('a backup name that is taken is never overwritten; one with the same bytes is reused', () => {
  const now = 1_800_000_000_000;
  const clock = mock.method(Date, 'now', () => now);
  try {
    const id = freshId();
    fs.mkdirSync(DAMAGED, { recursive: true });
    const theirs = Buffer.from('someone else\'s file');
    fs.writeFileSync(path.join(DAMAGED, `${id}.json.${now}`), theirs);
    fs.writeFileSync(path.join(DAMAGED, `${id}.json.${now + 1}`), theirs);
    const full = bytes(make(id));
    const bad = zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100));
    put(id, bad);
    load();
    const s = store.getSession(id);
    assert.ok(s);
    assert.equal(s.meta.salvaged.backup, `${id}.json.${now + 2}`);
    assert.ok(fs.readFileSync(path.join(DAMAGED, `${id}.json.${now}`)).equals(theirs), 'untouched');
    assert.ok(fs.readFileSync(path.join(DAMAGED, `${id}.json.${now + 1}`)).equals(theirs), 'untouched');
    assert.ok(fs.readFileSync(path.join(DAMAGED, s.meta.salvaged.backup)).equals(bad));

    // The same bytes already backed up under another name: that one is used.
    const id2 = freshId();
    const bad2 = zero(bytes(make(id2)), at(bytes(make(id2)), 'E2:', 100), at(bytes(make(id2)), 'E4:', 100));
    fs.writeFileSync(path.join(DAMAGED, `${id2}.json.12345`), bad2);
    put(id2, bad2);
    load();
    assert.equal(store.getSession(id2).meta.salvaged.backup, `${id2}.json.12345`);
    assert.equal(backups(id2).length, 1);
  } finally {
    clock.mock.restore();
  }
});

test('when the original cannot be backed up it is not changed: loaded from memory, marked unsaved', () => {
  const id = freshId();
  const full = bytes(make(id));
  const bad = zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100));
  put(id, bad);
  // A plain file where the backup folder should be.
  fs.rmSync(DAMAGED, { recursive: true, force: true });
  fs.writeFileSync(DAMAGED, 'in the way');
  try {
    load();
  } finally {
    fs.rmSync(DAMAGED, { force: true });
  }
  const s = store.getSession(id);
  assert.ok(s, 'still loaded');
  assert.equal(s.meta.salvaged.unsaved, true);
  assert.equal(s.meta.salvaged.backup, null);
  assert.ok(fs.readFileSync(file(id)).equals(bad), 'the original is not replaced without a copy of it');
  assert.match(s.events.at(-1).text, /沒能備份/);
  assert.equal(damagedEntry(id).unsaved, true);
});

test('a good store is left alone: no backup folder appears, nothing is flagged', async () => {
  fs.rmSync(DAMAGED, { recursive: true, force: true });
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  const ids = [freshId(), freshId()];
  for (const id of ids) put(id, bytes(make(id, 3)));
  const clean = await import(`../server/store.js?clean=${Date.now()}`);
  clean.loadSessions();
  assert.ok(ids.every((id) => clean.getSession(id).events.length === 3));
  assert.equal(fs.existsSync(DAMAGED), false);
  assert.deepEqual(clean.listDamaged(), []);
  assert.ok(ids.every((id) => clean.getSession(id).meta.salvaged === undefined));
});

test('the pieces: control runs are cut only inside strings; a cut is closed only at an event boundary', () => {
  const r = stripControlRuns('{"a":"x\u0000\u0000y","b":["p\u0001"]}');
  assert.equal(r.removed, 3);
  assert.equal(r.outsideAt, -1);
  assert.equal(JSON.parse(r.text).a.startsWith('x〔'), true);
  assert.equal(stripControlRuns('{"a":1,\u0000"b":2}').outsideAt, 7);
  assert.equal(stripControlRuns('{"a":"\\\u0000"}').removed, 0, 'a character after a backslash belongs to the escape');
  assert.equal(stripControlRuns('{ "a":\n\t1 }').removed, 0, 'whitespace is not damage');
  assert.equal(cutBackToLastEvent('{"id":"s","events":[{"type":"a"},{"type":"b","text":"par').text, '{"id":"s","events":[{"type":"a"}]}');
  assert.equal(cutBackToLastEvent('{"id":"s","events":[{"type":"a"},').text, '{"id":"s","events":[{"type":"a"}]}');
  assert.equal(cutBackToLastEvent('{"id":"s","events":[').text, '{"id":"s","events":[]}');
  assert.equal(cutBackToLastEvent('{"id":"s","meta":{"events":[{"x":1}'), null, 'only the top-level events list counts');
  assert.equal(cutBackToLastEvent('{"id":"s","events":[]}'), null, 'a whole document is not a cut one');
});

test('the same real shape: a 700 KB NUL run in a multi-megabyte file with escaped content and non-ASCII text', () => {
  const id = freshId();
  const s0 = make(id, 60);
  for (const e of s0.events) e.text = `E${e.id}:「中文」\n"quoted" \\ back\\slash ` + 'x'.repeat(40_000);
  s0.events[0].text = 'E0:' + s0.events[0].text;
  const full = bytes(s0);
  const from = 300 * 1024;
  const to = 1024 * 1024; // crash pattern: the run ends on a 1 MiB boundary
  // Make sure both ends land in the middle of a string.
  const bad = zero(full, from, to);
  put(id, bad);
  load();
  const s = store.getSession(id);
  assert.ok(s, 'loaded');
  assert.equal(s.meta.salvaged.removedBytes, to - from);
  assert.ok(s.events.length > 30, `most of the conversation is back (${s.events.length} of 60)`);
  assert.ok(s.events.slice(-5, -1).every((e) => /^E/.test(e.text)), 'the events after the gap are whole');
});

test('GET /api/damaged-sessions needs the token and lists what was repaired and what was not', async () => {
  const port = 26000 + Math.floor(Math.random() * 3000);
  const data = path.join(TMP, 'api-data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  const good = 's_apigood';
  const fixable = 's_apifixable';
  const broken = 's_apibroken';
  fs.writeFileSync(path.join(data, 'sessions', `${good}.json`), bytes(make(good, 3)));
  const full = bytes(make(fixable));
  const bad = zero(full, at(full, 'E2:', 100), at(full, 'E4:', 100));
  fs.writeFileSync(path.join(data, 'sessions', `${fixable}.json`), bad);
  fs.writeFileSync(path.join(data, 'sessions', `${broken}.json`), '{"id":"s_apibroken","events":[{{{');
  let log = '';
  const hub = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'salvage-token', AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(TMP, 'api-ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stderr.on('data', (d) => (log += d));
  hub.stdout.on('data', (d) => (log += d));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`hub did not start\n${log}`)), 15000);
      hub.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
      hub.once('exit', (c) => (clearTimeout(t), reject(new Error(`hub exited ${c}\n${log}`))));
    });
    const url = `http://127.0.0.1:${port}/api/damaged-sessions`;
    assert.equal((await fetch(url)).status, 401, 'no token');
    assert.equal((await fetch(url, { headers: { 'x-hub-token': 'wrong' } })).status, 401, 'wrong token');
    const r = await fetch(url, { headers: { 'x-hub-token': 'salvage-token' } });
    assert.equal(r.status, 200);
    const list = await r.json();
    assert.ok(Array.isArray(list));
    const byFile = Object.fromEntries(list.map((d) => [d.file, d]));
    assert.deepEqual(Object.keys(byFile).sort(), [`${broken}.json`, `${fixable}.json`]);
    assert.equal(byFile[`${fixable}.json`].salvaged, true);
    assert.equal(byFile[`${fixable}.json`].bytes, bad.length);
    assert.ok(fs.existsSync(path.join(data, 'sessions-damaged', byFile[`${fixable}.json`].backup)));
    assert.equal(byFile[`${broken}.json`].salvaged, false);
    assert.ok(byFile[`${broken}.json`].reason);
    assert.ok(byFile[`${broken}.json`].backup);
    // The conversation is in the sidebar's list, flagged.
    const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { 'x-hub-token': 'salvage-token' } })).json();
    const row = sessions.find((s) => s.id === fixable);
    assert.ok(row, 'the repaired conversation is listed');
    assert.equal(row.meta.salvaged.removedBytes > 0, true);
    assert.ok(sessions.find((s) => s.id === good));
    assert.equal(sessions.find((s) => s.id === broken), undefined);
    assert.ok(/無法載入對話檔 s_apibroken\.json/.test(log), 'the start-up log names the file that was left out');
  } finally {
    hub.kill('SIGTERM');
  }
});
