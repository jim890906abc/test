// A reply that is being written: drawn a block at a time, never different from the
// whole reply drawn at once, and the view follows it only while you are at the
// end — scroll up and it stays where you put it.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { startWindowingProxy } from './fixtures/windowing-proxy.mjs';
import { synthSession, synthMarkdown } from './fixtures/synth-conversation.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
let proxy;
let b;

before(async () => {
  if (skip) return;
  hub = await startHub([synthSession({ id: 's_chat', title: '串流', count: 400, seed: 21 })]);
  proxy = await startWindowingProxy({ target: hub.url, size: 150 });
  await proxy.warm('s_chat');
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  await proxy?.close();
  hub?.stop();
});

// Markdown the way models write it, and the awkward corners: a list that gets
// another item after a blank line, a table, raw HTML left open across blocks,
// an unfinished code fence, setext headings, quotes, reference links, CJK.
const HAND = {
  lists: '# Plan\n\n1. first\n2. second\n\n   continued paragraph of second\n\n3. third\n\n- a\n  - nested\n    - deeper\n- b\n\nAfter the list.\n\n> quote line one\n> quote line two\n\n> another\n\nText\n===\n\nSub\n---\n\nend',
  tables: 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter table\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\n    indented code\n\nlast <b>html</b> inline\n\n<div>block html\n\nstill block</div>\n\nfinal paragraph with `code` and **bold** and [link](http://a.b).',
  loose: '- one\n\n- two\n\n- three\n\nparagraph\n\n- tight a\n- tight b\n\n1) paren list\n2) second\n\n---\n\n***bold italic*** text\n\n~~strike~~ done',
  refs: 'See [the docs][d] and more text.\n\nMore.\n\n[d]: https://example.com',
  details: 'Before\n\n<details>\n<summary>more</summary>\n\nhidden **text** here\n\n- item\n\n</details>\n\nAfter',
  cjk: '## 結果\n\n- 第一項：已經完成\n- 第二項：**進行中**\n\n```\n未結束的程式碼區塊\n\n仍在區塊內\n',
};

// Seeded pieces glued together in random order, for the same check at scale.
function fuzzDocs(n, seed = 3) {
  let a = seed;
  const r = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const piece = [
    () => `# Heading ${Math.floor(r() * 9)}`,
    () => `## ${'word '.repeat(2 + Math.floor(r() * 3))}`,
    () => `${'plain text '.repeat(2 + Math.floor(r() * 6))}with \`code\` and **bold**.`,
    () => `- ${'item '.repeat(2)}\n- second item\n${r() < 0.5 ? '  - nested\n' : ''}- third`,
    () => `1. one\n2. two\n\n   para in two\n\n3. three`,
    () => `> quoted ${'line '.repeat(3)}\n> more quote`,
    () => `\`\`\`js\nconst a = ${Math.floor(r() * 99)};\n\nconst b = a + 1;\n\`\`\``,
    () => `| h1 | h2 |\n|----|----|\n| a | b |\n| c | d |`,
    () => '---',
    () => `Setext ${Math.floor(r() * 9)}\n${r() < 0.5 ? '===' : '---'}`,
    () => `<b>x</b> and a <span>${'y'.repeat(3)}</span> inline`,
    () => `    indented code ${Math.floor(r() * 9)}`,
    () => `![img](http://x/y.png) and [a link](http://a.b/${Math.floor(r() * 9)})`,
  ];
  return Array.from({ length: n }, () => Array.from({ length: 3 + Math.floor(r() * 7) }, () => piece[Math.floor(r() * piece.length)]()).join(r() < 0.8 ? '\n\n' : '\n'));
}

test('drawing a reply a block at a time gives, at every point of the way, what drawing it whole gives', { skip }, async () => {
  await b.goto(proxy.url, 400);
  await b.waitFor(`document.querySelector('.sidebar')`);
  const docs = { ...HAND, synth: synthMarkdown(6000, 4) };
  fuzzDocs(40).forEach((d, i) => (docs[`fuzz${i}`] = d));
  const res = await b.eval(`(async () => {
    const { MarkdownStream, markdownInto } = await import('/js/markdown.js');
    const out = {};
    for (const [name, doc] of Object.entries(${JSON.stringify(docs)})) {
      const el = document.createElement('div');
      const stream = new MarkdownStream(el);
      const step = doc.length > 500 ? 11 : 1;
      let bad = null;
      let steps = 0;
      for (let n = 1; n <= doc.length && !bad; n += step) {
        const prefix = doc.slice(0, n);
        stream.update(prefix);
        const ref = document.createElement('div');
        markdownInto(ref, prefix);
        steps++;
        if (el.innerHTML !== ref.innerHTML) bad = { n, tail: prefix.slice(-60), got: el.innerHTML.slice(-160), want: ref.innerHTML.slice(-160) };
      }
      out[name] = { steps, bad };
    }
    return out;
  })()`);
  const bad = Object.entries(res).filter(([, v]) => v.bad);
  assert.deepEqual(bad.map(([k, v]) => [k, v.bad]), [], 'no document differs from the whole at any prefix');
  assert.ok(Object.values(res).reduce((n, v) => n + v.steps, 0) > 3000, 'and a good many prefixes were compared');
});

test('only the last block of a long reply is drawn again as it grows', { skip }, async () => {
  await b.goto(proxy.url, 400);
  const r = await b.eval(`(async () => {
    const { MarkdownStream } = await import('/js/markdown.js');
    const el = document.createElement('div');
    const stream = new MarkdownStream(el);
    const para = (i) => 'Paragraph number ' + i + ' of the reply, with some words to fill it.';
    let text = '';
    for (let i = 0; i < 40; i++) text += para(i) + '\\n\\n';
    stream.update(text + 'Last para');
    const first = el.children[0];
    const middle = el.children[20];
    stream.update(text + 'Last paragraph, longer now');
    return { sameFirst: el.children[0] === first, sameMiddle: el.children[20] === middle, count: el.children.length, last: el.lastElementChild.textContent };
  })()`);
  assert.equal(r.sameFirst && r.sameMiddle, true, 'blocks already final are the same DOM nodes (not drawn again)');
  assert.equal(r.count, 41);
  assert.equal(r.last, 'Last paragraph, longer now');
});

async function openChat() {
  await b.goto(`${proxy.url}#/s/s_chat`, 300);
  await b.waitFor(`document.querySelector('.transcript .column > .ev')?.textContent.trim()`, { timeout: 15000 });
  await sleep(700);
}
const fromEnd = () => b.eval(`(() => { const t = document.querySelector('.transcript'); return Math.round(t.scrollHeight - t.scrollTop - t.clientHeight); })()`);

test('while you are at the end the view follows a reply as it is written', { skip }, async () => {
  await openChat();
  const live = proxy.live('s_chat');
  live.status('running');
  live.event({ id: 'follow1', type: 'text', agentId: 'main', text: '' });
  const text = synthMarkdown(6000, 8);
  for (let i = 0; i < text.length; i += 200) {
    live.delta('follow1', 'text', text.slice(i, i + 200));
    await sleep(25);
  }
  await sleep(400);
  assert.ok((await fromEnd()) <= 40, `the end of the reply is in view (${await fromEnd()}px from the end)`);
  live.status('idle');
});

test('once you scroll up, the reply being written does not pull the view back down', { skip }, async () => {
  await openChat();
  const live = proxy.live('s_chat');
  live.status('running');
  live.event({ id: 'follow2', type: 'text', agentId: 'main', text: '' });
  const text = synthMarkdown(9000, 9);
  let i = 0;
  const feed = async (count) => {
    for (let k = 0; k < count && i < text.length; k++, i += 150) {
      live.delta('follow2', 'text', text.slice(i, i + 150));
      await sleep(25);
    }
  };
  await feed(15);
  // a real wheel turn up, over the conversation
  const at = await b.eval(`(() => { const r = document.querySelector('.transcript').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -400 });
  await sleep(200);
  const spot = await b.eval(`document.querySelector('.transcript').scrollTop`);
  const rowTop = await b.eval(`(() => { const t = document.querySelector('.transcript'); const e = [...t.querySelectorAll('.column > .ev')].find((x) => x.getBoundingClientRect().bottom > t.getBoundingClientRect().top + 5); return { id: e?.dataset.id, y: Math.round(e.getBoundingClientRect().top - t.getBoundingClientRect().top) }; })()`);
  await feed(40); // a second of text, and more
  await sleep(300);
  const moved = await b.eval(`(() => { const t = document.querySelector('.transcript'); const e = t.querySelector('[data-id="${rowTop.id}"]'); return e ? Math.round(e.getBoundingClientRect().top - t.getBoundingClientRect().top) : null; })()`);
  assert.ok(moved !== null && Math.abs(moved - rowTop.y) <= 3, `what was on screen stayed (was ${rowTop.y}px, now ${moved}px; scrollTop ${spot})`);
  assert.ok((await fromEnd()) > 300, 'and the view is well away from the end');
  assert.equal(await b.eval(`!document.querySelector('.jump-bar').hidden`), true, 'with the way back to the newest message offered');
  // back to the end by that button: following again
  await b.click('.jump-end');
  await feed(10);
  await sleep(300);
  assert.ok((await fromEnd()) <= 40, 'back at the end it follows again');
  live.status('idle');
});

test('a reply that is finished is not parsed and drawn again each time the conversation starts or stops working', { skip }, async () => {
  await openChat();
  const live = proxy.live('s_chat');
  // a long finished reply, then the newest rows are marked again by each change of status
  live.event({ id: 'done_reply', type: 'text', agentId: 'main', text: synthMarkdown(20000, 12) });
  await b.waitFor(`document.querySelector('[data-id="done_reply"] .md')?.childElementCount > 10`, { timeout: 8000 });
  await sleep(300);
  await b.eval(`(() => { const md = document.querySelector('[data-id="done_reply"] .md'); window.__first = md.firstElementChild; window.__muts = 0; new MutationObserver((l) => (window.__muts += l.length)).observe(md, { childList: true, subtree: true }); })()`);
  for (const status of ['running', 'idle', 'running', 'idle']) {
    live.status(status);
    await sleep(250);
  }
  assert.equal(await b.eval('window.__muts'), 0, 'its text was not touched by four changes of status');
  assert.equal(await b.eval(`document.querySelector('[data-id="done_reply"] .md').firstElementChild === window.__first`), true, 'the same nodes are still there');
});
