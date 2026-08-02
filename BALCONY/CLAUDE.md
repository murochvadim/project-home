# Balcony Agent

Per-room agent for the balcony — OpenHASP touch panel, rules, and balcony-area devices (gates, barrier, lights).

Dashboard-only agent (no dedicated LXC service) — same pattern as Living Room and Corridor agents. All automation logic lives in the rule engine on LXC 105.

## File Locations

Everything scattered across canonical directories — this file is the index.

| Artifact | Path |
|----------|------|
| Dashboard page | [`BOILER/dashboard/public/balcony.html`](../BOILER/dashboard/public/balcony.html) |
| Dashboard JS | [`BOILER/dashboard/public/js/balcony.js`](../BOILER/dashboard/public/js/balcony.js) |
| Rules | `RULES/rules/*.py` (group=`balcony`) — none yet |
| DB setup migration | [`BALCONY/migrations/setup.sql`](migrations/setup.sql) |
| DB agent row | `agents` table, `name = 'balcony'` |
| Config storage | `dashboard_settings` keys prefixed `balcony.*` |
| Memory | [`memory/project_agent_balcony.md`](../.claude/projects/c--Users-muroc-project-home/memory/project_agent_balcony.md) |
| Panel artifacts | [`BALCONY/build_pages.py`](build_pages.py), [`BALCONY/pages.jsonl`](pages.jsonl), [`BALCONY/pages_backup.jsonl`](pages_backup.jsonl) |

## Storage Convention

All balcony configs use `dashboard_settings` keys with prefix `balcony.`:

| Key | Shape | Purpose |
|-----|-------|---------|
| `balcony.somfy_motors` | `[{idx,name,invert,enabled,run_sec,position_pct,astop_dir,astop_sec}]` (4) | Somfy tab — 4 motor names + invert + enable + curtain-visual estimate (run_sec/position_pct) + auto-stop (astop_dir open/close/off + astop_sec). Firmware indexes/addresses are fixed; this holds display + timing config. Auto-stop is also pushed to the board as the `somfy_astop` param. |
| `balcony.irrigation` | `{v1:{schedules:[{id,enabled,start_hm,duration_min,days:[0..6]}]}, v2:{…}}` | Irrigation tab — per-zone watering schedules for the HCT-636 water timer (read by the Balcony Irrigation rule on LXC 105; `days` 0=Sunday…6=Saturday). |
| ~~`balcony.smart_switch_bindings`~~ | JSONB | **REMOVED 2026-07-26** — the TS0044 was moved to the My BathRoom agent (now `my-bathroom.smart_switch_bindings`). |

Future keys land here as features ship (e.g. `balcony.button_actions` for HASP button → device wiring once it moves out of `hasp_buttons.action_*` columns, or `balcony.rule_sentences` if sentence-based rule authoring is added like Living Room).

System-wide HASP tables (`hasp_panels`, `hasp_buttons`, `hasp_displays`) hold panel-level state — those are deliberately NOT under `balcony.*` because they're shared across every room HASP agent. Balcony's rows in those tables are seeded by `server.js ensureSchema()`.

## Rules (group=`balcony`)

