// A performance budget for the front end: switching to a big conversation,
// dragging a divider, a long reply streaming in, typing and opening menus,
// changing the look or light/dark, and letting go of what was built. The limits are generous (several times what is
// measured on this machine, so a busy one does not turn them red) and every
// number is the median of several runs; a run over its limit is measured once
// more before it counts. They are there to catch a change that brings back the
// seconds, not to grade the milliseconds: scripts/perf-ui.mjs prints the numbers.
//
// Skips, saying why, when there is no Chromium.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason } from './browser-harness.mjs';
import { runPerf } from './perf-suite.mjs';

const skip = skipReason();
let windowed;
let whole;
let looks;

// Measure; if any limit is missed, measure again and judge the better of the two.
async function measured(options, ok) {
  const first = await runPerf(options);
  if (ok(first)) return first;
  const second = await runPerf(options);
  return ok(second) ? second : first;
}

const switches = (r) => r.switch.filter((s) => s.id === 's_big');
const switchOk = (r) => switches(r).every((s) => s.first <= 150 && s.paint <= 300 && s.cold <= 600) && r.directSwitch.paint <= 400;
const restOk = (r) => r.drag.fps >= 50 && r.drag.taskPerFrame <= 10 && r.stream.every((x) => x.fps >= 50 && x.longest <= 100) && r.input.typing.median <= 50 && r.input.typing.p95 <= 100 && r.input.slash <= 60 && r.input.model <= 60 && r.input.streaming.p95 <= 100 && r.input.streaming.max <= 100;

// The five changes of look/theme, in a long conversation and with a live page in the side panel.
// The style work is what tells the two ways of fading apart on any machine: 350-700 ms when every
// element had a colour transition, 15-40 ms with the cross-fade (even on a machine so busy that the
// frame numbers double). The frame limits are loose enough for that busy machine and tight enough
// for a page that stutters: under 25 fps or a frame over 120 ms is a page that stutters.
const themeOk = (r) => r.theme.every((t) => t.steps.every((s) => s.fps >= 25 && s.max <= 120 && s.styleMs <= 150 && s.settleMs <= 600) && t.worst.longest <= 100);

before(async () => {
  if (skip) return;
  // The Hub sends the newest 200 events; the rest of the checks run here too.
  windowed = await measured({ only: ['switch', 'drag', 'stream', 'input', 'memory'], runs: 3, events: 3000, window: 200, streamSizes: [12000, 100000], streamSeconds: 6 }, (r) => switchOk(r) && restOk(r) && r.memory.growthMB <= 6);
  // Changing the look from the 設定 menu (a long conversation; one with a live page in the panel).
  looks = await measured({ only: ['theme'], runs: 3, events: 3000, window: 200, themeScenarios: ['desktop', 'panel'] }, themeOk);
  // A Hub that still sends a conversation whole.
  whole = await measured({ only: ['switch'], runs: 3, events: 3000, window: 0 }, (r) => switches(r).every((s) => s.first <= 900));
});

test('a windowed conversation shows its newest messages within 150 ms of the click', { skip }, () => {
  for (const s of switches(windowed)) {
    assert.ok(s.first <= 150, `newest messages visible after ${s.first.toFixed(0)} ms (limit 150)`);
    assert.ok(s.paint <= 300, `and on screen after ${s.paint.toFixed(0)} ms (limit 300)`);
    assert.ok(s.cold <= 600, `the very first open after loading the page: ${s.cold.toFixed(0)} ms (limit 600)`);
    assert.ok(s.nodes <= 8000, `the page holds ${s.nodes} elements, not one per event (limit 8000)`);
    assert.ok(s.parseKB <= 1500, `the first copy is ${s.parseKB} KB (limit 1500)`);
  }
  assert.ok(windowed.directSwitch.paint <= 400, `straight from one big conversation to another: ${windowed.directSwitch.paint.toFixed(0)} ms (limit 400)`);
});

test('a conversation sent whole is cut on the page: few elements, and the first rows well inside a second', { skip }, () => {
  for (const s of switches(whole)) {
    assert.ok(s.first <= 900, `newest messages visible after ${s.first.toFixed(0)} ms (limit 900; it parses ${(s.parseKB / 1024).toFixed(1)} MB)`);
    assert.ok(s.nodes <= 8000, `the page holds ${s.nodes} elements (limit 8000)`);
  }
});

