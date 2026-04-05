# Orchestrator (Main Agent) — LXC 105

## Overview
The Main Agent is the system-wide orchestrator. It monitors all registered agents, auto-restarts failed services, runs DB retention cleanup, and raises/resolves alerts in `system_alerts`.

- **LXC**: 105 — IP `192.168.1.187`
- **Script**: `/opt/main-agent/project/ORCHESTRATOR/orchestrator.py`
- **Local script**: `ORCHESTRATOR/orchestrator.py`
- **Venv**: `/opt/main-agent/venv`
- **Env file**: `/etc/main-agent.env` (contains `DB_PASS`)
- **Git repo**: cloned at `/opt/main-agent/project` (same GitHub repo as all agents)
- **SSH key**: `/root/.ssh/id_ed25519` — authorised on all agent LXCs for service checks

---

## Systemd Units

| Unit | Type | Schedule | Role |
|------|------|----------|------|
| `main-agent.service` + `main-agent.timer` | oneshot | Every 1h (2 min after boot) | Full run: schedule + errors + SSH + retention + VACUUM |
| `main-agent-quick.service` + `main-agent-quick.timer` | oneshot | Every 5 min (3 min after boot) | Quick run: schedule + data freshness only (no SSH, no retention) |

Local unit files: `ORCHESTRATOR/main-agent.service`, `ORCHESTRATOR/main-agent.timer`, `ORCHESTRATOR/main-agent-quick.service`, `ORCHESTRATOR/main-agent-quick.timer`

---

## Full Run vs Quick Run

### Full run (every 1h)
For each registered agent:
1. **Schedule check** — is `data_table.next_ts` overdue by >5 min?
2. **Error check** — any `ERR:` prefixed rows in last 10 rows of `data_table`?
3. **Service check + auto-restart** — SSH to agent's LXC; `systemctl is-active <service>`; if down → `systemctl restart`; re-checks; raises `service_down` only if still failing
4. **Data freshness** — `raw_data` age > 15 min → `data_stale` alert for boiler
5. **Weather freshness** — `raw_weather` age > 65 min → `weather_stale` alert
6. **Retention cleanup** — deletes old rows per `retention_policies` where `auto_clean=true` and interval elapsed
7. **Weekly VACUUM ANALYZE** — runs outside transaction if >7 days since last
8. **Summary log** — active alert count or "all OK"

### Quick run (every 5 min) — `--quick` flag
- Schedule check only (no SSH, no error scan, no retention)
- Data freshness check (`raw_data`)
- Weather freshness check (`raw_weather`)

---

## Registered Agents

| name | LXC | IP | service | data_table | settings_table | oneshot |
|------|-----|----|---------|-----------|---------------|---------|
| `boiler` | 103 | 192.168.1.114 | `boiler-agent` | `agent_boiler_data` | `agent_settings` | false |
| `analyzer` | 100 | 192.168.1.138 | `analyzer` | `analyzer_log` | none | false |
| `player` | 100 | 192.168.1.138 | `player` | none | none | false |
| `ingest` | 100 | 192.168.1.138 | `ingest` | none | none | false |
| `main-agent` | 105 | 192.168.1.187 | `main-agent` | none | none | true |

> **Not registered:** `whisper-http` on LXC 106 (192.168.1.188) — infrastructure service, not an agent. Not in the agents table; dashboard surfaces transcription errors directly if it goes down.

### Per-agent monitoring detail

| Agent | Schedule check | Error check | Service check |
|-------|---------------|-------------|---------------|
| `boiler` | ✓ (`agent_boiler_data.next_ts`) | ✓ (last 10 rows) | ✓ `systemctl is-active boiler-agent` on LXC 103 |
| `analyzer` | ✓ (`analyzer_log.next_ts`) | ✓ (last 10 rows) | ✓ `systemctl is-active analyzer` on LXC 100 |
| `player` | — (no data_table) | — | ✓ `systemctl is-active player` on LXC 100 |
| `ingest` | — (no data_table) | — | ✓ `systemctl is-active ingest` on LXC 100 |
| `main-agent` | — (no data_table) | — | ✓ `systemctl is-active main-agent.timer` on LXC 105 |

**All three media agents share deploy_path `/opt/media-agent` on LXC 100.**

---

## Alert Types

| alert_type | Trigger | Severity | affected_agent |
|-----------|---------|----------|---------------|
| `agent_overdue` | `next_ts` > 5 min past | error | that agent |
| `agent_no_data` | `data_table` empty | warn | that agent |
| `agent_hard_errors` | `ERR:` in last 10 rows of data_table | error | that agent |
| `service_down` | `systemctl is-active` fails after auto-restart | critical | that agent |
| `service_ssh_failed` | SSH connection to LXC failed | error | that agent |
| `data_stale` | `raw_data` age > 15 min | error/critical | boiler |
| `weather_stale` | `raw_weather` age > 65 min | warn | collect_weather |
| `agent_schedule_check_failed` | DB error during schedule check | error | that agent |

- Alerts are **raised once** — no duplicates while condition persists
- Alerts **auto-resolve** when condition clears on next run
- `agent_schedule_check_failed` uses a SAVEPOINT so a DB error doesn't abort the outer transaction

