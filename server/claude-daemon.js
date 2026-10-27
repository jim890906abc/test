#!/usr/bin/env node
// The Claude daemon: runs Claude conversations (Claude API, the Console API
// key) on the computer their tools work on, on its own — like `kimi web`
// for Kimi. The hub (or the computer's bridge, for the hub) only watches and
// drives it: closing the hub, or the bridge, leaves every conversation
// running here, and they are all still here when it comes back.
//
//   node claude-daemon.js --dir <state dir>
//
// It listens on 127.0.0.1 only, on a port and with a token written to
// <dir>/daemon.json (readable by this user only):
//   GET  /health                     { ok, version, pid, running: [ids], capabilities: [names] }
//   POST /rpc     { op, args }       { ok, data } | { ok: false, error, status }
//   GET  /events                     server-sent events, one JSON message each:
//        { t: 'event' | 'patch' | 'delta' | 'session' | 'reset' | 'deleted', sid, seq, … }
// with the header x-daemon-token. Conversations are kept as JSON in
// <dir>/sessions; the API key the hub hands over in <dir>/claude.json.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const DIR = path.resolve(argv[argv.indexOf('--dir') + 1] || path.join(process.env.HOME || '.', '.agent-hub', 'claude'));
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
// The engine below keeps its state under AGENT_HUB_DATA.
process.env.AGENT_HUB_DATA = DIR;
process.env.AGENT_HUB_WORKSPACES ||= path.join(process.env.HOME || DIR, 'agent-hub-workspaces');

const store = await import('./store.js');
const account = await import('./claude-account.js');
const claude = await import('./adapters/claude.js');

// This program's own bytes: a hub with different code restarts it (when
// nothing is running) to update it.
const SELF = fileURLToPath(import.meta.url);
export const VERSION = crypto.createHash('sha1').update(fs.readFileSync(SELF)).update(process.env.AGENT_HUB_DAEMON_VERSION || '').digest('hex').slice(0, 12);

// ------------------------------------------------------------- the stream

const clients = new Set(); // http responses of /events
function publish(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
}

const summary = (s) => ({
  id: s.id,
  title: s.title,
  titled: s.titled,
  status: s.status,
  cwd: s.cwd,
  meta: s.meta,
  usage: s.usage,
  allowedTools: s.allowedTools,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});
const snapshot = (s) => ({ ...summary(s), seq: s.seq || 0, events: s.events });

function touch(s) {
  s.seq = (s.seq || 0) + 1;
  store.saveSession(s);
  return s.seq;
}

// What the engine calls to change a conversation: kept, and told to whoever
// watches.
function liveContext(session) {
  // `seq`: how far the conversation was when this was said.
  const changed = () => {
    store.saveSession(session);
    publish({ t: 'session', sid: session.id, seq: session.seq || 0, session: summary(session) });
  };
  return {
    session,
    emit(fields) {
      const ev = { id: store.newId('e_'), ts: Date.now(), ...fields };
      session.events.push(ev);
      publish({ t: 'event', sid: session.id, seq: touch(session), ev });
      return ev;
    },
    patch(ev, fields) {
      Object.assign(ev, fields);
      if (!ev.id) return;
      publish({ t: 'patch', sid: session.id, seq: touch(session), id: ev.id, fields });
    },
    delta(ev, text, field = 'text') {
      if (!text) return;
      ev[field] = (ev[field] || '') + text;
      publish({ t: 'delta', sid: session.id, seq: touch(session), id: ev.id, field, text });
    },
    setStatus(status) {
      if (session.status === status) return;
      session.status = status;
      changed();
    },
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
      changed();
    },
    setTitle(title) {
      if (!title || title === session.title) return;
      session.title = title;
      session.titled = true;
      changed();
    },
    replaceEvents(events) {
      session.events = events;
      publish({ t: 'reset', sid: session.id, seq: touch(session) });
    },
  };
}
claude.init(liveContext);

store.loadSessions();
for (const s of store.listSessions()) claude.restore(s);

// ------------------------------------------------------------------- ops

const must = (id) => {
  const s = store.getSession(String(id || ''));
  if (!s) throw Object.assign(new Error('找不到這個 Claude 對話'), { status: 404 });
  return s;
};

// The hub sends its key and Claude settings along with what it asks. A
// conversation's subagent default comes along too: the Hub owns it, and the
// daemon's copy must not go stale when it is changed while nothing runs.
function applyAuth(auth, args) {
  if (!auth) return;
  if (auth.apiKey && auth.apiKey !== account.apiKey()) account.setKey(auth.apiKey);
  if (auth.settings) account.setSettings(auth.settings, { explicit: true });
  if (Object.prototype.hasOwnProperty.call(auth, 'subagent') && args?.id) {
    const s = store.getSession(String(args.id));
    // Fail closed: an invalid setting must fail this call, not be ignored
    // and leave the old value silently in place.
    if (s) claude.applyHubSubagent(s, auth.subagent);
  }
}

