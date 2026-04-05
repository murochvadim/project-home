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
MCP Server: homeassistant (Connected direct via API)
Note: The Windows host uses npx.cmd, but the remote LXC requires npx.
Always use these MCP tools when I ask for data analysis or device status.

## Dashboard Server
- Runs locally on **Windows host** (not on any LXC)
- Managed by **pm2** — available at `C:\Users\muroc\AppData\Roaming\npm\pm2` (already in PATH)
- Restart command: `cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 restart ecosystem.config.js`
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
| 103 | LXC | App / Agents | 192.168.1.114 |
| 104 | LXC | Commands / Timers | 192.168.1.227 |
| 105 | LXC | Main Agent (Orchestrator) | 192.168.1.187 |
| 106 | LXC | Voice | 192.168.1.188 |

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

## Project Modules
Each project has its own CLAUDE.md with full details:

| Module | Folder | CLAUDE.md |
|--------|--------|-----------|
| Boiler Agent | `BOILER/` | `BOILER/CLAUDE.md` |
| Media Agent | `MEDIA/` | `MEDIA/CLAUDE.md` |
| Orchestrator | `ORCHESTRATOR/` | `ORCHESTRATOR/CLAUDE.md` |
| Voice System | `VOICE/` | `VOICE/CLAUDE.md` |
| Scripts (LXC 100) | `scripts/` | see `MEDIA/CLAUDE.md` |