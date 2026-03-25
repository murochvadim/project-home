# Boiler Project

## Boiler Project  Purpose

- Maintain the boiler water at the highest possible temperature for as long as possible during operating hours by controlling the valve.

## Boiler System Overview
- Boiler water is heated by **panel water** in a closed-loop system
- Panel water is heated by **solar radiation** during daylight hours
- The flow of panel water through the boiler is controlled by the **valve**
- Boiler water is used for **household needs**


## Data Source
- Proxmox LXC ID: 102
- Database: PostgreSQL
- IP: 192.168.1.219
- DB Name: `home_data`

## Tables
- `raw_data`:
  - `ts`
  - `boiler_temp`
  - `panel_temp`
  - `valve_state`

## Data Flow
- In lxc 103 Agents has running script that update raw_data with data from HA every 5 min. 

## Integration
- Home Assistant: 192.168.1.110:8123

## App LXC 
- Proxmox LXC ID: 103
- IP: 192.168.1.114

---

# Boiler Operational Inputs

## 1. Operational Hours Restriction
- `valve_state` can be set **ON/OFF only during 07:00–19:00 daily** (local time: Asia/Jerusalem)
- At **19:01**, `valve_state` must automatically be set **OFF** until **06:59** next day

## 2. Panel Temperature Logic
- These windows define when `panel_temp` readings are reliable (sensor stabilizes after flow transitions):
  - After valve ON: readings are **invalid** for the first `panel_temp_valid_after_on` minutes (water circulating, sensor unreliable); valid **after** that window
  - After valve OFF: readings remain **valid** for `panel_temp_valid_after_off` minutes; **invalid after** that window (water decouples from actual panel conditions)
- Both values are read from `agent_settings` table
- **Validity windows apply to trend calculations only** (steps 1B, 1C and Decision after waiting)
- **The Turn ON check** (`panel_temp > boiler_temp + temp_debounce`) always uses the raw current sensor reading — validity windows do NOT apply, so the agent is never blocked from evaluating a Turn ON

## 3. Valve State Source & Home Assistant Control
- The value of `valve_state` is **read from the `raw_data` table** in the PostgreSQL database
- Setting `valve_state` **ON/OFF** is done via **Home Assistant integration**
  - Entity: `switch.boiler_valve_switch_switch_1`
- Home Assistant integration rules and connection details are defined in the **root `claude.md`**
- All updates to `valve_state` must respect the **operational hours** and **panel temperature logic** above

---

## Domain Rules
- All temperatures are in **Celsius**
- `valve_state` logic:
  - `true` = panel water flow **ON**
  - `false` = panel water flow **OFF**

## Formatting Preferences
- When showing data, prefer **Markdown tables**
- For trends, suggest a **chart** or provide **min/max/average summaries**

# Agent  Operational Inputs

## 1. Agent will run every XX min according of what set in Boiler Agent settings in UI.

## 2. Every Run of Agent will ended with decision to on/off/ the valve or no action.  

## 3. Every Run of Agent will ended with updating db with - ts , text what was decision and why,any error or NO ERROR,next run ts.
 
## Tables
- `agent_boiler_data`:
  - `ts`
  - `boiler_temp`   — boiler temperature at time of run
  - `panel_temp`    — panel temperature at time of run
  - `valve_state`   — valve state at time of run (true/false)
  - `boiler_trend`  — boiler temperature trend (up/down/stable)
  - `panel_trend`   — panel temperature trend (up/down/stable)
  - `decision`      — agent decision: "turn_on" | "turn_off" | "keep_on" | "hold" | "waiting" | "no_action" | "disabled"
  - `error`         — "NO ERROR" | "WARN: ..." (soft warning, agent continues) | "ERR: ..." (hard error, agent stops)
  - `next_ts`       — timestamp of next scheduled run
  - `version`       — git commit hash of the deployed agent at time of run

- `agent_settings`:
  - `agent_enabled`              — enables or disables the agent; if false, agent writes decision = "disabled" and waits for next scheduled run
  - `run_interval_min`           — how often the agent runs, in minutes
  - `panel_temp_valid_after_on`  (default: 4)  — minutes to wait after valve turns ON before panel_temp readings are valid (invalid during this period while water is circulating)
  - `panel_temp_valid_after_off` (default: 10) — minutes after valve turns OFF during which panel_temp readings remain valid; invalid after this window (water decouples from actual panel conditions)
  - `trend_runs`                 (default: 3)  — number of recent readings used to calculate boiler and panel temperature trends (both heating and cooling directions); also the number of runs to wait after valve ON before making a decision (example: first run in the Morning).
  - `temp_debounce`              (default: 2)  — minimum temperature difference (°C) between panel and boiler required to change the trend decision; prevents valve toggling when temperatures are nearly equal


# Agent Prompt

## Safety Rule — always overrides everything, always causes exit:
- **Condition A:** valve_state is ON and operational hours have ended — checked first, before any other step
- **Condition B:** valve_state is ON and a hard error (ERR) has occurred — triggered reactively when a hard error is detected in Step 3
- If either condition is met: execute valve OFF via HA, write decision = "turn_off", error = "NO ERROR" (condition A) or "ERR: <description>" (condition B) to agent_boiler_data, then exit.
- Applies regardless of agent_enabled state or invalid data.

