#!/bin/bash
# Windows Laptop Backup Agent
# Runs on LXC 104 every 5 min via cron
# Reads jobs from PostgreSQL, pulls files from Windows via scp, stores on QNAP via SMB

DB_HOST="192.168.1.219"
DB_NAME="home_data"
DB_USER="postgres"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -t -A -q"
LOG="/var/log/backup-script.log"
LAPTOP_USER="muroc"
LAPTOP_IP="192.168.1.128"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# ── Clean stale 'running' entries older than 2h ──────────────────
$PSQL -c "UPDATE backup_log SET status='failed', finished_at=NOW(), message='interrupted' WHERE status='running' AND started_at < NOW() - INTERVAL '2 hours'" &>/dev/null

# ── Fetch all enabled jobs ────────────────────────────────────────
JOBS=$($PSQL -c "
  SELECT j.id, j.name, j.source_path, j.source_host, j.dest_subdir,
         j.max_age_hours, j.retention, j.run_now,
         s.share, s.smb_user, s.host
  FROM backup_jobs j
  JOIN backup_storages s ON s.id = j.storage_id
  WHERE j.enabled = TRUE
" 2>/dev/null)

if [ -z "$JOBS" ]; then
    exit 0
fi

# ── Process each job ─────────────────────────────────────────────
# Reachability is checked per-job against the job's source host (below), since
# jobs can now pull from different hosts (laptop, Raspberry Pi, …).
echo "$JOBS" | while IFS='|' read -r JOB_ID JOB_NAME SOURCE_PATH SRC_HOST DEST_SUBDIR MAX_AGE RETENTION RUN_NOW SHARE SMB_USER SMB_HOST; do
    [ -z "$JOB_ID" ] && continue

    # Check if backup is due
    LAST_OK=$($PSQL -c "
      SELECT EXTRACT(EPOCH FROM (NOW() - started_at))/3600
      FROM backup_log
      WHERE job_id=$JOB_ID AND status='ok'
      ORDER BY started_at DESC LIMIT 1
    " 2>/dev/null)

    OVERDUE=0
    [ -z "$LAST_OK" ] && OVERDUE=1
    [ -n "$LAST_OK" ] && awk "BEGIN{exit !($LAST_OK > $MAX_AGE)}" && OVERDUE=1
    [ "$RUN_NOW" = "t" ] && OVERDUE=1

    if [ "$OVERDUE" -eq 0 ]; then
        continue
    fi

    log "Job [$JOB_NAME] is due (overdue=$OVERDUE, run_now=$RUN_NOW)"

    # Insert started log entry
    LOG_ID=$($PSQL -c "INSERT INTO backup_log (job_id, started_at, status, message) VALUES ($JOB_ID, NOW(), 'running', 'started') RETURNING id" 2>/dev/null | tr -d ' ')
    if [ -z "$LOG_ID" ]; then
        log "Job [$JOB_NAME] SKIP — failed to create log entry (DB error?)"
        continue
    fi
    log "Job [$JOB_NAME] log_id=$LOG_ID"

    # Resolve source host — per-job source_host; default to the laptop for back-compat
    SRC="${SRC_HOST:-${LAPTOP_USER}@${LAPTOP_IP}}"
    if ! ssh -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SRC" "echo ok" &>/dev/null; then
        log "Job [$JOB_NAME] SKIP — source $SRC unreachable"
        $PSQL -c "
          UPDATE backup_log SET finished_at=NOW(), status='unreachable', message='source host not reachable'
          WHERE id=$LOG_ID
        " &>/dev/null
        continue
    fi

    # Resolve mount point — shares are pre-mounted on Proxmox host and bind-mounted into LXC
    # Claude_Data → /mnt/qnap-claude, Windows_Data → /mnt/qnap-windows
    case "$SHARE" in
        Claude_Data)  MOUNT_POINT="/mnt/qnap-claude" ;;
        Windows_Data) MOUNT_POINT="/mnt/qnap-windows" ;;
        *)            MOUNT_POINT="/mnt/qnap-${SHARE,,}" ;;
    esac

    if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        log "Job [$JOB_NAME] FAILED — mount point $MOUNT_POINT not available"
        $PSQL -c "
          UPDATE backup_log SET finished_at=NOW(), status='failed', message='mount point not available'
          WHERE id=$LOG_ID
        " &>/dev/null
        continue
    fi

    # Run scp
    TIMESTAMP=$(date '+%Y-%m-%d_%H%M%S')
    DEST_DIR="${MOUNT_POINT}/${DEST_SUBDIR}"
    DEST_PATH="${DEST_DIR}/${TIMESTAMP}"
    mkdir -p "$DEST_PATH"

    log "Job [$JOB_NAME] copying ${SRC}:${SOURCE_PATH} → $DEST_PATH"
    scp -o StrictHostKeyChecking=accept-new -o BatchMode=yes -r \
        "${SRC}:${SOURCE_PATH}" \
        "$DEST_PATH/" >> "$LOG" 2>&1
    SCP_RC=$?

    if [ $SCP_RC -eq 0 ]; then
        SIZE=$(du -sb "$DEST_PATH" 2>/dev/null | awk '{print $1}')
        log "Job [$JOB_NAME] OK — size=${SIZE} bytes"
        $PSQL -c "
          UPDATE backup_log SET finished_at=NOW(), status='ok', size_bytes=${SIZE:-0}, message='success'
          WHERE id=$LOG_ID
        " &>/dev/null

        # Rotate old backups — keep only last RETENTION copies
        DEST_DIR="${MOUNT_POINT}/${DEST_SUBDIR}"
        ls -1d "${DEST_DIR}"/[0-9]* 2>/dev/null | sort | head -n -${RETENTION} | while read -r OLD; do
            log "Job [$JOB_NAME] removing old backup: $OLD"
            rm -rf "$OLD"
        done

        # Clear run_now flag only on success so a failed run-now retries
        $PSQL -c "UPDATE backup_jobs SET run_now=FALSE WHERE id=$JOB_ID" &>/dev/null
    else
        log "Job [$JOB_NAME] FAILED — scp exit code $SCP_RC"
        rm -rf "$DEST_PATH"
        $PSQL -c "
          UPDATE backup_log SET finished_at=NOW(), status='failed', message='scp failed (exit $SCP_RC)'
          WHERE id=$LOG_ID
        " &>/dev/null
    fi
done
