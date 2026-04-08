# Discovery: Divoom Pixoo64 LED Display Control

**Description:** Add Divoom Pixoo64 (64x64 pixel LED display) control to the Media Agent on LXC 100. Display shows home status info from the Rule Engine, notifications, and custom content via direct HTTP API.
**Date:** 2026-04-08
**Status:** Draft

## 1. Goal

Integrate a Divoom Pixoo64 (64x64 pixel, IP 192.168.1.243) as a home status display controlled from LXC 100 (Media Agent). The display should show:
- Home status from Rule Engine: people count, active rooms, home mode (away/idle/active)
- Notifications (e.g., boiler events, alerts, doorbell)
- Custom content (text, images, animations)

Control is via the Pixoo64's local HTTP REST API (POST to `http://192.168.1.243:80/post`) -- no cloud dependency.

## 2. Current Behavior

**No Divoom/Pixoo code exists anywhere in the codebase.** A search for `divoom`, `pixoo` returned zero results.

### Existing Awtrix Protocol Support

The Rule Engine and Device Agent already support an **Awtrix** display protocol (a similar MQTT-based LED display):
- Rule Engine `_dispatch_command()` routes `protocol == 'awtrix'` commands to `awtrix/{device_name}/custom` (MQTT)
- Rule Engine subscribes to `awtrix/+/stats` for Awtrix status updates
- Device Agent queries `devices` table where `protocol IN ('mqtt', 'hasp', 'awtrix', 'zigbee')` for MQTT-based devices

**Key difference:** Awtrix uses MQTT natively. Pixoo64 uses HTTP REST -- it has no MQTT interface. This means the Pixoo64 cannot be controlled through the existing MQTT command dispatch path without a bridge/adapter.

### LXC 100 Current Services

| Service | Port | Role |
|---------|------|------|
| `player.service` (player_service.py) | 8766 | Media browsing, search, playback, faces |
| `ingest.service` (ingest_service.py) | 8767 | Scan, upload, library CRUD |
| `analyzer.service` (analyzer.py) | -- | Face detection + clustering |
| `tv_control.py` (nohup) | 8765 | Samsung/HA TV control |
| `minidlna` | 8200 | DLNA media server |

### Code Locations

| Component | File | Purpose |
|-----------|------|---------|
| Player service (local) | `scripts/player_service.py` | Flask app, port 8766, TV/soundbar proxy + media API |
| Ingest service (local) | `scripts/ingest_service.py` | Flask app, port 8767, scan + upload |
| TV control (no local copy) | LXC 100: `/opt/media-agent/tv_control.py` | Samsung UPnP + HA API proxy, port 8765 |
| Media CLAUDE.md | `MEDIA/CLAUDE.md` | Full service/API/deploy documentation |
| Rule Engine | `RULES/rule_engine.py` | Evaluates rules, dispatches commands via MQTT |
| Rule Engine MQTT client | `RULES/mqtt_client.py` | Publishes computed state to `mur/home/rule-engine/computed/{key}` |
| People Home rule | `RULES/rules/people_home.py` | Computes `people_home`, `occupied_rooms`, `home_mode` in shared state |
| Home Activity rule | `RULES/rules/home_activity.py` | Computes `active_rooms`, `activity_level`, `last_motion_room` |
| State Manager | `RULES/state_manager.py` | In-memory device/room state, persists shared state to `rule_engine_state` table |
| Dashboard main-agent JS | `BOILER/dashboard/public/js/main-agent.js` | Reads rule engine state for dashboard display |

## 3. Infrastructure Map

| LXC | Service | Change Needed |
|-----|---------|---------------|
| 100 | Media Agent services | **NEW** -- Add `pixoo_service.py` (or integrate into existing service). New systemd service or extend player_service |
| 105 | Rule Engine | Minor -- may need a new MQTT publish topic or HTTP push for Pixoo state updates |
| 107 | Mosquitto broker | Optional -- if using MQTT as transport between Rule Engine and Pixoo service |
| 102 | PostgreSQL | Optional -- `pixoo_config` table or use existing `rule_engine_state` |
| Windows | Dashboard | Optional (v2) -- Pixoo control panel on media page |

### LXC 100 Current State

- **OS**: Debian, Python 3.x with venv at `/opt/media-agent/venv`
- **Packages in venv**: InsightFace, psycopg2, flask, numpy, cv2, flask-cors
- **Network**: Can reach 192.168.1.243 (Pixoo64) directly on the LAN
- **Network**: Can reach 192.168.1.189 (MQTT broker) for subscribing to Rule Engine topics
- **Deploy**: via `scp` from local `scripts/` to `/opt/media-agent/` + systemctl restart

