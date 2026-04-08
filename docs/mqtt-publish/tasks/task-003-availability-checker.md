# Task 3: Add Availability Checker Thread

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 2

## Description
Add a periodic thread to DeviceAgent that checks `last_seen` for all devices every 180s and publishes online/offline availability to MQTT.

## Original Plan Context
Add `_availability_loop()` to `DEVICE/agent/device_agent.py`. Queries `last_seen` every 180s, publishes online/offline per device. Acceptance: devices not seen for 180s get `{"online": false}` on availability topic.

## Steps
1. Add `_availability_loop()` method to `DeviceAgent`:
   - Loop: `while not self._stop.is_set()` with `self._stop.wait(180)`
   - Under `_db_lock`: query `SELECT id, last_seen FROM devices WHERE enabled = true`
   - For each device: if `last_seen` is NULL or older than 180s → publish `{"online": false}`; otherwise → `{"online": true}`
   - Use `self._mqtt.publish_availability(device_id, online, last_seen_iso)`
2. In `run()`: start as daemon thread after adapters are started
   ```python
   threading.Thread(target=self._availability_loop, daemon=True, name='avail-check').start()
   ```
3. Thread exits cleanly when `self._stop` is set (shutdown)

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
