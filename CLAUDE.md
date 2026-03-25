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

## Domain Rules
- All temperatures are in **Celsius**.
- The `valve_state` logic: `true` means the panel water flow is ON, `false` means OFF.


## Formatting Preferences
- When showing data, prefer **Markdown Tables**.
- If I ask for a trend, suggest a **Chart** or a summary of the min/max/average.