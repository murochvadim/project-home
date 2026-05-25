# IR_RF_SOMFY_TOOL — Capture & Validate Bench Tool for IR + 433 MHz RF + Somfy RTS

> **Status:** scoping / design phase. Hardware on hand (per user): 5× generic CC1101+SMA modules (+10 dBm, 433 MHz, multi-pack), ESP32-WROOM-32, TSOP38238 IR receiver, IR LED + BC547 + resistors, breadboard. No sketch written yet, no DB tables, no dashboard page.

## Purpose

Bench rig that **captures, names, stores, and validates** wireless control signals across three protocol families, then makes the captured codes available to the rest of the project for future blaster boards.

| Mode | What it does | Underlying protocol concept |
|---|---|---|
| **IR** | Listen for any 38 kHz IR remote → decode → save with a name | Capture-and-replay (fixed codes, decoded by protocol — NEC, Sony, Daikin AC, Samsung TV, etc.) |
| **RF** (433.92 MHz) | Listen for 433 MHz ASK/OOK transmissions → decode or save raw → name | Capture-and-replay (fixed codes — PT2262, EV1527, garage doors, doorbells, weather stations, simple remotes) |
| **Somfy RTS** (433.42 MHz) | **NOT capture-and-replay** — Somfy uses rolling counters with AES-like encryption. Instead: **pair the rig as a NEW virtual remote** with each motor (one-time dance), then send up/down/stop commands from the assigned address. | Pair-then-control (rolling code, address-bound) |

After save + validate, captured codes (IR + RF) and paired motors (Somfy) live in DB tables. Future blaster ESP boards consume from these tables via the existing `esp_boards` framework — no per-board code-storage logic.

This module is **bench-only**: it captures, names, stores, validates. It is NOT a permanent blaster. After validation, the user moves on to building separate dedicated blaster boards (Maya bedroom IR, outdoor awning Somfy, garage RF, etc.) that consume the saved codes. Same pattern as `HLK_TOOL` — capture/calibrate on the bench, release the data to the rest of the project, move on.

## Hardware (confirmed)

### Sole rig: ESP32 + IR rx/tx + CC1101 (rx + tx via single module)

| Component | Role | Notes |
|---|---|---|
| **ESP32-WROOM-32** dev board | Brain — SPI to CC1101, GPIO to IR receiver/LED, WiFi+MQTT, ArduinoOTA | Same chip you use everywhere else in the project (matches HLK_TOOL pattern) |
| **TSOP38238** IR receiver | 38 kHz IR demodulator — captures any standard consumer IR remote (covers ~95% of AC remotes, TVs, fans, etc.) | 3-pin, demodulated digital output; works at 5 V or 3.3 V; output is open-drain so pull-up needed |
| **High-output IR LED** (5 mm, 940 nm) | IR transmit | Wide-angle for line-of-sight tolerance |
| **BC547 NPN transistor** | Drives the IR LED at higher current than ESP32 GPIO can directly source | Common-emitter switching |
| **220 Ω + 100 Ω resistors** | IR LED current limit + transistor base bias | Standard hobbyist values |
| **CC1101 module + SMA antenna** | 433 MHz transceiver — captures + transmits OOK/FSK/GFSK/MSK for RF and Somfy. Same module covers BOTH 433.92 MHz (general RF) and 433.42 MHz (Somfy) via firmware frequency switching. | Generic ~$2 module, +10 dBm TX, multi-band CC1101 chip but PCB tuned for 433 MHz band. 5-pack ordered for spares + future blasters. |
| **Breadboard + jumper wires** | Prototype wiring | Until everything is proven; then move to a proper PCB or perfboard. |

### ESP32 pin assignment (planned)

| ESP32 GPIO | Connects to | Why this pin |
|---|---|---|
| GPIO 5 (VSPI CS default) | CC1101 CSN (pin 4) | SPI chip-select |
| GPIO 18 (VSPI SCK default) | CC1101 SCK (pin 5) | SPI clock |
| GPIO 23 (VSPI MOSI default) | CC1101 MOSI (pin 6) | SPI master-out |
| GPIO 19 (VSPI MISO default) | CC1101 MISO (pin 7) | SPI master-in |
| GPIO 4 | CC1101 GDO0 (pin 3) | Hardware-interrupt-capable; CC1101 raises GDO0 when packet received / sync detected |
| GPIO 15 | CC1101 GDO2 (pin 8) | Second interrupt source (optional — used for fine-grained packet state machine) |
| GPIO 13 | TSOP38238 OUT pin | Interrupt-capable; demodulated IR bitstream |
| GPIO 14 | BC547 base via 220 Ω → IR LED via 100 Ω | PWM-capable (`ledc` channel), drives 38 kHz IR carrier for TX |
| 3V3 | CC1101 VCC (pin 2), TSOP38238 VCC | 3.3 V rail. **Never use 5 V on CC1101** — chip is 3.3 V only |
| 5V (VIN) | IR LED anode (via 100 Ω) | Higher current capability for stronger IR transmit. ESP32's USB 5 V rail handles ~150 mA easily. |
| GND | CC1101 GND (pin 1), TSOP38238 GND, BC547 emitter, all returns | Common ground critical |

