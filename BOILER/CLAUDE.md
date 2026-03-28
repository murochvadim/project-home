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
- `agent_settings`: agent_enabled, run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min, consumption_temp_delta, consumption_time_delta
- `boiler_consumptions`: id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at — hot water consumption events detected by agent each run; deduplicated by start_ts
- `raw_weather`: ts, condition, temp_ims, humidity_ims, uv_index_ims, wind_speed, uv_index_balcony, temp_balcony, illuminance_balcony, humidity_balcony — collected hourly
- `raw_weather_daily`: ts, forecast_date, condition, temp_high, temp_low, precipitation_mm — collected once at 06:00 daily (7-day forecast from IMS)

## Data Flow
- **raw_data**: LXC 103 script `/usr/local/bin/ha_to_pg` runs every 5 min via cron, fetches from HA
- **raw_weather + raw_weather_daily**: LXC 103 script `/opt/Agents-agent/project/BOILER/agent/collect_weather.py` runs every 30 min via cron (`*/30 * * * *`)
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
- At **19:00**, `valve_state` must automatically be set **OFF** until **06:59** next day (operational hours check: `7 <= hour < 19`)

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
  - `consumption_temp_delta`     (default: 3.0) — minimum boiler temperature drop (°C) to qualify as a hot water consumption event
  - `consumption_time_delta`     (default: 15) — time window (minutes) over which the drop is scanned; agent looks back this many minutes in raw_data each run


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
- **Probe Fire Logic (time gate) — checked first:** compute `probe_cost_min = panel_valid_after_on + (trend_runs + 1) × run_interval_min` (minimum minutes needed to complete the probe waiting phase and act on result). If `minutes until 19:00 < probe_cost_min` → skip probe: write decision = "no_action", why_decision = "Probe skipped: only Xm until end of operations, probe needs Ym to complete"
- Time since last valve close ≥ `probe_interval_min` minutes — determined by finding the most recent row in `raw_data` where `valve_state` changed from ON to OFF; if no such transition exists (e.g. valve was never ON), panel reading is treated as **valid** → falls through to Normal Turn ON check instead
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

## 7. Detect and save hot water consumption events:
- Scan raw_data for the last `consumption_time_delta` minutes
- Group consecutive drops (≥ 0.5°C per step) into events; only record completed events (drop has ended)
- Record event if total drop ≥ `consumption_temp_delta`; insert into `boiler_consumptions` with ON CONFLICT DO NOTHING (deduplicated by start_ts)

