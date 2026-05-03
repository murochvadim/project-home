---
description: Create, edit, remove, or audit a rule engine automation rule
user-invocable: true
---

# /create-rule — Rule Engine Rule Builder

You are building a rule for the home automation rule engine on LXC 105. Follow this interactive flow step by step. Use AskUserQuestion for each step. Do NOT skip steps or assume answers.

## Step 0: Action

Ask the user what they want to do:
- **Create** — build a new rule from scratch
- **Edit** — modify an existing rule (list rules from `RULES/rules/*.py`, excluding `_template.py` and `__init__.py`)
- **Remove** — delete a rule (list, confirm, delete from local + deploy)
- **Audit** — scan ALL existing rules for design smells (wildcard overuse, heavy loops, missing cooldowns, unguarded DB queries, noisy emits). Read-only — produces a report, makes no changes.

If **Remove**: list existing rules, confirm selection, delete the `.py` file locally and on LXC 105 (`/opt/main-agent/project/RULES/rules/`), then tell the user to click Reload on the dashboard. Done.

If **Edit**: list existing rules, ask which one, read the file, ask what to change (trigger, action, conditions, group/priority, or full rewrite), make changes, show modified code, get approval, deploy.

If **Audit**: jump to the **Audit Procedure** section at the end of this file. Do NOT continue to Step 1.

If **Create**: continue with the steps below.

## Step 1: Name & Description

Ask:
- "What should this rule be called?" (e.g., "Kitchen Light Auto")
- "Describe what it does in one sentence"

Generate a snake_case filename from the name (e.g., `kitchen_light_auto.py`).

## Step 2: Trigger Type

Ask which trigger type:
- **Presence** — fires when presence sensor detects someone in a room
- **Switch** — fires when a switch/light is operated in a room
- **Any device** — wildcard (`"*"`), fires on every device event — for info/state rules
- **State change** — fires when a specific shared state key changes
- **Timer-based** — fires based on timer conditions (idle timeout, etc.)

### Scaling guidance — prefer specific triggers when possible

Wildcard (`"*"`) triggers run on EVERY device event (~1 event/sec at current home scale). That multiplies work per event by the number of wildcard rules. Prefer:

- **Specific device_id triggers** (e.g., `triggers=["boiler"]` or `triggers=["bf123...","bf456..."]`) — the rule engine has a trigger index and only fires matching rules
- **Early-return pattern** for wildcard rules — filter on the first 2 lines to exit fast when the event isn't relevant:
  ```python
  def evaluate(event, state):
      dev_id = event.get("device_id", "")
      if dev_id not in {MY_DEVICE_IDS}:  # short-circuit
          return []
      # ... rest only runs for matching events
  ```

At ≤ 50 rules this doesn't matter much. At 100+ wildcard rules it does. Default toward specific triggers; use wildcard only for true aggregator rules (Home Activity, People Home, generic handlers like Wallmote Handler).

## Step 3: Room/Device (if presence or switch)

Query rooms from DB using MCP tool:
```sql
SELECT name FROM rooms ORDER BY name
```

Ask user to pick one or more rooms. Or ask for a specific device ID.

## Step 4: Action Type

Ask what should happen when the rule fires:
- **Pixoo preset** — push a named preset to Pixoo64 display with optional template variables
- **Pixoo resume** — unpause Pixoo rotation
- **Pixoo wipe** — clear Pixoo display
- **Awtrix on/off** — toggle the Awtrix LED matrix backlight (`power_on` / `power_off`)
- **Awtrix preset** — push a saved Awtrix message preset (text + color + scroll) with optional `{{var}}` template substitution
- **Device command** — turn_on/turn_off a specific device
- **Zigbee command** — send command to zigbee device
- **HASP command** — send command to HASP touchpanel
- **State update only** — info rule, updates shared state, no device commands

## Step 5: Pixoo Details (if pixoo action)

Query presets from DB:
```sql
SELECT name, type, content FROM pixoo_presets ORDER BY name
```

Ask:
- Which preset to push?
- Show the preset's `{{var}}` placeholders
- Ask what values to fill them with (can use state values like `state.shared.get("people_home")`)

