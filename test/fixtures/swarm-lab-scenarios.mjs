// Scripted-model scenarios for test/e2e-swarm-fork-lab.test.mjs (see fixtures/swarm-lab.mjs).
// A scenario decides, request by request, what the scripted model says; the first word of
// the newest user message (LAUNCH:x, FORKTASK_x, ...) tells which agent is asking.

const SWARM = (description, template, items, extra = {}) => ({ name: 'AgentSwarm', args: { description, prompt_template: template, items, ...extra } });
const AGENT = (description, prompt, extra = {}) => ({ name: 'Agent', args: { description, prompt, ...extra } });
const items = (n) => Array.from({ length: n }, (_, i) => `i${String(i + 1).padStart(2, '0')}`);

// 每個實驗：scenario(ctx) 決定假模型這一步說什麼
const E = {};

// --- smoke：只聊天，確認管線
E.smoke = {
  steps: ['HISTORY_MARKER_ALPHA 你好'],
  scenario: (c) => ({ text: `ack ${c.lastUser.slice(0, 40)}` }),
};

// --- A：fork 基本（Q1/Q2/Q5）。先有歷史，再 AgentSwarm fork:true
E.A = {
  steps: ['HISTORY_MARKER_ALPHA 先聊一輪', 'HISTORY_MARKER_BETA 再聊一輪', 'LAUNCH:A 請開 fork 子代理群'],
  scenario: (c) => {
    if (c.last.role === 'tool') return { text: `主代理收到工具結果：${c.lastToolText.slice(0, 1500)}`, tag: 'main-final' };
    if (c.lastUser.startsWith('LAUNCH:A')) return { calls: [SWARM('fork 測試', 'FORKTASK_A {{item}}', ['a', 'b', 'c'], { fork: true })], tag: 'main-launch' };
    if (c.lastUser.startsWith('FORKTASK_A')) return { text: `fork 子代理回覆 ${c.lastUser}`, tag: 'fork-A', delay: 800 };
    return { text: `ack ${c.lastUser.slice(0, 40)}`, tag: 'main-chat' };
  },
};

// --- A0：對照組，不開 fork 旗標卻帶 fork:true（確認旗標關時的錯誤原文）
E.A0 = { ...E.A };

