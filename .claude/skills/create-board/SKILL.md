---
description: Create, update, or remove an ESP8266/ESP32 board in the Project Boards subsystem. Scaffolds sketch files, registers DB rows, and writes .env secrets.
user-invocable: true
---

# /create-board — ESP Board Builder

You are managing an ESP8266 or ESP32 board for the Project Boards dashboard. Follow this interactive flow. Use **AskUserQuestion** for each step. Do NOT skip steps or assume answers.

The subsystem is documented in:
- Root `CLAUDE.md` (Dashboard Pages → Project Boards row + DB Tables → `esp_boards`)
- `BOILER/dashboard/docs/esp_boards.md` (onboarding cookbook)
- Existing reference sketch: `C:\Users\muroc\Arduino_Projects\RemoteXY_ESP8266_ver13\` (uses `Main.h` + `Esp_Base.ino` pattern)

Topic convention every board uses:
- `mur/home/esp/<id>/availability` — board → broker (LWT: `online`/`offline`)
- `mur/home/esp/<id>/schema` — board → broker (parameters + actions, retained)
- `mur/home/esp/<id>/status` — board → broker (60 s heartbeat)
- `mur/home/esp/<id>/config` — broker → board (JSON of parameters to set)
- `mur/home/esp/<id>/command` — broker → board (action key as plain string)
- `mur/home/esp/<id>/event` — board → broker (acks + ad-hoc events)

## Step 0: Action

Ask:
- **Create** — scaffold a new board (sketch + DB rows + .env entry)
- **Update** — modify existing board (name / parameters / ota_password / enabled)
- **Remove** — delete board from DB + clear retained MQTT topics
- **List** — show all boards in `esp_boards` table

Branch into the matching flow.

---

## CREATE FLOW

### C1: Board identity

Ask:
- **Board ID** (must match `^[a-zA-Z][a-zA-Z0-9_-]*$` — letters first, then alphanumeric/underscore/dash; max 50 chars). Reject IDs starting with digit/underscore. This is the `device_id` in the sketch AND the MQTT topic `<id>` token.
- **Human name** (e.g. "Garage Sensor", "Boiler Probe") — for dashboard tab label
- **Chip family**:
  - ESP8266 (NodeMCU / Wemos D1 Mini) — port 8266 for OTA, no BLE, ~50 KB RAM
  - ESP32 (DevKit / WROOM) — port 3232 for OTA, has BLE, ~320 KB RAM
  - ESP32-S3 (Sunton, etc.) — port 3232, USB-OTG capable
  - ESP32-C3 — port 3232, BLE 5.0, cheapest
- **Room** (optional — picks from `SELECT name FROM rooms` for the `devices.room` column)

### C2: MAC address

Ask:
- **Already known** → user pastes MAC (format `aa:bb:cc:dd:ee:ff`)
- **Discover from ARP** → query `net_devices` for recent unknown MACs and let user pick:
  ```sql
  SELECT mac, ip, vendor, last_seen FROM net_devices
  WHERE mac NOT IN (SELECT mac FROM esp_boards WHERE mac IS NOT NULL)
    AND mac NOT IN (SELECT mac FROM devices WHERE mac IS NOT NULL)
  ORDER BY last_seen DESC LIMIT 20;
  ```
- **Skip** — populate later (board still works without; live IP just won't auto-fill until DB is updated)

### C3: Parameters

Ask: how many tunable parameters does this board have?

For EACH parameter, prompt for:
- **Key** (snake_case, ≤ 30 chars, ASCII letters/digits/underscore)
- **Type** — `int` / `float` / `string` / `bool`
- **Default** value
- **Min / Max** (for int/float) OR **min_length / max_length** (for string)
- **Description** (≤ 100 chars — appears in dashboard Params tab)
- **Persistent** (true → stored in EEPROM; false → defaults at boot)
- **Secret** (true → dashboard renders as password field; default false)

After all parameters: confirm the list before generating.

**EEPROM layout planning**: total parameter bytes must fit in `EEPROM_SIZE` (default 128). Reserve 32 bytes at offset 0 for HA broker IP (legacy /set_ip path), magic byte at offset 32, then pack parameters from offset 33+. If exceeded, bump `EEPROM_SIZE` to 256/512/etc. (max 4096 on ESP8266).

### C4: Actions

Ask: what test/control actions does this board have? (Built-ins `restart` and `factory_reset` always work — don't add unless overriding.)

For EACH action:
- **Key** (snake_case)
- **Label** (display text, e.g. "Open Doorlock")
- **Description**
- **Group** — pick which dashboard card it appears in:
  - `system` (Status sub-tab)
  - `doorlock` / `robot` / `hivemq` / `custom_X` (Simulation sub-tab)
- **Destructive** (true → red border + confirm dialog; default false unless key matches the destructive set)

If a group key isn't already in `BOILER/dashboard/public/js/esp-boards.js` `ACTION_GROUPS`, ALSO instruct the user to add it (or do it if you have approval to edit dashboard JS).

### C5: OTA + MQTT credentials

- Pull `ESP_BOARDS_MQTT_PASS` from `BOILER/dashboard/.env` — this is the shared MQTT password (every board uses it).
- **OTA password**: ask user — generate a random 16-char (no `'`, `"`, `\`, `$`, space) OR accept user input.
  - Save to `.env` as `ESP_OTA_PASS_<ID_UPPER>=<password>`.
  - Will be baked into sketch's `OTA_PASSWORD` define AND stored in `esp_boards.ota_password` column.

