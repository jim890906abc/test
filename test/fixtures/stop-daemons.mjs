// Ending the Claude daemon a test's Hub started. The daemon is built to outlive
// its Hub (so a conversation can finish after the Hub is closed), which means a
// test that only stops the Hub leaves it behind — one per test, for ever.
//
//   await stopDaemons(dataDir)       // dataDir: the test's scratch folder (or its data/ inside it)
//   stopDaemonsSync(dataDir)         // the same where the caller cannot await
//   stopHubAndDaemons(proc, dir)     // Hub first (a live Hub restarts its daemon), then the daemons
//
// It finds the daemons by looking at every process's command line for a
// claude-daemon script whose `--dir` is the given folder or inside it, sends
// them SIGTERM, waits, and SIGKILLs the ones that did not end. It never uses
// `pkill -f` / `pgrep -f` (text matching can reach a process that is not ours,
// and some environments refuse it), and it refuses a folder outside the temp
// folder, so a daemon of real data can never be reached from here.
import { stopChildSync, stopDaemons, stopDaemonsSync } from '../../scripts/proc-scan.mjs';
import './leak-net.mjs';

export { stopChildSync, stopDaemons, stopDaemonsSync };

// The Hub first, and only when it has really gone the daemons (otherwise the
// Hub starts a new daemon two seconds after the old one ended).
export function stopHubAndDaemons(hubProc, scratchDir) {
  stopChildSync(hubProc);
  return stopDaemonsSync(scratchDir);
}
