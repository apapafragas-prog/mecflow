#!/bin/sh
# Nightly backup of the CBRE Reporting app (SQLite + uploaded files).
# Consistent DB snapshot via better-sqlite3's backup API inside the container
# (never copy a live .db file directly). Rotation: 7 daily / 4 weekly / 12 monthly.
# Run from Synology Task Scheduler as root, daily at 02:00:
#   bash /volume1/docker/cbre/backup-cbre.sh
set -u
BASE=/volume1/docker/cbre
DEST=/volume1/docker/cbre-backups
CONTAINER=cbre-reporting
DATE=$(date +%Y-%m-%d)
DOW=$(date +%u)   # 1..7 (7 = Sunday)
DOM=$(date +%d)

mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/monthly"

# 1) Consistent SQLite snapshot written to the shared /data volume
docker exec "$CONTAINER" node -e "
  const D=require('better-sqlite3');
  const db=new D('/data/cbre.db',{readonly:true});
  db.backup('/data/.backup-tmp.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
" || { echo "$(date) BACKUP FAILED: sqlite snapshot" >> "$DEST/backup.log"; exit 1; }

# 2) Archive: DB snapshot + uploaded files
tar -czf "$DEST/daily/cbre-$DATE.tar.gz" -C "$BASE/data" .backup-tmp.db files 2>>"$DEST/backup.log" \
  || { echo "$(date) BACKUP FAILED: tar" >> "$DEST/backup.log"; rm -f "$BASE/data/.backup-tmp.db"; exit 1; }
rm -f "$BASE/data/.backup-tmp.db"

# 3) Weekly (Sunday) and monthly (1st) copies
[ "$DOW" = "7" ]  && cp -f "$DEST/daily/cbre-$DATE.tar.gz" "$DEST/weekly/"
[ "$DOM" = "01" ] && cp -f "$DEST/daily/cbre-$DATE.tar.gz" "$DEST/monthly/"

# 4) Rotation
ls -1t "$DEST/daily"/*.tar.gz   2>/dev/null | tail -n +8  | xargs -r rm -f
ls -1t "$DEST/weekly"/*.tar.gz  2>/dev/null | tail -n +5  | xargs -r rm -f
ls -1t "$DEST/monthly"/*.tar.gz 2>/dev/null | tail -n +13 | xargs -r rm -f

SIZE=$(du -h "$DEST/daily/cbre-$DATE.tar.gz" | cut -f1)
echo "$(date) backup ok: cbre-$DATE.tar.gz ($SIZE)" >> "$DEST/backup.log"

# 5) OFFSITE (recommended): point Synology Hyper Backup at /volume1/docker/cbre-backups
#    so a NAS disk failure or ransomware cannot take out the backups too.
