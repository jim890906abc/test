// What a Hub that starts after a crash finds in a data folder: it loads the
// conversations the way server/index.js does and says what it got.
//
//   node store-read-child.mjs <data dir>
// prints one JSON line: { loaded, damaged, events, last }
//   damaged  the conversations loadSessions() could not take as they were (a
//            half-written file would show up here)
//   last     the number n of the last `n_<n>` event the streaming child made
//            that is on disk (-1: none)
const [dataDir] = process.argv.slice(2);
process.env.AGENT_HUB_DATA = dataDir;
process.env.AGENT_HUB_WORKSPACES = `${dataDir}/ws`;
const store = await import('../../server/store.js');
store.loadSessions();
const s = store.getSession('s_stream');
let last = -1;
for (let i = (s?.events.length ?? 0) - 1; i >= 0; i--) {
  const m = /^n_(\d+)$/.exec(s.events[i].id);
  if (m) {
    last = Number(m[1]);
    break;
  }
}
console.log(JSON.stringify({ loaded: Boolean(s), damaged: store.listDamaged().length, events: s?.events.length ?? 0, last }));
