// A scripted machine that speaks the bridge protocol and plays Kimi 2.1.1's
// prompt queue, for the 插隊 (cut-in) tests and screenshots:
//   • `:steer` is refused with 40402 "no active prompt to steer into" while the
//     running turn was not started by a message (a background task finished,
//     a cron job), and taken in a turn a message started;
//   • `GET /prompts` shows an `active` prompt only for such a turn;
//   • aborting a queued prompt takes it out of the queue, aborting the
//     session ends the turn, and the next queued message then starts;
//   • stopping a turn leaves background tasks alone: the fake records any call
//     that would stop one (`taskKills`), and the tests expect none.
import WebSocket from 'ws';

// One Kimi conversation on the machine, with its prompt queue.
export function fakeKimi(machineSend, sid, { model = '', title = sid } = {}) {
  const k = {
    sid,
    model,
    title,
    busy: false,
    turn: 0,
    active: null, // { turnId, promptId, tracked, kind }
    queue: [], // { promptId, text, content }: waiting prompts
    prompts: [], // every POST …/prompts: { promptId, text, hidden, images, content, busy }
    steers: [], // prompt ids taken into a running turn
    refused: [], // prompt ids refused
    promptAborts: [], // prompt ids taken back from the queue
    sessionAborts: 0,
    abortAt: 0,
    detached: [],
    tasks: [], // what GET …/tasks lists
    taskKills: [], // calls that would stop a task: there must be none
    nudgeAfterAbort: false, // a background task finishes at the moment the turn is stopped: Kimi goes straight on to a turn of its own
    steerMode: 'real', // 'real' | 'refuse' (even a message's turn) | 'accept' (even Kimi's own) | 'other' | 'notpending'
    abortDelay: 40,
    pending: 'none',
    bgBusy: false, // a background task is running: busy even between turns
    log: [], // the calls that matter, in order
    frames: [],
    onGetPrompts: null,
    afterPromptAbort: null,
    owner: null,
  };
  const frame = (type, payload) => {
    const f = { type, session_id: sid, time: Date.now(), payload: { agentId: 'main', ...payload, sessionId: sid } };
    k.frames.push(f);
    machineSend({ t: 'kimi.event', frame: f });
  };
  // Kimi keeps a session `busy` for as long as a background task runs, with no turn at all.
  const work = (active) => frame('event.session.work_changed', { busy: active || k.bgBusy, main_turn_active: active, pending_interaction: k.pending, last_turn_reason: active ? undefined : 'completed' });
  k.work = work;
  k.frame = frame;
  k.info = () => ({ id: sid, title: k.title, metadata: { cwd: '/tmp/project' }, busy: k.busy || k.bgBusy, pending_interaction: k.pending, last_turn_reason: 'completed', model: k.model, owner: k.owner, controllable: k.owner ? true : null });
  k.entry = () => ({ ...k.info(), updated_at: new Date().toISOString() });

  // A turn a message started (tracked: takes steers), or one Kimi started itself.
  k.startTurn = (text, { promptId, tracked = true, kind = 'user' } = {}) => {
    promptId ||= `${tracked ? 'k' : 'msg'}_${Math.random().toString(36).slice(2, 8)}`;
    k.busy = true;
    k.turn++;
    k.active = { turnId: `t${k.turn}`, promptId, tracked, kind };
    frame('turn.started', { turnId: k.active.turnId, promptId, origin: { kind }, prompt: text });
    work(true);
  };
  k.startOwnTurn = (kind = 'background_task') => k.startTurn('', { tracked: false, kind });
  k.endTurn = (reason = 'completed') => {
    if (!k.active) return;
    frame('turn.ended', { turnId: k.active.turnId, reason });
    k.active = null;
    k.busy = false;
    // Kimi runs the next waiting message as a turn of its own, at once.
    const next = k.queue.shift();
    if (next) k.startTurn(next.text, { promptId: next.promptId, tracked: true });
    else if (reason === 'cancelled' && k.nudgeAfterAbort) {
      k.nudgeAfterAbort = false;
      k.startOwnTurn();
    } else work(false);
  };
  k.toolStart = (id, name = 'Bash', args = { command: 'pytest' }) => frame('tool.call.started', { turnId: k.active?.turnId, toolCallId: id, name, args });
  k.toolResult = (id, output = 'ok') => frame('tool.result', { turnId: k.active?.turnId, toolCallId: id, output });
  k.stepDone = () => frame('turn.step.completed', { turnId: k.active?.turnId, step: 1, usage: { output: 10 }, llmStreamDurationMs: 100 });
  k.think = (delta) => frame('thinking.delta', { turnId: k.active?.turnId, delta });

  const textOf = (content) => (content || []).filter((c) => c.type === 'text' && !c.text.startsWith('<system-reminder>')).map((c) => c.text).join('');
  k.request = (method, p, body) => {
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    const err = (code, msg) => ({ code, msg, data: null });
    if (p === '/skills') return ok({ skills: [] });
    if (method === 'POST' && p === '/prompts') {
      const content = body.content || [];
      const rec = { promptId: body.prompt_id, text: textOf(content), hidden: content.filter((c) => c.type === 'text' && c.text.startsWith('<system-reminder>')).map((c) => c.text), images: content.filter((c) => c.type === 'image'), content, busy: k.busy, at: Date.now() };
      k.prompts.push(rec);
      k.log.push(`post:${rec.promptId}`);
      if (k.busy) {
        k.queue.push({ promptId: rec.promptId, text: rec.text, content: content.filter((c) => !c.text?.startsWith?.('<system-reminder>')) });
        return ok({ prompt_id: rec.promptId, status: 'queued' });
      }
      setTimeout(() => k.startTurn(rec.text, { promptId: rec.promptId, tracked: true }), 20);
      return ok({ prompt_id: rec.promptId, status: 'started' });
    }
    if (method === 'GET' && p === '/prompts') {
      k.log.push('get-prompts');
      k.onGetPrompts?.();
      return ok({ active: k.active?.tracked ? { prompt_id: k.active.promptId, status: 'running' } : null, queued: k.queue.map((q) => ({ prompt_id: q.promptId, status: 'queued', content: q.content })) });
    }
    const steer = p.match(/^\/prompts\/([\w-]+):steer$/);
    if (method === 'POST' && steer) {
      const id = steer[1];
      if (k.steerMode === 'other') return k.refused.push(id), err(50000, 'boom');
      if (k.steerMode === 'notpending') return k.refused.push(id), err(40402, 'one or more prompts are not pending');
      const own = !k.active || !k.active.tracked;
      if (k.steerMode !== 'accept' && (own || k.steerMode === 'refuse')) return k.refused.push(id), err(40402, 'no active prompt to steer into');
      const i = k.queue.findIndex((q) => q.promptId === id);
      if (i === -1) return k.refused.push(id), err(40402, 'one or more prompts are not pending');
      const [q] = k.queue.splice(i, 1);
      k.steers.push(id);
      setTimeout(() => {
        frame('prompt.steered', { promptIds: [id], activePromptId: k.active?.promptId });
        frame('turn.steer', { turnId: k.active?.turnId, input: q.content, promptIds: [id] });
      }, 20);
      return ok({ steered: true, prompt_ids: [id] });
    }
    const abort = p.match(/^\/prompts\/([\w-]+):abort$/);
    if (method === 'POST' && abort) {
      const id = abort[1];
      k.log.push(`prompt-abort:${id}`);
      const i = k.queue.findIndex((q) => q.promptId === id);
      if (i !== -1) {
        k.queue.splice(i, 1);
        k.promptAborts.push(id);
        setTimeout(() => frame('prompt.aborted', { promptId: id }), 10);
        const after = k.afterPromptAbort;
        k.afterPromptAbort = null;
        after?.(id);
        return ok({ aborted: true });
      }
      if (k.active?.tracked && k.active.promptId === id) {
        setTimeout(() => k.endTurn('cancelled'), k.abortDelay);
        return ok({ aborted: true });
      }
      return err(40402, `prompt ${id} not found`);
    }
    if (method === 'POST' && p === ':abort') {
      k.sessionAborts++;
      k.abortAt = Date.now();
      k.log.push('session-abort');
      setTimeout(() => k.endTurn('cancelled'), k.abortDelay);
      return ok({ aborted: true });
    }
    if (p === '/tasks') return ok({ items: k.tasks });
    const detach = p.match(/^\/tasks\/([\w-]+):detach$/);
    if (method === 'POST' && detach) {
      k.detached.push(detach[1]);
      k.log.push(`detach:${detach[1]}`);
      const t = k.tasks.find((x) => x.id === detach[1]);
      if (t) t.run_in_background = true;
      // The tool call returns ("moved to background"): a step boundary.
      setTimeout(() => {
        if (t) k.toolResult(t.parent_tool_call_id, 'moved to background');
        k.stepDone();
      }, 30);
      return ok({ id: detach[1] });
    }
    if (/^\/tasks\/[\w-]+(:(stop|cancel|kill))?$/.test(p) && (method === 'DELETE' || /:(stop|cancel|kill)$/.test(p))) {
      k.taskKills.push(`${method} ${p}`);
      return ok({});
    }
    return ok({});
  };
  return k;
}

