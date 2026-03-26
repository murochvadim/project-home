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
- `raw_data`: ts, boiler_temp, panel_temp, valve_state
- `agent_boiler_data`: ts, boiler_temp, panel_temp, valve_state, boiler_trend, panel_trend, decision, why_decision, error, next_ts, version
- `agent_settings`: agent_enabled, run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min
- `raw_weather`: ts, condition, temp_ims, humidity_ims, uv_index_ims, wind_speed, uv_index_balcony, temp_balcony, illuminance_balcony, humidity_balcony — collected hourly
- `raw_weather_daily`: ts, forecast_date, condition, temp_high, temp_low, precipitation_mm — collected once at 06:00 daily (7-day forecast from IMS)

## Data Flow
- **raw_data**: LXC 103 script `/usr/local/bin/ha_to_pg` runs every 5 min via cron, fetches from HA
- **raw_weather + raw_weather_daily**: LXC 103 script `/opt/Agents-agent/project/BOILER/agent/collect_weather.py` runs every hour via cron
  - Hourly: fetches `weather.ims_weather` + balcony sensors (`sensor.balcony_motion_*`) from HA → inserts into `raw_weather`
  - Daily at 06:00: calls `weather.get_forecasts?return_response` → inserts 7-day forecast into `raw_weather_daily`
  - HA_TOKEN stored in `/etc/environment` on LXC 103; loaded via `export $(grep -v '^#' /etc/environment | xargs)` in cron

## Weather Data Sources (Home Assistant)
- `weather.ims_weather` — IMS official: condition, temperature, humidity, uv_index, wind_speed, wind_bearing; supports hourly + daily forecasts
- `sensor.balcony_motion_temperature` — outdoor temp on balcony
- `sensor.balcony_motion_uv_index` — local UV index
- `sensor.balcony_motion_illuminance` — light level (solar radiation proxy)
- `sensor.balcony_motion_humidity` — outdoor humidity

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
- **Validity windows apply to panel trend calculation only** (Step 1C — boiler trend in Step 1B uses all readings unfiltered)
- **The normal Turn ON check** (`panel_temp > boiler_temp + temp_debounce`) always uses the raw current sensor reading — validity windows do NOT apply
- **The Probe Turn ON** (see Step 5 — Probe Logic) triggers when panel readings are invalid and the probe timer has elapsed — it does NOT use the raw reading for the turn-on decision; instead it opens the valve to obtain a valid reading

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

# Agent Operational Inputs

## 1. Agent will run every XX min according of what set in Boiler Agent settings in UI.

## 2. Every Run of Agent will ended with decision to on/off the valve or no action.

## 3. Every Run of Agent will ended with updating db with - ts, decision, why decision, any error or NO ERROR, next run ts.

## Tables
- `agent_boiler_data`:
  - `ts`
  - `boiler_temp`    — boiler temperature at time of run
  - `panel_temp`     — panel temperature at time of run
  - `valve_state`    — valve state at time of run (true/false)
  - `boiler_trend`   — boiler temperature trend (up/down/stable)
  - `panel_trend`    — panel temperature trend (up/down/stable)
  - `decision`       — agent decision: "turn_on" | "turn_off" | "keep_on" | "hold" | "waiting" | "no_action" | "disabled"
  - `why_decision`   — human-readable explanation of why this decision was made (e.g. "Panel 52.1°C > Boiler 48.3°C + debounce 2°C, trend UP → keep_on")
  - `error`          — "NO ERROR" | "WARN: ..." (soft warning, agent continues) | "ERR: ..." (hard error, agent stops)
  - `next_ts`        — timestamp of next scheduled run
  - `version`        — git commit hash of the deployed agent at time of run

- `agent_settings`:
  - `agent_enabled`              — enables or disables the agent; if false, agent writes decision = "disabled" and waits for next scheduled run
  - `run_interval_min`           — how often the agent runs, in minutes
  - `panel_temp_valid_after_on`  (default: 4)  — minutes to wait after valve turns ON before panel_temp readings are valid (invalid during this period while water is circulating)
  - `panel_temp_valid_after_off` (default: 10) — minutes after valve turns OFF during which panel_temp readings remain valid; invalid after this window (water decouples from actual panel conditions)
  - `trend_runs`                 (default: 3)  — number of recent readings used to calculate boiler and panel temperature trends; also the number of runs to wait after valve ON before making a final decision
  - `temp_debounce`              (default: 2)  — minimum temperature difference (°C) between panel and boiler required to act; prevents valve toggling when temperatures are nearly equal
  - `probe_interval_min`         (default: 60) — when panel readings are invalid and valve is OFF during operational hours, how many minutes to wait between probe attempts; prevents continuous probing on cloudy days


