# =============================================================================
# Node-Proxy Server - Dockerfile
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json ./
# NOTE: do NOT add native modules here (e.g. better-sqlite3) - the alpine
# image has no Python/gcc/make toolchain and GitHub prebuild downloads
# frequently time out on CN networks. storage.js uses pure-JS sql.js.
RUN npm install --omit=dev

# ---

FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy server code (data/certs/logs excluded via .dockerignore)
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data /app/certs /app/logs

EXPOSE 3000 8080 1080

VOLUME ["/app/data", "/app/certs", "/app/logs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

ENV NODE_ENV=production

ENTRYPOINT ["node", "server.js"]
CMD []