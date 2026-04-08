# Tech Design: Rule Engine

**Discovery:** [discovery.md](discovery.md)
**Date:** 2026-04-08
**Status:** Draft

## 1. Summary

Build a persistent Rule Engine service on LXC 105 that subscribes to all MQTT device events, evaluates Python-coded automation rules against in-memory device/room state, and sends commands back via MQTT. Rules are authored by Claude from user prompts, human-readable, and LLM-editable. A prerequisite Device Agent command handler bridges MQTT commands to HA API for Tuya device control. HASP/Zigbee/Awtrix commands go direct via native MQTT.

### Non-Goals
- Dashboard rule management page (v2)
- HA automation migration
- Replacing Boiler Agent logic (stays independent)
- Voice command integration (future)
- LLM auto-editing of rules (future — structure supports it)

## 2. Current Behavior

No automation engine exists. Device control is manual (dashboard toggle → HA API). Boiler Agent is the only automated control loop (single-purpose). HASP/Zigbee/Awtrix devices receive no automated commands. All device events already flow through MQTT via Device Agent (implemented in mqtt-publish feature).

## 3. To-Be Behavior

### System Flow

```
1. Rule Engine starts → connects MQTT → loads devices/rooms from DB into memory
2. Subscribes to mur/home/device/+/event, hasp/#, awtrix/#, zigbee2mqtt/#
3. Retained state messages bootstrap current device states
4. On each MQTT event:
   a. Update in-memory device state
   b. Find rules triggered by this device
   c. For each matching rule: evaluate(event, state) → list of commands
   d. Loop detection check on each command
   e. Publish commands to MQTT
5. Device Agent receives mur/home/device/{id}/command → calls HA API → publishes response
6. HASP/Zigbee/Awtrix receive native MQTT commands directly
7. Every 5 min: write heartbeat to rule_engine_log
8. At midnight: refresh device/room mapping from DB
```

### Command Flow

```
Rule Engine                          Device Agent                    Device
    │                                     │                            │
    ├─ mur/home/device/{id}/command ──►   │                            │
    │  {"action":"turn_on","channel":"1"} │                            │
    │                                     ├─ HA API service call ──►   │
    │                                     │                            │ (turns on)
    │   ◄── mur/home/device/{id}/        │                            │
    │       command/response              │                            │
    │       {"ok":true,"entity":"..."}    │                            │
    │                                     │                            │
    ├─ hasp/plate01/command/p1b4.val ─────────────────────────────►   │
    │  "1"                                                     (HASP direct)
    │                                                                  │
    ├─ zigbee2mqtt/light1/set ────────────────────────────────────►   │
    │  {"state":"ON","brightness":200}                        (Z2M direct)
```

## 4. Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Rule storage | Python files in `RULES/` dir in git repo | DB table, YAML, JSON | Code-reviewable, version-controlled, LLM can parse and edit Python. Deploy via git pull |
| Rule interface | `RULE` metadata dict + `evaluate(event, state)` function | Class-based, decorator-based | Simple, flat, human-readable. RULE dict is machine-parseable for dashboard/LLM |
| State layer | Shared in-memory dict (`state`) all rules read/write | Per-rule state, event sourcing | Rules communicate via state, not direct calls. No circular dependencies. Fast dict lookup |
| Rule indexing | Rules indexed by trigger device at load time | Scan all rules per event | O(1) lookup per event instead of O(N). Critical for speed with hundreds of rules |
| Command path (Tuya) | MQTT → Device Agent → HA API | Rule Engine calls HA directly | HA token stays in one place. Entity resolution already in Device Agent. Future: swap to direct tinytuya without Rule Engine changes |
| Command path (HASP/Zigbee/Awtrix) | MQTT direct to native topics | Route through Device Agent | No middleman needed. Native MQTT protocol. Fastest possible path |
| Loop detection | Track last N commands per device; 4x same command in 10s → auto-disable rule | Fixed rate limit per device | Allows fast legitimate use. Only catches actual loops |
| Enable/disable | Runtime via MQTT topic, persisted in `rule_engine_state` | File rename, DB flag | Instant response, no restart needed. Future dashboard toggle via MQTT |
| Venv | Shared `/opt/main-agent/venv` | Separate `/opt/rule-engine/venv` | Same dependencies (psycopg2, paho-mqtt). Saves disk on 512MB LXC |
| Rule Engine location | `RULES/` directory in project root | Inside ORCHESTRATOR/ | Clean separation — RULES is its own domain, not part of orchestrator |

