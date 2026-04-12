# Tech Design: Battery Devices Tab

**PRD:** Battery devices dashboard tab with visual icons and configurable thresholds
**Discovery:** [docs/battery-devices/discovery.md](discovery.md)
**Date:** 2026-04-12
**Status:** Draft

## 1. Summary

Add a "Batt Devices" tab to the Device Agent page showing all battery-powered devices as cards with visual battery icons colored by configurable thresholds. Add a "Settings" tab (separated from other tabs) for configuring good/mid/low battery boundaries. Settings persisted in a new `dashboard_settings` DB table.

### Non-Goals
- Scheduled battery check rules (needs scheduled rule type)
- Push notifications for low battery (needs notification service)

## 2. Current Behavior

Battery data exists in `devices.last_state` JSONB for 15 devices (13 Z-Wave + 2 Tuya sirens) but is never displayed as a dedicated view. The `dps_labels` JSONB identifies which DPS key holds battery data per device.

## 3. To-Be Behavior

### User Flow
1. User opens Device Agent page → sees existing tabs + new "Batt Devices" tab
2. Clicks "Batt Devices" → grid of cards, one per battery device, sorted lowest-first
3. Each card shows: battery icon (colored by threshold), percentage, device name, room, last seen time
4. Clicks "Settings" tab (right side of tab bar, after spacing) → configures good/mid/low thresholds
5. Saves → thresholds stored in DB, battery tab re-renders with new colors

### System Flow
1. Page loads → `GET /api/devices` (existing) returns all devices
2. Client-side JS filters devices where `dps_labels` has any value = `"Battery"`
3. For each battery device: find the battery DPS key from `dps_labels`, read value from `last_state`
4. Render cards with CSS battery icon, color from thresholds
5. Settings: `GET /api/dashboard-settings/battery` → returns thresholds (or defaults)
6. Save: `POST /api/dashboard-settings/battery` → stores to `dashboard_settings` table

## 4. Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Battery key detection | `dps_labels` value = "Battery" | Hardcoded key list ("battery", "15", "10") | `dps_labels` is authoritative, handles future devices automatically |
| Settings storage | `dashboard_settings` DB table | localStorage | User requested DB persistence; reusable for future dashboard settings |
| Card layout | Reuse `presence-grid` / `presence-card` pattern | Custom grid | Existing pattern matches dashboard aesthetic |
| Battery icon | Pure CSS rectangle with fill | SVG icon / icon library | No dependencies, simple, color-controllable |
| Sort order | Group by room, rooms sorted by worst battery, devices within room sorted ascending | Flat grid sorted by level | Grouped view surfaces critical rooms first; within each room, lowest device first |
| Tab placement | "Settings" after spacing, right side of tab bar | Inline in Batt tab / adjacent to Set Devices | User requested separate tab with spacing after Device History |
| Offline rendering | Grey icon + last known % | Hide offline devices | Shows all devices, user sees which are stale |

## 5. Interfaces / Models