const OPS = {
  async create({ id, cwd, title, config, permissionMode }) {
    if (store.getSession(id)) return snapshot(store.getSession(id));
    // Bound to a GitHub repository: the folder is the clone, made in setup.
    if (!config?.repo && !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(new Error(`資料夾不存在：${cwd}`), { status: 400 });
    const s = store.createSession({ id, agentId: 'claude', cwd: cwd || '', permissionMode: permissionMode || 'ask', title: title || '新對話' });
    try {
      await claude.setup(s, config || {});
    } catch (err) {
      store.deleteSession(s.id);
      throw err;
    }
    publish({ t: 'session', sid: s.id, seq: s.seq || 0, session: summary(s) });
    return snapshot(s);
  },
  // A conversation the hub ran itself before there was a daemon.
  import({ session }) {
    if (store.getSession(session.id)) return snapshot(store.getSession(session.id));
    const { machineId, ...rest } = session;
    const s = store.createSession({ ...rest, agentId: 'claude' });
    claude.restore(s);
    return snapshot(s);
  },
  snapshot: ({ id }) => snapshot(must(id)),
  list: () => store.listSessions().map(summary),
  // With the conversation's state right after: the hub shows it at once,
  // unless its stream has already brought something newer.
  async send({ id, text, images, note, steer }) {
    const s = must(id);
    const r = await claude.send(s, String(text ?? ''), { images: images || [], note, steer });
    return { ...r, status: s.status, seq: s.seq || 0 };
  },
  interrupt: ({ id }) => claude.interrupt(must(id)),
  respond: ({ id, eventId, optionId, extra }) => claude.respond(must(id), eventId, String(optionId ?? ''), extra || {}),
  configure: ({ id, change }) => claude.configure(must(id), change || {}),
  // The Hub's answer to a cross-provider Task (server/adapters/claude.js).
  // True when that request was still waiting; a late answer is ignored.
  brokerResult: ({ id, requestId, result }) => claude.brokerResult(must(id), String(requestId || ''), result || {}),
  // The Hub has the request and its child is working: the wait goes on.
  brokerAck: ({ id, requestId }) => claude.brokerAck(must(id), String(requestId || '')),
  // What this daemon can do: the Hub asks before sending a field an older
  // daemon would accept and ignore.
  capabilities: () => ({ version: VERSION, capabilities: claude.CAPABILITIES }),
  async command({ id, name, args }) {
    const r = (await claude.command(must(id), String(name || ''), String(args ?? ''))) || {};
    if (r.session) {
      publish({ t: 'session', sid: r.session.id, seq: r.session.seq || 0, session: summary(r.session) });
      return { session: snapshot(r.session) };
    }
    return {};
  },
  // Bound to a GitHub repository from now on (see claude.bindRepo).
  async bindRepo({ id, repo }) {
    const s = must(id);
    const r = await claude.bindRepo(s, { full: String(repo?.full || ''), branch: String(repo?.branch || '') });
    publish({ t: 'session', sid: s.id, seq: s.seq || 0, session: summary(s) });
    return r;
  },
  steerQueued: ({ id, promptId }) => claude.steerQueued(must(id), promptId),
  steerAll: ({ id }) => claude.steerAll(must(id)),
  cancelQueued: ({ id, promptId }) => claude.cancelQueued(must(id), promptId),
  title({ id, title }) {
    liveContext(must(id)).setTitle(String(title || '').slice(0, 120));
  },
  delete({ id }) {
    const s = store.getSession(String(id || ''));
    if (!s) return;
    claude.dispose(s);
    store.deleteSession(s.id);
    publish({ t: 'deleted', sid: s.id });
  },
  models: () => account.models(),
  test: () => account.models({ fresh: true }),
};

// --------------------------------------------------------------- server

const TOKEN = crypto.randomBytes(24).toString('hex');
const running = () => store.listSessions().filter((s) => claude.isRunning(s)).map((s) => s.id);

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const token = req.headers['x-daemon-token'] || '';
  if (token.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) return send(401, { ok: false, error: 'bad token' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, version: VERSION, pid: process.pid, running: running(), capabilities: claude.CAPABILITIES });
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': hello\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => (clearInterval(ping), clients.delete(res)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let raw = '';
    // Decoded across chunks: a character cut between two of them (any Chinese
    // character is three bytes) must not turn into U+FFFD.
    req.setEncoding('utf8');
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      try {
        const { op, args = {} } = JSON.parse(raw || '{}');
        if (!Object.hasOwn(OPS, op)) return send(404, { ok: false, error: `Claude 背景程式不認得這個操作：${op}`, status: 400 });
        applyAuth(args.auth, args);
        send(200, { ok: true, data: (await OPS[op](args)) ?? null });
      } catch (err) {
        send(200, { ok: false, error: err.message || String(err), status: err.status || 500 });
      }
    });
    return;
  }
  send(404, { ok: false, error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  // Private (it holds the token) and whole or not at all: the hub and the
  // connector read it to find this daemon.
  store.writeJsonAtomic(path.join(DIR, 'daemon.json'), { port: server.address().port, token: TOKEN, pid: process.pid, version: VERSION }, { mode: 0o600, space: 0 });
  console.log(`[claude-daemon] ${VERSION} listening on 127.0.0.1:${server.address().port} (${DIR})`);
});

function shutdown() {
  store.flushAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
