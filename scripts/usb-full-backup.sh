#!/bin/bash
# usb-full-backup.sh — one-session FULL project backup to an external disk on the PVE host.
#
# Deploy: scp scripts/usb-full-backup.sh root@192.168.1.101:/opt/usb-full-backup.sh ; chmod 755
# Runs ON the Proxmox host. Started detached by the dashboard (routes-usbbackup.js).
# Reports live progress to a status JSON + honors a stop flag. Reads sources READ-ONLY;
# never formats and never writes to a system disk.
#
# Sources (all already mounted on the PVE host):
#   /mnt/pbs          -> QNAP /PBS_Data  (ALL guest vzdump images = full system)
#   /mnt/qnap-claude  -> Claude_Data     (repo snapshots, memory, privacy, medical, people)
#   /mnt/qnap-media   -> Media           (media library — only copy)
#   /mnt/qnap-windows -> Windows_Data    (laptop image backups)
# Live pulls via `pct exec` (no SSH/passwords — host controls the containers):
#   DB dump (LXC 102), Vaultwarden vw-data (LXC 109), PVE host config (local), passphrase (LXC 104).

set -u

STATUS=/run/usb-full-backup.json
PHASE_F=/run/usb-full-backup.phase
STOP=/run/usb-full-backup.stop
LOCK=/run/usb-full-backup.lock
MP=/mnt/usb-backup
SOURCES=(/mnt/pbs /mnt/qnap-claude /mnt/qnap-media /mnt/qnap-windows)
MON_PID=""
TS=$(date +%Y-%m-%d_%H%M%S)
T0=$(date +%s)

# ---- status helpers (atomic write) ------------------------------------------
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
write_status() {  # state pct bytes_done bytes_total message
  local state="$1" pct="${2:-0}" done="${3:-0}" total="${4:-0}" msg="${5:-}"
  local phase; phase=$(cat "$PHASE_F" 2>/dev/null || echo "")
  local eta=0
  if [ "$state" = running ] && [ "$done" -gt 0 ] && [ "$total" -gt 0 ]; then
    local el=$(( $(date +%s) - T0 )); local rate=$(( done / (el>0?el:1) ))
    [ "$rate" -gt 0 ] && eta=$(( (total - done) / rate )); [ "$eta" -lt 0 ] && eta=0
  fi
  local tmp="${STATUS}.tmp"
  printf '{"state":"%s","phase":"%s","pct":%s,"bytes_done":%s,"bytes_total":%s,"eta_sec":%s,"started_at":"%s","finished_at":"%s","message":"%s"}\n' \
    "$state" "$(json_escape "$phase")" "${pct:-0}" "${done:-0}" "${total:-0}" "${eta:-0}" "$TS" \
    "$([ "$state" = running ] || date +%Y-%m-%d_%H:%M:%S)" "$(json_escape "$msg")" > "$tmp" && mv -f "$tmp" "$STATUS"
}
set_phase() { echo "$1" > "$PHASE_F"; }

cleanup() {
  [ -n "$MON_PID" ] && kill "$MON_PID" 2>/dev/null
  sync 2>/dev/null
  mountpoint -q "$MP" && umount "$MP" 2>/dev/null
}
trap cleanup EXIT

fail() { set_phase "$1"; write_status error 0 0 0 "$1"; exit 1; }

# ---- single instance --------------------------------------------------------
exec 9>"$LOCK"
flock -n 9 || { echo "already running"; exit 0; }
rm -f "$STOP"
set_phase "Detecting disk"
write_status running 0 0 0 "starting"

# ---- 1. detect the USB disk + its data partition ----------------------------
mapfile -t USBDISKS < <(lsblk -ndo NAME,TRAN,TYPE 2>/dev/null | awk '$2=="usb" && $3=="disk"{print $1}')
[ "${#USBDISKS[@]}" -eq 0 ] && fail "No external USB disk detected"
[ "${#USBDISKS[@]}" -gt 1 ] && fail "Multiple USB disks found (${USBDISKS[*]}) — connect only the backup disk"
DISK="${USBDISKS[0]}"
# pick the largest partition with a mountable filesystem (skip 16M MSR etc.)
read -r PART FS < <(lsblk -brno NAME,TYPE,FSTYPE,SIZE "/dev/$DISK" 2>/dev/null \
  | awk '$2=="part" && ($3=="exfat"||$3=="ntfs"||$3=="ext4"||$3=="ext3"||$3=="ext2"||$3=="vfat"){print $1, $3, $4}' \
  | sort -k3 -n | tail -1 | awk '{print $1, $2}')
