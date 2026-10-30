// A scripted Hub for the cluster screens, in a real browser: the page's GETs
// about clusters are answered from window.__fake (re-installed in every page that
// loads, so a test can reload), the sockets are kept so a test can push a message
// down them (window.__emit), and what changes something goes to the real scratch
// Hub of the harness. Shared by the cluster screens' browser tests.
import { summarizeCluster } from '../../public/js/cluster-model.js';

export const FAKE_SCRIPT = `(() => {
  window.__fake = window.__fake || { online: true, clusters: {}, parents: {}, timing: {}, memory: {} };
  window.__patch = window.__patch || {};
  window.__gets = [];
  window.__posts = [];
  window.__sockets = [];
  const patchSession = (s) => (s && window.__patch[s.id] ? { ...s, ...window.__patch[s.id] } : s);
  const RealWS = window.WebSocket;
  window.WebSocket = class extends RealWS {
    constructor(...a) { super(...a); window.__sockets.push(this); }
    set onmessage(fn) {
      this.__fn = fn;
      super.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return fn(e); }
        const patchMsg = (x) => (x.t === 'batch' ? { ...x, items: x.items.map(patchMsg) } : (x.t === 'session' || x.t === 'snapshot') && x.session ? { ...x, session: patchSession(x.session) } : x);
        fn({ data: JSON.stringify(patchMsg(m)) });
      };
    }
    get onmessage() { return this.__fn; }
  };
  window.__emit = (msg) => { const s = window.__sockets[window.__sockets.length - 1]; s.__fn({ data: JSON.stringify(msg) }); };
  const real = window.fetch;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const hit = (table, key) => { const v = table[key]; return v === undefined ? reply(404, { error: '沒有這筆資料' }) : v && v.__error ? reply(v.__error.status, { error: v.__error.message }) : reply(200, v); };
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      window.__posts.push(method + ' ' + u);
      const d = window.__postDelay;
      if (d && u.startsWith(d.prefix)) await new Promise((r) => setTimeout(r, d.ms));
      return real(url, init);
    }
    window.__gets.push(u);
    const F = window.__fake;
    let m;
    if (u === '/api/clusters') return reply(200, F.list || []);
    if (u === '/api/machines' && F.online !== null) return reply(200, [{ id: 'm1', name: 'box', online: F.online, kimi: { available: F.online } }]);
    if ((m = u.match(/^\\/api\\/clusters\\/([\\w-]+)\\/cleanup\\/plan$/))) return hit(F.plans || {}, m[1]);
    if ((m = u.match(/^\\/api\\/clusters\\/([\\w-]+)\\/memory$/))) return hit(F.memory, m[1]);
    if ((m = u.match(/^\\/api\\/clusters\\/([\\w-]+)$/))) return hit(F.clusters, m[1]);
    if ((m = u.match(/^\\/api\\/sessions\\/([\\w-]+)\\/clusters$/))) return hit(F.parents, m[1]);
    if ((m = u.match(/^\\/api\\/sessions\\/([\\w-]+)\\/timing$/))) return hit(F.timing, m[1]);
    const res = await real(url, init);
    if (/^\\/api\\/sessions(\\/[\\w-]+)?$/.test(u) && Object.keys(window.__patch).length) {
      const j = await res.clone().json().catch(() => null);
      if (Array.isArray(j)) return reply(res.status, j.map(patchSession));
      if (j && j.id) return reply(res.status, patchSession(j));
    }
    return res;
  };
})()`;

export const CID = 'c_0123456789ab';
export const T0 = Date.now();
export const DS_FLASH = 'agent-hub-deepseek/deepseek-v4.1-flash';

