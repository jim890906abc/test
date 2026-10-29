// Lab for Kimi's AgentSwarm / fork behaviour: the REAL Kimi Code CLI behind a scripted
// local OpenAI-compatible model (every request it gets is kept). Kimi's home is a
// scratch folder, the key is fake, nothing leaves the machine. Run the tests that use
// this inside a network namespace so even Kimi's own telemetry cannot get out:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-swarm-fork-lab.test.mjs'
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KIMI = process.env.KIMI_BIN;
const KIMI_PORT = 24000 + Math.floor(Math.random() * 3000);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : c == null ? '' : JSON.stringify(c));
const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// ---------------------------------------------------------------- 假模型
// scenario(ctx) -> { text?, calls?: [{name,args}], delay?: ms }
export function startFake({ scenario, outDir }) {
  const t0 = Date.now();
  const log = []; // 每個串流請求一筆
  let seq = 0;
  let inflight = 0;
  const timeline = []; // { t, inflight, tag, ev }
  fs.mkdirSync(path.join(outDir, 'reqs'), { recursive: true });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch {}
      if (!j.stream) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      const n = ++seq;
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const userTexts = msgs.filter((m) => m.role === 'user').map((m) => stripReminders(str(m.content))).filter(Boolean);
      const ctx = {
        n,
        body: j,
        msgs,
        last,
        lastToolText: last.role === 'tool' ? str(last.content) : '',
        lastUser: userTexts.at(-1) || '',
        userTexts,
        toolNames: (j.tools || []).map((t) => t.function?.name || t.name),
        log,
      };
      const act = (await scenario(ctx)) || { text: `收到：${ctx.lastUser.slice(0, 60)}` };
      const tag = act.tag || ctx.lastUser.split(/\s/)[0].slice(0, 30) + (last.role === 'tool' ? '(+tool)' : '');
      const rec = { n, t: Date.now() - t0, tag, tools: ctx.toolNames, nMsgs: msgs.length, lastRole: last.role, lastUser: ctx.lastUser.slice(0, 100), inflightAtStart: ++inflight, delay: act.delay || 0 };
      log.push(rec);
      timeline.push({ t: rec.t, inflight, tag, ev: 'start', n });
      fs.writeFileSync(path.join(outDir, 'reqs', `${String(n).padStart(3, '0')}.json`), JSON.stringify({ rec, url: req.url, body: j }));
      let closed = false;
      res.on('close', () => {
        if (closed) return;
        closed = true;
        inflight--;
        timeline.push({ t: Date.now() - t0, inflight, tag, ev: 'end', n });
      });
      if (act.delay) await sleep(act.delay);
      const send = (chunks) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...c }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      if (act.calls?.length) {
        const chunks = [{ delta: { role: 'assistant', content: act.pre || '好。' } }];
        act.calls.forEach((c, i) => chunks.push({ delta: { tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }));
        chunks.push({ delta: {}, finish_reason: 'tool_calls' });
        return send(chunks);
      }
      return send([{ delta: { role: 'assistant', content: act.text ?? 'ok' } }, { delta: {}, finish_reason: 'stop' }]);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, log, timeline, t0 })));
}

// ---------------------------------------------------------------- Kimi
const cleanEnv = (extra) => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  ...extra,
});

