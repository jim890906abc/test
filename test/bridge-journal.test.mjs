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
const SID2 = 'session_journal2';
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
  // A long conversation: changed to max and auto in the middle of a journal
  // much bigger than the start and the end the bridge reads whole.
  const dir2 = path.join(KIMI_HOME, 'sessions', 'ws1', SID2);
  fs.mkdirSync(path.join(dir2, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ title: '長日誌', cwd: TMP }));
  const filler = (n, at) => Array.from({ length: n }, (_, i) => ({ type: 'context.append', agentId: 'main', text: 'x'.repeat(1000), time: at + i }));
  const long = [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi/k3-256k', profileName: 'default', thinkingEffort: 'high', systemPrompt: 'x', disallowedTools: [], time: 1 },
    { type: 'permission.set_mode', agentId: 'main', mode: 'yolo', time: 2 },
    ...filler(300, 10),
    { type: 'config.update', agentId: 'main', thinkingEffort: 'max', time: 400 },
    { type: 'permission.set_mode', agentId: 'main', mode: 'auto', time: 401 },
    ...filler(800, 500),
  ];
  fs.writeFileSync(path.join(dir2, 'agents', 'main', 'wire.jsonl'), long.map((l) => JSON.stringify(l)).join('\n') + '\n');

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
          ws.send(JSON.stringify({ t: 'req', id: 'long', op: 'kimi.info', args: { sessionId: SID2 } }));
        }
        if (m.t === 'res') {
          answers.set(m.id, m);
          if (answers.size === 3) resolve();
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
  const longInfo = answers.get('long');
  assert.ok(fs.statSync(path.join(KIMI_HOME, 'sessions', 'ws1', SID2, 'agents', 'main', 'wire.jsonl')).size > 1_000_000);
  assert.equal(longInfo.data.effort, 'max');
  assert.equal(longInfo.data.permission, 'auto');
});

test('swarm mode turned on and off in a terminal Kimi is what the bridge reports; the model entering it by a tool call is not', async () => {
  const sid = 'session_journal_swarm';
  const dir = path.join(KIMI_HOME, 'sessions', 'ws1', sid);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'sub1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ title: 'swarm 日誌', cwd: TMP }));
  const main = [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi/k3-256k', profileName: 'default', thinkingEffort: 'high', systemPrompt: 'x', disallowedTools: [], time: 1 },
    { type: 'subagent.spawned', agentId: 'main', subagentId: 'sub1', time: 1.5 },
    { type: 'swarm_mode.enter', agentId: 'main', trigger: 'manual', time: 2 },
    { type: 'swarm_mode.exit', agentId: 'main', time: 3 },
    { type: 'swarm_mode.enter', agentId: 'main', trigger: 'task', time: 4 },
    { type: 'swarm_mode.exit', agentId: 'main', time: 5 },
    { type: 'swarm_mode.enter', agentId: 'main', trigger: 'tool', time: 6 },
    { type: 'swarm_mode.enter', agentId: 'main', trigger: 'manual', time: 7 },
  ];
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), main.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A subagent's own mode is not the conversation's.
  fs.writeFileSync(path.join(dir, 'agents', 'sub1', 'wire.jsonl'), [{ type: 'swarm_mode.enter', agentId: 'sub1', trigger: 'manual', time: 8 }].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const answer = await new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: 0, path: '/bridge' });
    const t = setTimeout(() => reject(new Error('bridge did not answer')), 15000);
    server.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hello') ws.send(JSON.stringify({ t: 'req', id: 'history', op: 'kimi.history', args: { sessionId: sid, turns: 10 } }));
        if (m.t === 'res') (clearTimeout(t), resolve(m), setTimeout(() => (proc.kill('SIGTERM'), server.close()), 50));
      });
    });
    let proc;
    server.on('listening', () => {
      proc = spawn(process.execPath, [path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), '--hub', `http://127.0.0.1:${server.address().port}`, '--key', 'k', '--kimi-home', KIMI_HOME, '--kimi-bin', path.join(TMP, 'no-kimi'), '--no-skill', '--state-dir', path.join(TMP, 'state-swarm')], { env: { ...process.env, HOME: TMP }, stdio: 'ignore' });
    });
  });
  assert.equal(answer.ok, true);
  const swarm = answer.data.frames.filter((f) => f.type === 'agent.status.updated' && 'swarmMode' in f.payload);
  assert.deepEqual(swarm.map((f) => [f.payload.agentId, f.payload.swarmMode]), [['main', true], ['main', false], ['main', true], ['main', false], ['main', true]], 'on, off, on (a one-shot task), off, on; the tool entry and the subagent say nothing');
});
