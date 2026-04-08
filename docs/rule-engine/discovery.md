# Discovery: Rule Engine

**Description:** Persistent service on LXC 105 that subscribes to MQTT, evaluates automation rules in real-time, and sends commands back via MQTT.
**Date:** 2026-04-08
**Status:** Draft

## 1. Goal

Build a long-running Rule Engine service on LXC 105 (192.168.1.187) that subscribes to all MQTT device events, evaluates automation rules authored as Python code, and sends commands back via MQTT. Rules are code -- carefully authored by Claude with dependency awareness, reviewed and approved by the user before deployment. The engine holds device and room state in memory (loaded from DB at startup, refreshed daily at midnight) so rule evaluation is fast and does not hit the database on every event. This replaces the current manual-only device control (toggle via dashboard -> HA API) with a reactive automation layer. The Rule Engine runs alongside the existing Orchestrator (timer-based oneshot) as a separate systemd service.

## 2. Current Behavior

Today there is **no automation engine**. All device control is manual:

1. **Dashboard toggle** -- User clicks toggle on the Devices page, which calls `POST /api/devices/:id/toggle` on `server.js`. This endpoint looks up the Tuya device ID in HA via a template query, finds the matching switch/light/cover entity, and calls HA's `turn_on`/`turn_off` service. Only works for Tuya devices mapped in HA.

2. **Boiler Agent** -- The only automated control loop. Runs on LXC 103 as `boiler-agent.service`, controls `switch.boiler_valve_switch_switch_1` via HA API based on temperature logic. This is a dedicated single-purpose agent, not a general rule engine.

3. **HA automations** -- No reference to HA automations in the codebase. All HA integration is read-only (WebSocket state subscription, API template queries for toggle). The system does not use HA's built-in automation engine.

4. **HASP plates** -- openHASP devices publish to `hasp/{node}/...` on Mosquitto. Commands are sent by publishing to `hasp/{node}/command/...`. Currently no agent sends commands to HASP devices.

5. **Zigbee devices** -- Controlled via Zigbee2MQTT by publishing to `zigbee2mqtt/{friendly_name}/set`. Currently only Z2M itself publishes commands; no agent does.

### Code Locations

| Component | File | Purpose |
|-----------|------|---------|
| MqttPublisher (reusable) | `DEVICE/agent/adapters/mqtt_publisher.py` | MQTT client with LWT, auto-reconnect, subscribe, publish. To be reused by Rule Engine |
| Device Agent | `DEVICE/agent/device_agent.py` | Publishes all device state/events to MQTT, ingests HASP/Awtrix/Zigbee/DIY via MQTT |
| Orchestrator | `ORCHESTRATOR/orchestrator.py` | Hourly health checks, retention cleanup. Runs on LXC 105 as oneshot timer |
| Dashboard toggle | `BOILER/dashboard/server.js` (line 2255) | `POST /api/devices/:id/toggle` -- HA API call to control Tuya devices |
| Boiler Agent | `BOILER/agent/boiler_agent.py` | Single-purpose valve control via HA API |
| MQTT tech design | `docs/mqtt-publish/tech-design.md` | Full MQTT topic map, payload formats, QoS decisions |
| MQTT discovery | `docs/mqtt-publish/discovery.md` | MQTT infrastructure discovery, ACL layout |

## 3. Infrastructure Map

| LXC | Service | Change Needed |
|-----|---------|---------------|
| 105 | Orchestrator (`main-agent.timer` + `main-agent-quick.timer`) | No change -- continues running alongside Rule Engine |
| 105 | **Rule Engine (`rule-engine.service`)** | **NEW** -- persistent Python service, separate systemd unit |
| 105 | Python 3.11.2, venv at `/opt/main-agent/venv` | Install `paho-mqtt` in existing venv (currently has: psycopg2-binary, paramiko, invoke) |
| 107 | Mosquitto broker | Add `rule_engine` user + ACL entries (subscribe to all, publish to command topics) |
| 102 | PostgreSQL | New tables: `rule_engine_log`, `rule_engine_state` (see DB Schema). Register in `retention_policies` + `agents` |
| 103 | Device Agent | No change -- already publishes all events to MQTT |
| Windows | Dashboard | Future: Rule Engine status page (not required for v1) |

