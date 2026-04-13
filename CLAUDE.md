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
| Main Agent | `main-agent.html` | Rule engine state, rules table, room grid |
| Device Agent | `devices.html` | All devices, Batt Devices, Set Devices, Rooms, Device History, Settings |
| Media Agents | `media.html` | TV + Soundbar control |
| Corridor Agents | `corridor.html` | Pixoo display editor + control |
| Project Health | `health.html` | System status, DB volumes, retention, alerts |
| Project Network | `network.html` | ARP scan, network devices |
| Weather | `general.html` | Weather data, solar heating potential |
| Voice | `voice.html` | Voice pipeline, intents, TTS |

### Sidebar (all pages)
- **Status badge**: `✓ OK` (green) / `⚠ N issues` (red blink) — polls `/api/health/status` every 60s
- **Battery badge**: `Batt ✓` (green) / `Batt Low - N` (dark red) — counts devices below low threshold + offline battery devices, polls every 60s
- Both managed by `alerts-monitor.js` (loaded on all 9 pages)
- Battery thresholds stored in `dashboard_settings` table (key `battery_thresholds`, default `{good: 60, low: 20}`)

### Dashboard DB Tables (system-wide, not module-specific)
- `dashboard_settings` — key/value store for dashboard-wide settings (battery thresholds, future settings). Retention: forever.
- `device_events` — device state changes from all protocols. Retention: 30 days.
- `devices` — device registry with last_state, dps_labels, dps_config, channel_config. Retention: forever.
- `rooms` — room definitions. Retention: forever.
- `net_devices` — ARP-scanned network devices. Used for MAC→IP resolution.

### Device Agent System
- Runs on LXC 103 as `device-agent.service`
- Protocols: local (Tuya TCP), gateway (Tuya sub-devices), cloud (Tuya cloud poll), zigbee (Z2M MQTT), zwave (HA WebSocket), ring (HA WebSocket)
- Source priority: tcp_push(5) = mqtt(5) > ha_api(4) > home_connect(4) > gateway_push(3) > cloud_push(3) > local_poll(2) > cloud_poll(1)
- HA adapter: SmartThings + Ring identifiers, initial seed restricted to external devices only
- Keepalive: hourly for IR remotes with no DPS (updates last_seen, shows "Alive" status)
- Scripts: `scripts/ha_api_patched.py` (HA adapter), `scripts/tuya_adapter_patched.py` (Tuya adapter)
- **BSH/Home Connect** (Siemens appliances): `home_connect` adapter, 6 appliances (Dishwasher, Oven, Hob, Hood, Microwave, Washer). `RemainingProgramTime` displayed as minutes, `ProgramFinished` as event. DPS labels must be added per device for dashboard visibility.

### Hot Water Consumption Classification
- Boiler agent detects drops → publishes to MQTT `mur/home/device/boiler/event`
- Rule `Boiler Consumption Classify` correlates with presence in Bathroom/Kitchen/My BathRoom
- Writes `cause` (human/thermal/unknown) + `likely_rooms` back to `boiler_consumptions` table

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
- HA token locations: `/etc/environment` (cron scripts) + `/etc/boiler-agent.env` (systemd service) — both must be updated together when token changes
- **Zigbee2MQTT**: `/opt/zigbee2mqtt`, systemd service `zigbee2mqtt`, frontend on port 8080, USB dongle EFR32 (ember adapter) at `/dev/ttyUSB0`
- Z2M connects to Mosquitto on LXC 107 (`mqtt://192.168.1.189:1883`), user `zigbee` / password in Z2M config

