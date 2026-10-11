// GitHub for the agents: each computer signs in once with the GitHub CLI,
// from the hub, by token or in the browser (gh's device flow). A fake `gh`
// stands in for the real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeCopy, current } from '../scripts/sync-bridge-github.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-github-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let log = '';

// gh, as far as Agent Hub uses it. Its sign-in lives in $FAKE_GH_STATE.
const FAKE_GH = `#!/usr/bin/env bash
S="$FAKE_GH_STATE"
echo "$*" >> "$S/calls"
case "$1 $2" in
  "--version "*) echo "gh version 2.70.0 (2026-01-01)" ;;
  "auth token") [ -f "$S/token" ] && cat "$S/token" || { echo "no oauth token found for github.com" >&2; exit 1; } ;;
  "api user") [ -f "$S/token" ] && echo '{"login":"octo","name":"Octo Cat","id":42}' || { echo "HTTP 401: Bad credentials" >&2; exit 1; } ;;
  "auth login")
    if [[ " $* " == *" --with-token "* ]]; then
      read -r t
      [[ "$t" == ghp_good* ]] || { echo "error validating token: HTTP 401: Bad credentials (https://api.github.com/)" >&2; exit 1; }
      echo "$t" > "$S/token"
    else
      [ "$GH_PROMPT_DISABLED" = 1 ] || { echo "would have prompted" >&2; exit 2; }
      echo "! First copy your one-time code: ABCD-1234" >&2
      echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
      while [ ! -f "$S/authorized" ]; do sleep 0.1; done
      echo web > "$S/token"
      echo "✓ Logged in as octo" >&2
    fi ;;
  "auth setup-git") touch "$S/setup-git" ;;
  "auth logout") rm -f "$S/token" ;;
  *) echo "unknown command $*" >&2; exit 1 ;;
esac
`;

const BIN = path.join(TMP, 'bin');
const HOME = path.join(TMP, 'home');
const GH_STATE = path.join(TMP, 'gh');
for (const d of [BIN, HOME, GH_STATE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });
const ENV = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, HOME, USERPROFILE: HOME, FAKE_GH_STATE: GH_STATE, GIT_CONFIG_NOSYSTEM: '1' };
delete ENV.AGENT_HUB_GH;
delete ENV.GH_PROMPT_DISABLED;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...ENV, PORT: String(PORT), AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: path.join(TMP, 'data'), AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => (log += d));
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('已啟動') && resolve()));
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
});

const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error), { status: res.status });
  return j;
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(50);
  }
  throw new Error(`timeout\n${log}`);
};
const gitConfig = (key) => {
  try {
    return fs.readFileSync(path.join(HOME, '.gitconfig'), 'utf8').match(new RegExp(`${key} = (.*)`))?.[1] || null;
  } catch {
    return null;
  }
};

test('the bridge carries the same GitHub code as the hub', () => {
  assert.equal(current(), bridgeCopy(), 'run node scripts/sync-bridge-github.mjs');
});

test('this computer: signed out, a bad token refused, a good one signs in and sets git up', async () => {
  const [c] = await api('GET', '/github');
  assert.equal(c.id, 'local');
  assert.equal(c.hub, true);
  assert.equal(c.gh, '2.70.0');
  assert.equal(c.login, null);
  await assert.rejects(api('POST', '/github/local/login', { token: 'not-a-token' }), (err) => err.status === 400 && /不像 GitHub token/.test(err.message));
  await assert.rejects(api('POST', '/github/local/login', { token: 'ghp_bad0000000000000000000000000' }), (err) => err.status === 400 && /Bad credentials/.test(err.message));
  const s = await api('POST', '/github/local/login', { token: 'ghp_good000000000000000000000000' });
  assert.equal(s.login, 'octo');
  assert.equal(s.account, 'Octo Cat');
  assert.ok(fs.existsSync(path.join(GH_STATE, 'setup-git')));
  // Commits get the account's name and its noreply address.
  assert.equal(gitConfig('name'), 'Octo Cat');
  assert.equal(gitConfig('email'), '42+octo@users.noreply.github.com');
  assert.deepEqual(s.git, { name: 'Octo Cat', email: '42+octo@users.noreply.github.com' });
  // The token went to gh, on stdin; the hub kept nothing.
  assert.equal(fs.readFileSync(path.join(GH_STATE, 'calls'), 'utf8').includes('ghp_good'), false);
  assert.equal(JSON.stringify(fs.readdirSync(path.join(TMP, 'data'), { recursive: true }).map((f) => (fs.statSync(path.join(TMP, 'data', f)).isFile() ? fs.readFileSync(path.join(TMP, 'data', f), 'utf8') : ''))).includes('ghp_good'), false);
  const out = await api('POST', '/github/local/logout');
  assert.equal(out.login, null);
  assert.match(fs.readFileSync(path.join(GH_STATE, 'calls'), 'utf8'), /auth logout --hostname github\.com --user octo/);
});

