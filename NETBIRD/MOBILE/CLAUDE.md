# Mobile Cockpit (PWA + mobile-api on LXC)

**Status as of 2026-05-20:** concept agreed, NOT YET BUILT. NetBird transport layer is partially set up (see `../CLAUDE.md`). This doc is the design + 4-phase rollout for the smartphone app itself.

## Decisions log (2026-05-23)

Settled this session — capture here so future-me doesn't re-litigate:

- **PWA over native Android.** Considered building a full native Android app (Kotlin + foreground service + HiveMQ MQTT client + WebView wrapping the dashboard) to absorb every phone-side role into one APK. Rejected as **over-engineered for actual needs**: user wants ~5 buttons + ~5 info tiles, NOT the full dashboard mirrored on the phone. PWA cockpit (HTML/JS, "Add to Home Screen") + Owntracks (background location, separate pre-built app) cover everything at <1 day of effort vs 2-3 weeks for the native path. Native app stays available as a Phase-5+ option only if the PWA approach hits a hard limit later.
- **No Tasker / MacroDroid.** Phone-side automation framework not needed — the rule engine on LXC 105 holds all logic. The phone is a thin client surface (buttons + tiles + Owntracks).
- **No standalone MQTT debug client app.** Earlier draft of this doc recommended keeping a generic MQTT client app installed for debugging. Dropped — the Cockpit PWA + the dashboard's existing Live MQTT Events card are sufficient for normal use, and ad-hoc debugging can install one on demand.
- **Cockpit page is small + phone-tailored.** Explicitly NOT a mobile-rendered copy of the full Windows dashboard. ~5 buttons + ~5 tiles, glanceable, one-handed. The full dashboard stays on Windows + tablet.

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

### Button press (e.g. v1's "Boiler Valve" toggle, laptop off, user at the office)

```
Phone PWA
  → POST http://<LXC-105-IP>:8089/api/mobile/action {"action_id": "boiler_valve_toggle"}
  (encrypted NetBird tunnel)
  →
LXC 105 mobile-api
  → looks up action_id in dashboard_settings.connection.cockpit_buttons
  → finds: action.type='ha_toggle', entity='switch.boiler_valve_switch_switch_1'
  → reads current state from HA REST GET /api/states/switch.boiler_valve_switch_switch_1
  → fires opposite via HA REST POST /api/services/switch/turn_{on,off}
  →
HA on LXC 101
  → driver dispatches the switch service to the boiler valve
  →
Hardware: boiler valve flips state
```

Laptop never touched. (The boiler agent may re-evaluate on its next run — see "Boiler valve manual toggle" safety note below.)

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

### `cockpit_buttons` shape — v1

```json
[
  {
    "id": "boiler_valve_toggle",
    "label": "Boiler Valve",
    "icon": "🔥",
    "color": "#e67e22",
    "action": {
      "type": "ha_toggle",
      "entity": "switch.boiler_valve_switch_switch_1"
    },
    "state_source": {"type": "ha_state", "entity": "switch.boiler_valve_switch_switch_1"},
    "order": 1
  }
]
```

Notes:
- `action.type='ha_toggle'` is a new dispatch type mobile-api will handle: read current state of the HA entity, then call `switch.turn_on` or `switch.turn_off` accordingly. Single endpoint, no separate ON/OFF buttons needed.
- `state_source` lets the button render its current state (e.g. lit green when valve is ON, grey when OFF) — read from HA's state for that entity on every cockpit poll.
- Future button types: `mqtt` (publish to a topic), `http` (POST to a dashboard endpoint), `ha_service` (named HA service call with arbitrary `data`). All handled in mobile-api dispatch.

### `cockpit_tiles` shape — v1

