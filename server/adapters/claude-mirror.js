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
import { sanitizeBrokerResult } from './broker-result.js';

export const live = true;
export const AGENT = { id: 'claude', name: 'Claude', type: 'claude', enabled: true };
export { hostFor };

// A conversation the hub only discovered (a daemon's own, or one started by
// another runtime) is a 子session; an existing node's origin is never
// rewritten by a sync. /fork from the Hub keeps the source's category.
const originOf = (s) => (s?.origin === 'external' ? 'external' : 'hub');

let liveContext = null; // injected by the runner
export function init(makeContext) {
  liveContext = makeContext;
}

const daemonSeq = new Map(); // session id -> last daemon seq applied
const syncing = new Map(); // session id -> snapshot in flight
const held = new Map(); // session id -> stream messages that came while a snapshot was on its way
const sentAt = new Map(); // session id -> daemon seq when a message was last sent (older states are stale)
const completedAt = new Map(); // session id -> daemon seq of the latest native turn_end

export function available() {
  return account.apiKey() ? { ok: true } : { ok: false, reason: account.keyProblem() || '還沒有設定 Claude API key' };
}

export function cannotSend(session) {
  if (!account.apiKey()) return account.keyProblem() || '還沒有設定 Claude API key：在左下角「⋯」→「Claude API…」貼上 Claude Console 的 API key（sk-ant-…）。';
  const m = session?.machineId && machines.getMachine(session.machineId);
  if (session?.machineId && !m?.online) return `「${m?.name || '那台電腦'}」目前離線。Claude 在那台電腦上照常工作，連接器連上後就能從這裡操作。`;
  return null;
}

// The key and Claude settings go along with what may call the API: the
// daemon keeps them, so it can go on while the hub is closed. A node's
// subagent default rides along too (the Hub owns it), so a change made while
// nothing is running is in the daemon before its next Task.
const auth = (session = null) => ({ apiKey: account.apiKey() || undefined, settings: account.settings(), ...(session ? { subagent: session.meta?.subagent ?? null } : {}) });
const call = (session, op, args = {}, timeoutMs = 120_000) => link.rpc(session.machineId || null, op, { id: session.id, ...args, auth: auth(session) }, timeoutMs);
const machineName = (session) => (session.machineId ? machines.getMachine(session.machineId)?.name || '那台電腦' : os.hostname());

// --------------------------------------------------------------- mirror

// session.meta is shared: the daemon writes most of it, the Hub writes some.
// A sync takes the daemon's fields and keeps the Hub's own, whatever the
// daemon's copy says. Who writes what (grep of every `meta` write in server/):
//
//   Hub-owned: written by the Hub only. The daemon neither needs nor owns them,
//   but may hold a stale copy from an earlier hand-over of the Hub's meta.
//     salvaged       store.js rescueSession: the note of a repaired conversation file
//     pendingSwitch  runner.js setPending / clearPending: the switch scheduled for
//                    the end of the running turn
//     turnProvider   runner.js snapshotTurn: the provider the running turn uses;
//                    cleared here when the turn ends (apply, onEvent turn_end), as
//                    the Kimi adapter clears it, so an old value is not kept for
//                    ever. Cleared on every sign that a turn ended, even one that
//                    is a moment late for the turn after it: a missing note shows
//                    the conversation's own provider, which for a Claude
//                    conversation is the same, while a kept one stays for good.
//     subagent       runner.js (ensureDefaultSubagent, setSubagent…): the subagent
//                    default; the Hub's copy rides along with every daemon call
//   (HUB_OWNED_META lists the first three; `subagent` has the rule below.)
//
//   Written here on every sync, from what the Hub knows: machineName.
//
//   Daemon-owned: everything else, taken from the daemon. Today (adapters/
//   claude.js, via setMeta): agent model effort permission planMode queue todos
//   repo parent budget context models defaultModel servedModel claudeUsage tps
//   rateLimits turnModel turnEffort turnSubagent. turnModel/turnEffort/
//   turnSubagent are also pre-set by the Hub when it starts a turn (snapshotTurn);
//   the daemon runs the turn, so its values win. A field only a newer daemon has
//   still arrives: the daemon's side is open, the Hub's is the closed list.
//
// A Hub-owned field the Hub does not have is not in the result, whatever the
// daemon holds (its copy is stale: the Hub cleared it). `adopt` is for a
// conversation the Hub did not know: the daemon's copy, whole.
export const HUB_OWNED_META = ['salvaged', 'pendingSwitch', 'turnProvider'];
export function mirrorMeta(session, meta, { adopt = false } = {}) {
  const out = { ...(meta || {}) };
  if (adopt) return out;
  const hub = session.meta || {};
  for (const key of HUB_OWNED_META) {
    if (Object.hasOwn(hub, key)) out[key] = hub[key];
    else delete out[key];
  }
  // The subagent default: a daemon summary must not undo a change made in the
  // Hub while nothing was running. Only a real (non-null) Hub value is kept.
  if (Object.hasOwn(hub, 'subagent') && hub.subagent != null) out.subagent = hub.subagent;
  else delete out.subagent;
  return out;
}

