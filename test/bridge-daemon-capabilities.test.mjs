// The connector and the Claude daemon it starts: the connector's hello says
// what it can do (`capabilities`), and it never hands work that depends on new
// daemon features to a daemon that lacks them. The daemon reports what it can
// do in /health.capabilities (handoff, broker, subagent_config). A daemon that
// is old (no field, or missing one) and has conversations running is reported
// to the hub as stale and kept for the running work only; it is replaced the
// moment it is idle. The real connector, a fake hub (HTTP + WebSocket, serving
// the daemon file) and fake daemons; no Claude, no account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { assertNoLeaks, snapshot } from './fixtures/leak-guard.mjs';
import { stopChildSync, stopDaemons } from './fixtures/stop-daemons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FAKE_DAEMON = path.join(ROOT, 'test/fixtures/fake-claude-daemon.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-daemon-caps-'));
const leaksBefore = snapshot();
const STATE = path.join(TMP, 'state');
const DIR = path.join(STATE, 'claude');
const NEEDS = 'handoff,broker,subagent_config';
// The version the hub asks for. Fresh for each test: the connector trusts a
// health check for a few seconds, and only for the version it was asked about.
let hubBuild = 0;
let HUB_VERSION = 'hub-build-0';

let hubHttp;
let hubWss;
let hubWs;
let bridge;
let hellos = [];
let states = []; // daemon.state messages
let helloWaiters = [];
let downloads = 0;
const pending = new Map();
const spawned = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const ask = (op, args) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`no answer for ${op}`)), 30000);
    pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
  });
