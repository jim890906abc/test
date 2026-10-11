// GitHub for the agents on this computer. Claude and Kimi use GitHub from
// their shell, with git and the GitHub CLI (gh), so a computer is signed in
// once, here, and every conversation on it can clone, push and open pull
// requests. The sign-in stays in gh's own store on this computer (git gets it
// through `gh auth setup-git`); Agent Hub never keeps a GitHub token.
// The bridge (bridge/agent-hub-bridge.mjs) carries the same code for the
// computers connected to the hub.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';

const GH = process.env.AGENT_HUB_GH || 'gh';
const HOST = 'github.com';
// Asked for on top of gh's own (repo, read:org, gist): pushing changes to
// .github/workflows needs it.
const EXTRA_SCOPES = ['workflow'];
// gh never waits for an answer that will not come.
const ENV = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' };

function run(cmd, args, { input, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...ENV }, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, missing: err?.code === 'ENOENT', out: String(stdout).trim(), err: String(stderr).trim() }),
    );
    child.stdin?.on('error', () => {});
    if (input != null) child.stdin?.end(input);
  });
}

const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// How to install gh here, for the user to run.
function installHint() {
  if (process.platform === 'darwin') return 'brew install gh';
  if (process.platform === 'win32') return 'winget install --id GitHub.cli';
  let osr = '';
  try {
    osr = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
  } catch {}
  if (/fedora|rhel|centos|rocky|alma/.test(osr)) return 'sudo dnf install gh';
  if (/arch|manjaro/.test(osr)) return 'sudo pacman -S github-cli';
  if (/alpine/.test(osr)) return 'sudo apk add github-cli';
  // GitHub's own apt repository: not every Debian-based system carries gh
  // (Kali does not).
  const apt = [
    'mkdir -p -m 755 /etc/apt/keyrings',
    'wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg',
    'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
    'apt update',
    'apt install -y gh',
  ].join(' && ');
  return process.getuid?.() === 0 ? apt : `sudo sh -c '${apt}'`;
}

async function gitIdentity() {
  const [name, email] = await Promise.all([run('git', ['config', '--global', 'user.name']), run('git', ['config', '--global', 'user.email'])]);
  return { name: name.out || null, email: email.out || null };
}

// After signing in: git pushes over https with gh's sign-in, and commits get
// the account's name (and its private noreply address) unless git already has
// an identity.
async function finish() {
  const setup = await run(GH, ['auth', 'setup-git', '--hostname', HOST]);
  if (!setup.ok) throw new Error(`gh auth setup-git 失敗：${firstLine(setup.err)}`);
  const u = await run(GH, ['api', 'user', '--hostname', HOST]);
  if (!u.ok) return;
  const user = JSON.parse(u.out);
  const id = await gitIdentity();
  if (!id.name) await run('git', ['config', '--global', 'user.name', user.name || user.login]);
  if (!id.email) await run('git', ['config', '--global', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`]);
}

// A sign-in in the browser (gh's device flow): gh shows a code, the user
// enters it at github.com/login/device, gh finishes on its own.
let web = null; // { child, code, url, state: 'waiting' | 'failed', error }

export async function status() {
  const v = await run(GH, ['--version']);
  if (v.missing) return { gh: null, install: installHint() };
  const base = { gh: v.out.match(/\d+\.\d+\.\d+/)?.[0] || '?', git: await gitIdentity() };
  if (web?.state === 'waiting') return { ...base, login: null, pending: { code: web.code, url: web.url } };
  const failed = web?.state === 'failed' ? web.error : null;
  web = null;
  const token = await run(GH, ['auth', 'token', '--hostname', HOST]);
  if (!token.ok) return { ...base, login: null, problem: failed };
  const u = await run(GH, ['api', 'user', '--hostname', HOST]);
  if (!u.ok) return { ...base, login: null, problem: `有登入資料，但 GitHub 不接受（${firstLine(u.err) || '連不上 GitHub'}）。重新登入一次。` };
  const user = JSON.parse(u.out);
  return { ...base, login: user.login, account: user.name || null };
}

export async function loginToken(token) {
  token = String(token || '').trim();
  if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(token)) throw Object.assign(new Error('這不像 GitHub token（ghp_… 或 github_pat_…）'), { status: 400 });
  const r = await run(GH, ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--with-token'], { input: `${token}\n`, timeoutMs: 30_000 });
  if (r.missing) throw Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 });
  if (!r.ok) throw Object.assign(new Error(`GitHub 不接受這個 token：${firstLine(r.err)}`), { status: 400 });
  await finish();
  return status();
}

export async function loginWeb() {
  if (web?.state === 'waiting') return { code: web.code, url: web.url };
  const child = spawn(GH, ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--web', '--skip-ssh-key', ...EXTRA_SCOPES.flatMap((s) => ['--scopes', s])], {
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const job = { child, code: null, url: null, state: 'waiting', error: null };
  web = job;
  let out = '';
  const timer = setTimeout(() => child.kill(), 15 * 60_000);
  const shown = new Promise((resolve, reject) => {
    const read = (d) => {
      out += d;
      job.code ??= out.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] || null;
      job.url ??= out.match(/https:\/\/\S+\/login\/device\S*/)?.[0] || null;
      if (job.code) resolve({ code: job.code, url: job.url || `https://${HOST}/login/device` });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => reject(err.code === 'ENOENT' ? Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 }) : err));
    child.on('close', async (code) => {
      clearTimeout(timer);
      reject(new Error(firstLine(out) || 'gh 沒有給出登入碼'));
      if (web !== job) return;
      if (code === 0) {
        try {
          await finish();
          web = null;
        } catch (err) {
          Object.assign(job, { state: 'failed', error: err.message });
        }
      } else Object.assign(job, { state: 'failed', error: job.code ? '沒有完成登入（逾時或被拒絕），再試一次。' : firstLine(out) });
    });
  });
  try {
    return await Promise.race([shown, new Promise((_, reject) => setTimeout(() => reject(new Error('gh 沒有在時間內給出登入碼')), 30_000))]);
  } catch (err) {
    if (web === job) web = null;
    child.kill();
    throw err;
  }
}

export async function cancelWeb() {
  const job = web;
  web = null;
  job?.child.kill();
  return status();
}

// The repositories this account can push to, most recently pushed first
// (its own, its organizations', and those it collaborates on).
export async function repos() {
  const r = await run(GH, ['api', '--hostname', HOST, 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'], { timeoutMs: 30_000 });
  if (r.missing) throw Object.assign(new Error(`這台電腦還沒有安裝 GitHub CLI（gh）：${installHint()}`), { status: 409 });
  if (!r.ok) throw Object.assign(new Error(`讀不到 repo 清單：${firstLine(r.err) || '這台電腦還沒登入 GitHub'}`), { status: 409 });
  return JSON.parse(r.out)
    .filter((x) => x.permissions?.push !== false)
    .map((x) => ({ full: x.full_name, private: Boolean(x.private), description: x.description || '', defaultBranch: x.default_branch, pushedAt: x.pushed_at }));
}

export async function logout() {
  await cancelWeb();
  const s = await status();
  if (s.login) {
    let r = await run(GH, ['auth', 'logout', '--hostname', HOST, '--user', s.login]);
    // gh before 2.40 has one account per host and no --user.
    if (!r.ok && /unknown flag/.test(r.err)) r = await run(GH, ['auth', 'logout', '--hostname', HOST]);
    if (!r.ok) throw new Error(`登出失敗：${firstLine(r.err)}`);
  }
  return status();
}
