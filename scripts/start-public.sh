#!/usr/bin/env bash
# One command to put Agent Hub on the public internet from this computer:
#   1. starts the hub on localhost
#   2. opens a Cloudflare quick tunnel (free, no account) → https://xxxx.trycloudflare.com
#   3. connects this computer's Kimi Code to the hub (bridge), if kimi is installed
# and prints the public URL, the login password and the command for other machines.
#
#   bash scripts/start-public.sh            (Ctrl+C stops everything)
#
# Env: PORT (default 8787), NO_BRIDGE=1 to skip connecting this computer.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
mkdir -p bin data
LOGDIR="$(mktemp -d)"

say() { printf '\033[1;38;5;173m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "需要 Node.js 22 以上：https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 版本太舊（$(node -v)），需要 22 以上"

if [ ! -d node_modules ]; then
  say "安裝相依套件（npm install）…"
  npm install --omit=dev --no-audit --no-fund >/dev/null
fi

# cloudflared: use the installed one, or download the official binary once.
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="./bin/cloudflared"
  if [ ! -x "$CF" ]; then
    OS="$(uname -s)"; ARCH="$(uname -m)"
    case "$ARCH" in x86_64|amd64) ARCH=amd64 ;; arm64|aarch64) ARCH=arm64 ;; *) die "不支援的 CPU 架構：$ARCH" ;; esac
    BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
    say "下載 cloudflared（Cloudflare 官方）…"
    if [ "$OS" = "Darwin" ]; then
      curl -fsSL "$BASE/cloudflared-darwin-$ARCH.tgz" -o bin/cloudflared.tgz || die "下載失敗，可改用 brew install cloudflared"
      tar -xzf bin/cloudflared.tgz -C bin && rm bin/cloudflared.tgz
    else
      curl -fsSL "$BASE/cloudflared-linux-$ARCH" -o "$CF" || die "下載 cloudflared 失敗"
    fi
    chmod +x "$CF"
  fi
fi

PIDS=()
cleanup() {
  echo
  say "關閉中…"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$LOGDIR"
}
trap cleanup EXIT INT TERM

say "啟動中控台（port $PORT）…"
PORT="$PORT" HOST=127.0.0.1 node server/index.js >"$LOGDIR/hub.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do grep -q "已啟動" "$LOGDIR/hub.log" 2>/dev/null && break; sleep 0.2; done
grep -q "已啟動" "$LOGDIR/hub.log" || { cat "$LOGDIR/hub.log"; die "中控台啟動失敗"; }

TOKEN="${AGENT_HUB_TOKEN:-$(node -p "require('./data/hub.json').token")}"
KEY="${AGENT_HUB_BRIDGE_KEY:-$(node -p "require('./data/hub.json').bridgeKey")}"

say "開啟 Cloudflare 公網通道…"
"$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$LOGDIR/cf.log" 2>&1 &
PIDS+=($!)
URL=""
for _ in $(seq 1 150); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGDIR/cf.log" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.2
done
[ -n "$URL" ] || { tail -20 "$LOGDIR/cf.log"; die "Cloudflare 通道沒有建立起來（請檢查網路或防火牆）"; }

if [ -z "${NO_BRIDGE:-}" ]; then
  if command -v kimi >/dev/null; then
    say "把這台電腦的 Kimi 連上中控台…"
    node bridge/agent-hub-bridge.mjs --hub "http://127.0.0.1:$PORT" --key "$KEY" >"$LOGDIR/bridge.log" 2>&1 &
    PIDS+=($!)
  else
    say "這台電腦沒有安裝 kimi，略過本機連接"
  fi
fi

cat <<EOF

  ┌────────────────────────────────────────────────────────────
  │  Agent Hub 已上線
  │
  │  公網網址：  $URL/#token=$TOKEN
  │  登入密碼：  $TOKEN
  │
  │  其他電腦要連上（在那台電腦執行）：
  │    curl -fsSL $URL/bridge/agent-hub-bridge.mjs -o agent-hub-bridge.mjs && node agent-hub-bridge.mjs --hub $URL --key $KEY
  │
  │  然後在那台電腦的 Kimi 裡輸入 /web，對話就會出現在中控台。
  │  這個網址每次啟動都會不同；按 Ctrl+C 停止。
  └────────────────────────────────────────────────────────────

EOF

# Keep running until a child exits or the user presses Ctrl+C.
wait -n "${PIDS[@]}" 2>/dev/null || true
tail -5 "$LOGDIR/hub.log" "$LOGDIR/cf.log" 2>/dev/null || true
