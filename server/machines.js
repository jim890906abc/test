// Machines connected through the bridge (bridge/agent-hub-bridge.mjs).
// Each bridge holds one WebSocket to the hub; the hub sends requests over it
// ({ t: 'req' }) and the bridge pushes Kimi events and session lists back.
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, findByNative, leafOf, chainOf, writeJsonAtomic, readJsonConfig, backupConfigCopy } from './store.js';

const FILE = path.join(DATA_DIR, 'machines.json');

// What a connector says it can do, in its hello: `capabilities`, an array of
// these names (a connector lists only what that version really supports).
//   pool             DeepSeek key pool through the loopback proxy
//   secondary_model  can set/repair the native subagent default ([secondary_model])
//   broker           cross-provider subagents through the local broker channel
//   handoff          relays a continuation's handoff to the Claude daemon, and
//                    refuses to use a daemon that cannot take it
// A connector that sends no `capabilities` has none (an empty array): the
// version string is never used to guess. The first connector that sends the
// field is CAPABILITY_CONNECTOR_VERSION; older ones must be reconnected with
// the current command (a message about "upgrade" can name this version).
export const CAPABILITIES = ['pool', 'secondary_model', 'broker', 'handoff'];
export const CAPABILITY_CONNECTOR_VERSION = '0.11.0';
const cleanCapabilities = (raw) => (Array.isArray(raw) ? [...new Set(raw.filter((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(x)))].slice(0, 16) : []);
const machines = new Map(); // id -> machine
const listeners = new Set(); // (machineId, frame) => void   for Kimi events
const onlineListeners = new Set(); // (machineId) => void
const sessionListeners = new Set(); // (machineId, entry) => void
const streams = new Map(); // stream id -> (chunk) => void   (a command's output as it comes)
const messageListeners = new Set(); // (machineId, msg) => void   for every other message
const helloListeners = new Set(); // (machineId) => void   a bridge (re)connected
const kimiServerListeners = new Set(); // (machineId) => void   Kimi's server came up on a machine (it was not up)
const sessionsListeners = new Set(); // (machineId) => void   the machine's session list arrived
const bridgeRequest = { fn: null }; // (machineId, msg) => Promise<data>   broker/hook
let broadcast = () => {};

export function setBroadcast(fn) {
  broadcast = fn;
}
export function onKimiEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onMachineOnline(fn) {
  onlineListeners.add(fn);
}
export function onSessionChange(fn) {
  sessionListeners.add(fn);
}
export function onBridgeMessage(fn) {
  messageListeners.add(fn);
}
export function onBridgeHello(fn) {
  helloListeners.add(fn);
}
export function onKimiServer(fn) {
  kimiServerListeners.add(fn);
}
export function onSessionsListed(fn) {
  sessionsListeners.add(fn);
}

// Whether the machine has said which of its conversations are working since
// it connected. Right after a connect it has not: a conversation that looks
// idle then may be mid-turn on Kimi's side. A bridge that never says (an old
// one) is taken at its word after a while rather than waited on for ever.
export const SESSIONS_WAIT_MS = 10_000;
export function sessionsKnown(machineId) {
  const m = machines.get(machineId);
  return Boolean(m && (m.sessionsKnown || Date.now() - (m.helloAt || 0) > SESSIONS_WAIT_MS));
}
export function onBridgeRequest(fn) {
  bridgeRequest.fn = fn;
}

// The registered computers, as they were when the Hub last stopped. A file
// that is there but cannot be used is kept as it is (readJsonConfig copies a
// damaged one into damaged-config) and said so; the list then starts empty and
// each connector registers again when it says hello. Nothing is written over
// what could not be read, or could not be copied away first.
let persistBlocked = false;
(() => {
  const r = readJsonConfig(FILE, { shape: 'array' });
  if (r.state === 'ok') {
    const usable = r.value.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id);
    for (const m of usable) machines.set(m.id, { ...m, online: false, ws: null, pending: new Map() });
    if (usable.length !== r.value.length) {
      const c = backupConfigCopy(FILE, r.raw);
      persistBlocked = Boolean(c.backupError);
      console.warn(`[machines] ${FILE} 裡有 ${r.value.length - usable.length} 筆不是電腦的資料，已略過，其餘 ${usable.length} 台照常載入。${c.backupPath ? `原檔已原封不動備份到 ${c.backupPath}。` : `原檔沒能備份（${c.backupError.message}），這次不會改寫它。`}`);
    }
  } else if (r.state === 'damaged') {
    persistBlocked = Boolean(r.backupError);
    console.warn(`[machines] ${FILE} 損壞（${r.reason}）。${r.backupPath ? `原檔已原封不動備份到 ${r.backupPath}。` : `原檔沒能備份（${r.backupError.message}），這次不會改寫它。`}已登記的電腦清單這次是空的；各台電腦的連接器連上來時會再登記一次。`);
  } else if (r.state === 'unreadable') {
    persistBlocked = true;
    console.warn(`[machines] 讀不到 ${FILE}（${r.error.code || r.error.message}）。已登記的電腦清單這次是空的；為了不蓋掉它，這次不會寫入這個檔案。`);
  }
})();

