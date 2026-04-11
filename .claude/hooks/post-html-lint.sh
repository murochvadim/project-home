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

# ── 3. Inline <style> redefinitions of classes already in css/style.css ──
# Prevents regression of the DRY cleanup done 2026-04-11. If a shared class
# is redefined inline (even with different values), flag it — the page may
# silently override the canonical version from style.css.
SHARED_CSS_FILE="$(dirname "$FILE")/css/style.css"
if [ -f "$SHARED_CSS_FILE" ]; then
  # Extract the inline <style> block text (single pass)
  inline_css=$(awk '/<style>/,/<\/style>/' "$FILE" 2>/dev/null)
  if [ -n "$inline_css" ]; then
    # Classes currently considered shared — list grows as more are extracted.
    # Matches selector patterns like `.foo {` or `.foo.bar {` at start of a rule.
    SHARED_CLASSES="device-stats stat-chip toggle flex-row flex-col flex-center flex-between flex-wrap"
    for cls in $SHARED_CLASSES; do
      # Only flag when the class is the FULL base selector: `.foo {` or `.foo, .bar`.
      # Skips legitimate descendant overrides like `.foo .child {` (space before child),
      # compound overrides like `.foo.active {`, and pseudo-class overrides like `.foo:hover {`.
      if echo "$inline_css" | grep -qE "(^|[[:space:]])\.${cls}[[:space:]]*[\{,]"; then
        ISSUES+=("⚠ Inline <style> redefines .${cls} — already in css/style.css; remove inline copy or override via a more specific selector")
      fi
    done
  fi
fi

# ── 4. Inline handlers referencing undefined functions ────────────────────
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
