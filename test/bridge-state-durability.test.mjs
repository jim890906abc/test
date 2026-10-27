// The connector's own files (bridge.json: the hub address, the bridge key and the
// DeepSeek key pool; the skill files, mcp.json and Kimi's config.toml it edits)
// are written whole or not at all, like the Hub's:
//   • a kill in the middle of a write leaves the OLD file, not half of a new one;
//     the data is forced to disk before the rename and the folder entry after it;
//     bridge.json stays private (0600) from its first byte; the half-written
//     temporary file of a process that is gone is cleaned up at the next start;
//   • a bridge.json that is there but cannot be used is not taken for "no state"
//     in silence: a damaged one is kept (byte for byte, private) before the new
//     state is written, and said; one that cannot be read is not written over.
// The connector runs for real (the Hub is not needed: it writes its state before
// it connects), with the disk-chaos preload for the kill and the op log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aroundRename, opsOf } from './fixtures/hub-process.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BRIDGE = path.join(ROOT, 'bridge', 'agent-hub-bridge.mjs');
const CHAOS = new URL('./fixtures/disk-chaos.mjs', import.meta.url).href;
const dirs = [];
const procs = new Set();
after(() => {
  for (const p of procs) p.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-bridge-${name}-`));
  dirs.push(dir);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  return { dir, state, kimi: path.join(dir, 'kimi'), file: (n) => path.join(state, n) };
}

// The real connector, on a hub that is not there.
function startBridge(sc, { chaos = {}, args = ['--no-skill', '--no-broker'] } = {}) {
  const env = { ...process.env, HOME: sc.dir };
  delete env.AGENT_HUB_BRIDGE_KEY;
  delete env.AGENT_HUB_URL;
  if (chaos.mark) env.AH_CRASH_MARK = chaos.mark;
  if (chaos.log) env.AH_OP_LOG = chaos.log;
  const pre = chaos.mark || chaos.log ? ['--import', CHAOS] : [];
  const proc = spawn(process.execPath, [...pre, BRIDGE, '--hub', 'http://127.0.0.1:9', '--key', 'bk_new_key', '--name', 'box', '--kimi-home', sc.kimi, '--state-dir', sc.state, '--kimi-bin', path.join(sc.dir, 'no-kimi'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(proc);
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => proc.once('exit', (code, signal) => (procs.delete(proc), r({ code, signal }))));
  return { proc, exited, out: () => out, stop: async () => (proc.exitCode === null && proc.signalCode === null ? (proc.kill('SIGTERM'), exited) : exited) };
}
const mode = (f) => fs.statSync(f).mode & 0o777;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ----------------------------------------------------------- bridge.json

test('bridge.json: written private (0600) from the first byte, the data synced before the rename and the folder after', async () => {
  const sc = scratch('order');
  const log = path.join(sc.dir, 'ops.log');
  const b = startBridge(sc, { chaos: { log } });
  try {
    await until(() => fs.existsSync(log) && opsOf(log).includes('rename bridge.json'), 'bridge.json to be written');
    const { before, after, opens } = aroundRename(opsOf(log), 'bridge.json');
    assert.equal(before, 'fsync', 'the data is on disk right before the rename');
    assert.equal(after, 'fsync-dir', 'the folder entry is synced right after');
    assert.match(opens.at(-1), /^open bridge\.json\.\d+\.tmp w 600$/, 'created private from the start');
    assert.equal(mode(sc.file('bridge.json')), 0o600);
    const state = readJson(sc.file('bridge.json'));
    assert.equal(state.key, 'bk_new_key');
    assert.equal(state.hub, 'http://127.0.0.1:9');
  } finally {
    await b.stop();
  }
});

test('bridge.json: a kill in the middle of the rewrite leaves the old file whole; the half-written temporary file is cleaned up at the next start', async () => {
  const sc = scratch('kill');
  const old = Buffer.from(JSON.stringify({ hub: 'http://old.example', key: 'bk_old_key', name: 'old', ids: { [sc.kimi]: 'm_old0000001' } }, null, 2));
  fs.writeFileSync(sc.file('bridge.json'), old, { mode: 0o600 });
  const victim = startBridge(sc, { chaos: { mark: '"key": "bk_new_key"' } });
  const end = await victim.exited;
  assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${victim.out()}`);
  assert.ok(fs.readFileSync(sc.file('bridge.json')).equals(old), 'the old file is whole (half a file would not parse)');
  assert.equal(fs.readdirSync(sc.state).filter((f) => f.startsWith('bridge.json.') && f.endsWith('.tmp')).length, 1, 'the half-written file is what the kill left (positive control)');

  const again = startBridge(sc);
  try {
    await until(() => readJson(sc.file('bridge.json')).key === 'bk_new_key', 'the new state');
    assert.equal(readJson(sc.file('bridge.json')).ids[sc.kimi], 'm_old0000001', 'the computer keeps the code it had');
    assert.deepEqual(fs.readdirSync(sc.state).filter((f) => f.endsWith('.tmp')), [], 'cleaned up');
  } finally {
    await again.stop();
  }
});