## 5. Interfaces / Models

### Rule File Interface

```python
# RULES/rules/kitchen_presence_light.py

RULE = {
    "name": "Kitchen Presence Light",
    "description": "Turn on kitchen light when someone enters kitchen, off after 5 min of no motion",
    "triggers": ["bf701209c99a59a811ueop"],  # Kitchen Presence Sensor device_id
    "controls": ["32104641ecfabc567240"],     # Kitchen Switch device_id
    "category": "lighting",                    # lighting, security, comfort, info
}

def evaluate(event, state):
    """
    event — dict: {"device_id": str, "dps": dict, "source": str, "ts": str}
    state — StateManager instance with:
        state.devices[device_id] → {"dps": {...}, "online": bool, "name": str, "room": str, ...}
        state.rooms[room_name] → {"devices": [device_id, ...]}
        state.shared → dict (persistent shared state: home_mode, people_home, etc.)
        state.get_timer(name) → float (seconds since timer was set)
        state.set_timer(name) → records current timestamp
    
    Returns: list of Command dicts, or empty list
        {"device_id": str, "action": str, "channel": str (optional), **kwargs}
    """
    presence = state.devices.get("bf701209c99a59a811ueop", {})
    dps = presence.get("dps", {})
    
    # DPS key "1" = presence state for Tuya presence sensors
    if dps.get("1") == True:
        state.set_timer("kitchen_last_motion")
        return [{"device_id": "32104641ecfabc567240", "action": "turn_on", "channel": "1"}]
    
    # No motion for 5 minutes → turn off
    if state.get_timer("kitchen_last_motion") > 300:
        return [{"device_id": "32104641ecfabc567240", "action": "turn_off", "channel": "1"}]
    
    return []
```

### StateManager

```python
# RULES/state_manager.py

class StateManager:
    """In-memory device/room state with shared persistent state."""
    
    def __init__(self, db_config: dict):
        self.devices: dict[str, dict] = {}      # device_id → {dps, online, name, room, ...}
        self.rooms: dict[str, dict] = {}         # room_name → {devices: [id, ...]}
        self.shared: dict = {}                    # persistent shared state
        self._timers: dict[str, float] = {}       # timer_name → timestamp
    
    def load_from_db(self):
        """Load devices + rooms from PostgreSQL. Called at startup and midnight."""
    
    def load_shared_state(self):
        """Load shared state from rule_engine_state table."""
    
    def save_shared_state(self):
        """Persist shared state to rule_engine_state table."""
    
    def update_device(self, device_id: str, dps: dict, source: str):
        """Merge incoming DPS into device state."""
    
    def update_availability(self, device_id: str, online: bool):
        """Update device online status."""
    
    def set_timer(self, name: str):
        """Record current time for a named timer."""
    
    def get_timer(self, name: str) -> float:
        """Seconds since timer was set. Returns float('inf') if never set."""
```

### RuleEngine

