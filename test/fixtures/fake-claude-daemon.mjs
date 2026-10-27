// A stand-in for the Claude daemon (bridge/claude-daemon.mjs) in the
// connector's tests: it speaks the same three endpoints the connector uses
// (/health, /rpc, /events), writes daemon.json the same way, and reports what
// the test tells it to:
//   --dir <dir>                   where daemon.json goes (the connector's dir)
//   FAKE_DAEMON_VERSION           the version /health reports
//   FAKE_DAEMON_CAPS              comma list for /health.capabilities; unset =
//                                 no `capabilities` field (a daemon from before
//                                 the field existed)
//   <dir>/busy.json               [ids] reported as /health.running (re-read on
//                                 every call, so a test can finish the work)
//   <dir>/rpc.log                 one JSON line per /rpc call: { op, args }
// SIGTERM ends it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const dir = path.resolve(args[args.indexOf('--dir') + 1]);
const VERSION = process.env.FAKE_DAEMON_VERSION || 'fake1';
const caps = process.env.FAKE_DAEMON_CAPS;
const TOKEN = crypto.randomBytes(12).toString('hex');
fs.mkdirSync(dir, { recursive: true });
const running = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'busy.json'), 'utf8'));
  } catch {
    return [];
  }
};
const server = http.createServer((req, res) => {
  const send = (code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
  if (req.headers['x-daemon-token'] !== TOKEN) return send(401, { ok: false, error: 'bad token' });
  if (req.url === '/health') return send(200, { ok: true, version: VERSION, pid: process.pid, running: running(), ...(caps !== undefined ? { capabilities: caps ? caps.split(',') : [] } : {}) });
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/rpc') {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const { op, args: a } = JSON.parse(raw || '{}');
      fs.appendFileSync(path.join(dir, 'rpc.log'), `${JSON.stringify({ op, args: a, pid: process.pid, version: VERSION })}\n`);
      send(200, { ok: true, data: { handledBy: VERSION, pid: process.pid, op } });
    });
    return;
  }
  send(404, { ok: false });
});
server.listen(0, '127.0.0.1', () => {
  const file = path.join(dir, 'daemon.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ port: server.address().port, token: TOKEN, pid: process.pid, version: VERSION }));
  fs.renameSync(`${file}.tmp`, file);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
