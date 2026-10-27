// The measurements themselves, section by section (see perf-lib.mjs for the
// pieces). `runPerf` returns plain data; `printTable` shows it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWindowingProxy } from './fixtures/windowing-proxy.mjs';
import { newPage, openHome, measureSwitch, measureDrag, measureStream, measureInput, measureMotion, measureTheme, heap, median, synthSession, withArtifact, startHubOn, sleep } from './perf-lib.mjs';

const bigIds = (dataDir, n = 4) =>
  fs
    .readdirSync(path.join(dataDir, 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.replace(/\.json$/, ''), size: fs.statSync(path.join(dataDir, 'sessions', f)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, n);

export async function runPerf({ dataDir = null, only = ['switch', 'drag'], runs = 5, events = 3000, window: win = 0, ids = null, streamSizes = [3000, 12000, 100000], streamSeconds = undefined, themeScenarios = ['desktop', 'panel', 'mobile'], themeTrace = false, log = () => {} } = {}) {
  const want = (s) => only.includes(s);
  const sessions = dataDir ? [] : [synthSession({ id: 's_big', title: '大型對話 A', count: events, seed: 7 }), synthSession({ id: 's_big2', title: '大型對話 B', count: Math.round(events / 2), seed: 11 }), synthSession({ id: 's_small', title: '小對話', count: 60, seed: 3 })];
  // A conversation that has made a page (for the side panel's Artifact, an iframe) to change colours with.
  if (!dataDir && want('theme')) sessions.push(withArtifact(synthSession({ id: 's_art', title: '有頁面的對話', count: Math.round(events / 3), seed: 5 })));
  const hub = await startHubOn({ dataDir, sessions });
  const proxy = await startWindowingProxy({ target: hub.url, size: win || null });
  const url = proxy.url;
  const targets = ids || (dataDir ? bigIds(dataDir, 4).map((x) => x.id) : ['s_big', 's_big2', 's_small']);
  const out = { mode: dataDir ? 'real-copy' : 'synthetic', window: win || null, events: dataDir ? null : events, runs, switch: [], drag: null, memory: null, notes: [] };
  const b = await newPage();
  out.load = { start: os.loadavg()[0] };
  try {
    if (win) for (const id of targets) await proxy.warm(id);
    await openHome(b, url);
    if (want('switch')) {
      for (const id of targets) {
        const title = await b.eval(`document.querySelector('a.side-row[href="#/s/${id}"] .row-title')?.textContent || ''`);
        const rows = [];
        for (let i = 0; i < runs + 1; i++) {
          rows.push(await measureSwitch(b, id));
          log(`switch ${id} #${i} first=${rows.at(-1).first?.toFixed(0)} paint=${rows.at(-1).paint?.toFixed(0)}`);
        }
        const cold = rows[0];
        const warm = rows.slice(1);
        out.switch.push({
          id,
          title: title.slice(0, 24),
          cold: cold.paint,
          first: median(warm.map((x) => x.first)),
          paint: median(warm.map((x) => x.paint)),
          longest: median(warm.map((x) => x.longest)),
          parseKB: Math.round(median(warm.map((x) => x.parseBytes)) / 1024),
          rows: warm[0].rows,
          nodes: warm[0].nodes,
        });
      }
      // A straight switch from one big conversation to another.
      if (targets.length > 1) {
        const rows = [];
        for (let i = 0; i < runs; i++) {
          await b.eval(`location.hash = '#/s/${targets[0]}'`);
          await sleep(900);
          rows.push(await measureSwitch(b, targets[1], { from: null }));
        }
        out.directSwitch = { from: targets[0], to: targets[1], first: median(rows.map((x) => x.first)), paint: median(rows.map((x) => x.paint)) };
      }
    }
    if (want('drag')) {
      await b.eval(`location.hash = '#/s/${targets[0]}'`);
      await b.waitFor(`document.querySelector('.transcript .column .ev')`, { timeout: 20000 });
      await sleep(1500);
      await b.click('button[title^="面板"]');
      await b.waitFor(`document.querySelector('.panel-grip')`, { timeout: 8000 });
      await sleep(500);
      const tries = [];
      for (let i = 0; i < Math.max(3, runs); i++) tries.push(await measureDrag(b));
      const m = (k) => median(tries.map((x) => x[k]));
      out.drag = { fps: m('fps'), p95: m('p95'), max: m('max'), longest: m('longest'), frames: tries[0].frames, taskPerFrame: m('taskPerFrame'), layoutPerFrame: m('layoutPerFrame'), layoutsPerFrame: m('layoutsPerFrame'), stylePerFrame: m('stylePerFrame') };
    }
    if (want('stream')) {
      await b.eval(`location.hash = '#/s/${targets[0]}'`);
      await b.waitFor(`[...document.querySelectorAll('.transcript .column > .ev')].some((e) => e.textContent.trim())`, { timeout: 20000 });
      await sleep(1500);
      out.stream = [];
      for (const chars of streamSizes) {
        const r = await measureStream(b, proxy, targets[0], { chars, perSec: 30, seconds: streamSeconds, id: `live_${chars}` });
        out.stream.push({ chars, ...r });
        log(`stream ${chars}: ${r.fps.toFixed(1)} fps, longest ${r.longest.toFixed(0)} ms`);
      }
    }
    if (want('motion')) {
      await b.eval(`location.hash = '#/s/${targets[0]}'`);
      await b.waitFor(`[...document.querySelectorAll('.transcript .column > .ev')].some((e) => e.textContent.trim())`, { timeout: 20000 });
      await sleep(1500);
      out.motion = await measureMotion(b, { switchTo: targets[1] || null });
    }
    if (want('theme')) {
      // The colour changes, from the 設定 menu: a long conversation, with the side panel
      // holding a live page (an iframe), and at a phone's width.
      const sid = ids?.[0] || (dataDir ? targets[0] : 's_art');
      out.theme = [];
      for (const sc of themeScenarios) {
        const mobile = sc === 'mobile';
        await b.size(mobile ? 390 : 1280, mobile ? 844 : 900, mobile);
        await b.eval(`location.hash = '#/'`);
        await sleep(600);
        await b.eval(`location.hash = '#/s/${sid}'`);
        await b.waitFor(`[...document.querySelectorAll('.transcript .column > .ev')].some((e) => e.textContent.trim())`, { timeout: 30000 });
        await sleep(1500);
        if (sc === 'panel') {
          await b.click('button[title^="面板"]');
          await b.waitFor(`document.querySelector('iframe.artifact-frame')`, { timeout: 8000 });
          await sleep(1500);
        }
        if (mobile) {
          await b.click('.sidebar-toggle');
          await b.waitFor(`document.querySelector('.app.drawer')`);
          await sleep(500);
        }
        const nodes = await b.eval(`document.getElementsByTagName('*').length`);
        const r = await measureTheme(b, { runs: Math.max(1, runs), trace: themeTrace, log: (m) => log(`[${sc}] ${m}`) });
        out.theme.push({ scenario: sc, nodes, ...r });
        if (mobile) await b.size(1280, 900);
        if (sc === 'panel') await b.click('button[title^="面板"]');
      }
    }
    if (want('input')) {
      await b.eval(`location.hash = '#/s/${targets[0]}'`);
      await b.waitFor(`[...document.querySelectorAll('.transcript .column > .ev')].some((e) => e.textContent.trim()) && document.querySelector('.composer-input')`, { timeout: 20000 });
      await sleep(1500);
      out.input = await measureInput(b);
      out.input.streaming = (await measureInput(b, { keys: 40, streaming: { proxy, sid: targets[0] } })).typing;
    }
    if (want('memory')) {
      const big = targets.slice(0, 3);
      await b.eval(`location.hash = '#/'`);
      await sleep(600);
      const home = [];
      const viewing = [];
      for (let round = 0; round < 4; round++) {
        for (const id of big) await measureSwitch(b, id, { settle: 300 });
        await sleep(500);
        viewing.push(await heap(b)); // the last big one still open
        await b.eval(`location.hash = '#/'`);
        await sleep(800);
        home.push(await heap(b));
        log(`memory round ${round}: open ${viewing.at(-1).usedMB.toFixed(1)} MB / ${viewing.at(-1).nodes} nodes, home ${home.at(-1).usedMB.toFixed(1)} MB / ${home.at(-1).nodes} nodes`);
      }
      out.memory = { viewing, home, growthMB: home.at(-1).usedMB - home[0].usedMB, openGrowthMB: viewing.at(-1).usedMB - viewing[0].usedMB, nodesAfter: home.at(-1).nodes, intervals: home.map((x) => x.intervals), listeners: home.map((x) => x.listeners) };
    }
    if (win) out.proxy = { ...proxy.stats };
    out.load.end = os.loadavg()[0];
  } finally {
    await b.close();
    await proxy.close();
    hub.stop();
  }
  return out;
}

const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');

export function printTable(r) {
  const lines = [];
  lines.push(`perf-ui  mode=${r.mode}${r.window ? `  window=${r.window}` : ''}${r.events ? `  events=${r.events}` : ''}  runs=${r.runs}${r.load ? `  machine load ${r.load.start.toFixed(1)} → ${r.load.end?.toFixed(1)} (cores: ${os.cpus().length}; a busy machine makes every number worse)` : ''}`);
  if (r.switch.length) {
    lines.push('', '切換對話（點擊 → 最新訊息可見 / 畫出來，ms）');
    lines.push('對話                     冷啟動   首批可見   畫出    最長任務  解析KB   列數   節點');
    for (const s of r.switch) lines.push(`${s.title.padEnd(22)}  ${f(s.cold).padStart(6)}  ${f(s.first).padStart(8)}  ${f(s.paint).padStart(6)}  ${f(s.longest).padStart(8)}  ${String(s.parseKB).padStart(6)}  ${String(s.rows).padStart(5)}  ${String(s.nodes).padStart(6)}`);
    if (r.directSwitch) lines.push(`直接 A→B 切換：首批 ${f(r.directSwitch.first)} ms，畫出 ${f(r.directSwitch.paint)} ms`);
  }
  if (r.motion) {
    lines.push('', '轉場（動畫期間：排版次數 / 影格 fps / 影格間隔最大 ms / 最長任務 ms）');
    for (const m of r.motion) lines.push(`  ${m.name.padEnd(10)} 排版 ${m.layouts} 次，${f(m.fps, 1)} fps，最大間隔 ${f(m.max, 1)} ms，最長任務 ${f(m.longest)} ms，動畫 ${m.animations} 個`);
  }
  if (r.drag) lines.push('', `拖曳面板分隔線：${f(r.drag.fps, 1)} fps，影格間隔 p95 ${f(r.drag.p95, 1)} ms / 最大 ${f(r.drag.max, 1)} ms，最長任務 ${f(r.drag.longest)} ms（${r.drag.frames} 影格）；每影格主執行緒 ${f(r.drag.taskPerFrame, 2)} ms（排版 ${f(r.drag.layoutPerFrame, 2)} ms × ${f(r.drag.layoutsPerFrame, 2)} 次、樣式 ${f(r.drag.stylePerFrame, 2)} ms）`);
  if (r.memory) {
    lines.push('', '記憶體（每輪輪流開 3 個大對話；MB / DOM 節點）');
    lines.push(`  開著最後一個：${r.memory.viewing.map((x) => `${f(x.usedMB, 1)}/${x.nodes}`).join(' → ')}；4 輪成長 ${f(r.memory.openGrowthMB, 1)} MB`);
    lines.push(`  回到首頁後：  ${r.memory.home.map((x) => `${f(x.usedMB, 1)}/${x.nodes}`).join(' → ')}；4 輪成長 ${f(r.memory.growthMB, 1)} MB`);
    lines.push(`  執行中的計時器：${r.memory.intervals.join(' → ')}；document/window/body 監聽器：${r.memory.listeners.map((l) => `${l.document}/${l.window}/${l.body}`).join(' → ')}`);
  }
  if (r.input) lines.push('', `輸入延遲（事件 → 下一影格開始，ms）：打字 中位 ${f(r.input.typing.median, 1)} / p95 ${f(r.input.typing.p95, 1)} / 最大 ${f(r.input.typing.max, 1)}（${r.input.typing.n} 鍵）；「/」選單 ${f(r.input.slash, 1)}；模型選單 ${f(r.input.model, 1)}${r.input.streaming ? `；串流中打字 中位 ${f(r.input.streaming.median, 1)} / p95 ${f(r.input.streaming.p95, 1)} / 最大 ${f(r.input.streaming.max, 1)}` : ''}`);
  if (r.stream) {
    lines.push('', '串流（每秒 30 個 delta 打進一則回覆；影格 fps／間隔 p95／最長任務／主執行緒忙碌）');
    for (const x of r.stream) lines.push(`  ${String(x.chars).padStart(6)} 字：${f(x.fps, 1)} fps，p95 ${f(x.p95, 1)} ms，最大 ${f(x.max, 1)} ms，最長任務 ${f(x.longest)} ms，忙碌 ${f(x.busyPct, 1)}%（腳本 ${f(x.scriptMs)} / 排版 ${f(x.layoutMs)} / 樣式 ${f(x.styleMs)} ms）`);
  }
  if (r.theme) {
    lines.push('', '換配色／淺深色（從 設定 選單點選 → 畫面不再變動；中位數；fps／影格間隔／掉影格為變色期間，樣式重算為點擊後 750ms 內）');
    for (const t of r.theme) {
      lines.push(`  ${{ desktop: '桌面', panel: '桌面＋Artifact 面板', mobile: '手機寬度' }[t.scenario] || t.scenario}（${t.nodes} 個元素）`);
      lines.push('    切換               套用   穩定   fps   間隔p95  最大  掉影格  >33ms  最長任務  樣式重算(次/ms)  排版(次/ms)');
      for (const s of t.steps) lines.push(`    ${s.name.padEnd(16)}  ${f(s.applyMs).padStart(5)}  ${f(s.settleMs).padStart(5)}  ${f(s.fps, 1).padStart(5)}  ${f(s.p95, 1).padStart(6)}  ${f(s.max, 1).padStart(5)}  ${f(s.dropped).padStart(5)}  ${f(s.over33).padStart(5)}  ${(s.traced ? f(s.traced.longestTaskMs) : '—').padStart(7)}  ${`${f(s.styleCount)} / ${f(s.styleMs, 1)}`.padStart(15)}  ${`${f(s.layoutCount)} / ${f(s.layoutMs, 1)}`.padStart(11)}${s.viaViewTransition ? '  [交叉淡入]' : ''}`);
      const w = t.worst;
      lines.push(`    最差：影格間隔最大 ${f(w.maxFrameGap, 1)} ms，最低 ${f(w.minFps, 1)} fps，最長任務 ${f(w.longestTraced ?? w.longest)} ms${w.longestTraced == null ? '（觀測器，>50ms 才算）' : '（trace）'}，穩定最久 ${f(w.settleMs)} ms，樣式重算最多 ${f(w.styleMs, 1)} ms`);
    }
  }
  if (r.motion) lines.push('', `轉場：${JSON.stringify(r.motion)}`);
  if (r.proxy) lines.push('', `視窗化代理：${JSON.stringify(r.proxy)}`);
  console.log(lines.join('\n'));
}
