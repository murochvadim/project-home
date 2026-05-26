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
| Rule files (group=`my-bathroom`) | `RULES/rules/my_bathroom_*.py` (4 files, see below) |
| DB agent row | `agents` table, `name = 'my-bathroom'` |
| DB panel row | `hasp_panels` table, `name = 'my-bathroom'` |
| DB device row (rule-target alias) | `devices.hasp:my-bathroom` |
| DB setup migration | [migrations/setup.sql](migrations/setup.sql) (agent row) + [migrations/002_panel.sql](migrations/002_panel.sql) (panel + device rows) |
| Config storage | `dashboard_settings.my-bathroom.*` |
| Memory | [memory/project_agent_my-bathroom.md](../../.claude/projects/c--Users-muroc-project-home/memory/project_agent_my-bathroom.md) |

## Dashboard Tabs

- **Panel** — full Balcony-equivalent UI (info card / status card / sync from panel / button bindings (wallmote-style picker) / display templates). **Power chip + On/Off button highlight (added 2026-05-26)** matches the Balcony pattern — state source is `hasp/my-bathroom/state/backlight` (`{state:"on"|"off", brightness:<n>}`), since OpenHASP 0.7.0-rc12's `statusupdate` JSON does NOT include the backlight field. Cached to `localStorage['my-bathroom.hp.power']` for persistence across page navigations. See [BALCONY/CLAUDE.md](../BALCONY/CLAUDE.md) for the full pattern reference.
- **Smart Switch** — Balcony-equivalent wallmote-style binding UI for the TS0044 scene remote (single-press only, hold doesn't fire on this firmware variant). Empty until hardware is paired.

## Rules (group=`my-bathroom`, 4 files)

Direct copies of the balcony equivalents with panel name + group fields swapped, SQL `WHERE p.name = 'my-bathroom'`. Fully isolated — no cross-firing.

| Rule | File | Trigger | Job |
|---|---|---|---|
| My BathRoom Buttons | [`my_bathroom_buttons.py`](../RULES/rules/my_bathroom_buttons.py) | wildcard (early-return on `hasp:my-bathroom:*`) | panel button press → device commands per `hasp_buttons.bindings` |
| My BathRoom Button Mirror | [`my_bathroom_button_mirror.py`](../RULES/rules/my_bathroom_button_mirror.py) | wildcard (early-return on bound device events) | device state → panel button visuals (`p<page>b<id>.val = 0/1`) |
| My BathRoom Displays | [`my_bathroom_displays.py`](../RULES/rules/my_bathroom_displays.py) | heartbeat (60 s) | render value templates onto panel labels via `hasp_displays` rows |
| My BathRoom Smart Switch Handler | [`my_bathroom_smart_switch_handler.py`](../RULES/rules/my_bathroom_smart_switch_handler.py) | `SMART_SWITCH_ID` (placeholder until paired) | TS0044 button event → device commands per `dashboard_settings.my-bathroom.smart_switch_bindings` |

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
| `My Bathroom Switch` | local (Tuya) | switch | |
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
