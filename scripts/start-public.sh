#!/usr/bin/env bash
# One command to put Agent Hub on the public internet from this computer:
#   1. starts the hub on localhost
#   2. opens a Cloudflare quick tunnel (free, no account) → https://xxxx.trycloudflare.com
#   3. connects this computer's Kimi Code to the hub (bridge), if kimi is installed
# and prints the public URL, the login password and the command for other machines.
#
#   bash scripts/start-public.sh            (Ctrl+C stops everything)
#
# The hub keeps running when a quick tunnel drops: the tunnel is restarted with
# backoff and a new public URL is printed. Only the hub exiting ends the script.
#
# Env:
#   PORT (default 8787)
#   AGENT_HUB_TOKEN  your own login password. Never "none": that turns the login
#                    off, and this script puts the hub on the public internet.
#   NO_BRIDGE=1      do not connect this computer's Kimi to the hub. Step 3 writes
#                    ~/.agent-hub and ~/.kimi-code (state, skills, MCP entry, and
#                    the Kimi config when DeepSeek is used); with NO_BRIDGE=1 none
#                    of that is touched. Other computers can still connect.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"

say() { printf '\033[1;38;5;173m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Public mode and no login would hand this whole computer to anyone who finds
# the address: refuse before anything is started or created.
NO_LOGIN_CHECK="$(printf '%s' "${AGENT_HUB_TOKEN:-}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
if [ "$NO_LOGIN_CHECK" = "none" ]; then
  die "AGENT_HUB_TOKEN 設成 none 代表關掉登入，而這支腳本會把中控台放上公網：任何人拿到網址就能在你的電腦上建立對話、執行指令、讀寫檔案，等於把整台電腦交出去。請不要設 none；不設的話會自動產生密碼（存在 data/hub.json），要自訂就設成別的值。只在本機使用請改跑 npm start，不要用公網模式。"
fi

mkdir -p bin data
LOGDIR="$(mktemp -d)"

command -v node >/dev/null || die "需要 Node.js 22 以上：https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 版本太舊（$(node -v)），需要 22 以上"

# Installed again whenever package-lock.json changed (an update added a package).
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.agent-hub-lock.json; then
  # npm ci installs exactly what package-lock.json says and leaves it as it
  # is, so the next git pull is not blocked by a rewritten lockfile.
  say "安裝相依套件（npm ci）…"
  npm ci --omit=dev --no-audit --no-fund >/dev/null
  cp package-lock.json node_modules/.agent-hub-lock.json
fi

# cloudflared: use the installed one, or download the official binary once.
#
# The download is a fixed release, never "latest", and is checked against the
# SHA-256 built in below before it is unpacked, made executable or run. A file
# that does not match is deleted and the script stops. Source of the hashes:
# the "digest" field GitHub computes for each release asset, which agrees with
# the checksum list in Cloudflare's release notes and with sha256sum of the
# downloaded bytes (checked for 2026.10.0; for the macOS .tgz Cloudflare lists
# the hash of the binary inside it, GitHub the hash of the .tgz).
# To use another release, set both AGENT_HUB_CLOUDFLARED_VERSION and
# AGENT_HUB_CLOUDFLARED_SHA256 (the hash of the file for this computer); to
# download from a mirror, set AGENT_HUB_CLOUDFLARED_BASE_URL. The hash is
# still checked either way. Or install cloudflared yourself (brew install
# cloudflared, your package manager): an installed one is used as it is.
CF_VERSION="2026.10.0"
CF_BASE="${AGENT_HUB_CLOUDFLARED_BASE_URL:-https://github.com/cloudflare/cloudflared/releases/download}"
CF_BASE="${CF_BASE%/}"
CF_EXPECT=""   # set only by AGENT_HUB_CLOUDFLARED_SHA256; otherwise the built-in table

# SHA-256 of the release asset for the built-in version (the file as downloaded).
cf_pinned_sha256() {
  case "$1" in
    cloudflared-linux-amd64) echo d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db ;;
    cloudflared-linux-arm64) echo e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08 ;;
    cloudflared-linux-arm) echo 1dbe8e4ec17e74bb7f49cf91db6a4903bd0f9fe41984556c7503e40b765fd099 ;;
    cloudflared-darwin-amd64.tgz) echo 903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f ;;
    cloudflared-darwin-arm64.tgz) echo a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70 ;;
    *) return 1 ;;
  esac
}