## 0. Read agent_settings. If agent_enabled = false → write decision = "disabled", error = "NO ERROR" to agent_boiler_data, then wait for next scheduled run.
 
## 1. Read `trend_runs` and `run_interval_min` from agent_settings, then read all raw_data rows from the last `trend_runs × run_interval_min` minutes:

- A. Validate data per "Panel Temperature Logic" — filter out readings outside validity windows
- B. Get boiler_temp trend (up/down/stable) from validated readings
- C. Get panel_temp trend (up/down/stable) from validated readings — if no valid readings exist, trend is unavailable

## 2. If panel_temp trend is unavailable (no valid readings):
- Write error = "WARN: not valid panel_temp" — this is a soft warning, not a hard error
- No trend, no Decision after waiting
- If valve is currently ON → write decision = "no_action" (cannot evaluate trend, hold current state)
- Turn ON check is still evaluated using raw current panel_temp
- Safety Rule always applies
- Step 3 does NOT apply to this warning

## 3. On any hard error (ERR: DB failure, HA unreachable, missing data, etc.):
- If valve is ON → Safety Rule Condition B applies: turn OFF valve, write decision = "turn_off", error = "ERR: <description>", then exit
- If valve is OFF → write decision = "no_action", error = "ERR: <description>", then exit


## 4. Get current valve_state

## 5. Agent Decision Logic

-Turn ON:
 - Within operational hours
 - Valve is currently OFF
 - `panel_temp > boiler_temp + temp_debounce` (panel is definitively warmer — worth opening the valve)
 - Turn ON and wait; write decision = "turn_on"
 - If conditions not met (panel not warm enough) → write decision = "no_action"

- Waiting Phase:
 - After valve ON, wait `trend_runs` agent runs before deciding
 - No decision during this phase
 - Write to agent_boiler_data: decision = "waiting", error = NO ERROR

- Decision after waiting (uses `temp_debounce` as a symmetric dead band):
 - If `panel_temp > boiler_temp + temp_debounce` → keep ON (panel is heating); write decision = "keep_on"
 - If `panel_temp < boiler_temp - temp_debounce` → turn OFF (panel is cooling); write decision = "turn_off"
 - If `|panel_temp - boiler_temp| <= temp_debounce` → no change, maintain current valve state; write decision = "hold"
   - "hold" means: temperatures are too close to act — panel is neither clearly heating nor clearly cooling the boiler
   - Valve stays ON; agent will re-evaluate next run
   - If temperatures stay in the dead band across many runs, the panel is contributing marginally — this is acceptable; the valve will turn OFF naturally once panel cools below `boiler_temp - temp_debounce`

- Turn OFF (immediate): handled exclusively by Safety Rule (see above) — not part of normal decision flow

## 6. Execute HA action if decision requires valve change

## 7. Write result to agent_boiler_data table:
  boiler_temp, panel_temp, valve_state,
  boiler_trend, panel_trend,
  decision, error,
  next_ts = current_ts + run_interval_min,
  version = current git commit hash.


## 8. Return report...

  boiler_temp,
  panel_temp,
  valve_state,
  boiler_trend,
  panel_trend,
  decision, error,
  next_ts,
  version.


# Dashboard

## 1. Multi-Agent Framework
- Dashboard is designed to support multiple agents
- Main navigation sidebar lists each agent as a separate section
- Boiler Agent is the first section; future agents are added as new sections
- Each agent section is fully independent (own pages, settings, data)

## 2. CRM Style
## 3. Paged
## 4. Pagination data of DB
  table raw_data
- 10,20,30 last rows

  table agent_boiler_data
  10,20,30 last rows

## 5. Data Refresh
- Dashboard auto-refreshes every `run_interval_min` minutes (aligned with agent run cycle)
- Manual refresh button available for immediate update

## 6. Main page - name Boiler Agent
- Manual trigger button Start/Stop to enable or disable actions of agent with display current status.
- Display of last agent report (current boiler_temp, panel_temp, valve_state, last decision)
- Setting - how often Agent will run in Minutes. 
- panel_temp_valid_after_on setting
- panel_temp_valid_after_off setting
- Trend calculation: last [__] runs
- Temperature debounce: [__] °C (minimum gap between panel and boiler temperatures to trigger a trend change)


## Deploy
- "Deploy to Production" button on the dashboard
- Triggers a `git pull` on LXC 103 (192.168.1.114) to pull latest code from the repository
- Restarts the agent service after pull
- Displays deploy result (success or error output) inline

## Version Comparison Page
- Select Version A vs Version B (by git commit hash or deploy date)
- Select time range for comparison
- Side-by-side metrics:
  - Average and max boiler temperature
  - Total time boiler stayed above a threshold temperature
  - Number of valve ON/OFF operations
  - Average valve ON duration

## Graph on Main page
- Boiler and Panel Temperatures
- Valve state overlaid as a background band or stepped line (ON/OFF) to show exactly when valve changes occurred
- Resolution: selectable — 5min, 15min, 1h, 6h, 1day
- Time range: last 1h, 6h, 24h

 





 
  