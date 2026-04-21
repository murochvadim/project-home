# Rule Creation System — TODO & Design

Central document for the sentence-based rule authoring pipeline. Everything about how rules are created, validated, generated, and deployed lives here.

## Goal

User writes natural-language sentences in a per-room "Rule Settings" tab on the dashboard. When user asks Claude in chat, Claude reads the sentences plus the apartment spatial model (zones, placements, device labels, controllers) and plus the device registry, validates the plan, and produces Python rule files on the laptop. Existing dashboard "Deploy to Production" button syncs to LXC 105 via `git pull` + service restart. No Python code walls in chat — user only sees an English summary and a validation verdict.

Long-term vision: an LLM loop that refines rules based on sentences + apartment metadata + historical outcome data (user overrides, rule fire frequency, actual effect vs intent).

## Status snapshot

- ✅ **Phase 1 MVP**: Rule Settings tab live in Living Room Agent page (numbered rules, per-sentence edit, reuses existing `/api/dashboard-settings/:key` endpoint)
- 🚧 **Phase 1 pipeline**: Claude sentence→rule generation workflow agreed (validate → write .py on laptop → summary in chat → user commits + deploys)
- ⏳ **Phase 2**: Standard JSON rule schema — critical for Phase 3 safety
- ⏳ **Phase 3**: Cross-room rules + sentence-edit-later flow + LLM-refinement based on outcome data

---

## Phases

### Phase 1 — Living Room MVP

- [x] DB schema: `living-room.rule_sentences` = JSONB array of rule containers: `[{id, name, active, sentences:[{id, text, active, added_at, updated_at}], added_at, updated_at}]`. **Rules numbered 1..N by array position** so user can say in chat "generate rule 2".
- [x] Rule Settings tab on Living Room Agent page (`living-room.html`): named rule containers, each with Add / Delete / Enable-toggle per sentence. No "Generate" button — triggered via chat.
- [x] Server endpoints: reused existing `/api/dashboard-settings/:key` (same pattern as wallmote_bindings). Zero new server code.
- [ ] Claude sentence→rule pipeline (triggered in chat): reads sentences via MCP on `dashboard_settings`, combines with `/api/apartment-scene` + `/api/devices`, produces Python rule files on laptop only, reports English summary + validation result.

### Phase 2 — Standard JSON rule schema

- [ ] Define canonical JSON rule schema: `{ triggers, conditions, actions, priority, group, cooldown_s, category, ... }`. Every rule is a JSON doc first, Python is a compiled artifact.
- [ ] Update `/create-rule` skill to emit standard JSON + compile to Python (JSON = source of truth, Python = generated). Same pipeline used by sentence→rule flow.
- [ ] Validator checks JSON against schema before compilation (fast-fail).
- [ ] Compiler templates per trigger type (time-based, event-based, state-change, wildcard).

### Phase 3 — Advanced

- [ ] Cross-room and apartment-wide rules (e.g. "when leaving kitchen turn off all lights"). Requires UI for apartment-level sentences and cross-room device resolution.
- [ ] Sentence edit-later flow: decide regenerate-whole-rule vs incremental update when user edits sentence N after rule was already generated.
- [ ] Outcome tracking infrastructure: new `rule_outcomes` table logging fire events + user-override events (manual switch flip right after rule fired → override signal).
- [ ] LLM-refinement loop: LLM reads sentences + apartment metadata + outcome history → suggests rule tweaks via dashboard. **Suggest, never auto-apply.**

---

## Flow & Agreements (locked)

### End-to-end authoring flow

```
1. User writes sentences in Rule Settings tab
   (stored in dashboard_settings.living-room.rule_sentences)

2. User asks Claude in chat: "generate rule 2 for Living Room"

3. Claude:
   - Reads sentences via MCP query
   - Pulls /api/apartment-scene (zones, placements, controllers)
   - Pulls /api/devices + dps_labels
   - Validates: devices exist, channels valid, sensors online, no conflicts
   - Writes .py file(s) to laptop: c:\Users\muroc\project_home\RULES\rules\
   - Reports English summary + validation verdict in chat

4. User commits + pushes to git (optional but recommended)

5. User clicks "Deploy to Production" on Project Health page
   → /api/deploy SSHs to LXC 105
   → git pull + systemctl restart main-agent
   → new rules loaded

6. (Optional) User clicks "Reload" on Main Agent page — service restart already loads
```

### File structure rules (agreed 2026-04-21)

