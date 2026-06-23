# My BathRoom Agent

Per-room agent for My BathRoom — touch panel, smart switch, smell pump, and bathroom-area devices.

Dashboard-only agent (no dedicated LXC service). Sibling of [Balcony Agent](../BALCONY/CLAUDE.md) — same shape and rule-pattern, fully isolated DB rows / MQTT topics / rule files. UI is hosted by the Windows dashboard; rule logic on LXC 105.

## Hardware

| Component | Spec |
|---|---|
| Touch panel | Sunton ESP32-S3 4848S040 · 480×480 IPS · OpenHASP 0.7.0-rc12 |
| Panel IP | `192.168.1.220` |
| Panel MAC | `8c:bf:ea:0d:bb:e8` |
| Plate name | `my-bathroom` |
| MQTT topic prefix | `hasp/my-bathroom/` |
| MQTT broker | LXC 107 (`192.168.1.189`) as user `hasp` |
| Smart switch (TS0044 wireless scene remote) | not yet paired — placeholder device id in the rule |

## File Locations

| Artifact | Path |
|----------|------|
| Dashboard page | [BOILER/dashboard/public/my-bathroom.html](../BOILER/dashboard/public/my-bathroom.html) |
| Dashboard JS | [BOILER/dashboard/public/js/my-bathroom.js](../BOILER/dashboard/public/js/my-bathroom.js) |
| Panel page layout (version-controlled) | [pages.jsonl](pages.jsonl) — pulled from the panel via `Sync from panel` button |
| Rule files | 8 total — 7 in group `my-bathroom` (`RULES/rules/my_bathroom_*.py` ×4 + `mybathroom.py` Lights + `mybathroom_panel_color.py` + `mybathroom_panel_alexa.py`) + 1 in `my-bathroom-bindings` (`mybathroom_panel_buttons.py`), see below |
| DB agent row | `agents` table, `name = 'my-bathroom'` |
| DB panel row | `hasp_panels` table, `name = 'my-bathroom'` |
| DB device row (rule-target alias) | `devices.hasp:my-bathroom` |
| DB setup migration | [migrations/setup.sql](migrations/setup.sql) (agent row) + [migrations/002_panel.sql](migrations/002_panel.sql) (panel + device rows) |
| Config storage | `dashboard_settings.my-bathroom.*` |
| Memory | [memory/project_agent_my-bathroom.md](../../.claude/projects/c--Users-muroc-project-home/memory/project_agent_my-bathroom.md) |

## Dashboard Tabs

