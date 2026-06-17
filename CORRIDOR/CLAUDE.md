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
| Rules | `RULES/rules/move_in_corridor.py` (`group='corridor'`) — corridor presence chain entry: light ON → conditional Awtrix preset + Entrance Monitor Ch.2 ON + Face Recognition screen ON when `home_mode=home` → Pixoo preset push after delay. **Fully sentence-driven** via `r_move_in_corridor` container in `apartment.rule_sentences` (refactored 2026-05-15 from the original hardcoded-device-IDs design — only the trigger device CORRIDOR_PRESENCE_ID stays hardcoded because `RULE['triggers']` is fixed at module load). Sentences classify by content keyword: `on presence` → always bucket, `when home` → home-mode bucket, `after delay` → delayed bucket; `cooldown is N seconds` and `pixoo delay is N seconds` tune knobs. Add/remove output devices by dragging `+Dev` chips into the appropriate sentence — no code change. |
| DB preset storage | `pixoo_presets` table (managed by pixoo service + dashboard editor) |
| Rule-engine-owned pixoo state | `rule_engine_state` keys prefixed `_pixoo_` (paused flag, `_pixoo_lock_until` countdown lock, etc.) |

## Countdown screen lock (since 2026-06-17)

A preset with an **active `{{countdown}}`** reserves the WHOLE Pixoo screen for the countdown's duration — enforced **centrally in `pixoo_service.py`**, so *every* pusher (any rule, the dashboard, sequences, screen rotation) is blocked while locked. This fixes the class of bug where Start Away's 90 s countdown was painted over ~1 s in by **Move in Corridor**'s Pixoo push when the user walked out through the corridor (the countdown was rendering fine — it was getting clobbered). It's a true reservation, not a per-rule opt-in flag, so no future Pixoo rule can accidentally clobber a countdown.

- **Set:** `_render_preset` calls `_set_lock(end_ts, preset_name)` on the initial push of any preset whose items contain `{{countdown}}` with a future end_ts (also stops any running sequence). State: in-memory `self._lock_until` / `self._lock_label`, mirrored to `rule_engine_state._pixoo_lock_until` for dashboard visibility.
- **Gate:** `_lock_blocks(payload, what)` guards both external entry points — MQTT `_handle_command` (`push_preset`/`play_sequence`; `wipe`/`resume` are force-only while locked) and HTTP `/push`. The **internal ticker re-render bypasses the gate** (it calls `_render_preset` directly, not the gated entries) so the locked countdown keeps refreshing every second. `rotate_screen` also early-returns while locked.
- **Allowed through while locked:** a push carrying its **own active countdown** (owner / supersede), or **`force: true`** (which also clears the lock).
- **Release:** auto-expire at `end_ts`; any `force` push; or the new `action: 'unlock'` command.
- **Rule coordination:** `start_away_mode.py` Phase 2's final preset carries `force:true` (race-safe release + show); and on an **early home-return mid-countdown** the rule emits `{action:'unlock'}` so the welcome/idle screen can take over immediately instead of waiting out the lock.
- **Dashboard:** all manual draw actions in `corridor.js` (wipe ×2, push-canvas, push-preset ×2, play-sequence) send `force:true` — a human action always wins over a lock. (`corridor.js?v=11`.)
- The older `daily_welcome.suppress_until_ts` flag still exists (Daily_Welcome's own 30-min re-push respects it); the central lock supersedes it as the general mechanism.
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
- **Scrolling (running) text** (added 2026-06-15) — each text item has a **↔ Scroll** checkbox + direction (left/right) / **speed 0–20** (0=slow, 20=fast; mapped in the renderer to `pic_speed = max(20, 300 − level·14)` ms/frame) / firmware-font(0–7). Stored on the item (`scroll/dir/speed/font`), so it saves with the preset and round-trips on load (item list shows a blue **↔** marker; **click an item to edit** — loads text + scroll settings back into the controls, removes it, re-Add re-inserts the updated version). **Render = software scroll-as-GIF, NOT native `Draw/SendHttpText`** — the native overlay was tried and abandoned (it rendered static on this firmware AND made text vanish on animated presets; also TextId caps at 0–19). Instead `pixoo_service._render_scroll_animation` bakes the text at a shifting x across N frames (cap 60, step auto-sized from text width) and sends them as one looping `SendHttpGif`, so the device loops it = continuous marquee. Static items + background (incl. an **animated GIF bg**, composited per frame) bake into every frame → **scroll works over animations too**. Branches in: `_render_preset` (preset/rule push) + the raw `/push` handler (editor live Push). One-time push cost (~8 s for a long marquee) then free (device loops); no ongoing ticker unless the text has live `{{tokens}}`. Editor `corridor.js?v=9`.
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
