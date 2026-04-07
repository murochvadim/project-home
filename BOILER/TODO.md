# Boiler Project — TODO

## Do Steps
# Step_0. Media System
> Status: thinking — confirm approach before starting

- [ ] Step_0.1 — Plex: install on QNAP, get IP + token
- [ ] Step_0.2 — Dashboard Media page: browse library thumbnails, click to cast to TV
- [ ] Step_0.3 — SmartThings: TV + Soundbar power, volume, input switch from dashboard
- [ ] Step_0.4 — Voice commands: play movie, switch audio to soundbar, turn off TV
- [ ] Step_0.5 — LXC 100: decide final role once media approach confirmed


## hook

# Step_1.
 
# Step_2.
 

# Step_3. 


# Step_4.
 

# Step_5.
 

# Step_6.


# Step_7.


 # Step_8.
  Selector output of sound not working 

# Step_9.


## Not to do more now   

8. Use the Fuzzy Matching method in request hendler of voice 

9. 2 models on same LXC - For Hebrew: ivrit-ai/whisper-large-v3-turbo-ct2 and for Russian: Systran/faster-whisper-large-v3-turbo or Ash8181/whisper-large-v3-russian-ct2 . wake word can decide which lang is to use 

10. 
## 10.----------------------------------------------------
 2 values det_score and cosine similarity  

## 11.-----------------------------------------------------
# BACKUP.
Purpose: Overall BackUp solution and BackUp presentation in Project envirement.
Create new Tab Backups   Project Health.
Use Proxmox VE API.
Use LXC 104 for created scripts. 
Backup storage QNAP ,name MUROCHNAS, folder DataVol1/ PBS_Data/ , Achived by NFS.   
# A.
Proxmox datacenter BackUp instruments used for all VMs or LXCs. I want to show all of them with last run,retention. 
# B.
I want BackUp instrument used Proxmox VE API for BackUp the rest files/folders/image in Project envirment.  
like Project folder ,like Laptop Image Backup
# C.
 




## Agent

### Future: Diagnostic Agent
**Goal:** Read active alerts from `system_alerts`, diagnose root cause, and either auto-fix (safe actions) or inform what to do.
**Trigger:** runs after orchestrator checks, only when unresolved alerts exist
**Location:** LXC 105 (has SSH keys to all LXCs)
**Design:**
- Detect `agent_hard_errors` with `ERR: 401` → identify as HA token invalidation → post step-by-step fix instructions to `orchestrator_log` + dashboard alert
- Detect `service_down` after failed auto-restart → suggest manual intervention steps
- Detect `backup_overdue` → check LXC 104 cron + mount points, report findings
- Auto-fix only for safe/reversible actions (service restarts already done by orchestrator)
- All other cases: enrich the existing alert with a `diagnosis` field showing exactly what to do
**Why:** HA token invalidation took multiple sessions to fully diagnose (5 token locations discovered one by one). A diagnostic agent would surface all of them immediately.


## Dashboard


## Bugs
- [ ] TV volume display not updating after volume_up/down — HA `media_player.samsung_85_qled` volume_level attribute doesn't push state back after volume commands

---

# Roadmap

┌─────────────────────────────────────────┐
│           Orchestrator (Claude)         │
│  - scheduling    - coordination         │
│  - shared tools  - anomaly detection    │
└──────────────┬──────────────────────────┘
               │ shared infrastructure
    ┌──────────┴────────────┐
    │   Common Tools Layer  │
    │  read_db  write_db    │
    │  call_ha  get_state   │
    └──────────┬────────────┘
               │
    ┌──────────┴────────────┐
    │   Policy Agent        │  ← one, works for ALL agents
    │   (Claude, daily)     │
    └───────────────────────┘

    agents/
  boiler/
    decision.py     ← deterministic rules
    settings_schema  ← what settings it has
    db_tables        ← its own data tables
    dashboard/       ← already exists ✓

  lights/           ← plug in, framework already there
    decision.py
    settings_schema
    db_tables
    dashboard/

  presence/         ← same
    decision.py
    ...


## Step 1 — Perfect Boiler Agent (current)
Fine-tune the boiler agent until it runs reliably and makes correct decisions
across all real-world scenarios: probe logic, waiting phase, normal decisions,
safety rules. Tune settings (debounce, probe_interval_min, trend_runs) based
on observed data. The boiler agent becomes the reference implementation.

### ✅ Code fixes completed (2026-03-28)

#### Critical
- [x] `ha_to_pg_updated.py` — hardcoded HA token + DB password moved to env vars
- [x] `ecosystem.config.js` — hardcoded HA token + Anthropic API key moved to `.env` file
- [x] Anthropic API key revoked and replaced with new key in `.env`

#### High — logic breaks
- [x] `orchestrator.py` — `check_schedule` now uses SAVEPOINT so a DB error doesn't abort the outer transaction and silently roll back the entire orchestrator run
- [x] `orchestrator.py` — `agent_schedule_check_failed` alert now resolved when schedule check succeeds (previously it latched permanently and blocked the boiler agent)

