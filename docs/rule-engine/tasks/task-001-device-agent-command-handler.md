# Task 1: Device Agent Command Handler

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 1

## Description
Add MQTT command handler to Device Agent. Subscribe to `mur/home/device/+/command`, parse command payload, resolve HA entity using existing entity_map from HA adapter, call HA API, publish response. This is the prerequisite for Rule Engine to control Tuya devices.

## Original Plan Context
Add `mur/home/device/+/command` subscription to Device Agent. Parse command payload, resolve HA entity (reuse entity_map from HA adapter), call HA API, publish response. Files: `DEVICE/agent/device_agent.py`. Acceptance: publish command to MQTT → device toggles, response published.

## Steps
1. Add `mur/home/device/+/command` to the existing MQTT subscription list in `_setup_mqtt_ingest()` (do NOT use a separate `subscribe()` call — that would overwrite `on_message`)
2. Add command routing in `_on_mqtt_message()` — detect `mur/home/device/+/command` topic
3. Add `_handle_command(device_id, payload)` method to `DeviceAgent`:
   - Parse payload: `action` (required), `channel` (optional), `brightness`/`color_temp`/`position` (optional), `rule` (optional, for logging)
   - Access HA adapter's `_entity_map` to resolve `device_id` → HA entity list
   - Entity selection priority (same as dashboard toggle):
     - If `channel` provided: find entity ending with `_{channel}`
     - Prefer entities ending with `_switch`, `_switch_1`, `_light`, `_curtain`
     - Skip `child_lock`, `countdown`, `indicator`
   - Map action to HA service call:
     - `turn_on` → `{domain}.turn_on`
     - `turn_off` → `{domain}.turn_off`
     - `set_brightness` → `light.turn_on` with `{"brightness": N}`
     - `set_color_temp` → `light.turn_on` with `{"color_temp": N}`
     - `set_position` → `cover.set_cover_position` with `{"position": N}`
   - Call HA API: `POST {HA_URL}/api/services/{domain}/{service}` with `{"entity_id": entity_id, ...}`
   - Publish response to `mur/home/device/{device_id}/command/response`:
     - Success: `{"ok": true, "entity_id": "...", "service": "...", "rule": "..."}`
     - Failure: `{"ok": false, "error": "...", "rule": "..."}`
4. HA_URL and HA_TOKEN already available from `adapters/ha_api.py` module-level vars — import them
5. Wrap entire handler in try/except — command failures must never crash Device Agent

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
