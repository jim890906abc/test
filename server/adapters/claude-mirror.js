// Claude conversations as the hub sees them: mirrors of the conversations a
// Claude daemon runs (server/claude-daemon.js) — on this computer, or on a
// connected one (session.machineId). The daemon runs Claude on its own, so
// it keeps working while the hub is closed; the hub forwards what you do
// (send, stop, approve, settings, commands) and follows what happens, as it
// does for Kimi. A conversation the hub ran itself before there were
// daemons moves into this computer's (or its computer's) daemon.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as machines from '../machines.js';
import * as account from '../claude-account.js';
import * as link from '../claude-link.js';
import { hostFor, listFiles as remoteListFiles, readFile as remoteReadFile, getChanges as remoteGetChanges } from './claude.js';

export const live = true;
export const AGENT = { id: 'claude', name: 'Claude', type: 'claude', enabled: true };
export { hostFor };

let liveContext = null; // injected by the runner
export function init(makeContext) {
  liveContext = makeContext;
}

const daemonSeq = new Map(); // session id -> last daemon seq applied
const syncing = new Map(); // session id -> snapshot in flight
const held = new Map(); // session id -> stream messages that came while a snapshot was on its way
const sentAt = new Map(); // session id -> daemon seq when a message was last sent (older states are stale)

export function available() {
  return account.apiKey() ? { ok: true } : { ok: false, reason: '還沒有設定 Claude API key' };
}

export function cannotSend(session) {
  if (!account.apiKey()) return '還沒有設定 Claude API key：在左下角「⋯」→「Claude API…」貼上 Claude Console 的 API key（sk-ant-…）。';
  const m = session?.machineId && machines.getMachine(session.machineId);
  if (session?.machineId && !m?.online) return `「${m?.name || '那台電腦'}」目前離線。Claude 在那台電腦上照常工作，連接器連上後就能從這裡操作。`;
  return null;
}

// The key and Claude settings go along with what may call the API: the
// daemon keeps them, so it can go on while the hub is closed.
const auth = () => ({ apiKey: account.apiKey() || undefined, settings: account.settings() });
const call = (session, op, args = {}, timeoutMs = 120_000) => link.rpc(session.machineId || null, op, { id: session.id, ...args, auth: auth() }, timeoutMs);
const machineName = (session) => (session.machineId ? machines.getMachine(session.machineId)?.name || '那台電腦' : os.hostname());

// --------------------------------------------------------------- mirror

// The daemon's copy, taken over whole.
function apply(session, snap) {
  const ctx = liveContext(session);
  daemonSeq.set(session.id, snap.seq || 0);
  session.cwd = snap.cwd || session.cwd;
  session.usage = snap.usage || session.usage;
  session.allowedTools = snap.allowedTools || [];
  if (snap.title && snap.title !== session.title) ctx.setTitle(snap.title);
  ctx.replaceEvents(snap.events || []);
  session.meta = { ...(snap.meta || {}), machineName: machineName(session) };
  ctx.setStatus(snap.status || 'idle');
  ctx.setMeta({});
}

// A fresh copy. The stream and the copy come on different connections:
// what the stream brings meanwhile is held, then whatever is newer than the
// copy is applied after it.
async function sync(session) {
  if (syncing.has(session.id)) return syncing.get(session.id);
  held.set(session.id, []);
  const p = (async () => {
    try {
      apply(session, await call(session, 'snapshot'));
    } catch (err) {
      if (err.status === 404 && session.state?.claude?.messages) return migrate(session);
      throw err;
    }
  })().finally(() => {
    syncing.delete(session.id);
    const later = held.get(session.id) || [];
    held.delete(session.id);
    for (const msg of later) if (msg.t === 'session' || msg.seq > (daemonSeq.get(session.id) ?? -1)) onEvent(session.machineId || null, msg);
  });
  syncing.set(session.id, p);
  return p;
}

// A conversation the hub ran itself: handed to the daemon, with everything
// it had (history, events, settings), then followed like the others.
async function migrate(session) {
  const { id, title, titled, cwd, permissionMode, allowedTools, events, meta, usage, createdAt, updatedAt, state } = session;
  const snap = await call(session, 'import', { session: { id, title, titled, cwd, permissionMode, allowedTools, events, meta, usage, createdAt, updatedAt, state: { claude: state.claude } } });
  session.state = { ...session.state, claude: undefined };
  apply(session, snap);
}

