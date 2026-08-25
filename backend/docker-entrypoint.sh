#!/bin/sh
# Runtime entrypoint: run privileged setup, then drop to the unprivileged 'node' user.
# The container root filesystem is read-only (see docker-compose.yml); only /data (volume) and
# /tmp (tmpfs) are writable.
set -e

# Bind-mounted volumes are often root-owned on the host (e.g. a Synology ./data folder). Fix ownership
# so the non-root 'node' user can read/write the DB and uploaded files. Ignore failures on exotic FSes.
mkdir -p /data /data/files
chown -R node:node /data 2>/dev/null || true

# First-run database initialisation (idempotent — only when the DB doesn't exist yet).
if [ ! -f /data/cbre.db ]; then
  echo "First run — initialising database…"
  su-exec node node init-db.js
fi

# Drop root and run the server as 'node'.
exec su-exec node node server.js