### LXC 105 Current State

- **OS**: Debian, Python 3.11.2
- **Disk**: 4 GB total, 850 MB used (3.2 GB free)
- **RAM**: 512 MB total, 24 MB used (487 MB available) -- plenty for a lightweight Python service
- **Services running**: cron, ssh, systemd basics only
- **Timers**: `main-agent.timer` (hourly), `main-agent-quick.timer` (5 min)
- **Venv**: `/opt/main-agent/venv` -- has psycopg2-binary, paramiko, paho-mqtt NOT installed
- **Git repo**: `/opt/main-agent/project` (same repo as all agents)
- **SSH key**: `/root/.ssh/id_ed25519` -- authorized on all LXCs

## 4. DB Schema

### Existing Tables (read-only)

| Table | Action | Columns Used by Rule Engine |
|-------|--------|----------------------------|
| `devices` | Read | `id` (PK text), `name`, `vendor`, `device_type`, `protocol`, `room`, `enabled`, `last_state` (jsonb), `channel_config` (jsonb), `dps_labels` (jsonb), `dps_config` (jsonb) |
| `rooms` | Read | `name` (PK text) |
| `device_events` | Read (replay on startup) | `id`, `device_id`, `ts`, `dps` (jsonb), `source` |
| `agents` | Read/Write | Register `rule-engine` row for orchestrator monitoring |

### New Tables

| Table | Action | Columns/Changes |
|-------|--------|----------------|
| `rule_engine_log` | Create | `id BIGSERIAL PK`, `ts TIMESTAMPTZ DEFAULT NOW()`, `decision TEXT`, `error TEXT`, `next_ts TIMESTAMPTZ` -- heartbeat log for orchestrator monitoring (follows agent framework contract) |
| `rule_engine_state` | Create | `key TEXT PK`, `value JSONB`, `updated_at TIMESTAMPTZ DEFAULT NOW()` -- persistent key-value store for rule state that must survive restarts (e.g., last motion time, scene state, cooldown timers) |
| `retention_policies` | Insert | Add rows for `rule_engine_log` (keep 30 days, auto_clean daily) and `rule_engine_state` (forever) |

### Rules Storage

Rules are **Python code files** on disk, NOT stored in DB. Located at a path like `/opt/main-agent/project/RULES/` in the git repo. Each rule is a `.py` file with a standard interface. This keeps rules version-controlled, code-reviewable, and deployable via `git pull`.

## 5. Agent Interactions

### Full Data Flow

```
  Tuya TCP/Cloud/Push ─┐
  HA WebSocket ─────────┤
  Home Connect SSE ─────┤
  HASP plates ──────────┤  (native MQTT)
  Awtrix displays ──────┤  (native MQTT)
  Zigbee2MQTT ──────────┘  (native MQTT)
            │
            ▼
   Device Agent (LXC 103)
   on_state_change() → DB write
            │
            ├─► mur/home/device/{id}/state    (retained, full merged state)
            ├─► mur/home/device/{id}/event    (transient, changed DPS)
            ├─► mur/home/device/{id}/availability (retained)
            └─► mur/home/device/_bridge/devices   (retained, daily inventory)
            │
            ▼
      Mosquitto (LXC 107)
            │
            ▼
   Rule Engine (LXC 105)
   subscribes to: mur/home/device/#, hasp/#, awtrix/#, zigbee2mqtt/#
            │
            ├─► Evaluate rules against in-memory device/room state
            │
            ├─► OUTBOUND COMMANDS:
            │   ├─► mur/home/device/{id}/command   (Tuya → Device Agent → HA)
            │   ├─► hasp/{node}/command/{path}      (openHASP direct)
            │   ├─► zigbee2mqtt/{name}/set           (Zigbee direct)
            │   └─► awtrix/{id}/custom               (Awtrix direct)
            │
            └─► rule_engine_log (DB heartbeat for orchestrator)
```

