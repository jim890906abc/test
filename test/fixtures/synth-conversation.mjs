// Conversations made up, shaped like the ones a real long session holds, so the
// front end can be tested and timed on big ones without anyone's real data.
// The same seed gives the same conversation every time.
import { seedSession } from '../browser-harness.mjs';

// A small deterministic random source, so the same conversation comes back
// every run and numbers can be compared.
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'agent session render window scroll stream token message panel tool result output queue parse cache layout frame event socket state patch delta anchor thread worker bridge machine gateway signal budget'.split(' ');
const para = (r, n) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
const codeLines = (r, n) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4)}\t  const ${WORDS[Math.floor(r() * WORDS.length)]}${i} = await ${WORDS[Math.floor(r() * WORDS.length)]}(${i}); // ${para(r, 4)}`).join('\n');

const markdownReply = (r) =>
  [
    `**${para(r, 3)}**：${para(r, 18)}。`,
    '',
    `- ${para(r, 8)}`,
    `- ${para(r, 10)}，\`${WORDS[Math.floor(r() * WORDS.length)]}()\``,
    `- ${para(r, 7)}`,
    '',
    '```js',
    codeLines(r, 3 + Math.floor(r() * 6)).replace(/^\s*\d+\t/gm, ''),
    '```',
    '',
    r() < 0.3 ? `| 項目 | 結果 |\n| --- | --- |\n| ${para(r, 2)} | ${para(r, 2)} |\n| ${para(r, 2)} | ${para(r, 3)} |\n` : `${para(r, 25)}。`,
  ].join('\n');

// About `count` events shaped like the ones a real long conversation holds:
// questions, thinking, Read/Grep runs (folded into one row), Bash/Edit/Write
// calls with output (a few of them very large), replies in Markdown, and a
// subagent card now and then with its own steps inside.
export function synthEvents({ count = 2000, seed = 7, big = 0.03, bigBytes = 150_000 } = {}) {
  const r = rng(seed);
  const events = [];
  let ts = 1_790_000_000_000;
  let n = 0;
  const id = () => `e${++n}`;
  const push = (ev) => events.push({ id: id(), ts: (ts += 400 + Math.floor(r() * 3000)), ...ev });
  const tool = (name, input, output, extra = {}) =>
    push({ type: 'tool_use', agentId: 'main', toolCallId: `call_${n}`, name, title: input.command || input.path || input.pattern || name, status: 'done', input, display: { kind: name === 'Bash' ? 'command' : 'file_io', operation: name.toLowerCase(), path: input.path }, isError: false, output, ...extra });
  while (events.length < count) {
    push({ type: 'user', text: `${para(r, 12 + Math.floor(r() * 20))}？\n\n${para(r, 14)}。`, images: [] });
    const steps = 6 + Math.floor(r() * 10);
    for (let i = 0; i < steps && events.length < count; i++) {
      const k = r();
      const huge = r() < big;
      const outLen = huge ? bigBytes : 400 + Math.floor(r() * 4000);
      const out = () => codeLines(r, Math.ceil(outLen / 70)).slice(0, outLen);
      if (k < 0.22) push({ type: 'thinking', text: para(r, 60 + Math.floor(r() * 140)) });
      else if (k < 0.4) tool('Read', { path: `/work/src/${WORDS[Math.floor(r() * 30)]}.js`, line_offset: 1, n_lines: 80 }, out());
      else if (k < 0.5) tool('Grep', { path: '/work/src', pattern: WORDS[Math.floor(r() * 30)] }, out());
      else if (k < 0.62) tool('Bash', { command: `npm test -- ${WORDS[Math.floor(r() * 30)]}` }, out());
      else if (k < 0.7) tool('Edit', { path: `/work/src/${WORDS[Math.floor(r() * 30)]}.js`, old_string: codeLines(r, 4), new_string: codeLines(r, 6) }, 'Replaced 1 occurrence');
      else if (k < 0.74) tool('Write', { path: `/work/${WORDS[Math.floor(r() * 30)]}.md`, content: para(r, 300) }, 'Wrote 2100 bytes');
      else if (k < 0.8) {
        const aid = n + 1;
        push({ type: 'tool_use', agentId: 'main', toolCallId: `call_${aid}`, name: 'Agent', title: para(r, 6), status: 'done', input: { description: para(r, 4), prompt: para(r, 30) }, subagent: { id: `agent-${aid}`, name: 'coder', description: para(r, 5), status: 'done', summary: para(r, 20) }, isError: false, output: para(r, 30) });
        const parent = events[events.length - 1].id;
        for (let c = 0; c < 4; c++) tool('Read', { path: `/work/${WORDS[Math.floor(r() * 30)]}.txt` }, out(), { parent, agentId: `agent-${aid}` });
        push({ type: 'text', text: para(r, 20), parent, agentId: `agent-${aid}` });
      } else push({ type: 'text', agentId: 'main', text: markdownReply(r) });
    }
    push({ type: 'turn_end', durationMs: 20000, usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0 }, interrupted: false, error: false });
  }
  return events;
}

// A conversation the Hub can load, `count` events long. It is a Kimi one on a
// computer that is not connected: the page shows it, with its model menu, and
// nothing real is started by opening it.
export function synthSession({ id = 's_big', title = '大型對話', count = 2000, seed = 7, ...rest } = {}) {
  const models = [
    { id: 'kimi-code/k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'max', image: true, context: 1048576 },
    { id: 'kimi-code/k3-256k', name: 'K3-256k', efforts: ['low', 'high', 'max'], defaultEffort: 'max', image: true, context: 262144 },
    { id: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview', efforts: ['low', 'high', 'max'], defaultEffort: 'max', image: true, context: 1048576 },
  ];
  return seedSession({
    id,
    title,
    agentId: 'kimi@m_perf',
    machineId: 'm_perf',
    kimiSessionId: `session_${id}`,
    provider: 'kimi',
    cwd: '/tmp/x',
    meta: { machineName: 'perf', models, model: 'kimi-code/k3', effort: 'max', context: { used: 120000, size: 1048576 } },
    events: synthEvents({ count, seed, ...rest }),
  });
}

// About `chars` characters of Markdown (headings, lists, code, tables), for a
// reply that is streamed in.
export function synthMarkdown(chars = 8000, seed = 99) {
  const r = rng(seed);
  let out = '';
  let n = 0;
  while (out.length < chars) out += `${n++ % 4 === 0 ? `## ${para(r, 3)}\n\n` : ''}${markdownReply(r)}\n\n`;
  return out.slice(0, chars);
}
