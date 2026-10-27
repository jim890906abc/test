// Narrow places in the real browser: the row of chips under the message box
// (permission, model, thinking, subagent...) and the one-line header of a
// subagent card must never cut a word off at the edge.
//
// Three things were seen on screen (README screenshots, 2026-10):
//   1. With the sidebar and a panel open, the chat column is only ~300-450px
//      wide. The chip row scrolled sideways with its scrollbar hidden, so the
//      last chip ("子代理 ...") was cut mid-letter and nothing said there was more.
//   2. On a phone, a subagent card's model text ("DeepSeek · DeepSeek V4.1 Flash ·
//      思考 high") and its "與要求不同" tag ran past the card's right edge.
//   3. The provider was said twice: "DeepSeek · DeepSeek V4.1 Flash".
//
// What is asserted is geometry measured in Chromium: every chip lies completely
// inside the row that holds it, whatever the width, look and content; a text
// that is shortened with an ellipsis says its full words in the chip's title;
// a card's header stays inside the card and its mismatch tag can be seen and hit.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { seedSession, skipReason, uiSession } from './browser-harness.mjs';
import { fixtureSessions, DS_FLASH, SUB_DEFAULT } from './ui-fixtures.mjs';

const skip = skipReason();
const OUT = process.env.UI_NARROW_OUT || '';
const LOOKS = [
  { name: 'kimi-light', look: 'kimi', theme: 'light' },
  { name: 'kimi-dark', look: 'kimi', theme: 'dark' },
  { name: 'claude', look: 'claude', theme: 'light' },
  { name: 'deepseek', look: 'deepseek', theme: 'light' },
];
// Chat column widths the chips are tried in: a phone, the chat column beside the
// sidebar and a panel (~443px), and wider ones up to a desktop's.
const WIDTHS = [300, 360, 390, 443, 600, 800, 1280];

// ------------------------------------------------------------ the fixtures

