// What the Hub serves without a login token. public/ is the product's own
// page (index.html, css/, js/) and nothing else: a report, a screenshot or a
// note that lands in that folder must not be readable over the network (the
// Hub is often put on the public internet by scripts/start-public.sh). And
// the files the connectors download (the bridge, the Claude daemon bundle,
// two vendor modules) must be served wherever the Hub is installed, also in a
// folder whose path has a dot in it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, makeHubTree, startHub } from './fixtures/hub-tree.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-static-'));
let port = 30000 + Math.floor(Math.random() * 2000);
const hubs = [];

// Same checks in a plain folder and in one with a dot in its path.
const places = [
  ['plain path', path.join(TMP, 'plain', 'hub')],
  ['path with a dot directory', path.join(TMP, '.dot', 'hub')],
];

// A request with the path exactly as written (fetch would tidy "..").
const raw = (base, p) =>
  new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });

before(async () => {
  for (const [name, tree] of places) {
    makeHubTree(tree);
    const pub = path.join(tree, 'public');
    // What ended up in public/ in real life, and the kinds of file around it.
    fs.writeFileSync(path.join(pub, 'secret.html'), '<h1>private report: password=hunter2</h1>');
    fs.writeFileSync(path.join(pub, 'report.png'), 'PNG-SECRET');
    fs.writeFileSync(path.join(pub, 'notes.txt'), 'NOTES-SECRET');
    fs.writeFileSync(path.join(pub, '.env'), 'API_KEY=ENV-SECRET');
    fs.mkdirSync(path.join(pub, 'private'));
    fs.writeFileSync(path.join(pub, 'private', 'shot-01.png'), 'SHOT-SECRET');
    fs.writeFileSync(path.join(pub, 'private-page.html'), '<p>PAGE-SECRET</p>');
    fs.writeFileSync(path.join(pub, 'css', 'leak.html'), 'CSS-DIR-HTML-SECRET');
    fs.writeFileSync(path.join(pub, 'js', 'data.json'), '{"k":"JS-DIR-JSON-SECRET"}');
    fs.mkdirSync(path.join(pub, 'js', 'sub'));
    fs.writeFileSync(path.join(pub, 'js', 'sub', 'extra.js'), '// nested product script');
    fs.writeFileSync(path.join(pub, 'js', '.hidden.js'), 'HIDDEN-SECRET');
    hubs.push(await startHub(tree, { port: ++port, data: path.join(TMP, name.replace(/\W+/g, '_'), 'data') }));
  }
});

after(() => {
  for (const h of hubs) h.stop();
  setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
});

for (const [i, [name, tree]] of places.entries()) {
  test(`public/ serves only the product page, css/ and js/ (${name})`, async () => {
    const { base } = hubs[i];
    // The product.
    const page = await raw(base, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /<div id="app"/);
    assert.equal((await raw(base, '/index.html')).body, page.body);
    for (const f of ['css/app.css', 'css/oatmeal.css', 'js/app.js', 'js/transcript.js', 'js/composer.js']) {
      const r = await raw(base, `/${f}`);
      assert.equal(r.status, 200, f);
      assert.equal(r.body, fs.readFileSync(path.join(REPO, 'public', f), 'utf8'), `${f} is served as it is`);
    }
    assert.match((await raw(base, '/css/app.css')).type, /text\/css/);
    assert.match((await raw(base, '/js/app.js')).type, /javascript/);
    assert.equal((await raw(base, '/js/sub/extra.js')).status, 200, 'a script in a js/ subfolder is the product too');

    // Everything else in public/ is not for the network: 404, and never the page standing in for it.
    for (const p of ['/secret.html', '/report.png', '/notes.txt', '/.env', '/private/shot-01.png', '/private-page.html', '/css/leak.html', '/js/data.json', '/js/.hidden.js', '/public/secret.html', '/favicon.ico', '/.git/config']) {
      const r = await raw(base, p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!/SECRET|hunter2|<div id="app"/.test(r.body), `${p} leaked: ${r.body.slice(0, 60)}`);
    }
    // Ways around the list.
    for (const p of ['/css/../secret.html', '/css/%2e%2e/secret.html', '/js/..%2fsecret.html', '/js/..%5csecret.html', '/css/%2e%2e%2f%2e%2e%2fpackage.json', '/%2e%2e/package.json', '/css/app.css%00.html', '/secret.html%20', '/SECRET.HTML', '/index.html/../secret.html']) {
      const r = await raw(base, p);
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
      assert.ok(!/SECRET|hunter2|"name": "agent-hub"/i.test(r.body), `${p} leaked: ${r.body.slice(0, 60)}`);
    }
    // A folder name is a page route, not a listing or a file: the page, or nothing — never contents.
    for (const p of ['/private/', '/css/', '/js/', '/js', '/private']) {
      const r = await raw(base, p);
      assert.ok(r.status === 404 || /<div id="app"/.test(r.body), `${p} → ${r.status}`);
      assert.ok(!/SECRET|\.png|\.css/.test(r.body.replace(/\/css\/(app|oatmeal)\.css|\/js\/app\.js/g, '')), `${p} listed or leaked something`);
    }
    // A client-side route (no file extension) still gets the page.
    const route = await raw(base, '/some/page');
    assert.equal(route.status, 200);
    assert.match(route.body, /<div id="app"/);
    // The API is still behind its own rules.
    assert.equal((await raw(base, '/api/nope')).status, 404);
  });

  test(`the connector downloads are served wherever the Hub is installed (${name})`, async () => {
    const { base } = hubs[i];
    for (const [url, file] of [
      ['/bridge/claude-daemon.mjs', 'bridge/claude-daemon.mjs'],
      ['/bridge/agent-hub-bridge.mjs', 'bridge/agent-hub-bridge.mjs'],
      ['/vendor/marked.esm.js', 'node_modules/marked/lib/marked.esm.js'],
      ['/vendor/purify.es.mjs', 'node_modules/dompurify/dist/purify.es.mjs'],
    ]) {
      const r = await raw(base, url);
      assert.equal(r.status, 200, `${url} → ${r.status} in ${tree}`);
      assert.equal(r.body, fs.readFileSync(path.join(REPO, file), 'utf8'), url);
    }
    assert.match((await raw(base, '/bridge/claude-daemon.mjs')).type, /javascript/);
  });
}

test('the repository agrees with the list: every tracked public/ file is served, and strays are ignored by default', async () => {
  const tracked = execFileSync('git', ['ls-files', 'public'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.includes('public/index.html') && tracked.some((f) => f.startsWith('public/js/')) && tracked.some((f) => f.startsWith('public/css/')));
  const { base } = hubs[0];
  for (const f of tracked) {
    const r = await raw(base, `/${f.replace(/^public\//, '')}`);
    assert.equal(r.status, 200, `${f} is in the repository but the Hub does not serve it`);
  }
  // What lands in public/ by accident is not committed by `git add -A`.
  for (const stray of ['secret.html', 'private-report.html', 'private/shot-01.png', 'notes.txt', 'css/leak.html', 'js/data.json']) {
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', `public/${stray}`], { cwd: REPO });
    } catch {
      ignored = false;
    }
    assert.ok(ignored, `public/${stray} would be committed`);
  }
});
