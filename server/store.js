// Persistence for agents and sessions. Everything lives as JSON under DATA_DIR
// so the hub needs no database. Session writes are debounced (the first change
// starts a 1.5 s timer; changes meanwhile ride along, the timer is not pushed
// back, so nothing waits longer than that), and made piece by piece with a
// pause after each: a big conversation (tens of megabytes of events) turned
// into one string and one buffer would hold up the live stream for a tenth of
// a second each time. The new file is flushed to disk before it replaces the
// old one, so a crash leaves the old or the new whole file, never a mix.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGENTS } from './adapters/presets.js';
import { salvage } from './salvage.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.AGENT_HUB_DATA || path.join(ROOT_DIR, 'data'));
export const WORKSPACES_DIR = path.resolve(process.env.AGENT_HUB_WORKSPACES || path.join(ROOT_DIR, 'workspaces'));

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
// Where a config file that would not parse is kept (see readJsonConfig).
export const DAMAGED_CONFIG_DIR = path.join(DATA_DIR, 'damaged-config');

// What the Hub keeps here (conversations, tokens, keys) is for its owner alone:
// a folder or file it creates is private (0700 / 0600). An existing one is
// left as it is; index.js says so when it is too open.
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

// A rename alone is atomic for readers but not durable: after a crash the new
// name can exist while its data blocks were never written, and the file comes
// back full-sized and zero-filled (a conversation was lost this way). So the
// data is forced to disk before the rename, and the folder entry after it.
// Exported for the other small files the Hub and the Claude daemon keep
// (hub.json, machines.json, daemon.json…): one way to write a file safely.
export function writeFileDurableSync(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'w', mode);
  try {
    // A file that was already there keeps its own permissions: a private one
    // must not inherit them.
    if (mode !== 0o666) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function writeFileDurable(file, data) {
  const fh = await fs.promises.open(file, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Not every platform lets a folder be opened and synced (Windows); there the
// rename is as durable as the system makes it.
export function fsyncDirSync(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

async function fsyncDir(dir) {
  try {
    const fh = await fs.promises.open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {}
}

// The whole file or nothing: written next to it, forced to disk, renamed over
// it, the folder synced. A write that fails (or a process killed in the
// middle) leaves the old file as it was; a failed one takes its temporary
// file with it. `mode` 0o600 keeps a secret private from the first byte.
export function writeJsonAtomic(file, value, { mode = 0o600, space = 2 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileDurableSync(tmp, JSON.stringify(value, null, space), mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDirSync(path.dirname(file));
}

// What a process killed in the middle of writeJsonAtomic leaves behind:
// `<name>.<pid>.tmp`, half written (the real file is untouched). Removed at
// the next start. A live process's file is its write in progress: left alone.
export function removeStaleTmp(file) {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.startsWith(base) && /^(\d+)\.tmp$/.exec(name.slice(base.length));
    if (!m || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), 0);
      continue; // alive
    } catch (err) {
      if (err.code === 'EPERM') continue; // alive, somebody else's
    }
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

// ------------------------------------------------------- guarded files
//
// A config file the Hub holds something a person typed in: an API key, the
// agents they added, their defaults. It is read with readJsonConfig and written
// back whole with writeJsonAtomic, and in between it is never taken for "empty"
// when it is not:
//   - missing: a first start, written when something is saved;
//   - ok: loaded;
//   - damaged: copied into damaged-config first (readJsonConfig), said at once
//     in plain words (once, not at every read), and NOT written over by what the
//     Hub does by itself or for an unrelated change. Only an `explicit` write —
//     the person typing in again what was lost — replaces it, and only while the
//     copy exists and the file is still the one that was copied;
//   - unreadable: never written over, whatever is asked.
// `problem` is what the API shows (public()) and what an error says (describe()).
export class ConfigBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigBlockedError';
    this.status = 409;
    this.code = 'config_blocked';
  }
}

export class GuardedConfig {
  // what: what the file holds ("Claude API key"); lost: the sentence that says
  // what could not be loaded and what to do; until: "in 重新輸入 API key 之前" —
  // when the Hub is willing to write the file again.
  constructor(file, { shape = 'object', tag, what, lost, until }) {
    Object.assign(this, { file, shape, tag, what, lost, until });
    this.problem = null; // { state: 'damaged', reason, backupPath, backupError } | { state: 'unreadable', code }
    this.told = null;
  }

  // The file as it is now: { state, value } with `value` only when it is ok.
  read() {
    const r = readJsonConfig(this.file, { shape: this.shape });
    if (r.state === 'ok') {
      this.problem = null;
      return { state: 'ok', value: r.value };
    }
    if (r.state === 'missing') {
      this.problem = null;
      return { state: 'missing', value: null };
    }
    this.problem = r.state === 'damaged' ? { state: 'damaged', reason: r.reason, backupPath: r.backupPath, backupError: r.backupError } : { state: 'unreadable', code: r.error.code || r.error.message };
    const message = this.describe();
    if (message !== this.told) {
      this.told = message;
      console.warn(`[${this.tag}] ${message}`);
    }
    return { state: r.state, value: null };
  }

  // Why the file cannot be used, in the words an error or the log uses; null when it can.
  describe() {
    const p = this.problem;
    if (!p) return null;
    const base = path.basename(this.file);
    if (p.state === 'unreadable') return `${this.what}檔案 ${base} 讀不到（${p.code}）。${this.what}這次無法載入；為了不蓋掉可能還好好的內容，Hub 不會寫入這個檔案。請修正這個檔案（或它的權限）後重新啟動 Hub。`;
    if (p.backupError) return `${this.what}檔案 ${base} 損壞（${p.reason}），而且沒能先備份原檔（${p.backupError.message}）。${this.lost}。為了不蓋掉唯一的一份，Hub 不會改寫這個檔案；請先排除備份失敗的原因再重新啟動 Hub。`;
    return `${this.what}檔案 ${base} 損壞（${p.reason}），原檔已原封不動備份於 ${p.backupPath}。${this.lost}。在你${this.until}之前，Hub 不會改寫這個檔案。`;
  }

  // What the API says to a browser, or null when the file is fine.
  public() {
    const p = this.problem;
    if (!p) return null;
    return { file: path.basename(this.file), state: p.state, reason: p.state === 'damaged' ? p.reason : `讀不到（${p.code}）`, backup: p.state === 'damaged' ? p.backupPath : null, message: this.describe() };
  }

  // Throws ConfigBlockedError when a write would be wrong, changing nothing:
  // call it before changing anything the write is meant to save.
  check({ explicit = false } = {}) {
    const p = this.problem;
    if (!p) return;
    if (p.state === 'unreadable' || p.backupError || !explicit) throw new ConfigBlockedError(this.describe());
    // An explicit replacement of a damaged file: only if it still is the file
    // that was copied away (someone may have put a good one back by hand, and
    // what is in memory is the empty start).
    const now = readJsonConfig(this.file, { shape: this.shape });
    if (now.state === 'ok') throw new ConfigBlockedError(`${this.what}檔案 ${path.basename(this.file)} 在 Hub 執行中被改過，現在讀得到了。為了不蓋掉修好的內容，這次沒有寫入；請重新啟動 Hub 載入它。`);
    if (now.state === 'unreadable') {
      this.problem = { state: 'unreadable', code: now.error.code || now.error.message };
      throw new ConfigBlockedError(this.describe());
    }
    if (now.state === 'damaged') {
      this.problem = { state: 'damaged', reason: now.reason, backupPath: now.backupPath, backupError: now.backupError };
      if (now.backupError) throw new ConfigBlockedError(this.describe());
    }
  }

  // Write `value` whole. A refused write throws ConfigBlockedError; one that
  // goes through also ends the problem.
  write(value, { explicit = false, ...options } = {}) {
    this.check({ explicit });
    writeJsonAtomic(this.file, value, options);
    this.problem = null;
  }

  // For what the Hub saves by itself (a migration, bookkeeping): written when
  // the file may be written, skipped — returning false — when it may not.
  writeIfAllowed(value, options = {}) {
    try {
      this.write(value, { ...options, explicit: false });
      return true;
    } catch (err) {
      if (err instanceof ConfigBlockedError) return false;
      throw err;
    }
  }
}

// ---------------------------------------------------------------- agents

let agents = [];

// The agents a person added (some hold an API key). A file that cannot be used
// is kept as it is and said (GuardedConfig); the start then goes on with the
// built-in presets, and nothing is written over the file until an agent is
// added, changed or deleted on purpose.
const agentsFile = new GuardedConfig(AGENTS_FILE, {
  shape: 'array',
  tag: 'store',
  what: 'Agent 清單',
  lost: '你自己加的 Agent（和它們的設定、API key）已無法載入，請重新新增或從備份還原',
  until: '新增或修改 Agent',
});

export function loadAgents() {
  const saved = agentsFile.read().value ?? [];
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

// `explicit`: a person added, changed or deleted an agent. Without it (the
// merge at start) the file is only written when it can be without losing
// anything; with it, a damaged file is replaced (its copy is kept) and one
// that cannot be read is not (throws ConfigBlockedError).
export function saveAgents({ explicit = false } = {}) {
  if (explicit) agentsFile.write(agents, { explicit });
  else agentsFile.writeIfAllowed(agents);
}

export function listAgents() {
  return agents;
}

export function getAgent(id) {
  return agents.find((a) => a.id === id);
}

export function upsertAgent(agent) {
  agentsFile.check({ explicit: true });
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx === -1) agents.push(agent);
  else agents[idx] = agent;
  saveAgents({ explicit: true });
  return agent;
}

export function deleteAgent(id) {
  agentsFile.check({ explicit: true });
  agents = agents.filter((a) => a.id !== id);
  saveAgents({ explicit: true });
}

// -------------------------------------------------------------- sessions

const sessions = new Map();
const saveTimers = new Map();
const saving = new Map(); // id -> { again }: a write in progress
const SAVE_DELAY = 1500;

// Conversation files that could not be read back as they are. Every one is
// copied untouched into DAMAGED_DIR first (outside the sessions folder, so it
// is never taken for a conversation); whatever can be rescued is loaded and
// marked, and whatever cannot is listed (listDamaged) and logged at start-up,
// never silently skipped.
const DAMAGED_DIR = path.join(DATA_DIR, 'sessions-damaged');
let damagedFiles = []; // what the last loadSessions() could not load

export function loadSessions() {
  damagedFiles = [];
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    // Left by a write the hub was stopped in the middle of.
    if (file.endsWith('.tmp')) fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
    if (!file.endsWith('.json')) continue;
    const s = readSessionFile(file);
    if (!s) continue;
    try {
      if (typeof s.id !== 'string' || !s.id) throw new Error('沒有 id');
      // A server restart kills whatever was running.
      if (s.status === 'running' || s.status === 'awaiting_permission') s.status = 'idle';
      for (const ev of s.events) {
        if (ev.type === 'permission' && !ev.decision) ev.decision = 'expired';
        if (ev.type === 'tool_use' && ev.status === 'running') ev.status = 'interrupted';
        settleSubagent(ev);
      }
      migrateSession(s);
      sessions.set(s.id, s);
      indexNative(s);
    } catch (err) {
      noteDamaged({ file, code: 'bad-structure', reason: `內容不像一個對話：${err.message}`, bytes: fileSize(file), backup: null });
    }
  }
}

const fileSize = (file) => {
  try {
    return fs.statSync(path.join(SESSIONS_DIR, file)).size;
  } catch {
    return null;
  }
};

function noteDamaged(entry) {
  damagedFiles.push({ salvaged: false, at: Date.now(), ...entry });
  console.warn(`[store] 無法載入對話檔 ${entry.file}：${entry.reason}${entry.backup ? `（原檔已備份為 ${path.join(DAMAGED_DIR, entry.backup)}）` : ''}`);
}

// What is in a session file: the parsed session, a rescued one, or null.
function readSessionFile(file) {
  const full = path.join(SESSIONS_DIR, file);
  let raw;
  let stat;
  try {
    stat = fs.statSync(full);
    raw = fs.readFileSync(full);
  } catch (err) {
    noteDamaged({ file, code: 'unreadable', reason: `讀不到檔案（${err.code || err.message}）`, bytes: null, backup: null });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return rescueSession(file, full, raw, stat, err);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    noteDamaged({ file, code: 'bad-structure', reason: '內容不像一個對話：最外層不是物件', bytes: raw.length, backup: null });
    return null;
  }
  return parsed;
}

// The file does not parse. Copy it away untouched, then try to get the
// conversation out of it (salvage.js). Only when the copy is on disk and
// reads back identical is the damaged original replaced by the repaired file;
// without such a copy the repaired conversation is only held in memory.
function rescueSession(file, full, raw, stat, parseError) {
  let backup = null;
  let backupError = null;
  try {
    backup = backupDamaged(file, raw);
  } catch (err) {
    backupError = err;
  }
  const noBackup = backupError ? `（沒能備份原檔：${backupError.message}）` : '';
  const r = salvage(raw, file.slice(0, -'.json'.length), parseError, stat.mtimeMs);
  if (!r.ok) {
    noteDamaged({ file, code: r.code, reason: r.reason + noBackup, bytes: raw.length, backup });
    return null;
  }
  const s = r.session;
  const note = { at: Date.now(), removedBytes: r.removedBytes, originalBytes: raw.length, backup, kinds: r.kinds, reason: r.reason };
  if (r.droppedBytes) note.droppedBytes = r.droppedBytes;
  const info = { id: newId('e_'), ts: Date.now(), type: 'info', text: '' };
  const tell = () => {
    const lost = [r.removedBytes && `已移除 ${r.removedBytes.toLocaleString('en-US')} 位元組的損壞區段（原處標有「〔損壞區段…〕」）`, r.droppedBytes && `已捨棄檔尾不完整的 ${r.droppedBytes.toLocaleString('en-US')} 位元組`].filter(Boolean).join('、');
    const where = backup ? `原檔已原封不動備份在 ${path.join(DAMAGED_DIR, backup)}。` : `原檔沒能備份${noBackup}。`;
    info.text = `這個對話的檔案曾損壞，${lost}後載入，損壞的那一段內容無法還原。${where}${note.unsaved ? '原檔暫時沒有被改動，下次存檔才會寫成乾淨的版本。' : ''}`;
  };
  s.meta = { ...(s.meta || {}), salvaged: note };
  s.events.push(info);
  if (!backup) note.unsaved = true;
  tell();
  if (backup) {
    try {
      replaceDamaged(full, stat, s);
    } catch (err) {
      note.unsaved = true;
      note.reason += `（但沒能把修復後的內容寫回原檔：${err.message}）`;
      tell();
    }
  }
  console.warn(`[store] 對話檔 ${file} 曾損壞，已救援並載入（${note.reason}）${backup ? `；原檔備份：${path.join(DAMAGED_DIR, backup)}` : ''}`);
  return s;
}

// A small config file (hub.json, machines.json, claude-deleted.json) read at
// start. Four different things can be true of it, and they are not the same:
//   missing     { state: 'missing' }              fine: first start
//   ok          { state: 'ok', value, raw }       parsed, and the right shape
//   damaged     { state: 'damaged', reason, raw, bytes, backup, backupPath, backupError }
//                                                 there, but empty / zero-filled /
//                                                 not JSON / the wrong shape
//   unreadable  { state: 'unreadable', error }    there, but cannot be read (a
//                                                 folder, no permission, I/O error)
// A damaged file is copied byte for byte into DAMAGED_CONFIG_DIR first
// (private, never over an earlier copy, reused for the same bytes). The caller
// decides what to start with; it must not write over the file when `backup` is
// null (the copy is the only evidence) or the state is `unreadable` (what is
// there is unknown, and may be perfectly good). `shape`: 'object' or 'array'.
export function readJsonConfig(file, { shape = 'object' } = {}) {
  removeStaleTmp(file);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    return err.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', error: err };
  }
  let value;
  let reason = null;
  try {
    value = JSON.parse(raw.toString('utf8'));
    const fits = shape === 'array' ? Array.isArray(value) : Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (!fits) reason = `最外層不是${shape === 'array' ? '陣列' : '物件'}`;
  } catch (err) {
    // Never the engine's own message: it can quote the start of the file, and
    // this file may hold secrets.
    const at = /position (\d+)/.exec(err.message)?.[1];
    reason = !raw.length ? '檔案是空的' : raw.every((b) => b === 0) ? '檔案裡全是 0 位元組（內容沒有真正寫到磁碟）' : `不是合法的 JSON${at ? `，約在第 ${at} 個字元` : ''}`;
  }
  if (!reason) return { state: 'ok', value, raw };
  return { state: 'damaged', reason, raw, bytes: raw.length, ...backupConfigCopy(file, raw) };
}

// { backup, backupPath, backupError }: the name of the copy of `raw` kept for
// `file` in DAMAGED_CONFIG_DIR, where it is, or why it could not be made.
export function backupConfigCopy(file, raw) {
  try {
    const backup = backupDamaged(path.basename(file), raw, DAMAGED_CONFIG_DIR);
    return { backup, backupPath: path.join(DAMAGED_CONFIG_DIR, backup), backupError: null };
  } catch (err) {
    return { backup: null, backupPath: null, backupError: err };
  }
}

// A byte-for-byte copy of a damaged file in `dir` (DAMAGED_DIR for conversations,
// DAMAGED_CONFIG_DIR for the config files), named
// `<file>.<ms>`; returns that name. A copy already there with the same bytes
// is reused (a file that stays damaged is seen at every start), and a name
// already taken is never overwritten.
function backupDamaged(file, raw, dir = DAMAGED_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${file}.`) || !/^\d+$/.test(name.slice(file.length + 1))) continue;
    try {
      const old = path.join(dir, name);
      if (fs.statSync(old).size === raw.length && fs.readFileSync(old).equals(raw)) return name;
    } catch {}
  }
  const tmp = path.join(dir, `.${file}.${process.pid}.partial`);
  try {
    writeFileDurableSync(tmp, raw, 0o600);
    for (let n = 0; n < 1000; n++) {
      const name = `${file}.${Date.now() + n}`;
      const dest = path.join(dir, name);
      try {
        fs.linkSync(tmp, dest); // refuses to replace a name that exists
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        // No hard links here: a plain rename, after checking the name is free.
        if (fs.existsSync(dest)) continue;
        fs.renameSync(tmp, dest);
      }
      if (!fs.readFileSync(dest).equals(raw)) {
        fs.rmSync(dest, { force: true });
        throw new Error('備份寫入後讀回來不一樣');
      }
      fsyncDirSync(dir);
      return name;
    }
    throw new Error('找不到可用的備份檔名');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Replace the damaged original with the repaired conversation, unless the
// original is no longer the file that was read.
function replaceDamaged(full, stat, session) {
  const now = fs.statSync(full);
  if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) throw new Error('原檔在讀取後又被改過');
  const text = JSON.stringify(session);
  const tmp = `${full}.${process.pid}.tmp`;
  try {
    writeFileDurableSync(tmp, text);
    if (!fs.readFileSync(tmp).equals(Buffer.from(text))) throw new Error('寫入後讀回來不一樣');
    fs.renameSync(tmp, full);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fsyncDirSync(SESSIONS_DIR);
}

// Every conversation file the Hub had to repair or could not load: the ones
// loaded after a repair (their own `meta.salvaged` says how) and the ones
// left out at the last start.
export function listDamaged() {
  const out = damagedFiles.map(({ file, code, reason, bytes, backup, at }) => ({ file, bytes, code, reason, salvaged: false, backup, at }));
  for (const s of sessions.values()) {
    const v = s.meta?.salvaged;
    if (v) out.push({ file: `${s.id}.json`, id: s.id, bytes: v.originalBytes ?? null, code: (v.kinds || []).join('+') || 'salvaged', reason: v.reason || '曾損壞，已修復後載入', salvaged: true, backup: v.backup ?? null, at: v.at, removedBytes: v.removedBytes ?? 0, unsaved: Boolean(v.unsaved) });
  }
  return out;
}

// A subagent card whose tool call is over (or was cut by the restart) cannot
// still be running: left alone it spins for ever. A background launch is the
// exception for a finished call; its real state follows from the replay.
function settleSubagent(ev) {
  const sub = ev?.subagent;
  if (ev?.type !== 'tool_use' || !sub || !['running', 'pending'].includes(sub.status)) return;
  const closed = { interrupted: 'cancelled', error: 'error', done: 'done' }[ev.status];
  if (!closed || (ev.status === 'done' && sub.background)) return;
  ev.subagent = { ...sub, status: closed };
}

// The provider a node belongs to. Kept deliberately independent of the
// adapters (store is imported by them): old conversations are classified from
// the fields they already have, and never rewritten just for reading.
export function nodeProvider(s) {
  if (s?.provider === 'kimi' || s?.provider === 'claude' || s?.provider === 'deepseek') return s.provider;
  if (s?.agentId === 'claude') return 'claude';
  // What an old record kept: the legacy mode, the marker made when a
  // DeepSeek conversation was created, a DeepSeek model in its settings, or
  // one the native last reported.
  if (s?.mode === 'deepseek' || s?.state?.deepseek || s?.modelConfig?.provider === 'deepseek') return 'deepseek';
  if (/^agent-hub-deepseek\//.test(s?.meta?.model || '') || /^agent-hub-deepseek\//.test(s?.modelConfig?.model || '')) return 'deepseek';
  return 'kimi';
}

// Where a session came from, independent of where it is displayed. A child
// node is always external, and a new low-level record defaults to external
// unless its caller explicitly claims it as a hub conversation. Actual broker
// children stay in their parent's subagent panel, not in either sidebar group.
const SESSION_ORIGINS = new Set(['hub', 'external']);

function resolveOrigin(parentId, requested) {
  if (requested != null && !SESSION_ORIGINS.has(requested)) {
    throw new TypeError(`session origin must be "hub" or "external", got ${JSON.stringify(requested)}`);
  }
  if (parentId) return 'external';
  return requested ?? 'external';
}

function migrateSession(s) {
  s.conversationId ||= s.id;
  s.continuedFrom ??= null;
  s.continuedTo ??= null;
  // An old record has no provider: it is worked out from what it kept, and
  // marked as worked out, so that what the native later reports (its model
  // alias) can still correct it. A provider set by a person or a switch
  // carries no such mark.
  if (!(s.provider === 'kimi' || s.provider === 'claude' || s.provider === 'deepseek')) {
    s.provider = nodeProvider(s);
    // (A Claude record is certain: its agent says so.)
    if (s.provider !== 'claude') s.providerInferred = true;
  }
  // Stores written before origin existed: a node with a parent came from a
  // terminal/runtime or broker; every other old record was a hub conversation,
  // so an upgrade never hides existing main chats.
  if (s.parentId) s.origin = 'external';
  else if (!SESSION_ORIGINS.has(s.origin)) s.origin = 'hub';
  // The Hub's own record of the choice. A DeepSeek conversation whose native
  // reported a model of another family is not recorded as running that model:
  // the model it was made for is the record (the native's word is kept in
  // meta, where drift is read from).
  const reported = s.meta?.model || '';
  const wrongFamily = s.provider === 'deepseek' && reported && !/^agent-hub-deepseek\//.test(reported);
  s.modelConfig ??= {
    provider: s.provider,
    model: wrongFamily ? s.state?.deepseek?.model || '' : reported,
    effort: wrongFamily ? '' : s.meta?.effort || '',
  };
}

export function listSessions() {
  return [...sessions.values()];
}

// Which Hub node is bound to a native Kimi session. A native id is bound when
// the node is made, and never changes, so an index kept by create/load/delete
// is exact; the lookup still checks the node it finds.
const nativeIndex = new Map(); // `${machineId}:${kimiSessionId}` -> session id
const nativeKey = (machineId, kimiSessionId) => `${machineId}:${kimiSessionId}`;
function indexNative(s) {
  if (s.machineId && s.kimiSessionId) nativeIndex.set(nativeKey(s.machineId, s.kimiSessionId), s.id);
}
export function findByNative(machineId, kimiSessionId) {
  const s = sessions.get(nativeIndex.get(nativeKey(machineId, kimiSessionId)));
  return s && s.machineId === machineId && s.kimiSessionId === kimiSessionId ? s : null;
}

// One logical conversation is a chain of nodes. Only the leaf is listed and
// is the one the next turn runs on; every old node and native binding stays.
export function chainOf(session) {
  if (!session) return [];
  const back = new Set();
  let first = session;
  while (first?.continuedFrom && sessions.has(first.continuedFrom) && !back.has(first.id)) {
    back.add(first.id);
    first = sessions.get(first.continuedFrom);
  }
  const out = [];
  const forward = new Set();
  let cur = first;
  while (cur && !forward.has(cur.id)) {
    forward.add(cur.id);
    out.push(cur);
    cur = cur.continuedTo ? sessions.get(cur.continuedTo) : null;
  }
  return out;
}

export function leafOf(session) {
  if (!session) return null;
  const seen = new Set();
  let cur = session;
  while (cur?.continuedTo && sessions.has(cur.continuedTo) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = sessions.get(cur.continuedTo);
  }
  return cur;
}

export function isLeaf(session) {
  return Boolean(session) && (!session.continuedTo || !sessions.has(session.continuedTo));
}

// A continuation node still being made (`provisional`) is not a leaf: the
// conversation's leaf stays the old node until the two are linked.
export function listLeaves() {
  return [...sessions.values()].filter((s) => isLeaf(s) && !s.provisional);
}

// The events of the whole chain, oldest first, as light references
// ({ ev, node, nodeIndex}) into the nodes: nothing is copied, so a window can
// be cut from a chain of tens of thousands of events without paying for the
// rest. A reference's position in this list is the event's index in the chain
// (what a snapshot's `window.firstIndex` and a page's `before` count).
export function chainItems(session) {
  const nodes = chainOf(leafOf(session) || session);
  const items = [];
  nodes.forEach((node, nodeIndex) => {
    for (const ev of node.events || []) items.push({ ev, node, nodeIndex });
  });
  items.sort((a, b) => (a.ev.ts || 0) - (b.ev.ts || 0) || a.nodeIndex - b.nodeIndex);
  return items;
}

// What an event looks like to a reader of the chain: its own fields (or
// `ev`, a trimmed copy of them) plus where it lives.
export function annotate(item, ev = item.ev) {
  const { node, nodeIndex } = item;
  return { ...ev, nodeId: node.id, conversationId: node.conversationId || node.id, nodeProvider: nodeProvider(node), nodeIndex };
}

// Visible events of the whole chain, oldest first. Events stay in their own
// node; this is a read-only projection, so a native snapshot can never erase
// another runtime's history.
export function chainEvents(session) {
  return chainItems(session).map((item) => annotate(item));
}

export function getSession(id) {
  return sessions.get(id);
}

export function createSession(fields) {
  const now = Date.now();
  const id = fields?.id || newId('s_');
  const session = {
    title: 'New session',
    status: 'idle',
    permissionMode: 'ask',
    allowedTools: [],
    events: [],
    state: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now,
    updatedAt: now,
    conversationId: id,
    continuedFrom: null,
    continuedTo: null,
    provider: null,
    modelConfig: null,
    handoff: null,
    ...fields,
    id,
  };
  session.conversationId ||= id;
  session.provider ||= nodeProvider(session);
  session.modelConfig ??= {
    provider: session.provider,
    model: session.meta?.model || '',
    effort: session.meta?.effort || '',
  };
  session.origin = resolveOrigin(session.parentId, session.origin);
  sessions.set(session.id, session);
  indexNative(session);
  saveSessionNow(session);
  return session;
}

// Everything saved while `fn` runs (synchronously) is bookkeeping: none of it
// moves updatedAt. Used for the start-up repair of an old store.
let quiet = 0;
export function quietly(fn) {
  quiet++;
  try {
    return fn();
  } finally {
    quiet--;
  }
}

// `immediate` starts the write now instead of after the debounce.
// `touch: false` is for bookkeeping that is not the user's activity (filling
// in a default on an old conversation, clearing a stale marker at start):
// updatedAt is the sidebar's sort key and only real activity may move it.
export function saveSession(session, { immediate = false, touch = true } = {}) {
  if (touch && !quiet) session.updatedAt = Date.now();
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
  job.done = writeSession(session)
    .catch((err) => console.warn(`[store] saving ${session.id}: ${err.message}`))
    .finally(() => {
      saving.delete(session.id);
      if (job.again) saveSessionNow(session);
    });
}

// Resolves once everything about `session` as it is now is on disk. For the
// few places where the order of two files matters (linking a chain).
export async function persistNow(session) {
  if (!sessions.has(session.id)) return;
  saveSessionNow(session);
  while (saving.has(session.id)) await saving.get(session.id).done;
}

// A repaired conversation whose repair is "not written back to the original
// file yet" (meta.salvaged.unsaved) says so until an ordinary save has put the
// conversation on disk. What is written is therefore the conversation without
// that flag, and the flag is dropped from memory only once the file is in
// place: a write that fails leaves it standing, and one that lands leaves it
// neither in the file (a restart would show the badge again) nor in memory.
function forWriting(session) {
  const note = session.meta?.salvaged;
  if (!note?.unsaved) return { view: session, landed() {} };
  const { unsaved: _, ...rest } = note;
  return {
    view: { ...session, meta: { ...session.meta, salvaged: rest } },
    landed() {
      if (session.meta?.salvaged === note) delete note.unsaved;
    },
  };
}

async function writeSession(session) {
  const file = sessionFile(session.id);
  const tmp = `${file}.${process.pid}.w.tmp`;
  const { view, landed } = forWriting(session);
  const fh = await fs.promises.open(tmp, 'w', 0o600);
  let complete = false;
  try {
    for await (const part of jsonParts(view, 'events')) {
      // Deleted while it was being written: stop, and do not bring it back.
      if (!sessions.has(session.id)) return;
      await fh.write(part);
    }
    // On disk before it takes the old file's place: a crash then leaves the
    // old whole file or the new whole file.
    await fh.sync();
    complete = true;
  } finally {
    await fh.close().catch(() => {});
    if (!complete) await fs.promises.rm(tmp, { force: true });
  }
  if (!sessions.has(session.id)) return fs.promises.rm(tmp, { force: true });
  fs.renameSync(tmp, file);
  landed();
  await fsyncDir(SESSIONS_DIR);
}

// The JSON of `obj` as a series of strings that join into exactly
// JSON.stringify(obj): everything but the list under `key` first, then the
// list (nearly all of a session), as many events at a time as fit in `slice`
// events or about `chars` characters, with a pause for the event loop after
// each. Items changed while it runs may be caught before or after the change;
// each is whole either way.
export async function* jsonParts(obj, key, { slice = 200, chars = 256 * 1024 } = {}) {
  const list = obj[key] || [];
  const n = list.length;
  const { [key]: _, ...rest } = obj;
  const head = JSON.stringify(rest);
  yield `${head === '{}' ? '{' : `${head.slice(0, -1)},`}${JSON.stringify(key)}:[`;
  let batch = [];
  let size = 0;
  let wrote = false;
  for (let i = 0; i < n; i++) {
    const text = JSON.stringify(list[i]);
    batch.push(text);
    size += text.length;
    if (batch.length >= slice || size >= chars) {
      yield (wrote ? ',' : '') + batch.join(',');
      wrote = true;
      batch = [];
      size = 0;
      await new Promise((r) => setImmediate(r));
    }
  }
  if (batch.length) yield (wrote ? ',' : '') + batch.join(',');
  yield ']}';
}

// The same as one string (for answering a request).
export async function jsonInSlices(obj, key, slice = 200) {
  const parts = [];
  for await (const part of jsonParts(obj, key, { slice })) parts.push(part);
  return parts.join('');
}

export function deleteSession(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  const gone = sessions.get(id);
  if (gone && nativeIndex.get(nativeKey(gone.machineId, gone.kimiSessionId)) === id) nativeIndex.delete(nativeKey(gone.machineId, gone.kimiSessionId));
  sessions.delete(id);
  fs.rmSync(sessionFile(id), { force: true });
}

// On shutdown: everything not yet on disk, written right away (and flushed,
// whole file, then renamed over the old one).
export function flushAll() {
  for (const id of new Set([...saveTimers.keys(), ...saving.keys()])) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const s = sessions.get(id);
    if (!s) continue;
    const tmp = `${sessionFile(id)}.${process.pid}.tmp`;
    const { view, landed } = forWriting(s);
    writeFileDurableSync(tmp, JSON.stringify(view));
    fs.renameSync(tmp, sessionFile(id));
    landed();
  }
  fsyncDirSync(SESSIONS_DIR);
}

// Defaults for conversations (model, thinking, permission, plan mode), kept
// on the hub so every browser and phone gets the same ones. Read at every use,
// so a file that cannot be used is kept as it is and said once (GuardedConfig):
// the defaults are then the built-in ones, and the file is only written over
// by a person saving the defaults (`explicit`), never by a migration.
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const settingsFile = new GuardedConfig(SETTINGS_FILE, {
  tag: 'store',
  what: '預設設定',
  lost: '新對話的預設模型、思考強度與權限已無法載入（會用內建的預設），請重新儲存預設或從備份還原',
  until: '儲存預設設定',
});
export function readSettings() {
  return settingsFile.read().value ?? { defaults: {} };
}
export function writeSettings(settings, { explicit = false } = {}) {
  settingsFile.write(settings, { explicit });
}

// A change to the defaults made once, by name: what is chosen in 設定
// afterwards stays. `change(defaults)` returns false when it cannot be made
// yet (it is tried again later); so does a settings file that may not be
// written over.
export function migrateSettings(name, change) {
  const st = readSettings();
  if ((st.migrated || []).includes(name)) return false;
  st.defaults = { ...(st.defaults || {}) };
  if (change(st.defaults) === false) return false;
  st.migrated = [...(st.migrated || []), name];
  return settingsFile.writeIfAllowed(st);
}
