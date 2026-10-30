// A REAL Hub process (server/index.js) on a temp data folder, with the fake
// Kimi machine and a fake Claude API around it. Nothing of the Hub is replaced:
// the runner, the kimi-remote adapter, the Claude mirror and the Claude daemon
// it spawns all run for real.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeClaude, wait } from './fake-anthropic.mjs';
import { startFakeGateway, startFakeMachine, GATEWAY_KEY } from './fake-machine.mjs';
import { assertNoLeaks, snapshot } from './leak-guard.mjs';
import { stopHubAndDaemons } from './stop-daemons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const CLAUDE_KEY = `sk-ant-api03-${'k'.repeat(40)}-test`;
export { wait };

export async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// `machine`: options of the fake computer (see startFakeMachine), or a function
// of the scratch folder that gives them.
export async function startRealHub(name, { claude = false, seed, machine: machineOptions } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-${name}-`));
  const before = snapshot(); // for the check in stop()
  const DATA = path.join(TMP, 'data');
  fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
  seed?.(DATA);
  const PORT = 30000 + Math.floor(Math.random() * 5000);
  const fakeClaude = claude ? await startFakeClaude(CLAUDE_KEY) : null;
  const gateway = await startFakeGateway();
  const env = { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws'), AGENT_HUB_DEEPSEEK_TEST_URL: gateway.url };
  delete env.ANTHROPIC_API_KEY;
  if (fakeClaude) env.AGENT_HUB_CLAUDE_TEST_URL = fakeClaude.url;
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start:\n${log}`)), 30000);
    const on = (d) => {
      log += d;
      if (log.includes('已啟動')) (clearTimeout(t), resolve());
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
  });
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: text }; }
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, body: j });
    return j;
  };
  const key = JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey;
  const machine = startFakeMachine({ port: PORT, key, id: 'm_fake', ...(typeof machineOptions === 'function' ? machineOptions(TMP) : machineOptions || {}) });
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((m) => m.id === 'm_fake' && m.online), 10000, 'machine online');
  if (fakeClaude) {
    // The Claude of that computer: a real daemon, reached through the machine.
    await machine.startClaudeDaemon({ root: ROOT, dir: path.join(TMP, 'machine-claude'), anthropicUrl: fakeClaude.url });
    await api('PUT', '/claude', { apiKey: CLAUDE_KEY });
  }
  return {
    TMP, DATA, PORT, api, machine, fakeClaude, gateway, log: () => log,
    // Stop the Hub (it writes what it still holds on SIGTERM) and its machine,
    // but keep the data folder: the next Hub starts on a copy of it. stop()
    // still cleans up afterwards.
    async halt() {
      machine.close();
      if (proc.exitCode === null) {
        const gone = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await gone;
      }
    },
    async setDeepseekKey() {
      await api('PUT', '/deepseek', { apiKey: GATEWAY_KEY });
      await until(async () => machine.dsModels.length, 10000, 'DeepSeek provisioned on the machine');
    },
    async stop() {
      machine.close();
      // The Hub until it is really gone, then every Claude daemon started on
      // this scratch folder: the Hub's own (DATA/claude-daemon) and the fake
      // machine's (TMP/machine-claude). A daemon outlives its Hub, and a Hub
      // that still runs starts a new one, so this order matters.
      stopHubAndDaemons(proc, TMP);
      fakeClaude?.close();
      gateway.close();
      await wait(300);
      await assertNoLeaks(before, { dirs: [TMP], stamp: false }); // nothing of this Hub (or its daemons) may outlive it
      fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
}
