// A stand-in Hub process for the save-loss tests: it holds one big conversation
// and streams into it the way a working agent does (a new event every tick, the
// conversation saved on every change), printing a line for every event it made,
// so the test that kills it (SIGKILL: no handler runs, nothing is flushed) knows
// exactly what it had produced.
//
//   node store-stream-child.mjs <data dir> <size in MB> <events per second> <seconds before the turn ends | never>
//
// stdout, one line each:
//   ready <ms the first whole write took>
//   tick <n> <ts>          event n was made (and saveSession called) at ts
//   turn-end <n> <ts>      the turn is over: status back to idle, saved
import { makeEvents } from './big-session.mjs';

const [dataDir, mb, rate, endAfter] = process.argv.slice(2);
process.env.AGENT_HUB_DATA = dataDir;
process.env.AGENT_HUB_WORKSPACES = `${dataDir}/ws`;
const store = await import('../../server/store.js');
const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = store.createSession({ id: 's_stream', title: 'streaming worker', status: 'idle', events: makeEvents({ mb: Number(mb) }) });
const t0 = performance.now();
await store.persistNow(s);
say(`ready ${Math.round(performance.now() - t0)}`);

s.status = 'running';
store.saveSession(s);
const started = Date.now();
for (let n = 0; ; n++) {
  if (endAfter !== 'never' && Date.now() - started >= Number(endAfter) * 1000) {
    s.status = 'idle';
    store.saveSession(s); // what runner.setStatus does when the turn is over
    say(`turn-end ${n - 1} ${Date.now()}`);
    await sleep(3_600_000);
  }
  const ts = Date.now();
  s.events.push({ id: `n_${n}`, ts, type: 'text', text: `streamed ${n}` });
  s.seq = n;
  store.saveSession(s);
  say(`tick ${n} ${ts}`);
  await sleep(1000 / Number(rate));
}
