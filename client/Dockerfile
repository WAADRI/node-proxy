# =============================================================================
# Node-Proxy Client - Dockerfile
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Copy client code
COPY . .

# Install dependencies (only ws)
RUN npm install --omit=dev

# Create directory for config
RUN mkdir -p /app/config

# Non-root user for security
RUN addgroup -S node-proxy && adduser -S node-proxy -G node-proxy \
    && chown -R node-proxy:node-proxy /app
USER node-proxy

ENV NODE_ENV=production

# Default: connect to local server (override via env)
ENV SERVER_URL=ws://127.0.0.1:3000/ws

ENTRYPOINT ["node", "client.js"]