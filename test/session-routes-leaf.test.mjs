// An old node of a switched conversation is a link in the chain, not a place
// to act: every /api/sessions/:id/... request is about the conversation, so
// it lands on the current leaf — read, write, send, schedule, pause, files.
// The chain: s_old (Kimi, machine offline) -> s_leaf (a plain agent whose
// folder holds a marker file); and s_k1 -> s_k2 (both Kimi) for the writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-routes-'));
const DATA = path.join(TMP, 'data');
const OLD_DIR = path.join(TMP, 'old-folder');
const LEAF_DIR = path.join(TMP, 'leaf-folder');
const PORT = 26000 + Math.floor(Math.random() * 1000);
let server;
let log = '';

const node = (id, patch) => ({
  id, conversationId: id, title: id, status: 'idle', permissionMode: 'ask', allowedTools: [], events: [], state: {},
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: 1000, updatedAt: 1000, provider: 'kimi',
  agentId: 'kimi@m_off', machineId: 'm_off', kimiSessionId: `k_${id}`, cwd: OLD_DIR, meta: {}, ...patch,
});
const put = (s) => fs.writeFileSync(path.join(DATA, 'sessions', `${s.id}.json`), JSON.stringify(s));
const call = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

before(async () => {
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  fs.mkdirSync(OLD_DIR, { recursive: true });
  fs.mkdirSync(LEAF_DIR, { recursive: true });
  fs.writeFileSync(path.join(LEAF_DIR, 'leaf-marker.txt'), 'only the leaf folder has this');
  fs.writeFileSync(path.join(OLD_DIR, 'old-marker.txt'), 'only the old folder has this');
  // plain leaf
  put(node('s_old', { continuedTo: 's_leaf' }));
  put(node('s_leaf', { continuedFrom: 's_old', conversationId: 's_old', agentId: 'plain', machineId: undefined, kimiSessionId: undefined, provider: 'claude', cwd: LEAF_DIR, events: [{ id: 'ev1', ts: 1, type: 'text', text: 'on the leaf' }] }));
  // Kimi -> Kimi, for writes
  put(node('s_k1', { continuedTo: 's_k2' }));
  put(node('s_k2', { continuedFrom: 's_k1', conversationId: 's_k1', scheduled: [{ id: 'q_leaf', text: 'later', at: Date.now() + 3600_000, createdAt: 1, attempts: 0, retryAt: 0, error: null, wait: null }] }));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
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
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('every action on an old node answers exactly as it does on the leaf (the leaf is plain, the old node is Kimi: they cannot answer alike by accident)', async () => {
  const same = [
    ['GET', '/files'],
    ['GET', '/file?path=leaf-marker.txt'],
    ['GET', '/changes'],
    ['POST', '/viewing'],
    ['POST', '/repo', { repo: 'a/b' }],
    ['POST', '/command', { name: 'compact' }],
    ['POST', '/earlier'],
    ['POST', '/autopause', { enabled: true }],
    ['POST', '/schedule', { text: 'x', at: Date.now() + 60000 }],
    ['POST', '/queue/steer-all'],
    ['POST', '/queue/p1/steer'],
    ['DELETE', '/queue/p1'],
    ['POST', '/background'],
    ['POST', '/unlock'],
    ['POST', '/interrupt'],
    ['POST', '/permissions/ev1', { optionId: 'allow' }],
    ['POST', '/backup'],
    ['DELETE', '/pending-switch'],
  ];
  const seen = [];
  for (const [method, suffix, body] of same) {
    const viaOld = await call(method, `/sessions/s_old${suffix}`, body);
    const viaLeaf = await call(method, `/sessions/s_leaf${suffix}`, body);
    assert.equal(viaOld.status, viaLeaf.status, `${method} ${suffix}: status ${viaOld.status} (old) vs ${viaLeaf.status} (leaf): ${JSON.stringify(viaOld.body)} | ${JSON.stringify(viaLeaf.body)}`);
    assert.deepEqual(viaOld.body, viaLeaf.body, `${method} ${suffix}`);
    seen.push(`${method} ${suffix} -> ${viaLeaf.status}`);
  }
  // The leaf's own answers are the plain ones, so equality above means the old node was not used.
  assert.match((await call('GET', '/sessions/s_old/files')).body.map?.((e) => e.name).join(','), /leaf-marker\.txt/);
  assert.equal((await call('POST', '/sessions/s_old/autopause', { enabled: true })).status, 400);
  assert.ok(seen.length >= 17);
});

test('writes on an old node land on the leaf: rename, Hub-level permission, scheduling and its cancellation, auto-pause', async () => {
  const renamed = await call('PATCH', '/sessions/s_k1', { title: 'new title', permissionMode: 'bypass' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.id, 's_k2', 'the answer is the leaf');
  const leaf = (await call('GET', '/sessions/s_k2')).body;
  assert.equal(leaf.title, 'new title');
  assert.equal(leaf.permissionMode, 'bypass');
  const viaOld = (await call('GET', '/sessions/s_k1')).body;
  assert.equal(viaOld.permissionMode, 'bypass', 'reading through the old URL shows the same conversation');
  await new Promise((r) => setTimeout(r, 2300));
  const files = (id) => JSON.parse(fs.readFileSync(path.join(DATA, 'sessions', `${id}.json`), 'utf8'));
  assert.equal(files('s_k1').permissionMode, 'ask', 'the old node\'s file was not written');
  assert.equal(files('s_k1').title, 's_k1');
  assert.equal(files('s_k2').permissionMode, 'bypass');

  const added = await call('POST', '/sessions/s_k1/schedule', { text: 'from old url', at: Date.now() + 120000 });
  assert.equal(added.status, 200);
  assert.equal(added.body.id, 's_k2');
  assert.deepEqual(added.body.scheduled.map((x) => x.text).sort(), ['from old url', 'later']);
  const cancelled = await call('DELETE', '/sessions/s_k1/schedule/q_leaf');
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body.scheduled.map((x) => x.text), ['from old url']);

  const paused = await call('POST', '/sessions/s_k1/autopause', { enabled: true, threshold: 80 });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.id, 's_k2');
  assert.equal(paused.body.autoPause.enabled, true);
  assert.equal(paused.body.autoPause.threshold, 80);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call('GET', '/sessions/s_k2')).body.autoPause.enabled, true);
});

