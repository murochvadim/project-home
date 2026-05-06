---
description: Create, edit, audit, or remove a dashboard agent (full framework — DB registration, dashboard page, sidebar, docs, memory, optional service layer, optional MQTT, optional rules group, retention policies)
user-invocable: true
---

# /create-agent — Full Agent Framework Scaffolder

You are scaffolding or modifying a complete "agent" — a namespaced system component with its own DB registration row, dashboard page, sidebar link, docs, memory, and optionally: LXC systemd service, data/settings tables, MQTT credentials, rules group.

Agents already in the system: Boiler (LXC 103), Device (LXC 103), Media (LXC 100), Corridor (LXC 100), Voice (LXC 106), Main/Orchestrator (LXC 105).

The canonical registration point is the `agents` table on LXC 102 (PostgreSQL) — a single row there drives orchestrator auto-discovery, `/api/agents` deploy dropdown, `/api/deploy` git-pull+restart, and Health page Services card.

Follow this interactive flow step by step. Use AskUserQuestion for each step. Do NOT skip steps or assume answers. Do NOT create or execute anything until Step 13 explicit Y/N confirmation.

## Step 0: Action

Ask what the user wants to do:
- **Create** — scaffold a new agent end-to-end
- **Edit** — targeted modification of one specific field / component
- **Audit** — validate an existing agent against the current framework standard, show drift, apply fixes per item
- **Remove** — delete an agent fully

If **Remove**:
  1. Query `SELECT name, description, lxc_id FROM agents ORDER BY name` — show list
  2. Confirm selection (explicit "yes delete <name>")
  3. Delete local files: `BOILER/dashboard/public/<slug>.html`, `BOILER/dashboard/public/js/<slug>.js`, `memory/project_agent_<slug>.md`, `<AGENT_DIR>/` (directory includes CLAUDE.md + migrations/, always present regardless of service layer)
  4. Sed-remove sidebar link from 9 HTML files
  5. Remove row from root `CLAUDE.md` Dashboard Pages table
  6. Remove line from `memory/MEMORY.md`
  7. Generate + run teardown SQL: `<AGENT_DIR>/migrations/teardown.sql` with:
     ```sql
     DELETE FROM agents WHERE name = '<slug>';
     DROP TABLE IF EXISTS agent_<slug>_data;
     DROP TABLE IF EXISTS agent_<slug>_settings;
     DELETE FROM retention_policies WHERE table_name LIKE 'agent_<slug>_%';
     DELETE FROM dashboard_settings WHERE key LIKE '<slug>.%';
     ```
  8. Print LXC manual-cleanup commands (stop+disable+remove service, remove /etc/<slug>-agent.env, remove MQTT user+ACL)
  9. `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`

If **Edit**: ask what to change (rename, slug rename, sidebar section, add/remove tab, storage mode change, service layer add/remove, rule group change, DB table columns). Apply changes with same confirm-before-write discipline. For DB changes, generate migration SQL + auto-execute.

If **Audit**: see the Audit Flow section below.

If **Create**: continue with the Create steps below (Step 1 onwards).

---

## Audit Flow (compare existing agent to current framework standard)

Goal: detect drift between an existing agent and what `/create-agent` would produce today. Report every drift, then ask per-item whether to fix.

### Audit Step A: Pick agent(s)

Query agents table:
```sql
SELECT name FROM agents ORDER BY name
```

Ask the user: which agent to audit? Offer:
- Specific agent name from the list
- `all` — audit every registered agent one by one

### Audit Step B: Collect current state per agent

For the chosen agent `<slug>`, gather:

1. **DB row** — `SELECT * FROM agents WHERE name = '<slug>'`
2. **Owned tables** — from the `agents` row (`data_table`, `settings_table`) plus any table with naming pattern `<slug>_*` or `agent_<slug>_*`
3. **Retention policies** — `SELECT * FROM retention_policies WHERE table_name IN (<owned tables>)`
4. **Dashboard files**:
   - `BOILER/dashboard/public/<slug>.html` exists?
   - `BOILER/dashboard/public/js/<slug>.js` exists?
