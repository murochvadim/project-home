# Task 6: Add Universal MQTT Ingest

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 3

## Description
Device Agent subscribes to MQTT topics from DIY devices, openHASP plates, Awtrix displays, and Zigbee2MQTT. All incoming events flow through `on_state_change()` for DB recording and MQTT republishing. Every event recorded for future LLM analysis.

## Original Plan Context
Device Agent subscribes to `mur/home/device/+/ingest`, `hasp/+/state`, `hasp/+/state/+`, `awtrix/+/stats`, `zigbee2mqtt/+`. Routes by topic prefix, maps to device_id, calls `on_state_change()` with source `mqtt`/`hasp`/`awtrix`/`zigbee`. All events recorded in DB for LLM analysis. Acceptance: HASP button press → device_events row + `mur/home/device/{id}/event` published.

## Steps
1. Add `_setup_mqtt_ingest()` method to `DeviceAgent`:
   - Subscribe to topics via `self._mqtt.subscribe()`:
     - `mur/home/device/+/ingest` — DIY devices
     - `hasp/+/state` — openHASP plate status
     - `hasp/+/state/+` — openHASP object states (buttons, sliders)
     - `awtrix/+/stats` — Awtrix display status
     - `zigbee2mqtt/+` — Zigbee device state (skip `zigbee2mqtt/bridge/*`)
   - Set `_on_mqtt_message` as the callback

2. Add `_on_mqtt_message(client, userdata, msg)` method:
   - Parse topic to determine source and device identifier:
     - `mur/home/device/{id}/ingest` → `device_id = id`, source = `'mqtt'`
     - `hasp/{node}/state` → map `node` to device_id, source = `'hasp'`
     - `hasp/{node}/state/{object}` → map `node` to device_id, include object in DPS key, source = `'hasp'`
     - `awtrix/{uid}/stats` → map `uid` to device_id, source = `'awtrix'`
     - `zigbee2mqtt/{name}` → map `friendly_name` to device_id, source = `'zigbee'`
   - Parse JSON payload
   - Look up device_id in `_mqtt_device_map` (built from devices table where protocol in ('mqtt', 'hasp', 'awtrix', 'zigbee'))
   - If unknown device_id: log warning, skip
   - Call `self.on_state_change(device_id, dps, source)`

3. Add `_build_mqtt_device_map()` method:
   - Query devices with `protocol IN ('mqtt', 'hasp', 'awtrix', 'zigbee')`
   - Build lookup dicts: `node_name → device_id`, `uid → device_id`, `friendly_name → device_id`
   - Called at startup and refreshed by config poll

4. In `run()`: call `_build_mqtt_device_map()` then `_setup_mqtt_ingest()` after MQTT connects

## Key Notes
- HASP/Awtrix/Zigbee devices must exist in `devices` table with appropriate protocol
- These devices will be added via dashboard (same as Tuya devices)
- `on_state_change()` handles DB write + MQTT republish — no special handling needed

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
