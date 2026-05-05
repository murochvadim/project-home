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
| _none yet_ | — | — |

Future keys land here as features ship (e.g. `balcony.button_actions` for HASP button → device wiring once it moves out of `hasp_buttons.action_*` columns, or `balcony.rule_sentences` if sentence-based rule authoring is added like Living Room).

System-wide HASP tables (`hasp_panels`, `hasp_buttons`, `hasp_displays`) hold panel-level state — those are deliberately NOT under `balcony.*` because they're shared across every room HASP agent. Balcony's rows in those tables are seeded by `server.js ensureSchema()`.

## Rules (group=`balcony`)

| Rule | File | Trigger | Purpose |
|------|------|---------|---------|
| Balcony Buttons | `RULES/rules/balcony_buttons.py` | `*` (early-return on `hasp:balcony:` device-id prefix) | On every panel button press, look up the matching `hasp_buttons` row (keyed on `(page, button_id, event)`) and dispatch every binding in its `bindings` JSONB array (multi-device per press, wallmote-parity since 2026-05-01). Each binding shape `{device_id, channel, name, label, action}` for device, or `{type:'hasp_command'\|'pixoo_preset', target}` for non-device. Toggle resolved client-side from `state.devices[id].dps[channel]`. 1 s cooldown per (page, button, event) collapses HASP's down+up triple into one fire. Sets `_skip_loop_guard=True` on emitted commands so rapid intentional presses don't trip the same-action-4-in-10s loop guard in `rule_engine._dispatch_command`. |
| Balcony Displays | `RULES/rules/balcony_displays.py` | `heartbeat` (60 s) | Iterate `hasp_displays` rows, resolve each row's source, render `format_string`, publish to `hasp/balcony/command/p<page>b<label_id>.<target_property>`. Two source kinds (since 2026-05-01): `state.shared` keys (`source_value='boiler_temp'`) and **device sensors** (`source_value='device:<device_id>:<dps_key>'`, e.g. `device:b0f9c460-…:temperature` reads `state.devices[id].dps['temperature']`). Format string supports `{{val}}` (the resolved source) and `{{<key>}}` (any state.shared key, for legacy multi-key templates). Per-row `refresh_sec` honored. **Float values are rounded to 1 decimal in `_fmt()`** (added 2026-05-03) so micro sensor-noise (e.g. `21.039999961853 → 21.040001869202`) doesn't blow past the dedupe and trigger spurious publishes. Dedupe against `last_value` — but **force-republish** every 10 minutes regardless of dedupe (added 2026-05-03) so a panel that reboots after a stable value (e.g. temperature held steady for hours) re-receives the value within ≤ 10 min instead of being stuck on the default text. **SELECT filters out empty `source_value` rows** at the DB layer (rule was processing all 67 placeholder rows on every heartbeat, ≈ 100 ms; now only the actually-configured rows are touched). |
| Balcony Button Mirror | `RULES/rules/balcony_button_mirror.py` | `*` (early-return on devices referenced by `bindings[0]` of any balcony button) | Output complement of `balcony_buttons`: when the bound device's state changes from ANY source (HA dashboard, mobile app, manual switch, our own command), publish `hasp/balcony/command/p<page>b<button_id>.val=0\|1` so the panel button's @checked tint stays in sync. Mirrors `bindings[0]`'s state when a button has multi-device bindings — first device wins (user puts the representative device first if they have a multi-device button). depends_on: `["Balcony Buttons"]`. ~2 s end-to-end latency. |
| Balcony Smart Switch Handler | `RULES/rules/balcony_smart_switch_handler.py` | specific id `["0x8c65a3fffeb139ae"]` (Tuya TS0044 wireless 4-button scene remote, Z2M friendly name `Balcony Smart Switch`) | Added 2026-05-03. Parses `dps['action']` matching `^(\d+)_(single\|double\|hold)$` → looks up `dashboard_settings.balcony.smart_switch_bindings` slot `btn<N>:<event>` → emits one command per binding (multi-device supported). Toggle resolved client-side. `_skip_loop_guard=True` for rapid presses. **Single only on the dashboard UI** (decided 2026-05-03 after live testing): `_hold` never fires on this MOES TS0044 firmware variant; `_double` works but creates visible on→off flicker when both single+double are bound on the same button (device emits both on a real double-click). A 500 ms single-debounce was prototyped to suppress the flicker but introduced sluggish latency on every press; user reverted. Per-binding action picks `toggle` / `turn_on` / `turn_off`. Bindings cached 30 s. |
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

