// The two files that hold a person's API keys — claude.json (the Claude Console
// key) and deepseek.json (the gateway key pool) — must not lose a key without a
// word. Every test runs the REAL Hub (server/index.js) on a temp data folder:
//   • written whole or not at all, private (0600) from the first byte, the data
//     synced before the rename and the folder entry after it; a kill in the
//     middle of a write (a real SIGKILL) leaves the old file, and the half-written
//     temporary file of a process that is gone is cleaned up at the next start;
//   • a file that is there but cannot be used is never taken for "no key":
//       damaged     copied byte for byte into damaged-config/ (0600, folder 0700),
//                   said at start in plain words (without quoting what is in the
//                   file), shown by the API (`damaged`) and by every error that
//                   would otherwise say "no key is set" — and NOT written over by
//                   anything the Hub does by itself or for an unrelated change;
//                   only the person typing a key again replaces it;
//       unreadable  (a folder, a link to itself, no permission) never written over;
//   • a key from the environment still works while the file is unusable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanup, scratch, spawnHub, readJson, opsOf, aroundRename } from './fixtures/hub-process.mjs';
import { startFakeClaude } from './fixtures/fake-anthropic.mjs';
import { startFakeGateway, GATEWAY_KEY } from './fixtures/fake-machine.mjs';

const CLAUDE_KEY = `sk-ant-api03-${'k'.repeat(40)}-test`;
const fakes = [];
after(() => {
  cleanup();
  for (const f of fakes) f.close();
});
const fakeClaude = await startFakeClaude(CLAUDE_KEY);
const fakeGateway = await startFakeGateway();
fakes.push(fakeClaude, fakeGateway);

const BAK = (sc) => path.join(sc.data, 'damaged-config');
const backups = (sc, name) => (fs.existsSync(BAK(sc)) ? fs.readdirSync(BAK(sc)).filter((f) => f.startsWith(`${name}.`) && /^\d+$/.test(f.slice(name.length + 1))) : []);
const mode = (f) => fs.statSync(f).mode & 0o777;
const same = (file, bytes) => fs.readFileSync(file).equals(bytes);
const tmps = (sc) => fs.readdirSync(sc.data).filter((f) => f.endsWith('.tmp'));

// What a crash, a bad disk or a careless editor leaves behind. The secret in
// the first one must never be quoted by the Hub (it is a key).
const SECRET = 'SECRETFRAGMENT0123456789';
const ACCOUNTS = [
  {
    name: 'claude',
    file: 'claude.json',
    api: '/claude',
    env: () => ({ AGENT_HUB_TOKEN: 'none', AGENT_HUB_CLAUDE_TEST_URL: fakeClaude.url }),
    newKey: CLAUDE_KEY,
    // A change that is not a key: Claude's 設定 save sends the web switch every time.
    unrelated: { webTools: false },
    mark: '"webTools": false',
    cut: Buffer.from(`{\n  "apiKey": "sk-ant-api03-${SECRET}`),
    good: { apiKey: `sk-ant-api03-${'g'.repeat(40)}-kept`, webTools: true },
    hasKey: (acc) => acc.hasKey,
    keyWords: /API key/,
  },
  {
    name: 'deepseek',
    file: 'deepseek.json',
    api: '/deepseek',
    env: () => ({ AGENT_HUB_TOKEN: 'none', AGENT_HUB_DEEPSEEK_TEST_URL: fakeGateway.url }),
    newKey: GATEWAY_KEY,
    unrelated: { defaults: { effort: 'low' } },
    mark: '"effort": "low"',
    cut: Buffer.from(`{"keys":{"opencode-go":{"revision":3,"activeId":"k1","keys":[{"id":"k1","key":"sk-${SECRET}`),
    good: { gateway: 'opencode-go', keys: { 'opencode-go': { revision: 2, activeId: 'k_old', keys: [{ id: 'k_old', key: 'sk-oc-go-kept-0123456789', addedAt: 1000 }] } }, activity: {} },
    hasKey: (acc) => acc.hasKey,
    keyWords: /金鑰池|API key/,
  },
];

const DAMAGE = (a) => ({
  'cut in the middle': a.cut,
  'empty': Buffer.alloc(0),
  'zero-filled (blocks that never reached the disk)': Buffer.alloc(96),
  'not JSON at all': Buffer.from('<<<<<<< HEAD\nthe merge went wrong\n'),
  'JSON, but an array': Buffer.from('[1, 2]'),
});

