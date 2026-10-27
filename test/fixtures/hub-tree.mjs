// A throw-away copy of the Hub's own tree (server/, bridge/, public/, scripts/) in a
// folder the test chooses — including one whose path has a dot in it, the way
// a checkout under ~/.claude/… or ~/.local/… does — so a test can add files
// to public/ or run the Hub from an awkward path without touching the repo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function makeHubTree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['server', 'bridge', 'public', 'scripts']) fs.cpSync(path.join(REPO, name), path.join(dir, name), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

// Starts `node server/index.js` in `tree` and resolves once it says it is up.
export async function startHub(tree, { port, data, env = {} }) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: data, AGENT_HUB_WORKSPACES: path.join(data, '..', 'ws'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Hub did not start in ${tree}\n${log}`)), 15000);
    proc.once('exit', (code) => (clearTimeout(t), reject(new Error(`Hub exited ${code} in ${tree}\n${log}`))));
    proc.stdout.on('data', (d) => d.toString().includes('已啟動') && (clearTimeout(t), resolve()));
  });
  return { proc, base: `http://127.0.0.1:${port}`, stop: () => proc.kill('SIGTERM') };
}
