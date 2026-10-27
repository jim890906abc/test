// Where the real Kimi CLI is, for the end-to-end tests that need it — one
// answer for every test file. KIMI_BIN names it; otherwise it is the first
// executable `kimi` on PATH.
//
// A test file that cannot find it must say so out loud: a skipped test only
// shows up as a number ("skipped 5"), and these skipped tests are the spec's
// core acceptance (a real Kimi with real subagents). So this prints one line
// per file either way, names the reason, and REQUIRE_KIMI=1 turns "not found"
// into a failure of the whole file.
import fs from 'node:fs';
import path from 'node:path';

const isExecutable = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// { bin, source } or { bin: null, why }.
export function findKimi(env = process.env) {
  if (env.KIMI_BIN) {
    return isExecutable(env.KIMI_BIN)
      ? { bin: env.KIMI_BIN, source: 'KIMI_BIN' }
      : { bin: null, why: `KIMI_BIN is set to ${env.KIMI_BIN}, which is not an executable file` };
  }
  const names = process.platform === 'win32' ? ['kimi.exe', 'kimi.cmd', 'kimi.bat', 'kimi'] : ['kimi'];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) if (isExecutable(path.join(dir, name))) return { bin: path.join(dir, name), source: 'PATH' };
  }
  return { bin: null, why: 'there is no executable `kimi` on PATH and KIMI_BIN is not set' };
}

// What a test file uses: `const { KIMI, SKIP } = kimiGate('e2e-foo')`.
export function kimiGate(label, env = process.env) {
  const found = findKimi(env);
  if (found.bin) {
    console.error(`[${label}] real Kimi CLI: ${found.bin} (from ${found.source})`);
    return { KIMI: found.bin, SKIP: false };
  }
  const message = `[${label}] the real-Kimi tests need the Kimi CLI, but ${found.why}`;
  if (env.REQUIRE_KIMI) throw new Error(`${message} (REQUIRE_KIMI is set)`);
  console.error(`${message}. THEY ARE SKIPPED — they are the spec's core acceptance. Set KIMI_BIN=/path/to/kimi, or REQUIRE_KIMI=1 to make this a failure.`);
  return { KIMI: null, SKIP: `kimi CLI not found: ${found.why}` };
}
