// Two things a person looked at and called ugly, measured in a real browser
// (a real Hub, the real front end, Chromium at a desktop's and a phone's width,
// light and dark):
//
//   1. The row under the message box of a DeepSeek conversation that is in swarm
//      mode and has used 83% of its context. The chips (attach, permission,
//      Swarm, model, thinking, subagent) were laid out one per line, because the
//      row of chips had to share its line with the context notice, the ring and
//      the stop button, and the notice (up to 360px) took what the chips needed.
//      Nothing was wrong with the Swarm chip itself; it was the 93px that pushed
//      the row over the edge. The chips now keep their line, and what sits at
//      the right (notice, ring, button) goes under them, still at the right,
//      when the two do not fit side by side.
//   2. The DeepSeek key list. A key card with many buttons gave the buttons all
//      the room and squeezed the gateway name, the key tail and the state badge
//      into a thin column, so "OpenCode Go" and "…bYtN" broke in the middle of
//      the word. The card is now: one line of facts, the "added" line under it,
//      and the buttons on a line of their own that wraps whole buttons.
//
// Skips, saying why, when there is no Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { seedSession, skipReason, startHub, launchBrowser } from './browser-harness.mjs';
import { DS_FLASH, SUB_DEFAULT } from './ui-fixtures.mjs';

const skip = skipReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const DAY = 86400e3;
const RESET = now + 3 * 3600_000;
let hub;
let gateway;
let b;

before(async () => {
  if (skip) return;
  gateway = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek/deepseek-v4.1-flash' }] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const session = seedSession({
    id: 's_polish',
    title: 'DeepSeek swarm, 83% context',
    agentId: 'kimi@m1',
    machineId: 'm1',
    kimiSessionId: 'kp',
    provider: 'deepseek',
    mode: 'deepseek',
    cwd: '/tmp/y',
    updatedAt: now,
    // Swarm on, 83% of the context used (so the notice shows), approvals not asked.
    meta: { model: DS_FLASH, effort: 'max', permission: 'auto', swarmMode: true, subagent: SUB_DEFAULT, context: { used: 829000, size: 1000000 } },
    events: [
      { id: 'u1', ts: now - 3000, type: 'user', text: 'hi' },
      { id: 't1', ts: now - 2000, type: 'text', agentId: 'main', text: 'hello' },
    ],
  });
  // The same conversation with the subagent following the main model: a short
  // chip, so that the whole row has room on one line in any ordinary font.
  const follow = seedSession({ ...session, id: 's_polish_follow', title: 'DeepSeek swarm, subagent follows', kimiSessionId: 'kf', meta: { ...session.meta, subagent: null }, updatedAt: now - 1000 });
  hub = await startHub([session, follow], {
    env: { AGENT_HUB_DEEPSEEK_TEST_URL: `http://127.0.0.1:${gateway.address().port}` },
    seed: (data) => {
      fs.writeFileSync(
        path.join(data, 'deepseek.json'),
        JSON.stringify({
          gateway: 'opencode-go',
          keys: {
            'opencode-go': {
              revision: 2,
              activeId: 'k_go1',
              keys: [
                { id: 'k_go1', key: 'sk-polish-go-one-SECRETFRAGMENT-AYuo', addedAt: now - 3 * DAY },
                { id: 'k_go2', key: 'sk-polish-go-two-SECRETFRAGMENT-bYtN', addedAt: now - DAY },
                { id: 'k_go3', key: 'sk-polish-go-out-SECRETFRAGMENT-Q7xz', addedAt: now - 2 * DAY, exhaustedAt: now - 1000, retryAt: RESET },
              ],
            },
            commandcode: { revision: 1, activeId: 'k_cc1', keys: [{ id: 'k_cc1', key: 'sk-polish-cc-one-SECRETFRAGMENT-SZM2', addedAt: now - 3 * DAY }] },
          },
          order: ['k_go1', 'k_go2', 'k_cc1', 'k_go3'],
          activity: {},
        }),
        { mode: 0o600 },
      );
    },
  });
  b = await launchBrowser();
});
after(async () => {
  await b?.close();
  hub?.stop();
  gateway?.close();
});

const CELLS = [
  { name: '1280 light', w: 1280, h: 900, theme: 'light', look: 'kimi' },
  { name: '1280 dark', w: 1280, h: 900, theme: 'dark', look: 'kimi' },
  { name: '390 light', w: 390, h: 844, theme: 'light', look: 'kimi' },
  { name: '390 dark', w: 390, h: 844, theme: 'dark', look: 'kimi' },
];

