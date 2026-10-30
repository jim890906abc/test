// The backups of a full purge (完全清除) end after 7 days: the Hub deletes its
// own half, and the half on a computer through that computer (which has to be
// connected: what waits for it is not forgotten), and never touches a file the
// purge did not make. Also: the tar.gz the Hub writes without any tool of the
// system is read back by the system's tar.
//
// The Hub is the REAL process (server/index.js) started on a data folder that
// already holds an index of backups, some of them long expired.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRealHub, until } from './fixtures/real-hub.mjs';
import { writeTarGz, tarHeader } from '../server/mini-tar.js';

const DAY = 24 * 3600 * 1000;
const hubs = [];
after(async () => {
  for (const h of hubs.reverse()) await h.stop();
});

const entry = (n, over = {}) => ({
  id: `c_${String(n).padStart(12, '0')}-20260101-000000`,
  clusterId: `c_${String(n).padStart(12, '0')}`,
  name: `叢集 ${n}`,
  purgedAt: Date.now() - 8 * DAY,
  expiresAt: Date.now() - DAY,
  partial: false,
  hub: { file: `cluster-c_${String(n).padStart(12, '0')}-20260101-000000.tar.gz`, bytes: 1 },
  machine: { machineId: 'm_fake', machineName: 'fake-machine', path: '', bytes: 1 },
  kept: [],
  ...over,
});

test('at start the Hub deletes the expired backups - its own files and, once the computer is connected, the computer\'s - drops them from the list, and leaves everything else alone', async () => {
  let TRASH_M; // the computer's trash
  let paths;
  const hub = await startRealHub('cluster-trash', {
    machine: (TMP) => ({ home: path.join(TMP, 'machine-home'), capabilities: ['kimi_delete'], stateDir: path.join(TMP, 'machine-state') }),
    seed: (DATA) => {
      const TMP = path.dirname(DATA);
      TRASH_M = path.join(TMP, 'machine-state', 'trash');
      const hubTrash = path.join(DATA, 'trash');
      fs.mkdirSync(hubTrash, { recursive: true });
      fs.mkdirSync(TRASH_M, { recursive: true });
      const mk = (n, over) => {
        const e = entry(n, over);
        e.machine.path = over?.machine?.path ?? path.join(TRASH_M, e.hub.file);
        return e;
      };
      const expired = mk(1);
      const young = mk(2, { expiresAt: Date.now() + 3 * DAY });
      const stranger = path.join(TMP, 'machine-home', 'precious.txt'); // an entry that points at something that is not a backup
      fs.mkdirSync(path.dirname(stranger), { recursive: true });
      fs.writeFileSync(stranger, 'mine');
      const odd = mk(3, { machine: { machineId: 'm_fake', machineName: 'fake-machine', path: stranger, bytes: 1 } });
      const away = mk(4, { machine: { machineId: 'm_never_connected', machineName: 'away', path: path.join(TRASH_M, entry(4).hub.file), bytes: 1 } });
      for (const e of [expired, young, odd, away]) fs.writeFileSync(path.join(hubTrash, e.hub.file), 'hub half');
      for (const e of [expired, young]) fs.writeFileSync(e.machine.path, 'machine half');
      const unlisted = path.join(TRASH_M, 'cluster-c_999999999999-20260101-000000.tar.gz');
      fs.writeFileSync(unlisted, 'not in the list');
      fs.writeFileSync(path.join(hubTrash, 'index.json'), JSON.stringify({ version: 1, items: [expired, young, odd, away] }));
      paths = { expired, young, odd, away, stranger, unlisted, hubTrash };
    },
  });
  hubs.push(hub);

  await until(async () => !fs.existsSync(paths.expired.machine.path), 15000, 'the computer\'s expired backup deleted through the connected computer');
  const list = async () => (await hub.api('GET', '/clusters/trash')).items;
  await until(async () => !(await list()).some((i) => i.id === paths.expired.id), 5000, 'the expired entry dropped');
  // The Hub's half of the expired one is gone, the young one is whole.
  assert.ok(!fs.existsSync(path.join(paths.hubTrash, paths.expired.hub.file)));
  assert.ok(fs.existsSync(path.join(paths.hubTrash, paths.young.hub.file)));
  assert.ok(fs.existsSync(paths.young.machine.path), 'not yet 7 days');
  assert.ok((await list()).some((i) => i.id === paths.young.id));
  // A path that is not a backup's name is never deleted, though the entry says so.
  assert.equal(fs.readFileSync(paths.stranger, 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(paths.hubTrash, paths.odd.hub.file)), 'its Hub half went');
  assert.ok(!(await list()).some((i) => i.id === paths.odd.id));
  // A computer that never connects: the Hub's half goes, the entry stays for the computer's half.
  const away = (await list()).find((i) => i.id === paths.away.id);
  assert.ok(away, 'waits for its computer');
  assert.equal(away.hub.removed, true);
  assert.equal(away.machine.removed, false);
  assert.ok(!fs.existsSync(path.join(paths.hubTrash, paths.away.hub.file)));
  // A backup that is in nobody's list is nobody's to delete here.
  assert.ok(fs.existsSync(paths.unlisted));
  assert.ok(hub.machine.rpcs.some((r) => r.op === 'sh.run' && /rm -f/.test(r.args.command)), 'it was the computer that deleted its own file');
});

