-- Register externally-managed network display devices in the devices table
-- so they appear in the Devices page and the dashboard's /api/devices LEFT
-- JOIN to net_devices on MAC surfaces their live IP / last_online.
--
-- These devices have dedicated services elsewhere (pixoo_service on LXC 100,
-- the OpenHASP firmware on the panel itself, the Awtrix browser MQTT path)
-- so device_agent does NOT manage them — the rows here are purely for
-- logical identity (rule dispatch, dashboard listing).
--
-- Idempotent: ON CONFLICT updates only the MAC + show_dashboard.
-- Generated 2026-05-01.

UPDATE devices
SET mac = '94:e6:86:0b:86:4c', show_dashboard = true
WHERE id = 'pixoo';

UPDATE devices
SET mac = '8c:bf:ea:0d:c3:24', show_dashboard = true
WHERE id = 'hasp:balcony';

INSERT INTO devices (id, name, vendor, protocol, device_type, room, show_dashboard, poll_enabled, enabled, mac)
VALUES ('awtrix_05ec2c', 'Awtrix', 'Ulanzi', 'awtrix', 'display', 'Living Room', true, false, true, '8c:4f:00:05:ec:2c')
ON CONFLICT (id) DO UPDATE
  SET mac = EXCLUDED.mac,
      show_dashboard = EXCLUDED.show_dashboard;
