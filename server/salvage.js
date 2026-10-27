// Getting a conversation back out of a session file that no longer parses.
//
// Pure text in, verdict out: no disk, no clock. The store (store.js) does the
// backing up and the loading around it.
//
// A crash in the middle of a write can leave a file whole in size but with a
// stretch of NUL bytes where its data should be (the disk block was never
// written), or cut short. Two repairs are tried, both only ever *removing*
// damage, never inventing content:
//
//   1. a run of illegal control characters (NUL…) that sits inside a JSON
//      string is cut out, and a visible marker is left in its place, because
//      what was there is gone for good and the text on either side of the gap
//      now touches;
//   2. a file that stops in the middle of an event is cut back to the last
//      complete event.
//
// A control character anywhere else (between tokens, where JSON structure
// itself was lost) is not repaired: the structure around it is no longer
// known, and guessing would load a wrong conversation as if it were right.
// Whatever comes out is also checked for the shape of a session.

// Control characters that JSON forbids raw inside a string, except the three
// that are whitespace between tokens.
const illegal = (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;

export const gapMarker = (n) => `〔損壞區段：${n} 位元組已移除，內容無法還原〕`;

// Cuts every run of illegal control characters out of the JSON strings of
// `text`. { text, removed, firstAt, outsideAt }: `outsideAt` is the offset of
// the first such character found anywhere else (-1 when there is none).
export function stripControlRuns(text, mark = gapMarker) {
  const scan = /["\\\u0000-\u001f]/g;
  const out = [];
  let last = 0;
  let removed = 0;
  let firstAt = -1;
  let outsideAt = -1;
  let inString = false;
  for (let m; (m = scan.exec(text)); ) {
    const i = m.index;
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      inString = !inString;
    } else if (c === 0x5c) {
      if (inString) scan.lastIndex = i + 2;
    } else if (illegal(c)) {
      let j = i + 1;
      while (j < text.length && illegal(text.charCodeAt(j))) j++;
      scan.lastIndex = j;
      if (!inString) {
        if (outsideAt < 0) outsideAt = i;
        continue;
      }
      if (firstAt < 0) firstAt = i;
      out.push(text.slice(last, i), mark(j - i));
      last = j;
      removed += j - i;
    }
  }
  if (!removed) return { text, removed, firstAt, outsideAt };
  out.push(text.slice(last));
  return { text: out.join(''), removed, firstAt, outsideAt };
}

// For a text that ends in the middle of its `events` list (or of a key after
// it): the text cut back to the last complete event and closed again.
// { text, dropped } or null when it is not that kind of damage.
export function cutBackToLastEvent(text) {
  const scan = /["\\{}[\]]/g;
  let depth = 0;
  let inString = false;
  let safe = -1; // end of the last whole event (or of the closed list)
  let inEvents = false;
  let closed = false;
  for (let m; (m = scan.exec(text)); ) {
    const i = m.index;
    const c = text[i];
    if (inString) {
      if (c === '\\') scan.lastIndex = i + 2;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (c === '[' && depth === 1 && /"events"\s*:\s*$/.test(text.slice(Math.max(0, i - 40), i))) {
        inEvents = true;
        safe = i + 1;
      }
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return null; // the root closed: not a truncated file
      if (inEvents && depth === 2 && c === '}') safe = i + 1;
      if (inEvents && depth === 1 && c === ']') {
        inEvents = false;
        closed = true;
        safe = i + 1;
      }
    }
  }
  if (safe < 0) return null;
  return { text: text.slice(0, safe) + (closed ? '}' : ']}'), dropped: Buffer.byteLength(text.slice(safe)) };
}

// Why this is not a conversation, or null when it is shaped like one.
export function shapeProblem(obj, expectedId) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '最外層不是物件';
  if (typeof obj.id !== 'string' || !obj.id) return '缺少 id';
  if (obj.id !== expectedId) return `檔案裡的 id（${obj.id.slice(0, 40)}）和檔名（${expectedId}）不一致`;
  if (!Array.isArray(obj.events)) return 'events 不是陣列';
  const bad = obj.events.findIndex((ev) => !ev || typeof ev !== 'object' || typeof ev.type !== 'string');
  if (bad >= 0) return `第 ${bad + 1} 個事件不是合法事件`;
  return null;
}

// Keys a session always has, for a file that stopped before reaching them.
function fillMissing(s, fallbackTime) {
  s.title ??= '（已救援的對話）';
  s.status ??= 'idle';
  s.permissionMode ??= 'ask';
  s.allowedTools ??= [];
  s.state ??= {};
  s.usage ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  s.createdAt ??= fallbackTime;
  s.updatedAt ??= fallbackTime;
}

const byteOffset = (text, charOffset) => Buffer.byteLength(text.slice(0, charOffset));

// The conversation in the damaged file `raw`, if it can be had.
//   { ok: true, session, removedBytes, droppedBytes, kinds, reason }
//   { ok: false, code, reason }
// `expectedId` is the file's name without `.json`; `parseError` is what
// JSON.parse said about the untouched text; `fallbackTime` stands in for
// createdAt/updatedAt if the file stopped before them.
export function salvage(raw, expectedId, parseError, fallbackTime = Date.now()) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!raw.some((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) {
    return fail('empty', raw.length ? '檔案只有空白' : '檔案是空的（0 位元組），常見於寫入到一半當機');
  }
  if (!raw.some(Boolean)) return fail('all-zero', `整個檔案（${raw.length} 位元組）都是 0x00，沒有任何內容可救，常見於寫入到一半當機`);
  const text = raw.toString('utf8');
  const kinds = [];
  const stripped = stripControlRuns(text);
  if (stripped.outsideAt >= 0) {
    return fail('control-chars-outside-strings', `位元組 ${byteOffset(text, stripped.outsideAt)} 附近有非法控制字元，而且不在字串內：JSON 的結構本身被破壞，無法安全判斷原本是什麼，所以不救援`);
  }
  let json = stripped.text;
  if (stripped.removed) kinds.push('control-chars');
  let obj;
  let dropped = 0;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    // Only a text that the parser read to its very end without finding the end
    // of the document is a truncated file. A parser that stopped earlier met
    // damage in the middle (what follows it may be intact but its structure
    // is no longer known): cutting there would pass a prefix off as the whole.
    const ranOut = /end of JSON input|Unterminated string/i.test(err.message);
    const cut = ranOut && cutBackToLastEvent(json);
    if (!cut) return fail('unparseable', `JSON 無法解析（${parseError?.message || err.message}）${stripped.removed ? '，移除字串內的損壞區段後仍不行' : '，也不是單純的檔尾截斷'}`);
    try {
      obj = JSON.parse(cut.text);
    } catch (err2) {
      return fail('unparseable', `JSON 無法解析（${err2.message}），截去檔尾後仍不行`);
    }
    dropped = cut.dropped;
    kinds.push('truncated');
  }
  const problem = shapeProblem(obj, expectedId);
  if (problem) return fail('bad-structure', `救援後的內容不像一個對話：${problem}`);
  fillMissing(obj, fallbackTime);
  const parts = [];
  if (stripped.removed) parts.push(`在位元組 ${byteOffset(text, stripped.firstAt)} 起有 ${stripped.removed.toLocaleString('en-US')} 位元組的非法控制字元（疑似寫入到一半當機，磁碟區塊被零填滿），已移除`);
  if (dropped) parts.push(`檔案在事件中間被截斷，已捨棄最後不完整的 ${dropped.toLocaleString('en-US')} 位元組`);
  return { ok: true, session: obj, removedBytes: stripped.removed, droppedBytes: dropped, kinds, reason: `${parts.join('；')}後載入` };
}
