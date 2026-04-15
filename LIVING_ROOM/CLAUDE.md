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

### Wallmote Tab Features

- Per-slot device multi-select popover with per-device action dropdown (Turn On / Turn Off / Toggle)
- Zigbee multi-gang switches shown as separate rows per channel (state_l1 / state_l2 / state_l3)
- Tuya multi-gang switches shown per `channel_config` entry
- Search by name / room / protocol in the picker
- **Test** button per slot — dispatches real commands via `/api/devices/:id/toggle` for instant verification without the physical button
- **Save Bindings** — POSTs all 16 slots (2 wallmotes × 8 slots each) in one request to `/api/dashboard-settings/living-room.wallmote_bindings`

## Feature 2 — Layout Tab (added 2026-04-15, expanded 2026-04-16)

SVG-based floor-plan editor for the room's walls, windows, doors, sliding glass doors, and internal dividers. Foundation of the spatial model whose primary consumer is AI investigations (see [project_spatial_model memory](../.claude/projects/c--Users-muroc-project-home/memory/project_spatial_model.md)).

- **Storage**: `dashboard_settings.room_layouts.<slug>` — single JSON blob per room
- **Fields this tab writes**: `shape`, `grid`, `walls[]`, `windows[]`, `doors[]`, `dividers[]`, `shared_with[]`. Future skills (`/room-zones`, `/room-devices`, `/room-scene`) add their own fields to the same key without collision.
- **API**:
  - `GET  /api/room-layouts/:slug` — direct hit, then falls back to any layout whose `shared_with` contains this slug (returns `_shared_from` for traceability)
  - `POST /api/room-layouts/:slug` — merges patch into existing blob (whitelist: `shape, grid, orientation, walls, windows, doors, dividers, shared_with`)
  - `GET  /api/room-slugs` — rooms + derived slug, feeds the `Leads to` dropdown
- **Elements**:
  - **Wall** — solid black line. Click-click, grid-snap (cell-size), Shift disables snap for free angles
  - **Window** — dashed blue band with centerline, placed along a wall (2 clicks on the wall)
  - **Door** (hinged) — wall gap + brown leaf at 90° + swing arc + hinge dot; `leads_to` field
  - **Sliding** — teal glass band with 2 overlapping tracks + ↔ arrow; `leads_to` field
  - **Divider** — dashed grey (open-plan boundary) or dashed blue with `→ slug` label (passage to another room)
- **Placement snap**: opening placement (windows/doors/sliding) uses a separate 0.05m soft-snap so values like `0.25m from corner` are reachable regardless of the visual cell size. Shift disables.
- **Edit panel**: Select tool → click any element → amber panel shows editable `Offset`, `Width`, and `Leads to` (dropdown populated from `/api/room-slugs`). Dividers show only `Leads to`.
- **Live cursor readout**: hovering in opening-tool modes shows a green dot on the wall with `X.XXm from S/E` label so offsets are visible BEFORE clicking.
- **Shared-space support**: `shared_with: [slug, ...]` at the top of the layout tells the GET fallback which slugs should return this same blob. Example: Living Room layout with `shared_with: ["kitchen"]` — requests for `/api/room-layouts/kitchen` return the Living Room blob, preserving AI investigation continuity for open-plan spaces.
- **Client**: `BOILER/dashboard/public/js/living-room.js` — second IIFE at the bottom, scoped so symbols don't leak into the wallmote-tab code above.

## Planned Future Features

- **Lights tab** — group-based lighting control (scenes, dim curves)
- **Scenes tab** — named scenes (Movie Mode, Reading Mode, etc.) mapped to a button combo or schedule
- **Presence tab** — auto-on-when-home rules specific to Living Room
- **/room-zones**, **/room-devices**, **/room-doorways**, **/room-scene** skills — layer more data onto the same `room_layouts.<slug>` key the Layout tab already writes

Each new feature = new tab in `living-room.html`, new rule(s) in `RULES/rules/` with `group="living-room"`, new keys under `living-room.*` in `dashboard_settings`.

## Extending the Agent

To add a new service (if ever needed): run `/create-agent Edit` → choose "add service layer". The skill generates `LIVING_ROOM/agent/living-room-agent.service` + env file + orphan guard, and updates the `agents` table row.