### C6: Generate sketch files

Create directory: `C:\Users\muroc\Arduino_Projects\<sketch_name>\` where `<sketch_name>` is user-provided (often matches board ID, e.g. `boiler_probe_01`). Inside it create:

#### `<sketch_name>.ino`
The main sketch file. Must include:
- `#include <ESP8266WiFi.h>` (or `<WiFi.h>` for ESP32)
- `#include <PubSubClient.h>` (for MQTT)
- `#include <ArduinoOTA.h>`
- `#include <ArduinoJson.h>`
- `#include <EEPROM.h>`
- `#include "Main.h"`
- Forward declarations for ESP base helpers
- `setup()` with:
  - WiFi connect
  - Build legacy + ESP base topics
  - Call `espBaseSetup()` (which registers ArduinoOTA + builds topics + loads EEPROM)
  - Configure PubSubClient with `setBufferSize(4096)` and callback
  - Connect to MQTT with LWT on `mur/home/esp/<id>/availability` payload `offline`
  - On connect: call `espBaseOnMosquittoConnect()`
- `loop()` first lines:
  - `ArduinoOTA.handle();`
  - any custom tick functions
  - `espBaseLoop();` (60 s heartbeat)
  - `if (!client.connected()) reconnect();`
  - `client.loop();`
- `callback(topic, payload, length)`:
  - `if (espBaseHandleMessage(topic, payload, length)) return;`
  - Custom topic handling (if any)

#### `Main.h`
- `#ifndef MAIN_H` / `#define MAIN_H` guards
- WiFi SSID + password (read from prompt or copy from existing reference sketch)
- MQTT credentials hardcoded:
  ```cpp
  const char* mqtt_server = "192.168.1.189";
  const char* mqtt_user   = "esp_boards";
  const char* mqtt_pass   = "<ESP_BOARDS_MQTT_PASS from .env>";
  ```
- Sketch identity:
  ```cpp
  const char* device_id      = "<board_id>";
  const char* sketch_name    = "<sketch_name>";
  const char* sketch_version = "v1";
  const char* build_ts       = __DATE__ " " __TIME__;
  #define OTA_PASSWORD       "<generated_or_user_input>"
  ```
- `EspParams` struct with fields matching parameter list from C3, with defaults
- ESP base topic Strings (built in `espBaseSetup()`):
  ```cpp
  String esp_avail_topic, esp_schema_topic, esp_status_topic;
  String esp_config_topic, esp_command_topic, esp_event_topic;
  ```

