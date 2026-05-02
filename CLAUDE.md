# Global Environment Settings

---
## ⛔ HARD ARCHITECTURE RULE — NEVER VIOLATE
**Windows dashboard (`BOILER/dashboard/server.js`) = static file server + TV/HA control ONLY.**
- NO media logic, NO ingest, NO search, NO library queries, NO SSH loops for features
- ALL business logic runs on LXCs (media → LXC 100, agents → LXC 103, timers → LXC 104)
- Dashboard JS calls LXC APIs directly: `http://192.168.1.138:<port>/api/...`
- If a feature needs an API endpoint → it goes on the appropriate LXC, NOT in server.js
- Violation of this rule means the code must be moved before merging
---

# Global Project Instructions
- All agents must reference root `claude.md` for global settings (timezone, MCP, Home Assistant integration, logging)

## Time & Scheduling
- Timezone: Asia/Jerusalem
- All timestamps must use this timezone

## Rules
- Never assume UTC unless explicitly stated
- Always convert external times to Asia/Jerusalem


## Connection Tools
MCP Server: postgres-lxc (Connected via SSH bridge to LXC)
MCP Server: homeassistant (Connected via `home-assistant-mcp-server` npm package — command-based, NOT SSE)
Note: The Windows host uses npx.cmd, but the remote LXC requires npx.
Always use these MCP tools when I ask for data analysis or device status.

### ⚠ MCP HA Server Config — DO NOT CHANGE THE APPROACH
Config: `C:\Users\muroc\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Uses `home-assistant-mcp-server` npm package (command-based) with `HA_URL` + `HA_TOKEN` env vars
- **Do NOT switch to SSE type** (`http://192.168.1.110:8123/api/mcp/sse`) — HA does not have `mcp_server:` enabled
- When HA token expires/resets: update only the `HA_TOKEN` value in that file, keep everything else unchanged

## Dashboard Server
- Runs locally on **Windows host** (not on any LXC)
- Managed by **pm2** — available at `C:\Users\muroc\AppData\Roaming\npm\pm2` (already in PATH)
- Restart command: `cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`
- ⚠ **NEVER use `pm2 restart`** — it caches the old process environment and ignores `.env` changes (causes stale HA tokens and wrong secrets)
- Do NOT look for pm2 or ecosystem.config.js on any LXC
- **Batch all server.js changes before restarting — restart once at the end, never after each edit**
- `HA_TOKEN` auto-refreshed from `.env` with 5-min TTL cache (`getHaToken()`) — no restart needed after token update

