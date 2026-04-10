#!/bin/bash
# Auto-scan: called by cron every minute. Triggers ingest only when not already running.
PROGRESS=$(curl -sf http://127.0.0.1:8767/api/media/scan/progress 2>/dev/null)
if [ -z "$PROGRESS" ]; then exit 0; fi
RUNNING=$(echo "$PROGRESS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('running','false'))" 2>/dev/null)
[ -z "$RUNNING" ] && exit 0
if [ "$RUNNING" = "True" ]; then exit 0; fi
curl -sf --max-time 30 -X POST http://127.0.0.1:8767/api/media/scan >> /var/log/auto_scan.log 2>&1