## Step 5b: Awtrix Details (if Awtrix action)

For **Awtrix on/off**: ask whether the rule turns it ON or OFF.

For **Awtrix preset**:
1. Query saved presets:
   ```sql
   SELECT value FROM dashboard_settings WHERE key = 'awtrix.messages'
   ```
   The value is a JSON array of `{name, template, color, scroll_speed, text_case, duration_s, ...}`. Show preset names.
2. If the array is empty: tell the user to create one first via the dashboard's Living Room → Awtrix tab.
3. Ask which preset to push.
4. Show the preset's template (e.g. `Boiler {{boiler_temp}}°C`) and ask what `vars` to pass. The rule's emitted `vars: {...}` dict overrides `state.shared` lookups for the listed keys; unlisted `{{key}}` placeholders fall back to `state.shared[key]`. For simple cases pass `vars: {}` and let state.shared do all the work.

## Step 6: Conditions

Ask which conditions apply (can pick multiple):
- **Time window** — only active between HH:MM and HH:MM (set via dashboard later, or hardcode)
- **Cooldown** — minimum seconds between fires (e.g., 300 = 5 min)
- **Home mode** — only when home_mode equals a value
- **Activity level** — only when activity_level equals a value
- **None** — always active

## Step 6.5: Testable payload (for custom-event rules)

Ask: does this rule react to a **custom MQTT payload** (not a plain presence or switch event)? If yes, the dashboard's **Test** button needs a `test_event` template in the RULE dict — otherwise Test will synthesize a presence sensor event that won't match the rule's conditions and the result will always be `no_action`.

If yes, ask the user to describe a realistic payload and add it to the RULE dict:

```python
"test_event": {
    "device_id": "<device the rule listens for>",
    "source":    "event",   # or whatever source the real publisher uses
    "dps":       { ... payload that would cause the rule to fire ... },
},
```

If the rule only reacts to presence/switch events, skip this step — the default test synthesis is enough.

## Step 7: Group & Priority

Ask:
- **Group** — which group? (pixoo, info, lighting, climate, or custom name). Rules in the same group compete — highest priority wins.
- **Priority** — number (1=highest/critical, 10=normal, 50=low). Only matters within the same group.
- **Depends on** — should this rule run after specific other rules? (e.g., "Home Activity", "People Home")

## Step 7.5: Virtual Devices (consume + produce)

Rules on LXC 105 query historical state from `device_events` — including state computed by other rules, published as "virtual devices" (prefix `virtual:*`, registered with `device_type='virtual'`). See root `CLAUDE.md` > "Rules Time-Travel Architecture".

### 7.5a — Does this rule need historical state from an existing virtual device?

Query what's already available:
```sql
SELECT id, name, dps_labels FROM devices WHERE protocol = 'virtual' ORDER BY id
```

Ask the user:
- "Does this rule need to know state at a past moment — e.g., 'was anyone home 10 minutes ago', 'what was valve state when drop started', 'what was the home mode at event time'?"
- If yes, show the list of virtual devices + their fields. Ask which to consume.
- Generated code uses `state.get_device_state_at('virtual:<name>', ts)` or `state.get_events_between(...)` to query.

If the rule only cares about live/current state, `state.shared[...]` or `state.devices[...]` is fine — skip this.

### 7.5b — Does this rule compute derived state others might want later?

If the rule produces a value that other rules (now or future) might want to query at a historical moment, it should **emit a virtual device event**.

Ask the user:
- "Does this rule compute a derived state (like 'area clean', 'guest mode', 'last alarm type') that could be useful to query later — by other rules, dashboards, or retroactive analysis?"
- If yes:
  - Propose a `virtual:<snake_case_owner>` id (e.g., `virtual:guest_mode`)
  - Propose a dps schema — list of field names + human labels
  - Add `state.emit_virtual_event(...)` call at the end of `evaluate()` — dedupe is automatic, `devices` table registration is idempotent

