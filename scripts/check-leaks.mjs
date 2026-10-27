#!/usr/bin/env node
// Lists the processes the tests left behind. Reads only; nothing is ended
// unless you say --kill-mine or --kill-stale.
//
//   node scripts/check-leaks.mjs                 list them (exit 1 when there are any)
//   node scripts/check-leaks.mjs --warn          list them, exit 0 (what `npm test` uses)
//   node scripts/check-leaks.mjs --json          the same as JSON
//   node scripts/check-leaks.mjs --mark          remember "now" (and what is already leftover)
//   node scripts/check-leaks.mjs --new           list only what appeared since --mark
//   node scripts/check-leaks.mjs --only-pid 1,2  act on those PIDs only (with --kill-mine / --kill-stale)
//   node scripts/check-leaks.mjs --kill-mine     end what the last `npm test` left
//   node scripts/check-leaks.mjs --kill-stale    end what belongs to a deleted test folder
//
// A leftover is a process that belongs to a test and has lost its parent:
//   - it belongs to a test when its command line, its working folder or its
//     environment points into <tmp>/agent-hub-* (every test makes such a
//     folder), or it carries the AGENT_HUB_TEST_* stamp;
//   - it has lost its parent when it was adopted (parent PID 1 or an init) and
//     no running test process is among its ancestors.
// That is a stand-in node/cloudflared that waits for a file nobody will ever
// write, a Claude daemon (built to outlive its Hub), a browser.
//
// --kill-mine ends only what is certainly from the last `npm test` (see
// scripts/run-tests.mjs, which writes the record): started after it began, not
// there before, and either carrying that run's stamp or belonging to a folder
// that has been deleted. Anything uncertain is left alone and listed.
// --kill-stale ends what belongs to a deleted folder, whenever it started: no
// test can use a process whose scratch folder is gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAN_SCAN, descendantsOf, findLeaks, listProcesses, terminate } from './proc-scan.mjs';

// Where the last `npm test` wrote its record (AGENT_HUB_LEAK_RECORD: tests of this script use their own).
export const RUN_RECORD = process.env.AGENT_HUB_LEAK_RECORD || path.join(os.tmpdir(), 'agent-hub.last-test-run.json');

const KIND = { fakebin: '假墊片', 'claude-daemon': 'Claude daemon', hub: 'Hub', bridge: 'bridge', chromium: '瀏覽器', other: '其他' };

export function readRunRecord(file = RUN_RECORD) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Called before a test run starts: remembers its id, its start and the
// leftovers that were already there (so they are never taken for this run's).
export function writeRunRecord(runId, { file = RUN_RECORD } = {}) {
  const record = {
    runId,
    startedAt: Date.now(),
    runner: process.pid,
    before: findLeaks().map((l) => [l.pid, l.startTicks]),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record));
  } catch {}
  return record;
}

// Which leftovers are certainly from the run in `record`; the rest, with the reason.
export function splitMine(leaks, record) {
  const mine = [];
  const other = [];
  const before = new Set((record?.before || []).map(([pid, t]) => `${pid}:${t}`));
  for (const l of leaks) {
    let skip = null; // [code, reason]: why this one is NOT certainly the run's
    if (!record) skip = ['no-record', '沒有上一次 npm test 的紀錄'];
    else if (before.has(`${l.pid}:${l.startTicks}`)) skip = ['earlier', '本次開始前就在了'];
    else if (l.startMs == null || l.startMs < record.startedAt - 1000) skip = ['earlier', '啟動時間早於本次'];
    else if (l.stamps.run && l.stamps.run !== record.runId) skip = ['other-run', '帶著別次執行的標記'];
    else if (l.stamps.run === record.runId) skip = null; // carries this run's stamp
    else if (!l.ownerExists && l.owner !== '(stamp)') skip = null; // its folder is gone: nobody can use it
    else skip = ['uncertain', l.stamps.known ? '資料夾還在，也沒有本次標記，無法確定' : '讀不到環境變數，無法確定'];
    if (skip) other.push({ ...l, whyCode: skip[0], why: skip[1] });
    else mine.push(l);
  }
  return { mine, other };
}

export const staleOnly = (leaks) => leaks.filter((l) => l.owner !== '(stamp)' && !l.ownerExists);

