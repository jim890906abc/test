// 完全清除 (full purge) of a finished cluster: everything it made, taken away
// whole - the worker conversations (the Hub's record and Kimi's, subagents with
// them), the worktrees, the worker branches, the memory file and the cluster's
// own record. The main conversation is never touched.
//
// The clean-up (清理) is the careful half: it only removes what is certainly
// somewhere else too. This is the other half, and it follows the same no-loss
// rule differently: what it deletes is first PACKED (a backup kept for 7 days,
// see cluster-trash.js), what is thrown away beyond the safe is only thrown
// away when the person ticked the box for it (all off by default), and
// anything that cannot be deleted is kept with the reason - never half-deleted
// without saying so.
//
// Order: what runs is interrupted · the backup is made (if it fails nothing is
// deleted) · each worker's Kimi conversations are deleted, then its Hub
// record · worktrees · branches · the merged branch · the memory · the
// cluster's record. A step that fails keeps its item, says why, and the next
// step goes on; the cluster's record is removed only when everything meant to
// go has gone, otherwise it stays marked as partly purged so the button can be
// pressed again.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as runner from './runner.js';
import * as machines from './machines.js';
import * as mem from './cluster-memory.js';
import * as trash from './cluster-trash.js';
import { ensureServer } from './adapters/kimi-remote.js';
import { writeTarGz } from './mini-tar.js';
import { subagentsOf } from './cluster-subagents.js';
import { getRecord, publicCluster, internals as C } from './cluster.js';
import { decidePurgeWorker, decidePurgeMerged, purgeOptions, PURGE_DAYS } from '../public/js/cluster-model.js';

const { fail, WORKING } = C;
const q = mem.quote;
const now = () => Date.now();
const GIT_TIMEOUT_MS = 120_000;
const BACKUP_TIMEOUT_MS = 20 * 60_000;
export const OLD_CONNECTOR_NOTE = '這台電腦的連接器太舊，Kimi 紀錄只能封存、不能刪除；重新執行連接指令更新後才能完全刪除';

const msg = (r) => r.output.trim().replace(/\s+/g, ' ').slice(0, 200) || `結束碼 ${r.exitCode}`;

// ------------------------------------------------------------------ checks

function checkPurgeable(rec) {
  if (rec.phase === 'merging') throw fail(409, '正在合併中，等它完成再清除');
  if (rec.phase === 'purging' || C.cleaning.has(rec.id)) throw fail(409, '正在清除或清理中，等它完成');
  if (rec.phase) throw fail(409, '叢集還在建立中');
  if (rec.workers.some((w) => WORKING.includes(C.leafOfWorker(w)?.status))) throw fail(409, '叢集還在跑，先全部停止');
  if (C.queueOpen(rec)) throw fail(409, '叢集還在跑：佇列還有任務沒做完，等它們做完或先全部停止');
  const m = machines.getMachine(rec.machineId);
  if (!m?.online) throw fail(409, `機器「${m?.name || rec.machineId}」目前離線：請在那台機器上執行連接器`);
}

// ------------------------------------------------------------------ gather

// The Hub conversations of a worker (its chain and every subagent conversation
// of any node) and the Kimi sessions behind them.
function membersOf(w) {
  const leaf = C.leafOfWorker(w);
  if (!leaf) return { leaf: null, chain: [], kids: [], natives: [] };
  const { chain, kids } = runner.conversationMembers(leaf);
  const natives = new Map();
  for (const id of [...chain, ...kids]) {
    const n = store.getSession(id);
    if (n?.kimiSessionId && n.machineId) natives.set(`${n.machineId}:${n.kimiSessionId}`, { machineId: n.machineId, kimiSessionId: n.kimiSessionId, hubId: id });
  }
  return { leaf, chain, kids, natives: [...natives.values()] };
}

const memoryDirOf = (rec) => {
  const dir = rec.memory.path.replace(/\/[^/]*$/, '');
  // Only the folder this cluster made, by its own name.
  return dir.endsWith(`/agent-hub-cluster/${rec.id}`) || dir.endsWith(`/.agent-hub-cluster/${rec.id}`) ? dir : null;
};

