# Agent Hub on a server / VPS. The hub only relays: Kimi itself runs on your
# machines (connected with the bridge), so this image needs no agent CLIs.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
