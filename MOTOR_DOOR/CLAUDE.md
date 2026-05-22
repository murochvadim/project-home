# MOTOR_DOOR — Living Room Mosquito-Net Door

ESP32-based motorized door controller for the **mosquito net door beside the moving glass door to the balcony** (living room). Bi-directional DC motor on a reel pulls the screen open/closed; encoder feedback + LD2420 mmWave presence sensor enable auto-open-on-approach and auto-close-when-clear.

Companion to the [BALCONY](../BALCONY/CLAUDE.md) agent — calibration and monitoring UI lives on the balcony's HASP touch panel (the one already mounted next to the balcony glass door). Same panel, dedicated page for the door's diagnostics + manual control.

## Hardware

| Component | Spec | Pin |
|---|---|---|
| **ESP32** (any dev-board variant) | Arduino-ESP32 core 3.x, LEDC PWM (20 kHz / 10-bit) | n/a |
| **BTS7960** H-bridge driver | 43 A bidirectional, hardware enable | LPWM=32, RPWM=33, L_EN=25, R_EN=26 |
| **DC motor + reel** | 242 ticks/rev (encoder), reel radius 3.7 cm → ~0.096 cm per tick | wired through BTS7960 |
| **Hall encoder** | Single-channel, RISING-edge ISR | ENC=4 |
| **LD2420 mmWave presence sensor** | UART2 @ 115200 baud, distance in cm | RX=15, TX=17 |
| **Magnet sensor** (end-stop) | Digital input | MAGNET=21 |

Note: BTS7960 current-sense pins (R_IS/L_IS) are documented in the old sketch but commented as "not working in driver BTS7960" — skipping in v2.

## Physical context

The mosquito screen door slides parallel to the glass balcony door, in the same wall opening. The mmWave sensor watches the inside of the living room → opens the screen when someone approaches the glass door, closes when the area clears for 10 s. Useful in summer when the glass door stays open: keeps mosquitoes out without manual screen-pulling.

## Existing sketch — `Motor_01_ver_10` (2,398 lines, 8 files)

