// Spec §12.1/§12.2: the page never tells anyone the Hub "can only look", to
// unlock, to type /web in their Kimi, or to switch to kimi-hub before the Hub
// can operate a conversation (terminal and Hub always operate side by side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const files = [...fs.readdirSync(path.join(PUBLIC, 'js')).map((f) => path.join('js', f)), 'index.html'].filter((f) => /\.(js|html)$/.test(f));

const FORBIDDEN = [
  [/只能看/, '"只能看" (the Hub is not read-only)'],
  [/唯讀/, '"唯讀"'],
  [/解鎖|解除鎖定/, 'an unlock step'],
  [/輸入 \/web|執行 kimi web/, 'asking the person to run /web or kimi web'],
  [/改用 kimi-hub/, 'asking the person to switch to kimi-hub'],
];

test('no page text asks for /web, kimi-hub, an unlock, or says the Hub can only look', () => {
  assert.ok(files.length >= 8, 'found the page sources');
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const [re, what] of FORBIDDEN) {
      const m = text.match(re);
      if (m) hits.push(`${f}: ${what} → …${text.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ')}…`);
    }
  }
  assert.deepEqual(hits, []);
});