async function openCell(cell, hash) {
  await b.size(cell.w, cell.h, cell.w < 700);
  await b.goto(hub.url + '#/', 300);
  await b.eval(`localStorage.setItem('hubPalette', ${JSON.stringify(cell.look)}); localStorage.setItem('hubTheme', ${JSON.stringify(cell.theme)})`);
  await b.goto(hub.url + hash, 300);
  await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`);
}

// ------------------------------------------------------------ the composer row

const MEASURE_COMPOSER = `(() => {
  const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const tools = document.querySelector('.composer-tools');
  const actions = document.querySelector('.composer-actions');
  const bar = document.querySelector('.composer-bar');
  const hint = document.querySelector('.ctx-hint');
  return {
    box: rect(document.querySelector('.composer-box')),
    bar: rect(bar),
    tools: rect(tools),
    actions: rect(actions),
    hint: hint ? rect(hint) : null,
    send: rect(actions.querySelector('.send')),
    chips: [...tools.children].map((c) => ({ control: c.dataset.control || (c.classList.contains('icon-only') ? 'attach' : c.className), text: c.innerText.trim(), ...rect(c) })),
    pageScroll: document.documentElement.scrollWidth - innerWidth,
  };
})()`;

const rowsOf = (items) => {
  let rows = 0;
  let last = -1e9;
  for (const x of [...items].sort((a, c) => a.top - c.top)) {
    if (x.top > last + 10) {
      rows++;
      last = x.top;
    }
  }
  return rows;
};

// What every desktop cell must keep, whichever conversation: the chips in order,
// whole, evenly spaced, Swarm next to permission and as tall; the notice, ring
// and button at the right and not over a chip.
function assertComposerRow(cell, m, { tag }) {
  const at = `${cell.name} ${tag}`;
  assert.deepEqual(m.chips.map((c) => c.control), ['attach', 'permission', 'swarm', 'model', 'effort', 'subagent'], `${at}: the chips, in order: ${JSON.stringify(m.chips.map((c) => [c.control, c.text]))}`);
  for (const c of m.chips) assert.ok(c.height === m.chips[1].height || c.control === 'attach', `${at}: ${c.control} is as tall as the others (${c.height} vs ${m.chips[1].height})`);

  // Swarm is next to permission, as tall, on the same baseline; the gaps between chips on a line are all alike.
  const perm = m.chips[1];
  const swarm = m.chips[2];
  assert.ok(Math.abs(swarm.top - perm.top) < 0.5 && Math.abs(swarm.bottom - perm.bottom) < 0.5, `${at}: Swarm is on the permission chip's line and baseline`);
  const sameLine = m.chips.slice(1).filter((c, i) => Math.abs(c.top - m.chips[i].top) < 0.5);
  const gaps = sameLine.map((c) => c.left - m.chips[m.chips.indexOf(c) - 1].right);
  assert.ok(gaps.length >= 3 && Math.max(...gaps) - Math.min(...gaps) <= 1, `${at}: the space between chips is the same all along: ${JSON.stringify(gaps.map((g) => Math.round(g * 10) / 10))}`);

  // Notice, ring and the button: inside the box, at its right, before the button, not over a chip.
  assert.ok(m.hint, `${at}: the context notice is shown`);
  assert.ok(m.actions.right >= m.bar.right - 2, `${at}: the notice, ring and button end at the box's right edge (${Math.round(m.actions.right)} vs ${Math.round(m.bar.right)})`);
  assert.ok(m.actions.left >= m.box.left && m.actions.right <= m.box.right, `${at}: and are inside the box`);
  assert.ok(m.hint.left >= m.actions.left - 0.5 && m.hint.right <= m.send.left, `${at}: the notice is before the button`);
  const over = m.chips.some((c) => c.right > m.actions.left + 0.5 && c.left < m.actions.right - 0.5 && c.bottom > m.actions.top + 1 && c.top < m.actions.bottom - 1);
  assert.ok(!over, `${at}: the right-hand group is not over a chip`);
  assert.ok(m.pageScroll <= 0, `${at}: no sideways scroll`);
}

