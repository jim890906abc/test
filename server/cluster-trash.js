// The backups a full purge (完全清除) leaves behind, and their end.
//
// Before anything of a cluster is deleted it is packed: on the computer of the
// workers (their Kimi conversation folders, the cluster's memory) into
// <connector state dir>/trash/cluster-<id>-<time>.tar.gz, and on the Hub (the
// workers' conversation files and the cluster's record) into data/trash/. They
// are kept for PURGE_DAYS days and then deleted - by the Hub (a check at start,
// when a computer connects, and once a day) and, for what lies on a computer,
// also by the connector itself (it checks the same way, so a computer whose Hub
// is gone does not keep them for ever).
//
// data/trash/index.json says what was backed up, where and until when, and what
// the purge left in place. It is the only list of them: a backup file that is
// not in it is not touched.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as machines from './machines.js';
import * as mem from './cluster-memory.js';
import { PURGE_DAYS } from '../public/js/cluster-model.js';

export const TRASH_DAYS = PURGE_DAYS;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const trashDir = () => path.join(store.DATA_DIR, 'trash');
const indexFile = () => path.join(trashDir(), 'index.json');
// The only names this ever deletes on a computer.
export const BACKUP_NAME = /^cluster-c_[0-9a-f]{12}-[0-9A-Za-z._-]+\.tar\.gz$/;

export function readIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

function writeIndex(items) {
  fs.mkdirSync(trashDir(), { recursive: true, mode: 0o700 });
  store.writeJsonAtomic(indexFile(), { version: 1, items });
}

export function addEntry(entry) {
  writeIndex([entry, ...readIndex().filter((e) => e.id !== entry.id)]);
  return entry;
}

// A new file name in data/trash for this cluster: cluster-<id>-<time>.tar.gz
export const stampOf = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const backupName = (cid, ms) => `cluster-${cid}-${stampOf(ms)}.tar.gz`;

// What the page lists: the purges whose backups are still kept.
export function listPurged() {
  return readIndex().map((e) => ({
    id: e.id,
    clusterId: e.clusterId,
    name: e.name,
    purgedAt: e.purgedAt,
    expiresAt: e.expiresAt,
    partial: Boolean(e.partial),
    hub: e.hub ? { file: e.hub.file, bytes: e.hub.bytes, removed: Boolean(e.hub.removed) } : null,
    machine: e.machine ? { machineId: e.machine.machineId, machineName: e.machine.machineName, path: e.machine.path, bytes: e.machine.bytes, removed: Boolean(e.machine.removed) } : null,
    kept: Array.isArray(e.kept) ? e.kept : [],
  }));
}

let sweeping = null;
// Deletes the backups whose time is up. What is on a computer that is not
// connected waits for it (the entry stays until it is gone). → { removed: [ids], waiting: [ids] }
export function sweep({ now = Date.now() } = {}) {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    const removed = [];
    const waiting = [];
    for (const e of readIndex()) {
      if (!(e.expiresAt <= now)) continue;
      let changed = false;
      const cur = { ...e };
      if (cur.hub && !cur.hub.removed) {
        try {
          fs.rmSync(path.join(trashDir(), path.basename(cur.hub.file)), { force: true });
          cur.hub = { ...cur.hub, removed: true };
          changed = true;
        } catch (err) {
          console.warn(`[cluster] trash ${cur.id}: could not delete ${cur.hub.file}: ${err.message}`);
        }
      }
      if (cur.machine && !cur.machine.removed) {
        const m = machines.getMachine(cur.machine.machineId);
        const file = String(cur.machine.path || '');
        const safe = BACKUP_NAME.test(path.posix.basename(file)) && path.posix.basename(path.posix.dirname(file)) === 'trash';
        if (!safe) {
          // Not a file this made: never delete it, and do not keep waiting for it.
          console.warn(`[cluster] trash ${cur.id}: ${file} is not a backup name; left alone`);
          cur.machine = { ...cur.machine, removed: true, left: true };
          changed = true;
        } else if (m?.online) {
          try {
            const r = await mem.sh(cur.machine.machineId, '/', `rm -f ${mem.quote(file)}`, { timeoutMs: 30_000 });
            if (r.exitCode === 0) {
              cur.machine = { ...cur.machine, removed: true };
              changed = true;
            } else console.warn(`[cluster] trash ${cur.id}: rm on ${m.name} failed: ${r.output.trim().slice(0, 200)}`);
          } catch (err) {
            console.warn(`[cluster] trash ${cur.id}: rm on ${m.name} failed: ${err.message}`);
          }
        }
      }
      const finished = (!cur.hub || cur.hub.removed) && (!cur.machine || cur.machine.removed);
      if (finished) {
        writeIndex(readIndex().filter((x) => x.id !== cur.id));
        removed.push(cur.id);
      } else {
        if (changed) writeIndex(readIndex().map((x) => (x.id === cur.id ? cur : x)));
        waiting.push(cur.id);
      }
    }
    return { removed, waiting };
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

let timer = null;
// At start, whenever a computer connects (what waited for it), and once a day.
export function startSweeper({ every = DAY_MS } = {}) {
  if (timer) return;
  const run = () => sweep().catch((err) => console.warn(`[cluster] trash sweep: ${err.message}`));
  setTimeout(run, 2000).unref?.();
  machines.onMachineOnline(() => setTimeout(run, 3000).unref?.());
  timer = setInterval(run, every);
  timer.unref?.();
}