// PUT that does not throw on a refusal: { status, body }.
async function put(hub, p, body) {
  const r = await fetch(`http://127.0.0.1:${hub.port}/api${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function get(hub, p) {
  const r = await fetch(`http://127.0.0.1:${hub.port}/api${p}`);
  return { status: r.status, body: await r.json() };
}
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

for (const a of ACCOUNTS) {
  // ------------------------------------------------------- written durably

  test(`${a.file}: written private (0600) from the first byte, the data synced before the rename and the folder after`, async () => {
    const sc = scratch(`${a.name}-order`);
    const log = path.join(sc.dir, 'ops.log');
    const hub = await spawnHub(sc, { env: a.env(), chaos: { log } });
    await hub.ready;
    try {
      const r = await put(hub, a.api, { apiKey: a.newKey });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await until(() => opsOf(log).includes(`rename ${a.file}`), `${a.file} to be written`);
      const { before, after, opens } = aroundRename(opsOf(log), a.file);
      assert.equal(before, 'fsync', 'the data is on disk right before the rename');
      assert.equal(after, 'fsync-dir', 'the folder entry is synced right after');
      assert.match(opens.at(-1), new RegExp(`^open ${a.file.replace('.', '\\.')}\\.\\d+\\.tmp w 600$`), 'created private from the start');
      assert.equal(mode(sc.file(a.file)), 0o600);
      assert.ok(fs.readFileSync(sc.file(a.file), 'utf8').includes(a.newKey), 'the key is in the file');
    } finally {
      await hub.stop();
    }
  });

  test(`${a.file}: a kill in the middle of a rewrite leaves the old file whole; the half-written temporary file is cleaned up at the next start`, async () => {
    const sc = scratch(`${a.name}-kill`);
    const old = Buffer.from(JSON.stringify(a.good, null, 2));
    fs.writeFileSync(sc.file(a.file), old, { mode: 0o600 });
    const hub = await spawnHub(sc, { env: a.env(), chaos: { mark: a.mark } });
    await hub.ready;
    put(hub, a.api, a.unrelated).catch(() => {}); // the write is cut, the connection dies with the Hub
    const end = await hub.stopsWithin();
    assert.equal(end.signal, 'SIGKILL', `the write really was cut (positive control)\n${hub.out()}`);
    assert.ok(same(sc.file(a.file), old), 'the old file is whole (half a file would not parse)');
    assert.equal(tmps(sc).filter((f) => f.startsWith(`${a.file}.`)).length, 1, 'the half-written file is what the kill left (positive control)');

    const again = await spawnHub(sc, { env: a.env() });
    await again.ready;
    try {
      assert.deepEqual(tmps(sc).filter((f) => f.startsWith(`${a.file}.`)), [], 'cleaned up at the next start');
      assert.ok(same(sc.file(a.file), old) || readJson(sc.file(a.file)), 'and the file is still whole');
    } finally {
      await again.stop();
    }
  });

  test(`${a.file}: the temporary file of a process that is gone is removed at start; a live process's is not touched`, async () => {
    const sc = scratch(`${a.name}-stale`);
    fs.writeFileSync(sc.file(a.file), JSON.stringify(a.good), { mode: 0o600 });
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.once('exit', r));
    const stale = sc.file(`${a.file}.${dead.pid}.tmp`);
    const alive = sc.file(`${a.file}.${process.pid}.tmp`); // this test process is alive
    fs.writeFileSync(stale, '{"half":');
    fs.writeFileSync(alive, '{"being":"written"}');
    const hub = await spawnHub(sc, { env: a.env() });
    await hub.ready;
    await hub.stop();
    assert.equal(fs.existsSync(stale), false, 'a dead process\'s file is cleaned up');
    assert.equal(fs.readFileSync(alive, 'utf8'), '{"being":"written"}', 'a live process\'s file is left alone');
  });

  // ------------------------------------------------------------- a fine file

  test(`${a.file} fine: the key is loaded, the file is not rewritten, nothing is copied or warned (control for the damage checks)`, async () => {
    const sc = scratch(`${a.name}-fine`);
    // Written by hand: if the Hub rewrote it, the spacing would change.
    const text = JSON.stringify(a.good);
    fs.writeFileSync(sc.file(a.file), text, { mode: 0o600 });
    const hub = await spawnHub(sc, { env: a.env() });
    try {
      await hub.ready;
      const acc = (await get(hub, a.api)).body;
      assert.equal(a.hasKey(acc), true, 'the saved key is there');
      assert.equal(acc.damaged ?? null, null);
      assert.equal(fs.readFileSync(sc.file(a.file), 'utf8'), text);
      assert.equal(fs.existsSync(BAK(sc)), false);
      assert.doesNotMatch(hub.out(), /損壞/);
    } finally {
      await hub.stop();
    }
  });

  // ---------------------------------------------------------------- damaged

  for (const [what, bytes] of Object.entries(DAMAGE(a))) {
    test(`${a.file} damaged (${what}): kept byte for byte in damaged-config, said out loud without quoting it, shown by the API, and NOT written over`, async () => {
      const sc = scratch(`${a.name}-damaged`);
      fs.writeFileSync(sc.file(a.file), bytes, { mode: 0o600 });
      const hub = await spawnHub(sc, { env: a.env() });
      try {
        await hub.ready;
        const [name, ...more] = backups(sc, a.file);
        assert.ok(name && !more.length, `exactly one copy of the damaged file is kept (${backups(sc, a.file)})`);
        assert.ok(same(path.join(BAK(sc), name), bytes), 'the copy is the damaged file, byte for byte');
        assert.equal(mode(path.join(BAK(sc), name)), 0o600, 'the copy is private');
        assert.equal(mode(BAK(sc)), 0o700, 'the folder is private');

        // The start says so, in plain words, and where the copy is — without the file's content.
        const log = hub.out();
        assert.ok(log.includes(a.file), `names the file\n${log}`);
        assert.match(log, /損壞/);
        assert.ok(log.includes(path.join(BAK(sc), name)), `says where the copy is\n${log}`);
        assert.match(log, a.keyWords, 'says what could not be loaded');
        assert.match(log, /重新輸入|從備份還原/, 'says what to do');
        assert.ok(!log.includes(SECRET), 'never quotes what is in the file (it is a key)');

        // Nothing the Hub does by itself has written over it.
        assert.ok(same(sc.file(a.file), bytes), 'the damaged file is untouched after the start');
        const acc = (await get(hub, a.api)).body;
        assert.equal(a.hasKey(acc), false, 'no key is made up');
        assert.equal(acc.damaged?.file, a.file, 'the API says the file is damaged');
        assert.equal(acc.damaged?.backup, path.join(BAK(sc), name), 'and where the copy is');
        assert.equal((await get(hub, '/config')).body[a.name].damaged?.file, a.file, '/api/config carries it too');

        // A change that is not the key does not replace it either: refused, plainly.
        const r = await put(hub, a.api, a.unrelated);
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /損壞/);
        assert.ok(r.body.error.includes(path.join(BAK(sc), name)), `the error says where the copy is: ${r.body.error}`);
        assert.ok(same(sc.file(a.file), bytes), 'still the damaged file after a settings change');
        assert.equal(backups(sc, a.file).length, 1, 'and still one copy');
      } finally {
        await hub.stop();
      }
    });
  }

  test(`${a.file} damaged: the same bytes are kept once however often the Hub starts; different damage is kept as well and the first copy is never overwritten`, async () => {
    const sc = scratch(`${a.name}-reuse`);
    const first = a.cut;
    fs.writeFileSync(sc.file(a.file), first);
    for (let i = 0; i < 3; i++) {
      const hub = await spawnHub(sc, { env: a.env() });
      await hub.ready;
      await hub.stop();
    }
    assert.equal(backups(sc, a.file).length, 1, 'three starts, one copy');
    const [name] = backups(sc, a.file);
    fs.writeFileSync(sc.file(a.file), Buffer.from('some other kind of damage'));
    const hub = await spawnHub(sc, { env: a.env() });
    await hub.ready;
    await hub.stop();
    assert.equal(backups(sc, a.file).length, 2);
    assert.ok(same(path.join(BAK(sc), name), first), 'the first copy still holds the first damage');
  });

  test(`${a.file} damaged, then the person types a key again: that (and only that) writes a good file, 0600; the damaged one stays in damaged-config; the warning is gone`, async () => {
    const sc = scratch(`${a.name}-reenter`);
    fs.writeFileSync(sc.file(a.file), a.cut, { mode: 0o600 });
    const hub = await spawnHub(sc, { env: a.env() });
    try {
      await hub.ready;
      const r = await put(hub, a.api, { apiKey: a.newKey });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(a.hasKey(r.body), true);
      assert.equal(r.body.damaged ?? null, null, 'the file is good again, nothing to warn about');
      const now = readJson(sc.file(a.file));
      assert.ok(JSON.stringify(now).includes(a.newKey), 'the key the person typed is in the new file');
      assert.ok(!JSON.stringify(now).includes(SECRET), 'nothing of the damaged file is carried over');
      assert.equal(mode(sc.file(a.file)), 0o600);
      const [name, ...more] = backups(sc, a.file);
      assert.ok(name && !more.length && same(path.join(BAK(sc), name), a.cut), 'the damaged file is still kept');
      // A change that is not the key goes through now.
      assert.equal((await put(hub, a.api, a.unrelated)).status, 200);
    } finally {
      await hub.stop();
    }
    // And the next start is quiet.
    const again = await spawnHub(sc, { env: a.env() });
    try {
      await again.ready;
      assert.doesNotMatch(again.out(), /損壞/);
      assert.equal(a.hasKey((await get(again, a.api)).body), true, 'the key survived the restart');
    } finally {
      await again.stop();
    }
  });

  test(`${a.file} damaged and the original cannot be copied away: not written over, not even when a key is typed; the error says why`, async () => {
    const sc = scratch(`${a.name}-nocopy`);
    fs.writeFileSync(sc.file(a.file), a.cut);
    fs.writeFileSync(BAK(sc), 'a file where the folder for the copies should be');
    const hub = await spawnHub(sc, { env: a.env() });
    try {
      await hub.ready;
      assert.match(hub.out(), /備份/);
      const r = await put(hub, a.api, { apiKey: a.newKey });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /備份/);
      assert.ok(same(sc.file(a.file), a.cut), 'the damaged file — the only copy — is untouched');
      assert.equal(a.hasKey((await get(hub, a.api)).body), false);
    } finally {
      await hub.stop();
    }
  });

  test(`${a.file} repaired by hand while the Hub runs: typing a key again does not write over the repaired file`, async () => {
    const sc = scratch(`${a.name}-handfix`);
    fs.writeFileSync(sc.file(a.file), a.cut, { mode: 0o600 });
    const hub = await spawnHub(sc, { env: a.env() });
    try {
      await hub.ready;
      const fixed = Buffer.from(JSON.stringify(a.good));
      fs.writeFileSync(sc.file(a.file), fixed, { mode: 0o600 }); // restored from the copy
      const r = await put(hub, a.api, { apiKey: a.newKey });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /重新啟動/, 'says the Hub has to be started again to load it');
      assert.ok(same(sc.file(a.file), fixed), 'the repaired file is untouched');
    } finally {
      await hub.stop();
    }
  });

  // ------------------------------------------------------------- unreadable

  const UNREADABLE = { 'a folder': (f) => fs.mkdirSync(f), 'a link to itself': (f) => fs.symlinkSync(path.basename(f), f) };
  for (const [what, make] of Object.entries(UNREADABLE)) {
    test(`${a.file} that cannot be read (${what}): never written over — not by the Hub, not by a typed key — the Hub keeps running and says why`, async () => {
      const sc = scratch(`${a.name}-unreadable`);
      make(sc.file(a.file));
      const before = fs.lstatSync(sc.file(a.file)).ino;
      const still = () => (fs.lstatSync(sc.file(a.file)).isDirectory() || fs.lstatSync(sc.file(a.file)).isSymbolicLink()) && fs.lstatSync(sc.file(a.file)).ino === before;
      const hub = await spawnHub(sc, { env: a.env() });
      try {
        await hub.ready;
        assert.match(hub.out(), new RegExp(a.file.replace('.', '\\.')));
        assert.match(hub.out(), /讀不到/);
        assert.ok(still(), 'untouched at the start');
        const acc = (await get(hub, a.api)).body;
        assert.equal(acc.damaged?.file, a.file);
        assert.equal(acc.damaged?.state, 'unreadable');
        for (const body of [{ apiKey: a.newKey }, a.unrelated]) {
          const r = await put(hub, a.api, body);
          assert.equal(r.status, 409, JSON.stringify(r.body));
          assert.match(r.body.error, /讀不到/);
          assert.ok(still(), `untouched after ${JSON.stringify(Object.keys(body))}`);
        }
        assert.equal(hub.proc.exitCode, null, 'the Hub is still running');
        assert.equal(fs.existsSync(BAK(sc)), false, 'nothing is copied: there is nothing to copy');
      } finally {
        await hub.stop();
      }
    });
  }
}

