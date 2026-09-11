# =============================================================================
# Node-Proxy Client - Dockerfile
# =============================================================================
FROM node:24-alpine

WORKDIR /app

# Copy client code
COPY . .

# Install dependencies (only ws)
RUN npm install --omit=dev

# Liveness supervisor run as PID 1 (see docker-entrypoint.sh)
RUN chmod +x /app/docker-entrypoint.sh

# Create directory for config
RUN mkdir -p /app/config

# Non-root user for security
RUN addgroup -S node-proxy && adduser -S node-proxy -G node-proxy \
    && chown -R node-proxy:node-proxy /app
USER node-proxy

ENV NODE_ENV=production

# Default: connect to local server (override via env)
ENV SERVER_URL=ws://127.0.0.1:3000/ws

# The client runs as a child of the supervisor, not as PID 1: a process cannot
# kill its own PID 1 (the kernel discards signals to a namespace init from
# inside that namespace), so only a parent can restart a client whose event loop
# has stalled. The client's stdout/stderr still reach `docker logs`, and the
# command stays overridable the usual way (`docker run <image> <cmd>`).
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["node", "client.ts"]