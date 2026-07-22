# Balcony Somfy RTS Blaster — Plan

> **Status:** PLAN ONLY — nothing built yet. Do not implement until explicitly told to.
> Self-contained. Absorbs the Somfy-relevant design from the (now-removed) `IR_RF_SOMFY_TOOL/` module — the IR / fixed-code-433-RF / spectrum-analyzer scope of that tool was dropped; only the **Somfy RTS blaster** survives, permanently, on the balcony BoBo board.

## Goal
Add a **CC1101 433.42 MHz transmitter** to the existing `balcony_bridge` (BoBo) ESP32, turning it into a permanent **Somfy RTS remote for 4 motors**, controlled from a new **Somfy tab in the Balcony Agent**. Self-contained — no capture bench tool needed (Somfy pairs directly; no code capture).

## Feasibility (verified 2026-07-22)
- CC1101 pins 5/18/23/19/4/15 are **free** — the BoBo sketch uses **zero GPIO** (pure BLE↔MQTT bridge; load cells live on the BoBo board and arrive over BLE).
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
| GDO0 (3) | GPIO 4 | async OOK TX data pin (Somfy frame bit-banged here) |
| GDO2 (8) | GPIO 15 | second GDO (optional) |
| VCC (2) | **3V3 only — NEVER 5 V** | CC1101 is 3.3 V only |
| GND (1) | GND | common ground critical |

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

## Backend (dashboard = UI only — architecture rule)
- **DB table `somfy_motors`** (LXC 102), retention **forever** (~4 rows), add to Health DB-Volumes:
  ```sql
  CREATE TABLE somfy_motors (
    id                      SERIAL PRIMARY KEY,
    board_id                TEXT NOT NULL DEFAULT 'balcony_bridge',
    motor_index             INT  NOT NULL,           -- 0..3, the <n> in somfy_up:<n>
    name                    TEXT NOT NULL UNIQUE,    -- "Balcony Awning", "Left Blind", ...
    virtual_remote_address  INT  NOT NULL UNIQUE,    -- 24-bit (1..0xFFFFFF)
    rolling_counter         INT  NOT NULL DEFAULT 0, -- 16-bit mirror of the board's NVS counter
    paired                  BOOLEAN DEFAULT FALSE,   -- TRUE only after a confirmed pairing dance
    paired_at               TIMESTAMPTZ,
    category                TEXT,                     -- 'awning'|'blind'|'shade'|'curtain'|'shutter'|'other'
    room                    TEXT,
    notes                   TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
  );
  ```
  Migration under `BALCONY/migrations/`.
- **`BOILER/dashboard/routes-somfy.js`** (new module, one `require()` past the architecture-guard hook): **only** `GET/POST /api/somfy/motors` (the `somfy_motors` CRUD). **The Up/Down/My/Pair buttons reuse the EXISTING `POST /api/esp/boards/balcony_bridge/command` endpoint** (already schema-validates + publishes `somfy_up:0` etc.) — no action-proxy needed. No business logic in `server.js`.
- **Rolling-counter DB mirror is display-only:** the ESP can't write Postgres — the board is authoritative via NVS and reports the counter in `/status`. The dashboard reads it from `esp_boards.last_status` for display; the motor never depends on the DB value.

## Dashboard — new **Somfy tab** in `BOILER/dashboard/public/balcony.html` + `js/balcony.js`
- One card per motor (×4): name + room + **▲ Up / ■ Stop(My) / ▼ Down** + **Pair (PROG)** + paired ✓/✗ + live counter + address (read-only).
- A config row to name motors / assign room+category / set address (writes `somfy_motors`; auto-assigns the next free 24-bit address on add).
- Pair button shows a confirm dialog with the pairing steps.

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
