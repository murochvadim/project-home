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
- `agent_settings`: agent_enabled, run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min, probe_max_boiler_temp, probe_max_delta, consumption_temp_delta, consumption_time_delta, consumption_descent_trigger_c, glitch_drop_threshold_c, glitch_bounce_recovery_c, sync_poll_interval_sec, wf96c_temp_delta_c, wf96c_heartbeat_sec
- `boiler_consumptions`: id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at, cause, likely_rooms — hot water drop events detected by agent each run; `cause` and `likely_rooms` filled asynchronously by rule engine using presence + valve context; `cause` ∈ {`human`,`panel`,`thermal`,`boiler`,`unknown`}; deduplicated by start_ts
- `sync_signals`: id, ts, source — written by the raw_data producer after each insert (`source='wf96c_ingest'` since 2026-04-23, previously `'ha_to_pg'`); boiler agent polls every `agent_settings.sync_poll_interval_sec` (default 300 s) and wakes immediately on new row
- `raw_weather`: ts, condition, temp_ims, humidity_ims, uv_index_ims, wind_speed, uv_index_balcony, temp_balcony, illuminance_balcony, humidity_balcony — collected every 60 min
- `raw_weather_daily`: ts, forecast_date, condition, temp_high, temp_low, precipitation_mm — collected once at 06:00 daily (7-day forecast from IMS)

## Data Flow
- **raw_data** (since 2026-04-23): event-driven from WF96C controller. LXC 103 systemd service `boiler-mqtt-ingest.service` runs `/opt/boiler-mqtt-ingest/wf96c_ingest.py`, which subscribes to MQTT topic `mur/home/device/116508838cce4eef9273/event` on LXC 107 as user `boiler_agent`. On each event it decodes DPS 103 ÷ 10 → `boiler_temp` (°C) and DPS 104 ÷ 10 → `panel_temp` (°C), reads `valve_state` from HA entity `switch.boiler_valve_switch_switch_1` with a 30-second cache, and inserts one row into `raw_data` + one row into `sync_signals (source='wf96c_ingest')` in a single transaction. **Dedupe (added 2026-04-25):** a row is written only when (a) first ever event, (b) `valve_state` flipped, (c) NULL↔value transition on either temp, (d) |Δ| ≥ `agent_settings.wf96c_temp_delta_c` (default 0.3 °C) on either temp, or (e) `agent_settings.wf96c_heartbeat_sec` (default 60 s) elapsed since the last write. Both knobs are reloaded from the DB every 60 s by `_maybe_reload_settings()` and exposed in the dashboard Settings card under the "WF96C Ingest" section — no service restart needed when tuning. Steady-state rate drops from ~7,600 rows/day (uncapped) to ~1,500-2,500 rows/day at the defaults; tightening to 0.1 °C / 30 s captures more detail at higher write cost; loosening to 0.5 °C / 120 s further reduces volume but risks fragmenting consumption events at the boundary.
  - **Source of truth in repo**: `BOILER/agent/wf96c_ingest.py`
  - **Systemd unit in repo**: `scripts/boiler-mqtt-ingest.service` (uses `/etc/boiler-agent.env` for `HA_TOKEN` + `MQTT_USER` + `MQTT_PASS`; `DB_PASS` not needed — Postgres on LXC 102 trusts the `192.168.1.0/24` subnet per `pg_hba.conf`).
  - **MQTT ACL note**: `boiler_agent` user on LXC 107 has `topic read mur/home/device/116508838cce4eef9273/#` in addition to its existing publish rights on `mur/home/device/boiler/#`.
  - **NULL guard**: if both `boiler_temp` AND `panel_temp` are still `None` (no WF96C reading yet at startup), skip both inserts — same rule as the old `ha_to_pg`.
  - **Legacy (≤ 2026-04-23)**: previously LXC 103 cron `/usr/local/bin/ha_to_pg` (repo `BOILER/agent/ha_to_pg_updated.py`) polled HA every 5 min for boiler_temp + panel_temp + valve_state. The cron line was removed 2026-04-23; script kept on disk for fast rollback. Valve commands still flow through HA; only the *reading* path changed.
- **raw_weather + raw_weather_daily**: LXC 103 script `/opt/Agents-agent/project/BOILER/agent/collect_weather.py` runs every 60 min via cron (`0 * * * *`)
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

