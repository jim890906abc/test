// Backups of a conversation's folder to the user's Google Drive, done by
// Agent Hub itself (not by Claude or Kimi, so they cost no tokens and always
// happen as asked): with rclone, on the conversation's computer, through its
// shell (this computer's, or a connected one's through its bridge).
// The computer signs in to Google once (rclone keeps the sign-in in its own
// config there; Agent Hub keeps nothing). A backup puts on the Drive:
//   Agent Hub 備份/<computer>/<folder>/最新/…          the folder as it is now
//   Agent Hub 備份/<computer>/<folder>/每日快照/<date>.tar.gz   one per day, the last 30
// Left out: what .gitignore ignores, .git, and what can be rebuilt
// (node_modules, virtualenvs, caches).
const REMOTE = 'agenthub-gdrive';
const RCLONE = process.env.AGENT_HUB_RCLONE || 'rclone';
const ROOT = 'Agent Hub 備份';
const KEEP_DAYS = 30;
const JUNK = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.next', '.turbo', '.gradle', '.terraform'];

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const lastLines = (s, n = 3) => String(s || '').trim().split('\n').slice(-n).join(' ').slice(0, 400);

// The install command for the computer's system (uname from its shell).
async function installHint(host) {
  const r = await host.run('/', 'uname -s; (. /etc/os-release 2>/dev/null; echo "$ID $ID_LIKE")', { timeoutMs: 10_000 }).catch(() => null);
  const out = String(r?.output || '').toLowerCase();
  if (out.includes('darwin')) return 'brew install rclone';
  if (/mingw|msys|cygwin|windows/.test(out)) return 'winget install Rclone.Rclone';
  if (/fedora|rhel|centos/.test(out)) return 'sudo dnf install rclone';
  if (/arch/.test(out)) return 'sudo pacman -S rclone';
  return 'sudo apt install rclone';
}

// Is rclone there, is this computer signed in, and how full is the Drive.
export async function status(host) {
  const v = await host.run('/', `${RCLONE} version 2>/dev/null | head -1; ${RCLONE} listremotes 2>/dev/null`, { timeoutMs: 15_000 });
  const out = String(v.output || '');
  const version = out.match(/rclone v?(\d+\.\d+\.\d+)/)?.[1];
  if (!version) return { rclone: null, install: await installHint(host) };
  const base = { rclone: version, pending: logins.get(host.name)?.state === 'waiting' ? { url: logins.get(host.name).url } : null };
  if (!out.split('\n').includes(`${REMOTE}:`)) {
    const failed = logins.get(host.name)?.state === 'failed' ? logins.get(host.name).error : null;
    if (!base.pending) logins.delete(host.name);
    return { ...base, signedIn: false, problem: failed };
  }
  const about = await host.run('/', `${RCLONE} about ${REMOTE}: --json`, { timeoutMs: 30_000 });
  if (about.exitCode !== 0) return { ...base, signedIn: false, problem: `有登入資料，但 Google 不接受（${lastLines(about.output, 1)}）。重新登入一次。` };
  let quota = null;
  try {
    const j = JSON.parse(String(about.output).slice(String(about.output).indexOf('{')));
    quota = { used: j.used ?? null, total: j.total ?? null };
  } catch {}
  return { ...base, signedIn: true, quota };
}

// Signing in: rclone's own Google sign-in, which ends on this computer
// (127.0.0.1): its link is opened in a browser of that computer. Or a
// token made with `rclone authorize "drive"` anywhere else, pasted here.
const logins = new Map(); // host name -> { state, url, error }

export async function loginWeb(host) {
  const cur = logins.get(host.name);
  if (cur?.state === 'waiting') return { url: cur.url };
  const job = { state: 'waiting', url: null, error: null };
  logins.set(host.name, job);
  let out = '';
  const shown = new Promise((resolve, reject) => {
    const done = host
      .run('/', `${RCLONE} authorize drive --auth-no-open-browser 2>&1`, {
        timeoutMs: 600_000,
        onData: (chunk) => {
          out += chunk;
          job.url ??= out.match(/https?:\/\/127\.0\.0\.1:\d+\/auth\?state=\S+/)?.[0] || null;
          if (job.url) resolve({ url: job.url });
        },
      })
      .then(async (r) => {
        out = String(r.output || out);
        const token = out.match(/--->\s*(\{[\s\S]*?\})\s*<---/)?.[1];
        if (r.exitCode !== 0 || !token) throw new Error(job.url ? '沒有完成登入（逾時或被拒絕），再試一次。' : lastLines(out) || 'rclone 沒有給出登入網址');
        await saveToken(host, token);
        logins.delete(host.name);
      })
      .catch((err) => {
        Object.assign(job, { state: 'failed', error: err.message });
        reject(err);
      });
    done.catch(() => {});
  });
  return Promise.race([shown, new Promise((_, reject) => setTimeout(() => reject(new Error('rclone 沒有在時間內給出登入網址')), 30_000))]);
}