// What the connector of that computer can do and where its trash is.
async function connectorOf(rec, sessionIds) {
  const machine = machines.getMachine(rec.machineId);
  const canDelete = machines.hasCapability(rec.machineId, 'kimi_delete');
  if (canDelete) {
    const info = await machines.rpc(rec.machineId, 'trash.info', { sessionIds }, 20_000);
    if (!info?.trashDir) throw new Error('連接器沒有說它的備份資料夾在哪裡');
    return { name: machine.name, canDelete, trashDir: String(info.trashDir), dirs: info.dirs && typeof info.dirs === 'object' ? info.dirs : {} };
  }
  const home = String(machine.home || '').replace(/\/+$/, '');
  return { name: machine.name, canDelete, trashDir: home ? `${home}/.agent-hub/trash` : '', dirs: {} };
}

async function gather(rec, opts) {
  const mergedBranch = `cluster/${rec.id}/merged`;
  const members = rec.workers.map((w) => ({ w, ...membersOf(w) }));
  const allNatives = [...new Set(members.flatMap((m) => m.natives.map((n) => n.kimiSessionId)))];
  const connector = await connectorOf(rec, allNatives);
  const workers = [];
  for (const m of members) {
    const { w, leaf } = m;
    let facts = { hasWorktree: false };
    if (rec.repo && w.worktree) {
      try {
        facts = { hasWorktree: true, ...(await C.inspectWorker(rec, w)) };
      } catch (err) {
        // The computer could not say: nothing of it is touched, and it says why.
        facts = { hasWorktree: true, dir: true, registered: true, dirty: 0, statusError: err.message, tip: '?', safe: '', unique: 0, checkedOutAt: [] };
      }
    }
    const sub = leaf ? subagentsOf(leaf, { childStatus: (id) => store.getSession(id)?.status }) : null;
    workers.push({
      sessionId: w.sessionId,
      n: w.n,
      title: w.title,
      worktree: w.worktree || null,
      branch: w.branch || null,
      exists: Boolean(leaf),
      conversation: { hubNodes: m.chain.length, hubSubagentSessions: m.kids.length, kimiSessions: m.natives.length, kimiSubagents: sub ? sub.counts.total + (sub.older || 0) : 0 },
      facts,
    });
  }
  let merged = { branch: mergedBranch, exists: false, tip: '' };
  if (rec.repo) {
    const r = await mem.sh(rec.machineId, rec.cwd, C.gitIn(rec.repo.top, `rev-parse --verify -q ${q(`refs/heads/${mergedBranch}`)}`), { timeoutMs: 60_000 });
    if (r.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(r.output.trim())) merged = { branch: mergedBranch, exists: true, tip: r.output.trim() };
    else if (r.exitCode > 1) throw new Error(`看不到合併分支：${msg(r)}`);
  }
  const memory = { path: rec.memory.path, dir: memoryDirOf(rec), exists: false, bytes: 0 };
  try {
    const st = await mem.statMemory(rec.machineId, rec.cwd, rec.memory.path);
    if (st) Object.assign(memory, { exists: true, bytes: st.bytes });
  } catch {}
  return { members, workers, merged, memory, connector, opts };
}

function decide(g) {
  return {
    workers: g.workers.map((x) => ({ sessionId: x.sessionId, ...decidePurgeWorker(x.facts, g.opts) })),
    merged: decidePurgeMerged(g.merged.exists, g.opts),
  };
}

// ------------------------------------------------------------------- plan

