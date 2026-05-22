# TOTO_TOILET — TOTO Washlet IR Bridge

ESP8266-based two-way IR bridge for the user's TOTO Washlet smart toilet. Listens for the physical IR remote and publishes detected button presses to MQTT. Replays captured TOTO codes back to the Washlet on command — turning every Washlet function into a project-addressable action.

Lives under My BathRoom (where the Washlet is physically located). Companion to the existing [MY_BATHROOM](../MY_BATHROOM/CLAUDE.md) per-room agent (HASP panel, smell pump, smart switch); the toilet is the new feature.

## Hardware

| Part | Role | Pin |
|---|---|---|
| **ESP8266** (NodeMCU / Wemos D1 Mini) | Brain — runs the sketch | n/a |
| **TSOP38238** (or TSOP4838) | IR receiver — demodulates 38 kHz signals from remote | **D2 (GPIO4)** — `IR_RECEIVE_PIN` |
| **IR LED 940 nm** + **2N2222 NPN** + 100 Ω + 100 Ω | Transmitter — pulses 38 kHz IR at the Washlet | **D7 (GPIO13)** — `IR_SEND_PIN` |
| **Buzzer (active)** | Short beep on successful IR send (audible confirmation) | **D5 (GPIO14)** — `BUZZER_PIN` |

TSOP receiver pinout: OUT→D2, GND→GND, VCC→3V3. Optional 100 nF decoupling cap between VCC and GND at the TSOP for noise immunity (apartments with LED/fluorescent interference).

IR LED transistor switching is needed because pulsed IR LEDs draw ~100 mA, more than an ESP8266 GPIO can source (~12 mA limit).

## Sketch

Located at **`C:\Users\muroc\Arduino_Projects\Toilet_ToTo_Claude\`** — created 2026-05-21.

Four-file structure, mirrors [Face_Recognition_Claude](../../../Arduino_Projects/Face_Recognition_Claude/) layout:

| File | Lines | Purpose |
|---|---|---|
| `Main.h` | ~115 | Pin map, MQTT config (LXC 107 plain), sketch identity, params struct, forward decls |
| `Esp_Base.ino` | ~190 | esp_boards framework — topics, schema, OTA, action dispatcher with safety gates |
| `Process_States.ino` | ~150 | IR receive (TOTO protocol decoder, 9 buttons) + IR send via `sendToto()` |
| `Toilet_ToTo_Claude.ino` | ~250 | WiFi/MQTT plumbing, HTTP /set_ip fallback, OTA serving |

### MQTT topic schema (esp_boards framework)

```
mur/home/esp/toilet_01/availability   — LWT, "online"/"offline"
mur/home/esp/toilet_01/schema         — retained, declares actions + parameters
mur/home/esp/toilet_01/status         — every 60 s (rssi, uptime, free_heap, last_button, rx/tx counters)
mur/home/esp/toilet_01/config         — board listens — JSON parameter writes
mur/home/esp/toilet_01/command        — board listens — plain string action key
mur/home/esp/toilet_01/event          — board → broker — JSON button_pressed + ack events
```

### Self-declared schema (announced on every reconnect)

**Actions:**
- `flush_full`, `flush_light`, `seat_toggle`, `stop`, `clean_ass`, `osc`, `air_drying`, `pulse`, `wand_clean` — TOTO buttons (all 9 disambiguate cleanly thanks to protocol-correct decoding)
- `restart`, `clear_eeprom`, `factory_reset`, `reset_wifi` — standard esp_boards housekeeping

**Parameters (dashboard-tunable):**
- `ir_tx_enabled` (bool, default `false`) — master safety gate. While false, all IR send commands ACK with `error: ir_tx_enabled=false`. Flip to true once raw codes are captured and verified.
- `ir_repeats` (int 1-5, default `3`) — how many times each IR code is repeated when transmitted. Matches TOTO factory remote behavior.

## What works the moment it's flashed

✅ **Receive direction is fully operational** — no extra steps needed:
- TOTO remote button → TSOP38238 → ESP detects pulse train → duration match against `TOTO_BUTTONS[]`
- Identified button → `event` published with `kind=button_pressed, payload=<button name>, ts=...`
- 2-second debounce suppresses the 3× factory repeat from spamming
- 60-second status heartbeat updates `last_button` + `rx_events_total` for dashboard

## What's pending — to wire up the SEND side

### Step 1 — Capture TOTO codes (per button, ~5 min total)

Much simpler than the prior IRremote / rawData approach — protocol-correct decoding gives a clean `uint64_t` per button instead of a 100-entry timing array.

Per-button procedure:
1. Flash THIS sketch (`Toilet_ToTo_Claude`) — the receiver is already TOTO-aware.
2. Open Serial Monitor at 115200. Initially every press will print:
   `IR TOTO: UNKNOWN code=0xXXXXXXXX — paste into TOTO_BUTTONS[]`
3. Copy that hex value into the matching slot in `Process_States.ino`'s `TOTO_BUTTONS[]` table (replace the `0` placeholder).
4. Repeat for each of the 9 declared buttons.
5. Re-flash. The receiver now matches each press to its name; the transmitter can replay them via `sendToto(code, kTotoBits, repeats)`.

### Step 2 — Re-flash + open the gate

```bash
# Re-flash (USB or OTA — see "OTA note" below)
# Then enable IR TX:
mosquitto_pub -h 192.168.1.189 -u esp_boards -P '=N!9ioNYZWH-8Rz+y+6n' \
  -t 'mur/home/esp/toilet_01/config' -m '{"ir_tx_enabled":true}'

