// The memory file of a cluster (叢集), and the shell it takes to reach it.
//
// A cluster's memory is ONE markdown file that lives on the computer the
// workers run on, outside every worktree and outside what git commits (see
// cluster.js for where). It is read and written through the bridge's shell,
// not through fs.read/fs.write: those only reach inside a conversation's
// folder, and this file is deliberately outside all of them.
//
// This module has no dependency on the runner so the Kimi adapter can use it
// (the memory is put in front of a worker's next prompt, the same way a
// hand-off is) without a cycle.
import crypto from 'node:crypto';
import * as machines from './machines.js';
import * as store from './store.js';

// 'single quotes' that survive any text, for a shell command line.
export const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// What one prompt may carry of the memory's new part, and what reading the
// file for the page returns of it. The bridge keeps at most 120,000 characters
// of a command's output, so both stay clear of that.
export const INJECT_MAX_BYTES = 16 * 1024;
export const READ_MAX_BYTES = 90 * 1024;
export const APPEND_MAX_CHARS = 20_000;
const PEEK_TIMEOUT_MS = 8_000;

// One shell command on a computer, in `cwd`: { output, exitCode, killedBy }.
// The output is whole (up to what the bridge keeps), not cut in the middle the
// way a model-facing tool result is.
export async function sh(machineId, cwd, command, { timeoutMs = 30_000 } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const r = await machines.rpcStream(machineId, 'sh.run', { cwd, command, timeoutMs, id }, null, timeoutMs + 15_000);
  return { output: String(r?.output ?? ''), exitCode: typeof r?.exitCode === 'number' ? r.exitCode : -1, killedBy: r?.killedBy ?? null };
}

// A line of the form NAME=value in a command's output.
export const field = (output, name) => new RegExp(`^${name}=(.*)$`, 'm').exec(output)?.[1]?.trim();

// The memory file as it is on disk: from byte `from` on, at most `max` bytes
// of it (the newest ones when more than that is new). `bytes` is its size when
// it was read, `from` where the returned text really starts.
// { exists: false } when there is no such file.
export async function readMemory(machineId, cwd, file, { from = 0, max = READ_MAX_BYTES, timeoutMs = 30_000 } = {}) {
  const f = quote(file);
  const command = [
    `f=${f}`,
    '[ -f "$f" ] || { echo AHC_MISSING; exit 0; }',
    'sz=$(wc -c < "$f" | tr -d " ")',
    'mt=$(date -r "$f" +%s 2>/dev/null || echo 0)',
    `st=${Math.max(0, Math.floor(from))}`,
    '[ "$st" -gt "$sz" ] && st=$sz',
    `[ $((sz - st)) -gt ${Math.floor(max)} ] && st=$((sz - ${Math.floor(max)}))`,
    'echo "AHC_SIZE=$sz"',
    'echo "AHC_MTIME=$mt"',
    'echo "AHC_FROM=$st"',
    'echo AHC_BODY',
    'tail -c +$((st + 1)) "$f" | head -c $((sz - st))',
  ].join('\n');
  const r = await sh(machineId, cwd, command, { timeoutMs });
  if (r.exitCode !== 0) throw Object.assign(new Error(`讀不到叢集記憶檔（${r.output.trim().slice(0, 200) || `結束碼 ${r.exitCode}`}）`), { status: 502 });
  if (/^AHC_MISSING\s*$/m.test(r.output) && !/^AHC_SIZE=/m.test(r.output)) return { exists: false };
  const body = r.output.indexOf('\nAHC_BODY\n');
  const head = body === -1 ? r.output : r.output.slice(0, body);
  const bytes = Number(field(head, 'AHC_SIZE'));
  if (!Number.isFinite(bytes)) throw Object.assign(new Error('讀叢集記憶檔得到看不懂的回應'), { status: 502 });
  const mtime = Number(field(head, 'AHC_MTIME')) || 0;
  // A start that lands inside a multi-byte character leaves a replacement
  // character first; it is not part of the text.
  const text = body === -1 ? '' : r.output.slice(body + '\nAHC_BODY\n'.length).replace(/^�+/, '');
  return { exists: true, bytes, updatedAt: mtime * 1000, from: Number(field(head, 'AHC_FROM')) || 0, text };
}

// Only the size and the time of it (for the cluster's status).
export async function statMemory(machineId, cwd, file, { timeoutMs = 8_000 } = {}) {
  const r = await readMemory(machineId, cwd, file, { from: Number.MAX_SAFE_INTEGER, max: 0, timeoutMs });
  return r.exists ? { bytes: r.bytes, updatedAt: r.updatedAt } : null;
}

// A delimiter that is not in `text`, for a here-document that expands nothing.
function delimiterFor(text) {
  for (;;) {
    const d = `AHC_EOF_${crypto.randomBytes(6).toString('hex')}`;
    if (!text.includes(d)) return d;
  }
}