# The SHA-256 of a file, whichever tool this computer has (read from stdin so
# an odd file name cannot change the output).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum <"$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 <"$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 <"$1" | awk '{print $NF}'
  else return 1
  fi
}

CF_TMP=""
# Like die, but removes the half-finished download first.
cf_die() {
  if [ -n "$CF_TMP" ]; then rm -rf "$CF_TMP"; fi
  die "$@"
}

# Another release, only with its hash: both variables, or neither.
if [ -n "${AGENT_HUB_CLOUDFLARED_VERSION:-}" ] || [ -n "${AGENT_HUB_CLOUDFLARED_SHA256:-}" ]; then
  [ -n "${AGENT_HUB_CLOUDFLARED_VERSION:-}" ] && [ -n "${AGENT_HUB_CLOUDFLARED_SHA256:-}" ] ||
    die "要改用其他版本的 cloudflared，必須同時設定 AGENT_HUB_CLOUDFLARED_VERSION 與 AGENT_HUB_CLOUDFLARED_SHA256"
  CF_VERSION="$AGENT_HUB_CLOUDFLARED_VERSION"
  CF_EXPECT="$(printf '%s' "$AGENT_HUB_CLOUDFLARED_SHA256" | tr 'A-F' 'a-f')"
  case "$CF_VERSION" in *[!0-9A-Za-z._-]*) die "AGENT_HUB_CLOUDFLARED_VERSION 只能包含英數字與 . _ -" ;; esac
  case "$CF_EXPECT" in *[!0-9a-f]*) die "AGENT_HUB_CLOUDFLARED_SHA256 必須是 64 個十六進位字元" ;; esac
  [ "${#CF_EXPECT}" -eq 64 ] || die "AGENT_HUB_CLOUDFLARED_SHA256 必須是 64 個十六進位字元"
fi

# bin/cloudflared is trusted only when this script put it there after checking
# it: bin/cloudflared.verified holds "<version> <sha256 of the program>". A
# program from an older copy of this script (downloaded from "latest", never
# checked) has no such record and is downloaded again, checked.
cf_installed_ok() {
  [ -x "$CF" ] && [ -f bin/cloudflared.verified ] || return 1
  local want got
  want="$CF_VERSION $(sha256_of "$CF" 2>/dev/null || echo none)"
  got="$(cat bin/cloudflared.verified 2>/dev/null || true)"
  [ "$got" = "$want" ]
}

