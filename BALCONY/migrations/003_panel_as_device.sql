-- Register the balcony HASP panel as a device row so the rule engine's
-- `protocol='hasp'` dispatch path resolves device_name='balcony' and
-- publishes commands to hasp/balcony/command/<path>.
-- Same pattern as the 'pixoo' device row.
-- Idempotent: ON CONFLICT DO NOTHING.

INSERT INTO devices (id, name, vendor, protocol, device_type, room, show_dashboard, poll_enabled, enabled)
VALUES ('hasp:balcony', 'balcony', 'OpenHASP', 'hasp', 'panel', 'Balcony', false, false, true)
ON CONFLICT (id) DO NOTHING;
