// scripts/start-public.sh downloads cloudflared only as a fixed release and
// only runs it once its SHA-256 matches the one built into the script. A
// download that does not match is deleted and never executed. The script runs
// for real here (real curl, tar and sha256 tools) against a loopback HTTP
// server standing in for github.com; node, kimi and uname are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAKE_CLOUDFLARED, SH, PS1, guardLeaks, realPath, removeProject, setupProject, runScript, startAssetServer, waitUntil } from './start-public-fixtures.mjs';

// Every script group this file starts is ended with the file, and no stand-in may outlive it.
guardLeaks();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The hashes of cloudflared 2026.10.0, taken on 2026-10-27 from the "digest"
// GitHub shows for each release asset, and checked two other ways: against
// the checksum list in Cloudflare's release notes (for the macOS .tgz files
// that list holds the hash of the binary inside the archive), and by
// downloading each file and running sha256sum on it.
const VERSION = '2026.10.0';
const PINS = {
  'cloudflared-linux-amd64': 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db',
  'cloudflared-linux-arm64': 'e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08',
  'cloudflared-linux-arm': '1dbe8e4ec17e74bb7f49cf91db6a4903bd0f9fe41984556c7503e40b765fd099',
  'cloudflared-darwin-amd64.tgz': '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f',
  'cloudflared-darwin-arm64.tgz': 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70',
  'cloudflared-windows-amd64.exe': '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c',
};
const shText = fs.readFileSync(SH, 'utf8');
const ps1Text = fs.readFileSync(PS1, 'utf8');

test('the built-in table pins one release and the hash of every platform file, in both scripts', () => {
  assert.equal(/^CF_VERSION="([^"]+)"/m.exec(shText)?.[1], VERSION, 'start-public.sh pins the release');
  assert.match(ps1Text, new RegExp(`\\$CfVersion = '${VERSION.replace(/\./g, '\\.')}'`), 'start-public.ps1 pins the same release');
  const table = Object.fromEntries([...shText.matchAll(/^\s+(cloudflared-[a-z0-9.-]+)\) echo ([0-9a-f]{64}) ;;$/gm)].map((m) => [m[1], m[2]]));
  for (const asset of ['cloudflared-linux-amd64', 'cloudflared-linux-arm64', 'cloudflared-linux-arm', 'cloudflared-darwin-amd64.tgz', 'cloudflared-darwin-arm64.tgz']) {
    assert.equal(table[asset], PINS[asset], `start-public.sh: ${asset}`);
  }
  assert.deepEqual(Object.keys(table).sort(), Object.keys(PINS).filter((n) => !n.includes('windows')).sort(), 'no other platform sneaks in unchecked');
  assert.match(ps1Text, new RegExp(`'${PINS['cloudflared-windows-amd64.exe']}'`), 'start-public.ps1: cloudflared-windows-amd64.exe');
  for (const text of [shText, ps1Text]) {
    assert.doesNotMatch(text, /releases\/latest/, 'no download follows "latest"');
    assert.match(text, /github\.com\/cloudflare\/cloudflared\/releases\/download/, 'downloads come from the Cloudflare release page');
  }
});

// A stand-in "cloudflared" the script is allowed to run once it checks out.
const GOOD = Buffer.from(FAKE_CLOUDFLARED);
const OVERRIDE = { AGENT_HUB_CLOUDFLARED_VERSION: 'test-1.2.3', AGENT_HUB_CLOUDFLARED_SHA256: sha256(GOOD) };

async function scenario(files, { env = {}, project = {}, uname = ['Linux', 'x86_64'], autostart = true } = {}) {
  const proj = setupProject(project);
  const server = await startAssetServer(files);
  const runs = [];
  const start = (more = {}) => {
    const r = runScript(proj, { env: { AGENT_HUB_CLOUDFLARED_BASE_URL: server.base, FAKE_UNAME_S: uname[0], FAKE_UNAME_M: uname[1], ...env, ...more } });
    runs.push(r);
    return r;
  };
  // The next start finds an empty gate (the stand-in tunnel counts its attempts there).
  const resetGate = () => {
    for (const f of fs.readdirSync(proj.gate)) fs.rmSync(path.join(proj.gate, f), { recursive: true, force: true });
  };
  return {
    proj,
    server,
    start,
    run: autostart ? start() : null,
    resetGate,
    gate: proj.gate,
    executed: () => fs.existsSync(path.join(proj.gate, 'cloudflared.executed')),
    bin: (...p) => path.join(proj.tmp, 'bin', ...p),
    async done() {
      for (const r of runs) await r.stop();
      await server.close();
      removeProject(proj);
    },
  };
}

