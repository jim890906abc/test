// DS2: the Claude daemon side of the unified-models work — a continuation's
// handoff, each conversation's subagent default (really used by Task), and
// the cross-provider Task broker (request event, answer, timeouts, and the
// Hub mirror glue). The daemon is started on its own, against a fake Claude
// API, so this does not depend on the Hub's runner/broker being finished.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeClaude, wait } from './fixtures/fake-anthropic.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-claude-ds2-'));
const DAEMON_DIR = path.join(TMP, 'daemon');
const KEY = `sk-ant-api03-${'d'.repeat(40)}-test`;

let fake;
let daemon;
let info;
let daemonLog = '';

const auth = () => ({ apiKey: KEY, settings: { defaults: { model: 'claude-opus-5-5', effort: 'high', permission: 'auto' }, webTools: false } });

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function rpc(op, args = {}) {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-daemon-token': info.token },
    body: JSON.stringify({ op, args }),
  });
  const j = await res.json();
  if (!j.ok) throw Object.assign(new Error(j.error || 'daemon error'), { status: j.status });
  return j.data;
}

async function create(id, config = {}) {
  const cwd = path.join(TMP, 'work', id);
  fs.mkdirSync(cwd, { recursive: true });
  return rpc('create', {
    id,
    cwd,
    title: id,
    permissionMode: 'auto',
    config: { permission: 'auto', model: 'claude-opus-5-5', effort: 'high', ...config },
    auth: auth(),
  });
}

const send = (id, text) => rpc('send', { id, text, auth: auth() });
const snap = (id) => rpc('snapshot', { id });
const messages = () => fake.requests.filter((r) => r.url.startsWith('/v1/messages'));
const subagentRequests = (from) => messages().slice(from).filter((r) => r.body?.system?.[0]?.text?.includes('You are a subagent'));

async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(25);
  }
  throw new Error(`timeout\n${daemonLog}`);
}

const idle = (id, ms = 20_000) =>
  until(async () => {
    const s = await snap(id);
    return !['running', 'awaiting_permission'].includes(s.status) && s;
  }, ms);

before(async () => {
  fake = await startFakeClaude(KEY);
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  daemon = spawn(process.execPath, ['server/claude-daemon.js', '--dir', DAEMON_DIR], {
    cwd: ROOT,
    env: { ...process.env, AGENT_HUB_CLAUDE_TEST_URL: fake.url, AGENT_HUB_BROKER_TIMEOUT_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => (daemonLog += d));
  daemon.stderr.on('data', (d) => (daemonLog += d));
  info = await until(async () => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DAEMON_DIR, 'daemon.json'), 'utf8'));
      return j.port && j.token ? j : null;
    } catch {
      return null;
    }
  }, 15_000);
});

