// The Hub's content security policy in a real browser: the page and its side
// panel (an Artifact: a page a model wrote, shown in a sandboxed srcdoc
// iframe that inherits the page's policy) must work under the default policy;
// the Hub cannot be framed; and AGENT_HUB_CSP=strict really shuts out injected
// scripts while the Hub itself still works.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, seedSession, skipReason, startHub } from './browser-harness.mjs';

const skip = skipReason();
const now = Date.now();

// A page like the ones models write: inline style, inline script, and the
// bridge the Hub puts in (window.agentHub) to hand a text back to the composer.
const PAGE = '<!doctype html><html><head><title>Probe page</title><style>body{font-family:sans-serif}</style></head><body><h1>Probe</h1><script>agentHub.fill("ARTIFACT-RAN")</script></body></html>';
const artifactSession = () =>
  seedSession({
    id: 's_art',
    title: 'Writes a page',
    agentId: 'kimi@m1',
    machineId: 'm1',
    kimiSessionId: 'k_s_art',
    cwd: '/tmp/art',
    updatedAt: now - 5000,
    events: [
      { id: 'a_u', ts: now - 9000, type: 'user', text: 'make a page' },
      { id: 'a_w', ts: now - 8000, type: 'tool_use', agentId: 'main', name: 'Write', title: 'Write page.html', status: 'done', input: { path: '/tmp/art/page.html', content: PAGE } },
    ],
  });

let hubs = [];
let b;
before(async () => {
  if (skip) return;
  b = await launchBrowser();
  // Every document (the page and any frame) reports what its policy blocks.
  await b.beforeLoad(`window.__csp = []; addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));`);
});
after(async () => {
  await b?.close();
  for (const h of hubs) h.stop();
});

const open = async (env, hash = '#/s/s_art') => {
  const hub = await startHub([artifactSession()], { env });
  hubs.push(hub);
  await b.goto(hub.url + hash, 600);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelectorAll('.side-row').length >= 1`);
  return hub;
};

test('default policy: the page loads with nothing blocked, and an Artifact still runs its own scripts and talks to the composer', { skip }, async () => {
  const hub = await open({});
  assert.deepEqual(await b.eval('window.__csp'), [], 'nothing of the Hub\'s own page is blocked');
  assert.equal(await b.eval('document.documentElement.dataset.look'), 'kimi', 'the inline palette script in index.html ran');
  const csp = await b.eval(`fetch('/').then((r) => r.headers.get('content-security-policy'))`);
  assert.match(csp, /frame-ancestors 'none'/);
  await b.click('.artifact-card');
  await b.waitFor(`document.querySelector('iframe.artifact-frame') && document.querySelector('.composer-input')?.value === 'ARTIFACT-RAN'`, { timeout: 8000, label: 'the Artifact\'s inline script ran and filled the composer through agentHub' });
  assert.deepEqual(await b.eval('window.__csp'), []);
  // The model's page as the Hub keeps it, shown in a sandbox without allow-same-origin.
  assert.equal(await b.eval(`document.querySelector('iframe.artifact-frame').getAttribute('sandbox').includes('allow-same-origin')`), false);
  void hub;
});

test('the Hub cannot be put in a frame (X-Frame-Options and frame-ancestors), not even by a page of its own origin', { skip }, async () => {
  await open({}, '#/');
  const framed = await b.eval(`new Promise((resolve) => { const f = document.createElement('iframe'); f.src = '/'; f.onload = () => resolve(f.contentDocument === null ? 'blocked' : 'framed'); document.body.append(f); setTimeout(() => resolve('timeout'), 5000); })`);
  assert.equal(framed, 'blocked');
});

test('AGENT_HUB_CSP=strict: the Hub still works (scripts, styles, its socket), and a script put into the page is not run', { skip }, async () => {
  const hub = await open({ AGENT_HUB_CSP: 'strict' }, '#/');
  assert.deepEqual(await b.eval('window.__csp'), [], 'nothing of the Hub\'s own page is blocked');
  assert.equal(await b.eval('document.documentElement.dataset.look'), 'kimi', 'the hashed inline script in index.html ran');
  assert.ok(await b.eval(`document.querySelectorAll('.side-row').length >= 1`), 'the page is drawn');
  assert.equal(
    await b.eval(`new Promise((resolve) => { const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onmessage = () => resolve('socket open'); ws.onerror = () => resolve('socket blocked'); setTimeout(() => resolve('timeout'), 4000); })`),
    'socket open',
  );
  // What an attacker who got markup into the page would try: an inline script, an inline handler, a script from elsewhere.
  await b.eval(`(() => {
    const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s);
    const i = document.createElement('div'); i.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__handler = 1">'; document.body.append(i);
    const x = document.createElement('script'); x.src = 'http://127.0.0.1:1/evil.js'; document.body.append(x);
  })()`);
  await b.sleep(500);
  assert.equal(await b.eval('window.__inline'), undefined, 'inline script');
  assert.equal(await b.eval('window.__handler'), undefined, 'inline handler');
  const blocked = await b.eval('window.__csp');
  assert.ok(blocked.some((v) => v.startsWith('script-src-elem')) && blocked.some((v) => v.startsWith('script-src-attr') || v.includes('inline')), `violations: ${JSON.stringify(blocked)}`);
  const csp = await b.eval(`fetch('/').then((r) => r.headers.get('content-security-policy'))`);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  void hub;
});

test('AGENT_HUB_CSP=strict: an Artifact\'s inline scripts do not run (the price of the strict policy: its frame inherits it)', { skip }, async () => {
  await open({ AGENT_HUB_CSP: 'strict' });
  await b.click('.artifact-card');
  await b.waitFor(`[...document.querySelectorAll('iframe.artifact-frame')].some((f) => f.srcdoc.includes('ARTIFACT-RAN'))`);
  await b.sleep(1500);
  assert.equal(await b.eval(`document.querySelector('.composer-input')?.value ?? ''`), '', 'the page\'s script was blocked, so it never filled the composer');
});
