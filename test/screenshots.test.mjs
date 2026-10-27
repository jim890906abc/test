// The README's three pictures and the script that retakes them
// (scripts/take-screenshots.mjs). A picture can go wrong without anything
// failing: a blank page, a stale file nobody retook, a path or this computer's
// name showing in it, a README that points at a file that is not there. This
// checks the files, the README, the data the pictures are made from and the
// script's own guard; and, with a Chromium, that a real run produces the same
// three pictures every time.
//
// Skips the part that needs a browser, saying why, when there is no Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, skipReason } from './browser-harness.mjs';
import { MACHINE, MAX_BYTES, SHOTS, TOKEN, demoSessions, guardPage } from '../scripts/take-screenshots.mjs';

const SCRIPT = path.join(ROOT, 'scripts', 'take-screenshots.mjs');
const DOCS = path.join(ROOT, 'docs');
// Strings this file may not write out whole (the repository is scanned for them).
const slashed = (...parts) => ['', ...parts].join('/');

// ------------------------------------------------------------------- PNG

// 8-bit RGB or RGBA, not interlaced: what Chromium writes.
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  const chunks = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString('latin1', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const head = chunks.find((c) => c.type === 'IHDR').data;
  const [width, height, depth, colour, , , interlace] = [head.readUInt32BE(0), head.readUInt32BE(4), head[8], head[9], head[10], head[11], head[12]];
  assert.ok(depth === 8 && (colour === 2 || colour === 6) && interlace === 0, `unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  const bpp = colour === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.equal(raw.length, height * (stride + 1), 'pixel data has the wrong length');
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let add;
      if (f === 0) add = 0;
      else if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (v + add) & 255;
    }
  }
  return { width, height, bpp, px };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// A PNG whose rows cycle through all five filter types, to prove the decoder
// undoes every one of them (the real pictures use 1, 2, 3 and 4).
function encodePng({ width, height, px }) {
  const bpp = 3;
  const stride = width * bpp;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = y % 5;
    out[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let sub;
      if (f === 0) sub = 0;
      else if (f === 1) sub = a;
      else if (f === 2) sub = b;
      else if (f === 3) sub = (a + b) >> 1;
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        sub = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * (stride + 1) + 1 + x] = (px[y * stride + x] - sub) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}

// How much is drawn: how many colours, and how much of the picture is the
// commonest one. A blank page is one colour (share 1); a screenful of
// interface is a flat background (share well under 1) with text and controls
// on it; undone-wrong pixels are noise (a share near 0).
function inspect(png) {
  const { width, height, bpp, px } = decodePng(png);
  const counts = new Map();
  for (let i = 0; i < px.length; i += bpp) {
    const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = Math.max(...counts.values());
  return { width, height, colours: counts.size, dominantShare: top / (width * height) };
}
const looksDrawn = (m) => m.colours >= 64 && m.dominantShare < 0.97 && m.dominantShare > 0.2;

// ---------------------------------------------------------------- the files

test('the PNG reader undoes every filter type, and the "is anything drawn" measure tells blank from a screenful', () => {
  const width = 90;
  const height = 60;
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([(x * 7 + y * 3) & 255, (x * y) & 255, (x ^ y) & 255], (y * width + x) * 3);
  const back = decodePng(encodePng({ width, height, px }));
  assert.ok(back.px.equals(px), 'a round trip through all five filters gives the same pixels back');

  const flat = (rgb) => Buffer.from(Array.from({ length: width * height }, () => rgb).flat());
  assert.equal(looksDrawn(inspect(encodePng({ width, height, px: flat([246, 240, 228]) }))), false, 'a blank page is not a picture');
  // A page drawn all in one colour but for a few stray dots is still blank.
  const dots = flat([246, 240, 228]);
  for (let i = 0; i < 5; i++) dots.set([i * 40, 0, 0], i * 3);
  assert.equal(looksDrawn(inspect(encodePng({ width, height, px: dots }))), false, 'a blank page with a few dots is not a picture');
  assert.equal(looksDrawn(inspect(encodePng({ width, height, px }))), false, 'noise is not a screenful of interface either');
  // Background plus a block of ordinary content.
  const page = flat([246, 240, 228]);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 80; x++) page.set([(x * 5) & 255, (y * 8) & 255, ((x + y) * 3) & 255], (y * width + x) * 3);
  assert.equal(looksDrawn(inspect(encodePng({ width, height, px: page }))), true, 'a background with content on it is');
});

test('the README, the script and docs/ name the same three pictures; each has the right size and is drawn', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const shown = [...readme.matchAll(/\]\(docs\/([A-Za-z0-9_-]+\.png)\)/g)].map((m) => m[1]).sort();
  const wanted = SHOTS.map((s) => s.file).sort();
  assert.deepEqual(shown, wanted, 'the pictures the README shows are the ones the script takes');
  assert.deepEqual(fs.readdirSync(DOCS).filter((f) => f.endsWith('.png')).sort(), wanted, 'docs/ holds those pictures and no stale ones');
  for (const file of wanted) assert.ok(source.includes(`'${file}'`), `${file} is named in the script`);
  assert.ok(readme.includes('scripts/take-screenshots.mjs'), 'the README says how the pictures are retaken');

  for (const shot of SHOTS) {
    const bytes = fs.readFileSync(path.join(DOCS, shot.file));
    const m = inspect(bytes);
    assert.deepEqual([m.width, m.height], [shot.width * shot.scale, shot.height * shot.scale], `${shot.file} has the size the script takes`);
    assert.ok(bytes.length < MAX_BYTES, `${shot.file} is ${(bytes.length / 1024).toFixed(0)} KB (limit ${MAX_BYTES / 1024} KB)`);
    assert.ok(looksDrawn(m), `${shot.file} is a drawn interface (${m.colours} colours, ${(m.dominantShare * 100).toFixed(0)}% in the commonest)`);
  }
});

// ------------------------------------------------------------ the demo data

test('the data the pictures are made from is invented: no local path, no real name, only reserved e-mail domains, nothing fetched from outside', () => {
  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'screenshot-demo', 'orders-dashboard.html'), 'utf8');
  for (const phone of [false, true]) {
    const sessions = demoSessions({ html, phone });
    const blob = JSON.stringify(sessions);
    for (const bad of [slashed('root'), slashed('home', ''), slashed('Users', ''), os.homedir()].filter((x) => x.length > 2)) assert.ok(!blob.includes(bad), `the demo sessions contain ${bad.slice(0, 5)}…`);
    assert.ok(sessions.every((s) => !s.cwd || s.cwd.startsWith(`${MACHINE.home}/`)), 'every folder is under the pretend computer\'s home, which the page shows as ~');
    assert.equal(MACHINE.name, 'my-computer');
    const real = os.hostname().toLowerCase();
    if (real.length >= 4 && real !== MACHINE.name) assert.ok(!blob.toLowerCase().split(/[^a-z0-9_-]+/).includes(real), "this computer's name is not in the demo data");
  }
  const mails = [...html.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]);
  assert.ok(mails.length > 0 && mails.every((d) => /^example\.(com|net|org)$/.test(d)), `the demo dashboard uses only example.com/.net/.org addresses (${mails.join(', ')})`);
  assert.deepEqual(html.match(/(?:https?:)?\/\/[^\s"')<>]+/g) || [], [], 'the demo dashboard loads nothing from outside');
});

test("the script's guard stops a picture that would show a path, the token, a real address, or a request to the outside", async () => {
  const hubUrl = 'http://127.0.0.1:1/';
  const page = (text, resources = [`${hubUrl}js/app.js`]) => ({ eval: async () => JSON.stringify({ text, resources }) });
  await guardPage(page('my-computer · ~/projects/shop-api · amy@example.com · ben@example.net'), hubUrl); // the clean page passes
  const stops = async (text, resources, why) => await assert.rejects(() => guardPage(page(text, resources), hubUrl), new RegExp(why), `${why}: ${text.slice(0, 40)}`);
  await stops(`my-computer · ${slashed('root', 'projects', 'shop-api')}`, undefined, 'must not be in a picture');
  await stops(`${slashed('home', 'someone', 'projects')}`, undefined, 'must not be in a picture');
  await stops(`token ${TOKEN}`, undefined, 'must not be in a picture');
  await stops('write to amy@corp.invalid', undefined, 'e-mail');
  await stops('fine text', [`${hubUrl}js/app.js`, 'https://fonts.example.net/a.css'], 'outside');
  const real = os.hostname();
  if (real.length >= 4 && real !== MACHINE.name) await stops(`ok ${real} ok`, undefined, 'real name');
});

// --------------------------------------------------------------- a real run

function run(out) {
  return spawnSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 280_000 });
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a real run into a scratch folder takes all three pictures at the right size, drawn, and a second run gives the same pictures', { skip: skipReason(), timeout: 600_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-shots-test-'));
  try {
    const dirs = [path.join(tmp, 'first'), path.join(tmp, 'second')];
    for (const dir of dirs) {
      const r = run(dir);
      assert.equal(r.status, 0, `the script exited ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.deepEqual(fs.readdirSync(dir).sort(), SHOTS.map((s) => s.file).sort());
      for (const shot of SHOTS) {
        const bytes = fs.readFileSync(path.join(dir, shot.file));
        const m = inspect(bytes);
        assert.deepEqual([m.width, m.height], [shot.width * shot.scale, shot.height * shot.scale], `${shot.file} size`);
        assert.ok(bytes.length < MAX_BYTES, `${shot.file} is ${(bytes.length / 1024).toFixed(0)} KB`);
        assert.ok(looksDrawn(m), `${shot.file} is drawn (${m.colours} colours, ${(m.dominantShare * 100).toFixed(0)}% in the commonest)`);
      }
    }
    // The same pictures again: byte for byte, or at most a sliver of pixels
    // (a rerun is meant to change nothing unless the front end changed).
    for (const shot of SHOTS) {
      const [a, b] = dirs.map((d) => path.join(d, shot.file));
      if (hash(a) === hash(b)) continue;
      const x = decodePng(fs.readFileSync(a));
      const y = decodePng(fs.readFileSync(b));
      let differing = 0;
      for (let i = 0; i < x.px.length; i += x.bpp) if (x.px[i] !== y.px[i] || x.px[i + 1] !== y.px[i + 1] || x.px[i + 2] !== y.px[i + 2]) differing++;
      assert.ok(differing / (x.width * x.height) < 0.0005, `${shot.file}: ${differing} pixels differ between two runs`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('without --out the script writes into docs/ (checked with --help, so nothing is taken)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--out DIR/);
  assert.match(r.stdout, /docs\/conversation\.png/);
});
