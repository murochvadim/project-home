-- KITCHEN_SMART_TABLET — singleton settings (Tech Settings: idle-return timeout, etc.)
-- Applied via LXC 104 → psql 102 (trust auth). Re-runnable.

CREATE TABLE IF NOT EXISTS kitchen_settings (
    id         INT PRIMARY KEY DEFAULT 1,
    config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT kitchen_settings_one_row CHECK (id = 1)
);
INSERT INTO kitchen_settings (id, config) VALUES (1, '{"idle_return_sec": 60}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_settings', NULL, false, 24, 'Kitchen settings — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
