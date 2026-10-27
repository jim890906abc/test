// The Docker image must not run as root, must keep its state in a private
// volume, must not go onto a non-loopback address without a real login
// password (or with AGENT_HUB_TOKEN=none), and must not take local files into
// the image (COPY . . burns them in): Dockerfile, scripts/docker-entrypoint.sh
// and .dockerignore.
//
// The entrypoint runs for real here (with a stand-in node). The .dockerignore
// rules are evaluated the way Docker evaluates them (see `ignored`), and when
// AGENT_HUB_TEST_DOCKER=1 and a Docker daemon is available the image is also
// really built from a folder full of decoy files and inspected — that one
// downloads the base image and the dependencies, so it is off by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const IGNORE = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const ENTRYPOINT = path.join(ROOT, 'scripts', 'docker-entrypoint.sh');
const instructions = DOCKERFILE.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
// Continuation lines joined: "RUN a \\\n && b" is one instruction.
const joined = DOCKERFILE.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const lastOf = (word) => joined.filter((l) => l.toUpperCase().startsWith(`${word} `)).pop();

// ------------------------------------------------------------------ Dockerfile
test('the image runs as an unprivileged user, never as root', () => {
  const user = lastOf('USER');
  assert.ok(user, 'there is a USER instruction');
  assert.doesNotMatch(user, /^USER\s+(root|0)(:|\s|$)/i, user);
  assert.match(user, /^USER\s+agenthub$/);
  // It comes before the process starts and after the files are installed.
  const at = (re) => joined.findIndex((l) => re.test(l));
  assert.ok(at(/^USER /) > at(/^COPY \. \./), 'USER after COPY . .');
  assert.ok(at(/^USER /) < at(/^ENTRYPOINT /), 'USER before the entrypoint');
  assert.match(joined.find((l) => /^RUN .*adduser/.test(l)), /-u 10001\b/, 'a fixed uid, so a bind mount can be chown-ed in advance');
  assert.equal(joined.filter((l) => /^USER /i.test(l)).length, 1, 'no switching back to root later');
});

test('all state lives in /data: owned by that user, mode 0700, a volume, and where the hub is told to look', () => {
  const run = joined.filter((l) => l.startsWith('RUN ')).join(' ');
  assert.match(run, /mkdir -p \/data/);
  assert.match(run, /chown agenthub:agenthub \/data/);
  assert.match(run, /chmod 0?700 \/data/);
  assert.ok(joined.some((l) => /^VOLUME \["\/data"\]$/.test(l)));
  assert.ok(!joined.some((l) => /^VOLUME .*\/app/.test(l)), 'not the old /app/data');
  const env = joined.filter((l) => l.startsWith('ENV ')).join(' ');
  assert.match(env, /AGENT_HUB_DATA=\/data\b/);
  assert.match(env, /AGENT_HUB_WORKSPACES=\/data\/workspaces\b/);
  // The non-root user's home is writable (Git, Node and the bridge's tools write there).
  assert.match(env, /HOME=\/home\/agenthub\b/);
  assert.match(run, /adduser .*-h \/home\/agenthub/);
});

