# Geolocation Agent

Phone movement tracking + geofence detection for any device reporting GPS
through Home Assistant Companion (or future OwnTracks). First device is
Vadim's Fold 5 (`device_tracker.sm_f946b`); schema + UI are N-device-ready
so additional phones land without code changes.

## File locations

| Artifact | Path |
|---|---|
| Dashboard tab | [BOILER/dashboard/public/project-general.html](../BOILER/dashboard/public/project-general.html) → "Geolocation" tab (status chips + collapsible Settings card + Leaflet map + events log) |
| Dashboard JS | Inline in `project-general.html` (`geoOnTabShow`, `geoLoadSettings`, `geoReloadTrail`, etc.). Tab is lazy-init — map + polling start only when the tab is clicked. |
| Server endpoints | [BOILER/dashboard/server.js](../BOILER/dashboard/server.js) → `/api/geolocation/{settings,locations,status,events,run-ingest}` cluster |
| Ingest script (canonical) | [scripts/geolocation_ingest.py](../scripts/geolocation_ingest.py) |
| Ingest deploy target | `/opt/geolocation_ingest.py` on LXC 104 |
| systemd unit + timer | `/etc/systemd/system/geolocation-ingest.{service,timer}` on LXC 104 — `OnUnitActiveSec=30s` |
| Env file (HA token) | `/etc/geolocation-ingest.env` on LXC 104 (chmod 600) |
| Log file | `/var/log/geolocation-ingest.log` on LXC 104 |
| DB tables (LXC 102) | `device_locations` (time-series GPS pings, retention 30 d auto_clean=true) + geofence rows in `device_events` (source=`geolocation_ingest`, dps `{kind:geofence, event:home|away, lat, lon}`) |
| Settings | `dashboard_settings.geolocation` (singleton JSONB row) |

## Settings schema (`dashboard_settings.geolocation`)

```jsonc
{
  "center":                 { "lat": 32.1593, "lon": 34.8932 },  // apartment center
  "home_radius_m":          80,
  "tracked_devices": [{
    "device_id":      "fold_5_vadim",            // logical id, our convention
    "name":           "Vadim Fold 5",            // display label
    "source":         "ha_companion",            // 'ha_companion' | 'owntracks' (v2)
    "ha_entity":      "device_tracker.sm_f946b", // HA's device_tracker entity_id
    "battery_entity": "sensor.sm_f946b_battery_level"  // optional
  }],
  "retention_days":         30,
  "geofence_events":        true,                // emit geofence:home/away to device_events
  "trail_window_default":   "24h",
  "low_accuracy_filter_m":  100,                 // drop pings with gps_accuracy > N m at ingest
  "outside_accuracy_threshold_m": 40,            // hide outdoor pings with gps_accuracy > N m from the trail (server-side filter)
  "stale_alert_hours":      6,                   // (reserved — future "no pings for N h" alert)
  "dedup_radius_m":         25,                  // skip insert if within N m AND M sec of last ping
  "dedup_window_sec":       60
}
```

## Data flow

```
Fold 5 (HA Companion app)
  ├─ pushes location to HA on adaptive cadence (~30 s when moving, 5-30 min when stationary)
  │
  └→ HA (`device_tracker.sm_f946b` with lat/lon/gps_accuracy/altitude/speed attributes)
       │
       │  GET /api/states/device_tracker.sm_f946b
       ▼
     LXC 104 — geolocation_ingest.py (every 30 s via systemd timer)
       ├─ reads settings from dashboard_settings.geolocation
       ├─ for each tracked device: fetch latest state from HA REST API
       ├─ dedup: skip if within dedup_radius_m AND dedup_window_sec of last row
       ├─ INSERT device_locations row
       ├─ haversine_m(ping, center) → home/away
       └─ on transition: INSERT device_events {kind:geofence, event:home|away}
```

## Dashboard tab structure

Three cards on the **Geolocation** tab of `project-general.html`:

1. **Status** — per-device chips (`home` green / `away` amber + distance + age + battery / `stale` grey / `no_data` grey). Auto-refreshes every 10 s while tab is visible.
2. **⚙ Settings** (collapsible `<details>`)
   - Apartment center (lat / lon) + "Use first available ping" auto-populate button
   - Home radius (m)
   - Retention (days)
   - Low-accuracy filter, stale-alert threshold, dedup params
   - Geofence-events toggle
   - Tracked-devices table (inline edit, +/− rows)
   - **💾 Save settings** + **▶ Run ingest now** (manual trigger via `/api/geolocation/run-ingest` → SSH to LXC 104 → `systemctl start geolocation-ingest.service`)
3. **Map · trail** — Leaflet + OpenStreetMap tiles (no API key, free). Apartment marker + red radius circle + per-device trail polyline + latest position pin + sparse dots tooltipping ts + accuracy. Window selector: 1 h / 24 h / 7 d / 30 d.
4. **Recent geofence events** — last 20 transitions from `device_events WHERE source='geolocation_ingest'`.

## Trail outlier filter pipeline

`GET /api/geolocation/locations` runs `_flagOutliers(rows, opts)` in `server.js` before returning, attaching an `is_outlier: true/false` per row. The dashboard renders only `!is_outlier` pings for the map. Three layers in order:

1. **Stuck-source detector** — flags any ping whose lat/lon is bit-identical (to 5 decimal places) with the previous ping FROM THE SAME source. Real GPS chips ALWAYS jitter; identical fixes = cached replay. Catches HA Companion freeze mode where Samsung battery saver stops the location service but the app keeps republishing the last fix. Verified 2026-06-01: HA published the same coord 18 times while OwnTracks showed the phone walking 100–400 m away.

