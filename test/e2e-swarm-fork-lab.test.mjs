// What Kimi Code's AgentSwarm / Agent `fork` really does, measured with the REAL Kimi
// CLI (its real journal, tools and subagent machinery) behind a scripted local model.
// No account, no network: Kimi's home is a scratch folder and the model key is fake.
// Run it inside a network namespace so not even Kimi's own telemetry can get out:
//
//   KIMI_BIN=~/.kimi-code/bin/kimi unshare -rn sh -c 'ip link set lo up && exec node --test test/e2e-swarm-fork-lab.test.mjs'
//
// These are facts about the Kimi version under test (written for 2.3.3), not about the
// Hub: when a new Kimi changes one of them, the failing test names which one.
//  - `fork` needs KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=1; without it the argument is refused;
//  - a fork starts from the caller's whole history (same system prompt, same tools,
//    same cache key), so its first request begins with the caller's last request;
//  - a forked subagent has Agent and AgentSwarm in its tool list, but swarm mode is off
//    for it: its AgentSwarm is refused, its Agent calls run (in parallel), and a fork of
//    a fork carries both generations' history;
//  - the snapshot is taken once; a resumed subagent keeps its own accumulated context;
//  - KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY caps an AgentSwarm only, not Agent calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kimiGate } from './fixtures/kimi-bin.mjs';
import { runExperiment, loadReqs, maxInflight } from './fixtures/swarm-lab.mjs';
import { scenarios } from './fixtures/swarm-lab-scenarios.mjs';

const { KIMI, SKIP } = kimiGate('e2e-swarm-fork-lab');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-swarmlab-'));
const FORK = { KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK: '1' };

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : JSON.stringify(c));
const names = (r) => (r.body.tools || []).map((t) => t.function.name);