after(() => {
  try {
    daemon.kill('SIGTERM');
  } catch {}
  fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('handoff: into the internal messages, never as a visible user message', async () => {
  const id = 's_handoff';
  const created = await create(id, {
    handoff: { text: 'User: 先前的問題\n\nAssistant: 先前的回答', from: 'Kimi Code · box', model: 'kimi-k3', omitted: 120 },
  });
  assert.equal(created.events.some((e) => e.type === 'user'), false);
  const event = created.events.find((e) => e.type === 'info' && e.handoff);
  assert.ok(event, JSON.stringify(created.events));
  assert.match(event.text, /不是新的使用者要求/);
  assert.equal(event.handoff.from, 'Kimi Code · box');
  assert.equal(event.handoff.omitted, 120);

  const n0 = messages().length;
  await send(id, '你好');
  const done = await idle(id);
  const body = messages()[n0].body;
  assert.match(textOf(body.messages[0].content), /earlier history carried over/);
  assert.match(textOf(body.messages[0].content), /先前的問題/);
  assert.equal(textOf(body.messages[1].content), '你好');
  assert.deepEqual(done.events.filter((e) => e.type === 'user').map((e) => e.text), ['你好']);
});

test('handoff: DS1\'s string + handoffFrom shape is accepted without double markers', async () => {
  const id = 's_handoff_ds1';
  const text = [
    'This is prior conversation history from Kimi.',
    'Working directory: /work/old',
    "It is NOT a new user request. Do not answer it. Use it only as context for the user's next message.",
    '',
    'User: 舊問題',
    '',
    '[... 99 characters omitted; the full events remain in Agent Hub ...]',
    '',
    'End of prior history.',
  ].join('\n');
  const created = await create(id, { handoff: text, handoffFrom: { provider: 'Kimi', cwd: '/work/old', chars: text.length, omitted: 99 } });
  const event = created.events.find((e) => e.type === 'info' && e.handoff);
  assert.ok(event);
  assert.equal(event.handoff.from, 'Kimi');
  assert.equal(event.handoff.fromCwd, '/work/old');
  assert.equal(event.handoff.omitted, 99);

  const n0 = messages().length;
  await send(id, '下一件事');
  await idle(id);
  const body = messages()[n0].body;
  const first = textOf(body.messages[0].content);
  assert.equal((first.match(/characters omitted; the full events remain/g) || []).length, 1);
  assert.equal((first.match(/not a new user request/gi) || []).length, 1);
  assert.equal((first.match(/Working directory: \/work\/old/g) || []).length, 1);
  assert.match(first, /Prior history source: Kimi/);
  assert.match(first, /舊問題/);
});

test('handoff: fromCwd is written into the text, not just kept as metadata', async () => {
  const id = 's_handoff_cwd';
  const created = await create(id, { handoff: { text: 'User: 舊問題\nAssistant: 舊回答', fromProvider: 'Kimi', fromCwd: '/work/old' } });
  const event = created.events.find((e) => e.type === 'info' && e.handoff);
  assert.ok(event);
  assert.equal(event.handoff.fromCwd, '/work/old');
  const n0 = messages().length;
  await send(id, '接手');
  await idle(id);
  const first = textOf(messages()[n0].body.messages[0].content);
  assert.match(first, /Working directory: \/work\/old/);
  assert.match(first, /Source: Kimi/);
  assert.match(first, /舊問題/);
});

test('the conversation subagent default is used by Task — real model and effort', async () => {
  const id = 's_sub_default';
  await create(id);
  await rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } }, auth: auth() });
  assert.deepEqual((await snap(id)).meta.subagent, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });

  const n0 = messages().length;
  await send(id, 'TASKPLAIN');
  const done = await idle(id);
  const sub = subagentRequests(n0)[0];
  assert.ok(sub, 'no subagent request');
  assert.equal(sub.body.model, 'claude-sonnet-5-5');
  assert.equal(sub.body.output_config?.effort, 'low');
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'done');
  assert.equal(card.subagent.provider, 'claude');
  assert.equal(card.subagent.model, 'claude-sonnet-5-5');
  assert.equal(card.subagent.effort, 'low');
  const turn = done.events.findLast((e) => e.type === 'turn_end');
  assert.deepEqual(turn.subagents.map((x) => ({ provider: x.provider, model: x.model, effort: x.effort })), [{ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }]);
});

test('a single Task call may override the conversation default', async () => {
  const id = 's_sub_override';
  await create(id);
  await rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } }, auth: auth() });
  const n0 = messages().length;
  await send(id, 'TASKSUB');
  await idle(id);
  const sub = subagentRequests(n0)[0];
  assert.ok(sub, 'no subagent request');
  assert.equal(sub.body.model, 'claude-opus-5-5');
  assert.equal(sub.body.output_config?.effort, 'high');
});

