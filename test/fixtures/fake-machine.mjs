// A machine that speaks the bridge protocol and plays Kimi (conversations,
// models, profile changes, prompts, archive) plus the DeepSeek gateway, so a
// REAL Hub (its runner and its kimi-remote adapter) can be tested with only
// the outside faked. Used by the end-to-end tests that need a Kimi side.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const SUB = 'managed:kimi-code/kimi-for-coding';
export const DS = 'agent-hub-deepseek';
export const GATEWAY_KEY = 'sk-oc-go-0123456789wxyz';

// Go lists V4.1 Flash among others' models; it only takes the one key.
export function startFakeGateway() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/opencode-go/models') return (res.statusCode = 404), res.end('{}');
    if (req.headers.authorization !== `Bearer ${GATEWAY_KEY}`) return (res.statusCode = 401), res.end('{"error":"bad key"}');
    res.end(JSON.stringify({ data: [{ id: 'kimi-k2' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

export function startFakeMachine({ port, key, id = 'm_fake', name = 'fake-machine', home = '/home/fake' }) {
  const k = {
    id,
    sessions: new Map(), // kimi session id -> { cwd, model, thinking, title, permission, busy }
    profiles: [], // { sid, agent_config }
    prompts: [], // { sid, body }
    archived: [],
    forks: [], // { from, to, body } for every :fork asked of the machine
    requests: [],
    rpcs: [], // every bridge operation asked of this machine, in order
    dsModels: [],
    claudeGate: {}, // op -> a promise: see claude.rpc
    historyGate: null, // a promise: the next kimi.history answer waits for it (its content is read before the wait)
    // sh.run really runs the command (bash -c, in the given folder) on this
    // test machine's disk, like the bridge does. `shEnv` adds to its
    // environment; `shHook(args)` may answer instead: a { output, exitCode }
    // (a command that fails), or nothing to let it run.
    shEnv: {},
    shHook: null,
    // POST /api/v1/sessions: `createHook(body)` may answer instead (an error
    // envelope), or nothing to let it create the conversation.
    createHook: null,
    // true: Kimi refuses every prompt (an error envelope, nothing recorded).
    // Or a function (kimi session id, body) => true for the ones to refuse.
    refusePrompts: false,
    // false: the subscription model does not think (no thinking-effort choices
    // at all, as a model of an OpenAI-style provider in the real Kimi).
    subThinking: true,
    autoRemoveOnArchive: true,
    n: 0,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const infoOf = (sid) => {
    const s = k.sessions.get(sid);
    return { id: sid, title: s.title, metadata: { cwd: s.cwd }, busy: Boolean(s.busy), pending_interaction: 'none', last_turn_reason: 'completed', owner: s.owner ?? null, controllable: s.controllable ?? null, guess: false, model: s.model, effort: s.thinking, permission: s.permission };
  };
  const entry = (sid) => ({ ...infoOf(sid), updated_at: new Date().toISOString() });
  const modelItems = () => [
    { model: SUB, display_name: 'kimi-for-coding', max_context_size: 262144, capabilities: [...(k.subThinking ? ['thinking'] : []), 'image_in', 'tool_use'] },
    ...k.dsModels.map((alias, i) => ({ model: alias, display_name: i === 0 ? 'K3-256k' : alias.split('/').pop(), max_context_size: 1_000_000, capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'] })),
  ];
  // What Kimi has stored of a conversation (its journal), served both as the
  // message list and as replay frames, so the Hub's mirror finds the same
  // history it already shows.
  const messagesOf = (sid) => (k.sessions.get(sid)?.history || []).flatMap((h, i) => [
    { id: `m_${sid}_${i}_u`, role: 'user', content: [{ type: 'text', text: h.user }], prompt_id: `p_${sid}_${i}`, created_at: new Date(1_000_000 + i * 2000).toISOString() },
    { id: `m_${sid}_${i}_a`, role: 'assistant', content: [{ type: 'text', text: h.assistant }], created_at: new Date(1_001_000 + i * 2000).toISOString() },
  ]);
  const framesOf = (sid) => (k.sessions.get(sid)?.history || []).flatMap((h, i) => [
    { type: 'turn.started', session_id: sid, time: 1_000_000 + i * 2000, payload: { agentId: 'main', turnId: `t${i}`, promptId: `p_${sid}_${i}`, origin: { kind: 'user' }, prompt: h.user } },
    { type: 'assistant.delta', session_id: sid, time: 1_000_500 + i * 2000, payload: { agentId: 'main', turnId: `t${i}`, delta: h.assistant } },
    { type: 'turn.ended', session_id: sid, time: 1_001_000 + i * 2000, payload: { agentId: 'main', reason: 'completed' } },
  ]);
  k.add = (sid, over = {}) => {
    k.sessions.set(sid, { cwd: '/tmp/project', model: '', thinking: '', title: sid, permission: 'manual', history: [], ...over });
    send({ t: 'kimi.session.update', item: entry(sid) });
  };
  // The native's own word about its model, as Kimi's journal gives it: a
  // main-agent agent.status.updated (config.update / profile.bind there).
  const statusFrame = (sid, model, thinkingEffort) => send({ t: 'kimi.event', frame: { type: 'agent.status.updated', session_id: sid, payload: { agentId: 'main', ...(model ? { model } : {}), ...(thinkingEffort ? { thinkingEffort } : {}) } } });
  // Something other than the Hub changed the native's model (a global default,
  // the terminal, another client): the native really runs it from now on, and
  // says so.
  k.nativeChange = (sid, { model, thinking } = {}) => {
    const s = k.sessions.get(sid);
    if (model) s.model = model;
    if (thinking) s.thinking = thinking;
    statusFrame(sid, model, thinking);
  };
  // Any frame of the native's event stream, main agent unless said otherwise.
  k.frame = (sid, type, payload = {}) => send({ t: 'kimi.event', frame: { type, session_id: sid, payload: { agentId: 'main', ...payload } } });
  // The same with Kimi's own time on it: `time` on the frame (what the journal gives) or, with
  // `inPayload`, in the payload (what Kimi's server gives). `k.send` is any message of the bridge protocol.
  k.send = send;
  k.frameAt = (sid, type, time, payload = {}, { inPayload = false, agentId = 'main' } = {}) =>
    send({ t: 'kimi.event', frame: { type, session_id: sid, ...(inPayload ? {} : { time }), payload: { agentId, ...(inPayload ? { time } : {}), ...payload } } });
  // op -> async (args) => answer: a bridge operation this machine answers its own way.
  k.answers = {};
  // How the native answers a /profile change, once it accepted it:
  //   false (default)  silent: Kimi journals a change with its next turn
  //   true             echoes what it took
  //   (sid, config) => { model, thinking }   says this instead (a native that does not take it)
  k.echoProfile = false;
  // Refuse every /profile change that names a model, as Kimi does an alias it does not know.
  k.refuseProfile = false;
  // Kimi answers a prompt: the frames of one finished turn.
  k.autoReply = true;
  // Imitate a Kimi that predates swarm mode (see the status answer below).
  k.swarmUnsupported = false;
  // Imitate a Kimi that answers a swarm change with "ok" and keeps its state.
  k.swarmIgnore = false;
  k.reply = (sid, promptId, text) => {
    const frame = (type, payload) => send({ t: 'kimi.event', frame: { type, session_id: sid, payload: { agentId: 'main', ...payload } } });
    frame('turn.started', { turnId: `turn_${++k.n}`, promptId, origin: { kind: 'user' }, prompt: text });
    k.sessions.get(sid)?.history.push({ user: text, assistant: `Kimi 收到：${text}` });
    frame('assistant.delta', { turnId: `turn_${k.n}`, delta: `Kimi 收到：${text}` });
    frame('turn.ended', { reason: 'completed' });
    frame('event.session.work_changed', { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' });
  };
  k.pushSessions = () => send({ t: 'kimi.sessions', items: [...k.sessions.keys()].map(entry) });
  const request = (method, p, body) => {
    k.requests.push({ method, path: p, body });
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') return ok({ default_model: SUB });
    if (p === '/api/v1/models') return ok({ items: modelItems() });
    if (method === 'POST' && p === '/api/v1/sessions') {
      const refused = k.createHook?.(body);
      if (refused) return refused;
      const sid = `session_new${++k.n}`;
      k.add(sid, { cwd: body.metadata.cwd });
      return ok({ id: sid, metadata: { cwd: body.metadata.cwd } });
    }
    const m = p.match(/^\/api\/v1\/sessions\/(session_\w+)(.*)$/);
    if (m && /\/skills$/.test(m[2])) return ok({ skills: [] });
    if (m && method === 'GET' && m[2].startsWith('/messages')) return ok({ items: messagesOf(m[1]).reverse(), has_more: false });
    if (m && method === 'POST' && m[2] === '/profile') {
      k.profiles.push({ sid: m[1], agent_config: body.agent_config, title: body.title });
      const c = body.agent_config || {};
      if (c.model && !modelItems().some((x) => x.model === c.model)) return { code: 40113, msg: `model ${c.model} does not exist`, data: null };
      if (c.model && k.refuseProfile) return { code: 50001, msg: 'the model could not be set', data: null };
      const s = k.sessions.get(m[1]);
      if (s) {
        if (c.model) s.model = c.model;
        if (c.thinking) s.thinking = c.thinking;
        if (c.permission_mode) s.permission = c.permission_mode;
        // Plan and swarm mode are the native's own state (Kimi 2.3.3 takes
        // them in agent_config); a swarm change is announced on its event
        // stream, as the real one does (SwarmModeEnter/Exit emit
        // agent.status.updated), and only when the state really changes.
        if (typeof c.plan_mode === 'boolean') s.plan = c.plan_mode;
        if (typeof c.swarm_mode === 'boolean' && Boolean(s.swarm) !== c.swarm_mode && !k.swarmUnsupported && !k.swarmIgnore) {
          s.swarm = c.swarm_mode;
          queueMicrotask(() => k.frame(m[1], 'agent.status.updated', { swarmMode: c.swarm_mode }));
        }
      }
      if (k.echoProfile && (c.model || c.thinking)) {
        const said = typeof k.echoProfile === 'function' ? k.echoProfile(m[1], c) : { model: c.model, thinking: c.thinking };
        if (said?.model && s) s.model = said.model;
        queueMicrotask(() => statusFrame(m[1], said?.model, said?.thinking));
      }
      return ok({ id: m[1] });
    }
    // GET /sessions/:id/status, as 2.3.3 answers it. An older Kimi has no
    // swarm_mode in it (k.swarmUnsupported imitates one: it also drops the
    // swarm_mode a profile change carries).
    if (m && method === 'GET' && m[2] === '/status') {
      const s = k.sessions.get(m[1]);
      if (!s) return { code: 40401, msg: 'session not found', data: null };
      return ok({ busy: Boolean(s.busy), model: s.model, thinking_level: s.thinking || 'off', permission: s.permission, plan_mode: Boolean(s.plan), ...(k.swarmUnsupported ? {} : { swarm_mode: Boolean(s.swarm) }), context_tokens: 0 });
    }
    if (m && method === 'POST' && m[2] === '/prompts') {
      if (typeof k.refusePrompts === 'function' ? k.refusePrompts(m[1], body) : k.refusePrompts) return { code: 50001, msg: 'simulated: the prompt was refused', data: null };
      k.prompts.push({ sid: m[1], body });
      const said = (body.content || []).filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');
      if (k.autoReply) setTimeout(() => k.reply(m[1], body.prompt_id, said), 20);
      return ok({ prompt_id: body.prompt_id, status: 'started' });
    }
    // Kimi's :fork, as the real Kimi 2.3.3 answered it (test/e2e-fork.test.mjs
    // runs the real one): a new conversation in the same folder with the whole
    // history copied, the given title or "Fork: <title>", and the model,
    // thinking and permission of the journal it copied. A busy conversation is
    // refused with 40901.
    if (m && method === 'POST' && m[2] === ':fork') {
      const src = k.sessions.get(m[1]);
      if (!src) return { code: 40401, msg: 'session not found', data: null };
      if (src.busy) return { code: 40901, msg: 'session busy', data: null };
      const sid = `session_fork${++k.n}`;
      k.add(sid, { cwd: src.cwd, title: body?.title || `Fork: ${src.title}`, model: src.model, thinking: src.thinking, permission: src.permission, history: src.history.map((h) => ({ ...h })) });
      k.forks.push({ from: m[1], to: sid, body });
      return ok({ id: sid, metadata: { cwd: src.cwd } });
    }
    if (m && method === 'POST' && m[2] === ':archive') {
      k.archived.push(m[1]);
      if (k.autoRemoveOnArchive) {
        k.sessions.delete(m[1]);
        queueMicrotask(() => send({ t: 'kimi.event', frame: { type: 'event.session.archived', session_id: m[1] } }));
      }
      return ok({});
    }
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId: id, name, hostname: os.hostname(), platform: 'test', bridgeVersion: '0.9.0', broker: 1, home, status });
    send({ t: 'kimi.sessions', items: [] });
  });
  // The Claude side of this computer: the REAL daemon (server/claude-daemon.js)
  // against the fake Claude API, reached the way a bridge reaches it (calls
  // relayed, its event stream forwarded to the Hub as claude.event).
  let daemon = null;
  k.startClaudeDaemon = async ({ root, dir, anthropicUrl }) => {
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn(process.execPath, ['server/claude-daemon.js', '--dir', dir], {
      cwd: root,
      env: { ...process.env, AGENT_HUB_CLAUDE_TEST_URL: anthropicUrl, AGENT_HUB_DATA: dir, AGENT_HUB_WORKSPACES: path.join(dir, 'ws') },
      stdio: 'ignore',
    });
    let info = null;
    for (let i = 0; i < 200 && !info; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
        if (j.pid === child.pid && j.port && j.token) info = j;
      } catch {}
    }
    if (!info) throw new Error('the Claude daemon did not start');
    daemon = { child, info, ac: new AbortController() };
    (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/events`, { headers: { 'x-daemon-token': info.token }, signal: daemon.ac.signal });
        send({ t: 'claude.event', msg: { t: 'resync' } });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
            if (data) try { send({ t: 'claude.event', msg: JSON.parse(data) }); } catch {}
          }
        }
      } catch {}
    })();
    return info;
  };
  k.stopClaudeDaemon = () => {
    daemon?.ac.abort();
    try { daemon?.child.kill('SIGTERM'); } catch {}
  };
  ws.on('message', async (data) => {
    const m = JSON.parse(data);
    if (m.t !== 'req') return;
    const a = m.args || {};
    k.rpcs.push({ op: m.op, args: a });
    let out;
    if (k.answers[m.op]) {
      try {
        out = await k.answers[m.op](a);
      } catch (err) {
        return send({ t: 'res', id: m.id, ok: false, error: err.message, status: err.status });
      }
      return send({ t: 'res', id: m.id, ok: true, data: out });
    }
    switch (m.op) {
      case 'claude.rpc': {
        if (!daemon) return send({ t: 'res', id: m.id, ok: false, error: '未知的操作：claude.rpc' });
        const r = await (await fetch(`http://127.0.0.1:${daemon.info.port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daemon-token': daemon.info.token }, body: JSON.stringify({ op: a.op, args: a.args || {} }) })).json();
        // k.claudeGate[op] = a promise: the daemon has done the call, but its answer
        // is held (used once) like a slow round trip, while the daemon's event
        // stream goes on. What the Hub sees when a short turn begins and ends
        // before the answer to its `send` arrives.
        const gate = k.claudeGate?.[a.op];
        if (gate) {
          k.claudeGate[a.op] = null;
          await gate;
        }
        if (!r.ok) return send({ t: 'res', id: m.id, ok: false, error: r.error || 'daemon error', status: r.status });
        out = r.data;
        break;
      }
      case 'claude.health':
        out = { ok: true };
        break;
      case 'kimi.status':
      case 'kimi.start':
        out = status;
        break;
      case 'kimi.info':
        out = k.sessions.has(a.sessionId) ? infoOf(a.sessionId) : null;
        break;
      case 'kimi.history': {
        // The journal is read NOW; the answer may be held (k.historyGate, used
        // once) like a slow disk or a long round trip: what Kimi writes in the
        // meantime is not in it.
        out = { frames: framesOf(a.sessionId), more: false, before: 0, info: k.sessions.has(a.sessionId) ? infoOf(a.sessionId) : {} };
        const gate = k.historyGate;
        k.historyGate = null;
        if (gate) await gate;
        break;
      }
      case 'kimi.request':
        out = request(a.method, a.path, a.body);
        break;
      case 'kimi.deepseek.provision':
        k.dsModels = a.models.map((x) => `${DS}/${x.model}`);
        out = { ok: true, created: true, models: k.dsModels, sessionHeader: true };
        break;
      case 'kimi.deepseek.remove':
        k.dsModels = [];
        out = { ok: true, removed: true };
        break;
      case 'workspace.create':
        out = { path: '/tmp/agent-hub-workspaces/new' };
        break;
      case 'sh.run': {
        const hooked = await k.shHook?.(a);
        if (hooked) {
          out = { killedBy: null, ...hooked };
          break;
        }
        out = await new Promise((resolve) => {
          const child = spawn('bash', ['-c', String(a.command)], { cwd: a.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...k.shEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
          let text = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (d) => (text += d));
          child.stderr.on('data', (d) => (text += d));
          child.on('error', (err) => resolve({ output: err.message, exitCode: -1, killedBy: null }));
          child.on('close', (code) => resolve({ output: text, exitCode: code ?? -1, killedBy: null }));
        });
        break;
      }
      case 'fs.stat': {
        // This computer's disk is this test machine's disk.
        const st = fs.statSync(path.resolve(a.cwd || '/', a.path || '.'), { throwIfNoEntry: false });
        out = { exists: Boolean(st), dir: Boolean(st?.isDirectory()), size: st?.size ?? 0 };
        break;
      }
      default:
        out = { ok: true };
    }
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  k.ready = new Promise((r) => ws.on('open', r));
  k.close = () => {
    k.stopClaudeDaemon();
    ws.close();
  };
  return k;
}