Lives at `C:\Users\muroc\Arduino_Projects\Motor_01_ver_10\`. Status: works but predates the esp_boards framework — uses old MQTT broker / user, hardcodes `hasp/plate01/...` (the OLD panel-name) for panel pushes, no OTA, no schema declaration, no `mur/home/esp/<id>/...` topics. Worth keeping for reference; new sketch starts clean.

| File | Lines | Role |
|---|---|---|
| `Motor_01_ver_10.ino` | 1,082 | Main entry — WiFi/MQTT plumbing, HTTP /set_ip, command callback, big setup/loop |
| `Main.h` | 184 | MQTT config, EEPROM layout, LD2420 UART setup, globals |
| `MotorDriver.h` | 192 | `motorInit()`, `motorStop()`, `motorSetSigned(pct)` — LEDC PWM dispatch |
| `Encoder.h` | 251 | ISR + tick counter + stall detection + glide detection |
| `Calib.h` | 302 | Calibration state machine + EEPROM persistence |
| `AutoDoor.ino` | 115 | LD2420 → auto-open / auto-close logic |
| `Monitor.h` | 206 | Real-time tick comparison vs expected speed (panel diagnostic) |
| `Diagram.ino` | 66 | (panel-side drawing helpers) |

Key concepts to carry over to v2 — explained below.

## Critical concepts (must carry into v2)

### Encoder physics
- 242 ticks per motor revolution; reel circumference 23.25 cm
- `CM_PER_TICK = REEL_CIRCUMFERENCE_CM / ENC_TICKS_PER_MOTOR_REV` ≈ 0.096 cm
- `encoderGetDistanceCm() = gEnc_ticks * CM_PER_TICK`
- Position tracking is **integration of ticks since last calibration anchor** (no absolute encoder — single-channel Hall counts pulses only)

### Stall detection (motor jammed)
- Tracks tick progress every 130 ms (`ENC_STALL_NOPROGRESS_MS`)
- < 2 ticks (`ENC_STALL_MIN_TICKS`) in that window → stall → motor stops
- Prevents winding burnout when door is physically blocked

### Glide detection (motor slipping / belt creep)
- Evaluates speed every 200 ms (`ENC_GLIDE_WINDOW_MS`)
- Tunable threshold `ENC_GLIDE_MAX_TICKS` (EEPROM, default ~25) — if ticks/window ≤ this and > 0 → glide → motor stops
- Ignored for first 600 ms after move start (acceleration period)
- Used to detect end-of-travel without needing a hard end-stop

### Calibration state machine
States: `CALIB_IDLE → CALIB_MOVING_CLOSE → CALIB_MOVING_OPEN → CALIB_DONE` (or `CALIB_FAILED`)
- Phase 1: drive CLOSE direction until external code stops the motor (glide / stall / magnet) → that point = "closed" reference
- Phase 2: drive OPEN direction up to requested travel-cm OR until external stop → final state recorded
- End states: `UNKNOWN / CLOSED / MAX_OPEN / IN_MID / MAGNET`
- EEPROM persists: end state, span cm, valid flag, encoder glide threshold, motor speed percent

### Auto-door logic
- `AUTO_OPEN_TRIGGER_CM = 150` — opens if LD2420 distance ≤ 150 cm
- `AUTO_DOOR_DELAY_MS = 10000` — closes after 10 s with no presence
- Only acts when motor is stopped (`motionDir == DIR_COAST`)
- Disabled during calibration (`cal_mode_on == true`)
- Disabled by manual `auto_mode_on = false` toggle

### Motor speed table (calibration diagnostic)
Pre-measured ticks-per-200ms for each speed step — used by `Monitor.h` to compute "missed ticks" vs expected:

| Speed % | Ticks per 200 ms |
|---|---|
| 40 | 30 |
| 50 | 39 |
| 60 | 48 |
| 70 | 60 |
| 80 | 77 |
| 90 / 100 | 91 |

If actual ticks/window < expected → motor is dragging (heavy load / weak battery). Surfaces on panel page 7 as live diagnostic.

## New sketch — `Motor_Door_Claude` (planned, ESP32)

Mirrors the [Face_Recognition_Claude](../../../Arduino_Projects/Face_Recognition_Claude/) / [Toilet_ToTo_Claude](../TOTO_TOILET/CLAUDE.md) layout — esp_boards framework + OTA + plain MQTT to LXC 107 + schema-declared actions + status heartbeat.

### Planned file structure

```
Motor_Door_Claude/
├── Motor_Door_Claude.ino   (main: WiFi/MQTT, HTTP /set_ip, OTA service, loop dispatch)
├── Main.h                  (device_id, sketch identity, pin map, EspParams struct, forward decls)
├── Esp_Base.ino            (esp_boards framework — schema, topics, OTA, action dispatcher)
├── MotorDriver.ino         (LEDC PWM, motorInit/motorStop/motorSetSigned — ported as-is)
├── Encoder.ino             (ISR + tick counter + stall/glide — ported as-is, .h → .ino)
├── Calib.ino               (calibration state machine — ported, EEPROM in EspParams layout)
├── AutoDoor.ino            (LD2420 → auto-open logic — ported)
├── Monitor.ino             (real-time tick comparison — ported, hasp/plate01 → hasp/balcony)
└── Process_States.ino      (one place that ties the above into espBaseLoop() ticks)
```

`Encoder.h` and `Calib.h` are converted to `.ino` because Arduino's build system handles `.ino` files specially (auto-prototype generation). The existing sketch puts `static inline` functions in `.h` and `#include`s them from `.ino` — works but unusual. We can keep that pattern if cleaner, but for v2 the standard is `.ino` files in the sketch folder.

### MQTT topics (esp_boards framework)

```
mur/home/esp/motor_door_01/availability   — LWT, "online"/"offline"
mur/home/esp/motor_door_01/schema         — retained, declared actions + parameters
mur/home/esp/motor_door_01/status         — every 60 s
mur/home/esp/motor_door_01/config         — board listens — JSON parameter writes
mur/home/esp/motor_door_01/command        — board listens — plain string action key
mur/home/esp/motor_door_01/event          — board → broker — JSON acks + door events
```

### Self-declared schema