---

## DB Tables

### `agents`
Agent registry — source of truth for all orchestrator behavior.
```
name PK, description, lxc_id, lxc_ip, service_name,
data_table, settings_table, deploy_path, git_branch,
service_oneshot BOOL, enabled, added_at
```
Adding a new agent = `INSERT INTO agents` → orchestrator + dashboard deploy dropdown pick it up automatically, no code changes.

### `orchestrator_log`
```
id BIGSERIAL PK, ts TIMESTAMPTZ, source VARCHAR(50), severity VARCHAR(10), message TEXT
```
Retention: 30 days, auto-clean daily.

### `system_alerts`
```
id BIGSERIAL PK, ts TIMESTAMPTZ, source, severity, affected_agent,
alert_type, message, resolved_at
```
Retention: 90 days, auto-clean daily.
Active alerts = `resolved_at IS NULL`. Dashboard shows last 50, active first.

---

## Agent Framework Contract
Every agent in the `agents` table must follow:
- **data_table** (if set): must have `ts TIMESTAMPTZ, decision TEXT, error TEXT, next_ts TIMESTAMPTZ`
- **settings_table** (if set): must have `agent_enabled BOOL, run_interval_min INT`
- **error column convention**: `NO ERROR` = ok, `WARN: ...` = soft warning, `ERR: ...` = hard error (triggers alert)
- **Systemd service** on its LXC — orchestrator checks via SSH
- **Retention policies** registered in `retention_policies` on first agent run

---

## Retention Policies (current state)

| Table | keep_days | auto_clean | interval_h | Description |
|-------|-----------|-----------|-----------|-------------|
| `raw_data` | 90 | ✓ | 24 | Raw sensor readings every 5 min |
| `agent_boiler_data` | 365 | ✓ | 24 | Agent decision log |
| `raw_weather` | 60 | ✓ | 24 | Hourly weather readings |
| `raw_weather_daily` | 60 | ✓ | 24 | Daily weather forecasts |
| `sync_signals` | 7 | ✓ | 24 | ha_to_pg signals |
| `orchestrator_log` | 30 | ✓ | 24 | Main agent run logs |
| `system_alerts` | 90 | ✓ | 24 | Cross-agent alerts |
| `analyzer_log` | 30 | ✓ | 24 | Analyzer run log |
| `manual_requests` | 90 | ✓ | 24 | Voice-initiated manual requests |
| `voice_token_log` | 365 | ✓ | 24 | Voice pipeline token usage/cost |
| `media_library` | forever | ✗ | — | Media file metadata |
| `face_crops` | forever | ✗ | — | Face crop embeddings |
| `face_registry` | forever | ✗ | — | Simple face registry (register-photo → recognize pipeline) |
| `boiler_consumptions` | forever | ✗ | — | Hot water consumption events |
| `agents` | forever | ✗ | — | Agent registry |
| `agent_settings` | forever | ✗ | — | Boiler agent settings |
| `documents` | forever | ✗ | — | Project documentation links |
| `voice_devices` | forever | ✗ | — | Voice device registry |
| `voice_device_entities` | forever | ✗ | — | Voice switch group entity list |
| `voice_device_settings` | forever | ✗ | — | Voice output device and boiler settings |
| `voice_intent_phrases` | forever | ✗ | — | Voice intent phrase library |

Retention uses the `ts` or `detected_at` column (whichever exists). Table and column names validated with regex before use in dynamic SQL.

---

## Deploy

### Via dashboard
- Dashboard Settings tab → Deploy card → agent dropdown (populated from `agents` table via `GET /api/agents`)
- `POST /api/deploy {agent}` → looks up `lxc_ip`, `service_name`, `deploy_path`, `git_branch`, `service_oneshot` → SSH → `git pull` → `systemctl restart` (persistent) or `systemctl start .timer` (oneshot)

### Manual deploy of orchestrator itself
```bash
scp ORCHESTRATOR/orchestrator.py root@192.168.1.187:/opt/main-agent/project/ORCHESTRATOR/orchestrator.py
ssh root@192.168.1.187 "systemctl start main-agent.service && systemctl is-active main-agent.timer"
```

### Deploy systemd units (first-time or after unit file changes)
```bash
scp ORCHESTRATOR/main-agent.service root@192.168.1.187:/etc/systemd/system/
scp ORCHESTRATOR/main-agent.timer root@192.168.1.187:/etc/systemd/system/
scp ORCHESTRATOR/main-agent-quick.service root@192.168.1.187:/etc/systemd/system/
scp ORCHESTRATOR/main-agent-quick.timer root@192.168.1.187:/etc/systemd/system/
ssh root@192.168.1.187 "systemctl daemon-reload && systemctl enable main-agent.timer main-agent-quick.timer && systemctl start main-agent.timer main-agent-quick.timer"
```

---

## Security Notes
- Table and column names used in dynamic SQL are validated against `^[a-z_][a-z0-9_]*$` — prevents injection even if DB is compromised
- Service names validated against `^[a-zA-Z0-9_.-]+$` before use in SSH shell commands
- SSH uses key auth only (`/root/.ssh/id_ed25519`), no passwords
