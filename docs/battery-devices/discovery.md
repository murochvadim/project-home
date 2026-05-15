# Discovery: Battery Devices Tab

**Description:** New dashboard tab showing all battery-powered devices with visual battery icons and configurable thresholds
**Date:** 2026-04-12
**Status:** Draft

## 1. Goal

Add a "Batt Devices" tab to the Device Agent dashboard page (`devices.html`) that displays all battery-powered devices in a card grid. Each card shows a visual battery icon colored by configurable thresholds (green/yellow/red/grey), the percentage value, device name, and room. A companion "Settings" tab allows users to configure the battery threshold boundaries (good/mid/low). This provides at-a-glance battery health visibility, and in the future, low-battery rules can be created via `/create-rule`.

## 2. Current Behavior

Battery data exists in the system but is only surfaced incidentally:
- **Siren devices** (DPS key `15`): battery % is appended to status text as "Idle 100%" in the All Devices table
- **Wireless switch devices** (DPS key `10`): battery % shown as "Ready 30%" in status text
- **Z-Wave devices** (DPS key `battery`): battery value is stored in `last_state` JSONB but never displayed on the dashboard

There is no dedicated battery view, no visual battery icons, and no configurable thresholds.

### Code Locations
| Component | File | Purpose |
|-----------|------|---------|
| Dashboard HTML | `BOILER/dashboard/public/devices.html` | Tab structure, tab-bar buttons, tab-panel divs |
| Dashboard JS | `BOILER/dashboard/public/js/devices.js` | `showTab()`, `decodeStatus()` (lines 46-54 handle siren/wireless_switch battery), `loadAll()`, `applyFilters()` |
| Shared CSS | `BOILER/dashboard/public/css/style.css` | `.stat-chip`, `.device-stats`, `.toggle`, CSS variables |
| Page CSS | `BOILER/dashboard/public/devices.html` `<style>` | `.presence-card`, `.presence-grid`, `.filter-bar`, page-specific overrides |
| Server endpoints | `BOILER/dashboard/server.js` | `GET /api/devices` (line 2625) returns full `devices` rows including `last_state` JSONB |
| HA data bridge | `DEVICE/agent/adapters/ha_api.py` (canonical since 2026-05-15; was `scripts/ha_api_patched.py`) | Maps HA entities to DPS keys; `battery` in entity_id -> dp_key `battery` |
| Add-device skill | `.claude/skills/add-device/SKILL.md` | Documents that battery stays in `dps_config`, not `channel_config` |

## 3. Infrastructure Map
| LXC | Service | Change Needed |
|-----|---------|---------------|
| Windows host | Dashboard (server.js, port 3000) | Add battery threshold settings storage + optional `/api/devices/battery` endpoint |
| 103 | Device Agent + ha_api_patched.py | None -- already writes `battery` key to `last_state` JSONB |
| 102 | PostgreSQL | Possibly add `dashboard_settings` table for threshold persistence (or use localStorage) |
| 101 | Home Assistant | None -- battery entities already exist and are polled |

## 4. DB Schema

### Devices table (existing, no changes)
| Table | Action | Columns/Changes |
|-------|--------|----------------|
| `devices` | Read only | `last_state` JSONB contains `battery` (Z-Wave), `10` (wireless_switch), `15` (siren) keys |
| `devices` | Read only | `dps_labels` JSONB contains `{"battery": "Battery"}` for Z-Wave devices |

### Settings storage (new, optional)
| Table | Action | Columns/Changes |
|-------|--------|----------------|
| `dashboard_settings` | **Create** (optional) | `key TEXT PK, value JSONB, updated_at TIMESTAMPTZ` -- stores battery thresholds and other dashboard-wide settings |

**Alternative:** Store thresholds in `localStorage` (like `staleThresholdMin` already does). Simpler, no DB change, but per-browser only. Given this is a single-user dashboard, localStorage is likely sufficient.

## 5. Agent Interactions