## 8. Return report:
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
  - Next Run shows `—` and countdown is hidden when agent is disabled
  - Next Probe Run — two-element display: value line (#next-probe) + countdown line (#next-probe-countdown, 0.82rem blue):
    - Disabled / valve ON / outside hours: value = `—` (grey), no countdown
    - Too late (probe fire logic blocked): value = `Too late — Xm left` (amber), no countdown
    - Ready (timer elapsed, feasible): value = `Ready` (green), no countdown
    - Counting down (feasible): value = date/time, countdown = live `MM:SS` (blue)
  - `/api/next-probe` returns `probe_feasible` (bool), `probe_cost_min` (min), `minutes_to_end` (min to 19:00); feasibility computed at the time the probe would fire, not just current time
  - Probe origin badge below Next Probe Run: `Probe started at HH:MM` (dark) when valve ON from probe during waiting phase; hidden otherwise
  - Outside operational hours text is NOT shown under Next Probe Run — Last Decision badge already conveys this
  - `why-decision` text (below Last Decision badge) and `next-probe-countdown` text both use font-size 0.82rem to match the value fields
  - `.status-item label` has `min-height: 2.3em` so multi-line labels (e.g. "Solar Heating Potential") don't push their value lower than single-line labels
  - Last Error
  - Solar Heating Potential: score (1–10) centered, colored (green/amber/brown), label below (e.g. "Poor — minimal heating today"); no icon; fetched from `/api/weather/scores`
  - Connections: PostgreSQL ⬤ and Home Assistant ⬤ (green/red live status)
- **Last Report card:** boiler_temp, panel_temp, valve_state, boiler_trend, panel_trend, report timestamp; Boiler Trend / Panel Trend / Report Time columns are `text-align:center`
- **Hot Water Usage — Today card** (below Last Report): event count, largest drop, avg drop, last event time; fetched from `/api/consumptions/today`
  - Uses same 7-column grid as Last Report (`0.7fr 2fr 1.3fr 1.3fr 0.7fr 1fr 1fr`) with `status-grid-divided` vertical lines
  - Items placed at specific columns to align dividers with Last Report: Events=col1, Largest Drop=col3, Avg Drop=col4, Last Event=col5
  - Largest Drop has `border-left` + `margin-left:-16px` so its left divider aligns exactly with Valve State's left divider in Last Report
  - Largest Drop, Avg Drop, Last Event are `text-align:center`
- **Settings:** run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min, consumption_temp_delta, consumption_time_delta
- **Deploy card:** "Deploy to Production" button → git pull on LXC 103 + restart agent service; output shown inline
- When countdown reaches 0 → shows "running…" → auto-refreshes after 15s to pick up new next_ts

## Data Page
- Table 1: raw_data — last 10/20/30 rows (ts, boiler_temp, panel_temp, valve_state)
- Table 2: agent_boiler_data — last 10/20/30 rows including why_decision column (truncated to 45 chars, full text on hover tooltip)
- Table 3: boiler_consumptions — last 10/20/50 rows (start_ts, end_ts, start_temp, end_temp, drop_c, duration_min)

## AI + Graph Page (sidebar: "AI + Graph")
- Page title and sidebar link: **AI + Graph**
- Top section: temperature graph (boiler, panel, valve, consumption events) — unchanged from before
- Bottom section: **AI Investigation card**

### Temperature Graph
- Boiler and Panel Temperatures as line chart (y-axis: 1 decimal place)
- Valve state as stepped line (ON/OFF) on secondary axis
- Consumption events as red downward triangles on boiler temp line (at start_temp height); tooltip shows drop °C + duration
- Resolution: selectable — 5min, 15min, 1h, 6h, 1day
- Time range: last 1h, 6h, 24h
- `/api/consumptions?from=ISO` used to fetch events for current time range

### AI Investigation Card
- **Controls:** hour range picker (from/to), checkboxes: Weather Forecast, Today's Outlook, Agent History
- **Buttons row:** `🧠 Investigate` (primary blue) + `View Prompt` (green, same color as Apply Suggested Parameters, toggles prompt panel) — both always visible after first run
- **Thinking state:** Investigate button shows spinning white circle + "Thinking…" while waiting for API response
- **Prompt panel** (toggleable, hidden by default): shows System and User messages sent to Claude; renders as `<pre>` blocks
- **Results section** (hidden until first run, persists via `localStorage`):
  - Last run timestamp + window shown
  - Summary box (blue left border)
  - **Suggested Settings** table: Parameter / Current / Suggested (green if changed) / Reason
  - **✓ Apply Suggested Parameters** button (green) — fetches current settings, merges suggestions, POSTs to `/api/settings`; shows "✓ Applied" or error inline
  - **AI INVESTIGATION** label (uppercase) + **✕ Clear** button (right-aligned)
  - Predicted graph (Chart.js, dashed lines) — boiler temp, panel temp, valve stepped line
  - Label: "Estimate only — dashed lines indicate AI prediction"
- **localStorage key:** `boiler_ai_investigation` — result persists across page closes until Clear is clicked or new investigation runs
- **Clear** wipes localStorage and hides results section

### AI Investigation — Server Logic (`/api/ai-investigate` POST)
- Required env var: `ANTHROPIC_API_KEY` in `ecosystem.config.js`
- Dependency: `@anthropic-ai/sdk` (installed in `node_modules`)
- Model: `claude-sonnet-4-6`, max_tokens: 2048
- **Data gathered:** agent_settings, last 100 agent_boiler_data rows, last 24 raw_weather rows, weather forecast, latest raw_data (current boiler temp), cooling rate query, last valve close timestamp
- **Cooling rate:** measured as `(first_valve_off_temp - last_valve_off_temp) / hours` over last 14h. If ≤ 0.05°C/h (boiler stable/heating), falls back to **0.5°C/h minimum**
- **Estimated boiler temp at window start:** `currentBoiler - coolingRate × hoursUntilWindow` (floored at 15°C)
- **Panel validity at window start:** if minutes since last valve close + hours until window > `panel_temp_valid_after_off` → INVALID → first action is a probe
- **Post-processing after Claude responds:**
  1. Shift all `boiler_temp` values in prediction by delta = `estimatedStartTemp - prediction[0].boiler_temp` (forces correct starting temp regardless of what Claude assumed)
  2. If panel invalid at start: force `prediction[0].valve = false`, `prediction[0].panel_temp = outdoor ambient temp`
- **Response includes** `_debug: { system_prompt, user_content }` for View Prompt feature

## Logic Page
- 4 tabs with Mermaid.js flowcharts: Main Flow, Waiting Phase, Turn ON & Probe, Normal Decision
- Rendered lazily (only when tab becomes visible) using startOnLoad: false

## Local Server Setup
- Dashboard server: `BOILER/dashboard/server.js`, port **3000**, binds to `127.0.0.1`
- Start manually: `HA_TOKEN=<token> node server.js` from `BOILER/dashboard/`
- PM2 config: `ecosystem.config.js` (includes HA_TOKEN); run with `pm2 start ecosystem.config.js`
- Dependencies: `express`, `pg`, `node-ssh`, `@anthropic-ai/sdk` (in `node_modules`)
- PM2 env vars required: `HA_TOKEN`, `ANTHROPIC_API_KEY`

## Project Health Page (sidebar: General → Project Health)
- **System Status card**: live status of all services — PostgreSQL (LXC 102), Home Assistant, LXC 103 SSH, Boiler Agent systemd service, ha_to_pg cron, PM2; fetched from `/api/health/status`
  - `ha_to_pg`: checks cron registration on LXC 103 + DB data freshness (age of last `raw_data` row ≤ 10 min = OK); returns `{cron_ok, last_ts, age_min, data_ok}`
- **Orchestrator Log card**: last N entries from `orchestrator_log` table; severity colour-coded (info/warn/error); shows last run time + status summary; `GET /api/health/orch-log?limit=N`
- **DB Volumes card**: table row counts, disk size, oldest/newest record for all tables; fetched from `/api/health/db-volumes` using `pg_stat_user_tables`
- **Retention Policies card**: editable table per DB table — keep_days (blank = forever), auto_clean toggle, clean_interval_hours, last_cleaned timestamp; Save per row, Clean per row, "Clean All Now" global button
  - Policies stored in `retention_policies` DB table (not config file — so orchestrator reads/writes them programmatically)
  - Default policies seeded on first run: raw_data=90d, agent_boiler_data=365d, raw_weather=60d, raw_weather_daily=60d, boiler_consumptions=forever
- **API endpoints:**
  - `GET /api/health/status` — checks PostgreSQL, HA, SSH to LXC 103, boiler-agent service, ha_to_pg cron, PM2
  - `GET /api/health/orch-log?limit=N` — last N orchestrator log entries
  - `GET /api/health/db-volumes` — row counts + sizes + date ranges per table
  - `GET /api/health/retention` — all retention policies
  - `POST /api/health/retention` — update one policy `{table_name, keep_days, auto_clean, clean_interval_hours}`
  - `POST /api/health/cleanup` — run cleanup `{table_name}` (null = all); returns `{results:[{table_name, deleted}]}`
- **retention_policies table schema:** `table_name PK, keep_days INT nullable, auto_clean BOOL, clean_interval_hours INT, last_cleaned_at TIMESTAMPTZ, description TEXT`

# Main Agent (Orchestrator)

## Infrastructure
- **LXC 105** — Proxmox LXC, IP `192.168.1.187`, name `MainAgent`
- Debian 12, Python 3.11, venv at `/opt/main-agent/venv`
- Script: `/opt/main-agent/orchestrator.py`
- Env file: `/etc/main-agent.env` (contains `DB_PASS`)
- Systemd: `main-agent.service` (oneshot) + `main-agent.timer` (runs every 1h, 2min after boot)
- SSH key: `/root/.ssh/id_ed25519` — authorised on LXC 103 for service checks

## Agent Framework Contract
Every agent registered in the `agents` table must follow this standard:
- **`agents` table:** `name PK, description, lxc_id, lxc_ip, service_name, data_table, settings_table, enabled, added_at`
- **Data table** must have: `ts TIMESTAMPTZ, decision TEXT, error TEXT, next_ts TIMESTAMPTZ`
- **Settings table** must have: `agent_enabled BOOL, run_interval_min INT`
- **Retention policies** registered in `retention_policies` table on first agent run
- **Systemd service** on its LXC — orchestrator checks it via SSH

Adding a new agent = INSERT into `agents` table → orchestrator + dashboard pick it up automatically, no code changes.

## Orchestrator Responsibilities (per run)
1. **Schedule check** — is each agent's `next_ts` overdue (> 5 min grace)?
2. **Error check** — any `ERR:` prefixed rows in last 10 rows of agent data table?
3. **Service check** — SSH to agent's LXC, run `systemctl is-active <service>`
4. **Retention cleanup** — delete old rows for tables where `auto_clean=true`, `keep_days` set, and `clean_interval_hours` has elapsed since `last_cleaned_at`
5. **Write all results** to `orchestrator_log` with severity `info/warn/error`

## DB Tables (new)
- `agents`: agent registry (see contract above)
- `orchestrator_log`: `id BIGSERIAL PK, ts TIMESTAMPTZ, source VARCHAR(50), severity VARCHAR(10), message TEXT`

## General Page (sidebar: General → Weather)
- **Today's Outlook card**: Solar Heating Potential (1–10) + Rain Probability (1–10) + Season; updated every 30 min
  - Scores computed on-the-fly in `/api/weather/scores` from latest `raw_weather` + today's `raw_weather_daily` — not stored in DB
  - Solar score: based on `condition` + `uv_index` (max of IMS and balcony); displayed as large colored number with description label (no icon)
  - Rain score: based on `condition` + `precipitation_mm` from today's forecast
  - Season: derived from current month (client-side, no API); Spring Mar–May, Summer Jun–Sep, Autumn Oct–Nov, Winter Dec–Feb
- **Current Conditions card**: reads latest row from `raw_weather` (no HA token needed on Windows dashboard)
- **Hourly Weather Log table**: last 24/48/72 rows from `raw_weather`
- **Daily Forecast Log table**: last 14/30 rows from `raw_weather_daily` (precipitation in mm)
- API endpoints: `/api/weather/scores`, `/api/weather/latest`, `/api/weather/hourly`, `/api/weather/daily`
- `collect_weather.py` cron runs every 30 min on LXC 103 (`*/30 * * * *`)
