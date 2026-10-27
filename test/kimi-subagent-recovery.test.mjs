import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-native-recovery-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');
const { Mirror, init } = await import('../server/adapters/kimi-remote.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fixture() {
  const card = {
    id: 'e_agent', type: 'tool_use', name: 'Agent', status: 'done',
    subagent: { id: 'agent-961', status: 'running', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' },
  };
  const session = { id: 's_native', machineId: 'm1', kimiSessionId: 'native1', state: {}, meta: {}, events: [card] };
  let seq = 0;
  const context = {
    emit(fields) {
      const ev = { id: `e_${++seq}`, ts: seq, ...fields };
      session.events.push(ev);
      return ev;
    },
    patch(ev, fields) { Object.assign(ev, fields); },
    delta(ev, text, field = 'text') { ev[field] = (ev[field] || '') + text; },
  };
  init(() => context);
  const mirror = new Mirror(session);
  mirror.tools.set('main:tool_native', card);
  return { mirror, card };
}

test('a completed native event finds its card by agent id after the mapping was lost', () => {
  const { mirror, card } = fixture();
  mirror.onSubagent('subagent.completed', { subagentId: 'agent-961', resultSummary: '完成結果' });
  assert.equal(card.subagent.status, 'done');
  assert.equal(card.subagent.summary, '完成結果');
  assert.equal(mirror.agents.get('agent-961').parent, card.id);
});

test('a native tool result closes a completed card and preserves its summary', () => {
  const { mirror, card } = fixture();
  mirror.onFrame({ type: 'tool.result', payload: { toolCallId: 'tool_native', isError: false, output: 'agent_id: agent-961\nactual_subagent_type: coder\nstatus: completed\nstop_reason: completed\n\n[summary]\n實際完成內容' } });
  assert.equal(card.status, 'done');
  assert.equal(card.subagent.status, 'done');
  assert.equal(card.subagent.summary, '實際完成內容');
});

test('cancelled and transport-error results do not leave a false running or done state', () => {
  const first = fixture();
  first.mirror.onFrame({ type: 'tool.result', payload: { toolCallId: 'tool_native', isError: false, output: 'status: cancelled' } });
  assert.equal(first.card.subagent.status, 'cancelled');

  const second = fixture();
  second.mirror.onFrame({ type: 'tool.result', payload: { toolCallId: 'tool_native', isError: true, output: 'status: completed' } });
  assert.equal(second.card.status, 'error');
  // The call is over, so its subagent is not "running" either: an error,
  // never a completed child and never a card that spins for ever.
  assert.equal(second.card.subagent.status, 'error', 'a transport error cannot fake a completed child, nor leave it running');
});