test('an unknown id is still a 404 on every route', async () => {
  for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/schedule'], ['GET', '/files'], ['POST', '/interrupt'], ['POST', '/autopause']]) {
    const r = await call(method, `/sessions/s_missing${suffix}`, method === 'GET' ? undefined : {});
    assert.equal(r.status, 404, `${method} ${suffix}`);
  }
});

test('the code cannot quietly go back: session routes take their session from the shared resolver', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.doesNotMatch(src, /mustSession\(/);
  assert.doesNotMatch(src, /mustLeafSession\(/);
  // Outside the resolver and the three handlers that need the node's own id
  // (snapshot redirect, chain delete, permission lookup) no session route may
  // read the id itself.
  const handlers = src.split(/\n(?=app\.(?:get|post|put|patch|delete)\()/).filter((h) => /^app\.\w+\('\/api\/sessions\/:id/.test(h));
  assert.ok(handlers.length >= 20, `found ${handlers.length} session routes`);
  const allowed = [/^app\.get\('\/api\/sessions\/:id',/, /^app\.delete\('\/api\/sessions\/:id',/, /^app\.post\('\/api\/sessions\/:id\/permissions/];
  for (const h of handlers) {
    if (allowed.some((re) => re.test(h))) continue;
    assert.doesNotMatch(h, /req\.params\.id|getSession\(/, `${h.split('\n')[0]} reads the id itself instead of using the resolved leaf`);
  }
});
