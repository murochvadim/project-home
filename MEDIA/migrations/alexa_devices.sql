-- Register 4 Amazon Alexa devices (HA-managed via alexa_media_player integration)
-- Created 2026-05-06 for the Media Agents → Alexa Devices tab + rule chips.
-- Idempotent: ON CONFLICT DO NOTHING.

INSERT INTO devices (
  id, name, vendor, device_type, protocol, room,
  enabled, show_dashboard, poll_enabled,
  dps_labels, dps_config, channel_config
)
VALUES
  ('media_player.10inch_echo_show', '10inch Echo Show', 'Amazon',
   'media_player', 'alexa', 'Living Room',
   true, true, false,
   '{}'::jsonb,
   '{
     "volume": {"name":"Volume","type":"range","min":0,"max":100,
                "enabled":true,"show_dashboard":true},
     "power":  {"name":"Power","action_on":"turn_on","action_off":"turn_off",
                "enabled":true,"show_dashboard":true}
   }'::jsonb,
   '{}'::jsonb),

  ('media_player.alexa_my_bathroom', 'Alexa My Bathroom', 'Amazon',
   'media_player', 'alexa', 'My BathRoom',
   true, true, false,
   '{}'::jsonb,
   '{
     "volume": {"name":"Volume","type":"range","min":0,"max":100,
                "enabled":true,"show_dashboard":true},
     "power":  {"name":"Power","action_on":"turn_on","action_off":"turn_off",
                "enabled":true,"show_dashboard":true}
   }'::jsonb,
   '{}'::jsonb),

  ('media_player.alexa_maya_bedroom', 'Alexa Maya Bedroom', 'Amazon',
   'media_player', 'alexa', 'Bedroom',
   true, true, false,
   '{}'::jsonb,
   '{
     "volume": {"name":"Volume","type":"range","min":0,"max":100,
                "enabled":true,"show_dashboard":true},
     "power":  {"name":"Power","action_on":"turn_on","action_off":"turn_off",
                "enabled":true,"show_dashboard":true}
   }'::jsonb,
   '{}'::jsonb),

  ('media_player.alexa_guy_room', 'Alexa Guy Room', 'Amazon',
   'media_player', 'alexa', 'Guy Room',
   true, true, false,
   '{}'::jsonb,
   '{
     "volume": {"name":"Volume","type":"range","min":0,"max":100,
                "enabled":true,"show_dashboard":true},
     "power":  {"name":"Power","action_on":"turn_on","action_off":"turn_off",
                "enabled":true,"show_dashboard":true}
   }'::jsonb,
   '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