test('bridge.json: the temporary file of a process that is gone is removed at start; a live process\'s is not touched', async () => {
  const sc = scratch('stale');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.once('exit', r));
  fs.writeFileSync(sc.file(`bridge.json.${dead.pid}.tmp`), '{"half":');
  const alive = sc.file(`bridge.json.${process.pid}.tmp`); // this test process is alive
  fs.writeFileSync(alive, '{"being":"written"}');
  const b = startBridge(sc);
  try {
    await until(() => fs.existsSync(sc.file('bridge.json')), 'bridge.json');
    assert.equal(fs.existsSync(sc.file(`bridge.json.${dead.pid}.tmp`)), false, 'a dead process\'s file is cleaned up');
    assert.equal(fs.readFileSync(alive, 'utf8'), '{"being":"written"}', 'a live process\'s file is left alone');
  } finally {
    await b.stop();
  }
});

const SECRET = 'SECRETFRAGMENT0123456789';
const DAMAGED = {
  'cut in the middle': Buffer.from(`{\n  "hub": "http://old.example",\n  "key": "bk_${SECRET}`),
  'empty': Buffer.alloc(0),
  'zero-filled (blocks that never reached the disk)': Buffer.alloc(96),
  'not JSON at all': Buffer.from('<<<<<<< HEAD\nthe merge went wrong\n'),
  'JSON, but an array': Buffer.from('[1, 2]'),
};
for (const [what, bytes] of Object.entries(DAMAGED)) {
  test(`bridge.json damaged (${what}): kept byte for byte (private) before the new state is written, and said without quoting it`, async () => {
    const sc = scratch('damaged');
    fs.writeFileSync(sc.file('bridge.json'), bytes, { mode: 0o600 });
    const b = startBridge(sc);
    try {
      await until(() => {
        try {
          return readJson(sc.file('bridge.json')).key === 'bk_new_key';
        } catch {
          return false;
        }
      }, 'a good bridge.json');
      const copies = fs.readdirSync(sc.state).filter((f) => f.startsWith('bridge.json.damaged-'));
      assert.equal(copies.length, 1, `one copy (${copies})`);
      assert.ok(fs.readFileSync(sc.file(copies[0])).equals(bytes), 'the copy is the damaged file, byte for byte');
      assert.equal(mode(sc.file(copies[0])), 0o600, 'the copy is private');
      assert.equal(mode(sc.file('bridge.json')), 0o600);
      const out = b.out();
      assert.match(out, /bridge\.json/);
      assert.match(out, /損壞/);
      assert.ok(out.includes(sc.file(copies[0])), `says where the copy is\n${out}`);
      assert.ok(!out.includes(SECRET), 'never quotes what is in the file');
    } finally {
      await b.stop();
    }
  });
}

test('bridge.json that cannot be read (a folder): not written over, the connector keeps running and says why', async () => {
  const sc = scratch('unreadable');
  fs.mkdirSync(sc.file('bridge.json'));
  const ino = fs.statSync(sc.file('bridge.json')).ino;
  const b = startBridge(sc);
  try {
    await until(() => /讀不到/.test(b.out()), 'the reason to be said');
    await sleep(1000);
    assert.equal(b.proc.exitCode, null, `still running\n${b.out()}`);
    const st = fs.statSync(sc.file('bridge.json'));
    assert.ok(st.isDirectory() && st.ino === ino, 'still what it was');
  } finally {
    await b.stop();
  }
});

