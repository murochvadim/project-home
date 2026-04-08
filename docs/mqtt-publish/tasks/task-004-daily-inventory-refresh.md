# Task 4: Add Daily Inventory Refresh Thread

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 6, Component 2

## Description
Add a thread that republishes the full device inventory (with rooms) to MQTT at midnight daily. Rooms and device-to-room assignments rarely change, so daily refresh is sufficient.

## Original Plan Context
Add `_daily_refresh()` to `DEVICE/agent/device_agent.py`. Sleeps until midnight, republishes full device list with rooms. Acceptance: at midnight, `_bridge/devices` topic updated with current devices+rooms.

## Steps
1. Add `_daily_refresh()` method to `DeviceAgent`:
   - Calculate seconds until next midnight (Asia/Jerusalem timezone)
   - Loop: `self._stop.wait(seconds_until_midnight)`
   - If not stopped: under `_db_lock`, query devices with rooms:
     ```sql
     SELECT id, name, room, device_type, protocol, vendor FROM devices WHERE enabled = true
     ```
   - Call `self._mqtt.publish_inventory(devices)`
   - Log "Daily inventory refresh published"
   - Recalculate next midnight, repeat
2. In `run()`: start as daemon thread
   ```python
   threading.Thread(target=self._daily_refresh, daemon=True, name='daily-refresh').start()
   ```
3. Use `pytz` / `datetime` for Asia/Jerusalem midnight calculation

## Readability Checklist
- [ ] Extract to named function if logic is >5 lines inline or has a distinct responsibility
- [ ] Add clarifying comment where type filtering or timing is non-obvious
- [ ] If introducing a new enum/model name, verify it matches the API/method name it serves

## Status
- [x] Complete