### Dashboard Pages (all served from `BOILER/dashboard/public/`)
| Page | File | Purpose |
|------|------|---------|
| Boiler Agent | `index.html` | Boiler control, reports, settings, AI investigation |
| Main Agent | `main-agent.html` | Rule engine state, rules table, room grid. **Base Rule Settings** tab (since 2026-04-22) — apartment-wide Layer 0/1 rule authoring in numbered containers of segment-based sentences (`dashboard_settings.apartment.rule_sentences`). Same UI pattern as Living Room Rule Settings: drag-reorder rules, `+Dev` chips with click-to-replace / ×-remove, Save All / Discard, `● Unsaved changes` badge + beforeunload warning, silent on-load migration of legacy `@Name:dps_key` tokens → `@Name dps_label`. Consumed by AI sentence→Python pipeline — see [RULES/TODO_RULES.md](RULES/TODO_RULES.md). **Compact segment cells** (since 2026-04-26) — whitespace-only separator inputs between chips render as 6 px transparent spacers (no border / no background), chip padding tightened to 2 px each side, leading-text inputs trim leading/trailing whitespace for `size` calc so trailing spaces don't reserve extra width. Chip-bearing sentences keep shared-column alignment (so chips line up vertically across sentences in the same rule), but **single-segment text sentences** (e.g. a knob declaration like `Evening Lights: active time modes are sunset-10, night, late_night`) render with `colspan="<maxSegs>"` so their length doesn't inflate the chip-row column widths. `maxSegs` is computed only from chip-bearing sentences. Cache-bust query strings on `main-agent.js` / `device-picker.js` get bumped on each layout change to invalidate browser cache. **Tab-bar live display** (since 2026-04-26) — right-aligned strip showing `time mode` + `next sunrise` + `next sunset`, fed by `state.shared` from the `Home Time Periods` rule, refreshed on the existing 10 s poll. **Per-rule Event Trace customization** (since 2026-04-26) — `ruleKeyWhitelist` map in `main-agent.js` lets a rule restrict its trace to a subset of state keys. Whitelisted rules also switch from "count of changes" rendering to **value-at-change** rendering (cell shows the new state value parsed from the `key=value` event result, empty buckets are skipped). `People Home` is whitelisted to `[people_home, people_home_dynamic]`; other rules unchanged. |
| Device Agent | `devices.html` | All devices, Batt Devices, Set Devices, Rooms, Device History, Settings |
| Media Agents | `media.html` | TV + Soundbar control |
| Corridor Agents | `corridor.html` | Pixoo display editor + control |
| Project Health | `health.html` | System status, DB volumes, retention, alerts |
| Project Network | `network.html` | ARP scan, network devices |
| Project Boards | `esp-boards.html` | ESP8266/ESP32 board management — DB-driven tab bar (one per `esp_boards` row, status dot in label), per-board sub-tabs **Status / Params / Simulation / OTA**. Reads `/api/esp/boards` (LEFT JOIN net_devices.mac for live IP, `split_part(b.ip::text, '/', 1)` to strip CIDR from INET). Phase 4 (2026-05-02) — boards self-declare schema via retained MQTT topic `mur/home/esp/<id>/schema` (parameters + actions); rule engine on LXC 105 ingests `availability` / `status` / `schema` / `event` and writes to `esp_boards`. Dashboard owns config CRUD + OTA orchestration (Phase 6 — `POST /api/esp/boards/:id/ota` accepts a multipart `.bin` and spawns `espota.py` with chip-aware port: 8266 for ESP8266 / 3232 for ESP32; binary path resolved from `ESP8266_OTA_PY` / `ESP32_OTA_PY` env vars). **Status sub-tab** has 3 cards: Connection (sketch identity + uptime + RSSI + heap) / Brokers (HiveMQ + Mosquitto live status — grey "unknown" when board offline) / System (Restart / Clear EEPROM / Force WiFi Reset, all destructive with confirm dialog). **Simulation sub-tab** has 4 cards: Doorlock (Open Doorlock + Door Relay status) / Robot (Robot Alive + Robot Lost Power + Charge Relay status) / HiveMQ Bridge (Reconnect HiveMQ + 3 sim_* actions that synthesize CAR_REQUEST locally without touching the cloud) / **Live MQTT Events** (browser-MQTT-WS subscribe to `mur/home/esp/<id>/event` via `dashboard_browser` user on port 9001 — black-background event console, last 50 messages, persists across sub-tab switches). Action grouping driven by `ACTION_GROUPS` lookup in `esp-boards.js`; unmapped actions auto-render in an "Other" card. Schema parameters of `type:'string'` with `secret:true` render as password input (used for `door_unlock_code`). **Params endpoint** validates submitted keys against the board's published `board_schema.parameters` set — rejects unknown keys. **Auto-refresh** every 30 s; suppressed while user has unsaved Params edits (`PARAMS_DIRTY` flag). Sub-tab choice persists across re-renders (`SELECTED_SUB_TAB`). **Sole shared MQTT user `esp_boards`** on LXC 107 — same topic ACL serves all future boards. Board IDs must match `^[a-zA-Z][a-zA-Z0-9_-]*$`. **Offline detection** ~22 s via LWT on `mur/home/esp/<id>/availability` payload `offline` — rule engine backdates `last_seen` to `now() - interval '1 hour'` so dashboard freshness check (`isOnline`, 180 s threshold) flips immediately instead of waiting for 3 missed heartbeats. New boards: `/create-board` skill scaffolds sketch + DB rows + `.env`. Onboarding cookbook: [BOILER/dashboard/docs/esp_boards.md](BOILER/dashboard/docs/esp_boards.md). |
| Weather | `general.html` | Weather data, solar heating potential |
| Voice | `voice.html` | Voice pipeline, intents, TTS |
| Project Rooms | `rooms.html` | Apartment-wide multi-room layout editor. Tools: Wall / Window / Door / Sliding / Archway (door_type=opening — wall gap, target stays drawable) / Glass / Divider / Select / Furniture ▾ (26 presets — sofa, armchair, coffee-table, tv-unit, dining-table, chair, bed, nightstand, wardrobe, desk, counter, fridge, stove, hob, oven, microwave, hood, sink, bathtub, toilet, shower, washing-machine, bookshelf, planter, fireplace, lamp) / **Devices Set** (V5 — presence/motion sensors; V9 — door sensors too) / **Zones Set** (V6 — 1m grid + named zones). Auto-positioning BFS via door/divider/archway leads_to. When the target room's door side doesn't match the expected opposite of the parent's door side, the BFS picks the correct transform: **perpendicular mismatch** (e.g. parent.south → target.east) → rotate by the exact N × 90° CW; **parallel mismatch** (e.g. parent.south ↔ target.south) → reflect across the matching axis (x-axis for N/S pairs, y-axis for E/W pairs). Reflection is required for asymmetric rooms (L-shapes, partial walls) because a 180° rotation would flip BOTH axes and destroy left/right handedness. `getWallSide` is orientation-aware — horizontal walls return only north/south, vertical walls only east/west, even on interior (non-bbox-boundary) walls; this prevents L-shape rooms with archways on inner walls from mis-classifying and triggering an unwanted rotation. **V8 flip-fix (2026-04-20)**: interior walls now use a polygon point-in-test (`buildRoomPolygon` + `pointInPolygon` helpers) instead of the bbox-center heuristic — probes 0.3 m perpendicular to the wall; the side that falls OUTSIDE the room polygon is the true "outward" face. Fixes non-rectangular rooms (e.g. Hallway L-shape) where bbox-center and polygon-interior disagree, causing children (e.g. Bedroom) to flip 180°. Also: `curLayout = displayRooms[curSlug] || allRooms[curSlug]` at BFS line 373 so rotated parents pass transformed geometry to their children instead of stale originals. **V7 Lights** (toolbar button Lights Set): place light fixtures in rooms with controller + channel + fixture type + intensity + state. Reuses `room_device_placements` table (`device_type='light'`). Shape driven by fixture — `spot`=cone, `strip`=180° one-sided rect along rotation axis (`strip_length_m × strip_width_m`), others=radius circle. Intensity (`high/mid/ambient`) drives yellow opacity only (0.28/0.16/0.08). Controller is any device (switch/circuit_breaker/light) from any room, cross-room supported. Dps-key sub-select uses controller's `dps_labels`. Icons per fixture: spot=triangle-in-rotation, ceiling=disc+ring, pendant=disc+cord, chandelier=disc+3-satellites, lamp=disc-on-base, sconce=half-disc+bar, strip=long-pill. Spread visible in all rooms (not just active) so ON/OFF is readable in apartment view. Copy/paste supports lights (Select → Copy → click canvas to paste clones with same controller). Multi-placement per controller allowed (N lights on one switch channel). State polling uses `params.controller_device_id` so controller retargets work without stale state. Lights toolbar checkbox (`apt_show_lights` localStorage) hides/shows icons. Shoelace polygon area for non-rectangular rooms (Balcony L-shape 39.6m² vs bbox 50m²). Per-room W/L zoom (localStorage). **Room Information** card — all rooms' Status / W / L / H / Area / Volume / Devices in one table. **Zone Information** card (V6) — Room / Zone name / Cells / Area / Devices in zone. **Device placements** (V5): triangle icon with apex = rotation, 15° step, nose indicator, state color (green clear / red active with cone+dot field / grey offline, 10-min offline threshold), **asymmetric cone params** (V5.1): `beam_angle_left_deg / beam_angle_right_deg / beam_length_left_m / beam_length_right_m / hold_s`, rendered as two independent pie slices joined on the aim axis (backward-compat fallback to legacy `beam_angle_deg / beam_length_m` splits into equal halves). Hinged doors also gain `hinge_side: 'start'|'end'` + `swing_dir: 'inward'|'outward'` controlling pivot + arc direction. Optional **wall_barrier** checkbox that ray-casts per side to clip the cone outline + dot field at walls (line-of-sight visibility polygon). Protocol-aware state detection (Tuya field `"1"`, Aeotec `motion`, Z2M `occupancy`). 5s polling via `/api/devices/states`. **V9 Door sensors (2026-04-23)**: the Devices Set picker + `DEV_PLACEABLE_TYPES` now also include `device_type='door_sensor'`. They render as a small 0.18 m square on the wall — red when open, grey when closed — no cone, no nose. Open/closed detection is protocol-aware via `_doorSensorIsOpen(p)` (Aeotec `door: true/false`, Z2M `contact: true/false` inverted, Tuya `"1": bool`). The edit panel auto-hides the cone-geometry fields (Rot / L-ang / R-ang / L-len / R-len / Hold / Wall-barrier) when a door-sensor placement is selected — only Enabled + Label remain. The save handler also branches on device type so door-sensor placements don't accumulate stray cone params. Drag-to-move + right-click-label-hide work unchanged via the shared `[data-dev-placement-id]` handlers. Ring Doorbell was reclassified `door_sensor → motion` at the same time (it's a motion + doorbell device, not a contact sensor). **Zones (V6)**: 1m fixed grid overlay (row-major, 1-based). Cells inside a named zone show the zone name; unnamed cells show their number (only while Zones Set tool active). Active room shows grid + cell numbers + selection + labels; non-active rooms show only the bold darker zone labels as AI anchors. `Zones` toolbar checkbox toggles visibility (localStorage `apt_show_zones`). Select tool picks zones (rename/delete via edit panel); Zones Set tool paints cells (click to toggle, Apply names the zone; blank name deletes). Zone labels left-click-drag (Select/Zones tools only — pointer-events:none in others so furniture placement isn't blocked), right-click hide, "Hidden labels" reveal. Save clears the purple editing-selection outline. All labels (room / divider / door / archway / furniture / device / zone) left-click-drag, right-click hide, "Hidden labels" toolbar toggle. Safety guard in Save: confirm dialog if walls/doors/dividers/furniture would shrink on the active room. `[save]` + `[undo-push]` console breadcrumbs for debugging. Scene serializer `GET /api/apartment-scene` emits per-room area + bbox + height + volume + device count + status, adjacency graph (including archways), exterior exposure, **Zones (1m grid):** block listing each named zone with cells + area, and `Devices placed:` block with position / rotation / cone / coverage m² / state / wall-clipped flag + `(in zone X)` / `(cell N)` suffix. Spatial context auto-injected into `/api/ai-investigate`. **V8 Rooms Scoreboard** (AI observability per room): new columns `ai_score_old / ai_score_new (+ *_at + *_reason)` on `rooms` table. Room Information card gained `📊 Scoreboard DD-MM-YY` button + a single score column (new only — sorted by apartment position top→bottom, left→right; the previous old-score column was removed 2026-04-29 to declutter the table). The Scoreboard detail modal still surfaces the full old vs new comparison per room from `_scoreboardData` (both fields are still populated by `/api/rooms/scoreboard` and rotated atomically by the skill). Modal opens with per-room reason + 7-row capability table (Presence / Which zone / People count / 2D position / Individual ID / Activity classification / Light state control) computed client-side from live placement + device data — diagnostic only, does NOT drive the overall score. `/review-rooms-score` skill applies **rubric v2.1** (hardware-class ceiling: base 6, +1 mmWave, +1 lights placed, +1 multi-target tracker like FP2/LD2450, +1 individual-ID like BLE/camera → current house caps at 8); subtractive structural gaps (area-scaled sensor penalty, cloud-DPS-1-only -2, offline/dead -1.5, no zones -1, typo -0.5, no doors modeled -0.5, 0 rule triggers 30d -0.5); clamp [0, max_achievable], round DOWN. Sub-rooms (Kitchen/Dining/Corridor/Entrance inside Living Room) scored via parent-zone coverage, capped at parent score. Skill flow: read-only gather (placements + devices + 30d event counts + 30d rule hits) → in-chat diff table → per-room approval (`all` / `changed` / row numbers / `cancel`) → atomic rotate `new→old` + PATCH fresh `new` only on approved rows. Endpoints: `GET /api/rooms/scoreboard`, `POST /api/rooms/scoreboard/rotate`, `PATCH /api/rooms/:name/score`. Rubric file: `.claude/skills/review-rooms-score/SKILL.md`. DB tables: `room_layouts.<slug>` (JSONB per room — walls/windows/doors/dividers/furniture/**zones**/shape/grid/origin/height_m), `dashboard_settings.room_dims` (undrawn W×L×H), `room_device_placements` (sensors). POST `/api/room-layouts/:slug` allowlist includes `zones` (V6 add — silently stripped before fix). **V10 Parameters Set (2026-04-27)**: place sensor-value labels (temperature / humidity / illuminance) per room. New placement type `device_type='parameter_label'` reusing `room_device_placements`. `params={dps_field, sources[], agg, font_size, color, format, unit}` — `sources` is a list of sensor `device_id`s, aggregated via `agg` ∈ `{avg|max|min|last}` (defaults: temp=avg, humidity=avg, illuminance=max). Renders as draggable SVG `<text>` with custom font_size + color (no icon). Picker shows in-room sensors first (folded via `SUBROOM_FOLD = {Kitchen→living-room, Dining Room→living-room}` so open-plan sub-room sensors count as in-room), then cross-room sensors (door sensors with internal `temperature` field, neighboring rooms). Toolbar checkbox `apt-show-parameters` (localStorage `apt_show_parameters`, default ON). State polling reuses existing 5 s cadence via `device_id = sources[0]`. **Critical fix**: server's POST handler used to `DELETE FROM room_device_placements WHERE device_id = $1` for any non-light placement, meant to prevent placing the same sensor twice but accidentally deleted parameter_labels referencing the same sensor — now scoped to `device_type IN ('presence','motion','door_sensor')` so labels and lights coexist freely with sensor placements. Apartment-scene serializer lists parameter_label placements alongside sensors (no telemetry of their own — they're UI labels). |
| Living Room Agent | `living-room.html` | Living Room automations — wallmote bindings (Layout tab moved to Rooms page), scenes, lights. **Rule Settings** tab (since 2026-04-22) — Living Room Layer 3 action rule authoring using the same segment-based sentence UI as Main Agent Base Rule Settings, stored at `dashboard_settings.living-room.rule_sentences`. **Awtrix** tab (since 2026-04-29) — sentence editor + saved-apps manager for the AWTRIX 3 LED matrix display (`awtrix_05ec2c`). Status card (battery / brightness / signal / temp / humidity), live preview of `{{var}}` substitution against `state.shared`, color picker, scroll-speed, text-case, blink, sound (RTTTL or filename), priority (low/normal/high → `wakeup`/`stack`/`pushIcon` mapping), clear-after-run (sets `lifetime` so the custom app auto-removes), reboot+apply for built-in app toggles. Browser publishes MQTT directly via WebSocket to mosquitto on LXC 107 port 9001 (no new server.js endpoints — saved templates stored in `dashboard_settings.awtrix.messages`, broker password served via in-handler special-case on existing `/api/dashboard-settings/_mqtt_browser_pass` reading from `process.env.MQTT_BROWSER_PASS` with self-healing fallback to `.env`). Built-in app toggles use a thin in-handler HTTP proxy to `http://192.168.1.165/api/settings` via `/api/dashboard-settings/_awtrix_settings` (firmware 0.98 silently drops `DAT` via MQTT settings — HTTP path works for all 5 keys). Clear-display button does `notify/dismiss` + `nextapp` + permanently removes the currently-shown app from the rotation if it's a saved custom app (firmware quirk: empty MQTT pub doesn't always remove from LittleFS, so we also delete via the dashboard storage). |
| Balcony Agent | `balcony.html` | Balcony automations — OpenHASP touch panel control, rule group `balcony`, balcony-area devices (gates, barrier, lights). Dashboard-only agent (no LXC service). Initial tab: Panel. Storage: `dashboard_settings.balcony.*`. |

