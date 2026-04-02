#!/bin/bash
# POST-TOOL-USE: Auto-clean /tmp working files after Bash commands
# Triggers when a Bash command used scp or wrote to /tmp/

CMD="${CLAUDE_TOOL_INPUT_COMMAND:-}"

# Only act when the command involved /tmp/
if ! echo "$CMD" | grep -q '/tmp/'; then
  exit 0
fi

CLEANED_LOCAL=()
CLEANED_REMOTE=()

# ── Clean local /tmp working files ────────────────────────────────────────
for f in /tmp/*.sql /tmp/*.py /tmp/*.txt /tmp/*.sh; do
  [ -f "$f" ] || continue
  rm -f "$f"
  CLEANED_LOCAL+=("$(basename "$f")")
done

# ── Clean remote /tmp files if scp was used ───────────────────────────────
if echo "$CMD" | grep -q 'scp '; then
  # Extract all "user@host:/tmp/file" patterns from the command
  while IFS= read -r target; do
    host=$(echo "$target" | cut -d: -f1)
    remote_path=$(echo "$target" | cut -d: -f2)
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$host" "rm -f '$remote_path'" 2>/dev/null; then
      CLEANED_REMOTE+=("$host:$remote_path")
    fi
  done < <(echo "$CMD" | grep -oE '[a-z]+@[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:/tmp/[^ ]+')
fi

# ── Report ────────────────────────────────────────────────────────────────
if [ ${#CLEANED_LOCAL[@]} -gt 0 ] || [ ${#CLEANED_REMOTE[@]} -gt 0 ]; then
  echo -n "[hook] /tmp cleanup:"
  [ ${#CLEANED_LOCAL[@]} -gt 0 ] && echo -n " local: ${CLEANED_LOCAL[*]}"
  [ ${#CLEANED_REMOTE[@]} -gt 0 ] && echo -n " | remote: ${CLEANED_REMOTE[*]}"
  echo
fi

exit 0
