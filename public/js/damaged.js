// What the page says about conversation files that were damaged on disk (the
// Hub repairs what it can and lists the rest: meta.salvaged on a conversation,
// GET /api/damaged-sessions). Pure functions, no DOM, so they are tested
// directly in node; app.js draws them.
//
// Everything is read defensively: an entry may lack any field (an older or a
// newer Hub), and a missing field is said as "unknown", never guessed.

export const SALVAGE_LABEL = '曾損壞並已修復';
export const UNSAVED_LABEL = '尚未寫回原檔';
// Where the Hub keeps the untouched original of every damaged file, relative to
// ITS data folder (on the machine the Hub runs on, not necessarily this one).
export const BACKUP_DIR = 'data/sessions-damaged/';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function fmtBytes(n) {
  if (n == null) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} 位元組`;
}

export const backupPath = (backup) => (text(backup) ? `${BACKUP_DIR}${text(backup)}` : null);

// A conversation's meta.salvaged -> what to show, or null when it was never
// damaged. { label, unsaved, lost (bytes or null), title (the tooltip) }.
export function salvageView(salvaged) {
  if (!salvaged || typeof salvaged !== 'object' || Array.isArray(salvaged)) return null;
  const removed = num(salvaged.removedBytes);
  const dropped = num(salvaged.droppedBytes);
  const original = num(salvaged.originalBytes);
  const lost = removed == null && dropped == null ? null : (removed || 0) + (dropped || 0);
  const lines = [text(salvaged.reason) || '這個對話的檔案曾損壞，已修復後載入。'];
  if (lost == null) lines.push('損失了多少內容：不明。');
  else if (lost === 0) lines.push('沒有移除任何內容。');
  else {
    const share = original ? `，約占原檔 ${fmtBytes(original)} 的 ${lost / original < 0.01 ? '不到 1' : Math.round((lost / original) * 100)}%` : '';
    lines.push(`約損失 ${fmtBytes(lost)} 的內容${share}；那一段無法還原（對話裡標有「〔損壞區段…〕」）。`);
  }
  const unsaved = Boolean(salvaged.unsaved);
  if (unsaved) lines.push('尚未寫回原檔：修復後的內容目前只在 Hub 的記憶體裡，原檔沒有被改動，下次存檔才會寫成乾淨的版本。');
  const where = backupPath(salvaged.backup);
  lines.push(where ? `損壞的原檔已原封不動備份在 Hub 那台機器的 ${where}。` : '沒有備份原檔。');
  return { label: SALVAGE_LABEL, unsaved, lost, title: lines.join('\n') };
}

// GET /api/damaged-sessions -> the files that could NOT be loaded (salvaged is
// false), what to list for each, and a signature of the set (so a dismissal
// holds until a different file turns up, not merely until the next reconnect).
export function damagedView(list) {
  const items = (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === 'object' && x.salvaged === false)
    .map((x) => ({
      file: text(x.file) || '（檔名不明）',
      reason: text(x.reason) || '原因不明',
      backup: text(x.backup),
      bytes: num(x.bytes),
      code: text(x.code),
    }));
  const signature = items
    .map((i) => `${i.file}|${i.code}|${i.bytes ?? ''}`)
    .sort()
    .join('\n');
  return { items, count: items.length, signature };
}

export const damagedHeadline = (count) => `${count} 個對話檔損壞無法載入`;

// The `damaged` field of an account (GET /api/claude, /api/deepseek, /api/config):
// the key file the Hub could not use, { file, state: 'damaged' | 'unreadable',
// reason, backup (where the copy is on the Hub's machine, or null), message }.
// -> the text to show, or null when the file is fine. The Hub's own message is
// used as it is (it is the same one its errors give); a field an older Hub did
// not send is said as unknown, never guessed.
export function configProblemText(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const message = text(d.message);
  if (message) return message;
  const file = text(d.file) || '設定檔';
  const reason = text(d.reason);
  if (d.state === 'unreadable') return `${file} 讀不到${reason ? `（${reason}）` : ''}。Hub 不會寫入這個檔案；請修正它（或它的權限）後重新啟動 Hub。`;
  const copy = text(d.backup);
  return `${file} 損壞${reason ? `（${reason}）` : ''}。${copy ? `原檔已原封不動備份於 Hub 那台機器的 ${copy}。` : '沒有備份原檔。'}請重新輸入，或從備份還原。`;
}
