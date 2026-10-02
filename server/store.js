// Persistence for agents and sessions. Everything lives as JSON under DATA_DIR
// so the hub needs no database; writes are debounced per session.
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

export function loadSessions() {
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
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

export function saveSession(session, { immediate = false } = {}) {
  session.updatedAt = Date.now();
  if (immediate) return saveSessionNow(session);
  if (saveTimers.has(session.id)) return;
  saveTimers.set(
    session.id,
    setTimeout(() => saveSessionNow(session), 400),
  );
}

function saveSessionNow(session) {
  clearTimeout(saveTimers.get(session.id));
  saveTimers.delete(session.id);
  if (!sessions.has(session.id)) return;
  writeJsonAtomic(path.join(SESSIONS_DIR, `${session.id}.json`), session);
}

export function deleteSession(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  sessions.delete(id);
  fs.rmSync(path.join(SESSIONS_DIR, `${id}.json`), { force: true });
}

export function flushAll() {
  for (const id of [...saveTimers.keys()]) {
    const s = sessions.get(id);
    if (s) saveSessionNow(s);
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