cf_download() {
  local os arch asset expect url got
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    armv7*|armv6*|armhf|arm) arch=arm ;;
    *) die "不支援的 CPU 架構：$arch（可自行安裝 cloudflared，腳本會優先使用）" ;;
  esac
  case "$os" in
    Linux) asset="cloudflared-linux-$arch" ;;
    Darwin)
      [ "$arch" != "arm" ] || die "macOS 沒有 32 位元 ARM 版的 cloudflared，請改用 brew install cloudflared"
      asset="cloudflared-darwin-$arch.tgz" ;;
    *) die "不支援的作業系統：$os（Windows 請用 scripts/start-public.ps1；也可自行安裝 cloudflared，腳本會優先使用）" ;;
  esac
  expect="$CF_EXPECT"
  if [ -z "$expect" ]; then expect="$(cf_pinned_sha256 "$asset")" || die "沒有 $asset 的已知雜湊，無法驗證下載"; fi

  url="$CF_BASE/$CF_VERSION/$asset"
  say "下載 cloudflared $CF_VERSION（Cloudflare 官方，會先核對 SHA-256）…"
  CF_TMP="$(mktemp -d "$PWD/bin/.cloudflared-download.XXXXXX")"
  curl -fsSL "$url" -o "$CF_TMP/$asset" || cf_die "下載 cloudflared 失敗（$url）。可自行安裝 cloudflared（macOS：brew install cloudflared），腳本會優先使用"
  got="$(sha256_of "$CF_TMP/$asset")" || cf_die "找不到 sha256sum、shasum 或 openssl，無法驗證下載檔，已中止（可自行安裝 cloudflared）"
  if [ "$got" != "$expect" ]; then
    cf_die "cloudflared 下載檔的 SHA-256 不符，已刪除、未執行。預期 $expect，實際 $got（$url）。可能是下載被竄改或網路被攔截；可自行安裝 cloudflared，腳本會優先使用"
  fi

  rm -f "$CF" bin/cloudflared.verified
  case "$asset" in
    *.tgz)
      tar -xzf "$CF_TMP/$asset" -C "$CF_TMP" cloudflared || cf_die "解開 cloudflared 失敗"
      mv "$CF_TMP/cloudflared" "$CF" ;;
    *) mv "$CF_TMP/$asset" "$CF" ;;
  esac
  chmod +x "$CF"
  rm -rf "$CF_TMP"; CF_TMP=""
  printf '%s %s\n' "$CF_VERSION" "$(sha256_of "$CF")" > bin/cloudflared.verified
}

CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="./bin/cloudflared"
  cf_installed_ok || cf_download
fi

HUB_PID=""
BRIDGE_PID=""
BRIDGE_STARTED=0
TUNNEL_PID=""
TUNNEL_PIDS=()   # current tunnel and every previous one, killed on exit

