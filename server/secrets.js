// The Hub's own secrets, kept in <data>/hub.json: the login token (the hub
// always requires one, so agents that can run shell commands here and on every
// connected machine are not open to the network) and the bridge key machines
// connect with. Generated once, then kept.
//
// What is generated is what the environment does not already give:
// AGENT_HUB_TOKEN (any value, `none` included) stands in for the token,
// AGENT_HUB_BRIDGE_KEY for the bridge key.
//
// A hub.json that cannot be parsed is never replaced in silence: a new bridge
// key cuts off every connected computer until it is reconnected with the new
// command, and a new token locks out whoever has the old one written down. It
// is copied byte for byte into <data>/damaged-config/ first, the start says so,
// and only then are new secrets made. A hub.json that cannot even be READ is
// not touched at all (what is in it is unknown, and may be fine): the Hub
// stops rather than guess, unless the environment supplies everything.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonConfig, writeJsonAtomic } from './store.js';

export function loadSecrets(dir, { env = process.env, warn = console.warn } = {}) {
  const file = path.join(dir, 'hub.json');
  const needToken = !env.AGENT_HUB_TOKEN;
  const needBridgeKey = !env.AGENT_HUB_BRIDGE_KEY;
  const r = readJsonConfig(file);
  let secrets = {};
  let damaged = null;
  if (r.state === 'ok') secrets = r.value;
  else if (r.state === 'unreadable') {
    const why = `讀不到 ${file}（${r.error.code || r.error.message}）`;
    if (needToken || needBridgeKey) throw new Error(`${why}。為了不蓋掉可能還好好的內容，Hub 沒有產生新的登入權杖／連接金鑰，也沒有啟動。請修正這個檔案（或它的權限）後再啟動；或用環境變數 AGENT_HUB_TOKEN 與 AGENT_HUB_BRIDGE_KEY 指定。`);
    warn(`[hub] ${why}；登入權杖與連接金鑰都由環境變數指定，這次用不到它，也沒有動它。`);
  } else if (r.state === 'damaged') {
    damaged = r;
    if (r.backupError && (needToken || needBridgeKey)) {
      throw new Error(`${file} 損壞（${r.reason}），而且沒能先備份原檔（${r.backupError.message}）。為了不蓋掉唯一的一份，Hub 沒有產生新的登入權杖／連接金鑰，也沒有啟動。請排除備份失敗的原因後再啟動；或用環境變數 AGENT_HUB_TOKEN 與 AGENT_HUB_BRIDGE_KEY 指定。`);
    }
  }
  const made = [];
  if (needToken && !secrets.token) (secrets.token = crypto.randomBytes(16).toString('hex')), made.push('登入權杖');
  if (needBridgeKey && !secrets.bridgeKey) (secrets.bridgeKey = `bk_${crypto.randomBytes(18).toString('hex')}`), made.push('連接金鑰');
  if (damaged) {
    const kept = damaged.backupPath ? `原檔已原封不動備份到 ${damaged.backupPath}` : `原檔沒能備份（${damaged.backupError.message}），這次沒有動它`;
    const reconnect = needBridgeKey ? '連接金鑰換了，所有已連接的電腦都要用新的連接指令重連（網頁左下角「連接電腦…」）' : '連接金鑰由環境變數指定，沒有變，已連接的電腦不受影響';
    const login = needToken ? '登入權杖也換了，登入要用新的（啟動訊息有印）' : '登入權杖由環境變數指定，沒有變';
    warn(`[hub] ${file} 損壞（${damaged.reason}）。${kept}。${made.length ? `已重新產生：${made.join('、')}。${reconnect}；${login}。` : '登入權杖與連接金鑰都由環境變數指定，沒有產生新的，也沒有改寫這個檔案。'}`);
  }
  // Whole or not at all, and private from the first byte: a kill in the middle
  // must not leave half a file (that would lose the token AND the key every
  // connected computer holds).
  if (made.length) writeJsonAtomic(file, secrets, { mode: 0o600 });
  return secrets;
}