// Conversations a daemon has that the hub does not (yet): started by Claude
// itself (StartConversation), or while the hub was away. Shown like the
// others, as Kimi's are.
const adopting = new Set();
// Deleted here: never taken back, and deleted in the daemon once it can be
// reached (its computer may have been off). Kept on disk.
const GONE_FILE = path.join(store.DATA_DIR, 'claude-deleted.json');
const gone = (() => {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(GONE_FILE, 'utf8'))));
  } catch {
    return new Map(); // id -> machineId | null
  }
})();
const saveGone = () => {
  try {
    fs.writeFileSync(GONE_FILE, JSON.stringify(Object.fromEntries([...gone].slice(-2000))));
  } catch {}
};
function forget(machineId, id) {
  link.rpc(machineId, 'delete', { id, auth: auth() }).then(
    () => {
      gone.delete(id);
      saveGone();
    },
    () => {},
  );
}
async function adopt(machineId, sid) {
  if (adopting.has(sid) || gone.has(sid) || store.getSession(sid)) return;
  adopting.add(sid);
  try {
    const snap = await link.rpc(machineId, 'snapshot', { id: sid, auth: auth() });
    if (store.getSession(sid) || gone.has(sid)) return;
    const s = store.createSession({ id: sid, agentId: AGENT.id, cwd: snap.cwd, title: snap.title || '新對話', titled: true, ...(machineId ? { machineId } : {}) });
    apply(s, snap);
  } catch (err) {
    console.warn(`[claude] ${sid}: ${err.message}`);
  } finally {
    adopting.delete(sid);
  }
}
async function adoptAll(machineId) {
  try {
    for (const x of await link.rpc(machineId, 'list', { auth: auth() })) {
      if (gone.has(x.id)) forget(machineId, x.id);
      else adopt(machineId, x.id);
    }
  } catch {}
}

// One message of a daemon's stream.
function onEvent(machineId, msg) {
  if (msg.t === 'resync') {
    for (const s of store.listSessions()) if (s.agentId === AGENT.id && (s.machineId || null) === machineId) sync(s).catch(() => {});
    adoptAll(machineId);
    return;
  }
  const session = store.getSession(msg.sid);
  if (!session && msg.t === 'session') return void adopt(machineId, msg.sid);
  if (!session || session.agentId !== AGENT.id || (session.machineId || null) !== machineId) return;
  if (syncing.has(session.id) && msg.t !== 'deleted') return void held.get(session.id)?.push(msg);
  const ctx = liveContext(session);
  if (msg.t === 'session') {
    const x = msg.session;
    session.usage = x.usage || session.usage;
    session.allowedTools = x.allowedTools || session.allowedTools;
    session.meta = { ...(x.meta || {}), machineName: machineName(session) };
    if (x.title && x.title !== session.title) ctx.setTitle(x.title);
    // A status said before the last message was sent is not how things are now.
    if ((msg.seq ?? -1) >= (sentAt.get(session.id) ?? 0)) ctx.setStatus(x.status);
    ctx.setMeta({});
    return;
  }
  if (msg.t === 'deleted') return;
  // A gap (or a reset): take a fresh copy instead.
  const last = daemonSeq.get(session.id);
  if (msg.t === 'reset' || last == null || msg.seq !== last + 1) return void sync(session).catch(() => {});
  daemonSeq.set(session.id, msg.seq);
  if (msg.t === 'event') return void ctx.insert(msg.ev);
  const ev = findEvent(session, msg.id);
  if (!ev) return void sync(session).catch(() => {});
  if (msg.t === 'patch') ctx.patch(ev, msg.fields);
  else if (msg.t === 'delta') ctx.delta(ev, msg.text, msg.field);
}
link.setHandler(onEvent);

function findEvent(session, id) {
  const evs = session.events;
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].id === id) return evs[i];
  return null;
}

// A connected computer came (back): catch up with its conversations.
machines.onBridgeHello((machineId) => {
  const mine = store.listSessions().filter((s) => s.agentId === AGENT.id && s.machineId === machineId);
  for (const s of mine) sync(s).catch((err) => console.warn(`[claude] ${s.id}: ${err.message}`));
  // Conversations that computer keeps but the hub does not know, if any
  // (the bridge says how many; older ones do not say).
  const m = machines.getMachine(machineId);
  if (m?.claudeSessions > mine.length || (!m?.claudeSessions && /^0\.5\./.test(m?.bridgeVersion || ''))) adoptAll(machineId);
});