Generated code pattern:
```python
state.emit_virtual_event(
    virtual_id='virtual:<name>',
    dps={
        'field_a': value_a,
        'field_b': value_b,
    },
    source='rule:<Rule Name>',
    name='<Human Readable Name>',
    dps_labels={
        'field_a': 'Field A Label',
        'field_b': 'Field B Label',
    },
)
```

If the rule only produces device commands (pixoo, on/off) and no derived state, skip this.

### Naming & scope guidance
- Virtual devices are for **discrete derived state** (mode flags, classifications, counts) — NOT continuous drifting values (temps, noise levels).
- Dedupe is automatic — emits only when `dps` differs from last emission. Still, emit sparingly.
- Pick `virtual:<name>` matching the rule's owning concept, not the rule name verbatim (e.g., `virtual:guest_mode` not `virtual:guest_detection_rule`).
- Existing virtual devices (as of 2026-04-14): `virtual:home_activity`, `virtual:people_home`, `virtual:boiler_status`.

### Scaling guidance — emit virtual events sparingly
- Each emission = 2-3 DB writes (~5-15ms on the main rule connection; isolated from heartbeat after the 2026-04-14 split-connection fix).
- **Emit only if another rule, dashboard card, or retroactive analysis actually queries this state.** "Might be useful later" is YAGNI.
- If the derived state flips many times per second, combine / debounce so emissions happen only on meaningful transitions. Example: Home Activity emits only when `active_rooms` list changes, not on every motion event.
- If your rule just needs to remember its last output for its OWN internal use → use `state.shared[...]` (in-memory). Virtual events are specifically for SHARING state with other rules or for historical queries.

## Step 7.75: Resource budget check

Before generating code, count current wildcard rules on-disk:
```bash
grep -l '"triggers": \["\*"\]' RULES/rules/*.py | grep -v '_template\|__init__'
```

Comfortable ceiling on LXC 105: **~15 wildcard rules** with light logic, or **~10** with heavy logic (O(n) `state.devices` scans, O(n²) loops). Past that, event dispatch latency rises from ms → 10s of ms during motion bursts.

If the new rule would bring wildcard count above these thresholds, offer these alternatives in order:

1. **Can this rule consume a `virtual:*` device instead of scanning raw events?**
   Query: `SELECT id FROM devices WHERE protocol='virtual'`
   If yes, change trigger from `"*"` to the specific virtual device id.
   Example: "notify when someone just arrived" → trigger on `virtual:people_home` changes rather than scanning everything.

2. **Can the logic live inside an existing aggregator rule?**
   If 3 small wildcard rules each do `if people_home > 1 and time_mode == 'night': ...`, consolidating them into one that branches on conditions is cheaper than 3 separate wildcard passes.

3. **If it must stay wildcard, early-return FAST.** The first 2 lines of `evaluate()`:
   ```python
   def evaluate(event, state):
       if event.get('device_id') not in MY_DEVICE_IDS:
           return []
       # ... rest only runs for matching events
   ```

Warn the user if the ceiling is approached. They can still proceed — the warning is a design-smell flag, not a block.

## Step 8: Generate & Review

### Cost checklist — run through before finalizing `evaluate()`

- [ ] No `for did, dev in state.devices.items():` loop inside `evaluate()` — that's ~115 iterations per event. Consume `state.shared['active_rooms']` (already computed by Home Activity) or another virtual-device-derived key instead.
- [ ] No `state.db_query(...)` inside `evaluate()` without TTL caching. See `wallmote_handler.py` lines 61-83 for the 30 s cache pattern. DB queries per event saturate the pool.
- [ ] No O(n²) loops on `presence_rooms`. If you need adjacency checks, reuse the corridor timers + `_are_adjacent` helper that already exist in `people_home.py`.
- [ ] `emit_virtual_event` only when dps actually differs from last emission. Dedupe is automatic, but if your dps includes noisy fields (timestamps, distance readings), dedupe won't catch them — exclude those from the emitted dps or the table will fill with near-duplicate rows.
- [ ] **Float values destined for displays / MQTT publishes get rounded to 1 decimal.** If your rule pushes a sensor reading (temp / humidity / RSSI / voltage) into `state.shared`, an `emit_virtual_event` dps field, or a command's `vars` dict that's substituted into a Pixoo/Awtrix/HASP template, round it: `round(val, 1)` or `f"{val:.1f}"`. Otherwise downstream `_fmt()` substitution handles it but float micro-noise (`21.039999961853 → 21.040001869202`) blows past `last_value` dedupe and triggers spurious publishes every heartbeat. See [Float rounding feedback](../../projects/c--Users-muroc-project-home/memory/feedback_float_rounding.md).
- [ ] Cooldown timer **mandatory** for rules that emit device commands (pixoo, turn_on/off, MQTT pushes). Without cooldown, a noisy trigger floods the command bus. Minimum 1 s; typically 30-300 s.

