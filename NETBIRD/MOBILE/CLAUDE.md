# Mobile Cockpit (PWA + mobile-api on LXC)

**Status as of 2026-05-20:** concept agreed, NOT YET BUILT. NetBird transport layer is partially set up (see `../CLAUDE.md`). This doc is the design + 4-phase rollout for the smartphone app itself.

## Goal

A custom smartphone "app" tailored exactly to user's wishes:

- ~5-10 **buttons** to trigger actions on the home project (gates, door, vacuum, music, AWAY mode, etc.)
- ~4-6 **live data tiles** glanceable at a tap (boiler, panel, mode, people, active rooms, time)
- **Reliable push notifications** when interesting events happen (laundry done, door left open, FR unknown face, system alerts)
- **Works from anywhere** via NetBird VPN (encrypted tunnel, no public exposure)
- **Laptop NOT in the runtime path** — phone talks directly to an LXC. Laptop is dev/config console only.

## Architecture — laptop-independent at runtime

```
┌──────────────────────────────────────────────────────────────┐
│  PHONE — PWA (cockpit.html, installed via "Add to Home Screen")│
│  Bookmark looks/acts like a native app                        │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     │ NetBird-encrypted HTTP (works anywhere)
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  LXC 105 — mobile-api service (NEW, ~200 lines Python/Flask)  │
│                                                              │
│  Serves PWA static files:                                    │
│   GET /                  → cockpit.html                      │
│   GET /manifest.json     → PWA manifest                      │
│   GET /service-worker.js → offline-cache logic               │
│   GET /css/cockpit.css                                       │
│   GET /js/cockpit.js                                         │
│   GET /img/icon-{192,512}.png                                │
│                                                              │
│  Serves mobile data + actions:                               │
│   GET  /api/mobile/state    → live tile JSON (every 5s poll) │
│   POST /api/mobile/action   → trigger button                 │
│   GET  /api/mobile/config   → layout config (buttons + tiles)│
│                                                              │
│  Reads:                                                      │
│   ▸ DB row dashboard_settings.connection.* (cockpit config)  │
│   ▸ devices table (live device state, last_state)            │
│   ▸ rule_engine state.shared (derived state: time_mode,      │
│     home_mode, people_home, active_rooms, …)                 │
│                                                              │
│  Publishes / calls:                                          │
│   ▸ MQTT (direct to LXC 107) — for device commands           │
│   ▸ HTTP to other LXCs (e.g. /api/vacuum on LXC 100)         │
│   ▸ Optional: subprocess for SSH if needed                   │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     │ MQTT / HTTP / DB queries
                     ▼
        (existing LXC 102 / 103 / 105 / 107 infrastructure)


┌──────────────────────────────────────────────────────────────┐
│  LAPTOP — editor only (not in data path)                     │
│                                                              │
│  Dashboard "Connection" tab (NEW):                           │
│   ▸ Drag-and-drop button list (label, action, color)         │
│   ▸ Tile config (data source, refresh rate, format)          │
│   ▸ Telegram notification rules                              │
│   ▸ "Push update" button → scp's static files to LXC 105     │
│                                                              │
│  Saves to: dashboard_settings.connection.*                   │
│   (mobile-api on LXC 105 reads same DB row on every config   │
│    GET — phone sees changes within seconds)                  │
│                                                              │
│  Can be off all day. Phone keeps working.                    │
└──────────────────────────────────────────────────────────────┘
```

## Lifecycle scenarios

### Button press (e.g. "Open Gates", laptop off, user at the office)

```
Phone PWA
  → POST http://<LXC-105-IP>:8089/api/mobile/action {"action_id": "open_gates"}
  (encrypted NetBird tunnel)
  →
LXC 105 mobile-api
  → looks up action_id in dashboard_settings.connection.cockpit_buttons
  → finds: protocol=esp, topic=mur/home/esp/gates_01/command, payload=gates_toggle
  → publishes MQTT to LXC 107
  →
LXC 107 mosquitto
  → fans out to gates_01 ESP board
  →
Hardware: gates open
```

Laptop never touched.

### Tile refresh (every 5 sec poll)