```python
# RULES/rule_engine.py

class RuleEngine:
    """Main engine: loads rules, subscribes to MQTT, evaluates and dispatches."""
    
    def __init__(self):
        self.mqtt: MqttPublisher       # MQTT client
        self.state: StateManager       # in-memory state
        self.rules: list[Rule]         # loaded rule modules
        self.trigger_index: dict       # device_id → [rule, ...]
        self._disabled_rules: set      # rule names disabled at runtime
        self._command_log: dict        # device_id → [(ts, action), ...] for loop detection
    
    def load_rules(self):
        """Import all .py files from RULES/rules/ directory."""
    
    def _index_rules(self):
        """Build trigger_index: device_id → list of rules that trigger on it."""
    
    def on_mqtt_event(self, client, userdata, msg):
        """MQTT callback: update state, find matching rules, evaluate, dispatch."""
    
    def _evaluate_rule(self, rule, event: dict) -> list[dict]:
        """Call rule.evaluate(event, state), catch exceptions."""
    
    def _dispatch_command(self, cmd: dict, rule_name: str):
        """Publish command to MQTT. Check loop detection first."""
    
    def _check_loop(self, device_id: str, action: str, rule_name: str) -> bool:
        """Return True if this looks like a loop (4x same cmd in 10s)."""
    
    def _disable_rule(self, rule_name: str):
        """Remove rule from evaluation. Persist to rule_engine_state."""
    
    def _enable_rule(self, rule_name: str):
        """Re-add rule to evaluation."""
```

### Command Payload Schema

```python
# Tuya command (via Device Agent)
{
    "action": "turn_on",        # turn_on, turn_off, set_brightness, set_color_temp, set_position
    "channel": "1",             # optional, for multi-switch devices
    "brightness": 200,          # optional, 0-255
    "color_temp": 400,          # optional, mireds
    "position": 50,             # optional, 0-100 for covers
    "rule": "kitchen_light"     # which rule sent this (for logging)
}

# Command response (from Device Agent)
{
    "ok": true,
    "entity_id": "switch.kitchen_switch_1",
    "service": "switch.turn_on",
    "error": null
}
```

## 6. Implementation Details

### Component 1: Device Agent command handler (prerequisite)

- **File:** `DEVICE/agent/device_agent.py` (modify)
- **Changes:** Subscribe to `mur/home/device/+/command`, handle commands by calling HA API
- **Extract — `_setup_command_handler()`:**
  ```python
  def _setup_command_handler(self):
      """Subscribe to command topic and set callback."""
  ```
- **Extract — `_on_command(client, userdata, msg)`:**
  ```python
  def _on_command(self, client, userdata, msg):
      """Handle device command: resolve HA entity, call HA API, publish response."""
  ```
- **Details:**
  - Parse device_id from topic: `mur/home/device/{device_id}/command`
  - Parse JSON payload: `action`, `channel` (optional), `brightness`/`color_temp`/`position` (optional)
  - Reuse HA API adapter's `_entity_map` to resolve device_id → HA entity
  - Entity selection logic: same priority as dashboard toggle (prefer `_switch` suffix, skip `child_lock`/`countdown`/`indicator`)
  - Map action to HA service: `turn_on` → `switch.turn_on`, `set_brightness` → `light.turn_on` with `brightness` attribute, `set_position` → `cover.set_cover_position`
  - Call HA API via requests (same pattern as dashboard toggle)
  - Publish response to `mur/home/device/{device_id}/command/response`
  - HA_TOKEN already available in Device Agent environment
  - Must NOT subscribe via `_mqtt.subscribe()` (that overwrites `on_message`). Instead, add topic to existing subscription list in `_setup_mqtt_ingest()`

### Component 2: StateManager

- **File:** `RULES/state_manager.py` (new)
- **Changes:** New file — in-memory device/room state manager
- **Details:**
  - `load_from_db()`: query `devices` (id, name, room, device_type, protocol, last_state, enabled) + `rooms` (name). Build `self.devices` and `self.rooms` dicts
  - `load_shared_state()`: query `rule_engine_state` table → populate `self.shared`
  - `save_shared_state()`: UPSERT all `self.shared` keys to `rule_engine_state`
  - `update_device()`: merge DPS into existing device state (same as Device Agent cache)
  - `set_timer()` / `get_timer()`: timer dict for time-based rules. Timers also persisted to `rule_engine_state` with prefix `_timer:`
  - DB connection: single connection with autocommit, reconnect on error (same pattern as Device Agent)