// What the Hub says of a subagent; `i` makes it a different one.
export const SUB = (i, patch = {}) => {
  const s = SUB_BASE(i, patch);
  // One that ended has the moment the Hub saw it end.
  if (['done', 'failed', 'cancelled'].includes(s.status) && !('finishedAt' in patch) && s.startedAt) s.finishedAt = s.startedAt + 5000 + i * 100;
  return s;
};
const SUB_BASE = (i, patch = {}) => ({
  id: `agent-${i}`,
  title: `分包 #${i + 1} (coder)`,
  name: 'coder',
  status: 'running',
  reason: null,
  provider: 'deepseek',
  model: DS_FLASH,
  effort: 'max',
  modelReason: null,
  steps: 3 + i,
  lastAction: `執行 wc -l /root/proj/f${i}.md`,
  startedAt: T0 - 90_000 + i * 1000,
  finishedAt: null,
  background: false,
  eventId: 'e_swarm',
  ...patch,
});
export const countsOf = (list) => {
  const c = { total: list.length, running: 0, awaiting: 0, done: 0, failed: 0, cancelled: 0, unknown: 0 };
  for (const s of list) c[s.status] += 1;
  return c;
};
export const SPEED = (tps = 42.5, rpm = 3.2) => ({ windowMs: 120_000, outTokens: Math.round(tps * 120), tokensPerSecond: tps, requests: Math.round(rpm * 2), requestsPerMinute: rpm, unmeasured: null });
export const NO_SPEED = (why = '這個對話用的不是 DeepSeek 號池（沒有經過連接器的 proxy），沒有請求紀錄可以算速度') => ({ windowMs: null, outTokens: null, tokensPerSecond: null, requests: null, requestsPerMinute: null, unmeasured: why });

export const W = (n, patch = {}) => {
  const subagents = patch.subagents ?? [];
  return {
    sessionId: `s_w${n}`,
    title: `工作者 ${n}：改第 ${n} 區`,
    task: `把第 ${n} 區的登入錯誤訊息改好，並補測試。\n\n（第二段）先讀 README，再動手。`,
    status: 'running',
    branch: `cluster/${CID}/w${n}`,
    worktree: `/home/user/proj-cluster-${CID}/w${n}`,
    swarm: true,
    progress: `正在改第 ${n} 個檔案`,
    finishedAt: null,
    hidden: false,
    taskIndex: n - 1,
    done: 0,
    speed: SPEED(10 * n, n),
    subagentsOlder: 0,
    ...patch,
    subagents,
    subagentCounts: patch.subagentCounts ?? countsOf(subagents),
  };
};
export const CLUSTER = (patch = {}) => ({
  id: CID,
  parentId: 's_kimi',
  createdAt: T0 - 120_000,
  status: 'running',
  mode: 'brief',
  isolate: true,
  swarm: true,
  warnings: [],
  workers: [W(1), W(2, { status: 'idle', finishedAt: T0 - 5000, swarm: false, taskIndex: null, done: 1 }), W(3, { status: 'error', finishedAt: T0 - 1000, taskIndex: null })],
  tasks: [
    { index: 0, title: '任務一', status: 'running', workerSessionId: 's_w1', startedAt: T0 - 100_000, finishedAt: null, attempts: 1, error: null },
    { index: 1, title: '任務二', status: 'done', workerSessionId: 's_w2', startedAt: T0 - 100_000, finishedAt: T0 - 5000, attempts: 1, error: null },
    { index: 2, title: '任務三', status: 'failed', workerSessionId: 's_w3', startedAt: T0 - 100_000, finishedAt: T0 - 1000, attempts: 1, error: 'w3 的回合出錯了' },
  ],
  memory: { path: `/home/user/proj/.git/agent-hub-cluster/${CID}/memory.md`, bytes: 120, updatedAt: T0 - 60_000 },
  merge: null,
  cleanup: null,
  ...patch,
});
export const rowOf = (c, parentTitle = 'Kimi chat with subagents') => ({ ...summarizeCluster(c), parentTitle });

export const TIMING = (patch = {}) => ({ since: T0 - 100_000, turns: 3, wallMs: 100_000, modelMs: 50_000, toolMs: 30_000, compactMs: 0, rateLimitWaitMs: 10_000, requests: 12, http429: 1, subagents: { spawned: 2, requeuedForRateLimit: 0 }, unmeasured: [], ...patch });
export const MEMORY = (text = '# 叢集記憶\n\n- 主對話決定：登入頁用 /auth/login') => ({ path: `/home/user/proj/.git/agent-hub-cluster/${CID}/memory.md`, text, bytes: Buffer.byteLength(text), updatedAt: T0 - 60_000 });

// A browser page that is told `fake` (and `patch`, what to add to the sessions' summaries) in this and every page loaded from now on.
export function fakeHub(b) {
  let script = null;
  return async function setFake(fake = {}, patch = {}) {
    const data = { online: true, clusters: {}, parents: {}, timing: {}, memory: {}, list: [], ...fake };
    if (script) await b.removeBeforeLoad(script);
    const src = `window.__fake = ${JSON.stringify(data)}; window.__patch = ${JSON.stringify(patch)};`;
    script = await b.beforeLoad(src);
    await b.eval(src);
  };
}