### Data flow for battery data
```
HA (Z-Wave entities) 
  -> ha_api_patched.py on LXC 103 (maps entity_id containing "battery" to dp_key "battery")
  -> device agent on LXC 103 (writes to devices.last_state JSONB)
  -> GET /api/devices on Windows dashboard (returns full rows)
  -> devices.js renders battery tab
```

**Battery key mapping by device type/protocol:**
| Source | DPS Key | Example Devices |
|--------|---------|----------------|
| Z-Wave via HA API | `battery` | Aeotec motion sensors, door sensors, Wallmotes |
| Tuya gateway sub-device | `15` | Sirens (General Audible Alarm, Guy Audible Alarm) |
| Tuya gateway sub-device | `10` | Wireless switches (none currently enabled) |
| Zigbee (Z2M) | N/A | Scene switches have no battery (mains-powered) |

## 6. MQTT Topics

N/A -- Battery data flows via HA API polling, not MQTT. Future low-battery rule alerts may use MQTT but that is out of scope for this feature.

## 7. HA Entities

Battery entities are already mapped by `ha_api_patched.py`. The Z-Wave devices use HA entities like:
- `sensor.<device_name>_battery` (e.g., `sensor.aeotec_motion_bedroom_battery`)

No new HA integration needed.

## 8. Dashboard Impact
| Page | Endpoint | Change |
|------|----------|--------|
| `devices.html` | -- | Add "Batt Devices" tab button in `.tab-bar`; add `#tab-battery` panel div |
| `devices.html` | -- | Add "Settings" tab button (for battery thresholds); add `#tab-batt-settings` panel div |
| `devices.html` `<style>` | -- | Add battery card styles (`.battery-grid`, `.battery-card`, `.battery-icon`) |
| `devices.js` | `GET /api/devices` (existing) | Filter devices with battery keys client-side; no new endpoint strictly needed |
| `devices.js` | -- | Add `renderBatteryTab()`, `renderBatterySettingsTab()`, update `showTab()` |
| `devices.js` | -- | Battery thresholds stored in `localStorage` (like stale threshold) |
| `server.js` | -- | No changes needed if using localStorage for thresholds |

### Tab structure (current -> proposed)
**Current tabs:** All Devices | Set Devices | Rooms | Device History
**Proposed tabs:** All Devices | Batt Devices | Set Devices | Rooms | Device History | Settings

Note: The existing "Set Devices" tab (`#tab-settings`) is for device enable/disable/dashboard/poll configuration. The new "Settings" tab would be for dashboard-wide settings like battery thresholds. Consider whether battery threshold settings should be a section within the Batt Devices tab instead of a separate tab to avoid confusion with "Set Devices".

## 9. Blast Radius
| Component | How Affected | Risk |
|-----------|-------------|------|
| `devices.html` | New tab-panel HTML added | Low -- additive only |
| `devices.js` | New render functions, `showTab()` updated | Low -- existing tab logic is simple switch |
| `devices.html` `<style>` | New CSS classes for battery cards | Low -- isolated styles |
| `server.js` | No changes (if localStorage) or minimal (if DB settings) | None to Low |
| LXC 103 (device agent) | No changes | None |
| LXC 102 (PostgreSQL) | No changes (if localStorage) or one new table | None to Low |

## 10. Edge Cases / Failure Modes

- **Battery key varies between device types:** Z-Wave uses `battery`, Tuya sirens use DPS `15`, Tuya wireless switches use DPS `10`. The rendering logic must check all three keys. The `dps_labels` JSONB is the authoritative source for which keys are "battery" -- if `dps_labels` contains a key with value `"Battery"`, that key holds the battery value.
- **Device is offline (last_seen stale):** Use the existing `isOnline()` function (checks `last_seen` against stale threshold). Offline devices show grey battery icon. Battery % still shows last known value.
- **Battery value is null but device has battery label:** Some Z-Wave devices (Balcony Door, Bedroom Balcony Door, Refrigerator Sensor) have `"battery": "Battery"` in `dps_labels` but `last_state` is `null` or has no `battery` key yet. These should show as "Unknown" or "--" with grey icon.
- **Siren DPS 15 is not always battery:** The Balcony Protector (a switch) has `dps15 = 2` which is a countdown timer, not battery. Must cross-reference `dps_labels` to confirm the key means "Battery".
- **Device loses battery data after restart:** Z-Wave battery reports are infrequent (some devices report only every 24h). Last known value persists in `last_state` JSONB, so this is not an issue.
- **Threshold configuration lost on browser clear:** If using localStorage, clearing browser data resets thresholds to defaults. Acceptable for single-user dashboard.

