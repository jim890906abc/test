// The delegation token (hb_…) is a capability the Hub hands to Kimi in a
// system reminder; the model puts it into the MCP tool call it makes. Kimi
// reports that call back as events, so without a mask at the one place events
// enter the Hub, the token reached the browser API, the WebSocket and the
// disk. This runs the whole real path: a real Hub, a scripted machine that
// plays Kimi (it reads the token from the prompt it was sent, as a model
// would, and streams it back in tool-call fragments, in the call, in the
// answer and in the result), and then looks at everything a person or a file
// can read: GET /api/sessions/:id, the live stream, and every file on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-token-'));
const DATA = path.join(TMP, 'data');
const PORT = 29000 + Math.floor(Math.random() * 1500);
// A login token with no recognizable prefix: only an exact-value rule can know it.
const LOGIN = '5f2c9ab7d41e8a03b6c7d9e0f1a2b3c4';
const MID = 'm_token';
const KID = 'session_token1';
const KID2 = 'session_history2';
const FILE_SECRET = 'AKIAIOSFODNN7EXAMPLE';
// What a person types into a message, and what an old transcript holds.
const USER_KEY = 'sk-9f8e7d6c5b4a39281716abcdef0123';
const OLD_TOKEN = `hb_${'0123456789abcdef'.repeat(3)}`;
const OLD_GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
let hub;
let machine;
let log = '';

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-hub-token': LOGIN }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

function fakeMachine(key) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const info = { id: KID, title: 'delegation', metadata: { cwd: '/tmp/p' }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', model: 'kimi/k2', effort: 'low' };
  const info2 = { ...info, id: KID2, title: 'an older conversation' };
  // The journal of the older conversation: a delegation whose arguments and
  // result carry secrets, as Kimi recorded them.
  const f2 = (type, payload) => ({ type, session_id: KID2, payload: { agentId: 'main', ...payload, sessionId: KID2 } });
  const journal = [
    f2('turn.started', { turnId: 'h1', promptId: 'old_p', origin: { kind: 'user' }, prompt: 'earlier request' }),
    f2('tool.call.started', { turnId: 'h1', toolCallId: 'hc1', name: 'mcp__agent-hub__delegate_to_provider', args: { token: OLD_TOKEN, task: 'old task text' } }),
    f2('tool.result', { turnId: 'h1', toolCallId: 'hc1', output: `used ${OLD_TOKEN} and ${OLD_GH}; old result text` }),
    f2('assistant.delta', { turnId: 'h1', delta: `Done with ${OLD_TOKEN}.` }),
    f2('turn.ended', { turnId: 'h1', reason: 'completed' }),
  ];
  const m = { prompts: [], ws };
  ws.on('open', () => {
    send({ t: 'hello', machineId: MID, name: 'token-box', hostname: os.hostname(), platform: 'test', bridgeVersion: '0.10.0', broker: 1, home: '/h', status: { available: true, server: true, version: '2.3.1' } });
    send({ t: 'kimi.sessions', items: [info, info2].map((i) => ({ ...i, updated_at: new Date().toISOString() })) });
  });
  ws.on('message', (d) => {
    const req = JSON.parse(d);
    if (req.t !== 'req') return;
    const a = req.args || {};
    let out = { ok: true };
    if (req.op === 'kimi.info') out = a.sessionId === KID2 ? info2 : info;
    else if (req.op === 'kimi.history') out = a.sessionId === KID2 ? { frames: journal, more: false, before: 0, info: info2 } : { frames: [], more: false, before: 0, info };
    else if (req.op === 'kimi.request') {
      const models = { items: [{ model: 'kimi/k2', display_name: 'K2', support_efforts: ['low', 'high'], default_effort: 'low' }] };
      if (a.method === 'POST' && /\/prompts$/.test(a.path)) {
        m.prompts.push(a.body);
        out = { code: 0, data: { prompt_id: a.body.prompt_id, status: 'started' } };
        setTimeout(() => m.play(a.body), 50);
      } else out = { code: 0, data: a.path === '/api/v1/models' ? models : a.path === '/api/v1/config' ? { default_model: 'kimi/k2' } : {} };
    }
    send({ t: 'res', id: req.id, ok: true, data: out });
  });
  const frame = (type, payload) => send({ t: 'kimi.event', frame: { type, session_id: KID, payload: { agentId: 'main', ...payload, sessionId: KID } } });
  // What Kimi does with the prompt: its model reads the token out of the Hub's
  // reminder and uses it, in pieces, the way streamed arguments arrive.
  m.play = (body) => {
    const reminder = body.content.map((c) => c.text || '').join('\n');
    const token = /token "(hb_[0-9a-f]+)"/.exec(reminder)?.[1];
    m.token = token;
    m.played = true;
    frame('turn.started', { turnId: 't1', promptId: body.prompt_id, origin: { kind: 'user' }, prompt: 'delegate something' });
    frame('event.session.work_changed', { busy: true, pending_interaction: 'none' });
    frame('assistant.delta', { turnId: 't1', delta: `I will delegate with token ${token}, then report.` });
    if (!token) return;
    const args = { token, provider: 'kimi', model: 'kimi/k2', effort: 'low', task: 'say hi to the broker' };
    const json = JSON.stringify(args);
    const name = 'mcp__agent-hub__delegate_to_provider';
    for (let i = 0; i < json.length; i += 7) frame('tool.call.delta', { turnId: 't1', toolCallId: 'c1', name, argumentsPart: json.slice(i, i + 7) });
    frame('tool.call.started', { turnId: 't1', toolCallId: 'c1', name, args, description: 'delegate' });
    frame('tool.result', { turnId: 't1', toolCallId: 'c1', output: `{"ok":true,"echo":"${token}","login":"x-hub-token: ${LOGIN}","aws":"${FILE_SECRET}","text":"hi from the child"}` });
    frame('turn.ended', { turnId: 't1', reason: 'completed' });
    frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' });
  };
  m.ready = new Promise((r) => ws.on('open', r));
  return m;
}