#### `Esp_Base.ino`
This is the BOARD-AGNOSTIC base block. Copy from `C:\Users\muroc\Arduino_Projects\RemoteXY_ESP8266_ver13\Esp_Base.ino` and adapt:
- **Schema JSON in PROGMEM** — generate from C3 + C4 inputs. Format as a single-line raw string `R"json(...)json"`. Include all parameters with full metadata + all actions.
- **EEPROM layout** — magic byte at `ESP_PARAMS_ADDR` (32). Pack scalar params in order. Strings get dedicated offsets (track explicitly). Bump magic when struct changes.
- **`loadEspParams` / `saveEspParams`** — generate read/write code per parameter (use `EEPROM.put(addr, val)` for ints, byte-by-byte for strings).
- **`espBaseSetup` / `espBaseOnMosquittoConnect` / `espBaseLoop`** — same as reference sketch, just adapt the schema/status field set.
- **`espBaseHandleMessage`** — handles `/config` (parses JSON, applies to esp_params, calls saveEspParams) and `/command` (routes by action key to user-defined handlers).
- **`publishEspStatus`** — JSON with `ip, rssi, uptime_s, free_heap, sketch_name, sketch_version, build_ts` PLUS any board-specific status fields the user wants surfaced (relays, sensor readings, etc.).
- **`publishEspEvent(kind, src, topic, payload)`** — for the Live MQTT tab.
- **`publishEspAck(action)`** — ack confirmation after commands.

For each user-declared command action, generate a handler stub (with `// TODO:` comments) that the user fills in.

### C7: Generate DB rows + .env entry

Generate SQL (do NOT execute yet — show to user for review):

```sql
-- Register in esp_boards (drives Project Boards page)
INSERT INTO esp_boards (id, name, mac, ota_password, enabled)
VALUES ('<id>', '<name>', '<mac or NULL>', '<ota_password>', true);

-- Companion row in devices (universal Devices page visibility)
INSERT INTO devices (id, name, vendor, device_type, protocol, mac, room, show_dashboard, poll_enabled)
VALUES ('<id>', '<name>', '<vendor: espressif>', 'esp_board', 'esp', '<mac or NULL>', '<room or NULL>', true, false);
```

Append to `BOILER/dashboard/.env`:
```
ESP_OTA_PASS_<ID_UPPER>=<ota_password>
```

After user approves, run:
1. `psql` query against LXC 102 (192.168.1.219, db `home_data`) — execute the SQL.
2. Append the `.env` line via Edit tool.
3. **No pm2 restart needed** — endpoints already loaded; first poll picks up the new row.

### C8: Final instructions

Tell the user:
1. **Open the new sketch in Arduino IDE**: `C:\Users\muroc\Arduino_Projects\<sketch_name>`. Required libraries: `PubSubClient`, `ArduinoJson`, `ArduinoOTA` (built-in), `EEPROM` (built-in), `ESP8266WiFi` or `WiFi`.
2. **Verify/Compile**. Fix any errors (most likely: missing libraries, `// TODO` handlers).
3. **USB-flash once** (subsequent updates flow via OTA from the dashboard).
4. **Open Project Boards** (`http://127.0.0.1:3000/esp-boards.html`) — the new board's tab appears within ~30 s of first MQTT publish.
5. Test the Doorlock / Robot / HiveMQ / custom action buttons via the Simulation sub-tab.

---

## UPDATE FLOW

### U1: Pick board

Query and list:
```sql
SELECT id, name, enabled, last_seen FROM esp_boards ORDER BY id;
```

User picks one.

### U2: Pick what to update

