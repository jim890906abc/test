// Starting a script under test as a process GROUP and ending the whole group.
//
// A test that runs scripts/start-public.sh (or a Hub, or a browser) starts more
// than one process: the script, the things it starts, and what those start.
// Signalling only the first leaves the rest behind whenever the first dies
// without cleaning up (SIGKILL after a slow shutdown on a loaded machine, a
// test that timed out). So:
//   spawnGroup(cmd, args, opts)  → like spawn, but the child leads its own group
//   killGroup(child)             → SIGTERM the group, wait until it is empty,
//                                  SIGKILL what is left, wait again
//   killAllGroups()              → every group still registered (an `after` hook)
// and a last-resort 'exit' hook SIGKILLs any group still registered when this
// process ends (an uncaught error, a runner that stops the file).
//
// Only the group this module created is ever signalled (negative PID of a
// child we spawned); nothing is matched by name.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_PROC, HAS_PROC, environOf, listProcesses } from '../../scripts/proc-scan.mjs';
import { STAMP } from './leak-net.mjs';

const groups = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function spawnGroup(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid) {
    groups.add(child.pid);
    child.once('exit', () => {
      // The leader is gone; its group may not be. Keep it registered until killGroup/killAllGroups sees it empty.
    });
  }
  return child;
}

function signalGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Members of the group that are really running (a zombie waiting to be reaped
// is not) and are ours: a group number can be handed to a stranger once the old
// group is empty, so a member counts only when it carries this test file's stamp
// (everything spawned here inherits it, see leak-net.mjs).
export function groupMembers(pgid) {
  if (HAS_PROC) return listProcesses().filter((p) => p.pgid === pgid && p.state !== 'Z' && p.state !== 'X' && environOf(p.pid)?.get(ENV_PROC) === STAMP);
  try {
    process.kill(-pgid, 0);
    return [{ pid: pgid }];
  } catch (err) {
    return err.code === 'EPERM' ? [{ pid: pgid }] : [];
  }
}

export async function killGroup(child, { termMs = 5000, killMs = 3000 } = {}) {
  const pgid = typeof child === 'number' ? child : child?.pid;
  if (!pgid) return { forced: false };
  let forced = false;
  if (groupMembers(pgid).length) {
    signalGroup(pgid, 'SIGTERM');
    for (const until = Date.now() + termMs; Date.now() < until && groupMembers(pgid).length;) await delay(50);
  }
  if (groupMembers(pgid).length) {
    forced = true;
    signalGroup(pgid, 'SIGKILL');
    for (const until = Date.now() + killMs; Date.now() < until && groupMembers(pgid).length;) await delay(50);
  }
  if (!groupMembers(pgid).length) groups.delete(pgid);
  return { forced };
}

export async function killAllGroups(opts) {
  const forced = [];
  for (const pgid of [...groups]) if ((await killGroup(pgid, opts)).forced) forced.push(pgid);
  return forced;
}

// The stop files the stand-in node / cloudflared wait for (see
// test/start-public-fixtures.mjs): written before the folder is deleted, so a
// stand-in that is somehow still running finds its file and ends, instead of
// waiting for ever for a file in a folder that no longer exists.
export function releaseGate(gate) {
  try {
    for (const name of ['stop-hub', 'stop-bridge']) fs.writeFileSync(path.join(gate, name), '');
    for (const f of fs.readdirSync(gate)) {
      const m = /^cf-(\d+)\.pid$/.exec(f);
      if (m) fs.writeFileSync(path.join(gate, `stop-cf-${m[1]}`), '');
    }
  } catch {}
}

process.on('exit', () => {
  for (const pgid of groups) signalGroup(pgid, 'SIGKILL');
});
