# ELECTRA_AIR_CONDITIONS — Agent Index

**Status: PLANNED (scoped 2026-08-14). Not built yet — hardware pending.**

Local control of **two Electra 2.5 HP A/C units** over **Modbus RTU / RS-485**, from our own hardware —
**NOT** Home Assistant, **NOT** the Electra cloud (the official `electrasmart` HA integration is
cloud-only and is rejected). Each unit's main board is an **Electra GEMINI PCB-1P0200 Ver001**, which
exposes a native RS-485 port and a DIP selector for **MODBUS** mode (vs the `RCW` proprietary wall-remote
mode, which uses A/B + CLK + OUT). Both boards share **one RS-485 multi-drop bus** with distinct slave
addresses, driven by a single wired **ESP32 + W5500 + RS-485** bridge in the existing `esp_boards`
framework. Control surfaces on a new **"Air Conditions" tab on Project General**.

## 📐 Wiring diagram
Graphical connection + board-interconnection diagram (2 panels: A/C↔bridge bus, and inside-the-bridge
board wiring): **https://claude.ai/code/artifact/f44dd1dc-29eb-41fe-8d68-99b4ff258f28**
— source committed here as [wiring.html](wiring.html).

## Hardware (decided)
- **ESP32 + W5500 (wired Ethernet)** — the `kazir_15` board pattern; **wired only, no WiFi** (MQTT + OTA +
  control all ride the Ethernet cable — more reliable than WiFi in a utility spot).
- **RS-485 converter** — auto-direction module preferred (removes the DE/RE wire); else MAX3485 + one
  DE/RE GPIO.
- Both GEMINI boards → **one RS-485 bus** (A↔A, B↔B, GND↔GND↔bridge). Each board's **DIP `J2` = ON
  (MODBUS)** (see the DIP table below) + a **unique Modbus address** (unit-1 = addr 1, unit-2 = addr 2).
  **120 Ω** termination at the two physical bus ends.
