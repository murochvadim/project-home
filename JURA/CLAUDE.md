# Jura Coffee Machine

Planning + protocol notes. Integration STARTED 2026-05-04 — chosen
implementation route is **Path C** (custom Arduino sketch on a spare
ESP32-C3, fits our `esp_boards` subsystem). Paths A and B are kept
below for context but are not the active route.

## ✅ BREAKTHROUGH (2026-07-10) — laptop BLE decodes REAL stats; the year-long blocker was a wrong key

Everything below (Phase 2 "blocked on the machine file", write hangs, undecodable
reads) is **resolved**. Proven live from the **laptop's Bluetooth** (`bleak`) —
tools in [tools/](tools/) (`jura_stats.py` is the payoff).

**The root cause of the whole block: the encryption key was wrong.** The real key
is `manufacturer_data[171][0]` — the **first byte of the BLE advertisement's
manufacturer payload** (company id 171 = `0xAB`). On this dongle **key = `0x2A`**.
The old sketch hardcoded `0xAB`, which is the company *id*, not the key. With the
right key the `juraEncDec` (already correctly ported — self-test confirms it's
involutory) decrypts everything.

**Statistics read flow (works, per AlexxIT/Jura):**
1. `encrypt([0x2A,0x00,0x01,0xFF,0xFF], key)` → write to **STATS_COMMAND `5a401533`**
   (`encrypt` overwrites byte[0] with the key, then `encdec`). This is a *read-request*, no brewing.
2. Poll-read STATS_COMMAND until **`byte[1] != 0xE1`** (`0xE1`/225 = "not ready" —
   this is exactly why our earlier bare reads returned `xx E1 3D D6…`: we never sent the request).
3. Read **STATS_DATA `5a401534`**, `encdec` with the key → **3-byte big-endian counters**,
   indexed by product `@Code` (index 0 = grand total).

**Live result (2026-07-10):** total **10,981**; Coffee 5062, Milk 4931, Cappuccino 316,
Espresso 276, Flat White 247, Latte 74, Ristretto 56, Espresso Macchiato 10, Hot water 9.

**The machine file — obtained.** `AlexxIT/Jura` bundles `core/resources.zip` with
Jura's own per-model command files. Our J6 = family **`EF557`** (map
`JOE_MACHINES.TXT`: `15111;J6;EF557`), file `documents/xml/EF557/1.0.xml`. It lists
**every** command the J6 accepts: brew products (Ristretto `01`, Espresso `02`,
Coffee `03`, Cappuccino `04`, Latte `07`, Flat White `2E`, 2× variants, Hot water
`0D`…), maintenance `@TG:` (CappuClean 21, CappuRinse 23, Cleaning 24, Decalc 25,
FilterChange 26, PressRinse 10), reads `@TR:32` (product counters) / `@TG:43` /
`@TG:C0`, and `@TS:00/01`.

**⛔ There is NO power-off / standby command** — not in the machine file, not in
AlexxIT, not in protocol-bt-cpp. Jura never exposed it. The only power item is an
*alert* the machine emits (`SwitchOff Delay active`). **Turning the J6 off over BLE
is impossible by design.** On/off is instead **detected by advertising presence**:
dongle advertising = ON, dongle absent = OFF (verified both ways, 3× each).

**Now reachable (same key + machine file):** coffee counters ✅ (done), machine
status/alerts (water/beans/grounds/clean/descale — decrypt MACHINE_STATUS `5a401524`
with the key), brew commands (encrypt 18-byte product packet → START_PRODUCT `5a401525`),
maintenance triggers. **Model** `EF557M` + firmware `V05.08F`/`V01.05` read as
plaintext from char `5a401531`.

**Radio note:** only the **laptop** (dashboard host) is within BLE range of the
kitchen Jura. The balcony bridge (BoBo) is out of range AND is a working module —
do NOT reflash it. A live Jura tile would run a scanner on the laptop.

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

**Phase 2 — IN PROGRESS, blocked on machine file (2026-05-04 session 2)**:

Significant progress, brew not yet functional. Six things proven, one
blocker.

**Proven working ✓ (do not re-investigate):**
- [x] Auth model is **NOT challenge/response** — there's no handshake.
      The encryption "key" is byte 0 of the BLE advertisement's
      Manufacturer Specific Data (AD type `0xFF`). Walk the raw
      advertisement payload (`d.getPayload()` / `d.getPayloadLength()`)
      and find the first `0xFF` AD record; the byte AFTER the AD type
      is the key. On this BlueFrog the key is `0xAB` (static for the
      lifetime of the dongle). Source: `Jura_BLE.ino` scan loop.
