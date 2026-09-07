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
set -eo pipefail   # pipefail: a failed tar must abort, not feed gpg a truncated
                   # stream that uploads fine and then permanently prunes a good copy

# Drive deletes are PERMANENT, not trashed. Without this, both the retention
# prune below AND every *_latest overwrite leave the old copy in Drive's trash,
# where it still counts against the storage quota forever (157 GB accumulated
# in 8 weeks before this was caught, 2026-09-06). Applies to every rclone call.
export RCLONE_DRIVE_USE_TRASH=false

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

# prune to newest N COPIES (count-based; from settings; never touches '_latest')
KEEP=$($PSQL -c "SELECT value->>'project_copies' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$KEEP" in ''|*[!0-9]*) KEEP=4 ;; esac
[ "$KEEP" -lt 1 ] && KEEP=4
rclone lsf "$REMOTE" --include "project_home_2*.tar.gz.gpg" 2>/dev/null | sort | head -n -${KEEP} | while read -r f; do rclone deletefile "$REMOTE/$f" 2>/dev/null || true; done

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

# ---- Claude memory dir (tiny, high-value; snapshotted to QNAP by the 'Claude Memory' job) ----
# Reads the newest QNAP Claude_Memory snapshot (laptop-asleep-safe), encrypts + uploads it to the same
# Drive remote with a distinct prefix, count-prunes to newest N, and logs to the 'Claude Memory (Drive)' job.
MEM_BASE="/mnt/qnap-claude/Claude_Memory"
MEM_NEWEST="$(ls -1dt "$MEM_BASE"/*/ 2>/dev/null | head -1)"
MEM_KEEP=$($PSQL -c "SELECT value->>'memory_copies' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$MEM_KEEP" in ''|*[!0-9]*) MEM_KEEP=4 ;; esac
[ "$MEM_KEEP" -lt 1 ] && MEM_KEEP=4
MJOB=$($PSQL -c "SELECT id FROM backup_jobs WHERE name='Claude Memory (Drive)' LIMIT 1" | tr -d '[:space:]')
MLOG=""
[ -n "$MJOB" ] && MLOG=$($PSQL -c "INSERT INTO backup_log(job_id,started_at,status,message) VALUES ($MJOB, now(), 'running', 'started') RETURNING id" | tr -d '[:space:]')
if [ -n "$MEM_NEWEST" ] && [ -d "${MEM_NEWEST}memory" ]; then
  MEM_TMP="/tmp/claude_memory_${STAMP}.tar.gz.gpg"
  tar czf - -C "$MEM_NEWEST" memory \
    | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o "$MEM_TMP"
  if [ -s "$MEM_TMP" ]; then
    rclone copyto "$MEM_TMP" "$REMOTE/claude_memory_${STAMP}.tar.gz.gpg"
    rclone copyto "$MEM_TMP" "$REMOTE/claude_memory_latest.tar.gz.gpg"
    rclone lsf "$REMOTE" --include "claude_memory_2*.tar.gz.gpg" 2>/dev/null | sort | head -n -${MEM_KEEP} | while read -r f; do rclone deletefile "$REMOTE/$f" 2>/dev/null || true; done
    MSZ=$(stat -c%s "$MEM_TMP" 2>/dev/null || echo 0)
    [ -n "$MLOG" ] && $PSQL -c "UPDATE backup_log SET status='ok', finished_at=now(), size_bytes=$MSZ, message='success' WHERE id=$MLOG" >/dev/null 2>&1
    # own marker: privacy.project_backup is already written above, BEFORE this half
    # runs, and this upload's backup_log job is disabled — so without this a failing
    # memory upload is invisible to every check.
    $PSQL -c "INSERT INTO dashboard_settings(key,value,updated_at) VALUES ('privacy.memory_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();" >/dev/null 2>&1 || true
    echo "$(date '+%F %T') claude memory cloud backup OK ($(du -h "$MEM_TMP" | awk '{print $1}')) -> $REMOTE"
  else
    [ -n "$MLOG" ] && $PSQL -c "UPDATE backup_log SET status='failed', finished_at=now(), message='encryption produced empty file' WHERE id=$MLOG" >/dev/null 2>&1
    echo "$(date '+%F %T') claude memory encryption produced empty file — skip"
  fi
  rm -f "$MEM_TMP"
else
  [ -n "$MLOG" ] && $PSQL -c "UPDATE backup_log SET status='failed', finished_at=now(), message='no Claude_Memory QNAP snapshot yet' WHERE id=$MLOG" >/dev/null 2>&1
  echo "$(date '+%F %T') no Claude_Memory snapshot yet — skip memory upload"
fi
echo "$(date '+%F %T') privacy project cloud backup OK ($SZ) -> $REMOTE"