### Command Path Decision

| Device Type | Command Path | Why |
|-------------|-------------|-----|
| Tuya (local/cloud/gateway) | Publish `mur/home/device/{id}/command` → Device Agent listens → calls HA API | Device Agent already has HA token + entity mapping logic. Avoids duplicating HA integration in Rule Engine |
| HASP (openHASP) | Publish directly to `hasp/{node}/command/{object}` | Native MQTT protocol, no HA involvement needed |
| Zigbee | Publish directly to `zigbee2mqtt/{friendly_name}/set` | Native MQTT via Z2M, no HA involvement needed |
| Awtrix | Publish directly to `awtrix/{id}/custom` or `awtrix/{id}/notify` | Native MQTT protocol |

**Key decision: Tuya commands go through Device Agent, not directly to HA.** This means Device Agent needs a new MQTT subscription on `mur/home/device/+/command` and a handler that calls the HA toggle API. This keeps the HA token and entity resolution logic in one place (Device Agent) rather than duplicating it in Rule Engine.

## 6. MQTT Topics

### Subscriptions (Rule Engine reads)

| Topic | Publisher | Subscriber | Payload | Retained | QoS |
|-------|-----------|------------|---------|----------|-----|
| `mur/home/device/+/state` | Device Agent | Rule Engine | `{"dps":{...},"source":"...","ts":"ISO8601"}` | Yes | 0 |
| `mur/home/device/+/event` | Device Agent | Rule Engine | `{"device_id":"...","dps":{...},"source":"...","ts":"ISO8601"}` | No | 0 |
| `mur/home/device/+/availability` | Device Agent | Rule Engine | `{"online":true/false,"last_seen":"ISO8601"}` | Yes | 1 |
| `mur/home/device/_bridge/state` | Device Agent | Rule Engine | `{"state":"online/offline","devices":N,...}` | Yes | 1 |
| `mur/home/device/_bridge/devices` | Device Agent | Rule Engine | `[{"id":"...","name":"...","room":"..."}]` | Yes | 0 |
| `hasp/+/state` | HASP plates | Rule Engine | JSON plate status | Yes | 0 |
| `hasp/+/state/+` | HASP plates | Rule Engine | Object state (button, slider values) | No | 0 |
| `awtrix/+/stats` | Awtrix displays | Rule Engine | JSON stats | Yes | 0 |
| `zigbee2mqtt/+` | Z2M | Rule Engine | JSON device state | Yes | 0 |

### Publications (Rule Engine writes)

| Topic | Publisher | Subscriber | Payload | Retained | QoS |
|-------|-----------|------------|---------|----------|-----|
| `mur/home/device/{id}/command` | Rule Engine | Device Agent | `{"action":"turn_on"/"turn_off","channel":"1",...}` | No | 1 |
| `hasp/{node}/command/{path}` | Rule Engine | HASP plate | Value string or JSON per openHASP spec | No | 0 |
| `zigbee2mqtt/{name}/set` | Rule Engine | Z2M | `{"state":"ON"/"OFF","brightness":N,...}` | No | 0 |
| `awtrix/{id}/custom` | Rule Engine | Awtrix display | App payload JSON | No | 0 |
| `mur/home/rule-engine/state` | Rule Engine | Dashboard/Orchestrator | `{"state":"online/offline","rules":N,"ts":"ISO8601"}` | Yes | 1 (LWT) |

### New Topic: `mur/home/device/{id}/command`

This is a new topic that requires Device Agent changes. When Device Agent receives a message on this topic:
1. Parse `{"action": "turn_on"/"turn_off", "channel": "1"}` (channel is optional, maps to multi-switch devices)
2. Look up HA entity using the same logic as `/api/devices/:id/toggle` in server.js
3. Call HA API `services/{domain}/{service}` with the resolved entity_id
4. Publish result to `mur/home/device/{id}/command/response` (optional, for Rule Engine confirmation)

