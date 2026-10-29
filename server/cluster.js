// 叢集 (cluster): one conversation hands several tasks to several workers at
// once. A worker is an ordinary Hub conversation (Kimi or DeepSeek, on the
// same computer) of its own - usually in a git worktree of its own - and the
// cluster is the page that holds them together: a shared memory file, a
// status, stop, and a merge of what the workers committed.
//
// This is NOT Kimi's /swarm. A worker may have Kimi's swarm mode turned on, and
// that is Kimi's own feature, set the way any conversation sets it; the cluster
// is the Hub's layer above conversations and uses no other name for itself.
//
// The Hub does what a person would: it makes the worktrees with git, opens the
// conversations through the same code a person's click uses (newSession,
// configure, the native :fork), and sends each worker its first message. What
// it keeps itself is small: the cluster record (data/clusters/<id>.json), and
// on each worker conversation `clusterId`, `clusterRole: 'worker'` and
// `clusterMemo` (which part of the memory file the worker has been told). A
// worker has no `parentId`: that field is the sub-agent hierarchy, and deleting
// a parent deletes such children; a worker is a conversation in its own right.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as runner from './runner.js';
import * as machines from './machines.js';
import { redact } from './redact.js';
import * as mem from './cluster-memory.js';

export const MAX_WORKERS = 8;
export const EXCERPT_MAX_CHARS = 8000;
const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
const MAX_NOTE = 4_000;
const TASK_SHOWN = 2_000;
const PROGRESS_SHOWN = 160;
const WORKING = ['running', 'awaiting_permission'];
const CLUSTER_DIR = path.join(store.DATA_DIR, 'clusters');

const clusters = new Map(); // cluster id -> record (see create())
const workerIndex = new Map(); // conversation id -> cluster id
let broadcast = () => {};
export function setBroadcast(fn) {
  broadcast = fn;
}

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const now = () => Date.now();

// ---------------------------------------------------------------- records

const fileOf = (id) => path.join(CLUSTER_DIR, `${id}.json`);

function persist(rec) {
  try {
    fs.mkdirSync(CLUSTER_DIR, { recursive: true, mode: 0o700 });
    // `phase` is only what is happening right now; it is not kept.
    const { phase, ...keep } = rec;
    store.writeJsonAtomic(fileOf(rec.id), keep);
  } catch (err) {
    console.warn(`[cluster] ${rec.id} not saved: ${err.message}`);
  }
}

function index(rec) {
  clusters.set(rec.id, rec);
  for (const w of rec.workers) workerIndex.set(w.sessionId, rec.id);
}

// Read at start. A file that cannot be used is skipped with a word, never
// deleted: it is the only record of where that cluster's worktrees are.
export function load() {
  let names = [];
  try {
    names = fs.readdirSync(CLUSTER_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^c_[0-9a-f]{12}\.json$/.test(name)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(CLUSTER_DIR, name), 'utf8'));
      if (rec?.id !== name.slice(0, -5) || !Array.isArray(rec.workers) || typeof rec.parentId !== 'string') throw new Error('內容不像一個叢集');
      index(rec);
    } catch (err) {
      console.warn(`[cluster] ${name} 沒有載入：${err.message}`);
    }
  }
}

// Flushed with the rest at shutdown (a debounce would lose the last change).
export function flush() {
  for (const rec of clusters.values()) persist(rec);
}

// ------------------------------------------------------------ the public form

const clip = (text, n) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// A long message keeps its beginning (what was asked) and its end (where it
// got to), with the middle named as left out.
const clipMiddle = (text, n) => {
  if (text.length <= n) return text;
  const mark = '…（中間省略）…';
  const head = Math.floor((n - mark.length) * 0.6);
  return `${text.slice(0, head)}${mark}${text.slice(text.length - (n - mark.length - head))}`;
};

const leafOfWorker = (w) => {
  const s = store.getSession(w.sessionId);
  return s ? store.leafOf(s) || s : null;
};

// One line of what a worker is doing or has just said: while it works, the
// to-do it has marked in progress; otherwise (and as a fallback) the first
// sentence of its latest visible text.
function progressOf(s) {
  if (!s) return '';
  const todo = (Array.isArray(s.meta?.todos) ? s.meta.todos : []).find((t) => t?.status === 'in_progress');
  if (WORKING.includes(s.status) && todo) {
    const t = String(todo.title || todo.content || '').trim();
    if (t) return clip(`▸ ${t.replace(/\s+/g, ' ')}`, PROGRESS_SHOWN);
  }
  for (let i = (s.events || []).length - 1; i >= 0; i--) {
    const ev = s.events[i];
    if (ev.type !== 'text' || !String(ev.text || '').trim()) continue;
    const lines = ev.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const line = lines.find((l) => !l.startsWith('#') && l.replace(/\W/g, '').length >= 4) || lines[0];
    return clip(line.replace(/\s+/g, ' '), PROGRESS_SHOWN);
  }
  return '';
}

