-- Personal Health — daily morning-exercise routine log.
-- Like ph_water (a per-person daily tracker), but each logged row records the
-- routine's TOTAL calories burned + the distinct muscles worked. The exercise
-- DEFINITIONS (name, reps, calories-per-rep, muscles, include) live GLOBALLY in
-- dashboard_settings.medical.exercises; one row is written here per "Done" / per
-- reminder-Clear, computed from the included definitions (see lib-exercise-log.js).
-- The reminder is "due today" when no row exists for the current day and the
-- schedule time_hm has passed, evaluated in routes-reminders.js. Added 2026-06-28.

CREATE TABLE IF NOT EXISTS ph_exercise_log (
  id             SERIAL PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  measured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_calories NUMERIC,          -- Σ (reps × cal_per_rep) of the included exercises
  muscles        JSONB,            -- distinct muscle list worked (preset keys + non-empty "other")
  exercises      JSONB,            -- snapshot of which exercises + their calories (history detail)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ph_exercise_log_profile ON ph_exercise_log(profile_id, measured_at DESC);

-- Retention: forever + protected (personal health), never auto-cleaned.
-- protected=true set directly here (the one-time server.js protect-seed already
-- fired via its sentinel, so it won't pick up new tables).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected)
VALUES ('ph_exercise_log', NULL, false, 24, 'Personal Health morning-exercise routine log — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
