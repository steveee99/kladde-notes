FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Patched dependency copies referenced by "overrides" in package.json
COPY vendor ./vendor
COPY packages/shared/package*.json ./packages/shared/
COPY packages/server/package*.json ./packages/server/
COPY packages/client/package*.json ./packages/client/
RUN npm install

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/client ./packages/client

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/server
RUN npm run build --workspace=packages/client

# Production runner stage
FROM node:24-alpine AS runner

# su-exec: the entrypoint drops from root to the "node" user after fixing the volume's owner
RUN apk add --no-cache su-exec

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002
# SQLite (node:sqlite), key file and encrypted attachments live next to it; mount a volume here
ENV DB_PATH=/app/data/kladde.sqlite

COPY package*.json ./
# Patched dependency copies referenced by "overrides" in package.json
COPY vendor ./vendor
COPY packages/shared/package*.json ./packages/shared/
COPY packages/server/package*.json ./packages/server/
COPY packages/client/package*.json ./packages/client/
RUN npm install --omit=dev --workspace=packages/server --workspace=packages/shared

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/client/dist ./packages/client/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Program files stay owned by root (read-only for the server), only the data directory is the server's
RUN mkdir -p /app/data /app/export && chown node:node /app/data /app/export && chmod 700 /app/data && chmod 755 /usr/local/bin/docker-entrypoint.sh
VOLUME ["/app/data"]

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
