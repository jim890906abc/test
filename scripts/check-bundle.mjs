#!/usr/bin/env node
// Is bridge/claude-daemon.mjs (the one file connected computers download to
// run Claude) what `npm run build:daemon` makes from the code as it is now?
// It is rebuilt into a temporary folder and compared; the committed file is
// never touched. A stale bundle means a connected computer runs old Claude
// code: nothing else would tell you.
//
//   node scripts/check-bundle.mjs        exit 0 when current, 1 when stale or the build cannot run
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'bridge', 'claude-daemon.mjs');

// esbuild labels each bundled dependency with its path relative to where it
// was built — in a comment above it and as the key of its wrapper
// (`"node_modules/x"() {`). A checkout whose node_modules is a symlink (a git
// worktree, a shared install) writes `../../../elsewhere/node_modules/x`,
// another writes `node_modules/x`. That label is not code.
export const normalize = (text) =>
  String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*\/\/ )(?:[^\n]*?\/)?node_modules\//gm, '$1node_modules/')
    .replace(/^(\s*)"(?:[^"\n]*?\/)?node_modules\/([^"\n]*)"\(/gm, '$1"node_modules/$2"(');

// { same: true } or { same: false, line, built, committed } at the first difference.
export function compare(built, committed) {
  const a = normalize(built).split('\n');
  const b = normalize(committed).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { same: false, line: i + 1, built: a[i] ?? '(end of file)', committed: b[i] ?? '(end of file)' };
  }
  return { same: true };
}

// Builds with the exact command of `npm run build:daemon`, the output moved to
// `outfile` (esbuild takes the last --outfile).
export function rebuild(outfile) {
  const r = spawnSync('npm', ['run', 'build:daemon', '--silent', '--', `--outfile=${outfile}`], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0 || !fs.existsSync(outfile)) {
    throw new Error(`could not rebuild the bundle (npm run build:daemon exited ${r.status}). Is esbuild installed (npm install)?\n${r.stderr || r.stdout || r.error || ''}`.trim());
  }
  return fs.readFileSync(outfile, 'utf8');
}

export function check() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-bundle-'));
  try {
    const built = rebuild(path.join(dir, 'claude-daemon.mjs'));
    return compare(built, fs.readFileSync(BUNDLE, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = check();
    if (r.same) console.log('bridge/claude-daemon.mjs is current');
    else {
      console.error(`bridge/claude-daemon.mjs is stale: it differs from what the code builds (first difference at line ${r.line}).`);
      console.error(`  built:     ${r.built.slice(0, 160)}`);
      console.error(`  committed: ${r.committed.slice(0, 160)}`);
      console.error('Run `npm run build:daemon` and commit the result.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
