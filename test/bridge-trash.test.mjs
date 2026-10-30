// The connector's side of a cluster's full purge (完全清除): it says it can do it
// (`kimi_delete`), lets the Hub ask Kimi to :delete a conversation, tells the Hub
// where Kimi keeps a conversation and where its own trash is, and deletes the
// backups a purge left in that trash once their 7 days are up - at start, and
// again every so often - and nothing else.
//
// The real connector spawned against a fake Hub socket (no Kimi needed), with
// its home, state folder and Kimi home all scratch folders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-trash-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const STATE_DIR = path.join(TMP, 'state');
const TRASH = path.join(STATE_DIR, 'trash');
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const source = fs.readFileSync(path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'utf8');

let bridge;
let hubWss;
let hubWs;
let hello;
const pending = new Map();

const until = async (fn, ms = 10000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ask = (op, args, ms = 20000) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no answer for ${op}`));
    }, ms);
    pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
  });

const name = (n) => `cluster-c_${String(n).padStart(12, '0')}-20260101-000000.tar.gz`;
// A file whose mtime is `ageMs` ago.
function put(file, ageMs, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

before(async () => {
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // What is in the trash when the connector starts.
  put(path.join(TRASH, name(1)), 8 * DAY); // expired
  put(path.join(TRASH, name(2)), 7 * DAY + 5000); // just expired
  put(path.join(TRASH, name(3)), 7 * DAY - 3_600_000); // an hour short
  put(path.join(TRASH, name(4)), 1000); // new
  put(path.join(TRASH, 'notes-from-the-user.txt'), 30 * DAY); // old, but not a backup's name
  put(path.join(TRASH, 'cluster-x-20260101.tar.gz'), 30 * DAY); // looks alike, is not one
  put(path.join(TRASH, `${name(5)}.partial`), 30 * DAY); // an unfinished one is not a finished one either
  fs.mkdirSync(path.join(TRASH, name(6))); // a folder with a backup's name
  fs.symlinkSync(path.join(TMP, 'precious'), path.join(TRASH, name(7))); // a link with a backup's name
  put(path.join(TMP, 'precious'), 30 * DAY, 'do not delete');
  // A conversation as Kimi keeps it (the connector finds it by its id).
  fs.mkdirSync(path.join(KIMI_HOME, 'sessions', 'wd_project_0123456789ab', 'session_abc-123', 'agents', 'main'), { recursive: true });
  hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => hubWss.on('listening', r));
  let helloSeen;
  const connected = new Promise((r) => (helloSeen = r));
  hubWss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') {
        hubWs = ws;
        hello = m;
        helloSeen();
      } else if (m.t === 'res' && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
  });
  const env = { ...process.env, HOME: TMP, AGENT_HUB_TRASH_SWEEP_MS: '300' };
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE_DIR, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], { env, stdio: 'ignore' });
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
});

after(() => {
  bridge?.kill('SIGTERM');
  hubWss?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('the hello says this connector can delete a Kimi conversation (kimi_delete)', () => {
  assert.ok(hello.capabilities.includes('kimi_delete'), hello.capabilities.join(','));
});

test('Kimi\'s :delete of a conversation is allowed through the connector, and nothing nearby is', () => {
  const block = source.slice(source.indexOf('const ALLOW = ['), source.indexOf('const allowed = '));
  const allowed = new Function(`${block}\nreturn (method, p) => ALLOW.some(([m, re]) => m === method && re.test(p));`)();
  const sid = 'session_0123abcd-4567';
  assert.equal(allowed('POST', `/api/v1/sessions/${sid}:delete`), true);
  assert.equal(allowed('POST', `/api/v1/sessions/${sid}:archive`), true, 'archive still is');
  for (const bad of [`/api/v1/sessions/${sid}:destroy`, `/api/v1/sessions/${sid}:delete/x`, '/api/v1/sessions/other:delete', `/api/v1/sessions/${sid}/../x:delete`, '/api/v1/sessions:delete']) assert.equal(allowed('POST', bad), false, bad);
  assert.equal(allowed('GET', `/api/v1/sessions/${sid}:delete`), false);
  assert.equal(allowed('DELETE', `/api/v1/sessions/${sid}`), false, 'no HTTP DELETE either');
});

test('trash.info says where Kimi keeps the asked conversations (null for one that is not there or an id that is not an id) and where the trash is', async () => {
  const r = await ask('trash.info', { sessionIds: ['session_abc-123', 'session_nope', '../../etc', 'session_../x', 42] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.trashDir, TRASH);
  assert.equal(r.data.days, 7);
  assert.deepEqual(r.data.dirs, {
    'session_abc-123': path.join(KIMI_HOME, 'sessions', 'wd_project_0123456789ab', 'session_abc-123'),
    session_nope: null,
    '../../etc': null,
    'session_../x': null,
    42: null,
  });
  assert.deepEqual((await ask('trash.info', {})).data.dirs, {});
});

test('at start the connector deletes the backups past 7 days and only those: not the new ones, not a file that is not a backup\'s name, not a folder or a link', async () => {
  await until(() => !fs.existsSync(path.join(TRASH, name(1))), 5000, 'the expired backup deleted');
  assert.ok(!fs.existsSync(path.join(TRASH, name(2))), 'just past 7 days');
  assert.ok(fs.existsSync(path.join(TRASH, name(3))), 'an hour short of 7 days stays');
  assert.ok(fs.existsSync(path.join(TRASH, name(4))), 'a new one stays');
  assert.ok(fs.existsSync(path.join(TRASH, 'notes-from-the-user.txt')));
  assert.ok(fs.existsSync(path.join(TRASH, 'cluster-x-20260101.tar.gz')));
  assert.ok(fs.existsSync(path.join(TRASH, `${name(5)}.partial`)));
  assert.ok(fs.statSync(path.join(TRASH, name(6))).isDirectory());
  assert.ok(fs.lstatSync(path.join(TRASH, name(7))).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(TMP, 'precious'), 'utf8'), 'do not delete', 'what the link points at is untouched');
});

test('and it keeps checking: a backup that grows old while the connector runs is deleted by the next check (every so often, once a day by default)', async () => {
  put(path.join(TRASH, name(8)), 9 * DAY);
  await until(() => !fs.existsSync(path.join(TRASH, name(8))), 5000, 'the next check deleted it');
  assert.ok(fs.existsSync(path.join(TRASH, name(4))), 'a young one is still kept');
});
