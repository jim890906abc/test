// OpenAI-compatible Chat Completions adapter. Works with OpenAI, Gemini,
// DeepSeek, Qwen, Mistral, Groq, xAI, OpenRouter, Ollama, LM Studio, vLLM…
// The hub runs the agent loop: stream a completion, execute any tool calls in
// the workspace, feed results back, repeat until the model answers in text.

const MAX_STEPS = 60;

export function apiKeyFor(agent) {
  return agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : '') || '';
}

function isLocal(agent) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(agent.baseUrl || '');
}

export function available(agent) {
  if (!agent.baseUrl) return { ok: false, reason: '尚未設定 Base URL' };
  if (!agent.model) return { ok: false, reason: '尚未設定模型名稱' };
  if (!apiKeyFor(agent) && !isLocal(agent)) {
    return { ok: false, reason: agent.apiKeyEnv ? `需要 API key（設定 ${agent.apiKeyEnv} 環境變數或在設定中填入）` : '需要 API key' };
  }
  return { ok: true };
}

function systemPrompt(ctx) {
  return [
    `You are ${ctx.agent.name}, an autonomous coding agent driven from "Agent Hub", a multi-agent control center.`,
    `You work inside the workspace directory ${ctx.cwd}. All file paths are relative to it.`,
    'Use the provided tools to inspect files, edit code and run commands rather than guessing. Read files before editing them.',
    'Prefer small, verifiable steps: after changing code, run the relevant build or tests when they exist.',
    'Some tool calls require the user\'s approval; if one is denied, do not retry it blindly — explain and ask.',
    'When you are done, reply with a concise summary of what you did and anything the user should check. Use Markdown.',
    ctx.agent.systemPrompt || '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function* sseLines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

async function streamCompletion(ctx, messages, tools) {
  const { agent, signal } = ctx;
  const headers = { 'content-type': 'application/json' };
  const key = apiKeyFor(agent);
  if (key) headers.authorization = `Bearer ${key}`;
  if (/openrouter\.ai/.test(agent.baseUrl)) {
    headers['HTTP-Referer'] = 'https://github.com/agent-hub';
    headers['X-Title'] = 'Agent Hub';
  }
  const body = {
    model: agent.model,
    messages,
    stream: true,
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
  if (/api\.openai\.com/.test(agent.baseUrl)) body.stream_options = { include_usage: true };
  if (agent.temperature !== undefined && agent.temperature !== '') body.temperature = Number(agent.temperature);

  const url = `${agent.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
    } catch {}
    throw new Error(`${agent.name} API 錯誤 ${res.status}: ${String(detail).slice(0, 600)}`);
  }

  let textEv = null;
  let thinkEv = null;
  let content = '';
  let finishReason = null;
  const calls = []; // index -> { id, name, arguments }

  for await (const line of sseLines(res, signal)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.usage) {
      ctx.addUsage({ inputTokens: chunk.usage.prompt_tokens || 0, outputTokens: chunk.usage.completion_tokens || 0 });
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      thinkEv ??= ctx.emit({ type: 'thinking', text: '' });
      ctx.delta(thinkEv, reasoning);
    }
    if (typeof d.content === 'string' && d.content) {
      textEv ??= ctx.emit({ type: 'text', text: '' });
      content += d.content;
      ctx.delta(textEv, d.content);
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: '', name: '', arguments: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, calls: calls.filter(Boolean), finishReason };
}

export async function run(ctx, userText) {
  const history = (ctx.state.messages ??= []);
  history.push({ role: 'user', content: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.signal.aborted) return;
    const tools = ctx.toolDefs();
    const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...history];
    const { content, calls, finishReason } = await streamCompletion(ctx, messages, tools);

    calls.forEach((c, i) => {
      if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`;
    });
    const assistant = { role: 'assistant', content: content || null };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    }
    history.push(assistant);

    if (!calls.length) {
      if (finishReason === 'length') ctx.emit({ type: 'info', text: '回覆因長度上限被截斷' });
      return;
    }

    // Every tool call must get a tool message back, even when interrupted,
    // so the stored history stays valid for the next turn.
    for (const call of calls) {
      let input;
      let result;
      try {
        input = JSON.parse(call.arguments || '{}');
      } catch {
        input = null;
      }
      if (ctx.signal.aborted) {
        result = { output: 'Interrupted by user.', isError: true };
      } else if (input === null) {
        const ev = ctx.emit({ type: 'tool_use', name: call.name, input: call.arguments, title: call.name, status: 'error' });
        result = { output: `Arguments were not valid JSON: ${call.arguments.slice(0, 300)}`, isError: true };
        ctx.patch(ev, { output: result.output, isError: true });
      } else {
        result = await ctx.runTool(call.name, input);
      }
      history.push({ role: 'tool', tool_call_id: call.id, content: result.output });
    }
  }
  ctx.emit({ type: 'info', text: `已達到單次回合 ${MAX_STEPS} 步上限，停止執行` });
}

export async function test(agent) {
  const headers = { 'content-type': 'application/json' };
  const key = apiKeyFor(agent);
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${agent.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: agent.model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  return `連線成功：${(j.choices?.[0]?.message?.content || '').trim().slice(0, 80) || '(空回覆)'}`;
}
