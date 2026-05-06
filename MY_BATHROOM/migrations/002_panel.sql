-- My BathRoom HASP panel registration (2026-05-06)
-- Idempotent.

INSERT INTO hasp_panels (name, ip, mac, hardware, mqtt_prefix, location, enabled)
VALUES ('my-bathroom', '192.168.1.220', '8c:bf:ea:0d:bb:e8',
        'ESP32-S3 4848S040', 'hasp', 'My BathRoom', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO devices (
  id, name, vendor, device_type, protocol, room, mac,
  enabled, show_dashboard, poll_enabled,
  dps_labels, dps_config, channel_config
)
VALUES (
  'hasp:my-bathroom', 'My BathRoom Panel Display', 'OpenHASP', 'panel', 'hasp', 'My BathRoom',
  '8c:bf:ea:0d:bb:e8', true, true, false,
  '{"page":"Page"}'::jsonb,
  '{
    "page":      {"max":12,"min":1,"name":"Page","type":"page_select","enabled":true,"action_on":"goto_page","show_dashboard":true},
    "backlight": {"name":"Screen","enabled":true,"action_on":"backlight_on","action_off":"backlight_off","show_dashboard":true}
  }'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
