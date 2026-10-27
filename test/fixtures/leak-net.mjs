// The safety net under every test file: when the file's process ends (normally,
// by an uncaught error, or because the runner sent SIGTERM/SIGINT), whatever it
// started and did not end is ended here instead of being left behind.
//
// How it knows what the file started: it stamps its own PID into the
// environment (AGENT_HUB_TEST_PROC) before anything is spawned. Children
// inherit it — and so do their children, a Claude daemon the Hub started
// included, even once the Hub is gone. Only processes carrying THIS file's PID
// are ended; a stamp is not guessable by another test, and nothing is matched
// by command text.
//
// It is meant to be the last line of defence, not the way tests clean up: the
// fixtures end what they start (test/fixtures/stop-daemons.mjs,
// proc-group.mjs). A process the net had to end is reported on stderr, so a
// test that depends on it can be found and fixed.
//
// Loaded for every file by `npm test` (--import, see scripts/run-tests.mjs);
// a test that starts processes also imports it, so that running that one file
// by hand is covered too. Importing it twice is harmless.
import { ENV_PROC, HAS_PROC, environOf, isSelfEnding, listProcesses, terminateSync } from '../../scripts/proc-scan.mjs';

// `node --test`'s own process only starts the files; each file runs in a child
// process of its own (NODE_TEST_CONTEXT is set there).
const isRunner = process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT;
const startedAt = Date.now();

export const STAMP = String(process.pid);

export function sweepOwned({ report = true } = {}) {
  if (!HAS_PROC) return [];
  const found = [];
  for (const p of listProcesses()) {
    if (p.pid === process.pid || p.state === 'Z' || isSelfEnding(p)) continue;
    if (p.startMs && p.startMs < startedAt - 2000) continue; // began before this process: not its child
    if (environOf(p.pid)?.get(ENV_PROC) === STAMP) found.push(p);
  }
  if (!found.length) return [];
  const res = terminateSync(found, { graceMs: 2000, killMs: 1500 });
  if (report) {
    const names = found.slice(0, 4).map((p) => `${p.pid} ${p.args.join(' ').slice(0, 90)}`).join('; ');
    process.stderr.write(`[leak-net] ${process.argv[1] || 'a test'} ended with ${found.length} process(es) still running; the net ended them (${res.ended.length} on TERM, ${res.killed.length} on KILL${res.stuck.length ? `, ${res.stuck.length} would not end` : ''}): ${names}\n`);
  }
  return found;
}

if (!isRunner && !globalThis.__agentHubLeakNet) {
  globalThis.__agentHubLeakNet = true;
  process.env[ENV_PROC] = STAMP;
  let swept = false;
  const once = () => {
    if (swept) return;
    swept = true;
    try {
      sweepOwned();
    } catch {}
  };
  process.on('exit', once);
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    process.on(sig, () => {
      once();
      process.exit(code);
    });
  }
}
