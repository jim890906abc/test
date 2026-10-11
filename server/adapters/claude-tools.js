// The tools Claude gets in a Claude API conversation, run in the
// conversation's folder — on the hub's computer (localHost) or on a
// connected one through its bridge (remoteHost). Named and shaped like
// Claude Code's (Bash, Read, Edit…), so the conversation view draws them the
// same way. File tools stay inside the folder; Bash runs there and is gated
// by the permission mode. TodoWrite, AskUserQuestion, ExitPlanMode and Task are
// handled by the conversation itself (adapters/claude.js).
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand, resolveInWorkspace } from '../tools.js';
import * as machines from '../machines.js';

const MAX_OUTPUT = 30_000;
const MAX_READ_LINES = 2000;
const MAX_LINE = 2000;
const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', 'dist', 'build', '.turbo']);
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const FILE_PATH = str('Path of the file: absolute (inside the working directory) or relative to it.');

// kind: read (never asks), edit (asks in 每次詢問), exec (asks unless 全部自動),
// and the ones the conversation handles itself.
export const TOOLS = [
  {
    name: 'Bash',
    kind: 'exec',
    description:
      'Run a shell command with bash in the working directory; returns its combined stdout/stderr and exit code. Use it for builds, tests, git, package managers and other terminal work. Each call starts a fresh shell in the working directory, so `cd` does not carry over: chain with && instead. Prefer Read, Grep and Glob for looking at files. Output beyond about 30,000 characters is cut in the middle. A command that never exits (a server, a watcher) blocks until the timeout: start those in the background (`nohup … > log 2>&1 &`).',
    input_schema: {
      type: 'object',
      properties: {
        command: str('The command to run.'),
        description: str('What the command does, in 5–10 words, shown to the user.'),
        timeout: int('Timeout in milliseconds (default 120000, at most 600000).'),
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    kind: 'read',
    description:
      'Read a file. Returns its lines numbered like `cat -n`, up to 2000 lines from `offset`; read large files in parts with offset and limit. Images (PNG, JPEG, GIF, WebP) come back as the image itself. Read a file before you edit it.',
    input_schema: {
      type: 'object',
      properties: { file_path: FILE_PATH, offset: int('Line number to start from (1-based).'), limit: int('How many lines to read (default 2000).') },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    kind: 'edit',
    description:
      "Create a file, or replace a file's entire content; parent folders are created. To change part of an existing file use Edit instead, and Read a file before overwriting it. HTML files you write are shown to the user live in a side panel, so a page is a good way to present a report, a chart or a prototype.",
    input_schema: { type: 'object', properties: { file_path: FILE_PATH, content: str('The complete content of the file.') }, required: ['file_path', 'content'] },
  },
  {
    name: 'Edit',
    kind: 'edit',
    description:
      'Replace exact text in a file. old_string must match the file exactly, whitespace and indentation included, and occur exactly once unless replace_all is true: include enough surrounding lines to make it unique. Read the file first. Use one Edit per place you change.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: FILE_PATH,
        old_string: str('The exact text to replace.'),
        new_string: str('The text to put in its place.'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    kind: 'read',
    description: 'Find files by path pattern, such as `**/*.ts` or `src/**/test_*.py`. Returns the matching paths, most recently modified first (at most 200). Skips .git, node_modules and similar folders.',
    input_schema: { type: 'object', properties: { pattern: str('Glob pattern, relative to `path`.'), path: str('Directory to search in (default: the working directory).') }, required: ['pattern'] },
  },
  {
    name: 'Grep',
    kind: 'read',
    description:
      "Search file contents with a regular expression (ripgrep syntax). output_mode 'files_with_matches' (default) lists the files that match, 'content' shows matching lines as path:line:text, 'count' counts matches per file. Narrow it with `glob` (e.g. '*.js') or `path`.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: str('Regular expression to search for.'),
        path: str('File or directory to search (default: the working directory).'),
        glob: str('Only search files matching this glob, e.g. "*.py".'),
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'What to return (default files_with_matches).' },
        case_insensitive: { type: 'boolean', description: 'Ignore case.' },
        context: int("Lines of context around each match ('content' mode)."),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'TodoWrite',
    kind: 'todo',
    description:
      'Create or update your todo list for the current task; the user sees it beside the conversation. Use it for work with three or more steps: list the steps, keep exactly one in_progress while you work on it, and mark each completed as soon as it is done. Send the whole list every time.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: str('The step, as an imperative ("Run the tests").'),
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: str('The step as it is being done ("Running the tests").'),
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'AskUserQuestion',
    kind: 'ask',
    description:
      'Ask the user one to four multiple-choice questions and wait for the answers. Use it when you need a decision you should not guess: a requirement, a preference, a trade-off between approaches. Give each question two to four options; the user can also type an answer of their own.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: str('The question, ending with a question mark.'),
              header: str('A very short label for it (at most 12 characters).'),
              options: {
                type: 'array',
                items: { type: 'object', properties: { label: str('The choice, 1–5 words.'), description: str('What choosing it means.') }, required: ['label'] },
              },
              multiSelect: { type: 'boolean', description: 'Allow picking more than one option.' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'ExitPlanMode',
    kind: 'plan',
    description:
      'Use only in plan mode, once your plan is ready: it shows the plan to the user for approval. Pass it as Markdown — what you will change, file by file, and how you will check the result. If the user approves, plan mode ends and you carry out the plan; otherwise revise it from their feedback and call this again.',
    input_schema: { type: 'object', properties: { plan: str('The plan, in Markdown.') }, required: ['plan'] },
  },
  {
    name: 'Task',
    kind: 'agent',
    description:
      "Launch a subagent that does a self-contained task on its own, in its own context, and reports back. Use it for broad searches or research that would otherwise fill this conversation with reading, and for independent parts of the work: call Task several times in one message to run them at the same time. A subagent has the file, Bash and web tools (not Task, AskUserQuestion or the plan tools), works in the same folder, and the user's permission mode applies to it. It sees nothing of this conversation, so give it a complete brief and say what to report.",
    input_schema: {
      type: 'object',
      properties: { description: str('The task in 3–5 words, shown to the user.'), prompt: str('The complete brief for the subagent.') },
      required: ['description', 'prompt'],
    },
  },
  // Conversations of their own, in Agent Hub (see claude.js).
  {
    name: 'StartConversation',
    kind: 'exec',
    description:
      "Start a new, separate Claude conversation in Agent Hub, on this computer: it works on its own, in its own context, and shows in the user's sidebar, where they can watch it and talk to it. Use it when the user asks for other conversations or agents — a second opinion, an adversarial reviewer or opponent, a long parallel job they want to follow. It runs on the same Claude API key, with the same permission mode as this conversation, in this working directory (folder 'same') or a new empty folder ('new'). It sees nothing of this conversation, so make `prompt` a complete brief. Returns its id: read its answers with ReadConversation and reply with MessageConversation. For a quick self-contained task only you need the result of, use Task instead. Never start Claude Code (the `claude` command) or another AI tool from Bash instead: the user cannot see those, and they are billed elsewhere.",
    input_schema: {
      type: 'object',
      properties: {
        title: str('A short name for it, shown in the sidebar (e.g. "對抗者 A").'),
        prompt: str('Its first message: the complete brief.'),
        model: str("Model id (e.g. claude-opus-5-5, claude-fable-5-1); default: this conversation's model."),
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: "Thinking effort; default: this conversation's." },
        folder: { type: 'string', enum: ['same', 'new'], description: "'same' (default): this working directory. 'new': a new empty folder." },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'MessageConversation',
    kind: 'exec',
    description: 'Send a message to a conversation you started with StartConversation, as the next thing it reads. If it is working, the message waits until its current turn ends.',
    input_schema: { type: 'object', properties: { id: str('The conversation id StartConversation returned.'), text: str('The message.') }, required: ['id', 'text'] },
  },
  {
    name: 'ReadConversation',
    kind: 'read',
    description:
      "Read a conversation you started with StartConversation: whether it is working, waiting for the user, idle or stopped on an error, what it cost, and its last replies. With wait: true, first wait until its current turn ends (at most 30 minutes, or until it waits for the user's approval).",
    input_schema: {
      type: 'object',
      properties: {
        id: str('The conversation id.'),
        wait: { type: 'boolean', description: 'Wait for its current turn to end first.' },
        replies: int('How many of its last replies to return (default 1, at most 10).'),
      },
      required: ['id'],
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export const toolKind = (name) => byName.get(name)?.kind || 'exec';
// For one request: the definitions as the API takes them. Inputs stream as
// they are written (a long file shows up while Claude writes it); they are
// checked here before anything runs.
export const apiTools = (names) => TOOLS.filter((t) => !names || names.includes(t.name)).map(({ name, description, input_schema }) => ({ name, description, input_schema, eager_input_streaming: true }));

// A tool input against its schema: required fields and the type of each.
export function validate(name, input) {
  const def = byName.get(name);
  if (!def) return `unknown tool "${name}"`;
  return check(def.input_schema, input, 'input');
}

function check(schema, value, where) {
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${where} must be an object`;
    for (const k of schema.required || []) if (value[k] === undefined || value[k] === null) return `${where}.${k} is missing`;
    for (const [k, v] of Object.entries(value)) {
      const p = schema.properties?.[k];
      if (!p || v === undefined || v === null) continue;
      const e = check(p, v, `${where}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return `${where} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const e = schema.items && check(schema.items, value[i], `${where}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'string') {
    if (typeof value !== 'string') return `${where} must be a string`;
    if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.join(', ')}`;
    return null;
  }
  if (t === 'integer' || t === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${where} must be a number`;
  if (t === 'boolean') return typeof value === 'boolean' ? null : `${where} must be true or false`;
  return null;
}

// The line shown on a tool's card.
export function titleOf(name, input = {}, cwd = '') {
  const rel = (p) => (cwd && typeof p === 'string' && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
  switch (name) {
    case 'Bash':
      return String(input.command || '').split('\n')[0];
    case 'Read':
    case 'Write':
    case 'Edit':
      return rel(input.file_path) || '';
    case 'Glob':
    case 'Grep':
      return `${input.pattern || ''}${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Task':
      return input.description || '';
    case 'StartConversation':
      return input.title || '';
    case 'MessageConversation':
      return (input.text || '').slice(0, 80);
    case 'ReadConversation':
      return input.wait ? '等它這一輪結束再讀' : '讀它的最新回覆';
    case 'AskUserQuestion':
      return input.questions?.[0]?.question || 'Claude 有問題要問你';
    case 'ExitPlanMode':
      return '計畫';
    case 'WebSearch':
      return input.query || '';
    case 'WebFetch':
      return input.url || '';
    default:
      return '';
  }
}

function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.4));
  return `${head}\n\n… [${text.length - head.length - tail.length} characters cut] …\n\n${tail}`;
}

// ----------------------------------------------------------------- hosts
// What the tools need from the computer they run on. Paths are resolved
// inside `cwd` there; { abs, rel } come back.

export const localHost = {
  name: 'local',
  at(cwd, p) {
    const abs = resolveInWorkspace(cwd, typeof p === 'string' && p ? p : '.');
    return { abs, rel: path.relative(fssync.realpathSync(cwd), abs).split(path.sep).join('/') || '.' };
  },
  async stat(cwd, p) {
    const at = this.at(cwd, p);
    const st = await fs.stat(at.abs).catch(() => null);
    return { ...at, exists: Boolean(st), dir: Boolean(st?.isDirectory()), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
  },
  async read(cwd, p) {
    const at = this.at(cwd, p);
    const st = await fs.stat(at.abs);
    if (st.isDirectory()) throw new Error(`${p} is a directory`);
    if (st.size > 20 * 1024 * 1024) throw new Error(`the file is ${Math.round(st.size / 1048576)} MB (at most 20 MB)`);
    return { ...at, size: st.size, buf: await fs.readFile(at.abs) };
  },
  async write(cwd, p, content) {
    const at = this.at(cwd, p);
    const existed = fssync.existsSync(at.abs);
    await fs.mkdir(path.dirname(at.abs), { recursive: true });
    await fs.writeFile(at.abs, content);
    return { ...at, existed };
  },
  async walk(cwd, p, limit = 2000) {
    const at = this.at(cwd, p);
    const files = [];
    let seen = 0;
    const walk = async (dir, rel) => {
      if (seen > 50_000 || files.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        seen++;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!IGNORED.has(e.name)) await walk(path.join(dir, e.name), r);
        } else if (files.length < limit) files.push([r, (await fs.stat(path.join(dir, e.name)).catch(() => null))?.mtimeMs || 0]);
      }
    };
    await walk(at.abs, '');
    return { rel: at.rel, files };
  },
  async run(cwd, command, { signal, timeoutMs, onData } = {}) {
    const r = await runCommand(command, { cwd, signal, timeoutMs, onData });
    return { output: r.output, exitCode: r.exitCode };
  },
};

// A connected computer: the same, asked of its bridge.
export function remoteHost(machineId) {
  const call = (op, args, timeoutMs) => machines.rpc(machineId, op, args, timeoutMs).catch((err) => Promise.reject(machines.tooOld(err, machines.getMachine(machineId))));
  return {
    name: machineId,
    stat: (cwd, p) => call('fs.stat', { cwd, path: p || '.' }),
    async read(cwd, p) {
      const r = await call('fs.read', { cwd, path: p }, 120_000);
      return { ...r, buf: Buffer.from(r.data, 'base64') };
    },
    write: (cwd, p, content) => call('fs.write', { cwd, path: p, content }, 120_000),
    walk: (cwd, p, limit = 2000) => call('fs.walk', { cwd, path: p || '.', limit }),
    async run(cwd, command, { signal, timeoutMs, onData } = {}) {
      const id = crypto.randomBytes(6).toString('hex');
      const ms = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000);
      const stop = () => machines.rpc(machineId, 'sh.kill', { id }).catch(() => {});
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const r = await machines.rpcStream(machineId, 'sh.run', { cwd, command, timeoutMs: ms, id }, onData, ms + 30_000).catch((err) => Promise.reject(machines.tooOld(err, machines.getMachine(machineId))));
        let output = truncate(String(r.output || '').trimEnd());
        if (r.killedBy === 'timeout') output += `\n[command timed out after ${ms} ms]`;
        if (r.killedBy === 'interrupted') output += '\n[interrupted by user]';
        return { output: output || '(no output)', exitCode: r.exitCode };
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
  };
}

// --------------------------------------------------------------- running

// Runs one tool on `host`. Resolves to { content, output, isError }:
// `content` goes back to Claude (text, or blocks for an image), `output` is
// shown on the card.
export async function execute(name, input, { host = localHost, cwd, signal, onData } = {}) {
  try {
    switch (name) {
      case 'Bash': {
        const r = await host.run(cwd, input.command, { signal, timeoutMs: input.timeout, onData });
        return { content: `${r.output}\n[exit code ${r.exitCode}]`, output: r.output, isError: r.exitCode !== 0 };
      }
      case 'Read':
        return await read(host, cwd, input);
      case 'Write': {
        const r = await host.write(cwd, input.file_path, input.content);
        const text = `${r.existed ? 'Updated' : 'Created'} ${r.rel} (${input.content.split('\n').length} lines)`;
        return { content: text, output: text, isError: false };
      }
      case 'Edit': {
        const st = await host.stat(cwd, input.file_path);
        if (!st.exists) return fail(`File does not exist: ${input.file_path}. Use Write to create it.`);
        if (input.old_string === input.new_string) return fail('old_string and new_string are the same; nothing to change.');
        const text = (await host.read(cwd, input.file_path)).buf.toString('utf8');
        const count = input.old_string ? text.split(input.old_string).length - 1 : 0;
        if (!count) return fail('old_string was not found in the file. Read the file again and copy the exact text, whitespace included.');
        if (count > 1 && !input.replace_all) return fail(`old_string occurs ${count} times. Include more surrounding lines to make it unique, or set replace_all.`);
        const next = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
        await host.write(cwd, input.file_path, next);
        const msg = `Edited ${st.rel} (${input.replace_all ? `${count} replacements` : '1 replacement'})`;
        return { content: msg, output: msg, isError: false };
      }
      case 'Glob':
        return await glob(host, cwd, input);
      case 'Grep':
        return await grep(host, cwd, input, signal);
      default:
        return fail(`Unknown tool "${name}"`);
    }
  } catch (err) {
    return fail(err.message || String(err));
  }
}

const fail = (text) => ({ content: text, output: text, isError: true });

async function read(host, cwd, input) {
  const type = IMAGE_TYPES[path.extname(String(input.file_path)).toLowerCase()];
  const f = await host.read(cwd, input.file_path);
  if (type) {
    if (f.size > 3_750_000) return fail(`The image is too large to read (${Math.round(f.size / 1024)} KB, the limit is about 3.7 MB).`);
    return { content: [{ type: 'image', source: { type: 'base64', media_type: type, data: f.buf.toString('base64') } }], output: `（圖片，${Math.round(f.size / 1024)} KB）`, isError: false };
  }
  if (f.buf.subarray(0, 8000).includes(0)) return fail(`${input.file_path} is a binary file (${f.size} bytes).`);
  const all = f.buf.toString('utf8').split('\n');
  if (all.length > 1 && all.at(-1) === '') all.pop();
  const start = Math.max((input.offset ?? 1) - 1, 0);
  const slice = all.slice(start, start + Math.max(1, input.limit ?? MAX_READ_LINES));
  let text = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line cut]` : l}`).join('\n');
  if (!all.length || (all.length === 1 && !all[0])) text = '(the file is empty)';
  const rest = all.length - start - slice.length;
  if (rest > 0) text += `\n… ${rest} more lines (read on with offset ${start + slice.length + 1})`;
  return { content: truncate(text, 100_000), output: text, isError: false };
}

// "src/**/*.ts" → a RegExp over paths relative to the search root.
export function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const p = pattern.replace(/^\.\//, '');
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slash = p[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${p.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += `[${p.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

async function glob(host, cwd, input) {
  const re = globToRegExp(input.pattern);
  const { rel, files } = await host.walk(cwd, input.path, 20_000);
  const hits = files.filter(([r]) => re.test(r)).sort((a, b) => b[1] - a[1]);
  const list = hits.slice(0, 200).map(([r]) => (rel === '.' ? r : `${rel}/${r}`));
  const more = hits.length > 200 ? `\n… and ${hits.length - 200} more (narrow the pattern)` : '';
  const text = list.length ? list.join('\n') + more : 'No files found.';
  return { content: text, output: list.length ? text : '', isError: false };
}

const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;

// ripgrep when the computer has it, grep otherwise.
async function grep(host, cwd, input, signal) {
  const where = (await host.stat(cwd, input.path)).rel;
  const mode = input.output_mode || 'files_with_matches';
  const ctx = mode === 'content' && input.context ? Math.min(input.context, 20) : 0;
  const rg = ['rg --color never --no-heading -M 400 --glob \'!.git\' --glob \'!node_modules\'', mode === 'files_with_matches' ? '-l' : mode === 'count' ? '-c' : '-n', ctx ? `-C ${ctx}` : '', input.case_insensitive ? '-i' : '', input.glob ? `--glob ${q(input.glob)}` : '', `-e ${q(input.pattern)} -- ${q(where)}`];
  const gr = ['grep -rEI --exclude-dir=.git --exclude-dir=node_modules', mode === 'files_with_matches' ? '-l' : mode === 'count' ? '-c' : '-n', ctx ? `-C ${ctx}` : '', input.case_insensitive ? '-i' : '', input.glob ? `--include=${q(input.glob)}` : '', `-e ${q(input.pattern)} -- ${q(where)}`];
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rg.filter(Boolean).join(' ')}; else ${gr.filter(Boolean).join(' ')}; fi`;
  const r = await host.run(cwd, cmd, { signal, timeoutMs: 30_000 });
  if (r.exitCode > 1 || r.exitCode === -1) return fail(`Search failed: ${r.output.trim() || `exit ${r.exitCode}`}`);
  let lines = r.output === '(no output)' ? [] : r.output.split('\n').filter(Boolean);
  if (mode === 'count') lines = lines.filter((l) => !/:0$/.test(l));
  const shown = lines.slice(0, 250).map((l) => l.replace(/^\.\//, ''));
  const more = lines.length > 250 ? `\n… ${lines.length - 250} more lines (narrow the search)` : '';
  const text = shown.length ? truncate(shown.join('\n') + more) : 'No matches.';
  return { content: text, output: shown.length ? text : '', isError: false };
}
