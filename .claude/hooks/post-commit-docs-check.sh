#!/bin/bash
# POST-TOOL-USE: Remind to update CLAUDE.md files after git commit
# Triggers only when a git commit command was run

CMD="${CLAUDE_TOOL_INPUT_COMMAND:-}"

# Only act on git commit commands
echo "$CMD" | grep -q 'git commit' || exit 0

# Check if any CLAUDE.md was modified in this commit
COMMITTED_MDS=$(cd /c/Users/muroc/project_home && git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | grep -i 'CLAUDE.md')

if [ -z "$COMMITTED_MDS" ]; then
  echo "[hook] ⚠ No CLAUDE.md updated in this commit. Checklist:"
  echo "  - Root CLAUDE.md: infrastructure, new features, system-wide changes?"
  echo "  - BOILER/CLAUDE.md: boiler-specific changes?"
  echo "  - ORCHESTRATOR/CLAUDE.md: alert types, orchestrator changes?"
  echo "  - Memory files: project_context.md for significant features?"
fi

exit 0
