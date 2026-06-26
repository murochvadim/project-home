-- Daily step entries per household member: manual entries + walking-trip-derived.
CREATE TABLE IF NOT EXISTS ph_steps (
  id          serial PRIMARY KEY,
  user_id     integer REFERENCES household_users(id) ON DELETE CASCADE,
  measured_at timestamptz NOT NULL DEFAULT now(),
  steps       integer NOT NULL,
  source      text NOT NULL DEFAULT 'manual',   -- 'manual' | 'trip'
  trip_id     bigint,                            -- phone_trips.id when source='trip'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ph_steps_user_ts ON ph_steps(user_id, measured_at DESC);
-- A walking trip is imported at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ph_steps_trip ON ph_steps(trip_id) WHERE trip_id IS NOT NULL;
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('ph_steps', NULL, false, 24, 'Personal Health daily step entries (manual + walking-trip derived)')
ON CONFLICT (table_name) DO NOTHING;