test('a download whose SHA-256 does not match is deleted, never run, and the script stops', async () => {
  const evil = Buffer.from('#!/bin/sh\ntouch "$GATE_DIR/cloudflared.executed"\n');
  const s = await scenario({ [`/releases/download/${VERSION}/cloudflared-linux-amd64`]: evil });
  try {
    const { code } = await s.run.finished();
    assert.equal(code, 1, s.run.text);
    assert.match(s.run.text, /SHA-256 不符/);
    assert.match(s.run.text, new RegExp(PINS['cloudflared-linux-amd64']), 'the expected hash is shown');
    assert.match(s.run.text, new RegExp(sha256(evil)), 'and the hash that was actually received');
    assert.equal(fs.existsSync(s.bin('cloudflared')), false, 'no program is left in bin/');
    assert.deepEqual(fs.readdirSync(s.bin()), [], 'nor any half-finished download');
    assert.equal(s.executed(), false, 'the downloaded file was never executed');
    assert.doesNotMatch(s.run.text, /Agent Hub 已上線/, 'the hub was not even started');
    assert.deepEqual(s.server.requests, [`/releases/download/${VERSION}/cloudflared-linux-amd64`], 'the fixed release was requested, not "latest"');
  } finally {
    await s.done();
  }
});

test('a download that matches the hash is installed, run, and not downloaded again on the next start', async () => {
  const s = await scenario({ '/releases/download/test-1.2.3/cloudflared-linux-amd64': GOOD }, { env: OVERRIDE });
  try {
    await s.run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 20000, 'the downloaded program to be run');
    assert.ok(s.executed(), 'the verified file was executed');
    assert.deepEqual(s.server.requests, ['/releases/download/test-1.2.3/cloudflared-linux-amd64']);
    assert.equal(fs.readFileSync(s.bin('cloudflared'), 'utf8'), GOOD.toString());
    assert.ok(fs.statSync(s.bin('cloudflared')).mode & 0o111, 'and made executable');
    assert.equal(fs.readFileSync(s.bin('cloudflared.verified'), 'utf8'), `test-1.2.3 ${sha256(GOOD)}\n`, 'a record says this program was checked');
    assert.deepEqual(fs.readdirSync(s.bin()).sort(), ['cloudflared', 'cloudflared.verified'], 'no download leftovers');
    await s.run.stop();

    // Started again: nothing to download.
    s.resetGate();
    const again = s.start();
    await again.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/, 20000, 'the second start');
    assert.equal(s.server.requests.length, 1, 'the verified program is kept, no second download');
  } finally {
    await s.done();
  }
});

test('a cloudflared that is already installed is used as it is: nothing is downloaded', async () => {
  const s = await scenario({}, { project: { installedCloudflared: true } });
  try {
    await s.run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
    assert.deepEqual(s.server.requests, []);
    assert.equal(fs.existsSync(s.bin('cloudflared')), false);
  } finally {
    await s.done();
  }
});

test('a program in bin/ from an older copy of the script (never checked) is not trusted: it is replaced by a checked download', async () => {
  const s = await scenario({ '/releases/download/test-1.2.3/cloudflared-linux-amd64': GOOD }, { env: OVERRIDE, autostart: false });
  try {
    fs.mkdirSync(s.bin(), { recursive: true });
    fs.writeFileSync(s.bin('cloudflared'), '#!/usr/bin/env bash\ntouch "$GATE_DIR/legacy.executed"\n', { mode: 0o755 });
    const run = s.start();
    await run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
    assert.equal(fs.existsSync(path.join(s.gate, 'legacy.executed')), false, 'the unchecked program never ran');
    assert.equal(s.server.requests.length, 1, 'a checked copy was downloaded instead');
    assert.equal(fs.readFileSync(s.bin('cloudflared'), 'utf8'), GOOD.toString());
  } finally {
    await s.done();
  }
});