// --- B：fork 子代理再開子代理
// B1：子代理呼叫 AgentSwarm（非 fork）
// B1F：子代理呼叫 AgentSwarm fork:true
// B2：子代理同一回合連發 3 個 Agent（非 fork），孫代理各 hold 3 秒
// B2F：同上但 fork:true
// B3：Agent fork 鏈（深度）
const nested = (variant) => ({
  steps: ['HISTORY_MARKER_ALPHA 先聊一輪', `LAUNCH:${variant}`],
  scenario: (c) => {
    const u = c.lastUser;
    // 主代理
    if (u.startsWith('LAUNCH:B1F')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 600)}`, tag: 'main-final' } : { calls: [SWARM('外層 fork 群', 'FORKTASK_B1F {{item}}', ['x', 'y'], { fork: true })], tag: 'main-launch' };
    if (u.startsWith('LAUNCH:B1')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 600)}`, tag: 'main-final' } : { calls: [SWARM('外層 fork 群', 'FORKTASK_B1 {{item}}', ['x', 'y'], { fork: true })], tag: 'main-launch' };
    if (u.startsWith('LAUNCH:B2F')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 600)}`, tag: 'main-final' } : { calls: [AGENT('外層單一 fork', 'FORKTASK_B2F', { fork: true })], tag: 'main-launch' };
    if (u.startsWith('LAUNCH:B2')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 600)}`, tag: 'main-final' } : { calls: [AGENT('外層單一 fork', 'FORKTASK_B2', { fork: true })], tag: 'main-launch' };
    if (u.startsWith('LAUNCH:B3')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 900)}`, tag: 'main-final' } : { calls: [AGENT('深度鏈 1', 'DEPTHCHAIN 1', { fork: true })], tag: 'main-launch' };
    // fork 子代理
    if (u.startsWith('FORKTASK_B1F')) return c.last.role === 'tool' ? { text: `B1F 子代理看到工具結果：${c.lastToolText.slice(0, 600)}`, tag: 'sub-final' } : { calls: [SWARM('內層 fork 群', 'GRANDTASK {{item}}', ['p', 'q'], { fork: true })], tag: 'sub-call-swarm-fork' };
    if (u.startsWith('FORKTASK_B1')) return c.last.role === 'tool' ? { text: `B1 子代理看到工具結果：${c.lastToolText.slice(0, 600)}`, tag: 'sub-final' } : { calls: [SWARM('內層群', 'GRANDTASK {{item}}', ['p', 'q'])], tag: 'sub-call-swarm' };
    if (u.startsWith('FORKTASK_B2F')) return c.last.role === 'tool' ? { text: `B2F 子代理看到工具結果：${c.lastToolText.slice(0, 300)}`, tag: 'sub-final' } : { calls: [AGENT('孫1', 'GRANDAGENT 1', { fork: true }), AGENT('孫2', 'GRANDAGENT 2', { fork: true }), AGENT('孫3', 'GRANDAGENT 3', { fork: true })], tag: 'sub-call-3agents' };
    if (u.startsWith('FORKTASK_B2')) {
      if (c.last.role === 'tool') {
        // 三個工具結果在最後三則 tool 訊息
        const tools = c.msgs.slice(-3).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 200));
        return { text: `B2 子代理看到 ${tools.length} 個工具結果：${tools.join(' || ')}`, tag: 'sub-final' };
      }
      return { calls: [AGENT('孫1', 'GRANDAGENT 1'), AGENT('孫2', 'GRANDAGENT 2'), AGENT('孫3', 'GRANDAGENT 3')], tag: 'sub-call-3agents' };
    }
    if (u.startsWith('GRANDAGENT')) return { text: `孫代理 ${u} 完成`, delay: 3000, tag: 'grand' };
    if (u.startsWith('GRANDTASK')) return { text: `孫代理 ${u} 完成`, delay: 500, tag: 'grand' };
    // B3 深度鏈
    const m = u.match(/^DEPTHCHAIN (\d+)/);
    if (m) {
      const d = Number(m[1]);
      if (c.last.role === 'tool') return { text: `深度 ${d} 收到：${c.lastToolText.slice(0, 400)}`, tag: `chain-${d}-final` };
      if (d >= Number(process.env.LAB_DEPTH || 12)) return { text: `深度 ${d} 到頂（假模型自己停）`, tag: `chain-${d}-stop` };
      return { calls: [AGENT(`深度鏈 ${d + 1}`, `DEPTHCHAIN ${d + 1}`, { fork: true })], tag: `chain-${d}` };
    }
    return { text: `ack ${u.slice(0, 40)}`, tag: 'main-chat' };
  },
});
for (const v of ['B1', 'B1F', 'B2', 'B2F', 'B3']) E[v] = nested(v);

// --- C：並行（Q4）。20 項、每個子代理的請求 hold 15 秒
const conc = (fork) => ({
  steps: [fork ? 'HISTORY_MARKER_ALPHA 先聊' : 'warm 先聊', `LAUNCH:C 開 20 項`],
  scenario: (c) => {
    const u = c.lastUser;
    if (c.last.role === 'tool') return { text: `主收到：${c.lastToolText.slice(0, 300)}`, tag: 'main-final' };
    if (u.startsWith('LAUNCH:C')) return { calls: [SWARM('20 項併發', 'CONCTASK {{item}}', items(Number(process.env.LAB_N || 20)), fork ? { fork: true } : {})], tag: 'main-launch' };
    if (u.startsWith('CONCTASK')) return { text: `完成 ${u}`, delay: Number(process.env.LAB_HOLD || 15000), tag: 'conc' };
    return { text: `ack`, tag: 'main-chat' };
  },
});
E.C = conc(false);
E.CF = conc(true);


const BASH = (cmd) => ({ name: 'Bash', args: { command: cmd, description: '印一行標記' } });
const toolText = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

// --- Q6：兩層 fork 的記憶傳遞。主 → fork A（做兩步 Bash）→ A 再 fork B
E.Q6 = {
  steps: ['HISTORY_MARKER_ALPHA 先聊一輪', 'HISTORY_MARKER_BETA 再聊一輪', 'LAUNCH:Q6 請 fork 一個 A'],
  scenario: (c) => {
    const u = c.lastUser;
    if (u.startsWith('LAUNCH:Q6')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 500)}`, tag: 'main-final' } : { calls: [AGENT('Q6 的 A', 'Q6A_TASK 你是 A', { fork: true })], tag: 'main-launch' };
    if (u.startsWith('Q6A_TASK')) {
      if (c.last.role === 'user') return { calls: [BASH('echo Q6A_STEP1_OUTPUT')], tag: 'A-step1' };
      const t = c.lastToolText;
      if (t.includes('Q6A_STEP1_OUTPUT')) return { calls: [BASH('echo Q6A_STEP2_OUTPUT')], tag: 'A-step2' };
      if (t.includes('Q6A_STEP2_OUTPUT')) return { calls: [AGENT('Q6 的 B', 'Q6B_TASK 你是 B', { fork: true })], tag: 'A-fork-B' };
      return { text: `A 完成，B 回報：${t.slice(0, 300)}`, tag: 'A-final' };
    }
    if (u.startsWith('Q6B_TASK')) return { text: 'B 完成', tag: 'B-first' };
    return { text: `ack ${u.slice(0, 40)}`, tag: 'main-chat' };
  },
};