// Runs one scenario with the given Kimi env and LAB_* knobs; returns what the model was asked.
async function lab(label, scenario, kimiEnv = {}, knobs = {}) {
  const was = {};
  for (const [k, v] of Object.entries(knobs)) (was[k] = process.env[k]), (process.env[k] = String(v));
  try {
    const def = scenarios[scenario];
    const res = await runExperiment({ workRoot: ROOT, name: label, scenario: def.scenario, steps: def.steps, kimiEnv, maxWaitMs: def.maxWaitMs ?? 150000, kimiBin: KIMI });
    const reqs = loadReqs(res.outDir);
    const tagged = (tag) => reqs.filter((r) => r.rec.tag === tag);
    return { ...res, reqs, tagged, timeline: res.fake.timeline };
  } finally {
    for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
const toolResults = (r) => r.body.messages.filter((m) => m.role === 'tool').map((m) => text(m.content));

test('fork on: each forked subagent starts from the caller\'s whole history, same tools, same cache key', { skip: SKIP }, async () => {
  const x = await lab('A', 'A', FORK);
  const main = x.tagged('main-launch')[0];
  const forks = x.tagged('fork-A');
  assert.equal(forks.length, 3);
  assert.equal(main.body.messages.length, 8);
  for (const f of forks) {
    assert.equal(f.body.messages.length, 14);
    assert.deepEqual(f.body.messages.slice(0, 8), main.body.messages, 'the caller\'s last request is a prefix of the fork\'s first');
    assert.match(JSON.stringify(f.body.messages), /HISTORY_MARKER_ALPHA[\s\S]*HISTORY_MARKER_BETA/);
    assert.deepEqual(f.body.tools, main.body.tools, 'the whole tool list, including Agent and AgentSwarm');
    assert.ok(names(f).includes('Agent') && names(f).includes('AgentSwarm'));
    assert.equal(f.body.prompt_cache_key, main.body.prompt_cache_key);
    assert.equal(f.body.messages[8].tool_calls[0].function.name, 'AgentSwarm', 'the pending AgentSwarm call is in the snapshot...');
    assert.match(text(f.body.messages[9].content), /still executing when this conversation snapshot was inherited/, '...with a stub result');
    assert.match(text(f.body.messages[10].content), /not your own history/);
    assert.match(text(f.body.messages[13].content), /Swarm Mode Ended/, 'swarm mode is announced as ended for the fork');
  }
  // Siblings differ only in the task and what follows it.
  assert.deepEqual(forks[0].body.messages.slice(0, 11), forks[1].body.messages.slice(0, 11));
  assert.notDeepEqual(forks[0].body.messages[11], forks[1].body.messages[11]);
});

test('fork off (the default): the argument is not in the tool schema and a call with it is refused', { skip: SKIP }, async () => {
  const x = await lab('A0', 'A0', {});
  const main = x.tagged('main-launch')[0];
  assert.ok(!('fork' in main.body.tools.find((t) => t.function.name === 'AgentSwarm').function.parameters.properties));
  const answer = toolResults(x.tagged('main-final')[0]).at(-1);
  assert.match(answer, /must NOT have additional property 'fork'/);
  assert.equal(x.tagged('fork-A').length, 0, 'no subagent started');
});

test('a forked subagent calling AgentSwarm (forked or not) is refused: swarm mode is off for it', { skip: SKIP }, async () => {
  for (const v of ['B1', 'B1F']) {
    const x = await lab(v, v, FORK);
    const finals = x.tagged('sub-final');
    assert.equal(finals.length, 2);
    for (const f of finals) assert.match(toolResults(f).at(-1), /Swarm mode is off, so AgentSwarm did not run and no subagents were started/);
    assert.equal(x.tagged('grand').length, 0, `${v}: no second layer started`);
  }
});

test('a forked subagent\'s Agent calls run, three in one turn in parallel; plain children have no Agent/AgentSwarm', { skip: SKIP }, async () => {
  const x = await lab('B2', 'B2', FORK);
  const kids = x.tagged('grand');
  assert.equal(kids.length, 3);
  for (const k of kids) {
    assert.ok(!names(k).includes('Agent') && !names(k).includes('AgentSwarm'));
    assert.equal(k.body.messages.length, 4, 'no history: a plain child starts from zero context');
  }
  assert.equal(maxInflight(x.timeline, (t) => t === 'grand').max, 3, 'the three children overlap');
  assert.equal(toolResults(x.tagged('sub-final')[0]).filter((t) => /status: completed/.test(t)).length, 3);
});

test('a fork of a fork carries both generations; sibling forks share everything up to their task', { skip: SKIP }, async () => {
  const x = await lab('B2F', 'B2F', FORK);
  const leader = x.tagged('sub-call-3agents')[0];
  const kids = x.tagged('grand');
  assert.equal(kids.length, 3);
  for (const k of kids) {
    assert.deepEqual(k.body.messages.slice(0, leader.body.messages.length), leader.body.messages);
    assert.ok(names(k).includes('Agent') && names(k).includes('AgentSwarm'));
    assert.match(JSON.stringify(k.body.messages), /HISTORY_MARKER_ALPHA/, 'the first generation\'s history is there too');
  }
  assert.deepEqual(kids[0].body.messages.slice(0, 17), kids[1].body.messages.slice(0, 17));
  assert.notDeepEqual(kids[0].body.messages[17], kids[1].body.messages[17], 'they differ only in their task');
});

test('fork chain: B (forked by A, forked by main) sees main\'s history, A\'s steps and A\'s pending call; no depth limit by 12', { skip: SKIP }, async () => {
  const q = await lab('Q6', 'Q6', FORK);
  const aLast = q.tagged('A-fork-B')[0];
  const b = q.tagged('B-first')[0];
  assert.deepEqual(b.body.messages.slice(0, aLast.body.messages.length), aLast.body.messages, 'A\'s whole request is the prefix of B\'s');
  const all = JSON.stringify(b.body.messages);
  for (const k of ['HISTORY_MARKER_ALPHA', 'HISTORY_MARKER_BETA', 'LAUNCH:Q6', 'Q6A_TASK', 'Q6A_STEP1_OUTPUT', 'Q6A_STEP2_OUTPUT', 'Q6B_TASK']) assert.ok(all.includes(k), k);
  assert.equal((all.match(/not your own history/g) || []).length, 2, 'one notice per generation');

  const d = await lab('B3', 'B3', FORK, { LAB_DEPTH: 12 });
  assert.equal(d.tagged('chain-12-stop').length, 1, 'twelve generations deep, nothing refused');
  assert.equal(d.reqs.filter((r) => toolResults(r).some((t) => /ERROR|Cannot|limit/i.test(t) && !/still executing/.test(t))).length, 0);
});

test('the snapshot is taken once: a running fork never sees what the caller says later; a resumed one keeps its own context', { skip: SKIP }, async () => {
  const x = await lab('Q7', 'Q7', FORK);
  const first = x.tagged('A-first')[0];
  const second = x.tagged('A-second')[0];
  const resumedR = x.tagged('A-resumed-R')[0];
  const resumedS = x.tagged('A-resumed-S')[0];
  const mainLater = x.reqs.filter((r) => r.rec.tag === 'main-chat' && JSON.stringify(r.body.messages).includes('LATER_MARKER_2'));
  assert.ok(mainLater.length > 0, 'the premise: the caller did hear LATER_MARKER_1/2 while A ran');
  assert.ok(x.meta.prompts[3].at < second.rec.t, 'and said it before A\'s next request');
  for (const r of [first, second, resumedR, resumedS]) assert.doesNotMatch(JSON.stringify(r.body.messages), /LATER_MARKER/);
  assert.deepEqual(second.body.messages.slice(0, first.body.messages.length), first.body.messages, 'A\'s own steps are appended to its snapshot');
  assert.match(JSON.stringify(resumedR.body.messages), /Q7A_STEP1_OUTPUT[\s\S]*Q7A_FINAL[\s\S]*Q7R_CONTINUE/, 'resume (Agent) brings A\'s accumulated context');
  assert.match(JSON.stringify(resumedS.body.messages), /Q7R_FINAL[\s\S]*Q7S_CONTINUE/, 'resume_agent_ids (AgentSwarm) too, including the earlier resume');
  assert.deepEqual(resumedS.body.messages.slice(0, resumedR.body.messages.length), resumedR.body.messages);
});

test('AgentSwarm concurrency: 20 items all in flight with no cap; the env cap holds it at 8', { skip: SKIP }, async () => {
  const knobs = { LAB_N: 20, LAB_HOLD: 14000 };
  const open = await lab('C', 'C', FORK, knobs);
  assert.equal(maxInflight(open.timeline, (t) => t === 'conc').max, 20);
  const starts = open.timeline.filter((e) => e.ev === 'start' && e.tag === 'conc').map((e) => e.t);
  assert.ok(starts[4] - starts[0] < 500, 'five at once...');
  assert.ok(starts[19] - starts[4] > 8000, '...then about one every 700 ms');
  const capped = await lab('C8', 'C', { ...FORK, KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '8' }, knobs);
  assert.equal(maxInflight(capped.timeline, (t) => t === 'conc').max, 8);
});

test('the cap does not apply to Agent calls: two forked leaders firing 12 Agent calls each run 24 at once', { skip: SKIP }, async () => {
  const x = await lab('B2N', 'B2N', { ...FORK, KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '8' }, { LAB_N: 12, LAB_HOLD: 4000 });
  assert.equal(maxInflight(x.timeline, (t) => t === 'conc').max, 24);
  const final = toolResults(x.tagged('main-final')[0]).at(-1);
  assert.equal((final.match(/收到 12 個完成、0 個錯誤/g) || []).length, 2);
});
