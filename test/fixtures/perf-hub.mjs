// A Hub shaped like the VPS one that was slow (2026-10-30), made up and
// repeatable: a real Hub process on a scratch folder with
//   - `conversations` conversations on disk, `workers` of them workers of
//     clusters (5 per cluster, two thirds of the clusters at work), the rest
//     main conversations, each carrying what a real Kimi conversation carries
//     in its summary (the computer's model list and skill list in `meta`: the
//     biggest part of a summary, 11 KB for the largest one on the VPS);
//   - the cluster records of those workers (data/clusters/c_<id>.json);
//   - `machines` fake computers (the real bridge protocol) that report
//     `native` Kimi conversations each, the hub's ones among them.
// Nothing is replaced: the Hub's store, machines, runner and cluster code run
// as they do in production. The numbers it gives are for comparing a run with
// the one before it, never for saying what a real Hub does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeMachine } from './fake-machine.mjs';
import { assertNoLeaks, snapshot } from './leak-guard.mjs';
import { stopHubAndDaemons } from './stop-daemons.mjs';
import { seedSession } from '../browser-harness.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What Kimi's server lists for a computer: a dozen models, a few dozen skills.
const MODELS = Array.from({ length: 12 }, (_, i) => ({ id: `managed:kimi-code/model-${i}`, name: `Kimi model ${i}`, context: 262144, efforts: ['low', 'medium', 'high'], thinking: true, capabilities: ['thinking', 'image_in', 'tool_use'] }));
const SKILLS = Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: `Use this skill when the task is about area ${i}: it knows the conventions, the commands to run and the files to look at, and tells you what to check before and after.`, source: i % 2 ? 'user' : 'project' }));
// The VPS had 90 conversations of 612 KB (6.8 KB each, the largest 11 KB): the lists differ from one computer's conversation to the next.
export const heavyMeta = (i = 0, extra = {}) => ({ models: MODELS.slice(0, 5 + (i % 8)), defaultModel: MODELS[0].id, skills: SKILLS.slice(0, 3 + ((i * 7) % 28)), machineName: 'perf', kimiVersion: '2.3.3', permission: 'auto', context: { used: 20000, size: 262144 }, ...extra });

const hex = (n, w = 12) => n.toString(16).padStart(w, '0');