// --- Q7：快照是一次性的？A 被 fork（背景）後主代理再講兩輪；A 之後的請求看得到嗎？resume 後帶什麼？
const agentIdIn = (c) => {
  for (const m of c.msgs) {
    if (m.role !== 'tool') continue;
    const mm = toolText(m).match(/agent_id: (\S+)/);
    if (mm) return mm[1];
  }
  return 'agent-0';
};
E.Q7 = {
  steps: [
    'HISTORY_MARKER_ALPHA 先聊一輪',
    { text: 'LAUNCH:Q7 請在背景 fork 一個 A', noIdle: true, wait: 2500 },
    { text: 'LATER_MARKER_1 主代理在 A 起跑後講的第一輪', noIdle: true, wait: 2500 },
    { text: 'LATER_MARKER_2 主代理在 A 起跑後講的第二輪', noIdle: true, wait: 24000 }, // 等 A 做完
    { text: 'LAUNCH:Q7R 請用 Agent resume 續跑 A', wait: 1500 },
    { text: 'LATER_MARKER_3 resume 之後再講一輪', wait: 1500 },
    { text: 'LAUNCH:Q7S 請用 AgentSwarm resume_agent_ids 續跑 A', wait: 1500 },
  ],
  scenario: (c) => {
    const u = c.lastUser;
    if (u.startsWith('LAUNCH:Q7R')) return c.last.role === 'tool' ? { text: `主收到 resume 結果：${c.lastToolText.slice(0, 400)}`, tag: 'main-final-R' } : { calls: [AGENT('續跑 A', 'Q7R_CONTINUE 請繼續', { resume: agentIdIn(c) })], tag: 'main-resume-call' };
    if (u.startsWith('LAUNCH:Q7S')) return c.last.role === 'tool' ? { text: `主收到 swarm resume 結果：${c.lastToolText.slice(0, 400)}`, tag: 'main-final-S' } : { calls: [{ name: 'AgentSwarm', args: { description: '用 swarm 續跑 A', resume_agent_ids: { [agentIdIn(c)]: 'Q7S_CONTINUE 請繼續' } } }], tag: 'main-swarm-resume-call' };
    if (u.startsWith('LAUNCH:Q7')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 400)}`, tag: 'main-final' } : { calls: [AGENT('Q7 背景 A', 'Q7A_TASK 你是 A', { fork: true, run_in_background: true })], tag: 'main-launch' };
    if (u.startsWith('Q7A_TASK')) {
      if (c.last.role === 'user') return { calls: [BASH('echo Q7A_STEP1_OUTPUT')], tag: 'A-first', delay: 20000 };
      return { text: 'A 完成 Q7A_FINAL', tag: 'A-second' };
    }
    if (u.startsWith('Q7R_CONTINUE')) return { text: 'A 續跑完成 Q7R_FINAL', tag: 'A-resumed-R' };
    if (u.startsWith('Q7S_CONTINUE')) return { text: 'A 續跑完成 Q7S_FINAL', tag: 'A-resumed-S' };
    return { text: `ack ${u.slice(0, 40)}`, tag: 'main-chat' };
  },
  maxWaitMs: 90000,
};


// --- B2N：兩層的實際做法——主 AgentSwarm fork 兩個「組長」，每個組長同一回合連發 N 個 Agent（孫代理 hold LAB_HOLD 毫秒）
E.B2N = {
  steps: ['HISTORY_MARKER_ALPHA 先聊一輪', 'LAUNCH:B2N 兩組長'],
  scenario: (c) => {
    const u = c.lastUser;
    const N = Number(process.env.LAB_N || 20);
    const kidFork = process.env.LAB_FORKKIDS === '1';
    if (u.startsWith('LAUNCH:B2N')) return c.last.role === 'tool' ? { text: `主收到：${c.lastToolText.slice(0, 400)}`, tag: 'main-final' } : { calls: [SWARM('兩組長', 'LEADER {{item}}', ['L1', 'L2'], { fork: true })], tag: 'main-launch' };
    if (u.startsWith('LEADER')) {
      if (c.last.role === 'tool') {
        const tools = c.msgs.filter((m) => m.role === 'tool').map((m) => toolText(m));
        const done = tools.filter((t) => /status: completed/.test(t)).length;
        const fail = tools.filter((t) => /ERROR|error/.test(t)).length;
        return { text: `${u} 收到 ${done} 個完成、${fail} 個錯誤`, tag: 'leader-final' };
      }
      return { calls: Array.from({ length: N }, (_, i) => AGENT(`${u.slice(7, 9)} 孫${i + 1}`, `WORKER ${u.slice(7, 9)}-${i + 1}`, kidFork ? { fork: true } : {})), tag: 'leader-calls' };
    }
    if (u.startsWith('WORKER')) return { text: `${u} 完成`, delay: Number(process.env.LAB_HOLD || 15000), tag: 'conc' };
    return { text: 'ack', tag: 'main-chat' };
  },
};

export { E as scenarios };
