# Balcony Somfy RTS Blaster — Plan

> **Status:** PLAN ONLY — nothing built yet. Do not implement until explicitly told to.
> Self-contained. Absorbs the Somfy-relevant design from the (now-removed) `IR_RF_SOMFY_TOOL/` module — the IR / fixed-code-433-RF / spectrum-analyzer scope of that tool was dropped; only the **Somfy RTS blaster** survives, permanently, on the balcony BoBo board.

## Goal
Add a **CC1101 433.42 MHz transmitter** to the existing `balcony_bridge` (BoBo) ESP32, turning it into a permanent **Somfy RTS remote for 4 motors**, controlled from a new **Somfy tab in the Balcony Agent**. Self-contained — no capture bench tool needed (Somfy pairs directly; no code capture).

## Feasibility (verified 2026-07-22)
- CC1101 pins used — 5/18/23/19/4 — are **free** (BoBo sketch uses **zero GPIO**; load cells arrive over BLE). GDO2 is left unconnected (GPIO 15 is a strapping pin — see wiring note).
- Board runs **NimBLE** with ~**108 KB free heap** (v14) → room for the Somfy + CC1101 libs.
- CC1101 is an **external SPI radio** → no coexistence hit with the ESP32 BLE+WiFi; Somfy TX is a brief burst, the ~10 Hz BoBo position stream is unaffected.
- 🔴 **Board must be ALWAYS POWERED.** It's been **offline since 07-10** — if it's only powered while you play the BoBo balance game, the blinds are **uncontrollable whenever the game is off**. A permanent Somfy blaster requires the BoBo board on permanent power. **Confirm the power arrangement before building — this is the top open question.**

## Hardware
CC1101 → ESP32-WROOM-32 (on the BoBo bridge):

| CC1101 pin | ESP32 | Why |
|---|---|---|
| CSN (4) | GPIO 5 | VSPI CS |
| SCK (5) | GPIO 18 | VSPI SCK |
| MOSI (6) | GPIO 23 | VSPI MOSI |
| MISO (7) | GPIO 19 | VSPI MISO |
| GDO0 (3) | GPIO 4 | async OOK TX data pin (not a strapping pin — safe) |
| GDO2 (8) | **— LEAVE UNCONNECTED —** | ⚠ GPIO 15 is a **strapping pin** and GDO2 is a CC1101 *output* → it can pull GPIO 15 LOW at reset and disrupt boot. GDO2 is unused for Somfy TX, so skip it. (For future RX, use a non-strapping pin: GPIO 22/32/33.) |
| VCC (2) | **3V3 only — NEVER 5 V** | CC1101 is 3.3 V only |
| GND (1) | GND | common ground critical |

**⚠ ESP32 strapping-pin check (verified):** the WROOM-32's 5 strapping pins are GPIO 0/2/5/12/15. In this wiring only **GPIO 5 (CSN)** and **GPIO 15 (GDO2)** are strapping. CSN is ESP32-driven with an internal pull-up (HIGH at reset = correct) → **safe**. GDO2/GPIO 15 is a CC1101 output → **left unconnected** to avoid a boot disruption. GPIO 12 (the flash-voltage strap that bricks boot) is deliberately not used. **Firmware:** set CC1101 IOCFG0 (GDO0 → async data-in) over SPI *before* the ESP32 drives GPIO 4, to avoid brief startup pin contention.

- **Antenna:** 17.3 cm quarter-wave wire on the CC1101 ANT pad (or the SMA whip) — required for range.
- Power the BoBo board OFF before wiring.

