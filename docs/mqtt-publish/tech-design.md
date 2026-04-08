# Tech Design: MQTT Publish (Device Agent)

**Discovery:** [discovery.md](discovery.md)
**Date:** 2026-04-08
**Status:** Implemented

## 1. Summary

Add MQTT publishing to Device Agent so every device state change, availability update, and daily config snapshot is broadcast to the Mosquitto broker on LXC 107. This creates the real-time event bus that the future Rule Engine (LXC 105) will subscribe to. The implementation adds a reusable `MqttPublisher` helper class and hooks into the existing `on_state_change()` flow with zero changes to adapter code.

### Non-Goals
- Rule Engine implementation (future)
- MQTT publishing for Boiler/Media/Voice agents (will reuse `MqttPublisher` later)
- Dashboard MQTT integration (dashboard continues reading from DB)
- Mosquitto TLS (acceptable on trusted LAN)
- Creating Rule Engine MQTT user (deferred)

## 2. Current Behavior

Device Agent runs on LXC 103. Five adapters (Tuya TCP, Tuya Cloud, Tuya Push, HA WebSocket, Home Connect SSE) call `on_state_change(device_id, dps, source)` on every state change. This method acquires `_db_lock`, writes to `devices` table (UPDATE last_state), optionally inserts into `device_events` (if not dedup'd), and releases the lock. No outbound messaging exists — all consumers poll PostgreSQL.

Full details in [discovery.md](discovery.md).

## 3. To-Be Behavior

### System Flow

1. Device Agent starts → connects to MQTT broker with LWT → publishes bridge online + full device inventory
2. Adapter detects state change → calls `on_state_change()`
3. `on_state_change()` acquires `_db_lock` → writes DB → publishes to MQTT:
   - `mur/home/device/{id}/state` (retained, full merged state) — always
   - `mur/home/device/{id}/event` (transient, changed DPS only) — only if not dedup'd
4. Every 180s, availability check publishes online/offline per device
5. At midnight daily, full device inventory + room mappings republished
6. On shutdown → MQTT LWT fires → `_bridge/state` → offline

### MQTT Message Flow

```
Adapter threads ──► on_state_change()
                        │
                        ├─► DB write (existing)
                        │
                        ├─► MQTT: mur/home/device/{id}/state     (retained, full state)
                        ├─► MQTT: mur/home/device/{id}/event     (transient, if not dup)
                        │
                   [periodic]
                        ├─► MQTT: mur/home/device/{id}/availability  (retained, 180s check)
                        ├─► MQTT: mur/home/device/_bridge/state      (retained, heartbeat)
                        └─► MQTT: mur/home/device/_bridge/devices    (retained, daily)
```

## 4. Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| MQTT library | paho-mqtt | asyncio mqtt, gmqtt | paho is the standard, thread-safe `publish()`, built-in reconnect via `loop_start()` |
| Publish location | Inside `on_state_change()` after DB write, under `_db_lock` | Outside lock, separate queue | Inside lock preserves event ordering. QoS 0 publish is non-blocking (~microseconds) |
| State payload | Full merged `last_state` from DB UPDATE result | Changed DPS only | Rule Engine gets complete picture on subscribe without maintaining its own merge |
| Event payload | Changed DPS + device_id only, no metadata | Include name/room/type | Rule Engine has device→room in memory (loaded daily). Keep events lean for speed |
| Availability detection | Periodic 180s scan of `last_seen` | Adapter disconnect callbacks | Consistent across all protocols. Adapters don't all support disconnect detection |
| Config/room refresh | Daily at midnight + on startup | 30s polling of `updated_at` | Rooms are physical, rarely change. Daily is sufficient per user requirement |
| Credential storage | `/etc/environment` on LXC 103 | Separate env file | Same pattern as HA_TOKEN, TUYA keys. One file for all agents |
| MQTT helper | Separate `MqttPublisher` class in `adapters/mqtt_publisher.py` | Inline in DeviceAgent | Reusable for Boiler/Media agents later. Clean separation of concerns |
| Dedup alignment | MQTT `event` follows same dedup as DB `device_events` | Independent dedup | Consistent: if it's in the DB, it's on MQTT. No divergence |
| QoS | 0 for state/event, 1 for availability/bridge | All QoS 0 | State has retained fallback. Availability/bridge are critical + low-frequency |
| Native MQTT devices | Device Agent subscribes to `hasp/#`, `awtrix/#`, `zigbee2mqtt/#` — writes all events to DB, republishes to `mur/home/device/` | Rule Engine subscribes directly to native topics | Every event must be recorded in DB for future LLM analysis of user behavior to improve rules. Universal ingest through Device Agent ensures consistent history |
| DIY devices | Publish to `mur/home/device/{id}/ingest` — Device Agent picks up, writes DB, republishes to `state`/`event` | Publish directly to `state` | Going through Device Agent gives free DB history, dedup, dashboard visibility |
| Topic prefix | `mur/home/` | `home/`, `ph/`, `agent/` | Unique, personal, no conflicts with any standard convention |

## 5. Interfaces / Models

```python
# DEVICE/agent/adapters/mqtt_publisher.py

class MqttPublisher:
    """Reusable MQTT publisher with LWT, auto-reconnect, and retained state."""

    def __init__(self, broker: str, port: int, username: str, password: str,
                 client_id: str, lwt_topic: str):
        """
        broker     — Mosquitto host (e.g. '192.168.1.189')
        port       — Mosquitto port (default 1883)
        username   — MQTT username (e.g. 'device_agent')
        password   — MQTT password
        client_id  — unique client ID (e.g. 'device-agent-103')
        lwt_topic  — Last Will topic (e.g. 'mur/home/device/_bridge/state')
        """

    def connect(self):
        """Connect to broker, set LWT, start threaded network loop."""

    def publish(self, topic: str, payload: dict, retain: bool = False, qos: int = 0):
        """Publish JSON payload to topic. Non-blocking, fire-and-forget."""

    def publish_bridge_online(self, device_count: int, adapter_count: int):
        """Publish bridge state as online with device/adapter counts."""

    def publish_device_state(self, device_id: str, full_state: dict, source: str):
        """Publish full merged state to mur/home/device/{id}/state (retained)."""

    def publish_device_event(self, device_id: str, dps: dict, source: str):
        """Publish changed DPS to mur/home/device/{id}/event (transient)."""

    def publish_availability(self, device_id: str, online: bool, last_seen: str):
        """Publish online/offline to mur/home/device/{id}/availability (retained, QoS 1)."""

    def publish_inventory(self, devices: list[dict]):
        """Publish full device list to mur/home/device/_bridge/devices (retained)."""

    def disconnect(self):
        """Stop network loop and disconnect. LWT fires automatically if not called."""

    @property
    def is_connected(self) -> bool:
        """Return True if MQTT client is currently connected."""
```

### MQTT Payloads

```json
// mur/home/device/{device_id}/state (retained)
{
  "dps": {"1": true, "2": false, "18": 0},
  "source": "tcp_push",
  "ts": "2026-04-08T10:30:15+03:00"
}

// mur/home/device/{device_id}/event (transient)
{
  "device_id": "bf63c2785492f2c15agnmi",
  "dps": {"1": true},
  "source": "tcp_push",
  "ts": "2026-04-08T10:30:15+03:00"
}

// mur/home/device/{device_id}/availability (retained, QoS 1)
{
  "online": true,
  "last_seen": "2026-04-08T10:30:15+03:00"
}

// mur/home/device/_bridge/state (retained, QoS 1, LWT = {"state":"offline"})
{
  "state": "online",
  "devices": 89,
  "adapters": 5,
  "ts": "2026-04-08T10:30:15+03:00"
}

// mur/home/device/_bridge/devices (retained)
[
  {
    "id": "bf63c2785492f2c15agnmi",
    "name": "Kitchen Presence",
    "room": "Kitchen",
    "device_type": "presence",
    "protocol": "local",
    "vendor": "tuya"
  },
  ...
]
```

## 6. Implementation Details

### Component 1: MqttPublisher helper class

- **File:** `DEVICE/agent/adapters/mqtt_publisher.py` (new)
- **Changes:** New file — reusable MQTT wrapper
- **Details:**
  - `__init__()`: create `paho.mqtt.client.Client`, set LWT (`mur/home/device/_bridge/state` → `{"state":"offline"}` retained QoS 1), set username/password, set `on_connect`/`on_disconnect` callbacks for logging
  - `connect()`: call `client.connect_async(broker, port)` + `client.loop_start()`. Non-blocking — if broker is down, paho retries automatically
  - `publish()`: call `client.publish(topic, json.dumps(payload), retain, qos)`. If not connected, silently drops (QoS 0 = fire-and-forget). Log warning on first drop, not every drop
  - `on_connect` callback: log "MQTT connected", publish bridge online state
  - `on_disconnect` callback: log "MQTT disconnected, reconnecting"
  - `disconnect()`: call `client.loop_stop()` + `client.disconnect()`
  - All timestamps in ISO8601 with Asia/Jerusalem timezone

### Component 2: DeviceAgent MQTT integration

- **File:** `DEVICE/agent/device_agent.py` (modify)
- **Changes:**
  - Import `MqttPublisher` and `os`
  - Add MQTT config constants from env vars at module level:
    ```python
    MQTT_BROKER = os.environ.get('MQTT_BROKER', '192.168.1.189')
    MQTT_PORT   = int(os.environ.get('MQTT_PORT', '1883'))
    MQTT_USER   = os.environ.get('MQTT_USER', 'device_agent')
    MQTT_PASS   = os.environ.get('MQTT_PASS', '')
    ```
  - `__init__()`: create `MqttPublisher` instance, call `connect()`
  - `_db_write()`: after the existing DB UPDATE, call `self._mqtt.publish_device_state()` with full merged state. After the non-dup INSERT, call `self._mqtt.publish_device_event()`
  - `run()`: after loading devices and starting adapters, call `self._mqtt.publish_inventory(devices)`. Start availability checker thread
  - `shutdown()`: call `self._mqtt.disconnect()` before closing DB

- **Extract — `_publish_state()`:**
  ```python
  def _publish_state(self, device_id: str, dps: dict, source: str, is_dup: bool):
      """Publish state and event to MQTT. Called under _db_lock after DB write."""
  ```
  Location: `DeviceAgent` class, called from `_db_write()` at the end.

- **Extract — `_availability_loop()`:**
  ```python
  def _availability_loop(self):
      """Periodic thread: check last_seen for all devices, publish availability."""
  ```
  Location: `DeviceAgent` class, started as daemon thread from `run()`. Runs every 180s, queries `SELECT id, last_seen FROM devices WHERE enabled = true`, publishes online/offline for each device.

- **Extract — `_daily_refresh()`:**
  ```python
  def _daily_refresh(self):
      """Thread: at midnight, republish full inventory + room mappings."""
  ```
  Location: `DeviceAgent` class, started as daemon thread from `run()`. Sleeps until next midnight, then re-queries devices with rooms and publishes to `_bridge/devices`.

- **Extract — `_config_poll_loop()`:**
  ```python
  def _config_poll_loop(self):
      """Thread: every 30s, check for enable/disable changes and publish."""
  ```
  Location: `DeviceAgent` class, started as daemon thread from `run()`. Every 30s:
  - Queries `SELECT id, enabled FROM devices WHERE updated_at > %s` — if device disabled, publish availability offline; if re-enabled, republish inventory.
  - Queries `SELECT id FROM devices WHERE created_at > %s AND enabled = true` — if new device found, republish inventory to `_bridge/devices`. Actual state tracking (adapter connection) requires agent restart; inventory update is immediate.

### Component 3: Universal MQTT ingest (DIY + HASP + Awtrix + Zigbee)

- **File:** `DEVICE/agent/device_agent.py` (modify)
- **Changes:** Device Agent subscribes to multiple MQTT topic trees. All incoming events flow through `on_state_change()` → DB write + republish to `mur/home/device/{id}/state` and `event`.
- **Subscriptions:**
  ```
  mur/home/device/+/ingest   ← DIY devices
  hasp/+/state               ← openHASP plate status
  hasp/+/state/+             ← openHASP object states (buttons, sliders)
  awtrix/+/stats             ← Awtrix display status
  zigbee2mqtt/+              ← Zigbee device state (not bridge topics)
  ```
- **Details:**
  - `MqttPublisher` adds `subscribe()` + `on_message` callback
  - `on_message` callback routes by topic prefix:
    - `mur/home/device/+/ingest` → extract device_id from topic, source = `'mqtt'`
    - `hasp/+/...` → map node name to device_id, source = `'hasp'`
    - `awtrix/+/...` → map uid to device_id, source = `'awtrix'`
    - `zigbee2mqtt/+` → map friendly_name to device_id, source = `'zigbee'`
  - Each device must exist in `devices` table with appropriate `protocol` (`mqtt`, `hasp`, `awtrix`, `zigbee`)
  - If device unknown, log warning and skip
  - All events written to `device_events` — every touch, button press, state change recorded for future LLM analysis

### Component 4: Mosquitto ACL + users setup

- **Target:** LXC 107 (192.168.1.189)
- **Changes:**
  - Create new Mosquitto users: `hasp`, `awtrix`
  - Create `/etc/mosquitto/acl` file
  - Add `acl_file /etc/mosquitto/acl` to `/etc/mosquitto/conf.d/acl.conf`
  - Restart Mosquitto

- **Full MQTT topic map (all device types on single broker):**
  ```
  mur/home/device/{id}/state       ← Device Agent (Tuya, BSH, DIY)
  mur/home/device/{id}/event       ← Device Agent
  mur/home/device/{id}/availability ← Device Agent
  mur/home/device/{id}/ingest      ← DIY devices publish here → Device Agent consumes
  mur/home/device/_bridge/state    ← Device Agent (LWT)
  mur/home/device/_bridge/devices  ← Device Agent (inventory)
  mur/home/boiler/...              ← Boiler Agent (future)
  mur/home/media/...               ← Media Agent (future)
  hasp/{node}/...                  ← openHASP plates (native, ~10 devices)
  awtrix/{id}/...                  ← Awtrix displays (native)
  zigbee2mqtt/...                  ← Zigbee2MQTT (native)
  ```

- **Mosquitto users + ACLs (`/etc/mosquitto/acl`):**
  ```
  # Zigbee2MQTT
  user zigbee
  topic readwrite zigbee2mqtt/#

  # Device Agent — publish to mur/home, subscribe to all for universal ingest
  user device_agent
  topic readwrite mur/home/device/#
  topic read zigbee2mqtt/#
  topic read hasp/#
  topic read awtrix/#

  # openHASP plates
  user hasp
  topic readwrite hasp/#

  # Awtrix displays
  user awtrix
  topic readwrite awtrix/#
  ```

### Component 4: Environment setup on LXC 103

- **Target:** LXC 103 (192.168.1.114)
- **Changes:** Add to `/etc/environment`:
  ```
  MQTT_BROKER=192.168.1.189
  MQTT_USER=device_agent
  MQTT_PASS=da_pass_107
  ```
- **Also:** Install paho-mqtt in device-agent venv:
  ```bash
  /opt/device-agent/venv/bin/pip install paho-mqtt
  ```

## 7. Config / Segmentation Plan

| Key | Type | Default | Location | Notes |
|-----|------|---------|----------|-------|
| `MQTT_BROKER` | string | `192.168.1.189` | `/etc/environment` on LXC 103 | Mosquitto broker IP |
| `MQTT_PORT` | int | `1883` | `/etc/environment` on LXC 103 | Mosquitto port |
| `MQTT_USER` | string | `device_agent` | `/etc/environment` on LXC 103 | MQTT username |
| `MQTT_PASS` | string | (none) | `/etc/environment` on LXC 103 | MQTT password |

## 8. BI Event Spec

N/A — no analytics events. MQTT topics serve as the event bus.

## 9. Error Handling & Edge Cases

| Scenario | Handling | Fallback |
|----------|----------|----------|
| MQTT broker down at startup | `connect_async()` + `loop_start()` — paho retries in background | DB writes continue normally, MQTT publishes silently dropped |
| MQTT broker goes down mid-operation | paho auto-reconnects. On reconnect, `on_connect` callback re-publishes bridge online + inventory | Events during disconnect are lost (QoS 0). Retained state is re-published on reconnect |
| MQTT publish fails | QoS 0 = fire-and-forget, no exception. Log warning on first disconnect | DB is source of truth, MQTT is best-effort |
| Device goes offline (last_seen > 180s) | Availability loop publishes `{"online": false}` to retained topic | Rule Engine sees offline status immediately |
| Device Agent restarts | All retained topics still on broker. On startup: publishes fresh inventory + state for all devices | Rule Engine has stale-but-valid retained messages during restart gap, refreshed within seconds |
| New device added | Config poll detects `created_at > last_check` within 30s, republishes inventory | Device visible in MQTT inventory immediately. State tracking requires agent restart (adapters not hot-loaded) |
| New DPS key appears | Already handled — `on_state_change()` receives any DPS, DB merges via `\|\|`, MQTT publishes full merged state | No action needed |
| Keepalive events (Home Connect) | Skipped — `source == 'keepalive'` returns early before MQTT publish | Only DB `last_seen` is touched |
| `MQTT_PASS` not set in env | `MqttPublisher` logs error, does not connect. All publishes silently dropped | Agent runs normally without MQTT |
| Mosquitto ACL blocks a publish | paho QoS 0 doesn't report ACL failures | Check Mosquitto log for denied messages |

## 10. Rollout Plan

- **Phase 1:** Deploy MqttPublisher + ACLs. Verify with `mosquitto_sub` that messages flow.
- **Phase 2:** Monitor for 24h — check Mosquitto log for errors, Device Agent log for warnings.
- **Rollback:** Remove MQTT env vars from `/etc/environment`, restart device-agent. Agent runs without MQTT (publish calls silently drop when no password configured).

## 11. Test Plan

### Manual Checklist
- [ ] Device Agent starts with MQTT broker down — no crash, DB works
- [ ] Device Agent starts with MQTT broker up — bridge online published
- [ ] Toggle a switch → `state` and `event` topics receive correct payload
- [ ] Toggle same switch again quickly → dedup: `state` updates, `event` skipped
- [ ] Wait 180s → availability published for all devices
- [ ] Kill Mosquitto → Device Agent continues, reconnects when Mosquitto restarts
- [ ] Kill Device Agent → LWT fires, `_bridge/state` shows offline
- [ ] Restart Device Agent → inventory republished, retained states refreshed
- [ ] Check midnight → daily inventory refresh published
- [ ] Disable a device in dashboard → within 30s, config poll detects it
- [ ] Verify ACLs: `zigbee` user cannot publish to `mur/home/#`, `device_agent` cannot publish to `zigbee2mqtt/#`

### Verification Command
```bash
# On LXC 107 — subscribe to all device topics
mosquitto_sub -h localhost -u device_agent -P da_pass_107 -t 'mur/home/device/#' -v
```

## 12. Ordered Task List

1. **Create MqttPublisher helper class** → New file `DEVICE/agent/adapters/mqtt_publisher.py`. Implements connect, publish, LWT, reconnect callbacks. Acceptance: class instantiates, connects to broker, publishes test message.

2. **Integrate MQTT into DeviceAgent** → Modify `DEVICE/agent/device_agent.py`. Add MQTT config from env vars, create MqttPublisher in `__init__`, publish state/event in `_db_write()`, publish inventory in `run()`, disconnect in shutdown. Acceptance: on_state_change publishes to MQTT after DB write.

3. **Add availability checker thread** → Add `_availability_loop()` to `DEVICE/agent/device_agent.py`. Queries `last_seen` every 180s, publishes online/offline per device. Acceptance: devices not seen for 180s get `{"online": false}` on availability topic.

4. **Add daily inventory refresh thread** → Add `_daily_refresh()` to `DEVICE/agent/device_agent.py`. Sleeps until midnight, republishes full device list with rooms. Acceptance: at midnight, `_bridge/devices` topic updated with current devices+rooms.

5. **Add config change polling thread** → Add `_config_poll_loop()` to `DEVICE/agent/device_agent.py`. Every 30s checks `updated_at` for enable/disable changes and `created_at` for new devices. New devices trigger inventory republish (actual state tracking requires agent restart). Disabling a device publishes availability offline. Acceptance: new device appears in `_bridge/devices` within 30s; disabled device gets offline availability.

6. **Add universal MQTT ingest** → Device Agent subscribes to `mur/home/device/+/ingest`, `hasp/+/state`, `hasp/+/state/+`, `awtrix/+/stats`, `zigbee2mqtt/+`. Routes by topic prefix, maps to device_id, calls `on_state_change()` with source `mqtt`/`hasp`/`awtrix`/`zigbee`. All events recorded in DB for LLM analysis. Acceptance: HASP button press → device_events row + `mur/home/device/{id}/event` published.

7. **Setup Mosquitto ACLs + users on LXC 107** → Create users `hasp`, `awtrix`. Create `/etc/mosquitto/acl` with per-user topic restrictions. Acceptance: each user can only access its own topic tree.

8. **Deploy and configure LXC 103** → Install paho-mqtt in venv, add MQTT env vars to `/etc/environment`, deploy files, restart device-agent. Acceptance: `mosquitto_sub` shows live device state messages.

## 13. Open Items / Follow-ups

- [ ] Add MQTT publishing to Boiler Agent (reuse MqttPublisher, topic: `mur/home/boiler/...`)
- [ ] Add MQTT publishing to Media Agent (reuse MqttPublisher, topic: `mur/home/media/...`)
- [ ] Build Rule Engine on LXC 105 (subscribes to `mur/home/#` + `hasp/#` + `awtrix/#` + `zigbee2mqtt/#`)
- [ ] Create `rule_engine` Mosquitto user + ACL when Rule Engine is built
- [ ] Migrate openHASP plates from HA MQTT to LXC 107 Mosquitto (change broker IP on each plate)
- [ ] Migrate Awtrix displays from HA MQTT to LXC 107 Mosquitto
- [ ] Add MQTT status indicator to dashboard Project Health page
- [ ] Consider Mosquitto TLS if agents move to untrusted network
