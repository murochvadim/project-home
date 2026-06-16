-- visited_places: unified "places I've been" table for the travel globe.
-- Sources: google_review / google_reservation (from Google Takeout),
--          booking (Booking.com DSAR export, loaded later), owntracks, manual...
-- Retention: forever. One row per visited place/event with coords + timestamp.

CREATE TABLE IF NOT EXISTS visited_places (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,            -- google_review | google_reservation | booking | ...
  kind         TEXT,                     -- stay | review | dining | reservation | ...
  place_name   TEXT,
  address      TEXT,
  city         TEXT,
  country      TEXT,
  country_code TEXT,
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  visited_at   TIMESTAMPTZ,              -- visit / check-in / start
  end_at       TIMESTAMPTZ,              -- check-out / end (nullable)
  rating       INT,
  notes        TEXT,
  source_id    TEXT,                     -- stable id from the source (dedupe key)
  raw          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_visited_places_visited_at ON visited_places (visited_at);

-- (1) Google Maps review — Carlsbad Plaza Hotel, Karlovy Vary CZ (has native coords)
INSERT INTO visited_places
  (source, kind, place_name, address, city, country, country_code, lat, lon, visited_at, rating, notes, source_id, raw)
VALUES
  ('google_review', 'review',
   'Carlsbad Plaza Medical Spa & Wellness Hotel',
   'Mariánskolázeňská 25, 360 01 Karlovy Vary 1, Czechia',
   'Karlovy Vary', 'Czechia', 'CZ',
   50.2193172, 12.8820753,
   '2025-04-09T17:05:45.902437Z', 5,
   'Trip type: Vacation; Travel group: Family',
   '4461be6bde143ac0',
   '{"trip_type":"Vacation","travel_group":"Family","stars":5}'::jsonb)
ON CONFLICT (source, source_id) DO NOTHING;

-- (2) Google reservation — Key to Riga restaurant, Riga LV (geocoded from address)
INSERT INTO visited_places
  (source, kind, place_name, address, city, country, country_code, lat, lon, visited_at, end_at, notes, source_id, raw)
VALUES
  ('google_reservation', 'dining',
   'Key to Riga, restorāns',
   'Riga, 8a Doma laukums, Riga, LV',
   'Riga', 'Latvia', 'LV',
   56.9500079, 24.1056709,
   '2022-12-31T18:00:00Z', '2022-12-31T19:00:00Z',
   'Dining reservation, party of 2',
   '12318393057909226729',
   '{"party_size":2,"service":"Dining Reservation"}'::jsonb)
ON CONFLICT (source, source_id) DO NOTHING;
