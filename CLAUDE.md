# Global Environment Settings

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
| 100 | LXC | — | 192.168.1.138 |
| 101 | VM | Home Assistant | 192.168.1.110 |
| 102 | LXC | PostgreSQL DB | 192.168.1.219 |
| 103 | LXC | App / Agents | 192.168.1.114 |
| 104 | LXC | Commands / Timers | 192.168.1.227 |
| 105 | LXC | Main Agent (Orchestrator) | 192.168.1.187 |
| 106 | LXC | Voice | 192.168.1.188 |

## Domain Rules
- All temperatures are in **Celsius**.
- The `valve_state` logic: `true` means the panel water flow is ON, `false` means OFF.


## Formatting Preferences
- When showing data, prefer **Markdown Tables**.
- If I ask for a trend, suggest a **Chart** or a summary of the min/max/average.