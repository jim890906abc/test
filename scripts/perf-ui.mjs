#!/usr/bin/env node
// How the front end feels, measured in a real Chromium, printed as a table.
//
//   node scripts/perf-ui.mjs                      # a synthetic big conversation
//   node scripts/perf-ui.mjs --data DIR           # a COPY of a real data folder
//   node scripts/perf-ui.mjs --only switch,drag   # some sections (switch, drag, stream, input, motion, memory, theme)
//   node scripts/perf-ui.mjs --only theme --trace  # colour changes, with a Chrome trace round for the longest task
//   node scripts/perf-ui.mjs --window 200         # serve conversations in windows of 200 events
//                                                 # (the contract of the Hub's windowed snapshot)
//
// --data is copied first; the original is never opened for writing. Without a
// Chromium the script says so and exits 0 (CHROMIUM_BIN points at one).
import { skipReason } from '../test/browser-harness.mjs';
import { runPerf, printTable } from '../test/perf-suite.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};

const why = skipReason();
if (why) {
  console.log(`perf-ui: skipped — ${why}`);
  process.exit(0);
}

const result = await runPerf({
  dataDir: opt('data', null),
  only: String(opt('only', 'switch,drag,stream,input,motion,memory,theme')).split(','),
  runs: Number(opt('runs', 5)),
  events: Number(opt('events', 3000)),
  window: Number(opt('window', 0)),
  ids: opt('ids', null) ? String(opt('ids')).split(',') : null,
  themeTrace: args.includes('--trace'),
  log: (m) => console.error(m),
});
printTable(result);
const out = opt('json', null);
if (out && out !== true) (await import('node:fs')).writeFileSync(out, JSON.stringify(result, null, 2));