### Pixoo64 Device

- **IP**: 192.168.1.243
- **Port**: 80 (HTTP)
- **Endpoint**: `POST http://192.168.1.243:80/post` with JSON body
- **Resolution**: 64x64 pixels
- **Protocol**: HTTP REST (no MQTT, no cloud required)

## 4. DB Schema

### Existing Tables (read-only for Pixoo service)

| Table | Action | Usage |
|-------|--------|-------|
| `rule_engine_state` | Read | Home status data (`people_home`, `occupied_rooms`, `home_mode`, `activity_level`, `active_rooms`) |
| `agents` | Write | Register `pixoo` agent for orchestrator monitoring |
| `retention_policies` | Write | Register any new log tables |

### New Tables

| Table | Action | Columns/Changes |
|-------|--------|----------------|
| `pixoo_log` (optional) | Create | `id BIGSERIAL PK`, `ts TIMESTAMPTZ DEFAULT NOW()`, `decision TEXT`, `error TEXT`, `next_ts TIMESTAMPTZ` -- heartbeat for orchestrator |
| `retention_policies` | Insert | Add row for `pixoo_log` (keep 30 days, auto_clean daily) |

### No Schema for Pixoo Content

Content/layout is defined in code (Python dicts/functions that build Pixoo API payloads). No DB storage needed for display templates.

## 5. Agent Interactions

### Data Flow

```
Rule Engine (LXC 105)
  ├── Computes: people_home, occupied_rooms, home_mode, activity_level
  ├── Publishes to MQTT: mur/home/rule-engine/computed/{key} (retained)
  └── Persists to DB: rule_engine_state table
        │
        ▼
Pixoo Service (LXC 100)
  ├── Option A: Subscribe to MQTT computed state topics (reactive, real-time)
  ├── Option B: Poll rule_engine_state table (simpler, 30-60s interval)
  ├── Option C: Rule Engine HTTP-pushes to Pixoo service API (event-driven)
  │
  └── Sends HTTP POST to Pixoo64 (192.168.1.243:80/post)
        │
        ▼
Pixoo64 Display (192.168.1.243)
  └── Renders 64x64 pixel content
```

### Recommended: Option A (MQTT subscription)

- LXC 100 can already reach the MQTT broker at 192.168.1.189
- Real-time updates when home state changes
- Need a Mosquitto user for the Pixoo service (or reuse an existing one)
- Consistent with existing architecture (all inter-agent communication via MQTT)

### Computed State Topics Available (published by Rule Engine, retained)

| MQTT Topic | Value | Updated |
|------------|-------|---------|
| `mur/home/rule-engine/computed/people_home` | `{"value": 2, "ts": "ISO8601"}` | On every device event (debounced 2s) |
| `mur/home/rule-engine/computed/occupied_rooms` | `{"value": ["Living Room", "Kitchen"], "ts": "..."}` | Same |
| `mur/home/rule-engine/computed/home_mode` | `{"value": "active"/"idle"/"away", "ts": "..."}` | Same |
| `mur/home/rule-engine/computed/activity_level` | `{"value": "idle"/"low"/"active", "ts": "..."}` | Same |
| `mur/home/rule-engine/computed/last_motion_room` | `{"value": "Living Room", "ts": "..."}` | Same |

## 6. MQTT Topics

### Subscriptions (Pixoo service reads)

| Topic | Publisher | Payload | Retained | QoS |
|-------|-----------|---------|----------|-----|
| `mur/home/rule-engine/computed/+` | Rule Engine | `{"value": ..., "ts": "ISO8601"}` | Yes | 0 |
| `mur/home/pixoo/command` | Dashboard/other | `{"action": "notify", "text": "..."}` | No | 1 |
| `mur/home/pixoo/brightness` | Dashboard/other | `{"value": 50}` | No | 0 |

### Publications (Pixoo service writes)

| Topic | Subscriber | Payload | Retained | QoS |
|-------|------------|---------|----------|-----|
| `mur/home/pixoo/state` | Dashboard/Orchestrator | `{"state": "online"/"offline", "brightness": N, "ts": "..."}` | Yes | 1 (LWT) |

## 7. HA Entities

| Entity | Usage | Access Method |
|--------|-------|---------------|
| N/A | Pixoo64 is not in Home Assistant | Direct HTTP API only |

The Pixoo64 is controlled entirely via its local HTTP API. No HA entity exists or is needed.

## 8. Divoom Pixoo64 HTTP API