before(async () => {
  hub = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AGENT_HUB_TOKEN: LOGIN, AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') }, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start\n${log}`)), 15000);
    hub.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
  });
  machine = fakeMachine(JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey);
  await machine.ready;
  await until(async () => (await api('GET', '/machines')).find((x) => x.id === MID && x.online && x.sessions.length === 2), 10000, 'machine online');
});

after(() => {
  machine?.ws.close();
  hub?.kill('SIGTERM');
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

const filesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('a delegation token that the model puts into a tool call never reaches the API, the stream or the disk', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID}/attach`);
  // A page watching the conversation from the start (what the browser keeps).
  const wsPage = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${LOGIN}`);
  const raw = [];
  wsPage.on('message', (d) => raw.push(String(d)));
  await new Promise((resolve, reject) => (wsPage.on('open', resolve), wsPage.on('error', reject)));
  wsPage.send(JSON.stringify({ t: 'watch', sid: s.id }));

  // A cross-provider choice is what makes the Hub issue a token.
  await api('POST', `/sessions/${s.id}/config`, { subagent: { provider: 'kimi', model: 'kimi/k2', effort: 'low' } });
  await api('POST', `/sessions/${s.id}/messages`, { text: `delegate something; my key is ${USER_KEY}` });
  await until(() => machine.played, 10000, 'the prompt reaches Kimi');
  // Positive control 1: the token really was issued and really went to Kimi, intact.
  assert.match(machine.token || '', /^hb_[0-9a-f]{48}$/, `the model was given a real token: ${JSON.stringify(machine.prompts[0])}`);
  const sent = machine.prompts[0].content.map((c) => c.text || '').join('\n');
  assert.ok(sent.includes(machine.token), 'Kimi gets the token in the prompt: masking must not touch what is sent to it');
  assert.ok(sent.includes(USER_KEY), 'and it gets the message as typed');

  const done = await until(async () => {
    const x = await api('GET', `/sessions/${s.id}`);
    return x.status === 'idle' && x.events.some((e) => e.type === 'tool_use' && e.status === 'done') && x;
  }, 15000, 'the turn to finish');
  const token = machine.token;

  // Positive control 2: the card is there and still useful.
  const card = done.events.find((e) => e.type === 'tool_use' && /delegate_to_provider/.test(e.name));
  assert.ok(card, 'the delegation card exists');
  assert.equal(card.input.task, 'say hi to the broker');
  assert.equal(card.input.provider, 'kimi');
  // The card the delegation made is the one Kimi's frames are adopted into (one
  // card per delegation), so it may carry no streamed-arguments preview; when it
  // does, the preview is still the masked task.
  if (card.argsText !== undefined) assert.match(card.argsText, /say hi to the broker/);
  assert.match(card.output, /hi from the child/);
  assert.match(JSON.stringify(card), /\[redacted\]/);

  // 1. The conversation as the API returns it, every way it can be read.
  const bodies = {
    session: JSON.stringify(done),
    list: JSON.stringify(await api('GET', '/sessions')),
    again: JSON.stringify(await api('GET', `/sessions/${s.id}`)),
  };
  for (const [what, body] of Object.entries(bodies)) {
    assert.ok(!body.includes(token), `${what}: the delegation token is in the API response`);
    assert.ok(!body.includes(token.slice(3, 40)), `${what}: most of the token is in the API response`);
    assert.ok(!body.includes(LOGIN), `${what}: the Hub login token is in the API response`);
    assert.ok(!body.includes(FILE_SECRET), `${what}: an AWS key id from a tool result is in the API response`);
    assert.ok(!body.includes(USER_KEY), `${what}: a key the person typed is in the API response`);
  }

  // 2. The live stream the page watched, frame by frame.
  await sleep(200);
  const stream = raw.join('\n');
  assert.ok(stream.includes('delegate_to_provider'), 'the page did watch the tool call');
  assert.ok(!stream.includes(token), 'the delegation token went out on the WebSocket');
  assert.ok(!stream.includes(token.slice(3, 40)), 'most of the token went out on the WebSocket');
  assert.ok(!stream.includes(LOGIN));
  assert.ok(!stream.includes(USER_KEY));
  assert.ok(stream.includes('delegate something'), 'the page did get the user event');
  wsPage.close();

  // 3. Everything on disk (the Hub's own login token and bridge key live in hub.json by design).
  await until(() => {
    const f = filesUnder(path.join(DATA, 'sessions')).find((p) => fs.readFileSync(p, 'utf8').includes('say hi to the broker'));
    return f && fs.readFileSync(f, 'utf8').includes('hi from the child');
  }, 8000, 'the session saved to disk');
  const leaks = filesUnder(DATA)
    .filter((p) => path.basename(p) !== 'hub.json')
    .filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return text.includes(token) || text.includes(token.slice(3, 40)) || text.includes(LOGIN) || text.includes(FILE_SECRET) || text.includes(USER_KEY);
    });
  assert.deepEqual(leaks, [], 'files on disk hold a secret');

  // The conversation is not harmed: it continues, and the next prompt gets a fresh working token.
  await api('POST', `/sessions/${s.id}/messages`, { text: 'again' });
  await until(() => machine.prompts.length === 2, 10000, 'second prompt');
  assert.notEqual(/token "(hb_[0-9a-f]+)"/.exec(machine.prompts[1].content.map((c) => c.text || '').join('\n'))?.[1], undefined);
});

test('opening an older Kimi conversation whose journal holds secrets: the replayed events are masked too', async () => {
  const s = await api('POST', `/machines/${MID}/kimi/${KID2}/attach`);
  const view = await until(async () => {
    const x = await api('GET', `/sessions/${s.id}`);
    return x.events.some((e) => e.type === 'tool_use') && x;
  }, 10000, 'the replayed conversation');
  const wire = JSON.stringify(view);
  assert.match(wire, /old task text/, 'the replay is there');
  assert.match(wire, /old result text/);
  for (const secret of [OLD_TOKEN, OLD_TOKEN.slice(3, 40), OLD_GH]) assert.ok(!wire.includes(secret), `replayed history holds ${secret.slice(0, 8)}…`);
  await until(() => filesUnder(path.join(DATA, 'sessions')).some((p) => fs.readFileSync(p, 'utf8').includes('old result text')), 8000, 'saved');
  for (const p of filesUnder(path.join(DATA, 'sessions'))) {
    const text = fs.readFileSync(p, 'utf8');
    for (const secret of [OLD_TOKEN, OLD_GH]) assert.ok(!text.includes(secret), `${path.basename(p)} holds ${secret.slice(0, 8)}…`);
  }
});