// A daemon's copy of a conversation taken over (exported for the tests).
export { apply as applySnapshot };
function apply(session, snap, opts = {}) {
  const ctx = liveContext(session);
  daemonSeq.set(session.id, snap.seq || 0);
  session.cwd = snap.cwd || session.cwd;
  session.usage = snap.usage || session.usage;
  session.allowedTools = snap.allowedTools || [];
  if (snap.title && snap.title !== session.title) ctx.setTitle(snap.title);
  const events = snap.events || [];
  const end = events.at(-1);
  const terminal = end?.type === 'turn_end' ? end : null;
  if (terminal) completedAt.set(session.id, snap.seq || 0);
  else completedAt.delete(session.id);
  ctx.replaceEvents(events);
  session.meta = mirrorMeta(session, { ...(snap.meta || {}), machineName: machineName(session) }, opts);
  ctx.setStatus(terminal ? (terminal.error ? 'error' : 'idle') : snap.status || 'idle');
  // A turn that ended while the Hub was not looking (it was stopped, or the
  // stream broke) leaves its note behind otherwise.
  ctx.setMeta(terminal ? { turnProvider: null } : {});
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
// id -> machineId | null. A list that is there but cannot be used is kept as it
// is (readJsonConfig copies a damaged one into damaged-config) and said so; it
// is not written over what could not be read, or could not be copied away.
let goneWritable = true;
const gone = (() => {
  const r = store.readJsonConfig(GONE_FILE);
  if (r.state === 'ok') return new Map(Object.entries(r.value));
  const effect = '以前刪掉的 Claude 對話，如果背景程式（daemon）裡還留著，可能會重新出現在側欄，需要再刪一次。';
  if (r.state === 'damaged') {
    goneWritable = !r.backupError;
    console.warn(`[claude] ${GONE_FILE} 損壞（${r.reason}）。${r.backupPath ? `原檔已原封不動備份到 ${r.backupPath}。` : `原檔沒能備份（${r.backupError.message}），這次不會改寫它。`}已刪除的對話清單這次是空的：${effect}`);
  } else if (r.state === 'unreadable') {
    goneWritable = false;
    console.warn(`[claude] 讀不到 ${GONE_FILE}（${r.error.code || r.error.message}）。已刪除的對話清單這次是空的，為了不蓋掉它，這次不會寫入：${effect}`);
  }
  return new Map();
})();
const saveGone = () => {
  if (!goneWritable) return;
  try {
    store.writeJsonAtomic(GONE_FILE, Object.fromEntries([...gone].slice(-2000)), { space: 0 });
  } catch (err) {
    console.warn(`[claude] 已刪除的對話清單沒寫進 ${GONE_FILE}（${err.message}）`);
  }
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
    const s = store.createSession({ id: sid, agentId: AGENT.id, cwd: snap.cwd, title: snap.title || '新對話', titled: true, origin: 'external', ...(machineId ? { machineId } : {}) });
    apply(s, snap, { adopt: true });
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
    session.meta = mirrorMeta(session, { ...(x.meta || {}), machineName: machineName(session) });
    if (x.title && x.title !== session.title) ctx.setTitle(x.title);
    // A status said before the last message was sent is not how things are now.
    const completed = completedAt.get(session.id);
    const stale = completed != null && ['running', 'awaiting_permission'].includes(x.status) && (msg.seq ?? -1) <= completed;
    if (!stale && (msg.seq ?? -1) >= (sentAt.get(session.id) ?? 0)) ctx.setStatus(x.status);
    ctx.setMeta({});
    return;
  }
  if (msg.t === 'deleted') return;
  // A gap (or a reset): take a fresh copy instead.
  const last = daemonSeq.get(session.id);
  if (msg.t === 'reset' || last == null || msg.seq !== last + 1) return void sync(session).catch(() => {});
  daemonSeq.set(session.id, msg.seq);
  if (msg.t === 'event') {
    if (msg.ev?.type === 'turn_end') {
      completedAt.set(session.id, msg.seq || 0);
      ctx.setStatus(msg.ev.error ? 'error' : 'idle');
      ctx.setMeta({ turnProvider: null });
    }
    ctx.insert(msg.ev);
    // A cross-provider Task the daemon is waiting on: run it through the
    // Hub's broker, then answer the daemon. Never on a replayed snapshot:
    // a request whose turn is gone must not start a child conversation.
    if (msg.ev?.type === 'info' && msg.ev.broker?.kind === 'delegate') {
      queueMicrotask(() => handleBrokerRequest(session, msg.ev).catch((err) => console.warn(`[claude] broker ${session.id}: ${err.message}`)));
    }
    // The daemon ended the turn (guard, stop, silence) while a child was
    // running for it: stop that child.
    if (msg.ev?.type === 'info' && msg.ev.broker?.kind === 'cancel') {
      queueMicrotask(() => handleBrokerCancel(session, msg.ev).catch((err) => console.warn(`[claude] broker cancel ${session.id}: ${err.message}`)));
    }
    return;
  }
  const ev = findEvent(session, msg.id);
  if (!ev) return void sync(session).catch(() => {});
  if (msg.t === 'patch') ctx.patch(ev, msg.fields);
  else if (msg.t === 'delta') ctx.delta(ev, msg.text, msg.field);
}
link.setHandler(onEvent);