- [x] **`juraEncDec` algorithm** ported verbatim from
      [protocol-bt-cpp/ByteEncDecoder.cpp](https://github.com/Jutta-Proto/protocol-bt-cpp/blob/main/src/jutta_bt_proto/ByteEncDecoder.cpp):
      two 16-byte permutation tables (`JURA_NUM1`, `JURA_NUM2`) +
      per-nibble shuffle. Symmetric — calling `juraEncDec(juraEncDec(x))`
      with the same key returns `x`. Implementation in `Jura_BLE.ino`.
- [x] **`StartProduct` characteristic** is `5a401525` (W only — no
      WRITE_NO_RSP). Bluedroid's `writeValue(..., false)` falls back
      to write-with-response anyway because the char doesn't expose
      the WRITE_NO_RSP property.
- [x] **Service has 8 (sometimes 9) characteristics**, NOT the larger
      set protocol-bt-cpp documents. Stable enumerated set:
      `5a401524` (R), `5a401525` (W), `5a401527` (R), `5a401528` (W),
      `5a401529` (W), `5a401530` (RW), `5a401531` (R), `5a401532` (RW),
      sometimes `5a401535` (RW). Notably **no `5a401533/34/38`** —
      protocol-bt-cpp's STATISTICS_COMMAND / STATISTICS_DATA /
      P_MODE_READ don't exist on this BlueFrog firmware.
- [x] **J6-specific opcodes** from
      [ryanalden/esphome-jura-component](https://github.com/ryanalden/esphome-jura-component):
      `0x07` espresso, `0x08` 2x espresso, `0x09` 1 coffee,
      `0x0A` 2x coffee, `0x06` hot water. (NOT `0x03` from
      protocol-bt-cpp's README — that was a different machine.)
- [x] **`AN:01` / `AN:02`** = power on/off. Different prefix from
      brew commands; routes through a different characteristic
      (likely `P_MODE` `5a401529` but unverified). `on`/`off`/`cancel`/
      `standby` are gated in code with a `cmd-blocked: an_prefix_pending`
      event until verified.

**The hard blocker:**
- [ ] **`writeValue` to START_PRODUCT silently times out** for every
      structure we've tried. The J6 doesn't ACK at the GATT layer →
      Bluedroid blocks `writeValue` for ~25 s, then auto-resets the
      chip. Confirmed across 5+ test cycles. Without ACK, the J6 also
      doesn't physically react (no beep, no display change).

### Failed write attempts (DO NOT REPEAT)

Each row is a complete sketch state we flashed and tested. The
"Reaction" column documents what the J6 did. None caused brewing.

| Bytes (pre-encryption, big-endian) | Length | Reaction | Source of structure |
|---|---|---|---|
| `[KEY] 03 00 04 14 00 00 01 00 01 00 00 00 00 00 [KEY]` | 16 | None | protocol-bt-cpp README example |
| `[KEY] 09 00 04 14 00 00 01 00 01 00 00 00 00 00 [KEY]` | 16 | None | Same template, J6 opcode `0x09` |
| `[KEY] 09 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 [KEY]` | 18 | None (writeValue timed out) | AlexxIT 18-byte, all-zero attributes |
| `[KEY] 09 00 04 28 00 00 02 00 01 00 00 00 00 00 00 00 [KEY]` | 18 | None (writeValue timed out) | AlexxIT 18-byte + protocol-bt-cpp's hardcoded attribute defaults |

`[KEY]` = `0xAB` on this BlueFrog. Buffer is encrypted with `juraEncDec(buf, 18, 0xAB)` after key insertion.

**Conclusion**: the J6 firmware checks the recipe payload (bytes 2-16)
against a per-machine schema and silently rejects writes that don't
match. The schema is NOT in any public source — it lives only in the
J6's machine-file XML inside JURA's official **JOE Android APK** under
`assets/machinefiles/<model>.xml`.

### Failed library/architecture attempts (DO NOT REPEAT)

| Attempt | Outcome |
|---|---|
| `writeValue(..., true)` (write-with-response) | Hangs ~25 s when J6 doesn't ACK, then chip software-reset |
| `writeValue(..., false)` (write-no-response) | Same hang — Bluedroid falls back to write-request because the char only exposes WRITE prop |
| FreeRTOS task wrapper with 5 s software timeout | Loop survives the timeout, but next session crashes with backtrace because the leaked task corrupts Bluedroid's mutex state. **Unsafe pattern, do not retry.** |
| `pollStats()` reading `MACHINE_STATUS` (5a401524) | Same indefinite hang as writeValue — the J6 doesn't respond to plain reads. Disabled in current sketch. Likely needs the WRITE STATISTICS_COMMAND → READ STATISTICS_DATA handshake first, but those characteristics don't exist on this BlueFrog firmware. |
| Reading `5a401534` STATISTICS_DATA | UUID doesn't exist on this BlueFrog (per enumeration) — kept the comment in `Main.h` for posterity. |

### What lives in the sketch right now (last flash)

Sketch directory: `C:\Users\muroc\Arduino_Projects\jura_bridge_01\`,
mirrored into this repo at [JURA/sketch/](sketch/) for git tracking
(authoritative copy is the Arduino_Projects one — Arduino IDE compiles
from there).

The four files:
- `Main.h` — board identity, UUIDs, MQTT/WiFi credentials, OTA password
- `Esp_Base.ino` — ESP base subsystem (schema, status, MQTT topics, OTA
  hooks, tunable params)
- `jura_bridge_01.ino` — main entry point, WiFi setup, Mosquitto
  reconnect, 60 s BLE init deferral for OTA windows
- `Jura_BLE.ino` — scan/connect/auth/cmd/disconnect, encryption,
  command dispatch

Current sketch state: best-guess 18-byte packet with protocol-bt-cpp
attribute defaults (`28 00 00 02 00 01`) at bytes 4-9, key at [0] and [17].
**Brew does not work**. Direct `writeValue(..., true)` (no FreeRTOS
wrapper). Stats poll DISABLED (was hanging). Encryption self-test
DISABLED (would also hang on the read).

### The path forward (when resumed)

The only realistic next step is extracting the J6 machine file from
the JOE Android APK. Outline:

1. Download the JOE app from the Google Play Store APK mirror
   (apkmirror.com — package `com.jura.joe` or similar)
2. Decompile with `jadx` or `apktool d <apk>`
3. Locate `resources/assets/machinefiles/` (per
   [protocol-bt-cpp README](https://github.com/Jutta-Proto/protocol-bt-cpp#machinefile))
4. Identify the J6's file (likely `EF532V2.xml` — protocol-bt-cpp
   uses that as its example, AND it's the machine ID family of the
   Impressa J6 line; verify by cross-referencing the J6's
   `ABOUT_MACHINE` read once we re-enable that path)
5. Parse the XML's `<PRODUCT code="09">` block — it has child elements
   describing each byte position and its meaning (`@Argument="P3"`
   means byte 3, `@Default="0x14"` means default value, etc.)
6. Plug those defaults into `cmdBuf[2..16]` in `Jura_BLE.ino`

Estimated effort: 2-4 hours offline (APK download, decompile, XML
parse, test). NOT incremental BLE debugging.

Alternative: capture a real J6 brew packet via Wireshark with a
phone running J.O.E. on Linux (`btmon` capture), decrypt with key
0xAB, decode. Probably faster (~1 hour) if you have a Linux box with
Bluetooth.

### What's also disabled / has TODO comments

- `pollStats()` — char reads hang, disabled. Re-enable with proper
  STATISTICS_COMMAND → STATISTICS_DATA handshake once we have the
  command bytes (probably also from machine file).
- Encryption self-test reading `ABOUT_MACHINE` — disabled because
  same hang. With handshake / proper write→read flow this would
  prove the encryption end-to-end and tell us model+firmware.
- `on`/`off`/`cancel`/`standby` — gated with `cmd-blocked:
  an_prefix_pending`. Need to wire the `AN:` prefix to `P_MODE`
  (5a401529) once the basic brew path works.

### Reference repos consulted

- [Jutta-Proto/protocol-bt-cpp](https://github.com/Jutta-Proto/protocol-bt-cpp) — encryption algorithm, UUIDs, write semantics, hardcoded 16-byte example (works for ONE machine, not J6)
- [Jutta-Proto/protocol-cpp](https://github.com/Jutta-Proto/protocol-cpp) — UART variant; serial protocol with FA: prefix
- [ryanalden/esphome-jura-component](https://github.com/ryanalden/esphome-jura-component) — J6-specific UART opcodes (FA:09 = coffee, etc.); confirms J6 model details
- [AlexxIT/Jura](https://github.com/AlexxIT/Jura) — actively-maintained HA component; **canonical 18-byte structure with key at [17]** (vs protocol-bt-cpp's older 16-byte / key-at-[15])
- [COM8/esp32-jura](https://github.com/COM8/esp32-jura) — older ESP32 prototype, UART only, NOT BLE; superseded by protocol-bt-cpp
- [Jutta-Proto/pyjura](https://github.com/Jutta-Proto/pyjura) — Python equivalent

## References

- [Jutta-Proto/protocol-bt-cpp](https://github.com/Jutta-Proto/protocol-bt-cpp) — definitive C++ implementation, includes the full spec
- [Jutta-Proto/pyjura](https://github.com/Jutta-Proto/pyjura) — Python port
- [Jutta-Proto/Home-Assistant](https://github.com/Jutta-Proto) — HA integration variants
- [BlueFrog product page](https://blue-frog.shop) — vendor docs (when available)
