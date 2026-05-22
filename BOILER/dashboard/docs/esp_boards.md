# ESP Boards — Onboarding Cookbook

How to add a new ESP8266 or ESP32 board to the **Project Boards** dashboard
page so it appears with status, parameter editing, test buttons, and OTA
firmware push.

## Topic convention (every board uses these)

`<id>` is the board's unique identifier — must match `^[a-zA-Z][a-zA-Z0-9_-]*$`.

| Topic | Direction | Payload | Notes |
|---|---|---|---|
| `mur/home/esp/<id>/availability` | board → broker | `online` / `offline` | retained |
| `mur/home/esp/<id>/schema` | board → broker | JSON `{parameters:[...], actions:[...]}` | retained, published once on every Mosquitto connect |
| `mur/home/esp/<id>/status` | board → broker | JSON `{ip, rssi, uptime_s, free_heap, sketch_name, sketch_version, build_ts}` | every 60 s |
| `mur/home/esp/<id>/config` | broker → board | JSON `{key1: val1, ...}` | board parses, updates struct, persists to EEPROM |
| `mur/home/esp/<id>/command` | broker → board | plain string `<action_key>` | board routes by key |
| `mur/home/esp/<id>/event` | board → broker | JSON `{kind:'ack', action:'<key>'}` etc. | optional |

## Schema payload shape

```json
{
  "parameters": [
    {"key": "door_lock_ms", "type": "int", "default": 500, "min": 100, "max": 10000, "persistent": true, "description": "Doorlock relay engaged duration (ms)"}
  ],
  "actions": [
    {"key": "open_doorlock", "label": "Open Doorlock", "description": "Trigger relay"}
  ]
}
```

The dashboard renders one form input per `parameters[]` entry (type-aware:
`int`/`float`/`text`/`bool`) and one button per `actions[]` entry. Action
keys in the destructive set (`reset_wifi`/`clear_eeprom`/`restart`/`factory_reset`)
get a confirm dialog before sending.

## Adding a new board — step by step

### 1. Sketch side

Reference sketches:
- ESP8266: `C:\Users\muroc\Arduino_Projects\RemoteXY_ESP8266_Claude\` (full HiveMQ-bridge example)
- ESP32-C3: `C:\Users\muroc\Arduino_Projects\My_Bathroom_Smell_6\` (minimal Mosquitto-only example with AUTO-cycle pump state machine)

Copy the appropriate `Esp_Base.ino` into your new sketch folder (Arduino IDE
merges all `.ino` files in the folder before compiling). Then in your `Main.h`:

- Set `device_id` to your unique board ID (must match the regex above).
- Set `sketch_name`, `sketch_version` constants.
- Set `OTA_PASSWORD` define to the shared OTA password (see "Required server-side config" below).
- Set `mqtt_server_moskuitto = "192.168.1.189"`,
  `mqtt_user_moskuitto = "esp_boards"`, and `mqtt_pass_moskuitto` to the
  shared `esp_boards` mosquitto password (stored in
  `BOILER/dashboard/.env` as `ESP_BOARDS_MQTT_PASS`).
- Define your `EspParams` struct fields and tweak defaults as needed.
- Edit the `ESP_SCHEMA_JSON` literal in `Esp_Base.ino` to declare your
  parameters + actions.

In your main `.ino`:

- `#include <ArduinoOTA.h>` near the top.
- Add forward decls for `espBaseSetup`, `espBaseOnMosquittoConnect`,
  `espBaseLoop`, `espBaseHandleMessage`.
- Call `espBaseSetup()` once in `setup()` after Wi-Fi is up.
- Call `ArduinoOTA.handle()` + `espBaseLoop()` at the top of `loop()`.
- Call `espBaseOnMosquittoConnect()` in your Mosquitto reconnect success path.
- Early-return in your MQTT callback if `espBaseHandleMessage(topic, payload, length)` returns true.

### 2. Build + flash via USB once

USB flash is required ONLY this first time. After this, all updates flow
over WiFi via the Project Boards dashboard's OTA sub-tab.

### 3. Register the board in the DB

Two rows: one in `esp_boards` (drives the Project Boards page), one in
`devices` (drives the universal Device Agent page).

```sql
-- esp_boards row. ota_password column is normally left NULL — server.js
-- falls back to the shared ESP_OTA_PASSWORD env var. Set the column only
-- if you want a per-board override.
INSERT INTO esp_boards (id, name, mac, enabled)
VALUES ('my_board_01', 'My Board', '<mac-addr>', true);

-- devices row (so the board appears on the Devices page with status dot)
INSERT INTO devices (id, name, vendor, device_type, protocol, mac, room, show_dashboard, poll_enabled)
VALUES ('my_board_01', 'My Board', 'espressif', 'esp_board', 'esp', '<mac-addr>', 'Hallway', true, false);
```

The `mac` column on both rows enables a LEFT JOIN to `net_devices` so live
IP and last-seen flow in from the ARP scanner (5-min cadence).

### 4. Reload the dashboard

Open `http://127.0.0.1:3000/esp-boards.html` — the board appears as a tab.
The status dot updates within ~60 s of the board's first MQTT publish.

### 5. Future updates — wireless via dashboard

