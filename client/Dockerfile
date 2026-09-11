# =============================================================================
# Node-Proxy Client - Dockerfile
# =============================================================================
FROM node:24-alpine

WORKDIR /app

# Copy client code
COPY . .

# Install dependencies (only ws)
RUN npm install --omit=dev

# Liveness watchdog used by HEALTHCHECK below (see healthcheck.sh)
RUN chmod +x /app/healthcheck.sh

# Create directory for config
RUN mkdir -p /app/config

# Non-root user for security
RUN addgroup -S node-proxy && adduser -S node-proxy -G node-proxy \
    && chown -R node-proxy:node-proxy /app
USER node-proxy

ENV NODE_ENV=production

# Default: connect to local server (override via env)
ENV SERVER_URL=ws://127.0.0.1:3000/ws

# Out-of-process liveness watchdog. The client writes a beacon file every 10s;
# when it goes stale the event loop is stalled and healthcheck.sh restarts the
# container (the restart policy brings it back). Such a stall cannot be caught
# from inside the process, and it leaves the node silently disconnected.
# Tune with WATCHDOG_STALE_SECONDS (0 = report only), disable by overriding the
# health check in compose. Invoked through /bin/sh so the script never depends
# on exec permissions or line endings.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["/bin/sh", "/app/healthcheck.sh"]

ENTRYPOINT ["node", "client.ts"]