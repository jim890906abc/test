// Pieces the streaming tests share: a machine that streams a Kimi conversation
// into the Hub, a browser page reduced to what it keeps, and a bare WebSocket
// that shows frames as they travelled (compressed or not).
import crypto from 'node:crypto';
import net from 'node:net';
import zlib from 'node:zlib';
import WebSocket from 'ws';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A machine on the Hub's bridge that has one Kimi session, `kid`, and can stream frames into it.
export function fakeMachine({ port, key, kid, machineId = 'm_w' }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?key=${encodeURIComponent(key)}`);
  const send = (m) => ws.send(JSON.stringify(m));
  const info = { id: kid, title: '視窗', metadata: { cwd: '/tmp/p' }, busy: false, pending_interaction: 'none', last_turn_reason: 'completed' };
  ws.on('open', () => {
    send({ t: 'hello', machineId, name: 'm', platform: 'test', bridgeVersion: '0.3.0', home: '/h', status: { available: true, server: true } });
    send({ t: 'kimi.sessions', items: [{ ...info, updated_at: new Date().toISOString() }] });
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t !== 'req') return;
    let out = { ok: true };
    if (m.op === 'kimi.info') out = info;
    else if (m.op === 'kimi.history') out = { frames: [], more: false, before: 0, info };
    else if (m.op === 'kimi.request') out = { code: 0, data: {} };
    send({ t: 'res', id: m.id, ok: true, data: out });
  });
  const frame = (type, payload) => send({ t: 'kimi.event', frame: { type, session_id: kid, payload: { agentId: 'main', ...payload, sessionId: kid } } });
  // `info` is what the machine answers about the session: a test sets info.busy while it streams a turn.
  return { ws, frame, info, ready: new Promise((r) => ws.on('open', r)) };
}

// A browser page reduced to what it keeps: the events it shows, in order, built
// the way app.js builds them (snapshot, then event / patch / delta by seq).
export function page({ port, token, watch, window } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const p = { ws, got: [], snapshots: 0, view: null, order: [], seq: 0, window: null, problems: [], unknownTargets: 0 };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    for (const x of m.t === 'batch' ? m.items : [m]) {
      p.got.push(x);
      if (x.t === 'snapshot') {
        if (x.error) continue;
        p.snapshots++;
        p.view = new Map(x.session.events.map((e) => [e.id, structuredClone(e)]));
        p.order = x.session.events.map((e) => e.id);
        p.seq = x.session.seq;
        p.window = x.session.window;
        continue;
      }
      if (!['event', 'patch', 'delta'].includes(x.t) || !p.view) continue;
      if (x.seq <= p.seq) continue;
      if (x.seq !== p.seq + 1) p.problems.push(`gap: ${p.seq} → ${x.seq}`);
      p.seq = x.seq;
      if (x.t === 'event') {
        p.view.set(x.ev.id, structuredClone(x.ev));
        p.order.push(x.ev.id);
      } else if (!p.view.has(x.id)) p.unknownTargets++;
      else if (x.t === 'patch') Object.assign(p.view.get(x.id), x.fields);
      else p.view.get(x.id)[x.field] = (p.view.get(x.id)[x.field] || '') + x.text;
    }
  });
  p.watch = (sid2) => ws.send(JSON.stringify({ t: 'watch', sid: sid2, ...(window ? { window } : {}) }));
  p.ready = new Promise((r) => ws.on('open', () => (watch !== undefined && p.watch(watch), r())));
  return p;
}

// A bare WebSocket client that keeps the frames as the wire carried them, to
// see which were compressed (RSV1) and how big they were.
export function rawSocket({ port, token, deflate }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let negotiated = '';
    const frames = [];
    const waiters = [];
    socket.on('connect', () => {
      socket.write([
        `GET /ws?token=${token} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        ...(deflate ? ['Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits'] : []), '', '',
      ].join('\r\n'));
    });
    socket.on('error', reject);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buf.subarray(0, end).toString();
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head));
        negotiated = /sec-websocket-extensions:\s*(.*)/i.exec(head)?.[1] || '';
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + len) break;
        const payload = buf.subarray(at, at + len);
        const rsv1 = Boolean(buf[0] & 0x40);
        const text = (rsv1 ? zlib.inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]), { finishFlush: zlib.constants.Z_SYNC_FLUSH }) : payload).toString('utf8');
        frames.push({ rsv1, wireBytes: at + len, textBytes: Buffer.byteLength(text), text });
        buf = buf.subarray(at + len);
        for (const w of waiters.splice(0)) w();
      }
    });
    const client = {
      negotiated,
      frames,
      send(text) {
        const body = Buffer.from(text);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]));
        const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]);
        socket.write(Buffer.concat([head, mask, masked]));
      },
      async frame(match, ms = 5000) {
        const end = Date.now() + ms;
        for (;;) {
          const f = frames.find((x) => match(x.text));
          if (f) return f;
          if (Date.now() > end) throw new Error('no such frame');
          await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
        }
      },
      close: () => socket.destroy(),
    };
    const ready = setInterval(() => {
      if (upgraded) { clearInterval(ready); client.negotiated = negotiated; resolve(client); }
    }, 5);
  });
}