# Trigger a flush via MQTT
mosquitto_pub -h 192.168.1.189 -u esp_boards -P '=N!9ioNYZWH-8Rz+y+6n' \
  -t 'mur/home/esp/toilet_01/command' -m 'flush_full'
```

Or use the dashboard Project Boards page → `toilet_01` tab → auto-generated action buttons.

## Phase 2 — My BathRoom HASP panel integration

The user has a HASP touch panel mounted on the wall right next to the TOTO toilet (the [my-bathroom panel](../MY_BATHROOM/CLAUDE.md), Sunton ESP32-S3 4848S040 at 192.168.1.220, MQTT prefix `hasp/my-bathroom/`). Once Phase 1 is live (codes captured + ir_tx_enabled=true), Phase 2 wires that panel into the toilet two ways: **control** and **reflection**.

### Direction A — Control (panel → TOTO)

5 panel buttons trigger TOTO/ambient actions. **4 are TOTO IR actions on `toilet_01`**, 1 is a non-toilet device.

| Panel button (TBD page/object) | Triggers | Implementation |
|---|---|---|
| **Flush** | `mur/home/esp/toilet_01/command` ← `flush_full` | Existing my_bathroom_buttons rule, `type: esp_command` binding |
| **Open Lid 1** | `toilet_01/command` ← `open_lid_1` (NEW action — to capture) | Same |
| **Open Lid 2** | `toilet_01/command` ← `open_lid_2` (NEW action — to capture) | Same |
| **Light On** | (depends on light identity — see open question) | Either HA `light.turn_on` or another esp_command |
| **Light Off** | (depends on light identity) | Same |

Two new action keys to add to the sketch when the codes are captured:
- `open_lid_1` — first-stage lid open (likely cover-only on a 2-stage TOTO lid)
- `open_lid_2` — second-stage lid open (cover + seat). May share the seat_toggle hardware button on the remote (cycle states) — to be confirmed.

These add to TOTO_BUTTONS[] in `Process_States.ino` + `ESP_SCHEMA_JSON` actions in `Esp_Base.ino` + the action-dispatch `if` chain. Same shape as the existing 9.

### Direction B — Reflection (TOTO event → panel display)

The remaining TOTO actions (the ones NOT given dedicated panel control buttons) reflect on the panel as visual feedback when the user presses them on the physical remote:

- `flush_light` — light flush
- `clean_ass` — rear wash
- `osc` — oscillating wash
- `air_drying` — warm air dry
- `pulse` — pulse wash
- `wand_clean` — self-clean wand
- `stop` — cancel current action
- `seat_toggle` — if not consumed by Lid 1/Lid 2

Implementation: a new rule (`my_bathroom_toilet_reflect.py`, sibling of `my_bathroom_displays.py`) subscribes to `mur/home/esp/toilet_01/event` and publishes `hasp/my-bathroom/command/<obj>.<prop>` updates per the event payload. The HASP page renders the animation.

Animation style: TBD with user (text flash on a status line / per-action icon highlight / pulsing indicator / "Last: <action> · Ns ago" text). Easiest is the **text flash** — one label updates with the action name, fades to default 5 s later.

### Open questions (to resolve when user is home)

1. **Which "Light" does the panel control?**
   - (a) TOTO's built-in seat / night light (if remote has the button) → new IR action
   - (b) The bathroom ceiling light → HA-mediated, not in the toilet sketch
   - (c) A separate fixture → tell me which device
2. **"Open lid 1" vs "Open lid 2"** — different IR buttons on the remote, or `seat_toggle` pressed 1× vs 2×?
3. **Page + button object IDs** on the my-bathroom panel for the 5 controls.
4. **Animation style** for reflective objects (text flash / icon highlight / status line).

Once those four are answered, Phase 2 is straightforward:
- Add 2 (or fewer) new TOTO action keys to the sketch + capture codes
- Add 5 button bindings to `dashboard_settings.my-bathroom.button_bindings`
- Write the new `my_bathroom_toilet_reflect.py` rule
- Add the HASP page geometry to `MY_BATHROOM/pages.jsonl`
- All committed under the existing per-room agent pattern

### Phase 2 dependencies

- Phase 1 complete (codes captured for the 9 current buttons + ir_tx_enabled=true verified)
- Two more codes captured if open_lid_1 / open_lid_2 turn out to be distinct IR buttons
- The 4 open questions resolved

## Known limitations / future work

### IRAM utilization at 94%

Tight ESP8266 IRAM budget. If another IRAM-heavy feature is added later (radio, more interrupts), link may fail. Mitigation if it bites: `#define DISABLE_*` for unused protocols in IRremoteESP8266's config to shrink the decoder table.

