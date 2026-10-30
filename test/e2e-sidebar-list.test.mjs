// The sidebar's list against a REAL Hub that has conversations and cluster
// workers on disk (the synthetic Hub of test/fixtures/perf-hub.mjs, small here):
// GET /api/sessions is unchanged; ?for=sidebar lists the same conversations -
// the workers as stubs, the others without their model and skill lists - and
// GET /api/machines?for=sidebar is the same without the Kimi conversations of
// the workers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPerfHub } from './fixtures/perf-hub.mjs';

let hub;
before(async () => {
  hub = await startPerfHub({ conversations: 30, workers: 20, perCluster: 5, activeClusters: 2, machines: 2, native: 30 });
});
after(() => hub?.stop());

const workerIds = () => new Set(hub.made.workers.map((w) => w.id));
const workerNatives = () => new Set(hub.made.workers.map((w) => w.kimiSessionId));

test('GET /api/sessions is unchanged; ?for=sidebar lists the same conversations, workers as stubs and the others without their model and skill lists', async () => {
  const all = await hub.api('GET', '/sessions');
  const side = await hub.api('GET', '/sessions?for=sidebar');
  assert.equal(all.length, 30);
  assert.ok(all.every((s) => !s.stub && !s.slim), 'the plain list is as it always was');
  assert.ok(all.filter((s) => s.clusterRole === 'worker').every((s) => s.meta.models.length && s.meta.skills.length), 'workers whole in the plain list');
  assert.equal(side.length, all.length, 'nothing is missing from the sidebar list');
  assert.deepEqual(side.map((s) => s.id).sort(), all.map((s) => s.id).sort());
  const stubs = side.filter((s) => s.stub);
  assert.deepEqual(stubs.map((s) => s.id).sort(), [...workerIds()].sort(), 'exactly the workers are stubs');
  for (const s of stubs) {
    assert.equal(s.clusterRole, 'worker');
    assert.ok(!('meta' in s) && !('usage' in s) && !('handoff' in s), 'a stub is a few fields');
    assert.ok(JSON.stringify(s).length < 700);
    const whole = all.find((x) => x.id === s.id);
    for (const k of ['title', 'cwd', 'status', 'clusterId', 'machineId', 'kimiSessionId', 'provider', 'conversationId']) assert.equal(s[k], whole[k], `${s.id} ${k}`);
  }
  for (const s of side.filter((x) => !x.stub)) {
    assert.equal(s.slim, true);
    const whole = all.find((x) => x.id === s.id);
    assert.equal(s.meta.models, undefined);
    assert.equal(s.meta.skills, undefined);
    const { meta: m1, slim, ...rest } = s;
    const { meta: m2, ...rest2 } = whole;
    assert.deepEqual(rest, rest2, 'every field but the meta is the same');
    const { models, skills, ...keptMeta } = m2;
    assert.deepEqual(m1, keptMeta, 'and the meta lost only the lists');
  }
  const bytes = async (p) => (await hub.raw(p)).bytes;
  const a = await bytes('/api/sessions');
  const b = await bytes('/api/sessions?for=sidebar');
  assert.ok(b < a / 4, `the sidebar's list is a fraction of the plain one (${b} of ${a} bytes)`);
});

test('GET /api/machines?for=sidebar is the same without the Kimi conversations of cluster workers', async () => {
  const all = await hub.api('GET', '/machines');
  const side = await hub.api('GET', '/machines?for=sidebar');
  const gone = workerNatives();
  assert.deepEqual(side.map((m) => m.id), all.map((m) => m.id));
  let removed = 0;
  for (const m of all) {
    const s = side.find((x) => x.id === m.id);
    assert.deepEqual({ ...s, sessions: undefined }, { ...m, sessions: undefined });
    assert.deepEqual(s.sessions, m.sessions.filter((e) => !gone.has(e.id)));
    removed += m.sessions.length - s.sessions.length;
  }
  assert.equal(removed, 20, 'every worker\'s native conversation, and only those');
});
