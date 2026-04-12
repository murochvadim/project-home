# Task 5: Settings Tab JS

**Feature:** battery-devices
**Tech Design:** [../tech-design.md](../tech-design.md)

## What to do

### `loadBatterySettings()`
- `GET /api/dashboard-settings/battery_thresholds`
- Cache in module-level `_battThresholds`
- If not found or error → default `{ good: 60, low: 20 }`
- Called once on first `renderBatteryTab()`, cached after

### `saveBatterySettings()`
- Read values from input fields `#batt-good` and `#batt-low`
- Validate: good > low, both 1-100
- `POST /api/dashboard-settings/battery_thresholds` with `{ value: { good, low } }`
- On success: update `_battThresholds` cache, show "Saved" inline, re-render battery tab
- On error: show error inline

### `renderDashSettingsTab()`
Render into `#tab-dash-settings`:
```html
<div class="card" style="max-width:400px;">
  <h3>Battery Thresholds</h3>
  <div style="display:flex; gap:16px; align-items:center; margin:12px 0;">
    <label>Good ≥ <input type="number" id="batt-good" min="1" max="100" value="60" style="width:60px"> %</label>
    <label>Low < <input type="number" id="batt-low" min="1" max="100" value="20" style="width:60px"> %</label>
  </div>
  <p style="font-size:0.75rem; color:#888;">
    Good (dark green) ≥ good threshold<br>
    Mid (dark yellow) ≥ low threshold<br>
    Low (dark red) < low threshold<br>
    Offline = grey
  </p>
  <button class="btn btn-primary" onclick="saveBatterySettings()">Save</button>
  <span id="batt-save-status" style="margin-left:8px; font-size:0.82rem;"></span>
</div>
```

### Update `showTab()`
Add case `'dash-settings'` → call `renderDashSettingsTab()`.

## Files
- `BOILER/dashboard/public/js/devices.js`

## Acceptance
- Settings tab shows threshold inputs with current DB values
- Change values → Save → values persist in DB
- Reload page → Settings tab shows saved values
- After save, switching to Batt Devices tab shows updated colors
- Validation: good must be > low, both 1-100