const K3 = 'kimi-code/k3.1-pro';
const now = Date.now();
const step = (id, parent, n) => ({ id, ts: now - 6000 + n, type: 'tool_use', agentId: 'a1', parent, name: 'Read', status: 'done', input: { path: `src/f${n}.js` }, output: 'x' });
// Subagent cards whose header has the most to say: a model that ran on another
// effort than requested (the mismatch tag), steps, "背景", a long name and a long task.
function narrowSession() {
  return seedSession({
    id: 's_narrow',
    title: 'Narrow cards',
    agentId: 'kimi@m1',
    machineId: 'm1',
    kimiSessionId: 'k1',
    provider: 'kimi',
    cwd: '/tmp/x',
    meta: { model: 'kimi-k2', machineName: 'box', subagent: SUB_DEFAULT },
    events: [
      { id: 'u1', ts: now - 9000, type: 'user', text: 'go' },
      {
        id: 'n1',
        ts: now - 8000,
        type: 'tool_use',
        agentId: 'main',
        name: 'Agent',
        status: 'done',
        title: '檢查訂單表的索引',
        subagent: { id: 'a1', name: 'explore', description: '檢查訂單表的索引', status: 'done', background: true, requested: SUB_DEFAULT, actual: { provider: 'deepseek', model: DS_FLASH, effort: 'high' }, summary: '完成' },
      },
      step('n1s1', 'n1', 1),
      step('n1s2', 'n1', 2),
      step('n1s3', 'n1', 3),
      {
        id: 'n2',
        ts: now - 7000,
        type: 'tool_use',
        agentId: 'main',
        name: 'Agent',
        status: 'done',
        title: 'unconfirmed',
        subagent: { id: 'a2', name: 'general-purpose-reviewer', description: '把所有訂單相關的資料表、索引、外鍵與觸發器逐一檢查一遍，再列出每一項的風險與建議的修法', status: 'done', requested: SUB_DEFAULT, actual: null, unverifiedReason: '這台電腦的 Kimi 沒有回報子代理實際用的模型', summary: '完成' },
      },
      {
        id: 'n3',
        ts: now - 6500,
        type: 'tool_use',
        agentId: 'main',
        name: 'Agent',
        status: 'done',
        title: 'claude',
        subagent: { id: 'a3', name: 'writer', description: '寫測試', status: 'done', requested: SUB_DEFAULT, actual: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' }, summary: '完成' },
      },
    ],
  });
}

let ui;
let b;
before(async () => {
  if (skip) return;
  ui = await uiSession([...fixtureSessions(), narrowSession()]);
  b = ui.b;
});
after(() => ui?.stop());

const setLook = async ({ look, theme }) => {
  await b.goto(ui.hub.url + '#/', 200);
  await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(look)}); localStorage.setItem('hubTheme', ${JSON.stringify(theme)})`);
};
const shot = async (name) => {
  if (OUT) await b.shot(path.join(OUT, `${name}.png`));
};

// ------------------------------------------------------ chips: the geometry

// What to hand a Composer to put every kind of chip on the row. JSON only:
// the page builds the callbacks.
const DS_MODELS = [
  { id: DS_FLASH, name: 'DeepSeek V4.1 Flash', provider: 'deepseek', efforts: ['low', 'high', 'max'], defaultEffort: 'max', available: true },
  { id: 'agent-hub-deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', efforts: ['low', 'high', 'max'], defaultEffort: 'max', available: true },
];
const CLAUDE_MODELS = [{ id: 'claude-opus-5', name: 'Claude Opus 5.5', provider: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', available: true }];
const STATES = {
  // A DeepSeek conversation with the full default subagent: the widest everyday row.
  'deepseek, full subagent': { agent: 'deepseek', provider: 'deepseek', models: DS_MODELS, model: DS_FLASH, effort: 'max', permission: 'manual', subagentMode: 'custom', subagent: SUB_DEFAULT, machineName: '' },
  // The native Kimi runs another model than the chosen one: two more chips, both long.
  'drift to Kimi, running': {
    agent: 'deepseek',
    provider: 'deepseek',
    models: DS_MODELS,
    model: DS_FLASH,
    effort: 'max',
    permission: 'manual',
    running: true,
    turnProvider: 'deepseek',
    turnModel: DS_FLASH,
    subagentMode: 'custom',
    subagent: SUB_DEFAULT,
    drift: { kind: 'provider', expected: { provider: 'deepseek', model: DS_FLASH, effort: 'max' }, actual: { provider: 'kimi', model: K3, effort: 'max' }, since: now },
  },
  // Claude: the model Anthropic says answered is one more chip.
  'claude, served model': {
    agent: 'claude',
    provider: 'claude',
    models: CLAUDE_MODELS,
    model: 'claude-opus-5',
    effort: 'xhigh',
    permission: 'edits',
    servedModel: { id: 'claude-opus-5-20261001', name: 'Claude Opus 5.5 (2026-10-01)', asked: 'claude-opus-5', at: now },
    subagentMode: 'custom',
    subagent: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
  },
  // Context nearly full: the hint beside the send button is as wide as a sentence,
  // and takes the chips' room unless the button and the hint go under them.
  'kimi, context hint beside the send button': {
    agent: 'kimi',
    provider: 'kimi',
    models: [{ id: K3, name: 'Kimi K3.1 Pro', provider: 'kimi', efforts: ['low', 'high'], defaultEffort: 'high', available: true }],
    model: K3,
    effort: 'high',
    permission: 'yolo',
    context: { used: 85000, size: 100000 },
    ctxHint: { band: 80, percent: 85, text: '上下文已用 85%，接近自動壓縮；回應會變慢，可用 /compact 或開新對話' },
    subagentMode: 'follow',
    subagent: null,
  },
  // The home: a computer and a folder with long names come first.
  'home, long computer and folder names': {
    home: true,
    agent: 'deepseek',
    provider: 'deepseek',
    models: DS_MODELS,
    model: DS_FLASH,
    effort: 'max',
    permission: 'manual',
    machineName: '開發機器-工作站-辦公室-很長很長的名字-01',
    folderName: 'projects/shop-api/services/orders-gateway/src/very/deep/folder',
    subagentMode: 'custom',
    subagent: SUB_DEFAULT,
  },
};

// Put a Composer in a box `width` wide (the chat column), fill it, measure
// every chip against the row that holds it, take the box away again.
// Chips on one row differ by a pixel or two in `top` (their heights differ); a new row starts well below.
const ROWS_JS = `const rowsOf = (chips) => { let rows = 0, last = -1e9; for (const x of [...chips].sort((a, b) => a.top - b.top)) { if (x.top > last + 10) { rows++; last = x.top; } } return rows; };`;
const measureChips = (width, state) => `(async () => {
  ${ROWS_JS}
  const { Composer } = await import('/js/composer.js');
  const spec = ${JSON.stringify(state)};
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:0;top:0;width:${width}px;background:var(--window);z-index:99999';
  document.body.append(wrap);
  const noop = () => {};
  const c = new Composer({ home: spec.home, agent: spec.agent, onOpenSubagent: noop, onCommand: noop, onConfig: noop, onRestoreModel: noop, onPickMachine: spec.home ? noop : undefined, onPickFolder: spec.home ? noop : undefined });
  wrap.append(c.el);
  c.update({ models: [], providers: [], ...spec });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tools = c.el.querySelector('.composer-tools');
  const box = c.el.querySelector('.composer-box');
  const tr = tools.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const chips = [...tools.children].map((e) => {
    const r = e.getBoundingClientRect();
    const spans = [...e.querySelectorAll(':scope > span')];
    const cut = spans.filter((s) => s.scrollWidth > s.clientWidth + 1);
    return {
      control: e.dataset.control || e.className,
      text: e.innerText.replace(/\\s+/g, ' ').trim(),
      title: e.title || '',
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
      cut: cut.map((s) => s.textContent.trim()),
      cutHasEllipsis: cut.every((s) => getComputedStyle(s).textOverflow === 'ellipsis'),
    };
  });
  const ar = c.el.querySelector('.composer-actions').getBoundingClientRect();
  const out = {
    actions: { left: ar.left, right: ar.right },
    tools: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom, scrollWidth: tools.scrollWidth, clientWidth: tools.clientWidth, overflowX: getComputedStyle(tools).overflowX },
    box: { left: br.left, right: br.right },
    rows: rowsOf(chips),
    chips,
    pageScroll: document.documentElement.scrollWidth - innerWidth,
  };
  wrap.remove();
  return out;
})()`;

// The rule every chip row must keep, in any width and look.
function assertRowIntact(cell, m, { singleRow = false } = {}) {
  assert.ok(m.chips.length >= 3, `${cell}: the row has chips`);
  for (const x of m.chips) {
    assert.ok(x.left >= m.tools.left - 0.5, `${cell}: "${x.text}" starts inside the row (${Math.round(x.left)} < ${Math.round(m.tools.left)})`);
    assert.ok(x.right <= m.tools.right + 0.5, `${cell}: "${x.text}" ends inside the row (${Math.round(x.right)} > ${Math.round(m.tools.right)}), no word is cut at the edge`);
    assert.ok(x.right <= m.box.right + 0.5, `${cell}: "${x.text}" is inside the message box`);
    assert.ok(x.width > 20, `${cell}: "${x.text}" keeps a width`);
    // A text shortened with an ellipsis says its full words where a pointer or a
    // screen reader can find them.
    for (const full of x.cut) {
      assert.ok(x.cutHasEllipsis, `${cell}: "${x.text}" is shortened with an ellipsis, not cut`);
      assert.ok(x.title.includes(full), `${cell}: the chip shortened to "${x.text}" carries the full "${full}" in its title (${JSON.stringify(x.title)})`);
    }
  }
  if (m.actions) assert.ok(m.actions.left >= m.box.left - 0.5 && m.actions.right <= m.box.right + 0.5, `${cell}: the send button and what sits by it are inside the message box`);
  assert.ok(m.tools.scrollWidth <= m.tools.clientWidth + 1, `${cell}: nothing of the row hides behind a sideways scroll (${m.tools.scrollWidth} > ${m.tools.clientWidth})`);
  assert.ok(m.pageScroll <= 0, `${cell}: the page does not scroll sideways`);
  if (singleRow) assert.equal(m.rows, 1, `${cell}: when it fits it stays one row`);
}

for (const L of LOOKS) {
  test(`${L.name}: every chip under the message box lies inside its row in a ${WIDTHS.join('/')}px chat column, whatever it says`, { skip }, async () => {
    await setLook(L);
    await ui.openApp('#/');
    await b.sleep(300);
    const seen = [];
    for (const [name, state] of Object.entries(STATES)) {
      for (const w of WIDTHS) {
        const m = await b.eval(measureChips(w, state));
        const cell = `${L.name} / ${name} / ${w}px`;
        // At a desktop's width the everyday row is one row, as it always was.
        // (the pill-shaped chips of the DeepSeek look are wider and need a second row for this one)
        assertRowIntact(cell, m, { singleRow: w >= 1280 && name === 'deepseek, full subagent' && L.look !== 'deepseek' });
        seen.push(`${name} ${w}px: ${m.rows} row${m.rows > 1 ? 's' : ''}`);
      }
    }
    if (process.env.UI_NARROW_VERBOSE) console.log(`# ${L.name}\n#   ${seen.join('\n#   ')}`);
  });
}