```json
[
  {
    "id": "total_power",
    "label": "Power",
    "source": {"type": "db_field", "device_id": "shelly_3em_main", "dps": "total_w"},
    "format": "{val} W",
    "color_threshold": [{"max": 1000, "color": "green"}, {"max": 3000, "color": "amber"}, {"color": "red"}],
    "order": 1
  },
  {
    "id": "home_state",
    "label": "Home",
    "source": {"type": "shared_state", "key": "home_mode"},
    "format": "{val|upper}",
    "color_map": {"home": "#27ae60", "away": "#e67e22", "abroad": "#c0392b"},
    "order": 2
  },
  {
    "id": "people_count",
    "label": "People",
    "source": {"type": "db_field", "device_id": "virtual:people_home", "dps": "people_home"},
    "fallback_value": "—",
    "fallback_when": {"shared_state": "people_count_state", "equals": "transit"},
    "format": "{val}",
    "order": 3
  },
  {
    "id": "last_room",
    "label": "Last Motion",
    "source": {"type": "db_field", "device_id": "virtual:home_activity", "dps": "last_motion_room"},
    "format": "{val} · {ago}",
    "order": 4
  },
  {
    "id": "boiler_temp",
    "label": "Boiler",
    "source": {"type": "db", "query": "SELECT boiler_temp FROM raw_data ORDER BY ts DESC LIMIT 1"},
    "format": "{val:.1f}°C",
    "color_threshold": [{"max": 35, "color": "red"}, {"max": 45, "color": "amber"}, {"color": "green"}],
    "order": 5
  },
  {
    "id": "car_distance",
    "label": "Car Distance",
    "source": {"type": "db_field", "device_id": "virtual:phone_vadim", "dps": "distance_from_home_m"},
    "format_dynamic": "if val < 1000 then '{val} m' else '{val/1000:.1f} km'",
    "fallback_value": "Home",
    "fallback_when": {"source_field": "at_home_zone", "equals": true},
    "order": 6
  }
]
```

Notes:
- `db_field` source type reads `last_state->>'<dps>'` from `devices` table where `id=<device_id>`. New helper to add in mobile-api.
- `shared_state` source type reads from `rule_engine_state` table.
- `db` source type runs an arbitrary read-only query (whitelist-validated by mobile-api).
- `format_dynamic` for the car-distance tile lets the same field render as either meters or km depending on magnitude — implemented in cockpit.html JavaScript at render time.
- `fallback_when` + `fallback_value` lets a tile show a chip ("Home" / "—") instead of a numeric value under specific conditions.

## Open decisions

| # | Question | Suggested default | Notes |
|---|---|---|---|
| 1 | Which LXC hosts mobile-api? | LXC 105 (rule engine — already has DB + MQTT access) | Alt: LXC 104 (less busy) |
| 2 | Which port? | 8089 | Must avoid existing ports |
| 3 | Auth model | Trust NetBird (anyone with NetBird account access can reach LXC 105) | Phase 1: trust-net. Phase 2: add bearer token if multi-user |
| 4 | Notifications channel | Telegram bot (Phase 4) | Web Push possible but iOS-fragile |
| 5 | Buttons in v1 | **Locked 2026-05-24** — see v1 list below | — |
| 6 | Tiles in v1 | **Locked 2026-05-24** — see v1 list below | — |

## v1 button + tile lists (locked 2026-05-24)

### Tiles (6) — info surface

| # | Tile | Source | Format |
|---|---|---|---|
| 1 | **Total Power Consumption** | `devices.last_state.total_w` for `shelly_3em_main` (depends on `POWER` module P1 — Shelly 3EM via HA → device_agent → devices table) | `{val} W` or `{val/1000} kW`, color-coded by threshold |
| 2 | **Home State** | `rule_engine_state` shared key `home_mode` (managed by Mode Buttons rule) | Chip: `HOME` (green) / `AWAY` (orange) / `ABROAD` (red) — same palette as the existing Main Agent home-mode chip |
| 3 | **People Count** | `devices.last_state.people_home` for virtual device `virtual:people_home` | Integer, or `—` when `people_count_state='transit'` |
| 4 | **Last Room Seen** | `devices.last_state.last_motion_room` for `virtual:home_activity` (rule: Home Activity; falls back to `last_motion_zone` for apartment-vision V8+) | Room/zone name + relative timestamp (e.g. "Bedroom · 3 min ago") |
| 5 | **Boiler Temp** | `SELECT boiler_temp FROM raw_data ORDER BY ts DESC LIMIT 1` | `{val:.1f}°C`, color-coded by threshold (red < 35°C cold, amber < 45°C, green ≥ 45°C — same palette as existing boiler agent surface) |
| 6 | **Car Distance from Home** | New virtual device `virtual:phone_<user>` populated by a new "Owntracks Distance" rule (see implementation note below). Reads home lat/lon from `dashboard_settings.apartment.location` (already exists, same row that drives sun events for Home Time Periods rule). | `{val} m` if < 1 km, `{val/1000:.1f} km` otherwise, OR `Home` chip if inside home geofence radius |

### Buttons (1) — control surface

