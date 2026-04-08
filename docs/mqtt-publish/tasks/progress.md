# Progress: MQTT Publish (Device Agent)

**Total Tasks**: 6
**Current Task**: done
**Completed**: 6/6

## Reference Docs
- **Discovery:** [discovery.md](../discovery.md)
- **Tech Design:** [tech-design.md](../tech-design.md)

## Completed Tasks
- [x] task-001-mqtt-publisher-class: Create MqttPublisher helper class
- [x] task-002-integrate-mqtt-device-agent: Integrate MQTT into DeviceAgent
- [x] task-003-availability-checker: Add availability checker thread

## Pending Tasks
- [x] task-004-daily-inventory-refresh: Add daily inventory refresh thread
- [x] task-005-config-change-polling: Add config change polling thread
- [x] task-006-universal-mqtt-ingest: Add universal MQTT ingest (DIY, HASP, Awtrix, Zigbee)

## Infrastructure (manual, not code tasks)
- Setup Mosquitto ACLs + users on LXC 107 (hasp, awtrix)
- Deploy to LXC 103: install paho-mqtt, add env vars, restart service
