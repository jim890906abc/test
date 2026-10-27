// Seed conversations for the real-browser UI tests: one of each shape the
// front end has to tell apart. Built on seedSession() so they load through the
// same restore path (running tool calls become "interrupted" on a restart, and
// a subagent whose call is over is settled with it) as real stored conversations.
// A card here must be a state the Hub can really leave behind AFTER that
// restore: the stored "running" under a finished or cut call no longer
// survives it (the card is settled as done / cancelled), so the "no final
// status" shape uses a call that was never closed instead (see e5).
import { seedSession } from './browser-harness.mjs';

export const DS_FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';
export const SUB_DEFAULT = { provider: 'deepseek', model: DS_FLASH, effort: 'max' };

const now = Date.now();
const user = (id, text, ts) => ({ id, ts, type: 'user', text });
const text = (id, body, ts) => ({ id, ts, type: 'text', agentId: 'main', text: body });
const card = (id, ts, patch) => ({ id, ts, type: 'tool_use', agentId: 'main', name: 'Agent', status: 'done', ...patch });

// What a person has to be able to read in every look: a tool call waiting for
// approval (with its buttons) and an error banner.
const attention = (p, ts) => [
  { id: `${p}ask`, ts, type: 'tool_use', agentId: 'main', name: 'Bash', title: 'rm build', status: 'pending', input: { command: 'rm -rf build' }, permission: { kind: 'tool', options: [] } },
  { id: `${p}err`, ts: ts + 1, type: 'error', agentId: 'main', text: '這一輪沒有完成：模型回覆被截斷' },
];

export function fixtureSessions() {
  return [
    // Kimi conversation with every kind of subagent card the restore path can leave.
    seedSession({
      id: 's_kimi',
      title: 'Kimi chat with subagents',
      agentId: 'kimi@m1',
      machineId: 'm1',
      kimiSessionId: 'k1',
      provider: 'kimi',
      cwd: '/tmp/x',
      updatedAt: now,
      meta: { model: 'kimi-k2', machineName: 'box', subagent: SUB_DEFAULT },
      events: [
        user('e1', 'scan', now - 9000),
        text('e2', 'ok', now - 8800),
        // Hub restarted while this ran: stored as running, the restore cuts the
        // tool call (interrupted) and settles the subagent with it (cancelled).
        card('e3', now - 8000, { title: 'stuck after restart', status: 'running', subagent: { id: 'a1', name: 'subagent', description: 'stuck after restart', status: 'running' } }),
        // The turn ended without this call ever being closed (no result came
        // back: the runtime's `ended`), and the subagent never reported a final
        // status nor which model it ran. The restore has nothing to settle it
        // with, so it really stays "running" under a call that is over.
        card('e5', now - 7000, { title: 'finished without report', status: 'ended', subagent: { id: 'a2', name: 'subagent', description: 'finished without report', status: 'running' } }),
        // Reported model, requested the same.
        card('e6', now - 6000, {
          title: 'verified model',
          status: 'done',
          subagent: {
            id: 'a3',
            name: 'subagent',
            description: 'verified model',
            status: 'done',
            requested: SUB_DEFAULT,
            actual: { provider: 'deepseek', model: DS_FLASH, effort: 'max' },
            unverifiedReason: '',
            summary: 'all good',
          },
        }),
        // Backend says: asked for DeepSeek, nothing confirmed.
        card('e7', now - 5000, {
          title: 'unverified model',
          status: 'done',
          subagent: {
            id: 'a4',
            name: 'subagent',
            description: 'unverified model',
            status: 'done',
            requested: SUB_DEFAULT,
            actual: null,
            unverifiedReason: '這台電腦的 Kimi 沒有回報子代理實際用的模型',
            summary: 'done but unverified',
          },
        }),
        // Asked for DeepSeek, ran on Claude.
        ...attention('k', now - 3500),
        card('e8', now - 4000, {
          title: 'ran elsewhere',
          status: 'done',
          subagent: {
            id: 'a5',
            name: 'subagent',
            description: 'ran elsewhere',
            status: 'done',
            requested: SUB_DEFAULT,
            actual: { provider: 'claude', model: 'claude-haiku-4', effort: 'low' },
            unverifiedReason: '',
            summary: 'ran on another provider',
          },
        }),
      ],
    }),
    seedSession({
      id: 's_claude',
      title: 'Claude chat',
      agentId: 'claude',
      provider: 'claude',
      cwd: '/tmp/x',
      updatedAt: now - 10000,
      meta: { model: 'claude-opus-5', subagent: null },
      events: [
        user('c1', 'hi', now - 20000),
        text('c2', 'hello', now - 19000),
        // A Claude Task that never said which model it used, in a conversation
        // whose own subagent setting is "native rules" (null), unlike s_kimi's.
        card('c3', now - 18000, { name: 'Task', title: 'task without model', subagent: { id: 'ct', name: 'subagent', description: 'task without model', status: 'done', summary: 'ok' } }),
        ...attention('c', now - 17000),
      ],
    }),
    seedSession({
      id: 's_ds',
      title: 'DeepSeek chat',
      agentId: 'kimi@m1',
      machineId: 'm1',
      kimiSessionId: 'k2',
      provider: 'deepseek',
      mode: 'deepseek',
      cwd: '/tmp/y',
      updatedAt: now - 20000,
      meta: { model: DS_FLASH, effort: 'max', subagent: SUB_DEFAULT },
      events: [user('d1', 'yo', now - 30000), text('d2', 'yes', now - 29000), ...attention('d', now - 28000)],
    }),
    // Ran a Kimi turn, then switched to DeepSeek inside the same runtime: idle,
    // so the row must name the provider the NEXT turn uses.
    seedSession({
      id: 's_swap',
      title: 'K to D idle switch',
      agentId: 'kimi@m1',
      machineId: 'm1',
      kimiSessionId: 'k3',
      provider: 'deepseek',
      mode: 'deepseek',
      cwd: '/tmp/z',
      updatedAt: now - 30000,
      modelConfig: { provider: 'deepseek', model: DS_FLASH, effort: 'max' },
      meta: { model: DS_FLASH, turnProvider: 'kimi', turnModel: null, subagent: SUB_DEFAULT },
      events: [user('w1', 'q', now - 40000)],
    }),
    // Seen from a terminal: external, so it belongs under 子session.
    seedSession({
      id: 's_ext',
      title: 'Terminal session',
      agentId: 'kimi@m1',
      machineId: 'm1',
      kimiSessionId: 'k9',
      provider: 'kimi',
      origin: 'external',
      cwd: '/tmp/t',
      updatedAt: now - 40000,
      meta: { owner: 'tui', controllable: false },
      events: [user('t1', 'x', now - 50000)],
    }),
    // A broker child: it lives in the parent's 子代理 panel, never in the sidebar.
    seedSession({
      id: 's_child',
      title: 'Hidden broker child',
      agentId: 'claude',
      provider: 'claude',
      parentId: 's_kimi',
      origin: 'external',
      cwd: '/tmp/x',
      updatedAt: now - 1000,
      meta: { model: 'claude-haiku-4' },
      events: [user('x1', 'child task', now - 3000)],
    }),
  ];
}
