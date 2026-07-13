# ZIGBEE_TOOL — ESP32-C6 Zigbee / 802.15.4 bench tool

Exploration + diagnostics tool for the home Zigbee network, built on an
**ESP32-C6** (DFRobot **DFR1117**, a Beetle/FireBeetle-class C6 board). The C6
has an 802.15.4 radio (Zigbee 3.0 + Thread 1.3) plus WiFi/BLE. This folder holds
two standalone Arduino sketches used to **see the home Zigbee network** without
touching the production coordinator. Bench/diagnostic only — not a deployed service.

> The real Zigbee coordinator is **Zigbee2MQTT on LXC 103** (`/opt/zigbee2mqtt`,
> USB dongle). These sketches are a *second, passive* radio for scanning/sniffing;
> they do **not** join or alter the Z2M network.

## Hardware — DFR1117 (ESP32-C6)

- **Native USB** (the C6's built-in USB Serial/JTAG, Espressif **VID `303A:1001`**) — no CH340/CP210x chip. Enumerates as **"USB Serial Device (COMx)"** (was COM6 here).
- **Connecting gotchas** (hit during setup):
  - Needs a **USB data cable** (charge-only powers the LEDs but the PC sees nothing). The board's USB-C ≠ the micro-USB cable used for the WROOM-32/jura boards.
  - If no COM port appears while a sketch is running, the flashed firmware had **USB CDC On Boot: Disabled** — force the ROM bootloader (hold **BOOT**, tap **RESET**, release BOOT) and it enumerates. Flash with **USB CDC On Boot: Enabled** so it stays visible.
- **Board package:** nothing to install — the Espressif **esp32 core 3.3.10** already ships C6 support incl. `DFRobot Beetle ESP32-C6` / `DFRobot FireBeetle 2 ESP32-C6` / generic `ESP32C6 Dev Module`.

## Home Zigbee network facts (verified 2026-07-11)

- Coordinator: **Zigbee2MQTT on LXC 103** (192.168.1.114), USB dongle (EFR32 ember).
- **Channel 11**, **PAN ID `0x1a62`**, ext PAN ID `DD:DD:DD:DD:DD:DD:DD:DD` (all Z2M defaults — `configuration.yaml` only sets `channel: 11`).
- The scan also sees **3 neighbour networks** (`0xd081` CH19, `0x8017` CH15, `0x4010` CH24) — not ours.

## Sketch 1 — `c6_zigbee_scan/` (Zigbee network scanner)

Lists nearby Zigbee **networks** (PANs) via the Arduino `Zigbee` library
(`ZigbeeCore::scanNetworks()`): PAN ID, channel, permit-join, router/ED capacity,
ext PAN ID. Confirms the C6 radio works + finds our network. **Sees networks, not
individual devices** (enumerating devices is the coordinator's job — Z2M has that).

**Tools settings (required):**
| | value |
|---|---|
| Board | DFRobot Beetle ESP32-C6 (or ESP32C6 Dev Module) |
| **Zigbee mode** | **Zigbee ZCZR (coordinator/router)** |
| **Partition Scheme** | **Zigbee ZCZR 4MB with spiffs** |
| USB CDC On Boot | Enabled · Port COM6 |

⚠ **Boot-loop panic on first flash?** Almost always a partition/stale-NVS issue:
set the **matching Zigbee ZCZR partition** and enable **Tools → Erase All Flash
Before Sketch Upload**, then re-flash. (That fixed it here.)

## Sketch 2 — `c6_zigbee_sniffer/` (802.15.4 MAC sniffer)  ← the "see my network" tool

Promiscuous 802.15.4 receiver on the raw `esp_ieee802154` API (no Zigbee stack).
Prints every MAC frame heard on the channel — **type / seq / src → dst (short
addresses) / RSSI / LQI** — and keeps a **live list of device short-addresses**
transmitting on our PAN. Pre-set to **`CHANNEL = 11`, `FILTER_PAN = 0x1a62`**
(set `FILTER_PAN = 0` to watch all networks).

**Tools settings (simpler — uses the raw radio, not the Zigbee stack):**
| | value |
|---|---|
| Board | DFRobot Beetle ESP32-C6 (or ESP32C6 Dev Module) |
| **Zigbee mode** | **Disabled** |
| **Partition Scheme** | **Default** (any non-Zigbee) |
| USB CDC On Boot | Enabled · Port COM6 |

**Scope:** the MAC headers (who talks, to whom, how often, RSSI) are **in the
clear**; Zigbee **payloads are encrypted** with the network key. To decode the
actual values, feed frames to **Wireshark + the network key** (ESP-IDF
`ieee802154_sniffer` extcap — a separate, bigger setup). This sketch is the
"which of my devices are talking, and how strong" view.

**Implementation notes:**
- `esp_ieee802154_receive_done()` is overridden (`extern "C"`) — it runs in driver
  context, so it only **copies** the frame into a ring buffer; parsing + `Serial`
  printing happen in `loop()`.
- Standard 802.15.4 MAC parse (FCF → frame type, PAN-ID compression, dst/src
  addressing modes → short addresses). Broadcast = `0xffff`, coordinator = `0x0000`.
- Compiles with **default** board settings (24% flash) — the `libieee802154.a` links
  without enabling Zigbee mode.

## Sniffed address → device name mapping

The sniffer shows **network short addresses** only. The mapping to friendly names
lives **only** in the coordinator's DB on LXC 103:
`/opt/zigbee2mqtt/data/database.db` (`nwkAddr` → `ieeeAddr`) + `configuration.yaml`
(`ieeeAddr` → `friendly_name`). Read-only lookup verified 2026-07-11:

| short addr | device |
|---|---|
| `0xd925` | DiningRoom Lower (Tuya TS0601) |
| `0xf3dc` | Hallway Switch Zigbee (Tuya TS0601) |
| `0x0000` | Z2M coordinator |

⚠ Short (network) addresses can change on rejoin — always re-check against Z2M's
current `database.db` when mapping. **Only read** the coordinator when asked.

## Possible next steps (not built)

1. **Zigbee router** — flash the C6 as a mains-powered Zigbee **repeater** and pair it
   into Z2M (permit-join) to extend range/coverage.
2. **Wireshark decode** — ESP-IDF `ieee802154_sniffer` (extcap) + the Z2M network key
   → full per-device payload decode.
3. **Thread** — the same radio does Thread 1.3 (Matter-over-Thread) if ever needed.

## Files
- `c6_zigbee_scan/c6_zigbee_scan.ino` — network scanner (Zigbee ZCZR mode).
- `c6_zigbee_sniffer/c6_zigbee_sniffer.ino` — 802.15.4 MAC sniffer (Zigbee mode disabled).

Authoritative Arduino copies live at `C:\Users\muroc\Arduino_Projects\c6_zigbee_scan\`
and `...\c6_zigbee_sniffer\` (flashed by USB). This folder is the version-controlled copy.
