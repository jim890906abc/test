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
import { subagentsOf, stepsOfNode } from './cluster-subagents.js';
import * as roster from './subagent-roster.js';
import * as timing from './timing.js';
import { summarizeCluster, autoClusterName, cleanClusterName, CLUSTER_NAME_MAX } from '../public/js/cluster-model.js';

export const MAX_WORKERS = 8;
// More tasks than workers is allowed: a worker that finishes a task is given
// the next one that is waiting, in its own conversation (see "the queue" below).
export const MAX_TASKS = 64;
export const DEFAULT_WORKERS = 4;
// A task is handed out at most twice: once, and once more after the first
// worker failed with it. A second failure is the task's own, not retried again.
export const MAX_ATTEMPTS = 2;
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
const cleaning = new Set(); // cluster ids being cleaned up right now (in memory only: a restart ends it)
const feeding = new Map(); // worker session id -> { ended, error } while the next task is on its way to it (in memory only)
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
      adoptQueue(rec);
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

// How fast a worker is generating, the chat room's own number (the adapter keeps
// it in the conversation's meta as `tps`: the tokens Kimi counted over the time
// it measured them streaming, the last ten steps - nothing is estimated here).
// Only a worker that is running has one to show: a finished or idle worker's last
// rate is not "now", and 0 would read as slow. Null says why.
function generationOf(s) {
  if (!s) return { tokensPerSecond: null, unmeasured: '這個工作者的對話已被刪除' };
  if (!WORKING.includes(s.status)) return { tokensPerSecond: null, unmeasured: '這個工作者現在沒有在跑，沒有「現在」的生成速度（上一輪的數字不當成現在的；對話裡還留著）' };
  const tps = s.meta?.tps;
  if (!(typeof tps === 'number' && Number.isFinite(tps) && tps > 0)) return { tokensPerSecond: null, unmeasured: '這一輪還沒有完成任何一步，或這個模型沒有回報串流時間；要等 Kimi 回報一步的字數與串流時間才量得到' };
  return { tokensPerSecond: tps, unmeasured: null };
}

function statusOf(rec) {
  if (rec.phase) return rec.phase;
  const live = rec.workers.map(leafOfWorker);
  if (live.some((s) => s && WORKING.includes(s.status))) return 'running';
  // Tasks still waiting for a worker (or handed to one that has not started yet): not done.
  if (queueOpen(rec)) return 'running';
  if (rec.stoppedAt) return 'stopped';
  // A stop ends the dispatching for good: what was never handed out stays waiting, and the cluster reads stopped.
  if (rec.halted && pendingOf(rec).length) return 'stopped';
  if (rec.workers.length && rec.workers.every((w) => w.finishedAt)) {
    const tasks = tasksOf(rec);
    return (tasks.length ? tasks.every((t) => t.status === 'failed') : live.every((s) => !s || s.status === 'error')) ? 'error' : 'done';
  }
  return 'running';
}

function parentTitleOf(rec) {
  const p = store.getSession(rec.parentId);
  return p ? (store.leafOf(p) || p).title ?? '' : null;
}

export function publicCluster(rec) {
  const leaves = rec.workers.map(leafOfWorker);
  const chains = leaves.map((s) => (s ? store.chainOf(s) : []));
  // 步數: the tool calls in each worker's conversation (all of its nodes, subagents' included), counted the
  // way the conversation's cards count them. A worker whose conversation was deleted keeps the number
  // it was last seen at (written down here, saved with the record); one never seen at all is not guessed.
  const steps = rec.workers.map((w, i) => {
    if (!leaves[i]) return Number.isFinite(w.stepsSeen) ? w.stepsSeen : null;
    w.stepsSeen = chains[i].reduce((a, n) => a + stepsOfNode(n), 0);
    return w.stepsSeen;
  });
  const counted = steps.filter((n) => n !== null);
  return {
    id: rec.id,
    // The cluster's own name, never the main conversation's title.
    name: cleanClusterName(rec.name) || autoClusterName(tasksOf(rec)) || '叢集',
    parentId: rec.parentId,
    // The main conversation's title as it is now; null: it has been deleted.
    parentTitle: parentTitleOf(rec),
    createdAt: rec.createdAt,
    status: statusOf(rec),
    mode: rec.mode,
    isolate: rec.isolate,
    swarm: rec.swarm,
    warnings: [...rec.warnings],
    // What the whole cluster - its workers and their subagents - produced in the last minute: one window over all of their conversations (the request records tie a subagent to its worker's session id).
    throughput: timing.recentOutput(chains, { from: rec.createdAt }),
    steps: counted.length ? counted.reduce((a, n) => a + n, 0) : null,
    // Workers whose steps cannot be said (the conversation is gone and was never counted): not in `steps`.
    stepsUnknown: steps.length - counted.length,
    workers: rec.workers.map((w, i) => {
      const s = leaves[i];
      // Its subagents, one entry each (an AgentSwarm's members too), judged by the conversation's own rules.
      const sub = subagentsOf(s, { childStatus: (id) => store.getSession(id)?.status });
      // 平均產出: the connector's request records, added up over the last five minutes, waiting included (null and why where they cannot say).
      const speed = timing.recentSpeed(chains[i], { from: rec.createdAt });
      return {
        sessionId: w.sessionId,
        title: w.title,
        steps: steps[i],
        task: clip(w.task, TASK_SHOWN),
        status: s ? s.status : 'deleted',
        branch: w.branch || null,
        worktree: w.worktree || null,
        // What the native says, not what was asked: Kimi can turn it off by itself.
        swarm: Boolean(s?.meta?.swarmMode),
        progress: progressOf(s),
        finishedAt: w.finishedAt || null,
        // Taken off the sidebar by a clean-up (the conversation itself is kept).
        hidden: Boolean(s?.clusterHidden),
        // The queue, from this worker's side: the task it is on now (its index
        // in `tasks`, from 0) and how many it has finished. Both are read from
        // the tasks, which are the one place that says who did what.
        taskIndex: taskOf(rec, w)?.index ?? null,
        done: tasksOf(rec).filter((t) => t.status === 'done' && t.workerSessionId === w.sessionId).length,
        // The newest 160 (oldest first); `subagentCounts` is over every one the Hub knows,
        // `subagentsOlder` how many more it let go of (always said, never silently left out).
        subagents: sub.list,
        subagentCounts: sub.counts,
        subagentsOlder: sub.older,
        speed,
        // How fast it generates right now, as the chat room says it (null and why where it does not).
        gen: generationOf(s),
      };
    }),
    // Every task, in the order given. Times are the Hub's own clock: `startedAt`
    // when the task was handed to its worker, `finishedAt` when the Hub saw that
    // worker's turn end. `attempts` is how many times it was handed out (a task
    // whose worker failed is handed out once more); `error` says why one failed
    // or was handed back.
    tasks: tasksOf(rec).map((t) => ({ index: t.index, title: t.title, status: t.status, workerSessionId: t.workerSessionId || null, startedAt: t.startedAt || null, finishedAt: t.finishedAt || null, attempts: t.attempts || 0, error: t.error || null })),
    memory: { path: rec.memory.path, bytes: rec.memory.bytes ?? 0, updatedAt: rec.memory.updatedAt ?? null },
    merge: rec.merge || null,
    cleanup: publicCleanup(rec),
    // Set only by a full purge that could not take everything away: the cluster is kept, marked, and the button works again.
    purge: rec.purge ? { at: rec.purge.at, partial: Boolean(rec.purge.partial), failed: [...(rec.purge.failed || [])] } : null,
  };
}