5. **Sidebar links** in 9 HTML files — grep each for `href="<slug>.html"`; expected: 1 per file
6. **Root CLAUDE.md Dashboard Pages row** — grep for `\`<slug>.html\``
7. **Memory** — `memory/project_agent_<slug>.md` exists? Listed in `MEMORY.md`?
8. **Service files** (if `service_name` is set):
   - `<AGENT_DIR>/agent/<service>.service` exists locally?
   - `.timer` file exists if `service_oneshot=true`?
9. **Own CLAUDE.md** (required for every agent — pointer index if dashboard-only, full doc if service) — `<AGENT_DIR>/CLAUDE.md` exists?

### Audit Step C: Compare to standard — drift checklist

For the collected state, check each item against what Create would produce today. Produce a structured report:

```
AUDIT REPORT — agent: <slug>
═══════════════════════════════════════════════════════════

DB registration (agents table)
  ✓ Row present
  ✗ description is NULL — Create sets a 1-sentence description
  ⚠ deploy_path is '/opt/Agents-agent/project' — Create default is '/opt/<slug>-agent'; legacy value, safe to keep

Dashboard layer
  ✓ public/<slug>.html exists
  ✓ public/js/<slug>.js exists
  ✗ Sidebar link missing in: network.html, general.html  (link found in 7/9)
  ✓ Root CLAUDE.md Dashboard Pages row present

Memory layer
  ✗ memory/project_agent_<slug>.md missing
  ✗ MEMORY.md index line missing

Service layer  (service_name = '<slug>-agent')
  ✓ <AGENT_DIR>/agent/<slug>-agent.service exists
  ✗ <AGENT_DIR>/CLAUDE.md missing (required for every agent — pointer index or full doc)

Tables owned (<table names>)
  ✓ <table_a> has retention_policy row (90d, auto_clean=true)
  ✗ <table_b> has NO retention_policy row — Create requires one
  ⚠ <table_c> exists but not referenced in agents row data_table/settings_table

Rule engine
  ⚠ No rule files found matching group='<slug>' — if agent owns rules, use /create-rule
```

Legend: ✓ OK, ✗ drift (missing/broken), ⚠ deviation (non-standard but may be intentional — ask before fixing).

### Audit Step D: Per-item fix decisions

For each `✗` or `⚠` entry, ask the user: fix / skip / leave.

Fix actions by drift category:

| Drift | Fix action |
|-------|-----------|
| `description is NULL` | Ask user for description, `UPDATE agents SET description = %s WHERE name = '<slug>'` |
| `deploy_path is legacy` | Ask user: normalize to standard path (risky — would break `/api/deploy` unless files moved) or keep |
| `Sidebar link missing in X files` | Sed-inject into each missing file under the stored sidebar section |
| `Root CLAUDE.md Dashboard Pages row missing` | Ask for purpose text, append row |
| `Memory file missing` | Generate from template using current DB row + filesystem state |
| `MEMORY.md index missing` | Append line |
| `own CLAUDE.md missing` | Generate skeleton; ask user to fill in Purpose / Overview |
| `Retention policy missing for table X` | Ask keep_days + auto_clean, generate INSERT |
| `Table exists but not in agents row` | Ask if table should be added as `data_table` or `settings_table` or left as feature-owned |
| `service file missing` | Generate from template |
| `timer file missing (oneshot)` | Generate from template |

### Audit Step E: Generate migration + apply

Collect all approved fixes:
1. Write accumulated SQL to `<AGENT_DIR>/migrations/audit_<yyyymmdd>.sql` (idempotent statements)
2. Write new local files (memory, service, own CLAUDE.md, etc.)
3. Sed-inject missing sidebar links
4. Show final manifest
5. Explicit Y/N to apply
6. On yes: auto-execute SQL via LXC 104 → psql 102 (same pattern as Create Step 14a), then restart dashboard (`pm2 delete && pm2 start`)
7. Print any LXC commands needing manual run (per Q1 hybrid)