// -------------------------------------------- what only Claude's file has

test('claude.json damaged: a key from ANTHROPIC_API_KEY still works, the file is still not written over, and the person is still told the saved key is gone', async () => {
  const sc = scratch('claude-damaged-env');
  fs.writeFileSync(sc.file('claude.json'), ACCOUNTS[0].cut, { mode: 0o600 });
  const hub = await spawnHub(sc, { env: { ...ACCOUNTS[0].env(), ANTHROPIC_API_KEY: CLAUDE_KEY } });
  try {
    await hub.ready;
    const acc = (await get(hub, '/claude')).body;
    assert.equal(acc.hasKey, true);
    assert.equal(acc.keySource, 'env', 'the environment key is used while the saved one cannot be loaded');
    assert.equal(acc.damaged?.file, 'claude.json');
    assert.ok(same(sc.file('claude.json'), ACCOUNTS[0].cut));
    assert.equal((await get(hub, '/claude/models')).status, 200, 'and the API can be reached with it');
  } finally {
    await hub.stop();
  }
});

test('claude.json fine: a key saved in the Hub still wins over ANTHROPIC_API_KEY (the module\'s own order is unchanged)', async () => {
  const sc = scratch('claude-fine-env');
  fs.writeFileSync(sc.file('claude.json'), JSON.stringify(ACCOUNTS[0].good), { mode: 0o600 });
  const hub = await spawnHub(sc, { env: { ...ACCOUNTS[0].env(), ANTHROPIC_API_KEY: CLAUDE_KEY } });
  try {
    await hub.ready;
    const acc = (await get(hub, '/claude')).body;
    assert.equal(acc.keySource, 'hub');
    assert.equal(acc.damaged ?? null, null);
  } finally {
    await hub.stop();
  }
});

