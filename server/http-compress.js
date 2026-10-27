// gzip for the API's big JSON answers (a conversation snapshot, the list), for
// a client that says it accepts it. Node's own zlib, off the main thread, so a
// 300 KB answer costs the event loop nothing while it is squeezed. Small
// answers go out as they are: compressing them costs more than it saves.
import zlib from 'node:zlib';

export const THRESHOLD = 1024; // bytes below which an answer is sent plain
const LEVEL = 4; // fast; JSON text still shrinks 5-10x

// Does the Accept-Encoding header allow gzip (and not with q=0)?
export function acceptsGzip(header) {
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined);
    if (q === undefined || Number(q) > 0) return true;
  }
  return false;
}

export function compressResponses({ threshold = THRESHOLD, level = LEVEL } = {}) {
  return (req, res, next) => {
    if (!acceptsGzip(req.headers['accept-encoding'])) return next();
    const send = res.send;
    res.send = function compressedSend(body) {
      const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.isBuffer(body) ? body : null;
      if (!buf || buf.length < threshold || this.headersSent || this.getHeader('Content-Encoding') || this.statusCode === 204 || this.statusCode === 304) {
        return send.call(this, body);
      }
      if (!this.getHeader('Content-Type') && typeof body === 'string') this.type('html'); // what send() would have said
      this.vary('Accept-Encoding');
      zlib.gzip(buf, { level }, (err, out) => {
        if (err || this.headersSent) return send.call(this, body); // could not: send it plain
        this.set('Content-Encoding', 'gzip');
        send.call(this, out);
      });
      return this;
    };
    next();
  };
}