// ------------------------------------------- chips: in the app, side by side

// Viewport widths, whether the panel is open, and so the chat column the
// composer really gets (the sidebar takes 248px, the panel up to a third).
const APP_CELLS = [
  { vw: 1280, panel: false },
  { vw: 1280, panel: true },
  { vw: 1000, panel: true },
  { vw: 900, panel: true },
  { vw: 800, panel: true },
  { vw: 390, panel: false },
  { vw: 360, panel: false },
];
for (const L of LOOKS) {
  test(`${L.name}: in the app, with and without the sidebar and the panel, the chips of a DeepSeek and a Claude conversation are whole`, { skip }, async () => {
    await setLook(L);
    for (const sid of ['s_ds', 's_claude']) {
      for (const cell of APP_CELLS) {
        await ui.openApp(`#/s/${sid}`, { viewport: [cell.vw, 900] });
        await b.waitFor(`document.querySelector('[data-control="subagent"]')`);
        if (cell.panel) {
          await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
          await b.waitFor(`document.querySelector('.app.with-panel')`);
          await b.sleep(450); // the panel slides in
        }
        // models (and so the model chip) arrive a moment after the page
        await b.waitFor(`document.querySelector('[data-control="model"]')`).catch(() => {});
        const m = await b.eval(`(() => {
          const tools = document.querySelector('.composer-tools');
          const tr = tools.getBoundingClientRect();
          const box = document.querySelector('.composer-box').getBoundingClientRect();
          return {
            tools: { left: tr.left, right: tr.right, scrollWidth: tools.scrollWidth, clientWidth: tools.clientWidth },
            box: { left: box.left, right: box.right },
            column: Math.round(box.width),
            pageScroll: document.documentElement.scrollWidth - innerWidth,
            chips: [...tools.children].map((e) => {
              const r = e.getBoundingClientRect();
              const cut = [...e.querySelectorAll(':scope > span')].filter((s) => s.scrollWidth > s.clientWidth + 1);
              return { text: e.innerText.replace(/\\s+/g, ' ').trim(), title: e.title || '', left: r.left, right: r.right, top: r.top, width: r.width, cut: cut.map((s) => s.textContent.trim()), cutHasEllipsis: cut.every((s) => getComputedStyle(s).textOverflow === 'ellipsis') };
            }),
          };
        })()`);
        m.rows = await b.eval(`(() => { ${ROWS_JS} return rowsOf(${JSON.stringify(m.chips.map((x) => ({ top: x.top })))}); })()`);
        const label = `${L.name} / ${sid} / viewport ${cell.vw}${cell.panel ? ' + panel' : ''} (column ${m.column}px)`;
        assertRowIntact(label, m);
        assert.ok(m.box.right <= cell.vw + 0.5, `${label}: the message box is on screen`);
        await shot(`chips_${L.name}_${sid}_${cell.vw}${cell.panel ? '_panel' : ''}`);
      }
    }
    await b.size(1280, 900);
  });
}

