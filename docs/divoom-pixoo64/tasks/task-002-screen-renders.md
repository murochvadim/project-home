# Task 2: Screen Render Functions

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md) — Section 5 (Screen Layouts) + Section 6, Component 2

## Description
Implement the 4 rotating screen render functions using the divoom-pixoo library. Each draws on the 64x64 pixel display.

## Steps
1. `render_clock()`:
   - Clear screen (black background)
   - Draw time (HH:MM) in large font, centered, white
   - Draw date (Day DD Mon) in smaller font below, grey
   - Use Asia/Jerusalem timezone
   - `pixoo.push()` to send frame

2. `render_home_status()`:
   - Title "HOME" with color based on `self.state['home_mode']`: green=active, yellow=idle, grey=away
   - "People: N" line
   - Active rooms list (from `self.state['active_rooms']`), max 3 lines, truncate names >10 chars
   - `pixoo.push()`

3. `render_weather()`:
   - Query DB: `SELECT temp_balcony, humidity_balcony, uv_index_balcony, condition FROM raw_weather ORDER BY ts DESC LIMIT 1`
   - Title "WEATHER" in blue
   - Temperature, condition, humidity, UV on separate lines
   - Handle NULL values (show "N/A")
   - `pixoo.push()`

4. `render_boiler()`:
   - Query DB: `SELECT boiler_temp, panel_temp, valve_state FROM agent_boiler_data ORDER BY ts DESC LIMIT 1`
   - Title "BOILER" in orange
   - Panel temp, boiler temp, valve state (ON/OFF with color)
   - Handle NULL values
   - `pixoo.push()`

5. DB connection for weather/boiler: use psycopg2 with autocommit, `_ensure_conn()` pattern

## Status
- [x] Complete