test('claude.json damaged and no key anywhere: starting a Claude conversation says the key FILE is damaged (and where the copy is), not "no key is set"', async () => {
  const sc = scratch('claude-damaged-message');
  fs.writeFileSync(sc.file('claude.json'), ACCOUNTS[0].cut, { mode: 0o600 });
  const hub = await spawnHub(sc, { env: ACCOUNTS[0].env() });
  try {
    await hub.ready;
    const [name] = backups(sc, 'claude.json');
    const cwd = path.join(sc.dir, 'project');
    fs.mkdirSync(cwd);
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'claude', cwd, prompt: 'hello' }) });
    const body = await r.json();
    assert.ok(r.status >= 400, `refused (${r.status}): ${JSON.stringify(body)}`);
    assert.match(body.error, /損壞/);
    assert.ok(body.error.includes(path.join(BAK(sc), name)), `says where the copy is: ${body.error}`);
    assert.doesNotMatch(body.error, /還沒有設定/, 'not the message for a person who never set a key');
    const models = await fetch(`http://127.0.0.1:${hub.port}/api/models`).then((x) => x.json());
    const claude = models.groups.find((g) => g.provider === 'claude');
    assert.match(claude.reason || '', /損壞/, 'the model catalog says why Claude is unavailable');
  } finally {
    await hub.stop();
  }
});

