// Stray files the repository once collected: a v0.3.0 copy of the connector
// at the root (made by running the "connect" curl command inside the Hub's own
// folder, which downloads to the current directory), and a folder literally
// named "undefined" (a screenshot script that built its path from a missing
// variable). A stale connector copy is dangerous: run by mistake, it replaces
// the installed connector with an old one that does not know the MCP/hook
// modes Kimi's configuration points at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { REPO } from './fixtures/hub-tree.mjs';

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
const isCheckout = () => {
  try {
    return git('rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
};

test('no stray script or placeholder-named folder is tracked, and the usual ways to make one are ignored', (t) => {
  if (!isCheckout()) return t.skip(`not a git checkout (${REPO}): cannot list tracked files`);
  const tracked = git('ls-files').split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter((f) => !f.includes('/') && /\.(mjs|cjs|js)$/.test(f)), [], 'a script at the repository root (the connector lives in bridge/)');
  assert.deepEqual(tracked.filter((f) => f.split('/').some((seg) => ['undefined', 'null', 'NaN', '[object Object]'].includes(seg))), [], 'a folder named after a missing variable');
  for (const stray of ['agent-hub-bridge.mjs', 'undefined/panes-default.png', 'null/x.png']) {
    let ignored = true;
    try {
      git('check-ignore', '-q', stray);
    } catch {
      ignored = false;
    }
    assert.ok(ignored, `${stray} would be committed by git add -A`);
  }
  // The real connector is still there.
  assert.ok(tracked.includes('bridge/agent-hub-bridge.mjs'));
});