test('a verified program that was changed afterwards is not trusted either', async () => {
  const s = await scenario({ '/releases/download/test-1.2.3/cloudflared-linux-amd64': GOOD }, { env: OVERRIDE });
  try {
    await s.run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
    await s.run.stop();
    fs.writeFileSync(s.bin('cloudflared'), '#!/usr/bin/env bash\ntouch "$GATE_DIR/tampered.executed"\n', { mode: 0o755 });
    s.resetGate();
    const run = s.start();
    await run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
    assert.equal(fs.existsSync(path.join(s.gate, 'tampered.executed')), false);
    assert.equal(s.server.requests.length, 2, 'downloaded again');
    assert.equal(fs.readFileSync(s.bin('cloudflared'), 'utf8'), GOOD.toString());
  } finally {
    await s.done();
  }
});

test('which file is requested for each platform (and the ones with no build are refused without a request)', async () => {
  const cases = [
    [['Linux', 'x86_64'], 'cloudflared-linux-amd64'],
    [['Linux', 'amd64'], 'cloudflared-linux-amd64'],
    [['Linux', 'aarch64'], 'cloudflared-linux-arm64'],
    [['Linux', 'armv7l'], 'cloudflared-linux-arm'],
    [['Darwin', 'x86_64'], 'cloudflared-darwin-amd64.tgz'],
    [['Darwin', 'arm64'], 'cloudflared-darwin-arm64.tgz'],
  ];
  for (const [uname, asset] of cases) {
    const s = await scenario({}, { uname }); // the server has nothing: every request is a 404
    try {
      const { code } = await s.run.finished();
      assert.equal(code, 1, s.run.text);
      assert.deepEqual(s.server.requests, [`/releases/download/${VERSION}/${asset}`], `${uname.join(' ')}`);
      assert.match(s.run.text, /下載 cloudflared 失敗/);
    } finally {
      await s.done();
    }
  }
  for (const [uname, why] of [[['Linux', 'riscv64'], /不支援的 CPU 架構/], [['Linux', 'i686'], /不支援的 CPU 架構/], [['FreeBSD', 'amd64'], /不支援的作業系統/], [['Darwin', 'armv7l'], /沒有 32 位元 ARM/]]) {
    const s = await scenario({}, { uname });
    try {
      const { code } = await s.run.finished();
      assert.equal(code, 1, s.run.text);
      assert.match(s.run.text, why, uname.join(' '));
      assert.deepEqual(s.server.requests, [], 'nothing was requested');
    } finally {
      await s.done();
    }
  }
});

