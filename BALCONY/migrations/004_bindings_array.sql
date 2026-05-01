-- Multi-binding per HASP button — wallmote parity (2026-05-01).
-- Adds a JSONB array column where each element is one device/action combo.
-- Element shape (matches living-room.wallmote_bindings slot shape):
--   {device_id, channel, name, label, action}
-- Plus non-device variants (rare in v1):
--   {type:'hasp_command', target}
--   {type:'pixoo_preset', target, vars?}
--
-- Idempotent: safe to re-run.

ALTER TABLE hasp_buttons
  ADD COLUMN IF NOT EXISTS bindings JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Migrate existing device-type rows into a single-element bindings array
-- with name + label resolved from the target device's channel_config.
UPDATE hasp_buttons b
SET bindings = jsonb_build_array(
  jsonb_build_object(
    'device_id', b.action_target,
    'channel',   b.action_payload->>'channel',
    'name',      d.name,
    'label',     COALESCE(
                   d.channel_config->(b.action_payload->>'channel')->>'name',
                   d.dps_labels->>(b.action_payload->>'channel')
                 ),
    'action',    COALESCE(b.action_payload->>'action', 'toggle')
  )
)
FROM devices d
WHERE b.action_type = 'device'
  AND b.action_target = d.id
  AND (b.bindings IS NULL OR b.bindings = '[]'::jsonb);

-- Migrate hasp_command-type rows
UPDATE hasp_buttons
SET bindings = jsonb_build_array(
  jsonb_build_object('type', 'hasp_command', 'target', action_target)
)
WHERE action_type = 'hasp_command'
  AND (bindings IS NULL OR bindings = '[]'::jsonb);

-- Migrate pixoo_preset-type rows
UPDATE hasp_buttons
SET bindings = jsonb_build_array(
  jsonb_build_object(
    'type', 'pixoo_preset',
    'target', action_target,
    'vars', action_payload->'vars'
  )
)
WHERE action_type = 'pixoo_preset'
  AND (bindings IS NULL OR bindings = '[]'::jsonb);