All commands are `POST http://192.168.1.243:80/post` with JSON body. Key commands:

### Channel Control

```json
{"Command": "Channel/SetIndex", "SelectIndex": 0}
```
Channels: 0=Faces (clock), 1=Cloud, 2=Visualizer, 3=Custom, 4=Blank

### Brightness

```json
{"Command": "Channel/SetBrightness", "Brightness": 50}
```
Range: 0-100

### Send Text

```json
{
  "Command": "Draw/SendHttpText",
  "TextId": 1,
  "x": 0, "y": 0,
  "dir": 0,
  "font": 2,
  "TextWidth": 64,
  "TextString": "Hello",
  "speed": 100,
  "color": "#FFFFFF",
  "align": 1
}
```
- `dir`: 0=left, 1=right
- `font`: 0-7 (different sizes)
- `align`: 1=left, 2=center, 3=right

### Draw Pixel Buffer (full frame)

```json
{
  "Command": "Draw/SendHttpGif",
  "PicNum": 1,
  "PicWidth": 64,
  "PicOffset": 0,
  "PicID": 0,
  "PicSpeed": 100,
  "PicData": "<base64 RGB data>"
}
```
- PicData: base64-encoded RGB888 pixel array (64*64*3 = 12288 bytes raw)
- PicNum: total frames (1 for static)

### Clear Screen

```json
{"Command": "Draw/ResetHttpGifId"}
```

### Get Device Settings

```json
{"Command": "Channel/GetIndex"}
```

### Send Notification (temporary overlay)

```json
{
  "Command": "Device/PlayTFGif",
  "FileType": 2,
  "FileName": "notification text"
}
```

### Animation Control

```json
{"Command": "Draw/SendHttpItemList", "ItemList": [...]}
```
Supports drawing primitives: rectangle, circle, line, text, fill -- all in one command.

## 9. Dashboard Impact

| Page | Endpoint | Change |
|------|----------|--------|
| Media page | N/A | v2: Add Pixoo control card (brightness slider, channel select, text input) |
| Main Agent page | N/A | No change -- Pixoo state could be shown alongside Rule Engine state in future |
| Health page | `GET /api/health/status` | v2: Add `pixoo` to monitored agents (via `system_alerts` table) |

**v1 requires no dashboard changes.** The Pixoo service is headless -- it receives state via MQTT and pushes to the display. Dashboard control can be added later.

## 10. Blast Radius

| Component | How Affected | Risk |
|-----------|-------------|------|
| LXC 100 (Media Agent) | New service added. Shares resources with player/ingest/analyzer | Low -- Pixoo service is lightweight (HTTP POST + MQTT subscribe). LXC 100 has spare capacity |
| Pixoo64 device | Receives HTTP commands | Low -- display is non-critical. Bad commands show wrong content, no safety risk |
| Rule Engine (LXC 105) | No changes needed -- already publishes computed state to MQTT | None |
| Mosquitto (LXC 107) | New user/ACL for Pixoo service (if not reusing existing) | Low -- additive config |
| PostgreSQL (LXC 102) | Optional `pixoo_log` table + `agents` row | Low -- minimal writes |
| Dashboard (Windows) | No changes for v1 | None |
| Existing Media services | No changes to player/ingest/analyzer | None |
| TV control | No changes | None |

## 11. Edge Cases / Failure Modes

- **Pixoo64 offline/unreachable** -- HTTP POST times out. Service should catch timeout, log warning, retry on next cycle. No cascading failure.

- **Rule Engine down** -- MQTT retained messages provide last known state. Pixoo service shows stale data until Rule Engine recovers. Display continues showing last content.

- **MQTT broker down** -- Pixoo service loses state updates. Display freezes on last content. Service auto-reconnects via paho.

- **LXC 100 resource contention** -- Pixoo service is lightweight (~10-20 MB Python). LXC 100 already runs 4 services. Low risk but monitor memory.

- **Rapid state changes** -- Rule Engine publishes computed state on every device event (debounced 2s). Pixoo HTTP API can handle ~1 request/second. If updates come faster, the service should debounce/throttle to avoid overwhelming the display.

- **Display content overflow** -- 64x64 pixels is very limited. Text must be short or scrolling. Room names may need abbreviation. Layout requires careful pixel-level design.

- **Pixoo firmware updates** -- Device may restart during OTA updates. Service should handle connection drops gracefully.

- **Concurrent HTTP access** -- If dashboard also sends commands to Pixoo directly, commands may conflict. All Pixoo control should go through the Pixoo service (single writer).

## 12. Deployment

