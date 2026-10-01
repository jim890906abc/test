// Workspace tools the hub lends to API-based agents (the "openai" adapter) and
// the demo agent. File tools are confined to the session's workspace; `bash`
// runs with the workspace as cwd and is gated by the permission system.
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 30_000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);

export const TOOL_DEFS = [
  {
    name: 'bash',
    kind: 'exec',
    description:
      'Run a shell command (bash -c) with the workspace as the working directory. Returns combined stdout/stderr and the exit code. Use for builds, tests, git, package managers, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    kind: 'read',
    description: 'Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'integer', description: '1-based line to start from.' },
        limit: { type: 'integer', description: 'Maximum number of lines (default 2000).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    kind: 'edit',
    description: 'Create or overwrite a file in the workspace with the given content. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    kind: 'edit',
    description:
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    kind: 'read',
    description: 'List files and directories in the workspace (skips .git, node_modules and similar).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root (default ".").' },
        depth: { type: 'integer', description: 'How many levels deep to list (default 2).' },
      },
      required: [],
    },
  },
  {
    name: 'search',
    kind: 'read',
    description: 'Search file contents with a regular expression (ripgrep syntax). Returns matching lines as path:line:text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory or file to search (default ".").' },
        glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts".' },
      },
      required: ['pattern'],
    },
  },
];

export function toolKind(name) {
  if (name === 'delegate_to_agent') return 'delegate';
  return TOOL_DEFS.find((t) => t.name === name)?.kind ?? 'exec';
}

// Minimal JSON-schema check for model-produced tool input: required keys and
// primitive types. Models occasionally emit malformed arguments; those are
// reported back as a tool error instead of being executed.
export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be a JSON object';
  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) return `missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    const t = prop.type;
    if (t === 'string' && typeof value !== 'string') return `"${key}" must be a string`;
    if (t === 'boolean' && typeof value !== 'boolean') return `"${key}" must be a boolean`;
    if ((t === 'integer' || t === 'number') && typeof value !== 'number') return `"${key}" must be a number`;
  }
  return null;
}

export function resolveInWorkspace(cwd, p = '.') {
  const root = fssync.realpathSync(cwd);
  const target = path.resolve(root, p);
  // Lexical check first, then canonicalise the deepest existing ancestor so a
  // symlink inside the workspace cannot point the write outside of it.
  let probe = target;
  while (!fssync.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fssync.realpathSync(probe), path.relative(probe, target));
  for (const candidate of [target, real]) {
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`path "${p}" is outside the workspace`);
    }
  }
  return target;
}

function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, max * 0.6);
  const tail = text.slice(-max * 0.4);
  return `${head}\n\n… [${text.length - head.length - tail.length} characters truncated] …\n\n${tail}`;
}

export function runCommand(command, { cwd, signal, timeoutMs = 120_000, onData } = {}) {
  timeoutMs = Math.min(Math.max(timeoutMs || 120_000, 1000), 600_000);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      detached: true,
      env: { ...process.env, TERM: 'dumb', CI: process.env.CI ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let killedBy = null;
    const kill = (why) => {
      killedBy = why;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunk) => {
      const s = chunk.toString();
      if (out.length < MAX_OUTPUT * 4) out += s;
      onData?.(s);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output: String(err.message), exitCode: -1, isError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let output = truncate(out.trimEnd());
      if (killedBy === 'timeout') output += `\n[command timed out after ${timeoutMs} ms]`;
      if (killedBy === 'interrupted') output += '\n[interrupted by user]';
      resolve({ output: output || '(no output)', exitCode: code ?? -1, isError: code !== 0 });
    });
  });
}

async function listTree(root, rel, depth, lines, limit = 400) {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot list "${rel}": ${err.code || err.message}`);
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (lines.length >= limit) return;
    const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    const indent = '  '.repeat(childRel.split('/').length - 1);
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      if (depth > 1 && !IGNORED_DIRS.has(entry.name)) await listTree(root, childRel, depth - 1, lines, limit);
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
}

// Executes one tool call. Always resolves to { output, isError } so the
// caller can hand the result straight back to the model.
export async function executeTool(name, input, { cwd, signal, onData } = {}) {
  try {
    switch (name) {
      case 'bash': {
        const r = await runCommand(input.command, { cwd, signal, timeoutMs: input.timeout_ms, onData });
        return { output: `${r.output}\n[exit code ${r.exitCode}]`, isError: r.isError };
      }
      case 'read_file': {
        const file = resolveInWorkspace(cwd, input.path);
        const text = await fs.readFile(file, 'utf8');
        const all = text.split('\n');
        const start = Math.max((input.offset ?? 1) - 1, 0);
        const slice = all.slice(start, start + (input.limit ?? 2000));
        const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`).join('\n');
        const more = start + slice.length < all.length ? `\n… (${all.length - start - slice.length} more lines)` : '';
        return { output: truncate(numbered + more) || '(empty file)', isError: false };
      }
      case 'write_file': {
        const file = resolveInWorkspace(cwd, input.path);
        const existed = fssync.existsSync(file);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, input.content);
        const lines = input.content.split('\n').length;
        return { output: `${existed ? 'Updated' : 'Created'} ${input.path} (${lines} lines)`, isError: false };
      }
      case 'edit_file': {
        const file = resolveInWorkspace(cwd, input.path);
        const text = await fs.readFile(file, 'utf8');
        const count = text.split(input.old_string).length - 1;
        if (count === 0) return { output: 'old_string not found in file', isError: true };
        if (count > 1 && !input.replace_all) {
          return { output: `old_string appears ${count} times; add context to make it unique or set replace_all`, isError: true };
        }
        const next = input.replace_all
          ? text.split(input.old_string).join(input.new_string)
          : text.replace(input.old_string, () => input.new_string);
        await fs.writeFile(file, next);
        return { output: `Edited ${input.path} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? 's' : ''})`, isError: false };
      }
      case 'list_files': {
        const dir = resolveInWorkspace(cwd, input.path ?? '.');
        const lines = [];
        await listTree(dir, '.', Math.min(input.depth ?? 2, 6), lines);
        return { output: lines.join('\n') || '(empty directory)', isError: false };
      }
      case 'search': {
        const target = resolveInWorkspace(cwd, input.path ?? '.');
        const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const glob = input.glob ? ` --glob ${q(input.glob)}` : '';
        const cmd = `if command -v rg >/dev/null; then rg -n --no-heading --color never -M 300 --glob '!.git'${glob} -e ${q(input.pattern)} ${q(target)}; else grep -rnE --exclude-dir=.git --exclude-dir=node_modules ${q(input.pattern)} ${q(target)}; fi | head -200`;
        const r = await runCommand(cmd, { cwd, signal, timeoutMs: 30_000 });
        const root = fssync.realpathSync(cwd) + path.sep;
        const output = r.output.split(root).join('');
        return { output: output === '(no output)' ? 'No matches.' : output, isError: false };
      }
      default:
        return { output: `Unknown tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { output: err.message, isError: true };
  }
}