### Sidebar (all pages)
- **Status badge** (top-left): `✓ OK` (green) / `⚠ N issues` (red blink) — overall system health; polls `/api/health/status` every 60s. **2-tick smoothing** (since 2026-04-29) — direction flips (green→red and red→green) require 2 consecutive ticks before the badge state changes. Reason: the Windows dashboard host is WiFi-only, so a brief blip (AP roam, sleep/wake) makes every TCP-port-22 probe + DB query fail in the same poll, which previously flashed the badge red for 60 s before recovering. In-state count changes (red 3 → red 5) still apply immediately so worsening problems aren't delayed. Real outages take 60 s longer to surface as a trade.
- **Battery badge** (top-right): `Batt ✓` (green) / `Batt Low - N` (dark red) — counts devices below low threshold + offline battery devices, polls every 60s
- **Device Integration badge** (full row below): `Device Integration ✓` (green) / `Device Integration ✗ N stuck` (dark red) — active `group_stale:*` alerts from the group health watchdog on LXC 104; polls `/api/health/integrations` every 60s
- All three managed by `alerts-monitor.js` (loaded on all 9 pages); Device Integration badge wrapped in `.badges-wrap` (inline-flex column, align-self:flex-start) so its width matches the upper Status+Batt row
- Battery thresholds stored in `dashboard_settings` table (key `battery_thresholds`, default `{good: 60, low: 20}`)