function statusOf(rec) {
  if (rec.phase) return rec.phase;
  const live = rec.workers.map(leafOfWorker);
  if (live.some((s) => s && WORKING.includes(s.status))) return 'running';
  if (rec.stoppedAt) return 'stopped';
  if (rec.workers.length && rec.workers.every((w) => w.finishedAt)) return live.every((s) => !s || s.status === 'error') ? 'error' : 'done';
  return 'running';
}

export function publicCluster(rec) {
  return {
    id: rec.id,
    parentId: rec.parentId,
    createdAt: rec.createdAt,
    status: statusOf(rec),
    mode: rec.mode,
    isolate: rec.isolate,
    swarm: rec.swarm,
    warnings: [...rec.warnings],
    workers: rec.workers.map((w) => {
      const s = leafOfWorker(w);
      return {
        sessionId: w.sessionId,
        title: w.title,
        task: clip(w.task, TASK_SHOWN),
        status: s ? s.status : 'deleted',
        branch: w.branch || null,
        worktree: w.worktree || null,
        // What the native says, not what was asked: Kimi can turn it off by itself.
        swarm: Boolean(s?.meta?.swarmMode),
        progress: progressOf(s),
        finishedAt: w.finishedAt || null,
      };
    }),
    memory: { path: rec.memory.path, bytes: rec.memory.bytes ?? 0, updatedAt: rec.memory.updatedAt ?? null },
    merge: rec.merge || null,
  };
}

const lastSent = new Map(); // cluster id -> the JSON last broadcast
function announce(rec, { force = false } = {}) {
  if (rec.phase === 'starting' && !force) return;
  const pub = publicCluster(rec);
  const json = JSON.stringify(pub);
  if (!force && lastSent.get(rec.id) === json) return;
  lastSent.set(rec.id, json);
  broadcast({ t: 'cluster', cluster: pub });
}

// A worker's events or status moved: say so, but not once per token.
const announceTimers = new Map();
export function noteActivity(sessionId) {
  if (!workerIndex.size) return;
  // A worker that went on in a new node of its chain speaks under the new node's id; the node knows its cluster.
  const cid = workerIndex.get(sessionId) || store.getSession(sessionId)?.clusterId;
  if (!cid || !clusters.has(cid) || announceTimers.has(cid)) return;
  const t = setTimeout(() => {
    announceTimers.delete(cid);
    const rec = clusters.get(cid);
    if (rec) announce(rec);
  }, 800);
  t.unref?.();
  announceTimers.set(cid, t);
}

// The memory file's size and time, read from the computer now (kept on the
// record so the public form needs no round trip). A computer that does not
// answer leaves what was known.
async function refreshMemory(rec) {
  try {
    const st = await mem.statMemory(rec.machineId, rec.cwd, rec.memory.path);
    if (st) rec.memory = { ...rec.memory, bytes: st.bytes, updatedAt: st.updatedAt };
  } catch {}
}

// A worker finished a turn, started one, or was stopped.
runner.onStatus((session) => {
  if (!workerIndex.size) return;
  const cid = workerIndex.get(session.id) || (session.continuedFrom ? chainIds(session).map((id) => workerIndex.get(id)).find(Boolean) : undefined);
  const rec = cid && clusters.get(cid);
  if (!rec) return;
  const w = rec.workers.find((x) => chainIds(session).includes(x.sessionId) || x.sessionId === session.id);
  if (!w) return;
  if (WORKING.includes(session.status)) {
    w.ran = true;
    w.finishedAt = null;
    rec.stoppedAt = null;
  } else if (w.ran && (session.status === 'idle' || session.status === 'error')) {
    // A turn that ended because stop() cut it short is not a finished worker:
    // it did not get to the end of its task, and the page must not count it as done.
    w.finishedAt = w.cutOff && session.status === 'idle' ? null : now();
    w.cutOff = false;
  } else return;
  // A cluster still being made is not shown or saved yet: it may yet be taken back.
  if (rec.phase === 'starting') return;
  persist(rec);
  announce(rec);
  if (!WORKING.includes(session.status)) {
    // A turn ended: the workers may have written to the memory meanwhile.
    refreshMemory(rec).then(() => {
      persist(rec);
      announce(rec);
    });
  }
});

function chainIds(session) {
  try {
    return store.chainOf(store.leafOf(session) || session).map((n) => n.id);
  } catch {
    return [session.id];
  }
}

// ---------------------------------------------------------------- queries

export function getRecord(cid) {
  const rec = clusters.get(String(cid));
  if (!rec) throw fail(404, '找不到這個叢集');
  return rec;
}

export async function get(cid) {
  const rec = getRecord(cid);
  await refreshMemory(rec);
  return publicCluster(rec);
}

