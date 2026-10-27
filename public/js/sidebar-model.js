// What the sidebar lists, kept free of the DOM so it can be tested directly in
// node (spec §14): the two source categories, which sessions never get a row,
// how a search and the saved fold state combine, and the provider named on a
// row.
import { PROVIDER_LABELS, busy, conversationIdOf, isDsModel, isLeaf, isProvider, modelConfigOf, providerOf, turnOf } from './providers.js';
import { driftOf, driftTag } from './model-drift.js';

// A native session the machine reports. Old chain nodes may still sit in a
// machine's list; the server marks them (or gives their conversationId) so the
// sidebar can show only the leaf.
export const isNativeLeaf = (k) => Boolean(k) && k.leaf !== false && !k.continuedTo && !k.archived && !k.hidden;

// Where a row came from, for the two sidebar categories. A session the hub has
// no record of (a native terminal/CLI one) is 子session; a hub-created
// conversation is a 聊天室. True parentId children never get a row at all: they
// belong to their parent's 子代理 panel. Old hub stores without origin stay in
// 聊天室 unless they are a child.
export function originOf(s) {
  if (!s || s.parentId) return 'external';
  if (s.origin === 'hub' || s.origin === 'external') return s.origin;
  return 'hub';
}

// The native sessions that belong to subagent children. A child is not listed,
// so its native session in the machine's list must not turn into an external
// row either. The page keeps what it has seen (`sticky`), so a child whose hub
// record is later deleted with its parent does not surface in this page; the
// machine entry itself may also say so with `parentId`.
export function newChildIndex() {
  return { keys: new Set(), ids: new Set(), conversations: new Set() };
}
export function rememberChildren(index, sessions) {
  for (const s of sessions) {
    if (!s?.parentId) continue;
    if (s.kimiSessionId && s.machineId) index.keys.add(`${s.machineId}:${s.kimiSessionId}`);
    if (s.kimiSessionId) index.ids.add(s.kimiSessionId);
    if (s.conversationId) index.conversations.add(s.conversationId);
  }
  return index;
}
const isChildEntry = (k, key, index) => Boolean(k.parentId) || index.keys.has(key) || index.ids.has(k.id) || Boolean(k.conversationId && index.conversations.has(k.conversationId));

