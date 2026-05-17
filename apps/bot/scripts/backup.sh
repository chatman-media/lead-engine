#!/usr/bin/env bash
# pg_dump the bot database into a custom-format archive ready for pg_restore.
#
# Designed to run from cron or a docker-compose sidecar. Reads
# DATABASE_URL from the environment (the same connection string the
# app uses). Writes to BACKUP_DIR (default /backups inside the
# container, ./backups locally).
#
# Filename includes UTC timestamp + ISO date so lexical sort gives
# chronological order. Retention is N most recent files by mtime
# (env BACKUP_KEEP, default 14 days × 1/day).
#
# Exits non-zero on any pg_dump failure; the upstream cron / health
# check should alert. Do NOT --no-password — pg_dump should fail loud
# if creds are missing rather than hang on stdin.
#
# Restore:
#   pg_restore -d $DATABASE_URL --clean --if-exists path/to/dump.pgc
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/tgchatbot-$ts.pgc"

echo "[backup] dumping to $out"
# -Fc → custom format (compressed, pg_restore-compatible).
# --no-owner / --no-privileges → portable across DBs with different role names.
pg_dump --no-owner --no-privileges --format=c --file="$out" "$DATABASE_URL"

# Restore-time sanity: pg_restore -l should list every table.
tables=$(pg_restore -l "$out" | grep -c "TABLE " || true)
echo "[backup] $out written (~$(du -h "$out" | cut -f1)), $tables tables in archive"

if [[ "$tables" -lt 10 ]]; then
  echo "[backup] WARN: only $tables tables in archive — dump may be incomplete" >&2
  exit 2
fi

# Prune anything older than the configured number of days.
echo "[backup] pruning files older than $BACKUP_KEEP days"
find "$BACKUP_DIR" -maxdepth 1 -name 'tgchatbot-*.pgc' -type f -mtime "+$BACKUP_KEEP" -print -delete

echo "[backup] done"