### Dashboard DB Tables (system-wide, not module-specific)
- `dashboard_settings` — key/value store for dashboard-wide settings (battery thresholds, future settings). Retention: forever.
- `device_events` — device state changes from all protocols. Retention: 30 days.
- `devices` — device registry with last_state, dps_labels, dps_config, channel_config. Retention: forever.
- `rooms` — room definitions. Retention: forever.
- `net_devices` — network devices. Populated by ARP scanner (LXC 104, every 5 min via systemd timer `net-arp-scan.timer`, source: [scripts/arp_scan.py](scripts/arp_scan.py) → deployed to `/opt/network-agent/arp_scan.py`) + SNMP scanner ([scripts/snmp_scan.py](scripts/snmp_scan.py), every 10 min via `net-snmp-scan.timer`, polls Aruba 1960 ports → `net_ports` table) + device agent IP writeback (LXC 103, every 5 min for local Tuya devices with active TCP connections). Used for MAC→IP resolution. Scanner injects its own host row (arp-scan can't see itself) with `name='LXC 104'`; `ON CONFLICT` preserves user-edited names/vendors on subsequent runs. **MAC-change dedup (added 2026-04-29):** `merge_replaced_macs()` runs after the main upsert each scan — collapses ghost MACs of existing physical devices. A new MAC X "replaces" an old MAC Y at the same IP only when ALL 4 guards pass: (1) X seen this scan, (2) Y silent ≥ 30 min, (3) `same vendor` (both known + equal) OR `Y was 'Locally administered' AND X has a known non-random vendor`, (4) NOT both already tracked as separate rows in `devices` table (protects Tuya gateway sub-devices that share an IP). On match: transfer Y's `name` + earliest `first_seen` to X, re-point `devices.mac` FK to X, then DELETE Y. The FK re-point is critical — without it `device_agent._update_net_device` would re-INSERT Y as a ghost on the next cycle.
- **External-device IP linking via MAC** (added 2026-05-01): the `devices` table stores rows for network devices that aren't managed by `device_agent` (Pixoo, OpenHASP panels, Awtrix LED matrix) — each has its own dedicated service that owns the IP, but the `devices` row exists for logical identity / dispatch / dashboard listing. These rows have `mac` populated; `GET /api/devices` LEFT JOINs `net_devices` on lower(mac) so `local_ip` and `last_seen` are filled in live from the ARP scanner (5-min cadence). Adapter-managed devices (Tuya / Zigbee / Z-Wave / Ring / Home Connect) keep writing their own `local_ip` and the COALESCE prefers theirs. Response payload gains an `ip_source` field — `'net_devices'` when the JOIN supplied the IP, `null` when the device's own adapter did. Pattern generalizes: when a future panel arrives (kitchen / bedroom HASP, etc.), insert a `devices` row with the panel's MAC and it auto-shows up in the device list.
- `hasp_panels` / `hasp_buttons` / `hasp_displays` — OpenHASP touch-panel registry + button-action mapping + value-display mapping. Phase 1 schema added 2026-05-01 to back the per-room agent folders (e.g. `BALCONY/`). All 3 tables: retention forever (config tables, never auto-cleaned). One row currently in `hasp_panels` (balcony, 192.168.1.141) and 4 rows in `hasp_buttons` (page 1: GATES/BARRIER/LIGHT 1/LIGHT 2 with `action_type` and `action_target` NULL — wired in a later phase by the rule engine on LXC 105). `hasp_displays` is empty until live-value publishing is added.
- `esp_boards` — ESP8266/ESP32 sketch registry. Added 2026-05-02 to back the **Project Boards** dashboard page. Columns: `id PK` (matches MQTT `<id>` token, ^[a-zA-Z][a-zA-Z0-9_-]*$), `name`, `ip INET`, `mac MACADDR` (LEFT JOIN net_devices for live IP), `sketch_name` / `sketch_version` / `build_ts` (extracted from /status payload by the rule engine), `board_schema JSONB` (parameters + actions self-declared by the board on every Mosquitto connect — column named `board_schema` not `schema` to dodge PG reserved word; aliased to `schema` in API response), `parameters JSONB` (last values pushed via dashboard), `ota_password`, `enabled`, `last_seen`, `last_status JSONB`. Retention forever (config table). Sole writer of last_status / last_seen / board_schema / extracted identity columns is the rule engine on LXC 105 (`mur/home/esp/+/+` ingest in `_handle_esp_message`); dashboard owns config CRUD only (parameters / ota_password / enabled). Endpoints: `GET /api/esp/boards`, `PATCH /api/esp/boards/:id`, `POST /api/esp/boards/:id/parameters` (publishes JSON to `mur/home/esp/<id>/config`), `POST /api/esp/boards/:id/command` (validates against board_schema.actions + builtin restart/factory_reset, publishes plain string to `mur/home/esp/<id>/command`), `POST /api/esp/boards/:id/ota` (multipart `firmware`, spawns `espota.py` from `ESP8266_OTA_PY` or `ESP32_OTA_PY` env paths). Onboarding cookbook at [BOILER/dashboard/docs/esp_boards.md](BOILER/dashboard/docs/esp_boards.md).

### Device Agent System
- Runs on LXC 103 as `device-agent.service`
- Protocols: local (Tuya TCP), gateway (Tuya sub-devices), cloud (Tuya cloud poll), zigbee (Z2M MQTT), zwave (HA WebSocket), ring (HA WebSocket)
- Source priority: tcp_push(5) = mqtt(5) > ha_api(4) > home_connect(4) > gateway_push(3) > cloud_push(3) > local_poll(2) > cloud_poll(1)
- HA adapter: SmartThings + Ring identifiers, initial seed restricted to external devices only; rebuilds entity map on WS reconnect; handles `auth_invalid`; watchdog thread (runs every 60s) forces `ws.close()` on: (1) no auth_ok within 60s of connect, (2) entity map empty >60s after auth, (3) no event for 15 min, or (4) 2 consecutive HA pings unanswered — recovers from stuck-socket states, post-HA-restart empty-map states, and integration flakiness. Additionally, on auth_ok the adapter rebuilds the entity map if empty (handles case where initial `_build_entity_map` ran during a brief HA outage and got 0 entities)
- Keepalive: hourly for IR remotes with no DPS + every ~15s for BSH appliances (Home Connect SSE KEEP-ALIVE). Updates `last_seen` only — does NOT overwrite `last_source` (preserves the real data source like `home_connect`, `local_poll`). IR remotes show "Alive" status via `last_seen` freshness check (< 2h + no DPS).
- **Net_devices IP writeback**: for local Tuya devices, writes IP + `last_online` to `net_devices` every 5 min per device (throttled). Complements ARP scanner which can't detect some Tuya devices.
- Scripts: `scripts/ha_api_patched.py` (HA adapter), `scripts/tuya_adapter_patched.py` (Tuya adapter)
- **BSH/Home Connect** (Siemens appliances): `home_connect` adapter, 6 appliances (Dishwasher, Oven, Hob, Hood, Microwave, Washer). `RemainingProgramTime` displayed as minutes, `ProgramFinished` as event. DPS labels must be added per device for dashboard visibility.

### Hot Water Consumption Classification
- Boiler agent detects drops → publishes to MQTT `mur/home/device/boiler/event` with valve context (`valve_state`, `valve_on_min`, `valve_off_min`)
- Rule `Boiler Consumption Classify` classifies into 5 categories (priority order):
  1. `human` — presence in Bathroom/Kitchen/My BathRoom (always wins)
  2. `panel` — valve was ON ≥ 4 min, no human (solar cycle drop)
  3. `thermal` — nobody home (overnight/away cooling)
  4. `boiler` — valve OFF ≥ 10 min, someone home (natural day cooling)
  5. `unknown` — fallback
- Writes `cause` + `likely_rooms` back to `boiler_consumptions` table

## LXC Infrastructure
> ⚠️ **LXC 104 = COMMANDS/TIMERS SERVER — all scheduled tasks, cron jobs, and systemd timers go here**
- Before deploying any timer/cron/systemd service to an LXC, confirm target is LXC 104

| ID | Type | Role | IP |
|----|------|------|----|
| 100 | LXC | Media Agent (TV + Soundbar) | 192.168.1.138 |
| 101 | VM | Home Assistant | 192.168.1.110 |
| 102 | LXC | PostgreSQL DB | 192.168.1.219 |
| 103 | LXC | App / Agents + Zigbee2MQTT | 192.168.1.114 |
| 104 | LXC | Commands / Timers | 192.168.1.227 |
| 105 | LXC | Orchestrator + Rule Engine | 192.168.1.187 |
| 106 | LXC | Voice | 192.168.1.188 |
| 107 | LXC | MQTT Broker (Mosquitto) | 192.168.1.189 |

## Domain Rules
- All temperatures are in **Celsius**.
- The `valve_state` logic: `true` means the panel water flow is ON, `false` means OFF.


## LXC Audit Procedure
When asked to **audit** or **clean** any LXC (e.g. "audit lxc 104"), always run ALL of the following checks before declaring clean:
1. `/root/` — list all files, inspect unknowns
2. `/tmp/` — list non-systemd files
3. `/opt/` — list dirs, check for leftover/unused scripts
4. `crontab -l` — list all cron jobs, flag anything not related to the LXC's role
5. `ps aux` — list running processes, flag unknowns
6. `systemctl list-units --type=service --state=running` — flag unexpected services
7. Report findings in a table: Item | What it is | Recommended action
8. Only declare "clean" after all 7 checks pass

## Formatting Preferences
- When showing data, prefer **Markdown Tables**.
- If I ask for a trend, suggest a **Chart** or a summary of the min/max/average.

---

## Rules Time-Travel Architecture

Rules on LXC 105 query `device_events` at any historical timestamp to get accurate state — they do NOT rely on MQTT payload context or in-memory timers for historical judgment.

**Data access helpers in `RULES/state_manager.py`:**
- `get_device_state_at(device_id, at_ts)` — latest dps for device at or before ts
- `get_last_transition_before(device_id, dps_key, at_ts)` — most recent change
- `get_events_between(device_ids, from_ts, to_ts)` — raw events for any list of devices in range
- `db_execute()` returns rowcount; logs warning on 0-row UPDATE/DELETE (silent data-loss guard)

**Split DB connection (2026-04-14):** state_manager holds two connections — `self.conn` (+ `_db_lock`) for rule-driven ops (db_execute, db_query, emit_virtual_event, get_* helpers), and `self._hb_conn` (+ `_hb_lock`) exclusively for the heartbeat thread (load_from_db, load_shared_state, save_shared_state, _write_heartbeat). Prevents `save_shared_state`'s 167-row upsert (~200ms) from blocking rule emissions. Max emission time dropped from 225-255ms to 2-6ms.

**Virtual devices** — derived states from rules live in `device_events` too, using `virtual:<name>` id prefix. Registered in `devices` table (device_type='virtual', protocol='virtual') so they appear on dashboard. Rules emit via `state.emit_virtual_event(virtual_id, dps, source, ...)` which dedupes against prior state.

Current virtual devices:
- `virtual:home_activity` (owner: Home Activity rule) — legacy: `active_rooms`, `activity_level`, `active_room_count`, `last_motion_room`; **apartment-vision (2026-04-24):** `active_zones`, `active_zone_count`, `last_motion_zone`, `door_state` (map of door-name → 'open'|'closed')
- `virtual:people_home` (owner: People Home rule) — legacy: `people_home`, `home_mode`, `someone_home`, `occupied_rooms`; **apartment-vision (2026-04-24):** `people_confidence` (high|medium|low|**transit**|**recalculating**), `last_entered_via`, `last_exited_via`, `last_transition_ts`, `people_count_state` (**stable**|**transit**|**recounting**), `people_count_floored`, `people_count_high_water`, `people_count_live`, `last_transition_source` (`door_sensor` | `inferred_entry` | `inferred_exit`)
- `virtual:boiler_status` (owner: Boiler Consumption Classify) — `last_cause`, `last_drop_c`, `last_rooms`, `last_start_ts`

**Apartment-vision upgrade (2026-04-24):** Home Activity + People Home now consume `state.spatial` — a zone/adjacency/sub-rooms index built by `state_manager.load_from_db()` from `dashboard_settings.room_layouts.*` + `room_device_placements`. Cone-to-zone geometry (point-in-polygon, 1m cells) ported from `buildApartmentScene` in server.js. Each sensor placement gets `zones` (full cone coverage) + `primary_zone` (zone at beam midpoint) — activity uses primary_zone to avoid edge-overlap false activations.

**Room classification in People Home counting (2026-04-24):**
- **Sub-room folding**: Kitchen auto-folded via zone-name heuristic; Dining Room + Entrance manually folded via `DEFAULT_MANUAL_SUBROOM_MERGE` (their parent zones named "Dining Table" / separate layout don't match the auto heuristic). All fold to Living Room — the open-plan living area counts as 1 room, not 4.
- **Transit-only rooms (`DEFAULT_TRANSIT_ROOMS`)**: Hallway. Walked through but not counted. Still shows in `active_rooms` / `occupied_rooms` (so the dashboard lights up Hallway when someone walks through) but excluded from `presence_rooms` / `people_count`.
- **Exterior (`DEFAULT_EXTERIOR_ROOMS`)**: Corridor (building hallway outside flat). Excluded entirely from count; used as Tier-1 signal for inferred transit.
- **Exterior motion**: Ring Doorbell (camera at Main Door). Same treatment — Tier-1 signal, not counted.
- **Counted rooms**: Living Room (open-plan parent), Balcony (separate room via sliding door), Bedroom, My BathRoom, Guy Room, DressRoom, Bathroom, Laundry, BedRoom Balcony.

**Main-Door-locked count (2026-04-24 strict v3 — door-event-driven only):** `people_home` changes ONLY on Main Door close events (real or inferred). Between door events the count is locked. No asymmetric UP, no sustain counters, no high-water mark — only door events move it. Three explicit visual states published via `people_count_state`:

| state | trigger | dashboard | confidence |
|---|---|---|---|
| `transit` | Main Door `open` | `--` (amber italic) | `transit` |
| `recounting` | Main Door just closed → inside the `door_close_stabilize_sec` window | `**` (amber italic) | `recalculating` |
| `stable` | window elapsed → `people_home` = live_count snapshot | integer | `high` / `medium` / `low` |

Flow: Main Door open → state=`transit`, `people_home` stays at previous lock; Main Door close → state=`recounting`, `_post_door_stabilize` timer starts; when timer elapses → snapshot `live_count` → new lock → state=`stable`. Inferred Tier-1↔Tier-3 transit (exterior Corridor / Ring Doorbell ↔ interior Entrance presence, within `transit_sequence_window_sec`) triggers the same recount path — handles a dead Main Door sensor. Initial boot seeds the lock from the first live reading.

**Stabilize window is auto-sized (2026-04-24 hold-aware):** each placement carries `hold_s` in `room_device_placements.params` (5 s radar, 15 s motion). The rule reads `hold_s` per counted-room sensor via `state.spatial['device_to_zones']` and computes `auto_stabilize = max(hold_s) + 5 s margin`. `people_home.door_close_stabilize_sec` (Settings knob, default 15 s) is now a **floor** — effective window = `max(knob, auto_stabilize)`. So if a motion sensor has 15 s hold, the recount waits 20 s; user can bump the knob higher if they want, but can't go below the auto-computed minimum. Prevents stale-hold over-counts at recount time.

**Constant vs Dynamic People count (2026-04-24):** People Home now emits two counts side-by-side for the Main Agent dashboard:

- **Constant** (`people_home`) — the locked count. Only changes on Main Door events (real or inferred). Conservative, audit-trustworthy.
- **Dynamic** (`people_home_dynamic`) — Constant + `discovered_count`. Can ONLY go up between door events; snaps back to Constant at every door event.

`discovered_count` climbs when a 4-signal test passes: (1) room NOT in lock-time snapshot (`_people_lock_rooms`), (2) room NOT already accounted via a recent corridor transit (`_people_accounted_rooms` populated when `corridor:A>B` timer fires), (3) room continuously active for ≥ 2 × max(hold_s) for its sensors (rising-edge timer `room_first_active:<room>`), (4) same room was a candidate last tick AND this tick (2-tick sustain filters single-tick glitches). All 4 must pass. Catches slow-wake sleepers / mmWave blind-spot reveals without bumping on same-person walk-in-and-stay.

Dashboard (`main-agent.html` + `main-agent.js`) renders both chips — "Constant People" + "Dynamic People" — both honoring the transit ("--") / recounting ("**") / integer states. Dynamic chip italic to signal "derived."

Emitted People Home diagnostic fields (in addition to legacy fields):
- `people_home` — **locked** count (what the dashboard reads)
- `people_count_state` — `stable` | `transit` | `recounting` (drives dashboard `--` / `**` / N rendering, read from `state.shared` by dashboard main-agent.js at polling cadence 5 s)
- `people_count_high_water` — locked count (alias retained for continuity)
- `people_count_live` — what sensors currently say, pre-lock (diagnostic)
- `people_count_floored` — `true` when `live != locked` (lock is holding)
- `people_confidence` ∈ {`high`, `medium`, `low`, `transit`, `recalculating`}
- `last_transition_source` — `door_sensor` | `inferred_entry` | `inferred_exit`

**Auto-reload on spatial changes:** dashboard writes `_spatial_reload_request='pending'` to `rule_engine_state` on any `POST /api/room-layouts/:slug`, `POST/PATCH/DELETE /api/room-device-placements/...`. The rule-engine heartbeat detects the flag within ≤60s, calls `state.load_from_db()` (rebuilds spatial + devices), and clears the flag. No manual Reload needed after layout edits.

**Sentence-tunable knobs:** heartbeat parses `dashboard_settings.apartment.rule_sentences` every 60s via `_parse_knob_sentences` regex patterns → writes to `state.shared` under `home_activity.*` / `people_home.*` keys. Rules read with `state.shared.get('<key>', <default>)`. Add a knob: append to `KNOB_PATTERNS` in `rule_engine.py` + author a matching sentence in Main Agent → Base Rule Settings → *container*.

**Switch-retain suppression (2026-04-23):** Home Activity's switch dispatch path now only fires `room_active:*` + `room_interact:*` timers when the switch state *signature* (dps keys excluding `last_seen`/`linkquality`/`battery`/etc.) differs from the previous signature. Fixes a bug where Zigbee retain messages containing the full state payload (e.g. `state_l1=OFF` unchanged) were perpetually marking Hallway active.

**Scope:** real-time sync applies to **discrete state changes** (switches, motion, valve, door, presence, etc.) — these are already in `device_events` via device agent. Continuous analog (temps, weather, UV, illuminance) stay in their own time-series tables.

**Pattern for future rules:**
- Consume state → use the 3 helpers; never trust MQTT payload for historical state
- Produce state → emit via `emit_virtual_event` on change; keep `state.shared` for live reads too
- Writes that matter → check rowcount return from `db_execute`
- Scaling → prefer specific `triggers=["device_id", ...]` over wildcard `["*"]`; for wildcard rules, filter + early-return in first 2 lines

**Rule groups:**
- `boiler` — Boiler Consumption Classify and future boiler rules
- `info` — Home Activity, People Home (global aggregators)
- `living-room` — Wallmote Handler and future Living Room automations (bindings stored in `dashboard_settings.living-room.*`)
- `pixoo` — Daily_Welcome (always-on default, priority 90) and future Pixoo64 display rules (alarms, notifications, status banners — use a smaller priority number so they override the welcome screen)

**Display chips in sentences (Awtrix + Pixoo, added 2026-05-02):** the dashboard's `+Dev` device picker (shared `device-picker.js`) renders action sub-buttons when the picked device is `device_type='display'`: `[on] [off] [push <preset>]`. Tokens emitted: `@Awtrix on`, `@Pixoo push Welcome`, etc. Awtrix saved-app list comes from `dashboard_settings.awtrix.messages`; Pixoo presets from `/api/pixoo/presets`. **Rule engine dispatch**: `protocol='awtrix'` branch in `rule_engine._dispatch_command` routes `power_on`/`power_off` → `<device_id>/power` and `push_preset` → loads template from `dashboard_settings.awtrix.messages`, substitutes `{{var}}` (cmd.vars first, then state.shared), publishes `<device_id>/notify`. **Shared parser**: `RULES/_display_chips.py` exposes `parse_display_chip(token, devices_by_name)` → command-dict-or-None, used by Evening Lights (s_el1 device list) and Start Away Mode (s_sa4/s_sa5 preset chips) so the same chip syntax works in both rules. Recognizes legacy `@Pixoo Start Away` + new `@Pixoo push Welcome` / `@Awtrix push Notify`. Required ACL on LXC 107: `rule_engine` has `topic write awtrix_05ec2c/{power,notify}` (added 2026-05-02 alongside existing `awtrix/+/custom` and `awtrix/+/notify`).

---

## Claude Hooks (`.claude/`)

Hooks run automatically on tool use. Configured in `.claude/settings.json` and `.claude/settings.local.json`.

| Hook | Trigger | File | What it does |
|------|---------|------|-------------|
| Architecture guard | `PreToolUse: Edit` on `server.js` | `settings.local.json` (inline) | Blocks business logic being added to server.js; enforces LXC architecture rule |
| LXC pre-check | `PreToolUse: Bash` | `.claude/hooks/pre-lxc-check.sh` | Validates SSH targets before running bash commands on LXCs |
| Prettier format | `PostToolUse: Edit\|Write` on `*.html` / `*.css` | `settings.json` (inline) | Auto-formats HTML/CSS with `npx prettier --write` |
| HTML lint | `PostToolUse: Edit\|Write` on `*.html` | `.claude/hooks/post-html-lint.sh` | Checks duplicate IDs, orphaned TAB comments, dead inline handlers |
| New DB table alert | `PostToolUse: Edit\|Write` on `*.js` / `*.sql` / `*.py` | `settings.json` (inline) | Warns when `CREATE TABLE IF NOT EXISTS` detected — add to retention_policies + DB Volumes |
| /tmp cleanup | `PostToolUse: Bash` | `.claude/hooks/post-tmp-cleanup.sh` | Removes local and remote /tmp working files after scp/tmp commands |
| Docs check | `PostToolUse: Bash` (git commit) | `.claude/hooks/post-commit-docs-check.sh` | After git commit, warns if no CLAUDE.md was updated — prints checklist of root/module docs + memory |

## Infrastructure Connections

### Windows Laptop (192.168.1.128)
- **OpenSSH Server** installed — LXC 103 can SSH/scp in as `muroc@192.168.1.128`
- **SMB1** enabled — required for QNAP SMB access via `\\192.168.1.155\...`
- LXC 103 authorized key: `/c/ProgramData/ssh/administrators_authorized_keys`
- Firewall rule: port 22 inbound allowed

### QNAP NAS (192.168.1.155)
- **NFS exports**: `/PBS_Data` (HA), `/Media` (10.0.0.2), `/Laptop_Data` (LXC 103 + Proxmox host)
- **SMB shares**: `Claude_Data` (project backups), `Windows_Data` (full image backups), `Laptop_Data`, `PBS_Data`, `Media`, `Public`
- **SMB user**: `claude` — has read/write on `Claude_Data` and `Windows_Data`
- **Proxmox host** mounts `/Laptop_Data` at `/mnt/qnap-laptop` → bind-mounted into LXC 103 at `/mnt/qnap-laptop`

### Orphan Process Guards
- **LXC 100**: `/opt/media-agent/kill-orphan.sh` in `ExecStartPre` for player, ingest, pixoo, media-agent services
- **LXC 105**: `/opt/main-agent/kill-orphans.sh` in `ExecStartPre` for rule-engine service

### LXC 100 (192.168.1.138) — Media Agent Services
- **Services**: `media-agent` (tv_control.py:8765), `player` (player_service.py:8766), `ingest` (ingest_service.py:8767), `pixoo` (pixoo_service.py:8768-8769), `analyzer` (analyzer.py)
- All use `HA_TOKEN` from `/etc/environment`
- **Orphan guard**: all 4 services (except analyzer) have `ExecStartPre=/opt/media-agent/kill-orphan.sh <script>` to kill stray processes before starting — prevents port-conflict crash loops
- **Local script**: `scripts/lxc100-kill-orphan.sh`
- ⚠ When HA token is renewed, update `/etc/environment` here AND restart media-agent — otherwise TV control silently fails
- **Restart**: `systemctl restart media-agent player ingest pixoo` — orphan guard handles cleanup automatically

### LXC 103 (192.168.1.114) — Connections
- SSH → Windows laptop: `ssh muroc@192.168.1.128` (key auth, no password)
- SMB → QNAP: `smbclient //192.168.1.155/<share> -U claude%<pass>` (`smbclient` installed)
- NFS → QNAP: `/mnt/qnap-laptop` (bind-mounted from Proxmox host, always available)
- HA token locations: `/etc/environment` (collect_weather cron) + `/etc/boiler-agent.env` (consumed by both `boiler-agent.service` AND `boiler-mqtt-ingest.service`) — both must be updated together when the token rotates, and both services restarted after updating the env file
- **systemd services**: `device-agent` (Tuya + HA + Z2M bridge, publishes to `mur/home/device/#`), `boiler-agent` (boiler decision loop, cron-driven internally), `boiler-mqtt-ingest` (since 2026-04-23 — subscribes to WF96C MQTT events, writes raw_data; replaces the old `ha_to_pg` cron), `zigbee2mqtt`
- **Zigbee2MQTT**: `/opt/zigbee2mqtt`, systemd service `zigbee2mqtt`, frontend on port 8080, USB dongle EFR32 (ember adapter) at `/dev/ttyUSB0`
- Z2M connects to Mosquitto on LXC 107 (`mqtt://192.168.1.189:1883`), user `zigbee` / password in Z2M config

### LXC 107 (192.168.1.189) — MQTT Broker
- **Mosquitto** only — dedicated message bus, no other services
- Config: `/etc/mosquitto/conf.d/*.conf` — listener 1883, auth required, password file `/etc/mosquitto/passwd`, ACL file `/etc/mosquitto/acl`
- Persistence: `/var/lib/mosquitto/mosquitto.db`
- Log: `/var/log/mosquitto/mosquitto.log` (logrotate daily, 7 rotations)
- **Users (ACL)**: `zigbee` (zigbee2mqtt/#), `device_agent` (mur/home/device/#), `hasp` (hasp/#), `awtrix` (`readwrite awtrix/#` + `readwrite awtrix_05ec2c/#` for the device's actual prefix — firmware 0.98 strips slashes so the live prefix is `awtrix_05ec2c` not `awtrix/awtrix_05ec2c`), `dashboard_browser` (added 2026-04-29 for the Awtrix dashboard tab — narrow ACL: `write awtrix_05ec2c/notify`, `write awtrix_05ec2c/notify/#`, `write awtrix_05ec2c/nextapp`, `write awtrix_05ec2c/custom/#`, `write awtrix_05ec2c/power`, `write awtrix_05ec2c/settings`, `write awtrix_05ec2c/reboot`, `read awtrix_05ec2c/stats`), `rule_engine` (read all + write commands + rule-engine topics + zigbee2mqtt/+/set), `pixoo_service` (pixoo topics), `boiler_agent` (write `mur/home/device/boiler/#` for consumption events AND read `mur/home/device/116508838cce4eef9273/#` so `boiler-mqtt-ingest.service` on LXC 103 can consume WF96C temperature events — added 2026-04-23), `esp_boards` (added 2026-05-02 — single shared user for ALL ESP8266/ESP32 boards in the project; ACL: `readwrite mur/home/esp/+/#` + `readwrite homeassistant/sensor/+/#` + `readwrite tele/+/LWT` + `read HOME_REQUEST` for the existing RemoteXY board's HA discovery + LWT topics + cross-broker bridge). Also: `rule_engine` was extended with `topic readwrite mur/home/esp/+/#` so the dashboard's POST /parameters and /command endpoints (which publish via `rule_engine` MQTT credentials) can write to the ESP topics, and the rule engine ingest can read them
- **WebSocket listener** on port 9001 (`listener 9001 / protocol websockets / allow_anonymous false` in `/etc/mosquitto/conf.d/default.conf`, added 2026-04-29) — used by the dashboard's Awtrix tab so the browser can publish MQTT directly without going through server.js. TCP 1883 listener still serves all backend services.
- **Z-Wave devices** (Aeotec sensors, Wallmotes) stay on SmartThings hub → HA WebSocket → device agent. Cannot go local without a Z-Wave USB dongle.
- **Ring devices** (Doorbell, Chime) connected via HA Ring integration → HA WebSocket → device agent. Events (ding/motion), battery, chime control, volume work. Camera snapshots require Ring Protect subscription (not active). Auth token + python-ring-doorbell venv at `/opt/ring-snapshot/` on LXC 103 for future use.

### LXC 104 (192.168.1.227) — Windows Backup Agent + Group Health Watchdog
- **Backup script**: `/opt/backup-script.sh` — runs every 5 min via cron
- **Group Health Watchdog**: `/opt/group_health_watchdog.py` — runs every 5 min via cron
- **Local scripts**: `scripts/backup-script.sh`, `scripts/group_health_watchdog.py`
- **Cron**:
  ```
  */5 * * * * /opt/backup-script.sh >> /var/log/backup-script.log 2>&1
  */5 * * * * /usr/bin/python3 /opt/group_health_watchdog.py >> /var/log/group-health.log 2>&1
  ```
- **Mounts**: `/mnt/qnap-claude` (QNAP Claude_Data), `/mnt/qnap-windows` (QNAP Windows_Data) — pre-mounted CIFS, always available
- **DB tables**: `backup_storages`, `backup_jobs`, `backup_log`, `system_alerts` (watchdog writes here) on LXC 102
- **Backup Logic**: reads jobs from DB → SSH-checks laptop reachability → scp source → QNAP mount → logs result → rotates old copies
- **Watchdog Logic**: groups devices by (protocol, last_source), checks freshness of each group vs cadence threshold, alerts to `system_alerts` when a group is silent but others are fresh (catches HA sub-integration hangs like SmartThings/Ring stuck). Phase 1 = alert-only, no auto-recovery. Writes alert_type = `group_stale:<protocol>:<source>`; auto-resolves when group recovers.
- **Deploy**: `scp scripts/backup-script.sh root@192.168.1.227:/opt/backup-script.sh` / `scp scripts/group_health_watchdog.py root@192.168.1.227:/opt/group_health_watchdog.py`

### LXC 105 (192.168.1.187) — Rule Engine
- Runs on LXC 105 as `rule-engine.service` with orphan guard (`ExecStartPre=/opt/main-agent/kill-orphans.sh`)
- Global DAG sort for depends_on, load-error alerts, stats persistence, save-failure alerts, db_execute single retry on failure
- Test button: honors RULE["test_event"], state_updated status for info rules
- Current rules: Home Time Periods, Mode Buttons, Home Activity, People Home, Boiler Consumption Classify, Wallmote Handler, Evening Lights, Start Away Mode, Daily_Welcome (pixoo)
- **Live RULE dict pattern:** the engine mutates each rule's `module.RULE['conditions']` in place when applying dashboard DB overrides (`_rule_overrides` key in `rule_engine_state`) — so reading e.g. `RULE.get('conditions',{}).get('time',{}).get('before')` at eval time automatically reflects the current override. Use this instead of redefining the value as a second constant. `Daily_Welcome` derives its end-of-day wipe time from the live window `before` so the dashboard's time-window editor moves the wipe too (single source of truth).
- External converter: `/opt/zigbee2mqtt/data/external_converters/tuya_scene_switch.js` (DPs 24/25/26)
- **Heartbeat tick (2026-04-23):** `RuleEngine._heartbeat_loop` emits a synthetic `{device_id:'heartbeat', source:'tick'}` event once per 60s and dispatches it through the normal rule-firing path. Rules declare `triggers=["heartbeat"]` to fire on the tick — used by time-based rules (e.g. Layer 0 `home_time_periods.py` time-mode + sun event derivation) to re-evaluate boundaries during quiet periods when no real device events fire. A `_dispatch_lock` serializes rule-firing between the paho callback thread and the heartbeat thread to keep group-active tracking + shared-state mutations consistent.
- **Home Time Periods (Layer 0, renamed from `home_state.py` 2026-04-26):** sentence-driven time-mode + sun events. Reads time-window sentences from the "Home Time Periods" container (`between <HH:MM | sun_event> and <HH:MM | sun_event> time_mode is <name>`; sun tokens: `dawn`/`sunrise`/`noon`/`sunset`/`dusk`) and lat/lon from the "Apartment Location" container; computes today's + tomorrow's sun events via the `astral` library; writes `state.shared['time_mode', 'day_of_week', 'dawn'..'dusk', 'next_sunrise', 'next_sunset']` and emits `virtual:home_state` (id retained for backwards compat). `next_sunrise` / `next_sunset` are "today's event if still upcoming, else tomorrow's" — surfaced live in the Main Agent tab bar (right side, alongside `time_mode`).
- **Mode Buttons (Layer 0, sole owner of `state.shared['home_mode']` 2026-04-25):** sentence-driven interpreter for base rule 2 ("Home/Away/Abroad Buttons", id `r_modebuttons_init`). Each declared button (`@<dev chip> represents <home|away|abroad> mode`) is watched on every event; on transition the active mode wins (single ON → that mode; multiple ON → most-recent transition). **Default-to-HOME**: all 3 buttons must be continuously OFF for `mode_buttons.default_home_cooldown_sec` (sentence-tuned, no Python fallback) before the rule emits `turn_on` to the HOME button. TTL cache (30 s) on the bindings; wildcard early-filter so non-button events return in 2 lines. No other rule writes `home_mode`.
- **Evening Lights (action rule 2026-04-26, gate sentence added 2026-04-29):** sentence-driven turn-on rule. Two firing scenarios — (A) **sun-anchor kick-in**: wall-clock minute equals any sun-event anchor declared in `s_el2` (e.g. `sunset+10`, `dusk-5`). Anchors resolve via `state.shared['<event>']` ISO strings published by Home Time Periods, with `(h*60+m+offset) % 1440` for wrap. Decoupled from `time_mode` — fires at perceptual "low light" regardless of which time-mode window we're in. (B) **late arrival**: `home_mode` just transitioned `away|abroad → home` AND current `time_mode` is in the time_mode names declared in `s_el2`. The `s_el2` list mixes both kinds: items matching `^(dawn|sunrise|noon|sunset|dusk)([+-]\d+)?$` are anchors (Scenario A); plain words are time_mode names (Scenario B). Example: `Evening Lights: active time modes are sunset-10, evening, twilight, late_night`. **Sentence-driven gates (`s_el3`)**: `Evening Lights: only fires when <state.shared key> is <value>` — multiple gate sentences AND-combined; applies to BOTH scenarios. The previous hardcoded `home_mode == 'home'` check at the fire line was removed and replaced with this generic gate parser so all conditions are visible in the dashboard rather than hidden in Python. Example gate sentence: `Evening Lights: only fires when home_mode is home`. If no gate sentence is authored, no gate is applied (Scenario A would fire at the sun anchor regardless of mode; Scenario B is still naturally gated by its `home_just_arrived` check). Device list in `s_el1` (`evening lights are @<Device> <Channel>, …`). Display-device chips are recognized via the shared `RULES/_display_chips.py` parser (added 2026-05-02): an Awtrix or Pixoo chip in s_el1 fires `power_on`/`power_off` or `push_preset` instead of `turn_on`, depending on the chip's action suffix (`@Awtrix on`, `@Pixoo push Welcome`, …). **Latched per home period + per calendar day** — once fired, won't refire until either (a) `home_mode` leaves `home` and comes back, OR (b) the calendar day changes (daily reset, added 2026-05-01: tracks `_evening_lights_fired_date`; without this, a continuously-home user — vacation week, WFH — never re-fires after the first night). Safe no-op when both anchors and modes are empty. depends_on: `["Home Time Periods", "Mode Buttons"]`.
- **Start Away Mode (action rule 2026-04-26):** sentence-driven 2-phase rule that fires on `home_mode` rising-edge to `away`. Container "Start Away Mode" with 5 sentences — `s_sa1` `Start Away: turn off all lights and tvs` (device-type families to bulk-OFF; aliases in `DEVICE_TYPE_ALIASES`), `s_sa2` `Start Away: device set ON is @<DeviceChip>` (single fake-presence device — chip appended via +Dev), `s_sa3` `Start Away: keep on for N seconds|minutes|hours` (duration X — accepts integer or decimal), `s_sa4` `Start Away: initial preset is <PresetName>` (Pixoo preset pushed at entry with live `{{countdown}}` token = `now + X` epoch; resolves chips in both legacy `@Pixoo PresetName` and new picker format `@Pixoo push PresetName` / `@Awtrix push SavedAppName`), `s_sa5` `Start Away: final preset is <PresetName>` (preset after countdown — same chip formats accepted). Phase 1 (entry): bulk-OFF + turn_on s_sa2 device + push s_sa4 preset; sets timer `start_away_t0`. Phase 2 (X elapsed, still away): turn_off s_sa2 device + push s_sa5 preset. **Latched per home period** — re-pressing AWAY during phase 1 doesn't refire; latch resets only when `home_mode` leaves `away`. Safe no-op when any of the 5 fields unparsed. Iteration over `state.devices` happens only in the once-per-period Phase-1 branch. group=`away`, priority=10, depends_on: `["Mode Buttons"]`. Known limitation: Daily_Welcome's 30-min push will overwrite the Pixoo preset during 08:00–23:59 if user goes away in that window — fix for later.

---

## Project Modules
Each project has its own CLAUDE.md with full details:

| Module | Folder | CLAUDE.md |
|--------|--------|-----------|
| Boiler Agent | `BOILER/` | `BOILER/CLAUDE.md` |
| Media Agent | `MEDIA/` | `MEDIA/CLAUDE.md` |
| Orchestrator | `ORCHESTRATOR/` | `ORCHESTRATOR/CLAUDE.md` |
| Rule Engine | `RULES/` | see `docs/rule-engine/tech-design.md` |
| Voice System | `VOICE/` | `VOICE/CLAUDE.md` |
| Corridor Agent | `CORRIDOR/` | `CORRIDOR/CLAUDE.md` — dashboard-only (Pixoo editor); service runs on LXC 100 as `pixoo_service` |
| Living Room Agent | `LIVING_ROOM/` | `LIVING_ROOM/CLAUDE.md` — dashboard-only; wallmote bindings + floor-plan layout editor (foundation for AI spatial investigations) + future scenes/lights |
| Balcony Agent | `BALCONY/` | `BALCONY/CLAUDE.md` — dashboard-only OpenHASP touch panel (Sunton ESP32-S3 4848S040 at 192.168.1.141, 4.0″ 480×480, 12 pages, hostname `balcony`). Page 1 has 4 toggle buttons (Gates, Barrier, Light 1, Light 2). MQTT prefix `hasp/balcony/` on broker LXC 107. `pages.jsonl` version-controlled in folder, regen via `BALCONY/build_pages.py`. Pattern: each room with a HASP panel = its own dashboard agent folder. |
| UPS subsystem | `UPS/` | `UPS/CLAUDE.md` — APC Back-UPS BX2200MI orchestrated shutdown. Master apcupsd on PVE host (USB), NIS slave on LXC 105 (observer), 60-s polling daemon writes to `ups_status` on LXC 102, dashboard surface on Project Health → UPS tab. Routine updates via `/pss-update` skill. |
| Scripts (LXC 100) | `scripts/` | see `MEDIA/CLAUDE.md` |
| Windows Backup (LXC 104) | `scripts/backup-script.sh` | see root `CLAUDE.md` LXC 104 section |

**Convention**: every named agent has a top-level `<AGENT>/` directory with at least a `CLAUDE.md` index file, regardless of whether it has a dedicated LXC service. Dashboard-only agents (Corridor, Living Room) use their CLAUDE.md as the index pointing to canonical artifact locations (dashboard HTML/JS, rules, migrations, etc.) — because the codebase structure forces those files to live in shared directories like `BOILER/dashboard/public/` and `RULES/rules/`.

## System-Wide Dashboard Pages

### Project Health Page (sidebar: General → Project Health)
- **System Status card**: live status of all services; fetched from `/api/health/status`; displayed in a 4-column grid:
  - All checks are performed **by the dashboard directly** (not by the orchestrator). Orchestrator contributes only via `system_alerts` table entries.
  - **Infrastructure** (direct checks): `postgres` — DB query; `homeassistant` — HA API; `vm101`/`lxc100`–`lxc106` — TCP port 22 reachability; `ups` — latest row from `ups_status` (DB query). `ok` requires status ∈ {`ONLINE`, `ONLINE SLAVE`} AND `age_sec ≤ 180` (catches both `COMMLOST` and a stalled polling daemon). `svc-ups` cell on the page is clickable → opens UPS tab. Counted by the sidebar Status badge alongside the other infra checks (added 2026-04-29).
  - **Server**: `pm2` — all pm2 processes online
  - **Services**:
    - `boiler_agent` — boiler service on LXC 103 (via `system_alerts`: red if active `service_down`/`service_ssh_failed`)
    - `media_agents` — analyzer, player, ingest on LXC 100 (via `system_alerts`: shown as 3 inline dots)
    - `voice_agent` — whisper-http on LXC 106 (via `system_alerts`: red if active `service_down`/`service_ssh_failed`)
  - **Scripts / Ingest** (direct DB/SSH checks):
    - `wf96c_ingest` (dashboard key still `ha_to_pg` for back-compat) — age of last `raw_data` row ≤ 15 min (DB query). Source switched from HA-polling cron to event-driven MQTT consumer on 2026-04-23; see [BOILER/CLAUDE.md](BOILER/CLAUDE.md#data-flow).
    - `collect_weather` — age of last `raw_weather` row ≤ 65 min (DB query)
    - `auto_scan` — age of `/var/log/auto_scan.log` on LXC 100 ≤ 120 s (SSH)
  - **Data freshness** (DB queries):
    - `boiler_last_decision` — age of last `agent_boiler_data` row ≤ `run_interval_min × 3`; shows age + decision
    - `orchestrator_last_run` — age of last `orchestrator_log` row ≤ 70 min; shows age
    - `active_alerts` — count of unresolved `system_alerts`; shows worst severity
- **Orchestrator Log card**: last N entries from `orchestrator_log` table; severity colour-coded (info/warn/error); shows last run time + status summary; `GET /api/health/orch-log?limit=N`
- **DB Volumes card**: table row counts, disk size, dead tuples, frag %, last vacuum per table; fetched from `/api/health/db-volumes` using `pg_stat_user_tables`; each row has a **Vacuum** button — runs `VACUUM ANALYZE` and updates dead tuples + frag % inline. **Adding a new table to the view requires two edits in the `/api/health/db-volumes` handler in `server.js`**: append the table name to the `tables` array AND add a `tsCol[<table>] = '<timestamp_col>'` entry (or `null` if the table has no time column) so the oldest/newest range query works. The `new-DB-table-alert` post-tool hook nudges this on every new `CREATE TABLE`, but the handler is the source of truth — neither retention_policies seed nor the table existing in pg is enough on its own.
- **Retention Policies card**: editable table per DB table — keep_days (blank = forever), auto_clean toggle, clean_interval_hours, last_cleaned timestamp; Save per row, Clean per row, "Clean All Now" global button
  - Policies stored in `retention_policies` DB table (not config file — so orchestrator reads/writes them programmatically)
  - Default policies seeded on first run: raw_data=90d, agent_boiler_data=365d, raw_weather=60d, raw_weather_daily=60d, boiler_consumptions=forever, orchestrator_log=30d, system_alerts=90d, sync_signals=7d
- **API endpoints:**
  - `GET /api/health/status` — checks PostgreSQL, HA, TCP to all LXCs, PM2; boiler-agent + media agents + voice agent (all via system_alerts); ha_to_pg + collect_weather freshness (DB); auto_scan log age (SSH); orchestrator last run age; boiler last decision age; active alerts count
  - `GET /api/health/orch-log?limit=N` — last N orchestrator log entries
  - `GET /api/health/db-volumes` — row counts + sizes + date ranges per table
  - `GET /api/health/retention` — all retention policies
  - `POST /api/health/retention` — update one policy `{table_name, keep_days, auto_clean, clean_interval_hours}`
  - `POST /api/health/cleanup` — run cleanup `{table_name}` (null = all); returns `{results:[{table_name, deleted}]}`
  - `POST /api/health/vacuum` — run `VACUUM ANALYZE {table_name}`; returns `{ok, dead_tup, frag_pct}` after
- **retention_policies table schema:** `table_name PK, keep_days INT nullable, auto_clean BOOL, clean_interval_hours INT, last_cleaned_at TIMESTAMPTZ, description TEXT`

### Project Health — System Alerts card
- Top card on Health page — shows all alerts (active first, resolved below with 50% opacity)
- Badge: `N active` (red/amber) or `all clear` (green)
- `GET /api/health/alerts` — returns last 50 alerts ordered active-first
- **Schema source of truth:** `server.js` `ensureSchema()` — `create_alerts.sql` was removed (was a duplicate)

### General Page / Weather (sidebar: General → Weather)
- **Today's Outlook card**: Solar Heating Potential (1–10) + Rain Probability (1–10) + Season; updated every 30 min
  - Scores computed on-the-fly in `/api/weather/scores` from latest `raw_weather` + today's `raw_weather_daily` — not stored in DB
  - Solar score: based on `condition` + `uv_index` (max of IMS and balcony); displayed as large colored number with description label (no icon)
  - Rain score: based on `condition` + `precipitation_mm` from today's forecast
  - Season: derived from current month (client-side, no API); Spring Mar–May, Summer Jun–Sep, Autumn Oct–Nov, Winter Dec–Feb
- **Current Conditions card**: reads latest row from `raw_weather` (no HA token needed on Windows dashboard)
- **Hourly Weather Log table**: last 24/48/72 rows from `raw_weather`
- **Daily Forecast Log table**: last 14/30 rows from `raw_weather_daily` (precipitation in mm)
- API endpoints: `/api/weather/scores`, `/api/weather/latest`, `/api/weather/hourly`, `/api/weather/daily`
- `collect_weather.py` cron runs every 60 min on LXC 103 (`0 * * * *`)