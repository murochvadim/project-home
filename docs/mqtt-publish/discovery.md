# Discovery: MQTT Publish (Device Agent)

**Description:** Add MQTT publishing to Device Agent so all device state changes, room assignments, and config updates are broadcast via MQTT for the future Rule Engine.
**Date:** 2026-04-08
**Status:** Draft

## 1. Goal

Enable the Device Agent (LXC 103) to publish all device state changes, online/offline transitions, room assignments, and config updates to the Mosquitto MQTT broker (LXC 107). This provides a real-time event bus that the future Rule Engine (LXC 105) and other agents can subscribe to without polling the database. The Device Agent is the first agent to get MQTT publishing; others (Boiler, Media, Voice) will follow the same pattern later, so the topic naming convention must be designed for multi-agent use from day one.

## 2. Current Behavior

Today the Device Agent runs on LXC 103 as a long-lived systemd service (`device-agent.service`). On startup it loads all enabled devices from the `devices` table, groups them by vendor/protocol, and starts one adapter per group. Each adapter runs in its own thread(s) and calls `on_state_change(device_id, dps, source)` whenever a device reports new state. This callback acquires `_db_lock`, deduplicates the event, writes `last_state` to the `devices` table, and inserts a row into `device_events`. There is no outbound messaging of any kind -- all state is stored in PostgreSQL and consumed by polling (dashboard reads DB directly, Boiler Agent reads `raw_data` from a separate ha_to_pg pipeline).

### Data Flow

```
Adapter threads (tuya TCP, tuya cloud, tuya push, HA WebSocket, Home Connect SSE)
    │
    ▼
on_state_change(device_id, dps, source)   ← single entry point, thread-safe via _db_lock
    │
    ├─► UPDATE devices SET last_state = ..., last_seen = NOW(), last_source = ...
    │
    └─► INSERT INTO device_events (device_id, ts, dps, source)   ← only if not dedup'd
```

Room assignments and config changes (name, room, enabled, channel_config, dps_labels, dps_config) are made via the dashboard `PATCH /api/devices/:id` endpoint, which writes directly to PostgreSQL. The Device Agent is not notified of these changes.

### Code Locations

| Component | File | Purpose |
|-----------|------|---------|
| Device Agent main | `DEVICE/agent/device_agent.py` | Core agent: loads devices, starts adapters, on_state_change, _db_write, run/shutdown |
| Base adapter | `DEVICE/agent/adapters/base.py` | Abstract base class: start/stop/get_state/set_state |
| Adapter registry | `DEVICE/agent/adapters/__init__.py` | ADAPTERS, CLOUD_ADAPTERS, PUSH_ADAPTERS dicts |
| Tuya local+gateway | `DEVICE/agent/adapters/tuya.py` | TCP persistent connections, gateway bootstrap, cloud poll fallback |
| Tuya cloud poll | `DEVICE/agent/adapters/tuya_cloud.py` | Cloud API polling for cloud-only devices |
| Tuya cloud push | `DEVICE/agent/adapters/tuya_push.py` | Pulsar WebSocket for real-time cloud events |
| HA API adapter | `DEVICE/agent/adapters/ha_api.py` | HA WebSocket subscription for state_changed events |
| Home Connect | `DEVICE/agent/adapters/home_connect.py` | SSE event stream for BSH appliances |
| Tuya config | `DEVICE/agent/adapters/tuya_config.py` | API keys/secrets for Tuya Cloud |
| Dashboard devices API | `BOILER/dashboard/server.js` (lines 2161-2360) | REST endpoints: GET/PATCH devices, GET/POST/PATCH/DELETE rooms, toggle, events |
| Dashboard devices UI | `BOILER/dashboard/public/js/devices.js` | Client-side device management |

## 3. Infrastructure Map