### Audit Step F: Report

Print a final summary:
```
Audit complete for <slug>:
  Fixed: <N>
  Skipped: <M>
  Left as-is: <K>
Run /create-agent audit again after N days to verify drift stays zero.
```

### When user picks 'all' in Audit Step A

Loop through each agent sequentially:
1. Show AUDIT REPORT per agent
2. Ask per-item decisions per agent (or offer batch mode: "fix all ✗ items across all agents?" — bulk apply)
3. Final consolidated summary at the end

---

## Step 1: Identity

Ask:
- "Agent display name?" (e.g., `Living Room Agent`)
- Auto-suggest URL slug from name, lowercase-kebab-case (e.g., `living-room`). Ask to confirm or override.

Validate:
- `BOILER/dashboard/public/<slug>.html` does NOT already exist
- `SELECT name FROM agents WHERE name = '<slug>'` returns no row (use mcp__postgres-lxc__query)
- Slug is lowercase letters + digits + single hyphens
- Slug does NOT collide with reserved pages: `index`, `health`, `network`, `general`, `main-agent`, `media`, `corridor`, `devices`, `voice`, `viewer`

Store: `<slug>`, `<name>`, `<description>` (ask for 1-sentence description).

## Step 2: Sidebar Placement

Ask which section the link goes under:
- **Agents** (default — same as Boiler, Media, Corridor, Device, Main)
- **General** (data/infrastructure pages)
- **Voice**
- **Create new section** — ask section label

Determine insertion anchor line per section:
- **Agents**: inject after `<a href="devices.html">Device Agent</a>`
- **General**: inject after `<a href="general.html">Weather</a>`
- **Voice**: inject after `<a href="voice.html">Voice</a>`
- **Custom**: add new `<div class="section-label">X</div>` + link, anchor before `Future Agents` divider

Show resulting sidebar snippet for confirmation.

## Step 3: Initial Tabs

Ask: "Initial tab names (comma-separated). Default: one tab matching the agent name."

Store tabs as list of `(tab_slug, tab_label)` pairs. Will render as tab-bar + empty tab-panels in the generated HTML.

## Step 4: Service Layer

Ask: "Does this agent run its own Python service on an LXC?"
- **None** — dashboard-only agent (like Corridor). Skip Steps 5 + 7 data table scaffolding.
- **Persistent** — long-running Python service (like Boiler, Device Agent). Systemd `Type=simple`, `Restart=always`.
- **Oneshot + timer** — scheduled one-shot runs (like Main Agent). Systemd `Type=oneshot` + `.timer`.

If none: set `service_name=NULL`, `service_oneshot=false`, skip to Step 6.

If Persistent/Oneshot, continue to Step 5.

## Step 5: Service Layer Details

Ask all (only if Step 4 != none):
- **LXC number** + IP (from root CLAUDE.md LXC table):
  - 100 = Media (192.168.1.138)
  - 103 = Agents (192.168.1.114)
  - 104 = Commands/Timers (192.168.1.227) — prefer for scheduled tasks
  - 105 = Orchestrator (192.168.1.187)
  - 106 = Voice (192.168.1.188)
  - 107 = MQTT broker (192.168.1.189) — generally don't add services here
- **Service name**: default `<slug>-agent.service`
- **Entry path on LXC**: default `/opt/<slug>-agent/agent.py`
- **Virtualenv path**: default `/opt/<slug>-agent/venv/bin/python3`
- **Env file path**: default `/etc/<slug>-agent.env`
- **Environment variables needed** (list): typically DB_PASS, HA_TOKEN, MQTT_PASS — ask which apply
- **Multi-process / port conflict risk?** — if yes, generate orphan-guard script `/opt/<slug>-agent/kill-orphans.sh`
- If **Oneshot**: ask schedule — `OnBootSec`, `OnUnitActiveSec` (e.g., every 5 min, every 1 hour)

