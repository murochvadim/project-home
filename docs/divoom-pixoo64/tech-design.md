# Tech Design: Divoom Pixoo64 Display Service

**Discovery:** [discovery.md](discovery.md)
**Date:** 2026-04-09
**Status:** Draft

## 1. Summary

Build a standalone Pixoo64 display service on LXC 100 that subscribes to Rule Engine computed state via MQTT and renders rotating screens (clock, home status, weather, boiler) on the 64x64 LED display. Uses the `divoom-pixoo` Python library for display control and paho-mqtt for state subscriptions.

### Non-Goals
- Dashboard control panel for Pixoo (v2)
- Hebrew text support (v2)
- Notification overlay system (v2)
- Brightness auto-schedule (v2)
- Custom pixel art animations (v2)

## 2. Current Behavior

No Pixoo/Divoom code exists. The display is unmanaged. Rule Engine already publishes computed home state to MQTT retained topics at `mur/home/rule-engine/computed/{key}`.

## 3. To-Be Behavior

### System Flow

1. `pixoo_service.py` starts on LXC 100 → connects to MQTT → subscribes to computed state topics
2. On connect: retained messages provide current home state immediately
3. Service maintains in-memory state dict from MQTT updates
4. Screen rotation timer fires every 10s → renders next screen to Pixoo64 via HTTP
5. On MQTT state change: update in-memory state (display refreshes on next rotation)
6. Heartbeat: write to `pixoo_log` every 60s for orchestrator monitoring
7. LWT on `mur/home/pixoo/state` → offline on disconnect

### Screen Rotation

```
Clock (10s) → Home Status (10s) → Weather (10s) → Boiler (10s) → repeat
```

Each screen is a Python function that builds a Pixoo display frame using the `divoom-pixoo` library.

## 4. Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Service location | LXC 100 standalone | LXC 105, integrate into player_service | LXC 100 is media/display LXC. Standalone = clean separation |
| Display library | `divoom-pixoo` Python library | Raw HTTP POST | Library already installed, handles protocol details |
| State source | MQTT subscription | DB polling | Real-time, reactive, consistent with architecture |
| Screen rotation | Timer-based, 10s per screen | Event-driven | Simple, predictable. Display doesn't need instant updates |
| Weather data | DB query (raw_weather) | MQTT (not published) | Weather data not on MQTT. Simple DB read every rotation cycle |
| Boiler data | DB query (agent_boiler_data) | MQTT (not published) | Same — boiler state not on MQTT yet |

## 5. Interfaces / Models

```python
# scripts/pixoo_service.py

class PixooService:
    """Manages Pixoo64 display with rotating screens."""
    
    def __init__(self):
        self.pixoo: Pixoo           # divoom-pixoo library instance
        self.mqtt: mqtt.Client      # paho MQTT client
        self.state: dict            # home state from MQTT
        self.screens: list          # list of screen render functions
        self.current_screen: int    # index into screens
        self._stop: threading.Event
    
    def connect_pixoo(self):
        """Initialize Pixoo64 connection."""
    
    def connect_mqtt(self):
        """Connect to MQTT broker, subscribe to computed state."""
    
    def on_mqtt_message(self, client, userdata, msg):
        """Update in-memory state from MQTT."""
    
    def rotate_screen(self):
        """Advance to next screen and render it."""
    
    def render_clock(self):
        """Draw clock screen — time + date."""
    
    def render_home_status(self):
        """Draw home status — mode, people, active rooms."""
    
    def render_weather(self):
        """Draw weather — temp, condition, humidity."""
    
    def render_boiler(self):
        """Draw boiler — temps, valve state."""
    
    def write_heartbeat(self):
        """Write to pixoo_log for orchestrator."""
    
    def run(self):
        """Main loop — rotation timer + MQTT."""
```

### Screen Layouts (64x64 pixels)

**Clock Screen:**
```
┌──────────────────────┐
│                      │
│      21:45           │  Large font, centered
│    Wed 09 Apr        │  Smaller font below
│                      │
└──────────────────────┘
```

**Home Status Screen:**
```
┌──────────────────────┐
│  HOME: Active        │  Green/Yellow/Grey
│  People: 2           │
│  Living Room         │  Active rooms
│  Kitchen             │  (scroll if >3)
└──────────────────────┘
```

**Weather Screen:**
```
┌──────────────────────┐
│  WEATHER             │
│  24°C  Sunny         │
│  Humidity: 45%       │
│  UV: 6               │
└──────────────────────┘
```

**Boiler Screen:**
```
┌──────────────────────┐
│  BOILER              │
│  Panel: 52.1°C       │
│  Boiler: 48.3°C      │
│  Valve: ON           │
└──────────────────────┘
```

## 6. Implementation Details

### Component 1: Pixoo Service core

- **File:** `scripts/pixoo_service.py` (new)
- **Details:**
  - Import `pixoo` from divoom-pixoo library
  - Init `Pixoo('192.168.1.243', 64)` — IP from env var, size 64
  - MQTT: paho client, subscribe to `mur/home/rule-engine/computed/+`
  - State dict: `{'people_home': 0, 'home_mode': 'away', 'active_rooms': [], ...}`
  - Screen list: `[render_clock, render_home_status, render_weather, render_boiler]`
  - Main loop: `time.sleep(10)` → `rotate_screen()` → next screen function → `pixoo.push()`
  - Heartbeat: every 60s write to `pixoo_log`
  - LWT: `mur/home/pixoo/state` → `{"state":"offline"}`
  - Signal handlers: SIGTERM/SIGINT → clean shutdown