// -------------------------------------------------------- the other files

test('the skill files the connector installs into Kimi are written whole too: synced before the rename, the folder after', async () => {
  const sc = scratch('skill');
  const log = path.join(sc.dir, 'ops.log');
  const b = startBridge(sc, { chaos: { log }, args: ['--no-broker'] });
  try {
    await until(() => fs.existsSync(log) && opsOf(log).includes('rename SKILL.md'), 'a skill to be installed');
    const { before, after } = aroundRename(opsOf(log), 'SKILL.md');
    assert.equal(before, 'fsync');
    assert.equal(after, 'fsync-dir');
    assert.ok(fs.existsSync(path.join(sc.kimi, 'skills', 'agent-hub-artifact', 'SKILL.md')));
  } finally {
    await b.stop();
  }
});

// The helper itself, taken out of the connector's source (it is one file, nothing
// to import) and run on a temp folder.
const source = fs.readFileSync(BRIDGE, 'utf8');
const block = source.slice(source.indexOf('// ---- durable-write:begin'), source.indexOf('// ---- durable-write:end'));
test('the connector has one helper for writing a file whole, and it does what it says', () => {
  assert.ok(block.length > 500, 'found the helper block in the connector');
  const lib = new Function('fs', 'path', 'process', `${block}\nreturn { writeFileAtomic, writeFileDurable, removeStaleTmp };`)(fs, path, process);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-durable-'));
  dirs.push(dir);

  // Whole, with the mode asked for, over an existing file with another mode.
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, 'old', { mode: 0o644 });
  lib.writeFileAtomic(f, 'new content', { mode: 0o600 });
  assert.equal(fs.readFileSync(f, 'utf8'), 'new content');
  assert.equal(mode(f), 0o600, 'a private file does not inherit what the old one had');
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'no temporary file left');

  // A write that cannot be completed: the old file is as it was and the temporary file is gone.
  const g = path.join(dir, 'taken');
  fs.mkdirSync(path.join(g, 'inside'), { recursive: true });
  assert.throws(() => lib.writeFileAtomic(g, 'x'), /EISDIR|ENOTEMPTY|EEXIST|EPERM/);
  assert.ok(fs.statSync(g).isDirectory(), 'what was there is untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'a failed write takes its temporary file with it');

  // A dead process's temporary file goes; a live one's (the parent's) stays.
  const dead = 2 ** 22 + 12345; // beyond any pid this machine hands out
  const alive = process.ppid;
  fs.writeFileSync(path.join(dir, `a.json.${dead}.tmp`), 'x');
  fs.writeFileSync(path.join(dir, `a.json.${alive}.tmp`), 'y');
  fs.writeFileSync(path.join(dir, 'b.json.1.tmp'), 'other file');
  lib.removeStaleTmp(f);
  assert.equal(fs.existsSync(path.join(dir, `a.json.${dead}.tmp`)), false);
  assert.equal(fs.existsSync(path.join(dir, `a.json.${alive}.tmp`)), true);
  assert.equal(fs.existsSync(path.join(dir, 'b.json.1.tmp')), true, 'another file\'s temporary file is not ours to remove');
});

test('every file the connector writes for itself or edits for Kimi goes through that helper (only the user\'s own files of a conversation are written in place)', () => {
  const outside = source.slice(0, source.indexOf('// ---- durable-write:begin')) + source.slice(source.indexOf('// ---- durable-write:end'));
  const raw = outside.split('\n').filter((l) => /fs\.(writeFileSync|renameSync|appendFileSync|createWriteStream)\(/.test(l) && !l.trim().startsWith('//'));
  // `write`: a file the hub saves INTO a conversation's folder (an attachment). It is the
  // person's project file, written in place on purpose: a rename would replace a link or
  // change the owner and permissions of a file that already exists.
  assert.deepEqual(raw.map((l) => l.trim().slice(0, 24)), ['fs.writeFileSync(at.abs,'], raw.join('\n'));
});