const openComposer = async (cell, id) => {
  await openCell(cell, `#/s/${id}`);
  await b.waitFor(`document.querySelector('[data-control="subagent"]') && document.querySelector('[data-control="model"]') && document.querySelector('[data-control="swarm"]') && document.querySelector('.ctx-hint')`);
  await sleep(400);
  return b.eval(MEASURE_COMPOSER);
};

for (const cell of CELLS.filter((c) => c.w >= 1000)) {
  test(`${cell.name}: swarm on and 83% context, the chips stay on ONE line (not one per line) and the notice, ring and stop button stay at the right`, { skip }, async () => {
    const m = await openComposer(cell, 's_polish_follow');
    // The premise: the chips, as wide as they are on their own line, do fit the
    // box, so one line is what a person should get.
    const nat = m.chips.reduce((sum, c) => sum + c.width, 0) + 2 * (m.chips.length - 1);
    const room = m.box.width - 24;
    assert.ok(nat <= room - 40, `premise: the chips need ${Math.round(nat)}px of the ${Math.round(room)}px the box has; change the fixture if a font change broke this`);
    assert.equal(rowsOf(m.chips), 1, `the chips are on one line: tops ${JSON.stringify(m.chips.map((c) => [c.control, Math.round(c.top)]))}`);
    assertComposerRow(cell, m, { tag: 'follow' });
    // none of them is cut for want of room
    assert.deepEqual(await b.eval(`[...document.querySelectorAll('.composer-tools .chip > span')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent.trim())`), [], 'no chip is shortened when there is room for it');
  });

  test(`${cell.name}: with a full subagent chip too (the user's own conversation) the chips are on one line when they fit it, and on whole lines, at most two, when they do not`, { skip }, async () => {
    await openCell(cell, '#/s/s_polish');
    // A narrower sans-serif than the sandbox's default, like the one a person's
    // own system has (the stack in oatmeal.css puts the system fonts first); where
    // it is not installed this is the default font and the row is a little wider
    // than the box, which the second half of the test is for.
    await b.eval(`document.documentElement.style.setProperty('--font-sans', 'Arial, "Liberation Sans", Helvetica, "Droid Sans Fallback", sans-serif')`);
    await b.waitFor(`document.querySelector('[data-control="subagent"]') && document.querySelector('[data-control="model"]') && document.querySelector('[data-control="swarm"]') && document.querySelector('.ctx-hint')`);
    await sleep(400);
    const m = await b.eval(MEASURE_COMPOSER);
    const nat = m.chips.reduce((sum, c) => sum + c.width, 0) + 2 * (m.chips.length - 1);
    const fits = nat <= m.box.width - 24 - 4;
    const rows = rowsOf(m.chips);
    if (fits) assert.equal(rows, 1, `the chips (${Math.round(nat)}px) fit the box (${Math.round(m.box.width - 24)}px) and must be on one line: tops ${JSON.stringify(m.chips.map((c) => [c.control, Math.round(c.top)]))}`);
    else assert.ok(rows <= 2, `the chips (${Math.round(nat)}px) are wider than the box (${Math.round(m.box.width - 24)}px) and use ${rows} lines, not one per line: tops ${JSON.stringify(m.chips.map((c) => [c.control, Math.round(c.top)]))}`);
    assertComposerRow(cell, m, { tag: `full subagent, ${fits ? 'fits' : 'wider than the box'}` });
    assert.deepEqual(await b.eval(`[...document.querySelectorAll('.composer-tools .chip > span')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent.trim())`), [], 'no chip is squeezed into an ellipsis by the notice beside it');
  });
}

for (const cell of CELLS.filter((c) => c.w < 700)) {
  test(`${cell.name}: on a phone the chips wrap as whole chips and nothing leaves the box`, { skip }, async () => {
    await openCell(cell, '#/s/s_polish');
    await b.waitFor(`document.querySelector('[data-control="subagent"]') && document.querySelector('[data-control="swarm"]') && document.querySelector('.ctx-hint')`);
    await sleep(400);
    const m = await b.eval(MEASURE_COMPOSER);
    for (const c of m.chips) {
      assert.ok(c.left >= m.tools.left - 0.5 && c.right <= m.tools.right + 0.5, `${c.control} is inside the row of chips`);
      assert.ok(c.width >= 28, `${c.control} keeps a width`);
    }
    assert.ok(m.actions.left >= m.box.left - 0.5 && m.actions.right <= m.box.right + 0.5, 'the right-hand group is inside the box');
    assert.ok(m.pageScroll <= 0, 'no sideways scroll');
    // More than a chip or two to a line: not one chip per line (3 lines at most for 6 chips here).
    assert.ok(rowsOf(m.chips) <= 3, `the chips use ${rowsOf(m.chips)} lines`);
    const swarm = m.chips.find((c) => c.control === 'swarm');
    const perm = m.chips.find((c) => c.control === 'permission');
    assert.ok(Math.abs(swarm.height - perm.height) < 0.5, 'Swarm is as tall as the permission chip');
  });
}