if [ -z "${PART:-}" ]; then                     # whole-disk fs (no partition table)
  FS=$(blkid -o value -s TYPE "/dev/$DISK" 2>/dev/null)
  [ -n "$FS" ] && PART="$DISK"
fi
[ -z "${PART:-}" ] && fail "USB disk /dev/$DISK has no mountable filesystem"

# ---- 2. mount RW ------------------------------------------------------------
set_phase "Mounting /dev/$PART ($FS)"
write_status running 0 0 0 "mounting /dev/$PART"
mkdir -p "$MP"
mountpoint -q "$MP" && umount "$MP" 2>/dev/null
case "$FS" in
  exfat) mount -t exfat "/dev/$PART" "$MP" 2>/dev/null || mount.exfat-fuse "/dev/$PART" "$MP" 2>/dev/null ;;
  ntfs)  mount -t ntfs3 "/dev/$PART" "$MP" 2>/dev/null || ntfs-3g "/dev/$PART" "$MP" 2>/dev/null ;;
  *)     mount "/dev/$PART" "$MP" 2>/dev/null ;;
esac
mountpoint -q "$MP" || fail "Failed to mount /dev/$PART ($FS) at $MP"

DEST_MIRROR="$MP/PROJECT_BACKUP/QNAP_Mirror"
DEST_LIVE="$MP/PROJECT_BACKUP/Live_Pull/$TS"
mkdir -p "$DEST_MIRROR" "$DEST_LIVE" || fail "Cannot write to the USB disk (read-only?)"

# ---- 3. pre-flight size vs free ---------------------------------------------
set_phase "Calculating size"
write_status running 0 0 0 "calculating total size"
BYTES_TOTAL=$(du -sbc "${SOURCES[@]}" 2>/dev/null | tail -1 | awk '{print $1}')
[ -z "${BYTES_TOTAL:-}" ] || [ "$BYTES_TOTAL" -le 0 ] && BYTES_TOTAL=1
FREE=$(df -B1 --output=avail "$MP" 2>/dev/null | tail -1 | tr -d ' ')
# add ~2% headroom for the live pulls
NEED=$(( BYTES_TOTAL + BYTES_TOTAL/50 ))
if [ -n "${FREE:-}" ] && [ "$FREE" -gt 0 ] && [ "$NEED" -gt "$FREE" ]; then
  fail "Won't fit: need $(numfmt --to=iec $NEED 2>/dev/null || echo $NEED), free $(numfmt --to=iec $FREE 2>/dev/null || echo $FREE)"
fi

# ---- 4. background progress monitor (du of our dest folders / total) ---------
monitor_loop() {
  while :; do
    [ -f "$STOP" ] && break
    local d; d=$(du -sb "$MP/PROJECT_BACKUP" 2>/dev/null | awk '{print $1}'); d=${d:-0}
    local p=$(( d * 100 / BYTES_TOTAL )); [ "$p" -gt 99 ] && p=99
    write_status running "$p" "$d" "$BYTES_TOTAL" ""
    sleep 5
  done
}
monitor_loop & MON_PID=$!

# ---- rsync wrapper that Stop can interrupt ----------------------------------
RSYNC_OPTS=(-a --delete --no-perms --no-owner --no-group --modify-window=2 --inplace)
run_rsync() {  # src dest
  rsync "${RSYNC_OPTS[@]}" "$1/" "$2/" &
  local rp=$!
  while kill -0 "$rp" 2>/dev/null; do
    if [ -f "$STOP" ]; then kill -TERM "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; return 130; fi
    sleep 2
  done
  wait "$rp"; return $?
}
stopped() { kill "$MON_PID" 2>/dev/null; MON_PID=""; write_status stopped 0 0 "$BYTES_TOTAL" "cancelled by user"; exit 0; }

