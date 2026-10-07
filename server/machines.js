// Machines connected through the bridge (bridge/agent-hub-bridge.mjs).
// Each bridge holds one WebSocket to the hub; the hub sends requests over it
// ({ t: 'req' }) and the bridge pushes Kimi events and session lists back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';

const FILE = path.join(DATA_DIR, 'machines.json');
const machines = new Map(); // id -> machine
const listeners = new Set(); // (machineId, frame) => void   for Kimi events
const onlineListeners = new Set(); // (machineId) => void
const sessionListeners = new Set(); // (machineId, entry) => void
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

try {
  for (const m of JSON.parse(fs.readFileSync(FILE, 'utf8'))) machines.set(m.id, { ...m, online: false, ws: null, pending: new Map() });
} catch {}

function persist() {
  const list = [...machines.values()].map(({ id, name, platform, home, lastSeen, kimiVersion }) => ({ id, name, platform, home, lastSeen, kimiVersion }));
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
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
    kimi: m.kimi || { available: false },
    sessions: m.online ? m.sessions || [] : [],
  };
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
});

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
  if (entry) sessionChanged(m, entry);
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
      m.ws?.close(4000, 'replaced');
      Object.assign(m, {
        name: String(msg.name || id).slice(0, 80),
        platform: msg.platform,
        home: msg.home,
        bridgeVersion: msg.bridgeVersion,
        online: true,
        ws,
        lastSeen: Date.now(),
        kimi: msg.status,
        kimiVersion: msg.status?.version || m.kimiVersion,
      });
      m.pending ??= new Map();
      machines.set(id, m);
      persist();
      changed(m);
      if (m.kimi?.available) for (const fn of onlineListeners) fn(m.id);
      return;
    }
    if (!m) return;
    m.lastSeen = Date.now();
    if (msg.t === 'res') {
      const p = m.pending.get(msg.id);
      if (!p) return;
      m.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || '連接器回報錯誤'));
    } else if (msg.t === 'kimi.event') {
      trackSession(m, msg.frame);
      for (const fn of listeners) fn(m.id, msg.frame);
    } else if (msg.t === 'kimi.sessions') {
      m.sessions = (msg.items || []).map(sessionEntry);
      changed(m);
      for (const e of m.sessions) for (const fn of sessionListeners) fn(m.id, e);
    } else if (msg.t === 'kimi.session.update') {
      const e = sessionEntry(msg.item || {});
      if (!e.id) return;
      m.sessions ??= [];
      const i = m.sessions.findIndex((x) => x.id === e.id);
      if (i === -1) m.sessions.unshift(e);
      else m.sessions[i] = e;
      sessionChanged(m, e);
    } else if (msg.t === 'kimi.status') {
      const wasAvailable = m.kimi?.available;
      m.kimi = msg.status;
      if (msg.status?.available && !wasAvailable) for (const fn of onlineListeners) fn(m.id);
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
    40999: '這個對話正在終端機的 Kimi 裡執行，中控台不能透過 Kimi 伺服器操作它',
  };
  return hints[code] || `Kimi 回報錯誤 ${code ?? ''}：${env?.msg || '未知錯誤'}`;
}
