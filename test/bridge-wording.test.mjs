// Spec 12: a terminal Kimi and the hub work side by side. The connector's
// messages (log lines, errors the hub shows) must not say the hub can only
// look, ask the user to type /web, or to restart Kimi through kimi-hub before
// anything can be done - that rule is gone. A static check of the strings the
// connector can show, comments excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const source = fs.readFileSync(path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'utf8');
const shown = source
  .split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));

test('no message tells the user the hub is read-only or that /web or kimi-hub is needed to operate', () => {
  const banned = [/唯讀/, /只能看/, /不能操作/, /輸入 \/web[^」]*(才|交給|操作)/, /請在 Kimi 裡輸入 \/web/, /改用 kimi-hub/, /要從中控台(送訊息|操作)[^。]*(\/web|kimi-hub)/];
  const hits = shown.filter(({ line }) => banned.some((re) => re.test(line))).map(({ line, n }) => `${n}: ${line.trim().slice(0, 100)}`);
  assert.deepEqual(hits, []);
});

test('what it says instead: the terminal keeps working and the hub operates through Kimi\'s server', () => {
  const text = shown.map((s) => s.line).join('\n');
  assert.match(text, /中控台會改經 Kimi 伺服器操作這個對話/);
  assert.match(text, /終端機與中控台並存/);
  assert.match(text, /不需要關閉終端機/);
});
