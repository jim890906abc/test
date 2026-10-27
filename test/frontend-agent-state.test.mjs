// What a subagent card may claim (public/js/agent-state.js), tested directly in
// node on the module the page loads: whether a spinner has evidence behind it,
// and which model the card may name (the one the runtime reported; what was
// asked for is a separate, labelled fact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentLife, subagentModelView, lifeBadge, LIVENESS } from '../public/js/agent-state.js';

const NOW = 1_000_000_000;
const card = (patch = {}, sub = {}) => ({ id: 'e1', ts: NOW - 5000, type: 'tool_use', name: 'Agent', status: 'running', subagent: { id: 'a1', status: 'running', ...sub }, ...patch });

// ------------------------------------------------------------ liveness

test('a subagent whose tool call was interrupted by a restart is stopped, not spinning', () => {
  // A stale claim: the tool call is interrupted, the subagent's own status is
  // still the "running" it last said. (The Hub's own restore settles such a
  // card itself now, see the next test; an older store, or a runtime that
  // closes the call without touching the subagent, can still hand this over.)
  const l = agentLife(card({ status: 'interrupted' }), { now: NOW, sessionStatus: 'idle' });
  assert.equal(l.state, 'stopped');
  assert.equal(l.running, false);
  assert.equal(l.reason, 'interrupted');
  assert.match(l.reasonText, /重新啟動/);
});

test('a subagent the Hub already settled as cancelled under an interrupted tool call still says why it stopped', () => {
  // What store.js leaves behind since a restart settles the card itself: the
  // tool call is `interrupted` AND the subagent's own status is now `cancelled`.
  // The reason must not depend on the stale "running" claim being there.
  const settled = agentLife(card({ status: 'interrupted' }, { status: 'cancelled' }), { now: NOW, sessionStatus: 'idle' });
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.reason, 'interrupted');
  assert.match(settled.reasonText, /重新啟動/);
  assert.equal(lifeBadge(settled), '已中斷');
  // The same words for every "stopped" spelling the subagent may use.
  for (const word of ['cancelled', 'stopped', 'suspended']) assert.equal(agentLife(card({ status: 'interrupted' }, { status: word }), { now: NOW }).reason, 'interrupted', word);
  // Controls: it is the tool call's interruption that is explained, not every stop.
  assert.equal(agentLife(card({ status: 'done' }, { status: 'cancelled' }), { now: NOW }).reason, '', 'the subagent stopped on its own while the call went on: nothing to add');
  assert.equal(agentLife(card({ status: 'interrupted' }, { status: 'done' }), { now: NOW }).state, 'done', 'a subagent that finished is done whatever happened to the call');
  assert.equal(agentLife(card({ status: 'interrupted' }, { status: 'done' }), { now: NOW }).reason, '');
});

test('a finished tool call with a subagent that never reported is "unknown", neither running nor done', () => {
  const l = agentLife(card({ status: 'done' }), { now: NOW, sessionStatus: 'idle' });
  assert.equal(l.state, 'unknown');
  assert.equal(l.running, false);
  assert.equal(lifeBadge(l), '狀態未知');
  assert.ok(l.reasonText, 'the card has a reason to show');
});

test('a tool call that failed ends its subagent as failed (the "subagent error" output case)', () => {
  const l = agentLife(card({ status: 'error' }), { now: NOW, sessionStatus: 'running' });
  assert.equal(l.state, 'failed');
});

test('a foreground subagent is running while the conversation works, and not once it is idle', () => {
  assert.equal(agentLife(card(), { now: NOW, sessionStatus: 'running' }).running, true);
  assert.equal(agentLife(card(), { now: NOW, sessionStatus: 'awaiting_permission' }).running, true);
  const idle = agentLife(card(), { now: NOW, sessionStatus: 'idle' });
  assert.equal(idle.running, false);
  assert.equal(idle.reason, 'session-idle');
});

test('an unknown conversation status is not evidence of an idle one', () => {
  assert.equal(agentLife(card(), { now: NOW }).running, true);
});

test('a background subagent outlives an idle conversation, but not its own silence', () => {
  const bg = card({ status: 'done' }, { background: true });
  assert.equal(agentLife(bg, { now: NOW, sessionStatus: 'idle', lastActivity: NOW - 1000 }).running, true, 'recent activity keeps it alive');
  const silent = agentLife(bg, { now: NOW, sessionStatus: 'idle', lastActivity: NOW - LIVENESS.silentMs - 1 });
  assert.equal(silent.state, 'unknown');
  assert.equal(silent.reason, 'silent');
  // While the conversation itself is working, silence is not held against it.
  assert.equal(agentLife(bg, { now: NOW, sessionStatus: 'running', lastActivity: NOW - 10 * LIVENESS.silentMs }).running, true);
  // Limits can be tuned.
  assert.equal(agentLife(bg, { now: NOW, sessionStatus: 'idle', lastActivity: NOW - 500, limits: { silentMs: 100 } }).state, 'unknown');
});

test('a broker child is judged by its own conversation, whatever the parent tool call says', () => {
  const broker = card({ status: 'done', childSessionId: 's_child' });
  assert.equal(agentLife(broker, { now: NOW, sessionStatus: 'idle', childStatus: () => 'running' }).running, true, 'the child is working: not shown as finished');
  assert.equal(agentLife(broker, { now: NOW, sessionStatus: 'idle', childStatus: () => 'awaiting_permission' }).running, true);
  const gone = agentLife(broker, { now: NOW, sessionStatus: 'running', childStatus: () => 'idle' });
  assert.equal(gone.running, false);
  assert.equal(gone.reason, 'child-idle');
});