| Step | Command | Target |
|------|---------|--------|
| 1. Create Pixoo service script | Write `scripts/pixoo_service.py` locally | Local repo |
| 2. Install paho-mqtt in LXC 100 venv | `ssh root@192.168.1.138 "/opt/media-agent/venv/bin/pip install paho-mqtt"` | LXC 100 |
| 3. Create Mosquitto user (if needed) | `ssh root@192.168.1.189 "mosquitto_passwd /etc/mosquitto/passwd pixoo_service"` | LXC 107 |
| 4. Update Mosquitto ACL | Append pixoo_service ACL entries | LXC 107 |
| 5. Restart Mosquitto | `ssh root@192.168.1.189 "systemctl restart mosquitto"` | LXC 107 |
| 6. Deploy script | `scp scripts/pixoo_service.py root@192.168.1.138:/opt/media-agent/pixoo_service.py` | LXC 100 |
| 7. Create systemd service | Install `pixoo.service` unit file | LXC 100 |
| 8. Register in agents table | `INSERT INTO agents (name, ...) VALUES ('pixoo', ...)` | LXC 102 |
| 9. Add retention policy | Insert row for `pixoo_log` (30 days) | LXC 102 |
| 10. Start service | `ssh root@192.168.1.138 "systemctl enable pixoo && systemctl start pixoo"` | LXC 100 |
| 11. Verify | Check display shows home status | Visual |

### Mosquitto ACL Addition

```
# Pixoo Service -- read computed state, read/write own topics
user pixoo_service
topic read mur/home/rule-engine/computed/#
topic read mur/home/pixoo/#
topic write mur/home/pixoo/#
```

### Systemd Service File

```ini
[Unit]
Description=Pixoo64 Display Service
After=network.target

[Service]
Type=simple
ExecStart=/opt/media-agent/venv/bin/python3 /opt/media-agent/pixoo_service.py
EnvironmentFile=/etc/pixoo.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Environment File (`/etc/pixoo.env`)

```
PIXOO_IP=192.168.1.243
MQTT_BROKER=192.168.1.189
MQTT_USER=pixoo_service
MQTT_PASS=<password>
DB_HOST=192.168.1.219
DB_NAME=home_data
DB_USER=postgres
```

## 13. Open Questions — RESOLVED

- [x] **Service architecture**: Standalone `pixoo_service.py` on LXC 100. Separate from media services.
- [x] **Display content**: Rotating screens — clock, home status, weather, boiler status, notifications. 10s rotation.
- [x] **State source**: MQTT subscription (reactive updates from Rule Engine computed state).
- [x] **LXC**: LXC 100 (media/display LXC).
- [x] **Python library**: Use existing `divoom-pixoo` library (already installed).
- [x] **Notification priority**: Deferred — implement basic screens first.
- [x] **Brightness schedule**: Deferred — manual for now.
- [x] **paho-mqtt**: Need to verify on LXC 100.
- [x] **Orchestrator registration**: Yes, register in agents table.
- [x] **MQTT user**: Create dedicated `pixoo_service` user on Mosquitto.
- [x] **Hebrew text**: Test later, English-only for v1.

## 14. Recommendations

- **Standalone service** -- Create `pixoo_service.py` as a new service on LXC 100 with its own systemd unit. Keep it separate from the media services (player/ingest/analyzer) since it has a different responsibility (status display vs. media playback).

- **MQTT for state, HTTP for display** -- Subscribe to Rule Engine computed state via MQTT for real-time updates. Use direct HTTP POST to Pixoo64 for display commands. This follows the existing architecture pattern.

- **Debounce display updates** -- Don't update the display on every MQTT message. Collect state changes and refresh the display at most once per 5 seconds. The Pixoo64 API and display refresh don't benefit from faster updates.

- **Layered display architecture** -- Design the service with swappable "screens": (1) Home Status screen (default), (2) Notification overlay (temporary), (3) Custom content (API-triggered). A simple state machine manages which screen is active.

- **Start minimal** -- v1: Home status text display (people count, mode, active rooms as scrolling text). v2: Pixel art icons, animations, notification support, dashboard controls.

- **Use `Draw/SendHttpItemList`** -- The item list command lets you draw text + shapes in a single API call. Better than sending multiple text commands.

- **Register in agents table** -- Follow the same pattern as other services. Write heartbeat to `pixoo_log`. Orchestrator monitors via SSH `systemctl is-active pixoo`.

- **Local copy in `scripts/`** -- Source of truth: `scripts/pixoo_service.py`. Deploy via `scp` to LXC 100, same pattern as player_service and ingest_service.
