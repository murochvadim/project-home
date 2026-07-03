-- Geolocation "Places" layer (2026-07-03) — dynamic away-bases.
--
-- ADDITIVE ONLY. Nothing here touches phone_trips, device_locations, the
-- owntracks_ingest.py Home state machine, or geo_trip_janitor.py. A separate
-- cron script (geo_places.py on LXC 104) fills these tables by reading the
-- already-cleaned device_locations ping stream. See GEOLOCATION/CLAUDE.md.
--
-- Model: anchors = Home + every spot the phone dwells at >= place_dwell_min
-- (auto-named via Nominatim). phone_places = the "Stay" rows; phone_place_trips
-- = the "leg" rows between anchors. geo_place_state = per-group cursor + machine
-- state so the cron processes pings incrementally.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT) so it can be re-applied safely.

-- One row per dwell-qualified visit ("fresh each visit" — no reuse/dedup).
-- Rendered as the "📍 Stay · <name> · <duration>" rows in Recent trips.
CREATE TABLE IF NOT EXISTS phone_places (
    id          BIGSERIAL PRIMARY KEY,
    group_id    TEXT NOT NULL,
    name        TEXT,                      -- reverse-geocoded at creation (no rename)
    lat         DOUBLE PRECISION NOT NULL, -- dwell-cluster centroid
    lon         DOUBLE PRECISION NOT NULL,
    radius_m    INTEGER NOT NULL,          -- membership radius = place_radius_m at creation
    arrived_at  TIMESTAMPTZ NOT NULL,      -- first ping of the dwell cluster
    left_at     TIMESTAMPTZ,               -- when the stay ended (departed the radius); NULL = still there
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_places_group_ts ON phone_places (group_id, arrived_at DESC);

-- One row per leg between two anchors (Home or a place). Same stat shape as
-- phone_trips so the merged Recent-trips render is uniform. max_dist_m is
-- measured from the leg's ORIGIN anchor (not Home).
CREATE TABLE IF NOT EXISTS phone_place_trips (
    id            BIGSERIAL PRIMARY KEY,
    group_id      TEXT NOT NULL,
    device_label  TEXT,
    kind          TEXT NOT NULL,          -- home_to_place | place_to_place | place_loop | place_to_home
    origin_name   TEXT,                   -- 'Home' or the origin place name
    dest_name     TEXT,                   -- 'Home' or the destination place name
    from_place_id BIGINT REFERENCES phone_places(id) ON DELETE SET NULL,
    to_place_id   BIGINT REFERENCES phone_places(id) ON DELETE SET NULL,
    started_at    TIMESTAMPTZ NOT NULL,   -- left the origin anchor
    returned_at   TIMESTAMPTZ,            -- arrived at the destination anchor; NULL = leg in flight
    duration_sec  INTEGER,
    max_dist_m    INTEGER,                -- max distance from ORIGIN anchor
    path_length_m INTEGER,
    outside_pings INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_place_trips_group_ts ON phone_place_trips (group_id, started_at DESC);
-- One open leg per group at a time (mirrors phone_trips' open-per-group guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_phone_place_trips_open_per_group
    ON phone_place_trips (group_id) WHERE (returned_at IS NULL);

-- Per-group incremental cursor + serialized state-machine blob for geo_places.py.
CREATE TABLE IF NOT EXISTS geo_place_state (
    group_id    TEXT PRIMARY KEY,
    last_ts     TIMESTAMPTZ,              -- newest device_locations.ts processed
    state       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retention: the two data tables are keep-forever + protected (like phone_trips
-- and the medical/privacy tables). geo_place_state is internal + forever (tiny).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES
  ('phone_places',      NULL, false, 24, true,  'Geolocation Places — away-base stays (dwell-qualified). Keep forever.'),
  ('phone_place_trips', NULL, false, 24, true,  'Geolocation Places — anchor-to-anchor legs. Keep forever.'),
  ('geo_place_state',   NULL, false, 24, false, 'Geolocation Places — per-group cron cursor + state. Internal.')
ON CONFLICT (table_name) DO NOTHING;
