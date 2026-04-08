# Task 5: Starter Rules (Read-Only)

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 10

## Description
Create the rules directory structure and starter rules. These are read-only rules that compute shared state from presence sensors — no commands sent. HA still controls all devices. Purpose: validate rule interface works and provide computed home state for future dashboard.

## Original Plan Context
New files in `RULES/rules/`: `_template.py`, `home_activity.py` (activity level from presence sensors), `people_home.py` (people count + occupied rooms). No commands — only compute shared state. HA still controls devices. Acceptance: presence events update shared state, computed state published to MQTT.

## Steps
1. Create `RULES/rules/` directory
2. Create `RULES/rules/__init__.py` (empty)
3. Create `RULES/rules/_template.py` — template rule file (skipped by loader, starts with `_`):
   ```python
   RULE = {
       "name": "Template Rule",
       "description": "Copy this file and modify for your rule",
       "triggers": [],     # device IDs that trigger this rule
       "controls": [],     # device IDs this rule may command
       "category": "info", # lighting, security, comfort, info
   }

   def evaluate(event, state):
       """Called on each matching event. Return list of command dicts or empty list."""
       return []
   ```
4. Create `RULES/rules/home_activity.py`:
   - `RULE`: name="Home Activity", triggers=all presence sensor IDs, category="info"
   - `evaluate()`:
     - Check all presence sensor devices in `state.devices`
     - Count how many have DPS "1" == True (active presence)
     - Determine activity level: "idle" (0), "low" (1-2), "active" (3+)
     - Find last motion room (most recent presence detection)
     - Update `state.shared["activity_level"]`, `state.shared["last_motion_room"]`
     - Return [] (no commands)
5. Create `RULES/rules/people_home.py`:
   - `RULE`: name="People Home", triggers=all presence sensor IDs, category="info"
   - `evaluate()`:
     - Check all presence sensors — group by room
     - Count rooms with active presence → rough people estimate
     - Build occupied rooms list
     - Update `state.shared["people_home"]`, `state.shared["occupied_rooms"]`
     - Return [] (no commands)
6. Get presence sensor device IDs from DB to populate triggers lists (query: `SELECT id FROM devices WHERE device_type = 'presence' AND enabled = true`)

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