function persist() {
  if (persistBlocked) return;
  // `capabilities` too: an offline machine keeps what it last said it could do
  // (replaced at its next hello) instead of looking like an old connector.
  const list = [...machines.values()].map(({ id, name, platform, home, lastSeen, kimiVersion, capabilities }) => ({ id, name, platform, home, lastSeen, kimiVersion, capabilities }));
  // Called from a bridge's message handler: a disk that will not take the
  // list must not take the Hub down with it. The list is rebuilt from the
  // connectors' hellos anyway.
  try {
    writeJsonAtomic(FILE, list);
  } catch (err) {
    console.warn(`[machines] 電腦清單沒寫進 ${FILE}（${err.message}）；各台電腦連上來時會再登記一次。`);
  }
}

export function publicMachine(m) {
  return {
    id: m.id,
    name: m.name,
    platform: m.platform,
    home: m.home,
    online: m.online,
    lastSeen: m.lastSeen,
    bridgeVersion: m.bridgeVersion,
    broker: m.broker || 0,
    pool: Number(m.pool) || 0,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    // The Claude daemon on that computer is too old for what this hub sends
    // and is waiting to be replaced (see the connector's daemon.state).
    daemonStale: Boolean(m.daemonStale),
    daemonStaleReason: m.daemonStale ? m.daemonStaleReason || '' : '',
    // The last DeepSeek provision for this machine: { ok, at, reason, ... }
    // (set by server/deepseek-account.js), null before the first one.
    provision: m.provision || null,
    kimi: m.kimi || { available: false },
    sessions: m.online ? visibleSessions(m) : [],
  };
}

export function hasCapability(machineId, name) {
  return Boolean(machines.get(machineId)?.capabilities?.includes(name));
}

// Record the outcome of the latest DeepSeek provision on the machine (null
// clears it). Not persisted: it describes this run's last attempt.
export function setProvision(machineId, provision) {
  const m = machines.get(machineId);
  if (!m) return;
  m.provision = provision || null;
  changed(m);
}

// A chain was linked or unlinked, or a conversation deleted: what the machine
// lists show (hidden old nodes, the leaf's chain fields) changes without any
// bridge message. No argument: every machine.
export function chainChanged(...nodes) {
  for (const m of machines.values()) if (!nodes.length || nodes.some((n) => n?.machineId === m.id)) changed(m);
}

export function listMachines() {
  return [...machines.values()].map(publicMachine);
}

export function getMachine(id) {
  return machines.get(id);
}

export function removeMachine(id) {
  const m = machines.get(id);
  m?.ws?.close();
  machines.delete(id);
  persist();
  broadcast({ t: 'machines' });
}

function changed(m) {
  broadcast({ t: 'machine', machine: publicMachine(m) });
}

// The machine's sessions are kept as the machine reported them. What the
// Hub knows about them (which conversation they belong to, whether they are a
// sub-agent or an old chain node) is worked out when they are read, never
// stored, so a link made or a conversation deleted a moment ago shows at once.
//   • an old node of a continuation chain, and a node still being made, are
//     not rows: the leaf stands for the conversation;
//   • a sub-agent's session carries its parent's id (and the Hub conversation
//     that owns it), whether or not the browser has that conversation;
//   • a native session the Hub archived for a deleted sub-agent stays hidden
//     even if the machine has not dropped it from its list yet.
// Pure native sessions the Hub never attached have no Hub fields.
const hiddenNatives = new Set(); // `${machineId}:${kimiSessionId}`

