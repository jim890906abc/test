// What changed between two JSON values, and how to put it back: the pair that
// lets the Hub send a page the difference between the cluster it last sent and
// the one it has now (a cluster is 5-35 KB; between two pushes a second apart a
// few numbers moved), and the page rebuild the whole from what it kept.
//
// Used by the server (server/page-push.js, to make the patch) and by the page
// (app.js, to apply it), so the two cannot disagree about the format.
//
// A patch is a node, one of:
//   { s: value }                  the value is this, replacing whatever was there
//   { o: { key: node, ... },      an object: each key named in `o` is patched
//     d: [key, ...] }             (`o` and `d` are each left out when empty), the keys in `d` are gone
//   { a: { index: node, ... },    an array of the same kind: each index named is patched,
//     l: length }                 and the array is `l` long (shorter: cut; longer: the new items come as { s })
// `diff` returns undefined where there is nothing to say. Only JSON values (no
// undefined, no functions, no cycles) go in; `apply` never changes what it is
// given, but what did not change is shared with it, not copied.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SAME = Symbol('same');
// A key called __proto__ (JSON.parse makes it an ordinary key) must not become the object's prototype.
const put = (obj, key, value) => (key === '__proto__' ? Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true }) : (obj[key] = value));

function nodeOf(a, b) {
  if (a === b) return SAME;
  if (Array.isArray(a) && Array.isArray(b)) {
    const patched = {};
    let any = false;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) {
        patched[i] = { s: b[i] };
        any = true;
        continue;
      }
      if (i >= b.length) break;
      const x = nodeOf(a[i], b[i]);
      if (x !== SAME) {
        patched[i] = x;
        any = true;
      }
    }
    if (!any && a.length === b.length) return SAME;
    return { a: patched, l: b.length };
  }
  if (isObject(a) && isObject(b)) {
    const o = {};
    const d = [];
    let any = false;
    for (const k of Object.keys(b)) {
      if (!Object.hasOwn(a, k)) {
        put(o, k, { s: b[k] });
        any = true;
        continue;
      }
      const x = nodeOf(a[k], b[k]);
      if (x !== SAME) {
        put(o, k, x);
        any = true;
      }
    }
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) d.push(k);
    if (!any && !d.length) return SAME;
    return { ...(any ? { o } : {}), ...(d.length ? { d } : {}) };
  }
  // Two different primitives, or a value that changed kind.
  return { s: b };
}

export function diff(before, after) {
  const node = nodeOf(before, after);
  return node === SAME ? undefined : node;
}

export function apply(base, node) {
  if (node === undefined) return base;
  if ('s' in node) return node.s;
  if ('a' in node) {
    const out = Array.isArray(base) ? base.slice(0, node.l) : [];
    for (const [i, sub] of Object.entries(node.a)) out[Number(i)] = apply(base?.[Number(i)], sub);
    return out;
  }
  const out = isObject(base) ? { ...base } : {};
  for (const k of node.d || []) delete out[k];
  for (const [k, sub] of Object.entries(node.o || {})) put(out, k, apply(isObject(base) ? base[k] : undefined, sub));
  return out;
}