export function fakeMachine({ port, key, machineId, models = [] }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const status = { available: true, server: true, version: '2.1.1', port: 1, auth: null, terminals: true };
  const m = { sessions: new Map() };
  m.add = (sid, opts) => {
    const k = fakeKimi(send, sid, opts);
    m.sessions.set(sid, k);
    return k;
  };
  const request = (method, p, body) => {
    const ok = (data) => ({ code: 0, msg: 'ok', data });
    if (p === '/api/v1/config') return ok({ default_model: 'fake/fake-1' });
    if (p === '/api/v1/models') return ok({ items: [{ model: 'fake/fake-1', display_name: 'Fake', capabilities: [], max_context_size: 128000 }, ...models] });
    const s = p.match(/^\/api\/v1\/sessions\/(session_\w+)(.*)$/);
    if (s && m.sessions.has(s[1])) return m.sessions.get(s[1]).request(method, s[2], body);
    return ok({});
  };
  ws.on('open', () => {
    send({ t: 'hello', machineId, name: 'fake-machine', platform: 'test', bridgeVersion: '0.8.0', home: '/home/fake', status });
    send({ t: 'kimi.sessions', items: [...m.sessions.values()].map((k) => k.entry()) });
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.t !== 'req') return;
    const a = msg.args || {};
    let out;
    switch (msg.op) {
      case 'kimi.status':
      case 'kimi.start':
        out = status;
        break;
      case 'kimi.info':
        out = m.sessions.get(a.sessionId)?.info() ?? null;
        break;
      case 'kimi.history':
        out = { frames: m.sessions.get(a.sessionId)?.frames || [], more: false, before: 0, info: m.sessions.get(a.sessionId)?.info() };
        break;
      case 'kimi.request':
        out = request(a.method, a.path, a.body);
        break;
      default:
        out = { ok: true };
    }
    send({ t: 'res', id: msg.id, ok: true, data: out });
  });
  m.ready = new Promise((r) => ws.on('open', r));
  m.close = () => ws.close();
  return m;
}