function chainMeta(machineId, kimiSessionId) {
  const hub = findByNative(machineId, kimiSessionId);
  if (!hub) return {};
  const leaf = leafOf(hub) || hub;
  return {
    hubSessionId: hub.id,
    conversationId: hub.conversationId || hub.id,
    continuedFrom: hub.continuedFrom || null,
    continuedTo: hub.continuedTo || null,
    leafId: leaf.id,
    isLeaf: leaf.id === hub.id && !hub.provisional,
    provisional: Boolean(hub.provisional),
    provider: hub.provider || null,
    chainLength: chainOf(leaf).length,
    parentId: hub.parentId || null,
  };
}

const sessionEntry = (s) => ({
  id: s.id,
  title: s.title || s.last_prompt || '',
  cwd: s.metadata?.cwd,
  workspaceId: s.workspace_id,
  busy: Boolean(s.busy),
  pending: s.pending_interaction || 'none',
  lastTurn: s.last_turn_reason,
  updatedAt: Date.parse(s.updated_at) || Date.now(),
  // 'tui' while a terminal Kimi runs it; controllable when that Kimi was
  // started through the bridge and accepts input from the hub.
  owner: s.owner || null,
  controllable: s.controllable ?? null,
  // Locked only because a terminal Kimi runs in the same folder.
  guess: Boolean(s.guess),
  // The model it last ran on (the bridge reads it from the journal), so the
  // sidebar can tell DeepSeek conversations apart without opening them.
  model: s.model || '',
});

const decorate = (machineId, entry) => ({ ...entry, ...chainMeta(machineId, entry.id) });
const hidden = (machineId, e) => hiddenNatives.has(`${machineId}:${e.id}`) || Boolean(e.hubSessionId && !e.isLeaf);
// The entry a browser sees, or null when it is not a row.
const shown = (machineId, entry) => {
  const e = decorate(machineId, entry);
  return hidden(machineId, e) ? null : e;
};
function visibleSessions(m) {
  return (m.sessions || []).map((entry) => shown(m.id, entry)).filter(Boolean);
}

// The Hub stopped listing these natives for good (a deleted sub-agent's
// session, archived on its machine).
export function hideNative(machineId, kimiSessionId) {
  hiddenNatives.add(`${machineId}:${kimiSessionId}`);
  const m = machines.get(machineId);
  if (m) changed(m);
}

function sessionChanged(m, entry) {
  broadcast({ t: 'kimi.session', machineId: m.id, session: entry });
  for (const fn of sessionListeners) fn(m.id, entry);
}

// Kimi pushes session-level changes (busy, waiting for approval, title, new
// or archived sessions) to every connection. Apply them to the machine's
// session list right away so the sidebar never waits for a refresh.
function trackSession(m, frame) {
  const p = frame.payload || {};
  const id = frame.session_id || p.sessionId || p.session?.id;
  if (!id) return;
  const list = (m.sessions ??= []);
  let entry = list.find((s) => s.id === id);
  switch (frame.type) {
    case 'event.session.created':
      if (!entry && p.session) list.unshift(sessionEntry(p.session));
      else return;
      break;
    case 'event.session.archived':
    case 'event.session.deleted':
      if (!entry) return;
      m.sessions = list.filter((s) => s.id !== id);
      broadcast({ t: 'kimi.session', machineId: m.id, id, removed: true });
      return;
    case 'event.session.work_changed':
      if (!entry) return;
      Object.assign(entry, { busy: Boolean(p.busy), pending: p.pending_interaction || 'none', lastTurn: p.last_turn_reason ?? entry.lastTurn, updatedAt: Date.now() });
      break;
    case 'session.meta.updated':
      if (!entry || !(p.title || p.patch?.lastPrompt)) return;
      if (p.title) entry.title = p.title;
      else if (!entry.title) entry.title = p.patch.lastPrompt;
      entry.updatedAt = Date.now();
      break;
    default:
      return;
  }
  entry ??= list.find((s) => s.id === id);
  const e = entry && shown(m.id, entry);
  if (e) sessionChanged(m, e);
}