### Component 3: RuleEngine core

- **File:** `RULES/rule_engine.py` (new)
- **Changes:** New file — main engine service
- **Details:**
  - `__init__()`: create MqttPublisher (copy from Device Agent), create StateManager, set up signal handlers
  - `load_rules()`: scan `RULES/rules/*.py`, import each module, validate `RULE` dict has required keys. Skip files starting with `_`. Load disabled list from `rule_engine_state`
  - `_index_rules()`: for each rule, add to `trigger_index[device_id]` for each device in `RULE["triggers"]`. Also add wildcard `"*"` trigger for rules that fire on any event
  - `on_mqtt_event()`:
    1. Parse event (topic → device_id + payload)
    2. `state.update_device(device_id, dps, source)`
    3. Look up `trigger_index[device_id]` + `trigger_index["*"]`
    4. For each matching rule (skip disabled): call `_evaluate_rule()`
    5. For each returned command: call `_dispatch_command()`
  - `_dispatch_command()`:
    - Check loop detection first
    - Route by device type: Tuya → `mur/home/device/{id}/command`, HASP → `hasp/{node}/command/...`, Zigbee → `zigbee2mqtt/{name}/set`, Awtrix → `awtrix/{id}/custom`
    - Publish with QoS 1 for commands (delivery matters)
  - `_check_loop()`: track `(device_id, action, timestamp)` in a deque per device. If 4+ identical actions in 10s → return True, auto-disable the rule
  - LWT on `mur/home/rule-engine/state` → `{"state":"offline"}`
  - Heartbeat: every 300s write to `rule_engine_log` (decision = running stats, error = NO ERROR)
  - Persist shared state every 60s (batch, not per-event)

### Component 4: MqttPublisher copy for Rule Engine

- **File:** `RULES/mqtt_client.py` (new)
- **Changes:** Copy of `DEVICE/agent/adapters/mqtt_publisher.py` adapted for Rule Engine
- **Details:**
  - Same core class, different topic prefix: `mur/home/rule-engine`
  - LWT topic: `mur/home/rule-engine/state`
  - Additional method: `publish_command()` — wraps publish with QoS 1
  - Remove device-specific helpers (publish_device_state, publish_availability, etc.)
  - Keep: `connect()`, `disconnect()`, `subscribe()`, `publish()`, `is_connected`

### Component 5: Rule loader and computed state publisher

- **File:** `RULES/rule_engine.py` (part of Component 3)
- **Extract — `_publish_computed_state()`:**
  ```python
  def _publish_computed_state(self):
      """Publish computed home state to MQTT for dashboard (debounced, max every 2s)."""
  ```
- **Details:**
  - Publishes to `mur/home/rule-engine/computed/people_home`, `mur/home/rule-engine/computed/activity`, etc.
  - Computed from shared state variables set by rules
  - Debounced: max once per 2 seconds to avoid MQTT spam
  - Dashboard subscribes to these for live display (future Main Agent page)

### Component 6: Enable/disable handler

- **File:** `RULES/rule_engine.py` (part of Component 3)
- **Details:**
  - Subscribe to `mur/home/rule-engine/disable/+` and `mur/home/rule-engine/enable/+`
  - On disable: remove rule from `trigger_index`, add to `_disabled_rules`, persist to `rule_engine_state`
  - On enable: reload rule file, re-index, remove from `_disabled_rules`, persist

### Component 7: Mosquitto user + ACL

- **Target:** LXC 107
- **Changes:** Create `rule_engine` user, add ACL entries
- **ACL:**
  ```
  user rule_engine
  topic read mur/home/device/#
  topic read hasp/#
  topic read awtrix/#
  topic read zigbee2mqtt/#
  topic write mur/home/device/+/command
  topic write mur/home/rule-engine/#
  topic write hasp/+/command/#
  topic write zigbee2mqtt/+/set
  topic write awtrix/+/custom
  topic write awtrix/+/notify
  ```