// ------------------------------------------------ cross-provider Task (broker)

const HEARTBEAT_MS = 10_000; // how often the Hub tells the daemon a child is still being worked on
let brokerRun = null; // the Hub's runner.delegateToProvider, when registered
const brokerSeen = new Map(); // session id + request id -> when it was seen

// The runner registers this at startup (avoids an import cycle); without it
// the runner is imported when the first request arrives. A broker that is
// not there is an error for that Task, never a reason to run it on Claude.
export function setBroker(fn) {
  brokerRun = typeof fn === 'function' ? fn : null;
}

function brokerSeenRecently(key) {
  const now = Date.now();
  for (const [k, at] of brokerSeen) if (now - at > 10 * 60_000) brokerSeen.delete(k);
  if (brokerSeen.has(key)) return true;
  brokerSeen.set(key, now);
  return false;
}

// Only these fields go to the daemon; nothing else (and no token or key).
const brokerResultForDaemon = (input) => sanitizeBrokerResult(input, { cutBy: 'the Hub' });

async function defaultBroker(session, request) {
  const mod = await import('../runner.js');
  if (typeof mod.delegateToProvider !== 'function') throw new Error('Hub 的 broker 尚未實作（runner.delegateToProvider），這次跨家子代理沒有執行');
  return mod.delegateToProvider(session, request);
}

// `deps` exists for the tests: `{ send, delegate }`; `delegate: null` means
// there is no broker at all. Everything else uses the real link and runner.
export async function handleBrokerRequest(session, ev, deps = {}) {
  const b = ev?.broker;
  if (!b || b.kind !== 'delegate' || !b.requestId) return false;
  const key = `${session.id}:${b.requestId}`;
  if (brokerSeenRecently(key)) return false;
  // A sign of life carries no settings: it must be quick and change nothing.
  const send = deps.send || ((op, args) => link.rpc(session.machineId || null, op, op === 'brokerAck' ? { ...args } : { ...args, auth: auth(session) }));
  // Tell the daemon at once that the request is here, and again while the
  // child works: "the Hub is not there" and "the child is still working" are
  // different things, and only the first may end the daemon's wait.
  const ack = () => send('brokerAck', { id: session.id, requestId: b.requestId }).catch(() => {});
  ack();
  const beat = setInterval(ack, deps.heartbeatMs || HEARTBEAT_MS);
  beat.unref?.();
  let result;
  try {
    const parent = session.events.find((e) => e.id === b.parentEventId);
    const task = typeof parent?.input?.prompt === 'string' ? parent.input.prompt : '';
    if (!task) throw new Error('找不到子代理的任務內容（parent tool event 不見了），這次跨家子代理沒有執行');
    const delegate = deps.delegate === null ? null : deps.delegate || brokerRun || defaultBroker;
    if (!delegate) throw new Error('Hub 的 broker 尚未接上（runner.delegateToProvider），這次跨家子代理沒有執行');
    result = await delegate(session, {
      provider: b.provider,
      model: b.model,
      effort: b.effort,
      task,
      parentEventId: b.parentEventId,
      token: typeof session.state?.delegationToken === 'string' ? session.state.delegationToken : undefined,
    });
  } catch (err) {
    result = { error: err?.message || String(err) };
  } finally {
    clearInterval(beat);
  }
  try {
    await send('brokerResult', { id: session.id, requestId: b.requestId, result: brokerResultForDaemon(result) });
  } catch (err) {
    console.warn(`[claude] broker result ${session.id}: ${err.message}`);
  }
  return true;
}

