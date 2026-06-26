-- Personal Health — waist & hip circumference time-series + a measure schedule.
-- Mirrors ph_measurements (weight) / ph_bp: one row per measurement, WHR is
-- COMPUTED (waist/hip), never stored. Added 2026-06-27.

CREATE TABLE IF NOT EXISTS ph_body (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  waist_cm    NUMERIC,
  hip_cm      NUMERIC,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ph_body_profile ON ph_body(profile_id, measured_at DESC);

-- Per-profile measure schedule (like weight_sched / bp_sched) → drives the
-- reminders badge. JSONB {freq, interval_n} or NULL = Off.
ALTER TABLE ph_profiles ADD COLUMN IF NOT EXISTS body_sched JSONB;

-- Retention: forever + protected (medical/health), so it's never auto-cleaned.
-- protected=true set directly here (the one-time server.js protect-seed already
-- fired via its sentinel, so it won't pick up new tables).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected)
VALUES ('ph_body', NULL, false, 24, 'Personal Health waist/hip measurements — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