# Agent Prompt

## Safety Rule — always overrides everything, always causes exit:
- **Condition A:** valve_state is ON and operational hours have ended — checked first, before any other step
- **Condition B:** valve_state is ON and a hard error (ERR) has occurred — triggered reactively when a hard error is detected in Step 2
- If either condition is met: execute valve OFF via HA, write decision = "turn_off", why_decision = reason, error = "NO ERROR" (condition A) or "ERR: <description>" (condition B) to agent_boiler_data, then exit.
- Applies regardless of agent_enabled state or invalid data.

## 0. Read agent_settings. If agent_enabled = false → write decision = "disabled", why_decision = "Agent is disabled", error = "NO ERROR" to agent_boiler_data, then wait for next scheduled run.

## 1. Read `trend_runs` and `run_interval_min` from agent_settings, then read all raw_data rows from the last `trend_runs × run_interval_min` minutes:

- A. Validate data per "Panel Temperature Logic" — filter out panel_temp readings outside validity windows (validity windows apply to panel sensor only; boiler sensor is always reliable)
- B. Get boiler_temp trend (up/down/stable) from **all** readings in the window (boiler sensor is not affected by valve transitions)
- C. Get panel_temp trend (up/down/stable) from **validity-filtered** readings only — if fewer than 2 valid readings exist, panel trend is unavailable

## 2. On any hard error (ERR: DB failure, HA unreachable, missing data, etc.):
- If valve is ON → Safety Rule Condition B applies: turn OFF valve, write decision = "turn_off", error = "ERR: <description>", then exit
- If valve is OFF → write decision = "no_action", error = "ERR: <description>", then exit
- If valve_state cannot be determined due to the hard error itself → treat as OFF (safe default — cannot turn off what we cannot confirm is ON)

## 3. Get current valve_state

## 4. Agent Decision Logic

### Waiting Phase — checked first, before any other decision:
- After valve turns ON (decision was "turn_on"), wait `trend_runs` agent runs before making a final decision
- **Detecting waiting phase:** look at the last `trend_runs` rows in `agent_boiler_data`; if `turn_on` appears within those rows AND every row more recent than it has decision = `waiting`, the waiting phase is active. If any resolved decision (`keep_on`, `turn_off`, `hold`, `no_action`) appears between the most recent row and the `turn_on`, the waiting phase has already resolved — do not re-enter it.
- **During each waiting run**, once panel readings become valid (panel_temp_valid_after_on minutes have elapsed since valve ON):
  - If panel_trend = **DOWN** → **early turn_off** (panel is cooling, probe failed or sun gone); write decision = "turn_off", why_decision = "Probe aborted: panel trend DOWN during waiting phase — panel is cooling"
  - Otherwise (UP or stable or readings not yet valid) → write decision = "waiting", why_decision = reason; continue to next run
- **On the last waiting run** (run number = trend_runs), if not already aborted:
  - If panel_trend = **UP** → write decision = "keep_on" (sun is heating, continue); why_decision = "Last probe run: panel trend UP → heating confirmed"
  - If panel_trend = **DOWN** → write decision = "turn_off"; why_decision = "Last probe run: panel trend DOWN → panel is cooling"
  - If panel_trend = **stable** or unavailable → write decision = "hold" (B); why_decision = "Last probe run: panel trend stable → hold, re-evaluate next run as normal"
- After waiting phase resolves (keep_on, turn_off, or hold) → subsequent runs use **Normal Decision** logic below

### Normal Turn ON — valve is OFF, panel reading is VALID:
- Within operational hours
- Valve is currently OFF
- `panel_temp > boiler_temp + temp_debounce` (panel is definitively warmer — worth opening the valve)
- Turn ON and enter Waiting Phase; write decision = "turn_on", why_decision = reason
- If conditions not met → write decision = "no_action", why_decision = reason

