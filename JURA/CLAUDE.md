# Jura Coffee Machine

Planning + protocol notes. Integration STARTED 2026-05-04 — chosen
implementation route is **Path C** (custom Arduino sketch on a spare
ESP32-C3, fits our `esp_boards` subsystem). Paths A and B are kept
below for context but are not the active route.

## Hardware

| Item | Value |
|---|---|
| Machine model | Jura Impressa J6 |
| Wireless adapter | **BlueFrog** (third-party Smart Connect alternative; TT214H Telink BLE SoC) |
| Adapter physical link | Plugged into the J6 service port (already done by user) |
| BLE address | `D5:B2:75:CC:85:CB` |
| BLE GAP name | `TT214H BlueFrog` |
| Smart Connect service UUID | `5a401523-ab2e-2548-c435-08c300000710` (matches [Jutta-Proto](https://github.com/Jutta-Proto/protocol-bt-cpp) spec) |

The BlueFrog is functionally interchangeable with Jura's own Smart Connect
dongle for protocol purposes — same service UUIDs, same
encrypted/handshake flow. Phone-side **J.O.E. app** confirmed compatible.

## Verified 2026-05-02

End-to-end BLE communication tested from the Windows dashboard host
(within ~5 m of the machine) using `bleak`:

- Discovery + GATT enumeration: ✓
- Connect + service tree:
  - `00001800` Generic Access (Device Name = `TT214H BlueFrog`)
  - `5a401523` Smart Connect — 14 characteristics (read + write + notify mix)
  - `5a401623` secondary service (about / aux)
  - `00001530` Nordic DFU (firmware update)
- **Statistics characteristic** `5a401531` (read, 56 bytes) — returns
  varying bytes per read (real counter data, not all-zero placeholders).
- **About / product / name reads** (`5a401524` / `5a401534` / `5a401537`) —
  return data with the same 20-byte encrypted prefix (`77e1 3dd6 8881 d3de
  a323 fa98 a4a3 faab 4756 a626…`) until the auth handshake is performed.

Conclusion: **the protocol family is the supported Jutta-Proto Smart
Connect**. Decoded data requires the auth handshake (next step).

## Available data surface (from Jutta-Proto spec)

When the auth handshake is implemented, expect to read:

### Live state
- Power state (on / standby / brewing / heating)
- Currently dispensing (drink id if active)
- Service alerts: water tank empty · beans empty · grounds full · drip tray full · door open
- Maintenance flags: cleaning required · descale required · filter exhausted
- Temperature ready / warming up

### Lifetime counters
- Total products dispensed (single counter)
- Per-product counters (one each): ristretto, espresso, coffee, 2× espresso, 2× coffee, hot water, plus milk-frothed drinks if the J6 has the milk system attachment
- Cleaning cycles · descaling cycles · filter replacements · hot-water cycles

### Maintenance
- Cycles since last cleaning
- Cycles since last descale
- Brew unit cycles

### Static info
- Machine model code (e.g. `EF553` → maps to a model name)
- EEPROM version
- Dongle firmware version

### Commands
- Start drink N (write to FA command channel)
- Cancel current operation
- Standby / wake
- Trigger cleaning / rinse cycle

## Integration paths

### ⭐ Path C — custom Arduino sketch on regular ESP32 (CHOSEN; Phase 1 done 2026-05-04)

```
J6 service port → BlueFrog dongle → BLE (5 m line-of-sight)
                                      → ESP32 (regular WROOM-32, NOT C3)
                                      → Wi-Fi → Mosquitto (LXC 107)
                                      → mur/home/esp/jura_bridge_01/{status,event,command}
                                      → rule engine (LXC 105) → devices.last_state
                                      → dashboard (Project Boards tab + rule sentence chips)
```

The sketch:
- Runs the Jutta-Proto auth handshake natively in C++ (~150 lines
  ported from `pyjura` / `protocol-bt-cpp`) — **Phase 2 (still TODO)**
- Polls the BlueFrog every N seconds (Settings-tunable) for stats +
  service flags
- Publishes decoded state to MQTT in the same shape as every other
  ESP board in the project (so it appears as a Project Board tab,
  gets OTA, is rule-targetable via `dps_config.action_on/action_off`)
- Subscribes to `mur/home/esp/jura_bridge_01/command` for brew /
  cancel / standby actions

Hardware: regular ESP32 Dev Module (WROOM-32, dual-core), MAC
`80:F3:DA:5E:B3:AC`, IP 192.168.1.118, USB-powered, placed within
~5 m of the J6.

### Migration story: ESP32-C3 → regular ESP32 (2026-05-04)

Path C originally targeted the ESP32-C3. The C3 turned out to have a
deterministic BLE controller bug (panic at `Saved PC: 0x4038ab62` with
NimBLE / `0x4038ac4a` with Bluedroid) — both host stacks share the
same controller firmware in arduino-esp32 3.3.8 for the C3 and both
crash under any concurrent BLE+WiFi load. The bug is in pre-compiled
controller IRAM; not fixable from sketch level.

We migrated to a regular ESP32 (WROOM-32, dual-core) which has separate
silicon for the BLE controller and is well-tested for this exact use
case. The C3 panic stopped immediately on the new board.

**Lessons that live in the final sketch as architectural decisions:**

- **Library**: Bluedroid via `<BLEDevice.h>` (NOT NimBLE-Arduino). NimBLE
  is more memory-efficient but the regular ESP32 has plenty of RAM, and
  we hit fewer NimBLE-Arduino library bugs. Requires the
  **Minimal SPIFFS (1.9 MB APP/190 KB SPIFFS)** partition scheme since
  Bluedroid + our app is ~1.7 MB.
- **Pattern**: poll-and-disconnect, NOT persistent connection. Every
  `poll_interval_sec` (30 s default) the sketch opens a session — scan
  → connect → auth → read stats → (queued cmd) → disconnect — and stays
  idle in between. Long-lived BLE connections + remote-initiated
  disconnects raced badly on the C3 even on the regular ESP32 the
  pattern is more stable and gives WiFi clean radio time between polls.
- **Connect**: scan-first-then-connect (canonical Bluedroid pattern).
  Direct `_client->connect(BLEAddress, BLE_ADDR_TYPE_RANDOM)` blocks for
  30 s before failing on regular ESP32 because the controller needs the
  address-resolution table populated by a scan. Scan finds the peer,
  produces a `BLEAdvertisedDevice`, then `_client->connect(found)` is
  fast and reliable.
- **OTA prep**: must `BLEDevice::deinit(true)` from `ArduinoOTA.onStart`.
  Bluedroid uses ~30 KB of heap; without freeing it, OTA upload buffers
  run out at ~25 KB free heap and the upload fails with
  `OTA error 3 (RECEIVE_ERROR)` immediately at 0%. After deinit the
  free heap goes from ~30 KB → ~160 KB and OTA flies through.
- **Dual-core race**: BLE callbacks (`onConnect` / `onDisconnect`) fire
  on Core 0 (BLE host task) but the app's MQTT client runs on Core 1.
  PubSubClient is NOT thread-safe — calling `publishEspEvent()` from
  callbacks corrupts internal state and panics. Callbacks now JUST set
  `volatile bool` flags; `juraBleLoop()` drains them on Core 1.
- **Watchdog**: BLE connect can legitimately block several seconds while
  the controller does a connection setup. The default 5 s loop task
  watchdog tripped during normal operation. We `esp_task_wdt_delete(NULL)`
  early in setup() to remove the loop task from TWDT — interrupt and
  RTC watchdogs still run for genuine hangs.
- **Address type**: BlueFrog's MAC `D5:B2:75:CC:85:CB` has top-2 bits
  set → static random address. Pass `BLE_ADDR_TYPE_RANDOM` explicitly
  on the BLEAddress constructor; without it the connect call defaults
  to public-address resolution which fails slowly.
- **WiFi setup**: keep the scan + lock-to-strongest-BSSID pattern from
  the smell board sketch (gives reliable WiFi acquisition in crowded
  apartment AP environments). Disable PMF, force WPA2-only.

**Effort actual**: 1 day for Phase 1 (scaffolding + migration + every
gotcha above). Phase 2 (auth handshake + opcodes) still TODO.

**BlueFrog reachability verified 2026-05-04** — bleak scan from the
Windows host found `D5:B2:75:CC:85:CB "TT214H BlueFrog"` advertising;
sketch successfully scans, finds, connects, runs (stub) auth, reads
stats characteristic returning a 56-byte payload (encrypted prefix
until real auth lands).

### Path A — ESPHome BLE proxy + HA integration (NOT CHOSEN, kept for context)

```
J6 service port → BlueFrog dongle → BLE
                                      → ESP32 (flashed with ESPHome bluetooth_proxy:)
                                      → Wi-Fi
                                      → HA (LXC 101) + HACS Jura integration
                                      → HA WebSocket
                                      → device_agent (LXC 103) → devices table
                                      → rule engine + dashboard
```

Hardware: any spare ESP32 (~$5-10) within ~5 m of the machine, USB-powered.
Effort: ~30-45 min one-time. Result: persistent integration; brew counters,
service alerts, brew commands all available as `devices` rows + rule
chips + display-template sources.

**Why not chosen (2026-05-04 decision):** Adds HA + HACS dependency for
one device, extra hop in the data path, and doesn't slot into our
`esp_boards` subsystem (no Project Boards tab, no MQTT-direct OTA).

### Path B — Python prototype on laptop (verification only)

Implement the Jutta-Proto auth handshake (~150 lines) in a throwaway
script on the dashboard host, read decoded values once, prove the
protocol works. **No persistence, no rules, no dashboard.** Skipped
2026-05-04 — Path C will port the handshake straight to Arduino, so a
laptop dry-run isn't a prerequisite.

Handshake outline (still applies — same code lands in the sketch):
1. Read 1-byte connection key from `5a401524`
2. Derive response via Jutta-Proto bit-permutation + XOR mask
3. Write derived response to `5a401525`
4. Now reads `5a401534` (product info), `5a401537` (machine name),
   `5a401531` (statistics) return decoded bytes
5. Statistics layout: 4-byte counters back-to-back; first = total, then
   per-product

## BLE radio constraints

- Range: ~5 m clear line-of-sight; ~3 m through one wall
- One client at a time — while ESP32 (Path A) is connected, the J.O.E.
  app on a phone won't connect, and vice versa
- BlueFrog accepts connections without bonding/pairing prompts (J.O.E.
  app pattern)

## Path C work checklist

**Phase 1 — DONE (2026-05-04)**:
- [x] Re-verify BlueFrog reachable via BLE scan
- [x] DPS shape designed (`power_state` / `current_drink` / `water_low` /
      `beans_low` / `grounds_full` / `cleaning_required` /
      `descale_required` / `total_dispensed` / `espressos_today`)
- [x] Action vocabulary designed (`brew_espresso` / `brew_coffee` /
      `brew_2x_espresso` / `brew_2x_coffee` / `hot_water` / `cancel` /
      `standby`, plus `on`/`off` aliases). `power_state` channel maps
      `action_on` → `brew_espresso`, `action_off` → `standby`.
- [x] DB rows inserted (`esp_boards.jura_bridge_01`,
      `devices.jura_bridge_01`, MAC = `80:F3:DA:5E:B3:AC`).
- [x] Sketch scaffolded (`Main.h`, `Esp_Base.ino`, `jura_bridge_01.ino`,
      `Jura_BLE.ino`) at `C:\Users\muroc\Arduino_Projects\jura_bridge_01\`.
- [x] Migrated from C3 → regular ESP32 (controller bug workaround).
- [x] BLE library: Bluedroid via `<BLEDevice.h>` (NOT NimBLE).
- [x] Pattern: poll-and-disconnect with scan-first-then-connect.
- [x] OTA verified end-to-end (deinit Bluedroid in `onStart` to free heap).
- [x] Cross-core race fixed (BLE callbacks → flag → main loop publishes MQTT).
- [x] Loop task WDT disabled (BLE connect legitimately blocks several seconds).

**Phase 2 — TODO (next session)**:
- [ ] Port Jutta-Proto auth handshake from `pyjura` (`auth.py`) to
      Arduino C++: read connection key from `5a401524`, apply
      bit-permutation + XOR, write derived byte to `5a401525`
- [ ] Set `jura_state.auth_ok = true` in `runAuthHandshake()` after
      real handshake succeeds — unlocks `juraSendCommand` to write
      FA opcodes (currently gated for safety)
- [ ] Port the 56-byte stats decoder (`pyjura/stats.py`) into
      `decodeStatsPayload()` — populate `power_state`, counters,
      service alert bools
- [ ] Port FA opcode table (`pyjura/commands.py`) into `resolveOpcode()`
      so brew commands actually brew (currently uses placeholder
      single-byte opcodes that the BlueFrog rejects)
- [ ] Smoke-test: click Power ON in dashboard → real espresso 🎉
- [ ] BlueFrog at RSSI -82 in current placement — consider moving the
      ESP32 1-2 m closer to the J6 if scan misses become frequent

## References

- [Jutta-Proto/protocol-bt-cpp](https://github.com/Jutta-Proto/protocol-bt-cpp) — definitive C++ implementation, includes the full spec
- [Jutta-Proto/pyjura](https://github.com/Jutta-Proto/pyjura) — Python port
- [Jutta-Proto/Home-Assistant](https://github.com/Jutta-Proto) — HA integration variants
- [BlueFrog product page](https://blue-frog.shop) — vendor docs (when available)
