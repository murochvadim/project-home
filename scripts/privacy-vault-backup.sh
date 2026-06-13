#!/bin/bash
# Privacy vault offsite-loss backup.
#
# Pulls the ENCRYPTED Cryptomator vault from Google Drive (read-only rclone
# token) down to QNAP. Ciphertext only — the vault password is NEVER involved,
# so this runs unattended and safely. Protects against losing the Google
# account (Drive is the primary offsite copy; QNAP is the local backup).
#
# Deploy: scp scripts/privacy-vault-backup.sh root@192.168.1.227:/opt/privacy-vault-backup.sh
#         (LXC 104 — the commands/timers server; has the QNAP mount + the
#          read-only rclone "gdrive" remote at /root/.config/rclone/rclone.conf)
# Cron (LXC 104):  15 3 * * * /opt/privacy-vault-backup.sh >> /var/log/privacy-vault-backup.log 2>&1
set -e
SRC="gdrive:Privacy"
DEST="/mnt/qnap-claude/Privacy_Vault"
mkdir -p "$DEST"
rclone sync "$SRC" "$DEST" --create-empty-src-dirs
echo "$(date '+%F %T') privacy vault backup OK -> $DEST"
