# Flashing the 15 firmware-locked switches → ESPHome/Tasmota (cloud-free)

**Status: NOT STARTED — reference for a later stage.** These are the 15 multi-gang wall switches that
TUYA_LOCAL Phase 1 could NOT make local (firmware refuses local Tuya: `Err 914/901` with the correct key,
open port 6668, ping OK, no UDP broadcast). Their recipes were removed, so they currently run on the **HA
cloud** path (work as before). The **permanent** fix — true local, no cloud ever — is to re-flash them with
open firmware. This doc records everything we know so the flashing can be done later.

## Chip (CONFIRMED by teardown)
Opened one **2-gang** switch → WiFi module is **`TYWE3S`** = **ESP8266 (ESP8285)**. NOT BK7231, so
**tuya-cloudcutter does NOT apply** — the ESP8266 tools do:
- **ESPHome** (recommended — native MQTT, drops into this project's device-agent/rules) or **Tasmota**.
- Board is a **touch** switch: `KEY2` touch pad(s), `D1–D5` status LEDs, an `XDS T904` touch/driver IC, main
  logic on the TYWE3S. The 3-gang type is very likely also TYWE3S — **confirm by opening one 3-gang** before
  assuming.
- TYWE3S flash pins are **exposed on the module edge**: `VCC · GND · TXD0 · RXD0 · GPIO0 · EN` (+ RST, ADC,
  GPIO2/4/5/8/12–16). Serial flashing is therefore easy (no tiny-pad soldering).

## The 15 devices (2 hardware types only)
**3-gang** — product_id `jzQA5vi0nxwAK1Hd` (9), SN prefix `GZAM24KVH…`:
| Device | DB id |
|---|---|
| Balcony Device Switch | `321046412cf43237c3d9` |
| Balcony Switch | `321046412cf43237bd9d` |
| Bedroom Scenario Switch | `321046412cf43237c37a` |
| Entrance Switch | `321046412cf43237c431` |
| Guy Room Scenario Switch | `321046412cf43237c4d8` |
| Guy Room Switch | `321046412cf43237c434` |
| Kitchen Switch | `32104641ecfabc567240` |
| Maya Bedside Switch | `321046412cf43237c308` |
| Vadim Bedside Light | `106013828caab500b8f5` |

**2-gang** — product_id `igrmQHvAQLDY6uzc` (6), SN prefix `ZXBB20ZJA…`:
| Device | DB id |
|---|---|
| Bathroom Switch | `182020202cf43237c182` |
| Bedroom Balcony Switch | `57317771ecfabcbd3ecb` |
| Bedroom Bookshelf Switch | `57317771ecfabcbd3f85` |
| Bedroom Main Switch | `57317771ecfabcbd3e52` |
| Hallway Switch | `57317771ecfabcbd4161` |
| My Room Switch | `57317771ecfabcbd3e3e` |

All paired **Aug 2020**. Category `kg` (switch). Only **2 boards to solve** — prove one of each, then repeat.

## Method A — tuya-convert (OTA, no wiring) — try first, LOW odds
`tuya-convert` is the ESP8266 OTA exploit. **Tuya patched it in 2019**, so 2020-updated firmware likely
fails — but it's a ~15-min, zero-risk try, and if it lands you avoid opening the other 14.
- **Host needed:** a **Linux machine with an AP-capable WiFi adapter** + **internet via ethernet** (WiFi becomes
  the fake AP). Raspberry Pi w/ WiFi, a Linux laptop, or any PC + USB-WiFi dongle. (Windows laptop can't run it;
  the LXCs have no WiFi.)
- **Steps:**
  ```
  git clone https://github.com/ct-Open-Source/tuya-convert
  cd tuya-convert && ./install_prereq.sh
  ./start_flash.sh            # then put the switch in pairing (fast-blink) mode
  ```
  It backs up the original firmware, then (if the exploit connects) flashes ESPHome/Tasmota OTA.

## Method B — serial / UART (reliable) — the real path if OTA fails
The board's already open on the bench; TYWE3S pins are exposed. Use a **3.3V USB-TTL adapter (NOT 5V)**:
| Adapter | → TYWE3S |
|---|---|
| 3.3V | **VCC** (and **EN**) |
| GND | **GND** |
| RX | **TXD0** |
| TX | **RXD0** |
| GND | **GPIO0** (pull LOW *during power-on* → bootloader) |

Then `esptool.py`: erase + write the firmware. First **read/back up** the stock firmware (`esptool read_flash`)
so a brick is recoverable.
- ⚠ **SAFETY: power the module ONLY from the USB-TTL 3.3V while wired — the mains/board must be fully
  disconnected. Never both at once.**

## Target firmware + config
- **ESPHome** preferred (native MQTT → this project's stack).
- **GPIO template is the real work** — it's a touch switch, so the relay(s), touch button(s), and status LED(s)
  each sit on a GPIO. Derive the mapping from a matching community template (search "TYWE3S touch switch 2/3
  gang ESPHome template") or bench-probe. Ping Claude with the gang count + a photo of the board — the ESPHome
  YAML can be built for you.

## Re-integration into this project (after flashing)
- Flashed switch speaks **MQTT** → re-add it to the local stack so it behaves exactly like before. Options: an
  ESP/MQTT `devices` row + the existing MQTT command path, or via HA. Keep the **same friendly name** so rules
  and the dashboard keep working.
- The DB ids above map each physical switch back to its rules/scenes/placements — reuse them when re-wiring.

## Meanwhile (before flashing) — how the 15 stay controllable
- They run on the **HA Tuya cloud** path (recipes removed). Works as long as the HA Tuya integration (Smart Life
  login) is authed.
- Fallback proven but NOT deployed: the **developer IoT-Core API** (`adapters/tuya_config.py` `tinytuya.Cloud`)
  still **fetches keys AND sends `/commands`** even when the HA OAuth expires and the gateway-poll API says "No
  permissions". So these are **not lost on the Oct-6 trial date** — re-login to Smart Life, or (if ever wanted)
  re-enable the reverted agent developer-cloud fallback. See [[project_tuya_local_phase1]].

## Sources
- tuya-convert (ESP8266 OTA): https://github.com/ct-Open-Source/tuya-convert
- ESPHome: https://esphome.io  ·  Tasmota: https://tasmota.github.io
- TYWE3S = ESP8266 module pinout: widely documented (Tasmota/ESPHome device DBs).
