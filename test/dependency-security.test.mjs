// The two production dependencies that npm audit flagged before the repository
// went public stay on fixed versions, and the front end's only XSS defence
// (DOMPurify, applied to every rendered Markdown reply) still does its job on
// the version that is installed.
//
//   dompurify    critical  GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f  (fixed in 3.4.17)
//   body-parser  high      GHSA-27r3-jxmh-p828 (trailing bytes after a compressed body)    (fixed in 2.4.0)
//
// The version floors read package-lock.json (what `npm ci` installs) and the
// installed copies; the sanitising check runs the real front-end Markdown
// renderer in a real browser, so it skips, saying why, without a Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, skipReason, startHub, launchBrowser } from './browser-harness.mjs';

const FLOORS = { dompurify: '3.4.17', 'body-parser': '2.4.0' };

const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10));
function atLeast(version, floor) {
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

test('the version comparison used here orders versions numerically, not as text', () => {
  assert.equal(atLeast('3.4.17', '3.4.17'), true);
  assert.equal(atLeast('3.4.16', '3.4.17'), false);
  assert.equal(atLeast('3.10.0', '3.4.17'), true, '10 is more than 4');
  assert.equal(atLeast('2.3.0', '2.4.0'), false);
  assert.equal(atLeast('2.4.0', '2.4.0'), true);
  assert.equal(atLeast('4.0.0', '3.99.99'), true);
});

for (const [name, floor] of Object.entries(FLOORS)) {
  test(`${name} is locked at ${floor} or later (the versions with the known advisories fixed)`, () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const locked = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(locked, `${name} is in package-lock.json`);
    assert.ok(atLeast(locked, floor), `package-lock.json locks ${name} ${locked}; run \`npm update ${name}\` (needs ${floor} or later)`);
    const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    assert.ok(atLeast(installed, floor), `installed ${name} is ${installed}; run \`npm ci\``);
  });
}

// ---------------------------------------------------------------------------
// The front end's Markdown renderer, in a browser: attacker-shaped Markdown
// (a model's reply can quote anything) must come out inert. The element is in
// the live document while it is drawn, so a surviving handler would really run
// and bump window.__pwned.
const skip = skipReason();
let hub;
let b;
before(async () => {
  if (skip) return;
  hub = await startHub([]);
  b = await launchBrowser();
  await b.goto(hub.url);
});
after(async () => {
  await b?.close();
  hub?.stop();
});

const ATTACKS = [
  '<script>window.__pwned++</script>',
  '<img src="x" onerror="window.__pwned++">',
  '<svg onload="window.__pwned++"></svg>',
  '<a href="javascript:window.__pwned++">raw html link</a>',
  '[markdown link](javascript:window.__pwned++)',
  '<iframe src="javascript:window.__pwned++"></iframe>',
  '<details open ontoggle="window.__pwned++">d</details>',
  '<math><mi xlink:href="javascript:window.__pwned++">x</mi></math>',
  '<div style="x" onclick="window.__pwned++" id="victim">click me</div>',
].join('\n\n');

test('the renderer strips <script>, event-handler attributes and javascript: links from Markdown', { skip }, async () => {
  const r = await b.eval(`(async () => {
    window.__pwned = 0;
    const { markdownInto } = await import('/js/markdown.js');
    const el = document.createElement('div');
    document.body.append(el);
    markdownInto(el, ${JSON.stringify(ATTACKS)});
    // Let image loads fail and any handler that survived run.
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('victim')?.click();
    const all = [...el.querySelectorAll('*')];
    return {
      pwned: window.__pwned,
      html: el.innerHTML,
      scripts: el.querySelectorAll('script, iframe').length,
      handlers: all.flatMap((n) => [...n.attributes].filter((a) => /^on/i.test(a.name)).map((a) => n.tagName + '.' + a.name)),
      jsLinks: all.flatMap((n) => [...n.attributes].filter((a) => /^\\s*javascript:/i.test(a.value)).map((a) => n.tagName + '.' + a.name)),
      text: el.innerText,
    };
  })()`);
  assert.equal(r.pwned, 0, `no injected script ran; output: ${r.html}`);
  assert.equal(r.scripts, 0, `no <script> or <iframe> survived: ${r.html}`);
  assert.deepEqual(r.handlers, [], `no on* attribute survived: ${r.html}`);
  assert.deepEqual(r.jsLinks, [], `no javascript: URL survived: ${r.html}`);
  // Stripping must not eat the harmless text around the attack.
  assert.match(r.text, /markdown link/, 'the link text is kept');
  assert.match(r.text, /click me/, 'the element text is kept');
});

test('ordinary Markdown still renders (links open safely in a new tab, code blocks keep their copy button)', { skip }, async () => {
  const r = await b.eval(`(async () => {
    const { markdownInto } = await import('/js/markdown.js');
    const el = document.createElement('div');
    document.body.append(el);
    markdownInto(el, '# Title\\n\\n[home](https://example.com/a?b=1)\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n');
    const a = el.querySelector('a[href]');
    return { h1: el.querySelector('h1')?.textContent, href: a?.getAttribute('href'), target: a?.target, rel: a?.rel, copy: Boolean(el.querySelector('pre .code-copy')) };
  })()`);
  assert.deepEqual(r, { h1: 'Title', href: 'https://example.com/a?b=1', target: '_blank', rel: 'noopener', copy: true });
});
