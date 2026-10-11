// The tools Claude gets in a Claude API conversation, run by the hub in the
// conversation's folder on this computer. Named and shaped like Claude
// Code's (Bash, Read, Edit…), so the conversation view draws them the same
// way. File tools stay inside the folder; Bash runs there and is gated by
// the permission mode. TodoWrite, AskUserQuestion, ExitPlanMode and Task are
// handled by the conversation itself (adapters/claude.js).
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runCommand, resolveInWorkspace } from '../tools.js';

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

const target = (cwd, p) => resolveInWorkspace(cwd, typeof p === 'string' && p ? p : '.');
const relTo = (cwd, abs) => path.relative(fssync.realpathSync(cwd), abs) || '.';

// Runs one tool. Resolves to { content, output, isError }: `content` goes
// back to Claude (text, or blocks for an image), `output` is shown on the
// card.
export async function execute(name, input, { cwd, signal, onData } = {}) {
  try {
    switch (name) {
      case 'Bash': {
        const r = await runCommand(input.command, { cwd, signal, timeoutMs: input.timeout, onData });
        const text = `${r.output}\n[exit code ${r.exitCode}]`;
        return { content: text, output: r.output, isError: r.isError };
      }
      case 'Read':
        return await read(cwd, input);
      case 'Write': {
        const file = target(cwd, input.file_path);
        const existed = fssync.existsSync(file);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, input.content);
        const lines = input.content.split('\n').length;
        const text = `${existed ? 'Updated' : 'Created'} ${relTo(cwd, file)} (${lines} lines)`;
        return { content: text, output: text, isError: false };
      }
      case 'Edit': {
        const file = target(cwd, input.file_path);
        if (!fssync.existsSync(file)) return fail(`File does not exist: ${input.file_path}. Use Write to create it.`);
        if (input.old_string === input.new_string) return fail('old_string and new_string are the same; nothing to change.');
        const text = await fs.readFile(file, 'utf8');
        const count = input.old_string ? text.split(input.old_string).length - 1 : 0;
        if (!count) return fail('old_string was not found in the file. Read the file again and copy the exact text, whitespace included.');
        if (count > 1 && !input.replace_all) return fail(`old_string occurs ${count} times. Include more surrounding lines to make it unique, or set replace_all.`);
        const next = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
        await fs.writeFile(file, next);
        const msg = `Edited ${relTo(cwd, file)} (${input.replace_all ? `${count} replacements` : '1 replacement'})`;
        return { content: msg, output: msg, isError: false };
      }
      case 'Glob':
        return await glob(cwd, input, signal);
      case 'Grep':
        return await grep(cwd, input, signal);
      default:
        return fail(`Unknown tool "${name}"`);
    }
  } catch (err) {
    return fail(err.message || String(err));
  }
}

const fail = (text) => ({ content: text, output: text, isError: true });

async function read(cwd, input) {
  const file = target(cwd, input.file_path);
  const st = await fs.stat(file);
  if (st.isDirectory()) return fail(`${input.file_path} is a directory. Use Glob or Bash (ls) to list it.`);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (type) {
    if (st.size > 3_750_000) return fail(`The image is too large to read (${Math.round(st.size / 1024)} KB, the limit is about 3.7 MB).`);
    const data = (await fs.readFile(file)).toString('base64');
    return { content: [{ type: 'image', source: { type: 'base64', media_type: type, data } }], output: `（圖片，${Math.round(st.size / 1024)} KB）`, isError: false };
  }
  if (st.size > 20 * 1024 * 1024) return fail(`The file is ${Math.round(st.size / 1048576)} MB. Read it in parts with Bash (head, sed -n) or search it with Grep.`);
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) return fail(`${input.file_path} is a binary file (${st.size} bytes).`);
  const all = buf.toString('utf8').split('\n');
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
        re += `(?:${p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|')})`;
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

async function glob(cwd, input, signal) {
  const root = target(cwd, input.path);
  const re = globToRegExp(input.pattern);
  const found = [];
  let seen = 0;
  const walk = async (dir, rel) => {
    if (signal?.aborted || seen > 50_000 || found.length >= 2000) return;
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
      } else if (re.test(r)) found.push(r);
    }
  };
  await walk(root, '');
  const withTime = await Promise.all(found.map(async (r) => ({ r, t: (await fs.stat(path.join(root, r)).catch(() => null))?.mtimeMs || 0 })));
  withTime.sort((a, b) => b.t - a.t);
  const base = relTo(cwd, root);
  const list = withTime.slice(0, 200).map(({ r }) => (base === '.' ? r : `${base}/${r}`));
  const more = withTime.length > 200 ? `\n… and ${withTime.length - 200} more (narrow the pattern)` : '';
  const text = list.length ? list.join('\n') + more : 'No files found.';
  return { content: text, output: list.length ? text : '', isError: false };
}

let hasRg = null;
function spawnCollect(cmd, args, { cwd, signal, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => out.length < 2_000_000 && (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, out, err });
    });
  });
}

async function grep(cwd, input, signal) {
  const root = target(cwd, input.path);
  const where = relTo(cwd, root);
  const mode = input.output_mode || 'files_with_matches';
  hasRg ??= spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  let args;
  let cmd;
  if (hasRg) {
    cmd = 'rg';
    args = ['--color', 'never', '--no-heading', '-M', '400', '--glob', '!.git', '--glob', '!node_modules'];
    if (mode === 'files_with_matches') args.push('-l');
    else if (mode === 'count') args.push('-c');
    else args.push('-n');
    if (mode === 'content' && input.context) args.push('-C', String(Math.min(input.context, 20)));
    if (input.case_insensitive) args.push('-i');
    if (input.glob) args.push('--glob', input.glob);
    args.push('-e', input.pattern, '--', where);
  } else {
    cmd = 'grep';
    args = ['-rE', '--exclude-dir=.git', '--exclude-dir=node_modules', '-I'];
    if (mode === 'files_with_matches') args.push('-l');
    else if (mode === 'count') args.push('-c');
    else args.push('-n');
    if (mode === 'content' && input.context) args.push('-C', String(Math.min(input.context, 20)));
    if (input.case_insensitive) args.push('-i');
    if (input.glob) args.push(`--include=${input.glob}`);
    args.push('-e', input.pattern, '--', where);
  }
  const r = await spawnCollect(cmd, args, { cwd, signal });
  if (r.code > 1 || r.code === -1) return fail(`Search failed: ${r.err.trim() || `exit ${r.code}`}`);
  let lines = r.out.split('\n').filter(Boolean);
  if (mode === 'count') lines = lines.filter((l) => !/:0$/.test(l));
  const strip = (l) => l.replace(/^\.\//, '');
  const shown = lines.slice(0, 250).map(strip);
  const more = lines.length > 250 ? `\n… ${lines.length - 250} more lines (narrow the search)` : '';
  const text = shown.length ? truncate(shown.join('\n') + more) : 'No matches.';
  return { content: text, output: shown.length ? text : '', isError: false };
}
