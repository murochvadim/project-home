#!/bin/bash
# Privacy Budget OFF-SITE backup (LXC 104, nightly cron).
#
# Dumps the ENCRYPTED Budget workbook blob from PostgreSQL (LXC 102) and pushes
# it to Google Drive via a DEDICATED rclone remote `gdrive_sheets` whose OAuth
# scope is `drive.file` — that scope lets rclone touch ONLY its own files, so it
# can NEVER read, modify, or delete the rest of the user's Drive (the Cryptomator
# vault or anything else). Ciphertext only; the Documents password is never
# involved, so this is safe + unattended. Mirrors scripts/privacy-vault-backup.sh.
#
# Setup (one-time, see PRIVACY/SPREADSHEETS_PLAN.md Phase 3):
#   on the laptop:  rclone authorize "drive" --drive-scope=drive.file
#   on LXC 104:     rclone config create gdrive_sheets drive scope=drive.file token='<paste>'
set -e

DB_HOST="192.168.1.219"
DB_NAME="home_data"
DB_USER="postgres"
REMOTE="gdrive_sheets:Privacy_Budget"
TMP="/tmp/privacy_budget.json"
STAMP="$(date '+%Y-%m-%d')"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -tA -q"
JOB_NAME="Privacy Budget (Drive)"   # disabled backup_jobs row → just gives this run a name in the Recent Backup Log
LOG_ID=""
# If we abort after opening a 'running' log row, mark it failed.
mark_fail() { [ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='failed', finished_at=now(), message='script aborted' WHERE id=$LOG_ID AND status='running'" >/dev/null 2>&1; }
trap mark_fail EXIT

# 1. Dump the encrypted blob (ciphertext) to a temp file
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -A -c \
  "SELECT json_build_object('enc_data',enc_data,'enc_iv',enc_iv,'updated_at',updated_at,'id',id)::text \
     FROM privacy_sheets WHERE id=1" > "$TMP"

# bail if there's nothing to back up (no row / empty)
if [ ! -s "$TMP" ]; then
  echo "$(date '+%F %T') no Budget data — skip"
  rm -f "$TMP"
  exit 0
fi

# open a 'running' Recent-Backup-Log row (look up the disabled job by name)
JOB_ID=$($PSQL -c "SELECT id FROM backup_jobs WHERE name='$JOB_NAME' LIMIT 1" | tr -d '[:space:]')
[ -n "$JOB_ID" ] && LOG_ID=$($PSQL -c "INSERT INTO backup_log(job_id,started_at,status,message) VALUES ($JOB_ID, now(), 'running', 'started') RETURNING id" | tr -d '[:space:]')

# 2. Push a dated copy + a stable 'latest'
rclone copyto "$TMP" "$REMOTE/privacy_budget_${STAMP}.json"
rclone copyto "$TMP" "$REMOTE/privacy_budget_latest.json"

# 3. Prune dated copies older than 30 days (never touches '_latest')
BKEEP=$($PSQL -c "SELECT value->>'budget_days' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$BKEEP" in ''|*[!0-9]*) BKEEP=30 ;; esac
[ "$BKEEP" -lt 1 ] && BKEEP=1
rclone delete "$REMOTE" --min-age ${BKEEP}d --include "privacy_budget_2*.json" 2>/dev/null || true

# 4. Record the success time for the dashboard's Backups status (fast DB read).
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q -c \
  "INSERT INTO dashboard_settings (key, value, updated_at) \
   VALUES ('privacy.cloud_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) \
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();" 2>/dev/null || true

# close the Recent-Backup-Log row as ok
SIZE_BYTES=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
[ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='ok', finished_at=now(), size_bytes=$SIZE_BYTES, message='success' WHERE id=$LOG_ID" >/dev/null 2>&1

rm -f "$TMP"
echo "$(date '+%F %T') privacy budget cloud backup OK -> $REMOTE"
