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
| `main-agent-quick.service` + `main-agent-quick.timer` | oneshot | Every 5 min (3 min after boot) | Quick run: schedule + errors + data freshness (no SSH, no retention) |

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
- Schedule check per agent
- **Error check per agent** (added 2026-05-07) — symmetric raise/resolve of `agent_hard_errors`. Was full-run-only; moved to quick so the alert auto-resolves within 5 min once `ERR:` rows roll out of the last-10-rows window, instead of waiting up to 60 min for the next full pass. Cost: ~12 small SELECTs every 5 min.
- Data freshness check (`raw_data`)
- Weather freshness check (`raw_weather`)
- Backup freshness check
- No SSH, no service auto-restart, no retention cleanup

---

## Registered Agents

| name | LXC | IP | service | data_table | settings_table | oneshot |
|------|-----|----|---------|-----------|---------------|---------|
| `boiler` | 103 | 192.168.1.114 | `boiler-agent` | `agent_boiler_data` | `agent_settings` | false |
| `analyzer` | 100 | 192.168.1.138 | `analyzer` | `analyzer_log` | none | false |
| `player` | 100 | 192.168.1.138 | `player` | none | none | false |
| `ingest` | 100 | 192.168.1.138 | `ingest` | none | none | false |
| `main-agent` | 105 | 192.168.1.187 | `main-agent` | none | none | true |
| `whisper-http` | 106 | 192.168.1.188 | `whisper-http` | none | none | false |
| `privacy` | 109 | 192.168.1.196 | `docker` | none | none | false |

> The canonical agent list is the **`agents` table on LXC 102** (`SELECT * FROM agents WHERE enabled=true`); the orchestrator reads it every run, so adding an agent = INSERT a row (no code deploy). The table above shows the service-monitored agents; several dashboard-only agents (balcony, bedroom, living-room, medical, my-bathroom, device-agent, pixoo, rule-engine) also have rows.
>
> **`privacy` (LXC 109, added 2026-06-15):** Vaultwarden + Caddy run via Docker with `restart=unless-stopped`, so the monitored unit is **`docker`** itself — if it's down the orchestrator restarts it and the containers recover; persistent failure raises `service_down:privacy`. No data/settings table (service-check only). **Prereq done:** LXC 105's `/root/.ssh/id_ed25519.pub` was added to LXC 109's `/root/.ssh/authorized_keys` (the orchestrator SSHes as root) — without it the check would raise `service_ssh_failed`. Any new service-monitored LXC needs the same key-trust step.

> **Not registered:** `media-agent.service` on LXC 100 — wrapper service; individual sub-agents (analyzer, player, ingest) are registered instead. `media-agent.service` itself is not monitored by the orchestrator.

### Per-agent monitoring detail

| Agent | Schedule check | Error check | Service check |
|-------|---------------|-------------|---------------|
| `boiler` | ✓ (`agent_boiler_data.next_ts`) | ✓ (last 10 rows) | ✓ `systemctl is-active boiler-agent` on LXC 103 |
| `analyzer` | ✓ (`analyzer_log.next_ts`) | ✓ (last 10 rows) | ✓ `systemctl is-active analyzer` on LXC 100 |
| `player` | — (no data_table) | — | ✓ `systemctl is-active player` on LXC 100 |
| `ingest` | — (no data_table) | — | ✓ `systemctl is-active ingest` on LXC 100 |
| `main-agent` | — (no data_table) | — | ✓ `systemctl is-active main-agent.timer` on LXC 105 |
| `whisper-http` | — (no data_table) | — | ✓ `systemctl is-active whisper-http` on LXC 106 |

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
| `backup_overdue` | last successful backup > `max_age_hours + 4h` | warn | `backup:<job name>` |
| `rule_error` | Rule auto-disabled after N consecutive evaluate() failures (raised by rule_engine itself, not orchestrator) | warn | `rule_engine` |
| `rule_load_error` | Rule file fails to import, missing RULE dict, missing required keys, or missing evaluate() — raised by rule_engine at load time | error | `rule_engine` |
| `rule_engine_state_save_failed` | `save_shared_state()` failed 5 times in a row — shared state may be stale | error | `rule_engine` |

- Alerts are **raised once** — no duplicates while condition persists
- Alerts **auto-resolve** when condition clears on next run
- `agent_schedule_check_failed`, `check_errors`, and `check_backup_freshness` all use SAVEPOINTs so a DB error in one check doesn't abort the outer transaction
- The three `rule_*` alerts are raised by the **rule engine on LXC 105**, not by the orchestrator. The orchestrator never generates them, but they appear in `system_alerts` and are surfaced on the dashboard Health page like any other alert. They do not auto-resolve — a rule file must be fixed/reloaded, or the state-save condition must recover, for them to stop being raised.

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
Dashboard health page reads `system_alerts` directly to surface agent service status — `boiler_agent`, media agents (analyzer, player, ingest), and `whisper-http` all show red if an active `service_down` or `service_ssh_failed` alert exists for that agent.

