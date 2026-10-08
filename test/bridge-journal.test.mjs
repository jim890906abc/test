// The bridge reading a conversation from Kimi's journal on disk: a thinking
// or model change (recorded as config.update, after the profile.bind that
// started the conversation) is what it reports, in the status and in the
// history it replays.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-journal-'));
const KIMI_HOME = path.join(TMP, 'kimi');
const SID = 'session_journal1';
let bridge;
let wss;

after(() => {
  bridge?.kill('SIGTERM');
  wss?.close();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

test('thinking changed after the conversation started is what the bridge reports', async () => {
  const dir = path.join(KIMI_HOME, 'sessions', 'ws1', SID);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ title: '日誌', cwd: TMP }));
  const lines = [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi/k3-256k', profileName: 'default', thinkingEffort: 'high', systemPrompt: 'x', disallowedTools: [], time: 1 },
    { type: 'turn.prompt', turnId: 't1', promptId: 'p1', origin: { kind: 'user' }, input: [{ type: 'text', text: '開始' }], time: 2 },
    { type: 'config.update', agentId: 'main', thinkingEffort: 'max', time: 3 },
  ];
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // A hub that asks the bridge about the conversation.
  wss = new WebSocketServer({ port: 0, path: '/bridge' });
  await new Promise((r) => wss.on('listening', r));
  const answers = new Map();
  const asked = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') {
          ws.send(JSON.stringify({ t: 'req', id: 'info', op: 'kimi.info', args: { sessionId: SID } }));
          ws.send(JSON.stringify({ t: 'req', id: 'history', op: 'kimi.history', args: { sessionId: SID, turns: 10 } }));
        }
        if (m.t === 'res') {
          answers.set(m.id, m);
          if (answers.size === 2) resolve();
        }
      });
    });
  });
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${wss.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill'], {
    env: { ...process.env, HOME: TMP },
    stdio: 'ignore',
  });
  await Promise.race([asked, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge did not answer')), 15000))]);

  const info = answers.get('info');
  assert.equal(info.ok, true);
  assert.equal(info.data.effort, 'max');
  assert.equal(info.data.model, 'kimi/k3-256k');
  const frames = answers.get('history').data.frames.filter((f) => f.type === 'agent.status.updated' && f.payload.thinkingEffort);
  assert.deepEqual(frames.map((f) => f.payload.thinkingEffort).slice(-2), ['high', 'max'], 'replayed in order, ending on max');
});
