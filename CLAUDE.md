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