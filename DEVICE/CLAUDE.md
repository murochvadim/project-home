# Device Agent

Cross-protocol device aggregator running on LXC 103 as `device-agent.service`. Unifies live state from Tuya local TCP, Tuya gateway (Zigbee sub-devices), Tuya cloud push (Pulsar), Home Assistant WebSocket (SmartThings / Ring / Aqara FP2 / vacuums), Home Connect (BSH Siemens appliances), and Zigbee2MQTT into a single `devices` table + per-device MQTT publish path.

## File Locations

| Artifact | Path |
|---|---|
| Service unit (deployed to `/etc/systemd/system/`) | [`DEVICE/device-agent.service`](device-agent.service) |
| Main loop | [`DEVICE/agent/device_agent.py`](agent/device_agent.py) |
| **Adapters (canonical repo source)** | [`DEVICE/agent/adapters/`](agent/adapters/) |
| Deploy target on LXC 103 | `/opt/device-agent/device_agent.py` + `/opt/device-agent/adapters/*.py` (systemd `ExecStart=/opt/device-agent/venv/bin/python3 /opt/device-agent/device_agent.py`; the older `/opt/device-agent/agent.py` is orphaned and NOT executed — deploying to it silently no-ops) |
| Memory | [`memory/project_context.md`](../.claude/projects/c--Users-muroc-project-home/memory/project_context.md) (general project context) |

## Adapter inventory

All files in `DEVICE/agent/adapters/` are the **canonical repo source** for the live `/opt/device-agent/adapters/*.py` on LXC 103. Deploy = `scp DEVICE/agent/adapters/<adapter>.py root@192.168.1.114:/opt/device-agent/adapters/<adapter>.py` + `systemctl restart device-agent`.

