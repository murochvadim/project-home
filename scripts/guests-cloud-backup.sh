#!/bin/bash
# Guest images OFF-SITE backup (LXC 104, weekly cron). For each guest 100-110, take
# the NEWEST vzdump from the READ-ONLY /mnt/pbs mount (LXCs = .tar.zst, the HA VM =
# .vma.zst), gpg AES256 → rclone rcat (STREAMED, no temp file) → drive.file remote
# gdrive_sheets:Guest_Images/<id>/. Ciphertext only; passphrase
# /etc/privacy-project-backup.pass. Retention guests_weeks from
# dashboard_settings.privacy.cloud_retention (min 1, default 4). Logs to Recent
# Backup Log via the disabled "Guest Images (Drive)" job.
#
# Usage: guests-cloud-backup.sh [guest_id]   (no arg = all 100-110; arg = just that one)
set -eo pipefail

DB_HOST="192.168.1.219"; DB_NAME="home_data"; DB_USER="postgres"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -tA -q"
PASSFILE="/etc/privacy-project-backup.pass"
PBS="/mnt/pbs"
REMOTE="gdrive_sheets:Guest_Images"
JOB_NAME="Guest Images (Drive)"
GUESTS="100 101 102 103 104 105 106 107 108 109 110 111"
[ -n "$1" ] && GUESTS="$1"

# HARDENING vs the shared rclone client_id rate limit (Error 403 "Queries per
# minute"), same as db-cloud-backup.sh — see backup docs. These images are
# GB-scale so 128M chunks cut the API-call count hard; a personal client_id on
# the gdrive_sheets remote is the real fix (own quota). Per-guest 3x retry below.
RC_OPTS="--drive-chunk-size 128M --tpslimit 6 --low-level-retries 20"

[ -r "$PASSFILE" ] || { echo "$(date '+%F %T') passphrase missing — abort"; exit 1; }
mountpoint -q "$PBS" || { echo "$(date '+%F %T') $PBS not mounted — abort"; exit 1; }

# retention (COPIES per guest) — clamp >= 1, default 4
GKEEP=$($PSQL -c "SELECT value->>'guests_copies' FROM dashboard_settings WHERE key='privacy.cloud_retention'" 2>/dev/null | tr -d '[:space:]')
case "$GKEEP" in ''|*[!0-9]*) GKEEP=4 ;; esac
[ "$GKEEP" -lt 1 ] && GKEEP=4

# open a 'running' Recent-Backup-Log row
LOG_ID=""
JOB_ID=$($PSQL -c "SELECT id FROM backup_jobs WHERE name='$JOB_NAME' LIMIT 1" | tr -d '[:space:]')
[ -n "$JOB_ID" ] && LOG_ID=$($PSQL -c "INSERT INTO backup_log(job_id,started_at,status,message) VALUES ($JOB_ID,now(),'running','started') RETURNING id" | tr -d '[:space:]')
mark_fail() { [ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='failed',finished_at=now(),message='script aborted' WHERE id=$LOG_ID AND status='running'" >/dev/null 2>&1; }
trap mark_fail EXIT

TOTAL=0; DONE=0
for id in $GUESTS; do
  # newest backup for this guest (filenames are date-stamped → name sort = chronological)
  f=$(find "$PBS" -maxdepth 3 \( -name "vzdump-lxc-${id}-*.tar.zst" -o -name "vzdump-qemu-${id}-*.vma.zst" \) 2>/dev/null | sort | tail -1)
  [ -z "$f" ] && { echo "guest $id: no backup found — skip"; continue; }
  base="$(basename "$f")"
  sz=$(stat -c%s "$f")
  # stream gpg -> rcat, 3x retry (rcat can't replay a pipe, so re-gpg on failure)
  up_ok=0
  for attempt in 1 2 3; do
    if gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o - "$f" \
        | rclone rcat $RC_OPTS "$REMOTE/$id/${base}.gpg"; then
      up_ok=1; break
    fi
    echo "$(date '+%F %T') guest $id upload attempt $attempt failed (rate limit?) — retry in 90s"
    sleep 90
  done
  [ "$up_ok" = 1 ] || { echo "$(date '+%F %T') guest $id FAILED after 3 attempts — skip"; continue; }
  rclone copyto "$REMOTE/$id/${base}.gpg" "$REMOTE/$id/latest.gpg"
  rclone lsf "$REMOTE/$id" --include "vzdump-*.gpg" 2>/dev/null | sort | head -n -${GKEEP} | while read -r f; do rclone deletefile "$REMOTE/$id/$f" 2>/dev/null || true; done
  TOTAL=$((TOTAL+sz)); DONE=$((DONE+1))
  echo "guest $id: $((sz/1024/1024)) MB -> $REMOTE/$id"
done

$PSQL -c "INSERT INTO dashboard_settings(key,value,updated_at) VALUES ('privacy.guests_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();" >/dev/null 2>&1 || true
[ -n "$LOG_ID" ] && $PSQL -c "UPDATE backup_log SET status='ok',finished_at=now(),size_bytes=${TOTAL},message='${DONE} guest(s)' WHERE id=$LOG_ID" >/dev/null 2>&1
echo "$(date '+%F %T') guests cloud backup OK (${DONE} guest(s), $((TOTAL/1024/1024)) MB, keep ${WEEKS}w)"