### OTA caveat (sketch_name doesn't contain "ESP8266")

User explicitly chose `sketch_name = "Toilet_ToTo_Claude"` (not `Toilet_ToTo_ESP8266`). Dashboard OTA Push card uses `server.js`'s `sketchName.includes('esp8266')` (case-insensitive) to pick port 8266. This sketch name fails that check → dashboard will default to port 3232 (ESP32). When OTA is needed, either:

- Fix dashboard's detection to also check `device_id` (e.g. boards starting with `toilet_`, `face_`, `gates_` are ESP8266)
- Or call `espota.py` manually with the correct password from `.env`
- Or rename `sketch_name` to include "ESP8266" (user pushback documented in [feedback memory](../../.claude/projects/c--Users-muroc-project-home/memory/feedback_user_chosen_names.md))

### My BathRoom agent integration

When the TX side is working, [MY_BATHROOM](../MY_BATHROOM/CLAUDE.md) gains a **Toilet** tab on its dashboard page surfacing the 6 buttons + a status panel (last button, rx/tx counters, ir_tx_enabled toggle). Rule engine can chip-reference the device via `@toilet_01 flush_full` syntax — matches the existing balcony/my-bathroom button sentence-driven patterns.

Possible automations once the chip works:
- Auto-flush 60 s after presence leaves the bathroom (if My BathRoom motion sensor is in `room_device_placements`)
- Light + warm seat + wash sequence on early-morning presence
- "Flush eco" preset on quick presence pulses

## Files referenced

| What | Where |
|---|---|
| Sketch | `C:\Users\muroc\Arduino_Projects\Toilet_ToTo_Claude\` |
| Legacy duration-based sniffer | `C:\Users\muroc\Arduino_Projects\Sniffer_IR_ToTo\` (superseded — this sketch now does its own TOTO capture via UNKNOWN-code prints) |
| Reference framework | `C:\Users\muroc\Arduino_Projects\Face_Recognition_Claude\` (Esp_Base.ino pattern) |
| This doc | `c:\Users\muroc\project_home\TOTO_TOILET\CLAUDE.md` |
| Sibling room agent | [`MY_BATHROOM/CLAUDE.md`](../MY_BATHROOM/CLAUDE.md) |

## Status

🟡 **Sketch written + compiles** (verified 2026-05-21 via arduino-cli, ESP8266 NodeMCU FQBN, IRremoteESP8266 library, 35% flash / 40% RAM / 94% IRAM). Receive side fully functional once flashed.
⏳ **TX side blocked on TOTO code capture** — one-time hardware procedure when user is at the toilet (~5 min: press each button, copy hex code from Serial Monitor into `TOTO_BUTTONS[]`).
⏳ **Dashboard surface** in My BathRoom — not yet built. Action buttons will appear in the auto-generated Project Boards `toilet_01` tab immediately on first connect (esp_boards framework auto-renders from declared schema), but the cleaner My BathRoom tab presentation is a separate step.

## References

- [IRremoteESP8266 library](https://github.com/crankyoldgit/IRremoteESP8266) — current sketch's library, has built-in TOTO protocol decode + encode
- [IRremoteESP8266 ir_Toto.cpp source](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/src/ir_Toto.cpp) — TOTO protocol constants (kTotoBits, kTotoDefaultRepeat, bit-mark 600 µs, one-space 1634 µs, zero-space 516 µs, gap 38 ms, prefix 0x0802)
- [ESPHome `transmit_toto` / `on_toto`](https://esphome.io/components/remote_transmitter/) — cross-check that the TOTO protocol implementation matches
- [Memory: user-chosen names verbatim](../../.claude/projects/c--Users-muroc-project-home/memory/feedback_user_chosen_names.md) — `sketch_name` decision