// The clusters of a conversation (any node of its chain made them), newest first.
export function listFor(session) {
  const ids = new Set(chainIds(session));
  return [...clusters.values()]
    .filter((rec) => ids.has(rec.parentId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicCluster);
}

// ------------------------------------------------------------------ memory

export async function readMemoryOf(cid) {
  const rec = getRecord(cid);
  const r = await mem.readMemory(rec.machineId, rec.cwd, rec.memory.path);
  if (!r.exists) throw fail(404, '叢集記憶檔不見了（可能被刪掉）：' + rec.memory.path);
  rec.memory = { ...rec.memory, bytes: r.bytes, updatedAt: r.updatedAt };
  return { path: rec.memory.path, text: r.text, bytes: r.bytes, updatedAt: r.updatedAt, ...(r.from > 0 ? { truncated: true, from: r.from } : {}) };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export async function appendDecision(cid, text) {
  const rec = getRecord(cid);
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw fail(400, '要追加的內容是空的');
  if (body.length > mem.APPEND_MAX_CHARS) throw fail(400, `一次最多追加 ${mem.APPEND_MAX_CHARS} 個字`);
  await mem.appendMemory(rec.machineId, rec.cwd, rec.memory.path, `\n## 主對話決定（${stamp()}）\n\n${body}`);
  const out = await readMemoryOf(cid);
  persist(rec);
  announce(rec);
  return out;
}

// -------------------------------------------------------------- the brief

// What the main conversation said last, oldest first, in at most `max`
// characters, with every credential-looking thing masked BEFORE it is cut (a
// key cut in half must not survive as its first half) and once more over the
// whole. Strict masking (redact), not the lighter one events go through: this
// text goes to other conversations.
export function excerptOf(session, max = EXCERPT_MAX_CHARS) {
  const leaf = store.leafOf(session) || session;
  const lines = [];
  let used = 0;
  const items = store.chainItems(leaf);
  for (let i = items.length - 1; i >= 0 && used < max; i--) {
    const ev = items[i].ev;
    if ((ev.type !== 'user' && ev.type !== 'text') || !String(ev.text || '').trim()) continue;
    const line = `${ev.type === 'user' ? '用戶' : '助理'}：${clipMiddle(redact(ev.text).trim(), 1500)}`;
    if (used + line.length + 2 > max) {
      if (!lines.length) lines.push(clip(line, max));
      break;
    }
    lines.unshift(line);
    used += line.length + 2;
  }
  return clip(redact(lines.join('\n\n')), max);
}

export function buildBrief({ cid, n, total, task, tasks, worktree, folder, branch, cwd, isolate, mode, memoryPath, note, excerpt }) {
  const out = [`你是叢集 ${cid} 的工作者 w${n}（共 ${total} 個）。這份簡報是派工，不是閒聊；讀完請直接開始做。`, '', `## 你的任務：${task.title}`, '', task.prompt, '', '## 工作範圍'];
  if (isolate && mode === 'fork') {
    out.push(`你專屬的 git worktree：${worktree}（分支 ${branch}）。你的對話是從主對話分叉出來的，所以目前的工作資料夾是主專案資料夾 ${cwd}，不是你的 worktree。所有讀、寫、指令一律用 ${worktree} 開頭的絕對路徑（或先 cd 進去再做）；不要編輯 ${cwd} 裡的檔案，也不要碰其他工作者的資料夾。`);
  } else if (isolate) {
    out.push(`你專屬的 git worktree：${worktree}（分支 ${branch}）。只在這個資料夾裡改檔；不要碰其他工作者的資料夾，也不要動主專案資料夾 ${cwd}。${folder && folder !== worktree ? `你的工作資料夾是 ${folder}（和主對話在專案裡的位置相同）。` : ''}`);
  } else {
    out.push(`這個叢集的工作者共用同一個資料夾 ${cwd}。改檔前先看 git status、重新讀過要改的檔，避免蓋掉別人的修改。`);
  }
  out.push(
    '',
    '## 叢集記憶',
    '',
    `檔案：${memoryPath}`,
    `- 重要的結論、介面決定、踩到的坑，追加到這個檔案的結尾（只追加，不要改寫舊內容）；其他工作者和主對話都會讀到。建議用 Bash：cat >> '${memoryPath}' <<'EOF' … EOF`,
    '- 在檢查點（開始新的子任務前、準備回報前）重新讀一次這個檔。Agent Hub 也會在你的下一則訊息前，附上它新增的部分。',
    '- 這個檔在 git 之外，不要 commit 它。',
  );
  if (note?.trim()) out.push('', '## 主對話交代', '', note.trim());
  if (tasks.length > 1) out.push('', '## 同時進行的任務', '', ...tasks.map((t, i) => `- w${i + 1}${i + 1 === n ? '（你）' : ''}：${t.title}`));
  out.push('', '## 完成時');
  if (isolate) out.push('', `把你的改動 commit 到分支 ${branch}（小而清楚的 commit）；沒有 commit 的改動不會被合併。`);
  out.push('', '最後用下面固定的四段回報：', '', '### 做了什麼', '### 改了哪些檔', '### 怎麼驗證', '### 未完成什麼');
  if (excerpt) out.push('', '## 主對話最近的對話摘錄（舊到新，已遮蔽金鑰，只當背景）', '', excerpt);
  return out.join('\n');
}

// ------------------------------------------------------------------- git

// Where the conversation's folder stands in git, asked of the computer.
// null for a folder that is not in a work tree.
async function inspectGit(machineId, cwd) {
  const script = [
    'top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo AHC_NOGIT; exit 0; }',
    // Where the conversation's folder is inside the project ("" at its root, "web/app/" below it).
    'echo "AHC_PREFIX=$(git rev-parse --show-prefix 2>/dev/null)"',
    'cd "$top" 2>/dev/null || { echo AHC_NOGIT; exit 0; }',
    'echo "AHC_TOP=$(pwd -P)"',
    'echo "AHC_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)"',
    'if git rev-parse --verify -q HEAD >/dev/null 2>&1; then echo "AHC_HEAD=$(git rev-parse HEAD)"; else echo "AHC_HEAD="; fi',
    'echo "AHC_BRANCH=$(git symbolic-ref --short -q HEAD)"',
    'echo "AHC_DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d " ")"',
  ].join('\n');
  const r = await mem.sh(machineId, cwd, script);
  if (r.exitCode !== 0) throw fail(502, `看不到主對話資料夾的 git 狀態：${r.output.trim().slice(0, 200)}`);
  if (/^AHC_NOGIT\s*$/m.test(r.output) || !mem.field(r.output, 'AHC_TOP') || !mem.field(r.output, 'AHC_COMMON')) return null;
  return {
    top: mem.field(r.output, 'AHC_TOP'),
    common: mem.field(r.output, 'AHC_COMMON'),
    prefix: (mem.field(r.output, 'AHC_PREFIX') || '').replace(/\/+$/, ''),
    head: mem.field(r.output, 'AHC_HEAD') || '',
    branch: mem.field(r.output, 'AHC_BRANCH') || '',
    dirty: Number(mem.field(r.output, 'AHC_DIRTY')) || 0,
  };
}

const dotted = (p) => p.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');

// The folder the workers' worktrees go in: beside the project, or (when that
// path has a dot folder in it - tools that skip hidden folders would not see
// the files) in the computer's agent-hub-workspaces. null when neither is fit.
function containerFor(top, cid, home) {
  const name = `${path.posix.basename(top)}-cluster-${cid}`;
  const beside = path.posix.join(path.posix.dirname(top), name);
  if (!dotted(beside)) return beside;
  const fallback = home ? path.posix.join(String(home).replace(/\/+$/, ''), 'agent-hub-workspaces', name) : null;
  return fallback && !dotted(fallback) ? fallback : null;
}

const gitIn = (dir, args, { quiet = false } = {}) => `git -C ${mem.quote(dir)} ${args}${quiet ? ' >/dev/null 2>&1' : ' 2>&1'}`;

// ------------------------------------------------------------ creating

function parseRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const mode = b.mode === undefined ? 'brief' : b.mode;
  if (mode !== 'brief' && mode !== 'fork') throw fail(400, 'mode 只能是 brief（簡報起跑）或 fork（完整分叉）');
  for (const k of ['isolate', 'swarm']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw fail(400, `${k} 必須是 true 或 false`);
  if (b.note !== undefined && typeof b.note !== 'string') throw fail(400, 'note 必須是文字');
  if ((b.note || '').length > MAX_NOTE) throw fail(400, `給全部工作者的話最多 ${MAX_NOTE} 個字`);
  if (!Array.isArray(b.tasks) || !b.tasks.length) throw fail(400, '至少要有一個任務');
  if (b.tasks.length > MAX_WORKERS) throw fail(400, `叢集第一版最多 ${MAX_WORKERS} 個工作者`);
  const tasks = b.tasks.map((t, i) => {
    const title = typeof t?.title === 'string' ? t.title.replace(/\s+/g, ' ').trim() : '';
    const prompt = typeof t?.prompt === 'string' ? t.prompt.trim() : '';
    if (!title) throw fail(400, `第 ${i + 1} 個任務沒有標題`);
    if (!prompt) throw fail(400, `第 ${i + 1} 個任務沒有內容`);
    if (title.length > MAX_TITLE) throw fail(400, `第 ${i + 1} 個任務的標題最多 ${MAX_TITLE} 個字`);
    if (prompt.length > MAX_PROMPT) throw fail(400, `第 ${i + 1} 個任務的內容最多 ${MAX_PROMPT} 個字`);
    return { title, prompt };
  });
  return { tasks, mode, isolate: b.isolate !== false, swarm: b.swarm !== false, note: (b.note || '').trim() };
}

// What the parent runs on, to be given to every worker: the same provider and
// model and thinking, the same subagent setting, the same permission.
async function inheritFrom(parent) {
  const provider = runner.providerOf(parent);
  const mc = parent.modelConfig || {};
  const model = mc.model || (provider === 'deepseek' ? parent.state?.deepseek?.model : '') || parent.meta?.model || '';
  // A conversation that never chose a thinking strength reads "off" in its
  // record, which most models do not list as one: a strength the model does
  // not offer is not handed on (the worker then has the model's own default).
  let effort = mc.effort || parent.meta?.effort || '';
  if (effort) {
    try {
      await runner.validateChoice({ provider, model, effort, session: parent, allowEmptyModel: true });
    } catch {
      effort = '';
    }
  }
  const permission = ['manual', 'yolo', 'auto'].includes(parent.meta?.permission) ? parent.meta.permission : undefined;
  // An explicit "native rules" (null) stays null; an unmarked default is not
  // copied as if it were a choice (the worker gets the same default).
  let subagent;
  if (parent.meta?.subagent) subagent = structuredClone(parent.meta.subagent);
  else if (parent.state?.subagentExplicit) subagent = null;
  return { provider, model, effort, permission, subagent };
}

export async function create(parentNode, body) {
  const parent = store.leafOf(parentNode) || parentNode;
  const req = parseRequest(body);
  const provider = runner.providerOf(parent);
  if (provider === 'claude' || !parent.kimiSessionId || !parent.machineId) throw fail(400, '叢集第一版只支援 Kimi／DeepSeek 對話');
  if (runner.isSwitching(parent)) throw fail(409, '這個對話正在切換接續節點，請稍後再派工');
  const machine = machines.getMachine(parent.machineId);
  if (!machine) throw fail(404, '找不到這個對話所在的電腦');
  if (!machine.online) throw fail(409, `機器「${machine.name}」目前離線：請在那台機器上執行連接器`);
  if (machine.platform === 'win32') throw fail(409, '叢集第一版需要 macOS 或 Linux 的電腦（要用 bash 與 git）');
  if (req.mode === 'fork' && WORKING.includes(parent.status)) throw fail(409, '主對話正在執行中，沒辦法分叉；等它停下來再派工，或改用簡報起跑');

  const cid = `c_${crypto.randomBytes(6).toString('hex')}`;
  const warnings = [];
  const git = await inspectGit(parent.machineId, parent.cwd);
  let isolate = req.isolate;
  let container = null;
  if (isolate && !git) {
    isolate = false;
    warnings.push('不是 git 專案，工作者共用同一個資料夾，可能互相覆蓋');
  } else if (isolate && !git.head) {
    isolate = false;
    warnings.push('這個 git 專案還沒有任何 commit，沒辦法開獨立 worktree，工作者共用同一個資料夾，可能互相覆蓋');
  } else if (isolate) {
    container = containerFor(git.top, cid, machine.home);
    if (!container) {
      isolate = false;
      warnings.push('專案所在的路徑含有以點開頭的資料夾，電腦的 agent-hub-workspaces 也不能用，沒辦法放 worktree；工作者共用同一個資料夾，可能互相覆蓋');
    }
  } else if (!req.isolate) {
    warnings.push('沒有開「每個工作者獨立 worktree」，工作者共用同一個資料夾，可能互相覆蓋');
  }
  if (isolate && git.dirty) warnings.push(`主對話的資料夾有 ${git.dirty} 項還沒 commit 的修改；工作者的 worktree 從目前的 HEAD 開始，看不到那些修改`);
  if (isolate && req.mode === 'fork') warnings.push('完整分叉的工作者從主對話的資料夾起跑，不在各自的 worktree 裡；簡報已要求它們所有編輯都用 worktree 的絕對路徑，但這要靠模型照做，沒有機制強制');
  const ctxUsed = parent.meta?.context;
  if (req.mode === 'fork' && ctxUsed?.size && ctxUsed.used / ctxUsed.size >= 0.5) {
    warnings.push(`主對話的上下文已用 ${Math.round((ctxUsed.used / ctxUsed.size) * 100)}%，每個分叉都帶著它起跑，很快會碰到上限；建議改用「簡報起跑」`);
  }

  const memoryPath = git ? `${git.common}/agent-hub-cluster/${cid}/memory.md` : `${parent.cwd.replace(/\/+$/, '')}/.agent-hub-cluster/${cid}/memory.md`;
  const rec = {
    id: cid,
    parentId: parent.id,
    machineId: parent.machineId,
    cwd: parent.cwd,
    createdAt: now(),
    phase: 'starting',
    mode: req.mode,
    isolate,
    swarm: req.swarm,
    note: req.note,
    warnings,
    repo: isolate ? { top: git.top, common: git.common, head: git.head, container } : null,
    memory: { path: memoryPath, bytes: 0, updatedAt: null },
    workers: [],
    merge: null,
    stoppedAt: null,
  };
  const made = { memory: false, worktrees: [], sessions: [] };
  clusters.set(cid, rec);
  try {
    await mem.createMemory(parent.machineId, parent.cwd, memoryPath, memoryHeader(rec, req.tasks), { ignoreFolder: !git });
    made.memory = true;
    await refreshMemory(rec);
    const startOffset = rec.memory.bytes || 0;

    // Worktrees first, one after the other: git takes locks of its own and the
    // order of branches is the order of workers.
    // A conversation working in a folder below the project's root gets the same
    // folder in its worktree.
    const plan = req.tasks.map((task, i) => ({ task, n: i + 1, branch: isolate ? `cluster/${cid}/w${i + 1}` : null, worktree: isolate ? `${container}/w${i + 1}` : null, folder: isolate ? (git.prefix ? `${container}/w${i + 1}/${git.prefix}` : `${container}/w${i + 1}`) : parent.cwd }));
    if (isolate) {
      for (const w of plan) {
        const r = await mem.sh(parent.machineId, git.top, gitIn(git.top, `worktree add -b ${mem.quote(w.branch)} ${mem.quote(w.worktree)} ${mem.quote(git.head)}`));
        if (r.exitCode !== 0) throw fail(502, `建不起 w${w.n} 的 git worktree：${r.output.trim().slice(0, 300)}`);
        made.worktrees.push(w);
      }
    }

    const inherited = await inheritFrom(parent);
    const excerpt = req.mode === 'brief' ? excerptOf(parent) : '';
    const settle = (w, session) => {
      made.sessions.push(session.id);
      session.clusterId = cid;
      session.clusterRole = 'worker';
      session.clusterMemo = { path: memoryPath, offset: startOffset };
      session.titled = true;
      store.saveSession(session);
      return session;
    };
    const openOne = async (w) => {
      let session;
      if (req.mode === 'fork') {
        const forked = await runner.command(parent, 'fork', w.task.title);
        session = settle(w, store.getSession(forked.session.id));
      } else {
        session = settle(w, await runner.newSession({
          provider: inherited.provider,
          machineId: parent.machineId,
          cwd: w.folder,
          permissionMode: parent.permissionMode,
          title: w.task.title,
          subagent: inherited.subagent,
          config: {
            ...(inherited.model ? { model: inherited.model } : {}),
            ...(inherited.effort ? { effort: inherited.effort } : {}),
            ...(inherited.permission ? { permission: inherited.permission } : {}),
          },
        }));
        // Kimi names a conversation after its first message unless told.
        await runner.command(session, 'title', w.task.title).catch(() => {});
      }
      rec.workers.push({ sessionId: session.id, title: w.task.title, task: w.task.prompt, branch: w.branch, worktree: w.worktree, folder: w.folder, finishedAt: null, ran: false, n: w.n });
      workerIndex.set(session.id, cid);
      if (req.swarm) {
        try {
          await runner.configure(session, { swarmMode: true });
        } catch (err) {
          warnings.push(`w${w.n}「${w.task.title}」沒能開啟原生 Swarm 模式：${err.message}`);
        }
      }
      return session;
    };
    if (req.mode === 'fork') {
      // One native :fork at a time: the source is one conversation.
      for (const w of plan) await openOne(w);
    } else {
      const results = await Promise.allSettled(plan.map(openOne));
      const bad = results.find((r) => r.status === 'rejected');
      if (bad) throw bad.reason;
    }
    rec.workers.sort((a, b) => a.n - b.n);

    // Every conversation exists; only now do any of them start.
    const briefs = rec.workers.map((w) => ({
      w,
      text: buildBrief({ cid, n: w.n, total: plan.length, task: { title: w.title, prompt: w.task }, tasks: req.tasks, worktree: w.worktree, folder: w.folder, branch: w.branch, cwd: parent.cwd, isolate, mode: req.mode, memoryPath, note: req.note, excerpt }),
    }));
    for (const { w, text } of briefs) {
      const r = await runner.deliver(store.getSession(w.sessionId), text, { note: '叢集派工簡報' });
      if (r?.ok === false) throw fail(502, `w${w.n} 沒有收到簡報：${r.error || 'Kimi 沒有回應'}`);
    }

    rec.phase = null;
    parent.clusterIds = [...(parent.clusterIds || []), cid];
    store.saveSession(parent, { touch: false });
    persist(rec);
    broadcast({ t: 'session', session: runner.summarize(parent) });
    for (const w of rec.workers) {
      const s = store.getSession(w.sessionId);
      if (s) broadcast({ t: 'session', session: runner.summarize(s) });
    }
    announce(rec, { force: true });
    return { cluster: publicCluster(rec), warnings: [...warnings] };
  } catch (err) {
    await recycle(rec, made).catch((e) => console.warn(`[cluster] ${cid} not fully cleaned up: ${e.message}`));
    throw err.status ? err : fail(502, err.message || String(err));
  }
}

function memoryHeader(rec, tasks) {
  return [
    `# 叢集記憶 ${rec.id}`,
    '',
    `建立於 ${stamp(new Date(rec.createdAt))}。這個檔案在 git 之外，只追加、不改寫；主對話與每個工作者都讀得到。`,
    ...(rec.note ? ['', '## 主對話交代', '', rec.note] : []),
    '',
    '## 任務',
    '',
    ...tasks.map((t, i) => `- w${i + 1}：${t.title}`),
    '',
  ].join('\n');
}

// A cluster that could not be made whole is taken back: the conversations
// opened for it stopped and removed (they hold nothing but the brief; a fork
// is a copy, the source is untouched), a worktree removed when git says it is
// clean (git itself refuses a dirty one) with its branch, the memory folder.
async function recycle(rec, made) {
  const { machineId, cwd } = rec;
  for (const sid of made.sessions) {
    const s = store.getSession(sid);
    workerIndex.delete(sid);
    if (!s) continue;
    const { kimiSessionId } = s;
    if (WORKING.includes(s.status)) await Promise.resolve(runner.interrupt(sid)).catch(() => {});
    try {
      runner.deleteConversation(s);
    } catch (err) {
      console.warn(`[cluster] ${rec.id}: conversation ${sid} not removed: ${err.message}`);
      continue;
    }
    if (kimiSessionId) {
      machines.hideNative(machineId, kimiSessionId);
      machines.kimiApi(machineId, 'POST', `/api/v1/sessions/${kimiSessionId}:archive`, {}).catch(() => {});
    }
  }
  if (rec.repo) {
    for (const w of made.worktrees) {
      await mem.sh(machineId, cwd, `${gitIn(rec.repo.top, `worktree remove ${mem.quote(w.worktree)}`)} && ${gitIn(rec.repo.top, `branch -d ${mem.quote(w.branch)}`)}`).catch(() => {});
    }
    await mem.sh(machineId, cwd, `rmdir ${mem.quote(rec.repo.container)} 2>/dev/null; true`).catch(() => {});
  }
  if (made.memory) {
    const dir = rec.memory.path.replace(/\/[^/]*$/, '');
    // Only the folder this cluster made, by its own name.
    if (dir.endsWith(`/agent-hub-cluster/${rec.id}`) || dir.endsWith(`/.agent-hub-cluster/${rec.id}`)) await mem.sh(machineId, cwd, `rm -rf ${mem.quote(dir)}; rmdir ${mem.quote(dir.replace(/\/[^/]*$/, ''))} 2>/dev/null; true`).catch(() => {});
  }
  clusters.delete(rec.id);
  lastSent.delete(rec.id);
  fs.rmSync(fileOf(rec.id), { force: true });
}

// ---------------------------------------------------------------- stop

export async function stop(cid) {
  const rec = getRecord(cid);
  let any = false;
  for (const w of rec.workers) {
    const s = leafOfWorker(w);
    if (!s || !WORKING.includes(s.status)) continue;
    any = true;
    w.cutOff = true; // the turn that ends next ends because of this stop
    await Promise.resolve(runner.interrupt(s.id)).catch((err) => {
      w.cutOff = false;
      console.warn(`[cluster] ${cid}: ${s.id} not interrupted: ${err.message}`);
    });
  }
  if (any) rec.stoppedAt = now();
  persist(rec);
  announce(rec, { force: true });
  return publicCluster(rec);
}

// --------------------------------------------------------------- merge

export async function merge(cid) {
  const rec = getRecord(cid);
  if (!rec.isolate || !rec.repo) throw fail(409, '只有「每個工作者獨立 worktree」的 git 叢集才能合併');
  if (rec.phase) throw fail(409, rec.phase === 'merging' ? '正在合併中' : '叢集還在建立中');
  const machine = machines.getMachine(rec.machineId);
  if (!machine?.online) throw fail(409, `機器「${machine?.name || rec.machineId}」目前離線：請在那台機器上執行連接器`);
  const { machineId } = rec;
  const dir = rec.cwd;
  const branch = `cluster/${rec.id}/merged`;
  const tree = `${rec.repo.container}/merged`;
  const run = (command, opts) => mem.sh(machineId, dir, command, opts);

  const exists = await run(gitIn(dir, `rev-parse --verify -q ${mem.quote(`refs/heads/${branch}`)}`, { quiet: true }));
  if (exists.exitCode === 0) throw fail(409, `合併用的分支 ${branch} 已經存在（上次合併留下的）。要重新合併，請先在專案裡刪掉它（git branch -D ${branch}），或直接用它`);

  rec.phase = 'merging';
  announce(rec, { force: true });
  const created = { tree: false };
  try {
    const head = await run(gitIn(dir, 'rev-parse HEAD'));
    if (head.exitCode !== 0) throw fail(502, `讀不到主對話目前的 HEAD：${head.output.trim().slice(0, 200)}`);
    // A leftover of an earlier attempt that died in the middle.
    await run(`${gitIn(dir, `worktree remove --force ${mem.quote(tree)}`, { quiet: true })}; ${gitIn(dir, 'worktree prune', { quiet: true })}; true`);
    const add = await run(gitIn(dir, `worktree add -b ${mem.quote(branch)} ${mem.quote(tree)} ${mem.quote(head.output.trim())}`));
    if (add.exitCode !== 0) throw fail(502, `建不起合併用的 worktree：${add.output.trim().slice(0, 300)}`);
    created.tree = true;
    const hasIdentity = (await run(gitIn(tree, 'config user.email', { quiet: true }))).exitCode === 0;
    const identity = hasIdentity ? '' : "-c user.name='Agent Hub' -c user.email='agent-hub@localhost' ";

    const results = [];
    for (const w of rec.workers) {
      const entry = { sessionId: w.sessionId, branch: w.branch, ok: false, conflicts: [] };
      const message = `Merge cluster ${rec.id} w${w.n}: ${w.title}`.replace(/[\r\n]+/g, ' ');
      const script = [
        `cd ${mem.quote(tree)} || exit 3`,
        `git rev-parse --verify -q ${mem.quote(`refs/heads/${w.branch}`)} >/dev/null 2>&1 || { echo AHC_NOBRANCH; exit 0; }`,
        `out=$(git ${identity}merge --no-ff -m ${mem.quote(message)} ${mem.quote(w.branch)} 2>&1); rc=$?`,
        'if [ $rc -ne 0 ]; then',
        '  echo AHC_CONFLICTS',
        '  git diff --name-only --diff-filter=U',
        '  echo AHC_END',
        '  git merge --abort >/dev/null 2>&1 || git reset -q --hard >/dev/null 2>&1',
        'fi',
        'echo "AHC_RC=$rc"',
        'echo "$out"',
      ].join('\n');
      const r = await run(script);
      if (r.exitCode !== 0) throw fail(502, `合併 w${w.n} 時出錯：${r.output.trim().slice(0, 300)}`);
      if (/^AHC_NOBRANCH\s*$/m.test(r.output)) entry.error = `找不到分支 ${w.branch}`;
      else if (mem.field(r.output, 'AHC_RC') === '0') entry.ok = true;
      else {
        const block = /^AHC_CONFLICTS\n([\s\S]*?)^AHC_END$/m.exec(r.output)?.[1] || '';
        entry.conflicts = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!entry.conflicts.length) entry.error = r.output.slice(r.output.indexOf('AHC_RC=')).split('\n').slice(1).join(' ').trim().slice(0, 300) || '合併失敗';
      }
      results.push(entry);
    }
    // The merge happened in a worktree of its own so the one the main
    // conversation works in was never touched; that worktree is not needed
    // any more, the branch stays.
    await run(`${gitIn(dir, `worktree remove --force ${mem.quote(tree)}`, { quiet: true })}; ${gitIn(dir, 'worktree prune', { quiet: true })}; true`);
    created.tree = false;
    rec.merge = { branch, at: now(), results };
    rec.phase = null;
    persist(rec);
    announceMerge(rec, head.output.trim());
    announce(rec, { force: true });
    return publicCluster(rec);
  } catch (err) {
    // Half a merge is not kept: what this attempt made goes, so it can be tried again.
    await run(`${created.tree ? `${gitIn(dir, `worktree remove --force ${mem.quote(tree)}`, { quiet: true })}; ` : ''}${gitIn(dir, 'worktree prune', { quiet: true })}; ${gitIn(dir, `branch -D ${mem.quote(branch)}`, { quiet: true })}; true`).catch(() => {});
    rec.phase = null;
    announce(rec, { force: true });
    throw err.status ? err : fail(502, err.message || String(err));
  }
}

// A system line in the main conversation (an info event: not a message from
// the user, and Kimi is not sent it).
function announceMerge(rec, head) {
  const parent = store.getSession(rec.parentId);
  if (!parent) return;
  const leaf = store.leafOf(parent) || parent;
  const m = rec.merge;
  const ok = m.results.filter((r) => r.ok);
  const bad = m.results.filter((r) => !r.ok);
  const label = (r) => `w${rec.workers.find((w) => w.sessionId === r.sessionId)?.n ?? '?'}`;
  const text = [
    `叢集 ${rec.id} 合併完成：分支 ${m.branch}（從 ${head.slice(0, 7)} 起，依序合併 ${m.results.length} 個工作者）。`,
    ok.length ? `成功：${ok.map(label).join('、')}。` : '沒有任何工作者合併成功。',
    bad.length ? `沒合進去：${bad.map((r) => `${label(r)}（${r.conflicts.length ? `衝突 ${r.conflicts.join('、')}` : r.error || '失敗'}）`).join('、')}。` : '',
    `你目前的分支和工作樹沒有被動到；要採用結果，在專案資料夾執行 git merge ${m.branch}。`,
  ].filter(Boolean).join('');
  runner.liveContext(leaf).emit({ type: 'info', text });
}