test('listening on 0.0.0.0 is only possible through the entrypoint that demands a real password', () => {
  const env = joined.filter((l) => l.startsWith('ENV ')).join(' ');
  const host = /HOST=(\S+)/.exec(env)?.[1];
  const entry = lastOf('ENTRYPOINT');
  assert.ok(entry, 'an ENTRYPOINT');
  assert.match(entry, /scripts\/docker-entrypoint\.sh/);
  assert.ok(!joined.some((l) => /^CMD /i.test(l)), 'no CMD that would bypass it');
  if (host !== '127.0.0.1') assert.match(entry, /docker-entrypoint/, `HOST=${host} is only safe behind the entrypoint`);
  assert.ok(!/AGENT_HUB_TOKEN\s*=\s*none/i.test(DOCKERFILE.replace(/^\s*#.*$/gm, '')), 'the image never sets the login off');
  assert.ok(fs.existsSync(ENTRYPOINT));
  assert.match(DOCKERFILE, /plain HTTP/, 'says that the image speaks plain HTTP and needs TLS in front');
  assert.match(DOCKERFILE, /AGENT_HUB_TOKEN=none/, 'explains the none refusal');
});

test('FROM, dependencies and sources: production dependencies only, installed before the sources are copied', () => {
  const from = joined.find((l) => l.startsWith('FROM '));
  assert.match(from, /^FROM node:22\b/);
  const ci = joined.findIndex((l) => /^RUN npm ci --omit=dev/.test(l));
  const copyAll = joined.findIndex((l) => /^COPY \. \./.test(l));
  assert.ok(ci >= 0 && copyAll > ci, 'npm ci --omit=dev runs before COPY . .');
  assert.ok(instructions.length > 5);
});

// ------------------------------------------------------------------ entrypoint
const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-entrypoint-'));
fs.writeFileSync(path.join(stubs, 'node'), '#!/bin/sh\nprintf "node %s\\nHOST=%s\\nTOKEN=%s\\n" "$*" "${HOST-}" "${AGENT_HUB_TOKEN-}" > "$OUT"\n', { mode: 0o755 });
const SYS_PATH = '/usr/bin:/bin';
function entry(env) {
  const out = path.join(stubs, `out-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync('sh', [ENTRYPOINT, ...(env.__args || [])], { env: { PATH: `${stubs}:${SYS_PATH}`, OUT: out, ...Object.fromEntries(Object.entries(env).filter(([k]) => k !== '__args')) }, encoding: 'utf8', timeout: 20000 });
  const ran = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  return { status: r.status, stderr: r.stderr, ran };
}

test('entrypoint: a non-loopback HOST without AGENT_HUB_TOKEN is refused with a message that says how to set one', () => {
  for (const host of ['0.0.0.0', '192.0.2.5', '::']) {
    const r = entry({ HOST: host });
    assert.equal(r.status, 1, `${host}: ${r.stderr}`);
    assert.equal(r.ran, null, 'the hub was not started');
    assert.match(r.stderr, /AGENT_HUB_TOKEN/);
    assert.match(r.stderr, /openssl rand -hex 16/);
  }
  const blank = entry({ HOST: '0.0.0.0', AGENT_HUB_TOKEN: '   ' });
  assert.equal(blank.status, 1, 'a blank password is no password');
  assert.equal(blank.ran, null);
});

test('entrypoint: AGENT_HUB_TOKEN=none (any case) is refused on a non-loopback HOST and never reaches the hub', () => {
  for (const token of ['none', 'NONE', 'None', ' none ']) {
    const r = entry({ HOST: '0.0.0.0', AGENT_HUB_TOKEN: token });
    assert.equal(r.status, 1, `${JSON.stringify(token)}: ${r.stderr}`);
    assert.equal(r.ran, null);
    assert.match(r.stderr, /none/);
    assert.match(r.stderr, /關掉登入/);
  }
});

test('entrypoint: a real password starts the hub with exactly node server/index.js, replacing the shell', () => {
  const r = entry({ HOST: '0.0.0.0', AGENT_HUB_TOKEN: 'a1b2c3d4e5f60718a1b2c3d4e5f60718' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.ran, /^node server\/index\.js\nHOST=0\.0\.0\.0\nTOKEN=a1b2c3d4e5f60718a1b2c3d4e5f60718\n$/);
  // A password that only starts with "none" is a password.
  assert.equal(entry({ HOST: '0.0.0.0', AGENT_HUB_TOKEN: 'none-of-your-business' }).status, 0);
});

test('entrypoint: on a loopback HOST (reachable only from inside) the hub makes its own password; none stays the local-use switch', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const r = entry({ HOST: host });
    assert.equal(r.status, 0, `${host}: ${r.stderr}`);
    assert.match(r.ran, /^node server\/index\.js\n/);
  }
  assert.equal(entry({ HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'none' }).status, 0);
  // No HOST at all is the hub's own default (127.0.0.1).
  assert.equal(entry({}).status, 0);
});

test('entrypoint: is plain POSIX sh (Alpine has no bash)', () => {
  const text = fs.readFileSync(ENTRYPOINT, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /\[\[|\bfunction\b|\$\{[^}]*,,|<\(/);
  const dash = spawnSync('sh', ['-n', ENTRYPOINT], { encoding: 'utf8' });
  assert.equal(dash.status, 0, dash.stderr);
});

// ------------------------------------------------------------------ .dockerignore
// Docker's rules: patterns are relative to the context root, `*` stays inside a
// folder, `**/` is any number of folders, a pattern matches a path when it
// matches the path or one of its parent folders, and the last matching
// pattern wins (a leading `!` puts it back).
function patternToRegExp(pattern) {
  const p = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+()|^$\\{}'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
function ignored(file, rules) {
  let excluded = false;
  const parts = file.split('/');
  for (const rule of rules) {
    const negated = rule.startsWith('!');
    const re = patternToRegExp(negated ? rule.slice(1) : rule);
    let hit = false;
    for (let i = 1; i <= parts.length && !hit; i++) hit = re.test(parts.slice(0, i).join('/'));
    if (hit) excluded = !negated;
  }
  return excluded;
}
const RULES = IGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const KEPT = [
  'package.json', 'package-lock.json', 'server/index.js', 'server/adapters/claude.js', 'bridge/agent-hub-bridge.mjs', 'bridge/claude-daemon.mjs',
  'scripts/docker-entrypoint.sh', 'scripts/start-public.sh', 'public/index.html', 'public/css/app.css', 'public/css/oatmeal.css', 'public/js/app.js', 'public/js/markdown.js',
  'test/fixtures/synth-conversation.mjs', 'README.md', 'docs/artifact.png', '.env.example',
];
const LEFT_OUT = [
  'data/hub.json', 'data/sessions/s_1.json', 'workspaces/2026-10-27-x/file', '.git/config', '.git/HEAD', 'node_modules/express/index.js', 'bin/cloudflared',
  '.env', '.env.local', 'server/.env', 'deploy/secrets.pem', 'id_rsa.key', 'x/y/z/debug.log', 'hub.log', 'npm-debug.log', 'notes.tmp', 'server/index.js.bak', '.DS_Store', 'public/.DS_Store',
  // Whatever gets dropped into public/ (the Hub serves only the product page from it).
  'public/report.html', 'public/report-2026.docx', 'public/walkthrough.html', 'public/shots/01.png', 'public/shots/deep/02.png', 'public/css/notes.md', 'public/css/leak.html', 'public/js/app.js.map', 'public/js/notes.txt', 'public/images/logo.png',
  'agent-hub-bridge.mjs', 'undefined/panes.png', 'null/x', 'test/fixtures/node_modules/x/index.js', 'test/trace.log',
];
test('.dockerignore keeps the product and leaves out local state, secrets, logs and anything but the product page in public/', () => {
  for (const f of KEPT) assert.equal(ignored(f, RULES), false, `${f} belongs in the image`);
  for (const f of LEFT_OUT) assert.equal(ignored(f, RULES), true, `${f} must not go into the image`);
});

test('the .dockerignore evaluator itself: last match wins, `*` stays in a folder, `**/` goes deep, a parent match covers the children', () => {
  assert.equal(ignored('a/b.log', ['*.log']), false, '*.log is root-level only');
  assert.equal(ignored('a/b.log', ['**/*.log']), true);
  assert.equal(ignored('b.log', ['**/*.log']), true, '**/ also matches zero folders');
  assert.equal(ignored('d/x/y', ['d']), true);
  assert.equal(ignored('d/keep.txt', ['d', '!d/keep.txt']), false);
  assert.equal(ignored('d/keep.txt', ['!d/keep.txt', 'd']), true, 'the later rule wins');
});

// ------------------------------------------------------------------ a real build (opt in)
const dockerOk = process.env.AGENT_HUB_TEST_DOCKER === '1' && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 }).status === 0;
test('a real docker build from a folder full of decoys leaves them out, runs as non-root, and refuses to start without a password', { skip: dockerOk ? false : 'set AGENT_HUB_TEST_DOCKER=1 with a running Docker to build the image for real (downloads the base image and the dependencies)', timeout: 540_000 }, async () => {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-docker-ctx-'));
  const tag = `agent-hub-test-${process.pid}`;
  const name = `agent-hub-test-${process.pid}`;
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 500_000, ...opts });
  try {
    // The tracked files of this checkout plus decoys of everything that must stay out.
    const files = sh('git', ['ls-files', '-z'], { cwd: ROOT }).stdout.split('\0').filter(Boolean);
    for (const f of [...files, '.dockerignore']) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      fs.mkdirSync(path.dirname(path.join(ctx, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(ctx, f));
    }
    const decoys = LEFT_OUT.filter((f) => !f.startsWith('node_modules/') && !f.startsWith('.git/') && f !== 'test/fixtures/node_modules/x/index.js');
    for (const f of decoys) {
      fs.mkdirSync(path.dirname(path.join(ctx, f)), { recursive: true });
      fs.writeFileSync(path.join(ctx, f), 'DECOY');
    }
    const build = sh('docker', ['build', '-q', '-t', tag, ctx]);
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = (...a) => sh('docker', ['run', '--rm', '--entrypoint', '', tag, ...a]);
    const listing = run('sh', '-c', 'cd /app && find . -path ./node_modules -prune -o -type f -print').stdout.split('\n').map((l) => l.replace(/^\.\//, '')).filter(Boolean);
    for (const f of decoys) assert.ok(!listing.includes(f), `${f} is in the image`);
    for (const f of ['server/index.js', 'public/index.html', 'scripts/docker-entrypoint.sh']) assert.ok(listing.includes(f), `${f} is missing from the image`);
    assert.equal(run('id', '-u').stdout.trim(), '10001', 'runs as the unprivileged user');
    assert.match(run('stat', '-c', '%a %U', '/data').stdout, /^700 agenthub/);
    const noPassword = sh('docker', ['run', '--rm', tag]);
    assert.equal(noPassword.status, 1);
    assert.match(noPassword.stderr, /AGENT_HUB_TOKEN/);
    const none = sh('docker', ['run', '--rm', '-e', 'AGENT_HUB_TOKEN=none', tag]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /關掉登入/);

    // With a password it really runs: as the unprivileged user, its state private, the login enforced.
    const token = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
    const up = sh('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::8787', '-e', `AGENT_HUB_TOKEN=${token}`, tag]);
    assert.equal(up.status, 0, up.stderr);
    const hostPort = /:(\d+)\s*$/m.exec(sh('docker', ['port', name, '8787/tcp']).stdout)?.[1];
    assert.ok(hostPort, 'a published port');
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${hostPort}/`);
        if (r.ok) page = r;
      } catch {}
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(page, `the hub answered; logs:\n${sh('docker', ['logs', name]).stdout}`);
    assert.equal((await fetch(`http://127.0.0.1:${hostPort}/api/hub`)).status, 401, 'no login, no data');
    assert.equal((await fetch(`http://127.0.0.1:${hostPort}/api/hub`, { headers: { 'x-hub-token': token } })).status, 200);
    const ps = sh('docker', ['exec', name, 'sh', '-c', 'id -u; ls -ln /data | tail -n +2; ps -o user,args | grep "[s]erver/index.js"']).stdout;
    assert.match(ps, /^10001\n/, `the hub does not run as root: ${ps}`);
    assert.match(ps, /^-rw------- +1 10001 +10001 .* hub\.json$/m, `state is private and owned by the hub user: ${ps}`);
    assert.match(sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', name]).stdout, /starting|healthy/);
  } finally {
    sh('docker', ['rm', '-f', name]);
    sh('docker', ['rmi', '-f', tag]);
    fs.rmSync(ctx, { recursive: true, force: true });
  }
});
