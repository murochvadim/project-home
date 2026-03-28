# Boiler Project — TODO

## General


## Agent


## Dashboard


## Bugs

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


 