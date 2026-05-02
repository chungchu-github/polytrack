#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# Polytrack — Daily SQLite backup
#
# Uses sqlite3 .backup (online, WAL-safe) rather than raw cp — cp can corrupt
# a live WAL database. Keeps the latest N days, gzips old backups.
#
# Hardened 2026-05-02 after a production disk-full crash:
#   1. Default KEEP_DAYS lowered 30 → 7 (8.5G of compressed backups on a
#      23G VPS pushed disk to 100% and locked out logins).
#   2. Prune runs FIRST so a tight-disk situation removes old backups
#      before trying to write a new one.
#   3. Pre-flight disk check: refuse to back up if free space < (DB size +
#      500 MB) — better to skip a day than die mid-write and leave a
#      half-baked file that the next day can't clean up either.
#   4. Trap removes any in-flight .db / .db.gz on failure.
#
# Usage:
#   ./scripts/backup-db.sh                  # run once
#   KEEP_DAYS=14 ./scripts/backup-db.sh     # keep 14 days (default 7)
#   FORCE=1 ./scripts/backup-db.sh          # bypass disk-space precheck
#
# Cron / PM2:
#   0 3 * * *  cd /home/polytrack/polytrack && ./scripts/backup-db.sh \
#              >> data/logs/backup.log 2>&1
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/polytrack.db"
DEST_DIR="$ROOT/data/backups"
KEEP_DAYS="${KEEP_DAYS:-7}"
FORCE="${FORCE:-0}"
SAFETY_MARGIN_BYTES="${SAFETY_MARGIN_BYTES:-524288000}"  # 500 MB
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST_DIR/polytrack-$STAMP.db"
OUT_GZ="$OUT.gz"

# Cleanup half-written files on any failure.
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    rm -f "$OUT" "$OUT_GZ" "$OUT.tmp" 2>/dev/null || true
    echo "[backup-db] FAILED (exit $rc) — cleaned partials" >&2
  fi
}
trap on_exit EXIT

if [[ ! -f "$DB" ]]; then
  echo "[backup-db] source not found: $DB" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup-db] sqlite3 CLI not installed (apt install sqlite3)" >&2
  exit 2
fi

mkdir -p "$DEST_DIR"

# ── 1. Prune old backups FIRST so a tight-disk run frees room before write ──
PRUNED=$(find "$DEST_DIR" -name 'polytrack-*.db.gz' -type f -mtime "+$KEEP_DAYS" -delete -print | wc -l | tr -d ' ')
if [[ "$PRUNED" -gt 0 ]]; then
  echo "[backup-db] pruned $PRUNED backups older than ${KEEP_DAYS}d"
fi

# ── 2. Pre-flight: is there enough disk space? ─────────────────────────────
DB_SIZE=$(stat -c%s "$DB" 2>/dev/null || stat -f%z "$DB" 2>/dev/null || echo 0)
# Free space on the partition holding DEST_DIR. df -P prints in 1K blocks.
FREE_KB=$(df -P "$DEST_DIR" | awk 'NR==2 { print $4 }')
FREE_BYTES=$(( FREE_KB * 1024 ))
NEED_BYTES=$(( DB_SIZE + SAFETY_MARGIN_BYTES ))

if [[ "$FORCE" != "1" && "$FREE_BYTES" -lt "$NEED_BYTES" ]]; then
  echo "[backup-db] SKIPPING — disk free $((FREE_BYTES/1024/1024))MB < required $((NEED_BYTES/1024/1024))MB (DB + 500MB margin). Use FORCE=1 to override." >&2
  # Treat as success so the cron doesn't trigger alerts every day until
  # disk gets cleared. Operator should see the WARN line in logs.
  trap - EXIT
  exit 0
fi

# ── 3. Backup (atomic vs concurrent writes — unlike cp on a WAL file) ──────
sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"

SIZE="$(du -h "$OUT_GZ" | awk '{print $1}')"
TOTAL=$(ls -1 "$DEST_DIR" 2>/dev/null | wc -l | tr -d ' ')
echo "[backup-db] wrote $OUT_GZ ($SIZE) · keep=${KEEP_DAYS}d total=$TOTAL"

# Disable trap on clean exit
trap - EXIT
