// What a conversation's summary is when it is only listed (server/session-list.js),
// and what a cluster worker is until it is opened: the parts of a summary that
// only the open conversation needs are taken out. Shared by the Hub (which makes
// them) and the page (which makes a worker's stub from what a cluster says, and
// tells a listed summary from a whole one, and keeps the stubs current from what
// a cluster says: syncWorkers).

// What a listed summary does not carry. Everything else in `meta` stays: the
// sidebar and the menus read `owner`, `machineName`, `salvaged`, `permission`,
// `budget`, `tps` and others from it for conversations that are not open.
export const OMITTED_FROM_LIST = ['models', 'skills', 'queue', 'todos'];

export const isClusterWorker = (s) => s?.clusterRole === 'worker';

// A summary in its listed form, marked `slim` so that a page can tell it from
// the whole one (it never replaces the whole one of the conversation it shows).
export function listForm(summary) {
  if (!summary || summary.slim) return summary;
  const meta = summary.meta && typeof summary.meta === 'object' ? Object.fromEntries(Object.entries(summary.meta).filter(([k]) => !OMITTED_FROM_LIST.includes(k))) : summary.meta;
  return { ...summary, meta, slim: true };
}

// A cluster worker as the sidebar keeps it until it is opened: what a row, a
// search and the "needs you" notice read - nothing of its settings or lists.
// From a summary (the Hub's list) or, with `from`, built by the page.
export function workerStub(summary) {
  const { id, title, cwd, status, agentId, machineId, kimiSessionId, provider, nextProvider, mode, conversationId, leafId, clusterId, clusterRole, clusterHidden, pendingChildPermission, updatedAt, createdAt, origin } = summary;
  return { id, title, cwd, status, agentId, machineId, kimiSessionId, provider, nextProvider, mode, conversationId: conversationId || id, leafId: leafId || id, isLeaf: true, continuedFrom: null, continuedTo: null, clusterId, clusterRole: clusterRole || 'worker', clusterHidden: Boolean(clusterHidden), pendingChildPermission: Boolean(pendingChildPermission), modelDrift: null, updatedAt, createdAt, origin, stub: true };
}

// A list read again (after the link was down) must not make the conversation
// that is open listed: it holds that one whole, with the lists a listed
// summary leaves out. The fresh word wins for everything the list carries; the
// lists come from what the page holds (the snapshot refreshes them).
export function mergeWhole(fresh, held) {
  if (!fresh || !held || held.slim || held.id !== fresh.id || !held.meta) return fresh;
  const kept = Object.fromEntries(OMITTED_FROM_LIST.filter((k) => held.meta[k] !== undefined).map((k) => [k, held.meta[k]]));
  if (!Object.keys(kept).length) return fresh;
  const { slim, ...rest } = fresh;
  return { ...rest, meta: { ...fresh.meta, ...kept } };
}

// The stubs of the workers (a Map: session id -> stub) after a cluster was
// told: a status, a title or a waiting subagent that moved, a worker that is
// new, one whose conversation was deleted. `parent` is the conversation that
// dispatched the cluster, if the page has it (a new worker's computer and
// folder). True when something a row shows changed.
export function syncWorkers(stubs, cluster, { parent = null, now = Date.now() } = {}) {
  let changed = false;
  // A cluster names a worker by the conversation it made; the Hub's list names it by the leaf of its chain, which is another node once the worker has gone on in a new one. Both are one stub.
  const leafOf = new Map();
  for (const [key, st] of stubs) if (st.conversationId && st.conversationId !== key) leafOf.set(st.conversationId, key);
  for (const w of cluster?.workers || []) {
    if (!w?.sessionId) continue;
    const key = stubs.has(w.sessionId) ? w.sessionId : leafOf.get(w.sessionId) || w.sessionId;
    if (w.status === 'deleted') {
      changed = stubs.delete(key) || changed;
      continue;
    }
    const waiting = Number(w.subagentCounts?.awaiting) > 0;
    const prev = stubs.get(key);
    if (!prev) {
      stubs.set(w.sessionId, {
        id: w.sessionId, title: w.title, cwd: parent?.cwd, status: w.status, agentId: parent?.agentId, machineId: parent?.machineId, provider: parent?.provider || 'kimi', nextProvider: parent?.provider || 'kimi', mode: null,
        conversationId: w.sessionId, leafId: w.sessionId, isLeaf: true, continuedFrom: null, continuedTo: null, clusterId: cluster.id, clusterRole: 'worker', clusterHidden: Boolean(w.hidden), pendingChildPermission: waiting, modelDrift: null, updatedAt: now, createdAt: now, origin: 'hub', stub: true,
      });
      changed = true;
      continue;
    }
    const next = { ...prev, title: w.title || prev.title, status: w.status, clusterHidden: Boolean(w.hidden), pendingChildPermission: waiting };
    if (next.status !== prev.status) next.updatedAt = now;
    if (next.title === prev.title && next.status === prev.status && next.clusterHidden === prev.clusterHidden && next.pendingChildPermission === prev.pendingChildPermission) continue;
    stubs.set(key, next);
    changed = true;
  }
  return changed;
}
