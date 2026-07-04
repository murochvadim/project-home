-- Personal Daily Journal (Privacy → Daily Journal tab, 2026-07-04).
-- ONE ROW PER (user, local day, slot). Plaintext (LAN-only) so it's AI-readable
-- for future reflections — NOT client-side encrypted like the site Docs.
-- Config (how many reminders / times / names) lives in dashboard_settings.journal.

CREATE TABLE IF NOT EXISTS journal_entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES household_users(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,              -- local Asia/Jerusalem day
  slot_id     TEXT NOT NULL,              -- stable id of the config slot
  slot_name   TEXT,                       -- snapshot of the slot's name (history stays readable if renamed/removed)
  comment     TEXT,                       -- Hebrew UTF-8, free text (may be empty)
  mood        SMALLINT,                   -- 1..5 (😞→😄), nullable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_user_date_slot ON journal_entries(user_id, entry_date, slot_id);
CREATE INDEX IF NOT EXISTS ix_journal_user_date ON journal_entries(user_id, entry_date DESC);

-- Retention: forever + protected (personal data), never auto-cleaned.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES ('journal_entries', NULL, false, 24, true, 'Personal daily journal (Privacy → Daily Journal) — plaintext, keep forever')
ON CONFLICT (table_name) DO NOTHING;
