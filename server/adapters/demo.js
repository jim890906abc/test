// A scripted agent that needs no account. It streams thinking and text,
// publishes a plan and calls the real workspace tools (so permission prompts,
// file changes and command output are all genuine) — handy for trying the UI.

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

async function stream(ctx, type, text) {
  const ev = ctx.emit({ type, text: '' });
  const parts = text.match(/[\s\S]{1,3}/g) || [];
  for (const p of parts) {
    await sleep(12 + Math.random() * 18, ctx.signal);
    ctx.delta(ev, p);
  }
  return ev;
}

function pickTask(prompt) {
  const p = prompt.toLowerCase();
  if (/python|\.py\b|py\b/.test(p)) {
    return {
      file: 'hello.py',
      lang: 'python',
      code: `def main():\n    tasks = ["分析需求", "撰寫程式", "執行驗證"]\n    for i, t in enumerate(tasks, 1):\n        print(f"{i}. {t} ✓")\n    print("Hello from Agent Hub (Python)!")\n\n\nif __name__ == "__main__":\n    main()\n`,
      cmd: 'python3 hello.py',
    };
  }
  if (/node|javascript|\bjs\b|typescript/.test(p)) {
    return {
      file: 'hello.js',
      lang: 'javascript',
      code: `const tasks = ['分析需求', '撰寫程式', '執行驗證'];\ntasks.forEach((t, i) => console.log(\`\${i + 1}. \${t} ✓\`));\nconsole.log('Hello from Agent Hub (Node.js)!');\n`,
      cmd: 'node hello.js',
    };
  }
  return {
    file: 'notes/task.md',
    lang: 'markdown',
    code: `# 任務紀錄\n\n> ${prompt.replace(/\n/g, ' ').slice(0, 200)}\n\n- [x] 檢視工作區\n- [x] 建立此紀錄檔\n- [ ] 交給真正的 agent 繼續處理\n`,
    cmd: 'ls -la notes && wc -l notes/task.md',
  };
}

export function available() {
  return { ok: true };
}

export async function run(ctx, text) {
  const task = pickTask(text);
  ctx.setMeta({ agentInfo: { name: 'Demo Agent', version: '1.0' }, protocol: 'built-in' });
  await stream(ctx, 'thinking', `使用者的需求是：「${text.slice(0, 80)}」。先看看工作區有什麼，再建立 ${task.file}，最後執行驗證。`);
  await stream(ctx, 'text', '好的，我先看一下工作區的結構。');

  const plan = [
    { content: '檢視工作區', priority: 'high', status: 'in_progress' },
    { content: `建立 ${task.file}`, priority: 'high', status: 'pending' },
    { content: '執行並驗證結果', priority: 'medium', status: 'pending' },
  ];
  const planEv = ctx.emit({ type: 'plan', entries: plan });
  const setPlan = (i, status) => {
    plan[i] = { ...plan[i], status };
    ctx.patch(planEv, { entries: plan.map((e) => ({ ...e })) });
  };

  await sleep(300, ctx.signal);
  await ctx.runTool('list_files', { path: '.', depth: 2 });
  setPlan(0, 'completed');
  setPlan(1, 'in_progress');

  await stream(ctx, 'text', `\n接著建立 \`${task.file}\`。`);
  const w = await ctx.runTool('write_file', { path: task.file, content: task.code });
  if (w.isError) {
    await stream(ctx, 'text', '\n寫入檔案沒有被允許，我先停在這裡。你可以改變權限模式後再試一次。');
    return;
  }
  setPlan(1, 'completed');
  setPlan(2, 'in_progress');

  await sleep(200, ctx.signal);
  const r = await ctx.runTool('bash', { command: task.cmd });
  setPlan(2, r.isError ? 'pending' : 'completed');
  ctx.addUsage({ inputTokens: 1200 + text.length * 2, outputTokens: 420 });

  await stream(
    ctx,
    'text',
    `\n\n完成了 ✅\n\n| 步驟 | 結果 |\n| --- | --- |\n| 檢視工作區 | 已完成 |\n| 建立 \`${task.file}\` | 已完成 |\n| 執行 \`${task.cmd}\` | ${r.isError ? '失敗' : '成功'} |\n\n\`\`\`${task.lang}\n${task.code.trimEnd()}\n\`\`\`\n\n右側的 **變更** 面板可以看到這次的 diff。這只是 Demo agent —— 到設定裡啟用 Kimi Code 等真正的 agent 即可接手。`,
  );
}

export async function test() {
  return 'Demo agent 隨時可用';
}
