#!/bin/bash
# Laptop project_home backup → QNAP via NFS
# Runs on LXC 103 (192.168.1.114), pulls from Windows laptop via scp
# Cron: daily at 02:00

LAPTOP_USER="muroc"
LAPTOP_IP="192.168.1.128"
LAPTOP_PATH="C:/Users/muroc/project_home"
QNAP_DEST="/mnt/qnap-laptop/project_home"
TIMESTAMP=$(date '+%Y-%m-%d_%H%M')
LOG="/var/log/laptop-backup.log"
BACKUP_DIR="${QNAP_DEST}/${TIMESTAMP}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }

log "Starting backup → $BACKUP_DIR"

# Check QNAP mount is available
if ! mountpoint -q /mnt/qnap-laptop; then
    log "ERROR: /mnt/qnap-laptop is not mounted"
    exit 1
fi

# Check laptop is reachable
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "${LAPTOP_USER}@${LAPTOP_IP}" "echo ok" &>/dev/null; then
    log "ERROR: Cannot reach laptop at ${LAPTOP_IP}"
    exit 1
fi

mkdir -p "$BACKUP_DIR"

# Copy project_home recursively (scp -r)
scp -o StrictHostKeyChecking=no -r \
    "${LAPTOP_USER}@${LAPTOP_IP}:${LAPTOP_PATH}" \
    "${QNAP_DEST}/${TIMESTAMP}" >> "$LOG" 2>&1

if [ $? -eq 0 ]; then
    log "Backup OK → $BACKUP_DIR"
else
    log "ERROR: scp failed"
    exit 1
fi

# Keep only last 7 backups
cd "$QNAP_DEST" || exit 1
ls -1d */ 2>/dev/null | sort | head -n -7 | while read -r old; do
    log "Removing old backup: $old"
    rm -rf "$old"
done

log "Done."