// The daemon cancelled a request (or gave up on it): the child the Hub
// started for it must not go on running unseen.
export async function handleBrokerCancel(session, ev, deps = {}) {
  const b = ev?.broker;
  if (!b || b.kind !== 'cancel' || !b.parentEventId) return false;
  const cancel = deps.cancel || (async (s, id) => (await import('../runner.js')).cancelDelegation(s, id));
  return cancel(session, b.parentEventId);
}

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

// ------------------------------------------------------------ capabilities
//
// A daemon older than this Hub accepts a field it does not know and ignores
// it (a handoff that never reaches Claude, a subagent default that is never
// used), so the Hub asks what the daemon can do before it sends anything that
// depends on it, and refuses with an upgrade message instead of pretending.

const capCache = new Map(); // machine id | 'local' -> { at, caps }
const CAP_TTL_MS = 30_000;

export async function daemonCapabilities(machineId, { fresh = false } = {}) {
  const key = machineId || 'local';
  const hit = capCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CAP_TTL_MS) return hit.caps;
  let caps;
  try {
    const r = await link.rpc(machineId || null, 'capabilities', {}, 15_000);
    caps = new Set(Array.isArray(r?.capabilities) ? r.capabilities.map(String) : []);
  } catch (err) {
    // A daemon that does not know the question is the old kind: no
    // capabilities. Anything else (offline, timeout) is not an answer.
    if (!/不認得這個操作|未知的操作/.test(err.message || '')) throw err;
    caps = new Set();
  }
  capCache.set(key, { at: Date.now(), caps });
  return caps;
}

export const forgetCapabilities = (machineId) => (machineId === undefined ? capCache.clear() : capCache.delete(machineId || 'local'));

function daemonOld(session, what, missing) {
  return Object.assign(new Error(`「${machineName(session)}」的 Claude 背景程式太舊，沒有${what}（缺少：${missing.join('、')}）。在那台電腦重新執行連接指令（左下角「連接電腦…」）更新後再試。`), { status: 409, code: 'daemon_old' });
}

// What the daemon must be able to do to honour this conversation's subagent
// setting: the setting itself, and the broker for another provider's.
const subagentNeeds = (sub) => (sub ? ['subagent_config', ...(sub.provider === 'claude' ? [] : ['broker'])] : []);

/** { ok, missing } for the conversation's subagent setting on its daemon. */
export async function subagentSupport(session) {
  const needs = subagentNeeds(session.meta?.subagent);
  if (!needs.length) return { ok: true, missing: [] };
  const have = await daemonCapabilities(session.machineId || null);
  const missing = needs.filter((c) => !have.has(c));
  return { ok: !missing.length, missing };
}

// ----------------------------------------------------------- lifecycle

