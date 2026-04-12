---
description: Add, edit, or remove a device from the devices table
user-invocable: true
---

# /add-device — Device Manager

Register, edit, or remove devices in the system. Follow this interactive flow step by step. Use AskUserQuestion for each step. Do NOT skip steps or assume answers.

## Step 0: Action

Ask the user what they want to do:
- **Add** — register a new device
- **Edit** — modify an existing device (list from DB, ask which one, ask what to change)
- **Remove** — delete a device (list, confirm, delete from DB)

If **Remove**: query `SELECT id, name, protocol, room FROM devices ORDER BY name`, list them, confirm selection, `DELETE FROM devices WHERE id = $1`. Done.

If **Edit**: query the device, show current values, ask what to change (name, room, device_type, dps_labels, dps_config, enabled, show_dashboard, notes), update via SQL. Done.

If **Add**: continue with the steps below.

## Step 1: Protocol

Ask which protocol:
- **zigbee** — Zigbee device via Z2M on LXC 103. Requires Z2M pairing.
- **local** — Tuya local device. Already discovered by device agent.
- **gateway** — Tuya device behind a gateway.
- **cloud** — Cloud-only device (BSH, etc.).

## Step 2: Device Identity

### If Zigbee:
1. Check if the device is already paired to Z2M:
   ```bash
   ssh root@192.168.1.189 "timeout 5 mosquitto_sub -h 127.0.0.1 -u zigbee -P 'z2m_pass_107' -t 'zigbee2mqtt/bridge/devices' -C 1"
   ```
   Parse the JSON and list devices not yet in the `devices` DB table.

2. If not paired: enable Z2M pairing mode (**254 seconds max**):
   ```bash
   ssh root@192.168.1.189 "mosquitto_pub -h 127.0.0.1 -u zigbee -P 'z2m_pass_107' -t 'zigbee2mqtt/bridge/request/permit_join' -m '{\"value\": true, \"time\": 254}'"
   ```
   Tell user to factory reset the device (hold button ~10s until LED blinks fast). Wait for join confirmation in Z2M logs.

3. After pairing, the `id` = IEEE address (e.g. `0xa4c138...`), get it from Z2M.

4. If Z2M says "NOT supported", an external converter may be needed at `/opt/zigbee2mqtt/data/external_converters/`. Check the model + manufacturer from Z2M logs and search for community converters.

### If Local/Gateway/Cloud:
Ask the user for the device ID (Tuya ID from the device agent logs or dashboard).

## Step 3: Device Details

Ask for:
- **Name** — friendly name. For Zigbee: must EXACTLY match the Z2M friendly name (case-sensitive). Rename in Z2M if needed:
  ```bash
  ssh root@192.168.1.189 "mosquitto_pub -h 127.0.0.1 -u zigbee -P 'z2m_pass_107' -t 'zigbee2mqtt/bridge/request/device/rename' -m '{\"from\": \"<old>\", \"to\": \"<new>\"}'"
  ```
  **IMPORTANT**: Check for name collisions — no two devices can share the same name (device agent maps by name).

- **Room** — query existing rooms:
  ```sql
  SELECT name FROM rooms ORDER BY name
  ```
  Let user pick or create new.

- **Device type** — one of: `switch`, `light`, `presence`, `circuit_breaker`, `curtain`, `door_sensor`, `remote`, `siren`, `gateway`, `temp_controller`, `co_alarm`, `gas_detector`, `water_heater`, or custom.

- **Vendor** — e.g. `Tuya`, `Aeotec`, `Xiaomi`, `BSH`

- **Product name** — model identifier (e.g. `TS0601_scene_switch`, `TS0002`)

## Step 4: DPS Configuration

Ask the user what data points the device exposes. For Zigbee TS0601 devices, DPS must match the external converter mapping.

For each DPS:
- **Key** — the property name (e.g. `state_l1`, `1`, `temperature`)
- **Label** — human-readable name (e.g. `Button 1`, `State`, `Temperature`)
- **Enabled** — whether the device agent should track this DPS (default: true)
- **Show dashboard** — whether to display on the devices dashboard (default: true)

Build two JSONB objects:
```json
dps_labels: {"state_l1": "Button 1", "state_l2": "Button 2"}
dps_config: {
  "state_l1": {"name": "Button 1", "enabled": true, "show_dashboard": true},
  "state_l2": {"name": "Button 2", "enabled": true, "show_dashboard": true}
}
```

If the user doesn't know the DPS: for Zigbee devices, check the Z2M converter exposes definition. For Tuya local devices, check `last_state` after one state change.

## Step 5: Settings

Ask:
- **Enabled** — should the device agent process events from this device? (default: true)
- **Show dashboard** — show on the devices page? (default: true for new devices)
- **Poll enabled** — should the agent poll this device? **Always false for Zigbee** (Z2M pushes via MQTT). Default true for local Tuya.
- **Poll interval** — seconds between polls. **0 for Zigbee**. Default 30 for local Tuya.

## Step 6: Insert & Verify

1. Insert into DB with ALL required columns:
```sql
INSERT INTO devices (
  id, name, vendor, category, device_type, protocol, product_name,
  room, enabled, show_dashboard, poll_enabled, poll_interval_sec,
  dps_labels, dps_config, channel_config
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12,
  $13::jsonb, $14::jsonb, '{}'::jsonb
);
```

2. For Zigbee devices: restart device agent to reload the MQTT device map:
```bash
ssh root@192.168.1.114 "systemctl restart device-agent"
```

3. Tell the user to trigger a state change (press button, toggle switch) and verify:
```sql
SELECT name, last_seen, last_state, last_source FROM devices WHERE id = '<id>'
```
`last_seen`, `last_state`, `last_source` should populate after first event.

4. Check rule engine sees the device:
```sql
SELECT rule_name, device_id, ts FROM rule_events WHERE device_id = '<id>' ORDER BY ts DESC LIMIT 3
```

## Important Notes

- **Zigbee device names MUST match Z2M friendly names exactly** — the device agent maps by name. A mismatch means events are silently dropped.
- **No duplicate names** — two devices with the same name break the device agent's name→id mapping.
- **poll_enabled = false for ALL Zigbee devices** — Z2M pushes state changes via MQTT. Polling is not supported.
- **External converters** for unsupported Tuya TS0601 devices go in `/opt/zigbee2mqtt/data/external_converters/`. Z2M auto-loads `.js` files from this directory on startup.
- **After adding a Zigbee device**: restart the device agent (`systemctl restart device-agent` on LXC 103) so it rebuilds the MQTT name→id map.
- Auto-populated columns (do NOT set manually): `last_seen`, `last_state`, `last_source`, `created_at`, `updated_at`. The device agent fills these on first event.
- `mac` column: auto-populated by device agent from net_devices table if available. Leave NULL on insert.
- `channel_config`: set to `'{}'::jsonb` unless the device has multiple channels (e.g. multi-gang relay with per-channel rooms).
