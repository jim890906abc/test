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
      for (const fn of listeners) fn(m.id, msg.frame);
    } else if (msg.t === 'kimi.sessions') {
      m.sessions = (msg.items || []).map((s) => ({
        id: s.id,
        title: s.title || s.last_prompt || '(未命名)',
        cwd: s.metadata?.cwd,
        busy: s.busy,
        pending: s.pending_interaction,
        lastTurn: s.last_turn_reason,
        updatedAt: Date.parse(s.updated_at) || Date.now(),
      }));
      changed(m);
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
export async function kimiApi(machineId, method, p, body) {
  const env = await rpc(machineId, 'kimi.request', { method, path: p, body });
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
  };
  return hints[code] || `Kimi 回報錯誤 ${code ?? ''}：${env?.msg || '未知錯誤'}`;
}