test('on macOS the .tgz is checked before it is unpacked, and a good one is unpacked and run', async () => {
  // Build a real .tgz holding the stand-in program, as Cloudflare ships it.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tgz-'));
  fs.writeFileSync(path.join(work, 'cloudflared'), GOOD, { mode: 0o755 });
  const tgzPath = path.join(work, 'cloudflared-darwin-arm64.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgzPath, '-C', work, 'cloudflared']).status, 0);
  const tgz = fs.readFileSync(tgzPath);
  const files = { '/releases/download/test-1.2.3/cloudflared-darwin-arm64.tgz': tgz };

  // The wrong hash for that archive: refused before anything is unpacked.
  const bad = await scenario(files, { uname: ['Darwin', 'arm64'], env: { AGENT_HUB_CLOUDFLARED_VERSION: 'test-1.2.3', AGENT_HUB_CLOUDFLARED_SHA256: '0'.repeat(64) } });
  try {
    const { code } = await bad.run.finished();
    assert.equal(code, 1);
    assert.match(bad.run.text, /SHA-256 不符/);
    assert.deepEqual(fs.readdirSync(bad.bin()), [], 'nothing unpacked, nothing left');
    assert.equal(bad.executed(), false);
  } finally {
    await bad.done();
  }

  const good = await scenario(files, { uname: ['Darwin', 'arm64'], env: { AGENT_HUB_CLOUDFLARED_VERSION: 'test-1.2.3', AGENT_HUB_CLOUDFLARED_SHA256: sha256(tgz).toUpperCase() } });
  try {
    await good.run.waitFor(/https:\/\/tunnel-1\.trycloudflare\.com/);
    assert.ok(good.executed());
    assert.equal(fs.readFileSync(good.bin('cloudflared'), 'utf8'), GOOD.toString(), 'the program inside the archive is what runs');
  } finally {
    await good.done();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('another release needs both its version and its hash; a malformed hash is refused', async () => {
  for (const env of [{ AGENT_HUB_CLOUDFLARED_VERSION: '2099.1.1' }, { AGENT_HUB_CLOUDFLARED_SHA256: 'a'.repeat(64) }, { AGENT_HUB_CLOUDFLARED_VERSION: '2099.1.1', AGENT_HUB_CLOUDFLARED_SHA256: 'xyz' }, { AGENT_HUB_CLOUDFLARED_VERSION: '../../evil', AGENT_HUB_CLOUDFLARED_SHA256: 'a'.repeat(64) }]) {
    const s = await scenario({}, { env });
    try {
      const { code } = await s.run.finished();
      assert.equal(code, 1, `${JSON.stringify(env)}\n${s.run.text}`);
      assert.match(s.run.text, /AGENT_HUB_CLOUDFLARED_/);
      assert.deepEqual(s.server.requests, []);
    } finally {
      await s.done();
    }
  }
});

test('a computer with no sha256 tool cannot verify, so it does not run the download', async () => {
  const s = await scenario({ [`/releases/download/${VERSION}/cloudflared-linux-amd64`]: GOOD }, { project: { omitTools: ['sha256sum', 'shasum', 'openssl'] } });
  try {
    const { code } = await s.run.finished();
    assert.equal(code, 1, s.run.text);
    assert.match(s.run.text, /無法驗證下載檔/);
    assert.equal(s.executed(), false);
    assert.equal(fs.existsSync(s.bin('cloudflared')), false);
    assert.deepEqual(fs.readdirSync(s.bin()), []);
  } finally {
    await s.done();
  }
});

test('a failed download stops the script and leaves nothing behind', async () => {
  const s = await scenario({});
  try {
    const { code } = await s.run.finished();
    assert.equal(code, 1);
    assert.match(s.run.text, /下載 cloudflared 失敗/);
    assert.deepEqual(fs.readdirSync(s.bin()), []);
  } finally {
    await s.done();
  }
});

// ---------------------------------------------------------------------------
// The same rules in scripts/start-public.ps1 (Windows), run under PowerShell 7
// on this machine; skipped, saying so, when `pwsh` is not installed. The
// downloaded file is not executable here (no chmod on Windows), so these stop
// at what the script did with the download.
const PWSH = realPath('pwsh');
const SKIP_PS = PWSH ? false : 'pwsh (PowerShell 7) is not installed: the cloudflared download in scripts/start-public.ps1 was not run';
if (SKIP_PS) console.error(`[start-public-cloudflared] ${SKIP_PS}`);

async function psScenario(files, { env = {}, project = {} } = {}) {
  const proj = setupProject({ script: PS1, ...project });
  const server = await startAssetServer(files);
  const runs = [];
  const start = (more = {}) => {
    const r = runScript(proj, { script: PS1, command: PWSH, args: ['-NoProfile', '-File', path.join(proj.tmp, 'scripts', 'start-public.ps1')], inherit: true, env: { AGENT_HUB_CLOUDFLARED_BASE_URL: server.base, ...env, ...more } });
    runs.push(r);
    return r;
  };
  return {
    proj,
    server,
    start,
    bin: (...p) => path.join(proj.tmp, 'bin', ...p),
    async done() {
      for (const r of runs) await r.stop();
      await server.close();
      removeProject(proj);
    },
  };
}
const EXE = '/releases/download/test-1.2.3/cloudflared-windows-amd64.exe';

test('ps1: a download whose SHA-256 does not match is deleted and the script stops before starting anything', { skip: SKIP_PS, timeout: 90_000 }, async () => {
  const evil = Buffer.from('MZ not the real cloudflared');
  const s = await psScenario({ [`/releases/download/${VERSION}/cloudflared-windows-amd64.exe`]: evil });
  try {
    const run = s.start();
    const { code } = await run.finished(60_000);
    assert.equal(code, 1, run.text);
    assert.match(run.text, /SHA-256 不符/);
    assert.match(run.text, new RegExp(PINS['cloudflared-windows-amd64.exe']), 'the expected hash is shown');
    assert.deepEqual(fs.readdirSync(s.bin()), [], 'no program and no half-finished download is left in bin/');
    assert.doesNotMatch(run.text, /啟動中控台/, 'nothing was started');
    assert.deepEqual(s.server.requests, [`/releases/download/${VERSION}/cloudflared-windows-amd64.exe`], 'the fixed release was requested, not "latest"');
  } finally {
    await s.done();
  }
});

test('ps1: a matching download is installed with a record that it was checked, and kept on the next start; an unchecked or changed program is replaced', { skip: SKIP_PS, timeout: 180_000 }, async () => {
  const s = await psScenario({ [EXE]: GOOD }, { env: OVERRIDE });
  try {
    // The record is written last, so once it is complete the install is done.
    const recorded = () => {
      try {
        return fs.readFileSync(s.bin('cloudflared.exe.verified'), 'utf8').trim() === `test-1.2.3 ${sha256(GOOD)}`;
      } catch {
        return false;
      }
    };
    const installed = () => {
      try {
        return recorded() && fs.readFileSync(s.bin('cloudflared.exe'), 'utf8') === GOOD.toString();
      } catch {
        return false;
      }
    };
    const first = s.start();
    await waitUntil(installed, 60_000, `the download to be installed; output:\n${first.text}`);
    assert.equal(fs.readFileSync(s.bin('cloudflared.exe'), 'utf8'), GOOD.toString());
    assert.equal(fs.readFileSync(s.bin('cloudflared.exe.verified'), 'utf8').trim(), `test-1.2.3 ${sha256(GOOD)}`);
    assert.deepEqual(fs.readdirSync(s.bin()).sort(), ['cloudflared.exe', 'cloudflared.exe.verified'], 'no download leftovers');
    assert.deepEqual(s.server.requests, [EXE]);
    await first.stop();

    const again = s.start();
    await again.waitFor(/啟動中控台/, 60_000, 'the second start to get past the download step');
    assert.equal(s.server.requests.length, 1, 'the checked program is kept: no second download');
    await again.stop();

    // Changed afterwards, or from an older copy of the script (no record): replaced.
    fs.writeFileSync(s.bin('cloudflared.exe'), 'changed afterwards');
    const third = s.start();
    await waitUntil(() => s.server.requests.length === 2 && installed(), 60_000, `the changed program to be replaced; output:\n${third.text}`);
    assert.equal(fs.readFileSync(s.bin('cloudflared.exe'), 'utf8'), GOOD.toString());
    await third.stop();
    fs.rmSync(s.bin('cloudflared.exe.verified'));
    fs.writeFileSync(s.bin('cloudflared.exe'), 'older copy, never checked');
    const fourth = s.start();
    await waitUntil(() => s.server.requests.length === 3 && installed(), 60_000, `the unchecked program to be replaced; output:\n${fourth.text}`);
    assert.equal(fs.readFileSync(s.bin('cloudflared.exe'), 'utf8'), GOOD.toString());
  } finally {
    await s.done();
  }
});

test('ps1: another release needs both its version and its hash; an installed cloudflared is used without any download', { skip: SKIP_PS, timeout: 120_000 }, async () => {
  for (const env of [{ AGENT_HUB_CLOUDFLARED_VERSION: '2099.1.1' }, { AGENT_HUB_CLOUDFLARED_SHA256: 'a'.repeat(64) }, { AGENT_HUB_CLOUDFLARED_VERSION: '2099.1.1', AGENT_HUB_CLOUDFLARED_SHA256: 'xyz' }]) {
    const s = await psScenario({}, { env });
    try {
      const run = s.start();
      const { code } = await run.finished(60_000);
      assert.equal(code, 1, `${JSON.stringify(env)}\n${run.text}`);
      assert.match(run.text, /AGENT_HUB_CLOUDFLARED_/);
      assert.deepEqual(s.server.requests, []);
    } finally {
      await s.done();
    }
  }
  const s = await psScenario({}, { project: { installedCloudflared: true } });
  try {
    const run = s.start();
    await run.waitFor(/啟動中控台/, 60_000, 'the script to get past the cloudflared step');
    assert.deepEqual(s.server.requests, []);
    assert.equal(fs.existsSync(s.bin('cloudflared.exe')), false);
  } finally {
    await s.done();
  }
});