test('a hub-run (broker) card is not ended by its own tool call: a transport error leaves the child as it is', () => {
  // Spec §4.1: "父傳輸等待與 child 自身狀態分開". The card of a broker child has
  // `broker: true` (and a childSessionId); the MCP call that waits for it
  // failing, or finishing, says nothing about the child.
  const broker = (toolStatus) => card({ status: toolStatus }, { broker: true });
  for (const toolStatus of ['error', 'done', 'interrupted']) assert.equal(agentLife(broker(toolStatus), { now: NOW, sessionStatus: 'running' }).running, true, `tool call ${toolStatus}: the child is still working`);
  // ...but it still needs evidence once nothing is going on at all.
  const idle = agentLife(broker('error'), { now: NOW, sessionStatus: 'idle', lastActivity: NOW - LIVENESS.silentMs - 1 });
  assert.equal(idle.state, 'unknown');
  assert.equal(idle.reason, 'silent');
  // A native card in the same position is ended (control).
  assert.equal(agentLife(card({ status: 'error' }), { now: NOW, sessionStatus: 'running' }).state, 'failed');
});

test('the subagent\'s own final status wins over everything', () => {
  assert.equal(agentLife(card({ status: 'running' }, { status: 'done' }), { now: NOW, sessionStatus: 'running' }).state, 'done');
  assert.equal(agentLife(card({ status: 'done' }, { status: 'error' }), { now: NOW }).state, 'failed');
  assert.equal(agentLife(card({ status: 'done' }, { status: 'suspended' }), { now: NOW }).state, 'stopped');
});

test('without a subagent status the tool call decides, as before', () => {
  const bare = (status) => ({ id: 'e', ts: NOW, type: 'tool_use', name: 'Task', status });
  assert.equal(agentLife(bare('running'), { now: NOW, sessionStatus: 'running' }).running, true);
  assert.equal(agentLife(bare('done'), { now: NOW }).state, 'done');
  assert.equal(agentLife(bare('error'), { now: NOW }).state, 'failed');
  assert.equal(agentLife(bare('interrupted'), { now: NOW }).state, 'stopped');
});

// ------------------------------------------------------ the model shown

const DS = { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4.1-flash', effort: 'max' };
const doneLife = { running: false };

test('the model shown is the one the runtime reported; a request is only ever labelled as a request', () => {
  const v = subagentModelView(card({ status: 'done' }, { status: 'done', requested: DS, actual: { provider: 'claude', model: 'claude-haiku-4', effort: 'low' } }), doneLife);
  assert.equal(v.confirmed, true);
  // the id's own tail already starts with the provider: said once
  assert.match(v.text, /^claude-haiku-4 · 思考 low$/);
  assert.equal(v.mismatch, true, 'asked for DeepSeek, got Claude: marked');
  assert.match(v.requestedText, /^要求：deepseek-v4\.1-flash/);
});

test('nothing reported: "未確認" with the request beside it, never the request in the actual\'s place', () => {
  const v = subagentModelView(card({ status: 'done' }, { status: 'done', requested: DS, actual: null, unverifiedReason: 'runtime 沒帶 model' }), doneLife);
  assert.equal(v.confirmed, false);
  assert.equal(v.text, '模型未確認');
  assert.ok(!/DeepSeek/.test(v.text), 'the requested provider is not in the actual\'s place');
  assert.match(v.requestedText, /^要求：deepseek-v4\.1-flash · 思考 max$/);
  assert.equal(v.note, 'runtime 沒帶 model');
  assert.match(v.title, /runtime 沒帶 model/);
});

test('waiting for the report is a short phase of a LIVE subagent; after it, or once finished, it is "未確認"', () => {
  const fresh = card({ ts: NOW - 1000 }, { requested: DS, actual: null });
  assert.equal(subagentModelView(fresh, { running: true }, { now: NOW }).waiting, true);
  assert.equal(subagentModelView(fresh, { running: true }, { now: NOW }).text, '等待回報模型…');
  const old = card({ ts: NOW - LIVENESS.modelReportWaitMs - 1 }, { requested: DS, actual: null });
  const late = subagentModelView(old, { running: true }, { now: NOW });
  assert.equal(late.waiting, false);
  assert.equal(late.text, '模型未確認');
  const ended = subagentModelView(fresh, doneLife, { now: NOW });
  assert.equal(ended.waiting, false, 'a finished subagent never "waits"');
  assert.equal(ended.text, '模型未確認');
});

test('a server that does not send requested/actual yet: the older flat fields are runtime reports; nothing else is borrowed', () => {
  const legacy = subagentModelView(card({ status: 'done' }, { status: 'done', provider: 'claude', model: 'claude-haiku-4', effort: 'low' }), doneLife);
  assert.equal(legacy.confirmed, true);
  assert.match(legacy.text, /^claude-haiku-4/);
  assert.equal(legacy.requestedText, '', 'no request recorded, none invented');
  const silent = subagentModelView(card({ status: 'done' }, { status: 'done' }), doneLife);
  assert.equal(silent.confirmed, false);
  assert.equal(silent.text, '模型未確認');
  assert.equal(silent.requestedText, '');
});

test('an explicit actual:null beats stale flat fields (the server said it is unconfirmed)', () => {
  const v = subagentModelView(card({ status: 'done' }, { status: 'done', model: 'whatever', actual: null }), doneLife);
  assert.equal(v.confirmed, false);
});

test('same model through its alias or its plain id is not a mismatch; a different effort is', () => {
  const same = subagentModelView(card({ status: 'done' }, { requested: DS, actual: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'max' } }), doneLife);
  assert.equal(same.mismatch, false);
  const effort = subagentModelView(card({ status: 'done' }, { requested: DS, actual: { provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'low' } }), doneLife);
  assert.equal(effort.mismatch, true);
});