test('signing in in the browser: a code to enter at GitHub, done once it is authorized', async () => {
  const r = await api('POST', '/github/local/web');
  assert.equal(r.code, 'ABCD-1234');
  assert.equal(r.url, 'https://github.com/login/device');
  // Asked again meanwhile: the same code, not a second sign-in.
  assert.equal((await api('POST', '/github/local/web')).code, 'ABCD-1234');
  const [c] = await api('GET', '/github');
  assert.deepEqual(c.pending, { code: 'ABCD-1234', url: 'https://github.com/login/device' });
  assert.match(fs.readFileSync(path.join(GH_STATE, 'calls'), 'utf8'), /auth login --hostname github\.com --git-protocol https --web --skip-ssh-key --scopes workflow/);
  fs.writeFileSync(path.join(GH_STATE, 'authorized'), '');
  const done = await until(async () => {
    const s = await api('POST', '/github/local/status');
    return s.login && s;
  });
  assert.equal(done.login, 'octo');
  assert.equal(done.pending, undefined);
  await api('POST', '/github/local/logout');
  fs.rmSync(path.join(GH_STATE, 'authorized'));
  // Given up on: cancelled.
  await api('POST', '/github/local/web');
  const cancelled = await api('POST', '/github/local/cancel');
  assert.equal(cancelled.login, null);
  assert.equal(cancelled.pending, undefined);
});

test('a connected computer: through its bridge, which also teaches Kimi the /github skill', async () => {
  const home = path.join(TMP, 'box-home');
  const kimiHome = path.join(home, '.kimi-code');
  const keyFile = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hub.json'), 'utf8')).bridgeKey;
  const bridge = spawn(process.execPath, ['bridge/agent-hub-bridge.mjs', '--hub', `http://127.0.0.1:${PORT}`, '--key', keyFile, '--name', 'box'], {
    cwd: ROOT,
    // No gh on this one.
    env: { ...ENV, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome, AGENT_HUB_GH: path.join(TMP, 'no-such-gh') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await until(async () => (await api('GET', '/machines')).find((x) => x.name === 'box' && x.online));
    const list = await api('GET', '/github');
    // The same computer as the hub: shown once, as the connected one.
    assert.equal(list.some((c) => c.id === 'local'), false);
    const box = list.find((c) => c.name === 'box');
    assert.equal(box.hub, true);
    assert.equal(box.gh, null);
    assert.match(box.install, /gh/);
    await assert.rejects(api('POST', `/github/${box.id}/login`, { token: 'ghp_good000000000000000000000000' }), /還沒有安裝 GitHub CLI/);
    const skill = fs.readFileSync(path.join(kimiHome, 'skills', 'agent-hub-github', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: github\n/);
    assert.match(skill, /gh auth status/);
    assert.ok(fs.existsSync(path.join(kimiHome, 'skills', 'agent-hub-artifact', 'SKILL.md')));
  } finally {
    bridge.kill();
  }
  await until(async () => (await api('GET', '/github')).some((c) => c.id === 'local'));
  const gone = (await api('GET', '/github')).find((c) => c.name === 'box');
  assert.equal(gone.offline, true);
});