export async function startKimi({ homeDir, env = {}, outDir, kimiBin = KIMI }) {
  fs.mkdirSync(path.join(homeDir, 'kimi-home'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'home'), { recursive: true });
  const kimiHome = path.join(homeDir, 'kimi-home');
  const p = spawn(kimiBin, ['web', '--no-open', '--port', String(KIMI_PORT)], {
    cwd: homeDir,
    env: cleanEnv({ HOME: path.join(homeDir, 'home'), KIMI_CODE_HOME: kimiHome, ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const logf = fs.createWriteStream(path.join(outDir, 'kimi-web.log'));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`kimi web not ready:\n${out}`)), 30000);
    const on = (d) => {
      out += d;
      logf.write(d);
      if (/Kimi server ready/.test(out)) (clearTimeout(t), resolve());
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
  const token = () => fs.readFileSync(path.join(kimiHome, 'server.token'), 'utf8').trim();
  const api = async (method, p2, body) => {
    const r = await fetch(`http://127.0.0.1:${KIMI_PORT}/api/v1${p2}`, { method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const txt = await r.text();
    try { return JSON.parse(txt).data ?? JSON.parse(txt); } catch { return txt; }
  };
  return { proc: p, api, kimiHome, port: KIMI_PORT };
}

// 停掉自己起的 Kimi（只殺自己 spawn 的那一個 pid，不用 pkill）
export async function stopKimi(k) {
  try { k.proc.kill('SIGTERM'); } catch {}
  try {
    const dir = path.join(k.kimiHome, 'server', 'instances');
    for (const f of fs.readdirSync(dir)) {
      try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).pid, 'SIGTERM'); } catch {}
    }
  } catch {}
  await sleep(500);
}

// ---------------------------------------------------------------- 一場實驗
// steps: 依序送的使用者訊息（每則等到 Kimi 閒置才送下一則）
export async function runExperiment({ workRoot, name, scenario, steps, kimiEnv = {}, swarmMode = true, settleMs = 1500, maxWaitMs = 120000, kimiBin }) {
  const outDir = path.join(workRoot, 'out', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const homeDir = path.join(workRoot, 'kimi-run', name);
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(homeDir, 'project'), { recursive: true });
  const fake = await startFake({ scenario, outDir });
  const k = await startKimi({ homeDir, env: kimiEnv, outDir, kimiBin });
  const meta = { name, kimiEnv, swarmMode, kimiVersion: '2.3.3', fakePort: fake.port, kimiPort: k.port };
  try {
    await k.api('POST', '/providers', { id: 'fake', type: 'openai', api_key: 'sk-fake', base_url: `http://127.0.0.1:${fake.port}/v1`, default_model: 'fake-1', models: [{ model: 'fake-1', max_context_size: 128000 }] });
    await k.api('POST', '/models/fake%2Ffake-1:set_default');
    const cwd = path.join(homeDir, 'project');
    const s = await k.api('POST', '/sessions', { metadata: { cwd } });
    meta.sessionId = s.id;
    const cfg = { permission_mode: 'yolo', model: 'fake/fake-1' };
    if (swarmMode) cfg.swarm_mode = true;
    await k.api('POST', `/sessions/${s.id}/profile`, { agent_config: cfg });
    meta.status = await k.api('GET', `/sessions/${s.id}/status`);
    const idle = async (ms = maxWaitMs) => {
      const end = Date.now() + ms;
      await sleep(400);
      while (Date.now() < end) {
        const d = await k.api('GET', `/sessions/${s.id}`).catch(() => null);
        if (d && !d.busy) return true;
        await sleep(300);
      }
      return false;
    };
    for (const step of steps) {
      const text = typeof step === 'string' ? step : step.text;
      const opt = typeof step === 'string' ? {} : step;
      const pid = 'prompt_' + crypto.randomBytes(6).toString('hex');
      const r = await k.api('POST', `/sessions/${s.id}/prompts`, { prompt_id: pid, content: [{ type: 'text', text }] });
      (meta.prompts ??= []).push({ text, at: Date.now() - fake.t0, result: r });
      if (opt.noIdle) await sleep(opt.wait ?? 3000);
      else {
        const ok = await idle();
        if (!ok) meta.timedOut = true;
        await sleep(opt.wait ?? settleMs);
      }
    }
    // 結果
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(fake.timeline, null, 1));
    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(fake.log, null, 1));
    // 複製 Kimi 的 journal（每個 agent 一份）
    const sroot = path.join(k.kimiHome, 'sessions');
    const copy = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name === 'wire.jsonl') copy.push(fp);
      }
    };
    walk(sroot);
    for (const fp of copy) {
      const rel = path.relative(sroot, fp).replace(/\//g, '__');
      fs.copyFileSync(fp, path.join(outDir, 'journal__' + rel));
    }
    meta.journals = copy.length;
    return { outDir, fake, meta, k };
  } finally {
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
    await stopKimi(k);
    fake.server.close();
  }
}

// ---------------------------------------------------------------- 分析工具
export const loadReqs = (outDir) =>
  fs.readdirSync(path.join(outDir, 'reqs')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(outDir, 'reqs', f), 'utf8')));

export function maxInflight(timeline, pred = () => true) {
  // 只算符合 pred(tag) 的請求
  let cur = 0, max = 0, at = 0;
  const open = new Set();
  const byN = new Map();
  for (const e of timeline) if (pred(e.tag)) byN.set(e.n, true);
  for (const e of timeline) {
    if (!byN.has(e.n)) continue;
    if (e.ev === 'start') { open.add(e.n); cur = open.size; if (cur > max) (max = cur, at = e.t); }
    else { open.delete(e.n); cur = open.size; }
  }
  return { max, at };
}

export function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
