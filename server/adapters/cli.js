// Generic CLI adapter for agents without ACP support. Each turn spawns the
// command in the workspace and streams its stdout into the conversation:
// JSON lines are mined for text, anything else is shown as terminal output.
import { spawn } from 'node:child_process';
import { splitArgs, commandExists } from './acp.js';

export function available(agent) {
  if (!agent.command) return { ok: false, reason: '尚未設定指令' };
  if (!commandExists(agent.command)) return { ok: false, reason: `找不到指令「${agent.command}」` };
  return { ok: true };
}

function buildArgs(agent, prompt, mode) {
  const extra = splitArgs(agent.args || '');
  if (agent.cliKind === 'aider') {
    const args = ['--message', prompt, '--no-pretty', '--no-fancy-input', '--no-check-update'];
    if (mode !== 'ask') args.push('--yes-always');
    if (agent.model) args.push('--model', agent.model);
    return { args: [...args, ...extra], stdin: null };
  }
  // plain: substitute {prompt}; without a placeholder the prompt goes to stdin.
  if (extra.some((a) => a.includes('{prompt}'))) {
    return { args: extra.map((a) => a.split('{prompt}').join(prompt)), stdin: null };
  }
  return { args: extra, stdin: prompt };
}

function textFromJson(obj) {
  if (typeof obj !== 'object' || obj === null) return null;
  const blocks = (c) =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : null;
  return blocks(obj.text) ?? blocks(obj.delta) ?? blocks(obj.content) ?? blocks(obj.message?.content) ?? blocks(obj.message) ?? null;
}

export async function run(ctx, text) {
  const { agent, session } = ctx;
  const history = ctx.previousTranscript();
  const prompt = history ? `<previous_conversation>\n${history}\n</previous_conversation>\n\n${text}` : text;
  const { args, stdin } = buildArgs(agent, prompt, session.permissionMode);

  const child = spawn(agent.command, args, {
    cwd: session.cwd,
    detached: true,
    env: { ...process.env, ...(agent.env || {}), NO_COLOR: '1', TERM: 'dumb' },
    stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (stdin != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  const onAbort = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  let outEv = null;
  let textEv = null;
  let stderr = '';
  const appendOut = (s) => {
    outEv ??= ctx.emit({ type: 'text', text: '', mono: true });
    ctx.delta(outEv, s);
  };
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const t = textFromJson(JSON.parse(trimmed));
          if (t) {
            textEv ??= ctx.emit({ type: 'text', text: '' });
            ctx.delta(textEv, t);
          }
          continue;
        } catch {}
      }
      appendOut(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    }
  });
  child.stderr.on('data', (c) => {
    stderr = (stderr + c.toString('utf8')).slice(-6000);
  });

  const code = await new Promise((resolve, reject) => {
    child.on('error', (err) =>
      reject(err.code === 'ENOENT' ? new Error(`找不到指令「${agent.command}」`) : err),
    );
    child.on('close', resolve);
  });
  ctx.signal.removeEventListener('abort', onAbort);
  if (buf.trim()) appendOut(buf);
  if (code !== 0 && !ctx.signal.aborted) {
    throw new Error(`${agent.name} 結束代碼 ${code}${stderr.trim() ? `\n${stderr.trim().split('\n').slice(-12).join('\n')}` : ''}`);
  }
}

export async function test(agent) {
  if (!commandExists(agent.command)) throw new Error(`找不到指令「${agent.command}」`);
  return `找到指令 ${agent.command}`;
}
