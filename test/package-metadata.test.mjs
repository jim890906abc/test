// package.json says what the repository really is and really needs:
//   - private: a generic name like "agent-hub" must never be published to npm by
//     an accidental `npm publish`;
//   - repository: where the code lives (npm, GitHub and tooling read it);
//   - engines.node: the lowest Node.js the project runs on, the same number
//     the start scripts, the bridge, the Docker image and the daemon bundle
//     target — one answer everywhere, not ">=20" in one place and 22 in another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const nodeMajor = () => {
  const m = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(pkg.engines?.node || '');
  assert.ok(m, `engines.node is a ">=N" range, got ${JSON.stringify(pkg.engines?.node)}`);
  return Number(m[1]);
};

test('package.json is private, so `npm publish` refuses to run', () => {
  assert.equal(pkg.private, true);
});

test('package.json names the repository', () => {
  assert.deepEqual(pkg.repository, { type: 'git', url: 'https://github.com/jim890906abc/test.git' });
});

test('engines.node is the Node.js version the start scripts, bridge, Docker image and daemon bundle really require', () => {
  const want = nodeMajor();
  assert.equal(want, 22, 'the project needs Node.js 22 (built-in WebSocket, esbuild target node22)');
  // Every place that states a minimum or a version to run on.
  const found = [];
  const sh = read('scripts', 'start-public.sh');
  found.push(['scripts/start-public.sh version check', Number(/"\$NODE_MAJOR" -ge (\d+)/.exec(sh)?.[1])]);
  found.push(['scripts/start-public.sh message', Number(/需要 Node\.js (\d+) 以上/.exec(sh)?.[1])]);
  const ps1 = read('scripts', 'start-public.ps1');
  found.push(['scripts/start-public.ps1 version check', Number(/\$major -lt (\d+)/.exec(ps1)?.[1])]);
  found.push(['scripts/start-public.ps1 message', Number(/需要 Node\.js (\d+) 以上/.exec(ps1)?.[1])]);
  found.push(['bridge/agent-hub-bridge.mjs header', Number(/Requires Node\.js (\d+)\+/.exec(read('bridge', 'agent-hub-bridge.mjs'))?.[1])]);
  found.push(['Dockerfile base image', Number(/^FROM node:(\d+)/m.exec(read('Dockerfile'))?.[1])]);
  found.push(['package.json build:daemon target', Number(/--target=node(\d+)/.exec(pkg.scripts['build:daemon'])?.[1])]);
  for (const [where, got] of found) assert.equal(got, want, `${where} says Node.js ${got}, engines.node says ${want}`);
  // The README states it in prose; check every mention it has.
  for (const m of read('README.md').matchAll(/Node\.js (\d+)\+/g)) assert.equal(Number(m[1]), want, `README says Node.js ${m[1]}+`);
});
