// The real-Kimi end-to-end files must find the Kimi CLI the same way, and say
// so out loud when they cannot. (They used to disagree: one read KIMI_BIN only
// and silently skipped the spec's core 3×3 acceptance on a machine where the
// other found `kimi` on PATH and ran.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findKimi, kimiGate } from './fixtures/kimi-bin.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-kimi-bin-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const exe = (file) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 }), file);

test('KIMI_BIN wins; otherwise the first executable kimi on PATH; otherwise nothing, with a reason', () => {
  const a = exe(path.join(TMP, 'a', 'kimi'));
  const b = exe(path.join(TMP, 'b', 'kimi'));
  assert.deepEqual(findKimi({ KIMI_BIN: b, PATH: path.dirname(a) }), { bin: b, source: 'KIMI_BIN' });
  assert.deepEqual(findKimi({ PATH: [path.join(TMP, 'none'), path.dirname(a), path.dirname(b)].join(path.delimiter) }), { bin: a, source: 'PATH' });
  const missing = findKimi({ KIMI_BIN: path.join(TMP, 'gone', 'kimi'), PATH: path.dirname(a) });
  assert.equal(missing.bin, null, 'a wrong KIMI_BIN is an error, not a quiet fallback to PATH');
  assert.match(missing.why, /KIMI_BIN is set to .*gone.*not an executable/);
  assert.match(findKimi({ PATH: path.join(TMP, 'none') }).why, /no executable `kimi` on PATH and KIMI_BIN is not set/);
  // A file called kimi that cannot run is not Kimi.
  fs.mkdirSync(path.join(TMP, 'c'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'c', 'kimi'), 'text', { mode: 0o644 });
  assert.equal(findKimi({ PATH: path.join(TMP, 'c') }).bin, null);
  assert.equal(findKimi({ PATH: path.join(TMP, 'b') }).bin, b);
  assert.equal(findKimi({ PATH: '' }).bin, null);
});

test('the gate skips with the reason in the skip text, or fails when Kimi is required', () => {
  const none = kimiGate('t', { PATH: path.join(TMP, 'none') });
  assert.equal(none.KIMI, null);
  assert.match(none.SKIP, /kimi CLI not found: there is no executable `kimi` on PATH/);
  assert.throws(() => kimiGate('t', { PATH: path.join(TMP, 'none'), REQUIRE_KIMI: '1' }), /REQUIRE_KIMI is set/);
  const found = kimiGate('t', { PATH: path.join(TMP, 'a') });
  assert.deepEqual([found.SKIP, found.KIMI], [false, path.join(TMP, 'a', 'kimi')]);
});

// The real files, run for real with no Kimi anywhere: both say so on stderr,
// both skip every test (and start nothing), and REQUIRE_KIMI=1 fails them.
const noKimiEnv = (extra = {}) => {
  const env = { ...process.env, PATH: path.join(TMP, 'none'), KIMI_BIN: '', ...extra };
  delete env.NODE_TEST_CONTEXT; // this process is a test; the child must run as its own
  return env;
};
for (const file of ['e2e-kimi-bridge', 'e2e-unified-broker']) {
  test(`${file} says out loud why it is skipped, and fails under REQUIRE_KIMI=1`, () => {
    const run = (env) => spawnSync(process.execPath, ['--test', `test/${file}.test.mjs`], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    const quiet = run(noKimiEnv());
    const out = quiet.stdout + quiet.stderr;
    assert.equal(quiet.status, 0, out);
    assert.match(out, new RegExp(`\\[${file}\\] the real-Kimi tests need the Kimi CLI, but there is no executable \`kimi\` on PATH`), out);
    assert.match(out, /THEY ARE SKIPPED/);
    assert.match(out, /ℹ pass 0/);
    assert.match(out, /ℹ fail 0/);
    assert.doesNotMatch(out, /ℹ skipped 0/, 'the tests are skipped, not absent');
    const strict = run(noKimiEnv({ REQUIRE_KIMI: '1' }));
    assert.notEqual(strict.status, 0, 'REQUIRE_KIMI=1 turns a missing Kimi into a failure');
    assert.match(strict.stdout + strict.stderr, /REQUIRE_KIMI is set/);
  });
}

// With a Kimi on PATH and KIMI_BIN unset, both files must take that Kimi (the
// old unified file ignored PATH and skipped). Their lookup is the one above;
// a file that starts a real Kimi must not carry a lookup of its own.
test('every test file that starts a real Kimi gets it from the shared lookup', () => {
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs') && f !== 'kimi-bin.test.mjs');
  const real = files.filter((f) => /\['web', '--no-open'/.test(fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')));
  assert.ok(real.includes('e2e-kimi-bridge.test.mjs') && real.includes('e2e-unified-broker.test.mjs'), real.join());
  for (const f of real) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    assert.match(src, /import \{ kimiGate \} from '\.\/fixtures\/kimi-bin\.mjs'/, `${f} does not use the shared lookup`);
    assert.doesNotMatch(src, /process\.env\.KIMI_BIN/, `${f} reads KIMI_BIN itself`);
    assert.doesNotMatch(src, /function which\(/, `${f} has a lookup of its own`);
  }
});
