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

# 2. Push a dated copy + a stable 'latest'
rclone copyto "$TMP" "$REMOTE/privacy_budget_${STAMP}.json"
rclone copyto "$TMP" "$REMOTE/privacy_budget_latest.json"

# 3. Prune dated copies older than 30 days (never touches '_latest')
rclone delete "$REMOTE" --min-age 30d --include "privacy_budget_2*.json" 2>/dev/null || true

# 4. Record the success time for the dashboard's Backups status (fast DB read).
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q -c \
  "INSERT INTO dashboard_settings (key, value, updated_at) \
   VALUES ('privacy.cloud_backup', json_build_object('last_ok', to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()) \
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();" 2>/dev/null || true

rm -f "$TMP"
echo "$(date '+%F %T') privacy budget cloud backup OK -> $REMOTE"
