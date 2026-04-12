# Task 3: Battery Tab JS Rendering

**Feature:** battery-devices
**Tech Design:** [../tech-design.md](../tech-design.md)

## What to do

Add these functions to `devices.js`:

### `getBatteryKey(device)`
Scan `device.dps_labels` for any key where value = "Battery". Returns the key name (e.g., "battery", "15", "10") or null.

### `getBatteryValue(device)`
Call `getBatteryKey()`, read value from `device.last_state[key]`. Return number or null.

### `batteryColor(value, thresholds)`
- `value >= thresholds.good` → `#1a5c2a` (dark green)
- `value >= thresholds.low` → `#8b6914` (dark yellow)
- `value < thresholds.low` → `#8b1a1a` (dark red)
- `null` or offline → `#999` (grey)

### `groupByRoom(batteryDevices)`
Group array of `{device, batteryVal, color}` by `device.room`.
- Sort rooms by worst (lowest) battery value — room with lowest device first
- Within each room, sort devices ascending by battery value
- Devices with no room → group "Unassigned"
- Returns array of `{room, devices: [{device, batteryVal, color}]}`

### `renderBatteryTab()`
1. Load thresholds via `loadBatterySettings()` (cached)
2. Filter `allDevices` where `getBatteryKey(d)` is not null
3. Map to `{device, batteryVal, color}`
4. Group by room via `groupByRoom()`
5. Render into `#battery-grid`:
   - Per room: `.battery-room-group` with `.battery-room-header` + `.presence-grid`
   - Per device: `.presence-card.battery-card` with battery icon + name + value + last seen
   - Card `onclick` calls `toggleBatteryChart(id, key, color)`

### `renderBatteryCard(device, batteryVal, color)`
Returns HTML string for one card. Battery icon fill height = `batteryVal` %. Last seen via existing `formatTimeAgo()`.

### Update `showTab()`
Add case `'battery'` → call `renderBatteryTab()`.

## Files
- `BOILER/dashboard/public/js/devices.js`

## Acceptance
- Batt Devices tab shows 15 devices grouped by room
- Rooms sorted by worst battery (DressRoom first with 13%)
- Within each room, lowest battery first
- Colors: 13% = red, 36% = yellow, 100% = green
- Offline devices (null last_state) show grey with "--"
- "Unassigned" group for devices with no room
