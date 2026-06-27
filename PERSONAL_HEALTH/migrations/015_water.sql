-- Personal Health — daily water intake (cups) + per-person goal/window.
-- A COUNT tracker (like ph_steps) rather than a measure-once table. The reminder
-- is "behind pace" (cups so far < target spread over the waking window), evaluated
-- in routes-reminders.js. Added 2026-06-27.

CREATE TABLE IF NOT EXISTS ph_water (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cups        NUMERIC NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ph_water_profile ON ph_water(profile_id, measured_at DESC);

-- Per-person goal: JSONB {target (cups/day), start_hm, end_hm} or NULL = Off.
ALTER TABLE ph_profiles ADD COLUMN IF NOT EXISTS water_sched JSONB;

-- Retention: forever + protected (health), never auto-cleaned.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected)
VALUES ('ph_water', NULL, false, 24, 'Personal Health water intake (cups) — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
