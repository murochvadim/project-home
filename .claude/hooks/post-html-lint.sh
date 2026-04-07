#!/bin/bash
# POST-TOOL-USE: HTML cleanliness check after Edit/Write on .html files
# Checks: duplicate IDs, orphaned TAB comments, dead inline handlers

FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"

[[ "$FILE" == *.html ]] || exit 0
[ -f "$FILE" ] || exit 0

ISSUES=()

# ── 1. Duplicate IDs ──────────────────────────────────────────────────────
dupes=$(grep -oE 'id="[^""]+"' "$FILE" | sed 's/id="//;s/"//' | sort | uniq -d)
if [ -n "$dupes" ]; then
  while IFS= read -r id; do
    ISSUES+=("🔴 Duplicate id=\"$id\"")
  done <<< "$dupes"
fi

# ── 2. TAB comment count vs tab-panel count ───────────────────────────────
# Warn only when there are MORE TAB comments than panels (orphaned comment)
tab_comments=$(grep -E '<!--.*TAB:' "$FILE" 2>/dev/null | wc -l | tr -d ' ')
tab_panels=$(grep -E 'class="tab-panel' "$FILE" 2>/dev/null | wc -l | tr -d ' ')
if [ "$tab_comments" -gt 0 ] && [ "$tab_comments" -gt "$tab_panels" ]; then
  ISSUES+=("⚠ TAB comment count ($tab_comments) > tab-panel count ($tab_panels) — orphaned TAB comment with no panel")
fi

# ── 3. Inline handlers referencing undefined functions ────────────────────
# DOM built-ins to skip
BUILTINS="click focus blur submit reset confirm alert prompt addEventListener removeEventListener getElementById querySelector querySelectorAll setTimeout clearTimeout setInterval clearInterval fetch JSON parseInt parseFloat isNaN encodeURIComponent decodeURIComponent"

# Extract function names called inline (onclick/onchange/onsubmit/oninput)
inline_fns=$(grep -oE 'on(click|change|submit|input)="[^""]+"' "$FILE" \
  | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\(' | tr -d '(' \
  | sort -u)

# Collect defined functions from inline <script> and linked .js files
defined_fns=$(grep -oE 'function [a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(' "$FILE" \
  | sed 's/function //;s/[[:space:]]*($//' | sort -u)

# Match src="...js..." including query strings like ?v=27
script_srcs=$(grep -oE 'src="[^"]+\.js[^"]*"' "$FILE" | sed 's/src="//;s/".*//' | sed 's/\?.*//')
for src in $script_srcs; do
  jsfile="$(dirname "$FILE")/$src"
  [ -f "$jsfile" ] && defined_fns+=$'\n'"$(grep -oE 'function [a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(' "$jsfile" \
    | sed 's/function //;s/[[:space:]]*($//')"
done
defined_fns=$(echo "$defined_fns" | sort -u)

while IFS= read -r fn; do
  [ -z "$fn" ] && continue
  echo "$BUILTINS" | grep -qw "$fn" && continue
  if ! echo "$defined_fns" | grep -qx "$fn"; then
    ISSUES+=("⚠ Inline handler calls '$fn()' — not found in page or linked JS files")
  fi
done <<< "$inline_fns"

# ── Report ────────────────────────────────────────────────────────────────
if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "[hook] HTML lint: ${#ISSUES[@]} issue(s) in $(basename "$FILE"):"
  for issue in "${ISSUES[@]}"; do
    echo "  $issue"
  done
else
  echo "[hook] HTML lint: $(basename "$FILE") clean ✓"
fi

exit 0
