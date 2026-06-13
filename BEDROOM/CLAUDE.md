# Bedroom Agent

Per-room agent for the Bedroom — area-specific control surfaces and automations.

Dashboard-only agent (no dedicated LXC service). Any future automation logic lives in the rule engine on LXC 105; the UI is hosted by the Windows dashboard. Sibling of the Balcony / My BathRoom per-room agents.

**Status: scaffold only (created 2026-06-13).** No features yet — one empty `Overview` tab. Control surfaces and rules will be added over time.

## File Locations

This file is the index — all artifacts live in shared canonical directories:

| Artifact | Path |
|----------|------|
| Dashboard page | `BOILER/dashboard/public/bedroom.html` |
| Dashboard JS | `BOILER/dashboard/public/js/bedroom.js` |
| Rules | `RULES/rules/*.py` (group=`bedroom`) — none yet, add via `/create-rule` |
| DB setup migration | `BEDROOM/migrations/setup.sql` |
| DB agent row | `agents` table, `name = 'bedroom'` |
| Config storage | `dashboard_settings` keys prefixed `bedroom.*` |
| Memory | `memory/project_agent_bedroom.md` |

## Rules (group=`bedroom`)

<!-- Populated by /create-rule when rules are added -->
None yet.

## Storage Keys

<!-- List keys under bedroom.* as features get added -->
None yet.

## Dashboard Tabs

- **Overview** — placeholder.

## Planned Future Features

<!-- User fills in as the agent grows -->

## Extending the Agent

To add a service layer later: run `/create-agent` → Edit → "add service layer". The skill generates `BEDROOM/agent/bedroom-agent.service` + env file + orphan guard, updates the `agents` table, and converts this pointer index into a full-module doc.