Options:
- **Name** — PATCH `/api/esp/boards/:id` with `{"name": "<new>"}`
- **Parameters** — POST `/api/esp/boards/:id/parameters` with the new key/value pairs (must match keys declared in board's published `board_schema`)
- **OTA password** — generate new + PATCH `/api/esp/boards/:id` with `{"ota_password": "<new>"}` + update `.env` `ESP_OTA_PASS_<ID_UPPER>`. **Warn**: must also update sketch's `OTA_PASSWORD` define + re-flash, or future OTA pushes break.
- **Enable / Disable** — PATCH with `{"enabled": <bool>}`. Disabled boards still ingest status but the dashboard greys them out.
- **Add new parameter / action** — sketch change required, not a runtime update. Modify `Esp_Base.ino` schema literal + EspParams struct (bump magic byte!) + re-flash.

### U3: Confirm + apply

Execute the chosen update via dashboard endpoint (`curl` against `127.0.0.1:3000`).

For sketch changes: edit files locally, then prompt user to compile + OTA-push.

---

## REMOVE FLOW

### R1: Confirm

```sql
SELECT id, name, enabled, last_seen FROM esp_boards;
```

User picks board to remove. Confirm deletion (this removes DB rows but does NOT erase the sketch on the board — it'll keep publishing to topics nobody listens to).

### R2: Apply

```sql
DELETE FROM devices WHERE id = '<id>';
DELETE FROM esp_boards WHERE id = '<id>';
```

Clear retained MQTT topics so dashboard doesn't show stale data:
```bash
ssh root@192.168.1.189 "
  for t in availability schema; do
    mosquitto_pub -u esp_boards -P '<from .env>' -t \"mur/home/esp/<id>/\$t\" -m '' -r
  done
"
```

Remove `.env` entry: delete the `ESP_OTA_PASS_<ID_UPPER>=...` line.

Tell user: physically power off / re-purpose the board to stop it from reconnecting and re-publishing under the same id.

---

## LIST FLOW

Run:
```sql
SELECT b.id, b.name, b.enabled,
       COALESCE(b.last_seen, nd.last_seen) AS last_seen,
       b.sketch_name, b.sketch_version,
       (b.last_status->>'rssi')::int AS rssi,
       (b.last_status->>'uptime_s')::int AS uptime_s,
       jsonb_array_length(COALESCE(b.board_schema->'parameters', '[]'::jsonb)) AS n_params,
       jsonb_array_length(COALESCE(b.board_schema->'actions', '[]'::jsonb)) AS n_actions
FROM esp_boards b
LEFT JOIN net_devices nd ON LOWER(nd.mac::text) = LOWER(b.mac::text)
ORDER BY b.id;
```

Render as markdown table. Highlight offline boards (last_seen NULL or > 180 s ago).

---

## Constants / paths to know

- **Broker**: 192.168.1.189 (LXC 107) — MQTT plain on port 1883, WebSocket on 9001
- **DB**: 192.168.1.219 (LXC 102) — PostgreSQL `home_data`, user `postgres` (trust auth from 192.168.1.0/24)
- **Rule engine**: 192.168.1.187 (LXC 105) — ingests `mur/home/esp/+/+`
- **Dashboard**: `http://127.0.0.1:3000` (Windows pm2)
- **Reference sketch**: `C:\Users\muroc\Arduino_Projects\RemoteXY_ESP8266_ver13\`
- **espota.py paths**:
  - ESP8266: `C:\Users\muroc\AppData\Local\Arduino15\packages\esp8266\hardware\esp8266\<ver>\tools\espota.py` (port 8266)
  - ESP32: `C:\Users\muroc\AppData\Local\Arduino15\packages\esp32\hardware\esp32\<ver>\tools\espota.py` (port 3232)
- **MAC of existing RemoteXY board**: `ec:64:c9:cd:da:80` (don't re-use)
- **Existing board IDs in use**: query `SELECT id FROM esp_boards;` to avoid collisions

## Important rules

- **NEVER** commit secrets to git. `.env` is gitignored — verify before saving.
- **NEVER** create a new MQTT user per board. The single `esp_boards` user serves all boards by ACL convention (`mur/home/esp/+/#`).
- **NEVER** flash without USB once before relying on OTA — first flash establishes the OTA listener.
- **EEPROM magic byte must change** whenever the EspParams struct changes shape (add/remove/reorder fields). Bump `ESP_PARAMS_MAGIC` in `Esp_Base.ino` so old saves don't load garbage into the new layout.
- **MQTT buffer size**: `setBufferSize(N)` where N must hold the schema JSON + topic + framing (~35 bytes overhead). Schema can grow fast — start with 4096; bump if you add many parameters/actions.
- **Board ID regex** is enforced server-side AND in rule engine. Validate before generating any code.
- **Architecture invariant**: dashboard owns config CRUD (parameters / ota_password / enabled), rule engine on LXC 105 is the SOLE writer of `last_status` / `last_seen` / `board_schema`. Don't violate this.
- **Float values in `/status` JSON**: when the board's `publishEspStatus` includes float sensor readings (temp / humidity / RSSI / battery_voltage / etc.), format with explicit precision (`Serial.printf("%.1f", val)` / equivalent) — DO NOT publish full IEEE 754 precision. Otherwise downstream consumers (HASP `_fmt`, Awtrix `_fmt_awtrix`, Pixoo render screens) carry sensor noise into dedupe loops + ugly long display strings. See [Float rounding feedback](../../projects/c--Users-muroc-project-home/memory/feedback_float_rounding.md) for the project-wide rule.

After completing the flow, briefly remind the user the next concrete action (compile + flash, or just refresh the dashboard).
