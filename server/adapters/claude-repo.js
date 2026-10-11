// A Claude conversation bound to a GitHub repository, like a Claude Code on
// the web session: the repository is cloned into the conversation's folder
// on one branch, and everything Claude makes is committed and pushed there.
// The binding is kept with the conversation (session.meta.repo) and is in
// the system prompt for good; Agent Hub checks at the end of every turn and
// has Claude commit and push what is left (or does it itself), and refuses
// commands that would push anywhere else or rewrite what was pushed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FULL = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Where repositories are cloned from (the tests use local ones).
const GITHUB = process.env.AGENT_HUB_GITHUB_TEST_URL || 'https://github.com';

// "owner/repo", from that or from a GitHub URL (https or ssh).
export function parseRepo(input) {
  const s = String(input || '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]/i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return FULL.test(s) && !s.split('/').some((p) => p === '.' || p === '..') ? s : null;
}

// A branch name git accepts (a strict subset of it, so it is also safe in a
// shell command).
export function validBranch(b) {
  b = String(b || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(b)) return null;
  if (/\.\.|\/\/|\/$|\.$|\.lock$|@\{|\/\./.test(b)) return null;
  return b;
}

export const newBranch = () => `claude/${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Cloned into a new folder under `workspaces`, on `branch`: the remote's
// branch if it has one, else a new one from the default branch. Resolves to
// the folder.
export async function clone(host, workspaces, { full, branch }) {
  fs.mkdirSync(workspaces, { recursive: true });
  const base = `${new Date().toISOString().slice(0, 10)}-${full.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'}`;
  let dir = path.join(workspaces, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(workspaces, `${base}-${i}`);
  const script = [
    'set -e',
    `git clone --origin origin -- ${q(`${GITHUB}/${full}.git`)} ${q(dir)}`,
    `cd ${q(dir)}`,
    `if git ls-remote --exit-code --heads origin ${q(branch)} >/dev/null 2>&1; then git checkout -q -B ${q(branch)} ${q(`origin/${branch}`)}; else git checkout -q -b ${q(branch)}; fi`,
    `git config ${q(`branch.${branch}.remote`)} origin`,
    `git config ${q(`branch.${branch}.merge`)} ${q(`refs/heads/${branch}`)}`,
  ].join('\n');
  const r = await host.run(workspaces, script, { timeoutMs: 600_000 });
  if (r.exitCode !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    const out = String(r.output || '');
    const tail = out.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    const why = /could not read Username|Authentication failed|Repository not found|not found|does not exist/i.test(out)
      ? `找不到 ${full}，或這台電腦沒有權限讀它。私人 repo 要先在「⋯」→「GitHub…」幫這台電腦登入。`
      : `沒辦法 clone ${full}。`;
    throw Object.assign(new Error(`${why}（${tail}）`), { status: 400 });
  }
  return dir;
}

// A folder that is already a clone of the repository: onto `branch` (an
// existing one, the remote's, or a new one from where it is now, keeping
// uncommitted work).
export async function useBranch(host, cwd, { branch }) {
  const script = [
    'set -e',
    'git fetch -q origin 2>/dev/null || true',
    `if [ "$(git symbolic-ref --short -q HEAD || true)" != ${q(branch)} ]; then`,
    `  if git show-ref -q --verify ${q(`refs/heads/${branch}`)}; then git checkout -q ${q(branch)};`,
    `  elif git show-ref -q --verify ${q(`refs/remotes/origin/${branch}`)}; then git checkout -q -b ${q(branch)} ${q(`origin/${branch}`)};`,
    `  else git checkout -q -b ${q(branch)}; fi`,
    'fi',
    `git config ${q(`branch.${branch}.remote`)} origin`,
    `git config ${q(`branch.${branch}.merge`)} ${q(`refs/heads/${branch}`)}`,
  ].join('\n');
  const r = await host.run(cwd, script, { timeoutMs: 120_000 });
  if (r.exitCode !== 0) throw Object.assign(new Error(`沒辦法切到分支 ${branch}：${String(r.output || '').trim().split('\n').slice(-3).join(' ').slice(0, 400)}`), { status: 409 });
}

export function promptSection({ full, branch }) {
  return [
    '# GitHub repository (bound to this conversation)',
    `This conversation is bound to the GitHub repository ${full}, cloned in the working directory, on the branch \`${branch}\` (remote \`origin\`). This does not change for the rest of the conversation: everything you make for the user goes into this repository, on this branch. Work with high discipline:`,
    `- Work only in this clone and only on \`${branch}\`. Do not switch to or create other branches, do not change the remote, and do not delete branches.`,
    `- Commit as you go, in small logical commits with clear messages that say what changed and why, and push them with \`git push -u origin ${branch}\`. A piece of work is not done until it is committed and pushed. Agent Hub checks at the end of every turn and reminds you of anything left uncommitted or unpushed; if you still leave it, Agent Hub commits and pushes it with a generic message, which is worse than yours.`,
    '- Before each commit, look at `git status` and `git diff --staged` and commit only what belongs to the task. Never commit secrets (keys, tokens, passwords, .env files), large generated files, dependencies or build output; add them to .gitignore instead.',
    "- Run the project's tests, linters or build before you push when it has them, and fix what fails.",
    '- Never force-push and never rewrite history that was pushed (no rebase, amend, reset or filter of pushed commits). Agent Hub refuses such commands.',
    `- If a push is rejected because the remote branch moved, run \`git pull --no-rebase origin ${branch}\`, resolve conflicts carefully (keep both sides' intent), run the checks again and push. If it fails for another reason, retry a couple of times, then tell the user exactly what failed.`,
    '- When you finish, tell the user which commits you pushed (short hash and message).',
  ].join('\n');
}

// What is left at the end of a turn: on another branch, uncommitted changes,
// commits not on the remote. null when all is pushed.
export async function check(host, cwd, { branch }) {
  const script = [
    'echo "branch=$(git symbolic-ref --short -q HEAD || echo detached-HEAD)"',
    'echo "dirty=$(git status --porcelain | wc -l | tr -d \' \')"',
    'echo "ahead=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)"',
  ].join('\n');
  const r = await host.run(cwd, script, { timeoutMs: 30_000 }).catch(() => null);
  const out = String(r?.output || '');
  const get = (k) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  if (!get('branch')) return null; // could not tell: say nothing
  const s = { branch: get('branch'), dirty: Number(get('dirty')) || 0, ahead: Number(get('ahead')) || 0 };
  if (s.branch === branch && !s.dirty && !s.ahead) return null;
  const zh = [];
  const en = [];
  if (s.branch !== branch) {
    zh.push(`停在分支 ${s.branch}，不是綁定的 ${branch}`);
    en.push(`you are on ${s.branch}, not on \`${branch}\`, the branch this conversation is bound to: bring the work over to \`${branch}\` (git checkout ${branch}, then merge or cherry-pick it)`);
  }
  if (s.dirty) {
    zh.push(`${s.dirty} 個檔案的變更還沒 commit`);
    en.push(`${s.dirty} changed or new file(s) are not committed`);
  }
  if (s.ahead) {
    zh.push(`${s.ahead} 個 commit 還沒 push`);
    en.push(`${s.ahead} commit(s) are not pushed`);
  }
  return {
    ...s,
    zh: zh.join('、'),
    en: `Agent Hub check at the end of your turn: ${en.join('; ')}. This conversation is bound to ${'`'}${branch}${'`'}: commit the work that belongs to the task with a clear message (leave out anything that must not be committed and add it to .gitignore), push it with \`git push -u origin ${branch}\`, then finish your answer.`,
  };
}

// The last resort, when Claude left work behind twice: committed as it is
// and pushed, on the bound branch only.
export async function autoSave(host, cwd, { branch }, left) {
  if (left.branch !== branch) return { ok: false, text: `沒辦法自動上傳：Claude 停在分支 ${left.branch}，不是綁定的 ${branch}。請叫 Claude 切回 ${branch} 並把工作帶過去。` };
  const script = [
    'set -e',
    'git add -A',
    "if ! git diff --cached --quiet; then if git config user.email >/dev/null; then git commit -q -m 'Agent Hub auto-save: work left uncommitted at the end of a turn'; else git -c user.name='Agent Hub' -c user.email='agent-hub@localhost' commit -q -m 'Agent Hub auto-save: work left uncommitted at the end of a turn'; fi; fi",
    `git push -q -u origin ${q(branch)} 2>&1`,
    'git log -1 --format=%h',
  ].join('\n');
  const r = await host.run(cwd, script, { timeoutMs: 180_000 });
  const out = String(r.output || '').trim();
  if (r.exitCode !== 0) return { ok: false, text: `自動 commit／push 失敗：${out.split('\n').slice(-3).join(' ').slice(0, 400)}` };
  return { ok: true, text: `Claude 留下了沒上傳的工作（${left.zh}），Agent Hub 已自動 commit 並 push 到 ${branch}（${out.split('\n').at(-1)}）。` };
}

// A Bash command that would push somewhere other than the bound branch,
// force-push, delete on the remote or change the remote: refused (why), or
// null. Commands are checked piece by piece (split at ;, &&, ||, | and new
// lines), as Claude writes them.
export function guard(command, { branch }) {
  for (const part of String(command || '').split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ''));
    // The command itself, after any VAR=value.
    let i = words.findIndex((w) => !/^\w+=/.test(w));
    if (words[i] !== 'git') continue;
    // git's own options before the subcommand (-C dir, -c k=v…).
    for (i++; i < words.length && words[i].startsWith('-'); i++) if (['-C', '-c', '--git-dir', '--work-tree'].includes(words[i])) i++;
    const sub = words[i];
    const args = words.slice(i + 1);
    if (sub === 'remote' && ['add', 'set-url', 'remove', 'rm', 'rename', 'set-head'].includes(args[0])) return `the remote of this repository is fixed (origin), so \`git remote ${args[0]}\` is not allowed`;
    if (sub !== 'push') continue;
    const opts = args.filter((a) => a.startsWith('-'));
    const bad = opts.find((o) => /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--all|--branches|--delete|-d|--prune)(=|$)/.test(o) || /^-[a-z]*f/.test(o));
    if (bad) return `\`git push ${bad}\` could overwrite or delete what is on the remote`;
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length && positional[0] !== 'origin') return 'pushing goes to origin only';
    for (const ref of positional.slice(1)) {
      if (ref.startsWith('+')) return `\`${ref}\` is a forced push`;
      const [src, dst] = ref.includes(':') ? ref.split(':') : [ref, ref];
      const to = (dst || '').replace(/^refs\/heads\//, '');
      const okSrc = ['HEAD', branch, `refs/heads/${branch}`].includes(src);
      if (!src || !okSrc || (to !== branch && !(to === 'HEAD' && !ref.includes(':')))) return `this conversation pushes to \`${branch}\` only (got \`${ref}\`)`;
    }
  }
  return null;
}
