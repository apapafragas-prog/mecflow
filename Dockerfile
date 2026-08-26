# ── Stage 1: Build the frontend ──────────────────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/vite.config.js frontend/index.html ./
RUN npm install
COPY frontend/src ./src
RUN npm run build

# ── Stage 2: Compile backend deps (native modules build here; toolchain never ships) ─────────────────
FROM node:20-alpine AS backend-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json ./
RUN npm install --omit=dev

# ── Stage 3: Runtime — slim, non-root, no build toolchain ────────────────────────────────────────────
# NOTE: pin the base image by digest (node:20-alpine@sha256:...) in CI for reproducible, attested builds.
FROM node:20-alpine
WORKDIR /app
# Runs as the unprivileged 'node' user (set in docker-compose.yml). No privilege-drop tooling needed.
COPY --from=backend-deps /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/server.js backend/init-db.js ./
COPY backend/lib ./lib
COPY --from=frontend /app/dist ./public
COPY backend/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data /data/files && chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

# Entrypoint verifies /data is writable, runs first-time DB init, then execs the server (as 'node').
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
