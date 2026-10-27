// agents.json (the agents a person added, some with an API key) and settings.json
// (their defaults) are not worth less than the key files: a file that is there
// but cannot be used must not be taken for "nothing saved" and written over by
// the next start or the next save. Every test runs the REAL Hub on a temp data
// folder:
//   • damaged: copied byte for byte into damaged-config/ (0600, folder 0700),
//     said once in plain words with where the copy is, and NOT written over by
//     the start (agent merge, settings migration) or by reading; only a person
//     adding/changing an agent or saving the defaults replaces it;
//   • unreadable (a link to itself, a folder): never written over — a save is
//     refused with the reason;
//   • the temporary file of a process that is gone is removed at the next start;
//   • a kill in the middle of a save leaves the old file whole.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanup, scratch, spawnHub, readJson } from './fixtures/hub-process.mjs';

after(cleanup);

const BAK = (sc) => path.join(sc.data, 'damaged-config');
const backups = (sc, name) => (fs.existsSync(BAK(sc)) ? fs.readdirSync(BAK(sc)).filter((f) => f.startsWith(`${name}.`) && /^\d+$/.test(f.slice(name.length + 1))) : []);
const mode = (f) => fs.statSync(f).mode & 0o777;
const same = (file, bytes) => fs.readFileSync(file).equals(bytes);
const env = { AGENT_HUB_TOKEN: 'none' };
const api = async (hub, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${hub.port}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const count = (text, re) => (text.match(re) || []).length;

const SECRET = 'SECRETFRAGMENT0123456789';
const MINE = { id: 'mine-1', name: '我的模型', type: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: `sk-${SECRET}`, builtin: false, enabled: true };
const NEW_AGENT = { name: '新加的', type: 'openai', baseUrl: 'http://127.0.0.1:2', model: 'n' };
const FILES = [
  {
    file: 'agents.json',
    what: 'Agent 清單',
    cut: Buffer.from(`[\n  {\n    "id": "mine-1",\n    "apiKey": "sk-${SECRET}`),
    good: JSON.stringify([MINE]),
    // A person adds an agent / saves the defaults.
    save: (hub) => api(hub, 'POST', '/agents', NEW_AGENT),
    saved: (sc) => readJson(sc.file('agents.json')).some((a) => a.name === '新加的'),
    mark: '"name": "新加的"',
  },
  {
    file: 'settings.json',
    what: '預設設定',
    cut: Buffer.from('{\n  "defaults": {\n    "provider": "claude",\n    "byProvider": {"cla'),
    good: JSON.stringify({ defaults: { provider: 'kimi', effort: 'low' }, migrated: ['effort-max'] }),
    save: (hub) => api(hub, 'PUT', '/settings', { defaults: { effort: 'high' } }),
    saved: (sc) => readJson(sc.file('settings.json')).defaults?.effort === 'high',
    mark: '"effort": "high"',
  },
];
const DAMAGE = (f) => ({
  'cut in the middle': f.cut,
  'empty': Buffer.alloc(0),
  'zero-filled (blocks that never reached the disk)': Buffer.alloc(96),
  'not JSON at all': Buffer.from('<<<<<<< HEAD\nthe merge went wrong\n'),
  'JSON, but the wrong shape': Buffer.from(f.file === 'agents.json' ? '{"id":"x"}' : '[1, 2]'),
});

for (const f of FILES) {
  test(`${f.file} damaged: kept byte for byte in damaged-config, said ONCE out loud with where the copy is, and NOT written over by the start or by reading`, async () => {
    for (const [what, bytes] of Object.entries(DAMAGE(f))) {
      const sc = scratch(`${f.file}-damaged`);
      fs.writeFileSync(sc.file(f.file), bytes);
      const hub = await spawnHub(sc, { env });
      try {
        await hub.ready;
        // Reading it again and again (every page load does) must not say it again.
        for (let i = 0; i < 3; i++) await api(hub, 'GET', '/config');
        const [name, ...more] = backups(sc, f.file);
        assert.ok(name && !more.length, `${what}: exactly one copy (${backups(sc, f.file)})`);
        assert.ok(same(path.join(BAK(sc), name), bytes), `${what}: the copy is the damaged file, byte for byte`);
        assert.equal(mode(path.join(BAK(sc), name)), 0o600);
        assert.equal(mode(BAK(sc)), 0o700);
        const log = hub.out();
        assert.equal(count(log, new RegExp(`${f.file.replace('.', '\\.')} 損壞`, 'g')), 1, `${what}: said once, not at every read\n${log}`);
        assert.ok(log.includes(path.join(BAK(sc), name)), `${what}: says where the copy is`);
        assert.ok(!log.includes(SECRET), 'never quotes what is in the file');
        assert.ok(same(sc.file(f.file), bytes), `${what}: the damaged file is untouched by the start and by reading`);
      } finally {
        await hub.stop();
      }
    }
  });

  test(`${f.file} damaged, then a person saves: only that writes a good file; the damaged one stays in damaged-config; the next start is quiet`, async () => {
    const sc = scratch(`${f.file}-resave`);
    fs.writeFileSync(sc.file(f.file), f.cut);
    const hub = await spawnHub(sc, { env });
    try {
      await hub.ready;
      assert.ok(same(sc.file(f.file), f.cut));
      const r = await f.save(hub);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(f.saved(sc), 'what the person saved is in the new file');
      assert.ok(!fs.readFileSync(sc.file(f.file), 'utf8').includes(SECRET), 'nothing of the damaged file is carried over');
      const [name, ...more] = backups(sc, f.file);
      assert.ok(name && !more.length && same(path.join(BAK(sc), name), f.cut), 'the damaged file is still kept');
    } finally {
      await hub.stop();
    }
    const again = await spawnHub(sc, { env });
    try {
      await again.ready;
      assert.doesNotMatch(again.out(), new RegExp(`${f.file.replace('.', '\\.')} 損壞`));
      assert.equal(backups(sc, f.file).length, 1);
    } finally {
      await again.stop();
    }
  });

  test(`${f.file} damaged and the original cannot be copied away: not written over, not even by a person's save; the error says why`, async () => {
    const sc = scratch(`${f.file}-nocopy`);
    fs.writeFileSync(sc.file(f.file), f.cut);
    fs.writeFileSync(BAK(sc), 'a file where the folder for the copies should be');
    const hub = await spawnHub(sc, { env });
    try {
      await hub.ready;
      assert.match(hub.out(), /備份/);
      const r = await f.save(hub);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /備份/);
      assert.ok(same(sc.file(f.file), f.cut), 'the damaged file — the only copy — is untouched');
    } finally {
      await hub.stop();
    }
  });

  for (const [what, make] of Object.entries({ 'a folder': (p) => fs.mkdirSync(p), 'a link to itself': (p) => fs.symlinkSync(path.basename(p), p) })) {
    test(`${f.file} that cannot be read (${what}): never written over by the start or by a save, the Hub keeps running and says why`, async () => {
      const sc = scratch(`${f.file}-unreadable`);
      make(sc.file(f.file));
      const ino = fs.lstatSync(sc.file(f.file)).ino;
      const hub = await spawnHub(sc, { env });
      try {
        await hub.ready;
        await api(hub, 'GET', '/config');
        assert.match(hub.out(), new RegExp(f.file.replace('.', '\\.')));
        assert.match(hub.out(), /讀不到/);
        const r = await f.save(hub);
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /讀不到/);
        const st = fs.lstatSync(sc.file(f.file));
        assert.ok((st.isDirectory() || st.isSymbolicLink()) && st.ino === ino, 'still what it was');
        assert.equal(hub.proc.exitCode, null);
      } finally {
        await hub.stop();
      }
    });
  }

  test(`${f.file}: the temporary file of a process that is gone is removed at start; a live process's is not touched`, async () => {
    const sc = scratch(`${f.file}-stale`);
    fs.writeFileSync(sc.file(f.file), f.good);
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.once('exit', r));
    const stale = sc.file(`${f.file}.${dead.pid}.tmp`);
    const alive = sc.file(`${f.file}.${process.pid}.tmp`);
    fs.writeFileSync(stale, '{"half":');
    fs.writeFileSync(alive, '{"being":"written"}');
    const hub = await spawnHub(sc, { env });
    await hub.ready;
    await hub.stop();
    assert.equal(fs.existsSync(stale), false, 'a dead process\'s file is cleaned up');
    assert.equal(fs.readFileSync(alive, 'utf8'), '{"being":"written"}', 'a live process\'s file is left alone');
  });

  test(`${f.file}: a kill in the middle of a save leaves the old file whole`, async () => {
    const sc = scratch(`${f.file}-kill`);
    const old = Buffer.from(f.good);
    fs.writeFileSync(sc.file(f.file), old);
    const hub = await spawnHub(sc, { env, chaos: { mark: f.mark } });
    await hub.ready;
    // The start's own rewrite of the file (agent merge / migration) may carry
    // the mark too; either way the file on disk must be a whole one.
    f.save(hub).catch(() => {});
    const end = await hub.stopsWithin();
    assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${hub.out()}`);
    JSON.parse(fs.readFileSync(sc.file(f.file), 'utf8')); // half a file does not parse
    const again = await spawnHub(sc, { env });
    await again.ready;
    await again.stop();
    assert.deepEqual(fs.readdirSync(sc.data).filter((n) => n.startsWith(`${f.file}.`) && n.endsWith('.tmp')), [], 'the half-written file is cleaned up at the next start');
  });
}

test('agents.json fine: the agents are loaded and kept, nothing is copied or warned (control for the damage checks)', async () => {
  const sc = scratch('agents-fine');
  fs.writeFileSync(sc.file('agents.json'), JSON.stringify([MINE]));
  const hub = await spawnHub(sc, { env });
  try {
    await hub.ready;
    const list = (await api(hub, 'GET', '/agents')).body;
    assert.ok(list.some((a) => a.id === 'mine-1'), 'the saved agent is there');
    assert.ok(readJson(sc.file('agents.json')).some((a) => a.id === 'mine-1' && a.apiKey === MINE.apiKey), 'and still in the file, with its key');
    assert.equal(fs.existsSync(BAK(sc)), false);
    assert.doesNotMatch(hub.out(), /損壞/);
  } finally {
    await hub.stop();
  }
});

test('settings.json fine or missing: the start still migrates the defaults, as before (control)', async () => {
  const sc = scratch('settings-migrate');
  const hub = await spawnHub(sc, { env });
  try {
    await hub.ready;
    assert.deepEqual(readJson(sc.file('settings.json')).migrated, ['effort-max']);
    assert.equal(readJson(sc.file('settings.json')).defaults.effort, 'max');
  } finally {
    await hub.stop();
  }
});

test('settings.json damaged: the defaults are the built-in ones meanwhile, and the defaults a person saves afterwards stay', async () => {
  const sc = scratch('settings-defaults');
  fs.writeFileSync(sc.file('settings.json'), FILES[1].cut);
  const hub = await spawnHub(sc, { env });
  try {
    await hub.ready;
    assert.deepEqual((await api(hub, 'GET', '/config')).body.settings, { defaults: {} });
    assert.equal((await FILES[1].save(hub)).status, 200);
    assert.equal((await api(hub, 'GET', '/config')).body.settings.defaults.effort, 'high');
  } finally {
    await hub.stop();
  }
});