Generate the Python rule file using these templates:

### File template:
```python
"""{description}

{additional_notes}
"""

{constants}

RULE = {{
    "name": "{name}",
    "description": "{description}",
    "triggers": {triggers},
    "controls": [],
    "category": "{category}",
    "group": "{group}",
    "priority": {priority},
    "depends_on": {depends_on},
}}


def evaluate(event, state):
    commands = []

    {trigger_code}

    {action_code}

    return commands
```

### Trigger code patterns:

**Presence:**
```python
    dev_id = event.get("device_id", "")
    device = state.devices.get(dev_id, {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")

    if dtype == "presence" and room.lower() in ({rooms_tuple}):
        dps = event.get("dps", {})
        presence_val = dps.get("1")
        if presence_val in (True, "true", "presence", 1, "True"):
            {cooldown_check}
            {action}
```

**Switch:**
```python
    dev_id = event.get("device_id", "")
    device = state.devices.get(dev_id, {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")

    if dtype in ("switch", "circuit_breaker", "light") and room.lower() in ({rooms_tuple}):
        {cooldown_check}
        {action}
```

**State change:**
```python
    prev = state.shared.get("_prev_{key}", "")
    curr = state.shared.get("{key}", "")
    if curr != prev:
        state.shared["_prev_{key}"] = curr
        {cooldown_check}
        {action}
```

**Timer/idle:**
```python
    activity = state.shared.get("activity_level", "idle")
    if activity == "idle":
        idle_time = state.get_timer("last_motion")
        if idle_time > {timeout_sec}:
            if state.shared.get("_{rule}_done") != "yes":
                state.shared["_{rule}_done"] = "yes"
                {action}
    else:
        state.shared["_{rule}_done"] = "no"
```

### Action code patterns:

**Pixoo preset:**
```python
                commands.append({
                    "device_id": "pixoo",
                    "protocol": "pixoo",
                    "action": "push_preset",
                    "preset_name": "{preset_name}",
                    "vars": {vars_dict},
                })
```

**Pixoo resume:**
```python
                commands.append({
                    "device_id": "pixoo",
                    "protocol": "pixoo",
                    "action": "resume",
                })
```

**Awtrix on/off:**
```python
                commands.append({
                    "device_id": "awtrix_05ec2c",       # MQTT prefix = device id
                    "protocol":  "awtrix",
                    "action":    "{turn_on_or_off}",     # 'power_on' or 'power_off'
                })
```

**Awtrix preset (with variable substitution):**
```python
                commands.append({
                    "device_id":   "awtrix_05ec2c",
                    "protocol":    "awtrix",
                    "action":      "push_preset",
                    "preset_name": "{preset_name}",
                    "vars":        {vars_dict},  # e.g. {"boiler_temp": state.shared.get("boiler_temp")}
                })
```
Rule engine resolves the preset from `dashboard_settings.awtrix.messages`,
substitutes `{{key}}` against `cmd['vars']` first then `state.shared`,
translates stored fields to wire format (`text` / `color` / `scrollSpeed` /
`textCase` / `duration` / `blinkText` / `rtttl`/`sound`), publishes to
`awtrix_05ec2c/notify`. Empty `vars` ⇒ all substitutions come from
`state.shared`. Required ACL on LXC 107 (already in place):
`rule_engine` has `topic write awtrix_05ec2c/{power,notify}`.