// ------------------------------------------------------------ the key list

const MEASURE_KEYS = `(() => {
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const cs = (e, p) => getComputedStyle(e)[p];
  return [...document.querySelectorAll('.deepseek-settings .ds-key')].map((card) => {
    const q = (s) => card.querySelector(s);
    const badge = q('.ds-key-state');
    return {
      id: card.dataset.keyId,
      on: card.classList.contains('on'),
      bg: cs(card, 'backgroundColor'),
      border: cs(card, 'borderTopColor'),
      card: rect(card),
      main: rect(q('.ds-key-main')),
      pos: rect(q('.ds-key-pos')),
      gw: { ...rect(q('.ds-key-gw')), min: parseFloat(cs(q('.ds-key-gw'), 'minWidth')) || 0 },
      hint: rect(q('.ds-key-hint')),
      state: { ...rect(badge), text: badge.innerText, overflows: badge.scrollHeight > badge.clientHeight + 1 },
      added: rect(q('.ds-key-added')),
      actions: rect(q('.ds-key-actions')),
      buttons: [...card.querySelectorAll('.ds-key-actions button')].map((x) => ({ act: x.dataset.act, text: x.innerText.trim(), title: x.title, aria: x.getAttribute('aria-label'), ...rect(x) })),
      overflowX: card.scrollWidth - card.clientWidth,
    };
  });
})()`;

async function openKeys(cell) {
  await openCell(cell, '#/s/s_polish');
  await b.waitFor(`document.querySelector('.composer-input')`);
  if (cell.w < 700) {
    await b.click('.sidebar-toggle');
    await b.waitFor(`document.querySelector('.app.drawer')`);
    await sleep(400);
  }
  await b.click('.side-foot button[aria-label="設定"]');
  await b.waitFor(`document.querySelector('.om-menu')`);
  await b.eval(`[...document.querySelectorAll('.om-menu__item')].find((i) => i.innerText.startsWith('DeepSeek…'))?.click()`);
  await b.waitFor(`document.querySelectorAll('.deepseek-settings .ds-key').length === 4`, { timeout: 8000 });
  await sleep(400);
}