test('dragging a divider keeps 50 frames a second with room to spare on every frame', { skip }, () => {
  assert.ok(windowed.drag.fps >= 50, `${windowed.drag.fps.toFixed(1)} fps (limit 50)`);
  assert.ok(windowed.drag.taskPerFrame <= 10, `${windowed.drag.taskPerFrame.toFixed(2)} ms of main-thread work per frame (limit 10 of 16.7)`);
  assert.ok(windowed.drag.longest <= 50, `longest task ${windowed.drag.longest} ms (limit 50)`);
});

test('a long reply streaming in at 30 updates a second stays smooth, whatever its length', { skip }, () => {
  for (const x of windowed.stream) {
    assert.ok(x.fps >= 50, `${x.chars} characters: ${x.fps.toFixed(1)} fps (limit 50)`);
    assert.ok(x.longest <= 100, `${x.chars} characters: longest task ${x.longest} ms (limit 100)`);
    assert.ok(x.busyPct <= 60, `${x.chars} characters: main thread ${x.busyPct.toFixed(0)}% busy (limit 60)`);
  }
});

test('typing and menus answer within 50 ms in a long conversation, also while a reply streams', { skip }, () => {
  const i = windowed.input;
  assert.ok(i.typing.median <= 50, `typing, median ${i.typing.median.toFixed(1)} ms (limit 50)`);
  assert.ok(i.typing.p95 <= 100, `typing, p95 ${i.typing.p95.toFixed(1)} ms (limit 100)`);
  assert.ok(i.slash <= 60, `the / menu ${i.slash.toFixed(1)} ms (limit 60)`);
  assert.ok(i.model <= 60, `the model menu ${i.model.toFixed(1)} ms (limit 60)`);
  assert.ok(i.streaming.p95 <= 100, `typing while a reply streams, p95 ${i.streaming.p95.toFixed(1)} ms (limit 100)`);
  assert.ok(i.streaming.max <= 100, `typing while a reply streams, slowest key ${i.streaming.max.toFixed(1)} ms (limit 100)`);
});

test('switching between big conversations lets go of what it built', { skip }, () => {
  const m = windowed.memory;
  assert.ok(m.growthMB <= 6, `back at the start page the heap grew ${m.growthMB.toFixed(1)} MB over four rounds (limit 6)`);
  assert.ok(m.home.at(-1).usedMB <= 12, `and what is left at the start page is ${m.home.at(-1).usedMB.toFixed(1)} MB (limit 12)`);
  assert.ok(m.nodesAfter <= m.home[0].nodes, `and no element was left behind (${m.nodesAfter} against ${m.home[0].nodes})`);
  assert.deepEqual([...new Set(m.intervals)].length, 1, `the number of running timers does not grow (${m.intervals.join(', ')})`);
  assert.equal(new Set(m.listeners.map((l) => JSON.stringify(l))).size, 1, 'nor do the listeners on document and window');
});

test('changing the look or light/dark keeps the page moving: little style work, no stutter, no long task, over quickly', { skip }, () => {
  for (const t of looks.theme) {
    const where = t.scenario === 'panel' ? 'with a live page in the panel' : 'in a long conversation';
    for (const s of t.steps) {
      assert.ok(s.styleMs <= 150, `${s.name} ${where}: ${s.styleMs.toFixed(0)} ms of style recalculation (limit 150; it was 350-700 when every element faded)`);
      assert.ok(s.fps >= 25, `${s.name} ${where}: ${s.fps.toFixed(1)} fps (limit 25)`);
      assert.ok(s.max <= 120, `${s.name} ${where}: a frame took ${s.max.toFixed(0)} ms (limit 120)`);
      assert.ok(s.settleMs <= 600, `${s.name} ${where}: ${s.settleMs.toFixed(0)} ms until nothing moves (limit 600)`);
    }
    assert.ok(t.worst.longest <= 100, `${where}: a task of ${t.worst.longest} ms (limit 100)`);
  }
});
