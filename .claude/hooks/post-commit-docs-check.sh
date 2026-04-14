#!/bin/bash
# POST-TOOL-USE: Remind to update CLAUDE.md files after git commit.
#
# Strategy: detect a JUST-HAPPENED commit by checking if HEAD's commit
# timestamp is within the last 30 seconds. This is more robust than
# relying on $CLAUDE_TOOL_INPUT_COMMAND, which may not be populated
# consistently across Claude Code versions / chained commands.
#
# To avoid repeated warnings on the same commit (because the hook fires
# on every Bash call, not just git commits), we record the last-warned
# HEAD sha in /tmp/.post-commit-warned-sha and skip if it matches.

REPO=/c/Users/muroc/project_home
cd "$REPO" 2>/dev/null || exit 0

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
HEAD_AGE=$(git log -1 --format=%ct HEAD 2>/dev/null)
NOW=$(date +%s)

# Only react to commits made in the last 30s
[ -z "$HEAD_AGE" ] && exit 0
[ $((NOW - HEAD_AGE)) -gt 30 ] && exit 0

# Dedupe: don't warn twice on the same commit
WARN_FILE=/tmp/.post-commit-warned-sha
[ -f "$WARN_FILE" ] && [ "$(cat "$WARN_FILE" 2>/dev/null)" = "$HEAD_SHA" ] && exit 0

# Check if any CLAUDE.md was part of this commit
COMMITTED_MDS=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | grep -i 'CLAUDE.md')

if [ -z "$COMMITTED_MDS" ]; then
  echo "[hook] ⚠ Commit $HEAD_SHA did NOT touch any CLAUDE.md. Consider:"
  echo "  - Root CLAUDE.md: infrastructure, new features, system-wide changes"
  echo "  - BOILER|MEDIA|VOICE|ORCHESTRATOR|CORRIDOR|LIVING_ROOM/CLAUDE.md: module-specific"
  echo "  - Memory files: project_*.md or incident_*.md for significant events"
  echo "  (Skip this warning for pure-refactor/tiny commits by updating the relevant CLAUDE.md or explicitly saying it's not needed.)"
fi

# Mark this commit as warned (success or miss)
echo "$HEAD_SHA" > "$WARN_FILE"
exit 0