```
Phone PWA
  → GET http://<LXC-105-IP>:8089/api/mobile/state
  →
LXC 105 mobile-api
  → queries DB: SELECT boiler_temp, panel_temp FROM raw_data ORDER BY ts DESC LIMIT 1
  → queries DB: SELECT key,value FROM rule_engine_state WHERE key IN ('home_mode','people_home',…)
  → builds JSON response
  → returns to phone
```

Laptop never touched.

### Layout edit (user adds a new button)

```
Laptop dashboard → Connection tab
  → user clicks "+ Add button" → defines label/action/color
  → POST /api/connection/save → writes dashboard_settings.connection.cockpit_buttons
  →
DB row updated
  →
Next time phone calls /api/mobile/config → sees new button → renders it
```

Laptop only on briefly during this edit. After save, laptop can shut down.

## Lifecycle table — when does the laptop matter?

| Action | Laptop needed? |
|---|---|
| Tap a button on phone | ✗ No |
| Glance at tile data on phone | ✗ No |
| Receive Telegram notification | ✗ No |
| Add/remove/reorder a button | ✓ Briefly (config edit) |
| Update PWA visual design | ✓ Briefly (push static files) |
| Add new notification rule | ✓ Briefly (config edit) |

Phone works 24/7 against LXC 105. Laptop is editor-only.

## Repository layout (this folder)

```
NETBIRD/MOBILE/
├── CLAUDE.md              (this file)
├── mobile_api/
│   ├── app.py             ← Flask service (~200 lines)
│   ├── config_loader.py   ← reads dashboard_settings.connection.*
│   ├── state_collector.py ← builds tile JSON from DB + state.shared
│   ├── action_dispatcher.py ← publishes MQTT / calls HTTP per action
│   └── requirements.txt   ← Flask, psycopg2, paho-mqtt
├── static/
│   ├── cockpit.html
│   ├── manifest.json
│   ├── service-worker.js
│   ├── css/cockpit.css
│   ├── js/cockpit.js
│   └── img/icon-{192,512}.png
├── mobile-api.service     ← systemd unit (LXC 105)
└── deploy.sh              ← scp + systemctl restart helper
```

## DB schema additions

No new tables. Reuses `dashboard_settings` (existing) with three new keys:

```
connection.cockpit_buttons   JSONB
connection.cockpit_tiles     JSONB
connection.telegram_rules    JSONB
connection.mobile_api_auth   TEXT  (optional bearer token if we add token-auth)
```

### `cockpit_buttons` shape

```json
[
  {
    "id": "open_gates",
    "label": "Open Gates",
    "icon": "🚪",
    "color": "#27ae60",
    "action": {
      "type": "mqtt",
      "topic": "mur/home/esp/gates_01/command",
      "payload": "gates_toggle"
    },
    "order": 1
  },
  {
    "id": "unlock_door",
    "label": "Unlock Door",
    "icon": "🔓",
    "color": "#e67e22",
    "action": {
      "type": "http",
      "method": "POST",
      "url": "http://192.168.1.187:3000/api/devices/face_01/command",
      "body": {"action": "unlock_door"}
    },
    "order": 2
  },
  …
]
```

### `cockpit_tiles` shape

```json
[
  {
    "id": "boiler_temp",
    "label": "Boiler",
    "source": {"type": "db", "query": "SELECT boiler_temp FROM raw_data ORDER BY ts DESC LIMIT 1"},
    "format": "{val:.1f}°C",
    "color_threshold": [{"max": 35, "color": "red"}, {"max": 45, "color": "amber"}, {"color": "green"}],
    "order": 1
  },
  {
    "id": "people_home",
    "label": "People",
    "source": {"type": "shared_state", "key": "people_home"},
    "format": "{val}",
    "order": 2
  },
  …
]
```

## Open decisions

