// What a subagent card says about itself, kept free of the DOM so the same
// words come out wherever they are needed: the conversation's card and 子代理
// panel (transcript.js) and the cluster page's small squares (server side, from
// the worker's events). One definition, so the three cannot say different things.

// Tool name -> [icon, the verb it is shown with].
export const TOOLS = {
  Bash: ['terminal', '執行'],
  Shell: ['terminal', '執行'],
  Read: ['eye', '讀取'],
  ReadFile: ['eye', '讀取'],
  Write: ['filePlus', '寫入'],
  WriteFile: ['filePlus', '寫入'],
  Edit: ['pencil', '編輯'],
  MultiEdit: ['pencil', '編輯'],
  StrReplaceFile: ['pencil', '編輯'],
  Glob: ['files', '找檔案'],
  Grep: ['search', '搜尋'],
  FetchURL: ['globe', '讀取網頁'],
  WebFetch: ['globe', '讀取網頁'],
  WebSearch: ['globe', '搜尋網路'],
  SearchWeb: ['globe', '搜尋網路'],
  CodeExecution: ['terminal', '雲端執行程式'],
  Agent: ['agents', '子代理'],
  AgentSwarm: ['agents', '子代理群'],
  Task: ['agents', '子代理'],
  StartConversation: ['agents', '開新對話'],
  MessageConversation: ['agent', '傳訊息給對話'],
  ReadConversation: ['eye', '讀對話'],
  btw: ['question', '順便問'],
  TodoList: ['todo', '待辦'],
  TodoWrite: ['todo', '待辦'],
  SetTodoList: ['todo', '待辦'],
  AskUserQuestion: ['question', '提問'],
  EnterPlanMode: ['map', '進入計畫模式'],
  ExitPlanMode: ['map', '計畫'],
  Skill: ['bolt', '技能'],
  TaskList: ['clock', '背景工作'],
  TaskOutput: ['clock', '背景工作輸出'],
  TaskStop: ['clock', '停止背景工作'],
  WaitFor: ['clock', '等待背景工作'],
  CronCreate: ['clock', '建立排程'],
  CronList: ['clock', '排程'],
  CronDelete: ['clock', '刪除排程'],
  CreateGoal: ['sparkle', '設定目標'],
  GetGoal: ['sparkle', '目標'],
  UpdateGoal: ['sparkle', '更新目標'],
  SetGoalBudget: ['sparkle', '目標預算'],
  delegate_to_provider: ['agents', '子代理'],
  'mcp__agent-hub__delegate_to_provider': ['agents', '子代理'],
};

const INTERNAL_AGENT = /delegate_to_provider|mcp__agent-hub|agent-hub|(^|[\s·])broker([\s·]|$)/i;
// Internal tool/connection names must never become a user-facing card title.
// This one is deliberately broad: a display name such as "agent-hub-broker"
// or "broker_task" is internal even though it is not a whole word.
export const INTERNAL_TITLE = /delegate_to_provider|mcp__agent-hub|agent-hub|broker/i;
export function agentName(sub) {
  const name = String(sub?.name || '').trim();
  return name && !/^(subagent|btw)$/i.test(name) && !INTERNAL_TITLE.test(name) ? name : '';
}
export function agentDescription(ev, sub = {}) {
  const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
  let text = sub.description || input.description || ev.title || input.prompt || input.task || '';
  if (INTERNAL_AGENT.test(String(text))) text = input.task || input.prompt || sub.description || '';
  const out = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return INTERNAL_TITLE.test(out) ? '' : out;
}

export const toolVerb = (name) => (TOOLS[name] || [null, name])[1];

// "執行 wc -l …": what a subagent did last, from its newest event that shows
// something (a tool call, or a line of text it wrote). `last` is that event.
export function activityOf(last, max = 120) {
  if (!last) return '';
  const text = last.type === 'tool_use' ? `${toolVerb(last.name)} ${last.title || ''}`.trim() : String(last.text || '').trim().split('\n').pop();
  return text.slice(0, max);
}

// The newest event of a list (oldest first) that tells what the subagent did.
export const lastShown = (events) => [...events].reverse().find((k) => k.type === 'tool_use' || (k.type === 'text' && k.text?.trim()));

// A step: one tool call, of the main agent or of a subagent. The conversation's
// subagent cards say "N 個步驟" from exactly this (transcript.js stepCount), and a
// cluster's 步數 counts the same thing over all of its workers' conversations,
// so the two cannot mean different things.
export const isStep = (ev) => ev?.type === 'tool_use';
export function countSteps(events) {
  let n = 0;
  for (const ev of events || []) if (isStep(ev)) n++;
  return n;
}
