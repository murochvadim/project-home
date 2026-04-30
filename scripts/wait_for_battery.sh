#!/bin/bash
# /etc/apcupsd/wait_for_battery.sh — runs Before=pve-guests.service on PVE
#
# Purpose: prevent pve-guests from starting LXCs/VMs while the UPS battery
# is too low to safely buffer a second short outage. Reads the threshold
# from /etc/apcupsd/recover.conf:
#
#   BATTERY_GATE_PCT=0     → gate disabled, exit immediately
#   BATTERY_GATE_PCT=50    → wait until BCHARGE >= 50% (or timeout)
#
# Safety design — never blocks pve-guests forever, never blocks when there
# is no UPS to gate against:
#   - 10 min hard timeout → exit 0 anyway
#   - STATUS=COMMLOST or unreadable → exit 0 (no UPS to wait on)
#   - STATUS=ONBATT during wait → keep waiting (don't burn battery on guest start)
#   - BATTERY_GATE_PCT=0 or unset → exit immediately

set +e

LOG=/var/log/apcupsd_shutdown.log
RECOVER_CONF=/etc/apcupsd/recover.conf
TIMEOUT=600           # 10 min hard cap
POLL_INTERVAL=30      # seconds between checks

THRESHOLD=0
[ -r "$RECOVER_CONF" ] && source "$RECOVER_CONF"
THRESHOLD="${BATTERY_GATE_PCT:-0}"

# Sanity-clamp to integer 0-100; anything else → treat as off
if ! [[ "$THRESHOLD" =~ ^[0-9]+$ ]] || [ "$THRESHOLD" -gt 100 ]; then
  THRESHOLD=0
fi

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(stamp) wait_for_battery: $*" >> "$LOG"; }

if [ "$THRESHOLD" -eq 0 ]; then
  log "gate disabled (BATTERY_GATE_PCT=0) → continuing immediately"
  exit 0
fi

log "gate enabled — waiting for BCHARGE >= ${THRESHOLD}% (timeout ${TIMEOUT}s)"

START=$(date +%s)
LAST_LINE=""

while :; do
  STATUS=$(apcaccess status 2>/dev/null | awk '/^STATUS/{print $3; exit}')
  BCHARGE=$(apcaccess status 2>/dev/null | awk '/^BCHARGE/{print int($3); exit}')

  # No UPS to read against → don't block (manual reboot, USB pulled, etc.)
  if [ -z "$STATUS" ] || [ "$STATUS" = "COMMLOST" ]; then
    log "STATUS=${STATUS:-empty} → no UPS to gate against, continuing"
    exit 0
  fi

  # Mains back AND battery healthy → continue
  if [ "$STATUS" = "ONLINE" ] && [ -n "$BCHARGE" ] && [ "$BCHARGE" -ge "$THRESHOLD" ] 2>/dev/null; then
    log "STATUS=ONLINE BCHARGE=${BCHARGE}% >= ${THRESHOLD}% → continuing"
    exit 0
  fi

  # Hard timeout fallback — never block forever
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    log "TIMEOUT after ${ELAPSED}s — continuing anyway (last STATUS=$STATUS BCHARGE=${BCHARGE:-?}%)"
    exit 0
  fi

  # De-dupe wait lines (same STATUS+BCHARGE → log only on change)
  THIS_LINE="STATUS=$STATUS BCHARGE=${BCHARGE:-?}%"
  if [ "$THIS_LINE" != "$LAST_LINE" ]; then
    log "waiting: $THIS_LINE threshold=${THRESHOLD}% (elapsed=${ELAPSED}s)"
    LAST_LINE="$THIS_LINE"
  fi
  sleep "$POLL_INTERVAL"
done
