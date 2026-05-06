# My BathRoom Agent

Per-room agent for My BathRoom — touch panel, smart switch, smell pump, and bathroom-area devices.

Dashboard-only agent (no dedicated LXC service). All automation logic lives in the rule engine on LXC 105 (rule sentences under `apartment.rule_sentences` on Main Agent → Base Rule Settings); UI is hosted by the Windows dashboard.

## File Locations

This file is the index — all artifacts live in shared canonical directories:

| Artifact | Path |
|----------|------|
| Dashboard page | [BOILER/dashboard/public/my-bathroom.html](../BOILER/dashboard/public/my-bathroom.html) |
| Dashboard JS | [BOILER/dashboard/public/js/my-bathroom.js](../BOILER/dashboard/public/js/my-bathroom.js) |
| Rules | [RULES/rules/](../RULES/rules/) — authored under Main Agent → Base Rule Settings, no per-agent group |
| DB setup migration | [MY_BATHROOM/migrations/setup.sql](migrations/setup.sql) |
| DB agent row | `agents` table, `name = 'my-bathroom'` |
| Config storage | `dashboard_settings` keys prefixed `my-bathroom.*` |
| Memory | [memory/project_agent_my-bathroom.md](../../.claude/projects/c--Users-muroc-project-home/memory/project_agent_my-bathroom.md) |

## Dashboard Tabs

- **Panel** — placeholder for the future OpenHASP panel mounted in the bathroom (mirror of Balcony's Panel tab — same pattern: page editor + button bindings).
- **Smart Switch** — placeholder for the future TS0044-class wireless scene remote bindings (mirror of Balcony's Smart Switch tab).

## Storage Keys

`dashboard_settings.my-bathroom.*` — populated as features land. Naming examples for future use:
- `my-bathroom.panel_buttons` — HASP button bindings (when panel arrives)
- `my-bathroom.smart_switch_bindings` — TS0044 button bindings
- `my-bathroom.scenes` — saved scene presets

## Devices in the Room (current snapshot)

| Device | Protocol | Type | Notes |
|---|---|---|---|
| `My Bathroom Smell` (`My_Bathroom_Smell_6`) | esp | esp_board | Pump + auto-mode controllable from rules via `dps_config.auto_enabled.action_on='smell_auto_start'` |
| `My Bathroom Door` | zwave | door_sensor | Aeotec; battery 42% |
| `My Bathroom Damper` | local (Tuya) | circuit_breaker | |
| `Smart Toilet AC breaker` | local (Tuya) | circuit_breaker | |
| `My Bathroom Color` | local (Tuya) | light | |
| `My Bathroom Under Cabinet Light` | zwave | switch | |
| `My Bathroom Switch` | local (Tuya) | switch | |
| `My Bathroom Presence sens` | local (Tuya) | presence | |

## Planned Future Features

- Mount HASP panel → wire bindings via the Panel tab
- Add TS0044 smart switch → bindings via the Smart Switch tab
- Sentence-driven rules consuming presence + door + smell pump state
- Scene presets (e.g. "Shower mode" — fan on, lights bright, panel page X)

## Extending the Agent

To add a service layer later: run `/create-agent Edit` → select "add service layer". Skill generates `MY_BATHROOM/agent/my-bathroom-agent.service` + env file, updates the `agents` table, and converts this pointer index into a full-module doc.
