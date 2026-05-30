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
| `tuya.py` | Local Tuya TCP per-device threads + gateway Zigbee hub. Watchdog respawns silent threads (since 2026-05-15). **Local-key rotation auto-recovery (since 2026-05-30):** each per-device thread increments `_per_dev_904_count[dev_id]` on every `Err 904` response (Tuya's "Unexpected Payload" — encryption mismatch = stale local_key after the user re-paired in the Tuya app) and resets it to 0 on any successful read. The watchdog (already running every `WATCHDOG_INTERVAL_SEC = 300 s`) checks this counter; when it exceeds `KEY_REFETCH_904_THRESHOLD = 5` AND the per-device throttle (`KEY_REFETCH_THROTTLE_SEC = 1800` = 30 min) has elapsed, it queries the Tuya cloud via `cloudrequest('/v1.0/devices/<id>')` for the device's current `local_key`. If the cloud's key differs from `devices.local_key`, the watchdog UPDATEs the row (sets `last_source='cloud_key_refresh'` for journal-trail), writes the new key into `self._per_dev_key[dev_id]` (the per-device thread reads this on every reconnect), and signals the per-device `force_reconnect` event. The reconnect picks up the fresh key + the TCP channel comes back without a service restart. If the cloud's key MATCHES the DB, the counter is reset and an INFO log notes that the 904 cause is something else (firmware bug, peer mismatch) — preventing infinite refetch loops on devices that aren't actually rotated. Throttle prevents bursting Tuya's cloud API if the cloud's key is ALSO wrong (extremely unlikely). Resolves the silent failure mode that kept Guy Room window Light on the cloud channel (`last_source='ha_api'`) for 14+ days before being noticed on 2026-05-30. Distinct from `Err 901` (network unreachable) which the existing UDP-broadcast IP rediscovery + silent-freeze watchdog already handle, and from device-side TCP-listener hangs (sustained 901 with UDP-find-succeeds + cloud-online — NOT fixable in code, requires physical power-cycle of the device). **UDP-broadcast IP rediscovery (since 2026-05-27):** `tinytuya.find_device(dev_id)` runs at the start of every reconnect iteration after the first (when `attempt > 0`). If the cached IP differs from the device's current broadcast-announced IP, the local variable updates AND the new IP is persisted to BOTH `devices.local_ip` AND `net_devices.ip` (via MAC subquery) in a single short-lived psycopg2 transaction. Self-heals from DHCP rotation within one reconnect cycle (~30 s) — no manual SQL, no restart needed. **Double-write is load-bearing:** the `device_agent.py` startup query uses `COALESCE(net_devices.ip, devices.local_ip)`, so persisting only to `devices.local_ip` would have the next restart pick the stale `net_devices.ip` and refire rediscovery anyway — exactly what happened across 4+ restart cycles on 2026-05-27 before the gap was found. The same-day audit also closed the second half of the loop in `device_agent._db_write` (both `keepalive` and state-change branches now read `mac, local_ip` via `RETURNING` from the UPDATE they already run, instead of trusting the stale startup-cached `_device_net_info` dict — the cache was overwriting `net_devices` with old values every 5 min and undoing rediscovery). Proven 2026-05-27 on `Aura Air switch` (.199 → .196), `Gas sensor` (.118 → .107), `Balcony Wall Flowers Light` (.135 → .133), `Guy Room window Light` (.175 → .178) — the last two confirmed booting straight to the correct IP across a deliberate restart after the double-write landed. Devices that don't broadcast (offline or non-stock firmware) get a `rediscovery timed out` INFO log and fall back to the cached IP. | active development |
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

## Behavior reference

The Device Agent System bullet in [root CLAUDE.md](../CLAUDE.md) under "Dashboard DB Tables" has the operational behavior reference: source priority ordering, keepalive cadence, net_devices writeback, the Tuya silent-freeze watchdog, etc. This file (DEVICE/CLAUDE.md) is the **file-location + adapter-inventory** index; root CLAUDE.md is the **behavior reference**.