- ⚠ Do **NOT** wire the board's `CLK`/`OUT` pins (RCW wall-remote mode only). **Shared GND is mandatory.**
- ⚠ Mains: power each unit **off at the breaker** before wiring (the `OUT/CLK/RS485/12V/GND` pins are the
  board's low-voltage optional/smart-home connector).

### DIP switches — CONFIRMED from the official diagram (Cat 444991/04) + real board photos (2026-08-18)
The board's optional connector is silkscreened **`OUT · CLK · RS485(B,A) · 12V · GND`** — exactly as the
schema assumed (the real-board photo matches pin-for-pin). The **`J2` DIP is the make-or-break setting.**
Per the board's own DIP table (EMD+ / JAMAICA / ELD):

| DIP | ON | OFF | Set to |
|---|---|---|---|
| **J1 Test** | Test mode | Normal operation | **OFF** |
| **J2 Modbus/RCW** | **MODBUS** | RCW (wall remote) | **ON** ⭐ |
| J3 CLK | B – presence sensor | A – timer | any (unused in Modbus) |
| J4 | not used | not used | — |
| J5 Heat-compensate | no compensate | compensate | installer choice |

⚠ **With `J2` OFF the RS-485 port runs the RCW protocol, NOT Modbus** — set **J2 ON** on every unit or the
bridge is silent. Modbus mode and the wired wall thermostat are likely **mutually exclusive** (confirm in
Phase 1).

### Powering the bridge — from the board's own 12 V (new, from the diagram)
The `12V/GND` pins in that same connector are the board's **supply rail for the smart-home module**, so
power the ESP32 bridge **from the A/C board's 12 V** via a small **12 V→5 V buck** — GND then doubles as the
RS-485 signal reference. Result: **one 4-wire run per unit (`A/B/12V/GND`), no separate PSU.** ⚠ verify the
12 V rail can source the bridge (~150 mA @12 V for ESP32+W5500); if it sags, use a separate 5 V supply (still
tie GND↔GND for the RS-485 reference). On the shared 2-unit bus, feed the bridge from **one** unit's 12 V
only (don't parallel the two 12 V rails) — but tie **all** GNDs together.

## Pin map (finalized — boot/OTA-safe)
Every GPIO below is boot- & OTA-safe; the SPI half mirrors the proven `kazir_15` board (verified against
`KAZIR_15_NETWORK/CLAUDE.md`). The only deviation from KZ15 is **RST → GPIO13 instead of GPIO2** — GPIO2
is a download-mode strapping pin, so GPIO13 (a plain output) removes any first-USB-flash risk.

**ESP32-WROOM-32 ↔ W5500 (Ethernet, VSPI)**
| W5500 | ESP32 GPIO | Req? | Note |
|---|---|---|---|
| MOSI | **23** | ✅ | VSPI MOSI |
| MISO | **19** | ✅ | VSPI MISO |
| SCLK/SCK | **18** | ✅ | VSPI clock |
| SCS/CS | **5** | ✅ | strap, default-HIGH = safe for CS |
| RST | **13** | ⭐ rec. | 24/7 recovery; **not GPIO2/12** (boot straps) |
| INT | **4** | ⚪ opt. | SPI is polled — can skip |
| VCC | **3.3 V** | ✅ | ⚠ 3.3 V, not 5 V; add 100 nF + 10 µF |
| GND | **GND** | ✅ | common ground |

**ESP32-WROOM-32 ↔ RS-485 transceiver (Modbus, UART2)**
| RS-485 | ESP32 GPIO | Req? | Note |
|---|---|---|---|
| DI | **17** (TX2) | ✅ | UART2 TX |
| RO | **16** (RX2) | ✅ | UART2 RX |
| DE/RE | **25** | ⚪ manual only | **skip for auto-direction module** (preferred) |
| VCC | **3.3 V** | ✅ | ⚠ 3.3 V-logic transceiver (MAX3485/auto-dir); ESP32 is **not** 5 V-tolerant |
| GND | **GND** | ✅ | common ground |

**RS-485 bus ↔ both GEMINI boards (multi-drop):** A↔A↔A, B↔B↔B, GND↔GND↔GND (shared) · DIP=MODBUS ·
addr 1 / addr 2 · **120 Ω** at the two physical ends · **never wire CLK/OUT** (RCW-only).

**Pins to AVOID:** GPIO0/2/12/15 (boot straps — GPIO12 high at boot = won't boot) · GPIO6–11 (internal
flash — bricks) · GPIO34–39 (input-only, can't drive outputs). No pin above lands on any of these.

## The gating unknown — the register map
Electra publishes no Modbus register map and none is public → **Phase 1 discovers it** (read/correlate
holding+input registers, or sniff the wall-controller traffic; approach as in the Actron485 / Midea-XYE
reverse-engineering projects).

## Plan — two phases

### Phase 1 — Prove the connection (ONE unit)
Wire one board's `A/B/GND` to a Modbus master (fastest: a **USB-RS485 dongle** on the laptop with
`modpoll`/`mbpoll`; or the ESP32 in a discovery firmware mode). Bring up the link (try **9600 8N1** first,
then 9600-8E1 / 19200; use the DIP address).
- **Read proof:** identify + read the **room-temperature** register — must track a real thermometer.
- **Map the key registers:** room temp, setpoint, mode, fan, on/off, error — with scale (temp ×1 or ×10)
  and enums (mode cool/heat/fan/dry/auto; fan low/med/high/auto).
- **Write proof:** write one control (power or setpoint) and confirm the **unit physically reacts**.
- Also settle: Modbus params (baud/parity/addr), and **whether MODBUS mode disables the wall
  thermostat** (the DIP looks mutually exclusive).
- **Success = one unit readable AND one command works. Stop + confirm before Phase 2.**

### Phase 2 — Both A/C units (full build)
One ESP32+W5500+RS-485 bridge on the multi-drop bus to both units. New **`electra_ac`** firmware
(esp_boards framework, reusing the `kazir_15` Ethernet+MQTT+OTA base + eModbus/ModbusMaster RTU master):
- Poll both slaves (~3–5 s) → publish `/status` with per-unit rounded fields `u1_power`, `u1_mode`,
  `u1_set_temp`, `u1_fan`, `u1_room_temp`, `u1_error`, and `u2_*`.
- `/command` (plain-string, namespaced + `:value` suffix like `balcony_bridge`): `u1_power_on` /
  `u1_power_off`, `u1_mode:cool`, `u1_fan:high`, `u1_set_temp:24`, and `u2_*` — write then re-read + republish.
- **DB:** one `esp_boards` row + one `devices` row (`protocol='esp'`, `u1_*`/`u2_*` channels like
  `balcony_bridge`); add the new status keys to `_ESP_STATUS_DPS_FIELDS` in `RULES/rule_engine.py` →
  `systemctl restart rule-engine`.
- **Dashboard:** new **Air Conditions** tab on `project-general.html` + `js/aircon.js` (two cards —
  power / mode / target-temp slider / fan / live room-temp), all via the existing
  `/api/esp/boards/:id/{command,parameters}` — **no new server endpoint**.

## Files (when built)
- Firmware: `C:\Users\muroc\Arduino_Projects\electra_ac\{electra_ac.ino,Main.h,Esp_Base.ino}` (not in git — bakes creds).
- Rule engine: `RULES/rule_engine.py` — `_ESP_STATUS_DPS_FIELDS` (+ optional `_ESP_CMD_STATE['electra_ac']`).
- Dashboard: `BOILER/dashboard/public/project-general.html` + `js/aircon.js`.
- DB: `esp_boards` + `devices` rows (LXC 102).

## Reference
- Wiring diagram: [wiring.html](wiring.html) / https://claude.ai/code/artifact/f44dd1dc-29eb-41fe-8d68-99b4ff258f28
- Board pattern reused: `KAZIR_15_NETWORK/CLAUDE.md` (ESP32 + W5500 wired-Ethernet), `esp_boards`
  framework docs `BOILER/dashboard/docs/esp_boards.md`, and `BALCONY/` `balcony_bridge` (multi-channel ESP).
