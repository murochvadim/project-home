#!/bin/bash
# Privacy: encrypted OFF-SITE backup of the WHOLE project folder to Google Drive.
#
# Chains onto the existing Windows backup: takes the newest QNAP snapshot that the
# "Claude Project Folder" job already produced, tars it (excluding node_modules +
# .git), encrypts it with gpg AES-256 (symmetric; passphrase in
# /etc/privacy-project-backup.pass — root-only, also kept in Vaultwarden), and
# uploads the single .gpg to Google Drive via the drive.file-scoped `gdrive_sheets`
# remote (can touch ONLY its own files). Google ever sees ONLY ciphertext.
# Source of truth: scripts/privacy-project-cloud-backup.sh
#
# Restore: rclone copy the .gpg back → gpg --decrypt --passphrase-file ... → tar xzf
#          → npm install (to rebuild node_modules).
set -e

DB_HOST="192.168.1.219"
DB_NAME="home_data"
DB_USER="postgres"
SNAP_BASE="/mnt/qnap-claude/Claude Project"
PASSFILE="/etc/privacy-project-backup.pass"
REMOTE="gdrive_sheets:Claude_Project_Enc"
RETAIN_DAYS=14
STAMP="$(date '+%Y-%m-%d')"
TMP="/tmp/project_home_${STAMP}.tar.gz.gpg"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -tA -q"
JOB_NAME="Project Folder (Drive)"   # disabled backup_jobs row → just gives this run a name in the Recent Backup Log
LOG_ID=""
mark_fail() { [ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='failed', finished_at=now(), message='script aborted' WHERE id=$LOG_ID AND status='running'" >/dev/null 2>&1; }
trap mark_fail EXIT

[ -r "$PASSFILE" ] || { echo "$(date '+%F %T') passphrase file missing — abort"; exit 1; }

# newest snapshot dir (path has a space → quote everything)
NEWEST="$(ls -1dt "$SNAP_BASE"/*/ 2>/dev/null | head -1)"
if [ -z "$NEWEST" ] || [ ! -d "${NEWEST}project_home" ]; then
  echo "$(date '+%F %T') no project_home snapshot yet — skip"
  exit 0
fi

# open a 'running' Recent-Backup-Log row (look up the disabled job by name)
JOB_ID=$($PSQL -c "SELECT id FROM backup_jobs WHERE name='$JOB_NAME' LIMIT 1" | tr -d '[:space:]')
[ -n "$JOB_ID" ] && LOG_ID=$($PSQL -c "INSERT INTO backup_log(job_id,started_at,status,message) VALUES ($JOB_ID, now(), 'running', 'started') RETURNING id" | tr -d '[:space:]')

# tar (exclude node_modules + .git) → gzip → gpg AES-256
tar czf - --exclude=node_modules --exclude=.git -C "$NEWEST" project_home \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o "$TMP"

[ -s "$TMP" ] || { echo "$(date '+%F %T') encryption produced empty file — abort"; rm -f "$TMP"; exit 1; }

# upload a dated copy + a stable 'latest'
rclone copyto "$TMP" "$REMOTE/project_home_${STAMP}.tar.gz.gpg"
rclone copyto "$TMP" "$REMOTE/project_home_latest.tar.gz.gpg"

# prune dated copies older than RETAIN_DAYS (from settings; never touches '_latest')
RETAIN_DAYS=$($PSQL -c "SELECT value->>'project_days' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$RETAIN_DAYS" in ''|*[!0-9]*) RETAIN_DAYS=14 ;; esac
[ "$RETAIN_DAYS" -lt 1 ] && RETAIN_DAYS=1
rclone delete "$REMOTE" --min-age ${RETAIN_DAYS}d --include "project_home_2*.tar.gz.gpg" 2>/dev/null || true

# record success time for the dashboard status
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q -c \
  "INSERT INTO dashboard_settings (key, value, updated_at) \
   VALUES ('privacy.project_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) \
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();" 2>/dev/null || true

# close the Recent-Backup-Log row as ok
SIZE_BYTES=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
[ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='ok', finished_at=now(), size_bytes=$SIZE_BYTES, message='success' WHERE id=$LOG_ID" >/dev/null 2>&1

SZ="$(du -h "$TMP" | awk '{print $1}')"
rm -f "$TMP"
echo "$(date '+%F %T') privacy project cloud backup OK ($SZ) -> $REMOTE"
