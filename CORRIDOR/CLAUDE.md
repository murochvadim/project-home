# Corridor Agent

Namespaced owner of the Pixoo64 display in the corridor — image/animation playback, preset management, scene rotation, rule-driven notifications.

Dashboard-only agent from the dashboard's perspective (no dedicated LXC service of its own). The actual Pixoo protocol work runs in `pixoo_service` on LXC 100, not here — this agent's scope is the dashboard editor + control UI.

## File Locations

This file is the index. All artifacts live in canonical locations:

| Artifact | Path |
|----------|------|
| Dashboard page | `BOILER/dashboard/public/corridor.html` |
| Dashboard JS | `BOILER/dashboard/public/js/corridor.js` |
| Dashboard API endpoints | `BOILER/dashboard/server.js` — 9 endpoints under `/api/pixoo/*` (brightness, wipe, restart, noise, power, channel, custom, status) |
| Pixoo service (LXC 100) | `/opt/media-agent/pixoo_service.py` — registered in `agents` table as `name='pixoo'` |
| Rules | `RULES/rules/` — none today; future pixoo-triggered rules use `group='pixoo'` and `RULE['controls']` with pixoo actions |
| DB preset storage | `pixoo_presets` table (managed by pixoo service + dashboard editor) |
| Rule-engine-owned pixoo state | `rule_engine_state` keys prefixed `_pixoo_` (paused flag, etc.) |
| MQTT user | `pixoo_service` on LXC 107 (mosquitto ACL) |

## Dashboard Page

Path: `/corridor.html`. Sidebar link under "Agents".

### Tabs

- **Pixoo64** — canvas editor, preset library, playback control

### Pixoo Tab Features

- 64×64 canvas with click-to-pixel drawing
- Zoom 1x / 1.5x / 2x
- Brightness slider
- Power ON/OFF
- Preset channels (Clock, Cloud, Sound, C1/C2/C3)
- Screen heartbeat status
- Preset save/load/delete

## API Endpoints (in `BOILER/dashboard/server.js`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pixoo/status` | GET | Current brightness, channel, heartbeat |
| `/api/pixoo/brightness` | POST | Set brightness 0-100 |
| `/api/pixoo/wipe` | POST | Clear canvas |
| `/api/pixoo/restart` | POST | Restart pixoo service on LXC 100 |
| `/api/pixoo/noise` | POST | Start noise effect |
| `/api/pixoo/power` | POST | ON/OFF |
| `/api/pixoo/channel` | POST | Switch to channel (Clock, Cloud, etc.) |
| `/api/pixoo/custom` | POST | Custom channels C1/C2/C3 |
| `/api/pixoo/preset/*` | various | Preset editor operations |

## Pixoo Service (LXC 100)

The actual hardware-facing service runs on LXC 100 (IP `192.168.1.138`):

- Service: `pixoo.service` (systemd)
- Entry: `/opt/media-agent/pixoo_service.py`
- Registered in `agents` table: `name='pixoo'`, `data_table='pixoo_log'`, `deploy_path='/opt/media-agent'`
- MQTT topics: listens on `mur/home/pixoo/*`, publishes heartbeat / state
- Orphan guard: `/opt/media-agent/kill-orphan.sh` in `ExecStartPre`

The dashboard's `/api/pixoo/*` endpoints publish to MQTT (via the dashboard's mqttClient) which the pixoo service consumes.

## Rule Engine Integration

Rules can control the Pixoo by returning commands with the pixoo protocol:

```python
commands.append({
    "device_id": "pixoo",
    "protocol": "pixoo",
    "action": "push_preset",
    "preset_name": "<preset>",
    "vars": {...},
})
```

The rule engine's dispatch routes protocol=`pixoo` to MQTT topic `mur/home/pixoo/command`. See the `/create-rule` skill for supported actions (push_preset, resume, wipe).

## Planned Future Features

- **GIF upload** — drag-drop gif → auto-convert to Pixoo frames
- **Text overlay** — overlay scrolling / pulsing text on any preset
- **Canvas WYSIWYG** — edit presets visually with proper color picker + layer support
- **Rule Engine notifications** — presets that react to system alerts (battery low, HA offline, etc.)

Each new feature = tab in `corridor.html`, server endpoint(s) in `server.js`, optional rule(s) in `RULES/rules/` with `group='pixoo'`.
