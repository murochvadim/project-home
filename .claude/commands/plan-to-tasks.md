---
name: plan-to-tasks
description: Split a plan or tech-design into individual task files under docs/features/[feature-name]/tasks/
---

# Plan to Tasks

Split a plan into task files under `docs/features/[feature-name]/tasks/`.

## Input
- **Plan file path**: e.g., `plan.md` or `docs/features/[feature-name]/tech-design.md`
- **Feature name**: Extract from filename or ask user

When called from `/tech-design` or `/workflow`, the input is `docs/features/[feature-name]/tech-design.md` and tasks are generated from Section 12 (Ordered Task List).

## Task Filtering Rules

**CRITICAL: Only create tasks for CODE CHANGES.**

Do NOT create tasks for:
- Building or compiling the project
- Running tests
- Verifying or validating changes
- Deployment or release steps
- Code review steps

Each task must represent actual code to write or modify. If a task includes writing tests, the tests are part of that code-change task — not a separate "run tests" task.

## Steps

1. **Get feature name** - Extract from plan filename or ask user

2. **Read plan file** - Parse to identify tasks (numbered lists, sections). If source is `tech-design.md`, read Section 12 (Ordered Task List).

3. **Filter tasks** - Remove any tasks that are build, test-run, verification, or deployment steps (see filtering rules above).

4. **Create directory**: `mkdir -p docs/features/[feature-name]/tasks`

5. **Create task files** - One `.md` per task with descriptive names: `task-001-[short-slug].md`
   - Format: `task-NNN-[kebab-case-name].md`
   - Example: `task-001-add-joker-config-model.md`, `task-002-implement-joker-service.md`
   - The slug should be 3-5 words max, derived from the task title

6. **Task file format**:
```markdown
# Task [number]: [Title]

## Reference Docs
- **Discovery:** [docs/features/[feature-name]/discovery.md](../discovery.md) (if exists)
- **Tech Design:** [docs/features/[feature-name]/tech-design.md](../tech-design.md) (if exists)

## Description
[Brief description]

## Original Plan Context
[FULL original plan content]

## Steps
1. [Step 1]
2. [Step 2]

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious (e.g. `OfType<T>` skipping subtypes, edge case ordering)
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [ ] Not started
```

7. **Create progress.md**:
```markdown
# Progress: [Feature Name]

**Total Tasks**: [count]
**Current Task**: 1
**Completed**: 0/[count]

## Reference Docs
- **Discovery:** [docs/features/[feature-name]/discovery.md](../discovery.md) (if exists)
- **Tech Design:** [docs/features/[feature-name]/tech-design.md](../tech-design.md) (if exists)

## Completed Tasks
(none yet)

## Pending Tasks
- [ ] task-001-[slug]: [Title]
- [ ] task-002-[slug]: [Title]
```

8. **Confirm**: Show created files, tell user to run `/implement-tasks [feature-name]`