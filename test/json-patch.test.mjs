// The difference between two JSON values and putting it back (public/js/json-patch.js):
// the Hub sends a page what changed in a cluster instead of the whole cluster,
// and the page must end with exactly the cluster the Hub has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, diff } from '../public/js/json-patch.js';

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random JSON value of limited depth: objects, arrays, strings, numbers, booleans, null, and the awkward keys.
function value(r, depth = 0) {
  const k = r();
  if (depth > 3 || k < 0.35) return [null, true, false, 0, -1, 1.5, 'x', '', 'a longer string', 7][Math.floor(r() * 10)];
  const KEYS = ['id', 'a', 'b', 'c', 'workers', 'speed', 'n', '0', '__proto__', 's', 'o', 'd', 'l'];
  if (k < 0.7) {
    const o = {};
    for (let i = Math.floor(r() * 5); i > 0; i--) Object.defineProperty(o, KEYS[Math.floor(r() * KEYS.length)], { value: value(r, depth + 1), enumerable: true, writable: true, configurable: true });
    return o;
  }
  return Array.from({ length: Math.floor(r() * 5) }, () => value(r, depth + 1));
}
// A copy with a few random edits: the second state of the same thing.
function edit(r, v) {
  if (r() < 0.12) return value(r, 2);
  if (Array.isArray(v)) {
    const out = v.map((x) => (r() < 0.5 ? edit(r, x) : x));
    if (r() < 0.25) out.pop();
    if (r() < 0.25) out.push(value(r, 3));
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (r() < 0.12) continue;
      Object.defineProperty(out, k, { value: r() < 0.5 ? edit(r, v[k]) : v[k], enumerable: true, writable: true, configurable: true });
    }
    if (r() < 0.3) Object.defineProperty(out, ['id', 'zz', '__proto__'][Math.floor(r() * 3)], { value: value(r, 3), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return r() < 0.5 ? value(r, 3) : v;
}

test('applying the difference of two values to the first gives the second, over many random pairs', () => {
  const r = rng(2026);
  let patched = 0;
  for (let i = 0; i < 4000; i++) {
    const a = value(r);
    const b = r() < 0.15 ? value(r) : edit(r, a);
    const snapshotA = JSON.stringify(a);
    const patch = diff(a, b);
    // Over the wire and back, as it travels.
    const wire = patch === undefined ? undefined : JSON.parse(JSON.stringify(patch));
    const got = apply(JSON.parse(snapshotA), wire);
    assert.deepStrictEqual(got, b, `pair ${i}: ${snapshotA} -> ${JSON.stringify(b)} by ${JSON.stringify(patch)}`);
    assert.equal(JSON.stringify(a), snapshotA, 'the value that was diffed is untouched');
    if (patch !== undefined) patched++;
  }
  assert.ok(patched > 1500, `a good share of the pairs really differ (${patched} of 4000)`);
});

test('nothing changed is no patch, and a patch applied changes neither of the values it was made from', () => {
  const a = { id: 'c_1', workers: [{ id: 'w1', n: 1 }, { id: 'w2', n: 2 }], speed: { tps: 3.5 } };
  assert.equal(diff(a, structuredClone(a)), undefined);
  const b = structuredClone(a);
  b.workers[1].n = 5;
  const patch = diff(a, b);
  const frozenA = JSON.stringify(a);
  const patchJson = JSON.stringify(patch);
  const result = apply(a, patch);
  assert.deepEqual(result, b);
  assert.equal(JSON.stringify(a), frozenA, 'apply does not change its base');
  assert.equal(JSON.stringify(patch), patchJson, 'apply does not change the patch');
  // What did not move is not sent.
  assert.deepEqual(patch, { o: { workers: { a: { 1: { o: { n: { s: 5 } } } }, l: 2 } } });
});

test('a key that is gone, an array that got shorter or longer, a value that changed kind, and null all come out right', () => {
  const cases = [
    [{ a: 1, b: 2 }, { a: 1 }],
    [{ a: [1, 2, 3] }, { a: [1] }],
    [{ a: [1] }, { a: [1, { x: 1 }, [2]] }],
    [{ a: { x: 1 } }, { a: [1] }],
    [{ a: [1] }, { a: null }],
    [{ a: null }, { a: { b: null } }],
    [[], [{}]],
    [{}, []],
    ['x', 'y'],
    [{ a: 1 }, { a: 1, b: undefined === 1 }],
  ];
  for (const [a, b] of cases) assert.deepEqual(apply(a, JSON.parse(JSON.stringify(diff(a, b) ?? null)) ?? undefined), b);
});

test('a key called __proto__ stays an ordinary key', () => {
  const a = JSON.parse('{"x":1}');
  const b = JSON.parse('{"x":1,"__proto__":{"polluted":true}}');
  const out = apply(a, JSON.parse(JSON.stringify(diff(a, b))));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(out, '__proto__'), true);
});