## 11. Deployment
| Step | Command | Target |
|------|---------|--------|
| 1. Edit files | Edit `devices.html`, `devices.js` | Windows host |
| 2. Restart dashboard | `cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 delete boiler-dashboard && pm2 start ecosystem.config.js` | Windows host |
| 3. Verify | Open `http://localhost:3000/devices.html`, click "Batt Devices" tab | Browser |

No LXC deployment needed. No DB migration needed (if using localStorage).

## 12. Open Questions — Resolved

- [x] **Settings storage** → DB table (`dashboard_settings` — `key TEXT PK, value JSONB, updated_at TIMESTAMPTZ`)
- [x] **Settings UI** → Separate "Settings" tab, placed on the same tab bar row but with spacing after "Device History" (not adjacent to Set Devices)
- [x] **Default thresholds** → Good >= 60%, Mid 20-59%, Low < 20%
- [x] **Scope** → All battery devices (any device where `dps_labels` has a "Battery" value — Z-Wave + Tuya sirens + future)
- [ ] Battery history chart: out of scope for v1
- [ ] `last_seen` on cards: include as small text (how long ago reported)

## 13. Recommendations

- **Use `dps_labels` as the authoritative source** for identifying battery keys. A device has battery if any key in `dps_labels` has value `"Battery"`. This handles Z-Wave (`battery` key), Tuya sirens (`15` key), and any future devices uniformly.
- **Filter client-side** from existing `GET /api/devices` response. The `allDevices` array is already loaded and cached in `devices.js`. No new server endpoint needed.
- **Use localStorage for thresholds** with sensible defaults (good >= 60, mid >= 20, low < 20). Same pattern as the existing `staleThresholdMin`.
- **Reuse the `presence-grid` / `presence-card` CSS pattern** for the battery card layout. The grid and card styles already exist and match the dashboard aesthetic.
- **Battery icon as pure CSS/SVG** -- a simple rectangular battery shape with fill level based on percentage. Color mapped by thresholds. No external icon library needed.
- **Sort battery cards** by level ascending (lowest first) so critical devices are immediately visible.
- **Inline settings** at the top of the Batt Devices tab (collapsible) rather than a separate Settings tab, to avoid naming confusion with "Set Devices".

### Battery devices currently in the system (13 Z-Wave + 2 Tuya siren)

| Device | Type | Room | Battery % | Key |
|--------|------|------|-----------|-----|
| Aeotec Motion Bedroom | presence | Bedroom | 100 | `battery` |
| Balcony Motion | presence | Balcony | 100 | `battery` |
| Hallway Motion | presence | Hallway | 100 | `battery` |
| Hallway 2 Motion | presence | Hallway | 100 | `battery` |
| Sallon Corner Motion | presence | Living Room | 100 | `battery` |
| TV Wall Corner Motion | presence | Living Room | 100 | `battery` |
| Wallmote 2 | remote | Living Room | 95 | `battery` |
| My Bathroom Door | door_sensor | My BathRoom | 47 | `battery` |
| Kitchen Motion | presence | Kitchen | 36 | `battery` |
| Wallmote 1 | remote | Living Room | 30 | `battery` |
| Bathroom Door | door_sensor | Bathroom | 27 | `battery` |
| Main Door | door_sensor | Entrance | 25 | `battery` |
| Dressroom Door | door_sensor | DressRoom | 13 | `battery` |
| General Audible Alarm | siren | (none) | 100 | `15` |
| Guy Audible Alarm | siren | Guy Room | 100 | `15` |

Note: Balcony Door, Bedroom Balcony Door, and Refrigerator Sensor have `"battery"` in `dps_labels` but `last_state` is currently null (devices may not have reported yet). They should appear as "Unknown" once they report.