## 7. HA Entities

| Entity | Usage | Access Method |
|--------|-------|---------------|
| All Tuya switch/light/cover entities | Controlled indirectly via Device Agent command topic | Device Agent calls HA API (has HA_TOKEN) |
| `switch.boiler_valve_switch_switch_1` | Boiler valve -- controlled by Boiler Agent, NOT by Rule Engine | Boiler Agent has exclusive control |

**Rule Engine does NOT need an HA token.** All HA-controlled devices are reached via MQTT command topics routed through Device Agent. HASP, Zigbee, and Awtrix devices are controlled via native MQTT directly.

## 8. Dashboard Impact

| Page | Endpoint | Change |
|------|----------|--------|
| Project Health | `GET /api/health/status` | Add `rule-engine` service check (via `system_alerts` table, same pattern as boiler_agent) |
| N/A (future) | N/A | v2: dedicated Rule Engine page showing active rules, last triggers, rule log |

**v1 requires no dashboard changes.** The Rule Engine registers in the `agents` table, so the Orchestrator monitors it automatically. The Project Health page will show its status via `system_alerts` (same as other agents). A dedicated rules management page is a v2 feature.

## 9. Blast Radius

| Component | How Affected | Risk |
|-----------|-------------|------|
| Device Agent (LXC 103) | Must add `mur/home/device/+/command` subscription + HA command handler | Medium -- new code in critical path. Must not crash on malformed commands |
| Mosquitto (LXC 107) | New user `rule_engine`, expanded ACL | Low -- additive config change, restart required |
| Orchestrator (LXC 105) | New `agents` row for monitoring. Shares LXC resources (CPU/RAM) | Low -- Orchestrator is oneshot (runs briefly every 5min/1h), Rule Engine is idle most of the time |
| PostgreSQL (LXC 102) | 2 new tables, additional writes (rule_engine_log heartbeat) | Low -- minimal write volume |
| Boiler Agent (LXC 103) | No change. Boiler valve control remains exclusive to Boiler Agent | None -- Rule Engine must NOT control boiler valve |
| Dashboard (Windows) | No immediate changes | None for v1 |
| HASP/Zigbee/Awtrix devices | Will receive commands from Rule Engine | Medium -- incorrect rules could send wrong commands. Rules are code-reviewed to mitigate |

## 10. Edge Cases / Failure Modes

- **Rule Engine down** -- No automations run. All devices remain in their current state. Manual control via dashboard still works. Orchestrator detects service_down via SSH check, raises alert, attempts auto-restart.

- **MQTT broker down** -- Rule Engine loses all input AND output. Cannot evaluate rules or send commands. Paho auto-reconnects. On reconnect, retained messages provide current state. Events during disconnect are lost (acceptable -- rules react to current state, not history).

- **Device Agent down** -- Rule Engine still receives native MQTT events (HASP, Zigbee, Awtrix) but loses Tuya device events. LWT on `_bridge/state` = offline alerts Rule Engine. Tuya command topic has no listener -- commands are lost. Rule Engine should check bridge state before sending Tuya commands.

- **Rule depends on offline device** -- Rule Engine tracks availability via `mur/home/device/{id}/availability`. Rules must check `online` status before acting. Rule code should handle missing/stale state gracefully.

- **Two rules conflict (both want to control same device)** -- Since rules are code, conflicts are resolved at authoring time by Claude + user review. Runtime: last-write-wins on MQTT. For critical devices, a "device lock" pattern can be implemented (rule claims exclusive control for N seconds).

- **Rule evaluation takes too long** -- Rules run in the main MQTT callback thread. A slow rule blocks all other rule evaluations. Mitigation: rules must be fast (no DB queries, no HTTP calls, no sleep). If a rule needs async work, it should set a flag and let a separate timer thread handle it.