test('changing the subagent default mid-turn applies to a Task started after it', async () => {
  const id = 's_sub_midturn';
  await create(id, { permission: 'manual' });
  await rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } }, auth: auth() });
  await send(id, 'MIDTASK');
  const permission = await until(async () => (await snap(id)).events.find((e) => e.permission && !e.permission.chosen));
  assert.equal(permission.name, 'Write');
  const during = await snap(id);
  assert.equal(during.meta.turnSubagent.model, 'claude-sonnet-5-5');

  await rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }, auth: auth() });
  assert.equal((await snap(id)).meta.turnSubagent.model, 'claude-sonnet-5-5', 'the turn snapshot does not change');
  await rpc('respond', { id, eventId: permission.id, optionId: 'approved', auth: auth() });

  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.subagent.model, 'claude-opus-5-5');
  assert.equal(card.subagent.effort, 'high');
  const sub = done.events.filter((e) => e.parent === card.id && e.type === 'text').at(-1);
  assert.match(sub.text, /子代理報告：find mid/);
  assert.equal('turnSubagent' in done.meta, true);
  assert.equal(done.meta.turnSubagent, null);
});

test('subagent settings are whitelisted, persistent, clearable and isolated', async () => {
  const id = 's_sub_whitelist';
  await create(id);
  await assert.rejects(rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-nope', effort: 'low' } }, auth: auth() }), /這個模型/);
  await assert.rejects(rpc('configure', { id, change: { subagent: { provider: 'kimi', model: 'bad model' } }, auth: auth() }), /模型名稱/);
  await assert.rejects(rpc('configure', { id, change: { subagent: { provider: 'deepseek', model: 'deepseek-chat' } }, auth: auth() }), /agent-hub-deepseek/);
  await assert.rejects(rpc('configure', { id, change: { subagent: { provider: 'openai', model: 'x' } }, auth: auth() }), /供應商/);

  await rpc('configure', { id, change: { subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } }, auth: auth() });
  assert.deepEqual((await snap(id)).meta.subagent, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
  await rpc('configure', { id, change: { subagent: null }, auth: auth() });
  assert.equal((await snap(id)).meta.subagent, null);

  const a = 's_iso_a';
  const b = 's_iso_b';
  await create(a);
  await create(b);
  await rpc('configure', { id: a, change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } }, auth: auth() });
  await rpc('configure', { id: b, change: { subagent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }, auth: auth() });
  const n0 = messages().length;
  await send(a, 'TASKPLAIN');
  await idle(a);
  await send(b, 'TASKPLAIN');
  await idle(b);
  const models = subagentRequests(n0).map((r) => r.body.model);
  assert.deepEqual([...models].sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
});

test('the Hub-owned subagent default travels with each call (no stale daemon meta)', async () => {
  const id = 's_sub_auth';
  await create(id);
  const sub = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
  const n0 = messages().length;
  await rpc('send', { id, text: 'TASKPLAIN', auth: { ...auth(), subagent: sub } });
  await idle(id);
  assert.deepEqual((await snap(id)).meta.subagent, sub);
  const req = subagentRequests(n0)[0];
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.equal(req.body.output_config?.effort, 'low');

  // null clears it before the next turn.
  await rpc('send', { id, text: 'hello', auth: { ...auth(), subagent: null } });
  await idle(id);
  assert.equal('subagent' in (await snap(id)).meta, false);
});

test('an invalid Hub-owned subagent setting fails the call instead of being silently ignored', async () => {
  const id = 's_sub_auth_bad';
  await create(id);
  const n0 = messages().length;
  await assert.rejects(rpc('send', { id, text: 'hello', auth: { ...auth(), subagent: { provider: 'openai', model: 'x' } } }), /供應商/);
  assert.equal(messages().length, n0, 'the send must not run');
  const s = await snap(id);
  assert.equal('subagent' in s.meta, false, 'the invalid setting is not kept');
  assert.equal(s.status, 'idle');

  // The conversation is still usable with a valid setting.
  await rpc('send', { id, text: 'hello', auth: { ...auth(), subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } } });
  await idle(id);
  assert.deepEqual((await snap(id)).meta.subagent, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
});