Store everything for generation.

## Step 6: Data Storage Model

Ask: "How will this agent persist data?"

Options (may pick multiple):
- **Dashboard settings keys** (`dashboard_settings` table, prefix `<slug>.*`) — simple key/value, no schema
- **Data table** — universal columns `ts, decision, error, next_ts` + agent-specific data
- **Settings table** — universal columns `agent_enabled, run_interval_min` + agent-specific settings

For each selected option, collect specifics:

### Data table (if chosen)
Ask: custom columns (name + type). Required columns auto-added:
```
ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
decision TEXT,
error TEXT,
next_ts TIMESTAMPTZ
```
Default table name: `agent_<slug>_data`

### Settings table (if chosen)
Ask: custom settings (name + type + default value). Required columns auto-added:
```
agent_enabled BOOLEAN NOT NULL DEFAULT true,
run_interval_min INTEGER
```
Default table name: `agent_<slug>_settings`. Seed row with `INSERT INTO ... DEFAULT VALUES;`

### Dashboard settings (if chosen)
Ask: list of keys (e.g., `<slug>.threshold`, `<slug>.bindings`). Document convention in memory + CLAUDE.md.

## Step 7: Retention Policies

For each new table (data and/or settings) from Step 6, ask:
- **keep_days** (default 365 for data, `NULL`/forever for settings)
- **auto_clean** (default true for data, false for settings)
- **clean_interval_hours** (default 24)

Generate `retention_policies` INSERT for each table.

## Step 8: MQTT Integration

Ask: "Does this agent publish or subscribe to MQTT topics?"
- **No** — skip
- **Yes** — ask:
  - MQTT user name (default: `<slug>_agent`)
  - Topics to publish (pattern: `mur/home/device/<slug>/*` or custom)
  - Topics to subscribe (if reading from other agents)
  - Generate manual commands for LXC 107 (user creation in `/etc/mosquitto/passwd`, ACL entry in `/etc/mosquitto/acl`, reload mosquitto)

Skill outputs these LXC 107 commands to the user — does NOT auto-run (per Q1 hybrid answer, manual for LXC changes).

## Step 9: Rule Engine Integration

Ask: "Will this agent own rules in `RULES/rules/`?"
- **No** — skip
- **Yes** — ask:
  - Rule group name (default = slug)
  - Expected rule types (info / control / safety / display)
  - Planned dependencies on virtual devices (e.g., `virtual:people_home`, `virtual:home_activity`)

Record in memory + CLAUDE.md so future rules follow convention. Skill does NOT create rule files — that's `/create-rule`'s job.

## Step 10: Documentation

**Every agent gets its own `<AGENT_DIR>/CLAUDE.md`**, regardless of service layer. The file is an index + purpose statement pointing to canonical artifact locations (which usually live in shared dirs like `BOILER/dashboard/public/` and `RULES/rules/`, since dashboard static files and rule files are forced into those paths by the server and rule engine).

Ask user to confirm directory name (default = upper-case of slug with dashes → underscores, e.g., `LIVING_ROOM/` for `living-room`, `CORRIDOR/` for `corridor`).

Content differs based on service layer:

### If Step 4 service layer = None
`<AGENT_DIR>/CLAUDE.md` is a **pointer document** — brief purpose + file location table mapping every artifact to its canonical path:
- Dashboard page → `BOILER/dashboard/public/<slug>.html`
- Dashboard JS → `BOILER/dashboard/public/js/<slug>.js`
- Rules → `RULES/rules/<rule_name>.py` (group=`<slug>`)
- Migration → `<AGENT_DIR>/migrations/setup.sql`
- Config storage → `dashboard_settings` keys prefixed `<slug>.*`
- Memory → `memory/project_agent_<slug>.md`

