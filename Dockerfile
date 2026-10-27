# Agent Hub on a server / VPS. The hub only relays: Kimi itself runs on your
# machines (connected with the bridge), so this image needs no agent CLIs.
#
#   docker build -t agent-hub .
#   docker run -d -p 127.0.0.1:8787:8787 -v agent-hub-data:/data \
#     -e AGENT_HUB_TOKEN="$(openssl rand -hex 16)" agent-hub
#
# What this image does for safety, and what it leaves to you:
#  - It runs as an unprivileged user ("agenthub"), not as root. Everything the
#    hub keeps (login token, bridge key, conversations, workspaces) lives in the
#    volume /data, which that user owns with mode 0700. A bind mount must be
#    owned by that user too: `chown 10001:10001 <folder>`.
#  - A container has to listen on 0.0.0.0 to be reachable through a published
#    port, and the hub can run commands on every connected computer. So the
#    entrypoint (scripts/docker-entrypoint.sh) refuses to start on a
#    non-loopback address unless AGENT_HUB_TOKEN is set to a real password, and
#    never accepts AGENT_HUB_TOKEN=none (which switches the login off; the hub
#    itself also exits for none on a non-loopback address).
#  - The image speaks plain HTTP, so the login token crosses the network in
#    clear. Publish the port on 127.0.0.1 only (as above) and put a TLS reverse
#    proxy in front of it, or reach it through a tunnel; do not expose 8787 to
#    the internet directly.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN addgroup -S -g 10001 agenthub \
 && adduser -S -u 10001 -G agenthub -h /home/agenthub agenthub \
 && mkdir -p /data \
 && chown agenthub:agenthub /data \
 && chmod 0700 /data
ENV HOST=0.0.0.0 PORT=8787 HOME=/home/agenthub AGENT_HUB_DATA=/data AGENT_HUB_WORKSPACES=/data/workspaces
USER agenthub
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]