2. **5-point median outlier** — for each ping, computes the median lat/lon of itself + 4 neighbors (2 each side). Flags the center ping when its distance from that median exceeds `max(3 × neighbor_spread, 30 m)`. Catches isolated single-ping outliers (e.g. WiFi-DB poisoning producing one Dead-Sea-style jump). Doesn't help against sustained drift across multiple consecutive pings.

3. **Outdoor low-accuracy cap** — for pings outside the home radius, flags those whose reported `accuracy_m` exceeds `outside_accuracy_threshold_m` (default 40). Real walking GPS is 5–30 m accuracy; drift bursts are 40–100 m. Indoor (inside-radius) pings are exempt because their accuracy noise doesn't visibly clutter the map. Tunable via Settings card.

Filter parameters are all in `dashboard_settings.geolocation`; threshold changes apply on the next 10 s dashboard poll cycle. No restart needed.

Outliers stay in `device_locations` (raw data preserved for diagnostics). Only the API response marks them — the client hides them from render.

## Trail rendering

- ⚪ **Grey dots** — every accepted ping (one per ping). Outside-radius pings get a small numbered badge (`#1`, `#2`, …) for diagnostic feedback ("which ping is wrong?"); inside-radius pings are plain dots.
- 🔵 **Blue polyline** — connects consecutive outside-radius pings AND the inside-bookend pings at each end of the outdoor run, so the line visually enters/exits the home circle on each excursion.
- 🔵 **Blue last-position pin** — at the freshest accepted ping per `group_id`.
- 🔴 **Red apartment center** + radius circle — drawn once.

Both ingest sources contribute to the merged trail when grouped under one `group_id` (e.g. HA Companion + OwnTracks of the same phone collapse to one trail).

## v1 trade-offs

- **30 s REST poll instead of HA WebSocket push** — simpler failure domain, follows the existing LXC 104 watchdog pattern. Misses sub-30-s movement between polls but captures every meaningful transition. Upgrade to WS later if "every micro-movement" matters.
- **Inline JS in project-general.html** instead of separate `js/geolocation.js` — keeps the tab self-contained, only loaded when project-general is opened, no extra HTTP roundtrip. If logic grows, factor out.
- **No mobile-app sensor subscription** beyond battery — could later subscribe to charging state, network type, motion sensors. Skipped for v1 to keep ingest narrow.

## Phase-0 gotcha — HA Companion throttling

Samsung's One UI aggressively kills background apps at low battery (and silently throttles them when the user hasn't interacted in ~24 h). When the Fold 5 reports stale (`last_changed` > a few hours ago):

1. **Charge the phone** — battery < 15% triggers Samsung's "Battery saver" which throttles ALL apps regardless of app-level battery setting.
2. **Settings → Apps → Home Assistant → Battery → "Unrestricted"** (One UI specific).
3. **HA Companion → Settings → Companion app → Manage sensors → Location → confirm "Background tracking" is on** + force-refresh once from the app.
4. Confirm freshness via HA REST API: `last_changed` should be within last minute or two.

The ingest pipeline keeps polling regardless — once the phone resumes pushing to HA, new pings flow into `device_locations` without any action on the project side.

## Adding more devices

1. On the new phone: install HA Companion app, sign in to HA, grant location permission "Allow all the time"
2. HA creates `device_tracker.<phone_model>` automatically
3. On Project General → Geolocation → Settings: click "+ Add device", fill in `device_id` (your choice, e.g. `iphone_maya`), `name`, `ha_entity` (copy from HA's device list), optional `battery_entity`
4. Save settings
5. Click "▶ Run ingest now" to verify the first ping lands

No code change. The schema + ingest are N-device.

## What the geofence events enable downstream

`device_events` rows with `source='geolocation_ingest'` and `dps.kind='geofence'` are first-class rule-engine triggers. To act on someone arriving home:

```python
# RULES/rules/example.py
def evaluate(event, state):
    if event.get('device_id') != 'fold_5_vadim':
        return []
    dps = event.get('dps') or {}
    if dps.get('kind') == 'geofence' and dps.get('event') == 'home':
        return [{'device_id': '<hallway_light>', 'action': 'turn_on', ...}]
    return []
```

Same pattern as any other device-event-driven rule. No special integration code needed.

## Future phases (not yet built)

- **OwnTracks ingest** — alternative to HA Companion; MQTT-based. Schema already supports `source='owntracks'`. Just add a new `owntracks_ingest.py` that subscribes to mosquitto.
- **Time-at-home stats card** — read `device_locations` over a window, compute time within radius. ~20 lines server-side.
- **Heatmap** — bucket pings into 50 m cells, render as Leaflet heatLayer overlay.
- **Smart-arrival prediction** — rolling 30 min window of pings; if approaching home at decreasing distance + non-zero speed, fire `geofence:arriving` event 2-5 min before actual entry.
- **Multi-floor zones** — each named zone is a separate radius around an anchor lat/lon. Currently only "home" exists.

## Companion docs

- Root [CLAUDE.md](../CLAUDE.md) → Dashboard Pages table → Project General tab; Project Modules table → this folder; DB tables list → `device_locations`
- Adjacent agent: [NETBIRD/CLAUDE.md](../NETBIRD/CLAUDE.md) — the phone reaches the home dashboard through NetBird, but geolocation tracking doesn't depend on NetBird (HA Companion publishes directly to HA whether the phone is at home or away).
