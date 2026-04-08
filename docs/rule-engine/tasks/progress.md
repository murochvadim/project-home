# Progress: Rule Engine

**Total Tasks**: 5
**Current Task**: 5
**Completed**: 5/5

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md)

## Completed Tasks
- [x] task-001-device-agent-command-handler: Device Agent command handler (prerequisite)

## Pending Tasks
- [x] task-002-state-manager: StateManager class
- [x] task-003-rule-engine-core: Rule Engine core service
- [x] task-004-mqtt-client: MQTT client for Rule Engine (done before task-003 — core depends on client)
- [x] task-005-starter-rules: Starter rules (read-only, home activity + people)

## Infrastructure (manual, not code tasks)
- Create Mosquitto user `rule_engine` + ACL on LXC 107
- Create DB tables `rule_engine_log` + `rule_engine_state` on LXC 102
- Register `rule-engine` in `agents` table + `retention_policies`
- Install paho-mqtt in `/opt/main-agent/venv` on LXC 105
- Create `/etc/rule-engine.env` on LXC 105
- Deploy systemd service `rule-engine.service` on LXC 105
