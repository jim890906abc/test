// REST + WebSocket client.

let token = '';
try {
  const m = location.hash.match(/token=([A-Za-z0-9]+)/);
  if (m) {
    localStorage.setItem('hubToken', m[1]);
    history.replaceState(null, '', location.pathname + '#/');
  }
  token = localStorage.getItem('hubToken') || '';
} catch {}

export function setToken(t) {
  token = t;
  try {
    localStorage.setItem('hubToken', t);
  } catch {}
}

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-hub-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

// Persistent socket with backoff. onStatus(true|false) reports connectivity;
// callers resync state after a reconnect.
export function connect(onMessage, onStatus) {
  let delay = 500;
  let ws;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => {
      onStatus(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();
}