| # | Button | Action | Notes |
|---|---|---|---|
| 1 | **Boiler Valve On/Off** | Toggle HA entity `switch.boiler_valve_switch_switch_1` via mobile-api → HA REST. Cockpit shows current valve state + flips on click. | **Safety note below — boiler agent may re-evaluate and override.** |

This is v1. Additional buttons/tiles (gates, door unlock, vacuum, music, etc. — from the earlier draft list) are deferred until v1 is shipped + working. Cockpit's whole architecture supports adding more later via the Connection tab UI; the Connection tab UI doesn't have to ship in v1 (`cockpit_buttons` + `cockpit_tiles` JSONB can be hand-edited in `dashboard_settings` for v1).

### Implementation note 1 — Car distance tile (new piece)

Tile 6 ("Car Distance from Home") is the only locked tile that doesn't already have a data source. Needs a small piece of plumbing:

**New rule: `Owntracks Distance`** (group=`info`, triggers=`["*"]` with fast early-return for non-Owntracks events):

- Subscribes to MQTT topic `owntracks/<user>/<device>` (published by Owntracks Android app once the user installs + configures it per the existing setup-priority "Phase 5a" in this doc).
- On each location update, reads `lat` + `lon` from the payload.
- Reads home `lat` + `lon` from `dashboard_settings.apartment.location` (existing — already used by `Home Time Periods` rule for sun events).
- Reads home zone radius from a new knob sentence `Car Distance: home zone radius is N meters` (default 100 m, sentence-tunable in Main Agent → Base Rule Settings).
- Computes haversine distance in meters.
- Emits virtual event to `virtual:phone_<user>` device with:
  - `distance_from_home_m` (int, meters)
  - `at_home_zone` (bool — true if distance ≤ home_zone_radius_m)
  - `last_location_ts`
  - `lat`, `lon` (for future map view)
- Registers `virtual:phone_<user>` in the existing `devices` table with `device_type='virtual'`, `protocol='virtual'`.

Effort: ~1 hour. Boilerplate-shaped rule, no new infrastructure.

Once Owntracks is installed and this rule lives on LXC 105, the cockpit tile reads `virtual:phone_vadim.last_state.distance_from_home_m` and renders it.

### Implementation note 2 — Boiler valve manual toggle (safety)

The boiler valve has an **autonomous agent** (`boiler-agent.service` on LXC 103, see `BOILER/CLAUDE.md`) that opens/closes the valve based on temperature trends + solar logic every N minutes. Manual toggle via the cockpit button fires an HA service call directly — same as if you'd toggled the switch in HA's UI.

**Practical implication:** if you turn the valve ON manually via cockpit, the boiler agent will re-evaluate on its next run (typically 5-15 min later) and may turn it OFF if its decision logic disagrees (e.g. panel cooler than boiler). And vice-versa.

The manual button is therefore useful for:
- **Emergency turn-off** (regardless of agent state — safety override always wins)
- **Temporary override** during agent's "no_action" / "disabled" / "hold" decision states
- **Forced ON for testing** even though the agent would say no

**Not in v1 scope but worth noting:** future enhancement could couple the manual toggle with a "pause boiler agent for N minutes" command — the cockpit toggle could send BOTH the valve-state change AND a `dashboard_settings.boiler.agent_paused_until=<timestamp>` write, which the agent checks before each run. Defer to v2.

For v1: the button just toggles the HA entity. User is aware the agent owns the long-term state.

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

## Phone sensor data — what app handles what

Owntracks (decided 2026-05-21) is the always-on location source — runs in background, publishes GPS to MQTT. But Owntracks is **purpose-built for location only**. For other phone sensors (battery, charging, WiFi BSSID, Bluetooth connections, screen state, etc.) the right tool is **HA Companion app** — it publishes through the existing HA on LXC 101, which the device_agent already subscribes to.

### Three-app combo

| Tool | Role | Publishes via |
|---|---|---|
| **Cockpit PWA** (planned, this module) | Primary daily UI — ~5 buttons + ~5 info tiles | Direct HTTP to mobile-api on LXC 105 |
| **Owntracks** (pre-built, install + configure) | GPS / location / geofence enter-leave / velocity / battery | MQTT direct to LXC 107 broker on `owntracks/<user>/<device>` topic |
| **HA Companion** (pre-built, install + configure) | All other phone sensors (charging, WiFi BSSID, Bluetooth, screen, audio mode, alarm time, NFC tags, motion/activity, step count, focus mode, …) | HA WebSocket → existing device_agent → `devices` table |

