// The connector's DeepSeek provisioning against the REAL Kimi CLI (skipped,
// with the reason, where no kimi binary is installed: KIMI_BIN or `kimi` on
// PATH). Kimi's own config API and file watcher decide what the file looks
// like after a write - the fake Kimi in the other tests only imitates that.
// Here: a [secondary_model] with only a default_effort stays the user's (the
// spec 2.4 "existing values are not overwritten" case, which the fake Kimi
// and the code reading it got wrong together). HOME is a temp dir and Kimi
// uses $HOME/.kimi-code there, the only place its config watcher follows.
// Nothing leaves this machine except what the real Kimi itself may do on
// start (run it where it cannot reach the network if that matters:
// `unshare -rn`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { parseToml, tomlSkip } from './fixtures/toml-oracle.mjs';
import { kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const gate = kimiGate('bridge-real-kimi-deepseek');
const KIMI = gate.KIMI;
const SKIP = KIMI ? tomlSkip : gate.SKIP;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-real-kimi-ds-'));
// Kimi's default place under HOME: its config watcher only follows the file there.
const KIMI_HOME = path.join(TMP, '.kimi-code');
const STATE = path.join(TMP, 'state');
const PORT = 56000 + Math.floor(Math.random() * 3000);
const DS = 'agent-hub-deepseek';
const procs = [];
// HOME is the temp dir and KIMI_CODE_HOME is unset: Kimi (and the connector) use
// $HOME/.kimi-code, never the real user's.
const { KIMI_CODE_HOME: _unused, ...BASE_ENV } = process.env;
let hubWss;
let hubWs;
let token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const kimiApi = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (j.code !== 0 && j.code !== 204) throw new Error(`kimi ${method} ${p}: ${j.code} ${j.msg}`);
  return j.data;
};
const secondary = async () => (await kimiApi('GET', '/config')).secondary_model ?? null;
const configFile = () => path.join(KIMI_HOME, 'config.toml');

const pending = new Map();
const ask = (op, args) =>
  new Promise((resolve, reject) => {
    const id = `q${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`no answer for ${op}`)), 60000);
    pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
    hubWs.send(JSON.stringify({ t: 'req', id, op, args }));
  });
const models = (names) => names.map((model) => ({ model, display_name: model, max_context_size: 1_000_000, max_output_size: 384_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] }));
const provision = (gateway, ids) => ask('kimi.deepseek.provision', { gateway, models: models(ids), pool: { revision: Date.now() % 1e9, activeId: 'dk_a', keys: [{ id: 'dk_a', apiKey: 'sk-real-kimi-test-0001' }] } });

before(async () => {
  if (SKIP) return;
  fs.mkdirSync(KIMI_HOME, { recursive: true });
  const web = spawn(KIMI, ['web', '--no-open', '--port', String(PORT)], { env: { ...BASE_ENV, HOME: TMP }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(web);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('kimi web did not start')), 30000);
    let out = '';
    const on = (d) => {
      out += d;
      if (/Kimi server ready/.test(out)) (clearTimeout(t), resolve());
    };
    web.stdout.on('data', on);
    web.stderr.on('data', on);
  });
  token = fs.readFileSync(path.join(KIMI_HOME, 'server.token'), 'utf8').trim();
  // The user's own model, and the default (the hub never touches it).
  await kimiApi('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: 'http://127.0.0.1:1/v1', default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
  await kimiApi('POST', '/models/fake%2Ffake-1:set_default');
  hubWss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => hubWss.on('listening', r));
  const connected = new Promise((resolve) => {
    hubWss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') (hubWs = ws), resolve();
        if (m.t === 'res' && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
      });
    });
  });
  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${hubWss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--state-dir', STATE, '--kimi-bin', KIMI, '--no-skill', '--no-broker'], {
    env: { ...BASE_ENV, HOME: TMP, AGENT_HUB_DEEPSEEK_TEST_URL: 'http://127.0.0.1:1' },
    stdio: 'ignore',
  });
  procs.push(bridge);
  await Promise.race([connected, sleep(20000).then(() => Promise.reject(new Error('bridge did not connect')))]);
});

after(() => {
  for (const p of procs) p.kill('SIGTERM');
  hubWss?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 500);
});

test('real Kimi: a [secondary_model] with only a default_effort stays the user\'s - nothing added, effort not overwritten', { skip: SKIP }, async () => {
  fs.appendFileSync(configFile(), '\n[secondary_model]\ndefault_effort = "high"\n');
  await until(async () => (await secondary())?.defaultEffort === 'high', 20000, 'Kimi loaded the user\'s [secondary_model]');
  const r = await provision('opencode-go', ['deepseek-v4.1-flash', 'deepseek-v4-pro']);
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.secondaryWarning || '', /default_model/);
  assert.equal(r.data.secondaryChanged, undefined);
  const now = await secondary();
  assert.deepEqual(now, { defaultEffort: 'high' }, 'Kimi still has exactly the user\'s table');
  const parsed = parseToml(fs.readFileSync(configFile(), 'utf8'));
  assert.equal(parsed.secondary_model.default_effort, 'high');
  assert.equal(parsed.secondary_model.default_model, undefined);
  assert.equal(parsed.default_model, 'fake/fake-1', 'the main default is untouched');
  assert.ok(parsed.providers[DS], 'the DeepSeek provider is provided all the same');
});
