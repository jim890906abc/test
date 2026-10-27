// Shared by the leak tests: scratch folders and the PIDs a test file starts,
// all ended in the file's `after` (a leak test must not leak itself).
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRunning } from '../../scripts/proc-scan.mjs';
import { killAllGroups } from './proc-group.mjs';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const gone = (pid) => !isRunning(pid);
export async function until(fn, ms = 8000, what = 'condition') {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await delay(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Call once at the top of a test file. `mk(label)` makes a scratch folder
// (agent-hub-leakhyg-*), `track(pid)` registers a process to be killed at the end.
export function leakKit() {
  const scratch = [];
  const ownPids = new Set();
  const mk = (label) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `agent-hub-leakhyg-${label}-`));
    scratch.push(d);
    return d;
  };
  const track = (pid) => (ownPids.add(pid), pid);
  after(async () => {
    await killAllGroups({ termMs: 500 });
    for (const pid of ownPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
  });
  return { mk, track, scratch };
}