Same shape as `dashboard_settings.living-room.wallmote_bindings` slot entries, plus rare non-device variants `{type:'hasp_command', target:'page 2'}` and `{type:'pixoo_preset', target:'<name>', vars:{...}}`. The legacy `action_type` / `action_target` / `action_payload` columns are retained but no longer read by code (preserved for rollback safety).

### How HASP button events reach the rule engine

The engine subscribes to `hasp/+/state/+` (already present on every plate). For object IDs matching `^p\d+b\d+$` (button widgets), it synthesizes a device_id `hasp:<plate>:<obj>` (e.g. `hasp:balcony:p1b110`) so rules can target the panel widget directly without registering each button as a separate device. Payload `{event:'short'|'long'|'down'|'up'|'double'}` is passed through as `dps`.

The panel ITSELF is registered as a single device row (`id='hasp:balcony', name='balcony', protocol='hasp'`) so the rule engine's existing `protocol='hasp'` dispatch path resolves and publishes commands to `hasp/balcony/command/<path>` — same shape Pixoo uses.

## Dashboard Page

Path: `/balcony.html` (served by the Windows dashboard). Sidebar link under "Agents" section, after Living Room Agent.

### Tabs

- **Panel** — five cards (top to bottom):
  - **OpenHASP Touch Panel** — static info: hardware (Sunton ESP32-S3 4848S040), IP `192.168.1.141`, MQTT prefix `hasp/balcony/`, web-UI link.
  - **HASP Balcony status** — live MQTT-over-WebSocket connection (browser → broker port 9001 as `dashboard_browser`), shows `● connected/offline` from LWT, uptime / signal / current page from `hasp/balcony/state/statusupdate`. Required ACL on LXC 107: `read hasp/balcony/state/#` + `read hasp/balcony/LWT`.
  - **Sync from panel** — POST `/api/hasp/balcony/sync` fetches the panel's current `pages.jsonl` over HTTP, parses every widget, upserts rows in `hasp_buttons` / `hasp_displays`, deletes unconfigured-stale rows whose widgets no longer exist, and saves the jsonl back to `BALCONY/pages.jsonl` for git history. Filters: skips `page=0` (OpenHASP global/nav layer) and label widgets whose text is purely a private-use codepoint glyph (E000–F8FF — they're icons, not data displays). User-configured rows (`action_type` set on a button / `format_string` set on a display) are preserved across syncs even if the widget is removed from the panel.
  - **Button Bindings** — table of `hasp_buttons` rows for the panel. Per row: event (`up` / `down` / `short` / `long` / `double` — note: panel only emits `up` / `down` by default, the rest need per-button config in pages.jsonl), action_type (`device` / `hasp_command` / `pixoo_preset`), target picker (device dropdown for `device`, free text for `hasp_command`, preset dropdown for `pixoo_preset`), payload (action `toggle` / `on` / `off` plus protocol-aware channel dropdown for `device`). Save All persists; Test fires the binding directly via `/api/hasp/balcony/buttons/:id/test` (HTTP path; bypasses the rule engine for fast wiring verification). Channel dropdown auto-populates from the target device's `dps_labels` / `channel_config` — Zigbee multi-gang shows `state_l1`/`state_l2`/…, Tuya shows numeric `1`/`2`/`3`. Legacy values not in the dropdown surface as red `(legacy)` options so they're easy to spot and replace.
  - **Display Templates** — list of `hasp_displays` rows. Per row: page, label_id, display_type (`text` / `gauge` / `series` / `bar`), target_property (`text` / `val` / `bg_color` / `text_color`), **Source picker** (single dropdown with two `<optgroup>`s — `state.shared keys` and `Device sensors`; selecting a device sensor option auto-fills `source_value='device:<id>:<key>'` and sets `source_type='device'`), format string (`{{val}}` for the resolved source, `{{<key>}}` for any state.shared key — supports multi-key templates like `B {{boiler_temp}} / P {{panel_temp}}`), refresh seconds, description. Live preview resolves the chosen source the same way the rule does (10 s device-list cache). Filters: `Show: only configured` (default) hides empty placeholder rows; switch to `all` to bind a panel widget. Limit: `10` / `20` / `50` / `all`. ▾ collapse toggle to fold the whole card. Save refreshes the list so the filter immediately reflects persisted values.