**Actions:**
- **Manual control**: `open`, `close`, `stop`
- **Calibration**: `calibrate_start`, `calibrate_cancel`
- **Auto-mode toggle**: `auto_on`, `auto_off`
- **Standard housekeeping**: `restart`, `clear_eeprom`, `factory_reset`, `reset_wifi`

**Parameters (dashboard-tunable via /config):**
- `motor_speed_pct` (int, 40-100, default 60) — calibration + runtime motor speed
- `enc_glide_max_ticks` (int, 5-50, default 25) — glide-stop sensitivity
- `max_dist_cm` (float, 10-300, default 200) — soft max open distance
- `auto_open_trigger_cm` (int, 50-300, default 150) — LD2420 distance threshold for auto-open
- `auto_close_delay_sec` (int, 5-120, default 10) — delay after no-presence before auto-close
- `auto_mode_enabled` (bool, default true) — global auto-mode gate

### Status payload (60 s heartbeat + on-event)

```json
{
  "ip": "192.168.1.X",
  "rssi": -55,
  "uptime_s": 12345,
  "free_heap": 200000,
  "sketch_name": "Motor_Door_Claude",
  "sketch_version": "v1",
  "build_ts": "May 21 2026 22:30:00",
  "door_state": "closed",           // closed / max_open / in_mid / magnet / unknown
  "door_dist_cm": 0.0,              // current integrated distance
  "max_dist_cm": 200.0,
  "motor_state": "coast",           // coast / opening / closing
  "motor_pct": 0,
  "calibration_valid": true,
  "calibration_state": "idle",      // idle / moving_close / moving_open / done / failed
  "auto_mode_enabled": true,
  "ld2420_distance_cm": 132,
  "presence_now": true,
  "last_stall": false,
  "last_glide": false,
  "encoder_ticks_total": 4583,
  "encoder_ticks_per_200ms": 47     // live diagnostic
}
```

## Balcony HASP panel integration

The user's [BALCONY](../BALCONY/CLAUDE.md) panel (192.168.1.141, plate `balcony`, MQTT prefix `hasp/balcony/`) already exists. The old sketch uses `hasp/plate01/...` — that's a **stale panel name from before the rename to `balcony`**. New sketch publishes to `hasp/balcony/...` exclusively.

### Page layout — Page 7 (Door Calibration + Monitoring)

Mostly identical to the old sketch's layout. Topic prefix changes from `hasp/plate01/command/p[7].b[X].text` to `hasp/balcony/command/p7b<X>.text` (note the dot-bracket → no-separator change matches OpenHASP 0.7+ convention).

| Object | Purpose |
|---|---|
| `p7b1.text` | Move-state: total missed ticks |
| `p7b2.text` | Move-state: total real distance (cm) |
| `p7b3.text` | Move-state: total missed distance (cm) |
| `p7b7` | Slider: encoder glide ticks (writes back to `enc_glide_max_ticks` parameter) |
| `p7b8.text` | Slider value display: glide ticks |
| `p7b9` | Slider: motor speed (writes back to `motor_speed_pct` parameter) |
| `p7b10.text` | Slider value display: motor speed |
| `p7b14.text` | Stop-state: total ticks counted (post-stop drift detection) |
| `p7b15.text` | Stop-state: total distance counted |
| `p7b16.text` | Spare |

### Page 6 (Manual control + door position display) — to confirm layout
| Object | Action |
|---|---|
| `p6b7` (Open button) | Publishes `mur/home/esp/motor_door_01/command` ← `open` |
| `p6b8` (Close button) | ← `close` |
| `p6b9` (Stop button) | ← `stop` |
| `p6b16` (Auto toggle) | ← `auto_on` / `auto_off` |
| Distance / position labels | Reflected from device status (rule-driven via `my_bathroom_displays.py`-style rule) |

Button bindings live in `dashboard_settings.balcony.button_bindings` (existing pattern). A new rule `balcony_motor_door_reflect.py` (sibling of `balcony_displays.py`) subscribes to `mur/home/esp/motor_door_01/status` + `event` and publishes `hasp/balcony/command/p<N>b<M>.text` updates so the panel reflects live door state.

## Devices in the project

`devices` table row (auto-created by the rule engine on first /availability message, or explicitly via migration):