# ---- 5. mirror the four QNAP shares -----------------------------------------
declare -A LABELS=( [/mnt/pbs]="guest images" [/mnt/qnap-claude]="Claude_Data" [/mnt/qnap-media]="Media library" [/mnt/qnap-windows]="Windows images" )
declare -A DESTS=( [/mnt/pbs]="PBS_Data" [/mnt/qnap-claude]="Claude_Data" [/mnt/qnap-media]="Media" [/mnt/qnap-windows]="Windows_Data" )
for src in "${SOURCES[@]}"; do
  [ -f "$STOP" ] && stopped
  mountpoint -q "$src" || { echo "skip $src (not mounted)"; continue; }
  set_phase "Mirroring ${LABELS[$src]}"
  run_rsync "$src" "$DEST_MIRROR/${DESTS[$src]}"
  [ $? -eq 130 ] && stopped
done

# ---- 6. live pulls via pct exec (best-effort; guest images are the fallback) -
[ -f "$STOP" ] && stopped
set_phase "Live pull: database"
mkdir -p "$DEST_LIVE/db" "$DEST_LIVE/vaultwarden" "$DEST_LIVE/secrets" "$DEST_LIVE/pve_host"
pct exec 102 -- su postgres -c "pg_dump -Fc home_data" > "$DEST_LIVE/db/home_data_${TS}.dump" 2>/dev/null \
  && echo "db dump ok" || echo "db dump FAILED (recoverable from LXC-102 guest image)" > "$DEST_LIVE/db/README_db_failed.txt"

set_phase "Live pull: Vaultwarden"
pct exec 109 -- tar czf - -C /opt/privacy vw-data > "$DEST_LIVE/vaultwarden/vw-data_${TS}.tar.gz" 2>/dev/null \
  && echo "vw-data ok" || echo "vw-data FAILED (recoverable from LXC-109 guest image)" > "$DEST_LIVE/vaultwarden/README_vw_failed.txt"

set_phase "Live pull: PVE host config"
tar czf "$DEST_LIVE/pve_host/pve_host_config_${TS}.tar.gz" \
  /etc/pve /etc/network/interfaces /etc/fstab /etc/hosts /usr/local/bin 2>/dev/null

set_phase "Live pull: passphrase"
pct exec 104 -- cat /etc/privacy-project-backup.pass > "$DEST_LIVE/secrets/privacy-project-backup.pass" 2>/dev/null \
  && chmod 600 "$DEST_LIVE/secrets/privacy-project-backup.pass" \
  || echo "passphrase not pulled (also in Vaultwarden)" > "$DEST_LIVE/secrets/README.txt"

# ---- 7. manifest + finish ---------------------------------------------------
set_phase "Writing manifest"
{
  echo "PROJECT FULL BACKUP — $TS"
  echo "Host: $(hostname)  Disk: /dev/$PART ($FS)"
  echo
  echo "== Sizes =="
  du -sh "$DEST_MIRROR"/* 2>/dev/null
  du -sh "$DEST_LIVE" 2>/dev/null
  echo
  echo "== Guest images (newest per guest) =="
  find "$DEST_MIRROR/PBS_Data" -name "vzdump-*.tar.zst" -o -name "vzdump-*.vma.zst" 2>/dev/null | sort
  echo
  echo "== Live pulls =="
  ls -la "$DEST_LIVE/db" "$DEST_LIVE/vaultwarden" "$DEST_LIVE/pve_host" "$DEST_LIVE/secrets" 2>/dev/null
  echo
  echo "== RESTORE GUIDE =="
  echo "Guest/VM : pct restore <id> <QNAP_Mirror/PBS_Data/.../vzdump-lxc-<id>-*.tar.zst>  (or qmrestore for VM 101)"
  echo "Database : pg_restore -d home_data Live_Pull/<ts>/db/home_data_<ts>.dump   (create DB first)"
  echo "Vaultwarden: tar xzf vw-data_<ts>.tar.gz into /opt/privacy/ on a fresh LXC 109"
  echo "Encrypted .gpg artifacts (Drive copies): decrypt with secrets/privacy-project-backup.pass"
  echo "Media/Docs: plain files under QNAP_Mirror/Media and QNAP_Mirror/Claude_Data"
} > "$MP/PROJECT_BACKUP/BACKUP_MANIFEST_${TS}.txt" 2>/dev/null

kill "$MON_PID" 2>/dev/null; MON_PID=""
sync
FINAL=$(du -sb "$MP/PROJECT_BACKUP" 2>/dev/null | awk '{print $1}'); FINAL=${FINAL:-0}
DUR=$(( $(date +%s) - T0 ))
set_phase "Done"
write_status done 100 "$FINAL" "$BYTES_TOTAL" "completed in $((DUR/60))m $((DUR%60))s"
exit 0
