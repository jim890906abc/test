// The session runner: owns turn execution, the permission gate, interrupts
// and sub-agent delegation. Adapters only translate between an agent and the
// hub's normalized event stream. Live adapters (Kimi on a connected machine)
// push events at any time and keep their own turn state.
import * as store from './store.js';
import { TOOL_DEFS, toolKind, validateInput, executeTool } from './tools.js';
import { ADAPTERS } from './adapters/index.js';
import { createWorkspace } from './workspace.js';
import * as machines from './machines.js';
import * as deepseek from './deepseek-account.js';
import * as modelDrift from './model-drift.js';
import * as claudeAccount from './claude-account.js';
import * as handoff from './handoff.js';
import { redactSecrets, redactDeep, appendRedacted } from './redact.js';
import { syncEvents, forgetEvents, findEvent, lastUserEventWithText } from './event-index.js';
import { inheritPermission, nativePermission, hubModeFor } from './permissions.js';
import { isActive as autoPauseActive } from './autopause.js';
import * as subagentPolicy from './subagent-policy.js';
import * as subagentBroker from './subagent-broker.js';
import os from 'node:os';
import * as repoBind from './adapters/claude-repo.js';
import { remoteHost } from './adapters/claude-tools.js';

let broadcast = () => {};
export function setBroadcast(fn) {
  broadcast = (msg) => {
    // A continuation node still being made is not on any screen yet: neither
    // the node nor what its adapter says about it goes out until it is linked.
    const sid = msg?.t === 'session' ? msg.session?.id : msg?.sid;
    if (sid && store.getSession(sid)?.provisional) return;
    fn(msg);
  };
}
// What a subagent setting can really do is read from the computer after the
// conversation is shown; the browser gets the answer when it arrives.
subagentPolicy.onChange((s) => broadcast({ t: 'session', session: summarize(s) }));

const running = new Map(); // sessionId -> { ac }
const pendingPermissions = new Map(); // `${sid}:${eventId}` -> resolve(decision)
const statusListeners = new Set(); // (session) => void, on every status change
const activeChildren = new Map(); // parent session id -> Set(child session id)
const parentInterrupts = new WeakMap(); // parent session -> interrupt version; background results must not revive it
// Cards already chosen by a delegation that has not created its child yet.
// Parallel MCP calls may reach the Hub together, before any child id exists
// on the parent card; this keeps them from sharing one.
const claimedBrokerCards = new Set(); // `${parentId}:${eventId}`
// Delegations the caller gave up on (the daemon's guard stopped the turn, it
// stopped waiting): checked again once a child that was still being made exists.
const cancelledDelegations = new Set(); // `${parentId}:${eventId}`

export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export const providerOf = (s) => (s?.provider === 'kimi' || s?.provider === 'claude' || s?.provider === 'deepseek' ? s.provider : store.nodeProvider(s));

// Where a conversation came from: the user made it here (hub), or the hub
// only discovered/attached it or a runtime/broker started it (external).
// Missing origin on an old store reads as hub, so existing conversations do
// not suddenly move out of the main list; a child with a parentId is always
// external whatever path made it.
export const ORIGINS = ['hub', 'external'];
export function originOf(s) {
  if (s?.parentId) return 'external';
  return s?.origin === 'external' ? 'external' : 'hub';
}

export function normalizeOrigin(value, fallback = 'hub') {
  if (value === undefined || value === null || value === '') return fallback;
  if (!ORIGINS.includes(value)) throw Object.assign(new Error('origin 只能是 hub 或 external'), { status: 400 });
  return value;
}

// The source of a whole continuation chain: every node keeps it, so a chain
// started outside the Hub stays external after a runtime switch.
function chainOrigin(session) {
  const nodes = store.chainOf(session);
  return originOf(nodes[0] || session);
}

const WORKING = ['running', 'awaiting_permission'];