- **Rule Engine restart -- missed events** -- On startup, Rule Engine subscribes to all topics. Retained messages provide current state for all devices. Transient events during downtime are lost. For most rules (react to current state), this is fine. Rules that need event history (e.g., "motion in last 5 minutes") should use `rule_engine_state` table to persist timestamps.

- **Stale in-memory state** -- Device/room mapping refreshed from DB at midnight. If a device is added or room changed mid-day, Rule Engine won't know until midnight or restart. Mitigation: also subscribe to `_bridge/devices` inventory updates (published every 30s on config change).

- **LXC 105 resource contention** -- 512 MB RAM, shared with Orchestrator. Rule Engine at idle uses ~20-30 MB Python. Orchestrator peaks briefly during runs. No concern unless rules accumulate large state.

- **Malformed MQTT command** -- Device Agent must validate command payload before calling HA API. Reject unknown actions, missing device_id, etc. Log and drop.

- **Infinite loop** -- Rule A turns on device X, which triggers Rule B to turn off device X, which triggers Rule A again. Mitigation: command cooldown per device (ignore commands to same device within N seconds). Also caught during code review.

- **Clock drift between LXCs** -- Rules using time-based conditions (e.g., "after sunset") should use NTP-synced system time. All LXCs use Proxmox host NTP.

## 11. Deployment

| Step | Command | Target |
|------|---------|--------|
| 1. Install paho-mqtt in venv | `ssh root@192.168.1.187 "/opt/main-agent/venv/bin/pip install paho-mqtt"` | LXC 105 |
| 2. Create rule_engine Mosquitto user | `ssh root@192.168.1.189 "mosquitto_passwd /etc/mosquitto/passwd rule_engine"` | LXC 107 |
| 3. Update Mosquitto ACL | Append rule_engine ACL entries to `/etc/mosquitto/acl` | LXC 107 |
| 4. Restart Mosquitto | `ssh root@192.168.1.189 "systemctl restart mosquitto"` | LXC 107 |
| 5. Create DB tables | `rule_engine_log`, `rule_engine_state` on LXC 102 | LXC 102 |
| 6. Register in agents table | `INSERT INTO agents (name, lxc_id, lxc_ip, service_name, data_table, ...) VALUES ('rule-engine', 105, '192.168.1.187', 'rule-engine', 'rule_engine_log', ...)` | LXC 102 |
| 7. Add retention policies | Insert rows for `rule_engine_log` (30d) and `rule_engine_state` (forever) | LXC 102 |
| 8. Set MQTT env vars | Add `MQTT_BROKER`, `MQTT_USER`, `MQTT_PASS` to `/etc/rule-engine.env` | LXC 105 |
| 9. Deploy rule engine code | `git pull` on LXC 105 or `scp` rule engine files | LXC 105 |
| 10. Install systemd service | Copy `rule-engine.service` to `/etc/systemd/system/`, enable + start | LXC 105 |
| 11. Add command handler to Device Agent | Deploy updated `device_agent.py` with `/command` subscription | LXC 103 |
| 12. Verify | `mosquitto_sub -h 192.168.1.189 -u rule_engine -P <pass> -t 'mur/home/rule-engine/#' -v` | LXC 107 |

### Mosquitto ACL Addition

```
# Rule Engine — subscribe to everything, publish commands + own status
user rule_engine
topic read mur/home/device/#
topic read hasp/#
topic read awtrix/#
topic read zigbee2mqtt/#
topic write mur/home/device/+/command
topic write mur/home/rule-engine/#
topic write hasp/+/command/#
topic write zigbee2mqtt/+/set
topic write awtrix/+/custom
topic write awtrix/+/notify
```

### Systemd Service File

