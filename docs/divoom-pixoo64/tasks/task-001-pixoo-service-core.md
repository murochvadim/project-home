# Task 1: Pixoo Service Core

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 1 + 3

## Description
Create the main Pixoo64 display service. Connects to MQTT for home state, manages screen rotation timer, writes heartbeat to DB.

## Steps
1. Create `scripts/pixoo_service.py`
2. Implement `PixooService` class:
   - `__init__()`: init Pixoo from env var `PIXOO_IP`, create paho MQTT client with LWT on `mur/home/pixoo/state`, init state dict, screen list, DB connection
   - `connect_mqtt()`: connect to broker, subscribe to `mur/home/rule-engine/computed/+`, `loop_start()`
   - `on_mqtt_message()`: parse topic → extract key (last segment), parse JSON value, update `self.state[key]`
   - `rotate_screen()`: advance `current_screen` index, call screen render function, handle Pixoo errors
   - `write_heartbeat()`: INSERT into `pixoo_log` (decision, error, next_ts)
   - `run()`: connect Pixoo + MQTT, main loop with 10s sleep → rotate, 60s heartbeat
   - `shutdown()`: disconnect MQTT, close DB
3. Add `main()` with SIGTERM/SIGINT handlers
4. Env vars: `PIXOO_IP`, `MQTT_BROKER`, `MQTT_USER`, `MQTT_PASS`, `DB_HOST`, `DB_NAME`, `DB_USER`
5. Screen functions are stubs in this task (just clear screen + text placeholder) — implemented in task 2

## Status
- [x] Complete
