// A config file that cannot be parsed is evidence, not something to start over
// from in silence. hub.json (the login token + the bridge key every connected
// computer holds), machines.json (the registered computers) and
// claude-deleted.json (conversations that must stay deleted) are, when
// damaged, copied byte for byte into <data>/damaged-config/<name>.<ms>
// (private, never over an existing copy, reused for the same bytes) and the
// start says so in plain words — instead of the old behaviour of generating a
// new token and bridge key without a word (every connected computer cut off,
// the user locked out of what they had written down) or of starting with no
// computers at all. A file that cannot be READ is not "damaged": nothing is
// written over it. Every test runs the REAL Hub as a child process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, scratch, spawnHub, connectMachine, readJson, waitFor } from './fixtures/hub-process.mjs';

after(cleanup);

const BAK = (sc) => path.join(sc.data, 'damaged-config');
const backups = (sc, name) => (fs.existsSync(BAK(sc)) ? fs.readdirSync(BAK(sc)).filter((f) => f.startsWith(`${name}.`) && /^\d+$/.test(f.slice(name.length + 1))) : []);
const mode = (f) => fs.statSync(f).mode & 0o777;

// What a crash, a bad disk or a careless editor leaves behind.
const DAMAGED = {
  'cut in the middle': Buffer.from('{\n  "token": "0123456789abcdef0123456789abcdef",\n  "bridgeKey": "bk_'),
  'empty': Buffer.alloc(0),
  'zero-filled (blocks that never reached the disk)': Buffer.alloc(96),
  'not JSON at all': Buffer.from('<<<<<<< HEAD\nthe merge went wrong\n'),
  'JSON, but null': Buffer.from('null'),
  'JSON, but an array': Buffer.from('[1, 2]'),
};

// ------------------------------------------------------------ hub.json

for (const [what, bytes] of Object.entries(DAMAGED)) {
  test(`hub.json damaged (${what}): kept byte for byte in damaged-config, said out loud, then new secrets that work`, async () => {
    const sc = scratch('hub-damaged');
    fs.writeFileSync(sc.file('hub.json'), bytes, { mode: 0o600 });
    const hub = await spawnHub(sc);
    try {
      await hub.ready;
      const [name, ...more] = backups(sc, 'hub.json');
      assert.ok(name && !more.length, `exactly one copy of the damaged file is kept (${backups(sc, 'hub.json')})`);
      assert.ok(fs.readFileSync(path.join(BAK(sc), name)).equals(bytes), 'the copy is the damaged file, byte for byte');
      assert.equal(mode(path.join(BAK(sc), name)), 0o600, 'the copy is private');
      assert.equal(mode(BAK(sc)), 0o700, 'the folder is private');

      const fresh = readJson(sc.file('hub.json'));
      assert.match(fresh.token, /^[0-9a-f]{32}$/);
      assert.match(fresh.bridgeKey, /^bk_[0-9a-f]{36}$/);
      assert.equal(mode(sc.file('hub.json')), 0o600);
      assert.notEqual(fresh.bridgeKey, 'bk_', 'a new key, not a piece of the old one');

      const log = hub.out();
      assert.match(log, /hub\.json/);
      assert.match(log, /損壞/);
      assert.ok(log.includes(path.join(BAK(sc), name)), `the warning says where the copy is\n${log}`);
      assert.match(log, /重連|重新連接/, 'it says every connected computer has to be reconnected');

      const info = await hub.api('/hub', { token: fresh.token });
      assert.equal(info.bridgeKey, fresh.bridgeKey, 'the Hub is using the secrets it wrote down');
    } finally {
      await hub.stop();
    }
  });
}

test('hub.json fine: left exactly as it is, nothing copied, nothing warned (control for the damage check)', async () => {
  const sc = scratch('hub-fine');
  // Written by hand: if the Hub rewrote it, the spacing would change.
  const text = '{"token":"tok-hand-written","bridgeKey":"bk_hand_written_key"}';
  fs.writeFileSync(sc.file('hub.json'), text, { mode: 0o600 });
  const hub = await spawnHub(sc);
  try {
    await hub.ready;
    assert.equal(fs.readFileSync(sc.file('hub.json'), 'utf8'), text);
    assert.equal(fs.existsSync(BAK(sc)), false, 'no damaged-config folder for a fine file');
    assert.doesNotMatch(hub.out(), /損壞/);
    assert.equal((await hub.api('/hub', { token: 'tok-hand-written' })).bridgeKey, 'bk_hand_written_key');
  } finally {
    await hub.stop();
  }
});

