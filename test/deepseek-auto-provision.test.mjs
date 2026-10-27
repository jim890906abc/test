import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-auto-provision-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const account = await import('../server/deepseek-account.js');
const machines = await import('../server/machines.js');
const GW = 'opencode-go';
const KEY = 'sk-auto-provision-secret-0001';
const KEY2 = 'sk-auto-provision-secret-0002';
const MODEL = 'agent-hub-deepseek/deepseek-v4.1-flash';
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve(fn()).catch(() => null);
    if (value) return value;
    await wait();
  }
  throw new Error(`timeout: ${what}`);
}
const answer = (args, secondaryModel = { model: MODEL, models: [MODEL], effort: 'max', force: false }) => ({ ok: true, models: args.models.map((m) => `agent-hub-deepseek/${m.model}`), secondaryModel });

function reset() {
  account.reload();
  for (const gw of ['opencode-go', 'opencode', 'commandcode']) account.clearKey(gw);
  account.setSettings({ gateway: GW });
}

function connect(id, onRequest) {
  const requests = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {};
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== 'req') return;
    requests.push(msg);
    onRequest?.(msg, (data) => ws.emit('message', JSON.stringify({ t: 'res', id: msg.id, ok: true, data })));
  };
  machines.attachBridge(ws);
  ws.emit('message', JSON.stringify({ t: 'hello', machineId: id, name: id, platform: 'test', home: TMP, bridgeVersion: '1.0.0', pool: 1, status: { available: true, server: true } }));
  return requests;
}

after(async () => {
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('provisionOnline starts every online machine without waiting for the first', async () => {
  reset();
  connect('auto_a');
  connect('auto_b');
  account.setKey(GW, KEY);
  const calls = [];
  const rpc = (machineId, op, args) => new Promise((resolve) => calls.push({ machineId, op, args, resolve }));
  let settled = false;
  const pending = account.provisionOnline({ rpc });
  pending.then(() => { settled = true; });
  await until(() => calls.length === 2, 4000, 'both machines provisioned');
  assert.deepEqual(new Set(calls.map((c) => c.machineId)), new Set(['auto_a', 'auto_b']));
  assert.ok(calls.every((c) => c.op === 'kimi.deepseek.provision'));
  calls.find((c) => c.machineId === 'auto_b').resolve(answer(calls[1].args));
  await wait(40);
  assert.equal(settled, false, 'one machine does not finish the other, but both were already sent');
  calls.find((c) => c.machineId === 'auto_a').resolve(answer(calls[0].args));
  const results = await pending;
  assert.ok(results.every((r) => r.ok && r.secondaryModel.model === MODEL));
  assert.deepEqual(account.publicAccount().secondaryModels.map((s) => [s.machineId, s.model, s.effort]), [['auto_a', MODEL, 'max'], ['auto_b', MODEL, 'max']]);
});

test('automatic provision errors are visible, redacted and throttled until state changes', async () => {
  reset();
  connect('auto_failure');
  account.setKey(GW, KEY);
  let calls = 0;
  const fail = async () => { calls++; throw new Error(`gateway refused ${KEY}`); };
  const ids = ['auto_failure'];
  const first = await account.provisionOnline({ rpc: fail, ids });
  assert.equal(first[0].ok, false);
  assert.ok(!JSON.stringify(account.publicAccount()).includes(KEY));
  assert.match(account.publicAccount().warnings.find((w) => w.machineId === 'auto_failure').text, /…0001/);
  const second = await account.provisionOnline({ rpc: fail, ids });
  assert.equal(second[0].throttled, true);
  assert.equal(calls, 1, 'no immediate retry storm');

  account.setKey(GW, KEY2);
  const recovered = await account.provisionOnline({ ids, rpc: async (id, op, args) => answer(args, { model: 'custom/keep', models: ['custom/keep'], effort: 'high', force: true }) });
  assert.equal(recovered[0].ok, true);
  assert.equal(recovered[0].secondaryModel.model, 'custom/keep');
  assert.equal(recovered[0].secondaryModel.force, true, 'an existing secondary is reported, not rewritten');
  assert.equal(account.publicAccount().warnings.length, 0);
});

test('bridge hello provisions in the background and reports the actual secondary', async () => {
  reset();
  account.setKey(GW, KEY);
  const requests = connect('auto_hello', (msg, reply) => {
    if (msg.op === 'kimi.deepseek.provision') queueMicrotask(() => reply(answer(msg.args)));
  });
  assert.equal(requests.length, 0, 'hello itself did not await provision');
  await until(() => requests.length === 1, 4000, 'background provision request');
  assert.equal(requests[0].op, 'kimi.deepseek.provision');
  await until(() => account.publicAccount().secondaryModels.some((s) => s.machineId === 'auto_hello' && s.model === MODEL && s.effort === 'max'), 4000, 'secondary projection');
});

test('no key and offline machines do not create background provisions', async () => {
  reset();
  let calls = 0;
  const rpc = async () => { calls++; return { ok: true }; };
  assert.deepEqual(await account.provisionOnline({ rpc, list: () => [{ id: 'offline', online: false, kimi: { server: true } }] }), []);
  assert.equal(calls, 0);
});
