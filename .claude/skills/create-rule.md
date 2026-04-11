---
description: Create, edit, or remove a rule engine automation rule
user-invocable: true
---

# /create-rule — Rule Engine Rule Builder

You are building a rule for the home automation rule engine on LXC 105. Follow this interactive flow step by step. Use AskUserQuestion for each step. Do NOT skip steps or assume answers.

## Step 0: Action

Ask the user what they want to do:
- **Create** — build a new rule from scratch
- **Edit** — modify an existing rule (list rules from `RULES/rules/*.py`, excluding `_template.py` and `__init__.py`)
- **Remove** — delete a rule (list, confirm, delete from local + deploy)

If **Remove**: list existing rules, confirm selection, delete the `.py` file locally and on LXC 105 (`/opt/main-agent/project/RULES/rules/`), then tell the user to click Reload on the dashboard. Done.

If **Edit**: list existing rules, ask which one, read the file, ask what to change (trigger, action, conditions, group/priority, or full rewrite), make changes, show modified code, get approval, deploy.

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
- **Any device** — wildcard, fires on every device event (for info/state rules)
- **State change** — fires when a specific shared state key changes
- **Timer-based** — fires based on timer conditions (idle timeout, etc.)

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

## Step 6: Conditions

Ask which conditions apply (can pick multiple):
- **Time window** — only active between HH:MM and HH:MM (set via dashboard later, or hardcode)
- **Cooldown** — minimum seconds between fires (e.g., 300 = 5 min)
- **Home mode** — only when home_mode equals a value
- **Activity level** — only when activity_level equals a value
- **None** — always active

## Step 7: Group & Priority

Ask:
- **Group** — which group? (pixoo, info, lighting, climate, or custom name). Rules in the same group compete — highest priority wins.
- **Priority** — number (1=highest/critical, 10=normal, 50=low). Only matters within the same group.
- **Depends on** — should this rule run after specific other rules? (e.g., "Home Activity", "People Home")

## Step 8: Generate & Review

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
3. Tell the user: "Rule deployed. Click **Reload** on the Main Agent dashboard to load it."
4. After reload, suggest: "Try clicking **Test** or **Force** on the new rule to verify it works."

## Important Notes

- Always use `triggers: ["*"]` unless the rule should only fire on specific device IDs
- Category options: "info" (state only), "display" (pixoo), "control" (device commands), "safety" (critical)
- The `evaluate(event, state)` function receives every matching event and must return a list of command dicts (or empty list)
- State is shared between rules — use `state.shared` for persistent data, `state.set_timer`/`state.get_timer` for cooldowns
- Always protect commands with cooldown timers to prevent rapid fire
- `state.devices[id]` has: dps, online, name, room, device_type, protocol
- People count: `int(state.shared.get("people_home", 0))`
- Activity: `state.shared.get("activity_level", "idle")` — values: "idle", "low", "active"
