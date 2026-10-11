// A local fake of the Claude API (api.anthropic.com) for the tests: GET
// /v1/models and streamed POST /v1/messages, scripted by the prompt (WRITE,
// BASH, PLAN, ASK, TASK, SLOW…). Only `key` is let in, as x-api-key.
import http from 'node:http';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A streamed Messages API response made of `blocks`.
async function respond(res, { blocks, stop = 'end_turn', usage = {}, slow = 0, model = 'claude-opus-5-5' }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'request-id': 'req_fake',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-remaining': '49',
    'anthropic-ratelimit-requests-reset': '2026-10-11T00:00:00Z',
  });
  let closed = false;
  res.on('close', () => (closed = true));
  const send = (e) => !closed && res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input ?? 1000, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.write ?? 0, output_tokens: 1 } } });
  for (const [index, b] of blocks.entries()) {
    if (b.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/[\s\S]{1,4}/g)) {
        if (slow) await wait(slow);
        if (closed) return;
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      }
    } else if (b.type === 'thinking') {
      send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig_fake' } });
    } else if (b.type === 'tool_use') {
      send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (const part of json.match(/[\s\S]{1,12}/g)) send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    }
    send({ type: 'content_block_stop', index });
  }
  send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output ?? 100 } });
  send({ type: 'message_stop' });
  res.end();
}

const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

// What the fake model does, from the request.
export function script(body, res) {
  const msgs = body.messages;
  const users = msgs.filter((m) => m.role === 'user');
  const first = textOf(users[0]?.content);
  const last = users.at(-1);
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  const lastText = textOf(last.content);
  // What the user said, without Agent Hub's notes before it.
  const said = lastText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
  if (/Write a summary of our conversation/.test(lastText)) return respond(res, { blocks: [{ type: 'text', text: '摘要：建立了 hi.txt。' }] });
  if (body.system[0].text.includes('You are a subagent')) return respond(res, { blocks: [{ type: 'text', text: `子代理報告：${first}` }] });
  // Bound to a repository: Agent Hub's end-of-turn check, done as asked
  // (REPOGOOD) or ignored (anything else).
  if (/Agent Hub check at the end of your turn/.test(lastText)) {
    if (!/^REPOGOOD/.test(first)) return respond(res, { blocks: [{ type: 'text', text: '好的，等一下再處理。' }] });
    const branch = lastText.match(/bound to `([^`]+)`/)[1];
    return respond(res, { blocks: [tool(`toolu_g${msgs.length}`, 'Bash', { command: `git add -A && git -c user.name=Claude -c user.email=claude@example.com commit -q -m "Add work.txt" && git push -q -u origin ${branch}` })], stop: 'tool_use' });
  }
  if (results.length) {
    if (/TASK/.test(first) && results.length === 2) return respond(res, { blocks: [{ type: 'text', text: `兩個子代理都回來了：${results.map((r) => textOf(r.content)).join(' / ')}` }] });
    return respond(res, { blocks: [{ type: 'text', text: `完成：${textOf(results[0].content).slice(0, 60)}` }] });
  }
  if (/^WRITE/.test(lastText)) {
    return respond(res, {
      blocks: [{ type: 'thinking', thinking: '先建立檔案。' }, { type: 'text', text: '我來建立 hi.txt。' }, tool('toolu_w1', 'Write', { file_path: 'hi.txt', content: 'hello from claude\n' })],
      stop: 'tool_use',
      usage: { input: 2000, output: 300 },
    });
  }
  if (/^REPO(GOOD|LAZY)/.test(said)) return respond(res, { blocks: [tool('toolu_r1', 'Bash', { command: 'echo work > work.txt' })], stop: 'tool_use' });
  if (/^REPOFORCE/.test(said)) return respond(res, { blocks: [tool('toolu_r2', 'Bash', { command: 'git push -f origin main' })], stop: 'tool_use' });
  if (/^BASH/.test(lastText)) return respond(res, { blocks: [tool('toolu_b1', 'Bash', { command: 'echo bash-ran', description: 'Say hi' })], stop: 'tool_use' });
  if (/^PLAN/.test(lastText)) return respond(res, { blocks: [tool('toolu_p1', 'ExitPlanMode', { plan: '1. 改 a.txt\n2. 跑測試' })], stop: 'tool_use' });
  if (/^ASK/.test(lastText)) return respond(res, { blocks: [tool('toolu_q1', 'AskUserQuestion', { questions: [{ question: '要用哪個框架？', header: '框架', options: [{ label: 'React' }, { label: 'Vue' }] }] })], stop: 'tool_use' });
  if (/^TASK/.test(lastText)) {
    return respond(res, { blocks: [tool('toolu_t1', 'Task', { description: '找 A', prompt: 'find A' }), tool('toolu_t2', 'Task', { description: '找 B', prompt: 'find B' })], stop: 'tool_use' });
  }
  // Answered by another model than the one asked for (a downgrade).
  if (/^SWAP/.test(lastText)) return respond(res, { blocks: [tool('toolu_s1', 'Bash', { command: 'echo should-not-run > swapped.txt' })], stop: 'tool_use', model: 'claude-opus-4-8' });
  if (/^REFUSE/.test(lastText)) return respond(res, { blocks: [], stop: 'refusal' });
  if (/^SLOW/.test(lastText)) return respond(res, { blocks: [{ type: 'text', text: '這是一段會慢慢寫出來的回覆，'.repeat(20) }], slow: 60 });
  return respond(res, { blocks: [{ type: 'text', text: `收到：${lastText.slice(0, 40)}` }] });
}

const MODELS = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model', max_input_tokens: 1000000, max_tokens: 128000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model', max_input_tokens: 1000000, max_tokens: 128000 },
];

// Resolves to { url, requests, close() }.
export async function startFakeClaude(key) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.headers['x-api-key'] !== key) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1).id }));
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/messages')) return script(body, res);
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