const fmtAge = (s) => (s == null ? '?' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeLeaks(leaks, { max = 40 } = {}) {
  const lines = [];
  for (const l of leaks.slice(0, max)) {
    const below = l.below.length ? ` (+${l.below.length} 子行程)` : '';
    const folder = l.owner === '(stamp)' ? '(只有標記)' : `${l.owner}${l.ownerExists ? '' : '（已刪除）'}`;
    lines.push(`  ${String(l.pid).padStart(8)}  ${fmtAge(l.ageSec).padStart(6)}  ${(KIND[l.kind] || l.kind).padEnd(13)} ${clip(folder, 60)}${below}\n            ${clip(l.args.join(' '), 150)}`);
  }
  if (leaks.length > max) lines.push(`  …另外 ${leaks.length - max} 個`);
  return lines.join('\n');
}

function summarize(leaks) {
  const total = leaks.reduce((n, l) => n + 1 + l.below.length, 0);
  const kinds = {};
  for (const l of leaks) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  return { count: leaks.length, withChildren: total, kinds };
}

// End `leaks` and what hangs below them. Returns what happened.
export async function killLeaks(leaks) {
  const procs = listProcesses();
  const targets = [];
  for (const l of leaks) {
    const root = procs.find((p) => p.pid === l.pid && p.startTicks === l.startTicks);
    if (!root) continue; // gone already, or the PID now belongs to someone else
    targets.push(root, ...descendantsOf(procs, root.pid));
  }
  return terminate(targets);
}

async function main(argv) {
  const has = (f) => argv.includes(f);
  const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  if (has('--help') || has('-h')) {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  if (!CAN_SCAN) {
    console.log('這個系統沒有可讀的行程表，略過測試殘留檢查。');
    return 0;
  }
  if (has('--mark')) {
    const rec = writeRunRecord(valueOf('--mark')?.startsWith('--') ? `manual-${Date.now()}` : valueOf('--mark') || `manual-${Date.now()}`);
    console.log(`已記下起點（${rec.before.length} 個既有殘留不算本次）。`);
    return 0;
  }
  let leaks = findLeaks();
  const record = readRunRecord();
  if (has('--new')) {
    const known = new Set((record?.before || []).map(([pid, t]) => `${pid}:${t}`));
    leaks = leaks.filter((l) => !known.has(`${l.pid}:${l.startTicks}`) && l.startMs != null && l.startMs >= (record?.startedAt || 0) - 1000);
  }
  if (valueOf('--run') && record && record.runId !== valueOf('--run')) {
    console.error(`--run ${valueOf('--run')} 與上一次 npm test 的紀錄（${record.runId}）不符，無法對帳，什麼都不殺。`);
    return 2;
  }

  if (valueOf('--only-pid')) {
    const only = new Set(valueOf('--only-pid').split(',').map(Number));
    leaks = leaks.filter((l) => only.has(l.pid));
  }

  if (has('--kill-mine') || has('--kill-stale')) {
    const picked = has('--kill-mine') ? splitMine(leaks, record) : { mine: staleOnly(leaks), other: leaks.filter((l) => !staleOnly(leaks).includes(l)).map((l) => ({ ...l, why: '資料夾還在，不是「已刪除資料夾」殘留' })) };
    if (has('--kill-mine') && !record) console.error('找不到上一次 npm test 的紀錄；什麼都不殺。（先跑 npm test，或改用 --kill-stale）');
    const res = picked.mine.length ? await killLeaks(picked.mine) : { ended: [], killed: [], stuck: [] };
    console.log(`已結束 ${res.ended.length + res.killed.length} 個行程（其中 ${res.killed.length} 個需要 SIGKILL），${res.stuck.length} 個結束不了。`);
    if (picked.other.length) {
      console.log(`未處理 ${picked.other.length} 個殘留（不確定是本次的，一律不殺）：`);
      console.log(picked.other.slice(0, 15).map((l) => `  ${l.pid}  ${l.why}`).join('\n'));
    }
    return res.stuck.length ? 1 : 0;
  }

  const s = summarize(leaks);
  if (has('--json')) {
    console.log(JSON.stringify({ ...s, leaks: leaks.map((l) => ({ ...l, below: l.below.map((p) => p.pid), stamps: l.stamps })) }, null, 2));
    return has('--warn') || !leaks.length ? 0 : 1;
  }
  if (!leaks.length) {
    console.log('沒有測試殘留行程。');
    return 0;
  }
  console.log(`有 ${s.count} 個測試殘留行程（含子行程共 ${s.withChildren} 個；${Object.entries(s.kinds).map(([k, n]) => `${KIND[k] || k} ${n}`).join('、')}），指令：node scripts/check-leaks.mjs --kill-mine`);
  console.log(describeLeaks(leaks));
  console.log('  --kill-mine：只結束上一次 npm test 期間產生的；--kill-stale：結束資料夾已被刪除的。不確定的一律不殺。');
  return has('--warn') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(2);
  });
}
