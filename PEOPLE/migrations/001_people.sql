-- 001_people.sql — People / Heritage foundation (Phase 1).
-- A "People hub" for family & friends: a Directory (people) + a relationship
-- edge list (people_relations) that later drives the network/tree graph.
-- Dashboard-only feature (Privacy → People tab); data lives here on LXC 102.
-- Plaintext, LAN-only (AI-readable, like medical_contacts / journal_entries).
-- Photos live on the QNAP; only the basename is stored in people.photo.

BEGIN;

CREATE TABLE IF NOT EXISTS people (
  id                 SERIAL PRIMARY KEY,
  given_name         TEXT,
  family_name        TEXT,
  maiden_name        TEXT,
  category           TEXT NOT NULL DEFAULT 'other',   -- family_mine | family_spouse | friend | other
  gender             TEXT,                            -- for the future tree layout
  birth_date         DATE,
  death_date         DATE,                            -- NULL = living
  photo              TEXT,                            -- basename on QNAP People_Photos
  phone              TEXT,
  email              TEXT,
  address            TEXT,
  relationship_to_me TEXT,                            -- how related / how you know them
  origin_place       TEXT,
  origin_country     TEXT,
  lat                DOUBLE PRECISION,                -- origin, for the Phase-3 map
  lon                DOUBLE PRECISION,
  notes              TEXT,
  tags               JSONB DEFAULT '[]'::jsonb,       -- friend circles / side of family
  household_user_id  INTEGER REFERENCES household_users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- edge list — scales from the close circle to deep ancestry AND holds friend links.
-- A person's edges vanish with them (CASCADE); each reciprocal link stored ONCE.
CREATE TABLE IF NOT EXISTS people_relations (
  id             SERIAL PRIMARY KEY,
  from_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  to_person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  rel_type       TEXT NOT NULL,                       -- parent | spouse | child | sibling | friend | ...
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_people_category ON people (category);
CREATE INDEX IF NOT EXISTS ix_prel_from ON people_relations (from_person_id);
CREATE INDEX IF NOT EXISTS ix_prel_to   ON people_relations (to_person_id);
-- one edge per (from,to,type) so re-adding the same link is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS uq_prel_edge ON people_relations (from_person_id, to_person_id, rel_type);

-- retention: forever + protected. The server's one-time protected seed already ran
-- (sentinel health.protected_seeded), so seed these rows AS protected here directly.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES
  ('people',           NULL, false, 24, true, 'People hub — family & friends directory'),
  ('people_relations', NULL, false, 24, true, 'People hub — relationship edges (family/friend graph)')
ON CONFLICT (table_name) DO UPDATE SET protected = true, auto_clean = false, keep_days = NULL;

COMMIT;