// Called for each /bridge WebSocket after the key has been checked.
export function attachBridge(ws) {
  let m = null;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'hello') {
      const id = String(msg.machineId || '').slice(0, 64) || `m_${crypto.randomBytes(5).toString('hex')}`;
      m = machines.get(id) || { id, pending: new Map() };
      const hadServer = Boolean(m.online && m.kimi?.server);
      m.ws?.close(4000, 'replaced');
      Object.assign(m, {
        name: String(msg.name || id).slice(0, 80),
        platform: msg.platform,
        home: msg.home,
        hostname: msg.hostname,
        bridgeVersion: msg.bridgeVersion,
        broker: Number(msg.broker) || 0,
        pool: Number(msg.pool) || 0,
        capabilities: cleanCapabilities(msg.capabilities),
        daemonStale: msg.daemonStale === true,
        daemonStaleReason: msg.daemonStale === true ? String(msg.daemonStaleReason || '').slice(0, 300) : '',
        claudeSessions: Number(msg.claudeSessions) || 0,
        online: true,
        ws,
        helloAt: Date.now(),
        sessionsKnown: false,
        lastSeen: Date.now(),
        kimi: msg.status,
        kimiVersion: msg.status?.version || m.kimiVersion,
      });
      m.pending ??= new Map();
      machines.set(id, m);
      persist();
      changed(m);
      if (m.kimi?.available) for (const fn of onlineListeners) fn(m.id);
      for (const fn of helloListeners) fn(m.id);
      if (m.kimi?.server && !hadServer) for (const fn of kimiServerListeners) fn(m.id);
      return;
    }
    if (!m) return;
    m.lastSeen = Date.now();
    if (msg.t === 'bridge.req') {
      const reply = (ok, data, error) => {
        try {
          ws.send(JSON.stringify({ t: 'res', id: msg.id, ok, ...(ok ? { data } : { error }) }));
        } catch {}
      };
      if (!bridgeRequest.fn) return reply(false, null, 'Hub 尚未載入 broker');
      Promise.resolve()
        .then(() => bridgeRequest.fn(m.id, msg))
        .then((data) => reply(true, data))
        .catch((err) => reply(false, null, err?.message || String(err)));
      return;
    }
    if (msg.t === 'res') {
      const p = m.pending.get(msg.id);
      if (!p) return;
      m.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      // With the status the bridge said (a 404 there is a 404 here too).
      else p.reject(Object.assign(new Error(msg.error || '連接器回報錯誤'), Number.isInteger(msg.status) ? { status: msg.status } : {}));
    } else if (msg.t === 'sh.data') {
      streams.get(msg.id)?.(String(msg.chunk || ''));
    } else if (msg.t === 'claude.event') {
      for (const fn of messageListeners) fn(m.id, msg);
    } else if (msg.t === 'kimi.event') {
      trackSession(m, msg.frame);
      for (const fn of listeners) fn(m.id, msg.frame);
    } else if (msg.t === 'kimi.sessions') {
      m.sessions = (msg.items || []).map((item) => sessionEntry(item));
      m.sessionsKnown = true;
      changed(m);
      for (const e of visibleSessions(m)) for (const fn of sessionListeners) fn(m.id, e);
      for (const fn of sessionsListeners) fn(m.id);
    } else if (msg.t === 'kimi.session.update') {
      const raw = sessionEntry(msg.item || {});
      if (!raw.id) return;
      m.sessions ??= [];
      const i = m.sessions.findIndex((x) => x.id === raw.id);
      if (i === -1) m.sessions.unshift(raw);
      else m.sessions[i] = raw;
      const e = shown(m.id, raw);
      if (e) sessionChanged(m, e);
      else broadcast({ t: 'kimi.session', machineId: m.id, id: raw.id, removed: true });
    } else if (msg.t === 'broker.ready') {
      m.broker = Number(msg.broker) || 0;
      // The broker is installed after the hello: the capability follows.
      if (Array.isArray(msg.capabilities)) m.capabilities = cleanCapabilities(msg.capabilities);
      changed(m);
    } else if (msg.t === 'deepseek.pool') {
      // The account validates and stores it; listeners only choose to act.
      for (const fn of messageListeners) fn(m.id, msg);
    } else if (msg.t === 'daemon.state') {
      // The connector's view of its Claude daemon: stale when the daemon
      // running there lacks capabilities the hub's build needs.
      m.daemonStale = msg.stale === true;
      m.daemonStaleReason = m.daemonStale ? String(msg.reason || '').slice(0, 300) : '';
      changed(m);
    } else if (msg.t === 'kimi.status') {
      const wasAvailable = m.kimi?.available;
      const wasServer = Boolean(m.kimi?.server);
      m.kimi = msg.status;
      if (msg.status?.available && !wasAvailable) for (const fn of onlineListeners) fn(m.id);
      if (msg.status?.server && !wasServer) for (const fn of kimiServerListeners) fn(m.id);
      if (msg.status?.version) m.kimiVersion = msg.status.version;
      if (!msg.status?.available) m.sessions = [];
      changed(m);
    }
  });
  ws.on('close', () => {
    if (!m || m.ws !== ws) return;
    m.online = false;
    m.ws = null;
    for (const p of m.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`機器「${m.name}」已離線`));
    }
    m.pending.clear();
    persist();
    changed(m);
  });
}

