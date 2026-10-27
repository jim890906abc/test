// One secret filter, tested with the credential shapes this system really
// holds or meets — not the two shapes the first implementation happened to
// match. Every case has a positive control (the secret body is gone and a mask
// is there), the negative controls prove ordinary text is not rewritten, and
// the boundary checks look at what leaves: the hand-off text, and the very
// request Claude's daemon sends to the (fake) Anthropic API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeClaude, wait } from './fixtures/fake-anthropic.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-redact-'));
process.env.AGENT_HUB_DATA = path.join(TMP, 'data');
process.env.AGENT_HUB_WORKSPACES = path.join(TMP, 'ws');

const redactMod = await import('../server/redact.js');
const handoffMod = await import('../server/handoff.js');
const store = await import('../server/store.js');
const { redact, redactSecrets, redactDeep, appendRedacted, registerSecretSource, isSecretKey } = redactMod;

// Each: [label, text around the secret (the secret is `S`), secret body].
const hex = (n, seed = 7) => Array.from({ length: n }, (_, i) => ((i * 37 + seed * 11 + (i >> 2)) % 16).toString(16)).join('');
const HUB_TOKEN = `hb_${hex(48)}`;
const BRIDGE_KEY = `bk_${hex(36, 3)}`;
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM_BODY = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u';
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\nH0Rz8eTqQ3wX9yq1vYJ2v8o6WkxjzF2d4gA7sEoUKDQ=\n-----END RSA PRIVATE KEY-----`;

const CASES = [
  ['Anthropic API key', 'the key is sk-ant-api03-Zk3Rq9mT7vXw2LbN8cPd5HfJ1sGyAeUo-4QwErTy_abc done', 'sk-ant-api03-Zk3Rq9mT7vXw2LbN8cPd5HfJ1sGyAeUo-4QwErTy_abc'],
  ['Anthropic OAuth token', 'ANTHROPIC_AUTH_TOKEN is sk-ant-oat01-Qw3Er5Ty7Ui9Op1As2Df4Gh6Jk8Lz0Xc', 'sk-ant-oat01-Qw3Er5Ty7Ui9Op1As2Df4Gh6Jk8Lz0Xc'],
  ['DeepSeek gateway key', 'paste: sk-9f8e7d6c5b4a39281716abcdef0123 ok', 'sk-9f8e7d6c5b4a39281716abcdef0123'],
  ['pool-style gateway key', 'using sk-pool-first-000000000001 now', 'sk-pool-first-000000000001'],
  ['.env line with an unprefixed key', 'cat .env\nOPENCODE_API_KEY=abcd1234efgh5678ijkl\nPORT=8787', 'abcd1234efgh5678ijkl'],
  ['quoted .env value', 'export ANTHROPIC_API_KEY="q1w2e3r4t5y6u7i8o9p0"', 'q1w2e3r4t5y6u7i8o9p0'],
  ['JSON apiKey', 'config {"gateway":"opencode-go","apiKey":"k9j8h7g6f5d4s3a2"}', 'k9j8h7g6f5d4s3a2'],
  ['JSON password', 'body {"user":"admin","password":"correct horse battery"}', 'correct horse battery'],
  ['JSON token (escaped inside a string)', 'out: "{\\"token\\":\\"opaque-session-value-12345\\"}"', 'opaque-session-value-12345'],
  ['Hub delegation token', `call delegate_to_provider with token "${HUB_TOKEN}"`, HUB_TOKEN],
  ['bridge key', `connect --key ${BRIDGE_KEY} now`, BRIDGE_KEY],
  ['Authorization Bearer header', 'curl -H "Authorization: Bearer 8f14e45fceea167a5a36dedd4bea2543" https://x.test', '8f14e45fceea167a5a36dedd4bea2543'],
  ['Bearer JWT', `token: Bearer ${JWT}`, JWT],
  ['GitHub token', 'git push https with ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['GitHub fine-grained token', 'GH=github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789_abcdefghij', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789_abcdefghij'],
  ['AWS access key id', 'aws key AKIAIOSFODNN7EXAMPLE in the config', 'AKIAIOSFODNN7EXAMPLE'],
  ['AWS secret access key line', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['Cookie header', 'GET / HTTP/1.1\nCookie: sessionid=a1b2c3d4e5f6; csrftoken=zz99yy88\nHost: x', 'a1b2c3d4e5f6'],
  ['Set-Cookie header', 'Set-Cookie: sid=s%3Aq1w2e3r4t5y6u7i8o9p0; Path=/; HttpOnly', 's%3Aq1w2e3r4t5y6u7i8o9p0'],
  ['PEM private key block', `here is the key:\n${PEM}\nthanks`, PEM_BODY],
  ['password in a URL', 'clone https://deploy:Sup3rS3cretPw@git.example.com/org/repo.git', 'Sup3rS3cretPw'],
  ['curl -u', 'curl -u admin:Hunter2Hunter2 https://api.example.com/v1', 'Hunter2Hunter2'],
  ['password: line', 'login with password: Tr0ub4dor&3xyz please', 'Tr0ub4dor&3xyz'],
];

test('every real-shape secret is gone from the hand-off filter, and a mask is left in its place', () => {
  assert.ok(CASES.length >= 13);
  for (const [label, text, secret] of CASES) {
    assert.ok(text.includes(secret), `fixture: ${label} holds its secret`);
    const out = redact(text);
    assert.ok(!out.includes(secret), `${label}: secret still present in: ${out}`);
    assert.match(out, /\[redacted/, `${label}: no mask in: ${out}`);
    // Idempotent: a second pass changes nothing (the hand-off is masked twice).
    assert.equal(redact(out), out, `${label}: not idempotent`);
  }
});

test('the events-strength filter masks credential shapes and JSON members but leaves free text alone', () => {
  for (const [label, text, secret] of CASES) {
    const out = redactSecrets(text);
    assert.equal(redactSecrets(out), out, `${label}: not idempotent`);
    if (!['.env line with an unprefixed key', 'quoted .env value', 'AWS secret access key line', 'password: line', 'curl -u'].includes(label)) {
      assert.ok(!out.includes(secret), `${label}: secret present in events text: ${out}`);
    }
  }
  // The lines a person types are theirs: an events-strength pass keeps them.
  assert.equal(redactSecrets('set password: hunter2 in the form'), 'set password: hunter2 in the form');
  assert.equal(redactSecrets('PORT=8787'), 'PORT=8787');
});

test('ordinary text is not rewritten (negative controls)', () => {
  const benign = [
    'commit 3f786850e387550fdab836ed7e6dc881de23001b fixes it',
    'uuid 550e8400-e29b-41d4-a716-446655440000',
    'max_tokens: 4096 and tokenizer: gpt',
    'The token count was 5, the password field is required.',
    'Bearer authentication is described in RFC 6750; Basic information follows.',
    'risk-assessment-framework-detailed-model and task-oriented-design-system-notes',
    'pip install sk-learn is wrong; use scikit-learn',
    'https://example.com/a/b?c=d#frag and ssh://git@github.com/org/repo.git',
    '/home/user/.ssh/id_rsa.pub and C:\\Users\\me\\.aws\\config',
    'a 64-char hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    '使用者要求：請幫我整理這份報告，不要動到 token 計數的部分。',
    'const maxTokens = 1024; const apiKeyHeader = "X-Api-Key-Name";',
  ];
  for (const text of benign) {
    assert.equal(redact(text), text, `strict filter rewrote: ${text}`);
    assert.equal(redactSecrets(text), text, `events filter rewrote: ${text}`);
  }
  // A long base64 blob (an inline image) is not scanned or altered.
  const blob = Buffer.alloc(9000, 7).toString('base64');
  assert.equal(redactDeep({ images: [{ data: blob }] }).images[0].data, blob);
});

test('registered exact values (the Hub login token, a bridge key, every pool key) are masked wherever they appear', () => {
  // Shapes that no pattern could know: a plain hex login token, a Claude key behind a gateway.
  const loginToken = hex(32, 9);
  const gatewayKey = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA';
  const stop = registerSecretSource(() => [loginToken, gatewayKey, 'short']);
  try {
    const out = redact(`x-hub-token: ${loginToken} and key=${gatewayKey} and short`);
    assert.ok(!out.includes(loginToken));
    assert.ok(!out.includes(gatewayKey));
    assert.ok(out.includes('short'), 'values under 8 characters are never treated as secrets');
    assert.ok(!redactSecrets(`login ${loginToken}`).includes(loginToken), 'events strength masks exact values too');
    assert.ok(!JSON.stringify(redactDeep({ a: { b: [`k ${gatewayKey}`] } })).includes(gatewayKey));
  } finally {
    stop();
  }
  assert.ok(redactSecrets(`login ${loginToken}`).includes(loginToken), 'an unregistered value is ordinary text again');
});

test('secret-named members are masked by name; look-alikes are not', () => {
  const out = redactDeep({ token: 'opaque123', apiKey: 'k1', client_secret: 'k2', Authorization: 'Basic abc', cookie: 'a=b', password: 'pw', headers: { 'X-Api-Key': 'k3' }, max_tokens: 4096, tokenCount: 3, usage: { inputTokens: 5 }, name: 'safe', empty: '', ok: true });
  assert.deepEqual(out, { token: '[redacted]', apiKey: '[redacted]', client_secret: '[redacted]', Authorization: '[redacted]', cookie: '[redacted]', password: '[redacted]', headers: { 'X-Api-Key': '[redacted]' }, max_tokens: 4096, tokenCount: 3, usage: { inputTokens: 5 }, name: 'safe', empty: '', ok: true });
  assert.ok(isSecretKey('accessToken') && isSecretKey('SESSION_SECRET') && !isSecretKey('inputTokens') && !isSecretKey('tokenizer'));
  const clean = { a: 1, b: ['x', { c: 'y' }] };
  assert.equal(redactDeep(clean), clean, 'a clean value comes back as the same object');
});

test('a secret split across streamed pieces never survives, wherever the cut falls', () => {
  const field = (secret, cutAt) => {
    const ev = {};
    const full = `{"task":"go","token":"${secret}","n":1}`;
    const at = full.indexOf(secret) + cutAt;
    const seen = [];
    for (const piece of [full.slice(0, at), full.slice(at)]) {
      const r = appendRedacted(ev, 'argsText', piece);
      seen.push(r);
    }
    return { ev, seen };
  };
  for (const secret of [HUB_TOKEN, 'sk-ant-api03-Zk3Rq9mT7vXw2LbN8cPd5HfJ1sGyAeUo-4QwErTy_abc']) {
    for (let cut = 1; cut < secret.length; cut += 3) {
      const { ev } = field(secret, cut);
      assert.ok(!ev.argsText.includes(secret), `cut ${cut}: ${ev.argsText}`);
      assert.match(ev.argsText, /"task":"go"/, 'the rest of the arguments is kept');
      assert.match(ev.argsText, /"n":1\}$/);
    }
  }
  // Piece by piece, one character at a time, the stored value is clean at the end.
  const ev = {};
  for (const ch of `curl -H "Authorization: Bearer 8f14e45fceea167a5a36dedd4bea2543" ${HUB_TOKEN} tail`) appendRedacted(ev, 'output', ch);
  assert.ok(!ev.output.includes('8f14e45fceea167a5a36dedd4bea2543'));
  assert.ok(!ev.output.includes(HUB_TOKEN));
  assert.ok(ev.output.endsWith(' tail'));
  // A secret that completes after part of it was shown asks for the field to be replaced.
  const ev2 = {};
  assert.deepEqual(appendRedacted(ev2, 'output', 'key '), { delta: 'key ' });
  const r1 = appendRedacted(ev2, 'output', HUB_TOKEN.slice(0, 20));
  assert.ok(r1.delta !== undefined || r1.replaced);
  const r2 = appendRedacted(ev2, 'output', HUB_TOKEN.slice(20));
  assert.ok(r2.replaced || !r2.delta?.includes(HUB_TOKEN.slice(20)), 'the tail of the token is not sent as a delta');
  assert.ok(!ev2.output.includes(HUB_TOKEN.slice(20)));
  // Clean streaming is byte-identical to a plain append, delta for delta.
  const ev3 = {};
  let sent = '';
  for (const p of ['Hello ', 'wor', 'ld, ', 'no secrets here\n']) sent += appendRedacted(ev3, 'text', p).delta;
  assert.equal(ev3.text, 'Hello world, no secrets here\n');
  assert.equal(sent, ev3.text);
});

test('a long stream keeps only a bounded window and still masks a late secret', () => {
  const ev = {};
  const filler = 'lorem ipsum dolor sit amet '.repeat(40);
  for (let i = 0; i < 80; i++) appendRedacted(ev, 'output', filler);
  appendRedacted(ev, 'output', ` the token is ${HUB_TOKEN.slice(0, 30)}`);
  appendRedacted(ev, 'output', `${HUB_TOKEN.slice(30)} end`);
  assert.ok(!ev.output.includes(HUB_TOKEN));
  assert.ok(!ev.output.includes(HUB_TOKEN.slice(30)));
  assert.ok(ev.output.startsWith('lorem ipsum') && ev.output.endsWith(' end'));
  assert.equal(ev.output.length, filler.length * 80 + ev.output.slice(filler.length * 80).length);
});

test('a private key far longer than the scan window is withheld as a whole while it streams', () => {
  const lines = Array.from({ length: 140 }, (_, i) => `${'AbCdEf0123456789+/'.repeat(4)}${String(i).padStart(4, '0')}`);
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----`;
  const ev = {};
  appendRedacted(ev, 'output', 'ls ~/.ssh\nid_ed25519\ncat id_ed25519\n');
  for (let i = 0; i < pem.length; i += 61) appendRedacted(ev, 'output', pem.slice(i, i + 61));
  appendRedacted(ev, 'output', '\n$ echo done\n');
  assert.ok(lines.length * 80 > 6000, 'the fixture is longer than two windows');
  for (const line of [lines[0], lines[70], lines[139]]) assert.ok(!ev.output.includes(line.slice(0, 40)), `a body line of the key survived: ${line.slice(0, 20)}`);
  assert.ok(!ev.output.includes('BEGIN OPENSSH'));
  assert.match(ev.output, /cat id_ed25519\n\[redacted private key\]\n\$ echo done\n$/);
});