const rpc = (op, a = {}, version = HUB_VERSION) => ask('claude.rpc', { op, args: a, version });
const rpcLog = () => {
  try {
    return fs.readFileSync(path.join(DIR, 'rpc.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const pidOf = () => JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.json'), 'utf8')).pid;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function startDaemon(env = {}, running = null) {
  fs.rmSync(path.join(DIR, 'daemon.json'), { force: true });
  if (running) busy(running); // before it starts: no moment where it looks idle
  const child = spawn(process.execPath, [FAKE_DAEMON, '--dir', DIR], { env: { ...process.env, ...env }, stdio: 'ignore' });
  spawned.push(child);
  return until(() => (fs.existsSync(path.join(DIR, 'daemon.json')) && JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.json'), 'utf8')).pid === child.pid ? child : null), 8000, 'fake daemon up');
}
function busy(ids) {
  fs.writeFileSync(path.join(DIR, 'busy.json'), JSON.stringify(ids));
}
async function reset() {
  HUB_VERSION = `hub-build-${++hubBuild}`;
  for (const c of spawned.splice(0)) c.kill('SIGTERM');
  await sleep(150);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(path.join(STATE, 'claude-daemon.mjs'), { force: true });
  fs.mkdirSync(DIR, { recursive: true });
  states = [];
  downloads = 0;
}

before(async () => {
  hubHttp = http.createServer((req, res) => {
    if (req.url === '/bridge/claude-daemon.mjs') {
      downloads++;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(fs.readFileSync(FAKE_DAEMON));
    }
    res.writeHead(404).end();
  });
  hubWss = new WebSocketServer({ server: hubHttp, path: '/bridge' });
  await new Promise((r) => hubHttp.listen(0, '127.0.0.1', r));
  hubWss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') {
        hubWs = ws;
        hellos.push(m);
        const w = helloWaiters;
        helloWaiters = [];
        for (const r of w) r();
      }
      if (m.t === 'daemon.state') states.push(m);
      if (m.t === 'res' && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
  });
  fs.mkdirSync(DIR, { recursive: true });
  const connected = new Promise((r) => helloWaiters.push(r));
  // The daemon this connector downloads and starts reports every capability.
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubHttp.address().port}`, '--key', 'k', '--kimi-home', path.join(TMP, 'kimi'), '--state-dir', STATE, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--no-broker'], {
    env: { ...process.env, HOME: TMP, FAKE_DAEMON_VERSION: 'new-build', FAKE_DAEMON_CAPS: NEEDS, AGENT_HUB_DAEMON_RECHECK_MS: '200' },
    stdio: 'ignore',
  });
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('bridge did not connect')))]);
});

after(async () => {
  // The connector starts the daemon it downloaded (STATE/claude-daemon.mjs --dir
  // STATE/claude) detached, so it outlives the connector: end the connector
  // first (it would start another), then every daemon of this scratch folder.
  if (bridge) stopChildSync(bridge);
  for (const c of spawned) c.kill('SIGTERM');
  await stopDaemons(TMP);
  hubWss?.close();
  hubHttp?.close();
  await sleep(300);
  try {
    await assertNoLeaks(leaksBefore, { dirs: [TMP] }); // nothing this file started may outlive it
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

test('the hello names only what this connector really supports, and the version says where that started', () => {
  const h = hellos.at(-1);
  assert.deepEqual(h.capabilities, ['pool', 'pool_cross', 'secondary_model', 'handoff', 'pool_timing', 'pool_measure', 'event_timing', 'pool_auth'], 'no broker: it was started with --no-broker');
  assert.equal(h.bridgeVersion, '0.11.0');
  assert.equal(h.pool, 1);
  assert.equal(h.broker, 0, 'the numeric flag agrees with the capability');
  assert.equal(h.daemonStale, false);
  const source = fs.readFileSync(path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'utf8');
  assert.match(source, /const VERSION = '0\.11\.0'/);
});

test('a busy daemon without the capabilities is reported stale and refuses only what needs them; it is kept for the running work', async () => {
  await reset();
  const old = await startDaemon({ FAKE_DAEMON_VERSION: 'old-build' }, ['session-1']); // no `capabilities` field at all
  const oldPid = old.pid;

  // A call carrying a subagent default would be silently dropped by this daemon.
  const refused = await rpc('send', { id: 's1', text: 'hi', auth: { subagent: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' } } });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /舊版本/);
  assert.match(refused.error, /handoff、broker、subagent_config/, 'says what it lacks');
  assert.deepEqual(rpcLog(), [], 'nothing reached the old daemon');
  await until(() => states.at(-1)?.stale === true, 5000, 'the hub is told');
  assert.match(states.at(-1).reason, /正在跑/);

  // So is a create that carries a handoff.
  const handoff = await rpc('create', { id: 's2', cwd: TMP, config: { handoff: 'earlier history', handoffFrom: { provider: 'kimi' }, subagent: null } });
  assert.equal(handoff.ok, false);
  assert.match(handoff.error, /舊版本/);

  // What keeps the running conversation going is never refused: stop, answer a
  // permission, read, and a send with no new field.
  for (const [op, a] of [
    ['interrupt', { id: 'session-1', auth: { subagent: { provider: 'deepseek' } } }],
    ['respond', { id: 'session-1', eventId: 'e', optionId: 'yes', auth: { subagent: { provider: 'deepseek' } } }],
    ['snapshot', { id: 'session-1' }],
    ['send', { id: 'session-1', text: 'plain', auth: { subagent: null } }],
  ]) {
    const r = await rpc(op, a);
    assert.equal(r.ok, true, `${op}: ${r.error}`);
    assert.equal(r.data.handledBy, 'old-build');
  }
  assert.deepEqual(rpcLog().map((x) => x.op), ['interrupt', 'respond', 'snapshot', 'send']);
  assert.equal(alive(oldPid), true, 'busy: not restarted');
  assert.equal(pidOf(), oldPid);
  assert.equal(downloads, 0);
});

test('the moment the stale daemon is idle it is replaced by the hub\'s build, and the hub is told it is no longer stale', async () => {
  const oldPid = pidOf();
  busy([]);
  // Any call (here a harmless read) lets the connector see the daemon is idle;
  // its own recheck would find out within a moment anyway.
  await until(() => pidOf() !== oldPid, 10000, 'the daemon is replaced');
  await until(() => states.at(-1)?.stale === false, 5000, 'the hub is told it is fine again');
  assert.equal(alive(oldPid), false, 'the old process is gone');
  assert.ok(downloads >= 1, 'the hub\'s file was downloaded');
  const r = await rpc('send', { id: 's1', text: 'hi', auth: { subagent: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.handledBy, 'new-build');
  const log = rpcLog().at(-1);
  assert.equal(log.args.auth.subagent.provider, 'deepseek', 'the field reached a daemon that keeps it');
});

test('an idle old daemon is replaced at once, before the call is made', async () => {
  await reset();
  await startDaemon({ FAKE_DAEMON_VERSION: 'old-build', FAKE_DAEMON_CAPS: 'handoff' });
  const oldPid = pidOf();
  const r = await rpc('create', { id: 's3', cwd: TMP, config: { handoff: 'history', subagent: { provider: 'deepseek' } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.handledBy, 'new-build');
  assert.notEqual(pidOf(), oldPid);
  assert.equal(alive(oldPid), false);
});

test('a daemon missing even one capability counts as stale, one that has them all does not', async () => {
  await reset();
  await startDaemon({ FAKE_DAEMON_VERSION: 'partial', FAKE_DAEMON_CAPS: 'handoff,broker' }, ['x']); // no subagent_config
  const refused = await rpc('configure', { id: 's', change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /subagent_config/);
  assert.ok(!/handoff、/.test(refused.error), 'names only what is missing');
  // Capable but older: kept while busy and used (nothing it lacks is needed).
  await reset();
  await startDaemon({ FAKE_DAEMON_VERSION: 'capable-old', FAKE_DAEMON_CAPS: NEEDS }, ['x']);
  const pid = pidOf();
  const ok = await rpc('send', { id: 's', text: 'hi', auth: { subagent: { provider: 'deepseek' } } });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.handledBy, 'capable-old');
  assert.equal(pidOf(), pid);
  assert.equal(states.filter((s) => s.stale).length, 0);
});

test('the hub\'s own build is never stale, whatever it reports, and is not restarted in a loop', async () => {
  await reset();
  // The hub asks for this build and the daemon on the machine IS that build,
  // but reports no capabilities (a hub from before the field existed).
  await startDaemon({ FAKE_DAEMON_VERSION: HUB_VERSION }, ['x']);
  const pid = pidOf();
  for (let i = 0; i < 3; i++) {
    const r = await rpc('send', { id: 's', text: 'hi', auth: { subagent: { provider: 'deepseek' } } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.handledBy, HUB_VERSION);
  }
  assert.equal(pidOf(), pid, 'never restarted');
  assert.equal(downloads, 0);
  assert.equal(states.filter((s) => s.stale).length, 0);
  // Likewise a replacement started from what the hub served: it reports its
  // own version, which differs from the hub's hash, and capabilities that this
  // test's hub build lacks - still consistent, so no loop.
  await reset();
  const r = await rpc('send', { id: 's', text: 'hi', auth: { subagent: { provider: 'deepseek' } } });
  assert.equal(r.ok, true, r.error);
  const first = pidOf();
  const again = await rpc('send', { id: 's', text: 'again', auth: { subagent: { provider: 'deepseek' } } });
  assert.equal(again.ok, true, again.error);
  assert.equal(pidOf(), first, 'the second call used the daemon the first one started');
});

test('a connector that reconnects tells the hub about a daemon that is still stale', async () => {
  await reset();
  await startDaemon({ FAKE_DAEMON_VERSION: 'old-build' }, ['x']);
  const refused = await rpc('send', { id: 's', text: 'hi', auth: { subagent: { provider: 'deepseek' } } });
  assert.equal(refused.ok, false);
  const connected = new Promise((r) => helloWaiters.push(r));
  hubWs.close();
  await Promise.race([connected, sleep(15000).then(() => Promise.reject(new Error('no reconnect')))]);
  const h = hellos.at(-1);
  assert.equal(h.daemonStale, true);
  assert.match(h.daemonStaleReason, /舊版本/);
});