| File | Role | Status |
|---|---|---|
| `__init__.py` | package marker | stable |
| `base.py` | `DeviceAdapter` abstract base class | stable |
| `tuya.py` | Local Tuya TCP per-device threads + gateway Zigbee hub. Watchdog respawns silent threads (since 2026-05-15). **Local-key rotation auto-recovery (since 2026-05-30):** each per-device thread increments `_per_dev_904_count[dev_id]` on every `Err 904` response (Tuya's "Unexpected Payload" — encryption mismatch = stale local_key after the user re-paired in the Tuya app) and resets it to 0 on any successful read. The watchdog (already running every `WATCHDOG_INTERVAL_SEC = 300 s`) checks this counter; when it exceeds `KEY_REFETCH_904_THRESHOLD = 5` AND the per-device throttle (`KEY_REFETCH_THROTTLE_SEC = 1800` = 30 min) has elapsed, it queries the Tuya cloud via `cloudrequest('/v1.0/devices/<id>')` for the device's current `local_key`. If the cloud's key differs from `devices.local_key`, the watchdog UPDATEs the row (sets `last_source='cloud_key_refresh'` for journal-trail), writes the new key into `self._per_dev_key[dev_id]` (the per-device thread reads this on every reconnect), and signals the per-device `force_reconnect` event. The reconnect picks up the fresh key + the TCP channel comes back without a service restart. If the cloud's key MATCHES the DB, the counter is reset and an INFO log notes that the 904 cause is something else (firmware bug, peer mismatch) — preventing infinite refetch loops on devices that aren't actually rotated. Throttle prevents bursting Tuya's cloud API if the cloud's key is ALSO wrong (extremely unlikely). Resolves the silent failure mode that kept Guy Room window Light on the cloud channel (`last_source='ha_api'`) for 14+ days before being noticed on 2026-05-30. **Mode C — device-side TCP listener stuck (same date):** sibling watchdog branch for sustained `Err 901` (TCP unreachable). Threshold `TCP_STUCK_901_THRESHOLD = 120` polls (~30 min). When crossed AND the per-device alert throttle (`TCP_STUCK_ALERT_THROTTLE_SEC = 3600` = 1 h) has elapsed, the watchdog runs two independent confirmation probes: (a) `tinytuya.find_device()` UDP broadcast — must hit, proving the device is on the LAN, (b) Tuya cloud `online` flag — must be true. If BOTH confirm the device is alive, the TCP listener is firmware-hung; the watchdog raises a `network:device_tcp_stuck:<id>` row in `system_alerts` (`source='device_agent'`, `severity='warn'`, message names the device + IP + instructs the user to power-cycle). Idempotent INSERT-or-UPDATE so a recurring detection refreshes the message + ts instead of stacking duplicate rows. If UDP fails OR cloud says offline, the watchdog logs INFO ("device genuinely offline") and bumps the throttle anyway so cloud API isn't burned on permanently-dead devices. **Auto-resolve on recovery:** the per-device thread tracks whether the 901 counter was above threshold; on the first successful local read (initial / local_poll / tcp_push), it calls `_resolve_tcp_stuck_alert(dev_id)` which sets `resolved_at = NOW()` on any active row for that device. The alert auto-clears the moment the user power-cycles the device. NOT fixable in code (firmware hang on the device's port-6668 listener); code can only surface + auto-resolve. **UDP-broadcast IP rediscovery (since 2026-05-27):** `tinytuya.find_device(dev_id)` runs at the start of every reconnect iteration after the first (when `attempt > 0`). If the cached IP differs from the device's current broadcast-announced IP, the local variable updates AND the new IP is persisted to BOTH `devices.local_ip` AND `net_devices.ip` (via MAC subquery) in a single short-lived psycopg2 transaction. Self-heals from DHCP rotation within one reconnect cycle (~30 s) — no manual SQL, no restart needed. **Double-write is load-bearing:** the `device_agent.py` startup query uses `COALESCE(net_devices.ip, devices.local_ip)`, so persisting only to `devices.local_ip` would have the next restart pick the stale `net_devices.ip` and refire rediscovery anyway — exactly what happened across 4+ restart cycles on 2026-05-27 before the gap was found. The same-day audit also closed the second half of the loop in `device_agent._db_write` (both `keepalive` and state-change branches now read `mac, local_ip` via `RETURNING` from the UPDATE they already run, instead of trusting the stale startup-cached `_device_net_info` dict — the cache was overwriting `net_devices` with old values every 5 min and undoing rediscovery). Proven 2026-05-27 on `Aura Air switch` (.199 → .196), `Gas sensor` (.118 → .107), `Balcony Wall Flowers Light` (.135 → .133), `Guy Room window Light` (.175 → .178) — the last two confirmed booting straight to the correct IP across a deliberate restart after the double-write landed. Devices that don't broadcast (offline or non-stock firmware) get a `rediscovery timed out` INFO log and fall back to the cached IP. | active development |
| `tuya_cloud.py` | Tuya Cloud API client. **IR-remote keepalive** for `device_type='remote'` (Tuya `wnykq` IR hubs). Two-iteration evolution: (a) **2026-05-15 v1** (commit f72a773): bumped `last_seen` on any successful empty-DPS status response — but the status API returns `success=True` even when device is offline, so dead-battery remotes showed perma-alive. (b) **2026-05-16 morning v2**: switched to `update_time` from `/v1.0/devices/<id>` — but `update_time` is the device-record metadata-update field, NOT a heartbeat. It's frozen for days/weeks on most devices. Made every IR hub permanently Offline. (c) **2026-05-16 current v3**: trusts the cloud's `online` boolean — the ONLY reliable signal for this class after an exhaustive scan of 9 endpoints (`active_time`/`create_time` = activation date, `update_time` = metadata, `shadow/properties[*].time` = last DPS publish — IR hubs never publish, `freeze-state` = months-of-silence flag, Pulsar `dp_report` = empty for zero-DPS devices). Lags by hours-to-days when devices die (Tuya's own offline detection cadence — same lag the Tuya app has). Helper: `_remote_recently_active()` returns True only if `online: true`. Scoped to `device_type='remote'`; other cloud-poll devices unaffected. | active development |
| `tuya_config.py` | API_REGION / API_KEY / API_SECRET constants | stable |
| `tuya_push.py` | Tuya cloud Pulsar push receiver (real-time cloud events) | **HAS UNDEPLOYED WORK** — see below |
| `ha_api.py` | Home Assistant WebSocket adapter (SmartThings, Ring, vacuums, HomeKit FP2, BSH). Multi-thread watchdog auto-heals stuck WS. | active development |
| `home_connect.py` | BSH Home Connect SSE adapter (Siemens dishwasher / oven / hob / hood / microwave / washer) | **HAS UNDEPLOYED WORK** — see below |
| `mqtt_publisher.py` | Publishes `mur/home/device/<id>/{event,state}` to LXC 107 mosquitto | stable |

## Canonical repo path policy (since 2026-05-15)

Previously the repo had TWO copies of `tuya.py` + `ha_api.py`:
- `scripts/tuya_adapter_patched.py` (the one actively edited and deployed)
- `DEVICE/agent/adapters/tuya.py` (stale snapshot from April 10, 5 weeks behind)

This bit us when the audit caught the `DEVICE/` copy missing 5 weeks of silent-freeze-watchdog work. Cleaned up:
- `scripts/tuya_adapter_patched.py` + `scripts/ha_api_patched.py` **DELETED**
- `DEVICE/agent/adapters/` is now the **single canonical source** for all adapter files
- Deploy command unchanged otherwise (just sources from DEVICE/ instead of scripts/)

## Known undeployed work

These changes exist in `DEVICE/agent/adapters/` but have NOT been pushed to LXC 103. Investigate + decide deploy or discard before next adapter release.

### `tuya_push.py` — silent-freeze watchdog for Pulsar (since 2026-04-10)

Adds a 10-minute message-staleness check that force-reconnects the Pulsar client when no cloud-push messages arrive. Same architectural pattern as the `tuya.py` watchdog (deployed 2026-05-15), but for the cloud-push path instead of the local-TCP path.

Diff (~12 lines):
- `self._last_msg_time` tracked in `__init__`
- Updated on every received message
- Outer reconnect loop checks `time.time() - self._last_msg_time > 600` and forces reconnect

Sat in repo for 5 weeks. Should be deployed when someone wants the same self-heal guarantee for cloud push as we now have for local TCP.

### `home_connect.py` — defensive refresh-token check (since 2026-04-10)

One-line change at startup:
```python
# Was:  if not HC_REFRESH_TOKEN:
# Now:  if not (HC_REFRESH_TOKEN or self._refresh_token):
```
Allows the adapter to start when the env var isn't set but in-memory state has the token. Likely a startup-race fix.

## Deploy procedure

```bash
# Single adapter
scp DEVICE/agent/adapters/<adapter>.py root@192.168.1.114:/opt/device-agent/adapters/<adapter>.py
ssh root@192.168.1.114 'systemctl restart device-agent'

# Main loop (device_agent.py — note systemd runs device_agent.py, NOT agent.py)
scp DEVICE/agent/device_agent.py root@192.168.1.114:/opt/device-agent/device_agent.py
ssh root@192.168.1.114 'systemctl restart device-agent'

# Verify post-deploy
ssh root@192.168.1.114 'systemctl is-active device-agent && journalctl -u device-agent --since "30 sec ago" | grep -iE "error|started" | head'
```

## Per-DPS merge & `cloud_authoritative_dps` (since 2026-06-06)

`_db_write` persists state with a **blind JSONB merge**: `last_state = last_state || new_dps`. The documented source-priority ordering (`tcp_push > ha_api > local_poll`) is applied **only to the `last_source` label** (`_device_best_source`) — it is **NOT** enforced on the per-DPS *values*. So whichever source last touched a key wins, regardless of priority.

This caused the **8 Gang Switch ch8 (AWAY) desync**: DPS 8 is a cloud-only datapoint — `ha_api` reports it on/off correctly, but the local link always reads `8:0`. Every `local_poll` full snapshot (`{3,4,7,8}`) clobbered the authoritative `ha_api 8:true` back to `0`, so the Devices page always showed AWAY off.

**Fix — per-device `cloud_authoritative_dps` guard:** add a top-level list to the device's `dps_config`, e.g. `{"cloud_authoritative_dps": ["8"]}`. At config load it's cached in `self._cloud_authoritative_dps[device_id]`; in `_db_write`, for `source in (local_poll, tcp_push, initial)` those keys are **stripped from `dps` before the merge** (and before filtered events/MQTT), so only `ha_api` / cloud-push can write them. Generic — any future cloud-only DP just needs the `dps_config` entry, no code change. Caveat: such a DP only refreshes on an `ha_api` state-**change** event, so right after a device-agent restart its `last_state` value is stale until the next real toggle (HA pushes only on change). See [[incident_mode_buttons_away_latch]].

## `_resolve_entity` allows `media_player` (2026-07-31)

`_handle_command` → `_resolve_entity` picks the HA entity for a `turn_on`/`turn_off` command from the device's `HA_DIRECT_DEVICES` entity map, filtered to a domain allowlist. That allowlist gained **`media_player`** (`device_agent.py:493` → `('switch','light','fan','cover','media_player')`) so **plain Samsung TVs (media_player-only, no smart plug) actually toggle** via `media_player/turn_on|off` — previously they resolved to no entity and silently no-op'd (Guy & Bedroom TVs). The **85"** still prefers its `switch.samsung_85_qled` smart plug (the switch-domain fallback wins over the media_player entity; neither ends in a `_PREFER_SUFFIX`). Blast radius is TVs only: Alexa/soundbar rows are `protocol='alexa'` → dispatched by the engine's alexa branch, never reaching `_resolve_entity`; no other `ha_api` device maps to a media_player entity. Enabled adding the **Balcony TV to Main Agent Scenes** (new row `media_player.balcony_55_neo_qled` `device_type='tv'` `protocol='ha_api'` + a `HA_DIRECT_DEVICES` state-only entry in `ha_api.py`). See root CLAUDE.md "Scenes tab → TV media" + [[project_media_tv]].

## Behavior reference

The Device Agent System bullet in [root CLAUDE.md](../CLAUDE.md) under "Dashboard DB Tables" has the operational behavior reference: source priority ordering, keepalive cadence, net_devices writeback, the Tuya silent-freeze watchdog, etc. This file (DEVICE/CLAUDE.md) is the **file-location + adapter-inventory** index; root CLAUDE.md is the **behavior reference**.