// What a purge would do now with these options, without doing any of it. The
// facts (what the computer said of each worktree and branch) go with it, so
// the dialog can show what each box would change without asking again.
export async function plan(cid, rawOpts = {}) {
  const rec = getRecord(cid);
  const opts = purgeOptions(rawOpts);
  checkPurgeable(rec);
  C.cleaning.add(rec.id);
  try {
    const g = await gather(rec, opts);
    const d = decide(g);
    return {
      dryRun: true,
      clusterId: rec.id,
      name: publicCluster(rec).name,
      options: opts,
      days: PURGE_DAYS,
      connector: { name: g.connector.name, canDeleteKimi: g.connector.canDelete, trashDir: g.connector.trashDir, note: g.connector.canDelete ? null : OLD_CONNECTOR_NOTE },
      workers: g.workers.map((x, i) => ({ ...x, decision: d.workers[i] })),
      merged: { ...g.merged, decision: d.merged },
      memory: g.memory,
      totals: {
        workers: g.workers.length,
        conversations: g.workers.filter((x) => x.exists).length,
        kimiSessions: new Set(g.members.flatMap((m) => m.natives.map((n) => n.kimiSessionId))).size,
        kimiSubagents: g.workers.reduce((a, x) => a + x.conversation.kimiSubagents, 0),
        worktrees: g.workers.filter((x) => x.facts.hasWorktree && x.facts.dir).length,
        dirtyWorktrees: g.workers.filter((x) => x.facts.hasWorktree && x.facts.dir && x.facts.dirty > 0).length,
        branches: g.workers.filter((x) => x.facts.hasWorktree && x.facts.tip).length,
        unmergedBranches: g.workers.filter((x) => x.facts.hasWorktree && x.facts.tip && !x.facts.safe).length,
      },
    };
  } finally {
    C.cleaning.delete(rec.id);
  }
}

// ----------------------------------------------------------------- backups

function manifestText(rec, g, d, at, items, extras) {
  const lines = [
    `Agent Hub 叢集完全清除前的備份（叢集 ${rec.id}「${publicCluster(rec).name}」）`,
    `備份時間：${new Date(at).toISOString()}　保留 ${PURGE_DAYS} 天後自動刪除`,
    '',
    '內容：',
    ...items.map((p) => `  ${p}`),
    ...extras.map((e) => `  extras/${e}`),
    '',
    '還原：',
    '  Kimi 對話資料夾與記憶檔：tar -xzf 這個檔案 -C /   （路徑是從 / 開始的相對路徑，Kimi 要先關掉）',
    '  未提交的修改：extras/wN-uncommitted.patch 在 worktree 裡 git apply；未追蹤的檔案在 extras/wN-untracked.tar.gz',
    '  被刪除的分支：extras/branches.bundle，git fetch extras/branches.bundle \'refs/heads/*:refs/heads/*\'',
    '',
    '被刪的分支（分支名 → 刪除時的 commit）：',
  ];
  g.workers.forEach((x, i) => {
    const b = d.workers[i].branch;
    if ((b === 'delete' || b === 'delete-unmerged') && x.branch) lines.push(`  ${x.branch} → ${x.facts.tip}${b === 'delete-unmerged' ? '　（沒合併進去的）' : ''}`);
  });
  if (d.merged.state === 'delete') lines.push(`  ${g.merged.branch} → ${g.merged.tip}　（合併分支）`);
  return lines.join('\n');
}

