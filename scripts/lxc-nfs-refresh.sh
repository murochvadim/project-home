#!/bin/bash
# /usr/local/sbin/lxc-nfs-refresh.sh — runs After=pve-guests.service on PVE.
#
# Auto-heals LXC bind mounts that point to QNAP shares (NFS or CIFS) when the
# LXC started before the underlying mount was active. This happens on every
# PVE boot where QNAP isn't yet up at the moment pve-guests.service fires.
# Without this, services inside affected LXCs (analyzer, network-agent) crash
# until something restarts the container.
#
# Strategy:
#   1. Auto-discover unique QNAP host paths from /etc/pve/lxc/*.conf bind specs
#   2. For each host path: try `mount`, then wait until it shows mounted+populated
#   3. For each LXC with a stale bind mount (in-container view has fewer entries
#      than the host path) — pct restart it once
#
# Idempotent + safe to run anytime — no-op when QNAP is healthy, restarts only
# the LXCs that actually have stale binds.

set +e
LOG=/var/log/lxc-nfs-refresh.log
TIMEOUT_PER_MOUNT=300   # 5 min cap per host path
POLL=5                  # seconds between mount-state checks

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(stamp) lxc-nfs-refresh: $*" >> "$LOG"; }

log "service start"

# ---- 1. Discover unique QNAP host paths from LXC configs ----
HOST_PATHS=$(grep -hE "^mp[0-9]+: /mnt/qnap-[a-z]+," /etc/pve/lxc/*.conf 2>/dev/null \
             | sed -n 's|^mp[0-9]\+: \(/mnt/qnap-[a-z]\+\),.*|\1|p' \
             | sort -u)

if [ -z "$HOST_PATHS" ]; then
  log "no QNAP bind mounts found in /etc/pve/lxc/*.conf — exiting"
  exit 0
fi

log "host paths to verify: $(echo $HOST_PATHS | tr '\n' ' ')"

# ---- 2. Ensure each host path is mounted + populated ----
ALL_OK=1
for path in $HOST_PATHS; do
  START=$(date +%s)
  while :; do
    if mountpoint -q "$path" && [ -n "$(ls -A "$path" 2>/dev/null | head -1)" ]; then
      log "  $path: mounted+populated"
      break
    fi
    # Try mounting if not currently mounted
    if ! mountpoint -q "$path"; then
      mount "$path" 2>/dev/null
    fi
    ELAPSED=$(( $(date +%s) - START ))
    if [ "$ELAPSED" -ge "$TIMEOUT_PER_MOUNT" ]; then
      log "  $path: TIMEOUT after ${ELAPSED}s — leaving as-is, dependent LXCs not refreshed"
      ALL_OK=0
      break
    fi
    sleep "$POLL"
  done
done

# ---- 3. Refresh LXCs with stale bind mounts ----
# We compare host-path entry count vs in-container entry count. If LXC sees
# fewer entries than the host has, the bind was made before the host mount
# was active — restart fixes it.
for conf in /etc/pve/lxc/*.conf; do
  id=$(basename "$conf" .conf)
  # Skip non-numeric (any future per-cluster files)
  [[ "$id" =~ ^[0-9]+$ ]] || continue

  # Each bind line: "mp0: /mnt/qnap-media,mp=/mnt/media,..."
  binds=$(grep -E "^mp[0-9]+: /mnt/qnap-[a-z]+," "$conf" 2>/dev/null)
  [ -z "$binds" ] && continue

  if ! pct status "$id" 2>/dev/null | grep -q running; then
    log "  LXC $id: not running — skipping"
    continue
  fi

  needs_restart=0
  while IFS= read -r line; do
    host_path=$(echo "$line" | sed -n 's|^mp[0-9]\+: \(/mnt/qnap-[a-z]\+\),.*|\1|p')
    in_mp=$(echo "$line"     | sed -n 's|^.*mp=\([^,]*\).*|\1|p')
    [ -z "$host_path" ] || [ -z "$in_mp" ] && continue

    # Skip if host path itself is empty/unmounted (already logged above)
    HOST_N=$(ls -A "$host_path" 2>/dev/null | wc -l)
    [ "$HOST_N" -eq 0 ] && continue

    LXC_N=$(pct exec "$id" -- sh -c "ls -A '$in_mp' 2>/dev/null | wc -l" 2>/dev/null)
    LXC_N="${LXC_N:-0}"

    if [ "$LXC_N" -ge "$HOST_N" ]; then
      log "  LXC $id: $in_mp ← $host_path ($LXC_N/$HOST_N entries) OK"
    else
      log "  LXC $id: $in_mp ← $host_path ($LXC_N/$HOST_N entries) STALE"
      needs_restart=1
    fi
  done <<< "$binds"

  if [ "$needs_restart" -eq 1 ]; then
    log "    → pct restart $id"
    pct restart "$id" >> "$LOG" 2>&1
  fi
done

log "service done (mount-readiness=$([ $ALL_OK -eq 1 ] && echo all-ok || echo partial))"
exit 0