| LXC | Service | Change Needed |
|-----|---------|---------------|
| 103 | Device Agent (`device-agent.service`) | Add MQTT client (paho-mqtt), publish on state change, config change, and online/offline |
| 107 | Mosquitto broker | Add ACL file to restrict topic access per user; `device_agent` user already exists with password `da_pass_107` |
| 105 | Rule Engine (future) | Subscribe to `mur/home/device/+/state` and related topics; no changes needed now |
| 102 | PostgreSQL | No changes -- existing DB writes continue unchanged |
| Windows | Dashboard (`server.js`) | No immediate changes required; future: optional MQTT status display |

### Ports/Connections

| From | To | Port | Protocol | Status |
|------|-----|------|----------|--------|
| LXC 103 (Device Agent) | LXC 107 (Mosquitto) | 1883 | MQTT | New connection |
| LXC 103 (Zigbee2MQTT) | LXC 107 (Mosquitto) | 1883 | MQTT | Already active (user: `zigbee`) |
| LXC 105 (Rule Engine) | LXC 107 (Mosquitto) | 1883 | MQTT | Future connection |

### Mosquitto Current State (LXC 107)

- Listener: 1883, `allow_anonymous false`
- Password file: `/etc/mosquitto/passwd`
- Users: `zigbee` (Z2M), `device_agent` (pre-created)
- ACL file: **none** -- all authenticated users can pub/sub everything
- Z2M base topic: `zigbee2mqtt/`

## 4. DB Schema

| Table | Action | Columns/Changes |
|-------|--------|----------------|
| `devices` | Read (no change) | id (PK text), name, vendor, category, device_type, protocol, local_ip, local_key, gateway_id, version, product_name, room, show_dashboard, poll_enabled, poll_interval_sec, enabled, notes, last_seen, last_state (jsonb), created_at, updated_at, channel_config (jsonb), dps_labels (jsonb), dps_config (jsonb), last_source, mac |
| `device_events` | Read (no change) | id (bigserial), device_id, ts, dps (jsonb), source |
| `device_agent_log` | Read (no change) | id (bigserial), ts, decision, error, next_ts |
| `rooms` | Read (no change) | name (PK text), created_at |
| `net_devices` | Read (no change) | mac, ip, name, vendor, first_seen, last_seen, last_online |
| No new tables | N/A | MQTT config (broker host, port, credentials) will be env vars in `/etc/environment` on LXC 103, not stored in DB |

**Device counts:** 89 total devices (all enabled), 16 rooms, 2 vendors (tuya, bsh), 3 protocols (local, gateway, cloud).

## 5. Agent Interactions

### Current Data Flow

```
                    ┌──────────────────────────────────┐
                    │        PostgreSQL (LXC 102)       │
                    │   devices, device_events tables   │
                    └──────┬──────────────┬────────────┘
                           │              │
              writes       │              │  reads (polling)
                           │              │
              ┌────────────┘              └────────────────┐
              │                                            │
   Device Agent (LXC 103)                    Dashboard (Windows:3000)
   on_state_change → DB                      GET /api/devices → DB
                                             PATCH /api/devices/:id → DB
```