// One row per logical conversation (a chain has one leaf), never one row per
// mode or per old runtime node, and never one for a subagent child.
// in: { sessions: summaries, machines, knownChainNative: Set, children: index }
export function buildRows({ sessions, machines, knownChainNative = new Set(), children = newChildIndex() }) {
  const machineById = (id) => machines.find((m) => m.id === id);
  const out = [];
  const leaves = new Map(); // conversationId -> leaf summary
  const rank = (s, cid) => (s.continuedFrom ? 2 : s.id === cid ? 1 : 0);
  for (const s of sessions) {
    if (!s || s.parentId || !isLeaf(s)) continue;
    const cid = conversationIdOf(s);
    const prev = leaves.get(cid);
    // A node with continuedFrom is the newer leaf; otherwise prefer the first
    // node whose id is the conversationId, then the newest update.
    if (!prev || rank(s, cid) > rank(prev, cid) || (rank(s, cid) === rank(prev, cid) && (s.updatedAt || 0) >= (prev.updatedAt || 0))) leaves.set(cid, s);
  }
  const followed = new Map();
  const leafNatives = new Set();
  for (const s of leaves.values()) {
    if (s.kimiSessionId) {
      followed.set(`${s.machineId}:${s.kimiSessionId}`, s);
      leafNatives.add(s.kimiSessionId);
    }
  }
  const chainParents = new Set([...leaves.values()].map((s) => s.continuedFrom).filter(Boolean));
  const added = new Set();
  const flag = (s) => Boolean(s?.pendingChildPermission);
  for (const m of machines) {
    for (const k of m.sessions || []) {
      const key = `${m.id}:${k.id}`;
      const s = followed.get(key);
      followed.delete(key);
      if (!s && isChildEntry(k, key, children)) continue;
      if (!s && !isNativeLeaf(k)) continue;
      if (!s && knownChainNative.has(k.id) && !leafNatives.has(k.id)) continue;
      if (!s && (chainParents.has(k.id) || chainParents.has(k.kimiSessionId))) continue;
      const cid = s ? conversationIdOf(s) : k.conversationId || k.id;
      if (added.has(cid)) continue;
      // An old Kimi node that the chain has already moved past: the leaf row
      // below represents this conversation.
      if (!s && k.conversationId && leaves.has(k.conversationId)) continue;
      const status = s ? s.status : k.busy ? (k.pending && k.pending !== 'none' ? 'awaiting_permission' : 'running') : k.lastTurn === 'failed' ? 'error' : 'idle';
      const provider = s ? providerOf(s) : isProvider(k.provider) ? k.provider : k.mode === 'deepseek' || isDsModel(k.model) ? 'deepseek' : 'kimi';
      out.push({ key, hub: s, kimi: k, machine: m, title: s?.title || k.title || '新對話', cwd: s?.cwd || k.cwd, status, provider, conversationId: cid, origin: s ? originOf(s) : 'external', deepseek: provider === 'deepseek', claude: provider === 'claude', updatedAt: Math.max(s?.updatedAt || 0, k.updatedAt || 0), childWaiting: flag(s) });
      added.add(cid);
    }
  }
  for (const [key, s] of followed) {
    const cid = conversationIdOf(s);
    if (added.has(cid)) continue;
    const m = machineById(s.machineId);
    out.push({ key, hub: s, machine: m, title: s.title, cwd: s.cwd, status: s.status, provider: providerOf(s), conversationId: cid, origin: originOf(s), deepseek: providerOf(s) === 'deepseek', claude: providerOf(s) === 'claude', updatedAt: s.updatedAt, offline: !m?.online, childWaiting: flag(s) });
    added.add(cid);
  }
  // Claude conversations, and Kimi leaves whose machine is no longer listed.
  for (const [cid, s] of leaves) {
    if (added.has(cid)) continue;
    const provider = providerOf(s);
    const key = s.kimiSessionId && s.machineId ? `${s.machineId}:${s.kimiSessionId}` : provider === 'claude' ? `claude:${s.id}` : `conv:${cid}`;
    out.push({ key, hub: s, machine: machineById(s.machineId), title: s.title || '新對話', cwd: s.cwd, status: s.status, provider, conversationId: cid, origin: originOf(s), deepseek: provider === 'deepseek', claude: provider === 'claude', updatedAt: s.updatedAt, offline: provider !== 'claude' && s.machineId ? !machineById(s.machineId)?.online : false, childWaiting: flag(s) });
    added.add(cid);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ------------------------------------------------------------ the two groups

// 聊天室 starts open, 子session starts folded. A stored choice wins.
export function parseSideSections(raw) {
  let o = null;
  try {
    o = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {}
  return { chat: o?.chat !== false, sub: o?.sub === true };
}

export const SECTION_LABELS = { chat: '聊天室', sub: '子session' };

// The groups to draw. A search opens every group that has a result for the
// moment; the saved fold state (`saved`) is read, never changed.
export function sidebarSections(allRows, { query = '', saved = parseSideSections(null) } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const searching = Boolean(q);
  const list = searching ? allRows.filter((r) => String(r.title || '').toLowerCase().includes(q) || String(r.cwd || '').toLowerCase().includes(q)) : allRows;
  const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const chat = list.filter((r) => r.origin !== 'external').sort(byTime);
  const sub = list.filter((r) => r.origin === 'external').sort(byTime);
  const open = (key) => (searching ? true : Boolean(saved[key]));
  const sections = [];
  if (chat.length || !searching) sections.push({ key: 'chat', label: SECTION_LABELS.chat, rows: chat, open: open('chat') });
  if (sub.length) sections.push({ key: 'sub', label: SECTION_LABELS.sub, rows: sub, open: open('sub') });
  return { searching, list, sections };
}

// --------------------------------------------------------- the provider tag

// The provider a row names (spec §3.1, §2.2). While a turn runs, the turn's
// own provider is what is really working and the conversation's setting is
// what the NEXT turn will use; when it is idle only the next turn is left, so
// a turnProvider kept from an earlier turn must not be shown.
export function rowProviderView(r) {
  const label = (p) => PROVIDER_LABELS[p] || p;
  const s = r.hub;
  if (!s) return { provider: r.provider, text: label(r.provider), title: `目前由 ${label(r.provider)} 執行`, pending: false };
  const runtime = providerOf(s);
  const target = modelConfigOf(s).provider;
  // The native conversation runs another model than the one recorded: the tag
  // names what runs, not the label (the page's own reading of summary.modelDrift).
  const drift = driftOf(s);
  if (drift && !busy(r.status)) return { ...driftTag(drift), pending: true };
  if (busy(r.status)) {
    const actual = turnOf(s, true)?.provider || runtime;
    if (target !== actual) return { provider: actual, text: `本回合 ${label(actual)}／下一回合 ${label(target)}`, title: `本回合 ${label(actual)}；下一回合 ${label(target)}`, pending: true };
    return { provider: actual, text: label(actual), title: `本回合由 ${label(actual)} 執行`, pending: false };
  }
  if (target !== runtime) return { provider: target, text: `下一回合 ${label(target)}`, title: `目前執行環境是 ${label(runtime)}；下一回合起改用 ${label(target)}`, pending: true };
  return { provider: target, text: label(target), title: `下一回合將使用 ${label(target)}`, pending: false };
}
