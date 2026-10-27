// Preload for a child process (node --import this-file ...): makes the two
// disk accidents that corrupt small config files reproducible, and records
// what the process did to the disk.
//
//   AH_CRASH_MARK=<text>   the first write whose data contains <text> is cut
//                          in half and the process is then killed with
//                          SIGKILL: a power cut / OOM kill in the middle of a
//                          write. Whatever file or fd the write went to keeps
//                          the first half.
//   AH_OP_LOG=<file>       one line per disk operation that matters, appended
//                          as it happens:
//                            open <name> <flags> <mode in octal>
//                            fsync | fsync-dir
//                            rename <new name>
//                            crash <first bytes of the data that was cut>
//
// Only the `fs` default export is patched, which is what the Hub's own code
// calls (the same way test/store-durable.test.mjs spies on it).
import fs from 'node:fs';
import path from 'node:path';

const mark = process.env.AH_CRASH_MARK || '';
const opLog = process.env.AH_OP_LOG || '';
const real = {
  appendFileSync: fs.appendFileSync,
  writeFileSync: fs.writeFileSync,
  writeSync: fs.writeSync,
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  renameSync: fs.renameSync,
  fstatSync: fs.fstatSync,
};
const note = (line) => {
  if (opLog) real.appendFileSync(opLog, `${line}\n`);
};
const name = (p) => (typeof p === 'string' ? path.basename(p) : String(p));

fs.openSync = (p, flags, mode) => {
  // Program files being loaded are not interesting.
  if (!/\.(m?js|cjs|node)$/.test(String(p))) note(`open ${name(p)} ${flags ?? 'r'} ${mode === undefined ? '-' : mode.toString(8)}`);
  return real.openSync(p, flags, mode);
};
fs.fsyncSync = (fd) => {
  note(real.fstatSync(fd).isDirectory() ? 'fsync-dir' : 'fsync');
  return real.fsyncSync(fd);
};
fs.renameSync = (from, to) => {
  note(`rename ${name(to)}`);
  return real.renameSync(from, to);
};
if (mark) {
  fs.writeFileSync = (target, data, opts) => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    if (text.includes(mark)) {
      const buf = Buffer.from(text);
      const half = buf.subarray(0, Math.floor(buf.length / 2));
      if (typeof target === 'number') real.writeSync(target, half);
      else real.writeFileSync(target, half, opts);
      note(`crash ${JSON.stringify(text.slice(0, 40))}`);
      process.kill(process.pid, 'SIGKILL');
    }
    return real.writeFileSync(target, data, opts);
  };
}