test('cross-provider Task: broker request and answer carry the actual provider/model/childSessionId', async () => {
  const id = 's_broker_ok';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  assert.equal(event.broker.provider, 'kimi');
  assert.equal(event.broker.model, 'kimi-k3');
  assert.equal(event.broker.effort, 'high');
  assert.equal('token' in event.broker, false);
  assert.equal(JSON.stringify(event).includes(KEY), false);

  assert.equal(
    await rpc('brokerResult', {
      id,
      requestId: event.broker.requestId,
      result: { childSessionId: 's_child_kimi', provider: 'kimi', model: 'kimi-k3', effort: 'high', text: 'Kimi 子代理回報：完成' },
      auth: auth(),
    }),
    true,
  );
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'done');
  assert.equal(card.childSessionId, 's_child_kimi');
  assert.equal(card.subagent.provider, 'kimi');
  assert.equal(card.subagent.model, 'kimi-k3');
  assert.equal(card.subagent.effort, 'high');
  assert.equal(card.subagent.childSessionId, 's_child_kimi');
  const turn = done.events.findLast((e) => e.type === 'turn_end');
  assert.equal(turn.subagents[0].childSessionId, 's_child_kimi');
  assert.equal(turn.subagents[0].provider, 'kimi');
  assert.equal(subagentRequests(n0).length, 0, 'a Kimi Task must not run on Claude');
  assert.ok(JSON.stringify(messages().slice(n0).at(-1).body.messages.at(-1)).includes('Kimi 子代理回報'));
});

test('cross-provider Task failure is explicit, with no Claude fallback', async () => {
  const id = 's_broker_error';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  await rpc('brokerResult', { id, requestId: event.broker.requestId, result: { error: 'Kimi Code 沒有登入' }, auth: auth() });
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'error');
  assert.equal(card.isError, true);
  assert.match(card.output, /沒有登入/);
  const result = messages().slice(n0).at(-1).body.messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(result.is_error, true);
  assert.match(result.content, /沒有登入/);
  assert.equal(subagentRequests(n0).length, 0, 'a failed Kimi Task must not be retried on Claude');
});

test('a broker answer from another model is not accepted as success', async () => {
  const id = 's_broker_swap';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  await rpc('brokerResult', {
    id,
    requestId: event.broker.requestId,
    result: { childSessionId: 's_child_other', provider: 'kimi', model: 'kimi-k2', effort: 'high', text: '別的模型' },
    auth: auth(),
  });
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'error');
  assert.match(card.output, /與要求/);
  assert.equal(subagentRequests(n0).length, 0);
});

test('a broker effort different from the Task request is a failure, and so is a missing one', async () => {
  const cases = [
    ['s_broker_effort_diff', { childSessionId: 's_child_eff1', provider: 'kimi', model: 'kimi-k3', effort: 'low', text: '不該採用的結果' }, /思考強度 low 與要求的 high 不同/, 'low'],
    ['s_broker_effort_missing', { childSessionId: 's_child_eff2', provider: 'kimi', model: 'kimi-k3', text: '不該採用的結果' }, /沒有回報實際的思考強度（要求 high）/, ''],
  ];
  for (const [id, result, expected, shownEffort] of cases) {
    await create(id);
    const n0 = messages().length;
    await send(id, 'TASKBROKER');
    const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
    assert.equal(event.broker.effort, 'high');
    await rpc('brokerResult', { id, requestId: event.broker.requestId, result, auth: auth() });
    const done = await idle(id);
    const card = done.events.find((e) => e.name === 'Task');
    assert.equal(card.status, 'error');
    assert.equal(card.subagent.status, 'error');
    assert.match(card.output, expected);
    assert.equal(card.subagent.effort, shownEffort, 'never show the requested effort as the one that ran');
    assert.equal(card.subagent.requestedEffort, 'high');
    assert.equal(subagentRequests(n0).length, 0);
    const toolResult = messages().slice(n0).at(-1).body.messages.at(-1).content.find((b) => b.type === 'tool_result');
    assert.equal(toolResult.is_error, true);
    assert.doesNotMatch(toolResult.content, /不該採用的結果/);
  }
});

