---
name: workflow
description: Orchestrate the full feature delivery pipeline — discovery, tech design, and task generation. Run one command to go from PRD to implementable tasks.
---

# Workflow

Orchestrate the full feature delivery pipeline: discovery → tech design → task files.

## Input
- **Feature name**: lowercase with hyphens (e.g., `album-joker`)
- **PRD**: Must be in conversation context

## Usage
```
/workflow album-joker
```

## Model

**Use the `opus` model for all phases of this workflow** (discovery, tech design, task generation).
Only `/implement-tasks` runs with the default model — do not override it here.

## Steps

1. **Validate inputs**
   - Feature name provided? If not, ask user.
   - PRD in context? If not, ask user to paste or reference it.
   - Create output directory: `mkdir -p docs/features/[feature-name]`

---

### Phase 1: Discovery

2. **Run Discovery via subagent**

   **CRITICAL: Delegate discovery to a subagent to preserve main context window.**

   Launch a Task tool agent that executes the full `/discovery` command for `[feature-name]`:
   ```
   Task tool:
     subagent_type: "general-purpose"
     model: "opus"
     description: "Discovery for [feature-name]"
     prompt: |
       Execute the `/discovery` command for feature [feature-name].

       ## PRD Summary
       [Paste key points from PRD — keep it concise, not the full PRD]

       Follow ALL steps in the /discovery command — including checking for
       related existing features, delegating codebase research to a sub-subagent,
       gate checking, interviewing the user on open questions, and grilling the user.

       Return a SHORT summary (max 10 lines) of key findings when done.
   ```

   **Note:** The `/discovery` command may determine that existing features should be updated instead of (or in addition to) creating a new one. If discovery exits early because the user chose to only update existing features, skip to step 8 (Done) — there is no new feature to design or split into tasks.

3. **Confirm discovery**
   - The user was already interviewed and grilled during discovery — no need for a full review pause
   - Show a one-line confirmation: "Discovery complete for [feature-name]. Proceeding to tech design."
   - If user objects, revise discovery before proceeding

---

### Phase 2: Tech Design

4. **Run Tech Design**
   After user approves discovery, execute all steps from `/tech-design [feature-name]`:
   - Read discovery.md, cross-reference with PRD
   - Fill gaps with targeted codebase investigation
   - Make all design decisions
   - Define interfaces/models in C#
   - Write `docs/features/[feature-name]/tech-design.md`

5. **Gate check design**
   Verify all sections complete:
   - [ ] To-be behavior defined (Section 3)
   - [ ] Design decisions documented (Section 4)
   - [ ] Interfaces/models specified (Section 5)
   - [ ] Implementation details per component (Section 6)
   - [ ] Ordered task list — code changes only, no build/test steps (Section 12)
   - No TBD placeholders remain

6. **PAUSE — Present tech design + annotation cycle**
   - Show key design decisions table
   - Show ordered task list summary
   - Show risks and open items
   - Ask: "Please review the tech design. You can:
     1. Tell me your changes here in chat
     2. **Add inline annotations in `tech-design.md`** and tell me to address them
     3. Approve to proceed"
   - If user adds annotations:
     - Read `tech-design.md` and collect all annotation markers
     - **CRITICAL — annotation review rules (all three are mandatory):**
       1. **Use `AskUserQuestion`** for every annotation — do not process them as part of a regular response
       2. **One at a time** — present one annotation in context (show surrounding text), ask what change they want, wait for the answer, then move to the next
       3. **Do NOT implement yet** — only discuss; collect all answers first, then summarize agreed changes, then apply all edits to `tech-design.md` in one pass
     - Remove annotation markers after addressing them
     - Re-present updated design
   - Repeat until user approves

---

### Phase 3: Task Generation

7. **Generate task files**
   After user approves tech design, invoke `/plan-to-tasks` with tech-design.md as input:
   - Reads Section 12 (Ordered Task List)
   - Creates task files under `docs/features/[feature-name]/tasks/`
   - Each task file includes references to discovery.md and tech-design.md

8. **Done**
    - Invoke the `update-features-index` skill to regenerate `docs/features/index.md`
    - Show summary of all generated artifacts:
      - `docs/features/[feature-name]/discovery.md`
      - `docs/features/[feature-name]/tech-design.md`
      - `docs/features/[feature-name]/tasks/progress.md`
      - `docs/features/[feature-name]/tasks/task-001.md` ... `task-NNN.md`
    - Tell user: "Run `/implement-tasks [feature-name]` to start building."