**Device on/off:**
```python
                commands.append({
                    "device_id": "{device_id}",
                    "action": "{turn_on_or_off}",
                })
```

### Cooldown pattern:
```python
            cooldown = state.get_timer("{rule_snake}_cooldown")
            if cooldown > {cooldown_sec}:
                state.set_timer("{rule_snake}_cooldown")
```

## Step 9: Deploy

After the user approves the generated code:

1. Write the file to `RULES/rules/{filename}.py`
2. Deploy to LXC 105:
   ```bash
   scp RULES/rules/{filename}.py root@192.168.1.187:/opt/main-agent/project/RULES/rules/
   ```
3. Tell the user: "Rule deployed. Click **Reload** on the Main Agent dashboard to load it — the button stays on **Reloading...** until the engine confirms the new rule is loaded (up to ~60s on the next background cycle), then returns to **Reload**."
4. After reload, suggest: "Try clicking **Test** or **Force** on the new rule to verify it works."

## Important Notes

- **Default to SPECIFIC triggers** (list of device_ids). Wildcard `"*"` is ONLY for true aggregator rules (Home Activity, People Home, Wallmote Handler) that genuinely need to see every event. Each wildcard rule is a tax on every event the system sees.
- Category options: "info" (state only), "display" (pixoo), "control" (device commands), "safety" (critical)
- The `evaluate(event, state)` function receives every matching event and must return a list of command dicts (or empty list)
- State is shared between rules — use `state.shared` for persistent data, `state.set_timer`/`state.get_timer` for cooldowns
- Always protect commands with cooldown timers to prevent rapid fire
- `state.devices[id]` has: dps, online, name, room, device_type, protocol
- People count: `int(state.shared.get("people_home", 0))`
- Activity: `state.shared.get("activity_level", "idle")` — values: "idle", "low", "active"
- **Scaling ceiling on current hardware:** 30-50 mixed rules comfortable; 15-20 wildcard rules is a soft cap; 20+ heavy wildcard rules (iterating `state.devices`, O(n²) scans) is a design smell — consolidate into aggregator rules before crossing.
- **First rule of performance:** prefer specific triggers. **Second rule:** consume `virtual:*` events rather than scanning raw state. **Third rule:** cache DB queries with TTL. If you're doing none of those, your rule is probably too heavy.

---

## Audit Procedure (when action = Audit)

Read-only static analysis of rule files against the Cost Checklist from Step 8. No file is modified. Produce a report.

### Step A0: Ask which rules to audit

Use `AskUserQuestion` to pick the scope:

- **All rules** — sweep every `RULES/rules/*.py` (except `_template.py` and `__init__.py`). Use for monthly health check or when the user says "audit rules" without specifying.
- **One specific rule** — if chosen, list the rule files (excluding templates) and ask which one. Run the checks against that single file only. Use when the user suspects a specific rule is slow or misbehaving.

The check set is the same in both modes; only the file scope differs.

### Severity calibration by trigger type (IMPORTANT)

Cost-per-event and cost-per-fire are different numbers. A `state.devices` iteration that costs 0.1 ms per call:
- **Wildcard (`"*"`)** — fires ~1×/sec → ~360 ms/hour → **medium severity** (the baseline in the table below)
- **Specific device_id(s)** — fires only on matching events (maybe 5-100×/day) → negligible CPU → **severity downgraded to low**, often ignorable
- **Heartbeat (`["heartbeat"]`)** — fires every 60 s → noticeable but bounded → **severity low-medium**
- **Virtual device trigger (`["virtual:X"]`)** — fires as often as the producing rule emits → usually low
- **Event-specific (`["boiler"]`, `["<device-id>"]`)** — fires only on real events of that type → **low**

When applying checks 2, 3, and 5 (heavy loops + DB queries), **look at the RULE dict's `triggers` field first** and calibrate the reported severity accordingly. A check 2 hit in a wildcard rule is medium; the same pattern in a specific-triggered rule is low and often a false alarm not worth reporting.