test('a broker effort is accepted and shown when the Task asked for the model default', async () => {
  const id = 's_broker_effort_default';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKERNOEFFORT');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  assert.equal(event.broker.effort, '');
  await rpc('brokerResult', {
    id,
    requestId: event.broker.requestId,
    result: { childSessionId: 's_child_eff3', provider: 'kimi', model: 'kimi-k3', effort: 'max', text: '預設 effort 回報' },
    auth: auth(),
  });
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'done');
  assert.equal(card.subagent.effort, 'max');
  assert.equal('requestedEffort' in card.subagent, false);
  const toolResult = messages().slice(n0).at(-1).body.messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.is_error, undefined);
  assert.match(toolResult.content, /預設 effort 回報/);
});

test('Hub offline: the cross-provider Task fails after the timeout, without fallback', async () => {
  const id = 's_broker_timeout';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKERDS');
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'error');
  assert.match(card.output, /沒有回應/);
  assert.match(card.output, /沒有改用 Claude/);
  const result = messages().slice(n0).at(-1).body.messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(result.is_error, true);
  assert.match(result.content, /沒有改用 Claude/);
  assert.equal(subagentRequests(n0).length, 0);
});

test('hub mirror: a broker request runs through delegateToProvider and answers the daemon', async () => {
  process.env.AGENT_HUB_DATA = path.join(TMP, 'hub-data');
  const mirror = await import('../server/adapters/claude-mirror.js');
  const calls = [];
  const sent = [];
  mirror.setBroker(async (session, req) => {
    calls.push(req);
    return { childSessionId: 's_child', provider: req.provider, model: req.model, effort: req.effort, text: 'ok from kimi' };
  });
  const session = { id: 's_parent', machineId: null, state: {}, events: [{ id: 'e_tool', type: 'tool_use', name: 'Task', input: { prompt: 'do the thing' } }] };
  const ev = { id: 'e_broker', type: 'info', broker: { kind: 'delegate', requestId: 'b_1', provider: 'kimi', model: 'kimi-k3', effort: 'high', parentEventId: 'e_tool' } };
  const send = async (op, args) => {
    sent.push({ op, args });
    return true;
  };
  // The Hub says it has the request before it says anything else.
  const results = () => sent.filter((x) => x.op === 'brokerResult');

  assert.equal(await mirror.handleBrokerRequest(session, ev, { send }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { provider: calls[0].provider, model: calls[0].model, effort: calls[0].effort, task: calls[0].task, parentEventId: calls[0].parentEventId },
    { provider: 'kimi', model: 'kimi-k3', effort: 'high', task: 'do the thing', parentEventId: 'e_tool' },
  );
  assert.equal(sent[0].op, 'brokerAck', 'acknowledged first');
  assert.equal(sent[0].args.requestId, 'b_1');
  assert.equal(results()[0].args.id, 's_parent');
  assert.equal(results()[0].args.requestId, 'b_1');
  assert.equal(results()[0].args.result.childSessionId, 's_child');
  assert.equal(JSON.stringify(results()[0].args).includes('delegationToken'), false);

  // The same request (a resync, say) is not run twice.
  assert.equal(await mirror.handleBrokerRequest(session, ev, { send }), false);
  assert.equal(calls.length, 1);

  // No parent tool event: an error goes back; nothing runs.
  const ev2 = { ...ev, id: 'e_broker2', broker: { ...ev.broker, requestId: 'b_2', parentEventId: 'missing' } };
  await mirror.handleBrokerRequest(session, ev2, { send });
  assert.equal(calls.length, 1);
  assert.match(results()[1].args.result.error, /parent tool event/);

  // No broker at all: an error goes back; it never turns into a Claude run.
  mirror.setBroker(null);
  const ev3 = { ...ev, id: 'e_broker3', broker: { ...ev.broker, requestId: 'b_3' } };
  await mirror.handleBrokerRequest(session, ev3, { send, delegate: null });
  assert.match(results()[2].args.result.error, /broker 尚未接上/);
});

test('hub mirror keeps the Hub-owned subagent default over daemon summaries', async () => {
  const mirror = await import('../server/adapters/claude-mirror.js');
  const hubSub = { provider: 'kimi', model: 'kimi-k3', effort: 'high' };
  const session = { meta: { subagent: hubSub } };
  assert.deepEqual(mirror.mirrorMeta(session, { model: 'm', subagent: { provider: 'claude', model: 'x', effort: '' } }), { model: 'm', subagent: hubSub });
  const empty = { meta: {} };
  assert.equal('subagent' in mirror.mirrorMeta(empty, { model: 'm', subagent: { provider: 'kimi', model: 'x', effort: '' } }), false);
  assert.deepEqual(mirror.mirrorMeta(empty, { subagent: { provider: 'kimi', model: 'x', effort: '' } }, { adopt: true }), { subagent: { provider: 'kimi', model: 'x', effort: '' } });
});

test('hub mirror default broker reaches the real runner.delegateToProvider', async () => {
  process.env.AGENT_HUB_DATA = path.join(TMP, 'hub-data-broker');
  const mirror = await import('../server/adapters/claude-mirror.js');
  mirror.setBroker(null);
  const sent = [];
  const session = {
    id: 's_parent_real',
    machineId: null,
    state: {},
    provider: 'claude',
    meta: { subagent: { provider: 'kimi', model: 'kimi-k3', effort: 'high' } },
    cwd: TMP,
    events: [{ id: 'e_tool_real', type: 'tool_use', name: 'Task', input: { prompt: 'real broker' } }],
  };
  const ev = { id: 'e_broker_real', type: 'info', broker: { kind: 'delegate', requestId: 'b_real', provider: 'kimi', model: 'kimi-k3', effort: 'high', parentEventId: 'e_tool_real' } };
  await mirror.handleBrokerRequest(session, ev, { send: async (op, args) => sent.push({ op, args }) });
  const result = sent.find((x) => x.op === 'brokerResult');
  assert.ok(result);
  // No Kimi computer in this test: the broker says so instead of running it
  // on Claude.
  assert.match(result.args.result.error, /Kimi|電腦|離線|模型/);
  assert.equal(result.args.result.text, '');
});

// ------------------------------------------------ request / actual on the card

test('a Claude Task card carries the request it was made with and the model Anthropic actually served', async () => {
  const id = 's_card_native';
  await create(id);
  await rpc('configure', { id, change: { subagent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } }, auth: auth() });
  await send(id, 'TASKPLAIN');
  const done = await idle(id);
  const sub = done.events.find((e) => e.name === 'Task').subagent;
  assert.deepEqual(sub.requested, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  assert.equal(sub.actual.provider, 'claude');
  assert.ok(sub.actual.model.startsWith('claude-sonnet-5-5'), `served ${sub.actual.model}`);
  assert.equal(sub.unverifiedReason, undefined);
});

test('a cross-provider Task card is requested at once, and gets an actual only from a child that reported one', async () => {
  const id = 's_card_broker';
  await create(id);
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  const waiting = (await snap(id)).events.find((e) => e.name === 'Task').subagent;
  assert.deepEqual(waiting.requested, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
  assert.equal(waiting.actual, null);
  assert.match(waiting.unverifiedReason, /Agent Hub/);
  await rpc('brokerResult', { id, requestId: event.broker.requestId, result: { childSessionId: 's_child_c1', provider: 'kimi', model: 'kimi-k3', effort: 'high', text: 'ok' }, auth: auth() });
  const sub = (await idle(id)).events.find((e) => e.name === 'Task').subagent;
  assert.deepEqual(sub.actual, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
  assert.equal(sub.unverifiedReason, undefined);
});

test('when the child ran on something else, the card shows both the request and what ran, as a failure', async () => {
  const id = 's_card_swap';
  await create(id);
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  await rpc('brokerResult', { id, requestId: event.broker.requestId, result: { childSessionId: 's_child_c2', provider: 'kimi', model: 'kimi-k2', effort: 'high', text: 'x' }, auth: auth() });
  const card = (await idle(id)).events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'error');
  assert.deepEqual(card.subagent.requested, { provider: 'kimi', model: 'kimi-k3', effort: 'high' });
  assert.deepEqual(card.subagent.actual, { provider: 'kimi', model: 'kimi-k2', effort: 'high' });
});

test('a Task that never reached a child has no actual and says why', async () => {
  const id = 's_card_failed';
  await create(id);
  await send(id, 'TASKBROKER');
  const event = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  await rpc('brokerResult', { id, requestId: event.broker.requestId, result: { provider: 'kimi', model: 'kimi-k3', effort: 'high', error: 'Kimi Code 沒有登入' }, auth: auth() });
  const sub = (await idle(id)).events.find((e) => e.name === 'Task').subagent;
  assert.equal(sub.actual, null, 'the request echoed back by a failed delegation is not an actual');
  assert.match(sub.unverifiedReason, /沒有登入/);
  assert.equal(sub.requested.model, 'kimi-k3');
});

// ---------------------------------------- capabilities, ack/heartbeat, cancel

test('the daemon says what it can do, in /health and as an op', async () => {
  const res = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { 'x-daemon-token': info.token } });
  const h = await res.json();
  for (const cap of ['broker', 'handoff', 'subagent_config']) assert.ok(h.capabilities.includes(cap), `/health lacks ${cap}`);
  const op = await rpc('capabilities');
  assert.deepEqual([...op.capabilities].sort(), [...h.capabilities].sort());
  assert.ok(op.version);
});