### Probe Turn ON — valve is OFF, panel reading is INVALID:
- Within operational hours
- Valve is currently OFF
- Panel reading is invalid (valve has been OFF longer than `panel_temp_valid_after_off` minutes)
- Time since last valve close ≥ `probe_interval_min` minutes — determined by finding the most recent row in `raw_data` where `valve_state` changed from ON to OFF; if no such transition exists (e.g. first morning run), treat as probe timer elapsed
- **Probe timer resets on every valve close** — whether by normal decision, early waiting-phase abort, or Safety Rule; meaning after each turn_off the agent waits `probe_interval_min` before probing again
- → Open valve to probe; write decision = "turn_on", why_decision = "Probe: panel reading invalid, opening valve to evaluate solar heating"
- → Enter Waiting Phase (same waiting phase as Normal Turn ON)
- If probe_interval_min has not elapsed yet → write decision = "no_action", why_decision = "Probe: waiting for probe_interval_min to elapse before next probe attempt"

### If panel_temp trend is unavailable (no valid readings) and valve is ON (outside waiting phase):
- Write error = "WARN: not valid panel_temp", decision = "no_action", why_decision = "Panel trend unavailable — cannot evaluate, holding current valve state"
- Safety Rule always applies

### Normal Decision — valve is ON, waiting phase is complete:
- Uses `temp_debounce` as a symmetric dead band:
  - If `panel_temp > boiler_temp + temp_debounce` → keep ON; write decision = "keep_on", why_decision = reason
  - If `panel_temp < boiler_temp - temp_debounce` → turn OFF; write decision = "turn_off", why_decision = reason
  - If `|panel_temp - boiler_temp| <= temp_debounce` → hold; write decision = "hold", why_decision = reason
    - Valve stays ON; agent re-evaluates next run
    - Valve will turn OFF naturally once panel cools below `boiler_temp - temp_debounce`

### Turn OFF (immediate): handled exclusively by Safety Rule — not part of normal decision flow

## 5. Execute HA action if decision requires valve change

## 6. Write result to agent_boiler_data table:
  boiler_temp, panel_temp, valve_state,
  boiler_trend, panel_trend,
  decision, why_decision, error,
  next_ts = current_ts + run_interval_min,
  version = current git commit hash.

## 7. Return report:
  boiler_temp, panel_temp, valve_state,
  boiler_trend, panel_trend,
  decision, why_decision, error,
  next_ts, version.


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
- Start/Stop button — enables or disables the agent; shows current status (ENABLED green / DISABLED)
- **Agent Control card:**
  - Agent Status, Last Decision + why_decision (italic below badge), Next Run + live MM:SS countdown
  - Next Probe Run + live MM:SS countdown (shows `—` when agent disabled or valve ON; `Ready` when timer elapsed)
  - Probe origin badge below Next Probe Run: `Probe started at HH:MM` (blue) when valve ON from probe; hidden (empty) when not active
  - When outside operational hours and agent enabled: shows `Outside operational hours (07:00–19:00)` in muted grey below Next Probe Run countdown (font-size 0.82rem, same as value); text persists and is not cleared by the countdown interval
  - `why-decision` text (below Last Decision badge) and `next-probe-countdown` text both use font-size 0.82rem to match the value fields
  - Last Error
  - Connections: PostgreSQL ⬤ and Home Assistant ⬤ (green/red live status)
- **Last Report card:** boiler_temp, panel_temp, valve_state, boiler_trend, panel_trend, report timestamp
- **Settings:** run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min
- **Deploy card:** "Deploy to Production" button → git pull on LXC 103 + restart agent service; output shown inline

## Data Page
- Table 1: raw_data — last 10/20/30 rows (ts, boiler_temp, panel_temp, valve_state)
- Table 2: agent_boiler_data — last 10/20/30 rows including why_decision column (truncated to 45 chars, full text on hover tooltip)

## Version Comparison Page
- Select Version A vs Version B (by git commit hash)
- Side-by-side metrics: avg/max boiler_temp, valve ON/OFF count, % time ON

## Graph Page
- Boiler and Panel Temperatures as line chart
- Valve state as stepped line (ON/OFF) on secondary axis
- Resolution: selectable — 5min, 15min, 1h, 6h, 1day
- Time range: last 1h, 6h, 24h

## Logic Page
- 4 tabs with Mermaid.js flowcharts: Main Flow, Waiting Phase, Turn ON & Probe, Normal Decision
- Rendered lazily (only when tab becomes visible) using startOnLoad: false

## General Page (sidebar: General → Weather)
- **Current Conditions card**: reads latest row from `raw_weather` (no HA token needed on Windows dashboard)
- **Hourly Weather Log table**: last 24/48/72 rows from `raw_weather`
- **Daily Forecast Log table**: last 14/30 rows from `raw_weather_daily` (precipitation in mm)
- API endpoints: `/api/weather/latest`, `/api/weather/hourly`, `/api/weather/daily`
