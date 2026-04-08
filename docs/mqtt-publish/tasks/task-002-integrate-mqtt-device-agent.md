# Task 2: Integrate MQTT into DeviceAgent

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 2

## Description
Modify `device_agent.py` to create MqttPublisher on startup, publish state/event on every `on_state_change()`, publish inventory after loading devices, and disconnect on shutdown.

## Original Plan Context
Modify `DEVICE/agent/device_agent.py`. Add MQTT config from env vars, create MqttPublisher in `__init__`, publish state/event in `_db_write()`, publish inventory in `run()`, disconnect in shutdown. Acceptance: on_state_change publishes to MQTT after DB write.

## Steps
1. Add imports: `os`, `MqttPublisher` from `adapters.mqtt_publisher`
2. Add module-level MQTT config constants:
   ```python
   MQTT_BROKER = os.environ.get('MQTT_BROKER', '192.168.1.189')
   MQTT_PORT   = int(os.environ.get('MQTT_PORT', '1883'))
   MQTT_USER   = os.environ.get('MQTT_USER', 'device_agent')
   MQTT_PASS   = os.environ.get('MQTT_PASS', '')
   ```
3. In `__init__()`: create `self._mqtt = MqttPublisher(...)`, call `self._mqtt.connect()`
4. Add `_publish_state(device_id, dps, source, is_dup)` method:
   - Always call `self._mqtt.publish_device_state()` with full merged state
   - If not `is_dup`, also call `self._mqtt.publish_device_event()`
   - Skip if `source == 'keepalive'`
5. In `_db_write()`: call `_publish_state()` at end, after DB writes
6. In `run()`: after loading devices and starting adapters, call `self._mqtt.publish_inventory(devices)` and `self._mqtt.publish_bridge_online()`
7. In `shutdown()` / finally block: call `self._mqtt.disconnect()` before `conn.close()`

## Key Constraint
- MQTT publish must happen inside `_db_lock` (after DB write) to preserve event ordering
- QoS 0 publish is non-blocking (~microseconds), safe under lock

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