- **Boiler Agent** (LXC 103): Does NOT read from `devices` table. Reads `raw_data` (fed since 2026-04-23 by `boiler-mqtt-ingest.service` subscribing directly to the WF96C controller's MQTT events; previously fed by the `ha_to_pg` cron that polled HA). Independent data pipeline.
- **Orchestrator** (LXC 105): Reads `device_agent_log` for schedule/error checks. Does not read device state.
- **Dashboard**: Reads `devices` and `device_events` tables directly via PostgreSQL. Writes config changes (room, name, enabled) via `PATCH /api/devices/:id`.

### Proposed Data Flow (with MQTT)

```
                    ┌──────────────────────────────────┐
                    │        PostgreSQL (LXC 102)       │
                    │   devices, device_events tables   │
                    └──────┬──────────────┬────────────┘
                           │              │
              writes       │              │  reads (polling)
                           │              │
              ┌────────────┘              └────────────────┐
              │                                            │
   Device Agent (LXC 103) ──── publishes ───► Mosquitto (LXC 107)
   on_state_change → DB                           │
   on_state_change → MQTT                         │  subscribes
                                                   │
                                          Rule Engine (LXC 105)
                                          (future: evaluate rules
                                           in real-time)
```

## 6. MQTT Topics

### Topic Naming Convention (multi-agent)

Pattern: `mur/home/{agent}/{identifier}/{event_type}`

This convention supports future agents:
- `mur/home/device/...` -- Device Agent
- `home/boiler/...` -- Boiler Agent (future)
- `home/media/...` -- Media Agent (future)
- `home/voice/...` -- Voice Agent (future)
- `home/orchestrator/...` -- Orchestrator (future)

### Device Agent Topics

| Topic | Publisher | Subscriber | Payload | Retained | QoS |
|-------|-----------|------------|---------|----------|-----|
| `mur/home/device/{device_id}/state` | Device Agent | Rule Engine | `{"dps":{...full merged},"source":"tcp_push","ts":"ISO8601"}` | Yes | 0 |
| `mur/home/device/{device_id}/event` | Device Agent | Rule Engine | `{"device_id":"...","dps":{...changed only},"source":"...","ts":"ISO8601"}` | No | 0 |
| `mur/home/device/{device_id}/availability` | Device Agent | Rule Engine | `{"online":true/false,"last_seen":"ISO8601"}` | Yes | 1 |
| `mur/home/device/_bridge/state` | Device Agent | Rule Engine | `{"state":"online","devices":89,"adapters":5,"ts":"ISO8601"}` | Yes | 1 (LWT) |
| `mur/home/device/_bridge/devices` | Device Agent | Rule Engine | `[{"id":"...","name":"...","room":"...","type":"...","protocol":"..."},...]` | Yes | 0 |

### Topic Design Decisions

1. **`state` vs `event`**: `state` is the full merged device state (retained, for late subscribers). `event` is the incremental DPS change (transient, for real-time rule evaluation). The Rule Engine subscribes to `event` for triggering rules and `state` for initial state bootstrap.

2. **Retained messages**: `state`, `availability`, `config`, `room`, and `_bridge/state` are retained so a new subscriber (Rule Engine restart) gets the latest state immediately without needing a full DB query. `event` is NOT retained -- it represents a point-in-time change.

3. **QoS 0 for state/event**: Device state changes are high-frequency (89 devices, multiple sources). QoS 0 (fire-and-forget) is sufficient because:
   - State is also persisted to DB (source of truth)
   - `state` topic is retained, so latest value is always available
   - Lost events are acceptable -- Rule Engine can poll DB for missed events on reconnect

4. **QoS 1 for availability and bridge state**: These are low-frequency, high-importance signals. QoS 1 ensures delivery.

5. **Payload format**: JSON with ISO8601 timestamps. Includes `device_id` in payload (not just topic) so subscribers can process without parsing topic strings.

### Comparison with Zigbee2MQTT Topics

Z2M publishes to `zigbee2mqtt/{friendly_name}` with raw Zigbee payloads. Device Agent topics are different:
- Different prefix (`mur/home/device/` vs `zigbee2mqtt/`)
- Different payload format (DPS-based vs Zigbee attribute-based)
- Different scope (all vendors, not just Zigbee)
- No conflict or overlap

## 7. HA Entities

| Entity | Usage | Access Method |
|--------|-------|---------------|
| N/A | MQTT publishing does not create or modify HA entities | N/A |

HA entities are consumed (read) by the HA API adapter via WebSocket. MQTT publishing is an output channel, not an HA integration.

## 8. Dashboard Impact

| Page | Endpoint | Change |
|------|----------|--------|
| Devices page | No change | Existing device management continues via DB |
| Project Health | `GET /api/health/status` | Future: add MQTT broker connectivity check |
| Settings | N/A | No MQTT toggle needed -- MQTT is always-on once deployed |

No immediate dashboard changes are required. The dashboard currently reads device state from PostgreSQL, which continues unchanged. In the future, a "MQTT Status" indicator could be added to the Project Health page to show broker connectivity.

## 9. Blast Radius

| Component | How Affected | Risk |
|-----------|-------------|------|
| Device Agent DB writes | Unchanged -- MQTT publish is additive, runs after successful DB write | None |
| Device Agent startup | Must handle MQTT broker unavailable at startup (connect in background) | Low -- graceful fallback |
| Device Agent state processing | MQTT publish must not block on_state_change (runs under _db_lock) | Medium -- must be async/fire-and-forget |
| Existing adapters | No changes to any adapter code | None |
| Dashboard | No changes | None |
| Boiler Agent | No impact -- reads raw_data, not devices table | None |
| Orchestrator | No impact -- reads device_agent_log only | None |
| Mosquitto broker | Additional load: ~89 devices x multiple sources, but messages are small JSON | Low |
| Zigbee2MQTT | No impact -- different MQTT user and topic prefix | None |

## 10. Edge Cases / Failure Modes

- **MQTT broker down at Device Agent startup**: MQTT client must connect in background with exponential backoff. Device Agent starts normally, DB writes proceed, MQTT publishes are silently dropped until connected. No crash, no blocking.
- **MQTT broker goes down mid-operation**: paho-mqtt has built-in reconnect. Messages during disconnect are lost (QoS 0). Retained messages are re-published on reconnect. Rule Engine detects disconnect via `_bridge/state` Last Will.
- **Device Agent restarts -- does Rule Engine need full state replay?**: No. All `state` topics are retained, so Rule Engine gets latest state from broker on subscribe. For events missed during Device Agent downtime, Rule Engine can query `device_events` table on startup.
- **Message ordering guarantees**: MQTT guarantees per-client message ordering. Since Device Agent is a single publisher, events for any given device arrive in order. Cross-device ordering is not guaranteed but not needed for rule evaluation.
- **Duplicate messages**: The existing dedup logic in `_db_write()` prevents duplicate DB inserts. MQTT should publish the same events that pass dedup (i.e., only non-duplicate events go to `event` topic). The `state` topic always publishes (it's retained, represents current state regardless of dedup).
- **Device goes offline**: Device Agent should publish `{"online": false}` to `mur/home/device/{id}/availability` when a device's `last_seen` exceeds a threshold. This requires a periodic check thread or integration with adapter disconnect callbacks.
- **Room with no devices**: `mur/home/device/room/{room_name}` would have an empty `devices` array. This is valid and expected.
- **Device with no room assigned**: `mur/home/device/{id}/state` still publishes; `room` field is `null` in payload. No room topic updated.
- **Thread safety**: paho-mqtt client is thread-safe for `publish()`. Multiple adapter threads call `on_state_change()` which holds `_db_lock` -- MQTT publish can happen inside or outside the lock. Recommendation: publish inside the lock (after DB write, before releasing lock) to maintain event ordering. The `publish()` call with QoS 0 is non-blocking.
- **Config changes from dashboard**: Dashboard writes to DB directly. Device Agent is not notified. Options: (a) dashboard also publishes to MQTT (adds mqtt dependency to dashboard), (b) Device Agent polls `updated_at` column periodically, (c) DB NOTIFY/LISTEN. Recommendation: option (b) with a 30-second poll interval for config changes, which then publishes to MQTT.
- **Large payload size**: DPS payloads are typically small (100-500 bytes JSON). No concern for MQTT message size limits.
- **Credential exposure**: MQTT password stored in `/etc/environment` on LXC 103 (same pattern as HA_TOKEN). Not stored in DB.

## 11. Deployment

| Step | Command | Target |
|------|---------|--------|
| 1. Install paho-mqtt | `ssh root@192.168.1.114 "/opt/device-agent/venv/bin/pip install paho-mqtt"` | LXC 103 |
| 2. Add ACL file to Mosquitto | `ssh root@192.168.1.189 "cat > /etc/mosquitto/conf.d/acl.conf << 'EOF'\nacl_file /etc/mosquitto/acl\nEOF"` | LXC 107 |
| 3. Create ACL file | See ACL content below | LXC 107 |
| 4. Restart Mosquitto | `ssh root@192.168.1.189 "systemctl restart mosquitto"` | LXC 107 |
| 5. Set MQTT env vars | Add `MQTT_BROKER=192.168.1.189` `MQTT_USER=device_agent` `MQTT_PASS=da_pass_107` to `/etc/environment` on LXC 103 | LXC 103 |
| 6. Deploy device_agent.py | `scp DEVICE/agent/device_agent.py root@192.168.1.114:/opt/device-agent/device_agent.py` | LXC 103 |
| 7. Restart Device Agent | `ssh root@192.168.1.114 "systemctl restart device-agent"` | LXC 103 |
| 8. Verify MQTT messages | `ssh root@192.168.1.189 "mosquitto_sub -h localhost -u device_agent -P da_pass_107 -t 'mur/home/device/#' -v"` | LXC 107 |

### Proposed ACL File (`/etc/mosquitto/acl`)

```
# Zigbee2MQTT
user zigbee
topic readwrite zigbee2mqtt/#

# Device Agent
user device_agent
topic write mur/home/device/#
topic read mur/home/device/#

# Rule Engine (future)
# user rule_engine
# topic read mur/home/#
# topic write home/orchestrator/#
```

## 12. Open Questions — RESOLVED

- [x] **Config changes publisher**: Device Agent polls `updated_at` every 30s for enable/disable changes. Keeps dashboard as pure UI (architecture rule).
- [x] **Full device inventory on startup**: Yes — publish to `mur/home/device/_bridge/devices` on startup so Rule Engine can bootstrap without DB.
- [x] **Offline threshold**: `last_seen` age > 180s (same as dashboard logic). Simple, consistent across all protocols.
- [x] **State topic payload**: Full merged `last_state` (retained). Rule Engine gets complete picture on subscribe.
- [x] **MQTT credentials**: `/etc/environment` on LXC 103 (shared with HA_TOKEN, TUYA keys). One file for all agents.
- [x] **Rule Engine MQTT user**: No — create later when building Rule Engine. Only set up ACLs for existing users now.
- [x] **Event topic metadata**: Raw DPS + device_id only. No metadata. Rule Engine maintains device→room mapping in memory (loaded from DB at startup, refreshed once per day).
- [x] **Room/config refresh**: Rooms and device-to-room assignments published once at startup + once per day (midnight). Physical rooms rarely change.
- [x] **Last Will (LWT)**: Yes — set LWT on `mur/home/device/_bridge/state` → `{"state":"offline"}` with retain=True. Critical for Rule Engine to detect stale data.

## 13. Recommendations

- **Publish inside `on_state_change()` after DB write**: Single choke point where all state changes converge. QoS 0 publish is non-blocking.
- **Use paho-mqtt with `loop_start()`**: Threaded network loop handles reconnection automatically. Initialize once in `__init__()`.
- **Wrap MQTT in a helper class**: `MqttPublisher` class encapsulates connection, LWT, and publish. Reusable for Boiler/Media agents later.
- **Set Last Will on `_bridge/state`**: LWT `{"state":"offline"}` retained. On connect, publish `{"state":"online",...}`.
- **Publish `event` only for non-deduplicated changes**: If `is_dup` is true, skip `event`. Always update `state` (retained).
- **Do NOT modify any adapter code**: All adapters already call `on_state_change()`. MQTT hooks in at agent level.
- **Add ACLs to Mosquitto now**: Restrict `zigbee` to `zigbee2mqtt/#`, `device_agent` to `mur/home/device/#`.
- **Config polling (enable/disable only)**: 30s poll of `updated_at` for device enable/disable changes. Room mapping refreshed daily at midnight.
- **Keep `keepalive` source out of MQTT**: Home Connect keepalive events are DB-only `last_seen` touches, not published.
- **Full inventory on startup**: Publish all devices with room/type/protocol to `mur/home/device/_bridge/devices` for Rule Engine bootstrap.
