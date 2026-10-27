// A REAL Hub (windowing on, with small windows so a few dozen events are "more
// than the window") with a made-up computer connected to it that streams a Kimi
// conversation into it, frame by frame, the way a real one does. Nothing of the
// Hub is replaced: the page under test opens the conversation the Hub built
// from those frames. This is what the "derived state" checks run on (a busy
// conversation, a subagent still working, a turn longer than the window).
import fs from 'node:fs';
import path from 'node:path';
import { startHub } from '../browser-harness.mjs';
import { fakeMachine, until, sleep } from '../hub-ws-fixtures.mjs';
import { WINDOW_ENV } from './window-scenes.mjs';

export { sleep, until };

export async function startLiveHub({ env = WINDOW_ENV, kid = 'session_live' } = {}) {
  const hub = await startHub([], { env });
  const key = JSON.parse(fs.readFileSync(path.join(hub.data, 'hub.json'), 'utf8')).bridgeKey;
  const machine = fakeMachine({ port: hub.port, key, kid, machineId: 'm_w' });
  await machine.ready;
  await until(async () => (await hub.api('/machines')).find((m) => m.online && m.sessions.length), 10000, 'machine online');
  const sid = (await hub.api(`/machines/m_w/kimi/${kid}/attach`, { method: 'POST' })).id;
  let turn = 0;
  let call = 0;
  const frame = (type, payload) => machine.frame(type, payload);
  const live = {
    hub,
    machine,
    sid,
    frame,
    // The conversation as the Hub holds it (whole), for what a test expects.
    whole: async () => (await hub.api(`/sessions/${sid}?window=all`)).events,
    // Wait until the Hub has taken in everything sent so far.
    async settled(minEvents = 0) {
      let last = -1;
      let still = 0;
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const n = (await live.whole()).length;
        still = n === last ? still + 1 : 0;
        last = n;
        if (n >= minEvents && still >= 3) return n;
        await sleep(60);
      }
      throw new Error('the Hub did not settle');
    },
    // A turn begins: the person's message, and the conversation is working.
    start(text) {
      turn++;
      machine.info.busy = true;
      frame('turn.started', { turnId: `t${turn}`, promptId: `p${turn}`, origin: { kind: 'user' }, prompt: text });
      frame('event.session.work_changed', { busy: true, pending_interaction: 'none' });
      return `t${turn}`;
    },
    // A finished tool call (a command), by the main agent or inside a subagent.
    tool(n, { agentId = 'main', name = 'Bash' } = {}) {
      const id = `c${++call}`;
      frame('tool.call.started', { agentId, turnId: `t${turn}`, toolCallId: id, name, args: name === 'Bash' ? { command: `echo ${n}` } : { path: `/work/f${n}.txt` } });
      frame('tool.result', { agentId, turnId: `t${turn}`, toolCallId: id, output: `${n}\n` });
    },
    // The model says something (one text event).
    say(text, { agentId = 'main' } = {}) {
      frame('assistant.delta', { agentId, turnId: `t${turn}`, delta: text });
    },
    // A subagent card: the Agent call and the subagent it starts. It goes on
    // working (no result yet) unless `background` is false and a result is sent.
    agent(name, { background = false } = {}) {
      const id = `a${++call}`;
      const subagentId = `sub-${id}`;
      frame('tool.call.started', { turnId: `t${turn}`, toolCallId: id, name: 'Agent', args: { description: name, prompt: `do ${name}`, ...(background ? { run_in_background: true } : {}) } });
      frame('subagent.spawned', { turnId: `t${turn}`, subagentId, parentToolCallId: id, subagentName: 'coder', description: name, runInBackground: background });
      return { id, subagentId };
    },
    end() {
      machine.info.busy = false;
      frame('turn.ended', { turnId: `t${turn}`, reason: 'completed' });
      frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' });
    },
    stop() {
      machine.ws.close();
      hub.stop();
    },
  };
  return live;
}