Plus: rule list (if any), storage key list, tab list, planned-future-features section.

### If Step 4 service layer = Persistent or Oneshot
`<AGENT_DIR>/CLAUDE.md` is a **full module doc** with sections (Purpose, System Overview, Data Source, Tables, Data Flow, Integration, App LXC) — same pattern as `BOILER/CLAUDE.md`, `MEDIA/CLAUDE.md`, `VOICE/CLAUDE.md`, `ORCHESTRATOR/CLAUDE.md`.

### Root CLAUDE.md updates (always)

1. Add row to Dashboard Pages table:
   ```
   | <Name> | `<slug>.html` | <short purpose> |
   ```
2. Add row to "Project Modules" table:
   ```
   | <Name> | `<AGENT_DIR>/` | `<AGENT_DIR>/CLAUDE.md` — <short note> |
   ```

Ask user for `<short purpose>` text.

## Step 11: Deploy Info

Ask (required for all agents with a service layer):
- **Deploy path** on target LXC: default `/opt/<slug>-agent`
- **Git branch**: default `main`

These become `deploy_path` and `git_branch` columns in the `agents` table row. `/api/deploy` endpoint uses them for git-pull + service restart.

For agents without service layer, set `deploy_path=NULL`, `git_branch=NULL`.

## Step 12: Generate & Review

Display to the user — a complete manifest of what will happen. NO file changes yet.

### Files to CREATE
```
BOILER/dashboard/public/<slug>.html
BOILER/dashboard/public/js/<slug>.js
<AGENT_DIR>/CLAUDE.md                          # always (pointer index for dashboard-only, full module doc if service)
memory/project_agent_<slug>.md
<AGENT_DIR>/migrations/setup.sql
[if service]  <AGENT_DIR>/agent/<slug>-agent.service
[if timer]    <AGENT_DIR>/agent/<slug>-agent.timer
[if orphan]   <AGENT_DIR>/agent/kill-orphans.sh
```

### Files to MODIFY
```
9 HTML files in BOILER/dashboard/public/  (sidebar link injection)
CLAUDE.md                                 (+1 Dashboard Pages row)
memory/MEMORY.md                          (+1 index line)
```

### SQL to APPLY (auto on confirm)
Full contents of `<AGENT_DIR>/migrations/setup.sql` shown here — including agents INSERT, CREATE TABLE statements, retention_policies INSERTs, optional seed rows.

### Manual commands to RUN on LXCs (printed, user executes)
```
# 1) SCP service file (if service layer)
scp <AGENT_DIR>/agent/<slug>-agent.service root@<LXC_IP>:/etc/systemd/system/
[if timer]
scp <AGENT_DIR>/agent/<slug>-agent.timer   root@<LXC_IP>:/etc/systemd/system/

# 2) Create env file (if service layer)
ssh root@<LXC_IP> 'cat > /etc/<slug>-agent.env <<EOF
DB_PASS=...
HA_TOKEN=...
EOF
chmod 600 /etc/<slug>-agent.env'

# 3) SCP orphan guard + entry script (if applicable)
scp <AGENT_DIR>/agent/kill-orphans.sh root@<LXC_IP>:/opt/<slug>-agent/
ssh root@<LXC_IP> 'chmod +x /opt/<slug>-agent/kill-orphans.sh'

# 4) Enable service
ssh root@<LXC_IP> 'systemctl daemon-reload && systemctl enable --now <slug>-agent[.timer]'

# 5) (If MQTT) on LXC 107:
ssh root@192.168.1.189 'mosquitto_passwd /etc/mosquitto/passwd <mqtt_user>'
# Add ACL lines to /etc/mosquitto/acl:
#   user <mqtt_user>
#   topic write <publish_topic>
#   topic read  <subscribe_topic>
ssh root@192.168.1.189 'systemctl reload mosquitto'
```

## Step 13: Confirmation

Ask the user: "Review the manifest above. Proceed? (yes / no)"