1. Edit your sketch in Arduino IDE.
2. Build (don't upload).
3. Open the Project Boards page. Above the board-tab bar there's a single
   page-level **OTA Push** card with a target-board dropdown — it
   auto-syncs to whichever board tab is currently active, but you can
   pick any board manually.
4. Drag the `.bin` file (typically at
   `%LOCALAPPDATA%\Temp\arduino\sketches\<hash>\<sketch>.ino.bin`)
   onto the drop zone, or click to browse.
5. The dashboard spawns `espota.py` with the shared OTA password; the
   board reboots into the new firmware on success.

### 6. (Optional) Make the board addressable from rules

If you want rules to be able to fire actions on this board (e.g. "when
presence in bathroom → @My Bathroom Smell on"), populate the `devices`
row's `dps_labels` and `dps_config`:

```sql
UPDATE devices SET
  dps_labels = '{"auto_enabled":"AUTO Cycle","pump_state":"Pump"}'::jsonb,
  dps_config = '{
    "auto_enabled": {"name":"AUTO Cycle","enabled":true,"show_dashboard":true,
                     "action_on":"smell_auto_start","action_off":"smell_auto_stop"},
    "pump_state":   {"name":"Pump","enabled":true,"show_dashboard":true}
  }'::jsonb
WHERE id = 'my_board_01';
```

What this gives you:

- **`dps_labels`**: declares which `/status` payload fields are
  user-visible on the Devices page. Only labeled fields appear; unlabeled
  ones (like `auto_phase`, `manual_active`) stay internal.
- **`dps_config.<channel>.action_on` / `action_off`**: declares which
  sketch action key to publish to `mur/home/esp/<id>/command` when a
  rule says `turn_on` / `turn_off`. Channels without an action mapping
  (like `pump_state` above) are read-only — visible on dashboard, not
  controllable from rules.

The rule engine on LXC 105 then:

- Projects the listed status fields into `devices.last_state` so rules
  can read e.g. `state.devices['my_board_01']['dps']['pump_state']`.
- Routes `{action: 'turn_on', device_id: 'my_board_01'}` through
  `_resolve_esp_action()` to the matching `action_on` (channel-aware,
  with single-channel fallback so `@My Board on` works without a
  channel suffix).

For the device to **show on/off buttons in the rule sentence picker**
(`+Dev` modal), at least one channel must have `action_on` or
`action_off`. The picker auto-detects this and renders the buttons —
single actionable channel → plain "label: on/off" buttons + short token
`@Name on`; multiple → channel-prefixed buttons + suffixed token
`@Name <channel> on`. No picker code change per board.

If the board's `/status` payload publishes a status field that's not yet
listed in `_ESP_STATUS_DPS_FIELDS` (in `RULES/rule_engine.py`), add it
there so the projection picks it up. Current set: `pump_state`,
`auto_enabled`, `auto_phase`, `manual_active`, `door_relay`, `charge_relay`.

## Required broker / ACL setup

These are **one-time per project**, not per board (single shared
`esp_boards` mosquitto user serves all boards):

```
# On LXC 107:
mosquitto_passwd -b /etc/mosquitto/passwd esp_boards '<your-shared-password>'

# Append to /etc/mosquitto/acl:
user esp_boards
topic readwrite mur/home/esp/+/#
topic readwrite homeassistant/sensor/+/#
topic readwrite tele/+/LWT
topic read HOME_REQUEST

# Inside the existing rule_engine block, add this line:
topic readwrite mur/home/esp/+/#

systemctl reload mosquitto
```

The `homeassistant/sensor/+/#` and `tele/+/LWT` permissions in the ACL
are legacy carry-overs for boards (like `remoteXY_01`) that also publish
HA-style discovery topics. Remove if your board doesn't need them.

## Required server-side config

`BOILER/dashboard/.env`:

```
ESP_BOARDS_MQTT_PASS=<your-shared-mosquitto-password>
ESP_OTA_PASSWORD=<your-shared-OTA-password>                # ONE value, all boards
ESP8266_OTA_PY=C:\...\packages\esp8266\hardware\esp8266\<ver>\tools\espota.py
ESP32_OTA_PY=C:\...\packages\esp32\hardware\esp32\<ver>\tools\espota.py
```

`ESP_OTA_PASSWORD` is shared across every board (since 2026-05-03) — same
philosophy as the shared `esp_boards` MQTT user. Each sketch bakes the
same value into its `OTA_PASSWORD` define. `server.js` reads this env
var as the fallback OTA password whenever `esp_boards.ota_password` is
NULL (which is the normal state). Per-board override is still possible
by setting the column explicitly.

`ESP_OTA_PASSWORD` must also be listed in the `env:` block of
`BOILER/dashboard/ecosystem.config.js` so pm2 picks it up — same pattern
as the other secret env vars. **After adding any new env var, restart
pm2 with `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`
(NEVER `pm2 restart` — caches the old environment).**

Legacy `ESP_OTA_PASS_<BOARD_ID_UPPER>` entries (one per board) are still
supported for back-compat — if the per-board column carries a value, it
overrides the env var. Existing boards (e.g. `remoteXY_01`) continue to
work without re-flashing as long as their column matches the value baked
into the sketch.

## Architecture notes

- **Sole MQTT user**: `esp_boards`. Adding boards does NOT require new
  ACL or mosquitto users.
- **Sole writer of `esp_boards.last_*` columns + `board_schema`**: the
  rule engine on LXC 105 (`_handle_esp_message` in `rule_engine.py`).
  Dashboard owns config CRUD only (parameters / ota_password / enabled).
- **Variant resolution for OTA**: `ESP8266_OTA_PY` is the default;
  `ESP32_OTA_PY` is used if `last_status.sketch_name` contains "esp32"
  or the dashboard sends `?chip=esp32` query param.
- **Board IDs**: must match `^[a-zA-Z][a-zA-Z0-9_-]*$` — leading
  underscore or digit is rejected by both the dashboard endpoints and the
  rule engine ingest.