## Firmware — `C:\Users\muroc\Arduino_Projects\balcony_bridge\balcony_bridge.ino` v14 → **v15**
*(local sketch, NOT in repo — bakes WiFi/MQTT/OTA creds, like all esp_boards firmware)*
1. Add libs `SmartRC-CC1101-Driver-Lib` (LSatan) + `Somfy_Remote_Lib` (Nickduino). CC1101 put in **async OOK TX @ 433.42 MHz**, then the Somfy frame is driven on GDO0. **⚠ SmartRC is FIFO/packet-oriented and the Somfy lib expects to toggle a data pin — this bridge is not drop-in; validate the async-TX register setup on bench early.**
2. **⚠ Timing (the #1 correctness risk):** Somfy frames are µs-precise Manchester bursts repeated over ~150 ms. Nickduino's `delayMicroseconds` bit-bang can be **corrupted by NimBLE/WiFi interrupts mid-frame** → the motor intermittently ignores commands. **Drive the OOK waveform with the ESP32 RMT peripheral (hardware-timed, jitter-immune)** or brief per-symbol critical sections — do **NOT** block all interrupts for the whole burst (WDT / WiFi drop). RMT also means the ~10 Hz BoBo stream doesn't stall during a send.
3. **First-boot CC1101 sanity check:** `PARTNUM (0x00)` == `0x00`, `VERSION (0x14)` == `0x14` over SPI — log it so a mis-wired module is obvious.
4. **4 virtual remotes** — one unique 24-bit address per motor (e.g. `0x100001..0x100004`).
5. Command actions handled in the existing `mqttCallback` chain (currently only `rescan`/`restart`): **`somfy_up:<n>` / `somfy_down:<n>` / `somfy_my:<n>` / `somfy_prog:<n>`** (n = 0–3). **Only these four** — Somfy **Stop and My are the SAME button/code**, so the ■ Stop button sends `somfy_my` (there is no separate `somfy_stop`).
6. **⚠ Schema declaration is REQUIRED (not optional).** The dashboard command endpoint (`server.js:5686`) rejects any base action **not** listed in `esp_boards.board_schema.actions` (400). So the four `somfy_*` actions **must** be added to the BoBo `SCHEMA_JSON`, and **v15 must be flashed (republishing the schema) BEFORE any dashboard button will work** — order matters.
7. Board reports each motor's live rolling counter in `/status` (display/backup only — see below).
8. Boot banner `Balcony_Bridge v15 (built …)`; BoBo BLE + position stream must keep working (regression-checked).

## ⚠ Rolling counter — the #1 correctness rule
A Somfy motor tracks the rolling code; if the board's counter is ever **lower** than the motor's last-seen value, the motor **rejects commands until re-paired**. Requirements:
1. Store the counter **per motor** in **NVS (`Preferences`)** — separate namespace from the BoBo calibration EEPROM (cal untouched).
2. **Increment + persist to NVS BEFORE transmitting** the frame.
3. Mirror the counter to the DB row after every successful transmit (for dashboard display / backup).
4. On boot, read the counter from **NVS as the authoritative source** (in case the DB drifted).
5. **`Preferences` must survive OTA** — it does by default with ArduinoOTA, but **verify** after the first OTA (don't wipe NVS on flash).
- **Single-owner pattern:** this board is the ONLY sender for these 4 motors, so NVS is authoritative and there are no cross-board races.

## Somfy protocol detail (from Nickduino lib)
- **Frame** = virtual address (24-bit) + rolling counter + rolling key + button (Up/Down/Stop-My/Prog), Manchester-coded, sent 433.42 MHz OOK, repeated a few times per press.
- **Pairing (PROG) frame** = same address + counter + key + button=`PROG`.
- **Send** = same address, next incremented counter, button = chosen action.
- Buttons exposed: **Up / Down / My (stop/preset) / Prog**. (Somfy "Stop" and "My" are the same physical button; the lib sends the MY/STOP code.)

## Backend — NONE NEW (frontend-only) ✅ confirmed 2026-07-22
The motors are fixed (4, firmware-hardcoded indexes + addresses), so **no `somfy_motors` table and no `routes-somfy.js`** — that was over-built. Everything reuses EXISTING endpoints:
- **Commands** → `POST /api/esp/boards/balcony_bridge/command { action:"somfy_up:0" }` (schema already declares the 4 actions, so it validates + publishes).
- **Names config** → generic `dashboard_settings` key **`balcony.somfy_motors`** (read/written via the existing `/api/dashboard-settings/:key`). Seed with the 4 names below.
- **Live state** (CC1101 ok + rolling counters) → `GET /api/esp/boards` → **response is `{boards:[…]}`** (verified 2026-07-22 — read `data.boards[i]`, NOT the response directly) → `boards[i].last_status.cc1101_ok` + `boards[i].last_status.somfy_counters[idx]`.
- **Command path proven live (2026-07-22):** `POST …/command {action:"somfy_my:0"}` → board parsed + ran `somfyTx` → counter[0] `0→2` in `/status`. The `counter: N` display = the **next rolling code** (increments per press; first press jumps 0→2 due to the uninitialized-flash guard, then +1 each). It's a heartbeat, not a press-count — label it plainly.
- No `server.js` changes, no DB migration, no new route module. Fits "dashboard = UI only" cleanly.

## Dashboard — new **Somfy tab** in `BOILER/dashboard/public/balcony.html` + `js/balcony.js`  ✅ confirmed scope
New **Somfy** tab (same tab pattern as Panel / Star Projector). Header strip: **CC1101 ✓ detected · board online** (greys out + disables buttons when offline). **4 motor cards** (no All-shortcuts):

| Card | idx | name key |
|---|---|---|
| **Left Roof** | 0 | `balcony.somfy_motors[0].name` |
| **Right Roof** | 1 | `[1]` |
| **Left Curtain** | 2 | `[2]` |
| **Right Curtain** | 3 | `[3]` |

Each card:
- Motor name.
- **▲ Open** (`somfy_up:idx`) · **■ Stop** (`somfy_my:idx`) · **▼ Close** (`somfy_down:idx`) buttons.
- **🔗 Pair** button → small modal with the pairing steps + a **Send PROG** action (`somfy_prog:idx`).
- **counter: N** — live rolling code from `last_status.somfy_counters[idx]`, polled from `/api/esp/boards` (a heartbeat that the motor's actually being driven).
- **invert** toggle (open↔close swap, stored in `balcony.somfy_motors[idx].invert`) — set during testing if a motor's Open/Close is physically reversed.

Seed `dashboard_settings.balcony.somfy_motors` once = `[{idx:0,name:"Left Roof",invert:false},{idx:1,name:"Right Roof",…},{idx:2,name:"Left Curtain",…},{idx:3,name:"Right Curtain",…}]`.
Cache-bust `js/balcony.js?v=` bumped.

## Pairing flow (one-time per motor — user has the original remote)
1. Hold **PROG** on the original Somfy remote until the motor **jogs** (programming mode).
2. Within ~2 s, click **Pair** on that motor's card → board sends its PROG frame → motor **jogs again** → paired → set `paired=true`, `paired_at=now()`.
3. Test ▲/■/▼. Repeat for all 4.
- **Pairing is additive** — Somfy motors hold many remotes, so your **original handheld remote keeps working** after we add the virtual one. Pick virtual addresses (`0x10000X`) that don't collide with an existing remote (extremely unlikely).
- **Range:** all 4 motors must be within CC1101 range of the balcony board — confirm they're all balcony-area (awning/blinds right there), not a distant motor.

## Rollout / test order
1. Wire CC1101 (power off) → flash v15 via **USB** first → confirm boot banner + CC1101 PARTNUM/VERSION OK + **BoBo still connects** + heap healthy.
2. **Regression:** verify the BoBo balance game / position stream still works.
3. Pair motor 0 → test → then 1, 2, 3. Confirm the counter **persists across a board reboot** (power-cycle, re-send — motor must still respond).
4. Wire the dashboard tab; verify each button.

## Docs to update (after it works)
`BALCONY/CLAUDE.md` (Somfy tab + board dual-role), root `CLAUDE.md` (esp board gains Somfy actions + rule group note), memory. This board is now the project's Somfy path (the IR_RF_SOMFY_TOOL bench tool was removed 2026-07-22).

## Reference
- Somfy_Remote_Lib (Nickduino): https://github.com/Nickduino/Somfy_Remote_Lib — README has the frame structure + pairing flow.
- SmartRC-CC1101-Driver-Lib (LSatan): https://github.com/LSatan/SmartRC-CC1101-Driver-Lib

## Open detail (not a blocker)
What the 4 motors are (awning / left blind / right blind / …) — named in the tab; no design impact.