Do NOT do anything without explicit "yes". If "no" — ask what to change and loop back.

## Step 14: Execute

On "yes":

### 14a. Auto — DB writes
Generate `<AGENT_DIR>/migrations/setup.sql` locally, then:
```bash
scp <AGENT_DIR>/migrations/setup.sql root@192.168.1.227:/tmp/agent_<slug>_setup.sql
ssh root@192.168.1.227 "PGPASSWORD='' psql -h 192.168.1.219 -U postgres -d home_data -f /tmp/agent_<slug>_setup.sql"
```
(LXC 104 works for this — backup-script.sh proves passwordless psql connection to 192.168.1.219.)

### 14b. Auto — Dashboard files + sidebar + agent dir + docs + memory
- Create directory `<AGENT_DIR>/` if it does not exist (always)
- Write `<AGENT_DIR>/CLAUDE.md` from the appropriate template:
  - If service layer = None → **pointer-index template** (see Templates section below)
  - If service layer = Persistent/Oneshot → **full-module template** with Purpose/Data Flow/etc. sections
- Write `<slug>.html` locally from template (`BOILER/dashboard/public/<slug>.html`)
- Write `<slug>.js` locally from template (`BOILER/dashboard/public/js/<slug>.js`)
- Sed-inject sidebar link into 9 HTML files
- Write `memory/project_agent_<slug>.md`
- Append row to root `CLAUDE.md` Dashboard Pages table AND to Project Modules table
- Append line to `memory/MEMORY.md`
- If service layer: also write `<AGENT_DIR>/agent/<slug>-agent.service` + timer + orphan guard + env file template

### 14c. Auto — Dashboard restart
```bash
cd /c/Users/muroc/project_home/BOILER/dashboard && pm2 delete boiler-dashboard && pm2 start ecosystem.config.js
```

### 14d. Print manual LXC commands
Output the commands block from Step 12 for the user to run manually. Highlight that until those commands run, the agent's service layer won't start — but the DB registration + dashboard page already exist and work for dashboard-only features.

## Templates

### HTML skeleton (`BOILER/dashboard/public/<slug>.html`)
Copy `BOILER/dashboard/public/corridor.html` as the base (simplest agent page). Replace:
- `<title>` → `<Name>`
- Page `<h1>` → `<Name>`
- Sidebar `<a class="active">` entry → new entry at correct section
- Tab bar + tab panels → user's Step 3 tabs
- `<script src="js/corridor.js">` → `<script src="js/<slug>.js">`
- Keep: shared CSS, alerts-monitor.js, badge structure, refresh-bar

### JS skeleton (`BOILER/dashboard/public/js/<slug>.js`)
```javascript
// <NAME> — page logic
(function () {
  function showTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
  }
  window.showTab = showTab;

  function refreshPage() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    // Per-tab refresh wiring added later as features are built.
  }
  window.refreshPage = refreshPage;
  window.addEventListener('DOMContentLoaded', refreshPage);
})();
```

### SQL file (`<AGENT_DIR>/migrations/setup.sql`)
```sql
-- Generated by /create-agent for <slug> on <date>
-- Idempotent: safe to re-run.

-- 1) Register in agents table
INSERT INTO agents (
  name, description, lxc_id, lxc_ip, service_name,
  data_table, settings_table,
  deploy_path, git_branch, service_oneshot, enabled
) VALUES (
  '<slug>', '<description>', <lxc_id|NULL>, '<lxc_ip|NULL>', '<service_name|NULL>',
  '<data_table|NULL>', '<settings_table|NULL>',
  '<deploy_path|NULL>', '<git_branch|NULL>', <service_oneshot>, true
)
ON CONFLICT (name) DO NOTHING;

-- 2) Data table (if selected in Step 6)
CREATE TABLE IF NOT EXISTS agent_<slug>_data (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision TEXT,
  error TEXT,
  next_ts TIMESTAMPTZ
  -- + custom columns from Step 6
);

-- 3) Settings table (if selected)
CREATE TABLE IF NOT EXISTS agent_<slug>_settings (
  agent_enabled BOOLEAN NOT NULL DEFAULT true,
  run_interval_min INTEGER
  -- + custom settings from Step 6
);
INSERT INTO agent_<slug>_settings DEFAULT VALUES;  -- seed single-row table

-- 4) Retention policies for each new table (Step 7)
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('agent_<slug>_data', <days>, <auto_clean>, <interval>, '<slug> decision log')
ON CONFLICT (table_name) DO NOTHING;
-- repeat for settings if applicable
```

