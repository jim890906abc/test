#!/usr/bin/env node
// `npm test`: node --test over every test file, two at a time — and then a look
// at what the tests left running.
//
//   npm test                       every test file
//   npm test -- test/store.test.mjs   only those files (anything after -- goes to node --test)
//
// Before the run it records "now" and the leftovers that already exist; every
// test file is started with test/fixtures/leak-net.mjs preloaded (it ends what
// the file started and did not end); after the run, leftovers that appeared
// during it are listed as a warning. The warning never changes the exit code:
// the exit code is node --test's own. To end what a run left behind:
//   node scripts/check-leaks.mjs --kill-mine
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeLeaks, readRunRecord, splitMine, writeRunRecord } from './check-leaks.mjs';
import { CAN_SCAN, ENV_RUN, findLeaks } from './proc-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const extra = process.argv.slice(2);
const files = extra.some((a) => !a.startsWith('-')) ? [] : fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
const net = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'leak-net.mjs')).href;

const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
if (CAN_SCAN) writeRunRecord(runId);

const child = spawn(process.execPath, ['--import', net, '--test', '--test-concurrency=2', ...extra, ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, [ENV_RUN]: runId },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

const status = await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))));

if (CAN_SCAN) {
  // A process that is shutting down gets a moment.
  let mine = [];
  let other = [];
  for (const until = Date.now() + 4000; ; ) {
    ({ mine, other } = splitMine(findLeaks(), readRunRecord()));
    if (!mine.length || Date.now() >= until) break;
    await delay(300);
  }
  // What is certainly from this run is the warning; the rest is only mentioned,
  // because on a shared machine another run (or a test of this run that is still
  // finishing) may own it.
  if (mine.length) {
    console.error(`\n[leak-check] 有 ${mine.length} 個測試殘留行程，指令：node scripts/check-leaks.mjs --kill-mine`);
    console.error(describeLeaks(mine, { max: 20 }));
  }
  const unsure = other.filter((l) => l.whyCode === 'uncertain' || l.whyCode === 'no-record');
  if (unsure.length) console.error(`\n[leak-check] 另有 ${unsure.length} 個來源無法確定的殘留（可能是同時在跑的別的測試，不處理）：node scripts/check-leaks.mjs`);
  const older = other.filter((l) => l.whyCode === 'earlier');
  if (older.length) console.error(`\n[leak-check] 機器上另有 ${older.length} 個較早留下的測試殘留（不是這次產生的）：node scripts/check-leaks.mjs --kill-stale 可結束資料夾已刪除的`);
}
process.exit(status);
