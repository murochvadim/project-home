-- Trips the user explicitly removed from the steps history — the LXC 104 importer
-- skips these so a deleted trip-derived step entry doesn't re-import.
CREATE TABLE IF NOT EXISTS ph_steps_excluded_trips (
  trip_id     bigint PRIMARY KEY,
  excluded_at timestamptz NOT NULL DEFAULT now()
);
