#!/usr/bin/env bash
# PreToolUse: warn if timer/cron command targets an LXC other than 104

cmd="$CLAUDE_TOOL_INPUT_COMMAND"

# Only care about commands that involve timers/scheduling
if echo "$cmd" | grep -qiE "(systemctl|\.timer|crontab|cron\.|at .*[0-9]|systemd-run|OnCalendar|OnBootSec)"; then
  # If it also targets an LXC via ssh/pct/lxc-attach
  if echo "$cmd" | grep -qiE "(ssh|pct exec|lxc-attach)"; then
    # Check if it targets LXC 104 specifically
    if echo "$cmd" | grep -qE "(104)"; then
      exit 0  # correct target, all good
    else
      echo "[hook] 🔴 WARNING: TIMER/CRON TASK detected targeting an LXC — LXC 104 is the designated COMMANDS/TIMERS server. Confirm target is LXC 104 before proceeding."
      exit 0  # warn but don't block
    fi
  fi
fi