- **Panel** — full Balcony-equivalent UI (info card / status card / sync from panel / button bindings (wallmote-style picker) / display templates). **Power chip + On/Off button highlight (added 2026-05-26)** matches the Balcony pattern — state source is `hasp/my-bathroom/state/backlight` (`{state:"on"|"off", brightness:<n>}`), since OpenHASP 0.7.0-rc12's `statusupdate` JSON does NOT include the backlight field. Cached to `localStorage['my-bathroom.hp.power']` for persistence across page navigations. See [BALCONY/CLAUDE.md](../BALCONY/CLAUDE.md) for the full pattern reference.
- **Smart Switch** — Balcony-equivalent wallmote-style binding UI for the TS0044 scene remote (single-press only, hold doesn't fire on this firmware variant). Empty until hardware is paired.
- **Lights Plate** (added 2026-06-22) — second OpenHASP plate `mybathroom-panel` @ `192.168.1.206` (MAC `8c:bf:ea:0c:29:e0`, MQTT prefix `hasp/mybathroom-panel/`, registered in `hasp_panels` id 456), which **physically replaces the failed "My Bathroom Switch"** (`57317771ecfabcbd3d24`) — the plate has **built-in relays**: page-1 button `p1b10` → GPIO 1 / grp 1 = **Laundry Light**, `p1b20` → GPIO 2 / grp 2 = **My Bathroom Light**. Full feature parity with the Panel tab (info / status+power+page / sync / button bindings / display templates) PLUS a **Lights card** with On/Off per relay (publishes `hasp/mybathroom-panel/command/output<pin> {"state":"on"|"off"}` — the documented OpenHASP GPIO relay path, confirmed working 2026-06-22; the JSON `{"state":…}` payload is required, a bare `1` does not drive the relay). **Third row — My Bathroom Under Cabinet Light (dashboard-only, 2026-06-23):** the Lights card also has an On/Off row for the **My Bathroom Under Cabinet Light** (`85faa01c-d378-43f8-a5dd-020a528121e5`, a **Z-Wave switch**, NOT a plate relay). Buttons toggle it via the dashboard's proven `POST /api/devices/:id/toggle` (zwave → SmartThings identifier → HA `switch.turn_on/off`); no rule, no plate GPIO. **Live status pill** subscribes to the device-agent's **retained** `mur/home/device/<id>/state` topic (`{dps:{light:bool},…}`) over the panel's existing MQTT WS (`dashboard_browser` has `read mur/home/device/+/state`) — retained → current value paints on tab-open, and every later change republishes, so the pill tracks **rule-driven** changes live, exactly like the plate-relay pills (no polling). `np-uc-*` ids; `NP_UC_ID` + `npRenderUC`/`npUnderCabinet`/`npLoadUC` in `mybathroom-panel.js`. Implemented as a self-contained controller [`js/mybathroom-panel.js`](../BOILER/dashboard/public/js/mybathroom-panel.js) — a scripted, namespaced (`np*`/`nb*`, own picker overlay `#nbk-*`, own MQTT client) clone of the Panel-tab logic in `my-bathroom.js`, so the two plates coexist on one page with zero shared-state collision. Server.js untouched (reuses the generic `/api/hasp/:panel/*` endpoints). Plate `pages.jsonl` in [MY_BATHROOM_PANEL/pages.jsonl](../MY_BATHROOM_PANEL/pages.jsonl) (page 0 nav row ◀🏠▶ matching the other plates; page 1 = the 2 relay buttons). **Done 2026-06-22:** the My Bathroom Lights + Laundry Light motion rules were re-targeted to this plate's relays (`p1b20` / `p1b10`) — see the rule notes below. **Page 2 — My Bathroom Color (2026-06-23):** a colour-control page for the **My Bathroom Color** RGBCW light (`80578725d8bfc003b2a0`) — on/off toggle (p2b10) + dim slider (p2b20) + colour picker `cpicker` (p2b30) + White/Colour mode (p2b40/41). Driven by rule `RULES/rules/mybathroom_panel_color.py` (+ actuator `RULES/_color_light.py`). **Control is HA-mediated** (`light.my_bath_color`) via the engine's new `_dispatch_ha_light` — NOT local Tuya: this light's local TCP write listener is unreliable (sleeps / drops `set_dps`; validated 2026-06-23 — local DP20/DP1 writes never turned it on, HA did). Gotchas learned: OpenHASP icon escapes (nav ◀/🏠/▶) must be **UPPERCASE** `\uXXXX` (lowercase doesn't render on fw 0.7.0-rc12); `cpicker` must be **square** (w==h) else it renders an oval, and it emits H/S/V directly (= HA `hs_color`); `slider` emits `{event:'up','val':N}` (act on `up` only). See [[project-mybathroom-color-panel]]. **Page 3 — Alexa My Bathroom sound control (2026-06-23):** 6 assignable Media buttons (p3b10–15, play a saved station) + Play/Stop/Pause (p3b20–22) + volume slider (p3b30), targeting `media_player.alexa_my_bathroom`. **Sound-only** (no announce/say). Rule `RULES/rules/mybathroom_panel_alexa.py` → the engine's **existing** `_dispatch_alexa` (NO engine change): media button → `play_station` (the station name assigned per button in `dashboard_settings.my-bathroom.alexa_media_buttons`, resolved against `media-agents.alexa_quick_music` at fire-time); transport → `media_play/stop/pause`; slider → `volume_set`. A **Media Buttons card** on the Lights Panel tab (`mybathroom-panel.js` `nbLoadMediaButtons`/`nbSetMediaButton`) assigns a station per button (auto-save). Validated 2026-06-23: play/stop/pause/volume work; Echo `turn_on/off` + next/prev are no-ops (dropped). Alexa can only play its own cloud services (Amazon Music/Spotify/TuneIn) — NOT the local Player-Agent QNAP playlists (those cast only to TVs/soundbar). **Button Bindings cleanup (same day):** `'slider'` removed from server.js `_HASP_BUTTON_OBJS` (sliders were polluting `hasp_buttons` + the Button Bindings card as mislabeled rows) + the 2 stray slider rows deleted + the card now groups by page. **Button Bindings functional + additive (2026-06-23):** `RULES/rules/mybathroom_panel_buttons.py` (clone of `my_bathroom_buttons.py` scoped to `mybathroom-panel`) reads the card's `hasp_buttons.bindings` and dispatches them (device toggle/on/off, alexa/vacuum via `_display_chips`, `hasp_command`, `pixoo_preset`). It's in its **own group `my-bathroom-bindings`** (NOT `my-bathroom`) — **on purpose**: the engine's group-conflict (`_fire_rules_for_event` ~L609) makes only ONE rule per group act per event, so sharing `my-bathroom` with the dedicated Colour/Alexa page rules made a press fire EITHER the binding OR the dedicated function (the wildcard buttons rule won by priority → the Alexa rule was skipped). A distinct group keeps them **additive**: a press does its dedicated job AND its binding (e.g. Play resumes Alexa AND turns on the colour light if you bind it). **Any** button can carry a binding now (no `_RESERVED`). ⚠ Binding the card is **not auto-save** — click **Save Bindings**. See [[project-rule-group-conflict]].

## Rules (8 files: 7 in group `my-bathroom` + 1 in `my-bathroom-bindings`)

The first 4 are direct copies of the balcony equivalents with panel name + group fields swapped, SQL `WHERE p.name = 'my-bathroom'`. Fully isolated — no cross-firing. The 5th (My Bathroom Lights) is an original motion-lighting rule (priority 10 keeps it above Displays/50 so its heartbeat auto-off is never skipped by same-group competition). The 3 newest — **My Bathroom Color Panel**, **My Bathroom Alexa Panel** (both group `my-bathroom`), and **My BathRoom Lights Panel Buttons** (group `my-bathroom-bindings` — its **own** group so a plate press fires its dedicated page rule AND its Button-Bindings binding; see [[project-rule-group-conflict]]) — drive the second plate's pages and are documented in the **Lights Plate** tab note above, not the table below.

| Rule | File | Trigger | Job |
|---|---|---|---|
| My BathRoom Buttons | [`my_bathroom_buttons.py`](../RULES/rules/my_bathroom_buttons.py) | wildcard (early-return on `hasp:my-bathroom:*`) | panel button press → device commands per `hasp_buttons.bindings` |
| My BathRoom Button Mirror | [`my_bathroom_button_mirror.py`](../RULES/rules/my_bathroom_button_mirror.py) | wildcard (early-return on bound device events) | device state → panel button visuals (`p<page>b<id>.val = 0/1`) |
| My BathRoom Displays | [`my_bathroom_displays.py`](../RULES/rules/my_bathroom_displays.py) | heartbeat (60 s) | render value templates onto panel labels via `hasp_displays` rows |
| My BathRoom Smart Switch Handler | [`my_bathroom_smart_switch_handler.py`](../RULES/rules/my_bathroom_smart_switch_handler.py) | `SMART_SWITCH_ID` (placeholder until paired) | TS0044 button event → device commands per `dashboard_settings.my-bathroom.smart_switch_bindings` |
| My Bathroom Lights | [`mybathroom.py`](../RULES/rules/mybathroom.py) | presence + door + switch (mirror master) + heartbeat | motion lighting — see below |

### My Bathroom Lights (motion lighting, created 2026-06-11)

> **2026-06-22 — re-targeted to the new OpenHASP plate.** The original "My Bathroom Switch" (`57317771ecfabcbd3d24`) **died** and was physically replaced by the **`mybathroom-panel`** plate (192.168.1.206), whose page-1 buttons drive **on-board relays**: `p1b20` = My Bathroom Light, `p1b10` = Laundry Light. Two new `protocol='hasp'` device rows back these: **`hasp:mybathroom-panel:p1b20`** ("My Bathroom Light") + **`hasp:mybathroom-panel:p1b10`** ("Laundry Light"). The rule now drives the main light through `p1b20`. **Control = `command/output<pin>`:** the rule emits `{action:'set', path:'output2', value:'{"state":"on"|"off"}'}` → the engine's generic hasp command branch publishes `hasp/mybathroom-panel/command/output2 {"state":…}` (confirmed working 2026-06-22 — the light drives correctly; no engine change, no restart — `_relay_cmd()` in the rule). The rule doesn't track or read the plate's relay state the way it did the old Tuya switch — it **re-asserts the commanded output** (idempotent) on each turn-on, and the **heartbeat auto-off fires UNCONDITIONALLY for plate relays** (once per empty period, guarded by `_mybathroom_autooff_done`) — so a manual tap-on we never saw still gets cleared and the light can't be left on. **Consequence:** the **mirror (s_mbr5)** and **OFF-cascade (s_mbr6)** are now **deactivated** — they reacted to the old switch's *pushed* state, which the plate doesn't provide. Day-set already turns main + under-cabinet on together, so that pairing is preserved; only the *manual-plate-tap* side-effects are lost (Option B / polling would restore them). Verified live: post-reload the rule fired `My Bathroom Light output2={"state":"off"}` + under-cabinet off, auto-off guard fires exactly once per empty period. **The separate Laundry Light rule (`laundry_light.py`, group `laundry`) was re-targeted the same way 2026-06-22** — `s_ll1` now `@Laundry Light` (= `hasp:mybathroom-panel:p1b10`), same plate-relay helpers + unconditional auto-off. Verified live: `Laundry Light -> hasp Laundry Light output1={"state":"off"}`.

Fully **sentence-driven** — everything configurable lives in the dashboard container **"My Bathroom Lights"** (`r_mybathroom_init` in `apartment.rule_sentences`); the rule parses it itself with a 30 s TTL cache, so edits + **Reload** (or just the 30 s cache for value/sentence edits) take effect without an engine restart. Three behaviours:

1. **Motion light** — presence (`bf23d678…dd4n`, dps `1`) or door (`66ac7365…ecff`, dps `door`) trigger turns on the **day set** inside the day window, or the **night set** outside it. Day-set = main light + under-cabinet; night-set = under-cabinet only.
2. **Auto-off** — on each heartbeat, if the room is continuously clear (presence dps `1` = `none`) AND no presence/door activity for `timeout`, turn off everything that's on. The countdown starts when the room goes empty and **resets on every trigger**; the clear-gate means lights never switch off while someone is detected.
3. **Mirror** (one-way) — operating the **My Bathroom Light** (My Bathroom Switch ch `2`) drives the **Under-Cabinet** (`85faa01c…21e5`): main on → both on, main off → both off.

Sentences (all editable in Base Rule Settings → My Bathroom Lights):

| ID | Default | Drives |
|---|---|---|
| s_mbr1 | `My Bathroom Lights: day lights are @My Bathroom Light, @My Bathroom Under Cabinet Light` | day set (`@My Bathroom Light` = plate relay `hasp:mybathroom-panel:p1b20` since 2026-06-22; was `@My Bathroom Switch My Bathroom Light` on the dead switch) |
| s_mbr2 | `My Bathroom Lights: night lights are @My Bathroom Under Cabinet Light` | night set |
| s_mbr3 | `My Bathroom Lights: day window is between 06:00 and 01:00` | day window (wraps past midnight → night band 01:00–06:00) |
| s_mbr4 | `My Bathroom Lights: turn off after 10 minutes` | auto-off timeout |
| s_mbr5 | `My Bathroom Lights: mirror @My Bathroom Switch My Bathroom Light to @My Bathroom Under Cabinet Light` | mirror master → slave — **DEACTIVATED 2026-06-22** (the plate doesn't push relay state, so the rule can't see a manual tap to mirror; day-set already pairs main + under-cabinet) |
| s_mbr6 | `My Bathroom Lights: when main light off also turn off @My Bathroom Switch Laundry Light` | OFF-cascade — **DEACTIVATED 2026-06-22** (same reason as s_mbr5: no pushed state from the plate; the Laundry Light rule manages the laundry independently). Originally (2026-06-11) — main light off → also off, **immediately, no occupancy gate** (the laundry-empty gate was dropped 2026-06-12: the adjacent laundry sensor still read "presence" at the off-instant so it blocked nearly every time). **Edge-gated** via `_mybathroom_master_was_on` — fires only on a real ch2 falling edge (was-on→off), NOT on steady-state local-poll snapshots showing ch2=false (which would otherwise keep re-killing the laundry light and fight the Laundry Light rule). One-way, OFF-only. |
| s_mbr7 | `My Bathroom Lights: only fires when home_mode is home` | **Home-mode gate (2026-06-12)** — gates the TURN-ON paths only (presence / door / Run): no turn-on unless `home_mode is home`. The mirror, OFF-cascade, and auto-off all **ignore** it (manual-switch responses + cleanup run regardless of mode). AND-combined; parsed via `_GATE_RE` + `_gates_pass`, same as Evening Lights / Dressroom Lights. |

Implementation notes:
- **No flood:** turn_on only emits for currently-off targets (`_is_on` state-diff) **plus** a **3 s burst debounce** (`_ON_DEBOUNCE_SEC`) — a `turn_on` takes >1 s to reflect back into `state.devices`, so the mmWave's entry flurry would otherwise re-emit; the debounce suppresses repeats and retries after 3 s if the light still reads off.
- **Counter:** auto-off uses `now - _mybathroom_last_active_ts >= timeout`, NOT minute-equality — no anchor-miss bug. `_`-prefixed shared keys (`_mybathroom_last_active_ts`, `_mybathroom_prev_present`, `_mybathroom_last_on_emit_ts`) → don't inflate the Runs counter. Verified live: fired at `idle 620s >= 600s, room clear` → both lights off.
- **Red Run button** on the rules table (via `test_event` source `force_run` + `count_force_fires`, same path as Evening/Morning Lights) — simulates a presence trigger NOW, turns on the time-appropriate set, bumps the Runs count.
- **Trigger IDs are hardcoded** in `RULE['triggers']` (triggers bind at module load — can't be sentence-driven); they're the room's permanent sensors + the mirror-master switch + heartbeat.

## Storage Keys

`dashboard_settings.my-bathroom.*`:
- `my-bathroom.smart_switch_bindings` — populated by the Smart Switch tab once the TS0044 is paired

Future:
- `my-bathroom.scenes` — saved scene presets

## Devices in the Room (snapshot at agent creation)

| Device | Protocol | Type | Notes |
|---|---|---|---|
| `hasp:my-bathroom` (panel) | hasp | panel | Controllable from rules via `dps_config` aliases (`backlight`, `page`) |
| `My Bathroom Smell` (`My_Bathroom_Smell_Claude`) | esp | esp_board | Pump + auto-mode controllable from rules via `dps_config.auto_enabled.action_on='smell_auto_start'`. Renamed from `My_Bathroom_Smell_6` 2026-05-23 (sketch + device_id + DB row). |
| `My Bathroom Door` | zwave | door_sensor | Aeotec; battery 42% |
| `My Bathroom Damper` | local (Tuya) | circuit_breaker | |
| `Smart Toilet AC breaker` | local (Tuya) | circuit_breaker | |
| `My Bathroom Color` | local (Tuya) | light | |
| `My Bathroom Under Cabinet Light` | zwave | switch | |
| `My Bathroom Switch` | local (Tuya) | switch | ch1 = "Laundry Light" (driven by the separate **Laundry Light** rule, group `laundry`, `RULES/rules/laundry_light.py` — Laundry room/sensor); ch2 = "My Bathroom Light" (driven by My Bathroom Lights here) |
| `My Bathroom Presence sens` | local (Tuya) | presence | |

## Pending integration: TOTO toilet IR bridge

The HASP panel sits on the wall right next to the user's TOTO Washlet. See [TOTO_TOILET/CLAUDE.md](../TOTO_TOILET/CLAUDE.md) for the sketch + Phase 2 panel integration plan. Five panel buttons will trigger TOTO functions (flush, open lid 1/2, light on/off — light identity TBD); remaining TOTO actions will reflect on the panel as visual feedback when the user presses the physical remote.

Pending Phase 2 work touches this folder via:
- New rule `RULES/rules/my_bathroom_toilet_reflect.py` (subscribes `mur/home/esp/toilet_01/event` → publishes `hasp/my-bathroom/command/<obj>.<prop>` updates)
- New entries in `dashboard_settings.my-bathroom.button_bindings` with `type: esp_command, target: toilet_01, action: <key>`
- Panel page geometry for the 5 control buttons + reflection objects added via `Sync from panel` after editing on the HASP web UI

## When you pair a TS0044 for this room

1. Pair via Z2M with friendly name `My BathRoom Smart Switch` (or any name — note the IEEE address).
2. Open `RULES/rules/my_bathroom_smart_switch_handler.py` and set `SMART_SWITCH_ID = "<ieee_address>"` (replaces the placeholder).
3. `scp` the file to LXC 105 + click Reload on Main Agent.
4. Open the dashboard's My BathRoom Agent → Smart Switch tab and add bindings per button (saves to `dashboard_settings.my-bathroom.smart_switch_bindings`).

## When you redesign the panel pages

The panel's page layout is edited via OpenHASP's web UI at `http://192.168.1.220` (or the `/edit` link). After editing, click **Sync from panel** in the dashboard's Panel tab — that pulls `pages.jsonl` from the panel, upserts `hasp_buttons` + `hasp_displays` rows, and saves the jsonl to `MY_BATHROOM/pages.jsonl` (per-panel directory derivation in `server.js`, since 2026-05-06).