Checks 4 (cooldown) and 6 (noisy dps) are severity-invariant — cooldown matters regardless of fire rate, and noisy dps defeats dedupe regardless.

### Checks

| # | Check | Detection | Default severity | Downgrade for specific triggers? |
|---|---|---|---|---|
| 1 | **Wildcard count exceeds soft cap** | Count files with `"triggers": ["*"]`; if total > 15, flag every wildcard rule with a note "consider specific trigger or virtual:* consumer" | medium if count > 15, low if count 10-15 | N/A — check 1 only applies to wildcard rules |
| 2 | **Heavy `state.devices` iteration** in `evaluate()` | `grep -E "for\s+\w+,?\s*\w*\s+in\s+state\.devices\.(items\|values\|keys)\(" INSIDE the evaluate function` | **medium** (wildcard — iterates ~115 devices per event) | **low** for heartbeat / specific triggers. Often not worth reporting at all if the rule fires <100×/day. |
| 3 | **Unguarded `state.db_query` / `state.get_*` historical helpers in `evaluate()`** | `state.db_query(`, `state.get_device_state_at(`, `state.get_last_transition_before(`, `state.get_events_between(` inside the evaluate function, with no nearby `_cache_ts`/`_cache_ttl_sec`/`time.time()` TTL pattern (check ±30 lines around the call) | **high** (wildcard — DB roundtrip per event) | **low** for specific / event-triggered rules that fire rarely. The boiler consumption classifier is the canonical example — multiple `get_events_between` calls per fire, but fires ~20×/day → 60 queries/day, negligible. |
| 4 | **Command emission without cooldown** | File has `commands.append(` AND no matching `state.set_timer(.+cooldown` + `state.get_timer(.+cooldown` pair (or equivalent debounce like `_last_fired_ts` tracking) | **high** — severity-invariant | No — a noisy trigger floods the command bus regardless of trigger type |
| 5 | **O(n²) loop on presence/active rooms** | Nested `for` loops where both iterate `presence_rooms`, `active_rooms`, or similar collections | **low-medium** depending on collection size | Downgrade to low for specific/heartbeat triggers. People Home's §5 adjacency dedupe is O(n²) but n ≤ 5 — not worth reporting even for wildcard. |
| 6 | **Noisy `emit_virtual_event` dps** | `emit_virtual_event(` call where the `dps={}` dict includes fields with names matching `distance`, `amplitude`, `raw_value`, `timestamp`, `ts`, `linkquality`, `rssi` (these drift and defeat dedupe, filling the events table with near-duplicates) | **medium** — severity-invariant | No — but check whether the timestamp field is the natural unique key of the event (like `last_start_ts` for consumption events, which SHOULD change per emission). If so, drop the finding. |
| 7 | **Rule file length** | File > 300 lines (`wc -l`) | low (suggest split into smaller rules or helper module) | N/A — file size doesn't depend on trigger |

### Process

1. Resolve the target file list based on Step A0's answer:
   - **All rules**: `ls RULES/rules/*.py` → filter out `_template.py`, `__init__.py`.
   - **One specific rule**: just that one file.
2. Read each target file.
3. Run each check. For each hit, record the file, line (if applicable), check number, and severity.
4. Print the wildcard count summary first (check 1 context — always computed across ALL rules, even in single-file mode, so the user sees the global ceiling).
5. Print a per-rule table: `Rule | Issue | Severity | Suggestion`. Group by rule file so the user can scan one rule at a time.
6. End with a summary line: `Audited N rules, M issues found across K rules (L rules clean).` — N matches the scope (1 in single-file mode, all in full-sweep mode).

### What the report does NOT do

- No changes to any file.
- No deploy.
- No severity escalation based on runtime metrics — this is a static-analysis pass. Runtime profiling is a separate `/review-code lxc 105` step.

### When the user should run Audit

- Periodically (e.g., monthly) as a health check
- Before adding a new wildcard rule — confirm you're not close to the ceiling
- After a performance issue on LXC 105 — narrow down which rule grew teeth
- After a rule refactor — confirm no regressions on the cost checklist
