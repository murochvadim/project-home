#!/bin/bash
# Database OFF-SITE backup (LXC 104, nightly cron). pg_dump -Fc (client 16, since
# the server is PG16) → gpg AES256 → rclone rcat → gdrive_sheets:DB_Backups
# (drive.file remote — touches ONLY its own files). FULLY STREAMED (no temp file;
# LXC 104 rootfs is small). Ciphertext only; passphrase /etc/privacy-project-backup.pass
# (root-only + Vaultwarden). Retention from dashboard_settings.privacy.cloud_retention.db_days
# (min 1, default 30). Logs to Recent Backup Log via the disabled "Database (Drive)" job.
set -eo pipefail

DB_HOST="192.168.1.219"; DB_NAME="home_data"; DB_USER="postgres"
PGDUMP="/usr/lib/postgresql/16/bin/pg_dump"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -tA -q"
PASSFILE="/etc/privacy-project-backup.pass"
REMOTE="gdrive_sheets:DB_Backups"
STAMP="$(date '+%Y-%m-%d')"
JOB_NAME="Database (Drive)"

[ -r "$PASSFILE" ] || { echo "$(date '+%F %T') passphrase missing — abort"; exit 1; }

# retention (days) — clamp to >= 1, default 30
KEEP=$($PSQL -c "SELECT value->>'db_days' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$KEEP" in ''|*[!0-9]*) KEEP=30 ;; esac
[ "$KEEP" -lt 1 ] && KEEP=1

# open a 'running' Recent-Backup-Log row
LOG_ID=""
JOB_ID=$($PSQL -c "SELECT id FROM backup_jobs WHERE name='$JOB_NAME' LIMIT 1" | tr -d '[:space:]')
[ -n "$JOB_ID" ] && LOG_ID=$($PSQL -c "INSERT INTO backup_log(job_id,started_at,status,message) VALUES ($JOB_ID,now(),'running','started') RETURNING id" | tr -d '[:space:]')
mark_fail() { [ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='failed',finished_at=now(),message='script aborted' WHERE id=$LOG_ID AND status='running'" >/dev/null 2>&1; }
trap mark_fail EXIT

# dump → encrypt → stream straight to Drive (no temp file). HARDENING against the
# shared rclone client_id rate limit (Error 403 "Queries per minute" on the shared
# project — the ~146 MB stream was tripping it most nights, see backup docs):
#   --drive-chunk-size 128M  → ~2 upload chunks instead of ~18 (8M default) = ~9x
#                              fewer API calls, so far less likely to hit the quota
#   --tpslimit / --low-level-retries → stay under ~10 tps + ride out transient 403s
#   outer 3x loop            → rcat can't replay a pipe, so we re-dump on failure
# REAL fix = a personal Google client_id on the gdrive_sheets remote (rclone's own
# recommendation; the shared default is heavily used). This only reduces the odds.
RC_OPTS="--drive-chunk-size 128M --tpslimit 6 --low-level-retries 20"
up_ok=0
for attempt in 1 2 3; do
  if PGPASSWORD='' "$PGDUMP" -h "$DB_HOST" -U "$DB_USER" -Fc "$DB_NAME" \
      | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" \
      | rclone rcat $RC_OPTS "$REMOTE/home_data_${STAMP}.dump.gpg"; then
    up_ok=1; break
  fi
  echo "$(date '+%F %T') upload attempt $attempt failed (rate limit?) — retry in 90s"
  sleep 90
done
[ "$up_ok" = 1 ] || { echo "$(date '+%F %T') DB cloud backup FAILED after 3 attempts (shared client_id quota — set a personal client_id)"; exit 1; }

# refresh 'latest' (server-side copy on Drive) + prune dated > KEEP days
rclone copyto "$REMOTE/home_data_${STAMP}.dump.gpg" "$REMOTE/home_data_latest.dump.gpg"
rclone delete "$REMOTE" --min-age ${KEEP}d --include "home_data_2*.dump.gpg" 2>/dev/null || true

SZ=$(rclone size "$REMOTE/home_data_${STAMP}.dump.gpg" --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("bytes",0))' 2>/dev/null || echo 0)

# status + close log
$PSQL -c "INSERT INTO dashboard_settings(key,value,updated_at) VALUES ('privacy.db_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();" >/dev/null 2>&1 || true
[ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='ok',finished_at=now(),size_bytes=${SZ:-0},message='success' WHERE id=$LOG_ID" >/dev/null 2>&1
echo "$(date '+%F %T') DB cloud backup OK ($((SZ/1024/1024)) MB, keep ${KEEP}d) -> $REMOTE"