// ---------------------------------------------- subagent cards: the header

// What of one card's header can be seen.
const measureCards = `(() => {
  const col = document.querySelector('.transcript');
  return {
    pageScroll: document.documentElement.scrollWidth - innerWidth,
    transcriptScroll: col.scrollWidth - col.clientWidth,
    cards: [...document.querySelectorAll('.tool.agent')].map((card) => {
      card.scrollIntoView({ block: 'center' }); // (what is scrolled out of the window cannot be pointed at)
      const cr = card.getBoundingClientRect();
      const row = card.querySelector('.tool-row');
      const inside = (e) => { const r = e.getBoundingClientRect(); return r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5; };
      // (a box with display: contents has no rectangle of its own: what it holds is what is seen)
      const parts = (el) => [...el.children].flatMap((e) => (getComputedStyle(e).display === 'contents' ? parts(e) : [e]));
      const visible = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.height > 0 && !!hit && (hit === e || e.contains(hit) || hit.contains(e)); };
      const model = card.querySelector('.subagent-model');
      const tag = card.querySelector('.subagent-mismatch');
      const chev = card.querySelector('.chev');
      return {
        title: card.querySelector('.tool-verb')?.innerText + ' | ' + (card.querySelector('.tool-target')?.innerText || ''),
        width: Math.round(cr.width),
        rowOverflow: row.scrollWidth - row.clientWidth,
        outside: parts(row).filter((e) => !inside(e)).map((e) => String(e.className.baseVal ?? e.className)),
        model: model ? { text: model.innerText, title: model.title, inside: inside(model), clipped: model.scrollWidth > model.clientWidth + 1, visible: visible(model) } : null,
        tag: tag ? { text: tag.innerText, inside: inside(tag), visible: visible(tag), clipped: tag.scrollWidth > tag.clientWidth + 1 } : null,
        chev: chev ? { inside: inside(chev), visible: visible(chev) } : null,
      };
    }),
  };
})()`;