// Writes the conversations and clusters into `data`. Returns what was made.
export function seedPerfData(data, { conversations = 100, workers = 60, perCluster = 5, activeClusters = 8, machineIds = ['m_fake', 'm_perf2'] } = {}) {
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(data, 'clusters'), { recursive: true });
  const now = Date.now();
  const made = { mains: [], workers: [], clusters: [], natives: [] }; // natives: [machineId, nativeId, title, busy]
  const put = (s) => fs.writeFileSync(path.join(data, 'sessions', `${s.id}.json`), JSON.stringify(s));
  const mains = conversations - workers;
  for (let i = 0; i < mains; i++) {
    const machineId = machineIds[i % machineIds.length];
    const nativeId = `session_main_${hex(i, 6)}`;
    const s = seedSession({
      id: `s_main${hex(i, 8)}`, title: `主對話 ${i}`, agentId: `kimi@${machineId}`, machineId, cwd: `/work/project-${i % 7}`, kimiSessionId: nativeId, provider: 'kimi',
      permissionMode: 'ask', updatedAt: now - i * 60_000, createdAt: now - 1e7 - i, meta: heavyMeta(i), modelConfig: { provider: 'kimi', model: MODELS[0].id, effort: 'high' },
      events: [{ id: `e${i}`, ts: now - i * 60_000, type: 'user', text: `做第 ${i} 件事` }],
    });
    put(s);
    made.mains.push(s);
    made.natives.push([machineId, nativeId, s.title, false]);
  }
  const clusterCount = Math.ceil(workers / perCluster);
  let w = 0;
  for (let c = 0; c < clusterCount; c++) {
    const parent = made.mains[c % made.mains.length];
    const cid = `c_${hex(c + 1)}`;
    const active = c < activeClusters;
    const rec = {
      id: cid, parentId: parent.id, machineId: parent.machineId, cwd: parent.cwd, createdAt: now - 3_600_000 - c * 1000, mode: 'fresh', isolate: false, swarm: false, note: '', warnings: [], repo: null,
      memory: { path: `${parent.cwd}/.agent-hub-cluster/${cid}/memory.md`, bytes: 1200, updatedAt: now - 60_000 }, workers: [], halted: false, merge: null, cleanup: null, stoppedAt: null,
    };
    for (let k = 0; k < perCluster && w < workers; k++, w++) {
      const nativeId = `session_work_${hex(w, 6)}`;
      const machineId = parent.machineId;
      const sid = `s_work${hex(w, 8)}`;
      const running = active && k < 4;
      const s = seedSession({
        id: sid, title: `工作者 ${c + 1}.${k + 1}`, agentId: `kimi@${machineId}`, machineId, cwd: parent.cwd, kimiSessionId: nativeId, provider: 'deepseek', mode: 'deepseek', status: running ? 'running' : 'idle',
        clusterId: cid, clusterRole: 'worker', updatedAt: now - w * 1000, createdAt: now - 3_000_000, meta: heavyMeta(w + 3, { tps: running ? 40 + w : undefined }),
        modelConfig: { provider: 'deepseek', model: 'agent-hub-deepseek/deepseek-v4-flash', effort: 'high' },
        events: [{ id: `ew${w}`, ts: now - w * 1000, type: 'text', text: `正在處理第 ${w} 項：把設定檔讀進來，再逐一檢查。` }],
      });
      put(s);
      made.workers.push(s);
      made.natives.push([machineId, nativeId, s.title, running]);
      rec.workers.push({ sessionId: sid, title: s.title, task: `第 ${w} 項任務：檢查並修正設定。`, branch: null, worktree: null, folder: parent.cwd, finishedAt: running ? null : now - 100_000, ran: true, n: k + 1 });
    }
    fs.writeFileSync(path.join(data, 'clusters', `${cid}.json`), JSON.stringify(rec));
    made.clusters.push(rec);
  }
  return made;
}

// A computer reports its conversations the way Kimi lists them: a conversation's
// `updated_at` moves only when it was used (the fake computer's own pushSessions
// stamps every one of them with the present, which would make every entry look
// changed at every report). `active`: the native ids that were used just now.
const STABLE_AT = new Date(Date.now() - 86_400_000).toISOString();
export function pushNatives(m, active = new Set()) {
  const items = [...m.sessions.entries()].map(([id, s]) => ({
    id, title: s.title, metadata: { cwd: s.cwd }, busy: Boolean(s.busy), pending_interaction: 'none', last_turn_reason: 'completed', owner: s.owner ?? null, controllable: s.controllable ?? null, guess: false, model: s.model, effort: s.thinking, permission: s.permission,
    updated_at: active.has(id) ? new Date().toISOString() : STABLE_AT,
  }));
  m.send({ t: 'kimi.sessions', items });
}