async function saveToken(host, token) {
  try {
    JSON.parse(token);
  } catch {
    throw Object.assign(new Error('這不是 rclone 的 token（要貼上 rclone authorize 印出的那一段 {…}）'), { status: 400 });
  }
  const r = await host.run('/', `${RCLONE} config delete ${REMOTE} >/dev/null 2>&1; ${RCLONE} config create ${REMOTE} drive token=${q(token)} --non-interactive`, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw Object.assign(new Error(`rclone 設定失敗：${lastLines(r.output)}`), { status: 400 });
}

export async function loginToken(host, token) {
  await saveToken(host, String(token || '').trim());
  logins.delete(host.name);
  const s = await status(host);
  if (!s.signedIn) throw Object.assign(new Error(s.problem || 'Google 不接受這個 token'), { status: 400 });
  return s;
}

export async function cancel(host) {
  logins.delete(host.name);
  await host.run('/', `pkill -f ${q(`${RCLONE} authorize drive`)} 2>/dev/null; true`, { timeoutMs: 10_000 }).catch(() => {});
  return status(host);
}

export async function logout(host) {
  await host.run('/', `${RCLONE} config delete ${REMOTE}`, { timeoutMs: 15_000 });
  return status(host);
}

// Where a folder's backups go: by computer and folder name.
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\n\r]+/g, '-').trim() || '未命名';
export const destOf = (computer, cwd) => `${ROOT}/${safe(computer)}/${safe(String(cwd).replace(/\/+$/, '').split('/').pop())}`;

// One backup of `cwd`: the latest copy brought up to date, and today's
// snapshot (re)written. Resolves to { files, bytes, dest, snapshot }.
export async function backup(host, cwd, computer) {
  const dest = destOf(computer, cwd);
  const junk = JUNK.map((d) => d.replace(/\./g, '\\.')).join('|');
  const script = [
    // A failed rclone fails the backup, even with its output cut to its end.
    'set -eo pipefail',
    `R=${q(`${REMOTE}:${dest}`)}`,
    'LIST=$(mktemp); TAR=$(mktemp); trap \'rm -f "$LIST" "$LIST.all" "$TAR"\' EXIT',
    // What is there, without what .gitignore ignores (in a git repository)…
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -z --cached --others --exclude-standard | tr \'\\0\' \'\\n\' > "$LIST.all"; else find . -type f | sed \'s|^\\./||\' > "$LIST.all"; fi',
    // …nor what can be rebuilt; only files that exist (a deleted tracked one is gone).
    `grep -Ev '(^|/)(${junk})(/|$)' "$LIST.all" | while IFS= read -r f; do [ -f "$f" ] && printf '%s\\n' "$f"; done > "$LIST" || true`,
    'N=$(wc -l < "$LIST" | tr -d \' \')',
    'BYTES=$(tr \'\\n\' \'\\0\' < "$LIST" | xargs -0 -r du -cb 2>/dev/null | tail -1 | cut -f1) || BYTES=0',
    `${RCLONE} sync . "$R/最新" --files-from "$LIST" --delete-excluded 2>&1 | tail -5`,
    'tar -czf "$TAR" -T "$LIST"',
    'DAY=$(date +%F)',
    `${RCLONE} copyto "$TAR" "$R/每日快照/$DAY.tar.gz" 2>&1 | tail -5`,
    `{ ${RCLONE} lsf "$R/每日快照" 2>/dev/null || true; } | sort | awk -v k=${KEEP_DAYS} '{ a[NR] = $0 } END { for (i = 1; i <= NR - k; i++) print a[i] }' | while IFS= read -r f; do ${RCLONE} deletefile "$R/每日快照/$f"; done`,
    'echo "AGENT_HUB_BACKUP files=$N bytes=${BYTES:-0} day=$DAY"',
  ].join('\n');
  const r = await host.run(cwd, script, { timeoutMs: 600_000 });
  const out = String(r.output || '');
  const m = out.match(/AGENT_HUB_BACKUP files=(\d+) bytes=(\d+) day=(\S+)/);
  if (r.exitCode !== 0 || !m) {
    if (/didn't find section in config file|not found in config file|NOTICE: Config file .* not found/i.test(out)) throw Object.assign(new Error('這台電腦還沒登入 Google Drive：在左下角「⋯」→「Google Drive 備份…」登入'), { status: 409 });
    if (/command not found|rclone: not found/.test(out)) throw Object.assign(new Error(`這台電腦還沒有安裝 rclone：${await installHint(host)}`), { status: 409 });
    throw Object.assign(new Error(`備份失敗：${lastLines(out)}`), { status: 500 });
  }
  return { files: Number(m[1]), bytes: Number(m[2]), dest, snapshot: `${dest}/每日快照/${m[3]}.tar.gz`, at: Date.now() };
}
