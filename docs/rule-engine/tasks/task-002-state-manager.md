# Task 2: StateManager Class

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 5 (StateManager) + Section 6, Component 2

## Description
Create the StateManager class that holds all device/room state in memory. Loads from PostgreSQL at startup, merges MQTT updates in real-time, manages shared persistent state and timers. This is the core data layer for rule evaluation.

## Original Plan Context
New file `RULES/state_manager.py`. In-memory device/room state, shared persistent state, timers. Load from DB, merge MQTT updates, persist shared state. Acceptance: load devices from DB, update via dict, save/restore shared state.

## Steps
1. Create `RULES/state_manager.py`
2. Implement `StateManager` class:
   - `__init__(db_config)`: store config, init empty dicts:
     - `self.devices: dict` — `{device_id: {"dps": {}, "online": bool, "name": str, "room": str, "device_type": str, "protocol": str}}`
     - `self.rooms: dict` — `{room_name: {"devices": [device_id, ...]}}`
     - `self.shared: dict` — persistent shared state (home_mode, people_home, etc.)
     - `self._timers: dict` — `{timer_name: timestamp}`
   - `_connect_db()`: psycopg2 connection with autocommit, reconnect pattern
   - `load_from_db()`:
     - Query `SELECT id, name, room, device_type, protocol, last_state, enabled FROM devices WHERE enabled = true`
     - Query `SELECT name FROM rooms`
     - Populate `self.devices` and `self.rooms` (group devices by room)
     - Log: "Loaded N devices across M rooms"
   - `load_shared_state()`:
     - Query `SELECT key, value FROM rule_engine_state`
     - Populate `self.shared` (non-timer keys) and `self._timers` (keys starting with `_timer:`)
   - `save_shared_state()`:
     - UPSERT all `self.shared` keys + `self._timers` to `rule_engine_state`
     - Use `INSERT ... ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()`
   - `update_device(device_id, dps, source)`:
     - If device_id not in `self.devices`, log debug and skip
     - Merge: `self.devices[device_id]["dps"].update(dps)`
   - `update_availability(device_id, online)`:
     - `self.devices[device_id]["online"] = online`
   - `update_inventory(inventory)`:
     - Refresh devices and rooms from inventory list (from `_bridge/devices` topic)
   - `set_timer(name)`: `self._timers[name] = time.time()`
   - `get_timer(name) -> float`: return `time.time() - self._timers[name]` or `float('inf')` if not set
3. DB connection: single connection, `_ensure_conn()` pattern (same as Device Agent)
4. All timestamps in UTC internally

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
