-- 018_steps_place_legs.sql (2026-07-04)
-- Let the steps importer also count Places-layer walking legs (phone_place_trips),
-- not just home trips (phone_trips). The two tables have INDEPENDENT id-spaces, so
-- ph_steps must dedup/unique on (source, trip_id) instead of trip_id alone —
-- otherwise a place-leg id 56 would collide with a home-trip id 56.
--
-- ADDITIVE ONLY: this does NOT change the walk/drive/phantom classifier. Place legs
-- are scored by the exact same classifier, so driving legs (home_to_place /
-- place_to_home) auto-skip and only genuine walks import (source='place_leg').
DROP INDEX IF EXISTS uq_ph_steps_trip;
CREATE UNIQUE INDEX uq_ph_steps_trip ON ph_steps (source, trip_id) WHERE trip_id IS NOT NULL;
