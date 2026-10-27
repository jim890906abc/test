// The Claude daemon reads a request body whole, whatever the network cuts it
// into: a multi-byte character (every Chinese character is three bytes, an
// emoji four) that lands across two chunks used to come out as U+FFFD in the
// text the daemon acted on, because the chunks were turned into text one at a
// time. A real daemon process, a real HTTP request written in pieces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, procs, cleanup, scratch, waitFor, readJson } from './fixtures/hub-process.mjs';

after(cleanup);

// An operation the daemon does not know is refused by name, and the name is
// the text we sent: what comes back says how the body was decoded.
const TEXT = '請求😀亂碼é';

// Every way to cut the body inside a character (one cut, and two cuts inside
// the same character), plus cuts between characters as the control.
function cutsFor(body) {
  const start = body.indexOf(Buffer.from(TEXT));
  const cuts = [];
  let at = start;
  for (const ch of TEXT) {
    const len = Buffer.byteLength(ch);
    cuts.push([at]); // between characters: never was a problem
    for (let a = 1; a < len; a++) {
      cuts.push([at + a]);
      for (let b = a + 1; b < len; b++) cuts.push([at + a, at + b]);
    }
    at += len;
  }
  return cuts;
}

test('the Claude daemon reads a request body whole whatever the cuts', async () => {
  const sc = scratch('daemon-body');
  const dir = path.join(sc.dir, 'claude');
  const child = spawn(process.execPath, ['server/claude-daemon.js', '--dir', dir], { cwd: ROOT, env: { ...process.env, HOME: sc.dir }, stdio: 'ignore' });
  procs.add(child);
  try {
    const info = await waitFor(() => {
      const j = readJson(path.join(dir, 'daemon.json'));
      return j.pid === child.pid && j.port && j;
    }, 'the daemon to write daemon.json', 15000);
    const body = Buffer.from(JSON.stringify({ op: TEXT, args: {} }));
    const post = (cuts) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: info.port, path: '/rpc', method: 'POST', headers: { 'x-daemon-token': info.token, 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (raw += d));
          res.on('end', () => resolve(JSON.parse(raw)));
        });
        req.on('error', reject);
        (async () => {
          let from = 0;
          for (const cut of [...cuts, body.length]) {
            req.write(body.subarray(from, cut));
            from = cut;
            if (from < body.length) await new Promise((r) => setTimeout(r, 25));
          }
          req.end();
        })();
      });
    const queue = cutsFor(body);
    assert.ok(queue.length > 20);
    const seen = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length) {
          const cuts = queue.shift();
          const r = await post(cuts);
          assert.equal(r.ok, false);
          seen.push(cuts.join(','));
          assert.ok(r.error.endsWith(TEXT), `cut at ${cuts}: ${r.error}`);
        }
      }),
    );
    assert.ok(seen.length > 20);
  } finally {
    child.kill('SIGTERM');
  }
});
