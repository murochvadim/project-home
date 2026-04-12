#!/bin/bash
# Kill orphan process for a specific service script
# Usage: kill-orphan.sh <script_name.py>
PATTERN="$1"
if [ -z "$PATTERN" ]; then exit 0; fi
# Use grep to filter — avoids pgrep matching this script's own command line
ps aux | grep "$PATTERN" | grep python3 | grep -v grep | awk '{print $2}' | while read pid; do
  kill $pid 2>/dev/null
done
sleep 1
exit 0
