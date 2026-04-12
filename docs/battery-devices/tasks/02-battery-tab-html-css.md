# Task 2: Battery Tab HTML + CSS

**Feature:** battery-devices
**Tech Design:** [../tech-design.md](../tech-design.md)

## What to do

1. Add tab buttons to `.tab-bar` in `devices.html`:
   - `<button class="tab-btn" onclick="showTab('battery', this)">Batt Devices</button>` — after "All Devices"
   - `<button class="tab-btn" onclick="showTab('dash-settings', this)" style="margin-left:auto">Settings</button>` — right-aligned at end of tab bar

2. Add tab panels:
   - `<div class="tab-panel" id="tab-battery"><div id="battery-grid"></div></div>`
   - `<div class="tab-panel" id="tab-dash-settings"></div>`

3. Add CSS in `<style>` block:
```css
.battery-room-group { margin-bottom: 18px; }
.battery-room-header {
  font-size: 0.7rem; font-weight: 600; color: #888;
  text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 8px; padding-bottom: 5px;
  border-bottom: 1px solid #e0dbd4;
}
.battery-card { cursor: pointer; }
.battery-card:hover { border-color: var(--brand-blue); }
.battery-icon {
  width: 30px; height: 50px; border: 2px solid;
  border-radius: 4px; position: relative;
}
.battery-icon::before {
  content: ''; position: absolute; top: -6px;
  left: 50%; transform: translateX(-50%);
  width: 12px; height: 4px; border-radius: 2px 2px 0 0;
  background: inherit; border: 2px solid; border-bottom: none;
}
.battery-fill {
  position: absolute; bottom: 2px; left: 2px; right: 2px;
  border-radius: 1px; transition: height 0.3s;
}
.battery-chart-panel {
  padding: 8px 16px; background: #faf8f5;
  border: 1px solid #e0dbd4; border-top: none;
  border-radius: 0 0 8px 8px; margin-top: -1px;
}
```

## Files
- `BOILER/dashboard/public/devices.html`

## Acceptance
- "Batt Devices" tab button appears after "All Devices"
- "Settings" tab button appears on the right side of the tab bar
- Both panels exist (empty until JS renders)
- Battery card CSS looks correct when JS populates
