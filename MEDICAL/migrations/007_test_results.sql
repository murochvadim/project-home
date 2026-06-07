-- Medical Tests — generic test-results table (added 2026-06-07).
-- Backs the "Tests" sub-tab on medical.html: a Hearing test card (Web Audio
-- pure-tone screening) writes one row per run; a Test Results card lists +
-- charts them. Generic by `test_type` so a future Eye test reuses the same
-- table with no schema change (test_type='vision').
--
--   results (JSONB) — per-test shape. Hearing:
--     {"right":{"250":dB,"500":dB,…,"8000":dB},"left":{…}}
--     (dB = attenuation tolerated below the reference level; higher = better)
--   meta    (JSONB) — {headphones, notes}

BEGIN;

CREATE TABLE IF NOT EXISTS medical_test_results (
  id          SERIAL PRIMARY KEY,
  test_type   TEXT NOT NULL,
  tested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  results     JSONB NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medical_test_results_type_ts
  ON medical_test_results (test_type, tested_at DESC);

-- Retention: forever (config/medical record — never auto-clean).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('medical_test_results', NULL, false, 24, 'Medical Tests results (hearing/vision) — keep forever')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
