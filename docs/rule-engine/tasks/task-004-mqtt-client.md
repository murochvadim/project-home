# Task 4: MQTT Client for Rule Engine

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 4

## Description
Create an adapted copy of MqttPublisher for the Rule Engine. Different topic prefix (`mur/home/rule-engine`), LWT on rule engine state, command publishing with QoS 1. Remove device-specific helpers, keep core connect/subscribe/publish.

## Original Plan Context
New file `RULES/mqtt_client.py`. Adapted copy of MqttPublisher for Rule Engine topic prefix + command publishing. Acceptance: connects, subscribes, publishes commands with QoS 1.

## Steps
1. Create `RULES/mqtt_client.py`
2. Copy core from `DEVICE/agent/adapters/mqtt_publisher.py` and adapt:
   - `TOPIC_PREFIX = 'mur/home/rule-engine'`
   - `client_id = 'rule-engine-105'`
   - LWT topic: `mur/home/rule-engine/state` → `{"state":"offline"}`
   - Keep: `__init__`, `connect`, `disconnect`, `publish`, `subscribe`, `is_connected`, `_on_connect`, `_on_disconnect`, `_now_iso`
   - Remove: `publish_device_state`, `publish_device_event`, `publish_availability`, `publish_inventory`, `publish_bridge_online` (these are Device Agent specific)
   - Add `publish_command(topic, payload)` — publishes with QoS 1 (commands must be delivered)
   - Add `publish_bridge_online(rule_count)` — publishes `{"state":"online","rules":N,"ts":"..."}` to LWT topic (retained, QoS 1)
   - Add `publish_computed_state(key, value)` — publishes to `mur/home/rule-engine/computed/{key}` (retained)
   - `_on_connect`: republish bridge online + resubscribe (same pattern as Device Agent publisher)
3. MQTT credentials from env vars: `MQTT_BROKER`, `MQTT_USER`, `MQTT_PASS`
4. Use `paho.mqtt.client` with `CallbackAPIVersion.VERSION2` (same as Device Agent)

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
