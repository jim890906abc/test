// A tar.gz written without any tool outside Node: the Hub's side of a purge
// backup (the conversation files and the cluster's record) must not depend on
// a `tar` being installed wherever the Hub runs. ustar format, regular files
// only, streamed (a conversation file can be large, so nothing is read whole).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BLOCK = 512;

function octal(value, width) {
  const s = Math.floor(value).toString(8);
  if (s.length > width - 1) throw new Error(`tar: ${value} does not fit in ${width} bytes`);
  return `${s.padStart(width - 1, '0')}\0`;
}

// ustar splits a long name into a prefix (up to 155) and a name (up to 100) at a slash.
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return { name: rest, prefix };
  }
  throw new Error(`tar: name too long: ${name}`);
}

export function tarHeader(name, size, { mtime = Date.now(), mode = 0o600 } = {}) {
  const h = Buffer.alloc(BLOCK, 0);
  const { name: n, prefix } = splitName(name);
  h.write(n, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // the checksum is summed over spaces
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

// entries: [{ name, file } | { name, data }]. A `file` is read as it is when the
// entry is reached; its size is taken then (the header needs it first).
// Resolves to the size of the archive written.
export async function writeTarGz(target, entries) {
  async function* parts() {
    for (const e of entries) {
      if (e.data !== undefined) {
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
        yield tarHeader(e.name, data.length, e);
        yield data;
        if (data.length % BLOCK) yield Buffer.alloc(BLOCK - (data.length % BLOCK), 0);
        continue;
      }
      // The size the header promises is the size that is written: read the file once into the stream and stop at it.
      const st = fs.statSync(e.file);
      yield tarHeader(e.name, st.size, { mtime: st.mtimeMs, ...e });
      let sent = 0;
      for await (const chunk of fs.createReadStream(e.file, { end: Math.max(0, st.size - 1) })) {
        if (!st.size) break;
        yield chunk;
        sent += chunk.length;
      }
      if (sent !== st.size) throw new Error(`tar: ${e.file} changed while it was read`);
      if (st.size % BLOCK) yield Buffer.alloc(BLOCK - (st.size % BLOCK), 0);
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  const out = fs.createWriteStream(target, { mode: 0o600 });
  await pipeline(Readable.from(parts()), zlib.createGzip(), out);
  return fs.statSync(target).size;
}