// --------------------------------------------------------- the hand-off text

test('the hand-off built for another provider carries none of the secrets the conversation touched', () => {
  const a = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_secret', provider: 'kimi', cwd: '/work/leaky', origin: 'hub' });
  // Every case goes through one of the places a hand-off reads from.
  const at = (i) => CASES[i][1];
  const places = [
    { id: 'u1', type: 'user', text: CASES.slice(0, 4).map((c) => c[1]).join('\n') },
    { id: 't1', type: 'tool_use', name: 'Bash', title: at(11), status: 'done', output: CASES.slice(4, 8).map((c) => c[1]).join('\n') },
    { id: 't2', type: 'tool_use', name: 'Read', input: { command: at(9) }, status: 'done', output: CASES.slice(15, 19).map((c) => c[1]).join('\n') },
    { id: 'x1', type: 'text', text: [8, 10, 12, 13, 14].map(at).join(' ; ') },
    { id: 'i1', type: 'info', text: at(19) },
    { id: 'er', type: 'error', text: [20, 21, 22].map(at).join(' ; ') },
    { id: 'ok', type: 'text', text: 'the build passed; the report is in /work/leaky/report.md' },
  ];
  places.forEach((ev, i) => a.events.push({ ts: i + 1, ...ev }));
  const used = new Set(CASES.slice(0, 8).concat(CASES.slice(15, 19), [8, 9, 10, 11, 12, 13, 14, 19, 20, 21, 22].map((i) => CASES[i])).map((c) => c[0]));
  assert.equal(used.size, CASES.length, 'every case is placed in the conversation');
  const b = store.createSession({ agentId: 'claude', conversationId: a.conversationId, continuedFrom: a.id, provider: 'claude', origin: 'hub' });
  a.continuedTo = b.id;
  const h = handoffMod.handoffFor(b, { provider: 'claude', model: 'claude-opus-5-5' });
  for (const [label, , secret] of CASES) assert.ok(!h.text.includes(secret), `${label} leaked into the hand-off:\n${h.text}`);
  assert.match(h.text, /the build passed; the report is in \/work\/leaky\/report\.md/, 'ordinary content survives');
  assert.match(h.text, /Working directory: \/work\/leaky/);
  assert.match(h.text, /\[tool Bash\]/);
  assert.match(h.text, /\[redacted/);
});

test('a tool output cut at 400 characters cannot leave half a key: it is masked before it is cut', () => {
  const a = store.createSession({ agentId: 'kimi@m1', machineId: 'm1', kimiSessionId: 'session_cut', provider: 'kimi', origin: 'hub' });
  const key = 'sk-9f8e7d6c5b4a39281716abcdef0123';
  const pad = 'x'.repeat(380);
  a.events.push({ id: 't', ts: 1, type: 'tool_use', name: 'Bash', title: 'env', status: 'done', output: `${pad} DEEPSEEK_API_KEY=${key} more` });
  const b = store.createSession({ agentId: 'claude', conversationId: a.conversationId, continuedFrom: a.id, provider: 'claude', origin: 'hub' });
  a.continuedTo = b.id;
  const { text } = handoffMod.chainTranscript(b);
  assert.ok(!text.includes('sk-9f8e'), text);
  assert.ok(!text.includes('DEEPSEEK_API_KEY=s'), text);
  assert.match(text, /\[output truncated\]/, 'the cut is still announced');
});

// ------------------------------------------- Claude daemon: the second mask

let fake;
let daemon;
let info;
let daemonLog = '';
const KEY = `sk-ant-api03-${'d'.repeat(40)}-test`;
const auth = () => ({ apiKey: KEY, settings: { defaults: { model: 'claude-opus-5-5', effort: 'high', permission: 'auto' }, webTools: false } });
async function rpc(op, args = {}) {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daemon-token': info.token }, body: JSON.stringify({ op, args }) });
  const j = await res.json();
  if (!j.ok) throw Object.assign(new Error(j.error || 'daemon error'), { status: j.status });
  return j.data;
}
async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(25);
  }
  throw new Error(`timeout\n${daemonLog}`);
}

