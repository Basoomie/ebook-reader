FROM node:22-alpine AS builder
WORKDIR /app
# Toolchain for better-sqlite3, used only if no prebuilt binary matches.
# It stays in this stage; the runtime image gets the finished node_modules.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Character counter (WP3b): generated from the web app's import code, see apps/web/scripts/build-server-counter.ts.
COPY vendor/ ./vendor/
EXPOSE 3001
# Unhealthy when the database is unavailable (the legacy endpoints still work then).
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3001}/api/v1/health" || exit 1
CMD ["node", "dist/index.js"]