// ------------------------------------------------------------------ mini tar

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mini-tar-'));
}

test('the Hub\'s own tar.gz is read back by the system tar: names (long, Chinese), contents byte for byte, files of every size around a block, an empty file', async () => {
  const dir = tmpdir();
  const sizes = [0, 1, 511, 512, 513, 1024, 100_000, 3 * 1024 * 1024 + 7];
  const src = [];
  sizes.forEach((n, i) => {
    const f = path.join(dir, `src-${i}.bin`);
    fs.writeFileSync(f, Buffer.from(Array.from({ length: n }, (_, k) => (k * 31 + i) & 255)));
    src.push(f);
  });
  const longName = `sessions/${'長'.repeat(30)}/${'x'.repeat(60)}.json`;
  assert.ok(Buffer.byteLength(longName) > 100, 'the premise: past the 100 bytes of a plain name');
  const entries = [
    { name: 'MANIFEST.json', data: '{"清單":"內容"}' },
    ...src.map((file, i) => ({ name: `sessions/s_${i}.json`, file })),
    { name: longName, data: Buffer.from('long name') },
    { name: '含 空白/與 中文.txt', data: '中文內容' },
  ];
  const out = path.join(dir, 'out.tar.gz');
  const bytes = await writeTarGz(out, entries);
  assert.equal(bytes, fs.statSync(out).size);
  assert.equal(fs.statSync(out).mode & 0o077, 0, 'private');
  const names = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(names, entries.map((e) => e.name));
  const x = path.join(dir, 'x');
  fs.mkdirSync(x);
  execFileSync('tar', ['-xzf', out, '-C', x]);
  src.forEach((f, i) => assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(x, `sessions/s_${i}.json`))), `file ${i} (${sizes[i]} bytes)`));
  assert.equal(fs.readFileSync(path.join(x, 'MANIFEST.json'), 'utf8'), '{"清單":"內容"}');
  assert.equal(fs.readFileSync(path.join(x, longName), 'utf8'), 'long name');
  assert.equal(fs.readFileSync(path.join(x, '含 空白/與 中文.txt'), 'utf8'), '中文內容');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that changes size while it is being read stops the archive with an error (a short archive is not passed off as whole), and a name that cannot be written is refused', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'grow.bin');
  fs.writeFileSync(f, Buffer.alloc(2 * 1024 * 1024, 7));
  const out = path.join(dir, 'out.tar.gz');
  const shrinking = writeTarGz(out, [{ name: 'a.bin', file: f }]);
  fs.truncateSync(f, 1000);
  // (Either it read the old size before the cut or it noticed: it never writes an archive that lies.)
  const result = await shrinking.then(() => 'ok', (e) => e.message);
  if (result !== 'ok') assert.match(result, /changed while it was read/);
  else assert.ok(execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).includes('a.bin'));
  assert.throws(() => tarHeader('d'.repeat(300), 1), /name too long/);
  fs.rmSync(dir, { recursive: true, force: true });
});