### LXC 107 (192.168.1.189) — MQTT Broker
- **Mosquitto** only — dedicated message bus, no other services
- Config: `/etc/mosquitto/conf.d/*.conf` — listener 1883, auth required, password file `/etc/mosquitto/passwd`, ACL file `/etc/mosquitto/acl`
- Persistence: `/var/lib/mosquitto/mosquitto.db`
- Log: `/var/log/mosquitto/mosquitto.log` (logrotate daily, 7 rotations)
- **Users (ACL)**: `zigbee` (zigbee2mqtt/#), `device_agent` (mur/home/device/#), `hasp` (hasp/#), `awtrix` (awtrix/#), `rule_engine` (read all + write commands + rule-engine topics + zigbee2mqtt/+/set), `pixoo_service` (pixoo topics), `boiler_agent` (write `mur/home/device/boiler/#` — publishes consumption events from LXC 103)
- **Z-Wave devices** (Aeotec sensors, Wallmotes) stay on SmartThings hub → HA WebSocket → device agent. Cannot go local without a Z-Wave USB dongle.
- **Ring devices** (Doorbell, Chime) connected via HA Ring integration → HA WebSocket → device agent. Events (ding/motion), battery, chime control, volume work. Camera snapshots require Ring Protect subscription (not active). Auth token + python-ring-doorbell venv at `/opt/ring-snapshot/` on LXC 103 for future use.

### LXC 104 (192.168.1.227) — Windows Backup Agent
- **Script**: `/opt/backup-script.sh` — runs every 5 min via cron
- **Local script**: `scripts/backup-script.sh`
- **Cron**: `*/5 * * * * /opt/backup-script.sh >> /var/log/backup-script.log 2>&1`
- **Mounts**: `/mnt/qnap-claude` (QNAP Claude_Data), `/mnt/qnap-windows` (QNAP Windows_Data) — pre-mounted CIFS, always available
- **DB tables**: `backup_storages`, `backup_jobs`, `backup_log` on LXC 102
- **Logic**: reads jobs from DB → SSH-checks laptop reachability → scp source → QNAP mount → logs result → rotates old copies
- **Deploy**: `scp scripts/backup-script.sh root@192.168.1.227:/opt/backup-script.sh`

### LXC 105 (192.168.1.187) — Rule Engine
- Runs on LXC 105 as `rule-engine.service` with orphan guard (`ExecStartPre=/opt/main-agent/kill-orphans.sh`)
- Global DAG sort for depends_on, load-error alerts, stats persistence, save-failure alerts
- Test button: honors RULE["test_event"], state_updated status for info rules
- Current rules: Home Activity, People Home, Boiler Consumption Classify
- External converter: `/opt/zigbee2mqtt/data/external_converters/tuya_scene_switch.js` (DPs 24/25/26)

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
| Scripts (LXC 100) | `scripts/` | see `MEDIA/CLAUDE.md` |
| Windows Backup (LXC 104) | `scripts/backup-script.sh` | see root `CLAUDE.md` LXC 104 section |

## System-Wide Dashboard Pages

### Project Health Page (sidebar: General → Project Health)
- **System Status card**: live status of all services; fetched from `/api/health/status`; displayed in a 4-column grid:
  - All checks are performed **by the dashboard directly** (not by the orchestrator). Orchestrator contributes only via `system_alerts` table entries.
  - **Infrastructure** (direct checks): `postgres` — DB query; `homeassistant` — HA API; `vm101`/`lxc100`–`lxc106` — TCP port 22 reachability
  - **Server**: `pm2` — all pm2 processes online
  - **Services**:
    - `boiler_agent` — boiler service on LXC 103 (via `system_alerts`: red if active `service_down`/`service_ssh_failed`)
    - `media_agents` — analyzer, player, ingest on LXC 100 (via `system_alerts`: shown as 3 inline dots)
    - `voice_agent` — whisper-http on LXC 106 (via `system_alerts`: red if active `service_down`/`service_ssh_failed`)
  - **Scripts — Cron** (direct SSH checks):
    - `ha_to_pg` — age of last `raw_data` row ≤ 15 min (DB query)
    - `collect_weather` — age of last `raw_weather` row ≤ 65 min (DB query)
    - `auto_scan` — age of `/var/log/auto_scan.log` on LXC 100 ≤ 120 s (SSH)
  - **Data freshness** (DB queries):
    - `boiler_last_decision` — age of last `agent_boiler_data` row ≤ `run_interval_min × 3`; shows age + decision
    - `orchestrator_last_run` — age of last `orchestrator_log` row ≤ 70 min; shows age
    - `active_alerts` — count of unresolved `system_alerts`; shows worst severity
- **Orchestrator Log card**: last N entries from `orchestrator_log` table; severity colour-coded (info/warn/error); shows last run time + status summary; `GET /api/health/orch-log?limit=N`
- **DB Volumes card**: table row counts, disk size, dead tuples, frag %, last vacuum per table; fetched from `/api/health/db-volumes` using `pg_stat_user_tables`; each row has a **Vacuum** button — runs `VACUUM ANALYZE` and updates dead tuples + frag % inline
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