// At hub start: this computer's daemon, if it has conversations, so they
// all show (also those the hub does not know) and go on.
export function start() {
  try {
    if (!fs.readdirSync(path.join(store.DATA_DIR, 'claude-daemon', 'sessions')).some((f) => f.endsWith('.json'))) return;
  } catch {
    return;
  }
  link.startLocal().catch((err) => console.warn(`[claude] ${err.message}`));
}

// ----------------------------------------------------------- lifecycle

// A new conversation, made in the daemon of its computer.
export async function create(session, config = {}) {
  // A GitHub repository is cloned first: that may take minutes.
  apply(session, await call(session, 'create', { cwd: session.cwd, title: session.title, permissionMode: session.permissionMode, config: { ...config, computer: machineName(session) } }, config.repo ? 660_000 : 120_000));
}

// At hub start: this computer's daemon is started (its conversations went
// on while the hub was closed) and every conversation catches up.
export function restore(session) {
  if (session.machineId) return; // when its bridge says hello
  link
    .startLocal()
    .then(() => sync(session))
    .catch((err) => console.warn(`[claude] ${session.id}: ${err.message}`));
}

export function view(session) {
  if (!daemonSeq.has(session.id) && !syncing.has(session.id)) sync(session).catch(() => {});
}

export function dispose(session) {
  gone.set(session.id, session.machineId || null);
  saveGone();
  forget(session.machineId || null, session.id);
  daemonSeq.delete(session.id);
}

// ------------------------------------------------------------- forwards

export async function send(session, text, { images = [], note, steer } = {}) {
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  // Working from now on, as far as anyone looking can tell (the daemon's own
  // word follows).
  if (session.status !== 'awaiting_permission') liveContext(session).setStatus('running');
  sentAt.set(session.id, Infinity);
  try {
    if (!daemonSeq.has(session.id)) await sync(session);
    const r = await call(session, 'send', { text, images, note, steer });
    sentAt.set(session.id, r?.seq ?? 0);
    if (r?.status && (daemonSeq.get(session.id) ?? -1) <= r.seq) liveContext(session).setStatus(r.status);
    return r;
  } catch (err) {
    sentAt.delete(session.id);
    throw err;
  }
}
export const interrupt = (session) => call(session, 'interrupt');
export const respond = (session, eventId, optionId, extra) => call(session, 'respond', { eventId, optionId, extra });
export const configure = (session, change) => call(session, 'configure', { change });
export const steerQueued = (session, promptId) => call(session, 'steerQueued', { promptId });
export const cancelQueued = (session, promptId) => call(session, 'cancelQueued', { promptId });
export const setTitle = (session, title) => call(session, 'title', { title });

// An existing conversation bound to a GitHub repository (it may move to a
// new clone: its folder comes with the fresh copy taken after).
export async function bindRepo(session, repo) {
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  try {
    await call(session, 'bindRepo', { repo }, 660_000);
  } catch (err) {
    if (/不認得這個操作/.test(err.message)) throw Object.assign(new Error('Claude 背景程式還是舊版（有對話正在執行，它要等都閒下來才會更新）。等對話都跑完、過一分鐘後再試。'), { status: 409 });
    throw err;
  }
  await sync(session);
}

export async function command(session, name, args = '') {
  const r = (await call(session, 'command', { name, args })) || {};
  // What it changed (/undo, /compact…) is here before this returns.
  await sync(session).catch(() => {});
  if (!r.session) return {};
  // /fork: a new conversation in the same daemon, mirrored here too.
  const snap = r.session;
  const copy = store.getSession(snap.id) || store.createSession({ id: snap.id, agentId: AGENT.id, cwd: snap.cwd, title: snap.title, titled: true, ...(session.machineId ? { machineId: session.machineId } : {}) });
  apply(copy, snap);
  return { session: copy };
}

// Files and changes: read on the conversation's computer.
export const listFiles = remoteListFiles;
export const readFile = remoteReadFile;
export const getChanges = remoteGetChanges;