### Component 8: DB tables + agent registration

- **Target:** LXC 102
- **SQL:**
  ```sql
  CREATE TABLE rule_engine_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      decision TEXT,
      error TEXT,
      next_ts TIMESTAMPTZ
  );

  CREATE TABLE rule_engine_state (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  INSERT INTO agents (name, lxc_id, lxc_ip, service_name, data_table, enabled)
  VALUES ('rule-engine', 105, '192.168.1.187', 'rule-engine', 'rule_engine_log', true);

  INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours)
  VALUES ('rule_engine_log', 30, true, 24);
  ```

### Component 9: Systemd service + env file

- **Target:** LXC 105
- **File:** `RULES/rule-engine.service`
  ```ini
  [Unit]
  Description=Rule Engine — MQTT automation service
  After=network.target

  [Service]
  Type=simple
  ExecStart=/opt/main-agent/venv/bin/python3 /opt/main-agent/project/RULES/rule_engine.py
  EnvironmentFile=/etc/rule-engine.env
  Restart=on-failure
  RestartSec=10
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```
- **Env file** `/etc/rule-engine.env`:
  ```
  MQTT_BROKER=192.168.1.189
  MQTT_USER=rule_engine
  MQTT_PASS=<password>
  DB_HOST=192.168.1.219
  DB_NAME=home_data
  DB_USER=postgres
  ```

### Component 10: Example starter rules

- **Directory:** `RULES/rules/`
- **Files:** 2-3 simple rules to validate the system
- **Examples:**
  - `_template.py` — template rule file (not loaded, starts with `_`)
  - `home_activity.py` — computes `activity_level` shared state from all presence sensors (read-only, no commands)
  - `people_home.py` — computes `people_home` count and `occupied_rooms` list from presence sensors (read-only, no commands)
  - Note: HA still controls all devices. These starter rules only compute shared state for dashboard visualization. Device control rules added later when ready to migrate from HA.

## 7. Config / Segmentation Plan

| Key | Type | Default | Location | Notes |
|-----|------|---------|----------|-------|
| `MQTT_BROKER` | string | `192.168.1.189` | `/etc/rule-engine.env` | Mosquitto broker |
| `MQTT_USER` | string | `rule_engine` | `/etc/rule-engine.env` | MQTT username |
| `MQTT_PASS` | string | — | `/etc/rule-engine.env` | MQTT password |
| `DB_HOST` | string | `192.168.1.219` | `/etc/rule-engine.env` | PostgreSQL host |
| `DB_NAME` | string | `home_data` | `/etc/rule-engine.env` | Database name |
| `DB_USER` | string | `postgres` | `/etc/rule-engine.env` | DB user |

## 8. BI Event Spec

N/A — Rule Engine logs to `rule_engine_log` table and publishes computed state to MQTT.

## 9. Error Handling & Edge Cases

| Scenario | Handling | Fallback |
|----------|----------|----------|
| MQTT broker down at startup | paho auto-reconnect. Engine starts but can't evaluate | Retained messages bootstrap on reconnect |
| MQTT broker down mid-operation | paho auto-reconnect. Commands during disconnect lost | Devices stay in current state. Rule Engine resumes on reconnect |
| Rule raises exception | Caught per-rule. Log error. Skip rule this event. Don't disable | Other rules continue evaluating |
| Rule takes >100ms | Log warning. No timeout kill (could leave shared state inconsistent) | Rules must be fast — no DB/HTTP in evaluate() |
| Loop detected (4x same cmd/10s) | Auto-disable causing rule. Log error. Publish to `rule-engine/alert` | Rule stays disabled until manually re-enabled |
| Device offline | `state.devices[id]["online"] == False`. Rules should check before commanding | Command sent anyway (HA will fail gracefully) |
| Unknown device in command | Device Agent logs warning, publishes `{"ok":false,"error":"unknown device"}` | Rule Engine logs failed command |
| DB down | StateManager reconnects. Shared state writes fail silently (in-memory continues) | Heartbeat log writes fail — Orchestrator detects stale log |
| LXC 105 OOM | Rule Engine killed, systemd restarts in 10s | On restart: reload state from DB + MQTT retained |
| New device added mid-day | Picked up from `_bridge/devices` inventory (subscribed). Also midnight refresh | New device available within seconds of inventory publish |