All three are complementary, all pre-built or tiny — zero native Android development. Owntracks is best at one thing (location, efficiently, with proper Android foreground service). HA Companion is best at the long tail of phone sensors. Cockpit PWA is what you actually look at when you pick up the phone.

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

## Push Notifications — ntfy channel (PLANNED, decided 2026-06-25 — NOT BUILT)

The "reliable push notifications" goal above finally has a chosen mechanism: **self-hosted `ntfy`**. This is the generic **notification CHANNEL** — a reusable "send a message to a person's phone over NetBird" transport. Consumers (pill reminders, laundry-done, door-left-open, FR-unknown-face, system alerts) just publish to a topic; they do NOT each reinvent phone delivery. First consumer = **pill reminders** (see `PERSONAL_HEALTH/PILL_REMINDERS_PLAN.md`).

**Why ntfy (supersedes the old "use Telegram" caveat below):** self-hosted, no Google FCM, no SMS, no phone number, no third-party account. Publish = one `curl`. Private via tokens/topic-ACLs.

### Verified feasibility (read-only checks, 2026-06-25)
| Piece | Finding |
|---|---|
| **Host** | **LXC 109** (Privacy) already runs Docker + Caddy (vaultwarden/caddy/privnet) — **~1.9 GB RAM free, ~15 GB disk free**, ntfy ports free. ntfy (~30–50 MB) = clean 4th compose service in `/opt/privacy/docker-compose.yml`. |
| **Phone reachability** | **Fold 5 (Android 16) is a live, connected NetBird peer.** NetBird network `home-lan` advertises **`192.168.1.0/24`** via LXC 108 → the phone reaches LXC 109 (`192.168.1.196`) over NetBird from anywhere. |
| **No-FCM fact** | For a **self-hosted** server the ntfy Android app uses its own **persistent instant-delivery connection — NOT Google FCM**. (FCM only applies to ntfy.sh-hosted topics.) Delivers over NetBird even when away. |
| **People** | `privacy.users` = **Vadim (Fold 5)** + **Maya (S 21)**. Each person → one topic (`vadim_pills` etc.); only the Fold 5 is set up today, S 21 needs the app. |

### Channel design (this folder owns it)
- **Server**: `binwiederhier/ntfy` container on LXC 109 (`serve`), `server.yml`, data volume, a port (`:8080` plain over the private net — recommended — or a Caddy HTTPS route).
- **Auth**: `auth-default-access: deny-all` + a publish token for senders + per-topic read for phones → private topics.
- **Per-person topic registry**: map each `privacy.users` person → an ntfy topic (a field on the user, or derived `<name>_pills` / future `<name>_alerts`). The sender resolves person → topic.
- **Send API (what consumers use)**: `curl -H "Authorization: Bearer <token>" -d "<message>" http://192.168.1.196:8080/<topic>`.
- **Phone (manual, per phone)**: install ntfy app → add server URL → subscribe to the topic → grant battery-optimization exemption (instant delivery holds a foreground connection; resumes on NetBird reconnect after sleep).

### Open decisions (answer when ordering the build)
1. **Exposure**: plain `http :8080` over the private net (simplest) vs Caddy HTTPS (phone must trust the internal CA).
2. **Topic privacy**: token auth (recommended) vs open topics on the private mesh.
3. **Actionable**: ntfy supports native action buttons (view/http/broadcast) → a self-hosted **[Taken]/[Snooze]** is doable later via an http-action → small log endpoint, **no HA automation needed**.

### Build phases (NOT built — for the order)
1. ntfy container on LXC 109 (compose + server.yml + token) → verify a `curl` publish pops on the Fold 5.
2. Per-person topic registry (privacy.users field or derived).
3. Phones: install app + subscribe (your manual step, per phone).
4. Consumers publish to topics (first = pill reminders, in PERSONAL_HEALTH).

## Where to pick up

1. Read this file
2. Read `../CLAUDE.md` for NetBird transport status — note the 2026-05-20 partial setup
3. Decide hosted vs self-host (your call). Mobile-api work doesn't care which.
4. Tell me **"start mobile phase 0"** — I'll install NetBird Linux client on LXC 105 + advertise the LAN route
5. Then Phase 1, etc.

Mobile-api is decoupled from which-NetBird-route: the only requirement is that LXC 105 is reachable from the phone via NetBird, which both options satisfy.