#### Medium — correctness
- [x] `orchestrator.py` — `DATA_STALE_MIN` raised 10 → 15 min (zero latency margin with ha_to_pg running every 5 min)
- [x] `boiler_agent.py` — warn-level `system_alerts` are no longer silently ignored; warning is now included in the `error` field and run continues
- [x] `boiler_agent.py` — waiting phase detection: search window enlarged to `trend_runs * 2 + 5` rows so increasing `trend_runs` mid-phase doesn't hide the `turn_on` row
- [x] `server.js` — probe countdown `minutesToEnd` now uses `Intl.DateTimeFormat` to read Jerusalem time directly — no longer wrong for non-Jerusalem machine timezones

#### Low — edge cases & hygiene
- [x] `boiler_agent.py` — `op_end` (19:00) now uses `TIMEZONE.localize()` instead of `now.replace(hour=19)` — DST-safe on Israel's two transition days per year
- [x] `collect_weather.py` — `collect_daily` now checks for existing `forecast_date` before inserting — no duplicate rows on re-run or double cron fire
- [x] `collect_weather.py` — docstring corrected: "runs every hour" → "runs every 30 min via cron"
- [x] `graph.js` — consumption tooltip now uses a `spikeConsumption` index map instead of `indexOf(start_temp)` — unambiguous when two events share the same temperature

- [x] Health dashboard — System Status card expanded with 6 new checks (orchestrator, collect_weather, active alerts, boiler last decision, orchestrator last run) grouped by Infrastructure / Services / Scripts / Server
- [x] Windows SSH key authorized on LXC 105 — dashboard can now check orchestrator service status
- [x] All fixes deployed to LXC 103 + LXC 105 via git pull (2026-03-28)

### ⏳ Still to do — operational (requires being on home network)

- [ ] Deploy all code fixes to LXC 103 (git pull + restart boiler-agent service)
- [ ] Verify orchestrator run after fixes (check orchestrator_log + system_alerts)
- [ ] Observe 2–3 days of `agent_boiler_data` — validate probe, waiting phase, normal decisions
- [ ] Tune settings if needed: `probe_interval_min`, `temp_debounce`, `trend_runs`
- [ ] Confirm `agent_schedule_check_failed` alert auto-resolves cleanly on next orchestrator run
- [ ] HA token rotation (token was committed to git — create new HA long-lived token, update `.env`)

### ⏳ Still to do — remaining low-priority code issues

- [ ] `ha_to_pg_updated.py` — uses `dbname` key; all other files use `database` (cosmetic inconsistency, both valid in psycopg2)
- [ ] `boiler_agent.py` — valve transition that happened just before the trend window opens is not captured (minor edge case, affects trend filtering only)
- [ ] `boiler_agent.py` — `ts` column uses DB `NOW()`, `next_ts` uses agent clock — clock skew between LXC and DB host could skew overdue detection
- [ ] `server.js` — `pm2.cmd` is Windows-only; will fail silently if dashboard is ever deployed to Linux
- [x] `system_alerts` DDL was duplicated in `create_alerts.sql` and `server.js` — `create_alerts.sql` deleted, `server.js` is now the single source of truth

---

## Step 2 — Policy Agent
Add a Claude-powered Policy Agent that runs once daily (e.g. at 20:00).
It reads the last 7 days of agent_boiler_data, analyses performance patterns
(probe success rate, valve toggle frequency, waiting phase outcomes), and
automatically adjusts agent_settings with reasoning. Changes are logged to a
new policy_updates table and shown on the dashboard.
- Why: the boiler agent is deterministic (fast, safe for hardware control).
  The Policy Agent adds the AI learning layer on top — it tunes the rules
  rather than replacing them.

### Probe Analysis (part of Policy Agent)
- Cross-reference probe events in `agent_boiler_data` with `boiler_consumptions`
  to exclude consumption-caused temp drops from probe outcome classification
- For each probe: measure true boiler temp delta (raw_data) after excluding
  consumption windows → classify as `beneficial` / `neutral` / `harmful`
- Correlate with weather at time of probe (UV, condition from `raw_weather`)
- Output recommendation: adjust `probe_interval_min` up or down
- Optionally write recommendation to a `probe_analysis` table + update `agent_settings`
- Why AI only: consumption events and probe effects overlap in time —
  rule-based logic cannot reliably separate them

## Step 3 — Multi-Agent Framework
After Step 2, extract the proven patterns from the boiler agent + policy agent
into a reusable framework. Every future agent (lights, presence, irrigation)
plugs into the framework without rebuilding it.
Framework provides:
  - Shared orchestrator (scheduling, coordination)
  - Common tools layer (DB read/write, HA calls)
  - Policy Agent that works for ALL agents automatically
  - Dashboard sections (sidebar already prepared)
  - Shared DB on LXC 102, shared HA connection
Each new agent only needs: decision logic + settings schema + DB tables.
- Why build framework last: by step 3 we have two real working agents.
  Every framework design decision is based on proven patterns, not
  assumptions. No over-engineering.
