#!/bin/sh
# Entry point of the Docker image (plain POSIX sh: the image is Alpine).
# The hub can run commands on every connected computer, so it must not listen
# on a non-loopback address (a container has to, to be reachable) without a
# real login password, and never with the login switched off.
set -eu

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

token="${AGENT_HUB_TOKEN:-}"
lower="$(printf '%s' "$token" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
host="${HOST:-127.0.0.1}"

case "$host" in
  127.*|localhost|::1|'[::1]') loopback=1 ;;
  *) loopback=0 ;;
esac

if [ "$loopback" = 0 ]; then
  if [ "$lower" = "none" ]; then
    die "HOST=$host 會讓中控台可以從容器外連進來，此時不能設 AGENT_HUB_TOKEN=none（那會關掉登入，等於把所有已連接的電腦交給任何連得到的人）。請設一個隨機密碼，例如 -e AGENT_HUB_TOKEN=\$(openssl rand -hex 16)。"
  fi
  if [ -z "$lower" ]; then
    die "HOST=$host 會讓中控台可以從容器外連進來，必須指定登入密碼：請用 -e AGENT_HUB_TOKEN=... 設定（例如 \$(openssl rand -hex 16)，只用英數字才能用 #token= 網址登入）。並建議只把埠發佈在 127.0.0.1 後面接 TLS 反向代理。"
  fi
fi

exec node server/index.js "$@"
