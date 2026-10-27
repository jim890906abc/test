// Conversations built to be longer than the window the Hub sends, with the
// thing under test placed where windowing cuts it off: a page written long
// ago, a subagent card far above the steps that go on inside it, a turn so
// long its question is out of the window.
//
// Everything is made up here (no real conversation, path or name).
import { seedSession } from '../browser-harness.mjs';

export const T0 = 1_790_000_000_000;

// A small window, so that a few dozen events are "longer than the window":
// the newest `WINDOW` events (and at most 2 turns) go to the page.
export const WINDOW = 24;
export const WINDOW_ENV = {
  AGENT_HUB_WINDOW_EVENTS: String(WINDOW),
  AGENT_HUB_WINDOW_TURNS: '2',
  AGENT_HUB_WINDOW_LATEST_EVENTS: String(WINDOW),
  AGENT_HUB_LIVE_TAIL: '4',
};

// Event makers; ids count up per scene so they are readable in a failure.
export function maker(prefix = 'e', start = T0) {
  let n = 0;
  let ts = start;
  const base = (type, extra) => ({ id: `${prefix}${++n}`, ts: (ts += 1000), type, ...extra });
  return {
    user: (text, extra = {}) => base('user', { text, ...extra }),
    text: (text, extra = {}) => base('text', { agentId: 'main', text, ...extra }),
    end: () => base('turn_end', { durationMs: 1000, interrupted: false, error: false }),
    tool: (name, input, extra = {}) => base('tool_use', { agentId: 'main', toolCallId: `call_${n + 1}`, name, title: input?.command || input?.path || name, status: 'done', input, isError: false, output: 'ok', ...extra }),
    // `count` questions with an answer each: padding that pushes everything before it out of the window.
    filler: function* filler(count, tag = 'padding') {
      for (let i = 0; i < count; i++) {
        yield base('user', { text: `${tag} question ${i}` });
        yield base('text', { agentId: 'main', text: `${tag} answer ${i}` });
        yield base('turn_end', { durationMs: 1000, interrupted: false, error: false });
      }
    },
    get next() {
      return n + 1;
    },
  };
}

// A stored Kimi conversation on a computer that is not connected (opening it
// starts nothing real), holding `events`.
export function storedSession(events, patch = {}) {
  return seedSession({
    id: 's_scene',
    title: 'scene',
    agentId: 'kimi@m_scene',
    machineId: 'm_scene',
    kimiSessionId: 'session_scene',
    provider: 'kimi',
    cwd: '/work/scene',
    meta: { machineName: 'scene', model: 'kimi-code/k3', effort: 'max' },
    events,
    ...patch,
  });
}

export const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// Pages written early in a conversation and edited again after a long stretch,
// in a conversation much longer than the window. Returns the events and what
// the Artifact panel must end up showing for each page.
export function artifactScene({ padding = 40 } = {}) {
  const m = maker('a');
  const events = [];
  const add = (...evs) => events.push(...evs);
  add(m.user('做幾個頁面'));
  const old1 = page('舊頁面', '<p>第一版</p>');
  add(m.tool('Write', { path: '/site/old.html', content: old1 }));
  add(m.tool('Edit', { path: '/site/old.html', old_string: '第一版', new_string: '第二版' }));
  add(m.tool('Write', { path: '/site/other.html', content: page('其他頁', '<p>只寫過一次</p>') }));
  add(m.text('做好了'), m.end());
  add(...m.filler(padding));
  // After the long stretch: the page is edited again (its Write is far out of the window) and a new one is written.
  add(m.user('再改一下'));
  add(m.tool('Edit', { path: '/site/old.html', old_string: '第二版', new_string: '第三版' }));
  add(m.tool('Write', { path: '/site/new.html', content: page('新頁面', '<p>最近寫的</p>') }));
  add(m.text('改好了'), m.end());
  return {
    events,
    expected: {
      'old.html': { versions: 3, title: '舊頁面', contains: ['第三版'], lacks: ['第一版', '第二版'], v1: '第一版', v2: '第二版' },
      'other.html': { versions: 1, title: '其他頁', contains: ['只寫過一次'] },
      'new.html': { versions: 1, title: '新頁面', contains: ['最近寫的'] },
    },
  };
}
