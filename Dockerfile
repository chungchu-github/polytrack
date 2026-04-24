# syntax=docker/dockerfile:1.7
# ─── Polytrack multi-stage build ─────────────────────────────────────────────
# Stage 1: build frontend (vite → static dist)
# Stage 2: install server deps (incl. native better-sqlite3 compile)
# Stage 3: slim runtime image with only node_modules + src + dist

# ── Stage 1: frontend build ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
# No package-lock.json is committed, so use install (not ci)
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── Stage 2: backend deps (needs toolchain for better-sqlite3) ───────────────
FROM node:20-alpine AS backend-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for safety
RUN addgroup -S polytrack && adduser -S polytrack -G polytrack

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Persistent data (SQLite DB + config.json) mounts here
RUN mkdir -p /app/data && chown -R polytrack:polytrack /app
VOLUME ["/app/data"]

USER polytrack

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
