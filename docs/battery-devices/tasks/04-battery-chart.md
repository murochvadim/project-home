# Task 4: Battery Card Click → Inline 24h Chart

**Feature:** battery-devices
**Tech Design:** [../tech-design.md](../tech-design.md)

## What to do

### `toggleBatteryChart(deviceId, batteryKey, color)`

1. If accordion already open for this device → collapse and return
2. Collapse any other open accordion
3. Create a `<div class="battery-chart-panel">` after the clicked card
4. Fetch `GET /api/devices/${deviceId}/events?minutes=1440` (existing endpoint, 24h)
5. Filter response for events containing the battery DPS key
6. If no data → show "No data in last 24h" text
7. If data → render Chart.js line chart:
   - Height: 120px
   - X axis: time (last 24h)
   - Y axis: battery % (0-100)
   - Line color: same as card's battery color
   - No legend
   - Point radius: 2
   - Tension: 0.3

### Card onclick
Each battery card gets `onclick="toggleBatteryChart('${deviceId}', '${batteryKey}', '${color}')"`.

### Chart cleanup
Track active chart instance in `_activeBatteryChart`. Destroy before creating new one to prevent Chart.js memory leak.

## Files
- `BOILER/dashboard/public/js/devices.js`

## Acceptance
- Click a battery card → 24h chart expands below it
- Click same card again → collapses
- Click a different card → old chart closes, new one opens
- Chart shows battery trend line in matching color
- "No data in last 24h" for devices with no events
- Chart.js already loaded (Device History tab uses it)
