FROM node:22-bookworm-slim AS deps

WORKDIR /app/server

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY . .

RUN mkdir -p /app/public/recordings

EXPOSE 19000 19001 40000-40999/udp

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