- **One Python file per rule container** (user preference — logical cohesion).
- Both/all sentences of Rule 1 "Light" land in one `lr_light.py` with clearly-commented branches inside `evaluate()`.
- Metadata fields inside RULE dict preserve DB linkage:
  - `rule_group`: stable id grouping all sentences
  - `source_rule_id`: DB id of parent Rule
  - `source_sentence_ids`: list of sentence ids that generated this file
- **But also see "Rule sizing" below** — prefer thin rules, many of them.

### Claude's responsibilities

- **Decides ambiguous references using apartment metadata** — no asking user piecewise questions like "which sensor?" or "which light is spot?". Only flags if truly unresolvable.
  Examples of decisions Claude makes without asking:
  - "Spot in Kitchen" → filter light placements whose dps_label contains "Spot" AND fall inside Kitchen zones
  - "enter Kitchen zone" → all sensors whose cone overlaps Kitchen zones (Kitchen Cooking + Kitchen Bar + Kitchen Walkway); OR logic
  - "all lights in Living Room" → every unique controller+DPS pair where a light placement exists in slug='living-room'
- **Validates before writing**:
  - All referenced devices exist
  - Controller + DPS channels are valid (check dps_labels or last_state)
  - Sensor device_ids are live (last_seen < 24h)
  - No contradictory logic between sentences of same rule
  - Cooldowns don't starve each other
  - Rule engine pattern compliance (required fields present)
  - No name collision with existing rule files in RULES/rules/
  - Zones referenced exist in room layout