// The computer's side: one tar.gz in the connector's trash. If anything in it
// fails the file is not left behind and the purge does not go on.
async function backupOnMachine(rec, g, d, at) {
  const dirs = [...new Set(g.members.flatMap((m) => m.natives.map((n) => g.connector.dirs[n.kimiSessionId])).filter(Boolean))];
  const items = [...dirs, ...(g.memory.dir && g.memory.exists ? [g.memory.dir] : [])];
  const extras = [];
  const frags = [];
  g.workers.forEach((x, i) => {
    if (d.workers[i].worktree !== 'discard') return;
    const n = x.n ?? i + 1;
    extras.push(`w${n}-uncommitted.patch`, `w${n}-untracked.tar.gz`);
    frags.push(
      `git -C ${q(x.worktree)} diff HEAD --binary > "$tmp/extras/w${n}-uncommitted.patch" || { echo "AHC_ERR=存不下 w${n} 未提交的修改"; exit 21; }`,
      `git -C ${q(x.worktree)} ls-files --others --exclude-standard -z > "$tmp/ul.${n}" || { echo "AHC_ERR=列不出 w${n} 未追蹤的檔案"; exit 22; }`,
      `if [ -s "$tmp/ul.${n}" ]; then tar -C ${q(x.worktree)} --null -T "$tmp/ul.${n}" -czf "$tmp/extras/w${n}-untracked.tar.gz" || { echo "AHC_ERR=存不下 w${n} 未追蹤的檔案"; exit 23; }; fi`,
    );
  });
  const doomed = g.workers.filter((x, i) => ['delete', 'delete-unmerged'].includes(d.workers[i].branch) && x.branch).map((x) => x.branch);
  if (d.merged.state === 'delete') doomed.push(g.merged.branch);
  if (doomed.length && rec.repo) {
    extras.push('branches.bundle');
    frags.push(
      `base=$(git -C ${q(rec.cwd)} rev-parse -q --verify HEAD 2>/dev/null) || base=`,
      'set --',
      '[ -n "$base" ] && set -- "^$base"',
      `for b in ${doomed.map((b) => q(`refs/heads/${b}`)).join(' ')}; do set -- "$@" "$b"; done`,
      `out=$(git -C ${q(rec.repo.top)} bundle create "$tmp/extras/branches.bundle" "$@" 2>&1); rc=$?`,
      'if [ $rc -ne 0 ]; then case "$out" in *"empty bundle"*) : ;; *) echo "AHC_ERR=存不下要刪的分支：$out"; exit 24;; esac; fi',
    );
  }
  const trashDir = g.connector.trashDir;
  if (!trashDir) throw new Error('不知道這台電腦的備份資料夾在哪裡（連接器沒有回報家目錄）');
  const name = trash.backupName(rec.id, at);
  const text = manifestText(rec, g, d, at, items, extras);
  const delim = `AHC_EOF_${Math.random().toString(16).slice(2, 10)}`;
  const script = [
    'umask 077',
    `trash=${q(trashDir)}`,
    `name=${q(name)}`,
    'mkdir -p "$trash" || { echo "AHC_ERR=建不起備份資料夾 $trash"; exit 11; }',
    'tmp=$(mktemp -d "${TMPDIR:-/tmp}/ahpurge.XXXXXX") || { echo "AHC_ERR=建不起暫存資料夾"; exit 12; }',
    'trap \'rm -rf "$tmp"\' EXIT',
    'mkdir -p "$tmp/extras"',
    `cat > "$tmp/MANIFEST.txt" <<'${delim}'\n${text}\n${delim}`,
    ...frags,
    'set --',
    `for p in ${items.map(q).join(' ')}; do if [ -e "$p" ]; then set -- "$@" "\${p#/}"; else echo "AHC_MISSING=$p"; fi; done`,
    // (A `-C /` with nothing after it is an error for GNU tar: a retry has nothing left to pack but the manifest.)
    'if [ $# -gt 0 ]; then tar -czf "$trash/$name.partial" -C "$tmp" MANIFEST.txt extras -C / "$@" 2>"$tmp/tar.err"; else tar -czf "$trash/$name.partial" -C "$tmp" MANIFEST.txt extras 2>"$tmp/tar.err"; fi; rc=$?',
    // (A conversation Kimi was still writing to changes under tar's hands: GNU tar says so with 1 and the archive is whole.)
    'if [ $rc -ne 0 ]; then if [ $rc -eq 1 ] && grep -q "file changed as we read it" "$tmp/tar.err"; then :; else echo "AHC_ERR=tar 失敗：$(head -c 300 "$tmp/tar.err")"; rm -f "$trash/$name.partial"; exit 30; fi; fi',
    'tar -tzf "$trash/$name.partial" >/dev/null 2>&1 || { echo "AHC_ERR=打包出來的檔案讀不回來"; rm -f "$trash/$name.partial"; exit 31; }',
    'mv "$trash/$name.partial" "$trash/$name" || { echo "AHC_ERR=備份檔改名失敗"; exit 32; }',
    'echo "AHC_BACKUP=$trash/$name"',
    'echo "AHC_BYTES=$(wc -c < "$trash/$name" | tr -d " ")"',
  ].join('\n');
  const r = await mem.sh(rec.machineId, rec.cwd, script, { timeoutMs: BACKUP_TIMEOUT_MS });
  const file = mem.field(r.output, 'AHC_BACKUP');
  if (r.exitCode !== 0 || !file) throw new Error(mem.field(r.output, 'AHC_ERR') || msg(r));
  return { machineId: rec.machineId, machineName: g.connector.name, path: file, bytes: Number(mem.field(r.output, 'AHC_BYTES')) || 0, missing: [...r.output.matchAll(/^AHC_MISSING=(.*)$/gm)].map((m) => m[1]), items: items.length };
}