// What the last clean-up did. Whether a conversation is hidden is read from the
// conversation (the one place it is kept), not from what was written then: a
// person may have put it back since.
function publicCleanup(rec) {
  if (!rec.cleanup) return null;
  return { at: rec.cleanup.at, auto: rec.cleanup.auto, results: rec.cleanup.results.map((r) => ({ ...r, reasons: [...r.reasons], hidden: isHidden(rec.workers.find((w) => w.sessionId === r.sessionId)) })) };
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

// A subagent that claims to run and has nothing to back it up reads unknown
// after a minute of silence (agent-state.js) - by the clock alone, with no event
// to say so. So now and then the clusters that have such a claim are read again;
// nothing is sent when nothing changed.
const RECHECK_MS = 15_000;
const recheckTimer = setInterval(() => {
  for (const rec of clusters.values()) {
    if (rec.phase) continue;
    if (rec.workers.some((w) => roster.rosterOf(leafOfWorker(w)).list.some((e) => !['done', 'error', 'cancelled'].includes(e.status)))) announce(rec);
  }
}, RECHECK_MS);
recheckTimer.unref?.();

// A worker's events or status moved: say so, but not once per token, and not more
// than once a second (a swarm of 128 changes something every few milliseconds).
const ANNOUNCE_EVERY_MS = 1000;
const announceTimers = new Map();
export function noteActivity(sessionId) {
  if (!workerIndex.size) return;
  // A worker's conversation that is no longer there was deleted: its task goes back to the queue.
  const own = workerIndex.get(sessionId);
  if (own && !store.getSession(sessionId)) setImmediate(() => workerGone(own, sessionId));
  // A worker that went on in a new node of its chain speaks under the new node's id; the node knows its cluster.
  const cid = own || store.getSession(sessionId)?.clusterId;
  if (!cid || !clusters.has(cid) || announceTimers.has(cid)) return;
  const t = setTimeout(() => {
    announceTimers.delete(cid);
    const rec = clusters.get(cid);
    if (rec) announce(rec);
  }, ANNOUNCE_EVERY_MS);
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

// The worker a conversation node belongs to, with its cluster record.
function workerOf(session) {
  const cid = workerIndex.get(session.id) || (session.continuedFrom ? chainIds(session).map((id) => workerIndex.get(id)).find(Boolean) : undefined);
  const rec = cid && clusters.get(cid);
  if (!rec) return null;
  const ids = chainIds(session);
  const w = rec.workers.find((x) => ids.includes(x.sessionId) || x.sessionId === session.id);
  return w ? { rec, w } : null;
}

// A worker finished a turn, started one, or was stopped.
runner.onStatus((session) => {
  if (!workerIndex.size) return;
  const hit = workerOf(session);
  if (!hit) return;
  const { rec, w } = hit;
  let pairs = [];
  if (WORKING.includes(session.status)) {
    w.ran = true;
    w.finishedAt = null;
    rec.stoppedAt = null;
    // The task it is on has been seen to start (a restart can tell a task that
    // ended while the Hub was away from one whose first turn never began).
    let t = taskOf(rec, w);
    // A person goes on with a worker that a stop cut off (a message to its
    // conversation): the work of that task goes on, and counts as done when it ends.
    if (!t) t = reviveCut(rec, w);
    if (t) t.began = true;
  } else if (w.ran && (session.status === 'idle' || session.status === 'error')) {
    const handoff = feeding.get(w.sessionId);
    if (handoff) {
      // The next task is being handed to this worker right now: the turn that
      // ended is either the task's own (it was quick) or the failed handoff.
      // The handoff decides which, when Kimi has answered it.
      handoff.ended = true;
      handoff.error = session.status === 'error';
      return;
    }
    pairs = turnEnded(rec, w, session.status);
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
  handOut(rec, pairs);
});

function chainIds(session) {
  try {
    return store.chainOf(store.leafOf(session) || session).map((n) => n.id);
  } catch {
    return [session.id];
  }
}

// -------------------------------------------------------------- the queue
//
// A cluster may have more tasks than workers. The workers are opened with the
// first tasks; whenever a worker's turn ends, the Hub gives that same
// conversation (its context, its worktree, the commits of its earlier tasks on
// the same branch) the next task that is waiting, until none is left. So the
// slowest task no longer holds up everything behind it: whoever is free takes
// the next one.
//
// Every task is in `rec.tasks`, in the order given:
//   pending   not handed out yet (or handed back after a failure)
//   running   handed to a worker (`workerSessionId`) at `startedAt`
//   done      that worker's turn ended; `finishedAt` is when the Hub saw it
//   failed    the worker's turn failed (twice), it was cut off by a stop, or no
//             worker was left to take it; `error` says which
// The times are this Hub's clock at the moment it handed the task out and at
// the moment it saw the worker go quiet: measured, not estimated.
//
// A worker whose turn failed, whose conversation was deleted, or that refused
// the next task is out of the queue (`w.out`): the task it held goes back to
// the queue ONCE (`attempts`), for another worker; a second failure ends it.
// A stop ends the dispatching for good (`rec.halted`): what was never handed
// out stays pending, nothing new is sent.

const RECONCILE_GRACE_MS = 30_000;

function tasksOf(rec) {
  return Array.isArray(rec.tasks) ? rec.tasks : [];
}
function pendingOf(rec) {
  return tasksOf(rec).filter((t) => t.status === 'pending');
}
// The task a worker is on now.
function taskOf(rec, w) {
  return tasksOf(rec).find((t) => t.status === 'running' && t.workerSessionId === w.sessionId) || null;
}
// Tasks are still waiting for a worker, or being worked on, and no stop has ended the dispatching.
function queueOpen(rec) {
  return !rec.halted && tasksOf(rec).some((t) => t.status === 'pending' || t.status === 'running');
}

// A cluster record from before the queue (or one just read from disk): its
// tasks are its workers' tasks, so every cluster has the same shape.
function adoptQueue(rec) {
  if (!Array.isArray(rec.tasks)) {
    rec.tasks = rec.workers.map((w, i) => ({
      index: i,
      title: w.title,
      prompt: '',
      status: w.finishedAt ? 'done' : rec.stoppedAt ? 'failed' : 'running',
      workerSessionId: w.sessionId,
      startedAt: rec.createdAt || null,
      finishedAt: w.finishedAt || null,
      attempts: 1,
      error: !w.finishedAt && rec.stoppedAt ? CUT_OFF : null,
      began: Boolean(w.ran),
    }));
  }
  rec.halted ??= false;
  // A cluster from before names: named the way a new one with no name is, from
  // its tasks (written down at its next save).
  if (!cleanClusterName(rec.name)) rec.name = autoClusterName(rec.tasks) || '叢集';
}

const CUT_OFF = '被「全部停止」中斷了';

const newTask = (t, index) => ({ index, title: t.title, prompt: t.prompt, status: 'pending', workerSessionId: null, startedAt: null, finishedAt: null, attempts: 0, error: null, began: false });

// The task is handed to the worker (before it is sent: the page sees it as
// running from the moment the Hub decided).
function claim(rec, w, task) {
  task.status = 'running';
  task.workerSessionId = w.sessionId;
  task.startedAt = now();
  task.finishedAt = null;
  task.error = null;
  task.began = false;
  task.attempts += 1;
  w.title = task.title;
  w.task = task.prompt;
  w.finishedAt = null;
}

function endTask(task, status, error = null) {
  task.status = status;
  task.finishedAt = now();
  task.error = error;
  // A finished task's text is not needed again; a failed one keeps it.
  if (status === 'done') task.prompt = '';
}

// A task whose worker failed: back to the queue for another worker the first
// time, failed for good the second.
function giveBack(rec, task, why) {
  if (task.attempts < MAX_ATTEMPTS && !rec.halted) {
    task.status = 'pending';
    task.workerSessionId = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.began = false;
    task.error = `${why}，已退回佇列等別的工作者接手`;
  } else {
    endTask(task, 'failed', `${why}${task.attempts >= MAX_ATTEMPTS ? '；這條已經重派過一次，不再重派' : ''}`);
  }
}

// A worker that takes no more tasks from the queue.
function retire(w, why) {
  w.out = why;
  w.finishedAt = w.finishedAt || now();
}

// Waiting tasks with no worker left to take them end as failed, so the
// cluster can end; with a worker alive (even a busy one) they wait for it.
function failStranded(rec) {
  if (rec.halted || !pendingOf(rec).length) return;
  if (rec.workers.some((w) => !w.out && store.getSession(w.sessionId))) return;
  for (const t of pendingOf(rec)) endTask(t, 'failed', '沒有可用的工作者了（都出錯或被刪除），這條沒有派出');
}

// A worker the queue can give a task to: quiet, with nothing on it, not out.
function canTake(rec, w) {
  if (w.out || feeding.has(w.sessionId) || taskOf(rec, w)) return false;
  return leafOfWorker(w)?.status === 'idle';
}

// Decides, now and in this one step (so two events cannot give the same task
// to two workers), which waiting task goes to which free worker, in the order
// of the tasks and of the workers. Nothing is sent here: handOut() sends.
function assign(rec) {
  const pairs = [];
  if (rec.halted || rec.phase) return pairs;
  for (const w of rec.workers) {
    const task = pendingOf(rec)[0];
    if (!task) break;
    if (!canTake(rec, w)) continue;
    claim(rec, w, task);
    feeding.set(w.sessionId, { ended: false, error: false });
    pairs.push({ w, task });
  }
  return pairs;
}

// The task a stop cut off on this worker, if the worker has one and nothing else
// is on it: running again (the same work, the same start).
function reviveCut(rec, w) {
  const cut = tasksOf(rec)
    .filter((t) => t.status === 'failed' && t.error === CUT_OFF && t.workerSessionId === w.sessionId)
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
  if (!cut) return null;
  cut.status = 'running';
  cut.finishedAt = null;
  cut.error = null;
  return cut;
}

// A worker's turn ended (`status` is what it ended as): settle the task it was
// on and decide what is handed out now. → the pairs to send.
function turnEnded(rec, w, status) {
  const cut = Boolean(w.cutOff) && status === 'idle';
  const task = taskOf(rec, w);
  if (task) {
    // A turn that ended because stop() cut it short did not finish its task.
    if (cut) endTask(task, 'failed', CUT_OFF);
    else if (status === 'error') {
      retire(w, 'error');
      giveBack(rec, task, `w${w.n} 的回合出錯了`);
    } else endTask(task, 'done');
  } else if (status === 'error') retire(w, 'error');
  w.cutOff = false;
  w.ran = true;
  w.finishedAt = cut ? null : now();
  const pairs = assign(rec);
  failStranded(rec);
  return pairs;
}

export function buildTaskMessage({ n, index, total, task, isolate, branch }) {
  return [
    `這是第 ${index + 1}/${total} 條任務；完成後照固定格式回報，然後等待下一條。`,
    '',
    `## 任務：${task.title}`,
    '',
    task.prompt,
    '',
    `（你是 w${n}：工作範圍、叢集記憶檔與規則照一開始的簡報。${isolate ? `這條的改動一樣 commit 到分支 ${branch}。` : ''}回報固定四段：做了什麼／改了哪些檔／怎麼驗證／未完成什麼。）`,
  ].join('\n');
}

// Hands the waiting tasks to the free workers, if there are any of either.
function pump(rec) {
  const pairs = assign(rec);
  if (!pairs.length) return;
  persist(rec);
  announce(rec);
  handOut(rec, pairs);
}

function handOut(rec, pairs) {
  for (const { w, task } of pairs) feedOne(rec, w, task).catch((err) => console.warn(`[cluster] ${rec.id}: handing task ${task.index + 1} to ${w.sessionId} failed: ${err.message}`));
}

// Sends one task to its worker. The task is already `running` (assign()); this
// settles it by what Kimi says to the message.
async function feedOne(rec, w, task) {
  const session = leafOfWorker(w);
  try {
    if (!session) throw new Error('工作者的對話已被刪除');
    // The conversation is named after what it is doing now (the sidebar shows it).
    await runner.command(session, 'title', task.title).catch(() => {});
    const text = buildTaskMessage({ n: w.n, index: task.index, total: rec.tasks.length, task, isolate: rec.isolate, branch: w.branch });
    const r = await runner.deliver(session, text, { note: `叢集任務 ${task.index + 1}/${rec.tasks.length}` });
    if (r?.ok === false) throw new Error(r.error || 'Kimi 沒有收到訊息');
  } catch (err) {
    feeding.delete(w.sessionId);
    if (!clusters.has(rec.id)) return;
    retire(w, 'refused');
    giveBack(rec, task, `交給 w${w.n} 時失敗：${err.message}`);
    const pairs = assign(rec);
    failStranded(rec);
    persist(rec);
    announce(rec, { force: true });
    handOut(rec, pairs);
    return;
  }
  const handoff = feeding.get(w.sessionId);
  feeding.delete(w.sessionId);
  if (!clusters.has(rec.id)) return;
  if (handoff?.ended) {
    // It was quick: the turn is over already.
    const pairs = turnEnded(rec, w, handoff.error ? 'error' : 'idle');
    persist(rec);
    announce(rec);
    handOut(rec, pairs);
  } else if (rec.halted) {
    // A stop came while the message was on its way: it is cut like the others.
    w.cutOff = true;
    await Promise.resolve(runner.interrupt(w.sessionId)).catch(() => {
      w.cutOff = false;
    });
  }
}

// The Hub's list of what Kimi is doing on a computer (it arrives when a
// computer connects, and as conversations change): after a Hub restart a turn
// may have ended while nobody was listening, and this is how the queue finds
// out and goes on. Only a worker that is quiet in the Hub AND in Kimi is
// settled; a task the Hub has not yet seen start is given a grace period.
machines.onSessionChange((machineId, entry) => {
  if (!clusters.size || !entry || entry.busy) return;
  for (const rec of clusters.values()) {
    if (rec.machineId !== machineId || rec.phase) continue;
    for (const w of rec.workers) if (leafOfWorker(w)?.kimiSessionId === entry.id) reconcile(rec, w);
  }
});

function reconcile(rec, w) {
  if (feeding.has(w.sessionId) || cleaning.has(rec.id)) return;
  const leaf = leafOfWorker(w);
  if (!leaf || WORKING.includes(leaf.status)) return;
  const task = taskOf(rec, w);
  let pairs;
  if (task) {
    if (!task.began && now() - (task.startedAt || 0) < RECONCILE_GRACE_MS) return;
    pairs = turnEnded(rec, w, leaf.status === 'error' ? 'error' : 'idle');
  } else {
    pairs = assign(rec);
    if (!pairs.length) return;
  }
  persist(rec);
  announce(rec);
  handOut(rec, pairs);
}

// A worker's conversation was deleted: its task goes back to the queue (once).
function workerGone(cid, sessionId) {
  // A purge deletes the conversations itself; they are not a worker that vanished.
  if (cleaning.has(cid)) return;
  const rec = clusters.get(cid);
  const w = rec?.workers.find((x) => x.sessionId === sessionId);
  if (!w || store.getSession(sessionId) || w.out === 'deleted') return;
  feeding.delete(sessionId);
  const task = taskOf(rec, w);
  retire(w, 'deleted');
  if (task) giveBack(rec, task, `w${w.n} 的對話被刪除了`);
  const pairs = rec.phase ? [] : assign(rec);
  failStranded(rec);
  if (rec.phase === 'starting') return;
  persist(rec);
  announce(rec, { force: true });
  handOut(rec, pairs);
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

// Every cluster, one light line each (no worker's subagent list: that is what
// a cluster's own page is for), for the page that lists them all. The numbers
// come out of the very same function the page applies to the cluster it is
// told about (summarizeCluster), so a pushed cluster and this list agree.
export function listAll() {
  return [...clusters.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((rec) => summarizeCluster(publicCluster(rec)));
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

export function buildBrief({ cid, n, total, task, taskIndex = n - 1, tasks, worktree, folder, branch, cwd, isolate, mode, memoryPath, note, excerpt }) {
  const queued = tasks.length > total; // more tasks than workers: the others wait their turn
  const out = [`你是叢集 ${cid} 的工作者 w${n}（共 ${total} 個）。這份簡報是派工，不是閒聊；讀完請直接開始做。`, '', `## 你的任務：${task.title}`, ''];
  if (queued) out.push(`這是第 ${taskIndex + 1}/${tasks.length} 條任務；完成後照固定格式回報，然後等待下一條。`, '');
  out.push(task.prompt, '', '## 工作範圍');
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
  if (queued) {
    const shown = tasks.slice(0, 40);
    out.push('', '## 任務佇列', '', `這個叢集有 ${tasks.length} 條任務、${total} 個工作者。你做完一條並回報之後，Agent Hub 會在這個對話裡把下一條任務交給你（不會重送這份簡報）；沒有下一條時就不會再收到。全部任務：`, ...shown.map((t, i) => `- 第 ${i + 1} 條${i === taskIndex ? '（你現在做這條）' : ''}：${t.title}`), ...(tasks.length > shown.length ? [`- …還有 ${tasks.length - shown.length} 條`] : []));
  } else if (tasks.length > 1) out.push('', '## 同時進行的任務', '', ...tasks.map((t, i) => `- w${i + 1}${i + 1 === n ? '（你）' : ''}：${t.title}`));
  out.push('', '## 完成時');
  if (isolate) out.push('', `把你的改動 commit 到分支 ${branch}（小而清楚的 commit${queued ? '；每條任務各自 commit，累積在同一個分支上' : ''}）；沒有 commit 的改動不會被合併。`);
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
  if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') throw fail(400, 'name（叢集名稱）必須是文字');
  const name = cleanClusterName(b.name);
  if (Array.from(name).length > CLUSTER_NAME_MAX) throw fail(400, `叢集名稱最多 ${CLUSTER_NAME_MAX} 個字`);
  if (!Array.isArray(b.tasks) || !b.tasks.length) throw fail(400, '至少要有一個任務');
  if (b.tasks.length > MAX_TASKS) throw fail(400, `一個叢集最多 ${MAX_TASKS} 條任務`);
  if (b.workers !== undefined && (!Number.isInteger(b.workers) || b.workers < 1 || b.workers > MAX_WORKERS)) throw fail(400, `workers（工作者數）要是 1 到 ${MAX_WORKERS} 的整數`);
  const tasks = b.tasks.map((t, i) => {
    const title = typeof t?.title === 'string' ? t.title.replace(/\s+/g, ' ').trim() : '';
    const prompt = typeof t?.prompt === 'string' ? t.prompt.trim() : '';
    if (!title) throw fail(400, `第 ${i + 1} 個任務沒有標題`);
    if (!prompt) throw fail(400, `第 ${i + 1} 個任務沒有內容`);
    if (title.length > MAX_TITLE) throw fail(400, `第 ${i + 1} 個任務的標題最多 ${MAX_TITLE} 個字`);
    if (prompt.length > MAX_PROMPT) throw fail(400, `第 ${i + 1} 個任務的內容最多 ${MAX_PROMPT} 個字`);
    return { title, prompt };
  });
  // Workers: as many as asked (at most 8), by default one per task up to 4. More
  // workers than tasks would leave some with nothing to do: only as many are opened as there are tasks.
  const asked = b.workers ?? Math.min(tasks.length, DEFAULT_WORKERS);
  return { tasks, workers: Math.min(asked, tasks.length), workersAsked: b.workers ?? null, mode, isolate: b.isolate !== false, swarm: b.swarm !== false, note: (b.note || '').trim(), name };
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

  if (req.workersAsked !== null && req.workersAsked > req.workers) warnings.push(`工作者數 ${req.workersAsked} 比任務數 ${req.tasks.length} 多，只開 ${req.workers} 個工作者（多的會閒著，白花額度）`);

  const memoryPath = git ? `${git.common}/agent-hub-cluster/${cid}/memory.md` : `${parent.cwd.replace(/\/+$/, '')}/.agent-hub-cluster/${cid}/memory.md`;
  const rec = {
    id: cid,
    name: req.name || autoClusterName(req.tasks),
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
    // The queue: every task in the order given (see "the queue" below).
    tasks: req.tasks.map(newTask),
    halted: false,
    merge: null,
    cleanup: null,
    stoppedAt: null,
  };
  const made = { memory: false, worktrees: [], sessions: [] };
  clusters.set(cid, rec);
  try {
    await mem.createMemory(parent.machineId, parent.cwd, memoryPath, memoryHeader(rec, req.tasks, req.workers), { ignoreFolder: !git });
    made.memory = true;
    await refreshMemory(rec);
    const startOffset = rec.memory.bytes || 0;

    // Worktrees first, one after the other: git takes locks of its own and the
    // order of branches is the order of workers.
    // A conversation working in a folder below the project's root gets the same
    // folder in its worktree.
    const plan = req.tasks.slice(0, req.workers).map((task, i) => ({ task, n: i + 1, branch: isolate ? `cluster/${cid}/w${i + 1}` : null, worktree: isolate ? `${container}/w${i + 1}` : null, folder: isolate ? (git.prefix ? `${container}/w${i + 1}/${git.prefix}` : `${container}/w${i + 1}`) : parent.cwd }));
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
      text: buildBrief({ cid, n: w.n, total: plan.length, task: { title: w.title, prompt: w.task }, taskIndex: w.n - 1, tasks: req.tasks, worktree: w.worktree, folder: w.folder, branch: w.branch, cwd: parent.cwd, isolate, mode: req.mode, memoryPath, note: req.note, excerpt }),
    }));
    for (const { w, text } of briefs) {
      // The first tasks go out with the brief; each is `running` from the moment it is sent.
      claim(rec, w, rec.tasks[w.n - 1]);
      const r = await runner.deliver(store.getSession(w.sessionId), text, { note: '叢集派工簡報' });
      if (r?.ok === false) throw fail(502, `w${w.n} 沒有收到簡報：${r.error || 'Kimi 沒有回應'}`);
    }

    rec.phase = null;
    // A worker that was quick may have finished its first task while the others were still being briefed.
    const pairs = assign(rec);
    parent.clusterIds = [...(parent.clusterIds || []), cid];
    store.saveSession(parent, { touch: false });
    persist(rec);
    broadcast({ t: 'session', session: runner.summarize(parent) });
    for (const w of rec.workers) {
      const s = store.getSession(w.sessionId);
      if (s) broadcast({ t: 'session', session: runner.summarize(s) });
    }
    announce(rec, { force: true });
    handOut(rec, pairs);
    return { cluster: publicCluster(rec), warnings: [...warnings] };
  } catch (err) {
    await recycle(rec, made).catch((e) => console.warn(`[cluster] ${cid} not fully cleaned up: ${e.message}`));
    throw err.status ? err : fail(502, err.message || String(err));
  }
}

function memoryHeader(rec, tasks, workers = tasks.length) {
  return [
    `# 叢集記憶 ${rec.id}`,
    '',
    `建立於 ${stamp(new Date(rec.createdAt))}。這個檔案在 git 之外，只追加、不改寫；主對話與每個工作者都讀得到。`,
    ...(rec.note ? ['', '## 主對話交代', '', rec.note] : []),
    '',
    '## 任務',
    '',
    // One task per worker: the worker is the task's name. More tasks than workers: they are numbered, and whoever is free takes the next.
    ...tasks.map((t, i) => (tasks.length > workers ? `- 第 ${i + 1} 條：${t.title}` : `- w${i + 1}：${t.title}`)),
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
  // From here on nothing new is handed out (a stop ends the dispatching for
  // good: tasks that were never sent stay waiting). This is set BEFORE any
  // worker is interrupted: the turn that ends because of the interrupt must not
  // be followed by the next task. A cluster with nothing working and nothing
  // waiting is left as it is.
  const open = tasksOf(rec).some((t) => t.status === 'pending' || t.status === 'running');
  const working = rec.workers.some((w) => WORKING.includes(leafOfWorker(w)?.status));
  if (open || working) rec.halted = true;
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
  if (any || open) rec.stoppedAt = now();
  persist(rec);
  announce(rec, { force: true });
  return publicCluster(rec);
}

// ----------------------------------------------------------------- name

// A new name from the person (the pencil on the cluster's page). Allowed at any
// time, even while the workers run: it changes nothing but what the cluster is called.
export function rename(cid, raw) {
  const rec = getRecord(cid);
  if (typeof raw !== 'string') throw fail(400, '名稱必須是文字');
  const name = cleanClusterName(raw);
  if (!name) throw fail(400, '名稱是空的');
  if (Array.from(name).length > CLUSTER_NAME_MAX) throw fail(400, `叢集名稱最多 ${CLUSTER_NAME_MAX} 個字`);
  rec.name = name;
  persist(rec);
  announce(rec, { force: true });
  return publicCluster(rec);
}

// A conversation was deleted: the clusters it started say their main conversation is gone.
export function noteDeleted(sessionId) {
  for (const rec of clusters.values()) if (rec.parentId === sessionId && !rec.phase) announce(rec, { force: true });
}

// ------------------------------------------------------------ clean up
//
// After the work is merged the workers' worktrees, branches and sidebar rows
// are only clutter. Cleaning up takes them away, and takes away nothing that
// is not somewhere else too (the no-loss rule), worker by worker:
//
//   worktree  removed only when it is CLEAN (git's own `worktree remove`, never
//             --force: nothing modified, nothing untracked) and its branch is
//             safe to delete too; otherwise kept, with the reason.
//   branch    deleted only when every commit on it is also in the merged
//             branch (cluster/<id>/merged) or in the main conversation's HEAD -
//             that is what `git branch -d` checks, done here against the merged
//             branch as well and as a compare-and-swap on the tip that was
//             checked (never -D). A branch checked out anywhere is not touched.
//   merged    cluster/<id>/merged is never touched; nor is the memory file.
//   worker    the conversation is neither deleted nor archived: it is taken off
//             the sidebar (`clusterHidden`) once nothing of it is left to look
//             after, and the cluster page puts it back on request.
//
// A worker whose merge failed, or that is still working, is left whole. A step
// that fails leaves that worker as it was and the next worker is done.
const CLEAN_TIMEOUT_MS = 120_000;
const WHY_RUNNING = '工作者還在跑';
const WHY_QUEUE = '工作者還在跑：佇列還有任務沒做完';

const chainNodes = (leaf) => {
  try {
    return store.chainOf(leaf);
  } catch {
    return [leaf];
  }
};
const isHidden = (w) => Boolean(w && leafOfWorker(w)?.clusterHidden);

// Hide or show a worker's conversation in the sidebar: on every node of its
// chain (the row is the leaf's, a later node copies the flag from the one before).
function setHidden(w, on) {
  const leaf = leafOfWorker(w);
  if (!leaf) return false;
  let changed = false;
  for (const node of chainNodes(leaf)) {
    if (Boolean(node.clusterHidden) === on) continue;
    if (on) node.clusterHidden = true;
    else delete node.clusterHidden;
    store.saveSession(node, { touch: false });
    changed = true;
  }
  if (changed) broadcast({ t: 'session', session: runner.summarize(leaf) });
  return changed;
}

// What a computer says of one worker's worktree and branch. Read only.
async function inspectWorker(rec, w) {
  const q = mem.quote;
  const script = [
    `top=${q(rec.repo.top)}; wt=${q(w.worktree)}; br=${q(w.branch)}; mergedbr=${q(`cluster/${rec.id}/merged`)}; main=${q(rec.cwd)}`,
    'real=$(cd "$wt" 2>/dev/null && pwd -P)',
    'echo "AHC_WTDIR=$([ -d "$wt" ] && echo 1 || echo 0)"',
    'echo "AHC_REAL=$real"',
    'list=$(git -C "$top" worktree list --porcelain 2>/dev/null)',
    'reg=0',
    'printf "%s\\n" "$list" | grep -Fxq "worktree $wt" && reg=1',
    '[ -n "$real" ] && printf "%s\\n" "$list" | grep -Fxq "worktree $real" && reg=1',
    'echo "AHC_WTREG=$reg"',
    'if [ -d "$wt" ]; then',
    '  st=$(git -C "$wt" status --porcelain 2>/dev/null); rc=$?',
    '  if [ $rc -ne 0 ]; then echo "AHC_STATUSERR=$(git -C "$wt" status --porcelain 2>&1 | head -c 200 | tr "\\n" " ")"; else echo "AHC_DIRTY=$(printf "%s\\n" "$st" | grep -c .)"; fi',
    'fi',
    'tip=$(git -C "$top" rev-parse --verify -q "refs/heads/$br" 2>/dev/null) || tip=',
    'echo "AHC_TIP=$tip"',
    'if [ -n "$tip" ]; then',
    '  mtip=$(git -C "$top" rev-parse --verify -q "refs/heads/$mergedbr" 2>/dev/null) || mtip=',
    '  mainhead=$(git -C "$main" rev-parse --verify -q HEAD 2>/dev/null) || mainhead=',
    '  echo "AHC_MERGEDTIP=$mtip"',
    '  safe=',
    '  if [ -n "$mtip" ] && git -C "$top" merge-base --is-ancestor "$tip" "$mtip" 2>/dev/null; then safe=merged',
    '  elif [ -n "$mainhead" ] && git -C "$top" merge-base --is-ancestor "$tip" "$mainhead" 2>/dev/null; then safe=head; fi',
    '  echo "AHC_SAFE=$safe"',
    '  if [ -z "$safe" ]; then',
    '    args="$tip"; [ -n "$mtip" ] && args="$args ^$mtip"; [ -n "$mainhead" ] && args="$args ^$mainhead"',
    '    echo "AHC_UNIQUE=$(git -C "$top" rev-list --count $args 2>/dev/null)"',
    '  fi',
    '  git -C "$top" worktree list --porcelain 2>/dev/null | awk -v b="branch refs/heads/$br" \'/^worktree /{p=substr($0,10)} $0==b{print "AHC_CHECKEDOUT=" p}\'',
    'fi',
  ].join('\n');
  // (git status of a big worktree can take a while.)
  const r = await mem.sh(rec.machineId, rec.cwd, script, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(r.output.trim().slice(0, 200) || `結束碼 ${r.exitCode}`);
  const own = new Set([w.worktree, mem.field(r.output, 'AHC_REAL')].filter(Boolean));
  return {
    dir: mem.field(r.output, 'AHC_WTDIR') === '1',
    registered: mem.field(r.output, 'AHC_WTREG') === '1',
    dirty: Number(mem.field(r.output, 'AHC_DIRTY')) || 0,
    statusError: mem.field(r.output, 'AHC_STATUSERR') || '',
    tip: mem.field(r.output, 'AHC_TIP') || '',
    mergedTip: mem.field(r.output, 'AHC_MERGEDTIP') || '',
    safe: mem.field(r.output, 'AHC_SAFE') || '',
    unique: Number(mem.field(r.output, 'AHC_UNIQUE')) || 0,
    // Where else the branch is checked out (its own worktree is not "else").
    checkedOutAt: [...r.output.matchAll(/^AHC_CHECKEDOUT=(.*)$/gm)].map((m) => m[1].trim()).filter((p) => p && !own.has(p)),
  };
}

// What is to be done for one worker, from what the computer said. `keepWhy`:
// a reason to leave it whole whatever git says (still working, merge failed).
// → { worktree: 'remove'|'gone'|'keep', branch: 'delete'|'gone'|'keep', safe, reasons }
function decideWorker(rec, f, keepWhy) {
  const mergedBranch = `cluster/${rec.id}/merged`;
  const reasons = [];
  let worktreeProblem = null; // why the worktree cannot be removed
  let branchProblem = null; // why the branch cannot be deleted
  let atRisk = false; // commits on the branch that are nowhere else: the worker is not finished with it
  if (f.dir) {
    if (!f.registered) worktreeProblem = 'git 不認得這個資料夾是 worktree，沒有動它';
    else if (f.statusError) worktreeProblem = `看不到 worktree 的狀態：${f.statusError}`;
    else if (f.dirty > 0) worktreeProblem = `有 ${f.dirty} 項未提交的修改或未追蹤的檔案`;
  }
  if (f.tip && !f.safe) {
    atRisk = true;
    branchProblem = f.mergedTip ? `分支有 ${f.unique} 個 commit 沒合進 ${mergedBranch}，也不在主對話目前的 HEAD 上` : `還沒合併過：分支有 ${f.unique} 個 commit 不在主對話目前的 HEAD 上`;
  } else if (f.tip && f.checkedOutAt.length) {
    branchProblem = `分支正被 ${f.checkedOutAt[0]} 檢出，沒有動它`;
  }
  if (keepWhy) {
    if (f.dir) worktreeProblem = worktreeProblem || keepWhy;
    if (f.tip) {
      branchProblem = branchProblem || keepWhy;
      atRisk = true;
    }
    reasons.push(keepWhy);
  }
  for (const why of [worktreeProblem, branchProblem]) if (why && !reasons.includes(why)) reasons.push(why);
  const worktree = !f.dir ? 'gone' : worktreeProblem || atRisk ? 'keep' : 'remove';
  let branch;
  if (!f.tip) branch = 'gone';
  else if (branchProblem) branch = 'keep';
  else if (worktree === 'keep') {
    branch = 'keep';
    reasons.push('分支還被 worktree 使用中');
  } else branch = 'delete';
  if (!f.dir) reasons.push('worktree 資料夾本來就不在了');
  if (!f.tip) reasons.push('分支本來就不在了');
  return { worktree, branch, safe: f.safe, reasons };
}

const gitMessage = (r) => r.output.trim().replace(/\s+/g, ' ').slice(0, 200) || `結束碼 ${r.exitCode}`;

// Does what decideWorker said, step by step; a step that fails is reported and
// the worker stays as it was after the last step that worked.
async function applyDecision(rec, w, d) {
  const out = { worktree: d.worktree === 'keep' ? 'kept' : 'removed', branch: d.branch === 'keep' ? 'kept' : 'deleted', reasons: [...d.reasons], did: { worktree: false, branch: false } };
  const { machineId, cwd } = rec;
  const q = mem.quote;
  if (d.worktree === 'remove') {
    const r = await mem.sh(machineId, cwd, gitIn(rec.repo.top, `worktree remove ${q(w.worktree)}`), { timeoutMs: CLEAN_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      out.worktree = 'kept';
      out.reasons.push(`git 拒絕移除 worktree：${gitMessage(r)}`);
      if (d.branch === 'delete') {
        out.branch = 'kept';
        out.reasons.push('分支還被 worktree 使用中');
      }
      return out;
    }
    out.did.worktree = true;
  } else if (d.worktree === 'gone') {
    // The folder was deleted by hand: git still lists it, and would not let its branch go.
    await mem.sh(machineId, cwd, gitIn(rec.repo.top, 'worktree prune', { quiet: true }) + '; true').catch(() => {});
  }
  if (d.branch === 'delete') {
    const script = [
      `top=${q(rec.repo.top)}; br=${q(w.branch)}; mergedbr=${q(`cluster/${rec.id}/merged`)}; main=${q(cwd)}; kind=${q(d.safe)}`,
      'tip=$(git -C "$top" rev-parse --verify -q "refs/heads/$br") || { echo "分支已經不在了"; exit 3; }',
      'if git -C "$top" worktree list --porcelain | grep -Fxq "branch refs/heads/$br"; then echo "分支被某個 worktree 檢出"; exit 3; fi',
      'if [ "$kind" = merged ]; then ref=$(git -C "$top" rev-parse --verify -q "refs/heads/$mergedbr") || { echo "合併用的分支不見了"; exit 4; }; else ref=$(git -C "$main" rev-parse --verify -q HEAD) || { echo "讀不到主對話的 HEAD"; exit 4; }; fi',
      'git -C "$top" merge-base --is-ancestor "$tip" "$ref" || { echo "分支上有 commit 不在別處"; exit 4; }',
      // Compare-and-swap: only if the branch is still at the commit that was checked.
      'git -C "$top" update-ref -d "refs/heads/$br" "$tip" 2>&1',
    ].join('\n');
    const r = await mem.sh(machineId, cwd, script, { timeoutMs: CLEAN_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      out.branch = 'kept';
      out.reasons.push(`沒有刪分支：${gitMessage(r)}`);
    } else out.did.branch = true;
  }
  return out;
}

// One worker: decide (and, unless `dry`, do) what its clean-up is.
async function cleanWorker(rec, w, { dry }) {
  const leaf = leafOfWorker(w);
  const keepWhy = leaf && WORKING.includes(leaf.status) ? WHY_RUNNING : queueOpen(rec) ? WHY_QUEUE : rec.merge?.results?.some((r) => r.sessionId === w.sessionId && !r.ok) ? '合併時沒合進去（衝突或失敗），分支與 worktree 留給你處理' : '';
  const base = { sessionId: w.sessionId, worktree: null, branch: null, hidden: false, reasons: [] };
  let result;
  let did = { worktree: false, branch: false };
  if (!rec.repo || !w.worktree) {
    // Shared folder: nothing to remove.
    result = { ...base, reasons: keepWhy ? [keepWhy] : [] };
  } else {
    try {
      const f = await inspectWorker(rec, w);
      const d = decideWorker(rec, f, keepWhy);
      if (dry) {
        result = { ...base, worktree: d.worktree === 'keep' ? 'kept' : 'removed', branch: d.branch === 'keep' ? 'kept' : 'deleted', reasons: d.reasons };
        did = { worktree: d.worktree === 'remove', branch: d.branch === 'delete' };
      } else {
        const a = await applyDecision(rec, w, d);
        did = a.did;
        result = { ...base, worktree: a.worktree, branch: a.branch, reasons: a.reasons };
      }
    } catch (err) {
      result = { ...base, worktree: 'kept', branch: 'kept', reasons: [...(keepWhy ? [keepWhy] : []), `看不到 git 狀態：${err.message}`] };
    }
  }
  if (!leaf) result.reasons.push('工作者的對話已被刪除');
  // Off the sidebar once nothing of the worker is left to look after.
  const settled = result.worktree !== 'kept' && result.branch !== 'kept' && !keepWhy;
  let newlyHidden = false;
  if (leaf && settled) {
    result.hidden = true;
    // (In a dry run: whether it would be.)
    newlyHidden = dry ? !leaf.clusterHidden : !leaf.clusterHidden && setHidden(w, true);
  }
  return { result, did, newlyHidden };
}

async function runCleanup(rec, { auto = false, dry = false } = {}) {
  const results = [];
  const actions = []; // (a dry run) what would really be done to each worker
  const counts = { worktrees: 0, branches: 0, hidden: 0 };
  for (const w of rec.workers) {
    const one = await cleanWorker(rec, w, { dry });
    results.push(one.result);
    actions.push({ sessionId: w.sessionId, removeWorktree: one.did.worktree, deleteBranch: one.did.branch, hide: one.newlyHidden });
    if (one.did.worktree) counts.worktrees++;
    if (one.did.branch) counts.branches++;
    if (one.newlyHidden) counts.hidden++;
  }
  if (dry) return { dryRun: true, results, actions };
  if (rec.repo) await mem.sh(rec.machineId, rec.cwd, `rmdir ${mem.quote(rec.repo.container)} 2>/dev/null; true`).catch(() => {});
  rec.cleanup = { at: now(), auto, results };
  persist(rec);
  announceCleanup(rec, counts);
  announce(rec, { force: true });
  return { dryRun: false, results };
}

function checkCleanable(rec) {
  if (rec.phase) throw fail(409, rec.phase === 'merging' ? '正在合併中，等它完成再清理' : '叢集還在建立中');
  if (cleaning.has(rec.id)) throw fail(409, '正在清理中');
  if (rec.workers.some((w) => WORKING.includes(leafOfWorker(w)?.status))) throw fail(409, '工作者還在跑，先全部停止');
  if (queueOpen(rec)) throw fail(409, '工作者還在跑：佇列還有任務沒做完，等它們做完或先全部停止');
  if (rec.repo && !machines.getMachine(rec.machineId)?.online) throw fail(409, `機器「${machines.getMachine(rec.machineId)?.name || rec.machineId}」目前離線：請在那台機器上執行連接器`);
}

// By hand (the 清理 button).
export async function cleanup(cid) {
  const rec = getRecord(cid);
  checkCleanable(rec);
  cleaning.add(rec.id);
  try {
    await runCleanup(rec, { auto: false });
  } finally {
    cleaning.delete(rec.id);
  }
  return publicCluster(rec);
}

// What 清理 would do now, without doing any of it (the confirmation lists it).
export async function cleanupPlan(cid) {
  const rec = getRecord(cid);
  checkCleanable(rec);
  cleaning.add(rec.id);
  try {
    return await runCleanup(rec, { dry: true });
  } finally {
    cleaning.delete(rec.id);
  }
}

// After a merge in which every worker went in. A worker still at work is left
// whole (and says so); a clean-up that goes wrong never undoes the merge.
async function autoCleanup(rec) {
  if (queueOpen(rec)) return; // a worker between two tasks still needs its worktree
  if (!rec.merge || !rec.workers.length || rec.merge.results.length !== rec.workers.length || !rec.merge.results.every((r) => r.ok)) return;
  if (cleaning.has(rec.id)) return;
  cleaning.add(rec.id);
  try {
    await runCleanup(rec, { auto: true });
  } catch (err) {
    console.warn(`[cluster] ${rec.id}: automatic clean-up failed: ${err.message}`);
  } finally {
    cleaning.delete(rec.id);
  }
}

// 放回側欄: one worker (by its session id) or all of them.
export function unhide(cid, sessionId) {
  const rec = getRecord(cid);
  const targets = sessionId === undefined || sessionId === null ? rec.workers : rec.workers.filter((w) => w.sessionId === sessionId);
  if (!targets.length) throw fail(404, '這個叢集沒有這個工作者');
  for (const w of targets) setHidden(w, false);
  persist(rec);
  announce(rec, { force: true });
  return publicCluster(rec);
}

// A system line in the main conversation, like the merge's.
function announceCleanup(rec, counts) {
  const parent = store.getSession(rec.parentId);
  if (!parent) return;
  const leaf = store.leafOf(parent) || parent;
  const label = (r) => `w${rec.workers.find((w) => w.sessionId === r.sessionId)?.n ?? '?'}`;
  const left = rec.cleanup.results.filter((r) => r.worktree === 'kept' || r.branch === 'kept');
  const text = [
    `叢集 ${rec.id} 已清理${rec.cleanup.auto ? '（合併全部成功後自動執行）' : ''}：移除 ${counts.worktrees} 個 worktree、刪除 ${counts.branches} 個分支、從側欄收起 ${counts.hidden} 個工作者對話。`,
    left.length ? `保留：${left.map((r) => `${label(r)}（${(r.reasons[0] || '').slice(0, 60)}）`).join('、')}。` : '',
    `${rec.merge ? `${rec.merge.branch} 與` : ''}叢集記憶檔都還在；工作者的對話沒有刪，在叢集頁可以開啟，或放回側欄。`,
  ].filter(Boolean).join('');
  runner.liveContext(leaf).emit({ type: 'info', text });
}

// --------------------------------------------------------------- merge

export async function merge(cid) {
  const rec = getRecord(cid);
  if (!rec.isolate || !rec.repo) throw fail(409, '只有「每個工作者獨立 worktree」的 git 叢集才能合併');
  if (rec.phase) throw fail(409, rec.phase === 'merging' ? '正在合併中' : '叢集還在建立中');
  if (cleaning.has(rec.id)) throw fail(409, '正在清理中，等它完成再合併');
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
    // Tasks that waited while the branches were merged go on.
    pump(rec);
  } catch (err) {
    // Half a merge is not kept: what this attempt made goes, so it can be tried again.
    await run(`${created.tree ? `${gitIn(dir, `worktree remove --force ${mem.quote(tree)}`, { quiet: true })}; ` : ''}${gitIn(dir, 'worktree prune', { quiet: true })}; ${gitIn(dir, `branch -D ${mem.quote(branch)}`, { quiet: true })}; true`).catch(() => {});
    rec.phase = null;
    announce(rec, { force: true });
    pump(rec);
    throw err.status ? err : fail(502, err.message || String(err));
  }
  // Outside the try above: whatever happens in the clean-up must never take the
  // merged branch away with it. Only a merge in which every worker went in cleans up by itself.
  await autoCleanup(rec);
  return publicCluster(rec);
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

// ----------------------------------------------------- for the full purge

// cluster-purge.js works on these same records and asks a computer about a
// worktree the same way the clean-up does; it is handed the pieces here and
// nothing else of this file's state.
export const internals = {
  WORKING,
  fail,
  clusters,
  workerIndex,
  lastSent,
  cleaning,
  fileOf,
  persist,
  announce,
  leafOfWorker,
  inspectWorker,
  gitIn,
  queueOpen,
  tasksOf,
  say: (msg) => broadcast(msg),
};