## 1. Agent will run every XX min according to what is set in Boiler Agent settings in UI.
- Between runs the agent polls `sync_signals` at `agent_settings.sync_poll_interval_sec` cadence (default 300 s / 5 min, tunable via the Settings card since 2026-04-24) and wakes immediately when the raw_data producer (`wf96c_ingest` since 2026-04-23) writes a new row. At steady WF96C emission rate this effectively sets the agent's run cadence.
- Maximum sleep is still `run_interval_min` — it's the failsafe ceiling used when WF96C is silent (no sync_signals arriving). `sync_signals` only shortens the wait, never extends it.

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
  - `run_interval_min`           — **max sleep ceiling** (minutes); agent always wakes at least this often, even with no sync_signal activity. Failsafe, not the primary cadence knob
  - `sync_poll_interval_sec`     (default: 300) — how often the agent polls `sync_signals` during sleep. **This is the effective run cadence during normal WF96C operation** since events arrive faster than the poll interval. Added 2026-04-24 (replaces a hardcoded 30 s)
  - `panel_temp_valid_after_on`  (default: 4)  — minutes to wait after valve turns ON before panel_temp readings are valid (invalid during this period while water is circulating)
  - `panel_temp_valid_after_off` (default: 10) — minutes after valve turns OFF during which panel_temp readings remain valid; invalid after this window (water decouples from actual panel conditions)
  - `trend_runs`                 (default: 3)  — number of recent readings used to calculate boiler and panel temperature trends; also the number of runs to wait after valve ON before making a final decision
  - `temp_debounce`              (default: 2)  — minimum temperature difference (°C) between panel and boiler required to act; prevents valve toggling when temperatures are nearly equal
  - `probe_interval_min`         (default: 90) — when panel readings are invalid and valve is OFF during operational hours, how many minutes to wait between probe attempts; prevents continuous probing on cloudy days
  - `probe_max_boiler_temp`      (default: 50) — probe is skipped if boiler temp ≥ this value; at high boiler temp the cold water entry loss from opening the valve outweighs any potential solar gain
  - `probe_max_delta`            (default: 20) — probe is skipped if (boiler_temp − panel_temp) > this value; large delta means pipe water is very cold relative to boiler, so opening the valve causes significant heat loss; probe retries next run when delta shrinks
  - `consumption_temp_delta`     (default: 3.0) — minimum boiler temperature drop (°C) to qualify as a hot water consumption event
  - `consumption_time_delta`     (default: 15) — time window (minutes) over which the drop is scanned; agent looks back this many minutes in raw_data each run
  - `consumption_descent_trigger_c` (default: 0.4) — per-step descent trigger (°C). A drop candidate starts when two consecutive `raw_data` rows differ by ≥ this value. Must be ≥ `wf96c_temp_delta_c` so a minimum-delta dedupe write doesn't fire the trigger by itself. Lower = catches slower drops but more sensor-noise candidates entered (still rejected by the total-drop check). Hot-reloaded by the boiler agent each run — no restart needed
  - `glitch_drop_threshold_c`    (default: 10.0) — sensor-dropout guard: drops ≥ this °C must pass the bounce test before being recorded; set to 0 to disable guard entirely
  - `glitch_bounce_recovery_c`   (default: 8.0) — if boiler recovers to within this many °C of the pre-drop temperature within 2 polls after the event ends, treat the drop as a sensor fault and discard (real showers cannot refill the boiler that fast)
  - `wf96c_temp_delta_c`         (default: 0.3) — minimum °C change in boiler_temp or panel_temp required for `boiler-mqtt-ingest.service` (LXC 103) to write a new `raw_data` row. Hot-reloaded by the ingest service every 60 s (no restart). Lower = finer detail + more rows; higher = fewer rows + risk of slow drift being missed
  - `wf96c_heartbeat_sec`        (default: 60) — maximum seconds between `raw_data` writes when nothing has changed; keeps freshness signals + sync_signals flowing during steady-state. Hot-reloaded same as above


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
- **Detecting waiting phase:** scan the last `trend_runs * 2 + 5` rows in `agent_boiler_data` (enlarged window so that increasing `trend_runs` mid-phase doesn't hide the `turn_on` row); if `turn_on` appears within those rows AND every row more recent than it has decision = `waiting`, the waiting phase is active. If any resolved decision (`keep_on`, `turn_off`, `hold`, `no_action`) appears between the most recent row and the `turn_on`, the waiting phase has already resolved — do not re-enter it. If `turn_on` is found further back than `trend_runs` rows (settings changed mid-phase), treat current run as the final waiting run.
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
- **Probe Fire Logic — checks in order:**
  1. `minutes until 19:00 < probe_cost_min` → skip: "Probe skipped: only Xm until end of operations, probe needs Ym to complete"
  2. `boiler_temp >= probe_max_boiler_temp` → skip: "Probe skipped: boiler X°C >= probe_max_boiler_temp Y°C — boiler warm enough, cold water entry loss not worth it"
  3. `(boiler_temp − panel_temp) > probe_max_delta` → skip: "Probe skipped: delta X°C > probe_max_delta Y°C — panel too cold relative to boiler"
  4. `time_since_close >= probe_interval_min` → fire: "Probe: panel reading invalid, opening valve to evaluate solar heating"
  5. else → "Probe: panel reading invalid, probe timer not elapsed (X/Y min)"
- `probe_cost_min = panel_valid_after_on + (trend_runs + 1) × run_interval_min` — minimum minutes needed to complete probe + waiting phase
- Time since last valve close determined by finding the most recent row in `raw_data` where `valve_state` changed ON→OFF; if no such transition exists, panel reading is treated as **valid** → falls through to Normal Turn ON check. **Look-back window is time-based** (`now() − interval '3 days'`) since 2026-04-25 — previously `LIMIT 500` rows, which silently broke when the WF96C MQTT ingest cutover on 2026-04-23 multiplied row cadence ~20× and shrank the 500-row window from ~41 hours to ~2 hours. Same fix applied to `get_time_since_last_open` for symmetry. See `_VALVE_TRANSITION_LOOKBACK` in `boiler_agent.py`.
- **Probe timer resets on every valve close** — whether by normal decision, early waiting-phase abort, or Safety Rule
- Guards 2 and 3 do NOT reset the probe timer — probe retries next run automatically when boiler cools or delta shrinks
- → Enter Waiting Phase (same as Normal Turn ON)

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
- Scan raw_data for the last `consumption_time_delta + 2 × run_interval_min` minutes — the padding guarantees at least one baseline row before the drop, so a sudden 1-tick fall anchors to the pre-drop temperature rather than the post-drop reading (fixed 2026-04-15)
- Start a candidate event when two consecutive rows differ by ≥ `consumption_descent_trigger_c` (default 0.4°C, settings-tunable since 2026-04-27 — was hardcoded 0.5°C, which silently missed slow drops where each WF96C dedupe step landed at ~0.3-0.4°C and never crossed 0.5). Extension: keep chaining forward as long as the next row is within `JITTER_TOL_C` (0.2°C) of the running minimum. The event ends EITHER when temperature recovers meaningfully above that floor, OR when `PLATEAU_K` (5) consecutive readings sit at/near the floor without a meaningful new minimum — i.e. the boiler has settled (fixed 2026-04-27: previously the chain only ended on recovery, but boilers don't naturally bounce back after a real drop, so the chain would extend through the slow post-drop coasting all the way to the last row in the lookback window, `min_idx` would land at the end, and the safety check `min_idx < len(rows) - 1` would always fail — real drops were silently never recorded). Earlier fix 2026-04-24 replaced an even older per-step ≥ 0.3°C threshold (sized for 5-min cron rows) that bailed almost immediately once WF96C MQTT ingest at 2-3 s cadence replaced the cron on 2026-04-23, silently fragmenting real drops into tiny sub-events. Only record completed events (drop has ended)
- Record event if total drop ≥ `consumption_temp_delta`; insert into `boiler_consumptions` with ON CONFLICT DO NOTHING (deduplicated by start_ts)
- **Sensor-dropout guard** (added 2026-04-19): any candidate drop ≥ `glitch_drop_threshold_c` is checked for implausible recovery — if the boiler temperature bounces back to within `glitch_bounce_recovery_c` of the pre-drop reading within 2 polls after the event ends, the drop is discarded as a sensor / HA dropout. Real consumption cannot refill the boiler that fast. Logged as `WARN: Glitch skipped:` for forensics. Set `glitch_drop_threshold_c = 0` to disable the guard entirely
- On each genuinely new insert (rowcount=1), publish the event to MQTT topic `mur/home/device/boiler/event` (user `boiler_agent` on LXC 107) with payload `{dps: {event_type, drop_c, duration_min, start_ts, end_ts, start_temp, end_temp, valve_state, valve_on_min, valve_off_min}}`. Publish is fail-silent — broker downtime never breaks detection. The rule engine on LXC 105 subscribes via `mur/home/device/+/event`; the `Boiler Consumption Classify` rule uses presence + valve context for 5-category classification (human/panel/thermal/boiler/unknown) and writes back `cause` + `likely_rooms` to the same row asynchronously. **Sensor-coverage safety net** (added 2026-04-19): the `boiler` fallback branch refuses to confidently classify as "natural cooling" if any of the water rooms (Bathroom, Kitchen, My BathRoom) has no presence sensor registered — a human shower there would be invisible to the rule, so the row is labeled `unknown` instead. The consumption row is still recorded; only the `cause` is conservative. Once every water room has a presence sensor, this path dissolves automatically.

## 8. Return report:
  boiler_temp, panel_temp, valve_state,
  boiler_trend, panel_trend,
  decision, why_decision, error,
  next_ts, version.


# Boiler Dashboard Pages

> System-wide dashboard info (sidebar, pages list, DB tables, settings) is in root `CLAUDE.md` under "Dashboard Server".
> This file documents only boiler-specific dashboard pages and logic.

## Style
- CRM style, paged
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
- **Hot Water Usage — Today card** (below Last Report): event count, classification chips (all 5 causes: `Human` / `Panel` / `Thermal` / `Boiler` / `Unknown`), largest drop, avg drop, last event time; fetched from `/api/consumptions/today` which returns split counts per cause. **Classification color palette** (used by chips, graph triangles, and consumption-events table in Data page — always keep these 3 places in sync): Human `#1565c0` (dark blue), Panel `#e67e22` (orange, matches Panel Temp line on graph), Thermal `#2e7d32` (green), Boiler `#4a9eff` (blue, matches Boiler Temp line on graph), Unknown `#b8860b` (goldenrod). The 3 places are: `index.html` span IDs `usage-*`, `graph.js` const `CAUSE_COLORS`, `data.js` const `causeColor`.
  - Uses same 7-column grid as Last Report (`0.7fr 2fr 1.3fr 1.3fr 0.7fr 1fr 1fr`) with `status-grid-divided` vertical lines
  - Items placed at specific columns to align dividers with Last Report: Events=col1, Largest Drop=col3, Avg Drop=col4, Last Event=col5
  - Largest Drop has `border-left` + `margin-left:-16px` so its left divider aligns exactly with Valve State's left divider in Last Report
  - Largest Drop, Avg Drop, Last Event are `text-align:center`
- **Settings card** (sectioned with uppercase headers since 2026-04-24 for easier navigation):
  - **Data Update**: `run_interval_min` (max sleep ceiling), `sync_poll_interval_sec` (actual run cadence)
  - **Decision Tuning**: `panel_temp_valid_after_on`, `panel_temp_valid_after_off`, `trend_runs`, `temp_debounce`, `probe_interval_min`
  - **Hot Water Consumption**: `consumption_temp_delta`, `consumption_time_delta`, `consumption_descent_trigger_c`
  - **Probe Temperature Constraints**: `probe_max_boiler_temp`, `probe_max_delta`
  - **Sensor Glitch Guard** (labels rendered in light red `#d96c6c` to signal these are safety/correctness knobs, not tuning): `glitch_drop_threshold_c`, `glitch_bounce_recovery_c`
  - **WF96C Ingest** (raw_data dedupe — see Data Flow above): `wf96c_temp_delta_c`, `wf96c_heartbeat_sec`. Values hot-reloaded by `boiler-mqtt-ingest.service` on LXC 103 every 60 s, no restart required.
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
- Consumption events as downward triangles on boiler temp line (at start_temp height), **colored by classification cause** (Human dark blue / Panel orange / Thermal green / Boiler blue / Unknown goldenrod — see Hot Water Usage card for palette); tooltip shows drop °C + duration
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

## Water Consumption tab (since 2026-06-08)
6th tab on the Boiler Agent page (`index.html`, `showMainTab('water')`), modeled on the **Project Power → Settings tab** (Billing Cycle + Tariff + Past Bills) but for **Israeli household water billing**. **Independent of the boiler agent** — uses its own `water_bills` table + `dashboard_settings.water.{billing,tariff}` keys; zero overlap with boiler logic/data. JS: `public/js/water.js` (`waterOnTabShow()` entry, `ws*`/`wb*`/`wc*` functions; loaded via `js/water.js?v=N`). Endpoints in **`routes-water.js`** (own module wired into server.js via one `require()` line — the architecture-guard hook blocks new `app.<method>(`/`async function` in server.js; `/api/power/*` are inline only because they predate the hook).
- **Cards**: (A) **Current Period (Water)** — meter-ready placeholder; renders "meter not connected yet" until a flow sensor is added (Phase 2). (A2) **Consumption graph** (2026-06-08) — Chart.js grouped bar chart of Private vs Shared m³ per bill, with a **View** selector: `By bill (each period)` / `Yearly totals` (sum private+shared per calendar year) / `Last 2/3/4/5 years` (per-period, filtered by `period_start` year vs the newest bill). `wgLoad()` in water.js reads `/api/water/bills`, sorts chronologically, aggregates client-side; single `_wgChart` instance destroyed/recreated on range change. Chart.js is already loaded on the Boiler page. (B) **Water Billing Cycle** (start_day / length_months default 2 = bi-monthly / current_period_start_date). (C) **Water Tariff** — persons_in_household, low-tier ₪/m³ + quota (base + per-person), high-tier ₪/m³, VAT, currency. (The **Sewage handling + Sewage rate + Fixed/standing charge** inputs were removed from the UI 2026-06-08 per user — they only fed the now-hidden estimate; the backend keeps them as harmless defaults `sewage_mode='bundled'`, `fixed_charge=0` for `_waterComputeCost` / Phase 2.) ⚠ defaults are PLACEHOLDERS flagged "verify against your bill". Only **low_tier_rate + VAT** are live-used today (tariff-drift sync); the rest persist for a possible future estimate. (D) **Past Water Bills** — `+ Paste bill (PDF)` or `+ Add manually` → **editable confirm modal** (period / **private m³** / **shared m³** / actual ₪) → `POST /api/water/bills`; table **Period / Private m³ Δ / Shared m³ Δ / Cost ₪ / Diff ₪** (the Estimate, Source + Uploaded columns were all dropped per user 2026-06-08). Period renders compact as `5-6 2024`. Private/Shared each show their **Δ vs the previous period** (▲ red = more, ▼ green = less); the **Diff ₪** column is the cost change vs the previous bill (not est-vs-actual). `total_m3 = private + shared` (computed server-side). `water_bills` has `private_m3` + `shared_m3` columns.

**Tariff-drift detection (like Project Power, 2026-06-08):** on PDF upload the parser also extracts the **recognized/low-tier rate** (summed `כמות מוכרת` rows — bills split it into water+sewage, e.g. 9.67+4.37=14.04) + **VAT%**. The upload endpoint compares both to the saved Water Tariff; if either differs > 1% it returns a `diff[]`, and after the bill is saved the frontend pops a **"⚠ Tariff change detected → Update settings"** modal (`wbShowDriftModal`/`wbApplyDrift`) that one-click-syncs `water.tariff`. **Only those two fields are auto-checked** — the additional/high-tier rate is split inconsistently across bills and the quota is rarely exceeded, so it's too erratic to auto-detect (left for manual edit). VAT change (17%→18%) and the recognized-rate updates are detected reliably. (The tariff card no longer drives an on-screen estimate, but it remains the drift-sync target / record of current rates.)
- **Cost formula** `_waterComputeCost(tariff, m3, daysElapsed)` (routes-water.js): tiered + pro-rated. `quota = (base + persons×per_person) × daysElapsed/30.42`; `low = min(m3, quota)`, `high = m3−quota`; `pretax = low×low_rate + high×high_rate + (separate sewage? m3×sewage_rate : 0) + fixed×months`; `total = pretax × (1+VAT/100)`. (Estimate is a sanity-check vs the bill's actual; exact match not required — real Israeli bills also split private vs shared-building consumption.)
- **PDF parser** `_parseWaterBill(text)` — tuned to the **מי הוד השרון / Maya Water** bill (mayawater.co.il). **KEY FINDING (2026-06-08):** on these bills the summary labels (`סה"כ לחיוב` / `סה"כ לתשלום` / `נפשות`) are rendered as **graphics**, so `pdf-parse` never emits them — label-anchoring is impossible (the first attempt parsed the period but returned NULL m³/cost). Instead it anchors on the two signals that DO survive as text: the **total-to-pay** amount after the shekel sign (`₪ 236.47`), and the **total consumption m³** printed immediately before it (`21.53\n₪ 236.47` — the real private+shared total, not a tier sub-quantity). VAT% derives from the still-labeled excl-VAT subtotal (`סה"כ ללא מע"מ`) + total. Period from `MM-MM/YYYY`. **Upload only PARSES + RETURNS** (no insert) — the confirm modal lets the user verify/fix before saving, so an imperfect parse is still usable. Validated end-to-end against the user's real bill (`heshbon.pdf`): period 03-04/2026 → **m³ 21.53, ₪236.47, VAT 18%**. Other corporations / older layouts fall through to the confirm modal (parse returns nulls). Diagnose new layouts by dumping `new PDFParse({data}).getText()` and finding which numbers/labels survive as text.
- **DB**: `water_bills` (id, uploaded_at, period_start/end, total_m3, total_cost_ils, est_cost_ils, raw_text, parsed JSONB, source, notes) on LXC 102, retention=forever, registered in Health DB-Volumes. `GET /api/water/status` returns `{meter_connected:false}` in Phase 1.
- **Phase 2 (future, when a water meter is added)**: live m³ ingest (Tuya flow sensor vs ESP — TBD) → `/api/water/status` returns live period m³ + cost → Card A lights up automatically (`wcRender` already keys off `meter_connected`).

## Local Server Setup
- Dashboard server: `BOILER/dashboard/server.js`, port **3000**, binds to `127.0.0.1`
- Secrets stored in `BOILER/dashboard/.env` (gitignored): `HA_TOKEN`, `ANTHROPIC_API_KEY`, `DB_PASS`
- `ecosystem.config.js` loads `.env` automatically at startup — always start with `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`
- ⚠ **NEVER use `pm2 restart`** — it caches the old process environment and ignores `.env` changes (causes stale HA tokens and wrong secrets)
- ⚠ **Restart policy lives in `ecosystem.config.js`, which is GIT-IGNORED** (it maps secrets out of `.env`). If this machine is ever rebuilt from git, re-add these two keys to the app block or the dashboard becomes killable-for-good again: **`min_uptime: 30000`** and **`restart_delay: 5000`**. Reason: pm2's defaults (min_uptime 1 s, max_restarts 16) let a network outage stop the app permanently — an instant exit counts as an "unstable" restart, 16 happen within seconds, and pm2 then leaves it `errored` until started by hand. That happened on 2026-05-14, 2026-05-29 and 2026-08-24. See [[incident_dashboard_crash_loop]].
- Dependencies: `express`, `pg`, `node-ssh`, `@anthropic-ai/sdk` (in `node_modules`)
- PM2 env vars required: `HA_TOKEN`, `ANTHROPIC_API_KEY` — sourced from `.env` (never hardcode in ecosystem.config.js)

> System-wide page specs (Health, Weather, Network) are in root `CLAUDE.md`.

# Main Agent (Orchestrator)
> Full orchestrator documentation: see `ORCHESTRATOR/CLAUDE.md`

## Agent Alert Behaviour (boiler agent — Step 0b)
At start of each run, before any logic:
- Query `system_alerts` for unresolved alerts where `affected_agent = 'boiler' OR affected_agent IS NULL`
- If `severity = error/critical` → write `decision = no_action`, `error = WARN: System alert: <type>: <message>`, exit safely
- If `severity = warn` → continue run, include in error field as warning
