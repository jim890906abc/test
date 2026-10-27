// What the page says about damaged conversation files, as pure functions
// (public/js/damaged.js): the badge on a repaired conversation, the list of
// files that could not be loaded, and the signature a dismissal is held by.
// Every field may be missing; a missing one is said as unknown, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salvageView, damagedView, damagedHeadline, configProblemText, fmtBytes, backupPath, SALVAGE_LABEL, BACKUP_DIR } from '../public/js/damaged.js';

const note = (patch = {}) => ({ at: 1, removedBytes: 745472, originalBytes: 7795196, backup: 's_a.json.1793111886200', kinds: ['control-chars'], reason: '在位元組 303104 起有 745,472 位元組的非法控制字元，已移除後載入', ...patch });

test('a conversation that was never damaged has no badge, whatever meta holds', () => {
  for (const v of [undefined, null, false, 0, '', 'salvaged', []]) assert.equal(salvageView(v), null, JSON.stringify(v));
  assert.equal(salvageView({})?.label, SALVAGE_LABEL, 'an empty note still says it was repaired (the note exists)');
});

test('the tooltip gives the Hub\'s reason, roughly how much was lost, and where the original is', () => {
  const v = salvageView(note());
  assert.equal(v.label, '曾損壞並已修復');
  assert.equal(v.unsaved, false);
  assert.equal(v.lost, 745472);
  assert.match(v.title, /非法控制字元/, 'the reason, as the Hub gave it');
  assert.match(v.title, /約損失 728 KB 的內容，約占原檔 7\.4 MB 的 10%/);
  assert.match(v.title, /data\/sessions-damaged\/s_a\.json\.1793111886200/);
  assert.match(v.title, /Hub 那台機器/, 'the backup is on the Hub\'s machine, not necessarily this one');
  assert.ok(!v.title.includes('尚未寫回原檔'));
});

test('lost bytes include what was cut off the end of the file; a tiny share is not rounded to 0%', () => {
  const v = salvageView(note({ removedBytes: 100, droppedBytes: 150, originalBytes: 5_000_000 }));
  assert.equal(v.lost, 250);
  assert.match(v.title, /約損失 250 位元組.*不到 1%/);
});

test('not yet written back to the original file is said, in the badge data and the tooltip', () => {
  const v = salvageView(note({ unsaved: true, backup: null }));
  assert.equal(v.unsaved, true);
  assert.match(v.title, /尚未寫回原檔/);
  assert.match(v.title, /沒有備份原檔/);
});

test('missing or nonsense fields are said as unknown, never invented', () => {
  const v = salvageView({ reason: 5, removedBytes: 'many', originalBytes: -1, backup: 7 });
  assert.equal(v.lost, null);
  assert.match(v.title, /曾損壞，已修復後載入|這個對話的檔案曾損壞/);
  assert.match(v.title, /損失了多少內容：不明/);
  assert.ok(!/NaN|undefined|null/.test(v.title));
  assert.match(salvageView({ removedBytes: 0 }).title, /沒有移除任何內容/);
});

test('only files the Hub could NOT load make the banner; a repaired one has its badge instead', () => {
  const list = [
    { file: 's_a.json', salvaged: true, reason: 'ok' },
    { file: 's_b.json', salvaged: false, reason: '檔案是空的', code: 'empty', backup: 's_b.json.1', bytes: 0 },
    { file: 's_c.json', salvaged: false, reason: '內容不像一個對話', code: 'bad-structure', backup: null, bytes: 12 },
    { file: 's_d.json', reason: 'no salvaged field at all' },
    null,
    'text',
  ];
  const v = damagedView(list);
  assert.equal(v.count, 2);
  assert.deepEqual(v.items.map((i) => i.file), ['s_b.json', 's_c.json']);
  assert.equal(damagedHeadline(v.count), '2 個對話檔損壞無法載入');
  assert.equal(v.items[0].backup, 's_b.json.1');
  assert.equal(v.items[1].backup, '');
});

test('nothing to show for an empty list, or for an answer that is not a list', () => {
  for (const x of [[], null, undefined, {}, 'oops', 5, { error: 'x' }]) assert.equal(damagedView(x).count, 0, JSON.stringify(x));
  assert.equal(damagedView([]).signature, '');
});

test('entries missing fields are listed with plain words instead of blanks', () => {
  const [i] = damagedView([{ salvaged: false }]).items;
  assert.equal(i.file, '（檔名不明）');
  assert.equal(i.reason, '原因不明');
  assert.equal(i.backup, '');
});

test('the signature is the set of files, not their order nor when the Hub noticed them; another file changes it', () => {
  const a = { file: 's_a.json', salvaged: false, code: 'empty', bytes: 0, at: 111 };
  const b = { file: 's_b.json', salvaged: false, code: 'bad-structure', bytes: 12, at: 222 };
  const one = damagedView([a, b]).signature;
  assert.equal(damagedView([b, a]).signature, one, 'order does not matter');
  assert.equal(damagedView([{ ...a, at: 999 }, { ...b, at: 998 }]).signature, one, 'a Hub restart notices the same files again later: the same set');
  assert.notEqual(damagedView([a]).signature, one, 'one file fewer is another set');
  assert.notEqual(damagedView([a, b, { file: 's_c.json', salvaged: false, code: 'empty', bytes: 0 }]).signature, one, 'one more is another set');
});

test('sizes read as people say them', () => {
  assert.equal(fmtBytes(0), '0 位元組');
  assert.equal(fmtBytes(900), '900 位元組');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(fmtBytes(null), '');
  assert.equal(backupPath('x.json.1'), `${BACKUP_DIR}x.json.1`);
  assert.equal(backupPath(''), null);
});

test('a key file the Hub could not use: its own message is shown as it is; nothing is shown for a file that is fine', () => {
  for (const v of [undefined, null, false, 0, '', 'damaged', [], 5]) assert.equal(configProblemText(v), null, JSON.stringify(v));
  const message = 'Claude API key檔案 claude.json 損壞（檔案是空的），原檔已原封不動備份於 /data/damaged-config/claude.json.1。';
  assert.equal(configProblemText({ file: 'claude.json', state: 'damaged', message }), message);
});

test('an older Hub that sends no message: the file, the reason and where the copy is are said, and what is not known is not invented', () => {
  const t = configProblemText({ file: 'deepseek.json', state: 'damaged', reason: '檔案是空的', backup: '/data/damaged-config/deepseek.json.1' });
  assert.match(t, /deepseek\.json 損壞（檔案是空的）/);
  assert.match(t, /備份於 Hub 那台機器的 \/data\/damaged-config\/deepseek\.json\.1/);
  assert.match(t, /重新輸入|從備份還原/);
  assert.match(configProblemText({ file: 'claude.json', state: 'damaged' }), /沒有備份原檔/);
  assert.match(configProblemText({ state: 'unreadable', reason: '讀不到（EISDIR）' }), /設定檔 讀不到.*不會寫入/);
  assert.ok(!/undefined|null|NaN/.test(configProblemText({ state: 'damaged' })));
});
