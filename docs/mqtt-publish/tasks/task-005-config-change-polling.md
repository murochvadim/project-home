# Task 5: Add Config Change Polling Thread

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 2

## Description
Add a thread that polls the devices table every 30s for enable/disable changes and new devices. Publishes availability offline for disabled devices and republishes inventory for new devices.

## Original Plan Context
Add `_config_poll_loop()` to `DEVICE/agent/device_agent.py`. Every 30s checks `updated_at` for enable/disable changes and `created_at` for new devices. New devices trigger inventory republish (actual state tracking requires agent restart). Disabling a device publishes availability offline. Acceptance: new device appears in `_bridge/devices` within 30s; disabled device gets offline availability.

## Steps
1. Add `_config_poll_loop()` method to `DeviceAgent`:
   - Track `_last_config_check` timestamp (initialized to agent start time)
   - Loop: `self._stop.wait(30)`
   - Under `_db_lock`, query:
     ```sql
     SELECT id, enabled FROM devices WHERE updated_at > %s
     ```
   - For disabled devices: publish `{"online": false}` to availability
   - For re-enabled devices: trigger inventory republish
   - Also query:
     ```sql
     SELECT id FROM devices WHERE created_at > %s AND enabled = true
     ```
   - If new devices found: republish full inventory to `_bridge/devices`
   - Update `_last_config_check` to now
2. In `run()`: start as daemon thread
   ```python
   threading.Thread(target=self._config_poll_loop, daemon=True, name='config-poll').start()
   ```

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