// Appends `text` (and a closing newline) to the file, making its folder first.
// Only ever appends: what is in the file is never rewritten.
export async function appendMemory(machineId, cwd, file, text) {
  const dir = file.replace(/\/[^/]*$/, '') || '/';
  const d = delimiterFor(text);
  const command = `mkdir -p ${quote(dir)} && cat >> ${quote(file)} <<'${d}'\n${text}\n${d}\n`;
  const r = await sh(machineId, cwd, command);
  if (r.exitCode !== 0) throw Object.assign(new Error(`寫不進叢集記憶檔（${r.output.trim().slice(0, 200) || `結束碼 ${r.exitCode}`}）`), { status: 502 });
}

// The memory file made new: its folder, a .gitignore for the case the folder
// sits inside a project that is later made a git repository, and the header.
export async function createMemory(machineId, cwd, file, header, { ignoreFolder = false } = {}) {
  const dir = file.replace(/\/[^/]*$/, '') || '/';
  const parent = dir.replace(/\/[^/]*$/, '') || '/';
  const d = delimiterFor(header);
  const command = [
    `mkdir -p ${quote(dir)}`,
    ignoreFolder ? `printf '*\\n' > ${quote(`${parent}/.gitignore`)}` : ':',
    `cat > ${quote(file)} <<'${d}'\n${header}\n${d}`,
  ].join(' && ') + '\n';
  const r = await sh(machineId, cwd, command);
  if (r.exitCode !== 0) throw Object.assign(new Error(`建不起叢集記憶檔（${r.output.trim().slice(0, 200) || `結束碼 ${r.exitCode}`}）`), { status: 502 });
}

// ---------------------------------------------------------------- injecting

// What a worker has been told of the memory is a byte offset into the file,
// kept on the worker's conversation (`clusterMemo: { path, offset }`). A prompt
// that has read the new part holds it here until Kimi has taken the prompt, so
// two prompts leaving together do not both carry the same part. The reading
// itself is one at a time per worker: the second prompt looks only after the
// first has said what it holds.
const reserved = new Map(); // session id -> the end offset of a prompt in flight
const reading = new Map(); // session id -> the read in progress (a promise)

async function alone(id, fn) {
  const before = reading.get(id) || Promise.resolve();
  let done;
  const mine = new Promise((r) => (done = r));
  const chain = before.then(() => mine);
  reading.set(id, chain);
  await before;
  try {
    return await fn();
  } finally {
    done();
    if (reading.get(id) === chain) reading.delete(id);
  }
}

// The part of the memory this worker has not been told yet, as the text of a
// system reminder, or null (nothing new, not a worker, the computer does not
// answer in time: a prompt never waits long for this, and the part stays new
// for the next one). Pair it with consumed() once Kimi took the prompt, or
// release() when it did not.
export function pending(session) {
  if (!session?.clusterMemo?.path || !session.machineId || !session.cwd) return Promise.resolve(null);
  return alone(session.id, () => peek(session));
}

async function peek(session) {
  const memo = session.clusterMemo;
  const offset = Math.max(memo.offset || 0, reserved.get(session.id) || 0);
  let r;
  try {
    r = await readMemory(session.machineId, session.cwd, memo.path, { from: offset, max: INJECT_MAX_BYTES, timeoutMs: PEEK_TIMEOUT_MS });
  } catch (err) {
    console.warn(`[cluster] memory of ${session.clusterId} not read for ${session.id}: ${err.message}`);
    return null;
  }
  if (!r.exists) return null;
  // The file became smaller: nothing says which part of it is new. Start over
  // from its end rather than tell the same things again.
  if (r.bytes < offset) {
    memo.offset = r.bytes;
    store.saveSession(session, { touch: false });
    return null;
  }
  if (r.bytes === offset || !r.text.trim()) return null;
  const skipped = r.from - offset;
  const text = [
    `叢集 ${session.clusterId} 的記憶檔（${memo.path}）有新內容，是主對話或其他工作者寫下的決定與結論，請納入你接下來的工作。這不是新的使用者要求。`,
    ...(skipped > 0 ? [`（比較舊的 ${skipped} 個位元組沒有附在這裡，需要時自己讀那個檔。）`] : []),
    '--- 新增內容 ---',
    r.text.trimEnd(),
    '--- 結束 ---',
  ].join('\n');
  reserved.set(session.id, r.bytes);
  return { text, end: r.bytes };
}

// Kimi took the prompt that carried `memo`: the worker has been told.
export function consumed(session, memo) {
  if (!memo) return;
  if (reserved.get(session.id) === memo.end) reserved.delete(session.id);
  if (session.clusterMemo && memo.end > (session.clusterMemo.offset || 0)) {
    session.clusterMemo = { ...session.clusterMemo, offset: memo.end };
    store.saveSession(session, { touch: false });
  }
}

// The prompt did not go out: the part is new again.
export function release(session, memo) {
  if (memo && reserved.get(session.id) === memo.end) reserved.delete(session.id);
}