export function summarize(s) {
  const leaf = store.leafOf(s) || s;
  const modelConfig = s.modelConfig || { provider: providerOf(s), model: s.meta?.model || '', effort: s.meta?.effort || '' };
  // 本回合實際使用 (turn*) and 下一回合將使用 (next*) are separate: the
  // first is the snapshot of the turn running now (none while idle), the
  // second follows from the settings now (a scheduled switch included).
  const working = WORKING.includes(s.status);
  const pending = s.state?.pendingProvider;
  const native = modelDrift.nativeOf(s);
  return {
    id: s.id,
    title: s.title,
    agentId: s.agentId,
    status: s.status,
    cwd: s.cwd,
    branch: s.branch,
    parentId: s.parentId,
    // Main chat vs 子session, independent of parentId's hierarchy.
    origin: originOf(s),
    permissionMode: s.permissionMode,
    machineId: s.machineId,
    kimiSessionId: s.kimiSessionId,
    // 'deepseek': runs a DeepSeek model in the computer's Kimi (billed to the
    // gateway's API key, not the Kimi subscription).
    mode: deepseek.isDeepseek(s) ? 'deepseek' : null,
    provider: providerOf(s),
    modelConfig,
    model: modelConfig.model || s.meta?.model || '',
    effort: modelConfig.effort || s.meta?.effort || '',
    subagent: s.meta?.subagent || null,
    turnProvider: working ? s.meta?.turnProvider ?? null : null,
    turnModel: working ? s.meta?.turnModel ?? null : null,
    turnEffort: working ? s.meta?.turnEffort ?? null : null,
    turnSubagent: working ? s.meta?.turnSubagent ?? null : null,
    nextProvider: pending?.provider || providerOf(s),
    nextModel: pending ? pending.model || '' : modelConfig.model || s.meta?.model || '',
    nextEffort: pending ? pending.effort || '' : modelConfig.effort || s.meta?.effort || '',
    nextSubagent: s.meta?.subagent || null,
    // What the native Kimi reports it really runs on (null until it has said),
    // and whether that disagrees with what the conversation is recorded to
    // use. The label on a conversation is the Hub's record; these two are the
    // native's word, so a disagreement is never hidden behind the label.
    nativeModel: native?.model ?? null,
    nativeEffort: native?.effort || null,
    nativeProvider: native?.provider ?? null,
    modelDrift: leaf?.id === s.id ? modelDrift.driftOf(s, providerOf(s)) : null,
    // What that setting can really do: its scope (a native subagent is the
    // computer's, not the conversation's), the value in effect, and whether
    // it can be guaranteed. See subagent-policy.js.
    subagentInfo: subagentPolicy.infoOf(s),
    // Continuation chain: one logical conversation, one leaf to run on.
    conversationId: s.conversationId || s.id,
    continuedFrom: s.continuedFrom || null,
    continuedTo: s.continuedTo || null,
    leafId: leaf?.id || s.id,
    isLeaf: leaf?.id === s.id,
    chainLength: store.chainOf(leaf || s).length,
    handoff: s.handoff ? { fromProvider: s.handoff.fromProvider, chainStartProvider: s.handoff.chainStartProvider || s.handoff.fromProvider, chainProviders: s.handoff.chainProviders || null, fromCwd: s.handoff.fromCwd, targetProvider: s.handoff.targetProvider, chars: s.handoff.chars, omitted: s.handoff.omitted, consumedAt: s.handoff.consumedAt || null, notes: s.handoff.notes || [] } : null,
    pendingProvider: s.state?.pendingProvider || null,
    // 叢集 (cluster): a worker names its cluster; the conversation that
    // dispatched clusters lists them (every node of its chain, so a runtime
    // switch of the main conversation does not hide them).
    clusterId: s.clusterId || null,
    clusterRole: s.clusterRole || null,
    // Taken off the sidebar by the cluster's clean-up (the conversation is kept).
    clusterHidden: Boolean(s.clusterHidden),
    clusterIds: clusterIdsOf(s),
    // A sub-agent is hidden from the sidebar, so a permission it waits on would
    // be invisible: the conversation that owns it carries the flag.
    pendingChildPermission: childAwaitsPermission(s),
    // Bound to a GitHub repository (Claude keeps it in meta, Kimi beside it).
    repo: s.meta?.repo || (s.repo ? { full: s.repo.full, branch: s.repo.branch, url: s.repo.url, dir: s.repo.dir } : null),
    meta: s.meta,
    usage: s.usage,
    autoPause: s.autoPause || null,
    lastBackup: s.lastBackup || null,
    scheduled: s.scheduled || [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function clusterIdsOf(s) {
  const out = [];
  for (const node of store.chainOf(store.leafOf(s) || s)) for (const id of node.clusterIds || []) if (!out.includes(id)) out.push(id);
  return out;
}

// Does a sub-agent working for this conversation (any node of its chain, any
// depth) wait for the user to approve something?
function childAwaitsPermission(session, depth = 0) {
  if (depth > 5) return false;
  for (const node of store.chainOf(store.leafOf(session) || session)) {
    for (const id of activeChildren.get(node.id) || []) {
      const child = store.getSession(id);
      if (child && (child.status === 'awaiting_permission' || childAwaitsPermission(child, depth + 1))) return true;
    }
  }
  return false;
}

// A sub-agent's status decides a flag on every conversation above it: tell the
// pages about those, since they do not follow the hidden sub-agent.
function announceAncestors(session) {
  const seen = new Set();
  for (let at = session; at?.parentId && !seen.has(at.parentId); ) {
    seen.add(at.parentId);
    const parent = store.getSession(at.parentId);
    if (!parent) return;
    broadcast({ t: 'session', session: summarize(store.leafOf(parent) || parent) });
    at = parent;
  }
}

function setStatus(session, status) {
  if (session.status === status) return;
  const waiting = session.status === 'awaiting_permission' || status === 'awaiting_permission';
  session.status = status;
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
  if (waiting && session.parentId) announceAncestors(session);
  for (const fn of statusListeners) {
    try {
      fn(session);
    } catch (err) {
      console.error('[runner] status listener:', err);
    }
  }
  if (status === 'idle' || status === 'error') {
    queueMicrotask(() => applyPendingSwitch(session).catch((err) => console.warn(`[runner] pending switch ${session.id}: ${err.message}`)));
  }
}

// ----------------------------------------------------------- event helpers

// A broker child is its own session. Its events are mirrored into the parent
// under the tool card that started it, while it works, so the existing card
// and the 子代理 panel have real steps without waiting for the final answer.
const brokerProjectedId = (childId, eventId) => `bp_${childId}_${eventId}`;
const isBrokerProjection = (ev) => Boolean(ev?.brokerChildId);
// The mirrored child's text goes through the same filter as every event (server/redact.js).
const scrubBrokerText = (value) => redactSecrets(value);

// A masked deep copy, secret-named members left out: the mirrored card never
// shares objects with the child's own event.
const cleanBrokerValue = (value) => {
  const clean = redactDeep(value, { drop: true });
  return clean && typeof clean === 'object' ? structuredClone(clean) : clean;
};

// The parent card a broker child belongs to. `state.broker` is written when
// the child is created; a child from an older hub build (or one whose state
// was lost) is recovered from parentId plus the parent's childSessionId or
// subagent.id. A saved link is only trusted while the card really belongs to
// this child: parallel delegations once shared one card, and repairing that
// must never take the card away from its real child.
const brokerCardOwners = (card) => [...new Set([card?.childSessionId, card?.subagent?.id].filter(Boolean))];
const brokerCardOwnedBy = (card, childId) => {
  const owners = brokerCardOwners(card);
  return owners.length > 0 && owners.every((id) => id === childId);
};
const brokerCardOwnedByOther = (card, childId) => brokerCardOwners(card).some((id) => id !== childId);
const brokerCardUnclaimed = (card) => brokerCardOwners(card).length === 0;
const isDelegateCard = (ev) => ev?.type === 'tool_use' && !isBrokerProjection(ev) && /delegate|mcp__agent-hub|broker|\bTask\b/i.test(ev.name || '');
const brokerTaskOf = (child) => {
  const said = lastUserEventWithText(child?.events);
  return String(said?.text || child?.title || '').trim();
};
const brokerCardTask = (card) => String(card?.input?.task || card?.input?.prompt || '').trim();

function brokerCardState(child) {
  const busy = ['running', 'awaiting_permission'].includes(child.status);
  const end = (child.events || []).findLast((e) => e.type === 'turn_end');
  const text = (child.events || []).findLast((e) => e.type === 'text' && String(e.text || '').trim())?.text?.trim() || '';
  const error = end?.error ? (child.events || []).findLast((e) => e.type === 'error' && e.text)?.text || '' : '';
  return {
    status: busy ? 'running' : end?.interrupted ? 'interrupted' : end?.error || child.status === 'error' ? 'error' : 'done',
    subStatus: busy ? 'running' : end?.interrupted ? 'cancelled' : end?.error || child.status === 'error' ? 'error' : 'done',
    text,
    error,
  };
}

// A card for a child whose saved card belonged to another child. Its fields
// come from the child itself, so one child's title/model/status never leaks
// into another's card; the child's own steps are reparented afterwards.
function makeBrokerCard(child) {
  const task = brokerTaskOf(child) || '子代理';
  const provider = providerOf(child);
  const model = child.modelConfig?.model || child.meta?.model || '';
  const effort = child.modelConfig?.effort || child.meta?.effort || '';
  const state = brokerCardState(child);
  const times = [child.createdAt, ...(child.events || []).map((e) => e.ts)].filter((n) => Number.isFinite(n));
  return {
    id: store.newId('e_'),
    ts: times.length ? Math.min(...times) : Date.now(),
    type: 'tool_use',
    name: 'delegate_to_provider',
    brokerSynthetic: true,
    title: task.slice(0, 120),
    input: { provider, model, effort, task },
    status: state.status,
    provider,
    model,
    effort,
    childSessionId: child.id,
    subagent: {
      id: child.id,
      name: 'subagent',
      broker: true,
      description: task.slice(0, 120),
      provider,
      model,
      effort,
      status: state.subStatus,
      ...(state.text ? { summary: state.text } : {}),
      ...(state.error ? { error: state.error } : {}),
      // Rebuilt from the child: its recorded request, and what it reported.
      ...subagentPolicy.contract({ requested: child.modelConfig?.model ? { provider, model: child.modelConfig.model, effort: child.modelConfig.effort || '' } : null, actual: childActual(child), reason: subagentPolicy.UNVERIFIED.child }),
    },
  };
}

// A card made for one task that the old last-writer-wins bug left holding
// another child's id: judged by what each was asked, not by the id it holds.
const normTask = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const PLACEHOLDER_TITLES = new Set(['', 'New session', '新對話']);
// Asked on every step the child streams: the verdict depends only on the two
// texts compared, so the last one for each child is remembered by those texts.
const fitsMemo = new WeakMap();
function brokerCardFits(card, child) {
  const rawA = brokerCardTask(card);
  // What the child was asked: its own first words, or a title that is not a
  // placeholder. A child with neither tells nothing, so its card stays.
  const said = lastUserEventWithText(child?.events)?.text;
  const rawB = said || (PLACEHOLDER_TITLES.has(String(child?.title || '').trim()) ? '' : child.title);
  const memo = child && typeof child === 'object' ? fitsMemo.get(child) : null;
  if (memo && memo.a === rawA && memo.b === rawB) return memo.fits;
  const a = normTask(rawA);
  const b = normTask(rawB);
  const fits = !a || !b ? true /* cannot tell: do not move it */ : a === b || a.startsWith(b) || b.startsWith(a);
  if (child && typeof child === 'object') fitsMemo.set(child, { a: rawA, b: rawB, fits });
  return fits;
}
function brokerCardWronglyOwned(card) {
  return brokerCardOwners(card).some((id) => {
    const owner = store.getSession(id);
    return owner && !brokerCardFits(card, owner);
  });
}

function claimBrokerCard(card, child, { force = false } = {}) {
  let changed = false;
  if (force || !card.childSessionId) {
    if (card.childSessionId !== child.id) changed = true;
    card.childSessionId = child.id;
  }
  if (card.subagent && (force || !card.subagent.id)) {
    if (card.subagent.id !== child.id) changed = true;
    card.subagent = { ...card.subagent, id: child.id };
  }
  return changed;
}

// Every step of `child` hangs under `card`. Looking at the whole parent each
// time made every streamed token cost as much as the parent is long, so the
// events already checked for this child and this card are not looked at again:
// steps are only ever added at the end, and a new one is made with its card's
// id. A different card, or an array that changed under the index, starts over.
function reparentBrokerProjections(parent, child, card) {
  const events = parent.events || [];
  const index = syncEvents(events);
  const done = index.reparented.get(child.id);
  const from = done && done.cardId === card.id && done.n <= events.length ? done.n : 0;
  let changed = false;
  for (let i = from; i < events.length; i++) {
    const ev = events[i];
    if (ev.brokerChildId !== child.id || ev.parent === card.id) continue;
    ev.parent = card.id;
    changed = true;
  }
  index.reparented.set(child.id, { cardId: card.id, n: events.length });
  return changed;
}

function brokerLinkFor(child) {
  if (!child?.parentId) return null;
  const parent = store.getSession(child.parentId);
  if (!parent) return null;
  const saved = child.state?.broker;

  // A saved card that belongs to another child is a stale link from the old
  // shared-card bug, not this child's card.
  let card = null;
  if (saved?.parentId === parent.id && saved?.parentEventId) {
    const found = findEvent(parent.events, saved.parentEventId);
    if (found && !isBrokerProjection(found) && !brokerCardOwnedByOther(found, child.id) && brokerCardFits(found, child)) card = found;
  }
  if (card) {
    const claimed = claimBrokerCard(card, child);
    const reparented = reparentBrokerProjections(parent, child, card);
    if (claimed || reparented) {
      parent.seq = (parent.seq || 0) + 1;
      store.saveSession(parent);
      broadcast(reparented ? { t: 'reset', sid: parent.id, seq: parent.seq } : { t: 'patch', sid: parent.id, seq: parent.seq, id: card.id, fields: { childSessionId: card.childSessionId, subagent: card.subagent } });
    }
    if (saved?.parentId !== parent.id || saved?.parentEventId !== card.id) {
      child.state = { ...(child.state || {}), broker: { parentId: parent.id, parentEventId: card.id } };
      store.saveSession(child);
    }
    return { parent, card };
  }

  // Find an existing card this child already owns (a replay may have given
  // it a new id), else an unclaimed native/synthetic card for the same task.
  const task = brokerTaskOf(child);
  card = (parent.events || []).findLast((e) => isDelegateCard(e) && brokerCardOwnedBy(e, child.id) && brokerCardFits(e, child));
  let rehomed = false;
  if (!card) {
    card = (parent.events || []).findLast((e) => isDelegateCard(e) && (brokerCardUnclaimed(e) || brokerCardWronglyOwned(e)) && task && normTask(brokerCardTask(e)) === normTask(task));
    rehomed = Boolean(card) && !brokerCardUnclaimed(card);
  }
  const created = !card;
  if (created) {
    card = makeBrokerCard(child);
    const firstProjection = (parent.events || []).findIndex((e) => e.brokerChildId === child.id);
    parent.events.splice(firstProjection === -1 ? parent.events.length : firstProjection, 0, card);
    forgetEvents(parent.events); // an element was inserted among the indexed ones
  } else {
    claimBrokerCard(card, child, { force: rehomed });
  }
  reparentBrokerProjections(parent, child, card);
  child.state = { ...(child.state || {}), broker: { parentId: parent.id, parentEventId: card.id } };
  store.saveSession(child);
  parent.seq = (parent.seq || 0) + 1;
  store.saveSession(parent);
  // The card id and every step's parent may have changed; a snapshot is the
  // one update that cannot leave a half-reparented card on screen.
  broadcast({ t: 'reset', sid: parent.id, seq: parent.seq });
  return { parent, card };
}

function brokerFields(child, ev, cardId) {
  const clean = cleanBrokerValue(ev) || {};
  return { ...clean, id: brokerProjectedId(child.id, ev.id), parent: cardId, brokerChildId: child.id, brokerEventId: ev.id };
}

function projectBrokerEvent(child, ev) {
  if (!ev?.id || isBrokerProjection(ev)) return null;
  const link = brokerLinkFor(child);
  if (!link) return null;
  const fields = brokerFields(child, ev, link.card.id);
  let pev = findEvent(link.parent.events, fields.id);
  const created = !pev;
  if (created) {
    link.parent.events.push(fields);
    pev = fields;
  } else Object.assign(pev, fields);
  link.parent.seq = (link.parent.seq || 0) + 1;
  store.saveSession(link.parent);
  broadcast(created ? { t: 'event', sid: link.parent.id, seq: link.parent.seq, ev: fields } : { t: 'patch', sid: link.parent.id, seq: link.parent.seq, id: fields.id, fields });
  return pev;
}

function projectBrokerPatch(child, ev, fields) {
  if (!ev?.id || isBrokerProjection(ev)) return null;
  const link = brokerLinkFor(child);
  if (!link) return null;
  const id = brokerProjectedId(child.id, ev.id);
  const pev = findEvent(link.parent.events, id);
  if (!pev) return projectBrokerEvent(child, ev);
  const clean = cleanBrokerValue(fields) || {};
  delete clean.brokerChildId;
  delete clean.brokerEventId;
  const projected = { ...clean, id, parent: link.card.id, brokerChildId: child.id, brokerEventId: ev.id };
  Object.assign(pev, projected);
  link.parent.seq = (link.parent.seq || 0) + 1;
  store.saveSession(link.parent);
  broadcast({ t: 'patch', sid: link.parent.id, seq: link.parent.seq, id, fields: projected });
  return pev;
}

function projectBrokerDelta(child, ev, text, field) {
  if (!ev?.id || isBrokerProjection(ev)) return null;
  const link = brokerLinkFor(child);
  if (!link) return null;
  const id = brokerProjectedId(child.id, ev.id);
  const pev = findEvent(link.parent.events, id);
  if (!pev) return projectBrokerEvent(child, ev);
  const safe = scrubBrokerText(text);
  if (!safe) return pev;
  const next = `${pev[field] || ''}${safe}`;
  if (next === (ev[field] || '')) {
    pev[field] = next;
    link.parent.seq = (link.parent.seq || 0) + 1;
    store.saveSession(link.parent);
    broadcast({ t: 'delta', sid: link.parent.id, seq: link.parent.seq, id, field, text: safe });
  } else {
    return projectBrokerPatch(child, ev, { [field]: ev[field] });
  }
  return pev;
}

function stableJson(value) {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

// A transport failure may have marked the parent card before the child
// reached its real end. Reconcile old cards from that end, never from a stale
// turn or a child that is still working.
function reconcileBrokerCard(child, { parent, card }) {
  if (['running', 'awaiting_permission'].includes(child.status)) return false;
  const end = (child.events || []).findLast((e) => e.type === 'turn_end');
  if (!end || !card.subagent) return false;
  const status = end.interrupted ? 'interrupted' : end.error ? 'error' : 'done';
  const subStatus = end.interrupted ? 'cancelled' : end.error ? 'error' : 'done';
  const text = (child.events || []).findLast((e) => e.type === 'text' && String(e.text || '').trim())?.text?.trim();
  const isError = Boolean(end.error);
  if (card.status === status && card.subagent.status === subStatus && card.isError === isError && (!text || card.subagent.summary === text)) return false;
  const error = isError ? (child.events || []).findLast((e) => e.type === 'error' && e.text)?.text || card.subagent.error || card.output : null;
  patch(parent, card, {
    status,
    isError,
    ...(text ? { output: text } : {}),
    subagent: { ...card.subagent, status: subStatus, ...(text ? { summary: text } : {}), error },
  });
  return true;
}

// Native replay replaces a child's events wholesale. Only that child's
// projections are rebuilt; the parent's own events and other children stay.
function rebuildBrokerProjection(child) {
  if (!child?.parentId) return false;
  const link = brokerLinkFor(child);
  if (!link) return false;
  const reconciled = reconcileBrokerCard(child, link);
  const current = link.parent.events.filter((e) => e.brokerChildId === child.id);
  const next = (child.events || []).filter((e) => !isBrokerProjection(e)).map((e) => brokerFields(child, e, link.card.id));
  if (stableJson(current) === stableJson(next)) return reconciled;
  link.parent.events = link.parent.events.filter((e) => e.brokerChildId !== child.id).concat(next);
  link.parent.seq = (link.parent.seq || 0) + 1;
  store.saveSession(link.parent);
  broadcast({ t: 'reset', sid: link.parent.id, seq: link.parent.seq });
  return true;
}

function restoreBrokerProjections() {
  for (const child of store.listSessions()) if (child.parentId) rebuildBrokerProjection(child);
}

// Native history replays a whole transcript with new event ids. The broker
// card a child points at may come back as a new event: re-link it by tool
// call / task text, or keep the old card when the replay has no equivalent.
function reattachBrokerCards(session, previous) {
  for (const child of store.listSessions()) {
    if (child.parentId !== session.id) continue;
    const oldId = child.state?.broker?.parentEventId;
    let source = oldId ? previous.find((e) => e.id === oldId) : null;
    // A stale link may point at a card that now belongs to another child:
    // never reuse it, and let brokerLinkFor build/find this child's own card.
    if (source && (isBrokerProjection(source) || brokerCardOwnedByOther(source, child.id))) source = null;
    if (!source) source = previous.find((e) => isDelegateCard(e) && brokerCardOwnedBy(e, child.id));
    if (!source || session.events.some((e) => e.id === source.id)) continue;
    const task = brokerCardTask(source);
    const match = session.events.find((e) => isDelegateCard(e) && !brokerCardOwnedByOther(e, child.id) && (
      (source.toolCallId && e.toolCallId === source.toolCallId)
      || (task && brokerCardTask(e) === task)
      || (source.title && e.title === source.title)
    ));
    if (!match) {
      if (brokerCardUnclaimed(source)) claimBrokerCard(source, child);
      session.events.push(source);
      continue;
    }
    Object.assign(match, {
      childSessionId: child.id,
      provider: source.provider,
      model: source.model,
      effort: source.effort,
      status: source.status,
      isError: source.isError,
      output: source.output,
      title: source.title || match.title,
      subagent: { ...(match.subagent || {}), ...(source.subagent || {}), id: child.id, broker: true },
    });
    child.state = { ...(child.state || {}), broker: { parentId: session.id, parentEventId: match.id } };
    store.saveSession(child);
  }
}

// An MCP/tool result may arrive after the broker child already finished (the
// local transport was interrupted, say). It must not replace the child's own
// final state; while the child is still working, the card keeps showing it.
function guardBrokerStatus(ev, fields) {
  const sub = ev?.subagent;
  if (!sub?.broker || !fields || !Object.hasOwn(fields, 'status') || Object.hasOwn(fields, 'subagent')) return fields;
  const running = sub.status === 'running' || sub.status === 'pending';
  const done = sub.status === 'done';
  const cancelled = ['cancelled', 'stopped', 'suspended'].includes(sub.status);
  if (!(running && ['done', 'error', 'interrupted'].includes(fields.status)) && !(done && fields.status !== 'done') && !(cancelled && fields.status === 'done')) return fields;
  const next = { ...fields };
  delete next.status;
  delete next.isError;
  return next;
}

function syntheticBrokerCard(session, fields) {
  if (fields.type !== 'tool_use' || !fields.input || typeof fields.input !== 'object') return null;
  if (!/delegate|mcp__agent-hub|broker/i.test(fields.name || '')) return null;
  const task = String(fields.input.task || '').trim();
  if (!task) return null;
  return (session.events || []).findLast((e) => e.brokerSynthetic && !e.brokerChildId && e.type === 'tool_use' && String(e.input?.task || '').trim() === task) || null;
}

function emit(session, fields) {
  // The one place an event enters the Hub: nothing past this line, not the
  // store, the stream to the browser or the API, ever holds a credential.
  fields = redactDeep(fields);
  // A delegation that is starting now always gets a card of its own, even
  // when a previous parallel call used the same task text. The flag is not
  // persisted; it only turns off the late-frame merge for this one event.
  const fresh = Boolean(fields.brokerFresh);
  if (fresh) {
    const { brokerFresh, ...rest } = fields;
    fields = rest;
  }
  // The MCP request can reach the Hub before Kimi's own tool frame. Merge
  // that late frame into the card the broker already made instead of
  // showing two cards for one delegation.
  const synthetic = fresh ? null : syntheticBrokerCard(session, fields);
  if (synthetic) {
    const merged = { ...fields, id: synthetic.id, ts: synthetic.ts, title: synthetic.title || fields.title, parent: synthetic.parent, subagent: { ...(synthetic.subagent || {}), ...(fields.subagent || {}) } };
    delete merged.brokerSynthetic;
    Object.assign(synthetic, merged);
    delete synthetic.brokerSynthetic;
    session.seq = (session.seq || 0) + 1;
    store.saveSession(session);
    broadcast({ t: 'patch', sid: session.id, seq: session.seq, id: synthetic.id, fields: merged });
    projectBrokerPatch(session, synthetic, merged);
    return synthetic;
  }
  const ev = { id: store.newId('e_'), ts: Date.now(), ...fields };
  session.events.push(ev);
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  broadcast({ t: 'event', sid: session.id, seq: session.seq, ev });
  projectBrokerEvent(session, ev);
  return ev;
}

function patch(session, ev, fields) {
  fields = guardBrokerStatus(ev, redactDeep(fields));
  if (!Object.keys(fields).length) return;
  Object.assign(ev, fields);
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  broadcast({ t: 'patch', sid: session.id, seq: session.seq, id: ev.id, fields });
  projectBrokerPatch(session, ev, fields);
}

function delta(session, ev, text, field = 'text') {
  if (!text) return;
  // Pieces of one field are masked as a whole: a secret cut between two
  // pieces is caught when it completes, and the page is then told to replace
  // the field instead of appending to it.
  const r = appendRedacted(ev, field, text);
  session.seq = (session.seq || 0) + 1;
  store.saveSession(session);
  if (r.replaced) {
    broadcast({ t: 'patch', sid: session.id, seq: session.seq, id: ev.id, fields: { [field]: ev[field] } });
    projectBrokerPatch(session, ev, { [field]: ev[field] });
    return;
  }
  broadcast({ t: 'delta', sid: session.id, seq: session.seq, id: ev.id, field, text: r.delta });
  projectBrokerDelta(session, ev, r.delta, field);
}

// ----------------------------------------------------------- agents

// Agents come from the store, plus one virtual "Kimi Code" agent per machine
// connected through the bridge.
export function remoteAgents() {
  return machines.listMachines().map((m) => ({
    id: `kimi@${m.id}`,
    name: `Kimi Code · ${m.name}`,
    type: 'kimi-remote',
    machineId: m.id,
    enabled: true,
    remote: true,
  }));
}

export function agentFor(id) {
  if (String(id).startsWith('kimi@')) return remoteAgents().find((a) => a.id === id) || null;
  // Claude through the Claude API (claude-account.js), run by the hub here.
  if (id === ADAPTERS.claude.AGENT.id) return ADAPTERS.claude.AGENT;
  return store.getAgent(id);
}

const adapterFor = (session) => ADAPTERS[agentFor(session.agentId)?.type];

// ------------------------------------------------------- model catalog
// Every choice the browser can make is checked here against the provider's
// real, currently configured models. Explicit choices fail; only an omitted
// model/effort may fall back to that provider's default.

const PROVIDER_LABEL = { kimi: 'Kimi', claude: 'Claude', deepseek: 'DeepSeek' };
const PROVIDERS = ['kimi', 'claude', 'deepseek'];

export function firstKimiMachine() {
  return machines.listMachines().find((m) => m.online && m.kimi?.server) || null;
}

function targetMachine(session, machineId) {
  return machineId || session?.machineId || firstKimiMachine()?.id || null;
}

async function modelsForProvider(provider, { session = null, machineId = null } = {}) {
  if (provider === 'claude') {
    if (!claudeAccount.apiKey()) {
      const err = new Error(claudeAccount.keyProblem() || '還沒有設定 Claude API key');
      err.status = 409;
      err.code = claudeAccount.keyProblem() ? 'key_unusable' : 'no_key';
      throw err;
    }
    const list = await claudeAccount.models();
    return {
      defaultModel: claudeAccount.DEFAULT_MODEL,
      models: list.map((m) => ({ ...m, provider: 'claude' })),
    };
  }
  if (provider === 'deepseek') {
    if (!deepseek.apiKey()) {
      const err = new Error(deepseek.keyProblem() || '還沒有設定 DeepSeek 的 API key');
      err.status = 409;
      err.code = deepseek.keyProblem() ? 'key_unusable' : 'no_key';
      throw err;
    }
    const d = deepseek.models();
    return {
      defaultModel: d.defaultModel,
      models: d.models.map((m) => ({ ...m, id: m.id, alias: deepseek.aliasFor(m.id), provider: 'deepseek' })),
    };
  }
  if (provider !== 'kimi') throw Object.assign(new Error(`不支援的供應商：${provider}`), { status: 400 });
  const mid = targetMachine(session, machineId);
  if (!mid) throw Object.assign(new Error('需要連接一台有 Kimi 的電腦'), { status: 409 });
  const machine = machines.getMachine(mid);
  if (!machine?.online) throw Object.assign(new Error(`「${machine?.name || mid}」目前離線`), { status: 409 });
  if (!machine.kimi?.server) throw Object.assign(new Error(`「${machine.name}」上沒有執行中的 Kimi（先在那台電腦執行 kimi web 或用「連接電腦」啟動）`), { status: 409 });
  const { models, defaultModel } = await ADAPTERS['kimi-remote'].modelsFor(mid);
  return { defaultModel, models: models.filter((m) => !m.deepseek).map((m) => ({ ...m, provider: 'kimi' })) };
}

export async function providerGroups({ session = null, machineId = null } = {}) {
  const groups = [];
  for (const provider of PROVIDERS) {
    try {
      const r = await modelsForProvider(provider, { session, machineId });
      groups.push({ provider, label: PROVIDER_LABEL[provider], available: true, reason: '', defaultModel: r.defaultModel, models: r.models });
    } catch (err) {
      let models = [];
      // A missing key still lets the UI show the known choices, but the
      // group is explicitly unavailable and cannot be selected.
      try {
        if (provider === 'claude') models = (await claudeAccount.models()).map((m) => ({ ...m, provider }));
        if (provider === 'deepseek') models = deepseek.models().models.map((m) => ({ ...m, alias: deepseek.aliasFor(m.id), provider }));
      } catch {}
      groups.push({ provider, label: PROVIDER_LABEL[provider], available: false, reason: err.message, defaultModel: '', models });
    }
  }
  return { groups, provider: session ? providerOf(session) : null, session: session?.id || null, machineId: machineId || session?.machineId || null };
}

// Returns a normalized choice {provider, model, effort}. `model` for
// DeepSeek is the Kimi alias (what its session profile takes); the raw
// gateway id is accepted from the browser too.
export async function validateChoice({ provider, model = '', effort = '', session = null, machineId = null, allowEmptyModel = false } = {}) {
  if (!PROVIDERS.includes(provider)) throw Object.assign(new Error(`不支援的供應商：${String(provider).slice(0, 40)}`), { status: 400 });
  const r = await modelsForProvider(provider, { session, machineId });
  let id = String(model || '').trim();
  if (provider === 'deepseek') {
    // The gateways spell one model differently and a conversation keeps the
    // spelling it chose with: the other gateway's spelling of a model the
    // gateway in use has is that model, written the way this gateway has it.
    // Only a model this gateway really lacks is refused, with who has it.
    const here = id ? deepseek.idAt(deepseek.gateway(), id) : null;
    if (here) id = here;
    else if (!id && allowEmptyModel) id = r.defaultModel;
    else throw Object.assign(new Error((id && deepseek.notAtGateway(id)) || `${PROVIDER_LABEL[provider]} 沒有 ${id || '（空白）'} 這個模型`), { status: 400 });
    id = deepseek.aliasFor(deepseek.bareId(id));
  } else {
    const hit = r.models.find((m) => m.id === id);
    if (!hit) {
      if (!id && allowEmptyModel) id = r.defaultModel;
      else throw Object.assign(new Error(`${PROVIDER_LABEL[provider]} 沒有 ${id || '（空白）'} 這個模型`), { status: 400 });
    }
  }
  const chosen = r.models.find((m) => m.id === id || m.alias === id) || null;
  let e = effort == null ? '' : String(effort);
  if (e && chosen && !(chosen.efforts || []).includes(e)) throw Object.assign(new Error(`${chosen.name || id} 不支援思考強度「${e}」`), { status: 400 });
  if (!e && chosen?.defaultEffort && chosen.efforts?.includes(chosen.defaultEffort)) e = chosen.defaultEffort;
  return { provider, model: id, effort: e };
}

export async function normalizeSubagent(input, { session = null, machineId = null } = {}) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('子代理設定格式不正確'), { status: 400 });
  const provider = String(input.provider || '');
  if (!PROVIDER_LABEL[provider]) throw Object.assign(new Error('子代理供應商必須是 Kimi、Claude 或 DeepSeek'), { status: 400 });
  const model = String(input.model || '').trim();
  if (!model) throw Object.assign(new Error('請選一個子代理模型'), { status: 400 });
  const choice = await validateChoice({ provider, model, effort: input.effort, session, machineId, allowEmptyModel: false });
  return { provider: choice.provider, model: choice.model, effort: choice.effort || '' };
}

export function defaultSubagent() {
  const ids = deepseek.modelIds();
  const id = ids.find((x) => /deepseek-v4\.1-flash$/i.test(x)) || deepseek.models().defaultModel;
  return { provider: 'deepseek', model: deepseek.aliasFor(id), effort: 'max' };
}

export function ensureDefaultSubagent(session) {
  if (session.state?.subagentExplicit || Object.hasOwn(session.meta || {}, 'subagent')) return;
  session.meta = { ...(session.meta || {}), subagent: defaultSubagent() };
  // A default filled in on an old conversation is not activity in it.
  store.saveSession(session, { touch: false });
}

// Context for live adapters (Kimi on a remote machine), which push events at
// any time rather than only inside a hub-started turn.
export function liveContext(session) {
  return {
    session,
    emit: (fields) => emit(session, fields),
    patch: (ev, fields) => patch(session, ev, fields),
    delta: (ev, text, field) => delta(session, ev, text, field),
    setStatus: (st) => setStatus(session, st),
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    setTitle(title) {
      if (!title || title === session.title) return;
      session.title = title;
      session.titled = true;
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    replaceEvents(events) {
      events = events.map((e) => redactDeep(e));
      // Native history has no Hub-made steps. Keep the mirrors that are still
      // backed by a child event (this may be a parent or a child replay).
      const previous = session.events || [];
      const incoming = new Set(events.map((e) => e.id));
      const kept = previous.filter((e) => {
        if (!e.brokerChildId || incoming.has(e.id)) return false;
        const child = store.getSession(e.brokerChildId);
        return Boolean(child?.events?.some((x) => x.id === e.brokerEventId));
      });
      session.events = kept.length ? [...events, ...kept] : events;
      reattachBrokerCards(session, previous);
      session.seq = (session.seq || 0) + 1;
      store.saveSession(session);
      broadcast({ t: 'reset', sid: session.id, seq: session.seq });
      rebuildBrokerProjection(session);
      for (const child of store.listSessions()) if (child.parentId === session.id) rebuildBrokerProjection(child);
    },
    // An event made elsewhere (a Claude daemon), kept as it is.
    insert(ev) {
      ev = redactDeep(ev);
      session.events.push(ev);
      session.seq = (session.seq || 0) + 1;
      store.saveSession(session);
      broadcast({ t: 'event', sid: session.id, seq: session.seq, ev });
      projectBrokerEvent(session, ev);
      return ev;
    },
  };
}
ADAPTERS['kimi-remote'].init(liveContext);
ADAPTERS.claude.init(liveContext);
// DS2's daemon Task path uses this instead of importing the runner (and
// creating a cycle); the fallback import still works without it.
ADAPTERS.claude.setBroker?.(delegateToProvider);

// A conversation's record of its DeepSeek model, rewritten in the spelling of the
// gateway the names follow now (see modelDrift.respellRecord). A turn in progress,
// or a switch being made, is left alone; the next pass (or the next message, which
// does it for its own conversation) gets it. Returns how many conversations changed.
export function respellDeepseekRecords() {
  let n = 0;
  for (const s of store.listLeaves()) {
    if (running.has(s.id) || ['running', 'awaiting_permission'].includes(s.status) || s.state?.pendingSwitching || switching.has(conversationOf(s))) continue;
    if (!modelDrift.respellRecord(s)) continue;
    // A rewrite of the record is bookkeeping, not activity (the sidebar sorts on updatedAt).
    store.saveSession(s, { touch: false });
    broadcast({ t: 'session', session: summarize(s) });
    n++;
  }
  return n;
}
deepseek.onGatewayChange(() => respellDeepseekRecords());

export function restoreLiveSessions() {
  // Repairing an old store is bookkeeping, not activity: nothing saved here
  // may move a conversation's updatedAt (the sidebar sorts on it).
  store.quietly(() => {
    // A node that was still being made when the Hub stopped never became part
    // of its chain: remove it (and its runtime sessions) before anything else
    // looks at it. The old node it came from is still the leaf.
    reclaimProvisionalNodes();
    // Messages set to go out later, and a quota-pause wait, sitting on a node
    // an earlier version left behind: they belong to the leaf now.
    adoptStrandedAutomation();
    // A switch interrupted by a hub restart is not "in progress" any more.
    // Keep the pending target; it is attempted once the machine is online.
    for (const s of store.listSessions()) {
      if (!s.state?.pendingSwitching) continue;
      delete s.state.pendingSwitching;
      store.saveSession(s);
    }
    for (const s of store.listSessions()) ensureDefaultSubagent(s);
    // The names may have changed gateway while nothing rewrote the records (a Hub
    // from before that did), or a turn was running when they did.
    respellDeepseekRecords();
    // A restart keeps both halves of a broker conversation on disk; rebuild a
    // missing/partial mirror for children created before this link existed.
    restoreBrokerProjections();
    for (const s of store.listSessions()) if (s.kimiSessionId) ADAPTERS['kimi-remote'].restore(s);
    for (const s of store.listSessions()) if (s.agentId === ADAPTERS.claude.AGENT.id) ADAPTERS.claude.restore(s);
    ADAPTERS.claude.start();
  });
  machines.onMachineOnline((machineId) => {
    ADAPTERS['kimi-remote'].onMachineOnline?.(machineId, store.listSessions());
    flushOrphanNatives(machineId);
    resumePendingSwitches(machineId);
  });
  // After a restart the Hub thinks a conversation is idle while Kimi may still
  // be working on it; a waiting switch goes ahead when Kimi says it stopped.
  machines.onSessionChange((machineId, entry) => {
    if (entry?.busy) return;
    const id = ADAPTERS['kimi-remote'].findByKimi?.(machineId, entry?.id);
    const s = id && store.getSession(id);
    if (s?.state?.pendingProvider) applyPendingSwitch(s).catch((err) => console.warn(`[runner] pending switch ${s.id}: ${err.message}`));
  });
  // The list is in: whatever was waiting for it may go ahead, and so may what
  // waited for an old bridge that never lists.
  machines.onSessionsListed((machineId) => resumePendingSwitches(machineId));
  machines.onMachineOnline((machineId) => setTimeout(() => resumePendingSwitches(machineId), machines.SESSIONS_WAIT_MS + 500).unref?.());
  resumePendingSwitches();
}

// Kimi sessions made for a continuation that never completed. Archived when
// their machine can be reached (best effort, and said in the log if it fails).
const orphanNatives = new Map(); // machineId -> Set(kimiSessionId)
function archiveOrphanNative(machineId, kimiSessionId) {
  (orphanNatives.get(machineId) || orphanNatives.set(machineId, new Set()).get(machineId)).add(kimiSessionId);
  if (machines.getMachine(machineId)?.online) flushOrphanNatives(machineId);
}
function flushOrphanNatives(machineId) {
  const ids = orphanNatives.get(machineId);
  if (!ids?.size) return;
  for (const kid of [...ids]) {
    ids.delete(kid);
    ADAPTERS['kimi-remote'].ensureServer(machineId)
      .then(() => machines.kimiApi(machineId, 'POST', `/api/v1/sessions/${kid}:archive`, {}))
      .catch((err) => console.warn(`[runner] could not archive the unused Kimi session ${kid} on ${machineId}: ${err.message}`));
  }
}

function adoptStrandedAutomation() {
  for (const node of store.listSessions()) {
    if (store.isLeaf(node) || node.provisional) continue;
    const leaf = store.leafOf(node);
    if (!leaf || leaf === node) continue;
    if (node.scheduled?.length) {
      leaf.scheduled = [...(leaf.scheduled || []), ...node.scheduled].sort((a, b) => a.at - b.at);
      node.scheduled = [];
      store.saveSession(node);
      store.saveSession(leaf);
      liveContext(leaf).emit({ type: 'info', text: `原本排在先前節點上的 ${leaf.scheduled.length} 則定時送出訊息，現在會送到這個對話。` });
    }
    if (autoPauseActive(node.autoPause)) {
      node.autoPause = null;
      store.saveSession(node);
      liveContext(leaf).emit({ type: 'info', text: '先前節點上的自動暫停／額度恢復後送出已取消：它只適用於 Kimi 訂閱的對話。需要的話請在這個對話重新設定。' });
    }
  }
}

function reclaimProvisionalNodes() {
  for (const node of store.listSessions().filter((x) => x.provisional)) {
    const upstream = node.continuedFrom && store.getSession(node.continuedFrom);
    if (upstream && upstream.continuedTo === node.id) {
      upstream.continuedTo = null;
      store.saveSession(upstream);
    }
    try {
      adapterFor(node)?.dispose?.(node);
    } catch {}
    store.deleteSession(node.id);
    console.warn(`[runner] removed an unfinished continuation node ${node.id} (the Hub stopped while it was being made)`);
    if (node.kimiSessionId && node.machineId) archiveOrphanNative(node.machineId, node.kimiSessionId);
  }
}

// Plain-text transcript of a conversation. It follows the continuation chain
// and uses the same deterministic, redacted projection as a runtime hand-off.
export function transcriptText(session, { maxChars = 12_000, beforeIndex } = {}) {
  return handoff.chainTranscript(session, { maxChars, beforeIndex }).text;
}

// --------------------------------------------------------------- tools

function delegateDef(session) {
  const others = store
    .listAgents()
    .filter((a) => a.enabled && a.id !== session.agentId && ADAPTERS[a.type]?.available(a).ok);
  if (!others.length || (session.depth ?? 0) > 0) return null;
  return {
    name: 'delegate_to_agent',
    kind: 'delegate',
    description:
      'Hand a self-contained sub-task to another agent connected to the hub. It works in the same workspace and its final answer is returned to you. Use it to get a second opinion, parallelize, or use a specialist. Available agents:\n' +
      others.map((a) => `- ${a.id}: ${a.name} (${a.type}${a.model ? `, ${a.model}` : ''})`).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', enum: others.map((a) => a.id), description: 'Which agent to delegate to.' },
        task: { type: 'string', description: 'A complete, self-contained description of the sub-task.' },
      },
      required: ['agent_id', 'task'],
    },
  };
}

export function toolDefsFor(session) {
  const d = delegateDef(session);
  return d ? [...TOOL_DEFS, d] : [...TOOL_DEFS];
}

function needsPermission(session, name) {
  if (session.allowedTools?.includes(name)) return false;
  const kind = toolKind(name);
  if (kind === 'read') return false;
  if (session.permissionMode === 'bypass') return false;
  if (session.permissionMode === 'auto_edits' && kind === 'edit') return false;
  return true;
}

export function toolTitle(name, input = {}) {
  switch (name) {
    case 'bash':
      return input.command;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return input.path;
    case 'list_files':
      return input.path || '.';
    case 'search':
      return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'delegate_to_agent':
      return `→ ${input.agent_id}: ${String(input.task || '').slice(0, 120)}`;
    default:
      return typeof input === 'string' ? input : JSON.stringify(input).slice(0, 160);
  }
}

// --------------------------------------------------------------- turns

function makeContext(session, agent, ac) {
  const ctx = {
    session,
    agent,
    cwd: session.cwd,
    signal: ac.signal,
    state: session.state,
    turnUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    emit: (fields) => emit(session, fields),
    patch: (ev, fields) => patch(session, ev, fields),
    delta: (ev, text, field) => delta(session, ev, text, field),
    addUsage({ inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
      ctx.turnUsage.inputTokens += inputTokens;
      ctx.turnUsage.outputTokens += outputTokens;
      ctx.turnUsage.costUsd += costUsd;
    },
    toolDefs: () => toolDefsFor(session),
    // Show a choice on the tool card and wait for the user. `options` follow
    // the ACP PermissionOption shape ({ optionId, name, kind }), so an ACP
    // agent's own buttons are shown verbatim. Resolves to the chosen optionId,
    // or null if the turn was interrupted.
    async askUser(ev, options) {
      const prevStatus = ev.status;
      patch(session, ev, { status: 'awaiting', permission: { options, chosen: null } });
      setStatus(session, 'awaiting_permission');
      const key = `${session.id}:${ev.id}`;
      const chosen = await new Promise((resolve) => {
        if (ac.signal.aborted) return resolve(null);
        pendingPermissions.set(key, resolve);
        ac.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      pendingPermissions.delete(key);
      if (!ac.signal.aborted) setStatus(session, 'running');
      patch(session, ev, {
        status: prevStatus === 'awaiting' ? 'pending' : prevStatus,
        permission: { options, chosen: chosen ?? 'cancelled' },
      });
      return chosen;
    },
    // Permission gate for hub-provided tools. Resolves to 'allow' | 'deny'.
    async requestPermission(ev) {
      if (!needsPermission(session, ev.name)) return 'allow';
      const chosen = await ctx.askUser(ev, [
        { optionId: 'allow', name: '允許', kind: 'allow_once' },
        { optionId: 'always', name: `本 session 一律允許 ${ev.name}`, kind: 'allow_always' },
        { optionId: 'deny', name: '拒絕', kind: 'reject_once' },
      ]);
      if (chosen === 'always' && !session.allowedTools.includes(ev.name)) session.allowedTools.push(ev.name);
      return chosen === 'allow' || chosen === 'always' ? 'allow' : 'deny';
    },
    // Agent-reported metadata (modes, models, slash commands, context usage)
    // shown in the UI next to the composer.
    setMeta(fields) {
      session.meta = { ...(session.meta || {}), ...fields };
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    setTitle(title) {
      if (!title) return;
      session.title = title;
      session.titled = true;
      store.saveSession(session);
      broadcast({ t: 'session', session: summarize(session) });
    },
    // Validate → permission → execute → record, for hub-provided tools.
    async runTool(name, input, ev) {
      ev ??= emit(session, { type: 'tool_use', name, input, title: toolTitle(name, input), status: 'pending' });
      const def = toolDefsFor(session).find((t) => t.name === name);
      if (!def) {
        patch(session, ev, { status: 'error', output: `Unknown tool "${name}"`, isError: true });
        return { output: `Unknown tool "${name}"`, isError: true };
      }
      const invalid = validateInput(def.parameters, input);
      if (invalid) {
        const output = `Invalid input: ${invalid}. Received: ${JSON.stringify(input).slice(0, 500)}`;
        patch(session, ev, { status: 'error', output, isError: true });
        return { output, isError: true };
      }
      const decision = await ctx.requestPermission(ev);
      if (decision === 'deny') {
        const output = ac.signal.aborted ? 'Interrupted by user.' : 'The user denied this tool call. Ask them how to proceed or try a different approach.';
        patch(session, ev, { status: ac.signal.aborted ? 'interrupted' : 'denied', output, isError: true });
        return { output, isError: true };
      }
      patch(session, ev, { status: 'running', output: '' });
      let result;
      if (name === 'delegate_to_agent') {
        result = await delegate(session, input, ev, ac.signal);
      } else {
        let pending = '';
        let timer = null;
        result = await executeTool(name, input, {
          cwd: session.cwd,
          signal: ac.signal,
          // Stream long-running command output into the card, batched.
          onData: (chunk) => {
            pending += chunk;
            timer ??= setTimeout(() => {
              delta(session, ev, pending, 'output');
              pending = '';
              timer = null;
            }, 150);
          },
        });
        clearTimeout(timer);
      }
      patch(session, ev, { status: result.isError ? 'error' : 'done', output: result.output, isError: result.isError });
      return result;
    },
    previousTranscript: () => transcriptText(session, { beforeIndex: ctx.turnStartIndex - 1 }),
    turnStartIndex: 0,
  };
  return ctx;
}

async function delegate(parent, input, ev, signal) {
  const agent = store.getAgent(input.agent_id);
  if (!agent) return { output: `No agent with id "${input.agent_id}"`, isError: true };
  const child = store.createSession({
    agentId: agent.id,
    cwd: parent.cwd,
    branch: parent.branch,
    parentId: parent.id,
    origin: 'external',
    depth: (parent.depth ?? 0) + 1,
    permissionMode: parent.permissionMode,
    title: String(input.task).slice(0, 80),
  });
  broadcast({ t: 'session', session: summarize(child) });
  patch(parent, ev, { childSessionId: child.id });
  const onAbort = () => interrupt(child.id);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const { text, error } = await runTurn(child, input.task);
    if (error) return { output: `${agent.name} failed: ${error}\n${text}`.trim(), isError: true };
    return { output: text || `(${agent.name} finished without a text answer)`, isError: false };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function runTurn(session, text, opts = {}) {
  if (running.has(session.id)) throw Object.assign(new Error('這個 session 正在執行中'), { status: 409 });
  const agent = agentFor(session.agentId);
  if (!agent) throw Object.assign(new Error(`找不到 agent：${session.agentId}`), { status: 400 });
  const adapter = ADAPTERS[agent.type];
  if (!adapter) throw Object.assign(new Error(`不支援的 agent 類型：${agent.type}`), { status: 400 });

  const ac = new AbortController();
  running.set(session.id, { ac });
  snapshotTurn(session);
  const images = (opts.images || []).slice(0, 8);
  emit(session, { type: 'user', text, images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) });
  if (!session.titled) {
    session.title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || session.title;
    session.titled = true;
  }
  setStatus(session, 'running');

  const ctx = makeContext(session, agent, ac);
  ctx.turnStartIndex = session.events.length;
  const started = Date.now();
  let error = null;
  try {
    const availability = adapter.available(agent);
    if (!availability.ok) throw new Error(availability.reason);
    await adapter.run(ctx, text, { images });
  } catch (err) {
    if (ac.signal.aborted) {
      emit(session, { type: 'info', text: '已中斷' });
    } else {
      error = err.message || String(err);
      emit(session, { type: 'error', text: error });
    }
  } finally {
    running.delete(session.id);
    for (const ev of session.events.slice(ctx.turnStartIndex)) {
      // A broker child's projected step belongs to the child; the parent
      // ending (or its transport failing) says nothing about that step.
      if (ev.brokerChildId) continue;
      // Tool calls the agent never closed: interrupted if the user stopped
      // the turn, otherwise left neutral rather than guessing an outcome.
      if (ev.type === 'tool_use' && ['pending', 'running', 'awaiting'].includes(ev.status)) {
        patch(session, ev, { status: ac.signal.aborted || ev.status === 'awaiting' ? 'interrupted' : 'ended' });
      }
    }
    const u = ctx.turnUsage;
    session.usage.inputTokens += u.inputTokens;
    session.usage.outputTokens += u.outputTokens;
    session.usage.costUsd += u.costUsd;
    emit(session, { type: 'turn_end', durationMs: Date.now() - started, usage: u, interrupted: ac.signal.aborted, error: Boolean(error) });
    setStatus(session, error ? 'error' : 'idle');
    store.saveSession(session, { immediate: true });
  }
  const turnText = session.events
    .slice(ctx.turnStartIndex)
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('\n\n')
    .trim();
  return { text: turnText, error };
}

// Wait for a live adapter's native turn. Live adapters push status/events
// themselves; runTurn's adapter.run contract does not apply to them.
async function runLiveTurn(session, text, opts = {}) {
  const adapter = adapterFor(session);
  snapshotTurn(session);
  const start = session.events.length;
  let sawRunning = ['running', 'awaiting_permission'].includes(session.status);
  let settle = null;
  let timedOut = false;
  const done = new Promise((resolve) => (settle = resolve));
  const off = onStatus((s) => {
    if (s.id !== session.id) return;
    if (['running', 'awaiting_permission'].includes(s.status)) sawRunning = true;
    if (sawRunning && (s.status === 'idle' || s.status === 'error')) settle();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    settle();
  }, Math.max(1000, Number(opts.timeoutMs) || 30 * 60_000));
  timer.unref?.();
  try {
    const r = await adapter.send(session, text, opts);
    if (r?.ok === false) throw new Error(r.error || '訊息沒有送出');
    // A very fast fake/live turn may finish before the first status event.
    if (!sawRunning && session.events.slice(start).some((e) => e.type === 'turn_end')) settle();
    await done;
    if (timedOut) throw new Error('子代理回合逾時');
    const events = session.events.slice(start);
    const out = events.filter((e) => e.type === 'text' && e.text).map((e) => e.text).join('\n\n').trim();
    const err = events.find((e) => e.type === 'error');
    const end = [...events].reverse().find((e) => e.type === 'turn_end');
    const error = err?.text || (end?.interrupted ? '已中斷' : null) || (end?.error ? '回合失敗' : null);
    return { text: out, error };
  } finally {
    clearTimeout(timer);
    off();
  }
}

// 本回合實際使用: what the turn that is starting uses, fixed when it starts
// (spec 2.2 / 6). Called by whatever starts a turn from the hub: a user
// message, an auto-send (自動暫停 「繼續」, 定時送出). A turn Kimi starts
// itself, or the next queued message's turn, is snapshotted by its adapter
// when the native turn starts. While a turn is running its snapshot is the
// truth and is left alone: a message sent (or settings changed) during it
// belongs to the next turn.
function snapshotTurn(session) {
  if (WORKING.includes(session.status)) return false;
  const mc = session.modelConfig || {};
  session.meta = {
    ...(session.meta || {}),
    turnProvider: providerOf(session),
    turnModel: mc.model || session.meta?.model || '',
    turnEffort: mc.effort || session.meta?.effort || '',
    turnSubagent: session.meta?.subagent || null,
  };
  store.saveSession(session);
  return true;
}

// Start a turn without waiting for the answer. HTTP handlers may await the
// returned live send to know the adapter/daemon accepted the message before
// reporting success; other callers can keep ignoring the return value.
export function startTurn(session, text, opts) {
  // The next turn always runs on the leaf, whichever node the caller holds.
  session = store.leafOf(session) || session;
  if (isSwitching(session)) throw Object.assign(new Error('正在切換接續節點，請稍後再送出'), { status: 409 });
  const adapter = adapterFor(session);
  if (adapter?.live) {
    const why = adapter.cannotSend?.(session);
    if (why) throw Object.assign(new Error(why), { status: 409 });
    snapshotTurn(session);
    const pending = adapter.send(session, text, opts);
    pending.catch((err) => {
      emit(session, { type: 'error', text: err.message });
      setStatus(session, 'idle');
    });
    return pending;
  }
  if (running.has(session.id)) throw Object.assign(new Error('這個 session 正在執行中'), { status: 409 });
  runTurn(session, text, opts).catch((err) => console.error(`[runner] ${session.id}:`, err));
}

// A message the hub sends on its own (auto-pause). Unlike startTurn it
// waits, and throws when the message did not get through.
export async function deliver(session, text, opts = {}) {
  // Whatever sends later (a scheduled message, 「繼續」 after a quota pause, a
  // background result) may hold a node from before a switch: it goes to the
  // leaf, the runtime the user last chose.
  session = store.leafOf(session) || session;
  if (isSwitching(session)) throw new Error('正在切換接續節點，請稍後再送出');
  const adapter = adapterFor(session);
  if (!adapter?.live) throw new Error('這個對話不支援自動送出訊息');
  const why = adapter.cannotSend?.(session);
  if (why) throw new Error(why);
  snapshotTurn(session);
  const r = await adapter.send(session, text, opts);
  if (r?.ok === false) throw new Error(r.error || 'Kimi 沒有收到訊息');
  return r;
}

export function isRunning(id) {
  return running.has(id);
}

export function interrupt(id) {
  running.get(id)?.ac.abort();
  const session = store.getSession(id);
  if (session) parentInterrupts.set(session, (parentInterrupts.get(session) || 0) + 1);
  const adapter = session && adapterFor(session);
  const r = adapter?.live ? adapter.interrupt(session) : undefined;
  // A broker Task is waiting on a child turn: stopping the parent must stop
  // that child too, not leave it running invisibly.
  for (const childId of activeChildren.get(id) || []) interrupt(childId);
  return r;
}

export async function resolvePermission(sid, eventId, optionId, extra = {}) {
  const session = store.getSession(sid);
  // A step mirrored from a broker child is answered on that child, not on
  // the parent whose transcript shows it.
  const mirrored = session?.events?.find((e) => e.id === eventId && e.brokerChildId);
  if (mirrored && mirrored.brokerChildId !== sid) {
    const child = store.getSession(mirrored.brokerChildId);
    if (child) return resolvePermission(child.id, mirrored.brokerEventId || mirrored.id, optionId, extra);
  }
  const resolve = pendingPermissions.get(`${sid}:${eventId}`);
  if (resolve) {
    resolve(String(optionId));
    return true;
  }
  const adapter = session && adapterFor(session);
  if (adapter?.live) return adapter.respond(session, eventId, String(optionId ?? ''), extra);
  return false;
}

// Mode / model / config changes requested from the UI, forwarded to adapters
// that support them.
export async function setSubagent(session, input) {
  const next = await normalizeSubagent(input, { session });
  const prev = session.meta?.subagent ?? null;
  const prevExplicit = session.state?.subagentExplicit;
  session.meta = { ...(session.meta || {}) };
  if (next) session.meta.subagent = next;
  else delete session.meta.subagent;
  session.state = { ...(session.state || {}), subagentExplicit: true };
  let decided = null;
  try {
    if (providerOf(session) === 'claude') {
      // Claude's daemon owns its native Task defaults; push the change now so
      // the next Task does not wait for the next message.
      await adapterFor(session)?.configure?.(session, { subagent: next });
    } else {
      // Kimi/DeepSeek: say now whether this can be honoured. A choice that
      // needs a broker the computer's connector does not have is refused
      // here, not stored and then ignored.
      decided = await subagentPolicy.refresh(session);
      if (decided.refuse) throw Object.assign(new Error(`${decided.reason}。${decided.fix}`), { status: 409, code: decided.code });
    }
  } catch (err) {
    session.meta = { ...(session.meta || {}) };
    if (prev) session.meta.subagent = prev;
    else delete session.meta.subagent;
    session.state = { ...(session.state || {}) };
    if (prevExplicit === undefined) delete session.state.subagentExplicit;
    else session.state.subagentExplicit = prevExplicit;
    subagentPolicy.refresh(session).catch(() => {});
    throw err;
  }
  // Whatever token a prompt carried was for the old setting.
  subagentBroker.revokeSession(session.id);
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
  if (decided) subagentPolicy.announce(session, decided, liveContext(session));
  return summaryOf(session);
}

export async function configure(session, change = {}) {
  const adapter = adapterFor(session);
  if (!adapter?.configure) throw Object.assign(new Error('這個對話不支援切換設定'), { status: 400 });
  // Swarm mode is Kimi Code's (one main model sends many subagents at once);
  // Claude has nothing that does it, and a setting that does nothing is not
  // accepted.
  if (change.swarmMode !== undefined && providerOf(session) === 'claude') throw Object.assign(new Error('Claude 沒有 swarm 模式：那是 Kimi Code 的功能，Kimi 與 DeepSeek 對話才有'), { status: 400 });
  let nextModel = change.model;
  let nextEffort = change.effort;
  // The Hub's record of the model, in the spelling the check below turned it into.
  let respelled = null;
  if (typeof nextModel === 'string' && nextModel) {
    const provider = providerOf(session);
    if (provider === 'deepseek' && !deepseek.isDeepseekModel(nextModel)) throw Object.assign(new Error('DeepSeek 對話只能用 DeepSeek 的模型'), { status: 400 });
    if (provider !== 'deepseek' && deepseek.isDeepseekModel(nextModel)) throw Object.assign(new Error('DeepSeek 的模型只能在 DeepSeek 對話裡用'), { status: 400 });
    const choice = await validateChoice({ provider, model: nextModel, effort: nextEffort, session });
    nextModel = choice.model;
    if (nextEffort === undefined || nextEffort === '') nextEffort = choice.effort;
    // Same Kimi runtime: a model switch is a profile change, not a new
    // conversation. DeepSeek models stay with DeepSeek conversations.
    if (provider !== 'deepseek' && deepseek.isDeepseekModel(nextModel)) throw Object.assign(new Error('DeepSeek 的模型只能在 DeepSeek 對話裡用'), { status: 400 });
    if (provider === 'deepseek' && !deepseek.isDeepseekModel(nextModel)) throw Object.assign(new Error('DeepSeek 對話只能用 DeepSeek 的模型'), { status: 400 });
  } else if (typeof nextEffort === 'string' && nextEffort) {
    const mc = session.modelConfig || {};
    if (mc.model) {
      const provider = providerOf(session);
      const choice = await validateChoice({ provider, model: mc.model, effort: nextEffort, session });
      if (provider === 'deepseek' && choice.model !== mc.model) respelled = choice.model;
    }
  }
  const payload = { ...change, model: nextModel, effort: nextEffort };
  const meta = await adapter.configure(session, payload);
  if (meta) session.meta = { ...(session.meta || {}), ...meta };
  const mc = { ...(session.modelConfig || { provider: providerOf(session) }) };
  mc.provider = providerOf(session);
  if (typeof nextModel === 'string' && nextModel) mc.model = nextModel;
  else if (respelled) mc.model = respelled;
  if (typeof nextEffort === 'string') mc.effort = nextEffort;
  session.modelConfig = mc;
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
  return summaryOf(session);
}

function summaryOf(session) {
  return summarize(store.leafOf(session) || session);
}

// Slash commands that map to agent actions (/compact, /undo, /fork, skills…).
export async function command(session, name, args) {
  const adapter = adapterFor(session);
  if (!adapter?.command) throw Object.assign(new Error('這個對話不支援指令'), { status: 400 });
  const r = (await adapter.command(session, name, args)) || {};
  // A Kimi /fork is still made from the Hub: it keeps the category of the
  // conversation it was forked from, and it is a copy of that conversation, so
  // it keeps its provider and its settings too (see forkedFrom). Any other
  // native id is an attach.
  if (r.kimiSessionId) {
    const source = store.leafOf(session) || session;
    const fork = name === 'fork';
    return { session: summarize(await attachKimi(session.machineId, r.kimiSessionId, fork ? { origin: originOf(source), from: source } : { origin: 'external' })) };
  }
  if (r.session) {
    broadcast({ t: 'session', session: summarize(r.session) });
    return { session: summarize(r.session) };
  }
  return {};
}

// 插隊 for a message waiting in the queue.
// /steer: every message still waiting (排隊中 or 等待插隊) slipped into the
// running turn at once.
export async function steerAll(session) {
  const adapter = adapterFor(session);
  if (adapter?.steerAll) return adapter.steerAll(session);
  if (!adapter?.steerQueued) throw Object.assign(new Error('這個對話不支援插隊'), { status: 400 });
  const waiting = (session.meta?.queue || []).filter((q) => !q.steered);
  for (const q of waiting) await adapter.steerQueued(session, q.promptId);
  return { count: waiting.length };
}

export async function steerQueued(session, promptId) {
  const adapter = adapterFor(session);
  if (!adapter?.steerQueued) throw Object.assign(new Error('這個對話不支援插隊'), { status: 400 });
  await adapter.steerQueued(session, promptId);
}

export async function cancelQueued(session, promptId) {
  const adapter = adapterFor(session);
  if (!adapter?.cancelQueued) throw Object.assign(new Error('這個對話沒有排隊中的訊息'), { status: 400 });
  await adapter.cancelQueued(session, promptId);
}

export function disposeSession(session) {
  running.get(session.id)?.ac.abort();
  adapterFor(session)?.dispose?.(session);
}

// The nodes a conversation is made of: its whole chain and, recursively, the
// sub-agent conversations of any of them. → { chain: [ids], kids: [ids] }
export function conversationMembers(session) {
  const leaf = store.leafOf(session) || session;
  const ids = new Set(store.chainOf(leaf).map((n) => n.id));
  ids.add(session.id);
  const chain = [...ids];
  const kids = [];
  const addChildren = (parentId) => {
    for (const child of store.listSessions()) {
      if (child.parentId !== parentId || ids.has(child.id)) continue;
      ids.add(child.id);
      kids.push(child.id);
      addChildren(child.id);
    }
  };
  for (const id of chain) addChildren(id);
  return { chain, kids };
}

// Delete a conversation: the one implementation behind every way to do it
// (the API, a Kimi row's 刪除, the /archive command). A conversation is its
// whole continuation chain plus, recursively, every sub-agent conversation
// (`parentId`) of any node; `continuedFrom` is a link in the chain, never a
// parent. Nodes go oldest first: a stop half way leaves a shorter valid chain,
// never an old node standing alone as the leaf again.
// The Kimi sessions of deleted sub-agents are Hub-made artifacts: they are
// archived on their machine (retried when it comes back if it is away) and
// kept out of the machine list meanwhile, so they never surface as 子session.
// The conversation's own Kimi sessions are the user's, and are left alone.
// `archiveNatives: false`: the caller has already dealt with the Kimi sessions
// on the machine (a full purge of a cluster deletes them), so they are only
// kept out of the machine list and not archived again.
export function deleteConversation(session, { archiveNatives = true } = {}) {
  const leaf = store.leafOf(session) || session;
  // A switch in progress holds a half-made node and native sessions of its
  // own; deleting under it would strand them.
  if (switching.has(conversationOf(leaf))) throw Object.assign(new Error('正在切換接續節點，請等切換完成再刪除'), { status: 409 });
  const { chain, kids } = conversationMembers(session);
  const subagentNatives = [];
  for (const id of [...chain, ...kids]) {
    const node = store.getSession(id);
    if (!node) continue;
    if (node.parentId && node.kimiSessionId && node.machineId) subagentNatives.push([node.machineId, node.kimiSessionId]);
    disposeSession(node);
    store.deleteSession(id);
    broadcast({ t: 'deleted', sid: id });
  }
  for (const [machineId, kimiSessionId] of subagentNatives) {
    machines.hideNative(machineId, kimiSessionId);
    if (archiveNatives) archiveOrphanNative(machineId, kimiSessionId);
  }
  machines.chainChanged();
  return { ok: true, deleted: [...chain, ...kids], archiving: archiveNatives ? subagentNatives.map(([, k]) => k) : [] };
}

// ------------------------------------------------- provider switching

// Kimi's and Claude's permission words overlap but differ in meaning, so a
// conversation's mode is never handed over as a string: see permissions.js,
// which only ever maps to the same or a stricter mode.

// K↔D: one native Kimi session, one profile change. This commits provider
// state only after Kimi accepted the model/effort, so a failure leaves the
// old model and provider exactly as they were.
async function switchKimiRuntime(session, target) {
  const kimi = ADAPTERS['kimi-remote'];
  if (target.provider === 'deepseek') {
    await kimi.ensureServer(session.machineId);
    await deepseek.ensureProvider(session.machineId);
    kimi.forgetModels(session.machineId);
  }
  await kimi.configure(session, {
    model: target.model,
    effort: target.effort,
    // Same runtime, same vocabulary: its own mode, but never an unrecognised word.
    permission: nativePermission(session, providerOf(session)),
    planMode: session.meta?.planMode,
  });
  session.provider = target.provider;
  // Chosen now, not worked out from old fields: the native's alias no longer
  // gets to correct it.
  delete session.providerInferred;
  session.mode = target.provider === 'deepseek' ? 'deepseek' : null;
  session.modelConfig = { provider: target.provider, model: target.model, effort: target.effort };
  session.state = { ...(session.state || {}), defaultsApplied: true, promptModel: true, userSet: { ...(session.state?.userSet || {}), model: true, effort: true } };
  if (target.provider === 'deepseek') session.state.deepseek = { gateway: deepseek.gateway(), model: target.model };
  session.meta = { ...(session.meta || {}), model: target.model, effort: target.effort };
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
  liveContext(session).emit({
    type: 'info',
    text: `已切換到 ${providerOf(session) === 'deepseek' ? 'DeepSeek' : 'Kimi'} · ${target.model}${target.effort ? ` · 思考 ${target.effort}` : ''}。沿用同一個 Kimi 原生對話，上下文保留。`,
  });
  return session;
}

async function switchKimiRuntimeChecked(session, target) {
  try {
    return await switchKimiRuntime(session, target);
  } catch (err) {
    // No provider/mode change was committed. The native profile may have
    // been untouched as well; the old model remains usable.
    throw Object.assign(new Error(`切換失敗，仍使用原本的 ${providerOf(session)} 模型：${err.message}`), { status: err.status || 502 });
  }
}

// Cross-runtime switch: a brand-new Hub/native node linked by conversationId
// and continuedFrom/To. The old node's native binding and events are never
// modified or deleted.
//
// A switch is one critical section per conversation (`switching`):
//  • only one at a time; a second request is refused with 409, not run;
//  • the old leaf takes no message meanwhile (startTurn/deliver check), so
//    nothing falls between the hand-off and the link. If something still
//    reaches it (a person typing in a terminal) the switch is cancelled
//    explicitly and can simply be tried again;
//  • the new node is stored `provisional`: not a leaf, not listed, not
//    broadcast. It becomes real in the same synchronous step that links both
//    ends, and is written to disk old end first, so a Hub that stops half way
//    leaves at most an orphan that the next start removes.
const switching = new Map(); // conversationId -> { provider, since }
const conversationOf = (s) => s.conversationId || s.id;
export const isSwitching = (s) => Boolean(s) && (switching.has(conversationOf(s)) || Boolean(s.state?.pendingSwitching));

// What a node's visible history adds up to. A native replay that only
// renumbers the events leaves it unchanged; new words change it.
function historySignature(node) {
  let n = 0;
  let chars = 0;
  for (const ev of node.events || []) {
    if (ev.brokerChildId || !['user', 'text', 'tool_use', 'error'].includes(ev.type)) continue;
    n++;
    chars += String(ev.text || ev.output || '').length;
  }
  return `${n}:${chars}`;
}

const switchLabel = (t) => `${PROVIDER_LABEL[t.provider]} · ${t.model}${t.effort ? ` · 思考 ${t.effort}` : ''}`;

// The waiting switch: a promise made while a turn runs. The last explicit
// choice replaces it; choosing what is already running calls it off.
function setPending(node, pending, current) {
  node.state = { ...(node.state || {}), pendingProvider: pending };
  node.meta = { ...(node.meta || {}), pendingSwitch: pending };
  // Written now: a restart a moment later must still find it.
  store.saveSession(node, { immediate: true });
  broadcast({ t: 'session', session: summarize(node) });
  liveContext(node).emit({ type: 'info', text: `已排定在這一輪結束後切換到 ${switchLabel(pending)}。這一輪仍使用 ${node.meta?.turnProvider || current} · ${node.meta?.turnModel || node.meta?.model || ''}。` });
}

function clearPending(node, why) {
  if (!node.state?.pendingProvider) return false;
  node.state = { ...node.state, pendingProvider: null };
  const meta = { ...(node.meta || {}) };
  delete meta.pendingSwitch;
  node.meta = meta;
  store.saveSession(node, { immediate: true });
  broadcast({ t: 'session', session: summarize(node) });
  if (why) liveContext(node).emit({ type: 'info', text: why });
  return true;
}

// Call off the switch that is waiting for the turn to end, without choosing
// a provider. Nothing waiting is not an error.
export function cancelPendingSwitch(session) {
  const leaf = store.leafOf(session) || session;
  clearPending(leaf, '已取消排定的切換。');
  return summarize(leaf);
}

// Background sub-agents still working for any node of this conversation.
const activeChildCount = (leaf) => store.chainOf(leaf).reduce((n, node) => n + (activeChildren.get(node.id)?.size || 0), 0);

async function createContinuationNode(old, target, { machineId, reason = '使用者切換模型' } = {}) {
  const conversationId = conversationOf(old);
  const signature = historySignature(old);
  // Taken inside the switch's critical section, at the last moment: this is
  // the whole history the new runtime will be handed.
  const h = handoff.handoffFor(old, target);
  // The new runtime gets a mode in its own words that asks the same or more.
  const perm = inheritPermission(old, providerOf(old), target.provider);
  const shared = {
    title: old.title || '新對話',
    titled: Boolean(old.titled),
    cwd: old.cwd,
    permissionMode: hubModeFor(target.provider, perm.permission, old.permissionMode),
    allowedTools: [...(old.allowedTools || [])],
    conversationId,
    continuedFrom: old.id,
    // A continuation belongs to the same category as the chain it extends,
    // including a Hub fork or a chain attached from elsewhere.
    origin: chainOrigin(old),
    provider: target.provider,
    modelConfig: { provider: target.provider, model: target.model, effort: target.effort },
    handoff: h,
    // Not a real leaf until linked below.
    provisional: true,
    meta: { ...(Object.hasOwn(old.meta || {}, 'subagent') ? { subagent: old.meta.subagent } : {}) },
    state: { ...(old.state?.subagentExplicit ? { subagentExplicit: true } : {}) },
    // A worker of a cluster (叢集) is still one in its new node: its tag and note
    // on the screen, and the part of the cluster memory it has been told so far.
    ...(old.clusterId ? { clusterId: old.clusterId, clusterRole: old.clusterRole || 'worker', ...(old.clusterMemo ? { clusterMemo: { ...old.clusterMemo } } : {}), ...(old.clusterHidden ? { clusterHidden: true } : {}) } : {}),
  };
  let node = null;
  let native = null;
  let nativeMachine = null;
  const discard = () => {
    if (node) {
      try {
        adapterFor(node)?.dispose?.(node);
      } catch {}
      store.deleteSession(node.id);
    }
    if (native) {
      machines.kimiApi(nativeMachine, 'POST', `/api/v1/sessions/${native.kimiSessionId}:archive`, {}).catch((err) => {
        console.warn(`[runner] could not archive the unused Kimi session ${native.kimiSessionId}: ${err.message}`);
        liveContext(old).emit({ type: 'info', text: `切換失敗後，新建的 Kimi 對話 ${native.kimiSessionId} 沒能自動封存（${err.message}）。可以在那台電腦的 Kimi 裡手動封存。` });
      });
    }
  };
  try {
    if (target.provider === 'claude') {
      node = store.createSession({ ...shared, agentId: 'claude', ...(machineId ? { machineId } : {}) });
      const cfg = {
        model: target.model,
        effort: target.effort,
        permission: perm.permission,
        planMode: Boolean(old.meta?.planMode),
        handoff: h.text,
        handoffFrom: { provider: h.fromProvider, cwd: h.fromCwd, chars: h.chars, omitted: h.omitted },
      };
      await ADAPTERS.claude.create(node, cfg);
    } else {
      const kimi = ADAPTERS['kimi-remote'];
      const mid = machineId || old.machineId || firstKimiMachine()?.id;
      if (!mid) throw Object.assign(new Error('需要連接一台有 Kimi 的電腦才能切換'), { status: 409 });
      await kimi.ensureServer(mid);
      if (target.provider === 'deepseek') {
        await deepseek.ensureProvider(mid);
        kimi.forgetModels(mid);
      }
      native = await kimi.createRemote({ machineId: mid, cwd: old.cwd, nameHint: old.title });
      nativeMachine = mid;
      node = store.createSession({
        ...shared,
        agentId: `kimi@${mid}`,
        machineId: mid,
        kimiSessionId: native.kimiSessionId,
        cwd: native.cwd || old.cwd,
        ...(target.provider === 'deepseek' ? { mode: 'deepseek' } : {}),
        state: { ...shared.state, defaultsApplied: true, promptModel: true, userSet: { model: true, effort: true } },
      });
      if (target.provider === 'deepseek') node.state.deepseek = { gateway: deepseek.gateway(), model: target.model };
      kimi.restore(node);
      await kimi.attach(node);
      await kimi.configure(node, { model: target.model, effort: target.effort, permission: perm.permission, planMode: old.meta?.planMode });
    }
    if (historySignature(old) !== signature) {
      throw Object.assign(new Error('原對話在切換期間又有了新內容（例如終端機裡有人輸入）。為了不漏掉它，這次切換已取消，請再選一次'), { status: 409 });
    }
  } catch (err) {
    discard();
    throw Object.assign(new Error(`接續到 ${PROVIDER_LABEL[target.provider]} 失敗，原對話仍可重試：${err.message}`), { status: err.status || 502 });
  }

  // ---- link (one synchronous step) ----
  delete node.provisional;
  old.continuedTo = node.id;
  // Messages set to go out later belong to the conversation: they follow the leaf.
  if (old.scheduled?.length) {
    node.scheduled = old.scheduled;
    old.scheduled = [];
  }
  // 自動暫停 watches a Kimi subscription's quota and types into that Kimi
  // conversation; it does not carry over to another runtime.
  const retired = autoPauseActive(old.autoPause) ? '自動暫停／額度恢復後送出' : '';
  if (retired) old.autoPause = null;
  // What the switch changed or left running, said both in the conversation and
  // on the hand-off record. A Claude node's events are the daemon's copy and
  // are replaced on every sync, so the record is what stays.
  const background = activeChildCount(old);
  const notes = [
    perm.note,
    retired && `${retired}已隨這次切換取消：它只適用於 Kimi 訂閱的對話。需要的話請在這個對話重新設定。`,
    background && `有 ${background} 個背景子代理仍在執行；它們完成後，結果會送到這個對話。`,
  ].filter(Boolean);
  node.handoff = { ...node.handoff, notes };
  // Old end first: if the Hub stops in between, the file of the new node still
  // says provisional and the next start removes it, leaving the old leaf.
  await store.persistNow(old);
  await store.persistNow(node);
  machines.chainChanged?.(old, node);
  broadcast({ t: 'session', session: summarize(old) });
  broadcast({ t: 'session', session: summarize(node) });
  const trail = [...new Set(h.chainProviders)];
  liveContext(node).emit({
    type: 'info',
    text: `已從 ${handoff.providerName(h.fromProvider)} 接續（${h.nodes} 個歷史節點${trail.length > 1 ? `，依序經過 ${trail.map(handoff.providerName).join(' → ')}` : ''}，${h.chars} 字${h.omitted ? `，省略 ${h.omitted} 字` : ''}）。下一則訊息會帶著前段歷史，目標：${switchLabel(target)}。原因：${reason}。`,
  });
  for (const note of notes) liveContext(node).emit({ type: 'info', text: note });
  return node;
}

export async function switchProvider(session, change = {}) {
  const liveNode = (session?.id && store.getSession(session.id)) || session;
  const old = store.leafOf(liveNode) || liveNode;
  const conversation = conversationOf(old);
  const busyError = () => Object.assign(new Error('正在切換接續節點，請稍後再試'), { status: 409 });
  if (switching.has(conversation) || (old.state?.pendingSwitching && !change.fromPending)) throw busyError();
  const provider = change.provider;
  if (!['kimi', 'claude', 'deepseek'].includes(provider)) throw Object.assign(new Error('供應商必須是 Kimi、Claude 或 DeepSeek'), { status: 400 });
  const mid = provider === 'claude' ? (change.machineId || old.machineId || null) : (change.machineId || old.machineId || firstKimiMachine()?.id || null);
  const target = await validateChoice({
    provider,
    model: change.model || '',
    effort: change.effort === undefined ? '' : change.effort,
    session: old,
    machineId: mid,
    allowEmptyModel: !change.model,
  });
  // Everything below up to taking the lock is synchronous: the state read
  // here is the state acted on.
  if (switching.has(conversation)) throw busyError();
  const current = providerOf(old);
  const busy = running.has(old.id) || ['running', 'awaiting_permission'].includes(old.status);
  if (provider === current) {
    // The last explicit choice wins: going back to what is running calls off
    // a switch that was waiting.
    if (!change.fromPending) clearPending(old, `已取消排定的切換：你又選回了目前使用的 ${PROVIDER_LABEL[current]}。`);
    // Same runtime/provider: the adapter's profile change is the next turn's
    // setting. It is safe while the current turn is running.
    const mc = old.modelConfig || {};
    // Choosing what the Hub already shows is no change only when the native
    // conversation says it runs it as well. The Hub's record is not the
    // native's word: after a drift (the native on another model than the Hub
    // recorded) re-choosing the same model is exactly how it is put back, so
    // an unreported or different native model is never short-circuited, and
    // `force` (the page's 「改回」 button) skips the shortcut altogether.
    const recorded = mc.model === target.model && (mc.effort || '') === (target.effort || '');
    // (Only a Kimi-runtime conversation has a native word to compare with.)
    const nativeAgrees = !old.kimiSessionId || modelDrift.nativeMatches(old, target);
    if (!change.force && recorded && nativeAgrees) return summarize(old);
    await configure(old, { model: target.model, effort: target.effort, ...(old.kimiSessionId ? { confirm: true } : {}) });
    return summarize(old);
  }
  if (busy) {
    if (change.fromPending) throw Object.assign(new Error('對話仍在執行中，接續切換延後'), { status: 409 });
    // Never tear down a running runtime, and never change its profile in the
    // middle of a turn (Kimi↔DeepSeek included): the choice is the next
    // turn's promise, and setStatus('idle') applies it once.
    setPending(old, { provider: target.provider, model: target.model, effort: target.effort, machineId: mid, reason: change.reason || '使用者切換模型', requestedAt: Date.now() }, current);
    return summarize(old);
  }
  // Idle: this direct choice replaces anything that was waiting.
  if (!change.fromPending) clearPending(old, `排定的切換已由你新的選擇取代：改切換到 ${switchLabel(target)}。`);
  // Kimi and DeepSeek are two providers in one runtime: keep the native
  // conversation and only change its profile.
  const sameRuntime = Boolean(old.kimiSessionId) && (current === 'kimi' || current === 'deepseek') && (provider === 'kimi' || provider === 'deepseek');
  switching.set(conversation, { provider, since: Date.now() });
  try {
    if (sameRuntime) {
      await switchKimiRuntimeChecked(old, target);
      return summarize(old);
    }
    const node = await createContinuationNode(old, target, { machineId: mid, reason: change.reason || '使用者切換模型' });
    return summarize(node);
  } finally {
    switching.delete(conversation);
  }
}

// The Kimi server's own word about a conversation: still working although the
// Hub's status says idle (a restart cleared it).
// Not knowing yet counts as busy: just after a connect the machine has not
// listed its conversations, and an idle-looking one may be mid-turn.
function nativeBusy(node) {
  if (!node?.kimiSessionId) return false;
  if (!machines.sessionsKnown(node.machineId)) return true;
  return Boolean(machines.getMachine(node.machineId)?.sessions?.find((x) => x.id === node.kimiSessionId)?.busy);
}

// Run after a live/non-live turn becomes idle. One attempt only: a failed
// cross-runtime switch is surfaced, and the old leaf stays retryable.
export async function applyPendingSwitch(session) {
  const node = (session?.id && store.getSession(session.id)) || session;
  if (!node) return null;
  const old = store.leafOf(node) || node;
  const pending = old.state?.pendingProvider;
  if (!pending || old.state?.pendingSwitching || switching.has(conversationOf(old))) return null;
  if (running.has(old.id) || ['running', 'awaiting_permission'].includes(old.status) || nativeBusy(old)) return null;
  // Offline is not a failure: keep the pending target and wait for the
  // machine-online event. Do not clear it, and do not poll.
  if (pending.provider !== 'claude') {
    if (!pending.machineId) pending.machineId = firstKimiMachine()?.id || null;
    if (!pending.machineId || !machines.getMachine(pending.machineId)?.online) return null;
  } else if (pending.machineId && !machines.getMachine(pending.machineId)?.online) return null;
  old.state = { ...(old.state || {}), pendingSwitching: true };
  store.saveSession(old);
  try {
    const result = await switchProvider(old, { ...pending, fromPending: true });
    old.state = { ...(old.state || {}), pendingProvider: null, pendingSwitching: false };
    delete old.meta?.pendingSwitch;
    store.saveSession(old, { immediate: true });
    broadcast({ t: 'session', session: summarize(old) });
    return result;
  } catch (err) {
    // The machine went away during the attempt: keep the target for its next
    // online event, instead of silently dropping it.
    const offline = pending.provider !== 'claude' && !machines.getMachine(pending.machineId)?.online;
    if (offline) {
      old.state = { ...(old.state || {}), pendingSwitching: false };
      store.saveSession(old);
      return null;
    }
    // One attempt only. A real failure clears the pending target and is
    // reported; the old leaf stays current and retryable by the user.
    old.state = { ...(old.state || {}), pendingProvider: null, pendingSwitching: false };
    delete old.meta?.pendingSwitch;
    store.saveSession(old, { immediate: true });
    broadcast({ t: 'session', session: summarize(old) });
    liveContext(old).emit({
      type: 'error',
      text: `排定的切換沒有完成，仍使用原本的 ${providerOf(old)} 對話：${err.message}。可以再選一次目標供應商重試。`,
    });
    return null;
  }
}

export function resumePendingSwitches(machineId = null) {
  for (const s of store.listSessions()) {
    const pending = s.state?.pendingProvider;
    if (!pending || s.state?.pendingSwitching) continue;
    if (machineId && pending.machineId && pending.machineId !== machineId) continue;
    if (s.status === 'running' || s.status === 'awaiting_permission') continue;
    applyPendingSwitch(s).catch((err) => console.warn(`[runner] resume pending ${s.id}: ${err.message}`));
  }
}

// What sends on its own at a given time only ever looks at leaves: an old
// node of a switched conversation is not a runtime any more.
export const schedulableSessions = () => store.listLeaves().filter((s) => (s.kimiSessionId || s.agentId === ADAPTERS.claude.AGENT.id) && s.scheduled?.length);
export const autoPauseSessions = () => store.listLeaves().filter((s) => s.kimiSessionId && autoPauseActive(s.autoPause) && !deepseek.isDeepseek(s));

// ------------------------------------------------------- 3×3 broker

// Interrupts are counted per node; the count that matters is the whole
// conversation's, so a stop pressed after a switch still holds back a result
// that was asked for before it.
const interruptVersionOf = (session) => store.chainOf(store.leafOf(session) || session).reduce((n, node) => n + (parentInterrupts.get(node) || 0), 0);
// What a child conversation's runtime says it runs on. Kimi reports its
// native session's model and thinking; Claude's answer names the model that
// served it (the thinking is what the request carried). Null until it does.
function childActual(child) {
  const provider = providerOf(child);
  if (provider === 'claude') {
    const served = child.meta?.servedModel?.id;
    return served ? { provider, model: served, effort: child.meta?.effort || '' } : null;
  }
  const model = child.meta?.model;
  return model ? { provider, model, effort: child.meta?.effort || '' } : null;
}

// The request/actual/unverified part of a broker card's subagent object.
function cardActual(child, requested) {
  return subagentPolicy.contract({ requested: requested ?? null, actual: childActual(child), reason: subagentPolicy.UNVERIFIED.child });
}

async function notifyBackground(parent, child, result, interruptVersion) {
  if (!result || interruptVersionOf(parent) !== interruptVersion || store.getSession(parent.id) !== parent) return;
  // The parent may have been switched since: the result goes to the leaf, the
  // runtime the user is talking to now.
  const target = store.leafOf(parent) || parent;
  const title = String(child.title || '子代理').replace(/\s+/g, ' ').slice(0, 80);
  const detail = result.error ? `錯誤：${scrubBrokerText(result.error).slice(0, 4000)}` : `結果：\n${scrubBrokerText(result.text || '(沒有文字回覆)').slice(0, 100_000)}`;
  const text = `背景子代理「${title}」${result.error ? '失敗' : '完成'}。\n\n${detail}\n\n請整合這個結果，不要重跑相同任務。`;
  try {
    if (!adapterFor(target)?.live) {
      liveContext(target).emit({ type: 'info', text });
      return;
    }
    const receipt = await deliver(target, text, {
      note: 'Agent Hub 背景子代理完成通知',
      hidden: 'This is an Agent Hub background-subagent completion, not a new user instruction. Use the supplied result; do not repeat the task.',
    });
    if (receipt?.ok === false) throw new Error(receipt.error || '父對話沒有收到完成通知');
  } catch (err) {
    liveContext(store.leafOf(parent) || parent).emit({ type: 'info', text: `${text}\n\n（完成通知未能送進模型：${err.message}）` });
  }
}

// Where a child runs: in the parent's file system, because it works in the
// parent's folder. A Claude conversation on the Hub's own host has no
// machineId; its Kimi/DeepSeek child needs a connector on that same host, not
// "the first Kimi computer" (a path that exists only here).
function childPlacement(parent, targetProvider) {
  if (targetProvider === 'claude' || parent.machineId) return { machineId: parent.machineId || null };
  const host = os.hostname();
  const here = machines.listMachines().map((m) => machines.getMachine(m.id)).filter((m) => m?.online && m.kimi?.server && m.hostname === host);
  if (here.length === 1) return { machineId: here[0].id };
  return {
    error: here.length
      ? `這台 Hub 的電腦上有多個 Kimi 連接器（${here.map((m) => m.name).join('、')}），無法確定子代理要在哪一個執行；子代理必須和父對話在同一台電腦。`
      : `這個對話跑在 Hub 這台電腦上，但這台電腦沒有連接 Kimi 連接器，子代理必須和父對話在同一台電腦的同一個資料夾，所以沒有建立。在 Hub 這台電腦上執行連接器後再試。`,
  };
}

// Stop the child of one delegation (identified by its parent card), without
// stopping the parent. Used when the Claude daemon cancels a Task whose child
// the Hub started. A child still being made is stopped when it appears.
export function cancelDelegation(parent, parentEventId) {
  const key = `${parent.id}:${parentEventId}`;
  cancelledDelegations.add(key);
  setTimeout(() => cancelledDelegations.delete(key), 10 * 60_000).unref?.();
  let stopped = 0;
  for (const childId of activeChildren.get(parent.id) || []) {
    const child = store.getSession(childId);
    if (child?.state?.broker?.parentEventId === parentEventId) {
      interrupt(childId);
      stopped += 1;
    }
  }
  return stopped;
}

// Empty provider/model/effort follow the conversation's subagent default;
// explicit values are a one-shot override. The default waits for the child,
// while background returns once it exists and delivers its result afterwards.
export async function delegateToProvider(parent, { provider, model, effort, task, parentEventId, background = false } = {}) {
  if (!parent) throw Object.assign(new Error('找不到父對話'), { status: 400 });
  const text = String(task || '').trim();
  if (!text) throw Object.assign(new Error('子代理任務是空的'), { status: 400 });
  background = background === true;
  const interruptVersion = interruptVersionOf(parent);
  const cfg = parent.meta?.subagent || null;
  const parentProvider = providerOf(parent);
  const targetProvider = provider || cfg?.provider || parentProvider;
  const sameAsParent = targetProvider === parentProvider;
  const cfgMatches = cfg && cfg.provider === targetProvider;
  const wantedModel = model || (cfgMatches ? cfg.model : '') || (sameAsParent ? parent.modelConfig?.model || parent.meta?.model || '' : '');
  const wantedEffort = effort !== undefined ? effort : cfgMatches && cfg.effort !== undefined ? cfg.effort : sameAsParent ? parent.modelConfig?.effort || parent.meta?.effort || '' : '';
  const place = childPlacement(parent, targetProvider);
  if (place.error) return { childSessionId: null, provider: targetProvider, model: wantedModel || '', effort: wantedEffort || '', text: '', error: place.error };
  const mid = place.machineId;
  let target;
  try {
    target = await validateChoice({
      provider: targetProvider,
      model: wantedModel,
      effort: wantedEffort,
      session: parent,
      machineId: mid,
      allowEmptyModel: !wantedModel && !cfg,
    });
  } catch (err) {
    return { childSessionId: null, provider: targetProvider, model: wantedModel || '', effort: wantedEffort || '', text: '', error: err.message };
  }

  // The child asks at least as much as its parent, in its own runtime's words.
  const childPermission = inheritPermission(parent, parentProvider, targetProvider);
  let child = null;
  const taskTitle = text.replace(/\s+/g, ' ').slice(0, 120);
  const internalTitle = (t) => !String(t || '').trim() || /delegate_to_provider|mcp__agent-hub|agent-hub/i.test(String(t));
  let ev = parentEventId ? parent.events?.find((e) => e.id === parentEventId) : null;
  // A card belongs to one delegation: one a child already holds, or another
  // delegation has just chosen, is not taken over (a repeated or parallel
  // request with the same id gets a card of its own below).
  if (ev && (!brokerCardUnclaimed(ev) || claimedBrokerCards.has(`${parent.id}:${ev.id}`) || isBrokerProjection(ev))) ev = null;
  if (!ev) {
    // A native MCP frame may already be on the parent (same task, still
    // unclaimed). A brokerSynthetic card from an earlier delegation is never
    // this call's card: reusing it made parallel children share one card.
    ev = [...(parent.events || [])].reverse().find((e) =>
      e.type === 'tool_use'
      && !e.brokerChildId
      && !e.brokerSynthetic
      && !e.subagent?.broker
      && brokerCardUnclaimed(e)
      && !claimedBrokerCards.has(`${parent.id}:${e.id}`)
      && ['pending', 'running', 'awaiting'].includes(e.status)
      && /delegate|mcp__agent-hub|broker/i.test(e.name || '')
      && brokerCardTask(e) === text,
    );
  }
  const ctx = liveContext(parent);
  if (!ev) ev = ctx.emit({ type: 'tool_use', name: 'delegate_to_provider', brokerSynthetic: true, brokerFresh: true, title: taskTitle, input: { provider: targetProvider, model: target.model, effort: target.effort, task: text, background }, status: 'running' });
  const claimKey = `${parent.id}:${ev.id}`;
  claimedBrokerCards.add(claimKey);
  ctx.patch(ev, {
    status: 'running',
    title: internalTitle(ev.title) ? taskTitle : ev.title,
    provider: targetProvider,
    model: target.model,
    effort: target.effort,
    brokerBackground: background,
    subagent: {
      id: null,
      name: 'subagent',
      broker: true,
      background,
      description: text.slice(0, 120),
      provider: targetProvider,
      model: target.model,
      effort: target.effort,
      permission: childPermission.permission,
      ...(childPermission.note ? { permissionNote: childPermission.note } : {}),
      status: 'running',
      // What this delegation asked for, fixed now; what the child's runtime
      // reports it really uses is filled in as soon as it does.
      ...subagentPolicy.contract({ requested: { provider: targetProvider, model: target.model, effort: target.effort }, actual: null, reason: subagentPolicy.UNVERIFIED.child }),
    },
  });
  const release = () => {
    claimedBrokerCards.delete(claimKey);
    if (!child) return;
    const kids = activeChildren.get(parent.id);
    kids?.delete(child.id);
    if (kids && !kids.size) activeChildren.delete(parent.id);
  };

  try {
    child = await newSession({
      provider: targetProvider,
      machineId: targetProvider === 'claude' ? parent.machineId || undefined : mid,
      cwd: parent.cwd,
      permissionMode: hubModeFor(targetProvider, childPermission.permission, parent.permissionMode || 'ask'),
      title: text.slice(0, 80),
      // A broker child is neither a main chat nor a 子session row: it is a
      // hidden child of this parent (origin external is what a child always
      // is), linked to its card from the moment it exists.
      origin: 'external',
      parentId: parent.id,
      brokerLink: { parentId: parent.id, parentEventId: ev.id, background },
      config: {
        model: target.model,
        effort: target.effort,
        permission: childPermission.permission,
        planMode: Boolean(parent.meta?.planMode),
      },
    });
    child.depth = (parent.depth ?? 0) + 1;
    child.allowedTools = [...(parent.allowedTools || [])];
    child.provider = targetProvider;
    child.modelConfig = { provider: targetProvider, model: target.model, effort: target.effort };
    store.saveSession(child, { immediate: true });
    broadcast({ t: 'session', session: summarize(child) });
    const kids = activeChildren.get(parent.id) || new Set();
    kids.add(child.id);
    activeChildren.set(parent.id, kids);
    ctx.patch(ev, { childSessionId: child.id, subagent: { ...ev.subagent, id: child.id, ...cardActual(child, ev.subagent.requested) } });
    rebuildBrokerProjection(child);
    // The parent may have been stopped while this child was being made: that
    // stop could not reach a child nobody tracked yet. The child exists (its
    // card points at it) but must not run.
    if ((parentInterrupts.get(parent) || 0) !== interruptVersion || cancelledDelegations.has(`${parent.id}:${ev.id}`)) {
      ctx.patch(ev, { status: 'interrupted', isError: false, output: '已中斷', subagent: { ...ev.subagent, status: 'cancelled' } });
      release();
      return { childSessionId: child.id, provider: targetProvider, model: target.model, effort: target.effort, text: '', error: '已中斷' };
    }
    const work = (async () => {
      try {
        const live = Boolean(adapterFor(child)?.live);
        const r = live ? await runLiveTurn(child, text) : await runTurn(child, text);
        // The runtime's own report, not the request echoed back: that is what
        // a caller (and the card) must compare with what was asked.
        const reported = childActual(child);
        const actualProvider = reported?.provider || providerOf(child);
        const actualModel = reported?.model || target.model;
        const actualEffort = reported ? reported.effort : target.effort;
        const end = [...(child.events || [])].reverse().find((e) => e.type === 'turn_end');
        const cancelled = Boolean(end?.interrupted) && !end?.error;
        const busy = !end && (['running', 'awaiting_permission'].includes(child.status) || running.has(child.id));
        const error = r.error || (cancelled ? '已中斷' : busy ? '子代理仍在執行' : child.status === 'error' ? '子代理執行失敗' : null);
        const safeText = scrubBrokerText(r.text);
        const safeError = error ? scrubBrokerText(error) : null;
        ctx.patch(ev, {
          status: busy ? 'running' : cancelled ? 'interrupted' : error ? 'error' : 'done',
          isError: Boolean(error),
          output: safeError ? `${safeError}\n${safeText}`.trim() : safeText,
          childSessionId: child.id,
          provider: actualProvider,
          model: actualModel,
          effort: actualEffort,
          subagent: {
            ...ev.subagent,
            id: child.id,
            provider: actualProvider,
            model: actualModel,
            effort: actualEffort,
            ...cardActual(child, ev.subagent.requested),
            status: busy ? 'running' : cancelled ? 'cancelled' : error ? 'error' : 'done',
            summary: !busy && !cancelled && !error ? safeText : undefined,
            error: safeError || undefined,
          },
        });
        return { childSessionId: child.id, provider: actualProvider, model: actualModel, effort: actualEffort, text: r.text || '', error: error || null };
      } catch (err) {
        try {
          if (adapterFor(child)?.live) interrupt(child.id);
        } catch {}
        ctx.patch(ev, { status: 'error', isError: true, output: err.message, childSessionId: child.id, subagent: { ...ev.subagent, status: 'error', error: err.message } });
        return { childSessionId: child.id, provider: targetProvider, model: target.model, effort: target.effort, text: '', error: err.message };
      } finally {
        release();
      }
    })();
    if (!background) return await work;
    work.then((result) => notifyBackground(parent, child, result, interruptVersion)).catch((err) => console.warn(`[broker] background ${child.id}: ${err.message}`));
    return { childSessionId: child.id, provider: targetProvider, model: target.model, effort: target.effort, background: true, status: 'running', text: '已在背景啟動；完成後會把結果送回這個對話。', error: null };
  } catch (err) {
    if (child) {
      try {
        if (adapterFor(child)?.live) interrupt(child.id);
      } catch {}
      ctx.patch(ev, { status: 'error', isError: true, output: err.message, childSessionId: child.id, subagent: { ...ev.subagent, status: 'error', error: err.message } });
    } else {
      ctx.patch(ev, { status: 'error', isError: true, output: err.message, subagent: { ...ev.subagent, status: 'error', error: err.message } });
    }
    release();
    return { childSessionId: child?.id || null, provider: targetProvider, model: target.model, effort: target.effort, text: '', error: err.message };
  }
}

// ------------------------------------------------------- session creation

export async function newSession({ agentId, machineId, cwd, prompt, nameHint, permissionMode = 'ask', branch, title, config, mode, provider, subagent, origin, parentId, brokerLink }) {
  // `provider` is the unified API. The legacy agent/agentId/mode fields stay
  // accepted so old callers and old conversations keep working. A session
  // the user starts here is a main chat unless the caller (broker) says
  // otherwise; any other value is rejected, never stored.
  const sessionOrigin = normalizeOrigin(origin, 'hub');
  // A broker child is hidden under its parent from the moment it exists: it
  // is saved, listed and announced with its parentId and its card link, never
  // as a free-standing 子session that is fixed up afterwards.
  const childFields = parentId ? { parentId, state: { broker: brokerLink || { parentId } } } : {};
  if (provider) {
    if (!['kimi', 'claude', 'deepseek'].includes(provider)) throw Object.assign(new Error(`不支援的供應商：${provider}`), { status: 400 });
    if (provider === 'claude') agentId = 'claude';
    else {
      if (!machineId) throw Object.assign(new Error(`${provider === 'deepseek' ? 'DeepSeek' : 'Kimi'} 對話需要選一台電腦`), { status: 400 });
      agentId = `kimi@${machineId}`;
      mode = provider === 'deepseek' ? 'deepseek' : undefined;
    }
  }
  const agent = agentFor(agentId);
  if (!agent) throw Object.assign(new Error(`找不到 agent：${agentId}`), { status: 400 });
  const chosenProvider = provider || (agent.type === 'claude' ? 'claude' : mode === 'deepseek' ? 'deepseek' : agent.type === 'kimi-remote' ? 'kimi' : null);
  const sub = subagent === undefined ? defaultSubagent() : await normalizeSubagent(subagent, { machineId });
  if (chosenProvider && config && (config.model || config.effort)) {
    const choice = await validateChoice({ provider: chosenProvider, model: config.model || '', effort: config.effort || '', machineId, allowEmptyModel: !config.model });
    config = { ...config, model: choice.model, effort: choice.effort };
  }
  let session;
  if (agent.type === 'kimi-remote') {
    const kimi = ADAPTERS['kimi-remote'];
    const availability = kimi.available(agent);
    if (!availability.ok) throw Object.assign(new Error(availability.reason), { status: 409 });
    // A DeepSeek conversation: Kimi has the DeepSeek provider first (the
    // bridge creates it, never touching the subscription or Kimi's default).
    const ds = mode === 'deepseek';
    if (ds) {
      await kimi.ensureServer(agent.machineId);
      if (!(await deepseek.ensureProvider(agent.machineId)).cached) kimi.forgetModels(agent.machineId);
    }
    // Bound to a GitHub repository: cloned on that computer first, and the
    // conversation starts in the clone.
    const { repo, ...settings } = config || {};
    let dir = cwd;
    if (repo) {
      const m = machines.getMachine(agent.machineId);
      dir = await repoBind.clone(remoteHost(agent.machineId), `${String(m?.home || '~').replace(/\/+$/, '')}/agent-hub-workspaces`, repo);
    }
    const r = await kimi.createRemote({ machineId: agent.machineId, cwd: dir, nameHint: nameHint || prompt });
    session = store.createSession({
      agentId,
      cwd: r.cwd,
      machineId: agent.machineId,
      kimiSessionId: r.kimiSessionId,
      permissionMode,
      title: title || '新對話',
      origin: sessionOrigin,
      provider: ds ? 'deepseek' : 'kimi',
      ...childFields,
      modelConfig: { provider: ds ? 'deepseek' : 'kimi', model: config?.model || '', effort: config?.effort || '' },
      ...(ds ? { mode: 'deepseek' } : {}),
      ...(repo ? { repo: { ...repo, url: `https://github.com/${repo.full}/tree/${repo.branch}`, dir: r.cwd } } : {}),
    });
    config = Object.keys(settings).length ? settings : undefined;
    session.state.defaultsApplied = true; // started with what was picked on the home screen
    if (config?.model || config?.effort) session.state.userSet = { ...(session.state.userSet || {}), ...(config.model ? { model: true } : {}), ...(config.effort ? { effort: true } : {}) };
    if (sub) session.meta = { ...(session.meta || {}), subagent: sub };
    if (ds) session.state.deepseek = { gateway: deepseek.gateway(), model: config?.model };
    kimi.restore(session);
    try {
      await kimi.attach(session);
      // Explicit settings must never be swallowed: an invalid model used to
      // leave a session that answered on Kimi's default, which is a silent
      // cross-provider fallback. Any configure failure now rolls back.
      if (ds) await configureDeepseek(kimi, session, config);
      else if (config && Object.values(config).some((v) => v !== undefined && v !== '')) await kimi.configure(session, config);
    } catch (err) {
      kimi.dispose(session);
      store.deleteSession(session.id);
      machines.kimiApi(agent.machineId, 'POST', `/api/v1/sessions/${r.kimiSessionId}:archive`, {}).catch(() => {});
      throw err;
    }
  } else if (agent.type === 'claude') {
    // Run by the Claude daemon of this computer, or of a connected one
    // (`machineId`), which keeps going while the hub is closed.
    const claude = ADAPTERS.claude;
    const why = claude.cannotSend({ machineId });
    if (why) throw Object.assign(new Error(why), { status: 409 });
    let dir = cwd;
    // Bound to a GitHub repository: its clone is the folder (made by the
    // daemon).
    if (config?.repo) dir = '';
    else if (machineId) {
      if (!dir) dir = (await machines.rpc(machineId, 'workspace.create', { name: nameHint || prompt || 'claude' })).path;
      const st = await claude.hostFor({ machineId }).stat(dir, '.');
      if (!st.dir) throw Object.assign(new Error(`資料夾不存在：${dir}`), { status: 400 });
    } else dir ||= await createWorkspace(nameHint || prompt || 'claude');
    session = store.createSession({
      agentId,
      cwd: dir,
      permissionMode,
      title: title || '新對話',
      origin: sessionOrigin,
      provider: 'claude',
      ...childFields,
      modelConfig: { provider: 'claude', model: config?.model || '', effort: config?.effort || '' },
      ...(machineId ? { machineId } : {}),
    });
    if (sub) session.meta = { ...(session.meta || {}), subagent: sub };
    try {
      await claude.create(session, config);
    } catch (err) {
      store.deleteSession(session.id);
      throw err;
    }
  } else {
    const dir = cwd || (await createWorkspace(nameHint || prompt || agent.name));
    session = store.createSession({
      agentId,
      cwd: dir,
      permissionMode,
      branch,
      title: title || '新對話',
      origin: sessionOrigin,
      provider: chosenProvider || 'kimi',
      ...childFields,
      modelConfig: { provider: chosenProvider || 'kimi', model: config?.model || '', effort: config?.effort || '' },
    });
    if (sub) session.meta = { ...(session.meta || {}), subagent: sub };
  }
  if (subagent !== undefined) session.state.subagentExplicit = true;
  broadcast({ t: 'session', session: summarize(session) });
  if (prompt) startTurn(session, prompt);
  return session;
}

// The model, thinking and permission a DeepSeek conversation starts with.
// It must get its model: if Kimi does not know it (the provider was lost
// since it was provisioned), the provider is made again and it is retried.
async function configureDeepseek(kimi, session, config) {
  if (!deepseek.isDeepseekModel(config?.model)) throw Object.assign(new Error('DeepSeek 對話需要選一個 DeepSeek 模型'), { status: 400 });
  try {
    await kimi.configure(session, config);
  } catch (err) {
    console.warn(`[deepseek] configure failed (${err.message}); provisioning again`);
    deepseek.forgetProvider(session.machineId);
    await deepseek.ensureProvider(session.machineId);
    kimi.forgetModels(session.machineId);
    await kimi.configure(session, config);
  }
}

// What a fork carries over from the conversation it was made from. The native
// :fork copies the history (and Kimi restores its model from the copied
// journal), but the Hub's own record of the conversation lives only here:
// without it a DeepSeek conversation forks into a node the Hub takes for a
// Kimi one - the wrong badge, a provider drift on a model that is right, and a
// refusal to send the first message - and the subagent choice is dropped
// (unmarked, so a restart gives it today's global default). Same fields a
// runtime switch gives its new node. Only Kimi/DeepSeek conversations fork
// through here; Claude forks inside its own adapter.
function forkedFrom(source) {
  const provider = providerOf(source) === 'deepseek' ? 'deepseek' : 'kimi';
  const mc = source.modelConfig || {};
  const state = {
    // A fork is not a new conversation: the global defaults are not laid over
    // what its history was running with.
    defaultsApplied: true,
    ...(source.state?.subagentExplicit ? { subagentExplicit: true } : {}),
    ...(source.state?.userSet ? { userSet: { ...source.state.userSet } } : {}),
    ...(source.state?.promptModel ? { promptModel: true } : {}),
    ...(provider === 'deepseek' ? { deepseek: structuredClone(source.state?.deepseek) || { gateway: deepseek.gateway(), model: mc.model || source.meta?.model || '' } } : {}),
  };
  return {
    provider,
    ...(provider === 'deepseek' ? { mode: 'deepseek' } : {}),
    modelConfig: { provider, model: mc.model || source.meta?.model || '', effort: mc.effort || source.meta?.effort || '' },
    meta: Object.hasOwn(source.meta || {}, 'subagent') ? { subagent: structuredClone(source.meta.subagent) } : {},
    state,
  };
}

// Take over a Kimi session that already exists on a machine (e.g. one handed
// to the local Kimi server with /web). Reuses the hub session if attached,
// without upgrading or rewriting its origin: merely looking at an external
// native conversation must leave it external.
//
// Two requests for the same native conversation at once (a double click, a
// fork and a click on the computer's list) used to both find no node, wait for
// the machine, and each make one: two nodes bound to one native conversation.
// The second request now joins the first.
const attachingKimi = new Map(); // `${machineId}:${kimiSessionId}` -> the attach in progress
export function attachKimi(machineId, kimiSessionId, opts = {}) {
  const key = `${machineId}:${kimiSessionId}`;
  let running = attachingKimi.get(key);
  if (!running) {
    running = attachKimiNow(machineId, kimiSessionId, opts).finally(() => attachingKimi.delete(key));
    attachingKimi.set(key, running);
  }
  return running;
}

async function attachKimiNow(machineId, kimiSessionId, { origin = 'external', from = null } = {}) {
  const attachedOrigin = normalizeOrigin(origin, 'external');
  const existing = ADAPTERS['kimi-remote'].findByKimi(machineId, kimiSessionId);
  if (existing && store.getSession(existing)) {
    const s = store.getSession(existing);
    await ADAPTERS['kimi-remote'].attach(s).catch(() => {});
    return s;
  }
  // Read from the conversation's files on the machine, so this works for
  // conversations running in a terminal and without a Kimi server.
  const info = (await machines.rpc(machineId, 'kimi.info', { sessionId: kimiSessionId }).catch(() => null)) || (await machines.kimiApi(machineId, 'GET', `/api/v1/sessions/${kimiSessionId}`));
  if (!info) throw Object.assign(new Error('找不到這個 Kimi 對話'), { status: 404 });
  const session = store.createSession({
    agentId: `kimi@${machineId}`,
    machineId,
    kimiSessionId,
    cwd: info.metadata?.cwd,
    title: info.title || info.last_prompt || 'Kimi 對話',
    titled: true,
    origin: attachedOrigin,
    ...(from ? forkedFrom(from) : {}),
  });
  ADAPTERS['kimi-remote'].restore(session);
  broadcast({ t: 'session', session: summarize(session) });
  await ADAPTERS['kimi-remote'].attach(session);
  session.provider = store.nodeProvider(session);
  session.modelConfig = {
    provider: session.provider,
    model: session.meta?.model || session.modelConfig?.model || '',
    effort: session.meta?.effort || session.modelConfig?.effort || '',
  };
  store.saveSession(session);
  broadcast({ t: 'session', session: summarize(session) });
  return session;
}