test('deepseek.json damaged: starting a DeepSeek conversation says the pool FILE is damaged, not "no key is set"', async () => {
  const sc = scratch('deepseek-damaged-message');
  fs.writeFileSync(sc.file('deepseek.json'), ACCOUNTS[1].cut, { mode: 0o600 });
  const hub = await spawnHub(sc, { env: ACCOUNTS[1].env() });
  try {
    await hub.ready;
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', machineId: 'm_any', cwd: '/tmp', prompt: 'hello' }) });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(body.error, /損壞/);
    assert.match(body.error, /deepseek\.json/);
    assert.doesNotMatch(body.error, /還沒有設定/);
  } finally {
    await hub.stop();
  }
});

test('deepseek.json damaged: the other ways a pool changes (activate, remove, clear, another gateway) never write the file', async () => {
  const sc = scratch('deepseek-damaged-ops');
  fs.writeFileSync(sc.file('deepseek.json'), ACCOUNTS[1].cut, { mode: 0o600 });
  const hub = await spawnHub(sc, { env: ACCOUNTS[1].env() });
  try {
    await hub.ready;
    // The pool in memory is empty: there is no key to activate or remove, and
    // choosing another gateway is a save of something that is not the key.
    for (const [body, refused] of [[{ activateKeyId: 'k1' }, true], [{ removeKeyId: 'k1' }, true], [{ clearKey: true }, false], [{ gateway: 'opencode' }, true]]) {
      const r = await put(hub, '/deepseek', body);
      if (refused) assert.ok(r.status >= 400, `${JSON.stringify(body)} is refused (${r.status})`);
      assert.ok(same(sc.file('deepseek.json'), ACCOUNTS[1].cut), `untouched after ${JSON.stringify(body)}`);
    }
    assert.equal((await put(hub, '/deepseek', { gateway: 'opencode' })).body.error.includes('損壞'), true, 'and says why');
  } finally {
    await hub.stop();
  }
});