- **Balcony Smart Switch** (added 2026-05-03) — bindings UI for the Tuya TS0044 4-button wireless scene remote (Z2M friendly name `Balcony Smart Switch`, IEEE `0x8c65a3fffeb139ae`, room=`Balcony`). Single card per button (4 cards × 1 row each — single only; see rule docs above for why hold/double aren't surfaced). Each row has a multi-device picker chip + per-device action dropdown (`toggle` / `turn_on` / `turn_off`). Multi-device per slot supported (one press fires all bound commands at once). Storage: `dashboard_settings.balcony.smart_switch_bindings` (mirrors the `living-room.wallmote_bindings` pattern from `living-room.js`). The picker reuses the same overlay as the HASP Button Bindings card via wrapper handlers `bcClosePicker` / `bcFilterPicker` that route to the smart-switch state when `_swPickerActive` is set. Lazy-loaded on first tab activation. Save All replaces the entire JSONB value — old `:double` / `:hold` keys from earlier UI experiments get dropped on the first save. **ESP boards are pickable as targets** since 2026-05-05 — `CONTROLLABLE_TYPES` includes `esp_board` and the picker enumerates each board's `dps_config` channels that have `action_on` (e.g. `gates_01` exposes `barrier_trigger` + `gates_trigger`). The action dropdown's `turn_on` / `turn_off` map per-channel to sketch keys via `dps_config.<channel>.action_on/action_off` in the rule engine — pulse-only triggers (gates) only meaningful with `turn_on` since they have no `action_off`. `toggle` resolves to `turn_on` when the channel has no current state in `last_state`.

## Home Gates board (gates_01) — building garage gate + barrier controller

ESP32 Dev Module at IP `192.168.1.158`, MAC `B0:CB:D8:CA:16:7C`, room `Balcony` (the controller's physical location, not the gates themselves which are downstairs at the building entrance). Sketch lives at `BALCONY/sketch/Home_Gates_Device_ver11/` (mirrored from `Arduino_Projects/Home_Gates_Device_ver11/` for git tracking; Arduino IDE compiles from the latter). Migrated from ESP8266 → ESP32 on 2026-05-05 because the ESP8266 board's MAC was stuck in REASON_AUTH_FAIL on the DECO mesh after a flash storm.

**Hardware**: Relay_1 (GPIO 12 — gate motor), Relay_2 (GPIO 13 — barrier), Buzzer (GPIO 14 — beep on each request). GPIO 12 is a strapping pin on ESP32; if the dev module won't boot with the relay attached high, swap to a non-strapping GPIO.

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

**OpenHASP empty-payload caveat (learned 2026-05-05)** — `mosquitto_pub -t 'hasp/<plate>/command/<obj>.text' -m ''` (empty payload) is silently ignored by the panel as "no change". To clear a label, send a single space `' '` instead. The `Gates Button Progress` rule encodes this — its idle-text constant is `" "` not `""`. Same caveat applies to any future rule that tries to clear a HASP widget's `text` property.

**Pushing pages.jsonl edits to the live panel** — the `command/jsonl` MQTT topic does NOT dynamically create new widgets on this firmware (only updates existing ones). To deploy new widgets:

1. Edit `BALCONY/pages.jsonl` (the source of truth — re-applied on every panel boot).
2. `scp` it to LXC 107 + `curl -F file=@/tmp/pages.jsonl http://192.168.1.141/edit` (panel HTTP only reachable from LXCs on the same subnet, not Windows host).
3. `mosquitto_pub -t 'hasp/balcony/command/restart' -m ''` to reboot the panel.
4. Wait ~10 s for the panel to come back. **DECO mesh occasionally rate-limits the panel's MAC after a fast reboot** (same lockout pattern as the gates_01 ESP8266 hit — REASON_AUTH_FAIL 202 in HASP serial). Recovery: power-cycle one DECO node, OR wait 15-30 min, OR power-cycle the panel itself.

For property-only changes (text_color, text_font, x/y/w/h, etc.) on **existing** widgets, use the live MQTT path instead — no reboot needed. Example: `mosquitto_pub -t 'hasp/balcony/command/p1b113.text_color' -m '#ffffff'`. Always update `pages.jsonl` in parallel so the changes survive the next reboot.

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
| ← from panel | `hasp/balcony/state/statusupdate` | full device info (every ~10 s) |
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
| 3 | Watering 1 / Watering 2 / … (original) |
| 4 | Temperatures: out / in / humidity (original) |
| 5 | Music: slider + rec/play (original) |
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
