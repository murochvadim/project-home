# Balcony Somfy RTS Blaster — Plan

> **Status:** PLAN ONLY — nothing built yet. Do not implement until explicitly told to.
> Self-contained (does not depend on `IR_RF_SOMFY_TOOL/`).

## Goal
Add a **CC1101 433.42 MHz transmitter** to the existing `balcony_bridge` (BoBo) ESP32, turning it into a permanent **Somfy RTS remote for 4 motors**, controlled from a new **Somfy tab in the Balcony Agent**. Self-contained — does **not** need a capture bench tool (Somfy pairs directly; no code capture).

## Feasibility (verified 2026-07-22)
- CC1101 pins 5/18/23/19/4/15 are **free** — the BoBo sketch uses **zero GPIO** (pure BLE↔MQTT bridge; load cells live on the BoBo board and arrive over BLE).
- Board runs **NimBLE** with ~**108 KB free heap** (v14) → room for the Somfy + CC1101 libs.
- CC1101 is an **external SPI radio** → no coexistence hit with the ESP32 BLE+WiFi; Somfy TX is a brief burst, the ~10 Hz BoBo position stream is unaffected.
- ⚠ Board has been **offline since 07-10** — must be powered on to flash/test.

## Hardware
CC1101 → ESP32-WROOM-32 (on the BoBo bridge):

| CC1101 pin | ESP32 |
|---|---|
| CSN (4) | GPIO 5 |
| SCK (5) | GPIO 18 |
| MOSI (6) | GPIO 23 |
| MISO (7) | GPIO 19 |
| GDO0 (3) | GPIO 4 |
| GDO2 (8) | GPIO 15 |
| VCC (2) | **3V3 only — NEVER 5 V** |
| GND (1) | GND |

- **Antenna:** 17.3 cm quarter-wave wire on the CC1101 ANT pad (or the SMA whip) — required for range.
- Power the BoBo board OFF before wiring.

## Firmware — `C:\Users\muroc\Arduino_Projects\balcony_bridge\balcony_bridge.ino` v14 → **v15**
*(local sketch, NOT in repo — bakes WiFi/MQTT/OTA creds, like all esp_boards firmware)*
1. Add libs `SmartRC-CC1101-Driver-Lib` + `Somfy_Remote_Lib` (Nickduino). CC1101 in **async OOK TX @ 433.42 MHz**; the Somfy frame is bit-banged on GDO0 (exact CC1101 register config validated on-bench during build).
2. **4 virtual remotes** — one unique 24-bit address per motor (e.g. `0x100001..0x100004`).
3. **Rolling counter per motor persisted to NVS (`Preferences`)**, separate namespace from the calibration EEPROM (BoBo cal untouched). **Counter written after EVERY transmit** — the #1 Somfy correctness rule (a lagging counter → motor ignores commands until re-sync/re-pair).
4. New command actions in the existing dispatcher: `somfy_up:<n>`, `somfy_down:<n>`, `somfy_stop:<n>`, `somfy_prog:<n>` (n = 0–3). `esp_boards` schema declares them.
5. Board reports each motor's live counter in `/status` so the dashboard can mirror/verify.
6. Boot banner `Balcony_Bridge v15 (built …)`; BoBo BLE + position stream must keep working (regression-checked).

## Backend (dashboard = UI only — architecture rule)
- **DB table `somfy_motors`** (LXC 102): `id, board_id, motor_index, name, room, remote_address, rolling_counter_mirror, notes, ts`. Retention forever; add to Health DB-Volumes. Migration under `BALCONY/migrations/`.
- **`BOILER/dashboard/routes-somfy.js`** (new module, one `require()` past the architecture-guard hook): `GET/POST /api/somfy/motors` (config CRUD) + a thin `POST /api/somfy/:index/:action` that proxies to the existing `mur/home/esp/balcony_bridge/command` path. No business logic in `server.js`.

## Dashboard — new **Somfy tab** in `BOILER/dashboard/public/balcony.html` + `js/balcony.js`
- One card per motor (×4): name + room + **▲ Up / ■ Stop / ▼ Down** + **Pair (PROG)** + live counter.
- A config row to name motors / assign room / set address (writes `somfy_motors`).
- Pair button shows a confirm dialog with the pairing steps.

## Pairing flow (one-time per motor — user has the original remote)
1. Hold **PROG** on the original Somfy remote until the motor **jogs** (programming mode).
2. Within ~2 s, click **Pair** on that motor's card → board sends its PROG frame → motor **jogs again** → paired.
3. Test ▲/■/▼. Repeat for all 4.

## Rollout / test order
1. Wire CC1101 (power off) → flash v15 via **USB** first → confirm boot banner + CC1101 init + **BoBo still connects** + heap healthy.
2. **Regression:** verify the BoBo balance game / position stream still works.
3. Pair motor 0 → test → then 1, 2, 3.
4. Wire the dashboard tab; verify each button; confirm the counter persists across a board reboot.

## Docs to update (after it works)
`BALCONY/CLAUDE.md` (Somfy tab + board dual-role), root `CLAUDE.md` (esp board gains Somfy actions), memory. If `IR_RF_SOMFY_TOOL/` is removed, note that this board is now the Somfy path.

## Open detail (not a blocker)
What the 4 motors are (awning / left blind / right blind / …) — named in the tab; no design impact.