## 10. Rollout Plan

- **Phase 1:** Deploy Device Agent command handler + Rule Engine with 2 starter rules (low-risk: presence light, home activity)
- **Phase 2:** Monitor for 48h. Check: commands execute correctly, no loops, heartbeat stable
- **Phase 3:** Add more rules incrementally (user prompts → Claude writes → user approves)
- **Rollback:** `systemctl stop rule-engine` on LXC 105. All devices stay in current state. Dashboard toggle still works.

## 11. Test Plan

### Manual Checklist
- [ ] Rule Engine starts, connects MQTT, logs "online"
- [ ] `mosquitto_sub` shows `mur/home/rule-engine/state` = online
- [ ] Trigger presence sensor → kitchen light turns on
- [ ] Wait 5 min no motion → kitchen light turns off
- [ ] Disable rule via MQTT → rule stops evaluating
- [ ] Enable rule via MQTT → rule resumes
- [ ] Kill Mosquitto → Rule Engine reconnects, resumes
- [ ] Kill Rule Engine → LWT fires, `rule-engine/state` = offline
- [ ] Restart Rule Engine → state restored from DB + retained messages
- [ ] Send malformed command → Device Agent rejects, publishes error response
- [ ] Orchestrator detects Rule Engine via `agents` table, checks health

## 12. Ordered Task List

1. **Device Agent command handler** → Add `mur/home/device/+/command` subscription to Device Agent. Parse command payload, resolve HA entity (reuse entity_map from HA adapter), call HA API, publish response. Files: `DEVICE/agent/device_agent.py`. Acceptance: publish command to MQTT → device toggles, response published.

2. **StateManager class** → New file `RULES/state_manager.py`. In-memory device/room state, shared persistent state, timers. Load from DB, merge MQTT updates, persist shared state. Acceptance: load devices from DB, update via dict, save/restore shared state.

3. **Rule Engine core** → New file `RULES/rule_engine.py`. MQTT subscribe, rule loading, trigger indexing, event routing, command dispatch, loop detection, enable/disable, heartbeat. Acceptance: starts, connects MQTT, loads rules, evaluates on events, dispatches commands.

4. **MQTT client for Rule Engine** → New file `RULES/mqtt_client.py`. Adapted copy of MqttPublisher for Rule Engine topic prefix + command publishing. Acceptance: connects, subscribes, publishes commands with QoS 1.

5. **Starter rules (read-only)** → New files in `RULES/rules/`: `_template.py`, `home_activity.py` (activity level from presence sensors), `people_home.py` (people count + occupied rooms). No commands — only compute shared state. HA still controls devices. Acceptance: presence events update shared state, computed state published to MQTT.

6. **Infrastructure setup** → Mosquitto user/ACL, DB tables, agent registration, systemd service, env file. Acceptance: Rule Engine service starts on LXC 105, Orchestrator monitors it.

## 13. Open Items / Follow-ups

- [ ] Dashboard "Main Agent" page with home state icons and rule status (v2)
- [ ] LLM auto-editing of rules from user prompts
- [ ] Rule dependency visualization
- [ ] Add MQTT publishing to Boiler Agent (so Rule Engine can see boiler state)
- [ ] Add MQTT publishing to Media Agent
- [ ] Computed state topics for dashboard (people_home, activity_level)
- [ ] Rule testing framework (dry-run mode without actual commands)
- [ ] Boiler coordination rules (electric heater ↔ valve)
