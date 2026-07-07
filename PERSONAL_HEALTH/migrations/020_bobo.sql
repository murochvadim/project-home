-- 020_bobo.sql — BoBo balance-board activity becomes a first-class Personal Health
-- metric (own ph_bobo table, keyed by profile_id) instead of a "test" in
-- medical_test_results. Same shape/retention as ph_bp / ph_exercise_log.
-- Migrates the existing test_type='balance' rows over, then removes them from the
-- Tests table so BoBo no longer appears under Medical -> Tests.

BEGIN;

CREATE TABLE IF NOT EXISTS ph_bobo (
  id           serial PRIMARY KEY,
  profile_id   integer NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  measured_at  timestamptz NOT NULL DEFAULT now(),
  game         text,          -- 'balance_training' | 'colour_tunnel'
  level        text,          -- easy | medium | hard
  score        numeric,       -- balanced seconds (balance) / points (colour tunnel)
  duration_s   integer,
  calories     numeric,
  details      jsonb,          -- full results blob (sets/hold_s/rest_s, obstacles/top_speed, …)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ph_bobo_profile ON ph_bobo (profile_id, measured_at DESC);

-- retention: forever + protected, like every other ph_* table
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES ('ph_bobo', NULL, false, 24, true, 'Personal Health — BoBo balance-board activity results')
ON CONFLICT (table_name) DO UPDATE SET protected = true, auto_clean = false, keep_days = NULL;

-- migrate existing balance rows (map household user_id -> ph_profiles.id)
INSERT INTO ph_bobo (profile_id, measured_at, game, level, score, duration_s, calories, details, created_at)
SELECT p.id, t.tested_at,
       COALESCE(t.meta->>'game', t.results->>'game'),
       t.results->>'level',
       NULLIF(t.results->>'score', '')::numeric,
       NULLIF(t.results->>'duration_s', '')::int,
       NULLIF(t.results->>'calories', '')::numeric,
       t.results, t.created_at
FROM medical_test_results t
JOIN ph_profiles p ON p.user_id = t.user_id
WHERE t.test_type = 'balance';

-- remove the migrated rows from the Tests table (BoBo is an activity, not a test)
DELETE FROM medical_test_results t
USING ph_profiles p
WHERE t.test_type = 'balance' AND p.user_id = t.user_id;

COMMIT;
