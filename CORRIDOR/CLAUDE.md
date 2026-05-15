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
| Rules | `RULES/rules/move_in_corridor.py` (`group='corridor'`) — corridor presence chain entry: light ON → conditional Awtrix preset + Entrance Monitor Ch.2 ON when `home_mode=home` → Pixoo preset push after delay. Knobs (cooldown, pixoo delay, preset names) sentence-driven via `r_move_in_corridor` container in `apartment.rule_sentences`. Hardware IDs hardcoded for safety. |
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
- **Save As New** button (added 2026-05-15) — next to Save. Always POSTs a new preset entry regardless of `_pixooLoadedPresetId`, enables clone-and-modify (load A → edit → Save As New → B exists with the changes, A is untouched). Auto-appends ` (copy)` if the user didn't change the name from the loaded preset's name; confirms before creating a duplicate-name entry (collision check against ALL existing presets, the loaded one excluded). After save, adopts the new preset's id so subsequent Save clicks update the clone, not the original.
- **Pause live updates checkbox** (added 2026-05-15) — next to Zoom buttons. Stops `loadPixoo()` from repainting the canvas with live device state so the user can edit from a blank canvas without rules overwriting work-in-progress. Canvas border turns orange (`#e67e22`) while paused; reverts to grey when off. State persisted in `sessionStorage` (key `corridor.pixooPauseUpdates`) — survives tab navigation, resets on browser close. Pure frontend, dashboard-only — outgoing actions (Push / Channel / Power buttons, rules pushing to the physical Pixoo) still work. Compare to the device-side `_pixoo_paused` flag in `rule_engine_state`, which pins the device's rotation cycle (unrelated — two different concepts that share the word "pause").
- **Live placeholders in text items** (added 2026-04-15; `{{countdown}}` added 2026-04-25) — drop `{{time}}` (→ `HH:MM`), `{{date}}` (→ e.g. `Mon 15 Apr`), or `{{countdown}}` (→ live `MM:SS` remaining) into any text item at any X,Y. Editor has **⏰ Time**, **📅 Date**, and **⏱ Countdown** buttons that prefill the token.
  - `{{time}}` / `{{date}}` resolve from the service clock (no caller setup needed).
  - `{{countdown}}` requires the pusher to supply `vars = {"countdown_end_ts": <unix_epoch>}` — renders as `max(0, end_ts − now)` formatted `MM:SS`. When the value is missing/invalid the token is stripped to an empty string.
  - **Ticker cadence is dynamic.** A preset with a non-expired `{{countdown}}` re-renders **every 1 second** so the count is smooth; once the countdown reaches `00:00` the service logs `ticker cadence 1s -> 60s` and downshifts so the device isn't hammered for nothing. Presets with only `{{time}}`/`{{date}}` keep the original 60 s cadence.
  - Ticker auto-stops on wipe/resume/new preset/sequence. Implemented in [scripts/pixoo_service.py](../scripts/pixoo_service.py) (`_substitute_live_tokens`, `_pick_ticker_cadence`, `_start_ticker` / `_stop_ticker`, `_render_preset`, `_rerender_raw_push`, `_render_gif_with_overlay`).
  - **Dashboard preview auto-polls** (added 2026-04-25) — `corridor.js` now calls `pixooPlay()` on page load so `/api/pixoo/status` polls every 5 s. The preview canvas updates automatically (countdown jumps in ~5-second steps on the web page; the physical Pixoo ticks smoothly at 1 s). Previously only a hard refresh showed new values.
  - **Editor-aware auto-poll** (added 2026-04-25) — the auto-poll's canvas-redraw block is **skipped while the editor has content** (a preset is loaded OR there are unsaved items / pixels / a background image). Otherwise the 5 s `loadPixoo` cycle would overwrite the in-progress preset within ~1 s of clicking Load. Status dot / screen name / heartbeat / brightness slider / "last refresh" still tick every 5 s — only the canvas pixel data is left alone. Resumes automatically after Clear/New (canvas is empty + no loaded preset → live device state takes over again). Guard expression: `_pixooLoadedPresetId !== null || items.length > 0 || pixels not empty || !!_pixooBgBase64`.
  - HTTP `/push` ticker now re-publishes `_pixoo_screen` on every tick (not just initial push), so dashboard preview reflects ticker-driven token values even for ad-hoc pushes bypassing the preset library.

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
