# Task 3: Rule Engine Core

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 5 (RuleEngine) + Section 6, Component 3

## Description
Create the main Rule Engine service. Loads rules from `RULES/rules/` directory, subscribes to MQTT, evaluates matching rules on each event, dispatches commands, handles loop detection and enable/disable. Writes heartbeat to DB for orchestrator monitoring.

## Original Plan Context
New file `RULES/rule_engine.py`. MQTT subscribe, rule loading, trigger indexing, event routing, command dispatch, loop detection, enable/disable, heartbeat. Acceptance: starts, connects MQTT, loads rules, evaluates on events, dispatches commands.

## Steps
1. Create `RULES/rule_engine.py`
2. Implement `RuleEngine` class:
   - `__init__()`:
     - Create MQTT client (from `mqtt_client.py`, task 4)
     - Create `StateManager` instance
     - Init: `self.rules = []`, `self.trigger_index = {}`, `self._disabled_rules = set()`, `self._command_log = {}` (for loop detection)
     - `self._stop = threading.Event()`
     - Signal handlers: SIGTERM, SIGINT → set `_stop`
   - `load_rules()`:
     - Scan `RULES/rules/*.py`, skip files starting with `_`
     - For each file: `importlib.import_module()`, validate `RULE` dict has keys: `name`, `description`, `triggers`, `controls`, `category`
     - Validate `evaluate` function exists
     - Load disabled rules from `state.shared.get("_disabled_rules", [])`
     - Log: "Loaded N rules (M disabled)"
   - `_index_rules()`:
     - For each rule, for each device_id in `RULE["triggers"]`:
       - `self.trigger_index.setdefault(device_id, []).append(rule_module)`
     - Support `"*"` wildcard trigger (fires on any event)
   - `on_mqtt_event(client, userdata, msg)`:
     - Parse topic → determine device_id, dps, source (same routing as Device Agent ingest)
     - Handle special topics:
       - `mur/home/device/+/state` → update device state in StateManager
       - `mur/home/device/+/availability` → update device online status
       - `mur/home/device/_bridge/devices` → update inventory in StateManager
       - `mur/home/rule-engine/disable/+` → disable rule
       - `mur/home/rule-engine/enable/+` → enable rule
     - For event topics (`mur/home/device/+/event`, `hasp/+/state/+`, `zigbee2mqtt/+`, `awtrix/+/stats`):
       - Update state
       - Look up `trigger_index[device_id]` + `trigger_index.get("*", [])`
       - For each matching rule (skip disabled): `_evaluate_rule(rule, event)`
       - For each returned command: `_dispatch_command(cmd, rule_name)`
   - `_evaluate_rule(rule, event) -> list[dict]`:
     - Call `rule.evaluate(event, self.state)` in try/except
     - If exception: log error with rule name + traceback, return []
     - If result not a list: log warning, return []
     - Return list of command dicts
   - `_dispatch_command(cmd, rule_name)`:
     - Extract `device_id`, `action` from cmd
     - Check `_check_loop(device_id, action, rule_name)` — if True, skip + log
     - Determine device type from `state.devices[device_id]["protocol"]`:
       - `hasp` → publish to `hasp/{name}/command/{path}` (name from state)
       - `zigbee` → publish to `zigbee2mqtt/{name}/set`
       - `awtrix` → publish to `awtrix/{name}/custom`
       - All others → publish to `mur/home/device/{device_id}/command` with QoS 1
     - Log: "Rule '{rule_name}' → {action} {device_id}"
   - `_check_loop(device_id, action, rule_name) -> bool`:
     - Maintain `self._command_log[device_id]` as list of `(timestamp, action)`
     - Purge entries older than 10s
     - If 4+ entries with same action → auto-disable rule, return True
   - `_disable_rule(rule_name)`:
     - Add to `self._disabled_rules`
     - Remove from `trigger_index` values
     - Persist: `state.shared["_disabled_rules"] = list(self._disabled_rules)`
     - Log: "Rule '{rule_name}' DISABLED"
   - `_enable_rule(rule_name)`:
     - Remove from `self._disabled_rules`
     - Re-index the rule
     - Persist
     - Log: "Rule '{rule_name}' ENABLED"
   - `_heartbeat_loop()`:
     - Every 300s: write to `rule_engine_log` (decision = stats, error = NO ERROR)
     - Every 60s: `state.save_shared_state()`
   - `_midnight_refresh()`:
     - Same pattern as Device Agent: sleep until midnight, call `state.load_from_db()`
   - `run()`:
     - `state.load_from_db()`, `state.load_shared_state()`
     - `load_rules()`, `_index_rules()`
     - MQTT connect + subscribe to all topics
     - Start heartbeat thread + midnight refresh thread
     - Main loop: `_stop.wait(10)` until stopped
     - On shutdown: `state.save_shared_state()`, MQTT disconnect, DB close
3. Add `main()` function with signal handlers (same pattern as Device Agent)
4. Add `if __name__ == '__main__': main()`

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