```ini
[Unit]
Description=Rule Engine — MQTT automation service
After=network.target

[Service]
Type=simple
ExecStart=/opt/main-agent/venv/bin/python3 /opt/main-agent/project/RULES/rule_engine.py
EnvironmentFile=/etc/rule-engine.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## 12. Open Questions — RESOLVED

- [x] **Device Agent command handler scope**: Full scope — `turn_on`, `turn_off`, `set_brightness`, `set_color_temp`, `set_position` (covers), plus read sensors (illuminance, temperature, humidity, motion feed data to rules). HA API is default for now; architecture supports switching to direct tinytuya later without redesign.
- [x] **Boiler valve exclusion**: No blocking, no exclusions. All devices controllable. Safety through code review + loop detection. Note: electric heater ON → valve must close (Rule Engine handles this coordination).
- [x] **Rule file structure**: Each rule is a `.py` file with `RULE` metadata dict (name, description, triggers, controls, category) + `evaluate(event, state)` function. Human-readable description. LLM-friendly for future auto-editing.
- [x] **Rule dependencies**: No direct rule-to-rule dependencies. Rules communicate via **shared state layer** (in-memory dict: `home_mode`, `people_home`, `last_motion_room`, etc.). Each rule reads/writes shared state. Persisted to `rule_engine_state` table.
- [x] **Rule enable/disable**: Runtime disable via MQTT (`mur/home/rule-engine/disable/{name}`) — removes rule from active evaluation completely. Persisted to `rule_engine_state`. Future: dashboard toggle.
- [x] **Command confirmation**: Yes — Device Agent publishes response on `mur/home/device/{id}/command/response` with success/fail.
- [x] **Rate limiting**: No fixed rate limit. Instead: **loop detection** — if same device gets same command 4+ times in 10 seconds, auto-disable the causing rule.
- [x] **Separate venv or shared**: Shared `/opt/main-agent/venv`. Both need psycopg2 + paho-mqtt. Simpler, saves disk.
- [x] **Dashboard**: v1 "Main Agent" page with visual icons showing live home state (activity, people count, occupied rooms). Rule list + enable/disable toggles in future.
- [x] **HA token for Rule Engine**: No. All commands go through Device Agent via MQTT. Rule Engine has zero HA dependency.

## 13. Recommendations

- **Reuse `MqttPublisher` from `DEVICE/agent/adapters/mqtt_publisher.py`** -- Copy or symlink into Rule Engine project. It already handles LWT, auto-reconnect, subscribe, and publish. Only add `on_message` routing logic.
- **Shared venv on LXC 105** -- Use `/opt/main-agent/venv` for Rule Engine. Only need to add `paho-mqtt`. Avoids maintaining two venvs on a 512 MB LXC.
- **Separate env file** -- Use `/etc/rule-engine.env` (not `/etc/environment`) to keep Rule Engine credentials isolated from Orchestrator.
- **Rules as code in git** -- Store rules in `RULES/` directory in the project repo. Each rule is a `.py` file. Deploy via `git pull` + `systemctl restart rule-engine`. Version-controlled, code-reviewable.
- **Device Agent command handler is a prerequisite** -- Before Rule Engine can control Tuya devices, Device Agent must subscribe to `mur/home/device/+/command` and implement the HA API call. This is a Device Agent change, not a Rule Engine change.
- **Register in `agents` table on day 1** -- So Orchestrator monitors Rule Engine health from the start (schedule check, service check, auto-restart).
- **Start with simple rules** -- First rules should be low-risk (e.g., HASP button toggles a Zigbee light). Build confidence before adding complex multi-device rules.
- **Command cooldown** -- Implement a per-device cooldown (5s default) in the Rule Engine to prevent infinite loops and rapid toggling.
- **Do NOT control boiler valve** -- Boiler Agent has exclusive control. Rule Engine should have a hardcoded exclusion list for safety-critical devices.
- **Heartbeat every 5 min** -- Write to `rule_engine_log` every 5 minutes (matches Device Agent pattern). Orchestrator checks `next_ts` for overdue detection.
- **Subscribe to `_bridge/devices` for live inventory updates** -- Don't wait for midnight refresh. Device Agent publishes inventory within 30s of device add/remove.
