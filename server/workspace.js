// Workspace helpers: creating per-session folders, browsing files and
// computing the "Changes" view from git without touching the user's index.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKSPACES_DIR } from './store.js';
import { resolveInWorkspace } from './tools.js';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=Agent Hub', '-c', 'user.email=agent-hub@localhost', '-c', 'commit.gpgsign=false'];

async function git(cwd, args, opts = {}) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, ...opts });
    return stdout;
  } catch (err) {
    // `git diff --no-index` exits 1 when files differ; that is a success here.
    if (opts.allowExit1 && err.code === 1) return err.stdout;
    throw err;
  }
}

export function slugify(text, fallback = 'workspace') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || fallback;
}

export async function isGitRepo(dir) {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

// A fresh folder under WORKSPACES_DIR with an empty initial commit, so the
// Changes panel can diff everything the agent does against it.
export async function createWorkspace(hint) {
  const stamp = new Date().toISOString().slice(0, 10);
  let dir = path.join(WORKSPACES_DIR, `${stamp}-${slugify(hint)}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(WORKSPACES_DIR, `${stamp}-${slugify(hint)}-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git(dir, ['init', '-q']);
    await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'Agent Hub workspace']);
  } catch {
    // git is optional; the hub still works without the Changes view.
  }
  return dir;
}

// For "compare" runs on an existing repository each agent gets its own git
// worktree so they cannot trample each other's edits.
export async function createWorktree(repoDir, name) {
  const top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim();
  const branch = `agent-hub/${slugify(name, 'run')}-${Date.now().toString(36)}`;
  const dir = path.join(WORKSPACES_DIR, 'worktrees', branch.replace(/\//g, '-'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(top, ['worktree', 'add', '-q', '-b', branch, dir]);
  return { dir, branch };
}

export function validateDir(dir) {
  const abs = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`資料夾不存在：${abs}`);
  return abs;
}

export async function listDir(cwd, rel = '.') {
  const dir = resolveInWorkspace(cwd, rel);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== '.git')
    .map((e) => ({
      name: e.name,
      path: rel === '.' ? e.name : `${rel}/${e.name}`,
      dir: e.isDirectory(),
    }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function readFile(cwd, rel) {
  const file = resolveInWorkspace(cwd, rel);
  const stat = await fs.promises.stat(file);
  if (stat.size > 2 * 1024 * 1024) return { path: rel, size: stat.size, tooLarge: true };
  const buf = await fs.promises.readFile(file);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, size: stat.size, binary, content: binary ? '' : buf.toString('utf8') };
}

// Tracked changes vs HEAD plus untracked files rendered as additions.
export async function getChanges(cwd) {
  if (!(await isGitRepo(cwd))) return { git: false, files: [], diff: '' };
  let hasHead = true;
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }
  let diff = hasHead ? await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']) : '';
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .filter(Boolean)
    .slice(0, 100);
  for (const file of untracked) {
    try {
      const st = fs.statSync(path.join(cwd, file));
      if (st.size > 512 * 1024) {
        diff += `diff --git a/${file} b/${file}\nnew file (${st.size} bytes, not shown)\n`;
        continue;
      }
      diff += await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { allowExit1: true });
    } catch {}
  }
  return { git: true, files: summarizeDiff(diff), diff };
}

export function summarizeDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      cur = { path: m[2], added: 0, removed: 0, status: 'modified' };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    else if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
  }
  return files;
}