```sql
INSERT INTO devices (id, name, protocol, device_type, room, mac, dps_labels, dps_config)
VALUES (
  'motor_door_01',
  'Mosquito Net Door',
  'esp',
  'door',
  'Living Room',
  '<board MAC>',
  '{
    "door_state":   "Position",
    "door_dist_cm": "Distance",
    "motor_state":  "Motor",
    "ld2420_distance_cm": "Presence Distance"
  }',
  '{
    "open":  {"action_on": "open",  "type": "action"},
    "close": {"action_on": "close", "type": "action"},
    "stop":  {"action_on": "stop",  "type": "action"}
  }'::jsonb
);
```

This lets the device be addressable from rule sentences (`@Mosquito Net Door open`) and shown on the Project Boards page + apartment layout.

## Phase plan

| Phase | What ships | Effort |
|---|---|---|
| **Phase 1** | New sketch written: `Motor_Door_Claude/` with all 9 files. Compiles via arduino-cli (ESP32 FQBN). | 2-3 h |
| **Phase 2** | Flashed to hardware via USB (first time). Smoke test: schema appears on Project Boards page, status payloads visible. | 30 min on-site |
| **Phase 3** | Calibration run: open Project Boards `motor_door_01` tab → click `calibrate_start` → door auto-finds closed + open extents → EEPROM persists span. | 15 min on-site |
| **Phase 4** | Manual control verified: open/close/stop via dashboard buttons. Stall + glide detection working. | 30 min on-site |
| **Phase 5** | LD2420 + auto-mode: walk near door → opens; leave → closes 10 s later. | 30 min on-site |
| **Phase 6** | Balcony panel page 7 reflection: bind `dashboard_settings.balcony.button_bindings` for open/close/stop/auto + write new `balcony_motor_door_reflect.py` rule for status→panel display updates. | 1-2 h |
| **Phase 7** | Project integration: insert `devices` row, expose `@Mosquito Net Door` chip for rule sentences, possible interactions with `Home Activity` virtual device for living-room presence-driven scenes. | 1 h |

## Differences from old sketch (v2 deltas)

1. **MQTT broker**: `192.168.1.143 / mqtt_user / +_device_mqtt` → `192.168.1.189 / esp_boards / <password>` (LXC 107)
2. **No TLS** — old sketch supported `MOSQ_USE_TLS` switch with BearSSL + NTP time + CA cert; new sketch drops it (matches Face_Recognition_Claude / Toilet_ToTo_Claude pattern — plain TCP only on the internal MQTT broker)
3. **Topics**: `homeassistant/sensor/motor_01/...` + `tele/motor_01/LWT` → `mur/home/esp/motor_door_01/...` (esp_boards framework)
4. **HASP panel name**: `plate01` → `balcony`
5. **HASP object syntax**: `p[7].b[8].text` → `p7b8.text` (OpenHASP 0.7+ convention — verify against existing balcony panel)
6. **OTA**: not present in v1 → present in v2 via `ArduinoOTA` with `ESP_OTA_PASSWORD`
7. **Schema declaration**: not present in v1 → retained `schema` topic with full action + parameter list on every connect
8. **Status heartbeat**: scattered MQTT publishes throughout v1 → consolidated 60 s heartbeat with full JSON status (matches other esp_boards members)
9. **Config writes**: v1 uses one-off MQTT commands ("Set Speed 60") → v2 uses standard `/config` JSON parameter writes through esp_boards framework
10. **Device ID**: `motor_01` → `motor_door_01` (matches the verbose-with-room convention used by `toilet_01`, `face_01`, `gates_01`)

## OTA caveat (same as Toilet_ToTo_Claude)

`sketch_name` in v2 will be e.g. `Motor_Door_Claude` — does NOT contain "ESP32" or "ESP8266" substring, so dashboard's OTA Push card auto-detection (`sketchName.includes('esp8266')`) defaults to port 3232. **For an ESP32 board that's actually correct** (port 3232 IS the ESP32 ArduinoOTA port), so this works out for once — no conflict with the user's naming convention.

## Files referenced

