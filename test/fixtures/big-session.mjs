// A synthetic conversation of a chosen size for the save-cost tests: the mix a
// busy worker really has (many short events, some tool calls with a few KB of
// output, now and then a very large tool output), deterministic, and with
// content that does not repeat (so nothing can shrink it).
//
//   makeEvents({ mb: 40 })  ->  [ { id, ts, type, ... }, ... ]  (~40 MB as JSON)

// A small deterministic generator (mulberry32): same numbers on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 _-/.:{}[]"\\\n';
function noise(next, n) {
  let out = '';
  while (out.length < n) {
    let chunk = '';
    for (let i = 0; i < 64; i++) chunk += ALPHABET[Math.floor(next() * ALPHABET.length)];
    out += chunk;
  }
  return out.slice(0, n);
}

export function makeEvents({ mb, seed = 7, base = 1_700_000_000_000 }) {
  const next = rng(seed);
  const target = mb * 1024 * 1024;
  const events = [];
  let bytes = 0;
  for (let i = 0; bytes < target; i++) {
    const kind = i % 100;
    let ev;
    if (kind === 0) {
      ev = { id: `e_${i}`, ts: base + i, type: 'tool_use', agentId: 'main', name: 'Shell', toolCallId: `call_${i}`, input: { command: `grep -rn "${noise(next, 30)}" .` }, title: 'Shell', status: 'done', output: noise(next, 80_000) };
    } else if (kind % 10 === 0) {
      ev = { id: `e_${i}`, ts: base + i, type: 'tool_use', agentId: 'main', name: 'ReadFile', toolCallId: `call_${i}`, input: { path: `/srv/${noise(next, 24)}` }, title: 'ReadFile', status: 'done', output: noise(next, 8_000) };
    } else if (kind % 10 === 5) {
      ev = { id: `e_${i}`, ts: base + i, type: 'thinking', text: noise(next, 700) };
    } else {
      ev = { id: `e_${i}`, ts: base + i, type: 'text', text: noise(next, 500) };
    }
    bytes += JSON.stringify(ev).length + 1;
    events.push(ev);
  }
  return events;
}
