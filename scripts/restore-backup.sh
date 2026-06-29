#!/bin/bash
# SAFE restore — materializes a backup into a NEW timestamped location, or (for the
# Budget) replaces the live DB blob AFTER snapshotting it for rollback. NEVER
# overwrites the original project folder. Runs on LXC 104 (has the QNAP mount, the
# gdrive_sheets rclone remote, the gpg passphrase, DB access, and SSH to the laptop).
#
# Usage:
#   restore-backup.sh project qnap  "<full path to snapshot's project_home>" <qnap|laptop>
#   restore-backup.sh project drive "<drive .gpg filename>"                   <qnap|laptop>
#   restore-backup.sh budget  qnap  "<full path to privacy_budget.json>"      db
#   restore-backup.sh budget  drive "<drive .json filename>"                  db
#
# Prints "RESTORED_TO: <path>" / "RESTORED_BUDGET: ok ..." on success.
set -e

TYPE="$1"; SRC="$2"; REF="$3"; DEST="$4"

DB_HOST="192.168.1.219"; DB_NAME="home_data"; DB_USER="postgres"
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -tA -q"
PASSFILE="/etc/privacy-project-backup.pass"
DRIVE_PROJECT="gdrive_sheets:Claude_Project_Enc"
DRIVE_BUDGET="gdrive_sheets:Privacy_Budget"
QNAP_RESTORE="/mnt/qnap-claude/Restores"
LAPTOP="muroc@192.168.1.128"
LAPTOP_RESTORE="C:/Users/muroc/Restore"
STAMP="$(date '+%Y-%m-%d_%H%M%S')"

# ───────────── PROJECT FOLDER (restore to a NEW folder) ─────────────
if [ "$TYPE" = "project" ]; then
  WORKBASE="/tmp/restore_${STAMP}"
  mkdir -p "$WORKBASE"
  if [ "$SRC" = "qnap" ]; then
    [ -d "$REF" ] || { echo "ERROR: snapshot not found: $REF"; exit 1; }
    mkdir -p "$WORKBASE/project_home"
    cp -a "$REF"/. "$WORKBASE/project_home"/
  elif [ "$SRC" = "drive" ]; then
    rclone copyto "$DRIVE_PROJECT/$REF" "$WORKBASE/enc.gpg"
    gpg --batch --yes --decrypt --passphrase-file "$PASSFILE" -o "$WORKBASE/arc.tgz" "$WORKBASE/enc.gpg"
    tar xzf "$WORKBASE/arc.tgz" -C "$WORKBASE"           # creates $WORKBASE/project_home/
    rm -f "$WORKBASE/enc.gpg" "$WORKBASE/arc.tgz"
  else
    echo "ERROR: unknown source '$SRC'"; exit 1
  fi
  [ -d "$WORKBASE/project_home" ] || { echo "ERROR: nothing materialized"; exit 1; }

  if [ "$DEST" = "qnap" ]; then
    TARGET="$QNAP_RESTORE/project_home_${STAMP}"
    case "$TARGET" in "$QNAP_RESTORE"/*) : ;; *) echo "ERROR: unsafe target"; exit 1 ;; esac
    mkdir -p "$TARGET"; cp -a "$WORKBASE/project_home"/. "$TARGET"/
    rm -rf "$WORKBASE"
    echo "RESTORED_TO: \\\\192.168.1.155\\Claude_Data\\Restores\\project_home_${STAMP}"
  elif [ "$DEST" = "laptop" ]; then
    # always under C:/Users/muroc/Restore — NEVER the original project_home
    scp -r -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "$WORKBASE/project_home" "$LAPTOP:$LAPTOP_RESTORE/project_home_${STAMP}"
    rm -rf "$WORKBASE"
    echo "RESTORED_TO: C:\\Users\\muroc\\Restore\\project_home_${STAMP} (laptop)"
  else
    rm -rf "$WORKBASE"; echo "ERROR: unknown dest '$DEST'"; exit 1
  fi
  exit 0
fi

# ───────────── BUDGET (rollback current, then replace the live blob) ─────────────
if [ "$TYPE" = "budget" ]; then
  if [ "$SRC" = "qnap" ]; then
    [ -f "$REF" ] || { echo "ERROR: snapshot file not found: $REF"; exit 1; }
    BLOB="$(cat "$REF")"
  elif [ "$SRC" = "drive" ]; then
    BLOB="$(rclone cat "$DRIVE_BUDGET/$REF")"
  else
    echo "ERROR: unknown source '$SRC'"; exit 1
  fi
  ENC_DATA="$(printf '%s' "$BLOB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("enc_data",""))')"
  ENC_IV="$(printf '%s' "$BLOB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("enc_iv",""))')"
  [ -n "$ENC_DATA" ] && [ -n "$ENC_IV" ] || { echo "ERROR: blob missing enc_data/enc_iv"; exit 1; }

  # rollback: snapshot the CURRENT live blob first (reversible)
  $PSQL -c "INSERT INTO dashboard_settings(key,value,updated_at)
            SELECT 'privacy.budget_rollback',
                   json_build_object('enc_data',enc_data,'enc_iv',enc_iv,
                     'saved_at',to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI'))::jsonb, now()
              FROM privacy_sheets WHERE id=1
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();"

  # write the restored blob into the live row (ciphertext only — unlock later in the Budget tab)
  $PSQL -c "INSERT INTO privacy_sheets(id,enc_data,enc_iv,updated_at) VALUES (1,'$ENC_DATA','$ENC_IV',now())
            ON CONFLICT (id) DO UPDATE SET enc_data=EXCLUDED.enc_data, enc_iv=EXCLUDED.enc_iv, updated_at=now();"
  echo "RESTORED_BUDGET: ok (current Budget saved as rollback)"
  exit 0
fi

# ───────────── DATABASE (restore into a NEW scratch DB — NEVER the live one) ─────────────
if [ "$TYPE" = "db" ]; then
  TARGET_DB="home_data_restore"
  BIN="/usr/lib/postgresql/16/bin"
  [ "$TARGET_DB" = "$DB_NAME" ] && { echo "ERROR: refusing to overwrite the live DB"; exit 1; }
  # fresh scratch DB (drop the previous restore if any — only ever touches *_restore)
  "$BIN/dropdb" -h "$DB_HOST" -U "$DB_USER" --if-exists "$TARGET_DB"
  "$BIN/createdb" -h "$DB_HOST" -U "$DB_USER" "$TARGET_DB"
  # download → decrypt → restore (streamed, no temp file)
  rclone cat "gdrive_sheets:DB_Backups/$REF" \
    | gpg --batch --yes --decrypt --passphrase-file "$PASSFILE" \
    | "$BIN/pg_restore" -h "$DB_HOST" -U "$DB_USER" -d "$TARGET_DB" --no-owner --no-privileges 2>/dev/null
  echo "RESTORED_DB: $TARGET_DB"
  exit 0
fi

echo "ERROR: unknown type '$TYPE'"; exit 1