- **Writes to laptop only** (`c:\Users\muroc\project_home\RULES\rules\`). Never scp, never SSH to LXC 105 during generation.
- **Reports English summary** in chat. No Python code walls.

### User's responsibilities

- Write sentences in the UI.
- Ask Claude in chat when ready.
- Review English summary + validation verdict.
- Commit and deploy via dashboard button.

### Deployment

- Never done by Claude directly.
- Always via dashboard `Deploy to Production` button → `/api/deploy` endpoint → SSH → git pull + restart.
- Human-in-loop gate is what keeps safety high.

---

## Rule sizing — thin rules, many of them

### Preference (strong)

**1–3 sentences per rule is ideal. Beyond 4 sentences, probably hiding 2+ rules inside one.**

### Why thin rules beat dense rules

| Concern | Thin (few sentences, many rules) | Dense (many sentences, few rules) |
|---|---|---|
| Debug a misbehavior | Open one small file, obvious | Navigate branching evaluate(), hunt |
| Disable one behavior | rename file to `.disabled`, done | edit shared file, risk typo breaking others |
| Cooldown / priority control | per-rule, clean | shared across sentences — one sentence's cooldown can starve another |
| AI translation reliability | high (single trigger, single action) | lower (AI has to juggle multiple triggers in one evaluate()) |
| Engine pattern match | matches 100% of existing rules | exception to the pattern |
| Git diff readability | clear — "this file changed" | blurred — "which sentence in the file broke?" |
| Refactor or split later | already split, just rename | painful — have to factor out branches |
| Single responsibility | ✓ each rule does one thing | ✗ multiple concerns per rule |

### Size guidelines

| Sentences in rule | Comfort |
|---|---|
| 1 | Perfect — simplest possible |
| 2–3 | Ideal — shared context, same trigger type |
| 4–6 | OK only if all sentences share one trigger type (e.g. all time-based) |
| 7+ | **Refactor signal** — you have multiple hidden rules |

### Group rules by GOAL, not by device

- ❌ "Lights" (encompasses everything related to lights)
- ✅ "Evening Vibe", "Night Off", "Away Mode" (each describes a *situation* or *intent*)

User thinks naturally in situations ("when I come home at night"). Device-oriented grouping forces translation back every time.

### Example: good vs bad structure for Living Room

**Good (goal-oriented, thin):**
- Rule 1 "**Evening Lights On**" (3 sentences — all at sunset: main light, sofa spots, TV spot)
- Rule 2 "**Night Off**" (2 sentences — 22:30 main light off, 23:00 TV spots off)
- Rule 3 "**Kitchen Motion**" (1 sentence — after 19:00 on presence)
- Rule 4 "**Auto-off Away**" (1 sentence — no people for 10 min)

→ 4 rules, 7 total sentences. Each rule answers ONE question ("why does this automation exist?").

**Bad (device-oriented, dense):**
- Rule 1 "**Light**" (15 sentences mixing time, motion, state, exceptions) ← hard to reason about

### Tension with "one Python file per rule container"

Our agreement ("one file per rule container") holds — but **the container should represent a single goal, not a device family**. Keep containers small and goal-scoped, and the "one file per rule" rule produces clean thin files. Dense files only appear when a container is too broad.

---

## Approach score — 8/10 (honest, 2026-04-21)

Natural-language sentences → AI-validated → deterministic Python rule files → manual deploy.

| Aspect | Score | Reasoning |
|---|---|---|
| Usability (author rules fast) | 9.5/10 | Sentences match how you naturally think about automation |
| Precision (does rule match intent?) | 7/10 | NL is inherently ambiguous; apartment metadata closes ~90%. Phase 2 JSON schema pushes to 8.5 |
| Safety (will it misfire?) | 7/10 | Validation catches obvious errors; subtle logic bugs possible. Mitigated by: validation step, manual deploy, git audit trail |
| Scalability (10 vs 100 rules) | 7/10 | Great for 5–20 rules/room. At 100+ conflict detection gets hard — Phase 3 addresses |
| Auditability (what's running?) | 8/10 | Sentences + generated Python both in git. Diff is clear |
| Evolvability (update over time) | 9/10 | Edit sentence → regenerate. Best-in-class iteration workflow |
| AI dependency (need Claude to update?) | 6/10 | Lock-in; not an issue today but real |

### Why not 10/10

1. NL ambiguity is permanent ("turn on when I enter" has 4 interpretations — door, motion, stationary, manual)
2. AI non-determinism — same sentences may produce slightly different Python each run (Phase 2 JSON schema fixes this)
3. No runtime LLM — rule runs deterministically after generation (good for safety; loses on-the-fly reasoning power)
4. No feedback loop yet — Phase 3 will add outcome-data-driven refinement

### Compared to alternatives

| Approach | Score | Note |
|---|---|---|
| Hand-write Python | 10/10 precision, 2/10 UX | Ours wins on usability |
| HA/Google Home GUI | 6/10 | Hits UI limits; ours more expressive |
| YAML DSL (Node-RED) | 7/10 | Requires learning DSL; ours avoids that |
| **Our plan** | **8/10** | Balance fit for your skill + apartment data richness |
| Runtime LLM (Claude evaluates every event) | 5/10 | Too slow/expensive/unreliable for hardware control |

### Three conditions to keep this 8/10

1. **Don't skip Phase 2 (JSON schema).** Without it, Phase 3 LLM-refinement is risky, and rebuilds are non-deterministic.
2. **Keep rules under ~20 per room.** Beyond that, conflict-detection becomes hard (but see sizing guidance — most rules should be 1–3 sentences, so 20 rules is plenty).
3. **Always deploy via dashboard button, never auto-deploy.** The human-in-loop gate keeps safety at 7; auto-deploy would drop it to 4.

---

## DB schema reference

### `dashboard_settings` row

```
key:   'living-room.rule_sentences'
value: JSONB — array of rule containers
```

### Rule container shape

```json
{
  "id":         "r_mo917iqlf0c",
  "name":       "Evening Vibe",
  "active":     true,
  "added_at":   "2026-04-21T19:43:32Z",
  "updated_at": "2026-04-21T19:46:43Z",
  "sentences":  [ /* array of sentence objects */ ]
}
```

### Sentence shape

```json
{
  "id":         "s_mo917x10qiv",
  "text":       "at sunset turn on TV spots",
  "active":     true,
  "added_at":   "2026-04-21T19:43:50Z",
  "updated_at": "2026-04-21T19:46:43Z"
}
```

### Identifiers

- Rule ids: `r_` + base36 timestamp + random suffix
- Sentence ids: `s_` + base36 timestamp + random suffix
- Room slug (e.g. `living-room`) identifies which room the rules belong to
- Array position gives the 1-based rule number user sees in the UI and references in chat

---

## Future ideas (not scheduled)

- Rule grouping/categorization in UI (by category — lighting / climate / security)
- Rule enable/disable by time window (rule only active on weekends, etc.)
- Sentence library / templates ("when nobody home for X minutes turn off Y")
- Cross-room rule inheritance (Apartment-wide rules that all rooms observe)
- Rule conflict detection: scan all rules, flag cases where two rules can both fire on same event with contradictory actions
- Rule simulation: run new rule against last 24h of `device_events` to preview what it would have done