// Starts the Hub (`seed` makes the folder), the fake computers and reports each one's Kimi conversations.
export async function startPerfHub(opts = {}) {
  const { machines: machineCount = 2, native = 100 } = opts;
  const machineIds = ['m_fake', 'm_perf2', 'm_perf3'].slice(0, machineCount);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-perf-'));
  const before = snapshot();
  const DATA = path.join(TMP, 'data');
  const made = seedPerfData(DATA, { ...opts, machineIds });
  const PORT = 30000 + Math.floor(Math.random() * 5000);
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', AGENT_HUB_TOKEN: 'none', AGENT_HUB_DATA: DATA, AGENT_HUB_WORKSPACES: path.join(TMP, 'ws') };
  delete env.ANTHROPIC_API_KEY;
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start:\n${log}`)), 30000);
    const on = (d) => {
      log += d;
      if (log.includes('已啟動')) (clearTimeout(t), resolve());
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    proc.once('exit', (code) => reject(new Error(`hub exited ${code}\n${log}`)));
  });
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: text }; }
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, body: j });
    return j;
  };
  const raw = async (p) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: buf.length, json: () => JSON.parse(buf.toString('utf8')) };
  };
  const key = JSON.parse(fs.readFileSync(path.join(DATA, 'hub.json'), 'utf8')).bridgeKey;
  const computers = machineIds.map((id) => startFakeMachine({ port: PORT, key, id, name: `電腦-${id}` }));
  await Promise.all(computers.map((m) => m.ready));
  // Each computer reports its conversations: the hub's own (linked by their native ids) and others, up to `native`.
  for (const m of computers) {
    for (const [mid, nid, title, busy] of made.natives) if (mid === m.id) m.sessions.set(nid, { cwd: '/work/x', model: '', thinking: '', title, permission: 'auto', history: [], busy });
    let extra = 0;
    while (m.sessions.size < native) m.sessions.set(`session_extra_${m.id}_${extra++}`, { cwd: `/work/other-${extra % 5}`, model: '', thinking: '', title: `終端機對話 ${extra}`, permission: 'auto', history: [], owner: 'tui', busy: false });
    pushNatives(m);
  }
  // Wait until the Hub knows them all (the machine list is the last thing to arrive).
  const until = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn().catch(() => false)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(async () => (await api('GET', '/machines')).every((m) => m.online && m.sessions.length >= Math.min(native, 20)), 15000, 'the computers and their conversations');
  // The connectors can write request records (the speed of a worker and the output of a cluster come from them).
  for (const m of computers) m.send({ t: 'broker.ready', broker: 1, capabilities: ['pool', 'pool_timing'] });
  await until(async () => (await api('GET', '/machines')).every((m) => m.capabilities.includes('pool_timing')), 5000, 'the computers able to time');
  await sleep(400);
  let rec = 0;
  // `count` request records for each of the workers, the way a connector's proxy reports them.
  const feedRequests = (workers, count = 2, at = Date.now()) => {
    for (const m of computers) {
      const mine = workers.filter((w) => w.machineId === m.id);
      if (!mine.length) continue;
      const records = [];
      for (const w of mine) {
        for (let i = 0; i < count; i++) {
          const startAt = at - 8000 + i * 3000;
          records.push({ id: `rq${++rec}`, req: rec, attempt: 1, key: 'dk_none', gateway: 'opencode-go', session: w.kimiSessionId, recvAt: startAt, startAt, headersMs: 40, firstByteMs: 90, endMs: 2500, status: 200, outcome: 'ok', inflight: 1, outTokens: 300 + (rec % 90) });
        }
      }
      m.send({ t: 'deepseek.requests', boot: 'b', since: at - 3_600_000, replay: false, records });
    }
  };
  return {
    TMP, DATA, PORT, api, raw, made, computers, machineIds, until, feedRequests, log: () => log,
    async stop() {
      for (const m of computers) m.close();
      stopHubAndDaemons(proc, TMP);
      await sleep(300);
      await assertNoLeaks(before, { dirs: [TMP], stamp: false });
      fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
}

// What happens on the Hub in `seconds` seconds when eight clusters are at work
// and nobody looks at them: every second one worker is touched and the request
// records of a few arrive; every other second a computer reports its
// conversations again. About the rate the VPS Hub showed (6 machine, 15 cluster
// and 8 session messages in 15 seconds), made up.
export async function runWorkload(hub, { seconds = 15 } = {}) {
  const active = hub.made.workers.filter((w) => w.status === 'running');
  for (let tick = 1; tick <= seconds; tick++) {
    const w = active[(tick * 7) % active.length];
    hub.feedRequests([active[(tick * 3) % active.length], active[(tick * 5) % active.length], w], 1);
    await hub.api('PATCH', `/sessions/${w.id}`, { title: `${w.title.replace(/ #\d+$/, '')} #${tick}` });
    if (tick % 2 === 0) {
      // A computer reports again: a worker's conversation was used, and now and then an ordinary one.
      const m = hub.computers[(tick / 2) % hub.computers.length];
      const mains = hub.made.mains.filter((c) => c.machineId === m.id);
      pushNatives(m, new Set([w.kimiSessionId, mains[tick % mains.length]?.kimiSessionId]));
    }
    await sleep(1000);
  }
}