| # | Question | Suggested default | Notes |
|---|---|---|---|
| 1 | Which LXC hosts mobile-api? | LXC 105 (rule engine — already has DB + MQTT access) | Alt: LXC 104 (less busy) |
| 2 | Which port? | 8089 | Must avoid existing ports |
| 3 | Auth model | Trust NetBird (anyone with NetBird account access can reach LXC 105) | Phase 1: trust-net. Phase 2: add bearer token if multi-user |
| 4 | Notifications channel | Telegram bot (Phase 4) | Web Push possible but iOS-fragile |
| 5 | Buttons in v1 | TBD by user | See draft list below |
| 6 | Tiles in v1 | TBD by user | See draft list below |

## Draft button + tile lists for v1 (seed for the Connection tab)

Buttons (user can edit/reorder):
1. Open Gates
2. Unlock Door (FR-board action)
3. Vacuum Roomba start
4. Vacuum Roomba dock
5. Music ▶ Play (current playlist)
6. Music ⏹ Stop
7. AWAY mode (toggle)
8. HOME mode (toggle)

Tiles:
1. Boiler temp (°C)
2. Panel temp (°C) — with valve state badge
3. Home mode (HOME / AWAY / ABROAD)
4. People home (count)
5. Active rooms (csv)
6. Time mode (morning / day / evening / night / late_night)

## Phase rollout

| Phase | Effort | Deliverable |
|---|---|---|
| **0 — NetBird LXC peer** | 30 min | NetBird Linux client on LXC 105 (or 104) + route advertisement for `192.168.1.0/24`. Phone reaches all LXCs from anywhere. |
| **1 — mobile-api scaffold** | 2-3 h | Flask service on LXC 105, systemd unit, basic `/state` + `/action` + `/config` endpoints. Hardcoded buttons/tiles for first smoke test. |
| **2 — cockpit.html PWA** | 2-3 h | Mobile-friendly UI with button + tile rendering. manifest.json + service-worker.js. "Add to home screen" tested. |
| **3 — Connection tab on laptop dashboard** | 1-2 h | UI to edit buttons + tiles. Writes to `dashboard_settings.connection.*`. mobile-api reads same row → phone sees changes. |
| **4 — Telegram bot daemon** | 2-3 h | Daemon on LXC 105 alongside mobile-api. Subscribes to MQTT + DB events. Sends notifications to user's Telegram. Notification rules in `dashboard_settings.connection.telegram_rules`. |

Total: ~7-10 hours, shippable in phases. After Phase 2 you have a working button-grid app; Phase 3 makes it user-configurable; Phase 4 adds notifications.

## Auth + security model

**Phase 1 — trust NetBird** (simplest):
- mobile-api binds to `0.0.0.0:8089` but LXC 105 firewall only allows the NetBird interface
- Anyone who has joined your NetBird account can reach the API — that's the auth boundary
- Same model as your existing dashboard (no in-app auth, relies on network-level trust)

**Phase 2 — optional bearer token** (defense-in-depth):
- mobile-api requires `Authorization: Bearer <token>` header
- Token stored in `dashboard_settings.connection.mobile_api_auth`
- PWA holds the token in localStorage
- Adds protection if a NetBird-authenticated guest device joins (e.g., partner's phone you don't fully trust)

Start with Phase 1, escalate if family/guest scenarios emerge.

## Do I still need an MQTT client app on the phone?

Short: **No for daily use, yes as a developer / debug tool.**

| Use case | MQTT client app | Cockpit PWA |
|---|---|---|
| Daily "open gates / see boiler" | overkill | ✓ designed for this |
| Test a new MQTT topic (debugging) | ✓ best tool | ✗ would need to edit Connection tab first |
| Subscribe to wildcards (`mur/home/#`) to watch live traffic | ✓ best tool | ✗ not built for this |
| Emergency manual control if cockpit / mobile-api breaks | ✓ direct to broker, simpler stack | ✗ more moving parts |
| Reading raw MQTT JSON messages | ✓ | ✗ |

Recommendation:
- **Keep the MQTT client installed** on the phone (free, lightweight)
- **Don't use it daily** — cockpit is the daily driver
- **Pull it out for debugging** — quick topic test, watching broker live, ad-hoc command that the cockpit doesn't have a button for

Both tools benefit from the same Phase 0 work (NetBird Linux client on LXC + advertise route to `192.168.1.0/24`) — once that's done, both the cockpit AND the MQTT client work from outside the home network.

