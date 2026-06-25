-- Canonical household-member identity table.
-- Replaces the dashboard_settings 'privacy.users' JSON roster ([{name, smartphone}])
-- with a real table that has a stable id, so cross-cutting features (health profile,
-- notifications, places, gateway) reference one identity instead of matching a name
-- string. See PRIVACY/CLAUDE.md + memory [[project_household_users]].
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS household_users (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  phone        text,                 -- phone number (records / future SMS)
  device_label text,                 -- smartphone label (geo + notif) = old privacy.users 'smartphone'
  ntfy_topic   text,                 -- per-person push topic (future reminders)
  role         text,                 -- optional: adult / child / guest
  active       boolean NOT NULL DEFAULT true,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed members from the existing privacy.users JSON roster (name + smartphone->device_label).
INSERT INTO household_users (name, device_label)
SELECT TRIM(u->>'name'), NULLIF(TRIM(u->>'smartphone'), '')
FROM dashboard_settings ds, jsonb_array_elements(ds.value) u
WHERE ds.key = 'privacy.users' AND COALESCE(TRIM(u->>'name'), '') <> ''
ON CONFLICT (name) DO UPDATE
  SET device_label = COALESCE(EXCLUDED.device_label, household_users.device_label);

-- Link the health profile to the member by a stable FK (backfill by name match).
ALTER TABLE ph_profiles ADD COLUMN IF NOT EXISTS user_id integer REFERENCES household_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ph_profiles_user ON ph_profiles(user_id);
UPDATE ph_profiles p SET user_id = h.id FROM household_users h WHERE p.name = h.name AND p.user_id IS NULL;

-- Retention: forever (identity/config table).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('household_users', NULL, false, 24, 'Canonical household-member identity (name, phone, device label, ntfy topic)')
ON CONFLICT (table_name) DO NOTHING;
