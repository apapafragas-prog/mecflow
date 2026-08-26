#!/bin/sh
# Runtime entrypoint. The container runs as the unprivileged 'node' user (see docker-compose.yml
# `user: node`), the root filesystem is read-only, and only /data (volume) and /tmp (tmpfs) are writable.
# The /data volume must be owned by uid 1000 (node) on the host — one-time on an existing install:
#   sudo chown -R 1000:1000 <host-data-dir>
set -e
mkdir -p /data/files 2>/dev/null || true

if [ ! -w /data ]; then
  echo "FATAL: /data is not writable by the 'node' user (uid 1000)."
  echo "Fix on the host once:  sudo chown -R 1000:1000 <the ./data folder bind-mounted to /data>"
  exit 1
fi

# First-run database initialisation (idempotent — only when the DB doesn't exist yet).
[ -f /data/cbre.db ] || { echo "First run — initialising database…"; node init-db.js; }

exec node server.js