### `backup_storages`
```
id SERIAL PK, name TEXT, type TEXT, host TEXT, share TEXT,
smb_user TEXT, smb_pass TEXT, mount_path TEXT, description TEXT, created_at TIMESTAMPTZ
```
Mount path = pre-mounted CIFS path on LXC 104 (e.g. `/mnt/qnap-claude`). Used by backup script to resolve destination without SMB remounting.

### `backup_jobs`
```
id SERIAL PK, name TEXT, source_host TEXT, source_path TEXT,
storage_id INT → backup_storages, dest_subdir TEXT,
max_age_hours INT, retry_interval_min INT, retention INT,
enabled BOOL, run_now BOOL, created_at TIMESTAMPTZ
```
`run_now=TRUE` triggers immediate backup on next cron tick (cleared on success only — failed run_now retries).

### `backup_log`
```
id SERIAL PK, job_id INT → backup_jobs, started_at TIMESTAMPTZ,
finished_at TIMESTAMPTZ, status TEXT, size_bytes BIGINT, message TEXT
```
`status` values: `running`, `ok`, `failed`, `unreachable`. Retention: 90 days, auto-clean daily.

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
| `sync_signals` | 7 | ✓ | 24 | raw_data producer signals for boiler agent wake-up (written by `wf96c_ingest` since 2026-04-23) |
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
| `backup_storages` | forever | ✗ | — | Windows backup storage definitions |
| `backup_jobs` | forever | ✗ | — | Windows backup job definitions |
| `backup_log` | 90 | ✓ | 24 | Windows backup run history |

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

---

## Known Incidents & Runbooks

### HA token invalidated (2026-04-06; runbook refreshed 2026-04-23)
**Symptom:** `weather_stale` alert raised; `collect_weather` cron fails with HTTP 401 from 192.168.1.110:8123. `boiler-mqtt-ingest` logs `HA valve fetch failed: 401` (temps keep flowing from MQTT, but valve_state becomes stale after 30s cache expiry). Boiler decisions can drift if the cached valve state no longer matches reality.
**Cause:** HA (LXC 101) restarted with a wiped token database (crash/restore from backup). Long-lived tokens are stored in HA's database — a DB reset invalidates all of them.
**Fix:**
1. **Test old token first**: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <old>" http://192.168.1.110:8123/api/` — if `200`, token still valid, just restart the failing service. If `401`, proceed.
2. HA UI → profile → Long-Lived Access Tokens → create new token → **save to password manager immediately**
3. Update `BOILER/dashboard/.env` → `HA_TOKEN=<new>` — restart: `cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`
4. Update `/etc/environment` on LXC 100 → `HA_TOKEN=<new>` — restart tv_control.py
5. Update `/etc/environment` on LXC 103 → `HA_TOKEN=<new>` — used only by `collect_weather` cron (no restart needed; picks up the new value on next 60-min tick)
6. Update `/etc/boiler-agent.env` on LXC 103 → `HA_TOKEN=<new>` — restart **both** services that consume this env file: `systemctl restart boiler-agent.service boiler-mqtt-ingest.service`
7. Update MCP config → `cline_mcp_settings.json` → `HA_TOKEN` env var — reload VS Code
8. Run collect_weather manually on LXC 103
9. Trigger orchestrator: `ssh root@192.168.1.187 "systemctl start main-agent-quick.service"`

**All 5 token locations:**
- `BOILER/dashboard/.env` — restart: `cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`
- `/etc/environment` on LXC 100 (tv_control.py) — restart: kill + nohup tv_control.py
- `/etc/environment` on LXC 103 (collect_weather only — `ha_to_pg` cron was retired 2026-04-23 in favor of `boiler-mqtt-ingest`) — no restart needed
- `/etc/boiler-agent.env` on LXC 103 (read by `boiler-agent.service` AND `boiler-mqtt-ingest.service`) — restart **both**: `systemctl restart boiler-agent.service boiler-mqtt-ingest.service`
- `cline_mcp_settings.json` (MCP HA server) — restart: VS Code reload window
**Prevention:** A dedicated `ha_down` TCP check on 192.168.1.110:8123 would give a clearer alert than waiting for `data_stale`/`weather_stale` — not yet implemented.