test('hub.json damaged but both secrets come from the environment: nothing is generated, the file is not touched, the env values are used', async () => {
  const sc = scratch('hub-env');
  const bytes = DAMAGED['cut in the middle'];
  fs.writeFileSync(sc.file('hub.json'), bytes, { mode: 0o600 });
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'tok-from-env', AGENT_HUB_BRIDGE_KEY: 'bk_from_env' } });
  try {
    await hub.ready;
    assert.ok(fs.readFileSync(sc.file('hub.json')).equals(bytes), 'no new secrets were written over it');
    assert.equal(backups(sc, 'hub.json').length, 1, 'but the damage is still kept as evidence');
    assert.match(hub.out(), /損壞/);
    assert.doesNotMatch(hub.out(), /重連|重新連接/, 'no key changed, so nobody has to reconnect');
    assert.equal((await hub.api('/hub')).bridgeKey, 'bk_from_env');
    assert.equal((await hub.api('/hub', { token: 'wrong' })).error?.includes('token'), true);
  } finally {
    await hub.stop();
  }
});

test('hub.json damaged and only the token comes from the environment: only the bridge key is generated', async () => {
  const sc = scratch('hub-env-token');
  fs.writeFileSync(sc.file('hub.json'), DAMAGED['not JSON at all'], { mode: 0o600 });
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'tok-from-env' } });
  try {
    await hub.ready;
    const fresh = readJson(sc.file('hub.json'));
    assert.match(fresh.bridgeKey, /^bk_[0-9a-f]{36}$/);
    assert.equal('token' in fresh, false, 'the login token is the environment\'s, not generated');
    assert.match(hub.out(), /重連|重新連接/, 'the bridge key did change');
    assert.equal((await hub.api('/hub')).bridgeKey, fresh.bridgeKey);
  } finally {
    await hub.stop();
  }
});

test('the same damaged bytes are kept once however often the Hub starts; different damage is kept as well and the first copy is never overwritten', async () => {
  const sc = scratch('hub-reuse');
  const env = { AGENT_HUB_TOKEN: 'tok-env', AGENT_HUB_BRIDGE_KEY: 'bk_env' }; // the damaged file stays in place
  const first = DAMAGED['cut in the middle'];
  fs.writeFileSync(sc.file('hub.json'), first);
  for (let i = 0; i < 3; i++) {
    const hub = await spawnHub(sc, { env });
    await hub.ready;
    await hub.stop();
  }
  assert.equal(backups(sc, 'hub.json').length, 1, 'three starts, one copy');
  const [name] = backups(sc, 'hub.json');

  const second = Buffer.from('some other kind of damage');
  fs.writeFileSync(sc.file('hub.json'), second);
  const hub = await spawnHub(sc, { env });
  await hub.ready;
  await hub.stop();
  assert.equal(backups(sc, 'hub.json').length, 2);
  assert.ok(fs.readFileSync(path.join(BAK(sc), name)).equals(first), 'the first copy still holds the first damage');
});