### Service unit (`<AGENT_DIR>/agent/<slug>-agent.service`)
```ini
[Unit]
Description=<Name> — automation service
After=network.target

[Service]
Type=<simple|oneshot>
ExecStartPre=/opt/<slug>-agent/kill-orphans.sh
ExecStart=/opt/<slug>-agent/venv/bin/python3 <entry_path>
EnvironmentFile=/etc/<slug>-agent.env
Restart=<always|no>
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Remove `ExecStartPre` line if orphan guard not needed.

### Timer unit (`<AGENT_DIR>/agent/<slug>-agent.timer`) — only for oneshot
```ini
[Unit]
Description=<Name> timer

[Timer]
OnBootSec=<1min>
OnUnitActiveSec=<e.g. 5min, 1h>
Unit=<slug>-agent.service

[Install]
WantedBy=timers.target
```

### Orphan guard (`<AGENT_DIR>/agent/kill-orphans.sh`)
```bash
#!/bin/bash
# Kill any stray <slug>-agent processes (prevent port conflicts on restart)
pkill -9 -f '<entry_path>' 2>/dev/null
sleep 0.5
exit 0
```
Add `#!/bin/bash` shebang + `chmod +x` on target LXC.

### Agent's own CLAUDE.md — full-module template (when service layer = Persistent or Oneshot)

`<AGENT_DIR>/CLAUDE.md`:
```markdown
# <Name>

## Purpose
<short purpose — from Step 10>

## System Overview
<user-editable: explain what this agent does, in one paragraph>

## Data Source
- Proxmox LXC ID: <lxc_id>
- IP: <lxc_ip>
- DB Name: `home_data`

## Tables
- `agent_<slug>_data` — decision log (ts, decision, error, next_ts, + custom columns)
- `agent_<slug>_settings` — configuration (agent_enabled, run_interval_min, + custom)

## Data Flow
<user-editable: end-to-end flow description>

## Integration
<HA/MQTT/other integrations if any>

## App LXC
- Proxmox LXC ID: <lxc_id>
- IP: <lxc_ip>
- Service: `<slug>-agent.service`
- Deploy path: <deploy_path>
- Deploy: `ssh root@<ip> "cd <deploy_path> && git pull && systemctl restart <service>"`
```

### Agent's own CLAUDE.md — pointer-index template (when service layer = None)