test('a Hub that keeps saying it is working keeps the wait alive past the silence timeout; the answer is then taken', async () => {
  // Its own daemon with a 6 s silence limit, so a slow machine does not make
  // the timing of the signs of life matter.
  const dir = path.join(TMP, 'daemon-alive');
  fs.mkdirSync(dir, { recursive: true });
  const d = spawn(process.execPath, ['server/claude-daemon.js', '--dir', dir], {
    cwd: ROOT,
    env: { ...process.env, AGENT_HUB_CLAUDE_TEST_URL: fake.url, AGENT_HUB_BROKER_TIMEOUT_MS: '6000' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    const own = await until(async () => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
        return j.port && j.token ? j : null;
      } catch {
        return null;
      }
    }, 15_000);
    const call = async (op, args = {}) => {
      const res = await fetch(`http://127.0.0.1:${own.port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daemon-token': own.token }, body: JSON.stringify({ op, args }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      return j.data;
    };
    const id = 's_ack_alive';
    const cwd = path.join(TMP, 'work', id);
    fs.mkdirSync(cwd, { recursive: true });
    await call('create', { id, cwd, title: id, permissionMode: 'auto', config: { permission: 'auto', model: 'claude-opus-5-5', effort: 'high' }, auth: auth() });
    await call('send', { id, text: 'TASKBROKER', auth: auth() });
    const event = await until(async () => (await call('snapshot', { id })).events.find((e) => e.broker?.kind === 'delegate'));
    // Signs of life every second for ~8 s: longer than the silence limit, never silent for it.
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      assert.equal(await call('brokerAck', { id, requestId: event.broker.requestId }), true, 'a sign of life is accepted');
      await wait(1000);
    }
    assert.equal(
      await call('brokerResult', { id, requestId: event.broker.requestId, result: { childSessionId: 's_child_alive', provider: 'kimi', model: 'kimi-k3', effort: 'high', text: '慢但完成' }, auth: auth() }),
      true,
      'an answer after the silence limit would have passed must still be taken: the child was working, not missing',
    );
    const card = (await until(async () => {
      const x = await call('snapshot', { id });
      return !['running', 'awaiting_permission'].includes(x.status) && x;
    })).events.find((e) => e.name === 'Task');
    assert.equal(card.status, 'done');
    assert.equal(card.subagent.actual.model, 'kimi-k3');
  } finally {
    d.kill('SIGTERM');
  }
});

test('a Hub that goes quiet: the Task fails without Claude fallback and the daemon tells the Hub to cancel the child', async () => {
  const id = 's_ack_silent';
  await create(id);
  const n0 = messages().length;
  await send(id, 'TASKBROKER');
  const done = await idle(id);
  const card = done.events.find((e) => e.name === 'Task');
  assert.equal(card.status, 'error');
  assert.match(card.output, /沒有回應/);
  const request = done.events.find((e) => e.broker?.kind === 'delegate');
  const cancel = done.events.find((e) => e.broker?.kind === 'cancel');
  assert.ok(cancel, 'the Hub is told to stop whatever it started for this request');
  assert.equal(cancel.broker.requestId, request.broker.requestId);
  assert.equal(cancel.broker.parentEventId, card.id);
  assert.equal(subagentRequests(n0).length, 0);
});

test('stopping the turn while a cross-provider Task waits tells the Hub to cancel its child', async () => {
  const id = 's_ack_stop';
  await create(id);
  await send(id, 'TASKBROKER');
  const request = await until(async () => (await snap(id)).events.find((e) => e.broker?.kind === 'delegate'));
  await rpc('interrupt', { id });
  const done = await idle(id);
  const cancel = done.events.find((e) => e.broker?.kind === 'cancel');
  assert.ok(cancel, 'a cancel went to the Hub');
  assert.equal(cancel.broker.requestId, request.broker.requestId);
  assert.equal(done.events.find((e) => e.name === 'Task').subagent.status, 'cancelled');
});

test('the Hub acknowledges a request at once and keeps doing so while its child works', async () => {
  process.env.AGENT_HUB_DATA = path.join(TMP, 'hub-data-ack');
  const mirror = await import('../server/adapters/claude-mirror.js');
  const sent = [];
  let finish;
  mirror.setBroker(() => new Promise((r) => (finish = r)));
  const session = { id: 's_ack_hub', machineId: null, state: {}, events: [{ id: 'e_t', type: 'tool_use', name: 'Task', input: { prompt: 'slow work' } }] };
  const ev = { id: 'e_b', type: 'info', broker: { kind: 'delegate', requestId: 'b_slow', provider: 'kimi', model: 'kimi-k3', effort: 'high', parentEventId: 'e_t' } };
  const done = mirror.handleBrokerRequest(session, ev, { send: async (op, args) => sent.push({ op, args }), heartbeatMs: 40 });
  await wait(200);
  assert.ok(sent.filter((x) => x.op === 'brokerAck').length >= 3, `acks: ${sent.map((x) => x.op)}`);
  assert.equal(sent.some((x) => x.op === 'brokerResult'), false, 'the child has not finished');
  finish({ childSessionId: 's', provider: 'kimi', model: 'kimi-k3', effort: 'high', text: 'ok' });
  await done;
  const acks = sent.filter((x) => x.op === 'brokerAck').length;
  await wait(150);
  assert.equal(sent.filter((x) => x.op === 'brokerAck').length, acks, 'no heartbeat after the answer');
  assert.equal(sent.at(-1).op, 'brokerResult');
});

test('a cancel from the daemon stops the child of that request and not the parent', async () => {
  const mirror = await import('../server/adapters/claude-mirror.js');
  const seen = [];
  const session = { id: 's_cancel_hub' };
  const r = await mirror.handleBrokerCancel(session, { broker: { kind: 'cancel', requestId: 'b_9', parentEventId: 'e_task' } }, { cancel: async (s, id) => (seen.push([s.id, id]), 1) });
  assert.equal(r, 1);
  assert.deepEqual(seen, [['s_cancel_hub', 'e_task']]);
  assert.equal(await mirror.handleBrokerCancel(session, { broker: { kind: 'delegate' } }, { cancel: async () => 1 }), false);
});