const CARD_CELLS = [
  { vw: 360, panel: false },
  { vw: 390, panel: false },
  { vw: 800, panel: true },
  { vw: 1000, panel: true },
  { vw: 1280, panel: false },
];
for (const L of LOOKS) {
  test(`${L.name}: a subagent card's header stays inside the card, and the model and the "與要求不同" tag can be read, at 360px, 390px and beside a panel`, { skip }, async () => {
    await setLook(L);
    for (const cell of CARD_CELLS) {
      await ui.openApp('#/s/s_narrow', { viewport: [cell.vw, 900] });
      await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 3`);
      if (cell.panel) {
        await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
        await b.waitFor(`document.querySelector('.app.with-panel')`);
        await b.sleep(450);
      }
      // the names come from the catalog, a moment after the page
      await b.waitFor(`[...document.querySelectorAll('.tool.agent .subagent-model')].some((m) => m.innerText.includes('DeepSeek V4.1 Flash'))`);
      const m = await b.eval(measureCards);
      const label = `${L.name} / viewport ${cell.vw}${cell.panel ? ' + panel' : ''}`;
      assert.equal(m.cards.length, 3, `${label}: three cards`);
      assert.ok(m.pageScroll <= 0, `${label}: the page does not scroll sideways`);
      assert.ok(m.transcriptScroll <= 0, `${label}: the conversation does not scroll sideways`);
      for (const c of m.cards) {
        const at = `${label}, card "${c.title}" (${c.width}px)`;
        assert.deepEqual(c.outside, [], `${at}: every part of the header is inside the card`);
        assert.ok(c.rowOverflow <= 1, `${at}: the header does not overflow itself (${c.rowOverflow}px)`);
        assert.ok(c.model.inside && c.model.visible, `${at}: the model text is on the card and nothing covers it (${JSON.stringify(c.model)})`);
        assert.ok(c.chev.inside && c.chev.visible, `${at}: the open/close arrow is on the card (${JSON.stringify(c.chev)})`);
        // The model text is either whole or shortened with its full words in the title.
        if (c.model.clipped) assert.ok(c.model.title.length > c.model.text.length, `${at}: a shortened model text says the rest in its title`);
      }
      const mismatch = m.cards.find((c) => c.tag);
      assert.ok(mismatch, `${label}: the card that ran another effort has its mismatch tag`);
      assert.equal(mismatch.tag.text, '與要求不同');
      assert.ok(mismatch.tag.inside && mismatch.tag.visible && !mismatch.tag.clipped, `${label}: "與要求不同" is whole, on the card and not covered (${JSON.stringify(mismatch.tag)})`);
      // Narrow cards say the whole model line, wrapped rather than shortened.
      if (mismatch.width <= 420) assert.ok(!mismatch.model.clipped, `${label}: on a ${mismatch.width}px card the model line "${mismatch.model.text}" is not shortened`);
      await shot(`cards_${L.name}_${cell.vw}${cell.panel ? '_panel' : ''}`);
    }
    await b.size(1280, 900);
  });
}

test('the 子代理 panel lists the same cards on a phone without anything running past its edge', { skip }, async () => {
  await setLook(LOOKS[0]);
  await ui.openApp('#/s/s_narrow', { viewport: [360, 800] });
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 3`);
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
  await b.waitFor(`[...document.querySelectorAll('.om-seg__item')].some((x) => x.textContent.startsWith('子代理'))`);
  await b.eval(`[...document.querySelectorAll('.om-seg__item')].find((x) => x.textContent.startsWith('子代理'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.agent-item').length >= 3`);
  await b.waitFor(`[...document.querySelectorAll('.agent-item')].some((i) => i.innerText.includes('DeepSeek V4.1 Flash'))`);
  // The panel slides in from the right: measure where it comes to rest, not on its way.
  await b.waitFor(`document.getAnimations().every((a) => a.playState !== 'running')`);
  const items = await b.eval(`[...document.querySelectorAll('.agent-item')].map((i) => {
    const r = i.getBoundingClientRect();
    return { text: i.innerText.replace(/\\s+/g, ' '), overflow: i.scrollWidth - i.clientWidth, right: r.right, outside: [...i.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > r.right + 0.5 && e.getBoundingClientRect().width > 0).map((e) => String(e.className.baseVal ?? e.className)) };
  })`);
  for (const i of items) {
    assert.ok(i.overflow <= 1 && i.right <= 360.5, `the panel row "${i.text}" fits the phone (overflow ${i.overflow}px, right ${i.right})`);
    assert.deepEqual(i.outside, [], `nothing of "${i.text}" runs past the row`);
  }
  await b.size(1280, 900);
});

// --------------------------------------------- the provider is said once

// "DeepSeek · DeepSeek", "Kimi · Kimi", "Claude · Claude" (any case, any of the
// separators the page uses) anywhere a person reads or hovers.
const TWICE = /\b(DeepSeek|Kimi|Claude)\s*[·・／/]\s*\1\b/i;
test('no screen, menu or tooltip says a provider twice ("DeepSeek · DeepSeek V4.1 Flash")', { skip }, async () => {
  const everything = `(() => {
    const out = [document.body.innerText];
    for (const e of document.querySelectorAll('[title],[aria-label]')) out.push(e.getAttribute('title') || '', e.getAttribute('aria-label') || '');
    for (const o of document.querySelectorAll('option')) out.push(o.textContent);
    return out.join('\\n');
  })()`;
  await setLook(LOOKS[0]);
  const seen = [];
  for (const hash of ['#/', '#/s/s_ds', '#/s/s_kimi', '#/s/s_claude', '#/s/s_narrow']) {
    await ui.openApp(hash);
    await b.waitFor(`document.querySelector('.composer')`);
    await b.sleep(500);
    seen.push([hash, await b.eval(everything)]);
  }
  // the 子代理 panel and the subagent dialog of a conversation with cards
  await ui.openApp('#/s/s_narrow');
  await b.waitFor(`document.querySelectorAll('.tool.agent').length >= 3`);
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('面板'))?.click()`);
  await b.waitFor(`[...document.querySelectorAll('.om-seg__item')].some((x) => x.textContent.startsWith('子代理'))`);
  await b.eval(`[...document.querySelectorAll('.om-seg__item')].find((x) => x.textContent.startsWith('子代理'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.agent-item').length >= 3`);
  seen.push(['子代理 panel', await b.eval(everything)]);
  await b.click('[data-control="subagent"]');
  await b.waitFor(`document.querySelector('.subagent-settings')`);
  seen.push(['subagent dialog', await b.eval(everything)]);
  await b.eval(`document.querySelector('.dialog-actions button[type="button"]')?.click()`);
  for (const [where, text] of seen) assert.doesNotMatch(text, TWICE, `${where}: a provider is said twice`);
  // ...and the single form is what is there
  assert.match(seen.find(([w]) => w === '#/s/s_ds')[1], /DeepSeek V4\.1 Flash/);
  assert.match(seen.find(([w]) => w === '子代理 panel')[1], /DeepSeek V4\.1 Flash · 思考 high/);
  assert.match(seen.find(([w]) => w === 'subagent dialog')[1], /子代理一律是 DeepSeek V4\.1 Flash · 思考 max/);
});

test('none of this leaves errors in the page', { skip }, async () => {
  const errors = b.logs.filter((l) => /^EXC|^error:/.test(l) && !/Failed to load resource/.test(l));
  assert.deepEqual(errors, []);
});