GPIO numbers are defaults; can be reshuffled if pin conflicts appear during build.

## Software libraries (off-the-shelf)

All open-source, MIT/BSD/Apache licensed, well-maintained:

| Library | Used for | Why |
|---|---|---|
| **`IRremoteESP8266`** ([GitHub](https://github.com/crankyoldgit/IRremoteESP8266)) | IR receive + decode + transmit | Handles 100+ AC/TV/remote protocols including Daikin / Mitsubishi / Samsung / LG / Sony / Panasonic / Toshiba / NEC / RC5 / RC6. Despite the name, works on ESP32. Same library your TOTO toilet sketch uses (commit `a0f770e`). |
| **`SmartRC-CC1101-Driver-Lib`** ([GitHub](https://github.com/LSatan/SmartRC-CC1101-Driver-Lib)) | CC1101 low-level driver: SPI init, frequency tuning, PA table, RX/TX FIFO, GDO interrupt config | Mature, widely-used. Configures the chip for OOK/ASK/FSK as needed per mode. |
| **`rc-switch`** ([GitHub](https://github.com/sui77/rc-switch)) | RF capture-and-decode for fixed-code protocols at 433.92 MHz | Handles PT2262/PT2272, EV1527, basic doorbells, simple remotes. Built on top of the raw OOK demodulation from CC1101. |
| **`Somfy_Remote_Lib`** by Nickduino ([GitHub](https://github.com/Nickduino/Somfy_Remote_Lib)) | Somfy RTS protocol — frame structure, rolling-counter math, pairing dance | Battle-tested on ESP32 + CC1101. Counter must persist to ESP32 NVS / EEPROM after every transmit. |

Plus the standard ESP32 stack: `WiFi.h`, `PubSubClient` (MQTT), `ArduinoOTA`, `Preferences` (NVS) or `EEPROM`, `ArduinoJson`.

## esp_boards framework (mandatory for this project)

Slots into the standard pattern documented in root `CLAUDE.md` → "Project Boards" + `BOILER/dashboard/docs/esp_boards.md`. Identical shape to `HLK_Tool_Claude` and `Face_Recognition_Claude`:

| Topic | Direction | Purpose |
|---|---|---|
| `mur/home/esp/ir_rf_somfy_01/availability` | board → broker | LWT online/offline |
| `mur/home/esp/ir_rf_somfy_01/schema` | board → broker (retained) | Parameters + actions self-declaration |
| `mur/home/esp/ir_rf_somfy_01/status` | board → broker | 60 s heartbeat + on-change (current mode, last captured frame summary, free heap, etc.) |
| `mur/home/esp/ir_rf_somfy_01/event` | board → broker | **Each captured frame** (IR / RF / Somfy) — published as JSON for dashboard to consume |
| `mur/home/esp/ir_rf_somfy_01/config` | broker → board | Parameter writes (e.g. switch mode, set Somfy frequency) |
| `mur/home/esp/ir_rf_somfy_01/command` | broker → board | Action dispatch (`start_capture_ir`, `start_capture_rf`, `start_capture_somfy`, `transmit_ir <code_id>`, `transmit_rf <code_id>`, `somfy_pair <motor_id>`, `somfy_send <motor_id> <up|down|stop|my>`) |

Board ID convention: `ir_rf_somfy_01` (the `_01` allows future variants if needed). Sketch name: must contain "ESP32" so dashboard's OTA path detection picks port 3232 → `sketch_name = "IR_RF_Somfy_Tool_ESP32"`.

## DB schema additions (LXC 102)

Two new tables:

### `ir_rf_codes` — captured IR + RF codes (capture-and-replay protocols)

```sql
CREATE TABLE ir_rf_codes (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,                -- user-given: "Living Room AC ON", "Garage Open", etc.
  category        TEXT,                          -- 'tv' | 'ac' | 'gate' | 'blind' | 'awning' | 'light' | 'fan' | 'doorbell' | 'other'
  family          TEXT NOT NULL,                 -- 'ir' | 'rf' (Somfy lives in separate table — different model)
  protocol_type   TEXT NOT NULL,                 -- 'ir_nec' | 'ir_sony' | 'ir_daikin' | 'ir_raw' | 'rf_pt2262' | 'rf_ev1527' | 'rf_raw' | ...
  raw_data        JSONB NOT NULL,                -- protocol-specific: timings array for raw, decoded code+repeat for known protocols, AC state struct for AC protocols
  frequency_hz    INT,                            -- 38000 for IR carrier, 433920000 for standard RF
  validated       BOOLEAN DEFAULT FALSE,
  validation_notes TEXT,                          -- "tested on Maya AC, turned on" / "tested on garage gate, opened OK"
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ir_rf_codes_family    ON ir_rf_codes (family);
CREATE INDEX ir_rf_codes_category  ON ir_rf_codes (category);
CREATE INDEX ir_rf_codes_validated ON ir_rf_codes (validated);
```

Retention: **forever** (config-like data, low volume — maybe 20-50 rows lifetime).

### `somfy_motors` — paired Somfy RTS motors (pair-then-control protocol)

```sql
CREATE TABLE somfy_motors (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL UNIQUE,    -- "Living Room Awning", "Bedroom Blind", "Balcony Shade", etc.
  virtual_remote_address  INT NOT NULL UNIQUE,     -- 24-bit address (1..0xFFFFFF), must not collide with another paired motor
  rolling_counter         INT NOT NULL DEFAULT 0,  -- 16-bit, persists across reboots. CRITICAL: must be saved to NVS after every transmit
  paired                  BOOLEAN DEFAULT FALSE,   -- TRUE only after successful pairing dance confirmed
  paired_at               TIMESTAMPTZ,
  category                TEXT,                     -- 'awning' | 'blind' | 'shade' | 'curtain' | 'shutter' | 'other'
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
```

**Critical operational concern: `rolling_counter` MUST survive ESP32 reboots / OTA / power loss.** If the counter ever resets to 0 (or to any lower value than the motor's last-seen counter), the motor will REJECT subsequent commands until re-paired. Implementation requirements:

1. ESP32 stores the current counter for each motor in **NVS** (`Preferences` library) — key per `virtual_remote_address`
2. Counter is INCREMENTED and PERSISTED **before** transmitting the frame
3. Counter is also mirrored to the DB row after every successful transmit (DB is the source of truth for the dashboard's display + bench-tool replacement scenarios)
4. On boot, ESP32 reads counter from NVS as the authoritative source (in case DB is out of sync)
5. **DO NOT** wipe NVS during OTA — `Preferences` survives ArduinoOTA flash by default, but verify

Retention: **forever** (~5-15 rows lifetime — one per motor in the home).

## Dashboard surface — new sub-tab on Project Boards page

Inside the existing Project Boards page (`BOILER/dashboard/public/esp-boards.html`), when the user selects this rig's tab (`ir_rf_somfy_01`), four sub-tabs (mode selector is here):

### Sub-tab 1 — Capture / Pair (mode-selector)

Top of the sub-tab: **Mode picker** (radio buttons or segmented control):
- **IR** (default)
- **RF 433.92 MHz**
- **Somfy 433.42 MHz**

Picking a mode sends a `command` MQTT message to the rig (`start_capture_ir`, `start_capture_rf`, `start_capture_somfy`). Rig reconfigures CC1101 frequency / disables CC1101 / enables TSOP38238 listening / etc. as appropriate.

**IR + RF modes** show:
- Live "waiting for transmission..." indicator (animated dot)
- When a frame is captured: rig publishes to `/event` with:
  - `family`: `ir` or `rf`
  - `protocol_type`: decoded protocol name OR `ir_raw`/`rf_raw` if unknown
  - `raw_data`: protocol-specific JSON
  - `decoded_repr`: human-readable (e.g. `NEC 0xFFE21D`, `EV1527 1234567`, `Daikin AC 24°C cool fan_auto`)
- Dashboard displays the captured frame in a "pending capture" box
- User fills in: **Name** (required), **Category** (dropdown), **Notes** (optional) → clicks **Save**
- Row inserted into `ir_rf_codes` with `validated=false`
- Pending capture cleared, dashboard returns to "waiting for next..." state

**Somfy mode** is different — see Sub-tab 3 (Somfy Motors) for the actual flow. Selecting Somfy here is mostly for forensic capture of existing Somfy frames (to verify a motor is broadcasting, to check counter status). Captured Somfy frames are NOT saved — Somfy is pair-not-capture by design.

### Sub-tab 2 — Saved Codes (IR + RF)

Table of `ir_rf_codes` rows. Columns:
- Name
- Family (IR / RF badge with color)
- Protocol type (`NEC`, `Sony`, `EV1527`, etc.)
- Category
- Validated (✓/✗ chip)
- Created at
- Actions: **Edit** (rename, recategorize, edit notes), **Delete**, **Transmit** (sends the code right now — for testing), **Open Validate flow** (see Sub-tab 4)

Filter by family / category / validated state. Sort.

### Sub-tab 3 — Somfy Motors (pair-and-control)

Table of `somfy_motors` rows. Each row:
- Motor name
- Virtual remote address (read-only, displayed for forensic / re-pair purposes)
- Rolling counter (read-only, displayed for diagnostic)
- Paired (✓/✗ chip — TRUE only after pairing dance succeeded)
- Created at
- **Up / Stop / Down / My** buttons (live-control the motor — sends Somfy command from this row's address + increments + persists counter)

Header buttons:
- **+ Add New Motor** — opens form: name (required), category (dropdown: awning/blind/shade/curtain/shutter/other), notes. Saves with `paired=false`, auto-assigns next-free `virtual_remote_address`.
- **Start Pairing for selected motor** — sends `somfy_pair <motor_id>` command to rig. Dashboard then prompts user: *"Press the Prog button on the motor's existing Somfy remote for 5 s until the motor jogs. Then press OK."* Once user clicks OK, dashboard sends `somfy_send_pair_command <motor_id>` — rig transmits the Somfy PROG frame from the virtual address. Motor jogs again to confirm pairing. User confirms via dashboard → `paired=true`, `paired_at=now()`.

### Sub-tab 4 — Validate

For any `ir_rf_codes` row that isn't yet validated:
- Select the code
- Click **Transmit**
- Dashboard prompts: *"Did the target device react as expected? (Y/N — describe behavior)"*
- User answers → `validated=true` (or stays false), `validation_notes` captured

Same workflow runs for Somfy motors implicitly: a motor's first successful Up/Down/Stop command after pairing counts as validation (`paired=true` already covers this).

## Capture flow — protocol detail

### IR capture
1. ESP32 in IR mode: TSOP38238 GPIO13 interrupt-armed
2. Each IR frame: arrival times → buffer (raw timings, microseconds)
3. After 100 ms of silence → frame end → `IRremoteESP8266` attempts to decode
4. If decoded: known protocol + parameters (e.g. NEC code 0xFFE21D)
5. If not decoded: raw timings preserved
6. Publish frame to `/event` topic
7. Dashboard displays it; user saves with a name

### RF capture (433.92 MHz)
1. CC1101 tuned to 433.92 MHz, OOK demod mode, GDO0 = sync-detect
2. Sync edge → start sampling bit stream into GDO0 ISR
3. After bit stream ends → buffer of timings → `rc-switch` decode attempt
4. If decoded: PT2262 / EV1527 / specific encoder type with code + protocol parameters
5. If not decoded: raw timings preserved
6. Publish + dashboard + save (same as IR flow)

### Somfy pairing (433.42 MHz)
1. User selects/creates a motor row in dashboard, assigns `virtual_remote_address` (auto-assigned next free 24-bit number)
2. User physically presses **Prog** on motor's existing remote — motor enters pair-mode (jogs once)
3. Dashboard sends `somfy_send_pair_command <motor_id>` → rig assembles Somfy PROG frame: address + counter + key + button=PROG
4. Counter incremented + persisted to NVS + DB
5. CC1101 tunes to 433.42 MHz, transmits the frame
6. Motor receives, validates, confirms by jogging again
7. User clicks "confirmed" in dashboard → `paired=true`

### Somfy send command (after pairing)
1. User clicks Up/Stop/Down/My on a paired motor row in dashboard
2. Rig assembles frame: same address as pairing, new incremented counter, button = chosen action
3. Counter incremented + persisted to NVS + DB
4. CC1101 tunes to 433.42 MHz, transmits
5. Motor responds (move up/stop/down/preset position "My")

## Validation flow

After capture + save:
- IR / RF: user picks the saved code, hits **Transmit**, observes target device → marks validated=true
- Somfy: successful Up/Down/Stop transmission to a paired motor counts as validation (implicit; `paired=true` is the gate)

Validated codes are the ones safe for future blaster boards to consume. Unvalidated codes are saved for forensic / archival but flagged as risky.

## Library / blaster consumption

Once a code is in `ir_rf_codes` (validated) OR a motor is in `somfy_motors` (paired), it's available for future ESP boards anywhere in the project to use:

**Pattern for a future blaster board:**
- Board declares in its `board_schema.actions` something like `{"key":"transmit_ir:<code_id>", "description":"Transmit IR code from DB"}` or `{"key":"somfy_up:<motor_id>","description":"Send Somfy UP to paired motor"}`
- Dashboard's device-picker can resolve code_id / motor_id by name (queries `ir_rf_codes` / `somfy_motors`)
- Rule engine action dispatcher (or dashboard direct dispatch) reads the row's `raw_data` (or motor address+counter) and sends the appropriate command to the blaster
- Blaster board executes the transmit via its own CC1101 / IR LED

**Critical: the rolling counter for a Somfy motor MUST be shared across the bench tool AND any future blaster that controls the same motor.** Two ways to handle this:

1. **Single-owner pattern (recommended for v1)** — exactly ONE board "owns" the motor at any time. That board persists the counter in its NVS + writes back to DB on every send. Other boards must query the DB before sending and use the latest counter. Simple but races possible if multiple sends happen near-simultaneously.

2. **DB-authoritative pattern** — all sends go through a central rule (e.g. on LXC 105) that increments the DB counter, writes the resulting frame data, and dispatches to whichever board is nearest. Avoids NVS-vs-DB drift but adds latency.

Defer this decision to when the first Somfy blaster board is built. For the bench tool itself, single-owner is fine — the tool is the only sender during capture/pair sessions.

## Setup steps

| # | What | Where | Status |
|---|---|---|---|
| 1 | Hardware on hand: ESP32 + TSOP38238 + IR LED + BC547 + resistors + breadboard + 5× CC1101+SMA ordered | user | ✓ confirmed |
| 2 | Scaffold `Arduino_Projects/IR_RF_Somfy_Tool_Claude/` sketch — 4 files following esp_boards framework (Main.h, main .ino, Esp_Base.ino, IR_RF_Somfy_Protocol.ino) | user's PC | ⏳ |
| 3 | Compile + flash via USB; first WiFi/MQTT connect | user | ⏳ |
| 4 | Verify CC1101 communication (read PARTNUM=0x00, VERSION=0x14 over SPI) | user | ⏳ |
| 5 | INSERT `esp_boards` row `ir_rf_somfy_01` (auto-populated by rule engine on first MQTT connect) | LXC 102 (rule engine writes it) | ⏳ |
| 6 | CREATE `ir_rf_codes` + `somfy_motors` tables + retention policy rows | LXC 102 | ⏳ |
| 7 | Add new sub-tabs on Project Boards page for this board: Capture / Saved / Somfy Motors / Validate | dashboard | ⏳ |
| 8 | First IR capture test (any TV remote — easiest baseline) | bench | ⏳ |
| 9 | First RF capture test (a doorbell or similar 433.92 MHz device) | bench | ⏳ |
| 10 | First Somfy pairing — pick a real motor (awning?), do the pairing dance, send Up/Down | bench | ⏳ |
| 11 | Document open issues / Lessons Learned section in this doc | — | ⏳ |

## Phase rollout

| Phase | Effort | What ships |
|---|---|---|
| **P1 — Sketch + IR-only mode** | ~2 days | ESP32 + TSOP38238 + IR LED wired. Sketch boots, joins WiFi+MQTT, captures IR frames, publishes to `/event`. Dashboard sub-tab shows live captures with name + save form. First IR code in DB. |
| **P2 — RF 433.92 MHz mode** | ~1-2 days | CC1101 wired + tuned to 433.92 MHz. Mode-selector + RF capture flow. First RF code in DB (test target: any cheap doorbell). |
| **P3 — Somfy 433.42 MHz mode + pairing dance** | ~2 days | Somfy library integrated. `somfy_motors` table active. Dashboard Somfy sub-tab with add-motor + pair flow. First real motor paired + driving up/down. |
| **P4 — Validate flow + dashboard polish** | ~1 day | Validate sub-tab. Edit/delete on saved codes. Filter + sort on saved codes. Pretty rendering of decoded codes (showing AC parameters for Daikin etc.). |
| **P5 (later) — Build first dedicated blaster board** | varies | Separate sketch (e.g. `Maya_AC_Blaster_Claude`), consumes from `ir_rf_codes`. Phase 5 is a separate module per blaster, not part of this spec. |

Total bench tool effort: ~6-7 days spread over a few weeks. Each phase independently shippable. P1 alone is useful (IR capture working end-to-end).

## Open decisions

1. **First targets to capture/validate during P1-P3** — which 2-3 concrete devices? Suggested: (a) TV remote (easiest IR baseline), (b) doorbell or similar cheap 433.92 MHz device (RF baseline), (c) a real Somfy motor you actually own (awning / blind / shade). User to specify.
2. **Maya bedroom AC remote** — eventual replacement target for the cloud-only Tuya ZCZK IR hub? Likely yes per `MEMORY.md` Tuya IR hubs entry — that integration is functionally crippled (cloud-only, no battery, can't send commands today).
3. **Counter ownership pattern for shared Somfy motors** — single-owner board or DB-authoritative? Defer to first blaster board.
4. **Should the bench tool also serve as a permanent blaster** for ONE specific use (e.g. if there's a Somfy motor near where the bench tool will live)? Or strictly bench-only and always-on blasters are separate hardware? Default: strictly bench-only.
5. **Frequency switching latency** — switching CC1101 between 433.92 (RF mode) and 433.42 (Somfy mode) takes ~1 ms. Negligible. No design impact.

## Integration with existing project

- **esp_boards framework** — single board (`ir_rf_somfy_01`) appears as another tab on Project Boards page alongside `face_01`, `gates_01`, `jura_bridge_01`, etc.
- **Rule engine on LXC 105** — eventually consumes `ir_rf_codes` + `somfy_motors` via the standard `_dispatch_esp` path: future blaster boards expose actions like `transmit_ir:<code_id>` that rules can call by name.
- **MQTT user** — uses existing shared `esp_boards` Mosquitto user on LXC 107 (per project convention). No new ACL needed.
- **OTA** — port 3232 (ESP32) via dashboard's `espota.py` spawn. Sketch name must contain "ESP32".
- **Sentence-driven rules** — future rules referencing IR/RF codes use `@<code_name>` chips (e.g. *"when X event, transmit @Maya AC On via @Maya AC Blaster"*).

## File / location index

| Artifact | Path |
|---|---|
| This doc | `IR_RF_SOMFY_TOOL/CLAUDE.md` |
| Sketch | `C:\Users\muroc\Arduino_Projects\IR_RF_Somfy_Tool_Claude\` (parallel to `Face_Recognition_Claude/`, `HLK_Tool_Claude/`, `jura_bridge_01/`). Sketches live outside this repo per project convention. |
| Dashboard sub-tab | `BOILER/dashboard/public/esp-boards.html` + `BOILER/dashboard/public/js/esp-boards.js` (extends existing board-tab handling to render Capture/Saved/Somfy/Validate sub-tabs for `ir_rf_somfy_01`-type boards) |
| Dashboard endpoints | `BOILER/dashboard/server.js` — new `/api/ir-rf-codes/*` + `/api/somfy-motors/*` routes (CRUD on the two tables) |
| DB migration | `BOILER/dashboard/migrations/<date>_ir_rf_somfy_tables.sql` (or inline in `ensureSchema()`) |
| Future blaster sketches | `C:\Users\muroc\Arduino_Projects\<Name>_Blaster_Claude\` per device — each consumes from `ir_rf_codes` + `somfy_motors` |

## Reference docs

- Hi-Link CC1101 datasheet — TI's official chip docs (search "CC1101 datasheet" — chip is widely documented)
- IRremoteESP8266 wiki: [github.com/crankyoldgit/IRremoteESP8266/wiki](https://github.com/crankyoldgit/IRremoteESP8266/wiki)
- Somfy RTS protocol notes by Nickduino: [github.com/Nickduino/Somfy_Remote_Lib](https://github.com/Nickduino/Somfy_Remote_Lib) — README has the frame structure + pairing flow
- `rc-switch` supported protocols: [github.com/sui77/rc-switch/wiki/KnownDevices](https://github.com/sui77/rc-switch/wiki/KnownDevices)

---

**Update protocol:** keep this doc current as decisions land. New design questions → add to Open Decisions. Resolved decisions → fold into the appropriate spec section. After P3 ships (first real Somfy motor paired) → add a "Lessons Learned" section before the file index.
