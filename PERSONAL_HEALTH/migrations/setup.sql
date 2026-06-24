-- Personal Health Record — minimum schema (first step).
-- A tab on medical.html (Medical agent). Tables on LXC 102 (home_data). Idempotent.
--
-- Two layers: a per-person profile (slow-changing) + a weight-measurement log.
-- BMI / age / ideal-weight are COMPUTED in the front-end from these — never stored
-- (so they can't go stale when height/DOB are corrected). Waist / activity / vitals
-- / charts / goals are deliberately deferred to a later step.

-- 1) Profiles — one row per person
CREATE TABLE IF NOT EXISTS ph_profiles (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  sex           TEXT,                 -- 'male' | 'female' (for future BMR / body-fat)
  date_of_birth DATE,                 -- → age computed
  height_cm     NUMERIC,              -- once (rarely changes)
  allergies     TEXT,                 -- e.g. 'sulfa, penicillin' — for med cross-check
  conditions    TEXT,                 -- e.g. 'pregnancy, gout, kidney disease' — for cross-check
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Measurements — weight log per person
CREATE TABLE IF NOT EXISTS ph_measurements (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  measured_at DATE NOT NULL DEFAULT CURRENT_DATE,
  weight_kg   NUMERIC NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ph_meas_profile ON ph_measurements (profile_id, measured_at DESC);

-- 3) Medications — structured pills list per person (its own card on the tab).
-- Schedule model carries enough to drive future reminders (step 2):
--   freq='daily'          + times                       → every day at HH:MM
--   freq='weekly'         + dow + times                 → e.g. Mon,Thu at HH:MM
--   freq='every_n_months' + interval_n + next_due       → e.g. every 6 months (half-year)
--   freq='every_n_days'   + interval_n + next_due       → every N days
--   freq='once'           + next_due + times            → one-time dose
--   freq='as_needed'                                    → no schedule
CREATE TABLE IF NOT EXISTS ph_medications (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES ph_profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  dose        TEXT,                 -- e.g. '100 mg', '1000 IU'
  freq        TEXT,                 -- daily | weekly | every_n_months | every_n_days | once | as_needed
  interval_n  INTEGER,              -- N for every_n_* (e.g. 6 = every half-year)
  times       TEXT,                 -- reminder time(s) of day 'HH:MM' (comma-sep for multiple)
  dow         TEXT,                 -- days of week for 'weekly' (e.g. 'Mon,Thu')
  next_due    DATE,                 -- next dose date (interval / once) — advances when taken (step 2)
  notes       TEXT,
  -- safety / reference info (for the ℹ️ Info modal + a future cross-check):
  purpose          TEXT,            -- what it treats, e.g. 'Blood pressure'
  ingredients      TEXT,            -- active ingredients
  drug_class       TEXT,            -- e.g. 'ARB + thiazide diuretic'
  avoid_with       TEXT,            -- interactions: drugs/foods to avoid
  contraindications TEXT,           -- conditions/allergies that conflict
  side_effects     TEXT,            -- what to watch for
  warnings         TEXT,            -- free-text catch-all
  prescriber_id    INTEGER,         -- → medical_contacts.id (a doctor)
  started_at       DATE,            -- when started
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ph_meds_profile ON ph_medications (profile_id);

-- Additive migration for already-deployed tables (idempotent — no-op if present).
ALTER TABLE ph_profiles    ADD COLUMN IF NOT EXISTS allergies        TEXT;
ALTER TABLE ph_profiles    ADD COLUMN IF NOT EXISTS conditions       TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS purpose          TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS ingredients      TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS drug_class       TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS avoid_with       TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS contraindications TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS side_effects     TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS warnings         TEXT;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS prescriber_id    INTEGER;
ALTER TABLE ph_medications ADD COLUMN IF NOT EXISTS started_at       DATE;

-- 4) Retention — keep everything forever (personal record)
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('ph_profiles',     NULL, false, 24, 'Personal Health profiles (forever)'),
       ('ph_measurements', NULL, false, 24, 'Personal Health weight log (forever)'),
       ('ph_medications',  NULL, false, 24, 'Personal Health medications list (forever)')
ON CONFLICT (table_name) DO NOTHING;
