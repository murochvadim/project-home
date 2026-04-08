---
name: discovery
description: Map current behavior, code locations, infrastructure, and blast radius for a feature before designing a solution. Use when starting a new feature to build context.
---

# Discovery

Map what exists today for a feature — current behavior, code locations, infrastructure, agent interactions, and blast radius.

## Input
- **Feature name**: lowercase with hyphens (e.g., `scene-engine`, `mqtt-publish`)
- **Description**: What the feature should do (pasted or explained by user)

## Steps

1. **Validate inputs**
   - Feature name provided? If not, ask user.
   - Feature description in context? If not, ask user to explain.

2. **Delegate research to subagent**

   **CRITICAL: Use a subagent for all codebase scanning to preserve main context window.**

   Launch an Agent tool with the following:
   ```
   Agent tool:
     subagent_type: "general-purpose"
     description: "Discovery research for [feature-name]"
     prompt: |
       You are conducting discovery research for a home automation feature.
       Scan the codebase and write a complete discovery document.

       ## Feature
       [feature-name]

       ## Description
       [What the feature should do]

       ## Project Context
       - Proxmox LXC infrastructure (read CLAUDE.md for full details)
       - LXC 100: Media Agent (192.168.1.138)
       - LXC 102: PostgreSQL DB (192.168.1.219)
       - LXC 103: Device Agent + Boiler Agent + Zigbee2MQTT (192.168.1.114)
       - LXC 104: Commands/Timers (192.168.1.227)
       - LXC 105: Orchestrator (192.168.1.187)
       - LXC 106: Voice (192.168.1.188)
       - LXC 107: MQTT Broker only — Mosquitto (192.168.1.189)
       - HA: 192.168.1.110
       - Dashboard: Windows host, port 3000
       - Architecture rule: dashboard = UI only, all logic on LXCs

       ## Instructions

       1. Read CLAUDE.md for full infrastructure and rules
       2. Scan codebase systematically:

          **Current behavior + code locations**
          - Use Grep/Glob to find code related to the feature area
          - Trace the main flows affected
          - Document entry points, agents, adapters, endpoints

          **Infrastructure mapping**
          - Which LXCs are affected
          - Which services need changes
          - Which ports/connections are involved

          **DB schema**
          - Which PostgreSQL tables are read/written
          - What new tables might be needed
          - Check retention policies in server.js

          **Agent interactions**
          - Which agents are involved
          - How data flows between them (DB, MQTT, HA API)
          - What callbacks/adapters are used

          **MQTT topics**
          - What topics exist or need to be created
          - Who publishes, who subscribes
          - Message format

          **HA entities**
          - Which Home Assistant entities are involved
          - How they're accessed (API, WebSocket, MCP)

          **Dashboard impact**
          - Which pages/tabs are affected
          - Which server.js endpoints need changes
          - Any new UI components needed

          **Blast radius**
          - All modules that depend on affected code
          - Services that need restarting
          - Risk of breaking existing functionality

          **Edge cases / failure modes**
          - What happens if MQTT is down
          - What happens if a device is offline
          - What happens if DB connection drops
          - Race conditions between agents

          **Deployment**
          - Files to scp to which LXC
          - Services to restart (systemctl, pm2)
          - DB migrations (ALTER TABLE, new tables)

       3. Write the discovery document to `docs/[feature-name]/discovery.md`
          using the template below. Every section must be filled or marked N/A.

       4. Return a SHORT summary (max 10 lines) of key findings and open questions.

       ## Discovery Template

       Write this structure to `docs/[feature-name]/discovery.md`:

       # Discovery: [Feature Name]

       **Description:** [Brief description]
       **Date:** [YYYY-MM-DD]
       **Status:** Draft

       ## 1. Goal
       [One paragraph summary of what the feature achieves]

       ## 2. Current Behavior
       [How the system works today in the affected area]

       ### Code Locations
       | Component | File | Purpose |
       |-----------|------|---------|
       | [Agent/Adapter] | `path/to/file.py:L##` | [What it does] |

       ## 3. Infrastructure Map
       | LXC | Service | Change Needed |
       |-----|---------|---------------|
       | [103] | [device-agent] | [Add MQTT publish] |

       ## 4. DB Schema
       | Table | Action | Columns/Changes |
       |-------|--------|----------------|
       | [table] | [existing/new/alter] | [description] |

       ## 5. Agent Interactions
       [Data flow diagram or description: which agents talk to each other and how]

       ## 6. MQTT Topics
       | Topic | Publisher | Subscriber | Payload |
       |-------|-----------|------------|---------|
       | [devices/+/state] | [Device Agent] | [Scene Engine] | [DPS JSON] |

       ## 7. HA Entities
       | Entity | Usage | Access Method |
       |--------|-------|---------------|
       | [switch.xxx] | [control] | [HA API / WebSocket] |

       ## 8. Dashboard Impact
       | Page | Endpoint | Change |
       |------|----------|--------|
       | [devices.html] | [/api/xxx] | [new/modify] |

       ## 9. Blast Radius
       | Component | How Affected | Risk |
       |-----------|-------------|------|
       | [module] | [direct/side effect] | [Low/Med/High] |

       ## 10. Edge Cases / Failure Modes
       - [What if MQTT broker is down?]
       - [What if device is offline?]

       ## 11. Deployment
       | Step | Command | Target |
       |------|---------|--------|
       | [Deploy agent] | `scp file root@IP:/path` | [LXC 103] |
       | [Restart] | `systemctl restart xxx` | [LXC 103] |
       | [DB migration] | `ALTER TABLE ...` | [LXC 102] |

       ## 12. Open Questions
       - [ ] [Question 1]
       - [ ] [Question 2]

       ## 13. Recommendations
       - [Recommendation 1]
       - [Recommendation 2]
   ```

3. **Gate check**
   - After the subagent completes, read `docs/[feature-name]/discovery.md`
   - Verify every section is filled or explicitly marked N/A
   - If a section is empty, launch a focused subagent to fill the gap

4. **Interactive interview for open questions**

   **CRITICAL: Do NOT just list questions — actively interview the user.**

   - Read Section 12 (Open Questions) from discovery.md
   - For each open question, use `AskUserQuestion` tool to present them interactively
   - After user answers, update discovery.md with the answers
   - Continue until all questions are resolved or user says to move on

5. **Present summary to user**
   - Show brief summary of key findings
   - Confirm all questions have been addressed
   - Tell user: "When ready, run `/tech-design [feature-name]` to proceed"

6. **Post-implementation: update project docs**

   After the feature is fully implemented and deployed (all tasks complete), update:
   - **CLAUDE.md** — if infrastructure changed (new LXC roles, new services, new connections, new env vars, new ports)
   - **Memory** (`project_context.md`) — add feature summary with key details
   - **Git commit** — include all doc updates in the final commit
   
   This ensures future conversations have accurate context about what exists.
