// "This test left nothing behind", as an assertion.
//
//   const before = snapshot();                 // before the test starts anything
//   ... the test starts and ends things ...
//   await assertNoLeaks(before, { dirs: [tmp] });   // in `after`
//
// assertNoLeaks fails — and lists them — when a process that was not there at
// snapshot() time is still running and belongs to this test: it carries this
// test file's stamp (everything the file spawns inherits it, a Claude daemon
// the Hub started included) or it points into one of the scratch folders given
// as `dirs` (command line, working folder, environment: that also finds the
// stand-ins of a script run with a clean environment). A process that is
// shutting down gets `settleMs` to finish first.
//
// This sees what the test's clean-up missed, so it must run AFTER the clean-up
// and must not end anything itself: it is the check, not a second clean-up.
import { ENV_PROC, ancestorsOf, environOf, isSelfEnding, isUnder, listProcesses, ownerDirOf, sleepSync } from '../../scripts/proc-scan.mjs';
import { STAMP } from './leak-net.mjs';

const key = (p) => `${p.pid}:${p.startTicks}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function snapshot() {
  return { at: Date.now(), seen: new Set(listProcesses().map(key)) };
}

// The processes now running that were not in `before` and belong to this test.
// `stamp: false`: only those that point into `dirs` (a fixture that stops one
// Hub must not count the browser the same test file still has open).
export function leaksSince(before, { dirs = [], stamp = true } = {}) {
  const procs = listProcesses();
  const skip = new Set([process.pid, ...ancestorsOf(procs, process.pid)]);
  const out = [];
  for (const p of procs) {
    if (skip.has(p.pid) || p.state === 'Z' || p.state === 'X' || isSelfEnding(p) || before.seen.has(key(p))) continue;
    const env = environOf(p.pid);
    const owner = ownerDirOf(p, { env });
    const mine = (stamp && env?.get(ENV_PROC) === STAMP) || (owner && dirs.some((d) => owner === d || isUnder(d, owner) || isUnder(owner, d)));
    if (mine) out.push(p);
  }
  return out;
}

function leakError(left) {
  const lines = left.map((p) => `  ${p.pid}  ppid ${p.ppid}  ${p.args.join(' ').slice(0, 160)}`);
  const err = new Error(`the test left ${left.length} process(es) running:\n${lines.join('\n')}`);
  err.name = 'AssertionError';
  err.leaks = left;
  return err;
}

export async function assertNoLeaks(before, { settleMs = 3000, ...opts } = {}) {
  let left = leaksSince(before, opts);
  for (const until = Date.now() + settleMs; left.length && Date.now() < until;) {
    await delay(100);
    left = leaksSince(before, opts);
  }
  if (left.length) throw leakError(left);
}

// The same where the caller cannot await (a fixture's synchronous stop()).
export function assertNoLeaksSync(before, { settleMs = 3000, ...opts } = {}) {
  let left = leaksSince(before, opts);
  for (const until = Date.now() + settleMs; left.length && Date.now() < until;) {
    sleepSync(100);
    left = leaksSince(before, opts);
  }
  if (left.length) throw leakError(left);
}