export function rpc(machineId, op, args = {}, timeoutMs = 60_000) {
  const m = machines.get(machineId);
  if (!m) return Promise.reject(Object.assign(new Error('找不到這台機器'), { status: 404 }));
  if (!m.online || !m.ws) return Promise.reject(Object.assign(new Error(`機器「${m.name}」目前離線：請在那台機器上執行連接器`), { status: 409 }));
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      m.pending.delete(id);
      reject(new Error(`機器「${m.name}」沒有在時間內回應`));
    }, timeoutMs);
    m.pending.set(id, { resolve, reject, timer });
    m.ws.send(JSON.stringify({ t: 'req', id, op, args }));
  });
}

// An rpc whose progress arrives on the way (a command's output): `onData`
// gets each chunk the bridge sends for `args.id`.
export async function rpcStream(machineId, op, args, onData, timeoutMs) {
  if (onData) streams.set(args.id, onData);
  try {
    return await rpc(machineId, op, args, timeoutMs);
  } finally {
    streams.delete(args.id);
  }
}

// An older bridge does not know an op: say what to do about it.
export function tooOld(err, m) {
  if (/未知的操作/.test(err?.message || '')) return Object.assign(new Error(`「${m?.name || '這台電腦'}」的連接器太舊，不支援 Claude。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。`), { status: 409 });
  return err;
}

// Calls the Kimi Server API on a machine and unwraps its envelope.
export async function kimiApi(machineId, method, p, body, timeoutMs) {
  const env = await rpc(machineId, 'kimi.request', { method, path: p, body }, timeoutMs);
  if (env?.code !== 0) {
    const err = new Error(kimiErrorText(env));
    err.kimiCode = env?.code;
    err.status = 400;
    throw err;
  }
  return env.data;
}

export function kimiErrorText(env) {
  const code = env?.code;
  const hints = {
    40110: 'Kimi 還沒有設定模型或登入：在那台機器上執行 kimi login（使用你的 Kimi 帳號）',
    40111: 'Kimi 的登入憑證不見了：在那台機器上重新執行 kimi login',
    40112: 'Kimi 的登入憑證被拒絕（可能已過期）：在那台機器上重新執行 kimi login',
    40113: 'Kimi 找不到要用的模型：在那台機器的 Kimi 裡用 /model 選一個模型',
    40401: '找不到這個 Kimi 對話（可能已被刪除或封存）',
    40901: 'Kimi 對話正在忙碌中',
    40902: '這個權限請求已經被處理了',
    40999: 'Kimi 伺服器拒絕操作這個由終端機執行的對話（40999）。請確認那台電腦的連接器已更新；只有可控的終端機會收到 Hub 的輸入',
  };
  return hints[code] || `Kimi 回報錯誤 ${code ?? ''}：${env?.msg || '未知錯誤'}`;
}