### DB Table
```sql
CREATE TABLE IF NOT EXISTS dashboard_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Battery thresholds shape (stored as `dashboard_settings` key = `battery_thresholds`)
```json
{
    "good": 60,
    "low": 20
}
```
Logic: `>= good` → green, `>= low && < good` → yellow, `< low` → red, offline → grey

### API Endpoints
```
GET  /api/dashboard-settings/:key  → { value: {...}, updated_at: "..." }
POST /api/dashboard-settings/:key  → body: { value: {...} } → { ok: true }
```

## 6. Implementation Details

### 6.1 DB Migration — `dashboard_settings` table
- **File:** `BOILER/dashboard/server.js` → `ensureSchema()`
- **Changes:** Add `CREATE TABLE IF NOT EXISTS dashboard_settings` + seed default battery thresholds
- **Details:** Table is generic key/value — reusable for future dashboard settings beyond battery

### 6.2 Server API — settings endpoints
- **File:** `BOILER/dashboard/server.js`
- **Changes:** Add 2 endpoints:
  - `GET /api/dashboard-settings/:key` — read one setting by key, return `{ value, updated_at }` or `{ value: null }` if not found
  - `POST /api/dashboard-settings/:key` — upsert setting, body `{ value }`, uses `ON CONFLICT (key) DO UPDATE`
- **Extract:** `getDashboardSetting(key)`, `saveDashboardSetting(key, value)` — inline in route handlers (< 5 lines each, no separate function needed)

### 6.3 HTML — New tabs + battery panel
- **File:** `BOILER/dashboard/public/devices.html`
- **Changes:**
  - Add `<button class="tab-btn" onclick="showTab('battery', this)">Batt Devices</button>` after "All Devices"
  - Add `<button class="tab-btn" onclick="showTab('dash-settings', this)" style="margin-left:auto">Settings</button>` at end of tab-bar (margin-left:auto pushes it right)
  - Add `<div class="tab-panel" id="tab-battery">` with placeholder grid container `<div id="battery-grid" class="presence-grid"></div>`
  - Add `<div class="tab-panel" id="tab-dash-settings">` with threshold inputs (good, low) + Save button
- **CSS additions:**
  ```css
  .battery-card { /* extends presence-card */ }
  .battery-icon { width: 30px; height: 50px; border: 2px solid; border-radius: 4px; position: relative; }
  .battery-icon::before { /* top nub */ }
  .battery-fill { position: absolute; bottom: 2px; left: 2px; right: 2px; transition: height 0.3s; }
  ```

### 6.4 JS — Battery tab rendering
- **File:** `BOILER/dashboard/public/js/devices.js`
- **Functions to add:**
  - `getBatteryKey(device)` — scans `dps_labels` for value "Battery", returns the key name (e.g. "battery", "15", "10") or null
  - `getBatteryValue(device)` — calls `getBatteryKey()`, reads value from `last_state`, returns number or null
  - `batteryColor(value, thresholds)` — returns CSS color based on thresholds: `>= good` → `#1a5c2a` (dark green), `>= low` → `#8b6914` (dark yellow), `< low` → `#8b1a1a` (dark red), null/offline → `#999` (grey)
  - `renderBatteryTab()` — filters `allDevices` for battery devices, groups by room, sorts rooms by worst battery (lowest first), within each room sorts devices ascending, renders grouped card grid with room headers
  - `renderBatteryCard(device, batteryVal, color)` — returns HTML for one battery card
  - `groupByRoom(batteryDevices)` — returns `Map<room, [{device, batteryVal, color}]>` sorted by worst battery per room
  - `toggleBatteryChart(deviceId, batteryKey, color)` — fetches `GET /api/devices/:id/events?minutes=1440`, filters for battery DPS, renders Chart.js line in accordion panel below the clicked card. Toggles open/close.
  - `loadBatterySettings()` — `GET /api/dashboard-settings/battery_thresholds`, caches in `_battThresholds`
  - `saveBatterySettings()` — reads inputs, `POST /api/dashboard-settings/battery_thresholds`, re-renders battery tab
  - `renderDashSettingsTab()` — renders threshold inputs with current values
- **Update `showTab()`:** add cases for `'battery'` → `renderBatteryTab()` and `'dash-settings'` → `renderDashSettingsTab()`
- **Battery card HTML structure:**
  ```html
  <!-- Room group -->
  <div class="battery-room-group">
    <div class="battery-room-header">{room}</div>
    <div class="presence-grid">
      <!-- One card per device in this room -->
      <div class="presence-card battery-card">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="battery-icon" style="border-color:{color}">
            <div class="battery-fill" style="height:{pct}%; background:{color}"></div>
          </div>
          <div>
            <div class="presence-name">{name}</div>
            <div style="font-size:1.4rem; font-weight:700; color:{color}">{pct}%</div>
            <div class="presence-age">{lastSeen}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  ```
  Room header CSS: same style as device page section headers (`font-size:0.7rem; font-weight:600; color:#888; text-transform:uppercase; letter-spacing:0.06em; border-bottom:1px solid #e0dbd4`).
  Room name is in the header — removed from individual cards to avoid redundancy.

### Click → inline 24h battery chart
  Clicking a battery card toggles an accordion panel below the card showing a small Chart.js line chart of battery level over the last 24 hours.
  - Data: `GET /api/devices/:id/events?minutes=1440` (existing endpoint) → filter for battery DPS key
  - Chart: small Chart.js line (height ~120px), no legend, time axis, battery % axis (0-100)
  - Color: same as the card's battery color
  - Toggle: click again to collapse, or click another card to switch
  - If no data in 24h: show "No data in last 24h" text instead of chart

## 7. Config / Segmentation Plan