// Two ways to be unreadable: a folder (nothing could be put in its place), and a
// link to itself (a rename WOULD replace it: the Hub must not).
const UNREADABLE = { 'a folder': (f) => fs.mkdirSync(f), 'a link to itself': (f) => fs.symlinkSync(path.basename(f), f) };
const stillThere = (f) => fs.lstatSync(f).isDirectory() || fs.lstatSync(f).isSymbolicLink();
for (const [what, make] of Object.entries(UNREADABLE)) {
  test(`hub.json that cannot be read (${what}): the Hub does not start and writes nothing over it; with both secrets from the environment it does not need it`, async () => {
    const sc = scratch('hub-unreadable');
    make(sc.file('hub.json'));
    const before = fs.lstatSync(sc.file('hub.json')).ino;
    const hub = await spawnHub(sc);
    const end = await hub.stopsWithin();
    assert.notEqual(end.code, 0);
    assert.match(hub.out(), /hub\.json/);
    assert.match(hub.out(), /讀不到/);
    assert.ok(stillThere(sc.file('hub.json')) && fs.lstatSync(sc.file('hub.json')).ino === before, 'still what it was, not replaced');
    assert.equal(fs.existsSync(BAK(sc)), false);

    const env = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'tok-env', AGENT_HUB_BRIDGE_KEY: 'bk_env' } });
    try {
      await env.ready;
      assert.equal((await env.api('/hub')).bridgeKey, 'bk_env');
      assert.ok(stillThere(sc.file('hub.json')) && fs.lstatSync(sc.file('hub.json')).ino === before);
    } finally {
      await env.stop();
    }
  });
}

test('hub.json damaged but it cannot be copied away: the Hub does not overwrite the only copy and does not start', async () => {
  const sc = scratch('hub-nocopy');
  const bytes = DAMAGED['cut in the middle'];
  fs.writeFileSync(sc.file('hub.json'), bytes);
  fs.writeFileSync(BAK(sc), 'a file where the folder for the copies should be');
  const hub = await spawnHub(sc);
  const end = await hub.stopsWithin();
  assert.notEqual(end.code, 0);
  assert.match(hub.out(), /備份/);
  assert.ok(fs.readFileSync(sc.file('hub.json')).equals(bytes), 'the damaged file is untouched');
});

// -------------------------------------------------------- machines.json

const FINE_MACHINES = [
  { id: 'm_a', name: '電腦甲', platform: 'linux', home: '/home/a', lastSeen: 1000, capabilities: ['pool'] },
  { id: 'm_b', name: '電腦乙', platform: 'darwin', home: '/Users/b', lastSeen: 2000, capabilities: [] },
];

test('machines.json fine: the registered computers are there (control for the damage check) and nothing is copied or warned', async () => {
  const sc = scratch('machines-fine');
  fs.writeFileSync(sc.file('machines.json'), JSON.stringify(FINE_MACHINES, null, 2));
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  try {
    await hub.ready;
    const list = await hub.api('/machines');
    assert.deepEqual(list.map((m) => m.id).sort(), ['m_a', 'm_b']);
    assert.equal(fs.existsSync(BAK(sc)), false);
    assert.doesNotMatch(hub.out(), /損壞/);
  } finally {
    await hub.stop();
  }
});

for (const [what, bytes] of Object.entries({ ...DAMAGED, 'JSON, but an object': Buffer.from('{"m_a":{"name":"x"}}') })) {
  if (what === 'JSON, but an array') continue; // an array is what machines.json is
  test(`machines.json damaged (${what}): kept byte for byte in damaged-config and said out loud; the Hub still starts`, async () => {
    const sc = scratch('machines-damaged');
    fs.writeFileSync(sc.file('machines.json'), bytes);
    const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
    try {
      await hub.ready;
      const [name, ...more] = backups(sc, 'machines.json');
      assert.ok(name && !more.length, `one copy (${backups(sc, 'machines.json')})`);
      assert.ok(fs.readFileSync(path.join(BAK(sc), name)).equals(bytes), 'the copy is the damaged file, byte for byte');
      assert.equal(mode(path.join(BAK(sc), name)), 0o600);
      assert.deepEqual(await hub.api('/machines'), [], 'no computers are made up');
      const log = hub.out();
      assert.match(log, /machines\.json/);
      assert.match(log, /損壞/);
      assert.ok(log.includes(path.join(BAK(sc), name)), `the warning says where the copy is\n${log}`);
    } finally {
      await hub.stop();
    }
  });
}

test('machines.json with some entries that are not computers: the good ones are loaded, the file is kept as it was, and it is said', async () => {
  const sc = scratch('machines-partial');
  const bytes = Buffer.from(JSON.stringify([FINE_MACHINES[0], null, { name: '沒有 id' }, 'text', FINE_MACHINES[1]]));
  fs.writeFileSync(sc.file('machines.json'), bytes);
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  try {
    await hub.ready;
    assert.deepEqual((await hub.api('/machines')).map((m) => m.id).sort(), ['m_a', 'm_b']);
    const [name] = backups(sc, 'machines.json');
    assert.ok(name && fs.readFileSync(path.join(BAK(sc), name)).equals(bytes));
    assert.match(hub.out(), /machines\.json/);
  } finally {
    await hub.stop();
  }
});