| Rule | File | Trigger | Purpose |
|------|------|---------|---------|
| Balcony Buttons | `RULES/rules/balcony_buttons.py` | `*` (early-return on `hasp:balcony:` device-id prefix) | On every panel button press, look up the matching `hasp_buttons` row (keyed on `(page, button_id, event)`) and dispatch every binding in its `bindings` JSONB array (multi-device per press, wallmote-parity since 2026-05-01). Each binding shape `{device_id, channel, name, label, action}` for device, or `{type:'hasp_command'\|'pixoo_preset', target}` for non-device. Toggle resolved client-side from `state.devices[id].dps[channel]`. 1 s cooldown per (page, button, event) collapses HASP's down+up triple into one fire. Sets `_skip_loop_guard=True` on emitted commands so rapid intentional presses don't trip the same-action-4-in-10s loop guard in `rule_engine._dispatch_command`. |
| Balcony Displays | `RULES/rules/balcony_displays.py` | `heartbeat` (60 s) | Iterate `hasp_displays` rows, resolve each row's source, render `format_string`, publish to `hasp/balcony/command/p<page>b<label_id>.<target_property>`. Two source kinds (since 2026-05-01): `state.shared` keys (`source_value='boiler_temp'`) and **device sensors** (`source_value='device:<device_id>:<dps_key>'`, e.g. `device:b0f9c460-…:temperature` reads `state.devices[id].dps['temperature']`). Format string supports `{{val}}` (the resolved source) and `{{<key>}}` (any state.shared key, for legacy multi-key templates). Per-row `refresh_sec` honored. **Float values are rounded to 1 decimal in `_fmt()`** (added 2026-05-03) so micro sensor-noise (e.g. `21.039999961853 → 21.040001869202`) doesn't blow past the dedupe and trigger spurious publishes. Dedupe against `last_value` — but **force-republish** every 10 minutes regardless of dedupe (added 2026-05-03) so a panel that reboots after a stable value (e.g. temperature held steady for hours) re-receives the value within ≤ 10 min instead of being stuck on the default text. **SELECT filters out empty `source_value` rows** at the DB layer (rule was processing all 67 placeholder rows on every heartbeat, ≈ 100 ms; now only the actually-configured rows are touched). |
| Balcony Button Mirror | `RULES/rules/balcony_button_mirror.py` | `*` (early-return on devices referenced by `bindings[0]` of any balcony button) | Output complement of `balcony_buttons`: when the bound device's state changes from ANY source (HA dashboard, mobile app, manual switch, our own command), publish `hasp/balcony/command/p<page>b<button_id>.val=0\|1` so the panel button's @checked tint stays in sync. Mirrors `bindings[0]`'s state when a button has multi-device bindings — first device wins (user puts the representative device first if they have a multi-device button). depends_on: `["Balcony Buttons"]`. ~2 s end-to-end latency. |
| ~~Balcony Smart Switch Handler~~ **(MOVED 2026-07-26)** | ~~`RULES/rules/balcony_smart_switch_handler.py`~~ **DELETED** — the TS0044 (`0x8c65a3fffeb139ae`) is now handled by `my_bathroom_smart_switch_handler.py` (group `my-bathroom`). Row kept for history. | specific id `["0x8c65a3fffeb139ae"]` (Tuya TS0044 wireless 4-button scene remote, Z2M friendly name `Balcony Smart Switch`) | Added 2026-05-03. Parses `dps['action']` matching `^(\d+)_(single\|double\|hold)$` → looks up `dashboard_settings.balcony.smart_switch_bindings` slot `btn<N>:<event>` → emits one command per binding (multi-device supported). Toggle resolved client-side. `_skip_loop_guard=True` for rapid presses. **Single only on the dashboard UI** (decided 2026-05-03 after live testing): `_hold` never fires on this MOES TS0044 firmware variant; `_double` works but creates visible on→off flicker when both single+double are bound on the same button (device emits both on a real double-click). A 500 ms single-debounce was prototyped to suppress the flicker but introduced sluggish latency on every press; user reverted. Per-binding action picks `toggle` / `turn_on` / `turn_off` (or per-channel `Page N` for HASP page-select bindings — see "Picker page-select" below). Bindings cached 30 s. **1 s per-slot cooldown** added 2026-05-05 to suppress duplicate `action` emissions from this TS0044 firmware (Z2M publishes the same action value twice in rapid succession on every press; without dedupe each binding fires twice — confused devices like Awtrix that don't tolerate two power-toggles 50 ms apart). Pattern matches the `balcony_buttons` HASP-press cooldown. |
| Gates Button Progress | `RULES/rules/gates_button_progress.py` | specific id `["gates_01"]` | Added 2026-05-05. Mirrors `gates_01`'s `barrier_progress` / `gates_progress` onto small corner-label widgets (`p1b113` for GATES, `p1b123` for BARRIER) on the balcony panel — green→white text shows live `N%` while a sequence runs, clears (single-space — see OpenHASP caveat below) when idle. Triggered by every gates_01 status update (board pushes /status on every state-machine tick, ~1 Hz during a sequence). Module-level dedupe map `_LAST` skips republishing identical text. **`_skip_loop_guard=True`** on every command — without it the rule engine's 4-same-action-in-10s loop guard auto-disables the rule mid-sequence (16+ ticks per fire all carry empty `action` since we route via `path`). Doesn't touch the buttons' `.val` — `toggle:true` was removed from `p1b110`/`p1b120` widget JSON so the buttons stay momentary; the corner percentage is the active-state indicator (empty=idle, "N%"=running). |

### `hasp_buttons.bindings` — JSONB array shape (added 2026-05-01)

Each panel button's actions live in a single JSONB array. One press fires N actions:

```json
[
  {"device_id": "32104641ecfabc567240", "channel": "2",
   "name": "Kitchen Switch", "label": "Frig Spots", "action": "toggle"},
  {"device_id": "321046412cf43237bd9d", "channel": "1",
   "name": "Balcony Switch", "label": "Wall Light", "action": "turn_on"}
]
```

Same shape as `dashboard_settings.living-room.wallmote_bindings` slot entries, plus rare non-device variants `{type:'hasp_command', target:'page 2'}`, `{type:'pixoo_preset', target:'<name>', vars:{...}}`, and `{type:'media', media_action:..., target:'tv55', playlist_id|rel_path}` (see "Media Buttons" below). The legacy `action_type` / `action_target` / `action_payload` columns are retained but no longer read by code (preserved for rollback safety).

### Media Buttons (pages 4 + 5 → Balcony TV `tv55`, added 2026-06-21)

Panel button presses on pages 4/5 drive the Balcony 55" TV via the media agent on LXC 100 (`player_service.py` :8766). The chain reuses the existing Balcony Buttons rule with a new `media` binding variant:

```json
{"type":"media","media_action":"tv_on","target":"tv55","label":"TV On"}            // page 4 control
{"type":"media","media_action":"play_playlist","playlist_id":12,"target":"tv55","shuffle":false,"repeat":false,"label":"..."}  // page 5
{"type":"media","media_action":"play_video","rel_path":"Videos/foo.mp4","target":"tv55","label":"foo.mp4"}                     // page 5
```

`media_action ∈ {tv_on, tv_off, vol_up, vol_down, pause, stop, prev, next, play_playlist, play_video}`.

**Flow:** panel `up` event → `hasp:balcony:p<page>b<id>` synthetic event → Balcony Buttons rule → `balcony_buttons._build_command` `media` branch emits `{device_id:'media', protocol:'media', media_action, target, ...}` → `rule_engine._dispatch_command` routes `protocol=='media'` (a cmd-level check next to `pixoo`, since `media` is a virtual device with no `devices` row) → `rule_engine._dispatch_media` does a urllib POST to the media agent:

| media_action | media-agent endpoint (`http://192.168.1.138:8766`) | body |
|---|---|---|
| `tv_on` / `tv_off` | `POST /api/media/command` | `{entity:'tv55', command:'turn_on'\|'turn_off'}` (proxied to tv_control :8765, `entity=='tv55'` branch) |
| `vol_up` / `vol_down` | `POST /api/media/command` | `{entity:'tv55', command:'volume_step', value:+10\|-10}` — **relative ±10% step**. tv_control's `volume_step` branch reads the TV's current `volume_level`, adds the delta, clamps 0..1, and calls `media_player.volume_set` (HA's bare `volume_up`/`volume_down` step too small). |
| `pause` / `stop` / `prev` / `next` | `POST /api/queue/{pause,stop,prev,next}` | `{}` |
| `play_playlist` | `POST /api/playlists/<playlist_id>/play` | `{target:'tv55', shuffle, repeat}` |
| `play_video` | `POST /api/media/play` | `{relPath, target:'tv55'}` |

`tv55` is a key in `player_service.py`'s `TV_TARGETS` (av_url `192.168.1.194:9197`, audio_sink `dlna`) and a branch in `tv_control.py`'s `/media/command` (entity `media_player.balcony_55_neo_qled_qe55qn85dbtxsq`). *(TV replaced 2026-06-25: `.217`→`.194`, new HA entity — see [MEDIA/CLAUDE.md](../MEDIA/CLAUDE.md) "TV-55 Balcony".)*

**DB rows:** 13 `hasp_buttons` rows with `action_type='media'` — page 4 (110/120/130/140/150) carry fixed control bindings; page 5 (110–140 playlists, 150–180 videos) start with empty bindings. (`action_type='media'` is also the flag the dashboard uses to split these out of the device-only Button Bindings picker.)

**Dashboard surface:** the **Media Buttons** card on the Panel tab (`bc-media-card` in `balcony.html`, `bcLoadMediaButtons`/`bcRenderMediaList`/`bcMediaSelectChange`/`bcSaveMediaButtons`/`bcTestMediaRow` in `balcony.js`). Page-4 control rows are read-only with a ▶ Test; page-5 rows get a playlist/video `<select>` (playlists from `GET /api/playlists`, videos from `GET /api/media/walk?path=Videos` filtered to video extensions) + ▶ Test. **Picking a playlist/video AUTO-SAVES** that row immediately (`PATCH /api/hasp/balcony/buttons/:id {bindings}`) — the panel button reads the *saved* binding, so a pick must persist without a separate Save click (▶ Test only previews the in-memory pick; the "Save Selection" button stays as a bulk backup). The browser calls the media agent directly via `MEDIA_API='http://192.168.1.138:8766'` (same pattern as `media.js`) — dashboard stays UI-only.

### How HASP button events reach the rule engine

The engine subscribes to `hasp/+/state/+` (already present on every plate). For object IDs matching `^p\d+b\d+$` (button widgets), it synthesizes a device_id `hasp:<plate>:<obj>` (e.g. `hasp:balcony:p1b110`) so rules can target the panel widget directly without registering each button as a separate device. Payload `{event:'short'|'long'|'down'|'up'|'double'}` is passed through as `dps`.

The panel ITSELF is registered as a single device row (`id='hasp:balcony', name='balcony', protocol='hasp'`) so the rule engine's existing `protocol='hasp'` dispatch path resolves and publishes commands to `hasp/balcony/command/<path>` — same shape Pixoo uses.

## Dashboard Page

Path: `/balcony.html` (served by the Windows dashboard). Sidebar link under "Agents" section, after Living Room Agent.

### Tabs

- **Panel** — five cards (top to bottom):
  - **OpenHASP Touch Panel** — static info: hardware (Sunton ESP32-S3 4848S040), IP `192.168.1.141`, MQTT prefix `hasp/balcony/`, web-UI link.
  - **HASP Balcony status** — live MQTT-over-WebSocket connection (browser → broker port 9001 as `dashboard_browser`), shows `● connected/offline` from LWT, uptime / signal / current page from `hasp/balcony/state/statusupdate`. **Power chip + On/Off active-button highlight (added 2026-05-26)** — header carries a `power: ON / OFF / —` chip (green/red/grey) and the matching On/Off button stays filled. State source is the dedicated `hasp/balcony/state/backlight` topic (NOT statusupdate — firmware 0.7.0-rc12 doesn't put the backlight field in statusupdate at all; learned from a live mosquitto_sub capture). Optimistic flip on click + 500 ms followup `command/statusupdate` request. Last-known state cached to `localStorage['balcony.hp.power']` and restored on `DOMContentLoaded` so the chip survives page navigation without waiting for the first MQTT roundtrip. Required ACL on LXC 107: `read hasp/balcony/state/#` + `read hasp/balcony/LWT` (the `state/#` wildcard already covered the new `state/backlight` topic — no ACL change needed).
  - **Sync from panel** — POST `/api/hasp/balcony/sync` fetches the panel's current `pages.jsonl` over HTTP, parses every widget, upserts rows in `hasp_buttons` / `hasp_displays`, deletes unconfigured-stale rows whose widgets no longer exist, and saves the jsonl back to `BALCONY/pages.jsonl` for git history. Filters: skips `page=0` (OpenHASP global/nav layer) and label widgets whose text is purely a private-use codepoint glyph (E000–F8FF — they're icons, not data displays). User-configured rows (`action_type` set on a button / `format_string` set on a display) are preserved across syncs even if the widget is removed from the panel.
  - **Button Bindings** — table of `hasp_buttons` rows for the panel. Per row: event (`up` / `down` / `short` / `long` / `double` — note: panel only emits `up` / `down` by default, the rest need per-button config in pages.jsonl), action_type (`device` / `hasp_command` / `pixoo_preset`), target picker (device dropdown for `device`, free text for `hasp_command`, preset dropdown for `pixoo_preset`), payload (action `toggle` / `on` / `off` plus protocol-aware channel dropdown for `device`). Save All persists; Test fires the binding directly via `/api/hasp/balcony/buttons/:id/test` (HTTP path; bypasses the rule engine for fast wiring verification). Channel dropdown auto-populates from the target device's `dps_labels` / `channel_config` — Zigbee multi-gang shows `state_l1`/`state_l2`/…, Tuya shows numeric `1`/`2`/`3`. Legacy values not in the dropdown surface as red `(legacy)` options so they're easy to spot and replace.
  - **Display Templates** — list of `hasp_displays` rows. Per row: page, label_id, display_type (`text` / `gauge` / `series` / `bar`), target_property (`text` / `val` / `bg_color` / `text_color`), **Source picker** (single dropdown with two `<optgroup>`s — `state.shared keys` and `Device sensors`; selecting a device sensor option auto-fills `source_value='device:<id>:<key>'` and sets `source_type='device'`), format string (`{{val}}` for the resolved source, `{{<key>}}` for any state.shared key — supports multi-key templates like `B {{boiler_temp}} / P {{panel_temp}}`), refresh seconds, description. Live preview resolves the chosen source the same way the rule does (10 s device-list cache). Filters: `Show: only configured` (default) hides empty placeholder rows; switch to `all` to bind a panel widget. Limit: `10` / `20` / `50` / `all`. ▾ collapse toggle to fold the whole card. Save refreshes the list so the filter immediately reflects persisted values.

- **Star Projector** (added 2026-05-26) — control surface for the Tuya WIFI Star Projector 2 (id `bfecd037d10a0ffcfagj8e`, IP `192.168.1.185`, MAC `00:33:7a:3b:bd:ed`, room `Balcony`, `protocol='local'`, `version='3.5'`). Layout: Power header + Brightness card (full width) + a **3-card row** Mode | Colour | Scene (each `flex` with `min-width`, wraps on narrow windows; Scene gets `flex:2` since the captured-scene list needs more room). Controls:
  - **Power** (DPS 20 bool) — `power: ON/OFF` chip + active-button highlight + `localStorage['balcony.sp.power']` cache for instant repaint after page reload.
  - **Mode** (DPS 21 enum: `white` / `colour` / `scene` / `music`) — 4 buttons, active one filled green.
  - **Brightness** (DPS 22 int 10..1000) — range slider, sent on release with 3 s touch-debounce so the 5 s poll doesn't repaint mid-drag.
  - **Colour** (DPS 24 raw hex string `HHHHSSSSVVVV` — Tuya HSV: H 0..360, S 0..1000, V 0..1000). Browser color-picker → JS converts RGB → Tuya HSV. Always sets `21: 'colour'` in the same payload so picking a color auto-switches mode.
  - **Scene** (DPS 25 — Tuya `scene_data_v2` raw hex blob) — **capture-replay** (NOT a hardcoded 1..8 enum, NOT factory presets). Reason: the device's "named scenes" (Aurora/Galaxy/…) are stored in the Tuya app's mobile code, not on the device. Local TCP only exposes the *currently active* scene_data; Tuya Cloud `/v1.0/iot-03/devices/<id>/specification` returns only the schema (`{scene_num, scene_units:[{h,s,v,bright,temperature,unit_change_mode,unit_gradient_duration,unit_switch_duration}, …]}`), not the device's preset list. So scenes are populated by **user capture**: open Tuya app → pick a scene → wait ~3 s for DPS 25 to sync → type a name in the dashboard → click 🎬 Capture → JS reads `SP_STATE['25']` and stores `{name, scene_data}` in `dashboard_settings.balcony.star_projector.scenes`. Each saved row gets a ▶ apply button + × delete button. Currently-playing detection: `SP_STATE['25'] === scene.scene_data` AND `SP_STATE['21'] === 'scene'` AND `SP_STATE['20'] === true` → green highlight + `● PLAYING` badge on that row, re-evaluated on every 5 s poll so the badge tracks scene changes from any source (dashboard, Tuya app, voice). Apply sends `{21:'scene', 25:<saved hex>}` in one DPS write so mode auto-switches.

  All controls write through the system-wide endpoint `POST /api/devices/:id/dps` (body `{dps: {key: value, ...}}`) — see "Direct Tuya local DPS write" below. 5 s state poll; optimistic repaint after each send so the UI feels instant. Scene list lazy-loaded on first tab activation via `GET /api/dashboard-settings/balcony.star_projector.scenes`; mutations persist via `POST` to the same key (existing endpoint, no new server.js code for storage). Cache-bust on every layout change.

- **Balcony Smart Switch** (added 2026-05-03; **⚠ MOVED to the My BathRoom agent 2026-07-26 — this tab + its `balcony.js` module + the handler + the `balcony.smart_switch_bindings` key were all DELETED; the physical TS0044 `0x8c65a3fffeb139ae` is now managed by My BathRoom → Smart Switch. Text below kept for history.**) — bindings UI for the Tuya TS0044 4-button wireless scene remote (Z2M friendly name `Balcony Smart Switch`, IEEE `0x8c65a3fffeb139ae`, room=`Balcony`). Single card per button (4 cards × 1 row each — single only; see rule docs above for why hold/double aren't surfaced). Each row has a multi-device picker chip + per-device action dropdown (`toggle` / `turn_on` / `turn_off`). Multi-device per slot supported (one press fires all bound commands at once). Storage: `dashboard_settings.balcony.smart_switch_bindings` (mirrors the `living-room.wallmote_bindings` pattern from `living-room.js`). The picker reuses the same overlay as the HASP Button Bindings card via wrapper handlers `bcClosePicker` / `bcFilterPicker` that route to the smart-switch state when `_swPickerActive` is set. Lazy-loaded on first tab activation. Save All replaces the entire JSONB value — old `:double` / `:hold` keys from earlier UI experiments get dropped on the first save. **ESP boards are pickable as targets** since 2026-05-05 — `CONTROLLABLE_TYPES` includes `esp_board` and the picker enumerates each board's `dps_config` channels that have `action_on` (e.g. `gates_01` exposes `barrier_trigger` + `gates_trigger`). The action dropdown's `turn_on` / `turn_off` map per-channel to sketch keys via `dps_config.<channel>.action_on/action_off` in the rule engine — pulse-only triggers (gates) only meaningful with `turn_on` since they have no `action_off`. `toggle` resolves to `turn_on` when the channel has no current state in `last_state`.

- **Somfy** (added 2026-07-23) — controls **4 Somfy RTS motors** (Left Roof / Right Roof / Left Curtain / Right Curtain) via the CC1101 433.42 MHz transmitter added to the `balcony_bridge` (BoBo) ESP32 (firmware `v17-somfy`). **Curtain-style UI (2026-07-23):** one card, 4 rows, each with a Project-General-Curtain-style **60×40 window + sliding red panes** (curtain-vis CSS copied into `balcony.html`) showing an **estimated** position (Somfy RTS gives NO feedback), plus **▲ Open · ■ Stop · ▼ Close** + **run [N] s** (manual full-travel time) + **set [%]** (re-anchor drift) + **auto-stop [off/open/close] + [N] s** + **🔗 Pair** + **enable** + **invert** + a live **`%` · cnt** readout. **Timed position estimate:** Open animates the panes 0→100 % over `run` s (red "· moving"), Close →0, Stop freezes at the current estimate; `set %` corrects drift; `position_pct` persists in the config. **Enable** unchecked greys + disables that row's Open/Stop/Close/Pair (`sfCmd`/pair also refuse a disabled motor). ⚠ the **`cnt`** (rolling code) is a security counter that only ever increments and is **NEVER reset** — resetting de-syncs the motor (it rejects lower codes until re-paired); only the `%` reaches 0 (closed) / 100 (open). Config lives in `dashboard_settings.balcony.somfy_motors` = `[{idx,name,invert,enabled,run_sec,position_pct,astop_dir,astop_sec}]`. **Timed auto-stop (firmware v17):** per-motor `somfy_astop` — a **schema param** the dashboard pushes via `POST /api/esp/boards/balcony_bridge/parameters` as a `/config` CSV `dir:sec`×4 (dir 0=off/1=up/2=down, EEPROM-persisted at ASTOP_ADDR 8-19); after the chosen direction the **board** sends Stop **N s later** (non-blocking `loop()` timer — robust even with the dashboard closed; a manual Stop / opposite direction cancels it). The dashboard holds it as **open/close + sec** (defaults roof→open, curtain→close), maps open/close→up/down via each motor's `invert` (re-pushes on invert change + on tab open), and animates the panes to the partial position over N s. **Frontend-only** — `js/balcony.js` self-contained IIFE (lazy-inits on tab open like Star Projector; wraps `showTab`; polls `GET /api/esp/boards` every 5 s → `{boards:[...]}` → `last_status.cc1101_ok` + `somfy_counters[idx]`): the buttons POST to the **existing** schema-validated `POST /api/esp/boards/balcony_bridge/command` with `somfy_up|down|my|prog:<idx>` (`My`==Stop, `prog`==pair). Names + per-motor invert stored in `dashboard_settings.balcony.somfy_motors` (seeded with the 4 names). **Pair modal** walks the one-time dance: hold **PROG** on the motor's original remote → motor jogs → click **Send PROG** → jogs again = paired (the original handheld remote keeps working — pairing is additive). No new DB table, no `routes-somfy.js`, no `server.js` change — the motors are fixed & firmware-hardcoded. Firmware details (CC1101 wiring SCK18/MISO19/MOSI23/CSN5/GDO0-4 with **GDO2 left off GPIO15 — strapping pin, would disrupt boot**; per-motor 24-bit virtual remote 0x100001..4; **EEPROM** rolling counter at addr 0/2/4/6, NOT NVS, to avoid the BoBo calibration-EEPROM conflict; async OOK via ELECHOUSE SmartRC + `Somfy_Remote_Lib`; fits the default partition at 96%, OTA-flashable) + the preserved `balcony_bridge/` v15-sanity rollback sketch are in `BALCONY/SOMFY_PLAN.md`. Verified end-to-end + first motor paired + working 2026-07-23.
- **somfy + fan** (tab renamed from `Somfy` 2026-07-23) — the same `balcony_bridge` board's CC1101 also drives a **433.92 MHz swing fan** (fixed-code RF, rc-switch **proto 6, 12-bit**). Firmware **`balcony_bridge_devices` (`v28-devices`)** — unified BoBo + Somfy + Fan (board display name = `balcony_bridge_devices` since v24; MQTT/OTA id stays `balcony_bridge`). **Fan card** (in `balcony.html`, below the Somfy card): `⏻ Fan On` / `⭘ Fan Off` / `Speed +` / `Speed −` / `💡 Light` + a `fan: ON/OFF` chip + `light:` chip + `speed: N` label. **Dashboard control (TX):** buttons call `fanCmd(<code>)` → `POST /api/esp/boards/balcony_bridge/command` `fan_tx:<code>` (schema action); the board TXes via CC1101 (retune → send 8× → back to RX). **Codes:** On **351** · Off **381** · Speed+ **349** · Speed− **375** · Light **382** (dashboard sends these; the fan's own decoder accepts the proto-6 re-encode). **Physical-remote mirroring (RX) — WORKS since v28 (was disabled v23):** a manual remote press is decoded and the `fan:`/`light:`/`speed:` chips update. The catch this took many iterations to crack: rc-switch's decoded integer **wobbles a few LSBs per press** (On observed as **351 / 359 / 367**; earlier BLE-load sessions even drifted it to 381) — matching a single value dropped real presses. **Fix (`v28`): `applyFanCode()` matches each button against a DRIFT-SET, and the sets are disjoint** → On `{351,359,367}` · Off `{381}` · Light `{382}` · Speed+ `{349}` · Speed− `{373,375}`; it returns bool and the RX handler publishes only on a match. On/Off are far apart (359 vs 381) so they're solid. **Residual:** On`351`↔Speed+`349` and Off`381`↔Light`382` are one bit apart, so Speed/Light *can* occasionally cross-classify — only raw-waveform-signature matching would fully fix that (designed, not built; the diagnostic `balcony_bridge_capture` sketch capture-4 dumps raw pulse timings for it). The board publishes `fan_power`/`fan_light`/`fan_speed` in `/status`; `js/balcony.js` `sfPoll` renders the chips. Fan state is still an ESTIMATE (no real feedback; resets on reboot). **RxBW note:** narrowing the CC1101 RX bandwidth (200→135 kHz) did **not** change the decode — bandwidth isn't the drift cause (CPU/BLE timing shifting rc-switch's bit-slicing is). Codes live inline in `balcony.html` `onclick` + the firmware `applyFanCode` sets — no DB, no `routes-*.js`, no `server.js` change. Firmware not in git (bakes creds) — sketch at `C:\Users\muroc\Arduino_Projects\balcony_bridge_devices\`; v28 also carries a **BLE client-pool leak fix** (`connectBobo` `setSelfDelete(true,true)` + null-guard — the old code crashed on the 4th BoBo reconnect).
- **Roborock** (added 2026-07-24) — control tab for the **Roborock S6** robot vacuum (`vacuum.roborock_s6_f881_robot_cleaner`, MAC `50:ec:50:19:f8:81`). The S6 is a **Mi Home** device, so it was added to HA via the **Xiaomi Miot Auto** integration (Mi Home account `1889750872`, local control) — NOT the Roborock cloud integration (that failed: `RoborockNoResponseFromBaseURL` = no Roborock-cloud account for the email). It's the standard `protocol='vacuum'` pattern: a `devices` row on LXC 102 (templated from the Viomi row + `pause`/`locate`), a 1-tuple `HA_DIRECT_DEVICES` entry in `DEVICE/agent/adapters/ha_api.py` (battery is in the vacuum entity attrs), and the device-agent projects `last_state.{state,battery}`. **Frontend-only tab** (`showTab('roborock')`, self-contained IIFE in `balcony.js` mirroring the Star Projector pattern): a header card with online dot + `state:` chip (cleaning/returning/paused/docked/idle/error) + `🔋 N%` chip + last-seen, and a button row **▶ Start / ⏹ Stop / ⏸ Pause / 🏠 Dock / 📢 Locate** → `POST /api/vacuum/vacuum.roborock_s6_f881_robot_cleaner/<verb>` (the existing entity-generic endpoint; `dock`→`return_to_base`). Status polls `GET /api/devices/states?ids=<id>` every 5 s. **No `server.js`/`routes-*.js`/DB-schema change** — reuses the existing vacuum endpoints. Also auto-becomes rule-addressable + bindable in the 5 pickers via `rule_engine._dispatch_vacuum`. **Tab extras (2026-07-24):** a **Suction** selector (Silent / Basic / Strong / Full Speed) → `POST /api/vacuum/:entity/fan-speed {speed}` in the new **`routes-vacuum.js`** module (wired via one require line, mirrors `routes-media-cd.js`) → `callHA('vacuum','set_fan_speed')`; plus **clean stats** (`Clean: N m² · M min` = the session's `clean_area`/`clean_time`). Both are fed by extending the device-agent's vacuum projection in `ha_api.py` to also carry `fan_speed` / `clean_area` / `clean_time` into `devices.last_state` (additive + guarded — Roomba/Viomi unaffected). **Balcony-only reality (decided 2026-07-24):** the S6 cleans just the balcony (one room), so per-room/segment mapping was **skipped** as valueless (Start already cleans the whole balcony); our apartment layout can't be the robot's nav map (it navigates by its own LIDAR map, `map_present:1`). **Phase 2 (only if ever wanted):** zone cleaning of sub-areas via `app_zoned_clean` would need a one-time coordinate calibration to the robot's map frame (`routes-vacuum.js` is the home for it) — deferred as not worth it for a balcony.

- **Irrigation** (added 2026-07-31) — control tab for **two HCT-636 wireless water timers = 4 valves**: **Water Valve A / B** (Zone A.B, `valve.water_timer_valve_1` / `_2`) + **Water Valve C / D** (Zone C.D, 2nd timer `valve.rf_water_timer_3_valve_1` / `_2`, added 2026-08-02; renamed the first pair 1/2→A/B same day). The valves are HA **`valve.`** entities (Tuya Sub-GHz behind the HCG-003 gateway → HA Tuya cloud integration), ingested by the device agent as `protocol='valve'` (state-only; see [DEVICE/CLAUDE.md](../DEVICE/CLAUDE.md) "HA valve domain"). **Four** device rows on LXC 102 (`device_type='valve'`, room Balcony). Adding more valves = one line each in `ha_api.py` `HA_DIRECT_DEVICES`, `balcony_irrigation.py` `VALVES`, and the `balcony.js` `VALVES` array + a `devices` row. ⚠ Zone C.D was **`unavailable` in HA** when wired (offline timer) — the rows/UI show offline until the physical timer reports; ingestion auto-fills on connect. **Per zone:** manual **💧 Open / ⏹ Close** → `POST /api/valve/:entity/:action` (**`routes-valve.js`**, own module past the architecture hook, mirrors `routes-vacuum.js`) → `callHA('valve','open_valve'|'close_valve')`; live open/closed state chip + online dot (polls `GET /api/devices/states` every 5 s). **⏰ Schedules — any number per zone:** each row = **on** toggle + **Start** time + **duration (min)** + **Days** (7 chips `S M T W T F S`, index 0=Sunday…6=Saturday). **＋ Add schedule** / **✕** remove / **💾 Save schedules** → `dashboard_settings.balcony.irrigation` = `{v1:{schedules:[{id,enabled,start_hm,duration_min,days:[…]}]}, v2:{…}}`. Executed by the **Balcony Irrigation** rule (group `irrigation`, LXC 105, `RULES/rules/balcony_irrigation.py`) — heartbeat-triggered crossing-edge open + per-schedule daily latch; **flood-safe auto-close** reconciled from a DB-persisted `open_until_ts` on every heartbeat (survives an engine restart, ≤60 s to close); overlapping schedules extend to the latest close. Opens/closes via engine **`_dispatch_valve`** (HA `valve.*` services). **Frontend-only tab** (`showTab('irrigation')`, self-contained IIFE in `balcony.js`, mirrors the Roborock pattern — schedules load ONCE per session so unsaved edits survive a tab switch). Manual open is NOT auto-closed (only scheduled opens set `open_until_ts`). See [[project_agent_water_valve]]. **LetPot Max card (added 2026-07-31):** a 3rd card in the same Irrigation tab (`#irr-letpot`, own IIFE) for the **LetPot LPH-Max A687** hydroponic garden (official HA LetPot cloud integration). Device agent ingests all **12 entities** (`ha_api.py` `HA_DIRECT_DEVICES` id `lph_max_a687`, `protocol='letpot'`; see [DEVICE/CLAUDE.md](../DEVICE/CLAUDE.md) "LetPot hydroponic"). Card = header (online dot + power chip + **💡 Light ON/OFF chip** + 💧 water-level % + 🌡 temperature °C) + controls: 4 switch toggles (Power / Pump cycling / Auto mode / Alarm), 💡 Brightness slider (1–9), Light-mode + Temp-unit selects, **💡 Light On / ⭘ Light Off buttons**, 🌅/🌆 Light-on/off `<input type=time>`, 🌱 Plants-age number; sensors read-only. Each control → **`POST /api/letpot/set {entity_id,value}`** (`routes-letpot.js`, own module: domain-inferred → `switch.turn_on|off` / `number.set_value` / `select.select_option` / `time.set_value`, allowlisted to `^(switch|number|select|time)\.(lph_|letpot_)`). Reads state on the tab's 5 s poll; inputs are touched-debounced (don't snap back mid-edit). No rule engine (LetPot self-schedules its light via its own `time` entities). **⚠ The LetPot light has NO instant switch + only runs when the unit is powered on** — it follows the on→off schedule (on==off ⇒ off). So **💡 Light On** = turn Power on (if off) + set `light_on=now`, `light_off=later` (light comes on immediately, but this **overwrites the schedule on-time to "now"**); **⭘ Light Off** = set `light_off=light_on` (light off, power/pump left on). The **💡 Light chip is an inference** (power on AND clock inside the on→off window, overnight-wrap aware) since the device exposes no light-state entity. **Layout (2026-07-31):** the 2 water-valve cards sit **side by side** (`#irr-list` flex row, cards `flex:1 1 320px`, wrap on narrow); the LetPot card is full-width below. See [[project_agent_letpot]].

## Home Gates board (gates_01) — building garage gate + barrier controller

ESP32 Dev Module at IP `192.168.1.158`, MAC `B0:CB:D8:CA:16:7C`, room `Balcony` (the controller's physical location, not the gates themselves which are downstairs at the building entrance). Sketch lives at `BALCONY/sketch/Home_Gates_Device_Claude/` (mirrored from `Arduino_Projects/Home_Gates_Device_Claude/` for git tracking; Arduino IDE compiles from the latter). Migrated from ESP8266 → ESP32 on 2026-05-05 because the ESP8266 board's MAC was stuck in REASON_AUTH_FAIL on the DECO mesh after a flash storm.

**Hardware**: Relay_1 (GPIO 16 — gate motor), Relay_2 (GPIO 17 — barrier), Buzzer (GPIO 14 — beep on each request). Migrated 12→16, 13→17 on 2026-05-06 to move off GPIO 12 (a strapping pin that can prevent boot when the relay holds it high during power-up). GPIO 16/17 are pure general-purpose IO on this generic ESP32 Dev Module — no strapping, no flash conflict, no PSRAM conflict (PSRAM only collides on WROVER, which this board isn't).

**Two MQTT-driven actions** (via `mur/home/esp/gates_01/command`):
- `open_barrier` — TOTAL_SEQUENCES (4) × BARRIER_PULSE_NUM (4) pulses on Relay_2 with `delay_btw_pulses_barrier` (default 3 s) between sequences. Auto-closes via the relay-pulse pattern.
- `open_both_gates` — TOTAL_SEQUENCES × BOTH_GATES_PULSE_NUM (8) pulses split between Relay_1 (gate) and Relay_2 (barrier) with `delay_btw_pulses_both` (default 2 s) between sequences.

**Tunable params** (Project Boards → Params): `delay_btw_pulses_barrier`, `delay_btw_pulses_both` — both 1..10 s, EEPROM-persisted.

**Live progress fields in `/status` payload**:
- `gates_state` — string: `idle` / `barrier_opening` / `both_opening` / `barrier_done` / `both_done`
- `barrier_progress` — int 0..100 while barrier sequence runs; -1 when idle
- `gates_progress` — int 0..100 while both-gates sequence runs; -1 when idle

These are projected into `devices.last_state` by the rule engine (`_ESP_STATUS_DPS_FIELDS` in `RULES/rule_engine.py`) so a HASP / Awtrix / Pixoo display can render a live progress bar via a rule sentence. The board publishes /status on EVERY state-machine tick during a sequence (~1 Hz), so progress flows real-time without polling.

**Project Boards Simulation tab** — the **Gates** card shows two visible progress bars (Barrier + Both Gates) updating live as the board publishes /status. The dashboard's existing WebSocket also subscribes to `mur/home/esp/+/status` (via `dashboard_browser` MQTT user with read ACL on `mur/home/esp/+/status`, added 2026-05-05) and updates the bar widths in place between the 30 s API polls.

**Devices page (Set Devices tab)** — gates_01's `dps_config` channels with `action_on` (`barrier_trigger`, `gates_trigger`) render as inline trigger-button rows under the device. Click `▶ open_barrier` / `▶ open_both_gates` to fire the action directly via `POST /api/esp/boards/gates_01/command`. Same pattern works for any future ESP board with `action_on` in `dps_config`.

**Rule integration** — the Balcony Smart Switch handler (above) can target gates_01 channels. Pick `Home Gates : Barrier` + action `turn_on` to bind a TS0044 button-press to `open_barrier`; the rule engine routes through `dps_config.barrier_trigger.action_on` → publishes `open_barrier` to the command topic. **Critical fix landed 2026-05-05** — `state_manager.py` now loads `dps_config` from the `devices` table on startup AND preserves it across `update_inventory()` refreshes; previously the column was unread, so every rule-fired ESP command silently logged `no mapping for action 'turn_on'` and got dropped. This was a latent bug affecting every ESP board with `action_on/off` mappings.

**Legacy compatibility** — the sketch still subscribes to the legacy `HOME_REQUEST` MQTT topic (payloads `12` = barrier, `13` = both gates) for back-compat with publishers that pre-date the esp_boards subsystem. New rules should target via `mur/home/esp/gates_01/command` (the action keys above) — same dispatch under the hood, but consistent with every other ESP board in the project.

**Panel corner-label widgets (added 2026-05-05)** — `p1b113` (over GATES button at x=160 y=62 w=62 h=28) and `p1b123` (over BARRIER button at x=395 y=62 w=62 h=28). Both `obj:label`, white `text_font:22`, right-aligned. Idle text=`""`. Driven by the `Gates Button Progress` rule (above) which writes `"N%"` while a sequence runs and `" "` (single space — NOT empty) when idle. The button widgets `p1b110`/`p1b120` deliberately **do not have `toggle:true`** — they're momentary, the corner overlay is the active-state indicator. Pulses fire on `down`/`up` events as normal; without `toggle` the panel doesn't latch the button into the lit-up @checked state which would wash out the corner text against the lighter background.

**Sketch contract for live progress** — `Process_States.ino` calls `publishEspStatusNow()` on every state-machine tick during a sequence (board → broker → rule engine → panel update, all in real time). Crucially, AFTER setting `barrier_progress = -1` / `gates_progress = -1` at sequence end, the sketch publishes ONE more time so the panel learns about idle within ~1 s — without that final publish, the corner stays at "100%" until the 60 s `espBaseLoop` heartbeat finally republishes the idle status.

**v12 — MQTT self-heal (2026-06-08).** The board went offline-but-network-OK: WiFi/ping alive, but the sketch had parked itself off MQTT forever after a single transient broker connect failure. Root cause was the `awaiting_new_mqtt_ip` latch — `loop()` guarded reconnect with `&& !awaiting_new_mqtt_ip`, and `reconnect_Mosquitto()` set that latch on ONE failure, so the board stopped retrying and waited for a manual `/set_ip` POST that never came. Fixed by mirroring the proven `RemoteXY_ESP8266_Claude` pattern: (1) `loop()` ALWAYS retries the known broker (guard removed — the latch is now informational only); (2) `reconnect_Mosquitto()` keeps a `mosq_fail_count` and only opens the `/set_ip` HTTP fallback after `MOSQ_FAIL_HTTP_THRESHOLD` (10) consecutive failures, resetting to 0 on success; keepalive stays 15 s (the bug was the non-retrying reconnect, not the keepalive). So a transient broker/WiFi blip can never park the board offline again — it self-heals the moment the broker is reachable.

**OTA-from-the-Windows-host caveat (2026-06-08) — NetBird breaks espota.** Since NetBird (LXC 108) announces `192.168.1.0/24`, the Windows dashboard host routes the whole LAN through the `wt0` tunnel (route metric 6 beats WiFi's 296), so it reaches `192.168.1.158` via the tunnel, NAT'd. espota's connect-back then fails ("No response from device" after auth OK) because the board is told an unreachable overlay IP AND the host's return path is asymmetric. The dashboard `-I` flag can't fix it (it only changes the advertised IP, not the host's route). **Workaround for a one-time OTA:** add a more-specific host route so the board is reached WiFi-direct (run as Admin): `New-NetRoute -DestinationPrefix 192.168.1.158/32 -InterfaceIndex <WiFi ifIndex> -NextHop 0.0.0.0 -RouteMetric 1` (a /32 beats NetBird's /24; NetBird won't override it; ActiveStore so it's gone on reboot). Then the dashboard OTA Push completes normally. Also watch the OTA Push **target dropdown** — it auto-syncs to the active board tab, so it's easy to accidentally target the wrong board. **Permanent cure:** exclude the dashboard-host peer from the `192.168.1.0/24` route distribution in NetBird admin so the host reaches its own LAN directly (also removes the broader hairpin/fragility — see NETBIRD/CLAUDE.md).

**OpenHASP empty-payload caveat (learned 2026-05-05)** — `mosquitto_pub -t 'hasp/<plate>/command/<obj>.text' -m ''` (empty payload) is silently ignored by the panel as "no change". To clear a label, send a single space `' '` instead. The `Gates Button Progress` rule encodes this — its idle-text constant is `" "` not `""`. Same caveat applies to any future rule that tries to clear a HASP widget's `text` property.

**Pushing pages.jsonl edits to the live panel** — the `command/jsonl` MQTT topic does NOT dynamically create new widgets on this firmware (only updates existing ones). To deploy new widgets:

1. Edit `BALCONY/pages.jsonl` (the source of truth — re-applied on every panel boot).
2. `scp` it to LXC 107 + `curl -F file=@/tmp/pages.jsonl http://192.168.1.141/edit` (panel HTTP only reachable from LXCs on the same subnet, not Windows host).
3. `mosquitto_pub -t 'hasp/balcony/command/restart' -m ''` to reboot the panel.
4. Wait ~10 s for the panel to come back. **DECO mesh occasionally rate-limits the panel's MAC after a fast reboot** (same lockout pattern as the gates_01 ESP8266 hit — REASON_AUTH_FAIL 202 in HASP serial). Recovery: power-cycle one DECO node, OR wait 15-30 min, OR power-cycle the panel itself.

For property-only changes (text_color, text_font, x/y/w/h, etc.) on **existing** widgets, use the live MQTT path instead — no reboot needed. Example: `mosquitto_pub -t 'hasp/balcony/command/p1b113.text_color' -m '#ffffff'`. Always update `pages.jsonl` in parallel so the changes survive the next reboot.

## Panel as a rule-targetable device (added 2026-05-05)

The `hasp:balcony` device row carries `dps_config` declaring two controllable channels — same `action_on`/`action_off` alias pattern ESP boards use, dispatched by the rule engine HASP branch:

| Channel | Type | `action_on` alias | `action_off` alias | Effect |
|---|---|---|---|---|
| `backlight` | toggle | `backlight_on` | `backlight_off` | publishes `hasp/balcony/command/backlight on\|off` |
| `page` | `page_select` (`min:1, max:12`) | `goto_page` | — | publishes `hasp/balcony/command/page <N>` where `<N>` = `cmd['page_num']` |

The `page` channel is special: it's a **parameterized** action, not a binary on/off. The rule engine's HASP branch reads `cmd['page_num']` when the alias resolves to `goto_page` and uses it as the publish payload.

**Picker page-select** — when a controllable channel has `dps_config.<channel>.type='page_select'`, the dashboard pickers (Balcony Smart Switch, Wallmote bindings, rule-sentence `+Dev` chips) render a **page-number dropdown** (1..max) instead of the usual toggle/turn_on/turn_off action dropdown. Selecting a number stores `{action:'turn_on', page_num:N, channel:'page'}` on the binding (or for sentence chips, inserts token `@Balcony Control Panel Page N`). Three pickers wired:
- `BOILER/dashboard/public/js/balcony.js` (Smart Switch)
- `BOILER/dashboard/public/js/living-room.js` (Wallmote)
- `BOILER/dashboard/public/js/device-picker.js` (Main Agent rule sentences) — version `?v=8`

**Sentence chip token format** — recognized by the shared parser at [`RULES/_display_chips.py`](../RULES/_display_chips.py) (extended 2026-05-05 from display-only to display+panel):
- `@<PanelName> on` → backlight on
- `@<PanelName> off` → backlight off
- `@<PanelName> Page <N>` → goto page N (case-insensitive `page` / `Page`)

Any rule using `parse_display_chip()` automatically supports panel chips. Currently consumed by `Evening Lights` (will route page chips through HASP dispatch on next sentence containing them).

**Fallback for legacy/null-channel bindings** — when a binding has `channel: null` (older pickers stored this), the rule engine HASP and Awtrix branches scan `dps_config.values()` for the first matching `action_on` / `action_off` alias. **Skips parameter-needing aliases** (e.g. `goto_page`) when the cmd lacks the parameter (`page_num`), so an on/off binding doesn't accidentally fall through to a page-navigation path.

## Direct Tuya local DPS write (added 2026-05-26)

New system-wide endpoint `POST /api/devices/:id/dps` for writing arbitrary Tuya local DPS values without going through Home Assistant. Built for the Star Projector tab but reusable by any future surface that needs device-specific DPS keys (mode/scene/HSV/vendor-extension) that aren't exposed as HA entities.

| Layer | Path | What it does |
|---|---|---|
| Dashboard endpoint | `BOILER/dashboard/server.js` `POST /api/devices/:id/dps` | Validates body `{dps: {...}}` is a non-empty object + the device's `protocol='local'`, then publishes `{action:'set_dps', dps, rule:'dashboard'}` to `mur/home/device/<id>/command`. 400 for any other protocol — the endpoint is deliberately scoped to local Tuya. |
| Device-agent action | `DEVICE/agent/device_agent.py::_handle_command` `action == 'set_dps'` branch | Resolves `self.adapters.get('tuya')` (the LOCAL adapter — keyed under just `'tuya'`, NOT `'tuya:local'` — see grouping in `_start_adapters`) and calls `tuya_local.set_state(device_id, dps)`. Replies to `mur/home/device/<id>/command/response` with `{ok, dps, rule}`. |
| Adapter | `DEVICE/agent/adapters/tuya.py::set_state` (already existed) | Opens a fresh `tinytuya.Device` to the IP, calls `set_multiple_values(dps)`, returns success bool. |

Caveat that bit during dev: the `protocol='cloud'` and `protocol='gateway'` adapters are keyed `tuya:cloud` and `tuya:push` respectively, but the LOCAL adapter has no suffix — its key is just `'tuya'`. Looking up `self.adapters.get('tuya:local')` silently returns None, and the early-return swallows the failure with no diagnostic. Pattern: always check the actual adapter-registration key in `journalctl -u device-agent --since 5m | grep "Started.*adapter"` before assuming a key.

Future callers (other tabs, future agents) should hit this endpoint instead of writing their own MQTT publish path — keeps the validation + publish wrapping + response routing in one place.

### Rule control — on/off from rules + scenes (Layer 1, added 2026-06-09)

The projector is `protocol='local'` and NOT mirrored in HA, so a rule emitting `turn_on`/`turn_off` would fail (those resolve through an HA entity the device-agent can't find). Layer 1 makes it rule-addressable for **power on/off** by reusing the `set_dps` path above:

- The device's `dps_config` declares a raw DPS payload per channel: `{"power": {"name":"Power", "dps_on":{"20":true}, "dps_off":{"20":false}}}` (DB-only, not git).
- `rule_engine._dispatch_command` default branch calls `_resolve_local_dps(dev, cmd)`: for `turn_on`/`turn_off` it looks up `dps_config.<channel>.dps_on/dps_off` (cmd's `channel` first, else the first channel that declares one) and **rewrites the command to `{action:'set_dps', dps:{...}}`** — same device-agent path as the dashboard. Devices without `dps_on`/`dps_off` keep the old pass-through (no regression).
- The shared `device-picker.js` renders `[on]/[off]` for any `dps_on`/`dps_off` channel (token `@Star Projector on`/`off`), so the projector is selectable in **scenes** + rule sentences. It's used in the *Away Devices Off* (off) and *Evening Lights* (on) scenes, and runnable via the Scenes-tab ▶ Run button / Start Away Mode.

**Layer 2 (pending) — richer DPS from rules:** mode (DPS 21) / brightness (22) / colour HSV (24) / scene (25). The plan is named "looks" (saved DPS snapshots like Pixoo presets) surfaced as `@Star Projector <LookName>` chips → dispatched as `set_dps`. Not built yet — Layer 1 covers power on/off only.

### API endpoints (panel-scoped CRUD; `:panel = balcony` for now)

| Endpoint | Purpose |
|---|---|
| `GET /api/hasp/:panel/buttons` | list `hasp_buttons` rows |
| `PATCH /api/hasp/:panel/buttons/:id` | update `event` / `action_type` / `action_target` / `action_payload` |
| `POST /api/hasp/:panel/buttons/:id/test` | direct dispatch — test a binding without going through rule engine |
| `GET /api/hasp/:panel/displays` | list `hasp_displays` rows |
| `POST /api/hasp/:panel/displays` | create a new display row |
| `PATCH /api/hasp/:panel/displays/:id` | update display fields |
| `DELETE /api/hasp/:panel/displays/:id` | delete |
| `POST /api/hasp/:panel/sync` | pull pages.jsonl + upsert + delete stale + save to repo |

## Hardware

| Field | Value |
|---|---|
| **Model** | Sunton ESP32-S3 4848S040 |
| **MCU** | ESP32-S3-N16R8 (16 MB Flash, 8 MB PSRAM, dual-core 240 MHz) |
| **Display** | 4.0" IPS RGB LCD, 480 × 480, ST7701 driver via parallel RGB |
| **Touch** | GT911 capacitive multi-touch |
| **Audio** | Speaker amplifier present on board, but NOT compiled into the OpenHASP firmware on this device — no click sounds available |
| **Storage** | LittleFS in flash (~24 KB used of much larger partition) |
| **Power** | USB-C 5 V |

## Network + identity

| Field | Value |
|---|---|
| Plate name (mqtt) | `balcony` (renamed from default `plate01` on 2026-04-30) |
| IP | `192.168.1.141` |
| MAC | `8c:bf:ea:0d:c3:24` |
| Hostname | `balcony` |
| Web UI | http://192.168.1.141 |
| Telnet console | port 23 (debug + manual HASP commands) |

## Firmware

| Field | Value |
|---|---|
| **Stack** | OpenHASP 0.7.0-rc12 (build 2024-05-23, env `esp32-s3-4848s040_16MB`) |
| LVGL theme | 2 (Material) — drives `@checked` accent via `color2` |
| `color1` | `#00b6ff` (cyan, used by nav row + accents) |
| `color2` | `#ff9962` (orange, the theme's `@checked` accent — appears on every toggled-on button) |
| GIF support | NOT compiled in (`obj":"gif"` returns `Failed to create object`) |
| Image rendering | Static images only via `obj":"img"`, requires LVGL native binary RGB565 — standard PNG/JPG/GIF do not render |

## MQTT topology

Broker: `192.168.1.189:1883` (LXC 107 mosquitto). Authenticated as user `hasp` (password in `BOILER/dashboard/.env` → `MQTT_HASP_PASS`).

Topic prefix: `hasp/balcony/`

| Direction | Topic pattern | Purpose |
|---|---|---|
| ← from panel | `hasp/balcony/LWT` | online/offline last will |
| ← from panel | `hasp/balcony/state/statusupdate` | full device info on every `command/statusupdate` request (NOT auto-pushed; does NOT include the backlight state on this firmware) |
| ← from panel | `hasp/balcony/state/backlight` | published on every backlight change as `{"state":"on"\|"off","brightness":<0-255>}`. **This is the only authoritative source for power state** on firmware 0.7.0-rc12 — `statusupdate` does not carry backlight/dim fields. |
| ← from panel | `hasp/balcony/state/sensors` | uptime, internal sensors |
| ← from panel | `hasp/balcony/state/p<page>b<id>` | button events `{"event":"down"}`/`up`/`{"val":1}` |
| ← from panel | `hasp/discovery/<mac>` | auto-discovery payload (one-shot on connect) |
| → to panel | `hasp/balcony/command/<HASP cmd>` | run any HASP cmd (e.g. `page 12`, `clearpage 1`, `restart`) |
| → to panel | `hasp/balcony/command/jsonl` | runtime add/replace an object on a page |
| → to panel | `hasp/balcony/command/p<page>b<id>.<prop>` | mutate a single property (e.g. `p1b110.val=1` toggles button) |

The `hasp` MQTT user has `readwrite` on `hasp/#`, so the rule engine on LXC 105 (subscribed as `rule_engine`) and any future per-room agent can both observe events and command the panel.

## Current page layout (post 2026-05-01 redesign)

12 pages total. Pages 0 and 1 are the only ones we re-skinned; pages 2-9 are the user's original design (lights, watering, temperatures, music, parking, glide, clock).

| Page | Content |
|---|---|
| 0 (global) | Background `#111` + nav row at the bottom — appears on every page. The nav has `<` / 🏠 / `>` icons — the design's only constants. |
| **1 (re-skinned 2026-05-01)** | **4 toggle buttons** in 2 × 2 grid: **GATES** (id 110, dim navy), **BARRIER** (id 120, dim purple), **LIGHT 1** (id 130, dim green), **LIGHT 2** (id 140, dim amber). Each button is a `btn` with overlaid `label` for the icon (font 48) and another `label` for the name (font 24). Both labels carry `click:false` so taps fall through to the underlying button — without that, clicks were being intercepted and toggling required several taps. The `@checked` bg flashes orange uniformly (theme `color2` driven; per-button `bg_color@checked` is overridden by the theme). |
| 2 | Saloon Area / Balcony Area lights (original design) |
| **3 (media redesign 2026-06-21)** | **Temperatures** — out / in / humidity / illum / wind. **MOVED here from page 4** (its old Watering content was discarded). The two live temperature displays followed: `hasp_displays` id 62 → `p3b1` (out temp), id 65 → `p3b4` (in temp), `page` re-pointed 4→3 so they keep updating. |
| **4 (media redesign 2026-06-21)** | **Media CONTROL** — 8 `btn` widgets (4 rows × 2) targeting the Balcony TV `tv55`: **TV On** (id 110) / **TV Off** (120) / **Vol −** (170) / **Vol +** (180) / **Pause** (130) / **Stop** (140) / **Prev** (150) / **Next** (160). Fixed `type:'media'` bindings (not user-editable). Vol −/+ step by **±10%** (see `volume_step` below), not HA's tiny default. |
| **5 (media redesign 2026-06-21)** | **Media SELECTION** — 8 `btn` widgets in 2 columns: **Playlist 1–4** (ids 110/120/130/140, left) + **Video 1–4** (150/160/170/180, right). Bindings start empty; the user assigns one playlist OR one video per button via the dashboard **Media Buttons** card. |
| 6 | Parking distance: Cal / Dist / Pos / Close (original) |
| 7 | Glide ticker (original) |
| 8 | Clock placeholder (`--:--`) (original — empty target for future content) |
| 9 | Almost-empty (original — empty target for future content) |
| 10, 11, 12 | Completely empty (free for future use) |

### Page 1 vertical layout (current 4 buttons)

```
y=0   ── (top of screen)
                     ↕ 50 px margin
y=50  ┌─ GATES ──────┐ ┌─ BARRIER ────┐
       │   icon       │ │   icon       │   each h=140
       │   GATES      │ │   BARRIER    │
y=190 └──────────────┘ └──────────────┘
                     ↕ 30 px gap
y=220 ┌─ LIGHT 1 ────┐ ┌─ LIGHT 2 ────┐
       │   icon       │ │   icon       │   each h=140
       │   LIGHT 1    │ │   LIGHT 2    │
y=360 └──────────────┘ └──────────────┘
                     ↕ 50 px margin
y=410 ── (top of nav row from page 0)
```

Per cell (top-left as the example, x=10..235):

| Object | id | x | y | w | h | font | role |
|---|---|---|---|---|---|---|---|
| `btn` | 110 | 10 | 50 | 225 | 140 | — | toggle, owns bg color |
| `label` (icon) | 111 | 10 | 65 | 225 | 60 | 48 | car glyph U+E10B (white, click:false) |
| `label` (name) | 112 | 10 | 135 | 225 | 40 | 24 | "GATES" (white, click:false) |

Same shape for `120/121/122 BARRIER`, `130/131/132 LIGHT 1`, `140/141/142 LIGHT 2`.

## Files in this folder

| File | Role |
|---|---|
| `pages.jsonl` | Mirror of `/pages.jsonl` on the device (downloaded from `http://192.168.1.141/pages.jsonl`). Source of truth for the panel's current design — version-controlled here. |
| `pages_backup.jsonl` | The original 8-button page-1 design + all of pages 2-9, captured 2026-05-01 before we re-skinned page 1. Use to revert if needed. |
| `build_pages.py` | Regenerates `pages_new.jsonl` from `pages_backup.jsonl` with the current 4-button design on page 1. Used when re-deploying the panel; uploads via `POST /edit` then `POST /reboot`. |

## DB rows for this panel

| Table | Row(s) |
|---|---|
| `hasp_panels` | 1 row, `name='balcony'`, IP `192.168.1.141`, mac `8c:bf:ea:0d:c3:24` (seeded by `server.js ensureSchema()` 2026-05-01) |
| `hasp_buttons` | 4 rows for page 1: GATES (110), BARRIER (120), LIGHT 1 (130), LIGHT 2 (140). `action_type` and `action_target` are NULL — wired in a later phase. |
| `hasp_displays` | 0 rows yet — value displays will be added when we drive live data onto the panel. |

## Planned Future Features

- **Button → device wiring** — fill in `hasp_buttons.action_type` + `action_target` for the 4 page-1 buttons (Gates, Barrier, Light 1, Light 2) and a rule in `RULES/rules/` (group=`balcony`) that dispatches them.
- **Live value displays** — populate `hasp_displays` rows; rule pushes substituted text via MQTT to label objects on the panel (same `{{var}}` template engine pattern as Pixoo presets).
- **Page editor in the dashboard Panel tab** — read/write `pages.jsonl` from the browser instead of `BALCONY/build_pages.py`.
- **Multi-panel scaling** — when a 2nd panel is added in another room (e.g. kitchen), scaffold a peer agent (`/create-agent` → `Kitchen Agent` → `KITCHEN/`) that reuses the shared HASP DB tables.

## Extending the Agent

To add a service layer later (if a balcony-specific Python loop is ever needed): run `/create-agent Edit` → "add service layer". The skill generates `BALCONY/agent/balcony-agent.service` + env file + orphan guard, updates the `agents` row, and converts the file-locations table to include the service.