| Key | Type | Default | Location | Migration |
|-----|------|---------|----------|-----------|
| `battery_thresholds` | `{ good: number, low: number }` | `{ good: 60, low: 20 }` | `dashboard_settings` table | Seeded in `ensureSchema()` |

## 8. BI Event Spec

N/A — dashboard-only feature, no telemetry.

## 9. Error Handling & Edge Cases

| Scenario | Handling | Fallback |
|----------|----------|----------|
| Device has "Battery" in dps_labels but no value in last_state | Show card with "--" and grey icon | Card still visible |
| Device offline (last_seen > stale threshold) | Grey icon, show last known %, "offline" label | Uses existing `isOnline()` |
| Battery key varies (battery / 15 / 10) | `getBatteryKey()` scans dps_labels for value "Battery" | Uniform detection |
| DPS 15 is NOT battery (e.g. Balcony Protector countdown) | `dps_labels` check prevents false match — only if label = "Battery" | Correct filtering |
| Settings not in DB yet | `GET` returns null → use defaults `{ good: 60, low: 20 }` | Graceful fallback |
| DB connection error on settings save | Show error inline, keep old values | Non-destructive |

## 10. Rollout Plan

- No feature flag — dashboard-only, single user
- Deploy: edit files → `pm2 delete + start` → verify
- Rollback: revert files → `pm2 delete + start`

## 11. Test Plan

### Manual Checklist
- [ ] Batt Devices tab shows all 15 battery devices
- [ ] Cards sorted by battery level ascending (lowest first)
- [ ] Colors correct: Dressroom Door (13%) = red, Kitchen Motion (36%) = yellow, Balcony Motion (100%) = green
- [ ] Offline devices (Balcony Door, Bedroom Balcony Door, Refrigerator Sensor) show grey with "--"
- [ ] Settings tab: change thresholds → save → battery tab re-renders with new colors
- [ ] Settings persist after page reload (DB-backed)
- [ ] Existing tabs (All Devices, Set Devices, Rooms, Device History) unaffected
- [ ] Settings tab is on the right side of the tab bar, separated from other tabs

## 12. Ordered Task List

1. **DB migration + API endpoints** → Add `dashboard_settings` table to `ensureSchema()` with default battery thresholds seed. Add `GET /POST /api/dashboard-settings/:key` endpoints. Files: `server.js`. Acceptance: endpoints return/save thresholds correctly.

2. **Battery tab HTML + CSS** → Add "Batt Devices" tab button, `#tab-battery` panel div, battery card CSS (`.battery-card`, `.battery-icon`, `.battery-fill`). Add "Settings" tab button with `margin-left:auto` for right-side placement, `#tab-dash-settings` panel with threshold inputs. Files: `devices.html`. Acceptance: tabs appear in correct positions, panels exist.

3. **Battery tab JS rendering** → Add `getBatteryKey()`, `getBatteryValue()`, `batteryColor()`, `groupByRoom()`, `renderBatteryTab()`, `renderBatteryCard()`. Update `showTab()` for `'battery'` case. Group by room (rooms sorted by worst battery), within room sorted ascending. Files: `devices.js`. Acceptance: 15 battery devices show grouped by room with correct values and colors.

4. **Battery card click → inline 24h chart** → Add `toggleBatteryChart()`. On card click, fetch `GET /api/devices/:id/events?minutes=1440`, filter for battery DPS key, render Chart.js line (120px height) in accordion below card. Click again to collapse. Files: `devices.js`, `devices.html` (Chart.js already loaded). Acceptance: clicking a card shows 24h battery trend, clicking again collapses.

5. **Settings tab JS** → Add `loadBatterySettings()`, `saveBatterySettings()`, `renderDashSettingsTab()`. Update `showTab()` for `'dash-settings'` case. Load from API, render inputs, save on click, re-render battery tab after save. Files: `devices.js`. Acceptance: thresholds save to DB, persist across reload, battery tab updates.

## 13. Open Items / Follow-ups

- [ ] Extended battery history (30 day chart — v1 does 24h only)
- [ ] Low-battery rule via `/create-rule` (reacts to battery DPS in events)
- [ ] Scheduled battery check rule (needs timer-driven rule type)
- [ ] Battery threshold push notification (needs notification service)
- [ ] Add `dashboard_settings` to `retention_policies` (keep_days: null, auto_clean: false)