before(async () => {
  fake = await startFakeClaude(KEY);
  const dir = path.join(TMP, 'daemon');
  fs.mkdirSync(dir, { recursive: true });
  daemon = spawn(process.execPath, ['server/claude-daemon.js', '--dir', dir], { cwd: ROOT, env: { ...process.env, AGENT_HUB_CLAUDE_TEST_URL: fake.url }, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', (d) => (daemonLog += d));
  daemon.stderr.on('data', (d) => (daemonLog += d));
  info = await until(async () => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
      return j.port && j.token ? j : null;
    } catch {
      return null;
    }
  });
});
after(async () => {
  try {
    daemon?.kill('SIGTERM');
  } catch {}
  fake?.close();
  store.flushAll();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Claude\'s daemon masks a hand-off it was sent unmasked: the request that reaches Anthropic has no secret', async () => {
  const id = 's_secret_handoff';
  const cwd = path.join(TMP, 'work', id);
  fs.mkdirSync(cwd, { recursive: true });
  const raw = CASES.map(([, text]) => text).join('\n\n');
  await rpc('create', {
    id,
    cwd,
    title: id,
    permissionMode: 'auto',
    config: { permission: 'auto', model: 'claude-opus-5-5', effort: 'high', handoff: { text: `User: ${raw}\n\nAssistant: 先前的回答在 /work/x`, from: 'Kimi', model: 'kimi-k3' } },
    auth: auth(),
  });
  const n0 = fake.requests.filter((r) => r.url.startsWith('/v1/messages')).length;
  await rpc('send', { id, text: '接著做', auth: auth() });
  await until(async () => !['running', 'awaiting_permission'].includes((await rpc('snapshot', { id })).status));
  const sent = fake.requests.filter((r) => r.url.startsWith('/v1/messages'))[n0];
  const wire = JSON.stringify(sent.body);
  for (const [label, , secret] of CASES) {
    // The body is JSON, so a secret with a newline or a quote is escaped there.
    assert.ok(!wire.includes(secret) && !wire.includes(JSON.stringify(secret).slice(1, -1)), `${label} reached the Anthropic request`);
  }
  assert.match(wire, /先前的回答在 \/work\/x/, 'the ordinary hand-off text is still sent');
  assert.match(wire, /earlier history carried over|prior conversation history/);
});
