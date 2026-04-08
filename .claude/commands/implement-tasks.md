---
name: implement-tasks
description: Implement tasks from docs/features/[feature-name]/tasks/ using Opus agents. Use "start tasks [name]", "continue tasks [name]", or add --all to auto-continue.
---

# Implement Tasks

Execute tasks from `docs/features/[feature-name]/tasks/` using Opus agents.

## Input
- **Feature name**: folder under `docs/features/`
- **--all flag**: Auto-continue all tasks without asking

## Usage
```
/implement-tasks user-auth          # Interactive - asks between tasks
/implement-tasks user-auth --all    # Auto - runs all remaining tasks
```

## Workflow

### Step 1: Check Progress
Read `docs/features/[feature-name]/tasks/progress.md`:
- Find current task number
- Show: `Feature: [name] | Progress: [done]/[total] | Starting: task-[n]`

### Step 2: Load Context Docs
Check for and read these reference documents (if they exist):
- `docs/features/[feature-name]/discovery.md` — current behavior, BI events, config, blast radius
- `docs/features/[feature-name]/tech-design.md` — design decisions, interfaces, implementation details

### Step 3: Find Next Task
- Get "Current Task" from progress.md
- Skip completed tasks
- If no progress.md, start with the first `task-*.md` file (sorted by name)
- Task files use pattern `task-NNN-[slug].md` (e.g., `task-001-add-joker-config.md`)

### Step 4: Launch Agent
```
Task tool:
  subagent_type: "general-purpose"
  model: "opus"
  prompt: |
    ## Context Documents
    [Include discovery.md content if it exists]
    [Include tech-design.md content if it exists]

    ## Task to Implement
    [FULL task-XXX.md content]

    ## Instructions
    - Read the context documents first to understand the full feature design
    - Follow the tech design decisions and interfaces exactly
    - **Use Red/Green TDD for every task:**
      1. Write tests that check the expected behavior (not implementation details)
      2. Run tests → confirm they FAIL (red) → if they pass before any implementation, the tests are wrong
      3. Implement the code to make them pass
      4. Run tests → confirm they PASS (green)
      5. Add any additional tests appropriate to the situation (unit tests, edge cases) based on what was implemented
    - Implement this task according to its steps
    - When done, update progress.md:
      - Mark task completed with timestamp
      - Set Current Task to next
      - Update Completed count
```

### Step 5: After Agent Completes

**With --all flag**: Loop to next task until done

**Without --all**: Ask user:
- "Yes, continue" → next task
- "Run all remaining" → switch to --all mode
- "Stop here" → exit

### Step 6: Update feature documentation
After all tasks are implemented, update the feature's own documentation and the features index. This runs once after all tasks complete — not after each individual task.

1. Read `docs/features/[feature-name]/tech-design.md` and compare against the implemented code to capture any deviations from the original design. Update the tech-design.md directly with timestamped update blocks (see format below) in the relevant sections.
2. Invoke the `feature-related-files` skill for this feature to update `related-files.md` with any new files created during implementation. This skill also regenerates the features index automatically.

**Update block format** (append at end of affected section, before next `## N.` heading):
```markdown

---

*Update DD/MM/YYYY*

[Factual description of implementation deviations — what changed from the original design and in which files.]
```

## Error Handling
- **Feature not found**: List available features under docs/features/
- **All done**: Show completion summary, then run step 6
- **Task missing**: Skip to next available task