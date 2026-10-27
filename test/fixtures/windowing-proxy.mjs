// A stand-in for a Hub that serves a conversation in WINDOWS, so the front end
// can be tested and measured against that contract without depending on the
// server side being there yet.
//
// It sits in front of a real Hub and passes everything through, except:
//   - a snapshot (WebSocket `snapshot`, and GET /api/sessions/:id) carries only
//     the newest `size` events, plus `session.window = { total, firstIndex, hasEarlier }`;
//   - GET /api/sessions/:id/events?before=<firstIndex>&limit=<n>
//       -> { events, firstIndex, hasEarlier }   (the n events right before `before`)
//   - a string field larger than `truncateOver` (output / text / argsText) is cut
//     to a `previewBytes` preview and the event gets `truncated: { field, bytes }`;
//   - GET /api/sessions/:id/events/:eventId?full=1 -> { event } with it whole.
//
// `stats` counts what went through, so a test can say how much was asked for.
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const CUT_FIELDS = ['output', 'text', 'argsText'];

// `size` null: the whole conversation is passed on untouched (a Hub that does not
// window); the proxy then only learns each snapshot's seq and summary, so that
// live messages can be played into the page.
export async function startWindowingProxy({ target, size = 120, truncateOver = 32768, previewBytes = 4096, delayMs = 0 }) {
  // How long a snapshot is held back before it is sent on (a slow Hub or link).
  let snapshotDelay = 0;
  const t = new URL(target);
  const full = new Map(); // session id -> the whole event list, as of its first snapshot
  const seqs = new Map(); // session id -> the seq of the last snapshot sent, then of what was pushed
  const summaries = new Map(); // session id -> its summary (the snapshot without events)
  const watchers = new Set(); // { client, sid }
  const warmSnap = new Map(); // session id -> the Hub's snapshot message, kept so a watch is answered at once
  const stats = { snapshots: 0, snapshotBytes: 0, pages: 0, pageEvents: 0, fulls: 0, beforeIds: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cut = (ev) => {
    for (const f of CUT_FIELDS) {
      const v = ev[f];
      if (typeof v === 'string' && v.length > truncateOver) return { ...ev, [f]: v.slice(0, previewBytes), truncated: { field: f, bytes: Buffer.byteLength(v) } };
    }
    return ev;
  };

  // Rewrite a snapshot body ({session:{events,...}}) into its window.
  const windowed = (sid, session) => {
    const events = session.events || [];
    full.set(sid, events);
    seqs.set(sid, session.seq || 0);
    const { events: _e, chain: _c, window: _w, ...summary } = session;
    summaries.set(sid, summary);
    // size null: a Hub that sends the whole conversation (the proxy only plays the live stream)
    if (!size) return session;
    const firstIndex = Math.max(0, events.length - size);
    return { ...session, events: events.slice(firstIndex).map(cut), window: { total: events.length, firstIndex, hasEarlier: firstIndex > 0 } };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/events(?:\/([\w-]+))?)?$/);
    try {
      if (m && req.method === 'GET') {
        const [, sid, eventId] = m;
        const isEvents = url.pathname.includes('/events');
        if (isEvents) {
          if (!full.has(sid)) await load(sid);
          const all = full.get(sid) || [];
          if (delayMs) await sleep(delayMs);
          if (eventId) {
            stats.fulls++;
            const ev = all.find((e) => e.id === eventId);
            res.writeHead(ev ? 200 : 404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(ev ? { event: ev } : { error: 'no such event' }));
          }
          const before = Math.min(Number(url.searchParams.get('before') ?? all.length), all.length);
          const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 1000));
          const start = Math.max(0, before - limit);
          stats.pages++;
          stats.beforeIds.push(url.searchParams.get('beforeId'));
          stats.pageEvents += before - start;
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ events: all.slice(start, before).map(cut), firstIndex: start, hasEarlier: start > 0 }));
        }
        // GET /api/sessions/:id (the HTTP copy of the snapshot)
        const body = await upstream(req);
        const parsed = JSON.parse(body);
        const out = parsed.session ? { ...parsed, session: windowed(sid, parsed.session) } : windowed(sid, parsed);
        const text = JSON.stringify(out);
        stats.snapshots++;
        stats.snapshotBytes += text.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(text);
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    pipe(req, res);
  });

  // Fetch a conversation once, up front, so that later opens are answered from
  // memory the way a Hub that windows on its side would (no 30 MB read each time).
  async function warm(sid) {
    const body = await (await fetch(`${target.replace(/\/$/, '')}/api/sessions/${sid}?window=all`)).text();
    const parsed = JSON.parse(body);
    const session = parsed.session || parsed;
    full.set(sid, session.events || []);
    warmSnap.set(sid, session);
  }

  async function load(sid) {
    const body = await (await fetch(`${target.replace(/\/$/, '')}/api/sessions/${sid}?window=all`)).text();
    const parsed = JSON.parse(body);
    full.set(sid, (parsed.session || parsed).events || []);
  }

  // The Hub windows its own snapshots now; this proxy cuts them itself, so it asks for the whole copy.
  const whole = (p) => `${p}${p.includes('?') ? '&' : '?'}window=all`;

  function upstream(req) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: t.hostname, port: t.port, path: whole(req.url), method: req.method, headers: { ...req.headers, host: t.host } }, (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      r.on('error', reject);
      r.end();
    });
  }

  function pipe(req, res) {
    const r = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    r.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(err.message));
    });
    req.pipe(r);
  }

  // Messages as the Hub would send them while a conversation is live, to the pages watching it.
  const live = (sid) => {
    const send = (msg) => {
      seqs.set(sid, (seqs.get(sid) || 0) + 1);
      const text = JSON.stringify({ ...msg, sid, seq: seqs.get(sid) });
      for (const w of watchers) if (w.sid === sid && w.client.readyState === 1) w.client.send(text);
    };
    return {
      status: (status) => {
        const text = JSON.stringify({ t: 'session', session: { ...summaries.get(sid), status, updatedAt: Date.now() } });
        for (const w of watchers) if (w.client.readyState === 1) w.client.send(text);
      },
      event: (ev) => send({ t: 'event', ev: { ts: Date.now(), ...ev } }),
      delta: (id, field, text) => send({ t: 'delta', id, field, text }),
      patch: (id, fields) => send({ t: 'patch', id, fields }),
    };
  };

  const wss = new WebSocketServer({ noServer: true });
  // End every page's socket (as a network drop would): the page reconnects and asks again.
  const dropSockets = () => wss.clients.forEach((c) => c.terminate());
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const up = new WebSocket(`ws://${t.host}${req.url}`);
      const backlog = [];
      const skip = new Set(); // sids whose next upstream snapshot was already answered
      const me = { client, sid: null };
      watchers.add(me);
      client.on('close', () => watchers.delete(me));
      client.on('message', (d, isBinary) => {
        if (!isBinary) {
          try {
            const m = JSON.parse(d.toString());
            if (m.t === 'watch') me.sid = m.sid || null;
            if (size && m.t === 'watch') {
              m.window = 'all';
              d = Buffer.from(JSON.stringify(m));
            }
            if (m.t === 'watch' && m.sid && warmSnap.has(m.sid)) {
              const out = JSON.stringify({ t: 'snapshot', sid: m.sid, session: windowed(m.sid, warmSnap.get(m.sid)) });
              stats.snapshots++;
              stats.snapshotBytes += out.length;
              skip.add(m.sid);
              setTimeout(() => client.readyState === 1 && client.send(out), snapshotDelay);
            }
          } catch {}
        }
        if (up.readyState === 1) up.send(d, { binary: isBinary });
        else backlog.push([d, isBinary]);
      });
      up.on('open', () => backlog.splice(0).forEach(([d, b]) => up.send(d, { binary: b })));
      up.on('message', (d, isBinary) => {
        if (isBinary) return client.send(d, { binary: true });
        const text = d.toString();
        if (!size) {
          // untouched, but note where the stream stands
          const cut = text.indexOf(',"events":[');
          const at = text.slice(0, 200).indexOf('{"t":"snapshot"');
          if (at !== -1 && cut > 0) {
            try {
              const head = JSON.parse(`${text.slice(at, cut)}}}`);
              seqs.set(head.sid, head.session.seq || 0);
              const { events: _e, chain: _c, window: _w, ...summary } = head.session;
              summaries.set(head.sid, summary);
            } catch {}
            stats.snapshots++;
            stats.snapshotBytes += text.length;
            return setTimeout(() => client.readyState === 1 && client.send(text), snapshotDelay);
          }
          return client.send(text);
        }
        // Dropped without parsing (it is the big one): a snapshot answered already.
        const head = text.slice(0, 200).match(/^\{"t":"snapshot","sid":"([^"]+)"/);
        if (head && skip.delete(head[1])) return;
        if (!text.slice(0, 200).includes('"t":"snapshot"') || text.includes('"error"') && text.length < 400) return client.send(text);
        const msg = JSON.parse(text);
        const one = (m) => {
          if (m.t === 'snapshot' && m.session?.events) m.session = windowed(m.sid, m.session);
          return m;
        };
        // A snapshot already answered from the warm copy is dropped here.
        const mine = (m) => !(m.t === 'snapshot' && skip.delete(m.sid));
        if (msg.t === 'batch') {
          msg.items = msg.items.filter(mine).map(one);
          if (!msg.items.length) return;
        } else if (!mine(msg)) return;
        else one(msg);
        const out = JSON.stringify(msg);
        stats.snapshots++;
        stats.snapshotBytes += out.length;
        setTimeout(() => client.readyState === 1 && client.send(out), snapshotDelay);
      });
      up.on('close', () => client.close());
      client.on('close', () => up.close());
      up.on('error', () => client.close());
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    stats,
    warm,
    dropSockets,
    live,
    holdSnapshots: (ms) => (snapshotDelay = ms),
    close: () => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), server.close(() => r()), server.closeAllConnections?.())),
  };
}