## Phone sensor data — what app handles what

Owntracks (decided 2026-05-21) is the always-on location source — runs in background, publishes GPS to MQTT. But Owntracks is **purpose-built for location only**. For other phone sensors (battery, charging, WiFi BSSID, Bluetooth connections, screen state, etc.) the right tool is **HA Companion app** — it publishes through the existing HA on LXC 101, which the device_agent already subscribes to.

### Two-app combo

| Tool | Role | Publishes via |
|---|---|---|
| **Owntracks** | GPS / location / geofence enter-leave / velocity / battery | MQTT direct to LXC 107 broker on `owntracks/<user>/<device>` topic |
| **HA Companion** | All other phone sensors (charging, WiFi BSSID, Bluetooth, screen, audio mode, alarm time, NFC tags, motion/activity, step count, focus mode, …) | HA WebSocket → existing device_agent → `devices` table |
| **Cockpit PWA** (planned) | Primary daily UI — buttons + tiles + foreground "live tracking" mode | Direct HTTP to mobile-api on LXC 105 |
| **Generic MQTT client** (already installed) | Debug / emergency control / topic exploration | Direct MQTT |

All four are complementary — none replaces another. Owntracks is best at one thing (location, efficiently); HA Companion is best at everything else (because HA's sensor infrastructure already exists in the stack).

### Phone sensor data unlocks (future automations)

When HA Companion is set up, these become trivial sentence-driven rules:

| Sensor → trigger | Rule example |
|---|---|
| `wifi_bssid = home` | "If phone connects to home WiFi, set home_mode is home" |
| `bluetooth_connection = <car>` | "If phone Bluetooth connects to car, log driving session start" |
| `is_charging = false AND battery_pct < 20` | "If phone battery low and not charging, Alexa: charge me" |
| `audio_mode = silent` AND home_mode = home | "If phone on silent at home, route notifications to Telegram only" |
| `last_scanned_tag = home_nfc` | "If NFC tag tapped, trigger HOME mode" |
| `next_alarm_time` | "30 min before alarm, start pre-warming bedroom heater" |
| `pedometer_steps_today` | "Daily steps glance on Awtrix in the morning" |

GPS through Owntracks unlocks:
- "Distance from home < 200m → auto-home_mode = home"
- "Distance from home > 500m for 10 min → auto-home_mode = away"
- "Phone enters office region → push: 'Vadim arrived at work'"
- Trip history on dashboard map

### Setup priority

1. **Phase 5a — Owntracks** (when LXC NetBird gateway + MQTT user created): GPS pipeline live
2. **Phase 5b — HA Companion** (separate, can be done before or after Owntracks): all phone sensors flowing
3. Both publish to existing infrastructure — no new schema beyond `phone_locations` for GPS history

## Caveats to remember

- **PWA cache**: Service worker aggressively caches static files for offline. When pushing a new PWA version, bump a version string in `service-worker.js` to force a refresh on phone next launch.
- **Cookies / sessions**: Not used. Each API request is stateless. No login on the cockpit itself.
- **TLS**: mobile-api on HTTP (no TLS) is fine — NetBird already provides end-to-end encryption. Adding TLS adds cert management burden with zero security gain inside the mesh.
- **iOS PWA quirk**: "Add to home screen" on iOS uses Safari only. Chrome on iOS does NOT support PWAs — users get a normal bookmark, not a fullscreen app.
- **Push notifications on iOS PWA**: Only since iOS 16.4 (March 2023). Requires HTTPS (i.e. would need a TLS cert on mobile-api OR push from a different server). For simplicity, use the Telegram bot path instead.

## Where to pick up

1. Read this file
2. Read `../CLAUDE.md` for NetBird transport status — note the 2026-05-20 partial setup
3. Decide hosted vs self-host (your call). Mobile-api work doesn't care which.
4. Tell me **"start mobile phase 0"** — I'll install NetBird Linux client on LXC 105 + advertise the LAN route
5. Then Phase 1, etc.

Mobile-api is decoupled from which-NetBird-route: the only requirement is that LXC 105 is reachable from the phone via NetBird, which both options satisfy.
