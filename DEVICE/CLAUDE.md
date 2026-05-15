# Device Agent

Cross-protocol device aggregator running on LXC 103 as `device-agent.service`. Unifies live state from Tuya local TCP, Tuya gateway (Zigbee sub-devices), Tuya cloud push (Pulsar), Home Assistant WebSocket (SmartThings / Ring / Aqara FP2 / vacuums), Home Connect (BSH Siemens appliances), and Zigbee2MQTT into a single `devices` table + per-device MQTT publish path.

## File Locations

| Artifact | Path |
|---|---|
| Service unit (deployed to `/etc/systemd/system/`) | [`DEVICE/device-agent.service`](device-agent.service) |
| Main loop | [`DEVICE/agent/device_agent.py`](agent/device_agent.py) |
| **Adapters (canonical repo source)** | [`DEVICE/agent/adapters/`](agent/adapters/) |
| Deploy target on LXC 103 | `/opt/device-agent/agent.py` + `/opt/device-agent/adapters/*.py` |
| Memory | [`memory/project_context.md`](../.claude/projects/c--Users-muroc-project-home/memory/project_context.md) (general project context) |

## Adapter inventory

All files in `DEVICE/agent/adapters/` are the **canonical repo source** for the live `/opt/device-agent/adapters/*.py` on LXC 103. Deploy = `scp DEVICE/agent/adapters/<adapter>.py root@192.168.1.114:/opt/device-agent/adapters/<adapter>.py` + `systemctl restart device-agent`.

| File | Role | Status |
|---|---|---|
| `__init__.py` | package marker | stable |
| `base.py` | `DeviceAdapter` abstract base class | stable |
| `tuya.py` | Local Tuya TCP per-device threads + gateway Zigbee hub. Watchdog respawns silent threads (since 2026-05-15). | active development |
| `tuya_cloud.py` | Tuya Cloud API client. **Keepalive branch for `device_type='remote'`** (since 2026-05-15) bumps `last_seen` on a successful empty-DPS poll — handles the Tuya `wnykq` IR-hub class whose cloud spec has zero DPS, so a normal poll returns `{}` and the original `if dps:` would skip on_state_change. Scoped to remotes; other cloud-poll devices unaffected. | active development |
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

# Verify post-deploy
ssh root@192.168.1.114 'systemctl is-active device-agent && journalctl -u device-agent --since "30 sec ago" | grep -iE "error|started" | head'
```

## Behavior reference

The Device Agent System bullet in [root CLAUDE.md](../CLAUDE.md) under "Dashboard DB Tables" has the operational behavior reference: source priority ordering, keepalive cadence, net_devices writeback, the Tuya silent-freeze watchdog, etc. This file (DEVICE/CLAUDE.md) is the **file-location + adapter-inventory** index; root CLAUDE.md is the **behavior reference**.
