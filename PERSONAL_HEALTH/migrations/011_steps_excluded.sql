-- Trips the user explicitly removed from the steps history — the LXC 104 importer
-- skips these so a deleted trip-derived step entry doesn't re-import.
CREATE TABLE IF NOT EXISTS ph_steps_excluded_trips (
  trip_id     bigint PRIMARY KEY,
  excluded_at timestamptz NOT NULL DEFAULT now()
);
-- Retention: forever (small, user-curated exclusion list). Registered 2026-06-26.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('ph_steps_excluded_trips', NULL, false, 24, 'Trip ids removed from steps history (importer skips them) — keep forever')
ON CONFLICT (table_name) DO NOTHING;
