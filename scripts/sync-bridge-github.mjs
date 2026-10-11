// Copies server/github.js into the bridge (bridge/agent-hub-bridge.mjs is one
// file that other computers download, so it carries its own copy), between
// its "github:begin" and "github:end" lines. Run after changing github.js:
//   node scripts/sync-bridge-github.mjs        (--check: only tell if stale)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bridge', 'agent-hub-bridge.mjs');

export function bridgeCopy() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'github.js'), 'utf8');
  const body = src
    .split('\n')
    .filter((l) => !/^import /.test(l))
    .join('\n')
    .replace(/^(\/\/.*\n)+\n?/, '')
    .replace(/^export /gm, '')
    .trim();
  const names = [...body.matchAll(/^(?:async )?function (\w+)/gm)].map((m) => m[1]).filter((n) => /^(status|loginToken|loginWeb|cancelWeb|logout)$/.test(n));
  return [
    '// github:begin — generated from server/github.js by scripts/sync-bridge-github.mjs',
    'const github = (() => {',
    ...body.split('\n').map((l) => (l ? `  ${l}` : l)),
    `  return { ${names.join(', ')} };`,
    '})();',
    '// github:end',
  ].join('\n');
}

export function current() {
  return fs.readFileSync(BRIDGE, 'utf8').match(/\/\/ github:begin[\s\S]*?\/\/ github:end/)?.[0] || null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const want = bridgeCopy();
  const have = current();
  if (process.argv.includes('--check')) {
    if (have !== want) {
      console.error('bridge/agent-hub-bridge.mjs has a stale copy of server/github.js: run node scripts/sync-bridge-github.mjs');
      process.exit(1);
    }
  } else {
    if (!have) throw new Error('no github:begin … github:end block in the bridge');
    fs.writeFileSync(BRIDGE, fs.readFileSync(BRIDGE, 'utf8').replace(have, () => want));
  }
}
