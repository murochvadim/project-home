# Living Room Agent

Namespaced owner of all Living Room automations — wallmote button bindings, lights, scenes.

Dashboard-only agent (no dedicated LXC service). All automation logic lives in the rule engine on LXC 105; UI is hosted by the Windows dashboard.

## File Locations

Everything scattered across canonical directories — this file is the index.

| Artifact | Path |
|----------|------|
| Dashboard page | `BOILER/dashboard/public/living-room.html` |
| Dashboard JS | `BOILER/dashboard/public/js/living-room.js` |
| Rules | `RULES/rules/wallmote_handler.py` (group=`living-room`) |
| DB setup migration | `LIVING_ROOM/migrations/setup.sql` |
| DB agent row | `agents` table, `name = 'living-room'` |
| Config storage | `dashboard_settings` keys prefixed `living-room.*` |
| Memory | `memory/project_agent_living-room.md` |

## Storage Convention

All living-room configs use `dashboard_settings` keys with prefix `living-room.`:

| Key | Shape | Purpose |
|-----|-------|---------|
| `living-room.wallmote_bindings` | `{"<slug>:<button>:<event>": [{device_id, channel, action, name, label}, ...]}` | Wallmote button → device bindings |

> **Note (2026-05-05):** `living-room.rule_sentences` was removed. Per-room rule authoring proved redundant — every actual rule (Evening Lights, Mode Buttons, Start Away Mode, etc.) cuts across multiple rooms via `@<device>` chips, so a "Living Room only" namespace was artificial. All rule authoring now lives on **Main Agent → Base Rule Settings** (`dashboard_settings.apartment.rule_sentences`). Future per-room agents (Balcony, Bedroom, etc.) follow the same pattern: their dashboards host area-specific control surfaces (wallmote bindings, smart switches, panels, displays) but NO rule editor.

Saved via POST to `/api/dashboard-settings/living-room.wallmote_bindings` from the Living Room page.

## Rules (group=`living-room`)

| Rule | File | Trigger | Purpose |
|------|------|---------|---------|
| Wallmote Handler | `RULES/rules/wallmote_handler.py` | `*` (filters for wallmote device_ids early) | Reads bindings, dispatches per-device actions (turn_on / turn_off / toggle) on physical button presses |

### Wallmote Handler details

- Listens for device events where `device_id` matches Wallmote 1 (`e410cc7b-a734-4177-b941-2394dd7a5f7f`) or Wallmote 2 (`62f40d30-5c63-4d97-bf55-c602d1e2ee93`)
- Parses `pushed:` / `held:` prefix from the button dps value
- Reads bindings from `dashboard_settings.living-room.wallmote_bindings` with 30s TTL cache
- `toggle` resolves against in-memory `state.devices[device_id].dps[channel]` — inverts current state
- Handles zigbee multi-gang switches via `channel='state_lN'`
- Handles Tuya multi-gang via numeric `channel='N'`

## Dashboard Page

Path: `/living-room.html` (served by the Windows dashboard). Sidebar link under "Agents" section, same row as Boiler / Media / Corridor / Device.

### Tabs

- **Wallmote** — binding editor for Wallmote 1 and Wallmote 2 (4 buttons × Pushed/Held = 8 slots per wallmote)
- **Awtrix** — sentence editor + saved-apps manager for the AWTRIX 3 LED matrix display. See root CLAUDE.md → Living Room Agent row for full details.

> **Removed (2026-05-05):** `Rule Settings` tab. Rule authoring consolidated to Main Agent — see the Main Agent → Base Rule Settings tab. Rationale: every real rule cross-cuts rooms; a per-room rule namespace added complexity without value. Living Room agent now hosts only room-specific non-rule UI (wallmote bindings + Awtrix). Pattern applies to all future per-room agents.

### Wallmote Tab Features

- Per-slot device multi-select popover with per-device action dropdown (Turn On / Turn Off / Toggle)
- Zigbee multi-gang switches shown as separate rows per channel (state_l1 / state_l2 / state_l3)
- Tuya multi-gang switches shown per `channel_config` entry
- Search by name / room / protocol in the picker
- **Test** button per slot — dispatches real commands via `/api/devices/:id/toggle` for instant verification without the physical button
- **Save Bindings** — POSTs all 16 slots (2 wallmotes × 8 slots each) in one request to `/api/dashboard-settings/living-room.wallmote_bindings`

## Feature 2 — Room Layout (moved to Rooms page 2026-04-16)

The Layout tab was **removed** from living-room.html on 2026-04-16. All room layout editing now lives on the dedicated **Rooms page** (`rooms.html`), which supports multi-room apartment-wide editing with auto-positioning, per-room W/L zoom, and an "Apartment" view showing all rooms connected.

See root `CLAUDE.md` Dashboard Pages table for the Rooms page entry. See [project_spatial_model memory](../.claude/projects/c--Users-muroc-project-home/memory/project_spatial_model.md) for the full spatial model architecture.

## Planned Future Features

- **Lights tab** — group-based lighting control (scenes, dim curves)
- **Scenes tab** — named scenes (Movie Mode, Reading Mode, etc.) mapped to a button combo or schedule
- **Presence tab** — auto-on-when-home rules specific to Living Room
- **/room-zones**, **/room-devices**, **/room-scene** skills — layer more data onto the same `room_layouts.<slug>` key the Rooms page writes

Each new feature = new tab in `living-room.html`, new rule(s) in `RULES/rules/` with `group="living-room"`, new keys under `living-room.*` in `dashboard_settings`.

## Extending the Agent

To add a new service (if ever needed): run `/create-agent Edit` → choose "add service layer". The skill generates `LIVING_ROOM/agent/living-room-agent.service` + env file + orphan guard, and updates the `agents` table row.
