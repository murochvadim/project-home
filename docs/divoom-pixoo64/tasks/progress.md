# Progress: Divoom Pixoo64

**Total Tasks**: 2
**Current Task**: 2
**Completed**: 2/2

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md)

## Completed Tasks
- [x] task-001-pixoo-service-core: Pixoo service core (MQTT, rotation, heartbeat)
- [x] task-002-screen-renders: Screen render functions (clock, home, weather, boiler)

## Pending Tasks
(none)

## Infrastructure (manual, not code tasks)
- Create Mosquitto user `pixoo_service` + ACL on LXC 107
- Create DB tables `pixoo_log` on LXC 102
- Register `pixoo` in `agents` table + `retention_policies`
- Install paho-mqtt in LXC 100 venv (if not present)
- Create `/etc/pixoo.env` on LXC 100
- Deploy systemd service `pixoo.service` on LXC 100
