// Which tool calls write an Artifact page, and what page that makes. One rule,
// used in two places that must never disagree:
//   - the page (artifacts.js: the Artifact panel, from the events it holds), and
//   - the Hub (server/artifact-index.js: the list it sends for the part of a
//     conversation the page does not hold, because the Hub only sends the
//     newest window; and what it answers when a version is opened).
// No DOM here: it runs in Node as well.

export const ARTIFACT_TOOL = /^(Write|Edit|MultiEdit|WriteFile|StrReplaceFile)$/;

export const isHtmlPath = (p) => /\.html?$/i.test(String(p || ''));

// Decode the body of a JSON string that may be cut off mid-stream.
export function decodePartial(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) return out;
    i++;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'u') {
      const hex = s.slice(i + 1, i + 5);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

export function partialField(text, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text || '');
  return m ? decodePartial(text.slice(m.index + m[0].length)) : null;
}

// The artifact a tool event writes, if any: { path, kind, content? }.
export function artifactOf(ev) {
  if (ev.type !== 'tool_use' || !ARTIFACT_TOOL.test(ev.name)) return null;
  const input = ev.input && typeof ev.input === 'object' ? ev.input : null;
  const path = input?.path || input?.file_path || partialField(ev.argsText, 'path') || partialField(ev.argsText, 'file_path');
  if (!isHtmlPath(path)) return null;
  const write = /Write/.test(ev.name);
  let content = null;
  if (write) content = typeof input?.content === 'string' ? input.content : partialField(ev.argsText, 'content');
  return { path, kind: write ? 'write' : 'edit', content, input, append: input?.mode === 'append' };
}

export function applyEdits(base, input) {
  if (base == null || !input) return null;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  let out = base;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || !out.includes(e.old_string)) return null;
    out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string);
  }
  return out;
}

const baseName = (p) => String(p || '').split('/').pop();

export const htmlTitle = (html, path) => (html && /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()) || baseName(path);

// One version of a page: what the page looks like after tool event `ev`
// (whose artifact is `a`), given the page before it (`prev`, null when that is
// not known: an Edit then has nothing to apply to).
export function nextVersion(prev, ev, a) {
  let html = null;
  if (a.kind === 'write') html = a.append ? (prev ?? '') + (a.content ?? '') : a.content;
  else if (['done', 'running'].includes(ev.status)) html = applyEdits(prev, a.input);
  else html = prev;
  const streaming = ev.status === 'pending' || (ev.status === 'running' && !ev.input);
  return { id: ev.id, html, streaming, failed: ev.status === 'error', kind: a.kind, append: Boolean(a.append) };
}

// All artifacts in a session, oldest first, each with its versions. A
// version's html is null when it can only be read from disk (an Edit whose
// base we never saw).
export function collectArtifacts(events) {
  const byPath = new Map();
  for (const ev of events) {
    const a = artifactOf(ev);
    if (!a) continue;
    let art = byPath.get(a.path);
    if (!art) byPath.set(a.path, (art = { path: a.path, versions: [] }));
    art.versions.push(nextVersion(art.versions.at(-1)?.html ?? null, ev, a));
  }
  for (const art of byPath.values()) {
    const v = art.versions.filter((x) => !x.failed);
    art.title = htmlTitle(v.at(-1)?.html, art.path);
    art.updated = art.versions.at(-1).id;
  }
  return [...byPath.values()];
}

// ------------------------------------------------- the list for the Hub to send

// What one artifact event contributes to the list, or null. Enough to put the
// version in its place and to replay it; never the content itself.
export function indexEntry(ev) {
  const a = artifactOf(ev);
  if (!a) return null;
  const entry = { path: a.path, eventId: ev.id, ts: ev.ts, kind: a.kind, status: ev.status };
  if (a.append) entry.append = true;
  // The title of a page is in the Write that made it; the page itself shows it
  // from the version it holds, this is for the list of pages the page does not hold.
  const title = a.kind === 'write' && typeof a.content === 'string' ? /<title[^>]*>([^<]*)<\/title>/i.exec(a.content)?.[1]?.trim() : '';
  if (title) entry.title = title;
  return entry;
}

// The entries of a list of events, in the order given.
export function artifactIndex(events) {
  const out = [];
  for (const ev of events) {
    const e = indexEntry(ev);
    if (e) out.push(e);
  }
  return out;
}

// What page version `eventId` of `path` is, from all events of the
// conversation: { html } (null when it cannot be derived: an Edit whose base
// was never a Write in this conversation), or null when there is no such version.
export function replayVersion(events, path, eventId) {
  let prev = null;
  for (const ev of events) {
    const a = artifactOf(ev);
    if (!a || a.path !== path) continue;
    const v = nextVersion(prev, ev, a);
    if (ev.id === eventId) return { path, eventId, html: v.html ?? null, streaming: v.streaming, failed: v.failed };
    prev = v.html;
  }
  return null;
}

// ------------------------------------------------- the page puts the two together

// The artifacts of the events the page holds (`local`, from collectArtifacts)
// with the versions it does not hold filled in from the Hub's list (`entries`):
// per path, versions in the order of the whole conversation; a version the
// page holds keeps its content, one it does not is a stand-in
// ({ id, html: null, failed, remote: true }) to be fetched when opened.
// `partial` marks a page some of whose versions are stand-ins.
export function mergeArtifactIndex(local, entries) {
  if (!Array.isArray(entries) || !entries.length) return local;
  const held = new Map();
  for (const art of local) for (const v of art.versions) held.set(v.id, v);
  const order = [];
  const byPath = new Map();
  const ensure = (path) => {
    let art = byPath.get(path);
    if (!art) {
      art = { path, versions: [], titleFromHub: '' };
      byPath.set(path, art);
      order.push(art);
    }
    return art;
  };
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || typeof e.eventId !== 'string' || seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    const art = ensure(e.path);
    if (e.title) art.titleFromHub = e.title;
    art.versions.push(held.get(e.eventId) || { id: e.eventId, html: null, streaming: false, failed: e.status === 'error', remote: true });
  }
  // What the page holds and the list has not heard of yet (it arrived after the list was made).
  for (const art of local) {
    const target = ensure(art.path);
    for (const v of art.versions) if (!seen.has(v.id)) target.versions.push(v);
  }
  for (const art of order) {
    // The first version held was made from nothing, but something came before
    // it: an Edit then has no content (it is null), an append would show only
    // what it appended, and so would everything made from that. Until a
    // Write that starts the page afresh, what is held does not know its
    // content: the Hub replays it.
    if (art.versions[0]?.remote) {
      let unknown = true;
      art.versions = art.versions.map((v) => {
        if (v.remote) return v;
        if (!v.failed && v.kind === 'write' && !v.append) unknown = false;
        return unknown && v.html != null ? { ...v, html: null } : v;
      });
    }
    const ok = art.versions.filter((x) => !x.failed);
    const last = ok.at(-1);
    art.partial = art.versions.some((v) => v.remote);
    art.title = last?.html ? htmlTitle(last.html, art.path) : art.titleFromHub || baseName(art.path);
    art.updated = art.versions.at(-1).id;
    delete art.titleFromHub;
  }
  return order;
}
