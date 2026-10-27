// `npm run check` must notice a stale Claude daemon bundle (bridge/claude-daemon.mjs
// is generated; connected computers download it). It rebuilds into a temporary
// folder, so the committed file is never overwritten, and it does not mistake
// the path labels esbuild writes (which depend on where node_modules lives)
// for a code change.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, makeHubTree } from './fixtures/hub-tree.mjs';
import { compare, normalize } from '../scripts/check-bundle.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-check-bundle-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const run = (tree) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['scripts/check-bundle.mjs'], { cwd: tree, env, encoding: 'utf8', timeout: 120_000 });
};

test('path labels are not code, but any code difference is', () => {
  const a = '// ../../../elsewhere/node_modules/@anthropic-ai/sdk/index.mjs\nvar x = 1;\n';
  const b = '// node_modules/@anthropic-ai/sdk/index.mjs\nvar x = 1;\n';
  assert.equal(normalize(a), normalize(b));
  assert.deepEqual(compare(a, b), { same: true });
  assert.equal(compare(a, b.replace('x = 1', 'x = 2')).same, false);
  assert.equal(compare(a, b.replace('var x', 'var y')).line, 2);
  assert.equal(compare(a, `${b}var extra;\n`).same, false, 'a longer file is different');
  // The key of a dependency's wrapper carries the same label.
  const w = (p) => `var init_tslib = __esm({\n  "${p}"() {\n    x();\n  }\n});\n`;
  assert.deepEqual(compare(w('../../../../../../elsewhere/node_modules/@anthropic-ai/sdk/internal/tslib.mjs'), w('node_modules/@anthropic-ai/sdk/internal/tslib.mjs')), { same: true });
  assert.equal(compare(w('node_modules/a/b.mjs'), w('node_modules/a/c.mjs')).same, false, 'a different dependency file is a difference');
  // A line that merely looks like a label inside the code is still compared.
  assert.equal(compare('const p = "node_modules/a";\n', 'const p = "node_modules/b";\n').same, false);
});

test('the committed bundle is what the current code builds', () => {
  const before = fs.statSync(path.join(REPO, 'bridge', 'claude-daemon.mjs')).mtimeMs;
  const r = run(REPO);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /claude-daemon\.mjs is current/);
  assert.equal(fs.statSync(path.join(REPO, 'bridge', 'claude-daemon.mjs')).mtimeMs, before, 'the committed file is not rewritten');
});

test('a change to code the daemon runs makes the check fail, naming the fix, and still leaves the file alone', () => {
  const tree = makeHubTree(path.join(TMP, 'tree'));
  const committed = fs.readFileSync(path.join(tree, 'bridge', 'claude-daemon.mjs'), 'utf8');
  assert.equal(run(tree).status, 0, 'the copy starts out current (also with node_modules reached through a symlink)');
  // server/adapters/claude.js is in the daemon's import graph.
  const file = path.join(tree, 'server', 'adapters', 'claude.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("const HANDOFF_MAX", "const HANDOFF_MAX_CHANGED_FOR_TEST"));
  const r = run(tree);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /claude-daemon\.mjs is stale/);
  assert.match(r.stderr, /npm run build:daemon/);
  assert.equal(fs.readFileSync(path.join(tree, 'bridge', 'claude-daemon.mjs'), 'utf8'), committed, 'the check never overwrites the bundle');
  // A file outside the daemon's graph does not matter.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("HANDOFF_MAX_CHANGED_FOR_TEST", 'HANDOFF_MAX'));
  fs.appendFileSync(path.join(tree, 'server', 'runner.js'), '\n// not part of the bundle\n');
  assert.equal(run(tree).status, 0);
});

test('npm run check runs it, and it covers scripts and the test fixtures', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /scripts\/\*\.mjs/);
  assert.match(pkg.scripts.check, /test\/fixtures\/\*\.mjs/);
  assert.match(pkg.scripts.check, /check:bundle/);
  assert.equal(pkg.scripts['check:bundle'], 'node scripts/check-bundle.mjs');
});