| What | Where |
|---|---|
| Old sketch (reference) | `C:\Users\muroc\Arduino_Projects\Motor_01_ver_10\` |
| Encoder calibrator (companion) | `C:\Users\muroc\Arduino_Projects\Motor_Encoder_Calibrator\` |
| Planned new sketch | `C:\Users\muroc\Arduino_Projects\Motor_Door_Claude\` (not yet created) |
| Reference framework | `C:\Users\muroc\Arduino_Projects\Face_Recognition_Claude\` |
| Sibling room agent (panel host) | [`BALCONY/CLAUDE.md`](../BALCONY/CLAUDE.md) |
| This doc | `c:\Users\muroc\project_home\MOTOR_DOOR\CLAUDE.md` |

## Open questions (resolve when user is back home)

1. **Page 6 layout confirmation**: button object IDs on the existing balcony panel — `p6b7` / `p6b8` / `p6b9` / `p6b16` mapping from old sketch. Are those still on Page 6 in the current `BALCONY/pages.jsonl`? Or has the panel been redesigned?
2. **HASP object syntax**: is the current balcony panel still on `p[7].b[8]` notation (older OpenHASP) or migrated to `p7b8` (0.7+)? Check `BALCONY/pages.jsonl`.
3. **Pin verification**: the planned pin map matches `MotorDriver.h` in v1 — confirm no rewiring planned.
4. **Existing devices placement**: is there a `room_device_placements` row for the Motor Door already? If so what room + coordinates? Or to be added when v2 is live?

## Status

🟢 **Sketch written + compiles** (2026-05-21). Verified via arduino-cli (`esp32:esp32:esp32` FQBN): **79% flash, 16% RAM**. All 9 files exist at `C:\Users\muroc\Arduino_Projects\door_motor_claude\`:

| File | Lines | Role |
|---|---|---|
| `door_motor_claude.ino` | ~205 | Main entry — WiFi/MQTT, HTTP /set_ip, OTA serve, panel slider listener |
| `Main.h` | ~165 | Pin map, MQTT config, EspParams + params struct, EEPROM layout, forward decls |
| `Esp_Base.ino` | ~245 | esp_boards framework — schema, topics, OTA, status, /config + /command dispatcher |
| `MotorDriver.ino` | ~110 | LEDC PWM dispatch, soft max-dist limit, post-stop AutoDoor flags |
| `Encoder.ino` | ~125 | Hall ISR + stall (130 ms) + glide (200 ms, tunable threshold) detectors |
| `Calib.ino` | ~115 | Two-phase calibration state machine + EEPROM persistence |
| `AutoDoor.ino` | ~70 | LD2420 presence → auto-open / auto-close with post-stop gate |
| `LD2420.ino` | ~70 | UART2 line parser ("Range NNN" / "Range OFF"), 1.5 s /event publish |
| `Monitor.ino` | ~135 | Real-time tick diagnostic + HASP balcony panel pushes (p7b1..p7b15) |

**Note on folder/sketch name**: user-chosen verbatim `door_motor_claude` (lowercase, snake_case — different from the earlier `Toilet_ToTo_Claude` PascalCase pattern). Device ID is `door_motor_01` to match.

Ready for Phases 2-7 (on-site flashing + calibration + auto-mode verify + panel page 7 binding + project rule-engine integration) when you're back home.

## References

- [BTS7960 motor driver datasheet](https://www.infineon.com/dgdl/Infineon-PB_BTS7960B-DS-v01_00-EN.pdf) — for reference on the enable + PWM pins
- [LD2420 mmWave sensor docs](https://www.seeedstudio.com/blog/2024/01/05/integrating-grove-radar-presence-sensor-into-home-assistant/) — UART protocol used in `Main.h`
- [ArduinoOTA library](https://github.com/JAndrassy/ArduinoOTA) — used by every esp_boards member sketch
- [Face_Recognition_Claude framework](../../../Arduino_Projects/Face_Recognition_Claude/) — primary reference for the esp_boards framework on ESP8266; we adapt it for ESP32 (`#include <WiFi.h>` not `<ESP8266WiFi.h>`, LEDC API for PWM, OTA port 3232 instead of 8266)
- [Toilet_ToTo_Claude framework](../TOTO_TOILET/CLAUDE.md) — most recent example of the same pattern; reuses `Esp_Base.ino` structure with device-specific actions