test('machines.json damaged: the first computer that connects writes a good file again; the damaged one stays in damaged-config', async () => {
  const sc = scratch('machines-heal');
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 't', bridgeKey: 'bk_test' }), { mode: 0o600 });
  const bytes = DAMAGED['cut in the middle'];
  fs.writeFileSync(sc.file('machines.json'), bytes);
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  await hub.ready;
  const ws = connectMachine(hub.port, 'bk_test', 'm_new', '新電腦');
  try {
    await waitFor(() => readJson(sc.file('machines.json')).some((m) => m.id === 'm_new'), 'the new computer in machines.json');
    const [name] = backups(sc, 'machines.json');
    assert.ok(fs.readFileSync(path.join(BAK(sc), name)).equals(bytes));
  } finally {
    ws.terminate();
    await hub.stop();
  }
});

test('machines.json that cannot be read (a link to itself): not written over, the Hub keeps running and computers still connect', async () => {
  const sc = scratch('machines-unreadable');
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 't', bridgeKey: 'bk_test' }), { mode: 0o600 });
  // Cannot be read, yet a rename would happily replace it: what the Hub must not do.
  fs.symlinkSync('machines.json', sc.file('machines.json'));
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  await hub.ready;
  const ws = connectMachine(hub.port, 'bk_test', 'm_new', '新電腦');
  try {
    await waitFor(async () => (await hub.api('/machines')).some((m) => m.id === 'm_new' && m.online), 'the computer online');
    assert.ok(fs.lstatSync(sc.file('machines.json')).isSymbolicLink(), 'still the file it was');
    assert.match(hub.out(), /machines\.json/);
    assert.match(hub.out(), /讀不到/);
    assert.equal(hub.proc.exitCode, null, 'the Hub is still running');
  } finally {
    ws.terminate();
    await hub.stop();
  }
});

test('machines.json that cannot be written: said, and the Hub does not go down with it', async () => {
  const sc = scratch('machines-unwritable');
  fs.writeFileSync(sc.file('hub.json'), JSON.stringify({ token: 't', bridgeKey: 'bk_test' }), { mode: 0o600 });
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  await hub.ready;
  // The temporary file the Hub will write next to it is a folder: the write fails.
  fs.mkdirSync(sc.file(`machines.json.${hub.proc.pid}.tmp`));
  const ws = connectMachine(hub.port, 'bk_test', 'm_new', '新電腦');
  try {
    await waitFor(async () => (await hub.api('/machines')).some((m) => m.id === 'm_new' && m.online), 'the computer online');
    await waitFor(() => /沒寫進/.test(hub.out()), 'the failure to be said');
    assert.match(hub.out(), /machines\.json/);
    assert.equal(hub.proc.exitCode, null, 'the Hub is still running');
  } finally {
    ws.terminate();
    await hub.stop();
  }
});

// ----------------------------------------------------- claude-deleted.json

test('claude-deleted.json damaged: kept in damaged-config and said out loud, with what it means for the sidebar', async () => {
  const sc = scratch('gone-damaged');
  const bytes = Buffer.from('{"c_1":"m_x","c_2":');
  fs.writeFileSync(sc.file('claude-deleted.json'), bytes);
  const hub = await spawnHub(sc, { env: { AGENT_HUB_TOKEN: 'none' } });
  try {
    await hub.ready;
    const [name, ...more] = backups(sc, 'claude-deleted.json');
    assert.ok(name && !more.length);
    assert.ok(fs.readFileSync(path.join(BAK(sc), name)).equals(bytes));
    const log = hub.out();
    assert.match(log, /claude-deleted\.json/);
    assert.match(log, /損壞/);
    assert.match(log, /重新出現/, 'deleted conversations may come back from their daemon: said so');
  } finally {
    await hub.stop();
  }
});
