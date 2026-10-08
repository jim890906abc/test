// Persistence for agents and sessions. Everything lives as JSON under DATA_DIR
// so the hub needs no database. Session writes are debounced, and made in
// slices that give way to everything else: a big conversation (megabytes of
// events) written in one go would hold up the live stream each time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGENTS } from './adapters/presets.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.AGENT_HUB_DATA || path.join(ROOT_DIR, 'data'));
export const WORKSPACES_DIR = path.resolve(process.env.AGENT_HUB_WORKSPACES || path.join(ROOT_DIR, 'workspaces'));

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- agents

let agents = [];

export function loadAgents() {
  let saved = [];
  try {
    saved = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  } catch {
    saved = [];
  }
  // Built-in presets are merged in by id so new presets show up after upgrades
  // while user edits to existing ones are kept. Presets seeded by earlier
  // versions (Demo Agent, other vendors) are dropped: only agents the user
  // added, plus Kimi on connected machines, exist.
  const keep = new Set(DEFAULT_AGENTS.map((a) => a.id));
  const byId = new Map(saved.filter((a) => !a.builtin || keep.has(a.id)).map((a) => [a.id, a]));
  for (const preset of DEFAULT_AGENTS) {
    if (!byId.has(preset.id)) byId.set(preset.id, { ...preset });
    else byId.set(preset.id, { ...preset, ...byId.get(preset.id), builtin: true });
  }
  agents = [...byId.values()];
  saveAgents();
  return agents;
}

export function saveAgents() {
  writeJsonAtomic(AGENTS_FILE, agents);
}

export function listAgents() {
  return agents;
}

export function getAgent(id) {
  return agents.find((a) => a.id === id);
}

export function upsertAgent(agent) {
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx === -1) agents.push(agent);
  else agents[idx] = agent;
  saveAgents();
  return agent;
}

export function deleteAgent(id) {
  agents = agents.filter((a) => a.id !== id);
  saveAgents();
}

// -------------------------------------------------------------- sessions

const sessions = new Map();
const saveTimers = new Map();
const saving = new Map(); // id -> { again }: a write in progress
const SAVE_DELAY = 1500;

export function loadSessions() {
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    // Left by a write the hub was stopped in the middle of.
    if (file.endsWith('.tmp')) fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
    if (!file.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      // A server restart kills whatever was running.
      if (s.status === 'running' || s.status === 'awaiting_permission') s.status = 'idle';
      for (const ev of s.events) {
        if (ev.type === 'permission' && !ev.decision) ev.decision = 'expired';
        if (ev.type === 'tool_use' && ev.status === 'running') ev.status = 'interrupted';
      }
      sessions.set(s.id, s);
    } catch (err) {
      console.warn(`[store] skipping unreadable session ${file}: ${err.message}`);
    }
  }
}

export function listSessions() {
  return [...sessions.values()];
}

export function getSession(id) {
  return sessions.get(id);
}

export function createSession(fields) {
  const now = Date.now();
  const session = {
    id: newId('s_'),
    title: 'New session',
    status: 'idle',
    permissionMode: 'ask',
    allowedTools: [],
    events: [],
    state: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  sessions.set(session.id, session);
  saveSessionNow(session);
  return session;
}

// `immediate` starts the write now instead of after the debounce.
export function saveSession(session, { immediate = false } = {}) {
  session.updatedAt = Date.now();
  if (immediate) return saveSessionNow(session);
  if (saveTimers.has(session.id)) return;
  saveTimers.set(
    session.id,
    setTimeout(() => saveSessionNow(session), SAVE_DELAY),
  );
}

const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);

function saveSessionNow(session) {
  clearTimeout(saveTimers.get(session.id));
  saveTimers.delete(session.id);
  if (!sessions.has(session.id)) return;
  // One write at a time per session; changes made meanwhile get the next.
  const busy = saving.get(session.id);
  if (busy) return void (busy.again = true);
  const job = { again: false };
  saving.set(session.id, job);
  writeSession(session)
    .catch((err) => console.warn(`[store] saving ${session.id}: ${err.message}`))
    .finally(() => {
      saving.delete(session.id);
      if (job.again) saveSessionNow(session);
    });
}

async function writeSession(session) {
  const text = await jsonInSlices(session, 'events');
  if (!sessions.has(session.id)) return;
  const file = sessionFile(session.id);
  const tmp = `${file}.${process.pid}.w.tmp`;
  await fs.promises.writeFile(tmp, text);
  // Deleted while it was being written: do not bring it back.
  if (!sessions.has(session.id)) return fs.promises.rm(tmp, { force: true });
  fs.renameSync(tmp, file);
}

// JSON of `obj` without holding the event loop: the list under `key`
// (nearly all of a session) goes in slices, with a pause after each. Items
// changed while it runs may be caught before or after the change; each is
// whole either way.
export async function jsonInSlices(obj, key, slice = 200) {
  const list = obj[key] || [];
  const n = list.length;
  const { [key]: _, ...rest } = obj;
  const head = JSON.stringify(rest);
  const parts = [head === '{}' ? '{' : `${head.slice(0, -1)},`, `${JSON.stringify(key)}:[`];
  for (let i = 0; i < n; i += slice) {
    if (i) {
      parts.push(',');
      await new Promise((r) => setImmediate(r));
    }
    parts.push(list.slice(i, Math.min(i + slice, n)).map((x) => JSON.stringify(x)).join(','));
  }
  parts.push(']}');
  return parts.join('');
}

export function deleteSession(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  sessions.delete(id);
  fs.rmSync(sessionFile(id), { force: true });
}

// On shutdown: everything not yet on disk, written right away.
export function flushAll() {
  for (const id of new Set([...saveTimers.keys(), ...saving.keys()])) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const s = sessions.get(id);
    if (!s) continue;
    const tmp = `${sessionFile(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, sessionFile(id));
  }
}

// Defaults for conversations (model, thinking, permission, plan mode), kept
// on the hub so every browser and phone gets the same ones.
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { defaults: {} };
  }
}
export function writeSettings(settings) {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

// A change to the defaults made once, by name: what is chosen in 設定
// afterwards stays. `change(defaults)` returns false when it cannot be made
// yet (it is tried again later).
export function migrateSettings(name, change) {
  const st = readSettings();
  if ((st.migrated || []).includes(name)) return false;
  st.defaults = { ...(st.defaults || {}) };
  if (change(st.defaults) === false) return false;
  st.migrated = [...(st.migrated || []), name];
  writeSettings(st);
  return true;
}