// A new conversation, made in the daemon of its computer.
export async function create(session, config = {}) {
  // Nothing that depends on a newer daemon is sent to an older one. A choice
  // the user made is refused; the unmarked default is left out and said so.
  const sub = session.meta?.subagent ?? null;
  const explicit = session.state?.subagentExplicit === true;
  const have = config.handoff || sub ? await daemonCapabilities(session.machineId || null) : new Set();
  if (config.handoff && !have.has('handoff')) throw daemonOld(session, '接續歷史的功能', ['handoff']);
  const support = sub ? await subagentSupport(session) : { ok: true, missing: [] };
  if (sub && !support.ok && explicit) throw daemonOld(session, `${sub.provider} 子代理的功能`, support.missing);
  const sendSub = sub && support.ok ? sub : null;
  // A GitHub repository is cloned first: that may take minutes. The node's
  // subagent default travels with the create so the daemon's meta starts
  // right (the auth below covers later calls).
  const snap = await call(session, 'create', { cwd: session.cwd, title: session.title, permissionMode: session.permissionMode, config: { ...config, computer: machineName(session), subagent: sendSub } }, config.repo ? 660_000 : 120_000);
  // The daemon says what it kept. A handoff that is not in what came back
  // never reached Claude: that is an error, not a conversation that has
  // silently forgotten its history.
  if (config.handoff && !(snap?.events || []).some((e) => e.type === 'info' && e.handoff)) {
    throw Object.assign(new Error(`「${machineName(session)}」的 Claude 背景程式沒有接下前段歷史（回應裡沒有接續紀錄），已停止，沒有把歷史丟掉。請更新那台電腦的連接器後再試。`), { status: 502, code: 'handoff_not_landed' });
  }
  apply(session, snap);
  if (sub && !support.ok) {
    liveContext(session).emit({ type: 'info', text: `這台電腦的 Claude 背景程式太舊（缺少：${support.missing.join('、')}），無法套用子代理預設（${sub.provider} · ${sub.model}）；這個對話的子代理（Task）會用 Claude 的原生規則。要套用請在那台電腦重新執行連接指令更新。`, subagentNotice: { code: 'daemon_old', scope: 'conversation' } });
  }
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
  import('../subagent-policy.js').then((p) => p.refreshSoon(session)).catch(() => {});
}

export function dispose(session) {
  gone.set(session.id, session.machineId || null);
  saveGone();
  forget(session.machineId || null, session.id);
  daemonSeq.delete(session.id);
  completedAt.delete(session.id);
}

// ------------------------------------------------------------- forwards

export async function send(session, text, { images = [], note, steer } = {}) {
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  // A subagent the user chose rides along with every call; an older daemon
  // would take the message and ignore it.
  if (session.meta?.subagent && session.state?.subagentExplicit === true) {
    const support = await subagentSupport(session);
    if (!support.ok) throw daemonOld(session, `${session.meta.subagent.provider} 子代理的功能`, support.missing);
  }
  // Working from now on, as far as anyone looking can tell (the daemon's own
  // word follows).
  const completed = completedAt.get(session.id);
  completedAt.delete(session.id);
  if (session.status !== 'awaiting_permission') liveContext(session).setStatus('running');
  sentAt.set(session.id, Infinity);
  try {
    if (!daemonSeq.has(session.id)) await sync(session);
    const r = await call(session, 'send', { text, images, note, steer });
    sentAt.set(session.id, r?.seq ?? 0);
    if (r?.status && (daemonSeq.get(session.id) ?? -1) <= r.seq) liveContext(session).setStatus(r.status);
    return r;
  } catch (err) {
    if (completed != null) completedAt.set(session.id, completed);
    sentAt.delete(session.id);
    throw err;
  }
}
export const interrupt = (session) => call(session, 'interrupt');
export const respond = (session, eventId, optionId, extra) => call(session, 'respond', { eventId, optionId, extra });
export async function configure(session, change) {
  if (change && 'subagent' in change && change.subagent) {
    const have = await daemonCapabilities(session.machineId || null);
    const missing = subagentNeeds(change.subagent).filter((c) => !have.has(c));
    if (missing.length) throw daemonOld(session, `${change.subagent.provider} 子代理的功能`, missing);
  }
  return call(session, 'configure', { change });
}
export const steerQueued = (session, promptId) => call(session, 'steerQueued', { promptId });
// In the daemon, whose queue is the one that counts (the hub's copy may lag).
export const steerAll = (session) => call(session, 'steerAll');
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
  const copy = store.getSession(snap.id) || store.createSession({ id: snap.id, agentId: AGENT.id, cwd: snap.cwd, title: snap.title, titled: true, origin: originOf(session), ...(session.machineId ? { machineId: session.machineId } : {}) });
  apply(copy, snap, { adopt: true });
  return { session: copy };
}

// Files and changes: read on the conversation's computer.
export const listFiles = remoteListFiles;
export const readFile = remoteReadFile;
export const getChanges = remoteGetChanges;
