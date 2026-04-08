# Task 1: Create MqttPublisher Helper Class

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 1

## Description
Create a reusable MQTT publisher class that handles connection, LWT, auto-reconnect, and publish methods. This class will be reused by Boiler/Media agents later.

## Original Plan Context
New file `DEVICE/agent/adapters/mqtt_publisher.py`. Implements connect, publish, LWT, reconnect callbacks. Acceptance: class instantiates, connects to broker, publishes test message.

## Steps
1. Create `DEVICE/agent/adapters/mqtt_publisher.py`
2. Implement `MqttPublisher` class with:
   - `__init__(broker, port, username, password, client_id, lwt_topic)` — create paho Client, configure LWT (`{"state":"offline"}` retained QoS 1), set credentials
   - `connect()` — `connect_async()` + `loop_start()`. Non-blocking, paho retries on failure
   - `on_connect` callback — log connected, publish bridge online
   - `on_disconnect` callback — log disconnected
   - `publish(topic, payload, retain, qos)` — `json.dumps(payload)`, fire-and-forget. Log warning on first disconnect drop only
   - `publish_device_state(device_id, full_state, source)` — retained to `mur/home/device/{id}/state`
   - `publish_device_event(device_id, dps, source)` — transient to `mur/home/device/{id}/event`
   - `publish_availability(device_id, online, last_seen)` — retained QoS 1 to `mur/home/device/{id}/availability`
   - `publish_inventory(devices)` — retained to `mur/home/device/_bridge/devices`
   - `publish_bridge_online(device_count, adapter_count)` — retained QoS 1 to `mur/home/device/_bridge/state`
   - `subscribe(topics, on_message)` — subscribe to list of topic patterns, set message callback
   - `disconnect()` — `loop_stop()` + `disconnect()`
   - `is_connected` property
3. All timestamps in ISO8601 with Asia/Jerusalem timezone
4. If `password` is empty, log error and skip connect (agent runs without MQTT)

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
