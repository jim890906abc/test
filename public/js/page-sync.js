// What the page does with the slim messages the Hub sends it (server/page-push.js),
// kept free of the DOM so it can be tested directly in node.
//
//   machine.patch  one computer: its own fields if they moved, the list entries
//                  that are new or changed, the ids that are gone
//   cluster.patch  the difference between the cluster the Hub last sent this page
//                  and the one it has now (public/js/json-patch.js)
import { apply } from './json-patch.js';

// The computer after a `machine.patch`: { before, machine } - or null when this
// page has no such computer (it must ask the Hub for the list). Does not change `machines`.
export function patchMachine(machines, msg) {
  const before = (machines || []).find((m) => m.id === msg?.id);
  if (!before) return null;
  const gone = new Set(msg.remove || []);
  const incoming = new Map((msg.upsert || []).filter((e) => e?.id).map((e) => [e.id, e]));
  const kept = [];
  const replaced = new Set();
  for (const e of before.sessions || []) {
    if (gone.has(e.id)) continue;
    if (incoming.has(e.id)) {
      kept.push(incoming.get(e.id));
      replaced.add(e.id);
    } else kept.push(e);
  }
  // A new conversation goes first, as a `kimi.session` puts it.
  const fresh = [...incoming.values()].filter((e) => !replaced.has(e.id));
  return { before, machine: { ...(msg.machine || before), sessions: [...fresh, ...kept] } };
}

// The page's copy of each cluster as the Hub last sent it, to apply a patch to.
// What it hands out is the page's own to keep and change; this copy is never
// handed out.
export function createClusterSync() {
  const sent = new Map(); // cluster id -> the cluster as last sent
  return {
    // A whole cluster arrived: remember it, hand it on.
    whole(cluster) {
      if (cluster?.id) sent.set(cluster.id, structuredClone(cluster));
      return cluster;
    },
    // A patch arrived: the cluster it makes, or null when the page was never sent that cluster whole (it must ask the Hub for it).
    patch(msg) {
      const base = sent.get(msg?.id);
      if (!base || !msg.patch) return null;
      const next = apply(base, msg.patch);
      sent.set(msg.id, structuredClone(next));
      return next;
    },
    has: (id) => sent.has(id),
  };
}
