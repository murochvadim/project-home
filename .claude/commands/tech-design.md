---
name: tech-design
description: Turn PRD + discovery into an implementable tech design spec, then split into task files via /plan-to-tasks. Requires discovery.md to exist first.
---

# Tech Design

Turn PRD + discovery into an implementable technical design, then generate task files.

## Input
- **Feature name**: lowercase with hyphens (e.g., `album-joker`)
- **PRD**: Must be in conversation context
- **Discovery**: `docs/features/[feature-name]/discovery.md` must exist

## Steps

1. **Validate inputs**
   - Feature name provided? If not, ask user.
   - `docs/features/[feature-name]/discovery.md` exists? If not, tell user to run `/discovery [feature-name]` first.
   - PRD in context? If not, ask user to paste or reference it.

2. **Read discovery document**
   - Read `docs/features/[feature-name]/discovery.md`
   - Cross-reference all findings with PRD requirements
   - Identify gaps between what exists and what the PRD needs

3. **Fill gaps with targeted investigation**
   - For any area where discovery is insufficient for design decisions, do focused codebase research
   - Look at interfaces, base classes, and patterns that the implementation will extend

4. **Make design decisions**
   - Choose approach for each component
   - Document trade-offs and alternatives considered
   - Resolve open questions from discovery (or escalate to user via AskUserQuestion)

5. **Define interfaces and models**
   - Write actual C# interface/class definitions, not just descriptions
   - Include request/response models, DTOs, config shapes

6. **Write tech design document**

   Write to `docs/features/[feature-name]/tech-design.md` using this template:

   ```markdown
   # Tech Design: [Feature Name]

   **PRD:** [Brief PRD reference or title]
   **Discovery:** [docs/features/[feature-name]/discovery.md](discovery.md)
   **Date:** [YYYY-MM-DD]
   **Status:** Draft

   ## 1. Summary
   [2-3 sentences on what we're building and why]

   ### Non-Goals
   - [What this design explicitly does NOT cover]

   ## 2. Current Behavior
   [Brief summary — full details in discovery.md]

   ## 3. To-Be Behavior

   ### User Flow
   1. [Step-by-step user experience]

   ### System Flow
   1. [Step-by-step system/service interaction]

   ## 4. Design Decisions
   | Decision | Choice | Alternatives Considered | Rationale |
   |----------|--------|------------------------|-----------|
   | [decision] | [chosen approach] | [other options] | [why] |

   ## 5. Interfaces / Models
   ```csharp
   // [Description of interface/model]
   public interface IExampleService
   {
       Task<Result> DoSomethingAsync(Request request);
   }
   ```

   ## 6. Implementation Details

   For each component, apply these rules:
   - **Encapsulation:** If new logic has a distinct responsibility or is >5 lines, specify it as a named function (not inline). State the function name, signature, and where it lives.
   - **Type hierarchy impact:** If introducing a type change (e.g. `List<AlbumCard>` → `List<BaseAlbumCard>`), list ALL downstream consumers that now need subtype filtering and flag them for clarifying comments.
   - **Naming cross-check:** Cross-check all new enum values, model names, and method names against the API/endpoint names they serve. They must match (e.g. `RedeemAlbumJoker` API → `RedeemJoker` method, not `JokerRedemption`).

   ### [Component 1]
   - **File(s):** `path/to/file.cs`
   - **Changes:** [What to add/modify]
   - **Extract?** [Named function needed? If yes: name, signature, location]
   - **Details:** [How it works]

   ### [Component 2]
   - **File(s):** `path/to/file.cs`
   - **Changes:** [What to add/modify]
   - **Extract?** [Named function needed? If yes: name, signature, location]
   - **Details:** [How it works]

   ## 7. Config / Segmentation Plan
   | Key | Type | Default | Segments | Migration |
   |-----|------|---------|----------|-----------|
   | [new config key] | [type] | [default value] | [segment list or N/A] | [migration steps] |

   ## 8. BI Event Spec
   | Event Name | Trigger | Payload | Notes |
   |------------|---------|---------|-------|
   | [event] | [when fired] | `{ field1: type, field2: type }` | [any notes] |

   ## 9. Error Handling & Edge Cases
   | Scenario | Handling | Fallback |
   |----------|----------|----------|
   | [scenario] | [how handled] | [fallback behavior] |

   ## 10. Rollout Plan
   - **Feature flag:** [flag name and config]
   - **Phase 1:** [rollout scope]
   - **Phase 2:** [broader rollout]
   - **Rollback:** [how to roll back]

   ## 11. Test Plan
   ### Unit Tests
   - [Test 1: what it verifies]

   ### Integration Tests
   - [Test 1: what it verifies]

   ### Manual Checklist
   - [ ] [Manual verification step]

   ## 12. Ordered Task List
   [This section feeds into /plan-to-tasks. Each task must be a CODE CHANGE task only.]
   [Do NOT include: build steps, test execution steps, verification steps, deployment steps.]
   [Each task = code to write or modify. Tests are part of the code change task, not separate tasks.]

   1. **[Task title]** → [Brief description, files affected, acceptance criteria]
   2. **[Task title]** → [Brief description, files affected, acceptance criteria]
   3. **[Task title]** → [Brief description, files affected, acceptance criteria]

   ## 13. Open Items / Follow-ups
   - [ ] [Item that can be addressed post-launch]
   ```

7. **Gate check**
   - Verify all sections are filled, no TBD placeholders remain
   - Sections 3, 4, 5, 6, 12 are required (cannot be N/A)
   - Verify Section 12 contains ONLY code-change tasks (no build/test/deploy steps)
   - If gaps exist, go back and investigate

8. **PAUSE — Present to user for review**
   - Show key design decisions table (Section 4)
   - Show ordered task list summary (Section 12)
   - Show risks and open items
   - Ask: "Please review the tech design. You can either:
     1. Tell me your changes here in chat
     2. **Add inline annotations directly in `tech-design.md`** (add comments with `<!-- COMMENT: your feedback -->` or `> **[ANNOTATION]:** your feedback`) and tell me to address them
     3. Approve to proceed"

9. **Annotation cycle (if user annotates the file)**

   When the user says they've added annotations or comments to tech-design.md:
   - Re-read `docs/features/[feature-name]/tech-design.md`
   - Search for annotation markers: `<!-- COMMENT:`, `<!-- TODO:`, `> **[ANNOTATION]**`, `> **[Q]**`, `> **[CHANGE]**`
   - For EACH annotation found:
     - Address the feedback by modifying the relevant section
     - Remove the annotation marker after addressing it
   - Present the changes made and ask user to review again
   - Repeat this cycle until user approves (no more annotations)

   **Supported annotation formats:**
   ```markdown
   <!-- COMMENT: I think we should use approach B instead -->
   <!-- TODO: Add error handling for timeout case -->
   > **[ANNOTATION]:** This interface needs a cancellation token
   > **[Q]:** Should this be async?
   > **[CHANGE]:** Use Redis instead of in-memory cache
   ```

10. **Generate task files (after user approves)**
    - Invoke `/plan-to-tasks` with the tech-design.md as input
    - Plan-to-tasks reads Section 12 and generates task files under `docs/features/[feature-name]/tasks/`
    - Each task file includes references to discovery.md and tech-design.md

11. **Done**
    - Tell user: "Tech design approved and tasks generated. Run `/implement-tasks [feature-name]` to start building."