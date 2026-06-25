# ── Stage 1: Build frontend ──
FROM node:20-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/vite.config.js frontend/index.html ./
RUN npm install
COPY frontend/src ./src
RUN npm run build

# ── Stage 2: Backend with frontend baked in ──
FROM node:20-alpine
WORKDIR /app

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++ py3-pip && pip3 install openpyxl --break-system-packages

COPY backend/package.json ./
RUN npm install --production

COPY backend/server.js backend/init-db.js backend/excel_report.py ./
COPY --from=frontend /app/dist ./public

# Create data dir
RUN mkdir -p /data /data/files

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

# Initialize DB on first run if not exists, then start server
CMD ["sh","-c","[ -f /data/cbre.db ] || node init-db.js; node server.js"]