`<AGENT_DIR>/CLAUDE.md`:
```markdown
# <Name>

<short purpose — from Step 10>

Dashboard-only agent (no dedicated LXC service). All automation logic lives in the rule engine on LXC 105; UI is hosted by the Windows dashboard.

## File Locations

This file is the index — all artifacts live in shared canonical directories:

| Artifact | Path |
|----------|------|
| Dashboard page | `BOILER/dashboard/public/<slug>.html` |
| Dashboard JS | `BOILER/dashboard/public/js/<slug>.js` |
| Rules | `RULES/rules/*.py` (group=`<rule_group>`) |
| DB setup migration | `<AGENT_DIR>/migrations/setup.sql` |
| DB agent row | `agents` table, `name = '<slug>'` |
| Config storage | `dashboard_settings` keys prefixed `<slug>.*` |
| Memory | `memory/project_agent_<slug>.md` |

## Rules (group=`<rule_group>`)

<!-- Populated by /create-rule when rules are added -->

## Storage Keys

<!-- List keys under <slug>.* as features get added -->

## Dashboard Tabs

- <tab names from Step 3>

## Planned Future Features

<!-- User fills in as the agent grows -->

## Extending the Agent

To add a service layer later: run `/create-agent Edit` → select "add service layer". Skill generates `<AGENT_DIR>/agent/<slug>-agent.service` + env file + orphan guard, updates the `agents` table, and converts this pointer index into a full-module doc.
```

### Memory file (`memory/project_agent_<slug>.md`)
```markdown
---
name: <Name>
description: Namespaced owner for <slug>. Page at /<slug>.html, sidebar section <section>, rule group <rule_group|none>, service layer <none|persistent|oneshot on LXC <id>>.
type: project
---

<Name> is the namespaced owner of <scope — user-provided in Step 1>.

- **Dashboard**: `BOILER/dashboard/public/<slug>.html`
- **Initial tabs**: <tabs>
- **Sidebar section**: <section>
- **Storage**: <dashboard_settings '<slug>.*' keys | agent_<slug>_data + agent_<slug>_settings>
- **Rule group**: <rule_group | none> (future rules use `"group": "<rule_group>"`)
- **Service layer**: <none | LXC <id>, `<slug>-agent.service` <persistent|oneshot>>
- **Own CLAUDE.md**: <yes at <AGENT_DIR>/CLAUDE.md | no>
- **MQTT user**: <none | `<mqtt_user>`, topics `<topics>`>
- **Deploy path**: <deploy_path>
- **Created**: <yyyy-mm-dd>

**How to apply**: when features are added to this agent, place storage under the above namespace, rules under the above group, docs in the above location, SQL migrations under `<AGENT_DIR>/migrations/*.sql`.
```

## Sidebar Injection

For each OTHER HTML file in `BOILER/dashboard/public/` (not the new one, not `viewer.html`), use sed to inject the link at the correct anchor per Step 2 choice. The anchor regex MUST match `</a>` only — NOT `href="...">`, because the page where the anchor link is the active one has `class="active"` between the href and `>`. Example for Agents section (anchor = the agent listed just above the new one — currently the Balcony Agent line):

```bash
# WRONG — skips pages where the anchor link is the .active one (e.g. balcony.html itself):
#   sed -i '/<a href="balcony.html">Balcony Agent<\/a>/a\...'
# RIGHT — matches both `<a href="balcony.html">Balcony Agent</a>` AND
#                      `<a href="balcony.html" class="active">Balcony Agent</a>`:
sed -i '/Balcony Agent<\/a>/a\  <a href="<SLUG>.html"><NAME></a>' <path>/<file>.html
```

After the sed loop, verify ACROSS all 14 files (every `*.html` in `public/` except `viewer.html`):
```bash
grep -l 'href="<slug>.html"' BOILER/dashboard/public/*.html | wc -l
# Expected: 14 (includes the new agent's own page)
```

This bug bit the My BathRoom Agent setup on 2026-05-06 — `balcony.html` was missed because its own `Balcony Agent` link carried `class="active"` and the over-specific anchor regex didn't match. Failure mode: the user opens the page where the anchor is .active, the new link is missing, the user reports the agent "disappeared."

## Important Notes

- Always use `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js` — never `pm2 restart`
- `viewer.html` does NOT get a sidebar link
- Don't create rule files here — tell user to run `/create-rule` with the agreed group name
- Don't edit `server.js` here — API endpoints are per-feature, added manually after agent exists
- Skill is dry-run safe until Step 13 confirmation — no files touched, no SQL executed
- If user aborts mid-flow, zero state changes
- If dashboard-only agent (Step 4 = none), skip Steps 5, 7-data-table, 11-deploy
- The `agents` table row is the CRITICAL registration — all downstream auto-discovery hinges on it
- If the setup SQL file already exists from a previous run, ask whether to regenerate or reuse