# Stop one tunnel and do not return until it is really gone, so a reconnect
# can never run two cloudflared processes at the same time.
stop_tunnel() {
  local p="${TUNNEL_PID:-}"
  [ -n "$p" ] || return 0
  kill "$p" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$p" 2>/dev/null || true
  wait "$p" 2>/dev/null || true
  TUNNEL_PID=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  echo
  say "關閉中…"
  local p i alive
  # TUNNEL_PIDS holds the current tunnel and all earlier ones; a tunnel that
  # ignored TERM must not survive as an orphan.
  for p in "${TUNNEL_PIDS[@]-}"; do
    if [ -n "$p" ]; then kill "$p" 2>/dev/null || true; fi
  done
  if [ -n "$BRIDGE_PID" ]; then kill "$BRIDGE_PID" 2>/dev/null || true; fi
  if [ -n "$HUB_PID" ]; then kill "$HUB_PID" 2>/dev/null || true; fi

  for i in $(seq 1 20); do
    alive=0
    for p in "${TUNNEL_PIDS[@]-}"; do
      if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then alive=1; fi
    done
    if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then alive=1; fi
    if [ -n "$HUB_PID" ] && kill -0 "$HUB_PID" 2>/dev/null; then alive=1; fi
    [ "$alive" -eq 0 ] && break
    sleep 0.1
  done

  for p in "${TUNNEL_PIDS[@]-}"; do
    if [ -n "$p" ]; then kill -9 "$p" 2>/dev/null || true; fi
  done
  if [ -n "$BRIDGE_PID" ]; then kill -9 "$BRIDGE_PID" 2>/dev/null || true; fi
  if [ -n "$HUB_PID" ]; then kill -9 "$HUB_PID" 2>/dev/null || true; fi

  for p in "${TUNNEL_PIDS[@]-}"; do
    if [ -n "$p" ]; then wait "$p" 2>/dev/null || true; fi
  done
  if [ -n "$BRIDGE_PID" ]; then wait "$BRIDGE_PID" 2>/dev/null || true; fi
  if [ -n "$HUB_PID" ]; then wait "$HUB_PID" 2>/dev/null || true; fi

  rm -rf "$LOGDIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

print_access() {
  local url="$1" reconnect="${2:-0}"
  if [ "$reconnect" = "1" ]; then
    # Only the new address. The password and the bridge key were printed once,
    # at startup; this script runs unattended (systemd, nohup) and its output
    # ends up in a log, so it must not write them again at every reconnect.
    echo
    say "公網通道已重新建立（quick tunnel 的網址可能改變，舊網址已失效）"
    say "新的公網網址：$url"
    say "登入密碼與連接金鑰沒有改變（啟動時印過一次，也在 data/hub.json）；其他電腦的連接指令把網址換成上面這個。"
    return 0
  fi
  cat <<EOF

  ┌────────────────────────────────────────────────────────────
  │  Agent Hub 已上線
  │
  │  公網網址：  $url/#token=$TOKEN
  │  登入密碼：  $TOKEN
  │
  │  其他電腦要連上（在那台電腦執行）：
  │    curl -fsSL $url/bridge/agent-hub-bridge.mjs -o agent-hub-bridge.mjs && AGENT_HUB_BRIDGE_KEY=$KEY node agent-hub-bridge.mjs --hub $url
  │    （金鑰用環境變數傳入，不會出現在那台電腦的行程列表；但會留在該終端機的指令歷史，不用時可清掉）
  │
  │  那台電腦的 Kimi 對話（包含終端機裡正在跑的）會自動出現在中控台。
  │  想從中控台操作終端機裡的 Kimi，改用這個指令啟動 Kimi：
  │    node ~/.agent-hub/agent-hub-bridge.mjs kimi
  │  （可以設成 alias kimi-hub）
  │
  │  注意：quick tunnel 每次啟動或重連的網址都可能不同，
  │        舊網址不會一直有效；請以最新印出的網址為準。
  │  按 Ctrl+C 停止。
  └────────────────────────────────────────────────────────────

EOF
}

# NO_BRIDGE=1 (or true/yes/on, any case) skips connecting this computer; unset,
# empty, 0, false, no and off connect it.
no_bridge() {
  case "$(printf '%s' "${NO_BRIDGE:-}" | tr 'A-Z' 'a-z')" in
    ""|0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

start_bridge() {
  [ "$BRIDGE_STARTED" = "1" ] && return 0
  BRIDGE_STARTED=1
  if no_bridge; then
    say "已設定 NO_BRIDGE，略過本機 Kimi 連接（不會寫入 ~/.agent-hub 與 ~/.kimi-code）"
    return 0
  fi
  if command -v kimi >/dev/null; then
    say "把這台電腦的 Kimi 連上中控台…"
    # The key goes in the environment, not on the command line, where any other
    # user of this computer could read it in the process list.
    AGENT_HUB_BRIDGE_KEY="$KEY" node bridge/agent-hub-bridge.mjs --hub "http://127.0.0.1:$PORT" >"$LOGDIR/bridge.log" 2>&1 &
    BRIDGE_PID=$!
  else
    say "這台電腦沒有安裝 kimi，略過本機連接"
  fi
}

# `wait -n` (return when any of the given processes ends) needs bash 4.3; the
# bash that macOS ships is 3.2, where it fails at once. Taking that failure for
# "the tunnel dropped" would tear down a working tunnel and reconnect in a loop.
# Arguments (for tests): major and minor version, default this bash's.
wait_n_supported() {
  local major="${1:-${BASH_VERSINFO[0]:-0}}" minor="${2:-${BASH_VERSINFO[1]:-0}}"
  [ "$major" -gt 4 ] || { [ "$major" -eq 4 ] && [ "$minor" -ge 3 ]; }
}

# Returns when the hub or the current tunnel is gone. Whatever `wait -n` did
# (or where it does not exist), it only returns once one of the two really has
# exited — checked by polling, the only method bash 3.2 has.
wait_hub_or_tunnel() {
  if wait_n_supported; then
    wait -n "$HUB_PID" "$TUNNEL_PID" 2>/dev/null || true
  fi
  while kill -0 "$HUB_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do
    sleep 0.2
  done
}

# Sleep before a reconnect, but stop as soon as the hub itself is gone.
backoff_sleep() {
  local deadline=$((SECONDS + BACKOFF))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$HUB_PID" 2>/dev/null; then
      say "中控台已結束"
      exit 1
    fi
    sleep 0.2
  done
}

say "啟動中控台（port $PORT）…"
PORT="$PORT" HOST=127.0.0.1 node server/index.js >"$LOGDIR/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 50); do grep -q "已啟動" "$LOGDIR/hub.log" 2>/dev/null && break; sleep 0.2; done
grep -q "已啟動" "$LOGDIR/hub.log" || { cat "$LOGDIR/hub.log"; die "中控台啟動失敗"; }

TOKEN="${AGENT_HUB_TOKEN:-$(node -p "require('./data/hub.json').token")}"
KEY="${AGENT_HUB_BRIDGE_KEY:-$(node -p "require('./data/hub.json').bridgeKey")}"

say "開啟 Cloudflare 公網通道…"
BACKOFF=1
MAX_BACKOFF=30
ATTEMPT=0
while :; do
  if ! kill -0 "$HUB_PID" 2>/dev/null; then
    say "中控台已結束"
    exit 1
  fi

  ATTEMPT=$((ATTEMPT + 1))
  CF_LOG="$LOGDIR/cf-$ATTEMPT.log"
  : >"$CF_LOG"
  "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CF_LOG" 2>&1 &
  TUNNEL_PID=$!
  TUNNEL_PIDS+=("$TUNNEL_PID")

  URL=""
  CONNECTED_AT=0
  for _ in $(seq 1 150); do
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
    [ -n "$URL" ] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
    if ! kill -0 "$HUB_PID" 2>/dev/null; then break; fi
    sleep 0.2
  done

  if ! kill -0 "$HUB_PID" 2>/dev/null; then
    say "中控台已結束"
    exit 1
  fi

  if [ -n "$URL" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    CONNECTED_AT=$SECONDS
    if [ "$ATTEMPT" -gt 1 ]; then
      print_access "$URL" 1
    else
      print_access "$URL" 0
    fi
    start_bridge
  else
    # The hub is alive, so this is only this tunnel attempt failing.
    tail -10 "$CF_LOG" 2>/dev/null || true
    say "Cloudflare 通道沒有建立起來（第 $ATTEMPT 次），$BACKOFF 秒後重試…（Hub 仍在執行）"
    stop_tunnel
    backoff_sleep
    if [ "$BACKOFF" -lt "$MAX_BACKOFF" ]; then
      BACKOFF=$((BACKOFF * 2))
      if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then BACKOFF=$MAX_BACKOFF; fi
    fi
    continue
  fi

  # Wait for either the hub or this tunnel to exit. The bridge is deliberately
  # not in this set: another connector may already be serving this computer.
  wait_hub_or_tunnel

  if ! kill -0 "$HUB_PID" 2>/dev/null; then
    say "中控台已結束"
    exit 1
  fi

  # The tunnel went away while the hub is still running: reconnect only it.
  if [ "$SECONDS" -ge $((CONNECTED_AT + 10)) ]; then BACKOFF=1; fi
  tail -5 "$CF_LOG" 2>/dev/null || true
  say "公網通道中斷（Hub 仍在執行），$BACKOFF 秒後自動重連…"
  stop_tunnel
  backoff_sleep
  if [ "$BACKOFF" -lt "$MAX_BACKOFF" ]; then
    BACKOFF=$((BACKOFF * 2))
    if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then BACKOFF=$MAX_BACKOFF; fi
  fi
done
