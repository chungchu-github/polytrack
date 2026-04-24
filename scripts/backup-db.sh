#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# Polytrack — Daily SQLite backup
#
# Uses sqlite3 .backup (online, WAL-safe) rather than raw cp — cp can corrupt
# a live WAL database. Keeps the latest N days, gzips old backups.
#
# Usage:
#   ./scripts/backup-db.sh                  # run once
#   KEEP_DAYS=14 ./scripts/backup-db.sh     # keep 14 days (default 30)
#
# Cron / PM2:
#   crontab -e
#   0 3 * * *  cd /Users/darkagent001/polytrack && ./scripts/backup-db.sh \
#              >> data/logs/backup.log 2>&1
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/polytrack.db"
DEST_DIR="$ROOT/data/backups"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST_DIR/polytrack-$STAMP.db"

if [[ ! -f "$DB" ]]; then
  echo "[backup-db] source not found: $DB" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup-db] sqlite3 CLI not installed (brew install sqlite / apt install sqlite3)" >&2
  exit 2
fi

mkdir -p "$DEST_DIR"

# .backup is atomic vs concurrent writes (unlike cp on a WAL file)
sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"

SIZE="$(du -h "$OUT.gz" | awk '{print $1}')"
echo "[backup-db] wrote $OUT.gz ($SIZE)"

# Prune anything older than KEEP_DAYS days
find "$DEST_DIR" -name 'polytrack-*.db.gz' -type f -mtime "+$KEEP_DAYS" -print -delete \
  | sed 's/^/[backup-db] pruned /'

echo "[backup-db] done. keep=${KEEP_DAYS}d, total=$(ls -1 "$DEST_DIR" | wc -l | tr -d ' ') backups"