### Component 2: Screen render functions

- **File:** `scripts/pixoo_service.py` (same file)
- **Extract — `render_clock()`:**
  - Use `pixoo.draw_text()` for time (large font) and date (small font)
  - Asia/Jerusalem timezone
  - Colors: white text on black background

- **Extract — `render_home_status()`:**
  - Title "HOME" with mode color (green=active, yellow=idle, grey=away)
  - People count
  - Active rooms list (first 3, truncate names to fit)

- **Extract — `render_weather()`:**
  - Query DB: `SELECT * FROM raw_weather ORDER BY ts DESC LIMIT 1`
  - Show: temperature, condition, humidity, UV index
  - Colors: blue theme

- **Extract — `render_boiler()`:**
  - Query DB: `SELECT * FROM agent_boiler_data ORDER BY ts DESC LIMIT 1`
  - Show: panel temp, boiler temp, valve state
  - Colors: orange/red theme

### Component 3: MQTT setup

- **File:** `scripts/pixoo_service.py` (same file)
- **Details:**
  - paho-mqtt client with LWT
  - Subscribe to `mur/home/rule-engine/computed/+`
  - On message: parse JSON, update `self.state` dict
  - Auto-reconnect via `loop_start()`

### Component 4: Mosquitto user + ACL

- **Target:** LXC 107
- **ACL:**
  ```
  user pixoo_service
  topic read mur/home/rule-engine/computed/#
  topic readwrite mur/home/pixoo/#
  ```

### Component 5: DB tables + agent registration

- **Target:** LXC 102
- **SQL:**
  ```sql
  CREATE TABLE pixoo_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      decision TEXT,
      error TEXT,
      next_ts TIMESTAMPTZ
  );
  
  INSERT INTO agents (name, lxc_id, lxc_ip, service_name, data_table, enabled)
  VALUES ('pixoo', 100, '192.168.1.138', 'pixoo', 'pixoo_log', true);
  
  INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours)
  VALUES ('pixoo_log', 30, true, 24);
  ```

### Component 6: Systemd service + env file

- **Target:** LXC 100
- **Service:** `pixoo.service`
- **Env:** `/etc/pixoo.env` with PIXOO_IP, MQTT_BROKER, MQTT_USER, MQTT_PASS, DB_HOST

## 7. Config / Segmentation Plan

| Key | Type | Default | Location |
|-----|------|---------|----------|
| `PIXOO_IP` | string | `192.168.1.243` | `/etc/pixoo.env` |
| `MQTT_BROKER` | string | `192.168.1.189` | `/etc/pixoo.env` |
| `MQTT_USER` | string | `pixoo_service` | `/etc/pixoo.env` |
| `MQTT_PASS` | string | — | `/etc/pixoo.env` |
| `DB_HOST` | string | `192.168.1.219` | `/etc/pixoo.env` |
| `SCREEN_INTERVAL` | int | `10` | Hardcoded, changeable later |

## 8. BI Event Spec

N/A — Pixoo service logs to `pixoo_log` table.

## 9. Error Handling & Edge Cases

| Scenario | Handling | Fallback |
|----------|----------|----------|
| Pixoo64 offline | HTTP timeout (3s). Log warning. Skip render, try next cycle | Display shows last content |
| MQTT broker down | paho auto-reconnect. State freezes at last known | Display continues with stale data |
| DB down (weather/boiler query) | Catch exception, skip that screen in rotation | Show "N/A" or skip to next screen |
| Pixoo library error | Catch, log, recreate Pixoo instance on next cycle | Service stays running |
| LXC 100 restart | systemd auto-starts pixoo.service. MQTT retained messages provide state | Display recovers within 10s |

## 10. Rollout Plan

- **Phase 1:** Deploy service with clock + home status screens only
- **Phase 2:** Add weather + boiler screens after verifying Phase 1
- **Rollback:** `systemctl stop pixoo` on LXC 100. Display stays on last content.

## 11. Test Plan

### Manual Checklist
- [ ] Service starts, Pixoo64 shows clock
- [ ] After 10s, display rotates to home status
- [ ] Walk into room → home status updates on next rotation
- [ ] Kill MQTT → display continues with stale data, reconnects
- [ ] Kill Pixoo service → LWT fires, display stays on last content
- [ ] Restart Pixoo service → display resumes rotation
- [ ] Check `pixoo_log` table has heartbeat entries

## 12. Ordered Task List

1. **Create Pixoo service core** → New file `scripts/pixoo_service.py`. MQTT connection, state management, screen rotation loop, heartbeat, signal handlers. Acceptance: service starts, connects MQTT, rotates screens.

2. **Implement screen render functions** → Add `render_clock()`, `render_home_status()`, `render_weather()`, `render_boiler()` to `scripts/pixoo_service.py`. Each function uses divoom-pixoo library to draw on 64x64 display. Acceptance: all 4 screens render correctly.

3. **Infrastructure setup** → Mosquitto user/ACL, DB tables, agent registration, systemd service, env file, paho-mqtt install. Acceptance: service runs on LXC 100, orchestrator monitors it.

## 13. Open Items / Follow-ups

- [ ] Dashboard Pixoo control card (brightness, channel, text input)
- [ ] Notification overlay system (temporary display on events)
- [ ] Brightness auto-schedule (dim at night)
- [ ] Hebrew text rendering (pixel font or image-based)
- [ ] Custom pixel art screens (icons for weather, home mode)
- [ ] MQTT publish for boiler/weather state (eliminate DB polling)