for (const cell of CELLS) {
  test(`${cell.name}: every key card is one line of facts, the "added" line, then a line of whole buttons; nothing is squeezed, broken or out of line`, { skip }, async () => {
    await openKeys(cell);
    const cards = await b.eval(MEASURE_KEYS);
    assert.deepEqual(cards.map((c) => c.id), ['k_go1', 'k_go2', 'k_cc1', 'k_go3']);
    const calm = cards.filter((c) => /^(使用中|待命)$/.test(c.state.text));
    assert.equal(calm.length, 3, 'three cards with a short state, one with a long one');

    for (const c of cards) {
      const at = `${c.id}`;
      // The facts are one block that keeps the card's width, never a thin column.
      assert.ok(c.main.width >= c.card.width * 0.8, `${at}: the facts keep the card's width (${Math.round(c.main.width)} of ${Math.round(c.card.width)}px), the buttons do not squeeze them`);
      // The gateway name and the key tail are never broken: one line of text each.
      assert.ok(c.gw.height <= 20, `${at}: the gateway name is one line (${Math.round(c.gw.height)}px high)`);
      assert.ok(c.hint.height <= 20, `${at}: the key tail is one line (${Math.round(c.hint.height)}px high)`);
      assert.ok(c.pos.height <= 20, `${at}: the position is one line`);
      // Position, gateway and tail are on one line.
      assert.ok(Math.abs(c.pos.top - c.gw.top) <= 3 && Math.abs(c.gw.top - c.hint.top) <= 3, `${at}: position, gateway and tail share a line`);
      // The state badge is whole: its words do not run out of the pill.
      assert.ok(!c.state.overflows, `${at}: the state "${c.state.text.slice(0, 12)}…" is whole inside its badge`);
      assert.ok(c.state.right <= c.card.right + 0.5 && c.state.left >= c.card.left - 0.5, `${at}: the badge is inside the card`);
      // "added" is on the line under the facts, at the left.
      assert.ok(c.added.height > 0, `${at}: it says when it was added`);
      assert.ok(c.added.top >= Math.max(c.hint.bottom, c.state.bottom) - 1, `${at}: "added" is under the facts, not beside them`);
      assert.ok(Math.abs(c.added.left - c.pos.left) <= 1, `${at}: "added" starts at the left like the facts`);
      assert.ok(c.added.height <= 20, `${at}: "added" is one line`);
      // The buttons are a line of their own, under "added", whole, inside the card.
      assert.ok(c.actions.top >= c.added.bottom - 1, `${at}: the buttons are under "added"`);
      assert.ok(Math.abs(c.actions.left - c.pos.left) <= 1, `${at}: the buttons start at the card's left like the rest`);
      for (const x of c.buttons) {
        assert.ok(x.left >= c.card.left && x.right <= c.card.right, `${at}: "${x.text}" is inside the card`);
        assert.ok(x.top >= c.actions.top - 0.5 && x.bottom <= c.actions.bottom + 0.5, `${at}: "${x.text}" is inside the buttons' line`);
        assert.equal(x.height, c.buttons[0].height, `${at}: every button is as tall as the first`);
        // A label on one line.
        assert.ok(x.height <= 24, `${at}: "${x.text}" is one line`);
      }
      assert.ok(c.overflowX <= 1, `${at}: nothing runs out of the card sideways`);
    }

    // Buttons alike in size: a word button has a common least width, and the
    // arrows are small square-ish icon buttons that say what they do.
    const all = cards.flatMap((c) => c.buttons);
    for (const x of all.filter((x) => x.act !== 'up' && x.act !== 'down')) assert.ok(x.width >= 48 - 0.5, `"${x.text}" is a full-size button (${Math.round(x.width)}px)`);
    for (const x of all.filter((x) => x.act === 'up' || x.act === 'down')) {
      assert.ok(x.width <= 34, `${x.act}: a small icon button (${Math.round(x.width)}px)`);
      assert.ok(x.title.length > 2 && x.aria === x.title, `${x.act}: has a title and the same aria-label (${JSON.stringify([x.title, x.aria])})`);
    }
    // 2-character words are as wide as each other, and so are the 4-character ones.
    for (const n of [2, 4]) {
      const ws = all.filter((x) => x.text.length === n && /[一-鿿]/.test(x.text)).map((x) => Math.round(x.width));
      assert.ok(ws.length > 0 && Math.max(...ws) - Math.min(...ws) <= 1, `${n}-character buttons are one width: ${JSON.stringify(ws)}`);
    }

    // The cards line up with one another, column by column.
    const same = (name, pick, tol = 1) => {
      const xs = cards.map(pick);
      assert.ok(Math.max(...xs) - Math.min(...xs) <= tol, `${name} lines up across the cards: ${JSON.stringify(xs.map((x) => Math.round(x * 10) / 10))}`);
    };
    same('the position', (c) => c.pos.left);
    same('the gateway name', (c) => c.gw.left);
    // (a gateway name longer than its column pushes its own card's tail; the others keep to the column)
    const inColumn = cards.filter((c) => c.gw.width <= c.gw.min + 0.5);
    assert.ok(inColumn.length >= 3, `premise: at least three gateway names fit their column (${inColumn.length})`);
    const tails = inColumn.map((c) => c.hint.left);
    assert.ok(Math.max(...tails) - Math.min(...tails) <= 1, `the key tail lines up across the cards: ${JSON.stringify(tails.map((x) => Math.round(x * 10) / 10))}`);
    const calmLeft = calm.map((c) => c.state.left);
    assert.ok(Math.max(...calmLeft) - Math.min(...calmLeft) <= 1, `the state badge lines up across the cards with a short state: ${JSON.stringify(calmLeft.map((x) => Math.round(x)))}`);
    same('the first button', (c) => c.buttons[0].left);

    // The card in use keeps its emphasis.
    const on = cards.find((c) => c.on);
    assert.equal(on.id, 'k_go1');
    for (const c of cards.filter((c) => !c.on)) assert.ok(on.border !== c.border && on.bg !== c.bg, 'the card in use has its own border and background');
  });
}
