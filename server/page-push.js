// What a page is sent of the things every page is told, when it has said it
// keeps the slim forms ({ t: 'watch', slim: 1 }; a page that did not gets every
// message whole, as before).
//
// A page that shows nothing in particular was sent, in 15 seconds on the VPS
// Hub, 6 times a computer's whole list of conversations (40 KB each), 15 times
// a whole cluster (11 KB) and 8 times a whole conversation summary - most of it
// what the page already had. Now each page is told what changed since it was
// last told (the Hub keeps, per page, what it sent):
//   machine    the first time, the computer as the sidebar keeps it (without the
//              Kimi conversations of cluster workers, which no row shows); then
//              `machine.patch`: the computer's own fields if they moved, the list
//              entries that are new or changed, the ids that are gone. Nothing
//              changed, nothing sent.
//   cluster    the first time whole; then `cluster.patch`, the difference to the
//              cluster last sent (public/js/json-patch.js), or nothing.
//   session    a cluster worker's summary only to a page that shows that worker;
//              others in their listed form (public/js/list-form.js), the whole one
//              only to the page that shows the conversation; the same summary
//              twice in a row is sent once.
//   kimi.session  not for a worker's native conversation (no row shows it).
// What a page is not sent it can always read (GET /api/clusters/:id,
// /api/sessions/:id, /api/machines) - and the page does read it where a patch
// finds nothing to patch.
import crypto from 'node:crypto';
import { diff } from '../public/js/json-patch.js';
import { isClusterWorker, listForm } from '../public/js/list-form.js';

const MAX_SESSIONS_REMEMBERED = 400;

// What this page has been sent, kept on its socket.
const stateOf = (ws) => (ws.sent ??= { machines: new Map(), clusters: new Map(), sessions: new Map() });
const sha = (text) => crypto.createHash('sha1').update(text).digest('base64');

// A message's way of reaching a slim page, or null when it has none (it goes
// as it is). `deps`: { sidebarView(machine), isWorkerNative(machineId, id) }.
// `deliver(ws, whole)` gives the texts to send that page (none: it has it);
// `whole()` is the message as it is, as text.
export function prepare(msg, deps) {
  if (msg?.t === 'machine' && msg.machine?.id) return machineMessage(msg, deps);
  if (msg?.t === 'machines') return { deliver: (ws, whole) => (ws.sent?.machines.clear(), [whole()]) };
  if (msg?.t === 'kimi.session') return kimiSessionMessage(msg, deps);
  if (msg?.t === 'cluster' && msg.cluster?.id) return clusterMessage(msg);
  if (msg?.t === 'session' && msg.session?.id) return sessionMessage(msg);
  return null;
}

// The page opened a conversation: what it will be sent of that one from now on does not depend on what it was sent before.
export function forgetSession(ws, id) {
  ws.sent?.sessions.delete(id);
}

function machineMessage(msg, deps) {
  const view = deps.sidebarView(msg.machine);
  const { sessions, ...head } = view;
  const headText = JSON.stringify(head);
  // What counts as the computer having changed: its own fields, but not the
  // `lastSeen` of one that is online - it moves with every message the
  // computer sends, and a page shows it only for a computer that is off.
  const headKey = head.online ? JSON.stringify({ ...head, lastSeen: null }) : headText;
  const entries = sessions.map((e) => [e.id, JSON.stringify(e)]);
  return {
    deliver(ws) {
      const mine = stateOf(ws).machines;
      const prev = mine.get(view.id);
      mine.set(view.id, { key: headKey, entries: new Map(entries) });
      if (!prev) return [`{"t":"machine","machine":${headText.slice(0, -1)},"sessions":[${entries.map((e) => e[1]).join(',')}]}}`];
      const upsert = entries.filter(([id, text]) => prev.entries.get(id) !== text).map((e) => e[1]);
      const now = mine.get(view.id).entries;
      const remove = [...prev.entries.keys()].filter((id) => !now.has(id));
      const headMoved = prev.key !== headKey;
      if (!headMoved && !upsert.length && !remove.length) return [];
      return [`{"t":"machine.patch","id":${JSON.stringify(view.id)}${headMoved ? `,"machine":${headText}` : ''},"upsert":[${upsert.join(',')}],"remove":${JSON.stringify(remove)}}`];
    },
  };
}

function kimiSessionMessage(msg, deps) {
  const removed = msg.removed === true;
  const id = removed ? msg.id : msg.session?.id;
  const text = removed ? null : JSON.stringify(msg.session);
  return {
    deliver(ws, whole) {
      const mine = ws.sent?.machines.get(msg.machineId);
      if (removed) {
        mine?.entries.delete(id);
        return [whole()];
      }
      if (deps.isWorkerNative(msg.machineId, id)) return [];
      mine?.entries.set(id, text);
      return [whole()];
    },
  };
}

function clusterMessage(msg) {
  const id = msg.cluster.id;
  const text = JSON.stringify(msg.cluster);
  let snap = null;
  return {
    deliver(ws, whole) {
      const mine = stateOf(ws).clusters;
      const prev = mine.get(id);
      if (prev?.text === text) return [];
      snap ??= JSON.parse(text);
      mine.set(id, { text, snap });
      if (!prev) return [whole()];
      const patch = diff(prev.snap, snap);
      if (patch === undefined) return [];
      const patchText = JSON.stringify(patch);
      // A patch that is no smaller than the cluster is not worth the page's work.
      if (patchText.length >= text.length) return [whole()];
      return [`{"t":"cluster.patch","id":${JSON.stringify(id)},"patch":${patchText}}`];
    },
  };
}

function sessionMessage(msg) {
  const id = msg.session.id;
  const worker = isClusterWorker(msg.session);
  const forms = {};
  // The message in its listed form, and the hash of either form, worked out once for all pages.
  const text = (form, whole) => (forms[form] ??= form === 'whole' ? whole() : JSON.stringify({ ...msg, session: listForm(msg.session) }));
  const hashes = {};
  const hashOf = (form, whole) => (hashes[form] ??= sha(text(form, whole)));
  return {
    deliver(ws, whole) {
      const watching = ws.watch === id;
      if (worker && !watching) return [];
      const form = watching ? 'whole' : 'listed';
      const mine = stateOf(ws).sessions;
      const hash = hashOf(form, whole);
      if (mine.get(id) === hash) return [];
      mine.delete(id);
      mine.set(id, hash);
      if (mine.size > MAX_SESSIONS_REMEMBERED) mine.delete(mine.keys().next().value);
      return [text(form, whole)];
    },
  };
}