// The Hub's side: the workers' conversation files and the cluster's record.
async function backupOnHub(rec, g, at) {
  const ids = [...new Set(g.members.flatMap((m) => [...m.chain, ...m.kids]))];
  for (const id of ids) {
    const s = store.getSession(id);
    if (s) await store.persistNow(s);
  }
  C.persist(rec);
  const entries = [];
  for (const id of ids) {
    const file = path.join(store.DATA_DIR, 'sessions', `${id}.json`);
    if (fs.existsSync(file)) entries.push({ name: `sessions/${id}.json`, file });
  }
  const recFile = C.fileOf(rec.id);
  if (fs.existsSync(recFile)) entries.push({ name: `clusters/${rec.id}.json`, file: recFile });
  entries.unshift({
    name: 'MANIFEST.json',
    data: JSON.stringify({ clusterId: rec.id, name: publicCluster(rec).name, at, expiresAt: at + PURGE_DAYS * trash.DAY_MS, conversations: ids, restore: '停掉中控台後，把 sessions/ 與 clusters/ 解到 data/ 底下再啟動' }, null, 2),
  });
  fs.mkdirSync(trash.trashDir(), { recursive: true, mode: 0o700 });
  const file = path.join(trash.trashDir(), trash.backupName(rec.id, at));
  try {
    const bytes = await writeTarGz(file, entries);
    return { file: path.basename(file), bytes, conversations: ids.length };
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- the steps

// One Kimi session on its computer: deleted (a connector that can), else archived.
// One that is not there any more is as good as deleted.
async function deleteNative(n, canDelete) {
  const action = canDelete ? 'delete' : 'archive';
  try {
    await ensureServer(n.machineId);
    await machines.kimiApi(n.machineId, 'POST', `/api/v1/sessions/${n.kimiSessionId}:${action}`, {}, 60_000);
    return { ok: true, action };
  } catch (err) {
    if (err.kimiCode === 40401) return { ok: true, action: 'gone' };
    return { ok: false, error: err.message || String(err) };
  }
}

async function removeBranch(rec, branch, tip, kind) {
  const top = rec.repo.top;
  const script = [
    `top=${q(top)}; br=${q(branch)}; main=${q(rec.cwd)}; kind=${q(kind)}; want=${q(tip)}; mergedbr=${q(`cluster/${rec.id}/merged`)}`,
    'cur=$(git -C "$top" rev-parse --verify -q "refs/heads/$br") || { echo "AHC_GONE"; exit 0; }',
    '[ "$cur" = "$want" ] || { echo "分支在備份之後又動過（現在是 $cur）"; exit 4; }',
    'if git -C "$top" worktree list --porcelain | grep -Fxq "branch refs/heads/$br"; then echo "分支被某個 worktree 檢出"; exit 3; fi',
    'if [ "$kind" = merged ]; then ref=$(git -C "$top" rev-parse --verify -q "refs/heads/$mergedbr") || { echo "合併用的分支不見了"; exit 4; }; git -C "$top" merge-base --is-ancestor "$cur" "$ref" || { echo "分支上有 commit 不在別處"; exit 4; }',
    'elif [ "$kind" = head ]; then ref=$(git -C "$main" rev-parse --verify -q HEAD) || { echo "讀不到主對話的 HEAD"; exit 4; }; git -C "$top" merge-base --is-ancestor "$cur" "$ref" || { echo "分支上有 commit 不在別處"; exit 4; }; fi',
    // Compare-and-swap: only if the branch is still at the commit that was backed up.
    'git -C "$top" update-ref -d "refs/heads/$br" "$cur" 2>&1',
  ].join('\n');
  const r = await mem.sh(rec.machineId, rec.cwd, script, { timeoutMs: GIT_TIMEOUT_MS });
  if (/^AHC_GONE$/m.test(r.output)) return { ok: true, gone: true };
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: msg(r) };
}

// ------------------------------------------------------------------ purge

export async function purge(cid, rawOpts = {}) {
  const rec = getRecord(cid);
  const opts = purgeOptions(rawOpts);
  checkPurgeable(rec);
  C.cleaning.add(rec.id);
  rec.phase = 'purging';
  C.announce(rec, { force: true });
  try {
    return await run(rec, opts);
  } finally {
    C.cleaning.delete(rec.id);
    if (C.clusters.get(rec.id) === rec && rec.phase === 'purging') {
      rec.phase = null;
      C.persist(rec);
      C.announce(rec, { force: true });
    }
  }
}

async function run(rec, opts) {
  const at = now();
  const name = publicCluster(rec).name;
  const res = { dryRun: false, clusterId: rec.id, name, at, options: opts, aborted: false, reason: '', backup: { enabled: !opts.noBackup, days: PURGE_DAYS, hub: null, machine: null }, connectorNote: null, workers: [], merged: { branch: `cluster/${rec.id}/merged`, state: 'none', reason: '' }, memory: { state: 'none', reason: '' }, container: null, failed: [], kept: [], removed: false, partial: false };

  let g;
  try {
    g = await gather(rec, opts);
  } catch (err) {
    return { ...res, aborted: true, reason: `看不到這個叢集的現況，所以什麼都沒有刪：${err.message}` };
  }
  const d = decide(g);
  if (!g.connector.canDelete) res.connectorNote = OLD_CONNECTOR_NOTE;

  // 1. what runs is interrupted (a subagent still going in a stopped worker).
  for (const m of g.members) {
    if (!m.leaf) continue;
    const sub = subagentsOf(m.leaf, { childStatus: (id) => store.getSession(id)?.status });
    if (sub.counts.running > 0 || sub.counts.awaiting > 0) await Promise.resolve(runner.interrupt(m.leaf.id)).catch(() => {});
  }

  // 2. the backup: if it cannot be made, nothing is deleted (and what half of it was made is taken back).
  if (!opts.noBackup) {
    try {
      res.backup.hub = await backupOnHub(rec, g, at);
      res.backup.machine = await backupOnMachine(rec, g, d, at);
    } catch (err) {
      if (res.backup.hub) fs.rmSync(path.join(trash.trashDir(), res.backup.hub.file), { force: true });
      return { ...res, aborted: true, reason: `備份沒有做成，所以什麼都沒有刪：${err.message}`, backup: { ...res.backup, hub: null, machine: null, error: err.message } };
    }
    res.backup.expiresAt = at + PURGE_DAYS * trash.DAY_MS;
  }

  // 3. each worker's conversations: Kimi's first, then the Hub's own record.
  for (let i = 0; i < g.workers.length; i++) {
    const x = g.workers[i];
    const m = g.members[i];
    const out = { sessionId: x.sessionId, n: x.n, title: x.title, conversation: 'gone', kimi: { deleted: 0, archived: 0, gone: 0, failed: 0 }, worktree: x.facts.hasWorktree ? 'kept' : 'none', branch: x.facts.hasWorktree ? 'kept' : 'none', reasons: [] };
    res.workers.push(out);
    if (!m.leaf) continue;
    const bad = [];
    for (const nat of m.natives) {
      const r = await deleteNative(nat, g.connector.canDelete);
      if (r.ok) out.kimi[r.action === 'delete' ? 'deleted' : r.action === 'archive' ? 'archived' : 'gone']++;
      else {
        out.kimi.failed++;
        bad.push(`Kimi 對話 ${nat.kimiSessionId} 沒有刪掉：${r.error}`);
      }
    }
    if (bad.length) {
      out.conversation = 'kept';
      out.reasons.push(...bad, '這個工作者的對話保留（Hub 紀錄還在，可以再按一次完全清除）');
      res.failed.push(`w${x.n}「${x.title}」的對話：${bad[0]}`);
      continue;
    }
    try {
      runner.deleteConversation(m.leaf, { archiveNatives: false });
      for (const nat of m.natives) machines.hideNative(nat.machineId, nat.kimiSessionId);
      C.workerIndex.delete(x.sessionId);
      out.conversation = g.connector.canDelete ? 'deleted' : 'archived';
    } catch (err) {
      out.conversation = 'kept';
      out.reasons.push(`Hub 的對話紀錄沒有刪：${err.message}`);
      res.failed.push(`w${x.n}「${x.title}」的 Hub 紀錄：${err.message}`);
    }
  }

  // 4. worktrees.
  // `kept(...)`: something stays - by the person's choice (an unticked box: said, not a failure) or because it could not be taken (a failure: the purge is partial).
  const kept = (x, label, kind, why) => (kind === 'option' ? res.kept : res.failed).push(`w${x.n} 的${label}：${why}`);
  for (let i = 0; i < g.workers.length; i++) {
    const x = g.workers[i];
    const out = res.workers[i];
    const dec = d.workers[i];
    if (!x.facts.hasWorktree) continue;
    if (dec.worktree === 'remove' || dec.worktree === 'discard') {
      const r = await mem.sh(rec.machineId, rec.cwd, C.gitIn(rec.repo.top, `worktree remove ${dec.worktree === 'discard' ? '--force ' : ''}${q(x.worktree)}`), { timeoutMs: GIT_TIMEOUT_MS });
      if (r.exitCode === 0) out.worktree = dec.worktree === 'discard' ? 'discarded' : 'removed';
      else {
        out.worktree = 'kept';
        const why = `git 拒絕移除 worktree：${msg(r)}`;
        out.reasons.push(why);
        dec.why.worktree = why;
        dec.keptBy.worktree = 'problem';
        kept(x, `worktree ${x.worktree}`, 'problem', why);
      }
    } else if (dec.worktree === 'gone') {
      await mem.sh(rec.machineId, rec.cwd, `${C.gitIn(rec.repo.top, 'worktree prune', { quiet: true })}; true`).catch(() => {});
      out.worktree = 'gone';
    } else {
      out.worktree = 'kept';
      out.reasons.push(dec.why.worktree);
      kept(x, `worktree ${x.worktree}`, dec.keptBy.worktree, dec.why.worktree);
    }
  }

  // 5. branches (one whose worktree stayed is not deleted: git would refuse, and it is still in use).
  for (let i = 0; i < g.workers.length; i++) {
    const x = g.workers[i];
    const out = res.workers[i];
    const dec = d.workers[i];
    if (!x.facts.hasWorktree) continue;
    const doomed = dec.branch === 'delete' || dec.branch === 'delete-unmerged';
    if (doomed && out.worktree === 'kept') {
      const why = '分支還被保留下來的 worktree 使用中';
      out.branch = 'kept';
      out.reasons.push(why);
      kept(x, `分支 ${x.branch}`, dec.keptBy.worktree, why);
    } else if (doomed) {
      const r = await removeBranch(rec, x.branch, x.facts.tip, dec.branch === 'delete-unmerged' ? 'unmerged' : x.facts.safe);
      if (r.ok) out.branch = r.gone ? 'gone' : 'deleted';
      else {
        out.branch = 'kept';
        out.reasons.push(`沒有刪分支：${r.error}`);
        kept(x, `分支 ${x.branch}`, 'problem', r.error);
      }
    } else if (dec.branch === 'gone') out.branch = 'gone';
    else {
      out.branch = 'kept';
      out.reasons.push(dec.why.branch);
      kept(x, `分支 ${x.branch}`, dec.keptBy.branch, dec.why.branch);
    }
  }
  if (rec.repo) await mem.sh(rec.machineId, rec.cwd, `rmdir ${q(rec.repo.container)} 2>/dev/null; true`).catch(() => {});
  if (rec.repo) {
    const left = await mem.sh(rec.machineId, rec.cwd, `[ -d ${q(rec.repo.container)} ] && echo yes; true`).catch(() => ({ output: '' }));
    res.container = /yes/.test(left.output) ? { path: rec.repo.container, state: 'kept' } : { path: rec.repo.container, state: 'gone' };
  }

  // 6. the merged branch.
  if (g.merged.exists) {
    if (d.merged.state === 'delete') {
      const r = await removeBranch(rec, g.merged.branch, g.merged.tip, 'unmerged');
      if (r.ok) res.merged = { branch: g.merged.branch, state: 'deleted', reason: '' };
      else {
        res.merged = { branch: g.merged.branch, state: 'kept', reason: r.error };
        res.failed.push(`合併分支 ${g.merged.branch}：${r.error}`);
      }
    } else {
      res.merged = { branch: g.merged.branch, state: 'kept', reason: d.merged.reason };
      res.kept.push(`合併分支 ${g.merged.branch}：${d.merged.reason}`);
    }
  }

  // 7. the memory file and its folder.
  if (!g.memory.dir) {
    res.memory = { state: 'kept', reason: '記憶檔的位置不是這個叢集自己建的資料夾，沒有動它' };
    res.failed.push(`叢集記憶檔：${res.memory.reason}`);
  } else {
    const dir = g.memory.dir;
    const parent = dir.replace(/\/[^/]*$/, '');
    const r = await mem.sh(rec.machineId, rec.cwd, [
      `rm -rf ${q(dir)} || exit 1`,
      // The folder above it goes too once it holds nothing else (the .gitignore this made counts as nothing).
      `if [ -f ${q(`${parent}/.gitignore`)} ] && [ "$(ls -A ${q(parent)})" = ".gitignore" ] && [ "$(cat ${q(`${parent}/.gitignore`)})" = "*" ]; then rm -rf ${q(parent)}; else rmdir ${q(parent)} 2>/dev/null; fi; true`,
    ].join('\n'), { timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode === 0) res.memory = { state: g.memory.exists ? 'deleted' : 'gone', reason: '' };
    else {
      res.memory = { state: 'kept', reason: msg(r) };
      res.failed.push(`叢集記憶檔：${msg(r)}`);
    }
  }

  // 8. the cluster's own record: only when everything meant to go has gone.
  res.partial = res.failed.length > 0;
  if (!res.partial) {
    removeRecord(rec);
    res.removed = true;
  } else {
    rec.purge = { at, partial: true, failed: res.failed, options: opts };
    C.persist(rec);
  }
  trash.addEntry({
    id: `${rec.id}-${trash.stampOf(at)}`,
    clusterId: rec.id,
    name,
    purgedAt: at,
    expiresAt: at + PURGE_DAYS * trash.DAY_MS,
    partial: res.partial,
    hub: res.backup.hub ? { file: res.backup.hub.file, bytes: res.backup.hub.bytes } : null,
    machine: res.backup.machine ? { machineId: res.backup.machine.machineId, machineName: res.backup.machine.machineName, path: res.backup.machine.path, bytes: res.backup.machine.bytes } : null,
    kept: [...res.kept, ...res.failed.map((f) => `（沒刪成）${f}`)],
  });
  return res;
}

// The cluster is gone: from the Hub's memory and disk, from the main
// conversation's list, and from every page.
function removeRecord(rec) {
  C.clusters.delete(rec.id);
  C.lastSent.delete(rec.id);
  for (const w of rec.workers) C.workerIndex.delete(w.sessionId);
  fs.rmSync(C.fileOf(rec.id), { force: true });
  const parent = store.getSession(rec.parentId);
  if (parent) {
    for (const node of store.chainOf(store.leafOf(parent) || parent)) {
      if (!Array.isArray(node.clusterIds) || !node.clusterIds.includes(rec.id)) continue;
      node.clusterIds = node.clusterIds.filter((id) => id !== rec.id);
      store.saveSession(node, { touch: false });
    }
    const leaf = store.leafOf(parent) || parent;
    C.say({ t: 'session', session: runner.summarize(leaf) });
  }
  C.say({ t: 'cluster.removed', id: rec.id });
}

export const listPurged = () => trash.listPurged();
